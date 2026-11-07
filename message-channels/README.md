# Galatea 消息渠道

`@loveandbeepbrother/dsh-galatea-channels`：让你在手机上经 QQ、微信和 DSH 里的助手说话。手机上的私聊接着框架的**中枢会话**，
和 DSH 桌面上是同一段聊天、同一个人格和记忆；助手在中枢里的回复按框架定的去向发回手机。

需要先装框架 `@loveandbeepbrother/dsh-galatea`，并定好中枢（在一个说过话的会话里输入 `/hub`）。

## 两个内置渠道

| 渠道 | 怎么接 | 能收 | 限制 |
| --- | --- | --- | --- |
| QQ 官方机器人 | 设置页扫码连接你在 QQ 开放平台建的机器人 | 本人私聊 | 平台限制：每条用户消息只能回 4 次、60 分钟内有效 |
| 微信 | 设置页扫码连接（iLink Bot） | 本人私聊 | |

文字、图片都能收发；文件按各渠道能力发，发不了的改走能发的渠道，或者发成文字、发路径。

别的聊天软件可以由插件接进来，见下面“接新平台”。群也要靠这样接进来的平台：两个内置渠道只接私聊，所以只装本包时用不上群功能。

### 连接 QQ 官方机器人、微信

1. 在 DSH 插件详情页找到本插件，点对应连接卡上的“连接”。
2. 用手机扫二维码并确认；有多个机器人账号时选一个，要验证码就在页面上填。
3. 看到“已连接”后，在手机上给机器人发一条消息，看看回复。

“断开连接”只停这个渠道，不动 DSH 里的会话。登录凭据存在本机的 DSH 凭据里，页面不回显密钥。

### 群

接了支持群的平台以后，你在群里第一次说话时，中枢会收到一条说明：这个群还没接会话。告诉助手要接到哪个会话，它用 `assistant_channel_group`
绑定；之后群里你说的话进那个会话，回复发回群里。群里别人说的话不收。一个群只接一个会话，一个会话只接一个群；查看、改绑、解绑也在中枢里说，
接着群的会话自己不能解绑。想让某类群自动接上（例如按群名接到对应的会话），由别的插件经 `setGroupResolver` 设一条规则，见下面。

**当心群里的别人**：接群的会话和中枢读的是同一份记忆（包括你私下聊过、记下来的事），它的回复又发进群里，群里的人都看得到。群里有别人时，别让它接触私事；这一版还没有把私密记忆和群隔开。

## 回复发到哪

- 你从手机发来的话，回到你发来的那个渠道。
- 中枢里别的轮（你在桌面上说的、定时提醒、后台思考转来的、别的会话转来的）的回复也发到手机：按配置的先后（`replyOrder`）走，
  没配时发到你最近说话的渠道；都发不了时用你最近说话的渠道。开了 `rerouteNote` 时，没走排在第一位的渠道，消息开头会注明。
  助手判断不用告诉你时整条只写 `[不发]`，这一轮就不发。
- 框架的休息时段里（默认开，00:00–08:00、本机时区，在框架核心的 `quietHours` 里改），不是你自己说话开始的那一轮，回复攒到时段结束再发。
- 接着群的会话：回复发回它的群。
- 手机上的话常分几条发：渠道先等一会儿再一起交给助手；助手觉得你没说完时可以回 `[等待]` 再等你。

**改道**：一片消息被平台确定没发出时，渠道改走同一范围里别的渠道发出，开头注明。
**暂停**：同一个绑定连着几片被确定没发出（默认 2 片），就暂停它一阵（默认 15 分钟），这段时间选路跳过它；到点后先试一片，发出就恢复。
暂停和恢复经框架核心报出来。点过发送却没核对到的（结果不明）不重发、不改道，下一轮会告诉助手“可能已经送到”。
**断开告警**：一个渠道连不上超过 `downAlarmMinutes`（默认 10 分钟），经别的渠道告诉你一次；短暂断开马上重连上的不算，恢复后重新计。
没有别的渠道能发时就不说。

一轮之中助手可以用 `assistant_channel_send` 先发一句、先发图，不必等这一轮结束。每个绑定（每个私聊、每个群）的回复在自己的后台投递里按顺序发，
一个渠道慢不会拖住别的渠道。文字照原文发，网址也不改写。

## 给模型的工具

