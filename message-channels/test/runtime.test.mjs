/**
 * 渠道运行态行为测试（development_fake）
 *
 * 使用明确 fake 的持久 KV、credentials、平台回调与 native cut，不发起任何真实网络、
 * 模型或 Agent 调用。断言聚焦：批游标顺序、重复/冲突输入、真实 native 引用、
 * 精确 batch 回话、unknown 不重发、崩溃 sending 恢复、凭据不泄露、会话归属/半配对、
 * 配对提交窗口取消、空 contextToken、close 等待晚 send/held ingress、status 投影，
 * 以及关闭单调、已准入后的异文冲突、最后发送窗口、同 deliveryId payload 不可变、
 * outgoing 投递 key 的官方 path-safe 合同（真实回复可落盘、sent 后重开不重发）、
 * Domain 写槽内的 exact 更新与断开/后续配对的平台链收敛。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { GROUP_NOTICES, createChannelRuntime, downNoticeOf, channelTableSchemas, ChannelRuntimeError, pushEntryOf } from '../runtime.js'
import { NO_TEXT_NOTE, extractReplyBatches, incomingFingerprintOf, splitReplyText } from '../replies.js'
import { createMainTextIngress } from '../channel-ingress.js'
import { withoutAnnotation as original } from '../../framework/core/classify.js'
import { outcomeFromEvents } from '../../framework/core/outcome.js'
import { TURN_ROUTE_RECORD, routeFromEvents } from '../../framework/core/routes.js'
import { createQuietHours } from '../../framework/core/quiet.js'
import { QQ_DELIVERY } from '../platforms/qq.js'
import { WEIXIN_DELIVERY } from '../platforms/weixin.js'

const SESSION_ID = 'session-main-1'
const SCOPE = 'galatea-channels'
/** 渠道默认工作目录（fixture）：与 createHarness 传给 runtime 的 defaultCwd 一致。 */
const CHANNEL_CWD = process.platform === 'win32'
    ? 'C:/dsh-fixtures/channel-workspace'
    : '/dsh-fixtures/channel-workspace'
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

function flush() {
    return new Promise(resolve => setImmediate(resolve))
}

function deferred() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

/**
 * 官方 session-query 的 not-found 错误形状：类名与 code 与真实 API 一致，供运行态按官方
 * code 判 absence（绝不按 message 文本推状态）。
 */
function sessionQueryNotFound(sessionId) {
    const error = new Error(`session-query: session ${sessionId} was not found`)
    error.name = 'SessionQueryError'
    error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
    return error
}

/**
 * 官方 per-record 存储的 record key 合同（storage-json/src/per-record-unit.ts 的 SAFE_KEY_RE）：
 * 只接受 `/^[a-zA-Z0-9_-]+$/`；development_fake 写入遵循同一合同。
 */
const PATH_SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/** 写入前按官方 key 合同校验（development_fake 的显式断言，不是生产校验）。 */
function assertPathSafeKey(table, key) {
    assert.equal(typeof key, 'string', `表 ${table} 的 key 必须是字符串`)
    assert.match(key, PATH_SAFE_KEY_RE, `表 ${table} 的 key 必须符合官方 path-safe 合同`)
}

/**
 * development_fake 持久 KV：get/entries 同步；put/delete/update 在同一条写队列上异步提交，
 * update 的 mutate 在写槽里看到最新 current（与公开 Domain 契约一致），缺失 key 在写槽内
 * reject code='missing-key'。每次写入前先按官方 path-safe key 合同校验，再按公开 schema 校验。
 */
function createTables() {
    const maps = { bindings: new Map(), incoming: new Map(), outgoing: new Map(), channel_default: new Map(), main_turns: new Map() }
    const ops = []
    const hooks = { beforePut: null }
    /** 单条队列：同一 Domain 的所有表共享提交顺序。 */
    let queue = Promise.resolve()
    function enqueue(job) {
        const started = queue.then(job)
        queue = started.then(() => undefined, () => undefined)
        return started
    }
    const domain = {
        name: 'channel_test',
        table(name) {
            const map = maps[name]
            const schema = channelTableSchemas[name]
            if (map === undefined || schema === undefined) throw new Error(`未声明表 ${name}`)
            const commit = async (key, value) => {
                assertPathSafeKey(name, key)
                if (typeof hooks.beforePut === 'function') await hooks.beforePut(name, key, value)
                map.set(key, value)
                ops.push({ op: 'put', table: name, key, value })
                return value
            }
            return {
                get: key => map.get(key),
                entries: () => [...map.entries()][Symbol.iterator](),
                keys: () => [...map.keys()][Symbol.iterator](),
                get size() {
                    return map.size
                },
                put: (key, value) => {
                    const parsed = schema.parse(value)
                    return enqueue(() => commit(key, parsed))
                },
                delete: key => enqueue(async () => {
                    assertPathSafeKey(name, key)
                    const existed = map.delete(key)
                    if (existed) ops.push({ op: 'delete', table: name, key })
                    return existed
                }),
                update: (key, mutate) => enqueue(async () => {
                    // 与公开 Domain 一致：key 是否存在、current 取值都在写槽内判定。
                    if (!map.has(key)) {
                        const error = new Error(`表 ${name} 没有可更新的记录 '${key}'`)
                        error.name = 'DomainError'
                        error.code = 'missing-key'
                        throw error
                    }
                    return commit(key, schema.parse(mutate(map.get(key))))
                }),
            }
        },
        close: async () => {
            throw new Error('domain 由 Host 在 runtime.close 之后关闭')
        },
    }
    return { domain, maps, ops, hooks }
}

/** development_fake credentials：只保存 grant record；beforeRead 供挂住真实读取窗口。 */
function createCredentials() {
    const records = new Map()
    const hooks = { beforeRead: null }
    return {
        records,
        hooks,
        readRecord: async key => {
            if (typeof hooks.beforeRead === 'function') await hooks.beforeRead(key)
            return records.get(key)
        },
        modifyRecord: async (key, mutate) => {
            const next = await mutate(records.get(key))
            if (next === undefined) return records.get(key)
            records.set(key, next)
            return next
        },
        deleteRecord: async key => {
            records.delete(key)
        },
    }
}

/**
 * 像框架核心一样给输入写出处：渠道准入的带 `via`（用户本人说的是 user，渠道自己放进来的是渠道插件），
 * 外部调用方经外部入口说的是外部调用方，其余带请求号的是用户本人在桌面上说的。
 */
function stampedSource(rpcId) {
    const via = { exit: 'qq', label: 'QQ 私聊' }
    if (rpcId.startsWith('channel-relay:1:')) return { kind: 'user', rpcId, speaker: { kind: 'program', plugin: 'message-channels-framework' }, via }
    if (rpcId.startsWith('channel-ingress:1:') || rpcId.startsWith('req-')) return { kind: 'user', rpcId, speaker: { kind: 'user' }, via }
    if (rpcId.startsWith('external:')) return { kind: 'user', rpcId, speaker: { kind: 'external', name: 'dev' } }
    return { kind: 'user', rpcId, speaker: { kind: 'user' } }
}

/**
 * development_fake native cut：真实 observation 形状（source/header/events/cursor + 可释放租约）。
 * 回合输入必须来自真实 agent/inbox/spliced 原件，user/message 只引用该原件的 id/rpcId。
 */
function createChatSession(sessionId = SESSION_ID) {
    const state = {
        header: { id: sessionId },
        instance: null,
        events: [],
        surfaceEvents: [],
        spliced: new Map(),
        flushResult: true,
        flushCalls: 0,
        capturedThroughSeqOverride: null,
        disposeCalls: 0,
        /** readSurface 调用次数：用来证明某个会话的回复根本没有被读取。 */
        readSurfaceCalls: 0,
    }
    // 公开 Session.seq 是“下一条 event 序号”（随 events.length 变化），不造静态万能值。
    state.instance = {
        header: state.header,
        get seq() {
            return state.events.length
        },
    }

    function append(type, data) {
        const seq = state.events.length
        const event = { type, seq, time: 1000 + seq, data }
        if (SURFACE_TYPES.has(type)) event.surfaceOp = 'append'
        state.events.push(event)
        if (SURFACE_TYPES.has(type)) state.surfaceEvents.push(event)
        return event
    }

    function cursor() {
        return state.events.length === 0 ? -1 : state.events[state.events.length - 1].seq
    }

    let nextTurn = 0
    return {
        state,
        append,
        cursor,
        /** 真实 Inbox 插入：返回原生 message id 与该插入事件的 seq。 */
        appendSpliced(messageId, requestId, text) {
            const message = {
                id: messageId,
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'user', rpcId: requestId },
            }
            const event = append('agent/inbox/spliced', { inserted: [message] })
            state.spliced.set(requestId, { id: messageId, seq: event.seq, text })
            return { id: messageId, seq: event.seq }
        },
        spliceOf(requestId) {
            return state.spliced.get(requestId)
        },
        /**
         * 追加一个真实结构回合：spliced → turn/start → user/message → model → turn/end。
         * `route` 给了就在这一轮开头写一条核心记下的回复去向（和真核心写的插件记录同形）。
         */
        addTurn(options = {}) {
            const { inputs = [], assistants = [], presented = [], endKind = 'completed', route, trigger = null } = options
            const turn = nextTurn
            nextTurn += 1
            append('turn/start', { turn })
            if (route !== undefined) {
                const seq = state.events.length
                state.events.push({ type: TURN_ROUTE_RECORD, ignorable: true, seq, time: 1000 + seq, data: { turn, trigger, route } })
            }
            for (const input of inputs) {
                const spliced = state.spliced.get(input.rpcId)
                const id = spliced === undefined ? `desktop-${turn}-${input.rpcId}` : spliced.id
                append('user/message', {
                    id,
                    role: 'user',
                    content: [{ type: 'text', text: input.text ?? (spliced === undefined ? '输入' : spliced.text) }],
                    source: input.source ?? stampedSource(input.rpcId),
                })
            }
            let step = 1
            for (const assistant of assistants) {
                append('assistant/message', {
                    turn,
                    step,
                    message: {
                        id: `asst-${turn}-${step}`,
                        role: 'assistant',
                        source: { kind: 'model' },
                        content: assistant.blocks ?? [{ type: 'text', text: assistant.text, source: { kind: 'model' } }],
                    },
                    stream: [],
                    ...(assistant.interrupted === true ? { interrupted: true } : {}),
                })
                step += 1
            }
            if (presented.length > 0) {
                append('deliverables/presented', { turn, callId: `call-present-${turn}`, files: presented.map(path => ({ path })) })
            }
            const end = append('turn/end', { turn, reason: { kind: endKind } })
            return { turn, endSeq: end.seq }
        },
    }
}

/**
 * 登记进来的测试平台 chat 的发送能力：连着就能主动发，没有次数与窗口；发文字、图片、文件，不发语音（语音按音频文件发）。
 * 发送节奏（`paceMs`）是固定的：第一片 1 秒，之后每片 6 秒，测试按它核对运行态在哪里等。
 */
const CHAT_DELIVERY = Object.freeze({
    sends: Object.freeze(['text', 'image', 'file']),
    canDeliverNow: ({ live }) => live === true,
})
const CHAT_PACE = Object.freeze({ first: 1000, next: 6000 })
const CHAT_LABEL = '测试聊天'

/** development_fake 平台：pair/listen/send 都由测试驱动。 */
function createFakePlatform(name) {
    const state = {
        pairImpl: async () => [],
        sendImpl: async () => ({ kind: 'platform-accepted', platformMessageId: `pm-${name}`, clientId: `cl-${name}` }),
        /** 可挂住 listen 结束时机（测试用）；读时取值，默认 null 即立即结束。 */
        holdStop: null,
        listens: [],
        sends: [],
        pairCalls: 0,
        /** 平台上的群（`groupList`）；null 表示查不了（没连上）。 */
        groupList: null,
    }
    // 发送能力取真实平台的声明（测试可以换掉）：运行态只按能力选路。chat 是登记进来的测试平台（像经手机转发的聊天软件）。
    const delivery = { qq: QQ_DELIVERY, weixin: WEIXIN_DELIVERY, chat: CHAT_DELIVERY }[name] ?? {}
    const platform = {
        ...delivery,
        async pair(options) {
            state.pairCalls += 1
            return state.pairImpl(options)
        },
        listen(options) {
            state.listens.push(options)
            return new Promise((resolve, reject) => {
                // 测试弄断这条连接：listen 以错误结束，运行态按断开处理并重连。
                state.drop = error => reject(error ?? Object.assign(new Error('connection lost'), { code: 'NETWORK' }))
                if (state.listenDown === true) {
                    setImmediate(() => reject(Object.assign(new Error('cannot connect'), { code: 'NETWORK' })))
                    return
                }
                const done = () => {
                    const hold = state.holdStop
                    if (hold === null) {
                        resolve()
                        return
                    }
                    Promise.resolve(hold()).then(resolve, resolve)
                }
                if (options.signal.aborted) {
                    done()
                    return
                }
                options.signal.addEventListener('abort', done, { once: true })
                setImmediate(() => {
                    if (!options.signal.aborted) options.onReady()
                })
            })
        },
        async send(request) {
            state.sends.push(request)
            return state.sendImpl(request)
        },
        // 只有 chat 支持群、有发送节奏（运行态按有没有 groupList、paceMs 认）。
        ...name === 'chat' ? {
            paceMs: part => (part.partIndex === 0 ? CHAT_PACE.first : CHAT_PACE.next),
            async groupList() {
                if (state.groupList === null) throw Object.assign(new Error('the phone bridge is not connected'), { code: 'NO_CONNECTION', notSent: true })
                return state.groupList
            },
        } : {},
    }
    return { platform, state }
}

/**
 * 预置一条绑定与它的授权。测试自选形状合法的 key；生产 key 由 runtime 用
 * 官方 credentialKey builder 生成，测试另在配对用例里断言其真实形状。
 */
async function seedBinding(tables, credentials, options) {
    const {
        platform = 'qq',
        accountId = 'account-1',
        senderId = 'owner-1',
        cursor,
        enabled = true,
        sessionId = SESSION_ID,
        bindingId = randomUUID(),
        credential = { cookie: `secret-${platform}` },
    } = options
    const conversationId = senderId
    const key = credentialKey(SCOPE, `account-seed-${platform}`)
    await credentials.modifyRecord(key, async () => ({
        kind: 'grant',
        payload: { bindingId, platform, accountId, senderId, conversationId, credential },
    }))
    const binding = {
        platform,
        bindingId,
        accountId,
        senderId,
        conversationId,
        sessionId,
        credentialKey: key,
        enabled,
        ...cursor === undefined ? {} : { cursor },
        createdAt: 1,
    }
    await tables.domain.table('bindings').put(platform, binding)
    return { binding, credentialKey: key }
}

/**
 * 框架核心的替身：记下入口声明的出处和经 deliver 放进会话的话；去来源标注、一轮的结果、回复去向用核心真的那几份规则，
 * 从假会话的事件里读。核心装上以后每一轮都有去向记录：事件里没有记录的轮按 `defaultRoute`（默认 `{to:'origin'}`；
 * 给 `null` 就和核心装上以前的轮一样，没有记录）。
 * @param eventsOf - 取一个假会话的事件。
 */
function fakeCore(eventsOf = () => [], { defaultRoute = { to: 'origin' }, deliver, hub = SESSION_ID, timezone = 'Asia/Shanghai' } = {}) {
    const declared = []
    const delivered = []
    const reports = []
    const roles = { hub }
    /** 附提醒：`会话\u0000键` → { text, onTaken }。 */
    const attached = new Map()
    const core = {
        declared,
        delivered,
        reports,
        attached,
        attach(sessionId, key, text, { onTaken } = {}) {
            attached.set(`${sessionId}\u0000${key}`, { sessionId, key, text, onTaken })
        },
        detach(sessionId, key) {
            attached.delete(`${sessionId}\u0000${key}`)
        },
        pending(sessionId, key) {
            return attached.has(`${sessionId}\u0000${key}`)
        },
        /** 这个会话还没交到的附提醒正文。 */
        noticeOf(sessionId, key = 'channel-notice') {
            return attached.get(`${sessionId}\u0000${key}`)?.text ?? null
        },
        /** 模拟这个会话的一轮正常结束、模型跑过：附提醒都交到了（`restart` 时不调回调，像重启后回调已经没了）。 */
        takeNotices(sessionId, { restart = false } = {}) {
            for (const [id, item] of [...attached]) {
                if (item.sessionId !== sessionId) continue
                attached.delete(id)
                if (!restart) item.onTaken?.()
            }
        },
        quietHours: createQuietHours({ start: '00:00', end: '08:00', timezone: 'Asia/Shanghai' }),
        /** 给人看的时间用的时区（核心的 `core.timezone`）；测试可以换。 */
        timezone,
        /** 额度现状（核心 `quota.detail` 的形状）；测试里改 `quotaDetail`。 */
        quotaDetail: { state: 'ok', since: null, resetsAt: null, window: null, outageId: null, windows: null },
        quota: { async detail() { return core.quotaDetail } },
        executors: { gatedFailure: async (sessionId, code) => code === 'USAGE_LIMIT' },
        /** 中枢（私聊绑定接的会话）；测试里换中枢就改 `core.sessions.setHub`。 */
        sessions: { hub: () => roles.hub, setHub: (id) => { roles.hub = id } },
        provenance: { original, declare: (requestId, declaration) => { declared.push({ requestId, declaration }) } },
        async deliver(sessionId, message) {
            if (delivered.some(item => item.sessionId === sessionId && item.key === message.key)) return { status: 'duplicate' }
            const result = deliver === undefined ? { status: 'delivered', messageId: `delivered-${delivered.length + 1}` } : await deliver(sessionId, message)
            if (result.status === 'delivered') delivered.push({ sessionId, ...message })
            return result
        },
        async outcomeOf(sessionId, turn) {
            return outcomeFromEvents(eventsOf(sessionId), turn)
        },
        async turnRoute(sessionId, turn) {
            return routeFromEvents(eventsOf(sessionId), turn) ?? (defaultRoute === null ? null : { turn, trigger: null, route: defaultRoute })
        },
        report(kind, detail) {
            reports.push({ kind, ...detail })
        },
    }
    return core
}

async function createHarness(options = {}) {
    // 重开用例可复用同一份持久表与凭据：证明重启后按已保存的同一份关联核对，不重建会话。
    const tables = options.tables ?? createTables()
    const credentials = options.credentials ?? createCredentials()
    // 重开用例可复用同一个会话（事件都在），模拟 DSH 重启后会话还在、渠道运行态重新起来。
    const chat = options.chat ?? createChatSession()
    // fixture 登记的普通会话：默认只有 SESSION_ID。A/B 用例可显式登记第二个目标会话；
    // 未登记的 id 一律失败，保持“不得触碰非归属会话”的强度。
    const chats = new Map([[SESSION_ID, chat]])
    for (const fixture of options.extraChats ?? []) {
        const id = fixture.state.header.id
        assert.ok(!chats.has(id), `fixture 会话 ${id} 重复登记`)
        chats.set(id, fixture)
    }
    const chatOf = id => {
        const fixture = chats.get(id)
        assert.ok(fixture !== undefined, `fixture 未登记会话 ${id}`)
        return fixture
    }
    /** 用例中途登记一个真实存在的普通会话（例如 runtime 自己预留的默认会话 id）。 */
    const registerChat = id => {
        assert.ok(!chats.has(id), `fixture 会话 ${id} 重复登记`)
        const fixture = createChatSession(id)
        chats.set(id, fixture)
        return fixture
    }
    const qq = createFakePlatform('qq')
    const weixin = createFakePlatform('weixin')
    const account = createFakePlatform('chat')
    const ingressLog = { created: [], admits: [], closes: [] }
    const splice = (platformMessageId, text) => chat.appendSpliced(
        `native-${platformMessageId}`,
        `req-${platformMessageId}`,
        text,
    )
    const admitImpl = options.admit ?? (async (message, binding, spliceOne) => {
        const original = spliceOne(message.messageId, message.text)
        return {
            status: 'accepted',
            sessionId: SESSION_ID,
            requestId: `req-${message.messageId}`,
            messageId: original.id,
            seq: original.seq,
        }
    })
    const createIngress = options.createIngress ?? ((hostContext, binding) => {
        const pending = new Set()
        let closed = false
        const handle = {
            binding,
            isClosed: () => closed,
            admit(message) {
                if (closed) {
                    return Promise.reject(new ChannelRuntimeError('INGRESS_CLOSED', 'ingress 已关闭，不再接受准入'))
                }
                ingressLog.admits.push({ binding, message })
                return new Promise((resolve, reject) => {
                    const entry = { reject }
                    pending.add(entry)
                    Promise.resolve()
                        .then(() => admitImpl(message, binding, splice))
                        .then(
                            value => {
                                pending.delete(entry)
                                resolve(value)
                            },
                            error => {
                                pending.delete(entry)
                                reject(error)
                            },
                        )
                })
            },
            async close() {
                if (!closed) {
                    closed = true
                    ingressLog.closes.push(binding)
                    // 真实 helper 会 abort 自己的准入信号：被阻塞的 admit 立即失败。
                    for (const entry of pending) {
                        entry.reject(new ChannelRuntimeError('INGRESS_CLOSED', 'ingress 已关闭，不再接受准入'))
                    }
                    pending.clear()
                }
                if (typeof options.closeIngress === 'function') await options.closeIngress(binding)
            },
        }
        ingressLog.created.push(handle)
        return handle
    })
    // development_fake：默认会话由渠道自己 create 一次；createImpl 只在首次配对时被调用，
    // 可返回与请求不同的 id。会话是否存在只由官方 observeSession 给出：fixture 登记的会话
    // 可观察，未登记的抛官方 not-found。sessionImpl 可选地改写某个 id 的观察事实：
    // 回 null 表示该会话已消失（not-found），回 {sessionId} 异 id 表示观察到的 header 不是它。
    const createImpl = options.create ?? options.channelSession ?? (async () => ({ sessionId: SESSION_ID }))
    const sessionImpl = options.session
    const hostCalls = { create: 0, createRequests: [] }
    const sessionController = {
        calls: hostCalls,
        async create(request) {
            hostCalls.create += 1
            hostCalls.createRequests.push(request)
            return createImpl(request)
        },
        async prompt() {
            return { accepted: true }
        },
    }
    const sessionQuery = {
        async observeSession(id) {
            // 官方 observeSession 对不存在的会话抛 SessionQueryError not-found：这里按真实 API 形状
            // 构造，运行态只能按官方 code 判 absence，不能把任意异常当“还没有这条会话”。
            const fixture = chats.get(id)
            if (fixture === undefined) throw sessionQueryNotFound(id)
            const fact = sessionImpl === undefined ? { sessionId: id } : await sessionImpl(id)
            if (fact === null) throw sessionQueryNotFound(id)
            fixture.state.observeCalls = (fixture.state.observeCalls ?? 0) + 1
            const events = fixture.state.events.slice()
            return {
                source: 'live',
                header: fact.sessionId === id ? fixture.state.header : { ...fixture.state.header, id: fact.sessionId },
                inheritedEventCount: 0,
                events,
                cursor: events.length === 0 ? -1 : events[events.length - 1].seq,
                [Symbol.dispose]: () => {
                    fixture.state.disposeCalls += 1
                },
            }
        },
        async readSurface(id) {
            const fixture = chatOf(id)
            fixture.state.readSurfaceCalls += 1
            return {
                session: { id: fixture.state.header.id },
                capturedThroughSeq: fixture.state.capturedThroughSeqOverride ?? fixture.cursor(),
                events: fixture.state.surfaceEvents.slice(),
            }
        },
    }
    const sessions = {
        get: id => chats.get(id)?.state.instance,
        flush: async instance => {
            const fixture = [...chats.values()].find(item => item.state.instance === instance)
            if (fixture === undefined) return false
            fixture.state.flushCalls += 1
            return fixture.state.flushResult
        },
    }
    if (options.seed !== undefined) await options.seed({ tables, credentials })
    const core = options.core ?? fakeCore(id => chats.get(id)?.state.events ?? [], options.fakeCore)
    let clock = 1000
    const runtime = await createChannelRuntime(
        { sessionController, sessionQuery, sessions, credentials, core },
        {
            platforms: { qq: qq.platform, weixin: weixin.platform },
            createIngress,
            domain: tables.domain,
            // 渠道自己持有的绝对默认工作目录（fixture）：不依赖 process.cwd()。
            defaultCwd: process.platform === 'win32' ? 'C:/dsh-fixtures/channel-workspace' : '/dsh-fixtures/channel-workspace',
            now: () => (clock += 1),
            sleep: async () => {},
            // 回复先后与改道说明：先走 chat，其次微信；没走 chat 时开头注明。
            replyOrder: ['chat', 'weixin'],
            rerouteNote: true,
            ...options.runtime,
        },
    )
    // 测试平台 chat 只在用例要求时登记，走和外部插件一样的 registerPlatform。
    const unregister = options.account === true ? runtime.registerPlatform({ id: 'chat', label: CHAT_LABEL, platform: options.accountPlatform ?? account.platform }) : null
    return {
        /** 推进假时钟，用于合并等待。 */
        advance: milliseconds => {
            clock += milliseconds
        },
        runtime, tables, credentials, chat, qq, weixin, account, ingressLog, core,
        sessionController, sessionQuery, sessions, hostCalls, registerChat, unregister,
    }
}

/** 让初始 wake、onReady 与其触发的合并 wake 全部跑完。 */
async function settle(runtime) {
    await runtime.wake()
    await flush()
    await runtime.wake()
    await flush()
}

/** 轮询到条件成立；只用事件循环让路，不引入真实时间等待。 */
async function waitFor(predicate, label) {
    for (let index = 0; index < 80; index += 1) {
        if (predicate()) return
        await flush()
    }
    assert.fail(`等待超时：${label}`)
}

/**
 * sending 意图持久之后，发送前最后的 source cut 读完 surface，随后的第一次 observeSession
 * 就是最终 owner 观察。onOwnerObserve 在那一刻被调用一次。
 */
function onFinalOwnerObserve(harness, onOwnerObserve) {
    const phase = { value: 'idle' }
    const readSurface = harness.sessionQuery.readSurface
    harness.sessionQuery.readSurface = async (id, ...rest) => {
        const surface = await readSurface(id, ...rest)
        if (phase.value === 'sending') phase.value = 'cut-read'
        return surface
    }
    const observe = harness.sessionQuery.observeSession
    harness.sessionQuery.observeSession = async (id, observeOptions) => {
        if (phase.value !== 'cut-read') return observe(id, observeOptions)
        phase.value = 'done'
        return onOwnerObserve(() => observe(id, observeOptions))
    }
    const realBeforePut = harness.tables.hooks.beforePut
    harness.tables.hooks.beforePut = async (table, key, value) => {
        if (typeof realBeforePut === 'function') await realBeforePut(table, key, value)
        if (table !== 'outgoing' || value.state !== 'sending') return
        if (phase.value === 'idle') phase.value = 'sending'
    }
}

/**
 * 把发送最后一步的 owner 观察挂住；放行后若设置了 state.headerId，观察到的 header 就是那个 id。
 */
function armFinalOwnerGate(harness) {
    const gate = deferred()
    const state = { held: false, headerId: undefined }
    onFinalOwnerObserve(harness, async observe => {
        const observation = await observe()
        state.held = true
        await gate.promise
        if (state.headerId === undefined) return observation
        return { ...observation, header: { ...observation.header, id: state.headerId } }
    })
    return { gate, state }
}

function listenOptions(state) {
    const options = state.listens[state.listens.length - 1]
    assert.ok(options !== undefined, '平台应已开始 listen')
    return options
}

function channel(harness, platform) {
    const view = harness.runtime.status().channels.find(item => item.platform === platform)
    assert.ok(view !== undefined, `status.channels 应包含 ${platform}`)
    return view
}

function incomingRows(harness) {
    return [...harness.tables.maps.incoming.entries()]
}

function outgoingRows(harness) {
    return [...harness.tables.maps.outgoing.values()]
}

function anchorOf(messageId, extra) {
    return { messageId, ...extra }
}

test('微信：批内 receive 全部持久后才推进游标，binding 游标取平台原值', async (t) => {
    const admission = deferred()
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' }),
        admit: async (message, binding, spliceOne) => {
            await admission.promise
            const original = spliceOne(message.messageId, message.text)
            return {
                status: 'accepted',
                sessionId: SESSION_ID,
                requestId: `req-${message.messageId}`,
                messageId: original.id,
                seq: original.seq,
            }
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.weixin.state)
    assert.equal(channel(harness, 'weixin').phase, 'connected')

    const first = { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'm-1', text: '第一条' }
    const second = { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'm-2', text: '第二条' }
    await Promise.all([
        options.onMessage(first, anchorOf('m-1')),
        options.onMessage(second, anchorOf('m-2')),
    ])
    const queued = incomingRows(harness)
    assert.equal(queued.length, 2)
    for (const [, row] of queued) assert.equal(row.state, 'queued')
    await options.onCursor('cursor-9')

    const bindingPuts = harness.tables.ops.filter(op => op.op === 'put' && op.table === 'bindings')
    const cursorPut = bindingPuts[bindingPuts.length - 1]
    assert.equal(cursorPut.value.cursor, 'cursor-9')
    const cursorIndex = harness.tables.ops.indexOf(cursorPut)
    for (const [, row] of queued) {
        const rowIndex = harness.tables.ops.findIndex(op => op.op === 'put'
            && op.table === 'incoming'
            && op.value.platformMessageId === row.platformMessageId)
        assert.ok(rowIndex >= 0)
        assert.ok(cursorIndex > rowIndex)
    }
    admission.resolve()
    await flush()
    await harness.runtime.wake()
    await flush()
})

test('重复输入复用已持久原件，正文变化判冲突且不覆盖', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        // 准入保持 unknown，原件正文保留下来供冲突比对
        admit: async message => ({ status: 'unknown', sessionId: SESSION_ID, requestId: `req-${message.messageId}` }),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    const envelope = { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'dup-1', text: '同一句' }
    await options.onMessage(envelope, anchorOf('dup-1'))
    await flush()
    const before = incomingRows(harness)
    await options.onMessage(envelope, anchorOf('dup-1'))
    assert.equal(incomingRows(harness).length, before.length)
    assert.equal(incomingRows(harness)[0][1].fingerprint, before[0][1].fingerprint)

    const changed = { ...envelope, text: '被改写的正文' }
    assert.deepEqual(await options.onMessage(changed, anchorOf('dup-1')), { status: 'conflict' })
    assert.equal(incomingRows(harness)[0][1].text, '同一句')
})

test('accepted 保存真实 native 引用，正文置空', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-7', text: '请处理' },
        anchorOf('m-7'),
    )
    await settle(harness.runtime)
    const [key, row] = incomingRows(harness)[0]
    assert.equal(row.state, 'accepted')
    assert.equal(row.text, null)
    assert.equal(row.requestId, 'req-m-7')
    assert.equal(row.nativeMessageId, 'native-m-7')
    assert.equal(row.nativeSeq, harness.chat.spliceOf('req-m-7').seq)
    assert.equal(harness.ingressLog.admits[0].message.messageId, 'm-7')
    assert.ok(key.length === 64)
})

test('按 binding 精确回话：多输入合批各发一份，锚点取该批最后一条', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'qq', accountId: 'account-qq', senderId: 'owner-qq' })
            await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' })
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const qqOptions = listenOptions(harness.qq.state)
    const wxOptions = listenOptions(harness.weixin.state)
    await qqOptions.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-qq', conversationId: 'owner-qq', senderId: 'owner-qq', messageId: 'm-qq', text: 'QQ 提问' },
        anchorOf('m-qq'),
    )
    await wxOptions.onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'm-wx', text: '微信提问' },
        anchorOf('m-wx', { contextToken: 'ct-wx' }),
    )
    await settle(harness.runtime)

    harness.chat.addTurn({
        inputs: [{ rpcId: 'req-m-qq' }, { rpcId: 'req-m-wx' }],
        assistants: [{ text: '两边都收到了' }],
    })
    await settle(harness.runtime)

    assert.equal(harness.qq.state.sends.length, 1)
    assert.equal(harness.weixin.state.sends.length, 1)
    assert.equal(harness.qq.state.sends[0].text, '两边都收到了')
    assert.deepEqual(harness.qq.state.sends[0].anchor, { messageId: 'm-qq' })
    assert.deepEqual(harness.weixin.state.sends[0].anchor, { messageId: 'm-wx', contextToken: 'ct-wx' })

    // 桌面独立回合、interrupted 回合不广播；纯 reasoning 回合没有可发的文字，只发一句说明
    harness.chat.addTurn({
        inputs: [{ rpcId: 'desktop-1', text: '桌面输入' }],
        assistants: [{ text: '桌面回复' }],
    })
    harness.chat.addTurn({
        inputs: [{ rpcId: 'req-m-qq' }],
        assistants: [{ text: '被中断的回复', interrupted: true }],
        endKind: 'aborted',
    })
    harness.chat.addTurn({
        inputs: [{ rpcId: 'req-m-qq' }],
        assistants: [{ blocks: [{ type: 'reasoning', text: '思考过程' }, { type: 'text', text: '工具广告', source: { kind: 'tool' } }] }],
    })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 2)
    assert.equal(harness.qq.state.sends[1].text, NO_TEXT_NOTE)
    assert.equal(harness.weixin.state.sends.length, 1)

    for (const row of outgoingRows(harness)) {
        assert.equal(row.state, 'sent')
        assert.equal(row.inputRequestIds.length, 1)
        assert.equal(row.partCount, 1)
    }
})

test('unknown 用同一平台身份再核对且不重发，accepted 后停止准入', async (t) => {
    let attempts = 0
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        admit: async (message, binding, spliceOne) => {
            attempts += 1
            if (attempts === 1) {
                return { status: 'unknown', sessionId: SESSION_ID, requestId: `req-${message.messageId}` }
            }
            const original = spliceOne(message.messageId, message.text)
            return {
                status: 'accepted',
                sessionId: SESSION_ID,
                requestId: `req-${message.messageId}`,
                messageId: original.id,
                seq: original.seq,
            }
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-u', text: '未知一次' },
        anchorOf('m-u'),
    )
    await flush()
    let row = incomingRows(harness)[0][1]
    assert.equal(row.state, 'unknown')
    assert.equal(row.text, '未知一次')
    assert.equal(row.requestId, 'req-m-u')
    assert.equal(harness.ingressLog.admits.length, 1)

    await harness.runtime.wake()
    await flush()
    row = incomingRows(harness)[0][1]
    assert.equal(row.state, 'accepted')
    // 两次准入使用同一平台消息身份，从未生成新的平台消息 id
    assert.deepEqual(harness.ingressLog.admits.map(item => item.message.messageId), ['m-u', 'm-u'])
    await harness.runtime.wake()
    await flush()
    assert.equal(harness.ingressLog.admits.length, 2)
})

test('崩溃 sending 恢复为 unknown 且永不自动重发', async (t) => {
    const base = {
        bindingId: 'binding-crash',
        sessionId: SESSION_ID,
        turn: 0,
        endSeq: 4,
        sourceSeqs: [3],
        inputRequestIds: ['req-crash'],
        partIndex: 0,
        partCount: 1,
        text: '崩溃前的回复',
        anchorKey: 'anchor-crash',
        receipt: null,
        errorCode: null,
    }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { bindingId: 'binding-crash' })
            // 预置键本身也必须符合官方 path-safe 合同；崩溃恢复只按同一条记录改写，不解析键。
            await tables.domain.table('outgoing').put('delivery-crash-seed', { ...base, state: 'sending' })
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    const row = harness.tables.maps.outgoing.get('delivery-crash-seed')
    assert.equal(row.state, 'unknown')
    assert.equal(row.receipt, null)
    assert.equal(row.errorCode, 'PROCESS_INTERRUPTED')
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 0)
})

test('凭据与 contextToken 只进 credentials，status 只给身份与计数', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-secret', text: '带锚点' },
        anchorOf('m-secret', { contextToken: 'ctx-value-1' }),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-secret' }], assistants: [{ text: '好' }] })
    await settle(harness.runtime)

    const statusText = JSON.stringify(harness.runtime.status())
    assert.ok(!statusText.includes('ctx-value-1'))
    assert.ok(!statusText.includes('secret-qq'))
    assert.ok(!statusText.includes('session-main-1'))
    assert.deepEqual(Object.keys(channel(harness, 'qq')).sort(), [
        'accountId', 'builtin', 'choices', 'connected', 'errorCode', 'hints', 'label', 'pairAttemptId', 'phase', 'platform', 'qrRevision', 'senderId', 'unknownCount',
    ])

    for (const [, row] of incomingRows(harness)) {
        assert.ok(!('credential' in row))
        assert.ok(!JSON.stringify(row).includes('ctx-value-1'))
    }
    assert.ok(!JSON.stringify([...harness.tables.maps.bindings.values()]).includes('secret-qq'))
    assert.ok(!JSON.stringify(outgoingRows(harness)).includes('ctx-value-1'))

    const stored = [...harness.credentials.records.entries()]
    const anchorRecord = stored.find(([key]) => key !== harness.tables.maps.bindings.get('qq').credentialKey)
    assert.ok(anchorRecord !== undefined)
    assert.match(anchorRecord[0], /^galatea-channels\/anchor-[0-9a-f]{64}$/)
    assert.equal(anchorRecord[1].payload.anchor.contextToken, 'ctx-value-1')
})

