/**
 * 调用方 `core.caller` 与工具声明。
 *
 * 调用方：
 * - 身份跟着 Agent 走：从 `exec.agent`（或工具激活时的 `agent`）所在的会话现算。
 *   会话角色是 `external` 的，按外部调用方的登记补上 `name`、`readOnly`；其余是 `{kind:'session', sessionId, role}`；
 *   拿不到 Agent 的是 `{kind:'program', plugin}`。
 * - 子代理按父会话算（上游 header 的 `parentSession`，一层层往上找到不是子代理的会话）。
 * - 不按调用编号登记，也不用异步上下文。
 *
 * 工具声明：
 * - 框架和插件的工具经 `core.tool(definition, meta)` 注册：核心替它向上游注册，`allow` 包成上游的 `when`，
 *   所以原生按真正的调用方筛；`allow` 抛错当"不允许"并报异常（上游 `when` 抛错会让整次解析失败）。
 * - 上游的工具改不了定义，用 `core.declareTool(name, meta)` 在一处登记；登记里的 `allow` 在两处执行：
 *   - 原生：核心在每个 Agent 新建或恢复时用 `agent.ctx.tools.restrict` 挡掉（只对这个 Agent 生效），会话角色变了重新挡一遍。
 *     上游的 `restrict` 只管全局工具，preset 在 Agent 自己作用域里注册的工具（比如 Goal 工具）它挡不了；
 *   - 端点：别的执行方和外部调用方都经核心的工具端点拿工具，端点按每个工具的 `allow` 筛，作用域里的工具也挡得住。
 * - `metaOf(name)` 给端点用：登记不到的照交（按默认值），报一次异常。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/tools
 */

import { inProbe } from './probe.js'

export const TOOL_AUDIENCES = Object.freeze(['all', 'native-only'])

/**
 * 框架替上游登记的工具（今天 Claude Code 插件里的 NATIVE_ONLY_TOOLS 搬到这里）：只给原生执行。
 * 别的执行方有自己的同类工具（读写、搜索、shell、网页、待办、skill），或者这些工具要它调不到的原生执行
 * （子代理、团队、目标、后台任务、工作目录、计划模式、插件管理）。
 */
export const UPSTREAM_NATIVE_ONLY_TOOLS = Object.freeze([
    'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'read_image', 'web_fetch', 'web_search', 'todo_write', 'skill',
    'ask_user_question', 'exit_plan_mode', 'working_directory', 'create_worktree', 'load_workspace_dependencies', 'plugin_manager',
    'cordis_inspect_list', 'cordis_inspect_query', 'workflow',
    'subagent', 'subagent_codex', 'subagent_fork', 'list_subagent_models', 'spawn_teammate', 'send_message', 'wait_agent',
    'interrupt_agent', 'list_agents', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
    'job_kill', 'job_list', 'job_output',
])
/**
 * 交给所有执行方（不给外部调用方）的上游工具和它们的声明：
 * - Goal 工具 Claude Code 没有同类，工作会话跑在 Claude Code 上也要能把 Goal 推到 complete、blocked，不然永远没有回报；
 * - `present` 是交付文档的规定出口，常驻（`alwaysLoad`）；
 * - 定时提醒 `schedule_*` 照默认延后加载。
 */
export const UPSTREAM_SHARED_TOOLS = Object.freeze({
    create_goal: { effect: 'write' },
    get_goal: { effect: 'read' },
    update_goal: { effect: 'write' },
    present: { effect: 'write', alwaysLoad: true },
    // DSH 0.2.2 的定时工具：create、list、view、edit（以前的 update、delete 合进了 edit）。
    schedule_create: { effect: 'write' },
    schedule_list: { effect: 'read' },
    schedule_view: { effect: 'read' },
    schedule_edit: { effect: 'write' },
})
export const EFFECTS = Object.freeze(['read', 'write'])
const DEFAULT_META = Object.freeze({ audience: 'all', effect: 'write', destructive: false, alwaysLoad: false, writesSegments: Object.freeze([]) })
const MAX_PARENT_DEPTH = 8

/**
 * 核对并补全工具声明。`alwaysLoad`：经 MCP 端点交给别的执行方时常驻（每次请求都带着完整定义）；
 * 默认不常驻，执行方按需经工具搜索加载，装的插件多了也不会把上下文占满。原生执行方不看这一项。
 */
export function normalizeMeta(meta = {}) {
    const { audience = 'all', effect = 'write', destructive = false, alwaysLoad = false, writesSegments = [], allow, links } = meta
    if (!TOOL_AUDIENCES.includes(audience)) throw new TypeError(`audience 只能是 ${TOOL_AUDIENCES.join('、')}`)
    if (!EFFECTS.includes(effect)) throw new TypeError(`effect 只能是 ${EFFECTS.join('、')}`)
    if (typeof destructive !== 'boolean') throw new TypeError('destructive 要是 true 或 false')
    if (typeof alwaysLoad !== 'boolean') throw new TypeError('alwaysLoad 要是 true 或 false')
    if (!Array.isArray(writesSegments) || writesSegments.some(name => typeof name !== 'string')) throw new TypeError('writesSegments 要是段名的数组')
    if (allow !== undefined && typeof allow !== 'function') throw new TypeError('allow 要是函数')
    if (links !== undefined && typeof links !== 'function') throw new TypeError('links 要是函数')
    return Object.freeze({
        audience, effect, destructive, alwaysLoad, writesSegments: Object.freeze([...writesSegments]),
        ...allow === undefined ? {} : { allow },
        ...links === undefined ? {} : { links },
    })
}

