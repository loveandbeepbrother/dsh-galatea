/**
 * 会话角色 `core.sessions`：中枢、项目和任务会话、后台会话、子代理、外部调用方。
 *
 * - 角色存在核心自己的存储域里，不从任何入口推出来；子代理不存，按上游会话 header 的 `origin` 现算。
 * - 中枢至多一个，只能经 `setHub` 换：换上新的，原来的中枢不再有角色。
 * - 每次变化在 `role_changes` 表记一条（谁、从什么到什么、谁改的），并通知 `on('changed')` 的监听者。
 * - 项目归属 `projectOf(sessionId)`：同步，判法只有这一套。先看项目登记的会话列表（上游 `sessionIds`，只含登记过的会话）；
 *   没登记在任何项目里，再看工作目录落在哪个项目里。工作目录要解析真实路径，是异步的：会话加载时（`noteAgent`）算好存着，
 *   所以没加载过的会话只按登记认。都取路径最具体的一个，并列的认不准，算不在项目里。
 *   落在用户内容目录（或它下面）的项目不算项目：中枢、外部调用方的工作目录在那里。没装项目登记时都不在项目里。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/sessions
 */

import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** 存起来的角色；`subagent` 现算、不存。 */
export const STORED_ROLES = Object.freeze(['hub', 'worker', 'background', 'tidy', 'external'])
export const ROLES = Object.freeze([...STORED_ROLES, 'subagent'])

const roleSchema = z.enum(STORED_ROLES)
/** 改角色的一方：调用方类型定下以前，只要求有 `kind`。 */
const bySchema = z.object({ kind: z.string() }).passthrough()

export const sessionsDomainSpec = defineDomain({
    name: 'mind_framework_core_sessions',
    version: 1,
    layout: 'per-record',
    tables: {
        roles: {
            valueSchema: z.object({ role: roleSchema, label: z.string().optional(), at: z.number(), by: bySchema }).strict(),
        },
        role_changes: {
            valueSchema: z.object({
                sessionId: z.string(),
                from: roleSchema.nullable(),
                to: roleSchema.nullable(),
                at: z.number(),
                by: bySchema,
            }).strict(),
        },
    },
})

/**
 * @param domain - 已打开的 `sessionsDomainSpec` 存储域。
 * @param deps.headerOf - 按会话编号取上游会话 header（会话不在内存里时为 `undefined`）。
 * @param deps.now - 取当前时间（测试用）。
 */
export function createSessions(domain, { headerOf, workspaces = () => [], excludedRoot = null, now = Date.now }) {
    const roles = () => domain.table('roles')
    const changes = () => domain.table('role_changes')
    const listeners = new Set()
    /** 见过的子代理会话（`agent/created` 时记下），会话不在内存里时 `roleOf` 也认得出。 */
    const subagents = new Set()
    /** 会话工作目录的真实路径（会话加载时算好），`projectOf` 按它认没登记的会话。 */
    const cwds = new Map()
    let sequence = 0
    let busy = Promise.resolve()
    const serial = (job) => {
        const next = busy.catch(() => {}).then(job)
        busy = next.catch(() => {})
        return next
    }

    function checkBy(by) {
        if (!bySchema.safeParse(by).success) throw new TypeError('改会话角色要写明是谁改的（by）')
    }

    function hub() {
        for (const [sessionId, value] of roles().entries()) if (value.role === 'hub') return sessionId
        return null
    }

    /** 定了某个角色的会话（存储里的，不管在不在内存里）。 */
    function withRole(role) {
        return [...roles().entries()].filter(([, value]) => value.role === role).map(([sessionId]) => String(sessionId))
    }

    function roleOf(sessionId) {
        const id = String(sessionId)
        const stored = roles().get(id)
        if (stored !== undefined) return stored.role
        if (subagents.has(id) || headerOf(id)?.origin === 'subagent') return 'subagent'
        return null
    }

    async function change(sessionId, to, { label, by }) {
        const from = roles().get(sessionId)?.role ?? null
        const at = now()
        if (to === null) await roles().delete(sessionId)
        else await roles().put(sessionId, { role: to, ...label === undefined ? {} : { label: String(label) }, at, by })
        sequence += 1
        await changes().put(`${at}-${String(sequence).padStart(6, '0')}`, { sessionId, from, to, at, by })
        for (const listener of [...listeners]) {
            try {
                listener({ sessionId, from, to })
            } catch {
                // 监听者出错不影响角色已经改好。
            }
        }
    }

    /** 换中枢：新的成为中枢，原来的中枢不再有角色。 */
    function setHub(sessionId, { by } = {}) {
        checkBy(by)
        const id = String(sessionId)
        return serial(async () => {
            const previous = hub()
            if (previous === id) return
            if (previous !== null) await change(previous, null, { by })
            await change(id, 'hub', { by })
        })
    }

    /** 给会话定一个角色（中枢只能经 `setHub`，子代理现算）。 */
    function assign(sessionId, role, { label, by } = {}) {
        checkBy(by)
        if (role === 'hub') throw new TypeError('中枢只能经 setHub 换')
        if (!STORED_ROLES.includes(role)) throw new TypeError(`没有这种会话角色：${role}`)
        const id = String(sessionId)
        return serial(() => change(id, role, { label, by }))
    }

    /** 去掉会话的角色。 */
    function release(sessionId, { by } = {}) {
        checkBy(by)
        const id = String(sessionId)
        return serial(async () => {
            if (roles().get(id) !== undefined) await change(id, null, { by })
        })
    }

    /** @returns 取消监听。 */
    function on(event, listener) {
        if (event !== 'changed') throw new TypeError(`core.sessions 没有 ${event} 事件`)
        listeners.add(listener)
        return () => {
            listeners.delete(listener)
        }
    }

    /** 上游新建或恢复了一个 Agent：记下子代理。 */
    function noteAgent(session) {
        const cwd = session?.header?.cwd
        if (session?.id !== undefined && typeof cwd === 'string' && cwd !== '') {
            const id = String(session.id)
            realpath(cwd).then(real => cwds.set(id, resolve(real)), () => cwds.set(id, resolve(cwd)))
        }
        if (session?.header?.origin === 'subagent') subagents.add(String(session.id))
    }

    /** 会话所在的项目 `{ id, title, path }`；不在项目里、认不准时为 `null`。 */
    function projectOf(sessionId) {
        const id = String(sessionId)
        // Windows 上路径不分大小写。
        const norm = path => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
        const inside = (root, path) => {
            const [r, p] = [norm(root), norm(path)]
            return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
        }
        const projects = workspaces().filter(item => excludedRoot === null || !inside(resolve(excludedRoot), resolve(item.path)))
        let holding = projects.filter(item => [...item.sessionIds].map(String).includes(id))
        const cwd = cwds.get(id)
        if (holding.length === 0 && cwd !== undefined) holding = projects.filter(item => inside(resolve(item.path), cwd))
        let best = null
        let tied = false
        for (const item of holding) {
            if (best === null || item.path.length > best.path.length) {
                best = item
                tied = false
            } else if (item.path.length === best.path.length) {
                tied = true
            }
        }
        return best === null || tied ? null : { id: String(best.id), title: String(best.title ?? best.id), path: best.path }
    }

    return Object.freeze({ hub, roleOf, withRole, setHub, assign, release, on, noteAgent, projectOf })
}
