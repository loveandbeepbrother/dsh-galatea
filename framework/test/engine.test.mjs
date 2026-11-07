/**
 * 原生压缩引擎：阈值按兜底压缩线现算（守着对上游 private 方法的覆盖）、交接换新对话、交接文档太长时失败看得见、
 * 主动压缩、用量的 epoch。会话、tokenMeter、LLM 层都是上游真的，模型是假的提供方。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'

import * as ContextModule from '../context/index.js'
import { BOUNDARY_RECORD, HANDOFF_FAILED_KEY, HANDOFF_LEAD, MindCompactionEngine, SWITCH_LEAD, trimmedRecord } from '../context/engine.js'
import { RECENT_CUT, RECENT_LEAD, recentTurnsText } from '../context/recent.js'
import { ROUTE, createUserMessage, makeHarness, waitFor } from './harness.mjs'

/** 测试用的上游压缩配置：小窗口下不留余量、不留尾巴。 */
const ENGINE_CONFIG = { headroomTokens: 0, maxTokens: 500, retainTokens: 0 }

/** 一段够长的话：上游的摘要外面套着一段固定前言（约 130 token），被替换的内容要比它长，压缩才算缩短了。 */
const long = text => `${text}。${'这一段是为了让对话够长。'.repeat(80)}`

/** 一段带着指定输入用量的回复（tokenMeter 按它估当前上下文）。 */
function replyWithUsage(text, inputTokens) {
    return function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
    }
}

async function setup(t, { context = true, fallbackCompactAt = 3_000, presetEngine = false } = {}) {
    const h = await makeHarness(t, { tokenMeter: true })
    h.adapter.contextWindow = 10_000
    let presetCtx
    if (presetEngine) {
        // DSH 的 web 预设：每个 Agent 的子插件里隔离地带一份上游引擎，它的处理器排在框架的引擎前面。默认线是窗口的八成。
        presetCtx = h.ctx.isolate('compaction')
        const upstream = await presetCtx.plugin(BasicCompactionEngine, ENGINE_CONFIG)
        t.after(() => upstream.dispose())
    }
    const engine = await h.ctx.plugin(MindCompactionEngine, ENGINE_CONFIG)
    t.after(() => engine.dispose())
    if (context) {
        const fiber = await h.ctx.plugin(ContextModule, { remindFrom: 0, remindStep: 100_000, fallbackCompactAt })
        t.after(() => fiber.dispose())
    }
    const agent = await h.createSession('main')
    const turn = async (text, script) => {
        if (script !== undefined) h.adapter.scripts.push(script)
        const before = (await h.turnEnds('main')).length
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await waitFor(async () => (await h.turnEnds('main')).length === before + 1, `这一轮：${text}`)
    }
    const compactions = async () => (await h.events('main')).filter(event => event.type === 'compaction/end')
    return { h, agent, turn, compactions, presetCtx }
}

test('守护：上游的 compactPressure 还是能覆盖的方法；阈值按兜底压缩线现算（窗口 1 万、线 3 千，上下文 4 千就压），没设线时照上游的冻结配置', async (t) => {
    assert.equal(typeof BasicCompactionEngine.prototype.compactPressure, 'function',
        '上游把 compactPressure 改成真正的私有了：原生压缩引擎的阈值会退回冻结的配置，要改接法')
    assert.ok(Object.hasOwn(MindCompactionEngine.prototype, 'compactPressure'))

    const withFallback = await setup(t)
    await withFallback.turn(long('一'), replyWithUsage('答一', 4_000))
    await withFallback.turn('二')
    const done = await withFallback.compactions()
    assert.ok(done.some(event => event.data?.error === undefined), '过了兜底压缩线，步间压缩了')

    const frozen = await setup(t, { context: false })
    await frozen.turn(long('一'), replyWithUsage('答一', 4_000))
    await frozen.turn('二')
    assert.equal((await frozen.compactions()).length, 0, '没设兜底压缩线时照上游的默认比例，4 千不压')
})

