/**
 * 单 Host 渠道租约。
 *
 * 官方 storageDomain 只在进程内按名字去重，两个 Host 指向同一 home 时都能 open，各自一条真实 listen 会重复回复同一条消息。
 * 这里用操作系统持有的独占资源：在由 home 路径算出的固定地址上监听——Windows 是命名管道
 * `\\.\pipe\dsh-galatea-channels-<sha1>`，其他系统是临时目录里的 unix socket。整个 Host 生命周期都开着；
 * 进程无论怎么退出，系统都会收回它，不靠 PID 文件，也就不会被 PID 复用骗到。同 home 的第二个 Host 立即失败。
 * 以前的 PID 文件锁（`channels.owner.lock`）是本插件自己的文件，取得租约前顺手删掉。
 *
 * @module @loveandbeepbrother/dsh-galatea-channels/lease
 */

import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 以前 PID 文件锁留下的文件名。 */
export const STALE_LOCK_FILE = 'channels.owner.lock'

/** 获取或释放失败的稳定 code，客户端按它显示对应提示。 */
const OWNER_UNAVAILABLE = 'CHANNEL_OWNER_UNAVAILABLE'

/** 丢失所有权时的稳定错误：不带路径、不带底层的 message。 */
function ownerUnavailable() {
    const error = new Error('galatea-channels: the channel owner lease is unavailable')
    error.code = OWNER_UNAVAILABLE
    return error
}

/**
 * 租约的系统地址：由租约目录（home 下的固定目录）算出，同一个 home 总是同一个地址。Windows 路径不分大小写。
 * @param rootDirectory - 租约目录（绝对路径）。
 */
export function leaseAddress(rootDirectory) {
    const path = resolve(rootDirectory)
    const digest = createHash('sha1').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex')
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\dsh-galatea-channels-${digest}`
        : join(tmpdir(), `dsh-galatea-channels-${digest}.sock`)
}

/** 在地址上开始监听；失败时给出系统错误码。 */
function listenOn(address) {
    return new Promise((done) => {
        const server = net.createServer(socket => socket.destroy())
        const onError = (error) => {
            server.close()
            done({ error })
        }
        server.once('error', onError)
        server.listen(address, () => {
            server.off('error', onError)
            done({ server })
        })
    })
}

/** unix socket 文件还在、但没有进程在听（持有者死了留下的）：连一下就知道。Windows 命名管道不会留下。 */
function abandoned(address) {
    if (process.platform === 'win32') return Promise.resolve(false)
    return new Promise((done) => {
        const socket = net.connect(address)
        socket.once('connect', () => {
            socket.destroy()
            done(false)
        })
        socket.once('error', error => done(error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT'))
    })
}

/**
 * 在 rootDirectory 上取得单 Host 租约。
 *
 * @param rootDirectory - 绝对目录；不存在时按该确定路径创建。
 * @param options - `signal` 取消时不再获取；`address` 只给测试换地址。
 * @returns `{ release() }`：release 幂等，关掉监听后兑现。
 */
export async function acquireChannelLease(rootDirectory, options = {}) {
    if (typeof rootDirectory !== 'string' || rootDirectory === '' || !isAbsolute(rootDirectory)) {
        throw new TypeError('galatea-channels: the lease root must be an absolute path')
    }
    const signal = options?.signal
    if (signal?.aborted) throw ownerUnavailable()
    try {
        await mkdir(rootDirectory, { recursive: true })
        // 以前的 PID 文件锁：本插件自己的文件，不再使用。
        await rm(join(rootDirectory, STALE_LOCK_FILE), { force: true })
    } catch {
        // 目录建不出来同样等于拿不到所有权。
        throw ownerUnavailable()
    }

    const address = options?.address ?? leaseAddress(rootDirectory)
    let { server, error } = await listenOn(address)
    if (error?.code === 'EADDRINUSE' && await abandoned(address)) {
        await rm(address, { force: true }).catch(() => {})
        ;({ server, error } = await listenOn(address))
    }
    if (server === undefined) throw ownerUnavailable()
    if (signal?.aborted) {
        await new Promise(done => server.close(() => done()))
        throw ownerUnavailable()
    }
    // 不因为它让进程多活：Host 关闭时由 release 关掉，进程退出时系统收回。
    server.unref()

    let releasing = null
    return {
        release() {
            releasing ??= new Promise(done => server.close(() => done()))
            return releasing
        },
    }
}
