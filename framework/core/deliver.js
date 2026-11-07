/**
 * 程序往会话里放消息的唯一入口 `core.deliver`。
 *
 * - 去重保持简单：同一个 `key`（记在 `source.deliveryKey`）或调用方给的消息编号在这个会话的日志里出现过，
 *   就算交过，返回 `duplicate`。不按消息状态判。
 * - 出处在放进去时写进 `source`：`speaker`（必填；没写的记"未知"并报异常，照常放进去）、`via`、`link`；
 *   `source.intent` 和回复去向 `reply` 原样记在 `source` 里，分类和 turn-route 以后按它们读。
 * - `wake`：`now`（默认）= 上游 `followup`；`next-turn` = 排进下一轮、不叫醒；`none` = `inject`，并进下一步、不叫醒。
 * - 落盘才算交出：`flush` 成了返回 `delivered`，没成返回 `unknown` 并写明原因（消息可能已经在会话里）。
 * - 交不出返回 `unavailable` 并写明原因，不静默吞掉。
 * - 外部调用方的会话（角色 `external`）不跑轮：交给它的一律 `unavailable`，并报一条异常（项目任务、定时提醒指错了会话时看得见）。
 * - `images`：`[{ mediaType, data }]`（base64，和渠道准入的图片同形），跟在正文后面作为图片块放进去。
 * - 回复去向是 `{to:'exit'}` 的，先核对目标会话接着出口（`core.exits`）；没接就 `unavailable`，不放进去
 *   （放进去了回复也发不到任何地方，调用方以为对方会在群里说）。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/deliver
 */

import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { UNKNOWN_SPEAKER, originFields, validSpeaker } from './provenance.js'

export const WAKES = Object.freeze(['now', 'next-turn', 'none'])
/** 放进会话的图片能是哪几种（和上游的图片块、渠道准入一致）。 */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** 会话日志里是否已有这条（进过收件箱或已经写成 `user/message`）：按消息编号或 `source.deliveryKey`。 */
export function deliveredBefore(events, { id, key }) {
    const matches = message => (id !== undefined && String(message?.id) === id) || message?.source?.deliveryKey === key
    return events.some((event) => {
        if (event?.type === 'user/message') return matches(event.data)
        if (event?.type === 'agent/inbox/spliced') return (event.data?.inserted ?? []).some(matches)
        return false
    })
}

/**
 * @param deps.hub - 中枢会话编号（没有时为 `null`）。
 * @param deps.readEvents - 读一个会话的全部日志事件。
 * @param deps.resolveAgent - 取会话的 Agent（不在内存里就恢复）；会话不存在时抛错。
 * @param deps.flush - 等会话落盘，返回是否成功。
 * @param deps.report - 报异常。
 * @param deps.roleOf - 会话角色。
 * @param deps.servedBy - 这个会话由哪些出口接（`core.exits.servedBy`）。
 */
