/**
 * Tencent Weixin (iLink bot) platform adapter — protocol only.
 *
 * Only `pair` / `listen` / `send` live here: no host, no runtime, no session
 * store, no model logic, and none of the media / CDN / typing / logging
 * modules the reference client ships. Importing this module and calling
 * `createWeixinPlatform()` neither logs in nor opens a socket; every network
 * effect happens inside `pair`, `listen` or `send`.
 *
 * Adapted from:
 *  - `@tencent-weixin/openclaw-weixin` (MIT, Copyright (C) 2026 Tencent),
 *    revision 874637a0: the HTTP/JSON protocol (headers, `base_info`, QR status
 *    names, `getupdates`/`sendmessage` bodies), `parseWeixinApiJson` and
 *    `classifyFetchError` from `src/api/api.ts`, and the QR transition rules
 *    from `src/auth/login-qr.ts` (three-code refresh budget, verify-code
 *    lifecycle, IDC redirect).
 *  - `wangx-wx/dsh-channel-wechat` (MIT), revision 0d9ae409: the split between
 *    a plain HTTP transport and the login state handling (`src/wechat/api.ts`,
 *    `src/wechat/login-machine.ts`), including the trailing-slash base URL
 *    normalisation and the "abandoning a held long poll keeps its socket"
 *    note.
 * See THIRD_PARTY_NOTICES.md at the repository root for the full notice.
 *
 * @module @loveandbeepbrother/dsh-galatea-channels/platforms/weixin
 */

import { createHash, randomBytes } from 'node:crypto';
import { aesEcbPaddedSize, decryptAesEcb, encryptAesEcb, inboundImageOf, weixinImageKey } from '../media.js';

const PLATFORM = 'weixin';
/** 对方最近一条消息的上下文多久内能主动发。 */
const CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Media CDN of the reference client (src/auth/accounts.ts). */
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** `MessageItemType.IMAGE`/`FILE` and `UploadMediaType.IMAGE`/`FILE` (src/api/types.ts). */
const ITEM_TYPE_IMAGE = 2;
const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const ITEM_TYPE_FILE = 4;
const UPLOAD_MEDIA_TYPE_FILE = 3;

/** Bound on one CDN image download or upload. */
const MEDIA_TIMEOUT_MS = 60_000;
/** Credentials and QR redirects may only point at this host or its subdomains. */
const TRUSTED_HOST = 'weixin.qq.com';
/** Protocol source version: `channel_version` and the client-version header. */
const DEFAULT_CHANNEL_VERSION = '2.4.10';
const BOT_TYPE = 3;
const ILINK_APP_ID = 'bot';
const DEFAULT_BOT_AGENT = 'dsh-channels';

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
/** Long-poll deadline for `getupdates` (the server may hold the request). */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_PAIR_TIMEOUT_MS = 300000;
/** How many QR codes one login may consume before giving up. */
const MAX_QR_REFRESH_COUNT = 3;

/** uint64 identifiers that must be quoted before `JSON.parse` sees them. */
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

/** `WeixinMessage.message_type` of a user message; 2 is the bot's own echo. */
const MESSAGE_TYPE_USER = 1;
/** `WeixinMessage.message_state` of a finished message; 1 is still generating. */
const MESSAGE_STATE_FINISH = 2;

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function platformError(code, message, extra) {
    const error = new Error(message);
    error.name = 'WeixinPlatformError';
    error.code = code;
    error.isPlatformError = true;
    if (extra !== undefined) Object.assign(error, extra);
    return error;
}

/** A failure raised before any request left the process. */
function notSentError(code, message, extra) {
    return platformError(code, message, { ...(extra === undefined ? {} : extra), notSent: true });
}

function abortError() {
    const error = platformError('ABORTED', 'weixin operation was cancelled');
    error.name = 'AbortError';
    return error;
}

/** Deliver a caller callback; an observer that throws never owns the flow. */
function invokeCallback(callback, value) {
    if (typeof callback !== 'function') return;
    try {
        callback(value);
    } catch {
        // Intentionally ignored.
    }
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (isNonEmptyString(value)) return value;
    }
    return null;
}

/**
 * Whether a `sendmessage` body without a business code is the plain success the
 * official client accepts: `{}`, an optional string `errmsg` (optional metadata,
 * never parsed: the business code, not the wording, decides failure), and the
 * optional `message_id` the API may return. Any other field, or a non-string
 * `errmsg`, leaves the outcome unconfirmed.
 */
function isEmptySendSuccess(parsed) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    for (const [key, value] of Object.entries(parsed)) {
        if (key === 'errmsg' && typeof value === 'string') continue;
        if ((key === 'message_id' || key === 'msg_id') && isNonEmptyString(value)) continue;
        if (key === 'msg' && value !== null && typeof value === 'object' && Array.isArray(value) === false) {
            const nested = Object.entries(value);
            if (nested.length === 1 && nested.every(([nestedKey, nestedValue]) => nestedKey === 'message_id' && isNonEmptyString(nestedValue))) {
                continue;
            }
        }
        return false;
    }
    return true;
}

function positiveNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function defaultSleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Encode a dotted version as the protocol's `0x00MMNNPP` integer.
 *
 * Adapted from @tencent-weixin/openclaw-weixin `src/api/api.ts` (MIT,
 * Copyright (C) 2026 Tencent).
 */
function buildClientVersion(version) {
    const parts = String(version).split('.').map((part) => Number.parseInt(part, 10));
    const major = Number.isNaN(parts[0]) ? 0 : (parts[0] ?? 0);
    const minor = Number.isNaN(parts[1]) ? 0 : (parts[1] ?? 0);
    const patch = Number.isNaN(parts[2]) ? 0 : (parts[2] ?? 0);
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** Collapse the observable bot agent into something safe for the wire. */
function normalizeBotAgent(raw) {
    const trimmed = raw?.trim() ?? '';
    return trimmed === '' ? DEFAULT_BOT_AGENT : trimmed.slice(0, 256);
}

/**
 * Build the `base_info` block carried by every protocol request.
 *
 * Adapted from @tencent-weixin/openclaw-weixin `src/api/api.ts` (MIT,
 * Copyright (C) 2026 Tencent) and `dsh-channel-wechat/src/wechat/api.ts`.
 */
function buildBaseInfo(options) {
    return {
        channel_version: options.channelVersion,
        bot_agent: normalizeBotAgent(options.botAgent),
    };
}

/**
 * `X-WECHAT-UIN`: a random uint32 rendered as its decimal string, base64'd.
 *
 * Adapted from @tencent-weixin/openclaw-weixin `src/api/api.ts` (MIT,
 * Copyright (C) 2026 Tencent).
 */
function randomWechatUin() {
    const uint32 = randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), 'utf8').toString('base64');
}

