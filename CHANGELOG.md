# 变更记录 / Changelog

## 0.1.0-preview.4

四个包统一到 0.1.0-preview.4。改了框架 `dsh-galatea`、`dsh-galatea-agent-sdk`、渠道 `dsh-galatea-channels`；`dsh-galatea-project-tasks` 只改了注释。

- **修正：框架的压缩引擎以前并没有真正接管压缩。** 之前的版本和文档说框架的引擎替代上游的 `compaction-basic`，只能有一个。这不对：DSH 的 web 预设里每个都带着一份，框架只停用了顶层那一行。预设里那份一直在工作，所以在 web 和桌面版上：
  - profile 里给 `mind-framework-compaction` 配的 `modelPolicies` 和兜底压缩线（`fallbackCompactAt`），对预设里那份都没有生效，它按上游默认的窗口八成压缩；
  - 外部执行方的会话到了那条线，还是会被它用模型摘要；从外部执行方切到原生模型时也是它先压，历史太长就会失败（`MODEL_SWITCH_COMPACTION_FAILED`）。

  现在框架在运行时接管这些实例：它们不再自动压缩（步间压力、切模型、溢出恢复），`/compact` 转到框架的引擎；外部执行方的会话 DSH 侧不做压缩，`/compact` 交给执行方自己。配置的线从这一版起才真正生效，升级后压缩的时机可能和以前不同。
- **渠道读得到引用了。** QQ 官方和微信引用一条消息时，以前引用的内容会丢。现在用户的话前面多一行：引用的是我们发过的，写开头和编号（`〔引用你发的：开头…，全文见 dsh:<会话>:<序号>〕`）；对不上的写开头，什么都没有就写“引用了一条消息”。适配器在信封上交 `quote`（`{ platformMessageId?, refIdx?, text?, label?, image? }`），投递记录的回执多了可选的 `refIdx`。
- **休息时段攒着的回复，过时了不再发。** 到点时，如果用户之后说过话，或者之后已经有话发到用户手上，这一条就丢弃。休息时段要打破休息，用 `assistant_channel_send`。
- **用户从渠道说的话，模型看得到从哪来。** 带 `via` 的本人消息开头多一行，比如“（来自 QQ 私聊）”，原文记在 `source.annotation`，读的人照旧准确去掉；桌面上说的不标。以 `/` 开头的消息交给 Claude Code 时不带这一行，它只认开头的 `/` 是命令。
- **交接是会话一级的事。**
  - 执行方换新对话以后，框架在 DSH 记录里落一个交接边界，交接文档换掉之前的记录，不调模型。Claude Code 自己压缩过以后也落一个，正文是它的摘要。
  - 每个边界写一条插件记录 `plugin:mind-framework/boundary`，种类（`handoff`、`switch`、`auto-compact`、`compact`）看这条记录，不看摘要的文字。
  - 执行方自己压缩的摘要（`auto-compact`、`compact`）经 `context.land` 请框架落边界时，要用 `by` 写明是哪个执行方写的；到落下时请求已经路由到别的执行方，这份摘要就不落。
  - 换新对话以后带上交接之前最近几轮的原文，放在交接文档后面：只有用户的话和助手回复的最终文字，超过上限从最旧的截并写明。默认 5 轮、8000 字，上下文模块的 `recentTurns`、`recentChars` 可以改，0 不带。
  - 以前 DSH 记录一直在长，从 Claude Code 切到原生模型时会因为压不下去而失败（`MODEL_SWITCH_COMPACTION_FAILED`）。
- **外部执行方的会话，DSH 侧不再做压力压缩。** 从外部执行方切到原生、历史放不下时，先请原来的执行方写交接（新的可选能力 `handoffTurn`）。写不了时，按目标模型的线裁剪最近的记录，并写明省略了多少。
- **agent-sdk 认得 DSH 边界**（新的可选能力 `boundary.landed`）。交过的最后一条被边界换掉以后，以边界为锚接着交，不再整段从头交接。
- **辅助请求**（标题、压缩）平铺消息时，运行时快照只放最新一份，文件块放占位。
- **执行方的可选能力缺失**改成每项一条、只在缺失的集合变化时报。以前是每次启动都把同样几条重报一遍。
- **定时工具的声明**换成 DSH 0.2.2 的名字：`schedule_view` 是读，`schedule_edit` 是写。
- **渠道的通知结果。** 没接群返回 `skipped`（`NO_GROUP`），不再报"没发出"；接着群、但群接的会话不在了，才是 `failed`（`GROUP_GONE`）。

## 0.1.0-preview.4 (English)

