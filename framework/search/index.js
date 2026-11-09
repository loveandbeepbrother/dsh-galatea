/**
 * 检索底座：一张派生索引，一个入口 `assistant_search`。提供服务 `search`。
 *
 * - **索引**是 `search.sqlite`（见 `store.js`）：能重建，删了不丢东西。写都在 worker 里（`worker.js`），查询在主线程。
 * - **来源**：经历（用户的话、回复、发往别处和转来的，系统条目不收）、工具轨迹（只给主动搜索）、记忆、便签、文档（配置的白名单）。
 *   经历按游标接新的；记忆和便签写入后经 `touch` 重扫；每隔 `scanMinutes` 按指纹全部对账一次，手改、git 回退、重算过的条目都接得上。
 * - **查询**：关键词（bigram，OR 加 BM25）和向量（经历、记忆、文档）两路按名次合并，向量挂了退回关键词。
 *   结果按来源分组，每个来源限条数，小说块挤不掉决定文档。可见范围在 SQL 里过滤。读原文仍走各自的工具，结果写明用什么读。
 *   同一次发送在发送方和接收方各有一份（`link` 相同）：折叠成一条，写明别处还有几份，前几名不会被副本占满。
 * - **查询向量**只算一次，有时限；连续失败熔断一阵，这期间只用关键词，结果写明。
 *
 * @module @loveandbeepbrother/dsh-galatea/search
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Worker } from 'node:worker_threads'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { clockSecondsText, timeFields } from '../core/time.js'
import { cosine } from '../embedder/index.js'
import { openStore } from './store.js'
import { DEFAULT_HINT, DEFAULT_WORDS, createGate, createSearchFirst, createStats, parseWords } from './first.js'
import { matchAny, queryTerms, stripSecrets, tokenize } from './tokens.js'

export const name = 'mind-framework-search'
export const inject = ['core']
export const SERVICE = 'search'

/** 查询最多用这么多个词。查询跑在 Host 主线程：全部词时最长的消息要近一秒，取前 256 个结果几乎不变，约四分之一秒。 */
const MAX_TERMS = 256
/** 名次合并的常数，和经历检索一样。 */
const FUSION_K = 60
/** 每一路取每个来源要显示条数的几倍来合并。 */
const OVERFETCH = 3
const SYNCED_CURSOR = 'synced'
const PAGE = 500
const SNIPPET_CHARS = 160
const VECTOR_BATCH = 50
/** 查询向量连续失败几次开始熔断、熔断多久。 */
const BREAKER_FAILURES = 2
const BREAKER_MS = 60_000

const LABELS = Object.freeze({ experience: '经历', operations: '工具轨迹', memory: '记忆', notes: '便签', documents: '文档' })
const SOURCES = Object.keys(LABELS)

export const Config = Schema.object({
    file: Schema.string().default('').description('索引文件；空为 DSH home 下的 galatea/search.sqlite'),
    documents: Schema.array(Schema.object({
        path: Schema.string().required().description('目录或文件'),
        label: Schema.string().required().description('结果里怎么称呼'),
        scope: Schema.union(['hub', 'shared', 'project']).default('hub').description('谁看得到：hub 中枢和后台思考；shared 所有会话；project 工作目录在这里面的会话和中枢'),
        vectors: Schema.boolean().default(false).description('算向量（全文会发给向量接口）'),
    })).default([]).description('进索引的文档目录（.md、.txt，按标题切块）'),
    exclude: Schema.array(Schema.string()).default([]).description('路径匹配这些正则的不进索引'),
    perSource: Schema.natural().default(5).description('每个来源最多给几条'),
    scanMinutes: Schema.natural().default(60).description('多久全部对账一次（文档、记忆、便签、经历）'),
    tailSeconds: Schema.natural().default(60).description('多久接一次新的经历'),
    embedTimeoutMs: Schema.natural().default(5_000).description('查询向量最多等多久'),
    searchFirst: Schema.object({
        enabled: Schema.boolean().default(true).description('中枢的一轮里有该查的输入时，附一段提示要它先用 assistant_search 查再答（见 first.js；现在经 Agent SDK 执行方的钩子附上）'),
        wordsFile: Schema.string().default('search-first-words.md').description('问题类型词的文件（相对内容库，一行一个，# 开头是注释）；模型能改，下一轮生效。没有这个文件时用 words'),
        words: Schema.array(Schema.string()).default([...DEFAULT_WORDS]).description('默认的问题类型词（中文，来自我们自己的数据；别的语言自己配）'),
        minLength: Schema.natural().default(20).description('输入至少几个字才判'),
        noveltyMin: Schema.number().default(0.7).description('不是用户本人说的输入，新颖度的下限'),
        recentRounds: Schema.natural().default(5).description('新颖度看最近几轮'),
        remindEvery: Schema.natural().default(500).description('判够这么多轮，提醒中枢看一眼词表要不要更新；0 不提醒'),
        hint: Schema.string().default(DEFAULT_HINT).description('附上的提示'),
    }).default({}).description('先搜再答（门控版）'),
})

