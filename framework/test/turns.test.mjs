/**
 * 核心：一轮的结果、附提醒、失败的一轮带着的输入。跑在真实的会话与 AgentLoop 上，模型提供方按用例脚本应答。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ROUTE, createUserMessage, makeHarness, textReply, waitFor } from './harness.mjs'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { createAttachments } from '../core/attach.js'
import { finalText, outcomeFromEvents } from '../core/outcome.js'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })

function promptMessage(text) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** 一次立刻失败、不可重试的模型请求（上游把非模型错误压成 UNKNOWN）。 */
function* failingReply() {
    throw new Error('模型那边坏了')
}

async function runTurn(h, agent, text, script) {
    if (script !== undefined) h.adapter.scripts.push(script)
    const before = (await h.turnEnds(String(agent.session.id))).length
    agent.followup(promptMessage(text))
    await waitFor(async () => (await h.turnEnds(String(agent.session.id))).length === before + 1, `第 ${before + 1} 轮`)
    return (await h.turnEnds(String(agent.session.id))).at(-1)
}

/* ------------------------------------------------------------------ 一轮的结果 */

test('outcomeOf：最终文字恰好是标记串才算不发或等待，正文里提到不算', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    const reply = await runTurn(h, agent, '一', () => textReply('好的，马上办'))
    const silent = await runTurn(h, agent, '二', () => textReply(' [不发] '))
    const wait = await runTurn(h, agent, '三', () => textReply('【等待】'))
    const mention = await runTurn(h, agent, '四', () => textReply('这一轮我不写 [不发]，照常回'))
    assert.deepEqual(await h.ctx.core.outcomeOf('main', reply.data.turn), { kind: 'reply', text: '好的，马上办' })
    assert.deepEqual(await h.ctx.core.outcomeOf('main', silent.data.turn), { kind: 'silent' })
    assert.deepEqual(await h.ctx.core.outcomeOf('main', wait.data.turn), { kind: 'wait' })
    assert.equal((await h.ctx.core.outcomeOf('main', mention.data.turn)).kind, 'reply')
    assert.equal(await h.ctx.core.outcomeOf('main', 99), null, '没有这一轮')
})

test('outcomeOf：出错的轮没有结果', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    const failed = await runTurn(h, agent, '会失败的一轮', failingReply)
    assert.equal(failed.data.reason.kind, 'error')
    assert.equal(await h.ctx.core.outcomeOf('main', failed.data.turn), null)
})

test('钩子拦一次、续做不调工具：最终文字只有续做那一段（执行方把边界之间的文字各交成一块），出口只发它', () => {
    // Claude Code 的一轮：工具在它那边跑，日志里只有文字块；被钩子拦下的那段和续做写的那段各是一块。
    const message = { content: [{ type: 'text', text: '我先查一下。' }, { type: 'text', text: '服务这就重启。' }, { type: 'text', text: '服务已经交给维护的人去重启了。' }] }
    assert.equal(finalText(message), '服务已经交给维护的人去重启了。')
    // 渠道发没有渠道输入的一轮按 outcomeOf（同一个函数）。
    const events = [
        { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message } },
        { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    assert.deepEqual(outcomeFromEvents(events, 1), { kind: 'reply', text: '服务已经交给维护的人去重启了。' }, '出口按 outcomeOf 发，只有续做那一段')
    assert.equal(finalText({ content: [{ type: 'text', text: '收尾' }, { type: 'text', text: '  ' }] }), '收尾', '空白块不算一段')
})

test('最终文字取最后一次工具调用之后的那一段；以工具收尾、后面没有文字的判成不发；半截的回复不算', () => {
    assert.equal(finalText({ content: [{ type: 'text', text: '先说一句' }, { type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }, { type: 'text', text: '收尾' }] }), '收尾')
    const events = [
        { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '先说' }, { type: 'tool-call', id: 'c', name: 'exit_plan', arguments: '{}' }] } } },
        { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } },
        { type: 'assistant/message', seq: 5, time: 5, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '完整的' }] } } },
        { type: 'assistant/message', seq: 6, time: 6, data: { turn: 2, step: 2, interrupted: true, message: { content: [{ type: 'text', text: '半截' }] } } },
        { type: 'turn/end', seq: 7, time: 7, data: { turn: 2, reason: { kind: 'completed' } } },
        { type: 'turn/start', seq: 8, time: 8, data: { turn: 3 } },
        { type: 'turn/end', seq: 9, time: 9, data: { turn: 3, reason: { kind: 'interrupted' } } },
        { type: 'turn/start', seq: 10, time: 10, data: { turn: 4 } },
        { type: 'assistant/message', seq: 11, time: 11, data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: '写到一半' }] } } },
        { type: 'turn/end', seq: 12, time: 12, data: { turn: 4, reason: { kind: 'max-tokens' } } },
    ]
    assert.deepEqual(outcomeFromEvents(events, 1), { kind: 'silent' })
    assert.deepEqual(outcomeFromEvents(events, 2), { kind: 'reply', text: '完整的' })
    assert.equal(outcomeFromEvents(events, 3), null, '强杀后补上的轮没有结果')
    assert.deepEqual(outcomeFromEvents(events, 4), { kind: 'reply', text: '写到一半', truncated: true }, '到了输出上限照常判，带上截断')
})

