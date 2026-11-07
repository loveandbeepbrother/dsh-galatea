#!/usr/bin/env node
/**
 * 外部入口的 stdio MCP 桥：外部 CLI（Claude Code、Codex CLI）把它配置成 MCP 服务，
 * 它把每条 JSON-RPC 消息转给框架核心的工具端点。
 *
 * 用法：`node bridge.mjs --discovery <发现文件> --token-env <环境变量名> [--client 名称] [--instructions <说明文件>]`
 *
 * - 桌面 Host 每次启动端口都变：每次请求重新读发现文件（只有地址、进程号、启动时间），DSH 重启后不用重启客户端。
 * - 令牌从 `--token-env` 指的环境变量读（用户自己的环境变量），不写进 CLI 的配置文件。
 * - DSH 没在运行（发现文件读不到、或者里面的进程不在了）：工具列表用上次的副本（发现文件同目录的
 *   `tools-cache-<名称>.json`），在 stderr 写明原因；调用返回"外部入口没有加载，或者 DSH 没在运行"。
 * - `initialize` 交回的说明取自 `--instructions` 文件（内容由用户写，框架不写死）。
 * - 只读、破坏性的标注（`readOnlyHint`、`destructiveHint`）由端点按工具声明给，桥原样转。
 * - 只依赖 Node 自带模块；直连本机，不经代理。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const option = (flag, fallback) => {
    const index = args.indexOf(flag)
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const discoveryFile = option('--discovery')
const tokenEnv = option('--token-env')
const client = option('--client', 'external')
const instructionsFile = option('--instructions')
if (discoveryFile === undefined || tokenEnv === undefined) {
    process.stderr.write('mind-framework bridge: 需要 --discovery <发现文件> 和 --token-env <环境变量名>\n')
    process.exit(2)
}
const cacheFile = join(dirname(discoveryFile), `tools-cache-${client.replace(/[^\w-]/g, '_')}.json`)
const DOWN = '外部入口没有加载，或者 DSH 没在运行'

function instructions() {
    if (instructionsFile === undefined || !existsSync(instructionsFile)) return undefined
    try {
        return readFileSync(instructionsFile, 'utf8').trim() || undefined
    } catch {
        return undefined
    }
}

/** 读发现文件，核对里面的进程还在；不在时交回原因。 */
function discover() {
    let found
    try {
        found = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    } catch (error) {
        return { down: `${DOWN}（读不到 ${discoveryFile}：${error.message}）` }
    }
    try {
        process.kill(found.pid, 0)
    } catch {
        return { down: `${DOWN}（发现文件里的进程 ${found.pid} 已经不在）` }
    }
    return { url: found.url }
}

function post(url, message) {
    const token = process.env[tokenEnv]
    if (!token) return Promise.reject(new Error(`环境变量 ${tokenEnv} 里没有令牌`))
    return new Promise((resolve, reject) => {
        const target = new URL(url)
        const body = Buffer.from(JSON.stringify(message), 'utf8')
        const call = request({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: 'POST',
            timeout: 11 * 60_000,
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'content-length': body.length,
                'x-mind-framework-client': encodeURIComponent(client),
            },
        }, (response) => {
            const chunks = []
            response.on('data', chunk => chunks.push(chunk))
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                if (text.trim() === '') return resolve(null)
                try {
                    resolve(JSON.parse(text))
                } catch {
                    reject(new Error(`HTTP ${response.statusCode}：${text.slice(0, 200)}`))
                }
            })
        })
        call.on('timeout', () => call.destroy(new Error('DSH 没有及时回应')))
        call.on('error', reject)
        call.end(body)
    })
}

const reply = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

function offline(message, reason) {
    const { id, method, params } = message
    process.stderr.write(`mind-framework bridge: ${reason}\n`)
    if (method === 'initialize') {
        return reply({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'mind-framework', version: '0.1.0' }, ...instructions() === undefined ? {} : { instructions: instructions() } } })
    }
    if (method === 'ping') return reply({ id, result: {} })
    if (method === 'tools/list') {
        let tools = []
        try {
            tools = JSON.parse(readFileSync(cacheFile, 'utf8'))
        } catch {
            process.stderr.write('mind-framework bridge: 也没有工具列表的副本\n')
        }
        return reply({ id, result: { tools } })
    }
    if (method === 'tools/call') return reply({ id, result: { content: [{ type: 'text', text: `${reason}；启动 DSH 后再试。` }], isError: true } })
    return reply({ id, error: { code: -32603, message: reason } })
}

async function handle(message) {
    const where = discover()
    if (where.down !== undefined) {
        if (message.id !== undefined) offline(message, where.down)
        return
    }
    let answer
    try {
        answer = await post(where.url, message)
    } catch (error) {
        if (message.id !== undefined) offline(message, `连不上 DSH（${error.message}）`)
        return
    }
    if (message.id === undefined || answer === null) return
    if (message.method === 'initialize' && answer.result !== undefined) {
        // 桥不转事件流，告诉客户端工具列表不会主动推变化。
        answer.result = { ...answer.result, capabilities: { ...answer.result.capabilities, tools: { listChanged: false } }, ...instructions() === undefined ? {} : { instructions: instructions() } }
    }
    if (message.method === 'tools/list' && Array.isArray(answer.result?.tools)) {
        try {
            writeFileSync(cacheFile, JSON.stringify(answer.result.tools))
        } catch {
            // 副本写不下不影响这一次。
        }
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`)
}

createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === '') return
    let message
    try {
        message = JSON.parse(line)
    } catch {
        return
    }
    handle(message).catch(error => process.stderr.write(`mind-framework bridge: ${error?.message ?? error}\n`))
})
