/**
 * 派生索引 `search.sqlite`：能重建，删了不丢东西，不进备份。写在 worker 里，查询在主线程（WAL，一写多读）。
 *
 * - 全文表 contentless_delete：不存原文，片段回原文取。
 * - 旁表 `items`：一行一条，记来源、引用、可见范围、时间、指纹。可见范围在 SQL 里过滤，不查完再滤。引用按来源唯一：
 *   发给会话的条目和那次工具调用是同一个编号。
 * - 同一次发送的几份副本（`link` 相同）各有一行，正文相同的只有一份进全文表，其余的 `copy_of` 指向它：词频按一条算。
 *   发送方那份优先。查询按几份的并集判断看不看得到，交回调用方看得到的那一份。接收方多一层通知的那份正文不同，
 *   自己进全文表，不然那段话就搜不到了；查询时按 `link` 折叠。
 * - 向量表按块内容哈希加模型存，重建全文时不碰，只算新块。
 * - 文件表记已扫过的文档（修改时间、大小），没变的不读。
 *
 * @module @loveandbeepbrother/dsh-galatea/search/store
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { indexedText, matchAny } from './tokens.js'

const SCHEMA = `
create table if not exists items (
    id integer primary key,
    source text not null,
    ref text not null,
    scope text not null,
    thread text,
    role text,
    category text,
    link text,
    at integer not null default 0,
    title text,
    location text,
    hash text not null,
    wants_vector integer not null default 0,
    body_hash text,
    copy_of integer,
    unique (source, ref)
);
create index if not exists items_source on items (source, scope);
create index if not exists items_copy on items (copy_of);
create index if not exists items_link on items (source, link, body_hash);
create index if not exists items_hash on items (hash);
create table if not exists vectors (
    hash text not null,
    model text not null,
    vector blob not null,
    primary key (hash, model)
) without rowid;
create table if not exists files (
    path text primary key,
    mtime integer not null,
    size integer not null
) without rowid;
create table if not exists cursors (
    key text primary key,
    value integer not null
) without rowid;
create virtual table if not exists texts using fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 0');
`

/** 结构变了就升这个数：旧索引丢掉重建。向量按内容哈希存，留着，不用重算。 */
const SCHEMA_VERSION = 2
const REBUILT = 'drop table if exists vocab; drop table if exists texts; drop table if exists items; drop table if exists files; drop table if exists cursors;'

/**
 * @param path - 文件路径。
 * @param options.readOnly - 只读连接（主线程查询）。
 */
