/**
 * 渠道租约测试：真实的命名管道（Windows）或 unix socket，测试自己建的临时目录。
 *
 * 不碰用户的 home，只结束测试自己起的子进程。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { STALE_LOCK_FILE, acquireChannelLease, leaseAddress } from '../lease.js'

/** 测试自己的目录，结束时删掉。 */
async function ownedRoot(t) {
    const root = await mkdtemp(join(tmpdir(), 'channels-lease-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    return root
}

/** 拿不到租约时的稳定 code。 */
function ownerUnavailable(error) {
    assert.equal(error.code, 'CHANNEL_OWNER_UNAVAILABLE')
    return true
}

test('同一个 home 只有一个持有者：持有期间第二个立即失败，释放后才能取得', async (t) => {
    const root = await ownedRoot(t)
    const first = await acquireChannelLease(root)
    await assert.rejects(acquireChannelLease(root), ownerUnavailable)

    await first.release()
    // 重复释放安全。
    await first.release()

    const second = await acquireChannelLease(root)
    await assert.rejects(acquireChannelLease(root), ownerUnavailable)
    await second.release()
    const third = await acquireChannelLease(root)
    await third.release()
})

test('持有者进程无论怎么结束，系统都收回租约：不靠 PID 文件，不会被 PID 复用骗到', async (t) => {
    const root = await ownedRoot(t)
    const module = pathToFileURL(join(import.meta.dirname, '..', 'lease.js')).href
    const child = spawn(process.execPath, ['-e', `import(${JSON.stringify(module)}).then(m => m.acquireChannelLease(${JSON.stringify(root)})).then(() => { console.log('held'); setInterval(() => {}, 1000) })`], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    t.after(() => child.kill())
    await new Promise((done, fail) => {
        child.stdout.on('data', chunk => (String(chunk).includes('held') ? done() : undefined))
        child.once('exit', code => fail(new Error(`子进程提前退出：${code}`)))
    })
    await assert.rejects(acquireChannelLease(root), ownerUnavailable, '别的进程持有时拿不到')
    child.kill('SIGKILL')
    await new Promise(done => child.once('exit', done))
    const after = await acquireChannelLease(root)
    await after.release()
})

test('以前 PID 文件锁留下的 channels.owner.lock 是自己的文件，取得租约前删掉', async (t) => {
    const root = await ownedRoot(t)
    await writeFile(join(root, STALE_LOCK_FILE), JSON.stringify({ pid: process.pid }))
    const lease = await acquireChannelLease(root)
    await assert.rejects(access(join(root, STALE_LOCK_FILE)), { code: 'ENOENT' })
    await lease.release()
})

test('地址由 home 下的租约目录算出：同一目录同一地址（Windows 不分大小写），不同目录不同地址', () => {
    const a = leaseAddress('D:/Home/personal-assistant')
    assert.equal(leaseAddress('D:/Home/personal-assistant'), a)
    assert.notEqual(leaseAddress('D:/Other/personal-assistant'), a)
    if (process.platform === 'win32') {
        assert.match(a, /^\\\\\.\\pipe\\dsh-galatea-channels-[0-9a-f]{40}$/)
        assert.equal(leaseAddress('d:/home/PERSONAL-ASSISTANT'), a)
    }
})

test('租约目录必须是绝对路径；取消时不取得', async (t) => {
    await assert.rejects(acquireChannelLease('relative/channels'), error => error instanceof TypeError)
    const root = await ownedRoot(t)
    await assert.rejects(acquireChannelLease(root, { signal: AbortSignal.abort() }), ownerUnavailable)
    const lease = await acquireChannelLease(root)
    await lease.release()
})
