/**
 * 渠道图片的共用部分：图片类型识别、回复中的本机图片引用、出站图片读取、微信 CDN 的 AES 加解密。
 *
 * 发图规则：助手回复中以 Markdown 图片写出的本机绝对路径（`![说明](D:\...\a.png)`）按图片发送，
 * 其余文字照常发送。网络地址、相对路径都按原文作为文字。
 */

import { createCipheriv, createDecipheriv } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

/** DSH 提示内容接受的图片类型。 */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 入站单张图片上限。 */
export const MAX_INBOUND_IMAGE_BYTES = 20 * 1024 * 1024

/** 出站单张图片上限。 */
export const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024

/** 出站单个文件上限。 */
export const MAX_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024

/**
 * 按文件头识别图片类型。
 * @param {Uint8Array} bytes
 * @returns {string|null} DSH 支持的 media type，不是这几类图片时为 null
 */
export function detectImageType(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
    return null
}

/**
 * 下载得到的字节转成入站图片；类型不支持或过大时返回 null。
 * @param {Uint8Array} bytes
 * @returns {{mediaType: string, data: string}|null}
 */
export function inboundImageOf(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_INBOUND_IMAGE_BYTES) return null
    const mediaType = detectImageType(bytes)
    if (mediaType === null) return null
    return { mediaType, data: Buffer.from(bytes).toString('base64') }
}

const IMAGE_REFERENCE = /!\[([^\]\n]*)\]\(\s*<?([^)<>\n]+?)>?\s*\)/g

/** 是否为本机绝对路径（Windows 盘符路径或 POSIX 绝对路径），网络地址不算。 */
function isLocalAbsolutePath(target) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return false
    return /^[A-Za-z]:[\\/]/.test(target) || (isAbsolute(target) && target.startsWith('/'))
}

/**
 * 把一段回复拆成按顺序排列的文字段与本机图片引用。
 * 不含本机图片引用时返回唯一一段原文，保证纯文字回复的切块与以前一致。
 * @param {string} text
 * @returns {Array<{kind: 'text', text: string}|{kind: 'image', path: string, alt: string}>}
 */
export function splitReplySegments(text) {
    if (typeof text !== 'string' || text === '') return []
    const segments = []
    let last = 0
    for (const match of text.matchAll(IMAGE_REFERENCE)) {
        const path = match[2].trim()
        if (!isLocalAbsolutePath(path)) continue
        const before = text.slice(last, match.index)
        if (before.trim() !== '') segments.push({ kind: 'text', text: before })
        segments.push({ kind: 'image', path, alt: match[1].trim() })
        last = match.index + match[0].length
    }
    if (segments.length === 0) return [{ kind: 'text', text }]
    const rest = text.slice(last)
    if (rest.trim() !== '') segments.push({ kind: 'text', text: rest })
    return segments
}

const FILE_LINK = /(?<!!)\[([^\]\n]+)\]\(\s*<?([^)<>\n]+?)>?\s*\)/g

/**
 * 回复里指向文件的 Markdown 链接（DSH 桌面显示为可点开的文件）在手机上只留文件名：渠道打不开本机文件，
 * 路径只是噪音。网络链接与图片引用不动。
 * @param {string} text
 * @returns {string}
 */
export function plainFileLinks(text) {
    // 两个字符以上的协议名才是网络地址；`D:` 是盘符，`file:` 也是本机文件。
    return text.replace(FILE_LINK, (whole, label, target) => (
        /^[a-z][a-z0-9+.-]+:/i.test(target.trim()) && !/^file:/i.test(target.trim()) ? whole : label
    ))
}

/**
 * 读取一张出站图片并核对类型与大小。失败时抛出带 `code` 的错误，调用方据此改发文字。
 * @param {string} path - 本机绝对路径
 * @returns {Promise<{bytes: Buffer, mediaType: string}>}
 */
export async function readOutboundImage(path) {
    const fail = (code, message) => Object.assign(new Error(message), { code })
    if (typeof path !== 'string' || !isLocalAbsolutePath(path)) throw fail('IMAGE_PATH_INVALID', '图片路径必须是本机绝对路径')
    let info
    try {
        info = await stat(path)
    } catch {
        throw fail('IMAGE_NOT_FOUND', `图片不存在：${path}`)
    }
    if (!info.isFile()) throw fail('IMAGE_NOT_FOUND', `不是文件：${path}`)
    if (info.size > MAX_OUTBOUND_IMAGE_BYTES) throw fail('IMAGE_TOO_LARGE', `图片超过 ${MAX_OUTBOUND_IMAGE_BYTES} 字节：${path}`)
    const bytes = await readFile(path)
    const mediaType = detectImageType(bytes)
    if (mediaType === null) throw fail('IMAGE_TYPE_UNSUPPORTED', `不是 PNG、JPEG、WebP 或 GIF 图片：${path}`)
    return { bytes, mediaType }
}

