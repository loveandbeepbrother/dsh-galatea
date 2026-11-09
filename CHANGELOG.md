# 变更记录 / Changelog

## 0.1.0-preview.4

四个包统一到 0.1.0-preview.4。改了框架 `dsh-galatea`、`dsh-galatea-agent-sdk`、渠道 `dsh-galatea-channels`；`dsh-galatea-project-tasks` 只改了注释。

- **多了一层常驻记忆。** 长期成立、每段对话都该知道的事实放 `standing-memory.md`，会话开头接在长期认知后面，和长期认知一样每轮固定版本、别处改了提一句、交接和切模型以后也在。`assistant_mind_read` 多了 `standing`，新工具 `assistant_standing_update` 给中枢、后台思考和交接整理，改了就生效，不走候选。配置 `standingFile`、`standingMaxChars`（默认 3000，超了只提醒）。没有这个文件按空，不报异常。
- **修正：框架的压缩引擎以前并没有真正接管压缩。** 之前的版本和文档说框架的引擎替代上游的 `compaction-basic`，只能有一个。这不对：DSH 的 web 预设里每个都带着一份，框架只停用了顶层那一行。预设里那份一直在工作，所以在 web 和桌面版上：
  - profile 里给 `mind-framework-compaction` 配的 `modelPolicies`、给 `mind-framework-context` 配的兜底压缩线（`fallbackCompactAt`），对预设里那份都没有生效，它按上游默认的窗口八成压缩；
  - 外部执行方的会话到了那条线，还是会被它用模型摘要；从外部执行方切到原生模型时也是它先压，历史太长就会失败（`MODEL_SWITCH_COMPACTION_FAILED`）。

  现在框架在运行时接管这些实例：它们不再自动压缩（步间压力、切模型、溢出恢复），`/compact` 转到框架的引擎；外部执行方的会话 DSH 侧不做压缩，`/compact` 交给执行方自己。配置的线从这一版起才真正生效，升级后压缩的时机可能和以前不同。
- **渠道读得到引用了。** QQ 官方和微信引用一条消息时，以前引用的内容会丢。现在用户的话前面多一行：引用的是我们发过的，写开头和编号（`〔引用你发的：开头…，全文见 dsh:<会话>:<序号>〕`）；对不上的写开头，什么都没有就写“引用了一条消息”。适配器在信封上交 `quote`（`{ platformMessageId?, refIdx?, text?, label?, image? }`），投递记录的回执多了可选的 `refIdx`。
- **休息时段攒着的回复，过时了不再发。** 到点时，如果用户之后说过话，或者之后已经有话发到用户手上，这一条就丢弃。休息时段要打破休息，用 `assistant_channel_send`。
- **用户从渠道说的话，模型看得到从哪来。** 带 `via` 的本人消息开头多一行，比如“（来自 QQ 私聊）”，原文记在 `source.annotation`，读的人照旧准确去掉；桌面上说的不标。以 `/` 开头的消息交给 Claude Code 时不带这一行，它只认开头的 `/` 是命令。
- **交接是会话一级的事。**
  - 执行方换新对话以后，框架在 DSH 记录里落一个交接边界，交接文档换掉之前的记录，不调模型。Claude Code 自己压缩过以后也落一个，正文是它的摘要。
  - 每个边界写一条插件记录 `plugin:mind-framework/boundary`，种类（`handoff`、`switch`、`auto-compact`、`compact`）看这条记录，不看摘要的文字。
  - 执行方自己压缩的摘要（`auto-compact`、`compact`）经 `context.land` 请框架落边界时，要用 `by` 写明是哪个执行方写的；到落下时请求已经路由到别的执行方，这份摘要就不落。
  - 换新对话以后带上交接之前最近几轮的原文，放在交接文档后面：只有用户的话、助手回复的最终文字和一轮中途发到用户手上的话（出口的可选能力 `sentBetween`，读不到时写明一句），超过上限从最旧的截并写明。默认 5 轮、8000 字，上下文模块的 `recentTurns`、`recentChars` 可以改，0 不带。
  - 以前 DSH 记录一直在长，从 Claude Code 切到原生模型时会因为压不下去而失败（`MODEL_SWITCH_COMPACTION_FAILED`）。
