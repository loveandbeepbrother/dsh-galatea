/**
 * 把一次模型请求的消息历史拆成 Claude Code 这一轮要收到的内容。
 *
 * AgentLoop 每次请求都带完整的派生历史。Claude Code 自己保存它见过的对话，所以只需交给它
 * 执行绑定记录之后新增的部分：
 *
 * - 末尾的用户输入（来源为 `user` 的 user 消息）作为本轮用户消息发送；
 * - 其他来源的 user 消息（时间、通知等）作为附加上下文；
 * - 运行时上下文快照取整段历史里最新一份的各节，适配器只用其中的人格、长期认知、常驻记忆、记忆目录、渠道约定；
 *   DSH 自己压缩留下的检查点不交；
 * - 其间其他模型的回复与工具结果作为接续材料，按预算保留最近的部分；
 * - Claude Code 自己产生的回复与 system / developer 消息跳过。
 *
 * @module @loveandbeepbrother/dsh-galatea-agent-sdk/plan
 */

/** 接续材料的默认字符预算。 */
export const DEFAULT_HANDOFF_CHARS = 24_000

/** 单条工具结果在接续材料里保留的字符数。 */
const TOOL_RESULT_CHARS = 600

/**
 * 取消息内容中的可读文本。
 * @param content - 消息的内容块。
 * @returns 文本块按顺序拼接，图片与文件以占位说明代替。
 */
export function textOf(content) {
    const parts = []
    for (const block of content ?? []) {
        if (block.type === 'text') parts.push(block.text)
        else if (block.type === 'image') {
            const label = block.attachment?.name ?? block.attachment?.attachmentId
            parts.push(label ? `[图片 ${label}]` : '[图片]')
        }
        else if (block.type === 'file') {
            const label = block.attachment?.name ?? block.attachment?.attachmentId
            parts.push(label ? `[文件 ${label}]` : '[文件]')
        }
        else if (block.type === 'tool-call') parts.push(`[调用工具 ${block.name}]`)
    }
    return parts.join('\n').trim()
}

/** Claude Code 自己开的一轮转进 DSH 时的输入来源（未绑定渠道时）。 */
export const SURFACE_SOURCE = 'agent-sdk'

/** 那一轮的输入文字首行带编号；经渠道转交时来源是 `user`，按这一行认出。 */
const SURFACE_LINE = /^【后台一轮 (cc-[0-9a-f]{8})】/m

/**
 * Claude Code 自己开的一轮在 DSH 里的输入文字。
 * @param key - 编号，适配器按它取回那一轮的回复。
 * @param cause - 起因，例如“后台任务「通读聊天记录」有了结果”。
 */
export function surfaceText(key, cause) {
    return `【后台一轮 ${key}】（系统转交，不是用户发言）${cause}，我自己接着处理了一轮，回复如下。`
}

/** 额度恢复后唤醒有积压的会话的那段话（未绑定渠道时）。 */
export const QUOTA_SOURCE = 'assistant-quota'

/**
 * 提问还是参考由框架核心认（`core.classify`，核心在 pre-step 已经把结果写进 `source.intent`）。
 * 没有核心时按消息里写好的分类：没写的当参考。
 */
export const intentOf = message => (message?.source?.intent === 'prompt' ? 'prompt' : 'context')

/** 输入是 Claude Code 自己开的一轮时返回其编号。 */
export function surfacedKey(message) {
    if (message.source?.kind === SURFACE_SOURCE && typeof message.source.key === 'string') return message.source.key
    return SURFACE_LINE.exec(textOf(message.content))?.[1]
}

/** DSH 的运行时上下文快照：不按消息交；适配器只从中取会话开头上下文的几节。 */
const SNAPSHOT_SOURCE = 'runtime-context'
/** DSH 记录里的边界（压缩检查点）：之前的记录换成了它的正文（交接文档、摘要），来源里带 `compactionId`。 */
const CHECKPOINT_SOURCE = 'compact-checkpoint'
/** 边界的正文作为接续材料时的开头。 */
export const BOUNDARY_LINE_LEAD = '（这之前的记录在 DSH 里换成了下面这份交接或摘要）'

