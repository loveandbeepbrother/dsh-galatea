/**
 * 记忆模块：谁能写、能查什么；语义加关键词检索；向量随记忆删、载入时清掉对不上的；记忆目录和它的变更说明；
 * 用户原地改文件、文件名不合规。核心、会话、内容库（真的 Git）、项目登记都是真的，向量提供方是固定向量的假的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as MemoryModule from '../memory/index.js'
import { describeIndexChange, indexText } from '../memory/store.js'
import { makeHarness } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })

/** 固定向量：含"猫"的文本朝一个方向，其余朝另一个方向。 */
function fakeEmbedder(calls) {
    return {
        name: 'test-embedder',
        apply(ctx) {
            ctx.provide('embedder', {
                id: 'fake', model: 'fake-model', dimensions: 2,
                async embed(texts) {
                    calls.push(texts.length)
                    return texts.map(text => Float32Array.from(/猫|喵/.test(text) ? [1, 0] : [0, 1]))
                },
            })
        },
    }
}

async function setup(t, { embedder = true } = {}) {
    const h = await makeHarness(t, { controller: true })
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const embedCalls = []
    if (embedder) {
        const fiber = await h.ctx.plugin(fakeEmbedder(embedCalls))
        t.after(() => fiber.dispose())
    }
    const content = h.coreConfig.contentDirectory
    const novel = join(h.workDirectory, 'novel')
    const garden = join(h.workDirectory, 'garden')
    for (const path of [content, novel, garden]) await mkdir(path, { recursive: true })
    const book = await h.ctx.workspaceRegistry.create(novel, '小说')
    const yard = await h.ctx.workspaceRegistry.create(garden, '园子')
    await h.createSession('main', { cwd: content })
    await h.createSession('idle', { cwd: content })
    await h.createSession('writer', { cwd: novel })
    await h.createSession('gardener', { cwd: garden })
    await h.ctx.core.sessions.setHub('main', { by: BY })
    await h.ctx.core.sessions.assign('idle', 'background', { by: BY })
    await h.ctx.core.sessions.assign('writer', 'worker', { by: BY })
    await h.ctx.core.sessions.assign('gardener', 'worker', { by: BY })
    await new Promise(resolve => setTimeout(resolve, 50))
    const memoryFiber = await h.ctx.plugin(MemoryModule, {})
    t.after(() => memoryFiber.dispose())
    const endpoints = {}
    const call = async (id, name, args) => {
        endpoints[id] ??= await h.ctx.core.toolEndpoint.open(id)
        const response = await fetch(endpoints[id].url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoints[id].token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name === null ? 'tools/list' : 'tools/call', params: name === null ? {} : { name, arguments: args } }),
        })
        const body = JSON.parse(await response.text())
        if (name === null) return body.result.tools.map(tool => tool.name)
        const text = body.result.content[0].text
        return body.result.isError ? { error: text } : JSON.parse(text)
    }
    return { h, reports, content, book, yard, call, embedCalls, memoryFiber }
}

test('谁能写、能查什么：中枢写全局，工作会话默认写本项目、写不了全局；工作会话只查得到全局和本项目，中枢、后台思考查全部', async (t) => {
    const { h, content, book, call } = await setup(t)
    const shared = await call('main', 'assistant_memory_write', { title: '猫的样本', summary: '样本里有一只猫', body: '猫叫甲。' })
    assert.match(shared.id, /^mem-/)
    const file = await readFile(join(content, 'memories', `${shared.id}.md`), 'utf8')
    assert.match(file, /^scope: global$/m)
    assert.match(file, /^sources:\n {2}- 会话 main（hub）$/m, '不传来源时写调用方')

    const chapter = await call('writer', 'assistant_memory_write', { title: '线索甲', summary: '钥匙在甲处', body: '钥匙放在甲处。' })
    assert.match(await readFile(join(content, 'memories', `${chapter.id}.md`), 'utf8'), new RegExp(`^scope: workspace:${book.id}$\\n^project: 小说$`, 'm'))
    assert.match((await call('writer', 'assistant_memory_write', { title: 'x', summary: 'x', body: 'x', scope: 'global' })).error, /不能写范围 global/)
    await call('gardener', 'assistant_memory_write', { title: '番茄', summary: '番茄要搭架子', body: '番茄长到半米要搭架子。' })

    const titles = async id => (await call(id, 'assistant_memory_search', { query: '番茄 钥匙 猫甲' })).hits.map(hit => hit.title).sort()
    assert.deepEqual(await titles('writer'), ['猫的样本', '线索甲'], '工作会话看不到别的项目')
    assert.deepEqual(await titles('main'), ['猫的样本', '番茄', '线索甲'])
    assert.deepEqual(await titles('idle'), ['猫的样本', '番茄', '线索甲'])
    assert.match((await call('writer', 'assistant_memory_read', { id: (await call('main', 'assistant_memory_search', { query: '番茄' })).hits[0].id })).error, /没有记忆/)

    assert.match((await call('idle', 'assistant_memory_write', { title: 'x', summary: 'x', body: 'x', scope: 'project' })).error, /不在项目里/)
    const index = (await h.ctx.core.segments.open('cc', 'writer')).find(entry => entry.name === MemoryModule.INDEX_SEGMENT).text
    assert.match(index, /共 2 条/)
    assert.match(index, /［小说］线索甲：钥匙在甲处/)
})