- **外部执行方的会话，DSH 侧不再做压力压缩。** 从外部执行方切到原生、历史放不下时，先请原来的执行方写交接（新的可选能力 `handoffTurn`）。写不了时，按目标模型的线裁剪最近的记录，并写明省略了多少。
- **agent-sdk 认得 DSH 边界**（新的可选能力 `boundary.landed`）。交过的最后一条被边界换掉以后，以边界为锚接着交，不再整段从头交接。
- **辅助请求**（标题、压缩）平铺消息时，运行时快照只放最新一份，文件块放占位。
- **执行方的可选能力缺失**改成每项一条、只在缺失的集合变化时报。以前是每次启动都把同样几条重报一遍。
- **定时工具的声明**换成 DSH 0.2.2 的名字：`schedule_view` 是读，`schedule_edit` 是写。
- **渠道的通知结果。** 没接群返回 `skipped`（`NO_GROUP`），不再报"没发出"；接着群、但群接的会话不在了，才是 `failed`（`GROUP_GONE`）。

- **便签按会话分本。** `notesFile` 换成 `notesDirectory`（默认 `notes`）。中枢、后台思考和外部调用方共用 `hub` 一本，项目一个项目一本，别的会话各一本；写只写自己那本，中枢、后台思考、外部调用方能用 `book` 参数读别的本子。以前根下的 `notes.md` 第一次启动时挪成 `notes/hub.md`。
- **便签搜索按空白分词**，命中词多的在前；以前整串当一个词，两个词的查询常常什么都搜不到。
- **检索写明搜了什么。** 记忆、便签、经历的结果带 `searched`（`semantic` 是 `ok`、`failed`、`none`、`backfilling`，还有未索引条数和补算错误）；结果为空又不是全覆盖时写明没搜到不代表没有。
- **交接整理。** `assistant_context_handoff` 在执行方接受之后立刻返回，后台跑一次一次性的整理；换对话等它跑完（超时 `tidyMaxMinutes`，默认 5，或出错都算跑完），用户的下一条消息最多等这么久；结果放在新对话的开头。新增会话角色 `tidy`：回退到旧包之前要删掉这条角色记录。内容库多一份 `交接整理.md`，没有时用自带的。
- **微信每条消息最多回 10 片。** 每条消息能回几次改成平台声明（`replyLimit`）；用完不再选它，超出的留到用户下一条消息之后，当场告诉用户。平台拒收本身也算这条消息回不了了（`rejectEndsReplies`），不靠计数，并报 `channels/replies-ended`。
- **Agent SDK 执行方的 `strictMcpConfig`**：只用配置写明的 MCP 服务器，不继承 Claude Code 自己的配置。默认关。
- **经历库不再丢只有操作、没有条目的一批。** Agent SDK 这条来源的工具调用以前缺一大半；升级后第一次拉取从头重读一遍补回来。
- 向量补算恢复时关掉报过的 `experience/embed-failed`。
- **统一搜索 `assistant_search`。** 新模块 `mind-framework-search`：经历、记忆、便签、文档（配置 `documents` 白名单，按标题切块）、工具轨迹进同一张派生索引，中文按相邻两字切，查询改成 OR 加 BM25（按原文顺序最多 256 个词），七个词不再因为缺一个就返回 0 条；关键词和向量两路按名次合并，结果按来源分组。同一次发送在两个会话的副本（`link` 相同）正文相同时只有发送方那份进全文表，词频和向量名次都按一条算；接收方多一层通知的那份自己进全文表，查询时折叠；可见范围按几份的并集，交回调用方看得到的那一份。`assistant_history_search` 的关键词也走它。记忆、便签、经历三个搜索退到按需加载。续接的对话工具表是冻结的，升级后要交接一次才看得到新工具。
- 重启打断的一轮补一条 `turn-failed`，也告诉那个会话，包括 Claude Code 自己开的轮。`activity` 带上 `busy`。
- 执行方取走的附提醒，这一轮结束就算交到，不看附上的时刻。
- 内容库定时提交工具以外的改动，写明是工具外改动，不标成用户。
- 外部调用方改工具清单或只读用 `POST /api/mind-framework/external/update`，令牌不变。以前只能重新登记，换令牌，在用的客户端全断。
- 核心的 `segments.preview`，各模块的 `sample`，经历库的 `digest`。
- **每条输入带到达时刻。** 当提问交给模型的每条输入（不论哪个入口、标不标来源），来源标注最前面写它进收件箱的时刻，按核心的 `timezone` 写、带偏移和星期，比如 `[11-08 周日 09:24 +08:00]（来自 QQ 私聊）`。以前桌面上本人说的话没有标注，现在也有一段只写时刻的标注（`source.annotation`），读的人照旧按它准确去掉。上游的时间行十分钟最多一条，Claude Code 只有开对话那天的日期。
- **行为变化：工具结果里的时间改成按核心的时区写、带偏移。** `assistant_search` 的 `at`、`assistant_memory_search` 和 `assistant_memory_read` 的 `created`、`updated` 以前是 UTC ISO（`2026-11-08T01:24:05.000Z`）；经历工具的 `at` 以前是不带时区的本地时间（`2026-11-08 09:24:05`）。现在都写成 `2026-11-08 09:24+08:00`，另给相对时间（`ago`、`updatedAgo`、`createdAgo`，比如 `3 天前`）。按 UTC ISO 解析这些字段的调用方要改。存储里的时间不变。
- **经历工具的 `since`、`until`、`at`** 认带偏移的写法（结果里的 `at` 只到分钟，原样传回落在那一分钟的开头）；不带偏移的、只写日期的按核心的 `timezone` 算，以前按 Host 进程的本地时区。
- **便签带时间。** `assistant_notes_search`、`assistant_notes_read` 和 `assistant_search` 的便签结果多了 `created`（从便签编号的 ULID 解出）和 `updated`（它那几行在内容库里最后一次提交的时刻，`git blame`）。有还没提交的改动时 `updated` 取文件修改时间，并在 `updatedNote` 写明；取不到时写“未知”和原因。内容库多了 `lineTimes(path)`。
- 检索服务多了 `terms(text, limit)`（和查询同一种切法）和 `frequencies(terms, { sources })`（每个词出现在几条里、这几个来源一共几条，同一次发送的副本算一条，默认经历、记忆、便签，在 worker 里算），给要按 IDF 加权的插件用。
- **`assistant_search` 把“降级”和“确实没有”分开写明。** 以前只在没结果又降级时写一句。现在只要有一路没走全（没走语义、经历的语义索引还在补算或补算停了、文档的语义一路出错），不管有没有结果，`note` 都写明，比如“这次只走了关键词（原因）：意思相近、字面不同的找不到”；能查的都查了还是空的，写“能查的都查了（没有降级），没有相关的”。经历结果多了 `link`（同一次发送的关联），经历服务多了 `vectorState(model)`，便签的 `sample` 改成用正文去搜。
- **使用统计。** 记忆、便签、文档段、经历被搜到（出现在 `assistant_search`、`assistant_memory_search`、`assistant_notes_search`、`assistant_history_search` 的结果里）和被打开（`assistant_memory_read`、`assistant_notes_read`、`assistant_history_read` 传入的 `ref`）的次数和最后时刻，按调用方的角色分开记，存在经历库的 `usage` 表里。新工具 `assistant_usage`（中枢、后台思考、交接整理、外部调用方可用）按来源列用得最多的、最久没用的、从没用过的（记忆和便签），默认只算中枢和项目会话，`roles: ["all"]` 算全部。文档被打开记不到（文档是用 Read 读的）。工具端点的 `open(sessionId, { probe: true })` 开体检用的令牌，经它调的工具，`core.caller` 认出的调用方带 `probe: true`，使用统计不记。经历服务多了 `noteUsage(who, source, refs, kind)`。
- **收藏。** 新工具 `assistant_favorite`（只有中枢：`add` 一条经历的 `ref` 或一句 `quote`，可附 `why`；`remove` 按 `id` 或 `ref`）和 `assistant_favorite_list`。存在内容库的 `favorites.jsonl`（经历模块的配置 `favoritesFile`）。`assistant_history_search` 和 `assistant_search` 多了 `favorites: true`，只看收藏过的经历；检索 store 的查询多了 `refs`。
- **“我们之间”。** 心智模块多了一份文件 `between-us.md`（配置 `betweenFile`，上限 `betweenMaxChars` 默认 1000），放最近的共同经历、用户近来在意的事、彼此的默契和变化。单独一段 `between-us`，接在心智段后面，开对话时定下、别处改了提一句。它不进按轮固定的版本：版本记录的 schema 是严格的，加字段会让回退的旧包读不了。中枢和后台思考用新工具 `assistant_between_us_update` 整份替换（带 `baseHash`、`summary`），`assistant_mind_read` 多了 part `"between_us"`。没有这个文件按空，不报异常。
- **记忆目录列不全时，写入就提醒。** `assistant_memory_write` 写完以后，中枢那份目录（全局记忆）在 `indexChars` 里列不全时，结果的 `note` 写明只列得下几条、较早的几条不再列出。以前只在目录末尾写一句，写的人看不到。
- **先搜再答（门控版）。** 中枢的一轮里有该查的输入时，在那条输入后面附一段提示，要它先用 `assistant_search` 查一下再答（要说某件事还没做、没定过、不存在的话，把这句话本身也搜一次）；查什么、用不用交给模型。
  - 门控：输入带问题类型词并且不少于 20 字。不是用户本人说的，还要新颖度不低于 0.7：消息里没在最近 5 轮出现的词，其 IDF 占全部词 IDF 的比例；IDF 用检索索引里经历、记忆、便签的条数。默认值来自我们自己的召回实验（门控在看结果前定死）：用例上避免 9/24（不附提示 5/24），普通消息没有重伤，每轮中位多等约 5 秒。
  - **默认词表是中文，来自我们自己的数据；别的语言要自己配**（检索模块的 `searchFirst.words`）。词表也可以放在内容库的一份文件里（`searchFirst.wordsFile`，默认 `search-first-words.md`，一行一个，`#` 开头是注释），模型能直接改，下一轮生效。
  - 判够 `searchFirst.remindEvery` 轮（默认 500）就经附提醒告诉中枢：这段时间判了几轮、附了几次，请它看一眼词表要不要更新；改不改由它定。计数存在检索索引的游标里，重启不清零。
  - 现在只经 Agent SDK 执行方的 `UserPromptSubmit` 钩子附上（`agentSdk.addHooks`），别的执行方还没有。服务 `searchFirst.stats()` 给能力体检看钩子在不在跑。`searchFirst.enabled: false` 关掉；门槛（`minLength`、`noveltyMin`、`recentRounds`）和提示（`hint`）都是配置。