/** Headers shared by GET and POST requests (never the bot token). */
function buildCommonHeaders(options) {
    const headers = {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(buildClientVersion(options.channelVersion)),
    };
    if (isNonEmptyString(options.routeTag)) headers.SKRouteTag = options.routeTag.trim();
    return headers;
}

/**
 * Classify a transport failure for diagnostics that carry no URL and no body.
 *
 * Adapted from @tencent-weixin/openclaw-weixin `src/api/api.ts` (MIT,
 * Copyright (C) 2026 Tencent) and `dsh-channel-wechat/src/wechat/api.ts`.
 */
function classifyFetchError(error) {
    if (error instanceof Error && error.name === 'AbortError') {
        return { type: 'timeout', description: 'request timeout' };
    }
    const causeValue = error === null || typeof error !== 'object' ? undefined : error.cause;
    const code = causeValue?.code;
    const text = `${String(causeValue ?? error ?? '')} ${String(typeof code === 'string' ? code : '')}`;
    const withCode = typeof code === 'string' ? { code } : {};
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/iu.test(text)) {
        return { type: 'dns', description: 'DNS resolution failed', ...withCode };
    }
    if (/ECONNREFUSED/iu.test(text)) {
        return { type: 'tcp', description: 'TCP connection refused', ...withCode };
    }
    if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/iu.test(text)) {
        return { type: 'tcp', description: 'TCP connection timeout or unreachable', ...withCode };
    }
    if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/iu.test(text)) {
        return { type: 'tls', description: 'TLS handshake error', ...withCode };
    }
    return { type: 'unknown', description: 'network request failed' };
}

/**
 * Validate a base URL or redirect target before any credential is sent to it.
 *
 * Only `https` on the default port, with no embedded credentials, under
 * `weixin.qq.com`, is accepted — a server-supplied address must not be able to
 * redirect the bot token somewhere else.
 *
 * @param {string} rawUrl candidate base URL
 * @param {string} label diagnostic label, never the URL itself
 * @returns {string} normalised base URL with a trailing slash
 */
function trustedBaseUrl(rawUrl, label) {
    if (!isNonEmptyString(rawUrl)) {
        throw platformError('BASE_URL_INVALID', `${label} is required`);
    }
    let url;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        throw platformError('BASE_URL_INVALID', `${label} is not a valid URL`);
    }
    if (url.protocol !== 'https:') {
        throw platformError('BASE_URL_UNTRUSTED', `${label} must use https`);
    }
    if (url.username !== '' || url.password !== '') {
        throw platformError('BASE_URL_UNTRUSTED', `${label} must not carry credentials`);
    }
    if (url.port !== '') {
        throw platformError('BASE_URL_UNTRUSTED', `${label} must use the default https port`);
    }
    const host = url.hostname.toLowerCase();
    if (host !== TRUSTED_HOST && host.endsWith(`.${TRUSTED_HOST}`) === false) {
        throw platformError('BASE_URL_UNTRUSTED', `${label} must stay under ${TRUSTED_HOST}`);
    }
    url.search = '';
    url.hash = '';
    return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/**
 * Quote uint64 message identifiers before `JSON.parse` sees them.
 *
 * Copied from @tencent-weixin/openclaw-weixin `src/api/api.ts` (MIT,
 * Copyright (C) 2026 Tencent). The scanner only rewrites real object
 * properties, never text inside JSON strings, so an id such as
 * 18446744073709551615 survives as a string instead of losing precision.
 */
export function parseWeixinApiJson(rawText) {
    let output = '';
    let index = 0;
    while (index < rawText.length) {
        if (rawText[index] !== '"') {
            output += rawText[index++];
            continue;
        }

        const stringStart = index;
        index++;
        let escaped = false;
        while (index < rawText.length) {
            const char = rawText[index++];
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                break;
            }
        }
        const stringToken = rawText.slice(stringStart, index);
        output += stringToken;

        let cursor = index;
        while (/\s/.test(rawText[cursor] ?? '')) cursor++;
        if (rawText[cursor] !== ':') continue;

        let key;
        try {
            key = JSON.parse(stringToken);
        } catch {
            continue;
        }
        if (typeof key !== 'string' || LOSSLESS_ID_FIELDS.has(key) === false) continue;

        output += rawText.slice(index, cursor + 1);
        cursor++;
        while (/\s/.test(rawText[cursor] ?? '')) {
            output += rawText[cursor++];
        }
        const numberStart = cursor;
        if (rawText[cursor] === '-') cursor++;
        while (/\d/.test(rawText[cursor] ?? '')) cursor++;
        if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
            output += `"${rawText.slice(numberStart, cursor)}"`;
            index = cursor;
        } else {
            index = numberStart;
        }
    }
    return JSON.parse(output);
}

/**
 * Combine the text items of one inbound message.
 *
 * @param {unknown} itemList `item_list` of a `WeixinMessage`
 * @returns {string|null} the composed text, or null when the message carries
 *     no text (a non-text message must be skipped, not emitted empty).
 */
function collectText(itemList) {
    if (Array.isArray(itemList) === false) return null;
    const parts = [];
    for (const item of itemList) {
        if (item === null || typeof item !== 'object') continue;
        if (item.type !== 1) continue;
        const text = item.text_item?.text;
        if (typeof text === 'string') parts.push(text);
    }
    if (parts.length === 0) return null;
    const joined = parts.join('');
    return joined === '' ? null : joined;
}