test('兜底压缩线比窗口还大的模型：最晚压到窗口的八成，不等到快满', async (t) => {
    // 窗口一万，线两万：按线算是 1 以上，封在八成。
    const { turn, compactions } = await setup(t, { fallbackCompactAt: 20_000 })
    await turn(long('一'), replyWithUsage('答一', 8_500))
    await turn('二', replyWithUsage('答二', 10))
    assert.equal((await compactions()).filter(event => event.data?.error === undefined).length, 1, '过了八成就压了')
    const lower = await setup(t, { fallbackCompactAt: 20_000 })
    await lower.turn(long('一'), replyWithUsage('答一', 7_000))
    await lower.turn('二', replyWithUsage('答二', 10))
    assert.equal((await lower.compactions()).length, 0, '没到八成不压')
})

test('交接：等会话空下来换掉系统开头和最后一个节点之外的全部，换成交接文档；下一轮模型看到的是交接文档；epoch 变了；换完往经历库推交接标记', async (t) => {
    const { h, turn, compactions } = await setup(t)
    const ExperienceModule = await import('../experience/index.js')
    const experience = await h.ctx.plugin(ExperienceModule, { archiveFile: join(h.root, 'experience.sqlite'), pullSeconds: 0, startupDelaySeconds: 3600 })
    t.after(() => experience.dispose())
    await turn(long('第一章写好了吗'))
    await turn(long('接着写第二章'))
    const before = await h.ctx.context.usage('main')
    const doc = join(h.root, '交接.md')
    await writeFile(doc, '进行中：第三章，写到一半。')
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: true })
    await waitFor(async () => (await compactions()).length === 1, '交接完成')
    assert.equal((await compactions())[0].data?.error, undefined)
    const after = await h.ctx.context.usage('main')
    assert.notEqual(after.epoch, before.epoch, '换新对话后 epoch 变了')
    // 交接标记是换完以后推进经历库的，和换新对话不是同一步：等它到。
    const readMarks = () => h.ctx.experience.read({ sessionId: 'main', marker: 'handoff' }, { kind: 'external', name: 't', readOnly: true }).then(answer => answer.entries, () => [])
    await waitFor(async () => (await readMarks()).length > 0, '交接标记进了经历库')
    const marks = await readMarks()
    assert.match(marks[0].text, /交接到新对话，交接文档：.*交接\.md/)
    await turn('继续')
    const sent = JSON.stringify(h.adapter.requests.at(-1).messages)
    assert.ok(sent.includes(HANDOFF_LEAD) && sent.includes('进行中：第三章，写到一半。'), '下一轮带着交接文档')
    assert.ok(!sent.includes('第一章写好了吗'), '旧的对话换掉了')
})

test('最近几轮原文：只有本人的话和最终回复，连发算一次，转来的和不发的不带；上限从最旧的截；这一轮的输入和交接之后的不算', async () => {
    const said = (id, text, speaker = { kind: 'user' }, annotation) => ({
        type: 'user/message',
        data: { id, role: 'user', source: { kind: 'user', speaker, ...annotation === undefined ? {} : { annotation } }, content: [{ type: 'text', text: annotation === undefined ? text : `${annotation}\n${text}` }] },
    })
    const replied = (turn, ...blocks) => ({ type: 'assistant/message', data: { turn, message: { content: blocks } } })
    const text = value => ({ type: 'text', text: value })
    const events = [
        said('u1', '第一轮'), replied(1, text('答一')),
        said('u2', '手机上连发一'), said('u3', '连发二', { kind: 'user' }, '（来自 QQ 私聊）'),
        replied(2, text('中途的话'), { type: 'tool-call', name: 'x' }, text('答二')),
        said('x1', '外部调用方转来的', { kind: 'external', name: 'claude-dev' }, '（以下来自外部调用方）'), replied(3, text('[不发]')),
        { type: 'runtime-context', data: { text: '快照' } },
        said('u4', '第三轮'), replied(4, text('答三')),
        said('u5', '交接之后才说的'),
    ]
    const all = recentTurnsText(events, { turns: 5, chars: 8_000, before: ['u5'] })
    assert.ok(all.startsWith(RECENT_LEAD))
    assert.match(all, /用户：手机上连发一\n\n用户：连发二\n\n你：答二/, '连发算一轮，来源行不带，只留最终文字')
    assert.ok(!all.includes('来自 QQ') && !all.includes('中途的话') && !all.includes('转来的') && !all.includes('不发') && !all.includes('快照'))
    assert.ok(!all.includes('交接之后才说的'), '这一轮要交的不算')
    const two = recentTurnsText(events, { turns: 2, chars: 8_000, before: ['u5'] })
    assert.ok(!two.includes('第一轮') && two.includes('答二') && two.includes('答三'), '只带最近两轮')
    const cut = recentTurnsText(events, { turns: 5, chars: 6, before: ['u5'] })
    assert.ok(cut.includes(RECENT_CUT) && cut.endsWith('你：答三'), '超上限从最旧的截，写明截过')
    assert.equal(recentTurnsText(events, { turns: 0, chars: 8_000 }), '', '0 就是不带')
    assert.equal(recentTurnsText([], { turns: 5, chars: 8_000 }), '')
})

