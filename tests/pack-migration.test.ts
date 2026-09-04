/**
 * packsV2 一次性迁移：默认包收编、存量 Profile 注册、已装版本补发自动包、激活指针兜底。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '../src/types'
import { migrateToPackHomesV2 } from '../electron/pack-migration'
import { readPackRegistry, upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-mig-'))
  temporaryRoots.push(root)
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })
  await mkdir(path.join(dshHome, 'profiles', 'pack-legacy-import'), { recursive: true })
  await writeFile(path.join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } }))
  await writeFile(path.join(dshHome, 'profiles', 'pack-legacy-import', 'package.json'), JSON.stringify({ name: 'dsh-profile-legacy', dependencies: {}, dsh: { profile: { bundles: [] } } }))
  let stored: AppSettings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome,
    dshVersion: '0.1.2-rc.1',
    profileName: 'web',
    activePackId: null,
  }
  const registryPath = path.join(root, 'packs.json')
  const packsRoot = path.join(root, 'dsh-packs')
  const deps = {
    registryPath,
    packsRoot,
    readStoredSettings: async () => stored,
    saveSettings: async (next: AppSettings) => { stored = next; return next },
    listManagedDshVersions: async () => [{ version: '0.1.2-rc.1' }, { version: '0.1.0-rc.7' }],
    ensurePackForVersion: async (version: string): Promise<void> => {
      const id = `pack-${version}`
      const records = await readPackRegistry(registryPath)
      if (records.some(record => record.id === id)) return
      const homePath = path.join(packsRoot, id)
      await mkdir(homePath, { recursive: true })
      const now = new Date().toISOString()
      const record: PackRecord = { id, name: version, description: '', version: '1.0.0', dshVersion: version, homePath, auto: true, source: 'created', installedAt: now, updatedAt: now, state: 'complete', plugins: [] }
      await upsertPackRecord(registryPath, record)
    },
    isRuntimeRunning: () => false,
  }
  return { root, dshHome, packsRoot, registryPath, deps, get stored() { return stored } }
}

describe('migrateToPackHomesV2', () => {
  it('收编默认包与存量 Profile，补发版本自动包，指针落到 web', async () => {
    const env = await fixture()
    await migrateToPackHomesV2(env.deps)
    const records = await readPackRegistry(env.registryPath)
    const ids = records.map(record => record.id).sort()
    expect(ids).toEqual(['0.1.0-rc.7'.replace('0.1.0-rc.7', 'pack-0.1.0-rc.7'), 'pack-0.1.2-rc.1', 'pack-legacy-import', 'web'].sort())
    const web = records.find(record => record.id === 'web')!
    expect(web.homePath).toBeUndefined() // 默认包共用可改的默认家目录
    const legacy = records.find(record => record.id === 'pack-legacy-import')!
    expect(legacy.homePath).toBeUndefined()
    const auto = records.find(record => record.id === 'pack-0.1.2-rc.1')!
    expect(auto.auto).toBe(true)
    expect(auto.homePath).toBe(path.join(env.packsRoot, 'pack-0.1.2-rc.1'))
    expect(env.stored.activePackId).toBe('web')
    expect(env.stored.profileName).toBe('web')
    expect(env.stored.packsV2Migrated).toBe(true)
  })

  it('注册表丢失但已迁移标记在位：自愈重建', async () => {
    const env = await fixture()
    await migrateToPackHomesV2(env.deps)
    const { rm } = await import('node:fs/promises')
    await rm(env.registryPath, { force: true })
    await migrateToPackHomesV2(env.deps)
    const records = await readPackRegistry(env.registryPath)
    expect(records.map(r => r.id).sort()).toContain('web')
    expect(env.stored.packsV2Migrated).toBe(true)
  })

  it('幂等：已迁移后不再动指针；重复执行不重复注册', async () => {
    const env = await fixture()
    await migrateToPackHomesV2(env.deps)
    const first = await readPackRegistry(env.registryPath)
    await migrateToPackHomesV2(env.deps)
    const second = await readPackRegistry(env.registryPath)
    expect(second.map(r => r.id)).toEqual(first.map(r => r.id))
  })

  it('运行中跳过迁移（下次启动再补）', async () => {
    const env = await fixture()
    await migrateToPackHomesV2({ ...env.deps, isRuntimeRunning: () => true })
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    expect(env.stored.packsV2Migrated).toBeFalsy()
  })

  it('激活指针指向不存在的包时回落到 web', async () => {
    const env = await fixture()
    await migrateToPackHomesV2({
      ...env.deps,
      readStoredSettings: async () => ({ ...env.stored, activePackId: 'pack-ghost', profileName: 'pack-ghost' }),
    })
    expect(env.stored.activePackId).toBe('web')
  })
})
