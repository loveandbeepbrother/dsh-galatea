/**
 * 组合包装配：本包 patch 叠加在官方 base → web-app 之上时，框架各模块按 id 插入、默认停用；
 * 会话日志目录、会话搜索的打开时机和前端 include 由本包接过。
 * 全部经官方 `loadOptionalPatches` / `composeEntries` 解析与组合，不自制 composer。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'

/** 按包 manifest 的 `dsh.bundle.patch` 取官方已发布的 patch 层，不复制其正文。 */
async function officialBundlePatches(specifier) {
    const file = fileURLToPath(import.meta.resolve(`${specifier}/cordis.patch.yml`))
    const patches = loadOptionalPatches('assistant-bundle', file)
    assert.ok(Array.isArray(patches) && patches.length > 0, `${specifier} 必须给出真实 patch 层`)
    return patches
}

/** 组合结果里唯一的一行。 */
function rowOf(entries, id) {
    const rows = entries.filter(entry => entry.id === id)
    assert.equal(rows.length, 1, `${id} 在装配结果里必须唯一`)
    return rows[0]
}

test('manifest：框架只有 Host 一侧，没有前端', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(manifest.dsh.client, undefined, '不登记前端')
    assert.ok(!Object.keys(manifest.exports).includes('./client') && !manifest.files.includes('client.js'))
    assert.equal(manifest.exports['.'], './core/index.js', '根导出是核心')
})

test('bundle 装配：框架模块装上就启用；上游 compaction-basic 停用（同一个服务只能有一个）；其余官方行（含 modules、会话存储）不改', async (t) => {
    const official = [
        await officialBundlePatches('@deepseek-ai/dsh-base'),
        await officialBundlePatches('@deepseek-ai/dsh-web-app'),
    ]
    const ours = loadOptionalPatches('assistant-bundle', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    const skipped = []
    const baseline = composeEntries(official, message => skipped.push(message))
    const entries = composeEntries([...official, ours], message => skipped.push(message))
    assert.deepEqual(skipped, [], '每一行 patch 都必须命中真实官方行')

    for (const id of ['agent', 'session-controller', 'agent-loop', 'typert-loader', 'session-persistence-jsonl', 'session-query-sqlite', 'modules']) {
        assert.deepEqual(rowOf(entries, id), rowOf(baseline, id), `${id} 行与官方组合一致`)
    }
    assert.equal(rowOf(entries, 'compaction-basic').disabled, true, '原生压缩由框架的引擎接替')

    const added = entries.filter(entry => !baseline.some(row => row.id === entry.id))
    assert.ok(added.length === 11 && added.every(entry => entry.id.startsWith('mind-framework-') && !entry.disabled), '十一个框架模块，装上就启用')
})
