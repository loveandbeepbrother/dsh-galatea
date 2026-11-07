/**
 * `assistant_session_send`：会话之间互相转交的方向与权限（development_fake）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runSessionSend } from '../index.js'

const MAIN = 'session-main'
const PROJECT = 'session-haocai'
const TASK = 'session-task-abc'

/** 框架核心的替身：按键去重，记下放进各会话的话（真核心的 deliver 在 mind-framework 的测试里）。 */
function fakeCore() {
    const inboxes = new Map()
    const keys = new Set()
    return {
        sessions: { hub: () => MAIN },
        inboxOf: id => inboxes.get(id) ?? [],
        async deliver(sessionId, message) {
            if (keys.has(`${sessionId}\u0000${message.key}`)) return { status: 'duplicate' }
            keys.add(`${sessionId}\u0000${message.key}`)
            inboxes.set(sessionId, [...inboxes.get(sessionId) ?? [], message])
            return { status: 'delivered', messageId: `m-${keys.size}` }
        },
    }
}

function setup({ groups, workspaces, extraSessions = [] } = {}) {
    const core = fakeCore()
    const sessions = [
        { sessionId: MAIN, projections: { values: { title: '中枢' } } },
        { sessionId: PROJECT, projections: { values: { title: '远航·项目会话' } } },
        { sessionId: TASK, projections: { values: { title: '任务·润色' } } },
        ...extraSessions,
    ]
    const services = {
        sessionController: { list: async () => ({ items: sessions }) },
        workspaceRegistry: { archivedSessionIds: [], list: () => workspaces ?? [{ id: 'ws', title: '远航', sessionIds: [PROJECT, TASK] }] },
    }
    const ctx = { get: name => services[name] }
    const runtime = {
        exitSessions: () => [{ sessionId: MAIN, as: 'hub' }, { sessionId: PROJECT, as: 'group', label: '群「项目-远航」' }],
        listGroups: async () => ({ status: 'ok', groups: groups ?? [{ groupId: '777', name: '项目-远航', sessionId: PROJECT }] }),
    }
    const send = (caller, args, extra = {}) => runSessionSend(ctx, runtime, core, args, {
        agent: { session: { id: caller, header: {} }, ...extra },
        callId: `call-${Math.random()}`,
    })
    return { core, send, runtime, ctx }
}

test('项目会话、任务会话只能发给中枢：出处记成调用的会话，回复照常发到手机', async () => {
    const { core, send } = setup()
    assert.match(await send(PROJECT, { text: '第三章需要用户定结局方向' }), /已交给中枢.*照常发到用户手机/)
    const [message] = core.inboxOf(MAIN)
    assert.equal(message.text, '【项目会话转来：远航·项目会话】\n第三章需要用户定结局方向')
    assert.deepEqual(message.source, { kind: 'galatea-session', from: PROJECT })
    assert.deepEqual(message.speaker, { kind: 'session', sessionId: PROJECT })
    assert.equal(message.reply, undefined, '去向照来源登记的（中枢：发到手机）')
    assert.match(await send(TASK, { text: '做完了', to: '中枢' }), /已交给中枢/)
    assert.match(core.inboxOf(MAIN)[1].text, /^【项目会话转来：任务·润色】/)
    assert.match(await send(TASK, { text: 'x', to: PROJECT }), /只能发给中枢/)
    assert.match(await send(TASK, { text: 'x', reply: 'group' }), /只在中枢发给接群的会话时用/)
    assert.equal(core.inboxOf(PROJECT).length, 0)
})

