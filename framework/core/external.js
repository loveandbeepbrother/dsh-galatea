/**
 * 外部调用方的登记 `core.external`：Claude Code、Codex CLI 这类不在 DSH 里跑的调用方。
 *
 * - 登记（名字、`readOnly`、`tools`）存在核心自己的存储域；令牌存进上游凭据服务（`<插件>/external-<名字>` 的记录），
 *   重启不变，`revoke` 时作废。身份是核心的数据，验令牌的也是核心的端点，所以外部入口模块只管桥和发现文件，
 *   关掉它，登记照样在，只是没有桥连进来。
 * - 每个名字一个角色为 `external` 的会话（经上游 `sessionController.create` 建，工作目录设在用户的内容目录），
 *   不跑轮，只作为它调工具时的执行上下文；令牌绑定在那个会话上。`core.caller` 认出这个会话时按登记补上 `name`、`readOnly`。
 * - `readOnly` 在服务端执行（只读端点只交读的工具）；`tools` 给了就只交这几个。
 * - 登记、作废只走主人才能调的设置页路由（上游 Connection 的精确路由：Host/Origin/Cookie 与主人身份由 Connection 核对，
 *   别人进不来）；服务上只开放 `list`。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/external
 */

import { randomBytes } from 'node:crypto'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const EXTERNAL_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/
export const ROUTE_PREFIX = '/api/mind-framework/external'
const LAST_SEEN_WRITE_MS = 60_000

export const externalDomainSpec = defineDomain({
    name: 'mind_framework_core_external',
    version: 1,
    layout: 'per-record',
    tables: {
        callers: {
            valueSchema: z.object({
                name: z.string(),
                readOnly: z.boolean(),
                tools: z.array(z.string()).nullable(),
                sessionId: z.string(),
                createdAt: z.number(),
                lastSeen: z.number().nullable(),
            }).strict(),
        },
    },
})

/**
 * @param domain - 已打开的 `externalDomainSpec` 存储域。
 * @param deps.credentials - 取上游凭据服务（没有时为 `undefined`：登记不了，已有的也接不上）。
 * @param deps.createSession - 建一个会话，交回会话编号。
 * @param deps.assignExternal - 把会话的角色定成 `external`。
 * @param deps.releaseRole - 去掉会话的角色。
 * @param deps.endpoint - 工具端点（`grant`、`close`）。
 * @param deps.owner - 插件名（凭据记录的作用域）。
 * @param deps.report - 报异常。
 */
export function createExternal(domain, { credentials, createSession, assignExternal, releaseRole, endpoint, owner, report, now = Date.now }) {
    const callers = () => domain.table('callers')
    const keyOf = name => `${owner}/external-${name}`
    const tokens = new Map()
    const lastWrite = new Map()

    function bySession(sessionId) {
        for (const [, value] of callers().entries()) if (value.sessionId === String(sessionId)) return value
        return undefined
    }

    function bind(registration, token) {
        tokens.set(registration.name, token)
        endpoint.grant(token, registration.sessionId, {
            readOnly: registration.readOnly,
            tools: registration.tools,
            onUse: () => noteSeen(registration.name),
        })
    }

    function noteSeen(name) {
        const at = now()
        const current = callers().get(name)
        if (current === undefined) return
        if (at - (lastWrite.get(name) ?? 0) < LAST_SEEN_WRITE_MS) return
        lastWrite.set(name, at)
        callers().put(name, { ...current, lastSeen: at }).catch(() => {})
    }

    /** 启动时：按登记把令牌接回端点。 */
    async function restore() {
        const store = credentials()
        if (store === undefined) {
            if ([...callers().entries()].length > 0) report('core/external-unavailable', { text: '没有凭据服务，已登记的外部调用方接不上' })
            return
        }
        for (const [name, registration] of callers().entries()) {
            const record = await store.readRecord(keyOf(name))
            const token = record?.kind === 'grant' ? record.payload?.token : undefined
            if (typeof token !== 'string' || token === '') {
                report('core/external-token-missing', { sessionId: registration.sessionId, text: `外部调用方 ${name} 的令牌在凭据里找不到，要重新登记` })
                continue
            }
            bind(registration, token)
        }
    }

    /**
     * 登记（或更新）一个外部调用方，发一个新令牌。只经主人的路由调。
     * @returns `{ token, sessionId }`。
     */
    async function register({ name, readOnly = true, tools = null } = {}) {
        if (typeof name !== 'string' || !EXTERNAL_NAME.test(name)) throw new TypeError('名字只能用小写字母、数字、_、-，开头是字母或数字')
        if (typeof readOnly !== 'boolean') throw new TypeError('readOnly 要是 true 或 false')
        if (tools !== null && (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string'))) throw new TypeError('tools 要是工具名的数组')
        const store = credentials()
        if (store === undefined) throw new Error('当前组合没有凭据服务，登记不了外部调用方')
        const previous = callers().get(name)
        const sessionId = previous?.sessionId ?? await createSession(name)
        // 先存登记、再定角色：反过来的话，中间那一下按角色认出是外部调用方、却找不到登记（会报 core/unregistered-external）。
        const registration = { name, readOnly, tools, sessionId, createdAt: previous?.createdAt ?? now(), lastSeen: previous?.lastSeen ?? null }
        await callers().put(name, registration)
        await assignExternal(sessionId)
        const token = randomBytes(32).toString('base64url')
        await store.modifyRecord(keyOf(name), () => ({ kind: 'grant', payload: { token } }))
        const old = tokens.get(name)
        if (old !== undefined) endpoint.close(old)
        bind(registration, token)
        return { token, sessionId }
    }

    function list() {
        return [...callers().entries()].map(([, { name, readOnly, tools, sessionId, lastSeen }]) => ({ name, readOnly, tools, sessionId, lastSeen }))
    }

    /** 作废：令牌失效、登记删掉、会话不再有角色（会话和它的记录留着）。只经主人的路由调。 */
    async function revoke(name) {
        const registration = callers().get(name)
        if (registration === undefined) return false
        const token = tokens.get(name)
        if (token !== undefined) endpoint.close(token)
        tokens.delete(name)
        await credentials()?.deleteRecord(keyOf(name))
        await callers().delete(name)
        await releaseRole(registration.sessionId)
        return true
    }

    return Object.freeze({ restore, register, list, revoke, bySession })
}

/**
 * 在上游 Connection 上挂主人才能调的路由：`GET …/list`、`POST …/register`、`POST …/revoke`。
 * @returns 撤掉这些路由。
 */
export function registerExternalRoutes(connection, external) {
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    const readJson = async (request) => {
        try {
            return await request.json()
        } catch {
            return undefined
        }
    }
    const routes = [
        { path: `${ROUTE_PREFIX}/list`, method: 'GET', fetch: async () => json(200, { callers: external.list() }) },
        {
            path: `${ROUTE_PREFIX}/register`, method: 'POST', fetch: async (request) => {
                const body = await readJson(request)
                try {
                    return json(200, await external.register({ name: body?.name, readOnly: body?.readOnly, tools: body?.tools ?? null }))
                } catch (error) {
                    return json(400, { error: error?.message ?? String(error) })
                }
            },
        },
        {
            path: `${ROUTE_PREFIX}/revoke`, method: 'POST', fetch: async (request) => {
                const body = await readJson(request)
                return json(200, { revoked: await external.revoke(String(body?.name ?? '')) })
            },
        },
    ]
    const disposers = routes.map(route => connection.fetch.register({ path: route.path, methods: [route.method], requestBody: 'buffered', fetch: route.fetch }))
    return () => {
        for (const dispose of disposers) dispose()
    }
}
