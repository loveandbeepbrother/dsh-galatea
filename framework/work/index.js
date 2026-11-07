/**
 * 持续工作：一件工作 = 一个目标，在一个工作会话里，借上游 Goal 跨轮、跨重启地推进，结束、阻塞、取消时
 * 回报发起方。项目任务建在它上面，不在框架里。提供服务 `work`、七个工具。
 *
 * - **编号**：调用方给 `key` 就用它，否则用发起会话加调用编号。同一个键、参数相同算同一件（交回已有的），参数不同拒绝。
 * - **开工**：在所给的项目里经 `sessionController.create` 建工作会话，定角色 `worker`，选执行方（不给就用发起会话当前的）；
 *   心智在时按发起会话这一轮的版本把工作会话固定住（`mind.pin(.., 'session', ..)`），不在时照常开工、报一次。
 *   然后在工作会话的维护窗口里：建 Goal、马上 disarm、经 `core.deliver` 放进初始输入、再 `resume`。维护期间新输入不叫醒，
 *   初始输入先于 resume 进收件箱，所以第一轮一定是这条输入，不会抢在初始化前面。
 * - **回报**：Goal 变成 `complete`、`blocked` 时先记下；等这一轮 `turn/end` 以后取这一轮的最终文字，经 `core.deliver`
 *   交给发起会话，写明"这是工作会话的报告，不代表用户验收"，并发 `work/changed`。
 * - **Goal 被停下以后谁接着推**（工作会话的 `turn/end`）：额度用完（执行方闸门的错误码）等额度不是 `limited` 再 resume；
 *   别的出错退避以后 resume，连着 3 次出错改成 `blocked` 并回报，写明错误码。
 * - **`pausedBy` 在 Goal 变成暂停的那一刻记**：本模块正在卸下（Host 关机）记"关机"，重启后照常继续；别的一律记
 *   "用户或会话"，不自动继续。`work.pause` 记调用方。
 * - **跨重启**：启动后对没结束的工作冷读 Goal：已经 `complete`、`blocked` 的补发回报；`active`、`paused` 又没有
 *   `pausedBy`（或是关机停的）的恢复工作会话、`resume`，告诉发起会话"Host 重启后已自动继续"。上游把 `resume` 写成
 *   由人授权，这里按用户事先的决定（自动继续，暂停过的除外）代为 resume。
 * - 重启后续跑前，先撤掉收件箱里这个 Goal 活过重启的旧续跑消息（上游 goal-round-driver 不看恢复回来的收件箱，
 *   resume 以后会再排一条，两条都跑）。
 * - **初始输入领走了却一步没跑**（日志里没有、收件箱里也没有，工作会话空闲）：换新编号重发一次。这是唯一安全的重发。
 *
 * @module @loveandbeepbrother/dsh-galatea/work
 */

