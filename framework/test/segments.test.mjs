/**
 * 核心：上下文段。原生走上游真实的 system-prompt 组装；别的执行方的开头与变更说明按核心记下的版本比。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createUserMessage, makeHarness, waitFor } from './harness.mjs'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })

function promptMessage(text) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function runTurn(h, sessionId, agent, text) {
    const before = (await h.turnEnds(sessionId)).length
    agent.followup(promptMessage(text))
    await waitFor(async () => (await h.turnEnds(sessionId)).length === before + 1, `${sessionId} 第 ${before + 1} 轮`)
    return (await h.turnEnds(sessionId)).at(-1)
}

/**
 * 最近一次模型请求里最新的那份运行时快照（段都在里面）。历史里旧的快照还带着旧内容，
 * 上游在新快照开头写明它取代之前的快照，模型看最新的那份，所以只查这一份。
 */
function lastRequest(h) {
    const snapshots = h.adapter.requests.at(-1).messages
        .filter(message => message.role === 'user')
        .map(message => message.content.map(block => block.text ?? '').join(''))
        .filter(text => text.startsWith('Current runtime context'))
    return snapshots.at(-1) ?? ''
}

test('原生：段按会话异步现算、空的不交，每一步都是最新的；登记它的插件卸下时段跟着撤掉', async (t) => {
    const h = await makeHarness(t)
    const hub = await h.createSession('hub')
    const work = await h.createSession('work')
    await h.ctx.core.sessions.setHub('hub', { by: BY })
    const probe = await h.pluginContext('probe-segments')
    let version = 1
    probe.core.segment({
        name: 'probe-messages',
        order: 9_000,
        audience: 'opening',
        text: async ({ sessionId, role }) => {
            await new Promise(resolve => setTimeout(resolve, 5))
            return role === 'hub' ? `待告知留言 v${version}（${sessionId}）` : ''
        },
    })
    assert.throws(() => probe.core.segment({ name: 'probe-messages', order: 1, audience: 'opening', text: () => '' }), /已经登记过/)

    await runTurn(h, 'hub', hub, '一')
    assert.ok(lastRequest(h).includes('待告知留言 v1（hub）'), '中枢有这段')
    await runTurn(h, 'work', work, '一')
    assert.ok(!lastRequest(h).includes('待告知留言'), '别的会话算出来是空，不交')

    version = 2
    await runTurn(h, 'hub', hub, '二')
    assert.ok(lastRequest(h).includes('待告知留言 v2'), '每一步重新算')

    await probe.fiber.dispose()
    await runTurn(h, 'hub', hub, '三')
    assert.ok(!lastRequest(h).includes('待告知留言'), '插件卸下，段跟着撤')
})

test('段算的时候出错：note 写一句读取失败并报异常；fail 让这一步失败', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const withdraw = h.ctx.core.segment({ name: '记忆目录', order: 9_100, audience: 'opening', text: () => { throw new Error('目录文件坏了') } })
    await runTurn(h, 'main', agent, '一')
    assert.ok(lastRequest(h).includes('（记忆目录 这一轮读取失败）'), '不给空串')
    assert.ok(reports.some(entry => entry.kind === 'core/segment-failed' && entry.text.includes('目录文件坏了')))
    withdraw()

    h.ctx.core.segment({ name: '心智', order: 9_200, audience: 'opening', onError: 'fail', text: async () => { throw new Error('人格文件读不出') } })
    const failed = await runTurn(h, 'main', agent, '二')
    assert.equal(failed.data.reason.kind, 'error')
    assert.match(JSON.stringify(failed.data.reason), /心智 读取失败/)
})

