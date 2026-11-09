/**
 * 记忆与人格框架的核心：提供服务 `core`。
 *
 * 这一版有：异常出口 `report` / `onReport`、会话角色 `sessions`、消息出处 `provenance`、消息入口 `deliver`、
 * 分类与来源标注 `classify` / `declareSource`、一轮的回复去向 `turnRoute`、一轮的结果 `outcomeOf`、
 * 附提醒 `attach` / `detach` / `pending` / `attachments`（含失败的一轮带着的输入）、上下文段 `segment` / `segments`
 * （附提醒在原生是其中一个段）、调用方 `caller` 与工具声明 `tool` / `declareTool` / `toolMeta`、工具端点 `toolEndpoint`、
 * 外部调用方的登记 `external`（登记、作废只走主人的设置页路由）、内容库 `content`、执行方 `executors` 与额度状态 `quota.state`。
 *
 * 认会话的输入只在一处：`agent/pre-step`。这里依次写出处、给这一步的消息分类并加来源标注，
 * 一轮第一步时还记下开启这一轮的消息和这一轮的回复去向。
 *
 * `core` 是一个 cordis Service：别的插件调 `report` 时，`this.ctx` 是调用方自己的上下文，
 * 所以知道是哪个插件报的，不用另传参数。存储先打开再提供服务，`sessions.hub()` 这类同步读一开始就能用。
 *
 * @module @loveandbeepbrother/dsh-galatea/core
 */

import { homedir } from 'node:os'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { createAttachments, turnsDomainSpec } from './attach.js'
import { createClassifier } from './classify.js'
import { createDeliver } from './deliver.js'
import { createContent } from './content.js'
import { createEndpoint } from './endpoint.js'
import { createExecutors, executorsDomainSpec } from './executors.js'
import { createExternal, externalDomainSpec, registerExternalRoutes } from './external.js'
import { outcomeFromEvents } from './outcome.js'
import { createProvenance } from './provenance.js'
import { createExits, createQuietHours, resolveTimezone } from './quiet.js'
import { createReports } from './report.js'
import { createSegments, segmentsDomainSpec } from './segments.js'
import { recordRoute, routeFromEvents, routeOf, triggerOf } from './routes.js'
import { createSessions, sessionsDomainSpec } from './sessions.js'
import { arrivalText } from './time.js'
import { UPSTREAM_NATIVE_ONLY_TOOLS, UPSTREAM_SHARED_TOOLS, createTools } from './tools.js'
import { STARTER_FILES } from '../starter.js'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'

/** 定中枢的命令名：用户在要作中枢的会话里输入 `/hub`。 */
export const HUB_COMMAND = 'hub'

export const name = 'mind-framework-core'
export const inject = ['storageDomain', 'sessionQuery', 'sessions', 'agents', 'systemPrompt', 'tools']

/** 原生把还没交到的附提醒交给模型的段（别的执行方按 `attachments` 自己交）。 */
export const ATTACHMENTS_SEGMENT = 'mind-framework-attachments'

/** 本插件提供的服务名（暂定）。 */
export const SERVICE = 'core'

/** 调用方上下文所属的插件。 */
function callerOf(ctx) {
    return { kind: 'program', plugin: String(ctx?.fiber?.name ?? 'unknown') }
}

class Core extends Service {
    constructor(ctx, parts) {
        super(ctx, SERVICE)
        this._parts = parts
    }

    get sessions() {
        return this._parts.sessions
    }

    get provenance() {
        return this._parts.provenance
    }

    /** 报一条异常，见 `report.js`。 */
    report(kind, detail) {
        this._parts.reports.report(kind, detail, callerOf(this.ctx))
    }

    /** 接收异常，见 `report.js`。 */
    onReport(consumer, options) {
        return this._parts.reports.onReport(consumer, options)
    }

    /** 某个时刻以后、没有消费方接手的异常，按类别归并，见 `report.js`。 */
    unhandledReports(since) {
        return this._parts.reports.unhandled(since)
    }

