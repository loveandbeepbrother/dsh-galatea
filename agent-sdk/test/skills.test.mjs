import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, visibleSkills } from '../index.js'

test('助手能用的 skill：用户级 skill 目录里含 SKILL.md 的子目录（跟随联接，synced 除外），加上按名字放行的插件 skill', async () => {
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'skill-source-'))
    const skills = join(config, 'skills')
    const make = async (dir, withSkill = true) => {
        await mkdir(dir, { recursive: true })
        if (withSkill) await writeFile(join(dir, 'SKILL.md'), '---\nname: x\n---\n')
    }
    await make(join(skills, 'illustrating'))
    await make(join(skills, 'drafting'))
    await make(join(skills, 'notes'), false)
    await make(join(skills, 'synced', 'claude-ai-skill'))
    await writeFile(join(skills, 'synced', 'SKILL.md'), '')
    await make(join(elsewhere, 'review-skill'))
    await symlink(join(elsewhere, 'review-skill'), join(skills, 'reviewing'), 'junction')
    await symlink(join(elsewhere, 'gone'), join(skills, 'broken'), 'junction')

    assert.deepEqual(
        visibleSkills(config, ['anthropic-skills:pdf', 'anthropic-skills:docx']),
        ['drafting', 'illustrating', 'reviewing', 'anthropic-skills:pdf', 'anthropic-skills:docx'],
    )
    assert.deepEqual(visibleSkills(join(config, 'missing'), ['anthropic-skills:pdf']), ['anthropic-skills:pdf'], '目录不在时只有插件 skill')
})

test('配置：插件 skill 名单默认不填（不过滤，和 Claude Code 一样）；旧的按名字列出全部 skill 的配置项已去掉', () => {
    const config = new Config({ sdkEntry: 'sdk.mjs', defaultCwd: '.' })
    assert.equal(config.pluginSkills, undefined)
    assert.equal('skills' in config, false)
    assert.deepEqual(new Config({ sdkEntry: 'sdk.mjs', defaultCwd: '.', pluginSkills: ['anthropic-skills:pdf'] }).pluginSkills, ['anthropic-skills:pdf'])
    assert.deepEqual(new Config({ sdkEntry: 'sdk.mjs', defaultCwd: '.', pluginSkills: [] }).pluginSkills, [], '填空名单：只有用户级 skill')
})

test('配置：另加的 MCP 服务器默认没有；和产品工具同名（dsh）时启动就报错，不静默覆盖；浏览器专用的配置项已去掉', () => {
    const config = new Config({ sdkEntry: 'sdk.mjs', defaultCwd: '.' })
    assert.deepEqual([config.mcpServers, config.allowedTools, config.systemAppend], [{}, [], ''])
    assert.equal('browser' in config, false)
    assert.throws(() => apply({}, new Config({ sdkEntry: 'sdk.mjs', defaultCwd: '.', mcpServers: { dsh: { type: 'stdio', command: 'x' } } })),
        /mcpServers 里不能有名为 dsh 的服务器/)
})
