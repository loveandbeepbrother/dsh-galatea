/**
 * 收藏：中枢觉得值得珍惜的一条经历（按编号）或一句原话，可附一句为什么。存在内容库的一个 JSONL 文件里，每次改动有提交可查。
 * 收藏是中枢按需调用工具标的，和渠道的引用无关（引用只是消息多时为了不混淆）。后台思考维护“我们之间”时优先看收藏。
 *
 * 每行一条：`{ id, at, ref?, excerpt?, quote?, why? }`。`excerpt` 是按编号收藏时那条经历的开头，列的时候不用再去读。
 *
 * @module @loveandbeepbrother/dsh-galatea/experience/favorites
 */

export const FAVORITE_ID = /^fav-[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const EXCERPT_CHARS = 120

/** 解析收藏文件；某一行不是 JSON 时抛错并写明第几行（文件可以手改）。 */
export function parseFavorites(text) {
    const list = []
    String(text ?? '').split(/\r?\n/).forEach((line, index) => {
        if (line.trim() === '') return
        let item
        try {
            item = JSON.parse(line)
        } catch {
            throw new Error(`收藏文件第 ${index + 1} 行不是 JSON`)
        }
        if (typeof item?.id !== 'string' || !Number.isFinite(item.at)) throw new Error(`收藏文件第 ${index + 1} 行缺 id 或 at`)
        list.push(item)
    })
    return list
}

export const formatFavorites = list => list.map(item => JSON.stringify(item)).join('\n') + (list.length > 0 ? '\n' : '')

/** 经历的开头，存进收藏当摘录。 */
export const excerptOf = text => {
    const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim())
    return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('')}…` : chars.join('')
}
