/**
 * 自省：后台思考什么时候醒、醒来交给它什么、一轮的结果怎么认，以及主动联系。
 * 提供服务 `reflection`、`contact`，上下文段 `contact-pending`，四个工具。
 *
 * - **后台思考会话**按角色认（`background`）。没有时，第一次要用时在中枢的工作目录建一个，定好角色和模型。
 * - **醒**要同时满足：没有进行中的一轮；到了 `nextAt`；后台会话的额度不是 `limited`（`unknown` 当可以继续）；
 *   前台空闲，即用户本人（核心的出处）最近一次说话超过 `quietMinutes`，而且中枢和接着出口的会话
 *   （`core.exits.foreground()`，比如接群的会话）都没有在跑。工作会话、后台会话、子代理不算前台。
 *   兜底：过了 `nextAt` 又过了 `overdueMinutes` 还没醒，就不看前台空闲醒一次。
 * - **交给它什么**：框架填的事实（现在时刻、上次的结果和小结、主动联系、留言条数、间隔范围、各插件经
 *   `contribute` 交来的几行），加上用户内容目录里的模板（`templateFile`）。没有模板文件时用框架自带的中性起步模板，
 *   并报一次。经 `core.deliver` 放进后台会话，编号先定好，记进 `running.messageId`。
 * - **一轮的结果**按编号在日志里找那条 `user/message`，看它所在那一轮的 `turn/end`。只在后台会话的 `turn/end` 之后、
 *   或者它空闲时判。间隔：
 *   - `completed` 并调过 `assistant_reflection_done`：按它声明的分钟数（夹在范围里）。
 *   - `completed` 没调：`defaultMinutes`，小结取最后一段文字的前 300 字，报一次。
 *   - 自省自己让位，或者这条领走了却一步没跑：0，下次输入写"上次被打断"。
 *   - 别的结束原因：`minMinutes`。
 *   - 超过 `lostAfterMinutes` 还没有结果：当作丢失，`nextAt` 改成现在，报一次。
 * - **让位**：用户本人在别的会话说话时，先记下 `yielding`，再 `cancel({kind:'user'}, {keepInbox: true})`。
 * - **主动联系**：留言存下以后马上经 `core.deliver('hub')` 交给中枢，休息时段也照交（发到手机那一下由出口管）。
 *   交不出的留着，下一次检查再交。打开主动联系只认用户本人的话（`latestFromUser`），口令是配置。
 *   待告知留言段只对中枢有内容，变化时只报新增的几条；`told` 不声明 `writesSegments`（标记之后可能又有新留言）。
 *   留言作为经历库的来源（`reflection-contact`）记进留言的会话的时间线。
 *
 * @module @loveandbeepbrother/dsh-galatea/reflection
 */

import Schema from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { STARTER_TEMPLATE, clampMinutes, factsText, turnOutcome } from './rhythm.js'

export const name = 'mind-framework-reflection'
export const inject = ['core', 'storageDomain', 'agents', 'sessionQuery']
export const REFLECTION_SOURCE = 'reflection'
export const CONTACT_SOURCE = 'contact'
export const CONTACT_SEGMENT = 'contact-pending'
const SPEAKER = Object.freeze({ kind: 'program', plugin: name })
/** 事实段里每类异常最近一条的说明留多少字。 */
const UNHANDLED_TEXT_CHARS = 200

const runningSchema = z.object({
    messageId: z.string(),
    startedAt: z.number(),
    yielding: z.boolean(),
    declared: z.object({ nextMinutes: z.number(), summary: z.string() }).strict().nullable(),
}).strict()
export const reflectionDomainSpec = defineDomain({
    name: 'mind_framework_reflection',
    version: 1,
    layout: 'per-record',
    tables: {
        state: {
            valueSchema: z.object({
                nextAt: z.number(),
                running: runningSchema.nullable(),
                last: z.object({ at: z.number(), outcome: z.string(), summary: z.string() }).strict().nullable(),
            }).strict(),
        },
        contact: { valueSchema: z.object({ enabled: z.boolean(), updatedAt: z.number() }).strict() },
        messages: {
            valueSchema: z.object({
                text: z.string(),
                reason: z.string(),
                by: z.string(),
                state: z.enum(['pending', 'relayed', 'told']),
                createdAt: z.number(),
                settledAt: z.number().nullable(),
            }).strict(),
        },
    },
})

