import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, InstalledSkill, PackManifest, PackPluginEntry, ProfileState } from '../src/types'
import { assertActivePackForStart, createPackManager, type PackInstallTarget } from '../electron/pack'
import { buildPackZip, inspectPackZip } from '../electron/pack-zip'
import { readPackRegistry, upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { recordPluginInstall, type PluginInstallReceipt } from '../electron/plugin-receipts'
import { recordPresetInstall } from '../electron/preset-receipts'
import { defaultSettings } from '../electron/settings'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'dsh-pack-mgr-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

async function makeEnv(): Promise<{
  root: string
  dshHome: string
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
    registryPath: path.join(root, 'packs.json'),
    snapshotRoot: path.join(root, 'pack-snapshots'),
    pluginReceiptsPath: path.join(root, 'plugin-installs.json'),
    presetReceiptsPath: path.join(root, 'preset-installs.json'),
    skillReceiptsPath: path.join(root, 'skill-installs.json'),
  }
}

const defaultProfile: ProfileState = {
  initialized: true,
  profileDir: '',
  manifestPath: '',
  plugins: [],
  activeBundles: [],
  dependencyCount: 0,
  disabledCount: 0,
}

function makeInstallerStub() {
  const installPluginTarget = vi.fn(async (_target: PackInstallTarget): Promise<void> => {})
  const installSkillLocal = vi.fn(async (_dshHome: string, _skill: { name: string; format: 'bundle' | 'flat'; sourceDir: string }): Promise<void> => {})
  const installPreset = vi.fn(async (request: { name: string }): Promise<{ installedPreset: { name: string; path: string; enabled: boolean }; installedPresets: never[] }> => ({
    installedPreset: { name: request.name, path: path.join(process.cwd(), request.name), enabled: true },
    installedPresets: [],
  }))
  const installPresetLocal = vi.fn(async (_dshHome: string, _preset: { name: string; sourceDir: string }): Promise<void> => {})
  const installSkill = vi.fn(async (_request: { repository: string; targetId: string }): Promise<{ installedSkill: InstalledSkill; installedSkills: never[] }> => ({
    installedSkill: {
      name: _request.targetId,
      description: '',
      path: path.join(process.cwd(), _request.targetId),
      format: 'bundle',
      enabled: true,
      modelInvocable: false,
      userInvocable: false,
    },
    installedSkills: [],
  }))
  const installSkillPinned = vi.fn(async (_request: { repository: string; target: { name: string } }): Promise<InstalledSkill> => ({
    name: _request.target.name,
    description: '',
    path: path.join(process.cwd(), _request.target.name),
    format: 'bundle',
    enabled: true,
    modelInvocable: false,
    userInvocable: false,
  }))
  const toggleSkill = vi.fn(async (_name: string, _enabled: boolean): Promise<never[]> => [])
  const togglePreset = vi.fn(async (_name: string, _enabled: boolean): Promise<never[]> => [])
  const remove = vi.fn(async (_packageName: string, _profileName?: string): Promise<void> => {})
  const readProfile = vi.fn(async (): Promise<ProfileState> => defaultProfile)
  const togglePlugin = vi.fn(async (): Promise<ProfileState> => defaultProfile)
  return {
    installPluginTarget,
    installSkillLocal,
    installSkill,
    installSkillPinned,
    toggleSkill,
    installPreset,
    installPresetLocal,
    togglePreset,
    remove,
    readProfile,
    togglePlugin,
  }
}

type InstallerStub = ReturnType<typeof makeInstallerStub>

function makeSettings(dshHome: string, profileName = 'web') {
  let current: AppSettings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome,
    dshVersion: '0.1.0-rc.7',
    profileName,
  }
  const saveSettings = vi.fn(async (next: AppSettings) => { current = next; return current })
  const readSettings = vi.fn(async () => current)
  return { readSettings, saveSettings, get current(): AppSettings { return current } }
}

type SettingsStoreMock = ReturnType<typeof makeSettings>

interface MakeManagerOptions {
  isRuntimeRunning?: () => boolean
  isInstallerBusy?: () => boolean
}

function makeManager(
  env: Awaited<ReturnType<typeof makeEnv>>,
  installer: InstallerStub,
  store: SettingsStoreMock,
  options: MakeManagerOptions = {},
) {
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
      list: vi.fn(async () => []),
      install: vi.fn(async () => {}),
      uninstall: vi.fn(async () => []),
    },
    installer,
    emitEvent,
    isRuntimeRunning: options.isRuntimeRunning ?? (() => false),
    isInstallerBusy: options.isInstallerBusy ?? (() => false),
    dshHome: env.dshHome,
  })
  return { manager, emitEvent }
}

function recordFor(id: string, plugins: PackRecord['plugins'] = []): PackRecord {
  return {
    id,
    name: id,
    description: '',
    version: '1.0.0',
    source: 'created',
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'complete',
    plugins,
  }
}

