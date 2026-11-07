import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply, Config, REFLECTION_FACT } from '../index.js'
import { noticeText, progressText, roundOutcome, taskIdOf, taskIdOfSession } from '../tasks.js'

const MAIN = 'session-main'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 只模拟本插件用到的 Host 表面：会话、项目、存储、事件，和框架核心（放进会话、额度、出口通知、工具声明、调用方与角色）。
 * 核心的真实行为另有 `framework.test.mjs` 接真的核心核对。
 * @param options.notice - 出口通知的回答；给了就当项目会话由出口接着（`served` 可以另给接着的会话）。
 * @param options.place - 放进会话的回答（默认照常放进去）。
 */
async function harness({ projectDir, reconcileDelayMs = 1_000_000, notice, served, projectSessions = [], quota, place, reflection, config: extra = {} } = {}) {
    const events = new Map()
    const agents = new Map()
    const handlers = new Map()
    const tools = new Map()
    const records = new Map()
    const renamed = []
    const delivered = []
    const notices = []
    const reports = []
    const assigned = []
    const toolMeta = new Map()
    const roles = new Map([[MAIN, 'hub']])
    const servedIds = new Set(notice === undefined ? [] : (served ?? projectSessions.map(item => item.id)))
    const titles = new Map(projectSessions.map(item => [item.id, item.title]))
    let seq = 0
    const push = (sessionId, type, data) => {
        if (!events.has(sessionId)) events.set(sessionId, [])
        events.get(sessionId).push({ type, seq: ++seq, time: Date.now(), data })
    }
    const makeAgent = (sessionId) => {
        const agent = {
            session: { id: sessionId, header: {} },
            selected: null,
            inbox: [],
            cancels: 0,
            model: { select: (selection) => { agent.selected = selection } },
            followup: (message) => {
                agent.inbox.push(message)
                push(sessionId, 'agent/inbox/spliced', { inserted: [message] })
            },
            cancel: () => { agent.cancels += 1 },
        }
        agents.set(sessionId, agent)
        return agent
    }
    const main = makeAgent(MAIN)
    const workspace = { id: 'ws-1', title: '示例书', path: projectDir ?? tmpdir(), sessionIds: projectSessions.map(item => item.id) }
    const workspaces = [workspace]
    const view = item => ({ workspaceId: item.id, title: item.title, path: item.path, sessionIds: item.sessionIds })
    const services = {
        workspaceRegistry: {
            archivedSessionIds: [],
            get: id => workspaces.find(item => item.id === id),
            list: () => workspaces,
        },
        workspaceController: {
            create: async ({ path }) => {
                const existing = workspaces.find(item => resolve(item.path) === resolve(path))
                if (existing !== undefined) return { workspace: view(existing), created: false }
                const made = { id: `ws-${workspaces.length + 1}`, title: path.split(/[\/]/).pop(), path: resolve(path), sessionIds: [] }
                workspaces.push(made)
                return { workspace: view(made), created: true }
            },
            rename: async ({ workspaceId, title }) => {
                const item = workspaces.find(candidate => candidate.id === workspaceId)
                item.title = title
                return { workspace: view(item) }
            },
        },
        sessionController: {
            create: async ({ workspaceId, sessionId }) => {
                const owner = workspaces.find(item => item.id === workspaceId)
                assert.ok(owner, `workspace ${workspaceId}`)
                makeAgent(sessionId)
                owner.sessionIds.push(sessionId)
                return { sessionId }
            },
            rename: async (request) => { renamed.push(request); titles.set(request.sessionId, request.title) },
            list: async () => ({ items: workspaces.flatMap(item => item.sessionIds).map(sessionId => ({ sessionId, running: false, updatedAt: 1, projections: { values: { title: titles.get(sessionId) ?? 't' } } })) }),
            // 公开的取 Agent：取不到时交回 `{ error }`，不抛。
            resolveAgent: async (sessionId) => {
                const agent = agents.get(String(sessionId))
                return agent === undefined ? { error: new Error('not found') } : { agent }
            },
        },
    }
    const disposers = []
    const provided = {}
    /** 这条消息（按编号）已经在会话里了：收件箱或日志里有。 */
    const placedBefore = (sessionId, id) => id !== undefined && ((agents.get(sessionId)?.inbox ?? []).some(message => message.id === id)
        || (events.get(sessionId) ?? []).some(event => event.data?.id === id || (event.data?.inserted ?? []).some(message => message.id === id)))
    let nextId = 0
    const core = {
        caller: (exec) => {
            const sessionId = String(exec.agent.session.id)
            return { kind: 'session', sessionId, role: roles.get(sessionId) ?? null }
        },
        sessions: {
            roleOf: id => roles.get(String(id)) ?? null,
            assign: async (id, role, { label, by }) => {
                roles.set(String(id), role)
                assigned.push({ sessionId: String(id), role, label, by })
            },
        },
        deliver: async (to, message) => {
            const answer = place?.(to, message)
            if (answer !== undefined) return answer
            const agent = agents.get(to)
            if (agent === undefined) return { status: 'unavailable', reason: `会话 ${to} 取不到` }
            if (placedBefore(to, message.id)) return { status: 'duplicate', messageId: message.id }
            const id = message.id ?? `m-${++nextId}`
            delivered.push({ to, ...message })
            agent.followup({ id, role: 'user', content: [{ type: 'text', text: message.text }], source: { ...message.source, speaker: message.speaker, ...message.reply === undefined ? {} : { reply: message.reply } } })
            return { status: 'delivered', messageId: id }
        },
        quota: { state: async () => quota?.value.state ?? 'unknown' },
        exits: {
            servedBy: id => (servedIds.has(id) ? [{ exit: 'qq', sessionId: id, as: 'group' }] : []),
            notify: async (sessionIds, request) => {
                notices.push({ sessionIds, ...request })
                return notice(request)
            },
        },
        declareSource: () => () => {},
        segment: () => () => {},
        tool: (definition, meta) => {
            tools.set(definition.name, definition)
            toolMeta.set(definition.name, meta)
            return () => tools.delete(definition.name)
        },
        report: (kind, detail) => { reports.push({ kind, ...detail }) },
    }
    const ctx = {
        core,
        agents: { get: id => agents.get(String(id)) },
        sessions: { flush: async () => true },
        sessionQuery: {
            observeSession: async (id) => {
                if (!events.has(String(id))) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
                return { events: events.get(String(id)), dispose() {} }
            },
        },
        storageDomain: {
            open: async () => ({
                table: () => ({
                    get: key => records.get(key),
                    entries: () => records.entries(),
                    put: async (key, value) => { records.set(key, structuredClone(value)) },
                }),
                close() {},
            }),
        },
        on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
        effect: (fn) => { disposers.push(fn()) },
        provide: (name, value) => { provided[name] = value },
        get: name => services[name],
        // 后台思考只在测试要的时候在：交来的事实行记进 contributed。
        inject: (names, apply) => {
            if (names.includes('reflection') && reflection !== undefined) {
                apply({ reflection, effect: (fn) => { disposers.push(fn()) } })
            }
        },
        logger: { warn: () => {} },
    }
    // 这里的测试按配了 Claude Code 提供方写；不配时的默认（用 DSH 的默认模型）另有一条。
    const config = new Config({ provider: 'agent-sdk', models: ['opus', 'sonnet'], defaultModel: 'opus', reconcileDelayMs, ...extra })
    apply(ctx, config)
    let calls = 0
    const call = async (tool, args, caller = main) => JSON.parse(await tools.get(tool).execute(args, {
        agent: caller,
        callId: `call-${++calls}`,
        signal: new AbortController().signal,
    }))
    /** 任务会话开始一轮：取用输入。 */
    const startTurn = (sessionId) => {
        const agent = agents.get(sessionId)
        const turn = (events.get(sessionId) ?? []).filter(event => event.type === 'turn/start').length + 1
        push(sessionId, 'turn/start', { turn })
        for (const message of agent.inbox.splice(0)) push(sessionId, 'user/message', message)
        return turn
    }
    /** 让任务会话完成一轮：没开始就先开始，然后回复、结束，并发出 turn/end。 */
    const finishTurn = async (sessionId, reply, reason = 'completed') => {
        const list = events.get(sessionId) ?? []
        const opened = list.filter(event => event.type === 'turn/start').length
        const closedTurns = list.filter(event => event.type === 'turn/end').length
        const turn = opened > closedTurns ? opened : startTurn(sessionId)
        push(sessionId, 'assistant/message', { turn, message: { content: [{ type: 'text', text: reply }] } })
        push(sessionId, 'turn/end', { turn, reason: { kind: reason } })
        handlers.get('session/event')({ id: sessionId }, { type: 'turn/end' })
        await sleep(650)
    }
    /** 放进中枢的（回报）。 */
    const toMain = () => delivered.filter(item => item.to === MAIN)
    return { ctx, provided, tools, toolMeta, call, records, agents, main, events, renamed, toMain, delivered, notices, reports, assigned, roles, startTurn, finishTurn, makeAgent, dispose: () => disposers.forEach(fn => fn()) }
}

