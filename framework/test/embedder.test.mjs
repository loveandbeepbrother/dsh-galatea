/**
 * 向量提供方：按批请求、按序号排回；没配全不提供服务，报出来写明缺什么（不带密钥）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as EmbedderModule from '../embedder/index.js'
import { makeHarness } from './harness.mjs'

test('createEmbedder：每批 10 条、每条截到 6000 码点，按 index 排回；没配全时不给', async () => {
    const sent = []
    const send = async (endpoint, apiKey, body) => {
        sent.push({ endpoint, apiKey, body })
        return { data: body.input.map((_text, index) => ({ index, embedding: [index, 1] })).reverse() }
    }
    const embedder = EmbedderModule.createEmbedder({ endpoint: 'https://embed.example/v1/embeddings', model: 'm', dimensions: 2, apiKey: 'k', send })
    const texts = Array.from({ length: 12 }, (_value, index) => (index === 0 ? '长'.repeat(7000) : `第${index}条`))
    const vectors = await embedder.embed(texts)
    assert.equal(vectors.length, 12)
    assert.deepEqual([...vectors[3]], [3, 1], '按 index 排回')
    assert.deepEqual(sent.map(call => call.body.input.length), [10, 2])
    assert.equal(Array.from(sent[0].body.input[0]).length, 6000)
    assert.equal(embedder.id, 'openai-compatible:embed.example')
    assert.equal(EmbedderModule.createEmbedder({ endpoint: 'https://embed.example/v1', model: 'm', dimensions: 2, apiKey: '' }), undefined)
})

test('没配全：不提供 embedder，报一条写明缺什么，不带密钥', async (t) => {
    const h = await makeHarness(t)
    const reports = []
    h.ctx.core.onReport(entry => reports.push(entry))
    const fiber = await h.ctx.plugin(EmbedderModule, { endpoint: 'https://embed.example/v1', model: 'm', dimensions: 2, apiKeyEnv: 'MIND_FRAMEWORK_TEST_NO_SUCH_KEY' })
    t.after(() => fiber.dispose())
    assert.equal(h.ctx.get('embedder'), undefined)
    const report = reports.find(entry => entry.kind === 'embedder/unconfigured')
    assert.match(report.text, /缺 环境变量 MIND_FRAMEWORK_TEST_NO_SUCH_KEY 里的密钥/)
})
