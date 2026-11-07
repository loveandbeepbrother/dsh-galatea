/**
 * DSH 会话解析用的小件（从旧 memory 插件的 sources.js 搬来，逻辑不变）：内容块的文字、操作摘要。
 *
 * @module @loveandbeepbrother/dsh-galatea/experience/parse
 */

/** 内容块中的可读文字；图片写成占位说明。 */
export function textOfBlocks(content) {
    if (typeof content === 'string') return content.trim()
    const parts = []
    for (const block of content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
        else if (block?.type === 'image') {
            const label = block.attachment?.name
            parts.push(label ? `[图片 ${label}]` : '[图片]')
        }
    }
    return parts.join('\n').trim()
}

/** 只记这些参数：路径、编号、地址、查询与命令开头；正文类参数（content、text、message……）一律不记。 */
const KEY_ARGS = /^(file_path|notebook_path|path|pattern|url|query|to|description|subagent_type|document|ref|sessionId|projectId|taskId|noteId|memoryId|id|command)$|Id$/
const CLIP = 120

const clip = (value, size = CLIP) => {
    const text = String(value).replace(/\s+/g, ' ').trim()
    return Array.from(text).length > size ? `${Array.from(text).slice(0, size).join('')}…` : text
}

/** `mcp__服务__工具` 去掉前缀。 */
export function toolName(name) {
    const text = String(name ?? '?')
    return text.startsWith('mcp__') ? text.split('__').slice(2).join('__') || text : text
}

/**
 * 一次工具调用的操作摘要：工具名与关键参数，可附结果里的编号。
 * @returns `{ tool, detail, link? }`
 */
export function describeOp(name, args, resultIds = []) {
    const tool = toolName(name)
    const parts = []
    if (args !== null && typeof args === 'object') {
        for (const [key, value] of Object.entries(args)) {
            if (!KEY_ARGS.test(key) || value === undefined || value === null || typeof value === 'object') continue
            parts.push(key === 'command' ? clip(String(value).split('\n')[0]) : `${key}=${clip(value)}`)
            if (parts.length >= 3) break
        }
    }
    if (resultIds.length > 0) parts.push(`→ ${resultIds.join(', ')}`)
    return { tool, detail: parts.join(' ') }
}
