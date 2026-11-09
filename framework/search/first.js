/**
 * 门控版“先搜再答”：中枢的一轮里有该查的输入时，在那条输入后面附一段 DSH 提示，要它先用 `assistant_search` 查一下再答。
 * 程序只管到时候一定提醒；查什么、查到的用不用，交给模型。
 *
 * 门控（默认值来自我们自己的召回实验，规则在看结果前定死）：
 * - 输入有问题类型词，并且不少于 `minLength` 字；
 * - 不是用户本人说的（别的会话、外部调用方、群里别人转来的），还要新颖度不低于 `noveltyMin`。新颖度是消息里没在最近
 *   `recentRounds` 轮出现的词，其 IDF 占全部词 IDF 的比例。
 * - 切词用检索底座的切法（相邻两字），每条最多 256 个词；IDF 用检索索引里经历、记忆、便签的条数，`ln((N+1)/(df+1))`；
 *   最近几轮取自会话事件：每条当提问的输入起一轮，接着它的助手回复，输入去掉核心加的来源标注。
 * - 算不出新颖度（索引还没建好、出错）时只按前一半判，并报一次。
 *
 * 默认词表是中文，来自我们自己的数据；别的语言要自己配。词表放在内容库的一份文件里（`wordsFile`，一行一个，`#` 开头是注释），
 * 模型能直接改，下一轮生效；没有这个文件时用配置里的 `words`。判够 `remindEvery` 轮提醒中枢看一眼词表，改不改由它定。
 *
 * 现在经 Agent SDK 执行方的 `UserPromptSubmit` 钩子附上（`agentSdk.addHooks`），别的执行方还没有这条路。
 *
 * @module @loveandbeepbrother/dsh-galatea/search/first
 */

/** 默认的提示：两句是实验里写定的，中间那句是后来加的（要说某件事没有之前，把这句话本身也搜一次）。 */
export const DEFAULT_HINT = '（DSH 提示，不是用户发言：回答这条消息之前，先写 1 到 3 个搜索词，用 assistant_search 各查一次，再回答。'
    + '如果要说某件事还没做、没定过、不存在，把这句话本身也搜一次。查到的东西用不用由你判断。\n'
    + '搜到的都是旧记录，每条都带着日期。它们说的状态可能已经变了：写进回复之前，先确认它在当前上下文里仍然成立；'
    + '不要把旧状态当成现状说，也不要把一件事的核对算到另一件事上。）'

/** 默认的问题类型词（中文）：总结、状态、规划、“还有哪些”、核对旧事。实验里事先写定，不按用例调。 */
export const DEFAULT_WORDS = Object.freeze(['总结', '汇总', '梳理', '盘点', '状态', '进度', '进展', '做到哪', '做完了', '没做完', '未完成', '还剩',
    '还有哪些', '还有什么', '待办', '清单', '规划', '计划', '下一步', '接下来', '顺序', '分工', '发布', '发版', '上线', '部署', '分支', '仓库', '账号',
    '为什么', '怎么回事', '是不是', '有没有', '之前', '以前', '上次', '记得', '定过', '说过', '还记得'])

/** 词表文件：一行一个词，也可以一行写几个、用顿号或逗号隔开；`#` 开头的行是注释。 */
export function parseWords(text) {
    return [...new Set(String(text ?? '').split(/\r?\n/)
        .filter(line => !line.trim().startsWith('#'))
        .flatMap(line => line.split(/[、,，]/))
        .map(word => word.trim())
        .filter(Boolean))]
}

const escape = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 门控的规则。
 * @param options.words - 问题类型词。
 * @param options.minLength - 至少几个字（按字符数）。
 * @param options.noveltyMin - 转来的消息新颖度的下限。
 */
export function createGate({ words = DEFAULT_WORDS, minLength = 20, noveltyMin = 0.7 } = {}) {
    const pattern = words.length === 0 ? null : new RegExp(words.map(escape).join('|'))
    const asksAbout = (text) => {
        const value = String(text ?? '')
        return pattern !== null && pattern.test(value) && Array.from(value).length >= minLength
    }
    return {
        asksAbout,
        /** 这条输入要不要提醒；`novelty` 只对不是本人说的有用，算不出时是 `undefined`（只按前一半判）。 */
        passes: ({ text, fromOwner, novelty }) => asksAbout(text) && (fromOwner || novelty === undefined || novelty >= noveltyMin),
    }
}

