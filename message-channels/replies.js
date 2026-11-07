/**
 * 渠道回复批提取（replies）
 *
 * 纯函数：只从真实 Session 事件里取出“该回合真实完成、且确实由某个渠道绑定输入”
 * 触发的回复批。关联链固定为
 * turn/start → user/message(source.kind='user' 的 rpcId) → assistant/message(data.turn)
 * → turn/end(reason.kind='completed')；锚点取该批中最后一条真实 user/message。
 *
 * 归属不是只看 accepted 标签与 rpcId：每条 user/message 还要对上持久化的原生引用
 * （data.id === nativeMessageId），并在 incoming.nativeSeq 指向的真实 agent/inbox/spliced
 * 原件里核对同 id / 同 source.rpcId，再用原件正文与原平台身份重算指纹。任一引用不可解析
 * 就不发送该回合。nativeSeq 是 Inbox 插入事件的 seq，绝不是 user/message 的 seq。
 */

import { createHash } from 'node:crypto'

/** 真实模型输出的来源标记；文本块或消息自身必须带这一标记。 */
const MODEL_SOURCE_KIND = 'model'

/** 真实 Inbox 插入事件类型；incoming.nativeSeq 指向它的 seq。 */
const INBOX_SPLICED_EVENT = 'agent/inbox/spliced'
/** 官方 present 工具记下的交付文件。 */
const PRESENTED_EVENT = 'deliverables/presented'
/** 渠道准入用户本人消息的请求号前缀（channel-ingress 按绑定与平台消息身份算出）：准入结果还没写回原件时也认得出是渠道输入。 */
export const CHANNEL_REQUEST_PREFIX = 'channel-ingress:1:'
/**
 * 渠道代为放进会话的输入（转交、等待到期提醒）走同一个准入，请求号换这个前缀：
 * 进了会话日志也和用户本人的话分得开，不必回头查收件表。
 */
export const CHANNEL_RELAY_PREFIX = 'channel-relay:1:'
/** 等待到期时代为提醒助手的输入；平台消息身份以此前缀区分于真实消息。 */
export const NUDGE_ID_PREFIX = 'wait-timeout:'
/** 代为转交给绑定会话的输入（例如项目任务回报）；平台消息身份以此前缀区分于真实消息。 */
export const RELAY_ID_PREFIX = 'relay:'

/** 这个平台消息身份是不是渠道代为放进来的（转交、等待到期提醒），而不是对方在平台上发的原件。 */
export function relayedInput(platformMessageId) {
    return platformMessageId.startsWith(NUDGE_ID_PREFIX) || platformMessageId.startsWith(RELAY_ID_PREFIX)
}

/** 请求号是不是渠道准入的（用户本人的消息，或渠道代为放进来的）。 */
export function isChannelRequest(rpcId) {
    return rpcId.startsWith(CHANNEL_REQUEST_PREFIX) || rpcId.startsWith(CHANNEL_RELAY_PREFIX)
}

/**
 * 收件表按请求号：这条渠道输入是不是对方在平台上发的原件（转交、等待到期提醒不是）。给 `inputOrigin` 用。
 * @param {unknown} incomingRecords - 已持久 incoming 记录
 * @returns {Map<string, boolean>}
 */
export function channelInputs(incomingRecords) {
    const channel = new Map()
    for (const record of Array.isArray(incomingRecords) ? incomingRecords : []) {
        if (!isRecord(record) || !isNonEmptyString(record.requestId)) continue
        const id = typeof record.platformMessageId === 'string' ? record.platformMessageId : ''
        channel.set(record.requestId, !relayedInput(id))
    }
    return channel
}