test('改派：进行中的一轮被中止，新要求等它结束再发，下一轮照常回报', async (t) => {
    const h = await harness()
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '写全本大纲' })
    const worker = h.agents.get(task.sessionId)
    h.startTurn(task.sessionId)
    const redirected = await h.call('assistant_task_review', { taskId: task.taskId, decision: 'revise', feedback: '只交两样，不写全本' })
    assert.equal(redirected.state, 'running')
    assert.equal(redirected.round, 2)
    assert.equal(worker.cancels, 1)
    assert.equal(worker.inbox.length, 0, '被中止的回合结束前不发')

    await h.finishTurn(task.sessionId, '写到一半', 'cancelled')
    assert.equal(h.toMain().length, 0, '被中止的一轮不回报')
    assert.equal(worker.inbox.length, 1)
    assert.match(worker.inbox[0].content[0].text, /进行中改了要求[\s\S]*git status[\s\S]*只交两样/)

    await h.finishTurn(task.sessionId, '两样交了')
    assert.equal(h.toMain().length, 1)
    assert.equal(h.toMain()[0].key, `${task.taskId}-r2`)
    const view = await h.call('assistant_task_status', { taskId: task.taskId })
    assert.equal(view.rounds[0].report, null)
    assert.equal(view.rounds[0].review.interrupted, true)
    assert.equal(view.rounds[1].report.text, '两样交了')
})