function receipt(packageName: string, packId: string, source: PluginInstallReceipt['source'] = 'npm'): PluginInstallReceipt {
  return {
    repository: 'demo/owner',
    packageName,
    packId,
    source,
    subdirectory: null,
    version: '1.2.3',
    commit: 'abc1234',
    installedAt: new Date().toISOString(),
  }
}

async function writeZip(env: Awaited<ReturnType<typeof makeEnv>>, fileName: string, manifest: PackManifest, bodies: Map<string, string>): Promise<string> {
  const zipPath = path.join(env.root, fileName)
  await writeFile(zipPath, Buffer.from(buildPackZip({ ...manifest, dshVersion: manifest.dshVersion ?? '0.1.0-rc.7' }, bodies)))
  return zipPath
}

/** 非标准 raw zip：任意路径 → 内容的字节构建器（不经 buildPackZip，可无 dsh-pack.yaml）。 */
function rawZip(entries: Record<string, string>): Uint8Array {
  const zip = new AdmZip()
  for (const [rel, content] of Object.entries(entries)) zip.addFile(rel, Buffer.from(content))
  return zip.toBuffer()
}

async function writeRawZip(env: Awaited<ReturnType<typeof makeEnv>>, fileName: string, entries: Record<string, string>): Promise<string> {
  const zipPath = path.join(env.root, fileName)
  await writeFile(zipPath, Buffer.from(rawZip(entries)))
  return zipPath
}

const SKILL_DOC = '---\nname: my-skill\ndescription: A skill.\n---\nBody.\n'

function managedPlugin(packageName: string) {
  return {
    packageName,
    displayName: packageName,
    version: '1.0.0',
    description: '',
    enabled: true,
    builtin: false,
    locked: false,
    compatible: true,
    order: 1,
  }
}

// ---------------------------------------------------------------------------
// createPack
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// importPack
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// analyzeImport
// ---------------------------------------------------------------------------

describe('analyzeImport', () => {
  it('有 body 的包：按 bodyPackageNames 列出，offline = true', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const bodyRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-body-'))
    const alphaDir = path.join(bodyRoot, 'alpha')
    await mkdir(alphaDir, { recursive: true })
    await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha' }))

    const manifest: PackManifest = {
      name: 'An',
      description: 'a',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const zipPath = await writeZip(env, 'an.zip', manifest, new Map([['alpha', alphaDir]]))

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.id).toBe('pack-an')
    expect(analysis.source).toBe('zip')
    expect(analysis.items).toEqual([{ packageName: 'alpha', available: true, offline: true, enabled: true }])
    await rm(bodyRoot, { recursive: true, force: true })
  })

  it('manifest-only 缺 repository 且非 npm 源标不可用', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const plugin: PackPluginEntry = { packageName: 'broken', source: 'github' }
    const manifest: PackManifest = {
      name: 'An',
      description: 'a',
      version: '1.0.0',
      plugins: [plugin],
    }
    const zipPath = await writeZip(env, 'an.zip', manifest, new Map())

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('manifest')
    expect(analysis.items).toEqual([{
      packageName: 'broken',
      available: false,
      offline: false,
      reason: '缺少来源仓库，无法联网安装',
    }])
  })

  it('无清单 zip 回退 raw：source=raw，name 取文件名清洗值，技能项带 kind=skill', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, 'raw-an.zip', {
      'plugin-alpha/package.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
      'skills/my-skill/SKILL.md': SKILL_DOC,
    })

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('raw')
    expect(analysis.id).toBe('pack-raw-an')
    expect(analysis.name).toBe('raw-an')
    expect(analysis.items).toEqual([
      { packageName: 'alpha', available: true, offline: true },
      { packageName: 'my-skill', available: true, offline: true, kind: 'skill' },
    ])
  })

  it('无清单且文件名/顶层目录名无法清洗出 ASCII 时 name 为空', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, '整合包(1).zip', {
      '整合包/plugin-alpha/package.json': JSON.stringify({ name: 'alpha' }),
    })

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('raw')
    expect(analysis.name).toBe('')
    expect(analysis.id).toBe('')
  })
})

// ---------------------------------------------------------------------------
// removePack
// ---------------------------------------------------------------------------

