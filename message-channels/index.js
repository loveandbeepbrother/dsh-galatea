/**
 * QQ 与微信消息渠道的 Host 半边。
 *
 * 本插件只拥有三件事：`galatea_channels` 存储域（bindings/incoming/outgoing/
 * channelDefault/mainTurns）、配对收发的 runtime，以及插件详情页调用的 owner-only HTTP 路由。
 * 渠道不拥有、也不复制别的模块的私有工作根；需要默认会话时由自己 create 一次并保存
 * 实际返回的 id。
 * 助手本身是借用：每条 binding 按真实 SessionId 投递，人格、心智和记忆归助手插件所有；
 * 多个渠道绑定同一 Session 时共用同一历史。
 *
 * runtime 负责收发状态，平台工厂负责平台协议，ingress 负责原生准入；
 * 本文件负责生命周期接线。
 *
 * @module @loveandbeepbrother/dsh-galatea-channels
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import QRCode from 'qrcode'
import Schema from '@deepseek-ai/schemastery'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createMainTextIngress } from './channel-ingress.js'
import { CHANNEL_NOTICE_SOURCE, CHANNEL_SPEAKER, createChannelRuntime, channelTableSchemas, NO_SEND_MARKERS, WAIT_MARKERS } from './runtime.js'
import { QUOTA_NOTICE_DEFAULTS } from './quota-notices.js'

/** 绑定会话里给助手的等待约定（第一句按会话接的是私聊还是群另写）。 */
const WAIT_GUIDANCE = [
    '手机上的话常被拆成几条连续的短消息，图片和文字也只能分条发。',
    `如果你判断对方的话还没说完，可以整条只回复 \`${WAIT_MARKERS[0]}\`，不写其他任何内容：这条不会发给对方，`,
    '渠道会等对方继续；对方一段时间没有新消息时你会收到提醒，那时必须正常回复。拿不准时就正常回复，不要滥用等待。',
].join('\n')

/**
 * 接着渠道的会话都要知道的发送约定（图片、分片、中途发送、没送到的提示、交付文档）。由渠道经会话开头段落自己交代：
 * 装了渠道才出现，换了执行方也一样（执行方的系统提示里不写渠道的事）。
 */
export const CHANNEL_RULES = [
    '工具调用之间写的文字只留在 DSH 桌面上，不发到手机；一轮之中要让用户知道的事用 `assistant_channel_send` 发。',
    '要把图片发给用户时，在回复里用 Markdown 图片写出本机绝对路径（`![说明](绝对路径)`），QQ 与微信会把它作为图片发送；',
    '只支持 PNG、JPEG、WebP、GIF，单张不超过 10MB。',
    '微信每条用户消息最多回 10 片，QQ 官方机器人只能回 4 片，`assistant_channel_send` 中途发的都算在内，用完要等用户下一条消息；QQ 官方机器人一条回复的全部文字合成一片放在最前',
    '（每 1000 字一片），随后是图片和文件，所以图片的说明会出现在图片前面，按“先说明、后附图”来写。',
    '一条回复里的几张图会按出现顺序编号 1、2、3……，自动拼成一张不压缩的大图发出，只占一片（太大时拆成两三张）；',
    '说明里按编号指代即可，一条回复不要超过 9 张图。DSH 桌面里仍逐张显示。后台一轮的转交文字末尾会写明这一轮还能发几片。',
    '放不下的部分会留到用户下一条消息回完后再发，这只是兜底；用户之后在 DSH 桌面上说过话的，就不再补发。',
    '用户消息后面若接着“（渠道提示，不是对方说的：…）”，那是渠道告诉你哪些内容没送到手机：确定没送到的需要时重新发；',
    '结果不明的可能已经送到，重发前先想一想，必要时问一句收到没有。',
    '本机文件的链接在 QQ 与微信里只显示文件名；用 `present`（Claude Code 里是 `mcp__dsh__present`）交付的文档会同时原样发到用户正在用的 QQ 或微信。',
    '`assistant_channel_send` 让你在一轮之中随时给用户发消息，不必结束这一轮：开始一件要花时间的事、做到一半有了',
    '关键进展或发现、遇到需要用户尽早知道的情况，都可以用它，发不发、发什么由你判断。不要为了先回话而结束这一轮。',
    '最终回复仍在这一轮结束时发出，不要重复已经发过的话。在有次数限制的渠道（微信、QQ 官方机器人）上它总给最终回复留一次，结果会告诉你还剩几次。',
].join('')

/**
 * 绑定会话的渠道约定（`galatea-channels-wait` 节）：接着群的会话写明是哪个群、怎么改；中枢写明回复走哪个渠道、群可以各接一个会话。
 * 两种都带上发送约定 `CHANNEL_RULES`。绑定、改绑后这一节变了，Claude Code 会话下一轮会收到“渠道约定已更新”。
 * @param runtime - 渠道运行态。
 * @param sessionId - 会话 id。
 * @returns 这一节的文字；不是绑定会话时为空串。
 */
export function channelGuidance(runtime, sessionId, quiet) {
    if (runtime === null || typeof runtime?.boundSessionIds !== 'function' || !runtime.boundSessionIds().has(sessionId)) return ''
    const group = typeof runtime.groupOfSession === 'function' ? runtime.groupOfSession(sessionId) : null
    if (group !== null) {
        return [
            `本会话接着用户的${group.label ?? ''}群「${group.name}」（群号 ${group.groupId}）：群里用户本人说的话进这个会话，你的回复发回这个群。`,
            WAIT_GUIDANCE,
            '用户要解绑这个群、或把它改接到别的会话时，请用户在中枢里说（`assistant_channel_group` 只有中枢能用）。',
            CHANNEL_RULES,
        ].join('\n')
    }
    const plan = typeof runtime.replyPlan === 'function' ? runtime.replyPlan() : { order: [], note: false }
    const route = plan.order.length === 0
        ? '其余发到用户最近说话的渠道。'
        : `其余按${plan.order.join('、')}的先后走，都发不了时用用户最近说话的渠道${plan.note ? `；没走${plan.order[0]}时，消息开头会注明` : ''}。`
    const groupLabel = typeof runtime.groupLabel === 'function' ? runtime.groupLabel() : null
    return [
        '本会话与用户在手机上的私聊共用。',
        '本会话每一轮最后的那段文字都会发到用户手机，不论这一轮由什么开始：用户在手机或桌面上说的话、转交、后台一轮、别的会话或外部调用方转来的话。'
            + `用户从手机发来的，回到用户发来的渠道；${route}`,
        `这一轮不需要告诉用户时（例如只是记下了什么、处理完一条转交、或已经用 \`assistant_channel_send\` 说过），整条只回复 \`${NO_SEND_MARKERS[0]}\`，不写其他任何内容。`,
        `休息时段（${quiet}）里默认用户不在：不是用户自己说话开始的那一轮，回复攒到时段结束再发；这时候确实要告诉用户，就调 \`assistant_channel_send\`，这是打破休息的唯一方式。攒着的回复到点时，如果用户之后说过话，或者之后已经有话发给用户，就过时了，不再发。`,
        WAIT_GUIDANCE,
        ...groupLabel === null ? [] : [`用户的${groupLabel}群可以各接一个会话（一个会话只接一个群）；用户要查看、绑定、解绑时用 \`assistant_channel_group\`。`],
        CHANNEL_RULES,
    ].join('\n')
}
import { createQQPlatform } from './platforms/qq.js'
import { createWeixinPlatform } from './platforms/weixin.js'
import { acquireChannelLease } from './lease.js'
import { registerChannelRoutes } from './routes.js'

