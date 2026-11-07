/**
 * 具体记忆的纯逻辑：编号、文件格式（和旧的 mind-writes 相同，已有的记忆文件照样读得出）、记忆目录和它的变更说明。
 *
 * @module @loveandbeepbrother/dsh-galatea/memory/store
 */

import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const MEMORY_ID = /^mem-[0-7][0-9A-HJKMNP-TV-Z]{25}$/
export const NOTE_ID = /^note-[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/** 26 位 Crockford ULID。 */
export function ulid(now = Date.now(), random = randomBytes(16)) {
    let time = ''
    let rest = now
    for (let index = 0; index < 10; index += 1) {
        time = CROCKFORD[rest % 32] + time
        rest = Math.floor(rest / 32)
    }
    let tail = ''
    for (let index = 0; index < 16; index += 1) tail += CROCKFORD[random[index] % 32]
    return time + tail
}

const SCALAR_KEYS = ['title', 'summary', 'scope', 'project', 'created', 'updated']
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 具体记忆文件：头部字段、来源列表、正文。 */
export function formatMemory(memory) {
    const lines = ['---']
    for (const key of SCALAR_KEYS) {
        if (memory[key] !== undefined && memory[key] !== null) lines.push(`${key}: ${oneLine(memory[key])}`)
    }
    lines.push('sources:')
    for (const source of memory.sources) lines.push(`  - ${oneLine(source)}`)
    lines.push('---', '', String(memory.body).trim(), '')
    return lines.join('\n')
}

/** 解析具体记忆文件；用户手改后字段缺了也尽量保留能用的部分。没有文件头时 `ok` 为 false。 */
export function parseMemory(text) {
    const normalized = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n')
    const memory = { sources: [], body: normalized.trim(), ok: false }
    if (!normalized.startsWith('---\n')) return memory
    const end = normalized.indexOf('\n---', 4)
    if (end < 0) return memory
    let inSources = false
    for (const line of normalized.slice(4, end).split('\n')) {
        const item = /^\s+-\s+(.*)$/.exec(line)
        if (inSources && item !== null) {
            memory.sources.push(item[1].trim())
            continue
        }
        const field = /^(\w+):\s*(.*)$/.exec(line)
        if (field === null) continue
        inSources = field[1] === 'sources'
        if (SCALAR_KEYS.includes(field[1])) memory[field[1]] = field[2].trim()
    }
    memory.body = normalized.slice(normalized.indexOf('\n', end + 1) + 1).trim()
    memory.ok = true
    return memory
}

/** 一条记忆在目录里的那一行。 */
export function indexLine(memory) {
    const where = memory.scope === 'global' ? '' : `［${memory.project ?? '本项目'}］`
    return `- ${memory.id} ${where}${memory.title ?? '（无标题）'}：${memory.summary ?? ''}`
}

/**
 * 记忆目录：给定的记忆（已经按范围筛好）按最近更新列出，超过 `limit` 字就截断并注明。
 * @returns 目录正文；一条都没有时是空串。
 */
export function indexText(memories, limit) {
    const visible = [...memories].sort((left, right) => String(right.updated ?? '').localeCompare(String(left.updated ?? '')))
    if (visible.length === 0) return ''
    const head = `具体记忆（共 ${visible.length} 条，按最近更新列出；需要时用 assistant_memory_read 读全文与来源，assistant_memory_search 按关键词查找）：`
    const lines = [head]
    let size = head.length
    let shown = 0
    for (const memory of visible) {
        const line = indexLine(memory)
        if (size + line.length > limit && shown > 0) break
        lines.push(line)
        size += line.length
        shown += 1
    }
    if (shown < visible.length) lines.push(`（另有 ${visible.length - shown} 条较早的记忆未列出，可用关键词检索。）`)
    return lines.join('\n')
}

/** 目录里列出的各条：编号 → 那一行。目录是本模块自己写的，按自己的格式拆。 */
export function listedLines(text) {
    const lines = new Map()
    for (const line of String(text ?? '').split('\n')) {
        const match = /^- (mem-\S+) /.exec(line)
        if (match !== null) lines.set(match[1], line)
    }
    return lines
}

/**
 * 两版目录的变更说明（核心的段 `onChange`）：按编号比，区分新增或修改、删掉了、被挤出目录（还在，只是没列出）。
 * @param exists - 某个编号的记忆现在还在不在。
 */
export function describeIndexChange(previous, next, exists) {
    const before = listedLines(previous)
    const after = listedLines(next)
    const changed = [...after].filter(([id, line]) => before.get(id) !== line).map(([, line]) => line.replace(/^- /, ''))
    const gone = [...before.keys()].filter(id => !after.has(id))
    const removed = gone.filter(id => !exists(id))
    const pushedOut = gone.filter(id => exists(id))
    const parts = []
    if (changed.length > 0) parts.push(`新增或修改：\n${changed.map(line => `- ${line}`).join('\n')}`)
    if (removed.length > 0) parts.push(`已删掉：${removed.join('、')}`)
    if (pushedOut.length > 0) parts.push(`目录满了没再列出（记忆还在，可以检索）：${pushedOut.join('、')}`)
    if (parts.length === 0) return '（DSH 提示，不是用户发言）记忆目录的说明变了，条目没变。'
    return `（DSH 提示，不是用户发言）记忆目录有变化。${parts.join('\n')}`
}