test('配对：缺本人身份与默认渠道会话不可用都不写绑定、不连接', async (t) => {
    const ownerless = await createHarness({})
    ownerless.qq.state.pairImpl = async () => {
        const error = new Error('no owner')
        error.code = 'OWNER_UNVERIFIED'
        throw error
    }
    const { attemptId } = await ownerless.runtime.beginPair('qq')
    assert.equal(typeof attemptId, 'string')
    await flush()
    assert.equal(channel(ownerless, 'qq').phase, 'error')
    assert.equal(channel(ownerless, 'qq').errorCode, 'OWNER_UNVERIFIED')
    assert.equal(ownerless.tables.maps.bindings.size, 0)
    assert.equal(ownerless.qq.state.listens.length, 0)
    await ownerless.runtime.close()

    // 扫码期间中枢被清掉：这次配对失败（NO_HUB），零绑定、零连接、零准入。
    const noHub = await createHarness({})
    noHub.qq.state.pairImpl = async () => {
        noHub.core.sessions.setHub(null)
        return [{ platform: 'qq', accountId: 'account-1', senderId: 'owner-1', credential: { cookie: 'c' } }]
    }
    await noHub.runtime.beginPair('qq')
    await flush()
    await flush()
    assert.equal(channel(noHub, 'qq').errorCode, 'NO_HUB')
    assert.equal(noHub.tables.maps.bindings.size, 0)
    assert.equal(noHub.qq.state.listens.length, 0)
    assert.equal(noHub.ingressLog.admits.length, 0)
    await noHub.runtime.close()
    t.diagnostic?.('OWNER_UNVERIFIED 与 NO_HUB 都不形成半连接，也不准入任何 prompt')
})

test('配对：多账户选择精确匹配，connected 只由真实 onReady 决定，凭据键是官方形状', async (t) => {
    const harness = await createHarness({})
    t.after(async () => {
        await harness.runtime.close()
    })
    const pairGate = deferred()
    harness.qq.state.pairImpl = async options => {
        options.onQr('qr-payload-1')
        return pairGate.promise
    }
    const { attemptId } = await harness.runtime.beginPair('qq')
    await flush()
    assert.equal(harness.runtime.qr('qq'), 'qr-payload-1')
    assert.equal(channel(harness, 'qq').phase, 'waiting')
    assert.equal(channel(harness, 'qq').pairAttemptId, attemptId)
    pairGate.resolve([
        { platform: 'qq', accountId: 'account-a', senderId: 'owner-a', credential: { cookie: 'a' } },
        { platform: 'qq', accountId: 'account-b', senderId: 'owner-b', credential: { cookie: 'b' } },
    ])
    await flush()
    await flush()
    const choosing = channel(harness, 'qq')
    assert.equal(choosing.phase, 'choose-account')
    assert.equal(choosing.connected, false)
    assert.deepEqual(choosing.choices, [
        { accountId: 'account-a', senderId: 'owner-a' },
        { accountId: 'account-b', senderId: 'owner-b' },
    ])
    await assert.rejects(
        harness.runtime.selectAccount({ platform: 'qq', attemptId, accountId: 'account-z' }),
        error => error.code === 'ACCOUNT_NOT_SELECTED',
    )
    const selected = await harness.runtime.selectAccount({ platform: 'qq', attemptId, accountId: 'account-b' })
    assert.equal(selected.status, 'selected')
    const binding = harness.tables.maps.bindings.get('qq')
    assert.equal(binding.accountId, 'account-b')
    assert.equal(binding.sessionId, SESSION_ID)
    assert.equal(binding.enabled, true)
    assert.equal('cursor' in binding, false, '配对不写续收位置：官方机器人用不着')
    // 官方 credentialKey builder：scope 固定、id 字母开头
    assert.match(binding.credentialKey, /^galatea-channels\/account-[0-9a-f]{64}$/)
    assert.equal(harness.credentials.records.get(binding.credentialKey).payload.bindingId, binding.bindingId)
    // pair/选择成功不等于连接 ready
    assert.equal(channel(harness, 'qq').phase, 'connecting')
    await flush()
    await flush()
    assert.equal(channel(harness, 'qq').phase, 'connected')
    await assert.rejects(
        harness.runtime.selectAccount({ platform: 'qq', attemptId, accountId: 'account-a' }),
        error => error.code === 'ATTEMPT_NOT_FOUND',
    )
})

test('配对提交窗口取消：只停用本次 exact bindingId，旧授权不动，不开始 listen', async (t) => {
    const gate = deferred()
    let oldKey = null
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            const seeded = await seedBinding(tables, credentials, {})
            oldKey = seeded.credentialKey
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const listensBeforeCommit = harness.qq.state.listens.length
    const oldBinding = harness.tables.maps.bindings.get('qq')
    harness.qq.state.pairImpl = async () => [
        { platform: 'qq', accountId: 'account-new', senderId: 'owner-new', credential: { cookie: 'new' } },
    ]
    let armed = false
    harness.tables.hooks.beforePut = async table => {
        if (table !== 'bindings' || armed) return
        armed = true
        await gate.promise
    }
    const { attemptId } = await harness.runtime.beginPair('qq')
    for (let index = 0; index < 50 && !armed; index += 1) await flush()
    assert.equal(armed, true, '新 binding 持久写入应在窗口内')
    assert.equal(harness.tables.maps.bindings.get('qq').bindingId, oldBinding.bindingId)

    const cancelled = await harness.runtime.cancelPair({ platform: 'qq', attemptId })
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(channel(harness, 'qq').pairAttemptId, null)

    gate.resolve()
    for (let index = 0; index < 50
        && harness.tables.maps.bindings.get('qq').bindingId === oldBinding.bindingId; index += 1) {
        await flush()
    }
    const stored = harness.tables.maps.bindings.get('qq')
    assert.notEqual(stored.bindingId, oldBinding.bindingId)
    assert.equal(stored.enabled, false, '取消后最多停用这条精确的新 bindingId')
    assert.equal(harness.qq.state.listens.length, listensBeforeCommit, '取消后禁止开始新 listen')
    // 旧授权原样保留，新授权只属于新 bindingId
    assert.equal(harness.credentials.records.get(oldKey).payload.bindingId, oldBinding.bindingId)
    assert.match(stored.credentialKey, /^galatea-channels\/account-[0-9a-f]{64}$/)
    assert.equal(harness.credentials.records.get(stored.credentialKey).payload.bindingId, stored.bindingId)
})

test('putBinding 失败时旧绑定与旧授权保持原样，新授权被清理', async (t) => {
    let oldKey = null
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            const seeded = await seedBinding(tables, credentials, {})
            oldKey = seeded.credentialKey
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const listensBeforeCommit = harness.qq.state.listens.length
    const oldBinding = harness.tables.maps.bindings.get('qq')
    harness.qq.state.pairImpl = async () => [
        { platform: 'qq', accountId: 'account-new', senderId: 'owner-new', credential: { cookie: 'new' } },
    ]
    harness.tables.hooks.beforePut = async table => {
        if (table === 'bindings') throw new Error('持久写入失败')
    }
    await harness.runtime.beginPair('qq')
    for (let index = 0; index < 50 && channel(harness, 'qq').errorCode !== 'PAIR_SAVE_FAILED'; index += 1) {
        await flush()
    }
    assert.equal(channel(harness, 'qq').errorCode, 'PAIR_SAVE_FAILED')
    const stored = harness.tables.maps.bindings.get('qq')
    assert.equal(stored.bindingId, oldBinding.bindingId)
    assert.equal(stored.enabled, true)
    assert.ok(harness.credentials.records.has(oldKey))
    // 只剩旧授权：新 grant 已随失败提交清理
    assert.equal(harness.credentials.records.size, 1)
    assert.equal(harness.qq.state.listens.length, listensBeforeCommit)
})

test('close 等待在途发送并保存真实回执', async (t) => {
    const gate = deferred()
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    harness.qq.state.sendImpl = async () => gate.promise
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-close', text: '晚回执' },
        anchorOf('m-close'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-close' }], assistants: [{ text: '正在发送' }] })

    void harness.runtime.wake().catch(() => {})
    for (let index = 0; index < 40 && harness.qq.state.sends.length === 0; index += 1) await flush()
    assert.equal(harness.qq.state.sends.length, 1)
    assert.equal(outgoingRows(harness)[0].state, 'sending')
    const listensBeforeClose = harness.qq.state.listens.length

    let closed = false
    const closing = harness.runtime.close().then(() => {
        closed = true
    })
    await flush()
    await flush()
    assert.equal(closed, false, 'close 必须等待在途发送')

    gate.resolve({ kind: 'platform-accepted', platformMessageId: 'pm-late', clientId: 'client-late' })
    await closing
    const [row] = outgoingRows(harness)
    assert.equal(row.state, 'sent')
    assert.deepEqual(row.receipt, { kind: 'platform-accepted', platformMessageId: 'pm-late', clientId: 'client-late' })
    assert.equal(harness.runtime.status().phase, 'closed')
    assert.equal(harness.qq.state.listens.length, listensBeforeClose, '关闭后不得再有新 listen')
    await assert.rejects(harness.runtime.wake(), error => error.code === 'RUNTIME_CLOSED')
    await harness.runtime.close()
})

test('cut 不一致或持久屏障不明时不生成也不发送', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-cut', text: 'cut 检查' },
        anchorOf('m-cut'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-cut' }], assistants: [{ text: '不该发送' }] })

    harness.chat.state.capturedThroughSeqOverride = 0
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 0)

    harness.chat.state.capturedThroughSeqOverride = null
    harness.chat.state.flushResult = false
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 0)

    harness.chat.state.flushResult = true
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 1)
    assert.ok(harness.chat.state.disposeCalls > 0)
})

test('QQ 超过 4 次回复额度时发出前 4 片、说明接在最后一段文字后面，其余留到对方下一条消息回完后接着发', async (t) => {
    const longText = 'x'.repeat(4500)
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-long', text: '长回复' },
        anchorOf('m-long'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-long' }], assistants: [{ text: longText }] })
    await settle(harness.runtime)
    const sentNow = outgoingRows(harness).filter(row => row.deferred !== true)
    const deferred = () => outgoingRows(harness).filter(row => row.deferred === true)
    assert.equal(harness.qq.state.sends.length, 4)
    assert.deepEqual(sentNow.map(row => row.state), ['sent', 'sent', 'sent', 'sent'])
    assert.equal(sentNow.slice(0, 3).map(row => row.text).join(''), 'x'.repeat(3000))
    assert.ok(sentNow[3].text.startsWith('x'.repeat(1000)), '说明不单占一片')
    assert.match(sentNow[3].text, /还有1 段文字没发；你下一条消息回完后我接着发/)
    assert.deepEqual(deferred().map(row => row.state), ['prepared'])

    // 对方再发一条：先发这一条的回复，再用剩下的额度把留下的两片发完。
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-next', text: '收到' },
        anchorOf('m-next'),
    )
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 4, '新消息还没有回复时不先发留下的片')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-next' }], assistants: [{ text: '好' }] })
    await settle(harness.runtime)
    const after = harness.qq.state.sends.slice(4)
    assert.deepEqual(after.map(send => send.anchor.messageId), ['m-next', 'm-next'])
    assert.equal(after[0].text, '好')
    assert.equal(after[1].text, 'x'.repeat(500))
    assert.deepEqual(deferred().map(row => row.state), ['sent'])
})

test('入站图片：随消息交给准入，准入后与正文一起清空', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const images = [{ mediaType: 'image/png', data: 'AAAA' }]
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-pic', text: '', images },
        anchorOf('m-pic'),
    )
    await settle(harness.runtime)
    const admitted = harness.ingressLog.admits.find(entry => entry.message.messageId === 'm-pic')
    assert.ok(admitted, '图片消息进入准入')
    assert.equal(admitted.message.text, '')
    assert.deepEqual(admitted.message.images, images)
    const row = incomingRows(harness).map(([, item]) => item).find(item => item.platformMessageId === 'm-pic')
    assert.equal(row.state, 'accepted')
    assert.equal(row.text, null)
    assert.equal(row.images, null)
})

test('合并准入：平台自己声明的合并窗口优先于全局的（读消息本身就慢的平台等得久一点）', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { mergeTextMs: 2000, mergeImageMs: 30000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    harness.qq.platform.mergeTextMs = 6000
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-slow', text: '慢平台的一句' },
        anchorOf('m-slow'),
    )
    harness.advance(2500)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 0, '全局的 2 秒到了，平台声明的 6 秒还没到')
    harness.advance(4000)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 1, '平台声明的时间到了才准入')
})

test('合并准入：安静期内的连续消息合成一条准入，只回复一次，锚定最后一条', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { mergeTextMs: 2000, mergeImageMs: 30000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const send = (messageId, text) => listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
        anchorOf(messageId),
    )
    await send('m-a', '第一句')
    await send('m-b', '第二句')
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 0, '安静期内不准入')
    harness.advance(2500)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 1, '两条合成一次准入')
    const [admitted] = harness.ingressLog.admits
    assert.equal(admitted.message.messageId, 'm-a')
    assert.equal(admitted.message.text, '第一句\n第二句')
    const rows = Object.fromEntries(incomingRows(harness).map(([, row]) => [row.platformMessageId, row]))
    assert.equal(rows['m-a'].state, 'accepted')
    assert.equal(rows['m-b'].state, 'accepted')
    assert.equal(rows['m-b'].mergedInto !== undefined, true)
    assert.equal(rows['m-b'].requestId, rows['m-a'].requestId)
    assert.ok(rows['m-a'].admittedFingerprint)

    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '一起回答' }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 1, '只回复一次')
    assert.equal(harness.qq.state.sends[0].text, '一起回答')
    assert.equal(harness.qq.state.sends[0].anchor.messageId, 'm-b', '锚定这组最后一条')
})

test('合并准入的总上限：一直有新的来就一直顺延，但从第一条起到了上限就先准入', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { mergeTextMs: 30_000, mergeImageMs: 30_000, mergeCapMs: 120_000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const send = (messageId, text) => listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
        anchorOf(messageId),
    )
    // 每 25 秒来一条：安静期一直被顺延。
    for (const [index, id] of ['c-1', 'c-2', 'c-3', 'c-4', 'c-5'].entries()) {
        if (index > 0) harness.advance(25_000)
        await send(id, `第${index + 1}句`)
        await settle(harness.runtime)
        assert.equal(harness.ingressLog.admits.length, 0, `第 ${index + 1} 条到时还在攒`)
    }
    // 第一条之后 100 秒；再过 20 秒到 2 分钟上限，不等最后一条之后的 30 秒安静期。
    harness.advance(20_000)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 1, '到上限就合成一条准入')
    assert.equal(harness.ingressLog.admits[0].message.text, ['第1句', '第2句', '第3句', '第4句', '第5句'].join('\n'))
})

test('请求号前缀：渠道自己放进来的（等待到期提醒）交给准入时标 relayed；结果不明重试时沿用原来请求号的前缀', async (t) => {
    let attempts = 0
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { waitTimeoutMs: 180000 },
        admit: async (message, binding, spliceOne) => {
            attempts += 1
            // 第二次准入（等待到期提醒）结果不明，记下的是部署前的旧前缀请求号。
            if (attempts === 2) return { status: 'unknown', sessionId: SESSION_ID, requestId: 'channel-ingress:1:legacy' }
            const original = spliceOne(message.messageId, message.text)
            const requestId = attempts === 3 ? 'channel-ingress:1:legacy' : `req-${message.messageId}`
            return { status: 'accepted', sessionId: SESSION_ID, requestId, messageId: original.id, seq: original.seq }
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-1', text: '我跟你说' },
        anchorOf('m-1'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-1' }], assistants: [{ text: '[等待]' }] })
    await settle(harness.runtime)
    harness.advance(181000)
    await settle(harness.runtime)
    await harness.runtime.wake()
    await settle(harness.runtime)
    assert.deepEqual(harness.ingressLog.admits.map(item => [item.message.messageId.replace(/:.*/, ''), item.message.relayed]),
        [['m-1', false], ['wait-timeout', true], ['wait-timeout', false]], '首次按来处标；结果不明的重试沿用旧请求号的前缀')
    assert.deepEqual(harness.ingressLog.admits[1].message.origin.speaker, { kind: 'program', plugin: 'message-channels-framework' }, '记成渠道说的')
})
test('忙时攒、闲时合：会话一轮进行中到的几条先留在渠道，这一轮结束后合成一条准入；忙得太久不再扣着', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { mergeTextMs: 2000, mergeImageMs: 30000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const send = (messageId, text) => listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
        anchorOf(messageId),
    )
    harness.runtime.markSessionBusy(SESSION_ID, true)
    await send('m-a', '第一句')
    harness.advance(5000)
    await send('m-b', '隔了一会儿的第二句')
    harness.advance(30_000)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 0, '一轮进行中不准入，间隔超过安静期也不拆开')
    harness.runtime.markSessionBusy(SESSION_ID, false)
    await harness.runtime.wake(SESSION_ID)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 1, '这一轮结束后合成一次准入')
    assert.equal(harness.ingressLog.admits[0].message.text, '第一句\n隔了一会儿的第二句')

    harness.runtime.markSessionBusy(SESSION_ID, true)
    await send('m-c', '第三句')
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 1)
    harness.advance(61 * 60_000)
    await harness.runtime.wake(SESSION_ID)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 2, '一轮开始超过一小时没有结束：不再当作忙')
})

test('合并准入：只有图片时等更久，随后的文字与图片一起准入', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { mergeTextMs: 2000, mergeImageMs: 30000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const images = [{ mediaType: 'image/png', data: 'AAAA' }]
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-pic', text: '', images },
        anchorOf('m-pic'),
    )
    harness.advance(10000)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 0, '只有图片时 10 秒仍在等文字')
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-txt', text: '这是哪里' },
        anchorOf('m-txt'),
    )
    harness.advance(2500)
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 1)
    assert.equal(harness.ingressLog.admits[0].message.text, '这是哪里')
    assert.deepEqual(harness.ingressLog.admits[0].message.images, images)
})

test('等待标记：不发送；到期无新消息时提醒助手，回复锚定对方最后一条', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { waitTimeoutMs: 180000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-half', text: '我跟你说' },
        anchorOf('m-half'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-half' }], assistants: [{ text: '[等待]' }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 0, '等待标记不发送')
    const [wait] = outgoingRows(harness)
    assert.equal(wait.kind, 'wait')
    assert.equal(wait.waitState, 'waiting')

    harness.advance(181000)
    await settle(harness.runtime)
    const nudge = harness.ingressLog.admits.find(entry => entry.message.messageId.startsWith('wait-timeout:'))
    assert.ok(nudge, '到期后提醒助手')
    assert.match(nudge.message.text, /请现在正常回复/)
    assert.equal(outgoingRows(harness).find(row => row.kind === 'wait').waitState, 'nudged')

    harness.chat.addTurn({ inputs: [{ rpcId: `req-${nudge.message.messageId}` }], assistants: [{ text: '好，你说' }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 1)
    assert.equal(harness.qq.state.sends[0].text, '好，你说')
    assert.equal(harness.qq.state.sends[0].anchor.messageId, 'm-half', '锚定对方最后一条真实消息')
})

test('等待标记：期间来了新消息就作废，不再提醒', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { waitTimeoutMs: 180000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const send = (messageId, text) => listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
        anchorOf(messageId),
    )
    await send('m-1', '我跟你说')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-1' }], assistants: [{ text: '【等待】' }] })
    await settle(harness.runtime)
    harness.advance(1000)
    await send('m-2', '今天特别累')
    await settle(harness.runtime)
    harness.advance(200000)
    await settle(harness.runtime)
    assert.equal(outgoingRows(harness).find(row => row.kind === 'wait').waitState, 'superseded')
    assert.equal(harness.ingressLog.admits.some(entry => entry.message.messageId.startsWith('wait-timeout:')), false)
})

test('留到下一条消息补发的片：别的绑定刚准入、收件行还没写回请求号的渠道输入不算桌面输入，照常补发（后续）', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000, mainTurnReplies: true },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-1', text: '画三张' },
        anchorOf('m-1'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-1' }], assistants: [{ text: '开始处理' }] })
    await settle(harness.runtime)
    harness.advance(51 * 60_000)
    // 中枢里程序放进来的一轮（没有渠道输入）：按去向发到手机，QQ 那条消息的回复窗口过了，留到对方下一条消息之后。
    harness.chat.addTurn({ inputs: [{ rpcId: 'bg-1', text: '【后台一轮】处理好了', source: { kind: 'work', deliveryKey: 'bg-1' } }], assistants: [{ text: '三张处理好了' }] })
    await settle(harness.runtime)
    assert.deepEqual(outgoingRows(harness).filter(row => row.deferred === true).map(row => row.text), ['三张处理好了'])
    // 同一会话绑着的另一个渠道刚准入了一条（用户本人的、和代为放进来的各一条），收件行还没写回请求号：会话日志里先有了这两条输入。
    harness.chat.addTurn({ inputs: [{ rpcId: 'channel-ingress:1:pending', text: '微信上说的' }, { rpcId: 'channel-relay:1:pending', text: '【项目任务回报】' }], assistants: [{ text: '好' }] })
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-2', text: '在吗' },
        anchorOf('m-2'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-2' }], assistants: [{ text: '在' }] })
    await settle(harness.runtime)
    assert.deepEqual(harness.qq.state.sends.map(send => send.text), ['开始处理', '在', '三张处理好了'], '延后片照常补发，没有当成在桌面上看过')
    assert.equal(outgoingRows(harness).some(row => row.errorCode === 'SEEN_ON_DESKTOP'), false)
})

test('留到下一条消息补发的片：对方之后从桌面发过消息就不再补发，也不当作未送达告诉助手', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000, mainTurnReplies: true },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-1', text: '画三张' },
        anchorOf('m-1'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-1' }], assistants: [{ text: '开始处理' }] })
    await settle(harness.runtime)
    harness.advance(51 * 60_000)
    // 中枢里程序放进来的一轮（没有渠道输入）：按去向发到手机，QQ 那条消息的回复窗口过了，留到对方下一条消息之后。
    harness.chat.addTurn({ inputs: [{ rpcId: 'bg-1', text: '【后台一轮】处理好了', source: { kind: 'work', deliveryKey: 'bg-1' } }], assistants: [{ text: '三张处理好了' }] })
    await settle(harness.runtime)
    assert.deepEqual(outgoingRows(harness).filter(row => row.deferred === true).map(row => row.text), ['三张处理好了'])
    // 桌面上说的这一轮本来也发到手机；这条只看留待片补不补发，给它 {to:'none'} 不外发。
    harness.chat.addTurn({ inputs: [{ rpcId: 'desktop-rpc-1', text: '在电脑上看到了' }], assistants: [{ text: '好' }], route: { to: 'none' } })
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-2', text: '在吗' },
        anchorOf('m-2'),
    )
    await settle(harness.runtime)
    const admitted = harness.ingressLog.admits.find(entry => entry.message.messageId === 'm-2')
    assert.doesNotMatch(admitted.message.text, /渠道提示/)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-2' }], assistants: [{ text: '在' }] })
    await settle(harness.runtime)
    assert.deepEqual(harness.qq.state.sends.map(send => send.text), ['开始处理', '在'])
    const dropped = outgoingRows(harness).find(row => row.deferred === true)
    assert.equal(dropped.state, 'failed')
    assert.equal(dropped.errorCode, 'SEEN_ON_DESKTOP')
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-3', text: '再问一句' },
        anchorOf('m-3'),
    )
    await settle(harness.runtime)
    assert.doesNotMatch(harness.ingressLog.admits.find(entry => entry.message.messageId === 'm-3').message.text, /渠道提示/)
})

test('同一会话还绑定了微信：微信上的消息不算桌面输入，留待的 QQ 片照常补发', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'qq', accountId: 'account-qq', senderId: 'owner-qq' })
            await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' })
        },
        runtime: { qqRelayWindowMs: 50 * 60_000, mainTurnReplies: true },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const fromQQ = (messageId) => listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-qq', conversationId: 'owner-qq', senderId: 'owner-qq', messageId, text: 'QQ' },
        anchorOf(messageId),
    )
    await fromQQ('q-1')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-q-1' }], assistants: [{ text: '开始处理' }] })
    await settle(harness.runtime)
    harness.advance(51 * 60_000)
    // 中枢里程序放进来的一轮（没有渠道输入）：按去向发到手机，QQ 那条消息的回复窗口过了，留到对方下一条消息之后。
    harness.chat.addTurn({ inputs: [{ rpcId: 'bg-1', text: '【后台一轮】处理好了', source: { kind: 'work', deliveryKey: 'bg-1' } }], assistants: [{ text: '处理好了' }] })
    await settle(harness.runtime)
    await listenOptions(harness.weixin.state).onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'w-1', text: '微信' },
        anchorOf('w-1', { contextToken: 'ct-w-1' }),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-w-1' }], assistants: [{ text: '微信上回你' }] })
    await settle(harness.runtime)
    await fromQQ('q-2')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-q-2' }], assistants: [{ text: '在' }] })
    await settle(harness.runtime)
    assert.deepEqual(harness.qq.state.sends.map(send => send.text), ['开始处理', '在', '处理好了'])
})

test('中途发送 prefer 微信：微信还在上下文里就先走微信，即使 QQ 更新、还有额度；微信过期后照常选路', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'qq', accountId: 'account-qq', senderId: 'owner-qq' })
            await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' })
        },
        runtime: { qqRelayWindowMs: 50 * 60_000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.weixin.state).onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'w-1', text: '微信' },
        anchorOf('w-1', { contextToken: 'ct-w-1' }),
    )
    await settle(harness.runtime)
    harness.advance(60_000)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-qq', conversationId: 'owner-qq', senderId: 'owner-qq', messageId: 'q-1', text: 'QQ' },
        anchorOf('q-1'),
    )
    await settle(harness.runtime)
    assert.equal((await harness.runtime.push({ sessionId: SESSION_ID, text: '外部调用方的进度', prefer: 'weixin' })).platform, 'weixin')
    const weixinBinding = [...harness.tables.maps.bindings.values()].find(row => row.platform === 'weixin').bindingId
    assert.equal((await harness.runtime.push({ sessionId: SESSION_ID, text: '维护通知', prefer: 'weixin', avoid: [weixinBinding] })).platform, 'qq',
        'avoid 掉的绑定不用：选路在其余能送达的里挑')
    assert.equal((await harness.runtime.push({ sessionId: SESSION_ID, text: '中枢的话' })).platform, 'qq', '不指定时照旧 QQ 优先')
    harness.advance(25 * 60 * 60_000)
    assert.equal((await harness.runtime.push({ sessionId: SESSION_ID, text: '过期以后', prefer: 'weixin' })).status, 'unavailable', '微信过期、QQ 窗口也过了：发不出去，由调用方另行转交')
})

test('未送达说明：发送失败的回复附给会话（不接在对方的话后面）；这一轮正常结束、模型跑过才算告诉了；说过不再附', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    const send = (messageId, text) => options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
        anchorOf(messageId),
    )
    await send('m-a', '画一张')
    await settle(harness.runtime)
    const accept = harness.qq.state.sendImpl
    harness.qq.state.sendImpl = async () => {
        throw Object.assign(new Error('rejected'), { code: 'SEND_REJECTED', definitelyRejected: true })
    }
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '第二轮结果好了，一共有三张。' }] })
    await settle(harness.runtime)
    assert.deepEqual(outgoingRows(harness).map(row => [row.state, row.errorCode, typeof row.failedAt]), [['failed', 'SEND_REJECTED', 'number']])
    harness.qq.state.sendImpl = accept

    const notice = harness.core.noticeOf(SESSION_ID)
    assert.match(notice, /^（渠道提示，不是对方说的：下面这些确定没有送到/)
    assert.match(notice, /第 \d+ 轮回复（QQ，SEND_REJECTED）：「第二轮结果好了，一共有三张。…」/)
    const rejected = () => outgoingRows(harness).find(row => row.errorCode === 'SEND_REJECTED')
    assert.equal(rejected().reportedAt, undefined, '附上了还没交到，不算告诉了')

    await send('m-b', '没收到')
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.find(entry => entry.message.messageId === 'm-b').message.text, '没收到', '不接在对方的话后面')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-b' }], assistants: [{ text: '我重发一次' }] })
    // 核心在这一轮正常结束、模型跑过以后才算交到（失败的轮核心不调，提示留着）。
    harness.core.takeNotices(SESSION_ID)
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.at(-1).text, '我重发一次')
    assert.ok(rejected().reportedAt > 0, '交到了才记告诉了')
    assert.equal(harness.core.noticeOf(SESSION_ID), null, '说过的不再附')
})

test('未送达说明：结果不明的单独说“可能已经送到”，不和确定没送到的混在一起，也不报错误码', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    const send = (messageId, text) => options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
        anchorOf(messageId),
    )
    await send('m-a', '讲讲')
    await settle(harness.runtime)
    const accept = harness.qq.state.sendImpl
    harness.qq.state.sendImpl = async () => {
        throw Object.assign(new Error('no reply'), { code: 'SEND_FAILED', resultUnknown: true })
    }
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '很长的一段说明，发出去没等到回音。' }] })
    await settle(harness.runtime)
    assert.deepEqual(outgoingRows(harness).map(row => row.state), ['unknown'])
    harness.qq.state.sendImpl = accept

    const text = harness.core.noticeOf(SESSION_ID)
    assert.match(text, /可能已经送到对方手机；重发前先想一想/)
    assert.match(text, /第 \d+ 轮回复（QQ，结果不明）：「很长的一段说明/)
    assert.doesNotMatch(text, /确定没有送到|SEND_FAILED/)
})

/** 一片发出后没等到确认（结果不明），记下平台给的“晚到结果”回调。 */
async function unknownThenLate(t) {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    const say = async (messageId, text) => {
        await options.onMessage(
            { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
            anchorOf(messageId),
        )
        await settle(harness.runtime)
    }
    await say('m-a', '讲讲')
    const accept = harness.qq.state.sendImpl
    const late = []
    harness.qq.state.sendImpl = async (request) => {
        late.push(request.onLateResult)
        throw Object.assign(new Error('no reply'), { code: 'SEND_FAILED', resultUnknown: true })
    }
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '很长的一段说明，发出去没等到回音。' }] })
    await settle(harness.runtime)
    harness.qq.state.sendImpl = accept
    assert.deepEqual(outgoingRows(harness).map(row => row.state), ['unknown'])
    assert.equal(typeof late[0], 'function', '平台拿到了晚到结果的回调')
    const admitted = messageId => harness.ingressLog.admits.find(entry => entry.message.messageId === messageId).message.text
    // 附给会话的提示（没有时为 null）；`take` 模拟这个会话的一轮正常结束、提示交到了。
    const notice = () => harness.core.noticeOf(SESSION_ID)
    const take = async () => {
        harness.core.takeNotices(SESSION_ID)
        await settle(harness.runtime)
    }
    return { harness, say, report: async (result) => { late[0](result); await settle(harness.runtime) }, admitted, notice, take }
}

test('晚到的结果：还没告诉会话时平台补回“发出了”——改记已发出（带回执），不进未送达说明，Watchdog 也看不到', async (t) => {
    const { harness, say, report, admitted, notice } = await unknownThenLate(t)
    await report({ status: 'sent', platformMessageId: 'pm-late' })
    const [row] = outgoingRows(harness)
    assert.equal(row.state, 'sent')
    assert.deepEqual(row.receipt, { kind: 'platform-accepted', platformMessageId: 'pm-late', clientId: null })
    assert.equal(row.failedAt, undefined)
    assert.deepEqual(harness.runtime.undelivered(), [])
    assert.equal(notice(), null, '还没交到的那条"可能已经送到"撤掉了')
    await say('m-b', '嗯')
    assert.equal(admitted('m-b'), '嗯')
})

test('晚到的结果：还没告诉会话时平台补回“没发出”——改记确定没发出，附给会话的提示改成“确定没有送到”', async (t) => {
    const { harness, report, notice } = await unknownThenLate(t)
    assert.match(notice(), /可能已经送到/)
    await report({ status: 'failed', code: 'BRIDGE_NOT_SENT' })
    assert.deepEqual(outgoingRows(harness).map(row => [row.state, row.errorCode]), [['failed', 'BRIDGE_NOT_SENT']])
    assert.match(notice(), /确定没有送到对方手机[\s\S]*第 \d+ 轮回复（QQ，BRIDGE_NOT_SENT）/)
    assert.doesNotMatch(notice(), /可能已经送到/)
})

test('晚到的结果：已经告诉会话“可能已经送到”后才补回“发出了”——改记已发出，附给会话补一句后来确认送到了，只说一次', async (t) => {
    const { harness, report, notice, take } = await unknownThenLate(t)
    assert.match(notice(), /可能已经送到对方手机/)
    await take()
    assert.equal(notice(), null)
    await report({ status: 'sent', platformMessageId: 'pm-late' })
    assert.equal(outgoingRows(harness).find(row => row.text.startsWith('很长的一段')).state, 'sent')
    assert.deepEqual(harness.runtime.undelivered(), [])
    assert.match(notice(), /^（渠道提示，不是对方说的：下面这些之前说结果不明，后来有了确定结果。）\n- 第 \d+ 轮回复（QQ）：「很长的一段说明，发出去没等到回音。…」之前说结果不明，后来确认已经送到对方手机，不用重发。$/)
    await take()
    assert.equal(notice(), null, '说过的不再附')
    assert.equal(outgoingRows(harness).find(row => row.text.startsWith('很长的一段')).lateNote, undefined)
})

test('出站图片：回复中的本机图片引用拆成图片片发送；文件缺失时改发说明文字', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-reply-'))
    const picture = join(dir, 'cat.png')
    await writeFile(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]))
    const missing = join(dir, 'gone.png')
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-draw', text: '画只猫' },
        anchorOf('m-draw'),
    )
    await settle(harness.runtime)
    // QQ 上全部文字合成一片放在最前，图片随后各占一片：文字 + 两张图共 3 片。
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-draw' }], assistants: [{ text: `处理好了：\n![猫](${picture})\n还有一张 ![丢失](${missing})` }] })
    await settle(harness.runtime)
    const sends = harness.qq.state.sends
    assert.equal(sends.length, 3)
    assert.equal(sends[0].text, '处理好了：\n\n还有一张')
    assert.equal(sends[1].image.mediaType, 'image/png')
    assert.equal(sends[1].image.path, picture)
    assert.equal(sends[2].image, undefined)
    assert.match(sends[2].text, /^\[图片无法发送（IMAGE_NOT_FOUND）：/)
    const rows = outgoingRows(harness).sort((left, right) => left.partIndex - right.partIndex)
    assert.deepEqual(rows.map(row => row.kind ?? 'text'), ['text', 'image', 'image'])
    assert.ok(rows.every(row => row.state === 'sent'))
})

test('QQ 片数：图片前后的文字合成一片，一段文字加三张图正好一次发完', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-reply-'))
    const pictures = []
    for (const name of ['b2', 'b3', 'bc']) {
        const path = join(dir, `${name}.png`)
        await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]))
        pictures.push(path)
    }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-three', text: '发我看看' },
        anchorOf('m-three'),
    )
    await settle(harness.runtime)
    const text = `三张都处理好了。\n\n${pictures.map(path => `![图](${path})`).join('\n')}\n\n都在这里了。`
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-three' }], assistants: [{ text }] })
    await settle(harness.runtime)
    const sends = harness.qq.state.sends
    assert.equal(sends.length, 4)
    assert.equal(sends[0].text, '三张都处理好了。\n\n都在这里了。')
    assert.deepEqual(sends.slice(1).map(send => send.image.path), pictures)
    assert.deepEqual(outgoingRows(harness).filter(row => row.deferred === true), [])
})

test('拼图：一条回复里相邻的几张图拼成一张无损大图，按顺序编号，同一批重试得到同一个文件', async (t) => {
    const { default: sharp } = await import('sharp')
    const dir = await mkdtemp(join(tmpdir(), 'channel-compose-'))
    const pictures = []
    for (const [index, size] of [[1, [300, 600]], [2, [400, 600]], [3, [150, 300]]].entries()) {
        const path = join(dir, `x${index}.png`)
        await sharp({ create: { width: size[1][0], height: size[1][1], channels: 3, background: { r: 40 * index, g: 90, b: 160 } } }).png().toFile(path)
        pictures.push(path)
    }
    const compositeDir = join(dir, 'composites')
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { compositeDir },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-compose', text: '发我看看' },
        anchorOf('m-compose'),
    )
    await settle(harness.runtime)
    const text = `三张都处理好了。\n\n${pictures.map(path => `![图](${path})`).join('\n')}`
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-compose' }], assistants: [{ text }] })
    await settle(harness.runtime)
    const sends = harness.qq.state.sends
    assert.equal(sends.length, 2)
    assert.equal(sends[0].text.trim(), '三张都处理好了。')
    const composite = sends[1].image.path
    assert.ok(composite.startsWith(compositeDir))
    // 等高排成一行：最高 600，第三张从 300 放大到 600、宽 300；原图不缩小。
    const meta = await sharp(composite).metadata()
    assert.equal(meta.format, 'png')
    assert.equal(meta.height, 600 + 24 * 2)
    assert.equal(meta.width, 300 + 400 + 300 + 24 * 4)
    assert.equal((await import('../compose.js')).composeImages.length, 3)
    const again = await (await import('../compose.js')).composeImages(pictures, compositeDir, { maxBytes: 10 * 1024 * 1024 })
    assert.deepEqual(again, [composite])
    const tight = await (await import('../compose.js')).composeImages(pictures, join(dir, 'tight'), { maxBytes: 1 })
    assert.deepEqual(tight, pictures, '放不下时拆开，拆到单张原样发')
})

