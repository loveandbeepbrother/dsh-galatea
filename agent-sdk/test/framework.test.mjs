/**
 * 执行方接到框架核心上：装上框架真实的核心和上游真实的设施，看执行方登记了什么、核心怎么认它。
 * 不跑真正的一轮（适配器自己的测试管那些），Agent SDK 只给一个占位。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import * as ExecutorModule from '../index.js'
import { QUOTA_SOURCE, SURFACE_SOURCE } from '../plan.js'
import { SessionId, makeHarness, withTimeout } from '../../framework/test/harness.mjs'

const sdkEntry = fileURLToPath(new URL('./fixtures/placeholder-sdk.mjs', import.meta.url))
const BY = Object.freeze({ kind: 'program', plugin: 'test' })

async function withExecutor(t, config = { auth: 'existing-login' }) {
    const h = await makeHarness(t)
    const fiber = await h.ctx.plugin(ExecutorModule.default ?? ExecutorModule, { sdkEntry, defaultCwd: h.root, ...config })
    t.after(() => fiber.dispose())
    return h
}

test('执行方登记：agent-sdk 路由的会话归它，额度状态问它的闸门；没有中途插话', async (t) => {
    const h = await withExecutor(t)
    const listed = h.ctx.core.executors.list().find(entry => entry.id === 'agent-sdk')
    assert.ok(listed, '登记了')
    assert.ok(listed.optional.includes('quotaGate') && listed.optional.includes('endCheck') && listed.optional.includes('resume'))
    assert.ok(!listed.optional.includes('steer'))
    assert.ok(listed.optional.includes('boundary') && listed.optional.includes('handoffTurn'), '认得 DSH 边界、切走前能写交接')

    const handle = await withTimeout(h.ctx.agents.create({
        sessionId: SessionId('cc-session'),
        meta: { cwd: h.root, agentPreset: 'plain-preset' },
        agentOptions: { provider: 'agent-sdk', model: 'opus' },
        setup: async agentCtx => { await h.ctx.agentPresets.mount(agentCtx, 'plain-preset') },
    }), 'create cc-session')
    t.after(() => handle.dispose())
    assert.equal((await h.ctx.core.executors.executorOf('cc-session')).id, 'agent-sdk')
    assert.equal(await h.ctx.core.quota.state('cc-session'), 'ok', '闸门没关')
    assert.equal(await h.ctx.core.executors.has('cc-session', 'steer'), false)
})

test('登录方式必填、没有默认值：没选或选了 api-key 却没给 key 时照样登记，但启动时报一次；api-key 时去掉订阅令牌', async (t) => {
    const { authProblem, processEnv } = ExecutorModule
    assert.match(authProblem({ env: {} }), /还没选登录方式/)
    assert.match(authProblem({ auth: 'api-key', env: {} }), /没有 ANTHROPIC_API_KEY/)
    assert.equal(authProblem({ auth: 'api-key', env: { ANTHROPIC_API_KEY: 'sk-test' } }), null)
    assert.equal(authProblem({ auth: 'existing-login', env: {} }), null)
    const keyed = processEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'o' }, { auth: 'api-key', env: { ANTHROPIC_API_KEY: 'sk-test' } })
    assert.deepEqual(keyed, { ANTHROPIC_API_KEY: 'sk-test' }, 'api-key 时只按 key 认证')
    assert.deepEqual(processEnv({ X: '1' }, { auth: 'existing-login', env: { Y: '2' } }), { X: '1', Y: '2' })

    const reports = []
    const h = await makeHarness(t)
    h.ctx.core.onReport(entry => reports.push(entry))
    const fiber = await h.ctx.plugin(ExecutorModule.default ?? ExecutorModule, { sdkEntry, defaultCwd: h.root })
    t.after(() => fiber.dispose())
    assert.ok(h.ctx.core.executors.list().some(entry => entry.id === 'agent-sdk'), '照样登记')
    assert.ok(reports.some(entry => entry.kind === 'agent-sdk/auth-unset' && /还没选登录方式/.test(entry.text)))
})

test('服务 agentSdk：别的插件经 addHooks 登记钩子，交回注销函数；不是函数的不收', async (t) => {
    const h = await withExecutor(t)
    assert.throws(() => h.ctx.agentSdk.addHooks({}), TypeError)
    const dispose = h.ctx.agentSdk.addHooks(() => ({}))
    assert.equal(typeof dispose, 'function')
    assert.equal(dispose(), true)
    assert.equal(dispose(), false, '注销过一次就没有了')
})

test('执行方自己放进会话的两种消息登记成提问、不用核心再标；额度恢复后先唤醒的是核心的中枢', async (t) => {
    const h = await withExecutor(t)
    for (const kind of [SURFACE_SOURCE, QUOTA_SOURCE]) {
        assert.equal(h.ctx.core.classify({ source: { kind } }), 'prompt', kind)
        assert.equal(h.ctx.core.sourceAudience({ source: { kind } }), 'all')
    }
    await h.ctx.core.sessions.setHub('main', { by: BY })
    assert.equal(h.ctx.core.sessions.hub(), 'main')
})

test('经历库在时，执行方把它拉起的进程记录注册成来源：按进程归属表放进它服务的 DSH 会话；查不到的程序记录报出来，用户直接运行的 Claude Code 的记录不管', async (t) => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const ExperienceModule = await import('../../framework/experience/index.js')
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(item => reports.push(item))
    const domain = await h.ctx.storageDomain.open(ExecutorModule.processesDomainSpec)
    await domain.table('processes').put('claude-abc', { sessionId: 'dsh-main', at: 1 })
    await domain.close?.()
    const project = join(h.root, 'cc-projects', 'D--work')
    await mkdir(project, { recursive: true })
    const at = second => new Date(Date.parse('2026-11-05T10:00:00+08:00') + second * 1000).toISOString()
    await writeFile(join(project, 'claude-abc.jsonl'), [
        { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 'tu1', name: 'SendMessage', input: { to: 'work-1', message: '第三章交给你' } }] } },
        { type: 'user', uuid: 'r1', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '{"msg_id":"m-77"}' }] } },
        { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(3), compactMetadata: { trigger: 'auto', preTokens: 500000 } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    const head = entrypoint => `${JSON.stringify({ type: 'user', uuid: 'x', timestamp: at(1), entrypoint, message: { content: 'hi' } })}\n`
    await writeFile(join(project, 'claude-unknown.jsonl'), head('sdk-ts'))
    await writeFile(join(project, 'dev-session.jsonl'), head('cli'))
    const experience = await h.ctx.plugin(ExperienceModule, { archiveFile: join(h.root, 'experience.sqlite'), pullSeconds: 0, startupDelaySeconds: 0 })
    t.after(() => experience.dispose())
    const fiber = await h.ctx.plugin(ExecutorModule.default ?? ExecutorModule, { sdkEntry, defaultCwd: h.root, transcriptDirectory: join(h.root, 'cc-projects') })
    t.after(() => fiber.dispose())
    const HUB = { kind: 'external', name: 'test', readOnly: true }
    const read = async () => {
        await h.ctx.experience.refresh()
        try {
            return (await h.ctx.experience.read({ sessionId: 'dsh-main', at: '2000-01-01' }, HUB)).entries
        } catch {
            return []
        }
    }
    let entries = []
    for (let attempt = 0; attempt < 40 && entries.length < 2; attempt += 1) {
        entries = await read()
        if (entries.length < 2) await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.deepEqual(entries.map(item => [item.ref, item.kind]), [['cc:claude-abc:tu1', '发给会话'], ['cc:claude-abc:c1', '压缩']])
    assert.equal(entries[0].link, 'm-77')
    const unmapped = reports.filter(item => item.kind === 'experience/unmapped-transcript')
    assert.equal(unmapped.length, 1, '只报程序拉起、又查不到的那一个，用户直接运行的不报')
    assert.match(unmapped[0].text, /claude-unknown\.jsonl/)

    // 报过的记在读取位置里：执行方重启（经历库的读取位置还在）以后文件没变就不再报；有了新内容再判断一次。
    await fiber.dispose()
    const again = await h.ctx.plugin(ExecutorModule.default ?? ExecutorModule, { sdkEntry, defaultCwd: h.root, transcriptDirectory: join(h.root, 'cc-projects') })
    t.after(() => again.dispose())
    await h.ctx.experience.refresh()
    await h.ctx.experience.refresh()
    assert.equal(reports.filter(item => item.kind === 'experience/unmapped-transcript').length, 1, '重启后同一个没变的文件不再报')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(project, 'claude-unknown.jsonl'), head('sdk-ts'))
    await h.ctx.experience.refresh()
    assert.equal(reports.filter(item => item.kind === 'experience/unmapped-transcript').length, 2, '有了新内容再判断一次')

    // 先写记录、后补归属（进程已经结束、文件不再变）：补上以后照样从头收进它服务的会话。
    await writeFile(join(project, 'claude-late.jsonl'), [
        { type: 'user', uuid: 'x2', timestamp: at(5), entrypoint: 'sdk-ts', message: { content: 'hi' } },
        { type: 'system', subtype: 'compact_boundary', uuid: 'c2', timestamp: at(6), compactMetadata: { trigger: 'auto', preTokens: 400000 } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    await h.ctx.experience.refresh()
    assert.equal(reports.filter(item => item.kind === 'experience/unmapped-transcript').length, 3, '先报一次查不到')
    await again.dispose()
    const late = await h.ctx.storageDomain.open(ExecutorModule.processesDomainSpec)
    await late.table('processes').put('claude-late', { sessionId: 'dsh-main', at: 2 })
    await late.close?.()
    const third = await h.ctx.plugin(ExecutorModule.default ?? ExecutorModule, { sdkEntry, defaultCwd: h.root, transcriptDirectory: join(h.root, 'cc-projects') })
    t.after(() => third.dispose())
    let refs = []
    for (let attempt = 0; attempt < 40 && !refs.includes('cc:claude-late:c2'); attempt += 1) {
        refs = (await read()).map(item => item.ref)
        if (!refs.includes('cc:claude-late:c2')) await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(refs.includes('cc:claude-late:c2'), '归属补上以后收进来了')
})