/**
 * 一条进了会话的输入从哪来，渠道里认"桌面 / 渠道"只用这一处（按框架核心写进 `source` 的
 * `speaker`、`via` 认，不再按请求号前缀去拼；原来的 `speakerOf` 去掉）：
 * - `channel`：经渠道入口准入的（带请求号）。收件表里有这条请求号的按收件行认 `own`（对方在平台上发的原件为真，
 *   等待到期提醒这类渠道自己放进来的为假）；收件行还没写回请求号时按出处认：带 `via` 的就是渠道准入的，用户本人说的 `own` 为真。
 * - `desktop`：用户本人经 `prompt` 进来、没有 `via`（DSH 桌面上打的字）。
 * - 其余返回 null：经 `core.deliver` 放进来的（没有请求号，哪怕带着 `via`，比如转到中枢的群消息）、外部调用方、程序、认不出的。
 * 以前的消息没有 `speaker`，不算桌面输入。
 * @param {unknown} source - user/message 的 source
 * @param {Map<string, boolean>} channel - `channelInputs` 的结果
 * @returns {{ from: 'channel' | 'desktop', own: boolean } | null}
 */
export function inputOrigin(source, channel) {
    if (!isRecord(source) || !isNonEmptyString(source.rpcId)) return null
    if (channel.has(source.rpcId)) return { from: 'channel', own: channel.get(source.rpcId) }
    const speaker = isRecord(source.speaker) ? source.speaker.kind : undefined
    if (isRecord(source.via)) return { from: 'channel', own: speaker === 'user' }
    return speaker === 'user' ? { from: 'desktop', own: true } : null
}

/** incoming 指纹域标签：与 runtime 写入时使用同一份计算。 */
const FINGERPRINT_DOMAIN = 'galatea-channels/fingerprint/1'

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== ''
}

function isSeq(value) {
    return Number.isSafeInteger(value) && value >= 0
}

function isTurn(value) {
    return Number.isSafeInteger(value) && value >= 0
}

function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * incoming 原件指纹：精确正文 + 图片张数 + 原平台身份。接收时写入，回复提取时用原生正文重算核对。
 * 没有图片时与只含正文的旧指纹完全相同；图片字节会被 DSH 规范化，原生侧只能核对张数。
 * @param {{platform: string, accountId: string, conversationId: string, senderId: string,
 *   platformMessageId: string, text: string, imageCount?: number}} record
 * @returns {string} 64 位十六进制指纹
 */
export function incomingFingerprintOf(record) {
    const fields = [
        FINGERPRINT_DOMAIN,
        record.platform,
        record.accountId,
        record.conversationId,
        record.senderId,
        record.platformMessageId,
        record.text,
    ]
    if (Number.isSafeInteger(record.imageCount) && record.imageCount > 0) fields.push({ images: record.imageCount })
    return sha256(JSON.stringify(fields))
}

/**
 * 一条真实 user 消息的可核对正文：至多一个 text 块，加任意张图片块，不含其他块。
 * 只有一个 text 块时与旧规则一致；只有图片时正文为空串。
 * @returns {{text: string, imageCount: number}|null}
 */
export function userInputOf(message) {
    if (!isRecord(message)) return null
    if (message.role !== undefined && message.role !== 'user') return null
    if (!Array.isArray(message.content) || message.content.length === 0) return null
    let text = null
    let imageCount = 0
    for (const block of message.content) {
        if (!isRecord(block)) return null
        if (block.type === 'text' && typeof block.text === 'string' && text === null) text = block.text
        else if (block.type === 'image') imageCount += 1
        else return null
    }
    if (text === null && imageCount === 0) return null
    return { text: text ?? '', imageCount }
}

/** 两份 user 输入是否相同。 */
function sameInput(left, right) {
    return left !== null && right !== null && left.text === right.text && left.imageCount === right.imageCount
}

/** 一轮完成了却一个字也没写、也没交付文件时发到手机的说明，免得对方什么都收不到。 */
export const NO_TEXT_NOTE = '（这一轮没有另外写回复，过程在电脑上可以看到。）'

/**
 * 一条 assistant 消息中的真实模型文本块：只保留 type='text' 的块，
 * 且块自身的 source.kind（缺省时看消息的 source.kind）必须是 'model'。
 * reasoning 块、工具调用、无来源标记的文本都不算模型回复。
 * @param {unknown} message - assistant/message.data.message
 * @returns {string[]} 各个非空文本块，按顺序
 */
