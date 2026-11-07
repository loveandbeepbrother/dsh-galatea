/** Development-only regression for the channel connection card. */

/**
 * 二维码刷新定向回归（development_fake）。
 *
 * 只加载真实的 `client.js`：用 node:vm 造一个没有 `document` 的干净上下文，让
 * `window.__ModuleLoader__.load` 交出 registration，再用极小的 React / primitives
 * shim 执行 `apply` 并直接调用 `ChannelCard`。不跑副作用、不发请求、不触真平台。
 *
 * 断言的是页面的可见契约：QR 版本号（`channel.qrRevision`）决定是否出图与是否换图，
 * `src` 只带身份与版本，永远不带二维码明文。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** development_fake 诱饵：真实 QR 明文，任何 src 或查询参数里都不许出现。 */
const QR_SECRET = 'qr-pair-value'

/** development_fake React：只提供 client.js 用到的钩子，副作用一律不执行。 */
function createReactShim(recorded) {
    return {
        createElement(type, props, ...children) {
            const element = { type, props: props ?? {}, children }
            recorded.push(element)
            return element
        },
        // 组件按纯函数渲染：useState 只回一个当前值与空 setter。
        useState(initial) {
            return [typeof initial === 'function' ? initial() : initial, () => {}]
        },
        useRef(initial) {
            return { current: initial }
        },
        useEffect() {
            // development_fake：轮询、定时器与 abort 都不跑。
        },
    }
}

/**
 * 加载真实 client.js 并执行 `apply`，拿到详情页组件与它渲染出的元素记录。
 *
 * 上下文里没有 `document`：样式 effect 按生产源码自己跳过，翻译器退回中文，
 * 因此这里也不需要 navigator 或任何其它浏览器 stub。
 */
function loadPage() {
    const elements = []
    const react = createReactShim(elements)
    // development_fake primitives：只要能与普通元素区分即可，渲染不需要真实样式。
    const primitives = { Button: 'test:Button', Input: 'test:Input' }

    let registration = null
    const sandbox = {
        window: {
            __ModuleLoader__: {
                load(config) {
                    registration = config
                },
            },
        },
    }
    vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
    assert.ok(registration !== null, 'client.js 应经 window.__ModuleLoader__.load 注册')
    // 模块 id 必须是本包的包名。
    assert.equal(registration.id, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name)

    const plugin = registration.factory(name => {
        if (name === 'react') return react
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
        throw new Error(`client.js 请求了未提供的依赖：${name}`)
    })
    assert.deepEqual([...plugin.inject], ['slots'])

    let Page = null
    const noop = () => {}
    let slotKey
    plugin.apply({
        effect(run) {
            run()
        },
        slots: {
            inject(_slot, factory) {
                return factory()
            },
            register(slot, component) {
                Page = component
                slotKey = slot?.key
                return noop
            },
        },
    })
    assert.equal(typeof Page, 'function', 'apply 应把详情页注册进 plugins.bundle.config')
    // 详情页插槽的键必须是本包的包名，对不上时页面注册了却永远不显示、也不报错。
    assert.equal(slotKey, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name)
    return { Page, elements }
}

/** 元素树里第一个名字为 ChannelCard 的函数类型：QQ 与微信共用的那张卡。 */
function channelCardType(elements) {
    for (const element of elements) {
        if (typeof element.type === 'function' && element.type.name === 'ChannelCard') return element.type
    }
    return null
}

/** 递归收集 img 元素（children 可能是嵌套数组）。 */
function imagesIn(node) {
    const found = []
    const walk = value => {
        if (value === null || value === undefined || typeof value !== 'object') return
        if (Array.isArray(value)) {
            for (const item of value) walk(item)
            return
        }
        if (value.type === 'img') found.push(value)
        for (const child of value.children ?? []) walk(child)
    }
    walk(node)
    return found
}

