/**
 * 先搜再答（门控版）：门控的正例、反例（用户本人的、转来的都有），词表文件的写法，新颖度的算法，从会话事件取这一轮的输入和
 * 最近几轮；接真模块时，提示确实经 Agent SDK 的钩子附在中枢那一轮上，判够轮数提醒中枢看词表，词表改了下一轮生效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as ExperienceModule from '../experience/index.js'
import * as SearchModule from '../search/index.js'
import { DEFAULT_HINT, createGate, createSearchFirst, createStats, noveltyOf, parseWords, turnInputs } from '../search/first.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { makeHarness, waitFor } from './harness.mjs'

const OWNER_ASKS = '之前定过的发布顺序是什么，帮我盘点一下还剩哪些没做'
const OWNER_SHORT = '部署了吗？'
const OWNER_CHAT = '今天晚饭吃了点面条，味道还挺不错的，你觉得呢哈哈哈'
const RELAYED = '【项目会话】第二章的修改已经交了，三处批注的状态请你看一下，下一步是排版'

test('门控：用户本人的，有问题类型词且够长就提醒；太短、没有类型词的不提醒；转来的还要够新；算不出新颖度只按前一半', () => {
    const gate = createGate()
    assert.ok(gate.passes({ text: OWNER_ASKS, fromOwner: true }))
    assert.ok(!gate.passes({ text: OWNER_SHORT, fromOwner: true }), '有类型词但不到 20 字')
    assert.ok(!gate.passes({ text: OWNER_CHAT, fromOwner: true }), '够长但没有类型词')
    assert.ok(gate.passes({ text: RELAYED, fromOwner: false, novelty: 0.7 }))
    assert.ok(!gate.passes({ text: RELAYED, fromOwner: false, novelty: 0.5 }), '最近几轮正在谈的事')
    assert.ok(gate.passes({ text: RELAYED, fromOwner: false, novelty: undefined }))
    const custom = createGate({ words: ['why', 'status'], minLength: 10 })
    assert.ok(custom.passes({ text: 'what is the status now', fromOwner: true }), '别的语言自己配词表')
    assert.ok(!custom.passes({ text: OWNER_ASKS, fromOwner: true }))
    assert.ok(!createGate({ words: [] }).passes({ text: OWNER_ASKS, fromOwner: true }), '空词表谁都不提醒')
})

test('词表文件：一行一个，也可以顿号逗号隔开；# 开头是注释；去重', () => {
    assert.deepEqual(parseWords('# 问题类型词\n进度\n状态、规划,下一步\n\n进度\n  # 缩进的注释\n'), ['进度', '状态', '规划', '下一步'])
})

test('新颖度：没在最近几轮出现的词的 IDF 占全部词 IDF 的比例', () => {
    assert.equal(noveltyOf(['常见', '罕见'], new Set(['常见']), { total: 99, counts: [99, 0] }), 1)
    assert.equal(noveltyOf(['常见', '罕见'], new Set(['罕见']), { total: 99, counts: [99, 0] }), 0)
    assert.equal(noveltyOf(['甲乙', '丙丁'], new Set(['甲乙']), { total: 99, counts: [9, 9] }), 0.5)
})

const input = (text, { speaker = { kind: 'user' }, annotation = '[11-08 周日 11:14 +08:00]' } = {}) => ({
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: `${annotation}\n${text}` }], source: { kind: 'user', intent: 'prompt', speaker, annotation } },
})
const reply = text => ({ type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text }] } })
const turn = n => ({ type: 'turn/start', data: { turn: n } })
const original = (message) => {
    const annotation = message.source?.annotation
    return message.content.map(block => (annotation && block.text.startsWith(`${annotation}\n`) ? { ...block, text: block.text.slice(annotation.length + 1) } : block))
}

test('从会话事件取：这一轮当提问的输入（去掉来源标注、分出是不是本人说的），之前最近几轮的输入和回复', () => {
    const events = []
    for (let n = 1; n <= 7; n += 1) events.push(turn(n), input(`第 ${n} 轮的问题`), reply(`第 ${n} 轮的回答`))
    events.push(turn(8), input(OWNER_ASKS), input(RELAYED, { speaker: { kind: 'external', name: 'dev' }, annotation: '[x]（以下来自外部调用方）' }))
    const found = turnInputs(events, { original })
    assert.equal(found.turn, 8)
    assert.deepEqual(found.inputs, [{ text: OWNER_ASKS, fromOwner: true }, { text: RELAYED, fromOwner: false }])
    assert.equal(found.recent, ['3', '4', '5', '6', '7'].map(n => `第 ${n} 轮的问题\n第 ${n} 轮的回答`).join('\n'))
})

test('判定：一轮最多判一次；不是中枢不判；提示里没有这一轮的输入（事件还没落）不判；转来的按新颖度；计数', async () => {
    const events = [turn(1), input(OWNER_ASKS)]
    const stats = createStats({ now: () => 1000 })
    const grams = text => [...new Set(Array.from(String(text).replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '')).map((char, index, all) => char + (all[index + 1] ?? '')).slice(0, -1))]
    const make = (hub = true) => createSearchFirst({
        isHub: () => hub, readEvents: async () => events, original, gate: async () => createGate(),
        terms: grams, frequencies: async terms => ({ total: 1000, counts: terms.map(() => 0) }), onJudged: result => stats.record(result),
    })
    const searchFirst = make()
    const promptOf = () => events.filter(event => event.type === 'user/message').at(-1).data.content[0].text
    assert.equal(await searchFirst(promptOf()), DEFAULT_HINT)
    assert.match(DEFAULT_HINT, /如果要说某件事还没做、没定过、不存在，把这句话本身也搜一次/)
    assert.equal(await searchFirst(promptOf()), undefined, '同一轮不重复')
    events.push(reply('好'), turn(2), input(OWNER_CHAT))
    assert.equal(await searchFirst(promptOf()), undefined, '闲聊')
    events.push(reply('嗯'), turn(3), input(RELAYED), reply('收到'), turn(4), input(RELAYED, { speaker: { kind: 'session', sessionId: 'dev' }, annotation: '[y]（以下来自会话 dev）' }))
    assert.equal(await searchFirst(promptOf()), undefined, '上一轮刚谈过的转来消息')
    assert.deepEqual(stats.stats(), { enabled: true, since: 1000, judged: 3, triggered: 1, lastJudgedAt: 1000, lastTriggeredAt: 1000 })
    assert.equal(await make(false)(OWNER_ASKS), undefined, '不是中枢')
    assert.equal(await make()('别的内容'), undefined, '事件还没落')
})

test('接真模块：提示经 Agent SDK 的钩子附在中枢那一轮；判够轮数提醒中枢看词表；词表文件改了下一轮生效；子代理不判', async (t) => {
    const h = await makeHarness(t, { controller: true })
    const dir = await mkdtemp(join(tmpdir(), 'search-first-'))
    const fibers = []
    t.after(async () => {
        for (const fiber of fibers) await fiber.dispose()
        await new Promise(resolve => setTimeout(resolve, 50))
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const content = h.coreConfig.contentDirectory
    await mkdir(content, { recursive: true })
    const providers = []
    fibers.push(await h.ctx.plugin({ name: 'fake-agent-sdk', apply: ctx => ctx.provide('agentSdk', { addHooks: (provider) => { providers.push(provider); return () => {} } }) }))
    const agent = await h.createSession('main', { cwd: content })
    await h.ctx.core.sessions.setHub('main', { by: { kind: 'program', plugin: 'test' } })
    fibers.push(await h.ctx.plugin(ExperienceModule, { archiveFile: join(dir, 'experience.sqlite') }))
    fibers.push(await h.ctx.plugin({
        name: 'search-under-test',
        inject: SearchModule.inject,
        apply: ctx => SearchModule.apply(ctx, new SearchModule.Config({ file: join(dir, 'search.sqlite'), searchFirst: { remindEvery: 2 } }), { autoStart: false }),
    }))
    await waitFor(async () => providers.length === 1, '挂上钩子')
    const hook = async (prompt, extra = {}) => providers[0]('main').UserPromptSubmit[0].hooks[0]({ prompt, ...extra })
    const ask = async (text) => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await waitFor(async () => (await h.userMessages('main')).some(message => JSON.stringify(message.content).includes(text)), '这一轮进来')
        return hook(text)
    }

    assert.deepEqual(await ask(OWNER_ASKS), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: DEFAULT_HINT } })
    assert.deepEqual(await hook(OWNER_ASKS, { agent_id: 'sub' }), {}, '子代理里不判')
    await waitFor(async () => (await h.turnEnds('main')).length >= 1, '第一轮跑完')
    assert.deepEqual(await ask(OWNER_CHAT), {}, '闲聊不附')
    await waitFor(async () => (await h.turnEnds('main')).length >= 2, '第二轮跑完')
    await waitFor(async () => (await h.ctx.core.attachments('main')).some(item => item.key === 'search-first-words'), '维护提醒落下')
    const reminder = (await h.ctx.core.attachments('main')).find(item => item.key === 'search-first-words')
    assert.match(reminder.text, /判了 2 轮，附了 1 次提示（50%）/, '判够两轮提醒中枢看词表')
    assert.equal(h.ctx.searchFirst.stats().judged, 2)

    await writeFile(join(content, 'search-first-words.md'), '# 只剩一个词\n晚饭\n')
    assert.deepEqual(await ask('晚饭这件事我想再问一下你今天的安排是怎样的'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: DEFAULT_HINT } }, '词表改了下一轮生效')
})