test('交接后下一轮带着最近几轮原文，放在交接文档后面；放不下时只留文档，交接照样做成', async (t) => {
    const { h, turn, compactions } = await setup(t)
    // 七轮：带五轮加上文档，比换掉的短，落得下。
    for (const name of ['一', '二', '三', '四', '五', '六', '七']) await turn(long(`第${name}章写好了吗`), replyWithUsage(`第${name}章写好了`, 10))
    const doc = join(h.root, '交接.md')
    await writeFile(doc, '进行中：第八章。')
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: true })
    await waitFor(async () => (await compactions()).some(event => event.data?.error === undefined), '交接完成')
    assert.equal((await compactions()).length, 1, '一次就落下了')
    await turn('继续', replyWithUsage('好', 10))
    const sent = JSON.stringify(h.adapter.requests.at(-1).messages)
    assert.ok(sent.indexOf('进行中：第八章。') >= 0 && sent.indexOf('进行中：第八章。') < sent.indexOf('原文记录'), '原文跟在交接文档后面')
    assert.ok(sent.includes('第七章写好了') && sent.includes('第三章写好了'), '最近五轮都在')
    assert.ok(!sent.includes('第二章写好了'), '更早的不带')
    assert.equal(sent.split('进行中：第八章。').length, 2, '交接文档没有重复')

    // 只有两轮：最近几轮就是全部历史，加上文档比换掉的长，只留文档，交接照样做成。
    const small = await setup(t)
    await small.turn(long('第一章写好了吗'), replyWithUsage('第一章写好了', 10))
    await small.turn(long('接着写第二章'), replyWithUsage('第二章在写', 10))
    const shortDoc = join(small.h.root, '短交接.md')
    await writeFile(shortDoc, '进行中：第三章。')
    assert.deepEqual(await small.h.ctx.context.handoff('main', shortDoc), { scheduled: true })
    await waitFor(async () => (await small.compactions()).some(event => event.data?.error === undefined), '只留文档落下了')
    await small.turn('继续', replyWithUsage('好', 10))
    const shorter = JSON.stringify(small.h.adapter.requests.at(-1).messages)
    assert.ok(shorter.includes('进行中：第三章。') && !shorter.includes('原文记录') && !shorter.includes('接着写第二章'))
})

test('外部执行方交接以后切到原生：边界里有交接文档和最近几轮原文', async (t) => {
    const { h, agent, turn, compactions } = await setup(t)
    await external(h, agent, {
        newConversation: (_id, _doc, { onSwitched }) => {
            setImmediate(() => onSwitched({ at: Date.now() }))
            return { scheduled: true }
        },
    })
    for (const name of ['一', '二', '三', '四', '五', '六', '七']) await turn(long(`第${name}章写好了吗`), replyWithUsage(`第${name}章写好了`, 10))
    const doc = join(h.root, '交接.md')
    await writeFile(doc, '进行中：第八章。')
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: true })
    await waitFor(async () => (await boundaries(h, 'main')).length === 1, '边界落下')
    assert.equal((await compactions()).length, 1, '一次就落下了，没有失败重来')
    agent.model.select({ ...ROUTE })
    await turn('换个模型接着写', replyWithUsage('好', 10))
    const sent = JSON.stringify(h.adapter.requests.at(-1).messages)
    assert.ok(sent.includes('进行中：第八章。') && sent.includes('原文记录') && sent.includes('第七章写好了'))
    assert.ok(!sent.includes('第二章写好了'), '更早的不带')
})

