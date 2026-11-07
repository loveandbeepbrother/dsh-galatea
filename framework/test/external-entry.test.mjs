/**
 * 外部入口：发现文件、stdio 桥（真的起一个桥进程走 MCP）、给用户抄的配置片段、给会话发话的工具。
 * 核心的登记、令牌、端点都是真的（上游的本地凭据服务、会话控制器），Connection 是只记下路由的替身。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as CredentialsLocalModule from '@deepseek-ai/dsh-credentials-local'

import * as ExternalModule from '../external/index.js'
import { makeHarness, waitFor } from './harness.mjs'

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const BY = Object.freeze({ kind: 'program', plugin: 'test' })

async function setup(t) {
    const h = await makeHarness(t, { core: false, controller: true })
    await h.ctx.plugin(CredentialsLocalModule.default ?? CredentialsLocalModule, { path: join(h.root, 'home', 'credentials.json'), dshHome: join(h.root, 'home'), watch: false })
    const routes = new Map()
    await h.ctx.plugin({
        name: 'fake-connection',
        apply(child) {
            child.provide('connection', { fetch: { register: (route) => { routes.set(`${route.methods[0]} ${route.path}`, route); return () => routes.delete(`${route.methods[0]} ${route.path}`) } } })
        },
    })
    await h.mountCore()
    h.ctx.core.tool(defineTool({ name: 'probe_read', description: '读一下', parameters: {}, output, execute: (_args, exec) => JSON.stringify(h.ctx.core.caller(exec)) }), { effect: 'read' })
    await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: BY })
    const route = async (method, path, body) => {
        const found = routes.get(`${method} /api/mind-framework/external/${path}`)
        assert.ok(found !== undefined, `挂了 ${method} ${path}`)
        const response = await found.fetch(new Request(`http://localhost${found.path}`, { method, ...body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } }))
        return { status: response.status, body: await response.json() }
    }
    const discoveryFile = join(h.root, 'bridge', 'endpoint.json')
    const instructionsFile = join(h.root, '外部入口说明.md')
    await writeFile(instructionsFile, '这是测试用的说明。')
    const mount = async () => {
        const fiber = await h.ctx.plugin(ExternalModule, { discoveryFile, tokenEnvPrefix: 'MF_TEST_TOKEN_', instructionsFile })
        t.after(() => fiber.dispose())
        return fiber
    }
    return { h, route, discoveryFile, instructionsFile, mount }
}

/** 起一个桥进程，按行收发 JSON-RPC。 */
function startBridge(t, args, env) {
    const child = spawn(process.execPath, [ExternalModule.BRIDGE, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    t.after(() => child.kill())
    const pending = new Map()
    const stderr = []
    child.stderr.on('data', chunk => stderr.push(String(chunk)))
    createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line)
        pending.get(message.id)?.(message)
        pending.delete(message.id)
    })
    let next = 1
    const ask = (method, params) => new Promise((resolve) => {
        const id = next++
        pending.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...params === undefined ? {} : { params } })}\n`)
    })
    return { ask, stderr }
}

test('发现文件只写地址、进程号、启动时间；桥每次读它、用环境变量里的令牌连核心端点；DSH 不在时用工具列表副本并写明原因', async (t) => {
    const { route, discoveryFile, instructionsFile, mount } = await setup(t)
    const fiber = await mount()
    const discovered = JSON.parse(await readFile(discoveryFile, 'utf8'))
    assert.deepEqual(Object.keys(discovered).sort(), ['pid', 'startedAt', 'url'])
    assert.equal(discovered.pid, process.pid)
    const { token } = (await route('POST', 'register', { name: 'claude-dev', readOnly: true })).body
    const config = (await route('POST', 'bridge-config', { name: 'claude-dev' })).body
    assert.equal(config.tokenEnv, 'MF_TEST_TOKEN_CLAUDE_DEV')
    assert.ok(!config.claudeCode.includes(token) && !config.codex.includes(token), '配置片段里没有令牌')
    assert.match(config.codex, /env_vars = \["MF_TEST_TOKEN_CLAUDE_DEV"\]/)

    const bridge = startBridge(t, ['--discovery', discoveryFile, '--token-env', config.tokenEnv, '--client', 'claude-dev', '--instructions', instructionsFile], { [config.tokenEnv]: token })
    const initialized = await bridge.ask('initialize', { protocolVersion: '2025-06-18' })
    assert.equal(initialized.result.instructions, '这是测试用的说明。')
    const listed = await bridge.ask('tools/list')
    assert.ok(listed.result.tools.some(tool => tool.name === 'probe_read'))
    assert.ok(!listed.result.tools.some(tool => tool.name === ExternalModule.SAY_TOOL), '登记时没写，发话工具不交')
    const called = await bridge.ask('tools/call', { name: 'probe_read', arguments: {} })
    assert.deepEqual(JSON.parse(called.result.content[0].text), { kind: 'external', name: 'claude-dev', readOnly: true })

    await fiber.dispose()
    await waitFor(() => !existsSync(discoveryFile), '卸下时删掉发现文件')
    const cached = await bridge.ask('tools/list')
    assert.ok(cached.result.tools.some(tool => tool.name === 'probe_read'), 'DSH 不在时用副本')
    const refused = await bridge.ask('tools/call', { name: 'probe_read', arguments: {} })
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /外部入口没有加载，或者 DSH 没在运行/)
    assert.ok(bridge.stderr.join('').includes('外部入口没有加载'), 'stderr 写明原因')
})

test('给会话发话：只有登记时写了这个工具的外部调用方能用；放进中枢，说话人是外部调用方，带来源标注', async (t) => {
    const { h, route, discoveryFile, mount } = await setup(t)
    await mount()
    const { token } = (await route('POST', 'register', { name: 'codex', readOnly: false, tools: ['probe_read', ExternalModule.SAY_TOOL] })).body
    const url = JSON.parse(await readFile(discoveryFile, 'utf8')).url
    const rpc = async (method, params) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json())
    assert.ok((await rpc('tools/list')).result.tools.some(tool => tool.name === ExternalModule.SAY_TOOL))
    const said = JSON.parse((await rpc('tools/call', { name: ExternalModule.SAY_TOOL, arguments: { text: '构建过了' } })).result.content[0].text)
    assert.equal(said.status, 'delivered')
    await waitFor(async () => (await h.userMessages('main')).some(message => message.source?.kind === ExternalModule.SAY_SOURCE), '放进中枢')
    const message = (await h.userMessages('main')).find(item => item.source?.kind === ExternalModule.SAY_SOURCE)
    assert.deepEqual(message.source.speaker, { kind: 'external', name: 'codex' })
    assert.match(message.source.annotation, /外部调用方 codex.*不是用户本人说的/)
})
