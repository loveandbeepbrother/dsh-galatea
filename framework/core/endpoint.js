/**
 * 工具端点 `core.toolEndpoint`：别的执行方（Claude Code 等）经 MCP 拿到会话能用的工具。
 *
 * - 按 Streamable HTTP：POST 收 JSON-RPC（`initialize`、`ping`、`tools/list`、`tools/call`、`notifications/*`），
 *   GET 开一条事件流，工具集变了推 `notifications/tools/list_changed`，开着的进程不用等下次启动；DELETE 结束会话。
 * - 每个执行方会话一个端点：`open(sessionId, {readOnly})` 发一个令牌，令牌绑定会话身份（`Authorization: Bearer`）。
 * - 列工具、调工具都和原生一样先 `tools.resolve` 出这个 Agent 这一步的工具集（`allow` 包成的 `when`、上游工具的挡法都生效），
 *   用完 `dispose`。只交 `audience` 不是 `native-only` 的；只读端点只交 `effect: 'read'` 的（在服务端执行）。
 *   MCP 的 `readOnlyHint`、`destructiveHint` 从工具声明来。工具默认延后加载：执行方（Claude Code）只列出工具名，
 *   要用时经工具搜索加载，插件装多了也不会把每段对话的开头占满；声明了 `alwaysLoad` 的才带
 *   `_meta['anthropic/alwaysLoad']` 常驻。`initialize` 交回服务器说明（`SERVER_INSTRUCTIONS`），告诉模型这组工具管什么、
 *   什么时候去搜。
 * - 执行时用上游的 `agents.withInitiator(agent, …)` 包住（上游 Goal 工具要求发起者就是这个 Agent），带着工具集执行；
 *   结果里的 `additionalContexts` 作为单独的一段文字交回。MCP 客户端取消请求时中止对应的调用。
 * - 工具调用不写 DSH 会话日志（执行方交回的回复只有文字块）。调声明了 `writesSegments` 的工具前后，交给核心重算那几段
 *   （`segmentWrites.before`、`after`），核心据此分清哪些是会话自己改的、哪些是别人改的，执行方不用各自去记。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/endpoint
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { probeCalls } from './probe.js'

export const PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY = 4 * 1024 * 1024

/**
 * 交给执行方的服务器说明（MCP `initialize` 的 `instructions`）：工具多半延后加载，模型只看得到工具名，
 * 靠这段知道这组工具管什么、什么时候去搜。上限 4096 字（Claude Code 的工具搜索按这个截）。
 */
export const SERVER_INSTRUCTIONS = [
    '这是 DSH 的助手框架（Galatea）交给你的工具，名字以 assistant_ 开头，另有 DSH 的 present、schedule_*、create_goal 等，以及装了的插件的工具。',
    '只有最常用的几个常驻（发消息、会话间转话、写便签、统一搜索、交付文档、交接）；其余只列出名字，用之前先用工具搜索按名字或用途加载。',
    '什么时候去搜：',
    '- 用户问起以前的事、你拿不准自己记得的对不对：先用 assistant_search（经历、记忆、便签、文档一起搜），不要凭印象答，也不要先反问用户。',
    '- 要改人格、长期认知、常驻记忆、记忆、便签：搜 assistant_persona、assistant_cognition、assistant_standing、assistant_memory、assistant_note。',
    '- 你是外部 CLI、开对话时没有带上人格和常驻记忆：开工前用 assistant_mind_read 读 standing，里面是每段对话都该知道的事实。',
    '- 要定提醒、改定时任务：搜 schedule。要看或改持续工作、项目任务：搜 assistant_work、assistant_project、assistant_task。',
    '- 要管理消息渠道、群绑定、主动联系用户：搜 assistant_channel、assistant_contact。',
    '- 用户提到语音、朗读或别的插件的能力：按用途搜一下，装了就会出来。',
    '工具执行时的权限由 DSH 检查：有的工具只给中枢，有的不给外部调用方；调不了时结果里会写明原因。',
].join('\n')

/**
 * fetch 规范里的"bad port"：Node 的 fetch（Claude Code 连 MCP 端点用的就是它）一律拒绝连这些端口。
 * 系统挑空端口时可能挑到（Windows 的动态端口范围被改到 1024 起时就会），挑到了就换一个。
 */
export const FETCH_BAD_PORTS = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113,
    115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
    563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
    6668, 6669, 6679, 6697, 10080,
])

/**
 * 让 `server` 听 `port`；`port` 为 0（由系统挑）时避开 `FETCH_BAD_PORTS`，最多换 `attempts` 次。
 * @returns 实际听的端口。
 */
export async function listenAvoidingBadPorts(server, port, host, attempts = 8) {
    for (let attempt = 0; ; attempt += 1) {
        const got = await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, host, () => {
                server.off('error', reject)
                resolve(server.address().port)
            })
        })
        if (port !== 0 || !FETCH_BAD_PORTS.has(got) || attempt + 1 >= attempts) return got
        await new Promise(resolve => server.close(() => resolve()))
    }
}