    /** 把一条消息放进会话，见 `deliver.js`。 */
    deliver(to, message) {
        return this._parts.deliver(to, message)
    }

    /** 认一条消息是提问还是参考，见 `classify.js`。 */
    classify(message, options) {
        return this._parts.classifier.classify(message, options)
    }

    /** 这条消息给哪些执行方（`all` / `native-only`），见 `classify.js`。 */
    sourceAudience(message) {
        return this._parts.classifier.audienceOf(message)
    }

    /** 替一个 kind 登记声明，见 `classify.js`。 */
    declareSource(kind, declaration) {
        return this._parts.classifier.declareSource(kind, declaration)
    }

    /** 一个会话的全部日志事件（会话不存在时为空数组）。 */
    readEvents(sessionId) {
        return this._parts.readEvents(String(sessionId))
    }

    /** 某个会话某一轮的结果：回复、不发、等待；没有正常完成的轮为 `null`，见 `outcome.js`。 */
    async outcomeOf(sessionId, turn) {
        return outcomeFromEvents(await this._parts.readEvents(String(sessionId)), turn)
    }

    /** 给会话附一条提醒，下一轮交给模型，见 `attach.js`。 */
    attach(sessionId, key, text, options) {
        return this._parts.attachments.attach(sessionId, key, text, options)
    }

    detach(sessionId, key) {
        return this._parts.attachments.detach(sessionId, key)
    }

    pending(sessionId, key) {
        return this._parts.attachments.pending(sessionId, key)
    }

    /** 这个会话还没交到的提醒（执行方按它交给模型）。 */
    attachments(sessionId, options) {
        return this._parts.attachments.list(sessionId, options)
    }

    /**
     * 登记一个上下文段，见 `segments.js`。段跟着登记它的插件：那个插件卸下时自动撤销。
     * @returns 提前撤销。
     */
    segment(definition) {
        return this.ctx.effect(() => this._parts.segments.segment(definition), `mind-framework-core: segment ${definition?.name}`)
    }

    /** 调用方：从 `exec.agent` 所在的会话现算，见 `tools.js`。 */
    caller(exec) {
        return this._parts.tools.caller({ agent: exec?.agent, plugin: this.ctx?.fiber?.name })
    }

    /**
     * 注册一个工具，`allow` 等声明见 `tools.js`。工具跟着注册它的插件：那个插件卸下时自动撤销。
     * @returns 提前撤销。
     */
    tool(definition, meta, options) {
        const tools = this.ctx.get('tools')
        return this.ctx.effect(() => this._parts.tools.register(tools, definition, meta, options), `mind-framework-core: tool ${definition?.name}`)
    }

    /** 登记上游工具的声明（给谁、读还是写、谁能用）。 */
    declareTool(name, meta) {
        this._parts.tools.declareTool(name, meta)
        this._parts.reapplyRestrictions()
    }

    /** 一个工具的声明；没有声明的按默认值，并报一次。 */
    toolMeta(name) {
        return this._parts.tools.metaOf(name)
    }

    /** 工具端点：`open(sessionId, {readOnly})` 发 `{url, token}`，`close(token)` 作废，见 `endpoint.js`。 */
    get toolEndpoint() {
        // address：外部入口写发现文件用。
        const { open, close, address } = this._parts.endpoint
        return { open, close, address }
    }

    /** 执行方：`register`（跟着登记它的插件撤）、`executorOf`、`executorFor`、`has`、`list`，见 `executors.js`。 */
    get executors() {
        // gatedFailure：这一轮以这个错误码结束，是不是执行方额度闸门管的那种（持续工作据此等额度恢复再推，不算出错）。
        // activity：会话里还在跑的后台任务数、进程最后一次输出的时间（执行方的可选能力，Watchdog 看任务有没有活动用）。
        const { executorOf, executorFor, has, list, provideNative, gatedFailure, activity } = this._parts.executors
        // executorOf、has 是异步的：归属读的是会话持久的模型选择。executorFor 按给的模型选择现答（切模型时新旧各问一次）。
        const register = definition => this.ctx.effect(() => this._parts.executors.register(definition), `mind-framework-core: executor ${definition?.id}`)
        return { register, executorOf, executorFor, has, list, provideNative, gatedFailure, activity }
    }