/**
 * The Host namespace this plugin provides.
 *
 * A namespace export, never a default export: the patch row names the plugin
 * and the loader reads `name`/`inject`/`apply` off the module namespace.
 */
export const name = 'message-channels-framework'

/**
 * Declared dependencies.
 *
 * `connection` is deliberately absent. The Connection service arrives only on a
 * browser-facing profile and only after web startup, so declaring it here would
 * gate the whole channel - including the messaging half that works headless -
 * and a headless profile would park this plugin forever.
 */
export const inject = [
    // 框架核心：谁说的、中枢、转交、回复去向、休息时段、附提醒都以核心为准。
    'core',
    'sessionController',
    'sessionQuery',
    'sessions',
    'storageDomain',
    'credentials',
    'tools',
]

/** 插件配置。内置 QQ 官方机器人、微信；别的平台由插件经 `registerPlatform` 登记（README“接新平台”）。 */
export const Config = Schema.object({
    replyOrder: Schema.array(Schema.string()).default([])
        .description('中枢发到手机时渠道的先后（平台名，如 [weixin, qq]）；空就发到用户最近说话的渠道'),
    rerouteNote: Schema.boolean().default(false)
        .description('中枢的话没走 replyOrder 第一位时，在消息开头注明是从哪个渠道改发的'),
    mergeWaitSeconds: Schema.natural().default(20)
        .description('手机上分几条发的话合成一条再交：最后一条之后安静这么多秒才交给会话，来一条顺延一次，从第一条起最多等 2 分钟。按用户打字的节奏调：分条发得慢就调大，嫌回得慢就调小；0 不等。平台可以自己声明（比如读消息本身就慢的平台）'),
    downAlarmMinutes: Schema.natural().default(10)
        .description('一个平台断开多久后经别的渠道告诉用户一次（短暂重连不算）；0 不告诉'),
    quotaNotices: Schema.object({
        usageWarnLevels: Schema.array(Schema.number()).default([...QUOTA_NOTICE_DEFAULTS.usageWarnLevels])
            .description('用量提前提醒的几档（占比）；每个窗口每档提醒一次'),
        usageWarnWindows: Schema.array(Schema.string()).default([...QUOTA_NOTICE_DEFAULTS.usageWarnWindows])
            .description('提前提醒看哪些额度窗口（five_hour、seven_day 等）'),
        sweepMinutes: Schema.natural().default(5).description('多久检查一次要不要发额度说明与用量提醒（休息时段结束后的补发靠它）'),
    }).default({}).description('额度用完与用量提前提醒，不经模型'),
    health: Schema.object({
        checkMinutes: Schema.natural().default(10).description('多久自查一次；0 不查'),
        downChecks: Schema.natural().default(2).description('已绑定的平台连续几次不是"已连接"才算断开（报 channels/down、自己重连一次）'),
        undeliveredGraceMinutes: Schema.natural().default(2).description('回复没送到、又没能立即告诉会话，多久后报 channels/undelivered'),
    }).default({}).description('渠道自查：断开、回复没送到，经框架核心报异常'),
    sendPause: Schema.object({
        rejects: Schema.natural().default(2).description('同一个绑定连着几片被平台确定没发出就暂停它（中间发出一片就重数）；0 不暂停'),
        minutes: Schema.natural().default(15).description('暂停多久：这段时间选路跳过它；到点后下一片先试它，发出就恢复，又没发出再停这么久'),
    }).default({}).description('连续发不出时暂停（例如某个平台的连接不稳时）：平台确定没发出的片改走别的渠道，暂停、恢复经框架核心报'),
})

/** The service name the routes and the client agree on. */
const SERVICE = 'assistantChannels'

/** Domain identity: renaming either half orphans stored rows. */
const DOMAIN_NAME = 'galatea_channels'
// 2：绑定的续收位置 cursor 只有用得着的平台（微信）写。新装的直接从第 2 版开始。
const DOMAIN_VERSION = 2

/** 单 Host 租约目录与拼图缓存目录：官方 dshHomePath 下渠道自己的目录。 */
const LEASE_DIRECTORY = 'galatea-channels'
const COMPOSITE_DIRECTORY = 'galatea-channels'

/** Shape a code must have before it is worth logging or reporting. */
const CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

const noop = () => {}


/**
 * 语音合成服务（`@loveandbeepbrother/dsh-tts-service`）的“发到聊天”去向：说话工具在用户不在电脑前时交给这里，
 * 按这个会话接着的渠道发出：能发语音的平台（官方 QQ）发语音条，别的发音频文件。没接手机渠道的会话不可用，说话工具会换下一个去向或只存文件。
 */
export function voiceOutput(runtime) {
    return {
        id: 'channel',
        name: '发到 QQ 或微信',
        async available(session) {
            return runtime.boundSessionIds().has(session.id) ? { yes: true } : { yes: false, why: '这个会话没接手机上的聊天渠道' }
        },
        async deliver(session, file) {
            const pushed = await runtime.push({ sessionId: session.id, voice: file, by: { kind: 'program', plugin: 'tts-say' } })
            if (pushed?.status === 'sent' && pushed.sent > 0) {
                return { ok: true, detail: `已作为语音发到${typeof runtime.voiceWord === 'function' ? runtime.voiceWord(pushed.platform) : pushed.platform}` }
            }
            return { ok: false, detail: `没有发到渠道：${pushed?.reason ?? (pushed?.failed ? '发送失败' : '放不下')}` }
        },
    }
}

/**
 * Read only the stable code of a thrown value.
 *
 * Error messages can carry a token, an appSecret or a context token, so none of
 * them is ever logged or returned; an unrecognised failure becomes `unexpected`.
 *
 * @param error - any thrown value.
 * @returns a code safe to log.
 */
function codeOf(error) {
    if (error !== null && typeof error === 'object') {
        const code = error.code
        if (typeof code === 'string' && CODE_PATTERN.test(code)) return code
    }
    return 'unexpected'
}

/** 任务会话的编号前缀（项目任务插件）。 */
const TASK_SESSION_PREFIX = 'session-task-'

/**
 * 会话是否已归档：宿主项目登记表的 `archivedSessionIds`。登记表不在时为 undefined（运行态按“查不了”处理）。
 * @param ctx - 插件上下文。
 * @param sessionId - 会话 id。
 */