function modelSegmentsOf(message) {
    if (!isRecord(message) || !Array.isArray(message.content)) return []
    const messageIsModel = isRecord(message.source) && message.source.kind === MODEL_SOURCE_KIND
    const parts = []
    for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'text') continue
        if (typeof block.text !== 'string' || block.text.trim() === '') continue
        const blockIsModel = block.source === undefined
            ? messageIsModel
            : (isRecord(block.source) && block.source.kind === MODEL_SOURCE_KIND)
        if (!blockIsModel) continue
        parts.push(block.text)
    }
    return parts
}

/** 一条 assistant 消息的真实模型文本：各块用换行连接，无内容时为空串。 */
function modelTextOf(message) {
    return modelSegmentsOf(message).join('\n')
}

/**
 * 当前 surface 上的同 seq 事件必须与观察 cut 里的原件同 type / 同 id / 同内容；
 * 只看 seq 相同就相信另一份 cut 会把撤下或替换的文本当成回复。
 */
function sameSurfaceCopy(observationEvent, surfaceEvent) {
    if (!isRecord(surfaceEvent)) return false
    if (surfaceEvent.type !== observationEvent.type) return false
    if (surfaceEvent.seq !== observationEvent.seq) return false
    const left = observationEvent.data
    const right = surfaceEvent.data
    if (!isRecord(left) || !isRecord(right)) return false
    if (observationEvent.type === 'user/message') {
        return isNonEmptyString(left.id)
            && left.id === right.id
            && sameInput(userInputOf(left), userInputOf(right))
    }
    if (observationEvent.type === 'assistant/message') {
        const leftMessage = left.message
        const rightMessage = right.message
        if (!isRecord(leftMessage) || !isRecord(rightMessage)) return false
        return isNonEmptyString(leftMessage.id)
            && leftMessage.id === rightMessage.id
            && modelTextOf(leftMessage) === modelTextOf(rightMessage)
    }
    return false
}

/**
 * 核对一条本轮 user/message 的原生归属：当前 surface 仍含它、持久原生引用可解析、
 * 原件正文指纹一致、日志里这条消息的正文仍和原件相同。不成立时返回原因（该回合不发送），成立时返回原件输入。
 * 正文那一道挡的是：渠道消息排队时在桌面上被编辑成了别的事（上游编辑排队项只换正文，编号和请求号都不变）。
 * 框架核心给不是用户本人说的消息加的来源标注，原文记在 `source.annotation`：比之前先用核心的 `original`（这里叫 originalOf）去掉它，
 * 合法的标注就不会被当成"被改了"（留下的那一处）。
 */
function resolveInput(record, event, surface, splices, originalOf) {
    const data = event.data
    if (!isRecord(data)) return null
    if (!sameSurfaceCopy(event, surface.get(event.seq))) return null
    const inserted = splices.get(record.nativeSeq)
    if (inserted === undefined) return null
    const original = inserted.find(message => isRecord(message)
        && message.id === record.nativeMessageId
        && isRecord(message.source)
        && message.source.kind === 'user'
        && message.source.rpcId === record.requestId)
    if (original === undefined) return null
    const originalInput = userInputOf(original)
    if (originalInput === null) return null
    // 原文用原生 user content 加原平台身份重算指纹，必须与接收时持久值一致；合并准入的首条
    // 核对合并后正文的指纹。
    const expected = isNonEmptyString(record.admittedFingerprint) ? record.admittedFingerprint : record.fingerprint
    if (incomingFingerprintOf({ ...record, ...originalInput }) !== expected) return null
    if (data.id !== record.nativeMessageId) return null
    if (!sameInput(userInputOf({ ...data, content: originalOf(data) }), originalInput)) return { changed: true }
    return originalInput
}

/**
 * 把该回合成批：每个 binding 一份，锚点取该批中最后一条真实 user/message。
 * 发到手机的只是这一轮最后一段文字：最后一条模型消息的最后一个文本块，也就是最后一次工具调用之后写的话。
 * 工具调用之间的过程留在桌面，一轮之中要先告诉对方的走立即发出。整轮全部文字记在 `legacy` 里，
 * 供升级前已经开始投递的批次核对。一个字也没写、也没交付文件的一轮发一句固定说明（`noText`），
 * 免得对方什么都收不到。
 */
