/**
 * 框架测试的真实设施：Cordis、官方 Session / 投影 / JSONL 持久化 / 查询、storage / storage-json / storageDomain、
 * 官方 Agent 注册表与 AgentLoop、preset 注册表、Tools 与原生工具执行器。唯一假的是模型提供方
 * （development_fake 路由，按用例脚本应答，不联网）。装配顺序照持续工作的原生回归。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import * as LoaderModule from '@deepseek-ai/cordis-plugin-loader'
import * as GroupModule from '@deepseek-ai/cordis-plugin-group'
import * as LlmModule from '@deepseek-ai/dsh-llm'
import * as SessionModule from '@deepseek-ai/dsh-session'
import * as SessionProjectionModule from '@deepseek-ai/dsh-session-projection'
import * as SessionQueryModule from '@deepseek-ai/dsh-session-query'
import * as SessionPersistenceJsonlModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SystemPromptModule from '@deepseek-ai/dsh-system-prompt'
import * as ToolsModule from '@deepseek-ai/dsh-tools'
import * as ToolExecutorNativeModule from '@deepseek-ai/dsh-tool-executor-native'
import * as AgentModule from '@deepseek-ai/dsh-agent'
import * as AgentLoopModule from '@deepseek-ai/dsh-agent-loop'
import * as AgentPresetsModule from '@deepseek-ai/dsh-agent-preset-registry'
import * as StorageModule from '@deepseek-ai/dsh-storage'
import * as StorageJsonModule from '@deepseek-ai/dsh-storage-json'
import * as StorageDomainModule from '@deepseek-ai/dsh-storage-domain'
import * as WorkspaceModule from '@deepseek-ai/dsh-workspace'
import * as TypertRegistryModule from '@deepseek-ai/dsh-typert-registry'
import * as AttachmentLocalModule from '@deepseek-ai/dsh-attachment-local'
import * as FsModule from '@deepseek-ai/dsh-fs'
import * as RemoteAccessModule from '@deepseek-ai/dsh-api-remote-access'
import * as AgentDefaultModelModule from '@deepseek-ai/dsh-agent-default-model'
import * as ApiGatewayModule from '@deepseek-ai/dsh-api-gateway'
import * as SessionControllerModule from '@deepseek-ai/dsh-api-session-controller'
import * as TokenMeterModule from '@deepseek-ai/dsh-token-meter'
import * as GoalModule from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriverModule from '@deepseek-ai/dsh-goal-round-driver'
import * as ToolGoalModule from '@deepseek-ai/dsh-tool-goal'

import * as CoreModule from '../core/index.js'

export const { SessionId } = SessionModule
export const { createUserMessage } = LlmModule
export const ROUTE = Object.freeze({ provider: 'development_fake-framework', model: 'framework-model-1' })
const PRESET = 'plain-preset'

function pluginOf(module) {
    return module.default ?? module
}

/** 带超时的等待。 */
export async function withTimeout(promise, label, ms = 20000) {
    let timer
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        clearTimeout(timer)
    }
}

/** 轮询等待一个异步事实成立。 */
export async function waitFor(predicate, label, attempts = 100) {
    for (let index = 0; index < attempts; index += 1) {
        if (await predicate()) return
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`timeout: ${label}`)
}

/** 一段立即结束的文本回复。 */
export function* textReply(text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
}

/** development_fake 提供方：按顺序消费用例脚本，没有脚本时回 "ok"；记下每次请求。 */
class FakeAdapter extends LlmModule.LlmAdapter {
    requests = []
    scripts = []

    /** 设了就报给上游的上下文窗口（压缩引擎按它算阈值）。 */
    contextWindow = undefined

    async resolveModel(provider, model) {
        return { provider, id: model, name: model, ...this.contextWindow === undefined ? {} : { context: { contextWindow: this.contextWindow } } }
    }

    async * stream(options) {
        this.requests.push(options)
        const script = this.scripts.shift()
        if (script !== undefined) {
            yield* script(options)
            return
        }
        yield* textReply('ok')
    }
}

function presetPlugin(id) {
    return {
        name: `test-preset-${id}`,
        inject: ['agentPresets'],
        async* apply(child) {
            yield await child.agentPresets.register({ id, plugins: [] })
        },
    }
}

async function disposeRoot(ctx) {
    if (typeof ctx.dispose === 'function') {
        await ctx.dispose()
        return
    }
    if (typeof ctx.fiber?.dispose === 'function') await ctx.fiber.dispose()
}

/**
 * 搭一套真实设施。
 * @param options.root - 共用的持久目录（重启用例）；不给就新建一个临时目录，收尾时删掉。
 * @param options.core - `false` 时先不装核心（用 `h.mountCore()` 稍后装）。
 * @param options.controller - 装上游真实的 `sessionController`（会话不在内存里时的恢复路径要用）。
 * @param options.tokenMeter - 装上游真实的 `tokenMeter`（压缩引擎要用）。
 * @param options.goal - 装上游真实的 Goal（服务、轮次驱动、Goal 工具；持续工作要用）。
 * @param options.sessionsRoot - 会话日志的目录（量本机日志的副本时用），`options.compression` 它的压缩方式。
 */
