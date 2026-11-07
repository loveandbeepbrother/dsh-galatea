import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { probeEgress } from '../index.js'

/** 假代理：对 CONNECT 先答 200，随后按 `then` 处理隧道。 */
async function fakeProxy(then) {
    const server = net.createServer((socket) => {
        socket.once('data', () => {
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
            then(socket)
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

test('出口探测：没有代理时不探测', async () => {
    assert.equal(await probeEgress({}), true)
})

test('出口探测：代理不在时不通', async () => {
    const server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    assert.equal(await probeEgress({ HTTPS_PROXY: `http://127.0.0.1:${port}` }, { timeoutMs: 2000 }), false)
})

test('出口探测：代理答了 200 但远端断开，不算通', async () => {
    const proxy = await fakeProxy(socket => socket.destroy())
    try {
        assert.equal(await probeEgress({ HTTPS_PROXY: proxy.url }, { timeoutMs: 2000 }), false)
    } finally {
        proxy.close()
    }
})

test('出口探测：握手迟迟不完成按超时算不通', async () => {
    const proxy = await fakeProxy(() => {})
    try {
        assert.equal(await probeEgress({ HTTPS_PROXY: proxy.url }, { timeoutMs: 300 }), false)
    } finally {
        proxy.close()
    }
})

test('出口探测：真实出口（设 PROBE_LIVE_PROXY 时；线路偶尔丢包，三次内通一次即可）', { skip: !process.env.PROBE_LIVE_PROXY }, async () => {
    const env = { HTTPS_PROXY: process.env.PROBE_LIVE_PROXY }
    let ok = false
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) ok = await probeEgress(env)
    assert.equal(ok, true)
})