test('交接文档比现有对话还长：交接没做成，原因报出来，也附在会话下一轮', async (t) => {
    const { h, turn } = await setup(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    await turn('嗯')
    const doc = join(h.root, '长交接.md')
    await writeFile(doc, '很长的交接。'.repeat(4_000))
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: true })
    await waitFor(() => h.ctx.core.pending('main', HANDOFF_FAILED_KEY), '交接失败的提醒')
    assert.match(h.ctx.core.attachments('main').find(item => item.key === HANDOFF_FAILED_KEY).text, /上下文还不大，交接文档比现有对话还长/)
    assert.ok(reports.some(entry => entry.kind === 'context/handoff-failed'))
})

test('主动压缩：等会话空下来压一次，交回 compacted；原生不收指定要保留的内容，结果里写明按默认压缩；装了引擎原生就有主动压缩', async (t) => {
    const { h, turn, compactions } = await setup(t)
    await turn(long('一'))
    await turn(long('二'))
    assert.deepEqual(await h.ctx.context.compact('main', { instructions: '留人物设定' }), { compacted: true, note: ContextModule.INSTRUCTIONS_IGNORED })
    assert.equal((await compactions()).length, 1)
    await turn(long('三'))
    assert.deepEqual(await h.ctx.context.compact('main'), { compacted: true }, '没指定要保留的内容时不写这句')
    assert.equal(await h.ctx.core.executors.has('main', 'compact'), true, '装了引擎，原生有主动压缩')
})

test('一轮进行中安排的交接：不打断这一轮，等它结束、会话空下来再换', async (t) => {
    const { h, agent, turn, compactions } = await setup(t)
    await turn(long('第一章'))
    const doc = join(h.root, '交接.md')
    await writeFile(doc, '进行中：第二章。')
    let release
    const gate = new Promise(resolve => { release = resolve })
    h.adapter.scripts.push(async function* () {
        await gate
        yield* replyWithUsage('写完了', 10)()
    })
    const ends = (await h.turnEnds('main')).length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: long('写第二章') }], source: { kind: 'user' } }))
    await waitFor(() => agent.status === 'running', '这一轮开始')
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await compactions()).length, 0, '这一轮还没结束，不动')
    release()
    await waitFor(async () => (await h.turnEnds('main')).length === ends + 1, '这一轮结束')
    await waitFor(async () => (await compactions()).length === 1, '空下来以后交接')
    assert.equal((await compactions())[0].data?.error, undefined)
})

test('压缩工具：原生会话指定要保留的内容时，工具结果里直接写明按默认压缩（模型看得到）', async (t) => {
    const { h, turn, compactions } = await setup(t)
    await turn(long('一'))
    await turn(long('二'))
    const endpoint = await h.ctx.core.toolEndpoint.open('main')
    const call = async args => {
        const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'assistant_context_compact', arguments: args } }),
        })
        return JSON.parse(await response.text()).result.content[0].text
    }
    const text = await call({ instructions: '留人物设定' })
    assert.ok(text.startsWith('已安排：这一轮结束后立即压缩上下文。') && text.includes(ContextModule.INSTRUCTIONS_IGNORED), text)
    await waitFor(async () => (await compactions()).length === 1, '压缩完成')
    await turn(long('三'))
    assert.equal(await call({}), '已安排：这一轮结束后立即压缩上下文。', '没指定时只说已安排')
})

/** 外部执行方用的模型：同一个假提供方下另一个模型，归测试登记的执行方。 */
const EXTERNAL = Object.freeze({ provider: ROUTE.provider, model: 'external-model' })
const ALL_REQUIRED = { runTurn: true, openingSegments: true, perTurnContext: true, toolEndpoint: true, interrupt: true, usage: () => null }