export function isArchivedSession(ctx, sessionId) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || !Array.isArray(registry?.archivedSessionIds)) return undefined
    return registry.archivedSessionIds.map(String).includes(String(sessionId))
}

/**
 * 用户说的“会话”换成会话 id（绑定群用）：依次按未归档会话的 id、未归档非任务会话的标题、项目标题（取它的
 * 「<项目>·项目会话」）找。都对不上或有几个时返回原因与最多 5 个标题里含这几个字的候选。
 * @param ctx - 插件上下文。
 * @param text - 会话 id、会话标题或项目标题。
 * @returns `{sessionId, title}`，或 `{reason: 'NONE' | 'AMBIGUOUS', candidates: [{sessionId, title}]}`；宿主没有这些服务时抛错。
 */
export async function findSession(ctx, text) {
    const registry = ctx.get('workspaceRegistry')
    const controller = ctx.get('sessionController')
    if (registry === undefined || typeof registry?.list !== 'function' || typeof controller?.list !== 'function') {
        throw new Error('workspaceRegistry or sessionController.list is unavailable')
    }
    const archived = new Set((registry.archivedSessionIds ?? []).map(String))
    const { items } = await controller.list({}, AbortSignal.timeout(20_000))
    const sessions = items.map(item => ({ sessionId: String(item.sessionId), title: item.projections?.values?.title }))
        .filter(item => !archived.has(item.sessionId))
    const named = item => ({ sessionId: item.sessionId, title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title : undefined })
    const byId = sessions.find(item => item.sessionId === text)
    if (byId !== undefined) return named(byId)
    const plain = sessions.filter(item => !item.sessionId.startsWith(TASK_SESSION_PREFIX))
    const byTitle = plain.filter(item => item.title === text)
    if (byTitle.length === 1) return named(byTitle[0])
    if (byTitle.length > 1) return { reason: 'AMBIGUOUS', candidates: byTitle.map(named) }
    // 按项目名找它的「…·项目会话」：同名的项目不止一个时不猜，列出来让调用方用会话 id。
    const projects = registry.list().filter(item => item.title === text).flatMap((workspace) => {
        const ids = new Set(workspace.sessionIds.map(String))
        return plain.filter(item => ids.has(item.sessionId) && item.title === `${text}·项目会话`)
    })
    if (projects.length === 1) return named(projects[0])
    if (projects.length > 1) return { reason: 'AMBIGUOUS', candidates: projects.map(named) }
    return {
        reason: 'NONE',
        candidates: plain.filter(item => typeof item.title === 'string' && item.title.includes(text)).slice(0, 5).map(named),
    }
}

/** 会话标题（会话列表里的），没有时为空。 */
async function sessionTitleOf(ctx, sessionId) {
    try {
        const { items } = await ctx.get('sessionController').list({}, AbortSignal.timeout(20_000))
        const title = items.find(item => String(item.sessionId) === sessionId)?.projections?.values?.title
        return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
    } catch {
        return undefined
    }
}

/** 会话之间互相转交的话的来源；登记在插件入口：别的会话说的，核心加来源标注。 */
export const SESSION_SOURCE = 'galatea-session'

/**
 * 执行 `assistant_session_send`：别的会话只能发给中枢；中枢按 `to` 找目标（会话 id、会话标题、项目标题、群号或群名）。
 * 经核心的入口 `core.deliver` 交出：出处记成调用的会话，同一次工具调用重试不重复。
 * 对方那一轮的回复往哪去由去向定：发给中枢的照常发到手机；发给接群会话的默认留在它自己的会话，
 * `reply: 'group'` 时发到它接的群（`{to:'exit'}`）。
 * @returns 给助手看的结果。
 */
export async function runSessionSend(ctx, runtime, core, args, exec) {
    const agent = exec?.agent
    const caller = String(agent?.session?.id ?? '')
    if (caller === '') return '没有发出：无法确定调用会话。'
    if (agent.parentAgent !== undefined || agent.session?.header?.origin === 'subagent') return '没有发出：子代理不能给别的会话发消息。'
    const text = String(args.text ?? '').trim()
    if (text === '') return '没有发出：text 不能为空。'
    if (args.reply !== undefined && args.reply !== 'group') return '没有发出：reply 只能是 "group"，或者不填。'
    if (runtime === null) return '没有发出：渠道还没就绪，稍后再试。'
    // 发给谁按框架核心的中枢认。
    const main = core.sessions.hub() ?? undefined
    const to = typeof args.to === 'string' ? args.to.trim() : ''
    let target
    let header
    if (main !== undefined && caller === main) {
        if (to === '') return '没有发出：中枢要写明发给谁（to：会话 id、会话标题、项目名，或群号、群名）。'
        let found
        try {
            found = await findSession(ctx, to)
        } catch {
            return '没有发出：宿主暂时查不了会话列表，稍后再试。'
        }
        target = found.sessionId
        if (target === undefined) {
            const groups = await runtime.listGroups({ caller }).catch(() => null)
            // 只认现在接着会话的群（解绑过的、会话已不在的不算）；同名的群不止一个时不猜。
            const live = groups?.status === 'ok' ? groups.groups.filter(item => item.sessionId && item.unbound !== true && !item.gone) : []
            const byNumber = live.filter(item => item.groupId === to)
            const byName = byNumber.length > 0 ? byNumber : live.filter(item => item.name === to)
            if (byName.length > 1) return `没有发出：有几个群都叫「${to}」，请用群号：${byName.map(item => `${item.name}（${item.groupId}）`).join('；')}。`
            target = byName[0]?.sessionId ?? undefined
            if (target === undefined) {
                const candidates = (found.candidates ?? []).map(item => `${item.title ?? item.sessionId}（${item.sessionId}）`)
                return found.reason === 'AMBIGUOUS'
                    ? `没有发出：有几个会话都叫「${to}」，请用会话 id：${candidates.join('；')}。`
                    : `没有发出：找不到「${to}」。${candidates.length > 0 ? `标题里含这几个字的：${candidates.join('；')}。` : ''}`
            }
        }
        if (target === caller) return '没有发出：不能发给自己。'
        header = '【中枢转来】'
    } else {
        if (main === undefined) return '没有发出：现在还没有中枢会话。'
        if (to !== '' && to !== main && to !== '中枢' && to !== 'hub') return '没有发出：这个会话只能发给中枢（不填 to）。'
        if (args.reply === 'group') return '没有发出：reply: "group" 只在中枢发给接群的会话时用。'
        target = main
        header = `【项目会话转来：${await sessionTitleOf(ctx, caller) ?? caller}】`
    }
    const group = target !== main && runtime.exitSessions?.().some(item => item.sessionId === target && item.as === 'group') === true
    if (args.reply === 'group' && !group) return '没有发出：对方没有接群，reply: "group" 用不了。'
    const toGroup = args.reply === 'group'
    const where = toGroup ? '（这一轮的回复会发到你接的群里。）' : group ? '（这一轮的回复留在这个会话里，不发到群里，也不会转回给中枢。）' : ''
    const key = `session-${caller}-${String(exec?.callId ?? `${Date.now()}`)}`
    // 这次转话的关联编号：接收方的条目带着它，结果里也写出来，发送方记录里的这次调用就能和接收方对上（同一次调用重试时不变）。
    const link = linkOf(key)
    let result
    try {
        result = await core.deliver(target, {
            key,
            text: `${header}${where}\n${text}`,
            source: { kind: SESSION_SOURCE, from: caller },
            speaker: { kind: 'session', sessionId: caller },
            link,
            ...toGroup ? { reply: { to: 'exit' } } : {},
        })
    } catch (error) {
        return `没有发出：${error?.message ?? error}。`
    }
    const name = target === main ? '中枢' : `「${await sessionTitleOf(ctx, target) ?? target}」`
    if (result.status === 'unavailable') return `没有发出：${name}现在收不到（${result.reason}）。`
    if (result.status === 'unknown') return `不确定交到没有：${name}的会话没能落盘（${result.reason}）。重试同一次调用不会重复交。`
    const reply = target === main ? '它的回复照常发到用户手机。' : toGroup ? '它这一轮的回复会发到它接的群里。' : '它的回复留在它自己的会话里，不会转回给你，也不外发。'
    if (result.status === 'duplicate') return `这一条之前已经交给${name}了，没有再交。${reply}（编号 ${link}）`
    return `已交给${name}：它空闲时马上处理，正在回复时排在这一轮之后。${reply}（编号 ${link}）`
}

