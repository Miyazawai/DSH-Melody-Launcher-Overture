/**
 * 「整合包 = 真隔离环境」一次性迁移。
 *
 *   1) 默认家目录收编为默认整合包 `web`（homePath 缺省 = 共用默认家目录）；
 *   2) 默认家目录里其它已存在的 Profile 注册为共用家目录的包（旧导入包）；
 *   3) 保证 activePackId 指向一个存在的包（与 profileName 同步）。
 *
 * 迁移只跑一次（packsV2Migrated）：之后注册表为空 = 用户删光了所有包的零包引导态，
 * 迁移不得重建任何包。整合包只由「新建 / 导入」产生，下载 DSH 版本不再自动建包。
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings } from '../src/types'
import { isSafeProfileName } from './profile'
import { readProfileMetadata } from './profile-service'
import { readPackRegistry, upsertPackRecord } from './pack-registry'

export interface PackHomeMigrationDeps {
  registryPath: string
  readStoredSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  isRuntimeRunning: () => boolean
}

const DEFAULT_PACK_ID = 'web'

export async function migrateToPackHomesV2(deps: PackHomeMigrationDeps): Promise<void> {
  if (deps.isRuntimeRunning()) return // 运行中不动激活指针，下次启动再补
  const settings = await deps.readStoredSettings()
  const now = new Date().toISOString()
  const records = await readPackRegistry(deps.registryPath)
  // 已迁移就不再跑：注册表为空 = 用户删光了所有包（零包引导态），绝不能重建复活。
  if (settings.packsV2Migrated) return

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
