/**
 * 整合包真隔离 E2E：导入/创建 → 私有家目录 → 切换 → 导出 → 删除。
 *
 * 夹具忠实模拟主进程装配：settings store 按激活包派生 dshHome（与
 * electron/settings.ts 的 resolvePackHome 咽喉点同构），DSH 模拟器把安装
 * 效果写进「当前派生家目录」，因此包与包之间的插件/技能/预设物理隔离。
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, PackManifest } from '../src/types'
import { createPackManager, type InstallInstaller, type PackInstallTarget } from '../electron/pack'
import { buildPackZip, inspectPackZip } from '../electron/pack-zip'
import { readPackRegistry } from '../electron/pack-registry'
import { readPluginReceipts, recordPluginInstall, removePluginReceipt } from '../electron/plugin-receipts'
import { readProfile, togglePlugin } from '../electron/profile'
import { installSkillFromDirectory } from '../electron/skill-install'
import { defaultSettings } from '../electron/settings'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'dsh-pack-e2e-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

async function makeEnv(): Promise<{
  root: string
  dshHome: string
  packsRoot: string
  registryPath: string
  snapshotRoot: string
  pluginReceiptsPath: string
  presetReceiptsPath: string
  skillReceiptsPath: string
}> {
  const root = await temporaryDirectory()
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles'), { recursive: true })
  return {
    root,
    dshHome,
    packsRoot: path.join(root, 'dsh-packs'),
    registryPath: path.join(root, 'packs.json'),
    snapshotRoot: path.join(root, 'pack-snapshots'),
    pluginReceiptsPath: path.join(root, 'plugin-installs.json'),
    presetReceiptsPath: path.join(root, 'preset-installs.json'),
    skillReceiptsPath: path.join(root, 'skill-installs.json'),
  }
}

type Env = Awaited<ReturnType<typeof makeEnv>>

/** 模拟 SettingsStore 的派生咽喉点：read() 的 dshHome = 激活包私有家目录。 */
function makeSettingsStore(env: Env) {
  let stored: AppSettings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome: env.dshHome,
    dshVersion: '0.1.0-rc.7',
    profileName: 'web',
    activePackId: null,
  }
  const readSettings = async (): Promise<AppSettings> => {
    if (!stored.activePackId) return stored
    const records = await readPackRegistry(env.registryPath)
    const home = records.find(record => record.id === stored.activePackId)?.homePath
    return home ? { ...stored, dshHome: home } : stored
  }
  return {
    readSettings,
    saveSettings: async (next: AppSettings) => { stored = next; return next },
    readStoredSettings: async () => stored,
    get current(): AppSettings { return stored },
  }
}

type SettingsStore = ReturnType<typeof makeSettingsStore>

function makeManager(env: Env, installer: InstallInstaller, store: SettingsStore) {
  const emitEvent = vi.fn()
  const manager = createPackManager({
    readSettings: store.readSettings,
    saveSettings: store.saveSettings,
    registryPath: env.registryPath,
    snapshotRoot: env.snapshotRoot,
    pluginReceiptsPath: env.pluginReceiptsPath,
    presetReceiptsPath: env.presetReceiptsPath,
    skillReceiptsPath: env.skillReceiptsPath,
    applicationAddons: {
      list: async () => [],
      install: async () => ({}),
      uninstall: async () => [],
    },
    installer,
    emitEvent,
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    unifiedProfiles: true,
    packsRoot: env.packsRoot,
    readStoredSettings: store.readStoredSettings,
  })
  return { manager, emitEvent }
}

// ---------------------------------------------------------------------------
// 有状态 DSH 模拟器：落盘目标 = 当前派生家目录（激活包的家）。
// ---------------------------------------------------------------------------

interface DshSimulator extends InstallInstaller {
  failOn: Set<string>
  installCalls: PackInstallTarget[]
}

