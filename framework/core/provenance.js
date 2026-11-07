/**
 * 消息出处 `core.provenance`：这条消息是谁说的。
 *
 * - 程序放消息走 `core.deliver`，出处在放进去时就写进 `source`。
 * - 经上游 `prompt` 进来的（`source.kind === 'user'`）：入口在调 `prompt` 之前用 `declare(requestId, …)` 声明，
 *   核心在 `agent/pre-step` 按 `rpcId` 找到声明，只往 `source` 里加字段（`speaker`、`via`、`link`），
 *   `kind`、`rpcId` 不动。没声明的按用户本人算；带 `principal` 的（上游只在发消息的不是主人时记它）不算。
 * - 声明只放在内存里，写进日志就清掉。所以 Host 重启后才领走的 `user` 消息（本进程没见它进收件箱）
 *   找不到声明，记成"未知"，不当用户本人。
 * - 读的人读 `user/message` 的 `source.speaker`；要求"用户本人"的地方调 `latestFromUser`，只认 `speaker.kind === 'user'`。
 * - 分类、来源标注、记下开启这一轮的消息也在同一个 pre-step 里做，下一步加。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/provenance
 */

import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { withoutAnnotation } from './classify.js'

/** 认不出是谁说的。 */
export const UNKNOWN_SPEAKER = Object.freeze({ kind: 'unknown' })
const USER_SPEAKER = Object.freeze({ kind: 'user' })

/** 合法的"谁说的"：用户本人、某个会话、外部调用方、某个插件（程序）、渠道上的别人（接群会话里群里其他人，由渠道准入声明）。 */
export function validSpeaker(speaker) {
    switch (speaker?.kind) {
        case 'user': return true
        case 'party': return typeof speaker.exit === 'string' && speaker.exit !== '' && (speaker.name === undefined || typeof speaker.name === 'string')
        case 'session': return typeof speaker.sessionId === 'string' && speaker.sessionId !== ''
        case 'external': return typeof speaker.name === 'string' && speaker.name !== ''
        case 'program': return typeof speaker.plugin === 'string' && speaker.plugin !== ''
        default: return false
    }
}

/** 出处的可选部分：从哪条路进来的、关联编号。 */
export function originFields({ via, link } = {}) {
    if (via !== undefined && !(typeof via?.exit === 'string' && typeof via?.label === 'string')) {
        throw new TypeError('via 要写成 { exit, label }')
    }
    if (link !== undefined && typeof link !== 'string') throw new TypeError('link 要是字符串')
    return { ...via === undefined ? {} : { via: { exit: via.exit, label: via.label } }, ...link === undefined ? {} : { link } }
}

function sameDeclaration(a, b) {
    return JSON.stringify(a) === JSON.stringify(b)
}

/** 消息的原文（各文本块连起来，来源标注按 `source.annotation` 去掉）。 */
export function messageText(message) {
    return withoutAnnotation(message).filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

/**
 * @param deps.readEvents - 读一个会话的全部日志事件（会话不存在时为空数组）。
 */
export function createProvenance({ readEvents }) {
    const declarations = new Map()
    /** 本进程里见过进收件箱的 `user` 消息编号；领走时清掉。 */
    const seen = new Set()

    /**
     * 入口在调 `prompt` 之前声明这条消息是谁说的。同一个 `requestId` 重复声明，内容相同算一次，不同的抛错。
     * @param requestId - 调 `prompt` 时自己给的请求号（日志里是 `source.rpcId`）。
     * @param declaration - `{ speaker, via?, link? }`。
     */
    function declare(requestId, declaration) {
        if (typeof requestId !== 'string' || requestId === '') throw new TypeError('declare 需要 requestId')
        if (!validSpeaker(declaration?.speaker)) throw new TypeError('declare 需要合法的 speaker')
        const value = Object.freeze({ speaker: { ...declaration.speaker }, ...originFields(declaration) })
        const existing = declarations.get(requestId)
        if (existing !== undefined && !sameDeclaration(existing, value)) {
            throw new Error(`请求号 ${requestId} 已经声明过别的出处`)
        }
        declarations.set(requestId, value)
    }

    /** 上游的 `agent/inbox/inserted`。 */
    function noteInserted(message) {
        if (message?.source?.kind === 'user') seen.add(String(message.id))
    }

    /** 这条 `user` 消息该记成谁说的，以及出处的其余字段。 */
    function resolve(message) {
        const source = message.source
        const declared = typeof source.rpcId === 'string' ? declarations.get(source.rpcId) : undefined
        if (declared !== undefined) return declared
        if (source.principal !== undefined) return { speaker: UNKNOWN_SPEAKER }
        if (!seen.has(String(message.id))) return { speaker: UNKNOWN_SPEAKER }
        return { speaker: USER_SPEAKER }
    }

    /**
     * pre-step 里给这一步的消息写上出处：只处理还没写出处的 `user` 消息，只加字段。
     * @returns 写好的消息（没有要改的就是原数组）。
     */
    function stamp(messages) {
        let changed = false
        const result = messages.map((message) => {
            const source = message?.source
            if (source?.kind !== 'user' || source.speaker !== undefined) return message
            const { speaker, via, link } = resolve(message)
            if (typeof source.rpcId === 'string') declarations.delete(source.rpcId)
            seen.delete(String(message.id))
            changed = true
            return freezeMessage({
                ...message,
                source: { ...source, speaker, ...via === undefined ? {} : { via }, ...link === undefined ? {} : { link } },
            })
        })
        return changed ? result : messages
    }

    /**
     * 这个会话里最近一条用户本人发的消息，以及在它之后、不是用户本人发的第一条（只用来写报错）。
     * @param options.after - 只看这个时刻（毫秒）以后进日志的。
     */
    async function latestFromUser(sessionId, { after } = {}) {
        const messages = (await readEvents(String(sessionId)))
            .filter(event => event?.type === 'user/message' && (after === undefined || event.time > after))
        let own = null
        let index = -1
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].data?.source?.speaker?.kind === 'user') {
                own = { text: messageText(messages[i].data), time: messages[i].time }
                index = i
                break
            }
        }
        const other = messages.slice(index + 1).find(event => event.data?.source?.speaker?.kind !== 'user')
        return {
            own,
            ...other === undefined ? {} : {
                otherAfter: { text: messageText(other.data), time: other.time, speaker: other.data?.source?.speaker ?? UNKNOWN_SPEAKER },
            },
        }
    }

    /**
     * 一条消息的原文内容块：核心加的来源标注按 `source.annotation` 准确去掉（没有标注就是原内容）。
     * 要拿日志里的消息和别处的原件比的（渠道比原文核对）用它，不要自己再写一份去标注的规则。
     */
    function original(message) {
        return withoutAnnotation(message)
    }

    return Object.freeze({ declare, noteInserted, stamp, latestFromUser, original })
}
