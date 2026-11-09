/**
 * 上下文模块的原生压缩引擎：继承上游的 `BasicCompactionEngine`，作为 `compaction` 服务注册，
 * 给原生会话补上换新对话、用量、主动压缩、兜底压缩线（经 `core.executors.provideNative`），
 * 也替所有执行方在 DSH 记录里落边界。
 *
 * - **和上游的 compaction-basic 同时存在**：profile 顶层的那一行可以停用，但 DSH 的 web 预设每个都在 Agent 的子插件里、
 *   隔离的服务域中各带一份，停用够不到，patch 也只能整行替换预设的配置。这几份都收到会话的事件，而且排在这里前面。
 *   所以这里启动时接管上游引擎的入口（`takeOverUpstream`）：别的实例不再自动压缩（步间压力、切模型、溢出恢复），
 *   手动压缩（预设里的 `/compact`）转交这里。全部会话的压缩只有这一处管，配置的线和策略才算数。
 *   顶层没装这个引擎、只装了上游的，启动完成时核心会报"原生没装压缩引擎"。
 * - 阈值：上下文模块经 `fallbackThreshold.set` 给一个绝对的 token 数；按目标模型的上下文窗口现算成比例，
 *   通过 `config` 交给上游的压缩判断（上游的配置构造时就冻结了，所以 `config` 换成按当前阈值算的 getter）。
 *   要知道窗口，覆盖了上游 TS 里标成 private 的 `compactPressure`：步间压力、换模型两条路都经过它。
 *   上游哪天把它改成真正的私有，守护测试先失败，不悄悄退回冻结的阈值。
 * - **边界**：DSH 记录里一段被一份文字换掉的地方（交接、Claude Code 自己压缩过、切走前写的交接）。都等会话空下来做一次
 *   `compactNow`（保留系统开头和最后一个节点，替换其余全部），这一次的 `summarize()` 交回给定的文字，不调模型。
 *   文字比被替换的内容还长时上游的缩短检查不通过，边界没落下，原因经核心报出来。
 *   落下后在会话日志里写一条插件记录 `plugin:mind-framework/boundary`（`{ compactionId, kind, executor, … }`），
 *   边界是哪一种看这条记录，不看摘要的文字；没有这条记录的压缩是上游按模型摘要的普通压缩。
 *   边界替哪个执行方的对话落下，就告诉它（可选能力 `boundary.landed`），它据此认得这份摘要是自己已经知道的。
 * - 交接：原生的换新对话就是落一次交接边界；别的执行方换过新对话以后，上下文模块再请这里落一次（`landBoundary`）。
 *   原生的交接没落下时，失败也附在会话的下一轮（还在原来的对话里）。
 *   交接边界在文档后面接上最近几轮原文（`context.recentTurns`），不分执行方：之后切到原生，看到的就是这段；加上它放不下就只留文档。
 *   外部执行方的新对话不看这个边界的正文（它是已知的），原文由它在新对话开头交。
 * - 外部执行方（不是原生的）自己管上下文：它们的会话不做 DSH 侧的压缩（压力、溢出恢复都不做），切到它们也不压；
 *   手动压缩转交执行方自己（可选能力 `compact`）。落边界不算压缩，照做。
 *   从外部执行方切到原生、历史放不下目标窗口时，不按模型摘要（旧的路由摘要整段历史会超过它自己的上限），
 *   先请原来的执行方跑一轮看不见的交接（可选能力 `handoffTurn`），交接文档写进工作目录的「交接」文件夹，读回来不空才用；
 *   做不了时用最近的记录裁剪着交过去，开头写明省略了多少、原文在经历库。
 *   这里每次压缩一提交就记边界（`compactRegion`）：上游可能再压一轮，后面那轮失败时，前面落下的不能没有记录。
 * - 执行方自己压缩过的摘要（`auto-compact`、`compact`）只说得清它那段对话：写摘要的执行方自己说明是谁（`by`），
 *   等到会话空下来时，请求已经路由到别的执行方了就不落，不然旧摘要会换掉切过去以后的新记录（切走时写交接压缩的、切走后后台轮压缩的都是这样）。
 * - 主动压缩：同样等会话空下来做 `compactNow`，摘要照上游。上游的摘要不收额外要求，所以不声明 `compactInstructions`，
 *   上下文模块在压缩工具的结果里写明按默认压缩。
 * - 用量：`{ tokens, window, epoch }`；`epoch` 是这个进程里这个会话成功压缩的次数（落边界也是一次压缩）。
 *
 * @module @loveandbeepbrother/dsh-galatea/context/engine
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { BOUNDARY_RECORD } from './recent.js'

export const name = 'mind-framework-compaction'
/** 交接文档在新上下文里的开头。 */
export const HANDOFF_LEAD = '（交接，不是用户发言：上一段对话结束前你自己写的交接文档，从这里接着做。）'
/** 切模型前原来的模型写的交接文档在新上下文里的开头。 */
export const SWITCH_LEAD = '（换模型，不是用户发言：上一段由别的模型处理，下面是它切走前写的交接文档，从这里接着做。）'
/** Claude Code 等执行方自己压缩过上下文时，它的摘要在 DSH 记录里的开头。 */
export const COMPACTED_LEAD = '（压缩，不是用户发言：这之前的对话已经压缩成下面的摘要，原文在经历库。）'
/** 交接没做成时附在会话下一轮的提醒的键。 */
export const HANDOFF_FAILED_KEY = 'context-handoff-failed'
export { BOUNDARY_RECORD }
/** 边界的种类：交接、切模型、执行方自己自动压缩过、执行方按指令压缩过。 */
export const BOUNDARY_KINDS = Object.freeze(['handoff', 'switch', 'auto-compact', 'compact'])
/** 执行方自己压缩留下的边界：正文是它那段对话的摘要。 */
const OWN_COMPACTION = new Set(['auto-compact', 'compact'])
/** 切到原生又写不了交接时，交过去的最近记录最多多少字。 */
export const SWITCH_TAIL_CHARS = 60_000
/** 原生模型最晚压到窗口的这个比例（和上游的默认一样）：窗口比兜底压缩线还小的模型，等到快满才压容易先撞窗口。 */
const NATIVE_MAX_RATIO = 0.8
/** 交接文档加最近几轮不到被换掉内容的这个比例，才带最近几轮（留出外面那层说明的余量）。 */
const RECENT_FITS = 0.8
/** 原生执行方的编号（核心自己登记的）。 */
const NATIVE = 'native'

