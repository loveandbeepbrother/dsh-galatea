/**
 * 经历库读文件的小件（从旧 memory 插件的 stores.js 搬来，逻辑不变）：按行增量读 JSON 记录文件、读记录文件的入口。
 *
 * @module @loveandbeepbrother/dsh-galatea/experience/files
 */

import { open, stat } from 'node:fs/promises'

/**
 * 按行追加的 JSON 文件（发件记录、上下文标记）的增量读取：记住读到的字节位置，每次只读新增的完整行，
 * 末尾的半行留到下次。文件变短（被清空或换掉）时从头重读，并在结果里说明。不存在当作空。
 * @returns `read() → { lines, reset }`；`rewind()` 回到文件开头（整体重建时用）。
 */
export function jsonTail(path) {
    let offset = 0
    return {
        async read() {
            let size
            try {
                size = (await stat(path)).size
            } catch {
                const reset = offset > 0
                offset = 0
                return { lines: [], reset }
            }
            let reset = false
            if (size < offset) {
                offset = 0
                reset = true
            }
            if (size === offset) return { lines: [], reset }
            const lines = []
            const { end } = await readLines(path, offset, entry => lines.push(entry), { skip: false })
            offset = end
            return { lines, reset }
        },
        rewind() {
            offset = 0
        },
    }
}

/** 记录文件中明显用不上、又可能很大的行（请求快照、文件历史），不必解析。 */
const SKIPPED = /^{"type":"(api-request[a-z-]*|file-history[a-z-]*|queue-operation|atis-latch|last-prompt|mode|permission-mode|cost-state|tools-used)"/
/** 判断要不要跳过时看行首这么多字节。 */
const HEAD = 48
/** 单行上限：超过的行（例如带大图的工具结果）整行丢弃，不为它攒内存。 */
export const MAX_LINE = 32 * 1024 * 1024

/**
 * 从 `offset` 起按行读 JSON 记录文件，分块读取，不把整个文件放进内存。只交出完整的行。
 *
 * 要跳过的行（请求快照等，可能上百 MB）一看行首就认出，其余字节边读边丢，不累积、不拷贝；
 * 要解析的行先把各块的片段收着，行结束时只拼一次。超过 `maxLine` 的行同样边读边丢。
 * @param onLine - `(entry, offset)`，`offset` 是这行开头的字节位置。
 * @param options.skip - 是否按行首跳过记录文件里用不上的行（默认是）。
 * @returns `{ end, size }`：`end` 是最后一个完整行之后的位置。
 */
export async function readLines(path, offset, onLine, { chunk = 4 * 1024 * 1024, skip = true, maxLine = MAX_LINE } = {}) {
    const { size } = await stat(path)
    const handle = await open(path, 'r')
    let position = offset
    let lineStart = offset
    let parts = []
    let length = 0
    /** 当前这行：undefined 还没看出来，true 丢弃，false 保留。 */
    let dropping
    try {
        while (position < size) {
            // 每块用新的缓冲区：保留中的行片段引用着它。
            const buffer = Buffer.allocUnsafe(Math.min(chunk, size - position))
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
            if (bytesRead === 0) break
            const base = position
            position += bytesRead
            let from = 0
            while (from < bytesRead) {
                const newline = buffer.indexOf(10, from)
                const stop = newline === -1 || newline >= bytesRead ? bytesRead : newline
                if (dropping !== true) {
                    parts.push(buffer.subarray(from, stop))
                    length += stop - from
                    if (dropping === undefined && (length >= HEAD || stop < bytesRead)) {
                        const head = (parts.length === 1 ? parts[0] : Buffer.concat(parts, length)).subarray(0, HEAD).toString('latin1')
                        dropping = skip && SKIPPED.test(head)
                    }
                    if (length > maxLine) dropping = true
                    if (dropping === true) {
                        parts = []
                        length = 0
                    }
                }
                if (stop === bytesRead) break
                if (dropping !== true) {
                    const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, length)
                    let entry
                    try {
                        entry = JSON.parse(line.toString('utf8'))
                    } catch {
                        entry = undefined
                    }
                    if (entry !== undefined && entry !== null) onLine(entry, lineStart)
                }
                parts = []
                length = 0
                dropping = undefined
                lineStart = base + stop + 1
                from = stop + 1
            }
        }
    } finally {
        await handle.close()
    }
    return { end: lineStart, size }
}