function collectTurn(open, endSeq, endTime, batches) {
    const last = open.assistants.at(-1)
    const noText = last === undefined && open.files.length === 0
    const text = last !== undefined ? last.segments.at(-1) : noText ? NO_TEXT_NOTE : ''
    const sourceSeqs = last !== undefined ? [last.seq] : noText ? [endSeq] : [...open.fileSeqs]
    const legacy = {
        text: open.assistants.map(item => item.text).join('\n'),
        sourceSeqs: open.assistants.length > 0 ? open.assistants.map(item => item.seq) : [...open.fileSeqs],
    }
    const perBinding = new Map()
    for (const input of open.inputs) {
        const list = perBinding.get(input.record.bindingId)
        if (list === undefined) perBinding.set(input.record.bindingId, [input])
        else list.push(input)
    }
    for (const [bindingId, inputs] of perBinding) {
        const anchor = inputs[inputs.length - 1]
        batches.push({
            bindingId,
            turn: open.turn,
            endSeq,
            sourceSeqs: [...sourceSeqs],
            inputRequestIds: inputs.map(input => input.record.requestId),
            text,
            ...noText ? { noText: true, endTime } : {},
            legacy: { text: legacy.text, sourceSeqs: [...legacy.sourceSeqs] },
            files: [...open.files],
            // 合并准入的一组锚定其最后一条原件。
            anchorKey: isNonEmptyString(anchor.record.replyAnchorKey) ? anchor.record.replyAnchorKey : anchor.record.anchorKey,
        })
    }
}

/**
 * 会话里最近一条桌面输入：来源为用户、带 rpcId、不是渠道准入过的输入，也不是外部调用方说的（框架核心把它的出处标成
 * `speaker.kind === 'external'`）。
 * @param {unknown} events - SessionObservation.events
 * @param {unknown} incomingRecords - 已持久 incoming 记录
 * @returns {{ seq: number, time: number } | null}
 */
export function latestDesktopInput(events, incomingRecords) {
    if (!Array.isArray(events) || !Array.isArray(incomingRecords)) return null
    const channel = channelInputs(incomingRecords)
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (!isRecord(event) || event.type !== 'user/message' || !isSeq(event.seq)) continue
        // 渠道转入的不算；外部调用方（核心标的出处是 external，不看请求号）经入口说的也不算用户在桌面。
        if (inputOrigin(isRecord(event.data) ? event.data.source : undefined, channel)?.from !== 'desktop') continue
        return { seq: event.seq, time: typeof event.time === 'number' ? event.time : 0 }
    }
    return null
}

/**
 * 提取每个真实 completed 回合的回复批。
 * @param {unknown} events - SessionObservation.events（只读数组，含真实 seq）
 * @param {unknown} currentSurfaceEvents - readSurface().events（当前 surface，用于排除撤下/替换文本）
 * @param {unknown} incomingRecords - 已持久 incoming 记录（只取 state='accepted'）
 * @param {Function} options.original - 消息的原文内容块（`core.provenance.original`）。
 * @param {Array<object>} [options.blocked] - 给了就收下"完成了、有渠道输入、却因核对不过不发"的轮：
 *   `{ turn, endSeq, endTime, reason }`，`reason` 是 `ambiguous`（同一请求号归属几个绑定）、`unresolved`（原件引用对不上）、
 *   `changed`（这条输入进会话前正文被改过）或 `surface`（模型文字和当前会话视图对不上）。这些轮不发，要让人看得见。
 * @returns {Array<{bindingId: string, turn: number, endSeq: number, sourceSeqs: number[]},
 *   inputRequestIds: string[], text: string, files: string[], anchorKey: string}>}
 */