test('附提醒在原生是一个段：没交到的每一步都在，交到以后就没有了', async (t) => {
    const h = await makeHarness(t)
    const agent = await h.createSession('main')
    await h.ctx.core.attach('main', 'usage', '用量提醒：五小时窗口已用 80%')
    await runTurn(h, 'main', agent, '一')
    assert.ok(lastRequest(h).includes('用量提醒：五小时窗口已用 80%'))
    await waitFor(() => !h.ctx.core.pending('main', 'usage'), '交到')
    await runTurn(h, 'main', agent, '二')
    assert.ok(!lastRequest(h).includes('用量提醒'), '交到以后不再出现')
})

test('别的执行方：open 给开头的全文；changes 按 onChange 给变更说明，没了的作废，压缩后补全文；重启不丢', async (t) => {
    const h = await makeHarness(t)
    const texts = { persona: '人格 v1', memory: '记忆目录：A', messages: '留言：一条', native: '原生运行环境' }
    const register = () => [
        h.ctx.core.segment({ name: '人格', order: 1, audience: 'opening', onChange: 'notice', noticeText: '（人格已更新，要看全文用 mind_read）', text: () => texts.persona }),
        h.ctx.core.segment({ name: '记忆目录', order: 2, audience: 'opening', onChange: (prev, next) => `记忆目录从「${prev}」变成「${next}」`, text: () => texts.memory }),
        h.ctx.core.segment({ name: '待告知留言', order: 3, audience: 'opening', text: () => texts.messages }),
        h.ctx.core.segment({ name: '原生环境', order: 4, audience: 'native-only', text: () => texts.native }),
    ]
    register()
    const opening = await h.ctx.core.segments.open('cc-conv-1', 'hub')
    assert.deepEqual(opening.map(entry => entry.name), ['人格', '记忆目录', '待告知留言'], '只给开头要有的')
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv-1', 'hub'), [], '没变不提')

    texts.persona = '人格 v2'
    texts.memory = '记忆目录：A、B'
    texts.messages = ''
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv-1', 'hub'), [
        '（人格已更新，要看全文用 mind_read）',
        '记忆目录从「记忆目录：A」变成「记忆目录：A、B」',
        '（待告知留言已经没有了，以前给你的旧版本作废）',
    ])

    texts.memory = '记忆目录：A、B、C'
    assert.deepEqual(await h.ctx.core.segments.changes('cc-conv-1', 'hub'), ['记忆目录从「记忆目录：A、B」变成「记忆目录：A、B、C」'], '会话自己改的不提，由核心按端点的调用算，见 endpoint.test.mjs')

    // 重启核心：每个对话看到的版本存在核心的存储里。
    await h.unmountCore()
    await h.mountCore()
    register()
    texts.messages = '留言：又一条'
    const compacted = await h.ctx.core.segments.changes('cc-conv-1', 'hub', { compacted: true })
    assert.deepEqual(compacted, [
        '【人格（对话开始以来改过，压缩后补全文）】\n人格 v2',
        '【记忆目录（对话开始以来改过，压缩后补全文）】\n记忆目录：A、B、C',
        '【待告知留言（对话开始以来改过，压缩后补全文）】\n留言：又一条',
    ])
    const fresh = await h.ctx.core.segments.changes('cc-conv-2', 'hub')
    assert.equal(fresh.length, 3, '没 open 过的对话按刚开对话处理，给开头的全文')
})

test('上游的段：登记了给谁的按登记的，没登记的当开头要有的照交，报一次', async (t) => {
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    h.ctx.core.segments.declareSegment('sandbox:policy', { audience: 'native-only' })
    assert.equal(h.ctx.core.segments.audienceOf('sandbox:policy'), 'native-only')
    assert.equal(h.ctx.core.segments.audienceOf('somebody:new'), 'opening')
    assert.equal(h.ctx.core.segments.audienceOf('somebody:new'), 'opening')
    assert.equal(reports.filter(entry => entry.kind === 'core/undeclared-segment').length, 1)
    assert.equal(h.ctx.core.segments.audienceOf('mind-framework-attachments'), 'native-only', '框架自己的段按自己的 audience')
})