All four packages are now 0.1.0-preview.4. Changed the framework `dsh-galatea`, `dsh-galatea-agent-sdk` and the channels package `dsh-galatea-channels`. `dsh-galatea-project-tasks` only had a comment changed.

- **Fix: the framework's compaction engine had not really taken over compaction.** Earlier versions and docs said the framework's engine replaces the upstream `compaction-basic` and that only one can exist. That was wrong: each of DSH's web presets carries its own copy, and the framework only disabled the top-level row. The preset copy kept working, so on web and desktop:
  - `modelPolicies` and the fallback line (`fallbackCompactAt`) configured for `mind-framework-compaction` never applied to the preset copy, which compacts at the upstream default of 80% of the window;
  - sessions on an external executor were still summarized through the model by that copy once they reached its line, and it also ran first when switching from an external executor to a native model, failing with `MODEL_SWITCH_COMPACTION_FAILED` when the history was too long.

  The framework now takes these instances over at runtime: they no longer compact on their own (step pressure, model switch, overflow recovery), and their `/compact` goes to the framework's engine. Sessions on an external executor get no DSH-side compaction, and `/compact` goes to the executor itself. The configured lines take effect for the first time in this version, so compaction may happen at different points after upgrading.
- **Channels now read quotes.** When the user quoted a message on the QQ official bot or WeChat, the quoted content used to be lost. Their message now starts with one more line: for a message we sent, its beginning and an id (`〔引用你发的：开头…，全文见 dsh:<session>:<seq>〕`); otherwise its beginning; and "引用了一条消息" when nothing else is known. Adapters pass `quote` on the envelope (`{ platformMessageId?, refIdx?, text?, label?, image? }`), and delivery receipts gain an optional `refIdx`.
- **Replies held during quiet hours are dropped once they're stale.** When quiet hours end, a held reply is discarded if the user has spoken since, or if something else has already been sent to them since. To break quiet hours, use `assistant_channel_send`.
- **The model can see which channel a user message came from.** A user's own message with a `via` starts with one extra line, such as "（来自 QQ 私聊）". The line is recorded in `source.annotation`, so readers remove it exactly as before. Messages typed on the desktop get no line. Messages starting with `/` reach Claude Code without the line, because it only treats a leading `/` as a command.
- **Handoff is session-level.**
  - After an executor starts a new conversation, the framework lands a handoff boundary in the DSH record: the handoff document replaces the earlier records, with no model call. After Claude Code compacts on its own, it lands one too, with Claude Code's summary as the text.
  - Each boundary writes a plugin record `plugin:mind-framework/boundary`. Its kind (`handoff`, `switch`, `auto-compact`, `compact`) comes from that record, not from the summary text.
  - When an executor asks `context.land` to record its own compaction summary (`auto-compact`, `compact`), it must name itself with `by`. If requests have been routed to another executor by the time the boundary would land, the summary is dropped.
  - A new conversation after a handoff also gets the verbatim text of the most recent turns, placed after the handoff document: only the user's words and the assistant's final replies, cut from the oldest when over the limit, with a note saying so. The default is 5 turns and 8000 characters. Change it with the context module's `recentTurns` and `recentChars`; 0 turns it off.
  - Previously the DSH record kept growing, and switching from Claude Code to a native model failed (`MODEL_SWITCH_COMPACTION_FAILED`).
- **No DSH-side pressure compaction for external executors.** When switching from one to a native model and the history doesn't fit, the framework first asks the previous executor to write a handoff (new optional capability `handoffTurn`). If it can't, the framework trims recent records to the target model's line and says how much was left out.
- **agent-sdk understands DSH boundaries** (new optional capability `boundary.landed`). When the last delivered message has been replaced by a boundary, it continues from the boundary instead of handing over the whole history again.
- **Auxiliary requests** (titles, compaction) include only the latest runtime snapshot when flattening messages, and use placeholders for file blocks.
- **Missing optional executor capabilities** are reported one per capability, and only when the missing set changes. Previously the same reports came back on every start.
- **Schedule tool declarations** use the DSH 0.2.2 names: `schedule_view` reads, `schedule_edit` writes.
- **Channel notice results.** With no group bound, the result is `skipped` (`NO_GROUP`) and no "not delivered" report is raised. `failed` (`GROUP_GONE`) now means only that a group is bound but its sessions are gone.

## 0.1.0-preview.3

只改了渠道包 `dsh-galatea-channels`。**用 preview.2 的请升级**：从 preview.1 升到 preview.2 时，如果投递记录里有 preview.1 写下的 `sentText`（QQ 官方机器人发过带网址的消息就会有），渠道打不开存储，整个起不来。

- 投递记录的结构重新收下 `sentText` 这个旧字段，preview.1 写下的记录照常打开；渠道不再写它，也不读它。

