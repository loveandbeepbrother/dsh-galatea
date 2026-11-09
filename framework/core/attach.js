/**
 * 附提醒 `core.attach`与"失败的一轮带着的输入"。
 *
 * 附提醒：
 * - 不开一轮，下一轮交给模型；这一轮成功结束（`turn/end` 为 `completed`）而且模型确实跑过，才算交到、才撤掉。
 *   这一轮开始以后才附上的不算交到，留给下一轮；除非执行方是在那之后才来取的（`delivering`，比如这一轮排在交接整理后面），
 *   那它已经交给模型了。失败了留着，下一轮再交。
 * - 存在核心自己的存储域里，Host 重启不丢；`onTaken` 只在内存里。
 * - 各执行方怎么交给模型（原生的段、Claude Code 的 `additionalContext`）由执行方按 `list` 取。
 *
 * 失败的一轮带着的输入：
 * - 一轮以错误结束（`error`），或者领走了却被 pre-step 拒掉（`blocked`），这一轮领走的输入
 *   （按 `agent/inbox/claimed` 收，不按 `user/message`：领走以后、写成 `user/message` 之前出错或被拒的，日志里没有它们）
 *   记成"未得到回应"，经附提醒交给这个会话的下一轮，写明错误码、每条的来源和摘要、"可能已经部分执行"；
 *   不当提问重发，不自动重试。同时报一条 `turn-failed`，不论来源。
 * - Host 被强杀的那一轮：上游恢复会话时才补一条 `turn/end {interrupted}`，作为种子写进日志、不派发事件。
 *   所以在 `agent/created`（恢复）时看一眼最后一轮，是 `interrupted` 又没处理过的，按失败的一轮处理一次。
 *   这时输入只能按这一轮写进日志的 `user/message` 收，和实时失败的轮（按 `agent/inbox/claimed`）依据不同：
 *   `agent/inbox/claimed` 只在运行时派发，不进日志（`agent-loop/src/inbox.ts:111`）；日志里只有收件箱的 splice，
 *   它按位置记、不记消息编号，要还原领走了哪几条就得按位置重放收件箱。
 *   强杀正好落在一轮中间很少见，领走了还没写成 `user/message` 的那几条在这种情况下认不出来，不为它另加机制。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/attach
 */

import { createHash } from 'node:crypto'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { modelRan } from './outcome.js'
import { messageText } from './provenance.js'

export const turnsDomainSpec = defineDomain({
    name: 'mind_framework_core_turns',
    version: 1,
    layout: 'per-record',
    tables: {
        attachments: {
            valueSchema: z.object({ sessionId: z.string(), key: z.string(), text: z.string(), at: z.number() }).strict(),
        },
        failures: {
            valueSchema: z.object({ sessionId: z.string(), turn: z.number(), code: z.string(), at: z.number() }).strict(),
        },
    },
})

/** 失败的一轮按什么结束算失败（被用户中止、正常完成、到了输出上限都不算）。 */
const FAILED_REASONS = new Set(['error', 'blocked', 'interrupted'])
const SUMMARY_LENGTH = 100

/** 存储域的键只能用字母、数字、`_`、`-`：会话编号加提醒键（或轮次）取 sha256，原值记在记录里。 */
const recordId = (...parts) => createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex')
const attachmentId = (sessionId, key) => recordId('attachment', sessionId, key)
const failureId = (sessionId, turn) => recordId('failure', sessionId, turn)

/** 一轮结束的错误码。 */
export function failureCode(reason) {
    if (reason?.kind === 'error') return String(reason.error?.code ?? 'UNKNOWN')
    if (reason?.kind === 'blocked') return 'BLOCKED'
    return 'INTERRUPTED'
}

/** 一条输入的来源、时间和摘要。 */
function inputLine(message, time, timezone) {
    const source = message?.source ?? {}
    const who = source.speaker?.kind === 'user' ? '用户本人' : source.kind ?? '未知'
    const text = messageText(message).replace(/\s+/g, ' ').trim()
    const summary = Array.from(text).length > SUMMARY_LENGTH ? `${Array.from(text).slice(0, SUMMARY_LENGTH).join('')}…` : text
    const at = new Date(time).toLocaleString('zh-CN', { timeZone: timezone, hour12: false })
    return `- ${at} · ${who}：${summary === '' ? '（没有文字）' : summary}`
}

/** 交给下一轮的那段说明。 */
export function failureNotice(turn, code, inputs) {
    return [
        `上一轮（第 ${turn} 轮）以错误 ${code} 结束，下面这些输入没有得到回应，可能已经部分执行。`
        + '先核对做到了哪一步，再决定怎么处理；不要当成新的请求从头再做。',
        ...inputs,
    ].join('\n')
}

/**
 * @param domain - 已打开的 `turnsDomainSpec` 存储域。
 * @param deps.readEvents - 读一个会话的全部日志事件。
 * @param deps.report - 报异常。
 * @param deps.gatedFailure - 这一轮的错误码是不是执行方额度闸门管的"额度用完"（这种不算失败）。
 * @param deps.now - 取当前时间（测试用）。
 * @param deps.timezone - 输入时间按哪个时区写（核心的 `timezone`）。
 */