const sha = text => createHash('sha256').update(String(text), 'utf8').digest('hex')

/** 第一处命中词前后的一段；没命中就从头取。 */
export function snippetOf(text, terms) {
    const source = Array.from(String(text ?? ''))
    const lower = source.join('').toLowerCase()
    const hits = terms.map(term => lower.indexOf(term)).filter(index => index >= 0)
    const at = hits.length === 0 ? 0 : Array.from(lower.slice(0, Math.min(...hits))).length
    const start = Math.max(0, at - 30)
    const piece = source.slice(start, start + SNIPPET_CHARS).join('').replace(/\s+/g, ' ').trim()
    return `${start > 0 ? '…' : ''}${piece}${start + SNIPPET_CHARS < source.length ? '…' : ''}`
}

/** 按名次合并几路：`lists` 是 `[{ refs: [...] , how }]`，交回 `[{ ref, score, how: [...] }]`，分高的在前。 */
export function fuse(lists) {
    const merged = new Map()
    for (const { refs, how } of lists) {
        refs.forEach((ref, rank) => {
            const item = merged.get(ref) ?? { ref, score: 0, how: [] }
            item.score += 1 / (FUSION_K + rank)
            if (!item.how.includes(how)) item.how.push(how)
            merged.set(ref, item)
        })
    }
    return [...merged.values()].sort((left, right) => right.score - left.score)
}

/**
 * 同一次发送的几份副本（`link` 相同）折叠成排在最前的那一条：关键词一路在索引里已经只有一份，这里接住向量一路交来的另一份，
 * 算作同一条命中了两路。索引里已经没有的不要。
 * @param itemOf - 引用 → 索引行。
 */
export function collapseCopies(merged, itemOf) {
    const kept = []
    const byLink = new Map()
    for (const item of merged) {
        const row = itemOf(item.ref)
        if (row === undefined) continue
        const first = row.link === null ? undefined : byLink.get(row.link)
        if (first !== undefined) {
            const added = item.how.filter(how => !first.how.includes(how))
            if (added.length > 0) {
                first.how = [...first.how, ...added]
                first.score += item.score
            }
            continue
        }
        const entry = { ...item, row }
        kept.push(entry)
        if (row.link !== null) byLink.set(row.link, entry)
    }
    return kept.sort((left, right) => right.score - left.score)
}

