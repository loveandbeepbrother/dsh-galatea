/**
 * 群绑定工具与渠道约定的 Host 半边：找会话、调用者判定、中文结果、按会话拼渠道约定。
 *
 * development_fake：运行态与宿主服务都是内存里的替身，只记调用，不连任何平台。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CHANNEL_RULES, channelGuidance, findSession, isArchivedSession, runGroupTool } from '../index.js'

/** 宿主的项目登记表与会话列表。 */
function fakeCtx({ archived = [] } = {}) {
    const services = {
        workspaceRegistry: {
            archivedSessionIds: archived,
            list: () => [
                { id: 'ws-1', title: '远航', sessionIds: ['s-project', 'session-task-1', 's-old'] },
                { id: 'ws-2', title: '示例书', sessionIds: ['s-voyage', 's-dup-1'] },
            ],
        },
        sessionController: {
            list: async () => ({
                items: [
                    { sessionId: 's-project', projections: { values: { title: '远航·项目会话' } } },
                    { sessionId: 'session-task-1', projections: { values: { title: '任务·润色' } } },
                    { sessionId: 's-old', projections: { values: { title: '远航·旧讨论' } } },
                    { sessionId: 's-voyage', projections: { values: { title: '示例书·项目会话' } } },
                    { sessionId: 's-dup-1', projections: { values: { title: '设定' } } },
                    { sessionId: 's-dup-2', projections: { values: { title: '设定' } } },
                    { sessionId: 's-main', projections: { values: { title: '中枢' } } },
                ],
            }),
        },
    }
    return { get: name => services[name] }
}

/** 只记调用的运行态。 */
function fakeRuntime(answers = {}) {
    const calls = []
    return {
        calls,
        listGroups: async (request) => {
            calls.push(['list', request])
            return answers.list ?? { status: 'ok', connected: true, groups: [] }
        },
        bindGroup: async (request) => {
            calls.push(['bind', request])
            return answers.bind ?? { status: 'bound', groupId: '777', name: '项目-远航', sessionId: request.sessionId, session: request.sessionTitle ?? request.sessionId, replaced: null, confirmed: true }
        },
        unbindGroup: async (request) => {
            calls.push(['unbind', request])
            return answers.unbind ?? { status: 'unbound', groupId: '777', name: '项目-远航', sessionId: 's-project', session: '远航·项目会话', dropped: 0, confirmed: true }
        },
    }
}

const execOf = (sessionId, extra = {}) => ({ agent: { session: { id: sessionId, header: {} }, ...extra } })

test('findSession：按会话 id、会话标题、项目标题依次找；归档的不算；同名与找不到时给候选', async () => {
    const ctx = fakeCtx({ archived: ['s-old'] })
    assert.deepEqual(await findSession(ctx, 's-voyage'), { sessionId: 's-voyage', title: '示例书·项目会话' })
    assert.deepEqual(await findSession(ctx, '远航·项目会话'), { sessionId: 's-project', title: '远航·项目会话' })
    assert.deepEqual(await findSession(ctx, '示例书'), { sessionId: 's-voyage', title: '示例书·项目会话' })
    // 任务会话按 id 找得到（由运行态说明为什么不行），按标题不算。
    assert.equal((await findSession(ctx, 'session-task-1')).sessionId, 'session-task-1')
    assert.equal((await findSession(ctx, '任务·润色')).reason, 'NONE')
    const dup = await findSession(ctx, '设定')
    assert.equal(dup.reason, 'AMBIGUOUS')
    assert.deepEqual(dup.candidates.map(item => item.sessionId), ['s-dup-1', 's-dup-2'])
    const none = await findSession(ctx, '旧讨论')
    assert.equal(none.reason, 'NONE')
    assert.deepEqual(none.candidates, [], '归档的会话不当候选')
    assert.equal(isArchivedSession(ctx, 's-old'), true)
    assert.equal(isArchivedSession(ctx, 's-project'), false)
    assert.equal(isArchivedSession({ get: () => undefined }, 's-project'), undefined)
})

test('绑定工具：不写 session 就是接到自己；写项目标题时接它的项目会话；replace 原样转交；子代理不能调用', async () => {
    const ctx = fakeCtx()
    const runtime = fakeRuntime()
    const self = await runGroupTool(ctx, runtime, { action: 'bind', group: '闲聊' }, execOf('s-old'))
    assert.match(self, /已把群「项目-远航」（777）接到「远航·旧讨论」。群里已发确认。/)
    assert.deepEqual(runtime.calls[0], ['bind', { caller: 's-old', group: '闲聊', sessionId: 's-old', sessionTitle: '远航·旧讨论', replace: false }])
    await runGroupTool(ctx, runtime, { action: 'bind', session: '示例书', replace: true }, execOf('s-project'))
    assert.deepEqual(runtime.calls[1], ['bind', { caller: 's-project', group: undefined, sessionId: 's-voyage', sessionTitle: '示例书·项目会话', replace: true }])
    // 会话列表里没有自己（例如没有标题）时照样按 id 接到自己。
    await runGroupTool(ctx, runtime, { action: 'bind', group: '888' }, execOf('s-unlisted'))
    assert.deepEqual(runtime.calls[2][1].sessionId, 's-unlisted')
    assert.match(await runGroupTool(ctx, runtime, { action: 'bind', session: '设定' }, execOf('s-main')), /有几个会话都叫「设定」/)
    assert.match(await runGroupTool(ctx, runtime, { action: 'bind', group: '777' }, execOf('s-main', { parentAgent: {} })), /子代理不能/)
    assert.match(await runGroupTool(ctx, runtime, { action: 'other' }, execOf('s-main')), /action 只能是/)
    assert.equal(runtime.calls.length, 3, '找不到会话、子代理、错的 action 都到不了运行态')
})

