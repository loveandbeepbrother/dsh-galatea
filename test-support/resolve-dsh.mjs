/**
 * 插件测试的模块解析钩子：把仓库内无法解析的官方包解析到 DSH 官方源码工作区。
 *
 * 产品插件以 peer/dev 依赖声明官方包，仓库里没有安装它们。本钩子先走默认解析；
 * 失败时：
 *
 *  - `@deepseek-ai/<name>[/<subpath>]` 按工作区中同名包目录做包内自引用解析，
 *    沿用该包自己的 `exports`，模块实例与官方包之间的依赖保持同一份；
 *  - 其它裸说明符从工作区的 pnpm 隐藏提升目录解析。
 *
 * 不修改官方源码工作区，也不安装任何依赖。
 *
 * @module dsh/test-support/resolve-dsh
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 包名 → 包目录；由 initialize 从工作区扫描得到。 */
let packages = new Map()
/** 其它裸说明符的回退解析位置（pnpm 隐藏提升目录内的虚拟父模块）。 */
let fallbackParent

/**
 * 扫描工作区内的包清单。只看 `packages/` 与 `vendor/` 下有限深度，跳过 node_modules。
 *
 * @param {string} root - DSH 官方源码工作区根目录。
 * @returns {Map<string, string>} 包名到目录的映射。
 */
function scan(root) {
    const found = new Map()
    const visit = (dir, depth) => {
        if (depth < 0) return
        let entries
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        if (entries.some(entry => entry.isFile() && entry.name === 'package.json')) {
            try {
                const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
                if (typeof name === 'string' && name.startsWith('@deepseek-ai/') && !found.has(name)) found.set(name, dir)
            } catch {
                // 损坏或非 JSON 的清单不参与映射。
            }
        }
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
                visit(join(dir, entry.name), depth - 1)
            }
        }
    }
    visit(join(root, 'packages'), 3)
    visit(join(root, 'vendor'), 4)
    return found
}

/** @param {{ root: string }} data - 由 register.mjs 传入的工作区根目录。 */
export function initialize(data) {
    packages = scan(data.root)
    const hoisted = join(data.root, 'node_modules', '.pnpm', 'node_modules')
    fallbackParent = existsSync(hoisted) ? pathToFileURL(join(hoisted, 'resolve-dsh-parent.mjs')).href : undefined
}

/** 拆出 `@scope/name` 与子路径。 */
function packageNameOf(specifier) {
    const parts = specifier.split('/')
    return parts.slice(0, 2).join('/')
}

export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context)
    } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
        if (specifier.startsWith('@deepseek-ai/')) {
            const dir = packages.get(packageNameOf(specifier))
            if (dir !== undefined) {
                return await nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(dir, 'package.json')).href })
            }
        }
        const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !/^[a-z]+:/i.test(specifier)
        if (bare && fallbackParent !== undefined) {
            return await nextResolve(specifier, { ...context, parentURL: fallbackParent })
        }
        throw error
    }
}
