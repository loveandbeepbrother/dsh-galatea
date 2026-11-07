import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuotaGate, WAKE_UNANSWERED, clockText, eventWindows, openState, sessionAfter, usageWindows, wakeMarker, wakeText } from '../quota.js'

/** 2026-03-10 北京时间某一刻。 */
const bj = (hh, mm, ss = 0) => Date.UTC(2026, 2, 10, hh - 8, mm, ss)

/** 手动推进的时钟。 */
function clock(start) {
    let now = start
    const timers = new Set()
    return {
        now: () => now,
        setTimer: (fn, ms) => {
            const timer = { at: now + Math.max(0, ms), fn }
            timers.add(timer)
            return timer
        },
        clearTimer: timer => timers.delete(timer),
        timers,
        async advance(ms) {
            const until = now + ms
            while (true) {
                const due = [...timers].filter(timer => timer.at <= until).sort((left, right) => left.at - right.at)[0]
                if (due === undefined) break
                timers.delete(due)
                now = Math.max(now, due.at)
                await due.fn()
            }
            now = until
        },
    }
}

const settle = async () => {
    for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve))
}

function gate({ stored, probe = async () => ({ status: 'unknown', via: null }), wake, config, sessionState, start = bj(21, 17, 20) } = {}) {
    const time = clock(start)
    const saved = []
    const woken = []
    const reports = []
    const quota = new QuotaGate({ usageQuery: false, ...config }, {
        report: (kind, detail) => { reports.push({ kind, ...detail }) },
        load: () => stored,
        save: (record) => { saved.push(structuredClone(record)) },
        probe,
        mainSessionId: () => 'main',
        roleOf: sessionId => (sessionId.startsWith('background') ? 'background' : null),
        wake: wake ?? (async (sessionId, request) => {
            woken.push({ sessionId, ...request })
            // 被唤醒的那一轮：带着唤醒的话开始，正常结束。
            setImmediate(() => {
                quota.turnStarted(sessionId, request.text)
                quota.turnCarries(sessionId)
                quota.turnFinished(sessionId, true)
            })
            return { status: 'delivered' }
        }),
        ...sessionState === undefined ? {} : { sessionState },
        ...time,
    })
    return { quota, time, saved, woken, reports }
}

test('北京时间：不随进程时区，不在同一天时写上日期', () => {
    assert.equal(clockText(1773153000 * 1000, bj(21, 19, 21), 'Asia/Shanghai'), '22:30')
    assert.equal(clockText(1773153000 * 1000, bj(21, 19, 21), 'Asia/Tokyo'), '23:30', '按给的时区写，不按进程环境')
    assert.equal(clockText(Date.UTC(2026, 2, 14, 0, 0), bj(21, 19, 21), 'Asia/Shanghai'), '3月14日 08:00')
})

test('rate_limit_event 的窗口：每次带全部窗口时都记下，只有当前窗口时记那一个；用量查询按百分比换成占比', () => {
    assert.deepEqual(eventWindows({
        status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.91, resetsAt: 1773153000,
        unifiedWindows: { five_hour: { utilization: 0.91, resetsAt: 1773153000, status: 'allowed_warning' }, seven_day: { utilization: 0.4, resetsAt: 1794000000 } },
    }), {
        five_hour: { utilization: 0.91, resetsAt: 1773153000000, status: 'allowed_warning' },
        seven_day: { utilization: 0.4, resetsAt: 1794000000000, status: null },
    })
    assert.deepEqual(eventWindows({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8, resetsAt: 1794000000 }), {
        seven_day: { utilization: 0.8, resetsAt: 1794000000000, status: 'allowed_warning' },
    })
    assert.deepEqual(eventWindows({ status: 'allowed' }), {})
    assert.equal(usageWindows({ rate_limits_available: false, rate_limits: null }), null)
    assert.deepEqual(usageWindows({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 95, resets_at: '2026-03-10T14:30:00.000Z' }, seven_day: null, model_scoped: [] } }), {
        five_hour: { utilization: 0.95, resetsAt: 1773153000000, status: null },
    })
})

test('唤醒的话：写明用完的时段、几条输入、哪些已在记录里，被打断的后台一轮只告诉、不重开', () => {
    const ledger = { firstAt: bj(21, 17, 20), lastAt: bj(21, 30, 21), rejected: 3, delivered: 0, pending: 0, sources: [], interrupted: [{ at: bj(21, 20), cause: '后台任务「整理」有了结果' }], wake: 'pending', wokeAt: null, answeredAt: null }
    const text = wakeText(ledger, { outageId: 'qabc', recoveredAt: bj(21, 37, 20), rateLimitType: 'seven_day' }, bj(21, 37, 20), 'Asia/Shanghai')
    assert.equal(text, '【额度恢复 qabc】（系统转交，不是用户发言）本周额度在 21:17–21:37 用完，被打断的后台一轮：后台任务「整理」有了结果；被打断的后台子代理与命令不会自动重开，要不要重做由你决定。现在恢复了，请按顺序处理；已经回过的不用重复。')
})

