# Galatea 项目任务

`@loveandbeepbrother/dsh-galatea-project-tasks`：中枢把要花时间的活派给 DSH 项目。插件在项目下新建一个任务会话，项目里的助手在项目目录里
亲自推进；这一轮结束时的最后一段回复作为执行报告交回中枢，中枢按交付要求验收：接受、返修或取消，再简要告诉用户。

需要先装框架 `@loveandbeepbrother/dsh-galatea`，并定好中枢（在一个会话里输入 `/hub`）。

## 怎么用

一般不用你直接调工具，跟中枢说就行，例如“把第三章按新大纲改一遍，交一份改动说明”。中枢会：

1. 用 `assistant_project_list` 看各项目的概述，挑出要派给的项目（目录还没注册成项目时，先用 `assistant_project_create` 注册）。
2. 用 `assistant_task_dispatch` 派出：写清要求和交付要求。插件在项目下建一个「任务·<标题>」会话，把任务交给它。
3. 任务会话做完一轮，报告以“【项目任务回报】”转交回中枢。中枢验收后用 `assistant_task_review` 接受、返修（同一个任务会话接着做下一轮）或取消；
   一轮还在做时也可以用返修改要求，正在做的那一轮会被中止。
4. 验收过的产出（文档、报告等），中枢用 `present` 交给你。

任务会话收到的说明里写着：在这个会话里亲自完成（机械性的批量工作可以交给子代理或别的工具）；做完更新项目概述文件、在项目的 git 仓库提交；
用户不在这个会话里，不提问，需要用户决定的事写进报告。

装了本包以后，中枢、项目里的会话开头上下文里各多一段说明（中枢：怎么派、怎么验收、验收过的产出怎么交；项目会话：收到任务时就是执行者）；
后台思考醒来时的事实段里多一行“可以用 assistant_project_list、assistant_task_status 看各项目和任务”。没装后台思考时这一行不交，也不报错。

装了消息渠道包、项目会话接着一个群时，任务的开始、做完、验收这些进度会各发一句固定的话到那个群，完整回报仍交给中枢。

## 工具

| 工具 | 算读还是写 | 谁能用 | 做什么 |
| --- | --- | --- | --- |
| `assistant_project_list` | 读 | 所有会话、外部调用方 | 列出已注册的项目：目录、概述开头、会话、各状态的任务数 |
| `assistant_task_status` | 读 | 所有会话、外部调用方 | 带 taskId 读一个任务的全部：要求、交付要求、每一轮的报告和验收；不带就列出任务，可按项目（workspaceId）、状态（state）筛 |
| `assistant_project_create` | 写 | 只有中枢 | 把本机目录注册成项目，并保证它有一个长期的「<项目名>·项目会话」 |
| `assistant_task_dispatch` | 写 | 只有中枢 | 派任务；同一次工具调用重试不会派两次 |
| `assistant_task_review` | 写 | 只有中枢 | 验收：`accept`、`revise`（带意见）、`cancel` |

子代理不能派发、验收任务。任务状态：`running`（在做）、`reported`（这一轮做完、等验收）、`accepted`、`canceled`。

## 配置

在 profile 的 `cordis.patch.yml` 里按条目 id `project-tasks-framework` 写 `config`。

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `overviewFiles` | `['项目概述.md']` | 项目概述文件名，按顺序取第一个存在的；都不存在时任务会新建第一个 |
| `overviewChars` | 1500 | 项目列表里每份概述的字数上限 |
| `reportChars` | 6000 | 回报里执行报告的字数上限，超过的让中枢用 `assistant_task_status` 读全文 |
| `provider` | 空 | 任务会话的模型提供方（例如 `agent-sdk`）；空就不选，任务会话用 DSH 设的默认模型 |
| `models` | `[]` | 派任务时可以选的模型（配了 `provider` 才用） |
| `defaultModel` | 空 | 派任务没写模型时用哪个（配了 `provider` 才用） |
| `reconcileDelayMs` | 15000 | Host 启动后多久核对没做完的任务（补发没送出的委派、补收重启期间结束的一轮、补交没送达的回报） |
| `redirectWaitMs` | 60000 | 改要求后等被中止的那一轮结束的最长时间，到时直接发出新要求 |
| `quotaRetryMs` | 300000 | 任务会话的执行方额度用完时，委派先不发，隔多久再看一次 |

例如让任务会话跑在 Agent SDK 执行方上：

```yaml
- id: project-tasks-framework
  config:
    provider: agent-sdk
    models: [opus, sonnet]
    defaultModel: opus
```

## 接在框架上的几处

- 委派经框架核心的 `core.deliver` 放进任务会话（说话人是本插件，回复不往外发）；回报经它放进中枢，回复照中枢的规则由出口发（休息时段里攒着）。
  放不进中枢时报 `project-tasks/notice-undelivered`，重启核对时再交。
- 任务会话、项目会话建好就在核心里登记成 `worker`。
- 额度按任务会话的执行方问核心（`core.quota.state`）：用完了委派先留着，恢复后自动发出。
- 进度发到项目接的群经 `core.exits.notify`；没发出由核心报。
- 存储域 `galatea_project_tasks`。对外提供只读的 `assistantProjectTasks.running()`：在跑的任务和任务会话最后活动的时间，给监视类插件用。

## 依赖

注入 `agents`、`sessionQuery`、`storageDomain`、`tools`、`core`；运行时取 DSH 的 `workspaceRegistry`、`workspaceController`、`sessionController`
（建项目、建会话、命名、列会话）。可选：框架的后台思考（`reflection`）。