const messageOf = error => error?.message ?? String(error)
const LEADS = { handoff: HANDOFF_LEAD, switch: SWITCH_LEAD, 'auto-compact': COMPACTED_LEAD, compact: COMPACTED_LEAD }
/** 同一个会话等着做的事只留一件：排得高的不被排得低的取代。 */
const rank = job => (job.kind === 'compact' ? 0 : job.boundary === 'handoff' ? 2 : 1)

/**
 * 接管上游引擎的入口（见模块说明）：改的是上游类的原型，覆盖所有实例，包括预设里隔离的那几份。
 * 上游哪天改了这几个方法的名字或调用路径，守护测试先失败。
 * @param engine - 接手的实例。
 * @returns 还原。
 */
function takeOverUpstream(engine) {
    const proto = BasicCompactionEngine.prototype
    const { compactPressure, compactIfNeeded, compactNow } = proto
    const ours = instance => instance instanceof MindCompactionEngine
    proto.compactPressure = function (...args) {
        return ours(this) ? compactPressure.apply(this, args) : Promise.resolve(null)
    }
    proto.compactIfNeeded = function (...args) {
        return ours(this) ? compactIfNeeded.apply(this, args) : Promise.resolve(null)
    }
    proto.compactNow = function (...args) {
        return ours(this) ? compactNow.apply(this, args) : engine.compactNow(...args)
    }
    return () => Object.assign(proto, { compactPressure, compactIfNeeded, compactNow })
}

