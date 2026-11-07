import assert from 'node:assert/strict'
import test from 'node:test'
import { englishAsides, extractSessionTurns, inputOrigin, latestDesktopInput } from '../replies.js'

/**
 * 像框架核心一样给输入写出处：渠道准入的带 `via`（用户本人说的是 user，渠道自己放进来的是渠道插件），
 * 外部调用方经外部入口说的是外部调用方，其余带请求号的是用户本人在桌面上说的。
 */
function stampedSource(rpcId) {
    const via = { exit: 'qq', label: 'QQ 私聊' }
    if (rpcId.startsWith('channel-relay:1:')) return { kind: 'user', rpcId, speaker: { kind: 'program', plugin: 'message-channels-framework' }, via }
    if (rpcId.startsWith('channel-ingress:1:') || rpcId.startsWith('req-')) return { kind: 'user', rpcId, speaker: { kind: 'user' }, via }
    if (rpcId.startsWith('external:')) return { kind: 'user', rpcId, speaker: { kind: 'external', name: 'dev' } }
    return { kind: 'user', rpcId, speaker: { kind: 'user' } }
}

const message = (seq, rpcId, kind = 'user') => ({ type: 'user/message', seq, time: seq * 1000, data: { source: kind === 'user' ? stampedSource(rpcId) : { kind, rpcId, speaker: { kind: 'program', plugin: kind } } } })

test('桌面输入：渠道转入、外部调用方转来的消息和非用户来源都不算，只认用户在桌面上发的', () => {
    const events = [
        message(1, 'desktop-1'),
        message(2, 'channel-ingress:1:abc'),
        message(3, 'external:0f1e'),
        message(4, 'gemini', 'other-plugin'),
    ]
    assert.deepEqual(latestDesktopInput(events, [{ requestId: 'channel-ingress:1:abc' }]), { seq: 1, time: 1000 })
    assert.equal(latestDesktopInput(events.slice(1), [{ requestId: 'channel-ingress:1:abc' }]), null)
})

