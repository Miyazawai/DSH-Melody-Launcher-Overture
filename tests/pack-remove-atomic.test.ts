import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/types'
import { createPackManager } from '../electron/pack'
import { readPackRegistry, upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

/**
 * removePack 的原子删除守卫：目录被占用（rename 失败）时必须整体失败、
 * 原目录分毫未动、注册表记录保留——杜绝「记录在、内容半删」的毁包状态。
 * rename 用可控 mock 模拟 Windows 上「目录内有打开句柄」的 EPERM。
 */

const h = vi.hoisted(() => ({ failNextRename: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string | URL, to: string | URL) => {
      if (h.failNextRename) {
        h.failNextRename = false
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      return actual.rename(from, to)
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-remove-'))
  roots.push(root)
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles'), { recursive: true })
  return {
    root,
    dshHome,
    packsRoot: path.join(root, 'dsh-packs'),
    registryPath: path.join(root, 'packs.json'),
    pluginReceiptsPath: path.join(root, 'plugin-installs.json'),
    presetReceiptsPath: path.join(root, 'preset-installs.json'),
    skillReceiptsPath: path.join(root, 'skill-installs.json'),
    snapshotRoot: path.join(root, 'pack-snapshots'),
  }
}

function makeManager(env: Awaited<ReturnType<typeof makeEnv>>, store: { readSettings: () => Promise<AppSettings>; saveSettings: (next: AppSettings) => Promise<AppSettings> }) {
  const installer = {
    readProfile: vi.fn(async () => ({ initialized: true, profileDir: '', manifestPath: '', plugins: [], activeBundles: [], dependencyCount: 0, disabledCount: 0 })),
    installPluginTarget: vi.fn(async () => {}), installNpmPackage: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    togglePlugin: vi.fn(async () => ({})), reorderPlugins: vi.fn(async () => []),
    installSkill: vi.fn(async () => ({})), installSkillPinned: vi.fn(async () => ({})), installPreset: vi.fn(async () => ({})),
    installPresetLocal: vi.fn(async () => {}), installSkillLocal: vi.fn(async () => {}),
    toggleSkill: vi.fn(async () => []), togglePreset: vi.fn(async () => []),
  }
  const manager = createPackManager({
    readSettings: store.readSettings,
    saveSettings: store.saveSettings,
    registryPath: env.registryPath,
    snapshotRoot: env.snapshotRoot,
    pluginReceiptsPath: env.pluginReceiptsPath,
    presetReceiptsPath: env.presetReceiptsPath,
    skillReceiptsPath: env.skillReceiptsPath,
    applicationAddons: { list: async () => [], install: async () => ({}), uninstall: async () => [] },
    installer: installer as never,
    emitEvent: () => {},
    emitOutput: () => {},
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    unifiedProfiles: true,
    packsRoot: env.packsRoot,
    readStoredSettings: store.readSettings,
  })
  return manager
}

function makeStore(dshHome: string) {
  let current: AppSettings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome,
    profileName: 'pack-x',
    activePackId: 'pack-x',
  }
  return {
    readSettings: async () => current,
    saveSettings: async (next: AppSettings) => { current = next; return current },
    get current() { return current },
  }
}

async function privateHomeRecord(env: Awaited<ReturnType<typeof makeEnv>>): Promise<PackRecord> {
  const homePath = path.join(env.packsRoot, 'pack-x')
  await mkdir(path.join(homePath, 'skills', 'officecli'), { recursive: true })
  await writeFile(path.join(homePath, 'skills', 'officecli', 'SKILL.md'), '# s')
  await writeFile(path.join(homePath, 'settings.yaml'), 'pet:\n  visible: true\n')
  return {
    id: 'pack-x', name: 'pack-x', description: '', version: '1.0.0',
    homePath, source: 'created',
    installedAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    state: 'complete', plugins: [],
  }
}

describe('removePack 原子删除', () => {
  it('目录被占用（rename 失败）时整体失败：原目录与记录分毫未动', async () => {
    const env = await makeEnv()
    const store = makeStore(env.dshHome)
    const manager = makeManager(env, store)
    await upsertPackRecord(env.registryPath, await privateHomeRecord(env))

    h.failNextRename = true
    await expect(manager.removePack('pack-x')).rejects.toThrow('无法删除')

    // 关键断言：目录还在、内容完整、记录还在 —— 不再有半删毁包。
    expect(existsSync(path.join(env.packsRoot, 'pack-x', 'settings.yaml'))).toBe(true)
    expect(existsSync(path.join(env.packsRoot, 'pack-x', 'skills', 'officecli', 'SKILL.md'))).toBe(true)
    expect(await readPackRegistry(env.registryPath)).toHaveLength(1)
  })

  it('正常删除：私有家目录整体消失、不留回收站残骸、记录清除', async () => {
    const env = await makeEnv()
    const store = makeStore(env.dshHome)
    const manager = makeManager(env, store)
    await upsertPackRecord(env.registryPath, await privateHomeRecord(env))

    await manager.removePack('pack-x')

    expect(existsSync(path.join(env.packsRoot, 'pack-x'))).toBe(false)
    const leftovers = (await readdir(env.packsRoot).catch(() => [])).filter(name => name.includes('.deleting-'))
    expect(leftovers).toEqual([])
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    // 删的是激活包：指针落到零包引导态。
    expect(store.current.activePackId).toBeNull()
  })
})
