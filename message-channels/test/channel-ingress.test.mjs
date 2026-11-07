/**
 * channel-ingress 定向单元测试（development_fake）。
 *
 * 用 development_fake 的 sessionController/sessionQuery/sessions 跑真实
 * createMainTextIngress；不联网、不建 Agent、不写盘。覆盖：
 * 身份先于 Host 调用、观察核实真实会话（子 agent 与异 id 拒绝）、rpcId 真实原件核对、同消息串行、live exact
 * flush、冷 revision、unknown、INPUT_CONFLICT、close/drain 与零 create。
 *
 * 这些用例只证明模块语义；真实平台往返与完整 profile 装配另行验收。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { IngressError, createMainTextIngress } from '../channel-ingress.js'

const SESSION_ID = 'session-1'

const BINDING = Object.freeze({
    platform: 'qq',
    accountId: 'account-1',
    conversationId: 'owner-1',
    senderId: 'owner-1',
    sessionId: SESSION_ID,
})

const flush = () => new Promise(resolve => setImmediate(resolve))

function codeOf(error) {
    assert.ok(error instanceof IngressError, `期望 IngressError，收到 ${String(error)}`)
    return error.code
}

function message(overrides = {}) {
    return {
        kind: 'private',
        platform: 'qq',
        accountId: 'account-1',
        conversationId: 'owner-1',
        senderId: 'owner-1',
        messageId: 'm-1',
        text: '你好',
        origin: { speaker: { kind: 'user' }, via: { exit: 'qq', label: 'QQ 私聊' } },
        ...overrides,
    }
}

/** 真实 producer 形状的 Inbox 原件事件。 */
function splicedEvent(requestId, text, options = {}) {
    return {
        type: 'agent/inbox/spliced',
        seq: options.seq ?? 7,
        data: {
            inserted: [{
                id: options.id ?? 'native-1',
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'user', rpcId: requestId },
            }],
        },
    }
}

/**
 * development_fake Host：只提供 ingress 借用并核对的公开服务，并记录每次调用。
 * create 一旦被调用即计数并失败：准入永远不得创建会话。
 */
function createWorld(options = {}) {
    const state = {
        prompts: [],
        observes: [],
        flushes: 0,
        createCalls: 0,
        disposes: 0,
        /** 当前尚未释放的观察租约数：每次真实观察取得一个，按实际数量核对全释放。 */
        leases: 0,
        /** 本次观察返回的真实事件快照来源。 */
        events: [],
        header: options.header ?? { id: SESSION_ID },
        source: options.source ?? 'live',
        revision: options.revision ?? 'rev-1',
        /** live 持久屏障借用服务里的 exact 实例。 */
        instance: null,
        promptImpl: async () => ({ accepted: true }),
        flushImpl: async () => true,
        /** 向框架核心声明过的出处（按先后），和 prompt 交错记在 calls 里。 */
        declared: [],
        calls: [],
    }
    const host = {
        core: {
            provenance: {
                declare(requestId, declaration) {
                    state.declared.push({ requestId, declaration })
                    state.calls.push('declare')
                },
            },
        },
        sessionController: {
            async prompt(request, signal) {
                state.prompts.push({ request, signal })
                state.calls.push('prompt')
                return state.promptImpl(request, signal)
            },
            async create() {
                state.createCalls += 1
                throw new Error('准入不得创建会话')
            },
        },
        sessionQuery: {
            async observeSession(sessionId, observeOptions) {
                state.observes.push({ sessionId, observeOptions })
                if (options.observeError !== undefined) throw options.observeError
                const events = state.events.slice()
                state.leases += 1
                return {
                    source: state.source,
                    revision: state.revision,
                    header: state.header,
                    events,
                    [Symbol.dispose]: () => {
                        state.leases -= 1
                        state.disposes += 1
                    },
                }
            },
        },
        sessions: {
            get() {
                return state.instance
            },
            async flush(instance) {
                state.flushes += 1
                return state.flushImpl(instance)
            },
        },
    }
    return { host, state }
}