/** 一条消息的文字（裁剪记录用）：图片、文件只放占位。 */
function plainText(message) {
    return (message.content ?? []).map(block => {
        if (block.type === 'text') return block.text
        if (block.type === 'image') return '[图片]'
        if (block.type === 'file') return '[文件]'
        if (block.type === 'tool-call') return `[调用工具 ${block.name}]`
        return ''
    }).filter(text => text !== '').join('\n').trim()
}

/**
 * 执行方压缩之后、边界落下之前又进来的记录：摘要里没有它们，换掉就丢了，接在摘要后面。
 * @param messages - 这次要换掉的消息。
 * @param afterId - 执行方压缩时记录里最后一条的编号；没有或已经找不到时不接。
 */
function afterSummary(messages, afterId) {
    const index = afterId === undefined ? -1 : messages.findIndex(message => String(message.id) === afterId)
    if (index < 0) return ''
    const lines = messages.slice(index + 1)
        .filter(message => message.source?.kind !== 'runtime-context' && message.source?.kind !== 'time-context')
        .map(message => `[${message.role}]\n${plainText(message)}`)
        .filter(line => !line.endsWith(']\n'))
    return lines.length === 0 ? '' : `\n\n（这份摘要之后的记录：）\n${lines.join('\n\n')}`
}

/**
 * 写不了交接时交过去的记录：最近一份边界的文字（之前的交接、摘要）整份留着，之后的记录从最近往前放，放不下的省略并写明。
 * 运行时快照不放（每份都取代之前的，新模型的请求里另有最新的一份）。放进去的不超过原来的一半：要比换掉的短，边界才落得下。
 */
export function trimmedRecord(messages, limit = SWITCH_TAIL_CHARS) {
    const usable = messages.filter(message => message.role !== 'system' && message.role !== 'developer' && message.source?.kind !== 'runtime-context')
    const checkpoint = usable.find(message => message.source?.kind === 'compact-checkpoint')
    const lines = usable.filter(message => message !== checkpoint)
        .map(message => `[${message.role}]\n${plainText(message)}`)
        .filter(line => !line.endsWith(']\n'))
    const budget = Math.min(limit, Math.floor(lines.reduce((sum, line) => sum + line.length, 0) / 2))
    const kept = []
    let size = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (size + lines[index].length > budget) {
            // 最近的一条本身就放不下：留开头，写明截断。
            if (kept.length === 0) kept.unshift(`${lines[index].slice(0, budget)}……（这条后面截断了，原文在经历库）`)
            break
        }
        kept.unshift(lines[index])
        size += lines[index].length
    }
    const omitted = lines.length - kept.length
    const lead = '（换模型，不是用户发言：上一段由别的模型处理，切走前没能写交接。下面是最近的记录'
        + `${omitted > 0 ? `；更早的 ${omitted} 条省略了，原文在经历库，需要时用经历库的工具查` : ''}。）`
    return [lead, ...checkpoint === undefined ? [] : [plainText(checkpoint)], ...kept].join('\n\n')
}

/** 交接文档的文件名用的时刻（北京时间）。 */
function stamp(now = Date.now()) {
    const beijing = new Date(now + 8 * 3600_000).toISOString()
    return `${beijing.slice(0, 10).replaceAll('-', '')}-${beijing.slice(11, 16).replace(':', '')}`
}

export class MindCompactionEngine extends BasicCompactionEngine {
    static inject = [...BasicCompactionEngine.inject, 'core', 'agents']
    static Config = BasicCompactionEngine.Config

