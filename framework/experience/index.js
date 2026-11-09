/**
 * 经历库：来源注册、检索、读取、串联。提供服务 `experience`、三个工具。
 *
 * - **来源注册**：`registerSource({ id, label, category?, pull? })` 交回 `{ append(entries, { replaceFrom?, ops? }), dispose() }`。
 *   推送式来源自己 `append`（一次拉取里要分几份各自重算的，也可以在 `pull` 里逐份 `append`，最后只交回 `cursor`）；拉取式来源给 `pull(cursor)`，经历库启动后和之后每隔一段时间问它一次，
 *   它交回 `{ entries, ops?, cursor, replaceFrom? }`（`ops` 带 `thread`、`part`），位置存在库里。编号由来源给，经历库只检查全库唯一，重复的拒收并报出来。
 *   `replaceFrom: { thread, tie }` 只删这个来源、这条时间线里 `tie` 不小于它的条目，再写回这次给出的。
 * - **条目** `{ id, thread, at, tie, role, kind, text, party?, link?, model?, title?, place?, part?, ops? }`：`role` 是
 *   user（用户本人）、assistant、peer（别处转来）、out（发往别处）、system。`part` 是来源里的一部分（比如一个记录文件），
 *   `replaceFrom` 也可以带 `part`：同一条时间线由几份文件各自喂、各自重算时用。条目带 `title` 时，这条时间线较早的条目跟着改成这个标题。
 * - **读文件的小件** `parsers.readLines(path, offset, onLine)`：按行读 JSONL，从字节位置续读，给文件型来源用。
 * - **内置来源 DSH 会话**（`dsh.js`）：顺着上游 `session/event` 一条条收；某个会话第一次见到、或者 `seq` 和上一条接不上
 *   （`session/event` 不确认不重发，会话恢复时的"进程重开"标记也不派发）就把这个会话整份读一遍补齐；启动时把全部会话
 *   整份读一遍。日志是只追加的，所以只写不删。旧日志里没有 `speaker` 的消息：库里有的保留旧分类，没有的记"来处不明"。
 *   子代理的会话不收（它的工具调用在父会话里），分叉继承来的事件不收。
 * - **能查的范围**按调用方算：中枢、后台思考、外部调用方（按它绑定的中枢算）看全部；
 *   工作会话（没定角色的也按它算）看本项目的会话和它自己。串联在遍历时就筛：看不见的时间线不进队列、不当跳板，
 *   结果末尾只写"另有 N 处关联在你看不到的会话里"。
 * - **检索**：关键词（FTS5 trigram）和语义各取前 `limit×3` 名，按名次合并（RRF，k=60）；语义用 `embedder` 服务，
 *   没有或失败时只按关键词并写明。向量按"模型@维度"区分，后台补算。
 * - 存储照旧是一个 SQLite 文件（`archive.js`），旧库原样接着用，编号不变，已有向量照样用。
 *
 * @module @loveandbeepbrother/dsh-galatea/experience
 */

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { agoText, clockText, parseTimeText, timeFields } from '../core/time.js'
import { cosine } from '../embedder/index.js'
import { ulid } from '../memory/store.js'
import { excerptOf, formatFavorites, parseFavorites } from './favorites.js'
import { excerpt, literalRanges, snippetAround, textWindow } from '../memory/notes.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MARKER_KINDS, openArchive, termsOf, vectorText } from './archive.js'
import { createDshParser, nextStep, titleOf } from './dsh.js'
import { readLines } from './files.js'

export const name = 'mind-framework-experience'
export const inject = ['core', 'sessionQuery']
export const SERVICE = 'experience'
/** 体检搜一句原话时取多少字。 */
const SAMPLE_CHARS = 40
/** 交接整理的摘录每条最多多少字；用户的话留得最多，转来的话最少。 */
const DIGEST_CLIPS = Object.freeze({ user: 2000, assistant: 600, out: 800, peer: 400 })
/** 没有边界时往回看多久。 */
const DIGEST_FALLBACK_MS = 72 * 3_600_000
/** 运行时快照和时钟这类注入的文字，不是谁说的话。 */
const INJECTED_TEXT = /^(Current runtime context|Time sampled while)/

export const ROLES = Object.freeze({ user: '用户', assistant: '助手', peer: '会话转来', out: '发往别的会话', system: '系统' })
const MARKER_ALIASES = Object.freeze({ compaction: '压缩', handoff: '交接', restart: '进程重开', model: '换模型' })
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30
const DEFAULT_WINDOW = 12_000
const MAX_WINDOW = 32_000
const DEFAULT_CONTEXT = 2
const MAX_CONTEXT = 5
const DEFAULT_PAGE = 20
const MAX_PAGE = 100
const MAX_OPS = 25
const SEGMENT_ENTRIES = 500
const DEFAULT_SEGMENTS = 12
const MAX_SEGMENTS = 30
const FUSION_K = 60
const EMBED_BATCH = 20

export const Config = Schema.object({
    archiveFile: Schema.string().default('').description('经历库的 SQLite 文件（绝对路径）；空就用 DSH home 下的 galatea/experience.sqlite'),
    pullSeconds: Schema.natural().default(120).description('每隔多少秒问一次拉取式来源'),
    startupDelaySeconds: Schema.natural().default(10).description('启动后多久第一次问拉取式来源'),
    minSimilarity: Schema.number().default(0.35).description('语义检索的最低相似度'),
    favoritesFile: Schema.string().default('favorites.jsonl').description('收藏文件（相对内容库），见 favorites.js'),
})

/** 使用统计默认只算这两种调用方：后台思考、交接整理做整理时会把一大批都搜一遍，算进去就分不出哪些真被用到。 */
export const DEFAULT_USAGE_ROLES = Object.freeze(['hub', 'worker'])
const USAGE_SOURCES = Object.freeze(['memory', 'notes', 'documents', 'experience'])

export class ExperienceError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

const clamp = (value, low, high, fallback) => (Number.isInteger(value) ? Math.min(high, Math.max(low, value)) : fallback)

function parseTime(value, field, timezone) {
    if (value === undefined || value === null || value === '') return undefined
    // 不带偏移的（只有日期也一样）按核心的时区算，不按 Host 进程的本地时区；我们给出的 `at` 带偏移，原样传回来就对。
    const time = parseTimeText(value, timezone)
    if (!Number.isFinite(time)) throw new ExperienceError('INVALID_ARGUMENT', `${field} 不是可识别的日期或时间：${value}`)
    return time
}