test('后台会话（角色 background）的积压恢复后不唤醒，后台思考自己顺延；按角色认，不看来源名；被打断过后台一轮的照样唤醒', async () => {
    const { quota, woken } = gate()
    await quota.load()
    quota.close({ resetsAt: 1773153000000, rateLimitType: 'five_hour', model: 'opus' })
    quota.reject('background-thinking', { pending: 1, sources: ['whatever-name'] })
    quota.reject('main', { pending: 1, sources: ['reflection'] })
    quota.reject('background-other', { pending: 1, sources: [] })
    quota.interrupted('background-other', '后台任务有了结果')
    quota.recover('probe')
    await quota.waking
    assert.deepEqual(woken.map(wake => wake.sessionId).sort(), ['background-other', 'main'], '中枢里来自自省的留言照样唤醒')
    assert.equal(quota.snapshot().last.sessions['background-thinking'].wake, 'deferred')
})

test('已经过去的恢复时间不当作最晚时间（否则一到点又打开）；不知道恢复时间时靠每 10 分钟查一次', async () => {
    const { quota, time } = gate({ probe: async () => ({ status: 'allowed', via: 'model' }) })
    await quota.load()
    quota.close({ resetsAt: bj(21, 0), rateLimitType: 'five_hour' })
    assert.equal(quota.snapshot().resetsAt, null)
    await time.advance(9 * 60_000)
    assert.equal(quota.limited(), true)
    await time.advance(60_000)
    assert.equal(quota.limited(), false)
    assert.equal(quota.snapshot().last.via, 'probe')
})

test('按会话里的实际事件判断恢复后：恢复后开始、有要模型作答的输入、正常结束的一轮才算答过（压缩命令、只取回自己开的轮不算）；唤醒的话在输入队列或已被取用都算已交出；最后一轮没结束为忙', () => {
    const marker = wakeMarker('qabc')
    const text = value => ({ content: [{ type: 'text', text: value }] })
    // 框架核心在 pre-step 已经把分类写进 source.intent：运行时快照是参考，其余这几种是提问。
    const input = (value, kind = 'user', extra = {}) => ({ role: 'user', source: { kind, intent: kind === 'runtime-context' ? 'context' : 'prompt', ...extra }, content: [{ type: 'text', text: value }] })
    const events = [
        { type: 'turn/start', time: bj(21, 0), data: { turn: 1 } },
        { type: 'turn/end', time: bj(21, 1), data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'agent/inbox/spliced', time: bj(21, 40), data: { inserted: [text(`${marker}（系统转交）`)] } },
        { type: 'turn/start', time: bj(21, 40, 0), data: { turn: 2 } },
        { type: 'user/message', time: bj(21, 40, 0), data: input(`${marker}（系统转交）`, 'assistant-quota') },
        { type: 'turn/end', time: bj(21, 41), data: { turn: 2, reason: { kind: 'error', error: { code: 'AGENT_SDK_TURN_FAILED' } } } },
    ]
    assert.deepEqual(sessionAfter(events, { since: bj(21, 37, 20), marker }), { answeredAt: null, woken: true, busy: false })
    // 恢复后用户单独发的压缩命令、只取回 Claude Code 自己开的轮：正常结束也不算答过。
    const more = [
        ...events,
        { type: 'turn/start', time: bj(21, 42), data: { turn: 3 } },
        { type: 'user/message', time: bj(21, 42), data: input('/压缩 保留人物设定') },
        { type: 'turn/end', time: bj(21, 42, 15), data: { turn: 3, reason: { kind: 'completed' } } },
        { type: 'turn/start', time: bj(21, 43), data: { turn: 4 } },
        { type: 'user/message', time: bj(21, 43), data: input('【后台一轮 cc-0a1b2c3d】（系统转交）', 'agent-sdk', { key: 'cc-0a1b2c3d' }) },
        { type: 'user/message', time: bj(21, 43), data: input('Current runtime context.', 'runtime-context') },
        { type: 'turn/end', time: bj(21, 43, 15), data: { turn: 4, reason: { kind: 'completed' } } },
        { type: 'turn/start', time: bj(21, 45), data: { turn: 5 } },
        { type: 'user/message', time: bj(21, 45), data: input('在吗') },
    ]
    assert.deepEqual(sessionAfter(more, { since: bj(21, 37, 20), marker }), { answeredAt: null, woken: true, busy: true })
    more.push({ type: 'turn/end', time: bj(21, 46), data: { turn: 5, reason: { kind: 'completed' } } })
    assert.deepEqual(sessionAfter(more, { since: bj(21, 37, 20), marker }), { answeredAt: bj(21, 46), woken: true, busy: false })
    assert.deepEqual(sessionAfter(events.slice(0, 2), { since: bj(21, 37, 20), marker }), { answeredAt: null, woken: false, busy: false })
})