test('任务编号由发起会话与调用编号决定；任务会话可反查任务', () => {
    const id = taskIdOf('s', 'c')
    assert.match(id, /^task-[0-9a-f]{24}$/)
    assert.equal(taskIdOf('s', 'c'), id)
    assert.equal(taskIdOfSession(`session-${id}`), id)
    assert.equal(taskIdOfSession('session-abc'), undefined)
})

test('roundOutcome：取请求所在回合最后一段模型文字；回合未结束为 null', () => {
    const events = [
        { type: 'turn/start', seq: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 2, data: { id: 'r1' } },
        { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: '先看看' }] } } },
        { type: 'assistant/message', seq: 4, data: { turn: 1, message: { content: [{ type: 'text', text: '报告' }] } } },
    ]
    assert.equal(roundOutcome(events, 'r1'), null)
    events.push({ type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } })
    assert.deepEqual(roundOutcome(events, 'r1'), { outcome: 'completed', text: '报告', turn: 1, endSeq: 5 })
    assert.equal(roundOutcome(events, 'r2'), null)
})

test('回报截断过长的报告并提示读全文', () => {
    const task = { title: 'T', taskId: 'task-1', workspaceTitle: 'P' }
    const text = noticeText(task, { round: 1, report: { outcome: 'error', text: 'x'.repeat(20) } }, { reportChars: 5 })
    assert.match(text, /没有正常结束：error/)
    assert.match(text, /xxxxx\n（报告共 20 字/)
})

test('派发：在项目下建会话、登记成 worker（标签 task）、命名、选模型，经核心交给委派（本插件说的、回复不外发）；同一调用重试不重复派出', async (t) => {
    const h = await harness()
    t.after(h.dispose)
    const tool = h.tools.get('assistant_task_dispatch')
    const exec = { agent: h.main, callId: 'call-x', signal: new AbortController().signal }
    const args = { workspaceId: 'ws-1', title: '润色样本文档', instructions: '按大纲润色样本文档', deliverables: ['样本文档新稿'] }
    const first = JSON.parse(await tool.execute(args, exec))
    const again = JSON.parse(await tool.execute(args, exec))
    assert.equal(again.taskId, first.taskId)
    assert.equal(first.state, 'running')
    assert.equal(first.roundSent, true)
    const agent = h.agents.get(first.sessionId)
    assert.deepEqual(agent.selected, { provider: 'agent-sdk', model: 'opus' })
    assert.deepEqual(h.renamed, [{ sessionId: first.sessionId, title: '任务·润色样本文档' }])
    assert.equal(agent.inbox.length, 1, '只交给一次')
    assert.equal(agent.inbox[0].source.kind, 'galatea-task')
    assert.deepEqual(agent.inbox[0].source.speaker, { kind: 'program', plugin: 'project-tasks-framework' })
    assert.deepEqual(agent.inbox[0].source.reply, { to: 'none' }, '任务会话的回复不往外发')
    assert.match(agent.inbox[0].content[0].text, /按大纲润色样本文档[\s\S]*样本文档新稿[\s\S]*项目概述\.md/)
    assert.equal(h.delivered[0].link, first.taskId)
    assert.deepEqual(h.assigned.map(item => [item.sessionId, item.role, item.label]), [[first.sessionId, 'worker', 'task']])
    assert.deepEqual(h.assigned[0].by, { kind: 'program', plugin: 'project-tasks-framework' })
})

