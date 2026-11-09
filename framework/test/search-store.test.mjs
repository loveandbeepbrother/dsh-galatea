/** 检索底座最底层：分词、切块、存储、文档扫描。不依赖宿主。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { blockHash, splitBlocks } from '../search/chunk.js'
import { missingVectorTexts, scanDocuments } from '../search/documents.js'
import { openStore } from '../search/store.js'
import { indexedText, looksLikeSecret, matchAny, queryTerms, tokenize } from '../search/tokens.js'

async function tempStore(t) {
    const dir = await mkdtemp(join(tmpdir(), 'search-store-'))
    const store = openStore(join(dir, 'search.sqlite'))
    t.after(async () => {
        store.close()
        await rm(dir, { recursive: true, force: true })
    })
    return { dir, store }
}

const item = (ref, text, extra = {}) => ({ source: 'memory', ref, scope: 'memory:global', hash: blockHash(text), text, ...extra })

test('分词：中文相邻两字，单字留着，英文数字小写，分隔符都切开', () => {
    assert.deepEqual(tokenize('花园改造'), ['花园', '园改', '改造'])
    assert.deepEqual(tokenize('猫'), ['猫'])
    assert.deepEqual(tokenize('assistant_search 用 v9.9-demo'), ['assistant', 'search', '用', 'v9', '9', 'demo'])
    assert.deepEqual(tokenize('Node 的 SQLite'), ['node', '的', 'sqlite'])
    assert.deepEqual(queryTerms('花园改造 规划 花园'), ['花园', '园改', '改造', '规划'], '不重复，按原文顺序')
    assert.deepEqual(queryTerms('花园改造 规划', 2), ['花园', '园改'], '有上限时取前面的')
})

test('令牌形状的长串在分词前丢掉；路径、UUID、普通长名字留着', () => {
    assert.equal(looksLikeSecret('FakeToken0Example1Fake2Token3x'), true)
    assert.equal(looksLikeSecret('0123456789abcdef0123456789abcdef'), true)
    assert.equal(looksLikeSecret('00000000-1111-4222-8333-444444444444'), false)
    assert.equal(looksLikeSecret('demo-home-dir-20261025'), false)
    assert.deepEqual(tokenize('Bearer FakeToken0Example1Fake2Token3x 结束'), ['bearer', '结束'])
    assert.ok(indexedText('D:/Example/demo-home-dir-20261025/x.md').includes('demo home dir 20261025'))
})

test('切块：按标题切，带标题链和行号；代码块里的井号不算标题；改一处别的块哈希不变；太长的切开', () => {
    const text = '# 一\n开头\n\n## 二\n内容二\n\n```\n# 不是标题\n```\n\n## 三\n内容三\n'
    const blocks = splitBlocks(text)
    assert.deepEqual(blocks.map(block => [block.line, block.heading]), [[1, '一'], [4, '一 › 二'], [11, '一 › 三']])
    assert.match(blocks[1].text, /不是标题/)
    const changed = splitBlocks(text.replace('内容二', '内容二改了'))
    assert.notEqual(changed[1].hash, blocks[1].hash)
    assert.equal(changed[2].hash, blocks[2].hash, '别的块不变')

    const long = splitBlocks(`# 长\n${'字'.repeat(5000)}\n`, { limit: 2000 })
    assert.ok(long.length >= 3)
    assert.ok(long.every(block => Array.from(block.text).length <= 2000))
    assert.equal(splitBlocks('\n\n  \n').length, 0)
})

test('存储：OR 加 BM25；可见范围和筛选在 SQL 里，不会被别的范围挤掉；改了重写，没变不动，删了就没', async (t) => {
    const { store } = await tempStore(t)
    const upserts = Array.from({ length: 30 }, (_, index) => item(`hidden-${index}`, '花园改造的规划', { scope: 'memory:workspace:other' }))
    upserts.push(item('mine', '花园改造', { scope: 'memory:global', at: 100 }))
    assert.equal(store.apply({ upserts }).changed, 31)
    const match = matchAny(queryTerms('花园改造 规划'))
    assert.equal(store.query({ match, limit: 5 }).length, 5)
    assert.deepEqual(store.query({ match, scopes: ['memory:global'], limit: 5 }).map(row => row.ref), ['mine'], '范围过滤在排序前')
    assert.equal(store.query({ match, scopes: ['memory:global'], since: 200 }).length, 0)

    assert.equal(store.apply({ upserts: [item('mine', '花园改造', { title: '新标题', at: 100 })] }).changed, 0, '内容没变')
    assert.equal(store.itemByRef('memory', 'mine').title, '新标题')
    assert.equal(store.apply({ upserts: [item('mine', '换了内容')] }).changed, 1)
    assert.equal(store.query({ match: matchAny(['花园']), scopes: ['memory:global'] }).length, 0, '旧内容搜不到了')
    assert.equal(store.query({ match: matchAny(['换了']), scopes: ['memory:global'] }).length, 1)
    store.apply({ source: 'memory', removes: ['mine'] })
    assert.equal(store.query({ match: matchAny(['换了']) }).length, 0)
})

test('文档频率：按来源数条数，同一次发送正文相同的副本算一条，别的来源不算；词和查询切法一样', async (t) => {
    const { store } = await tempStore(t)
    store.apply({ upserts: [
        item('m1', '风车的灯', { source: 'memory' }),
        copy('sent', 'writer', 'out', '风车要修', 'L1'),
        copy('got', 'editor', 'peer', '风车要修', 'L1'),
        copy('other', 'writer', 'user', '今天下雨', null),
        { source: 'documents', ref: 'd1', scope: 'doc:shared', hash: 'd', text: '风车的说明书' },
    ] })
    const terms = queryTerms('风车下雨')
    assert.deepEqual(terms, ['风车', '车下', '下雨'])
    assert.deepEqual(store.frequencies(terms, ['experience', 'memory']), { total: 3, counts: [2, 0, 1] }, '副本算一条，文档不算')
    assert.deepEqual(store.frequencies(terms, ['documents']), { total: 1, counts: [1, 0, 0] })
})

test('对账：多出来的删掉，指纹变了或缺的交回去', async (t) => {
    const { store } = await tempStore(t)
    store.apply({ upserts: [item('a', '甲'), item('b', '乙'), item('c', '丙')] })
    const { removed, stale } = store.reconcile('memory', [{ ref: 'a', hash: blockHash('甲') }, { ref: 'b', hash: 'changed' }, { ref: 'd', hash: 'new' }])
    assert.equal(removed, 1)
    assert.deepEqual(stale.sort(), ['b', 'd'])
    assert.equal(store.itemByRef('memory', 'c'), undefined)
})

const copy = (ref, thread, role, text, link, extra = {}) => ({ source: 'experience', ref, scope: `thread:${thread}`, thread, role, link, hash: `${blockHash(text)}:${link ?? ''}`, text, ...extra })

test('编号按来源唯一：发给会话的条目和那次工具调用同编号，各是各的；反复对账不翻来翻去', async (t) => {
    const { store } = await tempStore(t)
    const sent = { source: 'experience', ref: 'cc:1:toolu_1', scope: 'thread:main', thread: 'main', role: 'out', hash: 'h1', text: '发出去的原话' }
    const op = { source: 'operations', ref: 'cc:1:toolu_1', scope: 'thread:main', thread: 'main', title: 'send', hash: 'h2', text: 'assistant_session_send 工具参数' }
    assert.equal(store.apply({ upserts: [sent, op] }).changed, 2)
    assert.equal(store.countOf('experience'), 1)
    assert.equal(store.countOf('operations'), 1)
    assert.deepEqual(store.query({ match: matchAny(queryTerms('原话')), sources: ['experience'] }).map(row => row.ref), ['cc:1:toolu_1'])
    assert.equal(store.query({ match: matchAny(queryTerms('原话')), sources: ['operations'] }).length, 0)
    for (let round = 0; round < 2; round += 1) {
        assert.deepEqual(store.reconcile('experience', [{ ref: sent.ref, hash: sent.hash }]), { removed: 0, stale: [] })
        assert.deepEqual(store.reconcile('operations', [{ ref: op.ref, hash: op.hash }]), { removed: 0, stale: [] })
    }
    store.apply({ source: 'operations', removes: [op.ref] })
    assert.equal(store.countOf('experience'), 1, '删工具轨迹不碰同编号的条目')
})

test('副本：同一 link 只有一份进全文表，发送方优先，后到也换过去；词频按一条算；看得到哪份交哪份，都看不到就没有', async (t) => {
    const { store } = await tempStore(t)
    const match = matchAny(queryTerms('第三章'))
    store.apply({ upserts: [copy('got', 'editor', 'peer', '第三章请审', 'L1')] })
    assert.deepEqual(store.query({ match }).map(row => row.ref), ['got'], '只到了接收方：先用它')
    store.apply({ upserts: [copy('sent', 'writer', 'out', '第三章请审', 'L1')] })
    assert.deepEqual(store.query({ match }).map(row => row.ref), ['sent'], '发送方到了：换成它')
    assert.equal(store.itemByRef('experience', 'got').copy_of, store.itemByRef('experience', 'sent').id)
    assert.equal(store.db.prepare(`select count(*) as n from texts where texts match '"三章"'`).get().n, 1, '词频按一条算')
    store.apply({ upserts: [copy('got2', 'third', 'peer', '第三章请审', 'L1')] })
    assert.equal(store.itemByRef('experience', 'got2').copy_of, store.itemByRef('experience', 'sent').id)
    assert.equal(store.db.prepare(`select count(*) as n from texts where texts match '"三章"'`).get().n, 1)

    assert.deepEqual(store.query({ match, scopes: ['thread:editor'] }).map(row => [row.ref, row.thread]), [['got', 'editor']], '只有接收方那份的，交它自己那份')
    assert.deepEqual(store.query({ match, threads: ['third'] }).map(row => row.ref), ['got2'])
    assert.deepEqual(store.query({ match, scopes: ['thread:stranger'] }), [], '一份都没有的查不到')
    assert.deepEqual(store.query({ match, role: 'peer', scopes: ['thread:editor', 'thread:writer'] }).map(row => row.ref), ['got'], '筛选按同一份判断')
    assert.equal(store.query({ match, role: 'out', scopes: ['thread:editor'] }).length, 0, '条件要落在同一份上')
    assert.equal(store.query({ match, scopes: ['thread:editor', 'thread:third'] }).length, 1, '并集也只算一条')
    assert.equal(store.copiesOf('experience', 'L1'), 2)
    assert.equal(store.copiesOf('experience', 'L1', ['thread:editor']), 0, '看不到的不算')
    assert.equal(store.copiesOf('experience', 'L1', ['thread:editor', 'thread:third']), 1)
})

test('副本正文不同（接收方多一层通知）：各进全文表，那段话搜得到，接收方查到自己那份', async (t) => {
    const { store } = await tempStore(t)
    store.apply({ upserts: [
        copy('sent', 'writer', 'out', '第三章请审', 'L1'),
        copy('got', 'editor', 'peer', '第三章请审\n（对方的回复次数已经用完）', 'L1'),
    ] })
    assert.equal(store.itemByRef('experience', 'got').copy_of, null)
    assert.deepEqual(store.query({ match: matchAny(queryTerms('回复次数')) }).map(row => row.ref), ['got'], '只有接收方有的话搜得到')
    assert.deepEqual(store.query({ match: matchAny(queryTerms('回复次数')), scopes: ['thread:writer'] }), [], '发送方那边没有这段话')
    assert.deepEqual(store.query({ match: matchAny(queryTerms('第三章')), scopes: ['thread:editor'] }).map(row => row.ref), ['got'])
    assert.equal(store.query({ match: matchAny(queryTerms('第三章')) }).length, 2, '存储层是两条，同一 link 留给查询时折叠')
    assert.equal(store.copiesOf('experience', 'L1'), 1, '仍然算同一次发送的副本')
})

test('副本：删掉进全文表的那份，其余的交回去重写；对账也一样；两轮对账之后不再动', async (t) => {
    const { store } = await tempStore(t)
    const sent = copy('sent', 'writer', 'out', '第三章请审', 'L1')
    const got = copy('got', 'editor', 'peer', '第三章请审', 'L1')
    store.apply({ upserts: [sent, got] })
    const keep = [{ ref: got.ref, hash: got.hash }]
    const first = store.reconcile('experience', keep)
    assert.deepEqual(first, { removed: 1, stale: ['got'] }, '发送方没了：接收方那份要重新交')
    assert.equal(store.query({ match: matchAny(queryTerms('第三章')) }).length, 0)
    assert.deepEqual(store.apply({ upserts: [got] }), { changed: 1, orphans: [] })
    assert.deepEqual(store.query({ match: matchAny(queryTerms('第三章')) }).map(row => row.ref), ['got'])
    assert.deepEqual(store.reconcile('experience', keep), { removed: 0, stale: [] })

    const other = copy('other', 'third', 'out', '换了关联', 'L2')
    store.apply({ upserts: [other, copy('member', 'editor', 'peer', '换了关联', 'L2')] })
    const relinked = { ...other, link: 'L9', hash: 'changed' }
    assert.deepEqual(store.apply({ upserts: [relinked] }).orphans, ['member'], '代表换了内容或关联，其余的也要重交')
})

test('索引结构变了：丢掉重建，向量留着不重算；结构没变打开不动', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'search-store-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'search.sqlite')
    const old = new DatabaseSync(file)
    old.exec(`create table items (id integer primary key, source text not null, ref text not null unique, scope text not null, hash text not null);
        create table cursors (key text primary key, value integer not null) without rowid;
        create table vectors (hash text not null, model text not null, vector blob not null, primary key (hash, model)) without rowid;
        insert into items (source, ref, scope, hash) values ('experience', 'x', 'thread:a', 'h');
        insert into cursors (key, value) values ('entries', 99);
        insert into vectors (hash, model, vector) values ('kept', 'm', x'00000000');`)
    old.close()
    let store = openStore(file)
    assert.equal(store.countOf('experience'), 0, '旧条目丢掉了')
    assert.equal(store.cursor('entries'), 0, '游标也清了，从头接')
    assert.ok(store.hasVector('kept', 'm'), '向量留着')
    store.apply({ upserts: [item('a', '甲')] })
    store.close()
    store = openStore(file)
    assert.equal(store.countOf('memory'), 1, '结构没变不重建')
    store.close()
})

test('文档：白名单里的 md、txt 切块进索引；排除的不进；没变不读，改了重算，删了同步删；向量按内容哈希，重建不重算', async (t) => {
    const { dir, store } = await tempStore(t)
    const docs = join(dir, 'docs')
    await mkdir(join(docs, '私人草稿'), { recursive: true })
    const file = join(docs, '决定.md')
    await writeFile(file, '# 决定\n微信每条消息回十片\n\n# 另一件\n别的内容\n')
    await writeFile(join(docs, '私人草稿', '第一次.md'), '# 不该读\n私人内容\n')
    await writeFile(join(docs, '代码.js'), 'const a = 1')
    const entries = [{ path: docs, label: '文档', scopeKey: 'doc:hub', vectors: true }]
    const scan = () => scanDocuments(store, { entries, exclude: ['私人草稿'] })
    assert.deepEqual(scan(), { files: 1, changed: 1, removed: 0 })
    const found = store.query({ match: matchAny(queryTerms('微信')) })
    assert.equal(found.length, 1)
    assert.equal(found[0].location, `${file}:1`)
    assert.equal(found[0].title, '文档：决定')
    assert.equal(store.query({ match: matchAny(queryTerms('私人')) }).length, 0, '私人草稿没读')
    assert.deepEqual(scan(), { files: 1, changed: 0, removed: 0 }, '没变不读')

    const missing = missingVectorTexts(store, { model: 'm', limit: 10 })
    assert.equal(missing.length, 2)
    store.putVectors('m', missing.map(({ hash }) => ({ hash, vector: Float32Array.from([1, 0]) })))
    assert.equal(missingVectorTexts(store, { model: 'm', limit: 10 }).length, 0)
    assert.equal(store.loadVectors('m').length, 2)

    await writeFile(file, '# 决定\n微信每条消息回十片\n\n# 另一件\n改过的内容\n')
    await utimes(file, new Date(), new Date(Date.now() + 5000))
    assert.equal(scan().changed, 1)
    assert.equal(store.query({ match: matchAny(queryTerms('别的')) }).length, 0)
    assert.equal(missingVectorTexts(store, { model: 'm', limit: 10 }).length, 1, '只有改了的块要重算')

    await rm(file)
    assert.equal(scan().removed, 2)
    assert.equal(store.countOf('documents'), 0)

    const secret = 'aB3'.repeat(12)
    await writeFile(file, `# 配置\n接口的钥匙是 ${secret} 别外传\n`)
    scan()
    const sent = missingVectorTexts(store, { model: 'm', limit: 10 })
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.includes('接口的钥匙是'), '其余文字照发')
    assert.ok(!sent[0].text.includes(secret), '令牌形状的长串不发给向量接口')
})
