import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PluginInstallSource } from '../src/types'

/**
 * 插件安装 receipt：归属字段为 packId —— 插件属于「整合包」，而不是某个激活 Profile。
 * 磁盘上的旧记录（v1，字段名 profileName）在读取时归一化为 packId（unified 模式下
 * profile 目录名 === packId，旧值可安全沿用）。
 */
export interface PluginInstallReceipt {
  repository: string
  packageName: string
  /** 所属整合包 id（内部即 profile 目录名）。 */
  packId: string
  source: PluginInstallSource
  subdirectory: string | null
  version: string | null
  commit: string
  defaultBranch?: string
  targetId?: string
  installedAt: string
}

interface ReceiptFile {
  version: 1
  installs: PluginInstallReceipt[]
}

interface LegacyPluginInstallReceipt extends Omit<PluginInstallReceipt, 'packId'> {
  profileName: string
  packId?: never
}

/** 兼容旧磁盘记录：v1 的 profileName 字段按 packId 读取。 */
function normalizeReceipt(item: PluginInstallReceipt | LegacyPluginInstallReceipt): PluginInstallReceipt {
  if ('packId' in item && item.packId) return item as PluginInstallReceipt
  const legacy = item as unknown as LegacyPluginInstallReceipt
  return { ...legacy, packId: legacy.profileName }
}

async function readReceiptFile(filePath: string): Promise<ReceiptFile> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<ReceiptFile>
    return {
      version: 1,
      installs: Array.isArray(value.installs)
        ? value.installs.map(item => normalizeReceipt(item))
        : [],
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, installs: [] }
  }
}

async function writeReceiptFile(filePath: string, value: ReceiptFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, filePath)
  } catch {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export async function readPluginReceipts(filePath: string): Promise<PluginInstallReceipt[]> {
  return (await readReceiptFile(filePath)).installs
}

export async function recordPluginInstall(filePath: string, receipt: PluginInstallReceipt): Promise<void> {
  const current = await readReceiptFile(filePath)
  const installs = current.installs.filter(item => !(
    item.packId === receipt.packId && item.packageName === receipt.packageName
  ))
  installs.push(receipt)
  await writeReceiptFile(filePath, { version: 1, installs })
}

export async function removePluginReceipt(filePath: string, packId: string, packageName: string): Promise<void> {
  const current = await readReceiptFile(filePath)
  const installs = current.installs.filter(item => !(
    item.packId === packId && item.packageName === packageName
  ))
  if (installs.length === current.installs.length) return
  await writeReceiptFile(filePath, { version: 1, installs })
}
