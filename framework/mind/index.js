/**
 * 心智模块：人格、长期认知、常驻记忆、“我们之间”，人格候选与确认。提供服务 `mind`、上下文段 `mind` 和 `between-us`、六个工具。
 *
 * - 文件都在核心的内容库里（`core.content`），写入的顺序、留痕、用户手改的提交由内容库做；路径是配置。
 * - **按轮固定版本**：每个会话每一轮用同一个版本，写入从下一轮生效。找版本的顺序：这一轮的绑定 → 没完成的 Goal
 *   的绑定（缺了从 Goal 创建事件所在那一轮恢复）→ 会话本身的绑定 → 原生子代理取父会话这一轮的 → 读当前文件、
 *   存成版本再绑定。插件启用时已经在跑、又没有任何绑定的那一轮不补人格（补了会前几步没有、后几步有），
 *   下一轮生效，并报一条 `mind/suppressed-open-turn`。
 * - **谁能写**（默认配置，用工具的 `allow` 实现，不能写的工具不列给它）：
 *   人格——中枢写，稳定变化要用户本人确认；后台思考、外部调用方只能提候选；工作会话不能。
 *   长期认知——中枢、后台思考、外部调用方写；工作会话不能。常驻记忆——中枢、后台思考写，改了就是事实变了，不走候选；
 *   工作会话和外部调用方只读。确认、撤回候选只有中枢。没定角色的会话按工作会话算。
 * - **候选**：不是中枢提的，心智模块自己经 `core.deliver('hub')` 转交中枢，请它向用户确认。
 * - **确认**：调用会话里候选提出以后最近一条用户本人的消息（`core.provenance.latestFromUser`）含确认口令，
 *   人格的哈希还是候选记下的那个；新人格和候选状态在一次 `content.write` 里提交。
 * - **“我们之间”**：最近的共同经历、用户近来在意的事、彼此的默契和变化（陪伴的连续性，不只是协作规则）。中枢和后台思考写，
 *   整份替换；单独一段（`between-us`），接在心智段后面，开对话时定下、别处改了提一句。不进按轮固定的版本：版本记录的 schema
 *   是严格的，加一份要加字段，回退到旧包会读不了新版本。没有这个文件按空，不算异常。
 * - 篇幅上限是配置：超了照样写，返回值里写明。
 * - 文件不存在按空处理，不复制写死的默认人设；人格、长期认知按空处理时报一次 `mind/file-missing`，写明是哪个文件。
 *   常驻记忆是可选的一层，没有这个文件不算异常。
 *
 * @module @loveandbeepbrother/dsh-galatea/mind
 */

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CANDIDATE_CODE, candidateCode, confirms, formatCandidate, parseCandidate, withState } from './candidates.js'
import { composeText, createVersions, mindDomainSpec } from './versions.js'

export const name = 'mind-framework-mind'
export const inject = ['core', 'storageDomain', 'sessionProjections', 'agents']

export const SERVICE = 'mind'
export const SEGMENT = 'mind'
export const BETWEEN_SEGMENT = 'between-us'
/** 转交中枢的人格候选在会话里的来源。 */
export const CANDIDATE_SOURCE = 'mind-candidate'
export const MIND_TOOLS = Object.freeze(['assistant_mind_read', 'assistant_persona_update', 'assistant_persona_decide', 'assistant_cognition_update', 'assistant_standing_update', 'assistant_between_us_update'])
const WRITES = Object.freeze([SEGMENT])
const BETWEEN_WRITES = Object.freeze([BETWEEN_SEGMENT])
const SPEAKER = Object.freeze({ kind: 'program', plugin: name })
const PART_LABELS = Object.freeze({ persona: '人格', cognition: '长期认知', standing: '常驻记忆', between: '“我们之间”' })
/** 可以没有的文件：没有按空，不报。 */
const OPTIONAL_PARTS = new Set(['standing', 'between'])