test('回报：经核心放进中枢（不写回复去向，出口按中枢的规则发）；返修回到同一会话，下一轮再回报；接受后结束', async (t) => {
    const h = await harness()
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    await assert.rejects(h.call('assistant_task_review', { taskId: task.taskId, decision: 'accept' }), /还没有结束/)

    await h.finishTurn(task.sessionId, '第一版完成，提交 abc123')
    assert.equal(h.toMain().length, 1)
    assert.equal(h.toMain()[0].key, `${task.taskId}-r1`)
    assert.match(h.toMain()[0].text, /项目任务回报[\s\S]*第一版完成，提交 abc123/)
    assert.equal(h.toMain()[0].reply, undefined, '回复去向不写')
    assert.deepEqual(h.toMain()[0].speaker, { kind: 'program', plugin: 'project-tasks-framework' })
    assert.equal(h.main.inbox[0].id, h.toMain()[0].id, '用记下的消息编号放进去')
    const reported = await h.call('assistant_task_status', { taskId: task.taskId })
    assert.equal(reported.state, 'reported')
    assert.equal(reported.rounds[0].noticeVia, 'session')
    assert.equal(reported.rounds[0].noticeDelivered, true)

    await h.call('assistant_task_review', { taskId: task.taskId, decision: 'revise', feedback: '格式不对' })
    const agent = h.agents.get(task.sessionId)
    assert.match(agent.inbox[0].content[0].text, /返修要求[\s\S]*格式不对/)
    await h.finishTurn(task.sessionId, '格式已调整')
    assert.equal(h.toMain().length, 2)
    assert.equal(h.toMain()[1].key, `${task.taskId}-r2`)

    const accepted = await h.call('assistant_task_review', { taskId: task.taskId, decision: 'accept', feedback: '可以' })
    assert.equal(accepted.state, 'accepted')
    const full = await h.call('assistant_task_status', { taskId: task.taskId })
    assert.equal(full.rounds[0].review.decision, 'revise')
    assert.equal(full.rounds[1].report.text, '格式已调整')
    assert.equal(full.rounds[1].review.decision, 'accept')
})

test('回报：没有正常结束的一轮照样交回中枢', async (t) => {
    const h = await harness()
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    await h.finishTurn(task.sessionId, '完成', 'error')
    assert.equal(h.main.inbox.length, 1)
    assert.equal(h.main.inbox[0].source.kind, 'galatea-task')
    assert.match(h.main.inbox[0].content[0].text, /没有正常结束：error/)
    const view = await h.call('assistant_task_status', { taskId: task.taskId })
    assert.equal(view.rounds[0].noticeVia, 'session')
    assert.equal(view.rounds[0].noticeDelivered, true)
})

test('回报放不进中枢时报出来、记录停在没送达，重启核对时用同一个消息编号再交，只交一次', async (t) => {
    let refuse = true
    const h = await harness({ reconcileDelayMs: 1_000, place: to => (to === MAIN && refuse ? { status: 'unavailable', reason: '会话取不到' } : undefined) })
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    await h.finishTurn(task.sessionId, '完成')
    assert.equal(h.main.inbox.length, 0)
    assert.deepEqual(h.reports.map(item => item.kind), ['project-tasks/notice-undelivered'])
    assert.match(h.reports[0].text, /回报没放进发起会话（会话取不到）/)
    const pending = h.records.get(task.taskId).rounds[0].notice
    assert.equal(pending.state, 'sending')
    refuse = false
    await sleep(900)
    assert.equal(h.main.inbox.length, 1)
    assert.equal(h.main.inbox[0].id, pending.messageId)
    assert.equal(h.records.get(task.taskId).rounds[0].notice.state, 'delivered')
})