## 0.1.0-preview.3 (English)

Only the channels package `dsh-galatea-channels` changed. **If you installed preview.2, upgrade**: when the delivery records contain `sentText` written by preview.1 (any QQ official bot message that had a web address), preview.2 cannot open its storage and the channels plugin does not start.

- The delivery record schema accepts the old `sentText` field again, so records written by preview.1 open as before. The channel no longer writes or reads it.

## 0.1.0-preview.2

只改了渠道包 `dsh-galatea-channels`，另外三个包不变，仍是 0.1.0-preview.1。

- QQ 官方机器人发文字照原文发，网址不再换成“（链接见电脑）”。
- 适配器的发送结果去掉了 `sentText`，投递记录里也不再记它；`/media` 去掉了 `qqSafeLinks`。自己写的适配器如果回报了 `sentText`，渠道会忽略它，不用改。

## 0.1.0-preview.2 (English)

Only the channels package `dsh-galatea-channels` changed; the other three packages stay at 0.1.0-preview.1.

- The QQ official bot sends text as written; web addresses are no longer replaced with "（链接见电脑）".
- `sentText` is gone from adapter send results and from delivery records, and `qqSafeLinks` is gone from `/media`. A custom adapter that still returns `sentText` keeps working; the channel ignores it.

## 0.1.0-preview.1

这一版把不属于各包核心职责的功能移了出去，换成通用的接口：每个包只留它宣称要做的事，别的需求经接口由你自己的插件接上。
从 preview.0 升级时，按下面“删掉的配置项”改 profile。

### 删掉的配置项

| 包 | 配置项 | 换成 |
| --- | --- | --- |
| 执行方 `dsh-galatea-agent-sdk` | `browser` | 通用的 `mcpServers`、`allowedTools`、`systemAppend`（见下） |
| 框架 `dsh-galatea` | 经历库的 `transcriptDirs`（收 Claude Code 命令行的记录） | 由插件经 `experience.registerSource` 登记来源 |

### 新的接口

- **执行方**
  - `mcpServers`：另外给 Claude Code 挂的 MCP 服务器，写法同 Agent SDK。名字 `dsh` 留给框架的产品工具，重名时执行方启动就报错。
  - `allowedTools`：另挂的服务器里不用确认就能用的工具。
  - `systemAppend`：追加在系统提示末尾的说明。
- **框架的经历库**
  - 来源登记以后拿到的 `append(entries, { replaceFrom, ops })` 多收 `ops`，一次拉取里可以逐份文件各自重算。
  - 条目带 `title` 时，这条时间线较早的条目跟着改成这个标题。
  - 别的来源的条目按它登记时的 `label` 显示；`parsers` 只留通用的 `readLines`。
- **消息渠道**
  - `registerPlatform({ id, label, platform, hints })`：接新的聊天平台。适配器的约定见渠道 README“接新平台”。
    适配器可以提供 `paceMs`（发送节奏）、`groupList`（支持群）；发送时改了写法的，用 `sentText` 回报实际发出的版本。
  - `setGroupResolver(resolve)`：群第一次说话时按规则接到哪个会话。
  - `@loveandbeepbrother/dsh-galatea-channels/media`：写适配器用的小件（`qqSafeLinks`、`inboundImageOf` 等）。
  - 新配置：`replyOrder`（中枢发到手机时渠道的先后）、`rerouteNote`（没走第一位时开头注明）、`downAlarmMinutes`（断开告警的时限）。

### 行为变化

- **`/hub`**：在还没开过轮的会话里拒绝，提示先说一句话。DSH 不显示没开过轮的会话，新建会话时还会把它拿去重用。README 不再建议置顶。
- **claude.ai 账号连接器**：执行方不再写死关掉。要关的话，在执行方的 `env` 里写 `ENABLE_CLAUDEAI_MCP_SERVERS: 'false'`。
- **skill**：执行方默认不再过滤，和 Claude Code 一样。`pluginSkills` 填了名单才过滤：只放行用户级 skill 和名单里的插件 skill。
- **对话里的本机图片**：框架不再接管点击、不再带前端，点开回到 DSH 自己的浮层。
- **经历库**：框架不再内置 Claude Code 命令行记录的来源。DSH 拉起的 Claude Code 进程记录由执行方自己解析。
- **消息渠道**
  - 回复改成每个绑定在自己的后台投递里发，所有平台都一样。同一绑定的片照旧按顺序发，一个渠道慢不再拖住别的渠道。
  - 断开告警对所有平台一样：连不上超过 `downAlarmMinutes` 经别的渠道告诉一次；短暂重连不算。
  - 回复先后默认按对方最近说话的渠道；改道说明默认不写。
  - 网址由各平台在发送时处理：投递记录里存原文，平台改过写法时另记 `sentText`。官方 QQ 照旧把网址换成“（链接见电脑）”。
  - 没有群解析规则时，群第一次说话也会告诉中枢“这个群还没接会话”（以前不说）。群名「项目-<名>」自动接项目会话的规则移出了渠道。
  - 两个内置渠道（QQ 官方机器人、微信）只接私聊。群要靠插件接进来、支持群的平台。