/**
 * Image items (`type: 2`) of one inbound message that carry a CDN reference.
 * Adapted from @tencent-weixin/openclaw-weixin's `downloadMediaFromItem`
 * (src/media/media-download.ts, MIT, Copyright (C) 2026 Tencent).
 */
function collectImageItems(itemList) {
    if (Array.isArray(itemList) === false) return [];
    return itemList
        .filter(item => item !== null && typeof item === 'object' && item.type === ITEM_TYPE_IMAGE)
        .map(item => item.image_item)
        .filter(image => image !== null && typeof image === 'object'
            && (isNonEmptyString(image.media?.encrypt_query_param) || isNonEmptyString(image.media?.full_url)));
}

/** A CDN URL from the server or our own base: https on a qq.com host only. */
function trustedCdnUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'qq.com' && !url.hostname.endsWith('.qq.com')) return null;
    return url.toString();
}

/**
 * The provider message id, with the reference reader's precedence: a real
 * top-level id first, then the `msg_id` of the first item that carries one.
 *
 * Item-level ids are a normal modern wire shape; ignoring them would reject a
 * valid owner message and stall the cursor. Values stay lossless strings, and
 * no id is ever derived from `seq` or from a random value.
 *
 * Adapted from @tencent-weixin/openclaw-weixin's `getWeixinMessageId`
 * (tencent-weixin-inbound.ts:202, MIT, Copyright (C) 2026 Tencent).
 */
function getWeixinMessageId(message) {
    const topLevel = firstNonEmptyString(message.message_id, message.msg_id, message.svr_id);
    if (topLevel !== null) return topLevel;
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        const itemId = firstNonEmptyString(item.msg_id);
        if (itemId !== null) return itemId;
    }
    return null;
}

/**
 * Map one `WeixinMessage` to our envelope, or null when it must be skipped.
 *
 * Only user messages (`message_type` absent or 1) that are finished
 * (`message_state` absent or 2), from the scanned owner in a 1:1 chat, are
 * emitted. Both fields are optional on the wire: the reference reader only
 * drops an explicit bot type or an explicit generating state, and requiring
 * them would silently lose ordinary owner text. An explicit 2 for the type, an
 * explicit 1 (or any other value) for the state, and any unknown explicit value
 * are still skipped.
 *
 * @throws when the message is from the owner but carries no id: emitting a
 *     minted id or advancing the cursor past it would lose the message.
 */
/**
 * The message this one quotes: an item's `ref_msg`. `message_item.msg_id` is the platform id of the
 * quoted message; the text is often absent.
 * @returns {{platformMessageId?: string, text?: string, image?: true}|null}
 */
export function quoteOfItems(itemList) {
    if (!Array.isArray(itemList)) return null;
    const ref = itemList.find(item => item?.ref_msg !== null && typeof item?.ref_msg === 'object')?.ref_msg;
    if (ref === undefined) return null;
    const item = ref.message_item;
    const id = item?.msg_id;
    const text = [ref.title, item?.text_item?.text].find(value => isNonEmptyString(value));
    return {
        ...isNonEmptyString(id) ? { platformMessageId: id } : {},
        ...text === undefined ? {} : { text },
        ...item?.image_item !== undefined && item?.image_item !== null ? { image: true } : {},
    };
}

function mapInbound(message, credential) {
    if (message === null || typeof message !== 'object') return null;
    if (message.message_type !== undefined && message.message_type !== MESSAGE_TYPE_USER) return null;
    if (message.message_state !== undefined && message.message_state !== MESSAGE_STATE_FINISH) return null;
    if (isNonEmptyString(message.group_id)) return null;
    if (message.from_user_id !== credential.userId) return null;

    const messageId = getWeixinMessageId(message);
    if (messageId === null) {
        throw platformError(
            'MESSAGE_ID_MISSING',
            'weixin inbound message from the owner has no message id; refusing to emit or advance the cursor',
        );
    }

    const text = collectText(message.item_list);
    const imageItems = collectImageItems(message.item_list);
    if (text === null && imageItems.length === 0) return null;

    const owner = credential.userId;
    const quote = quoteOfItems(message.item_list);
    return {
        envelope: {
            kind: 'private',
            platform: PLATFORM,
            accountId: credential.botId,
            conversationId: owner,
            senderId: owner,
            messageId,
            text: text ?? '',
            ...quote === null ? {} : { quote },
        },
        imageItems,
        replyContext: {
            toUserId: owner,
            contextToken: typeof message.context_token === 'string' ? message.context_token : '',
        },
    };
}

function assertCredential(credential, options) {
    const make = options !== undefined && options.notSent === true ? notSentError : platformError;
    if (credential === null || typeof credential !== 'object') {
        throw make('CREDENTIAL_INVALID', 'weixin credential is required');
    }
    if (!isNonEmptyString(credential.botToken)) {
        throw make('CREDENTIAL_INVALID', 'weixin credential.botToken is required');
    }
    if (!isNonEmptyString(credential.botId)) {
        throw make('CREDENTIAL_INVALID', 'weixin credential.botId is required');
    }
    if (!isNonEmptyString(credential.userId)) {
        throw platformError('OWNER_UNVERIFIED', 'weixin credential has no scanning user');
    }
}

/**
 * Either every business code in the payload is 0, or the call failed. A
 * response carrying no code at all is not treated as an empty success.
 */
function assertBusinessSuccess(parsed, label) {
    const ret = parsed?.ret;
    const errcode = parsed?.errcode;
    const codes = [];
    if (typeof ret === 'number') codes.push(`ret=${ret}`);
    if (typeof errcode === 'number') codes.push(`errcode=${errcode}`);
    if (codes.length === 0) {
        throw platformError('BUSINESS_UNCONFIRMED', `${label}: response carries no business code`);
    }
    if ((typeof ret === 'number' && ret !== 0) || (typeof errcode === 'number' && errcode !== 0)) {
        throw platformError('BUSINESS_ERROR', `${label}: ${codes.join(' ')}`, { ret, errcode });
    }
}

