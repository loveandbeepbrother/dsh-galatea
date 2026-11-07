/**
 * 记忆模块：具体记忆和便签。提供服务 `memory`、`notes`，上下文段 `memory-index`，七个工具。
 *
 * - 便签：一个文件（路径是配置），格式照旧，读和写用 `notes.js` 的同一套解析；不进上下文。谁都能写（外部调用方只读时除外）。
 *
 * - 一条一个文件，在核心内容库的 `memories/` 下（目录是配置），格式和旧的 mind-writes 相同；编号 `mem-<ULID>`。
 *   写入、删除经 `core.content.write`（留痕、用户手改的提交由内容库做）。
 * - 范围照旧写成 `scope: global` 或 `scope: workspace:<项目编号>`，另有 `project:` 存项目标题；
 *   会话属于哪个项目问 `core.sessions.projectOf`。
 * - **谁能写、能查什么**（默认配置）：
 *   中枢写全局和任何项目的，后台思考、外部调用方写全局的，工作会话写自己项目的；没定角色的按工作会话算。
 *   中枢、后台思考、外部调用方查全部（外部调用方按它绑定的中枢算），工作会话查全局加本项目。
 * - **来源**必须有：不传时写调用方。
 * - **检索**：语义加 0.3 倍关键词命中率；没有向量提供方或者调用失败时只按关键词并写明。向量存在本模块的存储域，
 *   按"模型@维度"区分，换了就重算；删记忆时连向量一起删，载入时清掉对不上文件的。
 * - **记忆目录段**：全局的加上这个会话所在项目的，按更新时间倒序，截到上限。变更说明按编号比，
 *   区分新增或修改、删掉了、被挤出目录。缓存按每个文件的修改时间和大小，用户原地改文件也看得到。
 *   文件名不合规、解析不出来的记忆文件报一次。
 *
 * @module @loveandbeepbrother/dsh-galatea/memory
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { callerLabel } from '../core/content.js'
import { cosine, decodeVector, encodeVector } from '../embedder/index.js'
import { NotesError, editNotes, excerpt, literalRanges, parseNotes, snippetAround, textWindow } from './notes.js'
import { MEMORY_ID, NOTE_ID, describeIndexChange, formatMemory, indexText, parseMemory, ulid } from './store.js'

export const name = 'mind-framework-memory'
export const inject = ['core', 'storageDomain']
export const SERVICE = 'memory'
export const INDEX_SEGMENT = 'memory-index'
const WRITES = Object.freeze([INDEX_SEGMENT])

export const Config = Schema.object({
    memoriesDirectory: Schema.string().default('memories').description('具体记忆的目录（相对内容库）'),
    notesFile: Schema.string().default('notes.md').description('便签文件（相对内容库）'),
    notesMaxChars: Schema.natural().default(8000).description('便签的篇幅上限（字），超了照样写、返回值里写明，并交给后台思考整理；0 不限'),
    indexChars: Schema.natural().default(4000).description('记忆目录的篇幅上限（字）'),
    keywordWeight: Schema.number().default(0.3).description('检索时关键词命中率的权重'),
    minSimilarity: Schema.number().default(0.3).description('没有关键词命中时，语义相似度至少这么高才列出'),
})

export const vectorsDomainSpec = defineDomain({
    name: 'mind_framework_memory_vectors',
    version: 1,
    layout: 'per-record',
    tables: {
        vectors: {
            valueSchema: z.object({ hash: z.string(), model: z.string(), dimensions: z.number(), vector: z.string() }).strict(),
        },
    },
})

export class MemoryError extends Error {
    constructor(message, current) {
        super(current === undefined ? message : `${message}\n\n当前内容：\n${current}`)
        this.code = 'MEMORY'
    }
}

/**
 * 调用方对记忆的权限（默认配置）。
 * @param project - 调用方会话所在的项目（`projectOf` 的结果）。
 * @returns `{ readAll, readable(scope), writable(scope) }`。
 */
export function memoryAccess(who, project) {
    const own = project === null || project === undefined ? null : `workspace:${project.id}`
    const ownOnly = { readAll: false, readable: scope => scope === 'global' || scope === own, writable: scope => own !== null && scope === own }
    if (who?.kind === 'external') return { readAll: true, readable: () => true, writable: scope => !who.readOnly && scope === 'global' }
    if (who?.kind === 'program') return { readAll: false, readable: scope => scope === 'global', writable: () => false }
    if (who?.kind !== 'session') return { readAll: false, readable: () => false, writable: () => false }
    switch (who.role) {
        case 'hub': return { readAll: true, readable: () => true, writable: scope => scope === 'global' || /^workspace:\S+$/.test(scope) }
        case 'background': return { readAll: true, readable: () => true, writable: scope => scope === 'global' }
        default: return ownOnly
    }
}

