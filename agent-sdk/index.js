/**
 * Claude Code 执行：把 Claude Code 注册为 DSH 的 `agent-sdk` 模型提供方。
 *
 * 会话在原生模型菜单选择 `agent-sdk` 的模型后，AgentLoop 照常执行并写日志，每次模型请求
 * 交给该会话常驻的 Claude Code 进程（官方 Agent SDK、DSH 自带程序、专用账号目录）。
 * 设计见仓库的 `docs/design.md`。
 *
 * @module @loveandbeepbrother/dsh-galatea-agent-sdk
 */

import net from 'node:net'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { AgentSdkAdapter, IMAGE_REMIND_BYTES, withExtraHooks } from './adapter.js'
import { createProcessParser, entrypointOf } from './transcript.js'
import { DEFAULT_HANDOFF_CHARS, QUOTA_SOURCE, SURFACE_SOURCE } from './plan.js'
import { QUOTA_DEFAULTS, USAGE_LIMIT, sessionAfter } from './quota.js'

export const name = 'agent-sdk-executor'
export const inject = ['llm', 'agents', 'storageDomain', 'tools', 'core']

/** 提供方路由名，出现在模型菜单与会话记录中。 */
export const ROUTE = 'agent-sdk'

/** 执行方自己放进会话的消息（自己开的一轮、额度恢复后的唤醒）是谁说的。 */
const SPEAKER = Object.freeze({ kind: 'program', plugin: 'agent-sdk-executor' })


/** 执行绑定：DSH 会话 → Claude Code 会话与已交给它的最后一条消息。 */
/**
 * 这里拉起的 Claude Code 进程服务哪个 DSH 会话：进程报出会话编号时写下，只追加，不覆盖，交接也不删。
 * 经历库读进程记录时按它归到 DSH 会话（这份记录自己的归属，不靠读取时绑定当下指着谁）。
 */
export const processesDomainSpec = defineDomain({
    name: 'galatea_agent_sdk_processes',
    version: 1,
    layout: 'per-record',
    tables: {
        processes: {
            valueSchema: z.object({ sessionId: z.string(), at: z.number() }).strict(),
        },
    },
})

export const bindingDomainSpec = defineDomain({
    name: 'galatea_agent_sdk',
    // 2：加上这段对话手里的会话开头上下文、自己改过还没换上的节与待交出的交接文档；旧记录没有这几项，照样能读。
    // 4（框架下的执行方）：会话开头上下文改由框架核心按对话键记版本，去掉 held、wrote，加上 conversation；
    // 失败的一轮带着的输入改由框架核心接住，去掉早先的 inflight、unanswered；
    version: 4,
    compatibleVersions: [],
    layout: 'per-record',
    tables: {
        bindings: {
            valueSchema: z.object({
                claudeSessionId: z.string().nullable(),
                lastMessageId: z.string().nullable(),
                updatedAt: z.number(),
                conversation: z.string().nullable().optional(),
                handoff: z.string().nullable().optional(),
                // 这段对话已经知道的 DSH 边界（压缩检查点的 compactionId）；表字段只增不删。
                knownBoundary: z.string().nullable().optional(),
            }).strict(),
        },
    },
})

/** 一个额度窗口的用量（占比 0–1）与重置时间。 */
const windowSchema = z.object({
    utilization: z.number().nullable(),
    resetsAt: z.number().nullable(),
    status: z.string().nullable(),
    at: z.number(),
}).strict()

/** 一个会话在一次额度用完里的积压记录。 */
const ledgerSchema = z.object({
    firstAt: z.number(),
    lastAt: z.number(),
    rejected: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    sources: z.array(z.string()),
    interrupted: z.array(z.object({ at: z.number(), cause: z.string() }).strict()),
    /**
     * 恢复后的唤醒：`pending` 待唤醒、`delivered` 已交出而这一轮还没完成、`answered` 恢复后答过、`failed` 被唤醒的那一轮没有正常结束、
     * `deferred` 不唤醒（后台思考）、`unavailable` 交不出去。
     */
    wake: z.enum(['pending', 'delivered', 'answered', 'failed', 'deferred', 'unavailable']).nullable(),
    wokeAt: z.number().nullable(),
    answeredAt: z.number().nullable(),
    /** 交过几次唤醒（第几次用第几个转交键）。 */
    attempts: z.number().int().nonnegative(),
    /** 恢复后核对时报过"没接上"的时间；没报过的没有这一项。 */
    reportedAt: z.number().optional(),
}).strict()