- **行为变化：消息渠道的合并等待默认从 30 秒改成 20 秒，并且能配了。** 手机上分几条发的话，渠道等最后一条之后安静 `mergeWaitSeconds`（默认 20 秒）再合成一条交给助手。时长因人而异，README 写明了怎么调，也请代为安装的 agent 装完告诉用户。平台适配器可以声明自己的 `mergeTextMs`、`mergeImageMs`（读消息本身就慢的平台等得久一点）。
- **会话间转话带关联编号。** `assistant_session_send` 交出去的话带 `link`，结果末尾写“（编号 …）”；Agent SDK 执行方解析记录时把它记到发送方那次调用的操作上，经历库里两边对得上，`assistant_history_thread` 能从一边跟到另一边。以前接收方的条目没有编号。
- 修正：经历库启动以后一条条收进来的条目没有会话标题，搜索结果的 `where` 显示成会话编号，要等下次整份重读才补上。现在没写标题的条目沿用这个会话已有的标题。

## 0.1.0-preview.4 (English)

All four packages are now 0.1.0-preview.4. Changed the framework `dsh-galatea`, `dsh-galatea-agent-sdk` and the channels package `dsh-galatea-channels`. `dsh-galatea-project-tasks` only had a comment changed.

- **A new layer: standing memory.** Long-lasting facts every conversation should know live in `standing-memory.md`. It follows long-term cognition at the start of a conversation and works the same way: a fixed version per turn, one line when it changes elsewhere, and still there after a handoff or a model switch. `assistant_mind_read` gains `standing`, and the new tool `assistant_standing_update` is for the hub, background reflection and handoff tidying; changes apply directly, with no candidate step. Settings: `standingFile` and `standingMaxChars` (default 3000; going over only warns). A missing file counts as empty and is not reported.
- **Fix: the framework's compaction engine had not really taken over compaction.** Earlier versions and docs said the framework's engine replaces the upstream `compaction-basic` and that only one can exist. That was wrong: each of DSH's web presets carries its own copy, and the framework only disabled the top-level row. The preset copy kept working, so on web and desktop:
  - `modelPolicies` configured for `mind-framework-compaction`, and the fallback line (`fallbackCompactAt`) configured for `mind-framework-context`, never applied to the preset copy, which compacts at the upstream default of 80% of the window;
  - sessions on an external executor were still summarized through the model by that copy once they reached its line, and it also ran first when switching from an external executor to a native model, failing with `MODEL_SWITCH_COMPACTION_FAILED` when the history was too long.

  The framework now takes these instances over at runtime: they no longer compact on their own (step pressure, model switch, overflow recovery), and their `/compact` goes to the framework's engine. Sessions on an external executor get no DSH-side compaction, and `/compact` goes to the executor itself. The configured lines take effect for the first time in this version, so compaction may happen at different points after upgrading.