    constructor(ctx, config = {}) {
        super(ctx, config)
        const frozen = this.config
        /** `provider/model` → `{ provider, model, window }`：见过的目标模型的上下文窗口。 */
        this.windows = new Map()
        /** 上下文模块给的兜底压缩线（token）；没给时照上游的配置。 */
        this.fallback = undefined
        /** 每个会话等着空下来再做的一件事：`{ kind: 'boundary', boundary, text, … }` 或 `{ kind: 'compact', resolve }`。 */
        this.jobs = new Map()
        /** 正在落的边界：`summarize()` 按会话取它的文字。 */
        this.landing = new Map()
        /** 正在从外部执行方切到原生的会话：`summarize()` 按会话做交接。 */
        this.switching = new Map()
        /** 每个会话成功压缩的次数。 */
        this.epochs = new Map()
        Object.defineProperty(this, 'config', { configurable: true, enumerable: true, get: () => this.effectiveConfig(frozen) })
        ctx.effect(() => takeOverUpstream(this), 'mind-framework-compaction: upstream engines')

        ctx.on('agent/status', ({ agent, status }) => {
            if (status === 'idle') this.wake(agent)
        })
        ctx.on('session/event', (session, event) => {
            if (event?.type !== 'compaction/end' || event.data?.error !== undefined) return
            const id = String(session.id)
            this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
        }, { global: true })
        ctx.effect(() => ctx.core.executors.provideNative({
            newConversation: (sessionId, document, options) => this.newConversation(String(sessionId), document, options),
            usage: sessionId => this.usage(String(sessionId)),
            compact: (sessionId, options) => this.compactLater(String(sessionId), options),
            fallbackThreshold: { set: tokens => this.setFallback(tokens) },
        }), 'mind-framework-compaction: native capabilities')
    }

    setFallback(tokens) {
        if (!Number.isInteger(tokens) || tokens <= 0) throw new TypeError(`兜底压缩线要是正整数（${tokens}）`)
        this.fallback = tokens
    }

    /** 按兜底压缩线和见过的窗口，给每个目标模型现算 `thresholdRatio`；其余照冻结的配置。 */
    effectiveConfig(frozen) {
        if (this.fallback === undefined || this.windows.size === 0) return frozen
        const policies = frozen.modelPolicies.filter(policy => !this.windows.has(`${policy.provider}/${policy.model}`))
        for (const { provider, model, window } of this.windows.values()) {
            const own = frozen.modelPolicies.find(policy => policy.provider === provider && policy.model === model) ?? {}
            policies.push({ ...own, provider, model, thresholdRatio: Math.min(NATIVE_MAX_RATIO, this.fallback / window) })
        }
        return Object.freeze({ ...frozen, modelPolicies: Object.freeze(policies) })
    }

    async learnWindow({ provider, model }, signal) {
        if (this.fallback === undefined || !provider || !model) return
        const info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
        const window = info?.context?.contextWindow
        if (Number.isInteger(window) && window > 0) this.windows.set(`${provider}/${model}`, { provider, model, window })
    }

    /** 这个模型选择归哪个执行方；认不出时当原生。 */
    executorFor(config) {
        if (!config?.provider || !config.model) return undefined
        return this.ctx.core.executors.executorFor({ provider: config.provider, model: config.model })
    }

    /** 这个会话的请求最后路由到哪个执行方（不是现在选的：切模型时选择先变，请求后到）。说不清摘要是谁写的，那要写的一方自己说（`by`）。 */
    routedExecutor(agent) {
        return this.executorFor(agent.session.requestHeader()?.config)
    }

    /**
     * 覆盖上游的 private 方法（见模块说明）：先记下目标模型的窗口，阈值才按兜底压缩线现算。
     * 目标是外部执行方的不压；从外部执行方切到原生的，摘要由 `summarize()` 换成交接。
     */
    async compactPressure(agent, header, signal, requireBelowThreshold) {
        const target = this.executorFor(header.config)
        if (target !== undefined && target.id !== NATIVE) return null
        await this.learnWindow(header.config, signal)
        const from = this.executorFor(agent.session.requestHeader()?.config)
        if (from === undefined || from.id === NATIVE) return super.compactPressure(agent, header, signal, requireBelowThreshold)
        const sessionId = String(agent.session.id)
        // 写不了交接时裁剪的记录要放得进目标模型：按它的窗口和兜底压缩线里小的那个，一字按一个 token 算，只用四分之一。
        const window = this.windows.get(`${header.config.provider}/${header.config.model}`)?.window ?? Infinity
        const line = Math.min(window, this.fallback ?? Infinity)
        const state = { executor: from, limit: Number.isFinite(line) ? Math.min(SWITCH_TAIL_CHARS, Math.floor(line / 4)) : SWITCH_TAIL_CHARS }
        this.switching.set(sessionId, state)
        try {
            return await super.compactPressure(agent, header, signal, requireBelowThreshold)
        } finally {
            this.switching.delete(sessionId)
        }
    }