/** 额度闸门：只有一条记录 `gate`。 */
export const quotaDomainSpec = defineDomain({
    name: 'galatea_agent_sdk_quota',
    version: 1,
    layout: 'per-record',
    tables: {
        gate: {
            valueSchema: z.object({
                state: z.enum(['open', 'limited']),
                outageId: z.string().nullable(),
                since: z.number().nullable(),
                resetsAt: z.number().nullable(),
                rateLimitType: z.string().nullable(),
                model: z.string().nullable(),
                lastProbeAt: z.number().nullable(),
                probeVia: z.string().nullable(),
                windows: z.record(z.string(), windowSchema),
                backlog: z.record(z.string(), ledgerSchema),
                last: z.object({
                    outageId: z.string(),
                    since: z.number(),
                    recoveredAt: z.number(),
                    via: z.string(),
                    rateLimitType: z.string().nullable(),
                    resetsAt: z.number().nullable(),
                    sessions: z.record(z.string(), ledgerSchema),
                }).strict().nullable(),
                updatedAt: z.number(),
            }).strict(),
        },
    },
})


export const AUTH_MODES = Object.freeze(['api-key', 'existing-login'])

/**
 * 登录方式的问题（没有问题为 `null`）。必须在配置里明确选一种，没有默认值：
 * - `api-key`：用 `env` 里的 `ANTHROPIC_API_KEY`，按 API 计费；
 * - `existing-login`：用本机 Claude Code 已有的登录。
 * 没选或选了 `api-key` 却没给 key 时，执行方照样登记（模型菜单里看得到），但每一轮都失败并写明怎么改。
 */
export function authProblem(config) {
    if (config.auth === 'existing-login') return null
    if (config.auth === 'api-key') {
        return typeof config.env?.ANTHROPIC_API_KEY === 'string' && config.env.ANTHROPIC_API_KEY !== ''
            ? null
            : 'agent-sdk-executor 的 auth 是 api-key，但 env 里没有 ANTHROPIC_API_KEY：在 profile 里给 agent-sdk-executor 的 env 写上它。'
    }
    return 'agent-sdk-executor 还没选登录方式：在 profile 里给 agent-sdk-executor 写 auth: api-key（并在 env 里写 ANTHROPIC_API_KEY），'
        + '或 auth: existing-login（用本机 Claude Code 已有的登录）。'
}

/** 进程的环境：`api-key` 时去掉订阅登录的令牌，只按 API key 认证。 */
export function processEnv(base, config) {
    const env = { ...base, ...config.env }
    if (config.auth === 'api-key') delete env.CLAUDE_CODE_OAUTH_TOKEN
    return env
}