import { createHash, randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { callerLabel } from '../core/content.js'

export const name = 'mind-framework-work'
export const inject = ['core', 'storageDomain', 'agents', 'sessionQuery', 'goals']
export const WORK_SOURCE = 'work'
export const REPORT_SOURCE = 'work-report'
export const PHASES = Object.freeze(['running', 'paused', 'complete', 'blocked', 'canceled', 'lost'])
const SPEAKER = Object.freeze({ kind: 'program', plugin: name })
const MAX_ERRORS = 3

export const workDomainSpec = defineDomain({
    name: 'mind_framework_work',
    version: 1,
    layout: 'per-record',
    tables: {
        works: {
            valueSchema: z.object({
                workId: z.string(),
                fingerprint: z.string(),
                objective: z.string(),
                deliverables: z.array(z.string()),
                workspaceId: z.string(),
                origin: z.string(),
                by: z.string(),
                sessionId: z.string().nullable(),
                goalId: z.string().nullable(),
                messageId: z.string().nullable(),
                phase: z.enum(PHASES),
                pausedBy: z.string().nullable(),
                pendingReport: z.enum(['complete', 'blocked']).nullable(),
                waitingQuota: z.boolean(),
                errors: z.number(),
                lastError: z.string().nullable(),
                report: z.string().nullable(),
                createdAt: z.number(),
                updatedAt: z.number(),
            }).strict(),
        },
    },
})

export const Config = Schema.object({
    tickSeconds: Schema.natural().default(30),
    startupDelaySeconds: Schema.natural().default(15).description('启动后多久核对一遍没结束的工作'),
    backoffSeconds: Schema.natural().default(60).description('出错以后过多久再 resume（每多错一次乘上次数）'),
    maxGoalRounds: Schema.natural().default(0).description('每件工作的 Goal 轮数上限；0 用上游默认'),
})

export class WorkError extends Error {
    constructor(message) {
        super(message)
        this.code = 'WORK'
    }
}

const sha256 = text => createHash('sha256').update(text).digest('hex')
export const SHUTDOWN = '关机'
export const USER_OR_SESSION = '用户或会话'

export async function apply(ctx, config) {
    const core = ctx.core
    const domain = await ctx.storageDomain.open(workDomainSpec)
    let closing = false
    ctx.effect(() => () => {
        // 先置 closing：之后 goal-driver 卸下时停的 Goal 记成"关机"。
        closing = true
        domain.close?.()
    }, 'mind-framework-work: domain')
    const works = () => domain.table('works')
    const listeners = new Set()
    const reported = new Set()
    const reportOnce = (kind, key, detail) => {
        if (reported.has(`${kind}:${key}`)) return
        reported.add(`${kind}:${key}`)
        core.report(kind, detail)
    }
    const chains = new Map()
    const serial = (key, job) => {
        const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(job)
        chains.set(key, next.catch(() => {}))
        return next
    }
    const recordKey = workId => sha256(workId).slice(0, 40)
    const get = workId => works().get(recordKey(workId))
    const bySession = sessionId => [...works().entries()].map(([, value]) => value).find(item => item.sessionId === sessionId)
    async function patch(workId, changes) {
        const next = { ...get(workId), ...changes, updatedAt: Date.now() }
        await works().put(recordKey(workId), next)
        return next
    }
    function emit(record, report) {
        for (const listener of listeners) {
            try {
                listener({ workId: record.workId, phase: record.phase, ...report === undefined ? {} : { report } })
            } catch {
                // 监听者出错不影响工作本身。
            }
        }
    }

    function statusOf(record) {
        return {
            workId: record.workId, phase: record.phase, objective: record.objective, deliverables: record.deliverables,
            workspaceId: record.workspaceId, sessionId: record.sessionId, origin: record.origin,
            ...record.pausedBy === null ? {} : { pausedBy: record.pausedBy },
            ...record.lastError === null ? {} : { lastError: record.lastError },
            ...record.report === null ? {} : { report: record.report },
            createdAt: record.createdAt, updatedAt: record.updatedAt,
        }
    }

    async function resolveAgent(sessionId) {
        const live = ctx.agents.get(SessionId(sessionId))
        if (live !== undefined) return live
        const controller = ctx.get('sessionController')
        if (controller === undefined) throw new WorkError('当前组合没有 sessionController，工作会话不在内存里时取不到')
        const found = await controller.resolveAgent(SessionId(sessionId))
        if ('error' in found) throw found.error
        return found.agent
    }

    async function readEvents(sessionId) {
        let observation
        try {
            observation = await ctx.sessionQuery.observeSession(SessionId(sessionId), { projectionMode: 'none' })
            return [...observation.events]
        } catch (error) {
            if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return []
            throw error
        } finally {
            try {
                observation?.[Symbol.dispose]?.() ?? observation?.dispose?.()
            } catch {
                // 只读观察的释放失败不影响结论。
            }
        }
    }

    /* ------------------------------------------------------------------ 开工 */

    const goalObjective = record => [record.objective, ...record.deliverables.length > 0 ? ['交付：', ...record.deliverables.map(item => `- ${item}`)] : []].join('\n')
    const inputText = (record, extra) => [
        '（持续工作，不是用户发言）这是一件交给你的工作，会跨轮推进，直到你用 update_goal 把 Goal 标成 complete（做完）或 blocked（卡住、要别人决定）。',
        `目标：${record.objective}`,
        ...record.deliverables.length > 0 ? ['交付要求：', ...record.deliverables.map(item => `- ${item}`)] : [],
        `发起方：${record.by}。做完或卡住时，这一轮最后的文字会作为报告交给发起方，写清楚做了什么、交付在哪、还差什么。`,
        ...extra === undefined ? [] : ['', extra],
    ].join('\n')

    /** 在工作会话的维护窗口里建 Goal、放进输入、再 resume。 */
    async function launch(agent, record, text) {
        const messageId = `work-${randomUUID()}`
        await agent.runMaintenance(async () => {
            const goals = ctx.goals
            let view = goals.get(agent)
            if (view !== undefined && (view.phase === 'complete' || view.phase === 'blocked')) {
                goals.clear(agent, { id: view.id, revision: view.revision })
                view = undefined
            }
            if (view === undefined) view = goals.create(agent, { objective: goalObjective(record), ...config.maxGoalRounds > 0 ? { maxGoalRounds: config.maxGoalRounds } : {} })
            if (view.activation === 'armed') view = goals.disarm(agent) ?? view
            await patch(record.workId, { goalId: String(view.id), messageId })
            const result = await core.deliver(record.sessionId, { key: messageId, id: messageId, text, source: { kind: WORK_SOURCE, intent: 'prompt', key: messageId }, speaker: SPEAKER, link: record.workId })
            if (result.status === 'unavailable') throw new WorkError(`工作的输入没放进工作会话：${result.reason}`)
            const current = goals.get(agent)
            if (current?.phase !== 'active' || current.activation !== 'armed') goals.resume(agent, { id: current.id, revision: current.revision })
        })
        return patch(record.workId, { phase: 'running', pendingReport: null, waitingQuota: false, errors: 0, pausedBy: null })
    }

    /**
     * 开一件工作。
     * @param args - `{ key?, objective, deliverables, workspace, executor? }`；`workspace` 是项目编号。
     * @param by - 调用方（要是会话）。
     * @param options.callId - 调用编号（没给 key 时和发起会话一起当编号）。
     */
    async function start(args, by, { callId } = {}) {
        if (by?.kind !== 'session') throw new WorkError('工作只能由会话发起')
        const objective = String(args?.objective ?? '').trim()
        const deliverables = (Array.isArray(args?.deliverables) ? args.deliverables : []).map(String).map(item => item.trim()).filter(Boolean)
        const workspaceId = String(args?.workspace ?? '')
        if (objective === '') throw new WorkError('objective 不能为空')
        const workspace = ctx.get('workspaceRegistry')?.list().find(item => String(item.id) === workspaceId)
        if (workspace === undefined) throw new WorkError(`没有项目 ${workspaceId}；项目编号见 assistant_project_list`)
        const workId = String(args?.key ?? `${by.sessionId}:${callId ?? randomUUID()}`)
        const fingerprint = sha256(JSON.stringify([workspaceId, objective, deliverables]))
        return serial(workId, async () => {
            const existing = get(workId)
            if (existing !== undefined) {
                if (existing.fingerprint !== fingerprint) throw new WorkError(`工作 ${workId} 已经有了，参数和这次不同；换一个 key`)
                return statusOf(existing)
            }
            const controller = ctx.get('sessionController')
            if (controller === undefined) throw new WorkError('当前组合没有 sessionController，开不了工作会话')
            const now = Date.now()
            await works().put(recordKey(workId), {
                workId, fingerprint, objective, deliverables, workspaceId, origin: by.sessionId, by: callerLabel(by),
                sessionId: null, goalId: null, messageId: null, phase: 'running', pausedBy: null, pendingReport: null,
                waitingQuota: false, errors: 0, lastError: null, report: null, createdAt: now, updatedAt: now,
            })
            const created = await controller.create({ workspaceId: workspace.id })
            const sessionId = String(created.sessionId)
            await core.sessions.assign(sessionId, 'worker', { label: objective.slice(0, 40), by })
            let record = await patch(workId, { sessionId })
            const agent = await resolveAgent(sessionId)
            const selection = args?.executor ?? ctx.agents.get(SessionId(by.sessionId))?.model?.current?.()
            if (selection?.provider && selection?.model) agent.model?.select?.({ provider: selection.provider, model: selection.model })
            const mind = ctx.get('mind')
            if (mind === undefined) reportOnce('work/no-mind', 'start', { text: '心智没有加载，工作会话不固定人格、认知的版本' })
            else {
                try {
                    const snap = await mind.snapshot(by.sessionId)
                    if (snap !== null && snap.suppressed !== true) await mind.pin(sessionId, 'session', snap.versionId)
                } catch (error) {
                    core.report('work/mind-pin-failed', { sessionId, text: `工作 ${workId} 没能固定心智版本（${error?.message ?? error}），照常开工` })
                }
            }
            record = await launch(agent, record, inputText(record))
            emit(record)
            return statusOf(record)
        })
    }

    /* ------------------------------------------------------------------ 回报、出错、暂停 */

    async function finalText(sessionId, turn) {
        const outcome = await core.outcomeOf(sessionId, turn)
        return outcome?.kind === 'reply' ? outcome.text : ''
    }

    async function sendReport(record, phase, text) {
        const label = phase === 'complete' ? '做完了' : '卡住了'
        const body = [
            `【工作报告】（这是工作会话的报告，不代表用户验收）工作 ${record.workId}${label}。`,
            `目标：${record.objective}`,
            '',
            text.trim() === '' ? '（这一轮没有留下文字）' : text.trim(),
        ].join('\n')
        const updated = await patch(record.workId, { phase, pendingReport: null, report: text, waitingQuota: false })
        const result = await core.deliver(record.origin, { key: `work-report-${record.workId}-${phase}-${updated.updatedAt}`, text: body, source: { kind: REPORT_SOURCE, intent: 'prompt' }, speaker: SPEAKER, link: record.workId })
        if (result.status === 'unavailable') core.report('work/report-undelivered', { sessionId: record.origin, text: `工作 ${record.workId} 的报告没交给发起会话（${result.reason}）` })
        emit(updated, text)
        return updated
    }

    async function resumeGoal(record) {
        const agent = await resolveAgent(record.sessionId)
        const view = ctx.goals.get(agent)
        if (view === undefined) throw new WorkError(`工作会话 ${record.sessionId} 没有 Goal`)
        if (view.phase === 'active' && view.activation === 'armed') return view
        return ctx.goals.resume(agent, { id: view.id, revision: view.revision })
    }

    const backoff = new Map()
    async function onTurnEnd(sessionId, event) {
        const record = bySession(sessionId)
        if (record === undefined || ['complete', 'blocked', 'canceled', 'lost'].includes(record.phase)) return
        const turn = event.data?.turn
        const reason = event.data?.reason ?? {}
        if (record.pendingReport !== null) return sendReport(record, record.pendingReport, await finalText(sessionId, turn))
        if (reason.kind === 'completed') {
            if (record.errors > 0) await patch(record.workId, { errors: 0, lastError: null })
            return
        }
        if (record.pausedBy !== null) return
        const code = reason.error?.code ?? reason.code ?? reason.kind ?? 'unknown'
        if (await core.executors.gatedFailure(sessionId, code)) {
            await patch(record.workId, { waitingQuota: true })
            return
        }
        if (reason.kind === 'aborted' || reason.kind === 'interrupted') return
        const errors = record.errors + 1
        const updated = await patch(record.workId, { errors, lastError: String(code) })
        if (errors >= MAX_ERRORS) {
            return sendReport(updated, 'blocked', `连着 ${errors} 轮出错结束（最后一次：${code}），没有再继续。`)
        }
        backoff.set(record.workId, Date.now() + config.backoffSeconds * 1000 * errors)
    }

    ctx.on('goal/changed', (payload) => {
        const sessionId = String(payload?.agent?.session?.id ?? '')
        const phase = payload?.change?.goal?.phase
        if (sessionId === '' || phase === undefined) return
        const record = bySession(sessionId)
        if (record === undefined || record.goalId !== String(payload.change.ref?.id ?? payload.change.goal?.id)) return
        // 在变化的那一刻记，事后不去日志里按前后文推。
        if (phase === 'complete' || phase === 'blocked') {
            serial(record.workId, () => patch(record.workId, { pendingReport: phase })).catch(() => {})
        } else if (phase === 'paused' && record.pausedBy === null) {
            const pausedBy = closing ? SHUTDOWN : USER_OR_SESSION
            if (closing) {
                // 卸下中：存储域可能马上关，只尽量记。
                works().put(recordKey(record.workId), { ...record, pausedBy, phase: 'paused', updatedAt: Date.now() }).catch(() => {})
                return
            }
            serial(record.workId, async () => emit(await patch(record.workId, { pausedBy, phase: 'paused' }))).catch(() => {})
        }
    })

    ctx.on('session/event', (session, event) => {
        if (closing || event?.type !== 'turn/end') return
        const sessionId = String(session.id)
        const record = bySession(sessionId)
        if (record === undefined) return
        serial(record.workId, () => onTurnEnd(sessionId, event)).catch(error => core.report('work/turn-end-failed', { sessionId, text: `工作 ${record.workId} 处理一轮结束时出错（${error?.message ?? error}）` }))
    }, { global: true })

    /* ------------------------------------------------------------------ 定时核对 */

    async function checkOne(record) {
        if (record.phase !== 'running' || record.sessionId === null || record.pausedBy !== null) return
        if (record.waitingQuota) {
            if (await core.quota.state(record.sessionId) === 'limited') return
            await patch(record.workId, { waitingQuota: false })
            await resumeGoal(record)
            return
        }
        const due = backoff.get(record.workId)
        if (due !== undefined && Date.now() >= due) {
            backoff.delete(record.workId)
            await resumeGoal(record)
            return
        }
        // 初始输入领走了却一步没跑：只在工作会话空闲时判。
        const agent = ctx.agents.get(SessionId(record.sessionId))
        if (agent === undefined || agent.status === 'running' || record.messageId === null) return
        const events = await readEvents(record.sessionId)
        if (events.some(event => event.type === 'user/message' && String(event.data?.id) === record.messageId)) return
        const waiting = [...agent.inbox?.nextTurn ?? [], ...agent.inbox?.nextStep ?? []].some(message => String(message.id) === record.messageId)
        if (waiting) return
        core.report('work/initial-input-lost', { sessionId: record.sessionId, text: `工作 ${record.workId} 的初始输入领走了却一步没跑，换新编号重发` })
        await launch(agent, record, inputText(record))
    }

    async function tick() {
        if (closing) return
        for (const [, record] of works().entries()) {
            await serial(record.workId, () => checkOne(get(record.workId))).catch(error => reportOnce('work/check-failed', `${record.workId}:${error?.message ?? error}`, { text: `工作 ${record.workId} 核对出错（${error?.message ?? error}）` }))
        }
    }

    /** 启动后对没结束的工作核对一遍（跨重启）。 */
    async function reconcile() {
        for (const [, stored] of works().entries()) {
            if (closing) return
            if (!['running', 'paused'].includes(stored.phase) || stored.sessionId === null) continue
            await serial(stored.workId, async () => {
                const record = get(stored.workId)
                const agent = await resolveAgent(record.sessionId)
                const view = ctx.goals.get(agent)
                if (view === undefined) return
                if (view.phase === 'complete' || view.phase === 'blocked') {
                    // Goal 结束了、回报还没发出 Host 就被关了：补发。
                    const events = await readEvents(record.sessionId)
                    const lastTurn = events.filter(event => event.type === 'turn/end').at(-1)?.data?.turn
                    await sendReport(record, view.phase, lastTurn === undefined ? '' : await finalText(record.sessionId, lastTurn))
                    return
                }
                if (record.pausedBy !== null && record.pausedBy !== SHUTDOWN) return
                await patch(record.workId, { pausedBy: null, phase: 'running' })
                // 收件箱活过了重启、里面还有这个 Goal 的旧续跑消息：goal-round-driver 在 Agent 建好时把"有别的在排"清零、
                // 不看恢复回来的收件箱，resume 以后它会再排一条，两条都会跑。先撤掉旧的，由它重新排。
                for (const message of [...agent.inbox?.nextTurn ?? []]) {
                    if (message.source?.kind === 'goal' && String(message.source.goalId) === String(view.id)) agent.inbox.remove(message.id)
                }
                if (!(view.phase === 'active' && view.activation === 'armed')) ctx.goals.resume(agent, { id: view.id, revision: view.revision })
                await core.deliver(record.origin, {
                    key: `work-resumed-${record.workId}-${Date.now()}`,
                    text: `（持续工作，不是用户发言）Host 重启后，工作 ${record.workId}（${record.objective.slice(0, 60)}）已自动继续。`,
                    source: { kind: REPORT_SOURCE, intent: 'context' }, speaker: SPEAKER, link: record.workId, wake: 'none',
                })
            }).catch(error => core.report('work/reconcile-failed', { text: `工作 ${stored.workId} 重启后核对出错（${error?.message ?? error}）` }))
        }
    }

    const timer = setInterval(() => { tick().catch(() => {}) }, config.tickSeconds * 1000)
    timer.unref?.()
    const startup = setTimeout(() => { reconcile().catch(() => {}) }, config.startupDelaySeconds * 1000)
    startup.unref?.()
    ctx.effect(() => () => {
        clearInterval(timer)
        clearTimeout(startup)
    }, 'mind-framework-work: timers')

    /* ------------------------------------------------------------------ 其余操作 */

    const requireWork = (workId) => {
        const record = get(String(workId ?? ''))
        if (record === undefined) throw new WorkError(`没有工作 ${workId}`)
        return record
    }

    async function followup(workId, { text, by } = {}) {
        const body = String(text ?? '').trim()
        if (body === '') throw new WorkError('text 不能为空')
        return serial(String(workId), async () => {
            const record = requireWork(workId)
            if (record.phase === 'canceled' || record.phase === 'lost') throw new WorkError(`工作 ${workId} 已${record.phase === 'canceled' ? '取消' : '丢失'}`)
            const agent = await resolveAgent(record.sessionId)
            const updated = await launch(agent, record, inputText(record, `补充要求（${callerLabel(by)}）：${body}`))
            emit(updated)
            return statusOf(updated)
        })
    }

    async function pause(workId, { reason = '', by } = {}) {
        return serial(String(workId), async () => {
            const record = requireWork(workId)
            if (record.phase !== 'running') throw new WorkError(`工作 ${workId} 现在是 ${record.phase}，暂停不了`)
            // 先记谁停的，goal/changed 那边看到已经有了就不改。
            let updated = await patch(record.workId, { pausedBy: `${callerLabel(by)}${reason ? `：${reason}` : ''}`, phase: 'paused' })
            const agent = await resolveAgent(record.sessionId)
            const view = ctx.goals.get(agent)
            if (view?.phase === 'active') ctx.goals.pause(agent, { id: view.id, revision: view.revision })
            updated = get(record.workId)
            emit(updated)
            return statusOf(updated)
        })
    }

    async function resume(workId, { by } = {}) {
        return serial(String(workId), async () => {
            const record = requireWork(workId)
            if (record.phase !== 'paused' && record.phase !== 'running') throw new WorkError(`工作 ${workId} 现在是 ${record.phase}，不能继续；要返修用 followup`)
            const updated = await patch(record.workId, { pausedBy: null, phase: 'running', waitingQuota: false })
            await resumeGoal(updated)
            ctx.logger?.info?.(`mind-framework: 工作 ${workId} 由 ${callerLabel(by)} 继续`)
            emit(updated)
            return statusOf(updated)
        })
    }

    async function cancel(workId, { reason = '', by } = {}) {
        return serial(String(workId), async () => {
            const record = requireWork(workId)
            if (['complete', 'blocked', 'canceled'].includes(record.phase)) return statusOf(record)
            const updated = await patch(record.workId, { phase: 'canceled', pausedBy: `${callerLabel(by)}${reason ? `：${reason}` : ''}` })
            const agent = ctx.agents.get(SessionId(record.sessionId))
            if (agent !== undefined) {
                const view = ctx.goals.get(agent)
                if (view?.phase === 'active') ctx.goals.pause(agent, { id: view.id, revision: view.revision })
                agent.cancel({ kind: 'user' })
            }
            emit(updated)
            return statusOf(updated)
        })
    }

    const status = workId => statusOf(requireWork(workId))
    const list = ({ workspace } = {}) => [...works().entries()].map(([, value]) => value)
        .filter(item => workspace === undefined || item.workspaceId === String(workspace))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(statusOf)

    ctx.provide('work', {
        start, followup, pause, resume, cancel, status, list,
        on: (event, listener) => {
            if (event !== 'work/changed') throw new TypeError(`work 没有 ${event} 事件`)
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        tick, reconcile,
    })

    /* ------------------------------------------------------------------ 工具 */

    ctx.effect(() => core.declareSource(WORK_SOURCE, { intent: 'prompt', annotate: false, speaker: SPEAKER }), 'mind-framework-work: work source')
    ctx.effect(() => core.declareSource(REPORT_SOURCE, { intent: 'prompt', annotate: false, speaker: SPEAKER }), 'mind-framework-work: report source')
    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
    const hubOnly = who => who?.kind === 'session' && who.role === 'hub'
    const tool = ({ execute, ...definition }, meta) => core.tool(defineTool({
        ...definition,
        output,
        execute: async (args, exec) => JSON.stringify(await execute(args ?? {}, core.caller(exec), exec), null, 1),
    }), { allow: hubOnly, ...meta })

    /** `assistant_work` 每个动作要填的字段。 */
    const WORK_ACTIONS = Object.freeze({
        start: ['objective', 'workspace'],
        followup: ['workId', 'text'],
        pause: ['workId'],
        resume: ['workId'],
        cancel: ['workId'],
    })
    tool({
        name: 'assistant_work',
        description: 'Manage a piece of continuous work (hub only). Set `action` and the fields it needs. '
            + 'start (objective, workspace; optional deliverables, key): start the work in a new work session of a project; it keeps going across turns and restarts with a goal until the work session marks it complete or blocked, then its final report comes back to you (a report is not the user\'s acceptance). Same key with the same arguments returns the existing work. '
            + 'followup (workId, text): send a revision request or extra requirement; a finished or blocked work starts again with it. '
            + 'pause (workId; optional reason): pause a running work; it does not continue by itself, also not after a restart. '
            + 'resume (workId): let a paused work continue. '
            + 'cancel (workId; optional reason): cancel the work for good. '
            + 'Read state with assistant_work_status.',
        parameters: {
            action: { type: 'string', required: true, enum: Object.keys(WORK_ACTIONS), description: 'start, followup, pause, resume or cancel.' },
            objective: { type: 'string', description: 'start: what the work must achieve.' },
            deliverables: { type: 'array', items: { type: 'string' }, description: 'start: what must be delivered, one item each.' },
            workspace: { type: 'string', description: 'start: project id (from assistant_project_list).' },
            key: { type: 'string', description: 'start: your own id for this work, to make retries safe.' },
            workId: { type: 'string', description: 'followup, pause, resume, cancel: work id.' },
            text: { type: 'string', description: 'followup: what to change or add.' },
            reason: { type: 'string', description: 'pause, cancel: why.' },
        },
        execute: (args, who, exec) => {
            const needed = WORK_ACTIONS[args.action]
            if (needed === undefined) throw new Error(`action 只能是 ${Object.keys(WORK_ACTIONS).join('、')}`)
            const missing = needed.filter(field => typeof args[field] !== 'string' || args[field].trim() === '')
            if (missing.length > 0) throw new Error(`action ${args.action} 要填 ${missing.join('、')}`)
            switch (args.action) {
                case 'start': return start(args, who, { callId: exec?.callId === undefined ? undefined : String(exec.callId) })
                case 'followup': return followup(args.workId, { text: args.text, by: who })
                case 'pause': return pause(args.workId, { reason: args.reason, by: who })
                case 'resume': return resume(args.workId, { by: who })
                default: return cancel(args.workId, { reason: args.reason, by: who })
            }
        },
    }, { effect: 'write', destructive: true })
    tool({
        name: 'assistant_work_status',
        description: 'Read works (hub only). With workId: the state of one work (phase, who paused it, the last error, the last report). '
            + 'Without workId: the list of works, newest first, optionally of one project (workspace).',
        parameters: {
            workId: { type: 'string', description: 'Work id; omit to list.' },
            workspace: { type: 'string', description: 'When listing: only works of this project.' },
        },
        execute: args => (typeof args.workId === 'string' && args.workId !== '' ? status(args.workId) : list({ workspace: args.workspace })),
    }, { effect: 'read' })
}