    /**
     * 额度状态：按这个会话的执行方作答，没有额度闸门的答 `unknown`（读的一方当成"可以继续"）。
     * `detail` 另交补充的字段 `{ since, resetsAt, window, outageId, windows }`（没有的是 null），见 `executors.js`。
     */
    get quota() {
        return {
            state: sessionId => this._parts.executors.quotaState(sessionId),
            detail: sessionId => this._parts.executors.quotaDetail(sessionId),
        }
    }

    /** 内容库：`read`、`list`、`write`、`prepare`，见 `content.js`。内容目录明写成空时调用会抛错。 */
    get content() {
        const content = this._parts.content
        if (content !== undefined) return content
        const missing = () => Promise.reject(new Error('核心没有配置内容目录（contentDirectory），内容库不可用'))
        return { read: missing, list: missing, write: missing, prepare: missing, root: null }
    }

    /** 外部调用方：只开放 `list`（登记、作废只走主人的设置页路由），见 `external.js`。 */
    /** 给用户和模型看的时间用的时区（IANA 名），见配置 `timezone`。只有核心这一份。 */
    get timezone() {
        return this._parts.timezone
    }

    /** 休息时段：`inQuiet(at?)`、`nextEnd(at?)`、`describe()`、`config`，见 `quiet.js`。只有核心这一份。 */
    get quietHours() {
        return this._parts.quietHours
    }

    /** 出口登记：`register`（跟着登记它的插件撤）、`servedBy`、`foreground`、`list`、`notify`、`sentBetween`，见 `quiet.js`。 */
    get exits() {
        const { servedBy, foreground, list, notify, sentBetween } = this._parts.exits
        const register = definition => this.ctx.effect(() => this._parts.exits.register(definition), `mind-framework-core: exit ${definition?.id}`)
        return { register, servedBy, foreground, list, notify, sentBetween }
    }

    get external() {
        const { list } = this._parts.external
        return { list }
    }

    /** 给执行方用的：`open`、`changes`、`declareSegment`、`audienceOf`；给体检用的 `preview`，见 `segments.js`。 */
    get segments() {
        const { open, preview, changes, declareSegment, audienceOf } = this._parts.segments
        return { open, preview, changes, declareSegment, audienceOf }
    }

    /** 某个会话某一轮的回复去向 `{ turn, trigger, route }`，没有记录时为 `null`，见 `routes.js`。 */
    async turnRoute(sessionId, turn) {
        return routeFromEvents(await this._parts.readEvents(String(sessionId)), turn)
    }
}

/**
 * @param config.endpointPort - 工具端点听的本机端口，默认由系统挑一个空的。
 * @param config.externalCwd - 外部调用方会话的工作目录（用户的内容目录），默认是用户主目录。
 * @param config.contentDirectory - 内容库的根目录（用户自己的内容目录）；不给就用 DSH home 下的 `galatea/content`，明写成空串就没有内容库。
 * @param config.starter - `false` 时新建的内容库里不写起步模板（测试用）；默认写人格、长期认知、后台思考三份中性模板。
 * @param config.contentAuthor - 助手提交的作者名，默认"助手"。
 * @param config.timezone - 给用户和模型看的时间按哪个时区写（IANA 名，例如 Asia/Shanghai）；不给就用本机时区。各插件经 `core.timezone`
 *   读这一项，不各自写死或读进程环境（Host 进程的 TZ 可能是为别的用途设的）。
 * @param config.quietHours - 休息时段 `{ start, end, timezone }`，默认 00:00–08:00；时区不写就跟 `timezone` 走。
 * @param config.toolDeclarations - 不认识框架的插件（比如开源的语音包）注册的工具的声明 `{ 工具名: { effect, alwaysLoad, … } }`，
 *   由 profile 写，核心照上游工具一样登记。
 * @param deps.logger - 测试用：换掉 Host 日志。
 * @param deps.git - 测试用：换掉 Git 命令。
 * @param deps.startupSettled - 测试用：换掉"启动完成"的信号（默认等 Loader 把配置里的插件都装好）。
 * @param deps.dshHome - 测试用：换掉 DSH 运行数据根（没有中枢时给的命令里写它）。
 */
