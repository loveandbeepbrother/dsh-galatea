/**
 * 便签的纯逻辑：读和写用同一套解析。
 *
 * - 格式照旧：第一条非空行是 `# 便签`，每条以 `## note-<26 位 ULID>` 开头；代码围栏里的标题算正文；
 *   正文可以有更深的标题，别的一级、二级标题、重复或不合规的编号、不属于任何一条的正文都是格式错误，只报错，不改用户文件。
 * - 写：先按这套解析找到条目的范围，改完的全文再解析一遍，解析不过就拒绝（正文带了一级、二级标题，围栏没闭合，都在这里拦下）。
 *
 * @module @loveandbeepbrother/dsh-galatea/memory/notes
 */

export const NOTES_TITLE = '# 便签'
const NOTES_TITLE_TEXT = '便签'
const NOTE_PREFIX = 'note-'
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const SNIPPET_RADIUS = 60
const SNIPPET_LIMIT = 160
/** 标题行：最多 3 个前导空格加 1–6 个 `#`。 */
const HEADING_PATTERN = /^( {0,3})(#{1,6})(?:[ \t]+(\S(?:.*\S)?))?[ \t]*$/
/** 围栏行：``` 或 ~~~，至少三个。 */
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/

export class NotesError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

function fenceOf(line) {
    const match = FENCE_PATTERN.exec(line)
    if (match === null) return undefined
    const marker = match[2]
    const rest = match[3]
    // 反引号围栏的 info string 不能再带反引号（那是行内代码）。
    if (marker[0] === '`' && rest.includes('`')) return undefined
    return { char: marker[0], length: marker.length, rest }
}

/**
 * 解析便签文件。
 * @param options.closedFences - 要求代码围栏都闭合（写入后的检查用）。
 * @returns `{ notes: [{ id, headingLine, endLine（这一条最后一行，含尾部空行）, startLine, bodyEndLine, text }], lines, eol }`；行号从 1 起。
 * @throws NotesError `NOTES_FORMAT`。
 */
export function parseNotes(text, { label = '便签', closedFences = false } = {}) {
    const source = text.startsWith('﻿') ? text.slice(1) : text
    const eol = source.includes('\r\n') ? '\r\n' : '\n'
    const lines = source.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
    if (lines.length > 0 && lines.at(-1) === '') lines.pop()
    const notes = []
    const seen = new Set()
    let seenTitle = false
    let current
    let fence
    const fail = (detail) => {
        throw new NotesError('NOTES_FORMAT', `${label}格式错误：${detail}`)
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const lineNumber = index + 1
        if (fence !== undefined) {
            const closing = fenceOf(line)
            if (closing !== undefined && closing.char === fence.char && closing.length >= fence.length && closing.rest.trim() === '') fence = undefined
            if (current === undefined) {
                if (line.trim() !== '') fail(`第 ${lineNumber} 行在 ${NOTES_TITLE} 之前出现正文`)
                continue
            }
            current.body.push({ line: lineNumber, text: line })
            continue
        }
        const heading = HEADING_PATTERN.exec(line)
        if (heading !== null) {
            const level = heading[2].length
            const title = heading[3] ?? ''
            if (level === 1) {
                if (seenTitle) fail(`第 ${lineNumber} 行出现第二个一级标题 "${title}"`)
                if (title !== NOTES_TITLE_TEXT) fail(`第一条标题必须是 ${NOTES_TITLE}`)
                seenTitle = true
                continue
            }
            if (level === 2) {
                if (!seenTitle) fail(`第 ${lineNumber} 行在 ${NOTES_TITLE} 之前出现条目`)
                if (!title.startsWith(NOTE_PREFIX)) fail(`第 ${lineNumber} 行出现不属于任何便签的二级标题 "${title}"`)
                if (!ULID_PATTERN.test(title.slice(NOTE_PREFIX.length))) fail(`第 ${lineNumber} 行的便签编号 "${title}" 不合规`)
                if (seen.has(title)) fail(`便签编号 "${title}" 重复`)
                seen.add(title)
                if (current !== undefined) current.endLine = lineNumber - 1
                current = { id: title, headingLine: lineNumber, endLine: lines.length, body: [] }
                notes.push(current)
                continue
            }
            if (current === undefined) fail(`第 ${lineNumber} 行出现不属于任何便签的标题 "${title}"`)
            current.body.push({ line: lineNumber, text: line })
            continue
        }
        const fenceStart = fenceOf(line)
        if (fenceStart !== undefined) {
            fence = { char: fenceStart.char, length: fenceStart.length }
            if (current === undefined) {
                if (line.trim() !== '') fail(`第 ${lineNumber} 行在 ${NOTES_TITLE} 之前出现正文`)
                continue
            }
            current.body.push({ line: lineNumber, text: line })
            continue
        }
        if (current === undefined) {
            if (!seenTitle) {
                if (line.trim() === '') continue
                fail(`第一条非空行必须是 ${NOTES_TITLE}，实际是 "${line.trim()}"`)
            }
            if (line.trim() !== '') fail(`第 ${lineNumber} 行的正文不属于任何便签`)
            continue
        }
        current.body.push({ line: lineNumber, text: line })
    }
    // 读的时候没闭合的围栏按 Markdown 延续到文件末尾（和旧的读取端一样）；写入后的检查要求闭合。
    if (fence !== undefined && closedFences) fail('最后一个代码围栏没有闭合')
    if (!seenTitle && lines.some(line => line.trim() !== '')) fail(`缺少 ${NOTES_TITLE}`)
    return { notes: notes.map(finalize), lines, eol }
}

/** 去掉条目正文首尾的空行，保留真实行号。 */
function finalize(note) {
    const body = note.body
    let first = 0
    let last = body.length - 1
    while (first <= last && body[first].text.trim() === '') first += 1
    while (last >= first && body[last].text.trim() === '') last -= 1
    const kept = first <= last ? body.slice(first, last + 1) : []
    return {
        id: note.id,
        headingLine: note.headingLine,
        endLine: note.endLine,
        startLine: kept.length > 0 ? kept[0].line : note.headingLine,
        bodyEndLine: kept.length > 0 ? kept.at(-1).line : note.headingLine,
        text: kept.map(entry => entry.text).join('\n'),
    }
}

/**
 * 改便签文件：`add`（编号由调用方给）、`update`、`remove`。改完的全文再解析一遍，不过就抛错，文件不动。
 * @returns 新的全文。
 */
export function editNotes(text, { action, noteId, body }) {
    const parsed = parseNotes(text === '' ? `${NOTES_TITLE}\n` : text)
    const lines = parsed.lines.length === 0 ? [NOTES_TITLE] : [...parsed.lines]
    const bodyLines = String(body ?? '').trim().split(/\r?\n/)
    let next
    if (action === 'add') {
        if (parsed.notes.some(note => note.id === noteId)) throw new NotesError('NOTES_CONFLICT', `便签里已经有 ${noteId}`)
        while (lines.length > 1 && lines.at(-1).trim() === '') lines.pop()
        next = [...lines, '', `## ${noteId}`, '', ...bodyLines]
    } else {
        const note = parsed.notes.find(item => item.id === noteId)
        if (note === undefined) throw new NotesError('NOTE_MISSING', `便签里没有 ${noteId}`)
        const replacement = action === 'update' ? [`## ${noteId}`, '', ...bodyLines, ''] : []
        next = [...lines.slice(0, note.headingLine - 1), ...replacement, ...lines.slice(note.endLine)]
        while (next.length > 1 && next.at(-1).trim() === '') next.pop()
    }
    const out = next.join(parsed.eol) + parsed.eol
    let check
    try {
        check = parseNotes(out, { closedFences: true })
    } catch (error) {
        throw new NotesError('NOTES_BODY', `改完的便签解析不过，没有写入：${error.message.replace(/^便签格式错误：/, '')}（正文里不能有一级、二级标题，代码围栏要闭合）`)
    }
    const expected = parsed.notes.length + (action === 'add' ? 1 : action === 'remove' ? -1 : 0)
    if (check.notes.length !== expected) throw new NotesError('NOTES_BODY', '改完的便签条数不对，没有写入（正文里不能有 ## note- 开头的行）')
    return out
}

/* ------------------------------------------------------------------ 检索、读取的辅助 */

function literalPattern(query) {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
}

/** 全部字面命中（不分大小写）。 */
export function literalRanges(text, query) {
    const pattern = literalPattern(query)
    const ranges = []
    let match
    while ((match = pattern.exec(text)) !== null) {
        ranges.push({ index: match.index, length: match[0].length })
        if (match[0].length === 0) pattern.lastIndex += 1
    }
    return ranges
}

/** 以命中为中心截一段，按码点截，不切坏字。 */
export function snippetAround(text, index, length) {
    const chars = Array.from(text)
    const before = Array.from(text.slice(0, index)).length
    const hitLength = Array.from(text.slice(index, index + length)).length
    const start = Math.max(0, before - SNIPPET_RADIUS)
    const end = Math.min(chars.length, before + hitLength + SNIPPET_RADIUS)
    let snippet = chars.slice(start, end).join('')
    if (Array.from(snippet).length > SNIPPET_LIMIT) snippet = Array.from(snippet).slice(0, SNIPPET_LIMIT).join('')
    return `${start > 0 ? '…' : ''}${snippet}${end < chars.length ? '…' : ''}`
}

export function excerpt(text) {
    const chars = Array.from(text)
    const head = chars.slice(0, SNIPPET_LIMIT).join('')
    return chars.length > SNIPPET_LIMIT ? `${head}…` : head
}

/** 按码点取一个窗口，写明全长和下一段从哪起。 */
export function textWindow(text, offset, maxCharacters) {
    const chars = Array.from(text)
    if (offset > chars.length) throw new NotesError('INVALID_ARGUMENT', `offset ${offset} 超出正文长度 ${chars.length}`)
    const end = Math.min(chars.length, offset + maxCharacters)
    return { text: chars.slice(offset, end).join(''), offset, maxCharacters, totalCharacters: chars.length, ...end < chars.length ? { nextOffset: end } : {} }
}