export const Config = Schema.object({
    provider: Schema.string().default('').description('新建后台思考会话时用的模型提供方；空就不选，用 DSH 设的默认模型'),
    model: Schema.string().default(''),
    sessionTitle: Schema.string().default('后台思考'),
    templateFile: Schema.string().default('后台思考.md').description('后台思考的模板（相对内容库）'),
    contactPhrase: Schema.string().default('开启主动联系').description('用户本人打开主动联系要说的话'),
    tickSeconds: Schema.natural().default(60),
    firstDelayMinutes: Schema.natural().default(30),
    quietMinutes: Schema.natural().default(20),
    overdueMinutes: Schema.natural().default(240).description('过了该醒的时间这么久还没醒，就不看前台空闲醒一次'),
    minMinutes: Schema.natural().default(60),
    defaultMinutes: Schema.natural().default(180),
    maxMinutes: Schema.natural().default(720),
    lostAfterMinutes: Schema.natural().default(180),
})

const minutes = value => value * 60_000

/** @param deps.now - 换掉时钟（测试用）。 */
export async function apply(ctx, config, deps = {}) {
    const core = ctx.core
    const now = deps.now ?? Date.now
    const domain = await ctx.storageDomain.open(reflectionDomainSpec)
    let closed = false
    ctx.effect(() => () => {
        closed = true
        domain.close?.()
    }, 'mind-framework-reflection: domain')
    const table = name => domain.table(name)
    const started = now()
    let lastUserAt = started
    const reported = new Set()
    const reportOnce = (kind, key, detail) => {
        if (reported.has(`${kind}:${key}`)) return
        reported.add(`${kind}:${key}`)
        core.report(kind, detail)
    }
    let chain = Promise.resolve()
    const serial = (job) => {
        const next = chain.catch(() => {}).then(job)
        chain = next.catch(() => {})
        return next
    }
    const policy = Object.freeze({
        tickSeconds: config.tickSeconds, firstDelayMinutes: config.firstDelayMinutes, quietMinutes: config.quietMinutes,
        overdueMinutes: config.overdueMinutes, minMinutes: config.minMinutes, defaultMinutes: config.defaultMinutes,
        maxMinutes: config.maxMinutes, lostAfterMinutes: config.lostAfterMinutes,
    })
    const range = { min: config.minMinutes, max: config.maxMinutes }

    const state = () => table('state').get('state') ?? { nextAt: started + minutes(config.firstDelayMinutes), running: null, last: null }
    const saveState = value => table('state').put('state', value)
    const contactSettings = () => table('contact').get('settings') ?? { enabled: false, updatedAt: 0 }
    const messages = () => [...table('messages').entries()]
    const pendingMessages = () => messages().filter(([, message]) => message.state !== 'told')

    async function readEvents(sessionId) {
        let observation
        try {
            observation = await ctx.sessionQuery.observeSession(SessionId(sessionId), { projectionMode: 'none' })
            return [...observation.events]
        } catch (error) {
            if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return []
            throw error
        } finally {
            try {
                observation?.[Symbol.dispose]?.() ?? observation?.dispose?.()
            } catch {
                // 只读观察的释放失败不影响结论。
            }
        }
    }

    /* ------------------------------------------------------------------ 后台会话 */

    /** 后台思考会话：角色是 background 的那一个（存储里的，不在内存里也认得出）；有几个时取第一个并报一次。 */
    function backgroundSessionId() {
        const found = core.sessions.withRole('background')
        if (found.length > 1) reportOnce('reflection/many-background', found.join(','), { text: `有 ${found.length} 个后台会话（${found.join('、')}），后台思考用第一个` })
        return found[0] ?? null
    }

    async function resolveAgent(sessionId) {
        const live = ctx.agents.get(SessionId(sessionId))
        if (live !== undefined) return live
        const controller = ctx.get('sessionController')
        if (controller === undefined) throw new Error('当前组合没有 sessionController，后台会话不在内存里时取不到')
        const found = await controller.resolveAgent(SessionId(sessionId))
        if ('error' in found) throw found.error
        return found.agent
    }

    /** 后台会话的编号；没有就建一个（在中枢的工作目录）。 */
    async function ensureBackground() {
        const existing = backgroundSessionId()
        if (existing !== null && existing !== undefined) return existing
        const controller = ctx.get('sessionController')
        const hub = core.sessions.hub()
        if (controller === undefined || hub === null) throw new Error(hub === null ? '没有中枢会话，建不了后台思考会话' : '当前组合没有 sessionController，建不了后台思考会话')
        const cwd = ctx.agents.get(SessionId(hub))?.session?.header?.cwd
        const created = await controller.create({ ...cwd === undefined ? {} : { cwd } })
        const sessionId = String(created?.sessionId ?? created?.session?.id ?? created?.id)
        await core.sessions.assign(sessionId, 'background', { by: SPEAKER })
        const agent = await resolveAgent(sessionId)
        if (config.provider !== '') agent.model?.select?.({ provider: config.provider, model: config.model })
        // 起名可有可无：没有会话标题服务时照样用。
        try {
            await controller.rename?.({ sessionId, title: config.sessionTitle })
        } catch (error) {
            reportOnce('reflection/rename-failed', sessionId, { sessionId, text: `后台思考会话没能起名（${error?.message ?? error}），照样用` })
        }
        return sessionId
    }

    /* ------------------------------------------------------------------ 醒 */

    const contributors = new Map()
    function contribute(name, lines) {
        if (typeof name !== 'string' || name === '' || typeof lines !== 'function') throw new TypeError('contribute 要名字和交几行的函数')
        const entry = { name, lines }
        contributors.set(name, entry)
        return () => {
            if (contributors.get(name) === entry) contributors.delete(name)
        }
    }

    async function template() {
        const read = await core.content.read(config.templateFile).catch(() => null)
        if (read !== null && read.text.trim() !== '') return read.text.trim()
        reportOnce('reflection/template-missing', config.templateFile, { text: `后台思考的模板 ${config.templateFile} 不在用户内容目录里，用的是框架自带的起步模板` })
        return STARTER_TEMPLATE
    }

    async function frontIdle() {
        if (now() - lastUserAt < minutes(config.quietMinutes)) return false
        const front = new Set(core.exits.foreground())
        const hub = core.sessions.hub()
        if (hub !== null) front.add(hub)
        return [...front].every(sessionId => ctx.agents.get(SessionId(sessionId))?.status !== 'running')
    }

    async function start(sessionId) {
        const current = state()
        const contributions = []
        // 没有别的插件接手的异常由核心留着，按类别计数交进来；装了 Watchdog 这类消费方、它接手的类别就不在这里。
        const unhandled = core.unhandledReports(current.last?.at ?? 0)
        if (unhandled.length > 0) {
            contributions.push({
                name: '上次后台思考以后、没有别的插件接手的异常（按类别）',
                lines: unhandled.map(item => `${item.kind} × ${item.count}，最近一条：${item.lastText.slice(0, UNHANDLED_TEXT_CHARS)}`),
            })
        }
        for (const { name, lines } of contributors.values()) {
            try {
                contributions.push({ name, lines: (await lines(ctx)).map(String) })
            } catch {
                contributions.push({ name, lines: null })
            }
        }
        const facts = factsText({ now: now(), last: current.last, contact: contactSettings(), pendingContacts: pendingMessages().length, range, contributions, timezone: core.timezone })
        const text = `${facts}\n\n${await template()}`
        const messageId = `reflection-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        await saveState({ ...current, running: { messageId, startedAt: now(), yielding: false, declared: null } })
        const result = await core.deliver(sessionId, {
            key: messageId, id: messageId, text,
            source: { kind: REFLECTION_SOURCE, intent: 'prompt', key: messageId },
            speaker: SPEAKER,
            reply: { to: 'none' },
        })
        if (result.status === 'unavailable') {
            await saveState({ ...current, running: null, nextAt: now() + minutes(config.minMinutes) })
            core.report('reflection/deliver-failed', { sessionId, text: `后台思考没能开始：${result.reason}` })
        }
    }

    /** 这一轮的结果；还没法判的时候什么也不做。 */
    async function collect(sessionId) {
        const current = state()
        const running = current.running
        if (running === null) return
        const agent = ctx.agents.get(SessionId(sessionId))
        // 只在空闲时判：领走到写进日志之间隔着好几个 await，在跑时判会把刚开始的一轮当成没跑。
        if (agent?.status === 'running') return
        const result = turnOutcome(await readEvents(sessionId), running.messageId)
        const at = now()
        const finish = (minutesLater, outcome, summary) => saveState({ nextAt: at + minutes(minutesLater), running: null, last: { at: running.startedAt, outcome, summary } })
        if (!result.found || !result.ended) {
            const waiting = agent?.inbox?.nextTurn?.some(message => String(message.id) === running.messageId)
                || agent?.inbox?.nextStep?.some(message => String(message.id) === running.messageId)
            if (!result.found && !waiting && agent !== undefined) return finish(0, 'interrupted', '')
            if (at - running.startedAt > minutes(config.lostAfterMinutes)) {
                core.report('reflection/lost', { sessionId, text: `后台思考 ${running.messageId} 过了 ${config.lostAfterMinutes} 分钟还没有结果，当作丢失，重新安排` })
                return saveState({ nextAt: at, running: null, last: { at: running.startedAt, outcome: 'lost', summary: '' } })
            }
            return
        }
        if (running.yielding) return finish(0, 'yielded', '')
        if (result.outcome === 'completed') {
            if (running.declared !== null) return finish(clampMinutes(running.declared.nextMinutes, range), 'completed', running.declared.summary)
            reportOnce('reflection/no-done', running.messageId, { sessionId, text: `后台思考 ${running.messageId} 结束时没有调 assistant_reflection_done，按默认间隔` })
            return finish(config.defaultMinutes, 'completed', Array.from(result.text).slice(0, 300).join(''))
        }
        return finish(config.minMinutes, result.outcome, '')
    }

    async function tick() {
        if (closed) return
        const sessionId = backgroundSessionId()
        const current = state()
        if (current.running !== null) {
            if (sessionId !== null && sessionId !== undefined) await collect(sessionId)
            await relayContacts()
            return
        }
        if (now() >= current.nextAt) {
            const target = sessionId ?? null
            const quota = target === null ? 'unknown' : await core.quota.state(target)
            const overdue = now() >= current.nextAt + minutes(config.overdueMinutes)
            if (quota !== 'limited' && (overdue || await frontIdle())) {
                try {
                    await start(await ensureBackground())
                } catch (error) {
                    reportOnce('reflection/start-failed', String(error?.message ?? error), { text: `后台思考没能开始：${error?.message ?? error}` })
                }
            }
        }
        await relayContacts()
    }

    async function requestSoon({ reason = '', by } = {}) {
        return serial(async () => {
            const current = state()
            if (current.running !== null) return { status: 'running' }
            if (current.nextAt <= now()) return { status: 'due' }
            await saveState({ ...current, nextAt: now() })
            ctx.logger?.info?.(`mind-framework: 后台思考提前（${reason || '没写原因'}，${by?.plugin ?? by?.kind ?? '?'}）`)
            return { status: 'scheduled' }
        })
    }

    async function yieldNow() {
        const current = state()
        if (current.running === null || current.running.yielding) return
        await saveState({ ...current, running: { ...current.running, yielding: true } })
        const sessionId = backgroundSessionId()
        if (sessionId) ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'user' }, { keepInbox: true })
    }

    ctx.on('session/event', (session, event) => {
        if (closed) return
        const sessionId = String(session?.id ?? '')
        if (sessionId === backgroundSessionId()) {
            if (event?.type === 'turn/end') setTimeout(() => serial(() => collect(sessionId)).catch(() => {}), 200).unref?.()
            return
        }
        if (event?.type === 'user/message' && event.data?.source?.speaker?.kind === 'user') {
            lastUserAt = now()
            serial(yieldNow).catch(() => {})
        }
    }, { global: true })

    const timer = setInterval(() => {
        serial(tick).catch(error => reportOnce('reflection/tick-failed', String(error?.message ?? error), { text: `后台思考的检查出错（${error?.message ?? error}）` }))
    }, config.tickSeconds * 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'mind-framework-reflection: timer')

    ctx.provide('reflection', {
        requestSoon,
        state: () => {
            const { nextAt, running, last } = state()
            return { nextAt, ...running === null ? {} : { running: { messageId: running.messageId, startedAt: running.startedAt, yielding: running.yielding } }, ...last === null ? {} : { last } }
        },
        contribute,
        policy,
        tick: () => serial(tick),
    })

    /* ------------------------------------------------------------------ 主动联系 */

    let contactMarks
    ctx.inject(['experience'], (sub) => {
        const source = sub.experience.registerSource({ id: 'reflection-contact', label: '主动联系的留言', category: 'dsh' })
        contactMarks = source
        sub.effect(() => () => {
            source.dispose()
            if (contactMarks === source) contactMarks = undefined
        }, 'mind-framework-reflection: experience source')
    })

    const relayText = message => ['【主动联系】（后台转交，不是用户发言）你想主动告诉用户：', message.text, '', '请用自然的口吻发给用户，可以按当前语境润色，不必提到这是转交。'].join('\n')

    async function relayContacts() {
        for (const [id, message] of messages()) {
            if (message.state !== 'pending') continue
            const result = await core.deliver('hub', { key: `contact-${id}`, text: relayText(message), source: { kind: CONTACT_SOURCE, key: id }, speaker: SPEAKER, link: id })
            if (result.status === 'unavailable') return
            await table('messages').put(id, { ...message, state: 'relayed', settledAt: now() })
        }
    }

    const callerLabel = by => (by?.kind === 'session' ? by.sessionId : by?.kind === 'external' ? `external:${by.name}` : String(by?.plugin ?? 'unknown'))

    async function leave({ text, reason = '', by } = {}) {
        const body = String(text ?? '').trim()
        if (body === '') throw new Error('text 不能为空')
        const id = `c${now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
        const record = { text: body, reason: String(reason).trim(), by: callerLabel(by), state: 'pending', createdAt: now(), settledAt: null }
        await table('messages').put(id, record)
        if (contactMarks !== undefined && by?.kind === 'session') {
            try {
                contactMarks.append([{ id: `contact:${id}`, thread: by.sessionId, at: record.createdAt, tie: 0, role: 'out', kind: '留言给用户', party: '用户', link: id, text: body }])
            } catch (error) {
                core.report('reflection/contact-archive-failed', { text: `留言 ${id} 没进经历库（${error?.message ?? error}）` })
            }
        }
        await serial(relayContacts)
        return { id, state: table('messages').get(id).state }
    }

    const pending = () => pendingMessages().map(([id, message]) => ({ id, text: message.text, at: message.createdAt, by: message.by }))

    async function told(ids, { by } = {}) {
        const known = []
        const unknown = []
        for (const id of (ids ?? []).map(String)) {
            const message = table('messages').get(id)
            if (message === undefined) {
                unknown.push(id)
                continue
            }
            await table('messages').put(id, { ...message, state: 'told', settledAt: now() })
            known.push(id)
        }
        if (unknown.length > 0) core.report('reflection/told-unknown', { text: `标记已告知时有不存在的留言编号：${unknown.join('、')}（${callerLabel(by)}）` })
        return { told: known, ...unknown.length > 0 ? { unknown } : {} }
    }

    const compact = text => String(text ?? '').replace(/\s+/g, '')
    async function change({ enabled }, { by } = {}) {
        const current = contactSettings()
        if (enabled === true && !current.enabled) {
            if (by?.kind !== 'session') throw new Error('主动联系只能由用户本人在会话里开启')
            const { own } = await core.provenance.latestFromUser(by.sessionId)
            if (own === null || !compact(own.text).includes(compact(config.contactPhrase))) {
                throw new Error(`主动联系只能由用户本人开启：需要用户本人在这个会话里说"${config.contactPhrase}"`)
            }
        }
        const next = { enabled: typeof enabled === 'boolean' ? enabled : current.enabled, updatedAt: now() }
        await table('contact').put('settings', next)
        return { enabled: next.enabled }
    }

    ctx.provide('contact', { leave, pending, told, settings: () => ({ enabled: contactSettings().enabled }), change })

    /* ------------------------------------------------------------------ 段与工具 */

    core.segment({
        name: CONTACT_SEGMENT,
        order: 9450,
        audience: 'opening',
        text: ({ sessionId }) => {
            if (sessionId !== core.sessions.hub()) return ''
            const list = pending()
            if (list.length === 0) return ''
            return ['你在后台留下、还没告诉用户的话（找合适的时机自然地说，说完用 assistant_contact_told 标记）：', ...list.map(item => `- ${item.id}：${item.text}`)].join('\n')
        },
        // 全告知了、整段清空是中枢自己标的，不用提。
        onRemove: 'silent',
        // 只报新增的几条：标记已告知以后又有新留言，整段比对会把新留言一起吞掉。
        onChange: (previous, next) => {
            const ids = text => new Set([...String(text ?? '').matchAll(/^- (c[0-9a-z]+)：/gm)].map(match => match[1]))
            const before = ids(previous)
            const added = String(next ?? '').split('\n').filter(line => /^- c[0-9a-z]+：/.test(line) && !before.has(/^- (c[0-9a-z]+)：/.exec(line)[1]))
            return added.length === 0 ? '' : ['（DSH 提示，不是用户发言）新的待告知留言：', ...added].join('\n')
        },
    })

    ctx.effect(() => core.declareSource(REFLECTION_SOURCE, { intent: 'prompt', annotate: false, speaker: SPEAKER }), 'mind-framework-reflection: reflection source')
    ctx.effect(() => core.declareSource(CONTACT_SOURCE, { intent: 'prompt', annotate: false, speaker: SPEAKER }), 'mind-framework-reflection: contact source')

    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
    const tool = ({ execute, ...definition }, meta) => core.tool(defineTool({
        ...definition,
        output,
        execute: async (args, exec) => JSON.stringify(await execute(args ?? {}, core.caller(exec)), null, 1),
    }), meta)
    const role = (...roles) => who => who?.kind === 'session' && roles.includes(who.role)

    tool({
        name: 'assistant_reflection_done',
        description: 'Finish this background-thinking turn: say in one or two sentences what you did, and in how many minutes the next one should come. Counts only if the turn completes normally.',
        parameters: {
            summary: { type: 'string', required: true, description: 'What this turn did.' },
            nextMinutes: { type: 'integer', required: true, description: `Minutes until the next background thinking, ${config.minMinutes}-${config.maxMinutes}.` },
        },
        execute: async (args, who) => serial(async () => {
            const current = state()
            if (current.running === null) return { recorded: false, reason: '现在没有进行中的后台思考' }
            const nextMinutes = clampMinutes(Number(args.nextMinutes), range)
            await saveState({ ...current, running: { ...current.running, declared: { nextMinutes, summary: String(args.summary ?? '').trim() } } })
            return { recorded: true, nextMinutes, note: '这一轮正常结束时作数' }
        }),
    }, { effect: 'write', allow: role('background') })
    tool({
        name: 'assistant_contact_user',
        description: 'Leave a message you want to tell the user on your own initiative (a finding, a decision the user needs to make, a thought of your own). It is handed to the hub session, which tells the user.',
        parameters: {
            text: { type: 'string', required: true, description: 'What to tell the user.' },
            reason: { type: 'string', description: 'Why it is worth telling now.' },
        },
        execute: (args, who) => leave({ text: args.text, reason: args.reason, by: who }),
    }, { effect: 'write', allow: role('hub', 'background') })
    tool({
        name: 'assistant_contact_settings',
        description: `Read or change proactive contact. Turning it on requires the user to have personally said "${config.contactPhrase}" in this session; turning it off is always allowed. Call with no arguments to read.`,
        parameters: { enabled: { type: 'boolean', description: 'true to enable, false to disable.' } },
        execute: (args, who) => (args.enabled === undefined ? { enabled: contactSettings().enabled } : change({ enabled: args.enabled }, { by: who })),
    }, { effect: 'write', allow: role('hub') })
    tool({
        name: 'assistant_contact_told',
        description: 'Mark kept messages as told after you have passed them on to the user in conversation.',
        parameters: { ids: { type: 'array', items: { type: 'string' }, required: true, description: 'Message ids from the pending list.' } },
        execute: (args, who) => told(args.ids, { by: who }),
    }, { effect: 'write', allow: role('hub') })
}
