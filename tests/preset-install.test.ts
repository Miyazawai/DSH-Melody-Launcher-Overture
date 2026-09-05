import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { installPresetFromDirectory, installPresetFromRepository, readBuiltinAgentPresets, readInstalledPresets, toggleInstalledPreset, uninstallInstalledPreset } from '../electron/preset-install'
import { readPresetReceipts, recordPresetInstall } from '../electron/preset-receipts'
import type { PresetInstallTarget } from '../src/types'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function presetTarget(overrides: Partial<PresetInstallTarget> = {}): PresetInstallTarget {
  return {
    id: 'router-standard:preset/router-standard',
    name: 'router-standard',
    description: 'Standard routing preset.',
    sourceRepository: 'yjh051108/dsh-router-standard',
    revision: 'e'.repeat(40),
    sourcePath: 'preset/router-standard',
    ...overrides,
  }
}

/** 构造一个仓库 zip：根目录 + 预设目录 + 一个仓库根文件（不应被安装）。 */
function presetZip(presetName: string, resources?: Record<string, string>): Buffer {
  const zip = new AdmZip()
  const root = 'preset-repo-main'
  zip.addFile(`${root}/preset/${presetName}/preset.yml`, Buffer.from(`name: ${presetName}\ndescription: demo preset\n`))
  for (const [relative, content] of Object.entries(resources ?? {})) {
    zip.addFile(`${root}/preset/${presetName}/${relative}`, Buffer.from(content))
  }
  zip.addFile(`${root}/README.md`, Buffer.from('repo readme'))
  zip.addFile(`${root}/other/unrelated.txt`, Buffer.from('do not install'))
  return zip.toBuffer()
}

// 见 skill-install.test.ts：Buffer 现在是泛型，不再是合法的 BodyInit。
function fetchFor(archive: Buffer): typeof fetch {
  return (async () => new Response(new Uint8Array(archive), {
    status: 200,
    headers: { 'content-length': String(archive.byteLength) },
  })) as typeof fetch
}

async function freshRoots(): Promise<{ dshHome: string; cacheRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-preset-install-'))
  temporaryRoots.push(root)
  return { dshHome: path.join(root, 'home'), cacheRoot: path.join(root, 'cache') }
}

it('从本地目录安装预设：复制到 .agent-presets/<name>', async () => {
  const { dshHome } = await freshRoots()
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-preset-local-'))
  temporaryRoots.push(sourceDir)
  await writeFile(path.join(sourceDir, 'preset.yml'), 'name: router-standard\n')
  await writeFile(path.join(sourceDir, 'rules.yml'), 'rules')

  const installed = await installPresetFromDirectory(dshHome, 'router-standard', sourceDir)
  expect(installed.enabled).toBe(true)
  expect(await readFile(path.join(dshHome, '.agent-presets', 'router-standard', 'preset.yml'), 'utf8')).toContain('router-standard')
  expect(await readFile(path.join(dshHome, '.agent-presets', 'router-standard', 'rules.yml'), 'utf8')).toBe('rules')
})

