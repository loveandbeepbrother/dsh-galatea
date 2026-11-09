/**
 * 休息时段 `core.quietHours` 与出口登记 `core.exits`。
 *
 * - **休息时段**只有核心这一份：`{ start, end, timezone }`，时段可以跨午夜，`start === end` 表示没有休息时段。
 *   出口读它决定"留到时段结束再发"，给会话的说明也读它。按时区里的钟点算，不处理夏令时切换那一小时。
 * - **出口登记**：渠道这类出口插件登记"哪些会话由我接、接成什么"（`hub` 是接用户本人的私聊，`group` 是接群），
 *   核心按它答 `servedBy(sessionId)`、`foreground()`（接着出口的会话）。自省的"前台空闲"看 `foreground()`。
 * - **出口通知** `notify(sessionIds, { key, text, at? })`：往接着某个会话的出口推一句固定的话，不开一轮（项目任务的进度发到项目接的群）。
 *   出口登记时交 `notify` 才收；去重、过期、限额由出口自己判断。没有出口接、出口报错或没发出时报 `core/notify-undeliverable`，
 *   出口按自己的规则不发（`skipped`）不报。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/quiet
 */

const CLOCK = /^(\d{1,2}):(\d{2})$/

function minutesOf(clock) {
    const match = CLOCK.exec(String(clock))
    if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59) throw new TypeError(`时间要写成 HH:MM：${clock}`)
    return Number(match[1]) * 60 + Number(match[2])
}

/**
 * @param config.start - 开始，`HH:MM`。
 * @param config.end - 结束（不含），`HH:MM`。
 * @param config.timezone - IANA 时区名；不给就用本机的。
 */
/**
 * 配置里的时区：不给就用本机时区；给了不认识的名字直接报错，不悄悄退回本机时区。
 */
export function resolveTimezone(timezone) {
    if (timezone === undefined || timezone === null || timezone === '') return Intl.DateTimeFormat().resolvedOptions().timeZone
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    } catch {
        throw new RangeError(`不认识的时区：${timezone}`)
    }
    return timezone
}

export function createQuietHours({ start = '00:00', end = '08:00', timezone } = {}) {
    const from = minutesOf(start)
    const to = minutesOf(end)
    const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

    /** 这个时刻在时区里是当天第几分钟（含秒的零头，毫秒）。 */
    function clockOf(at) {
        const parts = Object.fromEntries(format.formatToParts(new Date(at)).map(part => [part.type, part.value]))
        const minutes = Number(parts.hour) * 60 + Number(parts.minute)
        return { minutes, remainder: Number(parts.second) * 1000 + (at % 1000 + 1000) % 1000 }
    }

    function inQuiet(at = Date.now()) {
        if (from === to) return false
        const { minutes } = clockOf(at)
        return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
    }

    /** 这个时刻所在的休息时段在什么时候结束；不在时段里就是它自己。 */
    function nextEnd(at = Date.now()) {
        if (!inQuiet(at)) return at
        const { minutes, remainder } = clockOf(at)
        const delta = (to - minutes + 1440) % 1440
        return at - remainder + delta * 60_000
    }

    const describe = () => (from === to ? '没有休息时段' : `${start}–${end}（${zone}）`)

    return Object.freeze({ inQuiet, nextEnd, describe, config: Object.freeze({ start, end, timezone: zone }) })
}

export const EXIT_ROLES = Object.freeze(['hub', 'group'])

