import path from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { LAUNCHER_RELEASE_REPOSITORY, OFFICIAL_PACK_VERSION } from '../src/constants'
import { githubCandidateUrls } from './github-archive'
import { downloadReleaseAsset } from './release-download'
import { readPackRegistry, upsertPackRecord } from './pack-registry'
import type { PackImportOptions, PackInstallResult } from '../src/types'

/**
 * 官方默认整合包：zip 作为 LAUNCHER_REPOSITORY 的 GitHub Release 资产发布
 * （`official-pack-v<版本>.zip`，由 OFFICIAL_PACK_VERSION 钉住）。
 *
 * 启动器首启（以及启动器更新带来新官方包版本后）核对注册表：没有同版本的
 * 官方包就自动下载导入；用户删掉官方包后可在整合包页一键「恢复」。
 * 官方包可删、可改名、可导出——「官方」只是来源与恢复锚点，不是枷锁。
 */

const GITHUB_API_ROOT = 'https://api.github.com'
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}
/** 官方包快照 zip 上限（含依赖本体，数百 MB 量级）。 */
export const OFFICIAL_PACK_MAX_BYTES = 2 * 1024 * 1024 * 1024

export function officialPackAssetName(version: string = OFFICIAL_PACK_VERSION): string {
  return `official-pack-v${version}.zip`
}

export function officialPackDisplayName(version: string = OFFICIAL_PACK_VERSION): string {
  return `官方默认整合包 ${version}`
}

export type OfficialPackOutcome = 'present' | 'imported' | 'no-asset' | 'failed'

export interface OfficialPackDeps {
  /** packs.json 路径（盖官方版本戳用）。 */
  registryPath: string
  /** 复用整合包导入管线（快照 zip → 隔离家目录 → 注册 → 激活）。 */
  importPack: (filePath: string, items: undefined, options: PackImportOptions) => Promise<PackInstallResult>
  fetchImpl: typeof fetch
  mirror?: string
  /** zip 的临时落盘目录（导入完成后删除）。 */
  downloadDir: string
  onProgress?: (received: number, totalBytes: number | null) => void
}

export interface OfficialPackResult {
  outcome: OfficialPackOutcome
  result?: PackInstallResult
  message?: string
}

interface ReleaseAssetRef {
  url: string
  size: number
}

/** 解析最新 Release 里的官方包资产；Release 可达但没有该资产时返回 null（不再换源重试）。 */
async function resolveOfficialPackAsset(
  deps: OfficialPackDeps,
): Promise<{ asset: ReleaseAssetRef | null; message?: string }> {
  const endpoint = `${GITHUB_API_ROOT}/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases/latest`
  const assetName = officialPackAssetName()
  for (const url of githubCandidateUrls(endpoint, deps.mirror)) {
    try {
      const response = await deps.fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12_000) })
      if (!response.ok) continue
      const release = await response.json() as {
        assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>
      }
      const assets = Array.isArray(release.assets) ? release.assets : []
      const found = assets.find(entry => entry?.name === assetName && typeof entry.browser_download_url === 'string')
      if (!found) return { asset: null, message: `最新 Release 中没有 ${assetName}。` }
      return { asset: { url: String(found.browser_download_url), size: Number(found.size) || 0 } }
    } catch {
      // 这个候选不可达，换下一个。
    }
  }
  return { asset: null, message: '无法访问 GitHub Release（网络或限流）。' }
}

/**
 * 确保当前版本的官方整合包存在；缺失时下载导入并盖版本戳。
 * 永不 throw——失败以 outcome/message 返回，由调用方决定提示方式。
 */
export async function ensureOfficialPack(deps: OfficialPackDeps): Promise<OfficialPackResult> {
  try {
    const records = await readPackRegistry(deps.registryPath)
    if (records.some(record => record.officialVersion === OFFICIAL_PACK_VERSION)) {
      return { outcome: 'present' }
    }

    const resolved = await resolveOfficialPackAsset(deps)
    if (!resolved.asset) {
      return { outcome: resolved.message?.includes('没有') ? 'no-asset' : 'failed', message: resolved.message }
    }

    let buffer: Buffer | null = null
    for (const url of githubCandidateUrls(resolved.asset.url, deps.mirror)) {
      try {
        buffer = await downloadReleaseAsset(url, OFFICIAL_PACK_MAX_BYTES, deps.onProgress, deps.fetchImpl)
        break
      } catch {
        // 换下一个候选源。
      }
    }
    if (!buffer) return { outcome: 'failed', message: '官方整合包下载失败。' }

    await mkdir(deps.downloadDir, { recursive: true })
    const zipPath = path.join(deps.downloadDir, officialPackAssetName())
    await writeFile(zipPath, buffer)
    try {
      const result = await deps.importPack(zipPath, undefined, { name: officialPackDisplayName() })
      const latest = await readPackRegistry(deps.registryPath)
      const record = latest.find(item => item.id === result.id)
      if (record) {
        await upsertPackRecord(deps.registryPath, { ...record, officialVersion: OFFICIAL_PACK_VERSION })
      }
      return { outcome: 'imported', result }
    } catch (error) {
      return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(zipPath, { force: true }).catch(() => undefined)
    }
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
