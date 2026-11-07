/**
 * 执行方 `core.executors`：原生、Claude Code，以及以后的第三方。
 *
 * - 登记时声明必备能力和可选能力；缺一项必备的就不能注册。可选能力没有的，报"某执行方没有某能力，所以……"，
 *   每项一条（subject 是"执行方/能力名"）；上次报过的缺失集合存起来，只报这次新缺的，原来缺、现在有了的报 resolved。
 *   每次启动都把同样几条重报一遍，会把真变化淹没。原生不在登记时报：它的可选能力由上下文模块随后补上。
 * - 一个会话归哪个执行方，是会话本身的数据，不看它当下有没有被加载：按会话持久的模型选择问各执行方的 `handles`
 *   （先问别的执行方，按登记先后；都不接的归原生，原生由核心自己登记）。模型选择读不出来的，报 `core/executor-unknown`，
 *   不归任何执行方，也不悄悄归给原生。
 * - 能力的值就是它的实现，一件事只说一遍（和额度闸门一样）：
 *   - 必备：`newConversation(sessionId, document)` 换新对话、`usage(sessionId)` 交回 `{ tokens, window, epoch }`
 *     （换新对话或压缩一次 `epoch` 就变一次）是函数；其余几项写 `true`；
 *   - 可选：`compact(sessionId, {instructions})` 是函数，兜底压缩线是 `fallbackThreshold: { set(tokens) }`，
 *     额度闸门是 `quotaGate: { state(sessionId), codes, detail? }`，其余写 `true`；没有的能力就不写。
 *     `detail(sessionId)` 只交补充的字段 `{ since, resetsAt, window, outageId, windows }`（`windows`：`{ <窗口>: { utilization, resetsAt } }`，
 *     `utilization` 是 0–1 的占比）；状态只从 `state` 一处来，两边不会说法不一致。
 *     会话的活动是 `activity(sessionId)` → `{ background, lastOutputAt }`（会话里还在跑的后台任务数、进程最后一次输出的时间），
 *     Watchdog 看"项目任务多久没活动"时用；没有这项能力的执行方，只能看日志的时间。
 * - 原生由核心自己登记；它的换新对话、用量、主动压缩、兜底压缩线由上下文模块的压缩引擎提供（`provideNative`），
 *   没装那个引擎时，换新对话写明做不了、用量为 `null`、没有主动压缩；启动完成时还是这样就报一次 `core/native-engine-missing`
 *   （配置错了要让人看见，不等到有人调交接工具），引擎装上以后又卸下也报。
 * - 额度闸门是执行方的能力，不在核心：`core.quota.state(sessionId)` 按这个会话的执行方作答，没有闸门的答 `unknown`；
 *   读的一方一律把 `unknown` 当成"可以继续"。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/executors
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** 各执行方上次报过缺哪些可选能力（按执行方编号）。 */
export const executorsDomainSpec = defineDomain({
    name: 'mind_framework_core_executors',
    version: 1,
    layout: 'per-record',
    tables: {
        capabilities: {
            valueSchema: z.object({ missing: z.array(z.string()), at: z.number() }).strict(),
        },
    },
})

export const REQUIRED = Object.freeze({
    runTurn: '跑一轮（分好类的提问和参考、附提醒；只有参考的一轮也照常跑；交回最终文字和用量）',
    openingSegments: '开新对话时把开头的段放进开头',
    perTurnContext: '每轮附上附提醒和段的变更说明',
    toolEndpoint: '接核心的工具端点',
    interrupt: '中断',
    usage: '每轮报上下文用量和窗口大小',
    newConversation: '换新对话（开头的段加一份交接文档重新开始）',
})

/** 必备能力里值必须是函数的（其余写 `true`）。 */
export const REQUIRED_FUNCTIONS = Object.freeze(['newConversation', 'usage'])
/** 可选能力里值的样子：函数，或带某些方法的对象；其余写 `true`。 */
const OPTIONAL_SHAPES = Object.freeze({
    compact: value => typeof value === 'function',
    fallbackThreshold: value => typeof value?.set === 'function',
    quotaGate: value => typeof value?.state === 'function'
        && (value.codes === undefined || (Array.isArray(value.codes) && value.codes.every(code => typeof code === 'string')))
        && (value.detail === undefined || typeof value.detail === 'function'),
    activity: value => typeof value === 'function',
    boundary: value => typeof value?.landed === 'function',
    handoffTurn: value => typeof value === 'function',
})