test('准入 await 期间的正文冲突不被旧快照抹掉', async (t) => {
    const gate = deferred()
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        admit: async (message, binding, spliceOne) => {
            await gate.promise
            const original = spliceOne(message.messageId, message.text)
            return {
                status: 'accepted',
                sessionId: SESSION_ID,
                requestId: `req-${message.messageId}`,
                messageId: original.id,
                seq: original.seq,
            }
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-c', text: '第一版' },
        anchorOf('m-c'),
    )
    for (let index = 0; index < 50 && harness.ingressLog.admits.length === 0; index += 1) await flush()
    assert.equal(harness.ingressLog.admits.length, 1)
    const [key, row] = incomingRows(harness)[0]
    // 另一入口在准入 await 窗口内把同一身份标为冲突
    await harness.tables.domain.table('incoming').put(key, { ...row, state: 'conflict' })

    gate.resolve()
    // 行在准入 await 窗口内已被标为 conflict：这个同步快照本身不是完成信号，
    // 必须等 admitQueued 真正消费回执、生产侧把冲突投影成 errorCode 之后再断言。
    for (let index = 0; index < 50 && channel(harness, 'qq').errorCode !== 'INPUT_CONFLICT'; index += 1) await flush()
    const latest = incomingRows(harness)[0][1]
    assert.equal(latest.state, 'conflict')
    assert.equal(latest.text, '第一版')
    assert.equal(latest.nativeMessageId, null)
    assert.equal(channel(harness, 'qq').errorCode, 'INPUT_CONFLICT')
    assert.deepEqual(await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-c', text: '第二版' },
        anchorOf('m-c'),
    ), { status: 'conflict' })
})

test('回执 sessionId 不是绑定中枢时保留原件与旧引用', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        admit: async message => ({
            status: 'accepted',
            sessionId: 'session-other',
            requestId: `req-${message.messageId}`,
            messageId: `native-${message.messageId}`,
            seq: 0,
        }),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-ref', text: '原件保留' },
        anchorOf('m-ref'),
    )
    for (let index = 0; index < 50 && channel(harness, 'qq').errorCode === null; index += 1) await flush()
    const [, row] = incomingRows(harness)[0]
    assert.equal(row.state, 'queued')
    assert.equal(row.text, '原件保留')
    assert.equal(row.requestId, null)
    assert.equal(row.nativeMessageId, null)
    assert.equal(channel(harness, 'qq').errorCode, 'INGRESS_REFERENCE_INVALID')
})

test('微信空 contextToken 可收件，只在发送前 notSent 拒绝', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {
            platform: 'weixin',
            accountId: 'account-wx',
            senderId: 'owner-wx',
        }),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.weixin.state)
    await options.onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'm-wx0', text: '空 token' },
        anchorOf('m-wx0', { contextToken: '' }),
    )
    await settle(harness.runtime)
    const [, row] = incomingRows(harness)[0]
    assert.equal(row.state, 'accepted')
    const binding = harness.tables.maps.bindings.get('weixin')
    const anchorRecord = [...harness.credentials.records.entries()]
        .find(([key]) => key !== binding.credentialKey)
    assert.equal(anchorRecord[1].payload.anchor.contextToken, '')

    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-wx0' }], assistants: [{ text: '不该发出' }] })
    await settle(harness.runtime)
    assert.equal(harness.weixin.state.sends.length, 0)
    const [outgoing] = outgoingRows(harness)
    assert.equal(outgoing.state, 'failed')
    assert.equal(outgoing.errorCode, 'ANCHOR_INCOMPLETE')
})

test('close 先停准入再排空：被阻塞的准入不会挡住关闭，也不会有晚连接', async (t) => {
    const admitGate = deferred()
    const closeGate = deferred()
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        admit: async () => {
            await admitGate.promise
            return { status: 'unknown', sessionId: SESSION_ID, requestId: 'req-late' }
        },
        closeIngress: async () => {
            await closeGate.promise
        },
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    const listensBeforeClose = harness.qq.state.listens.length
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-held', text: '被挂住的准入' },
        anchorOf('m-held'),
    )
    for (let index = 0; index < 50 && harness.ingressLog.admits.length === 0; index += 1) await flush()
    assert.equal(harness.ingressLog.admits.length, 1)

    let closed = false
    const closing = harness.runtime.close().then(() => {
        closed = true
    })
    for (let index = 0; index < 20; index += 1) await flush()
    assert.equal(closed, false, 'close 必须等待 helper 关闭')
    assert.equal(harness.ingressLog.closes.length, 1, 'close 必须先启动自有 ingress 的关闭')
    closeGate.resolve()
    await closing
    assert.equal(closed, true, '被阻塞的准入不能把 close 卡死')
    assert.equal(harness.ingressLog.created[0].isClosed(), true)
    assert.equal(harness.qq.state.listens.length, listensBeforeClose, '关闭后不得有晚连接')
    await assert.rejects(harness.runtime.wake(), error => error.code === 'RUNTIME_CLOSED')
    admitGate.resolve()
    t.after(async () => {
        await harness.runtime.close()
    })
})

test('status 投影为 {phase,channels:[channelView],counts}，扫码/验证码进度可操作', async (t) => {
    const harness = await createHarness({})
    t.after(async () => {
        await harness.runtime.close()
    })
    const codeGate = deferred()
    harness.qq.state.pairImpl = async options => {
        options.onQr('qr-payload-1')
        options.onState('scaned')
        await codeGate.promise
        const code = await options.getVerifyCode({ signal: options.signal })
        assert.equal(code, '246810')
        return [{ platform: 'qq', accountId: 'account-a', senderId: 'owner-a', credential: { cookie: 'a' } }]
    }
    const { attemptId } = await harness.runtime.beginPair('qq')
    for (let index = 0; index < 20 && channel(harness, 'qq').phase !== 'scanned'; index += 1) await flush()
    assert.equal(channel(harness, 'qq').phase, 'scanned', '可信 onState 扫码进度不能被吞掉')
    codeGate.resolve()
    for (let index = 0; index < 20 && channel(harness, 'qq').phase !== 'need-verify'; index += 1) await flush()
    const scanning = channel(harness, 'qq')
    assert.equal(scanning.phase, 'need-verify')
    assert.equal(scanning.pairAttemptId, attemptId)
    assert.equal(scanning.connected, false)
    assert.deepEqual(scanning.choices, [])
    assert.deepEqual(Object.keys(scanning).sort(), [
        'accountId', 'builtin', 'choices', 'connected', 'errorCode', 'hints', 'label', 'pairAttemptId', 'phase', 'platform', 'qrRevision', 'senderId', 'unknownCount',
    ])

    const status = harness.runtime.status()
    assert.deepEqual(Object.keys(status).sort(), ['channels', 'counts', 'phase'])
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
    assert.equal(status.phase, 'need-verify')
    assert.ok(!JSON.stringify(status).includes('qr-payload-1'), 'QR 明文不进 status')

    await harness.runtime.verifyCode({ platform: 'qq', attemptId, code: '246810' })
    for (let index = 0; index < 40 && harness.tables.maps.bindings.get('qq') === undefined; index += 1) await flush()
    const binding = harness.tables.maps.bindings.get('qq')
    assert.ok(binding !== undefined)
    assert.match(binding.credentialKey, /^galatea-channels\/account-[0-9a-f]{64}$/)
    assert.equal(harness.credentials.records.get(binding.credentialKey).payload.bindingId, binding.bindingId)
    for (let index = 0; index < 40 && channel(harness, 'qq').phase !== 'connected'; index += 1) await flush()
    const connected = channel(harness, 'qq')
    assert.equal(connected.phase, 'connected')
    assert.equal(connected.connected, true)
    assert.equal(connected.pairAttemptId, null)
    assert.equal(connected.accountId, 'account-a')
})

test('换绑/断开后不再发送未发出的后续分片，且不伪报 unknown', async (t) => {
    const gate = deferred()
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    harness.qq.state.sendImpl = async () => {
        await gate.promise
        return { kind: 'platform-accepted', platformMessageId: 'pm-first', clientId: 'client-first' }
    }
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-chunk', text: '两片回复' },
        anchorOf('m-chunk'),
    )
    await settle(harness.runtime)
    const text = `${'a'.repeat(900)}\n${'b'.repeat(900)}`
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-chunk' }], assistants: [{ text }] })
    void harness.runtime.wake().catch(() => {})
    for (let index = 0; index < 40 && harness.qq.state.sends.length === 0; index += 1) await flush()
    assert.equal(harness.qq.state.sends.length, 1)

    await harness.runtime.disconnect('qq')
    gate.resolve()
    for (let index = 0; index < 40 && outgoingRows(harness).length < 2; index += 1) await flush()
    assert.equal(harness.qq.state.sends.length, 1, '断开后不得再发旧授权分片')
    const rows = outgoingRows(harness).sort((left, right) => left.partIndex - right.partIndex)
    assert.equal(rows[0].state, 'sent')
    assert.equal(rows[1].state, 'failed')
    assert.equal(rows[1].errorCode, 'CREDENTIAL_MISSING')
    await harness.runtime.close()
})

test('replies 纯提取：只按真实原生引用与完成回合成批，发到手机的只是最后一段文字', () => {
    const events = []
    const surface = []
    let seq = 0
    const push = (type, data) => {
        const event = { type, seq, time: seq, data, surfaceOp: 'append' }
        seq += 1
        events.push(event)
        if (SURFACE_TYPES.has(type)) surface.push(event)
        return event
    }
    const splice = (id, rpcId, text) => push('agent/inbox/spliced', {
        inserted: [{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } }],
    })
    const user = (id, rpcId, text) => push('user/message', {
        id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId },
    })
    const model = (turn, step, id, text) => push('assistant/message', {
        turn,
        step,
        message: {
            id,
            role: 'assistant',
            source: { kind: 'model' },
            content: [{ type: 'text', text, source: { kind: 'model' } }],
        },
        stream: [],
    })
    const accepted = options => {
        const base = {
            platform: 'qq',
            accountId: 'account-1',
            conversationId: 'owner-1',
            senderId: 'owner-1',
            platformMessageId: options.platformMessageId ?? 'm-a',
            bindingId: options.bindingId,
            requestId: options.requestId,
            nativeMessageId: options.nativeMessageId,
            nativeSeq: options.nativeSeq,
            anchorKey: options.anchorKey,
            state: 'accepted',
            text: null,
        }
        return { ...base, fingerprint: incomingFingerprintOf({ ...base, text: options.originalText }) }
    }

    const originalA = splice('native-a', 'req-a', 'A 提问')
    // splice() 返回 SessionEvent：原生 message id 挂在 data.inserted[0]，事件本身没有 id。
    const nativeA = originalA.data.inserted[0]
    push('turn/start', { turn: 0 })
    user(nativeA.id, 'req-a', 'A 提问')
    model(0, 1, 'asst-0-1', '先查一下')
    model(0, 2, 'asst-0-2', '已经完成')
    const end = push('turn/end', { turn: 0, reason: { kind: 'completed' } })
    push('turn/start', { turn: 1 })
    user('native-desktop', 'desktop-1', '桌面输入')
    model(1, 1, 'asst-1-1', '桌面回复')
    push('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const incoming = [accepted({
        bindingId: 'binding-a',
        requestId: 'req-a',
        nativeMessageId: 'native-a',
        nativeSeq: originalA.seq,
        anchorKey: 'anchor-a',
        originalText: 'A 提问',
    })]
    const batches = extractReplyBatches(events, surface, incoming, { original })
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0], {
        bindingId: 'binding-a',
        turn: 0,
        endSeq: end.seq,
        sourceSeqs: [4],
        inputRequestIds: ['req-a'],
        text: '已经完成',
        legacy: { text: '先查一下\n已经完成', sourceSeqs: [3, 4] },
        files: [],
        anchorKey: 'anchor-a',
    })

    const clone = () => events.map(event => ({ ...event, data: structuredClone(event.data) }))
    const surfaceOf = list => list.filter(event => SURFACE_TYPES.has(event.type))

    // nativeSeq 指向的不是真实 Inbox 插入事件：引用不可解析，不成批
    assert.equal(extractReplyBatches(events, surface, [
        accepted({
            bindingId: 'binding-a', requestId: 'req-a', nativeMessageId: 'native-a',
            nativeSeq: 99, anchorKey: 'anchor-a', originalText: 'A 提问',
        }),
    ], { original }).length, 0)

    // user/message 的 id 与持久原生引用不一致：不成批
    const forged = clone()
    const forgedIndex = forged.findIndex(event => event.type === 'user/message' && event.data.source.rpcId === 'req-a')
    forged[forgedIndex] = { ...forged[forgedIndex], data: { ...forged[forgedIndex].data, id: 'native-other' } }
    assert.equal(extractReplyBatches(forged, surfaceOf(forged), incoming, { original }).length, 0)

    // 当前 surface 不再含该 user 原件：不成批
    assert.equal(extractReplyBatches(events, surface.filter(event => event.type !== 'user/message'), incoming, { original }).length, 0)

    // surface 上的 assistant 内容被替换：不成批
    const replacedSurface = surface.map(event => (event.type === 'assistant/message' && event.data.message.id === 'asst-0-2'
        ? {
            ...event,
            data: {
                ...event.data,
                message: {
                    ...event.data.message,
                    content: [{ type: 'text', text: '被替换', source: { kind: 'model' } }],
                },
            },
        }
        : event))
    assert.equal(extractReplyBatches(events, replacedSurface, incoming, { original }).length, 0)

    // 进会话前正文被改过（桌面上编辑了排队的消息：编号和请求号不变，只换正文）：不成批，报出来写明原因
    const edited = clone().map(event => (event.type === 'user/message' && event.data.source.rpcId === 'req-a'
        ? { ...event, data: { ...event.data, content: [{ type: 'text', text: '改成另一件事' }] } }
        : event))
    const blockedEdited = []
    assert.equal(extractReplyBatches(edited, surfaceOf(edited), incoming, { original, blocked: blockedEdited }).length, 0)
    assert.deepEqual(blockedEdited.map(item => [item.turn, item.reason]), [[0, 'changed']])

    // 框架核心给这条加了来源标注（原文记在 source.annotation）：经核心的 original 去掉再比，照常成批，不算"被改了"
    const annotation = '（以下来自插件 message-channels-framework，不是用户本人说的。）'
    const annotated = clone().map(event => (event.type === 'user/message' && event.data.source.rpcId === 'req-a'
        ? { ...event, data: { ...event.data, source: { ...event.data.source, annotation }, content: event.data.content.map((block, index) => (index === 0 ? { ...block, text: `${annotation}\n${block.text}` } : block)) } }
        : event))
    const blockedAnnotated = []
    assert.equal(extractReplyBatches(annotated, surfaceOf(annotated), incoming, { original, blocked: blockedAnnotated }).length, 1)
    assert.deepEqual(blockedAnnotated, [])
    assert.throws(() => extractReplyBatches(events, surface, incoming), /original/, '不给 original 不比')

    // 完成了、有渠道输入、却被挡下的轮报出来，写明原因；没有渠道输入的桌面那一轮不报
    const blockedForged = []
    extractReplyBatches(forged, surfaceOf(forged), incoming, { original, blocked: blockedForged })
    assert.deepEqual(blockedForged, [{ turn: 0, endSeq: end.seq, endTime: end.time, reason: 'unresolved' }])
    const blockedSurface = []
    extractReplyBatches(events, replacedSurface, incoming, { original, blocked: blockedSurface })
    assert.deepEqual(blockedSurface.map(item => [item.turn, item.reason]), [[0, 'surface']])
    const none = []
    extractReplyBatches(events, surface, incoming, { original, blocked: none })
    assert.deepEqual(none, [], '成批的不报')

    // 非 completed 结束不成批
    const aborted = clone().map(event => (event.type === 'turn/end' && event.data.turn === 0
        ? { ...event, data: { turn: 0, reason: { kind: 'aborted' } } }
        : event))
    assert.equal(extractReplyBatches(aborted, surfaceOf(aborted), incoming, { original }).length, 0)
    const blockedAborted = []
    extractReplyBatches(aborted, surfaceOf(aborted), incoming, { original, blocked: blockedAborted })
    assert.deepEqual(blockedAborted, [], '没有完成的不算被挡下')

    // 未成对边界（缺 turn/end）不成批
    assert.equal(extractReplyBatches(events.slice(0, end.seq), surface, incoming, { original }).length, 0)
})

test('replies：一条消息里的几段文字（工具调用之间写的）只发最后一段；一个字没写的一轮发一句说明', () => {
    const events = []
    const surface = []
    let seq = 0
    const push = (type, data) => {
        const event = { type, seq, time: 1000 + seq, data, surfaceOp: 'append' }
        seq += 1
        events.push(event)
        if (SURFACE_TYPES.has(type)) surface.push(event)
        return event
    }
    const ask = (turn, id, rpcId, text) => {
        const spliced = push('agent/inbox/spliced', {
            inserted: [{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } }],
        })
        push('turn/start', { turn })
        push('user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })
        const base = {
            platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1',
            platformMessageId: `m-${rpcId}`, bindingId: 'binding-a', requestId: rpcId, nativeMessageId: id,
            nativeSeq: spliced.seq, anchorKey: `anchor-${rpcId}`, state: 'accepted', text: null,
        }
        return { ...base, fingerprint: incomingFingerprintOf({ ...base, text }) }
    }
    const first = ask(0, 'native-a', 'req-a', '查一下')
    push('assistant/message', {
        turn: 0,
        step: 1,
        message: {
            id: 'asst-0',
            role: 'assistant',
            source: { kind: 'model' },
            content: [
                { type: 'text', text: 'Now check the logs.', source: { kind: 'model' } },
                { type: 'text', text: '查完了，一切正常。', source: { kind: 'model' } },
            ],
        },
        stream: [],
    })
    push('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const second = ask(1, 'native-b', 'req-b', '再看看')
    push('assistant/message', {
        turn: 1, step: 1, message: { id: 'asst-1', role: 'assistant', source: { kind: 'model' }, content: [] }, stream: [],
    })
    const end = push('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const batches = extractReplyBatches(events, surface, [first, second], { original })
    assert.equal(batches.length, 2)
    assert.equal(batches[0].text, '查完了，一切正常。')
    assert.equal(batches[0].legacy.text, 'Now check the logs.\n查完了，一切正常。')
    assert.equal(batches[0].noText, undefined)
    assert.equal(batches[1].text, NO_TEXT_NOTE)
    assert.equal(batches[1].noText, true)
    assert.equal(batches[1].endTime, end.time)
    assert.deepEqual(batches[1].sourceSeqs, [end.seq])
})

test('splitReplyText 按码点与自然换行分块且可完整还原', () => {
    const text = `${'a'.repeat(10)}\n${'😀'.repeat(700)}\n${'b'.repeat(400)}`
    const parts = splitReplyText(text, 1000)
    assert.ok(parts.length >= 2)
    assert.equal(parts.join(''), text)
    for (const part of parts) assert.ok(Array.from(part).length <= 1000)
    assert.deepEqual(splitReplyText('短回复', 1000), ['短回复'])
    assert.deepEqual(splitReplyText('', 1000), [])
})

test('凭据读取窗口内 close 后不再开始新 listen', async (t) => {
    const gate = deferred()
    const held = { value: false }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            const seeded = await seedBinding(tables, credentials, {})
            credentials.hooks.beforeRead = async key => {
                if (key !== seeded.credentialKey || held.value) return
                held.value = true
                await gate.promise
            }
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await waitFor(() => held.value, '凭据读取窗口')
    const closing = harness.runtime.close()
    gate.resolve()
    await closing
    assert.equal(harness.qq.state.listens.length, 0, '关闭开始后不得再开始 listen')
    assert.equal(harness.ingressLog.created.length, 0, '关闭开始后不得再创建准入 helper')
    assert.equal(harness.runtime.status().phase, 'closed')
})

test('取消旧配对窗口内 close 不再登记新尝试，也不开始新 listen', async (t) => {
    const readGate = deferred()
    const putGate = deferred()
    const window = { readHeld: false, putHeld: false }
    let oldKey = null
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            const seeded = await seedBinding(tables, credentials, {})
            oldKey = seeded.credentialKey
            credentials.hooks.beforeRead = async key => {
                if (key === oldKey || !key.startsWith(`${SCOPE}/account-`) || window.readHeld) return
                window.readHeld = true
                await readGate.promise
            }
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const listensBefore = harness.qq.state.listens.length
    harness.qq.state.pairImpl = async () => [
        { platform: 'qq', accountId: 'account-new', senderId: 'owner-new', credential: { cookie: 'new' } },
    ]
    // 第一次配对：新 binding 已落盘、正在读它的凭据（attempt 此刻已持有该 bindingId）
    void harness.runtime.beginPair('qq').catch(() => {})
    await waitFor(() => window.readHeld, '新 binding 的凭据读取窗口')
    harness.tables.hooks.beforePut = async table => {
        if (table !== 'bindings' || window.putHeld) return
        window.putHeld = true
        await putGate.promise
    }
    // 第二次配对停在 cancelAttempt 的 await 上（正在停用第一次的 binding）
    const second = harness.runtime.beginPair('qq')
    await waitFor(() => window.putHeld, '取消旧配对的停用写入')
    const closing = harness.runtime.close()
    readGate.resolve()
    putGate.resolve()
    await assert.rejects(second, error => error.code === 'RUNTIME_CLOSED')
    await closing
    assert.equal(harness.qq.state.pairCalls, 1, '关闭开始后不得再开始配对')
    assert.equal(harness.qq.state.listens.length, listensBefore, '关闭开始后不得再开始 listen')
    assert.equal(harness.runtime.status().phase, 'closed')
})

test('原文已准入后异文到达仍持久标 conflict，后续 replies 不再使用该记录', async (t) => {
    const hold = deferred()
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        admit: async (message, binding, spliceOne) => {
            await hold.promise
            const original = spliceOne(message.messageId, message.text)
            return {
                status: 'accepted',
                sessionId: SESSION_ID,
                requestId: `req-${message.messageId}`,
                messageId: original.id,
                seq: original.seq,
            }
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    const original = {
        kind: 'private',
        platform: 'qq',
        accountId: 'account-1',
        conversationId: 'owner-1',
        senderId: 'owner-1',
        messageId: 'm-b',
        text: '原文',
    }
    await options.onMessage(original, anchorOf('m-b'))
    // 原文的 ingress 持着同一个 incoming key 锁：异文只能排在它之后
    await waitFor(() => harness.ingressLog.admits.length === 1, '原文准入持锁')
    const changed = options.onMessage({ ...original, text: '异文' }, anchorOf('m-b'))
    hold.resolve()
    assert.deepEqual(await changed, { status: 'conflict' })
    const [, row] = incomingRows(harness)[0]
    assert.equal(row.state, 'conflict', '已准入的行命中不同正文也必须持久标冲突')
    // 已准入事实不伪回滚：真实 native 引用与 text(null) 原样保留
    assert.equal(row.text, null)
    assert.equal(row.requestId, 'req-m-b')
    assert.equal(row.nativeMessageId, 'native-m-b')
    assert.equal(row.nativeSeq, harness.chat.spliceOf('req-m-b').seq)

    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-b' }], assistants: [{ text: '冲突后不得发送' }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 0, '冲突记录不得再生成回复')
})

test('发送最后窗口撤下 surface：0 次平台调用，记 failed SOURCE_CHANGED 并保留 payload', async (t) => {
    const gate = deferred()
    const armed = { value: false }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-last', text: '最后窗口' },
        anchorOf('m-last'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-last' }], assistants: [{ text: '撤下即停' }] })
    harness.tables.hooks.beforePut = async (table, key, value) => {
        if (table !== 'outgoing' || value.state !== 'sending' || armed.value) return
        armed.value = true
        await gate.promise
    }
    const pending = harness.runtime.wake().then(() => undefined, () => undefined)
    await waitFor(() => armed.value, 'sending 意图持久窗口')
    // 在 sending 意图持久期间撤下当前 surface 上的模型文本
    const removed = harness.chat.state.surfaceEvents.pop()
    assert.equal(removed.type, 'assistant/message')
    gate.resolve()
    await pending
    assert.equal(harness.qq.state.sends.length, 0, '最后窗口 source 变动不得调用平台')
    const [row] = outgoingRows(harness)
    assert.equal(row.state, 'failed')
    assert.equal(row.errorCode, 'SOURCE_CHANGED')
    assert.equal(row.text, '撤下即停')
    assert.equal(row.partCount, 1)
})

test('最终 owner 复核后 source 被追加：0 次平台调用，记 failed SOURCE_CHANGED', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-append', text: '追加窗口' },
        anchorOf('m-append'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-append' }], assistants: [{ text: '追加即停' }] })
    const final = armFinalOwnerGate(harness)
    const pending = harness.runtime.wake().then(() => undefined, () => undefined)
    await waitFor(() => final.state.held, '最后一步 owner 复核')
    // cut 已经核对过：owner await 期间 source 被追加，只能靠同步 Session.seq 复核发现
    harness.chat.append('session/marker', { note: 'late' })
    final.gate.resolve()
    await pending
    assert.equal(harness.qq.state.sends.length, 0, '最后一步 source 追加后不得调用平台')
    const [row] = outgoingRows(harness)
    assert.equal(row.state, 'failed')
    assert.equal(row.errorCode, 'SOURCE_CHANGED')
    assert.equal(row.text, '追加即停')
})

test('发送最后窗口 owner 变化：0 次平台调用，记 failed OWNER_UNVERIFIED', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-owner', text: '换主窗口' },
        anchorOf('m-owner'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-owner' }], assistants: [{ text: '换主即停' }] })
    const final = armFinalOwnerGate(harness)
    const pending = harness.runtime.wake().then(() => undefined, () => undefined)
    await waitFor(() => final.state.held, '最后一步 owner 复核')
    final.state.headerId = 'session-other'
    final.gate.resolve()
    await pending
    assert.equal(harness.qq.state.sends.length, 0, 'owner 变动后不得用旧授权发送')
    const [row] = outgoingRows(harness)
    assert.equal(row.state, 'failed')
    assert.equal(row.errorCode, 'OWNER_UNVERIFIED')
    assert.equal(row.text, '换主即停')
})

test('冷源在最终 owner 验证窗口被改写：0 次平台调用，记 failed SOURCE_CHANGED', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-cold', text: '冷源窗口' },
        anchorOf('m-cold'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-cold' }], assistants: [{ text: '冷源改写即停' }] })

    // 冷源：没有 live 实例，只有只读 observation 与 opaque revision。
    const revision = { value: 'rev-1' }
    harness.sessions.get = () => undefined
    const observe = harness.sessionQuery.observeSession
    harness.sessionQuery.observeSession = async (id, observeOptions) => {
        const observation = await observe(id, observeOptions)
        return { ...observation, source: 'prepared', revision: revision.value }
    }
    // 只在最终 owner 窗口（最后一次 cut 之后的 owner 观察）改写冷源 revision：cut 与之前的
    // 观察都已核对过，旧流程会直接发出。
    onFinalOwnerObserve(harness, observe => {
        revision.value = 'rev-2'
        return observe()
    })
    const pending = harness.runtime.wake().then(() => undefined, () => undefined)
    await pending
    assert.equal(harness.qq.state.sends.length, 0, '冷源在最终 owner 窗口被改写不得调用平台')
    const [row] = outgoingRows(harness)
    assert.equal(row.state, 'failed')
    assert.equal(row.errorCode, 'SOURCE_CHANGED')
    assert.equal(row.text, '冷源改写即停')
})

test('既有 prepared 正文差异而 partCount 相同时 SOURCE_CHANGED，旧 payload 与身份不被改写', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-immutable', text: '不可变投递' },
        anchorOf('m-immutable'),
    )
    await settle(harness.runtime)
    const text = `${'a'.repeat(900)}\n${'b'.repeat(900)}`
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-immutable' }], assistants: [{ text }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 2)
    const entries = [...harness.tables.maps.outgoing.entries()]
    const [deliveryId, stored] = entries.find(([, value]) => value.partIndex === 1)
    // 预置：同 deliveryId、同 partCount，但正文不同的旧 prepared 投递
    const tampered = stored.text.replace(/^b/, 'z')
    assert.equal(tampered.length, stored.text.length)
    assert.notEqual(tampered, stored.text)
    harness.tables.maps.outgoing.set(deliveryId, {
        ...stored,
        state: 'prepared',
        text: tampered,
        receipt: null,
        errorCode: null,
    })
    const idsBefore = [...harness.tables.maps.outgoing.keys()].sort()

    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 2, '既有 prepared 正文不同不得再发一次')
    assert.deepEqual([...harness.tables.maps.outgoing.keys()].sort(), idsBefore, '不得新建 deliveryId 绕过旧投递')
    const after = harness.tables.maps.outgoing.get(deliveryId)
    assert.equal(after.state, 'failed')
    assert.equal(after.errorCode, 'SOURCE_CHANGED')
    assert.equal(after.text, tampered, '旧 payload 正文不被改写')
    assert.equal(after.partCount, stored.partCount)
    assert.deepEqual(after.sourceSeqs, stored.sourceSeqs)
})

test('cancelPair 后原绑定连接仍 ready 时恢复 connected 并可继续回复', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    // 平台配对挂起到 abort：只影响本次尝试，不碰已就绪的原绑定连接
    harness.qq.state.pairImpl = pairOptions => new Promise(resolve => {
        pairOptions.signal.addEventListener('abort', () => resolve([]), { once: true })
    })
    const { attemptId } = await harness.runtime.beginPair('qq')
    assert.equal(channel(harness, 'qq').phase, 'pairing')
    const cancelled = await harness.runtime.cancelPair({ platform: 'qq', attemptId })
    assert.equal(cancelled.status, 'cancelled')
    const view = channel(harness, 'qq')
    assert.equal(view.pairAttemptId, null)
    assert.equal(view.connected, true)
    assert.equal(view.phase, 'connected', '原绑定仍 ready 时不得把可见阶段留在 idle')
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-after-cancel', text: '取消后回复' },
        anchorOf('m-after-cancel'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-after-cancel' }], assistants: [{ text: '仍在原绑定回复' }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 1, '取消配对不得阻止原绑定回复')
})

test('微信：新 binding 已排入 Domain 写队列时，旧 listener 的晚游标不覆盖新 owner', async (t) => {
    const gate = deferred()
    const armed = { value: false }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' }),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const oldBinding = harness.tables.maps.bindings.get('weixin')
    const oldOptions = listenOptions(harness.weixin.state)
    harness.weixin.state.pairImpl = async () => [
        { platform: 'weixin', accountId: 'account-new', senderId: 'owner-new', credential: { cookie: 'new' } },
    ]
    // 门控新 binding 的 commit：put 已排入写队列，但同步 get 仍是旧 A。
    harness.tables.hooks.beforePut = async table => {
        if (table !== 'bindings' || armed.value) return
        armed.value = true
        await gate.promise
    }
    await harness.runtime.beginPair('weixin')
    await waitFor(() => armed.value, '新 binding 的写队列窗口')
    assert.equal(harness.tables.maps.bindings.get('weixin').bindingId, oldBinding.bindingId)

    // 旧 listener 的晚游标只能排在 B.put 之后：必须在写槽内发现 owner 已换。
    const lateCursor = oldOptions.onCursor('cursor-old')
    gate.resolve()
    await lateCursor

    const stored = harness.tables.maps.bindings.get('weixin')
    assert.notEqual(stored.bindingId, oldBinding.bindingId, '新 owner 不应被旧游标覆盖')
    assert.equal(stored.accountId, 'account-new')
    assert.equal(stored.enabled, true)
    assert.equal(stored.cursor, undefined, '旧 listener 的晚游标不得写进新 owner')
    assert.match(stored.credentialKey, /^galatea-channels\/account-[0-9a-f]{64}$/)
    assert.equal(harness.credentials.records.get(stored.credentialKey).payload.bindingId, stored.bindingId)

    // 当前 listener 的游标仍要正常落盘：exact 更新不是无条件丢弃。
    await waitFor(() => harness.weixin.state.listens.length === 2, '新绑定开始 listen')
    await listenOptions(harness.weixin.state).onCursor('cursor-new')
    assert.equal(harness.tables.maps.bindings.get('weixin').cursor, 'cursor-new')
})

test('断开与后续配对按同平台链收敛：断开的删除不会删掉后来建立的 binding', async (t) => {
    const stopGate = deferred()
    const stopped = { value: false }
    let oldKey = null
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            const seeded = await seedBinding(tables, credentials, {})
            oldKey = seeded.credentialKey
        },
    })
    t.after(async () => {
        stopGate.resolve()
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const oldBinding = harness.tables.maps.bindings.get('qq')
    // 挂住旧 listen 的结束：断开在排空旧连接时，后来的配对必须仍排在它后面。
    harness.qq.state.holdStop = () => {
        stopped.value = true
        return stopGate.promise
    }
    const disconnecting = harness.runtime.disconnect('qq')
    await waitFor(() => stopped.value, '断开排空旧连接')
    harness.qq.state.holdStop = null

    harness.qq.state.pairImpl = async () => [
        { platform: 'qq', accountId: 'account-later', senderId: 'owner-later', credential: { cookie: 'later' } },
    ]
    const { attemptId } = await harness.runtime.beginPair('qq')
    assert.equal(typeof attemptId, 'string')
    for (let index = 0; index < 20; index += 1) await flush()
    // 断开还没落盘：后来的配对必须等它，不能先写一条随后被删掉的 binding。
    assert.equal(harness.tables.maps.bindings.get('qq').bindingId, oldBinding.bindingId)

    stopGate.resolve()
    const result = await disconnecting
    assert.equal(result.status, 'disconnected')
    await waitFor(() => harness.tables.maps.bindings.get('qq') !== undefined,
        '后来配对的 binding 落盘（断开不得删除它）')
    const stored = harness.tables.maps.bindings.get('qq')
    assert.notEqual(stored.bindingId, oldBinding.bindingId)
    assert.equal(stored.accountId, 'account-later')
    assert.equal(stored.enabled, true, '断开不得停用或删除后来建立的 binding')
    assert.equal(harness.credentials.records.get(stored.credentialKey).payload.bindingId, stored.bindingId)
    assert.equal(harness.credentials.records.has(oldKey), false, '断开的旧授权已释放')
    await waitFor(() => channel(harness, 'qq').connected === true, '后来的配对连接')
})

test('A/B 普通会话：默认渠道 getter 指向 B 时，A 的既有 binding 仍只投 A 并回 A', async (t) => {
    let channelSessionCalls = 0
    const harness = await createHarness({
        // 模拟“UI 焦点/默认渠道 getter 现在是 B”：已有 binding 不能被执行它改写。
        channelSession: async () => {
            channelSessionCalls += 1
            return { sessionId: 'session-b' }
        },
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { sessionId: SESSION_ID })
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    assert.equal(channelSessionCalls, 0, '已有 binding 的恢复不得再选默认会话')

    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-ab', text: '给 A 的提问' },
        anchorOf('m-ab'),
    )
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.created.length, 1)
    assert.equal(harness.ingressLog.created[0].binding.sessionId, SESSION_ID, '工厂必须拿到固定的 binding.sessionId')
    assert.equal(harness.ingressLog.admits.length, 1)

    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-ab' }], assistants: [{ text: '只回 A' }] })
    await settle(harness.runtime)
    assert.equal(channelSessionCalls, 0)
    assert.equal(harness.qq.state.sends.length, 1, '回复只能走 A 的 binding')
    const [row] = outgoingRows(harness)
    assert.equal(row.sessionId, SESSION_ID)
    assert.equal(row.text, '只回 A')
})

test('恢复：已有 binding 只观察 binding.sessionId 核对，不取默认会话', async (t) => {
    const seen = []
    let channelSessionCalls = 0
    const harness = await createHarness({
        channelSession: async () => {
            channelSessionCalls += 1
            return { sessionId: SESSION_ID }
        },
        session: async (id) => {
            seen.push(id)
            return { sessionId: id }
        },
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, {})
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    assert.equal(channelSessionCalls, 0, '恢复路径不得调用 channelSession()')
    assert.deepEqual([...new Set(seen)], [SESSION_ID], '只按 binding.sessionId 核对')
    assert.equal(harness.qq.state.listens.length, 1, '核对通过即开始 listen')
    assert.equal(channel(harness, 'qq').connected, true)
    assert.equal(channel(harness, 'qq').errorCode, null)
})

test('会话目标失效：session() 回 null 或异 id 时前置拒绝，零 prompt 零发送', async (t) => {
    const cases = [
        ['目标消失', async () => null],
        ['回异 id', async () => ({ sessionId: 'session-other' })],
    ]
    for (const [label, session] of cases) {
        const harness = await createHarness({
            session,
            seed: async ({ tables, credentials }) => {
                await seedBinding(tables, credentials, {})
            },
        })
        try {
            await settle(harness.runtime)
            assert.equal(channel(harness, 'qq').errorCode, 'OWNER_UNVERIFIED', label)
            assert.equal(harness.qq.state.listens.length, 0, `${label}：不得开始 listen`)
            assert.equal(harness.ingressLog.created.length, 0, `${label}：不得建准入 helper`)
            assert.equal(harness.ingressLog.admits.length, 0, `${label}：零 prompt`)
            assert.equal(harness.qq.state.sends.length, 0, `${label}：零发送`)
        } finally {
            await harness.runtime.close()
        }
    }
})

test('普通 fork：parentSession 存在但 origin 不是 subagent 时仍按本人会话核验并回复', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    // 官方 fork 出的普通会话带 parentSession，但不是子 agent：不能因此拒绝归属核验。
    harness.chat.state.header.parentSession = 'session-root'
    await settle(harness.runtime)
    assert.equal(channel(harness, 'qq').errorCode, null, '普通 fork 不得被当作子 agent 拒绝')
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-fork', text: 'fork 提问' },
        anchorOf('m-fork'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-fork' }], assistants: [{ text: 'fork 回复' }] })
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 1, '普通 fork 同样要能准入')
    assert.equal(harness.qq.state.sends.length, 1, '普通 fork 同样要能回复')
    assert.equal(harness.qq.state.sends[0].text, 'fork 回复')
})

