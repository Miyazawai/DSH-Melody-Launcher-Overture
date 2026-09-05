/**
 * 「整合包 = 真隔离环境」迁移与启动同步。
 *
 * 一次性迁移（存量数据零搬迁）：
 *   1) 默认家目录收编为默认整合包 `web`（homePath 缺省 = 共用默认家目录）；
 *   2) 默认家目录里其它已存在的 Profile 注册为共用家目录的包（旧导入包）；
 *   3) 保证 activePackId 永远指向一个存在的包（与 profileName 同步）。
 *
 * 每次启动同步（syncAutoPacksForVersions）：已安装的 DSH 版本若没有对应自动包就补发；
 * 用户删过的（deletedAutoPacks 墓碑）不再复活。
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings } from '../src/types'
import { packProfileName } from './pack-manifest'
import { isSafeProfileName } from './profile'
import { readProfileMetadata } from './profile-service'
import { readPackRegistry, upsertPackRecord } from './pack-registry'

export interface PackHomeMigrationDeps {
  registryPath: string
  packsRoot: string
  readStoredSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  listManagedDshVersions: (runtimeRoot: string) => Promise<Array<{ version: string }>>
  ensurePackForVersion: (version: string) => Promise<unknown>
  isRuntimeRunning: () => boolean
}

const DEFAULT_PACK_ID = 'web'

export async function migrateToPackHomesV2(deps: PackHomeMigrationDeps): Promise<void> {
  if (deps.isRuntimeRunning()) return // 运行中不动激活指针，下次启动再补
  const settings = await deps.readStoredSettings()
  const now = new Date().toISOString()
  const records = await readPackRegistry(deps.registryPath)
  // 已迁移且注册表仍在：不重复注册（尊重用户删包）。注册表丢失则自愈重建。
  if (settings.packsV2Migrated && records.length > 0) return

  // 1) 默认包：homePath 缺省（永远跟随用户可改的默认家目录）。
  if (!records.some(record => record.id === DEFAULT_PACK_ID)) {
    await upsertPackRecord(deps.registryPath, {
      id: DEFAULT_PACK_ID,
      name: DEFAULT_PACK_ID,
      description: '',
      version: '1.0.0',
      ...(settings.dshVersion ? { dshVersion: settings.dshVersion } : {}),
      source: 'created',
      installedAt: now,
      updatedAt: now,
      state: 'complete',
      plugins: [],
    })
  }

  // 2) 存量共享 Profile → 包（不设 homePath = 共用默认家目录）。
  const profileRoot = path.join(settings.dshHome, 'profiles')
  const entries = await readdir(profileRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeProfileName(entry.name)) continue
    if (entry.name === DEFAULT_PACK_ID || entry.name === 'node_modules') continue
    const existing = await readPackRegistry(deps.registryPath)
    if (existing.some(record => record.id === entry.name)) continue
    const metadata = await readProfileMetadata(settings.dshHome, entry.name).catch(() => null)
    await upsertPackRecord(deps.registryPath, {
      id: entry.name,
      name: metadata?.name || entry.name,
      description: metadata?.description ?? '',
      version: '1.0.0',
      ...(metadata?.dshVersion ? { dshVersion: metadata.dshVersion } : {}),
      source: 'created',
      installedAt: metadata?.createdAt ?? now,
      updatedAt: now,
      state: 'complete',
      plugins: [],
    })
  }

  // 3) 激活指针兜底：指向当前 profileName 对应的包；不存在则回默认包。
  const finalRecords = await readPackRegistry(deps.registryPath)
  const wanted = settings.activePackId ?? settings.profileName
  const activeId = finalRecords.some(record => record.id === wanted) ? wanted : DEFAULT_PACK_ID
  await deps.saveSettings({ ...settings, activePackId: activeId, profileName: activeId, packsV2Migrated: true })
}

/**
 * 启动同步：每个已安装的托管 DSH 版本都应有对应的自动整合包；缺失则补发。
 * 用户删过的自动包（deletedAutoPacks 墓碑）不再复活。幂等、开销极小，每次启动都跑。
 */
export async function syncAutoPacksForVersions(deps: PackHomeMigrationDeps): Promise<void> {
  const settings = await deps.readStoredSettings()
  const versions = await deps.listManagedDshVersions(settings.dshInstallPath).catch(() => [])
  if (versions.length === 0) return
  const records = await readPackRegistry(deps.registryPath)
  const known = new Set(records.map(record => record.id))
  const tombstones = new Set(settings.deletedAutoPacks ?? [])
  for (const item of versions) {
    let id: string
    try {
      id = packProfileName(item.version)
    } catch {
      continue
    }
    if (known.has(id) || tombstones.has(id)) continue
    await deps.ensurePackForVersion(item.version).catch(() => undefined)
    known.add(id)
  }
}
