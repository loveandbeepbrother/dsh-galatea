import { test } from 'node:test'
import assert from 'node:assert/strict'
import { voiceOutput } from '../index.js'

/** 只有 `boundSessionIds`、`push` 和语音说法的假运行态。 */
function runtimeWith(result) {
    const pushed = []
    return {
        pushed,
        boundSessionIds: () => new Set(['main']),
        voiceWord: platform => ({ chat: '测试聊天（音频文件）', weixin: '微信（音频文件）' })[platform] ?? platform,
        push: async (request) => {
            pushed.push(request)
            if (result instanceof Error) throw result
            return result
        },
    }
}

test('语音去向：接着渠道的会话可用，没接的说明原因；发出去报平台，发不出报原因', async () => {
    const runtime = runtimeWith({ status: 'sent', platform: 'chat', sent: 1, failed: 0 })
    const output = voiceOutput(runtime)
    assert.equal(output.id, 'channel')
    assert.deepEqual(await output.available({ id: 'main' }), { yes: true })
    assert.deepEqual(await output.available({ id: 'other' }), { yes: false, why: '这个会话没接手机上的聊天渠道' })
    assert.deepEqual(await output.deliver({ id: 'main' }, 'D:/a.wav', { seconds: 2 }), { ok: true, detail: '已作为语音发到测试聊天（音频文件）' })
    assert.deepEqual(runtime.pushed, [{ sessionId: 'main', voice: 'D:/a.wav', by: { kind: 'program', plugin: 'tts-say' } }], '记下是语音合成插件发的')
    const weixin = voiceOutput(runtimeWith({ status: 'sent', platform: 'weixin', sent: 1, failed: 0 }))
    assert.equal((await weixin.deliver({ id: 'main' }, 'D:/a.wav', { seconds: 2 })).detail, '已作为语音发到微信（音频文件）')
    const failed = voiceOutput(runtimeWith({ status: 'unavailable', reason: 'NO_BINDING' }))
    assert.deepEqual(await failed.deliver({ id: 'main' }, 'D:/a.wav', { seconds: 2 }), { ok: false, detail: '没有发到渠道：NO_BINDING' })
})
