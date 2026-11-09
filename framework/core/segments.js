/**
 * 上下文段 `core.segments`：心智、记忆目录、待告知留言、附提醒、渠道约定这类按会话现算的段。
 *
 * - 核心替每个段向上游登记 `systemPrompt.context()`，原生每一步照旧生效。段的 `text` 可以异步：核心在
 *   `system-prompt/assemble` 中间件里按会话算好，写进缓存并换进这一次组装的结果；上游在组装以外读段时读缓存。
 * - 给谁分两层：`audience`（`opening` 所有执行方开对话就要；`native-only` 只描述原生运行环境）；
 *   哪个会话由 `text` 按会话现算，算出空串表示这个会话、这一轮没有，空的不交。
 * - 算的时候出错不给空串：`onError: 'note'`（默认）在段里写一句"<段名> 这一轮读取失败"并报异常；
 *   `'fail'` 让这一步失败、写明原因（缺了就不该往下跑的段）。读取失败不算内容变了：`open`、`changes` 不把失败那句
 *   记成这个对话看到的版本，这一轮只说一句"读取失败，沿用之前的版本"；开对话时就失败的段不记进基线，恢复后按新出现的段给全文。
 * - 别的执行方（Claude Code 等）开对话时用 `open` 取开头的全文，之后每一轮用 `changes` 取变更说明。
 *   续接（新进程接着原来的对话）也用同一个对话键再 `open` 一次：新进程的系统提示放的就是这一次交出的版本，
 *   基线和看到的版本跟着换成它，模型看到的开头和核心记的开头始终是同一份。
 *   核心替每个对话记着它上次看到的各段内容（存进核心的存储域，重启不丢），按下面五条规矩比：
 *   没变不提；变了按 `onChange`（`full` 附全文、`notice` 只说一句、函数由段自己给说明，交回空串就不提）；整段没了提醒旧版本作废；
 *   这一轮是会话自己改的不提：端点调声明了 `writesSegments` 的工具前后都重算这几段。每个会话每一段记一个"模型心里的版本"
 *   （第一次写时从上次比对看到的版本取），调用前算出的和它不一样，说明别人先改过，把这一步变化记下来；调用成功后它换成调用后的版本。
 *   比对时把别人改的那几步，加上"模型心里的版本到现在"这一步，逐步按 `onChange` 给说明，所以别人先改、后改都不会漏。
 *   压缩之后把对话开始以来改过的段补一遍。
 * - 上游自己的段用 `declareSegment(name, {audience})` 登记给谁；登记不到的照交，报一次异常。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/segments
 */

import { createHash } from 'node:crypto'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const AUDIENCES = Object.freeze(['opening', 'native-only'])

export const segmentsDomainSpec = defineDomain({
    name: 'mind_framework_core_segments',
    version: 1,
    layout: 'per-record',
    tables: {
        views: {
            valueSchema: z.object({
                conversation: z.string(),
                sessionId: z.string(),
                baseline: z.record(z.string(), z.string()),
                seen: z.record(z.string(), z.string()),
                at: z.number(),
            }).strict(),
        },
    },
})

const viewId = conversation => createHash('sha256').update(String(conversation)).digest('hex')

/**
 * @param domain - 已打开的 `segmentsDomainSpec` 存储域。
 * @param deps.systemPrompt - 上游的 `systemPrompt` 服务。
 * @param deps.report - 报异常。
 * @param deps.roleOf - 会话角色（交给段的 `text`）。
 * @param deps.now - 取当前时间（测试用）。
 */
