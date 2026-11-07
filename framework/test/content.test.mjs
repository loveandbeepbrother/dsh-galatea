/**
 * 核心：内容库。真的在临时目录里建 Git 仓库、提交；"没有 Git"用一个不存在的命令模拟。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeHarness } from './harness.mjs'
import { createContent, hashOf } from '../core/content.js'
import { STARTER_FILES } from '../starter.js'

const BY = Object.freeze({ kind: 'session', sessionId: 'main', role: 'hub' })
const gitLog = (root, ...args) => execFileSync('git', ['-C', root, 'log', '--format=%an|%s|%b', ...args], { encoding: 'utf8' })

test('读、列、一次写几个文件提交成一次；提交说明带调用方；text: null 是删除', async (t) => {
    const h = await makeHarness(t)
    const { content } = h.ctx.core
    assert.equal(await content.read('personality.md'), null)
    const first = await content.write([
        { path: 'personality.md', text: '人格 v1', baseHash: null },
        { path: 'candidates/1.md', text: '候选：已确认', baseHash: null },
    ], { message: '确认人格', by: BY })
    assert.ok(first.commit, '提交了')
    assert.equal(first.hashes['personality.md'], hashOf(Buffer.from('人格 v1')))
    const root = content.root
    assert.match(gitLog(root, '-1'), /^助手\|确认人格\|调用方：会话 main（hub）/, '一次提交，作者是助手，说明里带调用方')
    const changed = execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim().split(/\r?\n/).sort()
    assert.deepEqual(changed, ['candidates/1.md', 'personality.md'])

    assert.deepEqual(await content.read('personality.md'), { text: '人格 v1', hash: first.hashes['personality.md'] })
    assert.deepEqual((await content.list('candidates')).map(entry => entry.path), ['candidates/1.md'])
    await content.write([{ path: 'candidates/1.md', text: null, baseHash: first.hashes['candidates/1.md'] }], { message: '删候选', by: { kind: 'external', name: 'claude-dev' } })
    assert.equal(existsSync(join(root, 'candidates', '1.md')), false)
    assert.match(gitLog(root, '-1'), /调用方：外部调用方 claude-dev/)
})

test('新建的内容库在启动时写进起步模板（人格、长期认知、后台思考）；已经是仓库的内容库缺文件也不补', async (t) => {
    const h = await makeHarness(t, { coreConfig: { starter: undefined } })
    const root = h.ctx.core.content.root
    await h.ctx.core.content.prepare()
    for (const [path, text] of Object.entries(STARTER_FILES)) assert.equal(await readFile(join(root, path), 'utf8'), text, path)
    assert.match(gitLog(root, '-1'), /初始化内容库（框架自带的起步模板：/, '和建仓库是同一次提交')

    const existing = await mkdtemp(join(tmpdir(), 'galatea-content-'))
    t.after(() => rm(existing, { recursive: true, force: true }))
    execFileSync('git', ['-C', existing, 'init', '-q'])
    await createContent({ root: existing, report: () => {}, starter: STARTER_FILES }).prepare()
    assert.equal(existsSync(join(existing, 'personality.md')), false, '已有的内容库不悄悄补文件')
})

test('baseHash 对不上就拒绝、什么都不改；同一版本的两次写入只有先到的过；跳出内容库的路径不收', async (t) => {
    const h = await makeHarness(t)
    const { content } = h.ctx.core
    const { hashes } = await content.write([{ path: 'notes.md', text: '一', baseHash: null }], { message: '一', by: BY })
    const base = hashes['notes.md']
    const results = await Promise.allSettled([
        content.write([{ path: 'notes.md', text: '二（甲）', baseHash: base }], { message: '甲', by: BY }),
        content.write([{ path: 'notes.md', text: '二（乙）', baseHash: base }], { message: '乙', by: BY }),
    ])
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[1].status, 'rejected')
    assert.equal(results[1].reason.code, 'CONTENT_CONFLICT')
    assert.equal((await content.read('notes.md')).text, '二（甲）', '后到的没覆盖先到的')
    await assert.rejects(content.write([{ path: '../outside.md', text: 'x', baseHash: null }], { message: 'x', by: BY }), /跳出了内容库/)
    await assert.rejects(content.write([{ path: '.git/config', text: 'x', baseHash: null }], { message: 'x', by: BY }), /跳出了内容库/)
})

test('用户手改过的文件，写之前先以用户身份提交一次', async (t) => {
    const h = await makeHarness(t)
    const { content } = h.ctx.core
    const { hashes } = await content.write([{ path: 'memories/a.md', text: '原来的', baseHash: null }], { message: '写记忆', by: BY })
    await writeFile(join(content.root, 'memories', 'a.md'), '用户改过的')
    const userHash = hashOf(Buffer.from('用户改过的'))
    assert.notEqual(userHash, hashes['memories/a.md'])
    await content.write([{ path: 'memories/a.md', text: '助手再改', baseHash: userHash }], { message: '再改', by: BY })
    const log = gitLog(content.root, '-3').split(/\r?\n/).filter(line => line.includes('|'))
    assert.match(log[0], /^助手\|再改/)
    assert.ok(log.some(line => /^用户\|用户编辑：memories\/a\.md/.test(line)), '用户的改动单独提交')
})

test('提交失败就用原始字节退回、退暂存区；没有提交', async (t) => {
    const h = await makeHarness(t)
    const { content } = h.ctx.core
    const { hashes } = await content.write([{ path: 'personality.md', text: '人格 v1\r\n带 CRLF 的原字节', baseHash: null }], { message: '一', by: BY })
    const head = () => execFileSync('git', ['-C', content.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const before = head()
    await writeFile(join(content.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook-rejects >&2\nexit 1\n')
    await assert.rejects(content.write([{ path: 'personality.md', text: '人格 v2', baseHash: hashes['personality.md'] }], { message: '二', by: BY }), /提交失败，文件已退回/)
    assert.equal(hashOf(await readFile(join(content.root, 'personality.md'))), hashes['personality.md'], '原始字节退回，baseHash 还对得上')
    assert.equal(head(), before)
    assert.equal(execFileSync('git', ['-C', content.root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim(), '', '暂存区退干净了')
})

test('遇到没人拿着的 index.lock：删掉、报一条，再试一次', async (t) => {
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const { content } = h.ctx.core
    await content.write([{ path: 'a.md', text: '一', baseHash: null }], { message: '一', by: BY })
    await writeFile(join(content.root, '.git', 'index.lock'), '')
    const second = await content.write([{ path: 'b.md', text: '二', baseHash: null }], { message: '二', by: BY })
    assert.ok(second.commit)
    assert.ok(reports.some(entry => entry.kind === 'core/content-stale-lock'))
})

test('没有 Git：照常写入，第一次报"内容库没有留痕"', async (t) => {
    const h = await makeHarness(t, { coreDeps: { git: 'git-that-does-not-exist' } })
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const { content } = h.ctx.core
    const written = await content.write([{ path: 'a.md', text: '一', baseHash: null }], { message: '一', by: BY })
    assert.equal(written.commit, undefined)
    assert.equal((await content.read('a.md')).text, '一')
    await content.write([{ path: 'a.md', text: '二', baseHash: written.hashes['a.md'] }], { message: '二', by: BY })
    const untracked = reports.filter(entry => entry.kind === 'core/content-untracked')
    assert.equal(untracked.length, 1)
    assert.match(untracked[0].text, /找不到 Git/)
})

test('没有配置内容目录：内容库的调用都报错，启动时报一条', async (t) => {
    const h = await makeHarness(t, { coreConfig: { contentDirectory: '' } })
    await assert.rejects(h.ctx.core.content.read('a.md'), /没有配置内容目录/)
    assert.ok(h.warnings.some(line => line.includes('core/content-unavailable')))
})

test('中文名、带空格的文件：用户手改以后再写，照样先以用户身份提交', async (t) => {
    const h = await makeHarness(t)
    const { content } = h.ctx.core
    const path = '记忆/我的 便签.md'
    const { hashes } = await content.write([{ path, text: '原来的', baseHash: null }], { message: '写便签', by: BY })
    await writeFile(join(content.root, '记忆', '我的 便签.md'), '用户改过的')
    const written = await content.write([{ path, text: '助手再改', baseHash: hashOf(Buffer.from('用户改过的')) }], { message: '再改', by: BY })
    assert.ok(written.commit)
    assert.notEqual(written.hashes[path], hashes[path])
    const log = gitLog(content.root, '-3').split(/\r?\n/).filter(line => line.includes('|'))
    assert.match(log[0], /^助手\|再改/)
    assert.ok(log.some(line => line.startsWith('用户|用户编辑：记忆/我的 便签.md')), '用户的改动单独提交')
})