const sha256 = text => createHash('sha256').update(text).digest('hex')
const embeddedText = memory => `${memory.title ?? ''}\n${memory.summary ?? ''}\n${memory.body ?? ''}`

export async function apply(ctx, config) {
    const core = ctx.core
    const domain = await ctx.storageDomain.open(vectorsDomainSpec)
    ctx.effect(() => () => domain.close?.(), 'mind-framework-memory: vectors domain')
    const vectors = () => domain.table('vectors')
    const directory = config.memoriesDirectory
    const pathOf = id => `${directory}/${id}.md`
    const reported = new Set()
    const reportOnce = (key, detail) => {
        if (reported.has(key)) return
        reported.add(key)
        core.report(key.split(':')[0], detail)
    }

    /* ------------------------------------------------------------------ 载入 */

    /** 文件名 → `{ mtimeMs, size, memory }`。 */
    const cache = new Map()
    /** 最近一次载入的：编号 → 记忆。 */
    let current = new Map()

    async function load() {
        const root = core.content.root
        if (root === null) throw new MemoryError('核心没有配置内容目录，记忆不可用')
        const full = join(root, directory)
        let names
        try {
            names = await readdir(full)
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error
            names = []
        }
        const next = new Map()
        const seen = new Set()
        for (const fileName of names) {
            if (!fileName.endsWith('.md')) continue
            seen.add(fileName)
            const id = fileName.slice(0, -3)
            if (!MEMORY_ID.test(id)) {
                reportOnce(`memory/bad-file:${fileName}`, { text: `记忆目录里的 ${fileName} 文件名不合规（要是 mem-<ULID>.md），没收进记忆` })
                continue
            }
            const info = await stat(join(full, fileName))
            let entry = cache.get(fileName)
            if (entry === undefined || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
                const bytes = await readFile(join(full, fileName))
                const memory = parseMemory(bytes.toString('utf8'))
                entry = { mtimeMs: info.mtimeMs, size: info.size, memory: { ...memory, id, hash: sha256(bytes) } }
                cache.set(fileName, entry)
            }
            if (!entry.memory.ok) {
                reportOnce(`memory/unparsed:${fileName}:${entry.mtimeMs}`, { text: `记忆 ${fileName} 解析不出文件头，没收进记忆目录和检索` })
                continue
            }
            next.set(id, entry.memory)
        }
        for (const fileName of [...cache.keys()]) if (!seen.has(fileName)) cache.delete(fileName)
        current = next
        return next
    }

    // 载入时清掉对不上文件的向量。
    try {
        const memories = await load()
        for (const [id] of vectors().entries()) if (!memories.has(id)) await vectors().delete(id)
    } catch (error) {
        core.report('memory/load-failed', { text: `记忆载入失败（${error?.message ?? error}）` })
    }

    /* ------------------------------------------------------------------ 权限 */

    const projectOfCaller = who => (who?.kind === 'session' ? core.sessions.projectOf(who.sessionId) : null)
    const accessOf = who => memoryAccess(who, projectOfCaller(who))

    function titleOfProject(id) {
        const own = ctx.get('workspaceRegistry')?.list().find(item => String(item.id) === id)
        return own === undefined ? undefined : String(own.title ?? id)
    }

    /** `global`、`project`（调用方自己的项目）、`workspace:<编号>` → 存进文件的范围。 */
    function resolveScope(scope, who) {
        const project = projectOfCaller(who)
        if (scope === undefined || scope === '' || scope === null) return project === null ? 'global' : `workspace:${project.id}`
        if (scope === 'global') return 'global'
        if (scope === 'project') {
            if (project === null) throw new MemoryError('这个会话不在项目里，没有"本项目"；写全局的用 scope "global"')
            return `workspace:${project.id}`
        }
        if (/^workspace:\S+$/.test(scope)) return scope
        throw new MemoryError('scope 只能是 global、project 或 workspace:<项目编号>')
    }

    function requireVisible(id, who) {
        if (!MEMORY_ID.test(String(id ?? ''))) throw new MemoryError('id 应为 mem-<ULID>')
        const memory = current.get(id)
        if (memory === undefined || !accessOf(who).readable(memory.scope ?? 'global')) throw new MemoryError(`没有记忆 ${id}`)
        return memory
    }

    /* ------------------------------------------------------------------ 向量 */

    const vectorModel = embedder => `${embedder.model}@${embedder.dimensions}`

    async function refreshVectors(memories, embedder) {
        const stale = memories.filter((memory) => {
            const stored = vectors().get(memory.id)
            return stored === undefined || stored.hash !== sha256(embeddedText(memory)) || `${stored.model}@${stored.dimensions}` !== vectorModel(embedder)
        })
        if (stale.length === 0) return
        const made = await embedder.embed(stale.map(embeddedText))
        for (const [index, memory] of stale.entries()) {
            await vectors().put(memory.id, { hash: sha256(embeddedText(memory)), model: embedder.model, dimensions: embedder.dimensions, vector: encodeVector(made[index]) })
        }
    }

    /* ------------------------------------------------------------------ 服务 */

    async function write(args, who) {
        const title = String(args.title ?? '').trim()
        const summary = String(args.summary ?? '').trim()
        const body = String(args.body ?? '').trim()
        if (title === '' || summary === '' || body === '') throw new MemoryError('title、summary、body 都不能为空')
        await load()
        const existing = args.id === undefined || args.id === null || args.id === '' ? undefined : requireVisible(String(args.id), who)
        if (existing !== undefined && String(args.baseHash ?? '') !== existing.hash) {
            throw new MemoryError(`记忆 ${existing.id} 在你读取以后已经变了，基于下面的当前内容重新改`, formatMemory(existing))
        }
        const access = accessOf(who)
        const scope = resolveScope(args.scope ?? existing?.scope, who)
        if (!access.writable(scope)) throw new MemoryError(`这个会话不能写范围 ${scope} 的记忆`)
        if (existing !== undefined && !access.writable(existing.scope ?? 'global')) throw new MemoryError(`这个会话不能改范围 ${existing.scope} 的记忆`)
        const sources = (Array.isArray(args.sources) ? args.sources : []).map(String).map(item => item.trim()).filter(item => item !== '')
        const now = new Date().toISOString()
        const id = existing?.id ?? `mem-${ulid()}`
        const project = scope === 'global' ? undefined : (projectOfCaller(who)?.id === scope.slice('workspace:'.length) ? projectOfCaller(who).title : titleOfProject(scope.slice('workspace:'.length)))
        const text = formatMemory({
            title, summary, scope, project, created: existing?.created ?? now, updated: now,
            sources: sources.length > 0 ? sources : [callerLabel(who)], body,
        })
        const written = await core.content.write([{ path: pathOf(id), text, baseHash: existing?.hash ?? null }], { message: `${existing === undefined ? '新增' : '修改'}记忆：${title}`, by: who })
        const memories = await load()
        let note
        const embedder = ctx.get('embedder')
        if (embedder === undefined) note = '没有向量提供方：这条记忆只能按关键词检索到'
        else {
            try {
                await refreshVectors([memories.get(id)].filter(Boolean), embedder)
            } catch (error) {
                note = `向量没算出来（${error?.message ?? error}），下次检索时再算`
            }
        }
        return { id, hash: written.hashes[pathOf(id)] ?? null, commit: written.commit ?? null, ...note === undefined ? {} : { note } }
    }

    async function read(id, who) {
        await load()
        const memory = requireVisible(String(id), who)
        const { ok: _ok, ...rest } = memory
        return rest
    }

    async function forget(id, { baseHash, reason } = {}, who) {
        await load()
        const memory = requireVisible(String(id), who)
        if (!accessOf(who).writable(memory.scope ?? 'global')) throw new MemoryError(`这个会话不能删范围 ${memory.scope} 的记忆`)
        if (String(baseHash ?? '') !== memory.hash) throw new MemoryError(`记忆 ${memory.id} 在你读取以后已经变了，先重新读`, formatMemory(memory))
        const why = String(reason ?? '').trim()
        const written = await core.content.write([{ path: pathOf(memory.id), text: null, baseHash: memory.hash }], { message: `删除记忆：${memory.title ?? memory.id}${why ? `（${why}）` : ''}`, by: who })
        if (vectors().get(memory.id) !== undefined) await vectors().delete(memory.id)
        await load()
        return { id: memory.id, removed: true, commit: written.commit ?? null }
    }

    async function search(query, { limit = 10 } = {}, who) {
        const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
        if (words.length === 0) throw new MemoryError('query 不能为空')
        const count = Math.min(Math.max(Math.trunc(Number(limit) || 10), 1), 30)
        const access = accessOf(who)
        const candidates = [...(await load()).values()].filter(memory => access.readable(memory.scope ?? 'global'))
        let similarity = new Map()
        let note
        const embedder = ctx.get('embedder')
        if (embedder === undefined) note = '没有向量提供方，只按关键词检索'
        else {
            try {
                await refreshVectors(candidates, embedder)
                const [asked] = await embedder.embed([String(query)])
                similarity = new Map(candidates.map(memory => [memory.id, cosine(asked, decodeVector(vectors().get(memory.id).vector))]))
            } catch (error) {
                note = `语义检索失败（${error?.message ?? error}），只按关键词检索`
            }
        }
        const hits = candidates.map((memory) => {
            const haystack = embeddedText(memory).toLowerCase()
            const keywordMatch = words.filter(word => haystack.includes(word)).length / words.length
            const semantic = similarity.get(memory.id)
            return { memory, keywordMatch, similarity: semantic, score: (semantic ?? 0) + config.keywordWeight * keywordMatch }
        }).filter(hit => hit.keywordMatch > 0 || (hit.similarity ?? 0) >= config.minSimilarity)
            .sort((left, right) => right.score - left.score)
            .slice(0, count)
            .map(({ memory, keywordMatch, similarity: semantic }) => ({
                id: memory.id, title: memory.title, summary: memory.summary, scope: memory.scope, project: memory.project, updated: memory.updated,
                ...semantic === undefined ? {} : { similarity: Math.round(semantic * 1000) / 1000 },
                keywordMatch: Math.round(keywordMatch * 1000) / 1000,
            }))
        return { hits, ...note === undefined ? {} : { note } }
    }

    ctx.provide(SERVICE, { write, read, forget, search })

    /* ------------------------------------------------------------------ 便签 */

    let notesCache
    /** 当前便签：`{ fileHash, text, notes }`；文件不存在时是空的。 */
    async function currentNotes() {
        const stored = await core.content.read(config.notesFile)
        const text = stored?.text ?? ''
        const fileHash = stored?.hash ?? null
        if (notesCache?.fileHash !== fileHash || notesCache === undefined) {
            notesCache = { fileHash, text, notes: parseNotes(text, { label: `${config.notesFile} ` }).notes }
        }
        return notesCache
    }

    const clamp = (value, min, max, fallback) => {
        if (value === undefined || value === null) return fallback
        const number = Math.trunc(Number(value))
        return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback
    }

    async function notesSearch(query, { limit } = {}) {
        const literal = String(query ?? '').trim()
        if (literal === '') throw new NotesError('INVALID_ARGUMENT', 'query 不能为空')
        const parsed = await currentNotes()
        const items = []
        for (const note of parsed.notes) {
            const idRanges = literalRanges(note.id, literal)
            const bodyRanges = literalRanges(note.text, literal)
            const matchCount = idRanges.length + bodyRanges.length
            if (matchCount === 0) continue
            const hit = bodyRanges[0]
            items.push({
                noteId: note.id,
                headingLine: note.headingLine,
                startLine: note.startLine,
                endLine: note.bodyEndLine,
                hitLine: hit === undefined ? note.headingLine : note.startLine + note.text.slice(0, hit.index).split('\n').length - 1,
                matchCount,
                snippet: hit === undefined ? excerpt(note.text) : snippetAround(note.text, hit.index, hit.length),
            })
        }
        items.sort((left, right) => right.matchCount - left.matchCount || left.headingLine - right.headingLine)
        return { path: config.notesFile, fileHash: parsed.fileHash, query: literal, items: items.slice(0, clamp(limit, 1, 20, 10)) }
    }

    async function notesRead(noteId, { fileHash, offset, maxCharacters } = {}) {
        const parsed = await currentNotes()
        if (parsed.fileHash !== fileHash) throw new NotesError('REFERENCE_ERROR', `${config.notesFile} 的当前版本 ${parsed.fileHash} 和引用的版本 ${fileHash} 不同；请重新搜索`)
        const note = parsed.notes.find(entry => entry.id === noteId)
        if (note === undefined) throw new NotesError('REFERENCE_ERROR', `当前版本里没有便签 "${noteId}"；请重新搜索`)
        return {
            path: config.notesFile,
            fileHash: parsed.fileHash,
            noteId: note.id,
            headingLine: note.headingLine,
            startLine: note.startLine,
            endLine: note.bodyEndLine,
            ...textWindow(note.text, clamp(offset, 0, Number.MAX_SAFE_INTEGER, 0), clamp(maxCharacters, 1, 32_000, 12_000)),
        }
    }

    async function notesEdit(action, { noteId, body, fileHash } = {}, who) {
        if (!['add', 'update', 'remove'].includes(action)) throw new NotesError('INVALID_ARGUMENT', 'action 只能是 add、update 或 remove')
        if (action !== 'remove' && String(body ?? '').trim() === '') throw new NotesError('INVALID_ARGUMENT', 'body 不能为空')
        const parsed = await currentNotes()
        // add 不要调用方给版本（照旧）；内容库按这里读到的哈希写，读和写之间被别人改了照样会拒。
        if (action !== 'add' && parsed.fileHash !== fileHash) throw new NotesError('REFERENCE_ERROR', `${config.notesFile} 在你读取以后已经变了；请重新搜索`)
        const id = action === 'add' ? `note-${ulid()}` : String(noteId ?? '')
        if (action !== 'add' && !NOTE_ID.test(id)) throw new NotesError('INVALID_ARGUMENT', 'noteId 应为 note-<ULID>')
        const text = editNotes(parsed.text, { action, noteId: id, body })
        const label = { add: '新增', update: '修改', remove: '删除' }[action]
        const written = await core.content.write([{ path: config.notesFile, text, baseHash: parsed.fileHash }], { message: `${label}便签 ${id}`, by: who })
        const note = notesOverLimit(text)
        return { noteId: id, fileHash: written.hashes[config.notesFile] ?? null, commit: written.commit ?? null, ...note === undefined ? {} : { note } }
    }

    /** 便签超出篇幅上限时的一句（写入照样做）；没超或不限时为 undefined。 */
    function notesOverLimit(text) {
        if (config.notesMaxChars === 0 || text.length <= config.notesMaxChars) return undefined
        return `便签已 ${text.length} 字，超出上限 ${config.notesMaxChars} 字；已照样写入，整理时做完的删掉，长期有效的挪进记忆或项目文档`
    }

    // 装了后台思考时：便签超出上限，就在它的事实段里交一行，由它去整理（写便签的会话只在返回值里看到一次）。
    ctx.inject(['reflection'], (sub) => {
        const off = sub.reflection.contribute('便签', async () => {
            const note = notesOverLimit((await currentNotes()).text)
            return note === undefined ? [] : [note]
        })
        sub.effect(() => off, 'mind-framework-memory: notes length')
    })

    ctx.provide('notes', {
        search: notesSearch,
        read: notesRead,
        add: (body, who) => notesEdit('add', { body }, who),
        update: (noteId, body, fileHash, who) => notesEdit('update', { noteId, body, fileHash }, who),
        remove: (noteId, fileHash, who) => notesEdit('remove', { noteId, fileHash }, who),
    })

    /* ------------------------------------------------------------------ 段 */

    core.segment({
        name: INDEX_SEGMENT,
        order: 9400,
        audience: 'opening',
        text: async ({ sessionId }) => {
            const project = core.sessions.projectOf(sessionId)
            const own = project === null ? null : `workspace:${project.id}`
            const memories = [...(await load()).values()].filter(memory => (memory.scope ?? 'global') === 'global' || memory.scope === own)
            return indexText(memories, config.indexChars)
        },
        onChange: (previous, next) => describeIndexChange(previous, next, id => current.has(id)),
    })

    /* ------------------------------------------------------------------ 工具 */

    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
    const tool = ({ execute, ...definition }, meta) => core.tool(defineTool({
        ...definition,
        output,
        execute: async (args, exec) => JSON.stringify(await execute(args ?? {}, core.caller(exec)), null, 1),
    }), meta)
    const canWriteSomewhere = (who) => {
        const access = accessOf(who)
        const project = projectOfCaller(who)
        return access.writable('global') || (project !== null && access.writable(`workspace:${project.id}`))
    }

    tool({
        name: 'assistant_memory_write',
        description: 'Save a specific memory: a concrete past fact worth recalling later, with where it came from (who said it in which conversation). scope "global" is visible in every session; "project" only in sessions of the current project (default inside a project). Pass id and baseHash to revise an existing memory. Every session lists the titles and summaries of the memories in its scope.',
        parameters: {
            title: { type: 'string', required: true, description: 'Short title.' },
            summary: { type: 'string', required: true, description: 'One-line gist shown in the memory index.' },
            body: { type: 'string', required: true, description: 'The memory itself.' },
            // 上游不许同名工具按调用方各登记一份，说明只能所有人看到同一句。
            scope: { type: 'string', description: '"global" or "project" (the current project). The hub session is not in any project: to write a memory of a specific project it uses "workspace:<project id>", with the id from assistant_project_list.' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Where it came from, e.g. "session <id> seq <n>" or a file path; defaults to the calling session.' },
            id: { type: 'string', description: 'Existing memory id to revise.' },
            baseHash: { type: 'string', description: 'hash from assistant_memory_read, required with id.' },
        },
        execute: (args, who) => write(args, who),
    }, { effect: 'write', writesSegments: WRITES, allow: canWriteSomewhere })
    tool({
        name: 'assistant_memory_search',
        description: 'Search specific memories by meaning (semantic embedding) and keywords within what this session may see; each item reports its similarity and keyword match rate.',
        parameters: {
            query: { type: 'string', required: true, description: 'What to look for.' },
            limit: { type: 'integer', description: '1-30, default 10.' },
        },
        execute: (args, who) => search(args.query, { limit: args.limit }, who),
    }, { effect: 'read', alwaysLoad: true })
    tool({
        name: 'assistant_memory_read',
        description: 'Read one specific memory in full with its sources and version hash.',
        parameters: { id: { type: 'string', required: true, description: 'Memory id.' } },
        execute: (args, who) => read(args.id, who),
    }, { effect: 'read' })
    tool({
        name: 'assistant_notes_search',
        description: 'Search the shared notes file literally (case-insensitive, short Chinese terms work). Returns the current file version hash plus note ids and line numbers for assistant_notes_read and assistant_note_write.',
        parameters: {
            query: { type: 'string', required: true, description: 'Literal text to find.' },
            limit: { type: 'integer', description: '1-20, default 10.' },
        },
        execute: args => notesSearch(args.query, { limit: args.limit }),
    }, { effect: 'read', alwaysLoad: true })
    tool({
        name: 'assistant_notes_read',
        description: 'Read one shared note from the file version returned by assistant_notes_search. A changed file fails with REFERENCE_ERROR; search again then.',
        parameters: {
            noteId: { type: 'string', required: true, description: 'note id: "note-" plus a 26-character ULID.' },
            fileHash: { type: 'string', required: true, description: 'fileHash from assistant_notes_search.' },
            offset: { type: 'integer', description: 'Unicode code point offset, default 0.' },
            maxCharacters: { type: 'integer', description: '1-32000, default 12000.' },
        },
        execute: args => notesRead(String(args.noteId ?? ''), { fileHash: args.fileHash, offset: args.offset, maxCharacters: args.maxCharacters }),
    }, { effect: 'read' })
    tool({
        name: 'assistant_note_write',
        description: 'Add, update or remove one shared note (recent leads and to-dos). update and remove need the fileHash from assistant_notes_search. The body must not contain level-1 or level-2 headings, and code fences must be closed.',
        parameters: {
            action: { type: 'string', required: true, description: '"add", "update" or "remove".' },
            noteId: { type: 'string', description: 'note id for update/remove.' },
            body: { type: 'string', description: 'Note text for add/update.' },
            fileHash: { type: 'string', description: 'fileHash from assistant_notes_search, for update/remove.' },
        },
        execute: (args, who) => notesEdit(String(args.action ?? ''), args, who),
    }, { effect: 'write', alwaysLoad: true })
    tool({
        name: 'assistant_memory_forget',
        description: 'Delete a specific memory that is wrong or no longer worth keeping. The deletion stays in the history.',
        parameters: {
            id: { type: 'string', required: true, description: 'Memory id.' },
            baseHash: { type: 'string', required: true, description: 'hash from assistant_memory_read.' },
            reason: { type: 'string', description: 'Why it is removed.' },
        },
        execute: (args, who) => forget(args.id, { baseHash: args.baseHash, reason: args.reason }, who),
    }, { effect: 'write', destructive: true, writesSegments: WRITES, allow: canWriteSomewhere })
}