/** 转话的关联编号：由这次调用的键算出来，形状同 UUID。 */
export function linkOf(key) {
    const hex = createHash('sha256').update(String(key)).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** 绑定工具被拒时的说明。 */
function groupRefusal(result, label) {
    const list = items => (items?.length > 0 ? `候选：${items.join('；')}。` : '')
    const account = label ?? '支持群的渠道'
    switch (result.reason) {
        case 'NO_ACCOUNT': return label === null ? '没有执行：还没有接上支持群的渠道。' : `没有执行：${account}还没有配对。`
        case 'NOT_ALLOWED': return '没有执行：只有中枢、接着这个群的会话、或要把群接到自己的会话能改群的绑定；任务会话与子代理不能。'
        case 'SELF_ONLY': return '没有执行：这个会话没有接群，只能把群接到自己（不填 session）。要接到别的会话，请用户在中枢里说。'
        case 'GROUP_REQUIRED': return '没有执行：这个会话没有接群，要写明是哪个群（群号或完整群名）。'
        case 'GROUP_UNKNOWN': return `没有执行：找不到这个群（${account}不在这个群里，或群名不完全一致）。${list(result.candidates)}`
        case 'GROUP_AMBIGUOUS': return `没有执行：有几个同名的群，请用群号。${list(result.candidates)}`
        case 'GROUP_NOT_OWN': return `没有执行：这个会话接的是群「${result.group?.name}」，只能改它自己的群；别的群请用户在中枢里说。`
        case 'NOT_CONNECTED': return `没有执行：${account}现在没连上，查不了它在哪些群里，稍后再试。`
        case 'SESSION_REQUIRED': return '没有执行：要写明接到哪个会话。'
        case 'SESSION_TASK': return '没有执行：项目任务会话不能接群。'
        case 'SESSION_MAIN': return '没有执行：中枢已经接着私聊，不能再接群。'
        case 'SESSION_UNKNOWN': return '没有执行：这个会话打不开。'
        case 'SESSION_ARCHIVED': return '没有执行：这个会话已经归档。'
        case 'SESSION_TAKEN': return `没有执行：这个会话已经接着群「${result.group?.name}」（一个会话只接一个群）。用户同意顶掉那个群时，再带 replace: true 调用。`
        case 'NOT_BOUND': return '没有执行：这个群现在没有接任何会话。'
        default: return `没有执行：${result.reason ?? '未知原因'}。`
    }
}

/**
 * 执行 `assistant_channel_group`：调用者与目标的规则在运行态里核对，这里只找会话、写中文结果。
 * @param ctx - 插件上下文。
 * @param runtime - 渠道运行态。
 * @param args - 工具参数。
 * @param exec - 工具执行上下文（调用会话）。
 * @returns 给助手看的结果。
 */
export async function runGroupTool(ctx, runtime, args, exec) {
    const agent = exec?.agent
    const caller = String(agent?.session?.id ?? '')
    if (caller === '') return '没有执行：无法确定调用会话。'
    if (agent.parentAgent !== undefined || agent.session?.header?.origin === 'subagent') return '没有执行：子代理不能改群的绑定。'
    const action = String(args.action ?? '')
    const group = typeof args.group === 'string' && args.group.trim() !== '' ? args.group.trim() : undefined
    const label = typeof runtime.groupLabel === 'function' ? runtime.groupLabel() : null
    const account = label ?? '支持群的渠道'
    const refused = result => groupRefusal(result, label)
    const confirmation = result => (result.confirmed ? '群里已发确认。' : `群里的确认没发出去（${account}可能没连上）。`)
    const stays = sessionId => (sessionId === caller ? '你这一轮的回复不会再发到这个群，只留在 DSH。' : '')

    if (action === 'list') {
        const result = await runtime.listGroups({ caller })
        if (result.status !== 'ok') return refused(result)
        if (result.groups.length === 0) return result.connected ? `${account}不在任何群里，也没有群绑定。` : `没有群绑定；${account}现在没连上，看不到它在哪些群里。`
        const lines = result.groups.map((item) => {
            const where = item.sessionId === null ? '没有接会话'
                : item.unbound ? `已解绑（原来接「${item.session}」）`
                    : `接着「${item.session}」（${item.sessionId}）${item.gone === null ? '' : item.gone === 'deleted' ? '，但这个会话已删除' : '，但这个会话已归档'}`
            return `- 「${item.name}」（${item.groupId}）：${where}`
        })
        return [...lines, ...result.connected ? [] : [`（${account}现在没连上，只列出了已有的群绑定。）`]].join('\n')
    }
    if (action === 'unbind') {
        const result = await runtime.unbindGroup({ caller, group })
        if (result.status !== 'unbound') return refused(result)
        const dropped = result.dropped > 0 ? `还有 ${result.dropped} 条没来得及交给会话的消息不再处理。` : ''
        return `已解绑群「${result.name}」（${result.groupId}），它原来接「${result.session}」。${confirmation(result)}${dropped}${stays(result.sessionId)}`
    }
    if (action !== 'bind') return '没有执行：action 只能是 list、bind 或 unbind。'
    const wanted = typeof args.session === 'string' && args.session.trim() !== '' ? args.session.trim() : caller
    let target
    try {
        target = await findSession(ctx, wanted)
    } catch {
        return '没有执行：宿主暂时查不了会话列表，稍后再试。'
    }
    if (target.sessionId === undefined) {
        // 接到自己时，会话列表里没有标题也照样按 id 接。
        if (wanted !== caller) {
            const candidates = target.candidates.map(item => `${item.title ?? item.sessionId}（${item.sessionId}）`)
            return target.reason === 'AMBIGUOUS'
                ? `没有执行：有几个会话都叫「${wanted}」，请用会话 id：${candidates.join('；')}。`
                : `没有执行：找不到会话「${wanted}」。${candidates.length > 0 ? `标题里含这几个字的：${candidates.join('；')}。` : ''}`
        }
        target = { sessionId: caller }
    }
    const result = await runtime.bindGroup({ caller, group, sessionId: target.sessionId, sessionTitle: target.title, replace: args.replace === true })
    if (result.status === 'refused') return refused(result)
    if (result.status === 'same') return `群「${result.name}」（${result.groupId}）本来就接着「${result.session}」，没有改。`
    const replaced = result.replaced === null || result.replaced === undefined ? '' : `原来接着这个会话的群「${result.replaced.name}」已解绑。`
    const from = result.status === 'rebound' ? `（原来接「${result.previous.session}」）` : ''
    return `已把群「${result.name}」（${result.groupId}）接到「${result.session}」${from}。${replaced}${confirmation(result)}${stays(result.previous?.sessionId)}`
}

/**
 * Render QR text as an SVG document.
 *
 * The page loads the result with an `<img>`, so the markup never runs as part of
 * the page and the QR text itself is never sent as JSON.
 *
 * @param text - the QR payload the platform reported.
 * @returns a promise of the SVG string.
 */
function qrToSvg(text) {
    return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M' })
}

/**
 * 渠道三张表的域声明。
 *
 * schema 直接来自 runtime 的 `channelTableSchemas`；官方 `defineDomain` 校验
 * 域名、版本、布局和表名，配置错误在模块加载期失败。
 *
 * @returns 交给 `storageDomain.open` 的域 spec。
 */
function buildChannelDomainSpec() {
    const tables = {}
    for (const table of Object.keys(channelTableSchemas)) {
        tables[table] = { valueSchema: channelTableSchemas[table] }
    }
    return defineDomain({
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        layout: 'per-record',
        tables: tables,
    })
}

/**
 * 激活渠道 Host。
 *
 * 卸载保护在第一个 await 之前注册：域、平台工厂或 runtime 在卸载后才返回时，
 * 由同一次 release 关闭，不会发布到已经结束的 context。
 *
 * @param ctx - 本插件的 cordis context。
 */
export async function apply(ctx, config = {}) {
    const state = {
        /** context 结束即置位：之后不再发布任何服务。 */
        closed: false,
        /** 本次 Host 持有的文件租约。 */
        lease: null,
        /** 关闭没走完时置位：租约不再释放。 */
        sealed: false,
        domain: null,
        runtime: null,
        /** `session/event` 订阅的释放函数；不保存任何单一中枢 id。 */
        wakeDisposer: null,
        /** 额度说明与用量提醒的定时检查。 */
        quotaTimer: null,
        healthTimer: null,
        /** release 等待的唯一 acquisition promise。 */
        acquisition: null,
        /** 共享的一次性 teardown。 */
        closing: null,
    }

    // 绑定渠道的会话里，助手可以先不回复、等对方说完；其他会话不出现这段说明。
    ctx.effect(() => ctx.core.segment({
        name: 'galatea-channels-wait',
        order: 9_500,
        // 只描述这个会话接着哪个渠道、回复怎么发：所有执行方开对话都要。
        audience: 'opening',
        text: ({ sessionId }) => channelGuidance(state.runtime, String(sessionId), ctx.core.quietHours.describe()),
    }), 'message-channels-framework: wait segment')

    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

    // 经历库在时，中途发送注册成它的推送式来源：一次发送一条，发完就交。
    let pushSource = null
    // 不等它：没装经历库时这个注入永远不成，不能挡住启动；失败只记稳定的错误码。
    Promise.resolve(ctx.inject(['experience'], (sub) => {
        const source = sub.experience.registerSource({ id: 'channel-pushes', label: '消息渠道的中途发送', category: 'dsh' })
        pushSource = source
        sub.effect(() => () => {
            if (pushSource === source) pushSource = null
            source.dispose()
        }, 'message-channels-framework: experience source')
    })).catch((error) => {
        ctx.logger.warn(`galatea-channels: 经历库来源没注册（${codeOf(error)}）`)
    })
    const recordPush = (entry) => {
        if (pushSource === null) return
        Promise.resolve(pushSource.append([entry])).catch((error) => {
            ctx.logger.warn(`galatea-channels: 中途发送没记进经历库（${codeOf(error)}）`)
        })
    }

    // 程序和别的会话往会话里放话一律经核心的 `core.deliver`：渠道不再提供转交服务。
    // 渠道自己放进去的两种话在这里登记：会话之间转的（别的会话说的，加来源标注）、渠道的通知（正文写明了来历，不标）。
    const core = ctx.core
    ctx.effect(() => core.declareSource(SESSION_SOURCE, { intent: 'prompt', annotate: true }), 'message-channels-framework: session source')
    ctx.effect(() => core.declareSource(CHANNEL_NOTICE_SOURCE, { intent: 'prompt', annotate: false, speaker: CHANNEL_SPEAKER }), 'message-channels-framework: notice source')
    // 出口登记：私聊绑定指向的会话接成中枢，群绑定接着的会话接成群；自省看前台、核心核对 `{to:'exit'}` 都按它。
    // 出口通知（项目任务的进度发到项目接的群）也经这里收，渠道没起来时算没发出、由核心报。
    ctx.effect(() => core.exits.register({
        id: 'message-channels',
        label: 'QQ、微信',
        sessions: () => state.runtime?.exitSessions?.() ?? [],
        notify: request => (state.runtime === null ? { status: 'failed', reason: '渠道还没起来' } : state.runtime.notify(request)),
        sentBetween: (sessionId, from, to) => (state.runtime === null ? null : state.runtime.sentBetween(sessionId, from, to)),
    }), 'message-channels-framework: exit')
    // 换了中枢：私聊的消息按新中枢准入、回复，马上对一次账（攒着没交的私聊消息也是这时交进去）。
    ctx.effect(() => core.sessions.on('changed', ({ from, to }) => {
        if (from !== 'hub' && to !== 'hub') return
        state.runtime?.wake?.().catch?.((error) => {
            ctx.logger.warn(`galatea-channels: wake after hub change failed (${codeOf(error)})`)
        })
    }), 'message-channels-framework: hub change')

    // 会话之间互相转交：项目会话、任务会话只能发给中枢；中枢可以发给指定的项目会话或接群的会话。
    // 工具经核心注册：谁能用由核心按调用方挡（子代理按父会话算），端点照这里的声明交给外部调用方。
    const sessionOf = who => (who?.kind === 'session' ? who.sessionId : null)
    const servesGroup = sessionId => state.runtime?.exitSessions?.().some(item => item.sessionId === sessionId && item.as === 'group') === true
    core.tool(defineTool({
        name: 'assistant_session_send',
        description: 'Send a message to another DSH session. From any session other than the hub (中枢), it always goes to the hub (omit `to`): use it to report something the hub must know or decide, instead of leaving a note. '
            + 'From the hub, `to` names the target: a session id, an exact session title, a project title (meaning its 「项目·项目会话」), or a group number or exact group name (meaning the session attached to that group). '
            + 'The target receives it headed 【中枢转来】 or 【项目会话转来：<name>】, marked as coming from this session, not from the user; if it is idle it starts a turn right away, if it is busy it handles it right after the current turn. '
            + 'Where the target\'s reply goes: a message to the hub is answered to the user\'s phone as usual. A message to any other session is answered inside that session only: the reply is not sent to the user and does not come back to you. '
            + 'To have a session attached to a group answer in its group (e.g. "tell the group the draft is ready"), pass reply: "group". Retrying the same tool call does not send twice.',
        parameters: {
            text: { type: 'string', required: true, description: 'What to tell the other session, self-contained.' },
            to: { type: 'string', description: 'Hub only: target session id, session title, project title, or group number/name.' },
            reply: { type: 'string', description: 'Hub only, target attached to a group: "group" sends the target\'s reply this turn to its group. Without it the reply stays in the target session.' },
        },
        output,
        execute: async (args, exec) => runSessionSend(ctx, state.runtime, core, args ?? {}, exec),
    }), { effect: 'write', alwaysLoad: true, allow: who => who?.kind === 'session' && ['hub', 'worker', 'background'].includes(who.role) })

    // 说一句话就能解绑、改绑群：工具只给中枢；运行态另外核对调用者与目标。
    core.tool(defineTool({
        name: 'assistant_channel_group',
        description: 'View, bind or unbind the user\'s groups (on the channel that supports groups). Each group is attached to exactly one DSH session and each session to at most one group: the user\'s messages in that group go into that session and its replies go back to the group. '
            + 'Only call this when the user explicitly asks in this conversation (e.g. "这个群改绑到写作项目", "解绑这个群", "把群 X 接到这里"). '
            + 'action "list": the account\'s groups and what each is attached to. action "bind": attach `group` to `session`; if that session already has another group, the call is refused unless `replace` is true, so ask the user first. action "unbind": detach `group`. '
            + 'Omit `group` to mean the group attached to this session. Only the hub session (中枢) has this tool; any group can be changed from there. '
            + 'The group itself gets a short confirmation; after binding or unbinding the current group, your reply this turn stays in DSH and is not sent to that group.',
        parameters: {
            action: { type: 'string', required: true, description: '"list", "bind" or "unbind".' },
            group: { type: 'string', description: 'Group number or exact group name. Omit for the group attached to this session.' },
            session: { type: 'string', description: 'For bind: target session id, exact session title, or a project title (meaning its 「项目·项目会话」). Omit to mean this session.' },
            replace: { type: 'boolean', description: 'For bind: when the target session already has another group, unbind that group first. Only when the user agreed.' },
        },
        output,
        execute: async (args, exec) => {
            const runtime = state.runtime
            if (runtime === null) throw new Error('QQ、微信渠道还没有连接')
            return runGroupTool(ctx, runtime, args ?? {}, exec)
        },
    // list 是读，但和写放在一个工具里，整个按写算；只给中枢。
    }), { effect: 'write', allow: who => who?.kind === 'session' && who.role === 'hub' })

    // 一轮之中立即发到手机：说明接下来要做什么、报告进展、先发图片或文件，不必等这一轮结束。
    core.tool(defineTool({
        name: 'assistant_channel_send',
        description: 'Send a message to the user\'s phone right now, in the middle of your turn, without ending it: say what you are about to do before long work, report progress, or send images first. '
            + 'It goes to the channel the user last wrote from among those that can deliver right now (a group session only to its own group). Images are Markdown images with a local absolute path in `text`; `files` are local absolute paths sent as files, unchanged; when that channel cannot send files, a file goes through another channel that can, or is sent as text (small text files) or as its path on the computer, and the result says how. '
            + 'WeChat allows 10 replies per user message and the official QQ bot 4, shared by this tool, your final reply and any parts left over from earlier; when they run out the rest waits for the next message from the user. On the official QQ bot all text of one call is one part (per 1000 characters) placed first, then one part per image and per file. '
            + 'On these two channels this tool always leaves one reply for your final reply, and the result says how many parts were sent, how many did not fit, and how many replies are left. '
            + 'Your final reply is still sent when the turn ends; do not repeat there what you already sent.',
        parameters: {
            text: { type: 'string', description: 'Text to send now; may contain Markdown images with local absolute paths.' },
            files: { type: 'array', items: { type: 'string' }, description: 'Local absolute paths of files to send as files.' },
        },
        output,
        execute: async (args, exec) => {
            const runtime = state.runtime
            if (runtime === null) throw new Error('QQ、微信渠道还没有连接')
            // 发送范围按调用方：子代理按父会话（不拿子代理自己的会话去查绑定），外部调用方按中枢。
            const who = core.caller(exec)
            const sessionId = who.kind === 'external' ? core.sessions.hub() ?? '' : sessionOf(who) ?? ''
            if (sessionId === '') return '没有发出：认不出是哪个会话在发。'
            const result = await runtime.push({ sessionId, text: String(args?.text ?? ''), files: args?.files ?? [], by: who })
            if (result.status !== 'sent') {
                if (result.reason === 'NOT_BOUND') return '没有发出：这个会话没有绑定 QQ 或微信。'
                if (result.reason === 'NO_REPLIES_LEFT') {
                    return `没有发出：这条消息只剩 ${result.repliesLeft} 次回复（或已过期），要留给最终回复。要发的内容写进最终回复。`
                }
                return '没有发出：对方还没有在 QQ 或微信上发过消息。'
            }
            const left = result.repliesLeft === null ? '' : `这条消息还剩 ${result.repliesLeft} 次回复。`
            const unsent = result.unsent > 0 ? `${result.unsent} 片放不下，没有发。` : ''
            const failed = result.failed > 0 ? `${result.failed} 片发送失败。` : ''
            // 这个渠道发不了的内容改了发法：照实说明。
            const routed = (result.routed ?? []).map(note => `${note}。`).join('')
            return `已发到${state.runtime?.labelOf?.(result.platform) ?? result.platform}：${result.sent} 片。${failed}${unsent}${left}${routed}`
        },
    }), {
        effect: 'write',
        alwaysLoad: true,
        allow: who => (who?.kind === 'session' && (who.role === 'hub' || servesGroup(who.sessionId))) || (who?.kind === 'external' && who.readOnly !== true),
    })

    ctx.effect(() => {
        const acquisition = boot()
        state.acquisition = acquisition
        // 先挂观察者：启动失败由 apply 或 release 报告，不会先变成 unhandled。
        acquisition.then(noop, noop)
        return () => {
            // 同步置 closed，teardown 期间到达的请求或 session 事件立即看到。
            state.closed = true
            if (state.closing === null) {
                state.closing = release()
                // 未被 await 的卸载不会变成 unhandled rejection。
                state.closing.catch(noop)
            }
            return state.closing
        }
    }, 'galatea-channels: lifecycle')

    // 只在这里等待，启动失败才会作为插件失败报告给 loader。
    await state.acquisition

    /**
     * 取得租约 → 开域 → 建平台工厂 → 建 runtime → 发布。
     *
     * 每个 await 之后检查 closed：卸载后晚返回的对象由同一次 release 关闭。
     */
    async function boot() {
        // 官方 storageDomain 只在进程内去重，两个 Host 同 home 会各起一条真实
        // listen 并重复回复同一条消息，所以先取文件租约。
        state.lease = await acquireChannelLease(dshHomePath(LEASE_DIRECTORY))
        if (state.closed) return

        try {
            const storage = ctx.storageDomain
            if (storage === null || typeof storage !== 'object' || typeof storage.open !== 'function') {
                throw new TypeError('galatea-channels: storageDomain.open is unavailable')
            }
            const domain = await storage.open(buildChannelDomainSpec())
            if (domain === null || typeof domain !== 'object') {
                throw new TypeError('galatea-channels: storageDomain.open returned no domain')
            }
            state.domain = domain
            if (state.closed) return

            // 只建工厂：真实 pair/listen/send 发生前不联网、不画二维码。
            // 内置两个平台；别的平台由插件经服务的 registerPlatform 登记。
            const platforms = {
                qq: await createQQPlatform(),
                weixin: await createWeixinPlatform(),
            }
            if (state.closed) return

            // 本包自己的渠道侧 channel-ingress；入站只走 sessionController.prompt，
            // 不 create 恢复已绑定会话，也不管理 Agent handle。
            const runtime = await createChannelRuntime(ctx, {
                platforms: platforms,
                createIngress: createMainTextIngress,
                domain: domain,
                // 手机上的话常分条发：最后一条之后安静一段（配置 mergeWaitSeconds，默认 20 秒）再一起准入，来一条顺延一次；
                // 从第一条起最多攒 2 分钟。等多久因人而异，装好以后请用户按自己的节奏调（见 README）。
                mergeTextMs: (config.mergeWaitSeconds ?? 20) * 1000,
                mergeImageMs: (config.mergeWaitSeconds ?? 20) * 1000,
                mergeCapMs: 120_000,
                // 助手回复等待标记后最多再等 3 分钟。
                waitTimeoutMs: 180_000,
                // QQ 被动回复在对方消息后 60 分钟内有效；转交留出余量。
                qqRelayWindowMs: 50 * 60_000,
                // 中枢每一轮的回复默认发到手机。
                mainTurnReplies: true,
                // 中途发送记进经历库。
                pushed: recordPush,
                // 断开、没送到、英文旁白、回复被挡下经框架核心报：谁来收由核心管，渠道不认。
                report: (kind, detail) => ctx.core.report(kind, detail),
                downChecks: Math.max(1, config?.health?.downChecks ?? 2),
                undeliveredGraceMs: (config?.health?.undeliveredGraceMinutes ?? 2) * 60_000,
                // 连着被平台确定没发出就暂停这个绑定一阵。
                pauseRejects: config?.sendPause?.rejects ?? 2,
                pauseMs: (config?.sendPause?.minutes ?? 15) * 60_000,
                // 一条回复里相邻的几张图拼成一张无损大图再发。
                // 放在消息渠道自己的目录：框架的内容库是 git 仓库，缓存放进去会一直显示未跟踪。
                compositeDir: join(dshHomePath(COMPOSITE_DIRECTORY), 'composites'),
                // 一个平台断开这么久仍未恢复，经别的渠道告诉对方一次；回复先后与改道说明照配置。
                downAlarmMs: (config?.downAlarmMinutes ?? 10) * 60_000,
                replyOrder: config?.replyOrder ?? [],
                rerouteNote: config?.rerouteNote === true,
                // 群接的会话归档了没有（宿主项目登记表）：归档后群里的话转到中枢。
                isArchived: sessionId => isArchivedSession(ctx, sessionId),
                // 额度用完与用量提前提醒。
                quotaNotices: {
                    usageWarnLevels: config?.quotaNotices?.usageWarnLevels ?? QUOTA_NOTICE_DEFAULTS.usageWarnLevels,
                    usageWarnWindows: config?.quotaNotices?.usageWarnWindows ?? QUOTA_NOTICE_DEFAULTS.usageWarnWindows,
                },
            })
            if (runtime === null || typeof runtime !== 'object') {
                throw new TypeError('galatea-channels: createChannelRuntime returned no runtime')
            }
            // 先登记再判断：卸载发生在这次 await 期间时，晚返回的实例也由
            // release 关闭。
            state.runtime = runtime
            if (state.closed) return

            ctx.provide(SERVICE, runtime)

            // 只订阅真实 session 事件：没有 binding 时不读取默认渠道会话，也不建
            // Session/Agent/配对。订阅失败不致命，路由照常服务。
            watchSessionTurns()
            watchQuota()
            watchHealth()
            mountRoutes()
            mountVoiceOutput()
        } catch (error) {
            // 启动失败也要归还已取得的 runtime/域/租约；两类失败都保持可见。
            const failures = await closeAcquired()
            if (failures.length === 0) throw error
            throw new AggregateError([error, ...failures], 'galatea-channels: startup and cleanup failed')
        }
    }

    /**
     * 真实普通会话结束一个回合后唤醒 runtime。
     *
     * 启动时只订阅，不取默认渠道会话、不缓存任何“中枢 id”：没有 binding 就没有
     * session getter 副作用，也不会创建 Session/Agent/配对。事件里真实 Session 的 id
     * 原样传给 runtime.wake(sessionId)，runtime 只对账绑定到该会话的渠道，因此非绑定
     * 会话的 turn/end 不产生任何发送。失败不致命，路由照常服务，日志只留稳定 code。
     */
    function watchSessionTurns() {
        /**
         * 一个 session 事件折叠成 runtime 的唤醒信号。
         *
         * 只认真实 `turn/end`：子 agent 的回合结束不是本渠道的回复时机；是否属于
         * 渠道绑定由 runtime 按 bindings.sessionId 筛。另认 `llm/retry` 的第一回，
         * 交给 runtime.noticeStall 告诉对方在等恢复（断网与短暂限流）；以错误结束的一轮，看一次额度现状
         * （是不是额度用完由 runtime 问框架核心），需要就发固定说明。
         */
        const onSessionEvent = (eventSession, event) => {
            try {
                if (state.closed) return
                if (eventSession === null || typeof eventSession !== 'object') return
                if (event === null || typeof event !== 'object') return
                const sessionId = eventSession.id
                if (typeof sessionId !== 'string' || sessionId === '') return
                const runtime = state.runtime
                if (runtime === null) return
                // 一次失败的第一回重试：告诉对方在等网络或服务恢复。
                if (event.type === 'llm/retry' && event.data?.retry === 1 && typeof runtime.noticeStall === 'function') {
                    runtime.noticeStall({ sessionId, code: event.data.failure?.code }).catch((error) => {
                        ctx.logger.warn(`galatea-channels: stall notice failed (${codeOf(error)})`)
                    })
                    return
                }
                // 一轮进行中渠道先扣着新消息，结束时一并合成一条交给助手。
                if (event.type === 'turn/start' && typeof runtime.markSessionBusy === 'function') {
                    runtime.markSessionBusy(sessionId, true)
                    return
                }
                if (event.type !== 'turn/end' || typeof runtime.wake !== 'function') return
                runtime.markSessionBusy?.(sessionId, false)
                if (event.data?.reason?.kind === 'error') sweepQuota()
                const result = runtime.wake(sessionId)
                if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
                    result.then(noop, (error) => {
                        ctx.logger.warn(`galatea-channels: wake failed (${codeOf(error)})`)
                    })
                }
            } catch (error) {
                // `wake` runs inside an event dispatch that must not fail
                // because one channel misbehaved.
                ctx.logger.warn(`galatea-channels: wake failed (${codeOf(error)})`)
            }
        }

        let dispose
        try {
            dispose = ctx.on('session/event', onSessionEvent, { global: true })
        } catch (error) {
            ctx.logger.warn(`galatea-channels: wake disabled (${codeOf(error)})`)
            return
        }
        state.wakeDisposer = typeof dispose === 'function' ? dispose : null
    }

    /** 按额度现状发额度说明与用量提醒：现状由 runtime 问框架核心，渠道不认具体执行方。 */
    function sweepQuota() {
        const runtime = state.runtime
        if (runtime === null || typeof runtime.sweepQuota !== 'function') return
        runtime.sweepQuota().catch((error) => {
            ctx.logger.warn(`galatea-channels: quota notice failed (${codeOf(error)})`)
        })
    }

    /** 定时自查：断开、没送到的经核心报出来。 */
    function watchHealth() {
        const minutes = config?.health?.checkMinutes ?? 10
        if (minutes <= 0) return
        const timer = setInterval(() => {
            state.runtime?.checkHealth?.().catch?.((error) => {
                ctx.logger.warn(`galatea-channels: health check failed (${codeOf(error)})`)
            })
        }, minutes * 60_000)
        timer.unref?.()
        state.healthTimer = timer
    }

    /** 定时再看一次：休息时段结束后补发、用量过档但没有一轮结束的时候也能发出。 */
    function watchQuota() {
        const minutes = config?.quotaNotices?.sweepMinutes ?? 5
        if (minutes <= 0) return
        const timer = setInterval(sweepQuota, minutes * 60_000)
        timer.unref?.()
        state.quotaTimer = timer
    }

    /**
     * Mount the owner-only routes on the official Connection surface.
     *
     * A conditional sub-context, not a declared dependency and not an `await`:
     * the routes appear whenever (and if ever) a browser-facing host publishes
     * Connection, and nothing about startup waits on it.
     */
    /** 装了语音合成服务的说话工具（`ttsSay`）时注册“发到聊天”去向；没装时什么都不做，装上或卸下随时跟着变。 */
    function mountVoiceOutput() {
        if (state.closed) return
        let pending
        try {
            pending = ctx.inject(['ttsSay'], (injected) => {
                if (state.closed || state.runtime === null) return
                const say = injected.get('ttsSay')
                if (typeof say?.registerOutput !== 'function') return
                const runtime = state.runtime
                injected.effect(() => say.registerOutput(voiceOutput(runtime)), 'galatea-channels: voice output')
            })
        } catch (error) {
            ctx.logger.warn(`galatea-channels: voice output not registered (${codeOf(error)})`)
            return
        }
        if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
            pending.then(noop, (error) => {
                ctx.logger.warn(`galatea-channels: voice output not registered (${codeOf(error)})`)
            })
        }
    }

    function mountRoutes() {
        if (state.closed) return
        let pending
        try {
            pending = ctx.inject(['connection'], (injected) => {
                if (state.closed) return
                const connection = injected.get('connection')
                if (connection === null || connection === undefined) return
                const runtime = state.runtime
                if (runtime === null) return
                // `ctx.effect` here, so unloading this plugin removes exactly the
                // routes it registered - and with them the ability to pair.
                injected.effect(() => {
                    const dispose = registerChannelRoutes(connection, runtime, { qrToSvg: qrToSvg })
                    return () => dispose()
                }, 'galatea-channels: routes')
            })
        } catch (error) {
            ctx.logger.warn(`galatea-channels: routes not mounted (${codeOf(error)})`)
            return
        }
        // Never awaited: on a headless profile Connection never appears, and a
        // pending inject must not become a startup gate. A rejection here is
        // reported as a code, not as a token-bearing message.
        if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
            pending.then(noop, (error) => {
                ctx.logger.warn(`galatea-channels: routes not mounted (${codeOf(error)})`)
            })
        }
    }

    /**
     * 关闭本 Host 已取得的 runtime → domain → lease，按此顺序返回失败列表。
     *
     * runtime 或 domain 没能干净关闭时保留租约：第二个 Host 不能与未排空的发送
     * 并行。这里不假称已经释放。
     */
    async function closeAcquired() {
        const failures = []
        if (state.sealed) return failures

        const runtime = state.runtime
        state.runtime = null
        if (runtime !== null) {
            try {
                await runtime.close()
            } catch (error) {
                failures.push(error)
            }
        }

        const domain = state.domain
        state.domain = null
        if (domain !== null) {
            try {
                await domain.close()
            } catch (error) {
                failures.push(error)
            }
        }

        if (failures.length > 0) {
            state.sealed = true
            return failures
        }

        if (state.lease !== null) {
            const lease = state.lease
            state.lease = null
            try {
                await lease.release()
            } catch (error) {
                failures.push(error)
            }
        }
        return failures
    }

    /**
     * 卸载顺序：停 wake → 等 acquisition 收敛 → runtime.close 排空发送 →
     * domain.close → 释放自己的租约。
     *
     * 启动失败已由 apply 报告；这里只等它收敛，再把实际取得的对象关掉。关闭没
     * 走完时租约保留（见 closeAcquired），第二个 Host 因此拿不到锁。
     */
    async function release() {
        const failures = []
        if (state.healthTimer !== null) {
            clearInterval(state.healthTimer)
            state.healthTimer = null
        }
        if (state.quotaTimer !== null) {
            clearInterval(state.quotaTimer)
            state.quotaTimer = null
        }

        if (state.wakeDisposer !== null) {
            const disposeWake = state.wakeDisposer
            state.wakeDisposer = null
            try {
                disposeWake()
            } catch (error) {
                failures.push(error)
            }
        }

        if (state.acquisition !== null) {
            await state.acquisition.catch(noop)
        }

        const closeFailures = await closeAcquired()
        failures.push(...closeFailures)

        if (failures.length > 0) throw failures[0]
    }
}