/* ------------------------------------------------------------------ 附提醒 */

test('附提醒：轮开始以后才附上，但执行方是之后才取的（这一轮排在交接整理后面）：模型收到了，这一轮结束就算交到，不再交第二遍', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    let handed = null
    h.adapter.scripts.push(async function* later() {
        await h.ctx.core.attach('main', 'tidy', '整理结果')
        handed = h.ctx.core.attachments('main', { delivering: true }).map(item => item.key)
        yield* textReply('ok')
    })
    await runTurn(h, agent, '一')
    assert.deepEqual(handed, ['tidy'])
    await waitFor(() => !h.ctx.core.pending('main', 'tidy'), '这一轮结束就撤掉')

    // 只是看一眼（不是执行方要交）的不算。
    h.adapter.scripts.push(async function* peek() {
        await h.ctx.core.attach('main', 'peek', '中途附上的')
        h.ctx.core.attachments('main')
        yield* textReply('ok')
    })
    await runTurn(h, agent, '二')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(h.ctx.core.pending('main', 'peek'), true)
})

test('附提醒：这一轮成功结束、模型跑过才撤掉并回调；这一轮开始以后才附的留给下一轮；重启不丢', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    const taken = []
    await h.ctx.core.attach('main', 'usage', '用量提醒：五小时窗口已用 80%', { onTaken: () => taken.push('usage') })
    assert.equal(h.ctx.core.pending('main', 'usage'), true)
    assert.deepEqual(h.ctx.core.attachments('main').map(item => item.key), ['usage'])

    // 这一轮跑的时候再附一条：它不算这一轮交到的。
    h.adapter.scripts.push(function* late() {
        h.ctx.core.attach('main', 'late', '这一轮中途才附上的')
        yield* textReply('ok')
    })
    await runTurn(h, agent, '一')
    await waitFor(() => !h.ctx.core.pending('main', 'usage'), '交到以后撤掉')
    assert.deepEqual(taken, ['usage'])
    assert.equal(h.ctx.core.pending('main', 'late'), true, '中途附上的留到下一轮')

    // 失败的一轮不算交到。
    await runTurn(h, agent, '二', failingReply)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(h.ctx.core.pending('main', 'late'), true, '失败了留着')

    // 重启核心：提醒存在核心自己的存储里。
    await h.unmountCore()
    await h.mountCore()
    assert.equal(h.ctx.core.pending('main', 'late'), true)
    await h.ctx.core.detach('main', 'late')
    assert.equal(h.ctx.core.pending('main', 'late'), false)
})

/* ------------------------------------------------------------------ 失败的一轮带着的输入 */