/**
 * 读取一个出站文件（present 交付的文件，原样发送）。失败时抛出带 `code` 的错误，调用方据此改发文字。
 * @param {string} path - 本机绝对路径
 * @returns {Promise<{bytes: Buffer, name: string}>}
 */
export async function readOutboundFile(path) {
    const fail = (code, message) => Object.assign(new Error(message), { code })
    if (typeof path !== 'string' || !isLocalAbsolutePath(path)) throw fail('FILE_PATH_INVALID', '文件路径必须是本机绝对路径')
    let info
    try {
        info = await stat(path)
    } catch {
        throw fail('FILE_NOT_FOUND', `文件不存在：${path}`)
    }
    if (!info.isFile()) throw fail('FILE_NOT_FOUND', `不是文件：${path}`)
    if (info.size === 0) throw fail('FILE_EMPTY', `文件是空的：${path}`)
    if (info.size > MAX_OUTBOUND_FILE_BYTES) throw fail('FILE_TOO_LARGE', `文件超过 ${MAX_OUTBOUND_FILE_BYTES} 字节：${path}`)
    return { bytes: await readFile(path), name: basename(path) }
}

/** 出站语音（WAV）的大小上限：几分钟的 24kHz 单声道。 */
export const MAX_OUTBOUND_VOICE_BYTES = 10 * 1024 * 1024

/**
 * 读取一段出站语音：本机 WAV，16 位单声道 PCM。失败时抛出带 `code` 的错误，调用方据此改发文字。
 * @param {string} path - 本机绝对路径
 * @returns {Promise<{bytes: Buffer, name: string}>}
 */
export async function readOutboundVoice(path) {
    const fail = (code, message) => Object.assign(new Error(message), { code })
    if (typeof path !== 'string' || !isLocalAbsolutePath(path)) throw fail('VOICE_PATH_INVALID', '语音路径必须是本机绝对路径')
    let info
    try {
        info = await stat(path)
    } catch {
        throw fail('VOICE_NOT_FOUND', `语音不存在：${path}`)
    }
    if (!info.isFile()) throw fail('VOICE_NOT_FOUND', `不是文件：${path}`)
    if (info.size > MAX_OUTBOUND_VOICE_BYTES) throw fail('VOICE_TOO_LARGE', `语音超过 ${MAX_OUTBOUND_VOICE_BYTES} 字节：${path}`)
    const bytes = await readFile(path)
    try {
        pcmOfWav(bytes)
    } catch (error) {
        throw fail('VOICE_FORMAT_UNSUPPORTED', `${error.message}：${path}`)
    }
    return { bytes, name: basename(path) }
}

/**
 * WAV 里的 PCM：只接受 16 位单声道（PCM 格式 1），按块查找 fmt 与 data。
 * @param {Uint8Array} bytes
 * @returns {{pcm: Buffer, sampleRate: number}}
 */
export function pcmOfWav(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV 文件')
    let format = null
    for (let offset = 12; offset + 8 <= buf.length;) {
        const id = buf.toString('ascii', offset, offset + 4)
        const size = buf.readUInt32LE(offset + 4)
        const body = offset + 8
        if (id === 'fmt ' && body + 16 <= buf.length) {
            format = { tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
        }
        if (id === 'data') {
            if (format === null || format.tag !== 1 || format.channels !== 1 || format.bits !== 16) throw new Error('只支持 16 位单声道 PCM 的 WAV')
            const pcm = buf.subarray(body, Math.min(body + size, buf.length))
            if (pcm.length === 0) throw new Error('WAV 里没有声音')
            return { pcm, sampleRate: format.sampleRate }
        }
        offset = body + size + (size % 2)
    }
    throw new Error('WAV 里没有 data 段')
}

/** AES-128-ECB / PKCS#7 加密（微信 CDN 上传）。 */
export function encryptAesEcb(plaintext, key) {
    const cipher = createCipheriv('aes-128-ecb', key, null)
    return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** AES-128-ECB / PKCS#7 解密（微信 CDN 下载）。 */
export function decryptAesEcb(ciphertext, key) {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** 加密后长度：PKCS#7 至少补一个字节。 */
export function aesEcbPaddedSize(size) {
    return Math.ceil((size + 1) / 16) * 16
}

/**
 * 微信入站图片的 AES 密钥：`image_item.aeskey`（十六进制）优先，否则 `media.aes_key`（base64，
 * 内容是 16 字节原始密钥或 32 位十六进制字符串）。没有密钥时返回 null（明文下载）。
 */
export function weixinImageKey(imageItem) {
    if (typeof imageItem?.aeskey === 'string' && /^[0-9a-fA-F]{32}$/.test(imageItem.aeskey)) {
        return Buffer.from(imageItem.aeskey, 'hex')
    }
    const encoded = imageItem?.media?.aes_key
    if (typeof encoded !== 'string' || encoded === '') return null
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.length === 16) return decoded
    const ascii = decoded.toString('ascii')
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex')
    throw Object.assign(new Error('微信图片密钥既不是 16 字节也不是 32 位十六进制'), { code: 'IMAGE_KEY_INVALID' })
}
