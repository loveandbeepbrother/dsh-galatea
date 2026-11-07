/**
 * 自省的纯逻辑：一轮的结果、下次间隔、醒来的输入（事实部分）、默认的起步模板。
 *
 * @module @loveandbeepbrother/dsh-galatea/reflection/rhythm
 */

/** 框架自带的起步模板（中性，不写死人设）；用户内容目录里有自己的模板时用那一份。和新建内容库时写进去的是同一份（`starter.js`）。 */
export { REFLECTION_TEMPLATE as STARTER_TEMPLATE } from '../starter.js'

/** 给后台思考看的时刻，按核心的时区写（不用进程本地时区）。 */
const clockIn = timezone => time => new Date(time).toLocaleString('zh-CN', { hour12: false, timeZone: timezone })

/**
 * 醒来时框架填的事实。
 * @param options.last - 上一轮 `{ at, outcome, summary }`，没有时为 `null`。
 * @param options.contributions - `[{ name, lines | null }]`，`null` 是这一轮读取失败。
 */
export function factsText({ now, last, contact, pendingContacts, range, contributions = [], timezone }) {
    const clock = clockIn(timezone)
    const lines = ['【后台思考】（系统安排，不是用户发言）', `现在是 ${clock(now)}。`]
    if (last === null) lines.push('这是第一次后台思考。')
    else if (last.outcome === 'yielded' || last.outcome === 'interrupted') lines.push(`上次被打断（${clock(last.at)} 开始），先接着把没做完的部分做完。`)
    else lines.push(`上次后台思考结束于 ${clock(last.at)}（${last.outcome}）：${last.summary || '（没有留下小结）'}`)
    lines.push(`主动联系${contact.enabled ? '已开启' : '未开启'}；还没告诉用户的留言 ${pendingContacts} 条。`)
    lines.push(`下次间隔可以在 ${range.min}–${range.max} 分钟之间。`)
    for (const { name, lines: contributed } of contributions) {
        if (contributed === null) lines.push(`${name} 这一轮读取失败。`)
        else if (contributed.length > 0) lines.push(`${name}：`, ...contributed.map(line => `- ${line}`))
    }
    return lines.join('\n')
}

function modelText(message) {
    return (message?.content ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()
}

/**
 * 编号为 `messageId` 的输入所在那一轮的结果。
 * @returns `{ found: false }`（日志里还没有这条），`{ found: true, ended: false }`（那一轮还没结束），
 *   或 `{ found: true, ended: true, outcome, text }`。
 */
export function turnOutcome(events, messageId) {
    let current = null
    let turn = null
    let text = ''
    for (const event of events) {
        const data = event?.data
        if (event?.type === 'turn/start') {
            current = data?.turn ?? null
            continue
        }
        if (turn === null) {
            if (event?.type === 'user/message' && String(data?.id) === messageId) turn = current
            continue
        }
        if (event.type === 'assistant/message' && data?.turn === turn && data.interrupted !== true) {
            const said = modelText(data.message)
            if (said !== '') text = said
        } else if (event.type === 'turn/end' && data?.turn === turn) {
            return { found: true, ended: true, outcome: data.reason?.kind ?? 'unknown', text }
        }
    }
    return turn === null ? { found: false } : { found: true, ended: false }
}

/** 夹在允许范围里。 */
export const clampMinutes = (value, { min, max }) => Math.min(max, Math.max(min, Math.round(value)))