/** 已配对通道的 ingress；live 会话实例与观察 header 是同一引用。 */
function createIngress(world) {
    world.state.instance = { header: world.state.header }
    return createMainTextIngress(world.host, BINDING)
}

/**
 * 在 prompt 时写入真实 producer 原件，模拟 controller 已保存输入后的官方事件。
 * @returns 真实准入结果与 world。
 */
async function admitWithEvidence(options = {}, text = '你好') {
    let world
    world = createWorld(options)
    world.state.promptImpl = async request => {
        world.state.events.push(splicedEvent(request.requestId, text, { id: 'native-1', seq: 5 }))
        return { accepted: true }
    }
    const ingress = createIngress(world)
    const result = await ingress.admit(message({ text }))
    await ingress.close()
    return { world, result }
}

test('装配校验：缺依赖或非法绑定在构造期失败，不做任何调用', () => {
    const { host } = createWorld()
    assert.throws(() => createMainTextIngress({}, BINDING), error => codeOf(error) === 'INVALID_CONTEXT')
    assert.throws(
        () => createMainTextIngress({ ...host, sessionQuery: {} }, BINDING),
        error => codeOf(error) === 'INVALID_CONTEXT',
    )
    for (const field of ['platform', 'accountId', 'conversationId', 'senderId', 'sessionId']) {
        const binding = { ...BINDING, [field]: ' ' }
        assert.throws(() => createMainTextIngress(host, binding), error => codeOf(error) === 'INVALID_BINDING', field)
    }
    assert.throws(
        () => createMainTextIngress(host, { ...BINDING, platform: 'Fei Shu' }),
        error => codeOf(error) === 'INVALID_BINDING',
    )
})

test('装配校验：内置的平台和登记进来的平台都能建准入 helper（平台名合规就行，装没装着由运行态管）', async () => {
    const { host } = createWorld()
    for (const platform of ['qq', 'weixin', 'chat']) {
        const ingress = createMainTextIngress(host, { ...BINDING, platform })
        assert.equal(typeof ingress.admit, 'function', platform)
        await ingress.close()
    }
})

test('身份与正文校验先于任何 Host 调用', async () => {
    const world = createWorld()
    const ingress = createIngress(world)
    const cases = [
        ['非私聊', { ...message(), kind: 'group' }],
        ['他人发送者', { ...message(), senderId: 'someone-else' }],
        ['其他会话', { ...message(), conversationId: 'other-peer' }],
        ['携带 sessionId', { ...message(), sessionId: 'session-x' }],
        ['携带 requestId', { ...message(), requestId: 'req-x' }],
        ['空正文', { ...message(), text: '   ' }],
        ['数字消息 id', { ...message(), messageId: 42 }],
    ]
    for (const [label, payload] of cases) {
        await assert.rejects(ingress.admit(payload), error => codeOf(error) === 'INVALID_MESSAGE', label)
    }
    assert.equal(world.state.observes.length, 0)
    assert.equal(world.state.prompts.length, 0)
    await ingress.close()
})

test('观察核实目标会话：子 agent 与异 id 会话都在 prompt 前拒绝并释放租约', async () => {
    const cases = [
        ['子 agent origin', { id: SESSION_ID, origin: 'subagent' }],
        ['异 id', { id: 'session-other' }],
    ]
    for (const [label, header] of cases) {
        const world = createWorld({ header })
        const ingress = createIngress(world)
        await assert.rejects(ingress.admit(message()), error => codeOf(error) === 'SESSION_UNAVAILABLE', label)
        assert.equal(world.state.prompts.length, 0, `${label}：不得 prompt`)
        assert.equal(world.state.disposes, 1, `${label}：观察租约已释放`)
        assert.equal(world.state.createCalls, 0, `${label}：零 create`)
        await ingress.close()
    }
})