/** 新颖度：消息里的词（去重）中，没在最近几轮出现的那些的 IDF 之和，占全部词 IDF 之和的比例。 */
export function noveltyOf(terms, recentTerms, { total, counts }) {
    const idf = count => Math.log((total + 1) / (count + 1))
    let mass = 0
    let fresh = 0
    terms.forEach((term, index) => {
        const weight = idf(counts[index] ?? 0)
        mass += weight
        if (!recentTerms.has(term)) fresh += weight
    })
    return mass > 0 ? fresh / mass : 0
}

const textOf = blocks => (Array.isArray(blocks) ? blocks : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
const isInput = event => event?.type === 'user/message' && event.data?.source?.intent === 'prompt'

/**
 * 从会话事件里取这一轮（最后一个 `turn/start` 之后）当提问的输入，和它之前最近几轮的文字。
 * @param options.original - 消息 → 去掉来源标注的内容块（核心的 `provenance.original`）。
 */
export function turnInputs(events, { original, rounds = 5 }) {
    let start = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.type === 'turn/start') {
            start = index
            break
        }
    }
    if (start < 0) return { turn: undefined, inputs: [], recent: '' }
    const inputs = events.slice(start + 1).filter(isInput)
        .map(event => ({ text: textOf(original(event.data)), fromOwner: event.data.source?.speaker?.kind === 'user' }))
    const groups = []
    for (const event of events.slice(0, start)) {
        if (isInput(event)) groups.push([textOf(original(event.data))])
        else if (event?.type === 'assistant/message' && groups.length > 0) groups.at(-1).push(textOf(event.data?.content))
    }
    return { turn: events[start].data?.turn, inputs, recent: groups.slice(-rounds).flat().join('\n') }
}

/** 自启动以来判了几次、附了几次（所有会话共用一份；Watchdog 看钩子在不在跑用）。 */
export function createStats({ enabled = true, now = Date.now } = {}) {
    const stats = { enabled, since: now(), judged: 0, triggered: 0, lastJudgedAt: null, lastTriggeredAt: null }
    return {
        record({ triggered }) {
            stats.judged += 1
            stats.lastJudgedAt = now()
            if (triggered) {
                stats.triggered += 1
                stats.lastTriggeredAt = now()
            }
        },
        stats: () => ({ ...stats }),
    }
}

/**
 * 一个会话的判定：每一轮最多判一次（一轮里再交来的提示不重复附），返回要附的提示或 `undefined`。
 * @param deps.isHub - 这个会话现在是不是中枢。
 * @param deps.readEvents - 读会话事件。
 * @param deps.original - 消息 → 去掉来源标注的内容块。
 * @param deps.gate - 现在的门控规则（`createGate`；词表改了会换，每次判的时候取）。
 * @param deps.terms - 切词（检索底座的 `terms`）。
 * @param deps.frequencies - 文档频率（检索底座的 `frequencies`）。
 * @param deps.hint - 要附的提示。
 * @param deps.report - 报异常（算不出新颖度时报一次）。
 * @param deps.onJudged - 每判完一轮调一次：`{ triggered }`。
 */
export function createSearchFirst({ isHub, readEvents, original, gate, terms, frequencies, hint = DEFAULT_HINT, rounds = 5, report = () => {}, onJudged = () => {} }) {
    let judged
    let reported = false
    /** @param prompt - 交给执行方的这次提示；这一轮输入的原文要在里面，对不上（事件还没落）就不判。 */
    return async function searchFirst(prompt) {
        if (!isHub()) return undefined
        const { turn, inputs, recent } = turnInputs(await readEvents(), { original, rounds })
        if (turn === undefined || turn === judged || inputs.length === 0) return undefined
        const text = String(prompt ?? '')
        if (!inputs.some(input => text.includes(input.text.trim().slice(0, 80)))) return undefined
        judged = turn
        const rules = await gate()
        let recentTerms
        for (const input of inputs) {
            let novelty
            if (!input.fromOwner && rules.asksAbout(input.text)) {
                try {
                    recentTerms ??= new Set(terms(recent, Infinity))
                    const own = terms(input.text)
                    novelty = noveltyOf(own, recentTerms, await frequencies(own))
                } catch (error) {
                    if (!reported) report(`算不出新颖度，转来的消息只按问题类型词和字数判（${error?.message ?? error}）`)
                    reported = true
                }
            }
            if (rules.passes({ ...input, novelty })) {
                onJudged({ triggered: true })
                return hint
            }
        }
        onJudged({ triggered: false })
        return undefined
    }
}
