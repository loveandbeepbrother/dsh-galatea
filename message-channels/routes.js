/**
 * Owner-only HTTP surface of the message-channels Host.
 *
 * Every route below is an exact Fetch route on the official Connection service:
 * `connection.fetch.register` mounts it on the shared `/api` channel, so the
 * Host/Origin/Cookie fence and the owner-peer check belong to Connection. Only
 * an owner Peer reaches a handler; every other principal gets 403 before this
 * module runs. Nothing here authenticates, mints a cookie or reads a principal,
 * because a second half-authentication scheme in front of the same pairing data
 * would be a weaker fence, not a stronger one.
 *
 * Bodies are buffered (Connection's JSON cap applies first) and capped again
 * here. Every failure answers a stable code and nothing else: never an SDK
 * error, an appSecret, a context token or an arbitrary thrown object.
 *
 * @module @loveandbeepbrother/dsh-galatea-channels/routes
 */

/** Absolute path prefix shared by every route this module registers. */
export const CHANNEL_PREFIX = '/api/galatea-channels'


/** Second body cap; Connection's own buffered cap is the first one. */
const MAX_BODY_CHARS = 8192

/** Response headers a JSON answer always carries. */
const JSON_HEADERS = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
}

/** Response headers the QR image carries; a pairing code must never be cached. */
const SVG_HEADERS = {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'no-store',
}

/** Shape a code must have before it may travel to the browser. */
const CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/**
 * Register the channel actions on the shared Connection surface.
 *
 * The returned disposer removes exactly the routes registered here; the caller
 * owns it (the Host registers it through `ctx.effect`).
 *
 * @param connection - the official Connection handle; only `fetch.register` is read.
 * @param runtime - the channel runtime this plugin published.
 * @param options - `qrToSvg(text)` renders QR text to an SVG string.
 * @returns an idempotent asynchronous disposer removing every route registered here.
 */