test('普通 fork：parentSession 存在但 origin 不是 subagent 时仍可作为本人会话准入', async () => {
    const { world, result } = await admitWithEvidence({ header: { id: SESSION_ID, parentSession: 'session-parent' } })
    assert.equal(result.status, 'accepted', '普通 fork 仍是本人普通会话')
    assert.equal(result.sessionId, SESSION_ID)
    assert.equal(result.messageId, 'native-1')
    assert.equal(world.state.prompts.length, 1, '普通 fork 会话必须能准入')
    // 合法流程真实取得多个观察租约：按实际取得数量核对全部释放，不固定镜像实现内部次数。
    assert.ok(world.state.observes.length >= 1, '准入真实观察过目标会话')
    assert.equal(world.state.disposes, world.state.observes.length, '每次观察的租约都已释放')
    assert.equal(world.state.leases, 0, '没有遗留的观察租约')
    assert.equal(world.state.createCalls, 0, '零 create')
})

test('无法观察目标时明确失败，绝不盲读准入', async () => {
    const world = createWorld({ observeError: new Error('no observation lease') })
    const ingress = createIngress(world)
    await assert.rejects(ingress.admit(message()), error => codeOf(error) === 'OBSERVATION_UNAVAILABLE')
    assert.equal(world.state.prompts.length, 0)
    await ingress.close()
})

test('新消息：prompt 一次，返回真实 producer 的 message.id 与 seq', async () => {
    let world
    world = createWorld()
    world.state.promptImpl = async request => {
        world.state.events.push(splicedEvent(request.requestId, '你好', { id: 'native-9', seq: 11 }))
        return { accepted: true }
    }
    const ingress = createIngress(world)
    const result = await ingress.admit(message())
    assert.equal(world.state.prompts.length, 1)
    const { request } = world.state.prompts[0]
    // 固定 prompt 形状：会话由绑定固定，正文是单一 text part。
    assert.equal(request.sessionId, SESSION_ID)
    assert.equal(request.mode, 'queue')
    assert.deepEqual(request.content, [{ type: 'text', text: '你好' }])
    assert.equal(world.state.observes[0].sessionId, SESSION_ID)
    assert.equal(world.state.observes[0].observeOptions.projectionMode, 'none')
    assert.equal(result.status, 'accepted')
    assert.equal(result.sessionId, SESSION_ID)
    assert.equal(result.requestId, request.requestId)
    assert.equal(result.messageId, 'native-9')
    assert.equal(result.seq, 11)
    assert.equal(world.state.createCalls, 0, '准入不得创建会话')
    await ingress.close()
})

test('图片消息：图片随正文作为 image part 投递，原件按正文与图片张数核对', async () => {
    const world = createWorld()
    world.state.promptImpl = async request => {
        // controller 把 image part 存成附件引用：原件里是 image 块而不是 base64。
        const content = request.content.map(part => (part.type === 'image'
            ? { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: part.mediaType } }
            : part))
        world.state.events.push({
            type: 'agent/inbox/spliced',
            seq: 9,
            data: { inserted: [{ id: 'native-img', role: 'user', content, source: { kind: 'user', rpcId: request.requestId } }] },
        })
        return { accepted: true }
    }
    const ingress = createIngress(world)
    const images = [{ mediaType: 'image/png', data: 'AAAA' }]
    const onlyImage = await ingress.admit(message({ messageId: 'm-img', text: '', images }))
    const withText = await ingress.admit(message({ messageId: 'm-img-2', text: '看图', images }))
    assert.deepEqual(world.state.prompts[0].request.content, [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }])
    assert.deepEqual(world.state.prompts[1].request.content, [
        { type: 'text', text: '看图' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    ])
    assert.equal(onlyImage.status, 'accepted')
    assert.equal(withText.status, 'accepted')
    await ingress.close()
})

