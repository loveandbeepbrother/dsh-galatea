/**
 * core.deliver 交给不在内存里的会话：经上游公开的 sessionController.resolveAgent 恢复。
 * 装的是上游真实的会话控制器，恢复走它自己的那条路（读日志、按 preset 组装、agents.resume）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionId, makeHarness, waitFor } from './harness.mjs'
import { TURN_ROUTE_RECORD } from '../core/routes.js'

const BY = Object.freeze({ kind: 'program', plugin: 'test' })

test('会话不在内存里：deliver 经 sessionController.resolveAgent 恢复它，再放进去、叫醒开一轮', async (t) => {
    const h = await makeHarness(t, { controller: true })
    await h.createSession('cold', { release: true })
    const result = await h.ctx.core.deliver('cold', { key: 'k-cold', text: '给冷会话', source: { kind: 'assistant-session' }, speaker: BY })
    assert.equal(result.status, 'delivered', result.reason)
    assert.notEqual(h.ctx.agents.get(SessionId('cold')), undefined, '会话被恢复到内存里')
    await waitFor(async () => (await h.turnEnds('cold')).length === 1, '恢复后这一轮跑完')
    const [message] = await h.userMessages('cold')
    assert.equal(message.source.deliveryKey, 'k-cold')
})

test('会话根本不存在：sessionController 交回 not-found，deliver 返回不可用并写明原因', async (t) => {
    const h = await makeHarness(t, { controller: true })
    const result = await h.ctx.core.deliver('never-created', { key: 'k', text: 't', source: { kind: 'x' }, speaker: BY })
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /never-created/)
    assert.match(result.reason, /session\/not-found/)
})

test('回复去向的插件记录：能写、标成可跳过、不进模型；Host 重启后冷恢复时被跳过不报错，照样读得到', async (t) => {
    // 守着上游的 appendPluginRecord：上游哪天收紧这个接口或改了恢复时的处理，这条先失败。
    const root = await mkdtemp(join(tmpdir(), 'mind-framework-record-'))
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
    const firstCleanups = []
    const before = await makeHarness({ after: cleanup => firstCleanups.push(cleanup) }, { root, controller: true })
    await before.createSession('routed', { release: true })
    const first = await before.ctx.core.deliver('routed', { key: 'k1', text: '第一条', source: { kind: 'note' }, speaker: BY, reply: { to: 'none' } })
    await waitFor(async () => (await before.turnEnds('routed')).length === 1, '第一轮跑完')
    const [record] = (await before.events('routed')).filter(event => event.type === TURN_ROUTE_RECORD)
    assert.equal(record.ignorable, true, '插件记录标成可跳过')
    assert.equal(before.adapter.requests.at(-1).messages.some(message => JSON.stringify(message).includes(TURN_ROUTE_RECORD)), false, '不进模型看到的内容')
    assert.equal(await before.ctx.sessions.flush(before.ctx.agents.get(SessionId('routed')).session), true)
    for (const cleanup of firstCleanups) await cleanup()

    // 同一份数据重新搭一套：会话只在磁盘上，经会话控制器冷恢复，恢复不因这条记录失败。
    const h = await makeHarness(t, { root, controller: true })
    const again = await h.ctx.core.deliver('routed', { key: 'k2', text: '重启后再来一条', source: { kind: 'note' }, speaker: BY })
    assert.equal(again.status, 'delivered', again.reason)
    await waitFor(async () => (await h.turnEnds('routed')).length === 2, '重启后第二轮跑完')
    const [end1, end2] = await h.turnEnds('routed')
    assert.deepEqual(await h.ctx.core.turnRoute('routed', end1.data.turn), { turn: end1.data.turn, trigger: first.messageId, route: { to: 'none' } })
    assert.deepEqual((await h.ctx.core.turnRoute('routed', end2.data.turn)).route, { to: 'origin' })
})