test('读取失败不算内容变了：成功、失败一轮、恢复，三轮的说明；开对话时就失败的段恢复后给全文', async (t) => {
    const h = await makeHarness(t)
    let broken = false
    let memory = '记忆目录：A'
    let persona = '人格 v1'
    let personaBroken = true
    h.ctx.core.segment({ name: '记忆目录', order: 1, audience: 'opening', onChange: (prev, next) => `记忆目录从「${prev}」变成「${next}」`, text: () => {
        if (broken) throw new Error('目录文件坏了')
        return memory
    } })
    h.ctx.core.segment({ name: '人格', order: 2, audience: 'opening', onChange: 'notice', text: () => {
        if (personaBroken) throw new Error('人格文件读不出')
        return persona
    } })

    const opening = await h.ctx.core.segments.open('conv', 'hub')
    assert.deepEqual(opening.map(entry => entry.text), ['记忆目录：A', '（人格 这一轮读取失败）'], '开对话时失败的照样交出失败那句')

    broken = true
    assert.deepEqual(await h.ctx.core.segments.changes('conv', 'hub'), [
        '（记忆目录这一轮读取失败，沿用之前的版本）',
        '（人格这一轮读取失败）',
    ], '失败一轮：只说读取失败，不说已更新')

    broken = false
    personaBroken = false
    assert.deepEqual(await h.ctx.core.segments.changes('conv', 'hub'), [
        '【人格已更新，下面是全文】\n人格 v1',
    ], '恢复：记忆目录没变不提；开对话时就失败的人格按新出现的段给全文')

    broken = true
    memory = '记忆目录：A、B'
    assert.deepEqual(await h.ctx.core.segments.changes('conv', 'hub', { compacted: true }), [
        '（记忆目录这一轮读取失败，沿用之前的版本）',
        '【人格（对话开始以来改过，压缩后补全文）】\n人格 v1',
    ], '压缩后补全文时跳过读取失败的段')
    broken = false
    assert.deepEqual(await h.ctx.core.segments.changes('conv', 'hub'), ['记忆目录从「记忆目录：A」变成「记忆目录：A、B」'], '恢复后按真内容比')
})

test('压缩那一轮读取失败的段：记成基线的版本，恢复时把对话里改过的那版补上', async (t) => {
    const h = await makeHarness(t)
    let broken = false
    let memory = '记忆目录：A'
    h.ctx.core.segment({ name: '记忆目录', order: 1, audience: 'opening', text: () => {
        if (broken) throw new Error('目录文件坏了')
        return memory
    } })
    await h.ctx.core.segments.open('conv', 'hub')
    memory = '记忆目录：A、B'
    assert.equal((await h.ctx.core.segments.changes('conv', 'hub')).length, 1, '对话里改过一次，已经告诉过')
    broken = true
    assert.deepEqual(await h.ctx.core.segments.changes('conv', 'hub', { compacted: true }), ['（记忆目录这一轮读取失败，沿用之前的版本）'])
    broken = false
    assert.deepEqual(await h.ctx.core.segments.changes('conv', 'hub'), [`【记忆目录已更新，下面是全文】${String.fromCharCode(10)}记忆目录：A、B`],
        '压缩后模型手里只剩基线，恢复时补上改过的那版')
})

test('续接用同一个对话键再 open：基线和看到的版本换成这一次交出的，之后压缩补发只补真改过的', async (t) => {
    const h = await makeHarness(t)
    let memory = '记忆目录：A'
    h.ctx.core.segment({ name: '记忆目录', order: 1, audience: 'opening', text: () => memory })
    await h.ctx.core.segments.open('conv', 'hub')
    memory = '记忆目录：A、B'
    const reopened = await h.ctx.core.segments.open('conv', 'hub')
    assert.deepEqual(reopened.map(entry => entry.text), ['记忆目录：A、B'], '续接的新进程系统提示放的就是这一份')
    assert.deepEqual(await h.ctx.core.segments.changes('conv', 'hub', { compacted: true }), [], '基线已经是这一份，压缩后不重复补发')
})