test('会话目标中途失效：不再发送，已准入原件保持 accepted 且不重投', async (t) => {
    const control = { valid: true }
    const harness = await createHarness({
        session: async (id) => (control.valid ? { sessionId: id } : null),
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, {})
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-lost', text: '会话消失' },
        anchorOf('m-lost'),
    )
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 1)

    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-lost' }], assistants: [{ text: '会话已消失' }] })
    control.valid = false
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 0, '会话失效后不得调用平台发送')
    assert.equal(outgoingRows(harness).length, 0, '失效会话不准备任何投递')
    assert.equal(channel(harness, 'qq').errorCode, 'OWNER_UNVERIFIED')
    // 已准入的原件保持 accepted：不因会话失效而重投，也不造新的 turn/用户消息。
    const [key, row] = incomingRows(harness)[0]
    assert.ok(key.length > 0)
    assert.equal(row.state, 'accepted')
    assert.equal(row.text, null)
    assert.equal(harness.ingressLog.admits.length, 1, '不得重新 prompt')
})

test('wake(sessionId) 只对账绑定到该会话的渠道：非绑定会话零发送，同会话两条 binding 都唤醒', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'qq', accountId: 'account-qq', senderId: 'owner-qq' })
            await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' })
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const qqOptions = listenOptions(harness.qq.state)
    const wxOptions = listenOptions(harness.weixin.state)
    await qqOptions.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-qq', conversationId: 'owner-qq', senderId: 'owner-qq', messageId: 'm-scope-qq', text: 'QQ 提问' },
        anchorOf('m-scope-qq'),
    )
    await wxOptions.onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'm-scope-wx', text: '微信提问' },
        anchorOf('m-scope-wx', { contextToken: 'ct-scope' }),
    )
    await harness.runtime.wake(SESSION_ID)
    assert.equal(harness.ingressLog.admits.length, 2, '同一会话的两条 binding 都要准入')

    harness.chat.addTurn({
        inputs: [{ rpcId: 'req-m-scope-qq' }, { rpcId: 'req-m-scope-wx' }],
        assistants: [{ text: '同一普通会话的回复' }],
    })
    const observesBefore = harness.chat.state.observeCalls ?? 0
    const readsBefore = harness.chat.state.readSurfaceCalls
    // 非绑定会话的 turn/end：不得触发送，也不读该会话的回复。
    await harness.runtime.wake('session-unbound')
    assert.equal(harness.qq.state.sends.length, 0)
    assert.equal(harness.weixin.state.sends.length, 0)
    assert.equal(harness.chat.state.observeCalls ?? 0, observesBefore, '非绑定会话不观察事件')
    assert.equal(harness.chat.state.readSurfaceCalls, readsBefore, '非绑定会话不读回复')
    // fixture/storage 语义：没有记录时读到的就是 null（state 初值），不是 undefined。
    assert.equal(harness.chat.state.capturedThroughSeqOverride, null, '非绑定会话不得写读取游标')

    // 绑定会话的 turn/end：同一 sessionId 的两条渠道都要被唤醒。
    await harness.runtime.wake(SESSION_ID)
    assert.equal(harness.qq.state.sends.length, 1)
    assert.equal(harness.weixin.state.sends.length, 1)
    assert.equal(harness.qq.state.sends[0].text, '同一普通会话的回复')
    assert.equal(harness.weixin.state.sends[0].text, '同一普通会话的回复')
})

test('私聊接中枢：私聊的消息进现在的中枢；换了中枢，之后的消息进新中枢，绑定里存的会话不再读', async (t) => {
    const NEW_HUB = 'session-new-hub'
    const newHub = createChatSession(NEW_HUB)
    const harness = await createHarness({
        extraChats: [newHub],
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        admit: async (message, binding) => {
            const target = binding.sessionId === NEW_HUB ? newHub : harness.chat
            const original = target.appendSpliced(`native-${message.messageId}`, `req-${message.messageId}`, message.text)
            return { status: 'accepted', sessionId: binding.sessionId, requestId: `req-${message.messageId}`, messageId: original.id, seq: original.seq }
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const send = async (messageId, text) => {
        await listenOptions(harness.qq.state).onMessage(
            { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
            anchorOf(messageId),
        )
        await settle(harness.runtime)
    }
    await send('m-1', '旧中枢收')
    assert.equal(harness.chat.spliceOf('req-m-1')?.text, '旧中枢收')
    harness.core.sessions.setHub(NEW_HUB)
    await send('m-2', '新中枢收')
    assert.equal(newHub.spliceOf('req-m-2')?.text, '新中枢收', '换了中枢以后进新中枢')
    assert.equal(harness.chat.spliceOf('req-m-2'), undefined)
    assert.deepEqual(harness.runtime.exitSessions(), [{ sessionId: NEW_HUB, as: 'hub' }])
    assert.equal(harness.tables.maps.bindings.get('qq').sessionId, SESSION_ID, '绑定里存的不改，也不再读')
})

test('还没有中枢：私聊配对被拒（不出二维码），报一次 channels/no-hub；已有的私聊消息先留在渠道里，定了中枢以后交进去', async (t) => {
    const harness = await createHarness({ seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}), fakeCore: { hub: null } })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    assert.deepEqual(await harness.runtime.beginPair('weixin'), { refused: 'NO_HUB' })
    assert.equal(harness.weixin.state.pairCalls, 0, '不开始配对')
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-1', text: '有人吗' },
        anchorOf('m-1'),
    )
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.length, 0, '没有中枢就不准入')
    assert.deepEqual(harness.core.reports.map(item => item.kind), ['channels/no-hub'], '只报一次')
    assert.deepEqual(harness.runtime.exitSessions(), [], '没有中枢就不接中枢')
    harness.core.sessions.setHub(SESSION_ID)
    await settle(harness.runtime)
    assert.equal(harness.chat.spliceOf('req-m-1')?.text, '有人吗', '定了中枢以后交进去')
})
test('二维码刷新：新尝试从 0 起，真实 onQr 只在文本变化时 +1，取消后回到 0，status 不含 QR 明文', async (t) => {
    const harness = await createHarness({})
    t.after(async () => {
        await harness.runtime.close()
    })
    const pairOptions = { current: null }
    // development_fake：pair 挂起直到 abort，测试才能在同一次尝试里多次真实回调 onQr，且不触真平台。
    harness.qq.state.pairImpl = options => {
        pairOptions.current = options
        return new Promise(resolve => {
            if (options.signal.aborted) {
                resolve([])
                return
            }
            options.signal.addEventListener('abort', () => resolve([]), { once: true })
        })
    }
    const { attemptId } = await harness.runtime.beginPair('qq')
    await flush()
    assert.ok(pairOptions.current !== null, '平台 pair 应已开始并交出回调')

    // 新尝试：还没有任何二维码，版本号从 0 起，阶段只报“等待扫码”。
    const started = channel(harness, 'qq')
    assert.equal(started.pairAttemptId, attemptId)
    assert.equal(started.qrRevision, 0)
    assert.equal(started.phase, 'pairing')

    // 第一次真实有效的 onQr 把版本推到 1。
    pairOptions.current.onQr('qr-payload-A')
    assert.equal(harness.runtime.qr('qq'), 'qr-payload-A')
    assert.equal(channel(harness, 'qq').qrRevision, 1)
    assert.equal(channel(harness, 'qq').phase, 'waiting')

    // 同一条 QR 再回调不是刷新：版本不变，页面不必重建 img。
    pairOptions.current.onQr('qr-payload-A')
    assert.equal(channel(harness, 'qq').qrRevision, 1)

    // 换一条 QR 才是刷新。
    pairOptions.current.onQr('qr-payload-B')
    assert.equal(harness.runtime.qr('qq'), 'qr-payload-B')
    assert.equal(channel(harness, 'qq').qrRevision, 2)

    // 空文本不是二维码：既不推进版本，也不覆盖已有的 QR。
    pairOptions.current.onQr('')
    assert.equal(channel(harness, 'qq').qrRevision, 2)
    assert.equal(harness.runtime.qr('qq'), 'qr-payload-B')

    // UI 投影只给版本号（缓存键），QR 明文一个字都不进 status。
    assert.ok(!JSON.stringify(harness.runtime.status()).includes('qr-payload'))

    // 取消作废本次尝试：没有尝试就没有二维码，版本回到 0。
    const cancelled = await harness.runtime.cancelPair({ platform: 'qq', attemptId })
    assert.equal(cancelled.status, 'cancelled')
    const settled = channel(harness, 'qq')
    assert.equal(settled.pairAttemptId, null)
    assert.equal(settled.qrRevision, 0)
    assert.equal(harness.runtime.qr('qq'), null)
    assert.ok(!JSON.stringify(harness.runtime.status()).includes('qr-payload'))

    t.diagnostic?.('qrRevision：0 起、有效 A=>1、同 A=>1、B=>2、取消=>0，且 status 投影不含 QR 明文')
})

test('回复投递落盘：key 符合官方 path-safe 合同、sent 持久、重开不重发（development_fake）', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    // close 幂等：即便断言先失败也能收尾。
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-persist', text: '要落盘' },
        anchorOf('m-persist'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-persist' }], assistants: [{ text: '回复已落盘' }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 1, '一条回复恰好发一次')

    const entries = [...harness.tables.maps.outgoing.entries()]
    assert.equal(entries.length, 1, '一次投递只落一条 outgoing 记录')
    const [deliveryId, stored] = entries[0]
    assert.match(deliveryId, /^delivery-[0-9a-f]{64}$/, '投递 key 必须是官方认可的 path-safe 键')
    assert.equal(stored.state, 'sent', '平台确认后必须把 sent 持久到 outgoing')
    assert.equal(stored.text, '回复已落盘')
    assert.equal(stored.partIndex, 0)
    assert.equal(stored.partCount, 1)

    await harness.runtime.close()

    // 重开：同一份持久表 + 同一段真实会话内容；重启后算出的 deliveryId 必须与已 sent 的那条相同。
    const reopened = await createHarness({ tables: harness.tables, credentials: harness.credentials })
    t.after(async () => {
        await reopened.runtime.close()
    })
    reopened.chat.appendSpliced('native-m-persist', 'req-m-persist', '要落盘')
    reopened.chat.addTurn({ inputs: [{ rpcId: 'req-m-persist' }], assistants: [{ text: '回复已落盘' }] })
    await settle(reopened.runtime)
    assert.equal(reopened.qq.state.sends.length, 0, '已 sent 的同一投递重开后不得重发')
    assert.deepEqual([...reopened.tables.maps.outgoing.keys()], [deliveryId], '重开不得新建或改写投递身份')
    assert.equal(reopened.tables.maps.outgoing.get(deliveryId).state, 'sent')
})

test('present 交付的文件随回复原样发出：文字之后逐个发文件', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-files-'))
    const file = join(dir, '大纲.md')
    await writeFile(file, '# 大纲\n')
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-file', text: '大纲呢' },
        anchorOf('m-file'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-file' }], assistants: [{ text: '大纲在这里' }], presented: [file] })
    await settle(harness.runtime)
    const sends = harness.qq.state.sends
    assert.equal(sends.length, 2)
    assert.equal(sends[0].text, '大纲在这里')
    assert.equal(sends[1].file.name, '大纲.md')
    assert.equal(Buffer.from(sends[1].file.bytes).toString('utf8'), '# 大纲\n')
    assert.equal(outgoingRows(harness)[1].kind, 'file')
})

test('一轮之中立即发出：锚定对方最近的消息，QQ 给最终回复留一次额度，放不下的如实报告', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-push', text: '读完告诉我' },
        anchorOf('m-push'),
    )
    await settle(harness.runtime)
    const by = { kind: 'session', sessionId: SESSION_ID, role: 'hub' }
    const first = await harness.runtime.push({ sessionId: SESSION_ID, text: '好，我开始读，读完告诉你。', by })
    assert.deepEqual(first, { status: 'sent', platform: 'qq', sent: 1, failed: 0, unsent: 0, repliesLeft: 3 })
    assert.deepEqual(outgoingRows(harness).find(row => row.push === true).by, by, '中途发送记下是谁发的')
    const second = await harness.runtime.push({ sessionId: SESSION_ID, text: 'y'.repeat(3500) })
    assert.deepEqual(second, { status: 'sent', platform: 'qq', sent: 2, failed: 0, unsent: 2, repliesLeft: 1 })
    assert.deepEqual(await harness.runtime.push({ sessionId: SESSION_ID, text: '再来' }), { status: 'unavailable', reason: 'NO_REPLIES_LEFT', repliesLeft: 1 })
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-push' }], assistants: [{ text: '读完了' }] })
    await settle(harness.runtime)
    const sends = harness.qq.state.sends
    assert.equal(sends.length, 4)
    assert.ok(sends.every(send => send.anchor.messageId === 'm-push'))
    assert.equal(sends[3].text, '读完了')
    assert.deepEqual(await harness.runtime.push({ sessionId: 'session-other', text: 'x' }), { status: 'unavailable', reason: 'NOT_BOUND' })
})

/** 16 位单声道 WAV：rate 采样率，seconds 秒的正弦。 */
function wavBytes(rate = 24000, seconds = 0.2) {
    const samples = Math.round(rate * seconds)
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(i / 8)), i * 2)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24)
    header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36)
    header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm])
}

test('一轮之中发语音：QQ 收到语音片（WAV 原样交给适配器），出站记为 voice；读不出的语音改发说明', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-voice-'))
    const voice = join(dir, 'say.wav')
    await writeFile(voice, wavBytes())
    const broken = join(dir, 'broken.wav')
    await writeFile(broken, 'not a wav')
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-voice', text: '说给我听' },
        anchorOf('m-voice'),
    )
    await settle(harness.runtime)
    const result = await harness.runtime.push({ sessionId: SESSION_ID, voice })
    assert.deepEqual(result, { status: 'sent', platform: 'qq', sent: 1, failed: 0, unsent: 0, repliesLeft: 3 })
    const sends = harness.qq.state.sends
    assert.equal(sends.length, 1)
    assert.equal(sends[0].voice.path, voice)
    assert.deepEqual(Buffer.from(sends[0].voice.bytes), wavBytes())
    assert.equal(outgoingRows(harness)[0].kind, 'voice')
    await harness.runtime.push({ sessionId: SESSION_ID, voice: broken })
    assert.match(sends[1].text, /^\[语音无法发送（VOICE_FORMAT_UNSUPPORTED）/)
    await assert.rejects(harness.runtime.push({ sessionId: SESSION_ID, voice: '' }), /INVALID_PUSH|voice/)
})

test('模型请求开始重试：对方最近一条还没收到回复时告诉一声，之后的回复照常回这条；已有回复或无关类别不发', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-stall', text: '请处理这个请求' },
        anchorOf('m-stall'),
    )
    await settle(harness.runtime)
    assert.deepEqual(await harness.runtime.noticeStall({ sessionId: SESSION_ID, code: 'AGENT_SDK_TURN_FAILED' }), { status: 'skipped' })
    const noticed = await harness.runtime.noticeStall({ sessionId: SESSION_ID, code: 'TRANSPORT' })
    assert.deepEqual(noticed, { status: 'sent', platform: 'qq' })
    assert.match(harness.qq.state.sends[0].text, /网络断了.*不用重发/)
    assert.equal(outgoingRows(harness)[0].system, 'stall', '渠道自己的固定说明，带 system 标记')
    // 同一条消息已经收到过说明：再次断网不重复告诉。
    assert.deepEqual(await harness.runtime.noticeStall({ sessionId: SESSION_ID, code: 'RATE_LIMIT' }), { status: 'skipped' })
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-stall' }], assistants: [{ text: '已经处理好了' }] })
    await settle(harness.runtime)
    const sends = harness.qq.state.sends
    assert.equal(sends.length, 2)
    assert.equal(sends[1].text, '已经处理好了')
    assert.ok(sends.every(send => send.anchor.messageId === 'm-stall'))
    assert.deepEqual(await harness.runtime.noticeStall({ sessionId: 'session-other', code: 'TRANSPORT' }), { status: 'skipped' })
})

test('早已发完的旧批不因锚点后来用掉的额度补出留待片，也不重发', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-old', text: '旧问题' },
        anchorOf('m-old'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-old' }], assistants: [{ text: 'z'.repeat(1500) }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 2)
    const [first] = outgoingRows(harness)
    // 同一锚点上另有别批（例如转交的回复）用掉的额度：旧批按现在的剩余额度算会“超额”。
    for (let index = 0; index < 3; index += 1) {
        await harness.tables.domain.table('outgoing').put(`delivery-other-${index}`, {
            ...first, turn: 99, endSeq: 990 + index, partIndex: 0, partCount: 1, text: `别批 ${index}`, state: 'sent',
        })
    }
    harness.runtime.wake(SESSION_ID)
    await settle(harness.runtime)
    await options.onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-new', text: '新问题' },
        anchorOf('m-new'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-new' }], assistants: [{ text: '新回复' }] })
    await settle(harness.runtime)
    assert.deepEqual(outgoingRows(harness).filter(row => row.deferred === true), [])
    assert.deepEqual(harness.qq.state.sends.slice(2).map(send => send.text), ['新回复'])
})

/* ------------------------------------------------------------------ *
 * 测试聊天（chat）
 * ------------------------------------------------------------------ */

/** 一秒静音的 16 位单声道 WAV。 */
async function silentWav() {
    const pcm = Buffer.alloc(16000 * 2)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16000, 24)
    header.writeUInt32LE(32000, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(pcm.length, 40)
    const path = join(await mkdtemp(join(tmpdir(), 'channel-voice-')), 'say.wav')
    await writeFile(path, Buffer.concat([header, pcm]))
    return path
}

function fromAccount(harness, messageId, text = '测试聊天') {
    return listenOptions(harness.account.state).onMessage(
        { kind: 'private', platform: 'chat', accountId: 'account-qa', conversationId: 'owner-qa', senderId: 'owner-qa', messageId, text },
        anchorOf(messageId, { userId: 'owner-qa' }),
    )
}

function fromOfficialQQ(harness, messageId, text = 'QQ') {
    return listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-qq', conversationId: 'owner-qq', senderId: 'owner-qq', messageId, text },
        anchorOf(messageId),
    )
}

async function accountHarness(t, runtime = {}) {
    const harness = await createHarness({
        account: true,
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'qq', accountId: 'account-qq', senderId: 'owner-qq' })
            await seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' })
        },
        runtime: { qqRelayWindowMs: 50 * 60_000, ...runtime },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    return harness
}

test('测试聊天：没有回复次数限制，长回复一次发完、不留待；发不了语音，改成音频文件发出', async (t) => {
    const harness = await accountHarness(t)
    await fromAccount(harness, 'a-long', '长回复')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-long' }], assistants: [{ text: 'x'.repeat(5500) }] })
    await settle(harness.runtime)
    assert.equal(harness.account.state.sends.length, 6)
    assert.equal(outgoingRows(harness).filter(row => row.deferred === true).length, 0)
    assert.ok(harness.account.state.sends.every(send => !send.text.includes('QQ 每条消息只能回')), '没有额度说明')
    assert.equal(harness.qq.state.sends.length, 0)

    const voice = await silentWav()
    const pushed = await harness.runtime.push({ sessionId: SESSION_ID, voice })
    assert.equal(pushed.platform, 'chat')
    assert.equal(pushed.repliesLeft, null)
    const last = harness.account.state.sends.at(-1)
    assert.equal(last.voice, undefined, '不把语音交给发不了的平台')
    assert.equal(last.file?.name, 'say.wav', '能发文件：语音改成音频文件发出')
    assert.equal(last.file?.path, voice)
})

test('测试聊天连接状态：断开时状态显示未连接，恢复后显示连着', async (t) => {
    const harness = await accountHarness(t)
    await fromOfficialQQ(harness, 'q-1')
    await settle(harness.runtime)
    harness.advance(60_000)
    await fromAccount(harness, 'a-1')
    await settle(harness.runtime)
    assert.equal(channel(harness, 'chat').connected, true)
    listenOptions(harness.account.state).onLive(false)
    assert.equal(channel(harness, 'chat').connected, false)
    listenOptions(harness.account.state).onLive(true)
    assert.equal(channel(harness, 'chat').connected, true)
})

test('重连一次（Watchdog）：停掉断开的连接、重新连上；没有绑定的平台不动，未装配的平台报错', async (t) => {
    const harness = await accountHarness(t)
    assert.equal(harness.account.state.listens.length, 1)
    listenOptions(harness.account.state).onLive(false)
    assert.equal(channel(harness, 'chat').connected, false)
    assert.deepEqual(await harness.runtime.reconnect('chat'), { status: 'reconnecting' })
    await waitFor(() => harness.account.state.listens.length === 2 && channel(harness, 'chat').connected, '重新连上')
    assert.equal(harness.account.state.listens[0].signal.aborted, true, '旧连接已停')
    assert.equal(harness.qq.state.listens.length, 1, '别的平台不动')
    assert.deepEqual(await harness.runtime.reconnect('weixin'), { status: 'unbound' })
    await assert.rejects(harness.runtime.reconnect('telegram'), { code: 'UNKNOWN_PLATFORM' })
})

test('测试聊天掉线告警：断开超过时限经官方 QQ 发一次；当时没有可用锚点就等对方从官方 QQ 说话后再发', async (t) => {
    const harness = await accountHarness(t, { downAlarmMs: 10 * 60_000 })
    await fromAccount(harness, 'a-1')
    await settle(harness.runtime)
    listenOptions(harness.account.state).onLive(false)
    harness.advance(11 * 60_000)
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 0, '官方 QQ 没有锚点：不发')
    assert.equal(harness.account.state.sends.length, 0, '不往断开的测试聊天发')
    assert.equal(outgoingRows(harness).filter(row => row.push === true).length, 0, '不留下未送达记录')

    await fromOfficialQQ(harness, 'q-1', '怎么不回了')
    await settle(harness.runtime)
    assert.deepEqual(harness.qq.state.sends.map(send => send.text), [downNoticeOf('测试聊天', true)])
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 1, '一次断开只告警一次')
})

test('测试聊天掉线告警：官方 QQ 的回复次数用完、微信还在上下文里时改经微信发出，不再等对方说话', async (t) => {
    const harness = await createHarness({
        account: true,
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'qq', accountId: 'account-qq', senderId: 'owner-qq' })
            await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' })
            await seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' })
        },
        runtime: { qqRelayWindowMs: 50 * 60_000, downAlarmMs: 10 * 60_000 },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.weixin.state).onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'w-1', text: '微信' },
        anchorOf('w-1', { contextToken: 'ct-w-1' }),
    )
    await settle(harness.runtime)
    harness.advance(60_000)
    await fromOfficialQQ(harness, 'q-1')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-q-1' }], assistants: [{ text: 'a'.repeat(3500) }] })
    await settle(harness.runtime)
    const qqSends = harness.qq.state.sends.length
    harness.advance(60_000)
    await fromAccount(harness, 'a-1')
    await settle(harness.runtime)
    listenOptions(harness.account.state).onLive(false)
    harness.advance(11 * 60_000)
    await settle(harness.runtime)
    assert.deepEqual(harness.weixin.state.sends.map(send => send.text).filter(text => text === downNoticeOf('测试聊天', true)), [downNoticeOf('测试聊天', true)])
    assert.equal(harness.qq.state.sends.length, qqSends, '官方 QQ 没有额度，不往那里发')
})

test('测试聊天配对：用真实的中枢准入 helper，验证码填对后绑定、连接并结束这次尝试', async (t) => {
    const harness = await createHarness({ account: true, createIngress: createMainTextIngress })
    t.after(async () => {
        await harness.runtime.close()
    })
    harness.account.state.pairImpl = async options => {
        const code = await options.getVerifyCode({ signal: options.signal })
        assert.equal(code, '123456')
        return [{ platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa', credential: { url: 'ws://bridge', token: 't', accountId: 'account-qa', ownerId: 'owner-qa' } }]
    }
    const { attemptId } = await harness.runtime.beginPair('chat')
    await waitFor(() => channel(harness, 'chat').phase === 'need-verify', '等验证码')
    await harness.runtime.verifyCode({ platform: 'chat', attemptId, code: '123456' })
    await waitFor(() => channel(harness, 'chat').pairAttemptId === null, '尝试结束')
    await waitFor(() => channel(harness, 'chat').connected, '已连接')
    const view = channel(harness, 'chat')
    assert.equal(view.errorCode, null)
    assert.equal(view.accountId, 'account-qa')
    assert.equal(harness.account.state.listens.length, 1, '配对后开始收件')
    assert.equal(harness.tables.maps.bindings.get('chat').enabled, true)
})

test('配对保存卡住：超过时限结束这次尝试并报 PAIR_SAVE_TIMEOUT；晚到的保存停用它写下的绑定', async (t) => {
    const harness = await createHarness({ account: true, runtime: { pairCommitTimeoutMs: 20 } })
    t.after(async () => {
        await harness.runtime.close()
    })
    harness.account.state.pairImpl = async () => [
        { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa', credential: { url: 'ws://bridge', token: 't', accountId: 'account-qa', ownerId: 'owner-qa' } },
    ]
    const stuck = deferred()
    harness.credentials.hooks.beforeRead = () => stuck.promise
    await harness.runtime.beginPair('chat')
    await new Promise(resolve => setTimeout(resolve, 60))
    await flush()
    const view = channel(harness, 'chat')
    assert.equal(view.pairAttemptId, null, '尝试已结束，不会一直停在连接中')
    assert.equal(view.phase, 'error')
    assert.equal(view.errorCode, 'PAIR_SAVE_TIMEOUT')
    // 卡住的保存不再占着配对链：断开照常完成。
    assert.deepEqual(await harness.runtime.disconnect('chat'), { status: 'disconnected' })
    assert.equal(harness.tables.maps.bindings.get('chat'), undefined)

    harness.credentials.hooks.beforeRead = null
    stuck.resolve()
    for (let index = 0; index < 20; index += 1) await flush()
    assert.equal(harness.tables.maps.bindings.get('chat'), undefined, '晚到的保存不会复活已断开的绑定')
    assert.equal(harness.account.state.listens.length, 0, '不开始收件')
})

test('已保存的测试聊天绑定重启后直接用真实准入 helper 连上，不用重新配对', async (t) => {
    const harness = await createHarness({
        account: true,
        createIngress: createMainTextIngress,
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' }),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await waitFor(() => channel(harness, 'chat').connected, '已连接')
    assert.equal(channel(harness, 'chat').errorCode, null)
    assert.equal(harness.account.state.listens.length, 1)
})

/* ------------------------------------------------------------------ *
 * 测试聊天群：一个群对应一个项目会话
 * ------------------------------------------------------------------ */

const PROJECT_SESSION = 'session-project-yuanhang'
/** 测试用的群解析规则：群「项目-远航」接远航的项目会话；别的「项目-」群说明没有这个项目；其余不管（返回 null）。 */
const voyageResolver = async ({ groupName }) => {
    if (groupName === '项目-远航') return { sessionId: PROJECT_SESSION, sessionTitle: '远航·项目会话' }
    return groupName.startsWith('项目-') ? { reason: '没有这个项目' } : null
}

/** 中枢绑着测试聊天私聊，另登记一个「远航·项目会话」；准入按绑定的会话插进对应会话。 */
async function groupHarness(t, options = {}) {
    const project = createChatSession(PROJECT_SESSION)
    const harness = await createHarness({
        account: true,
        accountPlatform: options.accountPlatform,
        extraChats: [project],
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, {
                platform: 'chat',
                accountId: options.accountId ?? 'account-qa',
                senderId: options.senderId ?? 'owner-qa',
                ...options.credential === undefined ? {} : { credential: options.credential },
            })
        },
        admit: async (message, binding, spliceMain) => {
            const original = binding.sessionId === PROJECT_SESSION
                ? project.appendSpliced(`native-${message.messageId}`, `req-${message.messageId}`, message.text)
                : spliceMain(message.messageId, message.text)
            return { status: 'accepted', sessionId: binding.sessionId, requestId: `req-${message.messageId}`, messageId: original.id, seq: original.seq }
        },
        runtime: {
            resolveGroup: voyageResolver,
            ...options.runtime,
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    return { harness, project }
}

function fromGroup(harness, messageId, text, { groupName = '项目-远航', group = '777', images } = {}) {
    return listenOptions(harness.account.state).onMessage(
        { kind: 'group', platform: 'chat', accountId: 'account-qa', conversationId: `group:${group}`, senderId: 'owner-qa', messageId, text, groupName, ...images === undefined ? {} : { images } },
        { groupId: group, messageId },
    )
}

test('测试聊天群：群名「项目-远航」第一次说话就绑定到远航的项目会话；群里的话进项目会话，回复、中途发送、转交都发回群', async (t) => {
    const { harness, project } = await groupHarness(t)
    const owner = harness.tables.maps.bindings.get('chat')
    await fromGroup(harness, 'g-1', '第三章再看看')
    const group = harness.tables.maps.bindings.get('chat-group-777')
    assert.equal(group.sessionId, PROJECT_SESSION)
    assert.equal(group.conversationId, 'group:777')
    assert.equal(group.ownerBindingId, owner.bindingId)
    assert.deepEqual([group.groupName, group.sessionTitle, group.projectTitle], ['项目-远航', '远航·项目会话', undefined])
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-g-1')?.text, '第三章再看看')
    assert.equal(harness.chat.spliceOf('req-g-1'), undefined, '不进中枢')

    project.addTurn({ inputs: [{ rpcId: 'req-g-1' }], assistants: [{ text: '第三章的问题在这里' }] })
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => [send.peerId, send.text]), [['group:777', '第三章的问题在这里']])

    const pushed = await harness.runtime.push({ sessionId: PROJECT_SESSION, text: '进度：改完了' })
    assert.equal(pushed.platform, 'chat')
    assert.equal(harness.account.state.sends.at(-1).peerId, 'group:777')
    // 接群会话里没有渠道输入的轮：去向是 {to:'exit'} 或代用户的发到群里；别的会话、程序开的轮不外发。
    const sendsBefore = harness.account.state.sends.length
    project.addTurn({ inputs: [{ rpcId: 'main-said-1', text: '中枢转来的话' }], assistants: [{ text: '不外发' }], route: { to: 'origin' } })
    await settle(harness.runtime)
    assert.equal(harness.account.state.sends.length, sendsBefore, '别的会话开的一轮不外发')
    project.addTurn({ inputs: [{ rpcId: 'main-said-2', text: '在群里说一声' }], assistants: [{ text: '初稿好了' }], route: { to: 'exit' } })
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.slice(sendsBefore).map(send => [send.peerId, send.text]), [['group:777', '初稿好了']], '要发到出口的发到群里')
    project.addTurn({ inputs: [{ rpcId: 'schedule-1', text: '到点了' }], assistants: [{ text: '提醒：开会' }], route: { onBehalfOfUser: true } })
    project.addTurn({ inputs: [{ rpcId: 'main-said-3', text: '等一下' }], assistants: [{ text: '[等待]' }], route: { to: 'exit' } })
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.slice(sendsBefore + 1).map(send => [send.peerId, send.text]), [['group:777', '提醒：开会']], '代用户的发到群里；等待标记不发')

    assert.deepEqual(channel(harness, 'chat').groups, [{ groupId: '777', name: '项目-远航', session: '远航·项目会话', sessionId: PROJECT_SESSION, gone: null }])
    assert.ok(harness.runtime.boundSessionIds().has(PROJECT_SESSION), '项目会话也拿到等待约定')

    // 私聊照旧进中枢，回复发到私聊。
    await fromAccount(harness, 'a-1', '私聊')
    await settle(harness.runtime)
    assert.equal(harness.chat.spliceOf('req-a-1')?.text, '私聊')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '私聊回复' }] })
    await settle(harness.runtime)
    assert.equal(harness.account.state.sends.at(-1).peerId, 'owner-qa')
})

test('测试聊天群：同一本机消息号在私聊与群里是两条消息，各记在自己的绑定下；重推的重复只收一次；群绑定没有游标', async (t) => {
    const { harness, project } = await groupHarness(t)
    await fromGroup(harness, 'group:777/7703900000000000005', '群里')
    await fromAccount(harness, 'private:owner-qa/7703900000000000005', '私聊')
    await fromGroup(harness, 'group:777/7703900000000000005', '群里')
    const group = harness.tables.maps.bindings.get('chat-group-777')
    const owner = harness.tables.maps.bindings.get('chat')
    assert.equal('cursor' in group, false)
    const rows = [...harness.tables.maps.incoming.values()].map(row => [row.bindingId, row.platformMessageId])
    assert.deepEqual(rows.sort(), [
        [group.bindingId, 'group:777/7703900000000000005'],
        [owner.bindingId, 'private:owner-qa/7703900000000000005'],
    ].sort())
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-group:777/7703900000000000005')?.text, '群里')
    assert.equal(harness.chat.spliceOf('req-private:owner-qa/7703900000000000005')?.text, '私聊')
})

test('收件答复：私聊存下 persisted、重复 duplicate；群绑不上（没有项目）rejected；宿主暂时查不了项目 retry，之后查得了 persisted', async (t) => {
    let lookupFails = true
    const { harness, project } = await groupHarness(t, {
        runtime: {
            resolveGroup: async (group) => {
                if (lookupFails) throw new Error('workspace registry is busy')
                return voyageResolver(group)
            },
        },
    })
    assert.deepEqual(await fromAccount(harness, 'a-1', '私聊'), { status: 'persisted' })
    assert.deepEqual(await fromAccount(harness, 'a-1', '私聊'), { status: 'duplicate' })
    assert.deepEqual(await fromGroup(harness, 'g-1', '项目群第一句'), { status: 'retry' })
    assert.equal(harness.tables.maps.bindings.get('chat-group-777'), undefined)
    assert.equal([...harness.tables.maps.incoming.values()].some(row => row.platformMessageId === 'g-1'), false, '没存下')
    lookupFails = false
    assert.deepEqual(await fromGroup(harness, 'g-1', '项目群第一句'), { status: 'persisted' })
    assert.equal(harness.tables.maps.bindings.get('chat-group-777').sessionId, PROJECT_SESSION)
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-g-1')?.text, '项目群第一句')
    assert.deepEqual(await fromGroup(harness, 'x-1', '闲聊', { groupName: '闲聊', group: '888' }), { status: 'rejected' })
    assert.deepEqual(await fromGroup(harness, 'y-1', '没有群名', { groupName: '', group: '999' }), { status: 'retry' })
})

test('测试聊天群：群名不对或没有这个项目时不处理，转交中枢说明一次；再说话不重复说明', async (t) => {
    const { harness } = await groupHarness(t)
    await fromAccount(harness, 'a-1', '先在私聊说一句')
    await settle(harness.runtime)
    await fromGroup(harness, 'x-1', '随便聊', { groupName: '闲聊', group: '888' })
    await fromGroup(harness, 'x-2', '再说一句', { groupName: '闲聊', group: '888' })
    await fromGroup(harness, 'y-1', '这个项目呢', { groupName: '项目-不存在', group: '999' })
    await settle(harness.runtime)
    assert.equal(harness.tables.maps.bindings.get('chat-group-888'), undefined)
    assert.equal(harness.tables.maps.bindings.get('chat-group-999'), undefined)
    const rows = [...harness.tables.maps.incoming.values()]
    assert.ok(!rows.some(row => row.conversationId.startsWith('group:')), '群里的话不留原件')
    const notices = harness.core.delivered.filter(item => item.key.startsWith('group-unbound-'))
    assert.equal(notices.length, 2, '两个群各说明一次')
    assert.ok(notices.every(item => item.sessionId === SESSION_ID && item.source.kind === 'channel-notice' && item.speaker.kind === 'program'), '经核心交给中枢，记成渠道说的')
    assert.deepEqual(notices[0].reply, { onBehalfOfUser: true }, '用户刚在群里说了话：回复立即发')
    assert.ok(notices.some(item => item.text.includes('没有处理：这个群还没接会话。')), '规则不管的群')
    assert.ok(notices.some(item => item.text.includes('没有处理：没有这个项目。')), '规则给的原因照写')
    assert.ok(notices.every(item => item.text.includes('assistant_channel_group')), '告诉中枢怎么手动接')
})

test('测试聊天群：没有群解析规则时不自动接、中枢收到说明；规则可以在运行中设和撤销，已有时再设报错；断开测试聊天时群绑定一起删掉', async (t) => {
    const { harness } = await groupHarness(t)
    await fromGroup(harness, 'g-1', '你好')
    assert.ok(harness.tables.maps.bindings.get('chat-group-777') !== undefined)
    assert.deepEqual(await harness.runtime.disconnect('chat'), { status: 'disconnected' })
    assert.equal(harness.tables.maps.bindings.get('chat-group-777'), undefined)

    const bare = await groupHarness(t, { runtime: { resolveGroup: undefined } })
    assert.deepEqual(await fromGroup(bare.harness, 'g-2', '你好'), { status: 'rejected' })
    assert.equal(bare.harness.tables.maps.bindings.get('chat-group-777'), undefined)
    await settle(bare.harness.runtime)
    const notice = bare.harness.core.delivered.find(item => item.key.startsWith('group-unbound-777-'))
    assert.match(notice.text, /没有处理：这个群还没接会话。[\s\S]*assistant_channel_group/)

    const dispose = bare.harness.runtime.setGroupResolver(voyageResolver)
    assert.throws(() => bare.harness.runtime.setGroupResolver(async () => null), /已经有群解析规则了/)
    assert.deepEqual(await fromGroup(bare.harness, 'g-3', '再说一句'), { status: 'persisted' })
    assert.equal(bare.harness.tables.maps.bindings.get('chat-group-777').sessionId, PROJECT_SESSION)
    dispose()
    const again = bare.harness.runtime.setGroupResolver(async () => null)
    again()
})

