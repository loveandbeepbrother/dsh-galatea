/**
 * Claude 订阅额度的闸门：额度用完时所有会话的请求在交给 Claude Code 之前就拒绝，积压的输入原样留在 DSH，
 * 恢复后按顺序逐个唤醒有积压的会话。
 *
 * - 识别只读结构化信号：`rate_limit_event` 的 `status`、助手消息上的 `apiError`、`quotaLimits`、`error`；
 *   SDK 的 `USAGE_LIMIT_ERROR_PREFIXES` 只作兜底（认报错文字的开头）。普通的短暂 429 不归这里，照旧由 DSH 重试。
 * - 闸门存在存储域里，Host 重启后照样关着，并立即开始查恢复。
 * - 标注的恢复时间（`resetsAt`）是最晚时间：到点后（加一点余量）直接打开、开始唤醒；之前每隔一段时间查一次，
 *   先查用量（不经模型），查不到时用被拒的模型发一次最小请求；任何一次真实请求成功、或 Claude Code 报来“允许”，也算恢复。
 *   打开后若仍被拒，按新的恢复时间再关上（多半是按周的限额）。
 * - 积压记录每个会话首次与最后一次被拒的时间、交到 Claude Code 的与还留在 DSH 的输入条数、被打断的后台一轮。
 * - 唤醒：中枢优先，其余按首次被拒的时间，一次一个，只在被唤醒的那一轮结束后才唤醒下一个。恢复后开始、把输入交给模型作答的一轮
 *   正常结束，就算这个会话答过了积压（那一轮按顺序带上了全部积压），不再唤醒（压缩命令等不经模型作答的不算）；正有这样一轮在进行时先等它，不往里排唤醒。唤醒的状态区分
 *   “已交出、这一轮还没完成”与“恢复后已经答过”；Host 重启后，已交出的按会话里的实际事件重新判断，没答过的换一个转交键再交。
 *   只有后台思考输入的会话不唤醒（后台思考自己顺延）。被打断的后台子代理与命令只告诉会话，不自动重开。
 *
 * @module @loveandbeepbrother/dsh-galatea-agent-sdk/quota
 */

import { asksModel } from './plan.js'

/** 额度用完的失败类别：不交给 DSH 重试，由闸门恢复后唤醒会话。 */
export const USAGE_LIMIT = 'USAGE_LIMIT'

/** 闸门的默认配置（插件配置 `quota` 覆盖）。 */
export const QUOTA_DEFAULTS = Object.freeze({
    /** 额度用完期间多久查一次恢复。 */
    probeMinutes: 10,
    /** 到了标注的恢复时间再等多少秒打开闸门。 */
    resetGraceSeconds: 30,
    /** 先经 SDK 的用量查询（不经模型）看额度。 */
    usageQuery: true,
    /** 用量查询不可用时，用被拒的模型发一次最小请求（不用工具、不存记录）。 */
    modelProbe: true,
    /** 额度正常时经在跑的 Claude Code 进程查用量的间隔（分钟）；0 不查。不为此另开进程。 */
    usagePollMinutes: 30,
    /** 唤醒一个会话后，最多等它这一轮多久再唤醒下一个。 */
    wakeTurnMinutes: 20,
    /** 一个会话最多唤醒几次（被唤醒的那一轮没有正常结束、或 Host 重启后还没答过时再交）。 */
    wakeAttempts: 3,
    /** 恢复后多久核对：有积压的会话到那时还没回过一轮，报 `agent-sdk/wake-unanswered`（原来 Watchdog 看闸门内部做的，后来挪进来）。 */
    verifyMinutes: 15,
})

/** 唤醒状态的说法（报"恢复后会话没接上"时用）。 */
const WAKE_WORDS = Object.freeze({
    pending: '还没唤醒',
    delivered: '唤醒了，被唤醒的那一轮还没完成',
    failed: '被唤醒的那一轮没有正常结束（或没在等待时间内结束），不再自动唤醒',
    unavailable: '唤醒的话交不出去',
})

/** 恢复后核对报告的类别。 */
export const WAKE_UNANSWERED = 'agent-sdk/wake-unanswered'

/** 限额类型的说法。 */
export const WINDOW_WORDS = Object.freeze({
    five_hour: '5 小时额度',
    seven_day: '本周额度',
    seven_day_opus: '本周 Opus 额度',
    seven_day_sonnet: '本周 Sonnet 额度',
    seven_day_overage_included: '本周额度',
    overage: '额外用量',
})

/**
 * 一个时刻在给定时区里的 `{ y, m, d, hh, mm }`。时区由框架核心的 `timezone` 给（调用方传进来），不读进程环境：
 * Host 与 Claude Code 进程的 TZ 可能是为别的用途设的。
 */
