/**
 * 上下文模块：交接、换新对话、主动压缩、用量提醒、兜底压缩线。提供服务 `context`。
 *
 * 不碰具体执行方：只用核心认出的这个会话的执行方，和它的能力（能力的值就是实现，`core.executors`），以及核心的 `attach`、`tool`。
 * - 交接：文档要存在且非空；执行方的 `newConversation` 再看它自己的条件（后台任务没跑完等），通过就等会话空下来换新对话。
 *   新对话的开头是核心的开头段，第一轮输入的最前面是交接文档（由执行方摆）。
 * - 主动压缩：执行方的 `compact`；没有的执行方，压缩工具不交给它的会话。
 * - 用量提醒：每一轮结束时问执行方的 `usage`（`{ tokens, window, epoch }`），过 `remindFrom` 提醒一次，之后每涨 `remindStep` 再提醒；
 *   `epoch` 变了（执行方换了新对话或压缩过）就重计，不按用量的涨落去猜。提醒经核心的 `attach` 交给会话，原生会话也一样。
 * - 兜底压缩：会话加载时问它的执行方，第一次见到某份兜底压缩线能力就设到 `fallbackCompactAt`（执行方有 `fallbackThreshold` 时）。
 * - **交接标记**：本模块是经历库的一个推送式来源（`context-handoff`）。执行方真换过新对话以后经 `onSwitched`
 *   回来，这里往经历库推一条"交接"标记，编号照旧 `marker:<会话>:handoff:<时刻>`。没装经历库时不推。
 * - **边界**：交接是会话一级的事。DSH 里一个会话一直是同一个会话，换的只是执行方那边的对话；所以执行方换过新对话以后，
 *   这里请压缩引擎在 DSH 记录里也落一个交接边界（交接文档换掉之前的记录，不调模型），DSH 侧的上下文跟着一起换掉。
 *   原生的换新对话本身就是落边界，不再落第二次。执行方自己压缩过上下文时，也经 `land` 请这里落一个边界（服务 `context.land`）。
 *   没装本模块的压缩引擎时边界落不下，报出来。
 * - 原生会话的这几样由本模块的压缩引擎提供（`context/engine.js`，另一个插件入口，经 `core.executors.provideNative`）；没装时原生交接写明做不了。
 *
 * @module @loveandbeepbrother/dsh-galatea/context
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { recentTurnsText } from './recent.js'

export const name = 'mind-framework-context'
export const inject = ['core']

export const SERVICE = 'context'
/** 用量提醒在附提醒里的键。 */
export const USAGE_REMINDER_KEY = 'context-usage'

export const Config = Schema.object({
    remindFrom: Schema.natural().default(500_000).description('上下文超过这么多 token 时提醒一次；0 不提醒'),
    remindStep: Schema.natural().default(100_000).description('之后每再涨这么多 token 再提醒一次'),
    recentTurns: Schema.natural().default(5).description('交接换新对话以后带最近几轮原文；0 不带'),
    recentChars: Schema.natural().default(8_000).description('带的原文的上限（字），超了从最旧的截；0 不带'),
    fallbackCompactAt: Schema.natural().default(680_000).description('兜底压缩线（token）：执行方能调的就设到这里，只作兜底'),
})

const wan = value => `${Math.round(value / 10_000)} 万`

/** 上下文大了时附在下一轮的提醒。 */
export function usageReminder(tokens, fallback) {
    return `（DSH 提示，不是用户发言）上下文已到约 ${wan(tokens)} token${fallback ? `（自动压缩线 ${wan(fallback)}，只作兜底）` : ''}。`
        + '每次请求都要带着它，越大越慢。手头的事告一段落时，可以写交接文档、调用 `assistant_context_handoff` 换新对话'
        + '（来不及时用 `assistant_context_compact` 压缩）；之前先把还没落地的约定、决定写进记忆或便签。什么时候换由你决定。'
}

/** 执行方的压缩不收额外要求时，压缩工具的结果和服务的结果里写的话。 */
export const INSTRUCTIONS_IGNORED = '这个会话的压缩不收额外要求，会按默认压缩，指定要保留的内容没用上'

const HANDOFF_SCHEDULED = '已安排：这一轮结束后换新对话，交接文档随用户下一条消息交给新对话。'