export function extractReplyBatches(events, currentSurfaceEvents, incomingRecords, { original, blocked } = {}) {
    // 去来源标注的规则只在核心一份（`core.provenance.original`），这里不给就不比，免得悄悄退回不去标注的比法。
    if (typeof original !== 'function') throw new TypeError('extractReplyBatches 要 original：用 core.provenance.original')
    if (!Array.isArray(events) || !Array.isArray(currentSurfaceEvents) || !Array.isArray(incomingRecords)) {
        return []
    }
    const surface = new Map()
    for (const event of currentSurfaceEvents) {
        if (!isRecord(event) || !isSeq(event.seq)) continue
        surface.set(event.seq, event)
    }
    // 原生 Inbox 插入事件：seq -> inserted[]，只用于核对 incoming.nativeSeq。
    const splices = new Map()
    for (const event of events) {
        if (!isRecord(event) || event.type !== INBOX_SPLICED_EVENT || !isSeq(event.seq)) continue
        const inserted = isRecord(event.data) ? event.data.inserted : undefined
        if (Array.isArray(inserted)) splices.set(event.seq, inserted)
    }
    const inputs = new Map()
    const ambiguous = new Set()
    for (const record of incomingRecords) {
        if (!isRecord(record)) continue
        // 只有真实持久准入过、且带真实原生引用的输入才能对上原件。
        if (record.state !== 'accepted') continue
        // 并入首条的原件由首条代表，不单独参与归属。
        if (record.mergedInto !== undefined) continue
        if (!isNonEmptyString(record.requestId)) continue
        if (!isNonEmptyString(record.bindingId)) continue
        if (!isNonEmptyString(record.anchorKey)) continue
        if (!isNonEmptyString(record.nativeMessageId)) continue
        if (!isSeq(record.nativeSeq)) continue
        if (!isNonEmptyString(record.fingerprint)) continue
        const previous = inputs.get(record.requestId)
        if (previous !== undefined && previous.bindingId !== record.bindingId) {
            ambiguous.add(record.requestId)
            continue
        }
        inputs.set(record.requestId, record)
    }
    if (inputs.size === 0) return []

    const batches = []
    let open = null
    for (const event of events) {
        if (!isRecord(event) || !isSeq(event.seq)) continue
        const data = event.data
        if (event.type === 'turn/start') {
            // 缺 turn/start↔turn/end 边界的事件不成批。
            open = isRecord(data) && isTurn(data.turn)
                ? { turn: data.turn, inputs: [], assistants: [], files: [], fileSeqs: [], blocked: false, channel: false }
                : null
            continue
        }
        if (open === null) continue
        if (event.type === 'user/message') {
            if (!isRecord(data)) continue
            const source = data.source
            if (!isRecord(source) || source.kind !== 'user' || !isNonEmptyString(source.rpcId)) continue
            if (data.role !== undefined && data.role !== 'user') continue
            const record = inputs.get(source.rpcId)
            if (record === undefined) {
                // 同一 requestId 归属多个 binding：不猜，整回合不发送。
                if (ambiguous.has(source.rpcId)) {
                    open.blocked ||= 'ambiguous'
                    open.channel = true
                }
                continue
            }
            open.channel = true
            const resolved = resolveInput(record, event, surface, splices, original)
            if (resolved === null || resolved.changed === true) {
                // 引用不可解析、或正文被改过：不能广播这一回合的回复。
                open.blocked ||= resolved === null ? 'unresolved' : 'changed'
                continue
            }
            open.inputs.push({ seq: event.seq, record })
            continue
        }
        if (event.type === 'assistant/message') {
            if (!isRecord(data)) continue
            if (data.interrupted === true) continue
            if (isTurn(data.turn) && data.turn !== open.turn) continue
            const segments = modelSegmentsOf(data.message)
            const text = segments.join('\n')
            if (text.trim() === '') continue
            // 每个模型文本事件必须与观察 cut 的同一 seq/type/id/内容一致，否则该回合不广播。
            if (!sameSurfaceCopy(event, surface.get(event.seq))) {
                open.blocked ||= 'surface'
                continue
            }
            open.assistants.push({ seq: event.seq, text, segments })
            continue
        }
        if (event.type === PRESENTED_EVENT) {
            // 本轮用 present 交付的文件：渠道把文件本身发过去。
            const files = isRecord(data) && Array.isArray(data.files) ? data.files : []
            if (files.length > 0) open.fileSeqs.push(event.seq)
            for (const file of files) {
                if (isRecord(file) && isNonEmptyString(file.path) && !open.files.includes(file.path)) open.files.push(file.path)
            }
            continue
        }
        if (event.type === 'turn/end') {
            const matched = isRecord(data) && data.turn === open.turn
            const reason = isRecord(data) ? data.reason : undefined
            const completed = isRecord(reason) && reason.kind === 'completed'
            if (matched && completed && !open.blocked) collectTurn(open, event.seq, event.time, batches)
            else if (matched && completed && open.channel && blocked !== undefined) {
                blocked.push({ turn: open.turn, endSeq: event.seq, endTime: event.time, reason: open.blocked })
            }
            open = null
        }
    }

    batches.sort((left, right) => {
        if (left.endSeq !== right.endSeq) return left.endSeq - right.endSeq
        if (left.bindingId === right.bindingId) return 0
        return left.bindingId < right.bindingId ? -1 : 1
    })
    return batches
}

