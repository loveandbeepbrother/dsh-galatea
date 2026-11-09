/**
 * 记忆的使用统计（按调用方分开记，体检不记）、收藏（中枢标、检索能按收藏筛）、“我们之间”、记忆目录列不全时写入提醒。
 * 真的核心、工具端点、经历、记忆、心智、检索底座和 worker。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as ExperienceModule from '../experience/index.js'
import * as MemoryModule from '../memory/index.js'
import * as MindModule from '../mind/index.js'
import * as SearchModule from '../search/index.js'
import { makeHarness } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })

async function setup(t, { memory = {} } = {}) {
    const h = await makeHarness(t, { controller: true })
    const dir = await mkdtemp(join(tmpdir(), 'usage-'))
    const fibers = []
    t.after(async () => {
        for (const fiber of fibers) await fiber.dispose()
        await new Promise(resolve => setTimeout(resolve, 50))
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const content = h.coreConfig.contentDirectory
    await mkdir(content, { recursive: true })
    for (const id of ['main', 'worker', 'thinker', 'tidier']) await h.createSession(id, { cwd: content })
    await h.ctx.core.sessions.setHub('main', { by: BY })
    await h.ctx.core.sessions.assign('worker', 'worker', { by: BY })
    await h.ctx.core.sessions.assign('thinker', 'background', { by: BY })
    await h.ctx.core.sessions.assign('tidier', 'tidy', { by: BY })
    fibers.push(await h.ctx.plugin(ExperienceModule, { archiveFile: join(dir, 'experience.sqlite') }))
    fibers.push(await h.ctx.plugin(MemoryModule, memory))
    fibers.push(await h.ctx.plugin(MindModule, {}))
    fibers.push(await h.ctx.plugin({
        name: 'search-under-test',
        inject: SearchModule.inject,
        apply: ctx => SearchModule.apply(ctx, new SearchModule.Config({ file: join(dir, 'search.sqlite') }), { autoStart: false }),
    }))
    const endpoints = {}
    const call = async (id, name, args, options = {}) => {
        const key = `${id}:${options.probe === true}`
        endpoints[key] ??= await h.ctx.core.toolEndpoint.open(id, options)
        const response = await fetch(endpoints[key].url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoints[key].token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
        const body = JSON.parse(await response.text())
        if (body.error !== undefined) return { error: body.error.message }
        const text = body.result.content[0].text
        return body.result.isError ? { error: text } : JSON.parse(text)
    }
    return { h, call, content }
}

test('使用统计：搜到、打开按调用方分开记；默认只算中枢和项目会话；体检令牌不记；能列从没用过的', async (t) => {
    const { h, call } = await setup(t)
    const lamp = await call('main', 'assistant_memory_write', { title: '风车的维修安排', summary: '每月一次', body: '风车每月检修一次。' })
    const bell = await call('main', 'assistant_memory_write', { title: '钟楼的钥匙', summary: '在门卫那里', body: '钥匙在门卫那里。' })
    await h.ctx.search.syncNow()

    await call('main', 'assistant_search', { query: '风车的维修安排', sources: ['memory'] })
    await call('main', 'assistant_memory_read', { id: lamp.id })
    await call('worker', 'assistant_memory_search', { query: '风车' })
    await call('thinker', 'assistant_search', { query: '风车 钟楼', sources: ['memory'] })
    await call('main', 'assistant_search', { query: '钟楼的钥匙', sources: ['memory'] }, { probe: true })

    const usage = await call('main', 'assistant_usage', { source: 'memory' })
    const of = (report, id) => report.items.find(item => item.ref === id)
    assert.equal(of(usage, lamp.id).shown, 2, '中枢的统一搜索和项目会话的记忆搜索各一次')
    assert.equal(of(usage, lamp.id).opened, 1)
    assert.equal(of(usage, lamp.id).title, '风车的维修安排')
    assert.match(of(usage, lamp.id).lastOpened, /\+\d{2}:\d{2}$/)
    assert.equal(of(usage, bell.id), undefined, '后台思考的搜索、体检的搜索默认不算')
    assert.deepEqual(usage.roles, ['hub', 'worker'])

    const all = await call('main', 'assistant_usage', { source: 'memory', roles: ['all'] })
    assert.equal(of(all, lamp.id).shown, 3)
    assert.equal(of(all, bell.id).shown, 1, '算上后台思考；体检那次照样没记')
    const never = await call('main', 'assistant_usage', { source: 'memory', order: 'never' })
    assert.deepEqual(never.items.map(item => item.ref), [bell.id])
    assert.match((await call('main', 'assistant_usage', { source: 'documents', order: 'never' })).error, /只能配 source "memory" 或 "notes"/)
    assert.match((await call('worker', 'assistant_usage', {})).error, /不能调|没有/, '项目会话看不到统计')
})

test('收藏：中枢按编号或原话标、能列、能取消；检索能只看收藏；后台思考只能看', async (t) => {
    const { h, call } = await setup(t)
    const source = h.ctx.experience.registerSource({ id: 'test-s', label: '会话', category: 'dsh' })
    const at = Date.now() - 3_600_000
    source.append([
        { id: 'e1', thread: 'main', at, tie: 1, role: 'user', kind: '用户', text: '那天在码头看日落，风很大' },
        { id: 'e2', thread: 'main', at: at + 60_000, tie: 2, role: 'user', kind: '用户', text: '码头的旧船明天就拆了' },
    ])
    await h.ctx.search.syncNow()

    const added = await call('main', 'assistant_favorite', { action: 'add', ref: 'e1', why: '第一次一起看日落' })
    assert.match(added.id, /^fav-/)
    assert.match((await call('main', 'assistant_favorite', { action: 'add', ref: 'e1' })).error, /已经收藏过了/)
    assert.match((await call('main', 'assistant_favorite', { action: 'add', ref: 'nope' })).error, /没有 nope/)
    const quote = await call('main', 'assistant_favorite', { action: 'add', quote: '下次去海边要带上那把蓝色的伞' })
    assert.match((await call('thinker', 'assistant_favorite', { action: 'add', quote: 'x' })).error, /不能调|没有/, '后台思考不能标')

    const listed = await call('thinker', 'assistant_favorite_list', {})
    assert.equal(listed.total, 2)
    assert.equal(listed.items[1].excerpt, '那天在码头看日落，风很大')
    assert.equal(listed.items[1].why, '第一次一起看日落')
    assert.match(listed.items[0].at, /\+\d{2}:\d{2}$/)
    assert.equal((await call('main', 'assistant_favorite_list', { query: '蓝色的伞' })).items[0].id, quote.id)

    const history = await call('main', 'assistant_history_search', { query: '码头', favorites: true })
    assert.deepEqual(history.items.map(item => item.ref), ['e1'], '经历检索只看收藏')
    const unified = await call('main', 'assistant_search', { query: '码头', favorites: true })
    assert.deepEqual(unified.groups.map(group => [group.source, group.items.map(item => item.ref)]), [['experience', ['e1']]], '统一搜索只看收藏的经历')

    assert.equal((await call('main', 'assistant_favorite', { action: 'remove', ref: 'e1' })).removed, true)
    assert.equal((await call('main', 'assistant_favorite_list', {})).total, 1)
    assert.equal((await call('main', 'assistant_history_search', { query: '码头', favorites: true })).note, '还没有按编号收藏的经历', '只剩原话收藏')
    assert.deepEqual((await call('main', 'assistant_history_search', { query: '码头', favorites: true })).items, [])
})

test('“我们之间”：中枢和后台思考整份替换，交接整理和项目会话不能；接在心智段后面；超过上限照样写并写明', async (t) => {
    const { h, call } = await setup(t)
    const empty = await call('main', 'assistant_mind_read', { part: 'between_us' })
    assert.equal(empty.text, '', '没有文件按空')
    const written = await call('main', 'assistant_between_us_update', { text: '周末一起去海边看了日落。', baseHash: '', summary: '起步' })
    assert.equal(written.note, undefined)
    assert.match((await call('tidier', 'assistant_between_us_update', { text: 'x', baseHash: '', summary: 'x' })).error, /不能调|没有/)
    assert.match((await call('worker', 'assistant_between_us_update', { text: 'x', baseHash: '', summary: 'x' })).error, /不能调|没有/)
    const current = await call('thinker', 'assistant_mind_read', { part: 'between_us' })
    const long = await call('thinker', 'assistant_between_us_update', { text: '长'.repeat(1200), baseHash: current.hash, summary: '太长了' })
    assert.match(long.note, /超出篇幅上限 1000 字/)
    const preview = await h.ctx.core.segments.preview('main')
    const names = preview.opening.map(entry => entry.name)
    assert.ok(names.indexOf('between-us') === names.indexOf('mind') + 1 || !names.includes('mind'), '接在心智段后面')
    assert.match(preview.opening.find(entry => entry.name === 'between-us').text, /^长{10}/)
})

test('记忆目录：写完以后列不全了，写入结果里提醒有几条不再列出', async (t) => {
    const { call } = await setup(t, { memory: { indexChars: 200 } })
    const first = await call('main', 'assistant_memory_write', { title: '第一条', summary: '短', body: '一' })
    assert.doesNotMatch(first.note ?? '', /记忆目录/, '还列得下')
    let last
    for (let index = 0; index < 4; index += 1) last = await call('main', 'assistant_memory_write', { title: `第 ${index + 2} 条比较长的标题`, summary: '摘要也写得长一些，好让目录很快放不下', body: '正文' })
    assert.match(last.note, /记忆目录到了上限 200 字，只列得下最近更新的 \d+ 条，较早的 \d+ 条不再列出/)
})