| 工具 | 谁能用 | 做什么 |
| --- | --- | --- |
| `assistant_channel_send` | 中枢、接群的会话、可写的外部调用方 | 一轮之中立即发到手机 |
| `assistant_session_send` | 中枢、工作会话、后台会话 | 会话之间互转：别的会话只能发给中枢；中枢可以发给指定的会话、项目会话或接群的会话 |
| `assistant_channel_group` | 中枢 | 查看、绑定、解绑群（要接了支持群的平台） |

接着渠道的会话，开头上下文里会多一段渠道约定（这个会话接着哪个渠道、回复怎么发、图片和分片的规矩），装了本包才有。

## 配置

在 profile 的 `cordis.patch.yml` 里按条目 id `message-channels-framework` 写 `config`。

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `replyOrder` | 无 | 中枢发到手机时渠道的先后（平台名，例如 `[weixin, qq]`）；没配就发到你最近说话的渠道 |
| `rerouteNote` | `false` | 中枢的话没走 `replyOrder` 第一位时，在消息开头注明是从哪个渠道改发的 |
| `downAlarmMinutes` | 10 | 一个渠道连不上多久后经别的渠道告诉你一次；0 不告诉 |
| `quotaNotices.usageWarnLevels` | `[0.8, 0.9, 0.95]` | 用量提前提醒的几档 |
| `quotaNotices.usageWarnWindows` | `['five_hour', 'seven_day']` | 看哪些额度窗口 |
| `quotaNotices.sweepMinutes` | 5 | 多久检查一次要不要发额度说明、用量提醒 |
| `health.checkMinutes` | 10 | 多久自查一次；0 不查 |
| `health.downChecks` | 2 | 已绑定的平台连续几次不是“已连接”才算断开 |
| `health.undeliveredGraceMinutes` | 2 | 回复没送到、又没能告诉会话，多久后报出来 |
| `sendPause.rejects` | 2 | 连着几片确定没发出就暂停这个绑定；0 不暂停 |
| `sendPause.minutes` | 15 | 暂停多久 |

**额度说明**：会话的执行方报告额度用完时（目前是 Agent SDK 执行方），渠道发一句固定说明（最晚几点恢复、消息都收着、不用重发），
不经模型；5 小时和本周额度过了上面几档各提醒一次。休息时段里只有你刚说的话撞上额度用完时立即说，其余等时段结束。

**自查**：已绑定的平台连续断开时自己重连一次，并经框架核心报 `channels/down`；回复没送到、现在补不了的报 `channels/undelivered`。
恢复后各报一条带 `resolved` 的。没有别的插件接手这些类别时，框架的后台思考会看到它们。

## 给别的插件留的接口

渠道提供服务 `assistantChannels`（插件里写 `inject: ['assistantChannels']`）。

- `registerPlatform({ id, label, platform, hints? })`：接一个新平台，见下面“接新平台”。返回撤销函数。
- `setGroupResolver(resolve)`：群第一次说话、还没接会话时，渠道调 `resolve({ platform, groupId, groupName })` 问要接哪个会话。
  返回 `{ sessionId, sessionTitle? }` 就接上；返回 `{ reason }`（一句说明）或 `null` 就不接，渠道把原因告诉中枢，由中枢问你以后用工具绑定；
  抛错表示这次查不了，群消息稍后重送再问。要接的会话打不开、已经接了别的群时照样不接。同一时间只能有一条规则，已有时再设会报错；
  返回撤销函数，插件停用时调用。
- 写适配器用得上的小件从 `@loveandbeepbrother/dsh-galatea-channels/media` 导入，例如 `inboundImageOf(...)`（收到的图片转成渠道认的
  `{ mediaType, data }`）。

### 接新平台

一个平台就是一个**适配器对象**，经 `registerPlatform` 登记：

```js
const dispose = ctx.assistantChannels.registerPlatform({
    id: 'demo',                                  // 平台名：小写字母开头，字母、数字、连字符；也是绑定、凭据里的名字，登记过就不要改
    label: { zh: '演示', en: 'Demo' },           // 渠道名（字符串也行）：设置页、给你看的说明里都用它
    platform: adapter,                           // 适配器，见下表
    hints: { zh: { waiting: '…', needVerify: '…' }, en: { … } },  // 可选：设置页配对时的提示，不给就用通用的
})
```