function createDshSimulator(store: SettingsStore, receiptsPath: string): DshSimulator {
  const failOn = new Set<string>()
  const installCalls: PackInstallTarget[] = []
  const homeOf = async () => (await store.readSettings()).dshHome

  async function readProfileManifest(profileName: string): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(path.join(await homeOf(), 'profiles', profileName, 'package.json'), 'utf8')) as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { name: profileName, private: true, version: '0.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }
      }
      throw error
    }
  }

  async function writeProfileManifest(profileName: string, manifest: Record<string, unknown>): Promise<void> {
    const dir = path.join(await homeOf(), 'profiles', profileName)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  const installPluginTarget: InstallInstaller['installPluginTarget'] = async (target) => {
    if (failOn.has(target.packageName)) throw new Error(`模拟安装失败：${target.packageName}`)
    installCalls.push(target)
    const home = await homeOf()
    const profileName = target.profileName
    const pkgDir = path.join(home, 'profiles', profileName, 'node_modules', ...target.packageName.split('/'))
    await mkdir(pkgDir, { recursive: true })
    if (target.source === 'local-directory' && target.localDirectory) {
      if (!existsSync(path.join(target.localDirectory, 'package.json'))) {
        throw new Error(`本地插件本体缺少 package.json：${target.localDirectory}`)
      }
      await cp(target.localDirectory, pkgDir, { recursive: true })
    } else {
      await writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: target.packageName, version: target.version ?? '1.0.0' }, null, 2),
      )
    }
    const manifest = await readProfileManifest(profileName)
    const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) }
    const spec = target.source === 'npm'
      ? `${target.packageName}@${target.version ?? '^1.0.0'}`
      : target.source === 'github'
        ? `github:${target.repository ?? 'demo/owner'}#${target.commit || 'HEAD'}`
        : `file:../.pack-bodies/${target.packageName}`
    dependencies[target.packageName] = spec
    const profile = (manifest.dsh as { profile?: { bundles?: string[] } } | undefined)?.profile ?? { bundles: [] }
    const bundles = profile.bundles ?? []
    if (!bundles.includes(target.packageName)) bundles.push(target.packageName)
    await writeProfileManifest(profileName, {
      ...manifest,
      dependencies,
      dsh: { profile: { bundles } },
    })
    await recordPluginInstall(receiptsPath, {
      repository: target.repository ?? 'demo/owner',
      packageName: target.packageName,
      packId: profileName,
      source: target.source,
      subdirectory: target.subdirectory ?? null,
      version: target.version ?? null,
      commit: target.commit ?? '',
      installedAt: new Date().toISOString(),
    })
    return {}
  }

  const installSkillLocal: InstallInstaller['installSkillLocal'] = (home, skill) =>
    installSkillFromDirectory(home, skill.name, skill.format, skill.sourceDir)

  const remove: InstallInstaller['remove'] = async (packageName, profileName) => {
    const home = await homeOf()
    const profile = profileName!
    const manifest = await readProfileManifest(profile)
    const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) }
    delete dependencies[packageName]
    const bundles = ((manifest.dsh as { profile?: { bundles?: string[] } } | undefined)?.profile?.bundles ?? []).filter(name => name !== packageName)
    await writeProfileManifest(profile, {
      ...manifest,
      dependencies,
      dsh: { profile: { bundles } },
    })
    await rm(path.join(home, 'profiles', profile, 'node_modules', ...packageName.split('/')), { recursive: true, force: true })
    await removePluginReceipt(receiptsPath, profile, packageName)
    return readProfile(home, profile)
  }

  const installPreset: InstallInstaller['installPreset'] = async request => {
    if (failOn.has(request.name)) throw new Error(`模拟安装失败：${request.name}`)
    const destination = path.join(await homeOf(), '.agent-presets', request.name)
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'preset.yml'), `name: ${request.name}\n`)
    return {
      installedPreset: { name: request.name, path: destination, enabled: true },
      installedPresets: [],
    }
  }

  const installPresetLocal: InstallInstaller['installPresetLocal'] = async (home, preset) => {
    if (failOn.has(preset.name)) throw new Error(`模拟安装失败：${preset.name}`)
    const destination = path.join(home, '.agent-presets', preset.name)
    await mkdir(destination, { recursive: true })
    await cp(preset.sourceDir, destination, { recursive: true })
    return {}
  }

  const installSkill: InstallInstaller['installSkill'] = async request => {
    if (failOn.has(request.targetId)) throw new Error(`模拟安装失败：${request.targetId}`)
    return {
      installedSkill: {
        name: request.targetId,
        description: '',
        path: path.join(await homeOf(), 'skills', request.targetId),
        format: 'bundle',
        enabled: true,
        modelInvocable: false,
        userInvocable: false,
      },
      installedSkills: [],
    }
  }

  const installSkillPinned: InstallInstaller['installSkillPinned'] = async ({ target }) => {
    if (failOn.has(target.name)) throw new Error(`模拟安装失败：${target.name}`)
    const destination = path.join(await homeOf(), 'skills', target.name)
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'SKILL.md'), `---\nname: ${target.name}\ndescription: x\n---\n`)
    return {
      name: target.name,
      description: '',
      path: destination,
      format: target.format,
      enabled: true,
      modelInvocable: false,
      userInvocable: false,
    }
  }

  const toggleSkill: InstallInstaller['toggleSkill'] = async () => []
  const togglePreset: InstallInstaller['togglePreset'] = async () => []

  return {
    failOn,
    installCalls,
    installPluginTarget,
    installSkillLocal,
    installSkill,
    installSkillPinned,
    toggleSkill,
    installPreset,
    installPresetLocal,
    togglePreset,
    remove,
    readProfile: (home, profileName) => readProfile(home, profileName),
    togglePlugin: (home, profileName, packageName, enabled) => togglePlugin(home, profileName, packageName, enabled),
  }
}