/** 只对原生有用、不交给 Claude Code 的消息由框架核心按来源登记认（`core.sourceAudience`）；没有核心时都交。 */
export const audienceOf = () => 'all'

/**
 * 只有参考、没有提问的一轮：这一轮的摆法由执行方加。每条参考是谁放进来的、里面的话照不照做，
 * 核心已经写在它正文开头（来源标注）。
 */
export const NO_QUESTION_LEAD = '（这一轮没有人在问你：下面是会话里新进来的消息。需要处理就处理，不需要回应就整条只输出 [不发]。）'

/**
 * 一份运行时快照的各节 `{ name, text }`，DSH 在来源里记下了各节。没有分节记录时返回空数组：
 * 适配器只认得出按名字列出的节。
 * @param message - 来源为 `runtime-context` 的消息。
 */
export function snapshotSections(message) {
    const sections = message.source?.sections
    if (!Array.isArray(sections)) return []
    return sections
        .filter(section => typeof section?.name === 'string' && typeof section.text === 'string')
        .map(({ name, text }) => ({ name, text }))
}

/** 是否为本轮需要回答的输入。 */
function isUserInput(message, classify = intentOf) {
    return message.role === 'user' && classify(message) === 'prompt'
}

/** 用户直接发的压缩命令：`/压缩` 或 `/compact`，后面可以跟“重点保留什么”的说明。单独一条时由适配器不经模型处理。 */
export const COMPACT_COMMAND = /^\/(?:压缩|compact)(?:\s+([\s\S]*))?$/i

/** 认命令用的文字：用户本人从渠道说的话，核心写在开头的来源行不算内容。别人转来的消息标注不去，里面的命令不算数。 */
function commandTextOf(message, content = message.content) {
    const text = textOf(content)
    const annotation = message.source?.annotation
    if (message.source?.speaker?.kind !== 'user' || typeof annotation !== 'string') return text
    return text.startsWith(`${annotation}\n`) ? text.slice(annotation.length + 1) : text
}

/**
 * 交给 Claude Code 的文字：它只认开头的 `/` 是自己的命令，用户从渠道单独发的命令不带来源行，其余照原样（带着来源行）。
 * 只用于这一轮只有这一条提问时：几条连成一段时，开头的命令会把后面的话吞成它的参数。
 */
function deliveredText(message, content = message.content) {
    const command = commandTextOf(message, content)
    return command.trimStart().startsWith('/') ? command : textOf(content)
}

/**
 * 这条输入要模型作答：本轮提问的来源，且不是 Claude Code 自己开的轮（只取回保存的回复）、也不是压缩命令（不经模型处理）。
 * 额度恢复后按会话里的事件判断“答过积压”时用。
 */
export function asksModel(message) {
    if (message?.role !== 'user' || intentOf(message) !== 'prompt' || surfacedKey(message) !== undefined) return false
    return !COMPACT_COMMAND.test(commandTextOf(message).trim())
}

