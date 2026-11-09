/**
 * 上下文模块：交接、主动压缩、用量提醒、兜底压缩线、两个工具出不出现。核心是真的，执行方是假的（能力的值就是实现）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as ContextModule from '../context/index.js'
import { ROUTE, createUserMessage, makeHarness, waitFor } from './harness.mjs'

const REQUIRED = { runTurn: true, openingSegments: true, perTurnContext: true, toolEndpoint: true, interrupt: true, usage: () => null, newConversation: () => ({ scheduled: false, reason: '执行方 fake 不能换新对话' }) }

async function setup(t, { capable = true } = {}) {
    const h = await makeHarness(t)
    const calls = []
    const state = { tokens: 0, epoch: 0 }
    const probe = await h.pluginContext('probe-executor-context')
    const newConversation = (sessionId, document, options) => {
        calls.push(['newConversation', sessionId, document])
        if (state.refuse) return { scheduled: false, reason: '后台任务还在跑' }
        state.epoch += 1
        // 真执行方是等会话空下来换完才回调；替身当场回调。
        if (state.switchAt !== undefined) options?.onSwitched?.({ at: state.switchAt })
        return { scheduled: true }
    }
    probe.core.executors.register({
        id: 'fake',
        handles: selection => selection.provider === ROUTE.provider,
        required: { ...REQUIRED, ...capable ? { newConversation, usage: () => ({ tokens: state.tokens, window: 1_000_000, epoch: state.epoch }) } : {} },
        optional: capable ? {
            compact: (sessionId, options) => { calls.push(['compact', sessionId, options.instructions]); state.epoch += 1; return { compacted: true } },
            compactInstructions: true,
            fallbackThreshold: { set: (tokens) => { calls.push(['setFallbackThreshold', tokens]) } },
        } : {},
    })
    const fiber = await h.ctx.plugin(ContextModule, { remindFrom: 300_000, remindStep: 100_000, fallbackCompactAt: 680_000 })
    t.after(() => fiber.dispose())
    const agent = await h.createSession('main')
    const turn = async (text) => {
        const before = (await h.turnEnds('main')).length
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await waitFor(async () => (await h.turnEnds('main')).length === before + 1, '这一轮')
    }
    return { h, calls, state, turn }
}

test('交接：文档要存在且非空；执行方同意就安排，执行方拒了写明原因；第一次见到执行方时设兜底压缩线', async (t) => {
    const { h, calls, state } = await setup(t)
    const doc = join(h.root, '交接.md')
    assert.match((await h.ctx.context.handoff('main', doc)).reason, /读不到/)
    await writeFile(doc, '  ')
    assert.match((await h.ctx.context.handoff('main', doc)).reason, /空的/)
    await writeFile(doc, '进行中：第三章')
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: true })
    assert.deepEqual(calls.filter(call => call[0] === 'newConversation'), [['newConversation', 'main', doc]])
    assert.deepEqual(calls.filter(call => call[0] === 'setFallbackThreshold'), [['setFallbackThreshold', 680_000]], '兜底压缩线设一次')
    state.refuse = true
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: false, reason: '后台任务还在跑' })
    assert.equal((await h.ctx.context.handoff('main', '相对/路径.md')).reason, '要给交接文档的绝对路径')
})

test('用量提醒：过线提醒一次，之后每涨一档再提醒；执行方的 epoch 变了（压缩、换新对话）就重计，不按涨落猜；经核心的附提醒交给会话', async (t) => {
    const { h, state, turn } = await setup(t)
    state.tokens = 100_000
    await turn('一')
    assert.equal(h.ctx.core.pending('main', ContextModule.USAGE_REMINDER_KEY), false, '没过线不提醒')
    state.tokens = 320_000
    await turn('二')
    await waitFor(() => h.ctx.core.pending('main', ContextModule.USAGE_REMINDER_KEY), '过线提醒')
    assert.match(h.ctx.core.attachments('main')[0].text, /上下文已到约 32 万 token（自动压缩线 68 万，只作兜底）/)
    await h.ctx.core.detach('main', ContextModule.USAGE_REMINDER_KEY)
    state.tokens = 350_000
    await turn('三')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(h.ctx.core.pending('main', ContextModule.USAGE_REMINDER_KEY), false, '同一档不再提醒')
    state.tokens = 420_000
    await turn('四')
    await waitFor(() => h.ctx.core.pending('main', ContextModule.USAGE_REMINDER_KEY), '涨一档再提醒')
    await h.ctx.core.detach('main', ContextModule.USAGE_REMINDER_KEY)
    // 从 42 万压到 25 万：没跌破一半，但压缩过（epoch 变了），照样重计。
    await h.ctx.context.compact('main')
    state.tokens = 250_000
    await turn('五')
    state.tokens = 320_000
    await turn('六')
    await waitFor(() => h.ctx.core.pending('main', ContextModule.USAGE_REMINDER_KEY), '压缩后重计，再过线照样提醒')
})

test('压缩工具只在执行方有主动压缩时出现；交接是必备能力，工具一直在，执行方做不了时照它的原因写明', async (t) => {
    const withOps = await setup(t)
    await withOps.turn('看看工具')
    const tools = (withOps.h.adapter.requests.at(-1).tools ?? []).map(tool => tool.name)
    assert.ok(tools.includes('assistant_context_compact') && tools.includes('assistant_context_handoff'))
    assert.deepEqual(await withOps.h.ctx.context.compact('main', { instructions: '留人物设定' }), { compacted: true })
    assert.deepEqual(withOps.calls.find(call => call[0] === 'compact'), ['compact', 'main', '留人物设定'])

    const bare = await setup(t, { capable: false })
    await bare.turn('看看工具')
    const bareTools = (bare.h.adapter.requests.at(-1).tools ?? []).map(tool => tool.name)
    assert.ok(!bareTools.includes('assistant_context_compact') && bareTools.includes('assistant_context_handoff'))
    const doc = join(bare.h.root, '交接.md')
    await writeFile(doc, '进行中')
    assert.match((await bare.h.ctx.context.handoff('main', doc)).reason, /不能换新对话/)
    assert.match((await bare.h.ctx.context.compact('main')).reason, /不能主动压缩/)
})

test('交接标记：执行方真换过新对话以后经 onSwitched 回来，上下文模块往经历库推一条"交接"', async (t) => {
    const ExperienceModule = await import('../experience/index.js')
    const { h, state } = await setup(t)
    const experience = await h.ctx.plugin(ExperienceModule, { archiveFile: join(h.root, 'experience.sqlite'), pullSeconds: 0, startupDelaySeconds: 0 })
    t.after(() => experience.dispose())
    state.switchAt = Date.parse('2026-11-05T11:00:00+08:00')
    const doc = join(h.root, '交接.md')
    await writeFile(doc, '进行中')
    assert.deepEqual(await h.ctx.context.handoff('main', doc), { scheduled: true })
    const entries = (await h.ctx.experience.read({ sessionId: 'main', at: '2000-01-01' }, { kind: 'external', name: 't', readOnly: true })).entries
    assert.deepEqual(entries.map(item => [item.ref, item.kind, item.text]), [[`marker:main:handoff:${state.switchAt}`, '交接', `交接到新对话，交接文档：${doc}`]])
})

test('recentTurns 把出口交来的中途发送并进原文；出口读不到时写明一句', async (t) => {
    const { h, turn } = await setup(t)
    await turn('第一句')
    let answer = null
    const fiber = await h.ctx.plugin({
        name: 'probe-sends',
        inject: ['core'],
        apply: ctx => { ctx.core.exits.register({ id: 'probe', sessions: () => [], sentBetween: () => answer }) },
    })
    t.after(() => fiber.dispose())
    assert.match(await h.ctx.context.recentTurns('main'), /没读到/)
    answer = [{ at: Date.now() + 1, text: '发到手机的话' }]
    const text = await h.ctx.context.recentTurns('main')
    assert.ok(text.includes('用户：第一句') && text.endsWith('你（中途发的）：发到手机的话') && !text.includes('没读到'))
})
