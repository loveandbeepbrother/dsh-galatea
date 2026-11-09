/**
 * 经历库的存储：所有来源的条目（输入、回复、发出的消息、标记），每条时间线按先后排好，来源消失后仍在。
 *
 * - 一个 SQLite 文件：`entries` 与 `ops` 是真相，关键词索引
 *   （FTS5 trigram，适合中文）与语义向量（`entry_vectors`）都可以从它重建；`cursors` 记各来源读到的位置。
 *   同一条时间线（`session_id`）里按 `(at, tie, id)` 排序。
 * - 列的含义：`session_id` 是时间线，`origin` 是登记的来源，来源分部分时写成 `<来源>:<部分>`（如一个记录文件一部分；
 *   重算只动这个来源这一部分、这条时间线里的条目），`source` 是来源所属的大类（检索时按它筛）。
 * - 编号是来源给的完整编号，这里只检查全库唯一：别的来源已经用了的编号拒收。
 * - 关联编号由生产方给，这里不按正文猜。旧数据里的 `inferred_link` 照样读作关联编号。
 * - `usage`：记忆、便签、文档段、经历被搜到、被打开的次数和最后时刻，按调用方的角色分开记（后台整理会把一大批都搜一遍，
 *   混在一起就分不出哪些真被用到）。和经历放在一起是因为数据备份本来就覆盖这个文件；编号是各来源自己的编号。
 *
 * @module @loveandbeepbrother/dsh-galatea/experience/archive
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 标记类别：读的时候知道从哪里起上下文换过了。 */
export const MARKER_KINDS = ['压缩', '交接', '进程重开', '换模型']

const SCHEMA = `
create table if not exists entries (
    id text primary key,
    source text not null,
    session_id text not null,
    origin text not null,
    title text,
    place text,
    at integer not null,
    tie integer not null default 0,
    role text not null,
    kind text not null,
    text text not null,
    link text,
    inferred_link text,
    party text,
    model text,
    turn text,
    tkey text,
    hash text not null,
    vhash text not null
);
create index if not exists entries_order on entries(session_id, at, tie, id);
create index if not exists entries_at on entries(at);
create index if not exists entries_link on entries(link);
create index if not exists entries_inferred on entries(inferred_link);
create index if not exists entries_tkey on entries(tkey);
create virtual table if not exists entries_text using fts5(text, content='entries', content_rowid='rowid', tokenize='trigram');
create trigger if not exists entries_ai after insert on entries begin
    insert into entries_text(rowid, text) values (new.rowid, new.text);
end;
create trigger if not exists entries_ad after delete on entries begin
    insert into entries_text(entries_text, rowid, text) values ('delete', old.rowid, old.text);
end;
create trigger if not exists entries_au after update of text on entries begin
    insert into entries_text(entries_text, rowid, text) values ('delete', old.rowid, old.text);
    insert into entries_text(rowid, text) values (new.rowid, new.text);
end;
create table if not exists ops (
    id text primary key,
    session_id text not null,
    origin text not null,
    at integer not null,
    tie integer not null default 0,
    tool text not null,
    detail text not null,
    link text
);
create index if not exists ops_order on ops(session_id, at);
create index if not exists ops_link on ops(link);
create table if not exists entry_vectors (id text primary key, hash text not null, model text not null, vector blob not null);
create table if not exists cursors (key text primary key, value text not null);
create table if not exists usage (
    source text not null,
    ref text not null,
    role text not null,
    shown integer not null default 0,
    last_shown integer,
    opened integer not null default 0,
    last_opened integer,
    first_at integer not null,
    primary key (source, ref, role)
) without rowid;
`

/** 参与向量的角色：说的话与发出的消息；标记与系统转交不算。 */
const EMBEDDED_ROLES = `('user', 'peer', 'assistant', 'out')`
const MARKERS = `(${MARKER_KINDS.map(kind => `'${kind}'`).join(', ')})`
/** 不算输入、也不分段的系统条目：标记与渠道的自动提醒。 */
const NOT_INPUT = `(${[...MARKER_KINDS, '渠道提醒'].map(kind => `'${kind}'`).join(', ')})`

const sha = text => createHash('sha256').update(text).digest('hex')

