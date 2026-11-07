/**
 * 项目归属 `core.sessions.projectOf`：上游项目登记是真的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { SessionId, makeHarness } from './harness.mjs'

test('projectOf：登记过的按登记（上游只许登记工作目录正好是项目目录的会话），没登记的看工作目录落在哪个项目里、取最具体的；不在项目里、落在用户内容目录里的项目都算 null', async (t) => {
    const h = await makeHarness(t, { controller: true })
    const novel = join(h.workDirectory, 'novel')
    const chapter = join(novel, 'chapter-3')
    const content = h.coreConfig.contentDirectory
    for (const path of [chapter, content, join(h.root, 'elsewhere')]) await mkdir(path, { recursive: true })
    const book = await h.ctx.workspaceRegistry.create(novel, '小说')
    await h.ctx.workspaceRegistry.create(chapter, '第三章')
    await h.ctx.workspaceRegistry.create(content, '内容目录')
    await h.createSession('in-book', { cwd: novel })
    await h.createSession('in-chapter', { cwd: chapter })
    await h.createSession('hub', { cwd: content })
    await h.createSession('loose', { cwd: join(h.root, 'elsewhere') })
    await h.createSession('attached', { cwd: novel })
    await book.attachSession(SessionId('attached'))
    await new Promise(resolve => setTimeout(resolve, 50))
    const projectOf = id => h.ctx.core.sessions.projectOf(id)
    assert.deepEqual(projectOf('in-book'), { id: String(book.id), title: '小说', path: book.path })
    assert.equal(projectOf('in-chapter')?.title, '第三章', '嵌套的取最具体的')
    assert.equal(projectOf('hub'), null, '落在用户内容目录里的不算项目')
    assert.equal(projectOf('loose'), null)
    assert.equal(projectOf('attached')?.title, '小说', '登记过的按登记')
})
