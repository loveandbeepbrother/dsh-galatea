/**
 * DSH 拉起的 Claude Code 进程的记录（`<CLAUDE_CONFIG_DIR>/projects/<项目>/<会话>.jsonl`）：执行方注册经历库来源时用的解析。
 * 只取发给别的会话的消息、压缩边界与操作（其余已在 DSH 会话事件里）。记录格式是 Claude Code 的，所以由执行方自己认
 *（编号是 `cc:<记录文件名>:<uuid 或字节位置>`）。
 *
 * @module @loveandbeepbrother/dsh-galatea-agent-sdk/transcript
 */

import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 只记这些参数：路径、编号、地址、查询与命令开头；正文类参数（content、text、message……）一律不记。 */
const KEY_ARGS = /^(file_path|notebook_path|path|pattern|url|query|to|description|subagent_type|document|ref|sessionId|projectId|taskId|noteId|memoryId|id|command)$|Id$/
const CLIP = 120

const clip = (value, size = CLIP) => {
    const text = String(value).replace(/\s+/g, ' ').trim()
    return Array.from(text).length > size ? `${Array.from(text).slice(0, size).join('')}…` : text
}

/** `mcp__服务__工具` 去掉前缀。 */
function toolName(name) {
    const text = String(name ?? '?')
    return text.startsWith('mcp__') ? text.split('__').slice(2).join('__') || text : text
}

/** 工具结果里的编号（记忆、便签、任务、项目、消息）：只看 JSON 顶层名字以 id 结尾的字符串字段。 */
function idsOfResult(result) {
    let value = result
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value)
        } catch {
            return []
        }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
    return Object.entries(value)
        .filter(([key, item]) => /(^id|Id|_id)$/.test(key) && typeof item === 'string' && item.length <= 80)
        .map(([, item]) => item)
        .slice(0, 3)
}

/** `SendMessage` 结果里的消息编号：接收方记录里的 `origin.msg_id` 是同一个。 */
function msgIdOf(entry, text) {
    if (typeof entry.toolUseResult?.msg_id === 'string') return entry.toolUseResult.msg_id
    try {
        const value = JSON.parse(text)
        return typeof value?.msg_id === 'string' ? value.msg_id : undefined
    } catch {
        return undefined
    }
}

/** 工具结果的文字（Claude Code 的 tool_result 内容）。 */
function resultText(content) {
    if (typeof content === 'string') return content
    return (content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

/**
 * 一次工具调用的操作摘要：工具名与关键参数，可附结果里的编号。
 * @returns `{ tool, detail, link? }`
 */
function describeOp(name, args, resultIds = []) {
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

/** 结果里带编号或要据此记一条发出的调用（发消息、助手工具），续读时要等到它的结果。 */
const awaited = call => call.op.tool === 'SendMessage' || /^assistant_/.test(call.op.tool)
/** 等结果最多等这么久（按记录里最新的时间算）：中断后永远没有结果的调用不能把续读位置一直拖住。 */
const STALE_CALL_MS = 3_600_000
/** 会话间转话（渠道的 assistant_session_send）结果末尾的关联编号，接收方的条目带着同一个（渠道包的 assistant_session_send 这样写）。 */
const SESSION_SEND_LINK = /（编号 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})）$/

/**
 * DSH 里那个 Claude Code 进程的记录：只取发给别的会话的消息、压缩边界与操作（其余已在 DSH 会话事件里）。
 * 结果还没写进记录的 `SendMessage` 与助手工具（派任务的结果带任务编号）留到下次：`resume.offset` 停在最早一个还没有结果的调用。
 */
/** 看一份记录有没有停在一轮中途时读尾巴的多少字节。 */
const TAIL_BYTES = 256 * 1024

/**
 * 这份记录是不是停在一轮中途：最后一条说话的条目是用户那边（输入、工具结果），或者助手要调工具。
 * 正常结束的一轮停在助手的 `end_turn` 上（后面可能还有钩子的系统条目，不算）。
 */
export function turnLeftOpen(lines) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        let entry
        try {
            entry = JSON.parse(lines[index])
        } catch {
            continue
        }
        if (entry?.isSidechain === true) continue
        if (entry?.type === 'assistant') return entry.message?.stop_reason !== 'end_turn'
        if (entry?.type === 'user') return true
    }
    return false
}

/**
 * 上次重启打断的轮：`since` 到 `until` 之间写过、归某个会话、又停在一轮中途的记录。
 * DSH 的日志看不到 Claude Code 自己开的一轮（后台任务结束时），Host 正常退出也不留失败记录，所以看记录本身。
 * @param options.owners - Claude Code 对话编号 → `{ sessionId }`。
 * @returns `[{ sessionId, conversation, at }]`。
 */