/** @param deps.autoStart - 测试里设 false，不开定时，手动 `syncNow`。 */
export async function apply(ctx, config, deps = {}) {
    const core = ctx.core
    const file = config.file || dshHomePath('galatea', 'search.sqlite')
    mkdirSync(dirname(file), { recursive: true })

    const reported = new Set()
    const reportOnce = (kind, key, text) => {
        if (reported.has(`${kind}:${key}`)) return
        reported.add(`${kind}:${key}`)
        core.report(kind, { text, data: { subject: key } })
    }

    /* ------------------------------------------------------------------ worker */

    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { file } })
    const waiting = new Map()
    let nextCall = 0
    let closed = false
    const ready = new Promise((resolve, reject) => {
        worker.once('error', reject)
        worker.on('message', (message) => {
            if (message.ready === true) return resolve()
            const pending = waiting.get(message.id)
            if (pending === undefined) return
            waiting.delete(message.id)
            if (message.error !== undefined) pending.reject(new Error(message.error))
            else pending.resolve(message.result)
        })
    })
    worker.on('error', (error) => {
        for (const pending of waiting.values()) pending.reject(error)
        waiting.clear()
        core.report('search/worker-failed', { text: `检索的写入进程出错（${error?.message ?? error}），索引不再更新` })
    })
    const call = (op, args) => new Promise((resolve, reject) => {
        nextCall += 1
        waiting.set(nextCall, { resolve, reject })
        worker.postMessage({ id: nextCall, op, args })
    })
    await ready
    const store = openStore(file, { readOnly: true })
    ctx.effect(() => () => {
        closed = true
        store.close()
        worker.terminate()
    }, 'mind-framework-search: store')

    /* ------------------------------------------------------------------ 同步 */

    let queue = Promise.resolve()
    const serial = (job) => {
        const next = queue.catch(() => {}).then(() => (closed ? undefined : job()))
        queue = next.catch(() => {})
        return next
    }
    /** 记忆和便签的最新内容，片段从这里取。 */
    const held = { memory: new Map(), notes: new Map() }
    // 记在索引里：重启以后索引还在，不算“还在第一次建”。
    let everSynced = store.cursor(SYNCED_CURSOR) > 0
    /** 最近一次对账，每个来源：`{ expected, indexed, stale, removed }`。 */
    const lastSync = {}

    /** 按来源核对条数：索引和源对不上就报，分开数才看得出串了来源。 */
    function checkCount(source, expected, { stale, removed }) {
        const indexed = store.countOf(source)
        lastSync[source] = { expected, indexed, stale, removed }
        if (indexed !== expected) reportOnce('search/count-mismatch', `${source}:${expected}:${indexed}`, `检索索引的${LABELS[source]}条数和源对不上（源 ${expected}，索引 ${indexed}）`)
    }

    async function syncRows(source, service) {
        if (typeof service?.indexRows !== 'function') return
        const rows = await service.indexRows()
        held[source] = new Map(rows.map(row => [row.ref, row]))
        const { stale, removed } = await call('reconcile', { source, keep: rows.map(row => ({ ref: row.ref, hash: row.hash })) })
        if (stale.length > 0) await call('apply', { upserts: stale.map(ref => ({ source, ...held[source].get(ref) })) })
        checkCount(source, rows.length, { stale: stale.length, removed })
    }

    // 指纹带上关联：推断的关联可能后来才补上，要能对账对出来。
    const entryHash = row => `${row.hash}:${row.link ?? ''}`
    const entryItem = row => ({
        source: 'experience',
        ref: row.id,
        scope: `thread:${row.session_id}`,
        thread: row.session_id,
        role: row.role,
        category: row.source,
        link: row.link ?? null,
        at: row.at,
        hash: entryHash(row),
        text: row.text,
    })
    const opItem = row => ({
        source: 'operations',
        ref: row.id,
        scope: `thread:${row.session_id}`,
        thread: row.session_id,
        at: row.at,
        title: row.tool,
        hash: sha(`${row.tool}\n${row.detail ?? ''}`),
        text: `${row.tool}\n${row.detail ?? ''}`,
    })

    /** 写一批；写的时候换掉了一组副本的代表，其余几份重新交（全文表不存原文）。 */
    async function write(upserts, rowOf, toItem) {
        let batch = upserts
        while (batch.length > 0) {
            const { orphans } = await call('apply', { upserts: batch })
            batch = orphans.map(rowOf).filter(row => row !== undefined).map(toItem)
        }
    }

    /** 接新的：游标按经历库的 rowid 走。 */
    async function tail(experience) {
        if (typeof experience?.indexPage !== 'function') return
        for (const [key, page, toItem, rowOf] of [['entries', experience.indexPage, entryItem, experience.entryForIndex], ['ops', experience.opsPage, opItem, experience.opForIndex]]) {
            let cursor = await call('cursor', { key })
            while (!closed) {
                const rows = page(cursor, PAGE)
                if (rows.length === 0) break
                await write(rows.map(toItem), rowOf, toItem)
                cursor = rows.at(-1).rowid
                await call('setCursor', { key, value: cursor })
                // 让出一拍：第一次要接几万条。
                await new Promise(resolve => setImmediate(resolve))
            }
        }
    }

    /** 对账经历：重算过的条目、删掉的条目，游标看不到。 */
    async function reconcileExperience(experience) {
        if (typeof experience?.indexKeys !== 'function') return
        const { entries, ops } = experience.indexKeys()
        const fix = async (source, keep, rowOf, toItem) => {
            const { stale, removed } = await call('reconcile', { source, keep })
            await write(stale.map(rowOf).filter(row => row !== undefined).map(toItem), rowOf, toItem)
            checkCount(source, keep.length, { stale: stale.length, removed })
        }
        await fix('experience', entries.map(row => ({ ref: row.ref, hash: entryHash(row) })), experience.entryForIndex, entryItem)
        await fix('operations', ops.map(({ ref, tool, detail }) => ({ ref, hash: sha(`${tool}\n${detail ?? ''}`) })), experience.opForIndex, opItem)
    }

    const documentEntries = () => config.documents.map(entry => ({
        path: entry.path,
        label: entry.label,
        vectors: entry.vectors === true,
        scopeKey: entry.scope === 'project' ? `doc:project:${entry.path}` : `doc:${entry.scope ?? 'hub'}`,
    }))

    /** 文档向量在内存里的一份，换了才重读。 */
    let docVectors = { model: null, items: [] }
    let docVectorError = null
    const modelOf = embedder => `${embedder.model}@${embedder.dimensions}`
    function loadDocVectors(model) {
        docVectors = { model, items: store.loadVectors(model) }
    }

    async function embedDocuments() {
        const embedder = ctx.get('embedder')
        if (embedder === undefined || config.documents.every(entry => entry.vectors !== true)) return
        const model = modelOf(embedder)
        try {
            while (!closed) {
                const missing = await call('missingVectorTexts', { model, limit: VECTOR_BATCH })
                if (missing.length === 0) break
                const vectors = await embedder.embed(missing.map(item => item.text))
                await call('putVectors', { model, vectors: missing.map((item, index) => ({ hash: item.hash, vector: vectors[index] })) })
            }
            if (docVectorError !== null) reported.delete(`search/document-vectors-failed:${docVectorError}`)
            docVectorError = null
        } catch (error) {
            docVectorError = String(error?.message ?? error)
            reportOnce('search/document-vectors-failed', docVectorError, `文档算向量失败（${docVectorError}），语义检索暂时查不到文档，下次对账再试`)
        }
        loadDocVectors(model)
    }

    async function syncAll() {
        await syncRows('memory', ctx.get('memory'))
        await syncRows('notes', ctx.get('notes'))
        const experience = ctx.get('experience')
        await tail(experience)
        await reconcileExperience(experience)
        if (config.documents.length > 0) await call('scanDocuments', { entries: documentEntries(), exclude: config.exclude })
        everSynced = true
        await call('setCursor', { key: SYNCED_CURSOR, value: Date.now() })
        await embedDocuments()
    }
    const syncing = job => serial(job).catch((error) => {
        reportOnce('search/sync-failed', String(error?.message ?? error), `检索索引同步出错（${error?.message ?? error}）`)
    })

    if (deps.autoStart !== false) {
        const first = setTimeout(() => syncing(syncAll), 20_000)
        first.unref?.()
        const tailer = setInterval(() => syncing(() => tail(ctx.get('experience'))), config.tailSeconds * 1000)
        tailer.unref?.()
        const scanner = setInterval(() => syncing(syncAll), config.scanMinutes * 60_000)
        scanner.unref?.()
        ctx.effect(() => () => {
            clearTimeout(first)
            clearInterval(tailer)
            clearInterval(scanner)
        }, 'mind-framework-search: timers')
    }

    /* ------------------------------------------------------------------ 查询向量 */

    const breaker = { failures: 0, until: 0 }
    const vectorCache = new Map()
    /**
     * 查询向量：同一句只算一次；有时限；连续失败熔断。
     * @returns `{ model, vector }` 或 `{ failed: 原因 }` 或 `{ none: true }`。
     */
    async function queryVector(text, { timeoutMs = config.embedTimeoutMs } = {}) {
        const embedder = ctx.get('embedder')
        if (embedder === undefined) return { none: true }
        const model = modelOf(embedder)
        const key = `${model}\u0000${text}`
        if (vectorCache.has(key)) return { model, vector: vectorCache.get(key) }
        if (Date.now() < breaker.until) return { failed: '向量接口连续失败，暂时不试' }
        const attempt = embedder.embed([text]).then(([vector]) => {
            breaker.failures = 0
            vectorCache.set(key, vector)
            if (vectorCache.size > 64) vectorCache.delete(vectorCache.keys().next().value)
            return { model, vector }
        }).catch((error) => {
            breaker.failures += 1
            if (breaker.failures >= BREAKER_FAILURES) {
                breaker.until = Date.now() + BREAKER_MS
                breaker.failures = 0
            }
            return { failed: String(error?.message ?? error) }
        })
        let timer
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ failed: `向量接口 ${timeoutMs} ms 没回` }), timeoutMs)
            timer.unref?.()
        })
        const result = await Promise.race([attempt, timeout])
        clearTimeout(timer)
        return result
    }

    /* ------------------------------------------------------------------ 可见范围 */

    /** 这个调用方在各来源看得到的范围：`null` 是全部，否则是范围列表。 */
    async function scopesFor(who) {
        const seesAll = who?.kind === 'external' || (who?.kind === 'session' && ['hub', 'background', 'tidy'].includes(who.role))
        const threads = ctx.get('experience')?.visibleThreads?.(who)
        const threadScopes = threads === undefined || threads === null ? (seesAll ? null : []) : threads.map(thread => `thread:${thread}`)
        const projectDirectory = who?.kind === 'session' ? core.sessions.projectOf(who.sessionId)?.path : undefined
        const inside = entry => projectDirectory !== undefined && String(entry.path).toLowerCase().startsWith(String(projectDirectory).toLowerCase())
        const documents = seesAll ? null : ['doc:shared', ...config.documents.filter(entry => entry.scope === 'project' && inside(entry)).map(entry => `doc:project:${entry.path}`)]
        return {
            experience: threadScopes,
            operations: threadScopes,
            memory: await ctx.get('memory')?.scopesFor?.(who) ?? (seesAll ? null : []),
            notes: ctx.get('notes')?.scopesFor?.(who) ?? (seesAll ? null : []),
            documents,
        }
    }

    /* ------------------------------------------------------------------ 查询 */

    /** 一路关键词：OR 加 BM25。 */
    function keywordLists(terms, base) {
        if (terms.length === 0) return []
        return [{ how: 'keyword', refs: store.query({ ...base, match: matchAny(terms) }).map(row => row.ref) }]
    }

    function documentNearest(vector, scopes, limit) {
        const scored = []
        for (const { hash, vector: other } of docVectors.items) {
            const similarity = cosine(vector, other)
            scored.push({ hash, similarity })
        }
        scored.sort((left, right) => right.similarity - left.similarity)
        const refs = []
        for (const { hash } of scored) {
            for (const item of store.itemsWithHash(hash)) {
                if (scopes === null || scopes.includes(item.scope)) refs.push(item.ref)
            }
            if (refs.length >= limit) break
        }
        return refs.slice(0, limit)
    }

    /** 这一条的片段和怎么读原文。 */
    async function describe(source, row, terms) {
        // 时间按核心的时区写、带偏移，另给离现在多久（`at`、`ago`）。
        const base = { ref: row.ref, ...row.at > 0 ? timeFields(row.at, core.timezone) : {} }
        if (source === 'experience') {
            const entry = ctx.get('experience')?.entryForIndex?.(row.ref)
            return { ...base, who: entry?.role, thread: row.thread, ...row.link ? { link: row.link } : {}, snippet: snippetOf(entry?.text, terms), read: { tool: 'assistant_history_read', ref: row.ref } }
        }
        if (source === 'operations') {
            const op = ctx.get('experience')?.opForIndex?.(row.ref)
            return { ...base, title: row.title, thread: row.thread, snippet: snippetOf(stripSecrets(op?.detail), terms), read: { tool: 'assistant_history_read', sessionId: row.thread, at: clockSecondsText(row.at, core.timezone) } }
        }
        if (source === 'memory') {
            const memory = held.memory.get(row.ref)
            return { ...base, title: memory?.title, snippet: snippetOf(memory?.summary ?? memory?.text, terms), read: { tool: 'assistant_memory_read', id: row.ref } }
        }
        if (source === 'notes') {
            const note = held.notes.get(row.ref)
            return { ...base, title: note?.title, ...note?.times ?? {}, snippet: snippetOf(note?.text, terms), read: { tool: 'assistant_notes_read', book: note?.book, noteId: note?.noteId, fileHash: note?.fileHash } }
        }
        const at = row.location.lastIndexOf(':')
        const path = row.location.slice(0, at)
        const line = Number(row.location.slice(at + 1))
        const text = await readFile(path, 'utf8').then(value => value.split(/\r?\n/).slice(line - 1, line + 60).join('\n')).catch(() => '')
        return { ...base, title: row.title, where: row.location, snippet: snippetOf(text, terms), read: { tool: 'Read', file: path, line } }
    }

    /**
     * 统一入口。
     * @param options.who - 调用方。
     * @param options.sources - 只查这些来源。
     * @param options.perSource - 每个来源几条。
     * @returns `{ query, groups: [{ source, label, items }], searched, note? }`。
     */
    async function search(text, { who, sources = SOURCES, perSource = config.perSource, favorites = false } = {}) {
        const query = String(text ?? '').trim()
        if (query === '') throw new Error('query 不能为空')
        // 只看收藏：收藏的是经历，别的来源不查；关键词一路在 SQL 里按编号筛，语义一路逐条筛。
        const favored = favorites ? await ctx.get('experience')?.favoriteRefs?.() ?? new Set() : null
        if (favored !== null && favored.size === 0) return { query, groups: [], searched: { keyword: true, semantic: 'ok' }, note: '还没有按编号收藏的经历' }
        const wanted = (favored === null ? sources : ['experience']).filter(source => SOURCES.includes(source))
        const terms = queryTerms(query, MAX_TERMS)
        const scopes = await scopesFor(who)
        const target = await queryVector(query)
        const searched = { keyword: true, semantic: target.vector !== undefined ? 'ok' : target.none === true ? 'none' : 'failed' }
        if (target.failed !== undefined) searched.reason = target.failed
        const pullEach = perSource * OVERFETCH

        const groups = []
        for (const source of wanted) {
            const scope = scopes[source]
            if (Array.isArray(scope) && scope.length === 0) continue
            const lists = keywordLists(terms, { sources: [source], scopes: scope, ...favored === null ? {} : { refs: [...favored] }, limit: pullEach })
            // 工具轨迹只有关键词。
            if (target.vector !== undefined) {
                if (source === 'documents') {
                    if (docVectors.model !== target.model) loadDocVectors(target.model)
                    lists.push({ how: 'semantic', refs: documentNearest(target.vector, scope, pullEach) })
                } else if (source === 'experience') {
                    const near = ctx.get('experience')?.nearest?.(target.vector, target.model, { who, limit: favored === null ? pullEach : Number.MAX_SAFE_INTEGER }) ?? []
                    lists.push({ how: 'semantic', refs: favored === null ? near : near.filter(ref => favored.has(ref)).slice(0, pullEach) })
                } else if (source === 'memory') {
                    lists.push({ how: 'semantic', refs: await ctx.get('memory')?.nearest?.(target.vector, { who, limit: pullEach }) ?? [] })
                }
            }
            const merged = collapseCopies(fuse(lists), ref => store.itemByRef(source, ref)).slice(0, perSource)
            if (merged.length === 0) continue
            const items = []
            for (const { how, row } of merged) {
                const copies = store.copiesOf(source, row.link, scope)
                items.push({ match: how.length === 2 ? 'both' : how[0], ...copies > 0 ? { copies } : {}, ...await describe(source, row, tokenize(query).concat(query.toLowerCase())) })
            }
            if (items.length > 0) groups.push({ source, label: LABELS[source], score: merged[0].score, items })
        }
        groups.sort((left, right) => right.score - left.score)
        if (docVectorError !== null) searched.documentVectors = docVectorError
        const empty = groups.length === 0
        // 降级（有一路没走全）和确实没有要分开写明：不管有没有结果，降级都写；两路都查了还是空的，写确实没有。
        const caveats = []
        if (searched.semantic !== 'ok') caveats.push(`这次只走了关键词（${searched.reason ?? '没有向量提供方'}）：意思相近、字面不同的找不到`)
        else {
            const state = wanted.includes('experience') ? ctx.get('experience')?.vectorState?.(target.model) : undefined
            if (state !== undefined && state.unindexed > 0) {
                searched.unindexed = state.unindexed
                caveats.push(state.backfillError === null
                    ? `经历的语义索引还在补算，${state.unindexed} 条暂时只能按关键词找到`
                    : `经历的语义索引补算停了，${state.unindexed} 条只能按关键词找到（${state.backfillError}）`)
            }
            if (docVectorError !== null && wanted.includes('documents')) caveats.push(`文档的语义一路出错，文档只按关键词（${docVectorError}）`)
        }
        const note = caveats.length > 0 ? `${empty ? '没搜到不代表没有：' : ''}${caveats.join('；')}`
            : empty ? '能查的都查了（没有降级），没有相关的' : undefined
        return {
            query,
            groups: groups.map(({ score, ...group }) => group),
            searched,
            ...note === undefined ? {} : { note },
            ...!everSynced ? { indexing: '索引还在第一次建，结果可能不全' } : {},
        }
    }

    /**
     * 经历检索的关键词一路（`assistant_history_search` 用，和这里同一套分词）。索引还没建好时是 `null`，调用方退回旧表。
     * @returns 条目编号，好的在前。
     */
    function experienceKeyword(text, { threads = null, refs = null, role, category, since, until, limit }) {
        if (!everSynced) return null
        const terms = queryTerms(text, MAX_TERMS)
        const base = { sources: ['experience'], threads, refs, role, category, since, until, limit }
        return collapseCopies(fuse(keywordLists(terms, base)), ref => store.itemByRef('experience', ref)).map(item => item.ref)
    }

    ctx.provide(SERVICE, {
        search,
        experienceKeyword,
        queryVector,
        /** 记忆、便签刚写过：马上重扫。 */
        touch: source => syncing(() => syncRows(source, ctx.get(source))),
        syncNow: () => serial(syncAll),
        stats: () => ({ ...Object.fromEntries(SOURCES.map(source => [source, store.countOf(source)])), lastSync }),
        /** 一段话切成的词（去重、按原文顺序，最多 `limit` 个），和查询用的同一种切法。 */
        terms: (text, limit = MAX_TERMS) => queryTerms(String(text ?? ''), limit),
        /**
         * 每个词出现在几条里、这几个来源一共几条（`{ total, counts }`，`counts` 和 `terms` 一一对应），在 worker 里算，不挡 Host。
         * 默认看经历、记忆、便签：说过的话和记下的事，不含文档和工具轨迹。
         */
        frequencies: (terms, { sources = ['experience', 'memory', 'notes'] } = {}) => call('frequencies', { terms: [...terms], sources }),
    })

    /* ------------------------------------------------------------------ 先搜再答 */

    const first = config.searchFirst
    const firstStats = createStats({ enabled: first.enabled })
    ctx.provide('searchFirst', { stats: firstStats.stats })
    let gateCache = { hash: undefined, gate: null }
    /** 现在的门控：词表文件改了就换（模型能改，下一轮生效）。 */
    async function currentGate() {
        const stored = await core.content.read(first.wordsFile).catch(() => null)
        const hash = stored?.hash ?? null
        if (gateCache.gate === null || gateCache.hash !== hash) {
            const words = stored === null ? first.words : parseWords(stored.text)
            gateCache = { hash, gate: createGate({ words, minLength: first.minLength, noveltyMin: first.noveltyMin }) }
        }
        return gateCache.gate
    }
    // 判过几轮、附过几次存在索引的游标里，重启不清零（索引重建会清零，只是提醒晚一点）。
    const JUDGED = 'searchFirst.judged'
    const TRIGGERED = 'searchFirst.triggered'
    const REMINDED = 'searchFirst.remindedJudged'
    const REMINDED_TRIGGERED = 'searchFirst.remindedTriggered'
    async function countJudged({ triggered }) {
        firstStats.record({ triggered })
        const judged = Number(store.cursor(JUDGED)) + 1
        const hits = Number(store.cursor(TRIGGERED)) + (triggered ? 1 : 0)
        await call('setCursor', { key: JUDGED, value: judged })
        if (triggered) await call('setCursor', { key: TRIGGERED, value: hits })
        const since = Number(store.cursor(REMINDED))
        if (first.remindEvery === 0 || judged - since < first.remindEvery) return
        const sinceHits = Number(store.cursor(REMINDED_TRIGGERED))
        await call('setCursor', { key: REMINDED, value: judged })
        await call('setCursor', { key: REMINDED_TRIGGERED, value: hits })
        const hub = core.sessions.hub()
        if (hub === undefined || hub === null) return
        const rounds = judged - since
        const shown = hits - sinceHits
        await core.attach(hub, 'search-first-words', `（DSH 提示，不是用户发言）先搜再答自上次提醒以来判了 ${rounds} 轮，附了 ${shown} 次提示（${Math.round(shown / rounds * 100)}%）。`
            + `看一眼词表 ${first.wordsFile}（内容库里；没有这个文件时用的是配置里的默认词表，要改就照它建一份）要不要更新：常被问到、却没触发的说法加进去，触发了却多半用不上的去掉。改完下一轮生效；不改也行。`)
    }
    if (first.enabled) {
        ctx.inject(['agentSdk'], (sub) => {
            sub.effect(() => sub.agentSdk.addHooks((sessionId) => {
                const searchFirst = createSearchFirst({
                    isHub: () => core.sessions.hub() === sessionId,
                    readEvents: () => core.readEvents(sessionId),
                    original: message => core.provenance.original(message),
                    gate: currentGate,
                    terms: (text, limit = MAX_TERMS) => queryTerms(String(text ?? ''), limit),
                    frequencies: async (terms) => {
                        if (!everSynced) throw new Error('检索索引还在第一次建')
                        return call('frequencies', { terms: [...terms], sources: ['experience', 'memory', 'notes'] })
                    },
                    hint: first.hint,
                    rounds: first.recentRounds,
                    report: text => reportOnce('search-first/novelty-unavailable', sessionId, text),
                    onJudged: result => countJudged(result).catch(error => reportOnce('search-first/count-failed', String(error?.message ?? error), `先搜再答的计数没记下（${error?.message ?? error}）`)),
                })
                return {
                    UserPromptSubmit: [{
                        hooks: [async (input) => {
                            // 子代理里、Claude Code 自己开的一轮（后台任务的结果）不判。
                            if (input?.agent_id !== undefined || input?.source === 'system') return {}
                            try {
                                const hint = await searchFirst(input?.prompt)
                                return hint === undefined ? {} : { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: hint } }
                            } catch (error) {
                                reportOnce('search-first/failed', String(error?.message ?? error), `先搜再答的判定出错，这一轮没附提示（${error?.message ?? error}）`)
                                return {}
                            }
                        }],
                    }],
                }
            }), 'mind-framework-search: search-first hooks')
        })
    }

    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
    ctx.effect(() => core.tool(defineTool({
        name: 'assistant_search',
        description: 'Search everything at once: what was said (experience), memories, notes, documents and past tool calls, by keywords and meaning. Use it first when the answer may already exist, without having to decide which layer it is in. Results are grouped by source, each item says which tool reads the original. "searched" says what was covered: when semantic is not ok, finding nothing does not mean there is nothing.',
        parameters: {
            query: { type: 'string', required: true, description: 'Words, or a description of what you are looking for.' },
            sources: { type: 'array', items: { type: 'string' }, description: `Only these: ${SOURCES.join(', ')}. Default all.` },
            perSource: { type: 'integer', description: `Items per source, 1-20, default ${config.perSource}.` },
            favorites: { type: 'boolean', description: 'Only experience entries marked as favorites (assistant_favorite).' },
        },
        output,
        execute: async (args, exec) => {
            const who = core.caller(exec)
            const found = await search(args?.query, {
                who,
                ...Array.isArray(args?.sources) ? { sources: args.sources } : {},
                ...Number.isFinite(args?.perSource) ? { perSource: Math.min(Math.max(Math.trunc(args.perSource), 1), 20) } : {},
                favorites: args?.favorites === true,
            })
            // 使用统计：出现在结果里的算被搜到一次（按调用方分开记，体检不记）。
            for (const group of found.groups) ctx.get('experience')?.noteUsage?.(who, group.source, group.items.map(item => item.ref), 'shown')
            return JSON.stringify(found, null, 1)
        },
    }), { effect: 'read', alwaysLoad: true }), 'mind-framework-search: tool')
}
