/**
 * packsV2 一次性迁移：默认包收编、存量 Profile 注册、激活指针兜底。
 * 整合包只由「新建 / 导入」产生；下载 DSH 版本不再自动建包，也没有启动补发同步。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '../src/types'
import { migrateToPackHomesV2 } from '../electron/pack-migration'
import { readPackRegistry } from '../electron/pack-registry'
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
  const deps = {
    registryPath,
    readStoredSettings: async () => stored,
    saveSettings: async (next: AppSettings) => { stored = next; return next },
    isRuntimeRunning: () => false,
  }
  return { root, dshHome, registryPath, deps, get stored() { return stored } }
}

describe('migrateToPackHomesV2', () => {
  it('收编默认包与存量 Profile，指针落到 web', async () => {
    const env = await fixture()
    await migrateToPackHomesV2(env.deps)
    const records = await readPackRegistry(env.registryPath)
    const ids = records.map(record => record.id).sort()
    expect(ids).toEqual(['pack-legacy-import', 'web'])
    const web = records.find(record => record.id === 'web')!
    expect(web.homePath).toBeUndefined() // 默认包共用可改的默认家目录
    const legacy = records.find(record => record.id === 'pack-legacy-import')!
    expect(legacy.homePath).toBeUndefined()
    expect(env.stored.activePackId).toBe('web')
    expect(env.stored.profileName).toBe('web')
    expect(env.stored.packsV2Migrated).toBe(true)
  })

  it('零包引导态：已迁移且注册表为空时不重建任何包', async () => {
    const env = await fixture()
    await migrateToPackHomesV2(env.deps)
    // 模拟用户删光了所有包：注册表清空、指针置空。
    await writeFile(env.registryPath, '[]', 'utf8')
    await env.deps.saveSettings({ ...env.stored, activePackId: null })
    await migrateToPackHomesV2(env.deps)
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    expect(env.stored.activePackId).toBeNull()
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