export const Config = Schema.object({
    auth: Schema.union(AUTH_MODES)
        .description('登录方式，必填、没有默认值：api-key 用 env 里的 ANTHROPIC_API_KEY（按 API 计费）；existing-login 用本机 Claude Code 已有的登录'),
    sdkEntry: Schema.string().default('')
        .description('官方 Agent SDK 入口（claude-agent-sdk/sdk.mjs 的路径）；空就用本包依赖装的 @anthropic-ai/claude-agent-sdk。版本决定 opus、sonnet 对应的模型'),
    defaultCwd: Schema.string().default('')
        .description('会话没有工作目录时使用的目录；空就是用户主目录'),
    permissionMode: Schema.union(['auto', 'dontAsk', 'acceptEdits', 'default']).default('auto'),
    effort: Schema.union(['low', 'medium', 'high', 'xhigh']).default('high')
        .description('推理强度；经设置覆盖层交给进程，不随共用的 Claude Code 配置目录变化'),
    models: Schema.array(Schema.object({
        id: Schema.string().required(),
        name: Schema.string().required(),
    })).default([
        { id: 'opus', name: 'Claude Opus（经 Agent SDK）' },
        { id: 'sonnet', name: 'Claude Sonnet（经 Agent SDK）' },
    ]),
    contextWindow: Schema.natural().default(1_000_000)
        .description('报告给 DSH 的上下文大小；Claude Code 自己管理上下文压缩'),
    handoffChars: Schema.natural().default(DEFAULT_HANDOFF_CHARS),
    idleMinutes: Schema.natural().default(30),
    backgroundHours: Schema.natural().default(6)
        .description('还有后台任务在跑时，进程空闲多久才关闭'),
    autoCompactWindow: Schema.natural().default(680_000)
        .description('Claude Code 自动压缩线（token），只作兜底；平时由助手按提醒自己决定何时压缩'),
    disallowedTools: Schema.array(Schema.string()).default([])
        .description('另外不给模型用的 Claude Code 自带工具（例如 Workflow、ScheduleWakeup、ReportFindings）；AskUserQuestion 总是不给'),
    pluginSkills: Schema.array(Schema.string()).required(false).default(undefined)
        .description('不填时不过滤 skill（和 Claude Code 一样）；填了只放行用户级 skill 目录里的全部，加上这里按名字列出的插件 skill'),
    transcriptDirectory: Schema.string().default('')
        .description('这里拉起的 Claude Code 进程写记录的目录（下面一层是各项目的子目录）；空为 CLAUDE_CONFIG_DIR 下的 projects'),
    imageRemindBytes: Schema.natural().default(IMAGE_REMIND_BYTES)
        .description('上次压缩以来进入上下文的图片累计到这么多字节（base64）时，在下一轮开头提醒助手压缩；0 不提醒'),
    mcpServers: Schema.dict(Schema.any()).default({})
        .description('另外给 Claude Code 挂的 MCP 服务器：名字 → 配置（写法同 Agent SDK 的 mcpServers）；名字 dsh 留给产品工具'),
    allowedTools: Schema.array(Schema.string()).default([])
        .description('另加的服务器里不用确认就能用的工具（如 mcp__chrome__take_snapshot）；其余照权限模式处理'),
    systemAppend: Schema.string().default('')
        .description('追加在系统提示末尾的说明（例如另加的工具怎么用）'),
    env: Schema.dict(Schema.string()).default({})
        .description('Claude Code 进程的环境变量，叠加在去掉凭据后的 Host 环境之上'),
    retry: Schema.object({
        maxRetries: Schema.natural().default(40),
        initialSeconds: Schema.natural().default(30),
        maxMinutes: Schema.natural().default(10),
    }).default({ maxRetries: 40, initialSeconds: 30, maxMinutes: 10 })
        .description('断网、短暂限流时 DSH 等多久再重试这一轮：间隔从 initialSeconds 起逐次加倍，最长 maxMinutes，共 maxRetries 次；额度用完不在此列'),
    quota: Schema.object({
        probeMinutes: Schema.natural().default(QUOTA_DEFAULTS.probeMinutes)
            .description('额度用完期间多久查一次恢复'),
        resetGraceSeconds: Schema.natural().default(QUOTA_DEFAULTS.resetGraceSeconds)
            .description('到了标注的恢复时间再等多少秒打开闸门、开始唤醒'),
        usageQuery: Schema.boolean().default(QUOTA_DEFAULTS.usageQuery)
            .description('先经 SDK 的用量查询看额度（不经模型）'),
        modelProbe: Schema.boolean().default(QUOTA_DEFAULTS.modelProbe)
            .description('用量查询不可用时，用被拒的模型发一次最小请求查恢复'),
        usagePollMinutes: Schema.natural().default(QUOTA_DEFAULTS.usagePollMinutes)
            .description('额度正常时经在跑的 Claude Code 进程查用量的间隔（给提前提醒用）；0 不查'),
        wakeTurnMinutes: Schema.natural().default(QUOTA_DEFAULTS.wakeTurnMinutes)
            .description('恢复后唤醒一个会话，最多等它这一轮多久再唤醒下一个'),
        wakeAttempts: Schema.natural().default(QUOTA_DEFAULTS.wakeAttempts)
            .description('一个会话最多唤醒几次（被唤醒的那一轮没有正常结束、或 Host 重启后还没答过时再交）'),
        verifyMinutes: Schema.natural().default(QUOTA_DEFAULTS.verifyMinutes)
            .description('恢复后多久核对：有积压的会话到那时还没回过一轮，报 agent-sdk/wake-unanswered'),
    }).default({ ...QUOTA_DEFAULTS })
        .description('额度用完：闸门、查恢复与恢复后的唤醒'),
})