/**
 * @param deps.tools - 上游 `tools` 服务。
 * @param deps.createExecutor - 造一个上游的原生工具执行器。
 * @param deps.agents - 上游 `agents`（`withInitiator`）。
 * @param deps.resolveAgent - 取会话的 Agent（不在内存里就恢复）。
 * @param deps.metaOf - 工具声明。
 * @param deps.allows - `(name, meta, agent)`：这个 Agent 的调用方能不能用这个工具（按声明里的 `allow`）。
 * @param deps.report - 报异常。
 * @param deps.segmentWrites - `{ before(sessionId, names), after(sessionId, names, succeeded) }`。
 * @param deps.version - 版本号（写进 `serverInfo`）。
 * @param deps.now - 取当前时间（测试用）。
 */
export function createEndpoint({ tools, createExecutor, agents, resolveAgent, metaOf, allows = () => true, report, segmentWrites = { before: async () => {}, after: async () => {} }, version = '0.0.0', host = '127.0.0.1', port = 0 }) {
    const grants = new Map()
    const streams = new Map()
    let server
    let listening

    function start() {
        if (listening === undefined) {
            server = createServer((req, res) => {
                handle(req, res).catch((error) => {
                    report('core/endpoint-failed', { text: `工具端点处理请求出错（${error?.message ?? error}）` })
                    if (!res.headersSent) send(res, 500, rpcError(null, -32603, '端点内部出错'))
                    else res.end()
                })
            })
            listening = listenAvoidingBadPorts(server, port, host)
        }
        return listening
    }

    /**
     * 给一个执行方会话开端点。
     * @returns `{ url, token }`。
     */
    /** @param options.probe - 体检用的令牌：经它调的工具，调用方带 `probe: true`（使用统计不计数），见 `probe.js`。 */
    async function open(sessionId, { readOnly = false, probe = false } = {}) {
        const actualPort = await start()
        const token = randomBytes(24).toString('base64url')
        grants.set(token, { sessionId: String(sessionId), readOnly: readOnly === true, probe: probe === true })
        return { url: `http://${host}:${actualPort}/mcp`, token }
    }

    /**
     * 用一个已有的令牌开端点（外部调用方：令牌存在凭据里，重启不变）。
     * @param options.tools - 只交这几个工具（`null` 表示不限）。
     * @param options.onUse - 每次用这个令牌发请求时调。
     */
    function grant(token, sessionId, { readOnly = true, tools: allowed = null, onUse } = {}) {
        grants.set(token, { sessionId: String(sessionId), readOnly: readOnly === true, allowed: allowed === null ? null : new Set(allowed), onUse })
        return start()
    }

    /** 当前端点的地址（还没开时先开）。 */
    async function address() {
        return `http://${host}:${await start()}/mcp`
    }

    function close(token) {
        grants.delete(token)
        for (const stream of streams.get(token) ?? []) stream.end()
        streams.delete(token)
    }

    /** 工具集可能变了：告诉所有开着事件流的客户端重新列。 */
    function listChanged() {
        const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`
        for (const set of streams.values()) for (const stream of set) stream.write(frame)
    }

    async function dispose() {
        for (const token of [...grants.keys()]) close(token)
        // 客户端的 keep-alive 连接和事件流会让 close 一直等着：先全部断开。
        if (server !== undefined) {
            const closed = new Promise(resolve => server.close(() => resolve()))
            server.closeAllConnections()
            await closed
        }
    }

    /* ------------------------------------------------------------------ HTTP */

    const inflight = new Map()

    async function handle(req, res) {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' })
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
        const grant = token === undefined ? undefined : grants.get(token)
        if (grant === undefined) return send(res, 401, rpcError(null, -32001, '令牌不对或已经作废'))
        grant.onUse?.()
        if (req.method === 'GET') return openStream(token, res)
        if (req.method === 'DELETE') return send(res, 200, {})
        if (req.method !== 'POST') return send(res, 405, rpcError(null, -32600, '只收 POST、GET、DELETE'))
        const body = await readBody(req)
        let message
        try {
            message = JSON.parse(body)
        } catch {
            return send(res, 400, rpcError(null, -32700, '请求不是合法的 JSON'))
        }
        const messages = Array.isArray(message) ? message : [message]
        const replies = []
        let sessionHeader
        for (const item of messages) {
            if (item?.method === 'initialize') sessionHeader = randomUUID()
            const reply = await dispatch(grant, item)
            if (reply !== undefined) replies.push(reply)
        }
        if (replies.length === 0) {
            res.writeHead(202)
            return res.end()
        }
        return send(res, 200, Array.isArray(message) ? replies : replies[0], sessionHeader === undefined ? {} : { 'mcp-session-id': sessionHeader })
    }

    function openStream(token, res) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': open\n\n')
        const set = streams.get(token) ?? new Set()
        set.add(res)
        streams.set(token, set)
        res.on('close', () => set.delete(res))
    }

    async function dispatch(grant, message) {
        const { id, method, params } = message ?? {}
        const isRequest = id !== undefined && id !== null
        try {
            switch (method) {
                case 'initialize':
                    return result(id, {
                        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
                        capabilities: { tools: { listChanged: true } },
                        serverInfo: { name: 'mind-framework', version },
                        instructions: SERVER_INSTRUCTIONS,
                    })
                case 'ping':
                    return result(id, {})
                case 'tools/list':
                    return result(id, { tools: await listTools(grant) })
                case 'tools/call':
                    return result(id, await callTool(grant, params, id))
                case 'notifications/cancelled':
                    inflight.get(`${grant.sessionId}\u0000${params?.requestId}`)?.abort(new Error('MCP 客户端取消了这次调用'))
                    return undefined
                default:
                    if (typeof method === 'string' && method.startsWith('notifications/')) return undefined
                    return isRequest ? rpcError(id, -32601, `不支持 ${method}`) : undefined
            }
        } catch (error) {
            return isRequest ? rpcError(id, error?.rpcCode ?? -32603, error?.message ?? String(error)) : undefined
        }
    }

    /** 这个 Agent 这一步能用、这个端点该交的工具（解析出的工具集交给 `use`，用完放掉）。 */
    async function withVisible(grant, signal, use) {
        const agent = await resolveAgent(grant.sessionId)
        const modelSelection = agent.model?.current?.()
        const toolSet = await tools.resolve({ agent, modelSelection, signal })
        try {
            // 用上游转好的工具 schema：定义里的 parameters 是属性表，schema 里是完整的 JSON Schema。
            const visible = tools.schemas(agent, toolSet).filter((schema) => {
                const meta = metaOf(schema.name)
                if (meta.audience === 'native-only') return false
                if (grant.allowed != null && !grant.allowed.has(schema.name)) return false
                // 上游在 Agent 作用域里注册的工具 restrict 挡不了，声明里的 allow 在这里执行（列和调都经这里）。
                if (!allows(schema.name, meta, agent)) return false
                return !grant.readOnly || meta.effect === 'read'
            })
            return await use({ agent, toolSet, visible })
        } finally {
            toolSet.dispose()
        }
    }

    async function listTools(grant) {
        return withVisible(grant, AbortSignal.timeout(30_000), ({ visible }) => visible.map((schema) => {
            const meta = metaOf(schema.name)
            return {
                name: schema.name,
                description: schema.description ?? '',
                inputSchema: schema.parameters ?? { type: 'object', properties: {} },
                annotations: { readOnlyHint: meta.effect === 'read', destructiveHint: meta.destructive },
                ...meta.alwaysLoad ? { _meta: { 'anthropic/alwaysLoad': true } } : {},
            }
        }))
    }

    async function callTool(grant, params, requestId) {
        const name = params?.name
        if (typeof name !== 'string') throw Object.assign(new Error('tools/call 要写工具名'), { rpcCode: -32602 })
        const controller = new AbortController()
        const key = `${grant.sessionId}\u0000${requestId}`
        inflight.set(key, controller)
        try {
            return await withVisible(grant, controller.signal, async ({ agent, toolSet, visible }) => {
                if (!visible.some(schema => schema.name === name)) {
                    throw Object.assign(new Error(`这个端点不能调 ${name}`), { rpcCode: -32602 })
                }
                const written = metaOf(name).writesSegments
                if (written.length > 0) await segmentWrites.before(grant.sessionId, written)
                const executor = createExecutor()
                const batch = await probeCalls.run(grant.probe === true, () => agents.withInitiator(agent, () => executor.execute({
                    agent,
                    signal: controller.signal,
                    toolSet,
                    calls: [{ type: 'tool-call', id: `endpoint-${randomUUID()}`, name, arguments: JSON.stringify(params.arguments ?? {}) }],
                })))
                const outcome = batch.results[0]?.result
                if (written.length > 0) await segmentWrites.after(grant.sessionId, written, outcome?.isError !== true)
                const content = [...toMcpContent(outcome?.content ?? [])]
                for (const context of batch.additionalContexts ?? []) content.push(...toMcpContent(context.content ?? []))
                return { content, isError: outcome?.isError === true }
            })
        } finally {
            inflight.delete(key)
        }
    }

    return Object.freeze({ open, grant, address, close, listChanged, dispose })
}

/** 上游的内容块转成 MCP 的：文字照交，别的先写一句说明。 */
function toMcpContent(blocks) {
    return blocks.map(block => block?.type === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'text', text: `[${block?.type ?? '未知'}内容，端点暂时不转]` })
}

function result(id, value) {
    return id === undefined || id === null ? undefined : { jsonrpc: '2.0', id, result: value }
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } }
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > MAX_BODY) {
                reject(new Error('请求太大'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}
