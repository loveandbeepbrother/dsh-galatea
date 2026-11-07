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
import { makeHarness } from './harness.mjs'

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
    await writeFile(join(content, 'notes.md'), SAMPLE)
    const fiber = await h.ctx.plugin(MemoryModule, {})
    t.after(() => fiber.dispose())
    await h.createSession('main')
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
    assert.doesNotMatch(await readFile(join(content, 'notes.md'), 'utf8'), new RegExp(A))
    const rejected = await call('assistant_note_write', { action: 'add', body: '# 一级标题' })
    assert.match(rejected.error, /解析不过/)
    assert.equal(commits(), before + 1, '被拒的写入不动文件、不提交')
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
    assert.match(long.note, /^便签已 \d+ 字，超出上限 120 字；已照样写入/)
    const stored = await readFile(join(h.coreConfig.contentDirectory, 'notes.md'), 'utf8')
    assert.ok(stored.includes('很长的一条'), '照样写入')
    const [line] = await contributed.get('便签')()
    assert.match(line, /超出上限 120 字/)
})