export function openStore(path, { readOnly = false } = {}) {
    const db = new DatabaseSync(path, { readOnly })
    db.exec('pragma busy_timeout = 5000')
    if (!readOnly) {
        db.exec('pragma journal_mode = wal; pragma synchronous = normal;')
        if (db.prepare('pragma user_version').get().user_version !== SCHEMA_VERSION) {
            db.exec(REBUILT)
            db.exec(`pragma user_version = ${SCHEMA_VERSION}`)
        }
        db.exec(SCHEMA)
    }
    const statement = new Map()
    const prepared = sql => {
        if (!statement.has(sql)) statement.set(sql, db.prepare(sql))
        return statement.get(sql)
    }

    function transaction(job) {
        db.exec('begin immediate')
        try {
            const result = job()
            db.exec('commit')
            return result
        } catch (error) {
            db.exec('rollback')
            throw error
        }
    }

    /**
     * 删一条。它要是一组副本里进了全文表的那份，这一组的其余几份也删掉、记进 `orphans`：全文表不存原文，要调用方重新交。
     */
    function removeOne(source, ref, orphans) {
        const existing = prepared('select id, copy_of from items where source = ? and ref = ?').get(source, ref)
        if (existing === undefined) return false
        if (existing.copy_of === null) {
            prepared('delete from texts where rowid = ?').run(existing.id)
            for (const member of prepared('select ref from items where copy_of = ?').all(existing.id)) orphans.push(member.ref)
            prepared('delete from items where copy_of = ?').run(existing.id)
        }
        prepared('delete from items where id = ?').run(existing.id)
        return true
    }

    /** 写一条（没变不动）。`text` 只用来分词，不存。 */
    function upsertOne({ source, ref, scope, thread = null, role = null, category = null, link = null, at = 0, title = null, location = null, hash, text, wantsVector = false }, orphans) {
        const existing = prepared('select id, hash from items where source = ? and ref = ?').get(source, ref)
        const wants = wantsVector ? 1 : 0
        if (existing !== undefined && existing.hash === hash) {
            prepared('update items set scope = ?, thread = ?, role = ?, category = ?, link = ?, at = ?, title = ?, location = ?, wants_vector = ? where id = ?')
                .run(scope, thread, role, category, link, at, title, location, wants, existing.id)
            return false
        }
        if (existing !== undefined) removeOne(source, ref, orphans)
        const bodyHash = link === null ? null : createHash('sha256').update(String(text), 'utf8').digest('hex')
        const { lastInsertRowid: id } = prepared('insert into items (source, ref, scope, thread, role, category, link, at, title, location, hash, wants_vector, body_hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(source, ref, scope, thread, role, category, link, at, title, location, hash, wants, bodyHash)
        const first = link === null ? undefined : prepared('select id, role from items where source = ? and link = ? and body_hash = ? and copy_of is null and id != ?').get(source, link, bodyHash, id)
        if (first !== undefined && !(role === 'out' && first.role !== 'out')) {
            prepared('update items set copy_of = ? where id = ?').run(first.id, id)
            return true
        }
        if (first !== undefined) {
            prepared('delete from texts where rowid = ?').run(first.id)
            prepared('update items set copy_of = ? where id = ? or copy_of = ?').run(id, first.id, first.id)
        }
        prepared('insert into texts (rowid, body) values (?, ?)').run(id, indexedText(text))
        return true
    }

    /**
     * 一批写入和删除，一个事务。
     * @param options.source - `removes` 所属的来源。
     * @returns `changed`，和要重新交的引用 `orphans`（见 `removeOne`）。
     */
    const apply = ({ upserts = [], source, removes = [] } = {}) => transaction(() => {
        let changed = 0
        const orphans = []
        for (const ref of removes) if (removeOne(source, ref, orphans)) changed += 1
        for (const item of upserts) if (upsertOne(item, orphans)) changed += 1
        return { changed, orphans: orphans.filter(ref => upserts.every(item => item.ref !== ref) && !removes.includes(ref)) }
    })

    /**
     * 对账：这个来源应当有的就是这些，别的删掉。
     * @param keep - `[{ ref, hash }]`。
     * @returns 删了几条，以及指纹变了、要重新交的引用。
     */
    function reconcile(source, keep, { prefix } = {}) {
        const wanted = new Map(keep.map(item => [item.ref, item.hash]))
        const stale = []
        const removes = []
        const rows = prepared('select ref, hash from items where source = ?').all(source)
        for (const row of rows) {
            if (prefix !== undefined && !row.ref.startsWith(prefix)) continue
            if (!wanted.has(row.ref)) removes.push(row.ref)
            else if (wanted.get(row.ref) !== row.hash) stale.push(row.ref)
        }
        const have = new Set(rows.map(row => row.ref))
        for (const ref of wanted.keys()) if (!have.has(ref)) stale.push(ref)
        const { changed, orphans } = apply({ source, removes })
        for (const ref of orphans) if (wanted.has(ref) && !stale.includes(ref)) stale.push(ref)
        return { removed: changed, stale }
    }

    const cursor = key => prepared('select value from cursors where key = ?').get(key)?.value ?? 0
    const setCursor = (key, value) => prepared('insert into cursors (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(key, value)
    const fileRow = path => prepared('select mtime, size from files where path = ?').get(path)
    const setFile = (path, mtime, size) => prepared('insert into files (path, mtime, size) values (?, ?, ?) on conflict (path) do update set mtime = excluded.mtime, size = excluded.size').run(path, mtime, size)
    const dropFile = path => prepared('delete from files where path = ?').run(path)
    const knownFiles = () => prepared('select path from files').all().map(row => row.path)
    const refsOfFile = prefix => prepared("select ref from items where source = 'documents' and ref >= ? and ref < ?").all(`${prefix}#`, `${prefix}$`).map(row => row.ref)

    /** 块的向量：只算缺的。 */
    const hasVector = (hash, model) => prepared('select 1 from vectors where hash = ? and model = ?').get(hash, model) !== undefined
    const putVectors = (model, vectors) => transaction(() => {
        const put = prepared('insert into vectors (hash, model, vector) values (?, ?, ?) on conflict (hash, model) do update set vector = excluded.vector')
        for (const { hash, vector } of vectors) put.run(hash, model, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
    })
    /** 想要向量、这个模型还没有的块在哪些文件：`[{ ref, location, hash }]`。 */
    const missingVectors = (model, limit) => prepared(`select i.ref, i.location, i.hash from items i left join vectors v on v.hash = i.hash and v.model = ?
        where i.wants_vector = 1 and v.hash is null limit ?`).all(model, limit)

    /** 想要向量的块和它们的向量：`[{ id, hash, scope, vector }]`。 */
    function loadVectors(model) {
        return prepared(`select i.hash, v.vector from items i join vectors v on v.hash = i.hash and v.model = ? where i.wants_vector = 1 group by i.hash`).all(model)
            .map(row => ({ hash: row.hash, vector: new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)) }))
    }
    const itemsWithHash = hash => prepared('select * from items where hash = ?').all(hash)
    const itemByRef = (source, ref) => prepared('select * from items where source = ? and ref = ?').get(source, ref)
    /** 这一组副本除了自己，调用方还看得到几份。 */
    function copiesOf(source, link, scopes = null) {
        if (link === null) return 0
        if (scopes === null) return prepared('select count(*) as n from items where source = ? and link = ?').get(source, link).n - 1
        return Math.max(0, prepared('select count(*) as n from items where source = ? and link = ? and scope in (select value from json_each(?))').get(source, link, JSON.stringify(scopes)).n - 1)
    }

    /**
     * 全文查询，可见范围和筛选都在 SQL 里，按一组副本的任何一份判断。
     * @param options.match - FTS5 的查询串。
     * @param options.sources - 只查这些来源。
     * @param options.scopes - 看得到的范围；`null` 是全部。
     * @param options.threads - 只看这些时间线；`null` 是全部。
     * @returns 每组一行，是符合条件的那一份（进全文表的那份优先），带 `rank`。
     */
    function query({ match, sources = null, scopes = null, threads = null, refs = null, role, category, since, until, limit = 20 }) {
        const where = ['texts match :match']
        const member = []
        const params = { match, limit }
        if (sources !== null) {
            where.push('i.source in (select value from json_each(:sources))')
            params.sources = JSON.stringify(sources)
        }
        if (scopes !== null) {
            member.push('m.scope in (select value from json_each(:scopes))')
            params.scopes = JSON.stringify(scopes)
        }
        if (threads !== null) {
            member.push('m.thread in (select value from json_each(:threads))')
            params.threads = JSON.stringify(threads)
        }
        // 只要这几条（收藏）：按副本里的任何一份认，交回的就是那一份。
        if (refs !== null) {
            member.push('m.ref in (select value from json_each(:refs))')
            params.refs = JSON.stringify(refs)
        }
        if (role !== undefined) {
            member.push('m.role = :role')
            params.role = role
        }
        if (category !== undefined) {
            member.push('m.category = :category')
            params.category = category
        }
        if (since !== undefined) {
            member.push('m.at >= :since')
            params.since = since
        }
        if (until !== undefined) {
            member.push('m.at < :until')
            params.until = until
        }
        const chosen = `(select m.id from items m where (m.id = i.id or m.copy_of = i.id)${member.map(condition => ` and ${condition}`).join('')} order by m.copy_of is not null, m.id limit 1)`
        const rows = db.prepare(`select ${chosen} as chosen, bm25(texts) as rank from texts join items i on i.id = texts.rowid where ${where.join(' and ')} and chosen is not null order by rank limit :limit`).all(params)
        return rows.map(row => ({ ...prepared('select * from items where id = ?').get(row.chosen), rank: row.rank }))
    }

    const countOf = source => prepared('select count(*) as n from items where source = ?').get(source).n

    /**
     * 每个词出现在这几个来源的多少条里（进全文表的才算，同一次发送正文相同的副本算一条），以及这几个来源一共多少条：算 IDF 用。
     * 一个词一次全文查询，放在 worker 里跑（几十个词就要上百毫秒）。
     */
    function frequencies(terms, sources) {
        const marks = sources.map(() => '?').join(', ')
        const total = prepared(`select count(*) as n from items where source in (${marks}) and copy_of is null`).get(...sources).n
        const one = prepared(`select count(*) as n from texts join items i on i.id = texts.rowid where texts match ? and i.source in (${marks}) and i.copy_of is null`)
        return { total, counts: terms.map(term => one.get(matchAny([term]), ...sources).n) }
    }

    return {
        db, apply, reconcile, cursor, setCursor, fileRow, setFile, dropFile, knownFiles, refsOfFile, transaction,
        hasVector, putVectors, missingVectors, loadVectors, itemsWithHash, itemByRef, copiesOf, query, countOf, frequencies,
        anyOf: matchAny,
        close: () => db.close(),
    }
}
