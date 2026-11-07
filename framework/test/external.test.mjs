/**
 * 核心：外部调用方的登记。会话经上游真实的 sessionController 建，令牌存进上游真实的本地凭据服务；
 * Connection 用一个只记下路由的替身（它对主人身份的核对属于上游，这里只看核心挂了哪些路由、路由做了什么）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as CredentialsLocalModule from '@deepseek-ai/dsh-credentials-local'

import { makeHarness } from './harness.mjs'

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

async function withExtras(t, root) {
    const cleanups = []
    const h = await makeHarness(root === undefined ? t : { after: cleanup => cleanups.push(cleanup) }, { core: false, controller: true, ...root === undefined ? {} : { root } })
    await h.ctx.plugin(CredentialsLocalModule.default ?? CredentialsLocalModule, { path: join(h.root, 'home', 'credentials.json'), dshHome: join(h.root, 'home'), watch: false })
    const routes = new Map()
    await h.ctx.plugin({
        name: 'fake-connection',
        apply(child) {
            child.provide('connection', { fetch: { register: (route) => { routes.set(`${route.methods[0]} ${route.path}`, route); return () => routes.delete(`${route.methods[0]} ${route.path}`) } } })
        },
    })
    await h.mountCore()
    h.ctx.core.tool(defineTool({ name: 'probe_read', description: '读', parameters: {}, output, execute: (_args, exec) => JSON.stringify(h.ctx.core.caller(exec)) }), { effect: 'read' })
    h.ctx.core.tool(defineTool({ name: 'probe_write', description: '写', parameters: {}, output, execute: () => '写好了' }), { effect: 'write' })
    h.ctx.core.tool(defineTool({ name: 'probe_other', description: '别的', parameters: {}, output, execute: () => 'ok' }), { effect: 'read' })
    const call = async (method, path, body) => {
        const route = routes.get(`${method} /api/mind-framework/external/${path}`)
        assert.ok(route !== undefined, `挂了 ${method} ${path}`)
        const response = await route.fetch(new Request(`http://localhost${route.path}`, { method, ...body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } }))
        return { status: response.status, body: await response.json() }
    }
    return { h, call, shutdown: async () => { for (const cleanup of cleanups) await cleanup() } }
}

async function rpc(url, token, method, params) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return { status: response.status, body: response.status === 401 ? null : await response.json() }
}

test('登记外部调用方：建一个 external 会话、发令牌；端点按登记筛工具；调用方带名字；list 看得到，作废后令牌失效', async (t) => {
    const { h, call } = await withExtras(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const registered = await call('POST', 'register', { name: 'claude-dev', readOnly: false, tools: ['probe_read', 'probe_write'] })
    assert.equal(registered.status, 200)
    assert.deepEqual(reports.filter(entry => entry.kind === 'core/unregistered-external'), [], '登记过程中定角色时，登记已经存好')
    const { token, sessionId } = registered.body
    assert.equal(sessionId, 'session-external-claude-dev')
    assert.equal(h.ctx.core.sessions.roleOf(sessionId), 'external')

    const url = await h.ctx.core.toolEndpoint.open(sessionId).then(opened => opened.url)
    const names = (await rpc(url, token, 'tools/list')).body.result.tools.map(tool => tool.name).filter(name => name.startsWith('probe_')).sort()
    assert.deepEqual(names, ['probe_read', 'probe_write'], '只交登记的那几个')
    const who = await rpc(url, token, 'tools/call', { name: 'probe_read', arguments: {} })
    assert.deepEqual(JSON.parse(who.body.result.content[0].text), { kind: 'external', name: 'claude-dev', readOnly: false }, '调用方按登记补上名字')

    const codex = (await call('POST', 'register', { name: 'codex', readOnly: true })).body
    const codexNames = (await rpc(url, codex.token, 'tools/list')).body.result.tools.map(tool => tool.name).filter(name => name.startsWith('probe_')).sort()
    assert.deepEqual(codexNames, ['probe_other', 'probe_read'], '只读的只交读的工具')

    const listed = (await call('GET', 'list')).body.callers.map(entry => [entry.name, entry.readOnly])
    assert.deepEqual(listed.sort(), [['claude-dev', false], ['codex', true]])
    assert.deepEqual(h.ctx.core.external.list().map(entry => entry.name).sort(), ['claude-dev', 'codex'])
    assert.equal(h.ctx.core.external.register, undefined, '服务上不开放登记')

    assert.equal((await call('POST', 'register', { name: 'Bad Name' })).status, 400)
    assert.deepEqual((await call('POST', 'revoke', { name: 'codex' })).body, { revoked: true })
    assert.equal((await rpc(url, codex.token, 'tools/list')).status, 401, '作废后令牌失效')
    assert.equal(h.ctx.core.sessions.roleOf('session-external-codex'), null)
})

test('重启以后令牌不变：按登记从凭据里取回令牌接回端点；重新登记换新令牌，旧的作废', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mind-framework-external-'))
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
    const first = await withExtras(t, root)
    const { token } = (await first.call('POST', 'register', { name: 'claude-dev', readOnly: true })).body
    await first.shutdown()

    const { h, call, shutdown } = await withExtras(t, root)
    t.after(shutdown)
    const url = await h.ctx.core.toolEndpoint.open('session-external-claude-dev').then(opened => opened.url)
    assert.equal((await rpc(url, token, 'tools/list')).status, 200, '重启以后同一个令牌照样能用')
    const again = (await call('POST', 'register', { name: 'claude-dev', readOnly: true })).body
    assert.notEqual(again.token, token)
    assert.equal(again.sessionId, 'session-external-claude-dev', '还是原来那个会话')
    assert.equal((await rpc(url, token, 'tools/list')).status, 401, '旧令牌作废')
    assert.equal((await rpc(url, again.token, 'tools/list')).status, 200)
})

test('外部调用方的会话不跑轮：deliver 交给它一律不可用，并报一条', async (t) => {
    const { h, call } = await withExtras(t)
    const { sessionId } = (await call('POST', 'register', { name: 'claude-dev', readOnly: true })).body
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const result = await h.ctx.core.deliver(sessionId, { key: 'k', text: '定时提醒指错了会话', source: { kind: 'schedule' }, speaker: { kind: 'program', plugin: 'schedule' } })
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /不跑轮/)
    assert.ok(reports.some(entry => entry.kind === 'core/deliver-to-external'))
    assert.equal((await h.turnEnds(sessionId)).length, 0)
})