test('取消：中断进行中的一轮；只有中枢能派任务（任务会话、子代理都不行）', async (t) => {
    const h = await harness()
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    const worker = h.agents.get(task.sessionId)
    await assert.rejects(h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'U', instructions: '再派' }, worker), /只有中枢/)
    // 核心把子代理算成它的父会话（这里是中枢），所以由插件自己挡。
    const sub = { ...h.main, session: { id: MAIN, header: { origin: 'subagent' } } }
    await assert.rejects(h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'V', instructions: '再派' }, sub), /子代理/)
    const canceled = await h.call('assistant_task_review', { taskId: task.taskId, decision: 'cancel' })
    assert.equal(canceled.state, 'canceled')
    assert.equal(worker.cancels, 1)
    await assert.rejects(h.call('assistant_task_review', { taskId: task.taskId, decision: 'revise', feedback: 'x' }), /已取消/)
})

test('项目列表：带概述开头、会话与任务计数', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'project-tasks-'))
    await writeFile(join(dir, '项目概述.md'), '# 项目概述\n样本文档待润色')
    const h = await harness({ projectDir: dir })
    t.after(h.dispose)
    await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    const { projects } = await h.call('assistant_project_list', {})
    assert.equal(projects.length, 1)
    assert.equal(projects[0].overview.file, '项目概述.md')
    assert.match(projects[0].overview.text, /样本文档待润色/)
    assert.equal(projects[0].tasks.running, 1)
    assert.equal(projects[0].sessions[0].taskId !== null, true)
    const read = await h.call('assistant_task_status', { state: 'running' })
    assert.equal(read.tasks[0].project, '示例书')
})

test('注册项目：新目录注册并命名；已注册的目录原样返回；目录不存在时报错，除非要求新建', async (t) => {
    const projectDir = await mkdtemp(join(tmpdir(), 'project-tasks-'))
    const h = await harness({ projectDir })
    t.after(h.dispose)
    const fresh = await mkdtemp(join(tmpdir(), 'project-new-'))
    const made = await h.call('assistant_project_create', { name: '示例二', directory: fresh })
    assert.equal(made.created, true)
    assert.equal(made.title, '示例二')
    assert.equal(made.workspaceId, 'ws-2')
    assert.match(made.next, /assistant_task_dispatch/)
    const { projects } = await h.call('assistant_project_list', {})
    assert.deepEqual(projects.map(project => project.title), ['示例书', '示例二'])

    const again = await h.call('assistant_project_create', { name: '别的名字', directory: projectDir })
    assert.equal(again.created, false)
    assert.equal(again.workspaceId, 'ws-1')
    assert.equal(again.title, '示例书')

    const missing = join(fresh, '星图')
    await assert.rejects(h.tools.get('assistant_project_create').execute({ name: '星图', directory: missing }, { agent: h.main, callId: 'c-x' }), /不存在.*createDirectory/)
    await assert.rejects(h.tools.get('assistant_project_create').execute({ name: 'x', directory: 'relative/dir' }, { agent: h.main, callId: 'c-y' }), /绝对路径/)
    const built = await h.call('assistant_project_create', { name: '星图', directory: missing, createDirectory: true })
    assert.equal(built.created, true)
    assert.equal((await stat(missing)).isDirectory(), true)

    const task = h.makeAgent('session-task-abc')
    await assert.rejects(h.tools.get('assistant_project_create').execute({ name: 'y', directory: fresh }, { agent: task, callId: 'c-z' }), /只有中枢/)
})

