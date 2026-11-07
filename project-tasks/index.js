/**
 * 项目任务：中枢把任务派给项目，由项目里的助手亲自推进，结果回到中枢验收。
 *
 * 每项任务在目标项目下新建一条会话（在框架核心里登记成 worker，标签 task），委派以一条输入交给它；
 * 会话一轮结束时取最后的回复作为执行报告，交回中枢。验收的接受、返修与取消由中枢调用工具完成。
 * 接在框架核心上：委派与回报经 `core.deliver`，回复往哪发由出口按中枢的规则定；进度发到项目接的群经
 * `core.exits.notify`；额度问 `core.quota.state`；工具经 `core.tool` 声明谁能用。
 *
 * @module @loveandbeepbrother/dsh-galatea-project-tasks
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
    TASK_SOURCE, noticeText, progressText, redirectText, requestText, reviseText, roundOutcome,
    sessionIdOf, taskIdOf, taskIdOfSession, turnOpen,
} from './tasks.js'

export const name = 'project-tasks-framework'
export const inject = ['agents', 'sessionQuery', 'storageDomain', 'tools', 'core']

/** 委派、回报都是本插件放进会话的（程序），不是哪个会话说的。 */
const SPEAKER = Object.freeze({ kind: 'program', plugin: name })
/** `core.deliver` 的这几种结果都算已经放进去：`unknown` 是进了收件箱、落盘没成，重来时按消息编号认得出，不会重复。 */
const PLACED = Object.freeze(['delivered', 'duplicate', 'unknown'])

const STATES = ['running', 'reported', 'accepted', 'canceled']

const roundSchema = z.object({
    round: z.number().int().positive(),
    request: z.object({ id: z.string(), text: z.string() }).strict(),
    sentAt: z.number().nullable(),
    report: z.object({
        outcome: z.string(),
        text: z.string(),
        turn: z.number().int(),
        endSeq: z.number().int(),
        at: z.number(),
    }).strict().nullable(),
    notice: z.object({
        state: z.enum(['pending', 'sending', 'delivered']),
        via: z.enum(['channel', 'session']).nullable(),
        messageId: z.string().nullable(),
        platform: z.string().nullable(),
        at: z.number(),
    }).strict().nullable(),
    review: z.object({
        decision: z.enum(['accept', 'revise', 'cancel']),
        feedback: z.string(),
        by: z.string(),
        callId: z.string(),
        at: z.number(),
        /** 本轮进行中被改派，没有执行报告。 */
        interrupted: z.boolean().optional(),
    }).strict().nullable(),
}).strict()

/** 任务记录：键为任务编号。 */
export const taskDomainSpec = defineDomain({
    name: 'galatea_project_tasks',
    version: 1,
    layout: 'per-record',
    tables: {
        tasks: {
            valueSchema: z.object({
                taskId: z.string(),
                originId: z.string(),
                callId: z.string(),
                workspaceId: z.string(),
                workspaceTitle: z.string(),
                directory: z.string(),
                overviewFile: z.string(),
                sessionId: z.string(),
                title: z.string(),
                instructions: z.string(),
                deliverables: z.array(z.string()),
                model: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
                state: z.enum(STATES),
                rounds: z.array(roundSchema).min(1),
                createdAt: z.number(),
                updatedAt: z.number(),
            }).strict(),
        },
    },
})

export const Config = Schema.object({
    overviewFiles: Schema.array(Schema.string()).default(['项目概述.md'])
        .description('项目概述文件名，按顺序取第一个存在的；都不存在时任务会新建第一个'),
    overviewChars: Schema.natural().default(1500).description('项目列表中每份概述的字数上限'),
    reportChars: Schema.natural().default(6000).description('转交回报中执行报告的字数上限'),
    provider: Schema.string().default('').description('任务会话的模型提供方（例如 agent-sdk）；空就不选，用 DSH 设的默认模型'),
    models: Schema.array(Schema.string()).default([]).description('派任务时可以选的模型（配了提供方才用）'),
    defaultModel: Schema.string().default('').description('派任务没写模型时用哪个（配了提供方才用）'),
    reconcileDelayMs: Schema.natural().default(15_000).description('Host 启动后多久核对未完成的任务'),
    redirectWaitMs: Schema.natural().default(60_000).description('改派后等被中止的回合结束的最长时间，到时直接发出新要求'),
    quotaRetryMs: Schema.natural().default(300_000).description('任务会话的执行方额度用完时委派先不发，隔多久再看一次（毫秒）'),
})

