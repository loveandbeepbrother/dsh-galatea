/**
 * 额度用完与用量提前提醒的固定说明：不经模型，时间按调用方给的时区写（框架核心的 `core.timezone`）。
 *
 * - 额度用完：有来自渠道、还没回的真实输入时，每次额度用完、每个渠道范围只说一次；群会话不在群里说，私聊告诉用户、列出受影响的群。
 * - 用量提前提醒：5 小时与按周的额度各自到 80%、90%、95% 时各提醒一次（每个窗口按它的重置时间区分）。
 * - 休息时段（框架核心的一份 `core.quietHours`）：用户自己刚说的话撞上额度用完时照样立即说；
 *   其余等到时段结束，那时只说最高的一档。
 *
 * @module @loveandbeepbrother/dsh-galatea-channels/quota-notices
 */

/** 提醒的默认配置。 */
export const QUOTA_NOTICE_DEFAULTS = Object.freeze({
    usageWarnLevels: Object.freeze([0.8, 0.9, 0.95]),
    usageWarnWindows: Object.freeze(['five_hour', 'seven_day']),
    /** 用户的话在额度用完前这么久以内到的，算“撞上额度用完的是用户自己的话”。 */
    userHitMs: 10 * 60_000,
})

/** 限额类型的说法。 */
const WINDOW_WORDS = Object.freeze({
    five_hour: '5 小时额度',
    seven_day: '本周额度',
    seven_day_opus: '本周 Opus 额度',
    seven_day_sonnet: '本周 Sonnet 额度',
    seven_day_overage_included: '本周额度',
})

function zonedParts(time, timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(time)).map(part => [part.type, part.value]))
    return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: parts.hour, mm: parts.minute }
}

/**
 * 按给定时区的“HH:MM”；与 `now` 不在同一天时写成“M月D日 HH:MM”。
 * @param timeZone - IANA 时区名（框架核心的 `core.timezone`，由调用方传进来；这里不读环境）。
 */
export function localClock(time, now, timeZone) {
    const at = zonedParts(time, timeZone)
    const today = zonedParts(now, timeZone)
    const clock = `${at.hh}:${at.mm}`
    return at.y === today.y && at.m === today.m && at.d === today.d ? clock : `${at.m}月${at.d}日 ${clock}`
}

/**
 * 额度用完的说明。
 * @param quota - 额度现状（核心 `core.quota.detail` 的形状：`resetsAt`、`window`）。
 * @param scopes - 这次要说的范围：`{ main: boolean, groups: string[] }`（群名）。
 * @param timeZone - 恢复时间按哪个时区写（`core.timezone`）。
 */
export function quotaNoticeText(quota, { main, groups }, now, timeZone) {
    const what = WINDOW_WORDS[quota.window] ?? '额度'
    const when = typeof quota.resetsAt === 'number' ? `最晚 ${localClock(quota.resetsAt, now, timeZone)} 恢复` : '恢复时间还不知道'
    const where = groups.map(name => `群「${name}」`).join('、')
    const whose = main && groups.length > 0 ? `你在这里和${where}里的消息都收着`
        : main ? '你的消息都收着'
            : `${where}里的消息都收着`
    return `（${what}用完了，${when}，${whose}，恢复后按顺序回，不用重发。）`
}

/** 用量提前提醒的说明；重置时间按 `timeZone`（`core.timezone`）写。 */
export function usageWarningText(type, window, level, now, timeZone) {
    const what = WINDOW_WORDS[type] ?? '额度'
    const used = Math.min(100, Math.round(window.utilization * 100))
    return `（提醒：Claude ${what}已经用了 ${used}%（过了 ${Math.round(level * 100)}% 这一档），${localClock(window.resetsAt, now, timeZone)} 重置。）`
}

/** 用量提醒的去重键：哪个窗口（按重置时间到分钟）、哪一档。 */
export function usageKey(type, resetsAt, level) {
    return `usage-${type}-${Math.round(resetsAt / 60_000)}-${Math.round(level * 100)}`
}

/** 额度用完说明的去重键：这次停用的编号，加上这一条说到的范围（中枢为 `main`，群为绑定编号）。 */
export function quotaKey(outageId, scopes) {
    return `quota-${outageId}-${[...scopes].sort().join('|')}`
}

/** 从额度说明的去重键读回说到的范围；不是这次停用的返回 `null`。 */
export function scopesOfKey(key, outageId) {
    const prefix = `quota-${outageId}-`
    return key.startsWith(prefix) ? key.slice(prefix.length).split('|') : null
}

/**
 * 某个窗口这次该提醒的一档：用量过了的最高一档，且这一档及更高的都还没说过；不该提醒时为 `undefined`。
 * @param said - 某一档是否已经说过（按去重键查）。
 */
export function warningLevel(type, window, levels, said) {
    if (typeof window?.utilization !== 'number' || typeof window.resetsAt !== 'number') return undefined
    const passed = [...levels].sort((left, right) => left - right).filter(level => window.utilization >= level)
    if (passed.length === 0) return undefined
    const level = passed.at(-1)
    if (levels.filter(other => other >= level).some(other => said(usageKey(type, window.resetsAt, other)))) return undefined
    return level
}