/** 登记一个接 `EXTERNAL` 的执行方，把会话切到它；记下它收到的边界和交接请求。 */
async function external(h, agent, { handoffTurn, newConversation, compact } = {}) {
    const landed = []
    const probe = await h.pluginContext('probe-external')
    probe.core.executors.register({
        id: 'external',
        handles: selection => selection.model === EXTERNAL.model,
        required: { ...ALL_REQUIRED, newConversation: newConversation ?? (() => ({ scheduled: false, reason: 'test' })) },
        optional: { boundary: { landed: (sessionId, info) => landed.push({ sessionId, ...info }) }, ...handoffTurn === undefined ? {} : { handoffTurn }, ...compact === undefined ? {} : { compact } },
    })
    agent.model.select({ ...EXTERNAL })
    return landed
}

const boundaries = async (h, id) => (await h.events(id)).map(pluginRecordOf).filter(record => record?.type === BOUNDARY_RECORD).map(record => record.data)

test('外部执行方自己管上下文：它的会话过了兜底压缩线也不做 DSH 侧的压力压缩', async (t) => {
    const { h, agent, turn, compactions } = await setup(t)
    await external(h, agent)
    await turn(long('一'), replyWithUsage('答一', 4_000))
    await turn('二')
    assert.equal((await compactions()).length, 0)
})

test('外部执行方换过新对话以后，DSH 记录里落交接边界：交接文档换掉之前的记录，记录写明种类，执行方知道落下的是哪一个', async (t) => {
    const { h, agent, turn, compactions } = await setup(t)
    const landed = await external(h, agent, {
        newConversation: (_id, _doc, { onSwitched }) => {
            setImmediate(() => onSwitched({ at: Date.now() }))
            return { scheduled: true }
        },
    })
    await turn(long('第一章写好了吗'))
    await turn(long('接着写第二章'))
    const doc = join(h.root, '交接.md')
    await writeFile(doc, '进行中：第三章，写到一半。')
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: true })
    await waitFor(async () => (await compactions()).length === 1, '边界落下')
    const [record] = await boundaries(h, 'main')
    assert.equal(record.kind, 'handoff')
    assert.equal(record.executor, 'external')
    assert.equal(record.document, doc)
    await waitFor(() => landed.length === 1, '执行方收到边界')
    assert.deepEqual(landed[0], { sessionId: 'main', compactionId: record.compactionId, kind: 'handoff' })
    await turn('继续')
    const sent = JSON.stringify(h.adapter.requests.at(-1).messages)
    assert.ok(sent.includes(HANDOFF_LEAD) && sent.includes('进行中：第三章，写到一半。'))
    assert.ok(!sent.includes('第一章写好了吗'), 'DSH 侧的旧记录也换掉了')
})

test('从外部执行方切到原生、历史放不下：先请原来的执行方写交接（工作目录的交接文件夹），交接换掉之前的记录', async (t) => {
    const { h, agent, turn, compactions } = await setup(t, { fallbackCompactAt: 500 })
    const asked = []
    const landed = await external(h, agent, {
        handoffTurn: async (sessionId, { path }) => {
            asked.push({ sessionId, path })
            await writeFile(path, '切走前：第三章写到一半。')
            return { conversation: 'conv-1' }
        },
    })
    await turn(long('第一章写好了吗'), replyWithUsage('写好了', 4_000))
    await turn(long('接着写第二章'), replyWithUsage('在写', 4_000))
    assert.equal((await compactions()).length, 0, '外部执行方的会话不压')
    agent.model.select({ ...ROUTE })
    await turn('换个模型接着写')
    assert.equal(asked.length, 1)
    assert.match(asked[0].path, /交接[\\/]\d{8}-\d{4}-换模型\.md$/)
    assert.equal((await compactions()).length, 1)
    const [record] = await boundaries(h, 'main')
    assert.deepEqual([record.kind, record.executor, record.document, record.conversation], ['switch', 'external', asked[0].path, 'conv-1'])
    await waitFor(() => landed.length === 1, '原来的执行方收到边界')
    assert.equal(landed[0].conversation, 'conv-1')
    const sent = JSON.stringify(h.adapter.requests.at(-1).messages)
    assert.ok(sent.includes(SWITCH_LEAD) && sent.includes('切走前：第三章写到一半。'))
    assert.ok(!sent.includes('第一章写好了吗'))
})

