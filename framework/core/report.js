/**
 * 异常出口 `core.report`：所有模块"记一条异常"都经这里。
 *
 * - 类别由报的一方自己起名，不设清单，没见过的类别照收。
 * - 消费方（Watchdog 等）用 `onReport` 接收，自己决定怎么归并、怎么提醒。注册时可以用 `takes` 声明自己接手哪些类别
 *   （按前缀）；不写就是全部接手。
 * - 没有消费方接手的类别，核心自己留最近 `UNHANDLED_KEPT` 条，后台思考醒来时按类别计数交进事实段
 *   （`unhandled(since)`）：没装 Watchdog 的用户，异常也不会只写进日志就悄悄没了。
 * - 没有消费方时写进 Host 日志，并原样留下最近 `EARLY_KEPT` 条；第一个消费方注册时按先后把它们原样交给它
 *   （启动时消费方往往比报异常的模块晚装上，只交一个条数，具体是哪几条就丢了：Host 日志不落盘）。超出的条数另交一条
 *   "启动以来另有 N 条异常只写进了日志"。第一次报的时候日志里先说一句"没有装异常的消费方"。
 *   这和上一条的留存互不影响：没有消费方时报的异常既原样留给第一个消费方，也照旧记进没人接手的那份。
 * - `report` 不抛错、不等待；它自己出错（含消费方出错）只写日志，不再往回报。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/report
 */

/** 第一个消费方注册时，超出 `EARLY_KEPT`、只剩条数的那一条的类别。 */
export const UNCONSUMED_KIND = 'core/unconsumed'

/** 没有消费方时原样留下、等第一个消费方的异常条数。 */
export const EARLY_KEPT = 200

/** 没有消费方接手的异常，核心留最近这么多条。 */
export const UNHANDLED_KEPT = 200

/**
 * @param logger - Host 日志（`warn`）；没有时什么也不写。
 * @param now - 取当前时间（测试用）。
 */
export function createReports(logger, now = Date.now) {
    /** 消费方 → 它接手的类别前缀（`null` 是全部）。 */
    const consumers = new Map()
    /** 没有消费方接手的异常，最近的在后面。 */
    const unhandledEntries = []
    /** 还没有消费方时报的异常，原样留着，等第一个消费方。 */
    const early = []
    let unconsumed = 0
    let warned = false
    const warn = text => {
        try {
            logger?.warn?.(text)
        } catch {
            // 日志本身出错：没有更后面的地方可报了。
        }
    }

    /**
     * 报一条异常。
     * @param kind - 类别，报的一方自己起名。
     * @param detail - `{ sessionId?, text, data? }`。
     * @param by - 报的一方（调用方）。
     */
    function report(kind, detail, by) {
        try {
            const entry = Object.freeze({
                kind: String(kind),
                at: now(),
                ...detail?.sessionId === undefined ? {} : { sessionId: String(detail.sessionId) },
                text: String(detail?.text ?? ''),
                ...detail?.data === undefined ? {} : { data: detail.data },
                by,
            })
            if (!taken(entry.kind)) {
                unhandledEntries.push(entry)
                if (unhandledEntries.length > UNHANDLED_KEPT) unhandledEntries.shift()
            }
            if (consumers.size === 0) {
                if (!warned) {
                    warned = true
                    warn('mind-framework: 没有装异常的消费方，异常只写进日志')
                }
                if (early.length < EARLY_KEPT) early.push(entry)
                else unconsumed += 1
                warn(`mind-framework: 异常 ${entry.kind}${entry.sessionId === undefined ? '' : ` · ${entry.sessionId}`}：${entry.text}`)
                return
            }
            for (const consumer of [...consumers.keys()]) hand(consumer, entry)
        } catch (error) {
            warn(`mind-framework: 报异常时出错（${error?.message ?? error}）`)
        }
    }

    /** 有没有消费方接手这个类别。 */
    function taken(kind) {
        for (const takes of consumers.values()) {
            if (takes === null || takes.some(prefix => kind.startsWith(prefix))) return true
        }
        return false
    }

    function hand(consumer, entry) {
        try {
            const result = consumer(entry)
            if (typeof result?.then === 'function') {
                result.then(undefined, error => warn(`mind-framework: 异常的消费方出错（${error?.message ?? error}）`))
            }
        } catch (error) {
            warn(`mind-framework: 异常的消费方出错（${error?.message ?? error}）`)
        }
    }

    /**
     * 注册一个消费方。
     * @param consumer - 收到每一条 `{ kind, at, sessionId?, text, data?, by }`。
     * @param options.takes - 接手的类别前缀（例如 `['channels/']`）；不写是全部接手。接手的类别核心不再交给后台思考；
     *   只是看看、不处理的消费方写 `[]`。
     * @returns 取消注册。
     */
    function onReport(consumer, { takes } = {}) {
        if (typeof consumer !== 'function') throw new TypeError('onReport 需要一个函数')
        if (takes !== undefined && (!Array.isArray(takes) || takes.some(prefix => typeof prefix !== 'string' || prefix === ''))) {
            throw new TypeError('takes 要是类别前缀的数组')
        }
        const first = consumers.size === 0
        consumers.set(consumer, takes === undefined ? null : [...takes])
        if (first) {
            // 先按先后原样交出留着的，再交超出上限、只剩条数的那一条。
            for (const entry of early.splice(0)) hand(consumer, entry)
            if (unconsumed > 0) {
                const count = unconsumed
                unconsumed = 0
                hand(consumer, Object.freeze({
                    kind: UNCONSUMED_KIND,
                    at: now(),
                    text: `启动以来另有 ${count} 条异常只写进了日志（超出原样留下的 ${EARLY_KEPT} 条）`,
                    data: { count },
                    by: { kind: 'program', plugin: 'mind-framework-core' },
                }))
            }
        }
        return () => {
            consumers.delete(consumer)
        }
    }

    /**
     * 某个时刻以后、没有消费方接手的异常，按类别归并：`[{ kind, count, lastAt, lastText }]`，最近出现的类别在前。
     * 按现在的消费方算：后来有消费方接手的类别不再列出。
     */
    function unhandled(since = 0) {
        const byKind = new Map()
        for (const entry of unhandledEntries) {
            if (entry.at <= since || taken(entry.kind)) continue
            const seen = byKind.get(entry.kind)
            byKind.set(entry.kind, { kind: entry.kind, count: (seen?.count ?? 0) + 1, lastAt: entry.at, lastText: entry.text })
        }
        return [...byKind.values()].sort((left, right) => right.lastAt - left.lastAt)
    }

    return Object.freeze({ report, onReport, unhandled })
}
