/**
 * Route-table tests for the message-channels Host.
 *
 * Deliberately narrow. The subject is the route table: which exact routes exist,
 * which methods reach them, what a body may contain, when a QR code may be read,
 * what a response is allowed to leak, and whether the disposer really removes
 * everything. The runtime itself is a `development_fake` double and the route
 * registry is a stub, so nothing here is a second implementation of either.
 *
 * Owner authentication is **not** tested and must not be: Connection's
 * owner-peer check is what makes these routes owner-only, and a stub that
 * answered "authenticated" would be a test certifying a fence it does not have.
 * What is asserted instead is that this module contributes no authentication
 * surface of its own.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CHANNEL_PREFIX, registerChannelRoutes } from '../routes.js'

const PLATFORMS = ['qq', 'weixin']

/** One fresh channel row per platform, in the runtime's own vocabulary. */
function emptyChannel() {
    return {
        phase: 'idle',
        connected: false,
        accountId: null,
        senderId: null,
        pairAttemptId: null,
        qr: null,
        choices: [],
        unknownCount: 0,
        errorCode: null,
    }
}

/**
 * A development fake of the runtime.
 *
 * It implements only the members `routes.js` calls, keeps every call in `calls`
 * so a test can prove what did *not* happen (a QR text read after a stale
 * attempt, a pairing begun by a rejected body), and can be made to throw.
 */
function createDevelopmentFakeRuntime() {
    const calls = []
    const channels = { qq: emptyChannel(), weixin: emptyChannel() }
    const runtime = {
        calls: calls,
        channels: channels,
        fault: null,
        status() {
            if (runtime.fault !== null) throw runtime.fault
            return {
                channels: PLATFORMS.map((platform) => {
                    const channel = channels[platform]
                    return {
                        platform: platform,
                        phase: channel.phase,
                        connected: channel.connected,
                        accountId: channel.accountId,
                        senderId: channel.senderId,
                        pairAttemptId: channel.pairAttemptId,
                        choices: channel.choices.slice(),
                        errorCode: channel.errorCode,
                        unknownCount: channel.unknownCount,
                    }
                }),
            }
        },
        qr(platform) {
            calls.push(['qr', platform])
            return channels[platform].qr
        },
        beginPair(platform) {
            calls.push(['beginPair', platform])
            const channel = channels[platform]
            channel.phase = 'waiting'
            channel.pairAttemptId = 'attempt-' + platform
            channel.qr = 'qr-text:' + platform
            return Promise.resolve({ attemptId: channel.pairAttemptId })
        },
        verifyCode(input) {
            calls.push(['verifyCode', input])
            channels[input.platform].phase = 'scanned'
            return Promise.resolve()
        },
        selectAccount(input) {
            calls.push(['selectAccount', input])
            return Promise.resolve()
        },
        cancelPair(input) {
            calls.push(['cancelPair', input])
            const channel = channels[input.platform]
            channel.phase = 'idle'
            channel.pairAttemptId = null
            channel.qr = null
            return Promise.resolve()
        },
        disconnect(platform) {
            calls.push(['disconnect', platform])
            channels[platform].connected = false
            return Promise.resolve()
        },
        wake() {
            calls.push(['wake'])
        },
        close() {
            calls.push(['close'])
            return Promise.resolve()
        },
    }
    return runtime
}

/**
 * A stub of Connection's exact-route registry.
 *
 * `call` reproduces the one dispatch rule that matters here: a route answers
 * only paths *and* methods it registered. It models no authentication, because
 * it has none to model.
 */
function createRouteRegistry() {
    const entries = []
    return {
        entries: entries,
        fetch: {
            register(route) {
                const entry = { route: route, active: true }
                entries.push(entry)
                return async function dispose() {
                    entry.active = false
                }
            },
        },
        async call(method, path, body) {
            // 真实 Request.url 带 query；exact route 只按 pathname 匹配。
            const target = new URL(path, 'http://127.0.0.1')
            const entry = entries.find((candidate) => candidate.active && candidate.route.path === target.pathname)
            if (entry === undefined) return null
            if (!entry.route.methods.includes(method)) return null
            const init = { method: method }
            if (body !== undefined) {
                init.body = body
                init.headers = { 'content-type': 'application/json' }
            }
            return entry.route.fetch(new Request(target, init))
        },
    }
}