- **Channels now read quotes.** When the user quoted a message on the QQ official bot or WeChat, the quoted content used to be lost. Their message now starts with one more line: for a message we sent, its beginning and an id (`〔引用你发的：开头…，全文见 dsh:<session>:<seq>〕`); otherwise its beginning; and "引用了一条消息" when nothing else is known. Adapters pass `quote` on the envelope (`{ platformMessageId?, refIdx?, text?, label?, image? }`), and delivery receipts gain an optional `refIdx`.
- **Replies held during quiet hours are dropped once they're stale.** When quiet hours end, a held reply is discarded if the user has spoken since, or if something else has already been sent to them since. To break quiet hours, use `assistant_channel_send`.
- **The model can see which channel a user message came from.** A user's own message with a `via` starts with one extra line, such as "（来自 QQ 私聊）". The line is recorded in `source.annotation`, so readers remove it exactly as before. Messages typed on the desktop get no line. Messages starting with `/` reach Claude Code without the line, because it only treats a leading `/` as a command.
- **Handoff is session-level.**
  - After an executor starts a new conversation, the framework lands a handoff boundary in the DSH record: the handoff document replaces the earlier records, with no model call. After Claude Code compacts on its own, it lands one too, with Claude Code's summary as the text.
  - Each boundary writes a plugin record `plugin:mind-framework/boundary`. Its kind (`handoff`, `switch`, `auto-compact`, `compact`) comes from that record, not from the summary text.
  - When an executor asks `context.land` to record its own compaction summary (`auto-compact`, `compact`), it must name itself with `by`. If requests have been routed to another executor by the time the boundary would land, the summary is dropped.
  - A new conversation after a handoff also gets the verbatim text of the most recent turns, placed after the handoff document: only the user's words, the assistant's final replies and what a turn sent to the user midway (the exit's optional `sentBetween`; a note says so when it can't be read), cut from the oldest when over the limit, with a note saying so. The default is 5 turns and 8000 characters. Change it with the context module's `recentTurns` and `recentChars`; 0 turns it off.
  - Previously the DSH record kept growing, and switching from Claude Code to a native model failed (`MODEL_SWITCH_COMPACTION_FAILED`).
