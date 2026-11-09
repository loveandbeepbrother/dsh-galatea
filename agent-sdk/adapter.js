/**
 * `agent-sdk` 模型提供方：会话的每次模型请求交给该会话常驻的 Claude Code 进程。
 *
 * AgentLoop 照常执行会话并写日志；Claude Code 用自己的工具完成一轮，这一轮写下的文字依次流回
 * AgentLoop，合成一个文字块。每个 DSH 会话对应一个 Claude Code 会话，进程空闲超时后关闭，下一轮按
 * 执行绑定续接。同一条用户消息只发送一次：重试时重放已得的结果。
 *
 * Claude Code 自己也会开一轮（后台任务有了结果等），所以进程的输出由一个读取者从头读到尾，
 * 每一轮按它回显的输入 uuid 认领：属于 DSH 发来的输入的，交给等待中的那次请求；Claude Code 自己开的，
 * 先保存回复，再在 DSH 会话里开一轮把它取回，桌面与渠道照常呈现。
 *
 * @module @loveandbeepbrother/dsh-galatea-agent-sdk/adapter
 */

import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { COMPACT_COMMAND, flattenForOneShot, planTurn, surfaceText, surfacedKey, textOf } from './plan.js'
import { QuotaGate, USAGE_LIMIT, limitSignal, startsWithAny, usageWindows } from './quota.js'

/** DSH 按提供方策略重试的失败类别：断网、短暂限流、服务端错误。额度用完（`USAGE_LIMIT`）不在其中，由额度闸门恢复后唤醒会话。 */
export const RETRYABLE_CODES = Object.freeze(['TRANSPORT', 'RATE_LIMIT', 'SERVER'])

/** SDK 用量查询（`/usage` 背后的数据，不经模型）的方法名；SDK 标为实验性，没有这个方法时不用。 */
export const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

/**
 * Claude Code 一轮失败的类别。它自己已经对每次 API 请求重试过多次，到这里的是持续的故障。先看结构化信号（`limitSignal`）：
 * 额度用完为 `USAGE_LIMIT`，短暂限流为 `RATE_LIMIT`，过载与服务端错误为 `SERVER`；报错文字以 SDK 的额度用完前缀开头时也算额度用完。
 * 断网只有文字可认。归入 `RETRYABLE_CODES` 的交给 DSH 等一会儿再整轮重试，其余照旧作为本轮失败。
 * @param signal - 这一轮的额度信号（`limitSignal` 的结果），没有时为 `null`。
 * @param prefixes - SDK 的 `USAGE_LIMIT_ERROR_PREFIXES`。
 */
export function failureCode(text, signal = null, prefixes = []) {
    if (signal?.kind === 'usage' || startsWithAny(text, prefixes)) return USAGE_LIMIT
    if (signal?.kind === 'rate') return 'RATE_LIMIT'
    if (signal?.kind === 'server' || /API Error: 5\d\d|overloaded|internal server error/i.test(text)) return 'SERVER'
    if (/connection (error|dropped|refused)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|request timed out/i.test(text)) {
        return 'TRANSPORT'
    }
    return 'AGENT_SDK_TURN_FAILED'
}

/**
 * 追加在 Claude Code 预设系统提示后的说明：只写执行方自己的事（这一轮的回复是哪一段、开头上下文、换新对话、记忆工具）。
 * 渠道怎么发、项目任务怎么派，由那些插件经框架的会话开头段落自己交代，装了才出现。
 */
export const SYSTEM_APPEND = [
    '你同时是用户在 DSH 中的个人助手。用用户的语言写这一轮的文字，工具调用之间的也一样（代码标识符、路径与引用的原文除外）。',
    '最后一次工具调用之后的那段文字是这一轮的回复；会话接着聊天渠道时，它会发到用户那边，保持自然简洁，少用需要渲染的复杂格式，',
    '也不必在末尾重述前面说过的话。工具调用之间写的文字只留在 DSH 桌面上，不会发到聊天渠道：那里同样不写“我先看看”“Now read …”之类的过程旁白，',
    '也不放用户必须看到的内容。DSH 交给你的人格、长期认知、常驻记忆与其他上下文，按它们行事：',
    '以“（DSH 会话开头上下文”开头的是你的人格、长期认知、常驻记忆、记忆目录、待告知留言和各插件的约定等，在系统提示里，新对话开始时是最新版本；',
    '以“（DSH 提示”开头的是系统附带的提醒，以“（交接”开头的是你在上一段对话结束前写的交接文档。它们都不是用户的话。',
    '上下文大了时由你决定何时换新对话：先把该长期保存的写进记忆、便签与项目文档，再写交接文档（只写工作状态：进行中的事和进度、',
    '还没落档的决定、等用户回复的问题、最近动过的文件、最后几轮在谈什么，并写明接续经历库的哪一段），然后调用 `assistant_context_handoff`。',
    '放到后台的子代理或命令有了结果时，你会自己接着处理一轮；这一轮最后的那段文字同样是回复，像平常一样说就好。',
    'DSH 的经历、记忆、便签和文档检索等以 `mcp__dsh__` 开头的工具提供，需要回忆时先用 `assistant_search`，它一次搜全部。',
    '你的记忆由这些工具维护：用户告诉你值得长期记住的事、作品中定下的设定和约定，用 `assistant_memory_write` 记下并注明来源；',
    '近期待办与线索写进便签；从经历中形成的概括理解整理进长期认知；长期成立、每段对话都该知道的事实写进常驻记忆，变了就改；人格的稳定变化先成候选，等用户本人回复确认编号。',
    '定时提醒用 `schedule_` 开头的工具建立；到点时会以“[SCHEDULE REMINDER]”交给你。',
    '提到本机文件时写成链接 `[文件名](<绝对路径>)`，DSH 桌面里可以点开。',
    '交给用户看的完整文档（大纲、分析、报告、表格等）用 `mcp__dsh__present` 交付，在 DSH 会话里显示为可预览、可打开的文件卡片；',
    '回复里讲清要点和需要用户决定的事。只是改过的源文件不用 present。',
].join('\n')

/** 把 DSH 工具结果转成 MCP 的工具结果。 */
export function mcpResult(result) {
    const text = (result?.content ?? [])
        .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
        .join('\n')
    return { content: [{ type: 'text', text: text || '(无输出)' }], isError: result?.isError === true }
}

/**
 * 自动权限模式的服务端判定在常驻进程里失效的标志。进程一旦记下“不再请求判定”，此后每个
 * 需要判定的工具（Bash、PowerShell、Codex 等）都被拒绝，直到换进程；续接到新进程即可恢复。
 */
const CLASSIFIER_LATCHED = /auto mode classifier gave no verdict[\s\S]*did not ask for one/

/** 换进程后交给新进程的提示：接着完成被打断的同一条请求。 */
export const RESUME_AFTER_RETIRE = '（系统转交，不是用户发言）刚才 Bash 等工具被拒，是旧进程的权限判定失效，已换新进程续接。'
    + '刚才被拒的工具现在可以照常调用；请接着完成上一条消息的工作，像这次中断没有发生一样回复用户。'

/** SDK 转来的用户消息里是否有工具结果带着这个标志。 */
export function classifierLatched(message) {
    if (message?.type !== 'user' || !Array.isArray(message.message?.content)) return false
    return message.message.content.some((block) => {
        if (block?.type !== 'tool_result') return false
        const content = typeof block.content === 'string'
            ? block.content
            : (block.content ?? []).map(part => part?.text ?? '').join('\n')
        return CLASSIFIER_LATCHED.test(content)
    })
}

/** 生成发给 SDK 的一条用户消息；内容是文字或 Messages API 内容块数组。 */
function userMessage(content) {
    return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
}

/** Claude 建议的图片长边上限与单张字节目标。 */
const IMAGE_LONG_EDGE = 1568
const IMAGE_MAX_BYTES = 3_750_000

/** 按长边上限等比缩放的请求尺寸。 */
export function imageTarget(ref) {
    const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(ref.width, ref.height))
    return {
        width: Math.max(1, Math.round(ref.width * scale)),
        height: Math.max(1, Math.round(ref.height * scale)),
        maxBytes: IMAGE_MAX_BYTES,
    }
}

/**
 * 上次压缩以来进入上下文的图片（base64 字节）累计到这么多，在下一轮开头提醒一次压缩；每再多这么多再提醒一次。
 * 图片按 token 不算多，慢在每次内部请求都要把它们整份重新上传。
 */
export const IMAGE_REMIND_BYTES = 5_000_000

/** 一组内容块里的 base64 图片：张数与字节；工具结果里的图片一并算上。 */
export function imagesIn(content) {
    const total = { count: 0, bytes: 0 }
    const walk = (blocks) => {
        if (!Array.isArray(blocks)) return
        for (const block of blocks) {
            if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
                total.count += 1
                total.bytes += block.source.data.length
            } else if (block?.type === 'tool_result') {
                walk(block.content)
            }
        }
    }
    walk(content)
    return total
}

/** 图片多了时附在这一轮的提醒。 */
export function imageReminder({ count, bytes }) {
    return `（DSH 提示，不是用户发言）自上次压缩以来，上下文里已有 ${count} 张图片、约 ${(bytes / 1e6).toFixed(1)}MB，`
        + '每次内部请求都要整份重新上传，工具调用越多越慢。手头的图片工作告一段落时，调用 `assistant_context_compact` 压缩一次；'
        + '正在做的事不必为此中断。'
}

/** 附加上下文过长、改随用户消息发送时的开头。 */
export const CONTEXT_LEAD = '（DSH 附加上下文，不是用户发言。）'

/** 每个钩子附加上下文的安全长度：Claude Code 把超过 1 万字的钩子输出截成 2KB 预览，上限按每个钩子算。 */
export const HOOK_CONTEXT_CHARS = 9_000

/** 会话开头上下文最多分几个钩子。 */
export const OPENING_SLOTS = 4