平台名已经装着、少了必需的方法、没给渠道名、已经有一个支持群的平台时再登记一个支持群的，登记都直接报错。撤销登记时渠道停掉它的连接；
绑定照旧留着，再登记同名平台接着用。设置页按登记的平台多画一张连接卡；`hints` 只认两个键：`waiting`（配对开始、等用户操作时的提示）
和 `needVerify`（等用户填验证码时的提示）。

一个平台同一时间只有一个账户（一个本人绑定），渠道同一时间只对它调一个 `listen`：上一个结束（断开或撤销）以后才会再调。

适配器要实现的：

| 成员 | 必需 | 渠道怎么用 |
| --- | --- | --- |
| `pair({ signal, onQr, onState, getVerifyCode })` | 是 | 设置页点“连接”时调。要扫码就调 `onQr(文本)`（会画成二维码），扫完调 `onState('scanned')`（渠道只认这一个状态）；要验证码就 `await getVerifyCode({ signal })` 拿用户填的码（字符串）。返回账户数组 `[{ platform, accountId, senderId, credential }]`：`senderId` 是本人（只收用户的话），`credential` 是字符串或可存成 JSON 的对象，存进 DSH 凭据，之后原样交给 `listen`、`send`。返回几个账户时设置页让用户选。配对失败就抛错，错误的 `code`（如 `BAD_VERIFY_CODE`）显示在设置页上，用户再点“连接”重来；`signal` 中止时结束即可 |
| `listen({ credential, cursor, onMessage, onReady, onLive?, onAlert?, onCursor?, signal })` | 是 | 连上并收件，一直到 `signal` 中止才结束（返回的 Promise 那时才完成）。连上了调 `onReady()`。每条本人的消息调 `onMessage(信封, 回复锚点)`，**等它返回 `{ status }`** 再向平台确认：`persisted`、`duplicate`、`rejected`、`conflict` 都算处理完，`retry` 表示没存下、稍后重送；它抛错时停止收件、把错误抛出来。连接断了就让 Promise 以错误结束，渠道按断开处理并重连。连接还在、但另一头暂时不通的，用 `onLive(false/true)` 报；不报就按连着算。`onAlert({ kind, key, text })` 把平台自己发现的异常经框架核心报出去（`kind` 是类别，`key` 是同一件事的标识）；格式核不过时传 `onAlert({ invalid: 说明 })`。`cursor`、`onCursor(下一个位置)` 给需要续收位置的平台用：`cursor` 是上次存下的字符串，收到一批之后调 `onCursor` 存新的 |
| `send({ credential, peerId, anchor, text, image?, file?, voice?, deliveryId, signal, onLateResult? })` | 是 | 发一片。`peerId` 是对方（私聊是本人 `senderId`，群是 `group:<群号>`），`anchor` 是那条消息的回复锚点。图片、文件、语音片的 `image`/`file`/`voice` 带 `bytes`（文件还有 `name`），`text` 是本机路径。成功返回 `{ kind: 'platform-accepted', platformMessageId, clientId }`：`platformMessageId` 是平台给这条的编号，`clientId` 是你自己的发送编号，没有就填 `null`。确定没发出抛带 `notSent: true` 的错误（例如还没连上），平台明确拒收抛带 `definitelyRejected: true` 的：两种都算“确定没发出”，渠道改道、计入暂停；别的错误记成结果不明，**永不自动重发**。结果不明以后才知道确定结果的，调 `onLateResult({ status: 'sent', platformMessageId })` 或 `onLateResult({ status: 'failed', code })`。渠道不会把 `sends` 里没有的内容交给它 |
| `sends` | 否 | 能发的内容：`['text', 'image', 'file', 'voice']` 的子集；不给按都能发。发不了的渠道改走别的渠道或改成文字 |
| `canDeliverNow({ live, lastInputAt, repliesLeft, repliesNeeded, now })` | 否 | 现在能不能主动发给这个人（不是回刚收到的话）；不给就当不能，只回对方的话。`live`：连着、又没报断开；`lastInputAt`：对方最近一条消息的时间（毫秒），没有时为 `null`；`now`：现在（毫秒）；`repliesLeft`、`repliesNeeded`：按条限回复次数的平台用（官方 QQ），别的平台不用管 |
| `holdsUntilNextMessage` | 否 | `true`：现在发不了的内容可以留到对方下一条消息之后再发 |
| `paceMs(part, random)` | 否 | 这一片发出前至少等多久（毫秒）。`part` 有 `partIndex`（这一批里第几片，从 0 起）、`text`（文字，或图片、文件的本机路径）、`kind`（文字片没有；`image`、`file`、`voice`）。第一片等这么久，不扣已经过去的时间；之后的从上一片发出时算。渠道在发送前的最后核对之前等：等的时候回复被撤回就不发；进程这时退出，这一片重启后照常发。所以别在 `send` 里自己等。`random` 是 [0,1) 的随机数函数 |
| `groupList({ credential })` | 否 | 提供它就算**支持群**：返回本人所在的群 `[{ groupId, name }]`（`groupId` 是裸群号，不带 `group:`）。这一版最多一个支持群的平台 |