升级时：渠道还有没发完的回复（尤其是留到对方下一条消息之后再发的片）时，先等它们发完再升级。投递记录的切法规则变了，旧的未完成批可能不再续发。

---

### 文档

- 补充接 GPT 模型的说明：走 DSH 原生接口；Codex CLI 暂时不能作执行方。

## 0.1.0-preview.1 (English)

This release moves out features that are not part of each package's core job and replaces them with general interfaces:
each package keeps only what it claims to do, and anything else is plugged in by your own plugins through those interfaces.
When upgrading from preview.0, update your profile as listed under "Removed settings".

### Removed settings

| Package | Setting | Replaced by |
| --- | --- | --- |
| Executor `dsh-galatea-agent-sdk` | `browser` | the general `mcpServers`, `allowedTools`, `systemAppend` (below) |
| Framework `dsh-galatea` | experience `transcriptDirs` (Claude Code CLI transcripts) | a plugin registers a source via `experience.registerSource` |

### New interfaces

- **Executor**
  - `mcpServers`: extra MCP servers for Claude Code, in the Agent SDK format. The name `dsh` is reserved for the framework's tools, and a clash makes the executor fail at startup.
  - `allowedTools`: tools from those servers that run without asking.
  - `systemAppend`: text appended to the system prompt.
- **Framework experience archive**
  - The `append` handle from `registerSource` now takes `{ replaceFrom, ops }`, so one pull can recompute several files separately.
  - An entry carrying `title` retitles its whole timeline.
  - Entries from other sources show the source's `label`. `parsers` keeps only the generic `readLines`.
- **Channels**
  - `registerPlatform({ id, label, platform, hints })` connects a new chat platform. The adapter contract is in the channels README ("接新平台"). Adapters may provide `paceMs` (send pacing) and `groupList` (group support), and report the text they actually sent as `sentText`.
  - `setGroupResolver(resolve)` decides which session a group attaches to the first time it speaks.
  - `@loveandbeepbrother/dsh-galatea-channels/media` exports helpers for adapters (`qqSafeLinks`, `inboundImageOf`, …).
  - New settings:
    - `replyOrder`: the order of channels for the hub's messages.
    - `rerouteNote`: note the reroute when the first one isn't used.
    - `downAlarmMinutes`: how long a channel can be down before you are told.

### Behavior changes

- **`/hub`**: refused in a session that has never had a turn, with a hint to say something first. DSH hides such sessions and reuses them for New Session. The README no longer suggests pinning.
- **claude.ai connectors**: no longer forced off by the executor. To turn them off, set `ENABLE_CLAUDEAI_MCP_SERVERS: 'false'` in the executor's `env`.
- **Skills**: the executor no longer filters by default, matching Claude Code. Set `pluginSkills` to filter: user-level skills plus the plugin skills listed.
- **Local images in chat**: the framework no longer takes over the click or ships a frontend. Clicking falls back to DSH's own overlay.
- **Experience archive**: the framework no longer has a built-in source for Claude Code CLI transcripts. The executor parses the Claude Code process transcripts it launches itself.
- **Channels**
  - Replies are delivered in a background job per binding on every platform. Parts within a binding stay in order, and a slow channel no longer holds up the others.
  - The down alarm applies to every platform: after `downAlarmMinutes` you are told once through another channel. Brief reconnects don't count.
  - The reply order now defaults to wherever you spoke last. The reroute note is off by default.
  - Each platform handles URLs when sending. Delivery records keep the original text plus `sentText` when the platform changed it. The QQ official bot still replaces URLs with "（链接见电脑）".
  - Without a group resolver, a group's first message now also tells the hub that the group is not attached (previously silent). The built-in rule that attached groups named 「项目-<name>」 to project sessions was moved out of the channels package.
  - The two built-in channels (QQ official bot, WeChat) handle private chats only. Groups need a group-capable platform plugged in by a plugin.

When upgrading: if the channels still have replies in flight (especially parts held until the other person's next message), let them finish first. Delivery splitting rules changed, so unfinished old batches may not resume.

### Documentation

- How to use GPT models: through DSH's native interface. The Codex CLI cannot run sessions as an executor yet.