/** 唤醒中途 Host 重启时存下的状态：中枢已交出（第一次），示例书还没唤醒。 */
const halfway = () => ({
    ...openState(),
    last: {
        outageId: 'qabc', since: bj(21, 17, 20), recoveredAt: bj(21, 37, 20), via: 'probe', rateLimitType: 'five_hour', resetsAt: null,
        sessions: {
            main: { firstAt: bj(21, 19, 21), lastAt: bj(21, 20, 9), rejected: 2, delivered: 0, pending: 2, sources: ['user'], interrupted: [], wake: 'delivered', wokeAt: bj(21, 37, 20), answeredAt: null, attempts: 1 },
            demobook: { firstAt: bj(21, 17, 20), lastAt: bj(21, 30, 21), rejected: 3, delivered: 1, pending: 2, sources: ['user'], interrupted: [], wake: 'pending', wokeAt: null, answeredAt: null, attempts: 0 },
        },
    },
})

test('Host 在唤醒中途重启：已交出的按会话里的实际事件判断——唤醒的话在、还没答过的换一个转交键再交；答过的记下、不再唤醒', async () => {
    const pending = gate({ stored: halfway(), start: bj(21, 45), sessionState: async sessionId => (sessionId === 'main' ? { answeredAt: null, woken: true, busy: false } : null) })
    await pending.quota.load()
    await settle()
    await pending.quota.waking
    assert.deepEqual(pending.woken.map(wake => wake.key), ['quota-qabc-main-r2', 'quota-qabc-demobook'])
    assert.equal(pending.quota.snapshot().last.sessions.main.wake, 'answered')

    const done = gate({ stored: halfway(), start: bj(21, 45), sessionState: async sessionId => (sessionId === 'main' ? { answeredAt: bj(21, 39), woken: true, busy: false } : null) })
    await done.quota.load()
    await settle()
    await done.quota.waking
    assert.deepEqual(done.woken.map(wake => wake.key), ['quota-qabc-demobook'])
    assert.deepEqual(done.quota.snapshot().last.sessions.main, { ...halfway().last.sessions.main, wake: 'answered', answeredAt: bj(21, 39) })
})

test('转交入口说这个键已经交过（判重）：不当成完成，按会话里的实际事件判断，没答过就换键再交；最多交 wakeAttempts 次', async () => {
    const keys = []
    const { quota } = gate({
        config: { wakeAttempts: 2 },
        wake: async (sessionId, { key }) => {
            keys.push(key)
            return { status: 'duplicate' }
        },
        sessionState: async () => ({ answeredAt: null, woken: true, busy: false }),
    })
    await quota.load()
    quota.close({ resetsAt: 1773153000000 })
    quota.reject('main', { pending: 1, sources: ['user'] })
    quota.recover('reset')
    await quota.waking
    assert.deepEqual(keys, [`quota-${quota.snapshot().last.outageId}-main`, `quota-${quota.snapshot().last.outageId}-main-r2`])
    assert.equal(quota.snapshot().last.sessions.main.wake, 'failed')
})

test('被唤醒的那一轮没有正常结束：记成 failed，接着唤醒下一个；之后这个会话恢复后正常结束的一轮仍记为答过', async () => {
    const { quota } = gate({
        wake: async (sessionId, request) => {
            setImmediate(() => {
                quota.turnStarted(sessionId, request.text)
                quota.turnCarries(sessionId)
                quota.turnFinished(sessionId, sessionId !== 'main')
            })
            return { status: 'delivered' }
        },
    })
    await quota.load()
    quota.close({ resetsAt: 1773153000000 })
    quota.reject('main', { pending: 1, sources: ['user'] })
    quota.reject('demobook', { pending: 1, sources: ['user'] })
    quota.recover('reset')
    await quota.waking
    let sessions = quota.snapshot().last.sessions
    assert.deepEqual([sessions.main.wake, sessions.demobook.wake], ['failed', 'answered'])
    quota.turnStarted('main', '用户又说了一句')
    quota.turnCarries('main')
    quota.turnFinished('main', true)
    sessions = quota.snapshot().last.sessions
    assert.equal(sessions.main.wake, 'answered')
})

