/**
 * 一条回复里相邻的几张图拼成一张大图发出：按顺序编号、等高排列，原图不缩小，PNG 无损输出。
 * 拼图按原图路径、大小与修改时间命名并缓存，同一批重试时得到同一个文件。
 *
 * @module @loveandbeepbrother/dsh-galatea-channels/compose
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

/** 图与图、图与边缘之间的空白。 */
const GAP = 24
/** 编号圆的半径。 */
const BADGE = 26
/** 拼图任一边超过这个像素数就拆成几张。 */
const MAX_SIDE = 12_000
/** 拼图在缓存目录里保留多久。 */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000
const BACKGROUND = { r: 245, g: 245, b: 245 }

function columnsFor(count) {
    if (count <= 3) return count
    if (count === 4) return 2
    return 3
}

function badge(number) {
    const size = BADGE * 2 + 4
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
        + `<circle cx="${size / 2}" cy="${size / 2}" r="${BADGE}" fill="#000000" fill-opacity="0.62"/>`
        + `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${number}</text>`
        + '</svg>')
}

/** 把几张图排成网格：每张放大到最高那张的高度（只放大不缩小），左上角标序号。 */
async function render(paths, first) {
    const metas = await Promise.all(paths.map(path => sharp(path).metadata()))
    if (metas.some(meta => !meta.width || !meta.height || (meta.pages ?? 1) > 1)) return null
    const sizes = metas.map(meta => (meta.orientation ?? 1) >= 5
        ? { width: meta.height, height: meta.width }
        : { width: meta.width, height: meta.height })
    const height = Math.max(...sizes.map(size => size.height))
    const widths = sizes.map(size => Math.round(size.width * height / size.height))
    const columns = columnsFor(paths.length)
    const rows = Math.ceil(paths.length / columns)
    const rowWidths = []
    for (let row = 0; row < rows; row += 1) {
        const items = widths.slice(row * columns, (row + 1) * columns)
        rowWidths.push(items.reduce((sum, width) => sum + width, 0) + GAP * (items.length - 1))
    }
    const canvas = { width: Math.max(...rowWidths) + GAP * 2, height: rows * height + GAP * (rows + 1) }
    if (canvas.width > MAX_SIDE || canvas.height > MAX_SIDE) return null
    const layers = []
    for (let index = 0; index < paths.length; index += 1) {
        const row = Math.floor(index / columns)
        const column = index % columns
        const before = widths.slice(row * columns, row * columns + column).reduce((sum, width) => sum + width, 0)
        // 每行居中。
        const left = GAP + Math.round((canvas.width - GAP * 2 - rowWidths[row]) / 2) + before + GAP * column
        const top = GAP + row * (height + GAP)
        const image = await sharp(paths[index]).rotate().resize({ height, width: widths[index], fit: 'fill' }).png().toBuffer()
        layers.push({ input: image, left, top })
        layers.push({ input: badge(first + index), left: left + 12, top: top + 12 })
    }
    return sharp({ create: { ...canvas, channels: 3, background: BACKGROUND } })
        .composite(layers)
        .png({ compressionLevel: 9 })
        .toBuffer()
}

/** 拼一组；超过大小或尺寸上限时对半拆开再拼，拆到一张时原样发。 */
async function group(paths, stats, first, dir, maxBytes) {
    if (paths.length === 1) return [paths[0]]
    const key = createHash('sha256')
        .update(JSON.stringify(paths.map((path, index) => [path, stats[index].size, stats[index].mtimeMs, first + index])))
        .digest('hex')
        .slice(0, 24)
    const target = join(dir, `composite-${key}.png`)
    const cached = await stat(target).catch(() => null)
    if (cached !== null) return [target]
    const bytes = await render(paths, first)
    if (bytes !== null && bytes.length <= maxBytes) {
        await writeFile(target, bytes)
        return [target]
    }
    const half = Math.ceil(paths.length / 2)
    return [
        ...await group(paths.slice(0, half), stats.slice(0, half), first, dir, maxBytes),
        ...await group(paths.slice(half), stats.slice(half), first + half, dir, maxBytes),
    ]
}

async function prune(dir, now) {
    for (const name of await readdir(dir).catch(() => [])) {
        if (!name.startsWith('composite-')) continue
        const path = join(dir, name)
        const info = await stat(path).catch(() => null)
        if (info !== null && now - info.mtimeMs > KEEP_MS) await unlink(path).catch(() => {})
    }
}

/**
 * 把几张图拼成一张或几张大图，返回要发送的路径。读不了的图、动图或出错时原样返回，照旧逐张发送。
 * @param {string[]} paths - 本机图片绝对路径，按回复里的顺序
 * @param {string} dir - 拼图缓存目录
 * @param {{ maxBytes: number, now?: number }} options
 * @returns {Promise<string[]>}
 */
export async function composeImages(paths, dir, { maxBytes, now = Date.now() }) {
    if (paths.length < 2) return paths
    try {
        const stats = await Promise.all(paths.map(path => stat(path)))
        await mkdir(dir, { recursive: true })
        await prune(dir, now)
        return await group(paths, stats, 1, dir, maxBytes)
    } catch {
        return paths
    }
}
