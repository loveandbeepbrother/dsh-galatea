/**
 * 交接换新对话以后带上的最近几轮原文：交接文档写的是要点，接上语气和细节要靠原话。
 *
 * - 从会话日志现算，落过边界也读得到（边界只换模型看到的内容，日志不变）。
 * - 一轮：用户开口一次（连发的几条算一次），加上到用户下次开口之前助手的回复。
 * - 只有用户本人的话、助手回复的最终文字，和一轮中途发到用户手上的话（出口交来，日志里不一定有）。
 *   转来的话、工具输出、快照都不带；`[不发]`、`[等待]` 不算回复，但不影响这一轮中途发过的话。
 * - 超过上限时从最旧的截，写明截过。
 *
 * @module @loveandbeepbrother/dsh-galatea/context/recent
 */

import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { NO_SEND_MARKERS, WAIT_MARKERS, finalText } from '../core/outcome.js'
import { withoutAnnotation } from '../core/classify.js'

/** 边界的插件记录。 */
export const BOUNDARY_RECORD = 'plugin:mind-framework/boundary'
export const RECENT_LEAD ='（以下是交接之前最近几轮对话的原文记录，不是用户这次说的话，不用回应；用来接上语气和细节。）'
export const RECENT_CUT = '（更早的部分超过上限，截掉了；需要时去经历库查。）'
export const RECENT_SENDS_UNREAD = '（中途发到手机的话这次没读到，没写出来不等于没发过；需要时去经历库查。）'

const textOfBlocks = blocks => blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()

/**
 * @param events - 会话的日志事件。
 * @param options.turns - 带几轮；0 不带。
 * @param options.chars - 上限（字）；0 不带。
 * @param options.before - 这些消息编号（这一轮要交的输入）和它们之后的不算。
 * @param options.handoffDocument - 这份交接文档的边界落下之后的记录不算：那是交接之后的事，由别的路径交。
 * @param options.sends - 中途发到用户手上的话 `[{ at, text }]`，按时间并进所属的一轮；上面两条截止点之后的不算。
 * @param options.sendsUnread - 有中途发送没读到：写明一句，免得下一段对话把没写出来当成没发过。
 * @returns 要带的一段文字；没有可带的时为空串。
 */
export function recentTurnsText(events, { turns, chars, before = [], handoffDocument, sends = [], sendsUnread = false } = {}) {
    if (!(turns > 0) || !(chars > 0)) return ''
    const stop = new Set(before.map(String))
    const groups = []
    let current = null
    const pending = [...sends].sort((left, right) => left.at - right.at)
    // 这条之前发的并进当前这一轮；还没有一轮时，那是更早的事，不收。
    const takeSendsBefore = (time) => {
        while (pending.length > 0 && pending[0].at < time) {
            const { text } = pending.shift()
            current?.items.push({ who: '你（中途发的）', text, replied: true })
        }
    }
    let stopped = false
    for (const event of events) {
        if (Number.isFinite(event?.time)) takeSendsBefore(event.time)
        if (handoffDocument !== undefined) {
            const record = pluginRecordOf(event)
            if (record?.type === BOUNDARY_RECORD && record.data?.kind === 'handoff' && record.data?.document === handoffDocument) {
                stopped = true
                break
            }
        }
        if (event?.type === 'user/message') {
            if (stop.has(String(event.data?.id))) {
                stopped = true
                break
            }
            if (event.data?.source?.speaker?.kind !== 'user') continue
            const text = textOfBlocks(withoutAnnotation(event.data))
            if (text === '') continue
            if (current === null || current.items.some(item => item.replied)) {
                current = { items: [] }
                groups.push(current)
            }
            current.items.push({ who: '用户', text })
        } else if (event?.type === 'assistant/message' && current !== null && event.data?.interrupted !== true) {
            const text = finalText(event.data?.message).trim()
            const silent = text === '' || NO_SEND_MARKERS.includes(text) || WAIT_MARKERS.includes(text)
            // 同一轮后面的回复取代前面的（中途的话不是这一轮的结果）；这一轮最后判成不发的，也不留前面那段。
            current.items = current.items.filter(item => item.turn === undefined || item.turn !== event.data?.turn)
            if (!silent) current.items.push({ who: '你', text, replied: true, turn: event.data?.turn })
        }
    }
    if (!stopped) takeSendsBefore(Infinity)
    const lines = groups.slice(-turns).flatMap(group => group.items.map(item => `${item.who}：${item.text}`))
    if (lines.length === 0) return ''
    const lead = sendsUnread ? `${RECENT_LEAD}\n${RECENT_SENDS_UNREAD}` : RECENT_LEAD
    const body = lines.join('\n\n')
    if (body.length <= chars) return `${lead}\n\n${body}`
    return `${lead}\n${RECENT_CUT}\n\n${body.slice(-chars)}`
}