test('预设里各带一份上游引擎（DSH 的 web 预设都这样）：自动压缩全归框架的引擎，切模型照样先写交接，不走模型摘要', async (t) => {
    const { h, agent, turn, compactions } = await setup(t, { fallbackCompactAt: 500, presetEngine: true })
    const asked = []
    await external(h, agent, {
        handoffTurn: async (_id, { path }) => {
            asked.push(path)
            await writeFile(path, '切走前：第三章写到一半。')
            return { conversation: 'conv-1' }
        },
    })
    // 用量过了上游的线（窗口一万的八成）：要是上游那份还在动手，这里就会摘要。
    await turn(long('第一章写好了吗'), replyWithUsage('写好了', 9_500))
    await turn(long('接着写第二章'), replyWithUsage('在写', 9_500))
    await turn(long('第三章'), replyWithUsage('在写', 9_500))
    assert.equal((await compactions()).length, 0, '外部执行方的会话，上游那份也不压')
    const requests = h.adapter.requests.length
    agent.model.select({ ...ROUTE })
    await turn('换个模型接着写', replyWithUsage('好', 10))
    assert.equal(asked.length, 1, '先请原来的执行方写了交接')
    const summaries = (await h.events('main')).filter(event => event.type === 'compaction/summary')
    assert.equal(summaries.length, 1)
    assert.notEqual(summaries[0].data.llmStreamCall, true, '没有走模型摘要')
    assert.deepEqual((await boundaries(h, 'main')).map(record => record.kind), ['switch'])
    assert.equal(h.adapter.requests.length, requests + 1, '只有这一轮的请求，没有多一次摘要请求')
})

test('预设里的上游引擎：原生会话的步间压缩归框架的引擎，按兜底压缩线，只压一次', async (t) => {
    const { turn, compactions } = await setup(t, { presetEngine: true })
    // 过了框架的线（3 千）、没过上游的线（8 千）：只有框架的引擎在管才会压。
    await turn(long('一'), replyWithUsage('答一', 4_000))
    await turn('二', replyWithUsage('答二', 10))
    const done = (await compactions()).filter(event => event.data?.error === undefined)
    assert.equal(done.length, 1, '按框架的线压了一次')
})

test('预设里的 /compact（走隔离域里那份）：原生会话交给框架的引擎；外部执行方交给它自己压，DSH 这边不做模型摘要', async (t) => {
    const { h, agent, turn, compactions, presetCtx } = await setup(t, { presetEngine: true })
    const preset = await new Promise((resolve) => {
        presetCtx.inject(['compaction'], child => resolve(child.compaction))
    })
    assert.ok(preset instanceof BasicCompactionEngine && !(preset instanceof MindCompactionEngine), '确实是预设里那份')
    await turn(long('第一章'), replyWithUsage('好', 10))
    await turn(long('第二章'), replyWithUsage('好', 10))
    const signal = new AbortController().signal
    const result = await preset.compactNow(agent, signal)
    assert.ok(result !== null && (await compactions()).length === 1, '原生：压了一次')

    const compacted = []
    await external(h, agent, { compact: async (sessionId) => { compacted.push(sessionId); return { compacted: true } } })
    await turn(long('第三章'), replyWithUsage('好', 10))
    await turn(long('第四章'), replyWithUsage('好', 10))
    const before = (await compactions()).length
    const requests = h.adapter.requests.length
    assert.equal(await preset.compactNow(agent, signal), null)
    assert.deepEqual(compacted, ['main'], '外部执行方：请它自己压')
    assert.equal((await compactions()).length, before, 'DSH 这边没有压缩')
    assert.equal(h.adapter.requests.length, requests, '没有摘要请求')
})

test('外部执行方的会话，溢出恢复也不做 DSH 侧压缩', async (t) => {
    const { h, agent, turn, compactions } = await setup(t, { presetEngine: true })
    await external(h, agent)
    await turn(long('第一章'), replyWithUsage('好', 9_500))
    const engine = h.ctx.get('compaction')
    assert.equal(await engine.compactIfNeeded(agent, 'context-overflow', new AbortController().signal), null)
    assert.equal((await compactions()).length, 0)
})

