/**
 * 升级核对：拿一个已经用过的 DSH home 里渠道存储域的全部记录，用当前代码的严格结构逐条校验。
 * 结构是严格的（`.strict()`），删了已发布的字段或收窄了取值，旧记录就过不了，渠道整个起不来；
 * 发布前用一个带旧数据的 home 跑一遍，命中 0 条才算过。
 *
 * 用法：node --import ./test-support/register.mjs test-support/check-stored-records.mjs <DSH home>
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { channelTableSchemas } from '../message-channels/runtime.js'

const home = process.argv[2]
if (home === undefined) throw new Error('用法：check-stored-records.mjs <DSH home>')
const root = join(home, 'storages', 'galatea_channels')
if (!existsSync(root)) throw new Error(`没有渠道存储域：${root}`)

let checked = 0
const failures = []
for (const [table, schema] of Object.entries(channelTableSchemas)) {
    const dir = join(root, table)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        const record = raw?.record ?? raw
        const result = schema.safeParse(record)
        checked += 1
        if (!result.success) failures.push(`${table}/${name}：${result.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}`)
    }
}
console.log(`核对 ${checked} 条记录，过不了的 ${failures.length} 条`)
for (const line of failures.slice(0, 20)) console.log('  ' + line)
process.exit(failures.length === 0 ? 0 : 1)
