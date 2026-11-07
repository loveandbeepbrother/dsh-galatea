/**
 * 持续工作：开工（项目里建工作会话、定角色、维护窗口里建 Goal 放输入）、做完回报发起方、同键同参交回已有的、
 * 连着出错改成 blocked、暂停记下是谁停的、重启核对不替用户继续停下的工作。核心、会话控制器、项目登记、上游 Goal 都是真的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import * as WorkModule from '../work/index.js'
import { makeHarness, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })
const CONFIG = { tickSeconds: 3600, startupDelaySeconds: 3600, backoffSeconds: 0, maxGoalRounds: 0 }

function* text(body) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
}

async function setup(t) {
    const h = await makeHarness(t, { controller: true, goal: true })
    const reports = []
    h.ctx.core.onReport(item => reports.push(item))
    const novel = join(h.workDirectory, 'novel')
    await mkdir(novel, { recursive: true })
    const project = await h.ctx.workspaceRegistry.create(novel, '小说')
    await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: BY })
    const mount = async () => {
        const fiber = await h.ctx.plugin({ name: 'work-under-test', inject: WorkModule.inject, apply: child => WorkModule.apply(child, CONFIG) })
        t.after(() => fiber.dispose())
        return fiber
    }
    const fiber = await mount()
    const HUB = { kind: 'session', sessionId: 'main', role: 'hub' }
    /**
     * 工作会话的模型：第一轮（初始输入开的）先回一句；第二轮（Goal 轮次）调 update_goal 标成 complete，再写报告。
     * 上游只许"用户本人直接开的一轮或当前的 Goal 轮次"标 complete、blocked，初始输入开的那一轮两样都不是。
     */
    const completes = (report) => {
        h.adapter.scripts.push(() => text('开始做'), function* (options) {
            const agent = h.ctx.agents.get(options.sessionId)
            const view = h.ctx.goals.get(agent)
            const args = JSON.stringify({ goal_id: String(view.id), revision: view.revision, action: 'complete' })
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-done', name: 'update_goal', arguments: args } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
        }, () => text(report))
    }
    const reportsTo = async id => (await h.events(id)).flatMap(event => (event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : []))
        .filter(message => message.source?.kind === WorkModule.REPORT_SOURCE)
    return { h, reports, project, HUB, completes, reportsTo, fiber, mount }
}

test('开工：在项目里建工作会话、定成 worker；做完以后这一轮最后的文字作为报告交给发起会话，写明不代表用户验收', async (t) => {
    const { h, reports, project, HUB, completes, reportsTo } = await setup(t)
    const changes = []
    h.ctx.work.on('work/changed', change => changes.push(change))
    completes('第三章写好了，在 chapter-3.md')
    const started = await h.ctx.work.start({ objective: '写完第三章', deliverables: ['chapter-3.md'], workspace: String(project.id), key: 'k1' }, HUB)
    assert.equal(started.phase, 'running')
    assert.equal(h.ctx.core.sessions.roleOf(started.sessionId), 'worker')
    assert.equal(h.ctx.core.sessions.projectOf(started.sessionId)?.id, String(project.id))
    assert.ok(reports.some(item => item.kind === 'work/no-mind'), '没装心智时照常开工、报一次')
    await waitFor(async () => (await reportsTo('main')).length === 1, '报告交给发起会话')
    const [report] = await reportsTo('main')
    assert.match(report.content[0].text, /【工作报告】（这是工作会话的报告，不代表用户验收）工作 k1做完了/)
    assert.match(report.content[0].text, /第三章写好了，在 chapter-3\.md/)
    assert.equal(report.source.link, 'k1')
    assert.equal(h.ctx.work.status('k1').phase, 'complete')
    // 报告交出去以后才发变化通知，看到报告时通知可能还没到
    await waitFor(() => changes.length === 2, '做完的变化通知')
    assert.deepEqual(changes.map(change => change.phase), ['running', 'complete'])

    assert.equal((await h.ctx.work.start({ objective: '写完第三章', deliverables: ['chapter-3.md'], workspace: String(project.id), key: 'k1' }, HUB)).phase, 'complete', '同键同参交回已有的')
    await assert.rejects(h.ctx.work.start({ objective: '写第四章', workspace: String(project.id), key: 'k1' }, HUB), /参数和这次不同/)
    await assert.rejects(h.ctx.work.start({ objective: 'x', workspace: 'no-such', key: 'k2' }, HUB), /没有项目 no-such/)
})

test('连着出错：退避以后接着推，连着 3 轮出错改成 blocked，报告里写明错误', async (t) => {
    const { h, project, HUB, reportsTo } = await setup(t)
    // eslint-disable-next-line require-yield
    const broken = function* () { throw new Error('模型服务坏了') }
    h.adapter.scripts.push(broken, broken, broken)
    const started = await h.ctx.work.start({ objective: '会一直出错的工作', workspace: String(project.id), key: 'k-err' }, HUB)
    for (let round = 1; round <= 3; round += 1) {
        await waitFor(async () => (await h.turnEnds(started.sessionId)).length === round, `第 ${round} 轮出错结束`)
        await new Promise(resolve => setTimeout(resolve, 50))
        await h.ctx.work.tick()
    }
    await waitFor(async () => (await reportsTo('main')).length === 1, '报告')
    assert.equal(h.ctx.work.status('k-err').phase, 'blocked')
    assert.match((await reportsTo('main'))[0].content[0].text, /卡住了[\s\S]*连着 3 轮出错结束/)
})