test('唤醒交不出去（没有转交入口）：记成交不出去，到核对时报出来，接着唤醒下一个', async () => {
    const { quota } = gate({ wake: async () => ({ status: 'unavailable', reason: 'NO_DELIVERY' }) })
    await quota.load()
    quota.close({ resetsAt: 1773153000000 })
    quota.reject('main', { pending: 1, sources: ['user'] })
    quota.reject('demobook', { pending: 1, sources: ['user'] })
    quota.recover('reset')
    await quota.waking
    const sessions = quota.snapshot().last.sessions
    assert.equal(sessions.main.wake, 'unavailable')
    assert.equal(sessions.demobook.wake, 'unavailable')
})

test('额度正常时：报来的用量变了才记下，额度窗口按类型记下（出口经核心的 quota.detail 读，执行方不通知谁）', async () => {
    const saves = []
    const time = clock(bj(20, 0))
    const quota = new QuotaGate({}, { save: record => { saves.push(record) }, ...time })
    await quota.load()
    quota.observeEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81, resetsAt: 1773153000 }, 'opus')
    await quota.writes
    quota.observeEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81, resetsAt: 1773153000 }, 'opus')
    await quota.writes
    assert.equal(saves.length, 1, '没变就不再写')
    assert.equal(quota.snapshot().windows.five_hour.utilization, 0.81)
    assert.equal(quota.snapshot().state, 'open')
})

test('恢复后不经模型作答的一轮（压缩命令、只取回自己开的轮）正常结束不算答过积压；把输入交给模型作答的才算', async () => {
    const { quota } = gate()
    await quota.load()
    quota.close({ resetsAt: 1773153000000 })
    quota.reject('main', { delivered: 1, sources: ['user'] })
    quota.recover('reset')
    quota.turnStarted('main', '/压缩')
    quota.turnFinished('main', true)
    assert.equal(quota.snapshot().last.sessions.main.answeredAt, null)
    quota.turnStarted('main', '在吗')
    quota.turnCarries('main')
    quota.turnFinished('main', true)
    assert.equal(quota.snapshot().last.sessions.main.wake, 'answered')
})

test('恢复后核对（原来 Watchdog 做的）：到 verifyMinutes 还没回过一轮的会话各报一条，写明唤醒到了哪一步；不唤醒的不报；后来回了再报"好了"；只报一次', async () => {
    const { quota, time, reports } = gate({ wake: async () => ({ status: 'unavailable', reason: 'NO_DELIVERY' }) })
    await quota.load()
    quota.close({ resetsAt: 1773153000000 })
    quota.reject('main', { pending: 2, sources: ['user'] })
    quota.reject('background-thinking', { pending: 1, sources: ['reflection'] })
    quota.recover('reset')
    await quota.waking
    await time.advance(14 * 60_000)
    assert.deepEqual(reports, [], '没到核对时间')
    await time.advance(60_000)
    assert.equal(reports.length, 1, '不唤醒的（后台思考）不报')
    const [first] = reports
    assert.equal(first.kind, WAKE_UNANSWERED)
    assert.equal(first.sessionId, 'main')
    assert.match(first.text, /中枢有 2 条输入积压，到现在还没回过一轮：唤醒的话交不出去/)
    const outageId = quota.snapshot().last.outageId
    assert.deepEqual(first.data, { subject: `${outageId}-main`, outageId, wake: 'unavailable' })
    assert.equal(typeof quota.snapshot().last.sessions.main.reportedAt, 'number')
    quota.verify()
    assert.equal(reports.length, 1, '报过的不重报')
    quota.turnStarted('main', '用户又说了一句')
    quota.turnCarries('main')
    quota.turnFinished('main', true)
    assert.equal(reports.length, 2)
    assert.deepEqual(reports[1].data, { subject: `${outageId}-main`, outageId, resolved: true })
})

test('恢复后核对跨重启：按记下的恢复时间算，已经过了就马上核对；重启前报过的不重报；都回过的不报', async () => {
    const recoveredAt = bj(21, 0)
    const ledger = { firstAt: bj(20, 50), lastAt: bj(20, 55), rejected: 1, delivered: 0, pending: 1, sources: ['user'], interrupted: [], wake: 'failed', wokeAt: bj(21, 1), answeredAt: null, attempts: 3 }
    const stored = {
        ...openState(),
        last: { outageId: 'qold', since: bj(20, 50), recoveredAt, via: 'reset', rateLimitType: 'five_hour', resetsAt: null, sessions: {
            main: { ...ledger },
            told: { ...ledger, reportedAt: bj(21, 15) },
            done: { ...ledger, wake: 'answered', answeredAt: bj(21, 2) },
        } },
    }
    const { quota, time, reports } = gate({ stored, start: bj(21, 30) })
    await quota.load()
    await time.advance(0)
    assert.deepEqual(reports.map(item => item.sessionId), ['main'])
    assert.match(reports[0].text, /不再自动唤醒/)
})
