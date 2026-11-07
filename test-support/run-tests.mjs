/**
 * 产品插件测试的统一入口：逐个插件包在其目录内运行 `node --test`，并注册官方包解析钩子。
 *
 * 用法（在仓库任意位置）：
 *
 *     $env:DSH_SOURCE = '<上游 DSH 源码目录>'
 *     node test-support/run-tests.mjs [包名 ...]
 *
 * 不带参数时运行全部带 `test/` 目录的插件包。使用运行本脚本的同一个 Node。
 *
 * @module dsh/test-support/run-tests
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packProblems } from './pack-check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dshRoot = dirname(here)
const registerUrl = pathToFileURL(join(here, 'register.mjs')).href

const requested = process.argv.slice(2)
const candidates = readdirSync(dshRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(dshRoot, entry.name, 'test')))
    .map(entry => entry.name)
const unknown = requested.filter(name => !candidates.includes(name))
if (unknown.length > 0) {
    console.error(`未知插件包：${unknown.join(', ')}；可选：${candidates.join(', ')}`)
    process.exit(2)
}

const results = []
for (const name of requested.length > 0 ? requested : candidates) {
    const cwd = join(dshRoot, name)
    const files = readdirSync(join(cwd, 'test')).filter(file => file.endsWith('.test.mjs')).map(file => join('test', file))
    console.log(`\n== ${name} (${files.length} files)`)
    const run = spawnSync(process.execPath, ['--import', registerUrl, '--test', ...files], { cwd, stdio: 'inherit', env: process.env, windowsHide: true })
    // 测试在源码目录里跑，查不出包里漏了文件：另外核对发布出去的文件引用的本地模块都在包里。
    const problems = existsSync(join(cwd, 'package.json')) ? packProblems(cwd) : []
    for (const problem of problems) console.error(`打包检查：${problem}`)
    results.push({ name, status: problems.length > 0 ? 1 : run.status })
}

console.log('\n== summary')
for (const { name, status } of results) console.log(`${status === 0 ? 'ok  ' : 'FAIL'} ${name}`)
process.exit(results.every(result => result.status === 0) ? 0 : 1)