export function registerChannelRoutes(connection, runtime, options) {
    if (connection === null || typeof connection !== 'object') {
        throw new TypeError('registerChannelRoutes: connection is required')
    }
    const registry = connection.fetch
    if (registry === null || typeof registry !== 'object' || typeof registry.register !== 'function') {
        throw new TypeError('registerChannelRoutes: connection.fetch.register is required')
    }
    if (runtime === null || typeof runtime !== 'object') {
        throw new TypeError('registerChannelRoutes: runtime is required')
    }
    const qrToSvg = options === null || options === undefined ? undefined : options.qrToSvg
    if (typeof qrToSvg !== 'function') {
        throw new TypeError('registerChannelRoutes: options.qrToSvg is required')
    }

    const routes = [
        { path: `${CHANNEL_PREFIX}/status`, method: 'GET', handler: statusRoute },
        { path: `${CHANNEL_PREFIX}/qr.svg`, method: 'GET', handler: qrRoute },
        { path: `${CHANNEL_PREFIX}/begin`, method: 'POST', handler: beginRoute },
        { path: `${CHANNEL_PREFIX}/verify-code`, method: 'POST', handler: verifyCodeRoute },
        { path: `${CHANNEL_PREFIX}/select-account`, method: 'POST', handler: selectAccountRoute },
        { path: `${CHANNEL_PREFIX}/cancel`, method: 'POST', handler: cancelRoute },
        { path: `${CHANNEL_PREFIX}/disconnect`, method: 'POST', handler: disconnectRoute },
        { path: `${CHANNEL_PREFIX}/group-unbind`, method: 'POST', handler: groupUnbindRoute },
    ]

    const disposers = []
    try {
        for (const route of routes) {
            disposers.push(registry.register({
                path: route.path,
                // One method per route: exact-route dispatch only hands over the
                // methods listed here, and `guard` checks the method again, so a
                // request can never be answered by a different action.
                methods: [route.method],
                requestBody: 'buffered',
                fetch: guard(route.method, route.handler),
            }))
        }
    } catch (error) {
        // Half a route table is worse than none: a page that can begin a pairing
        // but not cancel it leaves an attempt nobody can stop.
        for (const dispose of disposers) {
            try {
                const result = dispose()
                if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
                    result.then(undefined, () => {})
                }
            } catch (ignored) {
                // The registration failure below is the error worth reporting.
            }
        }
        throw error
    }

    let disposed = false
    return async function disposeChannelRoutes() {
        if (disposed) return
        disposed = true
        const failures = []
        for (const dispose of disposers) {
            try {
                await dispose()
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length > 0) throw failures[0]
    }

    /**
     * Wrap one handler with the two rules every route shares.
     *
     * @param method - the single method this route owns.
     * @param handler - the route body.
     * @returns a Fetch handler answering 405 or a stable 503 instead of throwing.
     */
    function guard(method, handler) {
        return async function guarded(request) {
            if (request.method !== method) return failure(405, 'method-not-allowed')
            try {
                return await handler(request)
            } catch (error) {
                // A thrown value may carry a token in its message; only its code
                // is allowed to leave this process.
                return failure(503, stableCode(error))
            }
        }
    }

    /** GET /status: the read-only projection, sent exactly as the runtime reports it. */
    async function statusRoute() {
        return json(200, runtime.status())
    }

    /**
     * GET /qr.svg?platform=…&attemptId=…
     *
     * 读取 QR 文本前先核对当前尝试；渲染后重读一次 canonical status 和精确 QR
     * 文本，取消或重新配对落在渲染窗口内时报 409/404，页面不会拿到旧图。
     */
    async function qrRoute(request) {
        const url = new URL(request.url, 'http://127.0.0.1')
        const platform = readPlatform(url.searchParams.get('platform'))
        if (platform === null) return failure(400, 'invalid-platform')
        const attemptId = readValue(url.searchParams.get('attemptId'))
        if (attemptId === null) return failure(400, 'invalid-attempt')
        const channel = channelOf(readStatus(), platform)
        if (channel === null) return failure(503, 'unavailable')
        if (channel.pairAttemptId !== attemptId) return failure(409, 'stale-attempt')
        const text = runtime.qr(platform)
        if (typeof text !== 'string' || text.trim() === '') return failure(404, 'qr-unavailable')
        const svg = await qrToSvg(text)
        if (typeof svg !== 'string' || svg === '') return failure(503, 'qr-unavailable')
        // 渲染期间可能取消、重扫或换码：渲染后再核一次，变化就不返回旧二维码。
        const current = channelOf(readStatus(), platform)
        if (current === null) return failure(503, 'unavailable')
        if (current.pairAttemptId !== attemptId) return failure(409, 'stale-attempt')
        const latest = runtime.qr(platform)
        if (typeof latest !== 'string' || latest.trim() === '' || latest !== text) {
            return failure(404, 'qr-unavailable')
        }
        // SVG 作为图片响应返回，页面用 <img> 加载。
        return new Response(svg, { status: 200, headers: SVG_HEADERS })
    }

    /**
     * POST /begin {platform}
     *
     * 202 means "an attempt was started", never "the account is bound": the
     * binding only ever becomes visible through the status projection.
     */
    async function beginRoute(request) {
        const parsed = await readBody(request, ['platform'], ['platform'])
        if (parsed.error !== undefined) return parsed.error
        const platform = readPlatform(parsed.fields.platform)
        if (platform === null) return failure(400, 'invalid-platform')
        const attempt = await runtime.beginPair(platform)
        // 还没有中枢会话：私聊配对要绑到中枢，不开始。
        if (attempt?.refused === 'NO_HUB') return failure(409, 'no-hub')
        const attemptId = attempt === null || typeof attempt !== 'object' ? null : readValue(attempt.attemptId)
        if (attemptId === null) return failure(503, 'pair-not-started')
        return json(202, { attemptId: attemptId })
    }

    /** POST /verify-code {platform, attemptId, code} */
    async function verifyCodeRoute(request) {
        const parsed = await readBody(
            request,
            ['platform', 'attemptId', 'code'],
            ['platform', 'attemptId', 'code'],
        )
        if (parsed.error !== undefined) return parsed.error
        const platform = readPlatform(parsed.fields.platform)
        if (platform === null) return failure(400, 'invalid-platform')
        await runtime.verifyCode({
            platform: platform,
            attemptId: parsed.fields.attemptId,
            code: parsed.fields.code,
        })
        return json(200, runtime.status())
    }

    /** POST /select-account {platform, attemptId, accountId} */
    async function selectAccountRoute(request) {
        const parsed = await readBody(
            request,
            ['platform', 'attemptId', 'accountId'],
            ['platform', 'attemptId', 'accountId'],
        )
        if (parsed.error !== undefined) return parsed.error
        const platform = readPlatform(parsed.fields.platform)
        if (platform === null) return failure(400, 'invalid-platform')
        await runtime.selectAccount({
            platform: platform,
            attemptId: parsed.fields.attemptId,
            accountId: parsed.fields.accountId,
        })
        return json(200, runtime.status())
    }

    /** POST /cancel {platform, attemptId} */
    async function cancelRoute(request) {
        const parsed = await readBody(request, ['platform', 'attemptId'], ['platform', 'attemptId'])
        if (parsed.error !== undefined) return parsed.error
        const platform = readPlatform(parsed.fields.platform)
        if (platform === null) return failure(400, 'invalid-platform')
        await runtime.cancelPair({ platform: platform, attemptId: parsed.fields.attemptId })
        return json(200, runtime.status())
    }

    /** POST /disconnect {platform} — the main assistant session survives it. */
    async function disconnectRoute(request) {
        const parsed = await readBody(request, ['platform'], ['platform'])
        if (parsed.error !== undefined) return parsed.error
        const platform = readPlatform(parsed.fields.platform)
        if (platform === null) return failure(400, 'invalid-platform')
        await runtime.disconnect(platform)
        return json(200, runtime.status())
    }

    /** POST /group-unbind {groupId} — 设置页解绑一个群（支持群的平台上的）；群里收到解绑确认。 */
    async function groupUnbindRoute(request) {
        const parsed = await readBody(request, ['groupId'], ['groupId'])
        if (parsed.error !== undefined) return parsed.error
        if (!/^\d+$/.test(parsed.fields.groupId)) return failure(400, 'invalid-field')
        if (typeof runtime.unbindGroup !== 'function') return failure(404, 'unavailable')
        const result = await runtime.unbindGroup({ group: parsed.fields.groupId, by: 'settings' })
        if (result === null || typeof result !== 'object' || result.status !== 'unbound') {
            const code = typeof result?.reason === 'string' && CODE_PATTERN.test(result.reason) ? result.reason : 'unavailable'
            return failure(409, code)
        }
        return json(200, runtime.status())
    }

    /**
     * Read one JSON object body and validate its exact field set.
     *
     * @param request - the Fetch request whose body is read once.
     * @param allowed - every key this action accepts; anything else is refused so
     *   a body cannot carry an unvalidated extra field into the runtime.
     * @param required - the keys that must be present non-empty strings.
     * @returns `{ fields }` on success, `{ error }` carrying the response to send.
     */
    async function readBody(request, allowed, required) {
        let text
        try {
            text = await request.text()
        } catch (error) {
            return { error: failure(400, 'invalid-body') }
        }
        if (typeof text !== 'string') return { error: failure(400, 'invalid-body') }
        if (text.length > MAX_BODY_CHARS) return { error: failure(400, 'body-too-large') }
        let parsed
        try {
            parsed = JSON.parse(text)
        } catch (error) {
            return { error: failure(400, 'invalid-body') }
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { error: failure(400, 'invalid-body') }
        }
        for (const key of Object.keys(parsed)) {
            if (!allowed.includes(key)) return { error: failure(400, 'unknown-field') }
        }
        const fields = {}
        for (const key of required) {
            const value = parsed[key]
            if (typeof value !== 'string') return { error: failure(400, 'invalid-field') }
            const trimmed = value.trim()
            if (trimmed === '') return { error: failure(400, 'invalid-field') }
            fields[key] = trimmed
        }
        return { fields: fields }
    }

    /** Read the status projection once; a throwing runtime is mapped by `guard`. */
    function readStatus() {
        return runtime.status()
    }

    /** Pick one platform's entry out of the projection without trusting its shape. */
    function channelOf(projection, platform) {
        if (projection === null || typeof projection !== 'object') return null
        const channels = projection.channels
        if (!Array.isArray(channels)) return null
        for (const channel of channels) {
            if (channel !== null && typeof channel === 'object' && channel.platform === platform) return channel
        }
        return null
    }

    /** Accept one of the two platform ids, or nothing. */
    /** A platform the runtime has right now (built-in or registered); any other value is a 400. */
    function readPlatform(value) {
        const trimmed = readValue(value)
        return trimmed !== null && channelOf(readStatus(), trimmed) !== null ? trimmed : null
    }

    /** A non-empty trimmed string, or nothing. */
    function readValue(value) {
        if (typeof value !== 'string') return null
        const trimmed = value.trim()
        return trimmed === '' ? null : trimmed
    }

    /** The stable code of a thrown value; never its message. */
    function stableCode(error) {
        if (error !== null && typeof error === 'object') {
            const code = error.code
            if (typeof code === 'string' && CODE_PATTERN.test(code)) return code
        }
        return 'unavailable'
    }

    /** One JSON response; `undefined` serializes as no body rather than "undefined". */
    function json(status, value) {
        return new Response(JSON.stringify(value === undefined ? null : value), {
            status: status,
            headers: JSON_HEADERS,
        })
    }

    /** One failure response: a stable code and nothing else. */
    function failure(status, code) {
        return new Response(JSON.stringify({ error: code }), {
            status: status,
            headers: JSON_HEADERS,
        })
    }
}