test('切走前写交接时执行方自己压缩了：旧摘要的边界不落，切过去以后原生的新记录不被换掉', async (t) => {
    const { h, agent, turn, compactions } = await setup(t, { fallbackCompactAt: 500 })
    const answers = []
    await external(h, agent, {
        handoffTurn: async (_id, { path }) => {
            // 这时候模型已经选了原生，请求还没发：和 agent-sdk 的 PostCompact 一样不等、不指定执行方。
            answers.push(h.ctx.context.land('main', { kind: 'auto-compact', text: '切走前的旧摘要。', conversation: 'conv-1', by: 'external' }))
            await writeFile(path, '切走前：第三章写到一半。')
            return { conversation: 'conv-1' }
        },
    })
    await turn(long('第一章写好了吗'), replyWithUsage('写好了', 4_000))
    await turn(long('接着写第二章'), replyWithUsage('在写', 4_000))
    agent.model.select({ ...ROUTE })
    await turn('换个模型接着写，样本甲')
    await waitFor(() => answers.length === 1, '请求过落边界')
    const answer = await answers[0]
    assert.equal(answer.landed, false)
    assert.match(answer.reason, /切走/)
    assert.equal((await compactions()).length, 1, '只有切模型那一次')
    assert.deepEqual((await boundaries(h, 'main')).map(record => record.kind), ['switch'])
    const events = await h.events('main')
    const lastCompaction = events.findLast(event => event.type === 'compaction/end')
    const message = events.find(event => event.type === 'user/message' && JSON.stringify(event.data?.content).includes('样本甲'))
    assert.ok(message.seq > lastCompaction.seq, '原生的新记录在最后一次压缩之后，没有被换掉')
    assert.ok(!JSON.stringify(events).includes('切走前的旧摘要'))
})

test('执行方自己压缩过、没有切走：边界照落，记在这个执行方名下', async (t) => {
    const { h, agent, turn, compactions } = await setup(t)
    const landed = await external(h, agent)
    await turn(long('第一章写好了吗'))
    await turn(long('接着写第二章'))
    const answer = await h.ctx.context.land('main', { kind: 'auto-compact', text: '摘要：第二章在写。', conversation: 'conv-1', by: 'external' })
    assert.equal(answer.landed, true)
    assert.equal((await compactions()).length, 1)
    const [record] = await boundaries(h, 'main')
    assert.deepEqual([record.kind, record.executor, record.conversation], ['auto-compact', 'external', 'conv-1'])
    await waitFor(() => landed.length === 1, '执行方收到边界')
})

test('执行方压缩之后、边界落下之前又进来的记录：接在摘要后面，不丢', async (t) => {
    const { h, agent, turn } = await setup(t)
    await external(h, agent)
    await turn(long('第一章写好了吗'), replyWithUsage('写好了', 10))
    await turn(long('接着写第二章'), replyWithUsage('在写', 10))
    let release
    const gate = new Promise(resolve => { release = resolve })
    h.adapter.scripts.push(async function* () {
        await gate
        yield* replyWithUsage('第三章写到一半的回复', 10)()
    })
    h.adapter.scripts.push(replyWithUsage('追加的也答了', 10))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: long('写第三章') }], source: { kind: 'user' } }))
    await waitFor(() => agent.status === 'running', '这一轮开始')
    const landing = h.ctx.context.land('main', { kind: 'auto-compact', text: '摘要：写到第三章开头。', conversation: 'conv-1', by: 'external' })
    await new Promise(resolve => setTimeout(resolve, 30))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '追加一句，样本甲' }], source: { kind: 'user' } }))
    release()
    assert.equal((await landing).landed, true)
    await turn('继续', replyWithUsage('好', 10))
    const sent = JSON.stringify(h.adapter.requests.at(-1).messages)
    assert.ok(sent.includes('摘要：写到第三章开头。'))
    assert.ok(sent.includes('第三章写到一半的回复') && sent.includes('样本甲'), '摘要之后的记录都在')
    assert.ok(!sent.includes('第一章写好了吗'), '摘要之前的换掉了')
})