/**
 * `getupdates` may omit its business code: the current `types.GetUpdatesResp`
 * marks `ret`, `errcode`, `msgs` and `get_updates_buf` all optional, and the
 * reference client only rejects an explicitly non-zero code. So a missing code
 * is confirmed by a real batch (a `msgs` array or a `get_updates_buf` string)
 * instead of being refused.
 *
 * Returns `true` when the answer proves an explicit zero code or a real batch.
 * Returns `false` for a body with no code and no batch that is a plain `{}` or
 * carries only the optional control fields `longpolling_timeout_ms` / `errmsg`:
 * the server was reachable, yet nothing says a message arrived, so the caller
 * keeps waiting on the same cursor. `false` is *not* business success - it only
 * means "poll again". Any other unknown-only body is still
 * `BUSINESS_UNCONFIRMED`. Field types are checked here because the HTTP and
 * JSON layers are already done by `request` / `readJson`.
 */
function assertGetUpdatesSuccess(parsed) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw platformError('INVALID_RESPONSE', 'getupdates: response is not a JSON object');
    }

    const hasRet = parsed.ret !== undefined;
    const hasErrcode = parsed.errcode !== undefined;
    const ret = parsed.ret;
    const errcode = parsed.errcode;
    if ((hasRet && !(typeof ret === 'number' && Number.isFinite(ret)))
        || (hasErrcode && !(typeof errcode === 'number' && Number.isFinite(errcode)))) {
        throw platformError('INVALID_RESPONSE', 'getupdates: business code is not a finite number');
    }
    if ((hasRet && ret !== 0) || (hasErrcode && errcode !== 0)) {
        const codes = [];
        if (hasRet) codes.push(`ret=${ret}`);
        if (hasErrcode) codes.push(`errcode=${errcode}`);
        throw platformError('BUSINESS_ERROR', `getupdates: ${codes.join(' ')}`, { ret, errcode });
    }

    const hasMsgs = parsed.msgs !== undefined;
    if (hasMsgs) {
        if (Array.isArray(parsed.msgs) === false) {
            throw platformError('INVALID_RESPONSE', 'getupdates: msgs is not an array');
        }
        for (const message of parsed.msgs) {
            if (message === null || typeof message !== 'object' || Array.isArray(message)) {
                throw platformError('INVALID_RESPONSE', 'getupdates: msgs entry is not an object');
            }
        }
    }
    const hasBuf = parsed.get_updates_buf !== undefined;
    if (hasBuf && typeof parsed.get_updates_buf !== 'string') {
        throw platformError('INVALID_RESPONSE', 'getupdates: get_updates_buf is not a string');
    }

    if (hasRet === true || hasErrcode === true || hasMsgs === true || hasBuf === true) {
        return true;
    }

    // No code and no batch: a reachable server with nothing to deliver is not a
    // business success, so the caller keeps polling the same cursor.
    const controlFields = ['longpolling_timeout_ms', 'errmsg'];
    if (Object.keys(parsed).every((key) => controlFields.includes(key))) {
        if (parsed.longpolling_timeout_ms !== undefined) {
            const timeout = parsed.longpolling_timeout_ms;
            if (!(typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0)) {
                throw platformError('INVALID_RESPONSE', 'getupdates: longpolling_timeout_ms is not a finite non-negative number');
            }
        }
        if (parsed.errmsg !== undefined && typeof parsed.errmsg !== 'string') {
            throw platformError('INVALID_RESPONSE', 'getupdates: errmsg is not a string');
        }
        return false;
    }

    throw platformError(
        'BUSINESS_UNCONFIRMED',
        'getupdates: response carries neither a business code nor a batch',
    );
}

/**
 * Create the Weixin platform adapter.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injected transport (tests)
 * @param {(ms: number) => Promise<void>} [options.sleep] injected delay
 * @param {string} [options.baseUrl] must be an https `weixin.qq.com` endpoint
 * @param {string} [options.channelVersion] defaults to the protocol version
 * @param {string} [options.botAgent] observable marker, sanitised before use
 * @param {string} [options.routeTag] optional `SKRouteTag` deployment tag
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.longPollTimeoutMs] 30-40s per `getupdates`
 * @param {number} [options.pollIntervalMs] QR status poll interval
 * @param {number} [options.pairTimeoutMs] overall QR login budget
 * @returns {Promise<{ pair: Function, listen: Function, send: Function }>}
 */