/** A QR renderer that records the text it was asked to encode. */
function createQrRenderer() {
    const calls = []
    return {
        calls: calls,
        render(text) {
            calls.push(text)
            return Promise.resolve('<svg xmlns="http://www.w3.org/2000/svg" data-qr="' + text + '"/>')
        },
    }
}

/**
 * A QR renderer the test can hold: the route stays suspended inside `qrToSvg`
 * while the test changes the runtime, then releases it. This reaches the window
 * where a render outlives its attempt.
 */
function createHeldQrRenderer() {
    const calls = []
    const draws = []
    const waiters = []
    return {
        calls: calls,
        /** Resolves with the next render's release handle, in call order. */
        hold() {
            return new Promise((resolve) => {
                const next = draws.shift()
                if (next !== undefined) resolve(next)
                else waiters.push(resolve)
            })
        },
        render(text) {
            calls.push(text)
            let finish
            const drawn = new Promise((resolve) => {
                finish = resolve
            })
            const draw = {
                text: text,
                finish() {
                    finish('<svg xmlns="http://www.w3.org/2000/svg" data-qr="' + text + '"/>')
                },
            }
            const waiter = waiters.shift()
            if (waiter !== undefined) waiter(draw)
            else draws.push(draw)
            return drawn
        },
    }
}

/** Register the routes against fresh doubles. */
async function setup() {
    const registry = createRouteRegistry()
    const runtime = createDevelopmentFakeRuntime()
    const renderer = createQrRenderer()
    const dispose = registerChannelRoutes(registry, runtime, { qrToSvg: renderer.render })
    return { registry: registry, runtime: runtime, renderer: renderer, dispose: dispose }
}

test('registers one exact owner-only route per action and no authentication of its own', async () => {
    const { registry } = await setup()
    assert.deepEqual(registry.entries.map((entry) => entry.route.path), [
        `${CHANNEL_PREFIX}/status`,
        `${CHANNEL_PREFIX}/qr.svg`,
        `${CHANNEL_PREFIX}/begin`,
        `${CHANNEL_PREFIX}/verify-code`,
        `${CHANNEL_PREFIX}/select-account`,
        `${CHANNEL_PREFIX}/cancel`,
        `${CHANNEL_PREFIX}/disconnect`,
        `${CHANNEL_PREFIX}/group-unbind`,
    ])
    for (const entry of registry.entries) {
        assert.equal(entry.route.methods.length, 1)
        assert.equal(entry.route.requestBody, 'buffered')
        // The whole contribution is the four documented fields: no cookie read,
        // no principal, no second token check. Connection's owner check is the
        // only fence in front of these routes.
        assert.deepEqual(Object.keys(entry.route).sort(), ['fetch', 'methods', 'path', 'requestBody'])
    }
})

test('GET status sends the runtime projection unchanged with no-store', async () => {
    const { registry, runtime } = await setup()
    const response = await registry.call('GET', `${CHANNEL_PREFIX}/status`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), runtime.status())
})

test('POST begin answers 202 with the attempt id and never claims a binding', async () => {
    const { registry, runtime } = await setup()
    const response = await registry.call('POST', `${CHANNEL_PREFIX}/begin`, JSON.stringify({ platform: 'qq' }))
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { attemptId: 'attempt-qq' })
    assert.deepEqual(runtime.calls, [['beginPair', 'qq']])
    // 202 says "the attempt started". The projection still reports no connection.
    const projection = await (await registry.call('GET', `${CHANNEL_PREFIX}/status`)).json()
    const qq = projection.channels.find((channel) => channel.platform === 'qq')
    assert.equal(qq.connected, false)
    assert.equal(qq.pairAttemptId, 'attempt-qq')
})

test('a method a route does not own reaches no action at all', async () => {
    const { registry, runtime } = await setup()
    // Exact-route dispatch matches path and method, so these never dispatch.
    assert.equal(await registry.call('GET', `${CHANNEL_PREFIX}/begin`), null)
    assert.equal(await registry.call('POST', `${CHANNEL_PREFIX}/status`), null)
    assert.deepEqual(runtime.calls, [])

    // A handler reached with the wrong method refuses instead of acting.
    const begin = registry.entries.find((entry) => entry.route.path === `${CHANNEL_PREFIX}/begin`)
    const response = await begin.route.fetch(new Request(`http://127.0.0.1${CHANNEL_PREFIX}/begin`, { method: 'GET' }))
    assert.equal(response.status, 405)
    assert.deepEqual(await response.json(), { error: 'method-not-allowed' })
    assert.deepEqual(runtime.calls, [])
})