test('注册项目：保证有长期的项目会话；早先登记、还没有的再调一次就补上，已有的不重复建', async (t) => {
    const projectDir = await mkdtemp(join(tmpdir(), 'project-tasks-'))
    const h = await harness({ projectDir })
    t.after(h.dispose)
    const fresh = await mkdtemp(join(tmpdir(), 'project-new-'))
    const made = await h.call('assistant_project_create', { name: '示例二', directory: fresh })
    assert.equal(made.projectSession.created, true)
    assert.equal(made.projectSession.title, '示例二·项目会话')
    assert.ok(h.renamed.some(request => request.sessionId === made.projectSession.sessionId && request.title === '示例二·项目会话'))
    assert.deepEqual(h.agents.get(made.projectSession.sessionId).selected, { provider: 'agent-sdk', model: 'opus' })
    assert.equal(h.roles.get(made.projectSession.sessionId), 'worker', '项目会话也登记成 worker')
    assert.equal(h.assigned.find(item => item.sessionId === made.projectSession.sessionId).label, '项目会话')

    const again = await h.call('assistant_project_create', { name: '示例二', directory: fresh })
    assert.equal(again.projectSession.created, false, '已有的不重复建')
    assert.equal(again.projectSession.sessionId, made.projectSession.sessionId)

    // 早先登记的「示例书」只有别的会话、没有项目会话：再调一次补上。
    const old = await h.call('assistant_project_create', { name: '示例书', directory: projectDir })
    assert.equal(old.created, false)
    assert.equal(old.projectSession.created, true)
    assert.equal(old.projectSession.title, '示例书·项目会话')
})

test('重启核对：请求已进入任务会话但未记下时不重发，只补记已发送', async (t) => {
    const h = await harness({ reconcileDelayMs: 50 })
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    const record = h.records.get(task.taskId)
    h.records.set(task.taskId, { ...record, rounds: [{ ...record.rounds[0], sentAt: null }] })
    await sleep(700)
    assert.equal(h.agents.get(task.sessionId).inbox.length, 1, '不重复交给任务会话')
    assert.notEqual(h.records.get(task.taskId).rounds[0].sentAt, null)
})

/* ------------------------------ 任务进度发到项目的 群 ------------------------------ */

const PROJECT_SESSIONS = [{ id: 'session-other', title: '设定讨论' }, { id: 'session-project', title: '示例书·项目会话' }]

test('进度文字：开始、返修、改派、做完、没做成（原因译成词，不认识的照原样）、验收通过、取消；标题过长截断', () => {
    const task = { title: 'T' }
    assert.equal(progressText(task, { round: 1 }, 'start'), '【任务】开始做「T」。')
    assert.equal(progressText(task, { round: 2 }, 'revise'), '【任务】「T」按验收意见返修（第 2 轮）。')
    assert.equal(progressText(task, { round: 3 }, 'redirect'), '【任务】「T」要求改了，重新开始（第 3 轮）。')
    assert.equal(progressText(task, { round: 1 }, 'done'), '【任务】「T」做完了，等中枢验收。')
    assert.equal(progressText(task, { round: 1, report: { outcome: 'error' } }, 'failed'), '【任务】「T」这一轮没有正常结束（出错），中枢会看。')
    assert.equal(progressText(task, { round: 1, report: { outcome: 'max_turns' } }, 'failed'), '【任务】「T」这一轮没有正常结束（max_turns），中枢会看。')
    assert.equal(progressText(task, { round: 1 }, 'accepted'), '【任务】「T」验收通过。')
    assert.equal(progressText(task, { round: 1 }, 'canceled'), '【任务】「T」已取消。')
    assert.equal(progressText({ title: '长'.repeat(50) }, { round: 1 }, 'start'), `【任务】开始做「${'长'.repeat(40)}…」。`)
})

test('任务进度：派出、做完、返修、没做成、验收各经核心的出口通知发一句；项目会话排在最前、任务会话不算；键按任务、轮次与事件', async (t) => {
    const h = await harness({ notice: async () => ({ status: 'sent', exit: 'qq' }), projectSessions: PROJECT_SESSIONS })
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    await sleep(20)
    assert.equal(h.notices.length, 1)
    assert.deepEqual(h.notices[0].sessionIds, ['session-project', 'session-other'])
    assert.equal(typeof h.notices[0].at, 'number')
    assert.deepEqual([h.notices[0].key, h.notices[0].text], [`${task.taskId}-r1-start`, '【任务】开始做「T」。'])

    await h.finishTurn(task.sessionId, '完成')
    assert.deepEqual([h.notices[1].key, h.notices[1].text], [`${task.taskId}-r1-end`, '【任务】「T」做完了，等中枢验收。'])
    await h.call('assistant_task_review', { taskId: task.taskId, decision: 'revise', feedback: '再改改' })
    await sleep(20)
    assert.deepEqual([h.notices[2].key, h.notices[2].text], [`${task.taskId}-r2-start`, '【任务】「T」按验收意见返修（第 2 轮）。'])
    await h.finishTurn(task.sessionId, '没改完', 'error')
    assert.deepEqual([h.notices[3].key, h.notices[3].text], [`${task.taskId}-r2-end`, '【任务】「T」这一轮没有正常结束（出错），中枢会看。'])
    await h.call('assistant_task_review', { taskId: task.taskId, decision: 'accept' })
    await sleep(20)
    assert.deepEqual([h.notices[4].key, h.notices[4].text], [`${task.taskId}-r2-accept`, '【任务】「T」验收通过。'])
    assert.equal(h.notices.length, 5)
})

