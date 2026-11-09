/**
 * 给模型看的时间：按给定时区写、带偏移（夏令时、半小时偏移都对）；相对时间；我们给出的串和模型常写的几种都能解析回来，
 * 不带偏移的按给定时区，不按进程本地时区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { agoText, arrivalText, clockSecondsText, clockText, parseTimeText } from '../core/time.js'
import { ulidTime, ulid } from '../memory/store.js'

const AT = Date.parse('2026-11-08T01:24:05Z')

test('写法：按给定时区、带偏移；夏令时和半小时偏移；到达时刻带星期', () => {
    assert.equal(clockText(AT, 'Asia/Shanghai'), '2026-11-08 09:24+08:00')
    assert.equal(clockText(AT, 'Asia/Tokyo'), '2026-11-08 10:24+09:00')
    assert.equal(clockText(AT, 'Asia/Kolkata'), '2026-11-08 06:54+05:30')
    assert.equal(clockText(Date.parse('2026-07-01T12:00:00Z'), 'America/New_York'), '2026-07-01 08:00-04:00', '夏令时')
    assert.equal(clockText(Date.parse('2026-12-01T12:00:00Z'), 'America/New_York'), '2026-12-01 07:00-05:00')
    assert.equal(clockText(AT, 'UTC'), '2026-11-08 01:24+00:00')
    assert.equal(clockSecondsText(AT, 'Asia/Shanghai'), '2026-11-08 09:24:05+08:00')
    assert.equal(arrivalText(AT, 'Asia/Shanghai'), '11-08 周日 09:24 +08:00')
    assert.equal(arrivalText(Date.parse('2026-11-07T16:30:00Z'), 'Asia/Shanghai'), '11-08 周日 00:30 +08:00', '按给定时区跨日')
})

test('相对时间：刚才、分钟、小时、天、月、年；将来的写“后”', () => {
    const now = AT
    assert.equal(agoText(now - 20_000, now), '刚才')
    assert.equal(agoText(now - 5 * 60_000, now), '5 分钟前')
    assert.equal(agoText(now - 3 * 3_600_000, now), '3 小时前')
    assert.equal(agoText(now - 2 * 86_400_000, now), '2 天前')
    assert.equal(agoText(now - 90 * 86_400_000, now), '3 个月前')
    assert.equal(agoText(now - 800 * 86_400_000, now), '2 年前')
    assert.equal(agoText(now + 2 * 3_600_000, now), '2 小时后')
})

test('解析：我们给出的串原样传回来是同一刻；Z、+0800、T 都认；不带偏移的按给定时区，不看进程时区', () => {
    for (const timezone of ['Asia/Shanghai', 'America/New_York', 'Asia/Kolkata']) {
        assert.equal(parseTimeText(clockSecondsText(AT, timezone), 'UTC'), AT, `${timezone} 带秒的原样传回`)
        assert.equal(parseTimeText(clockText(AT, timezone), 'UTC'), AT - 5_000, `${timezone} 到分的原样传回，落在那一分开头`)
    }
    assert.equal(parseTimeText('2026-11-08T01:24:05Z', 'Asia/Shanghai'), AT)
    assert.equal(parseTimeText('2026-11-08 09:24:05 +0800', 'UTC'), AT)
    assert.equal(parseTimeText('2026-11-08T09:24:05.000+08:00', 'UTC'), AT)
    assert.equal(parseTimeText('2026-11-08 09:24:05', 'Asia/Shanghai'), AT, '不带偏移按给定时区')
    assert.equal(parseTimeText('2026-11-07 20:24:05', 'America/New_York'), AT)
    assert.equal(parseTimeText('2026-11-08', 'Asia/Shanghai'), Date.parse('2026-11-07T16:00:00Z'), '只有日期：那一天在给定时区的零点')
    assert.equal(parseTimeText('2026-03-08 03:30', 'America/New_York'), Date.parse('2026-03-08T07:30:00Z'), '夏令时刚开始的那天')
    assert.ok(Number.isNaN(parseTimeText('不是时间', 'UTC')))
})

test('ULID 里能解出生成时刻（便签的创建时间从这里来）', () => {
    assert.equal(ulidTime(ulid(AT)), AT)
    assert.ok(Number.isNaN(ulidTime('不是编号')))
})