/**
 * @param deps.roleOf - 会话角色。
 * @param deps.headerOf - 会话的上游 header（会话不在内存里时为 `undefined`）。
 * @param deps.externalOf - 外部调用方会话的登记 `{ name, readOnly }`（不是外部调用方时为 `undefined`）。
 * @param deps.report - 报异常。
 */
export function createTools({ roleOf, headerOf, externalOf, report }) {
    const own = new Map()
    const upstream = new Map()
    const reported = new Set()
    const reportOnce = (key, detail) => {
        if (reported.has(key)) return
        reported.add(key)
        report(key.split(':')[0], detail)
    }

    /** 从 Agent（或会话编号）现算调用方。 */
    function caller({ agent, sessionId, plugin } = {}) {
        let id = sessionId ?? (agent?.session?.id === undefined ? undefined : String(agent.session.id))
        if (id === undefined) return { kind: 'program', plugin: String(plugin ?? 'unknown') }
        for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
            const header = depth === 0 && agent !== undefined ? agent.session.header : headerOf(id)
            if (header?.origin !== 'subagent' || header.parentSession === undefined) break
            id = String(header.parentSession)
        }
        const role = roleOf(id)
        // 体检令牌发起的调用带上标记（见 probe.js）。
        const probe = inProbe() ? { probe: true } : {}
        if (role === 'external') {
            const registration = externalOf(id)
            if (registration !== undefined) return { kind: 'external', name: registration.name, readOnly: registration.readOnly, ...probe }
            reportOnce(`core/unregistered-external:${id}`, { sessionId: id, text: `会话 ${id} 的角色是外部调用方，却找不到它的登记，按只读处理` })
            return { kind: 'external', name: id, readOnly: true, ...probe }
        }
        return { kind: 'session', sessionId: id, role, ...probe }
    }

    /** `allow` 不许抛错：抛了当"不允许"，报一次。 */
    function allows(name, meta, who) {
        if (meta?.allow === undefined) return true
        try {
            return meta.allow(who) === true
        } catch (error) {
            reportOnce(`core/allow-threw:${name}`, { text: `工具 ${name} 的 allow 抛错，按不允许处理（${error?.message ?? error}）`, data: { subject: name, tool: name } })
            return false
        }
    }

    /**
     * 注册一个工具（在调用方插件的上下文里注册，那个插件卸下时跟着撤）。
     * @param tools - 调用方上下文里的上游 `tools` 服务。
     * @param options.when - 另外的激活条件（和 `allow` 同时成立才出现）。
     */
    function register(tools, definition, meta, options = {}) {
        const name = definition?.name
        if (typeof name !== 'string' || name === '') throw new TypeError('工具要有 name')
        const normalized = normalizeMeta(meta)
        if (own.has(name)) throw new Error(`工具 ${name} 已经经核心注册过`)
        own.set(name, normalized)
        let withdraw
        try {
            withdraw = tools.register(definition, {
                when: async (activation) => {
                    if (!allows(name, normalized, caller({ agent: activation.agent }))) return false
                    return options.when === undefined ? true : await options.when(activation)
                },
            })
        } catch (error) {
            own.delete(name)
            throw error
        }
        return () => {
            if (own.get(name) === normalized) own.delete(name)
            withdraw()
        }
    }

    /** 登记上游工具的声明。 */
    function declareTool(name, meta) {
        if (typeof name !== 'string' || name === '') throw new TypeError('declareTool 需要工具名')
        upstream.set(name, normalizeMeta(meta))
    }

    /** 端点按它交工具：经核心注册的按自己的声明，上游的按登记；都没有的按默认值照交，报一次。 */
    function metaOf(name) {
        const meta = own.get(name) ?? upstream.get(name)
        if (meta !== undefined) return meta
        // 每个工具各是一条（subject 是工具名）：不写的话 Watchdog 把它们并成一条，只留最后一个名字。
        reportOnce(`core/undeclared-tool:${name}`, { text: `工具 ${name} 没有声明，按默认值照交（给所有执行方、算写操作）`, data: { subject: name, tool: name } })
        return DEFAULT_META
    }

    /** 这个 Agent 不许用的上游工具（登记里的 `allow` 说不行的，且这个 Agent 看得到它）。 */
    function deniedUpstream(agent, known) {
        const who = caller({ agent })
        return [...upstream.entries()].filter(([name, meta]) => known.has(name) && !allows(name, meta, who)).map(([name]) => name)
    }

    return Object.freeze({ caller, register, declareTool, metaOf, deniedUpstream, allows })
}