test('图片消息：原件图片张数不同 → INPUT_CONFLICT；空正文且无图片在 Host 调用前拒绝', async () => {
    const world = createWorld()
    const ingress = createIngress(world)
    await assert.rejects(ingress.admit(message({ messageId: 'm-empty', text: '' })), error => codeOf(error) === 'INVALID_MESSAGE')
    await assert.rejects(
        ingress.admit(message({ messageId: 'm-bad', text: 'x', images: [{ mediaType: 'image/bmp', data: 'AA' }] })),
        error => codeOf(error) === 'INVALID_MESSAGE',
    )
    await ingress.close()

    const other = createWorld()
    other.state.promptImpl = async request => {
        other.state.events.push(splicedEvent(request.requestId, '看图', { id: 'native-x', seq: 3 }))
        return { accepted: true }
    }
    const second = createIngress(other)
    await assert.rejects(
        second.admit(message({ messageId: 'm-mismatch', text: '看图', images: [{ mediaType: 'image/png', data: 'AAAA' }] })),
        error => codeOf(error) === 'INPUT_CONFLICT',
    )
    await second.close()
})

test('已有真实原件：重放不重复 prompt，回报同一 message.id/seq', async () => {
    const { world, result } = await admitWithEvidence()
    assert.equal(result.status, 'accepted')
    assert.equal(result.messageId, 'native-1')
    assert.equal(result.seq, 5)

    const second = createIngress(world)
    const replay = await second.admit(message())
    assert.equal(world.state.prompts.length, 1, '原件已在：不得再 prompt')
    assert.equal(replay.status, 'accepted')
    assert.equal(replay.requestId, result.requestId, '同一平台消息身份的 requestId 稳定')
    assert.equal(replay.messageId, 'native-1')
    assert.equal(replay.seq, 5)
    await second.close()
})

test('渠道代为放进来的（relayed）请求号换前缀，进了日志也和用户本人的话分得开；relayed 只能是布尔值', async () => {
    const world = createWorld()
    world.state.promptImpl = async request => {
        world.state.events.push(splicedEvent(request.requestId, '你好', { id: `native-${world.state.prompts.length}`, seq: world.state.prompts.length + 1 }))
        return { accepted: true }
    }
    const ingress = createIngress(world)
    for (const [messageId, relayed] of [['m-own', undefined], ['relay:task-1-r1', true], ['m-own-2', false]]) {
        await ingress.admit(message({ messageId, ...relayed === undefined ? {} : { relayed } }))
    }
    assert.deepEqual(world.state.prompts.map(prompt => prompt.request.requestId.replace(/[0-9a-f]{64}$/, '')),
        ['channel-ingress:1:', 'channel-relay:1:', 'channel-ingress:1:'])
    await assert.rejects(ingress.admit(message({ messageId: 'm-x', relayed: 'yes' })), /relayed 只能是布尔值/)
})

test('同一消息并发只准入一次：按 requestId 串行，正文不进入请求身份', async () => {
    let release
    const held = new Promise(resolve => {
        release = resolve
    })
    const world = createWorld()
    world.state.promptImpl = async request => {
        world.state.events.push(splicedEvent(request.requestId, '你好', { id: 'native-5', seq: 6 }))
        await held
        return { accepted: true }
    }
    const ingress = createIngress(world)
    const first = ingress.admit(message({ messageId: 'm-concurrent' }))
    const second = ingress.admit(message({ messageId: 'm-concurrent' }))
    await flush()
    assert.equal(world.state.prompts.length, 1, '同一消息串行，只真正准入一次')
    const requestId = world.state.prompts[0].request.requestId
    assert.ok(requestId.startsWith('channel-ingress:1:'))
    assert.equal(requestId.includes('你好'), false, '正文不进入 requestId')
    assert.equal(requestId.includes('owner-1'), false, '本人标识不进入 requestId')
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.status, 'accepted')
    assert.equal(a.messageId, 'native-5')
    assert.equal(b.status, 'accepted', '第二次在真实原件之后只核对，不再 prompt')
    assert.equal(world.state.prompts.length, 1)
    await ingress.close()
})

test('同一消息的原生原件正文不同 → INPUT_CONFLICT，不 prompt 也不报成功', async () => {
    const { world } = await admitWithEvidence({}, 'A')
    const ingress = createIngress(world)
    await assert.rejects(
        ingress.admit(message({ text: 'B' })),
        error => codeOf(error) === 'INPUT_CONFLICT',
    )
    assert.equal(world.state.prompts.length, 1, '冲突不得重发')
    await ingress.close()
})

