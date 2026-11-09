/**
 * 核心的休息时段与出口登记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createExits, createQuietHours } from '../core/quiet.js'
import { makeHarness } from './harness.mjs'

const at = text => Date.parse(text)

test('休息时段按时区里的钟点算：时段内外、跨午夜、结束时刻；开始等于结束就是没有', () => {
    const night = createQuietHours({ start: '00:00', end: '08:00', timezone: 'Asia/Shanghai' })
    assert.equal(night.inQuiet(at('2026-11-05T02:00:00+08:00')), true)
    assert.equal(night.inQuiet(at('2026-11-05T08:00:00+08:00')), false, '结束那一刻不算')
    assert.equal(night.inQuiet(at('2026-11-05T23:30:00+08:00')), false)
    assert.equal(night.nextEnd(at('2026-11-05T02:15:30+08:00')), at('2026-11-05T08:00:00+08:00'))
    assert.equal(night.nextEnd(at('2026-11-05T12:00:00+08:00')), at('2026-11-05T12:00:00+08:00'), '不在时段里就是它自己')
    assert.equal(night.inQuiet(at('2026-11-05T02:00:00Z')), false, '同一时刻换个时区就不在时段里（北京时间 10:00）')
    const late = createQuietHours({ start: '22:00', end: '07:00', timezone: 'Asia/Shanghai' })
    assert.equal(late.inQuiet(at('2026-11-05T23:00:00+08:00')), true)
    assert.equal(late.nextEnd(at('2026-11-05T23:00:00+08:00')), at('2026-11-06T07:00:00+08:00'), '跨午夜到第二天')
    assert.equal(createQuietHours({ start: '08:00', end: '08:00' }).inQuiet(), false)
    assert.equal(night.describe(), '00:00–08:00（Asia/Shanghai）')
    assert.throws(() => createQuietHours({ start: '25:00' }), /HH:MM/)
})

test('出口登记：按出口交来的会话答 servedBy、foreground；交不出的报一次、当它没接；撤销后就没了', () => {
    const reports = []
    const exits = createExits({ report: (kind, detail) => reports.push({ kind, ...detail }) })
    const dispose = exits.register({ id: 'qq', label: 'QQ', sessions: () => [{ sessionId: 'main', as: 'hub' }, { sessionId: 'grp', as: 'group', label: '项目-小说' }] })
    exits.register({ id: 'broken', sessions: () => { throw new Error('坏了') } })
    assert.deepEqual(exits.servedBy('grp'), [{ exit: 'qq', exitLabel: 'QQ', sessionId: 'grp', as: 'group', label: '项目-小说' }])
    assert.deepEqual(exits.foreground().sort(), ['grp', 'main'])
    assert.ok(reports.some(item => item.kind === 'core/exit-sessions-failed'))
    assert.throws(() => exits.register({ id: 'qq', sessions: () => [] }), /已经登记过/)
    dispose()
    assert.deepEqual(exits.foreground(), [])
})

test('出口通知：按给的顺序挑第一个由收通知的出口接着的会话，把这个出口接着的几个一起交给它；没有出口接、出口出错、没发出都报，出口按规则不发不报', async () => {
    const reports = []
    const exits = createExits({ report: (kind, detail) => reports.push({ kind, ...detail }) })
    const calls = []
    let answer = { status: 'sent' }
    exits.register({ id: 'plain', sessions: () => [{ sessionId: 'a', as: 'group' }] })
    exits.register({
        id: 'qq',
        sessions: () => [{ sessionId: 'b', as: 'group' }, { sessionId: 'c', as: 'group' }],
        notify: async (request) => {
            calls.push(request)
            if (answer instanceof Error) throw answer
            return answer
        },
    })
    assert.deepEqual(await exits.notify(['a', 'x', 'c', 'b'], { key: 'k1', text: '开始了', at: 5 }), { status: 'sent', exit: 'qq' })
    assert.deepEqual(calls.at(-1), { sessionIds: ['c', 'b'], key: 'k1', text: '开始了', at: 5 }, '不收通知的出口跳过；同一出口接的按原顺序一起交')
    answer = { status: 'skipped', reason: 'DUPLICATE' }
    assert.deepEqual(await exits.notify(['b'], { key: 'k1', text: '开始了' }), { status: 'skipped', reason: 'DUPLICATE', exit: 'qq' })
    assert.equal(reports.length, 0, '出口按规则不发，不报')
    assert.equal((await exits.notify(['a', 'x'], { key: 'k2', text: '开始了' })).status, 'unavailable')
    answer = new Error('断了')
    assert.equal((await exits.notify(['b'], { key: 'k3', text: '开始了' })).status, 'failed')
    answer = { status: 'failed', reason: 'GROUP_GONE' }
    assert.match((await exits.notify(['b'], { key: 'k4', text: '开始了' })).reason, /GROUP_GONE/)
    assert.deepEqual(reports.map(item => [item.kind, item.data.key]), [
        ['core/notify-undeliverable', 'k2'], ['core/notify-undeliverable', 'k3'], ['core/notify-undeliverable', 'k4'],
    ])
    assert.throws(() => exits.register({ id: 'bad', sessions: () => [], notify: 'x' }), /notify 要是函数/)
    await assert.rejects(exits.notify([], { key: 'k', text: 't' }), /要给会话/)
})

test('核心交出休息时段（按配置）和出口登记（跟着登记它的插件撤）', async (t) => {
    const h = await makeHarness(t, { coreConfig: { quietHours: { start: '01:00', end: '06:00', timezone: 'Asia/Shanghai' } } })
    assert.equal(h.ctx.core.quietHours.describe(), '01:00–06:00（Asia/Shanghai）')
    const fiber = await h.ctx.plugin({ name: 'probe-exit', inject: ['core'], apply: ctx => { ctx.core.exits.register({ id: 'probe', sessions: () => [{ sessionId: 's', as: 'hub' }] }) } })
    assert.deepEqual(h.ctx.core.exits.foreground(), ['s'])
    await fiber.dispose()
    assert.deepEqual(h.ctx.core.exits.foreground(), [], '插件卸下，登记跟着撤')
})

test('出口交出中途发送：各出口合在一起按时间排；读不到的或出错的算没读到，出错的报一条；没这个能力的出口不算', async () => {
    const reports = []
    const exits = createExits({ report: (kind, item) => reports.push([kind, item.text]) })
    exits.register({ id: 'plain', sessions: () => [] })
    assert.deepEqual(await exits.sentBetween('main'), { sends: [], unread: false })
    assert.throws(() => exits.register({ id: 'bad', sessions: () => [], sentBetween: 'x' }), /sentBetween 要是函数/)
    const asked = []
    exits.register({ id: 'a', sessions: () => [], sentBetween: (...args) => { asked.push(args); return [{ at: 20, text: '后' }] } })
    exits.register({ id: 'b', sessions: () => [], sentBetween: async () => [{ at: 10, text: '先' }] })
    assert.deepEqual(await exits.sentBetween('main', 5, 30), { sends: [{ at: 10, text: '先' }, { at: 20, text: '后' }], unread: false })
    assert.deepEqual(asked, [['main', 5, 30]])
    const offline = createExits({ report: () => {} })
    offline.register({ id: 'c', sessions: () => [], sentBetween: () => null })
    assert.deepEqual(await offline.sentBetween('main'), { sends: [], unread: true }, '渠道还没起来')
    exits.register({ id: 'broken', sessions: () => [], sentBetween: () => { throw new Error('坏了') } })
    const broken = await exits.sentBetween('main')
    assert.equal(broken.unread, true)
    assert.equal(broken.sends.length, 2, '别的出口照收')
    assert.deepEqual(reports.at(-1), ['core/exit-sends-failed', '出口 broken 交不出中途发送（坏了）'])
})
