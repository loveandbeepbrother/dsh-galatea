/**
 * 给模型看的时间：都按核心配置的时区（`core.timezone`）写，带偏移，不靠进程本地时区，也不写死哪个时区。
 *
 * - 工具结果里的时刻：`2026-11-08 09:24+08:00`，另给相对时间（`3 天前`）。
 * - 输入的到达时刻（来源标注里）：`11-08 周六 09:24 +08:00`，短一些，日期和星期帮模型对上“今天”“昨天”。
 * - 模型照抄回来的时间串（`since`、`until`）：带偏移或 `Z` 的按原样解析；不带的按核心时区解析。
 *
 * @module mind-framework/core/time
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const formatters = new Map()

/** 一个时刻在给定时区里的各个字段，以及那一刻的 UTC 偏移（分钟）。 */
function partsOf(ms, timezone) {
    let formatter = formatters.get(timezone)
    if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        })
        formatters.set(timezone, formatter)
    }
    const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(part => [part.type, part.value]))
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
    const offset = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
    return { ...parts, offset, weekday: new Date(asUtc).getUTCDay() }
}

function offsetText(minutes) {
    const sign = minutes < 0 ? '-' : '+'
    const value = Math.abs(minutes)
    return `${sign}${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

/** 工具结果里的时刻：`YYYY-MM-DD HH:MM+08:00`。 */
export function clockText(ms, timezone) {
    const p = partsOf(ms, timezone)
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${offsetText(p.offset)}`
}

/** 精确到秒的版本（按秒排先后时用）：`YYYY-MM-DD HH:MM:SS+08:00`。 */
export function clockSecondsText(ms, timezone) {
    const p = partsOf(ms, timezone)
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${offsetText(p.offset)}`
}

/** 输入的到达时刻：`MM-DD 周X HH:MM +08:00`。 */
export function arrivalText(ms, timezone) {
    const p = partsOf(ms, timezone)
    return `${p.month}-${p.day} ${WEEKDAYS[p.weekday]} ${p.hour}:${p.minute} ${offsetText(p.offset)}`
}

/** 离现在多久：`刚才`、`5 分钟前`、`3 小时前`、`2 天前`、`4 个月前`、`1 年前`；在将来的写“之后”。 */
export function agoText(ms, now = Date.now()) {
    const delta = now - ms
    const later = delta < 0
    const span = Math.abs(delta)
    const minutes = Math.floor(span / 60_000)
    if (minutes < 1) return later ? '马上' : '刚才'
    const days = Math.floor(span / 86_400_000)
    const amount = minutes < 60 ? `${minutes} 分钟`
        : days < 1 ? `${Math.floor(minutes / 60)} 小时`
            : days < 60 ? `${days} 天`
                : days < 730 ? `${Math.floor(days / 30)} 个月`
                    : `${Math.floor(days / 365)} 年`
    return `${amount}${later ? '后' : '前'}`
}

/** 工具结果里一个时刻的两个字段：`{ at, ago }`（字段名由调用方定）。 */
export function timeFields(ms, timezone, now = Date.now()) {
    return { at: clockText(ms, timezone), ago: agoText(ms, now) }
}

const TIME_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?: ?(Z|[+-]\d{2}:?\d{2}))?)?$/i

/**
 * 模型给的时间串变成毫秒：`YYYY-MM-DD[ HH:MM[:SS[.mmm]]][偏移]`，`T` 和空格都认，偏移可以是 `Z`、`+08:00`、`+0800`，
 * 偏移前可以有一个空格（我们给出的 `at` 原样传回来就能认）。带偏移的按偏移；不带的按给定时区。别的写法交给 `Date.parse`，认不出是 `NaN`。
 * @param value - 时间串。
 * @param timezone - 不带偏移时按哪个时区（核心的 `timezone`）。
 */
export function parseTimeText(value, timezone) {
    const text = String(value).trim()
    const match = TIME_TEXT.exec(text)
    if (match === null) return Date.parse(text)
    const [, year, month, day, hour = '0', minute = '0', second = '0', milli = '0', zone] = match
    const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(milli.padEnd(3, '0')))
    if (zone !== undefined) {
        if (zone.toUpperCase() === 'Z') return wall
        const digits = zone.replace(':', '')
        const minutes = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5))
        return wall - (digits[0] === '-' ? -minutes : minutes) * 60_000
    }
    // 先按这个墙上时刻在该时区的偏移猜一次，再用猜出的时刻的偏移校一次（夏令时切换附近）。
    let guess = wall - partsOf(wall, timezone).offset * 60_000
    guess = wall - partsOf(guess, timezone).offset * 60_000
    return guess
}
