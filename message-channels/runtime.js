/**
 * QQ/微信共享渠道运行态（channel-runtime）
 *
 * 有界 owner：已配对本人私聊 → 精确 binding（固定 sessionId）→ 该普通会话准入 →
 * 该回合真实完成回复 → 准确平台锚点。平台对象、准入
 * helper（createIngress）与已打开的 storageDomain 都由 Host 传入；本模块不启动
 * Agent handle、不关闭 domain、不缓存凭据。启动时只有存在已保存且启用的 binding 才按
 * `sessionQuery.observeSession` 核对 binding.sessionId 的真实普通会话并开始 listen；只有首次配对才由渠道自己 `sessionController.create` 一次
 * 默认会话并保存实际返回的 id，没有 binding 时不创建 Session/Agent/配对。
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import { CHANNEL_RELAY_PREFIX, NUDGE_ID_PREFIX, RELAY_ID_PREFIX, englishAsides, relayedInput, extractReplyBatches, extractSessionTurns, incomingFingerprintOf, latestDesktopInput, splitReplyText } from './replies.js'
import { composeImages } from './compose.js'
import { IMAGE_MEDIA_TYPES, MAX_OUTBOUND_IMAGE_BYTES, plainFileLinks, readOutboundFile, readOutboundImage, readOutboundVoice, splitReplySegments } from './media.js'
import { QUOTA_NOTICE_DEFAULTS, quotaKey, quotaNoticeText, scopesOfKey, usageKey, usageWarningText, warningLevel } from './quota-notices.js'

/** 内置的平台：官方 QQ 机器人、微信。别的平台由插件经 `registerPlatform` 登记（README“接新平台”）。 */
export const BUILTIN_PLATFORMS = Object.freeze(['qq', 'weixin'])
/** 平台名：小写字母开头，字母、数字、连字符。它也是绑定、凭据键里的名字，登记过就不要再改。 */
const PLATFORM_ID = /^[a-z][a-z0-9-]*$/
/** 内置平台对方看到的渠道名；登记的平台用登记时给的。 */
const BUILTIN_LABELS = Object.freeze({ qq: 'QQ', weixin: '微信' })

/** 用户正在配对或扫码：不算断开，也不去重连。 */
const PAIRING_PHASES = new Set(['pairing', 'waiting', 'scanned', 'need-verify', 'choose-account'])
/** 自己重连一次的结果说法。 */
const RECONNECT_WORDS = Object.freeze({ reconnecting: '已重连一次', pairing: '正在配对，没有重连', unbound: '没有绑定，没有重连', closed: '渠道已关闭' })
/** 渠道自己报的异常类别（渠道经框架核心的 core.report 报，谁来收由核心管）。 */
export const CHANNEL_REPORTS = Object.freeze({
    down: 'channels/down',
    undelivered: 'channels/undelivered',
    englishAside: 'channels/english-aside',
    replyBlocked: 'channels/reply-blocked',
    // 一个绑定连着几片被平台确定没发出、暂停一阵，以及恢复。
    accountPaused: 'channels/account-paused',
    accountResumed: 'channels/account-resumed',
    // 平台拒收，这条消息回不了了（平台声明 `rejectEndsReplies`）：带平台的原话和已经送达几片。
    repliesEnded: 'channels/replies-ended',
    // 平台转来的报警（`onAlert`）格式不对，没有转报。
    alertInvalid: 'channels/alert-invalid',
})

/**
 * 一个平台断开太久时，经别的渠道告诉对方的固定说明。`returns`：它排在回复先后（`replyOrder`）的第一位，恢复后会自动回到它。
 */
export const downNoticeOf = (word, returns) => `（${word}断开了，我暂时在这里回你${returns ? `；${word}恢复后会自动回到${word}` : ''}。）`

/** 会话一轮的开始超过这么久还没等到结束，就不再当作忙（事件丢失时不至于一直扣着消息）。 */
const BUSY_STALE_MS = 60 * 60_000

/** 凭据域固定为 galatea-channels（JS 字符串即公开 brand 值）。 */
const CREDENTIAL_SCOPE = 'galatea-channels'

/** 键派生域标签：改动编码方式时递增（账户键同时绑定 bindingId）。 */
const ACCOUNT_KEY_DOMAIN = 'galatea-channels/account/2'
const ANCHOR_KEY_DOMAIN = 'galatea-channels/anchor/2'
const INCOMING_KEY_DOMAIN = 'galatea-channels/incoming/1'
const DELIVERY_ID_DOMAIN = 'channel-delivery/1'

/** 渠道自有默认会话关联只占一行；键是固定字面量，不按平台分表，也不复制 works 私表。 */

/** 分块、QQ 被动回复上限、相邻发送最小间隔。 */
const REPLY_CHUNK_LIMIT = 1000

/** 助手判断对方话没说完时的整条回复；渠道不发送它。 */
export const WAIT_MARKERS = Object.freeze(['[等待]', '【等待】'])
/** 助手决定这一轮不发到手机时的整条回复：渠道照等待标记一样吞掉，不发、不等、不提醒。 */
export const NO_SEND_MARKERS = Object.freeze(['[不发]', '【不发】'])
/**
 * 中枢的话没走排在回复先后（`replyOrder`）第一位的渠道、而这个会话接着它时，写在那条消息开头的说明（`rerouteNote` 开着时）。
 * 参数都是写给对方看的渠道名。
 */
export const rerouteNoteOf = (preferred, via) => `（${preferred}现在发不出，这条改从${via}发。）`
/** 一片被平台确定没发出、改经别的渠道发出时，写在改道那条开头的说明；同一批只说一次。参数是渠道名。 */
export const rejectedNoteOf = (from, via) => `（${from}没发出去，这条改从${via}发。）`
/** 改道的是图片、文件、语音时，在它前面另发一片的说明（正文是本机路径，没法在开头加字）。 */
export const rejectedMediaNoteOf = (from, via, kind) => `（${from}没发出去，下面${MEDIA_WORDS[kind] ?? '这个文件'}改从${via}发。）`
const MEDIA_WORDS = Object.freeze({ image: '这张', file: '这个文件', voice: '这段语音' })

export { NUDGE_ID_PREFIX, RELAY_ID_PREFIX }
export const NUDGE_TEXT = '（对方已经有一阵没有继续发消息了。请现在正常回复，不要再回复等待标记。）'
/** 群会话身份的前缀（支持群的平台都用它）：`group:<群号>`。 */
export const GROUP_PREFIX = 'group:'

/**
 * 经历库里一次中途发送（或渠道自己发的一条说明）的条目（来源 `channel-pushes`）：同一次发送的几片合成一条，
 * 没发出去的注明；渠道自己的固定说明记成"渠道提醒"。编号是 `push:<会话>:<绑定>:<endSeq>`。外部调用方经端点发的，写明是哪个名字。
 * @param rows - 同一次发送的片（`push: true`，同会话、同绑定、同 endSeq）。
 * @returns 条目；没有文字时为 null。
 */
export function pushEntryOf(rows, label) {
    const parts = [...rows].sort((left, right) => (left.partIndex ?? 0) - (right.partIndex ?? 0))
    const [row] = parts
    if (row === undefined) return null
    const body = pushBodyOf(parts)
    if (body === '') return null
    const sent = parts.some(part => part.state === 'sent')
    const by = row.by?.kind === 'external' ? `（外部调用方 ${row.by.name ?? '未注明'} 经端点发的）\n` : ''
    return {
        id: `push:${row.sessionId}:${row.bindingId}:${row.endSeq}`,
        thread: row.sessionId,
        at: row.endSeq,
        tie: 0,
        party: label ?? '渠道',
        ...row.system !== undefined ? { role: 'system', kind: '渠道提醒' } : { role: 'assistant', kind: '中途发给用户' },
        text: `${by}${body}${sent ? '' : '\n\n（没有发出去）'}`,
    }
}

/** 一次中途发送的几片拼成的文字；图片、语音写占位。 */
function pushBodyOf(parts) {
    return parts.map(part => (part.kind === 'voice' ? '[语音]' : part.kind === 'image' ? '[图片]' : String(part.text ?? ''))).join('\n').trim()
}

/** 渠道自己放进会话的通知（群没接上、群解绑过、群接的会话不在了）的来源；登记在插件入口。 */
export const CHANNEL_NOTICE_SOURCE = 'channel-notice'
/** 渠道这个程序（放进会话的通知记成它说的）。 */
export const CHANNEL_SPEAKER = Object.freeze({ kind: 'program', plugin: 'message-channels-framework' })
/** 群没有绑定成功时，转交给中枢的说明里的原因（每个群、每种原因只说一次）；群解析规则自己给的原因照它的写。 */
const GROUP_UNBOUND_REASONS = Object.freeze({
    NO_RULE: '这个群还没接会话',
    NO_SESSION: '按规则要接的会话已经打不开',
    SESSION_TAKEN: '按规则要接的会话已经接了别的群（一个会话只接一个群）',
})
/** 改动一个平台的群绑定（自动绑定、工具、设置页解绑）共用的串行链：一对一的检查与写入不会被并发绕过。 */
const groupsChain = platform => `groups:${platform}`

/**
 * 平台 `onMessage` 的结果（resolve 的 `{ status }`）：
 * `persisted` 原件与锚点已持久；`duplicate` 同一身份同一正文早已持久；`rejected` 确定不收（例如绑不上的群，已经或不必说明）；
 * `conflict` 同一身份来了不同正文（原件已持久标冲突，不覆盖、不再参与回复）；
 * `retry` 这次没存下、稍后重送再试（例如宿主暂时查不了项目）。除 `retry` 外平台都可以确认这条已处理完。
 * 抛错表示运行态持久失败，平台应停止收件并上报。
 */
export const RECEIVE = Object.freeze({ PERSISTED: 'persisted', DUPLICATE: 'duplicate', REJECTED: 'rejected', CONFLICT: 'conflict', RETRY: 'retry' })
/** 任务会话的编号前缀（项目任务插件）：任务会话不能接群。 */
const TASK_SESSION_PREFIX = 'session-task-'
/** 任务进度：每个群滚动 24 小时最多发这么多条；事件发生超过 6 小时不再发。 */
const TASK_NOTICE_LIMIT = 20
const TASK_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000
const TASK_NOTICE_STALE_MS = 6 * 60 * 60 * 1000
/** 渠道自己发的群消息（绑定确认、会话不在了、任务进度）的投递身份域与锚点身份。 */
const SYSTEM_DELIVERY_DOMAIN = 'channel-system-delivery/1'
const SYSTEM_ANCHOR_ID = 'system'

/** 群里的固定说明（不经模型）。 */
export const GROUP_NOTICES = Object.freeze({
    bound: title => `（这个群接到「${title}」了，之后在这里说的话由它来回。）`,
    rebound: title => `（这个群改接「${title}」了，之后在这里说的话由它来回。）`,
    unbound: () => '（这个群已经解绑，在这里说的话我先不处理了。要重新接上，跟我说一声。）',
    gone: (title, reason) => `（这个群原来接的「${title}」${reason === 'deleted' ? '已经删除了' : '已经归档了'}，刚才的话我先转到中枢。要改接哪个会话，直接说一声。）`,
})
/** 留待下次的片超过这么久还没发出就不再发。 */
const DEFERRED_TTL_MS = 24 * 60 * 60 * 1000
/** 留待下次的片的投递身份从这里编号，不与本批的片重叠。 */
const DEFERRED_PART_BASE = 1000
/** 改经别的渠道发出的片：投递身份从这里编号，按原来那一批与片的位置定，换了承载的渠道也不会重发。 */
const DETOUR_PART_BASE = 2000
/**
 * 平台确定没发出、改经同一范围里别的渠道发出的片：投递身份从这里加上原来那一片的位置编号（留待片的位置从 1000 起，
 * 落在 4000 以后），与按能力改道的片（2000 起）分开；原来那一片只对应这一条，不会改第二次道。
 */
const REROUTE_PART_BASE = 3000
/** 改道的是图片、文件、语音时在它前面插的那片说明：从这里加上原来那一片的位置编号，重启后认得出已经插过。 */
const REROUTE_NOTE_PART_BASE = 6000
/** 平台拒收、又没有别的渠道能接，留到对方下一条消息之后的片：投递身份从这里加上原来那一片的位置编号。 */
const HELD_PART_BASE = 4000
/** 没有渠道能发文件时按文字发出的文本文件：扩展名与大小上限。 */
const TEXT_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log'])
const TEXT_FILE_LIMIT = 64 * 1024
/** 内容种类的说法（给会话的说明）。 */
const KIND_WORDS = Object.freeze({ image: '图片', file: '文件', voice: '语音' })
/** 附给会话的未送达说明最多列几批。 */
const UNDELIVERED_NOTICE_LIMIT = 5
/** 失败多久以内的回复还会叫醒会话：再早的只附给会话、等它的下一轮。 */
const UNDELIVERED_WAKE_MS = 24 * 60 * 60 * 1000
/** 叫醒会话的那条话的编号前缀：认出"这一轮是被叫醒来处理未送达的"（防循环）。 */
const UNDELIVERED_WAKE_PREFIX = 'channel-wake-'
/** 叫醒会话的那条话：详情在附提醒里。 */
const UNDELIVERED_WAKE_TEXT = '（消息渠道：有回复没送到对方手机，详见渠道提示。需要的话现在重发；不用重发就整条只写 [不发]。）'
/** 回复没送到、平台现在能主动发时立即开的那一轮：转交键的前缀（后接绑定、轮次与结束序号，一批只开一次）。 */
export const UNDELIVERED_RELAY_KEY = 'undelivered-'
/** 给会话的渠道提示（未送达、后来有结果、改了发法）附在核心的附提醒里用的键：每个会话一条，变了就覆盖。 */
export const NOTICE_KEY = 'channel-notice'
/** 立即补告只给这么久以内的失败：更早的（例如升级前留下的）照旧等对方下一条消息。 */
/** 模型请求开始重试时发给对方的固定说明，按失败类别（DSH 的 LlmFailure.code）。 */
const STALL_NOTICES = Object.freeze({
    TRANSPORT: '（网络断了，我这边暂时连不上。恢复后会自动接着回这条，不用重发。）',
    TIMEOUT: '（网络断了，我这边暂时连不上。恢复后会自动接着回这条，不用重发。）',
    RATE_LIMIT: '（模型服务暂时限流，我在等着重试。恢复后会自动接着回这条，不用重发。）',
    SERVER: '（模型服务暂时出错，我在等着重试。恢复后会自动接着回这条，不用重发。）',
})
const SEND_GAP_MS = 2000
/**
 * 配对结果的保存（建绑定、开始收件）最多等这么久：卡住时结束这次尝试并报 PAIR_SAVE_TIMEOUT，
 * 设置页不会一直停在“连接中”。晚到的保存看到尝试已结束，会停用它写下的绑定。
 */
const PAIR_COMMIT_TIMEOUT_MS = 60_000

/** listen 网络退避：有限次、可取消；鉴权类明确失败不再重试。 */
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 16000
const LISTEN_RETRY_LIMIT = 4
const FATAL_LISTEN_CODES = new Set([
    'OWNER_UNVERIFIED',
    'AUTH_FAILED',
    'AUTH_REQUIRED',
    'CREDENTIAL_INVALID',
    'CREDENTIAL_REVOKED',
    'UNAUTHORIZED',
    'FORBIDDEN',
])

/** 渠道运行态稳定错误码。消息文本固定，不带凭据、URL 或平台响应体。 */
export class ChannelRuntimeError extends Error {
    constructor(code, message, options) {
        super(message, options)
        this.name = 'ChannelRuntimeError'
        this.code = code
    }
}

function fail(code, message, options) {
    throw new ChannelRuntimeError(code, message, options)
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== ''
}

function isSeq(value) {
    return Number.isSafeInteger(value) && value >= 0
}

function isAbortError(error) {
    return isRecord(error) && error.name === 'AbortError'
}

function abortError() {
    const error = new Error('操作已取消')
    error.name = 'AbortError'
    return error
}

/** 稳定错误码：只接受 UPPER_SNAKE 形式的平台 code，其余收敛为固定 fallback。 */
function stableErrorCode(error, fallback) {
    if (isRecord(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code)) {
        return error.code
    }
    return fallback
}

/**
 * 官方 session-query 唯一的 session-not-found code：只有它才等于“这条会话不存在”的结论。
 * `SESSION_QUERY_EVENT_NOT_FOUND` 等后缀相似的 code 说的是别的东西不存在，绝不算 absence。
 */
const SESSION_QUERY_ABSENT_CODE = 'SESSION_QUERY_SESSION_NOT_FOUND'

/**
 * 只有官方 `SessionQueryError` 的唯一 session-not-found 才判 absence：类名与官方 code 都要逐字
 * 对得上，绝不按 message 文本推断、也不按 code 后缀推断；event-not-found、IO/权限/损坏等其它
 * 异常都不是“不存在”，而是“无法核对”。
 */
function isSessionQueryNotFound(error) {
    if (!isRecord(error) || error.name !== 'SessionQueryError') return false
    if (typeof error.code !== 'string') return false
    return error.code === SESSION_QUERY_ABSENT_CODE
}

function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 平台账户授权键：官方 credentialKey(scope,id) builder，id 以字母开头的
 * 'account-'+hash。hash 同时绑定 bindingId，新配对与旧授权天然隔离。
 */
function accountCredentialKey(platform, accountId, bindingId) {
    const digest = sha256(JSON.stringify([ACCOUNT_KEY_DOMAIN, platform, accountId, bindingId]))
    return credentialKey(CREDENTIAL_SCOPE, `account-${digest}`)
}

/** 锚点键：按精确 incoming 来源（bindingId + 平台原消息身份）派生。 */
function anchorCredentialKey(bindingId, platformMessageId) {
    const digest = sha256(JSON.stringify([ANCHOR_KEY_DOMAIN, bindingId, platformMessageId]))
    return credentialKey(CREDENTIAL_SCOPE, `anchor-${digest}`)
}

/** 群绑定在表里的键：存储键只允许字母、数字、下划线和连字符。 */
function groupBindingKey(platform, conversationId) {
    return `${platform}-group-${conversationId.slice(GROUP_PREFIX.length)}`
}

function isGroupConversation(conversationId) {
    return typeof conversationId === 'string' && conversationId.startsWith(GROUP_PREFIX)
        && /^\d+$/.test(conversationId.slice(GROUP_PREFIX.length))
}

/** 回复被挡下的原因（`extractReplyBatches` 的 `blocked`）。 */
const BLOCKED_REASONS = Object.freeze({
    ambiguous: '同一个请求号归属几个绑定，认不出该发给谁',
    unresolved: '这一轮的渠道输入对不上收件箱里的原件',
    changed: '这一轮的渠道输入进会话前正文被改过（例如在桌面上编辑了排队的消息）',
    surface: '模型写的文字和当前会话视图对不上（可能被撤下或替换）',
})

/** 收件行是不是对方在平台上发的真实原件：不是等待到期时的代为提醒，也不是代为转交的输入。 */
function platformOriginal(row) {
    return !relayedInput(row.platformMessageId)
}

function incomingKeyOf(bindingId, platformMessageId) {
    return sha256(JSON.stringify([INCOMING_KEY_DOMAIN, bindingId, platformMessageId]))
}

/**
 * 官方 per-record 存储键只允许字母、数字、下划线和连字符。
 * 域标签与精确来源共同参与摘要，同一批次分片在重启后保持相同投递身份。
 */
function deliveryIdOf(batch, partIndex) {
    const digest = sha256(JSON.stringify([
        DELIVERY_ID_DOMAIN,
        batch.bindingId,
        batch.sessionId,
        batch.turn,
        batch.endSeq,
        partIndex,
    ]))
    return `delivery-${digest}`
}

/** 真实 JSON 值校验：凭据与锚点必须能原样进入 credentials 记录。 */
function isJsonValue(value, depth) {
    if (depth > 8) return false
    if (value === null) return true
    if (typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1))
    if (isRecord(value)) return Object.values(value).every(item => isJsonValue(item, depth + 1))
    return false
}

/** 平台凭据：非空字符串或可持久 JSON 对象，形状由平台自己决定。 */
function isCredentialValue(value) {
    if (typeof value === 'string') return value !== ''
    return isRecord(value) && isJsonValue(value, 0)
}

/* ------------------------------------------------------------------ *
 * 持久表严格 schema（Host defineDomain 复用）
 * ------------------------------------------------------------------ */

const platformSchema = z.string().regex(PLATFORM_ID)
const nonEmpty = z.string().min(1)
const createdAtSchema = z.number().int().nonnegative()

const bindingSchema = z.object({
    platform: platformSchema,
    bindingId: nonEmpty,
    accountId: nonEmpty,
    senderId: nonEmpty,
    conversationId: nonEmpty,
    sessionId: nonEmpty,
    credentialKey: nonEmpty,
    enabled: z.boolean(),
    // 平台自己的续收位置（例如微信的 `get_updates_buf`）：运行态不解析、不比较，只按平台给的原值存取；
    // 跟着绑定走（重新配对、断开时随绑定一起换掉或删掉）。用不着的平台从不写它。
    cursor: z.string().optional(),
    createdAt: createdAtSchema,
    // 群绑定（只有支持群的平台）：挂在这个私聊绑定上，借它的连接与凭据；会话是群解析规则或中枢的工具指定的。
    // conversationId 是 `group:<群号>`，表里的键是 `<平台>-group-<群号>`。群名只用于显示；projectTitle 只在旧行里有（以前按项目名自动绑定时写的）。
    ownerBindingId: nonEmpty.optional(),
    groupName: nonEmpty.optional(),
    projectTitle: nonEmpty.optional(),
    // 群可以接任意会话。sessionTitle 是绑定时的会话标题（只用于显示与说明）；unboundAt 是用户明确解绑的时间
    // （这一行 enabled 为 false，按群名自动绑定也跳过它）；gone 表示已经在群里说过“原会话不在了”。
    sessionTitle: nonEmpty.optional(),
    unboundAt: createdAtSchema.optional(),
    gone: z.object({
        sessionId: nonEmpty,
        reason: z.enum(['archived', 'deleted']),
        at: createdAtSchema,
    }).strict().optional(),
}).strict()

const incomingSchema = z.object({
    bindingId: nonEmpty,
    platformMessageId: nonEmpty,
    platform: platformSchema,
    accountId: nonEmpty,
    conversationId: nonEmpty,
    senderId: nonEmpty,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    // 只有图片的消息正文为空串；准入后与图片一起置空，原件留在原生会话里。
    text: z.string().nullable(),
    images: z.array(z.object({ mediaType: z.enum(IMAGE_MEDIA_TYPES), data: nonEmpty }).strict()).nullable().optional(),
    anchorKey: nonEmpty,
    // 合并准入：首条记下同批其余原件的键与合并后正文的指纹、回复锚点；其余原件指向首条。
    mergeKeys: z.array(nonEmpty).min(1).optional(),
    mergedInto: nonEmpty.optional(),
    admittedFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    replyAnchorKey: nonEmpty.optional(),
    // 首次准入前写下的未送达说明（接在正文后面）与它所说明的投递：重试时原样沿用，准入后把这些投递记为已告知。
    notice: nonEmpty.optional(),
    noticeIds: z.array(nonEmpty).min(1).optional(),
    // forwarded：群绑定的会话已被删除或归档，这条原件已经转交中枢（正文与图片在转交行里，这里清空）。
    state: z.enum(['queued', 'accepted', 'unknown', 'conflict', 'forwarded']),
    requestId: nonEmpty.nullable(),
    nativeMessageId: nonEmpty.nullable(),
    nativeSeq: z.number().int().nonnegative().nullable(),
    createdAt: createdAtSchema,
}).strict()

const receiptSchema = z.object({
    kind: z.literal('platform-accepted'),
    platformMessageId: nonEmpty.nullable(),
    clientId: nonEmpty.nullable(),
    // refIdx：平台用来指这条消息的另一个编号（QQ 官方引用时给的就是它）。
    refIdx: nonEmpty.optional(),
}).strict()

/** 引用标记里原文留多少字：注明开头和编号就够。 */
const QUOTE_HEAD_CHARS = 40
/** 按文字认引用时至少要这么多字，太短的认不准。 */
const QUOTE_MATCH_MIN_CHARS = 8

const outgoingSchema = z.object({
    bindingId: nonEmpty,
    sessionId: nonEmpty,
    turn: createdAtSchema,
    endSeq: createdAtSchema,
    sourceSeqs: z.array(createdAtSchema).min(1),
    inputRequestIds: z.array(nonEmpty).min(1),
    partIndex: createdAtSchema,
    partCount: z.number().int().positive(),
    // 图片、文件、语音片的 text 是本机路径；文字片不写 kind，与旧记录一致。
    // wait：助手只回复了等待标记，不发送；waitUntil 到期仍无新消息时提醒助手作答。
    kind: z.enum(['image', 'file', 'voice', 'wait']).optional(),
    waitUntil: z.number().int().nonnegative().optional(),
    // deferred：QQ 回复额度用完、留到对方下一条消息之后再发的片（deferredAt 为留下的时间）。
    // push：一轮之中由 assistant_channel_send 立即发出的片。
    deferred: z.boolean().optional(),
    deferredAt: z.number().int().nonnegative().optional(),
    push: z.boolean().optional(),
    // mainTurn：中枢里没有渠道输入的一轮的回复，借对方最近一条消息的锚点发出；同一轮只记在一个渠道名下。
    mainTurn: z.boolean().optional(),
    // system：渠道自己发的固定说明（task 任务进度，group 绑定确认与“会话不在了”，quota 额度用完与用量提醒，
    // stall 模型请求在等重试，account 一个平台断开太久的告警（名字沿用旧的），reroute 改道的图片、文件、语音前面插的那片说明），
    // 不是绑定会话写的话：不算回答了对方的消息，不进未送达说明，经历库记为渠道提醒。
    system: z.enum(['task', 'group', 'quota', 'stall', 'account', 'reroute']).optional(),
    // failedAt：这一片记为失败或结果不明的时间；reportedAt：已经告诉助手的时间（附给会话的提示在一轮正常结束、
    // 模型确实跑过以后才算告诉了；以前是写进对方下一条输入，或立即开一轮告诉）。
    // nextInputOnly：以前立即开一轮告诉助手、那一轮的回复也没送到时记的（防循环）；不再开轮，旧记录照读。
    // noticeAttached：这一片写进了附给会话的渠道提示：核心那里那条提示没了，就是告诉过了（重启后靠它补认）。
    failedAt: z.number().int().nonnegative().optional(),
    reportedAt: z.number().int().nonnegative().optional(),
    nextInputOnly: z.boolean().optional(),
    noticeAttached: z.boolean().optional(),
    // by：中途发送是谁发的（`core.caller`；语音是语音合成插件）。
    by: z.object({ kind: nonEmpty }).passthrough().optional(),
    // detour：这一片的渠道发不了这种内容，改经同一范围里现在能发的渠道发出；routeNote：改了发法时告诉会话的一句，
    // 和未送达说明一起附给会话，记下 reportedAt 后不再重复。
    detour: z.boolean().optional(),
    routeNote: nonEmpty.optional(),
    // reroutedTo：这一片被平台确定没发出（state 仍是 failed），改经同一范围里别的渠道发出时那条改道记录的投递编号。
    // 送没送到看那一条；有了它就不再改道（重启后也靠它认）。
    reroutedTo: nonEmpty.optional(),
    // lateNote：记成结果不明、已经告诉会话“可能已经送到”以后，平台才回了确定结果（发出或没发出）：附给会话
    // 补一句后来的结果，说过就去掉。
    lateNote: nonEmpty.optional(),
    // sentText：0.1.0-preview.1 的投递记录可能带着它（当时平台改写了文字就记下实际发出的那一版）。存储层按结构严格校验，
    // 去掉这个字段，旧记录就打不开、整个渠道起不来，所以照旧收下；现在不再写，也不读。
    sentText: z.string().optional(),
    waitState: z.enum(['waiting', 'nudged', 'superseded', 'final']).optional(),
    text: nonEmpty,
    anchorKey: nonEmpty,
    state: z.enum(['prepared', 'sending', 'sent', 'failed', 'unknown']),
    receipt: receiptSchema.nullable(),
    errorCode: nonEmpty.nullable(),
}).strict()

/**
 * 渠道自有的默认渠道会话关联：只有渠道在首次配对时自己创建的那条普通会话。
 * 不再读写（私聊绑到框架核心的中枢，渠道不再自己建会话）；表和数据留着，schema 只为打开表时校验。
 *
 * 单行（键固定 `CHANNEL_DEFAULT_KEY`）。只给最小状态，不是泛化事务框架：
 * - `requested`：create **之前**就落盘的创建请求身份（预留 id + 绝对工作目录）。此时还没有
 *   可用的会话关联，也还没有发出 create；重试、close 或重启都用同一个预留 id 核对，绝不换 id。
 * - `creating`：官方 create **调用之前**落盘的“已发出”阶段。这一行的存在本身就说明结果可能
 *   已经产生：恢复时先只读核对预留 id，核对不到就保留未确认，绝不再发出第二次 create。
 * - `created`：create 已发生，`sessionId` 是官方**实际返回的 id**（可能与预留 id 不同）。
 * 不存标题、Goal 或别的模块的私有工作根。这就是唯一的当前格式：读不到当前格式就明确失败，
 * 绝不做旧格式转换，也不重新挑一条可见根。
 */
export const channelDefaultSchema = z.object({
    state: z.enum(['requested', 'creating', 'created']),
    requestedSessionId: nonEmpty,
    sessionId: nonEmpty.nullable(),
    cwd: nonEmpty,
    createdAt: createdAtSchema,
}).strict()

/**
 * 中枢没有渠道输入的轮的发送状态：每个中枢一条起点、每一轮一条决定，重启不丢、不重复。
 * - `from`：第一次启用默认发送时读到的会话最后序号（`seq`，空会话为 -1）。这一序号及之前结束的轮是启用前的历史，一概不发；
 *   之后不再移动（不随重启、不随内存状态变化）。
 * - `turn`：这一轮怎么办，一轮只有这一条——`held` 休息时段里攒着（`heldUntil` 是攒下时那一段休息时段结束的时刻）；`skipped` 整条写了
 *   不发标记或等待标记，不发；`sending` 已经定好渠道与锚点（`bindingId`、`anchorKey`、`inputRequestIds`），这一轮的普通片与留待片
 *   都是这一条决定下的投递，续发与补发一直按当初的锚点核对，不会换锚点再发一遍。
 */
export const mainTurnSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('from'),
        sessionId: nonEmpty,
        seq: z.number().int().min(-1),
        at: createdAtSchema,
    }).strict(),
    z.object({
        kind: z.literal('turn'),
        sessionId: nonEmpty,
        turn: createdAtSchema,
        endSeq: createdAtSchema,
        state: z.enum(['held', 'skipped', 'sending']),
        heldUntil: createdAtSchema.optional(),
        bindingId: nonEmpty.optional(),
        anchorKey: nonEmpty.optional(),
        inputRequestIds: z.array(nonEmpty).min(1).optional(),
        // 攒着时记下发送要用的：之后这一轮可能被边界换掉，从记录里再也枚举不到它，到点照样按这里发。
        sourceSeqs: z.array(createdAtSchema).min(1).optional(),
        files: z.array(z.string()).optional(),
        // detached：这一轮已经不在当前记录里（落过边界），发的是这里存的，发送前不再和当前记录比。
        detached: z.boolean().optional(),
        // 定下要发时记下的文字（按这一轮的结果，不发、只交文件的轮为空串）；以前的记录没有，发时用这一轮的文字。
        text: z.string().optional(),
        at: createdAtSchema,
    }).strict(),
])

/**
 * bindings/incoming/outgoing/channel_default/main_turns 五张表的严格 schema。
 *
 * 物理表名必须满足官方 Domain 的 `/^[a-z][a-z0-9_]*$/`（camel 键会被拒绝），
 * 因此关联表的 schema 集合 key 是 `channel_default`；模块内部变量仍沿用 camel 名。
 */
export const channelTableSchemas = Object.freeze({
    bindings: bindingSchema,
    incoming: incomingSchema,
    outgoing: outgoingSchema,
    channel_default: channelDefaultSchema,
    main_turns: mainTurnSchema,
})

/* ------------------------------------------------------------------ *
 * 入参校验
 * ------------------------------------------------------------------ */

function normalizeHost(ctx) {
    if (!isRecord(ctx)) fail('INVALID_CONTEXT', 'ctx 必须是 Host 依赖对象')
    const { sessionController, sessionQuery, sessions, credentials, core } = ctx
    if (!isRecord(core) || typeof core.provenance?.original !== 'function' || typeof core.deliver !== 'function'
        || typeof core.turnRoute !== 'function' || typeof core.outcomeOf !== 'function' || typeof core.sessions?.hub !== 'function'
        || typeof core.attach !== 'function' || typeof core.detach !== 'function' || typeof core.pending !== 'function'
        || typeof core.quietHours?.inQuiet !== 'function' || typeof core.quota?.detail !== 'function'
        || typeof core.executors?.gatedFailure !== 'function') {
        fail('INVALID_CONTEXT', 'ctx.core 缺 provenance.original、deliver、turnRoute、outcomeOf、sessions.hub 或 attach/detach/pending：渠道要接框架核心')
    }
    // 默认会话由渠道自己 create 并保存，绝不管理 Agent handle。
    if (!isRecord(sessionController) || typeof sessionController.create !== 'function') {
        fail('INVALID_CONTEXT', 'ctx.sessionController.create 缺失')
    }
    if (!isRecord(sessionQuery)
        || typeof sessionQuery.observeSession !== 'function'
        || typeof sessionQuery.readSurface !== 'function') {
        fail('INVALID_CONTEXT', 'ctx.sessionQuery.observeSession/readSurface 缺失')
    }
    if (!isRecord(sessions) || typeof sessions.get !== 'function' || typeof sessions.flush !== 'function') {
        fail('INVALID_CONTEXT', 'ctx.sessions.get/flush 缺失')
    }
    if (!isRecord(credentials)
        || typeof credentials.readRecord !== 'function'
        || typeof credentials.modifyRecord !== 'function'
        || typeof credentials.deleteRecord !== 'function') {
        fail('INVALID_CONTEXT', 'ctx.credentials.readRecord/modifyRecord/deleteRecord 缺失')
    }
    return { sessionController, sessionQuery, sessions, credentials, core }
}

/** 适配器至少要有 pair、listen、send（见 README“接新平台”）；平台名要合规。 */
function checkPlatform(platform, value) {
    if (!PLATFORM_ID.test(platform)) fail('INVALID_OPTIONS', `平台名 ${platform} 不合规：小写字母开头，字母、数字、连字符`)
    if (!isRecord(value)
        || typeof value.pair !== 'function'
        || typeof value.listen !== 'function'
        || typeof value.send !== 'function') {
        fail('INVALID_OPTIONS', `平台 ${platform} 必须提供 pair/listen/send`)
    }
}