test('其他 requestId 的原件不算证据，结果是 unknown 且不重发', async () => {
    let world
    world = createWorld()
    world.state.promptImpl = async () => {
        world.state.events.push(splicedEvent('channel-ingress:1:other', '你好', { id: 'native-x', seq: 3 }))
        return { accepted: true }
    }
    const ingress = createIngress(world)
    const result = await ingress.admit(message())
    assert.equal(result.status, 'unknown')
    assert.equal(world.state.prompts.length, 1)
    await ingress.close()
})

test('live 观察必须对 exact 实例 flush：失败或实例被换都只报 unknown', async () => {
    // flush 返回 false：无法确认持久。
    let world
    world = createWorld()
    world.state.promptImpl = async request => {
        world.state.events.push(splicedEvent(request.requestId, '你好', { id: 'native-1', seq: 4 }))
        return { accepted: true }
    }
    world.state.flushImpl = async () => false
    let ingress = createIngress(world)
    let result = await ingress.admit(message())
    assert.equal(result.status, 'unknown')
    assert.equal(world.state.flushes, 1, 'live 观察要 flush 一次')
    await ingress.close()

    // flush 之后实例被替换：不是同一个 exact 会话实例，仍然 unknown。
    world = createWorld()
    world.state.promptImpl = async request => {
        world.state.events.push(splicedEvent(request.requestId, '你好', { id: 'native-1', seq: 4 }))
        return { accepted: true }
    }
    world.state.flushImpl = async () => {
        world.state.instance = { header: world.state.header }
        return true
    }
    ingress = createIngress(world)
    result = await ingress.admit(message())
    assert.equal(result.status, 'unknown')
    await ingress.close()

    // 借用服务里的实例 header 不是本观察的 header：flush 前就拒绝确认。
    world = createWorld()
    world.state.promptImpl = async request => {
        world.state.events.push(splicedEvent(request.requestId, '你好', { id: 'native-1', seq: 4 }))
        return { accepted: true }
    }
    world.state.flushImpl = async () => true
    ingress = createMainTextIngress(world.host, BINDING)
    world.state.instance = { header: { id: SESSION_ID } }
    result = await ingress.admit(message())
    assert.equal(result.status, 'unknown')
    assert.equal(world.state.flushes, 0, '实例不符时不得用别的实例 flush')
    await ingress.close()
})

test('冷观察：非空 revision 才确认持久，空 revision 报 unknown 且不 flush', async () => {
    const cases = [
        ['有 revision', 'rev-9', 'accepted'],
        ['空 revision', '', 'unknown'],
    ]
    for (const [label, revision, expected] of cases) {
        const { world, result } = await admitWithEvidence({ source: 'prepared', revision })
        assert.equal(result.status, expected, label)
        assert.equal(world.state.flushes, 0, `${label}：冷观察不 flush`)
    }
})

test('原件存在但没有可核对的原生引用：unknown，不重发', async () => {
    let world
    world = createWorld()
    world.state.promptImpl = async request => {
        // 形状不完整：没有 message.id。
        world.state.events.push({
            type: 'agent/inbox/spliced',
            seq: 2,
            data: { inserted: [{ role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: request.requestId } }] },
        })
        return { accepted: true }
    }
    const ingress = createIngress(world)
    const result = await ingress.admit(message())
    assert.equal(result.status, 'unknown')
    assert.equal(world.state.prompts.length, 1)
    await ingress.close()
})

