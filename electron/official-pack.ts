import path from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { LAUNCHER_RELEASE_REPOSITORY, OFFICIAL_PACK_VERSION } from '../src/constants'
import { githubCandidateUrls } from './github-archive'
import { downloadOfficialPackAsset, type OfficialPackDownloadProgress } from './official-pack-download'
import { readPackRegistry, upsertPackRecord } from './pack-registry'
import { compareVersions, validVersion } from './dsh-release'
import { applyStockAppearance } from './stock-appearance'
import type { OfficialPackRelease, PackImportOptions, PackInstallResult } from '../src/types'

/**
 * 官方默认整合包：zip 作为 LAUNCHER_RELEASE_REPOSITORY 的 GitHub Release 资产发布，
 * 资产名 `official-pack-v<版本>.zip`，版本号 = 适配的 DSH 版本 + 序号（如 0.1.5-rc.2.1），
 * 所以用户看版本号就知道这个包适配哪个 DSH。
 *
 * 一次可以挂多个版本（不同 Release 上各有一份资产），整合包页把它们列成一个「官方整合包」堆叠，
 * 最新版即推荐版本。首次获取（本机一个官方包都没有）仍自动导入推荐版本；发现**更新**版本只提醒，
 * 由用户在堆叠里点下载——不静默拉几百 MB。
 */

const GITHUB_API_ROOT = 'https://api.github.com'
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}
/** 列 Release 时的单页条数（GitHub 上限 100）。 */
const RELEASE_LOOKUP_LIMIT = 100
/** 官方包快照 zip 上限（含依赖本体，数百 MB 量级）。 */
export const OFFICIAL_PACK_MAX_BYTES = 2 * 1024 * 1024 * 1024

const OFFICIAL_PACK_ASSET_RE = /^official-pack-v(.+)\.zip$/
/** 构建脚本写进 Release 正文的三行元信息，用于回显「这个包是用什么建的」。 */
const RELEASE_BODY_DSH_RE = /(?:^|\n)\s*dsh\s*[:：]\s*(\S+)/i

export function officialPackAssetName(version: string = OFFICIAL_PACK_VERSION): string {
  return `official-pack-v${version}.zip`
}

export function officialPackDisplayName(version: string = OFFICIAL_PACK_VERSION): string {
  return `官方默认整合包 ${version}`
}

/**
 * 从官方包版本号里取回「适配的 DSH 版本」：`0.1.5-rc.2.1` → `0.1.5-rc.2`。
 * 只有「去掉尾段序号后仍是一个合法版本号」才认——那说明资产名按新命名方案编码了 DSH 版本。
 * 旧命名（如 `official-pack-v0.1.1.zip`，包版本 = 启动器版本，与 DSH 无关）解不出来，返回 null：
 * 界面显示「适配 DSH 未标注」也比拿包版本号冒充强（那是错的）。
 */
export function dshVersionOfOfficialPack(version: string): string | null {
  const trimmed = version.trim()
  const cut = trimmed.lastIndexOf('.')
  if (cut <= 0) return null
  const stripped = trimmed.slice(0, cut)
  return validVersion(stripped) ? stripped : null
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
  /** 下载进度（含字节数、总量、速度来源），界面据此画进度条。 */
  onProgress?: (progress: OfficialPackDownloadProgress) => void
}

export interface OfficialPackResult {
  outcome: OfficialPackOutcome
  result?: PackInstallResult
  message?: string
  /** 实际拿下这份包的源（镜像域名 / GitHub 直连），成功时用于日志与界面回显。 */
  source?: string
}

interface ReleaseAssetRef {
  url: string
  size: number
}

interface RawRelease {
  tag_name?: unknown
  body?: unknown
  published_at?: unknown
  draft?: unknown
  assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>
}

/** 从 Release 正文里读构建时记录的 DSH 版本（新方案的包都会写这行）。 */
function dshVersionFromNotes(notes: string | null): string | null {
  if (!notes) return null
  const match = RELEASE_BODY_DSH_RE.exec(notes)
  const value = match?.[1]?.trim()
  return value && validVersion(value) ? value : null
}

/** 只需要网络能力的窄依赖：列版本不需要导入管线。 */
export type OfficialPackListDeps = Pick<OfficialPackDeps, 'fetchImpl' | 'mirror'>

/**
 * 列出所有 Release 上的官方包资产，按版本降序（第一项即推荐版本）。
 * 网络/限流失败时抛错，由调用方决定怎么提示。
 */
