/**
 * 一轮的回复往哪去：核心只记下，出口按它发。
 *
 * 一轮第一步的 pre-step 里，核心认出开启这一轮的那条消息（`trigger`），按它声明的去向（`source.reply`，
 * 没声明就按 kind 登记的，再没有就是 `{to:'origin'}`）写一条插件记录 `plugin:mind-framework/turn-route`。
 * 插件记录是上游给插件留的日志记录（`appendPluginRecord`）：可跳过，不进模型看到的内容，随日志一起 fork、恢复。
 * 出口从日志里读（`turnRoute`），重启后照样对得上。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/routes
 */

import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'

export const TURN_ROUTE_RECORD = 'plugin:mind-framework/turn-route'
const ORIGIN = Object.freeze({ to: 'origin' })

/**
 * 这一步领走的消息里，哪一条开启了这一轮：第一步领走的是 next-step 里的全部，再加 next-turn 的第一条，
 * 所以是最后一条——除非它本来就在 next-step 里（会话是被 steer 叫醒的，这一轮没有 next-turn 的消息）。
 * @param claimed - 这一步领走的消息。
 * @param fromNextStep - 进收件箱时落在 next-step 的消息编号。
 */
export function triggerOf(claimed, fromNextStep) {
    const last = claimed.at(-1)
    if (last === undefined || fromNextStep.has(String(last.id))) return null
    return String(last.id)
}

/** 这条触发消息声明的回复去向。 */
export function routeOf(message, declarationOf) {
    return message?.source?.reply ?? declarationOf(message?.source?.kind)?.reply ?? ORIGIN
}

/** 写下这一轮的回复去向。 */
export function recordRoute(session, { turn, trigger, route }) {
    appendPluginRecord(session, TURN_ROUTE_RECORD, { turn, trigger, route })
}

/**
 * 读某一轮的回复去向。
 * @returns `{ turn, trigger, route }`；这一轮没有记录（比如核心装上以前的轮）时为 `null`。
 */
export function routeFromEvents(events, turn) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const record = pluginRecordOf(events[index])
        if (record?.type === TURN_ROUTE_RECORD && record.data?.turn === turn) return record.data
    }
    return null
}
