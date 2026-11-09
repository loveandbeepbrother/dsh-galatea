/**
 * 内容库 `core.content`：心智和记忆的文件都经这里写，写入的顺序、留痕和恢复只做一遍。
 *
 * - 根目录是用户自己的内容目录（配置给出），路径都相对它，不许跳出去；框架不写死目录名和文件名。
 * - 一次调用可以改几个文件，提交成一次；`text: null` 是删除。
 * - 整次写入在一条队列里：核对 `baseHash`、写文件、提交三步都在队列里，基于同一版本的两次写入只有先到的过。
 * - 工具以外的改动（用户手改、会话直接改文件，程序分不出是谁）：写之前，涉及的文件有没提交的改动，先单独提交一次，
 *   写明是工具外改动。工具以外改的、新放进来的文件（比如模板），另由 `sweep` 定时提交，不然它们要等下次工具写才留痕，
 *   从来不经工具写的文件就一直不在仓库里。
 * - 提交失败就退回：用写之前留下的原始字节写回文件，再 `git reset -- <路径>` 退暂存区（不用 Git 恢复文件：
 *   `autocrlf` 会改字节，模型手里的 `baseHash` 就对不上了）。提交成没成看 HEAD 有没有变。
 * - Git 命令自己计时，到点结束整棵进程树（Windows 上 `git` 可能是一层包装，只结束外层，里层还拿着锁）。
 *   遇到 `index.lock`：没有命令行里带 `-C <内容库>` 的 Git 进程，就删掉锁、报一条异常，再试一次。
 * - 没有 Git、建不了仓库：照常原子写入，第一次报"内容库没有留痕，因为……"。
 * - 提交说明里带调用方，事后查得到是谁改的。
 *
 * @module @loveandbeepbrother/dsh-galatea/core/content
 */

import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

const IGNORED = ['*.lock', '*.tmp', '.mind-framework-*.tmp', 'workspace/', '*.bak-*']
const GIT_TIMEOUT_MS = 30_000
/** 工具以外的改动的作者：程序分不出是用户还是哪个会话改的，不写成用户。 */
const OUTSIDE_AUTHOR = '工具外改动 <outside@mind-framework.local>'

export class ContentConflictError extends Error {
    constructor(path, expected, actual) {
        super(`内容库里的 ${path} 已经变了（以为是 ${expected ?? '不存在'}，现在是 ${actual ?? '不存在'}），先重新读再改`)
        this.code = 'CONTENT_CONFLICT'
        this.path = path
    }
}

/** 文件字节的 sha256。 */
export const hashOf = bytes => createHash('sha256').update(bytes).digest('hex')

/** 调用方写进提交说明的样子。 */
export function callerLabel(by) {
    switch (by?.kind) {
        case 'user': return '用户'
        case 'session': return `会话 ${by.sessionId}${by.role ? `（${by.role}）` : ''}`
        case 'external': return `外部调用方 ${by.name}`
        case 'program': return `插件 ${by.plugin}`
        default: return '未知'
    }
}

/**
 * @param options.root - 内容目录（绝对路径）。
 * @param options.git - Git 命令（默认 `git`；测试可以换成不存在的命令模拟"没有 Git"）。
 * @param options.authorName - 助手提交的作者名（默认中性的"助手"）。
 * @param options.report - 报异常。
 * @param options.timeoutMs - 每条 Git 命令的超时。
 * @param options.starter - 起步模板 `{ 相对路径: 内容 }`：只在内容库第一次建成仓库时写进去，已经有的文件不碰。
 */