test('绑定工具的结果：改绑与解绑自己的群时写明这一轮的回复只留在 DSH；拒绝时写明原因与下一步', async () => {
    const ctx = fakeCtx()
    const rebound = fakeRuntime({ bind: { status: 'rebound', groupId: '777', name: '项目-远航', sessionId: 's-voyage', session: '示例书·项目会话', previous: { sessionId: 's-project', session: '远航·项目会话' }, replaced: null, confirmed: true } })
    const moved = await runGroupTool(ctx, rebound, { action: 'bind', session: '示例书' }, execOf('s-project'))
    assert.match(moved, /（原来接「远航·项目会话」）[\s\S]*你这一轮的回复不会再发到这个群/)
    const unbound = await runGroupTool(ctx, fakeRuntime(), { action: 'unbind' }, execOf('s-project'))
    assert.match(unbound, /已解绑群「项目-远航」（777）[\s\S]*你这一轮的回复不会再发到这个群/)
    const fromMain = await runGroupTool(ctx, fakeRuntime(), { action: 'unbind', group: '777' }, execOf('s-main'))
    assert.ok(!fromMain.includes('你这一轮的回复'), '中枢解绑别的群时它自己的回复照常')
    const taken = fakeRuntime({ bind: { status: 'refused', reason: 'SESSION_TAKEN', group: { groupId: '888', name: '闲聊' } } })
    assert.match(await runGroupTool(ctx, taken, { action: 'bind', group: '777', session: '示例书' }, execOf('s-main')), /已经接着群「闲聊」[\s\S]*replace: true/)
    const listed = fakeRuntime({ list: { status: 'ok', connected: true, groups: [
        { groupId: '777', name: '项目-远航', sessionId: 's-project', session: '远航·项目会话', unbound: false, gone: 'archived' },
        { groupId: '888', name: '闲聊', sessionId: null, session: null, unbound: false, gone: null },
    ] } })
    const list = await runGroupTool(ctx, listed, { action: 'list' }, execOf('s-main'))
    assert.match(list, /「项目-远航」（777）：接着「远航·项目会话」（s-project），但这个会话已归档\n- 「闲聊」（888）：没有接会话/)
})

test('渠道约定按会话拼：接着群的会话写明群名与群号和改法；中枢写明群可以各接一个会话；其他会话没有这一节', () => {
    const runtime = {
        boundSessionIds: () => new Set(['s-project', 's-main']),
        groupOfSession: id => (id === 's-project' ? { groupId: '777', name: '项目-远航', label: '测试聊天' } : null),
        groupLabel: () => '测试聊天',
        replyPlan: () => ({ order: ['测试聊天', '微信'], note: true }),
    }
    const group = channelGuidance(runtime, 's-project')
    assert.match(group, /^本会话接着用户的测试聊天群「项目-远航」（群号 777）/)
    assert.match(group, /\[等待\][\s\S]*assistant_channel_group/)
    assert.ok(!group.includes('私聊共用'))
    const main = channelGuidance(runtime, 's-main', '00:00–08:00（Asia/Shanghai）')
    assert.match(main, /^本会话与用户在手机上的私聊共用。/)
    assert.match(main, /其余按测试聊天、微信的先后走，都发不了时用用户最近说话的渠道；没走测试聊天时，消息开头会注明。/, '回复先后照配置')
    assert.match(main, /休息时段（00:00–08:00（Asia\/Shanghai））里/, '休息时段照核心的说法')
    assert.match(main, /用户的测试聊天群可以各接一个会话（一个会话只接一个群）/)
    const plain = channelGuidance({ boundSessionIds: () => new Set(['s-main']), groupOfSession: () => null, groupLabel: () => null, replyPlan: () => ({ order: [], note: false }) }, 's-main')
    assert.match(plain, /其余发到用户最近说话的渠道。/, '没配先后：发到最近说话的渠道')
    assert.ok(!plain.includes('一个会话只接一个群'), '没有支持群的平台：不提群')
    // 发送约定（图片、分片、中途发送）由渠道自己交代，私聊和群都有；项目任务的事归项目任务插件。
    for (const text of [main, group]) assert.ok(text.includes(CHANNEL_RULES))
    assert.ok(!main.includes('项目任务'))
    assert.equal(channelGuidance(runtime, 's-other'), '')
    assert.equal(channelGuidance(null, 's-project'), '')
})