/**
 * 会话里没有渠道输入的已完成轮：中枢的这些轮的回复默认也发到用户手机。
 * 有任何一条渠道准入过的输入（真实消息、转交、等待提醒；按原件记下的请求号，或渠道准入请求号的前缀认）的轮
 * 已经由 `extractReplyBatches` 按原逻辑成批，这里一概不取，同一轮不会发两遍。
 * 取的文字与成批相同：最后一条模型消息的最后一个文字块；没有文字也没有交付文件的轮不取（不发固定说明）。
 *
 * `byUser`：这一轮该不该算用户自己触发（休息时段里只有它立即发，其余攒到时段结束）：
 * - 这一轮里有用户在 DSH 桌面上输入的话（来源为用户、带请求号、不是渠道准入、也不是外部调用方说的）；
 * - 或者在它之前，用户自己说的话（桌面输入或渠道里的真实消息）所在的那一轮没有正常结束，之后也还没有哪一轮正常结束过：
 *   这一轮是在接着回用户的话（例如额度恢复后唤醒的那一轮）。
 * @returns {Array<{turn: number, endSeq: number, endTime: number|undefined, sourceSeqs: number[], text: string,
 *   files: string[], byUser: boolean}>}
 */
export function extractSessionTurns(events, currentSurfaceEvents, incomingRecords) {
    if (!Array.isArray(events) || !Array.isArray(currentSurfaceEvents) || !Array.isArray(incomingRecords)) return []
    const surface = new Map()
    for (const event of currentSurfaceEvents) {
        if (isRecord(event) && isSeq(event.seq)) surface.set(event.seq, event)
    }
    const channel = channelInputs(incomingRecords)
    const turns = []
    let open = null
    let userPending = false
    for (const event of events) {
        if (!isRecord(event) || !isSeq(event.seq)) continue
        const data = event.data
        if (event.type === 'turn/start') {
            open = isRecord(data) && isTurn(data.turn)
                ? { turn: data.turn, assistants: [], files: [], fileSeqs: [], channel: false, desktop: false, userInput: false, blocked: false }
                : null
            continue
        }
        if (open === null) continue
        if (event.type === 'user/message') {
            const origin = inputOrigin(isRecord(data) ? data.source : undefined, channel)
            if (origin === null) continue
            if (origin.from === 'channel') open.channel = true
            if (origin.from === 'desktop') open.desktop = true
            if (origin.own) open.userInput = true
            continue
        }
        if (event.type === 'assistant/message') {
            if (!isRecord(data) || data.interrupted === true) continue
            if (isTurn(data.turn) && data.turn !== open.turn) continue
            const segments = modelSegmentsOf(data.message)
            if (segments.join('\n').trim() === '') continue
            if (!sameSurfaceCopy(event, surface.get(event.seq))) {
                open.blocked = true
                continue
            }
            open.assistants.push({ seq: event.seq, segments })
            continue
        }
        if (event.type === PRESENTED_EVENT) {
            const files = isRecord(data) && Array.isArray(data.files) ? data.files : []
            if (files.length > 0) open.fileSeqs.push(event.seq)
            for (const file of files) {
                if (isRecord(file) && isNonEmptyString(file.path) && !open.files.includes(file.path)) open.files.push(file.path)
            }
            continue
        }
        if (event.type === 'turn/end') {
            const matched = isRecord(data) && data.turn === open.turn
            const reason = isRecord(data) ? data.reason : undefined
            const completed = matched && isRecord(reason) && reason.kind === 'completed'
            if (completed && !open.blocked && !open.channel) {
                const last = open.assistants.at(-1)
                const text = last === undefined ? '' : last.segments.at(-1)
                if (text.trim() !== '' || open.files.length > 0) {
                    turns.push({
                        turn: open.turn,
                        endSeq: event.seq,
                        endTime: typeof event.time === 'number' ? event.time : undefined,
                        sourceSeqs: last === undefined ? [...open.fileSeqs] : [last.seq],
                        text,
                        files: [...open.files],
                        byUser: open.desktop || userPending,
                    })
                }
            }
            if (completed) userPending = false
            else if (open.userInput) userPending = true
            open = null
        }
    }
    return turns
}