// ---------------------------------------------------------------------------
// zip 构建器
// ---------------------------------------------------------------------------

async function writeStandardZip(env: Env, fileName: string, manifest: PackManifest, bodies: Map<string, string>): Promise<string> {
  const zipPath = path.join(env.root, fileName)
  await writeFile(zipPath, Buffer.from(buildPackZip({ ...manifest, dshVersion: manifest.dshVersion ?? '0.1.0-rc.7' }, bodies)))
  return zipPath
}

function rawZip(entries: Record<string, string>): Uint8Array {
  const zip = new AdmZip()
  for (const [rel, content] of Object.entries(entries)) zip.addFile(rel, Buffer.from(content))
  return zip.toBuffer()
}

async function writeRawZip(env: Env, fileName: string, entries: Record<string, string>): Promise<string> {
  const zipPath = path.join(env.root, fileName)
  await writeFile(zipPath, Buffer.from(rawZip(entries)))
  return zipPath
}

async function makePluginBody(env: Env, packageName: string, version = '1.2.3'): Promise<string> {
  const dir = path.join(env.root, 'bodies', ...packageName.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: packageName, version }, null, 2))
  await writeFile(path.join(dir, 'notes.txt'), `hello from ${packageName}`)
  return dir
}

const SKILL_DOC = '---\nname: my-skill\ndescription: A skill.\n---\nBody.\n'

/** 某包的家目录（注册表 homePath；缺省 = 默认家目录）。 */
async function packHome(env: Env, packId: string): Promise<string> {
  const records = await readPackRegistry(env.registryPath)
  return records.find(record => record.id === packId)?.homePath ?? env.dshHome
}

const profileDirOf = async (env: Env, packId: string) => path.join(await packHome(env, packId), 'profiles', packId)

// ===========================================================================
// 场景 A：标准包完整生命周期（私有家目录 + 激活指针）
// ===========================================================================

