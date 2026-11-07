/**
 * 核心：工具端点。真的起本机 HTTP，按 MCP 的 Streamable HTTP 发请求；工具走上游真实的解析与原生执行器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { makeHarness, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

/** 发一条 JSON-RPC。 */
async function rpc(endpoint, method, params, { id = 1, token = endpoint.token } = {}) {
    const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', ...id === null ? {} : { id }, method, ...params === undefined ? {} : { params } }),
    })
    const text = await response.text()
    return { status: response.status, headers: response.headers, body: text === '' ? null : JSON.parse(text) }
}

async function setup(t) {
    const h = await makeHarness(t)
    await h.createSession('hub')
    await h.createSession('work')
    await h.ctx.core.sessions.setHub('hub', { by: BY })
    await h.ctx.core.sessions.assign('work', 'worker', { by: BY })
    const seen = []
    h.ctx.core.tool(defineTool({
        name: 'probe_read', description: '读点东西', parameters: { q: { type: 'string' } }, output,
        execute: (args, exec) => {
            seen.push({ caller: h.ctx.core.caller(exec), initiator: String(h.ctx.agents.currentInitiator()?.session.id) })
            return `读到了 ${args.q}`
        },
    }), { effect: 'read' })
    h.ctx.core.tool(defineTool({ name: 'probe_write', description: '写点东西', parameters: {}, output, execute: () => '写好了' }), { effect: 'write', destructive: true, alwaysLoad: true })
    h.ctx.core.tool(defineTool({ name: 'probe_hub_only', description: '只给中枢', parameters: {}, output, execute: () => 'ok' }), { allow: caller => caller.role === 'hub' })
    h.ctx.core.tool(defineTool({ name: 'probe_native', description: '只给原生', parameters: {}, output, execute: () => 'ok' }), { audience: 'native-only' })
    return { h, seen }
}

test('端点：initialize、tools/list 按调用方和声明筛，令牌不对是 401', async (t) => {
    const { h } = await setup(t)
    const hub = await h.ctx.core.toolEndpoint.open('hub')
    const init = await rpc(hub, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(init.status, 200)
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: true } })
    assert.match(init.body.result.instructions, /工具搜索/, '服务器说明告诉模型这组工具管什么、什么时候去搜')
    assert.ok(init.body.result.instructions.length <= 4096)
    assert.ok(init.headers.get('mcp-session-id'))
    assert.equal((await rpc(hub, 'notifications/initialized', undefined, { id: null })).status, 202)

    const names = tools => tools.map(tool => tool.name).filter(name => name.startsWith('probe_')).sort()
    const hubTools = (await rpc(hub, 'tools/list')).body.result.tools
    assert.deepEqual(names(hubTools), ['probe_hub_only', 'probe_read', 'probe_write'], 'native-only 的不交')
    const read = hubTools.find(tool => tool.name === 'probe_read')
    assert.deepEqual(read.annotations, { readOnlyHint: true, destructiveHint: false })
    assert.equal(read._meta, undefined, '默认延后加载：不带常驻标记')
    assert.deepEqual(hubTools.find(tool => tool.name === 'probe_write')._meta, { 'anthropic/alwaysLoad': true }, '声明了 alwaysLoad 的常驻')
    assert.equal(read.inputSchema.type, 'object')
    assert.deepEqual(read.inputSchema.properties, { q: { type: 'string' } })
    assert.deepEqual(hubTools.find(tool => tool.name === 'probe_write').annotations, { readOnlyHint: false, destructiveHint: true })

    const work = await h.ctx.core.toolEndpoint.open('work')
    assert.deepEqual(names((await rpc(work, 'tools/list')).body.result.tools), ['probe_read', 'probe_write'], '按调用方筛')
    const readOnly = await h.ctx.core.toolEndpoint.open('hub', { readOnly: true })
    assert.deepEqual(names((await rpc(readOnly, 'tools/list')).body.result.tools), ['probe_read'], '只读端点只交读的工具，在服务端执行')

    assert.equal((await rpc(hub, 'tools/list', undefined, { token: 'wrong' })).status, 401)
    h.ctx.core.toolEndpoint.close(hub.token)
    assert.equal((await rpc(hub, 'tools/list')).status, 401, '作废以后不能再用')
})