    /** 外部执行方的会话不做 DSH 侧压缩：步间压力和溢出恢复都从这里进。 */
    compactIfNeeded(agent, trigger, signal) {
        const routed = this.routedExecutor(agent)
        if (routed !== undefined && routed.id !== NATIVE) return Promise.resolve(null)
        return super.compactIfNeeded(agent, trigger, signal)
    }

    /** 手动压缩：选的是外部执行方时交给它自己压，这里不做模型摘要。落边界（`landing`）不调模型，照做。 */
    compactNow(agent, signal, sourceCommandId) {
        const sessionId = String(agent.session.id)
        if (!this.landing.has(sessionId)) {
            const selected = this.executorFor(agent.model?.current?.())
            if (selected !== undefined && selected.id !== NATIVE) return this.compactOnExecutor(selected, sessionId)
        }
        return super.compactNow(agent, signal, sourceCommandId)
    }

    /** @returns `null`（DSH 记录这边没有压缩；执行方压过以后，边界由它经 `land` 落）。 */
    async compactOnExecutor(executor, sessionId) {
        const compact = executor.optional?.compact
        if (typeof compact === 'function') await compact(sessionId)
        else this.ctx.core.report('context/compact-unavailable', { sessionId, text: `执行方 ${executor.id} 不能主动压缩，这次没压` })
        return null
    }

    /** 切模型时每次压缩一提交就记边界：提交了就在记录里了，不管上游之后再压一轮成不成。 */
    async compactRegion(start, end, agent, signal) {
        const result = await super.compactRegion(start, end, agent, signal)
        const state = this.switching.get(String(agent.session.id))
        if (state !== undefined) {
            this.recordBoundary(agent.session, result.compactionId, { boundary: 'switch', executor: state.executor, document: state.document, conversation: state.conversation })
        }
        return result
    }

    /** 落边界时交回给定的文字、切模型时交回交接（都不调模型）；其余照上游。 */
    async summarize(input, agent, signal) {
        const sessionId = String(agent.session.id)
        const landing = this.landing.get(sessionId)
        if (landing !== undefined) {
            // 边界要比换掉的短才落得下：加上最近几轮明显放不下（上下文还不大）就只留文档，不去碰上游的缩短检查。
            const replaced = input.messages.filter(message => message.role !== 'system').reduce((sum, message) => sum + plainText(message).length, 0)
            const withRecent = landing.recent === undefined ? '' : `${landing.text}\n\n${landing.recent}`
            const text = withRecent !== '' && withRecent.length < replaced * RECENT_FITS ? withRecent : landing.text
            return { summary: [{ type: 'text', text: `${text}${afterSummary(input.messages, landing.afterId)}` }], provider: 'mind-framework', model: landing.boundary }
        }
        const switching = this.switching.get(sessionId)
        if (switching !== undefined) {
            // 上游可能再压一轮：交接只写一次，之后照用；裁剪的记录按这一轮的内容重算。
            const text = switching.document !== undefined ? switching.summary : await this.switchSummary(sessionId, switching, input, agent, signal)
            switching.summary = text
            return { summary: [{ type: 'text', text }], provider: 'mind-framework', model: 'switch' }
        }
        return super.summarize(input, agent, signal)
    }

