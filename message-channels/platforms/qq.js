/**
 * QQ platform adapter — a thin layer over Tencent's official QQ bot SDK.
 *
 * Only `pair` / `listen` / `send` live here: no host, no runtime, no session
 * store, no model logic. Importing this module and calling
 * `createQQPlatform()` neither logs in nor opens a socket; every network
 * effect happens inside `pair`, `listen` or `send`.
 *
 * Adapted from the official Tencent QQ bot SDK
 * (`@tencent-connect/qqbot-nodejs` 1.0.5 and its connector package
 * `@tencent-connect/qqbot-connector` 1.2.0, MIT, Copyright (C) Tencent): the
 * `startQrConnect` callback contract, the `QQBot` facade
 * (`start`/`stop`/`send`/`sendText`), `MsgType.TEXT === 0` and the
 * `InboundMessage` shape follow that package's published types.
 * See THIRD_PARTY_NOTICES.md at the repository root for the full notice.
 *
 * Delivery here is at-most-once, not exactly-once. The SDK's gateway advances
 * its own `lastSeq` / session snapshot before it notifies a listener and does
 * not await that listener's business work, so its cursor says nothing about
 * what this adapter's caller has persisted: a crash inside a callback can lose
 * an event the gateway already treats as delivered. This adapter provides no
 * application-level acknowledgement and cannot replay what the gateway does
 * not offer again.
 *
 * @module @loveandbeepbrother/dsh-galatea-channels/platforms/qq
 */

import { inboundImageOf, pcmOfWav } from '../media.js';

const PLATFORM = 'qq';
const C2C_EVENT_TYPE = 'C2C_MESSAGE_CREATE';
const QR_SOURCE = 'dsh';

/** `MsgType.TEXT` — plain text (QQBot.d.ts: `readonly TEXT: 0`). */
const MSG_TYPE_TEXT = 0;

/** `MsgType.MEDIA` — rich media reference from `uploadMedia` (QQBot.d.ts: msg_type 7). */
const MSG_TYPE_MEDIA = 7;

/** `MediaFileType.IMAGE`, `MediaFileType.VOICE` and `MediaFileType.FILE` (protocol/types.d.ts). */
const MEDIA_FILE_TYPE_IMAGE = 1;
const MEDIA_FILE_TYPE_VOICE = 3;
const MEDIA_FILE_TYPE_FILE = 4;

/** Bound on one inbound image download. */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

const SDK_SPECIFIER = '@tencent-connect/qqbot-nodejs';

/** QQ voice messages are SILK; the SDK's encoder needs the `silk-wasm` peer, a dependency of this package. */
const SDK_PROTOCOL_SPECIFIER = '@tencent-connect/qqbot-nodejs/protocol';

async function officialSilkEncoder(pcm, sampleRate) {
    const { pcmToSilk } = await import(SDK_PROTOCOL_SPECIFIER);
    return pcmToSilk(pcm, sampleRate);
}

/**
 * The QR-login entry point does not live in the QQBot SDK package: installed
 * `@tencent-connect/qqbot-nodejs` 1.0.5 exports no `startQrConnect`. That export
 * belongs to the connector package, so `pair` imports this one instead.
 */
const CONNECTOR_SPECIFIER = '@tencent-connect/qqbot-connector';

/** A gateway socket with no frame for this long is dead: about three missed heartbeat ACKs. */
const GATEWAY_STALE_MS = 150_000;
const WATCH_INTERVAL_MS = 30_000;
const WEBSOCKET_OPEN = 1;

/** Cached dynamic imports: resolved at most once, and never at module load. */
let sdkModulePromise = null;
let connectorModulePromise = null;

function loadOfficialSdk() {
    if (sdkModulePromise === null) {
        sdkModulePromise = import(SDK_SPECIFIER).catch((error) => {
            // A failed install must be retryable, so it does not poison the cache.
            sdkModulePromise = null;
            throw error;
        });
    }
    return sdkModulePromise;
}

function loadOfficialConnector() {
    if (connectorModulePromise === null) {
        connectorModulePromise = import(CONNECTOR_SPECIFIER).catch((error) => {
            // Same rule as the SDK: a later install may work, so no poisoned cache.
            connectorModulePromise = null;
            throw error;
        });
    }
    return connectorModulePromise;
}