test('任务进度：取消发“已取消”；改派后的一轮发“要求改了”，被中止的那一轮不发“没做成”', async (t) => {
    const h = await harness({ notice: async () => ({ status: 'sent', exit: 'qq' }), projectSessions: PROJECT_SESSIONS })
    t.after(h.dispose)
    const first = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'A', instructions: '做' })
    await h.call('assistant_task_review', { taskId: first.taskId, decision: 'cancel' })
    await sleep(20)
    assert.deepEqual(h.notices.map(item => item.key), [`${first.taskId}-r1-start`, `${first.taskId}-r1-cancel`])
    assert.equal(h.notices[1].text, '【任务】「A」已取消。')

    const second = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'B', instructions: '做' })
    h.startTurn(second.sessionId)
    await h.call('assistant_task_review', { taskId: second.taskId, decision: 'revise', feedback: '换个做法' })
    await h.finishTurn(second.sessionId, '做到一半', 'cancelled')
    const keys = h.notices.map(item => item.key)
    assert.ok(!keys.includes(`${second.taskId}-r1-end`), '被中止的一轮不发')
    assert.equal(h.notices.find(item => item.key === `${second.taskId}-r2-start`).text, '【任务】「B」要求改了，重新开始（第 2 轮）。')
})

test('任务进度：出口报错不影响任务；项目里没有哪个会话接着出口时不发', async (t) => {
    const h = await harness({ notice: async () => { throw new Error('出口坏了') } })
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    await h.finishTurn(task.sessionId, '完成')
    assert.equal(h.toMain().length, 1, '回报照常')
    assert.equal(h.notices.length, 0, '项目里只有任务会话，没有接着出口的会话')

    const failing = await harness({ notice: async () => { throw new Error('出口坏了') }, projectSessions: PROJECT_SESSIONS })
    t.after(failing.dispose)
    const other = await failing.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    await failing.finishTurn(other.sessionId, '完成')
    assert.equal(failing.toMain().length, 1, '出口报错时回报照常')
    assert.equal(failing.notices.length, 2)

    const unserved = await harness({ notice: async () => ({ status: 'sent', exit: 'qq' }), served: [], projectSessions: PROJECT_SESSIONS })
    t.after(unserved.dispose)
    const third = await unserved.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    await unserved.finishTurn(third.sessionId, '完成')
    assert.equal(unserved.notices.length, 0, '项目会话都没接群（项目本来就没接群）：不发，不算没发出')
})

test('任务进度：重启核对时对已发出的轮补调一次“开始”、对已回报的轮补调一次“结束”（渠道按键去重）', async (t) => {
    const h = await harness({ reconcileDelayMs: 50, notice: async () => ({ status: 'sent', exit: 'qq' }), projectSessions: PROJECT_SESSIONS })
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'T', instructions: '做' })
    await sleep(700)
    assert.equal(h.notices.filter(item => item.key === `${task.taskId}-r1-start`).length, 2, '派出时一次，启动核对补调一次（出口按键去重）')

    // 启动核对在回报之后才跑：任务停在 reported，补调一次“结束”，不补“开始”。
    const later = await harness({ reconcileDelayMs: 1_000, notice: async () => ({ status: 'sent', exit: 'qq' }), projectSessions: PROJECT_SESSIONS })
    t.after(later.dispose)
    const done = await later.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: 'U', instructions: '做' })
    await later.finishTurn(done.sessionId, '完成')
    assert.equal(later.records.get(done.taskId).state, 'reported')
    await sleep(900)
    assert.equal(later.notices.filter(item => item.key === `${done.taskId}-r1-end`).length, 2)
    assert.equal(later.notices.filter(item => item.key === `${done.taskId}-r1-start`).length, 1)
})