    /** 从外部执行方切到原生：先请它写交接，读回来不空才用；做不了时裁剪最近的记录。 */
    async switchSummary(sessionId, state, input, agent, signal) {
        if (state.trimmed === true) return trimmedRecord(input.messages, state.limit)
        const write = state.executor.optional?.handoffTurn
        const cwd = agent.session.header?.cwd
        let reason
        if (typeof write !== 'function') reason = `执行方 ${state.executor.id} 不能先写交接`
        else if (!cwd) reason = '会话没有工作目录，交接文档没地方放'
        else {
            const folder = join(cwd, '交接')
            const document = join(folder, `${stamp()}-换模型.md`)
            try {
                await mkdir(folder, { recursive: true })
                const answer = await write(sessionId, { path: document, signal })
                const text = (await readFile(document, 'utf8')).trim()
                if (text !== '') {
                    state.document = document
                    if (typeof answer?.conversation === 'string') state.conversation = answer.conversation
                    return `${SWITCH_LEAD}（${document}）\n\n${text}`
                }
                reason = '交接文档是空的'
            } catch (error) {
                signal?.throwIfAborted()
                reason = messageOf(error)
            }
        }
        this.ctx.core.report('context/switch-handoff-failed', { sessionId, text: `切模型前没能写交接（${reason}），改用最近的记录裁剪着交过去` })
        state.trimmed = true
        return trimmedRecord(input.messages, state.limit)
    }

    /** 记下边界的种类，告诉它替谁落的。 */
    recordBoundary(session, compactionId, { boundary, executor, document, conversation }) {
        const sessionId = String(session.id)
        try {
            appendPluginRecord(session, BOUNDARY_RECORD, {
                compactionId,
                kind: boundary,
                executor: executor?.id ?? NATIVE,
                ...document === undefined ? {} : { document },
                ...conversation === undefined ? {} : { conversation },
                at: Date.now(),
            })
        } catch (error) {
            this.ctx.core.report('context/boundary-record-failed', { sessionId, text: `边界的记录没写下（${messageOf(error)}）` })
        }
        const landed = executor?.optional?.boundary?.landed
        if (typeof landed !== 'function') return
        Promise.resolve()
            .then(() => landed(sessionId, { compactionId, kind: boundary, ...conversation === undefined ? {} : { conversation } }))
            .catch(error => this.ctx.core.report('context/boundary-landed-failed', { sessionId, text: `执行方 ${executor.id} 没接住落下的边界（${messageOf(error)}）` }))
    }

    async newConversation(sessionId, document, { onSwitched, ready } = {}) {
        let text
        try {
            text = (await readFile(document, 'utf8')).trim()
        } catch (error) {
            return { scheduled: false, reason: `交接文档读不到：${messageOf(error)}` }
        }
        if (text === '') return { scheduled: false, reason: '交接文档是空的' }
        // 交接之前的整理跑完再落边界。
        const land = () => this.schedule(sessionId, { kind: 'boundary', boundary: 'handoff', native: true, document, text: `${HANDOFF_LEAD}（${document}）\n\n${text}`, onSwitched })
        if (ready === undefined) land()
        else Promise.resolve(ready).then(land, land)
        return { scheduled: true }
    }