/** 可选能力，以及没有时框架怎么办。 */
export const OPTIONAL = Object.freeze({
    resume: '每次都按换新对话处理，交接文档取最近一次的',
    compact: '压缩工具对这个执行方的会话不交',
    compactInstructions: '压缩时指定要保留的内容用不上，压缩工具的结果里写明按默认压缩',
    resendAfterCompaction: '下一轮把改过的段整段附上',
    fallbackThreshold: '兜底压缩不可控',
    steer: '附提醒等下一轮',
    quotaGate: '额度用完按普通失败一轮处理，额度状态答 unknown',
    endCheck: '没有轮末检查',
    surface: '不支持后台自己开的一轮',
    skillFilter: '交全部 skill',
    imageAccounting: '不做图片累计提醒',
    activity: '看不出会话里有没有后台任务在跑、进程最后一次输出在什么时候，只能看日志的时间',
    boundary: 'DSH 记录里落下边界以后执行方不知道，下一轮按从头交接处理',
    handoffTurn: '切到别的执行方、历史放不下时不能先写交接，只能用最近的记录裁剪着交过去',
})

/**
 * @param deps.selectionOf - 读会话持久的模型选择（异步；读不出来时为 `undefined`）。
 * @param deps.report - 报异常。
 * @param deps.domain - 存上次报过的缺失能力（`executorsDomainSpec`）；没有时每次登记都照报。
 * @param deps.now - 取当前时间（测试用）。
 */