test('中枢发给接群的会话：默认回复留在对方会话、正文写明；reply: "group" 时去向是 {to:"exit"}，回复发到群里', async () => {
    const { core, send } = setup()
    assert.match(await send(MAIN, { text: '按新大纲改第三章', to: '远航' }), /已交给「远航·项目会话」.*留在它自己的会话里，不会转回给你/)
    const [stays] = core.inboxOf(PROJECT)
    assert.equal(stays.text, '【中枢转来】（这一轮的回复留在这个会话里，不发到群里，也不会转回给中枢。）\n按新大纲改第三章')
    assert.equal(stays.reply, undefined)
    assert.match(await send(MAIN, { text: '在群里说一声初稿好了', to: '777', reply: 'group' }), /会发到它接的群里/)
    const toGroup = core.inboxOf(PROJECT)[1]
    assert.deepEqual(toGroup.reply, { to: 'exit' })
    assert.match(toGroup.text, /^【中枢转来】（这一轮的回复会发到你接的群里。）/)
    assert.match(await send(MAIN, { text: 'x', to: TASK, reply: 'group' }), /没有接群/)
    assert.match(await send(MAIN, { text: 'x', to: '远航', reply: 'qq' }), /reply 只能是 "group"/)
})

test('中枢按项目名、会话标题、会话 id 或 群找目标；不填、找不到、发给自己都不发', async () => {
    const { core, send } = setup()
    for (const to of ['远航', '远航·项目会话', PROJECT, '777', '项目-远航']) assert.match(await send(MAIN, { text: `去看 ${to}`, to }), /已交给「远航·项目会话」/)
    assert.equal(core.inboxOf(PROJECT).length, 5)
    assert.match(await send(MAIN, { text: 'x' }), /要写明发给谁/)
    assert.match(await send(MAIN, { text: 'x', to: '不存在的项目' }), /找不到「不存在的项目」/)
    assert.match(await send(MAIN, { text: 'x', to: MAIN }), /不能发给自己/)
})

test('子代理不能发；同一次工具调用重试不重复', async () => {
    const { core, send, ctx, runtime } = setup()
    assert.match(await send(PROJECT, { text: 'x' }, { parentAgent: {} }), /子代理不能/)
    const exec = { agent: { session: { id: PROJECT, header: {} } }, callId: 'call-same' }
    await runSessionSend(ctx, runtime, core, { text: '一次' }, exec)
    assert.match(await runSessionSend(ctx, runtime, core, { text: '一次' }, exec), /之前已经交给中枢了/)
    assert.equal(core.inboxOf(MAIN).length, 1)
    assert.match(await runSessionSend(ctx, null, core, { text: 'x' }, exec), /渠道还没就绪/)
})

test('目标不猜：解绑过或会话已不在的群不算；同名的群、同名的项目不止一个时列出来让中枢用号码或 id（Codex 复核）', async () => {
    const OTHER = 'session-other'
    const unbound = setup({ groups: [{ groupId: '777', name: '项目-远航', sessionId: PROJECT, unbound: true, gone: null }] })
    assert.match(await unbound.send(MAIN, { text: 'x', to: '777' }), /找不到「777」/)
    const gone = setup({ groups: [{ groupId: '777', name: '项目-远航', sessionId: PROJECT, unbound: false, gone: 'archived' }] })
    assert.match(await gone.send(MAIN, { text: 'x', to: '项目-远航' }), /找不到/)
    const twins = setup({ groups: [
        { groupId: '777', name: '同名群', sessionId: PROJECT, unbound: false, gone: null },
        { groupId: '888', name: '同名群', sessionId: TASK, unbound: false, gone: null },
    ] })
    assert.match(await twins.send(MAIN, { text: 'x', to: '同名群' }), /有几个群都叫「同名群」.*777.*888/)
    assert.equal(twins.core.inboxOf(PROJECT).length, 0)
    const projects = setup({
        extraSessions: [{ sessionId: OTHER, projections: { values: { title: '远航·项目会话' } } }],
        workspaces: [{ id: 'ws1', title: '远航', sessionIds: [PROJECT] }, { id: 'ws2', title: '远航', sessionIds: [OTHER] }],
    })
    assert.match(await projects.send(MAIN, { text: 'x', to: '远航' }), /有几个会话都叫「远航」/)
})