export function partsIn(time, timezone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(time)).map(part => [part.type, part.value]))
    return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: parts.hour, mm: parts.minute }
}

/** 给定时区里的“HH:MM”；与 `now` 不在同一天时写成“M月D日 HH:MM”。 */
export function clockText(time, now, timezone) {
    const at = partsIn(time, timezone)
    const today = partsIn(now, timezone)
    const clock = `${at.hh}:${at.mm}`
    return at.y === today.y && at.m === today.m && at.d === today.d ? clock : `${at.m}月${at.d}日 ${clock}`
}

/** Claude Code 报来的秒级时间戳转毫秒；没有时为 `null`。 */
function secondsToMs(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null
}

/**
 * 一条 SDK 输出里的额度信号。
 * @returns `{ kind: 'usage', resetsAt, rateLimitType }`（额度用完）、`{ kind: 'rate' }`（短暂限流）、`{ kind: 'server' }`、
 *   `{ kind: 'other', error }`，或 `null`（不是报错的消息）。
 */
export function limitSignal(value, prefixes = []) {
    if (value?.type !== 'assistant') return null
    const info = value.quotaLimits ?? value.apiErrorParams?.rate_limit_info ?? null
    const text = (value.message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n')
    if (value.apiError === 'usage_limit_reached' || info?.status === 'rejected'
        || (value.error === 'rate_limit' && startsWithAny(text, prefixes))) {
        return { kind: 'usage', resetsAt: secondsToMs(info?.resetsAt), rateLimitType: info?.rateLimitType ?? null }
    }
    if (value.error === 'rate_limit' || value.apiErrorStatus === 429) return { kind: 'rate' }
    if (value.error === 'overloaded' || value.error === 'server_error' || (value.apiErrorStatus ?? 0) >= 500) return { kind: 'server' }
    if (value.error !== undefined && value.error !== null) return { kind: 'other', error: String(value.error) }
    return null
}

/** 文字是否以其中一个前缀开头（忽略开头空白）。 */
export function startsWithAny(text, prefixes) {
    const trimmed = String(text ?? '').trimStart()
    return prefixes.some(prefix => trimmed.startsWith(prefix))
}

/**
 * `rate_limit_event` 里的各个窗口：`unifiedWindows` 每次都带全部窗口（内部字段，新版 CLI 才有）；没有时只有当前起限制作用的那个。
 * 用量一律按占比（0–1）。
 * @returns `{ [rateLimitType]: { utilization, resetsAt, status } }`
 */
export function eventWindows(info) {
    const windows = {}
    if (info?.unifiedWindows !== null && typeof info?.unifiedWindows === 'object') {
        for (const [type, window] of Object.entries(info.unifiedWindows)) {
            if (window === null || typeof window !== 'object' || typeof window.utilization !== 'number') continue
            windows[type] = { utilization: window.utilization, resetsAt: secondsToMs(window.resetsAt), status: window.status ?? null }
        }
    }
    if (typeof info?.rateLimitType === 'string' && typeof info.utilization === 'number' && windows[info.rateLimitType] === undefined) {
        windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: secondsToMs(info.resetsAt), status: info.status ?? null }
    }
    return windows
}

/**
 * SDK 用量查询（`/usage` 背后的数据）的各窗口；`rate_limits_available` 不为真时为 `null`。用量按占比（0–1）。
 */
export function usageWindows(response) {
    if (response?.rate_limits_available !== true || response.rate_limits === null || typeof response.rate_limits !== 'object') return null
    const windows = {}
    for (const [type, window] of Object.entries(response.rate_limits)) {
        if (window === null || typeof window !== 'object' || Array.isArray(window) || typeof window.utilization !== 'number') continue
        const resetsAt = Date.parse(window.resets_at)
        windows[type] = { utilization: window.utilization / 100, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, status: null }
    }
    return windows
}

/**
 * 一个会话的积压记录。`wake` 是恢复后的唤醒状态：`pending` 待唤醒、`delivered` 已交出而这一轮还没完成、`answered` 恢复后答过、
 * `failed` 被唤醒的那一轮没有正常结束（或没在等待时间内结束）、`deferred` 不唤醒（后台思考）、`unavailable` 交不出去；`attempts` 是交过几次。
 */
function freshLedger(now) {
    return { firstAt: now, lastAt: now, rejected: 0, delivered: 0, pending: 0, sources: [], interrupted: [], wake: null, wokeAt: null, answeredAt: null, attempts: 0 }
}

/** 唤醒那段话开头的标记：带着它的一轮就是被唤醒的那一轮。 */
export function wakeMarker(outageId) {
    return `【额度恢复 ${outageId}】`
}