export function createExecutors({ selectionOf, report, domain, now = Date.now }) {
    const registered = []
    let native
    /** 原生的换新对话等是不是已经由压缩引擎补上了（`provideNative` 的撤销没调过）。 */
    let nativeProvided = false
    const NATIVE_MISSING = '原生没装压缩引擎，换新对话、主动压缩都做不了'

    /** 同一执行方的核对排队依次做：上一次还没存下集合，下一次就去读，会把同样几条重报一遍（快速重复登记时）。 */
    const capabilityChecks = new Map()
    function reportCapabilities(id, missingNow) {
        const next = (capabilityChecks.get(id) ?? Promise.resolve()).then(() => checkCapabilities(id, missingNow))
        capabilityChecks.set(id, next.catch(() => {}))
        return next
    }

    /** 和上次报过的比：新缺的各报一条，原来缺、现在有了的报 resolved，没变就不报；存下这次的集合。 */
    async function checkCapabilities(id, missingNow) {
        const table = domain?.table('capabilities')
        const before = table === undefined ? null : (await table.get(id))?.missing ?? null
        const known = new Set(before ?? [])
        const added = missingNow.filter(name => !known.has(name))
        const back = [...known].filter(name => !missingNow.includes(name))
        if (added.length === 0 && back.length === 0 && before !== null) return
        // 先存后报：存不下就都不报（出错由调用方报 core/internal），下次登记照旧和存着的比，变化不会被吞掉。
        if (table !== undefined) await table.put(id, { missing: [...missingNow].sort(), at: now() })
        for (const name of added) {
            report('core/executor-capability-missing', { text: `执行方 ${id} 没有"${name}"，所以${OPTIONAL[name]}`, data: { subject: `${id}/${name}`, executor: id, capability: name } })
        }
        for (const name of back) {
            report('core/executor-capability-missing', { text: `执行方 ${id} 有了"${name}"`, data: { subject: `${id}/${name}`, executor: id, capability: name, resolved: true } })
        }
    }

    /**
     * 登记一个执行方。
     * @param definition - `{ id, handles(selection), required: {能力: true…}, optional: {能力: true | 对象…} }`；
     *   `optional.quotaGate` 要是 `{ state(sessionId) }`。
     * @param options.native - 核心自己登记原生用：兜底，不按 `handles` 先问。
     * @returns 撤销登记。
     */
    function register(definition, { native: isNative = false } = {}) {
        const { id, handles, required = {}, optional = {} } = definition ?? {}
        if (typeof id !== 'string' || id === '') throw new TypeError('执行方要有 id')
        if (typeof handles !== 'function') throw new TypeError(`执行方 ${id} 要有 handles`)
        const missing = Object.keys(REQUIRED).filter(name => (REQUIRED_FUNCTIONS.includes(name) ? typeof required[name] !== 'function' : required[name] !== true))
        if (missing.length > 0) throw new Error(`执行方 ${id} 缺必备能力：${missing.map(name => `${name}（${REQUIRED[name]}）`).join('；')}`)
        const unknown = Object.keys(optional).filter(name => !(name in OPTIONAL))
        if (unknown.length > 0) throw new TypeError(`执行方 ${id} 声明了没有的可选能力：${unknown.join('、')}`)
        const malformed = Object.entries(optional)
            .filter(([name, value]) => value !== false && value !== undefined && (OPTIONAL_SHAPES[name] ?? (v => v === true))(value) !== true)
            .map(([name]) => name)
        if (malformed.length > 0) {
            throw new TypeError(`执行方 ${id} 的可选能力写得不对：${malformed.join('、')}（compact、activity、handoffTurn 是函数，fallbackThreshold 要有 set，quotaGate 要有 state，boundary 要有 landed，其余写 true）`)
        }
        if (registered.some(item => item.id === id) || native?.id === id) throw new Error(`执行方 ${id} 已经登记过`)
        const value = { id, handles, required: { ...required }, optional: { ...optional } }
        if (isNative) native = value
        else registered.push(value)
        // 原生的能力会由上下文模块补上（provideNative），别的执行方登记了就不变。
        if (!isNative) {
            Object.freeze(value.required)
            Object.freeze(value.optional)
        }
        // 原生的可选能力由上下文模块随后补上，登记这一刻缺的不算数。
        if (!isNative) {
            const missingNow = Object.keys(OPTIONAL).filter(name => optional[name] === undefined || optional[name] === false)
            reportCapabilities(id, missingNow).catch(error => report('core/internal', { text: `核对执行方 ${id} 的缺失能力出错（${error?.message ?? error}）` }))
        }
        return () => {
            if (isNative && native === value) native = undefined
            const index = registered.indexOf(value)
            if (index >= 0) registered.splice(index, 1)
        }
    }

    /** 这个会话归哪个执行方；模型选择读不出来时为 `undefined`，并报一条。 */
    async function executorOf(sessionId) {
        const id = String(sessionId)
        let selection
        try {
            selection = await selectionOf(id)
        } catch (error) {
            selection = undefined
            report('core/executor-unknown', { sessionId: id, text: `会话 ${id} 的模型选择读不出（${error?.message ?? error}），认不出归哪个执行方` })
            return undefined
        }
        if (selection === undefined) {
            report('core/executor-unknown', { sessionId: id, text: `会话 ${id} 的模型选择读不出，认不出归哪个执行方` })
            return undefined
        }
        return executorFor(selection, id)
    }

    /**
     * 某个模型选择归哪个执行方（不看会话）：切模型时按请求头里的新旧选择各问一次。
     * @param selection - `{ provider, model }`。
     * @param sessionId - 只用在报异常里。
     */
    function executorFor(selection, sessionId) {
        for (const executor of registered) {
            try {
                if (executor.handles(selection) === true) return executor
            } catch (error) {
                report('core/executor-handles-threw', { ...sessionId === undefined ? {} : { sessionId }, text: `执行方 ${executor.id} 的 handles 抛错（${error?.message ?? error}），跳过它` })
            }
        }
        return native
    }

    /** 这个会话的执行方有没有某项可选能力（认不出执行方的算没有）。 */
    async function has(sessionId, capability) {
        const value = (await executorOf(sessionId))?.optional[capability]
        return value !== undefined && value !== false
    }

    /** 额度状态：按这个会话的执行方作答，没有闸门、认不出执行方的答 `unknown`。 */
    async function quotaState(sessionId) {
        const gate = (await executorOf(sessionId))?.optional.quotaGate
        if (gate === undefined) return 'unknown'
        try {
            const state = await gate.state(String(sessionId))
            return ['ok', 'limited', 'unknown'].includes(state) ? state : 'unknown'
        } catch (error) {
            report('core/quota-state-failed', { sessionId: String(sessionId), text: `额度状态读不出（${error?.message ?? error}），按 unknown` })
            return 'unknown'
        }
    }

    /**
     * 额度现状加上补充的字段（出口说额度用完、用量提醒时用）：`state` 取 `quotaState`，其余取闸门的 `detail`；
     * 没有 `detail`、或读不出时，补充的字段都是 null。只交这几个字段，执行方多给的不往外传。
     */
    async function quotaDetail(sessionId) {
        const state = await quotaState(sessionId)
        const empty = { since: null, resetsAt: null, window: null, outageId: null, windows: null }
        const gate = (await executorOf(sessionId))?.optional.quotaGate
        if (typeof gate?.detail !== 'function') return { state, ...empty }
        let detail
        try {
            detail = await gate.detail(String(sessionId))
        } catch (error) {
            report('core/quota-detail-failed', { sessionId: String(sessionId), text: `额度详情读不出（${error?.message ?? error}），只给状态` })
            return { state, ...empty }
        }
        const pick = key => (detail?.[key] === undefined ? null : detail[key])
        return { state, since: pick('since'), resetsAt: pick('resetsAt'), window: pick('window'), outageId: pick('outageId'), windows: pick('windows') }
    }

    /**
     * 会话的活动（执行方的可选能力 `activity`）：`{ background, lastOutputAt }`，`background` 是还在跑的后台任务数，
     * `lastOutputAt` 是进程最后一次输出的时间（没有为 null）。执行方没有这项能力、认不出执行方、或读不出时为 null。
     */
    async function activity(sessionId) {
        const read = (await executorOf(sessionId))?.optional.activity
        if (typeof read !== 'function') return null
        let value
        try {
            value = await read(String(sessionId))
        } catch (error) {
            report('core/activity-failed', { sessionId: String(sessionId), text: `会话的活动读不出（${error?.message ?? error}），只能看日志的时间` })
            return null
        }
        if (value === null || value === undefined) return null
        const background = Number.isInteger(value.background) && value.background > 0 ? value.background : 0
        const lastOutputAt = Number.isFinite(value.lastOutputAt) ? value.lastOutputAt : null
        return { background, lastOutputAt }
    }

    /**
     * 这一轮以这个错误码结束，是不是"额度用完、由执行方的闸门恢复后唤醒"的那种（这种不算失败的一轮）。
     * 执行方的 `quotaGate.codes` 列出它报额度用完时用的错误码；没有闸门的执行方，额度用完照普通失败处理。
     */
    async function gatedFailure(sessionId, code) {
        const codes = (await executorOf(sessionId))?.optional.quotaGate?.codes ?? []
        return codes.includes(code)
    }

    /**
     * 上下文模块的压缩引擎给原生补上换新对话、用量、主动压缩、兜底压缩线。
     * @returns 撤销（换回"做不了"的那一份）。
     */
    function provideNative({ newConversation, usage, compact, fallbackThreshold } = {}) {
        if (native === undefined) throw new Error('原生执行方还没登记')
        if (typeof newConversation !== 'function' || typeof usage !== 'function') throw new TypeError('provideNative 要给 newConversation 和 usage')
        const before = { required: { ...native.required }, optional: { ...native.optional } }
        if (nativeProvided) throw new Error('原生的换新对话等已经由一个压缩引擎补上了')
        const target = native
        target.required.newConversation = newConversation
        target.required.usage = usage
        if (typeof compact === 'function') target.optional.compact = compact
        if (typeof fallbackThreshold?.set === 'function') target.optional.fallbackThreshold = fallbackThreshold
        nativeProvided = true
        return () => {
            target.required = before.required
            target.optional = before.optional
            nativeProvided = false
            // 核心自己卸下时原生也跟着走，不用报；只有原生还在、引擎走了，才是"现在做不了了"。
            if (native === target) report('core/native-engine-missing', { text: `原生的压缩引擎卸下了：${NATIVE_MISSING}` })
        }
    }

    /** 启动完成时调：原生用的还是做不了的那一份，就报一次。 */
    function checkNative() {
        if (native !== undefined && !nativeProvided) report('core/native-engine-missing', { text: NATIVE_MISSING })
    }

    function list() {
        return [...registered, ...native === undefined ? [] : [native]].map(({ id, optional }) => ({ id, optional: Object.keys(optional).filter(name => optional[name] !== false) }))
    }

    return Object.freeze({ register, executorOf, executorFor, has, quotaState, quotaDetail, activity, gatedFailure, provideNative, checkNative, list })
}