export function createContent({ root, git: gitCommand = 'git', authorName = '助手', report, timeoutMs = GIT_TIMEOUT_MS, starter = {} }) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('内容库要一个绝对路径的根目录')
    const base = normalize(root)
    let queue = Promise.resolve()
    let repository
    let untrackedReported = false
    const serial = (job) => {
        const next = queue.catch(() => {}).then(job)
        queue = next.catch(() => {})
        return next
    }

    /** 相对路径转成绝对路径，跳出根目录的不收。 */
    function resolvePath(path) {
        if (typeof path !== 'string' || path === '' || isAbsolute(path)) throw new TypeError(`内容库的路径要是相对路径：${path}`)
        const full = normalize(join(base, path))
        const rel = relative(base, full)
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep)[0] === '.git') throw new TypeError(`路径跳出了内容库：${path}`)
        return { full, rel: rel.split(sep).join('/') }
    }

    async function readBytes(full) {
        try {
            return await readFile(full)
        } catch (error) {
            if (error?.code === 'ENOENT') return null
            throw error
        }
    }

    async function read(path) {
        const { full } = resolvePath(path)
        const bytes = await readBytes(full)
        return bytes === null ? null : { text: bytes.toString('utf8'), hash: hashOf(bytes) }
    }

    async function list(dir = '.') {
        const start = dir === '.' || dir === '' ? base : resolvePath(dir).full
        const out = []
        async function walk(current) {
            let entries
            try {
                entries = await readdir(current, { withFileTypes: true })
            } catch (error) {
                if (error?.code === 'ENOENT') return
                throw error
            }
            for (const entry of entries) {
                if (entry.name === '.git') continue
                const full = join(current, entry.name)
                if (entry.isDirectory()) await walk(full)
                else if (entry.isFile()) out.push({ path: relative(base, full).split(sep).join('/'), hash: hashOf(await readFile(full)) })
            }
        }
        await walk(start)
        return out.sort((a, b) => a.path.localeCompare(b.path))
    }

    /* ------------------------------------------------------------------ Git */

    /** 跑一条 Git 命令：自己计时，到点结束整棵进程树。 */
    function runGit(args, { allowFailure = false } = {}) {
        return new Promise((resolve, reject) => {
            let child
            try {
                child = spawn(gitCommand, ['-C', base, '-c', `user.name=${authorName}`, '-c', 'user.email=assistant@mind-framework.local', ...args], { windowsHide: true })
            } catch (error) {
                reject(error)
                return
            }
            let stdout = ''
            let stderr = ''
            let timedOut = false
            child.stdout.on('data', chunk => { stdout += chunk })
            child.stderr.on('data', chunk => { stderr += chunk })
            const timer = setTimeout(() => {
                timedOut = true
                killTree(child.pid)
            }, timeoutMs)
            child.on('error', (error) => {
                clearTimeout(timer)
                reject(Object.assign(error, { gitMissing: error?.code === 'ENOENT' }))
            })
            child.on('close', (code) => {
                clearTimeout(timer)
                if (timedOut) reject(new Error(`git ${args[0]} 超过 ${timeoutMs / 1000} 秒没完成，已结束整棵进程树`))
                else if (code !== 0 && !allowFailure) reject(Object.assign(new Error(`git ${args[0]} 失败：${stderr.trim() || `退出码 ${code}`}`), { stderr }))
                else resolve({ code, stdout, stderr })
            })
        })
    }

    /** Git 命令遇到 `index.lock`：没有正在这个内容库里跑的 Git 进程，就删掉锁、报一条异常，再试一次。 */
    async function git(args, options) {
        try {
            return await runGit(args, options)
        } catch (error) {
            if (!/index\.lock/.test(error?.stderr ?? error?.message ?? '')) throw error
            const lock = join(base, '.git', 'index.lock')
            if (!existsSync(lock) || await gitRunningHere()) throw error
            await unlink(lock).catch(() => {})
            report('core/content-stale-lock', { text: `内容库的 index.lock 没有 Git 进程拿着，已删掉再试一次（${base}）` })
            return runGit(args, options)
        }
    }

    /** 有没有命令行里带着这个内容库路径的 Git 进程。 */
    function gitRunningHere() {
        return new Promise((resolve) => {
            const done = (output) => resolve(output.toLowerCase().includes(base.toLowerCase()))
            if (process.platform === 'win32') {
                execFile('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'git%'\" | ForEach-Object { $_.CommandLine }"],
                    { windowsHide: true }, (_error, stdout) => done(String(stdout ?? '')))
            } else {
                execFile('ps', ['-eo', 'args'], (_error, stdout) => done(String(stdout ?? '').split('\n').filter(line => /\bgit\b/.test(line)).join('\n')))
            }
        })
    }

    /** 准备好仓库：不是仓库就建一个；没有 Git、建不了时交回原因（之后照常写入，不留痕）。 */
    async function ensureRepository() {
        if (repository !== undefined) return repository
        try {
            await mkdir(base, { recursive: true })
            if (!existsSync(join(base, '.git'))) {
                await runGit(['init', '-q', '-b', 'main'])
                if (!existsSync(join(base, '.gitignore'))) await writeFile(join(base, '.gitignore'), `${IGNORED.join('\n')}\n`, 'utf8')
                // 起步模板只在第一次建成仓库时写，已经有的文件不碰。
                const seeded = []
                for (const [path, text] of Object.entries(starter)) {
                    const { full, rel } = resolvePath(path)
                    if (existsSync(full)) continue
                    await mkdir(dirname(full), { recursive: true })
                    await writeFile(full, text, 'utf8')
                    seeded.push(rel)
                }
                await runGit(['add', '-A'])
                await runGit(['commit', '-q', '--allow-empty', '-m', seeded.length === 0 ? '初始化内容库' : `初始化内容库（框架自带的起步模板：${seeded.join('、')}）`])
            }
            else {
                // 已有的仓库：框架要忽略的规则后来多了的，补上；用户自己写的不动。
                const ignore = join(base, '.gitignore')
                const current = existsSync(ignore) ? await readFile(ignore, 'utf8') : ''
                const missing = IGNORED.filter(rule => !current.split(/\r?\n/).includes(rule))
                if (missing.length > 0) await writeFile(ignore, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`, 'utf8')
            }
            repository = { ok: true }
        } catch (error) {
            repository = { ok: false, why: error?.gitMissing ? '找不到 Git' : (error?.message ?? String(error)) }
        }
        return repository
    }

    async function head() {
        const { code, stdout } = await git(['rev-parse', 'HEAD'], { allowFailure: true })
        return code === 0 ? stdout.trim() : null
    }

    /**
     * 工具以外改的、新放进来的文件，提交一次，写明是工具外改动（程序分不出是谁改的）。
     * @returns `{ paths }`：提交了哪些；没有要提交的、没有仓库时是空的。
     */
    function sweep() {
        return serial(async () => {
            const repo = await ensureRepository()
            if (!repo.ok) return { paths: [] }
            try {
                await git(['add', '-A'])
                const paths = (await git(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only'])).stdout.split(/\r?\n/).filter(Boolean)
                if (paths.length === 0) return { paths: [] }
                await git(['commit', '-q', `--author=${OUTSIDE_AUTHOR}`, '-m', `工具外改动：${paths.join('、')}`])
                return { paths }
            } catch (error) {
                await git(['reset', '-q'], { allowFailure: true }).catch(() => {})
                throw error
            }
        })
    }

    /* ------------------------------------------------------------------ 写入 */

    /**
     * 写入一批文件，提交成一次。
     * @param changes - `[{ path, text | null, baseHash }]`；`baseHash` 是读到时的哈希，新文件为 `null`。
     * @param options.message - 提交说明。
     * @param options.by - 调用方。
     * @returns `{ hashes: { 路径: 哈希 | null }, commit? }`。
     */
    function write(changes, { message, by } = {}) {
        if (!Array.isArray(changes) || changes.length === 0) return Promise.reject(new TypeError('write 至少要改一个文件'))
        if (typeof message !== 'string' || message.trim() === '') return Promise.reject(new TypeError('write 要写提交说明'))
        let planned
        try {
            planned = changes.map((change) => {
                if (change?.text !== null && typeof change?.text !== 'string') throw new TypeError(`${change?.path} 的 text 要是字符串或 null`)
                if (change.baseHash !== null && typeof change.baseHash !== 'string') throw new TypeError(`${change.path} 要写 baseHash（新文件写 null）`)
                return { ...resolvePath(change.path), text: change.text, baseHash: change.baseHash }
            })
        } catch (error) {
            return Promise.reject(error)
        }
        if (new Set(planned.map(item => item.rel)).size !== planned.length) return Promise.reject(new TypeError('同一个文件在一次写入里只能出现一次'))
        return serial(() => writeOnce(planned, message, by))
    }

    async function writeOnce(planned, message, by) {
        const repo = await ensureRepository()
        if (!repo.ok && !untrackedReported) {
            untrackedReported = true
            report('core/content-untracked', { text: `内容库没有留痕，因为${repo.why}；照常写入` })
        }
        const paths = planned.map(item => item.rel)

        // 用户手改：先以用户身份提交。
        // 不解析 status 的输出（中文、带空格的路径会被转义），逐个文件问，有改动的直接拿我们自己的相对路径去提交。
        if (repo.ok) {
            const edited = []
            for (const path of paths) {
                if ((await git(['status', '--porcelain', '--', path])).stdout.trim() !== '') edited.push(path)
            }
            if (edited.length > 0) {
                await git(['add', '-A', '--', ...edited])
                await git(['commit', '-q', `--author=${OUTSIDE_AUTHOR}`, '-m', `工具外改动：${edited.join('、')}`, '--', ...edited])
            }
        }

        // 核对 baseHash，留下原始字节。
        const originals = []
        for (const item of planned) {
            const bytes = await readBytes(item.full)
            const actual = bytes === null ? null : hashOf(bytes)
            if (actual !== item.baseHash) throw new ContentConflictError(item.rel, item.baseHash, actual)
            originals.push({ item, bytes })
        }

        // 写文件（先写临时文件再换名）。
        const hashes = {}
        try {
            for (const { item } of originals) {
                if (item.text === null) {
                    await rm(item.full, { force: true })
                    hashes[item.rel] = null
                    continue
                }
                const bytes = Buffer.from(item.text, 'utf8')
                await mkdir(dirname(item.full), { recursive: true })
                const temp = join(dirname(item.full), `.mind-framework-${randomBytes(6).toString('hex')}.tmp`)
                await writeFile(temp, bytes)
                await rename(temp, item.full)
                hashes[item.rel] = hashOf(bytes)
            }
        } catch (error) {
            await restore(originals)
            throw error
        }
        if (!repo.ok) return { hashes }

        // 提交；没成就用原始字节退回，并退暂存区。
        const before = await head()
        try {
            await git(['add', '-A', '--', ...paths])
            const staged = await git(['diff', '--cached', '--name-only', '--', ...paths])
            if (staged.stdout.trim() === '') return { hashes }
            await git(['commit', '-q', '-m', `${message.trim()}\n\n调用方：${callerLabel(by)}`, '--', ...paths])
        } catch (error) {
            const after = await head().catch(() => before)
            if (after !== before && after !== null) return { hashes, commit: after.slice(0, 12) }
            await restore(originals)
            await git(['reset', '-q', '--', ...paths], { allowFailure: true }).catch(() => {})
            throw new Error(`内容库提交失败，文件已退回写入前的样子（${error?.message ?? error}）`, { cause: error })
        }
        const after = await head()
        return { hashes, ...after !== null && after !== before ? { commit: after.slice(0, 12) } : {} }
    }

    async function restore(originals) {
        for (const { item, bytes } of originals) {
            try {
                if (bytes === null) await rm(item.full, { force: true })
                else {
                    await mkdir(dirname(item.full), { recursive: true })
                    await writeFile(item.full, bytes)
                }
            } catch {
                // 尽量退回；退不回的由调用方看到的错误说明。
            }
        }
    }

    /** 准备好内容库（不是仓库就建一个、写起步模板）：启动时调一次，不用等第一次写入。 */
    const prepare = () => serial(() => ensureRepository())

    /**
     * 文件每一行最后一次提交的时刻（毫秒，`git blame`）：便签按条给修改时间用。工作区里还没提交的行是 `null`
     * （工具外的改动要等定时的 `sweep` 才提交）。文件不在 Git 里、或者 blame 失败，返回 `null`。
     */
    async function lineTimes(path) {
        const result = await git(['blame', '--line-porcelain', '--', path], { allowFailure: true })
        if (result.code !== 0) return null
        const times = []
        let uncommitted = false
        for (const line of result.stdout.split('\n')) {
            if (/^[0-9a-f]{40} \d+ \d+/.test(line)) uncommitted = /^0{40} /.test(line)
            else if (line.startsWith('committer-time ')) times.push(uncommitted ? null : Number(line.slice('committer-time '.length)) * 1000)
        }
        return times
    }

    return Object.freeze({ read, list, write, sweep, prepare, lineTimes, root: base })
}

/** 结束整棵进程树：Windows 用 `taskkill /T /F`（趁外层还活着），别的系统发 SIGKILL。 */
function killTree(pid) {
    if (pid === undefined) return
    if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
        try {
            process.kill(pid, 'SIGKILL')
        } catch {
            // 已经退了。
        }
    }
}
