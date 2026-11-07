/**
 * 心智的版本与绑定：人格、长期认知的正文按 sha256 去重存成版本；每个会话的每一轮、
 * 每个 Goal、会话本身各绑定一个版本，同一轮从头到尾用同一个版本，写入从下一轮生效。
 *
 * @module @loveandbeepbrother/dsh-galatea/mind/versions
 */

import { createHash } from 'node:crypto'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const KINDS = Object.freeze(['turn', 'goal', 'session'])

export const mindDomainSpec = defineDomain({
    name: 'mind_framework_mind',
    version: 1,
    layout: 'per-record',
    tables: {
        versions: {
            valueSchema: z.object({
                id: z.string(),
                persona: z.string(),
                cognition: z.string(),
                personaHash: z.string(),
                cognitionHash: z.string(),
            }).strict(),
        },
        bindings: {
            valueSchema: z.object({
                sessionId: z.string(),
                kind: z.enum(KINDS),
                turn: z.number().nullable(),
                turnStartSeq: z.number().nullable(),
                goalId: z.string().nullable(),
                versionId: z.string(),
            }).strict(),
        },
    },
})

const sha256 = text => createHash('sha256').update(text).digest('hex')

export const versionIdOf = (personaHash, cognitionHash) => sha256(`${personaHash}\u0000${cognitionHash}`).slice(0, 32)
const bindingKey = (sessionId, kind, anchor) => sha256(`${sessionId}\u0000${kind}\u0000${anchor}`)

/** 段里的正文：人格、空一行、长期认知，空的那段省掉。 */
export function composeText({ persona, cognition }) {
    return [persona, cognition].map(part => String(part ?? '').trim()).filter(part => part !== '').join('\n\n')
}

/** @param domain - 已打开的 `mindDomainSpec` 存储域。 */
export function createVersions(domain) {
    const versions = () => domain.table('versions')
    const bindings = () => domain.table('bindings')

    /** 读一个版本并核对正文和哈希；缺了、对不上都抛错，不悄悄改用当前文件。 */
    function load(versionId, origin) {
        const record = versions().get(versionId)
        if (record === undefined) throw new Error(`心智：${origin}指向的版本 ${versionId} 正文缺失`)
        if (sha256(record.persona) !== record.personaHash || sha256(record.cognition) !== record.cognitionHash
            || versionIdOf(record.personaHash, record.cognitionHash) !== versionId) {
            throw new Error(`心智：版本 ${versionId} 的正文和哈希对不上`)
        }
        return record
    }

    async function ensure({ persona, cognition }) {
        const personaHash = sha256(persona)
        const cognitionHash = sha256(cognition)
        const id = versionIdOf(personaHash, cognitionHash)
        if (versions().get(id) !== undefined) return load(id, `版本 ${id} `)
        const record = { id, persona, cognition, personaHash, cognitionHash }
        await versions().put(id, record)
        return record
    }

    const anchorOf = (kind, { turnStartSeq, goalId }) => (kind === 'turn' ? turnStartSeq : kind === 'goal' ? goalId : 'session')

    function binding(sessionId, kind, anchor) {
        return bindings().get(bindingKey(sessionId, kind, kind === 'session' ? 'session' : anchor))
    }

    /** 写一个绑定；已有同一个版本时不写，已有别的版本时抛错（固定了就不换）。 */
    async function bind(sessionId, kind, { turn = null, turnStartSeq = null, goalId = null }, versionId) {
        const anchor = anchorOf(kind, { turnStartSeq, goalId })
        const existing = binding(sessionId, kind, anchor)
        if (existing !== undefined) {
            if (existing.versionId !== versionId) throw new Error(`心智：会话 ${sessionId} 的${kind}绑定已经是版本 ${existing.versionId}，不能换成 ${versionId}`)
            return false
        }
        await bindings().put(bindingKey(sessionId, kind, anchor), { sessionId, kind, turn, turnStartSeq, goalId, versionId })
        return true
    }

    return Object.freeze({ load, ensure, binding, bind })
}