export function createAttachments(domain, { readEvents, report, gatedFailure = async () => false, now = Date.now, timezone }) {
    const attachments = () => domain.table('attachments')
    const failures = () => domain.table('failures')
    const takenCallbacks = new Map()
    /** 执行方取走、这一轮要交给模型的提醒。 */
    const handedOut = new Set()
    /** 每个会话每一轮领走的输入：`会话#轮` → [{ message, time }]。 */
    const claimed = new Map()

    function attach(sessionId, key, text, { onTaken } = {}) {
        if (typeof key !== 'string' || key === '') throw new TypeError('attach 需要 key')
        if (typeof text !== 'string' || text.trim() === '') throw new TypeError('attach 需要 text')
        const id = attachmentId(String(sessionId), key)
        if (typeof onTaken === 'function') takenCallbacks.set(id, onTaken)
        else takenCallbacks.delete(id)
        return attachments().put(id, { sessionId: String(sessionId), key, text, at: now() })
    }

    function detach(sessionId, key) {
        const id = attachmentId(String(sessionId), key)
        takenCallbacks.delete(id)
        return attachments().delete(id)
    }

    function pending(sessionId, key) {
        return attachments().get(attachmentId(String(sessionId), key)) !== undefined
    }

    /**
     * 这个会话还没交到的提醒，按附上的先后。
     * @param options.delivering - 执行方取了就要交给模型：这一轮结束时不管附上的时刻都算交到。
     */
    function list(sessionId, { delivering = false } = {}) {
        const id = String(sessionId)
        const items = [...attachments().entries()].map(([, item]) => item).filter(item => item.sessionId === id)
            .sort((a, b) => a.at - b.at)
            .map(({ key, text, at }) => ({ key, text, at }))
        if (delivering) for (const item of items) handedOut.add(attachmentId(id, item.key))
        return items
    }

    function noteClaimed(sessionId, turn, message) {
        const id = failureId(String(sessionId), turn)
        const list = claimed.get(id) ?? []
        list.push({ message, time: now() })
        claimed.set(id, list)
    }

    /** pre-step 写好出处以后，用写好的那份换掉领走时记下的（领走时还没有出处）。 */
    function noteStamped(sessionId, turn, messages) {
        const list = claimed.get(failureId(String(sessionId), turn))
        if (list === undefined) return
        const byId = new Map(messages.map(message => [String(message.id), message]))
        for (const item of list) item.message = byId.get(String(item.message.id)) ?? item.message
    }

    async function recordFailure(sessionId, turn, code, inputs) {
        const id = failureId(sessionId, turn)
        if (failures().get(id) !== undefined) return
        await failures().put(id, { sessionId, turn, code, at: now() })
        if (inputs.length > 0) await attach(sessionId, `turn-failed:${turn}`, failureNotice(turn, code, inputs))
        report('turn-failed', {
            sessionId,
            text: `第 ${turn} 轮以 ${code} 结束，${inputs.length} 条输入没有得到回应${inputs.length > 0 ? '，已附给下一轮' : ''}`,
            data: { turn, code, inputs: inputs.length },
        })
    }

    /** 一轮结束（实时的 `turn/end`）：成功且模型跑过的撤掉交到的提醒；失败的把领走的输入记成未得到回应。 */
    async function noteTurnEnd(sessionId, event) {
        const id = String(sessionId)
        const { turn, reason } = event.data
        const taken = claimed.get(failureId(id, turn)) ?? []
        claimed.delete(failureId(id, turn))
        if (reason?.kind === 'max-tokens') {
            report('turn-truncated', { sessionId: id, text: `第 ${turn} 轮的回复到了输出上限，被截断了`, data: { turn } })
        }
        if (reason?.kind === 'completed' || reason?.kind === 'max-tokens') {
            const events = await readEvents(id)
            if (!modelRan(events, turn)) return
            const started = events.find(item => item?.type === 'turn/start' && item.data?.turn === turn)?.time ?? event.time
            for (const item of list(id)) {
                const key = attachmentId(id, item.key)
                if (item.at > started && !handedOut.has(key)) continue
                handedOut.delete(key)
                await attachments().delete(key)
                const callback = takenCallbacks.get(key)
                takenCallbacks.delete(key)
                try {
                    callback?.()
                } catch {
                    // 回调出错不影响已经撤掉。
                }
            }
            return
        }
        if (!FAILED_REASONS.has(reason?.kind)) return
        const code = failureCode(reason)
        // 额度用完、执行方有闸门：由闸门恢复后唤醒，不算失败的一轮。
        if (reason.kind === 'error' && await gatedFailure(id, code)) return
        await recordFailure(id, turn, code, taken.map(({ message, time }) => inputLine(message, time, timezone)))
    }

    /** 会话恢复了：最后一轮是强杀后补上的 `interrupted`、又没处理过的，按失败的一轮处理一次。 */
    async function noteResumed(sessionId) {
        const id = String(sessionId)
        const events = await readEvents(id)
        const end = events.findLast(event => event?.type === 'turn/end')
        if (end?.data?.reason?.kind !== 'interrupted') return
        const turn = end.data.turn
        const inputs = events.filter(event => event?.type === 'user/message' && event.seq < end.seq && turnOf(events, event) === turn)
            .map(event => inputLine(event.data, event.time, timezone))
        await recordFailure(id, turn, 'INTERRUPTED', inputs)
    }

    return Object.freeze({ attach, detach, pending, list, noteClaimed, noteStamped, noteTurnEnd, noteResumed })
}

/** 一条事件落在第几轮（它前面最近的 `turn/start`）。 */
function turnOf(events, target) {
    let turn = null
    for (const event of events) {
        if (event === target) return turn
        if (event?.type === 'turn/start') turn = event.data.turn
    }
    return turn
}
