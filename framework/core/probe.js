/**
 * 体检调用的标记：Watchdog 这类体检用 `toolEndpoint.open(sessionId, { probe: true })` 开的令牌，经它调的工具在这个异步上下文里跑，
 * `core.caller` 认出的调用方带 `probe: true`。使用统计这类记账的地方据此不计数，免得每半小时一次的体检把统计灌水。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/probe
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export const probeCalls = new AsyncLocalStorage()

/** 现在是不是体检令牌发起的调用。 */
export const inProbe = () => probeCalls.getStore() === true