test('端点：tools/call 带着解析出的工具集执行，发起者是这个 Agent，调用方按会话算；不该交的工具调不了', async (t) => {
    const { h, seen } = await setup(t)
    const hub = await h.ctx.core.toolEndpoint.open('hub')
    const called = await rpc(hub, 'tools/call', { name: 'probe_read', arguments: { q: '记忆' } })
    assert.deepEqual(called.body.result, { content: [{ type: 'text', text: '读到了 记忆' }], isError: false })
    assert.deepEqual(seen, [{ caller: { kind: 'session', sessionId: 'hub', role: 'hub' }, initiator: 'hub' }])

    const readOnly = await h.ctx.core.toolEndpoint.open('hub', { readOnly: true })
    const denied = await rpc(readOnly, 'tools/call', { name: 'probe_write', arguments: {} })
    assert.equal(denied.body.error.code, -32602)
    const work = await h.ctx.core.toolEndpoint.open('work')
    assert.match((await rpc(work, 'tools/call', { name: 'probe_hub_only', arguments: {} })).body.error.message, /不能调 probe_hub_only/)
    assert.equal((await rpc(hub, 'tools/call', { name: 'probe_native', arguments: {} })).body.error.code, -32602)
})

test('端点：上游在 Agent 作用域里注册的工具（restrict 挡不了），登记里的 allow 照样在端点挡住，列和调都不行', async (t) => {
    const { h } = await setup(t)
    // 充当 preset 在 Agent 自己作用域里注册的工具（Goal 工具就是这样）：不经核心注册。
    for (const id of ['hub', 'work']) h.ctx.agents.get(id).ctx.tools.register(defineTool({ name: 'probe_scoped', description: '作用域里的', parameters: {}, output, execute: () => 'ok' }))
    h.ctx.core.declareTool('probe_scoped', { effect: 'read', allow: caller => caller.role === 'hub' })
    const names = async endpoint => (await rpc(endpoint, 'tools/list')).body.result.tools.map(tool => tool.name)
    const hub = await h.ctx.core.toolEndpoint.open('hub')
    const work = await h.ctx.core.toolEndpoint.open('work')
    assert.ok((await names(hub)).includes('probe_scoped'))
    assert.ok(!(await names(work)).includes('probe_scoped'), 'allow 不让的不列')
    assert.ok((await rpc(work, 'tools/call', { name: 'probe_scoped', arguments: {} })).body.error, 'allow 不让的调不了')
})

test('端点：结果里的 additionalContexts 作为单独的一段交回；MCP 客户端取消时中止这次调用', async (t) => {
    const { h } = await setup(t)
    let started
    const running = new Promise(resolve => { started = resolve })
    h.ctx.core.tool(defineTool({
        name: 'probe_slow', description: '很慢', parameters: {}, output,
        execute: (_args, exec) => new Promise((resolve, reject) => {
            started()
            exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
        }),
    }), { effect: 'read' })
    h.ctx.core.tool(defineTool({
        name: 'probe_with_context', description: '附带说明', parameters: {}, output,
        execute: (_args, exec) => {
            exec.deferContext({ id: 'ctx-1', role: 'user', content: [{ type: 'text', text: '收尾说明：目标完成' }], source: { kind: 'test' } })
            return '完成了'
        },
    }), { effect: 'read' })
    const hub = await h.ctx.core.toolEndpoint.open('hub')
    const withContext = await rpc(hub, 'tools/call', { name: 'probe_with_context', arguments: {} })
    assert.deepEqual(withContext.body.result.content.map(block => block.text), ['完成了', '收尾说明：目标完成'])

    const pending = rpc(hub, 'tools/call', { name: 'probe_slow', arguments: {} }, { id: 42 })
    await running
    assert.equal((await rpc(hub, 'notifications/cancelled', { requestId: 42 }, { id: null })).status, 202)
    const cancelled = await pending
    assert.equal(cancelled.body.result.isError, true, '取消后这次调用以出错结束')
})

test('端点：工具集或角色变了，经 GET 事件流推 tools/list_changed', async (t) => {
    const { h } = await setup(t)
    const hub = await h.ctx.core.toolEndpoint.open('hub')
    const controller = new AbortController()
    t.after(() => controller.abort())
    const response = await fetch(hub.url, { headers: { accept: 'text/event-stream', authorization: `Bearer ${hub.token}` }, signal: controller.signal })
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const reader = response.body.getReader()
    let received = ''
    const pump = (async () => {
        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) return
                received += new TextDecoder().decode(value)
            }
        } catch {
            // 测试结束时中止流。
        }
    })()
    await h.ctx.core.sessions.assign('work', 'background', { by: BY })
    await waitFor(() => received.includes('notifications/tools/list_changed'), '角色变了推 list_changed')
    controller.abort()
    await pump
})