/** 一条历史消息在接续材料中的写法；不进入材料时返回空串。 */
function renderHistory(message, classify) {
    if (message.source?.kind === CHECKPOINT_SOURCE) return `${BOUNDARY_LINE_LEAD}
${textOf(message.content)}`
    if (isUserInput(message, classify)) {
        return `${message.source?.speaker?.kind === 'user' ? '用户' : '系统转交'}：${textOf(message.content)}`
    }
    if (message.role === 'assistant') {
        const source = message.source ?? {}
        return `助手（${source.provider ?? '?'}/${source.model ?? '?'}）：${textOf(message.content)}`
    }
    if (message.role === 'tool') {
        const text = textOf(message.content)
        const clipped = text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS)}…` : text
        return `[工具结果] ${clipped}`
    }
    return ''
}

/**
 * 拆分一次请求。
 * @param messages - 请求的完整消息历史。
 * @param options - `route` 本适配器的提供方名；`lastMessageId` 绑定记录中已交给 Claude Code 的最后一条消息；
 *   `handoffChars` 接续材料预算；`knownBoundary` 这段 Claude Code 对话已经知道的 DSH 边界（`compactionId`）。
 *   交过的最后一条已经被 DSH 侧的边界换掉时，以边界为锚：是已知的边界，只交它后面的；不是，先交它的正文，再交后面的。
 * @returns `{ prompt, promptBlocks, promptIds, sources, surfaced, lastMessageId, context, snapshot, handoff }`；没有新输入时
 *   `promptIds` 为空；`surfaced` 是其中 Claude Code 自己开的轮的编号，它们不进 `prompt`。
 *   文件在请求组装时已投影为带只读路径的文字，按文字处理。
 */
export function planTurn(messages, { route, lastMessageId, knownBoundary = null, handoffChars = DEFAULT_HANDOFF_CHARS, classify = intentOf, audience = audienceOf }) {
    const isInput = message => isUserInput(message, classify)
    const nativeOnly = message => audience(message) === 'native-only'
    const bound = lastMessageId !== undefined && lastMessageId !== null
    let known = bound ? messages.findIndex(message => message.id === lastMessageId) : -1
    // 交过的最后一条被 DSH 侧的边界换掉了（交接、执行方自己压缩过、切模型、原生压缩）：以边界为锚，不当成从头交接。
    let carried = null
    if (bound && known < 0) {
        const checkpoint = messages.findLastIndex(message => message.source?.kind === CHECKPOINT_SOURCE)
        if (checkpoint >= 0) {
            known = checkpoint
            if (messages[checkpoint].source?.compactionId !== knownBoundary) carried = messages[checkpoint]
        }
    }
    const fresh = known < 0
    const added = messages.slice(known + 1)
        .filter(message => message.role !== 'system' && message.role !== 'developer')

    // 末尾连续的 user 消息是本轮：其中的用户输入是提问；之前的内容按类别分到上下文与接续材料。
    let start = added.length
    while (start > 0 && added[start - 1].role === 'user') start--
    const tail = added.slice(start)
    const inputs = tail.filter(isInput)
    // Claude Code 自己开的那一轮已经答过，只取回回复，不再作为提问。
    const surfaced = inputs.map(surfacedKey).filter(key => key !== undefined)
    const asked = inputs.filter(message => surfacedKey(message) === undefined)
    // 只有参考、没有提问的一轮：别的插件放进会话的消息叫醒了它。把这些消息当作这一轮的输入交出，前面写明来源。
    // 否则 promptIds 为空、lastMessageId 没动，会被下面适配器当成"重试同一个请求"，把上一条回复原样重放。
    // DSH 交给适配器的请求里没有重试标识（GenerateOptions 只有 provider、model、messages、signal 等），"是不是重试"只能这样反推：
    // 有新进来的、可以交的消息就不是重试。
    const references = asked.length === 0 && surfaced.length === 0
        ? tail.filter(message => message.role === 'user' && !isInput(message) && !nativeOnly(message))
        : []
    const prompts = asked.length > 0 ? asked : references
    const turnInputs = [...inputs, ...references]
    const contextMessages = added
        .filter(message => message.role === 'user' && !isInput(message) && !nativeOnly(message)
            && !references.includes(message))
    // 快照取整段历史里最新的一份：Claude Code 压缩或换进程以后，即使快照没有变化也要整份补上。
    const latestSnapshot = messages.findLast(message => message.role === 'user' && message.source?.kind === SNAPSHOT_SOURCE)

    // 续接时 Claude Code 已有自己的回复；从头交接时它们也是历史。
    const lines = [...carried === null ? [] : [carried], ...added.slice(0, start)]
        .filter(message => fresh || !(message.role === 'assistant' && message.source?.provider === route))
        .map(message => renderHistory(message, classify))
        .filter(line => line.length > 0)
    let handoff = ''
    if (lines.length > 0) {
        let kept = []
        let size = 0
        for (let index = lines.length - 1; index >= 0; index--) {
            if (size + lines[index].length > handoffChars && kept.length > 0) break
            kept.unshift(lines[index])
            size += lines[index].length
        }
        const omitted = lines.length - kept.length
        const head = fresh
            ? '以下是这段对话在交给你之前的记录'
            : '以下是你离开期间这段对话新增的记录（由其他模型处理）'
        handoff = [
            `${head}${omitted > 0 ? `；更早的 ${omitted} 条未列出，需要时可用记忆工具查找` : ''}：`,
            ...kept,
        ].join('\n')
    }

    // 本轮提问的内容块：文字按消息拼接，未卸载的图片保留原块，交给适配器读出字节。
    const lead = references.length > 0 ? NO_QUESTION_LEAD : null
    const blocksOf = (message) => {
        const blocks = []
        const content = (message.content ?? []).filter(block => block.type !== 'image' || block.offloaded === true)
        const text = prompts.length === 1 && message === prompts[0] ? deliveredText(message, content) : textOf(content)
        if (text.length > 0) blocks.push({ type: 'text', text })
        for (const block of message.content ?? []) {
            if (block.type === 'image' && block.offloaded !== true) blocks.push(block)
        }
        return blocks
    }
    const askedBlocks = prompts.flatMap(blocksOf)
    // 参考：放进同一条用户消息、作为单独的内容块，图片跟在对应的块后面，排在提问前面；
    // 正文开头已经有核心写的来源标注。只在这一轮真的交给 Claude Code 时才带（只取回它自己开的轮时不带，留给下一轮）。
    const referenceBlocks = askedBlocks.length > 0 ? contextMessages.flatMap(blocksOf) : []
    const promptBlocks = [...lead === null ? [] : [{ type: 'text', text: lead }], ...referenceBlocks, ...askedBlocks]
    const promptText = prompts.length === 1 ? deliveredText(prompts[0]) : prompts.map(message => textOf(message.content)).filter(text => text.length > 0).join('\n\n')

    return {
        prompt: lead === null ? promptText : `${lead}\n\n${promptText}`,
        // 单独一条提问时认压缩命令用的文字。
        commandText: prompts.length === 1 ? commandTextOf(prompts[0]) : null,
        promptBlocks,
        // 这一轮带了参考块：要按内容块发，不并成一段文字。
        separate: referenceBlocks.length > 0,
        // 这一轮的输入是别的插件放进来的参考，不是提问：不当成压缩命令。
        reference: references.length > 0,
        promptIds: turnInputs.map(message => message.id),
        // 各条输入的来源（额度用完时记进积压，只有后台思考输入的会话恢复后不唤醒）。
        sources: turnInputs.map(message => message.source?.kind ?? 'user'),
        surfaced,
        // 记到这一组末尾的最后一条：DSH 在输入之后追加的时间等上下文也算已交，下一轮不再当成新增重发。
        lastMessageId: turnInputs.length > 0 ? tail[tail.length - 1].id : lastMessageId ?? null,
        // 最后一条输入：这一轮不交给 Claude Code 时（只取回它自己开的轮）只记到这里。
        lastInputId: turnInputs.length > 0 ? turnInputs[turnInputs.length - 1].id : lastMessageId ?? null,
        // 参考已经放进内容块，附加上下文（钩子）只留给附提醒和段的变更说明。
        context: [],
        snapshot: latestSnapshot === undefined ? null : snapshotSections(latestSnapshot),
        handoff,
    }
}

/**
 * 把一次辅助请求（标题、压缩）的全部消息平铺成一段文本。
 * 运行时快照只放最新一份：每份都取代之前的，长会话里攒下的几百份全放进去会超过 Claude Code 的上限。图片、文件只放占位（`textOf`）。
 * @param messages - 请求的完整消息历史。
 * @param system - 一次性调用方提供的系统提示。
 * @returns 供单次查询使用的提示文本。
 */
export function flattenForOneShot(messages, system) {
    const lines = []
    if (system) lines.push(`[系统]\n${system}`)
    const latestSnapshot = messages.findLast(message => message.source?.kind === SNAPSHOT_SOURCE)
    for (const message of messages) {
        if (message.source?.kind === SNAPSHOT_SOURCE && message !== latestSnapshot) continue
        const text = textOf(message.content)
        if (text.length === 0) continue
        lines.push(`[${message.role}]\n${text}`)
    }
    return lines.join('\n\n')
}