/** 条目的内容指纹（标题与目录之外任何字段变了都要更新；标题由 `retitle` 跟着会话改）与向量指纹（只看嵌入的文字）。 */
export function entryHash(entry) {
    return sha([entry.role, entry.kind, entry.text, entry.link ?? '', entry.party ?? '', entry.model ?? '', entry.turn ?? '', entry.at, entry.tie ?? 0, entry.origin].join('\u0000'))
}
export const vectorText = row => `${row.kind}：${row.text}`
export const vectorHash = entry => sha(vectorText(entry))

/** trigram 只能匹配三个字及以上的词；更短的词逐行字面比对。 */
const TRIGRAM = 3

/** 查询词：按空白切分，去重。 */
export function termsOf(query) {
    return [...new Set(String(query).split(/\s+/).map(term => term.trim()).filter(Boolean))]
}

/** FTS5 短语：整体加引号，内部引号成对转义，用户输入不会被当成查询语法。 */
const phrase = term => `"${term.replaceAll('"', '""')}"`

/**
 * 打开经历库。
 * @param path - SQLite 文件路径；测试可用 `':memory:'`。所在目录不存在就建上（不靠别的模块先建好）。
 */
export function openArchive(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;')
    db.exec(SCHEMA)

    const columns = 'id, source, session_id, origin, title, place, at, tie, role, kind, text, link, inferred_link, party, model, turn, tkey, hash, vhash'
    const statements = {
        get: db.prepare('select * from entries where id = ?'),
        hash: db.prepare('select hash from entries where id = ?'),
        owner: db.prepare('select origin, session_id from entries where id = ?'),
        // 没写标题的（启动以后一条条收进来的，只有整份读才知道标题）沿用这个会话已有的标题；会话改名由 `retitle` 整条跟着改。
        insert: db.prepare(`insert into entries (${columns}) values (:id, :source, :session_id, :origin,
            coalesce(:title, (select title from entries where session_id = :session_id and title is not null limit 1)), :place, :at, :tie,
            :role, :kind, :text, :link, null, :party, :model, :turn, :tkey, :hash, :vhash)`),
        update: db.prepare(`update entries set origin = :origin, title = coalesce(:title, title), place = coalesce(:place, place), at = :at, tie = :tie, role = :role,
            kind = :kind, text = :text, link = :link, party = :party, model = :model, turn = :turn, tkey = :tkey, hash = :hash,
            vhash = :vhash where id = :id`),
        scopeIds: db.prepare('select id from entries where session_id = ? and origin = ? and tie >= ?'),
        remove: db.prepare('delete from entries where id = ?'),
        putOp: db.prepare(`insert into ops (id, session_id, origin, at, tie, tool, detail, link) values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set at = excluded.at, tie = excluded.tie, tool = excluded.tool, detail = excluded.detail, link = excluded.link`),
        removeOps: db.prepare('delete from ops where session_id = ? and origin = ? and tie >= ?'),
        retitle: db.prepare('update entries set title = ? where session_id = ? and (title is null or title <> ?)'),
        cursor: db.prepare('select value from cursors where key = ?'),
        setCursor: db.prepare('insert into cursors (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'),
        clearCursors: db.prepare("delete from cursors where key like 'v2:%'"),
        after: db.prepare(`select * from entries where session_id = :session and (at, tie, id) > (:at, :tie, :id)
            order by at, tie, id limit :limit`),
        before: db.prepare(`select * from entries where session_id = :session and (at, tie, id) < (:at, :tie, :id)
            order by at desc, tie desc, id desc limit :limit`),
        position: db.prepare(`select count(*) as n from entries where session_id = :session and (at, tie, id) <= (:at, :tie, :id)`),
        boundary: db.prepare(`select at, tie from entries where session_id = :session and (at, tie, id) < (:at, :tie, :id)
            and role <> 'out' and kind not in ${NOT_INPUT} order by at desc, tie desc, id desc limit 1`),
        nextInput: db.prepare(`select * from entries where session_id = :session and (at, tie, id) > (:at, :tie, :id)
            and role in ('user', 'peer', 'system') and kind not in ${NOT_INPUT} and kind not like '%（中途）' order by at, tie, id limit 1`),
        lastInput: db.prepare(`select * from entries where session_id = :session and (at, tie, id) <= (:at, :tie, :id)
            and role in ('user', 'peer', 'system') and kind not in ${NOT_INPUT} and kind not like '%（中途）' order by at desc, tie desc, id desc limit 1`),
        between: db.prepare(`select * from entries where session_id = :session and (at, tie, id) >= (:fromAt, :fromTie, :fromId)
            and (:toAt is null or (at, tie, id) < (:toAt, :toTie, :toId)) order by at, tie, id limit :limit`),
        opsBetween: db.prepare(`select * from ops where session_id = :session and (at, tie) > (:fromAt, :fromTie)
            and (at, tie) <= (:toAt, :toTie) order by at, tie, id`),
        removeVector: db.prepare('delete from entry_vectors where id = ?'),
        opsLinksBetween: db.prepare('select distinct link from ops where session_id = ? and at >= ? and (? is null or at < ?) and link is not null'),
        byLink: db.prepare('select * from entries where link = ? or inferred_link = ? order by at, tie, id'),
        opsByLink: db.prepare('select * from ops where link = ? order by at'),
        latestMarker: db.prepare(`select * from entries where session_id = :session and role = 'system' and kind in ${MARKERS}
            and (:kind is null or kind = :kind) order by at desc, tie desc, id desc limit 1`),
        firstAtOrAfter: db.prepare('select * from entries where session_id = ? and at >= ? order by at, tie, id limit 1'),
        lastBefore: db.prepare('select * from entries where session_id = ? and at < ? order by at desc, tie desc, id desc limit 1'),
        indexPage: db.prepare("select rowid, id, session_id, role, kind, at, text, hash, source, coalesce(link, inferred_link) as link from entries where rowid > ? and role in ('user', 'assistant', 'out', 'peer') order by rowid limit ?"),
        indexKeys: db.prepare("select id as ref, hash, coalesce(link, inferred_link) as link from entries where role in ('user', 'assistant', 'out', 'peer')"),
        indexEntry: db.prepare('select rowid, id, session_id, role, kind, at, text, hash, source, coalesce(link, inferred_link) as link from entries where id = ?'),
        opsPage: db.prepare('select rowid, id, session_id, at, tool, detail from ops where rowid > ? order by rowid limit ?'),
        opsKeys: db.prepare('select id as ref, tool, detail from ops'),
        indexOp: db.prepare('select rowid, id, session_id, at, tool, detail from ops where id = ?'),
        spokenSince: db.prepare("select * from entries where session_id = ? and at > ? and role in ('user', 'assistant', 'out', 'peer') order by at desc, tie desc, id desc limit 20000"),
        lastInputBefore: db.prepare("select * from entries where session_id = ? and role = 'user' and at < ? and length(text) between 12 and 2000 order by at desc, tie desc, id desc limit 1"),
        sessionInfo: db.prepare('select source, title, place from entries where session_id = ? order by title is null, at desc limit 1'),
        stale: db.prepare(`select e.id, e.vhash, e.kind, e.text from entries e left join entry_vectors v on v.id = e.id
            where e.role in ${EMBEDDED_ROLES} and length(e.text) >= 2 and (v.id is null or v.hash <> e.vhash or v.model <> ?) limit ?`),
        putVector: db.prepare(`insert into entry_vectors (id, hash, model, vector) values (?, ?, ?, ?)
            on conflict(id) do update set hash = excluded.hash, model = excluded.model, vector = excluded.vector`),
        vectors: db.prepare(`select v.id, v.hash, v.vector, e.source, e.session_id, e.at, coalesce(e.link, e.inferred_link) as link from entry_vectors v join entries e on e.id = v.id
            where v.model = ? and v.hash = e.vhash`),
        count: db.prepare(`select count(*) as entries,
            (select count(*) from entries where role in ${EMBEDDED_ROLES} and length(text) >= 2) as embeddable,
            (select count(*) from entry_vectors) as vectors,
            (select count(*) from ops) as ops,
            (select count(distinct session_id) from entries) as sessions from entries`),
    }

    /** 编号被别的来源或别的时间线用了：拒收（编号是来源给的，全库唯一）。 */
    class DuplicateIdError extends Error {
        constructor(id, owner) {
            super(`经历库的编号 ${id} 已经属于来源 ${owner.origin}（时间线 ${owner.session_id}），拒收`)
            this.code = 'EXPERIENCE_DUPLICATE_ID'
            this.id = id
        }
    }

    /** 保存或更新一条；内容没变时什么也不做。返回是否有变化。 */
    function put(entry, scope) {
        const owner = statements.owner.get(entry.id)
        // 同一个来源的不同部分（如不同的记录文件）之间可以挪；别的来源用过的拒收。
        const sourceOf = origin => String(origin).split(':')[0]
        if (owner !== undefined && (sourceOf(owner.origin) !== sourceOf(scope.origin) || owner.session_id !== scope.sessionId)) throw new DuplicateIdError(entry.id, owner)
        const row = {
            id: entry.id,
            source: scope.source,
            session_id: scope.sessionId,
            origin: scope.origin,
            title: entry.title ?? scope.title ?? null,
            place: entry.place ?? scope.place ?? null,
            at: entry.at,
            tie: entry.tie ?? 0,
            role: entry.role,
            kind: entry.kind,
            text: entry.text,
            link: entry.link ?? null,
            party: entry.party ?? null,
            model: entry.model ?? null,
            turn: entry.turn ?? null,
            // 旧数据里给按正文配对用的指纹；配对去掉了，新条目不再写。
            tkey: null,
        }
        row.hash = entryHash(row)
        row.vhash = vectorHash(row)
        const existing = statements.hash.get(row.id)
        if (existing === undefined) {
            statements.insert.run(row)
            return true
        }
        if (existing.hash === row.hash) return false
        const { source, session_id, ...changed } = row
        statements.update.run(changed)
        return true
    }

    /** 被删掉的条目编号，等调用方（内存里的向量缓存）取走。 */
    let removed = []

    function transaction(body) {
        db.exec('begin')
        try {
            const result = body()
            db.exec('commit')
            return result
        } catch (error) {
            db.exec('rollback')
            throw error
        }
    }

    /**
     * 一个来源的若干条目与操作一次写入。
     * @param scope - `{ source, sessionId, origin, title?, place?, replaceFrom? }`；给了 `replaceFrom` 时，同一会话、同一来源中
     *   `tie >= replaceFrom` 而这次没有给出的条目与操作删掉（重新解析进行中的一段时，旧的“回复”可能已变成过程说明）。
     * @returns `{ changed, rejected }`：有变化的条目数、被拒收的（编号重复）说明。
     */
    function write(scope, entries, ops = []) {
        return transaction(() => {
            let changed = 0
            const rejected = []
            if (scope.replaceFrom !== undefined) {
                const keep = new Set(entries.map(entry => entry.id))
                for (const { id } of statements.scopeIds.all(scope.sessionId, scope.origin, scope.replaceFrom)) {
                    if (!keep.has(id)) {
                        statements.remove.run(id)
                        statements.removeVector.run(id)
                        removed.push(id)
                        changed++
                    }
                }
                statements.removeOps.run(scope.sessionId, scope.origin, scope.replaceFrom)
            }
            for (const entry of entries) {
                try {
                    if (put(entry, scope)) changed++
                } catch (error) {
                    if (error?.code !== 'EXPERIENCE_DUPLICATE_ID') throw error
                    rejected.push(error.message)
                }
            }
            for (const op of ops) statements.putOp.run(op.id, scope.sessionId, scope.origin, op.at, op.tie ?? 0, op.tool, op.detail ?? '', op.link ?? null)
            return { changed, rejected }
        })
    }

    /**
     * 关键词检索：每个词都要出现。三字及以上的词走全文索引并按相关度排序，更短的词逐行字面比对。
     * @returns `[{ ...row, rank }]`，按相关度（或时间倒序）。
     */
    function keyword(terms, filter, limit) {
        const long = terms.filter(term => Array.from(term).length >= TRIGRAM)
        const short = terms.filter(term => Array.from(term).length < TRIGRAM)
        const where = []
        const params = {}
        if (filter.source !== undefined) {
            where.push('e.source = :source')
            params.source = filter.source
        }
        if (filter.sessionId !== undefined) {
            where.push('e.session_id = :session')
            params.session = filter.sessionId
        }
        if (filter.sessions !== undefined) {
            // 调用方看得见的时间线（工作会话只看本项目的）；一条都没有时什么也查不到。
            if (filter.sessions.length === 0) return []
            where.push(`e.session_id in (${filter.sessions.map((_id, index) => `:t${index}`).join(', ')})`)
            filter.sessions.forEach((id, index) => { params[`t${index}`] = id })
        }
        if (filter.role !== undefined) {
            where.push('e.role = :role')
            params.role = filter.role
        }
        if (filter.since !== undefined) {
            where.push('e.at >= :since')
            params.since = filter.since
        }
        if (filter.until !== undefined) {
            where.push('e.at < :until')
            params.until = filter.until
        }
        short.forEach((term, index) => {
            where.push(`instr(lower(e.text), :s${index}) > 0`)
            params[`s${index}`] = term.toLowerCase()
        })
        params.limit = limit
        if (long.length > 0) {
            params.match = long.map(phrase).join(' AND ')
            const sql = `select e.*, bm25(entries_text) as rank from entries_text join entries e on e.rowid = entries_text.rowid
                where entries_text match :match ${where.length > 0 ? `and ${where.join(' and ')}` : ''}
                order by rank limit :limit`
            return db.prepare(sql).all(params)
        }
        const sql = `select e.*, 0 as rank from entries e ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
            order by e.at desc limit :limit`
        return db.prepare(sql).all(params)
    }

    const key = row => ({ session: row.session_id, at: row.at, tie: row.tie, id: row.id })

    const usageBump = {
        shown: db.prepare(`insert into usage (source, ref, role, shown, last_shown, first_at) values (?, ?, ?, 1, ?, ?)
            on conflict(source, ref, role) do update set shown = shown + 1, last_shown = excluded.last_shown`),
        opened: db.prepare(`insert into usage (source, ref, role, opened, last_opened, first_at) values (?, ?, ?, 1, ?, ?)
            on conflict(source, ref, role) do update set opened = opened + 1, last_opened = excluded.last_opened`),
    }
    const inList = (column, values, params, prefix) => {
        const names = values.map((value, index) => {
            params[`${prefix}${index}`] = String(value)
            return `:${prefix}${index}`
        })
        return `${column} in (${names.join(', ')})`
    }

    /**
     * 使用统计的汇总：同一条按选中的角色加起来。
     * @param options.order - `most`（搜到加打开最多的在前）或 `least_recent`（最后一次用到最早的在前）。
     */
    function usage({ sources = null, roles = null, refs = null, order = 'most', limit = 20 } = {}) {
        const where = []
        const params = { limit }
        if (sources !== null) where.push(inList('source', sources, params, 's'))
        if (roles !== null) where.push(inList('role', roles, params, 'r'))
        if (refs !== null) where.push(inList('ref', refs, params, 'f'))
        const ordering = order === 'least_recent'
            ? 'max(coalesce(max(last_shown), 0), coalesce(max(last_opened), 0)) asc'
            : 'sum(shown) + sum(opened) desc, max(coalesce(max(last_shown), 0), coalesce(max(last_opened), 0)) desc'
        return db.prepare(`select source, ref, sum(shown) as shown, sum(opened) as opened, max(last_shown) as last_shown,
            max(last_opened) as last_opened, min(first_at) as first_at from usage ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
            group by source, ref order by ${ordering} limit :limit`).all(params)
    }

    return {
        db,
        write,
        keyword,
        /** 这几条被搜到（`shown`）或被打开（`opened`）一次，记在调用方的角色下；同一批里重复的编号算一次。 */
        noteUsage(source, refs, kind, role, at = Date.now()) {
            const statement = usageBump[kind]
            if (statement === undefined) throw new TypeError('kind 只能是 shown 或 opened')
            transaction(() => {
                for (const ref of new Set(refs.map(String))) statement.run(String(source), ref, String(role), at, at)
            })
        },
        usage,
        /** 有使用记录的编号（某个来源、选中的角色）。 */
        usedRefs: (source, roles = null) => new Set(usage({ sources: [source], roles, limit: Number.MAX_SAFE_INTEGER }).map(row => row.ref)),
        /** 统计从什么时候开始记（最早一条的时刻），还没有记录时是 `null`。 */
        usageSince: () => db.prepare('select min(first_at) as at from usage').get()?.at ?? null,
        get: id => statements.get.get(id),
        /** 同一会话里这一条之后（不含）的若干条，按顺序。 */
        after: (row, limit) => statements.after.all({ ...key(row), limit }),
        /** 同一会话里这一条之前（不含）的若干条，按顺序（由近到远）。 */
        before: (row, limit) => statements.before.all({ ...key(row), limit }),
        /** 这一条是会话里的第几条（从 1 开始）。 */
        position: row => statements.position.get(key(row)).n,
        /** 这一条之前最近一条“输入或回复”的位置 `{ at, tie }`：其后到这一条之间的操作归这一条。 */
        boundaryBefore: row => statements.boundary.get(key(row)),
        /** 这一条所在的一段：从开启这一轮的输入（含）到下一轮的输入（不含）；中途到达的输入不分段。最多 `limit` 条，更多时 `more`。 */
        segmentOf(row, limit) {
            const start = statements.lastInput.get(key(row)) ?? row
            const next = statements.nextInput.get(key(start)) ?? null
            const entries = statements.between.all({
                session: row.session_id,
                fromAt: start.at, fromTie: start.tie, fromId: start.id,
                toAt: next?.at ?? null, toTie: next?.tie ?? null, toId: next?.id ?? null,
                limit: limit + 1,
            })
            const more = entries.length > limit
            const links = statements.opsLinksBetween.all(row.session_id, start.at, next?.at ?? null, next?.at ?? null).map(item => item.link)
            return { start, next, entries: entries.slice(0, limit), more, opLinks: links }
        },
        /** 同一会话里位置在 `from` 之后（不含）、`to` 及之前的操作；位置按 `(at, tie)`，同一毫秒的先后也分得清。 */
        opsBetween: (sessionId, from, to) => statements.opsBetween.all({ session: sessionId, fromAt: from.at, fromTie: from.tie, toAt: to.at, toTie: to.tie }),
        byLink: link => statements.byLink.all(link, link),
        /** 自上次取走以来被删掉的条目编号。 */
        drainRemoved: () => {
            const ids = removed
            removed = []
            return ids
        },
        opsByLink: link => statements.opsByLink.all(link),
        latestMarker: (sessionId, kind) => statements.latestMarker.get({ session: sessionId, kind: kind ?? null }),
        firstAtOrAfter: (sessionId, at) => statements.firstAtOrAfter.get(sessionId, at),
        lastBefore: (sessionId, at) => statements.lastBefore.get(sessionId, at),
        lastInputBefore: (sessionId, at) => statements.lastInputBefore.get(sessionId, at),
        spokenSince: (sessionId, at) => statements.spokenSince.all(sessionId, at),
        indexPage: (after, limit) => statements.indexPage.all(after, limit),
        indexKeys: () => statements.indexKeys.all(),
        indexEntry: id => statements.indexEntry.get(id),
        opsPage: (after, limit) => statements.opsPage.all(after, limit),
        opsKeys: () => statements.opsKeys.all(),
        indexOp: id => statements.indexOp.get(id),
        /** 会话的来源、标题与目录（取已有条目里的）。 */
        sessionInfo: sessionId => statements.sessionInfo.get(sessionId),
        /** 某条时间线里属于某个来源、`tie` 不小于给定值的条目编号（重算前看会删掉哪些）。 */
        idsFrom: (sessionId, origin, tie) => statements.scopeIds.all(sessionId, origin, tie).map(row => row.id),
        /** 会话标题变化时更新已保存的条目。 */
        retitle: (sessionId, title) => statements.retitle.run(title, sessionId, title),
        cursor: (name) => {
            const row = statements.cursor.get(name)
            return row === undefined ? undefined : JSON.parse(row.value)
        },
        setCursor: (name, value) => statements.setCursor.run(name, JSON.stringify(value)),
        /** 从原始来源整体重建：清空条目、操作与收录位置（向量按指纹复用，内容没变的不必重算）。 */
        reset: () => transaction(() => {
            removed = []
            db.exec('delete from entries; delete from ops;')
            statements.clearCursors.run()
        }),
        /** 还没有当前向量的条目。 */
        stale: (model, limit) => statements.stale.all(model, limit),
        staleCount: model => statements.stale.all(model, Number.MAX_SAFE_INTEGER).length,
        putVector: (id, hash, model, vector) => statements.putVector.run(id, hash, model,
            new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)),
        /** 当前模型的全部有效向量，带过滤所需的字段。 */
        vectors: model => statements.vectors.all(model).map(row => ({
            id: row.id,
            hash: row.hash,
            source: row.source,
            sessionId: row.session_id,
            at: row.at,
            link: row.link,
            vector: new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)),
        })),
        stats: () => statements.count.get(),
        close: () => db.close(),
    }
}
