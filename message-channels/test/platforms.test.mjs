/**
 * Behaviour tests for the QQ and Weixin platform adapters.
 *
 * Everything here is a `development_fake`: the SDK, the connector, `fetch` and
 * `sleep` are injected, so no real login happens, no socket is opened and no
 * test depends on a terminal, a credential or the network.
 *
 * One exception is deliberate: the default-factory test imports the installed
 * `@tencent-connect/qqbot-connector` package to check which module really
 * carries `startQrConnect`. Nothing there logs in either: it pairs with an
 * already-aborted signal.
 *
 * Run with: node --test test/ (from message-channels/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createQQPlatform } from '../platforms/qq.js';
import { createWeixinPlatform } from '../platforms/weixin.js';

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, label) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        if (predicate() === true) return;
        await flush();
    }
    throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// QQ development_fake: an SDK module and a connector module, both inert.
// ---------------------------------------------------------------------------

function createQQFake(sendHandler) {
    const state = { bots: [], qr: null, disposed: 0, sendCalls: [] };

    class FakeQQBot {
        constructor(options) {
            this.options = options;
            this.handlers = new Map();
            this.stopped = false;
            state.bots.push(this);
        }

        on(event, handler) {
            this.handlers.set(event, handler);
            return this;
        }

        off(event) {
            this.handlers.delete(event);
            return this;
        }

        emit(event, ...args) {
            const handler = this.handlers.get(event);
            return handler === undefined ? undefined : handler(...args);
        }

        start(signal) {
            this.startSignal = signal;
            return new Promise((resolve) => {
                this.settle = resolve;
                if (signal === undefined) return;
                if (signal.aborted === true) {
                    resolve();
                    return;
                }
                signal.addEventListener('abort', () => resolve(), { once: true });
            });
        }

        stop() {
            this.stopped = true;
            this.settle?.();
        }

        async send(options) {
            state.sendCalls.push(options);
            return sendHandler === undefined ? { id: 'SRV-MSG-1' } : sendHandler(options);
        }

        async sendText(target, content) {
            state.sendCalls.push({ target, content, viaSendText: true });
            return sendHandler === undefined ? { id: 'SRV-MSG-1' } : sendHandler({ target, content });
        }
    }

    const connector = {
        startQrConnect(callbacks, options) {
            state.qr = { callbacks, options };
            return () => {
                state.disposed += 1;
            };
        },
    };

    return { state, sdk: { QQBot: FakeQQBot, MsgType: { TEXT: 0 } }, connector };
}

const QQ_OWNER = { appId: 'APP-1', appSecret: 'SECRET-1', userOpenid: 'OWN-1' };

function qqOwnerMessage(id, text, overrides = {}) {
    return {
        rawEventType: 'C2C_MESSAGE_CREATE',
        kind: 'c2c',
        senderId: 'OWN-1',
        senderIsBot: false,
        content: text,
        messageId: id,
        msgType: 0,
        replyTarget: { scope: 'c2c', targetId: 'OWN-1', msgId: id },
        raw: { id, type: 'C2C_MESSAGE_CREATE', author: { user_openid: 'OWN-1', bot: false }, content: text },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------

test('QQ pair: hands the QR to onQr and keeps the scanning user openid', async () => {
    const { state, sdk, connector } = createQQFake();
    const platform = await createQQPlatform({ sdk, connector });

    const qrTexts = [];
    const pending = platform.pair({ onQr: (text) => qrTexts.push(text) });
    await flush();

    assert.ok(state.qr, 'the connector was asked to start a QR login');
    assert.equal(state.qr.options.displayQrCodeToConsole, false, 'the QR must never be printed');
    assert.equal(state.qr.options.source, 'dsh');

    state.qr.callbacks.onQrDisplayed('https://q.qq.com/connect?k=QR-1');
    state.qr.callbacks.onSuccess([
        { appId: 'APP-1', appSecret: 'SECRET-1', userOpenid: 'OWN-1' },
    ]);

    const credentials = await pending;
    assert.deepEqual(qrTexts, ['https://q.qq.com/connect?k=QR-1']);
    assert.deepEqual(credentials, [{
        platform: 'qq',
        accountId: 'APP-1',
        senderId: 'OWN-1',
        credential: { appId: 'APP-1', appSecret: 'SECRET-1', userOpenid: 'OWN-1' },
    }]);
});

test('QQ pair: a login without the scanning user is OWNER_UNVERIFIED, abort disposes the poll', async () => {
    const missingOwner = createQQFake();
    const platformA = await createQQPlatform({ sdk: missingOwner.sdk, connector: missingOwner.connector });
    const pendingA = platformA.pair({});
    await flush();
    missingOwner.state.qr.callbacks.onSuccess([{ appId: 'APP-1', appSecret: 'SECRET-1' }]);
    await assert.rejects(pendingA, (error) => {
        assert.equal(error.code, 'OWNER_UNVERIFIED');
        return true;
    });

    const aborted = createQQFake();
    const platformB = await createQQPlatform({ sdk: aborted.sdk, connector: aborted.connector });
    const controller = new AbortController();
    const pendingB = platformB.pair({ signal: controller.signal });
    await flush();
    controller.abort();
    await assert.rejects(pendingB, (error) => error.code === 'ABORTED');
    assert.equal(aborted.state.disposed, 1, 'cancelling must dispose the SDK QR poll');
});

test('QQ pair: the default factory finds startQrConnect in the installed connector, not in the SDK', async () => {
    // The real installed package is the subject here: 1.0.5 of the QQBot SDK
    // exports no startQrConnect, so the factory must lazily import the connector.
    const installed = await import('@tencent-connect/qqbot-connector');
    assert.equal(
        typeof (installed.startQrConnect ?? installed.default?.startQrConnect),
        'function',
        'the installed connector must export startQrConnect',
    );

    // An already-aborted pair must reject after the export check and before the
    // connector is called, so recording any HTTP attempt is a real defect and a
    // guard against a live login escaping from the default factory.
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
        requests += 1;
        throw new Error('no platform request is allowed in tests');
    };

    try {
        const platform = await createQQPlatform();
        const controller = new AbortController();
        controller.abort();

        const phases = [];
        const qrTexts = [];
        await assert.rejects(
            platform.pair({
                signal: controller.signal,
                onQr: (text) => qrTexts.push(text),
                onState: (phase) => phases.push(phase),
            }),
            (error) => {
                assert.equal(error.code, 'ABORTED');
                return true;
            },
        );

        assert.deepEqual(phases, [], 'an aborted pair must not start a QR login');
        assert.deepEqual(qrTexts, [], 'an aborted pair must not display a QR code');
        assert.equal(requests, 0, 'an aborted pair must not reach the platform');
    } finally {
        if (originalFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = originalFetch;
    }
});

test('QQ listen: only the owner private text is emitted, ready fires once, stop on cancel', async () => {
    const { state, sdk, connector } = createQQFake();
    const platform = await createQQPlatform({ sdk, connector });

    const received = [];
    let ready = 0;
    const controller = new AbortController();
    const listening = platform.listen({
        credential: QQ_OWNER,
        onMessage: async (envelope, replyContext) => {
            received.push({ envelope, replyContext });
        },
        onReady: () => {
            ready += 1;
        },
        signal: controller.signal,
    });
    await flush();

    const bot = state.bots[0];
    assert.equal(bot.options.transport, 'websocket');
    assert.equal(bot.options.appId, 'APP-1');

    bot.emit('ready', {});
    bot.emit('ready', {});
    assert.equal(ready, 1, 'the SDK ready event fires onReady exactly once');

    await bot.emit('message', {}, qqOwnerMessage('MSG-1', '你好'));
    await bot.emit('message', {}, qqOwnerMessage('MSG-2', '群里的', { kind: 'group' }));
    await bot.emit('message', {}, qqOwnerMessage('MSG-3', '别人的', { senderId: 'OTHER' }));
    await bot.emit('message', {}, qqOwnerMessage('MSG-4', '伪造的', {
        raw: { id: 'MSG-4', author: { user_openid: 'OTHER', bot: false } },
    }));
    await bot.emit('message', {}, qqOwnerMessage('MSG-5', '', { content: '', msgType: 7 }));
    await bot.emit('message', {}, qqOwnerMessage('MSG-6', '自己发的', { senderIsBot: true }));

    assert.equal(received.length, 1, 'only the owner text message is emitted');
    assert.deepEqual(received[0].envelope, {
        kind: 'private',
        platform: 'qq',
        accountId: 'APP-1',
        conversationId: 'OWN-1',
        senderId: 'OWN-1',
        messageId: 'MSG-1',
        text: '你好',
    });
    assert.deepEqual(received[0].replyContext, { scope: 'c2c', targetId: 'OWN-1', msgId: 'MSG-1' });

    controller.abort();
    await listening;
    assert.equal(bot.stopped, true, 'the bot is stopped when listen ends');
});

test('QQ listen: a silent gateway socket is terminated, one that keeps receiving frames is not', async () => {
    const { EventEmitter } = await import('node:events');
    const { state, sdk, connector } = createQQFake();
    const platform = await createQQPlatform({ sdk, connector, gatewayStaleMs: 60, watchIntervalMs: 10 });
    const controller = new AbortController();
    const listening = platform.listen({ credential: QQ_OWNER, onMessage: async () => {}, signal: controller.signal });
    await flush();

    const socket = () => Object.assign(new EventEmitter(), {
        readyState: 1,
        terminated: 0,
        terminate() { this.terminated += 1; },
    });
    const bot = state.bots[0];
    const alive = socket();
    bot.gateway = { currentWs: alive };
    const beat = setInterval(() => alive.emit('message', '{"op":11}'), 15);
    await new Promise(resolve => setTimeout(resolve, 200));
    clearInterval(beat);
    assert.equal(alive.terminated, 0, 'heartbeat ACKs keep the socket');

    const silent = socket();
    bot.gateway = { currentWs: silent };
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(silent.terminated >= 1, 'a socket silent past the limit is terminated so the SDK reconnects');

    controller.abort();
    await listening;
});

test('QQ listen: an early SDK start still waits for a pending persistence callback', async () => {
    const { state, sdk, connector } = createQQFake();
    const platform = await createQQPlatform({ sdk, connector });

    let release = () => {};
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const persisted = [];

    const listening = platform.listen({
        credential: QQ_OWNER,
        onMessage: async (envelope) => {
            await gate;
            persisted.push(envelope.messageId);
        },
    });
    await flush();
    const bot = state.bots[0];

    const handling = bot.emit('message', {}, qqOwnerMessage('MSG-9', '慢'));
    assert.equal(typeof handling?.then, 'function', 'the SDK handler hands back the persistence promise');

    // The gateway reports its own start as finished while the caller's write is
    // still running: listen must not answer before that write has an owner.
    bot.settle();
    let settled = null;
    listening.then(() => {
        settled = 'resolved';
    }, (error) => {
        settled = error;
    });
    await flush();
    await flush();
    assert.equal(settled, null, 'listen waits for the pending onMessage');
    assert.deepEqual(persisted, [], 'the write had not finished yet');

    release();
    await handling;
    await listening;
    assert.deepEqual(persisted, ['MSG-9']);
    assert.equal(bot.stopped, true);
});

test('QQ listen: a persistence failure is reported even when the connection ends first', async () => {
    const { state, sdk, connector } = createQQFake();
    const platform = await createQQPlatform({ sdk, connector });

    let release = () => {};
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const persistence = new Error('store unavailable');
    const controller = new AbortController();

    const listening = platform.listen({
        credential: QQ_OWNER,
        onMessage: async () => {
            await gate;
            throw persistence;
        },
        signal: controller.signal,
    });
    await flush();
    const bot = state.bots[0];

    const handling = bot.emit('message', {}, qqOwnerMessage('MSG-10', '写不进'));
    controller.abort();
    release();
    await handling;

    await assert.rejects(listening, (error) => {
        assert.equal(error.code, 'MESSAGE_PERSIST_FAILED');
        assert.equal(error.cause, persistence, 'the persistence error stays available as the cause');
        return true;
    });
    assert.equal(bot.stopped, true);
});

test('QQ send: replies to the exact anchor and reports the real platform id', async () => {
    const { state, sdk, connector } = createQQFake();
    const platform = await createQQPlatform({ sdk, connector });

    const controller = new AbortController();
    const listening = platform.listen({
        credential: QQ_OWNER,
        onMessage: () => undefined,
        signal: controller.signal,
    });
    await flush();

    const result = await platform.send({
        credential: QQ_OWNER,
        peerId: 'OWN-1',
        anchor: { scope: 'c2c', targetId: 'OWN-1', msgId: 'MSG-1' },
        text: '收到',
        deliveryId: 'delivery-1',
    });

    assert.deepEqual(result, { kind: 'platform-accepted', platformMessageId: 'SRV-MSG-1', clientId: null });
    assert.equal(state.sendCalls.length, 1);
    assert.deepEqual(state.sendCalls[0].target, { scope: 'c2c', targetId: 'OWN-1', msgId: 'MSG-1' });
    assert.equal(state.sendCalls[0].msgType, 0, 'plain text is sent explicitly');
    assert.equal(state.sendCalls[0].content, '收到');

    // Web addresses go out as written.
    const linked = await platform.send({
        credential: QQ_OWNER,
        peerId: 'OWN-1',
        anchor: { scope: 'c2c', targetId: 'OWN-1', msgId: 'MSG-1' },
        text: '见 https://example.com/a 和 [这篇](https://arxiv.org/pdf/1)',
        deliveryId: 'delivery-2',
    });
    assert.equal(state.sendCalls[1].content, '见 https://example.com/a 和 [这篇](https://arxiv.org/pdf/1)');
    assert.deepEqual(linked, { kind: 'platform-accepted', platformMessageId: 'SRV-MSG-1', clientId: null });

    controller.abort();
    await listening;
});

test('QQ send: a WAV voice is encoded to SILK and sent as a voice media reply; an unreadable one sends nothing', async () => {
    const { state, sdk, connector } = createQQFake();
    const encoded = [];
    const platform = await createQQPlatform({
        sdk,
        connector,
        encodeSilk: async (pcm, sampleRate) => {
            encoded.push({ bytes: pcm.length, sampleRate });
            return { silkBuffer: Buffer.from('SILK'), duration: 100 };
        },
    });
    const controller = new AbortController();
    const listening = platform.listen({ credential: QQ_OWNER, onMessage: () => undefined, signal: controller.signal });
    await flush();
    const uploads = [];
    state.bots[0].uploadMedia = async (options) => {
        uploads.push(options);
        return { file_info: 'FILE-INFO' };
    };

    const pcm = Buffer.alloc(480);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    const anchor = { scope: 'c2c', targetId: 'OWN-1', msgId: 'MSG-1' };

    const result = await platform.send({ credential: QQ_OWNER, peerId: 'OWN-1', anchor, voice: { bytes: Buffer.concat([header, pcm]) } });
    assert.deepEqual(result, { kind: 'platform-accepted', platformMessageId: 'SRV-MSG-1', clientId: null });
    assert.deepEqual(encoded, [{ bytes: 480, sampleRate: 24000 }]);
    assert.equal(uploads[0].fileType, 3, 'MediaFileType.VOICE');
    assert.equal(uploads[0].fileData, Buffer.from('SILK').toString('base64'));
    assert.deepEqual(state.sendCalls[0].media, { file_info: 'FILE-INFO' });

    await assert.rejects(
        platform.send({ credential: QQ_OWNER, peerId: 'OWN-1', anchor, voice: { bytes: Buffer.from('not a wav') } }),
        (error) => error.code === 'VOICE_ENCODE_FAILED' && error.notSent === true,
    );
    assert.equal(state.sendCalls.length, 1, 'nothing is sent when encoding fails');

    controller.abort();
    await listening;
});

test('QQ send: refuses to downgrade the anchor and never mints a message id', async () => {
    const { state, sdk, connector } = createQQFake(() => ({}));
    const platform = await createQQPlatform({ sdk, connector });

    await assert.rejects(platform.send({
        credential: QQ_OWNER,
        peerId: 'OWN-1',
        anchor: { scope: 'c2c', targetId: 'OWN-1', msgId: 'MSG-1' },
        text: 'x',
        deliveryId: 'delivery-1',
    }), (error) => {
        assert.equal(error.notSent, true);
        assert.equal(error.code, 'NO_CONNECTION');
        return true;
    });

    const controller = new AbortController();
    const listening = platform.listen({ credential: QQ_OWNER, onMessage: () => undefined, signal: controller.signal });
    await flush();

    await assert.rejects(platform.send({
        credential: QQ_OWNER,
        peerId: 'OWN-1',
        anchor: { scope: 'c2c', targetId: 'OWN-1' },
        text: 'x',
        deliveryId: 'delivery-1',
    }), (error) => {
        assert.equal(error.notSent, true);
        assert.equal(error.code, 'ANCHOR_MSGID_REQUIRED');
        return true;
    });
    assert.equal(state.sendCalls.length, 0, 'a missing anchor never reaches the SDK');

    await assert.rejects(platform.send({
        credential: QQ_OWNER,
        peerId: 'OWN-1',
        anchor: { scope: 'c2c', targetId: 'OWN-1', msgId: 'MSG-1' },
        text: 'x',
        deliveryId: 'delivery-1',
    }), (error) => {
        assert.equal(error.code, 'UNKNOWN_RESULT');
        assert.notEqual(error.notSent, true, 'the SDK was called, so this is not "not sent"');
        return true;
    });
    assert.equal(state.sendCalls.length, 1);

    controller.abort();
    await listening;
});

test('QQ send: an SDK failure is unknown, only a structured verdict is a rejection', async () => {
    const conflict = createQQFake(() => {
        throw Object.assign(new Error('conflict'), { httpStatus: 409 });
    });
    const platformA = await createQQPlatform({ sdk: conflict.sdk, connector: conflict.connector });
    const controllerA = new AbortController();
    const listeningA = platformA.listen({
        credential: QQ_OWNER,
        onMessage: () => undefined,
        signal: controllerA.signal,
    });
    await flush();

    const request = {
        credential: QQ_OWNER,
        peerId: 'OWN-1',
        anchor: { scope: 'c2c', targetId: 'OWN-1', msgId: 'MSG-1' },
        text: '收到',
        deliveryId: 'delivery-1',
    };

    await assert.rejects(platformA.send(request), (error) => {
        assert.equal(error.code, 'SEND_FAILED');
        assert.equal(error.resultUnknown, true, '409 does not prove the send had no effect');
        assert.notEqual(error.definitelyRejected, true);
        assert.notEqual(error.notSent, true);
        return true;
    });

    controllerA.abort();
    await listeningA;

    const verdict = createQQFake(() => {
        throw Object.assign(new Error('rejected'), { definitelyRejected: true });
    });
    const platformB = await createQQPlatform({ sdk: verdict.sdk, connector: verdict.connector });
    const controllerB = new AbortController();
    const listeningB = platformB.listen({
        credential: QQ_OWNER,
        onMessage: () => undefined,
        signal: controllerB.signal,
    });
    await flush();

    await assert.rejects(platformB.send(request), (error) => {
        assert.equal(error.definitelyRejected, true, 'an explicit verdict is still a rejection');
        assert.notEqual(error.resultUnknown, true);
        assert.notEqual(error.notSent, true);
        return true;
    });

    controllerB.abort();
    await listeningB;
});

// ---------------------------------------------------------------------------
// Weixin development_fake: an injected fetch that answers from a script.
// ---------------------------------------------------------------------------

function abortableHang(signal) {
    return new Promise((resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal === undefined) return;
        if (signal.aborted === true) {
            fail();
            return;
        }
        signal.addEventListener('abort', fail, { once: true });
    });
}

function createWeixinFake(handler) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const call = {
            url: String(url),
            method: init.method ?? 'GET',
            headers: init.headers ?? {},
            body: typeof init.body === 'string' ? init.body : undefined,
            signal: init.signal,
            redirect: init.redirect,
        };
        calls.push(call);
        const answer = await handler(call, calls.length - 1);
        if (answer !== undefined && answer.pending === true) return await abortableHang(call.signal);
        const status = answer?.status ?? 200;
        const text = typeof answer?.body === 'string' ? answer.body : JSON.stringify(answer?.body ?? {});
        return { ok: status >= 200 && status < 300, status, text: async () => text };
    };
    return { fetchImpl, calls };
}

const WEIXIN_OWNER = {
    botToken: 'TOKEN-1',
    botId: 'BOT-1',
    userId: 'USER-1',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
};

function qrAnswer() {
    return { body: { qrcode: 'QR-VALUE', qrcode_img_content: 'https://weixin.qq.com/x/qr?k=QR-VALUE' } };
}

test('Weixin pair: verify code, trusted redirect and confirmed credentials', async () => {
    const statuses = [
        { body: { status: 'wait' } },
        { body: { status: 'need_verifycode' } },
        { body: { status: 'scaned' } },
        { body: { status: 'scaned_but_redirect', redirect_host: 'ilinkai.weixin.qq.com' } },
        {
            body: {
                status: 'confirmed',
                bot_token: 'TOKEN-1',
                ilink_bot_id: 'BOT-1',
                ilink_user_id: 'USER-1',
                baseurl: 'https://ilinkai.weixin.qq.com',
            },
        },
    ];
    const { fetchImpl, calls } = createWeixinFake((call) => {
        if (call.url.includes('get_bot_qrcode')) return qrAnswer();
        const next = statuses.shift();
        assert.ok(next, 'no unexpected status poll');
        return next;
    });
    const sleeps = [];
    const platform = await createWeixinPlatform({
        fetchImpl,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
    });

    const qrTexts = [];
    const phases = [];
    const verifyCalls = [];
    const credentials = await platform.pair({
        onQr: (text) => qrTexts.push(text),
        onState: (phase) => phases.push(phase),
        getVerifyCode: async ({ signal }) => {
            verifyCalls.push(signal !== undefined);
            return '654321';
        },
    });

    assert.deepEqual(qrTexts, ['https://weixin.qq.com/x/qr?k=QR-VALUE'], 'only the platform QR text is shown');
    assert.equal(verifyCalls.length, 1, 'the phone verify code is requested once');
    assert.ok(phases.includes('need_verifycode'));
    assert.ok(phases.includes('redirect'));
    assert.deepEqual(credentials, [{
        platform: 'weixin',
        accountId: 'BOT-1',
        senderId: 'USER-1',
        credential: {
            botToken: 'TOKEN-1',
            botId: 'BOT-1',
            userId: 'USER-1',
            baseUrl: 'https://ilinkai.weixin.qq.com/',
        },
    }]);

    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].redirect, 'error', 'a redirect must never replay the request elsewhere');
    assert.ok(calls[0].url.includes('bot_type=3'));
    assert.deepEqual(JSON.parse(calls[0].body), { local_token_list: [] });

    const firstGet = calls.find((call) => call.method === 'GET');
    assert.equal(firstGet.headers.Authorization, undefined, 'QR polling never carries the bot token');
    assert.equal(firstGet.headers['iLink-App-Id'], 'bot');
    assert.ok(calls.some((call) => call.method === 'GET' && call.url.includes('verify_code=654321')));
    assert.ok(calls.some((call) => call.method === 'GET' && call.url.includes('qrcode=QR-VALUE')));
    assert.ok(sleeps.length > 0, 'polling waits between attempts');
});

test('Weixin pair: missing getVerifyCode and untrusted redirect hosts are explicit failures', async () => {
    const noCode = createWeixinFake((call) => (call.url.includes('get_bot_qrcode')
        ? qrAnswer()
        : { body: { status: 'need_verifycode' } }));
    const platformA = await createWeixinPlatform({ fetchImpl: noCode.fetchImpl, sleep: async () => {} });
    await assert.rejects(platformA.pair({}), (error) => {
        assert.equal(error.code, 'VERIFY_CODE_REQUIRED');
        return true;
    });

    const redirect = createWeixinFake((call) => (call.url.includes('get_bot_qrcode')
        ? qrAnswer()
        : { body: { status: 'scaned_but_redirect', redirect_host: 'evil.example.com' } }));
    const platformB = await createWeixinPlatform({ fetchImpl: redirect.fetchImpl, sleep: async () => {} });
    await assert.rejects(platformB.pair({}), (error) => {
        assert.equal(error.code, 'UNTRUSTED_REDIRECT');
        return true;
    });
});

test('Weixin pair: a confirmation must name the bot and the scanning user', async () => {
    const status = (body) => createWeixinFake((call) => (call.url.includes('get_bot_qrcode')
        ? qrAnswer()
        : { body }));

    const noUser = status({ status: 'confirmed', bot_token: 'T', ilink_bot_id: 'B' });
    const platformA = await createWeixinPlatform({ fetchImpl: noUser.fetchImpl, sleep: async () => {} });
    await assert.rejects(platformA.pair({}), (error) => {
        assert.equal(error.code, 'OWNER_UNVERIFIED');
        return true;
    });

    const noBot = status({ status: 'confirmed', bot_token: 'T', ilink_user_id: 'U' });
    const platformB = await createWeixinPlatform({ fetchImpl: noBot.fetchImpl, sleep: async () => {} });
    await assert.rejects(platformB.pair({}), (error) => {
        assert.equal(error.code, 'LOGIN_INCOMPLETE');
        return true;
    });
});

test('Weixin listen: lossless uint64 id, owner-only text, cursor after persistence', async () => {
    const batches = [
        '{"ret":0,"get_updates_buf":"CURSOR-1","msgs":[{"message_id":18446744073709551615,'
            + '"message_type":1,"message_state":2,"from_user_id":"USER-1","context_token":"CTX-1",'
            + '"item_list":[{"type":1,"text_item":{"text":"你好"}}]}]}',
        '{"ret":0,"get_updates_buf":"CURSOR-2","msgs":['
            + '{"message_id":2,"message_type":1,"message_state":2,"from_user_id":"OTHER",'
            + '"context_token":"CTX-2","item_list":[{"type":1,"text_item":{"text":"别人的"}}]},'
            + '{"message_id":3,"message_type":1,"message_state":2,"from_user_id":"USER-1","group_id":"GROUP-1",'
            + '"context_token":"CTX-3","item_list":[{"type":1,"text_item":{"text":"群"}}]},'
            + '{"message_id":4,"message_type":2,"message_state":2,"from_user_id":"USER-1",'
            + '"item_list":[{"type":1,"text_item":{"text":"bot"}}]},'
            + '{"message_id":5,"message_type":1,"message_state":1,"from_user_id":"USER-1",'
            + '"item_list":[{"type":1,"text_item":{"text":"partial"}}]},'
            + '{"message_id":6,"message_type":1,"message_state":2,"from_user_id":"USER-1",'
            + '"context_token":"CTX-6","item_list":[{"type":2,"image_item":{}}]}'
            + ']}',
    ];
    const { fetchImpl, calls } = createWeixinFake((call, index) => {
        if (index === 0) return { body: batches[0] };
        if (index === 1) return { body: batches[1] };
        return { pending: true };
    });
    const platform = await createWeixinPlatform({ fetchImpl });

    const log = [];
    const envelopes = [];
    let ready = 0;
    const controller = new AbortController();
    const listening = platform.listen({
        credential: WEIXIN_OWNER,
        onMessage: async (envelope, replyContext) => {
            envelopes.push({ envelope, replyContext });
            log.push(`message:${envelope.messageId}:${envelope.text}`);
        },
        onCursor: async (next) => {
            log.push(`cursor:${next}`);
        },
        onReady: () => {
            ready += 1;
        },
        signal: controller.signal,
    });

    await waitFor(() => log.length >= 3, 'both batches');
    controller.abort();
    await listening;

    assert.equal(envelopes.length, 1, 'only the owner text message is emitted');
    assert.equal(envelopes[0].envelope.messageId, '18446744073709551615', 'uint64 is never rounded');
    assert.deepEqual(envelopes[0].envelope, {
        kind: 'private',
        platform: 'weixin',
        accountId: 'BOT-1',
        conversationId: 'USER-1',
        senderId: 'USER-1',
        messageId: '18446744073709551615',
        text: '你好',
    });
    assert.deepEqual(envelopes[0].replyContext, { toUserId: 'USER-1', contextToken: 'CTX-1' });

    assert.deepEqual(log, [
        'message:18446744073709551615:你好',
        'cursor:CURSOR-1',
        'cursor:CURSOR-2',
    ], 'the cursor only moves after onMessage resolved');
    assert.equal(ready, 1, 'onReady fires once, after the first successful getupdates');

    assert.equal(calls[0].headers.Authorization, 'Bearer TOKEN-1');
    assert.deepEqual(JSON.parse(calls[0].body).get_updates_buf, '');
    assert.deepEqual(JSON.parse(calls[1].body).get_updates_buf, 'CURSOR-1');
    assert.equal(JSON.parse(calls[0].body).base_info.channel_version, '2.4.10');
});

test('Weixin listen: an item-level msg_id with omitted type/state is still a real owner message', async () => {
    const batch = '{"ret":0,"get_updates_buf":"CURSOR-I","msgs":['
        + '{"from_user_id":"USER-1","context_token":"CTX-I","item_list":['
        + '{"type":1,"msg_id":9223372036854775807,"text_item":{"text":"item 里的 id"}}]}]}';
    const { fetchImpl } = createWeixinFake((call, index) => (index === 0
        ? { body: batch }
        : { pending: true }));
    const platform = await createWeixinPlatform({ fetchImpl });

    const received = [];
    const cursors = [];
    const controller = new AbortController();
    const listening = platform.listen({
        credential: WEIXIN_OWNER,
        onMessage: async (envelope, replyContext) => {
            received.push({ envelope, replyContext });
        },
        onCursor: (next) => cursors.push(next),
        signal: controller.signal,
    });

    await waitFor(() => cursors.length === 1, 'the item-level id batch');
    controller.abort();
    await listening;

    assert.equal(received.length, 1, 'omitting message_type/message_state does not hide owner text');
    assert.equal(received[0].envelope.messageId, '9223372036854775807', 'the item msg_id is used losslessly');
    assert.equal(received[0].envelope.text, 'item 里的 id');
    assert.deepEqual(received[0].replyContext, { toUserId: 'USER-1', contextToken: 'CTX-I' });
    assert.deepEqual(cursors, ['CURSOR-I'], 'the batch is acknowledged only after onMessage resolved');
});

test('Weixin listen: a rejected getupdates or a failed persistence never advances the cursor', async () => {
    const failing = createWeixinFake(() => ({
        body: '{"ret":-14,"errmsg":"session suspended"}',
    }));
    const platformA = await createWeixinPlatform({ fetchImpl: failing.fetchImpl });
    let messages = 0;
    let cursors = 0;
    let ready = 0;
    await assert.rejects(platformA.listen({
        credential: WEIXIN_OWNER,
        onMessage: () => {
            messages += 1;
        },
        onCursor: () => {
            cursors += 1;
        },
        onReady: () => {
            ready += 1;
        },
    }), (error) => {
        assert.equal(error.code, 'BUSINESS_ERROR');
        assert.equal(error.ret, -14);
        return true;
    });
    assert.deepEqual([messages, cursors, ready], [0, 0, 0], 'a non-zero ret is not an empty success');

    const batch = '{"ret":0,"get_updates_buf":"CURSOR-X","msgs":['
        + '{"message_id":11,"message_type":1,"message_state":2,"from_user_id":"USER-1",'
        + '"context_token":"CTX-11","item_list":[{"type":1,"text_item":{"text":"一"}}]},'
        + '{"message_id":12,"message_type":1,"message_state":2,"from_user_id":"USER-1",'
        + '"context_token":"CTX-12","item_list":[{"type":1,"text_item":{"text":"二"}}]}'
        + ']}';
    const partial = createWeixinFake(() => ({ body: batch }));
    const platformB = await createWeixinPlatform({ fetchImpl: partial.fetchImpl });
    let cursorCalls = 0;
    let seen = 0;
    const persistence = new Error('store unavailable');
    await assert.rejects(platformB.listen({
        credential: WEIXIN_OWNER,
        onMessage: async () => {
            seen += 1;
            if (seen === 2) throw persistence;
        },
        onCursor: () => {
            cursorCalls += 1;
        },
    }), (error) => error === persistence);
    assert.equal(cursorCalls, 0, 'a failed batch keeps the cursor where it was');
    assert.equal(partial.calls.length, 1);
});

test('Weixin listen: a codeless getupdates batch is accepted and acknowledged after persistence', async () => {
    // The official `types.GetUpdatesResp` marks ret/errcode/msgs/get_updates_buf
    // all optional, so a real batch without any business code must not stop the
    // loop that the owner already bound.
    const batch = '{"get_updates_buf":"CURSOR-N","msgs":['
        + '{"message_id":7,"message_type":1,"message_state":2,"from_user_id":"USER-1",'
        + '"context_token":"CTX-7","item_list":[{"type":1,"text_item":{"text":"无码"}}]},'
        + '{"message_id":8,"message_type":1,"message_state":2,"from_user_id":"OTHER",'
        + '"context_token":"CTX-8","item_list":[{"type":1,"text_item":{"text":"别人"}}]}]}';
    const { fetchImpl } = createWeixinFake((call, index) => (index === 0
        ? { body: batch }
        : { pending: true }));
    const platform = await createWeixinPlatform({ fetchImpl });

    const log = [];
    const received = [];
    let ready = 0;
    const controller = new AbortController();
    const listening = platform.listen({
        credential: WEIXIN_OWNER,
        onMessage: async (envelope, replyContext) => {
            received.push({ envelope, replyContext });
            log.push(`message:${envelope.messageId}`);
        },
        onCursor: async (next) => {
            log.push(`cursor:${next}`);
        },
        onReady: () => {
            ready += 1;
        },
        signal: controller.signal,
    });

    await waitFor(() => log.length >= 2, 'the codeless batch');
    controller.abort();
    await listening;

    assert.equal(ready, 1, 'a codeless payload with a real msgs array is confirmed');
    assert.equal(received.length, 1, 'the owner filter is unchanged');
    assert.equal(received[0].envelope.messageId, '7', 'the id stays lossless');
    assert.equal(received[0].envelope.text, '无码');
    assert.deepEqual(received[0].replyContext, { toUserId: 'USER-1', contextToken: 'CTX-7' });
    assert.deepEqual(log, ['message:7', 'cursor:CURSOR-N'], 'the cursor still moves only after onMessage resolved');
});

test('Weixin listen: codeless empty batches and a bare cursor are confirmed, not rejected', async () => {
    const batches = [
        '{"get_updates_buf":"CURSOR-E","msgs":[]}',
        '{"get_updates_buf":""}',
        '{"ret":0,"errcode":0,"msgs":[]}',
    ];
    const { fetchImpl, calls } = createWeixinFake((call, index) => (index < batches.length
        ? { body: batches[index] }
        : { pending: true }));
    const platform = await createWeixinPlatform({ fetchImpl });

    const received = [];
    const cursors = [];
    let ready = 0;
    const controller = new AbortController();
    const listening = platform.listen({
        credential: WEIXIN_OWNER,
        onMessage: (envelope) => received.push(envelope),
        onCursor: (next) => cursors.push(next),
        onReady: () => {
            ready += 1;
        },
        signal: controller.signal,
    });

    await waitFor(() => calls.length >= batches.length + 1, 'the empty batches and the held poll');
    controller.abort();
    await listening;

    assert.equal(ready, 1, 'an empty codeless batch still proves the adapter is live');
    assert.deepEqual(received, [], 'an empty batch has no message');
    assert.deepEqual(cursors, ['CURSOR-E'], 'an empty-string cursor never overwrites the saved one');
});

test('Weixin listen: control-only answers keep waiting on the same cursor before the real batch', async () => {
    // `{}` or a bare `longpolling_timeout_ms` proves the server answered but
    // not that a message arrived: the loop must sleep one interval and poll
    // the same cursor again, never firing ready, a message or a cursor.
    const messages = [];
    const cursors = [];
    let ready = 0;

    const { fetchImpl, calls } = createWeixinFake((call, index) => {
        if (index === 0) return { body: '{}' };
        if (index === 1) return { body: '{"longpolling_timeout_ms":1000}' };
        if (index === 2) {
            return {
                body: '{"get_updates_buf":"CURSOR-F","msgs":[{"message_id":9,"message_type":1,'
                    + '"message_state":2,"from_user_id":"USER-1","context_token":"CTX-9",'
                    + '"item_list":[{"type":1,"text_item":{"text":"后到"}}]}]}',
            };
        }
        return { pending: true };
    });

    const sleeps = [];
    const snapshots = [];
    const platform = await createWeixinPlatform({
        fetchImpl,
        pollIntervalMs: 40,
        sleep: async (ms) => {
            sleeps.push(ms);
            snapshots.push([ready, messages.length, cursors.length]);
        },
    });

    const controller = new AbortController();
    const listening = platform.listen({
        credential: WEIXIN_OWNER,
        onMessage: (envelope) => messages.push(envelope),
        onCursor: (next) => cursors.push(next),
        onReady: () => {
            ready += 1;
        },
        signal: controller.signal,
    });

    await waitFor(() => cursors.length >= 1, 'the batch after the control-only answers');
    controller.abort();
    await listening;

    assert.equal(calls.length >= 3, true, 'both unconfirmed answers were followed by another poll');
    assert.deepEqual(sleeps.slice(0, 2), [40, 40], 'each unconfirmed answer waits one poll interval');
    assert.deepEqual(
        snapshots.slice(0, 2),
        [[0, 0, 0], [0, 0, 0]],
        'no ready, no message and no cursor before the real batch',
    );
    assert.deepEqual(messages.map((envelope) => envelope.messageId), ['9'], 'only the real batch is delivered');
    assert.deepEqual(cursors, ['CURSOR-F'], 'the cursor moves once, after persistence');
    assert.equal(ready, 1, 'ready fires exactly once, only for the confirmed batch');
});

test('Weixin listen: malformed, unknown or non-zero getupdates answers never become ready or a batch', async () => {
    const cases = [
        // `{}` and control-only answers are not failures: they keep waiting,
        // covered by the positive test above.
        ['{"unexpected":true}', 'BUSINESS_UNCONFIRMED'],
        ['{"longpolling_timeout_ms":"1000"}', 'INVALID_RESPONSE'],
        ['{"longpolling_timeout_ms":-1}', 'INVALID_RESPONSE'],
        ['{"longpolling_timeout_ms":1000,"unexpected":true}', 'BUSINESS_UNCONFIRMED'],
        ['{"errmsg":5}', 'INVALID_RESPONSE'],
        ['{"ret":-14,"errmsg":"session suspended"}', 'BUSINESS_ERROR'],
        ['{"errcode":-2}', 'BUSINESS_ERROR'],
        ['{"ret":"0"}', 'INVALID_RESPONSE'],
        ['{"ret":0,"msgs":"nope"}', 'INVALID_RESPONSE'],
        ['{"ret":0,"msgs":[null]}', 'INVALID_RESPONSE'],
        ['{"errcode":0,"msgs":[1,2]}', 'INVALID_RESPONSE'],
        ['{"get_updates_buf":5}', 'INVALID_RESPONSE'],
        ['[]', 'INVALID_RESPONSE'],
    ];

    for (const [body, code] of cases) {
        const { fetchImpl, calls } = createWeixinFake(() => ({ body }));
        const platform = await createWeixinPlatform({ fetchImpl });
        let messages = 0;
        let cursors = 0;
        let ready = 0;
        await assert.rejects(platform.listen({
            credential: WEIXIN_OWNER,
            onMessage: () => {
                messages += 1;
            },
            onCursor: () => {
                cursors += 1;
            },
            onReady: () => {
                ready += 1;
            },
        }), (error) => {
            assert.equal(error.code, code, `${body} -> ${code}`);
            if (code === 'BUSINESS_ERROR') {
                assert.ok(Number.isFinite(error.ret) || Number.isFinite(error.errcode), 'the code is reported');
            }
            return true;
        });
        assert.deepEqual([messages, cursors, ready], [0, 0, 0], `${body} is never a batch`);
        assert.equal(calls.length, 1, `${body} stops at the first poll`);
    }
});

test('Weixin send: business codes decide the outcome, and the delivery id is the client id', async () => {
    const answers = [
        { body: { ret: -14, errmsg: 'suspended' } },
        { body: { ret: 0, errmsg: '' } },
        { body: {} },
    ];
    const { fetchImpl, calls } = createWeixinFake(() => answers.shift() ?? { body: { ret: 0 } });
    const platform = await createWeixinPlatform({ fetchImpl });

    const request = {
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1', contextToken: 'CTX-1' },
        text: '收到',
        deliveryId: 'delivery-1',
    };

    const rejection = await platform.send(request).then(() => null, (error) => error);
    assert.ok(rejection, 'a non-zero ret is a failure');
    assert.equal(rejection.definitelyRejected, true);
    assert.notEqual(rejection.notSent, true);
    assert.ok(rejection.message.includes('TOKEN-1') === false, 'errors never carry the bot token');

    const accepted = await platform.send(request);
    assert.deepEqual(accepted, {
        kind: 'platform-accepted',
        platformMessageId: null,
        clientId: 'delivery-1',
    });

    const emptySuccess = await platform.send(request);
    assert.deepEqual(emptySuccess, {
        kind: 'platform-accepted',
        platformMessageId: null,
        clientId: 'delivery-1',
    });

    const body = JSON.parse(calls[0].body);
    assert.equal(calls[0].headers.Authorization, 'Bearer TOKEN-1');
    assert.equal(calls[0].url.endsWith('/ilink/bot/sendmessage'), true);
    assert.equal(body.msg.to_user_id, 'USER-1');
    assert.equal(body.msg.client_id, 'delivery-1');
    assert.equal(body.msg.message_type, 2);
    assert.equal(body.msg.message_state, 2);
    assert.equal(body.msg.context_token, 'CTX-1');
    assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '收到' } }]);
    assert.equal(body.base_info.channel_version, '2.4.10');
});

test('Weixin send: an absent business code is the official plain success, whatever the optional string errmsg says', async () => {
    const request = {
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1', contextToken: 'CTX-1' },
        text: '收到',
        deliveryId: 'delivery-1',
    };

    const accepted = [
        ['{}', null],
        ['{"errmsg":""}', null],
        ['{"errmsg":"ok"}', null],
        ['{"errmsg":"send failed"}', null],
        ['{"ret":0}', null],
        ['{"errcode":0}', null],
        ['{"message_id":"MID-1"}', 'MID-1'],
        ['{"msg_id":"MID-2","errmsg":""}', 'MID-2'],
        ['{"msg":{"message_id":"MID-3"}}', 'MID-3'],
        ['{"message_id":18446744073709551615}', '18446744073709551615'],
    ];

    for (const [body, id] of accepted) {
        const { fetchImpl, calls } = createWeixinFake(() => ({ body }));
        const platform = await createWeixinPlatform({ fetchImpl });
        assert.deepEqual(await platform.send(request), {
            kind: 'platform-accepted',
            platformMessageId: id,
            clientId: 'delivery-1',
        }, body);
        assert.equal(calls.length, 1, body);
    }

    const unconfirmed = [
        ['{"unexpected":true}', 'UNKNOWN_RESULT'],
        ['{"errmsg":5}', 'UNKNOWN_RESULT'],
        ['{"message_id":""}', 'UNKNOWN_RESULT'],
        ['{"message_id":{"a":1}}', 'UNKNOWN_RESULT'],
        ['{"msg":{"message_id":""}}', 'UNKNOWN_RESULT'],
        ['{"msg":{}}', 'UNKNOWN_RESULT'],
        ['{"msg":{"unexpected":true}}', 'UNKNOWN_RESULT'],
        ['{"ret":"0"}', 'UNKNOWN_RESULT'],
        ['{"ret":0,"errcode":"0"}', 'UNKNOWN_RESULT'],
        ['{"ret":null}', 'UNKNOWN_RESULT'],
        ['null', 'UNKNOWN_RESULT'],
        ['[]', 'UNKNOWN_RESULT'],
        ['0', 'UNKNOWN_RESULT'],
        ['not json', 'INVALID_RESPONSE'],
    ];

    for (const [body, code] of unconfirmed) {
        const { fetchImpl } = createWeixinFake(() => ({ body }));
        const platform = await createWeixinPlatform({ fetchImpl });
        await assert.rejects(platform.send(request), (error) => {
            assert.equal(error.code, code, body);
            if (code === 'UNKNOWN_RESULT') assert.equal(error.resultUnknown, true, body);
            assert.notEqual(error.notSent, true, body);
            assert.notEqual(error.definitelyRejected, true, body);
            return true;
        });
    }

    const rejected = ['{"ret":-14}', '{"errcode":40001}', '{"ret":-1,"errcode":"0"}'];

    for (const body of rejected) {
        const { fetchImpl } = createWeixinFake(() => ({ body }));
        const platform = await createWeixinPlatform({ fetchImpl });
        await assert.rejects(platform.send(request), (error) => {
            assert.equal(error.code, 'SEND_REJECTED', body);
            assert.equal(error.definitelyRejected, true, body);
            assert.notEqual(error.notSent, true, body);
            return true;
        });
    }
});

test('Weixin send: HTTP 408/409 are not safe failures, a non-zero ret still is a rejection', async () => {
    const request = {
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1', contextToken: 'CTX-1' },
        text: '收到',
        deliveryId: 'delivery-1',
    };

    for (const status of [408, 409, 429, 500]) {
        const { fetchImpl } = createWeixinFake(() => ({ status, body: { ret: 0 } }));
        const platform = await createWeixinPlatform({ fetchImpl });
        await assert.rejects(platform.send(request), (error) => {
            assert.equal(error.code, 'HTTP_STATUS');
            assert.notEqual(error.notSent, true, `HTTP ${status} does not prove nothing was sent`);
            assert.notEqual(error.definitelyRejected, true, `HTTP ${status} is not a platform verdict`);
            assert.equal(error.resultUnknown, true);
            return true;
        });
    }

    const business = createWeixinFake(() => ({ body: { ret: -14, errmsg: 'suspended' } }));
    const platform = await createWeixinPlatform({ fetchImpl: business.fetchImpl });
    await assert.rejects(platform.send(request), (error) => {
        assert.equal(error.definitelyRejected, true, 'a non-zero business code is still a rejection');
        assert.notEqual(error.notSent, true);
        return true;
    });
});

test('Weixin send: an unanchored or misaddressed reply fails before any request', async () => {
    const { fetchImpl, calls } = createWeixinFake(() => ({ body: { ret: 0 } }));
    const platform = await createWeixinPlatform({ fetchImpl });

    await assert.rejects(platform.send({
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1' },
        text: 'x',
        deliveryId: 'delivery-1',
    }), (error) => {
        assert.equal(error.notSent, true);
        assert.equal(error.code, 'CONTEXT_TOKEN_REQUIRED');
        return true;
    });

    await assert.rejects(platform.send({
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { contextToken: 'CTX-1' },
        text: 'x',
        deliveryId: 'delivery-1',
    }), (error) => {
        assert.equal(error.notSent, true);
        assert.equal(error.code, 'ANCHOR_TARGET_REQUIRED');
        return true;
    });

    await assert.rejects(platform.send({
        credential: WEIXIN_OWNER,
        peerId: 'SOMEONE-ELSE',
        anchor: { toUserId: 'SOMEONE-ELSE', contextToken: 'CTX-1' },
        text: 'x',
        deliveryId: 'delivery-1',
    }), (error) => {
        assert.equal(error.notSent, true);
        assert.equal(error.code, 'PEER_NOT_OWNER');
        return true;
    });

    await assert.rejects(platform.send({
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1', contextToken: 'CTX-1' },
        text: 'x',
    }), (error) => {
        assert.equal(error.notSent, true);
        assert.equal(error.code, 'DELIVERY_ID_REQUIRED');
        return true;
    });

    await assert.rejects(platform.send({
        credential: { ...WEIXIN_OWNER, baseUrl: 'https://evil.example.com/' },
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1', contextToken: 'CTX-1' },
        text: 'x',
        deliveryId: 'delivery-1',
    }), (error) => {
        assert.equal(error.notSent, true);
        assert.equal(error.code, 'BASE_URL_UNTRUSTED');
        return true;
    });

    assert.equal(calls.length, 0, 'no request leaves for an unanchored reply');
});
