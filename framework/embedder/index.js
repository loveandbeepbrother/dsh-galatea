/**
 * 向量提供方：服务 `embedder`，具体记忆和经历库共用一份。框架自带这一个兼容 OpenAI 接口的实现；
 * 别的提供方只要提供同名服务、同样的形状就能换。
 *
 * - 地址、模型、维度、密钥所在的环境变量名都是配置，默认值不指向任何一家；没配全就不提供服务，并报一次，
 *   用的一方只按关键词检索并写明。
 * - 直连，不读代理环境变量（`node:https` 本来就不读）。
 * - 每批 10 条，每条截到 6000 个码点（和旧的 mind-writes 相同）。
 *
 * ```ts
 * provide('embedder', { id, model, dimensions, embed(texts: string[]): Promise<Float32Array[]> })
 * ```
 *
 * @module @loveandbeepbrother/dsh-galatea/embedder
 */

import { request } from 'node:https'
import Schema from '@deepseek-ai/schemastery'

export const name = 'mind-framework-embedder'
// 核心不是必需的：有就经它报，没有就写日志（cordis 的 inject 只有必需一种，所以按用时取）。
export const inject = []
export const SERVICE = 'embedder'

const BATCH = 10
const MAX_CHARS = 6000

export const Config = Schema.object({
    endpoint: Schema.string().default('').description('兼容 OpenAI 的 embeddings 接口地址（完整 URL）'),
    model: Schema.string().default('').description('模型名'),
    dimensions: Schema.natural().default(0).description('向量维度'),
    apiKeyEnv: Schema.string().default('').description('密钥所在的环境变量名（只写变量名，不写密钥）'),
    timeoutMs: Schema.natural().default(30_000),
})

function post(endpoint, apiKey, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint)
        const payload = Buffer.from(JSON.stringify(body), 'utf8')
        const call = request({
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': payload.length },
            timeout: timeoutMs,
        }, (response) => {
            const chunks = []
            response.on('data', chunk => chunks.push(chunk))
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                if (response.statusCode !== 200) reject(new Error(`向量请求失败（${response.statusCode}）：${text.slice(0, 200)}`))
                else resolve(JSON.parse(text))
            })
        })
        call.on('timeout', () => call.destroy(new Error('向量请求超时')))
        call.on('error', reject)
        call.end(payload)
    })
}

/**
 * @param options.send - 换掉实际请求（测试用）。
 * @returns 服务的值；没配全时为 `undefined`。
 */
export function createEmbedder({ endpoint, model, dimensions, apiKey, timeoutMs = 30_000, send = post }) {
    if (!endpoint || !model || !dimensions || !apiKey) return undefined
    return Object.freeze({
        id: `openai-compatible:${new URL(endpoint).host}`,
        model,
        dimensions,
        async embed(texts) {
            const vectors = []
            for (let start = 0; start < texts.length; start += BATCH) {
                const input = texts.slice(start, start + BATCH).map(text => Array.from(String(text)).slice(0, MAX_CHARS).join(''))
                const json = await send(endpoint, apiKey, { model, input, dimensions, encoding_format: 'float' }, timeoutMs)
                for (const item of [...json.data].sort((left, right) => left.index - right.index)) vectors.push(Float32Array.from(item.embedding))
            }
            if (vectors.length !== texts.length) throw new Error(`向量条数不对：要 ${texts.length} 条，回来 ${vectors.length} 条`)
            return vectors
        },
    })
}

export function cosine(left, right) {
    let dot = 0
    let a = 0
    let b = 0
    for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * right[index]
        a += left[index] * left[index]
        b += right[index] * right[index]
    }
    return a === 0 || b === 0 ? 0 : dot / Math.sqrt(a * b)
}

/** 向量与 base64 互转，便于存进 JSON 记录。 */
export const encodeVector = vector => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
export function decodeVector(text) {
    const bytes = Buffer.from(text, 'base64')
    // Buffer 可能来自共享池、偏移没按 4 字节对齐：复制出独立的缓冲区。
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

export function apply(ctx, config) {
    const apiKey = config.apiKeyEnv === '' ? '' : process.env[config.apiKeyEnv] ?? ''
    const embedder = createEmbedder({ ...config, apiKey })
    if (embedder === undefined) {
        const missing = [['endpoint', config.endpoint], ['model', config.model], ['dimensions', config.dimensions], [`环境变量 ${config.apiKeyEnv || '（没写变量名）'} 里的密钥`, apiKey]]
            .filter(([, value]) => !value).map(([label]) => label)
        const text = `向量提供方没配全（缺 ${missing.join('、')}），不提供 embedder；记忆和经历库只按关键词检索`
        const core = ctx.get('core')
        if (core !== undefined) core.report('embedder/unconfigured', { text })
        else ctx.logger?.warn?.(`mind-framework: ${text}`)
        return
    }
    ctx.provide(SERVICE, embedder)
}