/** 中日韩文字与全角标点：出口检查里一段话只要含有它们就不算英文旁白。 */
const CJK_PATTERN = /[⺀-⿟　-〿぀-ヿ㄀-ㄯ㐀-䶿一-鿿豈-﫿＀-￯]/
/** 像命令的开头：不是旁白。 */
const COMMAND_PATTERN = /^(\$|>|PS\s|npm|pnpm|npx|node|git|python|py|pip|cd|ls|dir|cat|curl|winget|choco|powershell|pwsh|cmd|codex|claude)\b/i

/**
 * 出口检查（只记录、不改回复）：一段回复文字里一两行、完全不含中文的句子，可能是模型写的英文过程旁白。
 * 按空行分段，只看一两行的段；代码块、缩进代码、引用（`>`）、表格、整段加引号的原文、像命令的行不算；
 * 去掉行内代码、链接、网址与路径以后，剩下的要至少有四个英文单词、几乎没有代码符号才算。
 * @param {unknown} text - 实际发出去的一片文字
 * @returns {string[]} 可疑的段落原文
 */
export function englishAsides(text) {
    if (typeof text !== 'string' || text.trim() === '') return []
    const body = text.replace(/```[\s\S]*?(```|$)/g, '\n\n')
    const found = []
    for (const paragraph of body.split(/\n[ \t]*\n/)) {
        const lines = paragraph.split('\n').filter(line => line.trim() !== '')
        if (lines.length === 0 || lines.length > 2) continue
        if (lines.some(line => /^( {4}|\t)/.test(line) || /^\s*(>|\|)/.test(line))) continue
        const joined = lines.map(line => line.trim()).join(' ')
        if (CJK_PATTERN.test(joined)) continue
        const sentence = joined.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^#+\s+/, '')
        if (/^["'“‘「].*["'”’」]$/.test(sentence) || COMMAND_PATTERN.test(sentence)) continue
        const plain = sentence
            .replace(/`[^`]*`/g, ' ')
            .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
            .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
            .replace(/\bwww\.\S+/gi, ' ')
            .replace(/\b[A-Za-z]:[\\/]\S*/g, ' ')
            .replace(/(^|\s)[.~]?[\\/]\S+/g, ' ')
            .replace(/\S+[\\/]\S+/g, ' ')
        const words = plain.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []
        if (words.length < 4) continue
        if ((plain.match(/[{}();=<>[\]]/g) ?? []).length > 2) continue
        found.push(joined)
    }
    return found
}

/**
 * 按 Unicode 码点与自然换行分块，默认 1000 字符，不截断内容。
 * @param {unknown} text - 待发送的完整回复
 * @param {number} [limit] - 每块最大码点数
 * @returns {string[]} 顺序拼接后与原文完全一致的分块
 */
export function splitReplyText(text, limit = 1000) {
    if (typeof text !== 'string' || text === '') return []
    if (!Number.isSafeInteger(limit) || limit < 1) return []
    const points = Array.from(text)
    const parts = []
    let start = 0
    while (start < points.length) {
        const remaining = points.length - start
        if (remaining <= limit) {
            parts.push(points.slice(start).join(''))
            break
        }
        const window = points.slice(start, start + limit)
        let cut = -1
        for (let index = window.length - 1; index > 0; index -= 1) {
            if (window[index] === '\n') {
                cut = index
                break
            }
        }
        const size = cut > 0 ? cut + 1 : limit
        parts.push(points.slice(start, start + size).join(''))
        start += size
    }
    return parts
}
