/**
 * 核心：调用方与工具声明。原生的筛选走上游真实的工具解析（`when`、`agent.ctx.tools.restrict`），看模型请求里交了哪些工具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createUserMessage, makeHarness, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

function probeTool(name) {
    return defineTool({ name, description: `测试用工具 ${name}`, parameters: {}, output, execute: () => 'ok' })
}

async function toolsInNextTurn(h, sessionId, agent) {
    const before = (await h.turnEnds(sessionId)).length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '看看有哪些工具' }], source: { kind: 'user' } }))
    await waitFor(async () => (await h.turnEnds(sessionId)).length === before + 1, `${sessionId} 这一轮`)
    return (h.adapter.requests.at(-1).tools ?? []).map(tool => tool.name)
}

test('调用方从 exec.agent 所在的会话现算：会话角色、子代理按父会话、外部调用方没登记的按只读、没有 Agent 的是程序', async (t) => {
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const main = await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: BY })
    await h.ctx.core.sessions.assign('ext-dev', 'external', { by: BY })

    assert.deepEqual(h.ctx.core.caller({ agent: main }), { kind: 'session', sessionId: 'main', role: 'hub' })
    const subagent = { session: { id: 'sub-1', header: { origin: 'subagent', parentSession: 'main' } } }
    assert.deepEqual(h.ctx.core.caller({ agent: subagent }), { kind: 'session', sessionId: 'main', role: 'hub' }, '子代理按父会话')
    const external = { session: { id: 'ext-dev', header: {} } }
    assert.deepEqual(h.ctx.core.caller({ agent: external }), { kind: 'external', name: 'ext-dev', readOnly: true })
    assert.equal(reports.filter(entry => entry.kind === 'core/unregistered-external').length, 1)
    const probe = await h.pluginContext('probe-caller')
    assert.deepEqual(probe.core.caller({}), { kind: 'program', plugin: 'probe-caller' }, '拿不到 Agent 时写明是哪个插件')
    // 角色变了，内存里的子代理跟着按父会话的新角色算。
    await h.ctx.core.sessions.setHub('other', { by: BY })
    assert.deepEqual(h.ctx.core.caller({ agent: subagent }), { kind: 'session', sessionId: 'main', role: null })
})

test('core.tool：allow 包成上游的 when，原生按真正的调用方筛；allow 抛错当不允许并报；插件卸下工具跟着撤', async (t) => {
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const hub = await h.createSession('hub')
    const work = await h.createSession('work')
    await h.ctx.core.sessions.setHub('hub', { by: BY })
    await h.ctx.core.sessions.assign('work', 'worker', { by: BY })
    const probe = await h.pluginContext('probe-tools')
    probe.core.tool(probeTool('probe_hub_only'), { effect: 'read', allow: caller => caller.role === 'hub' })
    probe.core.tool(probeTool('probe_broken_allow'), { allow: () => { throw new Error('坏了') } })
    probe.core.tool(probeTool('probe_everyone'), { effect: 'write', destructive: true, writesSegments: ['记忆目录'] })
    assert.throws(() => probe.core.tool(probeTool('probe_everyone'), {}), /已经经核心注册过/)
    assert.throws(() => probe.core.tool(probeTool('probe_bad_meta'), { effect: 'delete' }), /effect/)

    const hubTools = await toolsInNextTurn(h, 'hub', hub)
    assert.ok(hubTools.includes('probe_hub_only'))
    assert.ok(hubTools.includes('probe_everyone'))
    assert.ok(!hubTools.includes('probe_broken_allow'), 'allow 抛错当不允许')
    assert.ok(reports.some(entry => entry.kind === 'core/allow-threw' && entry.data.tool === 'probe_broken_allow'))
    const workTools = await toolsInNextTurn(h, 'work', work)
    assert.ok(!workTools.includes('probe_hub_only'), '项目会话看不到只给中枢的工具')
    assert.ok(workTools.includes('probe_everyone'))

    assert.deepEqual(h.ctx.core.toolMeta('probe_everyone'), { audience: 'all', effect: 'write', destructive: true, alwaysLoad: false, writesSegments: ['记忆目录'] })
    await probe.fiber.dispose()
    assert.ok(!(await toolsInNextTurn(h, 'hub', hub)).includes('probe_everyone'), '注册它的插件卸下，工具跟着撤')
})

test('上游工具：declareTool 的 allow 按 Agent 挡掉；登记、换中枢以后重新挡；没声明的按默认值并报一次', async (t) => {
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    // 充当上游的全局工具：不经核心注册。
    await h.ctx.plugin({ name: 'fake-upstream-tools', inject: ['tools'], apply(child) { child.tools.register(probeTool('send_message')) } })
    const a = await h.createSession('a')
    const b = await h.createSession('b')
    await h.ctx.core.sessions.setHub('a', { by: BY })
    assert.ok((await toolsInNextTurn(h, 'b', b)).includes('send_message'), '还没登记时照常')

    h.ctx.core.declareTool('send_message', { audience: 'native-only', allow: caller => caller.role === 'hub' })
    assert.ok(!(await toolsInNextTurn(h, 'b', b)).includes('send_message'), '登记以后已有的 Agent 也重新挡')
    assert.ok((await toolsInNextTurn(h, 'a', a)).includes('send_message'))

    await h.ctx.core.sessions.setHub('b', { by: BY })
    assert.ok((await toolsInNextTurn(h, 'b', b)).includes('send_message'), '换中枢以后重新挡')
    assert.ok(!(await toolsInNextTurn(h, 'a', a)).includes('send_message'))

    // 登记以后才注册的上游工具（热加载）：全局工具名变了时重挡。
    h.ctx.core.declareTool('late_tool', { allow: caller => caller.role === 'hub' })
    await h.ctx.plugin({ name: 'fake-late-upstream', inject: ['tools'], apply(child) { child.tools.register(probeTool('late_tool')) } })
    assert.ok(!(await toolsInNextTurn(h, 'a', a)).includes('late_tool'), 'Agent 建好以后才注册的上游工具也挡住')
    assert.ok((await toolsInNextTurn(h, 'b', b)).includes('late_tool'))

    assert.equal(h.ctx.core.toolMeta('send_message').audience, 'native-only')
    assert.deepEqual(h.ctx.core.toolMeta('nobody_declared'), { audience: 'all', effect: 'write', destructive: false, alwaysLoad: false, writesSegments: [] })
    h.ctx.core.toolMeta('nobody_declared')
    assert.equal(reports.filter(entry => entry.kind === 'core/undeclared-tool').length, 1)
    assert.equal(reports.find(entry => entry.kind === 'core/undeclared-tool').data.subject, 'nobody_declared', '每个工具各是一条')
    // 核心替上游登记的共用工具：Goal、交付文档（常驻）、定时提醒（照默认延后加载）。
    assert.deepEqual([h.ctx.core.toolMeta('present').effect, h.ctx.core.toolMeta('present').alwaysLoad], ['write', true])
    assert.deepEqual([h.ctx.core.toolMeta('schedule_list').effect, h.ctx.core.toolMeta('schedule_list').alwaysLoad], ['read', false])
    assert.equal(h.ctx.core.toolMeta('schedule_create').alwaysLoad, false)
    assert.equal(reports.filter(entry => entry.kind === 'core/undeclared-tool').length, 1, '这几个不再报没声明')
})

test('不认识框架的插件注册的工具，由 profile 在核心的 toolDeclarations 里声明（比如语音包的 tts_service_*）', async (t) => {
    const h = await makeHarness(t, { coreConfig: { toolDeclarations: { tts_service_say: { effect: 'write', alwaysLoad: true }, tts_service_voices: { effect: 'read' } } } })
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    assert.deepEqual([h.ctx.core.toolMeta('tts_service_say').effect, h.ctx.core.toolMeta('tts_service_say').alwaysLoad], ['write', true])
    assert.equal(h.ctx.core.toolMeta('tts_service_voices').alwaysLoad, false, '没写就是默认的延后加载')
    assert.equal(h.ctx.core.toolMeta('tts_service_voices').effect, 'read')
    assert.equal(reports.filter(entry => entry.kind === 'core/undeclared-tool').length, 0)
})