信封（`onMessage` 的第一个参数）：`{ kind, platform, accountId, conversationId, senderId, messageId, text, images?, groupName? }`。

- 私聊：`kind: 'private'`，`conversationId` 就是本人的 `senderId`。
- 群：`kind: 'group'`，`conversationId` 是 `group:<群号>`，`senderId` 仍是本人（群里别人的话不要交），要带 `groupName`（还不知道群名时不带，
  渠道答 `retry`，稍后重送）。
- `accountId`、`senderId` 要和配对时的一样；`images` 是 `[{ mediaType, data }]`（base64）；只有图片时 `text` 可以是空串。

回复锚点（第二个参数）是一个字段都是字符串的对象，原样存下、发送时交回 `send`，可以放平台回复时要的任何东西；带 `messageId`
字段时要和信封的 `messageId` 一致。

最小的例子：一个本机演示平台，消息从 `receive()` 进来，发出去的打印出来。

```js
// demo-platform.js
export function createDemoPlatform() {
    let deliver = null
    let count = 0
    return {
        sends: ['text'],
        canDeliverNow: ({ live }) => live !== false,
        // 不扫码也不要验证码：直接认定本人。真实平台在这里调 onQr 或 getVerifyCode。
        async pair() {
            return [{ platform: 'demo', accountId: 'demo-bot', senderId: 'me', credential: { token: 'demo' } }]
        },
        listen({ onMessage, onReady, signal }) {
            return new Promise((resolve) => {
                deliver = onMessage
                onReady()
                signal.addEventListener('abort', () => {
                    deliver = null
                    resolve()
                }, { once: true })
            })
        },
        async send({ peerId, text }) {
            if (deliver === null) throw Object.assign(new Error('not connected'), { code: 'NO_CONNECTION', notSent: true })
            console.log(`→ ${peerId}: ${text}`)
            count += 1
            return { kind: 'platform-accepted', platformMessageId: `out-${count}`, clientId: null }
        },
        // 演示用：模拟本人发来一句话；返回渠道的处理结果 { status }。
        async receive(text) {
            count += 1
            const messageId = `in-${count}`
            return deliver({ kind: 'private', platform: 'demo', accountId: 'demo-bot', conversationId: 'me', senderId: 'me', messageId, text }, { messageId })
        },
    }
}

// index.js：一个 DSH 插件，把它登记进渠道
import { createDemoPlatform } from './demo-platform.js'

export const name = 'demo-platform'
export const inject = ['assistantChannels']

export function apply(ctx) {
    ctx.effect(() => ctx.assistantChannels.registerPlatform({ id: 'demo', label: '演示', platform: createDemoPlatform() }), 'demo platform')
}
```

装上以后设置页多一张“演示”的连接卡，点“连接”就配对好了。

## 存储与运行

- 存储域 `galatea_channels`（绑定、收件、发件、中枢每一轮的发送状态）；凭据存在 DSH 的凭据里，域名 `galatea-channels`。
- 拼图缓存放在 DSH home 下的 `galatea-channels/composites`。同一个 DSH home 只能有一个 Host 跑渠道（进程租约），第二个会启动失败，免得同一条消息回两遍。
- 设置页调用的路由挂在 `/api/galatea-channels/` 下，只认 DSH 的主人。
- 装了语音合成服务（`ttsSay`）时，渠道注册一个“发到聊天”的去向：能发语音的平台（官方 QQ）发语音条，别的发音频文件。

## 测试

在本目录先装依赖，再在仓库根目录跑：

```bash
pnpm install --prod --config.auto-install-peers=false   # 对等依赖由 DSH 和框架提供，不用装
node test-support/run-tests.mjs message-channels
```

第三方来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