/**
 * Read `startQrConnect` out of an imported connector module.
 *
 * A CommonJS package reaches an ESM importer either as named exports (when
 * Node's cjs-module-lexer can see them) or only under `default`, so both shapes
 * are accepted. Returns null when the module exposes no such function.
 */
function pickStartQrConnect(module) {
    if (module === null || (typeof module !== 'object' && typeof module !== 'function')) return null;
    const candidates = [
        module.startQrConnect,
        module.default?.startQrConnect,
        module.connector?.startQrConnect,
        module.default?.connector?.startQrConnect,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'function') return candidate;
    }
    return null;
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function platformError(code, message, extra) {
    const error = new Error(message);
    error.name = 'QqPlatformError';
    error.code = code;
    error.isPlatformError = true;
    if (extra !== undefined) Object.assign(error, extra);
    return error;
}

/** A failure raised before the SDK was asked to do anything. */
function notSentError(code, message) {
    return platformError(code, message, { notSent: true });
}

function abortError() {
    const error = platformError('ABORTED', 'QQ operation was cancelled');
    error.name = 'AbortError';
    return error;
}

/**
 * Deliver a caller callback. A callback that throws must not derail the
 * protocol flow it was observing, so its error is dropped.
 */
function invokeCallback(callback, value) {
    if (typeof callback !== 'function') return;
    try {
        callback(value);
    } catch {
        // Intentionally ignored: observers never own the protocol.
    }
}

/**
 * A logger with no output at all: the SDK would otherwise be free to log
 * tokens, app secrets or raw payloads. Dropping SDK diagnostics is preferable
 * to leaking credentials.
 */
function createQuietLogger() {
    const quiet = () => {};
    const logger = {
        debug: quiet,
        info: quiet,
        warn: quiet,
        error: quiet,
        trace: quiet,
        fatal: quiet,
    };
    logger.child = () => logger;
    return logger;
}

function assertCredential(credential, options) {
    const make = options !== undefined && options.notSent === true ? notSentError : platformError;
    if (credential === null || typeof credential !== 'object') {
        throw make('CREDENTIAL_INVALID', 'QQ credential is required');
    }
    if (!isNonEmptyString(credential.appId)) {
        throw make('CREDENTIAL_INVALID', 'QQ credential.appId is required');
    }
    if (!isNonEmptyString(credential.appSecret)) {
        throw make('CREDENTIAL_INVALID', 'QQ credential.appSecret is required');
    }
    if (!isNonEmptyString(credential.userOpenid)) {
        // Without the scanning owner there is no one a private reply may
        // legitimately be addressed to.
        throw platformError('OWNER_UNVERIFIED', 'QQ credential has no scanning user openid');
    }
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (isNonEmptyString(value)) return value;
    }
    return null;
}

/** The id QQ uses when this sent message is quoted later (`ref_msg_idx` on the inbound side). */
function refIdxOf(response) {
    const refIdx = firstNonEmptyString(response?.ext_info?.ref_idx, response?.refIdx);
    return refIdx === null ? {} : { refIdx };
}

/**
 * The message this one quotes, from the raw gateway event: `message_scene.ext` carries
 * `ref_msg_idx=<idx>`, and `msg_elements` carries what the platform shows for it.
 * @returns {{refIdx: string, text?: string, image?: string|true}|null}
 */
export function quoteOfRaw(raw) {
    const ext = raw?.message_scene?.ext;
    const entry = Array.isArray(ext) ? ext.find(item => typeof item === 'string' && item.startsWith('ref_msg_idx=')) : undefined;
    if (entry === undefined) return null;
    const refIdx = entry.slice('ref_msg_idx='.length);
    if (refIdx === '') return null;
    const elements = Array.isArray(raw.msg_elements) ? raw.msg_elements : [];
    const element = elements.find(item => item?.msg_idx === refIdx) ?? elements[0];
    const text = typeof element?.content === 'string' ? element.content.trim() : '';
    const attachment = Array.isArray(element?.attachments) ? element.attachments[0] : undefined;
    return {
        refIdx,
        ...text === '' ? {} : { text },
        ...attachment === undefined ? {} : { image: firstNonEmptyString(attachment?.filename) ?? true },
    };
}