export async function makeHarness(t, options = {}) {
    const root = options.root ?? await mkdtemp(join(tmpdir(), 'mind-framework-'))
    const ownsRoot = options.root === undefined
    const home = join(root, 'home')
    const workDirectory = join(root, 'work')
    await mkdir(join(home, 'storages'), { recursive: true })
    await mkdir(workDirectory, { recursive: true })

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(join(root, 'plugins/')).href
    const fibers = []
    const mount = async (plugin, config) => {
        const fiber = await ctx.plugin(plugin, config)
        fibers.push(fiber)
        return fiber
    }

    await mount(pluginOf(LoaderModule))
    ctx.loader.builtins.group = pluginOf(GroupModule)
    await mount(pluginOf(LlmModule))
    await mount(pluginOf(SessionModule))
    await mount(pluginOf(SessionProjectionModule))
    await mount(pluginOf(SystemPromptModule), { personaPrefix: '' })
    await mount(pluginOf(ToolsModule))
    await mount(pluginOf(ToolExecutorNativeModule))
    await mount(pluginOf(SessionPersistenceJsonlModule), { root: options.sessionsRoot ?? join(home, 'sessions'), compression: options.compression ?? 'none' })
    await mount(pluginOf(StorageModule))
    await mount(pluginOf(StorageJsonModule), { root: join(home, 'storages') })
    await mount(pluginOf(StorageDomainModule), { backend: 'json' })
    await mount(pluginOf(SessionQueryModule))
    await mount(pluginOf(AgentModule))
    await mount(pluginOf(AgentLoopModule), { agents: [] })
    await mount(pluginOf(AgentPresetsModule), { default: PRESET })
    await mount(presetPlugin(PRESET))
    if (options.controller === true) {
        await mount(pluginOf(WorkspaceModule))
        await mount(pluginOf(TypertRegistryModule))
        await mount(pluginOf(AttachmentLocalModule), { dshHome: home })
        await mount(pluginOf(FsModule))
        await mount(pluginOf(RemoteAccessModule))
        await mount(pluginOf(AgentDefaultModelModule), { ...ROUTE })
        // 上游的 fileUploads 要网关的 commands、connection：只给个替身（控制器启动时登记解析函数、prompt 时绑定上传的文件，这里都没有文件），其余都是真的。
        await mount({
            name: 'test-file-uploads-placeholder',
            apply(child) {
                child.provide('fileUploads', {
                    registerAgentResolver: () => () => {},
                    // 经控制器 prompt 时要用：这里没有上传的文件，绑定什么也不做。
                    bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
                    retirePrompt() {},
                })
            },
        })
        // 0.2.2 起会话控制器要 typertGateway（由 api-gateway 提供）；更早的版本不要，装上也无妨。
        await mount(pluginOf(ApiGatewayModule))
        await mount(pluginOf(SessionControllerModule), { nativeOpen: false })
    }

    if (options.tokenMeter === true) await mount(pluginOf(TokenMeterModule))
    if (options.goal === true) {
        await mount(pluginOf(GoalModule))
        await mount(pluginOf(GoalRoundDriverModule))
        await mount(pluginOf(ToolGoalModule))
    }

    const adapter = new FakeAdapter()
    ctx.llm.registerAdapter([ROUTE.provider], adapter)

    const warnings = []
    const handles = []
    let coreFiber
    const h = {
        ctx,
        root,
        workDirectory,
        adapter,
        warnings,
        /** 核心的配置（默认带一个临时的内容目录）。 */
        coreConfig: { contentDirectory: join(root, 'content'), starter: false, ...options.coreConfig },
        async mountCore() {
            // 日志换成记录器，好核对"只写进日志"的异常。
            const logger = { warn: text => warnings.push(String(text)), info() {}, debug() {}, error: text => warnings.push(String(text)) }
            coreFiber = await mount({
                name: 'mind-framework-core-under-test',
                inject: CoreModule.inject,
                apply: child => CoreModule.apply(child, h.coreConfig, { logger, ...options.coreDeps }),
            })
            return ctx.core
        },
        async unmountCore() {
            await coreFiber.dispose()
            coreFiber = undefined
        },
        /** 建一个会话，返回它的 Agent；`release` 时随即释放，会话只留在磁盘上（冷会话）；`cwd` 默认是设施的工作目录。 */
        async createSession(id, { release = false, cwd = workDirectory } = {}) {
            const handle = await withTimeout(ctx.agents.create({
                sessionId: SessionId(id),
                meta: { cwd, agentPreset: PRESET },
                agentOptions: { ...ROUTE },
                setup: async agentCtx => {
                    await ctx.agentPresets.mount(agentCtx, PRESET)
                },
            }), `create ${id}`)
            assert.equal(await ctx.sessions.flush(handle.agent.session), true, `${id} 已持久`)
            if (release) {
                await handle.dispose()
                assert.equal(ctx.agents.get(SessionId(id)), undefined, `${id} 已不在内存里`)
                return undefined
            }
            handles.push(handle)
            return handle.agent
        },
        /** 一个会话的全部日志事件。 */
        async events(id) {
            const observation = await ctx.sessionQuery.observeSession(SessionId(id))
            try {
                return [...observation.events]
            } finally {
                observation?.[Symbol.dispose]?.() ?? observation?.dispose?.()
            }
        },
        async userMessages(id) {
            return (await h.events(id)).filter(event => event.type === 'user/message').map(event => event.data)
        },
        async turnEnds(id) {
            return (await h.events(id)).filter(event => event.type === 'turn/end')
        },
        /** 一个带插件名的上下文：在它里面访问 `ctx.core`，调用方就是这个插件。 */
        async pluginContext(pluginName) {
            let captured
            await mount({ name: pluginName, inject: ['core'], apply(child) { captured = child } })
            return captured
        },
    }
    if (options.core !== false) await h.mountCore()
    t.after(async () => {
        for (const handle of handles.splice(0).reverse()) await handle.dispose?.()
        for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
        await disposeRoot(ctx)
        if (ownsRoot) await rm(root, { recursive: true, force: true, maxRetries: 3 })
    })
    return h
}