export async function interruptedTurns({ root, since, until, owners }) {
    const found = []
    for (const project of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!project.isDirectory()) continue
        for (const file of await readdir(join(root, project.name)).catch(() => [])) {
            if (!file.endsWith('.jsonl')) continue
            const conversation = file.slice(0, -'.jsonl'.length)
            const sessionId = owners.get(conversation)?.sessionId
            if (sessionId === undefined) continue
            const path = join(root, project.name, file)
            const { mtimeMs, size } = await stat(path)
            if (mtimeMs < since || mtimeMs > until) continue
            // 只读尾巴：一条记录可能很长，留够几条。
            const handle = await open(path, 'r')
            try {
                const length = Math.min(size, TAIL_BYTES)
                const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length)
                const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
                if (turnLeftOpen(lines)) found.push({ sessionId, conversation, at: mtimeMs })
            } finally {
                await handle.close()
            }
        }
    }
    return found
}

export function createProcessParser({ claudeSessionId }) {
    const entries = []
    const ops = []
    const pending = new Map()
    const id = uuid => `cc:${claudeSessionId}:${uuid}`

    let latest = 0
    function line(entry, offset) {
        if (entry === null || typeof entry !== 'object' || entry.isSidechain || typeof entry.timestamp !== 'string') return
        const at = Date.parse(entry.timestamp)
        if (!Number.isFinite(at)) return
        latest = Math.max(latest, at)
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
            const meta = entry.compactMetadata ?? {}
            entries.push({
                id: id(entry.uuid ?? offset),
                at,
                tie: 0,
                role: 'system',
                kind: '压缩',
                text: `Claude Code 压缩了上下文（${meta.trigger === 'auto' ? '自动' : '手动'}${Number.isFinite(meta.preTokens) ? `，压缩前约 ${meta.preTokens} token` : ''}）`,
            })
            return
        }
        if (entry.type === 'assistant') {
            for (const [index, block] of (entry.message?.content ?? []).entries()) {
                if (block?.type !== 'tool_use') continue
                const op = { id: id(block.id ?? `${offset}:${index}`), at, tie: 0, ...describeOp(block.name, block.input) }
                ops.push(op)
                if (typeof block.id === 'string') pending.set(block.id, { op, at, offset, input: block.input ?? {} })
            }
            return
        }
        if (entry.type !== 'user' || !Array.isArray(entry.message?.content)) return
        for (const block of entry.message.content) {
            if (block?.type !== 'tool_result') continue
            const call = pending.get(block.tool_use_id)
            if (call === undefined) continue
            pending.delete(block.tool_use_id)
            const text = resultText(block.content)
            if (call.op.tool === 'SendMessage') {
                const msgId = msgIdOf(entry, text)
                if (msgId === undefined) continue
                call.op.link = msgId
                call.op.detail = `${call.op.detail} → ${msgId}`
                entries.push({
                    id: id(block.tool_use_id),
                    at: call.at,
                    tie: 0,
                    role: 'out',
                    kind: '发给会话',
                    party: String(call.input.to ?? call.input.recipient ?? '?'),
                    link: msgId,
                    text: String(call.input.message ?? call.input.content ?? ''),
                })
            } else {
                // 会话间转话（渠道的 assistant_session_send）：结果末尾写着关联编号，接收方的条目带着同一个。
                const sent = /assistant_session_send$/.test(call.op.tool) ? SESSION_SEND_LINK.exec(text.trim()) : null
                if (sent !== null) {
                    call.op.link = sent[1]
                    call.op.detail = `${call.op.detail} → ${sent[1]}`.trim()
                    continue
                }
                const ids = idsOfResult(text)
                if (ids.length > 0 && /^assistant_/.test(call.op.tool)) {
                    call.op.detail = `${call.op.detail} → ${ids.join(', ')}`.trim()
                    if (/task_dispatch|project_create/.test(call.op.tool)) call.op.link = ids[0]
                }
            }
        }
    }

    function finish(end) {
        // 只为结果里带编号的调用（SendMessage、派任务等助手工具）等结果：其余工具没有结果也照记操作，不必回头重读。
        const waiting = [...pending.values()].filter(call => awaited(call) && call.at >= latest - STALE_CALL_MS).map(call => call.offset)
        return { entries, ops, resume: { offset: waiting.length > 0 ? Math.min(...waiting) : end } }
    }

    return { line, finish }
}

/** 记录文件开头第一条带 `entrypoint` 的行：`cli` 是用户直接运行的 Claude Code，其余（`sdk-ts` 等）是程序拉起的进程。 */
export async function entrypointOf(path) {
    const handle = await open(path, 'r')
    try {
        const buffer = Buffer.alloc(256 * 1024)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        for (const line of text.split('\n')) {
            const match = /"entrypoint":"([^"]+)"/.exec(line)
            if (match) return match[1]
        }
        return undefined
    } finally {
        await handle.close()
    }
}