/**
 * Map one SDK inbound message to our envelope, or null when it must not be
 * emitted. The identity of the sender is taken from the untouched gateway
 * event, never from a middleware-mutated field, so a rewritten `senderId`
 * cannot make someone else's message look like the owner's.
 */
function mapInbound(message, credential) {
    if (message === null || typeof message !== 'object') return null;
    if (message.kind !== 'c2c') return null;
    if (message.senderIsBot === true) return null;
    const imageUrls = imageUrlsOf(message.attachments);
    if (typeof message.msgType === 'number' && message.msgType !== MSG_TYPE_TEXT && imageUrls.length === 0) return null;
    if (typeof message.rawEventType === 'string' && message.rawEventType !== C2C_EVENT_TYPE) return null;

    const raw = message.raw;
    if (raw === null || typeof raw !== 'object') return null;
    if (raw.author !== null && typeof raw.author === 'object' && raw.author.bot === true) return null;

    const owner = credential.userOpenid;
    const rawSender = raw.author === null || typeof raw.author !== 'object' ? null : raw.author.user_openid;
    const replyTarget = message.replyTarget === null || typeof message.replyTarget !== 'object'
        ? null
        : message.replyTarget;
    const targetId = replyTarget === null ? null : replyTarget.targetId;

    if (rawSender !== owner) return null;
    if (message.senderId !== owner) return null;
    if (targetId !== owner) return null;
    if (replyTarget.scope !== undefined && replyTarget.scope !== 'c2c') return null;

    const messageId = firstNonEmptyString(raw.id, message.messageId);
    if (messageId === null) return null;

    const content = typeof message.content === 'string' ? message.content : '';
    // An image-only message arrives with blank content; text-only messages keep their exact text.
    const text = imageUrls.length > 0 && content.trim() === '' ? '' : content;
    if (text === '' && imageUrls.length === 0) return null;
    const quote = quoteOfRaw(raw);

    return {
        envelope: {
            kind: 'private',
            platform: PLATFORM,
            accountId: credential.appId,
            conversationId: owner,
            senderId: owner,
            messageId,
            text,
            ...quote === null ? {} : { quote },
        },
        imageUrls,
        replyContext: { scope: 'c2c', targetId: owner, msgId: messageId },
    };
}