export const OPENING_LEAD = '（DSH 会话开头上下文，不是用户发言：人格、长期认知、常驻记忆、记忆目录、渠道约定与待告知留言等。'
    + '新对话开始时给出，中途由别处改动时另行提醒，自己改的不提醒。）'

/** 每条变更说明前的一句（说明由框架核心按各段的 onChange 给出）。 */
export const NOTE_LEAD = '（DSH 提示，不是用户发言）'

/** 兜底压缩后补发改过的几节时的开头。 */
export const OPENING_UPDATE_LEAD = '（DSH 会话开头上下文更新，不是用户发言：系统提示里的人格、长期认知、常驻记忆、记忆目录、渠道约定等在这段对话开始后改过，'
    + '以下几节取代系统提示里的同名旧版本，其余照旧。）'

/** 交接文档随新对话第一条消息发送时的开头。 */
export const HANDOFF_LEAD = '（交接，不是用户发言：上一段对话结束前你自己写的交接文档，从这里接着做。'
    + '人格、长期认知、常驻记忆、记忆目录、渠道约定等在系统提示里；原话与细节在经历库里。）'

/**
 * 切到别的执行方之前那一轮看不见的交接（可选能力 `handoffTurn`）：这段对话里的东西切过去以后对方看不到，
 * 请模型把对方需要、开头上下文里又没有的工作状态写下来。整条回复就是正文，由适配器存成文件。
 */
export function handoffTurnPrompt(path) {
    return '（DSH 系统请求，不是用户发言，用户看不到这一轮）这个会话要切到别的模型接着做。切过去以后，它看不到你这段对话，'
        + '只看得到系统提示里的人格、长期认知、常驻记忆、记忆目录、渠道约定，和你现在写的交接文档。请写这份交接文档，只写开头上下文里没有的工作状态：'
        + '进行中的事和它到了哪一步、还没存到别处的决定、在等用户回答的问题、最近改过的文件、最后几轮在谈什么、接着经历库里的哪一段。'
        + `你的整条回复就是交接文档的正文，会原样存到 ${path}，所以不要调用工具，也不要写正文以外的话。`
}

/** 系统提示里的会话开头上下文：开头一句说明，后面是各段原文（框架核心 `segments.open`、`current` 给的）。 */
export function openingText(opening) {
    return [OPENING_LEAD, ...opening.map(entry => entry.text)].join('\n\n')
}

/**
 * 会话开头上下文按段落切成每份不超过 `limit` 字，分给几个钩子；单个段落过长时硬切。
 * @returns 各份文字；没有内容时为空数组。
 */
export function openingPieces(texts, limit = HOOK_CONTEXT_CHARS, lead = OPENING_LEAD) {
    if (texts.length === 0) return []
    const paragraphs = [lead, ...texts].join('\n\n').split('\n\n')
    const pieces = []
    let current = ''
    for (const paragraph of paragraphs) {
        const chunks = []
        for (let start = 0; start < paragraph.length; start += limit) chunks.push(paragraph.slice(start, start + limit))
        for (const chunk of chunks.length > 0 ? chunks : ['']) {
            if (current !== '' && current.length + 2 + chunk.length > limit) {
                pieces.push(current)
                current = chunk
            } else {
                current = current === '' ? chunk : `${current}\n\n${chunk}`
            }
        }
    }
    if (current !== '') pieces.push(current)
    return pieces
}

/** 给会话开头上下文的 `OPENING_SLOTS` 个钩子：第几份由 `pieceOf(slot, input)` 给出，没有时不带内容。 */
function openingSlots(hookEventName, pieceOf) {
    return Array.from({ length: OPENING_SLOTS }, (_, slot) => ({
        hooks: [async (input) => {
            const text = await pieceOf(slot, input)
            return text ? { hookSpecificOutput: { hookEventName, additionalContext: text } } : {}
        }],
    }))
}

/** 可推送、可关闭的异步输入流。 */
/** 自带的钩子加上 `extraHooks` 给的：同一个事件的匹配项接在自带的后面。 */
export function withExtraHooks(own, extra) {
    if (extra === undefined || extra === null) return own
    const merged = { ...own }
    for (const [event, groups] of Object.entries(extra)) merged[event] = [...merged[event] ?? [], ...groups]
    return merged
}

function inputStream() {
    const items = []
    let wake = null
    let closed = false
    return {
        push(item) {
            items.push(item)
            wake?.()
        },
        close() {
            closed = true
            wake?.()
        },
        async *[Symbol.asyncIterator]() {
            while (true) {
                if (items.length > 0) {
                    yield items.shift()
                    continue
                }
                if (closed) return
                await new Promise(resolve => { wake = resolve })
                wake = null
            }
        },
    }
}

/**
 * 一轮的用量交给 DSH：`result` 的用量是这一轮几十次内部请求的累计，DSH 却拿上一次请求的输入、缓存读写之和
 * 判断上下文有多满，累计值会让它每轮都去压缩。输入与缓存取这一轮最后一次内部请求的（就是当前上下文的大小），
 * 输出仍按整轮累计。没有逐次用量时照用累计值。
 */
export function turnUsage(total, last) {
    if (last === undefined || last === null) return total
    return {
        ...total ?? {},
        input_tokens: last.input_tokens ?? 0,
        cache_read_input_tokens: last.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: last.cache_creation_input_tokens ?? 0,
        output_tokens: total?.output_tokens ?? last.output_tokens ?? 0,
    }
}

/** SDK 用量转换为 DSH 的不相交计数。 */
export function usageOf(usage) {
    if (usage === undefined || usage === null) return undefined
    const result = {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
    }
    if (usage.cache_read_input_tokens) result.cacheReadTokens = usage.cache_read_input_tokens
    if (usage.cache_creation_input_tokens) result.cacheWriteTokens = usage.cache_creation_input_tokens
    return result
}

/** 一段文字作为一个完整文字块。 */
function* textBlock(index, text) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'text', text } }
}