describe('pack E2E · 标准包生命周期（真隔离）', () => {
  it('分析→导入（自动激活进私有目录）→切换→导出→删除→回导', async () => {
    const env = await makeEnv()
    const store = makeSettingsStore(env)
    const sim = createDshSimulator(store, env.pluginReceiptsPath)
    const { manager } = makeManager(env, sim, store)

    const alphaBody = await makePluginBody(env, 'alpha')
    const manifest: PackManifest = {
      name: 'Alpha Pack',
      description: 'alpha pack',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const zipPath = await writeStandardZip(env, 'alpha-pack.zip', manifest, new Map([['alpha', alphaBody]]))

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('zip')
    expect(analysis.id).toBe('pack-alpha-pack')

    // 导入即供给私有家目录并激活：settings 的 activePackId/profileName 同步指向包 id。
    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['alpha'])
    expect(result.state).toBe('complete')
    expect(store.current.activePackId).toBe('pack-alpha-pack')
    expect(store.current.profileName).toBe('pack-alpha-pack')

    const home = await packHome(env, 'pack-alpha-pack')
    expect(home).toBe(path.join(env.packsRoot, 'pack-alpha-pack'))
    const packDir = await profileDirOf(env, 'pack-alpha-pack')
    expect(await readFile(path.join(packDir, 'node_modules', 'alpha', 'package.json'), 'utf8')).toContain('"alpha"')
    expect(await readFile(path.join(packDir, 'node_modules', 'alpha', 'notes.txt'), 'utf8')).toBe('hello from alpha')
    // 默认家目录完全没被写入——隔离成立。
    expect(existsSync(path.join(env.dshHome, 'profiles', 'pack-alpha-pack'))).toBe(false)

    const installedProfile = await sim.readProfile(home, 'pack-alpha-pack')
    expect(installedProfile.initialized).toBe(true)
    expect(installedProfile.activeBundles).toContain('alpha')

    const records = await readPackRegistry(env.registryPath)
    expect(records).toHaveLength(1)
    expect(records[0].source).toBe('zip')
    expect(records[0].homePath).toBe(home)
    expect(records[0].plugins).toEqual([{ packageName: 'alpha', enabled: true }])

    // listPacks：导入后该包 enabled=true。
    expect((await manager.listPacks())[0].enabled).toBe(true)

    // 单项停用/启用作用于包内 Profile。
    const disabled = await manager.togglePackItem('pack-alpha-pack', 'alpha', false)
    expect(disabled.plugins.find(p => p.packageName === 'alpha')?.enabled).toBe(false)
    expect((await sim.readProfile(home, 'pack-alpha-pack')).activeBundles).not.toContain('alpha')
    const reEnabled = await manager.togglePackItem('pack-alpha-pack', 'alpha', true)
    expect(reEnabled.plugins.find(p => p.packageName === 'alpha')?.enabled).toBe(true)

    // 导出：从包自己的家目录读取。
    const { zipPath: exportedZipPath } = await manager.exportPack('pack-alpha-pack')
    const exportedBytes = await readFile(exportedZipPath)
    const inspection = inspectPackZip(exportedBytes)
    expect(inspection.hasBodies).toBe(true)
    expect(inspection.bodyPackageNames).toEqual(['alpha'])

    // 删除激活中的包：允许；没有其它包时进入零包引导态（指针置空，不自动新建兜底包）。
    const removed = await manager.removePack('pack-alpha-pack')
    expect(removed.removed).toBe(1)
    expect(existsSync(home)).toBe(false)
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    expect(store.current.activePackId).toBeNull()
    expect((await readPluginReceipts(env.pluginReceiptsPath)).filter(r => r.packId === 'pack-alpha-pack')).toEqual([])

    // 零包状态下新建空白包：自动成为当前包（引导闭环），不再有兜底 web 包可删。
    const blank = await manager.createBlankPack({ name: 'Blank', dshVersion: null })
    expect(await packHome(env, blank.id)).toBe(path.join(env.packsRoot, blank.id))
    expect(store.current.activePackId).toBe(blank.id)

    // 回导导出的 zip：重建独立环境。
    const exportedPath = path.join(env.root, 'roundtrip.zip')
    await writeFile(exportedPath, exportedBytes)
    const reimported = await manager.importPack(exportedPath)
    expect(reimported.installed).toEqual(['alpha'])
    const reimportedHome = await packHome(env, 'pack-alpha-pack')
    expect((await sim.readProfile(reimportedHome, 'pack-alpha-pack')).activeBundles).toContain('alpha')
    expect(store.current.activePackId).toBe('pack-alpha-pack')
  })
})

// ===========================================================================
// 场景 B：raw 包——技能/预设落进包私有家目录，包间互不可见
// ===========================================================================