test('段的"会话自己改的不提"由核心按端点记下的调用算：调过声明了 writesSegments 的工具，那一段变了也不提', async (t) => {
    const { h } = await setup(t)
    let memory = '记忆目录：A'
    h.ctx.core.segment({ name: '记忆目录', order: 1, audience: 'opening', text: () => memory })
    h.ctx.core.tool(defineTool({
        name: 'probe_memory_write', description: '写记忆', parameters: {}, output,
        execute: () => {
            memory = '记忆目录：A、B'
            return '写好了'
        },
    }), { effect: 'write', writesSegments: ['记忆目录'] })
    await h.ctx.core.segments.open('cc-conv', 'hub')
    const hub = await h.ctx.core.toolEndpoint.open('hub')
    await rpc(hub, 'tools/call', { name: 'probe_memory_write', arguments: {} })
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'hub'), [], '这一轮会话自己改的，不提')
    memory = '记忆目录：A、B、C'
    assert.equal((await h.ctx.core.segments.changes('cc-conv', 'hub')).length, 1, '别人改的照常提')
})

test('会话自己改完以后别人又改了同一段：下一轮只提别人改的那部分', async (t) => {
    const { h } = await setup(t)
    const notes = []
    h.ctx.core.segment({ name: '记忆目录', order: 1, audience: 'opening', onChange: (prev, next) => `新增：${next.slice(prev.length)}`, text: () => notes.join('') })
    h.ctx.core.tool(defineTool({
        name: 'probe_memory_add', description: '写一条记忆', parameters: { text: { type: 'string' } }, output,
        execute: (args) => {
            notes.push(args.text)
            return '写好了'
        },
    }), { effect: 'write', writesSegments: ['记忆目录'] })
    notes.push('A;')
    await h.ctx.core.segments.open('cc-conv', 'hub')
    const hub = await h.ctx.core.toolEndpoint.open('hub')
    await rpc(hub, 'tools/call', { name: 'probe_memory_add', arguments: { text: '中枢写的;' } })
    notes.push('外部调用方写的;')
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'hub'), ['新增：外部调用方写的;'], '自己写的不提，别人同时写的照常提')
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'hub'), [], '提过以后不再提')
})

test('别人先改、会话自己后改同一段：下一轮只提别人改的那部分', async (t) => {
    const { h } = await setup(t)
    const notes = []
    h.ctx.core.segment({ name: '记忆目录', order: 1, audience: 'opening', onChange: (prev, next) => `新增：${next.slice(prev.length)}`, text: () => notes.join('') })
    h.ctx.core.tool(defineTool({
        name: 'probe_memory_add', description: '写一条记忆', parameters: { text: { type: 'string' } }, output,
        execute: (args) => {
            notes.push(args.text)
            return '写好了'
        },
    }), { effect: 'write', writesSegments: ['记忆目录'] })
    notes.push('A;')
    await h.ctx.core.segments.open('cc-conv', 'hub')
    const hub = await h.ctx.core.toolEndpoint.open('hub')
    notes.push('外部调用方写的;')
    await rpc(hub, 'tools/call', { name: 'probe_memory_add', arguments: { text: '中枢写的;' } })
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'hub'), ['新增：外部调用方写的;'], '别人先写的照常提，自己后写的不提')
    // 别人先写、自己写、别人再写：两段别人的都提。
    notes.push('甲;')
    await rpc(hub, 'tools/call', { name: 'probe_memory_add', arguments: { text: '自己的;' } })
    notes.push('乙;')
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'hub'), ['新增：甲;', '新增：乙;'])
})

test('系统挑到 fetch 禁用的端口时换一个：指定了端口的照用；一直挑到也有次数上限', async () => {
    const { FETCH_BAD_PORTS, listenAvoidingBadPorts } = await import('../core/endpoint.js')
    const fake = (ports) => {
        const listened = []
        let closed = 0
        return {
            listened, closed: () => closed,
            once() {}, off() {},
            listen(port, host, done) { listened.push(port); this.current = ports.shift(); done() },
            address() { return { port: this.current } },
            close(done) { closed += 1; done() },
        }
    }
    assert.ok(FETCH_BAD_PORTS.has(6000) && FETCH_BAD_PORTS.has(5060) && !FETCH_BAD_PORTS.has(49152))
    const picked = fake([6000, 5060, 51234])
    assert.equal(await listenAvoidingBadPorts(picked, 0, '127.0.0.1'), 51234)
    assert.equal(picked.closed(), 2, '挑到两次禁用端口，关了两次')
    const fixed = fake([6000])
    assert.equal(await listenAvoidingBadPorts(fixed, 6000, '127.0.0.1'), 6000, '指定的端口不换')
    const stuck = fake([6000, 6000, 6000])
    assert.equal(await listenAvoidingBadPorts(stuck, 0, '127.0.0.1', 3), 6000, '到上限就用最后挑到的')
})