export async function createWeixinPlatform(options = {}) {
    if (options === null || typeof options !== 'object') {
        throw platformError('INVALID_OPTIONS', 'createWeixinPlatform options must be an object');
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw platformError('FETCH_UNAVAILABLE', 'createWeixinPlatform requires a fetch implementation');
    }
    const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
    const channelVersion = isNonEmptyString(options.channelVersion)
        ? options.channelVersion
        : DEFAULT_CHANNEL_VERSION;
    const botAgent = isNonEmptyString(options.botAgent) ? options.botAgent : DEFAULT_BOT_AGENT;
    const routeTag = isNonEmptyString(options.routeTag) ? options.routeTag : '';
    const requestTimeoutMs = positiveNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const longPollTimeoutMs = positiveNumber(options.longPollTimeoutMs, DEFAULT_LONG_POLL_TIMEOUT_MS);
    const pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    const pairTimeoutMs = positiveNumber(options.pairTimeoutMs, DEFAULT_PAIR_TIMEOUT_MS);

    const defaultBaseUrl = trustedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL, 'weixin base URL');
    const cdnBaseUrl = trustedCdnUrl(options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL)?.replace(/\/+$/, '');
    if (cdnBaseUrl === undefined) throw platformError('INVALID_OPTIONS', 'weixin cdnBaseUrl must be https on a qq.com host');

    /** POST/GET to the media CDN with a timeout; no bot token is ever sent there. */
    async function cdnFetch(url, init = {}) {
        return fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    }

    /**
     * Download and decrypt the images of one mapped message into `envelope.images`
     * (AES-128-ECB, as in the reference `pic-decrypt.ts`). A failed image is noted
     * in the text instead of being dropped silently.
     */
    async function attachImages(mapped) {
        if (mapped.imageItems.length === 0) return mapped.envelope;
        const images = [];
        let failed = 0;
        for (const item of mapped.imageItems) {
            try {
                const url = isNonEmptyString(item.media.full_url)
                    ? trustedCdnUrl(item.media.full_url)
                    : `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(item.media.encrypt_query_param)}`;
                if (url === null) throw new Error('untrusted CDN url');
                const response = await cdnFetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const body = Buffer.from(await response.arrayBuffer());
                const key = weixinImageKey(item);
                const image = inboundImageOf(new Uint8Array(key === null ? body : decryptAesEcb(body, key)));
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
     * Upload one image to the media CDN: `getuploadurl`, AES-128-ECB encryption
     * with a fresh key, POST of the ciphertext, and the `x-encrypted-param` reply
     * header as the download reference. Adapted from the reference
     * `src/cdn/upload.ts` and `src/cdn/cdn-upload.ts`. Nothing reaches the
     * recipient here, so every failure is "not sent".
     */
    async function uploadMedia({ credential, baseUrl, peerId, bytes, mediaType, signal }) {
        const plaintext = Buffer.from(bytes);
        const filekey = randomBytes(16).toString('hex');
        const aeskey = randomBytes(16);
        const filesize = aesEcbPaddedSize(plaintext.length);
        const fail = (code, message, cause) => {
            const error = platformError(code, message, cause === undefined ? undefined : { cause });
            error.notSent = true;
            return error;
        };
        let parsed;
        try {
            const rawText = await request({
                method: 'POST',
                baseUrl,
                endpoint: 'ilink/bot/getuploadurl',
                body: JSON.stringify({
                    filekey,
                    media_type: mediaType,
                    to_user_id: peerId,
                    rawsize: plaintext.length,
                    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
                    filesize,
                    no_need_thumb: true,
                    aeskey: aeskey.toString('hex'),
                    base_info: baseInfo(),
                }),
                token: credential.botToken,
                timeoutMs: requestTimeoutMs,
                signal,
                label: 'getuploadurl',
            });
            parsed = await readJson(rawText, 'getuploadurl');
        } catch (error) {
            throw fail('MEDIA_UPLOAD_FAILED', 'weixin getuploadurl failed; nothing was sent', error);
        }
        if ([parsed?.ret, parsed?.errcode].some(code => typeof code === 'number' && code !== 0)) {
            throw fail('MEDIA_UPLOAD_REJECTED', `weixin getuploadurl rejected (${parsed.ret ?? ''},${parsed.errcode ?? ''})`);
        }
        const uploadUrl = isNonEmptyString(parsed?.upload_full_url)
            ? trustedCdnUrl(parsed.upload_full_url.trim())
            : isNonEmptyString(parsed?.upload_param)
                ? `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(parsed.upload_param)}&filekey=${encodeURIComponent(filekey)}`
                : null;
        if (uploadUrl === null) throw fail('MEDIA_UPLOAD_INVALID', 'weixin getuploadurl returned no usable upload URL');
        let response;
        try {
            response = await cdnFetch(uploadUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: new Uint8Array(encryptAesEcb(plaintext, aeskey)),
            });
        } catch (error) {
            throw fail('MEDIA_UPLOAD_FAILED', 'weixin CDN upload failed; nothing was sent', error);
        }
        const downloadParam = response.status === 200 ? response.headers.get('x-encrypted-param') : null;
        if (!isNonEmptyString(downloadParam)) {
            throw fail('MEDIA_UPLOAD_FAILED', `weixin CDN upload answered HTTP ${response.status} without x-encrypted-param`);
        }
        // The reference sends the hex key string, base64-encoded, not the raw key bytes.
        return {
            media: {
                encrypt_query_param: downloadParam,
                aes_key: Buffer.from(aeskey.toString('hex'), 'ascii').toString('base64'),
                encrypt_type: 1,
            },
            filesize,
            rawsize: plaintext.length,
        };
    }

    /** One outbound item: an uploaded image or file, otherwise text. */
    async function outboundItem({ credential, baseUrl, peerId, text, image, file, signal }) {
        if (image !== null) {
            const uploaded = await uploadMedia({ credential, baseUrl, peerId, bytes: image.bytes, mediaType: UPLOAD_MEDIA_TYPE_IMAGE, signal });
            return { type: ITEM_TYPE_IMAGE, image_item: { media: uploaded.media, mid_size: uploaded.filesize } };
        }
        if (file !== null) {
            // Reference `sendFileMessageWeixin`: the file name and the plaintext length as a string.
            const uploaded = await uploadMedia({ credential, baseUrl, peerId, bytes: file.bytes, mediaType: UPLOAD_MEDIA_TYPE_FILE, signal });
            return { type: ITEM_TYPE_FILE, file_item: { media: uploaded.media, file_name: file.name, len: String(uploaded.rawsize) } };
        }
        return { type: 1, text_item: { text } };
    }

    const baseInfo = () => buildBaseInfo({ channelVersion, botAgent });

    /**
     * One HTTP request. The caller's abort signal is forwarded to `fetch`
     * itself, so cancelling really closes the held long poll instead of only
     * abandoning the await.
     *
     * @returns {Promise<string>} raw response text of a 2xx answer
     */
    async function request(params) {
        const { method, baseUrl, endpoint, body, token, timeoutMs, signal, label } = params;
        const url = new URL(endpoint, baseUrl);
        const headers = method === 'GET'
            ? buildCommonHeaders({ channelVersion, routeTag })
            : {
                'Content-Type': 'application/json',
                AuthorizationType: 'ilink_bot_token',
                'X-WECHAT-UIN': randomWechatUin(),
                ...buildCommonHeaders({ channelVersion, routeTag }),
            };
        // The bot token travels in one place only: the Authorization header.
        if (method !== 'GET' && isNonEmptyString(token)) {
            headers.Authorization = `Bearer ${token.trim()}`;
        }

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        timer.unref?.();
        const forwardAbort = () => controller.abort();
        if (signal !== undefined) {
            if (signal.aborted === true) controller.abort();
            else signal.addEventListener('abort', forwardAbort, { once: true });
        }

        try {
            const response = await fetchImpl(url.toString(), {
                method,
                headers,
                ...(body === undefined ? {} : { body }),
                signal: controller.signal,
                // `fetch` follows redirects by default; the token must never be
                // replayed to a `Location` the protocol did not vet. The QR
                // redirect handshake uses its own validated host field instead.
                redirect: 'error',
            });
            const text = await response.text();
            const status = typeof response.status === 'number' ? response.status : 0;
            const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
            if (ok === false) {
                // A status is not a delivery verdict. 408/409 - and every other
                // status - can be returned for a request the platform already
                // acted on, so no status range is reported as a rejection; only
                // a body-level business code may decide one further up.
                throw platformError('HTTP_STATUS', `${label}: HTTP ${status}`, { status });
            }
            return text;
        } catch (error) {
            if (error?.isPlatformError === true) throw error;
            if (signal?.aborted === true) throw abortError();
            if (timedOut === true || error?.name === 'AbortError') {
                throw platformError('HTTP_TIMEOUT', `${label}: request timed out`);
            }
            const classification = classifyFetchError(error);
            throw platformError('HTTP_FAILED', `${label}: ${classification.description}`, { classification });
        } finally {
            clearTimeout(timer);
            if (signal !== undefined) signal.removeEventListener('abort', forwardAbort);
        }
    }

    async function readJson(rawText, label) {
        try {
            return parseWeixinApiJson(rawText);
        } catch {
            throw platformError('INVALID_RESPONSE', `${label}: response is not JSON`);
        }
    }

    /** Ask the server for a fresh QR code and show it. */
    async function issueQr(state, signal, onQr) {
        const rawText = await request({
            method: 'POST',
            baseUrl: state.baseUrl,
            endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
            body: JSON.stringify({ local_token_list: [] }),
            timeoutMs: requestTimeoutMs,
            signal,
            label: 'get_bot_qrcode',
        });
        const parsed = await readJson(rawText, 'get_bot_qrcode');
        const qrcode = parsed?.qrcode;
        const qrText = parsed?.qrcode_img_content;
        if (!isNonEmptyString(qrcode)) {
            throw platformError('QR_UNAVAILABLE', 'weixin did not return a qrcode value');
        }
        if (!isNonEmptyString(qrText)) {
            // Show what the platform returned; never fetch or render an image.
            throw platformError('QR_UNAVAILABLE', 'weixin did not return qrcode_img_content to display');
        }
        invokeCallback(onQr, qrText);
        return { ...state, qrcode, refreshCount: state.refreshCount + 1, pendingVerifyCode: undefined };
    }

    /** One QR status poll. */
    async function fetchQrStatus(state, signal) {
        const query = new URLSearchParams();
        query.set('qrcode', state.qrcode);
        if (isNonEmptyString(state.pendingVerifyCode)) query.set('verify_code', state.pendingVerifyCode);
        const rawText = await request({
            method: 'GET',
            baseUrl: state.baseUrl,
            endpoint: `ilink/bot/get_qrcode_status?${query.toString()}`,
            timeoutMs: requestTimeoutMs,
            signal,
            label: 'get_qrcode_status',
        });
        const parsed = await readJson(rawText, 'get_qrcode_status');
        if (parsed === null || typeof parsed !== 'object' || !isNonEmptyString(parsed.status)) {
            throw platformError('INVALID_RESPONSE', 'get_qrcode_status returned no status');
        }
        return parsed;
    }

    /**
     * Log in by QR code and return the scanned owner's credentials.
     *
     * Nothing is printed and nothing is persisted; the QR text is only handed
     * to `onQr`, and `onQr` is never asked to fetch or render an image.
     *
     * @param {object} [params]
     * @param {AbortSignal} [params.signal]
     * @param {(text: string) => void} [params.onQr]
     * @param {(phase: string) => void} [params.onState]
     * @param {(params: { signal?: AbortSignal }) => (string|Promise<string>)} [params.getVerifyCode]
     * @returns {Promise<Array<{platform: string, accountId: string, senderId: string, credential: object}>>}
     */
    async function pair(params = {}) {
        const { signal, onQr, onState, getVerifyCode } = params;
        if (signal?.aborted === true) throw abortError();
        const deadline = Date.now() + pairTimeoutMs;
        let lastPhase = '';

        const announce = (phase) => {
            if (phase === lastPhase) return;
            lastPhase = phase;
            invokeCallback(onState, phase);
        };

        let state = { baseUrl: defaultBaseUrl, qrcode: '', refreshCount: 0, pendingVerifyCode: undefined };
        state = await issueQr(state, signal, onQr);

        for (;;) {
            if (signal?.aborted === true) throw abortError();
            if (Date.now() >= deadline) {
                throw platformError('PAIR_TIMEOUT', 'weixin QR login did not finish in time');
            }

            let response;
            try {
                response = await fetchQrStatus(state, signal);
            } catch (error) {
                // A failed status poll says nothing about the login; keep
                // polling until the deadline rather than guessing a result.
                if (error?.code === 'HTTP_TIMEOUT' || error?.code === 'HTTP_STATUS' || error?.code === 'HTTP_FAILED') {
                    await sleep(pollIntervalMs);
                    continue;
                }
                throw error;
            }

            switch (response.status) {
                case 'confirmed': {
                    const botToken = response.bot_token;
                    const botId = response.ilink_bot_id;
                    if (!isNonEmptyString(botId)) {
                        throw platformError('LOGIN_INCOMPLETE', 'weixin confirmation did not return ilink_bot_id');
                    }
                    if (!isNonEmptyString(botToken)) {
                        throw platformError('LOGIN_INCOMPLETE', 'weixin confirmation did not return bot_token');
                    }
                    const userId = response.ilink_user_id;
                    if (!isNonEmptyString(userId)) {
                        // Without the scanning user there is no owner to bind
                        // private traffic to; this is never inferred later.
                        throw platformError(
                            'OWNER_UNVERIFIED',
                            'weixin confirmation did not return the scanning user id',
                        );
                    }
                    let baseUrl = state.baseUrl;
                    if (isNonEmptyString(response.baseurl)) {
                        try {
                            baseUrl = trustedBaseUrl(response.baseurl, 'weixin confirmed baseurl');
                        } catch {
                            throw platformError(
                                'UNTRUSTED_REDIRECT',
                                'weixin returned a base URL that is not a weixin.qq.com https endpoint',
                            );
                        }
                    }
                    announce('confirmed');
                    return [{
                        platform: PLATFORM,
                        accountId: botId,
                        senderId: userId,
                        credential: {
                            botToken,
                            botId,
                            userId,
                            baseUrl,
                        },
                    }];
                }
                case 'scaned': {
                    // The server stops asking for a code once it accepted one;
                    // that is the only signal that it was right.
                    if (state.pendingVerifyCode !== undefined) {
                        state = { ...state, pendingVerifyCode: undefined };
                    }
                    announce('scanned');
                    break;
                }
                case 'need_verifycode': {
                    announce('need_verifycode');
                    if (typeof getVerifyCode !== 'function') {
                        throw platformError(
                            'VERIFY_CODE_REQUIRED',
                            'weixin login needs a phone verify code but getVerifyCode() was not provided',
                        );
                    }
                    let code;
                    try {
                        code = await getVerifyCode({ signal });
                    } catch (error) {
                        throw platformError(
                            'VERIFY_CODE_REQUIRED',
                            'getVerifyCode() did not return a verify code',
                            { cause: error },
                        );
                    }
                    if (!isNonEmptyString(code)) {
                        throw platformError(
                            'VERIFY_CODE_REQUIRED',
                            'getVerifyCode() did not return a verify code',
                        );
                    }
                    state = { ...state, pendingVerifyCode: code.trim() };
                    continue;
                }
                case 'scaned_but_redirect': {
                    const host = response.redirect_host;
                    if (!isNonEmptyString(host)) {
                        announce('wait');
                        break;
                    }
                    let nextBaseUrl;
                    try {
                        nextBaseUrl = trustedBaseUrl(`https://${host.trim()}`, 'weixin QR redirect host');
                    } catch {
                        throw platformError(
                            'UNTRUSTED_REDIRECT',
                            'weixin asked to poll a host that is not a weixin.qq.com https endpoint',
                        );
                    }
                    state = { ...state, baseUrl: nextBaseUrl };
                    announce('redirect');
                    break;
                }
                case 'expired':
                case 'verify_code_blocked': {
                    if (state.refreshCount + 1 > MAX_QR_REFRESH_COUNT) {
                        throw platformError(
                            'QR_EXPIRED',
                            'weixin QR code expired and the refresh budget is spent',
                        );
                    }
                    state = await issueQr(state, signal, onQr);
                    announce('refreshed');
                    break;
                }
                case 'binded_redirect':
                    throw platformError('ALREADY_BOUND', 'this weixin bot is already bound to another client');
                case 'wait':
                default:
                    // An unrecognised status is never a success: keep waiting.
                    announce('wait');
                    break;
            }

            if (signal?.aborted === true) throw abortError();
            await sleep(pollIntervalMs);
        }
    }

    /**
     * Receive 1:1 messages from the scanned owner until cancelled.
     *
     * The cursor only moves once every message of a batch has been persisted
     * by the caller (`onMessage` resolved). A failed batch, a non-zero `ret` or
     * `errcode`, or an owner message without an id stops the loop without
     * advancing anything.
     *
     * @param {object} params
     * @param {object} params.credential `{ botToken, botId, userId, baseUrl }`
     * @param {string} [params.cursor] `get_updates_buf` of the last saved batch
     * @param {(envelope: object, replyContext: object) => Promise<void>} params.onMessage
     * @param {(next: string) => (void|Promise<void>)} [params.onCursor]
     * @param {(info: { platform: string, accountId: string }) => void} [params.onReady]
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<void>} resolves on cancellation, rejects on failure.
     */
    async function listen(params = {}) {
        const { credential, onMessage, onCursor, onReady, signal } = params;
        assertCredential(credential);
        if (typeof onMessage !== 'function') {
            throw platformError('ONMESSAGE_REQUIRED', 'listen requires onMessage(envelope, replyContext)');
        }

        // An untrusted stored base URL must fail before the token is used.
        const baseUrl = trustedBaseUrl(credential.baseUrl ?? defaultBaseUrl, 'weixin credential baseUrl');

        let cursor = isNonEmptyString(params.cursor) ? params.cursor : '';
        let readyFired = false;

        while (signal?.aborted !== true) {
            let rawText;
            try {
                rawText = await request({
                    method: 'POST',
                    baseUrl,
                    endpoint: 'ilink/bot/getupdates',
                    body: JSON.stringify({ get_updates_buf: cursor, base_info: baseInfo() }),
                    token: credential.botToken,
                    timeoutMs: longPollTimeoutMs,
                    signal,
                    label: 'getupdates',
                });
            } catch (error) {
                if (signal?.aborted === true || error?.code === 'ABORTED') break;
                // A long-poll deadline with no answer is not a batch: there is
                // no message and no cursor to save.
                if (error?.code === 'HTTP_TIMEOUT') continue;
                throw error;
            }

            const parsed = await readJson(rawText, 'getupdates');
            // `getupdates` may omit its business code: a batch is accepted
            // without one, but a non-zero code is always an error. A `false`
            // answer means "reachable, nothing confirmed": wait one interval on
            // the same cursor instead of burning the loop, and never announce
            // ready or a batch from it.
            const confirmed = assertGetUpdatesSuccess(parsed);
            if (confirmed === false) {
                await sleep(pollIntervalMs);
                continue;
            }

            if (readyFired === false) {
                readyFired = true;
                invokeCallback(onReady, { platform: PLATFORM, accountId: credential.botId });
            }

            const messages = Array.isArray(parsed.msgs) ? parsed.msgs : [];
            for (const message of messages) {
                if (signal?.aborted === true) break;
                const mapped = mapInbound(message, credential);
                if (mapped === null) continue;
                const envelope = await attachImages(mapped);
                if (envelope === null) continue;
                // The caller persists here; the cursor moves only afterwards.
                await onMessage(envelope, mapped.replyContext);
            }
            if (signal?.aborted === true) break;

            const nextCursor = parsed.get_updates_buf;
            if (isNonEmptyString(nextCursor) && nextCursor !== cursor) {
                if (typeof onCursor === 'function') await onCursor(nextCursor);
                cursor = nextCursor;
            }
        }
    }

    /**
     * Send one plain-text passive reply to the exact inbound message.
     *
     * The reply is never downgraded: no proactive push, no "latest chat"
     * fallback, no retry of an unknown outcome, and no request without the
     * inbound `context_token`.
     *
     * @param {object} params
     * @param {object} params.credential `{ botToken, botId, userId, baseUrl }`
     * @param {string} params.peerId the owner's user id
     * @param {{ toUserId: string, contextToken: string }} params.anchor
     *     the `replyContext` of the inbound message being answered; both the
     *     recipient and the token are needed to address exactly that message
     * @param {string} params.text
     * @param {string} params.deliveryId sent as `client_id`
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ kind: 'platform-accepted', platformMessageId: string|null, clientId: string }>}
     */
    async function send(params = {}) {
        const { credential, peerId, anchor, text, deliveryId, image, file } = params;
        const hasImage = image !== null && typeof image === 'object' && image.bytes instanceof Uint8Array;
        const hasFile = file !== null && typeof file === 'object' && file.bytes instanceof Uint8Array;
        assertCredential(credential, { notSent: true });

        if (!isNonEmptyString(deliveryId)) {
            throw notSentError('DELIVERY_ID_REQUIRED', 'weixin send requires deliveryId as client_id');
        }
        if (!isNonEmptyString(peerId)) {
            throw notSentError('PEER_REQUIRED', 'weixin send requires peerId');
        }
        if (peerId !== credential.userId) {
            throw notSentError('PEER_NOT_OWNER', 'weixin replies are only sent to the scanning owner');
        }
        if (anchor === null || typeof anchor !== 'object') {
            throw notSentError('ANCHOR_REQUIRED', 'weixin send requires the inbound replyContext as anchor');
        }
        if (!isNonEmptyString(anchor.contextToken)) {
            throw notSentError(
                'CONTEXT_TOKEN_REQUIRED',
                'weixin passive reply requires the inbound context_token; refusing to send without it',
            );
        }
        // The token names a conversation, not a recipient: without the inbound
        // sender there is nobody to address, and guessing would be a downgrade.
        if (!isNonEmptyString(anchor.toUserId)) {
            throw notSentError(
                'ANCHOR_TARGET_REQUIRED',
                'weixin passive reply requires the inbound toUserId; refusing to address a bare context_token',
            );
        }
        if (anchor.toUserId !== peerId) {
            throw notSentError('ANCHOR_TARGET_MISMATCH', 'weixin anchor toUserId does not match peerId');
        }
        if (!hasImage && !hasFile && (typeof text !== 'string' || text === '')) {
            throw notSentError('TEXT_REQUIRED', 'weixin send requires non-empty text');
        }

        let baseUrl;
        try {
            baseUrl = trustedBaseUrl(credential.baseUrl ?? defaultBaseUrl, 'weixin credential baseUrl');
        } catch (error) {
            if (error?.isPlatformError === true) error.notSent = true;
            throw error;
        }

        const body = JSON.stringify({
            msg: {
                from_user_id: '',
                to_user_id: peerId,
                client_id: deliveryId,
                message_type: 2,
                message_state: 2,
                context_token: anchor.contextToken,
                item_list: [await outboundItem({
                    credential, baseUrl, peerId, text, image: hasImage ? image : null, file: hasFile ? file : null, signal: params.signal,
                })],
            },
            base_info: baseInfo(),
        });

        let rawText;
        try {
            rawText = await request({
                method: 'POST',
                baseUrl,
                endpoint: 'ilink/bot/sendmessage',
                body,
                token: credential.botToken,
                timeoutMs: requestTimeoutMs,
                signal: params.signal,
                label: 'sendmessage',
            });
        } catch (error) {
            // The request left the process, so it is never "not sent". A
            // transport fault or an HTTP status cannot prove there was no side
            // effect (408/409 included), so unless a body-level business code
            // already decided a rejection, the outcome stays unknown.
            if (error?.definitelyRejected === true) throw error;
            if (error !== null && typeof error === 'object') error.resultUnknown = true;
            throw error;
        }

        const parsed = await readJson(rawText, 'sendmessage');
        const ret = parsed?.ret;
        const errcode = parsed?.errcode;
        const codes = [];
        let codeMalformed = false;
        // A code that is present must be a finite number; any non-zero code is
        // the platform's own rejection, whatever else the body carries.
        for (const code of [ret, errcode]) {
            if (code === undefined) continue;
            if (Number.isFinite(code)) codes.push(code);
            else codeMalformed = true;
        }

        if (codes.some((code) => code !== 0)) {
            throw platformError('SEND_REJECTED', `weixin sendmessage rejected (${codes.join(',')})`, {
                ret,
                errcode,
                definitelyRejected: true,
            });
        }
        if (codeMalformed) {
            throw platformError(
                'UNKNOWN_RESULT',
                'weixin sendmessage returned a business code that is not a finite number',
                { resultUnknown: true },
            );
        }
        if (codes.length === 0 && isEmptySendSuccess(parsed) === false) {
            // A code-less body confirms nothing unless it is a valid empty success.
            throw platformError(
                'UNKNOWN_RESULT',
                'weixin sendmessage returned neither a business code nor an empty success',
                { resultUnknown: true },
            );
        }

        const platformMessageId = firstNonEmptyString(
            parsed?.message_id,
            parsed?.msg_id,
            parsed?.msg?.message_id,
        );
        return {
            kind: 'platform-accepted',
            // A successful answer may carry no id; null is honest, a minted id is not.
            platformMessageId,
            clientId: deliveryId,
        };
    }

    return { pair, listen, send, ...WEIXIN_DELIVERY };
}

/**
 * 发送能力（渠道运行态按它选路，不看平台名）：文字、图片、文件（没有语音消息，语音按音频文件发）；
 * 现在能不能主动发给这个对话——对方最近一条消息的上下文 24 小时内有效。
 */
export const WEIXIN_DELIVERY = Object.freeze({
    sends: Object.freeze(['text', 'image', 'file']),
    canDeliverNow: ({ live, lastInputAt, now }) => live === true && lastInputAt !== null && now - lastInputAt <= CONTEXT_WINDOW_MS,
});

export default createWeixinPlatform;