/** 把一段最终文字作为一个完整文字块输出。 */
function* textChunks(text, usage) {
    yield* textBlock(0, text)
    const converted = usageOf(usage)
    if (converted !== undefined) yield { type: 'usage', usage: converted }
    yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 一轮回复的文字依次到达时的队列：`push` 一段、`close` 结束，读取方按顺序取。 */
function textFeed() {
    const items = []
    let wake = null
    let closed = false
    return {
        push(text) {
            items.push(text)
            wake?.()
        },
        close() {
            closed = true
            wake?.()
        },
        async *[Symbol.asyncIterator]() {
            while (true) {
                if (items.length > 0) {
                    yield items.shift()
                    continue
                }
                if (closed) return
                await new Promise(resolve => { wake = resolve })
                wake = null
            }
        },
    }
}

/** 一轮里各段文字连成回复时的分隔。 */
const PIECE_SEPARATOR = '\n\n'

/** 保存的 Claude Code 自己开的轮的回复上限，取回前 Host 不重启时足够。 */
const SURFACED_LIMIT = 50

/** 取回时找不到保存的回复（Host 重启过）时交给 Claude Code 的提示。 */
export const RECALL_SURFACED = '（系统转交，不是用户发言）你刚才自己处理了一轮（后台任务有了结果等），那一轮的回复没能送到用户。'

/** "未得到回应"里每条输入留多少字。 */
const UNANSWERED_CHARS = 100

    + '请把那一轮要告诉用户的话完整地再说一遍。'


/** 本轮输入若只是一条压缩命令，返回它的说明（可能为空串）；否则 null。 */
export function compactCommand(plan) {
    // 只认单独一条：几条排队的消息会连成一段，不能把后面的请求当成压缩说明吞掉。
    // 参考轮的输入不是用户发的，不当成压缩命令。
    if (plan.reference || plan.promptIds.length !== 1 || plan.surfaced.length > 0) return null
    if (plan.promptBlocks.some(block => block.type !== 'text')) return null
    const match = COMPACT_COMMAND.exec(String(plan.commandText ?? '').trim())
    return match === null ? null : (match[1] ?? '').trim()
}

/** 压缩前先接上别的模型处理过的部分。 */
export const HANDOFF_BEFORE_COMPACT = '（系统转交，不是用户发言）用户要压缩上下文。压缩前先把上面的接续材料读进来；只回复“已接上”。'

/** 压缩结果的说明。 */
export function compactSummary(result) {
    if (!result.compacted) return `没有压缩：${result.reason}`
    const before = result.preTokens === null ? '' : `（压缩前约 ${Math.round(result.preTokens / 1000)}k token）`
    return `上下文已压缩${before}。之前的对话由摘要接续，旧的图片不再随每次请求上传。`
}

/** 结果是否回应这次请求：按回显的输入 uuid；旧版 CLI 不回显时，没有其他来源的结果归正在等待的请求。 */
function answers(value, turn, waiter) {
    const uuids = value.user_message_uuids
        ?? (value.user_message_uuid !== undefined ? [value.user_message_uuid] : turn.uuids)
    if (uuids.length > 0) return uuids.includes(waiter.uuid)
    return value.origin === undefined || value.origin.kind === 'human'
}

/** Claude Code 自己开一轮的起因。 */
export function causeOf(origin, summaries) {
    if (origin?.kind === 'task-notification') {
        return summaries.length > 0 ? `后台任务「${summaries.join('」「')}」有了结果` : '后台任务有了结果'
    }
    if (origin?.kind === 'peer') return '收到其他会话发来的消息'
    return 'Claude Code 自己开了一轮'
}

/**
 * Claude Code 模型适配器。
 *
 * `deps`：
 * - `ready()`：可选，首次请求前等待 SDK 与存储就绪；
 * - `loadSdk()`：返回 `{ query }`；
 * - `bindings`：`{ get(sessionId), put(sessionId, record) }`，可异步；
 * - `cwdOf(sessionId)`：会话工作目录，未知时返回 `undefined`；
 * - `readImage(ref, target, signal)`：读出图片请求版本 `{ data, mediaType }`；
 * - `imagePath(ref)`：可选，原图的只读路径；
 * - `toolEndpoint(sessionId)`：可选，核心的工具端点 `{ url, token }`（产品工具经它交给 Claude Code）；
 * - `surface(sessionId, { key, text })`：可选，在 DSH 会话里开一轮，取回 Claude Code 自己开的那一轮的回复；
 * - `env()`：子进程环境；
 * - `skills()`：可选，每次打开进程时给出助手能用的 skill 名单；不给时不限制；
 * - `quotaStore`：可选，`{ load(), save(record) }`，额度闸门的存储；不给时只在内存里；
 * - `mainSessionId()`：可选，中枢（额度恢复后先唤醒它）；
 * - `timezone()`：可选，给用户看的时间按哪个时区写（框架核心的 `timezone`）；
 * - `wake(sessionId, { key, text })`：可选，额度恢复后经唯一的转交入口交给有积压的会话；
 * - `sessionState(sessionId, { since, marker })`：可选，按会话里的实际事件判断恢复后答过没有（Host 重启后用）；
 * - `attachments(sessionId)`：可选，框架核心里这个会话还没交到的附提醒 `[{ key, text }]`；
 * - `sourceAudience(message)`：可选，框架核心认的"这条消息给哪些执行方"（`native-only` 的不交）；没有时都交；
 * - `classify(message)`：可选，框架核心的分类（`core.classify`）；没有时按消息里写好的 `source.intent`；
 * - `segments`：可选，框架核心的上下文段 `{ open(对话, 会话), changes(对话, 会话, {compacted}) }`；
 * - `extraHooks(sessionId)`：可选，给这个会话的 Claude Code 进程另加的钩子 `{ 事件名: [匹配项] }`，排在自带的同名钩子后面；
 * - `logger`。
 */
export class AgentSdkAdapter extends LlmAdapter {
    constructor(config, deps) {
        super()
        this.config = config
        this.deps = deps
        /** 每个会话的工具端点 `{ url, token }`。 */
        this.endpoints = new Map()
        /** @type {Map<string, object>} DSH 会话 id → 常驻 Claude Code 进程。 */
        this.live = new Map()
        /** 每个会话的上下文换过几代（开新对话、压缩各算一次），给框架的上下文模块判断要不要重计提醒。 */
        this.epochs = new Map()
        /** @type {Map<string, Promise<unknown>>} 每个会话的串行链。 */
        this.chains = new Map()
        /** @type {Map<string, { messageId: string, outcome: object }>} 每个会话最近答过的输入，重试时重放。 */
        this.answered = new Map()
        /** @type {Map<string, object>} Claude Code 自己开的轮：编号 → 回复，等 DSH 那一轮取回。 */
        this.surfaced = new Map()
        /** 已经记过日志的未归类快照节。 */
        /** 已经报过的未归类消息来源（只当附加上下文）。 */
        this.unknownSources = new Set()
        this.closed = false
        /** 额度闸门：额度用完期间所有请求在交给 Claude Code 之前就拒绝。 */
        this.quota = new QuotaGate(config.quota, {
            load: () => deps.quotaStore?.load(),
            save: record => deps.quotaStore?.save(record),
            probe: request => this.probeQuota(request),
            pollUsage: () => this.pollUsage(),
            mainSessionId: () => deps.mainSessionId?.(),
            timezone: () => deps.timezone?.(),
            roleOf: sessionId => deps.roleOf?.(sessionId),
            wake: deps.wake,
            sessionState: deps.sessionState,
            report: deps.report,
            ...deps.quotaClock ?? {},
            logger: deps.logger,
        })
        // 断网或短暂限流可能持续几十分钟：间隔逐次加倍到上限，直到次数用完。
        this.retryPolicy = resolveRetryPolicy({
            mode: 'normal',
            maxRetries: config.retry.maxRetries,
            retryableCodes: [...RETRYABLE_CODES],
            backoff: { initialDelayMs: config.retry.initialSeconds * 1000, maxDelayMs: config.retry.maxMinutes * 60_000 },
        }, 'galatea-agent-sdk.retry')
    }

    providerInfo(provider) {
        return { id: provider, name: 'Claude（经 Agent SDK）' }
    }

    providerRetryPolicy() {
        return this.retryPolicy
    }

    listModels(provider) {
        return Promise.resolve(this.config.models.map(model => ({
            provider,
            id: model.id,
            name: model.name,
            inputModalities: ['text', 'image'],
        })))
    }

    resolveModel(provider, model) {
        const known = this.config.models.find(entry => entry.id === model)
        return Promise.resolve({
            provider,
            id: model,
            name: known?.name ?? model,
            inputModalities: ['text', 'image'],
            context: { contextWindow: this.config.contextWindow },
        })
    }

    async *stream(options) {
        if (this.closed) throw new LlmError('Agent SDK 提供方已关闭', 'AGENT_SDK_CLOSED')
        // 登录方式没选对：每一轮一开头就失败、写明怎么改（拉起进程的入口 startQuery 也会拦，这里先拦是为了不做别的准备）。
        const authProblem = this.deps.authProblem?.()
        if (authProblem) throw new LlmError(authProblem, 'AGENT_SDK_AUTH')
        await this.deps.ready?.()
        await this.quota.load()
        if (options.purpose !== undefined || options.sessionId === undefined) {
            yield* await this.oneShot(options)
            return
        }
        const sessionId = String(options.sessionId)
        // 这一轮写下的每段文字（两次工具调用之间的一段）到达即作为一个文字块流出：渠道只把最后一块发到手机，
        // 中间的过程留在桌面。重放与取回的回复按保存的各段一次给出。
        const feed = textFeed()
        // 这一轮结束（不论成败）告诉额度闸门：恢复后的唤醒按它判断这个会话答过积压没有、被唤醒的那一轮结束没有。
        const run = this.serial(sessionId, () => this.converse(sessionId, options, text => feed.push(text)).then(
            (outcome) => {
                this.quota.turnFinished(sessionId, true)
                return outcome
            },
            (error) => {
                this.quota.turnFinished(sessionId, false)
                throw error
            },
        ))
        run.then(() => feed.close(), () => feed.close())
        let index = 0
        const streamed = []
        for await (const piece of feed) {
            yield* textBlock(index++, piece)
            streamed.push(piece)
        }
        const outcome = await run
        if (streamed.length === 0) {
            for (const piece of outcome.pieces) yield* textBlock(index++, piece)
        } else {
            const joined = streamed.join(PIECE_SEPARATOR)
            if (outcome.text.startsWith(joined) && outcome.text.length > joined.length) {
                yield* textBlock(index++, outcome.text.slice(joined.length).replace(/^\n+/, ''))
            }
        }
        if (index === 0) yield* textBlock(index++, '')
        const usage = usageOf(outcome.usage)
        if (usage !== undefined) yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'stop' } }
    }

    /** 同一会话的轮次串行执行。 */
    serial(sessionId, task) {
        const previous = this.chains.get(sessionId) ?? Promise.resolve()
        const run = previous.then(task, task)
        const settled = run.then(() => {}, () => {})
        this.chains.set(sessionId, settled)
        settled.then(() => {
            if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId)
        })
        return run
    }

    /**
     * 一轮对话：拆分请求、按需打开或续接进程、发送并等待结果。`onText` 收到这一轮依次写下的各段文字；
     * 返回的回复是它们按顺序连成的全文，重放与取回时是保存的全文。
     */
    async converse(sessionId, options, onText = () => {}) {
        const binding = (await this.deps.bindings.get(sessionId)) ?? {}
        const route = options.provider
        const handoffChars = this.config.handoffChars
        const classify = this.deps.classify
        const audience = this.deps.sourceAudience
        const judged = { ...classify === undefined ? {} : { classify }, ...audience === undefined ? {} : { audience } }
        const knownBoundary = binding.knownBoundary ?? null
        let plan = planTurn(options.messages, { route, lastMessageId: binding.lastMessageId, knownBoundary, handoffChars, ...judged })
        // 这份请求的最后一条消息：DSH 重试同一个请求时它不变，新开的一轮总会有新进来的消息。
        const requestTail = options.messages.at(-1)?.id ?? null
        // 这一轮有没有真正的提问：参考轮的输入是别的插件放进来的，不算。
        const noQuestion = plan.promptIds.length === 0 || plan.reference
        // 消息已发出，但既没有记下 Claude Code 会话 id、进程也不在了（首轮中途退出）：从头交接。
        // 助手自己交接换新对话后不算：新对话从交接文档接续，不从头交接历史。
        if (noQuestion && !binding.claudeSessionId && !this.live.has(sessionId) && !binding.handoff) {
            plan = planTurn(options.messages, { route, lastMessageId: null, handoffChars, ...judged })
        }
        // 按最终交出去的那一份报未归类的来源：从头交接时整段历史里的也算。
        const pieces = []
        const emit = (text) => {
            pieces.push(text)
            onText(text)
        }
        const finish = (outcome) => {
            const own = pieces.length > 0 ? [...pieces] : outcome.text === '' ? [] : [outcome.text]
            const full = { ...outcome, text: own.join(PIECE_SEPARATOR), pieces: own }
            this.answered.set(sessionId, { messageId: plan.lastMessageId, requestTail, outcome: full })
            return full
        }

        // 同一条用户消息只发送一次：重试时重放已得结果。DSH 交给适配器的请求里没有重试标识，
        // 认重试只能看请求本身：最后一条消息和上次答过的那份一样（之前看"没有新提问"，只有参考的一轮也会撞上）。
        if (noQuestion) {
            const last = this.answered.get(sessionId)
            if (last !== undefined && requestTail !== null && last.requestTail === requestTail) return last.outcome
            if (plan.promptIds.length === 0) {
                if (!binding.lastMessageId) throw new LlmError('没有新的用户输入可交给 Claude Code', 'AGENT_SDK_NO_INPUT')
                if (last !== undefined && last.messageId === binding.lastMessageId) return last.outcome
            }
        }

        // 额度用完：不交给 Claude Code，也不记下“已交到哪一条”，积压的输入原样留在 DSH，恢复后的下一轮按顺序一起带上。
        if (this.quota.limited()) {
            this.quota.reject(sessionId, { pending: plan.promptIds.length, sources: plan.sources })
            throw this.usageLimitError()
        }
        // 这个会话开始一轮（压缩命令、只取回自己开的轮这类不经模型作答的也算在进行）；带着唤醒标记的就是额度恢复后被唤醒的那一轮。
        // 算不算“答过积压”另由下面交给模型作答的两处记下（turnCarries）。
        this.quota.turnStarted(sessionId, plan.prompt)

        // 用户直接发的压缩命令：不经模型回答，压缩后回一句结果。
        const command = compactCommand(plan)
        if (command !== null) {
            // 换用过别的模型：先让 Claude Code 把接续材料读进来，否则压缩后这段历史就再也交不过去。
            if (plan.handoff.length > 0) {
                const entry = this.live.get(sessionId) ?? this.open(sessionId, options.model, binding.claudeSessionId ?? undefined, await this.prepare(sessionId, binding.claudeSessionId ?? undefined, binding))
                await this.runTurn(sessionId, entry, HANDOFF_BEFORE_COMPACT, [plan.handoff, ...plan.context], options, () => {}, { hidden: true })
            }
            const result = await this.runCompact(sessionId, command, plan.lastMessageId)
            return finish({ text: compactSummary(result), usage: undefined })
        }

        // Claude Code 自己开的轮已经答过：取回保存的回复，先于本轮其他输入的回答给出。
        const recalled = plan.surfaced.map(key => this.surfaced.get(key))
        for (const key of plan.surfaced) this.surfaced.delete(key)
        for (const outcome of recalled) {
            if (outcome !== undefined) for (const piece of outcome.pieces) emit(piece)
        }
        const lost = recalled.some(outcome => outcome === undefined)
        if (plan.promptIds.length > 0 && plan.promptBlocks.length === 0 && !lost) {
            // 这一轮没有交给 Claude Code：只记到最后一条输入，跟在后面的时间等上下文留给下一轮。
            plan = { ...plan, lastMessageId: plan.lastInputId }
            await this.writeBinding(sessionId, {
                claudeSessionId: this.live.get(sessionId)?.claudeSessionId ?? binding.claudeSessionId ?? null,
                lastMessageId: plan.lastMessageId,
            })
            return finish({ text: '', usage: undefined })
        }

        // 有待交出的交接文档：不论绑定里还记着哪个 Claude Code 会话，都开新对话（交接一经接受就记下，重启后也照此办）。
        const pending = binding.handoff ?? null
        const resume = pending !== null ? undefined : binding.claudeSessionId ?? undefined
        let entry = this.live.get(sessionId)
        if (entry !== undefined && pending !== null && !entry.handoffFresh) {
            this.dispose(sessionId)
            entry = undefined
        }
        if (entry === undefined) {
            entry = this.open(sessionId, options.model, resume, await this.prepare(sessionId, resume, binding))
            entry.handoffFresh = pending !== null
        } else if (entry.model !== options.model) {
            await entry.query.setModel(options.model)
            entry.model = options.model
        }
        // 交接后的新对话：第一条消息带上交接文档。新对话真的开起来（Claude Code 报来会话 id）以后才算交出、清掉记录、
        // 记下这条消息已发出；在那之前出了事（进程没起来、DSH 重启），下次连同交接文档重发这一批，不会丢。
        const handoff = pending !== null ? await this.handoffBlock(sessionId, pending, plan.promptIds) : null
        const save = (messageId, delivered = false) => {
            const handed = handoff !== null && delivered && entry.claudeSessionId !== null
            return this.writeBinding(sessionId, {
                claudeSessionId: entry.claudeSessionId,
                lastMessageId: handoff === null || handed ? messageId : binding.lastMessageId ?? null,
                conversation: entry.conversation,
                ...handed ? { handoff: null } : {},
            })
        }

        // 上次失败或中断：请它回答上一条。DSH 等待后重试时先探一下出口，还不通就不必让 Claude Code 再重试一遍。
        if (plan.promptIds.length === 0) {
            if (this.deps.reachable !== undefined && !(await this.deps.reachable(options.signal))) {
                throw new LlmError('Claude Code 的网络出口还连不上', 'TRANSPORT')
            }
            try {
                const startedAt = this.quota.now()
                // 请模型回答已经交出的上一条：这一轮作答的就是它，算答过积压。
                this.quota.turnCarries(sessionId)
                const outcome = await this.runTurn(sessionId, entry, '请回答我的上一条消息。', [], options, emit)
                this.quota.succeeded(sessionId, startedAt)
                return finish(outcome)
            } finally {
                await save(binding.lastMessageId)
            }
        }

        const context = [...plan.context]
        if (plan.handoff.length > 0) context.unshift(plan.handoff)
        if (handoff !== null) context.unshift(handoff)
        const prompt = plan.promptBlocks.length > 0 ? await this.userContent(plan, options.signal) : RECALL_SURFACED
        // 发送前记下这条消息已发出，重试时据此不再重复发送；本轮结束后再记下学到的 Claude Code 会话 id。
        // 失败时也不退回：消息已经在 Claude Code 自己的记录里，可能已部分执行，重发会重复执行。
        // 失败的一轮带着的输入由框架核心接住：记成未得到回应，附给下一轮。
        await save(plan.lastMessageId)
        const startedAt = this.quota.now()
        // 输入交给模型作答（带着从上次交出以后积下的全部输入）：这一轮正常结束才算答过积压。只取回自己开的轮、请它重说的不算。
        if (plan.promptBlocks.length > 0) this.quota.turnCarries(sessionId)
        let outcome
        try {
            try {
                outcome = await this.runTurn(sessionId, entry, prompt, context, options, emit)
            } catch (error) {
                if (error?.retired !== true) throw error
                // 旧进程已关闭；新进程续接同一 Claude Code 会话，接着做完这一条。只换一次。
                const continued = entry.claudeSessionId ?? resume
                entry = this.open(sessionId, options.model, continued, await this.prepare(sessionId, continued, { conversation: entry.conversation }))
                outcome = await this.runTurn(sessionId, entry, RESUME_AFTER_RETIRE, [], options, emit)
            }
        } catch (error) {
            // Claude Code 找不到要续接的会话：按绑定失效处理，新建会话并交接全部历史。
            if (resume !== undefined && error?.resumeMissing === true) {
                this.deps.logger?.warn?.(`galatea-agent-sdk: 续接 ${resume} 失败，改为新建会话`)
                this.dispose(sessionId)
                // 这一批随全部历史重新交接（在同一次请求里，这一轮不算失败）。
                await this.writeBinding(sessionId, { claudeSessionId: null, lastMessageId: null, conversation: null })
                return await this.converse(sessionId, options, onText)
            }
            await save(plan.lastMessageId, true)
            // 交到 Claude Code 以后才被拒：这几条已经在它的记录里（后面跟着额度报错），恢复后不再重发，唤醒时说明。
            if (error?.code === USAGE_LIMIT) {
                this.quota.reject(sessionId, { delivered: plan.promptIds.length - plan.surfaced.length, sources: plan.sources })
            }
            // 交接后的新对话没开起来：这一批没记成已发出，下次连同交接文档原样重发。
            throw error
        }
        await save(plan.lastMessageId, true)
        this.quota.succeeded(sessionId, startedAt)
        return finish(outcome)
    }

    /**
     * 压缩一个会话的 Claude Code 上下文（Claude Code 自带的 `/compact`）。排在这个会话正在进行的一轮之后，
     * 不打断它；在一轮之中调用（例如助手自己的工具）时不要等结果，否则会等到自己。
     * @returns `{ compacted, preTokens, reason }`
     */
    compact(sessionId, { instructions = '' } = {}) {
        return this.serial(sessionId, async () => {
            await this.deps.ready?.()
            return this.runCompact(sessionId, instructions)
        })
    }

    /** 在串行链里执行压缩；`lastMessageId` 给出时同时记下这条消息已处理（用户发的压缩命令）。 */
    async runCompact(sessionId, instructions, lastMessageId) {
        const binding = (await this.deps.bindings.get(sessionId)) ?? {}
        let entry = this.live.get(sessionId)
        if (entry === undefined) {
            if (!binding.claudeSessionId) return { compacted: false, preTokens: null, reason: '这个会话还没有 Claude Code 上下文' }
            entry = this.open(sessionId, this.config.models[0]?.id ?? 'opus', binding.claudeSessionId, await this.prepare(sessionId, binding.claudeSessionId, binding))
        }
        clearTimeout(entry.idle)
        entry.compaction = null
        const value = await new Promise((resolve, reject) => {
            // 压缩的结果不一定回显输入编号：这个等待者认领进程接下来的结果。
            entry.waiter = { uuid: randomUUID(), compact: true, onText: () => {}, settle: resolve, fail: reject }
            entry.input.push({ ...userMessage(instructions ? `/compact ${instructions}` : '/compact'), uuid: entry.waiter.uuid })
        })
        await this.writeBinding(sessionId, {
            claudeSessionId: entry.claudeSessionId,
            lastMessageId: lastMessageId ?? binding.lastMessageId ?? null,
            conversation: entry.conversation,
        })
        const meta = entry.compaction
        entry.compaction = null
        if (value.subtype !== 'success' || value.is_error) {
            return { compacted: false, preTokens: null, reason: value.result || (value.errors ?? []).join('; ') || value.subtype }
        }
        if (meta === null) return { compacted: false, preTokens: null, reason: 'Claude Code 没有报告压缩完成' }
        return { compacted: true, preTokens: meta.pre_tokens ?? null, reason: null }
    }

    /**
     * 本轮用户消息的内容：只有文字时是字符串；带图片时读出请求版本的字节，作为 base64 图片块，
     * 并附上原图的只读路径，Claude Code 需要处理原文件时可以直接读取。
     */
    async userContent(plan, signal) {
        // 有参考（作为单独的内容块）或有图片时发内容块；只有提问时发一段文字。
        if (plan.separate !== true && !plan.promptBlocks.some(block => block.type === 'image')) return plan.prompt
        const content = []
        for (const block of plan.promptBlocks) {
            if (block.type === 'text') {
                content.push({ type: 'text', text: block.text })
                continue
            }
            const image = await this.deps.readImage(block.attachment, imageTarget(block.attachment), signal)
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64') },
            })
            const path = this.deps.imagePath?.(block.attachment)
            if (path) content.push({ type: 'text', text: `[上图原文件（只读）：${path}]` })
        }
        return content
    }

    /**
     * 开进程之前要的东西：工具端点，和会话开头上下文。
     * - 新对话：起一个对话键；续接：沿用执行绑定里记的对话键（旧记录没有就起一个新的）。
     * - 两种都向核心 `open`，拿到的全文放进这个进程的系统提示：续接本来就是"用现在的段重新开头"，
     *   核心把这一次交出的版本记成这个对话的基线和看到的版本，模型看到的开头和核心记的始终是同一份。
     */
    async prepare(sessionId, resume, binding) {
        // 不续接就是新对话（交接以后、续接的会话没了），上下文从头算。
        if (resume === undefined) this.nextEpoch(sessionId)
        const tools = await this.endpointFor(sessionId)
        const segments = this.deps.segments
        if (segments === undefined) return { tools, conversation: null, launch: [] }
        const conversation = resume !== undefined && typeof binding?.conversation === 'string' ? binding.conversation : randomUUID()
        return { tools, conversation, launch: await segments.open(conversation, sessionId) }
    }

    /**
     * 这个会话的工具端点（核心的 MCP 端点，按会话发令牌，缓存到适配器关闭）；核心没给端点时为 `undefined`。
     */
    async endpointFor(sessionId) {
        if (this.endpoints.has(sessionId)) return this.endpoints.get(sessionId)
        const opened = await this.deps.toolEndpoint?.(sessionId)
        this.endpoints.set(sessionId, opened)
        return opened
    }

    /**
     * 打开一个常驻 Claude Code 进程，并开始读它的输出。会话开头上下文取最新版本放进系统提示。
     * @param prepared - `prepare` 给的工具端点、对话键和放进系统提示的开头上下文。
     */
    open(sessionId, model, resume, prepared = { tools: undefined, conversation: null, launch: [] }) {
        const input = inputStream()
        const { tools, conversation, launch } = prepared
        const entry = {
            input,
            model,
            claudeSessionId: resume ?? null,
            pendingContext: null,
            idle: undefined,
            turnSignal: undefined,
            /** 等待结果的那次请求：`{ uuid, onText, settle, fail }`。 */
            waiter: null,
            /** 进行中的一轮：`{ uuids, texts, owner }`，从它的第一条回复开始，到 `result` 为止。 */
            turn: null,
            /** 进行中的非环境类后台任务数。 */
            background: 0,
            /** 上一轮之后结束的后台任务的说明，用作 Claude Code 自己开一轮的起因。 */
            summaries: [],
            retire: false,
            /** 最近一次压缩的 `compact_metadata`（`pre_tokens` 等），压缩请求读完即清。 */
            compaction: null,
            /** 等这个进程空下来的（交接要等调用它的那一轮结束）。 */
            quietWaiters: [],
            /** 本进程看到的、上次压缩以来进入上下文的图片，以及已经提醒到第几档。续接的旧上下文里的图片不计。 */
            images: { count: 0, bytes: 0, reminded: 0 },
            /** 会话开头上下文在框架核心里按这个对话键记着版本（`null`：核心没给上下文段）。 */
            conversation,
            /** 兜底压缩后钩子装不下、留到下一轮附上的变更说明。 */
            carry: [],
            /** 这一次压缩后补发的那几份（几个钩子共用一次计算），下一轮开始时清掉。 */
            reopening: null,
        }
        // 产品工具经核心的工具端点交（HTTP MCP）：按调用方筛、只读端点、发起者、取消都在端点那一侧。服务名照旧叫 dsh。
        const dsh = tools === undefined ? undefined : { type: 'http', url: tools.url, headers: { Authorization: `Bearer ${tools.token}` } }
        // 配置里另加的 MCP 服务器（`mcpServers`）原样挂上；名字 dsh 留给产品工具，启动时已检查过不重名。
        const servers = { ...dsh === undefined ? {} : { dsh }, ...this.config.mcpServers ?? {} }
        const allowed = [...dsh === undefined ? [] : ['mcp__dsh'], ...this.config.allowedTools ?? []]
        const append = this.config.systemAppend ? `${SYSTEM_APPEND}\n${this.config.systemAppend}` : SYSTEM_APPEND
        const skills = this.deps.skills?.()
        entry.query = this.startQuery({
            prompt: input,
            options: {
                cwd: this.deps.cwdOf(sessionId) ?? this.config.defaultCwd,
                model,
                resume,
                env: this.deps.env(),
                permissionMode: this.config.permissionMode,
                disallowedTools: ['AskUserQuestion', ...this.config.disallowedTools ?? []],
                // 其他会话发来的消息不进 DSH 里的进程：用户在 DSH 里，跨会话消息由 DSH 外的 Claude Code 接收。
                // 推理强度由插件配置决定，不随共用配置目录里的 settings.json 变化。
                // 自动压缩只作兜底（线由配置定）；Claude Code 自带的自动记忆关掉，记忆只用 DSH 的一套。
                settings: {
                    crossSessionInbound: 'refuse',
                    effortLevel: this.config.effort ?? 'high',
                    autoMemoryEnabled: false,
                    ...(this.fallbackWindow ?? this.config.autoCompactWindow) ? { autoCompactWindow: this.fallbackWindow ?? this.config.autoCompactWindow } : {},
                },
                // 助手能用的 skill：配置了插件 skill 名单时进程打开时现读（用户级 skill 目录与名单里的插件 skill），否则不限制。
                ...Array.isArray(skills) ? { skills } : {},
                // 产品工具的权限由 DSH 执行器检查，在 Claude Code 一侧预先放行；另加的服务器只放行配置里 allowedTools 列出的。
                ...Object.keys(servers).length === 0 ? {} : { mcpServers: servers },
                ...this.config.strictMcpConfig === true ? { strictMcpConfig: true } : {},
                ...allowed.length === 0 ? {} : { allowedTools: allowed },
                // 系统提示在一段对话第一次请求时记下，沿用到压缩或开新对话；压缩后按这个进程启动时的追加段重新生成。
                systemPrompt: { type: 'preset', preset: 'claude_code', append: launch.length === 0 ? append : `${append}\n\n${openingText(launch)}` },
                hooks: withExtraHooks({
                    UserPromptSubmit: [{
                        hooks: [async () => {
                            const text = entry.pendingContext
                            entry.pendingContext = null
                            return text
                                ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
                                : {}
                        }],
                    }],
                    // 兜底的自动压缩之后：系统提示回到进程启动时的版本，之后改过的几节在那一刻补上（每个钩子各有 1 万字上限，分几个）。
                    SessionStart: openingSlots('SessionStart', async (slot, input) => {
                        if (input?.source !== 'compact') return undefined
                        return (await this.reopen(sessionId, entry))[slot]
                    }),
                    // Claude Code 自己压缩过：DSH 记录里也落一个边界，正文是它的摘要，DSH 侧的上下文跟着一起换掉。
                    PostCompact: [{
                        hooks: [async (input) => {
                            this.compacted(sessionId, entry, input)
                            return {}
                        }],
                    }],
                }, this.deps.extraHooks?.(sessionId)),
                stderr: line => this.deps.logger?.debug?.(`galatea-agent-sdk: ${line}`),
            },
        })
        entry.output = entry.query[Symbol.asyncIterator]()
        this.live.set(sessionId, entry)
        this.pump(sessionId, entry)
        return entry
    }

    /** 从头到尾读一个进程的输出；进程结束时让等待中的请求失败。 */
    async pump(sessionId, entry) {
        let failure
        try {
            while (true) {
                const { value, done } = await entry.output.next()
                if (done) break
                this.observe(sessionId, entry, value)
            }
            failure = new LlmError('Claude Code 进程意外结束', 'AGENT_SDK_EXITED')
        } catch (error) {
            failure = new LlmError(`Claude Code 进程异常结束：${error?.message ?? error}`, 'AGENT_SDK_EXITED', { cause: error })
        }
        // 记下进程已经结束：还没来得及交出请求就退出的，之后交给它的请求立即失败，不会一直等。
        entry.exited = failure
        if (this.live.get(sessionId) === entry) this.dispose(sessionId)
        const waiter = entry.waiter
        entry.waiter = null
        waiter?.fail(failure)
    }

    /** 处理进程的一条输出。 */
    observe(sessionId, entry, value) {
        entry.lastOutputAt = Date.now()
        if (typeof value.session_id === 'string') {
            // 进程报出它的 Claude Code 会话编号：这时就记下它服务哪个 DSH 会话（这份记录自己的归属，经历库读记录时查它）。
            if (entry.claudeSessionId !== value.session_id) {
                try {
                    this.deps.noteProcess?.(sessionId, value.session_id)
                } catch (error) {
                    this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 记进程归属失败：${error?.message ?? error}`)
                }
            }
            entry.claudeSessionId = value.session_id
        }
        if (!entry.retire && classifierLatched(value)) {
            entry.retire = true
            this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 的进程不再请求权限判定，换进程续接`)
            entry.query.interrupt().catch(() => {})
        }
        // 额度：Claude Code 每次额度状态变化时报来；被拒时记下，这一轮的失败据此归为额度用完。
        if (value.type === 'rate_limit_event') {
            if (value.rate_limit_info?.status === 'rejected') entry.rejection = value.rate_limit_info
            this.quota.observeEvent(value.rate_limit_info, entry.model)
            return
        }
        if (value.type === 'system') {
            if (value.subtype === 'background_tasks_changed' && Array.isArray(value.tasks)) {
                entry.background = value.tasks.filter(task => task?.ambient !== true).length
                this.armIdle(sessionId, entry)
            } else if (value.subtype === 'task_notification' && typeof value.summary === 'string' && value.summary !== '') {
                entry.summaries.push(value.summary)
            } else if (value.subtype === 'compact_boundary') {
                // 主动压缩、Claude Code 的兜底自动压缩都会报这个。
                this.nextEpoch(sessionId)
                entry.compaction = value.compact_metadata ?? {}
                entry.images = { count: 0, bytes: 0, reminded: 0 }
                // 压缩前的用量已经不算数，等下一次请求报来新的。
                entry.contextTokens = 0
            }
            return
        }
        // 工具结果里的图片（Read 读图等）留在主上下文里；子代理的留在它自己的上下文里，不算。
        if (value.type === 'user' && (value.parent_tool_use_id ?? null) === null) {
            // 内容也可能是一段文字（例如换模型时的提示），那里没有工具结果。
            const content = Array.isArray(value.message?.content) ? value.message.content : []
            const found = imagesIn(content.filter(block => block?.type === 'tool_result'))
            entry.images.count += found.count
            entry.images.bytes += found.bytes
            return
        }
        // 子代理的输出属于它自己的工具调用，不是这一轮的回复。
        if (value.type === 'assistant' && (value.parent_tool_use_id ?? null) === null) {
            clearTimeout(entry.idle)
            const turn = entry.turn ??= { uuids: [], texts: [], owner: null, usage: null }
            // 同一次内部请求的几条输出带着同一份用量；最后一次请求的就是当前上下文的大小。
            // 合成的报错消息带着全零的用量，不算当前上下文的大小。
            if (value.message?.usage && value.error === undefined) {
                turn.usage = value.message.usage
                const usage = value.message.usage
                entry.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
            }
            if (Array.isArray(value.user_message_uuids)) turn.uuids = value.user_message_uuids
            else if (typeof value.user_message_uuid === 'string') turn.uuids = [...turn.uuids, value.user_message_uuid]
            // Claude Code 合成的报错消息（额度用完、限流等）：记下信号，文字不是回复，不流给用户。
            const signal = limitSignal(value, this.usagePrefixes())
            if (signal !== null) {
                turn.signal = signal
                if (turn.owner === null && entry.waiter !== null && turn.uuids.includes(entry.waiter.uuid)) turn.owner = entry.waiter
                return
            }
            const texts = (value.message?.content ?? [])
                .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
                .map(block => block.text)
            turn.texts.push(...texts)
            // 这一轮认领了等待中的请求（包括请求被并进 Claude Code 自己开的一轮）：之前写下的也交给它。
            if (turn.owner === null && entry.waiter !== null && turn.uuids.includes(entry.waiter.uuid)) {
                turn.owner = entry.waiter
                for (const text of turn.texts) turn.owner.onText(text)
            } else if (turn.owner !== null) {
                for (const text of texts) turn.owner.onText(text)
            }
            return
        }
        if (value.type !== 'result') return

        const turn = entry.turn ?? { uuids: [], texts: [], owner: null, usage: null }
        entry.turn = null
        const waiter = entry.waiter
        // 压缩的结果不一定回显输入编号：压缩边界出现之后的结果归压缩请求；之前的（Claude Code 自己开的一轮）照常取回。
        const claimed = waiter !== null && (waiter.compact === true
            ? entry.compaction !== null || answers(value, turn, waiter)
            : turn.owner === waiter || answers(value, turn, waiter))
        if (claimed) {
            entry.waiter = null
            entry.summaries = []
            if (turn.owner === null) for (const text of turn.texts) waiter.onText(text)
            waiter.settle(value, turn)
        } else {
            this.adopt(sessionId, entry, value, turn)
        }
        entry.rejection = null
        if (entry.retire && entry.waiter === null && this.live.get(sessionId) === entry) this.dispose(sessionId)
        else this.armIdle(sessionId, entry)
        if (entry.turn === null && entry.waiter === null) for (const resolve of entry.quietWaiters.splice(0)) resolve()
    }

    /** Claude Code 自己开的一轮结束：保存回复，在 DSH 会话里开一轮取回。 */
    adopt(sessionId, entry, value, turn) {
        const cause = causeOf(value.origin, entry.summaries.splice(0))
        if (value.subtype !== 'success' || value.is_error) {
            // 额度用完打断了它：关上闸门，记进这个会话的积压，恢复后唤醒时告诉会话（不自动重开）。
            const reason = value.result || (value.errors ?? []).join('; ') || value.subtype
            if (failureCode(reason, this.signalOf(entry, turn), this.usagePrefixes()) === USAGE_LIMIT) {
                this.closeQuota(entry, turn)
                this.quota.interrupted(sessionId, cause)
            }
            this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 自己开的一轮（${cause}）失败：${value.result || (value.errors ?? []).join('; ') || value.subtype}`)
            return
        }
        const pieces = turn.texts.length > 0 ? [...turn.texts] : [value.result ?? '']
        const text = pieces.join(PIECE_SEPARATOR)
        if (text.trim() === '') return
        const key = `cc-${randomUUID().slice(0, 8)}`
        this.surfaced.set(key, { text, pieces, usage: turnUsage(value.usage, turn.usage) })
        while (this.surfaced.size > SURFACED_LIMIT) this.surfaced.delete(this.surfaced.keys().next().value)
        if (this.deps.surface === undefined) return
        Promise.resolve()
            .then(() => this.deps.surface(sessionId, { key, text: surfaceText(key, cause) }))
            .catch((error) => {
                this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 自己开的一轮没能转进 DSH：${error?.message ?? error}`)
            })
    }

    /**
     * 这一轮开始时的变更说明（作为这一轮的附加上下文）：上一次压缩后钩子装不下的，加上框架核心按这个对话记下的版本比出来的。
     * 自己改的不提、别人改的照常提，都由核心按工具端点的调用算。
     */
    async openingTurn(sessionId, entry) {
        entry.reopening = null
        const carried = entry.carry.splice(0)
        if (this.deps.segments === undefined || entry.conversation === null) return carried
        const notes = await this.deps.segments.changes(entry.conversation, sessionId)
        return [...carried, ...notes.map(note => `${NOTE_LEAD}${note}`)]
    }

    /**
     * 兜底的自动压缩（或 `/compact`）之后在 `SessionStart` 钩子里调用：重新生成的系统提示是进程启动时的版本，
     * 向核心要"对话开始以来改过的段"的全文补上。几个钩子共用一次计算；装不下的整条留到下一轮附上（随消息发送，没有钩子上限）。
     */
    reopen(sessionId, entry) {
        entry.reopening ??= (async () => {
            if (this.deps.segments === undefined || entry.conversation === null) return []
            const notes = await this.deps.segments.changes(entry.conversation, sessionId, { compacted: true })
            let fits = notes.length
            while (fits > 0 && openingPieces(notes.slice(0, fits), HOOK_CONTEXT_CHARS, OPENING_UPDATE_LEAD).length > OPENING_SLOTS) fits--
            if (fits < notes.length) {
                this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 压缩后要补的段超过 ${OPENING_SLOTS} 个钩子，${notes.length - fits} 条留到下一轮`)
                entry.carry.push(...notes.slice(fits).map(note => `${NOTE_LEAD}${note}`))
            }
            return openingPieces(notes.slice(0, fits), HOOK_CONTEXT_CHARS, OPENING_UPDATE_LEAD)
        })()
        return entry.reopening
    }

    /** 进程没有进行中的一轮（DSH 发来的或 Claude Code 自己开的）时兑现；进程关掉也兑现。 */
    quiet(entry) {
        if (entry.turn === null && entry.waiter === null) return Promise.resolve()
        return new Promise(resolve => entry.quietWaiters.push(resolve))
    }

    /** 读出执行绑定，合并改动后写回：各处只改自己关心的字段，不会把别的字段冲掉。 */
    async writeBinding(sessionId, patch) {
        const current = (await this.deps.bindings.get(sessionId)) ?? {}
        await this.deps.bindings.put(sessionId, {
            claudeSessionId: null,
            lastMessageId: null,
            ...current,
            ...patch,
            updatedAt: Date.now(),
        })
    }

    /**
     * 交接文档作为新对话第一条消息开头的一段，后面接最近几轮原文（这一轮要交的输入不算，免得交两遍）；
     * 读不到时说明一句，不挡住这一轮。
     */
    async handoffBlock(sessionId, path, promptIds = []) {
        let block
        try {
            const text = (await this.deps.readText(path)).trim()
            block = `${HANDOFF_LEAD}（${path}）\n\n${text}`
        } catch (error) {
            block = `${HANDOFF_LEAD}（${path}）\n\n（交接文档读不到：${error?.message ?? error}。需要时去经历库查上一段对话的结尾。）`
        }
        let recent = ''
        try {
            recent = (await this.deps.recentTurns?.(sessionId, { before: promptIds, handoffDocument: path })) ?? ''
        } catch (error) {
            this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 交接没带上最近几轮原文：${error?.message ?? error}`)
        }
        return recent === '' ? block : `${block}\n\n${recent}`
    }

    /**
     * 助手自己交接：核对交接文档与后台任务，排在这一轮之后关掉当前的 Claude Code 对话、换成新对话；
     * 交接文档随用户下一条消息交给新对话。立即返回核对结果，不等换对话（在一轮之中调用，等就会等到自己）。
     * @returns `{ scheduled: true }`，或 `{ scheduled: false, reason }`。
     */
    /**
     * 交接换新对话（框架的 newConversation）。
     * @param options.onSwitched - 真换过去以后调一次 `{ at }`（上下文模块据此往经历库推交接标记）。
     * @param options.ready - 换之前要等它（交接之前的整理）：等的时候占着串行链，下一条消息排在后面，新对话一定拿到整理之后的版本。
     */
    async handoff(sessionId, document, { onSwitched, ready } = {}) {
        if (typeof document !== 'string' || document.trim() === '') return { scheduled: false, reason: '没有给出交接文档的路径' }
        let text
        try {
            text = (await this.deps.readText(document)).trim()
        } catch (error) {
            return { scheduled: false, reason: `交接文档读不到：${error?.message ?? error}` }
        }
        if (text === '') return { scheduled: false, reason: '交接文档是空的' }
        const entry = this.live.get(sessionId)
        if (entry !== undefined && entry.background > 0) {
            return { scheduled: false, reason: `还有 ${entry.background} 个后台任务在跑（子代理、后台命令等），结果会回到旧对话；等它们结束再交接` }
        }
        // 一接受就记下：这之后 DSH 重启，下一条消息照样开新对话、交出交接文档，不会回到旧对话。
        await this.writeBinding(sessionId, { handoff: document })
        this.serial(sessionId, async () => {
            // 调用它的可能是 Claude Code 自己开的一轮（不占串行链）：等那一轮结束、回复取回以后再关。
            const live = this.live.get(sessionId)
            if (live !== undefined) await this.quiet(live)
            await Promise.resolve(ready).catch(() => {})
            if (this.live.get(sessionId) === live) this.dispose(sessionId)
            await this.writeBinding(sessionId, { claudeSessionId: null, conversation: null })
            try {
                onSwitched?.({ at: Date.now() })
            } catch (error) {
                this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 交接后的回调出错：${error?.message ?? error}`)
            }
            this.deps.logger?.info?.(`galatea-agent-sdk: ${sessionId} 已交接，下一条消息开新对话（${document}）`)
        }).catch(error => this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 交接失败：${error?.message ?? error}`))
        return { scheduled: true }
    }

    /**
     * DSH 记录里落下了一个边界（框架上下文模块经可选能力 `boundary.landed` 告诉）。是这段 Claude Code 对话已经知道的内容，
     * 就记下它的编号：之后交过的最后一条被它换掉时，以它为锚，只交它后面的消息（`planTurn` 的 `knownBoundary`）。
     * - 交接：新对话本来就从交接文档开始，总是已知的。
     * - 其余（切模型前写的交接、Claude Code 自己压缩过）：替当前这段对话落的才算。
     */
    boundaryLanded(sessionId, { compactionId, kind, conversation } = {}) {
        return this.serial(sessionId, async () => {
            const binding = (await this.deps.bindings.get(sessionId)) ?? {}
            const mine = kind === 'handoff' || (typeof conversation === 'string' && conversation === binding.claudeSessionId)
            if (!mine || typeof compactionId !== 'string') return { known: false }
            await this.writeBinding(sessionId, { knownBoundary: compactionId })
            return { known: true }
        })
    }

    /**
     * 切到别的执行方之前，在这段 Claude Code 对话里跑一轮看不见的交接，把回复存成交接文档（可选能力 `handoffTurn`）。
     * 进程不在时续接绑定里的对话；还没有对话时没有可交接的，抛错（框架改用裁剪的记录）。排在这个会话正在进行的一轮之后。
     * @returns `{ conversation }`：写交接的那段 Claude Code 对话（框架落边界后据此告诉这里它是已知的）。
     */
    handoffTurn(sessionId, { path, signal } = {}) {
        return this.serial(sessionId, async () => {
            await this.deps.ready?.()
            if (typeof path !== 'string' || path === '') throw new Error('没有给交接文档的路径')
            const binding = (await this.deps.bindings.get(sessionId)) ?? {}
            let entry = this.live.get(sessionId)
            if (entry === undefined) {
                if (!binding.claudeSessionId) throw new Error('这个会话还没有 Claude Code 对话，没有可交接的内容')
                entry = this.open(sessionId, this.config.models[0]?.id ?? 'opus', binding.claudeSessionId, await this.prepare(sessionId, binding.claudeSessionId, binding))
            }
            const outcome = await this.runTurn(sessionId, entry, handoffTurnPrompt(path), [], { signal }, () => {}, { hidden: true })
            const text = String(outcome?.text ?? '').trim()
            if (text === '') throw new Error('Claude Code 没有交回交接文档')
            await this.deps.writeText(path, `${text}
`)
            const conversation = entry.claudeSessionId ?? binding.claudeSessionId ?? null
            await this.writeBinding(sessionId, { claudeSessionId: conversation, conversation: entry.conversation ?? binding.conversation ?? null })
            this.deps.logger?.info?.(`galatea-agent-sdk: ${sessionId} 切走前写了交接（${path}）`)
            return { conversation }
        })
    }

    /**
     * Claude Code 压缩过上下文（兜底的自动压缩、`/compact`）：请框架在 DSH 记录里落一个边界（`deps.land`），正文是它的摘要，
     * 替这段对话落（落下后经 `boundary.landed` 回来，记成已知）。不等：边界等 DSH 会话空下来才落，失败由框架报。
     */
    compacted(sessionId, entry, input) {
        const text = typeof input?.compact_summary === 'string' ? input.compact_summary.trim() : ''
        if (text === '' || typeof this.deps.land !== 'function') return
        const kind = input.trigger === 'auto' ? 'auto-compact' : 'compact'
        Promise.resolve()
            .then(() => this.deps.land(sessionId, { kind, text, ...entry.claudeSessionId ? { conversation: entry.claudeSessionId } : {} }))
            .then((result) => {
                if (result?.landed === false) this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 压缩后 DSH 记录的边界没落下：${result.reason}`)
            })
            .catch(error => this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 压缩后请框架落边界出错：${error?.message ?? error}`))
    }

    nextEpoch(sessionId) {
        this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1)
    }

    /**
     * 这个会话的上下文用量（给框架的上下文模块）：`{ tokens, window, epoch }`，进程不在时没有。
     * `epoch` 在开新对话、压缩时各变一次。
     */
    usageOf(sessionId) {
        const entry = this.live.get(sessionId)
        if (entry === undefined || typeof entry.contextTokens !== 'number') return null
        return { tokens: entry.contextTokens, window: this.config.contextWindow ?? null, epoch: this.epochs.get(sessionId) ?? 0 }
    }

    /** 兜底压缩线（框架的上下文模块按它的策略设）：之后开的进程用它。 */
    setFallbackThreshold(tokens) {
        this.fallbackWindow = tokens
    }

    /** 记下这一轮用户消息带的图片；累计越过下一档时给出一条提醒（作为这一轮的附加上下文）。 */
    imageNotice(entry, prompt) {
        const found = imagesIn(Array.isArray(prompt) ? prompt : [])
        entry.images.count += found.count
        entry.images.bytes += found.bytes
        const step = this.config.imageRemindBytes ?? IMAGE_REMIND_BYTES
        if (step === 0) return []
        const level = Math.floor(entry.images.bytes / step)
        if (level <= entry.images.reminded) return []
        entry.images.reminded = level
        return [imageReminder(entry.images)]
    }

    /**
     * 会话的 Claude Code 进程现状：进程在不在、还在跑的后台任务（子代理、后台命令等）数、是否在一轮之中、最近一次输出的时间。
     * 进程关着时都是空值。
     */
    activity(sessionId) {
        const entry = this.live.get(sessionId)
        if (entry === undefined) return { live: false, background: 0, busy: false, lastOutputAt: null }
        return {
            live: true,
            background: entry.background,
            busy: entry.turn !== null || entry.waiter !== null,
            lastOutputAt: entry.lastOutputAt ?? null,
        }
    }

    /**
     * 发送一条用户消息并等到回应它的 `result`；`prompt` 是文字或内容块数组，`onText` 收到这一轮依次写下的文字。
     * `hidden` 的一轮（压缩前的准备）回复不给用户，不带等着的提示。
     */
    async runTurn(sessionId, entry, prompt, context, options, onText, { hidden = false } = {}) {
        if (entry.exited) throw entry.exited
        clearTimeout(entry.idle)
        const opening = hidden ? [] : await this.openingTurn(sessionId, entry)
        if (entry.exited) throw entry.exited
        // 附提醒在框架核心：每轮把还没交到的交出去；这一轮成功结束、模型跑过才算交到，由核心在一轮结束时判。
        const attached = hidden ? [] : (this.deps.attachments?.(sessionId) ?? []).map(item => item.text)
        const extra = [
            ...context, ...opening, ...this.imageNotice(entry, prompt), ...attached,
        ].join('\n\n')
        // 短的附加上下文走钩子；过长时随用户消息发送，放在用户的话前面，不被截断。
        const viaHook = extra.length <= HOOK_CONTEXT_CHARS
        if (!viaHook) {
            this.deps.logger?.info?.(`galatea-agent-sdk: ${sessionId} 的附加上下文 ${extra.length} 字，超过钩子安全长度，改随消息发送`)
            prompt = [{ type: 'text', text: `${CONTEXT_LEAD}\n${extra}` }, ...typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt]
        }
        entry.pendingContext = viaHook && extra !== '' ? extra : null
        const signal = options.signal
        entry.turnSignal = signal
        const onAbort = () => {
            entry.query.interrupt().catch(() => {})
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        return new Promise((resolve, reject) => {
            const done = () => {
                signal?.removeEventListener('abort', onAbort)
                entry.turnSignal = undefined
            }
            entry.waiter = {
                uuid: randomUUID(),
                onText,
                settle: (value, turn) => {
                    done()
                    let outcome
                    try {
                        outcome = this.outcomeOf(sessionId, entry, value, signal, turn)
                    } catch (error) {
                        reject(error)
                        return
                    }
                    resolve(outcome)
                },
                fail: (error) => {
                    done()
                    reject(error)
                },
            }
            entry.input.push({ ...userMessage(prompt), uuid: entry.waiter.uuid })
        })
    }

    /** 回应请求的 `result` 转为本轮结果；停止、换进程与失败抛出。 */
    outcomeOf(sessionId, entry, value, signal, turn) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted')
        if (entry.retire) throw Object.assign(new LlmError('Claude Code 进程的权限判定失效', 'AGENT_SDK_RETIRED'), { retired: true })
        if (value.subtype !== 'success' || value.is_error) {
            const errors = value.errors ?? []
            const reason = value.result || errors.join('; ') || value.subtype
            const code = failureCode(reason, this.signalOf(entry, turn), this.usagePrefixes())
            if (code === USAGE_LIMIT) {
                this.closeQuota(entry, turn)
                throw this.usageLimitError()
            }
            const failure = new LlmError(`Claude Code 本轮失败：${reason}`, code)
            failure.resumeMissing = errors.some(text => /No conversation found/.test(text))
            if (failure.resumeMissing) this.dispose(sessionId)
            throw failure
        }
        return { text: value.result ?? '', usage: turnUsage(value.usage, turn?.usage) }
    }

    /**
     * 没有请求在等、也没有一轮在进行时开始计时，超时后关闭进程，下一轮按绑定续接。后台任务还在跑时
     * 按 `backgroundHours` 计时，免得关进程时一并停掉它们。
     */
    armIdle(sessionId, entry) {
        clearTimeout(entry.idle)
        if (this.live.get(sessionId) !== entry || entry.waiter !== null || entry.turn !== null) return
        const minutes = entry.background > 0 ? this.config.backgroundHours * 60 : this.config.idleMinutes
        entry.idle = setTimeout(() => {
            if (this.live.get(sessionId) === entry && entry.waiter === null && entry.turn === null) this.dispose(sessionId)
        }, minutes * 60_000)
        entry.idle.unref?.()
    }

    /** 关闭一个会话的进程。 */
    dispose(sessionId) {
        const entry = this.live.get(sessionId)
        if (entry === undefined) return
        this.live.delete(sessionId)
        clearTimeout(entry.idle)
        for (const resolve of entry.quietWaiters.splice(0)) resolve()
        entry.input.close()
        entry.query.close?.()
    }

    /** 关闭全部进程。 */
    close() {
        this.closed = true
        this.quota.stop()
        for (const sessionId of [...this.live.keys()]) this.dispose(sessionId)
        for (const opened of this.endpoints.values()) if (opened !== undefined) this.deps.closeToolEndpoint?.(opened.token)
        this.endpoints.clear()
    }

    /** SDK 的额度用完报错前缀（兜底认文字）；SDK 还没加载或没有导出时为空。 */
    usagePrefixes() {
        const prefixes = this.deps.loadSdk?.()?.USAGE_LIMIT_ERROR_PREFIXES
        return Array.isArray(prefixes) ? prefixes : []
    }

    /** 这一轮的额度信号：助手报错消息上的，或这一轮里报来的“被拒”。 */
    signalOf(entry, turn) {
        if (turn?.signal?.kind === 'usage') return turn.signal
        const info = entry?.rejection
        if (info !== null && info !== undefined) {
            return { kind: 'usage', resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null, rateLimitType: info.rateLimitType ?? null }
        }
        return turn?.signal ?? null
    }

    /** 按这一轮的信号关上额度闸门。 */
    closeQuota(entry, turn) {
        const signal = this.signalOf(entry, turn)
        this.quota.close({
            resetsAt: signal?.kind === 'usage' ? signal.resetsAt ?? null : null,
            rateLimitType: signal?.kind === 'usage' ? signal.rateLimitType ?? null : null,
            model: entry?.model ?? null,
        })
    }

    /** 额度用完的失败：不交给 DSH 重试。 */
    usageLimitError() {
        const record = this.quota.record
        const when = record.resetsAt === null ? '恢复时间不明' : `最晚 ${new Date(record.resetsAt).toISOString()} 恢复`
        return new LlmError(`Claude 额度用完（${record.rateLimitType ?? '类型不明'}，${when}），恢复后自动接着处理`, USAGE_LIMIT, { status: 429 })
    }

    /**
     * 经 SDK 的用量查询读额度窗口（不经模型）。`spawn` 为真且没有在跑的进程时，开一个不发任何输入的短暂进程查完就关。
     * @returns 各窗口（`usageWindows`），查不到或不可用时 `null`。
     */
    /**
     * 拉起 Claude Code 进程的唯一入口（会话进程、用量查询、额度探测、单次调用都经这里）：登录方式没选对时不拉起，
     * 抛出写明怎么改的错误，不悄悄用本机的登录。
     */
    startQuery(request) {
        const authProblem = this.deps.authProblem?.()
        if (authProblem) throw new LlmError(authProblem, 'AGENT_SDK_AUTH')
        return this.deps.loadSdk().query(request)
    }

    async readUsage({ spawn = false } = {}) {
        const live = [...this.live.values()].find(entry => !entry.exited && typeof entry.query?.[USAGE_METHOD] === 'function')
        const ask = query => Promise.race([
            query[USAGE_METHOD]({ skipBehaviors: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('用量查询超时')), 30_000).unref?.()),
        ])
        if (live !== undefined) return usageWindows(await ask(live.query))
        if (!spawn) return null
        const idle = inputStream()
        const query = this.startQuery({
            prompt: idle,
            options: { cwd: this.config.defaultCwd, model: this.quota.record.model ?? this.config.models[0]?.id ?? 'opus', env: this.deps.env(), tools: [], persistSession: false, permissionMode: 'dontAsk' },
        })
        if (typeof query?.[USAGE_METHOD] !== 'function') {
            idle.close()
            query?.close?.()
            return null
        }
        // 输出要有人读，进程才不会堵住；这里什么都不用。
        const drain = (async () => {
            for await (const value of query) void value
        })().catch(() => {})
        try {
            return usageWindows(await ask(query))
        } finally {
            idle.close()
            query.close?.()
            void drain
        }
    }

    /** 额度正常时的定期用量：只经在跑的进程查，不为此另开进程。 */
    pollUsage() {
        return this.readUsage({ spawn: false })
    }

    /**
     * 额度用完期间查一次恢复没有：先查用量（不经模型）；用量查不到时，按配置用被拒的模型发一次最小请求（不用工具、只一轮、不存记录）。
     * @returns `{ status: 'allowed'|'rejected'|'unknown', via, resetsAt?, rateLimitType?, windows? }`
     */
    async probeQuota({ model, rateLimitType }) {
        // 登录方式没选对：不拉进程探，答不知道（定时探测不该因此报错）。
        if (this.deps.authProblem?.()) return { status: 'unknown', via: null }
        const config = this.quota.config
        if (config.usageQuery) {
            let windows = null
            try {
                windows = await this.readUsage({ spawn: true })
            } catch (error) {
                this.deps.logger?.debug?.(`galatea-agent-sdk: 用量查询失败：${error?.message ?? error}`)
            }
            if (windows !== null) {
                const limiting = rateLimitType !== null && windows[rateLimitType] !== undefined
                    ? [[rateLimitType, windows[rateLimitType]]]
                    : Object.entries(windows)
                const full = limiting.find(([, window]) => window.utilization >= 1)
                if (full === undefined) return { status: 'allowed', via: 'usage', windows }
                return { status: 'rejected', via: 'usage', resetsAt: full[1].resetsAt, rateLimitType: full[0], windows }
            }
        }
        if (!config.modelProbe) return { status: 'unknown', via: null }
        const query = this.startQuery({
            prompt: '只回复 ok。',
            options: {
                cwd: this.config.defaultCwd,
                model: model ?? this.config.models[0]?.id ?? 'opus',
                env: this.deps.env(),
                tools: [],
                maxTurns: 1,
                persistSession: false,
                permissionMode: 'dontAsk',
            },
        })
        const seen = { rejection: null }
        const turn = { signal: null }
        for await (const value of query) {
            if (value.type === 'rate_limit_event') {
                if (value.rate_limit_info?.status === 'rejected') seen.rejection = value.rate_limit_info
                continue
            }
            if (value.type === 'assistant') turn.signal = limitSignal(value, this.usagePrefixes()) ?? turn.signal
            if (value.type !== 'result') continue
            if (value.subtype === 'success' && !value.is_error) return { status: 'allowed', via: 'model' }
            const reason = value.result || value.subtype
            const signal = this.signalOf(seen, turn)
            if (failureCode(reason, signal, this.usagePrefixes()) === USAGE_LIMIT) {
                return { status: 'rejected', via: 'model', resetsAt: signal?.resetsAt ?? null, rateLimitType: signal?.rateLimitType ?? null }
            }
            return { status: 'unknown', via: 'model' }
        }
        return { status: 'unknown', via: 'model' }
    }

    /** 标题、压缩等辅助请求：一次性查询，不用工具，不保存会话。 */
    async oneShot(options) {
        if (this.quota.limited()) throw this.usageLimitError()
        const query = this.startQuery({
            prompt: flattenForOneShot(options.messages, options.system),
            options: {
                cwd: this.config.defaultCwd,
                model: options.model,
                env: this.deps.env(),
                tools: [],
                maxTurns: 1,
                persistSession: false,
                permissionMode: 'dontAsk',
            },
        })
        const onAbort = () => {
            query.interrupt().catch(() => {})
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        const startedAt = this.quota.now()
        const seen = { rejection: null, model: options.model }
        const turn = { signal: null }
        try {
            for await (const value of query) {
                if (value.type === 'rate_limit_event') {
                    if (value.rate_limit_info?.status === 'rejected') seen.rejection = value.rate_limit_info
                    this.quota.observeEvent(value.rate_limit_info, options.model)
                    continue
                }
                if (value.type === 'assistant') turn.signal = limitSignal(value, this.usagePrefixes()) ?? turn.signal
                if (value.type !== 'result') continue
                if (value.subtype !== 'success' || value.is_error) {
                    const reason = value.result || value.subtype
                    if (failureCode(reason, this.signalOf(seen, turn), this.usagePrefixes()) === USAGE_LIMIT) {
                        this.closeQuota(seen, turn)
                        throw this.usageLimitError()
                    }
                    throw new LlmError(`Claude Code 辅助请求失败：${reason}`, 'AGENT_SDK_TURN_FAILED')
                }
                this.quota.succeeded(undefined, startedAt)
                return textChunks(value.result, value.usage)
            }
            throw new LlmError('Claude Code 辅助请求没有结果', 'AGENT_SDK_EXITED')
        } finally {
            options.signal?.removeEventListener('abort', onAbort)
        }
    }
}
