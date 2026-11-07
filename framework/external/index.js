/**
 * 外部入口：让外部 CLI（Claude Code、Codex CLI）连进来调框架的工具、给会话发话。
 *
 * - 登记和令牌归核心（`core.external`，只走主人的设置页路由）；这里只管桥、发现文件和给用户抄进 CLI 配置的那一段。
 * - **发现文件**（配置 `discoveryFile`，默认 DSH home 下的 `galatea/endpoint.json`）：只写核心工具端点的地址、进程号、启动时间，每次启动重写，卸下时删掉
 *   （进程号是自己的才删）。桥每次请求读它。
 * - **桥**是 `bridge.mjs`（stdio MCP），令牌从环境变量读；`bridgeConfig(name)` 交回 Claude Code、Codex 两种写法，
 *   里面只有环境变量名，没有令牌（令牌只在登记那一次的返回里出现）。设置页另有一条主人路由取它。
 * - **给会话发话** `assistant_external_say({ to?, text })`：经 `core.deliver`，说话人是外部调用方的名字，`to` 默认中枢。
 *   这是一处策略变化（今天的默认工具里有意不放），所以只有登记时在 `tools` 里写了它的外部调用方能用。
 * - 安全边界按单用户算：令牌用来认出是谁、能用哪些工具，不当安全屏障；不查数据目录权限。
 *
 * @module @loveandbeepbrother/dsh-galatea/external
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ROUTE_PREFIX } from '../core/external.js'

export const name = 'mind-framework-external'
export const inject = ['core']
export const SAY_TOOL = 'assistant_external_say'
export const SAY_SOURCE = 'external-say'
export const BRIDGE = fileURLToPath(new URL('./bridge.mjs', import.meta.url))

export const Config = Schema.object({
    discoveryFile: Schema.string().default('').description('发现文件（绝对路径）；空就用 DSH home 下的 galatea/endpoint.json'),
    tokenEnvPrefix: Schema.string().default('MIND_FRAMEWORK_TOKEN_').description('令牌所在环境变量名的前缀，后面接大写的登记名'),
    instructionsFile: Schema.string().default('').description('桥交给 CLI 的说明文件（绝对路径，内容由用户写）'),
})

/** 登记名对应的环境变量名。 */
export const tokenEnvOf = (prefix, callerName) => `${prefix}${callerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

/**
 * 给用户抄进 CLI 配置的一段：Claude Code 的 MCP 配置（JSON）、Codex 的 `config.toml`。
 * @param options.node - Node 的路径（默认当前进程的）。
 */
export function bridgeConfigOf(callerName, { discoveryFile, tokenEnv, instructionsFile = '', node = process.execPath }) {
    const args = [BRIDGE, '--discovery', discoveryFile, '--token-env', tokenEnv, '--client', callerName, ...instructionsFile ? ['--instructions', instructionsFile] : []]
    const claudeCode = JSON.stringify({ mcpServers: { [`mind-${callerName}`]: { type: 'stdio', command: node, args } } }, null, 2)
    const toml = value => JSON.stringify(value)
    const codex = [
        `[mcp_servers.mind-${callerName}]`,
        `command = ${toml(node)}`,
        `args = [${args.map(toml).join(', ')}]`,
        `env_vars = [${toml(tokenEnv)}]`,
    ].join('\n')
    return {
        tokenEnv,
        claudeCode,
        codex,
        note: `把登记时拿到的令牌放进用户环境变量 ${tokenEnv}（不要写进配置文件），再把下面一段抄进对应的配置。`,
    }
}

export async function apply(ctx, config) {
    const core = ctx.core
    // 发现文件：没配就放在 DSH home 下，和内容库在一处；桥按它找核心的工具端点。
    const discoveryFile = config.discoveryFile === '' ? dshHomePath('galatea', 'endpoint.json') : config.discoveryFile

    function bridgeConfig(callerName) {
        if (!core.external.list().some(item => item.name === callerName)) throw new Error(`没有登记外部调用方 ${callerName}`)
        return bridgeConfigOf(callerName, { discoveryFile, tokenEnv: tokenEnvOf(config.tokenEnvPrefix, callerName), instructionsFile: config.instructionsFile })
    }

    /* ------------------------------------------------------------------ 发现文件 */

    {
        const url = await core.toolEndpoint.address()
        const body = JSON.stringify({ url, pid: process.pid, startedAt: new Date().toISOString() })
        const temporary = `${discoveryFile}.${randomUUID()}.tmp`
        await mkdir(dirname(discoveryFile), { recursive: true })
        await writeFile(temporary, body)
        await rename(temporary, discoveryFile)
        ctx.effect(() => () => {
            // 只删自己写的：别的 Host 进程可能已经写了新的。
            readFile(discoveryFile, 'utf8')
                .then(text => (JSON.parse(text).pid === process.pid ? rm(discoveryFile, { force: true }) : undefined))
                .catch(() => {})
        }, 'mind-framework-external: discovery file')
    }

    ctx.provide('externalEntry', { bridgeConfig, discoveryFile })

    // 设置页的主人路由：取某个登记名的配置片段（登记、作废在核心的路由上）。
    ctx.inject(['connection'], (sub) => {
        const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
        const dispose = sub.connection.fetch.register({
            path: `${ROUTE_PREFIX}/bridge-config`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
                try {
                    const payload = await request.json()
                    return json(200, bridgeConfig(String(payload?.name ?? '')))
                } catch (error) {
                    return json(400, { error: error?.message ?? String(error) })
                }
            },
        })
        sub.effect(() => dispose, 'mind-framework-external: bridge-config route')
    })

    /* ------------------------------------------------------------------ 给会话发话 */

    ctx.effect(() => core.declareSource(SAY_SOURCE, { intent: 'prompt', annotate: true }), 'mind-framework-external: say source')
    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
    // 只有登记时在 tools 里写了它的外部调用方能用（默认的一组里不放）。
    const granted = who => who?.kind === 'external' && !who.readOnly
        && (core.external.list().find(item => item.name === who.name)?.tools ?? []).includes(SAY_TOOL)
    core.tool(defineTool({
        name: SAY_TOOL,
        description: 'Put a message into a DSH session (the hub session by default), marked as coming from you, not from the user. The session answers in its own turn; the answer is not sent back to you.',
        parameters: {
            text: { type: 'string', required: true, description: 'What to say.' },
            to: { type: 'string', description: 'Session id; the hub session when omitted.' },
        },
        output,
        execute: async (args, exec) => {
            const who = core.caller(exec)
            const body = String(args?.text ?? '').trim()
            if (body === '') throw new Error('text 不能为空')
            const key = `external-${who.name}-${randomUUID()}`
            const result = await core.deliver(String(args?.to ?? 'hub'), { key, text: body, source: { kind: SAY_SOURCE, key }, speaker: { kind: 'external', name: who.name }, link: key })
            return JSON.stringify({ status: result.status, ...result.reason === undefined ? {} : { reason: result.reason }, link: key }, null, 1)
        },
    }), { effect: 'write', allow: granted })
}

