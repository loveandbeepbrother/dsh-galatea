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

async function setup(t, { embedder = false, coreConfig } = {}) {
    const h = await makeHarness(t, { controller: true, coreConfig })
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
    // 同一次发送的两份（关联相同）只留一条；串联（thread）照样看得到两边。
    const linksOf = async id => (await h.ctx.experience.search({ query: '第三章' }, who(id))).items.map(item => item.link ?? item.ref).sort()
    assert.deepEqual(await linksOf('main'), ['L1', 'L2', 'x1'])
    assert.deepEqual(await linksOf('writer'), ['L1', 'L2'], '同一项目的两个会话，别的看不到')
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

test('时间：结果按核心的时区写、带偏移，另给多久以前；给出的 at 原样传回 since、until 是同一刻；不带偏移的按核心的时区', async (t) => {
    const { h, who } = await setup(t, { coreConfig: { timezone: 'America/New_York' } })
    const s = h.ctx.experience.registerSource({ id: 'test-s', label: '会话', category: 'dsh' })
    s.append([
        entry('a1', 'main', 1, 'user', '用户', '第一句关于风车'),
        entry('a2', 'main', 2, 'user', '用户', '第二句关于风车'),
        entry('a3', 'main', 3, 'user', '用户', '第三句关于风车'),
    ])
    const search = async args => (await h.ctx.experience.search({ query: '风车', ...args }, who('main'))).items
    const items = await search({})
    const second = items.find(item => item.ref === 'a2')
    assert.equal(second.at, '2026-11-04 21:02-05:00', 'T0 是北京 11-05 10:00，纽约是前一天 21:00')
    assert.match(second.ago, /前$/)
    assert.deepEqual((await search({ since: second.at })).map(item => item.ref).sort(), ['a2', 'a3'], 'since 含那一刻')
    assert.deepEqual((await search({ until: second.at })).map(item => item.ref), ['a1'], 'until 不含那一刻')
    assert.deepEqual((await search({ since: '2026-11-04 21:03' })).map(item => item.ref), ['a3'], '不带偏移的按核心的时区（纽约）')
    assert.deepEqual((await search({ since: '2026-11-05T02:03:00Z' })).map(item => item.ref), ['a3'], 'UTC 写法照认')
    const read = await h.ctx.experience.read({ ref: 'a2', limit: 1 }, who('main'))
    assert.equal(read.entries[0].at, second.at, '读原文的时间写法一样')
})

test('标题：后来一条条收进来、没写标题的条目沿用这个会话已有的标题（重启以后的增量不再显示成会话编号）', async (t) => {
    const { h, who } = await setup(t)
    const s = h.ctx.experience.registerSource({ id: 'test-s', label: '会话', category: 'dsh' })
    s.append([entry('t1', 'main', 1, 'user', '用户', '第一句关于钟楼', { title: '日常对话' })])
    s.append([entry('t2', 'main', 2, 'user', '用户', '第二句关于钟楼')])
    s.append([entry('t3', 'writer', 3, 'user', '用户', '别的会话关于钟楼')])
    const where = Object.fromEntries((await h.ctx.experience.search({ query: '钟楼' }, who('main'))).items.map(item => [item.ref, item.where]))
    assert.match(where.t2, /「日常对话」/)
    assert.doesNotMatch(where.t3, /日常对话/, '别的会话不沾')
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

test('交接整理的摘录：从上次边界起，只要说的话；截短、带编号，超上限留最新的；快照和系统条目不要', async (t) => {
    const { h } = await setup(t)
    const source = h.ctx.experience.registerSource({ id: 'digest', label: '来源', category: 'dsh' })
    source.append([
        entry('d0', 'main', 1, 'user', '用户·桌面', '边界之前说的'),
        entry('d1', 'main', 2, 'system', '交接', '交接到新对话'),
        entry('d2', 'main', 3, 'user', '用户·桌面', `用户说的长话${'字'.repeat(2500)}`),
        entry('d3', 'main', 4, 'system', '系统', 'Current runtime context. 一大段快照'),
        entry('d4', 'main', 5, 'user', '用户·桌面', 'Current runtime context. 混在用户条目里的快照'),
        entry('d5', 'main', 6, 'assistant', '回复', '助手的回复'),
        entry('d6', 'main', 7, 'assistant', '思考', '助手的思考'),
        entry('d7', 'main', 8, 'out', '发往手机', '发到手机的话'),
        entry('d8', 'main', 9, 'peer', '项目会话转来', '项目回报'),
    ])
    const all = h.ctx.experience.digest('main', { maxChars: 60_000 })
    assert.equal(all.entries, 4)
    assert.equal(all.omitted, 0)
    assert.doesNotMatch(all.text, /边界之前|一大段快照|混在用户条目|助手的思考/)
    assert.match(all.text, /……（共 2506 字）/)
    assert.ok(all.text.indexOf('用户说的长话') < all.text.indexOf('项目回报'), '按时间顺序')
    assert.match(all.text, /d5\] 助手的回复/)

    const capped = h.ctx.experience.digest('main', { maxChars: 200 })
    assert.equal(capped.entries, 3, '放不下的最旧的那条不放')
    assert.equal(capped.omitted, 1)
    assert.equal(capped.oldestRef, 'd2')
    assert.doesNotMatch(capped.text, /用户说的长话/)
})

test('只有操作、没有条目的一批：操作不丢（记录里一段只有工具调用，读取位置已经往前走了，丢了就补不回来）', async (t) => {
    const { h, who } = await setup(t)
    let batch = 0
    const source = h.ctx.experience.registerSource({
        id: 'test-ops-only', label: '只有操作', category: 'dsh',
        pull: async () => {
            batch += 1
            if (batch === 1) return { entries: [entry('o1', 'doc-ops', 1, 'user', '用户', '先查一下')], cursor: { n: 1 } }
            if (batch === 2) return { entries: [], ops: [{ id: 'op-only', thread: 'doc-ops', at: T0 + 120_000, tie: 2, tool: 'Grep', detail: '只有工具调用的一批' }], cursor: { n: 2 } }
            return { entries: [entry('o2', 'doc-ops', 3, 'assistant', '回复', '查完了')], cursor: { n: 3 } }
        },
    })
    t.after(() => source.dispose?.())
    await waitFor(() => batch >= 1, '第一次拉')
    await h.ctx.experience.refresh()
    await h.ctx.experience.refresh()
    const read = await h.ctx.experience.read({ sessionId: 'doc-ops', at: '2026-11-05' }, who('main'))
    const reply = read.entries.find(item => item.ref === 'o2')
    assert.ok(reply.ops?.some(line => line.includes('只有工具调用的一批')), JSON.stringify(reply))
})

test('向量补算：失败报一次，写进 searched；恢复时报 resolved，searched 不再带错误；之后再坏再报', async (t) => {
    const { h, who, reports } = await setup(t)
    let failing = true
    const fake = await h.ctx.plugin({
        name: 'test-flaky-embedder',
        apply: ctx => ctx.provide('embedder', {
            id: 'flaky', model: 'flaky', dimensions: 2,
            embed: async (texts) => {
                if (failing && texts.some(text => text.includes('补算'))) throw new Error('connect ETIMEDOUT')
                return texts.map(() => Float32Array.from([1, 0]))
            },
        }),
    })
    t.after(() => fake.dispose())
    const source = h.ctx.experience.registerSource({ id: 'test-embed', label: '来源', category: 'dsh' })
    const kinds = () => reports.filter(item => item.kind === 'experience/embed-failed')
    source.append([entry('e1', 'main', 1, 'user', '用户·桌面', '要补算的第一句')])
    await waitFor(() => kinds().length === 1, '失败报了')
    const degraded = await h.ctx.experience.search({ query: '第一句' }, who('main'))
    assert.equal(degraded.searched.backfillError, 'connect ETIMEDOUT')

    failing = false
    source.append([entry('e2', 'main', 2, 'user', '用户·桌面', '要补算的第二句')])
    await waitFor(() => kinds().some(item => item.data?.resolved === true), '恢复时关掉')
    await waitFor(async () => (await h.ctx.experience.search({ query: '第一句' }, who('main'))).searched.backfillError === undefined, '不再带错误')

    failing = true
    source.append([entry('e3', 'main', 3, 'user', '用户·桌面', '要补算的第三句')])
    await waitFor(() => kinds().filter(item => item.data?.resolved !== true).length === 2, '再坏再报')
})
