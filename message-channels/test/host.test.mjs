/**
 * Host 生命周期测试。
 *
 * 用 development_fake 的 ctx（fake 域、fake sessionController/sessionQuery）跑
 * index.apply，runtime 用真实 createChannelRuntime 的无绑定初始化；平台工厂本身不联网。
 * 覆盖：启动不取默认渠道会话（零 session getter 副作用）、唤醒只认真实 turn/end；卸载落在
 * 初始化窗口内时 acquisition 收敛后才关域、租约最后释放；启动失败归还租约且错误保持可见。
 *
 * 平台工厂或 peer 包在本树里不可解析时明确 skip，而不是伪造覆盖。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireChannelLease } from '../lease.js'

const LEASE_DIRECTORY = 'galatea-channels'

/** 一条进程中断后待恢复的发送记录：runtime 初始化会把它改写成 unknown。 */
const SENDING_ROW = {
    bindingId: 'binding-1',
    sessionId: 'session-1',
    turn: 1,
    endSeq: 2,
    sourceSeqs: [1],
    inputRequestIds: ['request-1'],
    partIndex: 0,
    partCount: 1,
    text: 'hello',
    anchorKey: 'anchor-1',
    state: 'sending',
    receipt: null,
    errorCode: null,
}

const probe = await import('../index.js').then(
    (module) => ({ module: module }),
    (error) => ({ error: error }),
)
if (probe.error !== undefined && probe.error.code !== 'ERR_MODULE_NOT_FOUND') throw probe.error
const unavailable = probe.error === undefined
    ? null
    : '平台工厂或 peer 包在本树不可解析（ERR_MODULE_NOT_FOUND），Host 测试跳过'
const hostTest = unavailable === null
    ? test
    : (name, fn) => test(name, { skip: unavailable }, fn)