it('把 preset/<variant> 目录复制到 .agent-presets/<name>，跳过预设目录外的文件', async () => {
  const { dshHome, cacheRoot } = await freshRoots()
  const zip = presetZip('router-standard', { 'routing/rules.yml': 'rules', 'README.md': 'preset readme' })

  const installed = await installPresetFromRepository(
    cacheRoot, dshHome, 'yjh051108/dsh-router-standard', presetTarget(), () => undefined, fetchFor(zip),
  )

  expect(installed.name).toBe('router-standard')
  expect(installed.path).toBe(path.join(dshHome, '.agent-presets', 'router-standard'))
  expect(await readFile(path.join(dshHome, '.agent-presets', 'router-standard', 'preset.yml'), 'utf8')).toContain('name: router-standard')
  expect(await readFile(path.join(dshHome, '.agent-presets', 'router-standard', 'routing', 'rules.yml'), 'utf8')).toBe('rules')
  // 预设目录内的同名 README 会被安装；仓库根 / other/ 的不在预设目录下，不装。
  expect(await readFile(path.join(dshHome, '.agent-presets', 'router-standard', 'README.md'), 'utf8')).toContain('preset readme')
  await expect(readFile(path.join(dshHome, '.agent-presets', 'router-standard', 'unrelated.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readInstalledPresets(dshHome)).map(preset => preset.name)).toEqual(['router-standard'])
})

it('预设目录缺 preset.yml 时拒绝（下载内容与最初确认不一致）', async () => {
  const { dshHome, cacheRoot } = await freshRoots()
  const zip = new AdmZip()
  zip.addFile('preset-repo-main/preset/router-standard/routing/rules.yml', Buffer.from('rules'))
  const archive = zip.toBuffer()

  await expect(installPresetFromRepository(
    cacheRoot, dshHome, 'yjh051108/dsh-router-standard', presetTarget(), () => undefined, fetchFor(archive),
  )).rejects.toThrow('preset.yml')
  expect(await readInstalledPresets(dshHome)).toEqual([])
})

it('非法预设名 / 非法来源路径 / 非安全仓库均拒绝', async () => {
  const { dshHome, cacheRoot } = await freshRoots()
  const zip = presetZip('router-standard')
  const badName = presetTarget({ name: 'Bad_Name' })
  await expect(installPresetFromRepository(cacheRoot, dshHome, 'yjh051108/dsh-router-standard', badName, () => undefined, fetchFor(zip))).rejects.toThrow()
  const badSourcePath = presetTarget({ sourcePath: '../escape' })
  await expect(installPresetFromRepository(cacheRoot, dshHome, 'yjh051108/dsh-router-standard', badSourcePath, () => undefined, fetchFor(zip))).rejects.toThrow()
  await expect(installPresetFromRepository(cacheRoot, dshHome, 'not a repo', presetTarget(), () => undefined, fetchFor(zip))).rejects.toThrow()
})

it('压缩包包含越出仓库根的文件时拒绝（防路径穿越）', async () => {
  const { dshHome, cacheRoot } = await freshRoots()
  const zip = new AdmZip()
  zip.addFile('preset-repo-main/preset/router-standard/preset.yml', Buffer.from('name: router-standard\n'))
  zip.addFile('../evil.yml', Buffer.from('escape'))
  const archive = zip.toBuffer()

  await expect(installPresetFromRepository(
    cacheRoot, dshHome, 'yjh051108/dsh-router-standard', presetTarget(), () => undefined, fetchFor(archive),
  )).rejects.toThrow('不安全路径')
})

it('readInstalledPresets 只列出含 preset.yml 的目录，忽略其他目录', async () => {
  const { dshHome } = await freshRoots()
  await mkdir(path.join(dshHome, '.agent-presets', 'router-standard'), { recursive: true })
  await mkdir(path.join(dshHome, '.agent-presets', 'scratch'), { recursive: true })
  await writeFile(path.join(dshHome, '.agent-presets', 'router-standard', 'preset.yml'), 'name: router-standard\n')
  await writeFile(path.join(dshHome, '.agent-presets', 'scratch', 'rules.yml'), 'no preset')

  expect(await readInstalledPresets(dshHome)).toEqual([
    { name: 'router-standard', path: path.join(dshHome, '.agent-presets', 'router-standard'), enabled: true },
  ])
})

it('toggleInstalledPreset 在启用/停用目录间移动预设并标注 enabled', async () => {
  const { dshHome } = await freshRoots()
  const root = path.join(dshHome, '.agent-presets')
  await mkdir(path.join(root, 'router-standard'), { recursive: true })
  await writeFile(path.join(root, 'router-standard', 'preset.yml'), 'name: router-standard\n')

  const disabled = await toggleInstalledPreset(dshHome, 'router-standard', false)
  expect(disabled).toEqual([
    { name: 'router-standard', path: path.join(root, '.disabled', 'router-standard'), enabled: false },
  ])
  // 目录已移到 .disabled 下，DSH 不再可见。
  await expect(readFile(path.join(root, 'router-standard', 'preset.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(path.join(root, '.disabled', 'router-standard', 'preset.yml'), 'utf8')).resolves.toContain('name: router-standard')

  const reenabled = await toggleInstalledPreset(dshHome, 'router-standard', true)
  expect(reenabled).toEqual([
    { name: 'router-standard', path: path.join(root, 'router-standard'), enabled: true },
  ])
  await expect(readFile(path.join(root, 'router-standard', 'preset.yml'), 'utf8')).resolves.toContain('name: router-standard')
  await expect(readFile(path.join(root, '.disabled', 'router-standard', 'preset.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('toggleInstalledPreset 未知预设报错；幂等操作直接返回当前列表', async () => {
  const { dshHome } = await freshRoots()
  const root = path.join(dshHome, '.agent-presets')
  await mkdir(path.join(root, 'router-standard'), { recursive: true })
  await writeFile(path.join(root, 'router-standard', 'preset.yml'), 'name: router-standard\n')

  await expect(toggleInstalledPreset(dshHome, 'not-installed', false)).rejects.toThrow('未找到本地预设')
  const unchanged = await toggleInstalledPreset(dshHome, 'router-standard', true)
  expect(unchanged.map(preset => preset.name)).toEqual(['router-standard'])
  expect(unchanged[0].enabled).toBe(true)
})

it('预设文件数量超过安全上限时拒绝', async () => {
  const { dshHome, cacheRoot } = await freshRoots()
  const zip = new AdmZip()
  const root = 'preset-repo-main'
  zip.addFile(`${root}/preset/router-standard/preset.yml`, Buffer.from('name: router-standard\n'))
  for (let index = 0; index < 5_001; index += 1) {
    zip.addFile(`${root}/preset/router-standard/f-${index}.txt`, Buffer.from('x'))
  }
  const archive = zip.toBuffer()

  await expect(installPresetFromRepository(
    cacheRoot, dshHome, 'yjh051108/dsh-router-standard', presetTarget(), () => undefined, fetchFor(archive),
  )).rejects.toThrow(/安全限制|安全上限/)
}, 30_000)

async function seedPreset(dshHome: string, name: string): Promise<void> {
  await mkdir(path.join(dshHome, '.agent-presets', name), { recursive: true })
  await writeFile(path.join(dshHome, '.agent-presets', name, 'preset.yml'), `name: ${name}\n`)
}

it('uninstallInstalledPreset 删除目录与安装凭据，保留其他预设', async () => {
  const { dshHome } = await freshRoots()
  const receiptsPath = path.join(dshHome, 'preset-receipts.json')
  await seedPreset(dshHome, 'router-standard')
  await seedPreset(dshHome, 'websearch-pro')
  await recordPresetInstall(receiptsPath, {
    name: 'router-standard',
    repository: 'yjh051108/dsh-router-standard',
    sourcePath: 'preset/router-standard',
    revision: 'e'.repeat(40),
    installedAt: '2026-08-23T00:00:00.000Z',
  })

  const remaining = await uninstallInstalledPreset(dshHome, 'router-standard', receiptsPath)

  expect(remaining.map(preset => preset.name)).toEqual(['websearch-pro'])
  await expect(readFile(path.join(dshHome, '.agent-presets', 'router-standard', 'preset.yml'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(path.join(dshHome, '.agent-presets', 'websearch-pro', 'preset.yml'), 'utf8')).resolves.toContain('websearch-pro')
  expect((await readPresetReceipts(receiptsPath)).map(receipt => receipt.name)).toEqual([])
})

it('uninstallInstalledPreset 可删除停用状态的预设（.disabled 位置）', async () => {
  const { dshHome } = await freshRoots()
  const receiptsPath = path.join(dshHome, 'preset-receipts.json')
  await seedPreset(dshHome, 'router-standard')
  await toggleInstalledPreset(dshHome, 'router-standard', false)

  const remaining = await uninstallInstalledPreset(dshHome, 'router-standard', receiptsPath)

  expect(remaining).toEqual([])
  await expect(readFile(path.join(dshHome, '.agent-presets', '.disabled', 'router-standard', 'preset.yml'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('uninstallInstalledPreset 未知或非法预设名报错', async () => {
  const { dshHome } = await freshRoots()
  const receiptsPath = path.join(dshHome, 'preset-receipts.json')
  await seedPreset(dshHome, 'router-standard')

  await expect(uninstallInstalledPreset(dshHome, 'not-installed', receiptsPath)).rejects.toThrow('未找到本地预设')
  await expect(uninstallInstalledPreset(dshHome, 'Bad_Name', receiptsPath)).rejects.toThrow('预设名称无效')
  expect((await readInstalledPresets(dshHome)).map(preset => preset.name)).toEqual(['router-standard'])
})

describe('内置预设布局探测（新版 DSH 拆包）', () => {
  it('旧布局 config/agent-presets 仍可枚举', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'preset-old-'))
    temporaryRoots.push(root)
    const pkg = path.join(root, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(path.join(pkg, 'config', 'agent-presets', 'standard'), { recursive: true })
    await writeFile(path.join(pkg, 'config', 'agent-presets', 'standard', 'preset.yml'), 'name: 标准\n', 'utf8')
    const presets = await readBuiltinAgentPresets(pkg)
    expect(presets.map(p => p.name)).toEqual(['standard'])
  })

  it('新布局：.pnpm 下的 dsh-agent-presets/presets 能被找到', async () => {
    const versionRoot = await mkdtemp(path.join(os.tmpdir(), 'preset-new-'))
    temporaryRoots.push(versionRoot)
    const pkg = path.join(versionRoot, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(pkg, { recursive: true })
    const presetsDir = path.join(versionRoot, 'node_modules', '.pnpm', '@deepseek-ai+dsh-agent-pres_abc123', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
    for (const name of ['standard', 'cordis']) {
      await mkdir(path.join(presetsDir, name), { recursive: true })
      await writeFile(path.join(presetsDir, name, 'preset.yml'), `name: ${name}\n`, 'utf8')
    }
    const presets = await readBuiltinAgentPresets(pkg)
    expect(presets.map(p => p.name).sort()).toEqual(['cordis', 'standard'])
  })
})
