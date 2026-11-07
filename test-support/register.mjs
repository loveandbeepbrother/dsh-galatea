/**
 * 以 `node --import` 加载：注册官方包解析钩子。工作区根目录取自环境变量 `DSH_SOURCE`。
 *
 * @module dsh/test-support/register
 */

import { register } from 'node:module'

const root = process.env.DSH_SOURCE
if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('dsh/test-support: 请把 DSH_SOURCE 设为 DSH 官方源码工作区根目录')
}
register('./resolve-dsh.mjs', import.meta.url, { data: { root: root.trim() } })