/** 消息里的文字。 */
function messageText(message) {
    return (message?.content ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

/**
 * 按会话里的实际事件判断它恢复后的情况（Host 重启后用）：`answeredAt` 是恢复后开始、有要模型作答的输入（`asksModel`：不算压缩命令与
 * 只取回 Claude Code 自己开的轮）、正常结束的第一轮的结束时间；
 * `woken` 是唤醒的话已经在会话里（已放进输入队列或已被取用）；`busy` 是最后一轮还没结束。
 * @param since - 恢复的时间。
 * @param marker - `wakeMarker(编号)`。
 */
export function sessionAfter(events, { since, marker }) {
    const started = new Map()
    /** 哪些轮里有要模型作答的输入。 */
    const asked = new Set()
    let current = null
    let answeredAt = null
    let woken = false
    let busy = false
    for (const event of events ?? []) {
        const data = event?.data
        if (event?.type === 'turn/start') {
            started.set(data?.turn, event.time)
            current = data?.turn
            busy = true
        } else if (event?.type === 'turn/end') {
            busy = false
            const at = started.get(data?.turn)
            if (answeredAt === null && data?.reason?.kind === 'completed' && asked.has(data?.turn) && typeof at === 'number' && at >= since) {
                answeredAt = event.time
            }
        } else if (event?.type === 'user/message') {
            if (busy && asksModel(data)) asked.add(current)
            if (messageText(data).includes(marker)) woken = true
        } else if (event?.type === 'agent/inbox/spliced' && (data?.inserted ?? []).some(message => messageText(message).includes(marker))) {
            woken = true
        }
    }
    return { answeredAt, woken, busy }
}

/** 闸门的初始状态。 */
export function openState() {
    return {
        state: 'open',
        outageId: null,
        since: null,
        resetsAt: null,
        rateLimitType: null,
        model: null,
        lastProbeAt: null,
        probeVia: null,
        windows: {},
        backlog: {},
        last: null,
        updatedAt: 0,
    }
}

/** 恢复后交给有积压的会话的一段话（系统转交，不是用户发言）。 */
export function wakeText(ledger, { outageId, recoveredAt, rateLimitType }, now = recoveredAt, timezone) {
    const what = WINDOW_WORDS[rateLimitType] ?? 'Claude 的额度'
    const total = ledger.delivered + ledger.pending
    const parts = [`${wakeMarker(outageId)}（系统转交，不是用户发言）${what}在 ${clockText(ledger.firstAt, now, timezone)}–${clockText(recoveredAt, now, timezone)} 用完，`]
    if (total > 0) {
        parts.push(`这段时间这个会话有 ${total} 条输入没有回`)
        if (ledger.delivered > 0 && ledger.pending > 0) {
            parts.push(`（前 ${ledger.delivered} 条已经在你的记录里、后面跟着额度报错，其余 ${ledger.pending} 条随这条一起交给你）`)
        } else if (ledger.delivered > 0) {
            parts.push('（已经在你的记录里、后面跟着额度报错）')
        } else {
            parts.push('（随这条一起交给你）')
        }
        parts.push('。')
    }
    if (ledger.interrupted.length > 0) {
        const causes = [...new Set(ledger.interrupted.map(item => item.cause))]
        parts.push(`被打断的后台一轮：${causes.join('；')}；被打断的后台子代理与命令不会自动重开，要不要重做由你决定。`)
    }
    parts.push('现在恢复了，请按顺序处理；已经回过的不用重复。')
    return parts.join('')
}

/**
 * 额度闸门。
 *
 * `deps`：
 * - `load()` / `save(record)`：读写存储域里的闸门记录（可异步）；
 * - `probe({ model, rateLimitType })`：查一次额度，返回 `{ status: 'allowed'|'rejected'|'unknown', via, resetsAt?, rateLimitType?, windows? }`；
 * - `pollUsage()`：可选，额度正常时经在跑的进程查一次用量，返回窗口或 `null`；
 * - `mainSessionId()`：中枢；
 * - `roleOf(sessionId)`：可选，会话在框架核心里的角色。后台会话（`background`）恢复后不唤醒：后台思考自己顺延（框架核心按角色豁免，
 *   不按消息来源的名字认）；
 * - `wake(sessionId, { key, text })`：经唯一的转交入口交给会话，返回 `{ status }`；
 * - `sessionState(sessionId, { since, marker })`：可选，按会话里的实际事件给出 `sessionAfter` 的结果（Host 重启后判断已交出的唤醒）；
 * - `report(kind, detail)`：可选，报异常（框架核心的 `core.report`）：恢复 `verifyMinutes` 以后还没回过一轮的会话报一条，之后回了再报"好了"；
 * - `now()`、`setTimer(fn, ms)`、`clearTimer(handle)`、`logger`。
 */
export class QuotaGate {
    constructor(config = {}, deps = {}) {
        this.config = { ...QUOTA_DEFAULTS, ...config }
        this.deps = deps
        this.now = deps.now ?? Date.now
        this.setTimer = deps.setTimer ?? ((fn, ms) => {
            const handle = setTimeout(fn, Math.max(0, ms))
            handle.unref?.()
            return handle
        })
        this.clearTimer = deps.clearTimer ?? clearTimeout
        this.record = openState()
        this.loaded = false
        this.timers = { probe: undefined, reset: undefined, poll: undefined, verify: undefined }
        /**
         * @type {Map<string, { startedAt: number, wake: boolean, carries: boolean }>} 本进程里各会话正在进行的一轮；`wake` 表示它带着唤醒的话，
         * `carries` 表示它把输入交给了模型作答。
         */
        this.active = new Map()
        /** @type {Map<string, { wakeOnly: boolean, resolve: Function }[]>} 等某个会话一轮结束的；`wakeOnly` 的只等被唤醒的那一轮。 */
        this.endWaiters = new Map()
        /** 结果本进程不知道的会话（Host 重启过，或转交入口说这个键已经交过）：唤醒前按会话里的实际事件重新判断。 */
        this.recheck = new Set()
        /** 恢复后开始、等了 `wakeTurnMinutes` 还没结束的一轮所在的会话：先唤醒别的，那一轮结束后再看。 */
        this.longTurns = new Set()
        this.waking = null
        this.probing = null
        this.closed = false
        this.writes = Promise.resolve()
    }

    /** 读出存下的闸门；关着时立即开始查恢复，上次唤醒没做完的接着做。 */
    async load() {
        if (this.loaded) return
        try {
            const stored = await this.deps.load?.()
            if (stored !== undefined && stored !== null) this.record = { ...openState(), ...stored }
        } catch (error) {
            this.deps.logger?.warn?.(`galatea-agent-sdk: 读不出额度闸门，按额度正常处理：${error?.message ?? error}`)
        }
        this.loaded = true
        for (const [sessionId, ledger] of Object.entries(this.record.last?.sessions ?? {})) {
            ledger.attempts ??= 0
            // 重启前的结果本进程不知道（记下“答过”可能没赶上落盘）：唤醒前都按会话里的实际事件再判断一次。
            if ((ledger.wake === 'delivered' || ledger.wake === 'pending') && ledger.answeredAt === null) this.recheck.add(sessionId)
        }
        if (this.limited()) this.schedule({ probeNow: true })
        else {
            this.schedulePoll()
            if (this.record.last !== null) {
                this.runWakes()
                this.scheduleVerify()
            }
        }
    }

    /** 现在是否额度用完。 */
    limited() {
        return this.record.state === 'limited'
    }

    /** 给别的插件看的现状（只读副本）。 */
    snapshot() {
        return structuredClone({ ...this.record, loaded: this.loaded })
    }

    persist() {
        this.record.updatedAt = this.now()
        const copy = structuredClone(this.record)
        this.writes = this.writes.then(() => this.deps.save?.(copy)).catch((error) => {
            this.deps.logger?.warn?.(`galatea-agent-sdk: 额度闸门没写进存储：${error?.message ?? error}`)
        })
        return this.writes
    }

    /** 并入一组窗口用量。 */
    mergeWindows(windows) {
        const at = this.now()
        let changed = false
        for (const [type, window] of Object.entries(windows ?? {})) {
            const before = this.record.windows[type]
            if (before?.utilization === window.utilization && before?.resetsAt === window.resetsAt && before?.status === window.status) continue
            this.record.windows[type] = { utilization: window.utilization, resetsAt: window.resetsAt ?? null, status: window.status ?? null, at }
            changed = true
        }
        return changed
    }

    /** Claude Code 报来的 `rate_limit_event`：记下用量；`rejected` 关上闸门，额度用完期间报来“允许”就恢复。 */
    observeEvent(info, model) {
        if (info === null || typeof info !== 'object') return
        const changed = this.mergeWindows(eventWindows(info))
        if (info.status === 'rejected') {
            this.close({ resetsAt: secondsToMs(info.resetsAt), rateLimitType: info.rateLimitType ?? null, model })
            return
        }
        if ((info.status === 'allowed' || info.status === 'allowed_warning') && this.limited()) {
            this.recover('event')
            return
        }
        if (changed) this.persist()
    }

    /**
     * 关上闸门（额度用完）。已经关着时更新恢复时间与限额类型；上一次恢复后还没唤醒的会话并进这次的积压。
     */
    close({ resetsAt = null, rateLimitType = null, model = null } = {}) {
        const now = this.now()
        const record = this.record
        // 已经过去的恢复时间（上一个窗口的）不能再当作最晚时间，否则一到点就又打开：当作不知道，靠查恢复。
        if (resetsAt !== null && resetsAt <= now) resetsAt = null
        if (record.state !== 'limited') {
            const carried = {}
            for (const [sessionId, ledger] of Object.entries(record.last?.sessions ?? {})) {
                if (ledger.answeredAt === null && ['pending', 'delivered', 'failed', 'unavailable'].includes(ledger.wake)) {
                    carried[sessionId] = { ...ledger, wake: null, wokeAt: null, attempts: 0 }
                }
            }
            Object.assign(record, {
                state: 'limited',
                outageId: `q${now.toString(36)}`,
                since: now,
                resetsAt,
                rateLimitType,
                model,
                lastProbeAt: null,
                probeVia: null,
                backlog: carried,
            })
            this.deps.logger?.warn?.(`galatea-agent-sdk: Claude 额度用完（${rateLimitType ?? '类型不明'}），最晚 ${resetsAt === null ? '不明' : new Date(resetsAt).toISOString()} 恢复`)
        } else {
            if (resetsAt !== null) record.resetsAt = resetsAt
            if (rateLimitType !== null) record.rateLimitType = rateLimitType
            if (model !== null && record.model === null) record.model = model
        }
        this.persist()
        this.schedule()
    }

    /**
     * 记下一个会话这一次被拒。`delivered` 是这一轮交到 Claude Code 后才被拒的输入条数；`pending` 是闸门拦下、还留在 DSH 里的
     * 输入条数（每次被拒时都是从上次交出之后算起的全部，所以取最新的）。
     */
    reject(sessionId, { delivered = 0, pending = 0, sources = [] } = {}) {
        if (!this.limited()) return
        const now = this.now()
        const ledger = this.record.backlog[sessionId] ?? freshLedger(now)
        ledger.lastAt = now
        ledger.rejected += 1
        ledger.delivered += delivered
        if (delivered === 0) ledger.pending = pending
        ledger.sources = [...new Set([...ledger.sources, ...sources])]
        this.record.backlog[sessionId] = ledger
        this.persist()
    }

    /** 记下被额度打断的后台一轮（Claude Code 自己开的一轮）。 */
    interrupted(sessionId, cause) {
        if (!this.limited()) return
        const now = this.now()
        const ledger = this.record.backlog[sessionId] ?? freshLedger(now)
        ledger.lastAt = now
        ledger.interrupted.push({ at: now, cause: String(cause) })
        this.record.backlog[sessionId] = ledger
        this.persist()
    }

    /** 一次真实请求成功：`startedAt` 在额度用完之后的，说明已经恢复。 */
    succeeded(sessionId, startedAt) {
        if (this.limited() && startedAt >= this.record.since) this.recover('turn')
    }

    /**
     * 一个会话开始一轮（闸门开着）：`prompt` 带着唤醒标记的，就是被唤醒的那一轮。这时还不算在答积压：压缩命令、只取回自己开的轮等
     * 不经模型作答的一轮也从这里开始。
     */
    turnStarted(sessionId, prompt = '') {
        const last = this.record.last
        const wake = last !== null && typeof prompt === 'string' && prompt.includes(wakeMarker(last.outageId))
        this.active.set(sessionId, { startedAt: this.now(), wake, carries: false })
    }

    /** 这一轮把输入交给模型作答了（带着积下的输入，或请它回答已经交出的上一条）：正常结束才算答过积压。 */
    turnCarries(sessionId) {
        const turn = this.active.get(sessionId)
        if (turn !== undefined) turn.carries = true
    }

    /**
     * 一个会话的一轮结束。恢复后开始、把输入交给模型作答的一轮正常结束：这个会话答过了积压，不再唤醒（压缩命令等不经模型作答的不算）；
     * 被唤醒的那一轮没有正常结束：记成 `failed`。
     * 等它结束的继续：只等被唤醒那一轮的，只在这一轮带着唤醒标记时才放行。
     */
    turnFinished(sessionId, ok) {
        const turn = this.active.get(sessionId)
        if (turn === undefined) return
        this.active.delete(sessionId)
        const last = this.record.last
        const ledger = last?.sessions?.[sessionId]
        if (ledger !== undefined && ledger.answeredAt === null && turn.startedAt >= last.recoveredAt) {
            if (ok && turn.carries) {
                ledger.answeredAt = this.now()
                if (ledger.wake !== 'deferred') ledger.wake = 'answered'
                this.recheck.delete(sessionId)
                this.reportAnswered(sessionId, ledger)
                this.persist()
            } else if (!ok && turn.wake && ledger.wake === 'delivered') {
                ledger.wake = 'failed'
                this.persist()
            }
        }
        // 等了很久的那一轮终于结束：还没答过就让队列再看它。
        if (this.longTurns.delete(sessionId) && ledger?.answeredAt === null && !this.limited()) this.runWakes()
        const waiters = this.endWaiters.get(sessionId) ?? []
        const release = waiters.filter(waiter => !waiter.wakeOnly || turn.wake)
        const keep = waiters.filter(waiter => !release.includes(waiter))
        if (keep.length > 0) this.endWaiters.set(sessionId, keep)
        else this.endWaiters.delete(sessionId)
        for (const waiter of release) waiter.resolve('ended')
    }

    /** 等这个会话一轮结束（`wakeOnly` 时只等被唤醒的那一轮），最多 `wakeTurnMinutes`；返回 `ended`、`timeout` 或 `stopped`，并给出撤销等待的 `cancel`。 */
    waitEnd(sessionId, { wakeOnly }) {
        let waiter
        let timer
        const promise = new Promise((resolve) => {
            waiter = { wakeOnly, resolve }
            const list = this.endWaiters.get(sessionId) ?? []
            list.push(waiter)
            this.endWaiters.set(sessionId, list)
            timer = this.setTimer(() => resolve('timeout'), this.config.wakeTurnMinutes * 60_000)
        }).finally(() => {
            this.clearTimer(timer)
            const list = (this.endWaiters.get(sessionId) ?? []).filter(item => item !== waiter)
            if (list.length > 0) this.endWaiters.set(sessionId, list)
            else this.endWaiters.delete(sessionId)
        })
        return { promise, cancel: () => waiter.resolve('cancelled') }
    }

    /** 打开闸门（恢复），开始唤醒有积压的会话。 */
    recover(via) {
        if (!this.limited()) return
        const now = this.now()
        const record = this.record
        const sessions = {}
        for (const [sessionId, ledger] of Object.entries(record.backlog)) {
            // 后台会话的积压不唤醒，后台思考到点自己再来；被额度打断的后台一轮照样唤醒告诉它。
            const background = this.deps.roleOf?.(sessionId) === 'background' && ledger.interrupted.length === 0
            sessions[sessionId] = { ...ledger, wake: background ? 'deferred' : 'pending', wokeAt: null, answeredAt: null, attempts: 0 }
        }
        record.last = {
            outageId: record.outageId,
            since: record.since,
            recoveredAt: now,
            via,
            rateLimitType: record.rateLimitType,
            resetsAt: record.resetsAt,
            sessions,
        }
        Object.assign(record, {
            state: 'open', outageId: null, since: null, resetsAt: null, rateLimitType: null, model: null,
            lastProbeAt: null, probeVia: null, backlog: {},
        })
        this.deps.logger?.info?.(`galatea-agent-sdk: Claude 额度恢复（${via}），${Object.keys(sessions).length} 个会话有积压`)
        this.clearTimers()
        this.persist()
        this.schedulePoll()
        this.runWakes()
        this.scheduleVerify()
    }

    /** 恢复 `verifyMinutes` 以后核对一次（Host 重启后按记下的恢复时间算，已经过了就马上核对）。 */
    scheduleVerify() {
        if (this.closed || this.limited() || this.record.last === null || this.deps.report === undefined) return
        if (this.timers.verify !== undefined) this.clearTimer(this.timers.verify)
        const at = this.record.last.recoveredAt + this.config.verifyMinutes * 60_000
        this.timers.verify = this.setTimer(() => {
            this.timers.verify = undefined
            this.verify()
        }, Math.max(0, at - this.now()))
    }

    /**
     * 核对：恢复以后有积压、到现在还没回过一轮的会话（不唤醒的除外）各报一条 `agent-sdk/wake-unanswered`，写明唤醒到了哪一步。
     * 每个会话只报一次（`reportedAt` 记在积压记录里，重启后不重报）。
     */
    verify() {
        const last = this.record.last
        if (this.closed || this.limited() || last === null) return
        let changed = false
        for (const [sessionId, ledger] of Object.entries(last.sessions)) {
            if (ledger.wake === 'deferred' || ledger.answeredAt !== null || ledger.reportedAt !== undefined) continue
            const main = this.deps.mainSessionId?.() === sessionId
            this.deps.report?.(WAKE_UNANSWERED, {
                sessionId,
                text: `额度 ${clockText(last.recoveredAt, this.now(), this.deps.timezone?.())} 恢复，${main ? '中枢' : `会话 ${sessionId}`}有 ${ledger.delivered + ledger.pending} 条输入积压，`
                    + `到现在还没回过一轮：${WAKE_WORDS[ledger.wake] ?? '状态不明'}`,
                data: { subject: `${last.outageId}-${sessionId}`, outageId: last.outageId, wake: ledger.wake },
            })
            ledger.reportedAt = this.now()
            changed = true
        }
        if (changed) this.persist()
    }

    /** 报过"没接上"的会话后来回了：再报一条"好了"，Watchdog 据此关掉那一条。 */
    reportAnswered(sessionId, ledger) {
        const last = this.record.last
        if (ledger.reportedAt === undefined || last === null) return
        this.deps.report?.(WAKE_UNANSWERED, {
            sessionId,
            text: `额度恢复后会话 ${sessionId} 回过一轮了`,
            data: { subject: `${last.outageId}-${sessionId}`, outageId: last.outageId, resolved: true },
        })
    }

    clearTimers() {
        for (const name of Object.keys(this.timers)) {
            if (this.timers[name] !== undefined) this.clearTimer(this.timers[name])
            this.timers[name] = undefined
        }
    }

    /** 额度用完期间：每隔 `probeMinutes` 查一次；到了标注的恢复时间加余量直接打开。 */
    schedule({ probeNow = false } = {}) {
        if (this.closed || !this.limited()) return
        this.clearTimers()
        const now = this.now()
        const every = this.config.probeMinutes * 60_000
        const last = this.record.lastProbeAt ?? this.record.since
        const wait = probeNow ? 0 : Math.max(0, last + every - now)
        if (every > 0 || probeNow) this.timers.probe = this.setTimer(() => this.probe(), wait)
        if (this.record.resetsAt !== null) {
            const at = this.record.resetsAt + this.config.resetGraceSeconds * 1000
            this.timers.reset = this.setTimer(() => this.recover('reset'), Math.max(0, at - now))
        }
    }

    /** 额度正常时经在跑的进程定期查用量（给提前提醒用）。 */
    schedulePoll() {
        if (this.closed || this.limited() || !this.config.usageQuery || this.config.usagePollMinutes <= 0 || this.deps.pollUsage === undefined) return
        if (this.timers.poll !== undefined) this.clearTimer(this.timers.poll)
        this.timers.poll = this.setTimer(async () => {
            this.timers.poll = undefined
            try {
                const windows = await this.deps.pollUsage()
                if (windows !== null && windows !== undefined && !this.limited() && this.mergeWindows(windows)) {
                    this.persist()
                }
            } catch (error) {
                this.deps.logger?.debug?.(`galatea-agent-sdk: 查用量失败：${error?.message ?? error}`)
            }
            this.schedulePoll()
        }, this.config.usagePollMinutes * 60_000)
    }

    /** 查一次额度恢复没有。 */
    probe() {
        if (this.probing !== null || this.closed || !this.limited()) return this.probing ?? Promise.resolve()
        this.probing = (async () => {
            let result
            try {
                result = await this.deps.probe?.({ model: this.record.model, rateLimitType: this.record.rateLimitType })
            } catch (error) {
                result = { status: 'unknown', via: null }
                this.deps.logger?.warn?.(`galatea-agent-sdk: 查额度失败：${error?.message ?? error}`)
            }
            if (!this.limited()) return
            this.record.lastProbeAt = this.now()
            this.record.probeVia = result?.via ?? null
            if (result?.windows) this.mergeWindows(result.windows)
            if (result?.status === 'allowed') {
                this.recover(result.via === 'usage' ? 'usage' : 'probe')
                return
            }
            if (result?.status === 'rejected') {
                this.close({ resetsAt: result.resetsAt ?? null, rateLimitType: result.rateLimitType ?? null })
                return
            }
            this.persist()
            this.schedule()
        })().finally(() => {
            this.probing = null
        })
        return this.probing
    }

    /** 下一个要唤醒的会话（待唤醒或已交出还没完成的）：中枢优先，其余按首次被拒的时间。 */
    nextWake() {
        const sessions = this.record.last?.sessions ?? {}
        const main = this.deps.mainSessionId?.()
        const waiting = Object.entries(sessions)
            .filter(([sessionId, ledger]) => ledger.answeredAt === null && (ledger.wake === 'pending' || ledger.wake === 'delivered')
                && !this.longTurns.has(sessionId))
        waiting.sort(([leftId, left], [rightId, right]) => {
            if (leftId === main) return -1
            if (rightId === main) return 1
            return left.firstAt - right.firstAt
        })
        return waiting[0]?.[0]
    }

    /** 逐个唤醒；同一时刻只有一个在跑。 */
    runWakes() {
        if (this.waking !== null) return this.waking
        this.waking = (async () => {
            while (!this.closed && !this.limited() && this.record.last !== null) {
                const sessionId = this.nextWake()
                if (sessionId === undefined) break
                await this.wakeOne(sessionId)
            }
        })().catch((error) => {
            this.deps.logger?.warn?.(`galatea-agent-sdk: 恢复后唤醒会话失败：${error?.message ?? error}`)
        }).finally(() => {
            this.waking = null
        })
        return this.waking
    }

    /** 记下这个会话恢复后答过了积压。 */
    async markAnswered(sessionId, ledger, at) {
        ledger.answeredAt = at
        ledger.wake = 'answered'
        this.reportAnswered(sessionId, ledger)
        await this.persist()
    }

    /**
     * 处理队列里的一个会话，一次只推进一步（之后由队列再看它）：
     * 1. 本进程里它正有一轮恢复后开始的在进行：那一轮就在处理积压，等它结束（不往里排唤醒）；
     * 2. 已交出、这一轮的结果本进程不知道（Host 重启过，或转交入口说已经交过）：按会话里的实际事件判断，答过的记下，
     *    唤醒的话还在会话里排着、或最后一轮还没结束的等它；
     * 3. 否则交一次唤醒（第几次就用第几个转交键），只等被唤醒的那一轮结束。
     */
    async wakeOne(sessionId) {
        const last = this.record.last
        const ledger = last.sessions[sessionId]
        const running = this.active.get(sessionId)
        if (running !== undefined && running.startedAt >= last.recoveredAt) {
            const outcome = await this.waitEnd(sessionId, { wakeOnly: false }).promise
            // 等不到结束（一轮跑得太久）：先放行别的会话，那一轮结束后再看它。
            if (outcome === 'timeout' && this.active.has(sessionId)) this.longTurns.add(sessionId)
            return
        }
        if (this.recheck.has(sessionId)) {
            this.recheck.delete(sessionId)
            let seen = null
            try {
                seen = await this.deps.sessionState?.(sessionId, { since: last.recoveredAt, marker: wakeMarker(last.outageId) }) ?? null
            } catch (error) {
                this.deps.logger?.warn?.(`galatea-agent-sdk: 读不出 ${sessionId} 恢复后的事件：${error?.message ?? error}`)
            }
            if (typeof seen?.answeredAt === 'number') {
                await this.markAnswered(sessionId, ledger, seen.answeredAt)
                return
            }
            if (seen?.busy === true) {
                // 有一轮还没结束（多半就是带着唤醒的那一轮）：等它，结束后再按事件判断一次。
                this.recheck.add(sessionId)
                await this.waitEnd(sessionId, { wakeOnly: false }).promise
                return
            }
        }
        if (ledger.attempts >= this.config.wakeAttempts) {
            ledger.wake = 'failed'
            await this.persist()
            return
        }
        ledger.attempts += 1
        const base = `quota-${last.outageId}-${sessionId}`
        const key = ledger.attempts === 1 ? base : `${base}-r${ledger.attempts}`
        ledger.wake = 'delivered'
        ledger.wokeAt = this.now()
        await this.persist()
        // 先登记等待再交出：被唤醒的那一轮可能很快就结束。
        const wait = this.waitEnd(sessionId, { wakeOnly: true })
        let result
        try {
            result = this.deps.wake === undefined
                ? { status: 'unavailable', reason: 'NO_DELIVERY' }
                : await this.deps.wake(sessionId, { key, text: wakeText(ledger, last, this.now(), this.deps.timezone?.()) })
        } catch (error) {
            result = { status: 'unavailable', reason: error?.message ?? String(error) }
        }
        if (result?.status === 'unavailable') {
            wait.cancel()
            ledger.wake = 'unavailable'
            this.deps.logger?.warn?.(`galatea-agent-sdk: 额度恢复后没能唤醒 ${sessionId}（${result.reason ?? '不明'}），到核对时报出来`)
            await this.persist()
            return
        }
        if (result?.status === 'duplicate') {
            // 这个键已经在会话里：结果按会话里的实际事件判断（下一步队列再看它）。
            wait.cancel()
            if (ledger.answeredAt === null) this.recheck.add(sessionId)
            return
        }
        const outcome = await wait.promise
        if (outcome === 'timeout' && ledger.answeredAt === null && ledger.wake === 'delivered' && !this.limited()) {
            ledger.wake = 'failed'
            this.deps.logger?.warn?.(`galatea-agent-sdk: ${sessionId} 被唤醒的那一轮 ${this.config.wakeTurnMinutes} 分钟没有结束，先唤醒下一个`)
            await this.persist()
        }
    }

    /** 停掉计时（Host 卸载）。 */
    stop() {
        this.closed = true
        this.clearTimers()
        for (const waiters of [...this.endWaiters.values()]) for (const waiter of waiters) waiter.resolve('stopped')
    }
}