/** 官方 dshHomePath 读取 $DSH_HOME；测试把它指向自己的临时目录。 */
async function ownedHome(t) {
    const home = await mkdtemp(join(tmpdir(), 'channels-host-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    t.after(async () => {
        if (previous === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previous
        await rm(home, { recursive: true, force: true })
    })
    return home
}

/** runtime 的无绑定初始化只需要这些表的读写句柄。 */
function createFakeTable(name, events, options) {
    const records = new Map()
    if (name === 'outgoing' && options.sendingRow !== undefined) records.set('delivery-1', options.sendingRow)
    return {
        get(key) {
            events.push([`${name}.get`, key])
            return records.get(key)
        },
        entries() {
            events.push([`${name}.entries`])
            return [...records.entries()][Symbol.iterator]()
        },
        keys() {
            return [...records.keys()][Symbol.iterator]()
        },
        async put(key, value) {
            events.push([`${name}.put`, key])
            if (name === 'outgoing' && options.holdOutgoingPut !== undefined) await options.holdOutgoingPut()
            records.set(key, value)
            events.push([`${name}.put.done`, key])
        },
        update() {
            throw new Error(`unexpected call: ${name}.update must not be used by host tests without bindings`)
        },
        async delete(key) {
            return records.delete(key)
        },
        get size() {
            return records.size
        },
    }
}

function createFakeDomain(options = {}) {
    const events = options.events === undefined ? [] : options.events
    const tables = new Map()
    return {
        events: events,
        table(name) {
            // 官方 Domain 只接受 /^[a-z][a-z0-9_]*$/ 的表名：fake 同步这条约束，
            // 表名漂移（如 camel 键）在测试期就明确失败，而不是静默放行。
            if (!/^[a-z][a-z0-9_]*$/.test(name)) {
                throw new TypeError(`invalid domain table name: ${name}`)
            }
            if (!tables.has(name)) tables.set(name, createFakeTable(name, events, options))
            return tables.get(name)
        },
        async close() {
            events.push(['domain.close'])
            if (options.onClose !== undefined) await options.onClose()
        },
    }
}

function createFakeContext(options) {
    const effects = []
    const sessionHandlers = []
    const scheduleHooks = []
    const warnings = []
    // development_fake：默认会话由渠道自己 sessionController.create，本 fixture 只记次数与返回 id；
    // sessionQuery 记录每次观察的 id。
    const workCalls = { observes: [], create: 0 }
    /** 核心角色变化的订阅者（`core.sessions.on('changed')`）：测试按它们模拟换中枢。 */
    const roleListeners = []
    const context = {
        roleListeners,
        // 框架核心的替身：入口要向它声明出处。
        core: {
            provenance: { declare() {}, original: message => message.content },
            deliver: async () => ({ status: 'delivered', messageId: 'm' }),
            outcomeOf: async () => null,
            turnRoute: async () => null,
            declareSource: () => () => {},
            attach: async () => {},
            detach: async () => {},
            pending: () => false,
            exits: { register: () => () => {} },
            quietHours: { inQuiet: () => false, nextEnd: at => at, describe: () => '00:00–08:00（Asia/Shanghai）' },
            timezone: 'Asia/Shanghai',
            quota: { detail: async () => ({ state: 'unknown', since: null, resetsAt: null, window: null, outageId: null, windows: null }) },
            executors: { gatedFailure: async () => false },
            segments: [],
            segment(definition) {
                this.segments.push(definition)
                return () => {}
            },
            tool(definition, meta) {
                context.tools.register(definition)
                this.toolMetas.set(definition.name, meta)
                return () => {}
            },
            toolMetas: new Map(),
            caller: exec => ({ kind: 'session', sessionId: String(exec?.agent?.session?.id ?? ''), role: 'hub' }),
            sessions: {
                hub: () => options.hub ?? null,
                on: (event, listener) => {
                    if (event !== 'changed') throw new TypeError(event)
                    roleListeners.push(listener)
                    return () => roleListeners.splice(roleListeners.indexOf(listener), 1)
                },
            },
        },
        warnings: warnings,
        provides: new Map(),
        sessionHandlers: sessionHandlers,
        scheduleHooks: scheduleHooks,
        sessionController: {
            calls: workCalls,
            async create() {
                workCalls.create += 1
                return { sessionId: options.createdSessionId ?? 'channel-session' }
            },
            async prompt() {
                return { accepted: true }
            },
        },
        sessionQuery: {
            calls: workCalls,
            async observeSession(id) {
                workCalls.observes.push(id)
                throw new Error('this fixture keeps no main session')
            },
            async readSurface() {
                throw new Error('this fixture keeps no main session')
            },
        },
        sessions: {
            get() {
                return undefined
            },
            async flush() {
                return false
            },
        },
        storageDomain: {
            async open() {
                return options.domain
            },
        },
        credentials: {
            async readRecord() {
                return undefined
            },
            async modifyRecord() {},
            async deleteRecord() {},
        },
        tools: {
            registered: [],
            register(tool) {
                this.registered.push(tool)
                return () => {}
            },
        },
        systemPrompt: {
            contexts: [],
            context(entry) {
                this.contexts.push(entry)
                return () => {}
            },
        },
        logger: {
            warn(message) {
                warnings.push(String(message))
            },
        },
        effect(callback) {
            const dispose = callback()
            effects.push(dispose)
            return dispose
        },
        provide(name, value) {
            context.provides.set(name, value)
        },
        on(event, handler) {
            if (event === 'schedule/resolve-agent') scheduleHooks.push(handler)
            else sessionHandlers.push({ event: event, handler: handler })
            return () => {}
        },
        inject() {
            // 没有 browser host 提供 connection：条件 inject 一直等下去。
            return new Promise(() => {})
        },
        async dispose() {
            const failures = []
            for (const dispose of effects.splice(0).reverse()) {
                try {
                    await dispose()
                } catch (error) {
                    failures.push(error)
                }
            }
            if (failures.length > 0) throw failures[0]
        },
    }
    return context
}

const tick = (milliseconds = 10) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Poll for an effect that a Promise chain produces; no fixed sleeps in assertions. */
function waitFor(predicate, description) {
    return new Promise((resolve, reject) => {
        const started = Date.now()
        const poll = () => {
            let matched
            try {
                matched = predicate()
            } catch (error) {
                reject(error)
                return
            }
            if (matched) {
                resolve(matched)
                return
            }
            if (Date.now() - started > 2000) {
                reject(new Error(`timed out waiting for ${description}`))
                return
            }
            setTimeout(poll, 5)
        }
        poll()
    })
}

hostTest('没有 binding 时启动只订阅 turn/end，零 session getter 副作用', async (t) => {
    await ownedHome(t)
    const domain = createFakeDomain()
    const ctx = createFakeContext({ domain: domain })
    await probe.module.apply(ctx)
    await waitFor(() => ctx.sessionHandlers.length === 1, 'the wake handler')
    assert.equal(ctx.sessionHandlers[0].event, 'session/event')
    assert.equal(ctx.scheduleHooks.length, 0, '定时提醒不再经渠道转交：上游照常放进会话，回复按核心记下的去向发')
    assert.equal(ctx.warnings.some((message) => message.includes('wake disabled')), false)

    // 启动零副作用：没有 binding 时不 create 默认会话，也不核对任何会话、不建配对。
    assert.equal(ctx.sessionController.calls.create, 0)
    assert.deepEqual(ctx.sessionQuery.calls.observes, [])
    const status = ctx.provides.get('assistantChannels').status()
    assert.equal(status.counts.bindings, 0)
    for (const view of status.channels) {
        assert.equal(view.phase, 'idle')
        assert.equal(view.pairAttemptId, null)
    }

    // 启动时的首次对账会读一次表；等它结束再观察错误唤醒。
    await waitFor(
        () => domain.events.some((event) => Array.isArray(event) && event[0] === 'bindings.get'),
        'the startup reconcile',
    )
    await tick()
    domain.events.length = 0

    const handler = ctx.sessionHandlers[0].handler
    // turn/start、缺 Session 的事件、缺 type 的事件都不是回复时机。
    handler({ id: 'session-a' }, { type: 'turn/start' })
    handler(null, { type: 'turn/end' })
    handler({ id: 'session-a' }, null)
    handler({ id: '' }, { type: 'turn/end' })
    await tick()
    assert.deepEqual(domain.events, [])

    // 任意真实普通会话的 turn/end 都交给 runtime.wake(sessionId)，再由 binding 决定是否回复。
    handler({ id: 'session-a' }, { type: 'turn/end' })
    await waitFor(
        () => domain.events.some((event) => Array.isArray(event) && event[0] === 'bindings.get'),
        'the wake reconcile',
    )
    assert.equal(ctx.sessionController.calls.create, 0, '唤醒路径不创建也不重选默认会话')
    await ctx.dispose()
})

hostTest('三个工具经核心注册，谁能用照声明：转交给中枢、工作会话、后台会话；群绑定只给中枢；中途发送给中枢、接群会话和能写的外部调用方', async (t) => {
    await ownedHome(t)
    const ctx = createFakeContext({ domain: createFakeDomain() })
    await probe.module.apply(ctx)
    const metas = ctx.core.toolMetas
    assert.deepEqual([...metas.keys()].sort(), ['assistant_channel_group', 'assistant_channel_send', 'assistant_session_send'])
    for (const meta of metas.values()) assert.equal(meta.effect, 'write')
    const session = (role, sessionId = `s-${role}`) => ({ kind: 'session', sessionId, role })
    const allows = (name, who) => metas.get(name).allow(who)
    assert.deepEqual(['hub', 'worker', 'background', null, 'external'].map(role => allows('assistant_session_send', session(role))), [true, true, true, false, false])
    assert.equal(allows('assistant_session_send', { kind: 'external', name: 'dev', readOnly: false }), false)
    assert.deepEqual(['hub', 'worker', 'background'].map(role => allows('assistant_channel_group', session(role))), [true, false, false])
    assert.equal(allows('assistant_channel_send', session('hub')), true)
    assert.equal(allows('assistant_channel_send', session('worker')), false, '没接群的工作会话不行')
    assert.equal(allows('assistant_channel_send', { kind: 'external', name: 'dev', readOnly: false }), true, '外部调用方按中枢的范围')
    assert.equal(allows('assistant_channel_send', { kind: 'external', name: 'dev', readOnly: true }), false, '只读的外部调用方不能发')
    assert.equal(ctx.tools.registered.length, 3, '照样经上游注册')
    assert.deepEqual(ctx.core.segments.map(item => [item.name, item.audience]), [['galatea-channels-wait', 'opening']], '等待约定改由核心的段交')
    await ctx.dispose()
})

hostTest('换了中枢（核心的角色变化涉及中枢）就马上对一次账；别的角色变化不对账（渠道没有按时跑的对账，只能靠它）', async (t) => {
    await ownedHome(t)
    const domain = createFakeDomain()
    const ctx = createFakeContext({ domain: domain })
    await probe.module.apply(ctx)
    await waitFor(() => ctx.roleListeners.length === 1, '订阅了角色变化')
    const reconciled = () => domain.events.some((event) => Array.isArray(event) && event[0] === 'bindings.get')
    await waitFor(reconciled, 'the startup reconcile')
    await tick()
    domain.events.length = 0
    ctx.roleListeners[0]({ sessionId: 'task-1', from: null, to: 'worker' })
    await tick()
    assert.equal(reconciled(), false, '别的角色变化不对账')
    ctx.roleListeners[0]({ sessionId: 'hub-2', from: null, to: 'hub' })
    await waitFor(reconciled, '换了中枢就对账')
    await ctx.dispose()
    assert.equal(ctx.roleListeners.length, 0, '卸载时退订')
})

hostTest('无 binding 的启动不创建默认 Session/Agent：状态恒为 idle 且无配对尝试', async (t) => {
    await ownedHome(t)
    const ctx = createFakeContext({
        domain: createFakeDomain(),
        // 即使 create 随时可用，空状态启动也不得调用它。
        createdSessionId: 'channel-session',
    })
    await probe.module.apply(ctx)
    assert.equal(ctx.provides.has('assistantChannels'), true)
    assert.equal(ctx.sessionController.calls.create, 0)
    assert.deepEqual(ctx.sessionQuery.calls.observes, [])
    assert.equal(ctx.sessionHandlers.length, 1)
    assert.equal(ctx.warnings.some((message) => message.includes('wake disabled')), false)
    const status = ctx.provides.get('assistantChannels').status()
    assert.equal(status.phase, 'idle')
    assert.equal(status.counts.bindings, 0)
    await ctx.dispose()
})

hostTest('没有配对就不 create 默认会话：订阅照常建立', async (t) => {
    await ownedHome(t)
    const ctx = createFakeContext({
        domain: createFakeDomain(),
        createdSessionId: 'not-a-session-id',
    })
    await probe.module.apply(ctx)
    await waitFor(() => ctx.sessionHandlers.length === 1, 'the wake handler')
    assert.equal(ctx.provides.has('assistantChannels'), true)
    assert.equal(ctx.sessionController.calls.create, 0, '没有配对就不建默认会话')
    assert.deepEqual(ctx.sessionQuery.calls.observes, [])
    await ctx.dispose()
})

hostTest('unload closes the real runtime before the domain and releases the lease last', async (t) => {
    const home = await ownedHome(t)
    const leaseRoot = join(home, LEASE_DIRECTORY)
    const seen = []
    let ctx
    const domain = createFakeDomain({
        onClose: async () => {
            const runtime = ctx.provides.get('assistantChannels')
            seen.push(['runtime-phase-at-domain-close', runtime.status().phase])
            await assert.rejects(acquireChannelLease(leaseRoot), (error) => {
                seen.push(['lease-at-domain-close', error.code])
                return error.code === 'CHANNEL_OWNER_UNAVAILABLE'
            })
        },
    })
    ctx = createFakeContext({ domain: domain })

    await probe.module.apply(ctx)
    assert.equal(ctx.provides.has('assistantChannels'), true)

    await ctx.dispose()
    assert.deepEqual(seen, [
        ['runtime-phase-at-domain-close', 'closed'],
        ['lease-at-domain-close', 'CHANNEL_OWNER_UNAVAILABLE'],
    ])

    const next = await acquireChannelLease(leaseRoot)
    await next.release()
})

hostTest('an unload during runtime initialization drains it, publishes nothing, and releases the lease last', async (t) => {
    const home = await ownedHome(t)
    const leaseRoot = join(home, LEASE_DIRECTORY)
    const events = []
    let startPut
    const putStarted = new Promise((resolve) => {
        startPut = resolve
    })
    let finishPut
    const putReleased = new Promise((resolve) => {
        finishPut = resolve
    })
    const domain = createFakeDomain({
        events: events,
        sendingRow: SENDING_ROW,
        holdOutgoingPut: async () => {
            events.push('init-held')
            startPut()
            await putReleased
            events.push('init-settled')
        },
        onClose: async () => {
            events.push('domain-close')
            await assert.rejects(acquireChannelLease(leaseRoot), (error) => error.code === 'CHANNEL_OWNER_UNAVAILABLE')
        },
    })
    const ctx = createFakeContext({ domain: domain })

    const applying = probe.module.apply(ctx)
    await putStarted
    const closing = ctx.dispose()
    await tick()

    // acquisition 未收敛前：服务不发布，域也不关。
    assert.equal(ctx.provides.has('assistantChannels'), false)
    assert.equal(events.includes('domain-close'), false)

    finishPut()
    await applying
    await closing

    assert.equal(ctx.provides.has('assistantChannels'), false)
    assert.equal(events.indexOf('init-settled') < events.indexOf('domain-close'), true)

    const next = await acquireChannelLease(leaseRoot)
    await next.release()
})

hostTest('a failed startup still releases the lease and keeps the failure visible', async (t) => {
    const home = await ownedHome(t)
    const leaseRoot = join(home, LEASE_DIRECTORY)
    const failure = new Error('storage unavailable')
    failure.code = 'STORAGE_UNAVAILABLE'
    const ctx = createFakeContext({ domain: createFakeDomain() })
    ctx.storageDomain = {
        async open() {
            throw failure
        },
    }

    await assert.rejects(probe.module.apply(ctx), (error) => error === failure)

    // 租约已经还回去，下一次加载能重新取得。
    const next = await acquireChannelLease(leaseRoot)
    await next.release()
    await ctx.dispose()
})
