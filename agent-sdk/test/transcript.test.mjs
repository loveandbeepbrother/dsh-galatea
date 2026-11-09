/** 进程记录：重启打断的轮。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProcessParser, interruptedTurns, turnLeftOpen } from '../transcript.js'

test('重启打断的轮：记录停在中途才算；正常结束的、别的时间写的、没有归属的不算', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'interrupted-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'project'))
    const line = value => JSON.stringify(value)
    const ended = [line({ type: 'user', message: { content: 'a' } }), line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }), line({ type: 'system', subtype: 'stop_hook_summary' })]
    const waitingTool = [...ended, line({ type: 'user', message: { content: 'b' } }), line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } })]
    const gotResult = [...waitingTool, line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), '{坏的半行']
    assert.equal(turnLeftOpen(ended), false)
    assert.equal(turnLeftOpen(waitingTool), true)
    assert.equal(turnLeftOpen(gotResult), true)
    assert.equal(turnLeftOpen([]), false)
    assert.equal(turnLeftOpen([...ended, line({ type: 'user', isSidechain: true, message: { content: 'x' } })]), false, '子代理的不算')

    const write = (name, lines) => writeFile(join(root, 'project', `${name}.jsonl`), lines.join('\n'))
    await write('open', gotResult)
    await write('done', ended)
    await write('nobody', gotResult)
    const owners = new Map([['open', { sessionId: 'S1' }], ['done', { sessionId: 'S2' }]])
    const now = Date.now()
    const found = await interruptedTurns({ root, since: now - 60_000, until: now + 60_000, owners })
    assert.deepEqual(found.map(item => [item.sessionId, item.conversation]), [['S1', 'open']])
    assert.deepEqual(await interruptedTurns({ root, since: now + 60_000, until: now + 120_000, owners }), [], '时间窗外的不算')
    assert.deepEqual(await interruptedTurns({ root: join(root, '没有'), since: 0, until: now + 60_000, owners }), [])
})

test('会话间转话：结果末尾的关联编号记到这次调用的操作上，接收方的条目带着同一个；没有编号的照旧', () => {
    const parser = createProcessParser({ claudeSessionId: 'c1' })
    const at = second => new Date(Date.parse('2026-11-05T10:00:00+08:00') + second * 1000).toISOString()
    const link = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    parser.line({ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__dsh__assistant_session_send', input: { text: '第三章交给你' } }] } }, 0)
    parser.line({ type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `已交给中枢：它空闲时马上处理。它的回复照常发到用户手机。（编号 ${link}）` }] } }, 1)
    parser.line({ type: 'assistant', timestamp: at(3), message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__dsh__assistant_session_send', input: { text: 'x' } }] } }, 2)
    parser.line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: '没有发出：现在还没有中枢会话。' }] } }, 3)
    const { ops, entries } = parser.finish(4)
    assert.equal(ops[0].link, link)
    assert.match(ops[0].detail, new RegExp(`→ ${link}$`))
    assert.equal(ops[1].link, undefined, '没发出的没有编号')
    assert.deepEqual(entries, [], '发送方这边只记操作，不另记条目')
})
