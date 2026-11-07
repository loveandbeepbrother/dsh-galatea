/**
 * 项目任务接到框架核心上：真的核心、上游真的会话控制器和项目登记、真的工具解析。
 * 中枢的模型调 assistant_task_dispatch 派任务，任务会话做完一轮，回报回到中枢。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import SessionTitleService from '@deepseek-ai/dsh-session-title'

import * as TasksModule from '../index.js'
import { TASK_SOURCE } from '../tasks.js'
import { ROUTE, createUserMessage, makeHarness, waitFor } from '../../framework/test/harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })
const SPEAKER = Object.freeze({ kind: 'program', plugin: 'project-tasks-framework' })

function* text(body) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCall(id, name, args) {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

test('中枢派任务：任务会话建在项目里、登记成 worker；委派是本插件说的、回复不外发；做完的回报放回中枢；写的工具只交给中枢', async (t) => {
    const h = await makeHarness(t, { controller: true })
    // 任务会话要改名（任务·标题），真实 DSH 里由上游的会话标题服务做。
    const titles = await h.ctx.plugin(SessionTitleService, { fallbackMaxWords: 12, fallbackMaxBytes: 120, maxTitleBytes: 200 })
    t.after(() => titles.dispose())
    const reports = []
    h.ctx.core.onReport(item => reports.push(item))
    // 注册时先原样交来核心启动时报的（设施里替身执行方缺的能力、还没定中枢），这些在派任务之前，不算。
    const startup = reports.length
    const novel = join(h.workDirectory, 'novel')
    await mkdir(novel, { recursive: true })
    const project = await h.ctx.workspaceRegistry.create(novel, '小说')
    const main = await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: BY })
    const fiber = await h.ctx.plugin(TasksModule, {
        provider: ROUTE.provider, models: [ROUTE.model], defaultModel: ROUTE.model, reconcileDelayMs: 3_600_000,
    })
    t.after(() => fiber.dispose())

    // 模型按会话作答：中枢第一次调派任务的工具，任务会话交报告，其余回一句。
    let dispatched = false
    const route = function* (options) {
        const sessionId = String(options.sessionId)
        if (sessionId === 'main' && !dispatched) {
            dispatched = true
            yield* toolCall('call-dispatch', 'assistant_task_dispatch', { workspaceId: String(project.id), title: '润色第三章', instructions: '按大纲润色第三章' })
            return
        }
        if (sessionId.startsWith('session-task-')) {
            yield* text('第三章改完了，提交 abc123')
            return
        }
        yield* text('好')
    }
    h.adapter.scripts.push(...Array.from({ length: 12 }, () => route))
    main.followup(createUserMessage({ content: [{ type: 'text', text: '派个任务' }], source: { kind: 'user' } }))

    const reportsToHub = async () => (await h.events('main')).flatMap(event => (event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : []))
        .filter(message => message.source?.kind === TASK_SOURCE)
    await waitFor(async () => (await reportsToHub()).length === 1, '回报放回中枢', 300)

    const [report] = await reportsToHub()
    assert.deepEqual(report.source.speaker, SPEAKER)
    assert.equal(report.source.reply, undefined, '回复去向不写，出口按中枢的规则发')
    assert.match(report.content[0].text, /项目任务回报[\s\S]*第三章改完了，提交 abc123/)

    const taskSession = h.adapter.requests.map(request => String(request.sessionId)).find(id => id.startsWith('session-task-'))
    assert.ok(taskSession !== undefined, '任务会话跑过一轮')
    assert.equal(h.ctx.core.sessions.roleOf(taskSession), 'worker')
    assert.ok(h.ctx.workspaceRegistry.get(project.id).sessionIds.map(String).includes(taskSession), '任务会话建在项目里')
    const [request] = (await h.userMessages(taskSession)).filter(message => message.source?.kind === TASK_SOURCE)
    assert.deepEqual(request.source.speaker, SPEAKER)
    assert.deepEqual(request.source.reply, { to: 'none' })
    assert.match(request.content[0].text, /按大纲润色第三章/)

    // 工具：中枢的请求里有写的工具；任务会话（worker）只看得到读的。
    const toolsOf = sessionId => (h.adapter.requests.find(item => String(item.sessionId) === sessionId)?.tools ?? []).map(tool => tool.name)
    assert.ok(toolsOf('main').includes('assistant_task_dispatch'))
    assert.ok(toolsOf(taskSession).includes('assistant_task_status'))
    assert.ok(!toolsOf(taskSession).includes('assistant_task_dispatch'), '任务会话看不到派任务的工具')
    assert.equal(h.ctx.core.toolMeta('assistant_task_status').effect, 'read')
    assert.equal(h.ctx.core.toolMeta('assistant_task_review').effect, 'write')
    assert.deepEqual(reports.slice(startup).map(item => item.kind), [], '没有说话人缺失、没声明的工具、通知没发出这类异常')
})

test('怎么派、怎么做任务由本插件经会话开头段落交代：中枢看到派任务和交付的说明，项目会话看到执行者的说明，别的会话没有', async (t) => {
    const h = await makeHarness(t)
    await h.createSession('main')
    await h.createSession('work')
    await h.createSession('other')
    await h.ctx.core.sessions.setHub('main', { by: BY })
    await h.ctx.core.sessions.assign('work', 'worker', { by: BY })
    const fiber = await h.ctx.plugin(TasksModule, { reconcileDelayMs: 3_600_000 })
    t.after(() => fiber.dispose())
    const textOf = async sessionId => (await h.ctx.core.segments.open(`check-${sessionId}`, sessionId)).map(entry => entry.text).join('\n')
    const hub = await textOf('main')
    assert.ok(hub.includes(TasksModule.HUB_GUIDANCE))
    assert.match(TasksModule.HUB_GUIDANCE, /验收过的项目任务产出[^。]*present/, '验收过的产出用 present 交给用户')
    assert.ok((await textOf('work')).includes(TasksModule.WORKER_GUIDANCE))
    const other = await textOf('other')
    assert.ok(!other.includes(TasksModule.HUB_GUIDANCE) && !other.includes(TasksModule.WORKER_GUIDANCE))
})