function normalizeOptions(options) {
    if (!isRecord(options)) fail('INVALID_OPTIONS', 'createChannelRuntime 需要 {platforms,createIngress,domain}')
    const { platforms, createIngress, domain } = options
    if (typeof createIngress !== 'function') fail('INVALID_OPTIONS', 'createIngress 必须是函数')
    if (!isRecord(platforms)) fail('INVALID_OPTIONS', 'platforms 必须是 { 平台名: 适配器 } 对象')
    if (!isRecord(domain) || typeof domain.table !== 'function') {
        fail('INVALID_OPTIONS', 'domain 必须是 Host 已打开的 storageDomain Domain')
    }
    const normalizedPlatforms = {}
    for (const [platform, value] of Object.entries(platforms)) {
        if (value === undefined) continue
        checkPlatform(platform, value)
        normalizedPlatforms[platform] = value
    }
    if (Object.keys(normalizedPlatforms).length === 0) {
        fail('INVALID_OPTIONS', 'platforms 至少要提供一个平台对象')
    }
    const now = options.now === undefined ? () => Date.now() : options.now
    if (typeof now !== 'function') fail('INVALID_OPTIONS', 'now 必须是函数')
    const sleep = options.sleep === undefined
        ? milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        : options.sleep
    if (typeof sleep !== 'function') fail('INVALID_OPTIONS', 'sleep 必须是函数')
    // 交给适配器 paceMs 的随机源（[0,1) 均匀）；测试注入确定的序列。
    const random = options.random ?? Math.random
    if (typeof random !== 'function') fail('INVALID_OPTIONS', 'random 必须是函数')
    // 合并等待：最后一条消息到达后安静多久才准入。只有图片的消息等更久，好让随后的文字一起送达。
    const mergeTextMs = options.mergeTextMs ?? 0
    const mergeImageMs = options.mergeImageMs ?? 0
    // 一组从第一条起最多攒多久：不给时不设上限。
    const mergeCapMs = options.mergeCapMs ?? null
    // 助手回复等待标记后最多再等多久；0 表示不启用等待，标记按普通文字发送。
    const waitTimeoutMs = options.waitTimeoutMs ?? 0
    // QQ 被动回复只在对方消息后的一段时间内有效：借用对方消息额度的转交、中途发送与补发只在这段时间内发出。
    const qqRelayWindowMs = options.qqRelayWindowMs ?? 0
    // 相邻的几张图拼成一张大图的缓存目录；未设置时逐张发送。
    const compositeDir = options.compositeDir ?? null
    const pairCommitTimeoutMs = options.pairCommitTimeoutMs ?? PAIR_COMMIT_TIMEOUT_MS
    // 一个平台断开多久后经别的渠道告诉对方；0 表示不告警。
    const downAlarmMs = options.downAlarmMs ?? 0
    // 中枢发到手机时渠道的先后（平台名）；空时按对方最近在哪说话。rerouteNote：没走第一位时开头注明。
    const replyOrder = options.replyOrder ?? []
    if (!Array.isArray(replyOrder) || !replyOrder.every(isNonEmptyString)) fail('INVALID_OPTIONS', 'replyOrder 必须是平台名数组')
    const rerouteNote = options.rerouteNote === true
    // 群第一次说话、还没接会话时按群找要接的会话（见 setGroupResolver）；也可以在运行中由别的插件设。
    const resolveGroup = options.resolveGroup ?? null
    if (resolveGroup !== null && typeof resolveGroup !== 'function') fail('INVALID_OPTIONS', 'resolveGroup 必须是函数')
    // 会话是否已归档（宿主的项目登记表）：返回 true / false；未提供或查不了时只认删除，不认归档。
    const isArchived = options.isArchived ?? null
    if (isArchived !== null && typeof isArchived !== 'function') fail('INVALID_OPTIONS', 'isArchived 必须是函数')
    if (compositeDir !== null && !isNonEmptyString(compositeDir)) fail('INVALID_OPTIONS', 'compositeDir 必须是非空路径')
    // 额度用完与用量提前提醒：提醒的几档与看哪些窗口。
    const quotaNotices = { ...QUOTA_NOTICE_DEFAULTS, ...options.quotaNotices ?? {} }
    // 中枢里没有渠道输入的轮也发到手机；插件装配时打开。
    const mainTurnReplies = options.mainTurnReplies === true
    // 一次中途发送发完时交出它的经历库条目（`pushEntryOf`）；未提供时不交。
    const pushed = options.pushed ?? null
    if (pushed !== null && typeof pushed !== 'function') fail('INVALID_OPTIONS', 'pushed 必须是函数')
    // 报一条异常（框架核心的 `core.report(kind, { sessionId?, text, data? })`）：断开、没送到、英文旁白、回复被挡下；未提供时不报。
    const report = options.report ?? null
    if (report !== null && typeof report !== 'function') fail('INVALID_OPTIONS', 'report 必须是函数')
    // 自查（`checkHealth`）：已绑定的平台连续几次不是"已连接"才算断开；回复没送到、又没能立即告诉会话，过多久才报。
    const downChecks = options.downChecks ?? 2
    const undeliveredGraceMs = options.undeliveredGraceMs ?? 0
    // 暂停：同一个绑定连着几片被平台确定没发出就暂停它多久；0 片表示不暂停。
    const pauseRejects = options.pauseRejects ?? 2
    const pauseMs = options.pauseMs ?? 15 * 60_000
    for (const value of [mergeTextMs, mergeImageMs, mergeCapMs ?? 0, waitTimeoutMs, qqRelayWindowMs, downAlarmMs, pairCommitTimeoutMs, undeliveredGraceMs, pauseMs]) {
        if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_OPTIONS', 'mergeTextMs / mergeImageMs / mergeCapMs / waitTimeoutMs / qqRelayWindowMs / downAlarmMs / undeliveredGraceMs / pauseMs 必须是非负整数毫秒')
    }
    if (!Number.isSafeInteger(downChecks) || downChecks < 1) fail('INVALID_OPTIONS', 'downChecks 必须是正整数')
    if (!Number.isSafeInteger(pauseRejects) || pauseRejects < 0) fail('INVALID_OPTIONS', 'pauseRejects 必须是非负整数')
    return { platforms: normalizedPlatforms, createIngress, domain, now, sleep, random, mergeTextMs, mergeImageMs, mergeCapMs, waitTimeoutMs, qqRelayWindowMs, downAlarmMs, replyOrder, rerouteNote, pairCommitTimeoutMs, compositeDir, resolveGroup, isArchived, quotaNotices, mainTurnReplies, report, downChecks, undeliveredGraceMs, pushed, pauseRejects, pauseMs }
}

function openTables(domain) {
    let bindings
    let incoming
    let outgoing
    let channelDefault
    let mainTurns
    try {
        bindings = domain.table('bindings')
        incoming = domain.table('incoming')
        outgoing = domain.table('outgoing')
        channelDefault = domain.table('channel_default')
        mainTurns = domain.table('main_turns')
    } catch (error) {
        throw new ChannelRuntimeError('INVALID_DOMAIN', 'domain 未声明 bindings/incoming/outgoing/channel_default/main_turns 表', { cause: error })
    }
    for (const table of [bindings, incoming, outgoing, channelDefault, mainTurns]) {
        if (!isRecord(table)
            || typeof table.get !== 'function'
            || typeof table.entries !== 'function'
            || typeof table.put !== 'function'
            || typeof table.delete !== 'function'
            || typeof table.update !== 'function') {
            fail('INVALID_DOMAIN', 'domain 表句柄必须提供 get/entries/put/delete/update')
        }
    }
    return { bindings, incoming, outgoing, channelDefault, mainTurns }
}

/* ------------------------------------------------------------------ *
 * 运行态
 * ------------------------------------------------------------------ */

function createPlatformState(platform) {
    return {
        platform,
        phase: 'idle',
        errorCode: null,
        attempt: null,
        listener: null,
        retry: null,
        retryCount: 0,
        activeBindingId: null,
        // 断开的时间（连不上，或平台报告断开）、这次断开是否已经告警、告警计时器。
        downSince: null,
        alarmed: false,
        alarmTimer: undefined,
    }
}

/**
 * 创建渠道运行态 owner。
 * @param {object} ctx - Host 依赖（sessionController/sessionQuery/sessions/credentials）
 * @param {object} options - {platforms,createIngress,domain,now?,sleep?}
 * @returns {Promise<object>} 公开 runtime（status/qr/beginPair/verifyCode/selectAccount/
 *   cancelPair/disconnect/wake/close）
 */
/**
 * 一条进会话的渠道消息是谁说的、从哪来：入口在 prompt 之前声明。
 * 私聊还是群看绑定（群绑定带 ownerBindingId）；入口那一层分不出（群也按 private 进来）。
 * 渠道自己锚定在对方消息上放进来的（等待到期提醒、未送达补告，`relayed`）记成渠道插件，核心会加来源标注。
 * 程序和别的会话的话经 `core.deliver` 进会话，不经入口。
 */
export function originOf(binding, relayed, label = BUILTIN_LABELS[binding.platform] ?? binding.platform) {
    const platform = label
    const group = binding.ownerBindingId !== undefined && binding.ownerBindingId !== null
    const via = { exit: binding.platform, label: group ? `${platform} 群「${binding.groupName ?? binding.conversationId}」` : `${platform} 私聊` }
    return { speaker: relayed ? CHANNEL_SPEAKER : { kind: 'user' }, via }
}

