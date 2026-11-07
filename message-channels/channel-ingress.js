/**
 * 主助手私聊文本准入（channel-ingress）
 *
 * 已批准 QQ/微信接入的原生准入半步：把“渠道所有者配对确认后的精确本人私聊文本”
 * 写入官方 Session Inbox，并用官方事件的真实 message.id / event.seq 返回持久确认。
 *
 * 目标会话是 binding 固定的那条普通会话。`sessionQuery.observeSession(sessionId)` 只读
 * 观察同一个 id：header.id 必须相同，且必须不是子 agent 会话（只按
 * `origin === 'subagent'`；普通 fork 的 parentSession 合法）。
 * 目标永远不由调用者或 UI 焦点指定；输入只走公开的 `sessionController.prompt`，由它
 * 恢复准确 Agent。本模块不调用 create，不取得、取消或释放 Agent handle。只使用 Node
 * 内置库，不安装平台连接或 UI。
 *
 * 结果语义：
 * - { status:'accepted', sessionId, requestId, messageId, seq }
 *     原生 Inbox 已确认持久持有该用户消息；不代表模型完成或平台送达。
 *     messageId/seq 来自真实 producer 事件，不是本模块生成的引用。
 * - { status:'unknown', sessionId, requestId }
 *     已核对过一次真实证据，但持久屏障无法确认为真（或 prompt 失败且无证据）。
 *     调用方不得因此自动重发，应先对账。
 *
 * 抛出的 IngressError：参数类 INVALID_CONTEXT / INVALID_BINDING /
 * INVALID_MESSAGE（先于任何 Host 调用）；SESSION_UNAVAILABLE（目标 id 不符、子 agent
 * 会话）；OBSERVATION_UNAVAILABLE
 * （预读失败，绝不盲读准入）；INPUT_CONFLICT（同一 requestId 的原生原件有歧义，
 * 不重发也不报成功）；INGRESS_CLOSED。
 */

import { createHash } from 'node:crypto';
import { IMAGE_MEDIA_TYPES } from './media.js';
import { CHANNEL_RELAY_PREFIX, CHANNEL_REQUEST_PREFIX, userInputOf } from './replies.js';

const REQUEST_VERSION = 'galatea-channel/1';
/** 平台名的写法（内置的和登记的都一样）；平台装没装着由运行态管。 */
const PLATFORM_ID = /^[a-z][a-z0-9-]*$/;
const IDENTITY_FIELDS = Object.freeze(['platform', 'accountId', 'conversationId', 'senderId']);
const FORBIDDEN_MESSAGE_FIELDS = Object.freeze(['sessionId', 'requestId', 'rpcId', 'source']);
const INBOX_SPLICED_EVENT = 'agent/inbox/spliced';

const UNCONFIRMED = Object.freeze({ matched: false, durable: false, match: null });

export class IngressError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'IngressError';
        this.code = code;
    }
}