    /**
     * 等会话空下来落一个边界（上下文模块用）。
     * @param options.kind - `BOUNDARY_KINDS` 之一。
     * @param options.text - 边界的正文（交接文档、执行方的摘要），开头的说明这里按种类加。
     * @param options.executor - 替哪个执行方的对话落（落下后告诉它）。
     * @param options.by - `auto-compact`、`compact` 必须写：写这份摘要的执行方的编号。
     * @returns `{ landed: true, compactionId }`，或 `{ landed: false, reason }`。
     */
    landBoundary(sessionId, { kind, text, document, executor, conversation, by } = {}) {
        if (!BOUNDARY_KINDS.includes(kind)) throw new TypeError(`边界的种类只能是 ${BOUNDARY_KINDS.join('、')}`)
        const body = String(text ?? '').trim()
        if (body === '') return Promise.resolve({ landed: false, reason: '边界的正文是空的' })
        if (OWN_COMPACTION.has(kind) && (typeof by !== 'string' || by === '')) throw new TypeError(`${kind} 边界要写明写摘要的执行方（by）`)
        const lead = `${LEADS[kind]}${document === undefined ? '' : `（${document}）`}`
        const job = { kind: 'boundary', boundary: kind, text: `${lead}\n\n${body}`, document, executor, conversation, by }
        const place = extra => new Promise(resolve => this.schedule(String(sessionId), { ...job, ...extra, resolve }))
        if (!OWN_COMPACTION.has(kind)) return place({})
        // 记下这一刻记录里最后一条：边界要等空下来才落，这之后进来的不在这份摘要里。
        return this.ctx.core.readEvents(String(sessionId)).then((events) => {
            const last = events.findLast(event => event?.type === 'assistant/message' || (event?.type === 'user/message' && event.data?.id !== undefined))
            const id = last?.type === 'assistant/message' ? last.data?.message?.id : last?.data?.id
            return place(id === undefined ? {} : { afterId: String(id) })
        })
    }

    compactLater(sessionId) {
        return new Promise(resolve => this.schedule(sessionId, { kind: 'compact', resolve }))
    }

    /** 记下一件等会话空下来再做的事；同一个会话只留一件：交接优先，其次别的边界，再次压缩。 */
    schedule(sessionId, job) {
        const previous = this.jobs.get(sessionId)
        if (previous !== undefined && rank(previous) > rank(job)) {
            this.refuse(job, previous.boundary === 'handoff' ? '已经安排了交接，交接本身就会换掉旧的上下文' : '已经安排了别的边界')
            return
        }
        if (previous !== undefined) this.refuse(previous, '被之后安排的取代')
        this.jobs.set(sessionId, job)
        const agent = this.ctx.agents.get(SessionId(sessionId))
        if (agent !== undefined) this.wake(agent)
    }

    refuse(job, reason) {
        if (job.kind === 'compact') job.resolve?.({ compacted: false, reason })
        else job.resolve?.({ landed: false, reason })
    }

    wake(agent) {
        const sessionId = String(agent.session.id)
        if (!this.jobs.has(sessionId)) return
        // agent/status 在切换阶段时发：等这一步走完再开维护。
        setImmediate(() => {
            this.run(agent, sessionId).catch(error => this.ctx.core.report('context/engine-failed', { sessionId, text: `压缩引擎出错（${messageOf(error)}）` }))
        })
    }

    async run(agent, sessionId) {
        let job = this.jobs.get(sessionId)
        if (job === undefined || agent.status !== 'idle' || this.ctx.agents.get(SessionId(sessionId)) !== agent) return
        this.jobs.delete(sessionId)
        if (job.kind === 'boundary' && OWN_COMPACTION.has(job.boundary)) {
            const routed = this.routedExecutor(agent)
            if (routed?.id !== job.by) {
                this.ctx.logger?.info?.(`mind-framework: ${sessionId} 的${job.boundary}边界不落了：执行方 ${job.by} 已经切走`)
                this.refuse(job, `执行方 ${job.by} 已经切走，它的摘要不再换掉之后的记录`)
                return
            }
            job = { ...job, executor: routed }
        }
        const recent = job.boundary === 'handoff' ? await this.recentOf(sessionId) : ''
        let { result, failure } = await this.land(agent, sessionId, recent === '' ? job : { ...job, recent })
        // 估得放得下、上游算下来还是放不下：只留交接文档再落一次。
        if (recent !== '' && failure instanceof ManualCompactionError && failure.code === 'summary') {
            ({ result, failure } = await this.land(agent, sessionId, job))
        }
        if (failure instanceof ManualCompactionError && failure.code === 'busy') {
            // 抢在前面开了一轮：等下一次空下来。
            if (!this.jobs.has(sessionId)) this.jobs.set(sessionId, job)
            return
        }
        if (job.kind === 'boundary' && failure === undefined && result !== null) this.recordBoundary(agent.session, result.compactionId, job)
        await this.settle(sessionId, job, result, failure)
    }

