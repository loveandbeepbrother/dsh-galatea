/**
 * 一轮的结果 `core.outcomeOf`：回复、不发、等待。由日志现算，不另写事件。
 *
 * - `completed` 的轮有结果；到了输出上限的轮（`max-tokens`）照常判，回复带 `truncated: true`，
 *   出口发的时候在末尾注明"回复被截断"（截断的文字发出去比什么都不发好）。被中止、出错、强杀后补上的轮返回 `null`；
 *   半截的回复（`interrupted`）不算。
 * - 判定的是这一轮的最终文字：最后一条模型回复里、最后一个边界之后的那一段，也就是手机实际收到的那一段。
 *   边界是工具调用和钩子拦截：被拦下的那段本来就判定为"还不能算最终"。执行方把两个边界之间写下的文字各交成一个文字块
 *   （Claude Code 的工具在它自己那边跑，日志里没有工具调用块；钩子拦下以后续做的是新的一段），所以最终文字是
 *   最后一次工具调用之后的最后一个文字块。渠道发有渠道输入的一轮时取的也是最后一个文字块，两边是同一个定义。
 *   它恰好等于标记串才算不发或等待；正文里提到标记串不算。最后一次工具调用之后没有文字的，判成不发。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/outcome
 */

/** 这一轮不发到手机时的整条回复。 */
export const NO_SEND_MARKERS = Object.freeze(['[不发]', '【不发】'])
/** 这一轮等对方接着说时的整条回复。 */
export const WAIT_MARKERS = Object.freeze(['[等待]', '【等待】'])

/** 最后一条模型回复里，最后一个边界之后的文字：最后一次工具调用之后的最后一个有内容的文字块。 */
export function finalText(message) {
    const blocks = message?.content ?? []
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index]
        if (block?.type === 'tool-call') return ''
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return block.text
    }
    return ''
}

/**
 * @param events - 会话的日志事件。
 * @param turn - 第几轮。
 * @returns `{kind:'reply', text, truncated?}` / `{kind:'silent'}` / `{kind:'wait'}`；这一轮没结束或没有正常完成时为 `null`。
 */
export function outcomeFromEvents(events, turn) {
    const end = events.find(event => event?.type === 'turn/end' && event.data?.turn === turn)
    const kind = end?.data?.reason?.kind
    if (kind !== 'completed' && kind !== 'max-tokens') return null
    let last
    for (const event of events) {
        if (event?.type === 'assistant/message' && event.data?.turn === turn && event.data.interrupted !== true) last = event
        if (event === end) break
    }
    if (last === undefined) return { kind: 'silent' }
    const text = finalText(last.data.message).trim()
    if (text === '' || NO_SEND_MARKERS.includes(text)) return { kind: 'silent' }
    if (WAIT_MARKERS.includes(text)) return { kind: 'wait' }
    return { kind: 'reply', text, ...kind === 'max-tokens' ? { truncated: true } : {} }
}

/** 这一轮里模型确实跑过（有完整的模型回复）。 */
export function modelRan(events, turn) {
    return events.some(event => event?.type === 'assistant/message' && event.data?.turn === turn && event.data.interrupted !== true)
}