export async function createChannelRuntime(ctx, options) {
    const host = normalizeHost(ctx)
    const config = normalizeOptions(options)
    const tables = openTables(config.domain)

    /** close 后停止新准入与新后台循环；在途发送继续收尾并写入真实回执。 */
    let closing = false
    // 群解析规则：建运行态时给的，或者之后由别的插件经 setGroupResolver 设的；同一时间只有一个。
    let groupResolver = config.resolveGroup
    // 登记的平台的显示名与登记数据（内置平台的名字在 BUILTIN_LABELS）。撤销登记后名字照样留着：旧绑定、旧记录还能说清是哪个渠道。
    const labels = new Map(Object.entries(BUILTIN_LABELS))
    const descriptors = new Map()
    /** 对方看到的渠道名。 */
    const labelOf = platform => labels.get(platform) ?? platform ?? '渠道'
    /** 写给对方看的渠道名：官方机器人另外说清楚，免得和别的 QQ 渠道混。 */
    const channelWord = platform => (platform === 'qq' ? 'QQ 官方机器人' : labelOf(platform))
    /** 现在装着的平台。 */
    const platformIds = () => Object.keys(config.platforms)
    /** 支持群的平台（适配器提供 `groupList`），这一版最多一个；没有时为 null。 */
    const groupPlatform = () => platformIds().find(id => typeof config.platforms[id].groupList === 'function') ?? null
    /** 支持群的平台上本人的私聊绑定（群绑定挂在它上面）。 */
    const readGroupOwner = () => {
        const platform = groupPlatform()
        return platform === null ? null : readBinding(platform)
    }
    /** 合并等待到期后唤醒准入的计时器。 */
    let mergeTimer
    /** 正在一轮里的会话 → 这一轮开始的时间；由宿主按 turn/start、turn/end 报告。 */
    const busySessions = new Map()
    /** 会话忙时扣着新消息：忙超时的那一刻再唤醒一次，免得 turn/end 丢了以后消息一直扣着。 */
    let busyTimer
    /** 等待标记到期后唤醒核对的计时器。 */
    let waitTimer
    let closePromise = null
    /** 配对代次：新的一次 beginPair 让仍停在 cancelAttempt 窗口里的旧请求作废。 */
    let pairGeneration = 0
    const lifecycle = new AbortController()

    const platformStates = new Map(Object.keys(config.platforms).map(platform => [platform, createPlatformState(platform)]))
    /** 平台的运行状态；没有时（绑定里有、这次还没登记的平台）现建一个空的。 */
    function stateOf(platform) {
        let state = platformStates.get(platform)
        if (state === undefined) {
            state = createPlatformState(platform)
            platformStates.set(platform, state)
        }
        return state
    }
    /** 本模块创建、因此由本模块关闭的准入 helper（每 binding 一条）。 */
    const ingresses = new Map()
    /** 每条准入 helper 建的时候接的会话：私聊绑定换了中枢时据此认出要换。 */
    const ingressSessions = new Map()
    /** 在途异步动作（listen/receive/wake/send/pair 提交），close 排空。 */
    const inflight = new Set()
    /** 每 peer 串行发送链与上次发送完成时间。 */
    const peerChains = new Map()
    const peerLastSendAt = new Map()
    /** 各绑定的后台投递：bindingId → { again, promise }。 */
    const deliveryJobs = new Map()
    /**
     * 平台确定没发出的连续计数与暂停：bindingId → `{ binding, misses, until }`。只在内存里：进程重启、这个平台重连时清零。
     * `until` 为 null 时只在计数；不为 null 时暂停到这一刻，过了这一刻还留着就是在试——下一片发出就恢复，又确定没发出就再停。
     */
    const sendPauses = new Map()
    /** 正在改道发的片（原来那一片的投递编号）：改道那一条还没有结果时，原来那一片既不算送到也不算没送到。 */
    const reroutesInFlight = new Set()
    /** 这次运行态启动的时刻。 */
    const startedAt = config.now()
    /** 休息时段结束时唤醒一次，发出攒着的中枢回复。 */
    let quietTimer
    /** 串行链：同一 incoming key 的接收/准入，以及同平台配对提交。 */
    const keyChains = new Map()
    /** wake 合并：一个循环内多次请求只增量再跑一轮。 */
    let reconcileRunning = false
    let reconcileRequested = false
    let reconcileLoop = null
    /** 无参 wake 对账全部平台；带 sessionId 的 wake 只对账绑定到这些会话的渠道。 */
    let wakeAll = false
    const wakeScope = new Set()
    const wakeWaiters = []

    function track(promise) {
        const tracked = promise.then(
            value => {
                inflight.delete(tracked)
                return value
            },
            error => {
                inflight.delete(tracked)
                throw error
            },
        )
        tracked.catch(() => {})
        inflight.add(tracked)
        return tracked
    }

    function serialize(key, task) {
        const previous = keyChains.get(key) ?? Promise.resolve()
        const started = previous.then(task, task)
        const tail = started.then(() => undefined, () => undefined)
        keyChains.set(key, tail)
        tail.then(() => {
            if (keyChains.get(key) === tail) keyChains.delete(key)
        })
        return started
    }

    function readRecord(table, key) {
        try {
            return table.get(key)
        } catch {
            return undefined
        }
    }

    function readEntries(table) {
        try {
            return [...table.entries()]
        } catch {
            return []
        }
    }

    async function putRecord(table, schema, key, value) {
        const parsed = schema.parse(value)
        await table.put(key, parsed)
        return parsed
    }

    const putBinding = (value) => putRecord(tables.bindings, bindingSchema, value.platform, value)
    const putIncoming = (key, value) => putRecord(tables.incoming, incomingSchema, key, value)
    // 第一次记为失败或结果不明时补上 failedAt：只有带它的片才会写进未送达说明，旧记录不追溯。
    const putOutgoing = (key, value) => putRecord(tables.outgoing, outgoingSchema, key,
        (value.state === 'failed' || value.state === 'unknown') && value.failedAt === undefined && value.kind !== 'wait'
            ? { ...value, failedAt: config.now() }
            : value)

    /**
     * 在真实 Domain 写槽里按 exact bindingId 改动一条记录：updater 看到的是该写槽上最新的
     * current（可能是并发新配对刚排入并已提交的 B），不是调用时读到的快照。只有
     * current.bindingId 仍等于捕获值才应用改动，新 owner 或无效行原样保持，绝不写回旧完整对象。
     * key 在排队期间消失时按“已无目标”返回 'gone'；其它持久失败原样上抛。
     */
    async function updateBindingExact(key, bindingId, change) {
        try {
            await tables.bindings.update(key, current => {
                if (!isRecord(current)) return current
                const parsed = bindingSchema.safeParse(current)
                if (!parsed.success) return current
                if (parsed.data.bindingId !== bindingId) return current
                const next = change(parsed.data)
                return next === undefined ? current : next
            })
            return 'updated'
        } catch (error) {
            // 公开 Domain 只在 key 已不存在时用 code='missing-key'：目标已不在，没有可写记录。
            if (isRecord(error) && error.code === 'missing-key') return 'gone'
            throw error
        }
    }

    /** 读到的 binding 必须通过严格 schema；坏的记录按“无可用绑定”处理。私聊绑定的键就是平台名。 */
    function readBinding(platform) {
        const binding = readBindingAt(platform)
        return binding === null || binding.ownerBindingId !== undefined ? null : binding
    }

    function readBindingAt(key) {
        const raw = readRecord(tables.bindings, key)
        if (raw === undefined) return null
        const parsed = parseBinding(raw)
        return parsed.success ? parsed.data : null
    }

    function isGroupBinding(binding) {
        return binding.ownerBindingId !== undefined
    }

    /** 休息时段在什么时候结束（框架核心的一份）；不在时段里为 null。 */
    function quietEnd(at) {
        return host.core.quietHours.inQuiet(at) ? host.core.quietHours.nextEnd(at) : null
    }

    /** 中枢（框架核心的数据）：私聊绑定接的就是它。没有中枢时为 null。 */
    function hubSessionId() {
        const hub = host.core.sessions.hub()
        return isNonEmptyString(hub) ? hub : null
    }

    /**
     * 读出来用的绑定：私聊绑定的会话按现在的中枢现算（换了中枢就跟着换；绑定里存的会话编号不再读），
     * 没有中枢时为 null（这条私聊的消息先留在渠道里，不准入也不发）。群绑定照存的会话。
     */
    function parseBinding(raw) {
        const parsed = bindingSchema.safeParse(raw)
        if (!parsed.success || isGroupBinding(parsed.data)) return parsed
        return { success: true, data: { ...parsed.data, sessionId: hubSessionId() } }
    }

    /** 没有中枢：报一次（有了中枢以后再没有，再报一次）。 */
    let noHubReported = false
    function reportNoHub(what) {
        if (noHubReported) return
        noHubReported = true
        host.core.report?.('channels/no-hub', { text: `还没有中枢会话：${what}。先在 DSH 里建一个会话、定成中枢` })
    }

    function bindingKeyOf(binding) {
        return isGroupBinding(binding) ? groupBindingKey(binding.platform, binding.conversationId) : binding.platform
    }

    /** 群绑定只在它挂着的私聊绑定仍是同一个、且启用时才算数（重新配对或断开后就失效）。 */
    function groupOwnerOf(group) {
        const owner = readBinding(group.platform)
        if (owner === null || owner.enabled !== true || owner.bindingId !== group.ownerBindingId) return null
        return owner
    }

    /** 挂在这个私聊绑定上、仍然启用的群绑定。 */
    function groupBindingsOf(owner) {
        const prefix = `${owner.platform}-group-`
        const groups = []
        for (const [key, raw] of readEntries(tables.bindings)) {
            if (typeof key !== 'string' || !key.startsWith(prefix)) continue
            const parsed = parseBinding(raw)
            if (!parsed.success) continue
            const group = parsed.data
            if (group.ownerBindingId !== owner.bindingId || group.enabled !== true) continue
            if (key !== groupBindingKey(group.platform, group.conversationId)) continue
            groups.push(group)
        }
        return groups.sort((left, right) => left.createdAt - right.createdAt)
    }

    /** 一条绑定此刻是否可用：私聊绑定看自己，群绑定还要看它挂着的私聊绑定。 */
    function bindingActive(binding) {
        if (binding.enabled !== true) return false
        return !isGroupBinding(binding) || groupOwnerOf(binding) !== null
    }

    function hasBindingRow(platform) {
        return readRecord(tables.bindings, platform) !== undefined
    }

    function readIncoming(key) {
        const raw = readRecord(tables.incoming, key)
        if (raw === undefined) return null
        const parsed = incomingSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
    }

    function readOutgoing(deliveryId) {
        const raw = readRecord(tables.outgoing, deliveryId)
        if (raw === undefined) return null
        const parsed = outgoingSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
    }

    function readIncomingRows() {
        const rows = []
        for (const [, value] of readEntries(tables.incoming)) {
            const parsed = incomingSchema.safeParse(value)
            if (parsed.success) rows.push(parsed.data)
        }
        return rows
    }

    function readDeliveries(bindingId, turn, endSeq) {
        const rows = []
        for (const [deliveryId, value] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(value)
            if (!parsed.success) continue
            if (parsed.data.bindingId !== bindingId) continue
            if (parsed.data.turn !== turn || parsed.data.endSeq !== endSeq) continue
            rows.push({ deliveryId, record: parsed.data })
        }
        return rows
    }

    function sameNumberList(left, right) {
        return left.length === right.length && left.every((value, index) => value === right[index])
    }

    function sameStringList(left, right) {
        return left.length === right.length && left.every((value, index) => value === right[index])
    }

    /**
     * 同一 deliveryId 的 payload 与身份必须逐字段一致：正文/分片/真实来源任一变化都
     * 说明这是另一次投递，不能就地改写成新内容冒充旧身份。
     */
    function sameDeliveryPayload(stored, prepared) {
        if (stored.bindingId !== prepared.bindingId) return false
        if (stored.sessionId !== prepared.sessionId) return false
        if (stored.turn !== prepared.turn || stored.endSeq !== prepared.endSeq) return false
        if (stored.partIndex !== prepared.partIndex) return false
        if (stored.partCount !== prepared.partCount) return false
        if (stored.text !== prepared.text) return false
        if (stored.kind !== prepared.kind) return false
        if (stored.anchorKey !== prepared.anchorKey) return false
        if (!sameNumberList(stored.sourceSeqs, prepared.sourceSeqs)) return false
        return sameStringList(stored.inputRequestIds, prepared.inputRequestIds)
    }

    /* ---------------------------- 凭据 ---------------------------- */

    async function writeGrant(key, payload) {
        if (!isJsonValue(payload, 0)) fail('INVALID_CREDENTIAL', '凭据载荷必须可持久 JSON')
        await host.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload }))
    }

    async function readGrantPayload(key) {
        let record
        try {
            record = await host.credentials.readRecord(key)
        } catch {
            return null
        }
        if (!isRecord(record) || record.kind !== 'grant') return null
        return isRecord(record.payload) ? record.payload : null
    }

    async function deleteGrantQuietly(key) {
        try {
            await host.credentials.deleteRecord(key)
        } catch {
            // 已不被任何绑定引用的孤立授权：删除失败不改运行态结论。
        }
    }

    /** 每次平台操作都从公开 readRecord 取凭据，并核对它属于当前绑定身份。群绑定用它挂着的私聊绑定的凭据。 */
    async function readAccountCredential(binding) {
        if (isGroupBinding(binding)) {
            const owner = groupOwnerOf(binding)
            return owner === null ? null : readAccountCredential(owner)
        }
        const payload = await readGrantPayload(binding.credentialKey)
        if (payload === null) return null
        if (payload.bindingId !== binding.bindingId) return null
        if (payload.platform !== binding.platform) return null
        if (payload.accountId !== binding.accountId) return null
        if (payload.senderId !== binding.senderId) return null
        if (payload.conversationId !== binding.conversationId) return null
        if (!isCredentialValue(payload.credential)) return null
        return payload.credential
    }

    /** 锚点即 replyContext 原样（准确原消息），只存在于 credentials 记录。 */
    async function readAnchor(binding, anchorKey) {
        const payload = await readGrantPayload(anchorKey)
        if (payload === null) return null
        if (payload.bindingId !== binding.bindingId) return null
        if (payload.platform !== binding.platform) return null
        if (payload.conversationId !== binding.conversationId) return null
        const anchor = payload.anchor
        if (!isRecord(anchor)) return null
        const values = Object.values(anchor)
        if (values.length === 0) return null
        for (const value of values) {
            if (typeof value !== 'string') return null
        }
        if (!values.some(value => value !== '')) return null
        return { ...anchor }
    }

    /**
     * 发送可用的锚点：微信每片必须带准确的非空 contextToken。
     * 收件时 contextToken 为空是真实字段（仍要持久、仍要准入），只在发送前拒绝。
     */
    function anchorSendable(binding, anchor) {
        if (binding.platform !== 'weixin') return true
        return isNonEmptyString(anchor.contextToken)
    }

    /* ---------------------------- 中枢 ---------------------------- */

    /**
     * 绑定会话只按真实普通会话核对：只读观察 binding.sessionId，header.id 必须相同且不是
     * 子 agent 会话。标题、UI 焦点、默认渠道会话与别的模块的私有工作根都不参与判断。
     */
    async function verifyBindingSession(binding) {
        const sessionId = binding.sessionId
        if (!(await observeOwnedSession(sessionId))) return null
        return { sessionId }
    }

    /**
     * 真正核实目标存在且属于本人：观察租约的 header.id 必须就是该 id，且不是子 agent 会话
     * （只按 `origin === 'subagent'` 判定）。普通 fork 也带 `parentSession` 但仍是合法普通会话，
     * 因此不据 parentSession 拒绝。任何形状不符或读取失败都返回 null，绝不改投别的会话。
     */
    async function observeOwnedSession(sessionId) {
        let observation
        try {
            observation = await host.sessionQuery.observeSession(sessionId, {
                projectionMode: 'none',
                signal: lifecycle.signal,
            })
        } catch {
            return null
        }
        try {
            if (!isRecord(observation) || !isRecord(observation.header)) return null
            if (typeof observation[Symbol.dispose] !== 'function') return null
            if (observation.header.id !== sessionId) return null
            if (observation.header.origin === 'subagent') return null
            return observation.header
        } finally {
            disposeObservation(observation)
        }
    }

    /** 准入 helper 每 binding 一条；恒等身份、固定会话与持久绑定一致。私聊绑定换了中枢时关掉旧的、按新中枢建一条。 */
    function getIngress(binding) {
        const existing = ingresses.get(binding.bindingId)
        if (existing !== undefined && ingressSessions.get(binding.bindingId) === binding.sessionId) return existing
        if (existing !== undefined) track(closeIngress(binding.bindingId))
        let ingress
        try {
            ingress = config.createIngress(ctx, {
                platform: binding.platform,
                accountId: binding.accountId,
                conversationId: binding.conversationId,
                senderId: binding.senderId,
                // 固定会话：helper 只向这一条普通会话准入，不重新选择默认会话。
                sessionId: binding.sessionId,
            })
        } catch (error) {
            throw new ChannelRuntimeError('INGRESS_UNAVAILABLE', '无法创建中枢准入 helper', { cause: error })
        }
        if (!isRecord(ingress) || typeof ingress.admit !== 'function' || typeof ingress.close !== 'function') {
            throw new ChannelRuntimeError('INGRESS_UNAVAILABLE', 'createIngress 未返回 {admit,close}')
        }
        ingresses.set(binding.bindingId, ingress)
        ingressSessions.set(binding.bindingId, binding.sessionId)
        return ingress
    }

    /** 启动 helper 的 close（它自己发出 abort 并停止准入）；调用即开始，返回等待它的 promise。 */
    function closeIngress(bindingId) {
        const ingress = ingresses.get(bindingId)
        if (ingress === undefined) return Promise.resolve()
        ingresses.delete(bindingId)
        ingressSessions.delete(bindingId)
        return Promise.resolve(ingress.close()).catch(() => {
            // helper 已自行收尾；关闭失败不改变运行态结论。
        })
    }

    /* ---------------------------- 平台状态 ---------------------------- */

    function setError(state, code) {
        state.phase = 'error'
        state.errorCode = code
    }

    function requestWakeSafely() {
        wake().catch(() => {})
    }

    function delayWithSignal(milliseconds, signal) {
        return new Promise(resolve => {
            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                signal.removeEventListener('abort', finish)
                resolve()
            }
            if (signal.aborted) {
                finish()
                return
            }
            signal.addEventListener('abort', finish, { once: true })
            Promise.resolve(config.sleep(milliseconds)).then(finish, finish)
        })
    }

    function scheduleListenRetry(state, binding) {
        if (closing || state.retry !== null) return
        if (state.retryCount >= LISTEN_RETRY_LIMIT) return
        state.retryCount += 1
        const token = { controller: new AbortController() }
        const wait = Math.min(RETRY_BASE_MS * 2 ** (state.retryCount - 1), RETRY_MAX_MS)
        const promise = (async () => {
            await delayWithSignal(wait, token.controller.signal)
            if (token.controller.signal.aborted || closing) return
            if (state.listener !== null) return
            requestWakeSafely()
        })()
        state.retry = token
        track(promise).then(
            () => {
                if (state.retry === token) state.retry = null
            },
            () => {
                if (state.retry === token) state.retry = null
            },
        )
    }

    function handleListenFailure(state, binding, listener, error) {
        const code = stableErrorCode(error, 'LISTEN_FAILED')
        if (state.listener === listener) state.listener = null
        setError(state, code)
        // 连不上就算断开（所有平台一样）；断开超过 downAlarmMs 经别的渠道告诉对方一次。
        state.downSince ??= config.now()
        scheduleDownAlarm(state)
        if (FATAL_LISTEN_CODES.has(code)) return
        scheduleListenRetry(state, binding)
    }

    function markReady(state, listener) {
        if (closing || state.listener !== listener) return
        listener.ready = true
        // 连接重新建起来了：之前连着没发出的计数和暂停都不再作数。
        clearPauses(state.platform, '重新连上了')
        // 连上了：断开计时清掉（另报连通的平台，之后报断开再重新计）。
        clearDown(state)
        state.phase = 'connected'
        state.errorCode = null
        state.retryCount = 0
        requestWakeSafely()
    }

    /** 平台报告连通变化（`onLive`，例如经手机转发的平台：连接还在、手机那头断了）。断开时记下时间并安排告警核对；连上时清掉。 */
    function markLive(state, listener, up) {
        if (closing || state.listener !== listener) return
        // 另一头从断到连（重连或重启）：之前连着没发出的计数和暂停都不再作数。
        if (up === true && listener.live !== true) clearPauses(state.platform, '另一头重新连上了')
        listener.live = up === true
        if (up === true) {
            clearDown(state)
            return
        }
        state.downSince ??= config.now()
        scheduleDownAlarm(state)
    }

    function clearDown(state) {
        state.downSince = null
        state.alarmed = false
        clearTimeout(state.alarmTimer)
        state.alarmTimer = undefined
    }

    /**
     * 平台转来的报警（`onAlert`，例如平台发来的报警事件，平台已核过格式）：经框架核心报，类别、subject（`key`）、正文照平台给的；
     * 格式不对的不报原样，报一条 `channels/alert-invalid` 说哪里不对。只认当前这条连接。
     */
    function noteAlert(state, listener, alert) {
        if (closing || state.listener !== listener || !isRecord(alert)) return
        if (isNonEmptyString(alert.kind) && isNonEmptyString(alert.key) && isNonEmptyString(alert.text)) {
            reportSafely(alert.kind, { text: alert.text, data: { subject: alert.key } })
            return
        }
        const label = labelOf(state.platform)
        reportSafely(CHANNEL_REPORTS.alertInvalid, {
            text: `${label}转来的报警格式不对，没有转报：${isNonEmptyString(alert.invalid) ? alert.invalid : '缺类别、key 或正文'}`,
            data: { subject: state.platform },
        })
    }

    function scheduleDownAlarm(state) {
        if (closing || config.downAlarmMs === 0 || state.downSince === null || state.alarmed) return
        clearTimeout(state.alarmTimer)
        const remaining = Math.max(state.downSince + config.downAlarmMs - config.now(), 0)
        state.alarmTimer = setTimeout(() => {
            state.alarmTimer = undefined
            track(alarmIfDown(state)).catch(() => {})
        }, remaining)
        state.alarmTimer.unref?.()
    }

    /**
     * 一个平台断开超过 `downAlarmMs`：经别的渠道（选路此时不会选到它）发一句固定说明，一次断开只发一次。
     * 当时没有可用渠道（官方机器人没有锚点或额度、微信上下文过期）时不记已告警，对方之后从备用渠道说话、对账时再试；
     * 交给了平台就记已告警，结果不明也不再发。
     */
    async function alarmIfDown(state) {
        if (closing || config.downAlarmMs === 0 || state.alarmed || state.downSince === null) return
        if (config.now() - state.downSince < config.downAlarmMs) return
        const binding = readBinding(state.platform)
        if (binding === null || binding.enabled !== true) return
        if (bindingLive(binding)) return
        // 选路只剩断开的这个平台自己时不发：发不出去，还会留下一条未送达记录。
        const picked = pickReplyAnchor(sessionScope(binding.sessionId), { need: 2 })
        if (picked === null || picked.binding.bindingId === binding.bindingId) return
        if ((repliesLeftOn(picked.binding.platform, picked.anchorKey) ?? 2) < 2) return
        // 渠道自己的固定说明：带 system 标记，不算回答了对方的消息。一次断开一个键：发出或结果不明就算告过（不重发），
        // 确定没发出的下次对账再试。
        const key = `${state.platform}-down-${state.downSince}`
        const notice = downNoticeOf(channelWord(state.platform), config.replyOrder[0] === state.platform)
        if (!systemNoticeExists(key)) await sendSystem(picked.binding, notice, { key, system: 'account', anchor: picked.anchorKey })
        if (systemNoticeExists(key)) state.alarmed = true
    }

    /** 停止本平台连接：abort 平台 listen 并等它自己排空；helper 仍可复用于准入。 */
    async function stopListener(state) {
        if (state.retry !== null) {
            state.retry.controller.abort()
            state.retry = null
        }
        const listener = state.listener
        state.listener = null
        if (listener === null) return
        listener.controller.abort()
        try {
            await listener.promise
        } catch {
            // listen 的失败已经由它自己的处理路径收敛。
        }
    }

    function startListening(state, binding, platform, credential, ingress) {
        const listener = {
            bindingId: binding.bindingId,
            controller: new AbortController(),
            ingress,
            ready: false,
            // 平台经 onLive 报告的连通状态；不报告的平台保持 null，按 ready 算。
            live: null,
            promise: null,
        }
        state.listener = listener
        state.phase = 'connecting'
        state.errorCode = null
        const signal = listener.controller.signal
        listener.promise = (async () => {
            try {
                await platform.listen({
                    credential,
                    cursor: binding.cursor,
                    onMessage: (envelope, replyContext) => track(receiveMessage(
                        state, listener, binding, envelope, replyContext,
                    )),
                    onCursor: next => track(persistCursor(state, listener, binding, next)),
                    onReady: () => markReady(state, listener),
                    onLive: up => markLive(state, listener, up),
                    onAlert: alert => noteAlert(state, listener, alert),
                    signal,
                })
                if (!signal.aborted && !closing && state.listener === listener) {
                    setError(state, 'LISTEN_ENDED')
                }
            } catch (error) {
                if (signal.aborted || closing || isAbortError(error)) return
                handleListenFailure(state, binding, listener, error)
            } finally {
                if (state.listener === listener) state.listener = null
            }
        })()
        track(listener.promise)
    }

    /**
     * 取凭据并连接。closing 单调：每个 await 之后无条件复查，不只给配对 guard 查。
     * guard（配对提交时传入）另外核对本次尝试仍有效；失效则不开始新 listen。
     */
    async function ensureConnected(state, binding, guard) {
        if (closing) return 'stale'
        if (guard !== undefined && !guard()) return 'stale'
        if (state.listener !== null || state.retry !== null) return 'started'
        const platform = config.platforms[binding.platform]
        if (platform === undefined) {
            setError(state, 'PLATFORM_UNAVAILABLE')
            return 'error'
        }
        const credential = await readAccountCredential(binding)
        if (closing) return 'stale'
        if (guard !== undefined && !guard()) return 'stale'
        if (credential === null) {
            setError(state, 'CREDENTIAL_MISSING')
            return 'error'
        }
        let ingress
        try {
            ingress = getIngress(binding)
        } catch {
            setError(state, 'INGRESS_UNAVAILABLE')
            return 'error'
        }
        // 创建 helper 之后、实际 startListening 之前再查一次：关闭开始后不登记新连接。
        if (closing) return 'stale'
        if (guard !== undefined && !guard()) return 'stale'
        startListening(state, binding, platform, credential, ingress)
        return 'started'
    }

    /* ---------------------------- receive ---------------------------- */

    function normalizeEnvelope(raw, binding) {
        if (!isRecord(raw)) fail('INVALID_MESSAGE', 'onMessage 信封必须是对象')
        if (raw.kind !== (isGroupBinding(binding) ? 'group' : 'private')) fail('INVALID_MESSAGE', '只准入本人私聊与已绑定群里本人的消息')
        for (const field of ['platform', 'accountId', 'conversationId', 'senderId']) {
            if (!isNonEmptyString(raw[field])) fail('INVALID_MESSAGE', `信封 ${field} 必须是非空字符串`)
            if (raw[field] !== binding[field]) fail('INVALID_MESSAGE', `信封 ${field} 与已配对本人绑定不一致`)
        }
        // 平台原 messageId 保持字符串，不做数字转换。
        if (!isNonEmptyString(raw.messageId)) fail('INVALID_MESSAGE', '信封 messageId 必须是非空字符串')
        const images = raw.images === undefined ? [] : raw.images
        if (!Array.isArray(images) || !images.every(image => isRecord(image)
            && IMAGE_MEDIA_TYPES.includes(image.mediaType) && isNonEmptyString(image.data))) {
            fail('INVALID_MESSAGE', '信封 images 必须是受支持类型的 { mediaType, data } 数组')
        }
        if (typeof raw.text !== 'string' || (raw.text.trim() === '' && images.length === 0)) {
            fail('INVALID_MESSAGE', '信封 text 必须是非空白字符串（只有图片时可为空串）')
        }
        return {
            messageId: raw.messageId,
            text: raw.text,
            images: images.map(image => ({ mediaType: image.mediaType, data: image.data })),
            ...isRecord(raw.quote) ? { quote: raw.quote } : {},
        }
    }

    /** 引用的那条是不是这个会话发出去的：先按平台的编号认，认不出再按文字认（有的平台只给文字）。 */
    function findQuoted(quote, sessionId) {
        const flat = text => String(text).replace(/\s+/g, '')
        const wanted = isNonEmptyString(quote.text) ? flat(quote.text) : ''
        let byText = null
        for (const [, value] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(value)
            if (!parsed.success || parsed.data.state !== 'sent' || parsed.data.sessionId !== sessionId) continue
            const row = parsed.data
            if (isNonEmptyString(quote.platformMessageId) && row.receipt?.platformMessageId === quote.platformMessageId) return row
            if (isNonEmptyString(quote.refIdx) && row.receipt?.refIdx === quote.refIdx) return row
            if (byText !== null || row.kind !== undefined || wanted.length < QUOTE_MATCH_MIN_CHARS) continue
            const mine = flat(row.text)
            if (mine.length >= QUOTE_MATCH_MIN_CHARS && (mine === wanted || mine.startsWith(wanted) || wanted.startsWith(mine))) byText = row
        }
        return byText
    }

    /**
     * 用户引用了一条消息时写在用户的话前面的一行（信封的 `quote`：`{ platformMessageId?, refIdx?, text?, label?, image? }`，平台能给什么给什么）。
     * 只注明开头和编号，全文按编号去经历库查；对不上的只写开头，什么都没有就写"引用了一条消息"。
     */
    function quoteLine(quote, sessionId) {
        const head = (text) => {
            const flat = String(text).replace(/\s+/g, ' ').trim()
            return flat.length > QUOTE_HEAD_CHARS ? `${flat.slice(0, QUOTE_HEAD_CHARS)}…` : flat
        }
        const row = findQuoted(quote, sessionId)
        if (row !== null) {
            const what = row.kind === undefined ? head(row.text) : `一个${row.kind === 'image' ? '图片' : '文件'}`
            return `〔引用你发的：${what}，全文见 dsh:${row.sessionId}:${row.sourceSeqs.at(-1)}〕`
        }
        const label = isNonEmptyString(quote.label) ? ` ${quote.label}` : ''
        if (isNonEmptyString(quote.text)) return `〔引用${label}：${head(quote.text)}〕`
        if (quote.image !== undefined && quote.image !== null) return `〔引用了一张图片${isNonEmptyString(quote.image) ? `（${quote.image}）` : ''}〕`
        return '〔引用了一条消息〕'
    }

    /**
     * replyContext 就是被动回复的准确原消息锚点，原样保存；不自造“最近一条”。
     * 字段值必须是字符串，但允许空串（微信 contextToken 真实存在空值）：
     * 空 contextToken 收件/准入照常，只有发送时才按 notSent 拒绝。
     */
    function normalizeAnchor(raw, messageId) {
        if (!isRecord(raw)) fail('INVALID_ANCHOR', 'replyContext 缺失：被动回复需要准确原消息锚点')
        const anchor = {}
        for (const [name, value] of Object.entries(raw)) {
            if (typeof value !== 'string') {
                fail('INVALID_ANCHOR', 'replyContext 的锚点字段必须是字符串')
            }
            anchor[name] = value
        }
        const values = Object.values(anchor)
        if (values.length === 0) fail('INVALID_ANCHOR', 'replyContext 为空')
        if (!values.some(value => value !== '')) fail('INVALID_ANCHOR', 'replyContext 没有可用的原消息身份')
        if ('platformMessageId' in anchor && anchor.platformMessageId !== messageId) {
            fail('ANCHOR_MISMATCH', 'replyContext 的原消息身份与信封不一致')
        }
        if ('messageId' in anchor && anchor.messageId !== messageId) {
            fail('ANCHOR_MISMATCH', 'replyContext 的原消息身份与信封不一致')
        }
        return anchor
    }

    async function receiveMessage(state, listener, binding, envelope, replyContext) {
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭，拒绝新输入')
        const owner = readBinding(state.platform)
        if (owner === null
            || owner.enabled !== true
            || owner.bindingId !== binding.bindingId
            || state.listener !== listener) {
            fail('NOT_BOUND', '该平台当前没有可用的本人绑定')
        }
        // 群里本人的话进这个群接的会话；没绑上的群不留原件（不能让监听因此停下），结果告诉平台。
        let current = owner
        if (isRecord(envelope) && envelope.kind === 'group') {
            const found = await groupBindingFor(state, owner, envelope)
            if (found.group === undefined) return { status: found.status }
            current = found.group
        }
        const message = normalizeEnvelope(envelope, current)
        const anchor = normalizeAnchor(replyContext, message.messageId)
        const fingerprintOf = text => incomingFingerprintOf({
            platform: current.platform,
            accountId: current.accountId,
            conversationId: current.conversationId,
            senderId: current.senderId,
            platformMessageId: message.messageId,
            text,
            imageCount: message.images.length,
        })
        // 认重推按平台给的原话：引用那一行是按当时的投递记录写的，同一条重推时可能不一样，不算不同的消息。
        const fingerprint = fingerprintOf(message.text)
        const key = incomingKeyOf(current.bindingId, message.messageId)
        return serialize(key, async () => {
            const existing = tables.incoming.get(key)
            if (existing !== undefined) {
                const row = readIncoming(key)
                // 已有的行形状不可用、或这一身份已判冲突：不覆盖，按冲突答复（确定的结果，平台不必重送）。
                if (row === null) return { status: RECEIVE.CONFLICT }
                if (row.fingerprint === fingerprint) {
                    if (row.state === 'conflict') return { status: RECEIVE.CONFLICT }
                    // 同一身份同一正文：复用已持久原件，不重复写。
                    return { status: RECEIVE.DUPLICATE }
                }
                // 任何不同正文命中都要持久标冲突：已准入的行保留真实 native 引用与原
                // text（accepted 的 null 也保留），只让它不再参与这一身份的回复。
                if (row.state !== 'conflict') {
                    await putIncoming(key, { ...row, state: 'conflict' })
                }
                return { status: RECEIVE.CONFLICT }
            }
            const anchorKey = anchorCredentialKey(current.bindingId, message.messageId)
            // 只写一次：进会话的正文从这里定下来，准入时按它核对（`admittedFingerprint`）。
            let text = message.text
            if (message.quote !== undefined) {
                const line = quoteLine(message.quote, current.sessionId)
                text = text === '' ? line : `${line}\n${text}`
            }
            // 先持久锚点凭据，再持久 incoming：两者成功后才 resolve 给平台。
            await writeGrant(anchorKey, {
                bindingId: current.bindingId,
                platform: current.platform,
                conversationId: current.conversationId,
                platformMessageId: message.messageId,
                anchor,
            })
            await putIncoming(key, {
                bindingId: current.bindingId,
                platformMessageId: message.messageId,
                platform: current.platform,
                accountId: current.accountId,
                conversationId: current.conversationId,
                senderId: current.senderId,
                fingerprint,
                ...text === message.text ? {} : { admittedFingerprint: fingerprintOf(text) },
                text,
                ...message.images.length === 0 ? {} : { images: message.images },
                anchorKey,
                state: 'queued',
                requestId: null,
                nativeMessageId: null,
                nativeSeq: null,
                createdAt: config.now(),
            })
            // 平台在这之后才推进续收位置（微信）或回确认（例如经手机转发的平台）；这里只请求一次合并对账。
            requestWakeSafely()
            return { status: RECEIVE.PERSISTED }
        })
    }

    /**
     * 平台的续收位置只在本批所有 receive 持久成功后写入，且永远是平台给的原值（opaque 字符串，
     * 不解析、不比较大小）。写入走 exact 更新：写槽里重核仍是捕获的 bindingId、listener
     * 仍属本次连接且未关闭，旧 listener 不会覆盖新 owner，也不会复活已删除的 binding。
     */
    async function persistCursor(state, listener, binding, next) {
        if (closing || state.listener !== listener) return
        if (typeof next !== 'string') fail('INVALID_CURSOR', '平台游标必须是原始字符串')
        await updateBindingExact(state.platform, binding.bindingId, current => {
            if (closing || state.listener !== listener) return current
            return { ...current, cursor: next }
        })
    }

    /**
     * 群消息找它的群绑定。还没绑定时问一次群解析规则（setGroupResolver 设的）要接哪个会话，之后群改名不影响。
     * 返回 `{ group }`；绑不上时返回 `{ status }`：`rejected`（确定不收：没有规则或规则不接、会话打不开、用户解绑过等，
     * 已经或不必转交中枢说明）或 `retry`（这次没法判断：平台还没给群名、规则暂时查不了、等待期间换了绑定），交给平台稍后重送。
     * 同一个群的绑定串行进行，不会建出两条。
     */
    async function groupBindingFor(state, owner, envelope) {
        if (typeof config.platforms[state.platform]?.groupList !== 'function') fail('INVALID_MESSAGE', '这个平台不支持群')
        const conversationId = envelope.conversationId
        if (!isGroupConversation(conversationId)) fail('INVALID_MESSAGE', '群信封 conversationId 必须是 group:<群号>')
        if (envelope.platform !== owner.platform || envelope.accountId !== owner.accountId || envelope.senderId !== owner.senderId) {
            fail('INVALID_MESSAGE', '群信封与已配对本人绑定不一致')
        }
        const key = groupBindingKey(owner.platform, conversationId)
        // 与工具、设置页的改动共用一条链：一个会话只接一个群的检查与写入之间不会插进别的绑定。
        return serialize(groupsChain(owner.platform), async () => {
            const existing = readBindingAt(key)
            if (existing !== null && existing.ownerBindingId === owner.bindingId) {
                if (existing.enabled === true) return { group: existing }
                // 用户明确解绑过：不按群名绑回去，中枢说明一次（每次解绑说一次）。
                if (existing.unboundAt !== undefined) {
                    const groupName = isNonEmptyString(envelope.groupName) ? envelope.groupName.trim() : existing.groupName ?? conversationId
                    noticeUnboundMarked(owner, conversationId, groupName, existing.unboundAt)
                }
                return { status: RECEIVE.REJECTED }
            }
            // 平台还没给这个群的群名：这次不绑定也不说明，稍后重送再试。
            if (!isNonEmptyString(envelope.groupName)) return { status: RECEIVE.RETRY }
            const groupName = envelope.groupName.trim()
            let reason = null
            let found = null
            if (groupResolver === null) {
                reason = GROUP_UNBOUND_REASONS.NO_RULE
            } else {
                try {
                    found = await groupResolver({ platform: owner.platform, groupId: conversationId.slice(GROUP_PREFIX.length), groupName })
                } catch {
                    // 规则暂时查不了（例如宿主的服务还没好）：这次不处理，稍后重送再试。
                    return { status: RECEIVE.RETRY }
                }
                if (closing) return { status: RECEIVE.RETRY }
                if (!isRecord(found) || !isNonEmptyString(found.sessionId)) {
                    reason = isRecord(found) && isNonEmptyString(found.reason) ? found.reason.trim() : GROUP_UNBOUND_REASONS.NO_RULE
                } else if (await observeOwnedSession(found.sessionId) === null) {
                    reason = GROUP_UNBOUND_REASONS.NO_SESSION
                } else if (groupBindingsOf(owner).some(group => group.sessionId === found.sessionId)) {
                    // 一个会话只接一个群：要接的会话已经接了别的群，回复不能有两个去处。
                    reason = GROUP_UNBOUND_REASONS.SESSION_TAKEN
                }
            }
            if (closing) return { status: RECEIVE.RETRY }
            if (reason !== null) {
                noticeUnboundGroup(owner, conversationId, groupName, reason)
                return { status: RECEIVE.REJECTED }
            }
            // 等待期间私聊绑定换了（重新配对、断开）：不再替旧绑定建群绑定。
            if (groupOwnerOf({ platform: owner.platform, ownerBindingId: owner.bindingId }) === null) return { status: RECEIVE.RETRY }
            const group = {
                platform: owner.platform,
                bindingId: randomUUID(),
                accountId: owner.accountId,
                senderId: owner.senderId,
                conversationId,
                sessionId: found.sessionId,
                credentialKey: owner.credentialKey,
                enabled: true,
                createdAt: config.now(),
                ownerBindingId: owner.bindingId,
                groupName,
                sessionTitle: isNonEmptyString(found.sessionTitle) ? found.sessionTitle.trim() : found.sessionId,
            }
            await putRecord(tables.bindings, bindingSchema, key, group)
            return { group }
        })
    }

    /**
     * 渠道自己给中枢的通知：经核心的入口放进会话，同一个键只放一次。
     * 都是用户刚在群里说了话引起的，回复按"代用户"对待（休息时段里也立即发到手机）。
     * @returns 核心 deliver 的结果；交不出时为 `{status:'unavailable'}`，不抛错。
     */
    async function noticeHub(sessionId, { key, text, images, speaker = CHANNEL_SPEAKER, via }) {
        try {
            return await host.core.deliver(sessionId, {
                key,
                text,
                ...images === undefined || images.length === 0 ? {} : { images },
                source: { kind: CHANNEL_NOTICE_SOURCE },
                speaker,
                ...via === undefined ? {} : { via },
                reply: { onBehalfOfUser: true },
            })
        } catch (error) {
            return { status: 'unavailable', reason: error?.message ?? String(error) }
        }
    }

    /** 绑不上的群：告诉中枢一次（同一个群、同一群名与原因只放一次）。`reason` 是说明文字。 */
    function noticeUnboundGroup(owner, conversationId, groupName, reason) {
        const digest = sha256(JSON.stringify([groupName, reason])).slice(0, 16)
        const groupId = conversationId.slice(GROUP_PREFIX.length)
        const key = `group-unbound-${groupId}-${digest}`
        const text = `【${labelOf(owner.platform)}群】（消息渠道的通知）${labelOf(owner.platform)}收到用户在群「${groupName}」（群号 ${groupId}）里的消息，但没有处理：`
            + `${reason}。要让这个群接一个会话，问用户要接到哪个会话，然后用 \`assistant_channel_group\` 绑定。`
            + '接上以后请用户在群里再说一遍（刚才那条没有留下）。请把这件事简短告诉用户。'
        // 中枢暂时交不了：下一条群消息会再试。
        track(noticeHub(owner.sessionId, { key, text })).catch(() => {})
    }

    /** 用户解绑过的群里又说了话：不处理，告诉中枢一次（每次解绑说一次）。 */
    function noticeUnboundMarked(owner, conversationId, groupName, unboundAt) {
        const groupId = conversationId.slice(GROUP_PREFIX.length)
        const text = `【${labelOf(owner.platform)}群】（消息渠道的通知）用户在群「${groupName}」（群号 ${groupId}）里说了话，但这个群已经解绑，消息没有处理。`
            + '用户要重新接上时，用 `assistant_channel_group` 绑定到用户指定的会话，再请用户在群里重说一遍。请把这件事简短告诉用户。'
        // 中枢暂时交不了：下一条群消息会再试。
        track(noticeHub(owner.sessionId, { key: `group-unbound-${groupId}-at-${unboundAt}`, text })).catch(() => {})
    }

    /* ---------------------------- 群接的会话不在了 ---------------------------- */

    /**
     * 群接的会话现在怎样：`archived`（宿主登记为已归档）、`deleted`（官方 not-found）、`present`，
     * 或 `unknown`（读取失败、header 不符）。只有前两种是确定结论，才会把群里的话转走。
     */
    async function groupSessionPresence(group) {
        if (config.isArchived !== null) {
            let archived
            try {
                archived = await config.isArchived(group.sessionId)
            } catch {
                archived = undefined
            }
            if (archived === true) return 'archived'
        }
        let observation
        try {
            observation = await host.sessionQuery.observeSession(group.sessionId, {
                projectionMode: 'none',
                signal: lifecycle.signal,
            })
        } catch (error) {
            return isSessionQueryNotFound(error) ? 'deleted' : 'unknown'
        }
        try {
            if (!isRecord(observation) || !isRecord(observation.header)) return 'unknown'
            if (typeof observation[Symbol.dispose] !== 'function') return 'unknown'
            if (observation.header.id !== group.sessionId || observation.header.origin === 'subagent') return 'unknown'
            return 'present'
        } finally {
            disposeObservation(observation)
        }
    }

    /** 群绑定显示用的会话标题：绑定时记下的标题，旧行用「项目名·项目会话」，再没有就是会话 id。 */
    function sessionTitleOf(group) {
        if (isNonEmptyString(group.sessionTitle)) return group.sessionTitle
        if (isNonEmptyString(group.projectTitle)) return `${group.projectTitle}·项目会话`
        return group.sessionId
    }

    /**
     * 群接的会话确定被删除或归档：群里还没准入的本人消息按私聊同样的安静时间合成一组，经转交交给中枢
     * （带图片、不看桌面），原件记为 forwarded。这一次“不在了”的第一组带长说明，并在群里说一次（先记下再发，
     * 崩溃时宁可少说一次）。转交不可用时原件保持 queued，下次对账再试。
     */
    async function forwardGoneGroup(owner, group, reason) {
        // 合并准入的一组按整组处理：首条不是 queued（例如准入结果不明，可能已进了原会话）时，它的其余原件也不转，
        // 留给会话恢复后由首条一起核对；拆开转走会让首条再也找不齐成员。
        const rows = readIncomingRows()
            .filter(row => row.bindingId === group.bindingId && row.state === 'queued'
                && platformOriginal(row)
                && (row.mergedInto === undefined || readIncoming(row.mergedInto)?.state === 'queued'))
            .sort((left, right) => left.createdAt - right.createdAt
                || (left.platformMessageId < right.platformMessageId ? -1 : 1))
        if (rows.length === 0) return
        const wait = mergeWait(rows)
        if (wait > 0) {
            scheduleMergeWake(wait)
            return
        }
        const keys = rows.map(row => incomingKeyOf(row.bindingId, row.platformMessageId))
        const first = group.gone === undefined || group.gone.sessionId !== group.sessionId
        const groupId = group.conversationId.slice(GROUP_PREFIX.length)
        const groupName = group.groupName ?? groupId
        const title = sessionTitleOf(group)
        const what = reason === 'deleted' ? '已经删除' : '已经归档'
        const head = first
            ? `【群】用户在群「${groupName}」（群号 ${groupId}）里说了下面的话。这个群接的「${title}」${what}，`
                + '所以转到这里；群里已经告诉用户。用户说要改接到哪个会话或解绑时，用 `assistant_channel_group`。'
            : `【群「${groupName}」，原会话已不在，转到这里】`
        const body = rows.map(row => row.text ?? '').filter(part => part.trim() !== '').join('\n')
        const images = rows.flatMap(row => row.images ?? [])
        // 群里的话是用户本人说的，出处照实写（从哪个群来）；开头那段说明是渠道加的，正文里写明了。
        const result = await noticeHub(owner.sessionId, {
            // 由这一组的全部原件决定：崩溃后再来的一组若多了新消息，键不同，宁可重复也不漏。
            key: `group-moved-${sha256(JSON.stringify(keys)).slice(0, 32)}`,
            text: body === '' ? head : `${head}\n\n${body}`,
            images,
            speaker: { kind: 'user' },
            via: originOf(group, false, labelOf(group.platform)).via,
        })
        // 结果不明（可能已经在会话里）时先不记转走：下次再交，核心按键认出交过，返回 duplicate。
        if (result.status !== 'delivered' && result.status !== 'duplicate') return
        for (const key of keys) {
            await serialize(key, async () => {
                const latest = readIncoming(key)
                if (latest === null || latest.state !== 'queued') return
                await putIncoming(key, { ...latest, state: 'forwarded', text: null, ...latest.images === undefined ? {} : { images: null } })
            })
        }
        if (!first) return
        const at = config.now()
        const key = groupBindingKey(group.platform, group.conversationId)
        await updateBindingExact(key, group.bindingId, current => (
            current.sessionId !== group.sessionId || current.gone?.sessionId === group.sessionId
                ? current
                : { ...current, gone: { sessionId: group.sessionId, reason, at } }
        ))
        const current = readBindingAt(key)
        if (current === null || current.gone?.at !== at) return
        track(sendSystem(current, GROUP_NOTICES.gone(title, reason), { key: `gone-${group.sessionId}-${at}`, system: 'group' })).catch(() => {
            // 发不出去：群里少说一次，转交已经写进中枢。
        })
    }

    /** 群接的会话又能用了（取消归档）：去掉“已经说过”，下次再不在了会重新说一次。 */
    async function clearGone(group) {
        await updateBindingExact(groupBindingKey(group.platform, group.conversationId), group.bindingId, (current) => {
            if (current.gone === undefined) return current
            const { gone, ...rest } = current
            return rest
        })
    }

    /* ---------------------------- 群的系统说明与任务进度 ---------------------------- */

    /** 渠道自己发进群的一片：投递身份由群绑定、说明键与片序号决定。 */
    function systemDeliveryIdOf(bindingId, key, partIndex) {
        return `delivery-${sha256(JSON.stringify([SYSTEM_DELIVERY_DOMAIN, bindingId, key, partIndex]))}`
    }

    /**
     * 渠道自己往群里发一段固定的话（不经模型）。支持群的平台连着就能发，不借对方消息的锚点：每个群绑定一条固定的系统锚点。
     * 文字照常经 replyParts 与平台的发送节奏。同一说明键已发过（不是失败）的片不再发。
     * 平台确定没发出时不改道（只改会话写的话）：群说明的范围只有这个群，无处可改；私聊的说明（额度、等重试、平台掉线）
     * 确定没发出就不算说过，由各自的调用方下次照常重新选路再说（那时暂停的绑定已被跳过），这里再改道会和那次重说各发一遍；
     * 它们也不进给会话的未送达说明，不会引出会话补发。连续没发出照样计入暂停（sendPrepared 里数）。
     * @returns {Promise<'sent'|'failed'>}
     */
    async function sendSystem(binding, text, { key, system, anchor }) {
        const state = stateOf(binding.platform)
        // 给定锚点时借对方那条消息发（私聊的额度说明）；否则群用自己的固定系统锚点。
        const anchorKey = anchor ?? anchorCredentialKey(binding.bindingId, `${SYSTEM_ANCHOR_ID}:${binding.conversationId}`)
        if (anchor === undefined && await readAnchor(binding, anchorKey) === null) {
            await writeGrant(anchorKey, {
                bindingId: binding.bindingId,
                platform: binding.platform,
                conversationId: binding.conversationId,
                platformMessageId: SYSTEM_ANCHOR_ID,
                anchor: { groupId: binding.conversationId.slice(GROUP_PREFIX.length) },
            })
        }
        const parts = replyParts(binding.platform, text)
        const endSeq = config.now()
        for (let index = 0; index < parts.length; index += 1) {
            if (closing) return 'failed'
            const deliveryId = systemDeliveryIdOf(binding.bindingId, key, index)
            const stored = readOutgoing(deliveryId)
            // 记下了还没开始发（prepared，例如在打字节奏里停机）：用同一行接着发。开始发过的（sending 重启后是 unknown）
            // 与已发出的不再发，最多一次。同一说明键在本进程里由调用方串行，不会两处同时接着发。
            if (stored !== null && stored.state === 'prepared') {
                if (await sendPrepared(state, binding, null, deliveryId, stored) !== 'sent') return 'failed'
                continue
            }
            if (stored !== null && stored.state !== 'failed') continue
            const prepared = {
                bindingId: binding.bindingId,
                sessionId: binding.sessionId,
                turn: 0,
                endSeq,
                sourceSeqs: [0],
                inputRequestIds: [`${SYSTEM_ANCHOR_ID}:${key}`],
                anchorKey,
                partIndex: index,
                partCount: parts.length,
                ...parts[index].kind === undefined ? {} : { kind: parts[index].kind },
                text: parts[index].text,
                state: 'prepared',
                receipt: null,
                errorCode: null,
                push: true,
                system,
            }
            await putOutgoing(deliveryId, prepared)
            if (await sendPrepared(state, binding, null, deliveryId, prepared) !== 'sent') {
                reportPushed(binding, binding.sessionId, endSeq)
                return 'failed'
            }
        }
        reportPushed(binding, binding.sessionId, endSeq)
        return parts.length > 0 ? 'sent' : 'failed'
    }

    /** 一次中途发送（或一条系统说明）发完了：把这一组片拼成经历库条目交出去；交不出不影响发送。 */
    function reportPushed(binding, sessionId, endSeq) {
        if (config.pushed === null) return
        const rows = []
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            const row = parsed.data
            if (row.push !== true || row.bindingId !== binding.bindingId || row.sessionId !== sessionId || row.endSeq !== endSeq) continue
            // 平台确定没发出、改道发出了的片照发出了记。
            rows.push(row.state !== 'sent' && deliveredRow(row) ? { ...row, state: 'sent' } : row)
        }
        const entry = pushEntryOf(rows, labelOf(binding.platform))
        if (entry === null) return
        track(Promise.resolve().then(() => config.pushed(entry))).catch(() => {})
    }

    /**
     * 这段时间里这个会话中途发到用户手上的话（出口的 `sentBetween`，交接带最近几轮原文时用）。只算会话自己发的、
     * 确实到了用户手上的片：渠道自己的说明、外部调用方经端点发的不算；改道发出的算在原来那一片上。
     * @returns `[{ at, text }]`，`at` 是发送时刻（毫秒）。
     */
    function sentBetween(sessionId, from = 0, to = Infinity) {
        const sends = new Map()
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            const row = parsed.data
            if (row.push !== true || row.sessionId !== sessionId || row.system !== undefined || row.by?.kind === 'external') continue
            if ((row.partIndex ?? 0) >= REROUTE_PART_BASE || row.endSeq < from || row.endSeq > to) continue
            const send = sends.get(row.endSeq) ?? []
            send.push(row)
            sends.set(row.endSeq, send)
        }
        const out = []
        for (const [at, rows] of sends) {
            const delivered = rows.filter(deliveredRow).sort((left, right) => (left.partIndex ?? 0) - (right.partIndex ?? 0))
            const body = pushBodyOf(delivered)
            if (body !== '') out.push({ at, text: delivered.length < rows.length ? `${body}\n（这次发送有一部分没发出去）` : body })
        }
        return out.sort((left, right) => left.at - right.at)
    }

    /**
     * 同一说明键已经开始发过的系统片（任务进度去重：换了群也不再发第二次）。失败的与只记下还没开始发的（prepared）不算：
     * 前者可以再发，后者由 sendSystem 用同一行接着发。
     */
    function systemNoticeExists(key) {
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success || parsed.data.system === undefined) continue
            if (parsed.data.inputRequestIds[0] !== `${SYSTEM_ANCHOR_ID}:${key}`) continue
            if (parsed.data.state !== 'failed' && parsed.data.state !== 'prepared') return true
        }
        return false
    }

    /**
     * 出口通知（核心 `core.exits.notify`）：项目任务的进度这类固定的话发到群。`sessionIds` 是核心挑给渠道的、
     * 渠道接着的会话（按调用方的顺序，项目会话在前），取第一个接了群、且会话还在的。
     * 事件超过 6 小时、这个群 24 小时内已满 20 条、同一 `key` 已经发过时按规则不发（`skipped`）；
     * 没有群、或者这些会话都没接群：没有可发的地方，是 `skipped`（`NO_GROUP`），不算没发出：大多数人不接群，
     * 每件任务都报异常就成了噪音。接着群、但群接的会话都不在了，才是没发出（`failed`，`GROUP_GONE`），由核心报出来。
     * 派任务的只有中枢、中枢不接群，所以不再判断"群接的就是派任务的会话"。
     * @param {{ sessionIds: string[], key: string, text: string, at?: number }} request
     * @returns {Promise<{ status: 'sent'|'failed'|'unknown', groupId?: string, reason?: string } | { status: 'skipped', reason: string }>}
     */
    async function notify({ sessionIds, key, text, at } = {}) {
        if (!Array.isArray(sessionIds) || !sessionIds.every(isNonEmptyString) || !isNonEmptyString(key) || !isNonEmptyString(text)) {
            throw new ChannelRuntimeError('INVALID_NOTICE', 'notify 需要 sessionIds、key 与 text')
        }
        if (closing) return { status: 'skipped', reason: 'CLOSED' }
        if (Number.isFinite(at) && config.now() - at > TASK_NOTICE_STALE_MS) return { status: 'skipped', reason: 'STALE' }
        return serialize(`task-notice:${key}`, async () => {
            if (systemNoticeExists(key)) return { status: 'skipped', reason: 'DUPLICATE' }
            const owner = readGroupOwner()
            if (owner === null || owner.enabled !== true) return { status: 'skipped', reason: 'NO_GROUP' }
            const groups = groupBindingsOf(owner)
            let chosen = null
            let bound = false
            for (const sessionId of sessionIds) {
                const group = groups.find(item => item.sessionId === sessionId)
                if (group === undefined) continue
                bound = true
                if (await groupSessionPresence(group) !== 'present') continue
                chosen = group
                break
            }
            if (chosen === null) return bound ? { status: 'failed', reason: 'GROUP_GONE' } : { status: 'skipped', reason: 'NO_GROUP' }
            let recent = 0
            // 这条事件自己落盘未发的行（停机前已记下）不占名额，否则补发会被它自己挡住，拖过 6 小时就永远不发了。
            const own = `${SYSTEM_ANCHOR_ID}:${key}`
            for (const [, raw] of readEntries(tables.outgoing)) {
                const parsed = outgoingSchema.safeParse(raw)
                if (!parsed.success) continue
                const row = parsed.data
                if (row.inputRequestIds[0] === own) continue
                if (row.system === 'task' && row.bindingId === chosen.bindingId && row.partIndex === 0 && row.state !== 'failed'
                    && config.now() - row.endSeq < TASK_NOTICE_WINDOW_MS) recent += 1
            }
            if (recent >= TASK_NOTICE_LIMIT) return { status: 'skipped', reason: 'CAP' }
            const status = await sendSystem(chosen, text, { key, system: 'task' })
            return { status, groupId: chosen.conversationId.slice(GROUP_PREFIX.length) }
        })
    }

    /* ---------------------------- 群绑定的查看与改动 ---------------------------- */

    /** 挂在这个私聊绑定上的全部群绑定行（含已解绑的）。 */
    function groupRowsOf(owner) {
        const prefix = `${owner.platform}-group-`
        const rows = []
        for (const [key, raw] of readEntries(tables.bindings)) {
            if (typeof key !== 'string' || !key.startsWith(prefix)) continue
            const parsed = parseBinding(raw)
            if (!parsed.success || parsed.data.ownerBindingId !== owner.bindingId) continue
            if (key !== groupBindingKey(parsed.data.platform, parsed.data.conversationId)) continue
            rows.push(parsed.data)
        }
        return rows.sort((left, right) => left.createdAt - right.createdAt)
    }

    /**
     * 中枢（原来叫中枢、取私聊绑定指向的会话）：有中枢、且有启用的私聊绑定时就是它，否则为空。
     * 用 Set 是为了调用处照旧按"是不是"判。中枢已经接着私聊，不能再接群。
     */
    function hubSessions() {
        const hub = hubSessionId()
        if (hub === null) return new Set()
        return platformIds().some(platform => readBinding(platform)?.enabled === true) ? new Set([hub]) : new Set()
    }

    /** 这个会话接着的群（只算启用的群绑定）：`{ groupId, name }`，没有时为 null。 */
    function groupOfSession(sessionId) {
        const owner = readGroupOwner()
        if (owner === null || owner.enabled !== true) return null
        const group = groupBindingsOf(owner).find(item => item.sessionId === sessionId)
        if (group === undefined) return null
        const groupId = group.conversationId.slice(GROUP_PREFIX.length)
        return { groupId, name: group.groupName ?? groupId, label: labelOf(owner.platform) }
    }

    /**
     * 调用工具的会话是谁：`task`（任务会话，一律不行）、`main`（中枢，任何群）、`bound`（接着某个群，只动自己的群）、
     * `other`（没接群的普通会话，只能把一个群接到自己）。
     */
    function callerRole(owner, caller) {
        if (!isNonEmptyString(caller)) return { kind: 'none' }
        if (caller.startsWith(TASK_SESSION_PREFIX)) return { kind: 'task' }
        if (hubSessions().has(caller)) return { kind: 'main' }
        const group = groupBindingsOf(owner).find(item => item.sessionId === caller)
        return group === undefined ? { kind: 'other' } : { kind: 'bound', group }
    }

    /** 支持群的平台当前的群列表 `[{groupId, name}]`；平台不支持或没连上时为 null。 */
    async function platformGroups(owner) {
        const platform = config.platforms[owner.platform]
        if (typeof platform?.groupList !== 'function') return null
        const state = stateOf(owner.platform)
        if (!hasReadyListener(state, owner)) return null
        const credential = await readAccountCredential(owner)
        if (credential === null) return null
        try {
            const list = await platform.groupList({ credential })
            return Array.isArray(list)
                ? list.filter(item => isRecord(item) && /^\d+$/.test(String(item.groupId)))
                    .map(item => ({ groupId: String(item.groupId), name: isNonEmptyString(item.name) ? item.name.trim() : String(item.groupId) }))
                : null
        } catch {
            return null
        }
    }

    /**
     * “群”的说法换成群号：纯数字直接用；否则先在平台的群列表里按群名精确匹配，再在已有的群绑定行里匹配。
     * @returns {{ groupId: string } | { reason: 'GROUP_UNKNOWN' | 'GROUP_AMBIGUOUS', candidates: string[] }}
     */
    function resolveGroupRef(text, known, rows) {
        const value = String(text).trim()
        if (/^\d+$/.test(value)) return { groupId: value }
        const byName = (known ?? []).filter(item => item.name === value).map(item => item.groupId)
        const fromRows = rows.filter(row => row.groupName === value).map(row => row.conversationId.slice(GROUP_PREFIX.length))
        const matches = [...new Set(byName.length > 0 ? byName : fromRows)]
        if (matches.length === 1) return { groupId: matches[0] }
        const similar = (known ?? []).filter(item => item.name.includes(value)).map(item => `${item.name}（${item.groupId}）`).slice(0, 5)
        return matches.length === 0
            ? { reason: 'GROUP_UNKNOWN', candidates: similar }
            : { reason: 'GROUP_AMBIGUOUS', candidates: matches }
    }

    function groupView(row, known) {
        const groupId = row.conversationId.slice(GROUP_PREFIX.length)
        return {
            groupId,
            name: known?.find(item => item.groupId === groupId)?.name ?? row.groupName ?? groupId,
            sessionId: row.sessionId,
            session: sessionTitleOf(row),
            unbound: row.enabled !== true,
            gone: row.gone?.sessionId === row.sessionId ? row.gone.reason : null,
        }
    }

    /**
     * 列出群：中枢与没接群的会话看到这个平台上的全部群（含没接的）与已有的群绑定；接着群的会话只看到自己的群。
     * @param {{ caller: string }} request
     */
    async function listGroups({ caller } = {}) {
        const owner = readGroupOwner()
        if (owner === null || owner.enabled !== true) return { status: 'refused', reason: 'NO_ACCOUNT' }
        const role = callerRole(owner, caller)
        if (role.kind === 'task' || role.kind === 'none') return { status: 'refused', reason: 'NOT_ALLOWED' }
        const known = await platformGroups(owner)
        const rows = groupRowsOf(owner)
        const groups = rows.map(row => groupView(row, known))
        for (const item of known ?? []) {
            if (!groups.some(group => group.groupId === item.groupId)) {
                groups.push({ groupId: item.groupId, name: item.name, sessionId: null, session: null, unbound: false, gone: null })
            }
        }
        const own = role.kind === 'bound' ? role.group.conversationId.slice(GROUP_PREFIX.length) : null
        return {
            status: 'ok',
            connected: known !== null,
            groups: own === null ? groups : groups.filter(group => group.groupId === own),
        }
    }

    /** 这个群还在等的 `[等待]`：会话换了或群解绑，提醒不再交给谁。 */
    async function supersedeWaits(bindingId, sessionId) {
        for (const [deliveryId, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            const row = parsed.data
            if (row.bindingId !== bindingId || row.sessionId !== sessionId || row.kind !== 'wait' || row.waitState !== 'waiting') continue
            await putOutgoing(deliveryId, { ...row, waitState: 'superseded' })
        }
    }

    /** 在群链里停用一条群绑定（用户明确解绑）：记下解绑时间，挡住按群名自动绑回。 */
    async function disableGroupInChain(group) {
        const key = groupBindingKey(group.platform, group.conversationId)
        const at = config.now()
        await updateBindingExact(key, group.bindingId, (current) => {
            const { gone, ...rest } = current
            return { ...rest, enabled: false, unboundAt: at }
        })
        await closeIngress(group.bindingId)
        await supersedeWaits(group.bindingId, group.sessionId)
        const dropped = readIncomingRows().filter(row => row.bindingId === group.bindingId && row.state === 'queued'
            && platformOriginal(row)).length
        return { updated: readBindingAt(key), dropped, at }
    }

    /** 群的说法 → 群号，并按调用者核对能不能动这个群；失败时返回拒绝结果。 */
    function targetGroup(role, group, known, rows) {
        let groupId
        if (!isNonEmptyString(group)) {
            if (role.kind !== 'bound') return { refused: { status: 'refused', reason: 'GROUP_REQUIRED' } }
            groupId = role.group.conversationId.slice(GROUP_PREFIX.length)
        } else {
            const found = resolveGroupRef(group, known, rows)
            if (found.groupId === undefined) return { refused: { status: 'refused', reason: found.reason, candidates: found.candidates } }
            groupId = found.groupId
        }
        if (role.kind === 'bound' && groupId !== role.group.conversationId.slice(GROUP_PREFIX.length)) {
            return { refused: { status: 'refused', reason: 'GROUP_NOT_OWN', group: groupView(role.group, known) } }
        }
        return { groupId }
    }

    /**
     * 把一个群接到一个会话（新建、或原地改绑），见 。调用者：中枢任何群；接着群的会话只动自己的群；
     * 没接群的会话只能把群接到自己。目标不能是中枢、任务会话、子代理、打不开或已归档的会话；
     * 一个会话只接一个群，目标已接别的群时要 `replace` 才先解绑那个群。
     * @param {{ caller: string, group?: string, sessionId: string, sessionTitle?: string, replace?: boolean }} request
     */
    async function bindGroup({ caller, group, sessionId, sessionTitle, replace = false } = {}) {
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭')
        const owner = readGroupOwner()
        if (owner === null || owner.enabled !== true) return { status: 'refused', reason: 'NO_ACCOUNT' }
        const role = callerRole(owner, caller)
        if (role.kind === 'task' || role.kind === 'none') return { status: 'refused', reason: 'NOT_ALLOWED' }
        if (!isNonEmptyString(sessionId)) return { status: 'refused', reason: 'SESSION_REQUIRED' }
        if (role.kind === 'other' && sessionId !== caller) return { status: 'refused', reason: 'SELF_ONLY' }
        const known = await platformGroups(owner)
        const target = targetGroup(role, group, known, groupRowsOf(owner))
        if (target.refused !== undefined) return target.refused
        const { groupId } = target
        if (known === null) return { status: 'refused', reason: 'NOT_CONNECTED' }
        const entry = known.find(item => item.groupId === groupId)
        if (entry === undefined) return { status: 'refused', reason: 'GROUP_UNKNOWN', candidates: [] }
        if (sessionId.startsWith(TASK_SESSION_PREFIX)) return { status: 'refused', reason: 'SESSION_TASK' }
        if (hubSessions().has(sessionId)) return { status: 'refused', reason: 'SESSION_MAIN' }
        if (await observeOwnedSession(sessionId) === null) return { status: 'refused', reason: 'SESSION_UNKNOWN' }
        if (config.isArchived !== null && await Promise.resolve(config.isArchived(sessionId)).catch(() => false) === true) {
            return { status: 'refused', reason: 'SESSION_ARCHIVED' }
        }
        const title = isNonEmptyString(sessionTitle) ? sessionTitle.trim() : sessionId
        const conversationId = `${GROUP_PREFIX}${groupId}`
        const key = groupBindingKey(owner.platform, conversationId)
        const after = []
        const result = await serialize(groupsChain(owner.platform), async () => {
            // 等待期间私聊绑定换了（重新配对、断开）：不再替旧绑定改群。
            if (groupOwnerOf({ platform: owner.platform, ownerBindingId: owner.bindingId }) === null) return { status: 'refused', reason: 'NO_ACCOUNT' }
            const existing = readBindingAt(key)
            const mine = existing !== null && existing.ownerBindingId === owner.bindingId ? existing : null
            if (mine !== null && mine.enabled === true && mine.sessionId === sessionId) {
                return { status: 'same', groupId, name: entry.name, sessionId, session: sessionTitleOf(mine) }
            }
            // 一个会话只接一个群。
            const taken = groupBindingsOf(owner).find(item => item.sessionId === sessionId && item.conversationId !== conversationId)
            let replaced = null
            if (taken !== undefined) {
                if (replace !== true) return { status: 'refused', reason: 'SESSION_TAKEN', group: groupView(taken, known) }
                const { updated } = await disableGroupInChain(taken)
                replaced = groupView(taken, known)
                if (updated !== null) after.push(() => sendSystem(updated, GROUP_NOTICES.unbound(), { key: `unbind-${updated.bindingId}-${updated.unboundAt}`, system: 'group' }))
            }
            if (mine !== null && mine.enabled === true) {
                // 改绑：原地换会话，锚点与还没准入的原件跟着走；旧会话的等待作废，未发的回复片发送前核对会停下。
                const previous = { sessionId: mine.sessionId, session: sessionTitleOf(mine) }
                await updateBindingExact(key, mine.bindingId, (current) => {
                    const { gone, projectTitle, ...rest } = current
                    return { ...rest, sessionId, sessionTitle: title, groupName: entry.name }
                })
                await closeIngress(mine.bindingId)
                await supersedeWaits(mine.bindingId, previous.sessionId)
                const updated = readBindingAt(key)
                if (updated !== null) after.push(() => sendSystem(updated, GROUP_NOTICES.rebound(title), { key: `bind-${updated.bindingId}-${config.now()}`, system: 'group' }))
                return { status: 'rebound', groupId, name: entry.name, sessionId, session: title, previous, replaced }
            }
            const created = {
                platform: owner.platform,
                bindingId: randomUUID(),
                accountId: owner.accountId,
                senderId: owner.senderId,
                conversationId,
                sessionId,
                credentialKey: owner.credentialKey,
                enabled: true,
                createdAt: config.now(),
                ownerBindingId: owner.bindingId,
                groupName: entry.name,
                sessionTitle: title,
            }
            if (mine !== null) await closeIngress(mine.bindingId)
            await putRecord(tables.bindings, bindingSchema, key, created)
            after.push(() => sendSystem(created, GROUP_NOTICES.bound(title), { key: `bind-${created.bindingId}`, system: 'group' }))
            return { status: 'bound', groupId, name: entry.name, sessionId, session: title, replaced }
        })
        let confirmed = after.length === 0
        for (const send of after) confirmed = (await send().catch(() => 'failed')) === 'sent'
        requestWakeSafely()
        return result.status === 'refused' || result.status === 'same' ? result : { ...result, confirmed }
    }

    /**
     * 解绑一个群（工具或设置页）：这一行停用并记下解绑时间，群里发一句确认。设置页（`by: 'settings'`）可以解绑任何群；
     * 工具里中枢任何群、接着群的会话只解自己的群。
     * @param {{ caller?: string, group?: string, by?: 'tool'|'settings' }} request
     */
    async function unbindGroup({ caller, group, by = 'tool' } = {}) {
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭')
        const owner = readGroupOwner()
        if (owner === null || owner.enabled !== true) return { status: 'refused', reason: 'NO_ACCOUNT' }
        let role = { kind: 'main' }
        if (by !== 'settings') {
            role = callerRole(owner, caller)
            if (role.kind !== 'main' && role.kind !== 'bound') return { status: 'refused', reason: 'NOT_ALLOWED' }
        }
        const rows = groupRowsOf(owner)
        // 解绑不要求连着：群名先在已有的群绑定行里找。
        const target = targetGroup(role, group, /^\d+$/.test(String(group ?? '').trim()) ? null : await platformGroups(owner), rows)
        if (target.refused !== undefined) return target.refused
        const key = groupBindingKey(owner.platform, `${GROUP_PREFIX}${target.groupId}`)
        const result = await serialize(groupsChain(owner.platform), async () => {
            const current = readBindingAt(key)
            if (current === null || current.ownerBindingId !== owner.bindingId || current.enabled !== true) {
                return { status: 'refused', reason: 'NOT_BOUND', groupId: target.groupId }
            }
            const view = groupView(current, null)
            const { updated, dropped } = await disableGroupInChain(current)
            return { status: 'unbound', ...view, unbound: true, dropped, updated }
        })
        if (result.status !== 'unbound') return result
        const { updated, ...view } = result
        const confirmed = updated === null
            ? false
            : (await sendSystem(updated, GROUP_NOTICES.unbound(), { key: `unbind-${updated.bindingId}-${updated.unboundAt}`, system: 'group' }).catch(() => 'failed')) === 'sent'
        return { ...view, confirmed }
    }

    /* ---------------------------- wake ---------------------------- */

    /**
     * 请求一次合并对账。已有循环时并入下一次迭代；返回的 promise 在本轮
     * （含并入的请求）完成后兑现。传 sessionId 时只对账绑定到该会话的渠道，
     * 因此非绑定会话的 turn/end 不产生任何发送；不传参数保持全平台对账。
     */
    function wake(sessionId) {
        if (closing) {
            return Promise.reject(new ChannelRuntimeError('RUNTIME_CLOSED', '渠道运行态已关闭，拒绝 wake'))
        }
        if (sessionId !== undefined && !isNonEmptyString(sessionId)) {
            return Promise.reject(new ChannelRuntimeError('INVALID_ARGUMENT', 'wake(sessionId) 需要非空 sessionId'))
        }
        if (sessionId === undefined) wakeAll = true
        else wakeScope.add(sessionId)
        return new Promise((resolve, reject) => {
            wakeWaiters.push({ resolve, reject })
            reconcileRequested = true
            startReconcileLoop()
        })
    }

    function startReconcileLoop() {
        if (reconcileRunning) return
        reconcileRunning = true
        reconcileLoop = (async () => {
            let failure = null
            try {
                while (reconcileRequested && !closing) {
                    reconcileRequested = false
                    // 本轮覆盖范围：无参 wake 对账全部平台；带 sessionId 的 wake 只对账这些会话。
                    const scope = wakeAll ? null : new Set(wakeScope)
                    wakeAll = false
                    wakeScope.clear()
                    try {
                        await reconcileOnce(scope)
                    } catch (error) {
                        failure = error
                        break
                    }
                }
            } finally {
                reconcileRunning = false
                reconcileLoop = null
                const waiters = wakeWaiters.splice(0)
                // 等待者看到的是"这次唤醒该发的都发完了"：包括各绑定的后台投递。新的唤醒可以同时开始下一轮。
                const jobs = await Promise.allSettled([...deliveryJobs.values()].map(job => job.promise))
                const rejected = jobs.find(result => result.status === 'rejected')
                if (failure === null && rejected !== undefined) failure = rejected.reason
                for (const waiter of waiters) {
                    if (failure === null) waiter.resolve(undefined)
                    else waiter.reject(failure)
                }
            }
        })()
        track(reconcileLoop)
    }

    /**
     * scope=null 对账全部平台；否则只对账 binding.sessionId 命中 scope 的渠道。未命中的
     * 渠道不改连接、不改准入与回复：非绑定会话的 turn/end 不产生任何发送。
     */
    async function reconcileOnce(scope) {
        for (const platform of platformIds()) {
            if (closing) return
            const state = stateOf(platform)
            // 配对进行中不触碰连接与回复，回调只改当前尝试。
            if (state.attempt !== null) continue
            const binding = readBinding(platform)
            if (binding === null) {
                if (hasBindingRow(platform)) {
                    setError(state, 'BINDING_INVALID')
                    continue
                }
                await stopListener(state)
                if (state.activeBindingId !== null) {
                    await closeIngress(state.activeBindingId)
                    state.activeBindingId = null
                }
                state.downSince = null
                state.phase = 'idle'
                state.errorCode = null
                state.retryCount = 0
                continue
            }
            // 不在本轮 scope 内：保留既有连接与重试状态，只跳过本平台的准入与回复。
            // 群绑定各有自己接的会话：私聊不在 scope 内时，scope 里的群照常处理。
            const ownInScope = scope === null || scope.has(binding.sessionId)
            const groups = binding.enabled === true
                ? groupBindingsOf(binding).filter(group => scope === null || scope.has(group.sessionId))
                : []
            if (!ownInScope && groups.length === 0) continue
            if (state.activeBindingId !== binding.bindingId) {
                await stopListener(state)
                if (state.activeBindingId !== null) await closeIngress(state.activeBindingId)
                state.activeBindingId = binding.bindingId
                state.retryCount = 0
            }
            if (binding.enabled !== true) {
                await stopListener(state)
                state.phase = 'idle'
                continue
            }
            // 没有中枢：私聊的消息先留在渠道里（照常收，不准入也不发），报一次；同一个账号上的群照常。
            const noHub = binding.sessionId === null
            if (noHub) reportNoHub('QQ、微信私聊的消息先留在渠道里，定了中枢以后再交进去')
            else {
                noHubReported = false
                // 恢复只按中枢的真实普通会话引用核对；不读 UI 焦点，不重新选择会话。
                const owner = await verifyBindingSession(binding)
                if (closing) return
                if (owner === null || owner.sessionId !== binding.sessionId) {
                    // 中枢会话已消失或观察回了别的 id：停监听、不猜标题、不换会话。
                    await stopListener(state)
                    setError(state, 'OWNER_UNVERIFIED')
                    continue
                }
            }
            await ensureConnected(state, binding)
            if (closing) return
            if (ownInScope && !noHub) {
                await admitQueued(state, binding)
                if (closing) return
                await deliverReplies(state, binding)
                if (closing) return
            }
            for (const group of groups) {
                // 群接的会话确定被删除或归档：群里本人的话转到中枢，群里说一次。只是暂时查不了时这个群暂停，原件留着。
                const presence = await groupSessionPresence(group)
                if (closing) return
                if (presence === 'archived' || presence === 'deleted') {
                    await forwardGoneGroup(binding, group, presence)
                    continue
                }
                if (presence !== 'present') continue
                if (group.gone !== undefined) await clearGone(group)
                if (closing) return
                await admitQueued(state, group)
                if (closing) return
                await deliverReplies(state, group)
                if (closing) return
            }
            // 别的平台断开时，对方从这个渠道说了话、有了可用锚点：补发还没发出的掉线告警。
            for (const other of [...platformStates.values()]) {
                if (other.platform !== platform && other.downSince !== null && !other.alarmed) await alarmIfDown(other)
            }
        }
        // 中枢、接群会话里没有渠道输入的轮（按回复去向）：各平台的准入与回复对过之后再看，有渠道输入的轮已经按原逻辑成批。
        // `mainTurnReplies` 只管中枢的轮发不发到手机；接群会话的轮按去向发，不看它。
        if (closing) return
        for (const { sessionId, as } of exitSessions()) {
            if (as === 'hub' && !config.mainTurnReplies) continue
            if (scope === null || scope.has(sessionId)) deliverMainTurns(sessionId, as)
        }
    }

    /** 同一 incoming key 的冲突落盘：只改仍处于 pending 的原件，不覆盖已建立的原生引用。 */
    async function markConflict(key) {
        const latest = readIncoming(key)
        if (latest === null) return
        if (latest.state !== 'queued' && latest.state !== 'unknown') return
        await putIncoming(key, { ...latest, state: 'conflict' })
    }

    /**
     * 准入一条 pending 原件。与 receive 共用同一 key 锁：入锁后重读，await 之后再重读，
     * 绝不用旧快照覆盖并发写入的 conflict 或新 native 引用。
     */
    async function admitOne(state, binding, ingress, key) {
        let row = readIncoming(key)
        if (row === null) return 'skipped'
        if (row.bindingId !== binding.bindingId) return 'skipped'
        if (row.state !== 'queued' && row.state !== 'unknown') return 'skipped'
        // 一组原件以首条身份合并准入：正文按到达顺序换行拼接，图片依次附上。
        const members = [row]
        for (const memberKey of row.mergeKeys ?? []) {
            const member = readIncoming(memberKey)
            if (member === null || member.mergedInto !== key || member.state !== 'queued') return 'invalid'
            members.push(member)
        }
        // 没有保留原件就无法核对原生来源，保持原状态等待人工确认。
        if (members.some(member => member.text === null)) return 'skipped'
        // 给会话的渠道提示改走核心的附提醒，不再接在对方的话后面。以前已经接上说明、
        // 结果不明的旧原件重试时照接，正文要和第一次一样才对得上会话里的原件。
        const body = members.length === 1 ? row.text : members.map(member => member.text).filter(part => part.trim() !== '').join('\n')
        const text = row.notice === undefined ? body : body.trim() === '' ? row.notice : `${body}\n\n${row.notice}`
        const images = members.flatMap(member => member.images ?? [])
        // 请求号前缀分开用户本人的和渠道代为放进来的：一组里有一条是代为放进来的，整组都不算用户本人说的；
        // 已经准入过、记着请求号的（结果不明重试），沿用原来的前缀，才对得上会话里已有的原件。
        const relayed = row.requestId !== null
            ? row.requestId.startsWith(CHANNEL_RELAY_PREFIX)
            : members.some(member => relayedInput(member.platformMessageId))
        let result
        try {
            result = await ingress.admit({
                kind: 'private',
                platform: binding.platform,
                accountId: binding.accountId,
                conversationId: binding.conversationId,
                senderId: binding.senderId,
                messageId: row.platformMessageId,
                text,
                ...images.length > 0 ? { images } : {},
                relayed,
                origin: originOf(binding, relayed, labelOf(binding.platform)),
            })
        } catch (error) {
            if (closing) return 'skipped'
            const code = stableErrorCode(error, 'INGRESS_FAILED')
            if (code === 'INPUT_CONFLICT') {
                await markConflict(key)
                for (const memberKey of row.mergeKeys ?? []) await markConflict(memberKey)
                return 'conflict'
            }
            state.errorCode = code
            return 'failed'
        }
        // await 之后的精确版本复核：锁内重读，冲突/新引用不能被旧 snapshot 抹掉。
        const latest = readIncoming(key)
        if (latest === null) return 'skipped'
        if (latest.state === 'conflict') return 'conflict'
        if (latest.state !== row.state || latest.fingerprint !== row.fingerprint) return 'skipped'
        if (!isRecord(result)) return 'invalid'
        // 回执必须指向本绑定的真实中枢，否则保留原 text 与旧引用。
        if (result.sessionId !== binding.sessionId) return 'invalid'
        if (latest.requestId !== null && result.requestId !== latest.requestId) return 'invalid'
        if (result.status === 'accepted') {
            if (!isNonEmptyString(result.requestId)
                || !isNonEmptyString(result.messageId)
                || !isSeq(result.seq)) {
                return 'invalid'
            }
            // 真实 producer 交付后才写 native 引用；正文置空，原文留在原生会话里。
            const native = { requestId: result.requestId, nativeMessageId: result.messageId, nativeSeq: result.seq }
            const merged = members.length === 1 && row.notice === undefined ? {} : {
                // 准入正文（合并的、或接了未送达说明的）的指纹用于回复归属核对；合并时回复锚定本组最后一条。
                admittedFingerprint: incomingFingerprintOf({
                    platform: latest.platform,
                    accountId: latest.accountId,
                    conversationId: latest.conversationId,
                    senderId: latest.senderId,
                    platformMessageId: latest.platformMessageId,
                    text,
                    imageCount: images.length,
                }),
                ...members.length === 1 ? {} : { replyAnchorKey: members[members.length - 1].anchorKey },
            }
            await putIncoming(key, {
                ...latest,
                state: 'accepted',
                text: null,
                ...latest.images === undefined ? {} : { images: null },
                ...native,
                ...merged,
            })
            for (const memberKey of row.mergeKeys ?? []) {
                const member = readIncoming(memberKey)
                if (member === null || member.state !== 'queued') continue
                await putIncoming(memberKey, {
                    ...member,
                    state: 'accepted',
                    text: null,
                    ...member.images === undefined ? {} : { images: null },
                    ...native,
                })
            }
            // 以前接在正文里的说明：准入了就算说过（旧原件才有 noticeIds）。
            for (const deliveryId of latest.noticeIds ?? []) {
                const stored = readOutgoing(deliveryId)
                if (stored === null) continue
                // 后来的结果写进了这段说明才算说过（说明在准入前就定下了，之后才到的结果留给下一条输入）。
                if (stored.lateNote !== undefined && latest.notice?.includes(stored.lateNote)) {
                    const { lateNote: _told, ...rest } = stored
                    await putOutgoing(deliveryId, { ...rest, reportedAt: stored.reportedAt ?? config.now() })
                } else if (stored.reportedAt === undefined) {
                    await putOutgoing(deliveryId, { ...stored, reportedAt: config.now() })
                }
            }
            return 'accepted'
        }
        if (result.status === 'unknown') {
            if (!isNonEmptyString(result.requestId)) return 'invalid'
            // unknown 保留原件，下一轮 wake 用同一身份再核对，不自动重发。
            await putIncoming(key, {
                ...latest,
                state: 'unknown',
                requestId: result.requestId,
            })
            return 'unknown'
        }
        return 'invalid'
    }

    /**
     * 按到达先后排好的一组新到原件还要等多久才准入（毫秒，≤ 0 表示现在就准入）：最后一条之后安静 `mergeTextMs`
     * （只有图片时 `mergeImageMs`），来一条顺延一次；但从第一条算起不超过 `mergeCapMs`，免得一直有新的来就一直不交。
     * 平台可以声明自己的 `mergeTextMs`、`mergeImageMs`（比如读消息本身就慢的平台要等得久一点），没声明的用这里的。
     */
    function mergeWait(rows) {
        const newest = rows[rows.length - 1]
        const imageOnly = newest.text !== null && newest.text.trim() === '' && (newest.images?.length ?? 0) > 0
        const declared = config.platforms[newest.platform]
        const own = imageOnly ? declared?.mergeImageMs : declared?.mergeTextMs
        const window = Number.isSafeInteger(own) && own >= 0 ? own : imageOnly ? config.mergeImageMs : config.mergeTextMs
        const quiet = window - (config.now() - newest.createdAt)
        if (config.mergeCapMs === null) return quiet
        return Math.min(quiet, config.mergeCapMs - (config.now() - rows[0].createdAt))
    }

    /** 安静期结束后唤醒一次准入。 */
    function scheduleMergeWake(milliseconds) {
        if (closing) return
        clearTimeout(mergeTimer)
        mergeTimer = setTimeout(() => {
            mergeTimer = undefined
            requestWakeSafely()
        }, milliseconds)
        mergeTimer.unref?.()
    }

    /**
     * 把同一绑定连续到达的几条原件定成一组：先持久分组（首条记下其余键，其余指向首条），
     * 再准入。重启后按已保存的分组继续，不会拆开或重组。
     * @returns 首条原件
     */
    async function groupFresh(rows) {
        const [lead, ...rest] = rows
        const leadKey = incomingKeyOf(lead.bindingId, lead.platformMessageId)
        const restKeys = rest.map(row => incomingKeyOf(row.bindingId, row.platformMessageId))
        for (let index = 0; index < rest.length; index += 1) {
            await serialize(restKeys[index], async () => {
                const latest = readIncoming(restKeys[index])
                if (latest !== null && latest.state === 'queued' && latest.mergeKeys === undefined) {
                    await putIncoming(restKeys[index], { ...latest, mergedInto: leadKey })
                }
            })
        }
        return serialize(leadKey, async () => {
            const latest = readIncoming(leadKey)
            if (latest === null || latest.state !== 'queued' || latest.mergedInto !== undefined) return lead
            const grouped = { ...latest, mergeKeys: restKeys }
            await putIncoming(leadKey, grouped)
            return grouped
        })
    }

    /** 会话是否正在一轮里；开始太久仍没有结束的不算。 */
    function sessionBusy(sessionId) {
        const since = busySessions.get(sessionId)
        return since !== undefined && config.now() - since < BUSY_STALE_MS
    }

    /** 在这个会话的忙超时到点时唤醒一次；已有更早的计时就不动。 */
    function scheduleBusyExpiry(sessionId) {
        if (closing) return
        const due = busySessions.get(sessionId) + BUSY_STALE_MS
        if (busyTimer !== undefined && busyTimer.due <= due) return
        clearTimeout(busyTimer?.timer)
        const timer = setTimeout(() => {
            busyTimer = undefined
            requestWakeSafely()
        }, Math.max(due - config.now(), 0))
        timer.unref?.()
        busyTimer = { timer, due }
    }

    /**
     * 宿主报告会话一轮的开始与结束。结束时不在这里唤醒：宿主的 turn/end 本来就会 wake 这个会话，准入那时一并进行。
     * @param {string} sessionId
     * @param {boolean} busy
     */
    function markSessionBusy(sessionId, busy) {
        if (!isNonEmptyString(sessionId)) return
        if (busy === true) busySessions.set(sessionId, config.now())
        else busySessions.delete(sessionId)
    }

    /** queued/unknown 的原件按同一平台消息身份重新核对，绝不生成新身份。 */
    async function admitQueued(state, binding) {
        const pending = readIncomingRows()
            .filter(row => row.bindingId === binding.bindingId)
            .filter(row => row.state === 'queued' || row.state === 'unknown')
            // 已并入某个首条的原件由首条一起准入。
            .filter(row => row.mergedInto === undefined)
            .sort((left, right) => left.createdAt - right.createdAt
                || (left.platformMessageId < right.platformMessageId ? -1 : 1))
        if (pending.length === 0) return
        // 新到、尚未分组的原件等安静一段时间再一起准入；已分组或待核对的照常继续。
        const fresh = pending.filter(row => row.state === 'queued' && row.mergeKeys === undefined)
        let ready = pending.filter(row => !fresh.includes(row))
        // 会话正在一轮里：新到的先留在渠道，这一轮结束（turn/end 唤醒）后与期间陆续到的合成一条再交，
        // 不再一条排一轮。已分组或待核对的照常继续。
        if (fresh.length > 0 && sessionBusy(binding.sessionId)) scheduleBusyExpiry(binding.sessionId)
        if (fresh.length > 0 && !sessionBusy(binding.sessionId)) {
            const wait = mergeWait(fresh)
            if (wait > 0) {
                scheduleMergeWake(wait)
            } else if (fresh.length === 1) {
                ready = [...ready, fresh[0]]
            } else {
                ready = [...ready, await groupFresh(fresh)]
            }
        }
        if (ready.length === 0) return
        let ingress
        try {
            ingress = getIngress(binding)
        } catch {
            state.errorCode = 'INGRESS_UNAVAILABLE'
            return
        }
        for (const row of ready) {
            if (closing) return
            const key = incomingKeyOf(row.bindingId, row.platformMessageId)
            const outcome = await serialize(key, () => admitOne(state, binding, ingress, key))
            if (outcome === 'conflict') {
                state.errorCode = 'INPUT_CONFLICT'
                return
            }
            if (outcome === 'invalid') {
                state.errorCode = 'INGRESS_REFERENCE_INVALID'
                return
            }
            if (outcome === 'failed') return
        }
    }

    /* ---------------------------- native cut ---------------------------- */

    /**
     * 持久屏障：live 只认可 flush===true 且实例未变的 exact Session；prepared 只认非空 revision。
     * 成功时带回这次 cut 绑定的 exact live 实例（prepared 无实例），供最后同步复核。
     */
    async function confirmPersistence(observation) {
        const { source, revision, header } = observation
        if (source === 'prepared') return isNonEmptyString(revision) ? { instance: null } : null
        if (source !== 'live') return null
        const instance = host.sessions.get(header.id)
        if (!isRecord(instance) || instance.header !== header) return null
        let flushed
        try {
            flushed = await host.sessions.flush(instance)
        } catch {
            return null
        }
        if (flushed !== true || host.sessions.get(header.id) !== instance) return null
        return { instance }
    }

    function disposeObservation(observation) {
        try {
            if (isRecord(observation) && typeof observation[Symbol.dispose] === 'function') {
                observation[Symbol.dispose]()
            }
        } catch {
            // 只读租约的释放失败不改变对账结论。
        }
    }

    /**
     * 取一次与当前 surface 完全对应的不可变 cut。
     * @returns {Promise<null|{sessionId: string, source: string, revision: unknown, header: unknown,
     *   cursor: number, instance: unknown, events: unknown[], surfaceEvents: unknown[]}>}
     */
    async function readCut(binding) {
        const sessionId = binding.sessionId
        let observation
        try {
            observation = await host.sessionQuery.observeSession(sessionId, {
                projectionMode: 'none',
                signal: lifecycle.signal,
            })
        } catch {
            return null
        }
        try {
            if (!isRecord(observation)) return null
            if (typeof observation[Symbol.dispose] !== 'function') {
                return null
            }
            if (!isRecord(observation.header) || observation.header.id !== sessionId) {
                return null
            }
            if (!Array.isArray(observation.events)) return null
            const cursor = observation.cursor
            if (!Number.isSafeInteger(cursor) || cursor < 0) {
                return null
            }
            let surface
            try {
                surface = await host.sessionQuery.readSurface(sessionId)
            } catch {
                return null
            }
            if (!isRecord(surface)) return null
            if (!isRecord(surface.session) || surface.session.id !== sessionId) {
                return null
            }
            if (!Array.isArray(surface.events)) return null
            // surface 必须恰好停在同一 cut，否则不生成也不发送。
            if (surface.capturedThroughSeq !== cursor) {
                return null
            }
            const persistence = await confirmPersistence(observation)
            if (persistence === null) return null
            // 一并带回 exact 实例/header/cursor/revision：发送最后一步要在 await 之后同步复核它们。
            return {
                sessionId,
                source: observation.source,
                revision: observation.revision,
                header: observation.header,
                cursor,
                instance: persistence.instance,
                events: observation.events,
                surfaceEvents: surface.events,
            }
        } finally {
            disposeObservation(observation)
        }
    }

    /* ---------------------------- 发送 ---------------------------- */

    function enqueuePeer(key, task) {
        const previous = peerChains.get(key) ?? Promise.resolve()
        const started = previous.then(task, task)
        const tail = started.then(() => undefined, () => undefined)
        peerChains.set(key, tail)
        tail.then(() => {
            if (peerChains.get(key) === tail) peerChains.delete(key)
        })
        return started
    }

    function classifySendError(error) {
        const code = stableErrorCode(error, 'SEND_UNKNOWN')
        if (isRecord(error) && error.notSent === true) return { state: 'failed', code }
        if (isRecord(error) && error.definitelyRejected === true) return { state: 'failed', code }
        // 已调用发送后的网络错误只能记 unknown，永不自动重发。
        return { state: 'unknown', code }
    }

    /** exact 当前 ready listener 且与 binding 匹配——connected 的唯一来源。群绑定看它挂着的私聊绑定的连接。 */
    function hasReadyListener(state, binding) {
        const listener = state.listener
        const bindingId = isGroupBinding(binding) ? binding.ownerBindingId : binding.bindingId
        if (listener === null) return false
        if (listener.ready !== true) return false
        if (listener.bindingId !== bindingId) return false
        if (listener.controller.signal.aborted) return false
        return state.activeBindingId === bindingId
    }

    /** 连接就绪且平台没有报告断开（经手机转发的平台：连接对象还在，手机那头可能暂时断开）。 */
    function bindingLive(binding) {
        const state = stateOf(binding.platform)
        return hasReadyListener(state, binding) && state.listener.live !== false
    }

    /**
     * 发送授权同步核验：closing、当前 enabled 的精确 binding/session、exact ready listener。
     * 唯一例外：解绑确认在这一行停用之后发，只放行渠道自己的群说明（`system: 'group'`）。
     */
    function isSendAuthorized(state, binding, prepared) {
        if (closing) return false
        const current = readBindingAt(bindingKeyOf(binding))
        if (current === null) return false
        if (current.bindingId !== binding.bindingId) return false
        const unboundNotice = prepared?.system === 'group' && current.enabled === false
            && current.unboundAt !== undefined && groupOwnerOf(current) !== null
        if (!unboundNotice && !bindingActive(current)) return false
        if (current.sessionId !== binding.sessionId) return false
        return hasReadyListener(state, binding)
    }

    /** 未调用平台发送的确定事实：记 failed（notSent），不伪报 unknown。 */
    async function markNotSent(deliveryId, prepared, code) {
        await putOutgoing(deliveryId, {
            ...prepared,
            state: 'failed',
            receipt: null,
            errorCode: code,
        })
        return 'failed'
    }

    /**
     * 发一片：进 peer 队列后重核凭据、锚点、授权与来源，再调平台。
     * @param mayYield - 调用方能改道（`sendPiece`）：轮到这一片、本来要调平台时，这个绑定在暂停中、又有别的渠道能接，就不试它，
     *   记 failed `SEND_PAUSED` 返回 `paused`，由调用方改道。在队列里现算：排队期间前面的片可能刚把它停掉。
     * @returns `sent`；`rejected` 是调了平台、平台确定没发出（只对它改道、计数）；`failed` 是渠道自己在发之前拦下的
     *   （markNotSent）；`unknown` 是可能已经发出；`paused` 见上。
     */
    async function sendPrepared(state, binding, batch, deliveryId, prepared, { mayYield = false } = {}) {
        const platform = config.platforms[binding.platform]
        const yields = () => mayYield && pausedNow(binding) && pickCarrier(binding, prepared.kind ?? 'text') !== null
        if (platform === undefined) return markNotSent(deliveryId, prepared, 'PLATFORM_UNAVAILABLE')
        const peerKey = `${binding.platform}\u0000${binding.conversationId}`
        return enqueuePeer(peerKey, async () => {
            // 进入 peer 队列后重新取凭据与锚点（不缓存旧授权）。
            const credential = await readAccountCredential(binding)
            if (credential === null) return markNotSent(deliveryId, prepared, 'CREDENTIAL_MISSING')
            if (closing) return markNotSent(deliveryId, prepared, 'RUNTIME_CLOSED')
            const anchor = await readAnchor(binding, prepared.anchorKey)
            if (anchor === null) return markNotSent(deliveryId, prepared, 'ANCHOR_MISSING')
            if (!anchorSendable(binding, anchor)) return markNotSent(deliveryId, prepared, 'ANCHOR_INCOMPLETE')
            const last = peerLastSendAt.get(peerKey)
            const elapsed = last === undefined ? Infinity : config.now() - last
            // 适配器要求的发送节奏（`paceMs`，例如像人打字一样隔一会儿再发下一片）：第一片不扣已过去的时间，只保证不短于常规间隔；
            // 没有节奏的平台只保证常规间隔。等待必须在下面的最后核对之前：等完再核，等待期间撤下的回复不会发出，
            // 进程在等待中退出时这一片也还没记成“发送中”，重启后照常发。
            const paced = typeof platform.paceMs === 'function' ? platform.paceMs(prepared, config.random) : undefined
            const pace = Number.isFinite(paced) && paced > 0 ? paced : null
            const wait = pace === null
                ? SEND_GAP_MS - elapsed
                : prepared.partIndex === 0
                    ? Math.max(pace, SEND_GAP_MS - elapsed)
                    : pace - (last === undefined ? 0 : elapsed)
            // 暂停中、要让给别的渠道的片不用等打字节奏：它不会经这个渠道发。
            if (wait > 0 && !yields()) await delayWithSignal(wait, lifecycle.signal)
            if (closing) return markNotSent(deliveryId, prepared, 'RUNTIME_CLOSED')
            if (!isSendAuthorized(state, binding, prepared)) return markNotSent(deliveryId, prepared, 'BINDING_STALE')
            // 发送前持久 sending 意图；崩溃恢复会把它转 unknown。
            await putOutgoing(deliveryId, { ...prepared, state: 'sending' })
            // 一轮之外的片（batch 为 null：留待下次的片已在原批核对过，立即发出的片来自本会话的工具调用）
            // 不再对照回复批。
            if (batch !== null) {
                // 最终 source cut：首片取到的结果不能带到最后窗口，每片都在这里重核。
                const cut = await readCut(binding)
                if (cut === null || !cutStillMatches(binding, cut, batch)) {
                    return markNotSent(deliveryId, prepared, 'SOURCE_CHANGED')
                }
                // 最终 owner 观察同时核对 prepared 冷 cut 的 revision/cursor：冷源在 owner 窗口被改写
                // 也不会发出；live cut 的精确尾序由下面同步复核。
                const final = await verifyOwnerForSend(binding, cut)
                if (final === 'source-changed') return markNotSent(deliveryId, prepared, 'SOURCE_CHANGED')
                if (final !== 'ok') return markNotSent(deliveryId, prepared, 'OWNER_UNVERIFIED')
                // 这里起没有新的 await 改变源边界：只同步复查 source 尾序、closing、enabled exact
                // binding/session、exact ready listener，随后直接用 prepared 的 payload 调用平台。
                if (!liveSourceExact(cut)) return markNotSent(deliveryId, prepared, 'SOURCE_CHANGED')
            }
            if (closing) return markNotSent(deliveryId, prepared, 'RUNTIME_CLOSED')
            if (!isSendAuthorized(state, binding, prepared)) return markNotSent(deliveryId, prepared, 'BINDING_STALE')
            // 来源、归属都核过了，这一片本可以发：这个绑定还在暂停里就不试它，交给调用方改道。到点了（排队期间过了暂停）照常试。
            if (yields()) {
                await markNotSent(deliveryId, prepared, 'SEND_PAUSED')
                return 'paused'
            }
            const controller = new AbortController()
            // 图片片：读出并核对本机图片；读不出来时改发一行说明，不让内容静默消失。
            let payload = { text: prepared.text }
            if (prepared.kind === 'image') {
                try {
                    const image = await readOutboundImage(prepared.text)
                    payload = { text: prepared.text, image: { path: prepared.text, ...image } }
                } catch (error) {
                    payload = { text: `[图片无法发送（${stableErrorCode(error, 'IMAGE_UNREADABLE')}）：${prepared.text}]` }
                }
            } else if (prepared.kind === 'file') {
                try {
                    const file = await readOutboundFile(prepared.text)
                    payload = { text: prepared.text, file: { path: prepared.text, ...file } }
                } catch (error) {
                    payload = { text: `[文件无法发送（${stableErrorCode(error, 'FILE_UNREADABLE')}）：${prepared.text}]` }
                }
            } else if (prepared.kind === 'voice') {
                // 语音片：能力里有语音的平台发语音消息（官方机器人由适配器转 SILK）；没有的（微信等）按音频文件发。
                try {
                    const voice = await readOutboundVoice(prepared.text)
                    payload = canSendKind(binding, 'voice')
                        ? { text: prepared.text, voice: { path: prepared.text, ...voice } }
                        : { text: prepared.text, file: { path: prepared.text, ...voice } }
                } catch (error) {
                    payload = { text: `[语音无法发送（${stableErrorCode(error, 'VOICE_UNREADABLE')}）：${prepared.text}]` }
                }
            }
            let result
            try {
                result = await platform.send({
                    credential,
                    peerId: binding.conversationId,
                    anchor,
                    ...payload,
                    deliveryId,
                    signal: controller.signal,
                    // 记成结果不明以后平台才回的确定结果（例如手机转发晚回的），改记这一片。
                    onLateResult: late => { settleLateSend(deliveryId, late).catch(() => {}) },
                })
            } catch (error) {
                const outcome = classifySendError(error)
                await putOutgoing(deliveryId, {
                    ...prepared,
                    state: outcome.state,
                    receipt: null,
                    errorCode: outcome.code,
                })
                if (outcome.state !== 'failed') return outcome.state
                // 调了平台、平台确定没发出：和渠道自己拦下的分开（只对这种改道，也只数这种）。
                if (config.platforms[binding.platform]?.rejectEndsReplies === true && outcome.code === 'SEND_REJECTED') {
                    // 拒的是这条消息，不是这个账号：不算进暂停，对方再说一句就能接着发。说一次，带上平台的原话。
                    const sent = usedReplies(prepared.anchorKey)
                    reportSafely(CHANNEL_REPORTS.repliesEnded, {
                        ...isNonEmptyString(binding.sessionId) ? { sessionId: binding.sessionId } : {},
                        text: `${bindingWord(binding)}拒收了（${error?.message ?? outcome.code}）：这条消息已送达 ${sent} 片${sent === 0 ? '，一片都没发出去，可能不是次数的问题' : ''}`,
                        data: { subject: prepared.anchorKey, delivered: sent },
                    })
                } else noteSendResult(binding, false, error?.message)
                return 'rejected'
            } finally {
                peerLastSendAt.set(peerKey, config.now())
            }
            if (!isRecord(result) || result.kind !== 'platform-accepted') {
                await putOutgoing(deliveryId, {
                    ...prepared,
                    state: 'unknown',
                    receipt: null,
                    errorCode: 'SEND_RESULT_INVALID',
                })
                return 'unknown'
            }
            if (!isReceiptField(result.platformMessageId) || !isReceiptField(result.clientId)) {
                await putOutgoing(deliveryId, {
                    ...prepared,
                    state: 'unknown',
                    receipt: null,
                    errorCode: 'SEND_RECEIPT_INVALID',
                })
                return 'unknown'
            }
            const receipt = {
                kind: 'platform-accepted',
                platformMessageId: isNonEmptyString(result.platformMessageId) ? result.platformMessageId : null,
                clientId: isNonEmptyString(result.clientId) ? result.clientId : null,
                ...isNonEmptyString(result.refIdx) ? { refIdx: result.refIdx } : {},
            }
            // 晚返回的真实回执尽力保存；状态 sent 只代表平台已接受。
            await putOutgoing(deliveryId, { ...prepared, state: 'sent', receipt, errorCode: null })
            noteSendResult(binding, true)
            if (prepared.kind === undefined && prepared.system === undefined) noteEnglishAsides(binding, deliveryId, prepared)
            return 'sent'
        })
    }

    /* ------------------- 平台确定没发出：改道与暂停 ------------------- */

    /**
     * 发一片会话写的话（一轮的回复、中枢没有渠道输入的轮、中途发送、留待片）。平台确定没发出时，在同一范围（`scopeOf`：私聊在本人的
     * 几个私聊渠道之间换，群只有它自己）里另找现在能发、又能发这种内容的渠道改道发出；这个绑定暂停中、又有渠道能接时，核对完来源就
     * 直接改道，不试它。渠道自己在发之前拦下的（来源变了、绑定失效、锚点没了……）意思是这片不该发或现在不能发，结果不明的可能已经
     * 发出，都不改道。
     * @returns 这一片送没送到：`sent`（直接发出或改道发出）；没送到时是 sendPrepared 或改道那一条的结果。
     */
    async function sendPiece(state, binding, batch, deliveryId, prepared) {
        const outcome = await sendPrepared(state, binding, batch, deliveryId, prepared, { mayYield: true })
        if (outcome !== 'rejected' && outcome !== 'paused') return outcome
        return await rerouteRejected(binding, deliveryId) ?? await holdRejected(binding, deliveryId) ?? 'failed'
    }

    /**
     * 平台拒收了这条消息的回复（`rejectEndsReplies`），又没有别的渠道能接：这一片留到对方下一条消息之后，告诉会话一句。
     * 原来那一片记 `reroutedTo` 指向留待片：它发出就算这一片送到了，还没发时不算未送达。
     * @returns `held`；这一片不该留时为 null。
     */
    async function holdRejected(binding, deliveryId) {
        const row = readOutgoing(deliveryId)
        const declared = config.platforms[binding.platform]
        if (row === null || declared?.rejectEndsReplies !== true || declared.holdsUntilNextMessage !== true) return null
        // 本来就是留待片，补发时又被拒：回去接着等下一条消息（错误码留着，这条消息算回不了了；发出时清掉）。
        if (row.deferred === true && row.state === 'failed' && row.errorCode === 'SEND_REJECTED') {
            await putOutgoing(deliveryId, { ...row, state: 'prepared' })
            return 'held'
        }
        if (row.state !== 'failed' || row.errorCode !== 'SEND_REJECTED' || row.reroutedTo !== undefined || row.detour === true || row.system !== undefined) return null
        const heldId = await holdPart(binding, row, row.partIndex, { kind: row.kind, text: row.text }, `${row.push === true ? '中途发送' : `第 ${row.turn} 轮回复`}：${labelOf(binding.platform)}这条消息回不了了，留到用户下一条消息之后接着发，不用重发`)
        await putOutgoing(deliveryId, { ...row, reroutedTo: heldId })
        return 'held'
    }

    /** 记一片留到对方下一条消息之后的片；按原来的投递和位置编号，记过就不再记。 */
    async function holdPart(binding, origin, position, part, routeNote) {
        const heldId = deliveryIdOf(origin, HELD_PART_BASE + position)
        if (readOutgoing(heldId) !== null) return heldId
        const at = config.now()
        await putOutgoing(heldId, {
            bindingId: binding.bindingId,
            sessionId: origin.sessionId,
            turn: 0,
            endSeq: at,
            sourceSeqs: origin.sourceSeqs,
            inputRequestIds: origin.inputRequestIds,
            anchorKey: origin.anchorKey,
            partIndex: HELD_PART_BASE + position,
            partCount: 1,
            ...part.kind === undefined ? {} : { kind: part.kind },
            ...routeNote === undefined ? {} : { routeNote },
            ...origin.push === true ? { push: true } : {},
            ...origin.by === undefined ? {} : { by: origin.by },
            text: part.text,
            state: 'prepared',
            receipt: null,
            errorCode: null,
            detour: true,
            deferred: true,
            deferredAt: at,
        })
        return heldId
    }

    /**
     * 把平台确定没发出（或暂停中让出来）的一片改经同一范围里别的渠道发出：先记改道那一条（锚定对方在那里最近的一条消息），再在原来
     * 那一片上记 `reroutedTo`（state 仍是 failed），然后发。为什么换了渠道同一批只说一次：文字写在改道那条开头；图片、文件、语音
     * 的正文是本机路径，在它前面经同一渠道另发一片说明（`system: 'reroute'`，编号按原来那一片定，记过就不再插）。每片只改一次：原来那片记过就不再改，改道记录自己
     * （连同按能力改道的片）没发出也不再改。改道发出后给会话留一句（`routeNote`，经 syncNotices 告诉一次）；中途发送在发送结果里说。
     * 渠道自己的固定说明不经这里（见 sendSystem）。
     * @returns 改道那一条的结果；这一片不该改道、或没有能接的渠道时为 null。
     */
    async function rerouteRejected(binding, deliveryId) {
        if (closing) return null
        const row = readOutgoing(deliveryId)
        if (row === null || row.state !== 'failed' || row.reroutedTo !== undefined || row.detour === true || row.system !== undefined) return null
        // 同一批里已经有改了道的片：为什么换了渠道已经说过（文字开头或插的那片），不再说。
        const noted = readDeliveries(row.bindingId, row.turn, row.endSeq)
            .some(item => item.deliveryId !== deliveryId && item.record.reroutedTo !== undefined)
        // 图片、文件、语音前面要插说明时，承载的渠道得能连发两次（官方 QQ 借的锚点只剩一次时，说明会占掉那一片的额度）。
        // 没有这样的渠道就退回能发一次的、不插说明：内容比说明要紧，不为一句说明让它送不到。
        const kind = row.kind ?? 'text'
        const roomy = row.kind !== undefined && !noted ? pickCarrier(binding, kind, 2) : null
        const carrier = roomy ?? pickCarrier(binding, kind)
        if (carrier === null) return null
        const via = carrier.binding.platform
        const rerouteId = deliveryIdOf(row, REROUTE_PART_BASE + row.partIndex)
        const base = {
            bindingId: carrier.binding.bindingId,
            sessionId: row.sessionId,
            turn: 0,
            endSeq: config.now(),
            sourceSeqs: [carrier.latest.nativeSeq],
            inputRequestIds: [carrier.latest.requestId],
            anchorKey: carrier.anchorKey,
            partCount: 1,
            state: 'prepared',
            receipt: null,
            errorCode: null,
            detour: true,
        }
        const detour = {
            ...base,
            partIndex: REROUTE_PART_BASE + row.partIndex,
            ...row.kind === undefined ? {} : { kind: row.kind },
            text: row.kind === undefined && !noted ? `${rejectedNoteOf(channelWord(binding.platform), channelWord(via))}\n${row.text}` : row.text,
        }
        const noteId = roomy !== null ? deliveryIdOf(row, REROUTE_NOTE_PART_BASE + row.partIndex) : null
        const note = noteId === null || readOutgoing(noteId) !== null ? null : {
            ...base,
            partIndex: REROUTE_NOTE_PART_BASE + row.partIndex,
            text: rejectedMediaNoteOf(channelWord(binding.platform), channelWord(via), row.kind),
            system: 'reroute',
        }
        reroutesInFlight.add(deliveryId)
        try {
            if (note !== null) await putOutgoing(noteId, note)
            await putOutgoing(rerouteId, detour)
            await putOutgoing(deliveryId, { ...row, reroutedTo: rerouteId })
            // 说明没发出也照发那一片：内容比说明要紧。
            if (note !== null) await sendPrepared(stateOf(via), carrier.binding, null, noteId, note)
            const outcome = await sendPrepared(stateOf(via), carrier.binding, null, rerouteId, detour)
            if (outcome === 'sent' && row.push !== true) {
                const sent = readOutgoing(rerouteId)
                if (sent !== null) await putOutgoing(rerouteId, { ...sent, routeNote: reroutedNoteOf(row, binding.platform, via) })
            }
            return outcome
        } finally {
            reroutesInFlight.delete(deliveryId)
        }
    }

    /** 改道发出后告诉会话的一句：哪一轮的哪一片、从哪里换到了哪里，不用重发。 */
    function reroutedNoteOf(row, from, via) {
        const what = row.push === true ? '中途发送' : `第 ${row.turn} 轮回复`
        const excerpt = row.kind === undefined ? `「${Array.from(row.text.trim()).slice(0, 24).join('')}…」` : `的${KIND_WORDS[row.kind] ?? '文件'}`
        return `${what}${excerpt}：${labelOf(from)}确定没发出去，已经改从${labelOf(via)}发出，不用重发`
    }

    /** 这一片送到了没有：发出了，或平台确定没发出后改道发出了。 */
    function deliveredRow(row) {
        if (row.state === 'sent') return true
        return row.reroutedTo !== undefined && readOutgoing(row.reroutedTo)?.state === 'sent'
    }

    /** 这个绑定此刻在不在暂停里。到点以后、还没试出结果之前不算：下一片照常先试它。 */
    function pausedNow(binding) {
        const entry = sendPauses.get(binding.bindingId)
        return entry !== undefined && entry.until !== null && config.now() < entry.until
    }

    /**
     * 记一片调了平台以后的确定结果（按绑定，不按平台名）：发出了就清零，暂停着的就此恢复；平台确定没发出就数一次，连着
     * `pauseRejects` 片没发出、或到点后试的那一片又没发出，就暂停 `pauseMs`。结果不明的不数：可能已经发出。不设时间窗口，不倍增。
     */
    function noteSendResult(binding, sent, detail) {
        if (config.pauseRejects === 0) return
        const entry = sendPauses.get(binding.bindingId)
        if (sent) {
            if (entry === undefined) return
            sendPauses.delete(binding.bindingId)
            if (entry.until !== null) reportResumed(entry.binding, config.now() >= entry.until ? '到点后试发的一片发出去了' : '一片发出去了')
            return
        }
        const now = config.now()
        const next = entry ?? { binding, misses: 0, until: null }
        next.misses += 1
        sendPauses.set(binding.bindingId, next)
        if (next.until !== null && now < next.until) {
            // 暂停中没有别的渠道能接、照旧经它发，又没发出：从现在起再停一段，不另报。
            next.until = now + config.pauseMs
            return
        }
        if (next.until === null && next.misses < config.pauseRejects) return
        const said = typeof detail === 'string' && detail !== '' ? `（${detail}）` : ''
        const why = next.until === null ? `连着 ${next.misses} 片被平台确定没发出${said}` : '到点后试发的一片又被平台确定没发出'
        next.until = now + config.pauseMs
        reportSafely(CHANNEL_REPORTS.accountPaused, {
            ...isNonEmptyString(binding.sessionId) ? { sessionId: binding.sessionId } : {},
            text: `${bindingWord(binding)}暂停发送 ${Math.round(config.pauseMs / 60_000)} 分钟：${why}；这段时间改走同一范围里别的渠道，到点后先试一片`,
            data: { subject: binding.bindingId },
        })
    }

    /** 这个平台重新连上（连接重建，或另一头重连、重启）：之前的计数与暂停都清掉，暂停着的报恢复。 */
    function clearPauses(platform, why) {
        for (const [bindingId, entry] of sendPauses) {
            if (entry.binding.platform !== platform) continue
            sendPauses.delete(bindingId)
            if (entry.until !== null) reportResumed(entry.binding, why)
        }
    }

    function reportResumed(binding, why) {
        reportSafely(CHANNEL_REPORTS.accountResumed, {
            ...isNonEmptyString(binding.sessionId) ? { sessionId: binding.sessionId } : {},
            text: `${bindingWord(binding)}恢复发送：${why}`,
            data: { subject: binding.bindingId },
        })
        // 同一 subject 的暂停那条报“好了”，让收报告的一方（Watchdog）关掉它。
        reportSafely(CHANNEL_REPORTS.accountPaused, { text: `${bindingWord(binding)}不再暂停`, data: { subject: binding.bindingId, resolved: true } })
    }

    /** 报告里说的是哪个绑定：渠道名加私聊或哪个群。 */
    function bindingWord(binding) {
        const label = labelOf(binding.platform)
        return isGroupBinding(binding) ? `${label}群「${binding.groupName ?? binding.conversationId.slice(GROUP_PREFIX.length)}」` : `${label}私聊`
    }

    /**
     * 出口检查（只记录、不删不改）：实际发出去的模型文字（回复与中途发送，不含渠道自己的固定说明）里一两行、完全不含中文的
     * 句子，可能是模型写的英文过程旁白：把会话、时间、原文各报一条（`channels/english-aside`），观察模型还会不会这样写。
     */
    function noteEnglishAsides(binding, deliveryId, row) {
        if (config.report === null) return
        const asides = englishAsides(row.text)
        if (asides.length === 0) return
        const where = isGroupBinding(binding)
            ? `群「${binding.groupName ?? binding.conversationId.slice(GROUP_PREFIX.length)}」接的会话`
            : hubSessions().has(row.sessionId) ? '中枢' : '会话'
        const what = row.push === true ? '中途发送' : row.mainTurn === true ? `第 ${row.turn} 轮回复（没有渠道输入的一轮）` : `第 ${row.turn} 轮回复`
        const at = new Date(config.now()).toLocaleString('zh-CN', { hour12: false, timeZone: host.core.timezone })
        for (const [index, line] of asides.entries()) {
            reportSafely(CHANNEL_REPORTS.englishAside, {
                sessionId: row.sessionId,
                text: `发出去的回复里有英文旁白 · ${where}：${at} 经${labelOf(binding.platform)}发出的${what}：${line}`,
                data: { subject: `${deliveryId}-${index}` },
            })
        }
    }

    /**
     * 平台在这一片记成结果不明以后才回的确定结果（`{status: 'sent', platformMessageId}` 或 `{status: 'failed', code}`）。
     * 只改还是结果不明的片。还没告诉会话的：发出了就不再算未送达（不进未送达说明、不进 Watchdog），没发出的改成确定没发出、
     * 照未送达说。已经告诉会话“可能已经送到”的（记过 reportedAt，或 以前已写进一条待准入输入的说明）：照样改记，
     * 另记一句后来的结果（`lateNote`），附给会话说一次。附给会话的提示还没交到的不算说过：直接按新结果改写那条提示。
     * 改道那一条：会话听到的是原来那一片的结果，原来那片告诉过会话“可能已经送到”，这条就按告诉过处理，补的那句照原来那片说。
     * 晚回的结果也计入连续没发出：发出算一次发出，确定没发出算一次平台确定没发出。
     */
    async function settleLateSend(deliveryId, late) {
        if (!isRecord(late) || (late.status !== 'sent' && late.status !== 'failed')) return
        const row = readOutgoing(deliveryId)
        if (row === null || row.state !== 'unknown') return
        const sent = late.status === 'sent'
        const binding = readBindingById(row.bindingId)
        if (binding !== undefined) noteSendResult(binding, sent)
        const origin = rerouteOrigin(deliveryId)
        const told = row.reportedAt !== undefined || origin?.reportedAt !== undefined
            || readIncomingRows().some(input => input.noticeIds?.includes(deliveryId))
        const settled = sent
            ? {
                state: 'sent',
                receipt: { kind: 'platform-accepted', platformMessageId: isNonEmptyString(late.platformMessageId) ? late.platformMessageId : null, clientId: null },
                errorCode: null,
            }
            : { state: 'failed', errorCode: isNonEmptyString(late.code) ? late.code : 'SEND_FAILED_LATE' }
        if (told) {
            // 已经说过“结果不明”：不再按未送达重说（记下已告诉），只补一句后来的结果。
            await putOutgoing(deliveryId, { ...row, ...settled, reportedAt: row.reportedAt ?? config.now(), lateNote: lateNoteOf(origin ?? row, sent) })
            return
        }
        if (sent) {
            const { failedAt: _failedAt, ...rest } = row
            await putOutgoing(deliveryId, { ...rest, ...settled })
            return
        }
        await putOutgoing(deliveryId, { ...row, ...settled })
    }

    /** 改道那一条对应的原来那一片（`reroutedTo` 指向它）；不是改道记录时为 null。 */
    function rerouteOrigin(deliveryId) {
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (parsed.success && parsed.data.reroutedTo === deliveryId) return parsed.data
        }
        return null
    }

    /** 后来的确定结果怎么说：哪一轮、哪个渠道、开头几个字。 */
    function lateNoteOf(row, sent) {
        const where = labelOf(bindingPlatforms().get(row.bindingId))
        const what = row.push === true ? '中途发送' : row.detour === true ? '改经这个渠道发的片' : `第 ${row.turn} 轮回复`
        const excerpt = row.kind === undefined ? `「${Array.from(row.text.trim()).slice(0, 24).join('')}…」` : '图片或文件'
        return sent
            ? `${what}（${where}）：${excerpt}之前说结果不明，后来确认已经送到对方手机，不用重发。`
            : `${what}（${where}）：${excerpt}之前说结果不明，后来确认没有送到，需要的话重新发。`
    }

    /** 回执字段只接受缺失、null 或非空字符串；其它类型视为不可信回执。 */
    function isReceiptField(value) {
        return value === undefined || value === null || isNonEmptyString(value)
    }

    /**
     * 用现有原生 cut 重核该批：同 turn/endSeq 完成边界、同一批真实输入、同一 sourceSeqs
     * 与当前 surface 文本都仍成立。整批结果不能无限复用。
     */
    function cutStillMatches(binding, cut, batch) {
        if (batch.mainTurn === true) {
            // 攒着的时候就定下了、之后落了边界的一轮：当前记录里已经没有它，发的是存下的那份。
            if (readMainTurn(mainTurnKey(binding.sessionId, batch.turn, batch.endSeq))?.detached === true) return true
            // 中枢没有渠道输入的一轮：同一轮仍在、仍没有渠道输入，文字与交付文件不变。
            const turn = extractSessionTurns(cut.events, cut.surfaceEvents, readIncomingRows())
                .find(item => item.turn === batch.turn && item.endSeq === batch.endSeq)
            return turn !== undefined && turn.text === batch.turnText
                && sameNumberList(turn.sourceSeqs, batch.sourceSeqs) && sameStringList(turn.files, batch.files)
        }
        const rows = readIncomingRows().filter(row => row.bindingId === binding.bindingId)
        const fresh = extractReplyBatches(cut.events, cut.surfaceEvents, rows, { original: host.core.provenance.original })
        const match = fresh.find(item => item.bindingId === binding.bindingId
            && item.turn === batch.turn
            && item.endSeq === batch.endSeq)
        if (match === undefined) return false
        // 升级前开始投递、按旧规则（整轮全部文字）续发的一批，对照同一轮的旧规则文字。
        const same = source => source !== undefined && source.text === batch.text && sameNumberList(source.sourceSeqs, batch.sourceSeqs)
        if (!same(match) && !same(match.legacy)) return false
        if (!sameStringList(match.files ?? [], batch.files ?? [])) return false
        if (!sameStringList(match.inputRequestIds, batch.inputRequestIds)) return false
        return match.anchorKey === batch.anchorKey
    }

    /**
     * live cut 的同步尾序复核：仍是同一 Session 实例与 header，且公开 Session.seq
     * （下一条 event 序号）恰为 cursor+1：cut 之后被追加/撤下都能在 await 之后同步发现。
     */
    function liveSourceExact(cut) {
        if (cut.source !== 'live') return host.sessions.get(cut.sessionId) === undefined
        const instance = host.sessions.get(cut.sessionId)
        if (!isRecord(instance) || instance !== cut.instance) return false
        if (instance.header !== cut.header) return false
        return instance.seq === cut.cursor + 1
    }

    /**
     * 发送前最后一次 owner 观察，同时是该刻源边界的最后核对：
     * - 观察租约 header.id 就是 binding.sessionId，且不是子 agent 会话（普通 fork 的 parentSession 合法）；
     * - prepared 冷 cut 的同一次观察还必须回到同一 opaque revision/cursor，且期间没有新挂 live
     *   实例：冷源窗口里源被改写就不能发。
     * live cut 的精确实例尾序由随后同步的 liveSourceExact 复核；这里之后不再有改变源边界的 await。
     * @returns {Promise<'ok'|'owner-unverified'|'source-changed'>}
     */
    async function verifyOwnerForSend(binding, cut) {
        const sessionId = binding.sessionId
        let observation
        try {
            observation = await host.sessionQuery.observeSession(sessionId, {
                projectionMode: 'none',
                signal: lifecycle.signal,
            })
        } catch {
            return 'owner-unverified'
        }
        try {
            if (!isRecord(observation) || !isRecord(observation.header)) return 'owner-unverified'
            if (typeof observation[Symbol.dispose] !== 'function') return 'owner-unverified'
            if (observation.header.id !== sessionId) return 'owner-unverified'
            if (observation.header.origin === 'subagent') return 'owner-unverified'
            if (cut.source !== 'prepared') return 'ok'
            // 冷源：这一次观察就是源边界的最后核对，之后只剩同步复核。
            if (observation.source !== 'prepared') return 'source-changed'
            if (!isNonEmptyString(observation.revision) || observation.revision !== cut.revision) {
                return 'source-changed'
            }
            if (observation.cursor !== cut.cursor) return 'source-changed'
            if (host.sessions.get(sessionId) !== undefined) return 'source-changed'
            return 'ok'
        } finally {
            disposeObservation(observation)
        }
    }

    /**
     * 一批回复的发送片：按发图规则拆成文字段与本机图片，文字段再按长度切块。
     * QQ 每条消息能回的次数有限：全部文字合成一段放在最前，随后每张图、每个文件各一片，片数因此
     * 是“文字（每 1000 字一片）+ 图数 + 文件数”。微信按原文顺序穿插。
     * 不含本机图片引用的回复与以前切出的片完全相同，已建立的投递身份不变。
     */
    function replyParts(platform, text, files = []) {
        // 本机文件链接只留文字；网址照原文（平台要改写法的由适配器在发送时改，例如 QQ 去掉可点的网址）。
        const plain = plainFileLinks
        const segments = splitReplySegments(text)
        const texts = segments.filter(segment => segment.kind !== 'image')
        const ordered = platform === 'qq' && texts.length > 1
            ? [{ kind: 'text', text: texts.map(segment => segment.text.trim()).join('\n\n') }, ...segments.filter(segment => segment.kind === 'image')]
            : platform === 'qq' ? [...texts, ...segments.filter(segment => segment.kind === 'image')] : segments
        const parts = []
        for (const segment of ordered) {
            if (segment.kind === 'image') parts.push({ kind: 'image', text: segment.path })
            else for (const chunk of splitReplyText(plain(segment.text), REPLY_CHUNK_LIMIT)) parts.push({ text: chunk })
        }
        for (const path of files) parts.push({ kind: 'file', text: path })
        return parts
    }

    /** 相邻的几张图拼成一张（或放不下时几张）大图；QQ 上文字在前，所以一条回复的图都相邻。 */
    async function stitchImages(parts) {
        if (config.compositeDir === null) return parts
        const result = []
        for (let index = 0; index < parts.length;) {
            if (parts[index].kind !== 'image') {
                result.push(parts[index])
                index += 1
                continue
            }
            let end = index
            while (end < parts.length && parts[end].kind === 'image') end += 1
            const paths = parts.slice(index, end).map(part => part.text)
            const sent = await composeImages(paths, config.compositeDir, { maxBytes: MAX_OUTBOUND_IMAGE_BYTES, now: config.now() })
            for (const path of sent) result.push({ kind: 'image', text: path })
            index = end
        }
        return result
    }

    /**
     * 该锚点已用掉的 QQ 被动回复次数：不计等待标记、失败的片和还没发出的留待片；
     * `skip` 是某一批自己的 turn/endSeq，算这一批还能发几片时不计它自己。
     */
    function usedReplies(anchorKey, skip) {
        let count = 0
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            const row = parsed.data
            if (row.anchorKey !== anchorKey || row.kind === 'wait' || row.state === 'failed') continue
            if (row.deferred === true && row.state === 'prepared') continue
            if (skip !== undefined && row.turn === skip.turn && row.endSeq === skip.endSeq) continue
            count += 1
        }
        return count
    }

    /** 对方最近一条真实消息（不含等待提醒与系统转交）。 */
    function latestRealInput(binding) {
        return readIncomingRows()
            .filter(row => row.bindingId === binding.bindingId && row.state === 'accepted'
                && platformOriginal(row))
            .sort((left, right) => right.createdAt - left.createdAt)[0]
    }

    /**
     * 有的平台（声明 `replyLimit`）一条消息只能回有限几次：超出这一批还能用的次数时，发出前几片，并告诉对方还有多少、
     * 什么时候接着发，其余留到对方下一条消息之后。说明接在发出的最后一段文字后面，没有文字片时才单占一片。
     * 一片也发不了时整批留待。完整回复保留在 DSH 会话里。
     */
    function fitReply(platform, parts, available) {
        if (parts.length <= available) return { parts, deferred: [] }
        if (available <= 0) return { parts: [], deferred: parts }
        const lastText = parts.slice(0, available).findLastIndex(part => part.kind === undefined)
        const kept = parts.slice(0, lastText >= 0 ? available : available - 1)
        const rest = parts.slice(kept.length)
        const count = kind => rest.filter(part => part.kind === kind).length
        const texts = rest.length - count('image') - count('file')
        const left = [
            count('image') > 0 ? `${count('image')} 张图` : '',
            count('file') > 0 ? `${count('file')} 个文件` : '',
            texts > 0 ? `${texts} 段文字` : '',
        ].filter(Boolean).join('、')
        const { replyLimit, replyLimitLabel } = config.platforms[platform]
        const notice = `（${replyLimitLabel} 每条消息只能回 ${replyLimit} 次，还有${left}没发；你下一条消息回完后我接着发，完整内容也在 DSH 桌面。）`
        if (lastText < 0) return { parts: [...kept, { text: notice }], deferred: rest }
        const withNotice = kept.map((part, index) => index === lastText ? { text: `${part.text.trimEnd()}\n\n${notice}` } : part)
        return { parts: withNotice, deferred: rest }
    }

    /** 这个锚点所属的对方真实消息（合并的一组取最后一条）。 */
    function anchorOwner(anchorKey) {
        return readIncomingRows()
            .filter(row => row.state === 'accepted' && (row.replyAnchorKey ?? row.anchorKey) === anchorKey
                && platformOriginal(row))
            .sort((left, right) => right.createdAt - left.createdAt)[0]
    }

    /**
     * 这个 QQ 锚点还剩几次被动回复。借用别人的锚点（转交、中途发送、补发）时，超出被动回复窗口就是 0。
     * `own` 表示这一批正是在回复这条消息。
     */
    /** 这条消息有没有被平台拒收过。 */
    function anchorRejected(anchorKey) {
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (parsed.success && parsed.data.anchorKey === anchorKey && parsed.data.errorCode === 'SEND_REJECTED') return true
        }
        return false
    }

    /** 对方的消息过了多久就不能再借它回复：平台声明的，没声明时是配置的转交窗口。 */
    const replyWindowOf = platform => config.platforms[platform]?.replyWindowMs ?? config.qqRelayWindowMs

    /** 这条消息在这个平台还能回几次；平台没有次数限制时是 `null`。 */
    function repliesLeftOn(platform, anchorKey, { skip, own = false } = {}) {
        const limit = config.platforms[platform]?.replyLimit
        if (limit === undefined) return null
        if (config.platforms[platform].rejectEndsReplies === true && anchorRejected(anchorKey)) return 0
        if (!own) {
            const owner = anchorOwner(anchorKey)
            if (owner === undefined || config.now() - owner.createdAt > replyWindowOf(platform)) return 0
        }
        return Math.max(limit - usedReplies(anchorKey, skip), 0)
    }

    /** 批的输入里有没有不是转交的输入：等待提醒也是在回复对方那条消息。 */
    function answersOwnInput(batch) {
        return readIncomingRows().some(row => batch.inputRequestIds.includes(row.requestId)
            && !row.platformMessageId.startsWith(RELAY_ID_PREFIX))
    }

    /**
     * 还没告诉助手的未送达投递（发送失败、结果不明、留待片过期）：`[{ deliveryId, row }]`。
     * 渠道自己发的群说明不是会话写的话，不算。
     */
    function unreportedFailures(predicate) {
        const rows = new Map()
        for (const [deliveryId, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (parsed.success) rows.set(deliveryId, parsed.data)
        }
        // 平台确定没发出、改了道的片只按原来那一片说一次，看改道那一条的结果：发出了不算未送达（另有一句改道说明），
        // 正在发的先不说（免得这时说“没送到”、会话又补发一遍），结果不明的照结果不明说，没发出的（或停机时还没发的）照确定没送到说。
        const reroutes = new Set([...rows.values()].map(row => row.reroutedTo).filter(id => id !== undefined))
        const found = []
        for (const [deliveryId, row] of rows) {
            if (row.failedAt === undefined || row.reportedAt !== undefined || row.system !== undefined) continue
            if (reroutes.has(deliveryId)) continue
            let view = row
            if (row.reroutedTo !== undefined) {
                if (reroutesInFlight.has(deliveryId)) continue
                const state = rows.get(row.reroutedTo)?.state
                if (state === 'sent') continue
                if (state === 'unknown' || state === 'sending') view = { ...row, state: 'unknown' }
            }
            if (predicate(view)) found.push({ deliveryId, row: view })
        }
        return found
    }

    /** 绑定编号 → 平台。 */
    function bindingPlatforms() {
        const platforms = new Map()
        for (const [, raw] of readEntries(tables.bindings)) {
            const parsed = parseBinding(raw)
            if (parsed.success) platforms.set(parsed.data.bindingId, parsed.data.platform)
        }
        return platforms
    }

    /** 一片未送达回复的说法：哪一轮、哪个渠道、开头几个字（不给全文）。 */
    function undeliveredLine({ row, unknown, codes, head }, platforms) {
        const where = labelOf(platforms.get(row.bindingId))
        const what = row.push === true ? '中途发送' : row.detour === true ? '改经这个渠道发的片' : `第 ${row.turn} 轮回复`
        const excerpt = head === null ? '图片或文件' : `「${Array.from(head.trim()).slice(0, 24).join('')}…」`
        return `- ${what}（${where}，${unknown ? '结果不明' : [...codes].join('、')}）：${excerpt}`
    }

    /** 未送达的片按批（再按确定没发出与结果不明）归并，按失败时间排序。 */
    function undeliveredGroups(entries) {
        const groups = new Map()
        for (const { deliveryId, row } of entries) {
            // 确定没发出的和结果不明的分开说：结果不明的可能已经送到，照“没送到”去重发会让对方收到两遍。
            const unknown = row.state === 'unknown'
            const key = `${row.bindingId}\u0000${row.turn}\u0000${row.endSeq}\u0000${unknown}`
            const group = groups.get(key) ?? { row, unknown, ids: [], codes: new Set(), head: null }
            group.ids.push(deliveryId)
            group.codes.add(row.errorCode ?? row.state)
            if (group.head === null && row.kind === undefined) group.head = row.text
            groups.set(key, group)
        }
        return [...groups.values()].sort((left, right) => left.row.failedAt - right.row.failedAt)
    }

    /**
     * 还没告诉助手的未送达投递，按批归并成一段说明，附给会话（`syncNotices`）。看整个会话：失败可能发生在另一个渠道。
     */
    function undeliveredNotice(sessionId) {
        const parts = [undeliveredText(unreportedFailures(row => row.sessionId === sessionId)), lateNotice(sessionId), routeNotice(sessionId)]
            .filter(part => part !== null)
        if (parts.length === 0) return null
        return { text: parts.map(part => part.text).join('\n'), ids: parts.flatMap(part => part.ids) }
    }

    /** 之前说结果不明、后来有了确定结果的片（`lateNote`），还没说的。 */
    function lateNotice(sessionId) {
        const found = []
        for (const [deliveryId, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (parsed.success && parsed.data.sessionId === sessionId && parsed.data.lateNote !== undefined) found.push({ deliveryId, row: parsed.data })
        }
        if (found.length === 0) return null
        found.sort((left, right) => left.row.endSeq - right.row.endSeq)
        return {
            text: ['（渠道提示，不是对方说的：下面这些之前说结果不明，后来有了确定结果。）', ...found.map(({ row }) => `- ${row.lateNote}`)].join('\n'),
            ids: found.map(({ deliveryId }) => deliveryId),
        }
    }

    /** 还没告诉会话的改了发法的说明：哪一轮、改成怎么发的。 */
    function routeNotice(sessionId) {
        const found = []
        for (const [deliveryId, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            const row = parsed.data
            if (row.sessionId !== sessionId || row.routeNote === undefined || row.reportedAt !== undefined) continue
            found.push({ deliveryId, row })
        }
        if (found.length === 0) return null
        found.sort((left, right) => left.row.endSeq - right.row.endSeq)
        return {
            text: ['（渠道提示，不是对方说的：下面这些按渠道能发的内容改了发法。）', ...found.map(({ row }) => `- ${row.routeNote}`)].join('\n'),
            ids: found.map(({ deliveryId }) => deliveryId),
        }
    }

    /** 未送达说明的正文与涉及的投递；没有时为 `null`。 */
    function undeliveredText(entries) {
        const platforms = bindingPlatforms()
        const ordered = undeliveredGroups(entries)
        if (ordered.length === 0) return null
        const shown = ordered.slice(0, UNDELIVERED_NOTICE_LIMIT)
        const line = group => undeliveredLine(group, platforms)
        const failed = shown.filter(group => !group.unknown)
        const unsure = shown.filter(group => group.unknown)
        const sections = []
        if (failed.length > 0) sections.push('（渠道提示，不是对方说的：下面这些确定没有送到对方手机，需要的话重新发。）', ...failed.map(line))
        if (unsure.length > 0) {
            sections.push('（渠道提示，不是对方说的：下面这些发出后没等到确认，可能已经送到对方手机；重发前先想一想，必要时问一句收到没有。）', ...unsure.map(line))
        }
        if (ordered.length > shown.length) sections.push(`- 另有 ${ordered.length - shown.length} 批`)
        return {
            text: sections.join('\n'),
            ids: ordered.flatMap(group => group.ids),
        }
    }

    /**
     * 平台回答“现在能不能主动发给这个对话”要用的事实：连接在不在、对方最近一条消息的时间、借那条消息还能回复几次。
     * 运行态只按平台给出的 `canDeliverNow(facts)` 判断，不按平台名分支。
     */
    function deliveryFacts(binding) {
        const latest = latestRealInput(binding)
        const anchorKey = latest === undefined ? null : latest.replyAnchorKey ?? latest.anchorKey
        return {
            latest,
            anchorKey,
            facts: {
                now: config.now(),
                live: bindingLive(binding),
                lastInputAt: latest === undefined ? null : latest.createdAt,
                repliesLeft: anchorKey === null ? 0 : repliesLeftOn(binding.platform, anchorKey),
            },
        }
    }

    /* ---------------------------- 按能力选路 ---------------------------- */

    /** 平台能不能发这种内容（`text`、`image`、`file`、`voice`）；平台没有声明时按都能发，由平台自己在发送时拒绝。 */
    function canSendKind(binding, kind = 'text') {
        const sends = config.platforms[binding.platform]?.sends
        return !Array.isArray(sends) || sends.includes(kind)
    }

    /** 能不能承载这种内容：发不了语音而能发文件时，语音按音频文件发。 */
    function canCarry(binding, kind = 'text') {
        return canSendKind(binding, kind) || (kind === 'voice' && canSendKind(binding, 'file'))
    }

    /**
     * 平台说现在能不能主动发给这个对话；`need` 是至少要能发几次。平台没有这项能力时按不能。
     * 连着被平台确定没发出、正在暂停的绑定也按现在不能发：选路先用别的渠道。
     */
    function deliverableNow(binding, need = 1) {
        if (pausedNow(binding)) return false
        const { facts } = deliveryFacts(binding)
        return config.platforms[binding.platform]?.canDeliverNow?.({ ...facts, repliesNeeded: need }) === true
    }

    /**
     * 一个绑定能换到的渠道范围：私聊可以在本人的几个私聊渠道之间换；群只能用到达同一个群的渠道，绝不落到私聊或别的群。
     */
    function scopeOf(binding) {
        if (isGroupBinding(binding)) return [binding]
        return sessionBindings(binding.sessionId).filter(item => !isGroupBinding(item))
    }

    /** 不是在回复某条消息时（转交、中途发送、主动联系）一个会话的渠道范围：有私聊绑定时只用私聊，否则是它接着的群。 */
    function sessionScope(sessionId) {
        const bindings = sessionBindings(sessionId)
        const own = bindings.filter(item => !isGroupBinding(item))
        return own.length > 0 ? own : bindings
    }

    /** 有对方真实消息可锚定的绑定，按对方最近一次在那里说话的时间从新到旧。 */
    function anchoredCandidates(bindings) {
        return bindings
            .map((binding) => {
                const latest = latestRealInput(binding)
                return latest === undefined ? null : { binding, latest, anchorKey: latest.replyAnchorKey ?? latest.anchorKey }
            })
            .filter(candidate => candidate !== null)
            .sort((left, right) => right.latest.createdAt - left.latest.createdAt)
    }

    /**
     * 唯一的选路：从给定范围里挑一个现在能发、又能发这种内容的渠道，对方最近在哪里说话就先用哪里；`prefer`（平台名或按先后排的几个，
     * 调用方指定）能发时按先后先用它们。都不能发时退回能把内容留到对方下一条消息之后再发的渠道（平台声明 `holdsUntilNextMessage`），
     * 再退回对方最近说话的那个渠道；绝不改投对方看不到的渠道。
     * @param need - 至少要能发几次：中途发送要给这一轮的最终回复留一次，所以是 2。
     */
    function pickReplyAnchor(bindings, { need = 1, prefer, kind = 'text' } = {}) {
        const candidates = anchoredCandidates(bindings)
        if (candidates.length === 0) return null
        const ready = candidates.filter(candidate => deliverableNow(candidate.binding, need) && canCarry(candidate.binding, kind))
        for (const platform of [prefer ?? []].flat()) {
            const hit = ready.find(candidate => candidate.binding.platform === platform)
            if (hit !== undefined) return hit
        }
        return ready[0]
            ?? candidates.find(candidate => config.platforms[candidate.binding.platform]?.holdsUntilNextMessage === true)
            ?? candidates[0]
    }

    /**
     * 中枢的话没走回复先后里的第一位、而这个会话接着它的私聊时，写在那条消息开头的一句说明（`rerouteNote` 开着时）；
     * 不需要时为 `null`。只看选中的渠道与第一位的私聊绑定在不在，同一批续发时得到同一句。
     */
    function rerouteNote(binding) {
        const preferred = config.rerouteNote ? config.replyOrder[0] : undefined
        if (preferred === undefined || binding.platform === preferred || isGroupBinding(binding)) return null
        const first = readBinding(preferred)
        return first !== null && bindingActive(first) && first.sessionId === binding.sessionId
            ? rerouteNoteOf(channelWord(preferred), channelWord(binding.platform)) : null
    }

    /** 文件名（给会话的说明里用）。 */
    const fileLabel = path => basename(String(path))

    /** 没有渠道能发文件时，小的文本文件读成文字；不是文本文件、太大或读不出时为 `null`。 */
    async function readTextFile(path) {
        if (!TEXT_FILE_EXTENSIONS.has(extname(String(path)).toLowerCase())) return null
        try {
            if ((await stat(path)).size > TEXT_FILE_LIMIT) return null
            const text = await readFile(path, 'utf8')
            return text.includes('\u0000') ? null : text
        } catch {
            return null
        }
    }

    /**
     * 按能力决定一批片怎么发：这个渠道能发的照发；发不了的（例如某个平台发不了文件）在同一范围里找现在能发、又能发这种内容的渠道
     * 改道发；都没有时，文本文件按文字分片发，其余只发一行文件在电脑上的位置。改了发法的片带一句 `routeNote` 告诉会话。
     * @param detourIdOf - 第几片改道发时的投递身份；那一片已经改道发过（有记录）时照旧用那条记录，不再重新选路。
     * @returns `{ parts, detours: [{ index, deliveryId, part, carrier, note }] }`
     */
    async function routeParts(binding, parts, { what, detourIdOf }) {
        const own = []
        const detours = []
        const label = labelOf(binding.platform)
        for (const [index, part] of parts.entries()) {
            const kind = part.kind ?? 'text'
            if (canCarry(binding, kind)) {
                own.push(part)
                continue
            }
            const deliveryId = detourIdOf(index)
            const stored = readOutgoing(deliveryId)
            const name = part.kind === 'file' ? `「${fileLabel(part.text)}」` : KIND_WORDS[kind] ?? kind
            if (stored !== null) {
                detours.push({ index, deliveryId, part, carrier: null, note: stored.routeNote })
                continue
            }
            const carrier = pickCarrier(binding, kind)
            if (carrier !== null) {
                const via = labelOf(carrier.binding.platform)
                detours.push({ index, deliveryId, part, carrier, note: `${what}的${name}：${label}发不了${KIND_WORDS[kind] ?? kind}，改经${via}发出` })
                continue
            }
            const text = kind === 'file' ? await readTextFile(part.text) : null
            if (text !== null) {
                const chunks = replyParts(binding.platform, `${fileLabel(part.text)}：\n\n${text}`)
                    .map(chunk => (chunk.kind === undefined ? chunk : { text: chunk.text }))
                own.push(...chunks.map((chunk, at) => (at === 0
                    ? { ...chunk, routeNote: `${what}的${name}：没有现在能发文件的渠道，按文字分 ${chunks.length} 片发出` }
                    : chunk)))
                continue
            }
            own.push({
                text: `（${KIND_WORDS[kind] ?? kind}在电脑上：${part.text}）`,
                routeNote: `${what}的${name}：没有现在能发${KIND_WORDS[kind] ?? kind}的渠道，只发了它在电脑上的位置`,
            })
        }
        return { parts: own, detours }
    }

    /** 同一范围里别的、现在能发（至少 `need` 次）、又能发这种内容的渠道；没有时为 `null`。 */
    function pickCarrier(binding, kind, need = 1) {
        const others = scopeOf(binding).filter(item => item.bindingId !== binding.bindingId)
        return anchoredCandidates(others).find(candidate => deliverableNow(candidate.binding, need) && canCarry(candidate.binding, kind)) ?? null
    }

    /**
     * 发出改道的片：记在承载它的渠道名下，锚定对方在那里最近的一条消息。
     * @param fields - 记进每一片的字段：中途发送改道的片还是那次发送的一部分，带 `push`、`by` 和那次的 `endSeq`。
     */
    async function sendDetours(sessionId, detours, fields = {}) {
        for (const { index, deliveryId, part, carrier, note } of detours) {
            if (closing) return
            let stored = readOutgoing(deliveryId)
            if (stored !== null && stored.state !== 'prepared') continue
            const target = stored === null ? carrier?.binding : readBindingById(stored.bindingId)
            if (target === null || target === undefined) continue
            if (stored === null) {
                stored = {
                    bindingId: target.bindingId,
                    sessionId,
                    turn: 0,
                    endSeq: config.now(),
                    sourceSeqs: [carrier.latest.nativeSeq],
                    inputRequestIds: [carrier.latest.requestId],
                    anchorKey: carrier.anchorKey,
                    partIndex: DETOUR_PART_BASE + index,
                    partCount: 1,
                    ...part.kind === undefined ? {} : { kind: part.kind },
                    text: part.text,
                    state: 'prepared',
                    receipt: null,
                    errorCode: null,
                    detour: true,
                    ...note === undefined ? {} : { routeNote: note },
                    ...fields,
                }
                await putOutgoing(deliveryId, stored)
            }
            await sendPrepared(stateOf(target.platform), target, null, deliveryId, stored)
        }
    }

    /** 按绑定编号读当前的绑定（私聊或群）。 */
    function readBindingById(bindingId) {
        for (const [, raw] of readEntries(tables.bindings)) {
            const parsed = parseBinding(raw)
            if (parsed.success && parsed.data.bindingId === bindingId) return parsed.data
        }
        return undefined
    }

    /** 这个会话这一次附过的提示正文（内存里）：没变就不重附，免得把附上的时间推到一轮开始以后、这一轮交不到。 */
    const attachedNotices = new Map()

    /**
     * 给会话的渠道提示（早先的未送达说明、后来有结果、改了发法）：附在核心的附提醒里，下一轮交给模型；
     * 这一轮正常结束、模型确实跑过以后核心才算交到，渠道这时给涉及的片记 `reportedAt`（后来有结果的去掉 `lateNote`）。
     * - 每个会话一条（键 `NOTICE_KEY`），内容变了就覆盖：核心按附上的时间判，这一轮开始以后才改的留给下一轮。
     * - 已告知：`onTaken` 只在内存里，所以每次先补认一遍：附过（`noticeAttached`）、还没记告知的片，核心那里这条提示已经没了，
     *   就是交到过了（重启以后也靠这个）。
     * - 平台能主动发时另外叫醒会话（`wakeForFailures`），不等它自己的下一轮。
     */
    async function syncNotices(sessionId) {
        if (closing || !isNonEmptyString(sessionId)) return
        let pending
        try {
            pending = host.core.pending(sessionId, NOTICE_KEY)
        } catch {
            return
        }
        if (!pending) {
            attachedNotices.delete(sessionId)
            for (const [deliveryId, raw] of readEntries(tables.outgoing)) {
                const parsed = outgoingSchema.safeParse(raw)
                if (parsed.success && parsed.data.sessionId === sessionId && parsed.data.noticeAttached === true) await markNoticeTold(deliveryId)
            }
        }
        const notice = undeliveredNotice(sessionId)
        if (notice === null) {
            if (pending) {
                await Promise.resolve(host.core.detach(sessionId, NOTICE_KEY)).catch(() => {})
                attachedNotices.delete(sessionId)
            }
            return
        }
        if (pending && attachedNotices.get(sessionId) === notice.text) return
        const ids = [...notice.ids]
        try {
            await host.core.attach(sessionId, NOTICE_KEY, notice.text, {
                onTaken: () => { track((async () => { for (const id of ids) await markNoticeTold(id) })()).catch(() => {}) },
            })
        } catch {
            // 附不上（核心的存储一时写不了）：下次对账再附。
            return
        }
        attachedNotices.set(sessionId, notice.text)
        for (const deliveryId of ids) {
            const stored = readOutgoing(deliveryId)
            if (stored !== null && stored.noticeAttached !== true) await putOutgoing(deliveryId, { ...stored, noticeAttached: true })
        }
    }

    /**
     * 回复确定没送到或结果不明、平台说现在能主动发时，马上叫醒这个会话（早先的时效：提示走附提醒，叫醒照旧）：
     * 经核心放一条很短的话（来源 `channel-notice`、`wake: 'now'`、回复发到所接的出口），详情由 `syncNotices` 附在提示里。
     * - 同一批失败只叫醒一次（核心按键去重）；失败超过一天的不叫醒，只等这个会话的下一轮。
     * - 防循环：被叫醒的那一轮（触发消息是叫醒的那条）自己的回复又没送到，标成只等下一轮（`nextInputOnly`），不再为它叫醒。
     * - 中途发送的失败在发送结果里已经告诉助手，不叫醒；绑定改接了别的会话以后，旧会话的失败也不叫醒新会话。
     * - 回复的去向照没有渠道输入的轮：休息时段里攒着。
     */
    async function wakeForFailures(binding) {
        if (closing) return
        const entries = unreportedFailures(row => row.bindingId === binding.bindingId && row.sessionId === binding.sessionId
            && row.push !== true && row.nextInputOnly !== true)
        if (entries.length === 0) return
        const fresh = []
        for (const entry of entries) {
            if (await answersWake(entry.row)) {
                await putOutgoing(entry.deliveryId, { ...entry.row, nextInputOnly: true })
                continue
            }
            if (config.now() - entry.row.failedAt <= UNDELIVERED_WAKE_MS) fresh.push(entry)
        }
        if (fresh.length === 0) return
        const { latest, facts } = deliveryFacts(binding)
        if (latest === undefined || config.platforms[binding.platform]?.canDeliverNow?.(facts) !== true) return
        const batches = new Set(fresh.map(({ row }) => `${binding.bindingId}-${row.turn}-${row.endSeq}`))
        for (const batch of batches) {
            if (closing) return
            const id = `${UNDELIVERED_WAKE_PREFIX}${sha256(batch).slice(0, 32)}`
            try {
                await host.core.deliver(binding.sessionId, {
                    key: id,
                    id,
                    text: UNDELIVERED_WAKE_TEXT,
                    source: { kind: CHANNEL_NOTICE_SOURCE },
                    speaker: CHANNEL_SPEAKER,
                    wake: 'now',
                    reply: { to: 'exit' },
                })
            } catch {
                // 交不出（会话一时取不到）：下次对账再试，同一批照旧只交一次。
            }
        }
    }

    /** 这一片是不是被叫醒的那一轮自己的回复：那一轮的触发消息是叫醒的那条（只有没有渠道输入的轮会是）。 */
    async function answersWake(row) {
        if (row.mainTurn !== true || !Number.isSafeInteger(row.turn)) return false
        try {
            const routed = await host.core.turnRoute(row.sessionId, row.turn)
            return typeof routed?.trigger === 'string' && routed.trigger.startsWith(UNDELIVERED_WAKE_PREFIX)
        } catch {
            return false
        }
    }

    /** 附给会话的提示交到了：这一片算告诉过（后来有结果的那句说过就去掉）。 */
    async function markNoticeTold(deliveryId) {
        await serialize(`notice-told:${deliveryId}`, async () => {
            const stored = readOutgoing(deliveryId)
            if (stored === null || stored.noticeAttached !== true) return
            const { noticeAttached: _attached, lateNote, ...rest } = stored
            await putOutgoing(deliveryId, lateNote !== undefined && stored.reportedAt !== undefined
                ? rest
                : { ...rest, ...lateNote === undefined ? {} : { lateNote }, reportedAt: stored.reportedAt ?? config.now() })
        })
    }

    /**
     * 还没告诉助手的未送达回复（给 Watchdog；附给会话的提示没交到之前都算）：失败超过 `olderThanMs` 仍没告诉的，按绑定归并。
     * 只给开头几个字，不给全文。
     * @returns `[{ sessionId, main, bindingId, platform, group, groupName, items: [{ what, unknown, excerpt, failedAt }], guarded }]`
     */
    function undelivered({ olderThanMs = 0 } = {}) {
        const cutoff = config.now() - olderThanMs
        const entries = unreportedFailures(row => row.failedAt <= cutoff)
        const bindings = new Map()
        for (const [, raw] of readEntries(tables.bindings)) {
            const parsed = parseBinding(raw)
            if (parsed.success) bindings.set(parsed.data.bindingId, parsed.data)
        }
        const mains = hubSessions()
        const byBinding = new Map()
        for (const group of undeliveredGroups(entries)) {
            const binding = bindings.get(group.row.bindingId)
            const item = byBinding.get(group.row.bindingId) ?? {
                sessionId: group.row.sessionId,
                main: mains.has(group.row.sessionId) && binding !== undefined && !isGroupBinding(binding),
                bindingId: group.row.bindingId,
                platform: binding?.platform ?? null,
                group: binding !== undefined && isGroupBinding(binding),
                groupName: binding !== undefined && isGroupBinding(binding) ? binding.groupName ?? binding.conversationId.slice(GROUP_PREFIX.length) : null,
                items: [],
                guarded: false,
            }
            item.items.push({
                what: group.row.push === true ? '中途发送' : group.row.detour === true ? '改经这个渠道发的片' : `第 ${group.row.turn} 轮回复`,
                unknown: group.unknown,
                excerpt: group.head === null ? '图片或文件' : Array.from(group.head.trim()).slice(0, 24).join(''),
                failedAt: group.row.failedAt,
            })
            if (group.row.nextInputOnly === true) item.guarded = true
            byBinding.set(group.row.bindingId, item)
        }
        return [...byBinding.values()]
    }

    async function deliverBatch(state, binding, newest) {
        let batch = newest
        const existing = readDeliveries(binding.bindingId, batch.turn, batch.endSeq)
            .filter(item => item.record.deferred !== true)
        // 已经全部发出的一批不再核对：分片规则后来变了也不会把旧回复标成来源变化。
        if (existing.length > 0 && existing.length === existing[0].record.partCount
            && existing.every(item => deliveredRow(item.record))) return
        const detourIdOf = index => deliveryIdOf({ bindingId: binding.bindingId, sessionId: binding.sessionId, turn: batch.turn, endSeq: batch.endSeq }, DETOUR_PART_BASE + index)
        const plan = async (source = batch) => {
            // 这个渠道发不了的内容按能力改道或改成文字。
            const routed = await routeParts(binding, await stitchImages(replyParts(binding.platform, source.text, source.files)),
                { what: `第 ${source.turn} 轮回复`, detourIdOf })
            const whole = routed.parts
            // 已经开始投递的一批沿用当时的片数：只在首次投递时按剩余额度切分，不给早已发完的旧批补出留待片。
            // 转交的回复借用对方最近一条消息的额度，那条消息过了被动回复窗口时整批留到对方下一条消息之后。
            const fitted = config.platforms[binding.platform]?.replyLimit !== undefined
                ? fitReply(binding.platform, whole, existing.length > 0
                    ? existing[0].record.partCount
                    : repliesLeftOn(binding.platform, batch.anchorKey, { skip: batch, own: batch.mainTurn !== true && answersOwnInput(batch) }))
                : { parts: whole, deferred: [] }
            return { ...fitted, detours: routed.detours }
        }
        let fitted = await plan()
        // 升级前已经开始投递的一批按当时的规则续发（整轮全部文字），不因规则变化被判成来源变化。
        // 片数与片的种类也要对上：只比前几片的文字，会把片数已变的新切法当成对得上，停在来源变化上不再续发。
        const fits = candidate => existing.every(item => item.record.partCount === candidate.parts.length
            && item.record.text === candidate.parts[item.record.partIndex]?.text
            && item.record.kind === candidate.parts[item.record.partIndex]?.kind)
        if (existing.length > 0 && !fits(fitted)) {
            const older = batch.legacy === undefined ? null : { ...batch, text: batch.legacy.text, sourceSeqs: batch.legacy.sourceSeqs }
            for (const source of older === null ? [] : [older]) {
                const candidate = await plan(source)
                if (!fits(candidate)) continue
                fitted = candidate
                batch = source
                break
            }
        }
        const parts = fitted.parts
        const chunks = parts.map(part => part.text)
        if (chunks.length === 0 && fitted.deferred.length === 0) {
            await sendDetours(binding.sessionId, fitted.detours)
            return
        }
        // failed/unknown/sending 都是终态：不补发、不新增片段；prepared 从未发送，可恢复。平台确定没发出、已经改道发出的片
        // 算送到了，后面的片接着发（重启后也是）。
        if (existing.some(item => !deliveredRow(item.record) && item.record.state !== 'prepared')) return
        const base = {
            bindingId: binding.bindingId,
            sessionId: binding.sessionId,
            turn: batch.turn,
            endSeq: batch.endSeq,
            sourceSeqs: [...batch.sourceSeqs],
            inputRequestIds: [...batch.inputRequestIds],
            anchorKey: batch.anchorKey,
            ...batch.mainTurn === true ? { mainTurn: true } : {},
        }
        // 首次投递时先记下留待下次的片：发送中途崩溃也不丢。
        const deferredAt = config.now()
        for (let index = 0; existing.length === 0 && index < fitted.deferred.length; index += 1) {
            const deliveryId = deliveryIdOf(base, DEFERRED_PART_BASE + index)
            if (readOutgoing(deliveryId) !== null) continue
            const part = fitted.deferred[index]
            await putOutgoing(deliveryId, {
                ...base,
                partIndex: DEFERRED_PART_BASE + index,
                partCount: fitted.deferred.length,
                ...part.kind === undefined ? {} : { kind: part.kind },
                ...part.routeNote === undefined ? {} : { routeNote: part.routeNote },
                text: part.text,
                state: 'prepared',
                receipt: null,
                errorCode: null,
                deferred: true,
                deferredAt,
            })
        }
        if (existing.length > 0) {
            // 已建立的同 turn/endSeq 投递身份与元数据不可改写：不一致时显式 SOURCE_CHANGED。
            const consistent = existing.every(item => item.record.sessionId === binding.sessionId
                && item.record.partCount === chunks.length
                && item.record.partIndex < chunks.length
                && item.record.text === chunks[item.record.partIndex]
                && item.record.kind === parts[item.record.partIndex].kind
                && item.record.anchorKey === base.anchorKey
                && sameNumberList(item.record.sourceSeqs, base.sourceSeqs)
                && sameStringList(item.record.inputRequestIds, base.inputRequestIds))
            if (!consistent) {
                state.errorCode = 'SOURCE_CHANGED'
                for (const item of existing) {
                    if (item.record.state !== 'prepared') continue
                    await putOutgoing(item.deliveryId, {
                        ...item.record,
                        state: 'failed',
                        errorCode: 'SOURCE_CHANGED',
                    })
                }
                return
            }
        }
        for (let index = 0; index < chunks.length; index += 1) {
            if (closing) return
            const deliveryId = deliveryIdOf(base, index)
            const stored = readOutgoing(deliveryId)
            if (stored !== null && stored.state !== 'prepared') continue
            const prepared = {
                ...base,
                partIndex: index,
                partCount: chunks.length,
                ...parts[index].kind === undefined ? {} : { kind: parts[index].kind },
                ...parts[index].routeNote === undefined ? {} : { routeNote: parts[index].routeNote },
                text: chunks[index],
                state: 'prepared',
                receipt: null,
                errorCode: null,
            }
            if (stored === null) {
                await putOutgoing(deliveryId, prepared)
            } else if (!sameDeliveryPayload(stored, prepared)) {
                // 同 deliveryId 的正文/分片/来源不可变：改写等于换一次投递，直接停批。
                state.errorCode = 'SOURCE_CHANGED'
                await putOutgoing(deliveryId, { ...stored, state: 'failed', errorCode: 'SOURCE_CHANGED' })
                return
            }
            // 首片之后 source 被撤下/压缩、或 owner 变动，由 sendPrepared 的最后一步发现并停批。
            // 平台确定没发出的片改道发出后接着发下一片；没送到就停批。
            const outcome = await sendPiece(state, binding, batch, deliveryId, prepared)
            if (outcome === 'held') {
                // 这条消息回不了了：后面的片不再碰平台，一起留到对方下一条消息之后。
                for (let rest = index + 1; rest < chunks.length; rest += 1) {
                    if (readOutgoing(deliveryIdOf(base, rest)) === null) await holdPart(binding, base, rest, { kind: parts[rest].kind, text: chunks[rest] })
                }
                return
            }
            if (outcome !== 'sent') return
        }
        await sendDetours(binding.sessionId, fitted.detours)
    }

    /**
     * 每个绑定（私聊、各群）在自己的后台投递里发回复：有发送节奏的平台一批可能要发几十秒，慢的平台也不拖住对账循环，
     * 别的绑定的收件和发送照常进行。同一绑定的片在一个投递里按顺序发；投递进行中又被唤醒时，发完再跑一遍。
     * wake() 的等待者仍会等到这些后台投递结束。
     */
    async function deliverReplies(state, binding) {
        const running = deliveryJobs.get(binding.bindingId)
        if (running !== undefined) {
            running.again = true
            return
        }
        const job = { again: false, promise: null }
        // 先登记再开始：投递若同步就结束，finally 里的删除不会被随后的登记盖掉。
        deliveryJobs.set(binding.bindingId, job)
        job.promise = track((async () => {
            try {
                // 让出一拍：对账循环先往下走，不等这一批的节奏。
                await Promise.resolve()
                do {
                    job.again = false
                    if (closing) return
                    // 重跑时重新读绑定：字段可能已更新；绑定没了或停用就不再发。
                    const current = readBindingAt(bindingKeyOf(binding))
                    if (current === null || current.bindingId !== binding.bindingId || !bindingActive(current)) return
                    await reconcileReplies(state, current)
                } while (job.again && !closing)
            } finally {
                if (deliveryJobs.get(binding.bindingId) === job) deliveryJobs.delete(binding.bindingId)
            }
        })())
    }

    /* ------------------- 中枢每一轮的回复默认发到手机 ------------------- */

    /** 中枢的私聊绑定（启用的）：中枢的回复在这几个渠道里按先后选。 */
    function mainScope(sessionId) {
        return sessionBindings(sessionId).filter(binding => !isGroupBinding(binding))
    }

    /**
     * 渠道接着的会话（登记给核心的出口 `core.exits`）：私聊绑定指向的会话接成中枢（`hub`），
     * 群绑定接着的会话接成群（`group`）。一个会话只按一种算：私聊优先（中枢不能再接群）。
     */
    function exitSessions() {
        const out = new Map()
        for (const sessionId of hubSessions()) out.set(sessionId, { sessionId, as: 'hub' })
        for (const [, raw] of readEntries(tables.bindings)) {
            const parsed = parseBinding(raw)
            if (!parsed.success || !isGroupBinding(parsed.data) || !bindingActive(parsed.data) || out.has(parsed.data.sessionId)) continue
            const group = parsed.data
            out.set(group.sessionId, { sessionId: group.sessionId, as: 'group', label: `群「${group.groupName ?? group.conversationId.slice(GROUP_PREFIX.length)}」` })
        }
        return [...out.values()]
    }

    /** 已经报过"这一轮没有回复去向记录"的轮：`<会话>-<turn/end 的 seq>`，同一轮只报一次。 */
    const reportedNoRoute = new Set()

    /**
     * 没有渠道输入的一轮怎么发：按核心记下的回复去向（`core.turnRoute`）和这一轮的结果（`core.outcomeOf`）。
     * - 结果是等待、或不发且没有要交的文件：不发。不发的轮还有文件时只发文件。
     * - 中枢（`hub`）：去向是 `{to:'none'}` 的不发；其余发到手机。代用户的（`onBehalfOfUser`）或用户在桌面上说的立即发，
     *   别的休息时段里留到时段结束。
     * - 接群会话（`group`）：代用户的立即发到群里；`{to:'exit'}` 的发到群里、休息时段里留到时段结束；
     *   别的会话、程序开的一轮不外发，也不回传给说话的那个会话。
     * - 没有去向记录的轮（核心装上以前的）：不发，报一次。
     * @returns `{ send: false }` 或 `{ send: true, now: boolean, text }`。
     */
    async function planTurn(sessionId, as, item) {
        const outcome = await host.core.outcomeOf(sessionId, item.turn)
        if (outcome === null || outcome.kind === 'wait' || (outcome.kind === 'silent' && item.files.length === 0)) return { send: false }
        const routed = await host.core.turnRoute(sessionId, item.turn)
        if (routed === null) {
            const subject = `${sessionId}-${item.endSeq}`
            if (!reportedNoRoute.has(subject)) {
                reportedNoRoute.add(subject)
                host.core.report?.('channels/no-turn-route', { sessionId, text: `会话 ${sessionId} 第 ${item.turn} 轮没有回复去向记录，这一轮的回复没有发出去` })
            }
            return { send: false }
        }
        const route = routed.route ?? {}
        const text = outcome.kind === 'reply' ? `${item.text}${outcome.truncated === true ? '\n\n（回复到了长度上限，后面被截断了。）' : ''}` : ''
        if (as === 'hub') {
            if (route.to === 'none') return { send: false }
            return { send: true, now: route.onBehalfOfUser === true || item.byUser, text }
        }
        if (route.onBehalfOfUser === true) return { send: true, now: true, text }
        if (route.to === 'exit') return { send: true, now: false, text }
        return { send: false }
    }

    /** 中枢起点与每一轮决定的存储键（只用字母、数字与连字符）。 */
    const mainFromKey = sessionId => `main-from-${sha256(sessionId).slice(0, 40)}`
    const mainTurnKey = (sessionId, turn, endSeq) => `main-turn-${sha256(JSON.stringify([sessionId, turn, endSeq])).slice(0, 40)}`

    function readMainTurn(key) {
        const raw = readRecord(tables.mainTurns, key)
        if (raw === undefined) return null
        const parsed = mainTurnSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
    }

    const putMainTurn = (key, value) => putRecord(tables.mainTurns, mainTurnSchema, key, value)

    /**
     * 中枢、接群会话里没有渠道输入的轮在后台投递里发（有发送节奏的平台可能要几十秒，对账循环不等它）；投递进行中又被唤醒时，发完再跑一遍。
     * 每个会话只有一个这样的投递，同一轮不会被并发处理两次。
     */
    function deliverMainTurns(sessionId, as) {
        const jobKey = `main-turns\u0000${sessionId}`
        const running = deliveryJobs.get(jobKey)
        if (running !== undefined) {
            running.again = true
            return
        }
        const job = { again: false, promise: null }
        deliveryJobs.set(jobKey, job)
        job.promise = track((async () => {
            try {
                await Promise.resolve()
                do {
                    job.again = false
                    if (closing) return
                    await reconcileMainTurns(sessionId, as)
                } while (job.again && !closing)
            } finally {
                if (deliveryJobs.get(jobKey) === job) deliveryJobs.delete(jobKey)
            }
        })())
    }

    /**
     * 中枢每一轮的最终回复默认发到用户手机：有渠道输入的轮照原逻辑回到原来的渠道，这里只补
     * 没有渠道输入的轮（桌面上说的、外部调用方或别的会话转来的、后台一轮、额度恢复后的唤醒……）。发送状态全部持久（`main_turns` 表）：
     * - 起点：第一次启用时读到的会话最后序号，之后不动；之前结束的轮是启用前的历史，一概不发（夜里第一次部署也不会把当夜早先的轮补发）。
     * - 整条只写了不发标记或等待标记的记 `skipped`，不发。
     * - 休息时段里不是用户触发的轮（`byUser`）记 `held` 攒着，时段结束后发；到点唤醒一次。停机跨过时段结束也不丢：重启后不在时段里就发。
     *   到点时已经过时的不发：这一轮之后用户说过话，或者之后已经有话发到用户手上（`heldIsStale`）。
     * - 选渠道：按配置的先后（`replyOrder`），再按对方最近说话的渠道；没走第一位时按 `rerouteNote` 在那条消息开头注明。选定后先记 `sending`（渠道、锚点），
     *   再发；之后只按这一条接着发，留待片换锚补发以后也不会再按普通片发一遍。
     */
    async function reconcileMainTurns(sessionId, as) {
        if (closing || (as === 'hub' && !config.mainTurnReplies)) return
        const scope = as === 'hub' ? mainScope(sessionId) : sessionBindings(sessionId).filter(isGroupBinding)
        if (scope.length === 0) return
        const cut = await readCut(scope[0])
        if (cut === null) return
        let from = readMainTurn(mainFromKey(sessionId))
        if (from === null) {
            from = { kind: 'from', sessionId, seq: cut.cursor, at: config.now() }
            await putMainTurn(mainFromKey(sessionId), from)
        }
        const now = config.now()
        const quiet = host.core.quietHours.inQuiet(now)
        let held = false
        const items = extractSessionTurns(cut.events, cut.surfaceEvents, readIncomingRows())
        // 攒着的轮不靠当前记录枚举：之后落了边界，它就枚举不到了，但已经定了要发。
        const listed = new Set(items.map(item => mainTurnKey(sessionId, item.turn, item.endSeq)))
        for (const [key] of readEntries(tables.mainTurns)) {
            const row = readMainTurn(key)
            if (row?.kind !== 'turn' || row.sessionId !== sessionId || listed.has(key)) continue
            if (row.state !== 'held' && !(row.state === 'sending' && row.detached === true)) continue
            items.push({ turn: row.turn, endSeq: row.endSeq, sourceSeqs: row.sourceSeqs ?? [row.endSeq], text: row.text ?? '', files: row.files ?? [], byUser: false, detached: true })
        }
        items.sort((left, right) => left.endSeq - right.endSeq)
        for (const item of items) {
            if (closing) return
            if (item.endSeq <= from.seq) continue
            const key = mainTurnKey(sessionId, item.turn, item.endSeq)
            let decided = readMainTurn(key)
            if (decided?.state === 'skipped') continue
            if (decided?.state !== 'sending') {
                const base = { kind: 'turn', sessionId, turn: item.turn, endSeq: item.endSeq }
                // 留到时段结束的轮已经定了要发：时段里接着留，时段过了直接发，不再问一遍去向。
                if (decided?.state === 'held' && quiet) {
                    held = true
                    continue
                }
                if (decided?.state === 'held' && heldIsStale(cut.events, sessionId, item)) {
                    await putMainTurn(key, { ...base, state: 'skipped', at: now })
                    continue
                }
                if (decided?.state !== 'held') {
                    let plan
                    try {
                        plan = await planTurn(sessionId, as, item)
                    } catch {
                        // 读不出这一轮的结果或去向（会话日志暂时读不了）：这次先不定，下次对账再看。
                        continue
                    }
                    if (!plan.send) {
                        await putMainTurn(key, { ...base, state: 'skipped', at: now })
                        continue
                    }
                    if (quiet && !plan.now) {
                        held = true
                        await putMainTurn(key, { ...base, state: 'held', heldUntil: quietEnd(now), text: plan.text, sourceSeqs: item.sourceSeqs, files: item.files, at: now })
                        continue
                    }
                    decided = { ...base, text: plan.text }
                }
                const picked = as === 'hub' ? pickMainTarget(scope) : pickGroupTarget(scope)
                if (picked === null) continue
                decided = {
                    ...base,
                    state: 'sending',
                    bindingId: picked.binding.bindingId,
                    anchorKey: picked.anchorKey,
                    inputRequestIds: [picked.latest.requestId],
                    text: decided.text,
                    ...item.detached === true ? { detached: true, sourceSeqs: item.sourceSeqs, files: item.files } : {},
                    at: now,
                }
                await putMainTurn(key, decided)
            }
            const binding = readBindingById(decided.bindingId)
            if (binding === undefined || !bindingActive(binding) || binding.sessionId !== sessionId) continue
            const state = stateOf(binding.platform)
            if (!hasReadyListener(state, binding)) continue
            const note = rerouteNote(binding)
            // 发的文字是定下要发时记的那份（结果是不发、只交文件的轮为空）；旧记录没有这一项时用这一轮的文字。
            const body = decided.text ?? item.text
            await deliverBatch(state, binding, {
                mainTurn: true,
                turn: item.turn,
                endSeq: item.endSeq,
                sourceSeqs: item.sourceSeqs,
                inputRequestIds: [...decided.inputRequestIds],
                anchorKey: decided.anchorKey,
                text: note === null ? body : body === '' ? note : `${note}\n\n${body}`,
                turnText: item.text,
                files: item.files,
            })
        }
        if (held) scheduleQuietWake()
    }

    /** 攒着的这一轮到点时还该不该发：之后用户本人说过话，或者之后的轮已经有话发到用户手上（`assistant_channel_send`、代用户的回复），就过时了。 */
    function heldIsStale(events, sessionId, item) {
        if (events.some(event => event?.type === 'user/message' && event.seq > item.endSeq && event.data?.source?.speaker?.kind === 'user')) return true
        for (const [, value] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(value)
            if (parsed.success && parsed.data.sessionId === sessionId && parsed.data.state === 'sent' && parsed.data.system === undefined && parsed.data.turn > item.turn) return true
        }
        return false
    }

    /** 新的一轮选渠道：连接就绪的私聊渠道里按配置的先后（`replyOrder`，空时按对方最近在哪说话），借对方在那里最近一条真实消息的锚点。 */
    function pickMainTarget(scope) {
        const ready = scope.filter(binding => hasReadyListener(stateOf(binding.platform), binding))
        return ready.length === 0 ? null : pickReplyAnchor(ready, { prefer: config.replyOrder })
    }

    /** 接群会话的一轮发到它接的群：群绑定要连着，借对方在群里最近一条消息的锚点。 */
    function pickGroupTarget(scope) {
        const ready = scope.filter(binding => hasReadyListener(stateOf(binding.platform), binding))
        return ready.length === 0 ? null : pickReplyAnchor(ready)
    }

    /** 休息时段里攒着回复：时段结束时唤醒一次，把它们发出去。已有更早的计时就不动。 */
    function scheduleQuietWake() {
        if (closing) return
        const due = quietEnd(config.now())
        if (due === null || (quietTimer !== undefined && quietTimer.due <= due)) return
        clearTimeout(quietTimer?.timer)
        const timer = setTimeout(() => {
            quietTimer = undefined
            requestWakeSafely()
        }, Math.max(due - config.now(), 0) + 1000)
        timer.unref?.()
        quietTimer = { timer, due }
    }

    /** 已经记过的"回复被挡下"的轮：`<绑定>-<turn/end 的 seq>`，同一轮只记一次。 */
    const reportedBlocked = new Set()

    /**
     * 一轮完成了、有渠道输入，回复却因归属核对不过没有发：以前悄悄不发，哪里都不记。
     * 报一条 `channels/reply-blocked`；只报这次启动之后结束的轮，升级前早已结束的不补报。
     * 已经发出去的轮不算：压缩以后旧轮在会话视图里换成了摘要，核对会不过，但回复早就送到了（Codex 复核）。
     */
    function noteBlockedReplies(binding, sessionId, blocked) {
        if (config.report === null) return
        for (const turn of blocked) {
            const subject = `${binding.bindingId}-${turn.endSeq}`
            if (reportedBlocked.has(subject) || !(turn.endTime >= startedAt)) continue
            if (readDeliveries(binding.bindingId, turn.turn, turn.endSeq).length > 0) continue
            reportedBlocked.add(subject)
            const where = isGroupBinding(binding)
                ? `群「${binding.groupName ?? binding.conversationId.slice(GROUP_PREFIX.length)}」接的会话`
                : hubSessions().has(sessionId) ? '中枢' : '会话'
            const why = BLOCKED_REASONS[turn.reason] ?? turn.reason
            reportSafely(CHANNEL_REPORTS.replyBlocked, {
                sessionId,
                text: `一轮完成了，回复没有发出去 · ${where}：第 ${turn.turn} 轮（${labelOf(binding.platform)}）：${why}，这一轮的回复没有发到对方手机。`,
                data: { subject },
            })
        }
    }

    async function reconcileReplies(state, binding) {
        if (closing || !hasReadyListener(state, binding)) return
        const rows = readIncomingRows().filter(row => row.bindingId === binding.bindingId)
        if (!rows.some(row => row.state === 'accepted')) return
        const cut = await readCut(binding)
        if (cut === null) return
        const blocked = []
        const batches = extractReplyBatches(cut.events, cut.surfaceEvents, rows, { original: host.core.provenance.original, blocked })
        noteBlockedReplies(binding, binding.sessionId, blocked)
        for (const batch of batches) {
            if (closing) return
            if (batch.bindingId !== binding.bindingId) continue
            // 没写文字的说明只给这次启动之后结束的轮：升级前早已结束的空轮不补发。
            if (batch.noText === true && !(batch.endTime >= startedAt)) continue
            // 整条只写了不发标记：这一轮不发到手机，也不等、不提醒。
            if (NO_SEND_MARKERS.includes(batch.text.trim())) continue
            if (config.waitTimeoutMs > 0 && WAIT_MARKERS.includes(batch.text.trim())) {
                await recordWait(binding, batch, rows)
                continue
            }
            await deliverBatch(state, binding, batch)
        }
        // 判断桌面输入要看全部绑定的准入记录：同一会话绑定的另一渠道（微信）的消息不算桌面。
        await drainDeferred(state, binding, latestDesktopInput(cut.events, readIncomingRows()))
        await checkWaits(binding)
        await syncNotices(binding.sessionId)
        await wakeForFailures(binding)
    }

    /**
     * 留待下次的片：对方发来新消息、这条消息已经得到回复之后，用它剩下的回复额度按顺序接着发。
     * 新消息自己的回复总是先发。超过一天还没发出的不再发。对方在那一轮之后从 DSH 桌面发过消息的，
     * 说明已经在桌面上看过，不再补发，也不当作未送达告诉助手。
     */
    async function drainDeferred(state, binding, desktop = null) {
        if (config.platforms[binding.platform]?.replyLimit === undefined) return
        const waiting = []
        for (const [deliveryId, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            const row = parsed.data
            if (row.bindingId !== binding.bindingId || row.deferred !== true || row.state !== 'prepared') continue
            if (config.now() - (row.deferredAt ?? 0) > DEFERRED_TTL_MS) {
                await putOutgoing(deliveryId, { ...row, state: 'failed', errorCode: 'DEFERRED_EXPIRED' })
                continue
            }
            if (desktop !== null && row.sessionId === binding.sessionId && row.endSeq < desktop.seq) {
                await putOutgoing(deliveryId, { ...row, state: 'failed', errorCode: 'SEEN_ON_DESKTOP', reportedAt: config.now() })
                continue
            }
            waiting.push({ deliveryId, row })
        }
        if (waiting.length === 0) return
        const latest = latestRealInput(binding)
        const limit = config.platforms[binding.platform]?.replyLimit
        if (limit === undefined || latest === undefined || config.now() - latest.createdAt > replyWindowOf(binding.platform)) return
        const anchorKey = latest.replyAnchorKey ?? latest.anchorKey
        const used = usedReplies(anchorKey)
        if (used === 0) return
        if (config.platforms[binding.platform].rejectEndsReplies === true && anchorRejected(anchorKey)) return
        let free = limit - used
        const due = waiting
            .filter(item => (item.row.deferredAt ?? 0) <= latest.createdAt)
            .sort((left, right) => (left.row.deferredAt - right.row.deferredAt)
                || (left.row.endSeq - right.row.endSeq) || (left.row.partIndex - right.row.partIndex))
        for (const { deliveryId, row } of due) {
            if (free <= 0 || closing) return
            const prepared = { ...row, anchorKey }
            await putOutgoing(deliveryId, prepared)
            free -= 1
            if (await sendPiece(state, binding, null, deliveryId, prepared) !== 'sent') return
        }
    }

    /**
     * 助手只回复了等待标记：不发送，记下一条 wait 投递与到期时间。若这一轮本身就是到期提醒，
     * 不再等待（避免循环），记为 final。
     */
    async function recordWait(binding, batch, rows) {
        const base = {
            bindingId: binding.bindingId,
            sessionId: binding.sessionId,
            turn: batch.turn,
            endSeq: batch.endSeq,
            sourceSeqs: [...batch.sourceSeqs],
            inputRequestIds: [...batch.inputRequestIds],
            anchorKey: batch.anchorKey,
        }
        const deliveryId = deliveryIdOf(base, 0)
        if (readOutgoing(deliveryId) !== null) return
        const answersNudge = rows.some(row => batch.inputRequestIds.includes(row.requestId)
            && row.platformMessageId.startsWith(NUDGE_ID_PREFIX))
        const now = config.now()
        await putOutgoing(deliveryId, {
            ...base,
            partIndex: 0,
            partCount: 1,
            kind: 'wait',
            text: batch.text.trim(),
            state: 'sent',
            receipt: null,
            errorCode: null,
            waitUntil: now + config.waitTimeoutMs,
            waitState: answersNudge ? 'final' : 'waiting',
        })
        if (!answersNudge) scheduleWaitWake(config.waitTimeoutMs)
    }

    /**
     * 处理仍在等待的标记：期间来了新消息就作废（新消息会触发新的一轮）；到期仍无新消息，
     * 以最后一条消息为锚点写入一条提醒输入，由正常准入交给助手。
     */
    async function checkWaits(binding) {
        for (const [deliveryId, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            const wait = parsed.data
            if (wait.bindingId !== binding.bindingId || wait.kind !== 'wait' || wait.waitState !== 'waiting') continue
            const since = wait.waitUntil - config.waitTimeoutMs
            const newer = readIncomingRows().some(row => row.bindingId === binding.bindingId
                && row.createdAt > since
                && !row.platformMessageId.startsWith(NUDGE_ID_PREFIX))
            if (newer) {
                await putOutgoing(deliveryId, { ...wait, waitState: 'superseded' })
                continue
            }
            const remaining = wait.waitUntil - config.now()
            if (remaining > 0) {
                scheduleWaitWake(remaining)
                continue
            }
            const platformMessageId = `${NUDGE_ID_PREFIX}${wait.turn}:${wait.endSeq}`
            const key = incomingKeyOf(binding.bindingId, platformMessageId)
            await serialize(key, async () => {
                if (tables.incoming.get(key) !== undefined) return
                await putIncoming(key, {
                    bindingId: binding.bindingId,
                    platformMessageId,
                    platform: binding.platform,
                    accountId: binding.accountId,
                    conversationId: binding.conversationId,
                    senderId: binding.senderId,
                    fingerprint: incomingFingerprintOf({
                        platform: binding.platform,
                        accountId: binding.accountId,
                        conversationId: binding.conversationId,
                        senderId: binding.senderId,
                        platformMessageId,
                        text: NUDGE_TEXT,
                    }),
                    text: NUDGE_TEXT,
                    anchorKey: wait.anchorKey,
                    state: 'queued',
                    requestId: null,
                    nativeMessageId: null,
                    nativeSeq: null,
                    // 提醒不参与合并等待：时间戳取足够早，下一次准入立即进行。
                    createdAt: config.now() - config.mergeImageMs - config.mergeTextMs - 1,
                })
            })
            await putOutgoing(deliveryId, { ...wait, waitState: 'nudged' })
            requestWakeSafely()
        }
    }

    /** 等待到期时唤醒一次核对。 */
    function scheduleWaitWake(milliseconds) {
        if (closing) return
        clearTimeout(waitTimer)
        waitTimer = setTimeout(() => {
            waitTimer = undefined
            requestWakeSafely()
        }, milliseconds)
        waitTimer.unref?.()
    }

    /**
     * 把一段系统转交的文字作为对方消息交给绑定会话，回复照常发回该渠道。
     *
     * 锚点借用对方最近一条真实消息：微信沿用它的上下文；QQ 只在被动回复窗口内、且该消息还剩足够
     * 回复额度时借用。多个渠道都可用时选对方最近用过的那个。同一 key 只写入一次。
     * @param {{ sessionId: string, key: string, text: string }} request
     * @returns {Promise<{ status: 'queued', platform: string } | { status: 'unavailable', reason: string }>}
     */
    /** 会话启用中的绑定。 */
    function sessionBindings(sessionId) {
        const bindings = []
        for (const [, raw] of readEntries(tables.bindings)) {
            const parsed = parseBinding(raw)
            if (parsed.success && parsed.data.sessionId === sessionId && bindingActive(parsed.data)) bindings.push(parsed.data)
        }
        return bindings
    }

    /**
     * 一轮之中立即发给对方，不必等这一轮结束：文字照发图规则拆片，文件原样发送，语音（本机 WAV）在最后。
     * 锚定对方最近一条真实消息；QQ 给这一轮的最终回复留一次额度，放不下的片不发，并在结果里说明。
     * `prefer: 'weixin'` 时微信还在上下文里就先走微信，否则照常选路。
     * @param {{ sessionId: string, text?: string, files?: string[], voice?: string, prefer?: 'weixin' }} request
     * @returns {Promise<{ status: 'sent', platform: string, sent: number, failed: number, unsent: number,
     *   repliesLeft: number|null } | { status: 'unavailable', reason: string }>}
     */
    /**
     * `avoid`：这次不用的绑定（按 bindingId）。例如要停掉某个渠道做维护时，通知用户不能再经它发。
     */
    async function push({ sessionId, text = '', files = [], voice, prefer, avoid = [], by } = {}) {
        if (!isNonEmptyString(sessionId) || typeof text !== 'string' || !Array.isArray(files)
            || !files.every(isNonEmptyString) || (voice !== undefined && !isNonEmptyString(voice))
            || !Array.isArray(avoid) || !avoid.every(isNonEmptyString)) {
            throw new ChannelRuntimeError('INVALID_PUSH', 'push 需要 sessionId，text 为字符串，files 为路径数组，voice 为路径')
        }
        if (replyParts('weixin', text, files).length === 0 && voice === undefined) throw new ChannelRuntimeError('INVALID_PUSH', 'push 没有可发送的内容')
        const bindings = sessionScope(sessionId).filter(binding => !avoid.includes(binding.bindingId))
        if (bindings.length === 0) return { status: 'unavailable', reason: 'NOT_BOUND' }
        const picked = pickReplyAnchor(bindings, { need: 2, prefer })
        if (picked === null) return { status: 'unavailable', reason: 'NO_REPLY_ANCHOR' }
        const { binding, anchorKey, latest } = picked
        const stamp = config.now()
        const whole = await stitchImages(replyParts(binding.platform, text, files))
        if (voice !== undefined) whole.push({ kind: 'voice', text: voice })
        // 这个渠道发不了的内容按能力改道或改成文字；怎么发的写进结果，助手当场就知道。
        const routed = await routeParts(binding, whole, {
            what: '这次发送',
            detourIdOf: index => deliveryIdOf({ bindingId: binding.bindingId, sessionId, turn: 0, endSeq: stamp }, DETOUR_PART_BASE + index),
        })
        const parts = routed.parts.map(({ routeNote, ...part }) => part)
        const routeNotes = [...routed.parts.map(part => part.routeNote), ...routed.detours.map(detour => detour.note)].filter(note => note !== undefined)
        // 有次数限制的平台给这一轮的最终回复留一次。
        const left = repliesLeftOn(binding.platform, anchorKey)
        if (left !== null && left < 2) return { status: 'unavailable', reason: 'NO_REPLIES_LEFT', repliesLeft: left }
        const state = stateOf(binding.platform)
        const allowed = left === null ? parts.length : Math.min(parts.length, left - 1)
        const base = {
            bindingId: binding.bindingId,
            sessionId,
            turn: 0,
            endSeq: stamp,
            sourceSeqs: [latest.nativeSeq],
            inputRequestIds: [latest.requestId],
            anchorKey,
        }
        let sent = 0
        let held = 0
        let failed = 0
        for (let index = 0; index < allowed; index += 1) {
            if (closing) break
            const deliveryId = deliveryIdOf(base, index)
            const prepared = {
                ...base,
                partIndex: index,
                partCount: allowed,
                ...parts[index].kind === undefined ? {} : { kind: parts[index].kind },
                text: parts[index].text,
                state: 'prepared',
                receipt: null,
                errorCode: null,
                push: true,
                ...by === undefined ? {} : { by },
            }
            await putOutgoing(deliveryId, prepared)
            const outcome = await sendPiece(state, binding, null, deliveryId, prepared)
            if (outcome === 'held') {
                held += 1
                continue
            }
            if (outcome !== 'sent') {
                failed += 1
                continue
            }
            sent += 1
            // 平台确定没发出、改道发出的片：结果里写明，助手当场就知道不用重发。
            const row = readOutgoing(deliveryId)
            const via = row?.reroutedTo === undefined ? undefined : readBindingById(readOutgoing(row.reroutedTo)?.bindingId)?.platform
            if (via !== undefined) routeNotes.push(reroutedNoteOf(row, binding.platform, via))
        }
        reportPushed(binding, sessionId, stamp)
        await sendDetours(sessionId, routed.detours.map(({ note, ...detour }) => detour), { endSeq: stamp, push: true, ...by === undefined ? {} : { by } })
        for (const { deliveryId } of routed.detours) {
            if (readOutgoing(deliveryId)?.state === 'sent') sent += 1
            else failed += 1
        }
        return {
            status: 'sent',
            platform: binding.platform,
            sent,
            failed,
            unsent: parts.length - allowed + held,
            repliesLeft: repliesLeftOn(binding.platform, anchorKey, { own: true }),
            ...routeNotes.length > 0 ? { routed: routeNotes } : {},
        }
    }

    /**
     * 模型请求开始重试（断网、限流、服务端错误）时告诉对方一声：只在对方最近一条消息还没得到回答、也没说过这句时发，
     * 文字固定、不经模型。重试成功后的回复照常作为这条消息的回复发出。
     * @param {{ sessionId: string, code?: string }} request
     */
    async function noticeStall({ sessionId, code } = {}) {
        const text = STALL_NOTICES[code]
        if (text === undefined || !isNonEmptyString(sessionId)) return { status: 'skipped' }
        const picked = pickReplyAnchor(sessionScope(sessionId), { need: 2 })
        if (picked === null || answeredAnchor(picked.anchorKey)) return { status: 'skipped' }
        // 每条消息只说一次：同一锚点再次断网不重复。
        const key = `stall-${picked.anchorKey}`
        if (systemNoticeExists(key)) return { status: 'skipped' }
        if ((repliesLeftOn(picked.binding.platform, picked.anchorKey) ?? 2) < 2) return { status: 'unavailable', reason: 'NO_REPLIES_LEFT' }
        // 渠道自己的固定说明：带 system 标记，不算回答了这条消息，额度说明与“没人回”的检查照常看得到它还在等。
        const status = await sendSystem(picked.binding, text, { key, system: 'stall', anchor: picked.anchorKey })
        return { status, platform: picked.binding.platform }
    }

    /**
     * 不经模型告诉用户一句固定的话：经这个会话的渠道范围选路（对方最近在哪说话先用哪，现在发不了的换同一范围里能发的），
     * 借对方最近一条消息发出，给之后的回复留一次。同一 `key` 已经发过（不是失败）时不再发。
     * @returns `{ status: 'sent'|'failed', platform }` 或 `{ status: 'skipped'|'unavailable', reason }`
     */
    async function noticeUser({ sessionId, key, text } = {}) {
        if (!isNonEmptyString(sessionId) || !isNonEmptyString(key) || !isNonEmptyString(text)) {
            throw new ChannelRuntimeError('INVALID_NOTICE', 'noticeUser 需要 sessionId、key 与 text')
        }
        if (closing) return { status: 'skipped', reason: 'CLOSED' }
        return serialize(`user-notice:${key}`, async () => {
            if (systemNoticeExists(key)) return { status: 'skipped', reason: 'DUPLICATE' }
            const bindings = sessionScope(sessionId)
            if (bindings.length === 0) return { status: 'unavailable', reason: 'NOT_BOUND' }
            // 同中枢的回复：按配置的先后（`replyOrder`）；没走第一位时按 `rerouteNote` 开头注明。
            const picked = pickReplyAnchor(bindings, { need: 2, prefer: config.replyOrder })
            if (picked === null) return { status: 'unavailable', reason: 'NO_REPLY_ANCHOR' }
            if ((repliesLeftOn(picked.binding.platform, picked.anchorKey) ?? 2) < 2) return { status: 'unavailable', reason: 'NO_REPLIES_LEFT' }
            const note = rerouteNote(picked.binding)
            const status = await sendSystem(picked.binding, note === null ? text : `${note}\n${text}`, { key, system: 'quota', anchor: picked.anchorKey })
            return { status, platform: picked.binding.platform }
        })
    }

    /**
     * 对方这条消息有没有得到回答（法）：只认模型回这条消息的那一轮的回复批——锚定这条消息、这一批的输入里有对方的话
     * （真实消息或等待提醒，不是转交）、没有失败、不是还留着没发的片。渠道自己的固定说明（`system`：等待重试、额度、掉线告警、
     * 群与任务进度）、中途发送、等待标记、中枢没有渠道输入那几轮的回复（`mainTurn`）都不算；整条写了不发标记的一轮
     * 没有记录，也不算。
     */
    function answeredAnchor(anchorKey) {
        const own = new Set(readIncomingRows()
            .filter(row => isNonEmptyString(row.requestId) && !row.platformMessageId.startsWith(RELAY_ID_PREFIX))
            .map(row => row.requestId))
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            const row = parsed.data
            if (row.anchorKey !== anchorKey || (row.state === 'failed' && !deliveredRow(row))) continue
            if (row.system !== undefined || row.push === true || row.mainTurn === true || row.kind === 'wait') continue
            if (row.deferred === true && row.state === 'prepared') continue
            if (row.inputRequestIds.some(id => own.has(id))) return true
        }
        return false
    }

    /** 一个会话的绑定里，对方最近一条还没得到回复的真实消息：`{ binding, latest, anchorKey }`，没有时为空数组。 */
    function waitingInputs(sessionId) {
        return sessionBindings(sessionId)
            .map(binding => ({ binding, latest: latestRealInput(binding) }))
            .filter(({ latest }) => latest !== undefined)
            .map(item => ({ ...item, anchorKey: item.latest.replyAnchorKey ?? item.latest.anchorKey }))
            .filter(({ anchorKey }) => !answeredAnchor(anchorKey))
    }

    /** 这次额度用完已经说到的范围。 */
    function quotaScopesSaid(outageId) {
        const said = new Set()
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success || parsed.data.system !== 'quota') continue
            if (parsed.data.state === 'failed' || parsed.data.state === 'prepared') continue
            const key = parsed.data.inputRequestIds[0].slice(SYSTEM_ANCHOR_ID.length + 1)
            for (const scope of scopesOfKey(key, outageId) ?? []) said.add(scope)
        }
        return said
    }

    /**
     * 额度用完与用量提前提醒，不经模型。由额度闸门变化、`USAGE_LIMIT` 失败的一轮结束与定时检查调用，可以重复调用：
     * 每次额度用完、每个范围只说一次（中枢私聊为一个范围，每个群各一个；群的不在群里说，私聊告诉用户、列出群）；
     * 用量过了某一档时每个窗口每档一次。休息时段里：撞上额度用完的是用户自己刚说的话时照样说，其余等时段结束。
     * @param request.quota - 执行方额度闸门的现状。
     */
    async function sweepQuota({ quota } = {}) {
        // 不给现状就现读（插件入口在一轮以错误结束、和定时器上这样调）；给了就照它判（测试按这份现状核对说法）。
        if (quota === undefined) quota = await quotaView()
        if (closing || !isRecord(quota)) return { sent: [] }
        const options = config.quotaNotices
        const now = config.now()
        const quiet = host.core.quietHours.inQuiet(now)
        const main = [...hubSessions()][0]
        const sent = []
        if (main === undefined) return { sent }
        if (quota.state === 'limited' && isNonEmptyString(quota.outageId)) {
            const said = quotaScopesSaid(quota.outageId)
            const fresh = new Map()
            for (const sessionId of Object.keys(quota.backlog ?? {})) {
                for (const { binding, latest } of waitingInputs(sessionId)) {
                    const group = isGroupBinding(binding)
                    const scope = group ? binding.bindingId : 'main'
                    if (said.has(scope)) continue
                    const name = group ? binding.groupName ?? binding.conversationId.slice(GROUP_PREFIX.length) : null
                    const previous = fresh.get(scope)
                    fresh.set(scope, { group, name, at: Math.max(previous?.at ?? 0, latest.createdAt) })
                }
            }
            const userHit = [...fresh.values()].some(item => item.at >= (quota.since ?? now) - options.userHitMs)
            if (fresh.size > 0 && (!quiet || userHit)) {
                const groups = [...fresh.values()].filter(item => item.group).map(item => item.name)
                const text = quotaNoticeText(quota, { main: fresh.has('main'), groups }, now, host.core.timezone)
                const result = await noticeUser({ sessionId: main, key: quotaKey(quota.outageId, fresh.keys()), text })
                sent.push({ kind: 'quota', ...result })
            }
        }
        if (!quiet) {
            for (const type of options.usageWarnWindows) {
                const window = quota.windows?.[type]
                if (window === undefined || typeof window.resetsAt !== 'number' || window.resetsAt <= now) continue
                // 这个窗口已经用完、正在停用：额度用完的说明已经说了，不再报用量。
                if (quota.state === 'limited' && quota.window === type) continue
                const level = warningLevel(type, window, options.usageWarnLevels, systemNoticeExists)
                if (level === undefined) continue
                const result = await noticeUser({ sessionId: main, key: usageKey(type, window.resetsAt, level), text: usageWarningText(type, window, level, now, host.core.timezone) })
                sent.push({ kind: 'usage', window: type, level, ...result })
            }
        }
        return { sent }
    }

    /**
     * 额度现状：状态和补充的字段问框架核心（`core.quota.detail(中枢)`，按中枢的执行方作答，渠道不认具体执行方）；
     * 哪些会话撞了额度、还有没答复的输入，从日志现推：接着渠道的会话最后一轮以错误结束，而这个错误码是那个会话的执行方
     * 额度闸门管的（`core.executors.gatedFailure`）。
     * @returns `{ state, since, resetsAt, window, outageId, windows, backlog: { <会话>: { at } } }`；没有中枢时为 null。
     */
    async function quotaView() {
        const hub = hubSessionId()
        if (hub === null) return null
        const detail = await host.core.quota.detail(hub)
        const backlog = {}
        for (const { sessionId } of exitSessions()) {
            const end = await lastTurnEnd(sessionId)
            if (end === null || !end.failed || !isNonEmptyString(end.code)) continue
            if (await host.core.executors.gatedFailure(sessionId, end.code)) backlog[sessionId] = { at: end.at }
        }
        return { ...detail, backlog }
    }

    /** 会话最后结束的一轮：`{ failed, code, at }`；读不出或还没有时为 `null`。 */
    async function lastTurnEnd(sessionId) {
        let observation
        try {
            observation = await host.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal: lifecycle.signal })
            const events = Array.isArray(observation?.events) ? observation.events : []
            for (let index = events.length - 1; index >= 0; index -= 1) {
                const event = events[index]
                if (event?.type === 'turn/start') return null
                if (event?.type !== 'turn/end') continue
                const reason = event.data?.reason
                return { failed: reason?.kind === 'error', code: reason?.error?.code ?? null, at: event.time ?? null }
            }
            return null
        } catch {
            return null
        } finally {
            if (observation !== undefined) disposeObservation(observation)
        }
    }


    /* ---------------------------- 配对 ---------------------------- */

    function rejectVerify(attempt) {
        const entry = attempt.verify
        attempt.verify = null
        if (entry === null) return
        entry.cleanup?.()
        entry.reject(new ChannelRuntimeError('ATTEMPT_CANCELLED', '配对尝试已取消'))
    }

    /** 本次尝试仍是当前尝试：未 settled、未 abort、运行态未关闭。 */
    function attemptIsCurrent(state, attempt) {
        return !closing
            && state.attempt === attempt
            && attempt.settled !== true
            && !attempt.controller.signal.aborted
    }

    /**
     * 只停用这条精确的新 bindingId：在真实写槽里比对 current.bindingId，排队期间被新配对
     * 覆盖时看到的是新记录并原样保持，不动旧授权。key 已不在时按“已无目标”处理；
     * 其它持久失败明确上抛，不能吞掉后宣称取消已持久。
     */
    async function disableStoredBinding(platform, bindingId) {
        try {
            await updateBindingExact(platform, bindingId, current => (
                current.enabled === false ? current : { ...current, enabled: false }
            ))
        } catch (error) {
            throw new ChannelRuntimeError('BINDING_DISABLE_FAILED', '无法停用已取消的绑定', { cause: error })
        }
    }

    /** 取消提交后已落盘的本次 binding：停止其连接/helper，并停用精确 bindingId。 */
    async function cleanupCancelledCommit(state, bindingId) {
        if (state.listener !== null && state.listener.bindingId === bindingId) await stopListener(state)
        if (state.activeBindingId === bindingId) state.activeBindingId = null
        await closeIngress(bindingId)
        await disableStoredBinding(state.platform, bindingId)
    }

    /**
     * 立即废弃当前尝试：旧回调不能再改运行态。已开始提交的精确 binding 由返回的
     * cleanup 只停用该 bindingId，绝不覆盖后来的新 binding 或改动旧授权。
     */
    function cancelAttempt(state) {
        const attempt = state.attempt
        if (attempt === null) return Promise.resolve()
        state.attempt = null
        attempt.settled = true
        attempt.controller.abort()
        rejectVerify(attempt)
        const bindingId = attempt.bindingId
        if (bindingId === null) return Promise.resolve()
        return track(cleanupCancelledCommit(state, bindingId))
    }

    function requestVerifyCode(state, attempt, signal) {
        if (state.attempt !== attempt || attempt.settled) {
            return Promise.reject(new ChannelRuntimeError('ATTEMPT_NOT_FOUND', '配对尝试已失效'))
        }
        if (attempt.verify !== null) {
            return Promise.reject(new ChannelRuntimeError('CODE_NOT_EXPECTED', '当前配对尝试已在等待验证码'))
        }
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, cleanup: undefined }
            attempt.verify = entry
            if (isRecord(signal) && typeof signal.addEventListener === 'function') {
                const onAbort = () => {
                    if (attempt.verify !== entry) return
                    attempt.verify = null
                    reject(abortError())
                }
                signal.addEventListener('abort', onAbort, { once: true })
                entry.cleanup = () => signal.removeEventListener('abort', onAbort)
                if (signal.aborted) onAbort()
            }
        })
    }

    /**
     * 真实 pair 返回的账户：先生成新 bindingId，再持久只属于它的 grant，最后才持久
     * binding 并连接。putBinding 失败时旧 binding/旧 grant 原样保留；每个 await 之后
     * 都核对尝试仍有效，取消后不开始新 listen。
     */
    async function adoptPairedAccount(state, attempt, account) {
        // 私聊绑到中枢：渠道不再自己建中枢。扫码期间中枢被清掉时这次配对失败，写明原因。
        const hub = hubSessionId()
        if (hub === null) {
            reportNoHub('私聊配对没有完成')
            throw new ChannelRuntimeError('NO_HUB', '还没有中枢会话，先在 DSH 里建一个、定成中枢再配对')
        }
        if (!attemptIsCurrent(state, attempt)) return 'cancelled'
        const platform = state.platform
        const previous = readBinding(platform)
        const bindingId = randomUUID()
        // 私聊 peer 就是本人 senderId：pair 不返回会话 id，绑定据此固定会话。
        const conversationId = account.senderId
        const key = accountCredentialKey(platform, account.accountId, bindingId)
        const binding = {
            platform,
            bindingId,
            accountId: account.accountId,
            senderId: account.senderId,
            conversationId,
            // 只作记录（配对时的中枢）：读绑定时私聊的会话按现在的中枢现算。
            sessionId: hub,
            credentialKey: key,
            enabled: true,
            createdAt: config.now(),
        }
        await writeGrant(key, {
            bindingId,
            platform,
            accountId: account.accountId,
            senderId: account.senderId,
            conversationId,
            credential: account.credential,
        })
        if (!attemptIsCurrent(state, attempt)) {
            await deleteGrantQuietly(key)
            return 'cancelled'
        }
        try {
            await putBinding(binding)
        } catch (error) {
            // binding 未落盘：旧授权仍指向旧 grant，新 grant 只是孤立记录。
            await deleteGrantQuietly(key)
            throw error
        }
        // 从这一刻起，取消只能停用这条 exact bindingId。
        attempt.bindingId = bindingId
        if (!attemptIsCurrent(state, attempt)) {
            await disableStoredBinding(platform, bindingId)
            // 被替换的旧连接不再代表任何已保存 binding：只停这一条，不碰更新的尝试。
            if (previous !== null
                && state.listener !== null
                && state.listener.bindingId === previous.bindingId) {
                await stopListener(state)
                await closeIngress(previous.bindingId)
                if (state.activeBindingId === previous.bindingId) state.activeBindingId = null
            }
            return 'cancelled'
        }
        await stopListener(state)
        if (!attemptIsCurrent(state, attempt)) {
            await disableStoredBinding(platform, bindingId)
            return 'cancelled'
        }
        if (state.activeBindingId !== null && state.activeBindingId !== bindingId) {
            await closeIngress(state.activeBindingId)
        }
        if (!attemptIsCurrent(state, attempt)) {
            await disableStoredBinding(platform, bindingId)
            return 'cancelled'
        }
        state.activeBindingId = bindingId
        // 新 binding 成功后才清理旧 grant；旧 incoming/outgoing 留在原 bindingId。
        if (previous !== null && previous.credentialKey !== key) {
            await deleteGrantQuietly(previous.credentialKey)
        }
        if (!attemptIsCurrent(state, attempt)) {
            await disableStoredBinding(platform, bindingId)
            return 'cancelled'
        }
        state.retryCount = 0
        state.phase = 'connecting'
        state.errorCode = null
        await ensureConnected(state, binding, () => attemptIsCurrent(state, attempt))
        if (!attemptIsCurrent(state, attempt)) {
            await disableStoredBinding(platform, bindingId)
            return 'cancelled'
        }
        return 'committed'
    }

    /**
     * 等一次配对保存，最多 `pairCommitTimeoutMs`：超时就结束这次尝试（之后晚到的保存按已取消处理，只停用它自己写下的
     * 那条 bindingId）并报 PAIR_SAVE_TIMEOUT，尝试不会一直挂着。它在 `pair:<平台>` 串行链里面计时，超时同时放开这条链，
     * 之后的配对与断开不会排在卡住的保存后面。
     */
    function commitWithin(attempt, commit) {
        let timer
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                attempt.settled = true
                reject(new ChannelRuntimeError('PAIR_SAVE_TIMEOUT', '配对保存超时'))
            }, config.pairCommitTimeoutMs)
            timer.unref?.()
        })
        commit.catch(() => {})
        return Promise.race([commit, timeout]).finally(() => clearTimeout(timer))
    }

    async function settlePair(state, attempt, rawResults) {
        if (state.attempt !== attempt || attempt.settled) return
        if (!Array.isArray(rawResults)) {
            throw new ChannelRuntimeError('PAIR_RESULT_INVALID', 'pair 未返回账户数组')
        }
        const accounts = []
        const seen = new Map()
        for (const item of rawResults) {
            if (!isRecord(item)) throw new ChannelRuntimeError('PAIR_RESULT_INVALID', 'pair 返回项不是对象')
            if (item.platform !== state.platform) throw new ChannelRuntimeError('PAIR_RESULT_INVALID', 'pair 返回项平台不一致')
            if (!isNonEmptyString(item.accountId) || !isNonEmptyString(item.senderId)) {
                throw new ChannelRuntimeError('OWNER_UNVERIFIED', 'pair 未返回可信本人身份')
            }
            if (!isCredentialValue(item.credential)) {
                throw new ChannelRuntimeError('PAIR_RESULT_INVALID', 'pair 未返回可用凭据')
            }
            const previous = seen.get(item.accountId)
            if (previous !== undefined && previous !== item.senderId) {
                throw new ChannelRuntimeError('OWNER_UNVERIFIED', '同一账户出现多个本人身份')
            }
            if (previous !== undefined) continue
            seen.set(item.accountId, item.senderId)
            accounts.push({ accountId: item.accountId, senderId: item.senderId, credential: item.credential })
        }
        if (accounts.length === 0) {
            if (state.attempt === attempt) {
                state.attempt = null
                attempt.settled = true
                state.phase = 'error'
                state.errorCode = 'NO_OWNER_ACCOUNT'
            }
            return
        }
        if (accounts.length > 1) {
            if (state.attempt !== attempt || attempt.settled) return
            attempt.state = 'choose-account'
            attempt.results = accounts
            state.phase = 'choose-account'
            state.errorCode = null
            return
        }
        // 单账户：保留并传入原 attempt 身份直到提交结束；同平台提交走同一串行链。
        try {
            const outcome = await serialize(
                `pair:${state.platform}`,
                () => commitWithin(attempt, adoptPairedAccount(state, attempt, accounts[0])),
            )
            if (outcome === 'committed' && state.attempt === attempt) {
                state.attempt = null
                attempt.settled = true
            }
        } catch (error) {
            if (attempt.controller.signal.aborted || state.attempt !== attempt) return
            state.attempt = null
            attempt.settled = true
            setError(state, stableErrorCode(error, 'PAIR_SAVE_FAILED'))
        }
    }

    /**
     * 配对准备：先废弃旧尝试，再登记新尝试。这个 await 窗口内 close 可能已做完资源
     * 快照，关闭开始或已被更新的请求取代后绝不登记新长生命周期 promise。
     */
    async function beginPairTask(state, platform, generation) {
        // 立即废弃旧尝试：旧回调（QR/状态/验证码/结果）不能再改运行态。
        await cancelAttempt(state)
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭，拒绝配对')
        if (generation !== pairGeneration) fail('ATTEMPT_CANCELLED', '配对尝试已被更新的请求取代')
        const attempt = {
            attemptId: randomUUID(),
            controller: new AbortController(),
            qrText: null,
            qrRevision: 0,
            state: 'pairing',
            results: null,
            verify: null,
            settled: false,
            scanned: false,
            bindingId: null,
            promise: null,
        }
        state.attempt = attempt
        state.phase = 'pairing'
        state.errorCode = null
        const platformObject = config.platforms[platform]
        attempt.promise = (async () => {
            try {
                const results = await platformObject.pair({
                    signal: attempt.controller.signal,
                    onQr: text => {
                        if (state.attempt !== attempt || attempt.settled) return
                        if (!isNonEmptyString(text)) return
                        // 只有内容真正变化才递增版本，UI 据此换图。
                        if (attempt.qrText === text) return
                        attempt.qrRevision += 1
                        attempt.qrText = text
                    },
                    onState: progress => {
                        if (state.attempt !== attempt || attempt.settled) return
                        // 只认可信枚举：扫码完成；其它平台私有文本不进公开状态。
                        if (progress === 'scaned' || progress === 'scanned') attempt.scanned = true
                    },
                    getVerifyCode: ({ signal } = {}) => requestVerifyCode(state, attempt, signal),
                })
                await settlePair(state, attempt, results)
            } catch (error) {
                if (state.attempt !== attempt) return
                state.attempt = null
                attempt.settled = true
                setError(state, stableErrorCode(error, 'PAIR_FAILED'))
            } finally {
                rejectVerify(attempt)
            }
        })()
        track(attempt.promise)
        // 立即返回，等待扫码在后台进行。
        return { attemptId: attempt.attemptId }
    }

    async function beginPair(platform) {
        requirePlatform(platform)
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭，拒绝配对')
        // 私聊配对绑到中枢：还没有中枢就不开始（不出二维码），写明原因并报一次。
        if (hubSessionId() === null) {
            reportNoHub('私聊配对被拒绝')
            return { refused: 'NO_HUB' }
        }
        const state = stateOf(platform)
        pairGeneration += 1
        // 准备段也纳入 track：close 先等它结束，之后才可能看到新尝试。
        return track(beginPairTask(state, platform, pairGeneration))
    }

    async function selectAccountTask(input) {
        const { platform, attemptId, accountId } = isRecord(input) ? input : {}
        requirePlatform(platform)
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭，拒绝选择账户')
        const state = stateOf(platform)
        const attempt = state.attempt
        if (attempt === null
            || attempt.attemptId !== attemptId
            || attempt.state !== 'choose-account'
            || attempt.settled) {
            fail('ATTEMPT_NOT_FOUND', '没有等待选择的配对尝试')
        }
        const chosen = Array.isArray(attempt.results)
            ? attempt.results.find(item => item.accountId === accountId)
            : undefined
        if (chosen === undefined) fail('ACCOUNT_NOT_SELECTED', 'accountId 不是当前尝试的可选项')
        // 保留 attempt 身份直到提交结束：期间 cancel/close 仍能作废本次提交。
        try {
            const outcome = await serialize(
                `pair:${platform}`,
                () => commitWithin(attempt, adoptPairedAccount(state, attempt, chosen)),
            )
            if (outcome === 'cancelled') fail('ATTEMPT_CANCELLED', '配对尝试已取消')
            if (state.attempt === attempt) {
                state.attempt = null
                attempt.settled = true
            }
        } catch (error) {
            if (attempt.controller.signal.aborted || state.attempt !== attempt) throw error
            state.attempt = null
            attempt.settled = true
            setError(state, stableErrorCode(error, 'PAIR_SAVE_FAILED'))
            throw error
        }
        return { status: 'selected' }
    }

    function selectAccount(input) {
        return track(selectAccountTask(input))
    }

    async function verifyCode(input) {
        const { platform, attemptId, code } = isRecord(input) ? input : {}
        requirePlatform(platform)
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭，拒绝提交验证码')
        const state = stateOf(platform)
        const attempt = state.attempt
        if (attempt === null || attempt.attemptId !== attemptId || attempt.settled) {
            fail('ATTEMPT_NOT_FOUND', '没有匹配的配对尝试')
        }
        const entry = attempt.verify
        if (entry === null) fail('CODE_NOT_EXPECTED', '当前配对尝试未等待验证码')
        if (!isNonEmptyString(code)) fail('INVALID_CODE', '验证码必须是非空字符串')
        attempt.verify = null
        entry.cleanup?.()
        entry.resolve(code)
        return { status: 'submitted' }
    }

    async function cancelPairTask(input) {
        const { platform, attemptId } = isRecord(input) ? input : {}
        requirePlatform(platform)
        if (closing) return { status: 'closed' }
        const state = stateOf(platform)
        const attempt = state.attempt
        // 过期/未知尝试直接忽略，绝不改动更新的尝试。
        if (attempt === null || attempt.attemptId !== attemptId) return { status: 'stale' }
        const cleanup = cancelAttempt(state)
        await cleanup
        // 取消的是配对尝试，不是已就绪的原绑定连接：从真实 ready 派生阶段恢复。
        const binding = readBinding(platform)
        const stillReady = !closing && binding !== null && binding.enabled === true
            && hasReadyListener(state, binding)
        state.phase = stillReady ? 'connected' : 'idle'
        state.errorCode = null
        if (!closing) requestWakeSafely()
        return { status: 'cancelled' }
    }

    function cancelPair(input) {
        return track(cancelPairTask(input))
    }

    /**
     * 断开：先同步作废当前尝试（旧回调/旧提交立即失效），再把绑定写入、凭据释放与状态收尾
     * 排进同平台 pair 链，与 adopt 的提交按同一条链收敛：并发的旧提交或后来的新配对都不会
     * 被这次删除越位覆盖。cleanup 不属于这条链，等在链内排空，不在自己持有的链上自等。
     */
    async function disconnectTask(platform) {
        requirePlatform(platform)
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭，拒绝断开')
        const state = stateOf(platform)
        // 同步作废：cleanup 的 await 放到链内，链位在调用时就已排定。
        const cleanup = cancelAttempt(state)
        return serialize(`pair:${platform}`, async () => {
            await cleanup
            await stopListener(state)
            const binding = readBinding(platform)
            if (binding !== null) {
                // 挂在它上面的群绑定一起删：断开就是这个账号整个不再收发，重新配对后群要重新绑定。
                // 已解绑的行也删：重新配对后不再有“解绑过”的记录，群里再说话按群名或工具重新接。
                for (const group of groupRowsOf(binding)) {
                    await tables.bindings.delete(groupBindingKey(platform, group.conversationId))
                    await closeIngress(group.bindingId)
                }
                // 先删绑定再删凭据：重启不会留下“有绑定无凭据”的半状态。
                await tables.bindings.delete(platform)
                await closeIngress(binding.bindingId)
                if (state.activeBindingId === binding.bindingId) state.activeBindingId = null
                await deleteGrantQuietly(binding.credentialKey)
            } else if (hasBindingRow(platform)) {
                // 形状不可用的绑定行也一并清掉，避免重启后反复落入 BINDING_INVALID。
                await tables.bindings.delete(platform)
            }
            state.phase = 'idle'
            state.errorCode = null
            state.retryCount = 0
            return { status: 'disconnected' }
        })
    }

    function disconnect(platform) {
        return track(disconnectTask(platform))
    }

    /**
     * 让一个已绑定的平台重连一次（Watchdog）：停掉当前连接与退避、清零重试次数，再请求一次对账，由对账照常连上。
     * 排在同平台的配对链上，不与配对、断开交错；配对进行中或没有启用的绑定时不动。不等连上：结果看之后的状态。
     * @returns `{ status: 'reconnecting' | 'pairing' | 'unbound' | 'closed' }`
     */
    async function reconnectTask(platform) {
        requirePlatform(platform)
        if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭，拒绝重连')
        const state = stateOf(platform)
        return serialize(`pair:${platform}`, async () => {
            if (closing) return { status: 'closed' }
            if (state.attempt !== null) return { status: 'pairing' }
            const binding = readBinding(platform)
            if (binding === null || binding.enabled !== true) return { status: 'unbound' }
            await stopListener(state)
            if (closing) return { status: 'closed' }
            state.retryCount = 0
            requestWakeSafely()
            return { status: 'reconnecting' }
        })
    }

    function reconnect(platform) {
        return track(reconnectTask(platform))
    }

    /* ---------------------------- 自查 ---------------------------- */

    /** 报一条异常；报的一方出错不影响渠道。 */
    function reportSafely(kind, detail) {
        if (config.report === null) return
        try {
            config.report(kind, detail)
        } catch {
            // 核心的 report 本身不抛错；这里只防装配错的替身。
        }
    }

    /**
     * 各平台的断开情况（只在内存里，重启后重新数）：`streak` 连续几次不是"已连接"，`reported` 这一次断开报过没有。
     * `reported` 为 null 表示这次启动以后还没看过：重启前可能报过，第一次看到已连接时也报一次"好了"，让 Watchdog 关掉旧的那条。
     */
    const healthOf = new Map()
    /** 报过"没送到"的绑定：绑定 → 报的时候那几片（变了就再报一次）；null 表示这次启动以后还没看过。 */
    let undeliveredReported = null

    /**
     * 自查（原来 Watchdog 读渠道的状态做的）：
     * - 已绑定的平台连续 `downChecks` 次不是"已连接"（配对、扫码中不算）：自己重连一次，报 `channels/down`（subject 是平台）；
     *   恢复以后报一条 `resolved`。
     * - 回复没送到、只能等对方下一条消息才告诉会话、超过 `undeliveredGraceMs` 的：每个绑定报一条 `channels/undelivered`
     *   （subject 是绑定），没送到的片变了再报；告诉会话以后报 `resolved`。
     * 由插件入口按定时器调。
     */
    async function checkHealth() {
        if (closing || config.report === null) return
        for (const platform of platformIds()) {
            if (config.platforms[platform] === undefined) continue
            const view = channelView(platform)
            const label = labelOf(platform)
            const health = healthOf.get(platform) ?? { streak: 0, reported: null }
            const down = view.accountId !== null && view.phase !== 'connected' && view.phase !== 'closed' && !PAIRING_PHASES.has(view.phase)
            if (!down) {
                if (health.reported !== false) {
                    reportSafely(CHANNEL_REPORTS.down, { text: `消息渠道 ${label} 没有断开`, data: { subject: platform, resolved: true } })
                }
                healthOf.set(platform, { streak: 0, reported: false })
                continue
            }
            health.streak += 1
            if (health.streak >= config.downChecks && health.reported !== true) {
                let action
                try {
                    action = RECONNECT_WORDS[(await reconnect(platform)).status] ?? '已重连一次'
                } catch (error) {
                    action = `重连没成（${error?.code ?? error?.message ?? error}）`
                }
                reportSafely(CHANNEL_REPORTS.down, {
                    text: `消息渠道 ${label} 不是已连接（${view.phase}${view.errorCode ? `，${view.errorCode}` : ''}），连续 ${health.streak} 次；${action}`,
                    data: { subject: platform, phase: view.phase, errorCode: view.errorCode ?? null },
                })
                health.reported = true
            }
            healthOf.set(platform, health)
        }
        const current = new Map(undelivered({ olderThanMs: config.undeliveredGraceMs }).map(entry => [entry.bindingId, entry]))
        const before = undeliveredReported
        undeliveredReported = new Map()
        for (const [bindingId, entry] of current) {
            const signature = entry.items.map(item => `${item.failedAt}:${item.what}`).join('|')
            undeliveredReported.set(bindingId, signature)
            if (before?.get(bindingId) === signature) continue
            const platform = labelOf(entry.platform)
            const where = entry.main ? `中枢（${platform}私聊）` : entry.group ? `群「${entry.groupName}」接的会话（${platform}）` : `会话（${platform}）`
            const items = entry.items.map(item => `${item.what}「${item.excerpt}…」（${item.unknown ? '结果不明' : '确定没送到'}）`)
            const next = entry.main ? '可以经别的现在能送达的渠道告诉用户（主动联系）' : entry.group ? '群会话，不跨渠道，只记下' : '只记下'
            reportSafely(CHANNEL_REPORTS.undelivered, {
                sessionId: entry.sessionId,
                text: [
                    `回复没送到 · ${where}：${items.join('；')}`,
                    entry.guarded ? '立即补告那一轮的回复也没送到，不再自动开轮' : '现在不能主动补发',
                    `等对方下一条消息时告诉会话；${next}`,
                ].join('。'),
                data: { subject: bindingId },
            })
        }
        // 告诉了会话的（不在名单里了）：报"好了"。刚启动时不知道重启前报过哪些，名单外的已启用绑定都报一次。
        const cleared = before === null
            ? [...readEntries(tables.bindings)].map(([, raw]) => parseBinding(raw)).filter(parsed => parsed.success).map(parsed => parsed.data.bindingId)
            : [...before.keys()]
        for (const bindingId of cleared) {
            if (current.has(bindingId)) continue
            reportSafely(CHANNEL_REPORTS.undelivered, { text: '没送到的回复已经告诉会话了', data: { subject: bindingId, resolved: true } })
        }
    }

    /* ---------------------------- 公开查询 ---------------------------- */

    function requirePlatform(platform) {
        if (typeof platform !== 'string' || !PLATFORM_ID.test(platform)) {
            fail('UNKNOWN_PLATFORM', '未知平台')
        }
        if (config.platforms[platform] === undefined) {
            fail('UNKNOWN_PLATFORM', '该平台未装配')
        }
        return platform
    }

    function countUnknownForBinding(bindingId) {
        if (bindingId === null) return 0
        let count = 0
        for (const [, raw] of readEntries(tables.outgoing)) {
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            if (parsed.data.bindingId !== bindingId) continue
            if (parsed.data.state === 'unknown') count += 1
        }
        return count
    }

    /** 配对尝试的 UI 可操作进度：验证码 > 扫码完成 > 已有 QR > 等待扫码。 */
    function attemptProgress(attempt) {
        if (attempt.state === 'choose-account') return 'choose-account'
        if (attempt.verify !== null) return 'need-verify'
        if (attempt.scanned === true) return 'scanned'
        if (isNonEmptyString(attempt.qrText)) return 'waiting'
        return 'pairing'
    }

    /** UI 投影：只给身份、进度、计数，不给 QR 明文、凭据或 token。 */
    function channelView(platform) {
        const state = stateOf(platform)
        const binding = readBinding(platform)
        const attempt = state.attempt === null || state.attempt.settled ? null : state.attempt
        const connected = binding !== null && binding.enabled === true && hasReadyListener(state, binding)
            && state.listener.live !== false
        let phase
        if (closing) {
            phase = 'closed'
        } else if (attempt !== null) {
            phase = attemptProgress(attempt)
        } else if (connected) {
            phase = 'connected'
        } else if (state.phase === 'connected' || state.phase === 'connecting') {
            phase = 'connecting'
        } else if (state.phase === 'error') {
            phase = 'error'
        } else {
            phase = 'idle'
        }
        const choices = phase === 'choose-account' && Array.isArray(attempt.results)
            ? attempt.results.map(item => ({ accountId: item.accountId, senderId: item.senderId }))
            : []
        const descriptor = descriptors.get(platform)
        return {
            platform,
            // 渠道名（字符串或 `{ zh, en }`）与配对提示：登记的平台照登记时给的；内置平台由设置页自己写。
            label: descriptor?.label ?? labelOf(platform),
            hints: descriptor?.hints ?? null,
            builtin: BUILTIN_PLATFORMS.includes(platform),
            phase,
            connected,
            accountId: binding === null ? null : binding.accountId,
            senderId: binding === null ? null : binding.senderId,
            pairAttemptId: attempt === null ? null : attempt.attemptId,
            qrRevision: attempt === null ? 0 : attempt.qrRevision,
            choices,
            errorCode: state.errorCode,
            unknownCount: countUnknownForBinding(binding === null ? null : binding.bindingId),
            // 支持群的平台：已接的群（只列启用的）：群号、群名（绑定时的名字）、会话标题与 id，会话不在了时注明原因。
            ...typeof config.platforms[platform]?.groupList === 'function' ? {
                groups: binding === null || binding.enabled !== true ? [] : groupBindingsOf(binding).map(group => ({
                    groupId: group.conversationId.slice(GROUP_PREFIX.length),
                    name: group.groupName ?? group.conversationId.slice(GROUP_PREFIX.length),
                    session: sessionTitleOf(group),
                    sessionId: group.sessionId,
                    gone: group.gone?.sessionId === group.sessionId ? group.gone.reason : null,
                })),
            } : {},
        }
    }

    function status() {
        const channels = []
        for (const platform of platformIds()) {
            if (config.platforms[platform] === undefined) continue
            channels.push(channelView(platform))
        }
        const counts = {
            bindings: 0,
            incoming: { queued: 0, accepted: 0, unknown: 0, conflict: 0 },
            outgoing: { prepared: 0, sending: 0, sent: 0, failed: 0, unknown: 0 },
        }
        for (const [, raw] of readEntries(tables.bindings)) {
            if (isRecord(raw) && raw.enabled === true) counts.bindings += 1
        }
        for (const [, raw] of readEntries(tables.incoming)) {
            if (!isRecord(raw) || typeof raw.state !== 'string') continue
            if (Object.hasOwn(counts.incoming, raw.state)) counts.incoming[raw.state] += 1
        }
        for (const [, raw] of readEntries(tables.outgoing)) {
            if (!isRecord(raw) || typeof raw.state !== 'string') continue
            if (Object.hasOwn(counts.outgoing, raw.state)) counts.outgoing[raw.state] += 1
        }
        let phase = 'idle'
        if (closing) {
            phase = 'closed'
        } else {
            const phases = channels.map(view => view.phase)
            if (phases.includes('connected')) phase = 'connected'
            else if (phases.includes('error')) phase = 'error'
            else if (phases.includes('choose-account')) phase = 'choose-account'
            else if (phases.includes('need-verify')) phase = 'need-verify'
            else if (phases.includes('scanned')) phase = 'scanned'
            else if (phases.includes('waiting')) phase = 'waiting'
            else if (phases.includes('pairing')) phase = 'pairing'
            else if (phases.includes('connecting')) phase = 'connecting'
        }
        return {
            phase,
            channels: Object.freeze(channels),
            counts: Object.freeze(counts),
        }
    }

    function qr(platform) {
        const state = stateOf(requirePlatform(platform))
        const attempt = state.attempt
        if (attempt === null || attempt.settled) return null
        return attempt.qrText
    }

    /* ---------------------------- 恢复与关闭 ---------------------------- */

    /** 进程重启后 sending 一律转 unknown：已调用但无回执的发送永不自动重发。 */
    async function recoverSendingDeliveries() {
        for (const [deliveryId, raw] of readEntries(tables.outgoing)) {
            if (!isRecord(raw) || raw.state !== 'sending') continue
            const parsed = outgoingSchema.safeParse(raw)
            if (!parsed.success) continue
            try {
                await tables.outgoing.put(deliveryId, {
                    ...parsed.data,
                    state: 'unknown',
                    receipt: null,
                    errorCode: 'PROCESS_INTERRUPTED',
                })
            } catch {
                return
            }
        }
    }

    async function runClose() {
        closing = true
        clearTimeout(mergeTimer)
        clearTimeout(waitTimer)
        clearTimeout(busyTimer?.timer)
        clearTimeout(quietTimer?.timer)
        for (const state of platformStates.values()) clearTimeout(state.alarmTimer)
        reconcileRequested = false
        lifecycle.abort(new ChannelRuntimeError('RUNTIME_CLOSED', '渠道运行态已关闭'))
        // 1) 先发平台 listen / 退避的 abort，并启动所有自有 helper 的 close（停止新准入）。
        const listeners = []
        for (const state of platformStates.values()) {
            if (state.retry !== null) {
                state.retry.controller.abort()
                state.retry = null
            }
            const listener = state.listener
            if (listener !== null) {
                listener.controller.abort()
                listeners.push(listener.promise)
            }
        }
        const attemptCleanups = []
        for (const state of platformStates.values()) attemptCleanups.push(cancelAttempt(state))
        const ingressCloses = [...ingresses.keys()].map(bindingId => closeIngress(bindingId))
        // 2) 再等 helper（其 close 会 abort 被阻塞的准入）、listen 排空与在途晚 send。
        await Promise.allSettled(attemptCleanups)
        await Promise.allSettled(ingressCloses)
        await Promise.allSettled(listeners)
        while (inflight.size > 0) {
            await Promise.allSettled([...inflight])
        }
        for (const state of platformStates.values()) {
            state.listener = null
            state.phase = 'closed'
            state.errorCode = null
        }
    }

    function close() {
        closePromise ??= runClose()
        return closePromise
    }

    await recoverSendingDeliveries()
    // 只有存在已启用 binding 时这次 wake 才会读取中枢并开始 listen。
    requestWakeSafely()

    return Object.freeze({
        status,
        qr,
        beginPair,
        verifyCode,
        selectAccount,
        cancelPair,
        disconnect,
        reconnect,
        wake,
        close,
        push,
        noticeStall,
        noticeUser,
        sweepQuota,
        markSessionBusy,
        listGroups,
        bindGroup,
        unbindGroup,
        /**
         * 设群解析规则：群第一次说话、还没接会话时，渠道用 `{ platform, groupId, groupName }` 问它要接哪个会话。
         * 规则返回 `{ sessionId, sessionTitle? }` 就接上；返回 `{ reason }`（说明文字）或 `null` 就不接，渠道把原因告诉中枢，
         * 由中枢问用户后用工具绑定；抛错表示这次查不了，群消息稍后重送再问。会话打不开、已经接了别的群时照样不接。
         * 已有规则时再设会报错，不静默顶掉。
         * @returns 撤销函数。
         */
        /**
         * 登记一个平台（README“接新平台”）。`platform` 是适配器（至少 pair、listen、send；能力字段见 README），`label` 是
         * 对方看到的渠道名（字符串，或 `{ zh, en }`），`hints` 是设置页配对时的提示（可选，`{ zh: { waiting, needVerify }, en: … }`）。
         * 平台名已经装着、或已经有一个支持群的平台时报错。返回撤销函数：停掉它的连接并撤下，绑定照旧留着，下次登记同名平台接着用。
         */
        registerPlatform({ id, label, platform, hints } = {}) {
            if (closing) fail('RUNTIME_CLOSED', '渠道运行态已关闭')
            if (typeof id !== 'string') fail('INVALID_OPTIONS', '平台要有名字 id')
            checkPlatform(id, platform)
            if (config.platforms[id] !== undefined) fail('INVALID_OPTIONS', `平台 ${id} 已经装着了`)
            const zh = typeof label === 'string' ? label : label?.zh
            if (!isNonEmptyString(zh)) fail('INVALID_OPTIONS', `平台 ${id} 要有 label`)
            const groups = groupPlatform()
            if (typeof platform.groupList === 'function' && groups !== null) fail('INVALID_OPTIONS', `已经有支持群的平台 ${groups}，这一版只能有一个`)
            config.platforms[id] = platform
            labels.set(id, zh)
            descriptors.set(id, { label, hints: hints ?? null })
            stateOf(id)
            requestWakeSafely()
            return () => {
                if (config.platforms[id] !== platform) return
                delete config.platforms[id]
                descriptors.delete(id)
                const state = stateOf(id)
                clearDown(state)
                track((async () => {
                    await cancelAttempt(state)
                    await stopListener(state)
                })()).catch(() => {})
            }
        },
        /** 对方看到的渠道名（登记的平台用登记时给的）。 */
        labelOf,
        /** 支持群的平台的渠道名；没有时为 null。 */
        groupLabel: () => {
            const platform = groupPlatform()
            return platform === null ? null : labelOf(platform)
        },
        /** 语音发到这个平台时的说法：能力里没有语音的按音频文件发。 */
        voiceWord: platform => `${labelOf(platform)}${config.platforms[platform]?.sends?.includes('voice') === true ? '' : '（音频文件）'}`,
        /** 中枢发到手机时渠道的先后（渠道名）与改道时是否注明：写进中枢的渠道约定。 */
        replyPlan: () => ({ order: config.replyOrder.filter(id => config.platforms[id] !== undefined).map(labelOf), note: config.rerouteNote }),
        setGroupResolver(resolve) {
            if (typeof resolve !== 'function') fail('INVALID_OPTIONS', '群解析规则必须是函数')
            if (groupResolver !== null) fail('INVALID_OPTIONS', '已经有群解析规则了，先撤销原来的')
            groupResolver = resolve
            return () => {
                if (groupResolver === resolve) groupResolver = null
            }
        },
        notify,
        checkHealth,
        groupOfSession,
        undelivered,
        exitSessions,
        sentBetween,
        /** 当前启用绑定指向的会话；只有它们的助手需要知道渠道的等待约定。 */
        boundSessionIds() {
            const ids = new Set()
            for (const [, raw] of readEntries(tables.bindings)) {
                const parsed = parseBinding(raw)
                if (parsed.success && bindingActive(parsed.data)) ids.add(parsed.data.sessionId)
            }
            return ids
        },
    })
}