- **No DSH-side pressure compaction for external executors.** When switching from one to a native model and the history doesn't fit, the framework first asks the previous executor to write a handoff (new optional capability `handoffTurn`). If it can't, the framework trims recent records to the target model's line and says how much was left out.
- **agent-sdk understands DSH boundaries** (new optional capability `boundary.landed`). When the last delivered message has been replaced by a boundary, it continues from the boundary instead of handing over the whole history again.
- **Auxiliary requests** (titles, compaction) include only the latest runtime snapshot when flattening messages, and use placeholders for file blocks.
- **Missing optional executor capabilities** are reported one per capability, and only when the missing set changes. Previously the same reports came back on every start.
- **Schedule tool declarations** use the DSH 0.2.2 names: `schedule_view` reads, `schedule_edit` writes.
- **Channel notice results.** With no group bound, the result is `skipped` (`NO_GROUP`) and no "not delivered" report is raised. `failed` (`GROUP_GONE`) now means only that a group is bound but its sessions are gone.

- **One notebook per session.** `notesFile` becomes `notesDirectory` (default `notes`). The hub, background thinking and outside callers share `hub`, a project has one book, other sessions have their own. You write only to your own book; the hub, background thinking and outside callers can read others with `book`. An old `notes.md` at the content root moves to `notes/hub.md` on first start.
- **Notes search splits on whitespace**, notes matching more words first. It used to treat the whole query as one string, so a two-word query often found nothing.
- **Search results say what was searched.** Memory, notes and experience results carry `searched` (`semantic` is `ok`, `failed`, `none` or `backfilling`, plus the unindexed count and the backfill error). An empty result that was not a full search says that nothing found does not mean nothing there.
- **Handoff tidy.** `assistant_context_handoff` returns as soon as the executor accepts, and a one-off tidy runs in the background. The switch waits for it (`tidyMaxMinutes`, default 5; a timeout or error also counts as finished), so the user's next message waits at most that long. The result appears at the start of the new conversation. New session role `tidy`: delete that role record before rolling back to an older package. The content library gains `交接整理.md`; the built-in one is used when it is missing.
- **WeChat allows 10 replies per user message.** Platforms now declare how many replies a message allows (`replyLimit`). Once used up the channel is no longer chosen, the rest waits for the user's next message, and the user is told at once. A rejection by the platform also ends that message's replies (`rejectEndsReplies`), whatever the count says, and is reported as `channels/replies-ended`.
- **`strictMcpConfig` for the Agent SDK executor**: use only the MCP servers listed in the config, without inheriting Claude Code's own configuration. Off by default.
- **The experience archive no longer drops batches that contain only operations.** Most tool calls from Agent SDK sessions were missing; the first pull after upgrading rereads from the start to recover them.
- Closes the `experience/embed-failed` report when vector backfill recovers.
- **Unified search `assistant_search`.** New module `mind-framework-search`: experience, memories, notes, documents (a `documents` whitelist, split by heading) and past tool calls share one derived index. Chinese is split into adjacent pairs, queries are OR with BM25 (at most the first 256 terms, in message order), so a seven-word query no longer returns nothing because one word is missing. Keyword and vector results merge by rank and are grouped by source. Copies of the same send in two sessions (same `link`) count once: when the text is identical only the sender's copy enters the full-text index, and vector results give it one rank. A copy with extra text keeps its own row and folds at query time. Visibility is the union of the copies, and a caller gets the copy it can see. The keyword part of `assistant_history_search` uses it too. The three separate searches load on demand now. Resumed conversations keep their old tool list, so hand off once after upgrading to see the new tool.
- A turn left open by a restart is reported as `turn-failed` and told to that session, including turns Claude Code started by itself. `activity` now carries `busy`.
- Attachments an executor has taken count as delivered when that turn ends, whenever they were attached.
- The content library commits changes made outside the tools on a timer, labelled as such rather than as the user's.
- `POST /api/mind-framework/external/update` changes an outside caller's tool list or read-only flag and keeps its token. Registering again issues a new token and disconnects every client using the old one.
- `segments.preview` on the core, `sample` on each module, `digest` on the experience archive.
- **Every input carries its arrival time.** Each input handed to the model as a prompt, from any entry and whether or not its source is labelled, now starts its annotation with the moment it entered the inbox, in the core `timezone` with offset and weekday, e.g. `[11-08 周日 09:24 +08:00]（来自 QQ 私聊）`. The owner's own desktop messages used to have no annotation; they now get one holding only the time (`source.annotation`), and readers still strip it exactly. The upstream time line appears at most once every ten minutes, and Claude Code only knows the date its conversation started.
- **Behaviour change: times in tool results are now written in the core time zone with an offset.** `at` in `assistant_search` and `created`/`updated` in `assistant_memory_search` and `assistant_memory_read` used to be UTC ISO (`2026-11-08T01:24:05.000Z`). `at` in the experience tools used to be local time without a zone (`2026-11-08 09:24:05`). All of them are now `2026-11-08 09:24+08:00`, plus a relative time (`ago`, `updatedAgo`, `createdAgo`, e.g. `3 天前`). Callers that parse these fields as UTC ISO need updating. Stored times are unchanged.
- **`since`, `until` and `at` in the experience tools** accept strings with an offset. An `at` from a result is given to the minute, so passing it back unchanged lands at the start of that minute. Strings without an offset, and bare dates, are read in the core `timezone`. They used to be read in the Host process's local time zone.
- **Notes carry times.** Note results from `assistant_notes_search`, `assistant_notes_read` and `assistant_search` gain `created`, decoded from the note id's ULID, and `updated`, the last commit touching the note's lines in the content repository (`git blame`). When the note has uncommitted edits, `updated` is the file's modification time and `updatedNote` says so. When it cannot be found out, `updated` is “未知” with the reason. The content repository gains `lineTimes(path)`.
- The search service gains `terms(text, limit)`, which splits text the same way queries do, and `frequencies(terms, { sources })`. The latter returns, for each term, how many items contain it, plus the total number of items in those sources. Copies of one send count once. The default sources are experience, memories and notes, and the work runs in the worker. It is for plugins that weight terms by IDF.
- **`assistant_search` now tells "degraded" apart from "really nothing".** It used to add a line only when there were no results and a path was missing. Now, whenever a path did not run in full, `note` says so, results or not. That covers no semantic path, the experience semantic index still backfilling or stalled, and the document semantic path failing. For example: “这次只走了关键词（原因）：意思相近、字面不同的找不到”. When everything available was searched and nothing came back, it says “能查的都查了（没有降级），没有相关的”. Experience results gain `link`, the relation tying together copies of one send. The experience service gains `vectorState(model)`. The notes `sample` now searches with the note's text.
- **Usage statistics.** Memories, notes, document sections and experience entries are now counted when they are shown and when they are opened, with the last time of each. Shown means appearing in the results of `assistant_search`, `assistant_memory_search`, `assistant_notes_search` or `assistant_history_search`. Opened means the `ref` passed to `assistant_memory_read`, `assistant_notes_read` or `assistant_history_read`. Counts are kept per caller role in a `usage` table in the experience archive. The new tool `assistant_usage` lists the most used entries, the longest unused, or the never used (memories and notes) for a source. It is available to the hub, background reflection, handoff tidying and outside callers. By default it counts only the hub and project sessions; `roles: ["all"]` counts everyone. Document opens cannot be counted, because documents are read with Read. `toolEndpoint.open(sessionId, { probe: true })` opens a token for health probes. Tools called through it see a caller with `probe: true`, and usage statistics skip those calls. The experience service gains `noteUsage(who, source, refs, kind)`.
- **Favorites.** New tools `assistant_favorite` (hub only) and `assistant_favorite_list`. `add` takes an experience `ref` or a `quote`, optionally with `why`; `remove` takes an `id` or a `ref`. Favorites are stored in `favorites.jsonl` in the content repository (experience config `favoritesFile`). `assistant_history_search` and `assistant_search` gain `favorites: true` to search only favorited entries. Search store queries gain `refs`.
- **"Between us".** The mind module gains a file `between-us.md` (config `betweenFile`, limit `betweenMaxChars`, default 1000). It holds recent shared experiences, what the user has cared about lately, and the understandings and changes between the two. It is its own segment, `between-us`, right after the mind segment. It is fixed when a conversation opens, and a change elsewhere brings a notice. It stays out of the per-turn version: that record's schema is strict, and adding a field would leave a rolled-back older package unable to read it. The hub and background reflection replace it whole with the new tool `assistant_between_us_update` (with `baseHash` and `summary`). `assistant_mind_read` gains part `"between_us"`. A missing file counts as empty and is not reported.
- **The memory index warns on write when it no longer fits.** After `assistant_memory_write`, if the hub's index (global memories) no longer fits in `indexChars`, `note` says how many entries are listed and how many older ones are left out. Before, only a line at the end of the index said so, which the writer did not see.
- **Search first (gated).** When a hub turn contains an input worth checking, a hint follows that input. It asks the model to search with `assistant_search` before answering, and, before saying something was not done, not decided or does not exist, to search for that very statement. What to search and whether to use the results is the model's call.
  - Gate: the input contains a question-type word and is at least 20 characters long. Inputs not from the user themselves must also have novelty of at least 0.7. Novelty is the share of the message's total term IDF carried by terms absent from the last 5 rounds; IDF comes from item counts of experience, memories and notes in the search index. The defaults come from our own recall experiments, where the gate was fixed before looking at results. On the test cases the hint avoided 9 of 24 errors (5 of 24 without it), ordinary messages were not seriously harmed, and the median turn took about 5 seconds longer.
  - **The default word list is Chinese and comes from our own data; other languages need their own** (search module `searchFirst.words`). The list can also live in a file in the content repository (`searchFirst.wordsFile`, default `search-first-words.md`, one word per line, lines starting with `#` are comments). The model can edit it directly, and changes take effect on the next turn.
  - Every `searchFirst.remindEvery` judged turns (default 500), an attachment tells the hub how many turns were judged and how many got the hint, and asks it to look at the word list. Whether to change it is the model's call. The counts live in search index cursors and survive restarts.
  - For now the hint is attached only through the Agent SDK executor's `UserPromptSubmit` hook (`agentSdk.addHooks`); other executors do not have it yet. The service `searchFirst.stats()` lets the health probe check that the hook is running. `searchFirst.enabled: false` turns it off; the thresholds (`minLength`, `noveltyMin`, `recentRounds`) and the hint (`hint`) are configuration.
- **Behaviour change: the channels merge wait drops from 30 to 20 seconds by default and is now configurable.** When you send several messages in a row from your phone, the channels package waits until `mergeWaitSeconds` (default 20) pass after the last one, then hands them to the assistant as one. The right wait differs from person to person. The README says how to change it and asks installing agents to tell the user. Platform adapters can declare their own `mergeTextMs` and `mergeImageMs`, so platforms that are slow to read messages can wait longer.
- **Session-to-session messages carry a link id.** Messages sent with `assistant_session_send` carry a `link`, and the result ends with “（编号 …）”. When the Agent SDK executor parses its transcript, it puts that id on the sender's operation for that call. Both sides then match in the experience archive, and `assistant_history_thread` can follow from one to the other. The receiving entry used to have no id.
- Fix: experience entries taken in one by one after startup had no session title, so `where` in search results showed the session id until the next full reread. Entries without a title now take the title the session already has.

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