describe('removePack runtime guard', () => {
  it('allows deleting an inactive pack while DSH runtime is running', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [managedPlugin('alpha')] })
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store, { isRuntimeRunning: () => true })
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [{ packageName: 'alpha', enabled: true }]))

    const result = await manager.removePack('pack-x')
    expect(result.removed).toBe(1)
    expect(await readPackRegistry(env.registryPath)).toEqual([])
  })

  it('blocks deleting the active pack while DSH runtime is running', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [managedPlugin('alpha')] })
    const store = makeSettings(env.dshHome, 'web')
    store.current.activePackId = 'pack-x'
    const { manager } = makeManager(env, stub, store, { isRuntimeRunning: () => true })
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [{ packageName: 'alpha', enabled: true }]))

    await expect(manager.removePack('pack-x')).rejects.toThrow('DSH 运行时正在运行')
    expect(await readPackRegistry(env.registryPath)).toHaveLength(1)
  })

  it('deleting the active pack falls back to another pack', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [managedPlugin('alpha')] })
    const store = makeSettings(env.dshHome, 'web')
    store.current.activePackId = 'pack-x'
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [{ packageName: 'alpha', enabled: true }]))
    await upsertPackRecord(env.registryPath, recordFor('pack-y'))

    await manager.removePack('pack-x')
    const records = await readPackRegistry(env.registryPath)
    expect(records.map(r => r.id)).toEqual(['pack-y'])
    expect(store.current.activePackId).toBe('pack-y')
    expect(store.current.profileName).toBe('pack-y')
  })

  it('deleting the only active pack leaves zero packs and clears the pointer', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [managedPlugin('alpha')] })
    const store = makeSettings(env.dshHome, 'web')
    store.current.activePackId = 'pack-x'
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [{ packageName: 'alpha', enabled: true }]))

    await manager.removePack('pack-x')
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    expect(store.current.activePackId).toBeNull()
    // 零包引导态：不再自动新建兜底 web 包。
    expect(existsSync(path.join(env.dshHome, 'profiles', 'web'))).toBe(false)
  })
})

describe('assertActivePackForStart', () => {
  const base = defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() })

  it('零包状态拒绝启动并引导新建', () => {
    expect(() => assertActivePackForStart({ ...base, activePackId: null })).toThrow('还没有整合包')
    expect(() => assertActivePackForStart({ ...base, activePackId: 'web' })).not.toThrow()
  })
})

describe('零包引导闭环（自动激活）', () => {
  it('没有激活包时新建空白包自动成为当前包', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue(defaultProfile)
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)

    const created = await manager.createBlankPack({ name: 'Fresh Pack', dshVersion: null })
    expect(created.enabled).toBe(true)
    expect(store.current.activePackId).toBe(created.id)
    expect(store.current.profileName).toBe(created.id)
  })

  it('已有激活包时新建空白包不抢当前', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue(defaultProfile)
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x'))
    store.current.activePackId = 'pack-x'

    const created = await manager.createBlankPack({ name: 'Fresh Pack', dshVersion: null })
    expect(created.enabled).toBe(false)
    expect(store.current.activePackId).toBe('pack-x')
  })
})

// ---------------------------------------------------------------------------
// activate / deactivate
// ---------------------------------------------------------------------------

describe('activatePack（真隔离指针）', () => {
  it('激活同步写 activePackId 与 profileName，并补齐缺失的包骨架', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x'))

    const activated = await manager.activatePack('pack-x')
    expect(activated.profileName).toBe('pack-x')
    expect(activated.activePackId).toBe('pack-x')
    expect(store.current.profileName).toBe('pack-x')
    expect(store.current.activePackId).toBe('pack-x')
    // 骨架：profiles/pack-x/package.json 已落盘。
    expect(existsSync(path.join(env.dshHome, 'profiles', 'pack-x', 'package.json'))).toBe(true)
  })

  it('activatePack 对不存在的包抛错', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)
    await expect(manager.activatePack('pack-ghost')).rejects.toThrow('整合包不存在')
  })

  it('激活带 dshVersion 的包时先确保版本已装并切换可执行文件', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const emitEvent = vi.fn()
    const ensureDshVersionInstalled = vi.fn(async () => {})
    const selectDshVersion = vi.fn(async () => {})
    const manager = createPackManager({
      readSettings: store.readSettings,
      saveSettings: store.saveSettings,
      registryPath: env.registryPath,
      snapshotRoot: env.snapshotRoot,
      pluginReceiptsPath: env.pluginReceiptsPath,
      presetReceiptsPath: env.presetReceiptsPath,
      skillReceiptsPath: env.skillReceiptsPath,
      applicationAddons: { list: vi.fn(async () => []), install: vi.fn(async () => {}), uninstall: vi.fn(async () => []) },
      installer: stub,
      emitEvent,
      isRuntimeRunning: () => false,
      isInstallerBusy: () => false,
      dshHome: env.dshHome,
      ensureDshVersionInstalled,
      selectDshVersion,
    })
    await upsertPackRecord(env.registryPath, { ...recordFor('pack-v'), dshVersion: '9.9.9' })
    await manager.activatePack('pack-v')
    expect(ensureDshVersionInstalled).toHaveBeenCalledWith('9.9.9')
    expect(selectDshVersion).toHaveBeenCalledWith('9.9.9')
  })
})

// ---------------------------------------------------------------------------
// removePack
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// exportPack
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// togglePackItem / removePackItem
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// listPacks
// ---------------------------------------------------------------------------