/** 用户级 skill 目录里不算助手 skill 的子目录：claude.ai 同步下来的。 */
const SYNCED_SKILLS = 'synced'

/**
 * 助手能用的 skill：`<CLAUDE_CONFIG_DIR>/skills` 下每个含 SKILL.md 的直接子目录（跟随目录联接与符号链接，`synced` 除外），
 * 加上按名字放行的插件 skill。目录读不了时只有插件 skill。
 * @param configDir - Claude Code 的配置目录；没有设时取 `~/.claude`。
 */
export function visibleSkills(configDir, pluginSkills, logger) {
    const root = join(configDir || join(homedir(), '.claude'), 'skills')
    let own = []
    try {
        own = readdirSync(root)
            .filter(name => name !== SYNCED_SKILLS && existsSync(join(root, name, 'SKILL.md')))
            .sort()
    } catch (error) {
        if (error?.code !== 'ENOENT') logger?.warn?.(`galatea-agent-sdk: 读不了 skill 目录 ${root}：${error?.message ?? error}`)
    }
    return [...own, ...pluginSkills.filter(name => !own.includes(name))]
}

/** 探测出口用的地址：Claude Code 的 API 入口。 */
export const PROBE_HOST = 'api.anthropic.com'

/**
 * 经 `env` 里的代理与 `PROBE_HOST` 完成一次 TLS 握手，成功即算出口已通。没有配置代理时不探测。
 * 代理对 CONNECT 总是先答 200，所以必须等到握手完成才知道远端连上了。
 */
export function probeEgress(env, { timeoutMs = 15_000, signal } = {}) {
    const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY
    if (!raw) return Promise.resolve(true)
    if (signal?.aborted) return Promise.resolve(false)
    let proxy
    try {
        proxy = new URL(raw)
    } catch {
        return Promise.resolve(true)
    }
    return new Promise((resolve) => {
        let socket
        let secure
        const finish = (ok) => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            secure?.destroy()
            socket?.destroy()
            resolve(ok)
        }
        const onAbort = () => finish(false)
        const timer = setTimeout(() => finish(false), timeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        socket = net.connect(Number(proxy.port || 80), proxy.hostname)
        socket.once('error', () => finish(false))
        socket.once('connect', () => socket.write(`CONNECT ${PROBE_HOST}:443 HTTP/1.1\r\nHost: ${PROBE_HOST}:443\r\n\r\n`))
        let head = ''
        const onData = (chunk) => {
            head += chunk.toString('latin1')
            if (!head.includes('\r\n\r\n')) return
            socket.off('data', onData)
            if (!/^HTTP\/1\.[01] 200/.test(head)) return finish(false)
            secure = tls.connect({ socket, servername: PROBE_HOST })
            secure.once('secureConnect', () => finish(true))
            secure.once('error', () => finish(false))
        }
        socket.on('data', onData)
    })
}

/**
 * 额度闸门的快照换成核心的通用形状（`quotaGate.detail`）：`window` 是用完的那个窗口（Claude 叫 rateLimitType），
 * `windows` 每个窗口只给用量占比和重置时间。状态不在这里给，核心从 `state` 取。
 */