function fail(code, message, options) {
    throw new IngressError(code, message, options);
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function isAbortError(error) {
    return isRecord(error) && error.name === 'AbortError';
}

/**
 * 复制并冻结渠道所有者已确认的本人绑定与固定会话。调用者之后改动自己那份对象
 * 不会影响本模块；本模块只消费这一份精确绑定，不创建配对，不把首位发信者当
 * 本人，也不重新选择默认会话或当前 UI 焦点。
 */
function normalizeBinding(binding) {
    if (!isRecord(binding)) {
        fail('INVALID_BINDING', 'binding 必须是 {platform,accountId,conversationId,senderId,sessionId} 对象');
    }
    const copy = {};
    for (const field of IDENTITY_FIELDS) {
        const value = binding[field];
        if (typeof value !== 'string') {
            fail('INVALID_BINDING', `binding.${field} 必须是非空字符串`);
        }
        if (value.trim() === '') {
            fail('INVALID_BINDING', `binding.${field} 不能是空白字符串`);
        }
        copy[field] = value;
    }
    if (!PLATFORM_ID.test(copy.platform)) {
        fail('INVALID_BINDING', `binding.platform 必须是平台名（小写字母开头，字母、数字、连字符），收到 ${copy.platform}`);
    }
    if (!isNonEmptyString(binding.sessionId)) {
        fail('INVALID_BINDING', 'binding.sessionId 必须是已绑定普通会话的非空 id');
    }
    copy.sessionId = binding.sessionId;
    return Object.freeze(copy);
}

function normalizeHost(ctx) {
    if (!isRecord(ctx)) {
        fail('INVALID_CONTEXT', 'ctx 必须是 Host 依赖对象');
    }
    const { sessionController, sessionQuery, sessions, core } = ctx;
    if (!isRecord(sessionController) || typeof sessionController.prompt !== 'function') {
        fail('INVALID_CONTEXT', 'ctx.sessionController.prompt 缺失');
    }
    if (!isRecord(sessionQuery) || typeof sessionQuery.observeSession !== 'function') {
        fail('INVALID_CONTEXT', 'ctx.sessionQuery.observeSession 缺失');
    }
    if (
        !isRecord(sessions)
        || typeof sessions.get !== 'function'
        || typeof sessions.flush !== 'function'
    ) {
        fail('INVALID_CONTEXT', 'ctx.sessions.get / ctx.sessions.flush 缺失');
    }
    // 谁说的由入口在 prompt 之前向框架核心声明，不再靠请求号前缀事后去认。
    if (!isRecord(core) || typeof core.provenance?.declare !== 'function') {
        fail('INVALID_CONTEXT', 'ctx.core.provenance.declare 缺失：渠道要接框架核心');
    }
    // 只借用引用：不创建、不恢复、不关闭、不替换任何借用服务，也不持有 Agent handle。
    return Object.freeze({ sessionController, sessionQuery, sessions, core });
}

/**
 * 稳定 requestId：sha256(JSON.stringify([版本,platform,accountId,conversationId,messageId]))
 * 加前缀。正文与 senderId 一律不进入 ID；messageId 保持渠道原始字符串。
 * 渠道代为放进来的（转交、等待到期提醒，`relayed`）用另一个前缀，进了会话日志也和用户本人的话分得开。
 */
function computeRequestId(binding, messageId, relayed) {
    const digest = createHash('sha256')
        .update(JSON.stringify([
            REQUEST_VERSION,
            binding.platform,
            binding.accountId,
            binding.conversationId,
            messageId,
        ]))
        .digest('hex');
    return `${relayed ? CHANNEL_RELAY_PREFIX : CHANNEL_REQUEST_PREFIX}${digest}`;
}

/**
 * 校验在调用 controller 之前完成：只准入精确本人私聊文本。
 * 返回归一化后的不可变请求描述，会话目标永远不是调用者提供的。
 */
function normalizeMessage(message, binding) {
    if (!isRecord(message)) {
        fail('INVALID_MESSAGE', 'message 必须是对象');
    }
    for (const field of FORBIDDEN_MESSAGE_FIELDS) {
        if (field in message) {
            fail('INVALID_MESSAGE', `message 不允许携带 ${field}；会话目标由已绑定会话固定`);
        }
    }
    if (message.kind !== 'private') {
        fail('INVALID_MESSAGE', `只准入私聊文本，收到 kind=${String(message.kind)}`);
    }
    for (const field of IDENTITY_FIELDS) {
        const value = message[field];
        if (typeof value !== 'string' || value.trim() === '') {
            fail('INVALID_MESSAGE', `message.${field} 必须是非空字符串`);
        }
        if (value !== binding[field]) {
            fail('INVALID_MESSAGE', `message.${field} 与已配对确认的本人绑定不一致`);
        }
    }
    if (typeof message.messageId !== 'string') {
        fail('INVALID_MESSAGE', 'message.messageId 必须是渠道原始字符串，不做数字转换');
    }
    if (message.messageId.trim() === '') {
        fail('INVALID_MESSAGE', 'message.messageId 不能是空白字符串');
    }
    const images = normalizeImages(message.images);
    if (message.relayed !== undefined && typeof message.relayed !== 'boolean') {
        fail('INVALID_MESSAGE', 'message.relayed 只能是布尔值');
    }
    if (!isRecord(message.origin) || !isRecord(message.origin.speaker) || typeof message.origin.speaker.kind !== 'string') {
        fail('INVALID_MESSAGE', 'message.origin 要写明 { speaker, via? }：谁说的由入口声明');
    }
    if (typeof message.text !== 'string' || (message.text.trim() === '' && images.length === 0)) {
        fail('INVALID_MESSAGE', 'message.text 必须是非空白字符串（只有图片时可为空串）');
    }
    return Object.freeze({
        requestId: computeRequestId(binding, message.messageId, message.relayed === true),
        messageId: message.messageId,
        text: message.text,
        images,
        origin: Object.freeze({ speaker: Object.freeze({ ...message.origin.speaker }), ...message.origin.via === undefined ? {} : { via: Object.freeze({ ...message.origin.via }) } }),
    });
}

/** 图片必须是 DSH 支持的类型与非空 base64。 */
function normalizeImages(images) {
    if (images === undefined || images === null) return Object.freeze([]);
    if (!Array.isArray(images)) fail('INVALID_MESSAGE', 'message.images 必须是数组');
    return Object.freeze(images.map((image) => {
        if (!isRecord(image) || !IMAGE_MEDIA_TYPES.includes(image.mediaType) || !isNonEmptyString(image.data)) {
            fail('INVALID_MESSAGE', 'message.images 的每一项必须是 { mediaType, data } 且类型受支持');
        }
        return Object.freeze({ mediaType: image.mediaType, data: image.data });
    }));
}

/**
 * 原生原件必须“恰为该完整输入”：正文非空时恰好一个等于它的 text part，另有恰好
 * imageCount 个图片 part，不含其他块；没有图片时与旧规则相同（恰好一个 text part）。
 */
function contentMatches(content, text, imageCount) {
    const input = userInputOf({ content });
    if (input === null) return false;
    const textParts = content.filter(part => isRecord(part) && part.type === 'text').length;
    if (text === '' ? textParts !== 0 : textParts !== 1) return false;
    return input.text === text && input.imageCount === imageCount;
}

/**
 * 只从 agent/inbox/spliced.data.inserted 的真实 producer 事件里找完整原件：
 * source.kind==='user' && source.rpcId===requestId、role==='user'、content 恰为
 * 单一 text part、message.id 非空、event.seq 为非负安全整数。
 * 同 requestId 不同正文或不同 message.id → INPUT_CONFLICT（不报成功也不重发）；
 * 同一 message.id 在另一处 splice 重复出现仍是同一条消息，取最早的 seq。
 */
function scanObservationEvents(events, requestId, text, imageCount = 0) {
    let present = false;
    const ids = new Set();
    let match = null;
    for (const event of events) {
        if (!isRecord(event) || event.type !== INBOX_SPLICED_EVENT) {
            continue;
        }
        const inserted = isRecord(event.data) ? event.data.inserted : undefined;
        if (!Array.isArray(inserted)) {
            continue;
        }
        const seq = event.seq;
        for (const message of inserted) {
            if (!isRecord(message)) {
                continue;
            }
            const source = message.source;
            if (!isRecord(source) || source.kind !== 'user' || source.rpcId !== requestId) {
                continue;
            }
            // 该 requestId 的原生原件已经存在：绝不当作缺席再 prompt 一次。
            present = true;
            if (!contentMatches(message.content, text, imageCount)) {
                fail('INPUT_CONFLICT', `requestId ${requestId} 已存在不同正文的原生原件，拒绝成功也不重发`);
            }
            if (message.role !== 'user' || !isNonEmptyString(message.id) || !isEventSeq(seq)) {
                // 形状不完整的原件不提供可核对的原生引用。
                continue;
            }
            ids.add(message.id);
            if (match === null || seq < match.seq) {
                match = { messageId: message.id, seq };
            }
        }
    }
    if (ids.size > 1) {
        fail('INPUT_CONFLICT', `requestId ${requestId} 对应多个不同原生 message.id，拒绝任选其一`);
    }
    return { present, match };
}

/**
 * 观察租约能否作为“本人普通会话”的证据。返回 null 表示可用，否则给出稳定错误码：
 * - 形状不完整（无租约、无 header、无 events）→ OBSERVATION_UNAVAILABLE
 * - header.id 不是固定目标 → SESSION_UNAVAILABLE（绝不改投）
 * - 子 agent 会话（`origin === 'subagent'`）→ SESSION_UNAVAILABLE（不能当作本人会话）；
 *   普通 fork 也带 parentSession，但仍是合法普通会话，不据 parentSession 拒绝
 */
function targetProblem(observation, sessionId) {
    if (!isRecord(observation)
        || typeof observation[Symbol.dispose] !== 'function'
        || !isRecord(observation.header)
        || !Array.isArray(observation.events)) {
        return {
            code: 'OBSERVATION_UNAVAILABLE',
            message: '观察租约不是官方 SessionObservation 的公开形状（header/events/Symbol.dispose）',
        };
    }
    if (observation.header.id !== sessionId) {
        return { code: 'SESSION_UNAVAILABLE', message: '观察租约不是绑定会话（header.id 不同），拒绝改投' };
    }
    if (observation.header.origin === 'subagent') {
        return { code: 'SESSION_UNAVAILABLE', message: '绑定目标是子 agent 会话，不能作为本人会话准入' };
    }
    return null;
}

/** event.seq 必须是真实的非负安全整数。 */
function isEventSeq(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function disposeObservation(observation) {
    if (!isRecord(observation) || typeof observation[Symbol.dispose] !== 'function') {
        return;
    }
    try {
        observation[Symbol.dispose]();
    } catch {
        // 释放失败不覆盖准入结论；所有路径都尝试释放。
    }
}

function acceptedResult(sessionId, request, match) {
    return Object.freeze({
        status: 'accepted',
        sessionId,
        requestId: request.requestId,
        messageId: match.messageId,
        seq: match.seq,
    });
}

function unknownResult(sessionId, request) {
    return Object.freeze({
        status: 'unknown',
        sessionId,
        requestId: request.requestId,
    });
}

class MainTextIngress {
    #host;

    #binding;

    #queues = new Map();

    #inFlight = new Set();

    #closed = false;

    #closePromise = null;

    #closedFailure = null;

    #lifecycle = new AbortController();

    constructor(host, binding) {
        this.#host = host;
        this.#binding = binding;
    }

    /**
     * 准入一条已配对本人私聊文本。所有校验先于任何 Host 调用；同一实例内按
     * requestId 串行，同一消息并发只真正准入一次。
     */
    async admit(message) {
        this.#assertOpen();
        const request = normalizeMessage(message, this.#binding);
        const pending = this.#enqueue(request.requestId, () => this.#admitOnce(request));
        this.#inFlight.add(pending);
        const settle = () => {
            this.#inFlight.delete(pending);
        };
        pending.then(settle, settle);
        return pending;
    }

    /** 停止新准入、abort 本 helper 的 signal、排空在途 promise。幂等。 */
    close() {
        if (this.#closePromise !== null) {
            return this.#closePromise;
        }
        this.#closed = true;
        this.#lifecycle.abort(this.#closedError());
        this.#closePromise = this.#drain();
        return this.#closePromise;
    }

    async #drain() {
        while (this.#inFlight.size > 0) {
            await Promise.allSettled([...this.#inFlight]);
        }
    }

    #assertOpen() {
        if (this.#closed) {
            throw this.#closedError();
        }
    }

    #closedError() {
        if (this.#closedFailure === null) {
            this.#closedFailure = new IngressError('INGRESS_CLOSED', 'ingress 已关闭，不再接受准入');
        }
        return this.#closedFailure;
    }

    #rethrowIfAborted(error) {
        if (this.#closed) {
            throw this.#closedError();
        }
        if (isAbortError(error)) {
            throw error;
        }
    }

    #enqueue(key, task) {
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const started = previous.then(() => task());
        const tail = started.then(() => undefined, () => undefined);
        this.#queues.set(key, tail);
        tail.then(() => {
            if (this.#queues.get(key) === tail) {
                this.#queues.delete(key);
            }
        });
        return started;
    }

    async #admitOnce(request) {
        this.#assertOpen();
        const signal = this.#lifecycle.signal;
        const sessionId = this.#binding.sessionId;

        const before = await this.#confirm({ phase: 'pre', sessionId, request, signal });
        this.#assertOpen();
        if (before.matched) {
            return before.durable
                ? acceptedResult(sessionId, request, before.match)
                : unknownResult(sessionId, request);
        }

        // 先声明这条是谁说的、从哪来：核心在这一步的 pre-step 按请求号写进 source.speaker、source.via。
        // 同一个请求号重复声明、内容相同算一次（结果不明重试时会再来一次）。放在 prompt 的 try 外面：
        // 声明失败是写错了，要报出来，不能当成 prompt 失败、悄悄落成"结果不明"。
        this.#host.core.provenance.declare(request.requestId, request.origin);
        try {
            await this.#promptOnce(sessionId, request, signal);
        } catch (error) {
            // 取消/关闭不吞；其余 prompt 失败留给下面“一次真实证据核对”决定结论。
            this.#rethrowIfAborted(error);
        }
        this.#assertOpen();

        const after = await this.#confirm({ phase: 'post', sessionId, request, signal });
        this.#assertOpen();
        if (after.matched && after.durable) {
            return acceptedResult(sessionId, request, after.match);
        }
        // 已核对过一次真实证据：无证据或屏障不成立都只报 unknown，不自动重发。
        return unknownResult(sessionId, request);
    }

    /**
     * 取一次观察租约，扫真实事件，必要时核对持久屏障；finally 一律释放租约。
     * pre：无法观察或目标不是本人普通会话就明确失败（绝不盲读后 prompt）。
     * post：无法确认只代表“无法确认”，由调用方报 unknown。
     */
    async #confirm({ phase, sessionId, request, signal }) {
        this.#assertOpen();
        let observation;
        try {
            observation = await this.#host.sessionQuery.observeSession(sessionId, {
                projectionMode: 'none',
                signal,
            });
        } catch (error) {
            this.#rethrowIfAborted(error);
            return this.#unconfirmed(phase, 'OBSERVATION_UNAVAILABLE', '无法观察绑定会话事件，拒绝盲读准入', error);
        }

        try {
            // 关闭检查放在 try 内：即使 close 落在观察返回之后，也要先释放租约。
            this.#assertOpen();
            const problem = targetProblem(observation, sessionId);
            if (problem !== null) {
                return this.#unconfirmed(phase, problem.code, problem.message);
            }
            const { present, match } = scanObservationEvents(
                observation.events, request.requestId, request.text, request.images.length);
            if (!present) {
                return { matched: false, durable: false, match: null };
            }
            if (match === null) {
                // 原件存在但没有可核对的原生引用：不重发，也不声称已持久。
                return { matched: true, durable: false, match: null };
            }
            const durable = await this.#confirmPersistence(sessionId, observation);
            this.#assertOpen();
            return { matched: true, durable, match };
        } finally {
            disposeObservation(observation);
        }
    }

    /** 预读阶段无法确认就明确失败；确认阶段只表示“无法确认”。 */
    #unconfirmed(phase, code, message, cause) {
        if (phase === 'pre') {
            throw new IngressError(code, message, cause === undefined ? undefined : { cause });
        }
        return UNCONFIRMED;
    }

    /**
     * 持久屏障。真实 SessionObservation 的 source/revision/header 都在顶层：
     * prepared 要求非空 opaque revision（不解析）；live 要求借用服务里的实例 header
     * 就是本观察的 header，对该 exact 实例 flush 必须 === true，await 后仍是同一实例。
     * 任何不确定都返回 false（→ unknown）；不先 flush 再观测，也不用其它实例的 flush。
     */
    async #confirmPersistence(sessionId, observation) {
        const { source, revision, header } = observation;
        if (source === 'prepared') {
            return isNonEmptyString(revision);
        }
        if (source !== 'live') {
            return false;
        }
        const { sessions } = this.#host;
        const instance = sessions.get(sessionId);
        if (!isRecord(instance) || instance.header !== header) {
            return false;
        }
        let flushed;
        try {
            flushed = await sessions.flush(instance);
        } catch (error) {
            this.#rethrowIfAborted(error);
            return false;
        }
        this.#assertOpen();
        return flushed === true && sessions.get(sessionId) === instance;
    }

    /**
     * 原生 prompt 请求形状固定；source {kind:'user', rpcId:requestId} 由现有
     * controller 保存。内部复用官方 requestId 去重，但不 flush，也不调用 create。
     */
    async #promptOnce(sessionId, request, signal) {
        const payload = Object.freeze({
            requestId: request.requestId,
            sessionId,
            mode: 'queue',
            content: Object.freeze([
                ...request.text === '' ? [] : [Object.freeze({ type: 'text', text: request.text })],
                ...request.images.map(image => Object.freeze({ type: 'image', mediaType: image.mediaType, data: image.data })),
            ]),
        });
        const result = await this.#host.sessionController.prompt(payload, signal);
        this.#assertOpen();
        if (!isRecord(result) || result.accepted !== true) {
            throw new IngressError('PROMPT_NOT_ACCEPTED', 'sessionController.prompt 未返回 {accepted:true}');
        }
    }
}

/**
 * 创建主助手私聊文本准入 helper。
 * @param {object} ctx Host 依赖：sessionController/sessionQuery/sessions
 * @param {object} binding 渠道所有者已配对确认的本人与固定会话
 *   {platform,accountId,conversationId,senderId,sessionId}
 * @returns {{admit(message: object): Promise<object>, close(): Promise<void>}}
 */
export function createMainTextIngress(ctx, binding) {
    const host = normalizeHost(ctx);
    const owner = normalizeBinding(binding);
    return Object.freeze(new MainTextIngress(host, owner));
}