test('旧版写下的投递记录照样打得开：0.1.0-preview.1 带 sentText 的记录过得了严格的结构（去掉这个字段曾让渠道起不来）', () => {
    const legacy = {
        bindingId: 'binding-1', sessionId: 'session-hub', turn: 12, endSeq: 40, sourceSeqs: [38], inputRequestIds: ['channel-ingress:1:abc'],
        partIndex: 0, partCount: 1, mainTurn: true, text: '见 https://example.com/a', sentText: '见 （链接见电脑）',
        anchorKey: 'galatea-channels/anchor-1', state: 'sent',
        receipt: { kind: 'platform-accepted', platformMessageId: 'msg-1', clientId: null }, errorCode: null,
    }
    const parsed = channelTableSchemas.outgoing.parse(legacy)
    assert.equal(parsed.text, legacy.text)
})

test('网址照原文发：交给平台的是原文，投递记录里也只有原文', async (t) => {
    const linked = '参考 [这篇](https://arxiv.org/pdf/1) 和 https://www.youtube.com/watch?v=x'
    const harness = await accountHarness(t)
    await fromOfficialQQ(harness, 'q-link', '官方提问')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-q-link' }], assistants: [{ text: linked }] })
    await settle(harness.runtime)
    assert.deepEqual(harness.qq.state.sends.map(send => send.text), [linked], '交给平台的是原文')
    const row = outgoingRows(harness).find(item => item.bindingId === harness.tables.maps.bindings.get('qq').bindingId && item.state === 'sent')
    assert.equal(row.text, linked)
    assert.equal('sentText' in row, false)
})

test('没写文字的说明只给这次启动之后结束的轮：之前结束的空轮不补发', async (t) => {
    let clock = 1_000_000
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'qq', accountId: 'account-qq', senderId: 'owner-qq' })
        },
        runtime: { now: () => (clock += 1) },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-qq', conversationId: 'owner-qq', senderId: 'owner-qq', messageId: 'm-qq', text: 'QQ 提问' },
        anchorOf('m-qq'),
    )
    await settle(harness.runtime)
    // 会话事件的时间（1000 起）早于运行态启动：当作升级前就结束的轮。
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-qq' }], assistants: [{ blocks: [{ type: 'reasoning', text: '思考过程' }] }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 0)
})

test('只发最后一段：升级前按整轮全部文字开始投递的一批按旧规则续发，不判成来源变化', async (t) => {
    const harness = await accountHarness(t)
    await fromAccount(harness, 'a-whole', '测试聊天提问')
    await settle(harness.runtime)
    const before = '过程'.repeat(200)
    const final = '结'.repeat(1500)
    harness.chat.addTurn({
        inputs: [{ rpcId: 'req-a-whole' }],
        assistants: [{ blocks: [{ type: 'text', text: before }, { type: 'text', text: final }] }],
    })
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), splitReplyText(final, 1000), '新规则只发最后一段')
    // 改成"旧版本按整轮全部文字切成三片、发了第一片、第二片已记下还没发"的样子。
    const whole = splitReplyText(`${before}\n${final}`, 1000)
    assert.equal(whole.length, 3)
    const rows = [...harness.tables.maps.outgoing.entries()].filter(([, row]) => row.partCount === 2)
    assert.equal(rows.length, 2)
    for (const [deliveryId, row] of rows) {
        harness.tables.maps.outgoing.set(deliveryId, {
            ...row,
            partCount: whole.length,
            text: whole[row.partIndex],
            ...row.partIndex === 1 ? { state: 'prepared', receipt: null, errorCode: null } : {},
        })
    }
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.slice(2).map(send => send.text), whole.slice(1), '按旧规则续发其余两片')
    assert.ok(outgoingRows(harness).every(row => row.errorCode !== 'SOURCE_CHANGED'))
})

test('有发送节奏的平台（适配器的 paceMs）按节奏等待后发出：第一片不扣已过去的时间，之后扣；没有节奏的官方 QQ 只保留常规间隔', async (t) => {
    const waits = []
    const harness = await accountHarness(t, { sleep: async milliseconds => { waits.push(milliseconds) } })
    await fromAccount(harness, 'a-pace', '测试聊天提问')
    await settle(harness.runtime)
    waits.length = 0
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-pace' }], assistants: [{ text: 'x'.repeat(2500) }] })
    await settle(harness.runtime)
    assert.equal(harness.account.state.sends.length, 3)
    const paced = waits.filter(milliseconds => milliseconds > 0)
    assert.equal(paced.length, 3, '每片发出前都等')
    assert.equal(paced[0], CHAT_PACE.first, '第一片按节奏等，不扣已过去的时间')
    assert.ok(paced.slice(1).every(milliseconds => milliseconds > CHAT_PACE.next - 100 && milliseconds <= CHAT_PACE.next), `后续扣掉已过去的时间 ${paced}`)

    harness.advance(60_000)
    await fromOfficialQQ(harness, 'q-pace', '官方提问')
    await settle(harness.runtime)
    waits.length = 0
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-q-pace' }], assistants: [{ text: 'y'.repeat(2500) }] })
    await settle(harness.runtime)
    assert.ok(waits.every(milliseconds => milliseconds <= 2000), `官方 QQ 只有常规间隔 ${waits}`)
})

test('节奏在每个绑定自己的后台投递里等：不挡官方 QQ 的收发；wake 等到它发完', async (t) => {
    let release
    const gate = new Promise(resolve => {
        release = resolve
    })
    let holding = false
    const harness = await accountHarness(t, {
        sleep: async milliseconds => {
            if (holding && milliseconds >= 500) await gate
        },
    })
    await fromAccount(harness, 'a-slow', '测试聊天提问')
    await settle(harness.runtime)
    holding = true
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-slow' }], assistants: [{ text: '测试聊天的回复' }] })
    let woke = false
    const waking = harness.runtime.wake().then(() => {
        woke = true
    })
    await flush()
    await fromOfficialQQ(harness, 'q-fast', '官方提问')
    await waitFor(() => incomingRows(harness).some(([, row]) => row.platformMessageId === 'q-fast' && row.state === 'accepted'), '官方 QQ 的话已准入')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-q-fast' }], assistants: [{ text: '官方的回复' }] })
    harness.runtime.wake().catch(() => {})
    await waitFor(() => harness.qq.state.sends.length === 1, '官方 QQ 的回复不等测试聊天')
    assert.equal(harness.account.state.sends.length, 0, '测试聊天还在等')
    assert.equal(woke, false, 'wake 等测试聊天发完')
    release()
    await waking
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['测试聊天的回复'])
})

/* ------------------------------------------------------------------ *
 * 测试聊天群接任意会话、一句话改绑、会话不在了、任务进度
 * ------------------------------------------------------------------ */

const OTHER_SESSION = 'session-shilishu'
const PNG = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }

/** 中枢绑着测试聊天私聊，另登记「远航·项目会话」与另一个普通会话；测试聊天在三个群里。 */
async function sessionsHarness(t, options = {}) {
    const project = createChatSession(PROJECT_SESSION)
    const other = createChatSession(OTHER_SESSION)
    const archived = new Set()
    const harness = await createHarness({
        account: true,
        extraChats: [project, other],
        session: options.session,
        fakeCore: options.fakeCore,
        // 重开用例传入上一个运行态的持久表与凭据：绑定已在里面，不再预置。
        tables: options.tables,
        credentials: options.credentials,
        seed: options.tables !== undefined ? undefined : async ({ tables, credentials }) => {
            const { binding } = await seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' })
            await options.seed?.({ tables, owner: binding })
        },
        admit: async (message, binding, spliceMain) => {
            const hooked = await options.admitHook?.(message, binding)
            if (hooked !== undefined) return hooked
            const fixture = binding.sessionId === PROJECT_SESSION ? project : binding.sessionId === OTHER_SESSION ? other : null
            const original = fixture === null
                ? spliceMain(message.messageId, message.text)
                : fixture.appendSpliced(`native-${message.messageId}`, `req-${message.messageId}`, message.text)
            return { status: 'accepted', sessionId: binding.sessionId, requestId: `req-${message.messageId}`, messageId: original.id, seq: original.seq }
        },
        runtime: {
            resolveGroup: voyageResolver,
            isArchived: async id => archived.has(id),
            ...options.runtime,
        },
    })
    harness.account.state.groupList = [{ groupId: '777', name: '项目-远航' }, { groupId: '888', name: '闲聊' }, { groupId: '999', name: '示例书讨论' }]
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    return { harness, project, other, archived }
}

function sendsTo(harness, peerId) {
    return harness.account.state.sends.filter(send => send.peerId === peerId).map(send => send.text)
}

/** 转到中枢的群消息（经核心交给中枢的）。 */
function movedRows(harness) {
    return harness.core.delivered.filter(item => item.key.startsWith('group-moved-'))
}

/** 交给某个会话准入的正文（按准入顺序）。 */
function admittedTexts(harness, prefix) {
    return harness.ingressLog.admits.filter(entry => entry.message.messageId.startsWith(prefix)).map(entry => entry.message)
}

test('群接任意会话：中枢把一个名字随意的群接到普通会话，群里的话进它、回复发回群；群里收到绑定确认（系统行）', async (t) => {
    const { harness, other } = await sessionsHarness(t)
    const result = await harness.runtime.bindGroup({ caller: SESSION_ID, group: '闲聊', sessionId: OTHER_SESSION, sessionTitle: '示例书·项目会话' })
    assert.equal(result.status, 'bound')
    assert.equal(result.groupId, '888')
    assert.equal(result.confirmed, true)
    const row = harness.tables.maps.bindings.get('chat-group-888')
    assert.equal(row.sessionId, OTHER_SESSION)
    assert.equal(row.sessionTitle, '示例书·项目会话')
    assert.equal(row.groupName, '闲聊')
    assert.equal(row.ownerBindingId, harness.tables.maps.bindings.get('chat').bindingId)
    assert.deepEqual(sendsTo(harness, 'group:888'), [GROUP_NOTICES.bound('示例书·项目会话')])
    const confirmation = outgoingRows(harness).find(item => item.system === 'group')
    assert.equal(confirmation.push, true)
    assert.equal(confirmation.state, 'sent')

    await fromGroup(harness, 'g-1', '第一章', { groupName: '闲聊', group: '888' })
    await settle(harness.runtime)
    assert.equal(other.spliceOf('req-g-1')?.text, '第一章')
    other.addTurn({ inputs: [{ rpcId: 'req-g-1' }], assistants: [{ text: '收到' }] })
    await settle(harness.runtime)
    assert.equal(sendsTo(harness, 'group:888').at(-1), '收到')
    assert.deepEqual(harness.runtime.groupOfSession(OTHER_SESSION), { groupId: '888', name: '闲聊', label: '测试聊天' })
    assert.equal(harness.runtime.groupOfSession(SESSION_ID), null)
    assert.deepEqual(harness.runtime.exitSessions().find(item => item.as === 'hub'), { sessionId: SESSION_ID, as: 'hub' }, '中枢就是中枢')
    assert.deepEqual(channel(harness, 'chat').groups, [{ groupId: '888', name: '闲聊', session: '示例书·项目会话', sessionId: OTHER_SESSION, gone: null }])
    assert.equal((await harness.runtime.bindGroup({ caller: SESSION_ID, group: '888', sessionId: OTHER_SESSION })).status, 'same')
})

test('群的系统说明没送到时不进那个会话的未送达说明', async (t) => {
    const { harness, other } = await sessionsHarness(t)
    harness.account.state.sendImpl = async () => {
        throw Object.assign(new Error('平台拒收'), { code: 'SEND_FAILED', definitelyRejected: true })
    }
    const result = await harness.runtime.bindGroup({ caller: SESSION_ID, group: '888', sessionId: OTHER_SESSION, sessionTitle: '示例书' })
    assert.equal(result.confirmed, false)
    assert.equal(outgoingRows(harness).find(item => item.system === 'group').state, 'failed')
    harness.account.state.sendImpl = async () => ({ kind: 'platform-accepted', platformMessageId: 'pm', clientId: null })
    await fromGroup(harness, 'g-1', '第一章', { groupName: '闲聊', group: '888' })
    await settle(harness.runtime)
    assert.equal(other.spliceOf('req-g-1')?.text, '第一章', '正文后面没有接“渠道提示”')
})

test('群一对一：会话已接别的群时拒绝，带 replace 时先解绑那个群（它收到解绑确认）；两个群同时接同一个会话只成一个', async (t) => {
    const { harness } = await sessionsHarness(t)
    const bind = request => harness.runtime.bindGroup({ caller: SESSION_ID, ...request })
    assert.equal((await bind({ group: '888', sessionId: OTHER_SESSION, sessionTitle: '示例书' })).status, 'bound')
    const taken = await bind({ group: '999', sessionId: OTHER_SESSION, sessionTitle: '示例书' })
    assert.equal(taken.reason, 'SESSION_TAKEN')
    assert.equal(taken.group.groupId, '888')
    assert.equal(harness.tables.maps.bindings.get('chat-group-999'), undefined)

    const replaced = await bind({ group: '999', sessionId: OTHER_SESSION, sessionTitle: '示例书', replace: true })
    assert.equal(replaced.status, 'bound')
    assert.equal(replaced.replaced.groupId, '888')
    const old = harness.tables.maps.bindings.get('chat-group-888')
    assert.equal(old.enabled, false)
    assert.equal(typeof old.unboundAt, 'number')
    assert.equal(sendsTo(harness, 'group:888').at(-1), GROUP_NOTICES.unbound())
    assert.equal(sendsTo(harness, 'group:999').at(-1), GROUP_NOTICES.bound('示例书'))
    assert.equal(harness.tables.maps.bindings.get('chat-group-999').sessionId, OTHER_SESSION)

    const both = await Promise.all([
        bind({ group: '777', sessionId: PROJECT_SESSION }),
        bind({ group: '888', sessionId: PROJECT_SESSION }),
    ])
    assert.deepEqual(both.map(item => item.status).sort(), ['bound', 'refused'])
    assert.equal(both.find(item => item.status === 'refused').reason, 'SESSION_TAKEN')
})

test('群改绑：原地换会话——绑定身份不变，旧会话的等待作废，群里收到改接确认；还没准入的话跟着进新会话', async (t) => {
    const { harness, project, other } = await sessionsHarness(t, { runtime: { mergeTextMs: 12_000, waitTimeoutMs: 180_000 } })
    await fromGroup(harness, 'g-1', '先说一句')
    harness.advance(13_000)
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-g-1')?.text, '先说一句')
    project.addTurn({ inputs: [{ rpcId: 'req-g-1' }], assistants: [{ text: '[等待]' }] })
    await settle(harness.runtime)
    const before = harness.tables.maps.bindings.get('chat-group-777')
    assert.equal(outgoingRows(harness).find(row => row.kind === 'wait').waitState, 'waiting')

    // 群接的会话（远航）在群里被要求“改绑到示例书”：不写 group 就是自己的群。
    const moved = await harness.runtime.bindGroup({ caller: PROJECT_SESSION, sessionId: OTHER_SESSION, sessionTitle: '示例书·项目会话' })
    assert.equal(moved.status, 'rebound')
    assert.equal(moved.previous.sessionId, PROJECT_SESSION)
    const after = harness.tables.maps.bindings.get('chat-group-777')
    assert.equal(after.bindingId, before.bindingId)
    assert.equal(after.sessionId, OTHER_SESSION)
    assert.equal(after.projectTitle, undefined)
    assert.equal(outgoingRows(harness).find(row => row.kind === 'wait').waitState, 'superseded', '旧会话的等待不再提醒新会话')
    assert.equal(sendsTo(harness, 'group:777').at(-1), GROUP_NOTICES.rebound('示例书·项目会话'))

    // 改接之后到的话进新会话（准入助手按新会话重建）。
    await fromGroup(harness, 'g-2', '改接以后的话')
    harness.advance(13_000)
    await settle(harness.runtime)
    assert.equal(other.spliceOf('req-g-2')?.text, '改接以后的话')
    assert.equal(project.spliceOf('req-g-2'), undefined)

    // 还在合并等待里的话，改绑后跟着进新会话。
    await fromGroup(harness, 'g-3', '还没交出去的话')
    assert.equal((await harness.runtime.bindGroup({ caller: SESSION_ID, group: '777', sessionId: PROJECT_SESSION, sessionTitle: '远航·项目会话' })).status, 'rebound')
    harness.advance(13_000)
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-g-3')?.text, '还没交出去的话')
    assert.equal(other.spliceOf('req-g-3'), undefined)
})

test('群绑定工具的调用者与目标：没接群的会话只能把群接到自己；接着群的会话只动自己的群；任务会话、中枢、归档与打不开的会话都不行', async (t) => {
    const { harness, archived } = await sessionsHarness(t)
    const bind = request => harness.runtime.bindGroup(request)
    const reason = result => result.reason
    assert.equal(reason(await bind({ caller: OTHER_SESSION, group: '888', sessionId: PROJECT_SESSION })), 'SELF_ONLY')
    assert.equal((await bind({ caller: OTHER_SESSION, group: '闲聊', sessionId: OTHER_SESSION, sessionTitle: '示例书' })).status, 'bound')
    assert.equal(reason(await bind({ caller: OTHER_SESSION, group: '999', sessionId: OTHER_SESSION })), 'GROUP_NOT_OWN')
    assert.equal(reason(await harness.runtime.unbindGroup({ caller: OTHER_SESSION, group: '777' })), 'GROUP_NOT_OWN')
    assert.equal(reason(await bind({ caller: 'session-task-abc', group: '999', sessionId: 'session-task-abc' })), 'NOT_ALLOWED')
    assert.equal(reason(await bind({ caller: SESSION_ID, group: '999', sessionId: 'session-task-abc' })), 'SESSION_TASK')
    assert.equal(reason(await bind({ caller: SESSION_ID, group: '999', sessionId: SESSION_ID })), 'SESSION_MAIN')
    assert.equal(reason(await bind({ caller: SESSION_ID, group: '999', sessionId: 'session-nowhere' })), 'SESSION_UNKNOWN')
    archived.add(PROJECT_SESSION)
    assert.equal(reason(await bind({ caller: SESSION_ID, group: '999', sessionId: PROJECT_SESSION })), 'SESSION_ARCHIVED')
    archived.delete(PROJECT_SESSION)
    assert.equal(reason(await bind({ caller: SESSION_ID, group: '123', sessionId: PROJECT_SESSION })), 'GROUP_UNKNOWN')
    assert.equal(reason(await bind({ caller: SESSION_ID, group: '没有这个群', sessionId: PROJECT_SESSION })), 'GROUP_UNKNOWN')
    assert.equal(reason(await bind({ caller: PROJECT_SESSION, sessionId: PROJECT_SESSION })), 'GROUP_REQUIRED')
    assert.equal(reason(await harness.runtime.unbindGroup({ caller: PROJECT_SESSION, group: '888' })), 'NOT_ALLOWED')
    harness.account.state.groupList = null
    assert.equal(reason(await bind({ caller: SESSION_ID, group: '999', sessionId: PROJECT_SESSION })), 'NOT_CONNECTED')
    harness.account.state.groupList = [{ groupId: '777', name: '项目-远航' }, { groupId: '888', name: '闲聊' }, { groupId: '999', name: '示例书讨论' }]

    assert.deepEqual((await harness.runtime.listGroups({ caller: OTHER_SESSION })).groups.map(group => group.groupId), ['888'])
    const all = await harness.runtime.listGroups({ caller: SESSION_ID })
    assert.deepEqual(all.groups.map(group => [group.groupId, group.sessionId]), [['888', OTHER_SESSION], ['777', null], ['999', null]])
    assert.equal((await harness.runtime.listGroups({ caller: 'session-task-abc' })).reason, 'NOT_ALLOWED')
})

test('群按群名自动绑定：项目会话已接别的群时不绑、中枢说明一次；解绑过的「项目-」群不被绑回，每次解绑说明一次', async (t) => {
    const { harness } = await sessionsHarness(t)
    await fromAccount(harness, 'a-1', '私聊先说一句')
    await settle(harness.runtime)
    assert.equal((await harness.runtime.bindGroup({ caller: SESSION_ID, group: '888', sessionId: PROJECT_SESSION, sessionTitle: '远航·项目会话' })).status, 'bound')
    await fromGroup(harness, 'g-1', '远航群里说话')
    await fromGroup(harness, 'g-2', '再说一句')
    await settle(harness.runtime)
    assert.equal(harness.tables.maps.bindings.get('chat-group-777'), undefined)
    const takenNotices = harness.core.delivered.filter(item => item.key.startsWith('group-unbound-777-') && !item.key.includes('-at-'))
    assert.equal(takenNotices.length, 1)
    assert.match(takenNotices[0].text, /已经接了别的群/)

    assert.equal((await harness.runtime.unbindGroup({ caller: SESSION_ID, group: '888' })).status, 'unbound')
    await fromGroup(harness, 'g-3', '现在能接上了')
    assert.equal(harness.tables.maps.bindings.get('chat-group-777').sessionId, PROJECT_SESSION)
    const unbound = await harness.runtime.unbindGroup({ group: '777', by: 'settings' })
    assert.equal(unbound.status, 'unbound')
    assert.equal(sendsTo(harness, 'group:777').at(-1), GROUP_NOTICES.unbound())
    await fromGroup(harness, 'g-4', '解绑以后说话')
    await fromGroup(harness, 'g-5', '又说一句')
    await settle(harness.runtime)
    assert.equal(harness.tables.maps.bindings.get('chat-group-777').enabled, false, '没有按群名绑回去')
    const marked = () => harness.core.delivered.filter(item => item.key.startsWith('group-unbound-777-at-'))
    assert.equal(marked().length, 1)
    assert.match(marked()[0].text, /这个群已经解绑/)

    assert.equal((await harness.runtime.bindGroup({ caller: SESSION_ID, group: '777', sessionId: PROJECT_SESSION })).status, 'bound')
    harness.advance(10)
    assert.equal((await harness.runtime.unbindGroup({ caller: SESSION_ID, group: '项目-远航' })).status, 'unbound')
    await fromGroup(harness, 'g-6', '第二次解绑以后')
    await settle(harness.runtime)
    assert.equal(marked().length, 2)
})

test('群接的会话归档：群里本人的话（带图片）转到中枢，即使用户在桌面上；群里只说一次；恢复后照常，再归档再说一次', async (t) => {
    const { harness, project, archived } = await sessionsHarness(t)
    await fromAccount(harness, 'a-1', '私聊先说一句')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '好' }] })
    harness.chat.addTurn({ inputs: [{ rpcId: 'desk-1', text: '桌面上说' }], assistants: [{ text: '嗯' }] })
    await settle(harness.runtime)
    await fromGroup(harness, 'g-1', '先接上')
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-g-1')?.text, '先接上')

    archived.add(PROJECT_SESSION)
    await fromGroup(harness, 'g-2', '这句还在吗', { images: [PNG] })
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-g-2'), undefined)
    assert.equal(movedRows(harness).length, 1)
    const [first] = movedRows(harness)
    assert.match(first.text, /群「项目-远航」（群号 777）[\s\S]*「远航·项目会话」已经归档[\s\S]*这句还在吗/)
    assert.equal(first.images.length, 1, '图片随着交给中枢')
    assert.equal(first.sessionId, SESSION_ID)
    assert.deepEqual(first.speaker, { kind: 'user' }, '群里的话是用户本人说的')
    assert.deepEqual(first.via, { exit: 'chat', label: '测试聊天 群「项目-远航」' })
    const g2 = [...harness.tables.maps.incoming.values()].find(row => row.platformMessageId === 'g-2')
    assert.equal(g2.state, 'forwarded')
    assert.equal(g2.text, null)
    const goneNotice = GROUP_NOTICES.gone('远航·项目会话', 'archived')
    await waitFor(() => sendsTo(harness, 'group:777').includes(goneNotice), '群里说一次')
    assert.equal(harness.tables.maps.bindings.get('chat-group-777').gone.reason, 'archived')
    assert.equal(channel(harness, 'chat').groups[0].gone, 'archived')

    await fromGroup(harness, 'g-3', '再说一句')
    await settle(harness.runtime)
    assert.equal(movedRows(harness).length, 2)
    assert.match(movedRows(harness)[1].text, /^【群「项目-远航」，原会话已不在，转到这里】\n\n再说一句$/)
    assert.equal(sendsTo(harness, 'group:777').filter(text => text === goneNotice).length, 1, '群里只说一次')

    archived.delete(PROJECT_SESSION)
    await fromGroup(harness, 'g-4', '回来了')
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-g-4')?.text, '回来了')
    assert.equal(harness.tables.maps.bindings.get('chat-group-777').gone, undefined)
    archived.add(PROJECT_SESSION)
    await fromGroup(harness, 'g-5', '又归档了')
    await settle(harness.runtime)
    await waitFor(() => sendsTo(harness, 'group:777').filter(text => text === goneNotice).length === 2, '再归档再说一次')
})

test('群接的会话删除时同样转中枢（说明“已经删除”）；只是暂时查不了时不转，原件留着', async (t) => {
    let mode = 'ok'
    const { harness } = await sessionsHarness(t, {
        session: async (id) => {
            if (id !== PROJECT_SESSION || mode === 'ok') return { sessionId: id }
            if (mode === 'deleted') return null
            throw new Error('读取超时')
        },
    })
    await fromAccount(harness, 'a-1', '私聊先说一句')
    await settle(harness.runtime)
    await fromGroup(harness, 'g-1', '先接上')
    await settle(harness.runtime)
    mode = 'flaky'
    await fromGroup(harness, 'g-2', '暂时查不了')
    await settle(harness.runtime)
    const g2 = () => [...harness.tables.maps.incoming.values()].find(row => row.platformMessageId === 'g-2')
    assert.equal(g2().state, 'queued')
    assert.equal(movedRows(harness).length, 0)
    mode = 'deleted'
    await settle(harness.runtime)
    assert.equal(g2().state, 'forwarded')
    assert.match(movedRows(harness)[0].text, /已经删除[\s\S]*暂时查不了/)
    await waitFor(() => sendsTo(harness, 'group:777').includes(GROUP_NOTICES.gone('远航·项目会话', 'deleted')), '群里说已经删除')
})

test('群接的会话不在了、中枢暂时交不了（核心交不出）：原件留着，之后补转', async (t) => {
    let refuse = true
    const { harness, archived } = await sessionsHarness(t, { fakeCore: { deliver: async () => (refuse ? { status: 'unavailable', reason: '中枢取不到' } : { status: 'delivered', messageId: 'm-late' }) } })
    await fromGroup(harness, 'g-1', '先接上')
    await settle(harness.runtime)
    archived.add(PROJECT_SESSION)
    await fromGroup(harness, 'g-2', '还在吗')
    await settle(harness.runtime)
    const g2 = () => [...harness.tables.maps.incoming.values()].find(row => row.platformMessageId === 'g-2')
    assert.equal(g2().state, 'queued')
    assert.equal(movedRows(harness).length, 0)
    assert.equal(sendsTo(harness, 'group:777').length, 0, '还没转走就不在群里说')
    refuse = false
    await fromGroup(harness, 'g-3', '又说一句')
    await settle(harness.runtime)
    assert.equal(g2().state, 'forwarded')
    assert.equal(movedRows(harness).length, 1)
})

test('出口通知（任务进度）发到项目接的群：取第一个接了群的会话；同一键只发一次；事件过期、每群 24 小时 20 条时按规则不发；群接的会话不在了、没有群算没发出；文字照原文交给平台', async (t) => {
    const { harness, archived } = await sessionsHarness(t)
    assert.equal((await harness.runtime.bindGroup({ caller: SESSION_ID, group: '777', sessionId: PROJECT_SESSION })).status, 'bound')
    const notice = (key, extra = {}) => harness.runtime.notify({
        sessionIds: [OTHER_SESSION, PROJECT_SESSION],
        key,
        text: '【任务】开始做「看 https://example.com/a 」。',
        ...extra,
    })
    assert.deepEqual(await notice('t1-r1-start'), { status: 'sent', groupId: '777' })
    // 群说明照原文交给平台：网址怎么发由适配器决定（真实的 QQ 适配器在发送时去掉）。
    assert.equal(sendsTo(harness, 'group:777').at(-1), '【任务】开始做「看 https://example.com/a 」。')
    assert.equal(outgoingRows(harness).filter(row => row.system === 'task').length, 1)
    assert.deepEqual(await notice('t1-r1-start'), { status: 'skipped', reason: 'DUPLICATE' })
    assert.deepEqual(await notice('k-stale', { at: -7 * 60 * 60_000 }), { status: 'skipped', reason: 'STALE' })
    // 没接群：没有可发的地方，不算没发出；接着群、群接的会话不在了，才是没发出。
    assert.deepEqual(await notice('k-none', { sessionIds: [OTHER_SESSION] }), { status: 'skipped', reason: 'NO_GROUP' })
    archived.add(PROJECT_SESSION)
    assert.deepEqual(await notice('k-gone'), { status: 'failed', reason: 'GROUP_GONE' })
    archived.delete(PROJECT_SESSION)
    for (let index = 0; index < 19; index += 1) assert.equal((await notice(`k-cap-${index}`)).status, 'sent')
    assert.deepEqual(await notice('k-cap-over'), { status: 'skipped', reason: 'CAP' })
    harness.advance(24 * 60 * 60_000 + 1)
    assert.equal((await notice('k-next-day')).status, 'sent')
})

test('旧形状的群绑定原样可读、照常收发（显示为「项目·项目会话」）；断开测试聊天时已解绑的群行也删掉', async (t) => {
    const { harness, project } = await sessionsHarness(t, {
        seed: async ({ tables, owner }) => {
            await tables.domain.table('bindings').put('chat-group-777', {
                platform: 'chat',
                bindingId: 'group-old',
                accountId: 'account-qa',
                senderId: 'owner-qa',
                conversationId: 'group:777',
                sessionId: PROJECT_SESSION,
                credentialKey: owner.credentialKey,
                enabled: true,
                createdAt: 2,
                ownerBindingId: owner.bindingId,
                groupName: '项目-远航',
                projectTitle: '远航',
            })
        },
    })
    assert.deepEqual(channel(harness, 'chat').groups, [{ groupId: '777', name: '项目-远航', session: '远航·项目会话', sessionId: PROJECT_SESSION, gone: null }])
    await fromGroup(harness, 'g-1', '旧绑定照常')
    await settle(harness.runtime)
    assert.equal(project.spliceOf('req-g-1')?.text, '旧绑定照常')
    assert.equal((await harness.runtime.unbindGroup({ group: '777', by: 'settings' })).status, 'unbound')
    assert.equal(harness.tables.maps.bindings.get('chat-group-777').enabled, false)
    await harness.runtime.disconnect('chat')
    assert.equal(harness.tables.maps.bindings.get('chat-group-777'), undefined)
})

test('群接的会话归档时，准入结果不明的合并一组整组不转；取消归档后这一组照常核对，后来的话照常进会话（1）', async (t) => {
    let stuck = true
    const { harness, project, archived } = await sessionsHarness(t, {
        runtime: { mergeTextMs: 12_000 },
        // 合并的一组准入结果不明（可能已进了原会话），核对到会话恢复之前一直不明。
        admitHook: async (message, binding) => {
            if (binding.sessionId !== PROJECT_SESSION || message.messageId !== 'g-1' || !stuck) return undefined
            return { status: 'unknown', sessionId: PROJECT_SESSION, requestId: 'req-g-1' }
        },
    })
    await fromAccount(harness, 'a-1', '私聊先说一句')
    await settle(harness.runtime)
    await fromGroup(harness, 'g-1', '第一句')
    await fromGroup(harness, 'g-2', '第二句')
    harness.advance(13_000)
    await settle(harness.runtime)
    const row = id => [...harness.tables.maps.incoming.values()].find(item => item.platformMessageId === id)
    assert.equal(row('g-1').state, 'unknown')
    assert.equal(row('g-2').state, 'queued')
    assert.ok(row('g-2').mergedInto !== undefined, 'g-2 并在 g-1 这一组里')

    archived.add(PROJECT_SESSION)
    await fromGroup(harness, 'g-3', '归档后说的')
    harness.advance(13_000)
    await settle(harness.runtime)
    assert.equal(row('g-3').state, 'forwarded')
    assert.equal(row('g-2').state, 'queued', '结果不明的那一组不拆开转走')
    assert.ok(!movedRows(harness).some(message => message.text.includes('第二句')))

    archived.delete(PROJECT_SESSION)
    stuck = false
    await fromGroup(harness, 'g-4', '恢复以后')
    harness.advance(13_000)
    await settle(harness.runtime)
    assert.equal(row('g-1').state, 'accepted')
    assert.equal(row('g-2').state, 'accepted')
    assert.equal(project.spliceOf('req-g-4')?.text, '恢复以后')
    assert.equal(channel(harness, 'chat').errorCode, null)
})

test('任务进度记下了还没开始发就停机：重启后补调时用同一行发出，只发一次（2）', async (t) => {
    const first = await sessionsHarness(t)
    assert.equal((await first.harness.runtime.bindGroup({ caller: SESSION_ID, group: '777', sessionId: PROJECT_SESSION })).status, 'bound')
    const request = { sessionIds: [PROJECT_SESSION], key: 'task-x-r1-start', text: '【任务】开始做「T」。' }
    // 停机落在“记下 prepared 之后、写 sending 之前”（打字节奏的等待里）。
    first.harness.tables.hooks.beforePut = async (table, key, value) => {
        if (table === 'outgoing' && value.system === 'task' && value.state === 'sending') throw new Error('进程退出')
    }
    await assert.rejects(first.harness.runtime.notify(request))
    const pending = () => outgoingRows(first.harness).filter(row => row.system === 'task')
    assert.deepEqual(pending().map(row => row.state), ['prepared'])
    await first.harness.runtime.close()
    first.harness.tables.hooks.beforePut = null

    const second = await sessionsHarness(t, { tables: first.harness.tables, credentials: first.harness.credentials })
    await waitFor(() => channel(second.harness, 'chat').connected, '重启后连上')
    assert.deepEqual(await second.harness.runtime.notify(request), { status: 'sent', groupId: '777' })
    assert.deepEqual(await second.harness.runtime.notify(request), { status: 'skipped', reason: 'DUPLICATE' })
    assert.deepEqual(pending().map(row => row.state), ['sent'], '还是同一行')
    const sent = [...first.harness.account.state.sends, ...second.harness.account.state.sends].filter(send => send.text === request.text)
    assert.equal(sent.length, 1)
})

test('任务进度限额：停机前记下的那条自己不占名额，第 20 条重启后照常补发（3）', async (t) => {
    const first = await sessionsHarness(t)
    assert.equal((await first.harness.runtime.bindGroup({ caller: SESSION_ID, group: '777', sessionId: PROJECT_SESSION })).status, 'bound')
    for (let index = 1; index < 20; index += 1) {
        const earlier = { sessionIds: [PROJECT_SESSION], key: `task-n${index}-r1-start`, text: `【任务】开始做「T${index}」。` }
        assert.equal((await first.harness.runtime.notify(earlier)).status, 'sent')
    }
    const request = { sessionIds: [PROJECT_SESSION], key: 'task-n20-r1-start', text: '【任务】开始做「T20」。' }
    first.harness.tables.hooks.beforePut = async (table, key, value) => {
        if (table === 'outgoing' && value.system === 'task' && value.state === 'sending') throw new Error('进程退出')
    }
    await assert.rejects(first.harness.runtime.notify(request))
    await first.harness.runtime.close()
    first.harness.tables.hooks.beforePut = null

    const second = await sessionsHarness(t, { tables: first.harness.tables, credentials: first.harness.credentials })
    await waitFor(() => channel(second.harness, 'chat').connected, '重启后连上')
    assert.deepEqual(await second.harness.runtime.notify(request), { status: 'sent', groupId: '777' }, '不被自己那行挡成 CAP')
    const another = { sessionIds: [PROJECT_SESSION], key: 'task-n21-r1-start', text: '【任务】开始做「T21」。' }
    assert.deepEqual(await second.harness.runtime.notify(another), { status: 'skipped', reason: 'CAP' }, '满 20 条后照样限额')
})

/* ---------------------------- 未送达立即补告 ---------------------------- */

/** 一个官方 QQ 绑定的 harness；`canDeliverNow` 装在 fake 平台对象上：运行态只问它，不看平台名。 */
async function failureHarness(t, canDeliverNow) {
    const reports = []
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        // 被叫醒的那一轮是中枢没有渠道输入的轮：回复照常发到手机，借对方最近一条消息的被动回复额度（官方 QQ 的发送规则照旧）。
        runtime: { qqRelayWindowMs: 50 * 60_000, mainTurnReplies: true, report: (kind, detail) => { reports.push({ kind, ...detail }) } },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    // null：平台没有这项能力。
    if (canDeliverNow === null) delete harness.qq.platform.canDeliverNow
    else if (canDeliverNow !== undefined) harness.qq.platform.canDeliverNow = canDeliverNow
    await settle(harness.runtime)
    const options = listenOptions(harness.qq.state)
    const say = async (messageId, text) => {
        await options.onMessage(
            { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text },
            anchorOf(messageId),
        )
        await settle(harness.runtime)
    }
    const accept = harness.qq.state.sendImpl
    const failWith = (error) => { harness.qq.state.sendImpl = async () => { throw error } }
    const recover = () => { harness.qq.state.sendImpl = accept }
    // 以前在平台能主动发时立即开一轮补告（`relay:undelivered-` 输入）；现在只附给会话，这一项应当一直是空的。
    const notices = () => harness.ingressLog.admits.filter(entry => entry.message.messageId.startsWith('relay:undelivered-'))
    const notice = (sessionId = SESSION_ID) => harness.core.noticeOf(sessionId)
    // 叫醒会话的那几条（经核心交给会话的，编号前缀 channel-wake-）。
    const wakes = (sessionId = SESSION_ID) => harness.core.delivered.filter(item => item.sessionId === sessionId && item.id?.startsWith('channel-wake-'))
    return { harness, say, failWith, recover, notices, notice, wakes, reports }
}

