/**
 * 经历库的内置来源 DSH 会话：谁说的按 source.speaker 记、去掉来源标注；启动时整份读、之后一条条收；seq 接不上整份补读；
 * 旧日志没有 speaker 的保留库里的旧分类。核心、会话、SQLite 都是真的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import * as ExperienceModule from '../experience/index.js'
import { openArchive } from '../experience/archive.js'
import { nextStep } from '../experience/dsh.js'
import { createUserMessage, makeHarness, waitFor } from './harness.mjs'

const say = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function mountExperience(t, h) {
    const fiber = await h.ctx.plugin(ExperienceModule, { archiveFile: join(h.root, 'experience.sqlite'), pullSeconds: 0, startupDelaySeconds: 0 })
    t.after(() => fiber.dispose())
    return fiber
}

const HUB = { kind: 'external', name: 'test', readOnly: true }
const entriesOf = async (h, sessionId) => {
    try {
        return (await h.ctx.experience.read({ sessionId, at: '2000-01-01', limit: 100 }, HUB)).entries
    } catch (error) {
        if (/没有条目/.test(error.message)) return []
        throw error
    }
}

test('经历库所在的目录还没有时自己建上，不靠别的模块先建好', async (t) => {
    const h = await makeHarness(t)
    const fiber = await h.ctx.plugin(ExperienceModule, { archiveFile: join(h.root, 'galatea', 'nested', 'experience.sqlite'), pullSeconds: 0, startupDelaySeconds: 0 })
    t.after(() => fiber.dispose())
    await waitFor(() => h.ctx.get('experience') !== undefined, '经历库起来')
})

test('谁说的按 source.speaker 记，来源标注去掉；启动时整份读，之后的一轮一条条收进来', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    agent.followup(say('我本人说的'))
    await waitFor(async () => (await h.turnEnds('main')).length === 1, '第一轮')
    await mountExperience(t, h)
    await waitFor(async () => h.ctx.experience.stats().entries >= 2, '启动时整份读')
    await h.ctx.core.deliver('main', { key: 'k1', text: '项目会话转来的话', source: { kind: 'assistant-session' }, speaker: { kind: 'session', sessionId: 'work-1' }, link: 'L9' })
    await waitFor(async () => (await h.turnEnds('main')).length === 2, '第二轮')
    await waitFor(async () => (await entriesOf(h, 'main')).length === 4, '第二轮一条条收进来')
    const entries = await entriesOf(h, 'main')
    assert.deepEqual(entries.map(item => [item.role, item.kind]), [['用户', '用户'], ['助手', '回复'], ['会话转来', '会话转来'], ['助手', '回复']])
    assert.equal(entries[0].party, '桌面')
    assert.equal(entries[2].party, '会话 work-1')
    assert.equal(entries[2].link, 'L9')
    assert.equal(entries[2].text, '项目会话转来的话', '来源标注去掉，只留原文')
    assert.match(entries[0].ref, /^dsh:main:\d+$/, '编号照旧')
})

test('收到一条事件时：第一次见到、seq 接不上就整份补读；正好接上就收这一条；整份读时已经读到的、子代理会话的跳过', () => {
    assert.equal(nextStep(undefined, 7), 'reread')
    assert.equal(nextStep({ lastSeq: 6 }, 7), 'feed')
    assert.equal(nextStep({ lastSeq: 6 }, 9), 'reread', '漏了 7、8')
    assert.equal(nextStep({ lastSeq: 9 }, 8), 'skip', '整份读时已经读到')
    assert.equal(nextStep(null, 3), 'skip', '子代理会话')
})

test('旧日志里没有 speaker 的消息：库里已有的保留旧分类，没有的记"来处不明"', async (t) => {
    const h = await makeHarness(t, { core: false })
    const agent = await h.createSession('main')
    agent.followup(say('核心装上之前说的一'))
    await waitFor(async () => (await h.turnEnds('main')).length === 1, '第一轮')
    agent.followup(say('核心装上之前说的二'))
    await waitFor(async () => (await h.turnEnds('main')).length === 2, '第二轮')
    await h.mountCore()
    const [first] = (await h.events('main')).filter(event => event.type === 'user/message')
    // 旧插件收录过第一句（分类是"用户·QQ"），迁移后 origin 改成 dsh-events。
    const archive = openArchive(join(h.root, 'experience.sqlite'))
    archive.write({ source: 'dsh', sessionId: 'main', origin: 'dsh-events' }, [{ id: `dsh:main:${first.seq}`, at: first.time, tie: first.seq, role: 'user', kind: '用户', party: 'QQ', text: '核心装上之前说的一' }])
    archive.close()
    await mountExperience(t, h)
    await waitFor(async () => h.ctx.experience.stats().entries >= 4, '启动时整份读')
    const inputs = (await entriesOf(h, 'main')).filter(item => item.kind !== '回复')
    assert.deepEqual(inputs.map(item => [item.text, item.kind, item.party ?? null]), [
        ['核心装上之前说的一', '用户', 'QQ'],
        ['核心装上之前说的二', '来处不明', null],
    ])
})
