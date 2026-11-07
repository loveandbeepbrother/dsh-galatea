/**
 * 自省：第一次醒时建后台会话、交给它事实加模板加插件交来的几行；按编号认这一轮，按结束方式定下次间隔；
 * 用户本人说话时让位，下次输入写"上次被打断"；主动联系交给中枢、待告知留言段只报新增、打开只认用户本人。
 * 核心、会话、会话控制器都是真的，模型是假的提供方，时钟由测试给。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as ReflectionModule from '../reflection/index.js'
import { createUserMessage, makeHarness, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })
const CONFIG = {
    provider: 'development_fake-framework', model: 'framework-model-1', sessionTitle: '后台思考', templateFile: '后台思考.md',
    contactPhrase: '开启主动联系', tickSeconds: 3600, firstDelayMinutes: 0, quietMinutes: 0, overdueMinutes: 240,
    minMinutes: 60, defaultMinutes: 180, maxMinutes: 720, lostAfterMinutes: 180,
}

function textReply(text) {
    return function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
    }
}

async function setup(t) {
    const h = await makeHarness(t, { controller: true })
    const reports = []
    // 只看不接：没有消费方接手的异常照样交给后台思考。
    h.ctx.core.onReport(item => reports.push(item), { takes: [] })
    const clock = { now: Date.parse('2026-11-05T14:00:00+08:00') }
    const hub = await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: BY })
    const fiber = await h.ctx.plugin({
        name: 'reflection-under-test',
        inject: ReflectionModule.inject,
        apply: child => ReflectionModule.apply(child, CONFIG, { now: () => clock.now }),
    })
    t.after(() => fiber.dispose())
    const background = () => h.ctx.core.sessions.withRole('background')[0]
    const inputs = async () => (await h.events(background())).filter(event => event.type === 'user/message' && event.data.source?.kind === 'reflection')
    const endpoints = {}
    const call = async (id, name, args) => {
        endpoints[id] ??= await h.ctx.core.toolEndpoint.open(id)
        const response = await fetch(endpoints[id].url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoints[id].token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
        const body = JSON.parse(await response.text())
        if (body.error !== undefined) return { error: body.error.message }
        const text = body.result.content[0].text
        return body.result.isError ? { error: text } : JSON.parse(text)
    }
    return { h, hub, reports, clock, background, inputs, call }
}

test('第一次醒：建后台会话（角色 background），交给它事实、起步模板和插件交来的几行；没调 done 按默认间隔并报一次', async (t) => {
    const { h, reports, clock, background, inputs } = await setup(t)
    h.ctx.reflection.contribute('Watchdog', () => ['渠道断过一次'])
    h.ctx.reflection.contribute('坏掉的', () => { throw new Error('读不出') })
    await h.ctx.reflection.tick()
    assert.ok(background(), '建了后台会话')
    await waitFor(async () => (await h.turnEnds(background())).length === 1, '后台这一轮跑完')
    const [input] = await inputs()
    const text = input.data.content.map(block => block.text).join('\n')
    assert.match(text, /【后台思考】/)
    assert.match(text, /这是第一次后台思考/)
    assert.match(text, /Watchdog：\n- 渠道断过一次/)
    assert.match(text, /坏掉的 这一轮读取失败/)
    assert.match(text, /assistant_reflection_done/, '起步模板')
    assert.ok(reports.some(item => item.kind === 'reflection/template-missing'))
    await h.ctx.reflection.tick()
    const state = h.ctx.reflection.state()
    assert.equal(state.last.outcome, 'completed')
    assert.equal(state.nextAt, clock.now + 180 * 60_000, '默认 180 分钟')
    assert.ok(reports.some(item => item.kind === 'reflection/no-done'))
})

test('没有别的插件接手的异常，按类别计数交进事实段；有消费方接手的类别不交', async (t) => {
    const { h, background, inputs } = await setup(t)
    h.ctx.core.onReport(() => {}, { takes: ['handled/'] })
    const probe = await h.pluginContext('probe-plugin')
    probe.core.report('probe/broken', { text: '第一次坏了' })
    probe.core.report('probe/broken', { text: '又坏了一次' })
    probe.core.report('handled/thing', { text: '有人管的' })
    await h.ctx.reflection.tick()
    await waitFor(async () => (await inputs()).length === 1, '后台这一轮开始')
    const text = (await inputs())[0].data.content.map(block => block.text).join('\n')
    assert.match(text, /没有别的插件接手的异常（按类别）：\n(- .*\n)*- probe\/broken × 2，最近一条：又坏了一次/)
    assert.doesNotMatch(text, /handled\/thing/)
    assert.ok(background())
})

test('调过 assistant_reflection_done 的一轮正常结束：按声明的分钟数（夹在范围里），小结照声明', async (t) => {
    const { h, clock, background, call } = await setup(t)
    let release
    const gate = new Promise(resolve => { release = resolve })
    h.adapter.scripts.push(async function* () {
        await gate
        yield* textReply('想完了')()
    })
    await h.ctx.reflection.tick()
    await waitFor(() => h.ctx.agents.get(background())?.status === 'running', '后台这一轮开始')
    assert.deepEqual(await call(background(), 'assistant_reflection_done', { summary: '整理了记忆', nextMinutes: 5 }), { recorded: true, nextMinutes: 60, note: '这一轮正常结束时作数' })
    assert.match((await call('main', 'assistant_reflection_done', { summary: 'x', nextMinutes: 90 })).error ?? '', /./, '中枢调不了')
    release()
    await waitFor(async () => (await h.turnEnds(background())).length === 1, '跑完')
    await h.ctx.reflection.tick()
    assert.deepEqual(h.ctx.reflection.state().last.summary, '整理了记忆')
    assert.equal(h.ctx.reflection.state().nextAt, clock.now + 60 * 60_000, '夹到最少 60 分钟')
})

test('用户本人在中枢说话：后台这一轮让位，下次马上接着来，输入写"上次被打断"', async (t) => {
    const { h, hub, clock, background, inputs } = await setup(t)
    h.adapter.scripts.push(async function* (options) {
        await new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal.reason ?? new Error('aborted')))
        })
        yield* textReply('不会到这里')()
    })
    await h.ctx.reflection.tick()
    await waitFor(() => h.ctx.agents.get(background())?.status === 'running', '后台这一轮开始')
    hub.followup(createUserMessage({ content: [{ type: 'text', text: '我回来了' }], source: { kind: 'user' } }))
    await waitFor(async () => (await h.turnEnds(background())).length === 1, '后台这一轮被打断')
    await waitFor(async () => (await h.turnEnds('main')).length === 1, '中枢回完')
    await h.ctx.reflection.tick()
    assert.equal(h.ctx.reflection.state().last.outcome, 'yielded')
    assert.ok(h.ctx.reflection.state().nextAt <= clock.now, '马上接着来')
    await h.ctx.reflection.tick()
    await waitFor(async () => (await inputs()).length === 2, '下一轮开始')
    assert.match((await inputs())[1].data.content[0].text, /上次被打断/)
})

test('主动联系：留言交给中枢；待告知留言段只对中枢有内容、变化时只报新增；打开只认用户本人的口令', async (t) => {
    const { h, hub, call } = await setup(t)
    await h.createSession('work')
    await h.ctx.core.sessions.assign('work', 'worker', { by: BY })
    const left = await call('main', 'assistant_contact_user', { text: '第三章写完了' })
    assert.equal(left.state, 'relayed')
    const inbox = (await h.events('main')).flatMap(event => (event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : []))
    assert.ok(inbox.some(message => message.source?.kind === 'contact' && message.source?.link === left.id), '交给了中枢')
    assert.match((await call('work', 'assistant_contact_user', { text: 'x' })).error ?? '', /./, '工作会话不能留言')

    const opening = await h.ctx.core.segments.open('cc', 'main')
    assert.match(opening.find(entry => entry.name === ReflectionModule.CONTACT_SEGMENT).text, new RegExp(`- ${left.id}：第三章写完了`))
    assert.equal((await h.ctx.core.segments.open('cc-w', 'work')).find(entry => entry.name === ReflectionModule.CONTACT_SEGMENT), undefined, '只对中枢')
    await call('main', 'assistant_contact_told', { ids: [left.id] })
    assert.deepEqual(await h.ctx.core.segments.changes('cc', 'main'), [], '只少了一条，不提')
    const second = await call('main', 'assistant_contact_user', { text: '还有一件事' })
    const changes = await h.ctx.core.segments.changes('cc', 'main')
    assert.equal(changes.length, 1)
    // 整段清空以后又有了：核心按新出现的段给全文，全文里只有还没告知的，就是新增的这一条。
    assert.match(changes[0], new RegExp(`- ${second.id}：还有一件事`))
    assert.doesNotMatch(changes[0], new RegExp(left.id), '已告知的不再出现')
    const third = await call('main', 'assistant_contact_user', { text: '第三件' })
    const more = await h.ctx.core.segments.changes('cc', 'main')
    assert.deepEqual(more, [`（DSH 提示，不是用户发言）新的待告知留言：\n- ${third.id}：第三件`], '段还在时只报新增')

    assert.match((await call('main', 'assistant_contact_settings', { enabled: true })).error, /需要用户本人在这个会话里说"开启主动联系"/)
    hub.followup(createUserMessage({ content: [{ type: 'text', text: '开启 主动联系 吧' }], source: { kind: 'user' } }))
    await waitFor(async () => (await h.turnEnds('main')).length >= 1, '中枢这一轮')
    assert.deepEqual(await call('main', 'assistant_contact_settings', { enabled: true }), { enabled: true })
})

test('前台空闲也看接着出口的会话：接群的会话在跑时不醒，空下来以后再醒', async (t) => {
    const { h, background } = await setup(t)
    const group = await h.createSession('grp')
    const fiber = await h.ctx.plugin({ name: 'probe-exit', inject: ['core'], apply: ctx => { ctx.core.exits.register({ id: 'probe', sessions: () => [{ sessionId: 'grp', as: 'group' }] }) } })
    t.after(() => fiber.dispose())
    let release
    const gate = new Promise(resolve => { release = resolve })
    h.adapter.scripts.push(async function* () {
        await gate
        yield* textReply('群里回完了')()
    })
    group.followup(createUserMessage({ content: [{ type: 'text', text: '群里有人说话' }], source: { kind: 'user' } }))
    await waitFor(() => group.status === 'running', '接群的会话在跑')
    await h.ctx.reflection.tick()
    assert.equal(background(), undefined, '前台在跑，不醒（也就没建后台会话）')
    release()
    await waitFor(async () => (await h.turnEnds('grp')).length === 1, '群里这一轮完了')
    await h.ctx.reflection.tick()
    assert.ok(background(), '空下来以后醒了')
})
