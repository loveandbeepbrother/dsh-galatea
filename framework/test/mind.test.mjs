/**
 * 心智模块：按轮固定版本、谁能写哪一层、候选转交中枢、确认只认用户本人、新人格和候选状态一次提交。
 * 核心、会话、内容库（真的 Git）都是真的，模型是假的提供方。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as MindModule from '../mind/index.js'
import { versionIdOf } from '../mind/versions.js'
import { createUserMessage, makeHarness, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })

async function setup(t, config = {}) {
    const h = await makeHarness(t)
    const content = h.coreConfig.contentDirectory
    await mkdir(content, { recursive: true })
    await writeFile(join(content, 'personality.md'), '我是人格第一版。\n')
    await writeFile(join(content, 'long-term-cognition.md'), '认知第一版。\n')
    const fiber = await h.ctx.plugin(MindModule, config)
    t.after(() => fiber.dispose())
    const agents = {}
    for (const id of ['main', 'work', 'idle']) agents[id] = await h.createSession(id)
    await h.ctx.core.sessions.setHub('main', { by: BY })
    await h.ctx.core.sessions.assign('work', 'worker', { by: BY })
    await h.ctx.core.sessions.assign('idle', 'background', { by: BY })
    const turn = async (id, text) => {
        const before = (await h.turnEnds(id)).length
        agents[id].followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await waitFor(async () => (await h.turnEnds(id)).length === before + 1, `${id} 这一轮`)
    }
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
    // 原生把段放进 runtime-context 消息；历史里还留着前几轮的，以最后一份为准（上游写明新的一份取代旧的）。
    const lastRequest = () => JSON.stringify(h.adapter.requests.at(-1).messages.findLast(message => message.source?.kind === 'runtime-context'))
    return { h, content, agents, turn, call, lastRequest }
}

test('按轮固定版本：写入从下一轮生效；记下的那一轮的版本查得到', async (t) => {
    const { h, content, turn, call, lastRequest } = await setup(t)
    await turn('main', '你好')
    assert.ok(lastRequest().includes('我是人格第一版。') && lastRequest().includes('认知第一版。'))
    const read = await call('main', 'assistant_mind_read', { part: 'personality' })
    const written = await call('main', 'assistant_persona_update', { text: '我是人格第二版。', baseHash: read.hash, kind: 'daily', summary: '换一版' })
    assert.equal(written.published, true)
    assert.equal(await readFile(join(content, 'personality.md'), 'utf8'), '我是人格第二版。\n')
    await turn('main', '再来')
    assert.ok(lastRequest().includes('我是人格第二版。') && !lastRequest().includes('我是人格第一版。'))
    const firstTurn = (await h.events('main')).find(event => event.type === 'turn/start')
    const pinned = await h.ctx.mind.snapshot('main', { turn: firstTurn.seq })
    assert.match(pinned.persona, /第一版/, '第一轮绑定的还是第一版')
    const stale = await call('main', 'assistant_persona_update', { text: '第三版', baseHash: read.hash, kind: 'daily', summary: '用旧哈希' })
    assert.match(stale.error, /已经变了[\s\S]*我是人格第二版/, '基于旧版本改不了，并带回当前内容')
})

test('谁能写：工作会话看不到写人格、认知的工具；后台思考只能提候选，由心智模块转交中枢', async (t) => {
    const { h, call } = await setup(t)
    const workTools = await call('work', null)
    assert.ok(workTools.includes('assistant_mind_read'))
    for (const name of ['assistant_persona_update', 'assistant_cognition_update', 'assistant_persona_decide']) assert.ok(!workTools.includes(name), `工作会话不该有 ${name}`)
    const idleTools = await call('idle', null)
    assert.ok(idleTools.includes('assistant_persona_update') && idleTools.includes('assistant_cognition_update') && !idleTools.includes('assistant_persona_decide'))

    const read = await call('idle', 'assistant_mind_read', { part: 'personality' })
    assert.match((await call('idle', 'assistant_persona_update', { text: '新的', baseHash: read.hash, kind: 'daily', summary: '试试' })).error, /只能用 kind "stable" 提候选/)
    const proposed = await call('idle', 'assistant_persona_update', { text: '更沉稳的人格。', baseHash: read.hash, kind: 'stable', summary: '性格更沉稳' })
    assert.equal(proposed.published, false)
    // 排进中枢的下一轮，不叫醒它：后台思考的提议不打断中枢手头的事。
    const inbox = async () => (await h.events('main')).flatMap(event => (event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : []))
    await waitFor(async () => (await inbox()).some(message => message.source?.kind === MindModule.CANDIDATE_SOURCE), '转交到中枢')
    const handed = (await inbox()).find(message => message.source?.kind === MindModule.CANDIDATE_SOURCE)
    assert.match(JSON.stringify(handed.content), new RegExp(`会话 idle提出了一个人格的稳定变化候选 ${proposed.candidate}`))
    assert.deepEqual(handed.source.speaker, { kind: 'program', plugin: MindModule.name })
    const cognition = await call('idle', 'assistant_mind_read', { part: 'cognition' })
    assert.ok((await call('idle', 'assistant_cognition_update', { text: '后台整理过的认知。', baseHash: cognition.hash, summary: '整理' })).commit !== undefined)
})

test('确认人格只认用户本人：转交来的口令不算；本人回复以后新人格和候选状态一次提交；人格先变了候选作废', async (t) => {
    const { h, content, turn, call } = await setup(t)
    const read = await call('main', 'assistant_mind_read', { part: 'personality' })
    const proposed = await call('main', 'assistant_persona_update', { text: '确认后的人格。', baseHash: read.hash, kind: 'stable', summary: '大改' })
    const code = proposed.candidate
    assert.equal(proposed.confirmPhrase, `确认人格 ${code}`)
    assert.deepEqual((await call('main', 'assistant_mind_read', { part: 'candidates' })).pending.map(item => item.candidate), [code])

    await h.ctx.core.deliver('main', { key: 'relay', text: `确认人格 ${code}`, source: { kind: 'assistant-session' }, speaker: { kind: 'session', sessionId: 'work' } })
    await waitFor(async () => (await h.turnEnds('main')).length === 1, '转交的那一轮')
    assert.match((await call('main', 'assistant_persona_decide', { candidate: code, decision: 'confirm' })).error, /不是用户本人发的/)

    await turn('main', `确认人格 ${code.toLowerCase()}`)
    const before = execFileSync('git', ['-C', content, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
    const decided = await call('main', 'assistant_persona_decide', { candidate: code, decision: 'confirm' })
    assert.equal(decided.state, 'confirmed')
    assert.equal(await readFile(join(content, 'personality.md'), 'utf8'), '确认后的人格。\n')
    assert.match(await readFile(join(content, 'candidates', `${code}.md`), 'utf8'), /^state: confirmed$/m)
    const after = execFileSync('git', ['-C', content, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
    assert.equal(Number(after) - Number(before), 1, '新人格和候选状态是一次提交')

    const again = await call('main', 'assistant_mind_read', { part: 'personality' })
    const second = await call('main', 'assistant_persona_update', { text: '再改。', baseHash: again.hash, kind: 'stable', summary: '再改' })
    await call('main', 'assistant_persona_update', { text: '日常小改。', baseHash: again.hash, kind: 'daily', summary: '小改' })
    await turn('main', `确认人格 ${second.candidate}`)
    assert.match((await call('main', 'assistant_persona_decide', { candidate: second.candidate, decision: 'confirm' })).error, /已被修改，候选 .* 作废/)
    assert.match(await readFile(join(content, 'candidates', `${second.candidate}.md`), 'utf8'), /^state: stale$/m)
})

test('别的执行方（Claude Code）开对话时心智段在开头；别处改了认知，下一轮只收到一句"已由别处更新"；自己改的不提', async (t) => {
    const { h, call } = await setup(t)
    const opening = await h.ctx.core.segments.open('cc-conv', 'main')
    const mind = opening.find(entry => entry.name === MindModule.SEGMENT)
    assert.ok(mind.text.includes('我是人格第一版。') && mind.text.includes('认知第一版。'))
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'main'), [], '没变不提')

    const cognition = await call('idle', 'assistant_mind_read', { part: 'cognition' })
    await call('idle', 'assistant_cognition_update', { text: '后台改过的认知。', baseHash: cognition.hash, summary: '后台整理' })
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'main'), ['（DSH 提示，不是用户发言）人格、长期认知或常驻记忆已由别处更新；需要时用 `assistant_mind_read` 读最新版本。'])

    const mine = await call('main', 'assistant_mind_read', { part: 'cognition' })
    await call('main', 'assistant_cognition_update', { text: '中枢自己改的认知。', baseHash: mine.hash, summary: '自己整理' })
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'main'), [], '经端点、声明了 writesSegments 的工具，自己改的不提')
})

test('人格文件不存在按空处理，报一次写明是哪个文件；文件有了以后再没了再报', async (t) => {
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const content = h.coreConfig.contentDirectory
    await mkdir(content, { recursive: true })
    await writeFile(join(content, 'long-term-cognition.md'), '认知。\n')
    const fiber = await h.ctx.plugin(MindModule, { personaFile: '配错的/人格.md' })
    t.after(() => fiber.dispose())
    const missing = () => reports.filter(entry => entry.kind === 'mind/file-missing')
    assert.deepEqual(await h.ctx.mind.read('persona'), { text: '', hash: null })
    await h.ctx.mind.read('persona')
    assert.equal(missing().length, 1, '只报一次')
    assert.match(missing()[0].text, /人格文件 配错的\/人格.md 不存在，按空处理/)
    await mkdir(join(content, '配错的'), { recursive: true })
    await writeFile(join(content, '配错的', '人格.md'), '有了。\n')
    assert.equal((await h.ctx.mind.read('persona')).text, '有了。\n')
    const { rm } = await import('node:fs/promises')
    await rm(join(content, '配错的', '人格.md'))
    await h.ctx.mind.read('persona')
    assert.equal(missing().length, 2, '有了以后再没了再报')
})

test('常驻记忆是可选的一层：没有文件按空、不报异常；中枢写了从下一轮生效，放在长期认知后面，这一轮还是原来的版本', async (t) => {
    const { h, content, turn, call, lastRequest } = await setup(t)
    const reports = []
    h.ctx.core.onReport(item => reports.push(item))
    await turn('main', '你好')
    assert.deepEqual(reports.filter(item => item.kind === 'mind/file-missing'), [])
    const empty = await call('main', 'assistant_mind_read', { part: 'standing' })
    assert.deepEqual(empty, { file: 'standing-memory.md', hash: null, text: '' })

    const written = await call('main', 'assistant_standing_update', { text: '事实第一版。', baseHash: '', summary: '开始记' })
    assert.ok(written.commit !== undefined)
    assert.equal(await readFile(join(content, 'standing-memory.md'), 'utf8'), '事实第一版。\n')
    const firstTurn = (await h.events('main')).find(event => event.type === 'turn/start')
    assert.equal((await h.ctx.mind.snapshot('main', { turn: firstTurn.seq })).standing, '', '已经绑定的那一轮不变')

    await turn('main', '再来')
    const request = lastRequest()
    assert.ok(request.includes('事实第一版。'))
    assert.ok(request.indexOf('认知第一版。') < request.indexOf('事实第一版。'), '在长期认知之后')
    const read = await call('main', 'assistant_mind_read', { part: 'standing' })
    assert.equal(read.text, '事实第一版。\n')
    const stale = await call('main', 'assistant_standing_update', { text: '第二版。', baseHash: '', summary: '用旧哈希' })
    assert.match(stale.error, /常驻记忆在你读取以后已经变了[\s\S]*事实第一版/)
})

test('谁能写常驻记忆：中枢和后台思考写，不走候选；工作会话只读；外部调用方只读', async (t) => {
    const { call } = await setup(t)
    const workTools = await call('work', null)
    assert.ok(workTools.includes('assistant_mind_read') && !workTools.includes('assistant_standing_update'))
    assert.ok((await call('idle', null)).includes('assistant_standing_update'))
    const read = await call('idle', 'assistant_mind_read', { part: 'standing' })
    const written = await call('idle', 'assistant_standing_update', { text: '后台记的事实。', baseHash: read.hash ?? '', summary: '补一条' })
    assert.equal(written.candidate, undefined, '改了就是事实变了，不走候选')
    assert.equal((await call('work', 'assistant_mind_read', { part: 'standing' })).text, '后台记的事实。\n')
    assert.equal(MindModule.permissions({ kind: 'external', name: 'cli', readOnly: false }).standing, false)
    assert.equal(MindModule.permissions({ kind: 'external', name: 'cli', readOnly: false }).read, true)
    assert.equal(MindModule.permissions({ kind: 'session', role: 'worker' }).standing, false)
    assert.equal(MindModule.permissions({ kind: 'session', role: 'hub' }).standing, true)
})

test('常驻记忆的篇幅：默认 3000 字，超了照样写，返回值里写明；上限可配，0 不限', async (t) => {
    const { content, call } = await setup(t)
    const long = '事'.repeat(3001)
    const over = await call('main', 'assistant_standing_update', { text: long, baseHash: '', summary: '很长' })
    assert.match(over.note, /超出篇幅上限 3000 字（现在 3001 字），已照样写入/)
    assert.equal((await readFile(join(content, 'standing-memory.md'), 'utf8')).trim(), long)
    const read = await call('main', 'assistant_mind_read', { part: 'standing' })
    assert.equal((await call('main', 'assistant_standing_update', { text: '事'.repeat(3000), baseHash: read.hash, summary: '压回去' })).note, undefined)
})

test('常驻记忆的文件名和上限是配置', async (t) => {
    const { content, call } = await setup(t, { standingFile: 'facts.md', standingMaxChars: 2 })
    const over = await call('main', 'assistant_standing_update', { text: '三个字', baseHash: '', summary: '试试' })
    assert.match(over.note, /超出篇幅上限 2 字/)
    assert.equal(await readFile(join(content, 'facts.md'), 'utf8'), '三个字\n')
    assert.equal((await call('main', 'assistant_mind_read', { part: 'standing' })).file, 'facts.md')
})

test('别处改了常驻记忆：别的执行方下一轮只收到一句；开新对话（交接、切模型）带上最新的；自己改的不提', async (t) => {
    const { h, call } = await setup(t)
    await h.ctx.core.segments.open('cc-conv', 'main')
    await call('idle', 'assistant_standing_update', { text: '后台记的事实。', baseHash: '', summary: '补一条' })
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'main'), ['（DSH 提示，不是用户发言）人格、长期认知或常驻记忆已由别处更新；需要时用 `assistant_mind_read` 读最新版本。'])
    const read = await call('main', 'assistant_mind_read', { part: 'standing' })
    await call('main', 'assistant_standing_update', { text: '中枢改的事实。', baseHash: read.hash, summary: '自己改' })
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv', 'main'), [], '自己改的不提')
    const opening = await h.ctx.core.segments.open('cc-conv-2', 'main')
    assert.ok(opening.find(entry => entry.name === MindModule.SEGMENT).text.includes('中枢改的事实。'))
})

test('还没用常驻记忆的版本，编号和以前一样；用了以后编号不同', () => {
    const legacy = createHash('sha256').update('p\u0000c').digest('hex').slice(0, 32)
    assert.equal(versionIdOf('p', 'c'), legacy, '存着的旧版本照常核对得过')
    assert.notEqual(versionIdOf('p', 'c', 's'), legacy)
})

test('存储里没有常驻记忆字段的旧版本照常读：绑定它的那一轮常驻记忆是空的', async (t) => {
    const { h, content, turn, call } = await setup(t)
    await writeFile(join(content, 'personality.md'), '旧版本的人格。\n')
    await turn('main', '第一轮')
    const firstTurn = (await h.events('main')).find(event => event.type === 'turn/start')
    const old = await h.ctx.mind.snapshot('main', { turn: firstTurn.seq })
    assert.equal(old.standing, '')
    await call('main', 'assistant_standing_update', { text: '有了事实。', baseHash: '', summary: '开始记' })
    await turn('main', '第二轮')
    const second = (await h.events('main')).filter(event => event.type === 'turn/start').at(-1)
    const now = await h.ctx.mind.snapshot('main', { turn: second.seq })
    assert.equal(now.standing, '有了事实。\n')
    assert.notEqual(now.versionId, old.versionId)
    assert.equal(now.persona, old.persona, '另外两份没变')
})