const REJECTED = () => Object.assign(new Error('rejected'), { code: 'SEND_REJECTED', definitelyRejected: true })
const NO_ANSWER = () => Object.assign(new Error('no reply'), { code: 'SEND_FAILED', resultUnknown: true })

test('未送达附给会话：提示附在附提醒里、不接在对方的话后面；失败的一轮不算告诉了；重启以后按核心那里还有没有补认', async (t) => {
    const { harness, say, failWith, recover, notices, notice } = await failureHarness(t, () => false)
    await say('m-a', '测试附件在哪')
    failWith(REJECTED())
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '附件在这里，第三个已处理。' }] })
    await settle(harness.runtime)
    assert.equal(notices().length, 0, '不再转交补告输入')
    assert.match(notice(), /^（渠道提示，不是对方说的：下面这些确定没有送到对方手机，需要的话重新发。）\n- 第 \d+ 轮回复（QQ，SEND_REJECTED）：「附件在这里，第三个已处理。…」/)
    const row = () => outgoingRows(harness).find(item => item.errorCode === 'SEND_REJECTED')
    assert.equal(row().noticeAttached, true)
    assert.equal(harness.runtime.undelivered().length, 1, '没交到之前 Watchdog 看得到')

    // 一轮失败（核心不调交到的回调，提示留着）：渠道这边什么都不记。
    await settle(harness.runtime)
    assert.equal(row().reportedAt, undefined)
    assert.notEqual(notice(), null)

    // 重启：回调没了；之后那一轮正常结束、核心撤掉了提示，渠道下一次对账时按"附过、核心那里已经没有了"补认告诉了。
    recover()
    harness.core.takeNotices(SESSION_ID, { restart: true })
    assert.equal(row().reportedAt, undefined, '回调没了，还没记')
    await harness.runtime.wake()
    await settle(harness.runtime)
    assert.ok(row().reportedAt > 0, '补认了')
    assert.equal(row().noticeAttached, undefined)
    assert.equal(notice(), null, '说过的不再附')
    assert.deepEqual(harness.runtime.undelivered(), [])
    await say('m-b', '好')
    assert.equal(harness.ingressLog.admits.find(entry => entry.message.messageId === 'm-b').message.text, '好')
})

test('未送达叫醒会话（早先的时效）：平台说现在能主动发时，经核心马上叫醒会话（详情在附提醒），同一批只叫醒一次；现在不能主动发就只附提示', async (t) => {
    // 官方 QQ 的名字、像测试聊天一样的能力：只要能力说能发就叫醒，证明不按平台名分支。
    const { harness, say, failWith, wakes, notice } = await failureHarness(t, ({ live }) => live === true)
    await say('m-a', '测试附件在哪')
    failWith(REJECTED())
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '附件在这里，第三个已处理。' }] })
    await settle(harness.runtime)
    const [wake] = wakes()
    assert.ok(wake, '叫醒了')
    assert.match(wake.text, /有回复没送到对方手机，详见渠道提示/)
    assert.deepEqual([wake.source, wake.speaker, wake.wake, wake.reply], [{ kind: 'channel-notice' }, { kind: 'program', plugin: 'message-channels-framework' }, 'now', { to: 'exit' }])
    assert.equal(wake.key, wake.id)
    assert.match(notice(), /确定没有送到[\s\S]*附件在这里/, '详情附在提示里')
    await settle(harness.runtime)
    await harness.runtime.wake()
    await settle(harness.runtime)
    assert.equal(wakes().length, 1, '同一批只叫醒一次')

    const quiet = await failureHarness(t, () => false)
    await quiet.say('m-a', '画一张')
    quiet.failWith(REJECTED())
    quiet.harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '处理好了' }] })
    await settle(quiet.harness.runtime)
    assert.equal(quiet.wakes().length, 0, '现在不能主动发：不叫醒')
    assert.notEqual(quiet.notice(), null, '只附提示')
})

test('未送达叫醒防循环：被叫醒的那一轮自己的回复也没送到，不再叫醒，只附提示等下一轮，Watchdog 看得到', async (t) => {
    const { harness, say, failWith, recover, wakes, notice } = await failureHarness(t, ({ live }) => live === true)
    await say('m-a', '图呢')
    failWith(REJECTED())
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '第一次回复' }] })
    await settle(harness.runtime)
    const [wake] = wakes()
    // 被叫醒的那一轮：触发消息是叫醒的那条，没有渠道输入；提示在这一轮交到了，它自己的回复又没送到。
    harness.chat.addTurn({
        inputs: [{ rpcId: wake.id, text: wake.text, source: { kind: 'channel-notice', deliveryKey: wake.key } }],
        assistants: [{ text: '重发也失败了' }],
        route: { to: 'exit' },
        trigger: wake.id,
    })
    harness.core.takeNotices(SESSION_ID)
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.equal(wakes().length, 1, '不再叫醒第二次')
    const again = outgoingRows(harness).find(row => row.text === '重发也失败了')
    assert.equal(again.mainTurn, true, '被叫醒的那一轮按没有渠道输入的轮发')
    assert.equal(again.nextInputOnly, true)
    assert.equal(again.reportedAt, undefined)
    const [pending] = harness.runtime.undelivered()
    assert.equal(pending.guarded, true)
    assert.equal(pending.items[0].excerpt, '重发也失败了')
    assert.match(notice(), /「重发也失败了…」/, '照样附给会话，等它的下一轮')
    recover()
})
test('未送达立即补告：绑定改接了别的会话后，旧会话写的失败回复不补告给新会话（不会把别人的话重发进去）', async (t) => {
    let can = false
    const { harness, say, failWith, recover, notices } = await failureHarness(t, () => can)
    await say('m-a', '在吗')
    failWith(REJECTED())
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '旧会话写的回复' }] })
    await settle(harness.runtime)
    assert.equal(notices().length, 0, '当时发不了，没开轮')
    // 模拟改绑之后：这条失败回复属于另一个会话（绑定 id 不变，sessionId 是旧的）。
    for (const [id, row] of harness.tables.maps.outgoing) harness.tables.maps.outgoing.set(id, { ...row, sessionId: 'session-old' })
    recover()
    can = true
    await say('m-b', '又来了')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-b' }], assistants: [{ text: '新会话的回复' }] })
    await settle(harness.runtime)
    assert.equal(notices().length, 0, '旧会话的失败不交给现在接着的会话')
    assert.doesNotMatch(harness.core.noticeOf(SESSION_ID) ?? '', /旧会话写的回复/, '也不附给现在接着的会话')
    assert.equal(harness.core.delivered.filter(item => item.id?.startsWith('channel-wake-')).length, 0, '也不叫醒现在接着的会话')
    assert.equal(outgoingRows(harness).find(row => row.text === '旧会话写的回复').reportedAt, undefined, '留在原处，不当作已告诉')
})

test('未送达附给会话：结果不明的用“可能已经送到，重发前先想一想”的说法', async (t) => {
    const { harness, say, failWith, notice } = await failureHarness(t, ({ live }) => live === true)
    await say('m-a', '讲讲')
    failWith(NO_ANSWER())
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '很长的一段说明，发出去没等到回音。' }] })
    await settle(harness.runtime)
    assert.match(notice(), /可能已经送到对方手机；重发前先想一想[\s\S]*第 \d+ 轮回复（QQ，结果不明）：「很长的一段说明/)
    assert.doesNotMatch(notice(), /确定没有送到/)
})

test('未送达的回复：Watchdog 看得到（只给开头 24 个字，刚失败的先不算）；附给会话的提示交到以后就没有了', async (t) => {
    const { harness, failWith, recover, notices } = await failureHarness(t, () => false)
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-a', text: '画一张' },
        anchorOf('m-a'),
    )
    await settle(harness.runtime)
    failWith(REJECTED())
    const long = '处理好了，一共有三张了，这句话超过二十四个字了，后面还有。'
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: long }] })
    await settle(harness.runtime)
    assert.equal(notices().length, 0, '不开轮')
    const [pending] = harness.runtime.undelivered()
    assert.equal(pending.sessionId, SESSION_ID)
    assert.equal(pending.main, true, '私聊绑定的会话是中枢')
    assert.equal(pending.platform, 'qq')
    assert.equal(pending.group, false)
    assert.equal(pending.guarded, false)
    assert.equal(pending.items[0].excerpt, Array.from(long).slice(0, 24).join(''), '只给开头 24 个字')
    assert.equal(harness.runtime.undelivered({ olderThanMs: 60_000 }).length, 0, '刚失败的先不算')
    recover()
    harness.core.takeNotices(SESSION_ID)
    await settle(harness.runtime)
    assert.deepEqual(harness.runtime.undelivered(), [], '告诉过了')
})
test('平台的主动发送能力：微信看对方最近一条消息是否在 24 小时内；官方 QQ 看那条消息还剩几次回复', async () => {
    const now = 100 * 24 * 60 * 60 * 1000
    const { createWeixinPlatform } = await import('../platforms/weixin.js')
    const weixin = await createWeixinPlatform()
    assert.equal(weixin.canDeliverNow({ live: true, lastInputAt: now - 23 * 60 * 60 * 1000, repliesLeft: 1, now }), true)
    assert.equal(weixin.canDeliverNow({ live: true, lastInputAt: now - 23 * 60 * 60 * 1000, repliesLeft: 0, now }), false, '这条消息的 10 次用完了')
    assert.equal(weixin.canDeliverNow({ live: true, lastInputAt: now - 23 * 60 * 60 * 1000, repliesLeft: 1, repliesNeeded: 2, now }), false)
    assert.equal(weixin.canDeliverNow({ live: true, lastInputAt: now - 25 * 60 * 60 * 1000, repliesLeft: 5, now }), false)
    assert.equal(weixin.canDeliverNow({ live: true, lastInputAt: null, repliesLeft: 5, now }), false)
    const { createQQPlatform } = await import('../platforms/qq.js')
    const qq = await createQQPlatform()
    assert.equal(qq.canDeliverNow({ live: true, lastInputAt: now, repliesLeft: 2, now }), true)
    assert.equal(qq.canDeliverNow({ live: true, lastInputAt: now, repliesLeft: 0, now }), false)
})

test('未送达附给会话（测试聊天群）：群里的回复没送到，附给群接的项目会话、叫醒它；Watchdog 记为群会话', async (t) => {
    const { harness, project } = await groupHarness(t)
    await fromGroup(harness, 'g-1', '远航第二章的图')
    await settle(harness.runtime)
    harness.account.state.sendImpl = async () => { throw REJECTED() }
    project.addTurn({ inputs: [{ rpcId: 'req-g-1' }], assistants: [{ text: '第二章的附件在这里' }] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.ok(!incomingRows(harness).some(([, row]) => row.platformMessageId.startsWith('relay:undelivered-')), '不再转交补告输入')
    assert.match(harness.core.noticeOf(PROJECT_SESSION), /确定没有送到[\s\S]*测试聊天，SEND_REJECTED[\s\S]*「第二章的附件在这里…」/, '附给群接的项目会话')
    assert.equal(harness.core.noticeOf(SESSION_ID), null, '不附给中枢')
    const wakes = harness.core.delivered.filter(item => item.id?.startsWith('channel-wake-'))
    assert.deepEqual(wakes.map(item => item.sessionId), [PROJECT_SESSION], '连着：叫醒的是群接的项目会话，它的回复发回群')
    const [pending] = harness.runtime.undelivered()
    assert.deepEqual([pending.sessionId, pending.main, pending.group, pending.groupName, pending.platform],
        [PROJECT_SESSION, false, true, '项目-远航', 'chat'])
})
/* ---------------------------- 按能力选路 ---------------------------- */

/** 测试聊天与微信都绑在中枢上：对方先在微信、再在测试聊天上说话。 */
async function routeHarness(t, { weixin = true, accountSends = ['text', 'image'] } = {}) {
    const harness = await createHarness({
        account: true,
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' })
            if (weixin) await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' })
        },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    // 这些用例讲的是“测试聊天发不了某种内容时怎么改道”：默认给一个只发文字和图片的测试聊天（chat 自己的声明能发文件）。
    harness.account.platform.sends = Object.freeze([...accountSends])
    await settle(harness.runtime)
    const fromWeixin = async (messageId, text = '微信') => {
        await listenOptions(harness.weixin.state).onMessage(
            { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId, text },
            anchorOf(messageId, { contextToken: `ct-${messageId}` }),
        )
        await settle(harness.runtime)
    }
    const fromQa = async (messageId, text = '测试聊天') => {
        await fromAccount(harness, messageId, text)
        await settle(harness.runtime)
    }
    const admitted = messageId => harness.ingressLog.admits.find(entry => entry.message.messageId === messageId)?.message.text
    // 附给中枢的渠道提示（没有时为空串）。
    const notice = () => harness.core.noticeOf(SESSION_ID) ?? ''
    return { harness, fromWeixin, fromQa, admitted, notice }
}

async function routeFile(name, content) {
    const dir = await mkdtemp(join(tmpdir(), 'channel-route-'))
    const file = join(dir, name)
    await writeFile(file, content)
    return file
}

test('按能力选路：测试聊天发不了 md 文件，微信现在能发就改经微信发出，附给会话说明怎么发的', async (t) => {
    const file = await routeFile('大纲.md', '# 大纲\n')
    const { harness, fromWeixin, fromQa, admitted, notice } = await routeHarness(t)
    await fromWeixin('w-1')
    harness.advance(60_000)
    await fromQa('a-1', '大纲呢')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '大纲在这里' }], presented: [file] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['大纲在这里'], '测试聊天只发文字')
    const [viaWeixin] = harness.weixin.state.sends
    assert.equal(viaWeixin.file.name, '大纲.md')
    assert.equal(viaWeixin.anchor.messageId, 'w-1', '锚定对方在微信上最近的一条')
    const detour = outgoingRows(harness).find(row => row.detour === true)
    assert.equal(detour.state, 'sent')

    assert.match(notice(), /^（渠道提示，不是对方说的：下面这些按渠道能发的内容改了发法。）\n- 第 \d+ 轮回复的「大纲\.md」：测试聊天发不了文件，改经微信发出$/)
    await fromQa('a-2', '收到')
    assert.equal(admitted('a-2'), '收到', '不接在对方的话后面')
    harness.core.takeNotices(SESSION_ID)
    await settle(harness.runtime)
    assert.equal(notice(), '', '说过的不再附')
})

test('按能力选路：同一范围里没有现在能发文件的渠道时，md 按文字分片发出；能力按平台声明（微信声明发不了文件时同样改成文字）', async (t) => {
    const file = await routeFile('设定.md', `# 设定\n${'甲'.repeat(1500)}\n`)
    for (const variant of ['no-weixin', 'weixin-no-file']) {
        const { harness, fromWeixin, fromQa, notice } = await routeHarness(t, { weixin: variant !== 'no-weixin' })
        if (variant === 'weixin-no-file') {
            // 名叫微信、声明只发文字：运行态只看声明，不看名字。
            harness.weixin.platform.sends = ['text']
            await fromWeixin('w-1')
        }
        await fromQa('a-1', '设定呢')
        harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '设定如下' }], presented: [file] })
        await settle(harness.runtime)
        await settle(harness.runtime)
        const texts = harness.account.state.sends.map(send => send.text)
        assert.equal(texts[0], '设定如下')
        const body = texts.slice(1)
        assert.match(body[0], /^设定\.md：\n\n# 设定/)
        assert.ok(body.length >= 2, '超过一片的长度分几片')
        assert.equal(body.join('').replace(/\s/g, ''), `设定.md：#设定${'甲'.repeat(1500)}`, '全文按顺序发完')
        assert.ok(harness.account.state.sends.every(send => send.file === undefined))
        assert.equal(harness.weixin.state.sends.length, 0)
        assert.ok(notice().includes(`「设定.md」：没有现在能发文件的渠道，按文字分 ${body.length} 片发出`))
    }
})

test('按能力选路：二进制文件没有渠道能发时只发一行文件在电脑上的位置，并告诉会话', async (t) => {
    const file = await routeFile('合同.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]))
    const { harness, fromQa, notice } = await routeHarness(t, { weixin: false })
    await fromQa('a-1', '合同呢')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '合同在这里' }], presented: [file] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['合同在这里', `（文件在电脑上：${file}）`])
    assert.match(notice(), /「合同\.pdf」：没有现在能发文件的渠道，只发了它在电脑上的位置/)
})

test('按能力选路：群会话只用到达同一个群的渠道，发不了的文件不落到私聊，改成文字发回群', async (t) => {
    const file = await routeFile('进度.md', '第二章改完了\n')
    const project = createChatSession(PROJECT_SESSION)
    const harness = await createHarness({
        account: true,
        extraChats: [project],
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' })
            // 项目会话另外绑了微信私聊：群里的回复照样不能落到私聊。
            await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx', sessionId: PROJECT_SESSION })
        },
        admit: async (message, binding, spliceMain) => {
            const original = binding.sessionId === PROJECT_SESSION
                ? project.appendSpliced(`native-${message.messageId}`, `req-${message.messageId}`, message.text)
                : spliceMain(message.messageId, message.text)
            return { status: 'accepted', sessionId: binding.sessionId, requestId: `req-${message.messageId}`, messageId: original.id, seq: original.seq }
        },
        runtime: { resolveGroup: voyageResolver },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    // 讲的是“到达这个群的渠道发不了文件”：给一个只发文字和图片的测试聊天。
    harness.account.platform.sends = Object.freeze(['text', 'image'])
    await settle(harness.runtime)
    await listenOptions(harness.weixin.state).onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'w-1', text: '微信' },
        anchorOf('w-1', { contextToken: 'ct-w-1' }),
    )
    await settle(harness.runtime)
    await fromGroup(harness, 'g-1', '进度呢')
    await settle(harness.runtime)
    project.addTurn({ inputs: [{ rpcId: 'req-g-1' }], assistants: [{ text: '进度如下' }], presented: [file] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => [send.peerId, send.text]),
        [['group:777', '进度如下'], ['group:777', '进度.md：\n\n第二章改完了\n']])
    assert.equal(harness.weixin.state.sends.length, 0, '不落到私聊')
    assert.equal(outgoingRows(harness).some(row => row.detour === true), false)
})

test('按能力选路：平台声明能发文件，文件直接经它发出、不改道', async (t) => {
    const file = await routeFile('大纲.md', '# 大纲\n')
    const { harness, fromWeixin, fromQa } = await routeHarness(t, { accountSends: CHAT_DELIVERY.sends })
    assert.deepEqual([...CHAT_DELIVERY.sends].sort(), ['file', 'image', 'text'])
    await fromWeixin('w-1')
    harness.advance(60_000)
    await fromQa('a-1', '大纲呢')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '大纲在这里' }], presented: [file] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    const sends = harness.account.state.sends
    assert.deepEqual(sends.map(send => send.text), ['大纲在这里', file])
    assert.equal(sends[1].file.name, '大纲.md')
    assert.equal(harness.weixin.state.sends.length, 0, '不改经微信')
})

test('按能力选路：中途发送的文件也按能力改道，结果里写明怎么发的', async (t) => {
    const file = await routeFile('清单.md', '- 一\n')
    const { harness, fromWeixin, fromQa } = await routeHarness(t)
    await fromWeixin('w-1')
    harness.advance(60_000)
    await fromQa('a-1')
    const pushed = await harness.runtime.push({ sessionId: SESSION_ID, text: '清单发你', files: [file] })
    assert.equal(pushed.platform, 'chat')
    assert.equal(pushed.sent, 2)
    assert.deepEqual(pushed.routed, ['这次发送的「清单.md」：测试聊天发不了文件，改经微信发出'])
    assert.equal(harness.weixin.state.sends[0].file.name, '清单.md')
    assert.equal(outgoingRows(harness).find(row => row.detour === true).routeNote, undefined, '结果里说过，不再接到下一条输入')
    const sends = harness.runtime.sentBetween(SESSION_ID)
    assert.equal(sends.length, 1, '改道的片和文字是同一次发送')
    assert.match(sends[0].text, /^清单发你\n.*清单\.md$/s, '交接带的原文里有改道发出的片')
})

test('按能力选路：一轮回复里改道的片不算中途发送，外部调用方发的改道片也不算', async (t) => {
    const file = await routeFile('大纲.md', '# 大纲\n')
    const { harness, fromWeixin, fromQa } = await routeHarness(t)
    await fromWeixin('w-1')
    harness.advance(60_000)
    await fromQa('a-1', '大纲呢')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '大纲在这里' }], presented: [file] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.equal(outgoingRows(harness).filter(row => row.detour === true).length, 1)
    assert.deepEqual(harness.runtime.sentBetween(SESSION_ID), [])
    await harness.runtime.push({ sessionId: SESSION_ID, text: '外部发的', files: [file], by: { kind: 'external', name: 'cli' } })
    assert.deepEqual(harness.runtime.sentBetween(SESSION_ID), [])
})

/* ------------------------- 平台确定没发出：改道与暂停 ------------------------- */

/** 平台还没发出去就失败了：确定没发出。 */
const NOT_SENT = () => Object.assign(new Error('paste not confirmed'), { code: 'NOT_SENT', notSent: true })
const PAUSE_MS = 15 * 60_000

/**
 * 测试聊天与微信都绑在中枢上；报告记在 `reports`。`reopen`（上一次的 `{ tables, credentials, chat }`）模拟重启。
 * `script(...results)`：测试聊天接下来几次发送的结果（'fail' 确定没发出、'unknown' 结果不明、'ok' 发出），用完以后照常发出。
 * `late(result)`：最早一次结果不明的发送，平台晚回确定结果（`{status:'sent'}` 或 `{status:'failed', code}`）。
 * `kinds()`：暂停、恢复两类报告，报“好了”的记成 `<类别> resolved`。
 */
async function rejectHarness(t, { reopen } = {}) {
    const reports = []
    const harness = await createHarness({
        account: true,
        ...reopen ?? {
            seed: async ({ tables, credentials }) => {
                await seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' })
                await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' })
            },
        },
        runtime: { report: (kind, detail) => { reports.push({ kind, ...detail }) } },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const queue = []
    const lates = []
    const accept = harness.account.state.sendImpl
    harness.account.state.sendImpl = async (request) => {
        const next = queue.shift() ?? 'ok'
        if (next === 'fail') throw NOT_SENT()
        if (next === 'unknown') {
            lates.push(request.onLateResult)
            throw Object.assign(new Error('no reply'), { code: 'SEND_FAILED', resultUnknown: true })
        }
        return accept(request)
    }
    const script = (...results) => { queue.push(...results) }
    const late = async (result) => {
        lates.shift()(result)
        await settle(harness.runtime)
    }
    const fromWeixin = async (messageId, text = '微信') => {
        await listenOptions(harness.weixin.state).onMessage(
            { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId, text },
            anchorOf(messageId, { contextToken: `ct-${messageId}` }),
        )
        await settle(harness.runtime)
    }
    const fromQa = async (messageId, text = '测试聊天') => {
        await fromAccount(harness, messageId, text)
        await settle(harness.runtime)
    }
    const reply = async (messageId, text) => {
        harness.chat.addTurn({ inputs: [{ rpcId: `req-${messageId}` }], assistants: [{ text }] })
        await settle(harness.runtime)
        await settle(harness.runtime)
    }
    const push = text => harness.runtime.push({ sessionId: SESSION_ID, text })
    const notice = () => harness.core.noticeOf(SESSION_ID) ?? ''
    const kinds = () => reports.filter(item => item.kind.startsWith('channels/account-'))
        .map(item => (item.data?.resolved === true ? `${item.kind} resolved` : item.kind))
    /** 最近一条这一类的报告。 */
    const last = kind => reports.filter(item => item.kind === kind).at(-1)
    /** 对方先在微信、再在测试聊天上说了话：回复默认回测试聊天，微信现在也能发。 */
    const bothSaid = async () => {
        await fromWeixin('w-1')
        harness.advance(60_000)
        await fromQa('a-1', '图呢')
    }
    return { harness, reports, script, late, reply, push, notice, kinds, last, bothSaid }
}

const TWO_PARTS = `${'甲'.repeat(800)}\n\n${'乙'.repeat(800)}`
const NOTE = '（测试聊天没发出去，这条改从微信发。）\n'

test('改道：测试聊天确定没发出的片改从微信发、开头说明换了渠道；原来那片仍记 failed 并指向改道记录；会话收到“改道发出”而不是“没送到”', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail')
    await h.reply('a-1', '附件在这里，第三个已处理。')
    assert.equal(h.harness.account.state.sends.length, 1, '测试聊天试过一次')
    const [viaWeixin] = h.harness.weixin.state.sends
    assert.equal(viaWeixin.text, `${NOTE}附件在这里，第三个已处理。`)
    assert.equal(viaWeixin.anchor.messageId, 'w-1', '锚定对方在微信上最近的一条')
    const [originalId, original] = [...h.harness.tables.maps.outgoing.entries()].find(([, row]) => row.errorCode === 'NOT_SENT')
    assert.equal(original.state, 'failed', '原来那片的状态不改')
    assert.notEqual(original.reroutedTo, originalId)
    const detour = h.harness.tables.maps.outgoing.get(original.reroutedTo)
    assert.deepEqual([detour.state, detour.detour], ['sent', true])
    assert.doesNotMatch(h.notice(), /没有送到|结果不明/, '不再告诉会话没送到')
    assert.match(h.notice(), /\n- 第 \d+ 轮回复「附件在这里，第三个已处理。…」：测试聊天确定没发出去，已经改从微信发出，不用重发$/)
    assert.equal(h.harness.core.delivered.some(item => item.id?.startsWith('channel-wake-')), false, '不为它叫醒会话')
    assert.deepEqual(h.harness.runtime.undelivered(), [], 'Watchdog 也看不到未送达')
    h.harness.core.takeNotices(SESSION_ID)
    await settle(h.harness.runtime)
    assert.equal(h.notice(), '', '改道说明只说一次')
})

test('改道：一批里某片改道后，后面的片照常先经测试聊天发；重启后不重复改道、也不重发', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail')
    await h.reply('a-1', TWO_PARTS)
    assert.deepEqual(h.harness.weixin.state.sends.map(send => send.text.trim()), [`${NOTE}${'甲'.repeat(800)}`])
    assert.deepEqual(h.harness.account.state.sends.map(send => send.text.trim()), ['甲'.repeat(800), '乙'.repeat(800)], '第二片照常经测试聊天发出')
    await h.harness.runtime.close()

    const reopened = await rejectHarness(t, { reopen: { tables: h.harness.tables, credentials: h.harness.credentials, chat: h.harness.chat } })
    await settle(reopened.harness.runtime)
    await settle(reopened.harness.runtime)
    assert.equal(reopened.harness.account.state.sends.length, 0, '重启后不重发')
    assert.equal(reopened.harness.weixin.state.sends.length, 0, '重启后不再改道')
    assert.equal(outgoingRows(reopened.harness).filter(row => row.detour === true).length, 1)
    assert.doesNotMatch(reopened.notice(), /没有送到/)
})

test('改道：暂停中的测试聊天在一批里不再试，核对完来源直接改道；换了渠道的说明只写在第一片', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail', 'fail', 'fail')
    await h.reply('a-1', `${TWO_PARTS}\n\n${'丙'.repeat(800)}`)
    assert.equal(h.harness.account.state.sends.length, 2, '连着两片没发出就暂停，第三片不再试测试聊天')
    assert.deepEqual(h.harness.weixin.state.sends.map(send => send.text.trim()), [`${NOTE}${'甲'.repeat(800)}`, '乙'.repeat(800), '丙'.repeat(800)])
    const third = outgoingRows(h.harness).find(row => row.partIndex === 2 && row.detour !== true)
    assert.deepEqual([third.state, third.errorCode, typeof third.reroutedTo], ['failed', 'SEND_PAUSED', 'string'])
    assert.deepEqual(h.kinds(), ['channels/account-paused'])
    assert.doesNotMatch(h.notice(), /没有送到/)
})

test('不改道：渠道自己在发之前拦下的（来源变了）不改道、不计入暂停，照旧算没发出', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    let armed = false
    h.harness.tables.hooks.beforePut = async (table, key, value) => {
        if (table !== 'outgoing' || value.state !== 'sending' || armed) return
        armed = true
        // 发送意图记下以后，这一轮的文字从会话视图上撤下了：最后的核对会拦下它。
        h.harness.chat.state.surfaceEvents.pop()
    }
    await h.reply('a-1', '撤下即停')
    assert.equal(h.harness.account.state.sends.length, 0)
    assert.equal(h.harness.weixin.state.sends.length, 0, '不改道')
    const [row] = outgoingRows(h.harness)
    assert.deepEqual([row.state, row.errorCode, row.reroutedTo], ['failed', 'SOURCE_CHANGED', undefined])
    assert.deepEqual(h.kinds(), [])
})

test('不改道：结果不明的片可能已经发出，不改道，照旧说“可能已经送到”', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('unknown')
    await h.reply('a-1', '附件在这里')
    assert.equal(h.harness.weixin.state.sends.length, 0)
    assert.equal(outgoingRows(h.harness).some(row => row.reroutedTo !== undefined || row.detour === true), false)
    assert.match(h.notice(), /可能已经送到[\s\S]*测试聊天，结果不明/)
})

test('不改道：改道那一条也确定没发出时不再改，照确定没送到告诉会话（只说原来那一片一次）', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail')
    h.harness.weixin.state.sendImpl = async () => { throw NOT_SENT() }
    await h.reply('a-1', '附件在这里')
    assert.equal(h.harness.account.state.sends.length, 1)
    assert.equal(h.harness.weixin.state.sends.length, 1, '改道那一条没发出也不再改')
    const detour = outgoingRows(h.harness).find(row => row.detour === true)
    assert.deepEqual([detour.state, detour.reroutedTo], ['failed', undefined])
    assert.match(h.notice(), /^（渠道提示，不是对方说的：下面这些确定没有送到对方手机，需要的话重新发。）\n- 第 \d+ 轮回复（测试聊天，NOT_SENT）：「附件在这里…」$/)
})

test('改道：中途发送确定没发出时改从微信发，发送结果算发出、写明改了道，不再另附给会话', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail')
    const pushed = await h.push('先发你一句')
    assert.deepEqual([pushed.platform, pushed.sent, pushed.failed], ['chat', 1, 0])
    assert.deepEqual(pushed.routed, ['中途发送「先发你一句…」：测试聊天确定没发出去，已经改从微信发出，不用重发'])
    assert.equal(h.harness.weixin.state.sends[0].text, `${NOTE}先发你一句`)
    await settle(h.harness.runtime)
    assert.doesNotMatch(h.notice(), /先发你一句/)
})

test('不改道：群里的回复确定没发出时不落到私聊（群的范围只有它自己），照旧算没送到', async (t) => {
    const project = createChatSession(PROJECT_SESSION)
    const harness = await createHarness({
        account: true,
        extraChats: [project],
        seed: async ({ tables, credentials }) => {
            await seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' })
            // 项目会话另外绑了微信私聊：群里的回复照样不能落到私聊。
            await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx', sessionId: PROJECT_SESSION })
        },
        admit: async (message, binding, spliceMain) => {
            const original = binding.sessionId === PROJECT_SESSION
                ? project.appendSpliced(`native-${message.messageId}`, `req-${message.messageId}`, message.text)
                : spliceMain(message.messageId, message.text)
            return { status: 'accepted', sessionId: binding.sessionId, requestId: `req-${message.messageId}`, messageId: original.id, seq: original.seq }
        },
        runtime: { resolveGroup: voyageResolver },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.weixin.state).onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'w-1', text: '微信' },
        anchorOf('w-1', { contextToken: 'ct-w-1' }),
    )
    await settle(harness.runtime)
    await fromGroup(harness, 'g-1', '进度呢')
    await settle(harness.runtime)
    harness.account.state.sendImpl = async () => { throw NOT_SENT() }
    project.addTurn({ inputs: [{ rpcId: 'req-g-1' }], assistants: [{ text: '进度如下' }] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.equal(harness.weixin.state.sends.length, 0, '不落到私聊')
    assert.equal(outgoingRows(harness).some(row => row.detour === true || row.reroutedTo !== undefined), false)
    assert.match(harness.core.noticeOf(PROJECT_SESSION), /确定没有送到[\s\S]*测试聊天，NOT_SENT[\s\S]*「进度如下…」/)
})

test('暂停：连着 2 片确定没发出就暂停 15 分钟、选路跳过它；中间发出一片就重数', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail', 'ok', 'fail')
    assert.equal((await h.push('一')).platform, 'chat')
    assert.equal((await h.push('二')).platform, 'chat')
    assert.equal((await h.push('三')).platform, 'chat')
    assert.deepEqual(h.kinds(), [], '中间发出过一片：只算连着 1 片')
    h.script('fail')
    assert.equal((await h.push('四')).platform, 'chat')
    assert.deepEqual(h.kinds(), ['channels/account-paused'])
    const paused = h.reports.at(-1)
    assert.match(paused.text, /^测试聊天私聊暂停发送 15 分钟：连着 2 片被平台确定没发出/)
    assert.equal(paused.data.subject, h.harness.tables.maps.bindings.get('chat').bindingId)
    const tried = h.harness.account.state.sends.length
    assert.equal((await h.push('五')).platform, 'weixin', '暂停中选路跳过测试聊天')
    assert.equal(h.harness.account.state.sends.length, tried)
    assert.equal(h.harness.weixin.state.sends.at(-1).text, '五', '选路直接选到的微信不加改道说明')
})

test('暂停：到点后下一片先试测试聊天，只试这一片——又没发出就再停 15 分钟；发出就恢复', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail', 'fail')
    await h.push('一')
    await h.push('二')
    assert.deepEqual(h.kinds(), ['channels/account-paused'])
    h.harness.advance(PAUSE_MS)
    h.script('fail')
    const retried = await h.push('三')
    assert.deepEqual([retried.platform, retried.sent], ['chat', 1], '到点先试测试聊天，没发出就改道')
    assert.deepEqual(h.kinds(), ['channels/account-paused', 'channels/account-paused'], '试的那一片又没发出：再停')
    assert.match(h.reports.at(-1).text, /到点后试发的一片又被平台确定没发出/)
    assert.equal((await h.push('四')).platform, 'weixin')
    h.harness.advance(PAUSE_MS)
    assert.equal((await h.push('五')).platform, 'chat')
    assert.deepEqual(h.kinds(), ['channels/account-paused', 'channels/account-paused', 'channels/account-resumed', 'channels/account-paused resolved'])
    assert.match(h.last('channels/account-resumed').text, /^测试聊天私聊恢复发送：到点后试发的一片发出去了/)
    const resolved = h.reports.at(-1)
    assert.deepEqual(resolved.data, { subject: h.last('channels/account-resumed').data.subject, resolved: true }, '暂停那条同一 subject 报好了，Watchdog 能关掉它')
    h.script('fail')
    await h.push('六')
    assert.equal((await h.push('七')).platform, 'chat', '恢复后从头数：一片没发出不暂停')
})

test('暂停：另一头从断到连时清零——暂停着的恢复，没到 2 片的计数也重来', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    const live = up => listenOptions(h.harness.account.state).onLive(up)
    h.script('fail', 'fail')
    await h.push('一')
    await h.push('二')
    assert.equal((await h.push('三')).platform, 'weixin')
    live(false)
    live(true)
    assert.deepEqual(h.kinds(), ['channels/account-paused', 'channels/account-resumed', 'channels/account-paused resolved'])
    assert.match(h.last('channels/account-resumed').text, /恢复发送：另一头重新连上了/)
    assert.equal((await h.push('四')).platform, 'chat', '重连后不再跳过')
    h.script('fail')
    await h.push('五')
    live(false)
    live(true)
    h.script('fail')
    await h.push('六')
    assert.equal((await h.push('七')).platform, 'chat', '重连前的 1 片不带过来')
    assert.deepEqual(h.kinds(), ['channels/account-paused', 'channels/account-resumed', 'channels/account-paused resolved'])
})

test('改道那一条结果不明、会话已被告知“可能已经送到”后，平台晚回确定没发出：补一句后来确认没有送到（照原来那一片说）', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail')
    let lateWeixin
    h.harness.weixin.state.sendImpl = async (request) => {
        lateWeixin = request.onLateResult
        throw Object.assign(new Error('no reply'), { code: 'SEND_FAILED', resultUnknown: true })
    }
    await h.reply('a-1', '附件在这里')
    assert.match(h.notice(), /可能已经送到[\s\S]*第 \d+ 轮回复（测试聊天，结果不明）：「附件在这里…」/)
    h.harness.core.takeNotices(SESSION_ID)
    await settle(h.harness.runtime)
    assert.equal(h.notice(), '')
    lateWeixin({ status: 'failed', code: 'NOT_SENT' })
    await settle(h.harness.runtime)
    assert.match(h.notice(), /下面这些之前说结果不明，后来有了确定结果。）\n- 第 \d+ 轮回复（测试聊天）：「附件在这里…」之前说结果不明，后来确认没有送到，需要的话重新发。$/)
    h.harness.core.takeNotices(SESSION_ID)
    await settle(h.harness.runtime)
    assert.equal(h.notice(), '', '只补说一次')
})

