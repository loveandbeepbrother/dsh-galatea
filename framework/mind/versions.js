/**
 * 心智的版本与绑定：人格、长期认知、常驻记忆的正文按 sha256 去重存成版本；每个会话的每一轮、
 * 每个 Goal、会话本身各绑定一个版本，同一轮从头到尾用同一个版本，写入从下一轮生效。
 * 常驻记忆是空的版本不写这两个字段，编号也只算前两份：还没用常驻记忆的版本不变。
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
                standing: z.string().optional(),
                standingHash: z.string().optional(),
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

export const versionIdOf = (personaHash, cognitionHash, standingHash) => sha256([personaHash, cognitionHash, ...standingHash === undefined ? [] : [standingHash]].join('\u0000')).slice(0, 32)
const bindingKey = (sessionId, kind, anchor) => sha256(`${sessionId}\u0000${kind}\u0000${anchor}`)

/** 段里的正文：人格、长期认知、常驻记忆，中间空一行，空的那段省掉。 */
export function composeText({ persona, cognition, standing }) {
    return [persona, cognition, standing].map(part => String(part ?? '').trim()).filter(part => part !== '').join('\n\n')
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
            || (record.standing !== undefined && sha256(record.standing) !== record.standingHash)
            || versionIdOf(record.personaHash, record.cognitionHash, record.standingHash) !== versionId) {
            throw new Error(`心智：版本 ${versionId} 的正文和哈希对不上`)
        }
        return { ...record, standing: record.standing ?? '' }
    }

    async function ensure({ persona, cognition, standing = '' }) {
        const personaHash = sha256(persona)
        const cognitionHash = sha256(cognition)
        const standingHash = standing === '' ? undefined : sha256(standing)
        const id = versionIdOf(personaHash, cognitionHash, standingHash)
        if (versions().get(id) !== undefined) return load(id, `版本 ${id} `)
        await versions().put(id, { id, persona, cognition, personaHash, cognitionHash, ...standing === '' ? {} : { standing, standingHash } })
        return { id, persona, cognition, personaHash, cognitionHash, standing, standingHash }
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
