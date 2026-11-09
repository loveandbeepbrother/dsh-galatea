/** 检索底座接真模块：真的核心、真的工具端点、真的记忆和经历、真的 worker。向量是假的。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as ExperienceModule from '../experience/index.js'
import * as MemoryModule from '../memory/index.js'
import * as SearchModule from '../search/index.js'
import { fuse, snippetOf } from '../search/index.js'
import { makeHarness, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })
const T0 = Date.parse('2026-11-05T10:00:00+08:00')
const entry = (id, thread, minute, role, kind, text) => ({ id, thread, at: T0 + minute * 60_000, tie: minute, role, kind, text })

async function setup(t, { embed, documents = [] } = {}) {
    const h = await makeHarness(t, { controller: true })
    const dir = await mkdtemp(join(tmpdir(), 'search-'))
    const fibers = []
    t.after(async () => {
        for (const fiber of fibers) await fiber.dispose()
        await new Promise(resolve => setTimeout(resolve, 50))
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    if (embed !== undefined) {
        fibers.push(await h.ctx.plugin({
            name: 'test-embedder',
            apply: ctx => ctx.provide('embedder', { id: 'fake', model: 'fake', dimensions: 2, embed }),
        }))
    }
    const content = h.coreConfig.contentDirectory
    await mkdir(content, { recursive: true })
    const novel = join(h.workDirectory, 'novel')
    await mkdir(novel, { recursive: true })
    const book = await h.ctx.workspaceRegistry.create(novel, '小说')
    for (const [id, cwd] of [['main', content], ['writer', novel], ['stranger', content]]) await h.createSession(id, { cwd })
    await h.ctx.core.sessions.setHub('main', { by: BY })
    await h.ctx.core.sessions.assign('writer', 'worker', { by: BY })
    await h.ctx.core.sessions.assign('stranger', 'worker', { by: BY })
    fibers.push(await h.ctx.plugin(ExperienceModule, { archiveFile: join(dir, 'experience.sqlite') }))
    fibers.push(await h.ctx.plugin(MemoryModule, {}))
    fibers.push(await h.ctx.plugin({
        name: 'search-under-test',
        inject: SearchModule.inject,
        apply: ctx => SearchModule.apply(ctx, new SearchModule.Config({ file: join(dir, 'search.sqlite'), documents, exclude: ['私人草稿'] }), { autoStart: false }),
    }))
    const endpoints = {}
    const call = async (id, name, args) => {
        endpoints[id] ??= await h.ctx.core.toolEndpoint.open(id)
        const response = await fetch(endpoints[id].url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoints[id].token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
        const body = JSON.parse(await response.text())
        if (body.error !== undefined) return { error: body.error.message }
        const text = body.result.content[0].text
        return body.result.isError ? { error: text } : JSON.parse(text)
    }
    return { h, dir, call, book }
}

test('合并和片段：两路都有的排前面；片段落在命中处', () => {
    const merged = fuse([{ how: 'keyword', refs: ['a', 'b'] }, { how: 'semantic', refs: ['b', 'c'] }])
    assert.equal(merged[0].ref, 'b')
    assert.deepEqual(merged[0].how, ['keyword', 'semantic'])
    assert.match(snippetOf(`${'前面'.repeat(100)}目标词${'后面'.repeat(100)}`, ['目标词']), /目标词/)
})

test('统一入口：经历、记忆、便签、文档、工具轨迹一起搜，按来源分组，写明怎么读；七个词也不返回 0 条；系统条目不进', async (t) => {
    const docs = await mkdtemp(join(tmpdir(), 'search-docs-'))
    t.after(() => rm(docs, { recursive: true, force: true }))
    await mkdir(join(docs, '私人草稿'), { recursive: true })
    await writeFile(join(docs, '规划.md'), '# 花园改造计划\n周末直接做的事\n')
    await writeFile(join(docs, '私人草稿', '一.md'), '# 花园改造计划\n不该读\n')
    const { h, call } = await setup(t, { documents: [{ path: docs, label: '笔记' }] })
    const source = h.ctx.experience.registerSource({ id: 'test-search', label: '来源', category: 'dsh' })
    source.append([
        entry('e1', 'main', 1, 'user', '用户·桌面', '花园改造具体先做什么'),
        entry('e2', 'main', 2, 'system', '来处不明', '花园改造 这是注入的提醒'),
    ], { ops: [{ id: 'op1', thread: 'main', at: T0 + 180_000, tie: 3, tool: 'Grep', detail: '花园改造 令牌 FakeToken0Example1Fake2Token3x' }] })
    await call('main', 'assistant_memory_write', { title: '花园改造的方向', summary: '先做检索', body: '正文' })
    await call('main', 'assistant_note_write', { action: 'add', body: '花园改造的便签' })
    await h.ctx.search.syncNow()

    const found = await call('main', 'assistant_search', { query: '花园改造 计划 下一步 周末 待办 花盆分区 改造方向' })
    assert.deepEqual(found.groups.map(group => group.source).sort(), ['documents', 'experience', 'memory', 'notes', 'operations'].sort())
    const of = name => found.groups.find(group => group.source === name)
    assert.equal(of('experience').items.length, 1, '系统条目不进')
    assert.equal(of('experience').items[0].read.tool, 'assistant_history_read')
    assert.equal(of('memory').items[0].read.tool, 'assistant_memory_read')
    assert.equal(of('notes').items[0].read.tool, 'assistant_notes_read')
    assert.equal(of('documents').items.length, 1, '私人草稿没进')
    assert.match(of('documents').items[0].where, /规划\.md:1$/)
    assert.doesNotMatch(JSON.stringify(found), /FakeToken0Example1Fake2Token3x/, '令牌不出来')
    assert.deepEqual(found.searched, { keyword: true, semantic: 'none' })
    assert.match(found.note, /^这次只走了关键词（没有向量提供方）/, '有结果也写明降级')

    const only = await call('main', 'assistant_search', { query: '花园', sources: ['memory'] })
    assert.deepEqual(only.groups.map(group => group.source), ['memory'])
    const nothing = await call('main', 'assistant_search', { query: '绝对没有这个说法zzqq' })
    assert.deepEqual(nothing.groups, [])
    assert.match(nothing.note, /^没搜到不代表没有：这次只走了关键词/)
})

test('可见范围：项目会话只看本项目的经历和记忆、自己的便签；中枢的文档看不到，共用的看得到', async (t) => {
    const docs = await mkdtemp(join(tmpdir(), 'search-docs-'))
    t.after(() => rm(docs, { recursive: true, force: true }))
    await writeFile(join(docs, 'hub.md'), '# 中枢文档\n共同词\n')
    const shared = await mkdtemp(join(tmpdir(), 'search-shared-'))
    t.after(() => rm(shared, { recursive: true, force: true }))
    await writeFile(join(shared, 'all.md'), '# 共用文档\n共同词\n')
    const { h, call } = await setup(t, { documents: [{ path: docs, label: '私', scope: 'hub' }, { path: shared, label: '公', scope: 'shared' }] })
    const source = h.ctx.experience.registerSource({ id: 'test-scope', label: '来源', category: 'dsh' })
    source.append([entry('s-main', 'main', 1, 'user', '用户', '共同词 中枢说的'), entry('s-writer', 'writer', 2, 'user', '用户', '共同词 项目里说的')])
    await call('main', 'assistant_memory_write', { title: '共同词 全局', summary: '摘要', body: '正文' })
    await call('main', 'assistant_note_write', { action: 'add', body: '共同词 中枢便签' })
    await call('writer', 'assistant_note_write', { action: 'add', body: '共同词 项目便签' })
    await h.ctx.search.syncNow()

    const hub = await call('main', 'assistant_search', { query: '共同词', perSource: 20 })
    const refs = (result, name) => result.groups.find(group => group.source === name)?.items.map(item => item.ref) ?? []
    assert.equal(refs(hub, 'experience').length, 2)
    assert.equal(refs(hub, 'documents').length, 2)
    assert.equal(refs(hub, 'notes').length, 2)

    const worker = await call('writer', 'assistant_search', { query: '共同词', perSource: 20 })
    assert.deepEqual(refs(worker, 'experience'), ['s-writer'])
    assert.equal(refs(worker, 'documents').length, 1)
    assert.match(worker.groups.find(group => group.source === 'documents').items[0].where, /all\.md/)
    assert.equal(refs(worker, 'notes').length, 1)
    assert.match(worker.groups.find(group => group.source === 'notes').items[0].snippet, /项目便签/)
    assert.equal(refs(worker, 'memory').length, 1, '全局记忆看得到')
})

test('向量：两路合并；向量挂了退回关键词并写明；连续失败熔断，不再等；文档算向量，只算一次', async (t) => {
    let failing = false
    const calls = []
    const embed = async (texts) => {
        calls.push(texts)
        if (failing) throw new Error('connect ETIMEDOUT')
        return texts.map(text => Float32Array.from(/猫|喵|毛茸茸/.test(text) ? [1, 0] : [0, 1]))
    }
    const docs = await mkdtemp(join(tmpdir(), 'search-docs-'))
    t.after(() => rm(docs, { recursive: true, force: true }))
    await writeFile(join(docs, '猫.md'), '# 喵星人\n它喜欢晒太阳\n')
    const { h, call } = await setup(t, { embed, documents: [{ path: docs, label: '文档', vectors: true }] })
    await h.ctx.search.syncNow()
    const embeddedDocs = calls.flat().filter(text => text.includes('晒太阳')).length
    assert.equal(embeddedDocs, 1)
    await h.ctx.search.syncNow()
    assert.equal(calls.flat().filter(text => text.includes('晒太阳')).length, 1, '没变不重算')

    const semantic = await call('main', 'assistant_search', { query: '毛茸茸的', sources: ['documents'] })
    assert.equal(semantic.searched.semantic, 'ok')
    assert.equal(semantic.groups[0].items[0].match, 'semantic', '没有共同词，靠向量找到')
    assert.equal(semantic.note, undefined, '两路都走了、有结果：不写说明')
    const none = await call('main', 'assistant_search', { query: 'zzqq 不存在的说法', sources: ['notes'] })
    assert.deepEqual(none.groups, [])
    assert.equal(none.note, '能查的都查了（没有降级），没有相关的', '确实没有和降级分开写')

    failing = true
    const first = await call('main', 'assistant_search', { query: '晒太阳 第一次', sources: ['documents'] })
    assert.equal(first.searched.semantic, 'failed')
    assert.match(first.searched.reason, /ETIMEDOUT/)
    assert.equal(first.groups[0].items[0].match, 'keyword', '退回关键词')
    assert.match(first.note, /^这次只走了关键词（.*ETIMEDOUT.*）：意思相近、字面不同的找不到$/, '有结果也写明降级')
    await call('main', 'assistant_search', { query: '晒太阳 第二次', sources: ['documents'] })
    const before = calls.length
    const third = await call('main', 'assistant_search', { query: '晒太阳 第三次', sources: ['documents'] })
    assert.equal(calls.length, before, '熔断了，不再调')
    assert.match(third.searched.reason, /暂时不试/)
})

test('经历检索的关键词也走新索引：不要求每个词都出现；索引没建好时退回旧表', async (t) => {
    const { h, call } = await setup(t)
    const source = h.ctx.experience.registerSource({ id: 'test-history', label: '来源', category: 'dsh' })
    source.append([entry('h1', 'main', 1, 'user', '用户', '花园改造具体先做什么')])
    const before = await call('main', 'assistant_history_search', { query: '花园改造', context: 0 })
    assert.equal(before.items.length, 1, '索引没建好：旧表')
    await h.ctx.search.syncNow()
    const after = await call('main', 'assistant_history_search', { query: '花园改造 另一个完全不相干的词', context: 0 })
    assert.equal(after.items.length, 1, 'OR：七个词不再返回 0 条')
    assert.equal(after.items[0].ref, 'h1')
})

test('跨会话副本：同一次发送在两边各一份，折叠成一条，写明还有几份；前几名不被占满；没有关联的不靠文字猜', async (t) => {
    const { h, call } = await setup(t)
    const source = h.ctx.experience.registerSource({ id: 'test-copies', label: '来源', category: 'dsh' })
    const copy = (id, thread, minute, role, kind, text, link) => ({ ...entry(id, thread, minute, role, kind, text), ...link === undefined ? {} : { link } })
    source.append([
        ...Array.from({ length: 6 }, (_, index) => [
            copy(`sent-${index}`, 'writer', index + 1, 'out', '发给中枢', `副本内容 第 ${index} 次`, `l-${index}`),
            copy(`got-${index}`, 'main', index + 1, 'peer', '转来', `副本内容 第 ${index} 次`, `l-${index}`),
        ]).flat(),
        copy('other', 'main', 20, 'user', '用户', '副本内容 另一件事'),
        copy('same-text', 'writer', 21, 'user', '用户', '副本内容 另一件事'),
    ])
    await h.ctx.search.syncNow()
    const found = await call('main', 'assistant_search', { query: '副本内容', sources: ['experience'], perSource: 20 })
    const items = found.groups[0].items
    assert.equal(items.length, 8, '6 次发送各一条，加两条没有关联的')
    assert.equal(items.filter(item => item.copies === 1).length, 6)
    assert.ok(items.some(item => item.ref === 'other') && items.some(item => item.ref === 'same-text'), '没有关联的文字一样也不折')
    const limited = await call('main', 'assistant_search', { query: '副本内容', sources: ['experience'], perSource: 3 })
    assert.equal(limited.groups[0].items.length, 3, '切条数在折叠之后')

    const history = await call('main', 'assistant_history_search', { query: '副本内容 第', context: 0, limit: 30 })
    const links = history.items.map(item => item.link).filter(Boolean)
    assert.equal(new Set(links).size, links.length, '经历检索的关键词一路也折叠')

    const worker = await call('writer', 'assistant_search', { query: '第 3 次', sources: ['experience'], perSource: 20 })
    assert.deepEqual(worker.groups[0].items.filter(item => item.thread === 'main'), [], '折叠不会让人看到别的时间线')
    assert.ok(worker.groups[0].items.some(item => item.ref === 'sent-3'), '看不到的那份不算，看得到的那份还在')
    assert.ok(worker.groups[0].items.every(item => item.copies === undefined), '看不到的那份也不算进 copies')

    const seen = await call('main', 'assistant_search', { query: '第 3 次', sources: ['experience'], perSource: 20 })
    const third = seen.groups[0].items.find(item => item.snippet.includes('第 3 次'))
    assert.equal(third.ref, 'sent-3', '两份都看得到：交发送方那份')
    assert.equal(third.copies, 1)

    const received = await call('main', 'assistant_history_search', { query: '第 3 次', role: 'peer', context: 0, limit: 30 })
    assert.ok(received.items.some(item => item.ref === 'got-3'), '按角色查，查到符合角色的那一份')
})

test('副本正文不同也只算一条：能看到两份的折叠成一条，只有接收方有的通知也搜得到', async (t) => {
    const { h, call } = await setup(t)
    const source = h.ctx.experience.registerSource({ id: 'test-wrapped', label: '来源', category: 'dsh' })
    source.append([
        { ...entry('sent', 'writer', 1, 'out', '发给中枢', '第三章审完了'), link: 'w1' },
        { ...entry('got', 'main', 1, 'peer', '转来', '第三章审完了\n（回复次数已经用完）'), link: 'w1' },
    ])
    await h.ctx.search.syncNow()
    const both = await call('main', 'assistant_search', { query: '第三章审完了', sources: ['experience'], perSource: 20 })
    assert.equal(both.groups[0].items.length, 1, '看得到两份，折叠成一条')
    assert.equal(both.groups[0].items[0].copies, 1)
    const notice = await call('main', 'assistant_search', { query: '回复次数', sources: ['experience'] })
    assert.equal(notice.groups[0].items[0].ref, 'got')
    const writer = await call('writer', 'assistant_search', { query: '回复次数', sources: ['experience'] })
    assert.deepEqual(writer.groups, [], '发送方的时间线没有这段话，也查不到接收方那份')
})

test('超过 12 个词的普通句子：不因为别的词更稀就丢掉目标的词，两个搜索都一样', async (t) => {
    const { h, call } = await setup(t)
    const source = h.ctx.experience.registerSource({ id: 'test-long-query', label: '来源', category: 'dsh' })
    // 句子里 13 个词各只在一条无关条目里出现一次，目标的两个词更常见（各出现 3 次）。
    const rare = Array.from({ length: 13 }, (_, index) => String.fromCodePoint(0x5000 + index * 2, 0x5001 + index * 2))
    source.append([
        entry('target', 'main', 1, 'user', '用户', '部署窗口'),
        entry('common-1', 'main', 2, 'user', '用户', '部署 别的事情'),
        entry('common-2', 'main', 3, 'user', '用户', '部署 别的事情'),
        entry('common-3', 'main', 4, 'user', '用户', '窗口 另一件事'),
        entry('common-4', 'main', 5, 'user', '用户', '窗口 另一件事'),
        ...rare.map((word, index) => entry(`rare-${index}`, 'main', 6 + index, 'user', '用户', word)),
    ])
    await h.ctx.search.syncNow()
    const query = [...rare, '部署', '窗口'].join(' ')
    const found = await call('main', 'assistant_search', { query, sources: ['experience'], perSource: 20 })
    assert.ok(found.groups[0].items.some(item => item.ref === 'target'), 'assistant_search 搜得到')
    const history = await call('main', 'assistant_history_search', { query, context: 0, limit: 30 })
    assert.ok(history.items.some(item => item.ref === 'target'), 'assistant_history_search 搜得到')
})

test('超过 256 个词的消息：按原文顺序取前 256 个，后面的不算；不报错', async (t) => {
    const { h, call } = await setup(t)
    const source = h.ctx.experience.registerSource({ id: 'test-too-long', label: '来源', category: 'dsh' })
    const words = Array.from({ length: 300 }, (_, index) => String.fromCodePoint(0x5100 + index * 2, 0x5101 + index * 2))
    source.append([
        entry('early', 'main', 1, 'user', '用户', words[255]),
        entry('late', 'main', 2, 'user', '用户', words[256]),
    ])
    await h.ctx.search.syncNow()
    const found = await call('main', 'assistant_search', { query: words.join(' '), sources: ['experience'], perSource: 20 })
    assert.deepEqual(found.groups[0].items.map(item => item.ref), ['early'], '第 256 个词算，第 257 个不算')
})

test('发给会话的条目和工具轨迹同编号：两边都搜得到；按来源核对条数，对不上就报；再对账不重算', async (t) => {
    const { h, call } = await setup(t)
    const reports = []
    h.ctx.core.onReport(item => reports.push(item))
    const source = h.ctx.experience.registerSource({ id: 'test-same-id', label: '来源', category: 'dsh' })
    source.append([entry('shared-id', 'main', 1, 'out', '发给会话', '只有发送方一份的独有词语')], {
        ops: [{ id: 'shared-id', thread: 'main', at: T0 + 60_000, tie: 1, tool: 'assistant_session_send', detail: '轨迹里的另一个词语' }],
    })
    await h.ctx.search.syncNow()
    const sent = await call('main', 'assistant_search', { query: '独有词语', sources: ['experience'] })
    assert.equal(sent.groups[0].items[0].ref, 'shared-id', '条目没被工具轨迹盖掉')
    const operation = await call('main', 'assistant_search', { query: '轨迹里的另一个', sources: ['operations'] })
    assert.equal(operation.groups[0].items[0].ref, 'shared-id')

    await h.ctx.search.syncNow()
    const { lastSync } = h.ctx.search.stats()
    for (const name of ['experience', 'operations', 'memory', 'notes']) {
        assert.equal(lastSync[name].indexed, lastSync[name].expected, `${name} 条数对上`)
        assert.equal(lastSync[name].stale, 0, `${name} 第二轮对账不重算`)
        assert.equal(lastSync[name].removed, 0)
    }
    assert.equal(reports.filter(item => item.kind === 'search/count-mismatch').length, 0)
})

test('向量一路也按一条算：同一次发送的两份只占一个名次，和关键词命中的那份算同一条', async (t) => {
    const embed = async texts => texts.map(() => Float32Array.from([1, 0]))
    const { h, call } = await setup(t, { embed })
    const source = h.ctx.experience.registerSource({ id: 'test-vector-copies', label: '来源', category: 'dsh' })
    const copy = (id, thread, minute, role, kind, text, link) => ({ ...entry(id, thread, minute, role, kind, text), ...link === undefined ? {} : { link } })
    source.append(Array.from({ length: 5 }, (_, index) => [
        copy(`sent-${index}`, 'writer', index + 1, 'out', '发给中枢', `向量副本 第 ${index} 次`, `v-${index}`),
        copy(`got-${index}`, 'main', index + 1, 'peer', '转来', `向量副本 第 ${index} 次`, `v-${index}`),
    ]).flat())
    await h.ctx.experience.refresh()
    await h.ctx.search.syncNow()
    const nearest = h.ctx.experience.nearest(Float32Array.from([1, 0]), 'fake@2', { who: { kind: 'session', sessionId: 'main', role: 'hub' }, limit: 5 })
    assert.equal(nearest.length, 5, '5 个名次是 5 次发送，不是 2 次半')
    const found = await call('main', 'assistant_search', { query: '向量副本', sources: ['experience'], perSource: 10 })
    const items = found.groups[0].items
    assert.equal(items.length, 5)
    assert.ok(items.every(item => item.match === 'both'), '关键词交发送方、向量可能交接收方，都算同一条命中两路')
})

test('写入后马上进索引；重算过的经历、删掉的记忆，对账时跟上', async (t) => {
    const { h, call } = await setup(t)
    await h.ctx.search.syncNow()
    const written = await call('main', 'assistant_memory_write', { title: '刚写的', summary: '摘要', body: '正文' })
    // 不手动同步：写入以后自己重扫。
    await waitFor(async () => (await call('main', 'assistant_search', { query: '刚写的', sources: ['memory'] })).groups[0]?.items[0]?.ref === written.id, '写入后进了索引')
    await h.ctx.memory.forget(written.id, { reason: '测试', baseHash: (await h.ctx.memory.read(written.id, { kind: 'session', sessionId: 'main', role: 'hub' })).hash }, { kind: 'session', sessionId: 'main', role: 'hub' })
    await h.ctx.search.syncNow()
    assert.deepEqual((await call('main', 'assistant_search', { query: '刚写的', sources: ['memory'] })).groups, [])
})