test('prompt 失败：有真实原件报 accepted，无原件报 unknown，都不重发', async () => {
    let world
    world = createWorld()
    world.state.promptImpl = async request => {
        world.state.events.push(splicedEvent(request.requestId, '你好', { id: 'native-1', seq: 4 }))
        throw new Error('controller 失败')
    }
    let ingress = createIngress(world)
    let result = await ingress.admit(message())
    assert.equal(result.status, 'accepted', '失败但真实证据已持久：报 accepted')
    assert.equal(world.state.prompts.length, 1)
    await ingress.close()

    world = createWorld()
    world.state.promptImpl = async () => {
        throw new Error('controller 失败')
    }
    ingress = createIngress(world)
    result = await ingress.admit(message())
    assert.equal(result.status, 'unknown', '失败且无证据：只报 unknown')
    assert.equal(world.state.prompts.length, 1, 'unknown 不得自动重发')
    await ingress.close()
})

test('close：在途准入被拒绝并排空，关闭后新准入直接失败且幂等', async () => {
    const world = createWorld()
    world.state.promptImpl = (request, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
        }, { once: true })
    })
    const ingress = createIngress(world)
    const pending = ingress.admit(message())
    await flush()
    assert.equal(world.state.prompts.length, 1)
    await ingress.close()
    await assert.rejects(pending, error => codeOf(error) === 'INGRESS_CLOSED')
    await ingress.close()
    await assert.rejects(ingress.admit(message()), error => codeOf(error) === 'INGRESS_CLOSED')
    assert.equal(world.state.prompts.length, 1, '关闭后不得再 prompt')
    assert.equal(world.state.createCalls, 0)
})

test('close 落在观察期间：关闭发起后不 prompt，晚返回的租约仍被释放', async () => {
    const world = createWorld()
    let releaseObserve
    const held = new Promise(resolve => {
        releaseObserve = resolve
    })
    // 真实查询不可取消：租约在拿到结果后才释放，关闭只能等它返回，不能反过来等关闭。
    world.host.sessionQuery.observeSession = async () => {
        world.state.leases += 1
        await held
        return {
            source: 'live',
            revision: 'rev-1',
            header: world.state.header,
            events: [],
            [Symbol.dispose]: () => {
                world.state.leases -= 1
                world.state.disposes += 1
            },
        }
    }
    const ingress = createIngress(world)
    const pending = ingress.admit(message())
    // 关闭会拒绝在途准入：断言先挂上，避免排空期间出现未处理的拒绝。
    const rejected = assert.rejects(pending, error => codeOf(error) === 'INGRESS_CLOSED')
    await flush()
    assert.ok(world.state.leases >= 1, '准入已取得观察租约')
    // 先发起关闭但不等待（观察还没返回），再放行查询，最后才等关闭排空完成。
    const closing = ingress.close()
    await flush()
    assert.equal(world.state.prompts.length, 0, '关闭发起后不得再 prompt')
    assert.equal(world.state.createCalls, 0, '准入零 create')
    releaseObserve()
    await closing
    await rejected
    assert.equal(world.state.prompts.length, 0, '晚返回的观察不得触发 prompt')
    assert.equal(world.state.leases, 0, '没有遗留的观察租约')
    assert.ok(world.state.disposes >= 1, '晚返回的观察租约被释放')
})

test('谁说的由入口在 prompt 之前向框架核心声明：请求号就是 prompt 的请求号，出处原样交出；没写出处的消息在 Host 调用前拒绝', async () => {
    // 只看声明和 prompt 的先后与内容，不管准入的结论（没有原件，结论是 unknown）。
    const world = createWorld()
    const ingress = createIngress(world)
    await ingress.admit(message({ origin: { speaker: { kind: 'user' }, via: { exit: 'qq', label: '群「项目-小说」' } } }))
    assert.deepEqual(world.state.calls, ['declare', 'prompt'], '先声明，再 prompt')
    assert.equal(world.state.declared[0].requestId, world.state.prompts[0].request.requestId)
    assert.deepEqual(world.state.declared[0].declaration, { speaker: { kind: 'user' }, via: { exit: 'qq', label: '群「项目-小说」' } })
    const bare = createIngress(createWorld())
    const { origin: _origin, ...withoutOrigin } = message()
    await assert.rejects(bare.admit(withoutOrigin), error => codeOf(error) === 'INVALID_MESSAGE')
})