test('暂停记下是谁停的；别处把 Goal 停了记成"用户或会话"；重启核对不替用户继续', async (t) => {
    const { h, project, HUB } = await setup(t)
    h.adapter.scripts.push(async function* (options) {
        await new Promise(resolve => options.signal?.addEventListener('abort', resolve))
        yield* text('被停下')
    })
    const started = await h.ctx.work.start({ objective: '长工作', workspace: String(project.id), key: 'k-long' }, HUB)
    await waitFor(() => h.ctx.agents.get(started.sessionId)?.status === 'running', '工作会话在跑')
    const paused = await h.ctx.work.pause('k-long', { reason: '先放一放', by: HUB })
    assert.equal(paused.phase, 'paused')
    assert.match(paused.pausedBy, /会话 main（hub）：先放一放/)
    await h.ctx.work.reconcile()
    assert.equal(h.ctx.work.status('k-long').phase, 'paused', '重启核对不替用户继续')

    const second = await h.ctx.work.start({ objective: '另一件', workspace: String(project.id), key: 'k-other' }, HUB)
    await waitFor(async () => (await h.turnEnds(second.sessionId)).length >= 1, '另一件跑了一轮')
    const agent = h.ctx.agents.get(second.sessionId)
    const view = h.ctx.goals.get(agent)
    if (view.phase === 'active') h.ctx.goals.pause(agent, { id: view.id, revision: view.revision })
    await waitFor(() => h.ctx.work.status('k-other').pausedBy === WorkModule.USER_OR_SESSION, '记成用户或会话')
})

test('跨重启：没结束、也没人停过的工作，重新装上以后核对一遍，接着推并告诉发起会话"已自动继续"', async (t) => {
    const { h, project, HUB, fiber, mount } = await setup(t)
    h.adapter.scripts.push(async function* (options) {
        await new Promise(resolve => options.signal?.addEventListener('abort', resolve))
        yield* text('被停下')
    })
    const started = await h.ctx.work.start({ objective: '跨重启的工作', workspace: String(project.id), key: 'k-restart' }, HUB)
    await waitFor(() => h.ctx.agents.get(started.sessionId)?.status === 'running', '工作会话在跑')
    await fiber.dispose()
    // Goal 驱动没卸下，这里模拟重启后 Goal 被重置成没激活。
    const agent = h.ctx.agents.get(started.sessionId)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await waitFor(async () => (await h.turnEnds(started.sessionId)).length >= 1, '这一轮停了')
    const view = h.ctx.goals.get(agent)
    if (view.activation === 'armed') h.ctx.goals.disarm(agent)
    // 收件箱里留着一条活过重启的旧续跑消息。
    const { createUserMessage } = await import('./harness.mjs')
    const stale = createUserMessage({ content: [{ type: 'text', text: '旧的续跑' }], source: { kind: 'goal', goalId: view.id, revision: view.revision, round: 9 } })
    agent.inbox.append('next-turn', stale)
    await mount()
    await h.ctx.work.reconcile()
    assert.equal(h.ctx.goals.get(agent).activation, 'armed', '接着推')
    assert.ok(!agent.inbox.nextTurn.some(message => String(message.id) === String(stale.id)), '旧续跑消息撤掉了，不会和新排的一起跑')
    const notices = (await h.events('main')).flatMap(event => (event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : []))
        .filter(message => message.source?.kind === WorkModule.REPORT_SOURCE)
    assert.match(notices.at(-1).content[0].text, /Host 重启后，工作 k-restart（跨重启的工作）已自动继续/)
})

test('工具：七个合成 assistant_work（按 action）和 assistant_work_status；缺字段写明缺哪个，不带 workId 是列表', async (t) => {
    const { h } = await setup(t)
    const endpoint = await h.ctx.core.toolEndpoint.open('main')
    const rpc = async (method, params) => {
        const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        return JSON.parse(await response.text()).result
    }
    const call = async (name, args) => {
        const result = await rpc('tools/call', { name, arguments: args })
        return { error: result.isError === true, text: result.content.map(block => block.text).join('\n') }
    }
    const names = (await rpc('tools/list')).tools.map(tool => tool.name).filter(name => name.startsWith('assistant_work'))
    assert.deepEqual(names.sort(), ['assistant_work', 'assistant_work_status'])

    const missing = await call('assistant_work', { action: 'pause' })
    assert.ok(missing.error && /action pause 要填 workId/.test(missing.text), missing.text)
    const startMissing = await call('assistant_work', { action: 'start', objective: '写第三章' })
    assert.ok(startMissing.error && /action start 要填 workspace/.test(startMissing.text), startMissing.text)
    const wrong = await call('assistant_work', { action: 'stop', workId: 'w1' })
    assert.ok(wrong.error, wrong.text)

    const empty = await call('assistant_work_status', {})
    assert.ok(!empty.error, empty.text)
    assert.deepEqual(JSON.parse(empty.text), [], '不带 workId：列表（这时还没有工作）')
    const unknown = await call('assistant_work_status', { workId: 'no-such-work' })
    assert.ok(unknown.error, '带 workId 时按单个查，查不到报错')
})
