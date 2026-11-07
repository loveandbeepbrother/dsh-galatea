/**
 * 打包检查：发布出去的文件里引用的本地模块，必须也在包里。
 *
 * 测试在源码目录里跑，`package.json` 的 `files` 漏了新文件也照样通过，装上以后插件却加载不了。
 * 这里用 `npm pack --dry-run` 取包里实际会有的文件，逐个扫其中 js/mjs 的相对引用。
 *
 * @module dsh/test-support/pack-check
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

/** `import … from './x.js'`、`export … from './x.js'`、`import('./x.js')`、`import './x.js'` 里的相对路径。 */
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g

/**
 * @param {string} cwd - 插件包目录。
 * @returns {string[]} 问题，每条一句；没有就是空数组。
 */
export function packProblems(cwd) {
    const run = spawnSync('npm pack --dry-run --json --ignore-scripts', { cwd, encoding: 'utf8', shell: true, windowsHide: true })
    if (run.status !== 0) return [`npm pack --dry-run 失败：${(run.stderr || run.stdout || '').trim().split('\n').at(-1)}`]
    const shipped = new Set(JSON.parse(run.stdout)[0].files.map(file => normalize(file.path)))
    const problems = []
    for (const file of shipped) {
        if (!/\.m?js$/.test(file)) continue
        const text = readFileSync(join(cwd, file), 'utf8')
        for (const [, specifier] of text.matchAll(RELATIVE_SPECIFIER)) {
            const target = normalize(relative(cwd, join(cwd, dirname(file), specifier)))
            if (!shipped.has(target)) problems.push(`${file} 引用的 ${specifier} 不在包里（package.json 的 files）`)
        }
    }
    return problems
}