export function createSegments(domain, { systemPrompt, report, roleOf, now = Date.now }) {
    const views = () => domain.table('views')
    const defined = new Map()
    /** 原生每次组装算出的段文字：`段名\0会话` → 文字。 */
    const cache = new Map()
    const declaredUpstream = new Map()
    /** 会话自己改过的段：会话 → 段名 → `{ known, others: [[改前, 改后], …] }`（`known` 是模型心里的版本）。 */
    const selfWrites = new Map()
    const reportedUpstream = new Set()

    /**
     * 登记一个段。
     * @param definition - `{ name, order, text, audience, onChange?, noticeText?, onError?, onRemove? }`；`onRemove: 'silent'` 时整段清空不提醒。
     * @returns 撤销这个段。
     */
    function segment(definition) {
        const { name, order, text, audience, onChange = 'full', onError = 'note' } = definition ?? {}
        if (typeof name !== 'string' || name === '') throw new TypeError('segment 需要 name')
        if (!Number.isFinite(order)) throw new TypeError('segment 需要数字 order')
        if (typeof text !== 'function') throw new TypeError('segment 的 text 要是函数')
        if (!AUDIENCES.includes(audience)) throw new TypeError(`audience 只能是 ${AUDIENCES.join('、')}`)
        if (!['full', 'notice'].includes(onChange) && typeof onChange !== 'function') throw new TypeError('onChange 只能是 full、notice 或函数')
        if (!['note', 'fail'].includes(onError)) throw new TypeError('onError 只能是 note 或 fail')
        if (definition.onRemove !== undefined && !['notice', 'silent'].includes(definition.onRemove)) throw new TypeError('onRemove 只能是 notice 或 silent')
        if (defined.has(name)) throw new Error(`段 ${name} 已经登记过`)
        const value = Object.freeze({ ...definition, onChange, onError })
        defined.set(name, value)
        const withdraw = systemPrompt.context({
            name,
            order,
            interpolate: false,
            text: context => cache.get(`${name}\u0000${sessionOf(context)}`) ?? '',
        })
        return () => {
            if (defined.get(name) !== value) return
            defined.delete(name)
            for (const key of [...cache.keys()]) if (key.startsWith(`${name}\u0000`)) cache.delete(key)
            withdraw()
        }
    }

    /** 按会话算一个段，交回 `{ text, failed }`；出错按 `onError` 处理（`note` 时 `text` 是失败那句）。 */
    async function compute(definition, sessionId, agent) {
        try {
            const text = await definition.text({ sessionId, agent, role: roleOf(sessionId) })
            return { text: typeof text === 'string' ? text : '', failed: false }
        } catch (error) {
            const why = error?.message ?? String(error)
            if (definition.onError === 'fail') throw new Error(`段 ${definition.name} 读取失败，这一步不往下跑（${why}）`, { cause: error })
            report('core/segment-failed', { sessionId, text: `段 ${definition.name} 这一轮读取失败（${why}）`, data: { segment: definition.name } })
            return { text: `（${definition.name} 这一轮读取失败）`, failed: true }
        }
    }

    /** 按会话算出所有段（只要 `audiences` 里的）。 */
    async function computeAll(sessionId, audiences, agent) {
        const entries = [...defined.values()].filter(definition => audiences.includes(definition.audience)).sort((a, b) => a.order - b.order)
        const results = await Promise.all(entries.map(definition => compute(definition, sessionId, agent)))
        return entries.map((definition, index) => ({ name: definition.name, order: definition.order, ...results[index] }))
    }

    /** 原生：`system-prompt/assemble` 中间件。 */
    async function assemble(context, next) {
        const sessionId = sessionOf(context)
        if (sessionId === undefined) return next()
        const computed = await computeAll(sessionId, AUDIENCES, context.agent)
        for (const entry of computed) cache.set(`${entry.name}\u0000${sessionId}`, entry.text)
        const result = await next()
        const byName = new Map(computed.map(entry => [entry.name, entry.text]))
        return {
            ...result,
            contexts: result.contexts.map(entry => byName.has(entry.name) ? { ...entry, text: byName.get(entry.name), interpolate: false } : entry),
        }
    }

    /**
     * 别的执行方开一个新对话：开头要有的段的全文（空的不给），并记下这个对话看到的版本。
     * @param conversation - 执行方自己的对话编号（换新对话就是新的编号）。
     */
    async function open(conversation, sessionId) {
        const current = (await computeAll(String(sessionId), ['opening'])).filter(entry => entry.text !== '')
        // 读取失败的段照样交出失败那句，但不记进基线：恢复以后按新出现的段给全文。
        const texts = Object.fromEntries(current.filter(entry => !entry.failed).map(entry => [entry.name, entry.text]))
        await views().put(viewId(conversation), { conversation: String(conversation), sessionId: String(sessionId), baseline: texts, seen: texts, at: now() })
        return current.map(({ name, order, text }) => ({ name, order, text }))
    }

    /**
     * 体检用：现在开对话会交出的开头段，以及这个会话最近一段对话已经拿到的段。什么也不记；段读不出时照常按 `onError` 处理。
     * @returns `{ opening: [{ name, text, failed }], delivered: { at, names } | null }`。
     */
    async function preview(sessionId) {
        const id = String(sessionId)
        const opening = (await computeAll(id, ['opening'])).filter(entry => entry.text !== '').map(({ name, text, failed }) => ({ name, text, failed }))
        const latest = [...views().entries()].map(([, record]) => record).filter(record => record.sessionId === id)
            .sort((left, right) => right.at - left.at)[0]
        return { opening, delivered: latest === undefined ? null : { at: latest.at, names: Object.keys(latest.seen) } }
    }

    /**
     * 别的执行方每一轮开始时：和这个对话上次看到的比，给出变更说明，并记下这次的版本。
     * @param options.compacted - 这个对话刚压缩过：把对话开始以来改过的段整段补一遍。
     * @returns 变更说明，每段一条；没有变化是空数组。没 `open` 过的对话按刚开对话处理，返回开头的全文。
     */
    async function changes(conversation, sessionId, { compacted = false } = {}) {
        const record = views().get(viewId(conversation))
        if (record === undefined) return (await open(conversation, sessionId)).map(entry => entry.text)
        const current = await computeAll(String(sessionId), ['opening'])
        const failed = new Set(current.filter(entry => entry.failed).map(entry => entry.name))
        const now_ = Object.fromEntries(current.filter(entry => entry.text !== '' && !entry.failed).map(entry => [entry.name, entry.text]))
        // 读取失败的段沿用上次看到的版本，不算变了、也不算没了。压缩那一轮失败的段，压缩后模型手里只剩基线，
        // 所以记成基线的版本（基线里没有就不记）：恢复时和基线比，对话里改过的那版会补上。
        for (const name of failed) {
            const kept = compacted ? record.baseline[name] : record.seen[name]
            if (kept !== undefined) now_[name] = kept
        }
        const notes = []
        // 上次比对以后会话自己改过的段：别人改的那几步，加上"模型心里的版本到现在"这一步。
        const own = selfWrites.get(String(sessionId)) ?? new Map()
        for (const entry of current) {
            if (failed.has(entry.name)) {
                notes.push(record.seen[entry.name] === undefined ? `（${entry.name}这一轮读取失败）` : `（${entry.name}这一轮读取失败，沿用之前的版本）`)
                continue
            }
            const next = now_[entry.name]
            if (own.has(entry.name) && !compacted) {
                const state = own.get(entry.name)
                notes.push(...describeSteps(defined.get(entry.name), [...state.others, [state.known, next]], next))
                continue
            }
            const prev = record.seen[entry.name]
            if (next === undefined || next === prev) continue
            if (compacted) continue
            const definition = defined.get(entry.name)
            if (prev === undefined || definition.onChange === 'full') notes.push(`【${entry.name}已更新，下面是全文】\n${next}`)
            else if (definition.onChange === 'notice') notes.push(definition.noticeText ?? `（${entry.name}已更新）`)
            else {
                // 段自己说这一处变化不用提（比如只报新增，而这次只少了几条）：交回空串就不提。
                const note = String(definition.onChange(prev, next) ?? '')
                if (note !== '') notes.push(note)
            }
        }
        for (const name of Object.keys(record.seen)) {
            // 段可以声明清空了不用提（`onRemove: 'silent'`，比如待告知留言全告知了）；登记里没有了的段照样提。
            if (defined.get(name)?.onRemove === 'silent') continue
            if (now_[name] === undefined && !(own.has(name) && own.get(name).known === undefined)) notes.push(`（${name}已经没有了，以前给你的旧版本作废）`)
        }
        if (compacted) {
            for (const entry of current) {
                if (failed.has(entry.name)) continue
                const next = now_[entry.name]
                if (next !== undefined && next !== record.baseline[entry.name]) notes.push(`【${entry.name}（对话开始以来改过，压缩后补全文）】\n${next}`)
            }
        }
        await views().put(viewId(conversation), { ...record, seen: now_, at: now() })
        selfWrites.delete(String(sessionId))
        return notes
    }

    /** 这个会话上次比对时看到的某一段（最近一次比对的那个对话）。 */
    function lastSeen(sessionId, name) {
        let latest
        for (const [, view] of views().entries()) {
            if (view.sessionId === sessionId && (latest === undefined || view.at > latest.at)) latest = view
        }
        return latest?.seen[name]
    }

    /** 端点调一个会改这些段的工具之前：算一次，和模型心里的版本不一样就是别人先改过，记下这一步。读取失败的不记。 */
    async function beforeSelfWrite(sessionId, names) {
        const id = String(sessionId)
        const states = selfWrites.get(id) ?? new Map()
        selfWrites.set(id, states)
        for (const name of names) {
            const definition = defined.get(name)
            if (definition === undefined) continue
            const state = states.get(name) ?? { known: lastSeen(id, name), others: [] }
            states.set(name, state)
            const { text, failed } = await compute(definition, id)
            if (failed) continue
            const pre = text === '' ? undefined : text
            if (pre !== state.known) {
                state.others.push([state.known, pre])
                state.known = pre
            }
        }
    }

    /** 调用之后：成功的话，模型心里的版本换成调用后的；出错的不动。读取失败的不记。 */
    async function afterSelfWrite(sessionId, names, succeeded) {
        if (!succeeded) return
        const states = selfWrites.get(String(sessionId))
        for (const name of names) {
            const definition = defined.get(name)
            const state = states?.get(name)
            if (definition === undefined || state === undefined) continue
            const { text, failed } = await compute(definition, String(sessionId))
            if (!failed) state.known = text === '' ? undefined : text
        }
    }

    /** 一段按若干步变化给说明：函数型逐步算拼起来；full、notice 只要有一步变了就提一次（full 给现在的全文）。 */
    function describeSteps(definition, steps, next) {
        const changed = steps.filter(([from, to]) => from !== to)
        if (changed.length === 0) return []
        if (changed.some(([from]) => from === undefined) || definition.onChange === 'full') {
            return next === undefined ? [] : [`【${definition.name}已更新，下面是全文】\n${next}`]
        }
        if (definition.onChange === 'notice') return [definition.noticeText ?? `（${definition.name}已更新）`]
        return changed.filter(([, to]) => to !== undefined).map(([from, to]) => String(definition.onChange(from, to) ?? '')).filter(note => note !== '')
    }

    /** 登记上游自己的段给谁。 */
    function declareSegment(name, { audience } = {}) {
        if (!AUDIENCES.includes(audience)) throw new TypeError(`audience 只能是 ${AUDIENCES.join('、')}`)
        declaredUpstream.set(name, audience)
    }

    /**
     * 上游的段给谁：框架的段按自己的 `audience`，上游的按 `declareSegment`；都登记不到的当 `opening` 照交，报一次异常。
     */
    function audienceOf(name, sessionId) {
        const own = defined.get(name)
        if (own !== undefined) return own.audience
        const upstream = declaredUpstream.get(name)
        if (upstream !== undefined) return upstream
        if (!reportedUpstream.has(name)) {
            reportedUpstream.add(name)
            report('core/undeclared-segment', { ...sessionId === undefined ? {} : { sessionId }, text: `上游的段 ${name} 没有登记给谁，照样交给所有执行方`, data: { segment: name } })
        }
        return 'opening'
    }

    return Object.freeze({ segment, assemble, open, preview, changes, beforeSelfWrite, afterSelfWrite, declareSegment, audienceOf })
}

/** 组装时是哪个会话（没有 Agent 的诊断组装为 `undefined`）。 */
function sessionOf(context) {
    const id = context?.agent?.session?.id
    return id === undefined ? undefined : String(id)
}