/** 交接整理的结果写给接手的对话的话。 */
export function tidyNote(tidied) {
    const lead = '（DSH 提示，不是用户发言）交接整理'
    if (tidied.status === 'skipped') return `${lead}这次没跑。`
    if (tidied.status === 'failed') return `${lead}没做完（${tidied.reason}），已写的留着，已经报了。`
    const cost = `用时 ${tidied.seconds} 秒${tidied.tokens === null ? '' : `，上下文约 ${tidied.tokens} token`}`
    return `${lead}（${cost}）：${tidied.summary}${tidied.gaps === '' ? '' : `\n要你知道的：${tidied.gaps}`}`
}

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

export function apply(ctx, config) {
    const policy = Object.freeze({ remindFrom: config.remindFrom, remindStep: config.remindStep, fallbackCompactAt: config.fallbackCompactAt })
    const core = ctx.core
    /** 每个会话已经提醒到第几档、上次看到的用量。 */
    const reminded = new Map()
    /** 设过兜底压缩线的能力（按对象认：压缩引擎重新装上时是新的一份，要再设）。 */
    const thresholdsSet = new WeakSet()

    /** 这个会话的执行方，以及要用的几项能力（值就是实现）。第一次见到某个执行方时设它的兜底压缩线。 */
    async function capabilitiesOf(sessionId) {
        const executor = await core.executors.executorOf(sessionId)
        const caps = {
            newConversation: executor?.required?.newConversation,
            usage: executor?.required?.usage,
            compact: typeof executor?.optional?.compact === 'function' ? executor.optional.compact : undefined,
            compactInstructions: executor?.optional?.compactInstructions === true,
            fallbackThreshold: executor?.optional?.fallbackThreshold,
        }
        if (executor !== undefined && typeof caps.fallbackThreshold?.set === 'function' && !thresholdsSet.has(caps.fallbackThreshold)) {
            thresholdsSet.add(caps.fallbackThreshold)
            try {
                await caps.fallbackThreshold.set(policy.fallbackCompactAt)
            } catch (error) {
                core.report('context/fallback-threshold-failed', { sessionId, text: `执行方 ${executor.id} 的兜底压缩线没设上（${error?.message ?? error}）` })
            }
        }
        return { executor, caps }
    }

    const cannot = (executor, what) => `执行方 ${executor?.id ?? '（认不出）'} 不能${what}`

    /** 经历库在时，交接标记往这里推。 */
    let markers
    ctx.inject(['experience'], (sub) => {
        const source = sub.experience.registerSource({ id: 'context-handoff', label: '交接标记', category: 'dsh' })
        markers = source
        sub.effect(() => () => {
            source.dispose()
            if (markers === source) markers = undefined
        }, 'mind-framework-context: handoff markers')
    })

    function markHandoff(sessionId, document, at) {
        if (markers === undefined) return
        try {
            markers.append([{ id: `marker:${sessionId}:handoff:${at}`, thread: sessionId, at, tie: 0, role: 'system', kind: '交接', text: `交接到新对话，交接文档：${document}` }])
        } catch (error) {
            core.report('context/handoff-marker-failed', { sessionId, text: `交接标记没进经历库（${error?.message ?? error}）` })
        }
    }

    /** @param options.ready - 换对话要等它（交接之前的整理）；不给就不等。 */
    async function handoff(sessionId, document, { ready } = {}) {
        const id = String(sessionId)
        if (typeof document !== 'string' || document.trim() === '' || !isAbsolute(document)) return { scheduled: false, reason: '要给交接文档的绝对路径' }
        let text
        try {
            text = (await readFile(document, 'utf8')).trim()
        } catch (error) {
            return { scheduled: false, reason: `交接文档读不到：${error?.message ?? error}` }
        }
        if (text === '') return { scheduled: false, reason: '交接文档是空的' }
        const { executor, caps } = await capabilitiesOf(id)
        if (typeof caps.newConversation !== 'function') {
            core.report('context/handoff-unavailable', { sessionId: id, text: `${cannot(executor, '换新对话')}，这次交接没做` })
            return { scheduled: false, reason: cannot(executor, '换新对话') }
        }
        const onSwitched = async ({ at, landed = false } = {}) => {
            markHandoff(id, document, at)
            if (landed) return
            // 交接之前的整理可能往文档后面补过：换的时候再读。
            const current = await readFile(document, 'utf8').then(value => value.trim()).catch(() => text)
            land(id, { kind: 'handoff', text: current === '' ? text : current, document, executor })
                .catch(error => core.report('context/boundary-failed', { sessionId: id, text: `DSH 记录里的交接边界没落下（${error?.message ?? error}）` }))
        }
        const result = await caps.newConversation(id, document, { onSwitched, ready })
        if (result?.scheduled !== true) core.report('context/handoff-refused', { sessionId: id, text: `交接没做：${result?.reason ?? '执行方没说原因'}` })
        return result?.scheduled === true ? { scheduled: true } : { scheduled: false, reason: String(result?.reason ?? '执行方没说原因') }
    }

    /**
     * 请压缩引擎在 DSH 记录里落一个边界（等会话空下来）。不等它落下：失败由引擎报。
     * @param options - `{ kind, text, document?, conversation?, executor?, by? }`；没给执行方时按会话现认；
     *   执行方自己压缩的（`auto-compact`、`compact`）要写 `by`：写这份摘要的执行方的编号。
     * @returns 落没落下：`{ landed: true, compactionId }` 或 `{ landed: false, reason }`。
     */
    async function land(sessionId, { kind, text, document, conversation, executor, by } = {}) {
        const id = String(sessionId)
        const engine = ctx.get('compaction')
        if (typeof engine?.landBoundary !== 'function') {
            const reason = '没装上下文模块的压缩引擎，DSH 记录里落不了边界'
            core.report('context/boundary-unavailable', { sessionId: id, text: reason })
            return { landed: false, reason }
        }
        const owner = executor ?? (await core.executors.executorOf(id))
        return engine.landBoundary(id, { kind, text, document, conversation, executor: owner, by })
    }

    /**
     * 交接换新对话以后带的最近几轮原文（见 `recent.js`）：只有一处算法，各执行方自己决定放在新对话的哪里。
     * @param options.before - 这一轮要交的输入的编号，它们和之后的不算。
     * @param options.handoffDocument - 这份交接的边界落下之后的记录不算。
     */
    async function recentTurns(sessionId, { before, handoffDocument } = {}) {
        // 交接整理每次都是全新的一段，上一次的内容不带。
        if (core.sessions.roleOf(String(sessionId)) === 'tidy') return ''
        const { sends, unread } = await core.exits.sentBetween(String(sessionId))
        return recentTurnsText(await core.readEvents(String(sessionId)), { turns: config.recentTurns, chars: config.recentChars, before, handoffDocument, sends, sendsUnread: unread })
    }

    async function compact(sessionId, options = {}) {
        const id = String(sessionId)
        const { executor, caps } = await capabilitiesOf(id)
        if (typeof caps.compact !== 'function') return { compacted: false, reason: cannot(executor, '主动压缩') }
        const instructions = String(options.instructions ?? '').trim()
        if (instructions === '' || caps.compactInstructions) return caps.compact(id, { instructions })
        // 执行方的压缩不收额外要求：照默认压，结果里写明，不悄悄丢掉。
        const result = await caps.compact(id, { instructions: '' })
        return { ...result, note: INSTRUCTIONS_IGNORED }
    }

    /** `{ tokens, window, epoch }`；执行方报不出时为 `null`。 */
    async function usage(sessionId) {
        const { caps } = await capabilitiesOf(String(sessionId))
        return typeof caps.usage === 'function' ? (await caps.usage(String(sessionId))) ?? null : null
    }

    /** 一轮结束：用量过线就附一条提醒；执行方换了新对话或压缩过（`epoch` 变了）就重计。 */
    async function checkUsage(sessionId) {
        if (policy.remindFrom === 0) return
        const now = await usage(sessionId)
        const tokens = now?.tokens
        if (typeof tokens !== 'number') return
        const state = reminded.get(sessionId) ?? { level: -1, epoch: now.epoch }
        if (now.epoch !== state.epoch) {
            state.level = -1
            state.epoch = now.epoch
        }
        reminded.set(sessionId, state)
        if (tokens < policy.remindFrom) return
        const level = Math.floor((tokens - policy.remindFrom) / Math.max(policy.remindStep, 1))
        if (level <= state.level) return
        state.level = level
        await core.attach(sessionId, USAGE_REMINDER_KEY, usageReminder(tokens, policy.fallbackCompactAt))
    }

    // 会话一加载就问一次它的执行方：兜底压缩线在第一轮之前就设好，不等用量提醒去问。
    ctx.on('agent/created', ({ agent }) => {
        const sessionId = String(agent?.session?.id ?? '')
        if (sessionId === '') return
        capabilitiesOf(sessionId).catch(error => core.report('context/fallback-threshold-failed', { sessionId, text: `兜底压缩线没设上（${error?.message ?? error}）` }))
    })

    ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return
        checkUsage(String(session.id)).catch(error => core.report('context/usage-check-failed', { sessionId: String(session.id), text: `用量没查成（${error?.message ?? error}）` }))
    }, { global: true })

    // 外部调用方的会话不跑轮，交接、压缩对它没有意义。
    const notExternal = who => who?.kind !== 'external'
    // 压缩工具只在会话的执行方有主动压缩时出现（没有的能力，对应工具不交）；换新对话是必备能力，交接工具一直在。
    const offers = capability => async (activation) => {
        const { caps } = await capabilitiesOf(String(activation.agent.session.id))
        return typeof caps[capability] === 'function'
    }
    core.tool(defineTool({
        name: 'assistant_context_compact',
        description: 'Compact this session\'s context now: earlier conversation is replaced by a summary and old images stop being re-uploaded with every request. Use when the user asks, or when replies get slow because the context is huge. Runs right after the current turn ends; the next turn starts from the compacted context. Optional instructions say what the summary must keep.',
        parameters: { instructions: { type: 'string', description: 'What the summary must keep (optional).' } },
        output,
        execute: async (args, exec) => {
            const sessionId = String(exec?.agent?.session?.id ?? '')
            if (sessionId === '') throw new Error('无法确定调用会话')
            const { caps } = await capabilitiesOf(sessionId)
            const ignored = String(args?.instructions ?? '').trim() !== '' && !caps.compactInstructions
            // 不等结果：压缩要排在这一轮之后，等它就会等到自己。
            compact(sessionId, { instructions: args?.instructions })
                .then(result => { if (result?.compacted !== true) core.report('context/compact-failed', { sessionId, text: `压缩没做成：${result?.reason ?? '未知'}` }) })
                .catch(error => core.report('context/compact-failed', { sessionId, text: `压缩出错（${error?.message ?? error}）` }))
            return `已安排：这一轮结束后立即压缩上下文。${ignored ? `${INSTRUCTIONS_IGNORED}。` : ''}`
        },
    }), { effect: 'write', allow: notExternal }, { when: offers('compact') })
    core.tool(defineTool({
        name: 'assistant_context_handoff',
        description: 'Start a fresh conversation for this session from a handoff document you wrote, instead of compacting. Before calling: save anything that must last into memory, notes and project documents; then write the handoff document (only working state that the opening context does not already carry: work in progress and its stage, decisions not yet saved elsewhere, questions waiting for the user, files recently changed, what the last few turns were about, and which experience-archive entry it continues from) into the workspace 交接 folder. Refused while background tasks are still running. Runs right after the current turn ends; the next user message opens the new conversation with your persona, cognition, memory index and channel rules at its start and the handoff document in front of the message.',
        parameters: { document: { type: 'string', required: true, description: 'Absolute path of the handoff document.' } },
        output,
        execute: async (args, exec) => {
            const sessionId = String(exec?.agent?.session?.id ?? '')
            if (sessionId === '') throw new Error('无法确定调用会话')
            const document = String(args?.document ?? '')
            const reflection = ctx.get('reflection')
            const tidies = reflection?.tidyApplies?.(sessionId) === true
            // 工具一次调用有时限（Claude Code 的 HTTP MCP 是 60 秒），整理不能等在这里：立刻返回，换对话等整理跑完，结果放进下一轮。
            let release = () => {}
            const ready = tidies ? new Promise((resolve) => { release = resolve }) : undefined
            const result = await handoff(sessionId, document, { ready })
            if (!result.scheduled) {
                release()
                return `没有交接：${result.reason}`
            }
            if (!tidies) return HANDOFF_SCHEDULED
            // 先让执行方接受（拒绝的不白跑）。整理不抛错；超时、出错都会结束，换对话不会一直等。
            reflection.tidy(sessionId, { document })
                .then(tidied => core.attach(sessionId, `handoff-tidy-${Date.now()}`, tidyNote(tidied)))
                .catch(error => core.report('context/tidy-note-failed', { sessionId, text: `交接整理的结果没交给会话（${error?.message ?? error}）` }))
                .finally(release)
            return `${HANDOFF_SCHEDULED}交接整理在后台跑，用户的下一条消息最多等它跑完再开新对话；结果会放在新对话的开头。`
        },
    }), { effect: 'write', allow: notExternal, alwaysLoad: true })

    ctx.provide(SERVICE, { handoff, compact, usage, land, recentTurns, policy })
}
