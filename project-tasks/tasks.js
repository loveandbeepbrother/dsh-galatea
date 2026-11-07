/**
 * 项目任务的纯逻辑：编号、委派与回报的文字、从会话事件取一轮的执行报告。
 *
 * @module @loveandbeepbrother/dsh-galatea-project-tasks/tasks
 */

import { createHash } from 'node:crypto'

/** 委派、返修与回报消息的来源；经核心登记成本轮提问（`intent: 'prompt'`）。 */
export const TASK_SOURCE = 'galatea-task'

/** 同一发起会话的同一次工具调用对应同一项任务，重试不会重复派出。 */
export function taskIdOf(originId, callId) {
    const digest = createHash('sha256').update(`${originId}\n${callId}`).digest('hex')
    return `task-${digest.slice(0, 24)}`
}

/** 任务会话的编号由任务编号决定，重试时复用同一会话。 */
export function sessionIdOf(taskId) {
    return `session-${taskId}`
}

/** 任务会话编号 → 任务编号；不是任务会话时返回 `undefined`。 */
export function taskIdOfSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('session-task-')
        ? sessionId.slice('session-'.length)
        : undefined
}

/** 第一轮：交给项目会话的委派。 */
export function requestText(task) {
    const lines = [
        '【项目任务】中枢委派给本项目会话的任务（系统转交，不是用户发言）',
        `编号：${task.taskId}`,
        `标题：${task.title}`,
        `项目目录：${task.directory}`,
        '',
        '要求：',
        task.instructions,
    ]
    if (task.deliverables.length > 0) {
        lines.push('', '交付要求：', ...task.deliverables.map(item => `- ${item}`))
    }
    lines.push(
        '',
        '执行约定：',
        '- 在这个会话里亲自完成；机械性的批量工作可以交给子代理或别的工具。',
        `- 完成后更新项目概述 ${task.overviewFile}（当前状态、已完成、下一步、待用户决定的事项），并在项目的 git 仓库提交改动。`,
        '- 用户不在这个会话里，不要向用户提问。需要用户决定的事写进报告，能先做的部分先做完。',
        '- 你的最终回复就是执行报告，会转交中枢验收：写清完成了什么、改了哪些文件、提交编号，以及没有完成或需要用户决定的事项。',
    )
    return lines.join('\n')
}

/** 返修轮：中枢验收后的返修要求。 */
export function reviseText(task, round, feedback) {
    return [
        `【返修要求】中枢验收任务 ${task.taskId} 第 ${round - 1} 轮后要求返修（系统转交，不是用户发言）`,
        '',
        feedback,
        '',
        `完成后同样以执行报告回复，并更新项目概述 ${task.overviewFile}、提交改动。`,
    ].join('\n')
}

/** 改派轮：一轮还在进行时中枢改了要求，上一轮被中止。 */
export function redirectText(task, round, feedback) {
    return [
        `【返修要求】中枢在任务 ${task.taskId} 第 ${round - 1} 轮进行中改了要求，上一轮已中止（系统转交，不是用户发言）`,
        '',
        '上一轮做到一半的改动可能还在工作区：先看 git status 与最近的提交，与下面要求一致的保留，其余撤回或改写。',
        '',
        feedback,
        '',
        `完成后同样以执行报告回复，并更新项目概述 ${task.overviewFile}、提交改动。`,
    ].join('\n')
}

/** 会话最近一个回合是否还没结束。 */
export function turnOpen(events) {
    let open = null
    for (const event of events) {
        if (event?.type === 'turn/start') open = event.data?.turn ?? null
        else if (event?.type === 'turn/end' && event.data?.turn === open) open = null
    }
    return open !== null
}

/** 一轮结束后转交发起会话的回报。 */
export function noticeText(task, round, { reportChars }) {
    const { report } = round
    const lines = [
        '【项目任务回报】（系统转交，不是用户发言）',
        `任务「${task.title}」第 ${round.round} 轮已结束（${task.taskId}，项目：${task.workspaceTitle}）。`,
    ]
    if (report.outcome !== 'completed') lines.push(`本轮没有正常结束：${report.outcome}。`)
    const points = Array.from(report.text)
    lines.push('', '执行报告：', points.length === 0 ? '（没有文字回复）' : points.slice(0, reportChars).join(''))
    if (points.length > reportChars) {
        lines.push(`（报告共 ${points.length} 字，以上为开头；全文用 assistant_task_status 读取。）`)
    }
    lines.push(
        '',
        '请对照交付要求验收：用 assistant_task_review 接受、返修或取消。然后用一两句话把结果告诉用户，需要用户决定的事项列出来。',
    )
    return lines.join('\n')
}

/** 回合结束原因的说法（turn/end 的 reason.kind）；不认识的照原样写。 */
const OUTCOME_WORDS = Object.freeze({
    cancelled: '被中断',
    canceled: '被中断',
    interrupted: '被中断',
    aborted: '被中断',
    error: '出错',
    failed: '出错',
    unknown: '原因不明',
})

/**
 * 发到项目接的群的任务进度：固定的一句话，不经模型；完整回报与验收仍在发起会话。
 * @param task - 任务记录（用 title）。
 * @param round - 这一轮（用 round、report.outcome）。
 * @param event - `start`、`revise`、`redirect`、`done`、`failed`、`accepted`、`canceled`。
 * @returns 一句话。
 */
export function progressText(task, round, event) {
    const points = Array.from(task.title)
    const title = `「${points.length > 40 ? `${points.slice(0, 40).join('')}…` : task.title}」`
    switch (event) {
        case 'start': return `【任务】开始做${title}。`
        case 'revise': return `【任务】${title}按验收意见返修（第 ${round.round} 轮）。`
        case 'redirect': return `【任务】${title}要求改了，重新开始（第 ${round.round} 轮）。`
        case 'done': return `【任务】${title}做完了，等中枢验收。`
        case 'failed': {
            const kind = round.report?.outcome ?? 'unknown'
            return `【任务】${title}这一轮没有正常结束（${OUTCOME_WORDS[kind] ?? kind}），中枢会看。`
        }
        case 'accepted': return `【任务】${title}验收通过。`
        case 'canceled': return `【任务】${title}已取消。`
        default: throw new Error(`未知的任务进度：${event}`)
    }
}

/** 模型消息里的文字。 */
function modelText(message) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
    return message.content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim()
}

/**
 * 在会话事件里找一轮的结果：请求消息所在回合结束时，取该回合最后一段模型文字。
 * @param events - 会话事件（按 seq 升序）。
 * @param requestId - 本轮请求消息的 id。
 * @returns 回合尚未结束或请求还没进入会话时为 `null`；否则 `{ outcome, text, turn, endSeq }`，
 *   `outcome` 是回合结束原因（正常完成为 `completed`）。
 */
export function roundOutcome(events, requestId) {
    let current = null
    let turn = null
    let text = ''
    for (const event of events) {
        const data = event?.data
        if (event?.type === 'turn/start') {
            current = data?.turn ?? null
            continue
        }
        if (turn === null) {
            if (event?.type === 'user/message' && data?.id === requestId) turn = current
            continue
        }
        if (event.type === 'assistant/message' && data?.turn === turn && data.interrupted !== true) {
            const said = modelText(data.message)
            if (said !== '') text = said
            continue
        }
        if (event.type === 'turn/end' && data?.turn === turn) {
            return { outcome: data.reason?.kind ?? 'unknown', text, turn, endSeq: event.seq }
        }
    }
    return null
}