test('检索：语义加关键词；没有关键词命中也能按意思查到；没有向量提供方只按关键词并写明', async (t) => {
    const { call, embedCalls } = await setup(t)
    await call('main', 'assistant_memory_write', { title: '样本动物', summary: '样本里有只猫', body: '猫甲。' })
    await call('main', 'assistant_memory_write', { title: '天气', summary: '下雨', body: '今天下雨。' })
    const found = await call('main', 'assistant_memory_search', { query: '喵星人' })
    assert.deepEqual(found.hits.map(hit => hit.title), ['样本动物'], '没有字面命中，按意思找到')
    assert.equal(found.hits[0].keywordMatch, 0)
    assert.ok(found.hits[0].similarity > 0.9)
    assert.ok(embedCalls.length >= 1)

    const bare = await setup(t, { embedder: false })
    const written = await bare.call('main', 'assistant_memory_write', { title: '样本动物', summary: '样本里有只猫', body: '猫甲。' })
    assert.match(written.note, /没有向量提供方/)
    const plain = await bare.call('main', 'assistant_memory_search', { query: '有只猫' })
    assert.deepEqual(plain.hits.map(hit => hit.title), ['样本动物'])
    assert.match(plain.note, /只按关键词/)
    assert.deepEqual((await bare.call('main', 'assistant_memory_search', { query: '喵星人' })).hits, [])
})

test('删记忆连向量一起删；用户原地改文件，目录和检索都看得到；文件名不合规的报一次', async (t) => {
    const { h, reports, content, call, memoryFiber } = await setup(t)
    const written = await call('main', 'assistant_memory_write', { title: '猫', summary: '样本猫', body: '猫甲。' })
    const kept = await call('main', 'assistant_memory_write', { title: '狗', summary: '邻居的狗', body: '旺财。' })
    const read = await call('main', 'assistant_memory_read', { id: written.id })
    assert.equal(read.hash, written.hash)
    const path = join(content, 'memories', `${written.id}.md`)
    await writeFile(path, (await readFile(path, 'utf8')).replace('summary: 样本猫', 'summary: 用户手改过的摘要'))
    const index = (await h.ctx.core.segments.open('cc', 'main')).find(entry => entry.name === MemoryModule.INDEX_SEGMENT).text
    assert.match(index, /猫：用户手改过的摘要/, '原地改文件也看得到')
    assert.match((await call('main', 'assistant_memory_forget', { id: written.id, baseHash: written.hash })).error, /已经变了/, '用户改过以后旧哈希删不了')
    const fresh = await call('main', 'assistant_memory_read', { id: written.id })
    assert.equal((await call('main', 'assistant_memory_forget', { id: written.id, baseHash: fresh.hash, reason: '不准了' })).removed, true)
    await writeFile(join(content, 'memories', 'random.md'), '随手放的')
    await call('main', 'assistant_memory_search', { query: '随手' })
    await call('main', 'assistant_memory_search', { query: '随手' })
    assert.equal(reports.filter(entry => entry.kind === 'memory/bad-file').length, 1)
    // 存储域由记忆模块占着：卸下它再打开核对。
    await memoryFiber.dispose()
    const domain = await h.ctx.storageDomain.open(MemoryModule.vectorsDomainSpec)
    try {
        assert.equal(domain.table('vectors').get(written.id), undefined, '向量跟着删了')
        assert.notEqual(domain.table('vectors').get(kept.id), undefined, '别的向量还在')
    } finally {
        await domain.close?.()
    }
})

test('记忆目录的变更说明按编号比：新增或修改、删掉了、被挤出目录分开说', () => {
    const memory = (id, title, updated) => ({ id: `mem-${id}`, title, summary: '摘要', scope: 'global', updated })
    const A = '0AAAAAAAAAAAAAAAAAAAAAAAAA'
    const B = '0BBBBBBBBBBBBBBBBBBBBBBBBB'
    const C = '0CCCCCCCCCCCCCCCCCCCCCCCCC'
    const before = indexText([memory(A, '甲', '1'), memory(B, '乙', '2')], 1000)
    const after = indexText([memory(B, '乙改', '3'), memory(C, '丙', '4')], 1000)
    const note = describeIndexChange(before, after, id => id === `mem-${A}` ? false : true)
    assert.match(note, /新增或修改：\n- mem-0C+ 丙：摘要\n- mem-0B+ 乙改：摘要/)
    assert.match(note, new RegExp(`已删掉：mem-${A}`))
    const squeezed = describeIndexChange(before, after, () => true)
    assert.match(squeezed, new RegExp(`目录满了没再列出（记忆还在，可以检索）：mem-${A}`))
})