test('在跑的任务（Watchdog 只读查看）：任务会话最后一次活动的时间；回报后不再列出', async (t) => {
    const h = await harness()
    t.after(h.dispose)
    const before = Date.now()
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: '润色', instructions: '润色样本文档' })
    h.startTurn(task.sessionId)
    const [running] = await h.provided.assistantProjectTasks.running()
    assert.equal(running.taskId, task.taskId)
    assert.equal(running.sessionId, task.sessionId)
    assert.equal(running.round, 1)
    assert.equal(running.project, '示例书')
    assert.ok(running.lastActivityAt >= before)
    await h.finishTurn(task.sessionId, '做完了')
    assert.deepEqual(await h.provided.assistantProjectTasks.running(), [])
})

test('额度用完（问核心 quota.state(任务会话)）：委派先不发、告诉派任务的会话会自动发出；恢复后隔一会儿再看时照常发出，只发一次', async (t) => {
    const quota = { value: { state: 'limited', outageId: 'q1' } }
    const h = await harness({ quota, config: { quotaRetryMs: 30 } })
    t.after(h.dispose)
    const task = await h.call('assistant_task_dispatch', { workspaceId: 'ws-1', title: '润色样本文档', instructions: '按大纲润色' })
    assert.equal(task.roundSent, false)
    assert.match(task.note, /额度用完了，委派先留着，恢复后自动发出/)
    await sleep(80)
    assert.equal(h.agents.get(task.sessionId)?.inbox.length ?? 0, 0, '用完期间一直不发')
    quota.value = { state: 'ok' }
    await sleep(120)
    const agent = h.agents.get(task.sessionId)
    assert.equal(agent.inbox.length, 1)
    assert.equal(agent.inbox[0].source.kind, 'galatea-task')
    await sleep(80)
    assert.equal(agent.inbox.length, 1, '只发一次')
})

test('工具声明：读的 3 个谁都能用（外部调用方也给）；写的 3 个按写算、只给中枢', async (t) => {
    const h = await harness()
    t.after(h.dispose)
    for (const name of ['assistant_project_list', 'assistant_task_status']) {
        assert.deepEqual(h.toolMeta.get(name), { effect: 'read' }, name)
    }
    for (const name of ['assistant_project_create', 'assistant_task_dispatch', 'assistant_task_review']) {
        const meta = h.toolMeta.get(name)
        assert.equal(meta.effect, 'write', name)
        assert.equal(meta.allow({ kind: 'session', sessionId: MAIN, role: 'hub' }), true)
        assert.equal(meta.allow({ kind: 'session', sessionId: 's', role: 'worker' }), false)
        assert.equal(meta.allow({ kind: 'session', sessionId: 's', role: 'background' }), false)
        assert.equal(meta.allow({ kind: 'external', name: 'codex', readOnly: false }), false)
    }
})

test('没配模型提供方（默认）：任务会话不选模型、用 DSH 的默认模型；派任务时不能指定 model', async (t) => {
    const h = await harness({ config: { provider: '', models: [], defaultModel: '' } })
    t.after(h.dispose)
    const tool = h.tools.get('assistant_task_dispatch')
    const exec = { agent: h.main, callId: 'call-default', signal: new AbortController().signal }
    const args = { workspaceId: 'ws-1', title: '整理笔记', instructions: '把这周的笔记按主题归类', deliverables: ['归类后的笔记'] }
    const first = JSON.parse(await tool.execute(args, exec))
    assert.equal(first.state, 'running')
    assert.equal(h.agents.get(first.sessionId).selected ?? null, null, '不选模型')
    await assert.rejects(tool.execute({ ...args, model: 'opus' }, { ...exec, callId: 'call-default-2' }), /没有配置任务会话的模型提供方/)
})

test('后台思考在时，往它醒来时的事实段交一行：去哪看各项目和任务；卸载时收回；没装后台思考也照常装上', async (t) => {
    const contributed = new Map()
    const reflection = { contribute: (name, lines) => { contributed.set(name, lines); return () => contributed.delete(name) } }
    const h = await harness({ reflection })
    assert.deepEqual(await contributed.get('项目任务')(), [REFLECTION_FACT])
    assert.match(REFLECTION_FACT, /assistant_project_list[\s\S]*assistant_task_status/)
    h.dispose()
    assert.equal(contributed.has('项目任务'), false)
    const bare = await harness()
    t.after(bare.dispose)
    assert.ok(bare.tools.has('assistant_project_list'))
})
