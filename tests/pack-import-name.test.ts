import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/types'
import { createPackManager } from '../electron/pack'
import { planSnapshot, writeSnapshotZip } from '../electron/pack-snapshot'
import { readPackRegistry } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

/**
 * 同快照重复导入的显示名：中文显示名 + zip 内 profileId 冲突时也必须得到「原名 (2)」。
 *
 * 这是官方默认整合包的真实情形——显示名是中文（「官方默认整合包 x.y.z」），
 * 而包内 profileId 是英文（pack-test）。早先的实现拿中文显示名反推 id 前缀，
 * 算不出后缀，列表里会出现两个同名包。
 */

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-import-name-'))
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
  }
}

function makeManager(env: Awaited<ReturnType<typeof makeEnv>>, store: ReturnType<typeof makeStore>) {
  const installer = {
    readProfile: vi.fn(async () => ({ initialized: true, profileDir: '', manifestPath: '', plugins: [], activeBundles: [], dependencyCount: 0, disabledCount: 0 })),
    installPluginTarget: vi.fn(async () => {}), installNpmPackage: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    togglePlugin: vi.fn(async () => ({})), reorderPlugins: vi.fn(async () => []),
    installSkill: vi.fn(async () => ({})), installSkillPinned: vi.fn(async () => ({})), installPreset: vi.fn(async () => ({})),
    installPresetLocal: vi.fn(async () => {}), installSkillLocal: vi.fn(async () => {}),
    toggleSkill: vi.fn(async () => []), togglePreset: vi.fn(async () => []),
  }
  return createPackManager({
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
}

/** 造一个最小快照 zip：家目录镜像，profileId 固定为英文 pack-test。 */
async function buildSnapshotZip(root: string): Promise<string> {
  const home = path.join(root, 'source-home')
  const profileDir = path.join(home, 'profiles', 'pack-test')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(home, 'settings.yaml'), 'pet:\n  petId: whale-girl\n', 'utf8')
  await writeFile(path.join(profileDir, 'profile.yaml'), [
    'name: pack-test',
    'description: ""',
    'dshVersion: 0.1.5-rc.2',
    'source:',
    '  kind: local',
    'createdAt: 2026-09-15T00:00:00.000Z',
    'updatedAt: 2026-09-15T00:00:00.000Z',
    'exportedAt: null',
    '',
  ].join('\n'), 'utf8')
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-pack-test', private: true }, null, 2), 'utf8')

  const zipPath = path.join(root, 'official-pack-v0.1.5-rc.2.1.zip')
  const plan = await planSnapshot(home, { packId: 'pack-test' })
  await writeSnapshotZip(plan, zipPath)
  return zipPath
}

describe('快照导入的显示名', () => {
  it('中文显示名 + 包内英文 profileId：重复导入得到「原名 (2)」', async () => {
    const env = await makeEnv()
    const store = makeStore(env.dshHome)
    const manager = makeManager(env, store)
    const zipPath = await buildSnapshotZip(env.root)
    const displayName = '官方默认整合包 0.1.5-rc.2.1'

    const first = await manager.importPack(zipPath, undefined, { name: displayName })
    expect(first.id).toBe('pack-test')

    const second = await manager.importPack(zipPath, undefined, { name: displayName })
    expect(second.id).toBe('pack-test-2')

    const records = await readPackRegistry(env.registryPath)
    const names = records.map(record => record.name).sort()
    expect(names).toEqual([displayName, `${displayName} (2)`].sort())

    // 第二次导入落进自己的家目录，两份环境互不覆盖。
    const secondProfiles = await readdir(path.join(env.packsRoot, 'pack-test-2', 'profiles'))
    expect(secondProfiles).toHaveLength(1)
    await expect(readFile(path.join(env.packsRoot, 'pack-test-2', 'profiles', secondProfiles[0]!, 'profile.yaml'), 'utf8'))
      .resolves.toContain('0.1.5-rc.2')
  })
})