/** 一串真实形状的会话事件：每轮 turn/start → 输入 → 模型文字 → turn/end。 */
function sessionEvents(turns) {
    const events = []
    const push = (type, data) => {
        const event = { type, seq: events.length, time: 1000 + events.length, data }
        events.push(event)
        return event
    }
    turns.forEach(({ inputs = [], texts = [], end = 'completed' }, turn) => {
        push('turn/start', { turn })
        for (const rpcId of inputs) push('user/message', { id: `u-${turn}-${rpcId}`, role: 'user', content: [{ type: 'text', text: '话' }], source: stampedSource(rpcId) })
        texts.forEach((text, step) => push('assistant/message', { turn, message: { id: `a-${turn}-${step}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text, source: { kind: 'model' } }] } }))
        push('turn/end', { turn, reason: { kind: end } })
    })
    return events
}

test('中枢没有渠道输入的轮：有渠道输入的不取（含原件还没写回请求号的）；桌面输入算用户触发，外部调用方转来的不算；没写字的不取', () => {
    const events = sessionEvents([
        { inputs: ['req-1'], texts: ['回渠道'] },
        { inputs: ['channel-ingress:1:fresh'], texts: ['也是渠道'] },
        { inputs: ['desktop-1'], texts: ['过程', '桌面的回复'] },
        { inputs: ['external:D1'], texts: ['回外部调用方'] },
        { texts: [] },
        { texts: ['后台一轮'] },
    ])
    const turns = extractSessionTurns(events, events, [{ requestId: 'req-1', platformMessageId: 'm-1' }])
    assert.deepEqual(turns.map(item => [item.turn, item.text, item.byUser]), [[2, '桌面的回复', true], [3, '回外部调用方', false], [5, '后台一轮', false]])
})

test('原件还没写回请求号时按前缀认：用户本人的那一轮失败，接着的算用户触发；渠道代为放进来的那一轮失败不算', () => {
    const events = sessionEvents([
        { inputs: ['channel-ingress:1:own'], end: 'error' },
        { texts: ['接着回你'] },
        { inputs: ['channel-relay:1:relayed'], end: 'error' },
        { texts: ['转交失败之后'] },
    ])
    assert.deepEqual(extractSessionTurns(events, events, []).map(item => [item.text, item.byUser]),
        [['接着回你', true], ['转交失败之后', false]])
})

test('中枢没有渠道输入的轮：用户的话所在那一轮失败、之后还没有哪一轮正常结束时，接着的一轮算用户触发（例如额度恢复后的唤醒）；转交那一轮失败不算', () => {
    const events = sessionEvents([
        { inputs: ['req-user'], end: 'error' },
        { inputs: ['quota-wake'].map(() => 'external:wake'), texts: ['接着回你'] },
        { texts: ['之后的后台一轮'] },
        { inputs: ['req-relay'], end: 'error' },
        { texts: ['转交失败之后'] },
    ])
    const records = [{ requestId: 'req-user', platformMessageId: 'm-9' }, { requestId: 'req-relay', platformMessageId: 'relay:task-1' }]
    assert.deepEqual(extractSessionTurns(events, events, records).map(item => [item.text, item.byUser]),
        [['接着回你', true], ['之后的后台一轮', false], ['转交失败之后', false]])
})

test('出口检查：一两行、完全不含中文的句子算英文旁白；代码、命令、路径、网址、引用和夹着中文的不算', () => {
    const text = [
        'Now read the config file and check the proxy.',
        '',
        '好的，配置我看完了。',
        '',
        '```\nconst a = 1 // some english comment here\n```',
        '',
        'git commit -m "fix the thing now"',
        '',
        '> The quick brown fox jumps over the lazy dog.',
        '',
        '"To be or not to be, that is the question."',
        '',
        'D:\\work\\dsh\\packages',
        '',
        'See https://example.com/docs for details',
        '',
        'Let me check this 文件 first.',
        '',
        'line one of three english words here',
        'line two of three english words here',
        'line three of three english words here',
    ].join('\n')
    assert.deepEqual(englishAsides(text), ['Now read the config file and check the proxy.'])
    assert.deepEqual(englishAsides('全是中文的回复。'), [])
})

test('输入从哪来：按核心写的出处认；收件表里有的按收件行认；经 core.deliver 放进来的、外部调用方、程序都不算', () => {
    const via = { exit: 'qq', label: 'QQ 私聊' }
    const channel = new Map([['channel-ingress:1:old-relay', false]])
    assert.deepEqual(inputOrigin({ kind: 'user', rpcId: 'channel-ingress:1:old-relay' }, channel), { from: 'channel', own: false }, '收件表里有的按收件行认')
    assert.deepEqual(inputOrigin({ kind: 'user', rpcId: 'x-1', speaker: { kind: 'user' }, via }, new Map()), { from: 'channel', own: true }, '收件行还没写回：带 via 的是渠道准入的')
    assert.deepEqual(inputOrigin({ kind: 'user', rpcId: 'x-2', speaker: { kind: 'program', plugin: 'message-channels-framework' }, via }, new Map()), { from: 'channel', own: false })
    assert.deepEqual(inputOrigin({ kind: 'user', rpcId: '6f1c2c1e', speaker: { kind: 'user' } }, new Map()), { from: 'desktop', own: true })
    assert.equal(inputOrigin({ kind: 'channel-notice', deliveryKey: 'group-moved-1', speaker: { kind: 'user' }, via }, new Map()), null, '经 core.deliver 放进来的不是渠道输入')
    assert.equal(inputOrigin({ kind: 'user', rpcId: 'external:D1', speaker: { kind: 'external', name: 'dev' } }, new Map()), null)
    assert.equal(inputOrigin({ kind: 'work', deliveryKey: 'w-1', speaker: { kind: 'program', plugin: 'work' } }, new Map()), null)
    assert.equal(inputOrigin({ kind: 'user', rpcId: 'old-1' }, new Map()), null, '以前没有出处的不算桌面输入')
    assert.equal(inputOrigin(undefined, new Map()), null)
})