export async function listOfficialPackVersions(deps: OfficialPackListDeps): Promise<OfficialPackRelease[]> {
  const endpoint = `${GITHUB_API_ROOT}/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases?per_page=${RELEASE_LOOKUP_LIMIT}`
  let releases: RawRelease[] | null = null
  let lastError = '无法访问 GitHub Release（网络或限流）。'
  for (const url of githubCandidateUrls(endpoint, deps.mirror)) {
    try {
      const response = await deps.fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12_000) })
      if (response.status === 403) {
        lastError = 'GitHub 请求额度暂时用尽，稍后再试。'
        continue
      }
      if (!response.ok) {
        lastError = `GitHub 返回 ${response.status}。`
        continue
      }
      const payload = await response.json() as unknown
      if (!Array.isArray(payload)) {
        lastError = 'GitHub 返回了非预期的数据。'
        continue
      }
      releases = payload as RawRelease[]
      break
    } catch {
      // 这个候选不可达，换下一个。
    }
  }
  if (!releases) throw new Error(lastError)

  const found: OfficialPackRelease[] = []
  const seen = new Set<string>()
  for (const release of releases) {
    if (!release || release.draft === true) continue
    const releaseTag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const notes = typeof release.body === 'string' ? release.body : null
    const publishedAt = typeof release.published_at === 'string' ? release.published_at : null
    for (const asset of Array.isArray(release.assets) ? release.assets : []) {
      const assetName = typeof asset?.name === 'string' ? asset.name : ''
      const match = OFFICIAL_PACK_ASSET_RE.exec(assetName)
      const version = match?.[1]?.trim()
      if (!version || typeof asset.browser_download_url !== 'string' || seen.has(version)) continue
      seen.add(version)
      found.push({
        version,
        // 正文的构建元信息 > 资产名里的编码；两者都没有就是真的不知道（旧命名的历史资产），
        // 留给渲染层用本机已装包的真实绑定版本补，仍补不上就显示「未标注」。
        dshVersion: dshVersionFromNotes(notes) ?? dshVersionOfOfficialPack(version),
        assetName,
        assetUrl: asset.browser_download_url,
        size: Number(asset.size) || 0,
        releaseTag,
        publishedAt,
        notes,
      })
    }
  }
  return found.sort((left, right) => compareVersions(left.version, right.version))
}

/** 列表读取失败时返回 null（给「确保存在」这类不该抛的路径用）。 */
async function tryListOfficialPackVersions(deps: OfficialPackListDeps): Promise<OfficialPackRelease[] | null> {
  try {
    return await listOfficialPackVersions(deps)
  } catch {
    return null
  }
}

/**
 * 老路径兜底：直接查 `releases/latest` 里的同名资产。
 * 只在 Release 列表读不到（网络黑洞/限流）时使用，保证「最新版」仍然装得上。
 */
async function resolveOfficialPackAssetFromLatest(
  deps: OfficialPackDeps,
  version: string,
): Promise<{ asset: ReleaseAssetRef | null; message?: string }> {
  const endpoint = `${GITHUB_API_ROOT}/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases/latest`
  const assetName = officialPackAssetName(version)
  for (const url of githubCandidateUrls(endpoint, deps.mirror)) {
    try {
      const response = await deps.fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12_000) })
      if (!response.ok) continue
      const release = await response.json() as { assets?: RawRelease['assets'] }
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

/** 下载 → 导入 → 盖官方版本戳 → 把外观钉回原生。 */
async function downloadAndImport(
  deps: OfficialPackDeps,
  version: string,
  asset: ReleaseAssetRef,
): Promise<OfficialPackResult> {
  let buffer: Buffer
  let source: string
  try {
    // 百 MB 级下载走换源下载器：直连慢/卡住会自己切到镜像，全程上报字节数与当前来源。
    const download = await downloadOfficialPackAsset(asset.url, {
      fetchImpl: deps.fetchImpl,
      maxBytes: OFFICIAL_PACK_MAX_BYTES,
      mirror: deps.mirror,
      onProgress: deps.onProgress,
    })
    buffer = download.buffer
    source = download.source
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }

  await mkdir(deps.downloadDir, { recursive: true })
  const zipPath = path.join(deps.downloadDir, officialPackAssetName(version))
  await writeFile(zipPath, buffer)
  try {
    const result = await deps.importPack(zipPath, undefined, { name: officialPackDisplayName(version) })
    const latest = await readPackRegistry(deps.registryPath)
    const record = latest.find(item => item.id === result.id)
    if (record) {
      await upsertPackRecord(deps.registryPath, { ...record, officialVersion: version })
      // 官方包的内容由发布方决定，导入后统一把外观钉回 DSH 原生无皮肤：
      // skin-center 的 seed 只在 active 为 null 且未初始化时才发作，写这一次就够，
      // 之后用户自己挑的皮肤/壁纸不会被反复覆盖。
      if (record.homePath) await applyStockAppearance(record.homePath)
    }
    return { outcome: 'imported', result, source }
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error), source }
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined)
  }
}

async function ensureVersionFrom(
  deps: OfficialPackDeps,
  version: string,
  releases: OfficialPackRelease[] | null,
): Promise<OfficialPackResult> {
  try {
    const listed = releases?.find(item => item.version === version)
    if (listed) {
      return await downloadAndImport(deps, version, { url: listed.assetUrl, size: listed.size })
    }
    const resolved = await resolveOfficialPackAssetFromLatest(deps, version)
    if (!resolved.asset) {
      return { outcome: resolved.message?.includes('没有') ? 'no-asset' : 'failed', message: resolved.message }
    }
    return await downloadAndImport(deps, version, resolved.asset)
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 确保指定版本的官方整合包存在；缺失时下载导入并盖版本戳。永不 throw。
 * 「已导入」的短路在联网之前——本机已有这个版本就一次网络请求都不发。
 */
export async function ensureOfficialPackVersion(deps: OfficialPackDeps, version: string): Promise<OfficialPackResult> {
  const target = version.trim()
  if (!target) return { outcome: 'failed', message: '官方整合包版本号为空。' }
  try {
    const records = await readPackRegistry(deps.registryPath)
    if (records.some(record => record.officialVersion === target)) return { outcome: 'present' }
  } catch {
    // 注册表读不出来不阻断：继续走下载，导入端会自己兜底。
  }
  return ensureVersionFrom(deps, target, await tryListOfficialPackVersions(deps))
}