test('一轮出错：领走的输入记成未得到回应，附给下一轮，报 turn-failed；不重发', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    await h.ctx.core.deliver('main', { key: 'remind', text: '到点了：给林舟发周报', source: { kind: 'schedule' }, speaker: BY, wake: 'none' })
    const failed = await runTurn(h, agent, '帮我看看昨天的记录', failingReply)
    const key = `turn-failed:${failed.data.turn}`
    await waitFor(() => h.ctx.core.pending('main', key), '附给下一轮')

    const [notice] = h.ctx.core.attachments('main').filter(item => item.key === key)
    const code = failed.data.reason.error.code
    assert.match(notice.text, new RegExp(`第 ${failed.data.turn} 轮）以错误 ${code} 结束`), '错误码取 turn/end 里的')
    assert.match(notice.text, /可能已经部分执行/)
    assert.match(notice.text, /schedule：到点了：给林舟发周报/, '程序放进来的输入也在里面')
    assert.match(notice.text, /用户本人：帮我看看昨天的记录/)
    const [report] = reports.filter(entry => entry.kind === 'turn-failed')
    assert.deepEqual(report.data, { turn: failed.data.turn, code, inputs: 2 })
    assert.equal((await h.turnEnds('main')).length, 1, '不自动重发、不开新的一轮')

    // 下一轮成功跑完，这条说明就算交到了。
    await runTurn(h, agent, '再来')
    await waitFor(() => !h.ctx.core.pending('main', key), '下一轮交到以后撤掉')
})

test('Host 被强杀的那一轮：恢复时最后一轮是 interrupted、没处理过的，按失败的一轮处理一次', async () => {
    const tables = new Map()
    const tableOf = (name) => {
        if (!tables.has(name)) {
            const stored = new Map()
            tables.set(name, { get: id => stored.get(id), put: async (id, value) => { stored.set(id, value) }, delete: async (id) => { stored.delete(id) }, entries: () => stored.entries() })
        }
        return tables.get(name)
    }
    const domain = { table: tableOf }
    const reports = []
    const events = [
        { type: 'turn/start', seq: 1, time: 1000, data: { turn: 4 } },
        { type: 'user/message', seq: 2, time: 1001, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '强杀前的那条' }], source: { kind: 'assistant-task' } } },
        { type: 'turn/end', seq: 3, time: 1002, data: { turn: 4, reason: { kind: 'interrupted' } } },
    ]
    const attachments = createAttachments(domain, { readEvents: async () => events, report: (kind, detail) => reports.push({ kind, ...detail }), now: () => 2000 })
    await attachments.noteResumed('main')
    await attachments.noteResumed('main')
    const [notice] = attachments.list('main')
    assert.equal(notice.key, 'turn-failed:4')
    assert.match(notice.text, /以错误 INTERRUPTED 结束/)
    assert.match(notice.text, /assistant-task：强杀前的那条/)
    assert.equal(reports.length, 1, '同一轮只处理一次')
})

test('到了输出上限的轮：照常算回复、带 truncated，报 turn-truncated，附提醒照样算交到', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    await h.ctx.core.attach('main', 'k', '一条提醒')
    const end = await runTurn(h, agent, '写长一点', function* truncated() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '写到一半' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '写到一半' } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })
    assert.equal(end.data.reason.kind, 'max-tokens')
    assert.deepEqual(await h.ctx.core.outcomeOf('main', end.data.turn), { kind: 'reply', text: '写到一半', truncated: true })
    await waitFor(() => reports.some(entry => entry.kind === 'turn-truncated'), '报截断')
    await waitFor(() => !h.ctx.core.pending('main', 'k'), '提醒算交到')
})

test('额度用完、执行方有额度闸门：这一轮不算失败（闸门恢复后唤醒）；没有闸门的执行方照普通失败处理', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const required = { runTurn: true, openingSegments: true, perTurnContext: true, toolEndpoint: true, interrupt: true, usage: () => null, newConversation: () => ({ scheduled: false, reason: 'test' }) }
    const probe = await h.pluginContext('probe-gate')
    probe.core.executors.register({ id: 'gated', handles: selection => selection.provider === ROUTE.provider, required, optional: { quotaGate: { state: () => 'limited', codes: ['USAGE_LIMIT'] } } })
    function* quotaOut() {
        throw new LlmError('额度用完了', 'USAGE_LIMIT')
    }
    const limited = await runTurn(h, agent, '额度用完时的一句', quotaOut)
    assert.equal(limited.data.reason.kind, 'error')
    assert.equal(limited.data.reason.error.code, 'USAGE_LIMIT')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(h.ctx.core.pending('main', `turn-failed:${limited.data.turn}`), false, '有闸门：不记成未得到回应')
    assert.equal(reports.filter(entry => entry.kind === 'turn-failed').length, 0)

    await probe.fiber.dispose()
    const plain = await runTurn(h, agent, '没有闸门时的一句', quotaOut)
    await waitFor(() => h.ctx.core.pending('main', `turn-failed:${plain.data.turn}`), '没有闸门：照普通失败处理')
})
