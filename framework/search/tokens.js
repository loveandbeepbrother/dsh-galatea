/**
 * 检索的分词：纯函数，没有依赖。索引和查询用同一份，离线回放也用它。
 *
 * - 中文连续串切成相邻两字；一个字的串保留那一个字。英文和数字按连续字母、数字切，小写。`_`、`-`、`.` 都是分隔，
 *   所以 `assistant_search` 搜 `search` 也能中。切好以后用空白连起来存进 FTS5，由 unicode61 按空白切
 *   （Node 的 sqlite 注册不了自定义分词器）。
 * - 看着像令牌、密钥的长串在分词前丢掉：不去猜哪个是令牌，只看形状，宁可少索引一个长串。
 *
 * @module @loveandbeepbrother/dsh-galatea/search/tokens
 */

const RUNS = /\p{Script=Han}+|[\p{L}\p{N}]+/gu
const LONG_STRING = /[A-Za-z0-9_\-+=]{24,}/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HAN_START = /^\p{Script=Han}/u

/** 这个长串看着像令牌：大小写和数字混着，或者一长串十六进制、字母数字。会话编号那样的 UUID 不算。 */
export function looksLikeSecret(text) {
    if (UUID.test(text)) return false
    if (/[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text)) return true
    return /^[A-Za-z0-9]{32,}$/.test(text) && /[0-9]/.test(text)
}

/** 去掉看着像令牌的长串。 */
export function stripSecrets(text) {
    return String(text ?? '').replace(LONG_STRING, match => (looksLikeSecret(match) ? ' ' : match))
}

function runTokens(run) {
    if (!HAN_START.test(run)) return [run]
    const chars = Array.from(run)
    if (chars.length === 1) return chars
    const tokens = []
    for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(chars[index] + chars[index + 1])
    return tokens
}

/** 切成一串词（保持顺序，可以重复）。 */
export function tokenize(text) {
    const runs = stripSecrets(text).toLowerCase().match(RUNS) ?? []
    return runs.flatMap(runTokens)
}

/** 存进全文表的正文。 */
export const indexedText = text => tokenize(text).join(' ')

/**
 * 查询要用的词：不重复，按原文顺序，最多 `limit` 个。太长时不挑“最稀”的：相邻两字切出来最稀的多半是跨词的碎片，
 * 不在目标里（真实数据上选中的词 5% 在目标里，全部词是 13%）。
 */
export const queryTerms = (text, limit = Infinity) => [...new Set(tokenize(text))].slice(0, limit)

/** FTS5 的 OR 查询。词只含字母和数字，引号里不用转义。 */
export const matchAny = terms => terms.map(term => `"${term}"`).join(' OR ')
