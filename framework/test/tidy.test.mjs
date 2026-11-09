/** 交接整理：真的核心、真的上下文和后台思考模块，执行方是假的。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as ContextModule from '../context/index.js'
import * as ReflectionModule from '../reflection/index.js'
import { permissions } from '../mind/index.js'
import { makeHarness, textReply, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })
const CONFIG = new ReflectionModule.Config({ provider: 'development_fake-framework', model: 'framework-model-1', tidyProvider: 'development_fake-framework', tidyModel: 'framework-model-1' })

async function setup(t, overrides = {}, deps = {}) {
    const h = await makeHarness(t, { controller: true })
    const reports = []
    h.ctx.core.onReport(item => reports.push(item), { takes: [] })
    await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: BY })
    const dir = mkdtempSync(join(tmpdir(), 'tidy-'))
    const document = join(dir, 'handoff.md')
    writeFileSync(document, '交接文档正文\n')
    const fiber = await h.ctx.plugin({
        name: 'reflection-under-test',
        inject: ReflectionModule.inject,
        apply: child => ReflectionModule.apply(child, new ReflectionModule.Config({ ...CONFIG, ...overrides }), { tidyDocument: join(dir, 'tidy-session.md'), ...deps }),
    })
    t.after(() => fiber.dispose())
    const target = () => h.ctx.core.sessions.withRole('tidy')[0]
    const inputs = async () => (await h.events(target())).filter(event => event.type === 'user/message' && event.data.source?.kind === 'handoff-tidy')
    return { h, reports, document, target, inputs }
}

test('整理：建 tidy 会话，交给它事实、交接文档路径和模板；跑完交回小结和用时；角色不对的不跑', async (t) => {
    const { h, document, target, inputs, reports } = await setup(t)
    h.ctx.reflection.contribute('Watchdog', () => ['语义检索降级'])
    const result = await h.ctx.reflection.tidy('main', { document })
    assert.equal(result.status, 'done', JSON.stringify(result))
    assert.equal(typeof result.seconds, 'number')
    assert.equal(h.ctx.core.sessions.roleOf(target()), 'tidy')
    const text = (await inputs())[0].data.content.map(block => block.text).join('\n')
    assert.match(text, /【交接整理】/)
    assert.ok(text.includes(document))
    assert.match(text, /Watchdog：\n- 语义检索降级/)
    assert.match(text, /assistant_tidy_done/, '起步模板')
    assert.ok(reports.some(item => item.kind === 'reflection/template-missing'))
    assert.equal(h.ctx.core.sessions.withRole('background').length, 0, '不碰后台思考会话')

    assert.deepEqual(await h.ctx.reflection.tidy(target(), { document }), { status: 'skipped' }, '整理会话自己交接不再整理')
    const before = (await inputs()).length
    await h.ctx.reflection.tidy('main', { document })
    assert.equal(h.ctx.core.sessions.withRole('tidy').length, 1, '只有一个整理会话')
    assert.equal((await inputs()).length, before + 1)
})

test('整理超时：取消，报出来，不抛错；下一次还能跑', async (t) => {
    const { h, document, reports } = await setup(t, {}, { tidyLimitMs: 1 })
    // 模型一直不答：机器忙的时候，答得快的假模型会抢在限时之前。
    let release
    const held = new Promise((resolve) => { release = resolve })
    h.adapter.scripts.push(async function * () { await held })
    const result = await h.ctx.reflection.tidy('main', { document })
    assert.equal(result.status, 'failed')
    assert.match(result.reason, /超过 5 分钟/)
    await waitFor(() => reports.some(item => item.kind === 'reflection/tidy-failed'), '报了')
    assert.equal(reports.find(item => item.kind === 'reflection/tidy-failed').sessionId, 'main')
    release()
})

test('整理配 0 分钟或空角色：不跑', async (t) => {
    const { h, document, target } = await setup(t, { tidyMaxMinutes: 0 })
    assert.deepEqual(await h.ctx.reflection.tidy('main', { document }), { status: 'skipped' })
    assert.equal(target(), undefined)
})

test('tidy 的权限：能写常驻记忆，不能写人格和长期认知', () => {
    const can = permissions({ kind: 'session', sessionId: 'x', role: 'tidy' })
    assert.equal(can.standing, true)
    assert.equal(can.cognition, false)
    assert.equal(can.personaCandidate, false)
    assert.equal(can.personaDaily, false)
})

test('工具结果：写明用时和小结；失败写明没做完；没跑不多话', () => {
    const noteOf = ContextModule.tidyNote
    assert.match(noteOf({ status: 'failed', reason: '超过 5 分钟', seconds: 300 }), /交接整理没做完（超过 5 分钟）/)
    const done = noteOf({ status: 'done', summary: '改了常驻记忆一处', gaps: '文档补了一条', seconds: 42, tokens: 70000 })
    assert.match(done, /用时 42 秒，上下文约 70000 token/)
    assert.match(done, /改了常驻记忆一处/)
    assert.match(done, /要你知道的：文档补了一条/)
})

test('调过 assistant_tidy_done：按声明的小结和要说的话交回；只有 tidy 能调；没在跑时不记', async (t) => {
    const { h, document, target } = await setup(t)
    let release
    const gate = new Promise(resolve => { release = resolve })
    h.adapter.scripts.push(async function* () {
        await gate
        yield* textReply('整理完了')
    })
    const running = h.ctx.reflection.tidy('main', { document })
    await waitFor(() => target() !== undefined && h.ctx.agents.get(target())?.status === 'running', '整理这一轮开始')
    const call = async (id, args) => {
        const endpoint = await h.ctx.core.toolEndpoint.open(id)
        const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'assistant_tidy_done', arguments: args } }),
        })
        const body = JSON.parse(await response.text())
        return body.error?.message ?? body.result.content[0].text
    }
    assert.match(await call('main', { summary: 'x' }), /./)
    assert.deepEqual(JSON.parse(await call(target(), { summary: '常驻记忆改了一处', gaps: '文档补了一条' })), { recorded: true })
    release()
    const result = await running
    assert.equal(result.summary, '常驻记忆改了一处')
    assert.equal(result.gaps, '文档补了一条')
    assert.deepEqual(JSON.parse(await call(target(), { summary: '晚了' })).recorded, false)
})

test('交接工具和整理接在一起：执行方接受之后才整理，整理的结果写进工具结果；执行方拒了不整理', async (t) => {
    const { h, document } = await setup(t)
    const calls = []
    const readies = []
    const probe = await h.pluginContext('probe-executor-tidy')
    let refuse = false
    probe.core.executors.register({
        id: 'tidy-fake',
        handles: selection => selection.provider === 'development_fake-framework',
        required: {
            runTurn: true, openingSegments: true, perTurnContext: true, toolEndpoint: true, interrupt: true, usage: () => null,
            newConversation: (sessionId, _document, options) => {
                calls.push(['newConversation', sessionId])
                readies.push(options?.ready)
                return refuse ? { scheduled: false, reason: '后台任务还在跑' } : { scheduled: true }
            },
        },
        optional: {},
    })
    const fiber = await h.ctx.plugin(ContextModule, {})
    t.after(() => fiber.dispose())
    const real = h.ctx.reflection.tidy
    const endpoint = await h.ctx.core.toolEndpoint.open('main')
    const handoff = async () => {
        const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'assistant_context_handoff', arguments: { document } } }),
        })
        const body = JSON.parse(await response.text())
        return body.result.content[0].text
    }
    assert.equal(typeof real, 'function')
    const said = await handoff()
    assert.match(said, /已安排/)
    assert.match(said, /交接整理在后台跑/, '工具立刻返回')
    assert.deepEqual(calls[0], ['newConversation', 'main'], '先让执行方接受')
    await waitFor(() => h.ctx.core.attachments('main').some(item => /交接整理（用时 \d+ 秒/.test(item.text)), '结果放进下一轮')
    assert.equal(typeof readies[0]?.then, 'function', '换对话要等整理')
    await readies[0]
    assert.equal(h.ctx.core.sessions.withRole('tidy').length, 1)

    refuse = true
    const before = calls.length
    const refused = await handoff()
    assert.match(refused, /没有交接：后台任务还在跑/)
    assert.equal(calls.length, before + 1, '拒了就不整理，也不开整理的新对话')
})