export const Config = Schema.object({
    personaFile: Schema.string().default('personality.md').description('人格文件（相对内容库）'),
    cognitionFile: Schema.string().default('long-term-cognition.md').description('长期认知文件（相对内容库）'),
    standingFile: Schema.string().default('standing-memory.md').description('常驻记忆文件（相对内容库）；没有这个文件按空，不算异常'),
    candidatesDirectory: Schema.string().default('candidates').description('人格候选的目录（相对内容库）'),
    personaMaxChars: Schema.natural().default(0).description('人格的篇幅上限（字），超了照样写、返回值里写明；0 不限'),
    cognitionMaxChars: Schema.natural().default(0).description('长期认知的篇幅上限（字）；0 不限'),
    standingMaxChars: Schema.natural().default(3000).description('常驻记忆的篇幅上限（字），超了照样写、返回值里写明；0 不限'),
    betweenFile: Schema.string().default('between-us.md').description('“我们之间”的文件（相对内容库）；没有这个文件按空，不算异常'),
    betweenMaxChars: Schema.natural().default(1000).description('“我们之间”的篇幅上限（字），超了照样写、返回值里写明；0 不限'),
    confirmTemplate: Schema.string().default('确认人格 {code}').description('用户确认人格候选要说的话，{code} 换成候选编号'),
})

export class MindWriteError extends Error {
    constructor(message, current) {
        super(current === undefined ? message : `${message}\n\n当前内容：\n${current}`)
        this.code = 'MIND_WRITE'
    }
}

/** 某个调用方能做什么（默认配置）。 */
export function permissions(who) {
    if (who?.kind === 'external') return { read: true, personaDaily: false, personaCandidate: !who.readOnly, cognition: !who.readOnly, standing: false, between: false, decide: false }
    if (who?.kind !== 'session') return { read: true, personaDaily: false, personaCandidate: false, cognition: false, standing: false, between: false, decide: false }
    switch (who.role) {
        case 'hub': return { read: true, personaDaily: true, personaCandidate: true, cognition: true, standing: true, between: true, decide: true }
        case 'background': return { read: true, personaDaily: false, personaCandidate: true, cognition: true, standing: true, between: true, decide: false }
        // 交接整理只管事实：人格、长期认知和“我们之间”不归它，看到要改的告诉中枢。
        case 'tidy': return { read: true, personaDaily: false, personaCandidate: false, cognition: false, standing: true, between: false, decide: false }
        default: return { read: true, personaDaily: false, personaCandidate: false, cognition: false, standing: false, between: false, decide: false }
    }
}