/** 中枢会话的开头段落：怎么派任务、怎么验收、验收过的产出怎么交给用户。 */
export const HUB_GUIDANCE = [
    '用户的创作与开发项目注册为 DSH 项目。需要在某个项目里推进较长的工作时，先用 `assistant_project_list` 看各项目的概述，',
    '再用 `assistant_task_dispatch` 派给该项目；做完会以“【项目任务回报】”转交给你，按交付要求验收后用 `assistant_task_review`',
    '接受、返修或取消，并简要告诉用户。验收过的项目任务产出（文档、报告等）用 `present`（Claude Code 里是 `mcp__dsh__present`）交给用户。',
    '项目接着聊天群时，进度也会发到那个群，完整回报仍交给你。',
].join('')
/** 项目会话、任务会话的开头段落。 */
export const WORKER_GUIDANCE = '收到“【项目任务】”或“【返修要求】”时，你就是该项目里的执行者：照要求做完，这一轮最后的那段文字作为报告交回中枢验收。'
/** 后台思考醒来时的事实段里，本插件交的一行（框架的后台思考模板不写插件的事）。 */
export const REFLECTION_FACT = '可以用 assistant_project_list、assistant_task_status 看各项目和任务'

class TaskError extends Error {
    constructor(message) {
        super(message)
        this.name = 'TaskError'
    }
}

/** 释放一次只读观察。 */
function dispose(observation) {
    try {
        if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]()
        else observation?.dispose?.()
    } catch {
        // 只读观察的释放失败不影响结论。
    }
}

/** 按码点截取。 */
function clip(text, limit) {
    const points = Array.from(text)
    return points.length > limit ? `${points.slice(0, limit).join('')}…` : text
}