describe('pack E2E · raw 包资源隔离', () => {
  it('两个包各装同名技能，互不串扰；删包连技能一起消失', async () => {
    const env = await makeEnv()
    const store = makeSettingsStore(env)
    const sim = createDshSimulator(store, env.pluginReceiptsPath)
    const { manager } = makeManager(env, sim, store)

    const firstZip = await writeRawZip(env, 'game-pack.zip', {
      'Gaming Pack/plugin-alpha/package.json': JSON.stringify({ name: 'alpha', version: '1.2.3' }),
      'Gaming Pack/skills/my-skill/SKILL.md': SKILL_DOC,
    })
    const first = await manager.importPack(firstZip, undefined, { name: 'Game Pack' })
    expect(first.installed).toEqual(['alpha', 'my-skill'])
    const firstHome = await packHome(env, 'pack-game-pack')
    expect(await readFile(path.join(firstHome, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain('my-skill')
    // 默认家目录没有技能。
    expect(existsSync(path.join(env.dshHome, 'skills'))).toBe(false)

    const secondZip = await writeRawZip(env, 'second.zip', {
      'README.txt': 'marker to avoid wrapper detection',
      'my-skill/SKILL.md': SKILL_DOC,
    })
    const second = await manager.importPack(secondZip, undefined, { name: 'Second' })
    expect(second.installed).toEqual(['my-skill'])
    const secondHome = await packHome(env, 'pack-second')
    expect(await readFile(path.join(secondHome, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain('my-skill')
    // 激活指针已切到第二个包；第一个包的家目录原封不动。
    expect(store.current.activePackId).toBe('pack-second')
    expect(existsSync(path.join(firstHome, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)

    // 删除第一个包（当前未激活）：整家删除；第二个包不受影响。
    await manager.removePack('pack-game-pack')
    expect(existsSync(firstHome)).toBe(false)
    expect(existsSync(path.join(secondHome, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
  })

  it('导入含预设的整合包：预设落包私有家目录，删包清理', async () => {
    const env = await makeEnv()
    const store = makeSettingsStore(env)
    const sim = createDshSimulator(store, env.pluginReceiptsPath)
    const { manager } = makeManager(env, sim, store)

    const manifest: PackManifest = {
      name: 'Preset E2E',
      description: 'preset e2e',
      version: '1.0.0',
      plugins: [],
      presets: [{
        name: 'router-standard',
        repository: 'demo/preset-repo',
        sourcePath: 'preset/router-standard',
        revision: 'abc1234',
      }],
    }
    const zipPath = await writeStandardZip(env, 'preset-e2e.zip', manifest, new Map())
    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['router-standard'])
    const home = await packHome(env, 'pack-preset-e2e')
    expect(existsSync(path.join(home, '.agent-presets', 'router-standard'))).toBe(true)
    const records = await readPackRegistry(env.registryPath)
    expect(records[0].presets).toEqual([{ name: 'router-standard', enabled: true }])

    // 切到空白包再删，预设随家目录消失。
    const blank = await manager.createBlankPack({ name: 'Other', dshVersion: null })
    await manager.activatePack(blank.id)
    await manager.removePack('pack-preset-e2e')
    expect(existsSync(home)).toBe(false)
  })
})

// ===========================================================================
// 场景 C：中途失败 → partial + 回滚
// ===========================================================================

describe('pack E2E · 中途失败回滚', () => {
  it('raw 导入单项失败：state=partial；回滚还原包目录与注册表', async () => {
    const env = await makeEnv()
    const store = makeSettingsStore(env)
    const sim = createDshSimulator(store, env.pluginReceiptsPath)
    sim.failOn.add('beta')
    const { manager } = makeManager(env, sim, store)

    const zipPath = await writeRawZip(env, 'partial-pack.zip', {
      'plugin-alpha/package.json': JSON.stringify({ name: 'alpha' }),
      'plugin-beta/package.json': JSON.stringify({ name: 'beta' }),
      'skills/my-skill/SKILL.md': SKILL_DOC,
    })

    const result = await manager.importPack(zipPath, undefined, { name: 'Partial Pack' })
    expect(result.state).toBe('partial')
    expect(result.installed).toEqual(['alpha', 'my-skill'])
    expect(result.failures).toEqual([{ packageName: 'beta', reason: '模拟安装失败：beta' }])
    const home = await packHome(env, 'pack-partial-pack')
    expect(await readFile(path.join(home, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain('my-skill')
    expect(await readPackRegistry(env.registryPath)).toHaveLength(1)
    await expect(manager.hasSnapshot()).resolves.toBe(true)

    const rolledBack = await manager.rollback()
    expect(rolledBack.profileName).toBe('pack-partial-pack')
    expect(existsSync(home)).toBe(false)
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    await expect(manager.hasSnapshot()).resolves.toBe(false)
  })
})

// ===========================================================================
// 场景 D：包计数实时化（注册表不记市场安装，列表以家目录为准）
// ===========================================================================

describe('pack E2E · 包计数实时化', () => {
  it('listPacks 的插件/技能计数实时反映包家目录（市场安装不写注册表也能看到）', async () => {
    const env = await makeEnv()
    const store = makeSettingsStore(env)
    const sim = createDshSimulator(store, env.pluginReceiptsPath)
    const { manager } = makeManager(env, sim, store)

    // 零包状态新建：自动激活，私有家目录就位。
    const blank = await manager.createBlankPack({ name: 'Live', dshVersion: null })
    const home = await packHome(env, blank.id)

    // 模拟市场/npm 安装：只写家目录（profile manifest + skills/），不写注册表记录。
    await sim.installPluginTarget({ profileName: blank.id, packageName: 'alpha', source: 'npm', version: '1.2.3', repository: 'demo/owner' } as never, undefined)
    const skillSource = path.join(home, '.skill-src', 'my-skill')
    await mkdir(skillSource, { recursive: true })
    await writeFile(path.join(skillSource, 'SKILL.md'), SKILL_DOC)
    await sim.installSkillLocal(home, { name: 'my-skill', format: 'bundle', sourceDir: skillSource })

    // 注册表记录仍是空骨架，但列表计数以家目录为准。
    const records = await readPackRegistry(env.registryPath)
    expect(records[0].plugins).toEqual([])
    const status = (await manager.listPacks()).find(pack => pack.id === blank.id)
    expect(status?.plugins.map(plugin => plugin.packageName)).toEqual(['alpha'])
    expect(status?.plugins[0]?.enabled).toBe(true)
    expect(status?.skills?.map(skill => skill.name)).toEqual(['my-skill'])
    expect(status?.skills?.[0]?.enabled).toBe(true)
  })
})

// ===========================================================================
// 场景 E：导出不含个人数据
// ===========================================================================

describe('pack E2E · 导出隐私边界', () => {
  it('包家目录里的凭据/会话文件不进导出 zip', async () => {
    const env = await makeEnv()
    const store = makeSettingsStore(env)
    const sim = createDshSimulator(store, env.pluginReceiptsPath)
    const { manager } = makeManager(env, sim, store)

    const alphaBody = await makePluginBody(env, 'alpha')
    const manifest: PackManifest = {
      name: 'Privacy Pack',
      description: 'privacy boundary check',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const zipPath = await writeStandardZip(env, 'privacy.zip', manifest, new Map([['alpha', alphaBody]]))
    await manager.importPack(zipPath)

    const home = await packHome(env, 'pack-privacy-pack')
    await writeFile(path.join(home, '.credentials.yaml'), 'deepseek: { api_key: SECRET }\n', 'utf8')
    await mkdir(path.join(home, 'sessions', 'proj'), { recursive: true })
    await writeFile(path.join(home, 'sessions', 'proj', 'session.jsonl'), '{"secret":"chat"}', 'utf8')

    const { zipPath: exported } = await manager.exportPack('pack-privacy-pack')
    const entries = new AdmZip(Buffer.from(await readFile(exported))).getEntries().map(entry => entry.entryName)
    expect(entries.some(entry => /credentials/i.test(entry))).toBe(false)
    expect(entries.some(entry => /sessions/i.test(entry))).toBe(false)
    expect(entries.some(entry => entry.includes('alpha'))).toBe(true)
  })
})

// 防止 readdir 被 tree-shake 误报未使用（部分场景用目录枚举断言）。
void readdir