/** Image attachment URLs of one inbound message, normalized to https. */
function imageUrlsOf(attachments) {
    if (!Array.isArray(attachments)) return [];
    const urls = [];
    for (const attachment of attachments) {
        if (attachment === null || typeof attachment !== 'object') continue;
        if (typeof attachment.content_type !== 'string' || !attachment.content_type.startsWith('image/')) continue;
        if (!isNonEmptyString(attachment.url)) continue;
        const url = attachment.url.trim();
        urls.push(/^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`);
    }
    return urls;
}

/**
 * Download the images of one mapped message into `envelope.images`. A failed or
 * unsupported image is not dropped silently: the text says so.
 */
async function attachImages(mapped, fetchImpl) {
    if (mapped.imageUrls.length === 0) return mapped.envelope;
    const images = [];
    let failed = 0;
    for (const url of mapped.imageUrls) {
        try {
            const response = await fetchImpl(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const image = inboundImageOf(new Uint8Array(await response.arrayBuffer()));
            if (image === null) throw new Error('unsupported image');
            images.push(image);
        } catch {
            failed += 1;
        }
    }
    const note = failed > 0 ? `[${failed} 张图片接收失败]` : '';
    const text = [mapped.envelope.text, note].filter(part => part !== '').join('\n');
    if (text === '' && images.length === 0) return null;
    return { ...mapped.envelope, text, images };
}

/**
 * Was this send failure a verdict from the platform rather than an unknown
 * outcome?
 *
 * Only a structured marker counts. An HTTP status proves nothing once the
 * request was issued - 408 and 409 in particular are returned for requests the
 * platform may already have acted on - and the QQ SDK publishes no such
 * marker, so anything its `send` throws stays unknown.
 */
function isDefiniteRejection(error) {
    return error !== null && typeof error === 'object' && error.definitelyRejected === true;
}

/**
 * Create the QQ platform adapter.
 *
 * @param {object} [options]
 * @param {object} [options.sdk] Injected SDK module (`{ QQBot, MsgType }`);
 *     used by tests. When absent the official package is imported on first use.
 * @param {object} [options.connector] Injected connector module
 *     (`{ startQrConnect }`). When neither it nor `options.sdk` is given, the
 *     official connector package is imported by the first `pair`; nothing is
 *     imported at module load or at factory creation.
 * @param {typeof fetch} [options.fetchImpl] downloads inbound image attachments (tests inject it)
 * @param {(pcm: Buffer, sampleRate: number) => Promise<{ silkBuffer: Buffer }>} [options.encodeSilk]
 *     encodes outbound voice; tests inject it, the default is the SDK's `pcmToSilk`
 * @param {number} [options.gatewayStaleMs] a gateway socket silent this long is terminated
 * @param {number} [options.watchIntervalMs] how often the gateway socket is checked
 * @returns {Promise<{ pair: Function, listen: Function, send: Function }>}
 */
export async function createQQPlatform(options = {}) {
    if (options === null || typeof options !== 'object') {
        throw platformError('INVALID_OPTIONS', 'createQQPlatform options must be an object');
    }

    const injectedSdk = options.sdk;
    const injectedConnector = options.connector;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const encodeSilk = options.encodeSilk ?? officialSilkEncoder;
    const gatewayStaleMs = options.gatewayStaleMs ?? GATEWAY_STALE_MS;
    const watchIntervalMs = options.watchIntervalMs ?? WATCH_INTERVAL_MS;

    /** accountId (AppID) -> QQBot. Private to this factory, never shared. */
    const bots = new Map();

    async function resolveSdk() {
        let sdk = injectedSdk;
        if (sdk === null || sdk === undefined) {
            try {
                sdk = await loadOfficialSdk();
            } catch (error) {
                throw platformError(
                    'SDK_UNAVAILABLE',
                    `QQ adapter cannot load ${SDK_SPECIFIER}`,
                    { cause: error },
                );
            }
        }
        const QQBot = sdk.QQBot ?? sdk.default?.QQBot;
        const MsgType = sdk.MsgType ?? sdk.default?.MsgType;
        return { QQBot, MsgType };
    }

    /**
     * The QR-login function to pair with, or null when nothing exports one.
     *
     * Kept separate from `resolveSdk` so `pair` never loads the QQBot SDK, which
     * only `listen` and `send` need. An injected module is used exactly as given:
     * when injection was requested and the export is missing, `pair` reports
     * SDK_MISSING_EXPORT rather than silently falling back to the real package
     * and opening a live login.
     */
    async function resolveConnector() {
        const injected = pickStartQrConnect(injectedConnector) ?? pickStartQrConnect(injectedSdk);
        if (injected !== null) return injected;

        const injectedNothing = (injectedConnector === null || injectedConnector === undefined)
            && (injectedSdk === null || injectedSdk === undefined);
        if (injectedNothing === false) return null;

        let connector;
        try {
            connector = await loadOfficialConnector();
        } catch (error) {
            throw platformError(
                'SDK_UNAVAILABLE',
                `QQ adapter cannot load ${CONNECTOR_SPECIFIER}`,
                { cause: error },
            );
        }
        return pickStartQrConnect(connector);
    }

    /**
     * Log in by QR code and return the scanned owner's credentials.
     *
     * The QR payload is handed to `onQr` only: nothing is printed to a console
     * and nothing is persisted. Cancelling disposes the SDK poll.
     *
     * @param {object} [params]
     * @param {AbortSignal} [params.signal]
     * @param {(text: string) => void} [params.onQr]
     * @param {(phase: string) => void} [params.onState]
     * @param {(params: { signal?: AbortSignal }) => (string|Promise<string>)} [params.getVerifyCode]
     *     Unused by QQ; accepted so both platforms share one surface.
     * @returns {Promise<Array<{platform: string, accountId: string, senderId: string, credential: object}>>}
     */
    async function pair(params = {}) {
        const { signal, onQr, onState } = params;
        const startQrConnect = await resolveConnector();
        if (typeof startQrConnect !== 'function') {
            throw platformError('SDK_MISSING_EXPORT', 'the QQ connector does not export startQrConnect');
        }
        if (signal?.aborted === true) throw abortError();

        return await new Promise((resolve, reject) => {
            let settled = false;
            let dispose = null;

            const finish = (settle, value) => {
                if (settled) return;
                settled = true;
                if (signal !== undefined) signal.removeEventListener('abort', onAbort);
                if (typeof dispose === 'function') {
                    try {
                        dispose();
                    } catch {
                        // Disposal is best effort; the outcome is already decided.
                    }
                }
                settle(value);
            };

            const onAbort = () => finish(reject, abortError());

            const callbacks = {
                onQrDisplayed(url) {
                    if (settled) return;
                    invokeCallback(onState, 'qr-ready');
                    if (isNonEmptyString(url)) invokeCallback(onQr, url);
                },
                onQrExpired() {
                    if (settled) return;
                    invokeCallback(onState, 'qr-expired');
                },
                onFailure(error) {
                    invokeCallback(onState, 'failed');
                    const failure = platformError('PAIR_FAILED', 'QQ QR login failed', { cause: error });
                    finish(reject, failure);
                },
                onSuccess(credentials) {
                    if (settled) return;
                    const entries = Array.isArray(credentials) ? credentials : [];
                    const verified = entries.filter((entry) => entry !== null
                        && typeof entry === 'object'
                        && isNonEmptyString(entry.appId)
                        && isNonEmptyString(entry.appSecret)
                        // The scanning user must be reported by the platform;
                        // it is never inferred from the first inbound message.
                        && isNonEmptyString(entry.userOpenid));
                    if (verified.length === 0) {
                        invokeCallback(onState, 'failed');
                        finish(reject, platformError(
                            'OWNER_UNVERIFIED',
                            'QQ QR login did not report the scanning user openid',
                        ));
                        return;
                    }
                    invokeCallback(onState, 'confirmed');
                    finish(resolve, verified.map((entry) => ({
                        platform: PLATFORM,
                        accountId: entry.appId,
                        senderId: entry.userOpenid,
                        credential: {
                            appId: entry.appId,
                            appSecret: entry.appSecret,
                            userOpenid: entry.userOpenid,
                        },
                    })));
                },
            };

            try {
                dispose = startQrConnect(callbacks, {
                    displayQrCodeToConsole: false,
                    source: QR_SOURCE,
                    ...(signal === undefined ? {} : { signal }),
                });
            } catch (error) {
                finish(reject, platformError('PAIR_FAILED', 'QQ QR login could not start', { cause: error }));
                return;
            }

            if (signal !== undefined) {
                if (signal.aborted === true) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    /**
     * Receive private messages from the scanned owner until cancelled.
     *
     * Only complete, plain-text, 1:1 messages whose untouched gateway event
     * names the owner are emitted. Groups, the bot's own messages, other
     * people's chats and non-text payloads are skipped without emitting.
     *
     * @param {object} params
     * @param {object} params.credential `{ appId, appSecret, userOpenid }`
     * @param {string} [params.cursor] Ignored: the QQ gateway resumes by itself.
     * @param {(envelope: object, replyContext: object) => Promise<void>} params.onMessage
     * @param {(next: string) => (void|Promise<void>)} [params.onCursor] Unused: QQ has no cursor.
     * @param {(info: { platform: string, accountId: string }) => void} [params.onReady]
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<void>} resolves on cancellation, rejects on failure.
     *     It settles only after every `onMessage` this loop started has
     *     finished: the SDK's gateway cursor is not an acknowledgement that the
     *     caller persisted anything.
     */
    async function listen(params = {}) {
        const { credential, onMessage, onReady, signal } = params;
        assertCredential(credential);
        if (typeof onMessage !== 'function') {
            throw platformError('ONMESSAGE_REQUIRED', 'listen requires onMessage(envelope, replyContext)');
        }
        if (signal?.aborted === true) return;

        const { QQBot } = await resolveSdk();
        if (typeof QQBot !== 'function') {
            throw platformError('SDK_MISSING_EXPORT', 'the QQ SDK does not export QQBot');
        }

        const accountId = credential.appId;
        if (bots.has(accountId)) {
            throw platformError('ALREADY_LISTENING', 'a listen loop is already active for this account');
        }

        const bot = new QQBot({
            appId: credential.appId,
            appSecret: credential.appSecret,
            accountId,
            transport: 'websocket',
            logger: createQuietLogger(),
        });
        bots.set(accountId, bot);

        let readyFired = false;
        let stopping = false;
        let persistenceFailure = null;
        /** Persistence callbacks this loop started and has not yet awaited. */
        const pending = new Set();

        const fireReady = () => {
            if (readyFired) return;
            readyFired = true;
            invokeCallback(onReady, { platform: PLATFORM, accountId });
        };

        const stopBot = () => {
            try {
                bot.stop();
            } catch {
                // A failing stop must not mask the error that caused it.
            }
        };

        /** Let every persistence callback this loop started reach an outcome. */
        const drainPending = async () => {
            while (pending.size > 0) {
                await Promise.allSettled([...pending]);
            }
        };

        const handleMessage = (ctx, message) => {
            if (stopping === true || signal?.aborted === true || persistenceFailure !== null) return;
            const mapped = mapInbound(message, credential);
            if (mapped === null) return;

            // The caller persists the envelope before this resolves. The work is
            // tracked here because the SDK's await of this handler is not an
            // acknowledgement: its gateway has already moved its own cursor on,
            // so a callback still running when `start` ends would otherwise be
            // left without an owner. A persistence failure stops the connection
            // and is reported upward; it is never swallowed, and the message is
            // not blindly replayed either.
            const persisted = (async () => {
                try {
                    const envelope = await attachImages(mapped, fetchImpl);
                    if (envelope === null) return;
                    await onMessage(envelope, mapped.replyContext);
                } catch (error) {
                    if (persistenceFailure === null) {
                        persistenceFailure = error ?? new Error('onMessage rejected');
                    }
                    stopBot();
                }
            })();
            pending.add(persisted);
            const forget = () => {
                pending.delete(persisted);
            };
            persisted.then(forget, forget);
            return persisted;
        };

        // No SDK messageFilter is installed on purpose: filtering happens here
        // and only here, so a rejected message is never marked seen before the
        // caller has persisted it.
        bot.on('ready', fireReady);
        bot.on('message', handleMessage);

        // The SDK sends heartbeats but never checks that the gateway answers them,
        // so a socket that died with a network change stays "open" until TCP gives
        // up. Any frame counts as life (heartbeat ACKs come
        // every ~40 s); a silent socket is terminated, and the SDK reconnects and
        // RESUMEs from its last sequence.
        let watched = null;
        let lastFrameAt = Date.now();
        const watchdog = setInterval(() => {
            const ws = bot.gateway?.currentWs;
            if (ws === undefined || ws === null) return;
            if (ws !== watched) {
                watched = ws;
                lastFrameAt = Date.now();
                const touch = () => {
                    if (watched === ws) lastFrameAt = Date.now();
                };
                ws.on('message', touch);
                ws.on('pong', touch);
                return;
            }
            if (ws.readyState === WEBSOCKET_OPEN && Date.now() - lastFrameAt > gatewayStaleMs) {
                lastFrameAt = Date.now();
                ws.terminate();
            }
        }, watchIntervalMs);
        watchdog.unref?.();

        let startFailure = null;
        try {
            // `start` is the long-running Promise. The signal only ends this
            // bot's own connection; it never touches the process-wide agent.
            await bot.start(signal);
        } catch (error) {
            startFailure = error ?? new Error('QQ bot start failed');
        }

        // `start` returning or failing ends intake, but it does not end ownership
        // of the callbacks already running: those are real writes. Only once they
        // have settled does this loop clear its map and report an outcome.
        clearInterval(watchdog);
        stopping = true;
        stopBot();
        await drainPending();
        bots.delete(accountId);

        if (persistenceFailure !== null) {
            // A failed persistence is what the runtime must surface; the
            // disconnect that followed is only its consequence.
            throw platformError(
                'MESSAGE_PERSIST_FAILED',
                'QQ onMessage did not complete; the listener stopped to avoid losing the message',
                { cause: persistenceFailure },
            );
        }
        if (startFailure !== null) throw startFailure;
    }

    /**
     * Send one plain-text passive reply to the exact anchored message.
     *
     * The reply is never downgraded: no proactive push, no "latest chat"
     * fallback, no retry of an unknown outcome.
     *
     * @param {object} params
     * @param {object} params.credential `{ appId, appSecret, userOpenid }`
     * @param {string} params.peerId the owner's openid
     * @param {{ scope?: string, targetId?: string, msgId?: string }} params.anchor
     *     the replyContext of the inbound message being answered
     * @param {string} params.text
     * @param {string} [params.deliveryId] QQ has no client id; kept for symmetry.
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ kind: 'platform-accepted', platformMessageId: string, clientId: null }>}
     */
    async function send(params = {}) {
        const { credential, peerId, anchor, text, image, file, voice } = params;
        assertCredential(credential, { notSent: true });

        const accountId = credential.appId;
        const bot = bots.get(accountId);
        if (bot === undefined) {
            throw notSentError(
                'NO_CONNECTION',
                'no QQ connection for this account; listen() must be running in this factory',
            );
        }
        if (!isNonEmptyString(peerId)) {
            throw notSentError('PEER_REQUIRED', 'send requires peerId');
        }
        if (peerId !== credential.userOpenid) {
            throw notSentError('PEER_NOT_OWNER', 'QQ replies are only sent to the scanning owner');
        }
        if (anchor === null || typeof anchor !== 'object') {
            throw notSentError('ANCHOR_REQUIRED', 'send requires the inbound replyContext as anchor');
        }
        if (anchor.scope !== undefined && anchor.scope !== 'c2c') {
            throw notSentError('ANCHOR_SCOPE_INVALID', 'QQ anchor must be a c2c reply target');
        }
        if (!isNonEmptyString(anchor.targetId) || anchor.targetId !== peerId) {
            throw notSentError('ANCHOR_TARGET_MISMATCH', 'QQ anchor targetId does not match peerId');
        }
        if (!isNonEmptyString(anchor.msgId)) {
            throw notSentError(
                'ANCHOR_MSGID_REQUIRED',
                'QQ passive reply requires the original inbound message id; refusing to send proactively',
            );
        }
        const hasImage = image !== null && typeof image === 'object' && image.bytes instanceof Uint8Array;
        const hasFile = file !== null && typeof file === 'object' && file.bytes instanceof Uint8Array;
        const hasVoice = voice !== null && typeof voice === 'object' && voice.bytes instanceof Uint8Array;
        if (!hasImage && !hasFile && !hasVoice && (typeof text !== 'string' || text === '')) {
            throw notSentError('TEXT_REQUIRED', 'send requires non-empty text');
        }

        const target = { scope: 'c2c', targetId: peerId, msgId: anchor.msgId };
        if (hasImage) return sendMedia(bot, target, { fileType: MEDIA_FILE_TYPE_IMAGE, fileData: Buffer.from(image.bytes).toString('base64') });
        // Files go to the SDK as a buffer: it switches to chunked upload from 5MB on.
        if (hasFile) return sendMedia(bot, target, { fileType: MEDIA_FILE_TYPE_FILE, buffer: Buffer.from(file.bytes), fileName: file.name });
        if (hasVoice) return sendMedia(bot, target, { fileType: MEDIA_FILE_TYPE_VOICE, fileData: await silkOf(voice.bytes) });
        const useUniversalSend = typeof bot.send === 'function';
        const useSendText = typeof bot.sendText === 'function';
        if (useUniversalSend === false && useSendText === false) {
            throw notSentError('SDK_SEND_UNSUPPORTED', 'the QQ bot exposes neither send() nor sendText()');
        }

        let response;
        try {
            response = useUniversalSend === true
                ? await bot.send({ target, msgType: MSG_TYPE_TEXT, content: text })
                : await bot.sendText(target, text);
        } catch (error) {
            const failure = platformError('SEND_FAILED', 'QQ send failed', { cause: error });
            if (isDefiniteRejection(error)) {
                failure.definitelyRejected = true;
            } else {
                // The SDK call may have reached the platform: the outcome is
                // unknown, and retrying would risk a duplicate. No status range
                // is used to narrow this; only a structured verdict is.
                failure.resultUnknown = true;
            }
            throw failure;
        }

        const platformMessageId = firstNonEmptyString(response?.id);
        if (platformMessageId === null) {
            // Never invent an id: without the platform's own id the delivery
            // cannot be acknowledged, so the outcome is reported as unknown.
            throw platformError(
                'UNKNOWN_RESULT',
                'QQ accepted the request without returning a message id',
                { resultUnknown: true },
            );
        }

        return { kind: 'platform-accepted', platformMessageId, clientId: null, ...refIdxOf(response) };
    }

    /** A 16-bit mono WAV as base64 SILK. Nothing has been sent when this fails. */
    async function silkOf(wavBytes) {
        let encoded;
        try {
            const { pcm, sampleRate } = pcmOfWav(wavBytes);
            encoded = await encodeSilk(pcm, sampleRate);
        } catch (error) {
            throw notSentError('VOICE_ENCODE_FAILED', 'QQ voice could not be encoded as SILK; nothing was sent', { cause: error });
        }
        if (!(encoded?.silkBuffer instanceof Uint8Array) || encoded.silkBuffer.length === 0) {
            throw notSentError('VOICE_ENCODE_FAILED', 'the SILK encoder returned no data; nothing was sent');
        }
        return Buffer.from(encoded.silkBuffer).toString('base64');
    }

    /**
     * Upload one image, voice or file and send it as a passive rich-media reply. A
     * failed upload sends nothing, so it is reported as not sent; the send that
     * follows keeps the same unknown-outcome rule as text.
     */
    async function sendMedia(bot, target, source) {
        if (typeof bot.uploadMedia !== 'function' || typeof bot.send !== 'function') {
            throw notSentError('SDK_MEDIA_UNSUPPORTED', 'the QQ bot exposes no uploadMedia()/send() for media');
        }
        let upload;
        try {
            upload = await bot.uploadMedia({ target, ...source, srvSendMsg: false });
        } catch (error) {
            throw notSentError('MEDIA_UPLOAD_FAILED', 'QQ media upload failed; nothing was sent', { cause: error });
        }
        if (!isNonEmptyString(upload?.file_info)) {
            throw notSentError('MEDIA_UPLOAD_INVALID', 'QQ media upload returned no file_info; nothing was sent');
        }
        let response;
        try {
            response = await bot.send({ target, msgType: MSG_TYPE_MEDIA, media: { file_info: upload.file_info } });
        } catch (error) {
            const failure = platformError('SEND_FAILED', 'QQ media send failed', { cause: error });
            if (isDefiniteRejection(error)) failure.definitelyRejected = true;
            else failure.resultUnknown = true;
            throw failure;
        }
        const platformMessageId = firstNonEmptyString(response?.id);
        if (platformMessageId === null) {
            throw platformError('UNKNOWN_RESULT', 'QQ accepted the media without returning a message id', { resultUnknown: true });
        }
        return { kind: 'platform-accepted', platformMessageId, clientId: null, ...refIdxOf(response) };
    }

    return { pair, listen, send, ...QQ_DELIVERY };
}

/**
 * 发送能力（渠道运行态按它选路，不看平台名）：能发的内容种类；现在能不能主动发给这个对话——官方机器人只能被动回复，
 * 借对方最近一条消息还剩的回复次数（窗口内），至少要剩 `repliesNeeded`（默认 1）次；发不了时内容留到对方下一条消息之后再发。
 */
export const QQ_DELIVERY = Object.freeze({
    sends: Object.freeze(['text', 'image', 'file', 'voice']),
    holdsUntilNextMessage: true,
    replyLimit: 4,
    replyLimitLabel: 'QQ',
    canDeliverNow: ({ live, repliesLeft, repliesNeeded = 1 }) => live === true && repliesLeft >= Math.max(repliesNeeded, 1),
});

export default createQQPlatform;
