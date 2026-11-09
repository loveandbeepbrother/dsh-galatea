/**
 * 写索引的 worker：分词、写全文表、扫文档都是同步的，放在这里不挡 Host。主线程只查询。
 *
 * 消息 `{ id, op, args }`，回 `{ id, result }` 或 `{ id, error }`。
 *
 * @module @loveandbeepbrother/dsh-galatea/search/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { missingVectorTexts, scanDocuments } from './documents.js'
import { openStore } from './store.js'

const store = openStore(workerData.file)

const OPS = {
    apply: args => store.apply(args),
    reconcile: ({ source, keep, prefix }) => store.reconcile(source, keep, { prefix }),
    scanDocuments: args => scanDocuments(store, args),
    missingVectorTexts: args => missingVectorTexts(store, args),
    putVectors: ({ model, vectors }) => store.putVectors(model, vectors),
    cursor: ({ key }) => store.cursor(key),
    setCursor: ({ key, value }) => store.setCursor(key, value),
    frequencies: ({ terms, sources }) => store.frequencies(terms, sources),
}

parentPort.on('message', ({ id, op, args }) => {
    try {
        parentPort.postMessage({ id, result: OPS[op](args) ?? null })
    } catch (error) {
        parentPort.postMessage({ id, error: String(error?.message ?? error) })
    }
})

parentPort.postMessage({ ready: true })
