import { applyGitHubMirror, GITHUB_PUBLIC_MIRRORS } from './github-archive'
import { downloadReleaseAsset } from './release-download'

/**
 * 官方整合包（百余 MB）的下载器：候选源自动换。
 *
 * 国内直连 GitHub 常是「连得上但慢到几十 KB/s」，只靠断流超时救不了，所以有三重守卫：
 * 等首字节超时、中途断流超时、以及**速度下限**（观测窗口内平均速度不达标就换源）。
 * 候选顺序：用户配置的镜像 → GitHub 直连 → 内置公共镜像。全部都不达标时，第二轮按实测速度
 * 从快到慢再试一次——那一轮只看断流，不再因慢中断，否则「全网都慢」的线路会一直换源、永远下不完。
 */

export interface OfficialPackDownloadTuning {
  /** 等首个字节的上限：超时说明这条链路基本不通。 */
  firstByteMs: number
  /** 中途多久没有新数据判定为断流。 */
  stallMs: number
  /** 速度观测窗口：窗口内的平均速度低于下限就换源。 */
  probeMs: number
  /** 速度下限（字节/秒）。 */
  floorBytesPerSecond: number
}

/** 默认值面向国内家宽调过：直连 8 秒不见字节、或 5 秒内均速不到 300KB/s 就换镜像。 */
export const OFFICIAL_PACK_DOWNLOAD_TUNING: OfficialPackDownloadTuning = {
  firstByteMs: 8_000,
  stallMs: 20_000,
  probeMs: 5_000,
  floorBytesPerSecond: 300 * 1024,
}

export interface OfficialPackDownloadProgress {
  received: number
  total: number | null
  /** 正在使用的下载源（镜像域名或「GitHub 直连」），用于界面回显。 */
  source: string
}

/** 候选顺序：用户显式配置的镜像优先，其次直连，最后内置公共镜像。 */
export function officialPackCandidateUrls(assetUrl: string, mirror?: string): string[] {
  const candidates: string[] = []
  if (mirror?.trim()) candidates.push(applyGitHubMirror(assetUrl, mirror))
  candidates.push(assetUrl)
  for (const prefix of GITHUB_PUBLIC_MIRRORS) candidates.push(`${prefix}${assetUrl}`)
  return candidates
}

/** 给界面看的源名字：镜像显示域名，直连显示「GitHub 直连」。 */
export function officialPackSourceLabel(candidateUrl: string, assetUrl: string): string {
  if (candidateUrl === assetUrl) return 'GitHub 直连'
  try {
    return new URL(candidateUrl).host
  } catch {
    return '镜像'
  }
}

/** 换源时抛出：带上实测平均速度，第二轮据此按快慢排序。 */
class CandidateRejected extends Error {
  constructor(message: string, readonly speed: number) {
    super(message)
    this.name = 'CandidateRejected'
  }
}

export interface OfficialPackDownloadOptions {
  fetchImpl: typeof fetch
  maxBytes: number
  mirror?: string
  onProgress?: (progress: OfficialPackDownloadProgress) => void
  tuning?: Partial<OfficialPackDownloadTuning>
}

export interface OfficialPackDownloadResult {
  buffer: Buffer
  /** 实际拿下这份包的源（给界面回显「经 xxx 下载」）。 */
  source: string
}

export async function downloadOfficialPackAsset(
  assetUrl: string,
  options: OfficialPackDownloadOptions,
): Promise<OfficialPackDownloadResult> {
  const tuning = { ...OFFICIAL_PACK_DOWNLOAD_TUNING, ...options.tuning }
  const candidates = officialPackCandidateUrls(assetUrl, options.mirror)
  /** 被测速拒绝过的源 → 实测均速（第二轮排序用）。 */
  const measured = new Map<string, number>()
  let lastError: unknown = null

  for (const enforceFloor of [true, false]) {
    const ordered = enforceFloor
      ? candidates
      : [...measured.keys()].sort((left, right) => (measured.get(right) ?? 0) - (measured.get(left) ?? 0))
    for (const candidateUrl of ordered) {
      const source = officialPackSourceLabel(candidateUrl, assetUrl)
      try {
        const buffer = await downloadCandidate(candidateUrl, source, options, tuning, enforceFloor)
        return { buffer, source }
      } catch (error) {
        lastError = error
        if (error instanceof CandidateRejected) measured.set(candidateUrl, error.speed)
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : '未知原因'
  throw new Error(`官方整合包下载失败：所有下载源都不可用（最后一个：${detail}）。`)
}

/** 从单个候选源取整包；被守卫打断时抛 CandidateRejected（含均速）。 */
async function downloadCandidate(
  candidateUrl: string,
  source: string,
  options: OfficialPackDownloadOptions,
  tuning: OfficialPackDownloadTuning,
  enforceFloor: boolean,
): Promise<Buffer> {
  const controller = new AbortController()
  const startedAt = Date.now()
  let received = 0
  let lastDataAt = startedAt
  let firstByteAt: number | null = null
  let probeStartedAt = startedAt
  let probeStartBytes = 0
  let rejection: CandidateRejected | null = null

  const reject = (message: string): void => {
    if (rejection) return
    const seconds = Math.max(1, Date.now() - startedAt) / 1000
    rejection = new CandidateRejected(message, received / seconds)
    controller.abort()
  }

  /** 守卫巡检间隔：跟着最紧的那个阈值走（生产里 250ms，测试把阈值调小后也随之变快）。 */
  const tickMs = Math.max(25, Math.min(250, Math.floor(Math.min(tuning.firstByteMs, tuning.stallMs, tuning.probeMs) / 4)))
  const watchdog = setInterval(() => {
    const now = Date.now()
    if (firstByteAt === null) {
      if (now - startedAt >= tuning.firstByteMs) reject(`${source} 无响应（等首字节超时）`)
      return
    }
    if (now - lastDataAt >= tuning.stallMs) {
      reject(`${source} 下载中断`)
      return
    }
    if (!enforceFloor) return
    const windowMs = now - probeStartedAt
    if (windowMs < tuning.probeMs) return
    const speed = ((received - probeStartBytes) * 1000) / windowMs
    if (speed >= tuning.floorBytesPerSecond) return
    reject(`${source} 速度只有 ${Math.round(speed / 1024)} KB/s`)
  }, tickMs)

  try {
    return await downloadReleaseAsset(
      candidateUrl,
      options.maxBytes,
      (chunkReceived, total) => {
        const now = Date.now()
        received = chunkReceived
        lastDataAt = now
        if (firstByteAt === null) {
          firstByteAt = now
          probeStartedAt = now
          probeStartBytes = chunkReceived
        }
        options.onProgress?.({ received: chunkReceived, total, source })
      },
      options.fetchImpl,
      controller.signal,
    )
  } catch (error) {
    if (rejection) throw rejection
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearInterval(watchdog)
  }
}