export function quotaDetailOf(snapshot) {
    const windows = Object.fromEntries(Object.entries(snapshot?.windows ?? {})
        .filter(([, window]) => typeof window?.utilization === 'number')
        .map(([type, window]) => [type, { utilization: window.utilization, resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt : null }]))
    return {
        since: snapshot?.since ?? null,
        resetsAt: snapshot?.resetsAt ?? null,
        window: snapshot?.rateLimitType ?? null,
        outageId: snapshot?.outageId ?? null,
        windows,
    }
}

/** 产品工具在 Claude Code 里的 MCP 服务器名；配置里另加的服务器不能用它。 */
export const PRODUCT_SERVER = 'dsh'

export function apply(ctx, config) {
    // 另加的服务器和产品工具重名会把产品工具顶掉：启动就报错，不静默覆盖。
    if (Object.hasOwn(config.mcpServers ?? {}, PRODUCT_SERVER)) {
        throw new Error(`galatea-agent-sdk: mcpServers 里不能有名为 ${PRODUCT_SERVER} 的服务器，这个名字留给框架的产品工具；请改名`)
    }
    let sdk
    let domain
    let quotaDomain
    // 首次请求时才加载 SDK 与打开存储域，Host 启动不等待它们。
    let ready
    const ensureReady = () => {
        ready ??= Promise.all([
            import(config.sdkEntry === '' ? '@anthropic-ai/claude-agent-sdk' : pathToFileURL(config.sdkEntry).href).then((module) => { sdk = module }),
            ctx.storageDomain.open(bindingDomainSpec).then((opened) => { domain = opened }),
            ctx.storageDomain.open(quotaDomainSpec).then((opened) => { quotaDomain = opened }),
        ]).catch((error) => {
            ready = undefined
            throw error
        })
        return ready
    }
    const table = () => domain.table('bindings')
    // 进程归属表：启动时开始打开、不等它；用的地方等这个 Promise。
    const processesOpened = ctx.storageDomain.open(processesDomainSpec)
    ctx.effect(() => () => {
        processesOpened.then(opened => opened.close?.(), () => {})
    }, 'agent-sdk-executor: processes domain')
    const processes = async () => (await processesOpened).table('processes')
    function noteProcess(sessionId, claudeSessionId) {
        processes().then((table) => {
            if (table.get(claudeSessionId) !== undefined) return
            return table.put(claudeSessionId, { sessionId: String(sessionId), at: Date.now() })
        }).catch(error => ctx.logger?.warn?.(`galatea-agent-sdk: 进程归属没记下（${claudeSessionId} → ${sessionId}）：${error?.message ?? error}`))
    }
    const attachments = () => {
        const store = ctx.get('attachments')
        if (store === undefined) throw new Error('galatea-agent-sdk: 当前组合没有附件服务，无法转交图片')
        return store
    }

    // 别的插件给 Claude Code 进程另加钩子：服务 `agentSdk.addHooks(sessionId => ({ 事件名: [匹配项] }))`，交回注销函数；
    // 下一次打开进程时生效。本包自己不挂这类钩子。
    const hookProviders = new Set()
    ctx.provide('agentSdk', {
        addHooks(provider) {
            if (typeof provider !== 'function') throw new TypeError('addHooks 要一个函数：sessionId => 钩子')
            hookProviders.add(provider)
            return () => hookProviders.delete(provider)
        },
    })
    const adapter = new AgentSdkAdapter(config.defaultCwd === '' ? { ...config, defaultCwd: homedir() } : config, {
        ready: ensureReady,
        extraHooks: sessionId => [...hookProviders].reduce((hooks, provider) => withExtraHooks(hooks, provider(sessionId)), {}),
        loadSdk: () => sdk,
        bindings: {
            get: sessionId => table().get(sessionId),
            put: (sessionId, record) => table().put(sessionId, record),
        },
        cwdOf: sessionId => ctx.agents.get(sessionId)?.session?.header?.cwd,
        noteProcess,
        readImage: (ref, target, signal) => attachments().readImageRequest(ref, target, signal),
        imagePath: ref => attachments().imageHostPath(ref),
        // 产品工具经核心的工具端点交：哪些交、谁能调、只读、发起者都在核心那一侧。
        toolEndpoint: sessionId => ctx.core.toolEndpoint.open(sessionId),
        closeToolEndpoint: token => ctx.core.toolEndpoint.close(token),
        // Claude Code 自己开的一轮：经框架核心唯一的入口放进会话，回复往哪去照会话的规矩。
        surface: async (sessionId, { key, text }) => {
            const result = await ctx.core.deliver(sessionId, { key, text, source: { kind: SURFACE_SOURCE, key }, speaker: SPEAKER })
            if (result.status === 'unavailable') throw new Error(`自己开的一轮没交进会话：${result.reason}`)
        },
        env: () => processEnv(scrubbedParentEnv(), config),
        authProblem: () => authProblem(config),
        // 每次打开进程时现读：用户新装的 skill 下一个进程就能用。
        skills: () => (config.pluginSkills === undefined ? undefined : visibleSkills(config.env.CLAUDE_CONFIG_DIR, config.pluginSkills, ctx.logger)),
        // 去节点那一段偶尔丢包，单次握手可能失败：连探两次都不通才算出口不通。
        reachable: async (signal) => {
            const env = processEnv(scrubbedParentEnv(), config)
            return await probeEgress(env, { signal }) || probeEgress(env, { signal })
        },
        readText: path => readFile(path, 'utf8'),
        writeText: (path, text) => writeFile(path, text, 'utf8'),
        // Claude Code 压缩过以后，请框架的上下文模块在 DSH 记录里落边界（没装上下文模块时不落）。
        land: (sessionId, options) => ctx.get('context')?.land?.(sessionId, { ...options, by: ROUTE }) ?? { landed: false, reason: '没装框架的上下文模块' },
        // 交接后的新对话开头带的最近几轮原文（算法在框架的上下文模块；没装时不带）。
        recentTurns: (sessionId, options) => ctx.get('context')?.recentTurns?.(sessionId, options) ?? '',
        // 额度闸门：存在自己的存储域里；恢复后经框架核心的入口唤醒有积压的会话；变化时交给消息渠道发不经模型的提示。
        quotaStore: {
            load: () => quotaDomain?.table('gate').get('gate'),
            save: record => quotaDomain?.table('gate').put('gate', record),
        },
        // 额度恢复后先唤醒中枢；后台会话不唤醒（按角色，不按来源名）。
        mainSessionId: () => ctx.core.sessions.hub() ?? undefined,
        // 给用户看的时间按框架核心的时区写（不读进程环境）。
        timezone: () => ctx.core.timezone,
        roleOf: sessionId => ctx.core.sessions.roleOf(sessionId),
        wake: (sessionId, { key, text }) => ctx.core.deliver(sessionId, { key, text, source: { kind: QUOTA_SOURCE, key }, speaker: SPEAKER }),
        // 恢复后核对没接上的会话，经框架核心报出来（Watchdog 收）。
        report: (kind, detail) => ctx.core.report(kind, detail),
        // Host 重启后判断已交出的唤醒：按会话里的实际事件（恢复后有没有正常结束的一轮、唤醒的话在不在、最后一轮结束没有）。
        sessionState: async (sessionId, { since, marker }) => {
            const query = ctx.get('sessionQuery')
            if (typeof query?.observeSession !== 'function') return null
            let observation
            try {
                observation = await query.observeSession(sessionId, { projectionMode: 'none' })
                return sessionAfter([...observation.events ?? []], { since, marker })
            } catch {
                return null
            } finally {
                try {
                    observation?.[Symbol.dispose]?.() ?? observation?.dispose?.()
                } catch {
                    // 只读观察的释放失败不影响结论。
                }
            }
        },
        // 提问还是参考由框架核心认，执行方不维护来源表。
        classify: message => ctx.core.classify(message),
        attachments: sessionId => ctx.core.attachments(sessionId),
        sourceAudience: message => ctx.core.sourceAudience(message),
        // 会话开头上下文由框架核心的上下文段给：开新对话、续接、每轮的变更说明、压缩后补发。
        segments: {
            open: (conversation, sessionId) => ctx.core.segments.open(conversation, sessionId),
            changes: (conversation, sessionId, options) => ctx.core.segments.changes(conversation, sessionId, options),
        },
        logger: ctx.logger,
    })

    // 执行方自己放进会话的两种消息：是提问（要模型作答），正文开头已经写明是系统转交，不用核心再标。
    ctx.effect(() => ctx.core.declareSource(SURFACE_SOURCE, { intent: 'prompt', annotate: false, speaker: SPEAKER }), 'agent-sdk-executor: surface source')
    ctx.effect(() => ctx.core.declareSource(QUOTA_SOURCE, { intent: 'prompt', annotate: false, speaker: SPEAKER }), 'agent-sdk-executor: quota source')
    // 登记成执行方：模型路由是 agent-sdk 的会话归它。能力的值就是实现：换新对话、用量、主动压缩、
    // 兜底压缩线给框架的上下文模块调（核心六，交接、压缩两个工具由它注册）；额度闸门在这里，核心按它答 quota.state，
    // 额度用完（USAGE_LIMIT）的一轮不算失败，由闸门恢复后唤醒。没有中途插话（steer）：附提醒等下一轮。
    // 经历库在时，把这里拉起的 Claude Code 进程记录注册成它的一个来源：只收发给别的会话的消息、
    // 压缩边界和操作（其余已在 DSH 会话事件里），放进这个进程服务的 DSH 会话。记录格式由执行方自己认（transcript.js），按行读文件用经历库的 parsers.readLines。
    // 归哪个 DSH 会话查进程归属表（进程报出会话编号时写下）；入口是 cli 的是用户直接运行的 Claude Code，不归这里；
    // 程序拉起的、表里查不到的不猜，报一次。
    ctx.inject(['experience'], (sub) => {
        const { parsers } = sub.experience
        const source = sub.experience.registerSource({
            id: 'agent-sdk-process',
            label: 'DSH 里的 Claude Code 进程',
            category: 'dsh',
            pull: async (cursor) => {
                const files = { ...cursor?.files ?? {} }
                const owners = await processes()
                const entries = []
                const ops = []
                const root = config.transcriptDirectory || (config.env.CLAUDE_CONFIG_DIR ? join(config.env.CLAUDE_CONFIG_DIR, 'projects') : '')
                let projects = []
                if (root !== '') {
                    try {
                        projects = (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory())
                    } catch (error) {
                        if (error?.code !== 'ENOENT') throw error
                    }
                }
                for (const project of projects) {
                    for (const file of await readdir(join(root, project.name))) {
                        if (!file.endsWith('.jsonl')) continue
                        const claudeSessionId = file.slice(0, -'.jsonl'.length)
                        const path = join(root, project.name, file)
                        const before = files[path] ?? { offset: 0, size: -1 }
                        if (before.cli === true) continue
                        const { size } = await stat(path)
                        const thread = owners.get(claudeSessionId)?.sessionId
                        // 大小没变就不再扫；报过查不到归属的，归属表后来补上了照样从头收（进程可能已经结束，文件不会再变）。
                        if (before.size === size && !(before.unmapped === true && thread !== undefined)) continue
                        if (thread === undefined) {
                            const entry = await entrypointOf(path)
                            if (entry === 'cli') files[path] = { cli: true }
                            else if (entry !== undefined) {
                                // 查不到归属的程序记录（例如别的插件拉起的进程，归属表里本来就没有）不猜它属于哪个会话：报一次，
                                // 把当时的大小记进读取位置，之后文件不变就不再报、不再扫（重启也一样）；有了新内容再判断一次。
                                ctx.core.report('experience/unmapped-transcript', { text: `Claude Code 进程记录 ${path} 在进程归属表里查不到服务哪个 DSH 会话，没收进经历库`, data: { file: path } })
                                files[path] = { offset: before.offset ?? 0, size, unmapped: true }
                            }
                            continue
                        }
                        const parser = createProcessParser({ claudeSessionId })
                        const { end } = await parsers.readLines(path, before.offset, (line, offset) => parser.line(line, offset))
                        const result = parser.finish(end)
                        entries.push(...result.entries.map(item => ({ ...item, thread, part: path })))
                        ops.push(...result.ops.map(op => ({ ...op, thread, part: path })))
                        files[path] = { offset: result.resume.offset, size }
                    }
                }
                return { entries, ops, cursor: { files } }
            },
        })
        sub.effect(() => () => source.dispose(), 'agent-sdk-executor: experience source')
    })

    ctx.core.executors.register({
        id: 'agent-sdk',
        handles: selection => selection?.provider === ROUTE,
        required: {
            runTurn: true, openingSegments: true, perTurnContext: true, toolEndpoint: true, interrupt: true,
            newConversation: (sessionId, document, options) => adapter.handoff(String(sessionId), document, options),
            usage: sessionId => adapter.usageOf(String(sessionId)),
        },
        optional: {
            resume: true,
            compact: (sessionId, options) => adapter.compact(String(sessionId), options),
            // Claude Code 的 /compact 收要保留什么的说明。
            compactInstructions: true,
            resendAfterCompaction: true,
            fallbackThreshold: { set: tokens => adapter.setFallbackThreshold(tokens) },
            endCheck: true,
            surface: true,
            skillFilter: true,
            imageAccounting: true,
            // 会话的活动：还在跑的后台任务数、进程最后一次输出的时间；Watchdog 经核心问，看项目任务是不是真的没在动。
            activity: (sessionId) => {
                const { background, lastOutputAt } = adapter.activity(String(sessionId))
                return { background, lastOutputAt }
            },
            // 额度现状：状态只从 state 来；detail 给出口说额度用完、用量提醒要的补充字段（核心的通用形状）。
            // 执行方不再去调消息渠道：渠道自己在一轮结束和定时器上看（执行方不依赖渠道）。
            quotaGate: { state: () => (adapter.quota.limited() ? 'limited' : 'ok'), codes: [USAGE_LIMIT], detail: () => quotaDetailOf(adapter.quota.snapshot()) },
            // DSH 记录里落下的边界：是这段对话已经知道的内容就记下，之后以它为锚续接（交过的最后一条被它换掉时）。
            boundary: { landed: (sessionId, info) => adapter.boundaryLanded(String(sessionId), info) },
            // 切到别的执行方、历史放不下时，先在这段对话里跑一轮看不见的交接（框架的压缩引擎调）。
            handoffTurn: (sessionId, options) => adapter.handoffTurn(String(sessionId), options),
        },
    })

    // 登录方式没选对：启动时报一次（每一轮也会照这个失败）。
    const unauthenticated = authProblem(config)
    if (unauthenticated !== null) ctx.core.report('agent-sdk/auth-unset', { text: unauthenticated })

    ctx.effect(() => {
        const registration = ctx.llm.registerAdapter([ROUTE], adapter)
        // 额度闸门在 Host 启动时就读出：上次停在额度用完时立即开始查恢复，上次唤醒没做完的接着做。
        const start = setTimeout(() => {
            ensureReady().then(() => adapter.quota.load())
                .catch(error => ctx.logger?.warn?.(`galatea-agent-sdk: 额度闸门没读出来：${error?.message ?? error}`))
        }, 0)
        start.unref?.()
        return () => {
            clearTimeout(start)
            registration()
            adapter.close()
            domain?.close?.()
            quotaDomain?.close?.()
        }
    }, 'galatea-agent-sdk: adapter')
}
