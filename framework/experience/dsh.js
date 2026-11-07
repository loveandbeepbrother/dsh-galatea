/**
 * 经历库的内置来源：DSH 会话。
 *
 * - 条目编号照旧 `dsh:<会话>:<事件 seq>`，操作 `dsh:<会话>:<seq>:<块编号>`，`tie` 是事件 seq。
 * - **谁说的从 `user/message` 的 `source.speaker` 读**（核心在入口定好，日志里不会再变），不再查渠道收件表：
 *   用户本人记 `user`；别的会话、外部调用方、渠道上的别人记 `peer`；程序放进来的记 `system`，类别取 `source.kind`；
 *   认不出来的记"来处不明"并报一次。正文按 `source.annotation` 去掉来源标注，只留原文。
 * - 每条输入都收（旧的只收一张表里的来源，待告知留言、持续工作的回执被悄悄丢掉）。
 * - 切换之前的旧日志没有 `speaker`：库里已经有的保留旧的分类，没有的才记成"来处不明"（见 `index.js`）。
 * - 解析要的状态（当前轮号、上一次的模型）由解析器自己带着，所以既能整份读，也能一条条喂。
 *
 * @module @loveandbeepbrother/dsh-galatea/experience/dsh
 */

import { withoutAnnotation } from '../core/classify.js'
import { describeOp, textOfBlocks } from './parse.js'

const PARTY_LABEL = speaker => `${speaker.name ?? '渠道上的别人'}（${speaker.exit}）`

/** 一条用户消息的角色、类别、对方、关联编号。 */
export function meaningOf(source) {
    const speaker = source?.speaker
    const via = source?.via
    const link = typeof source?.link === 'string' && source.link !== '' ? { link: source.link } : {}
    switch (speaker?.kind) {
        case 'user': return { role: 'user', kind: '用户', party: via?.label ?? via?.exit ?? '桌面', ...link }
        case 'session': return { role: 'peer', kind: via?.label ?? '会话转来', party: `会话 ${speaker.sessionId}`, ...link }
        case 'external': return { role: 'peer', kind: via?.label ?? '外部调用方转来', party: `外部调用方 ${speaker.name}`, ...link }
        case 'party': return { role: 'peer', kind: via?.label ?? '渠道上的别人', party: PARTY_LABEL(speaker), ...link }
        case 'program': return { role: 'system', kind: via?.label ?? String(source?.kind ?? '程序转交'), party: `插件 ${speaker.plugin}`, ...link }
        case 'unknown': return { role: 'system', kind: '来处不明', ...link, unknown: true }
        default: return { role: 'system', kind: '来处不明', ...link, legacy: true }
    }
}

/**
 * 一个会话的解析器。
 * @returns `{ feed(event) → { entries, ops } }`；条目带 `legacy`（旧日志没有 speaker）或 `unknown`（认不出来）时由调用方处理。
 */
export function createDshParser(sessionId) {
    let turn = null
    let selected
    const base = event => ({ id: `dsh:${sessionId}:${event.seq}`, thread: sessionId, at: event.time, tie: event.seq, ...turn === null ? {} : { turn: String(turn) } })
    return {
        feed(event) {
            const entries = []
            const ops = []
            const data = event?.data ?? {}
            switch (event?.type) {
                case 'turn/start':
                    turn = data.turn ?? event.seq
                    break
                case 'user/message': {
                    if ((data.role ?? 'user') !== 'user') break
                    const text = textOfBlocks(withoutAnnotation(data))
                    if (text === '') break
                    entries.push({ ...base(event), ...meaningOf(data.source), text })
                    break
                }
                case 'assistant/message': {
                    const message = data.message ?? {}
                    const source = message.source ?? {}
                    const model = source.provider === undefined ? undefined : `${source.provider}/${source.model ?? '?'}`
                    const text = textOfBlocks(message.content)
                    const entry = { ...base(event), role: 'assistant', kind: '回复', text, ...model === undefined ? {} : { model } }
                    ;(message.content ?? []).forEach((block, index) => {
                        if (block?.type !== 'tool-call') return
                        ops.push({ id: `${entry.id}:${block.id ?? index}`, at: event.time, tie: event.seq, ...describeOp(block.name, block.arguments) })
                    })
                    if (text !== '') entries.push(entry)
                    break
                }
                case 'session/end-seed':
                    // 会话重新载入时追加的恢复标记；分叉继承的不算。
                    if (data.inherited === true) break
                    entries.push({ ...base(event), role: 'system', kind: '进程重开', text: 'DSH 重新载入了这个会话（Host 重启或会话重开），之后的对话由新进程接续' })
                    break
                case 'model/selection': {
                    const now = `${data.provider ?? '?'}/${data.model ?? '?'}`
                    if (selected !== undefined && selected !== now) entries.push({ ...base(event), role: 'system', kind: '换模型', text: `模型换成 ${now}（之前是 ${selected}）`, model: now })
                    selected = now
                    break
                }
                case 'compaction/summary':
                    entries.push({ ...base(event), role: 'system', kind: '压缩', text: 'DSH 压缩了这个会话的上下文' })
                    break
                default:
            }
            return { entries, ops }
        },
    }
}

/** 最近的会话标题。 */
export function titleOf(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title
    }
    return undefined
}

/**
 * 收到一条事件时怎么办：`skip`（整份读时已经读到了，或者是子代理会话）、`feed`（正好接上一条）、
 * `reread`（第一次见到这个会话，或者 seq 接不上：`session/event` 不确认不重发，漏了就整份补读）。
 * @param state - 这个会话的 `{ lastSeq }`；没见过为 `undefined`，子代理会话为 `null`。
 */
export function nextStep(state, seq) {
    if (state === null) return 'skip'
    if (state === undefined) return 'reread'
    if (seq <= state.lastSeq) return 'skip'
    return seq === state.lastSeq + 1 ? 'feed' : 'reread'
}