export async function apply(ctx, config) {
    const core = ctx.core
    const domain = await ctx.storageDomain.open(mindDomainSpec)
    ctx.effect(() => () => domain.close?.(), 'mind-framework-mind: domain')
    const versions = createVersions(domain)
    const phrase = code => config.confirmTemplate.replaceAll('{code}', code)
    const files = { persona: config.personaFile, cognition: config.cognitionFile, standing: config.standingFile, between: config.betweenFile }

    /* ------------------------------------------------------------------ 读文件 */

    /** 按空处理过、已经报过的文件；文件又有了就清掉，之后再没了再报。 */
    const missingReported = new Set()

    async function readPart(part) {
        const read = await core.content.read(files[part])
        if (read !== null) {
            missingReported.delete(part)
            return read
        }
        // 文件不存在按空处理不算出错，onError 拦不住；路径配错时段会悄悄变空，所以报出来。常驻记忆本来就可以没有。
        if (!OPTIONAL_PARTS.has(part) && !missingReported.has(part)) {
            missingReported.add(part)
            core.report('mind/file-missing', { text: `${PART_LABELS[part]}文件 ${files[part]} 不存在，按空处理；路径配错了的话心智段会是空的`, data: { file: files[part] } })
        }
        return { text: '', hash: null }
    }

    /** 连读两次一致才用（读的时候可能正被写），最多三次。 */
    async function readStable() {
        const readAll = async () => [await readPart('persona'), await readPart('cognition'), await readPart('standing')]
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const first = await readAll()
            const second = await readAll()
            if (first.every((part, index) => part.hash === second[index].hash)) return { persona: second[0].text, cognition: second[1].text, standing: second[2].text }
        }
        throw new Error('心智：人格、长期认知、常驻记忆一直在变，读不到稳定的一份')
    }

    /* ------------------------------------------------------------------ 这一轮的版本 */

    /** 会话这一轮、Goal 的情况（上游投影）。 */
    function processingOf(session) {
        const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
        // 没装 Goal 插件时没有这份投影。
        let goalState
        try {
            goalState = ctx.sessionProjections.stateOf(session, 'goal')
        } catch {
            goalState = undefined
        }
        const current = goalState?.current?.goal
        const startSeq = boundary?.openTurnStartSeq
        return {
            turn: startSeq === null || startSeq === undefined ? null : { number: boundary.lastTurn, startSeq },
            goal: current === undefined || current === null || current.phase === 'complete' ? null : { id: String(current.id) },
        }
    }

    function parentOf(session) {
        const header = session?.header
        if (header?.origin !== 'subagent' || header.parentSession === undefined) return undefined
        const parent = ctx.agents.get(header.parentSession)
        if (parent === undefined || !ctx.agents.isOwnedBy(session.id, parent)) return undefined
        return parent
    }

    /** Goal 创建事件所在的那一轮（Goal 的绑定缺了时用它恢复）。 */
    function creationTurn(session, goalId) {
        let open
        for (const event of session.snapshotEvents()) {
            if (event.type === 'turn/start') open = { number: event.data.turn, startSeq: event.seq }
            else if (event.type === 'turn/end') open = undefined
            else if (event.type === 'goal/change' && event.data?.operation === 'create' && String(event.data.goal?.id) === goalId) return open
        }
        return undefined
    }

    async function select(agent, info) {
        const sessionId = String(agent.session.id)
        const turn = { turn: info.turn.number, turnStartSeq: info.turn.startSeq }
        const own = versions.binding(sessionId, 'turn', info.turn.startSeq)
        if (own !== undefined) return versions.load(own.versionId, `第 ${info.turn.number} 轮的绑定`)
        const adopt = async (versionId, origin) => {
            const record = versions.load(versionId, origin)
            await versions.bind(sessionId, 'turn', turn, record.id)
            return record
        }
        if (info.goal !== null) {
            const goal = versions.binding(sessionId, 'goal', info.goal.id)
            if (goal !== undefined) return adopt(goal.versionId, `Goal ${info.goal.id} 的绑定`)
            const created = creationTurn(agent.session, info.goal.id)
            const atCreation = created === undefined ? undefined : versions.binding(sessionId, 'turn', created.startSeq)
            if (atCreation !== undefined) {
                await versions.bind(sessionId, 'goal', { turn: created.number, turnStartSeq: created.startSeq, goalId: info.goal.id }, atCreation.versionId)
                return adopt(atCreation.versionId, `Goal ${info.goal.id} 创建时那一轮的绑定`)
            }
        }
        const session = versions.binding(sessionId, 'session')
        if (session !== undefined) return adopt(session.versionId, '会话的绑定')
        const parent = parentOf(agent.session)
        if (parent !== undefined) {
            const parentInfo = processingOf(parent.session)
            const parentTurn = parentInfo.turn === null ? undefined : versions.binding(String(parent.session.id), 'turn', parentInfo.turn.startSeq)
            if (parentTurn !== undefined) {
                await versions.bind(sessionId, 'session', {}, parentTurn.versionId)
                return adopt(parentTurn.versionId, `父会话 ${parent.session.id} 这一轮的绑定`)
            }
        }
        // 版本正文先落盘，再写绑定。
        const record = await versions.ensure(await readStable())
        if (info.goal !== null) await versions.bind(sessionId, 'goal', { ...turn, goalId: info.goal.id }, record.id)
        await versions.bind(sessionId, 'turn', turn, record.id)
        return record
    }

    /** 启用时已经在跑、又没有任何绑定的那一轮：`会话\0这一轮的起点`。 */
    const suppressed = new Set()
    const turnKey = (sessionId, startSeq) => `${sessionId}\u0000${startSeq}`
    /** 同一轮并行的几次组装只选一次。 */
    const inflight = new Map()

    function hasAnyBinding(sessionId, info) {
        return versions.binding(sessionId, 'turn', info.turn.startSeq) !== undefined
            || (info.goal !== null && versions.binding(sessionId, 'goal', info.goal.id) !== undefined)
            || versions.binding(sessionId, 'session') !== undefined
    }

    for (const agent of ctx.agents.list()) {
        let info
        try {
            info = processingOf(agent.session)
        } catch {
            continue
        }
        const sessionId = String(agent.session.id)
        if (info.turn === null || hasAnyBinding(sessionId, info)) continue
        suppressed.add(turnKey(sessionId, info.turn.startSeq))
        core.report('mind/suppressed-open-turn', { sessionId, text: `心智启用时会话 ${sessionId} 的第 ${info.turn.number} 轮已经在跑，这一轮不补人格，下一轮生效` })
    }

    /** 这个 Agent 这一轮的版本；没有正在跑的一轮时为 `undefined`，启用时那一轮为 `'suppressed'`。 */
    async function currentVersion(agent) {
        const info = processingOf(agent.session)
        if (info.turn === null) return undefined
        const sessionId = String(agent.session.id)
        const key = turnKey(sessionId, info.turn.startSeq)
        if (suppressed.has(key)) return 'suppressed'
        let pending = inflight.get(key)
        if (pending === undefined) {
            pending = select(agent, info).finally(() => {
                if (inflight.get(key) === pending) inflight.delete(key)
            })
            inflight.set(key, pending)
        }
        return pending
    }

    /* ------------------------------------------------------------------ 段 */

    core.segment({
        name: SEGMENT,
        order: 300,
        audience: 'opening',
        onChange: 'notice',
        noticeText: '（DSH 提示，不是用户发言）人格、长期认知或常驻记忆已由别处更新；需要时用 `assistant_mind_read` 读最新版本。',
        // 读不出就不往下跑：没有人格的一轮不该当成正常的一轮。
        onError: 'fail',
        text: async ({ agent }) => {
            // 没有正在跑的一轮（预览、开对话前取开头）：读当前文件，不写绑定。
            const version = agent === undefined ? undefined : await currentVersion(agent)
            if (version === 'suppressed') return ''
            return composeText(version ?? await readStable())
        },
    })

    core.segment({
        name: BETWEEN_SEGMENT,
        order: 310,
        audience: 'opening',
        onChange: 'notice',
        noticeText: '（DSH 提示，不是用户发言）“我们之间”已由别处更新；需要时用 `assistant_mind_read`（part "between_us"）读最新版本。',
        text: async () => (await readPart('between')).text.trim(),
    })

    /* ------------------------------------------------------------------ 服务 */

    /**
     * 某个会话的版本。
     * @param at - 不给：这个会话正在跑的那一轮（会话要在内存里）；`{ turn }`：那一轮起点的绑定（`turn` 是轮起点的 seq）；
     *   `{ goalId }`、`'session'`：那个绑定。
     * @returns `{ versionId, persona, cognition, standing }`；启用时那一轮为 `{ suppressed: true }`；没有时为 `null`。
     */
    async function snapshot(sessionId, at) {
        const id = String(sessionId)
        let record
        if (at === undefined) {
            const agent = ctx.agents.get(id)
            if (agent === undefined) throw new Error(`mind.snapshot：会话 ${id} 不在内存里，要给 at`)
            const version = await currentVersion(agent)
            if (version === 'suppressed') return { suppressed: true }
            record = version
        } else {
            const found = at === 'session' ? versions.binding(id, 'session')
                : at?.goalId !== undefined ? versions.binding(id, 'goal', String(at.goalId))
                    : at?.turn !== undefined ? versions.binding(id, 'turn', at.turn) : undefined
            record = found === undefined ? undefined : versions.load(found.versionId, '绑定')
        }
        return record === undefined ? null : { versionId: record.id, persona: record.persona, cognition: record.cognition, standing: record.standing ?? '' }
    }

    /** 把一个 Goal 或会话本身固定到某个版本（持续工作用）。 */
    async function pin(sessionId, at, versionId) {
        versions.load(versionId, 'pin ')
        if (at === 'session') return void await versions.bind(String(sessionId), 'session', {}, versionId)
        if (typeof at?.goalId === 'string') return void await versions.bind(String(sessionId), 'goal', { goalId: at.goalId }, versionId)
        throw new TypeError("pin 的 at 只能是 { goalId } 或 'session'")
    }

    async function read(part) {
        if (!Object.hasOwn(files, part)) throw new TypeError("read 的 part 只能是 persona、cognition、standing 或 between")
        return readPart(part)
    }

    async function candidates() {
        const entries = await core.content.list(config.candidatesDirectory)
        const pending = []
        for (const { path } of entries) {
            if (!path.endsWith('.md')) continue
            const stored = await core.content.read(path)
            const candidate = stored === null ? null : parseCandidate(stored.text)
            if (candidate?.state === 'pending') pending.push({ candidate: candidate.code, summary: candidate.summary, created: candidate.created, confirmPhrase: phrase(candidate.code) })
        }
        return pending
    }

    ctx.provide(SERVICE, { snapshot, pin, read, candidates })

    /* ------------------------------------------------------------------ 写入 */

    async function requireBase(part, baseHash) {
        const current = await readPart(part)
        const given = baseHash === '' || baseHash === undefined ? null : baseHash
        if (given !== current.hash) throw new MindWriteError(`${PART_LABELS[part]}在你读取以后已经变了，基于下面的当前内容重新改`, current.text)
        return current
    }

    const withNewline = text => (text.endsWith('\n') ? text : `${text}\n`)
    const overLimit = (text, limit) => (limit > 0 && text.length > limit ? `超出篇幅上限 ${limit} 字（现在 ${text.length} 字），已照样写入；下次整理时压缩一下` : undefined)

    /** 整份替换长期认知或常驻记忆。 */
    async function replaceWhole(part, limit, args, who) {
        const text = String(args.text ?? '')
        const summary = String(args.summary ?? '').trim()
        if (summary === '') throw new MindWriteError('summary 不能为空：写明这次整理了什么')
        const base = await requireBase(part, args.baseHash)
        const written = await core.content.write([{ path: files[part], text: withNewline(text), baseHash: base.hash }], { message: `${PART_LABELS[part]}：${summary}`, by: who })
        const note = overLimit(text, limit)
        return { hash: written.hashes[files[part]] ?? null, commit: written.commit ?? null, ...note === undefined ? {} : { note } }
    }

    async function updatePersona(args, who) {
        const text = String(args.text ?? '')
        const summary = String(args.summary ?? '').trim()
        if (text.trim() === '' || summary === '') throw new MindWriteError('text 与 summary 不能为空')
        const can = permissions(who)
        if (args.kind === 'daily') {
            if (!can.personaDaily) throw new MindWriteError('这个会话不能直接改人格，只能用 kind "stable" 提候选，由中枢请用户确认')
            const base = await requireBase('persona', args.baseHash)
            const written = await core.content.write([{ path: files.persona, text: withNewline(text), baseHash: base.hash }], { message: `人格日常变化：${summary}`, by: who })
            const note = overLimit(text, config.personaMaxChars)
            return { published: true, hash: written.hashes[files.persona] ?? null, commit: written.commit ?? null, ...note === undefined ? {} : { note } }
        }
        if (args.kind !== 'stable') throw new MindWriteError('kind 只能是 daily 或 stable')
        const base = await requireBase('persona', args.baseHash)
        const code = candidateCode()
        const path = `${config.candidatesDirectory}/${code}.md`
        const written = await core.content.write([{
            path,
            text: formatCandidate({ code, baseHash: base.hash, created: Date.now(), summary, body: withNewline(text) }),
            baseHash: null,
        }], { message: `人格候选 ${code}：${summary}`, by: who })
        const asked = phrase(code)
        if (who?.kind === 'session' && who.role === 'hub') {
            return {
                published: false, candidate: code, confirmPhrase: asked, commit: written.commit ?? null,
                note: `把变化摘要告诉用户，请用户本人回复"${asked}"；收到后调用 assistant_persona_decide。等待期间当前人格继续生效。`,
            }
        }
        // 不是中枢提的：心智模块自己转交中枢，不靠提出方去说。
        const proposer = who?.kind === 'external' ? `外部调用方 ${who.name}` : `会话 ${who?.sessionId ?? '（不明）'}`
        const handed = await core.deliver('hub', {
            key: `mind-candidate:${code}`,
            text: `（心智模块转交，不是用户发言）${proposer}提出了一个人格的稳定变化候选 ${code}：${summary}。`
                + `请先用 assistant_mind_read 看 candidates，向用户说明这个变化，请用户本人回复"${asked}"；收到后调用 assistant_persona_decide。`
                + '用户不同意就撤回（decision "withdraw"）。等待期间当前人格继续生效。',
            source: { kind: CANDIDATE_SOURCE, key: code },
            speaker: SPEAKER,
            wake: 'next-turn',
        })
        if (handed.status === 'unavailable') core.report('mind/candidate-undelivered', { text: `人格候选 ${code} 没能转交中枢（${handed.reason}）` })
        return {
            published: false, candidate: code, commit: written.commit ?? null,
            note: handed.status === 'unavailable'
                ? `候选已存下，但没能转交中枢（${handed.reason}）；中枢下次查看候选时会看到`
                : '候选已存下并转交中枢，由中枢向用户确认；确认之前当前人格继续生效。',
        }
    }

    async function decidePersona(args, who) {
        const code = String(args.candidate ?? '').toUpperCase()
        if (!CANDIDATE_CODE.test(code)) throw new MindWriteError('candidate 应为 4 位候选编号')
        const path = `${config.candidatesDirectory}/${code}.md`
        const stored = await core.content.read(path)
        const candidate = stored === null ? null : parseCandidate(stored.text)
        if (candidate === null) throw new MindWriteError(`没有候选 ${code}`)
        if (candidate.state !== 'pending') throw new MindWriteError(`候选 ${code} 已${candidate.state === 'confirmed' ? '发布' : '作废'}`)
        const settle = (state, message) => core.content.write([{ path, text: withState(stored.text, state), baseHash: stored.hash }], { message, by: who })
        if (args.decision === 'withdraw') {
            const written = await settle('withdrawn', `人格候选 ${code}：撤回`)
            return { candidate: code, state: 'withdrawn', commit: written.commit ?? null }
        }
        if (args.decision !== 'confirm') throw new MindWriteError('decision 只能是 confirm 或 withdraw')
        const asked = phrase(code)
        const { own, otherAfter } = await core.provenance.latestFromUser(who.sessionId, { after: candidate.created - 1 })
        if (own === null || !confirms(own.text, code, phrase)) {
            if (otherAfter !== undefined && confirms(otherAfter.text, code, phrase)) {
                throw new MindWriteError(`带"${asked}"的这条不是用户本人发的（是转交、外部 CLI 或认不出来处的消息），所以不能确认；要用户本人回复`)
            }
            throw new MindWriteError(`没有看到用户本人在候选提出后回复"${asked}"；人格只在用户本人确认后发布`)
        }
        const current = await readPart('persona')
        if (current.hash !== candidate.baseHash) {
            await settle('stale', `人格候选 ${code}：人格已变，作废`)
            throw new MindWriteError(`人格在候选提出后已被修改，候选 ${code} 作废；请基于当前人格重新提出`, current.text)
        }
        // 新人格和候选状态一次提交。
        const written = await core.content.write([
            { path: files.persona, text: candidate.body, baseHash: current.hash },
            { path, text: withState(stored.text, 'confirmed'), baseHash: stored.hash },
        ], { message: `人格稳定变化（用户确认 ${code}）：${candidate.summary}`, by: who })
        const note = overLimit(candidate.body, config.personaMaxChars)
        return { candidate: code, state: 'confirmed', commit: written.commit ?? null, ...note === undefined ? {} : { note } }
    }

    async function readMind(args) {
        if (args.part === 'candidates') return { pending: await candidates() }
        const part = { personality: 'persona', cognition: 'cognition', standing: 'standing', between_us: 'between' }[args.part]
        if (part === undefined) throw new MindWriteError('part 只能是 personality、cognition、standing、between_us 或 candidates')
        const current = await readPart(part)
        return { file: files[part], hash: current.hash, text: current.text }
    }

    /* ------------------------------------------------------------------ 工具 */

    ctx.effect(() => core.declareSource(CANDIDATE_SOURCE, { intent: 'prompt', annotate: false, speaker: SPEAKER }), 'mind-framework-mind: candidate source')
    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
    const tool = ({ execute, ...definition }, meta) => core.tool(defineTool({
        ...definition,
        output,
        execute: async (args, exec) => JSON.stringify(await execute(args ?? {}, core.caller(exec)), null, 1),
    }), meta)

    tool({
        name: 'assistant_mind_read',
        description: 'Read the current personality, long-term cognition, standing memory or "between us" with its version hash (needed to update it), or list persona candidates waiting for the user\'s confirmation. part: "personality", "cognition", "standing", "between_us" or "candidates".',
        parameters: { part: { type: 'string', required: true, description: '"personality", "cognition", "standing", "between_us" or "candidates".' } },
        execute: args => readMind(args),
    }, { effect: 'read' })
    tool({
        name: 'assistant_persona_update',
        description: 'Change the shared personality, effective from the next turn of every session. kind "daily": everyday views, interests, method preferences, short-term mood and self-understanding; published at once (only the hub session may do this). kind "stable": values, relationship with the user, long-term core goals, name, voice, appearance or a marked change of character; saved as a candidate that is published only after the user personally replies the confirmation phrase. text is the complete new personality file; baseHash comes from assistant_mind_read.',
        parameters: {
            text: { type: 'string', required: true, description: 'Complete new personality text.' },
            baseHash: { type: 'string', required: true, description: 'hash returned by assistant_mind_read for the personality.' },
            kind: { type: 'string', required: true, description: '"daily" or "stable".' },
            summary: { type: 'string', required: true, description: 'What changes and why, in one or two sentences.' },
        },
        execute: (args, who) => updatePersona(args, who),
    }, { effect: 'write', writesSegments: WRITES, allow: who => permissions(who).personaCandidate })
    tool({
        name: 'assistant_persona_decide',
        description: 'Settle a persona candidate. "confirm" publishes it only if the latest message the user personally sent in this session after the candidate was made contains the confirmation phrase and the personality is unchanged since. "withdraw" drops it (for example when the user declines).',
        parameters: {
            candidate: { type: 'string', required: true, description: '4-character candidate code.' },
            decision: { type: 'string', required: true, description: '"confirm" or "withdraw".' },
        },
        execute: (args, who) => decidePersona(args, who),
    }, { effect: 'write', writesSegments: WRITES, allow: who => permissions(who).decide })
    tool({
        name: 'assistant_cognition_update',
        description: 'Replace the long-term cognition file (effective from the next turn of every session). text is the complete new file; baseHash comes from assistant_mind_read; summary says what was reorganized.',
        parameters: {
            text: { type: 'string', required: true, description: 'Complete new long-term cognition text.' },
            baseHash: { type: 'string', required: true, description: 'hash returned by assistant_mind_read for the cognition.' },
            summary: { type: 'string', required: true, description: 'What was added, changed or removed.' },
        },
        execute: (args, who) => replaceWhole('cognition', config.cognitionMaxChars, args, who),
    }, { effect: 'write', writesSegments: WRITES, allow: who => permissions(who).cognition })
    tool({
        name: 'assistant_standing_update',
        description: 'Replace the standing memory file (effective from the next turn of every session): long-lasting facts every conversation should know, as opposed to understanding drawn from experience, which belongs in long-term cognition. When a fact changes, update it here directly; no user confirmation is needed. text is the complete new file; baseHash comes from assistant_mind_read (empty when the file does not exist yet); summary says what changed.',
        parameters: {
            text: { type: 'string', required: true, description: 'Complete new standing memory text.' },
            baseHash: { type: 'string', required: true, description: 'hash returned by assistant_mind_read for the standing memory; empty when it does not exist yet.' },
            summary: { type: 'string', required: true, description: 'What was added, changed or removed.' },
        },
        execute: (args, who) => replaceWhole('standing', config.standingMaxChars, args, who),
    }, { effect: 'write', writesSegments: WRITES, allow: who => permissions(who).standing })
    tool({
        name: 'assistant_between_us_update',
        description: 'Replace "between us" (effective from the next conversation of every session): recent shared experiences, what the user has cared about lately, the understandings and changes between the two of you. It is the continuity of companionship, not working rules (those belong in standing memory). Write dates as absolute dates. text is the complete new file; baseHash comes from assistant_mind_read with part "between_us" (empty when it does not exist yet); summary says what changed.',
        parameters: {
            text: { type: 'string', required: true, description: 'Complete new "between us" text.' },
            baseHash: { type: 'string', required: true, description: 'hash returned by assistant_mind_read for "between_us"; empty when it does not exist yet.' },
            summary: { type: 'string', required: true, description: 'What changed.' },
        },
        execute: (args, who) => replaceWhole('between', config.betweenMaxChars, args, who),
    }, { effect: 'write', writesSegments: BETWEEN_WRITES, allow: who => permissions(who).between })
}