export async function apply(ctx, config = {}, deps = {}) {
    // 内容目录：没配就用 DSH home 下的 galatea/content；明写成空串是"不要内容库"。
    // 经历库、发现文件这些运行时的数据放在上一层 galatea/，不进用户的内容库（内容库是 git 仓库，数据库进去就跟着提交）。
    const contentRoot = config?.contentDirectory === undefined
        ? (deps.dshHome === undefined ? dshHomePath('galatea', 'content') : `${deps.dshHome}/galatea/content`)
        : (config.contentDirectory || null)
    // 存储域在插件卸下时关掉，并等它关完：同一进程里重新装上核心时才能再打开。
    const domain = await ctx.storageDomain.open(sessionsDomainSpec)
    ctx.effect(() => () => domain.close?.(), 'mind-framework-core: sessions domain')
    const turnsDomain = await ctx.storageDomain.open(turnsDomainSpec)
    ctx.effect(() => () => turnsDomain.close?.(), 'mind-framework-core: turns domain')
    const externalDomain = await ctx.storageDomain.open(externalDomainSpec)
    ctx.effect(() => () => externalDomain.close?.(), 'mind-framework-core: external domain')
    const segmentsDomain = await ctx.storageDomain.open(segmentsDomainSpec)
    ctx.effect(() => () => segmentsDomain.close?.(), 'mind-framework-core: segments domain')
    const executorsDomain = await ctx.storageDomain.open(executorsDomainSpec)
    ctx.effect(() => () => executorsDomain.close?.(), 'mind-framework-core: executors domain')

    const reports = createReports(deps.logger ?? ctx.logger)
    const selfReport = (kind, detail) => reports.report(kind, detail, { kind: 'program', plugin: name })

    /** 一个会话的全部日志事件；只要事件，不算投影。 */
    async function readEvents(sessionId) {
        let observation
        try {
            observation = await ctx.sessionQuery.observeSession(SessionId(sessionId), { projectionMode: 'none' })
        } catch (error) {
            if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return []
            throw error
        }
        try {
            return [...observation.events]
        } finally {
            try {
                observation?.[Symbol.dispose]?.() ?? observation?.dispose?.()
            } catch {
                // 只读观察的释放失败不影响结论。
            }
        }
    }

    /** 会话不在内存里就经上游公开的 `sessionController.resolveAgent` 恢复；它不抛错，交回 `{agent}` 或 `{error}`。 */
    async function resolveAgent(sessionId) {
        const live = ctx.agents.get(SessionId(sessionId))
        if (live !== undefined) return live
        const controller = ctx.get('sessionController')
        if (controller === undefined) throw new Error('会话不在内存里，而当前组合没有 sessionController 可以恢复它')
        const found = await controller.resolveAgent(SessionId(sessionId))
        if ('error' in found) throw found.error
        return found.agent
    }

    const sessions = createSessions(domain, {
        headerOf: id => ctx.agents.get(SessionId(id))?.session?.header,
        workspaces: () => ctx.get('workspaceRegistry')?.list() ?? [],
        excludedRoot: contentRoot,
    })
    const provenance = createProvenance({ readEvents })
    const classifier = createClassifier({ report: selfReport, hub: () => sessions.hub(), roleOf: id => sessions.roleOf(id) })
    const timezone = resolveTimezone(config?.timezone)
    const attachments = createAttachments(turnsDomain, {
        readEvents,
        timezone,
        report: selfReport,
        gatedFailure: (sessionId, code) => executors.gatedFailure(sessionId, code),
    })
    const segments = createSegments(segmentsDomain, {
        systemPrompt: ctx.systemPrompt,
        report: selfReport,
        roleOf: id => sessions.roleOf(id),
    })
    ctx.effect(() => segments.segment({
        name: ATTACHMENTS_SEGMENT,
        order: 9_800,
        audience: 'native-only',
        text: ({ sessionId }) => {
            const items = attachments.list(sessionId)
            return items.length === 0 ? '' : ['还没交到的提醒（这一轮正常结束才算交到）：', ...items.map(item => item.text)].join('\n\n')
        },
    }), 'mind-framework-core: attachments segment')
    ctx.on('system-prompt/assemble', (_assembly, context, next) => segments.assemble(context, next))
    let external
    const tools = createTools({
        roleOf: id => sessions.roleOf(id),
        headerOf: id => ctx.agents.get(SessionId(id))?.session?.header,
        externalOf: id => external?.bySession(id),
        report: selfReport,
    })
    /**
     * 会话持久的模型选择：在内存里先读 Agent 的；不在就读日志里最后一条 `model/selection`；
     * 没记过选择的会话跟着默认模型走（上游的规矩，`session-controller/src/agent.ts:466`）；会话不存在为 `undefined`。
     */
    async function selectionOf(id) {
        const live = ctx.agents.get(SessionId(id))?.model?.current?.()
        if (live !== undefined) return live
        // 区分"会话不存在"和"会话还没有事件"：刚建的会话只有 header。
        let events
        try {
            const observation = await ctx.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none' })
            try {
                events = [...observation.events]
            } finally {
                observation?.[Symbol.dispose]?.()
            }
        } catch (error) {
            if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
            throw error
        }
        const recorded = events.findLast(event => event?.type === 'model/selection')?.data
        if (recorded !== undefined) return recorded
        return ctx.get('agentDefaultModel')?.currentSelection?.()
    }
    const executors = createExecutors({ selectionOf, report: selfReport, domain: executorsDomain })
    // 原生由核心自己登记，兜底：别的执行方都不接的会话归它。压缩、兜底阈值由上下文模块提供，那时再声明。
    ctx.effect(() => executors.register({
        id: 'native',
        handles: () => true,
        required: {
            runTurn: true, openingSegments: true, perTurnContext: true, toolEndpoint: true, interrupt: true,
            // 没装上下文模块的压缩引擎时：换新对话做不了、用量没有（provideNative 换成真的）。
            newConversation: () => ({ scheduled: false, reason: '原生会话不能换新对话：没有装框架的压缩引擎' }),
            usage: () => null,
        },
        optional: { resume: true, resendAfterCompaction: true, steer: true, skillFilter: true, imageAccounting: true },
    }, { native: true }), 'mind-framework-core: native executor')
    // 启动完成（配置里的插件都装好了）时，原生还没有压缩引擎就报一次。不在 apply 里等：Loader 要等核心自己装完。
    let stopped = false
    ctx.effect(() => () => { stopped = true }, 'mind-framework-core: startup check')
    const startupSettled = deps.startupSettled ?? (() => ctx.get('loader')?.await())
    // 没有中枢（新装上框架、或中枢被清掉）：报出来，告诉用户怎么定；不替用户建。
    const checkHub = () => {
        if (sessions.hub() !== null) return
        selfReport('core/no-hub', {
            text: `还没有中枢会话：消息渠道的私聊、给中枢的转交、主动联系都没有去处。在 DSH 里打开要作中枢的会话（没有就新建一个，建议置顶），输入 /${HUB_COMMAND}`,
        })
    }
    Promise.resolve()
        .then(() => startupSettled())
        .then(() => {
            if (stopped) return
            executors.checkNative()
            checkHub()
        })
        .catch(error => selfReport('core/startup-check-failed', { text: `启动完成后的检查没做成（${error?.message ?? error}）` }))
    const content = contentRoot === null
        ? undefined
        : createContent({
            root: contentRoot,
            authorName: config.contentAuthor ?? '助手',
            report: selfReport,
            starter: config.starter === false ? {} : STARTER_FILES,
            ...deps.git === undefined ? {} : { git: deps.git },
        })
    if (content !== undefined) {
        // 工具以外改的文件定时留痕：启动后一分钟一次，之后半小时一次。
        const sweep = () => content.sweep().catch(error => selfReport('core/content-sweep-failed', { text: `内容库没能提交工具以外的改动（${error?.message ?? error}）` }))
        const first = setTimeout(sweep, 60_000)
        const again = setInterval(sweep, 30 * 60_000)
        first.unref?.()
        again.unref?.()
        ctx.effect(() => () => {
            clearTimeout(first)
            clearInterval(again)
        }, 'mind-framework-core: content sweep')
    }
    if (content === undefined) selfReport('core/content-unavailable', { text: '内容目录（contentDirectory）明写成了空，心智与记忆的写入不可用' })
    // 启动时就准备好内容库：新建的内容库这时写进起步模板，不用等第一次写入。
    else content.prepare().catch(error => selfReport('core/content-prepare-failed', { text: `内容库没准备好（${error?.message ?? error}）` }))
    for (const tool of UPSTREAM_NATIVE_ONLY_TOOLS) tools.declareTool(tool, { audience: 'native-only' })
    // 外部调用方的会话不跑轮，Goal 对它没有意义。
    for (const [tool, meta] of Object.entries(UPSTREAM_SHARED_TOOLS)) tools.declareTool(tool, { audience: 'all', ...meta, allow: who => who?.kind !== 'external' })
    for (const [tool, meta] of Object.entries(config?.toolDeclarations ?? {})) tools.declareTool(tool, meta)
    /** 上游工具按 `allow` 挡掉的限制：每个 Agent 一份，角色或登记变了重新挡。 */
    const restrictions = new Map()
    function restrict(agent) {
        restrictions.get(agent)?.()
        restrictions.delete(agent)
        const known = new Set(ctx.tools.definitions().map(definition => definition.name))
        const denied = tools.deniedUpstream(agent, known)
        if (denied.length === 0) return
        try {
            restrictions.set(agent, agent.ctx.tools.restrict({ deny: denied }))
        } catch (error) {
            selfReport('core/restrict-failed', { sessionId: String(agent.session.id), text: `没能挡掉 ${denied.join('、')}（${error?.message ?? error}）` })
        }
    }
    let executor
    const endpoint = createEndpoint({
        tools: ctx.tools,
        createExecutor: () => (executor ??= new NativeToolExecutor(ctx)),
        agents: ctx.agents,
        resolveAgent,
        metaOf: name => tools.metaOf(name),
        allows: (name, meta, agent) => tools.allows(name, meta, tools.caller({ agent })),
        report: selfReport,
        segmentWrites: { before: segments.beforeSelfWrite, after: segments.afterSelfWrite },
        port: config?.endpointPort ?? 0,
    })
    ctx.effect(() => () => endpoint.dispose(), 'mind-framework-core: tool endpoint')
    const OWNER = { kind: 'user' }
    external = createExternal(externalDomain, {
        credentials: () => ctx.get('credentials'),
        createSession: async (externalName) => {
            const controller = ctx.get('sessionController')
            if (controller === undefined) throw new Error('当前组合没有 sessionController，建不了外部调用方的会话')
            const created = await controller.create({ cwd: config?.externalCwd ?? homedir(), sessionId: SessionId(`session-external-${externalName}`) })
            return String(created.sessionId)
        },
        assignExternal: sessionId => sessions.assign(sessionId, 'external', { by: OWNER }),
        releaseRole: sessionId => sessions.release(sessionId, { by: OWNER }),
        endpoint,
        owner: name,
        report: selfReport,
    })
    await external.restore()
    // 登记、作废只走主人的设置页路由；没有 Connection 的组合（测试、无界面）就没有这几条路由，不挡启动。
    // 定中枢：用户在要作中枢的会话里输入 /hub。命令只有用户本人能发，模型调不到，所以中枢不会被转来的话改掉。
    const pendingCommand = ctx.inject(['commands'], (injected) => {
        injected.effect(() => injected.get('commands').register({
            definitionId: CommandDefinitionId('@loveandbeepbrother/dsh-galatea/hub'),
            name: HUB_COMMAND,
            description: 'Make this session the hub (中枢) of Galatea: private chats, handoffs and the assistant\'s own messages go here',
            handler: async (invocation) => {
                if (invocation.rawInput.trim() !== '') return { kind: 'error', text: `用法：/${HUB_COMMAND}（不带参数）` }
                const sessionId = String(invocation.agent?.session?.id ?? '')
                if (sessionId === '') return { kind: 'error', text: '这里没有会话，定不了中枢' }
                const role = sessions.roleOf(sessionId)
                if (role === 'external' || invocation.agent?.session?.header?.parentSession !== undefined) {
                    return { kind: 'error', text: '外部调用方的会话、子代理不能作中枢' }
                }
                const previous = sessions.hub()
                if (previous === sessionId) return { kind: 'success', text: '这个会话已经是中枢了' }
                // 还没开过轮的会话 DSH 算空会话（和会话控制器同一个口径）：侧栏不列，新建会话时还会被拿去重用，定成中枢就找不回来了。
                // 这里抛错而不是交回 error 结果：命令结果显示在对话流里，空会话显示成新建会话页、没有对话流，用户看不到；
                // 抛错时 DSH 的输入框会弹出这句提示（命令日志里照样记一条失败）。
                const boundary = ctx.agents.turnBoundaryOf(invocation.agent.session)
                if (boundary.lastTurn === 0 && boundary.openTurnStartSeq === null) {
                    throw new Error(`先在这个会话里说一句话，再输入 /${HUB_COMMAND}（DSH 不显示还没开过轮的会话，新建会话时还会把它拿去重用）`)
                }
                await sessions.setHub(sessionId, { by: { kind: 'user', via: `/${HUB_COMMAND}` } })
                return { kind: 'success', text: previous === null ? '这个会话现在是中枢了' : `这个会话现在是中枢了，原来的中枢（${previous}）不再有角色` }
            },
        }), 'mind-framework-core: hub command')
    })
    pendingCommand?.then?.(undefined, error => selfReport('core/hub-command-failed', { text: `定中枢的命令 /${HUB_COMMAND} 没注册上（${error?.message ?? error}）` }))
    const pendingRoutes = ctx.inject(['connection'], (injected) => {
        const connection = injected.get('connection')
        if (connection?.fetch?.register === undefined) return
        injected.effect(() => registerExternalRoutes(connection, external), 'mind-framework-core: external routes')
    })
    pendingRoutes?.then?.(undefined, error => selfReport('core/external-routes-failed', { text: `外部调用方的设置页路由没挂上（${error?.message ?? error}）` }))
    const reapplyRestrictions = () => {
        for (const agent of ctx.agents.list()) restrict(agent)
    }
    // 角色变了全部重挡：它在内存里的子代理按父会话算调用方，也要跟着变（Agent 不多，不单挑）。
    sessions.on('changed', () => {
        reapplyRestrictions()
        endpoint.listChanged()
    })
    // 上游工具在 Agent 建好以后才注册（插件热加载）也要挡：restrict 不收还不存在的名字，所以在全局工具的名字变了时重挡。
    // tools/change 在挡的时候也会发（restrict 改的是 Agent 自己那一层），只比全局名字，不会自己触发自己。
    let knownNames = ''
    ctx.on('tools/change', () => {
        endpoint.listChanged()
        const names = ctx.tools.definitions().map(definition => definition.name).sort().join('\u0000')
        if (names === knownNames) return
        knownNames = names
        reapplyRestrictions()
    })
    ctx.on('agent/disposed', ({ agent }) => {
        restrictions.delete(agent)
    })
    const quietly = (label, job) => job.catch(error => selfReport('core/internal', { text: `${label}出错（${error?.message ?? error}）` }))
    /** 进收件箱时落在 next-step 的消息编号：认开启这一轮的消息时排除它们（会话被 steer 叫醒的轮）。 */
    const fromNextStep = new Set()
    /** 消息进收件箱的时刻：标注里写的是到达的时刻，不是进模型的时刻（排着队的消息可能等了很久）。没进 pre-step 的过一天丢掉。 */
    const arrivals = new Map()
    const arrivalOf = (id) => {
        const time = arrivals.get(id) ?? Date.now()
        arrivals.delete(id)
        return arrivalText(time, timezone)
    }
    const quietHours = createQuietHours({ timezone, ...config?.quietHours ?? {} })
    const exits = createExits({ report: selfReport })
    const deliver = createDeliver({
        hub: () => sessions.hub(),
        servedBy: id => exits.servedBy(id),
        readEvents,
        resolveAgent,
        flush: session => ctx.sessions.flush(session),
        report: selfReport,
        roleOf: id => sessions.roleOf(id),
    })

    ctx.on('agent/created', ({ agent, source }) => {
        sessions.noteAgent(agent?.session)
        restrict(agent)
        if (source === 'resume') quietly('检查恢复前的最后一轮', attachments.noteResumed(agent.session.id))
    })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => attachments.noteClaimed(agent.session.id, turn, message))
    // 会话事件在各会话自己的范围里派发，要用 global 才收得到所有会话的。
    ctx.on('session/event', (session, event) => {
        if (event?.type === 'turn/end') quietly('处理一轮的结束', attachments.noteTurnEnd(session.id, event))
    }, { global: true })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        provenance.noteInserted(message)
        const now = Date.now()
        arrivals.set(String(message.id), now)
        if (arrivals.size > 1000) for (const [id, time] of arrivals) if (now - time > 86_400_000) arrivals.delete(id)
        if (agent?.inbox?.nextStep?.some(item => item.id === message.id)) fromNextStep.add(String(message.id))
    })
    ctx.on('agent/pre-step', async (payload, next) => {
        const triggerId = payload.step === 1 ? triggerOf(payload.messages, fromNextStep) : null
        for (const message of payload.messages) fromNextStep.delete(String(message.id))
        const decision = await next()
        if (decision?.kind !== 'enter') return decision
        const sessionId = String(payload.agent.session.id)
        const messages = classifier.stamp(provenance.stamp(decision.messages), { triggerId, sessionId, arrivalOf })
        attachments.noteStamped(sessionId, payload.turn, messages)
        if (payload.step === 1) {
            const trigger = triggerId === null ? undefined : messages.find(message => String(message.id) === triggerId)
            try {
                recordRoute(payload.agent.session, { turn: payload.turn, trigger: triggerId, route: routeOf(trigger, classifier.declarationOf) })
            } catch (error) {
                selfReport('core/turn-route-failed', { sessionId, text: `第 ${payload.turn} 轮的回复去向没记下（${error?.message ?? error}）` })
            }
        }
        return messages === decision.messages ? decision : { ...decision, messages }
    })

    new Core(ctx, { reports, sessions, provenance, deliver, classifier, attachments, segments, tools, endpoint, external, content, executors, reapplyRestrictions, readEvents, quietHours, exits, timezone })
}