test('invalid bodies answer one stable 400 code and never echo the body', async () => {
    const { registry, runtime } = await setup()
    const cases = [
        ['not json', 'not-json', 'invalid-body'],
        ['an array', JSON.stringify(['qq']), 'invalid-body'],
        ['a non-string field', JSON.stringify({ platform: 5 }), 'invalid-field'],
        ['an unknown platform', JSON.stringify({ platform: 'telegram' }), 'invalid-platform'],
        ['an unvalidated extra field', JSON.stringify({ platform: 'qq', appSecret: 'super-secret' }), 'unknown-field'],
        ['an oversized body', JSON.stringify({ platform: 'qq', code: 'x'.repeat(8200) }), 'body-too-large'],
    ]
    for (const [label, body, code] of cases) {
        const response = await registry.call('POST', `${CHANNEL_PREFIX}/begin`, body)
        const text = await response.text()
        assert.equal(response.status, 400, label)
        assert.deepEqual(JSON.parse(text), { error: code }, label)
        assert.equal(text.includes('super-secret'), false, label)
    }
    assert.deepEqual(runtime.calls, [])
})

test('a superseded attempt cannot read a QR code', async () => {
    const { registry, runtime, renderer } = await setup()
    runtime.channels.weixin.phase = 'waiting'
    runtime.channels.weixin.pairAttemptId = 'attempt-2'
    runtime.channels.weixin.qr = 'qr-text:weixin:attempt-2'

    const response = await registry.call('GET', `${CHANNEL_PREFIX}/qr.svg?platform=weixin&attemptId=attempt-1`)
    const text = await response.text()
    assert.equal(response.status, 409)
    assert.deepEqual(JSON.parse(text), { error: 'stale-attempt' })
    // Neither the text that pairs nor any render of it leaves the Host.
    assert.equal(text.includes('qr-text:weixin'), false)
    assert.deepEqual(renderer.calls, [])
    assert.deepEqual(runtime.calls, [])
})

