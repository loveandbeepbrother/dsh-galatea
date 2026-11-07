/**
 * 核心：执行方登记与额度状态。会话的模型选择来自上游真实的 Agent。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ROUTE, SessionId, createUserMessage, makeHarness, waitFor } from './harness.mjs'

const ALL_REQUIRED = { runTurn: true, openingSegments: true, perTurnContext: true, toolEndpoint: true, interrupt: true, usage: () => null, newConversation: () => ({ scheduled: false, reason: 'test' }) }

test('缺必备能力的执行方不能注册；可选能力没有的每项报一条降级说明，只在缺失集合变化时报', async (t) => {
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    assert.throws(() => h.ctx.core.executors.register({ id: 'half', handles: () => false, required: { runTurn: true } }), /缺必备能力：openingSegments/)
    assert.throws(() => h.ctx.core.executors.register({ id: 'odd', handles: () => false, required: ALL_REQUIRED, optional: { teleport: true } }), /没有的可选能力：teleport/)
    const off = h.ctx.core.executors.register({ id: 'cc', handles: () => false, required: ALL_REQUIRED, optional: { resume: true, compact: () => ({ compacted: true }), steer: true } })
    const ofCc = () => reports.filter(entry => entry.kind === 'core/executor-capability-missing' && entry.data.executor === 'cc')
    await waitFor(() => ofCc().length > 0, '缺失能力报出来')
    const missing = ofCc().map(entry => entry.data.capability)
    assert.ok(missing.includes('endCheck') && missing.includes('quotaGate'))
    assert.ok(!missing.includes('resume'))
    assert.ok(ofCc().every(entry => entry.data.subject === `cc/${entry.data.capability}`), '每项一条，subject 是执行方/能力名')
    assert.throws(() => h.ctx.core.executors.register({ id: 'cc', handles: () => false, required: ALL_REQUIRED }), /已经登记过/)
    assert.deepEqual(h.ctx.core.executors.list().map(entry => entry.id), ['cc', 'native'])
    assert.ok(!reports.some(entry => entry.kind === 'core/executor-capability-missing' && entry.data.executor === 'native'), '原生不在登记时报')

    // 重启（撤销后用同样的能力重新登记）：缺失集合没变，不再重报。
    const before = ofCc().length
    off()
    const again = h.ctx.core.executors.register({ id: 'cc', handles: () => false, required: ALL_REQUIRED, optional: { resume: true, compact: () => ({ compacted: true }), steer: true } })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(ofCc().length, before, '集合没变就不报')
    // 有了 endCheck：只为它报一条 resolved，别的不重报。
    again()
    h.ctx.core.executors.register({ id: 'cc', handles: () => false, required: ALL_REQUIRED, optional: { resume: true, compact: () => ({ compacted: true }), steer: true, endCheck: true } })
    await waitFor(() => ofCc().length > before, '有了的那一项报 resolved')
    assert.deepEqual(ofCc().slice(before).map(entry => [entry.data.capability, entry.data.resolved]), [['endCheck', true]])
})

test('会话按模型选择归执行方：别的执行方先问，都不接的归原生；额度状态按执行方作答，没有闸门的是 unknown', async (t) => {
    const h = await makeHarness(t)
    await h.createSession('main')
    assert.equal((await h.ctx.core.executors.executorOf('main')).id, 'native')
    assert.equal(await h.ctx.core.quota.state('main'), 'unknown', '原生没有额度闸门')
    assert.deepEqual(await h.ctx.core.quota.detail('main'), { state: 'unknown', since: null, resetsAt: null, window: null, outageId: null, windows: null })

    let gate = 'limited'
    const probe = await h.pluginContext('probe-executor')
    probe.core.executors.register({
        id: 'agent-sdk',
        handles: selection => selection.provider === ROUTE.provider,
        required: ALL_REQUIRED,
        optional: { quotaGate: { state: () => gate } },
    })
    assert.equal((await h.ctx.core.executors.executorOf('main')).id, 'agent-sdk', '按会话的模型选择')
    assert.equal(await h.ctx.core.executors.has('main', 'quotaGate'), true)
    assert.equal(await h.ctx.core.quota.state('main'), 'limited')
    gate = 'nonsense'
    assert.equal(await h.ctx.core.quota.state('main'), 'unknown', '答不出合法的值按 unknown')
    assert.equal((await h.ctx.core.quota.detail('main')).state, 'unknown', '没有 detail 的闸门：状态照 state()')
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    assert.equal(await h.ctx.core.executors.executorOf('never-existed'), undefined, '读不出模型选择的不归原生')
    assert.ok(reports.some(entry => entry.kind === 'core/executor-unknown'))
    assert.equal(await h.ctx.core.quota.state('never-existed'), 'unknown')

    await probe.fiber.dispose()
    assert.equal((await h.ctx.core.executors.executorOf('main')).id, 'native', '登记它的插件卸下，执行方跟着撤')
})

test('会话没加载时也按它持久的模型选择归属：Claude Code 会话卸下以后，问到的还是 Claude Code 的额度', async (t) => {
    const h = await makeHarness(t, { controller: true })
    await h.createSession('cold', { release: true })
    const probe = await h.pluginContext('probe-executor-cold')
    probe.core.executors.register({
        id: 'agent-sdk',
        handles: selection => selection.provider === ROUTE.provider,
        required: ALL_REQUIRED,
        optional: { quotaGate: { state: () => 'limited' } },
    })
    assert.equal(h.ctx.agents.get(SessionId('cold')), undefined, '会话不在内存里')
    assert.equal((await h.ctx.core.executors.executorOf('cold')).id, 'agent-sdk', '没记过选择的跟着默认模型走')
    assert.equal(await h.ctx.core.quota.state('cold'), 'limited', '不会因为没加载就问到原生、答 unknown')
})

test('能力的值就是实现：必备的换新对话、用量要是函数；可选能力按各自的样子；原生的由 provideNative 补上', async (t) => {
    const h = await makeHarness(t)
    await h.createSession('main')
    const probe = await h.pluginContext('probe-caps')
    assert.throws(() => probe.core.executors.register({ id: 'x', handles: () => false, required: { ...ALL_REQUIRED, usage: true } }), /缺必备能力：usage/)
    assert.throws(() => probe.core.executors.register({ id: 'y', handles: () => false, required: ALL_REQUIRED, optional: { compact: true } }), /可选能力写得不对：compact/)
    assert.throws(() => probe.core.executors.register({ id: 'z', handles: () => false, required: ALL_REQUIRED, optional: { fallbackThreshold: true } }), /fallbackThreshold/)
    // 原生：没装压缩引擎时换新对话写明做不了、没有主动压缩；补上以后就有了。
    const native = await h.ctx.core.executors.executorOf('main')
    assert.equal(native.id, 'native')
    assert.match(native.required.newConversation('main', 'D:/x.md').reason, /没有装框架的压缩引擎/)
    assert.equal(await h.ctx.core.executors.has('main', 'compact'), false)
    const undo = h.ctx.core.executors.provideNative({ newConversation: () => ({ scheduled: true }), usage: () => ({ tokens: 5, window: 10, epoch: 0 }), compact: () => ({ compacted: true }) })
    assert.deepEqual((await h.ctx.core.executors.executorOf('main')).required.usage('main'), { tokens: 5, window: 10, epoch: 0 })
    assert.equal(await h.ctx.core.executors.has('main', 'compact'), true)
    undo()
    assert.equal(await h.ctx.core.executors.has('main', 'compact'), false, '撤销后换回去')
})

test('启动完成时原生还没有压缩引擎就报一次；装上了就不报；装上以后又卸下也报', async (t) => {
    let settle
    const settled = new Promise(resolve => { settle = resolve })
    const h = await makeHarness(t, { coreDeps: { startupSettled: () => settled } })
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const missing = () => reports.filter(entry => entry.kind === 'core/native-engine-missing')
    assert.equal(missing().length, 0, '启动没完成前不报')
    settle()
    await waitFor(() => missing().length === 1, '启动完成报一次')
    assert.match(missing()[0].text, /原生没装压缩引擎，换新对话、主动压缩都做不了/)

    let settle2
    const settled2 = new Promise(resolve => { settle2 = resolve })
    const h2 = await makeHarness(t, { coreDeps: { startupSettled: () => settled2 } })
    const reports2 = []
    h2.ctx.core.onReport(entry => reports2.push(entry))
    const undo = h2.ctx.core.executors.provideNative({ newConversation: () => ({ scheduled: true }), usage: () => null })
    settle2()
    await new Promise(resolve => setTimeout(resolve, 30))
    const missing2 = () => reports2.filter(entry => entry.kind === 'core/native-engine-missing')
    assert.equal(missing2().length, 0, '启动时已经装上，不报')
    undo()
    assert.match(missing2()[0]?.text ?? '', /压缩引擎卸下了/)
})

test('启动完成时还没有中枢：报 core/no-hub，告诉用户在要作中枢的会话里输入 /hub；有中枢就不报', async (t) => {
    let settle
    const settled = new Promise(resolve => { settle = resolve })
    const h = await makeHarness(t, { coreDeps: { startupSettled: () => settled, dshHome: 'D:/dsh-home-for-test' } })
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    settle()
    await waitFor(() => reports.some(entry => entry.kind === 'core/no-hub'), '报了没有中枢')
    const [noHub] = reports.filter(entry => entry.kind === 'core/no-hub')
    assert.match(noHub.text, /打开要作中枢的会话[\s\S]*输入 \/hub/)

    let settle2
    const settled2 = new Promise(resolve => { settle2 = resolve })
    const h2 = await makeHarness(t, { coreDeps: { startupSettled: () => settled2 } })
    const reports2 = []
    h2.ctx.core.onReport(entry => reports2.push(entry))
    await h2.createSession('main')
    await h2.ctx.core.sessions.setHub('main', { by: { kind: 'program', plugin: 'test' } })
    settle2()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(reports2.filter(entry => entry.kind === 'core/no-hub').length, 0)
})

test('会话的活动是执行方的可选能力：能力的值就是函数；交回的只取后台任务数和最后输出时间；没有这项能力、读不出时为 null，读不出还要报', async (t) => {
    const h = await makeHarness(t)
    await h.createSession('main')
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    assert.equal(await h.ctx.core.executors.activity('main'), null, '原生没有这项能力')
    const probe = await h.pluginContext('probe-activity')
    assert.throws(() => probe.core.executors.register({ id: 'bad', handles: () => false, required: ALL_REQUIRED, optional: { activity: true } }), /activity/)
    let answer = { background: 2, lastOutputAt: 1234, extra: 'x' }
    probe.core.executors.register({
        id: 'agent-sdk',
        handles: selection => selection.provider === ROUTE.provider,
        required: ALL_REQUIRED,
        optional: { activity: () => { if (answer instanceof Error) throw answer; return answer } },
    })
    assert.deepEqual(await h.ctx.core.executors.activity('main'), { background: 2, lastOutputAt: 1234 })
    answer = { background: -1, lastOutputAt: 'later' }
    assert.deepEqual(await h.ctx.core.executors.activity('main'), { background: 0, lastOutputAt: null }, '不合法的值按没有')
    answer = null
    assert.equal(await h.ctx.core.executors.activity('main'), null)
    answer = new Error('进程表坏了')
    assert.equal(await h.ctx.core.executors.activity('main'), null)
    assert.ok(reports.some(entry => entry.kind === 'core/activity-failed' && entry.sessionId === 'main'))
})

test('额度详情：state 只从闸门的 state() 来，detail() 只补充 since、resetsAt、window、outageId、windows，多给的不往外传；读不出时只给状态并报出来', async (t) => {
    const h = await makeHarness(t)
    await h.createSession('main')
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    let detail = () => ({ state: 'ok', since: 1, resetsAt: 2, window: 'five_hour', outageId: 'o-1', windows: { five_hour: { utilization: 0.9, resetsAt: 2 } }, model: 'opus' })
    const probe = await h.pluginContext('probe-executor')
    probe.core.executors.register({
        id: 'agent-sdk',
        handles: selection => selection.provider === ROUTE.provider,
        required: ALL_REQUIRED,
        optional: { quotaGate: { state: () => 'limited', codes: ['USAGE_LIMIT'], detail: sessionId => detail(sessionId) } },
    })
    assert.deepEqual(await h.ctx.core.quota.detail('main'),
        { state: 'limited', since: 1, resetsAt: 2, window: 'five_hour', outageId: 'o-1', windows: { five_hour: { utilization: 0.9, resetsAt: 2 } } }, 'detail 里的 state 不算，多给的 model 不传')
    detail = () => { throw new Error('读不出') }
    assert.deepEqual(await h.ctx.core.quota.detail('main'), { state: 'limited', since: null, resetsAt: null, window: null, outageId: null, windows: null })
    assert.ok(reports.some(entry => entry.kind === 'core/quota-detail-failed'))
    assert.throws(() => probe.core.executors.register({
        id: 'bad', handles: () => false, required: ALL_REQUIRED, optional: { quotaGate: { state: () => 'ok', detail: 'x' } },
    }), /quotaGate/)
    await probe.fiber.dispose()
})

test('定中枢：用户在会话里输入 /hub；原来的中枢不再有角色；还没开过轮、带参数、外部调用方的会话不行', async (t) => {
    const registered = []
    const h = await makeHarness(t)
    // 充当上游的命令服务：只收登记，测试里直接调登记上来的处理函数。
    await h.ctx.plugin({ name: 'fake-commands', apply(child) { child.provide('commands', { register: (definition) => { registered.push(definition); return () => {} } }) } })
    await waitFor(() => registered.some(item => item.name === 'hub'), '登记了 /hub')
    const { handler } = registered.find(item => item.name === 'hub')
    const a = await h.createSession('a')
    const b = await h.createSession('b')
    const invoke = (agent, rawInput = '') => handler({ agent, rawInput, signal: new AbortController().signal })
    // 还没开过轮的会话 DSH 不显示、会被重用：抛错（DSH 的输入框把它弹给用户看；交回 error 结果在空会话里看不到）。
    await assert.rejects(invoke(a), /先在这个会话里说一句话/)
    assert.equal(h.ctx.core.sessions.hub(), null)
    for (const [id, agent] of [['a', a], ['b', b]]) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }))
        await waitFor(async () => (await h.turnEnds(id)).length === 1, `${id} 开过一轮`)
    }
    assert.equal((await invoke(a)).kind, 'success')
    assert.equal(h.ctx.core.sessions.hub(), 'a')
    assert.equal((await invoke(b, '别的')).kind, 'error', '不带参数')
    assert.match((await invoke(b)).text, /原来的中枢（a）不再有角色/)
    assert.equal(h.ctx.core.sessions.hub(), 'b')
    assert.equal(h.ctx.core.sessions.roleOf('a'), null)
    await h.ctx.core.sessions.assign('a', 'external', { by: { kind: 'program', plugin: 'test' } })
    assert.equal((await invoke(a)).kind, 'error', '外部调用方的会话不能作中枢')
})
