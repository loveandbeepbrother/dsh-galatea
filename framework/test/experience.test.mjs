/**
 * 经历库（第一块）：来源注册（推送、拉取、编号重复拒收、重算只动自己的）、按调用方限制能查的范围、串联不经过看不见的时间线、
 * 语义检索。核心、项目登记、SQLite 都是真的，向量提供方是固定向量的假的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import * as ExperienceModule from '../experience/index.js'
import { makeHarness, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })
const T0 = Date.parse('2026-11-05T10:00:00+08:00')
const entry = (id, thread, minute, role, kind, text, extra = {}) => ({ id, thread, at: T0 + minute * 60_000, tie: minute, role, kind, text, ...extra })

async function setup(t, { embedder = false } = {}) {
    const h = await makeHarness(t, { controller: true })
    const reports = []
    h.ctx.core.onReport(item => reports.push(item))
    if (embedder) {
        const fake = await h.ctx.plugin({
            name: 'test-embedder',
            apply: ctx => ctx.provide('embedder', {
                id: 'fake', model: 'fake', dimensions: 2,
                embed: async texts => texts.map(text => Float32Array.from(/猫|喵/.test(text) ? [1, 0] : [0, 1])),
            }),
        })
        t.after(() => fake.dispose())
    }
    const content = h.coreConfig.contentDirectory
    const novel = join(h.workDirectory, 'novel')
    for (const path of [content, novel]) await mkdir(path, { recursive: true })
    await h.ctx.workspaceRegistry.create(novel, '小说')
    for (const [id, cwd] of [['main', content], ['writer', novel], ['editor', novel], ['stranger', h.workDirectory]]) await h.createSession(id, { cwd })
    await h.ctx.core.sessions.setHub('main', { by: BY })
    for (const id of ['writer', 'editor', 'stranger']) await h.ctx.core.sessions.assign(id, 'worker', { by: BY })
    await new Promise(resolve => setTimeout(resolve, 50))
    const fiber = await h.ctx.plugin(ExperienceModule, { archiveFile: join(h.root, 'experience.sqlite'), pullSeconds: 0, startupDelaySeconds: 0 })
    t.after(() => fiber.dispose())
    const who = id => ({ kind: 'session', sessionId: id, role: h.ctx.core.sessions.roleOf(id) })
    return { h, reports, who }
}

test('推送式来源：按时间线写入；别的来源用过的编号拒收并报出来；replaceFrom 只删这个来源、这条时间线里 tie 不小于它的', async (t) => {
    const { h, reports, who } = await setup(t)
    const a = h.ctx.experience.registerSource({ id: 'test-a', label: '甲来源', category: 'dsh' })
    const b = h.ctx.experience.registerSource({ id: 'test-b', label: '乙来源', category: 'dsh' })
    a.append([entry('a1', 'main', 1, 'user', '用户·桌面', '今天写第三章'), entry('a2', 'main', 2, 'assistant', '回复', '好的，先列提纲')])
    b.append([entry('b1', 'main', 3, 'peer', '项目会话转来', '第三章初稿好了')])
    assert.equal(b.append([entry('a1', 'main', 9, 'user', '用户·桌面', '冒名的')]), 0)
    assert.match(reports.find(item => item.kind === 'experience/duplicate-id').text, /a1 已经属于来源 test-a/)
    a.append([entry('a2', 'main', 2, 'assistant', '回复', '改过的回复')], { replaceFrom: { thread: 'main', tie: 2 } })
    a.append([], { replaceFrom: { thread: 'main', tie: 2 } })
    const read = await h.ctx.experience.read({ sessionId: 'main', at: '2026-11-05' }, who('main'))
    assert.deepEqual(read.entries.map(item => item.ref), ['a1', 'b1'], '甲的 a2 删了，乙的 b1 不动')
    assert.throws(() => a.append([{ id: 'x', thread: 'main' }]), /缺 at、tie、role、kind 或 text/)
})

test('拉取式来源：启动后问一次，位置存进库里，下次带着位置问', async (t) => {
    const { h, who } = await setup(t)
    const asked = []
    h.ctx.experience.registerSource({
        id: 'test-pull', label: '拉取', category: 'claude-code',
        pull: async (cursor) => {
            asked.push(cursor)
            const next = (cursor ?? 0) + 1
            return { entries: [entry(`p${next}`, 'cc-1', next, 'user', '用户', `第 ${next} 条`)], cursor: next }
        },
    })
    await waitFor(() => asked.length >= 1, '第一次拉')
    await h.ctx.experience.refresh()
    assert.deepEqual(asked.slice(0, 2), [undefined, 1])
    const read = await h.ctx.experience.read({ sessionId: 'cc-1', at: '2026-11-05' }, who('main'))
    assert.deepEqual(read.entries.map(item => item.ref), ['p1', 'p2'])
})

test('文件型来源：一次拉取里逐份 append（各带 replaceFrom、ops），只交回位置；条目带标题时整条时间线跟着改；别的来源按 label 显示', async (t) => {
    const { h, who } = await setup(t)
    const asked = []
    let source
    source = h.ctx.experience.registerSource({
        id: 'test-files', label: '外部记录', category: 'notes-app',
        pull: async (cursor) => {
            asked.push(cursor)
            if (cursor !== undefined) {
                // 第二份文件重算：只动它自己那一部分；标题改了，前面的条目跟着改。
                source.append([entry('f2', 'doc-1', 2, 'assistant', '回复', '重算后的回复', { part: 'b.jsonl', title: '新标题' })],
                    { replaceFrom: { thread: 'doc-1', part: 'b.jsonl', tie: 0 }, ops: [{ id: 'op-2', thread: 'doc-1', part: 'b.jsonl', at: T0 + 120_000, tie: 2, tool: 'Read', detail: 'file_path=b.md' }] })
                return { entries: [], cursor: { files: 2 } }
            }
            source.append([entry('f1', 'doc-1', 1, 'user', '用户', '第一份', { part: 'a.jsonl', title: '旧标题' })], { replaceFrom: { thread: 'doc-1', part: 'a.jsonl', tie: 0 } })
            source.append([entry('f2', 'doc-1', 2, 'assistant', '回复', '第二份', { part: 'b.jsonl', title: '旧标题' })], { replaceFrom: { thread: 'doc-1', part: 'b.jsonl', tie: 0 } })
            return { entries: [], cursor: { files: 1 } }
        },
    })
    await waitFor(() => asked.length >= 1, '第一次拉')
    await h.ctx.experience.refresh()
    assert.deepEqual(asked.slice(0, 2), [undefined, { files: 1 }], '位置照样存')
    const read = await h.ctx.experience.read({ sessionId: 'doc-1', at: '2026-11-05' }, who('main'))
    assert.deepEqual(read.entries.map(item => [item.ref, item.text]), [['f1', '第一份'], ['f2', '重算后的回复']])
    assert.equal(read.where, '外部记录「新标题」（doc-1）', '按来源的 label 显示，标题整条时间线跟着改')
    assert.ok(read.entries[1].ops?.some(line => line.includes('b.md')), 'append 带的操作记下了')
})

test('能查的范围：中枢看全部；工作会话只看本项目的会话；串联不经过看不见的时间线，只写数目', async (t) => {
    const { h, who } = await setup(t)
    const s = h.ctx.experience.registerSource({ id: 'test-s', label: '会话', category: 'dsh' })
    s.append([
        entry('w1', 'writer', 1, 'out', '发给编辑', '第三章请审', { link: 'L1' }),
        entry('e1', 'editor', 2, 'peer', '作者转来', '第三章请审', { link: 'L1' }),
        entry('e2', 'editor', 3, 'out', '发给中枢', '第三章审完了', { link: 'L2' }),
        entry('m1', 'main', 4, 'peer', '编辑转来', '第三章审完了', { link: 'L2' }),
        entry('x1', 'stranger', 5, 'user', '用户', '第三章不相干的事'),
    ])
    const refs = async id => (await h.ctx.experience.search({ query: '第三章' }, who(id))).items.map(item => item.ref).sort()
    assert.deepEqual(await refs('main'), ['e1', 'e2', 'm1', 'w1', 'x1'])
    assert.deepEqual(await refs('writer'), ['e1', 'e2', 'w1'], '同一项目的两个会话，别的看不到')
    assert.deepEqual(await refs('stranger'), ['x1'], '不在项目里的工作会话只看自己')
    await assert.rejects(h.ctx.experience.read({ sessionId: 'main' }, who('writer')), /看不到会话 main/)
    await assert.rejects(h.ctx.experience.read({ ref: 'm1' }, who('writer')), /没有 m1/)

    const fromWriter = await h.ctx.experience.thread({ ref: 'w1' }, who('writer'))
    assert.deepEqual(fromWriter.items.map(item => item.ref), ['w1', 'e1', 'e2'], '中枢那一段看不到，也不从它往下走')
    assert.equal(fromWriter.note, '另有 1 处关联在你看不到的会话里')
    const fromHub = await h.ctx.experience.thread({ ref: 'w1' }, who('main'))
    assert.deepEqual(fromHub.items.map(item => item.ref), ['w1', 'e1', 'e2', 'm1'])
    assert.equal(fromHub.note, undefined)
})

test('语义检索：向量后台补算；没有字面命中也能按意思找到；没有向量提供方只按关键词并写明', async (t) => {
    const { h, who } = await setup(t, { embedder: true })
    const s = h.ctx.experience.registerSource({ id: 'test-s', label: '会话', category: 'dsh' })
    s.append([entry('c1', 'main', 1, 'user', '用户', '样本里的猫叫甲'), entry('c2', 'main', 2, 'user', '用户', '明天要下雨')])
    await waitFor(() => h.ctx.experience.stats().vectors === 2, '向量补算完')
    const found = await h.ctx.experience.search({ query: '喵星人' }, who('main'))
    assert.deepEqual(found.items.map(item => item.ref), ['c1'])
    assert.equal(found.items[0].match, 'semantic')
    assert.match(found.note, /关键词、语义各取前 30 名合并/)

    const bare = await setup(t)
    bare.h.ctx.experience.registerSource({ id: 'test-s', label: '会话', category: 'dsh' }).append([entry('c1', 'main', 1, 'user', '用户', '家里的样本猫')])
    const plain = await bare.h.ctx.experience.search({ query: '样本猫' }, bare.who('main'))
    assert.deepEqual(plain.items.map(item => item.ref), ['c1'])
    assert.match(plain.note, /没有向量提供方，只做了关键词检索/)
})