test('the current attempt renders as an SVG image', async () => {
    const { registry, runtime, renderer } = await setup()
    runtime.channels.weixin.phase = 'waiting'
    runtime.channels.weixin.pairAttemptId = 'attempt-2'
    runtime.channels.weixin.qr = 'qr-text:weixin:attempt-2'

    const response = await registry.call('GET', `${CHANNEL_PREFIX}/qr.svg?platform=weixin&attemptId=attempt-2`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(await response.text(), /^<svg/)
    assert.deepEqual(renderer.calls, ['qr-text:weixin:attempt-2'])
})

test('an empty QR text is a 404 and unreadable parameters are a 400', async () => {
    const { registry, runtime, renderer } = await setup()
    runtime.channels.qq.phase = 'waiting'
    runtime.channels.qq.pairAttemptId = 'attempt-qq'
    runtime.channels.qq.qr = ''

    // The previous code must not survive a re-pairing as a cached image.
    const empty = await registry.call('GET', `${CHANNEL_PREFIX}/qr.svg?platform=qq&attemptId=attempt-qq`)
    assert.equal(empty.status, 404)
    assert.deepEqual(await empty.json(), { error: 'qr-unavailable' })
    assert.deepEqual(renderer.calls, [])

    assert.equal((await registry.call('GET', `${CHANNEL_PREFIX}/qr.svg?attemptId=attempt-qq`)).status, 400)
    assert.equal((await registry.call('GET', `${CHANNEL_PREFIX}/qr.svg?platform=qq`)).status, 400)
})

test('a failing runtime answers its stable code without private details', async () => {
    const { registry, runtime } = await setup()
    const rejection = new Error('appSecret=super-secret contextToken=ctx-1')
    rejection.code = 'channel-closed'
    runtime.fault = rejection

    const response = await registry.call('GET', `${CHANNEL_PREFIX}/status`)
    const text = await response.text()
    assert.equal(response.status, 503)
    assert.deepEqual(JSON.parse(text), { error: 'channel-closed' })
    assert.equal(text.includes('super-secret'), false)
    assert.equal(text.includes('ctx-1'), false)

    runtime.fault = new Error('contextToken=ctx-2')
    const unclassified = await registry.call('GET', `${CHANNEL_PREFIX}/status`)
    assert.equal(unclassified.status, 503)
    assert.deepEqual(await unclassified.json(), { error: 'unavailable' })
})

test('verify-code forwards the exact fields and answers the projection', async () => {
    const { registry, runtime } = await setup()
    const response = await registry.call(
        'POST',
        `${CHANNEL_PREFIX}/verify-code`,
        JSON.stringify({ platform: 'weixin', attemptId: 'attempt-1', code: ' 123456 ' }),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(runtime.calls, [
        ['verifyCode', { platform: 'weixin', attemptId: 'attempt-1', code: '123456' }],
    ])
    assert.deepEqual(await response.json(), runtime.status())
})

test('the disposer removes every route and stays idempotent', async () => {
    const { registry, dispose } = await setup()
    await dispose()
    assert.equal(registry.entries.every((entry) => entry.active === false), true)
    assert.equal(await registry.call('GET', `${CHANNEL_PREFIX}/status`), null)
    // A second call must not remove anything twice or throw.
    await dispose()
})

test('a QR that finishes after cancel or a new code is never served', async () => {
    const registry = createRouteRegistry()
    const runtime = createDevelopmentFakeRuntime()
    const renderer = createHeldQrRenderer()
    const dispose = registerChannelRoutes(registry, runtime, { qrToSvg: renderer.render })

    runtime.channels.qq.phase = 'waiting'
    runtime.channels.qq.pairAttemptId = 'attempt-1'
    runtime.channels.qq.qr = 'qr-text:qq:attempt-1'

    const pending = registry.call('GET', `${CHANNEL_PREFIX}/qr.svg?platform=qq&attemptId=attempt-1`)
    const drawing = await renderer.hold()
    assert.equal(drawing.text, 'qr-text:qq:attempt-1')

    // The page cancels while the SVG is still rendering.
    const cancelled = await registry.call(
        'POST',
        `${CHANNEL_PREFIX}/cancel`,
        JSON.stringify({ platform: 'qq', attemptId: 'attempt-1' }),
    )
    assert.equal(cancelled.status, 200)
    drawing.finish()

    const superseded = await pending
    const supersededText = await superseded.text()
    assert.equal(superseded.status, 409)
    assert.deepEqual(JSON.parse(supersededText), { error: 'stale-attempt' })
    assert.equal(supersededText.includes('qr-text:qq'), false)

    // Same attempt, but the platform replaced the code: the old image is stale
    // for the same reason.
    runtime.channels.qq.phase = 'waiting'
    runtime.channels.qq.pairAttemptId = 'attempt-2'
    runtime.channels.qq.qr = 'qr-text:qq:attempt-2'
    const second = registry.call('GET', `${CHANNEL_PREFIX}/qr.svg?platform=qq&attemptId=attempt-2`)
    const secondDrawing = await renderer.hold()
    runtime.channels.qq.qr = 'qr-text:qq:attempt-2b'
    secondDrawing.finish()

    const refreshed = await second
    const refreshedText = await refreshed.text()
    assert.equal(refreshed.status, 404)
    assert.deepEqual(JSON.parse(refreshedText), { error: 'qr-unavailable' })
    assert.equal(refreshedText.includes('qr-text:qq'), false)

    await dispose()
})

test('group-unbind：设置页解绑一个群，只收纯数字群号，按设置页身份交给运行态；运行态拒绝时回它的稳定原因', async () => {
    const { registry, runtime } = await setup()
    let answer = { status: 'unbound', groupId: '777' }
    runtime.unbindGroup = async (input) => {
        runtime.calls.push(['unbindGroup', input])
        return answer
    }
    const response = await registry.call('POST', `${CHANNEL_PREFIX}/group-unbind`, JSON.stringify({ groupId: ' 777 ' }))
    assert.equal(response.status, 200)
    assert.deepEqual(runtime.calls, [['unbindGroup', { group: '777', by: 'settings' }]])
    assert.deepEqual(await response.json(), runtime.status())

    const invalid = await registry.call('POST', `${CHANNEL_PREFIX}/group-unbind`, JSON.stringify({ groupId: '项目-远航' }))
    assert.equal(invalid.status, 400)
    const extra = await registry.call('POST', `${CHANNEL_PREFIX}/group-unbind`, JSON.stringify({ groupId: '777', caller: 'x' }))
    assert.equal(extra.status, 400)
    assert.equal(runtime.calls.length, 1, '不合法的请求到不了运行态')

    answer = { status: 'refused', reason: 'NOT_BOUND' }
    const refused = await registry.call('POST', `${CHANNEL_PREFIX}/group-unbind`, JSON.stringify({ groupId: '888' }))
    assert.equal(refused.status, 409)
    assert.deepEqual(await refused.json(), { error: 'NOT_BOUND' })
})
