import test from 'node:test'
import assert from 'node:assert/strict'

import { quotaDetailOf } from '../index.js'

test('额度闸门的快照换成核心的通用形状：window 是用完的窗口，windows 只给用量占比和重置时间，不给状态', () => {
    const snapshot = {
        state: 'limited', outageId: 'qout1', since: 10, resetsAt: 20, rateLimitType: 'five_hour', model: 'opus', backlog: { s: {} },
        windows: { five_hour: { utilization: 1, resetsAt: 20, status: 'rejected' }, seven_day: { utilization: 0.4, resetsAt: 99, status: null }, broken: {} },
    }
    assert.deepEqual(quotaDetailOf(snapshot), {
        since: 10, resetsAt: 20, window: 'five_hour', outageId: 'qout1',
        windows: { five_hour: { utilization: 1, resetsAt: 20 }, seven_day: { utilization: 0.4, resetsAt: 99 } },
    })
    assert.deepEqual(quotaDetailOf({ state: 'open', windows: {} }), { since: null, resetsAt: null, window: null, outageId: null, windows: {} })
})
