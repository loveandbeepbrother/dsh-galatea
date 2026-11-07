/**
 * 交接换新对话以后带上的最近几轮原文：交接文档写的是要点，接上语气和细节要靠原话。
 *
 * - 从会话日志现算，落过边界也读得到（边界只换模型看到的内容，日志不变）。
 * - 一轮：用户开口一次（连发的几条算一次），加上到用户下次开口之前助手的回复。
 * - 只有用户本人的话和助手回复的最终文字（手机实际收到的那一段）：转来的话、工具输出、快照都不带，`[不发]`、`[等待]` 不算回复。
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

const textOfBlocks = blocks => blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()

/**
 * @param events - 会话的日志事件。
 * @param options.turns - 带几轮；0 不带。
 * @param options.chars - 上限（字）；0 不带。
 * @param options.before - 这些消息编号（这一轮要交的输入）和它们之后的不算。
 * @param options.handoffDocument - 这份交接文档的边界落下之后的记录不算：那是交接之后的事，由别的路径交。
 * @returns 要带的一段文字；没有可带的时为空串。
 */
export function recentTurnsText(events, { turns, chars, before = [], handoffDocument } = {}) {
    if (!(turns > 0) || !(chars > 0)) return ''
    const stop = new Set(before.map(String))
    const groups = []
    let current = null
    for (const event of events) {
        if (handoffDocument !== undefined) {
            const record = pluginRecordOf(event)
            if (record?.type === BOUNDARY_RECORD && record.data?.kind === 'handoff' && record.data?.document === handoffDocument) break
        }
        if (event?.type === 'user/message') {
            if (stop.has(String(event.data?.id))) break
            if (event.data?.source?.speaker?.kind !== 'user') continue
            const text = textOfBlocks(withoutAnnotation(event.data))
            if (text === '') continue
            if (current === null || current.replies.size > 0) {
                current = { said: [], replies: new Map() }
                groups.push(current)
            }
            current.said.push(text)
        } else if (event?.type === 'assistant/message' && current !== null && event.data?.interrupted !== true) {
            const text = finalText(event.data?.message).trim()
            const silent = text === '' || NO_SEND_MARKERS.includes(text) || WAIT_MARKERS.includes(text)
            // 同一轮后面的回复取代前面的（中途的话不是这一轮的结果）；这一轮最后判成不发的，也不留前面那段。
            if (silent) current.replies.delete(event.data?.turn)
            else current.replies.set(event.data?.turn, text)
        }
    }
    const lines = groups.slice(-turns).flatMap(group => [
        ...group.said.map(text => `用户：${text}`),
        ...[...group.replies.values()].map(text => `你：${text}`),
    ])
    if (lines.length === 0) return ''
    const body = lines.join('\n\n')
    if (body.length <= chars) return `${RECENT_LEAD}\n\n${body}`
    return `${RECENT_LEAD}\n${RECENT_CUT}\n\n${body.slice(-chars)}`
}