/** 一个时刻在给定时区（核心的 `timezone`）里的 `YYYY-MM-DD HH:MM:SS`。不用进程本地时区：Host 进程的 TZ 可能是为别的用途设的。 */
export function localTime(ms, timezone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map(part => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

/** 条目在哪：DSH 会话写标题；别的来源写它登记时的 label（`label` 是按条目的 category 找到的那个来源的）。 */
function whereOf(row, label) {
    if (row.source === 'dsh') return `DSH「${row.title ?? row.session_id}」${row.place ? `（${row.place}）` : ''}`
    return `${label ?? row.source}${row.title ? `「${row.title}」` : ''}（${row.place ?? row.session_id}）`
}

function snippetOf(text, terms) {
    for (const term of terms) {
        const hit = literalRanges(text, term)[0]
        if (hit !== undefined) return snippetAround(text, hit.index, hit.length)
    }
    return excerpt(text)
}

const preview = (text, size = 100) => {
    const chars = Array.from(String(text).replace(/\s+/g, ' ').trim())
    return chars.length > size ? `${chars.slice(0, size).join('')}…` : chars.join('')
}
const brief = timezone => row => ({ ref: row.id, at: clockText(row.at, timezone), who: `${ROLES[row.role] ?? row.role}·${row.kind}`, preview: preview(row.text) })
const opLine = op => (op.detail ? `${op.tool} ${op.detail}` : op.tool)

/**
 * 调用方能看的时间线：`{ all: true }` 或 `{ threads: Set }`。
 * @param projectOf - 核心的 `projectOf`；`threadsOf()` 交回库里全部时间线。
 */
export function visibilityOf(who, { projectOf, threadsOf }) {
    if (who?.kind === 'external') return { all: true }
    if (who?.kind !== 'session') return { threads: new Set() }
    if (who.role === 'hub' || who.role === 'background' || who.role === 'tidy') return { all: true }
    const project = projectOf(who.sessionId)
    const threads = new Set([who.sessionId])
    if (project !== null) for (const thread of threadsOf()) if (projectOf(thread)?.id === project.id) threads.add(thread)
    return { threads }
}

/** @param options.archive - 换掉 SQLite 文件（测试用，`':memory:'`）。 */
export async function apply(ctx, config, options = {}) {
    const core = ctx.core
    // 没配就放在 DSH home 下，和内容库在一处。
    const file = options.archive ?? (config.archiveFile || dshHomePath('galatea', 'experience.sqlite'))
    const archive = openArchive(file)
    let closed = false
    ctx.effect(() => () => {
        closed = true
        archive.close()
    }, 'mind-framework-experience: archive')
    const reported = new Set()
    const reportOnce = (kind, key, detail) => {
        if (reported.has(`${kind}:${key}`)) return
        reported.add(`${kind}:${key}`)
        core.report(kind, detail)
    }
    const threadsStatement = archive.db.prepare('select distinct session_id from entries')
    const threadsOf = () => threadsStatement.all().map(row => row.session_id)
    const visibility = who => visibilityOf(who, { projectOf: id => core.sessions.projectOf(id), threadsOf })
    const sees = (seen, thread) => seen.all === true || seen.threads.has(thread)

    /* ------------------------------------------------------------------ 来源 */

    const sources = new Map()
    const cursorKey = id => `v2:src:${id}`
    /** 某个 category 的来源的 label（几个来源同一个 category 时取先登记的）；来源已撤销时为 undefined。 */
    const labelOf = category => [...sources.values()].find(source => source.category === category)?.label

    function write(source, entries, replaceFrom, extraOps = []) {
        const byThread = new Map()
        const groupKey = (thread, part) => `${thread}\u0000${part ?? ''}`
        for (const entry of entries) {
            if (typeof entry?.id !== 'string' || entry.id === '' || typeof entry.thread !== 'string' || entry.thread === '') {
                throw new ExperienceError('INVALID_ENTRY', `来源 ${source.id} 交来的条目缺 id 或 thread`)
            }
            if (!Number.isFinite(entry.at) || !Number.isFinite(entry.tie) || !(entry.role in ROLES) || typeof entry.kind !== 'string' || typeof entry.text !== 'string') {
                throw new ExperienceError('INVALID_ENTRY', `来源 ${source.id} 的条目 ${entry.id} 缺 at、tie、role、kind 或 text`)
            }
            const key = groupKey(entry.thread, entry.part)
            const group = byThread.get(key) ?? { thread: entry.thread, part: entry.part, list: [] }
            group.list.push(entry)
            byThread.set(key, group)
        }
        if (replaceFrom !== undefined && !byThread.has(groupKey(replaceFrom.thread, replaceFrom.part))) {
            byThread.set(groupKey(replaceFrom.thread, replaceFrom.part), { thread: replaceFrom.thread, part: replaceFrom.part, list: [] })
        }
        // 只有操作、没有条目的一批也要写：来源的读取位置已经往前走了，这里丢了就补不回来。
        for (const op of extraOps) {
            if (typeof op?.thread === 'string' && op.thread !== '' && !byThread.has(groupKey(op.thread, op.part))) {
                byThread.set(groupKey(op.thread, op.part), { thread: op.thread, part: op.part, list: [] })
            }
        }
        let changed = 0
        for (const { thread, part, list } of byThread.values()) {
            const first = list.find(entry => entry.title !== undefined || entry.place !== undefined)
            const replaces = replaceFrom !== undefined && replaceFrom.thread === thread && (replaceFrom.part ?? undefined) === (part ?? undefined)
            const ops = [
                ...list.flatMap(entry => (entry.ops ?? []).map(op => ({ ...op, at: op.at ?? entry.at, tie: op.tie ?? entry.tie }))),
                ...extraOps.filter(op => op.thread === thread && (op.part ?? undefined) === (part ?? undefined)),
            ]
            const result = archive.write({
                source: source.category,
                sessionId: thread,
                origin: part === undefined ? source.id : `${source.id}:${part}`,
                title: first?.title,
                place: first?.place,
                ...replaces ? { replaceFrom: replaceFrom.tie } : {},
            }, list, ops)
            changed += result.changed
            if (first?.title !== undefined) archive.retitle(thread, first.title)
            for (const message of result.rejected) core.report('experience/duplicate-id', { text: message, data: { source: source.id } })
        }
        if (changed > 0) embedLater()
        return changed
    }

    /**
     * 登记一个来源。
     * @param definition - `{ id, label, category?（检索时按它筛，默认同 id）, pull?(cursor) }`。
     * @returns `{ append(entries, { replaceFrom?, ops? }), dispose() }`。
     */
    function registerSource(definition) {
        const { id, label, category = id, pull } = definition ?? {}
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) throw new TypeError('来源要有 id（小写字母、数字、连字符）')
        if (typeof label !== 'string' || label === '') throw new TypeError(`来源 ${id} 要有 label`)
        if (pull !== undefined && typeof pull !== 'function') throw new TypeError(`来源 ${id} 的 pull 要是函数`)
        if (sources.has(id)) throw new Error(`来源 ${id} 已经登记过`)
        const source = Object.freeze({ id, label, category, pull })
        sources.set(id, source)
        if (pull !== undefined && started) setImmediate(() => pullOne(source))
        return Object.freeze({
            append: (entries, { replaceFrom, ops = [] } = {}) => {
                if (sources.get(id) !== source) throw new Error(`来源 ${id} 已经撤销登记`)
                return write(source, entries, replaceFrom, ops)
            },
            dispose: () => {
                if (sources.get(id) === source) sources.delete(id)
            },
        })
    }

    async function pullOne(source) {
        if (closed || sources.get(source.id) !== source) return
        try {
            const result = await source.pull(archive.cursor(cursorKey(source.id)))
            if (closed || sources.get(source.id) !== source || result === undefined || result === null) return
            write(source, result.entries ?? [], result.replaceFrom, result.ops ?? [])
            if (result.cursor !== undefined) archive.setCursor(cursorKey(source.id), result.cursor)
        } catch (error) {
            reportOnce('experience/pull-failed', `${source.id}:${error?.message ?? error}`, { text: `经历库问来源 ${source.label} 失败（${error?.message ?? error}），下次再问` })
        }
    }

    let pulling = null
    function pullAll() {
        pulling ??= (async () => {
            for (const source of [...sources.values()]) if (source.pull !== undefined) await pullOne(source)
        })().finally(() => {
            pulling = null
        })
        return pulling
    }

    let started = false
    const startTimer = setTimeout(() => {
        started = true
        readAllSessions().then(() => pullAll())
    }, config.startupDelaySeconds * 1000)
    const tick = config.pullSeconds > 0 ? setInterval(() => {
        if (started) pullAll()
    }, config.pullSeconds * 1000) : undefined
    ctx.effect(() => () => {
        clearTimeout(startTimer)
        if (tick !== undefined) clearInterval(tick)
    }, 'mind-framework-experience: timers')

    /** 从原始来源整体重建：清空条目、操作和读到的位置（向量按指纹复用）。 */
    async function rebuild() {
        archive.reset()
        vectors = null
        dshState.clear()
        await readAllSessions()
        await pullAll()
        return archive.stats()
    }

    /* ------------------------------------------------------------------ 内置来源：DSH 会话 */

    const dshSource = Object.freeze({ id: 'dsh-events', label: 'DSH 会话', category: 'dsh' })
    sources.set(dshSource.id, dshSource)
    /** 会话 → `{ parser, lastSeq }`；`null` 表示子代理会话，不收。 */
    const dshState = new Map()
    const chains = new Map()
    const serial = (key, job) => {
        const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(job)
        chains.set(key, next.catch(() => {}))
        return next
    }

    /** 这一批里的条目按库里有没有处理：旧日志没有 speaker 的，库里有就留旧分类。 */
    function settleDsh(sessionId, entries) {
        const kept = []
        for (const { legacy, unknown, ...item } of entries) {
            if (legacy === true && archive.get(item.id) !== undefined) continue
            if (unknown === true) reportOnce('experience/unknown-speaker', sessionId, { sessionId, text: `会话 ${sessionId} 里有认不出谁说的消息（${item.id}），记成"来处不明"` })
            kept.push(item)
        }
        return kept
    }

    function writeDsh(sessionId, parsed, { title, place } = {}) {
        const entries = settleDsh(sessionId, parsed.entries).map(item => ({ ...item, ...title === undefined ? {} : { title }, ...place === undefined ? {} : { place } }))
        write(dshSource, entries, undefined, parsed.ops.map(op => ({ ...op, thread: sessionId })))
    }

    /**
     * 整份读一个会话。在内存里的会话读它自己的日志：`readSession` 会给读的时候没结束的一轮补一个收尾，
     * 补出来的事件占了 seq，之后真来的事件就接不上，每条都会再整份读一遍。
     */
    async function readSessionWhole(sessionId, live = ctx.get('agents')?.get(SessionId(sessionId))?.session) {
        if (closed) return
        let snapshot
        try {
            snapshot = live !== undefined
                ? { session: live.header, inheritedEventCount: live.inheritedEventCount, events: live.snapshotEvents() }
                : await ctx.sessionQuery.readSession(SessionId(sessionId))
        } catch (error) {
            reportOnce('experience/session-read-failed', `${sessionId}:${error?.message ?? error}`, { sessionId, text: `经历库读会话 ${sessionId} 失败（${error?.message ?? error}）` })
            return
        }
        if (closed) return
        if (snapshot.session?.origin === 'subagent') {
            dshState.set(sessionId, null)
            return
        }
        const events = snapshot.events.slice(snapshot.inheritedEventCount ?? 0)
        const parser = createDshParser(sessionId)
        const parsed = { entries: [], ops: [] }
        for (const event of events) {
            const one = parser.feed(event)
            parsed.entries.push(...one.entries)
            parsed.ops.push(...one.ops)
        }
        const title = titleOf(snapshot.events)
        writeDsh(sessionId, parsed, { title, place: snapshot.session?.cwd })
        if (title !== undefined) archive.retitle(sessionId, title)
        dshState.set(sessionId, { parser, lastSeq: events.at(-1)?.seq ?? snapshot.events.at(-1)?.seq ?? -1 })
    }

    async function readAllSessions() {
        let records
        try {
            records = await ctx.sessionQuery.listSessions()
        } catch (error) {
            core.report('experience/session-list-failed', { text: `经历库列会话失败（${error?.message ?? error}）` })
            return
        }
        for (const record of records) {
            if (closed) return
            const sessionId = String(record.header.id)
            await serial(sessionId, () => readSessionWhole(sessionId))
        }
    }

    ctx.on('session/event', (session, event) => {
        if (closed || !started) return
        const sessionId = String(session.id)
        serial(sessionId, async () => {
            const state = dshState.get(sessionId)
            const step = nextStep(state, event.seq)
            if (step === 'skip') return
            // 整份读一遍补齐，这一条也在里面。
            if (step === 'reread') return readSessionWhole(sessionId, session)
            state.lastSeq = event.seq
            writeDsh(sessionId, state.parser.feed(event), { place: session.header?.cwd })
            if (event.type === 'session/title' && typeof event.data?.title === 'string') archive.retitle(sessionId, event.data.title)
        }).catch(error => reportOnce('experience/ingest-failed', `${sessionId}:${error?.message ?? error}`, { sessionId, text: `经历库收录会话 ${sessionId} 失败（${error?.message ?? error}）` }))
    }, { global: true })

    /* ------------------------------------------------------------------ 向量 */

    let vectors = null
    let embedding = null
    /** 后台补算最近一次失败的原因；补算成功过一批就清掉。 */
    let backfillError = null
    const modelOf = embedder => `${embedder.model}@${embedder.dimensions}`
    function embedLater() {
        const embedder = ctx.get('embedder')
        if (embedder === undefined || embedding !== null || closed) return
        const model = modelOf(embedder)
        embedding = (async () => {
            while (!closed) {
                const batch = archive.stale(model, EMBED_BATCH)
                if (batch.length === 0) return
                const computed = await embedder.embed(batch.map(vectorText))
                if (closed) return
                if (backfillError !== null) {
                    // 又能算了：关掉报过的异常；之后再坏再报。
                    backfillError = null
                    for (const key of [...reported]) if (key.startsWith('experience/embed-failed:')) reported.delete(key)
                    core.report('experience/embed-failed', { text: '经历库补算向量恢复了', data: { resolved: true } })
                }
                batch.forEach((row, index) => {
                    archive.putVector(row.id, row.vhash, model, computed[index])
                    if (vectors?.model === model) {
                        const meta = archive.get(row.id)
                        if (meta !== undefined) vectors.items.set(row.id, { id: row.id, hash: row.vhash, source: meta.source, sessionId: meta.session_id, at: meta.at, vector: computed[index] })
                    }
                })
            }
        })().catch(error => {
            backfillError = String(error?.message ?? error)
            reportOnce('experience/embed-failed', String(error?.message ?? error), { text: `经历库补算向量失败（${error?.message ?? error}），下次有新条目时再试` })
        }).finally(() => {
            embedding = null
        })
    }

    /* ------------------------------------------------------------------ 读取用的小件 */

    function opsOf(row) {
        if (row.role !== 'assistant') return undefined
        const from = archive.boundaryBefore(row) ?? { at: Number.MIN_SAFE_INTEGER, tie: 0 }
        const ops = archive.opsBetween(row.session_id, from, row)
        if (ops.length === 0) return undefined
        const lines = ops.slice(0, MAX_OPS).map(opLine)
        if (ops.length > MAX_OPS) lines.push(`……另有 ${ops.length - MAX_OPS} 项`)
        return lines
    }

    function full(row, text) {
        return {
            ref: row.id,
            ...timeFields(row.at, core.timezone),
            role: ROLES[row.role] ?? row.role,
            kind: row.kind,
            ...row.party ? { party: row.party } : {},
            ...(row.link ?? row.inferred_link) ? { link: row.link ?? row.inferred_link } : {},
            ...row.model ? { model: row.model } : {},
            ...text,
        }
    }

    function clipped(row, budget, offset = 0) {
        const window = textWindow(row.text, Math.min(offset, Array.from(row.text).length), Math.max(1, budget))
        return {
            text: window.text,
            ...window.nextOffset === undefined && offset === 0 ? {} : { totalCharacters: window.totalCharacters },
            ...window.nextOffset === undefined ? {} : { nextOffset: window.nextOffset },
            ...offset > 0 ? { offset } : {},
        }
    }

    function requireRow(ref, seen) {
        const row = archive.get(String(ref ?? ''))
        if (row === undefined || !sees(seen, row.session_id)) throw new ExperienceError('REFERENCE_ERROR', `经历库里没有 ${ref}；请先用 assistant_history_search 找到它`)
        return row
    }

    /* ------------------------------------------------------------------ 检索 */

    async function search(args = {}, by) {
        const query = String(args.query ?? '').trim()
        if (query === '') throw new ExperienceError('INVALID_ARGUMENT', 'query 不能为空')
        if (args.role !== undefined && ROLES[args.role] === undefined) throw new ExperienceError('INVALID_ARGUMENT', `role 只能是 ${Object.keys(ROLES).join('、')}`)
        const seen = visibility(by)
        const sessionId = args.sessionId === undefined ? undefined : String(args.sessionId)
        if (sessionId !== undefined && !sees(seen, sessionId)) throw new ExperienceError('REFERENCE_ERROR', `看不到会话 ${sessionId}`)
        const filter = {
            source: args.source === undefined ? undefined : String(args.source),
            sessionId,
            ...seen.all === true || sessionId !== undefined ? {} : { sessions: [...seen.threads] },
            role: args.role,
            since: parseTime(args.since, 'since', core.timezone),
            until: parseTime(args.until, 'until', core.timezone),
        }
        const limit = clamp(args.limit, 1, MAX_LIMIT, DEFAULT_LIMIT)
        const around = clamp(args.context, 0, MAX_CONTEXT, DEFAULT_CONTEXT)
        // 只看收藏过的：关键词一路在索引里就按编号筛（不会被别的挤出前几名），语义一路和旧表逐条筛。
        const favorites = args.favorites === true ? await favoriteRefs() : null
        if (favorites !== null && favorites.size === 0) return { query, items: [], searched: { keyword: true, semantic: 'ok' }, note: '还没有按编号收藏的经历' }
        const terms = termsOf(query)
        const ranked = new Map()
        const add = (id, rank, how, similarity) => {
            const item = ranked.get(id) ?? { id, score: 0, how: new Set(), similarity: undefined }
            item.score += 1 / (FUSION_K + rank)
            item.how.add(how)
            if (similarity !== undefined) item.similarity = similarity
            ranked.set(id, item)
        }
        // 关键词走检索底座的索引，和 assistant_search 同一套分词。它没装、还没建好，或者要查系统条目（索引不收）时用旧表。
        const indexed = filter.role === 'system' ? null : ctx.get('search')?.experienceKeyword?.(query, {
            threads: filter.sessionId !== undefined ? [filter.sessionId] : filter.sessions ?? null,
            role: filter.role,
            category: filter.source,
            since: filter.since,
            until: filter.until,
            ...favorites === null ? {} : { refs: [...favorites] },
            limit: limit * 3,
        }) ?? null
        const keywordIds = indexed ?? archive.keyword(terms, filter, limit * 3).map(row => row.id)
        keywordIds.forEach((id, index) => add(id, index, 'keyword'))

        const notes = [`关键词、语义各取前 ${limit * 3} 名合并`]
        const searched = { keyword: true, semantic: 'ok' }
        const embedder = ctx.get('embedder')
        if (embedder === undefined) {
            notes.push('没有向量提供方，只做了关键词检索')
            searched.semantic = 'none'
        } else {
            try {
                const model = modelOf(embedder)
                const [target] = await embedder.embed([query])
                if (vectors?.model !== model) vectors = { model, items: new Map(archive.vectors(model).map(item => [item.id, item])) }
                for (const id of archive.drainRemoved()) vectors.items.delete(id)
                const matches = []
                for (const item of vectors.items.values()) {
                    if (favorites !== null && !favorites.has(item.id)) continue
                    if (!sees(seen, item.sessionId)) continue
                    if (filter.source !== undefined && item.source !== filter.source) continue
                    if (filter.sessionId !== undefined && item.sessionId !== filter.sessionId) continue
                    if (filter.since !== undefined && item.at < filter.since) continue
                    if (filter.until !== undefined && item.at >= filter.until) continue
                    const similarity = cosine(target, item.vector)
                    if (similarity >= config.minSimilarity) matches.push({ id: item.id, similarity })
                }
                matches.sort((left, right) => right.similarity - left.similarity)
                let rank = 0
                const links = new Set()
                for (const match of matches) {
                    if (rank >= limit * 3) break
                    const row = archive.get(match.id)
                    if (row === undefined || row.vhash !== vectors.items.get(match.id)?.hash) {
                        vectors.items.delete(match.id)
                        continue
                    }
                    if (filter.role !== undefined && row.role !== filter.role) continue
                    // 同一次发送的几份只占一个名次。
                    const link = row.link ?? row.inferred_link
                    if (link !== null && link !== undefined) {
                        if (links.has(link)) continue
                        links.add(link)
                    }
                    add(match.id, rank++, 'semantic', match.similarity)
                }
                // 按当前模型算：换过模型以后，旧模型的向量不算数。
                const unindexed = archive.staleCount(model)
                if (unindexed > 0) {
                    const { embeddable } = archive.stats()
                    const embedded = embeddable - unindexed
                    searched.semantic = 'backfilling'
                    searched.unindexed = unindexed
                    notes.push(backfillError === null ? `语义索引还在补算（${embedded}/${embeddable} 条）` : `语义索引补算停了（${embedded}/${embeddable} 条）：${backfillError}`)
                }
            } catch (error) {
                searched.semantic = 'failed'
                searched.reason = String(error?.message ?? error)
                notes.push(`语义检索暂时不可用：${error?.message ?? error}`)
            }
            if (backfillError !== null) searched.backfillError = backfillError
        }
        const shownLinks = new Set()
        const items = [...ranked.values()]
            .sort((left, right) => right.score - left.score)
            .map(item => ({ item, row: archive.get(item.id) }))
            .filter(({ row }) => row !== undefined && sees(seen, row.session_id) && (favorites === null || favorites.has(row.id)))
            // 同一次发送的几份副本（关联相同）只留排在最前的：语义一路也会同时命中两边。
            .filter(({ row }) => {
                const link = row.link ?? row.inferred_link
                if (link === null || link === undefined || shownLinks.has(link)) return link === null || link === undefined
                shownLinks.add(link)
                return true
            })
            .slice(0, limit)
            .map(({ item, row }) => ({
                ref: row.id,
                ...timeFields(row.at, core.timezone),
                where: whereOf(row, labelOf(row.source)),
                sessionId: row.session_id,
                role: ROLES[row.role] ?? row.role,
                kind: row.kind,
                ...row.party ? { party: row.party } : {},
                ...(row.link ?? row.inferred_link) ? { link: row.link ?? row.inferred_link } : {},
                match: item.how.size === 2 ? 'both' : [...item.how][0],
                ...item.similarity === undefined ? {} : { similarity: Math.round(item.similarity * 1000) / 1000 },
                text: snippetOf(row.text, terms),
                before: around === 0 ? [] : archive.before(row, around).reverse().map(brief(core.timezone)),
                after: around === 0 ? [] : archive.after(row, around).map(brief(core.timezone)),
            }))
        if (items.length === 0 && searched.semantic !== 'ok') notes.unshift('没搜到不代表没有')
        return { query, items, searched, note: notes.join('；') }
    }

    async function read(args = {}, by) {
        const seen = visibility(by)
        const limit = clamp(args.limit, 1, MAX_PAGE, DEFAULT_PAGE)
        const budget = clamp(args.maxCharacters, 1, MAX_WINDOW, DEFAULT_WINDOW)
        const offset = clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0)
        const sessionId = args.sessionId === undefined ? undefined : String(args.sessionId)
        let direction = args.direction ?? 'forward'
        if (direction !== 'forward' && direction !== 'backward') throw new ExperienceError('INVALID_ARGUMENT', 'direction 只能是 forward 或 backward')
        if (sessionId !== undefined && !sees(seen, sessionId)) throw new ExperienceError('REFERENCE_ERROR', `看不到会话 ${sessionId}`)
        let anchor
        if (args.ref !== undefined) anchor = requireRow(args.ref, seen)
        else if (sessionId === undefined) throw new ExperienceError('INVALID_ARGUMENT', '需要 ref，或 sessionId（可加 at 或 marker）')
        else if (args.marker !== undefined) {
            const marker = String(args.marker)
            const kind = marker === 'any' ? undefined : MARKER_ALIASES[marker] ?? marker
            if (kind !== undefined && !MARKER_KINDS.includes(kind)) throw new ExperienceError('INVALID_ARGUMENT', `marker 只能是 any、${Object.keys(MARKER_ALIASES).join('、')}`)
            anchor = archive.latestMarker(sessionId, kind)
            if (anchor === undefined) throw new ExperienceError('REFERENCE_ERROR', `会话 ${sessionId} 里没有这种标记`)
        } else if (args.at !== undefined) {
            const at = parseTime(args.at, 'at', core.timezone)
            anchor = direction === 'forward' ? archive.firstAtOrAfter(sessionId, at) : archive.lastBefore(sessionId, at)
        } else {
            direction = 'backward'
            anchor = archive.lastBefore(sessionId, Number.MAX_SAFE_INTEGER)
        }
        if (anchor === undefined) throw new ExperienceError('REFERENCE_ERROR', `会话 ${sessionId} 在这个位置没有条目`)
        const rows = direction === 'forward' ? [anchor, ...archive.after(anchor, limit - 1)] : [...archive.before(anchor, limit - 1).reverse(), anchor]
        const order = direction === 'forward' ? rows : [...rows].reverse()
        const kept = []
        let left = budget
        for (const row of order) {
            if (left <= 0) break
            const ops = opsOf(row)
            const text = clipped(row, left, row === anchor ? offset : 0)
            left -= Array.from(text.text).length + (ops?.join('\n').length ?? 0)
            kept.push(full(row, { ...text, ...ops ? { ops } : {} }))
        }
        const entries = direction === 'forward' ? kept : kept.reverse()
        const first = archive.get(entries[0].ref)
        const last = archive.get(entries.at(-1).ref)
        const previous = archive.before(first, 1)[0]
        const next = archive.after(last, 1)[0]
        return {
            sessionId: anchor.session_id,
            where: whereOf(anchor, labelOf(anchor.source)),
            from: archive.position(first),
            entries,
            ...previous ? { previous: previous.id } : {},
            ...next ? { next: next.id } : {},
        }
    }

    async function thread(args = {}, by) {
        const seen = visibility(by)
        const start = requireRow(args.ref, seen)
        const maxSegments = clamp(args.maxSegments, 1, MAX_SEGMENTS, DEFAULT_SEGMENTS)
        const budget = clamp(args.maxCharacters, 1, MAX_WINDOW, DEFAULT_WINDOW)
        const queue = [start]
        const segments = new Set()
        const links = new Set()
        const collected = new Map()
        /** 指到看不见的时间线的地方：`时间线\0编号`。 */
        const hidden = new Set()
        let truncated = false
        // 看不见的时间线不进队列，也不从它往下走（不当跳板）。
        const enqueue = (row, link) => {
            if (sees(seen, row.session_id)) queue.push(row)
            else hidden.add(`${row.session_id}\u0000${link}`)
        }
        while (queue.length > 0) {
            const row = queue.shift()
            const segment = archive.segmentOf(row, options.segmentEntries ?? SEGMENT_ENTRIES)
            if (segment.more) truncated = true
            const segmentKey = `${segment.start.session_id}\u0000${segment.start.id}`
            if (segments.has(segmentKey)) continue
            if (segments.size >= maxSegments) {
                truncated = true
                break
            }
            segments.add(segmentKey)
            const found = [...segment.opLinks]
            for (const item of segment.entries) {
                collected.set(item.id, item)
                if (item.link) found.push(item.link)
                if (item.inferred_link) found.push(item.inferred_link)
            }
            for (const link of found) {
                if (links.has(link)) continue
                links.add(link)
                for (const other of archive.byLink(link)) enqueue(other, link)
                for (const op of archive.opsByLink(link)) {
                    const at = archive.lastBefore(op.session_id, op.at + 1)
                    if (at !== undefined) enqueue(at, link)
                }
            }
        }
        if (!collected.has(start.id)) collected.set(start.id, start)
        const rows = [...collected.values()].sort((left, right) => left.at - right.at || left.tie - right.tie || (left.id < right.id ? -1 : 1))
        const share = Math.max(300, Math.floor(budget / Math.max(1, rows.length)))
        const items = []
        let left = budget
        for (const row of rows) {
            if (left <= 0) {
                truncated = true
                break
            }
            const ops = opsOf(row)
            const text = clipped(row, Math.min(share, left))
            left -= Array.from(text.text).length
            items.push({ where: whereOf(row, labelOf(row.source)), sessionId: row.session_id, ...full(row, { ...text, ...ops ? { ops } : {} }) })
        }
        return {
            ref: start.id,
            links: [...links],
            segments: segments.size,
            items,
            ...truncated ? { truncated: true } : {},
            ...hidden.size > 0 ? { note: `另有 ${hidden.size} 处关联在你看不到的会话里` } : {},
        }
    }

    // 给文件型来源用的读文件小件；具体记录格式由各来源自己认。
    const parsers = Object.freeze({ readLines })
    /** 体检用：这个会话某个时刻之前最近的一句用户原话和能搜回它的说法；没有时是 `null`。 */
    function sample(sessionId, before = Date.now()) {
        const row = archive.lastInputBefore(String(sessionId), before)
        if (row === undefined) return null
        const link = row.link ?? row.inferred_link
        // 带上关联：统一搜索把同一次发送的几份折成一条，交回的可能是另一份。
        return { id: row.id, query: Array.from(row.text).slice(0, SAMPLE_CHARS).join(''), ...link ? { link } : {} }
    }

    /**
     * 交接整理用的摘录：上次交接或压缩以来，用户的话、助手的回复、发往别处的和转来的话。每条截短并带编号（要紧的按编号读原文）；
     * 不要系统条目和注入的快照；超过 `maxChars` 时留最新的。
     * @returns `{ text, since, entries, omitted, oldestRef }`。
     */
    function digest(sessionId, { maxChars = 60_000, now = Date.now() } = {}) {
        const id = String(sessionId)
        const boundaries = [archive.latestMarker(id, '交接'), archive.latestMarker(id, '压缩')].filter(Boolean).map(row => row.at)
        const since = boundaries.length > 0 ? Math.max(...boundaries) : now - DIGEST_FALLBACK_MS
        const lines = []
        let chars = 0
        let omitted = 0
        let oldestRef = null
        for (const row of archive.spokenSince(id, since)) {
            if (row.role === 'assistant' && row.kind !== '回复') continue
            if (INJECTED_TEXT.test(row.text)) continue
            const all = Array.from(row.text)
            const clip = DIGEST_CLIPS[row.role] ?? DIGEST_CLIPS.peer
            const body = all.length > clip ? `${all.slice(0, clip).join('')}……（共 ${all.length} 字）` : row.text
            const line = `[${localTime(row.at, core.timezone)} ${ROLES[row.role] ?? row.role} ${row.id}] ${body}`
            if (omitted > 0 || chars + line.length > maxChars) {
                omitted += 1
                oldestRef = row.id
                continue
            }
            chars += line.length
            lines.push(line)
        }
        return { text: lines.reverse().join('\n'), since, entries: lines.length, omitted, oldestRef }
    }

    /**
     * 向量最近的条目编号（检索底座的向量一路）。
     * @param options.who - 调用方，看不到的时间线不算。
     */
    function nearest(target, model, { who, limit = 15 } = {}) {
        if (vectors?.model !== model) vectors = { model, items: new Map(archive.vectors(model).map(item => [item.id, item])) }
        for (const id of archive.drainRemoved()) vectors.items.delete(id)
        const seen = visibility(who)
        const matches = []
        for (const item of vectors.items.values()) {
            if (!sees(seen, item.sessionId)) continue
            const similarity = cosine(target, item.vector)
            if (similarity >= config.minSimilarity) matches.push({ id: item.id, similarity })
        }
        // 同一次发送的几份只占一个名次。
        const links = new Set()
        const kept = []
        for (const match of matches.sort((left, right) => right.similarity - left.similarity)) {
            if (kept.length >= limit) break
            const link = vectors.items.get(match.id)?.link
            if (link !== null && link !== undefined) {
                if (links.has(link)) continue
                links.add(link)
            }
            kept.push(match.id)
        }
        return kept
    }

    /* ------------------------------------------------------------------ 收藏 */

    async function loadFavorites() {
        const stored = await core.content.read(config.favoritesFile)
        return { hash: stored?.hash ?? null, list: stored === null ? [] : parseFavorites(stored.text) }
    }

    async function favoriteRefs() {
        return new Set((await loadFavorites()).list.map(item => item.ref).filter(ref => typeof ref === 'string'))
    }

    async function favoriteAdd(args, who) {
        const ref = args.ref === undefined || args.ref === '' ? undefined : String(args.ref)
        const quote = String(args.quote ?? '').trim()
        const why = String(args.why ?? '').trim()
        if (ref === undefined && quote === '') throw new ExperienceError('INVALID_ARGUMENT', '要给 ref（一条经历的编号）或 quote（一句原话），也可以两样都给')
        let excerpt
        if (ref !== undefined) {
            const row = archive.get(ref)
            if (row === undefined || !sees(visibility(who), row.session_id)) throw new ExperienceError('REFERENCE_ERROR', `没有 ${ref} 这条经历`)
            excerpt = excerptOf(row.text)
        }
        const { hash, list } = await loadFavorites()
        const already = ref === undefined ? undefined : list.find(item => item.ref === ref)
        if (already !== undefined) throw new ExperienceError('INVALID_ARGUMENT', `这条已经收藏过了（${already.id}）`)
        const item = { id: `fav-${ulid()}`, at: Date.now(), ...ref === undefined ? {} : { ref, excerpt }, ...quote === '' ? {} : { quote }, ...why === '' ? {} : { why } }
        const written = await core.content.write([{ path: config.favoritesFile, text: formatFavorites([...list, item]), baseHash: hash }],
            { message: `收藏：${quote || excerpt}`.slice(0, 80), by: who })
        return { id: item.id, commit: written.commit ?? null }
    }

    async function favoriteRemove(args, who) {
        const { hash, list } = await loadFavorites()
        const target = list.find(item => (args.id !== undefined && item.id === String(args.id)) || (args.ref !== undefined && item.ref === String(args.ref)))
        if (target === undefined) throw new ExperienceError('REFERENCE_ERROR', '没有这条收藏（按 id 或 ref 找）')
        const written = await core.content.write([{ path: config.favoritesFile, text: formatFavorites(list.filter(item => item !== target)), baseHash: hash }],
            { message: `取消收藏：${target.quote ?? target.excerpt ?? target.id}`.slice(0, 80), by: who })
        return { id: target.id, removed: true, commit: written.commit ?? null }
    }

    async function favoriteList(args) {
        const needle = String(args.query ?? '').trim().toLowerCase()
        const list = (await loadFavorites()).list
            .filter(item => needle === '' || [item.quote, item.excerpt, item.why].some(text => String(text ?? '').toLowerCase().includes(needle)))
            .sort((left, right) => right.at - left.at)
        const limit = clamp(args.limit, 1, 100, 30)
        return {
            total: list.length,
            items: list.slice(0, limit).map(({ at, ...item }) => ({ ...item, ...timeFields(at, core.timezone) })),
        }
    }

    /* ------------------------------------------------------------------ 使用统计 */

    /** 调用方记在哪个角色下；体检、程序自己调的不记（`null`）。没定角色的会话按工作会话算。 */
    const usageRole = who => (who?.probe === true ? null : who?.kind === 'external' ? 'external' : who?.kind === 'session' ? (who.role ?? 'worker') : null)

    /** 这几条被搜到（`shown`）或被打开（`opened`）一次。记不下来不影响工具本身，报一次。 */
    function noteUsage(who, source, refs, kind) {
        const role = usageRole(who)
        const list = (refs ?? []).filter(ref => ref !== undefined && ref !== null && ref !== '')
        if (role === null || list.length === 0) return
        try {
            archive.noteUsage(source, list, kind, role)
        } catch (error) {
            reportOnce('experience/usage-failed', String(error?.message ?? error), { text: `使用统计没记下（${error?.message ?? error}）` })
        }
    }

    /** 各来源条目的标题，列统计时一起给（不用再逐条去读）。 */
    async function titlesOf(source) {
        const service = source === 'memory' ? ctx.get('memory') : source === 'notes' ? ctx.get('notes') : undefined
        if (typeof service?.indexRows !== 'function') return new Map()
        return new Map((await service.indexRows()).map(row => [row.ref, row.title]))
    }

    async function usageReport(args) {
        const sources = args.source === undefined ? USAGE_SOURCES : [String(args.source)]
        if (sources.some(source => !USAGE_SOURCES.includes(source))) throw new ExperienceError('INVALID_ARGUMENT', `source 只能是 ${USAGE_SOURCES.join('、')}`)
        const roles = Array.isArray(args.roles) && args.roles.length > 0 ? (args.roles.includes('all') ? null : args.roles.map(String)) : [...DEFAULT_USAGE_ROLES]
        const order = args.order ?? 'most'
        if (!['most', 'least_recent', 'never'].includes(order)) throw new ExperienceError('INVALID_ARGUMENT', 'order 只能是 most、least_recent 或 never')
        const limit = clamp(args.limit, 1, 100, 20)
        const since = archive.usageSince()
        const head = {
            since: since === null ? null : clockText(since, core.timezone),
            roles: roles ?? 'all',
            note: '文档被打开记不到（文档是用 Read 读的，不经过这里的工具），只有被搜到的次数。',
        }
        if (order === 'never') {
            if (sources.length !== 1 || !['memory', 'notes'].includes(sources[0])) throw new ExperienceError('INVALID_ARGUMENT', 'order "never" 只能配 source "memory" 或 "notes"（别的来源条目太多，列不全）')
            const titles = await titlesOf(sources[0])
            const used = archive.usedRefs(sources[0], roles)
            const never = [...titles.entries()].filter(([ref]) => !used.has(ref))
            return { ...head, total: never.length, items: never.slice(0, limit).map(([ref, title]) => ({ source: sources[0], ref, title })) }
        }
        const refs = Array.isArray(args.refs) ? args.refs.map(String) : null
        const rows = archive.usage({ sources, roles, refs, order, limit })
        const titles = new Map()
        for (const source of new Set(rows.map(row => row.source))) titles.set(source, await titlesOf(source))
        const when = (field, at) => (at === null || at === undefined ? {} : { [field]: clockText(at, core.timezone), [`${field}Ago`]: agoText(at) })
        return {
            ...head,
            items: rows.map(row => {
                const title = titles.get(row.source)?.get(row.ref) ?? (row.source === 'experience' ? excerptOf(archive.get(row.ref)?.text ?? '').slice(0, 40) : undefined)
                return { source: row.source, ref: row.ref, ...title ? { title } : {}, shown: row.shown, opened: row.opened, ...when('lastShown', row.last_shown), ...when('lastOpened', row.last_opened) }
            }),
        }
    }

    ctx.provide(SERVICE, {
        registerSource, search, read, thread, rebuild, refresh: pullAll, stats: () => archive.stats(), sample, digest, parsers,
        noteUsage, favoriteRefs,
        /** 语义索引的进度（按给定模型）：还没算向量的条数、能算的总数、补算最近一次失败的原因（没失败是 `null`）。 */
        vectorState: model => ({ unindexed: archive.staleCount(model), embeddable: archive.stats().embeddable, backfillError }),
        // 给检索底座：它按游标接新的，按指纹对账。
        indexPage: (after, limit) => archive.indexPage(after, limit),
        opsPage: (after, limit) => archive.opsPage(after, limit),
        indexKeys: () => ({ entries: archive.indexKeys(), ops: archive.opsKeys() }),
        entryForIndex: id => archive.indexEntry(id),
        opForIndex: id => archive.indexOp(id),
        visibleThreads: (who) => {
            const seen = visibility(who)
            return seen.all === true ? null : [...seen.threads]
        },
        nearest,
    })

    /* ------------------------------------------------------------------ 工具 */

    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
    const tool = ({ execute, ...definition }, meta = {}) => core.tool(defineTool({
        ...definition,
        output,
        execute: async (args, exec) => JSON.stringify(await execute(args ?? {}, core.caller(exec)), null, 1),
    }), { effect: 'read', ...meta })

    tool({
        name: 'assistant_history_search',
        description: 'Search the experience archive: the DSH sessions this session may see, plus whatever other sources plugins have registered, kept as one ordered timeline per session. An entry is one input, one reply, one message sent to another session or to the phone, or a marker (compaction, handoff, restart, model change). Keyword and semantic matches are merged; each hit comes with the entries just before and after it in the same session. Use the ref with assistant_history_read to read on in order, or with assistant_history_thread to follow a cross-session exchange.',
        parameters: {
            query: { type: 'string', required: true, description: 'What to look for: words, or a description of what was said.' },
            source: { type: 'string', description: '"dsh", or the category of another registered source, to search only that source.' },
            sessionId: { type: 'string', description: 'Search only one session.' },
            role: { type: 'string', description: 'Only one role: user, assistant, peer (received from another session), out (sent to another session or the phone), system.' },
            since: { type: 'string', description: 'Only entries at or after this date/time, e.g. "2026-10-29".' },
            until: { type: 'string', description: 'Only entries before this date/time.' },
            context: { type: 'integer', description: 'Entries before and after each hit, 0-5, default 2.' },
            limit: { type: 'integer', description: '1-30, default 10.' },
            favorites: { type: 'boolean', description: 'Only entries marked as favorites (assistant_favorite).' },
        },
        execute: async (args, who) => {
            const found = await search(args, who)
            noteUsage(who, 'experience', found.items.map(item => item.ref), 'shown')
            return found
        },
    })
    tool({
        name: 'assistant_history_read',
        description: 'Read one session of the experience archive in its original order. Start from an entry (ref), from a time (sessionId + at), from the latest marker (sessionId + marker: handoff, compaction, restart, model or any), or give only sessionId to read the latest entries. Replies list the operations done before them (tool name and key parameters only). previous/next are refs to continue; a long entry returns nextOffset, read on with ref + offset.',
        parameters: {
            ref: { type: 'string', description: 'Start at this entry (from search, thread, previous or next).' },
            sessionId: { type: 'string', description: 'Session to read when there is no ref.' },
            at: { type: 'string', description: 'With sessionId: start at this date/time.' },
            marker: { type: 'string', description: 'With sessionId: start at the latest marker of this kind (handoff, compaction, restart, model, any).' },
            direction: { type: 'string', description: '"forward" (default) or "backward" from the start point.' },
            limit: { type: 'integer', description: 'Entries, 1-100, default 20.' },
            offset: { type: 'integer', description: 'Character offset into the first entry, for a long entry.' },
            maxCharacters: { type: 'integer', description: 'Total text budget, 1-32000, default 12000.' },
        },
        execute: async (args, who) => {
            const result = await read(args, who)
            if (args.ref !== undefined) noteUsage(who, 'experience', [String(args.ref)], 'opened')
            return result
        },
    })
    tool({
        name: 'assistant_history_thread',
        description: 'Follow one matter across sessions: from an entry, take its segment (from the input that started it to the next input), follow the link ids in it (message ids between sessions, development-session message ids, task ids) to the matching entries in other sessions, and return all of them in time order with where each happened. Sessions this session may not see are skipped and only counted.',
        parameters: {
            ref: { type: 'string', required: true, description: 'Entry to start from.' },
            maxSegments: { type: 'integer', description: 'Segments to follow, 1-30, default 12.' },
            maxCharacters: { type: 'integer', description: 'Total text budget, 1-32000, default 12000.' },
        },
        execute: (args, who) => thread(args, who),
    })

    const readsUsage = who => who?.kind === 'external' || (who?.kind === 'session' && ['hub', 'background', 'tidy'].includes(who.role))
    tool({
        name: 'assistant_usage',
        description: 'Usage statistics: how often each memory, note, document section or experience entry was returned by a search (shown) and opened by a read tool (opened), with the last times. By default only the hub and project sessions count; background reflection and handoff tidying search widely and would make everything look active. Use it to see what is really used and what has gone untouched.',
        parameters: {
            source: { type: 'string', description: '"memory", "notes", "documents" or "experience". Default all.' },
            order: { type: 'string', description: '"most" (default): most used first; "least_recent": longest unused first; "never": never used (memory or notes only).' },
            roles: { type: 'array', items: { type: 'string' }, description: 'Callers to count: hub, worker (project sessions), background, tidy, external. Default hub and worker; ["all"] for every caller.' },
            refs: { type: 'array', items: { type: 'string' }, description: 'Only these entries.' },
            limit: { type: 'integer', description: '1-100, default 20.' },
        },
        execute: args => usageReport(args),
    }, { allow: readsUsage })
    tool({
        name: 'assistant_favorite',
        description: 'Mark as a favorite something worth cherishing: one experience entry by ref, or a sentence (quote), optionally with why. Favorites are your own choice, not channel quote replies. action "remove" takes the id (or the ref). Background reflection looks at favorites first when it maintains "between us".',
        parameters: {
            action: { type: 'string', required: true, description: '"add" or "remove".' },
            ref: { type: 'string', description: 'Experience entry ref (add, or remove by ref).' },
            quote: { type: 'string', description: 'A sentence to keep (add).' },
            why: { type: 'string', description: 'Why it matters (add).' },
            id: { type: 'string', description: 'Favorite id (remove).' },
        },
        execute: (args, who) => {
            if (args.action === 'add') return favoriteAdd(args, who)
            if (args.action === 'remove') return favoriteRemove(args, who)
            throw new ExperienceError('INVALID_ARGUMENT', 'action 只能是 add 或 remove')
        },
    }, { effect: 'write', allow: who => who?.kind === 'session' && who.role === 'hub' })
    tool({
        name: 'assistant_favorite_list',
        description: 'List favorites, newest first, optionally only those whose quote, excerpt or reason contains query. To search the archive among favorites only, use assistant_history_search or assistant_search with favorites: true.',
        parameters: {
            query: { type: 'string', description: 'Only favorites containing this text.' },
            limit: { type: 'integer', description: '1-100, default 30.' },
        },
        execute: args => favoriteList(args),
    }, { allow: readsUsage })
}