test('二维码刷新：版本 0 不出图，版本变化才换 src，URL 只带身份与版本', () => {
    const { Page, elements } = loadPage()

    elements.length = 0
    Page()
    const ChannelCard = channelCardType(elements)
    assert.equal(typeof ChannelCard, 'function', '详情页应渲染 ChannelCard')
    elements.length = 0

    // 尝试仍在进行（phase/attemptId 都在）：出不出图只由 qrRevision 决定。
    const channelOf = qrRevision => ({
        phase: 'waiting',
        connected: false,
        pairAttemptId: 'attempt-1',
        choices: [],
        qrRevision,
        // development_fake 诱饵：真实 QR 明文不许进 src。
        qrText: QR_SECRET,
    })

    const render = qrRevision => {
        elements.length = 0
        const tree = ChannelCard({
            t: key => key,
            platform: 'weixin',
            label: '微信',
            busy: '',
            channel: channelOf(qrRevision),
        })
        return imagesIn(tree)
    }

    // 还没有二维码：一张图都不出，页面只显示“正在获取二维码”。
    assert.equal(render(0).length, 0, 'qrRevision=0 不得渲染二维码 img')

    const first = render(1)
    assert.equal(first.length, 1, 'qrRevision=1 应渲染一张二维码')
    const firstSrc = first[0].props.src
    assert.equal(typeof firstSrc, 'string')
    assert.equal(first[0].props.alt, 'qrAlt', 'alt 走字典，不拼二维码内容')

    // 同一版本号重复渲染：src 一个字符都不变（不重复下载，也不闪一下）。
    const again = render(1)
    assert.equal(again.length, 1)
    assert.equal(again[0].props.src, firstSrc, '同一 qrRevision 的 src 必须稳定')

    // 版本变化：src 必须变，浏览器才会丢掉旧图重新取。
    const second = render(2)
    assert.equal(second.length, 1, 'qrRevision=2 仍是一张二维码')
    const secondSrc = second[0].props.src
    assert.notEqual(secondSrc, firstSrc, 'qrRevision 变化必须换 src')

    for (const [qrRevision, src] of [[1, firstSrc], [2, secondSrc]]) {
        assert.ok(!src.startsWith('data:'), `revision=${qrRevision} 不得内联二维码负载`)
        assert.ok(!src.includes(QR_SECRET), `revision=${qrRevision} 的 src 不得含二维码明文`)
        const url = new URL(src, 'https://dsh.invalid/')
        assert.equal(url.searchParams.get('platform'), 'weixin', `revision=${qrRevision} 保留 platform`)
        assert.equal(url.searchParams.get('attemptId'), 'attempt-1', `revision=${qrRevision} 保留 attemptId`)
        assert.equal(url.searchParams.get('revision'), String(qrRevision), `revision=${qrRevision} 携带版本`)
        for (const value of url.searchParams.values()) {
            assert.ok(!value.includes(QR_SECRET), `revision=${qrRevision} 的查询参数不得含二维码明文`)
        }
    }
})

/** 递归收集元素树里的文字。 */
function textsIn(node) {
    const found = []
    const walk = value => {
        if (value === null || value === undefined) return
        if (typeof value === 'string') {
            found.push(value)
            return
        }
        if (typeof value !== 'object') return
        if (Array.isArray(value)) {
            for (const item of value) walk(item)
            return
        }
        if (typeof value.props?.placeholder === 'string') found.push(value.props.placeholder)
        for (const child of value.children ?? []) walk(child)
    }
    walk(node)
    return found
}

test('登记的平台的卡片：配对提示照登记时给的（按页面语言取，没有就用通用的）；没有二维码时不出图', () => {
    const { Page, elements } = loadPage()
    elements.length = 0
    Page()
    const ChannelCard = channelCardType(elements)
    const t = Object.assign(key => key, { language: 'en' })
    const hints = { zh: { waiting: '先发一句话', needVerify: '填回你的验证码' }, en: { waiting: 'Send a message first', needVerify: 'Enter the code it sent you' } }
    const render = (phase, extra = {}) => ChannelCard({
        t,
        platform: 'chat',
        label: '测试聊天',
        busy: '',
        channel: { phase, connected: false, pairAttemptId: 'attempt-1', choices: [], qrRevision: 0, hints, ...extra },
    })
    const waiting = render('pairing')
    assert.equal(imagesIn(waiting).length, 0)
    assert.ok(textsIn(waiting).includes('Send a message first'))
    const verify = render('need-verify')
    assert.ok(textsIn(verify).includes('Enter the code it sent you'))
    assert.ok(!textsIn(verify).includes('needVerify'), '不用通用的提示')
    assert.ok(textsIn(render('need-verify', { hints: null })).includes('needVerify'), '没给提示时用通用的')
})

test('支持群的平台的卡片列出已接的群：群名 → 会话，会话不在了时注明；每个群一个解绑按钮，按群号解绑', () => {
    const { Page, elements } = loadPage()
    elements.length = 0
    Page()
    const ChannelCard = channelCardType(elements)
    const unbound = []
    const card = ChannelCard({
        t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
        platform: 'chat',
        label: '测试聊天',
        busy: false,
        onUnbindGroup: groupId => unbound.push(groupId),
        channel: {
            phase: 'connected',
            connected: true,
            pairAttemptId: null,
            choices: [],
            qrRevision: 0,
            groups: [
                { groupId: '777', name: '项目-远航', session: '远航·项目会话', sessionId: 's1', gone: null },
                { groupId: '888', name: '闲聊', session: '示例书', sessionId: 's2', gone: 'archived' },
            ],
        },
    })
    const found = []
    const walk = (value) => {
        if (value === null || value === undefined || typeof value !== 'object') return
        if (Array.isArray(value)) {
            for (const item of value) walk(item)
            return
        }
        found.push(value)
        for (const child of value.children ?? []) walk(child)
    }
    walk(card)
    const texts = found.flatMap(node => node.children.filter(child => typeof child === 'string'))
    assert.ok(texts.includes('group:{"group":"项目-远航","session":"远航·项目会话"}'))
    assert.ok(texts.includes('groupGone:{"group":"闲聊","session":"示例书"}'))
    const buttons = found.filter(node => node.type === 'test:Button' && node.children.includes('unbindGroup'))
    assert.equal(buttons.length, 2)
    buttons[1].props.onClick()
    assert.deepEqual(unbound, ['888'])
})