test('暂停：同一绑定排着几片时，前面的片刚把它停掉，后面已经排进队的片不再试测试聊天，直接改道', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    const gate = deferred()
    let calls = 0
    h.harness.account.state.sendImpl = async () => {
        calls += 1
        if (calls === 1) await gate.promise
        throw NOT_SENT()
    }
    const pending = [h.push('一'), h.push('二'), h.push('三')]
    await waitFor(() => h.harness.account.state.sends.length === 1, '第一片在发')
    for (let index = 0; index < 20; index += 1) await flush()
    gate.resolve()
    const results = await Promise.all(pending)
    assert.ok(results.every(result => result.platform === 'chat' && result.sent === 1), '三次都先选了测试聊天、都改道发出')
    assert.equal(h.harness.account.state.sends.length, 2, '第三片轮到时测试聊天已经暂停：不试')
    assert.equal(h.harness.weixin.state.sends.length, 3)
    assert.equal(outgoingRows(h.harness).filter(row => row.errorCode === 'SEND_PAUSED').length, 1)
})

test('暂停：平台晚回的结果也计入——晚回“已发出”隔开的两次没发出不算连着；晚回“确定没发出”算一次', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail', 'unknown')
    await h.push('一')
    await h.push('二')
    await h.late({ status: 'sent', platformMessageId: 'pm-late' })
    h.script('fail')
    await h.push('三')
    assert.deepEqual(h.kinds(), [], '晚回发出那一片把计数清零了')
    assert.equal((await h.push('四')).platform, 'chat')

    h.script('unknown')
    await h.push('五')
    await h.late({ status: 'failed', code: 'NOT_SENT' })
    h.script('fail')
    await h.push('六')
    assert.deepEqual(h.kinds(), ['channels/account-paused'], '晚回确定没发出算一次，再一次就暂停')
    assert.equal((await h.push('七')).platform, 'weixin')
})

/* ------------------------------ 额度用完与用量提醒 ------------------------------ */

/** 2026-03-10 北京时间某一刻（日期可调）。 */
const bjAt = (hh, mm, ss = 0, day = 10) => Date.UTC(2026, 2, day, hh - 8, mm, ss)
/** 恢复时间：2026-03-10 22:30 北京时间。 */
const RESETS_AT = 1773153000 * 1000

/** 额度闸门的现状（形状同 Claude Code 插件的 `quota()`）。 */
const limitedQuota = (sessions, extra = {}) => ({
    state: 'limited', outageId: 'qout1', since: bjAt(21, 17, 20), resetsAt: RESETS_AT, window: 'five_hour', model: 'opus',
    windows: {}, backlog: Object.fromEntries(sessions.map(id => [id, { firstAt: bjAt(21, 17, 20) }])), last: null, ...extra,
})

test('额度用完：对方的消息还没回时私聊说一次（北京时间、不用重发），同一次停用不再说；之后的回复照常回这条', async (t) => {
    const time = { now: bjAt(21, 19, 21) }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000, now: () => time.now },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-q1', text: '那肯定' },
        anchorOf('m-q1'),
    )
    await settle(harness.runtime)
    const first = await harness.runtime.sweepQuota({ quota: limitedQuota([SESSION_ID]) })
    assert.deepEqual(first.sent.map(item => [item.kind, item.status]), [['quota', 'sent']])
    assert.equal(harness.qq.state.sends[0].text, '（5 小时额度用完了，最晚 22:30 恢复，你的消息都收着，恢复后按顺序回，不用重发。）')
    assert.equal(outgoingRows(harness)[0].system, 'quota')
    // 同一次停用：再看几次都不重复；用户又发一条也不再说。
    time.now = bjAt(21, 20, 9)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-q2', text: '等做完一起吧' },
        anchorOf('m-q2'),
    )
    await settle(harness.runtime)
    assert.deepEqual((await harness.runtime.sweepQuota({ quota: limitedQuota([SESSION_ID]) })).sent, [])
    assert.equal(harness.qq.state.sends.length, 1)
    // 没有积压（这个会话不在这次停用的积压里）或额度正常：不说。
    assert.deepEqual((await harness.runtime.sweepQuota({ quota: limitedQuota([], { outageId: 'qout2' }) })).sent, [])
    assert.deepEqual((await harness.runtime.sweepQuota({ quota: { state: 'open', windows: {}, backlog: {} } })).sent, [])
    // 恢复后的回复照常回最近这条。
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-q1' }, { rpcId: 'req-m-q2' }], assistants: [{ text: '恢复了，接着说' }] })
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.at(-1).text, '恢复了，接着说')
})

test('额度用完：群会话不在群里说，私聊告诉用户、列出受影响的群；同一个群只列一次', async (t) => {
    const time = { now: bjAt(21, 17, 0) }
    const { harness } = await groupHarness(t, { runtime: { now: () => time.now } })
    // 中枢私聊先有一来一回（有可锚定的消息、也已经回过）。
    await listenOptions(harness.account.state).onMessage(
        { kind: 'private', platform: 'chat', accountId: 'account-qa', conversationId: 'owner-qa', senderId: 'owner-qa', messageId: 'p-1', text: '晚上好' },
        anchorOf('p-1'),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-p-1' }], assistants: [{ text: '晚上好呀' }] })
    await settle(harness.runtime)
    time.now = bjAt(21, 17, 20)
    await fromGroup(harness, 'g-1', '第一章怎么写')
    await settle(harness.runtime)
    const before = harness.account.state.sends.length
    const result = await harness.runtime.sweepQuota({ quota: limitedQuota([PROJECT_SESSION]) })
    assert.deepEqual(result.sent.map(item => [item.kind, item.status]), [['quota', 'sent']])
    const sends = harness.account.state.sends.slice(before)
    assert.equal(sends.length, 1)
    assert.equal(sends[0].text, '（5 小时额度用完了，最晚 22:30 恢复，群「项目-远航」里的消息都收着，恢复后按顺序回，不用重发。）')
    assert.equal(sends[0].peerId, 'owner-qa', '发到私聊，不在群里说')
    assert.deepEqual((await harness.runtime.sweepQuota({ quota: limitedQuota([PROJECT_SESSION]) })).sent, [])
})

test('休息时段（北京时间 0–8 点）：撞上额度用完的是用户刚说的话时立即说；早先没回的话等到 8 点再说', async (t) => {
    const time = { now: bjAt(23, 50, 0) }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' }),
        runtime: { now: () => time.now },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.weixin.state).onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'w-1', text: '睡前问一句' },
        anchorOf('w-1', { contextToken: 'ctx-1' }),
    )
    await settle(harness.runtime)
    // 00:40 定时提醒撞上额度用完：撞上的不是用户的话，等到 8 点。
    time.now = bjAt(0, 40, 0, 11)
    const night = limitedQuota([SESSION_ID], { since: bjAt(0, 40, 0, 11), resetsAt: bjAt(5, 40, 0, 11) })
    assert.deepEqual((await harness.runtime.sweepQuota({ quota: night })).sent, [])
    assert.equal(harness.weixin.state.sends.length, 0)
    time.now = bjAt(8, 0, 30, 11)
    const morning = await harness.runtime.sweepQuota({ quota: night })
    assert.deepEqual(morning.sent.map(item => item.status), ['sent'])
    assert.match(harness.weixin.state.sends[0].text, /^（5 小时额度用完了，最晚 05:40 恢复/)

    // 另一次停用：用户 01:10 发的话自己撞上了，立即说。
    time.now = bjAt(1, 10, 0, 12)
    await listenOptions(harness.weixin.state).onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'w-2', text: '还醒着吗' },
        anchorOf('w-2', { contextToken: 'ctx-2' }),
    )
    await settle(harness.runtime)
    const hit = limitedQuota([SESSION_ID], { outageId: 'qout9', since: bjAt(1, 10, 5, 12), resetsAt: bjAt(6, 0, 0, 12) })
    assert.deepEqual((await harness.runtime.sweepQuota({ quota: hit })).sent.map(item => item.status), ['sent'])
    assert.match(harness.weixin.state.sends.at(-1).text, /最晚 06:00 恢复/)
})

test('用量提前提醒：5 小时与本周额度各自到 80%、90%、95% 各提醒一次；休息时段里不发，8 点只发最高的一档', async (t) => {
    const time = { now: bjAt(18, 0, 0) }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000, now: () => time.now },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-u1', text: '在吗' },
        anchorOf('m-u1'),
    )
    await settle(harness.runtime)
    const windows = {
        five_hour: { utilization: 0.83, resetsAt: RESETS_AT, status: 'allowed_warning', at: time.now },
        seven_day: { utilization: 0.5, resetsAt: Date.UTC(2026, 2, 14, 0, 0), status: 'allowed', at: time.now },
    }
    const open = () => ({ state: 'open', outageId: null, windows: structuredClone(windows), backlog: {} })
    const first = await harness.runtime.sweepQuota({ quota: open() })
    assert.deepEqual(first.sent.map(item => [item.window, item.level, item.status]), [['five_hour', 0.8, 'sent']])
    assert.equal(harness.qq.state.sends[0].text, '（提醒：Claude 5 小时额度已经用了 83%（过了 80% 这一档），22:30 重置。）')
    assert.deepEqual((await harness.runtime.sweepQuota({ quota: open() })).sent, [])
    windows.seven_day.utilization = 0.91
    const weekly = await harness.runtime.sweepQuota({ quota: open() })
    assert.deepEqual(weekly.sent.map(item => [item.window, item.level]), [['seven_day', 0.9]])
    assert.match(harness.qq.state.sends.at(-1).text, /本周额度已经用了 91%（过了 90% 这一档），3月14日 08:00 重置/)
    // 夜里本周额度涨到 92% 又到 96%：不发；8 点只发 95% 这一档，90% 已经说过、跳过的不补。
    time.now = bjAt(2, 0, 0, 11)
    windows.seven_day.utilization = 0.96
    windows.five_hour = { utilization: 0.2, resetsAt: bjAt(6, 0, 0, 11), status: 'allowed', at: time.now }
    assert.deepEqual((await harness.runtime.sweepQuota({ quota: open() })).sent, [])
    time.now = bjAt(8, 0, 0, 11)
    const morning = await harness.runtime.sweepQuota({ quota: open() })
    assert.deepEqual(morning.sent.map(item => [item.window, item.level]), [['seven_day', 0.95]])
})

/* ------------------------- 中枢每一轮的回复默认发到手机 ------------------------- */

test('改道：改道的是文件时，在它前面经同一渠道插一片说明；重启后不重复插、不重发', async (t) => {
    const file = await routeFile('大纲.md', '# 大纲\n')
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('ok', 'fail')
    h.harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '大纲在这里' }], presented: [file] })
    await settle(h.harness.runtime)
    await settle(h.harness.runtime)
    assert.deepEqual(h.harness.account.state.sends.map(send => send.text), ['大纲在这里', file], '文字经测试聊天发出，文件试过一次')
    const viaWeixin = h.harness.weixin.state.sends
    assert.deepEqual(viaWeixin.map(send => [send.text, send.file?.name]), [['（测试聊天没发出去，下面这个文件改从微信发。）', undefined], [file, '大纲.md']])
    const inserted = outgoingRows(h.harness).find(row => row.system === 'reroute')
    assert.deepEqual([inserted.state, inserted.detour], ['sent', true], '插的那片也记在改道记录里')
    assert.doesNotMatch(h.notice(), /没有送到/)
    assert.match(h.notice(), /第 \d+ 轮回复的文件：测试聊天确定没发出去，已经改从微信发出，不用重发/)
    await h.harness.runtime.close()

    const reopened = await rejectHarness(t, { reopen: { tables: h.harness.tables, credentials: h.harness.credentials, chat: h.harness.chat } })
    await settle(reopened.harness.runtime)
    await settle(reopened.harness.runtime)
    assert.equal(reopened.harness.weixin.state.sends.length, 0, '重启后不重复插、不重发')
    assert.equal(reopened.harness.account.state.sends.length, 0)
    assert.equal(outgoingRows(reopened.harness).filter(row => row.system === 'reroute').length, 1)
})

test('改道：承载的官方 QQ 锚点只剩一次回复时，文件照改道发出、不插说明（说明不占掉文件的额度）', async (t) => {
    const file = await routeFile('大纲.md', '# 大纲\n')
    const harness = await accountHarness(t)
    await fromOfficialQQ(harness, 'q-1', 'QQ 上问')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-q-1' }], assistants: [{ text: ['甲', '乙', '丙'].map(word => word.repeat(800)).join('\n\n') }] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.equal(harness.qq.state.sends.length, 3, '这条 QQ 消息已经回了 3 次，只剩 1 次')
    harness.advance(60_000)
    await fromAccount(harness, 'a-1', '大纲呢')
    await settle(harness.runtime)
    const accept = harness.account.state.sendImpl
    harness.account.state.sendImpl = async (request) => {
        if (request.file !== undefined) throw NOT_SENT()
        return accept(request)
    }
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '大纲在这里' }], presented: [file] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    const viaQQ = harness.qq.state.sends.slice(3)
    assert.deepEqual(viaQQ.map(send => [send.text, send.file?.name]), [[file, '大纲.md']], '只发文件，用掉最后一次')
    assert.equal(outgoingRows(harness).some(row => row.system === 'reroute'), false)
})

test('改道：同一批前面的文字已经改道、开头说过了，后面改道的文件不再插说明（同一批只说一次）', async (t) => {
    const file = await routeFile('大纲.md', '# 大纲\n')
    const h = await rejectHarness(t)
    await h.bothSaid()
    h.script('fail', 'fail')
    h.harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '大纲在这里' }], presented: [file] })
    await settle(h.harness.runtime)
    await settle(h.harness.runtime)
    assert.deepEqual(h.harness.weixin.state.sends.map(send => send.text), [`${NOTE}大纲在这里`, file])
    assert.equal(outgoingRows(h.harness).some(row => row.system === 'reroute'), false)
})

test('时区（core.timezone）：额度说明的恢复时间、英文旁白报告的时刻都按核心给的时区写，不写死北京时间', async (t) => {
    const time = { now: bjAt(21, 19, 21) }
    const reports = []
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000, now: () => time.now, report: (kind, detail) => { reports.push({ kind, ...detail }) } },
        fakeCore: { timezone: 'UTC' },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-q1', text: '那肯定' },
        anchorOf('m-q1'),
    )
    await settle(harness.runtime)
    await harness.runtime.sweepQuota({ quota: limitedQuota([SESSION_ID]) })
    assert.equal(harness.qq.state.sends[0].text, '（5 小时额度用完了，最晚 14:30 恢复，你的消息都收着，恢复后按顺序回，不用重发。）', '北京 22:30 即 UTC 14:30')
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-q1' }], assistants: [{ text: 'Now check the outline.\n\n看完了。' }] })
    await settle(harness.runtime)
    await flush()
    const aside = reports.find(item => item.kind === 'channels/english-aside')
    assert.match(aside.text, /：2026\/3\/10 13:19:21 经QQ发出的/, '北京 21:19:21 即 UTC 13:19:21')
})

test('平台报警（onAlert）：经框架核心照报（类别、subject 是 key、正文照传）；格式不对的不照报，报一条 channels/alert-invalid', async (t) => {
    const h = await rejectHarness(t)
    const alert = data => listenOptions(h.harness.account.state).onAlert(data)
    alert({ kind: 'platform/sender-unresolved', key: 'private:1000/77', text: '认不出这条消息是谁发的' })
    alert({ invalid: '类别不合平台的约定（channels/down）' })
    assert.deepEqual(h.reports.map(({ kind, text, data }) => [kind, text, data]), [
        ['platform/sender-unresolved', '认不出这条消息是谁发的', { subject: 'private:1000/77' }],
        ['channels/alert-invalid', '测试聊天转来的报警格式不对，没有转报：类别不合平台的约定（channels/down）', { subject: 'chat' }],
    ])
})

/**
 * 中枢接着 测试聊天与微信私聊、打开了默认发送的装配；`time.now` 可调（北京时间）。
 * `reopen`（上一次装配的 `{ tables, credentials, chat }`）模拟重启：同一份存储与会话，不再预置绑定。`platforms` 换掉预置的私聊渠道。
 */
async function mainTurnHarness(t, { time, qq = false, reopen, platforms, fakeCore } = {}) {
    const records = []
    const seeded = platforms ?? ['chat', 'weixin', ...qq ? ['qq'] : []]
    const accounts = { 'chat': ['account-qa', 'owner-qa'], weixin: ['account-wx', 'owner-wx'], qq: ['account-qq', 'owner-qq'] }
    const harness = await createHarness({
        account: true,
        ...reopen ?? {
            seed: async ({ tables, credentials }) => {
                for (const platform of seeded) {
                    await seedBinding(tables, credentials, { platform, accountId: accounts[platform][0], senderId: accounts[platform][1] })
                }
            },
        },
        runtime: { mainTurnReplies: true, qqRelayWindowMs: 50 * 60_000, now: () => time.now, report: (kind, detail) => { records.push({ kind, ...detail }) } },
        fakeCore,
    })
    let closed = false
    const close = async () => {
        if (closed) return
        closed = true
        await harness.runtime.close()
    }
    t.after(close)
    await settle(harness.runtime)
    const fromWeixin = async (messageId, text = '微信') => {
        await listenOptions(harness.weixin.state).onMessage(
            { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId, text },
            anchorOf(messageId, { contextToken: `ct-${messageId}` }),
        )
        await settle(harness.runtime)
    }
    const fromQa = async (messageId, text = '测试聊天') => {
        await fromAccount(harness, messageId, text)
        await settle(harness.runtime)
    }
    const turn = async (options) => {
        harness.chat.addTurn(options)
        await settle(harness.runtime)
    }
    const saved = { tables: harness.tables, credentials: harness.credentials, chat: harness.chat }
    return { harness, records, fromWeixin, fromQa, turn, close, saved }
}

test('改道：中枢没有渠道输入的一轮选了测试聊天、测试聊天确定没发出时改从微信发；会话收到改道说明，不说没送到', async (t) => {
    const time = { now: bjAt(15, 0, 0, 11) }
    const { harness, fromWeixin, fromQa, turn } = await mainTurnHarness(t, { time })
    await fromWeixin('w-1', '微信上说')
    await fromQa('a-1', '测试聊天上说')
    await turn({ inputs: [{ rpcId: 'req-w-1' }, { rpcId: 'req-a-1' }], assistants: [{ text: '都收到了' }] })
    const before = { account: harness.account.state.sends.length, weixin: harness.weixin.state.sends.length }
    const accept = harness.account.state.sendImpl
    harness.account.state.sendImpl = async () => { throw Object.assign(new Error('paste not confirmed'), { code: 'NOT_SENT', notSent: true }) }
    await turn({ inputs: [{ rpcId: 'desktop-1', text: '桌面上问一句' }], assistants: [{ text: '桌面上答' }] })
    await settle(harness.runtime)
    harness.account.state.sendImpl = accept
    assert.equal(harness.account.state.sends.length, before.account + 1, '先选测试聊天、试了一次')
    assert.deepEqual(harness.weixin.state.sends.slice(before.weixin).map(send => send.text), ['（测试聊天没发出去，这条改从微信发。）\n桌面上答'])
    const notice = harness.core.noticeOf(SESSION_ID) ?? ''
    assert.doesNotMatch(notice, /没有送到/)
    assert.match(notice, /第 \d+ 轮回复「桌面上答…」：测试聊天确定没发出去，已经改从微信发出，不用重发/)
})

test('中枢每一轮的回复默认发到手机：没有渠道输入的轮发到测试聊天私聊（即使对方最近在微信上说话），有渠道输入的照旧回原渠道，同一轮不发两遍；[不发] 与 [等待] 不发', async (t) => {
    const time = { now: bjAt(15, 0, 0, 11) }
    const { harness, records, fromWeixin, fromQa, turn } = await mainTurnHarness(t, { time })
    await fromQa('a-1', '测试聊天上说')
    await fromWeixin('w-1', '微信上说')
    await turn({ inputs: [{ rpcId: 'req-w-1' }], assistants: [{ text: '微信上回你' }] })
    await turn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '测试聊天上回你' }] })
    assert.deepEqual(harness.weixin.state.sends.map(send => send.text), ['微信上回你'], '渠道输入回到原渠道')
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['测试聊天上回你'])

    await turn({ inputs: [{ rpcId: 'desktop-1', text: '桌面上问一句' }], assistants: [{ text: '我先查一下' }, { text: '桌面上答' }] })
    await turn({ inputs: [{ rpcId: 'external:D1', text: '【外部调用方】部署好了' }], assistants: [{ text: '收到，我去看看' }] })
    await turn({ assistants: [{ text: '[不发]' }] })
    await turn({ assistants: [{ text: '[等待]' }] })
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['测试聊天上回你', '桌面上答', '收到，我去看看'], '只发最后一段，不重复')
    assert.ok(harness.account.state.sends.slice(1).every(send => send.anchor.messageId === 'a-1'), '借对方在测试聊天上最近一条消息的锚点')
    assert.equal(harness.weixin.state.sends.length, 1, '同一轮不再经微信发一遍')
    const rows = outgoingRows(harness).filter(row => row.mainTurn === true)
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.state === 'sent' && row.inputRequestIds[0] === 'req-a-1'))
    assert.deepEqual(records, [], '没有英文旁白')

    // 测试聊天断了：改走微信，开头注明；英文旁白照常发出，另经核心报一条（channels/english-aside）。
    listenOptions(harness.account.state).onLive(false)
    await turn({ assistants: [{ text: 'Now read the outline and check chapter three.\n\n大纲我看完了，第三章没问题。' }] })
    assert.equal(harness.weixin.state.sends.at(-1).text, '（测试聊天现在发不出，这条改从微信发。）\n\nNow read the outline and check chapter three.\n\n大纲我看完了，第三章没问题。')
    assert.equal(harness.account.state.sends.length, 3)
    await flush()
    assert.equal(records.length, 1)
    assert.equal(records[0].kind, 'channels/english-aside')
    assert.equal(records[0].sessionId, 'session-main-1')
    assert.match(records[0].text, /^发出去的回复里有英文旁白 · 中枢：.*经微信发出的第 \d+ 轮回复（没有渠道输入的一轮）：Now read the outline and check chapter three\.$/)
    assert.match(records[0].data.subject, /-0$/)
})

test('中枢的回复在休息时段（0–8 点）：不是用户触发的轮攒到 8 点再发；桌面上说的、接着回失败那一轮里用户的话的，立即发', async (t) => {
    const time = { now: bjAt(0, 30, 0, 11) }
    const { harness, fromQa, turn } = await mainTurnHarness(t, { time })
    await fromQa('a-1', '睡前问一句')
    await turn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '用户的话照常立即回' }] })
    await turn({ inputs: [{ rpcId: 'external:D1' }], assistants: [{ text: '外部调用方那边部署好了' }] })
    await turn({ assistants: [{ text: '【后台一轮】图处理好了' }] })
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['用户的话照常立即回'], '不是用户触发的攒着')
    await turn({ inputs: [{ rpcId: 'desktop-1', text: '电脑上问' }], assistants: [{ text: '桌面上问的立即回' }] })
    assert.equal(harness.account.state.sends.at(-1).text, '桌面上问的立即回')
    // 用户的话那一轮失败了（例如额度用完），恢复后唤醒的那一轮在接着回用户：立即发。
    time.now = bjAt(1, 10, 0, 11)
    await fromQa('a-2', '还醒着吗')
    await turn({ inputs: [{ rpcId: 'req-a-2' }], endKind: 'error' })
    await turn({ inputs: [{ rpcId: 'external:wake' }], assistants: [{ text: '额度恢复了，回你刚才的话' }] })
    assert.equal(harness.account.state.sends.at(-1).text, '额度恢复了，回你刚才的话')
    assert.equal(harness.account.state.sends.length, 3)

    time.now = bjAt(8, 0, 30, 11)
    await settle(harness.runtime)
    assert.equal(harness.account.state.sends.length, 3, '攒着的那两句，用户之后又说过话，过时了，8 点不发')
})

test('中枢攒着的回复：之后用户没说过话，8 点按顺序发出；不重发', async (t) => {
    const time = { now: bjAt(0, 30, 0, 11) }
    const { harness, fromQa, turn } = await mainTurnHarness(t, { time })
    await fromQa('a-1', '睡前问一句')
    await turn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '用户的话照常立即回' }] })
    await turn({ inputs: [{ rpcId: 'external:D1' }], assistants: [{ text: '外部调用方那边部署好了' }] })
    await turn({ assistants: [{ text: '【后台一轮】图处理好了' }] })
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['用户的话照常立即回'], '不是用户触发的攒着')
    time.now = bjAt(8, 0, 30, 11)
    await settle(harness.runtime)
    const after = harness.account.state.sends.slice(1).map(send => send.text)
    assert.deepEqual(after.length === 0 ? (await harness.runtime.wake?.(), await settle(harness.runtime), harness.account.state.sends.slice(1).map(send => send.text)) : after, ['外部调用方那边部署好了', '【后台一轮】图处理好了'], '8 点按顺序发出攒着的')
    await settle(harness.runtime)
    assert.equal(harness.account.state.sends.length, 3, '不重发')
})

test('回答判定：渠道自己的固定说明（等待重试）不算回答——之后那一轮以额度用完失败时额度说明照发；中枢没有渠道输入那一轮的回复也不算', async (t) => {
    const time = { now: bjAt(21, 0, 0) }
    const { harness, turn } = await mainTurnHarness(t, { time, qq: true })
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-qq', conversationId: 'owner-qq', senderId: 'owner-qq', messageId: 'm-s1', text: '这个附件要调整' },
        anchorOf('m-s1'),
    )
    await settle(harness.runtime)
    assert.deepEqual(await harness.runtime.noticeStall({ sessionId: SESSION_ID, code: 'TRANSPORT' }), { status: 'sent', platform: 'qq' })
    assert.equal(outgoingRows(harness).at(-1).system, 'stall')
    assert.deepEqual(await harness.runtime.noticeStall({ sessionId: SESSION_ID, code: 'TRANSPORT' }), { status: 'skipped' }, '同一条只说一次')
    await turn({ inputs: [{ rpcId: 'req-m-s1' }], endKind: 'error' })
    const quota = limitedQuota([SESSION_ID], { since: bjAt(21, 1, 0) })
    const first = await harness.runtime.sweepQuota({ quota })
    assert.deepEqual(first.sent.map(item => [item.kind, item.status]), [['quota', 'sent']], '等待重试的说明不算回答，额度说明照发')
    // 测试聊天与微信上都没有说过话：借官方 QQ 那条消息发，开头注明没走测试聊天。
    assert.match(harness.qq.state.sends.at(-1).text, /^（测试聊天现在发不出，这条改从QQ 官方机器人发。）\n（5 小时额度用完了/)
    time.now = bjAt(21, 20, 0)

    // 中枢没有渠道输入的一轮的回复借了这条消息的锚点，也不算回答了它。
    await turn({ inputs: [{ rpcId: 'desktop-1', text: '桌面上随便问' }], assistants: [{ text: '桌面上答' }] })
    assert.equal(outgoingRows(harness).filter(row => row.mainTurn === true).length, 1)
    // 这条消息仍算在等回答，所以下一次停用照样要说；官方 QQ 这条消息已用掉 3 次（等待说明、额度说明、那一轮的回复），只剩 1 次，留给回复。
    const again = await harness.runtime.sweepQuota({ quota: { ...quota, outageId: 'qout2' } })
    assert.deepEqual(again.sent.map(item => [item.kind, item.status, item.reason]), [['quota', 'unavailable', 'NO_REPLIES_LEFT']])
})

test('额度说明：同中枢的回复，测试聊天私聊优先，不先借官方 QQ 的回复次数；测试聊天断开时改走微信并注明', async (t) => {
    const time = { now: bjAt(21, 0, 0) }
    const { harness, fromQa, fromWeixin } = await mainTurnHarness(t, { time, qq: true })
    await fromQa('a-1')
    await fromWeixin('w-1')
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-qq', conversationId: 'owner-qq', senderId: 'owner-qq', messageId: 'q-1', text: '最近在官方 QQ 上说' },
        anchorOf('q-1'),
    )
    await settle(harness.runtime)
    await harness.runtime.sweepQuota({ quota: limitedQuota([SESSION_ID], { since: bjAt(21, 0, 0) }) })
    assert.equal(harness.qq.state.sends.length, 0, '不借官方 QQ 的回复次数')
    assert.match(harness.account.state.sends.at(-1).text, /^（5 小时额度用完了/)
    listenOptions(harness.account.state).onLive(false)
    await harness.runtime.sweepQuota({ quota: limitedQuota([SESSION_ID], { outageId: 'qout3', since: bjAt(21, 0, 0) }) })
    assert.match(harness.weixin.state.sends.at(-1).text, /^（测试聊天现在发不出，这条改从微信发。）\n（5 小时额度用完了/)
    assert.equal(harness.qq.state.sends.length, 0)
})

test('中枢攒着的回复：7:50 停机、8:10 重启也照发——攒着的状态与起点都存着，不靠内存；再重启不重发', async (t) => {
    const time = { now: bjAt(1, 0, 0, 11) }
    const first = await mainTurnHarness(t, { time })
    await first.fromQa('a-1', '睡前说一句')
    await first.turn({ inputs: [{ rpcId: 'external:D1' }], assistants: [{ text: '外部调用方那边部署好了' }] })
    assert.equal(first.harness.account.state.sends.length, 0, '夜里攒着')
    const held = [...first.harness.tables.maps.main_turns.values()].filter(row => row.kind === 'turn')
    assert.deepEqual(held.map(row => [row.state, row.heldUntil]), [['held', bjAt(8, 0, 0, 11)]])
    time.now = bjAt(7, 50, 0, 11)
    await first.close()

    time.now = bjAt(8, 10, 0, 11)
    const second = await mainTurnHarness(t, { time, reopen: first.saved })
    assert.deepEqual(second.harness.account.state.sends.map(send => send.text), ['外部调用方那边部署好了'])
    assert.equal(second.harness.account.state.sends[0].anchor.messageId, 'a-1')
    await second.close()

    const third = await mainTurnHarness(t, { time, reopen: first.saved })
    await settle(third.harness.runtime)
    assert.equal(third.harness.account.state.sends.length, 0, '已经发过的不重发')
})

test('攒着的回复过时了不发：之后用户说过话', async (t) => {
    const time = { now: bjAt(1, 0, 0, 11) }
    const { harness, fromQa, turn } = await mainTurnHarness(t, { time })
    await fromQa('a-1', '睡前说一句')
    await turn({ inputs: [{ rpcId: 'external:D1' }], assistants: [{ text: '夜里攒着的那句' }] })
    assert.equal(harness.account.state.sends.length, 0, '夜里攒着')
    time.now = bjAt(3, 0, 0, 11)
    await turn({ inputs: [{ rpcId: 'desktop-1', text: '已查看前面的测试结果' }], assistants: [{ text: '好的' }] })
    const told = harness.account.state.sends.map(send => send.text)
    assert.deepEqual(told, ['好的'], '用户说话那一轮照常立即回')
    time.now = bjAt(8, 10, 0, 11)
    await harness.runtime.wake?.()
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), told, '攒着的那句过时了，到点也不发')
    const rows = [...harness.tables.maps.main_turns.values()].filter(row => row.kind === 'turn')
    assert.ok(rows.every(row => row.state !== 'held'), '不留在攒着的状态')
})

test('攒着的回复过时了不发：之后已经有话发到用户手上；没过时的到点照发', async (t) => {
    const time = { now: bjAt(1, 0, 0, 11) }
    const { harness, fromQa, turn } = await mainTurnHarness(t, { time })
    await fromQa('a-1', '睡前说一句')
    await turn({ inputs: [{ rpcId: 'external:D1' }], assistants: [{ text: '第一句：已经被后面那句说过了' }] })
    await turn({ inputs: [{ rpcId: 'schedule-1', text: '到点了' }], assistants: [{ text: '提醒：开会' }], route: { onBehalfOfUser: true } })
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['提醒：开会'], '代用户的立即发')
    await turn({ inputs: [{ rpcId: 'external:D2' }], assistants: [{ text: '第二句：之后没人说过' }] })
    time.now = bjAt(8, 10, 0, 11)
    await harness.runtime.wake?.()
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['提醒：开会', '第二句：之后没人说过'])
})

test('攒着的回复：之后落了边界、从记录里枚举不到它了，到点照样发（不靠当前记录）', async (t) => {
    const time = { now: bjAt(1, 0, 0, 11) }
    const { harness, fromQa, turn } = await mainTurnHarness(t, { time })
    await fromQa('a-1', '睡前说一句')
    await turn({ inputs: [{ rpcId: 'external:D1' }], assistants: [{ text: '夜里攒着的那句' }] })
    const [held] = [...harness.tables.maps.main_turns.values()].filter(row => row.kind === 'turn' && row.state === 'held')
    assert.ok(held.sourceSeqs.length > 0, '发送要用的存下来了')
    // 边界：这一轮的回复不在当前记录里了（日志还在），枚举不到它。
    const surface = harness.chat.state.surfaceEvents
    const reply = surface.findIndex(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('夜里攒着的那句'))
    assert.ok(reply >= 0)
    surface.splice(reply, 1)
    time.now = bjAt(8, 10, 0, 11)
    await harness.runtime.wake?.()
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['夜里攒着的那句'], '发出去了，没有因为对不上当前记录被拦下')
    assert.equal(outgoingRows(harness).at(-1).state, 'sent')
    assert.equal(outgoingRows(harness).at(-1).errorCode, null)
    await settle(harness.runtime)
    assert.equal(harness.account.state.sends.length, 1, '不重发')
})

test('引用：同一条重推不算冲突（引用那一行变了也一样）；太短的已发消息不按文字认', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const binding = [...harness.tables.maps.bindings.values()].map(row => row.record ?? row).find(row => row.platform === 'qq')
    const row = (text, id) => ({
        bindingId: binding.bindingId, sessionId: binding.sessionId, turn: 3, endSeq: 90, sourceSeqs: [88], inputRequestIds: ['req-x'], partIndex: 0, partCount: 1,
        text, anchorKey: 'galatea-channels/anchor-1', state: 'sent', receipt: { kind: 'platform-accepted', platformMessageId: id, clientId: null }, errorCode: null,
    })
    harness.tables.maps.outgoing.set('delivery-short', row('收到', 'short-1'))
    const options = listenOptions(harness.qq.state)
    const envelope = (id, quote) => ({ kind: 'private', platform: 'qq', accountId: binding.accountId, conversationId: binding.conversationId, senderId: binding.senderId, messageId: id, text: '嗯', quote })
    assert.equal((await options.onMessage(envelope('r1', { text: '收到：这是一段测试用的长文本' }), anchorOf('r1'))).status, 'persisted')
    await settle(harness.runtime)
    assert.equal(harness.ingressLog.admits.at(-1).message.text, '〔引用：收到：这是一段测试用的长文本〕\n嗯', '不把别人的话认成我们发的"收到"')
    // 重推：这时候投递记录里有了能对上的一条，引用那一行会不一样，但还是同一条消息。
    harness.tables.maps.outgoing.set('delivery-long', row('收到：这是一段测试用的长文本', 'long-1'))
    assert.equal((await options.onMessage(envelope('r1', { text: '收到：这是一段测试用的长文本' }), anchorOf('r1'))).status, 'duplicate')
    const [, stored] = incomingRows(harness).find(([, value]) => value.platformMessageId === 'r1')
    assert.notEqual(stored.state, 'conflict')
})

test('引用：按平台编号、ref_idx、文字认出是我们发的，只写开头和编号；对不上的写开头或"引用了一条消息"；原话还在', async (t) => {
    const LONG = '这是我们发出去的一段比较长的回复，开头四十个字以内会写进标记，后面的部分不进标记只在经历库里能查到。'
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const binding = [...harness.tables.maps.bindings.values()].map(row => row.record ?? row).find(row => row.platform === 'qq')
    const sent = {
        bindingId: binding.bindingId, sessionId: binding.sessionId, turn: 3, endSeq: 90, sourceSeqs: [88], inputRequestIds: ['req-x'], partIndex: 0, partCount: 1,
        text: LONG, anchorKey: 'galatea-channels/anchor-1', state: 'sent',
        receipt: { kind: 'platform-accepted', platformMessageId: 'sent-1', clientId: null, refIdx: 'REFIDX_1' }, errorCode: null,
    }
    harness.tables.maps.outgoing.set('delivery-quoted', sent)
    const options = listenOptions(harness.qq.state)
    const say = async (id, text, quote) => {
        await options.onMessage({ kind: 'private', platform: 'qq', accountId: binding.accountId, conversationId: binding.conversationId, senderId: binding.senderId, messageId: id, text, ...quote === undefined ? {} : { quote } }, anchorOf(id))
        await settle(harness.runtime)
        return harness.ingressLog.admits.at(-1).message.text
    }
    const id = `dsh:${binding.sessionId}:88`
    const line = `〔引用你发的：${LONG.slice(0, 40)}…，全文见 ${id}〕`
    assert.equal(await say('q1', '这个对', { platformMessageId: 'sent-1' }), `${line}\n这个对`, '微信给的编号')
    assert.equal(await say('q2', '这个也对', { refIdx: 'REFIDX_1' }), `${line}\n这个也对`, 'QQ 官方给的 ref_idx')
    assert.equal(await say('q3', '回复', { label: '助手 12:00', text: `  ${LONG}` }), `${line}\n回复`, '只有全文时按文字认')
    assert.ok(!(await say('q4', '不要全文', { text: LONG })).includes('只在经历库里能查到'), '不放全文')
    assert.equal(await say('q5', '别的', { label: '对方 12:10', text: '他自己以前说的一句话，发出去的记录里没有' }), '〔引用 对方 12:10：他自己以前说的一句话，发出去的记录里没有〕\n别的')
    assert.equal(await say('q6', '图', { refIdx: 'REFIDX_9', image: 'picture.png' }), '〔引用了一张图片（picture.png）〕\n图')
    assert.equal(await say('q7', '啥', { platformMessageId: 'unknown' }), '〔引用了一条消息〕\n啥')
    assert.equal(await say('q8', '没引用'), '没引用')
    const parsed = channelTableSchemas.outgoing.parse(sent)
    assert.equal(parsed.receipt.refIdx, 'REFIDX_1', '投递记录的结构收下 refIdx')
})