export function createDeliver({ hub, readEvents, resolveAgent, flush, report, roleOf = () => null, servedBy = () => [] }) {
    const chains = new Map()
    const serial = (key, job) => {
        const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(job)
        const tail = next.catch(() => {})
        chains.set(key, tail)
        tail.then(() => {
            if (chains.get(key) === tail) chains.delete(key)
        })
        return next
    }

    /**
     * 把一条消息放进会话。
     * @param to - 会话编号，或 `'hub'`（中枢）。
     * @param message - `{ key, id?, text, source, speaker, via?, link?, wake?, reply?, images? }`。
     */
    function deliver(to, message) {
        const { key, id, text, source, wake = 'now', images } = message ?? {}
        if (typeof to !== 'string' || to === '') return Promise.reject(new TypeError('deliver 需要目标会话'))
        if (typeof key !== 'string' || key === '') return Promise.reject(new TypeError('deliver 需要 key'))
        if (typeof text !== 'string' || text.trim() === '') return Promise.reject(new TypeError('deliver 需要 text'))
        if (typeof source?.kind !== 'string' || source.kind === '') return Promise.reject(new TypeError('deliver 需要 source.kind'))
        if (id !== undefined && (typeof id !== 'string' || id === '')) return Promise.reject(new TypeError('id 要是非空字符串'))
        if (!WAKES.includes(wake)) return Promise.reject(new TypeError(`wake 只能是 ${WAKES.join('、')}`))
        if (images !== undefined && !(Array.isArray(images) && images.every(image => IMAGE_MEDIA_TYPES.includes(image?.mediaType) && typeof image.data === 'string' && image.data !== ''))) {
            return Promise.reject(new TypeError(`images 要是 [{ mediaType, data }]，mediaType 只能是 ${IMAGE_MEDIA_TYPES.join('、')}`))
        }
        let origin
        try {
            origin = originFields(message)
        } catch (error) {
            return Promise.reject(error)
        }
        const sessionId = to === 'hub' ? hub() : to
        if (sessionId === null) return Promise.resolve({ status: 'unavailable', reason: '没有中枢会话' })
        if (roleOf(sessionId) === 'external') {
            report('core/deliver-to-external', { sessionId, text: `有消息要交给外部调用方的会话 ${sessionId}（来源 ${source.kind}，键 ${key}），这种会话不跑轮，没交`, data: { kind: source.kind, key } })
            return Promise.resolve({ status: 'unavailable', reason: `会话 ${sessionId} 是外部调用方的会话，不跑轮` })
        }
        if (message.reply?.to === 'exit' && servedBy(sessionId).length === 0) {
            return Promise.resolve({ status: 'unavailable', reason: `会话 ${sessionId} 没接任何出口（私聊或群），回复发不出去` })
        }
        return serial(`${sessionId}\u0000${key}`, () => deliverOnce(sessionId, { ...message, wake, origin }))
    }

    async function deliverOnce(sessionId, { key, id, text, source, speaker, reply, wake, origin, images = [] }) {
        let events
        try {
            events = await readEvents(sessionId)
        } catch (error) {
            return { status: 'unavailable', reason: `读不了会话 ${sessionId} 的日志（${error?.message ?? error}）` }
        }
        if (deliveredBefore(events, { id, key })) return { status: 'duplicate', ...id === undefined ? {} : { messageId: id } }

        let who = speaker
        if (!validSpeaker(who)) {
            who = UNKNOWN_SPEAKER
            report('core/speaker-missing', {
                sessionId,
                text: `放进会话的消息没写明是谁说的（来源 ${source.kind}，键 ${key}），记成未知`,
                data: { kind: source.kind, key },
            })
        }
        const marked = {
            ...source,
            deliveryKey: key,
            speaker: { ...who },
            ...origin,
            ...reply === undefined ? {} : { reply },
        }
        const content = [{ type: 'text', text }, ...images.map(image => ({ type: 'image', mediaType: image.mediaType, data: image.data }))]
        const built = id === undefined
            ? createUserMessage({ content, source: marked })
            : freezeMessage({ id, role: 'user', content, source: marked })

        let agent
        try {
            agent = await resolveAgent(sessionId)
        } catch (error) {
            return { status: 'unavailable', reason: `会话 ${sessionId} 取不到（${[error?.code, error?.message ?? String(error)].filter(Boolean).join('：')}）` }
        }
        try {
            if (wake === 'now') agent.followup(built)
            else if (wake === 'next-turn') agent.send(built, 'next-turn', false)
            else agent.inject(built)
        } catch (error) {
            return { status: 'unavailable', reason: `会话 ${sessionId} 不收消息（${error?.message ?? error}）` }
        }
        let flushed
        try {
            flushed = await flush(agent.session)
        } catch (error) {
            return { status: 'unknown', messageId: String(built.id), reason: `落盘出错（${error?.message ?? error}）` }
        }
        if (flushed !== true) return { status: 'unknown', messageId: String(built.id), reason: '落盘没有成功' }
        return { status: 'delivered', messageId: String(built.id) }
    }

    return deliver
}