/** @param deps.report - 报异常。 */
export function createExits({ report }) {
    const exits = new Map()

    /**
     * 登记一个出口。
     * @param definition - `{ id, label, sessions() → [{ sessionId, as: 'hub' | 'group', label? }], notify?, sentBetween? }`。
     *   `notify({ sessionIds, key, text, at })` 收核心挑给它的会话（它接着的、按调用方给的顺序），
     *   返回 `{ status: 'sent' | 'skipped' | 'failed', reason? }`。
     *   `sentBetween(sessionId, from, to)` 交出这段时间里这个会话中途发到用户手上的话 `[{ at, text }]`（毫秒），现在读不到时返回 `null`。
     * @returns 撤销登记。
     */
    function register(definition) {
        const { id, label, sessions, notify, sentBetween } = definition ?? {}
        if (typeof id !== 'string' || id === '') throw new TypeError('出口要有 id')
        if (typeof sessions !== 'function') throw new TypeError(`出口 ${id} 要有 sessions()`)
        if (notify !== undefined && typeof notify !== 'function') throw new TypeError(`出口 ${id} 的 notify 要是函数`)
        if (sentBetween !== undefined && typeof sentBetween !== 'function') throw new TypeError(`出口 ${id} 的 sentBetween 要是函数`)
        if (exits.has(id)) throw new Error(`出口 ${id} 已经登记过`)
        const value = Object.freeze({ id, label: String(label ?? id), sessions, ...notify === undefined ? {} : { notify }, ...sentBetween === undefined ? {} : { sentBetween } })
        exits.set(id, value)
        return () => {
            if (exits.get(id) === value) exits.delete(id)
        }
    }

    function served() {
        const out = []
        for (const exit of exits.values()) {
            let list
            try {
                list = exit.sessions() ?? []
            } catch (error) {
                report('core/exit-sessions-failed', { text: `出口 ${exit.id} 交不出它接的会话（${error?.message ?? error}），这次当它没接` })
                continue
            }
            for (const item of list) {
                if (!EXIT_ROLES.includes(item?.as)) continue
                out.push({ exit: exit.id, exitLabel: exit.label, sessionId: String(item.sessionId), as: item.as, ...item.label === undefined ? {} : { label: String(item.label) } })
            }
        }
        return out
    }

    /** 这个会话由哪些出口接、接成什么。 */
    const servedBy = sessionId => served().filter(item => item.sessionId === String(sessionId))
    /** 接着出口的会话（前台）。 */
    const foreground = () => [...new Set(served().map(item => item.sessionId))]
    const list = () => [...exits.values()].map(({ id, label }) => ({ id, label }))

    /**
     * 往接着这些会话的出口推一句话：按 `sessionIds` 的顺序，第一个由收通知的出口接着的会话定下出口，
     * 这个出口接着的那几个会话（顺序不变）一起交给它，由它挑。
     * @returns `{ status, exit?, reason? }`；`status` 是 `sent`、`skipped`（出口按规则不发）、`unavailable`（没有出口接）或 `failed`。
     */
    async function notify(sessionIds, { key, text, at } = {}) {
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) throw new TypeError('notify 要给会话')
        if (typeof key !== 'string' || key === '' || typeof text !== 'string' || text === '') throw new TypeError('notify 要有 key 和 text')
        const ids = sessionIds.map(String)
        const candidates = served().filter(item => exits.get(item.exit)?.notify !== undefined)
        const first = ids.find(id => candidates.some(item => item.sessionId === id))
        const undeliverable = (reason, extra = {}) => {
            report('core/notify-undeliverable', { text: `通知 ${key} 没发出：${reason}`, data: { key, sessionIds: ids, ...extra } })
        }
        if (first === undefined) {
            const reason = `${ids.join('、')} 都没有收通知的出口接着`
            undeliverable(reason)
            return { status: 'unavailable', reason }
        }
        const exit = exits.get(candidates.find(item => item.sessionId === first).exit)
        const mine = ids.filter(id => candidates.some(item => item.sessionId === id && item.exit === exit.id))
        let result
        try {
            result = await exit.notify({ sessionIds: mine, key, text, ...at === undefined ? {} : { at } })
        } catch (error) {
            const reason = `出口 ${exit.id} 出错（${error?.message ?? error}）`
            undeliverable(reason, { exit: exit.id })
            return { status: 'failed', exit: exit.id, reason }
        }
        if (result?.status === 'sent' || result?.status === 'skipped') return { ...result, exit: exit.id }
        const reason = `出口 ${exit.id} 没发出（${result?.reason ?? result?.status ?? '没有交回结果'}）`
        undeliverable(reason, { exit: exit.id })
        return { status: 'failed', exit: exit.id, reason }
    }

    /**
     * 这个会话中途发到用户手上的话：各出口的合在一起，按时间排。
     * @returns `{ sends: [{ at, text }], unread }`；`unread` 为真时有出口现在读不到，没列出来不等于没发过。
     */
    async function sentBetween(sessionId, from = 0, to = Infinity) {
        const sends = []
        let unread = false
        for (const exit of exits.values()) {
            if (exit.sentBetween === undefined) continue
            try {
                const got = await exit.sentBetween(String(sessionId), from, to)
                if (got === null || got === undefined) unread = true
                else sends.push(...got)
            } catch (error) {
                unread = true
                report('core/exit-sends-failed', { text: `出口 ${exit.id} 交不出中途发送（${error?.message ?? error}）`, data: { subject: exit.id } })
            }
        }
        return { sends: sends.sort((left, right) => left.at - right.at), unread }
    }

    return Object.freeze({ register, servedBy, foreground, list, notify, sentBetween })
}