export function apply(ctx, config) {
    let domain
    let ready
    let closed = false
    let timer
    const chains = new Map()

    const open = () => {
        ready ??= ctx.storageDomain.open(taskDomainSpec).then((opened) => { domain = opened }).catch((error) => {
            ready = undefined
            throw error
        })
        return ready
    }
    const table = () => domain.table('tasks')
    const now = () => Date.now()
    const service = (serviceName) => {
        const found = ctx.get(serviceName)
        if (found === undefined) throw new TaskError(`当前组合没有 ${serviceName} 服务`)
        return found
    }
    const sessionController = () => service('sessionController')

    /** 同一任务的动作依次进行。 */
    function serial(key, job) {
        const previous = chains.get(key) ?? Promise.resolve()
        const next = previous.catch(() => {}).then(job)
        const tail = next.catch(() => {})
        chains.set(key, tail)
        tail.then(() => {
            if (chains.get(key) === tail) chains.delete(key)
        })
        return next
    }

    const readTask = taskId => table().get(taskId)
    const allTasks = () => [...table().entries()].map(([, value]) => value)
    async function saveTask(task) {
        const next = { ...task, updatedAt: now() }
        await table().put(task.taskId, next)
        return next
    }
    const latest = task => task.rounds[task.rounds.length - 1]
    const withRound = (task, round) => ({
        ...task,
        rounds: task.rounds.map(item => (item.round === round.round ? round : item)),
    })

    /**
     * 写操作的调用者只能是中枢本身。工具声明里的 `allow` 已经只给中枢，这里执行时再核一次。
     * 核心把子代理算成它的父会话，所以子代理要在这里另外挡。
     */
    function callerOf(exec) {
        const agent = exec?.agent
        if (agent?.session?.header?.origin === 'subagent' || agent?.parentAgent !== undefined) {
            throw new TaskError('子代理不能派发或验收项目任务')
        }
        const who = ctx.core.caller(exec)
        if (who?.kind !== 'session') throw new TaskError('无法确定调用会话')
        if (who.role !== 'hub') throw new TaskError('只有中枢能派发、验收项目任务')
        return who.sessionId
    }

    function requireTask(taskId) {
        const task = typeof taskId === 'string' ? readTask(taskId) : undefined
        if (task === undefined) throw new TaskError(`没有任务 ${taskId}`)
        return task
    }

    async function readEvents(sessionId) {
        let observation
        try {
            observation = await ctx.sessionQuery.observeSession(SessionId(sessionId))
        } catch (error) {
            if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return []
            throw error
        }
        try {
            return [...observation.events]
        } finally {
            dispose(observation)
        }
    }

    async function overviewOf(directory) {
        for (const file of config.overviewFiles) {
            const path = join(directory, file)
            try {
                const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
                const points = Array.from(text)
                return {
                    file,
                    updatedAt: info.mtimeMs,
                    text: points.slice(0, config.overviewChars).join(''),
                    totalCharacters: points.length,
                }
            } catch {
                // 下一个候选。
            }
        }
        return null
    }

    /** 取会话的 Agent（在内存里的直接用，否则经公开的 `sessionController.resolveAgent` 恢复）；取不到时为 null。 */
    async function findAgent(sessionId) {
        const live = ctx.agents.get(SessionId(sessionId))
        if (live !== undefined) return live
        const found = await sessionController().resolveAgent(SessionId(sessionId))
        return 'error' in found ? null : found.agent
    }

    async function requireAgent(sessionId) {
        const agent = await findAgent(sessionId)
        if (agent === null) throw new TaskError(`会话 ${sessionId} 取不到`)
        return agent
    }

    /** 在核心里登记成 worker（会话是什么写成数据）；已经是的不重写。 */
    async function markWorker(sessionId, label) {
        if (ctx.core.sessions.roleOf(sessionId) === 'worker') return
        await ctx.core.sessions.assign(sessionId, 'worker', { label, by: SPEAKER })
    }

    /** 取得任务会话的 Agent；会话还不存在时在项目下新建、登记角色、命名并选好模型。 */
    async function taskAgent(task) {
        const found = await findAgent(task.sessionId)
        if (found !== null) {
            // 建好、还没登记角色就停了机的，这时补上。
            await markWorker(task.sessionId, 'task')
            return found
        }
        const controller = sessionController()
        await controller.create({ workspaceId: task.workspaceId, sessionId: task.sessionId })
        await markWorker(task.sessionId, 'task')
        const agent = await requireAgent(task.sessionId)
        if (task.model !== null) agent.model.select({ provider: task.model.provider, model: task.model.model })
        await controller.rename({ sessionId: task.sessionId, title: `任务·${task.title}` })
        return agent
    }

    /**
     * 项目里可以接收任务进度的会话，按优先顺序：先是「<项目>·项目会话」，再是其余未归档、非任务的会话。
     * 渠道取第一个接了群的。
     */
    async function projectSessionsOf(task) {
        const registry = ctx.get('workspaceRegistry')
        const workspace = typeof registry?.get === 'function' ? registry.get(task.workspaceId) : undefined
        if (workspace === undefined) return []
        const archived = new Set((registry.archivedSessionIds ?? []).map(String))
        const ids = workspace.sessionIds.map(String).filter(id => !archived.has(id) && taskIdOfSession(id) === undefined)
        if (ids.length === 0) return []
        const { items } = await sessionController().list({}, AbortSignal.timeout(20_000))
        const titles = new Map(items.map(item => [String(item.sessionId), item.projections?.values?.title]))
        const project = `${workspace.title}·项目会话`
        return [...ids.filter(id => titles.get(id) === project), ...ids.filter(id => titles.get(id) !== project)]
    }

    /** 这一轮发出时的说法：第 1 轮开始，改派后重新开始，验收后返修。 */
    function startEvent(task, round) {
        if (round.round === 1) return 'start'
        const previous = task.rounds.find(item => item.round === round.round - 1)
        return previous?.review?.interrupted === true ? 'redirect' : 'revise'
    }

    /**
     * 任务进度发到项目接着的群：一句固定的话，经核心的出口通知（`core.exits.notify`），不等结果，绝不影响任务本身。
     * 去重（同一键只发一次）、过期、每群上限由出口判断；没发出由核心报（`core/notify-undeliverable`）。
     * 项目里没有哪个会话接着出口（项目本来就没接群）时不发，这不算没发出。
     */
    function noticeProgress(task, round, event, at) {
        const kind = { start: 'start', revise: 'start', redirect: 'start', done: 'end', failed: 'end', accepted: 'accept', canceled: 'cancel' }[event]
        const job = (async () => {
            const sessionIds = await projectSessionsOf(task)
            if (!sessionIds.some(id => ctx.core.exits.servedBy(id).length > 0)) return
            await ctx.core.exits.notify(sessionIds, {
                key: `${task.taskId}-r${round.round}-${kind}`,
                text: progressText(task, round, event),
                at,
            })
        })()
        job.catch((error) => {
            ctx.logger.warn(`project-tasks-framework: ${task.taskId} 进度没有发到群里：${error?.message ?? error}`)
        })
    }

    function messageOf(task, round, id, text) {
        const source = { kind: TASK_SOURCE, taskId: task.taskId, round }
        const content = [{ type: 'text', text }]
        return id === undefined
            ? createUserMessage({ content, source })
            : freezeMessage({ id, role: 'user', content, source })
    }

    /**
     * 把最新一轮的请求交给任务会话；已经进入会话的不重发。改派后被中止的回合还没结束时先不发，
     * 等它的 turn/end 触发核对再发，免得新要求混进正在中止的回合；`force` 用于等不到结束时。
     */
    async function sendRound(taskId, { force = false, backfill = false } = {}) {
        let task = readTask(taskId)
        if (task === undefined || task.state !== 'running') return
        const round = latest(task)
        if (round.sentAt !== null) {
            // 启动核对：发出后、进度发到群之前停过机的，补一次（渠道按键去重，过期的不发）。
            if (backfill) noticeProgress(task, round, startEvent(task, round), round.sentAt)
            return
        }
        await taskAgent(task)
        // 额度用完：委派先不发，留着，隔一会儿再看；恢复后照常发出。不能直接发进去等闸门恢复：
        // 那一轮会以额度错误结束，回报会被当成"没做成"交回去。额度按任务会话的执行方问（会话要先建好）。
        if (await quotaDeferred(task)) {
            reconcileLater(taskId, config.quotaRetryMs)
            return
        }
        const events = await readEvents(task.sessionId)
        if (!force && turnOpen(events)) return
        // 经核心放进任务会话：按请求的消息编号认出已经进入会话的，不重发；任务会话的回复不往外发。
        const result = await ctx.core.deliver(task.sessionId, {
            key: `${task.taskId}-r${round.round}-request`,
            id: round.request.id,
            text: round.request.text,
            source: { kind: TASK_SOURCE, taskId: task.taskId, round: round.round },
            speaker: SPEAKER,
            reply: { to: 'none' },
            link: task.taskId,
        })
        if (!PLACED.includes(result.status)) throw new TaskError(`委派没有放进任务会话：${result.reason ?? result.status}`)
        task = readTask(taskId)
        const saved = await saveTask(withRound(task, { ...latest(task), sentAt: now() }))
        noticeProgress(saved, latest(saved), startEvent(saved, latest(saved)), latest(saved).sentAt)
    }

    /** 任务会话的执行方额度用完了（框架核心按会话的执行方作答）：委派先不发。 */
    async function quotaDeferred(task) {
        return await ctx.core.quota.state(task.sessionId) === 'limited'
    }

    /** 任务会话一轮结束：记下执行报告并转交。 */
    async function collectRound(taskId) {
        const task = readTask(taskId)
        if (task === undefined || task.state !== 'running') return
        const round = latest(task)
        if (round.sentAt === null || round.report !== null) return
        const outcome = roundOutcome(await readEvents(task.sessionId), round.request.id)
        if (outcome === null) return
        const saved = await saveTask({
            ...withRound(task, {
                ...round,
                report: { ...outcome, at: now() },
                notice: { state: 'pending', via: null, messageId: null, platform: null, at: now() },
            }),
            state: 'reported',
        })
        const reported = latest(saved)
        noticeProgress(saved, reported, reported.report.outcome === 'completed' ? 'done' : 'failed', reported.report.at)
        await deliverNotice(taskId)
    }

    /** 把最新一轮的回报放进发起会话（中枢）；回复照中枢的规则由出口发。 */
    async function deliverNotice(taskId) {
        let task = readTask(taskId)
        if (task === undefined) return
        let round = latest(task)
        if (round.report === null || round.notice === null || round.notice.state === 'delivered') return
        const text = noticeText(task, round, { reportChars: config.reportChars })
        const key = `${task.taskId}-r${round.round}`

        // 放进会话时用的消息编号先记下：交出后、记下“已送达”前停了机，重来时按它认出已经交过的。
        if (round.notice.messageId === null) {
            task = await saveTask(withRound(task, {
                ...round,
                notice: { ...round.notice, state: 'sending', messageId: String(messageOf(task, round.round, undefined, text).id), at: now() },
            }))
            round = latest(task)
        }
        // 经核心放进会话。回复去向不写：派任务的只有中枢，回报一律进中枢，出口按中枢的规则发（休息时段里攒着）。
        // 记录里 via 一律是 session、platform 为 null；旧记录里的 channel 当历史留着。
        const result = await ctx.core.deliver(task.originId, {
            key,
            id: round.notice.messageId,
            text,
            source: { kind: TASK_SOURCE, taskId: task.taskId, round: round.round },
            speaker: SPEAKER,
            link: task.taskId,
        })
        if (!PLACED.includes(result.status)) {
            ctx.core.report('project-tasks/notice-undelivered', {
                sessionId: task.originId,
                text: `任务 ${task.taskId} 第 ${round.round} 轮的回报没放进发起会话（${result.reason ?? result.status}），重启核对时再试`,
                data: { taskId: task.taskId, round: round.round },
            })
            return
        }
        const notice = { state: 'delivered', via: 'session', messageId: round.notice.messageId, platform: null, at: now() }
        await saveTask(withRound(readTask(taskId), { ...round, notice }))
    }

    /** 核对一项任务：补发未送出的请求，补收已结束的回合，补交未送达的回报。 */
    async function reconcile(taskId, options) {
        await open()
        const task = readTask(taskId)
        if (task === undefined) return
        if (task.state === 'running') {
            if (latest(task).sentAt === null) await sendRound(taskId, options)
            else {
                if (options?.backfill === true) await sendRound(taskId, options)
                await collectRound(taskId)
            }
        } else if (task.state === 'reported') {
            // 启动核对：回报前停过机、结束的进度还没发到群的，补一次（渠道按键去重）。
            if (options?.backfill === true) {
                const round = latest(task)
                noticeProgress(task, round, round.report.outcome === 'completed' ? 'done' : 'failed', round.report.at)
            }
            await deliverNotice(taskId)
        }
    }

    function reconcileLater(taskId, delay, options) {
        const handle = setTimeout(() => {
            if (closed) return
            serial(taskId, () => reconcile(taskId, options)).catch((error) => {
                ctx.logger.warn(`project-tasks-framework: ${taskId} 核对失败：${error?.message ?? error}`)
            })
        }, delay)
        handle.unref?.()
    }

    /* ------------------------------ 工具主体 ------------------------------ */

    async function listProjects() {
        const registry = service('workspaceRegistry')
        const archived = new Set(registry.archivedSessionIds.map(String))
        const { items } = await sessionController().list({}, AbortSignal.timeout(20_000))
        const summaries = new Map(items.map(item => [String(item.sessionId), item]))
        const tasks = allTasks()
        const projects = await Promise.all(registry.list().map(async (workspace) => {
            const own = tasks.filter(task => task.workspaceId === String(workspace.id))
            const counts = Object.fromEntries(STATES.map(state => [state, own.filter(task => task.state === state).length]))
            const sessions = workspace.sessionIds.map(String).filter(id => !archived.has(id)).map((id) => {
                const summary = summaries.get(id)
                return {
                    sessionId: id,
                    title: summary?.projections?.values?.title ?? null,
                    running: summary?.running ?? false,
                    updatedAt: summary?.updatedAt ?? null,
                    taskId: taskIdOfSession(id) ?? null,
                }
            })
            return {
                workspaceId: String(workspace.id),
                title: workspace.title,
                path: workspace.path,
                overview: await overviewOf(workspace.path),
                sessions,
                tasks: counts,
            }
        }))
        return { projects }
    }

    /**
     * 项目的长期会话「<项目>·项目会话」：项目群接的、任务进度发往的就是它。没有（或都已归档）时在项目下新建、命名、选好模型。
     */
    async function ensureProjectSession(workspaceId, projectTitle) {
        const registry = ctx.get('workspaceRegistry')
        const workspace = typeof registry?.get === 'function' ? registry.get(workspaceId) : undefined
        const archived = new Set((registry?.archivedSessionIds ?? []).map(String))
        const ids = (workspace?.sessionIds ?? []).map(String).filter(id => !archived.has(id))
        const name = `${projectTitle}·项目会话`
        const controller = sessionController()
        if (ids.length > 0) {
            const { items } = await controller.list({}, AbortSignal.timeout(20_000))
            const found = items.find(item => ids.includes(String(item.sessionId)) && item.projections?.values?.title === name)
            if (found !== undefined) return { sessionId: String(found.sessionId), created: false }
        }
        const sessionId = `session-${randomUUID()}`
        await controller.create({ workspaceId, sessionId })
        // 项目会话和任务会话在权限表里是同一列，所以项目里的会话也登记成 worker。
        await markWorker(sessionId, '项目会话')
        const agent = await requireAgent(sessionId)
        if (config.provider !== '') agent.model.select({ provider: config.provider, model: config.defaultModel })
        await controller.rename({ sessionId, title: name })
        return { sessionId, created: true }
    }

    /**
     * 注册一个新项目：目录已登记为项目时直接返回它，不重复建、不改名。目录不存在时只在明确要求时新建。
     * 两种情况都保证项目有一个长期的项目会话（早先登记、还没有项目会话的，这时补上）。
     */
    async function createProject(exec, args) {
        callerOf(exec)
        const title = String(args.name ?? '').trim()
        const directory = String(args.directory ?? '').trim()
        if (title === '' || directory === '') throw new TaskError('name 与 directory 不能为空')
        if (!isAbsolute(directory)) throw new TaskError(`directory 必须是本机绝对路径：${directory}`)
        const info = await stat(directory).catch(() => null)
        if (info === null) {
            if (args.createDirectory !== true) {
                throw new TaskError(`目录 ${directory} 不存在；确实要新建这个目录时传 createDirectory: true`)
            }
            await mkdir(directory, { recursive: true })
        } else if (!info.isDirectory()) {
            throw new TaskError(`${directory} 不是目录`)
        }
        const controller = service('workspaceController')
        let { workspace, created } = await controller.create({ path: directory })
        if (created && workspace.title !== title) {
            try {
                ({ workspace } = await controller.rename({ workspaceId: workspace.workspaceId, title }))
            } catch (error) {
                throw new TaskError(`项目已按目录名「${workspace.title}」注册（${workspace.workspaceId}），改名为「${title}」失败：${error?.message ?? error}`)
            }
        }
        const projectSession = await ensureProjectSession(String(workspace.workspaceId), workspace.title)
        return {
            workspaceId: String(workspace.workspaceId),
            title: workspace.title,
            path: workspace.path,
            created,
            projectSession: { sessionId: projectSession.sessionId, title: `${workspace.title}·项目会话`, created: projectSession.created },
            next: created
                ? `项目已注册。可以用 assistant_task_dispatch 给它派任务，比如先通读目录、写一份 ${config.overviewFiles[0]}。`
                : '这个目录早已注册为项目，没有重复建；用 assistant_project_list 查看它的概述与会话。',
        }
    }

    async function dispatch(exec, args) {
        const originId = callerOf(exec)
        const callId = String(exec.callId ?? '')
        if (callId === '') throw new TaskError('缺少工具调用编号')
        const title = String(args.title ?? '').trim()
        const instructions = String(args.instructions ?? '').trim()
        if (title === '' || instructions === '') throw new TaskError('title 与 instructions 不能为空')
        const deliverables = (args.deliverables ?? []).map(item => String(item).trim()).filter(item => item !== '')
        // 没配提供方：任务会话用 DSH 设的默认模型，不收 model。
        const model = args.model ?? config.defaultModel
        if (config.provider === '' && args.model !== undefined) throw new TaskError('没有配置任务会话的模型提供方，派任务时不能指定 model')
        if (config.provider !== '' && !config.models.includes(model)) throw new TaskError(`model 只能是 ${config.models.join('、')}`)

        const taskId = taskIdOf(originId, callId)
        await serial(taskId, async () => {
            if (readTask(taskId) !== undefined) return
            const workspace = service('workspaceRegistry').get(args.workspaceId)
            if (workspace === undefined) throw new TaskError(`没有项目 ${args.workspaceId}；用 assistant_project_list 查看已注册的项目`)
            const overview = await overviewOf(workspace.path)
            const base = {
                taskId,
                originId,
                callId,
                workspaceId: String(workspace.id),
                workspaceTitle: workspace.title,
                directory: workspace.path,
                overviewFile: overview?.file ?? config.overviewFiles[0],
                sessionId: sessionIdOf(taskId),
                title,
                instructions,
                deliverables,
                model: config.provider === '' ? null : { provider: config.provider, model },
                state: 'running',
                createdAt: now(),
            }
            const text = requestText(base)
            const message = messageOf(base, 1, undefined, text)
            await saveTask({
                ...base,
                rounds: [{
                    round: 1,
                    request: { id: String(message.id), text },
                    sentAt: null,
                    report: null,
                    notice: null,
                    review: null,
                }],
            })
            await sendRound(taskId)
        })
        const task = readTask(taskId)
        const parallel = allTasks().filter(other => other.workspaceId === task.workspaceId
            && other.taskId !== taskId && other.state === 'running')
        const notes = [
            ...parallel.length > 0 ? [`该项目还有 ${parallel.length} 项任务在进行，同时改同一批文件可能冲突`] : [],
            ...latest(task).sentAt === null && await quotaDeferred(task) ? ['额度用完了，委派先留着，恢复后自动发出'] : [],
        ]
        return {
            ...summaryOf(task),
            ...notes.length > 0 ? { note: notes.join('；') } : {},
        }
    }

    async function review(exec, args) {
        const reviewer = callerOf(exec)
        const callId = String(exec.callId ?? '')
        const decision = args.decision
        if (!['accept', 'revise', 'cancel'].includes(decision)) throw new TaskError('decision 只能是 accept、revise 或 cancel')
        const feedback = String(args.feedback ?? '').trim()
        if (decision === 'revise' && feedback === '') throw new TaskError('返修需要写明 feedback')
        const taskId = requireTask(args.taskId).taskId
        await serial(taskId, async () => {
            let task = readTask(taskId)
            const round = latest(task)
            if (task.rounds.some(item => item.review?.callId === callId)) return
            const verdict = { decision, feedback, by: reviewer, callId, at: now() }
            if (decision === 'cancel') {
                if (task.state === 'accepted' || task.state === 'canceled') throw new TaskError(`任务已${task.state === 'accepted' ? '接受' : '取消'}`)
                ctx.agents.get(SessionId(task.sessionId))?.cancel({ kind: 'user' })
                const canceled = await saveTask({ ...withRound(task, { ...round, review: verdict }), state: 'canceled' })
                noticeProgress(canceled, latest(canceled), 'canceled', verdict.at)
                return
            }
            // 进行中的一轮可以改派：中止它，新要求等它结束后发出。
            const redirect = decision === 'revise' && task.state === 'running'
            if (task.state !== 'reported' && !redirect && !(decision === 'revise' && task.state === 'accepted')) {
                throw new TaskError(task.state === 'running'
                    ? '这一轮还没有结束，等回报后再接受；要改要求就用 revise 改派'
                    : `任务已${task.state === 'accepted' ? '接受' : '取消'}`)
            }
            if (decision === 'accept') {
                const accepted = await saveTask({ ...withRound(task, { ...round, review: verdict }), state: 'accepted' })
                noticeProgress(accepted, latest(accepted), 'accepted', verdict.at)
                return
            }
            if (redirect && round.sentAt !== null) {
                ctx.agents.get(SessionId(task.sessionId))?.cancel({ kind: 'user' })
                reconcileLater(taskId, config.redirectWaitMs, { force: true })
            }
            const next = round.round + 1
            const text = redirect ? redirectText(task, next, feedback) : reviseText(task, next, feedback)
            const message = messageOf(task, next, undefined, text)
            const reviewed = withRound(task, { ...round, review: redirect ? { ...verdict, interrupted: true } : verdict })
            task = await saveTask({
                ...reviewed,
                state: 'running',
                rounds: [
                    ...reviewed.rounds,
                    { round: next, request: { id: String(message.id), text }, sentAt: null, report: null, notice: null, review: null },
                ],
            })
            await sendRound(taskId)
        })
        return summaryOf(readTask(taskId))
    }

    function summaryOf(task) {
        const round = latest(task)
        return {
            taskId: task.taskId,
            title: task.title,
            project: task.workspaceTitle,
            workspaceId: task.workspaceId,
            sessionId: task.sessionId,
            state: task.state,
            round: round.round,
            roundSent: round.sentAt !== null,
            reportOutcome: round.report?.outcome ?? null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        }
    }

    function readTaskView(taskId) {
        const task = requireTask(taskId)
        return {
            ...summaryOf(task),
            directory: task.directory,
            overviewFile: task.overviewFile,
            model: task.model,
            instructions: task.instructions,
            deliverables: task.deliverables,
            rounds: task.rounds.map(round => ({
                round: round.round,
                request: round.round === 1 ? null : clip(round.request.text, 2000),
                sent: round.sentAt !== null,
                report: round.report,
                noticeVia: round.notice?.via ?? null,
                noticeDelivered: round.notice?.state === 'delivered',
                review: round.review === null ? null : {
                    decision: round.review.decision,
                    feedback: round.review.feedback,
                    at: round.review.at,
                    ...round.review.interrupted ? { interrupted: true } : {},
                },
            })),
        }
    }

    /**
     * 在跑的任务（一轮已派出、还没回报）与任务会话最后一次活动的时间，供别的插件（例如看门狗一类的监视插件）只读查看。
     * 最后活动取任务会话最后一个事件的时间、这一轮发出的时间与任务记录更新时间中最晚的。
     */
    async function runningTasks() {
        await open()
        const found = []
        for (const task of allTasks().filter(item => item.state === 'running')) {
            const round = latest(task)
            const events = await readEvents(task.sessionId)
            const lastEventAt = events.reduce((last, event) => (typeof event?.time === 'number' && event.time > last ? event.time : last), 0)
            found.push({
                taskId: task.taskId,
                title: task.title,
                project: task.workspaceTitle,
                sessionId: task.sessionId,
                directory: task.directory,
                round: round.round,
                lastActivityAt: Math.max(lastEventAt, round.sentAt ?? 0, task.updatedAt),
            })
        }
        return found
    }

    /* ------------------------------ 注册 ------------------------------ */

    const output = {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
    }
    const json = value => JSON.stringify(value, null, 1)
    const run = body => async (args, exec) => {
        await open()
        return json(await body(args ?? {}, exec))
    }

    // 工具经核心注册：读的 3 个谁都能用（外部调用方也给）；写的 3 个只给中枢。
    const core = ctx.core
    const READ = { effect: 'read' }
    const WRITE = { effect: 'write', allow: who => who?.kind === 'session' && who.role === 'hub' }
    ctx.effect(() => core.declareSource(TASK_SOURCE, { intent: 'prompt', annotate: false, speaker: SPEAKER }), 'project-tasks-framework: task source')
    // 怎么派、怎么做任务，由本插件经会话开头段落交代（执行方的系统提示里不写）：装了才出现。
    ctx.effect(() => core.segment({
        name: 'project-tasks',
        order: 9_400,
        audience: 'opening',
        text: ({ sessionId }) => {
            const role = core.sessions.roleOf(String(sessionId))
            if (role === 'hub') return HUB_GUIDANCE
            if (role === 'worker') return WORKER_GUIDANCE
            return ''
        },
    }), 'project-tasks-framework: guidance segment')
    // 后台思考醒来时告诉它去哪看各项目和任务。没装后台思考时这个注入一直不成，什么也不做。
    ctx.inject(['reflection'], (sub) => {
        const off = sub.reflection.contribute('项目任务', async () => [REFLECTION_FACT])
        sub.effect(() => off, 'project-tasks-framework: reflection facts')
    })
    core.tool(defineTool({
        name: 'assistant_project_list',
        description: 'List every registered DSH project (Workspace): id, title, directory, the start of its overview file (by default 项目概述.md), its open sessions, and task counts by state. Read-only.',
        parameters: {},
        output,
        execute: run(() => listProjects()),
    }), READ)
    core.tool(defineTool({
        name: 'assistant_project_create',
        description: 'Register a local directory as a new DSH project (Workspace) so tasks can be dispatched to it, and make sure it has its long-lived project session "<title>·项目会话" (created when missing — also for an already-registered project, so calling this again fixes a project without one; a QQ group can then be bound to that session). If the directory is already a project, that project is returned unchanged instead of creating a duplicate. A missing directory is an error unless createDirectory is true. Returns the project id, title, directory and whether it was newly created.',
        parameters: {
            name: { type: 'string', required: true, description: 'Project display name.' },
            directory: { type: 'string', required: true, description: 'Absolute local path of the project directory.' },
            createDirectory: { type: 'boolean', description: 'Create the directory (recursively) when it does not exist. Default false.' },
        },
        output,
        execute: run((args, exec) => createProject(exec, args)),
    }), WRITE)
    core.tool(defineTool({
        name: 'assistant_task_dispatch',
        description: 'Dispatch a task to a project. A new session is created inside that project and works on it in the project directory; when its turn ends, its final reply comes back to the calling session as a 【项目任务回报】 for review with assistant_task_review. Retrying the same tool call does not dispatch twice. Avoid running two tasks that edit the same files of one project at the same time.',
        parameters: {
            workspaceId: { type: 'string', required: true, description: 'Project id from assistant_project_list.' },
            title: { type: 'string', required: true, description: 'Short task title, used as the task session name.' },
            instructions: { type: 'string', required: true, description: 'What to do, with enough context to work without asking the user.' },
            deliverables: { type: 'array', items: { type: 'string' }, description: 'Concrete acceptance criteria checked at review.' },
            model: { type: 'string', description: config.provider === '' ? 'Not used: task sessions use the default model.' : `Model for the task session: ${config.models.map(item => `"${item}"`).join(' or ')} (default "${config.defaultModel}").` },
        },
        output,
        execute: run((args, exec) => dispatch(exec, args)),
    }), WRITE)
    core.tool(defineTool({
        name: 'assistant_task_status',
        description: 'Read project tasks. With taskId: one task in full (instructions, deliverables, and every round with its complete report and review). '
            + 'Without taskId: the list of tasks, newest first; optional filters workspaceId and state (running, reported, accepted, canceled). '
            + '"reported" means the latest round has ended and awaits review.',
        parameters: {
            taskId: { type: 'string', description: 'Task id; omit to list.' },
            workspaceId: { type: 'string', description: 'When listing: only tasks of this project.' },
            state: { type: 'string', description: 'When listing: only tasks in this state.' },
        },
        output,
        execute: run(args => (typeof args.taskId === 'string' && args.taskId !== ''
            ? readTaskView(args.taskId)
            : {
                tasks: allTasks()
                    .filter(task => args.workspaceId === undefined || task.workspaceId === args.workspaceId)
                    .filter(task => args.state === undefined || task.state === args.state)
                    .sort((left, right) => right.createdAt - left.createdAt)
                    .map(summaryOf),
            })),
    }), READ)
    core.tool(defineTool({
        name: 'assistant_task_review',
        description: 'Review a project task. After its report arrives: "accept" closes it; "revise" sends feedback back into the same task session for another round (also allowed after accept). While a round is still running, "revise" redirects it: the round is interrupted and the feedback becomes the next round, so use it as soon as the user changes the requirements instead of waiting for the report. "cancel" stops the task and interrupts a running round. The executor\'s report and this review are stored separately.',
        parameters: {
            taskId: { type: 'string', required: true, description: 'Task id.' },
            decision: { type: 'string', required: true, description: '"accept", "revise" or "cancel".' },
            feedback: { type: 'string', description: 'Review notes; required for "revise" and sent to the task session verbatim.' },
        },
        output,
        execute: run((args, exec) => review(exec, args)),
    }), WRITE)

    ctx.effect(() => {
        // 任务会话一轮结束时收取报告；稍候再读，确保该回合的事件已经可见，读不到时再补一次。
        const off = ctx.on('session/event', (session, event) => {
            if (closed || event?.type !== 'turn/end') return
            const taskId = taskIdOfSession(session?.id === undefined ? undefined : String(session.id))
            if (taskId === undefined) return
            reconcileLater(taskId, 500)
            reconcileLater(taskId, 5_000)
        }, { global: true })

        // Host 重启后核对：补发未送出的请求、补收重启期间结束的回合、补交未送达的回报。
        timer = setTimeout(() => {
            open().then(() => {
                for (const task of allTasks()) {
                    if (task.state === 'running' || task.state === 'reported') reconcileLater(task.taskId, 0, { backfill: true })
                }
            }).catch((error) => {
                ctx.logger.warn(`project-tasks-framework: 启动核对失败：${error?.message ?? error}`)
            })
        }, config.reconcileDelayMs)
        timer.unref?.()

        return () => {
            closed = true
            clearTimeout(timer)
            off()
            domain?.close?.()
        }
    }, 'project-tasks-framework')

    ctx.provide('assistantProjectTasks', { running: runningTasks })
}
