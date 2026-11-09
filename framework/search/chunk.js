/**
 * 文档切块：按标题切，太长的再按段落切。块由内容决定：改了一处，别的块的内容和哈希都不变，向量可以接着用。
 *
 * @module @loveandbeepbrother/dsh-galatea/search/chunk
 */

import { createHash } from 'node:crypto'

/** 一块最多多少字。向量接口超过 6000 字直接截断，切块要在调用之前。 */
export const MAX_BLOCK_CHARS = 2000

const HEADING = /^(#{1,4})\s+(.*\S)\s*$/

export const blockHash = text => createHash('sha256').update(text, 'utf8').digest('hex')

/** 一段太长时按空行切，还太长就按字数硬切。 */
function splitLong(lines, startLine, limit) {
    const pieces = []
    let current = []
    let currentStart = startLine
    let size = 0
    const flush = () => {
        if (current.length > 0) pieces.push({ line: currentStart, text: current.join('\n') })
        current = []
        size = 0
    }
    lines.forEach((line, index) => {
        const length = Array.from(line).length
        if (length > limit) {
            flush()
            const chars = Array.from(line)
            for (let at = 0; at < chars.length; at += limit) pieces.push({ line: startLine + index, text: chars.slice(at, at + limit).join('') })
            currentStart = startLine + index + 1
            return
        }
        // 到了上限，或者过了一半又遇到空行：在这里断，断点尽量落在段落之间。
        if (size + length + 1 > limit || (line.trim() === '' && size > limit / 2)) {
            flush()
            currentStart = startLine + index
        }
        current.push(line)
        size += length + 1
    })
    flush()
    return pieces
}

/**
 * @param text - 文档全文。
 * @returns `[{ line（从 1 起）, heading（标题链，用 › 连）, text, hash }]`，空块不要。
 */
export function splitBlocks(text, { limit = MAX_BLOCK_CHARS } = {}) {
    const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)
    const sections = []
    const chain = []
    let current = { line: 1, heading: '', lines: [] }
    let fenced = false
    lines.forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
        const match = fenced ? null : HEADING.exec(line)
        if (match !== null) {
            sections.push(current)
            const level = match[1].length
            chain.length = Math.min(chain.length, level - 1)
            chain[level - 1] = match[2]
            current = { line: index + 1, heading: chain.filter(Boolean).join(' › '), lines: [] }
        }
        current.lines.push(line)
    })
    sections.push(current)
    const blocks = []
    for (const section of sections) {
        for (const piece of splitLong(section.lines, section.line, limit)) {
            const body = piece.text.trim()
            if (body === '') continue
            blocks.push({ line: piece.line, heading: section.heading, text: body, hash: blockHash(body) })
        }
    }
    return blocks
}