test('中枢第一次启用在夜里：启用前当夜早先结束的轮是历史，8 点也不补发；启用后攒着的照发', async (t) => {
    const chat = createChatSession()
    chat.addTurn({ inputs: [{ rpcId: 'external:early' }], assistants: [{ text: '一点钟的外部调用方回复' }] })
    chat.addTurn({ assistants: [{ text: '两点钟的后台一轮' }] })
    const time = { now: bjAt(3, 0, 0, 11) }
    const { harness, fromQa, turn } = await mainTurnHarness(t, { time, reopen: { chat, seed: async ({ tables, credentials }) => {
        await seedBinding(tables, credentials, { platform: 'chat', accountId: 'account-qa', senderId: 'owner-qa' })
    } } })
    const from = [...harness.tables.maps.main_turns.values()].find(row => row.kind === 'from')
    assert.equal(from.seq, chat.cursor(), '起点是第一次启用时会话的最后序号')
    await fromQa('a-1', '还没睡')
    await turn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '用户的话照常回' }] })
    await turn({ inputs: [{ rpcId: 'external:late' }], assistants: [{ text: '三点半的外部调用方回复' }] })
    time.now = bjAt(8, 0, 30, 11)
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['用户的话照常回', '三点半的外部调用方回复'])
})

test('中枢只有官方 QQ：回复因锚点过了窗口整批留待，对方再发消息、得到回答后换新锚补发一次，不再按普通片发第二遍', async (t) => {
    const time = { now: bjAt(15, 0, 0, 11) }
    const { harness, turn } = await mainTurnHarness(t, { time, platforms: ['qq'] })
    const fromQQ = async (messageId, text) => {
        await fromOfficialQQ(harness, messageId, text)
        await settle(harness.runtime)
    }
    await fromQQ('q-1', '画三张')
    await turn({ inputs: [{ rpcId: 'req-q-1' }], assistants: [{ text: '开始处理' }] })
    time.now = bjAt(15, 51, 0, 11)
    await turn({ inputs: [{ rpcId: 'external:D1' }], assistants: [{ text: '三张处理好了' }] })
    assert.deepEqual(harness.qq.state.sends.map(send => send.text), ['开始处理'])
    assert.deepEqual(outgoingRows(harness).filter(row => row.deferred === true).map(row => [row.text, row.mainTurn]), [['三张处理好了', true]])
    await fromQQ('q-2', '好了吗')
    await turn({ inputs: [{ rpcId: 'req-q-2' }], assistants: [{ text: '好了' }] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.deepEqual(harness.qq.state.sends.map(send => [send.text, send.anchor.messageId]),
        [['开始处理', 'q-1'], ['好了', 'q-2'], ['三张处理好了', 'q-2']], '补发一次，不再发第二遍')
    const decided = [...harness.tables.maps.main_turns.values()].filter(row => row.kind === 'turn')
    assert.deepEqual(decided.map(row => [row.state, row.inputRequestIds]), [['sending', ['req-q-1']]], '一轮一条决定，锚点仍是当初那条')
})

/* ------------------- 没有渠道输入的轮按核心记下的回复去向发 ------------------- */

/** 程序经核心放进会话的一条话（kind 不是 user、带 deliveryKey）。 */
const programInput = (key, text) => ({ rpcId: key, text, source: { kind: 'work', deliveryKey: key } })

test('中枢里没有渠道输入的轮按去向：休息时段里代用户的（定时提醒）立即发；{to:"none"} 的不发；没有去向记录的不发、报一次；别的留到时段结束', async (t) => {
    const time = { now: bjAt(0, 30, 0, 11) }
    const { harness, fromQa, turn } = await mainTurnHarness(t, { time, fakeCore: { defaultRoute: null } })
    await fromQa('a-1', '睡前问一句')
    await turn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '用户的话照常立即回' }] })
    await turn({ inputs: [{ rpcId: 'schedule-1', text: '提醒', source: { kind: 'schedule' } }], assistants: [{ text: '提醒：吃药' }], route: { onBehalfOfUser: true } })
    await turn({ inputs: [programInput('work-1', '持续工作的一轮')], assistants: [{ text: '不外发的一轮' }], route: { to: 'none' } })
    await turn({ inputs: [programInput('contact-1', '主动联系')], assistants: [{ text: '处理好了，明早看' }], route: { to: 'origin' } })
    await turn({ inputs: [programInput('old-1', '核心装上以前的')], assistants: [{ text: '没有去向记录' }] })
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['用户的话照常立即回', '提醒：吃药'], '代用户的立即发，其余不发或攒着')
    assert.deepEqual(harness.core.reports.map(item => item.kind), ['channels/no-turn-route'])

    time.now = bjAt(8, 0, 30, 11)
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.slice(2).map(send => send.text), ['处理好了，明早看'], '时段结束只发攒着的那一轮')
    assert.equal(harness.core.reports.length, 1, '没有去向记录的轮只报一次')
})

test('接群会话里没有渠道输入的轮按去向：休息时段里代用户的立即发到群里，{to:"exit"} 的留到时段结束；别的会话开的不外发', async (t) => {
    const time = { now: bjAt(23, 0, 0, 11) }
    const { harness, project } = await groupHarness(t, { runtime: { now: () => time.now } })
    await fromGroup(harness, 'g-1', '先接上')
    await settle(harness.runtime)
    project.addTurn({ inputs: [{ rpcId: 'req-g-1' }], assistants: [{ text: '接上了' }] })
    await settle(harness.runtime)
    time.now = bjAt(1, 0, 0, 12)
    const before = harness.account.state.sends.length
    project.addTurn({ inputs: [{ rpcId: 'schedule-1', text: '提醒', source: { kind: 'schedule' } }], assistants: [{ text: '提醒：交稿' }], route: { onBehalfOfUser: true } })
    project.addTurn({ inputs: [programInput('session-main-1', '在群里说一声')], assistants: [{ text: '初稿好了' }], route: { to: 'exit' } })
    project.addTurn({ inputs: [programInput('session-main-2', '你看看这个')], assistants: [{ text: '看完了' }], route: { to: 'origin' } })
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.slice(before).map(send => [send.peerId, send.text]), [['group:777', '提醒：交稿']])
    time.now = bjAt(8, 0, 30, 12)
    await settle(harness.runtime)
    await settle(harness.runtime)
    assert.deepEqual(harness.account.state.sends.slice(before).map(send => [send.peerId, send.text]), [['group:777', '提醒：交稿'], ['group:777', '初稿好了']], '别的会话开的那一轮始终不外发')
})

test('出口登记：私聊绑定指向的会话接成中枢，群绑定接着的会话接成群（带群名）', async (t) => {
    const { harness } = await groupHarness(t)
    await fromGroup(harness, 'g-1', '先接上')
    await settle(harness.runtime)
    assert.deepEqual(harness.runtime.exitSessions(), [
        { sessionId: SESSION_ID, as: 'hub' },
        { sessionId: PROJECT_SESSION, as: 'group', label: '群「项目-远航」' },
    ])
})

test('没有渠道输入的轮，结果是"不发"但交了文件的：只发文件、不发那句不发标记；整条 [不发] 又没有文件的，什么都不发', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-silent-files-'))
    const file = join(dir, '第三章.md')
    await writeFile(file, '# 第三章\n')
    const time = { now: bjAt(14, 0, 0, 11) }
    const { harness, fromQa, turn } = await mainTurnHarness(t, { time })
    await fromQa('a-1', '先说一句')
    await turn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '好' }] })
    const before = harness.account.state.sends.length
    await turn({ inputs: [programInput('work-1', '持续工作的一轮')], assistants: [{ text: '[不发]' }], presented: [file] })
    const sent = harness.account.state.sends.slice(before)
    assert.equal(sent.length, 1, '只发了文件')
    assert.equal(sent[0].file?.name, '第三章.md')
    assert.equal(Buffer.from(sent[0].file.bytes).toString('utf8'), '# 第三章\n')
    assert.ok(!sent.some(send => typeof send.text === 'string' && send.text.includes('不发')), '不发标记没有发出去')
    await turn({ inputs: [programInput('work-2', '又一轮')], assistants: [{ text: '[不发]' }] })
    assert.equal(harness.account.state.sends.length, before + 1, '整条不发、没有文件的什么都不发')
})

test('中途发送记进经历库（来源 channel-pushes）：一次发送一条，几片合成一条；没发出去的注明；外部调用方写明名字；渠道自己的说明记成渠道提醒', async (t) => {
    const entries = []
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000, pushed: entry => { entries.push(entry) } },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-1', text: '读完告诉我' },
        anchorOf('m-1'),
    )
    await settle(harness.runtime)
    await harness.runtime.push({ sessionId: SESSION_ID, text: '好，开始读。', by: { kind: 'session', sessionId: SESSION_ID, role: 'hub' } })
    await flush()
    assert.equal(entries.length, 1)
    const [first] = entries
    assert.match(first.id, new RegExp(`^push:${SESSION_ID}:[^:]+:\\d+$`))
    assert.deepEqual([first.thread, first.tie, first.role, first.kind, first.party, first.text], [SESSION_ID, 0, 'assistant', '中途发给用户', 'QQ', '好，开始读。'])

    harness.qq.state.sendImpl = async () => { throw Object.assign(new Error('rejected'), { code: 'SEND_REJECTED', definitelyRejected: true }) }
    await harness.runtime.push({ sessionId: SESSION_ID, text: '第二句', by: { kind: 'external', name: 'dev', readOnly: false } })
    await flush()
    assert.equal(entries[1].text, '（外部调用方 dev 经端点发的）\n第二句\n\n（没有发出去）')

    assert.deepEqual(pushEntryOf([{ sessionId: 's', bindingId: 'b', endSeq: 5, partIndex: 0, text: '（网络断了，等恢复）', state: 'sent', system: 'stall' }], '微信'),
        { id: 'push:s:b:5', thread: 's', at: 5, tie: 0, party: '微信', role: 'system', kind: '渠道提醒', text: '（网络断了，等恢复）' })
    assert.equal(pushEntryOf([{ sessionId: 's', bindingId: 'b', endSeq: 6, partIndex: 0, kind: 'image', text: 'C:/a.png', state: 'sent' }, { sessionId: 's', bindingId: 'b', endSeq: 6, partIndex: 1, kind: 'voice', text: 'C:/a.wav', state: 'sent' }], 'qq').text,
        '[图片]\n[语音]', '图片和语音不写路径')
})

test('额度现状问核心：状态和恢复时间来自 core.quota.detail(中枢)，撞了额度的会话从日志现推（最后一轮的错误码是执行方闸门管的）；渠道不认具体执行方', async (t) => {
    const time = { now: bjAt(21, 19, 21) }
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, {}),
        runtime: { qqRelayWindowMs: 50 * 60_000, now: () => time.now },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    await listenOptions(harness.qq.state).onMessage(
        { kind: 'private', platform: 'qq', accountId: 'account-1', conversationId: 'owner-1', senderId: 'owner-1', messageId: 'm-q1', text: '那肯定' },
        anchorOf('m-q1'),
    )
    await settle(harness.runtime)
    harness.core.quotaDetail = { state: 'limited', since: bjAt(21, 17, 20), resetsAt: RESETS_AT, window: 'five_hour', outageId: 'qout1', windows: {} }
    assert.deepEqual((await harness.runtime.sweepQuota()).sent, [], '会话最后一轮没以额度用完结束：没有要说的')
    // 这一轮以 USAGE_LIMIT 结束（执行方闸门管的错误码）：现推出这个会话撞了额度。
    harness.chat.state.events.push({ type: 'turn/start', seq: harness.chat.state.events.length, time: 1, data: { turn: 99 } })
    harness.chat.state.events.push({ type: 'turn/end', seq: harness.chat.state.events.length, time: 2, data: { turn: 99, reason: { kind: 'error', error: { code: 'USAGE_LIMIT' } } } })
    const first = await harness.runtime.sweepQuota()
    assert.deepEqual(first.sent.map(item => [item.kind, item.status]), [['quota', 'sent']])
    assert.equal(harness.qq.state.sends.at(-1).text, '（5 小时额度用完了，最晚 22:30 恢复，你的消息都收着，恢复后按顺序回，不用重发。）')
    harness.core.quotaDetail = { ...harness.core.quotaDetail, state: 'ok' }
    assert.deepEqual((await harness.runtime.sweepQuota()).sent, [], '状态只看核心的：恢复了就不说')
})

/* ---------------------------- 自查（原来 Watchdog 读渠道的状态做的） ---------------------------- */

test('自查：已绑定的平台连续两次不是已连接才报 channels/down（subject 是平台），并自己重连一次；同一次断开只报一次；恢复后报 resolved；刚启动时已连接的也报一次 resolved', async (t) => {
    const time = { now: bjAt(15, 0, 0, 11) }
    const { harness, records } = await mainTurnHarness(t, { time })
    const downs = () => records.filter(item => item.kind === 'channels/down')
    await harness.runtime.checkHealth()
    assert.deepEqual(downs().map(item => [item.data.subject, item.data.resolved]).sort(), [['chat', true], ['qq', true], ['weixin', true]], '重启前可能报过，第一次看到没断开（已连接、或没绑定）就报一次好了')
    records.length = 0

    listenOptions(harness.account.state).onLive(false)
    await harness.runtime.checkHealth()
    assert.equal(downs().length, 0, '一次不算')
    const listens = harness.account.state.listens.length
    await harness.runtime.checkHealth()
    assert.equal(downs().length, 1)
    assert.equal(downs()[0].data.subject, 'chat')
    assert.equal(downs()[0].data.resolved, undefined)
    assert.match(downs()[0].text, /^消息渠道 测试聊天 不是已连接（connecting），连续 2 次；已重连一次$/)
    await settle(harness.runtime)
    assert.ok(harness.account.state.listens.length > listens, '自己重连了一次')

    listenOptions(harness.account.state).onLive(false)
    await harness.runtime.checkHealth()
    await harness.runtime.checkHealth()
    assert.equal(downs().length, 1, '同一次断开不重报、不再重连')
    listenOptions(harness.account.state).onLive(true)
    await harness.runtime.checkHealth()
    assert.deepEqual(downs().at(-1).data, { subject: 'chat', resolved: true })
    assert.equal(downs().length, 2)
})

test('自查：回复没送到、现在补不了的，每个绑定报一条 channels/undelivered（subject 是绑定）；没变不重报；告诉会话以后报 resolved', async (t) => {
    const { harness, say, failWith, recover, reports } = await failureHarness(t, () => false)
    const undelivered = () => reports.filter(item => item.kind === 'channels/undelivered')
    await say('m-a', '测试附件在哪')
    failWith(REJECTED())
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-a' }], assistants: [{ text: '附件在这里，第三个已处理。' }] })
    await settle(harness.runtime)
    await harness.runtime.checkHealth()
    assert.equal(undelivered().length, 1)
    const [first] = undelivered()
    const bindingId = harness.runtime.undelivered()[0].bindingId
    assert.equal(first.data.subject, bindingId)
    assert.equal(first.sessionId, SESSION_ID)
    assert.match(first.text, /^回复没送到 · 中枢（QQ私聊）：第 \d+ 轮回复「附件在这里，第三个已处理。…」（确定没送到）。现在不能主动补发。等对方下一条消息时告诉会话；可以经别的现在能送达的渠道告诉用户（主动联系）$/)
    await harness.runtime.checkHealth()
    assert.equal(undelivered().length, 1, '没变不重报')

    recover()
    harness.core.takeNotices(SESSION_ID, { restart: true })
    await harness.runtime.wake()
    await settle(harness.runtime)
    assert.deepEqual(harness.runtime.undelivered(), [])
    await harness.runtime.checkHealth()
    assert.deepEqual(undelivered().at(-1).data, { subject: bindingId, resolved: true })
})

/* ------------------------------------------------------------------ *
 * 平台登记、所有平台一样的后台投递与断开告警、回复先后与改道说明（preview.1）
 * ------------------------------------------------------------------ */

/** 中枢接着官方 QQ 和微信私聊（没有登记别的平台）。 */
async function qqWeixinHarness(t, runtime = {}, { qq = true } = {}) {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => {
            if (qq) await seedBinding(tables, credentials, { platform: 'qq', accountId: 'account-qq', senderId: 'owner-qq' })
            await seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' })
        },
        runtime: { qqRelayWindowMs: 50 * 60_000, downAlarmMs: 10 * 60_000, ...runtime },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    return harness
}

function fromWeixinOwner(harness, messageId, text = '微信') {
    return listenOptions(harness.weixin.state).onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId, text },
        anchorOf(messageId, { contextToken: `ct-${messageId}` }),
    )
}

test('断开告警对所有平台一样：官方 QQ 短暂断开马上重连不算；微信一直连不上超过时限，对方从官方 QQ 说话时告诉一次；恢复后复位，再断再告诉', async (t) => {
    const harness = await qqWeixinHarness(t)
    const notice = downNoticeOf('微信', false)
    const notices = () => harness.qq.state.sends.map(send => send.text).filter(text => text.includes('断开了'))

    // 官方 QQ 的连接断了、马上重连上（SDK 自己重连的不经运行态；这里是 listen 本身断了又起来）：不算断开。
    harness.qq.state.drop()
    await settle(harness.runtime)
    assert.equal(channel(harness, 'qq').connected, true, '重连上了')
    await fromWeixinOwner(harness, 'w-0', '在吗')
    harness.advance(11 * 60_000)
    await settle(harness.runtime)
    assert.ok(harness.weixin.state.sends.every(send => !send.text.includes('断开了')), '短暂重连不告警')

    // 微信一直连不上。
    harness.weixin.state.listenDown = true
    harness.weixin.state.drop()
    await settle(harness.runtime)
    assert.equal(channel(harness, 'weixin').connected, false)
    harness.advance(11 * 60_000)
    await fromOfficialQQ(harness, 'q-1', '在吗')
    await settle(harness.runtime)
    assert.deepEqual(notices(), [notice], '断开超过时限，经官方 QQ 告诉一次（微信不在回复先后的第一位：不说会自动回到它）')
    harness.advance(60_000)
    await fromOfficialQQ(harness, 'q-2', '还在吗')
    await settle(harness.runtime)
    assert.deepEqual(notices(), [notice], '一次断开只告诉一次')

    // 恢复：复位。再断开超过时限，再告诉一次。
    harness.weixin.state.listenDown = false
    await settle(harness.runtime)
    assert.equal(channel(harness, 'weixin').connected, true, '恢复了')
    harness.weixin.state.listenDown = true
    harness.weixin.state.drop()
    await settle(harness.runtime)
    harness.advance(11 * 60_000)
    await fromOfficialQQ(harness, 'q-3', '又断了？')
    await settle(harness.runtime)
    assert.deepEqual(notices(), [notice, notice], '恢复后复位：新的一次断开再告诉')
})

test('断开告警：没有别的可用渠道时不发、不报错，也不留下未送达记录', async (t) => {
    const harness = await qqWeixinHarness(t, {}, { qq: false })
    await fromWeixinOwner(harness, 'w-1', '在吗')
    await settle(harness.runtime)
    harness.weixin.state.listenDown = true
    harness.weixin.state.drop()
    await settle(harness.runtime)
    harness.advance(11 * 60_000)
    await harness.runtime.wake()
    await settle(harness.runtime)
    assert.equal(harness.weixin.state.sends.length, 0)
    assert.equal(outgoingRows(harness).filter(row => row.system === 'account').length, 0)
})

test('每个绑定在自己的后台投递里发：卡住的微信不挡官方 QQ 的收发；同一绑定的片按顺序发；结果不明的不重发', async (t) => {
    const harness = await qqWeixinHarness(t)
    await fromWeixinOwner(harness, 'w-1', '微信提问')
    await settle(harness.runtime)
    let release
    const gate = new Promise(resolve => {
        release = resolve
    })
    const accept = harness.weixin.state.sendImpl
    harness.weixin.state.sendImpl = async (request) => {
        await gate
        return accept(request)
    }
    const text = `${'甲'.repeat(1000)}${'乙'.repeat(600)}`
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-w-1' }], assistants: [{ text }] })
    const waking = harness.runtime.wake()
    try {
        await waitFor(() => harness.weixin.state.sends.length === 1, '微信第一片卡在发送里')
        harness.advance(60_000)
        fromOfficialQQ(harness, 'q-1', '官方提问').catch(() => {})
        await waitFor(() => incomingRows(harness).some(([, row]) => row.platformMessageId === 'q-1' && row.state === 'accepted'), '官方 QQ 的话已准入')
        harness.chat.addTurn({ inputs: [{ rpcId: 'req-q-1' }], assistants: [{ text: '官方的回复' }] })
        harness.runtime.wake().catch(() => {})
        await waitFor(() => harness.qq.state.sends.length === 1, '官方 QQ 的回复不等微信')
        assert.equal(harness.weixin.state.sends.length, 1, '微信还卡着')
    } finally {
        // 断言失败时也放开卡住的发送：不然关闭运行态会一直等它。
        release()
    }
    await waking
    await settle(harness.runtime)
    assert.deepEqual(harness.weixin.state.sends.map(send => send.text), splitReplyText(text, 1000), '同一绑定按顺序发完')

    // 结果不明的片照旧记 unknown、不重发（和以前在对账循环里直接发时一样）。
    harness.weixin.state.sendImpl = async () => { throw Object.assign(new Error('timeout'), { code: 'SEND_TIMEOUT', resultUnknown: true }) }
    harness.advance(60_000)
    await fromWeixinOwner(harness, 'w-2', '再问')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-w-2' }], assistants: [{ text: '第二次的回复' }] })
    await settle(harness.runtime)
    await settle(harness.runtime)
    const unknown = outgoingRows(harness).filter(row => row.text === '第二次的回复')
    assert.deepEqual(unknown.map(row => row.state), ['unknown'])
    assert.equal(harness.weixin.state.sends.filter(send => send.text === '第二次的回复').length, 1, '不重发')
})

test('登记平台：名字合规、不能重名、要有渠道名、支持群的只能有一个；渠道名进状态；撤销后停掉连接、绑定留着，再登记接着用', async (t) => {
    const harness = await accountHarness(t)
    assert.deepEqual([channel(harness, 'chat').label, channel(harness, 'chat').builtin, channel(harness, 'qq').builtin], ['测试聊天', false, true])
    const plain = { pair: async () => ({}), listen: async () => {}, send: async () => ({}) }
    assert.throws(() => harness.runtime.registerPlatform({ id: 'chat', label: '重名', platform: plain }), /已经装着了/)
    assert.throws(() => harness.runtime.registerPlatform({ id: 'Bad Name', label: '名字不对', platform: plain }), /不合规/)
    assert.throws(() => harness.runtime.registerPlatform({ id: 'other', platform: plain }), /要有 label/)
    assert.throws(() => harness.runtime.registerPlatform({ id: 'other', label: '缺 send', platform: { pair: plain.pair, listen: plain.listen } }), /pair\/listen\/send/)
    assert.throws(() => harness.runtime.registerPlatform({ id: 'other', label: '也有群', platform: { ...plain, groupList: async () => [] } }), /只能有一个/)

    await fromAccount(harness, 'a-1', '测试聊天提问')
    await settle(harness.runtime)
    const listen = listenOptions(harness.account.state)
    harness.unregister()
    await settle(harness.runtime)
    assert.equal(listen.signal.aborted, true, '停掉了它的连接')
    assert.equal(harness.runtime.status().channels.some(item => item.platform === 'chat'), false, '状态里没有它了')
    assert.ok(harness.tables.maps.bindings.get('chat') !== undefined, '绑定留着')

    const again = harness.runtime.registerPlatform({ id: 'chat', label: CHAT_LABEL, platform: harness.account.platform })
    await settle(harness.runtime)
    assert.equal(channel(harness, 'chat').connected, true, '再登记就接着用原来的绑定')
    again()
})

test('回复先后与改道说明是配置：replyOrder 空时发到对方最近说话的渠道；rerouteNote 关着时不注明', async (t) => {
    const harness = await accountHarness(t, { replyOrder: [], rerouteNote: false })
    await fromAccount(harness, 'a-1', '先在测试聊天说')
    await settle(harness.runtime)
    harness.advance(60_000)
    await fromOfficialQQ(harness, 'q-1', '后在官方 QQ 说')
    await settle(harness.runtime)
    const result = await harness.runtime.noticeUser({ sessionId: SESSION_ID, key: 'k-order', text: '一句说明' })
    assert.equal(result.platform, 'qq', '最近在官方 QQ 说的')
    assert.deepEqual(harness.qq.state.sends.map(send => send.text), ['一句说明'], '不注明改道')
})

test('发送节奏的等待在记“发送中”之前：等的时候这一片还没记成发送中（进程这时退出，重启后照常发）', async (t) => {
    const seen = []
    const box = {}
    box.harness = await accountHarness(t, {
        sleep: async (milliseconds) => {
            if (milliseconds !== CHAT_PACE.first || box.harness === undefined) return
            const chatId = box.harness.tables.maps.bindings.get('chat')?.bindingId
            seen.push(outgoingRows(box.harness).filter(row => row.bindingId === chatId && row.text === '一句回复').map(row => row.state))
        },
    })
    const harness = box.harness
    await fromAccount(harness, 'a-1', '测试聊天提问')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-a-1' }], assistants: [{ text: '一句回复' }] })
    await settle(harness.runtime)
    assert.ok(seen.length >= 1, '按节奏等过')
    assert.ok(seen.every(states => !states.includes('sending')), `等的时候没有记成发送中：${JSON.stringify(seen)}`)
    assert.deepEqual(harness.account.state.sends.map(send => send.text), ['一句回复'])
})

test('README“接新平台”的最小例子原样能用：登记、配对、收一句话、回复发出去', async (t) => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const block = /```js\n(\/\/ demo-platform\.js\n[\s\S]*?)\n\/\/ index\.js/.exec(readme)?.[1]
    assert.ok(block !== undefined, 'README 里有 demo-platform.js 的代码')
    const dir = await mkdtemp(join(tmpdir(), 'channels-readme-'))
    await writeFile(join(dir, 'demo-platform.mjs'), block)
    const { createDemoPlatform } = await import(pathToFileURL(join(dir, 'demo-platform.mjs')).href)

    const harness = await createHarness({})
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const printed = []
    const log = console.log
    console.log = (...args) => printed.push(args.join(' '))
    t.after(() => {
        console.log = log
    })
    const platform = createDemoPlatform()
    harness.runtime.registerPlatform({ id: 'demo', label: '演示', platform })
    assert.equal(channel(harness, 'demo').label, '演示')
    await harness.runtime.beginPair('demo')
    await waitFor(() => harness.tables.maps.bindings.get('demo')?.enabled === true, '配对好了')
    await settle(harness.runtime)
    assert.equal(channel(harness, 'demo').connected, true)
    assert.deepEqual(await platform.receive('你好'), { status: 'persisted' })
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-in-1' }], assistants: [{ text: '你好呀' }] })
    await settle(harness.runtime)
    assert.deepEqual(printed, ['→ me: 你好呀'])
})

test('sentBetween：只交会话中途发到用户手上的话；外部调用方的、渠道自己的、没发出去的不算；改道发出的算一次；时间段外的不算', async (t) => {
    const h = await rejectHarness(t)
    await h.bothSaid()
    const { runtime } = h.harness
    const sends = () => runtime.sentBetween(SESSION_ID)
    assert.deepEqual(sends(), [])

    await runtime.push({ sessionId: SESSION_ID, text: '会话自己发的', by: { kind: 'session', sessionId: SESSION_ID, role: 'hub' } })
    await runtime.push({ sessionId: SESSION_ID, text: '外部调用方发的', by: { kind: 'external', name: 'cli' } })
    assert.deepEqual(sends().map(item => item.text), ['会话自己发的'])

    h.script('fail')
    await runtime.push({ sessionId: SESSION_ID, text: '改道发出的' })
    assert.deepEqual(sends().map(item => item.text), ['会话自己发的', '改道发出的'], '原来那片算发出了，改道那条不重复')

    const row = [...h.harness.tables.maps.outgoing.values()].find(item => item.push === true && item.text === '会话自己发的')
    assert.equal(sends()[0].at, row.endSeq)
    assert.deepEqual(runtime.sentBetween(SESSION_ID, row.endSeq + 1).map(item => item.text).includes('会话自己发的'), false)
    assert.deepEqual(runtime.sentBetween(SESSION_ID, 0, row.endSeq - 1), [])
    assert.deepEqual(runtime.sentBetween('session-other'), [], '别的会话的不算')

    h.harness.tables.maps.outgoing.set('channel-note', { ...row, text: '渠道自己的说明', endSeq: row.endSeq + 5, system: 'stall', partIndex: 0 })
    h.harness.tables.maps.outgoing.set('never-sent', { ...row, text: '没发出去的', endSeq: row.endSeq + 6, state: 'failed', errorCode: 'NOT_SENT', partIndex: 0 })
    h.harness.tables.maps.outgoing.set('picture', { ...row, kind: 'image', text: 'D:/x.png', endSeq: row.endSeq + 7, partIndex: 0 })
    h.harness.tables.maps.outgoing.set('half-1', { ...row, text: '发出的一半', endSeq: row.endSeq + 8, partIndex: 0, partCount: 2 })
    h.harness.tables.maps.outgoing.set('half-2', { ...row, text: '没发出的一半', endSeq: row.endSeq + 8, partIndex: 1, partCount: 2, state: 'failed', errorCode: 'NOT_SENT' })
    const texts = sends().map(item => item.text)
    assert.ok(!texts.includes('渠道自己的说明') && !texts.includes('没发出去的'))
    assert.ok(texts.includes('[图片]'))
    assert.ok(texts.includes('发出的一半\n（这次发送有一部分没发出去）'))
})

test('微信一条消息最多回 10 片：中途发送数着次数、给最终回复留一次；用完不再调平台；对方再说一句就重新算', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' }),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.weixin.state)
    const say = messageId => options.onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId, text: `说一句 ${messageId}` },
        anchorOf(messageId, { contextToken: `ct-${messageId}` }),
    )
    await say('m-1')
    await settle(harness.runtime)
    for (let index = 0; index < 9; index += 1) {
        const sent = await harness.runtime.push({ sessionId: SESSION_ID, text: `第 ${index + 1} 句` })
        assert.equal(sent.sent, 1, `第 ${index + 1} 句：${JSON.stringify(sent)}`)
        assert.equal(sent.repliesLeft, 10 - index - 1)
    }
    const calls = harness.weixin.state.sends.length
    assert.deepEqual(await harness.runtime.push({ sessionId: SESSION_ID, text: '第 10 句' }), { status: 'unavailable', reason: 'NO_REPLIES_LEFT', repliesLeft: 1 }, '留一次给最终回复')
    assert.equal(harness.weixin.state.sends.length, calls, '没有调平台去碰拒收')

    await say('m-2')
    await settle(harness.runtime)
    const again = await harness.runtime.push({ sessionId: SESSION_ID, text: '接着说' })
    assert.equal(again.sent, 1)
    assert.equal(again.repliesLeft, 9, '新消息重新算 10 次')
})

test('微信：一轮回复超过这条消息还剩的次数：发前几片，写明还有多少、什么时候接着发；对方下一条消息回完后接着发', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' }),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.weixin.state)
    await options.onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'm-long', text: '讲长一点' },
        anchorOf('m-long', { contextToken: 'ct-long' }),
    )
    await settle(harness.runtime)
    for (let index = 0; index < 8; index += 1) await harness.runtime.push({ sessionId: SESSION_ID, text: `先说第 ${index + 1} 句` })
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-long' }], assistants: [{ text: Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 段：${'字'.repeat(500)}`).join('\n\n') }] })
    await settle(harness.runtime)
    const sends = harness.weixin.state.sends
    assert.equal(sends.length, 10, '正好用完 10 次，第 11 次不调平台')
    const last = JSON.stringify(sends.at(-1))
    assert.match(last, /微信 每条消息只能回 10 次/)
    assert.match(last, /下一条消息/)
    const deferred = outgoingRows(harness).filter(row => row.deferred === true && row.state === 'prepared')
    assert.ok(deferred.length > 0, '其余留着')
    await options.onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId: 'm-next', text: '继续' },
        anchorOf('m-next', { contextToken: 'ct-next' }),
    )
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-next' }], assistants: [{ text: '好' }] })
    await settle(harness.runtime)
    assert.ok(sends.length > 11, `回完下一条接着发：${sends.length}`)
    assert.equal(outgoingRows(harness).filter(row => row.deferred === true && row.state === 'prepared').length, 0)
})

test('微信比 10 次更早拒收：不靠计数，拒收本身算这条消息回不了了；不再碰平台，留到下一条消息之后；报一次，带平台的原话', async (t) => {
    const reports = []
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' }),
        runtime: { report: (kind, detail) => reports.push({ kind, ...detail }) },
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.weixin.state)
    const say = messageId => options.onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId, text: `说一句 ${messageId}` },
        anchorOf(messageId, { contextToken: `ct-${messageId}` }),
    )
    await say('m-1')
    await settle(harness.runtime)
    assert.equal((await harness.runtime.push({ sessionId: SESSION_ID, text: '第一句' })).sent, 1)
    const accept = harness.weixin.state.sendImpl
    harness.weixin.state.sendImpl = async () => {
        throw Object.assign(new Error('weixin sendmessage rejected (-2)'), { code: 'SEND_REJECTED', definitelyRejected: true })
    }
    const rejected = await harness.runtime.push({ sessionId: SESSION_ID, text: '第二句' })
    assert.equal(rejected.sent, 0)
    assert.equal(rejected.unsent, 1, '留着，不算没送达')
    assert.equal(rejected.failed, 0)
    harness.weixin.state.sendImpl = accept
    const ended = reports.filter(item => item.kind === 'channels/replies-ended')
    assert.equal(ended.length, 1)
    assert.match(ended[0].text, /weixin sendmessage rejected \(-2\)/)
    assert.match(ended[0].text, /已送达 1 片/)
    const calls = harness.weixin.state.sends.length
    assert.deepEqual(await harness.runtime.push({ sessionId: SESSION_ID, text: '第三句' }), { status: 'unavailable', reason: 'NO_REPLIES_LEFT', repliesLeft: 0 }, '才发了一片也算用完')
    assert.equal(harness.weixin.state.sends.length, calls, '不再碰平台')

    await say('m-2')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-2' }], assistants: [{ text: '回这一条' }] })
    await settle(harness.runtime)
    const texts = harness.weixin.state.sends.map(item => item.text)
    assert.ok(texts.includes('回这一条'))
    assert.ok(texts.includes('第二句'), '留着的那片接着发')
    assert.equal(outgoingRows(harness).filter(row => row.state === 'failed' && row.reroutedTo === undefined).length, 0, '不算未送达')
})

test('微信：补发留待片时又被拒：不丢，回去接着等；下一条消息回完接着发，不重复', async (t) => {
    const harness = await createHarness({
        seed: async ({ tables, credentials }) => seedBinding(tables, credentials, { platform: 'weixin', accountId: 'account-wx', senderId: 'owner-wx' }),
    })
    t.after(async () => {
        await harness.runtime.close()
    })
    await settle(harness.runtime)
    const options = listenOptions(harness.weixin.state)
    const say = messageId => options.onMessage(
        { kind: 'private', platform: 'weixin', accountId: 'account-wx', conversationId: 'owner-wx', senderId: 'owner-wx', messageId, text: `说一句 ${messageId}` },
        anchorOf(messageId, { contextToken: `ct-${messageId}` }),
    )
    const accept = harness.weixin.state.sendImpl
    const REJECT = async () => {
        throw Object.assign(new Error('weixin sendmessage rejected (-2)'), { code: 'SEND_REJECTED', definitelyRejected: true })
    }
    await say('m-1')
    await settle(harness.runtime)
    harness.weixin.state.sendImpl = REJECT
    await harness.runtime.push({ sessionId: SESSION_ID, text: '留着的话' })
    const waiting = () => outgoingRows(harness).filter(row => row.deferred === true && row.state === 'prepared')
    assert.equal(waiting().length, 1)

    // 下一条消息：回复发出了，补发那一片又被拒。
    await say('m-2')
    await settle(harness.runtime)
    let calls = 0
    harness.weixin.state.sendImpl = async (request) => {
        calls += 1
        return calls === 1 ? accept(request) : REJECT()
    }
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-2' }], assistants: [{ text: '回第二条' }] })
    await settle(harness.runtime)
    assert.equal(waiting().length, 1, '又被拒也不丢')
    assert.equal(outgoingRows(harness).filter(row => row.state === 'failed' && row.reroutedTo === undefined).length, 0)

    harness.weixin.state.sendImpl = accept
    await say('m-3')
    await settle(harness.runtime)
    harness.chat.addTurn({ inputs: [{ rpcId: 'req-m-3' }], assistants: [{ text: '回第三条' }] })
    await settle(harness.runtime)
    assert.equal(waiting().length, 0)
    assert.equal(harness.weixin.state.sends.filter(item => item.text === '留着的话' && item.anchor.contextToken === 'ct-m-3').length, 1, '发出一次')
})