test('切走以后执行方的后台轮才压缩：请求已经路由到原生，这份摘要不落，也不算到原生头上', async (t) => {
    const { h, agent, turn, compactions } = await setup(t)
    await external(h, agent)
    await turn(long('第一章写好了吗'))
    agent.model.select({ ...ROUTE })
    await turn(long('换个模型，样本甲'))
    const before = (await compactions()).length
    const answer = await h.ctx.context.land('main', { kind: 'auto-compact', text: '后台轮的旧摘要。', conversation: 'conv-1', by: 'external' })
    assert.equal(answer.landed, false)
    assert.match(answer.reason, /切走/)
    assert.equal((await compactions()).length, before)
    assert.ok(!JSON.stringify(await h.events('main')).includes('后台轮的旧摘要'))
    await assert.rejects(h.ctx.context.land('main', { kind: 'auto-compact', text: '摘要' }), /by/, '不写是谁写的摘要不收')
})

test('切模型的压缩落下一次以后又失败：已经落下的那次照样有记录，原来的执行方也知道', async (t) => {
    const { h, agent, turn, compactions } = await setup(t, { fallbackCompactAt: 500 })
    const landed = await external(h, agent, {
        handoffTurn: async (_id, { path }) => {
            // 比旧历史短（第一次压缩落得下），但还是超过目标模型的线（之后再压不动，切换失败）。
            await writeFile(path, '切走前的长交接。'.repeat(300))
            return { conversation: 'conv-1' }
        },
    })
    for (const text of ['第一章', '第二章', '第三章', '第四章', '第五章', '第六章']) await turn(long(text), replyWithUsage('写好了', 4_000))
    agent.model.select({ ...ROUTE })
    await turn('换个模型接着写')
    const done = (await compactions()).filter(event => event.data?.error === undefined)
    assert.ok(done.length >= 1, '至少落下了一次')
    const ends = await h.turnEnds('main')
    assert.notEqual(ends.at(-1).data?.reason?.kind, 'completed', '切换本身失败了')
    const records = await boundaries(h, 'main')
    assert.deepEqual(records.map(record => record.compactionId), done.map(event => event.data.compactionId), '每次落下的都有记录')
    assert.equal(records[0].kind, 'switch')
    await waitFor(() => landed.length === done.length, '原来的执行方收到边界')
    assert.equal(landed[0].conversation, 'conv-1')
})

test('切到原生前写不了交接：用最近的记录裁剪着交过去，开头写明省略、原文在经历库，报出来', async (t) => {
    const { h, agent, turn, compactions } = await setup(t, { fallbackCompactAt: 500 })
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    await external(h, agent)
    await turn(long('第一章写好了吗'), replyWithUsage('写好了', 4_000))
    await turn(long('接着写第二章'), replyWithUsage('在写', 4_000))
    agent.model.select({ ...ROUTE })
    await turn('换个模型接着写')
    assert.equal((await compactions()).length, 1, '裁剪的记录按目标模型的线放得下，一次就够')
    assert.equal((await boundaries(h, 'main'))[0].kind, 'switch')
    assert.ok(reports.some(entry => entry.kind === 'context/switch-handoff-failed'))
    assert.ok(JSON.stringify(h.adapter.requests.at(-1).messages).includes('切走前没能写交接'))
})

test('裁剪的记录：最近一份边界整份留着，快照不放，放不下的写明省略了几条', () => {
    const say = (role, text, kind = role) => ({ role, source: { kind }, content: [{ type: 'text', text }] })
    const text = trimmedRecord([
        say('system', '系统'),
        say('user', '上次的交接：第二章', 'compact-checkpoint'),
        say('user', '快照', 'runtime-context'),
        say('user', '旧的'.repeat(50)),
        say('assistant', '新的'),
    ], 60)
    assert.ok(text.includes('上次的交接：第二章'))
    assert.ok(!text.includes('快照') && !text.includes('系统'))
    assert.match(text, /更早的 1 条省略了，原文在经历库/)
    assert.ok(text.endsWith('[assistant]\n新的'))
})
