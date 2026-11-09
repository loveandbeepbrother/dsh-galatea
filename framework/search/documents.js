/**
 * 文档进索引：白名单目录里的 .md、.txt，按标题切块。修改时间和大小没变的不读，文件改了重算，删了同步删。
 * 在 worker 里跑，同步读文件不挡 Host。
 *
 * @module @loveandbeepbrother/dsh-galatea/search/documents
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { splitBlocks } from './chunk.js'
import { stripSecrets } from './tokens.js'

const EXTENSIONS = new Set(['.md', '.txt'])
/** 太大的文件多半是导出物，不是写给人读的文档。 */
const MAX_FILE_BYTES = 5_000_000

/** 引用：路径加块的内容哈希，同一文件里重复的块加序号。 */
const refOf = (path, hash, occurrence) => `${path}#${hash.slice(0, 16)}${occurrence === 0 ? '' : `-${occurrence}`}`

function* walk(path, excluded) {
    if (!existsSync(path) || excluded(path)) return
    const info = statSync(path)
    if (info.isFile()) {
        if (EXTENSIONS.has(extname(path).toLowerCase()) && info.size <= MAX_FILE_BYTES) yield { path, info }
        return
    }
    for (const name of readdirSync(path)) yield* walk(join(path, name), excluded)
}

/** 一个文件切成要写进索引的行。 */
function itemsOf(path, mtime, entry) {
    const seen = new Map()
    return splitBlocks(readFileSync(path, 'utf8')).map((block) => {
        const occurrence = seen.get(block.hash) ?? 0
        seen.set(block.hash, occurrence + 1)
        return {
            source: 'documents',
            ref: refOf(path, block.hash, occurrence),
            scope: entry.scopeKey,
            at: mtime,
            title: block.heading === '' ? entry.label : `${entry.label}：${block.heading}`,
            location: `${path}:${block.line}`,
            hash: block.hash,
            text: `${block.heading}\n${block.text}`,
            wantsVector: entry.vectors === true,
        }
    })
}

/**
 * 扫一遍。
 * @param store - `openStore` 的结果。
 * @param options.entries - `[{ path, label, scopeKey, vectors? }]`。
 * @param options.exclude - 路径含这些的不进（正则串）。
 * @returns `{ files, changed, removed }`。
 */
export function scanDocuments(store, { entries, exclude = [] }) {
    const patterns = exclude.map(text => new RegExp(text, 'i'))
    const excluded = path => patterns.some(pattern => pattern.test(path))
    const present = new Set()
    let changed = 0
    let removed = 0
    for (const entry of entries) {
        for (const { path, info } of walk(entry.path, excluded)) {
            present.add(path)
            const known = store.fileRow(path)
            const mtime = Math.trunc(info.mtimeMs)
            if (known !== undefined && known.mtime === mtime && known.size === info.size) continue
            const items = itemsOf(path, mtime, entry)
            const keep = new Set(items.map(item => item.ref))
            const removes = store.refsOfFile(path).filter(ref => !keep.has(ref))
            store.apply({ upserts: items, source: 'documents', removes })
            store.setFile(path, mtime, info.size)
            changed += 1
            removed += removes.length
        }
    }
    for (const path of store.knownFiles()) {
        if (present.has(path)) continue
        const removes = store.refsOfFile(path)
        store.apply({ source: 'documents', removes })
        store.dropFile(path)
        removed += removes.length
    }
    return { files: present.size, changed, removed }
}

/**
 * 还没有向量的块的原文（重读文件，全文表不存原文）。文件没了或块变了的跳过，下次扫描会清掉。
 * 这些文字要发给向量接口，令牌形状的长串在这里去掉。
 * @returns `[{ hash, text }]`。
 */
export function missingVectorTexts(store, { model, limit }) {
    const wanted = store.missingVectors(model, limit)
    const byFile = new Map()
    for (const row of wanted) {
        const path = row.location.slice(0, row.location.lastIndexOf(':'))
        byFile.set(path, [...byFile.get(path) ?? [], row.hash])
    }
    const texts = new Map()
    for (const [path, hashes] of byFile) {
        if (!existsSync(path)) continue
        const need = new Set(hashes)
        for (const block of splitBlocks(readFileSync(path, 'utf8'))) {
            if (need.has(block.hash) && !texts.has(block.hash)) texts.set(block.hash, stripSecrets(`${block.heading}\n${block.text}`))
        }
    }
    return [...texts].map(([hash, text]) => ({ hash, text }))
}
