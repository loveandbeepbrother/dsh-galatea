/**
 * 渠道接到框架核心上：真的入口、真的核心、上游真的会话控制器。
 * 一条私聊、一条群消息进会话，日志里的 `source.speaker`、`source.via` 由入口声明、核心写进去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createMainTextIngress } from '../channel-ingress.js'
import { originOf, pushEntryOf } from '../runtime.js'
import { join } from 'node:path'
import * as ExperienceModule from '../../framework/experience/index.js'
import { makeHarness, waitFor } from '../../framework/test/harness.mjs'

test('私聊、群消息进会话：日志里记成用户本人说的，via 写明哪个平台、私聊还是哪个群；渠道代为放进来的记成渠道插件、带来源标注', async (t) => {
    const h = await makeHarness(t, { controller: true })
    // 经上游的会话控制器建（真实 DSH 里渠道的会话都是这样建的），它才收这个会话的 prompt。
    const { sessionId } = await h.ctx.sessionController.create({ cwd: h.workDirectory })
    const main = String(sessionId)
    const binding = { platform: 'qq', accountId: 'bot-1', conversationId: 'owner-1', senderId: 'owner-1', sessionId: main }
    const ingress = createMainTextIngress(h.ctx, binding)
    t.after(() => ingress.close?.())
    const send = (messageId, text, origin) => ingress.admit({ kind: 'private', platform: 'qq', accountId: 'bot-1', conversationId: 'owner-1', senderId: 'owner-1', messageId, text, origin })
    await send('m-1', '私聊里说的', originOf({ platform: 'qq' }, false))
    await send('m-2', '群里说的', originOf({ platform: 'qq', ownerBindingId: 'qq', groupName: '项目-小说', conversationId: 'g-1' }, false))
    await send('m-3', '代为放进来的', originOf({ platform: 'qq' }, true))
    await waitFor(async () => (await h.userMessages(main)).length === 3, '三条都进了会话')
    // 不是用户本人说的，核心把来源标注写在第一个文本块开头，所以按"含有"找。
    const messages = await h.userMessages(main)
    const byText = Object.fromEntries(['私聊里说的', '群里说的', '代为放进来的'].map(text => [text, messages.find(message => message.content.some(block => block.text?.includes(text)))?.source]))
    assert.deepEqual(byText['私聊里说的'].speaker, { kind: 'user' })
    assert.deepEqual(byText['私聊里说的'].via, { exit: 'qq', label: 'QQ 私聊' })
    assert.deepEqual(byText['群里说的'].via, { exit: 'qq', label: 'QQ 群「项目-小说」' })
    assert.deepEqual(byText['代为放进来的'].speaker, { kind: 'program', plugin: 'message-channels-framework' })
    assert.match(byText['代为放进来的'].annotation ?? '', /插件 message-channels-framework.*不是用户本人说的/, '不是用户本人说的，核心加来源标注')
})

test('中途发送的条目经历库收得下（真的经历库）：编号照旧，中枢读得到，角色、类别、对方照写', async (t) => {
    const h = await makeHarness(t, { controller: true })
    await h.createSession('main')
    await h.ctx.core.sessions.setHub('main', { by: { kind: 'program', plugin: 'test' } })
    const fiber = await h.ctx.plugin(ExperienceModule, { archiveFile: join(h.root, 'experience.sqlite'), pullSeconds: 0, startupDelaySeconds: 0 })
    t.after(() => fiber.dispose())
    const source = h.ctx.experience.registerSource({ id: 'channel-pushes', label: '消息渠道的中途发送', category: 'dsh' })
    const at = Date.parse('2026-11-05T10:00:00+08:00')
    const entry = pushEntryOf([{ sessionId: 'main', bindingId: 'b-1', endSeq: at, partIndex: 0, text: '好，开始读。', state: 'sent' }], '测试聊天')
    assert.equal(await source.append([entry]), 1)
    const read = await h.ctx.experience.read({ sessionId: 'main', at: '2026-11-05' }, { kind: 'session', sessionId: 'main', role: 'hub' })
    const found = read.entries.find(item => item.ref === `push:main:b-1:${at}`)
    assert.ok(found, JSON.stringify(read.entries))
    assert.match(JSON.stringify(found), /好，开始读。/)
    assert.match(JSON.stringify(found), /中途发给用户/)
})
