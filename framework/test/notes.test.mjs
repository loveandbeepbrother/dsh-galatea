/**
 * 便签：读写同一套解析；正文带一级、二级标题或围栏没闭合的写入被拒、文件不动；更新、删除要核对版本；每次写入一个提交。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as MemoryModule from '../memory/index.js'
import { editNotes, parseNotes } from '../memory/notes.js'
import { makeHarness, waitFor } from './harness.mjs'

const A = 'note-0AAAAAAAAAAAAAAAAAAAAAAAAA'
const B = 'note-0BBBBBBBBBBBBBBBBBBBBBBBBB'
const SAMPLE = `# 便签\n\n## ${A}\n\n第一条\n\n\`\`\`\n## 围栏里的标题算正文\n\`\`\`\n\n## ${B}\n\n第二条\n### 更深的标题也算正文\n`

test('解析：围栏里的标题、更深的标题算正文；不属于任何一条的二级标题、重复编号是格式错误；读的时候没闭合的围栏延续到末尾', () => {
    const { notes } = parseNotes(SAMPLE)
    assert.deepEqual(notes.map(note => note.id), [A, B])
    assert.match(notes[0].text, /## 围栏里的标题算正文/)
    assert.match(notes[1].text, /### 更深的标题也算正文/)
    assert.throws(() => parseNotes(`# 便签\n\n## 随便写的\n`), /不属于任何便签的二级标题/)
    assert.throws(() => parseNotes(`# 便签\n\n## ${A}\n\n## ${A}\n`), /重复/)
    assert.equal(parseNotes(`# 便签\n\n## ${A}\n\n\`\`\`\n没闭合\n`).notes.length, 1)
    assert.deepEqual(parseNotes('').notes, [])
})

test('编辑：增、改、删只动那一条；正文带二级标题、围栏没闭合、带 ## note- 行的都拒掉', () => {
    const C = 'note-0CCCCCCCCCCCCCCCCCCCCCCCCC'
    const added = editNotes(SAMPLE, { action: 'add', noteId: C, body: '第三条' })
    assert.deepEqual(parseNotes(added).notes.map(note => note.id), [A, B, C])
    const updated = editNotes(added, { action: 'update', noteId: A, body: '改过的第一条' })
    assert.equal(parseNotes(updated).notes[0].text, '改过的第一条')
    assert.equal(parseNotes(updated).notes[1].text, parseNotes(SAMPLE).notes[1].text, '别的条目不动')
    const removed = editNotes(updated, { action: 'remove', noteId: B })
    assert.deepEqual(parseNotes(removed).notes.map(note => note.id), [A, C])
    assert.throws(() => editNotes(SAMPLE, { action: 'add', noteId: C, body: '## 二级标题' }), /解析不过/)
    assert.throws(() => editNotes(SAMPLE, { action: 'add', noteId: C, body: '```\n没闭合' }), /代码围栏要闭合/)
    assert.throws(() => editNotes(SAMPLE, { action: 'update', noteId: A, body: `x\n\n## ${C}\ny` }), /条数不对/)
    assert.throws(() => editNotes(SAMPLE, { action: 'update', noteId: C, body: 'x' }), /没有 note-0C/)
    assert.equal(parseNotes(editNotes('', { action: 'add', noteId: C, body: '第一条' })).notes.length, 1, '空文件从头建')
})

test('工具：搜索给出版本和行号；更新、删除要带版本；每次写入一个提交；被拒的写入不动文件', async (t) => {
    const h = await makeHarness(t)
    const content = h.coreConfig.contentDirectory
    await mkdir(content, { recursive: true })
    await mkdir(join(content, 'notes'), { recursive: true })
    await writeFile(join(content, 'notes', 'hub.md'), SAMPLE)
    const fiber = await h.ctx.plugin(MemoryModule, {})
    t.after(() => fiber.dispose())
    await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: { kind: 'program', plugin: 'test' } })
    const endpoint = await h.ctx.core.toolEndpoint.open('main')
    const call = async (name, args) => {
        const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
        const body = JSON.parse(await response.text())
        const text = body.result.content[0].text
        return body.result.isError ? { error: text } : JSON.parse(text)
    }
    const found = await call('assistant_notes_search', { query: '第二条' })
    assert.equal(found.items[0].noteId, B)
    assert.equal(found.items[0].hitLine, 13)
    const read = await call('assistant_notes_read', { noteId: B, fileHash: found.fileHash })
    assert.match(read.text, /^第二条/)

    const added = await call('assistant_note_write', { action: 'add', body: '新的一条' })
    assert.match(added.noteId, /^note-/)
    assert.match((await call('assistant_note_write', { action: 'update', noteId: A, body: 'x', fileHash: found.fileHash })).error, /已经变了/, '旧版本改不了')
    const commits = () => Number(execFileSync('git', ['-C', content, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim())
    const before = commits()
    await call('assistant_note_write', { action: 'remove', noteId: A, fileHash: added.fileHash })
    assert.equal(commits(), before + 1)
    assert.doesNotMatch(await readFile(join(content, 'notes', 'hub.md'), 'utf8'), new RegExp(A))
    const rejected = await call('assistant_note_write', { action: 'add', body: '# 一级标题' })
    assert.match(rejected.error, /解析不过/)
    assert.equal(commits(), before + 1, '被拒的写入不动文件、不提交')
})

test('便签的时间：创建从编号里解出来；最后修改取它那几行的最后一次提交；有没提交的改动时取文件修改时间并写明', async (t) => {
    const h = await makeHarness(t, { coreConfig: { timezone: 'Asia/Shanghai' } })
    const content = h.coreConfig.contentDirectory
    await mkdir(join(content, 'notes'), { recursive: true })
    const fiber = await h.ctx.plugin(MemoryModule, {})
    t.after(() => fiber.dispose())
    await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: { kind: 'program', plugin: 'test' } })
    const endpoint = await h.ctx.core.toolEndpoint.open('main')
    const call = async (name, args) => {
        const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
        return JSON.parse(JSON.parse(await response.text()).result.content[0].text)
    }
    const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\+08:00$/
    const first = await call('assistant_note_write', { action: 'add', body: '风车第一条' })
    await call('assistant_note_write', { action: 'add', body: '风车第二条' })
    const found = await call('assistant_notes_search', { query: '风车' })
    const item = found.items.find(entry => entry.noteId === first.noteId)
    assert.match(item.created, CLOCK)
    assert.match(item.updated, CLOCK, '经工具写的已经提交')
    assert.equal(item.updatedAgo, '刚才')
    assert.equal(item.updatedNote, undefined)
    const read = await call('assistant_notes_read', { noteId: first.noteId, fileHash: found.fileHash })
    assert.equal(read.updated, item.updated)

    // 工具以外改了第一条（还没到定时提交）：这一条写明是文件修改时间，第二条照旧取提交时间。
    const path = join(content, 'notes', 'hub.md')
    await writeFile(path, (await readFile(path, 'utf8')).replace('风车第一条', '风车第一条（手改）'))
    const again = await call('assistant_notes_search', { query: '风车' })
    const edited = again.items.find(entry => entry.noteId === first.noteId)
    assert.match(edited.updated, CLOCK)
    assert.match(edited.updatedNote, /还没提交进心智仓/)
    assert.equal(again.items.find(entry => entry.noteId !== first.noteId).updatedNote, undefined)
})

test('篇幅上限：超了照样写入，返回值写明字数和上限；装了后台思考时在它的事实段里交一行，没超时不交', async (t) => {
    const h = await makeHarness(t)
    await mkdir(h.coreConfig.contentDirectory, { recursive: true })
    const contributed = new Map()
    h.ctx.provide('reflection', { contribute: (name, lines) => { contributed.set(name, lines); return () => contributed.delete(name) } })
    const fiber = await h.ctx.plugin(MemoryModule, { notesMaxChars: 120 })
    t.after(() => fiber.dispose())
    const by = { kind: 'program', plugin: 'test' }
    const short = await h.ctx.notes.add('短的一条', by)
    assert.equal(short.note, undefined)
    assert.deepEqual(await contributed.get('便签')(), [], '没超时不交')
    const long = await h.ctx.notes.add('很长的一条'.repeat(30), by)
    assert.match(long.note, /^便签 hub 已 \d+ 字，超出上限 120 字；已照样写入/)
    const stored = await readFile(join(h.coreConfig.contentDirectory, 'notes', 'hub.md'), 'utf8')
    assert.ok(stored.includes('很长的一条'), '照样写入')
    const [line] = await contributed.get('便签')()
    assert.match(line, /超出上限 120 字/)
})

test('以前根下的 notes.md：启动时挪成中枢那一本，一次提交；两边都有时不动', async (t) => {
    const h = await makeHarness(t)
    const content = h.coreConfig.contentDirectory
    await mkdir(content, { recursive: true })
    await writeFile(join(content, 'notes.md'), SAMPLE)
    const fiber = await h.ctx.plugin(MemoryModule, {})
    t.after(() => fiber.dispose())
    await waitForNotes(h, A)
    assert.equal(await readFile(join(content, 'notes', 'hub.md'), 'utf8'), SAMPLE)
    await assert.rejects(readFile(join(content, 'notes.md'), 'utf8'), { code: 'ENOENT' })
    assert.match(execFileSync('git', ['-C', content, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /便签挪到 notes\/hub\.md/)
})

test('两边都有时不动：中枢那本已经有了，根下的 notes.md 留着', async (t) => {
    const h = await makeHarness(t)
    const content = h.coreConfig.contentDirectory
    await mkdir(join(content, 'notes'), { recursive: true })
    await writeFile(join(content, 'notes.md'), '# 便签\n')
    await writeFile(join(content, 'notes', 'hub.md'), SAMPLE)
    const fiber = await h.ctx.plugin(MemoryModule, {})
    t.after(() => fiber.dispose())
    await waitForNotes(h, A)
    assert.equal(await readFile(join(content, 'notes.md'), 'utf8'), '# 便签\n')
    assert.equal(await readFile(join(content, 'notes', 'hub.md'), 'utf8'), SAMPLE)
})

test('篇幅提醒按本算：每本超了各交一行，写明是哪一本', async (t) => {
    const h = await makeHarness(t)
    await mkdir(join(h.coreConfig.contentDirectory, 'notes'), { recursive: true })
    await writeFile(join(h.coreConfig.contentDirectory, 'notes', 'project-a.md'), `# 便签\n\n## ${A}\n\n${'长'.repeat(200)}\n`)
    await writeFile(join(h.coreConfig.contentDirectory, 'notes', 'project-b.md'), `# 便签\n\n## ${B}\n\n短\n`)
    const contributed = new Map()
    h.ctx.provide('reflection', { contribute: (name, lines) => { contributed.set(name, lines); return () => contributed.delete(name) } })
    const fiber = await h.ctx.plugin(MemoryModule, { notesMaxChars: 120 })
    t.after(() => fiber.dispose())
    await waitForNotes(h, A, 'project-a')
    const lines = await contributed.get('便签')()
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^便签 project-a 已/)
})

/** 等插件起来（`notes` 服务出现）再看。 */
async function waitForNotes(h, id, book = 'hub') {
    await waitFor(async () => h.ctx.get('notes') !== undefined, '便签服务')
    const found = await h.ctx.notes.search(id, { book }, { kind: 'program', plugin: 'test' })
    assert.equal(found.items.length > 0, true)
}