    async land(agent, sessionId, job) {
        if (job.kind === 'boundary' && job.native === true && job.document !== undefined) {
            // 交接之前的整理可能往文档后面补过：落边界时再读。
            const current = await readFile(job.document, 'utf8').then(value => value.trim()).catch(() => '')
            if (current !== '') job.text = `${HANDOFF_LEAD}（${job.document}）\n\n${current}`
        }
        if (job.kind === 'boundary') this.landing.set(sessionId, job)
        try {
            return { result: await this.compactNow(agent, new AbortController().signal) }
        } catch (failure) {
            return { failure }
        } finally {
            this.landing.delete(sessionId)
        }
    }

    /** 最近几轮原文；拿不到就不带，报出来，不挡交接。 */
    async recentOf(sessionId) {
        try {
            return await this.ctx.get('context')?.recentTurns?.(sessionId) ?? ''
        } catch (error) {
            this.ctx.core.report('context/recent-turns-failed', { sessionId, text: `交接没带上最近几轮原文（${messageOf(error)}）` })
            return ''
        }
    }

    async settle(sessionId, job, result, failure) {
        if (job.kind === 'compact') {
            if (failure !== undefined) job.resolve({ compacted: false, reason: `压缩出错（${messageOf(failure)}）` })
            else job.resolve(result === null ? { compacted: false, reason: '没有可以压缩的内容' } : { compacted: true })
            return
        }
        let reason
        if (failure instanceof ManualCompactionError && failure.code === 'summary') reason = `上下文还不大，${job.boundary === 'handoff' ? '交接文档' : '边界的文字'}比现有对话还长`
        else if (failure !== undefined) reason = `落边界出错（${messageOf(failure)}）`
        else if (result === null) reason = '上下文里还没有可以换掉的内容'
        if (reason === undefined) {
            this.ctx.logger?.info?.(`mind-framework: ${sessionId} 落下了${job.boundary}边界${job.document === undefined ? '' : `（${job.document}）`}`)
            job.resolve?.({ landed: true, compactionId: result.compactionId })
            try {
                job.onSwitched?.({ at: Date.now(), landed: true })
            } catch (error) {
                this.ctx.core.report('context/handoff-callback-failed', { sessionId, text: `交接后的回调出错（${error?.message ?? error}）` })
            }
            return
        }
        job.resolve?.({ landed: false, reason })
        if (job.native !== true) {
            // 执行方那边已经换过或压过了：只是 DSH 记录没跟上，报出来，不告诉助手"还在原来的对话里"。
            this.ctx.core.report('context/boundary-failed', { sessionId, text: `DSH 记录里的${job.boundary}边界没落下：${reason}` })
            return
        }
        // 原生的交接失败落在看得见的一边：报出来，也附在下一轮告诉助手。
        this.ctx.core.report('context/handoff-failed', { sessionId, text: `交接没做成：${reason}` })
        await this.ctx.core.attach(sessionId, HANDOFF_FAILED_KEY,
            `（DSH 提示，不是用户发言）上次安排的交接没做成：${reason}。还在原来的对话里，交接文档在 ${job.document}。`)
    }

    /** `{ tokens, window, epoch }`；会话不在内存里时没有。 */
    async usage(sessionId) {
        const agent = this.ctx.agents.get(SessionId(sessionId))
        if (agent === undefined) return null
        const session = agent.session
        const tokens = this.ctx.tokenMeter.measure(session).totalTokens
        const target = session.requestHeader()?.config
        let window = null
        if (target?.provider && target.model) {
            try {
                window = (await this.ctx.llm.resolveModelInfo(target.provider, target.model))?.context?.contextWindow ?? null
            } catch {
                window = null
            }
        }
        return { tokens, window, epoch: this.epochs.get(sessionId) ?? 0 }
    }
}

export default MindCompactionEngine
