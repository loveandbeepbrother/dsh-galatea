/**
 * 人格候选的纯逻辑：编号、确认口令、候选文件的格式（和旧的 mind-writes 相同，已有的候选文件照样读得出）。
 *
 * @module @loveandbeepbrother/dsh-galatea/mind/candidates
 */

import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CANDIDATE_CODE = /^[0-9A-HJKMNP-TV-Z]{4}$/
export const STATES = Object.freeze(['pending', 'withdrawn', 'stale', 'confirmed'])

/** 候选编号：4 位，便于用户在手机上回复。 */
export function candidateCode(random = randomBytes(4)) {
    let code = ''
    for (let index = 0; index < 4; index += 1) code += CROCKFORD[random[index] % 32]
    return code
}

/** 默认的确认口令。 */
export const confirmPhrase = code => `确认人格 ${code}`

/** 一段话里有没有对这个候选的确认：去掉空白、不分大小写比口令。 */
export function confirms(text, code, phrase = confirmPhrase) {
    const compact = value => String(value ?? '').replace(/\s+/g, '').toUpperCase()
    return compact(text).includes(compact(phrase(code)))
}

/** 候选文件：头部 `code`、`baseHash`、`created`（毫秒）、`summary`、`state`，后面是完整的新人格。 */
export function formatCandidate({ code, baseHash, created, summary, state = 'pending', body }) {
    return [
        '---',
        `code: ${code}`,
        `baseHash: ${baseHash ?? ''}`,
        `created: ${created}`,
        `summary: ${String(summary).replace(/\s+/g, ' ').trim()}`,
        `state: ${state}`,
        '---',
        '',
        body,
    ].join('\n')
}

export function parseCandidate(text) {
    const normalized = String(text).replace(/^﻿/, '')
    const end = normalized.indexOf('\n---', 4)
    if (!normalized.startsWith('---') || end < 0) return null
    const fields = {}
    for (const line of normalized.slice(4, end).split(/\r?\n/)) {
        const match = /^(\w+):\s*(.*)$/.exec(line)
        if (match) fields[match[1]] = match[2].trim()
    }
    const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1).replace(/^\r?\n/, '')
    return { code: fields.code, baseHash: fields.baseHash || null, created: Number(fields.created), summary: fields.summary ?? '', state: fields.state, body }
}

/** 只改候选文件里的状态那一行。 */
export const withState = (text, state) => String(text).replace(/^state: pending$/m, `state: ${state}`)
