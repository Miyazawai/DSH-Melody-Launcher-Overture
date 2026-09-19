import { DSH_PACKAGE_NAME } from '../src/constants'
import { dshChannelRank } from '../src/lib/dsh-version'
import type { RuntimeVersionCandidate } from '../src/types'

/**
 * DSH 版本挑选的唯一口径。
 *
 * 这是一个叶子模块（只依赖 src/constants、src/lib/dsh-version 与 src/types），
 * 供 runtime-versions（版本列表/推荐安装）与 dsh-update（检查更新）共用。
 * 两边必须用同一条规则，否则会出现「提示可更新到 X，装下去却是 Y」。
 *
 * 规则：稳定优先、同级取新——正式版 > rc > beta > alpha > 其它，同一渠道内取版本号最高的。
 * 渠道一律从版本串本身解析（见 src/lib/dsh-version.ts），不采信 npm dist-tag：
 * dist-tag 是发布者自起的别名，它和版本串里的渠道经常对不上（例如 next 标签指向 rc 版本）。
 */

/** 可下载列表里每个渠道最多保留多少条。 */
export const VERSION_LIMIT_PER_CHANNEL = 12

/** 这些 dist-tag 指向的版本不参与截断，避免被同类版本挤掉。 */
const RETAINED_DIST_TAGS = ['latest', 'next', 'beta', 'rc', 'alpha']

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

export function validVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())
}

interface ParsedVersion {
  core: [number, number, number]
  prerelease: string[]
}

function parseVersion(version: string): ParsedVersion | null {
  const match = normalizeVersion(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** Returns a positive number when remote is newer than local. */
export function compareVersions(local: string, remote: string): number {
  const left = parseVersion(local)
  const right = parseVersion(remote)
  if (!left || !right) return normalizeVersion(remote).localeCompare(normalizeVersion(local))

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return right.core[index] - left.core[index]
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? -1 : 1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const localPart = left.prerelease[index]
    const remotePart = right.prerelease[index]
    if (localPart === undefined || remotePart === undefined) return localPart === undefined ? 1 : -1
    if (localPart === remotePart) continue
    const localNumber = /^\d+$/.test(localPart) ? Number(localPart) : null
    const remoteNumber = /^\d+$/.test(remotePart) ? Number(remotePart) : null
    if (localNumber !== null && remoteNumber !== null) return remoteNumber - localNumber
    if (localNumber !== null) return -1
    if (remoteNumber !== null) return 1
    return remotePart.localeCompare(localPart)
  }
  return 0
}

/** 版本号最高者（列表里真正最新的那个）；空列表返回 null。 */
export function pickNewestDshVersion(candidates: readonly RuntimeVersionCandidate[]): RuntimeVersionCandidate | null {
  let newest: RuntimeVersionCandidate | null = null
  for (const candidate of candidates) {
    if (!newest || compareVersions(newest.version, candidate.version) > 0) newest = candidate
  }
  return newest
}

/**
 * 启动器推荐下载/更新的版本：稳定优先、同级取新。
 * 结果只取决于候选集合本身，与输入顺序无关。
 */
export function pickRecommendedDshVersion(candidates: readonly RuntimeVersionCandidate[]): RuntimeVersionCandidate | null {
  let best: RuntimeVersionCandidate | null = null
  let bestRank = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const rank = dshChannelRank(candidate.version)
    if (rank > bestRank) continue
    // 同渠道取版本号最高的；相同版本保留先出现的一个。
    if (rank === bestRank && best && compareVersions(best.version, candidate.version) <= 0) continue
    best = candidate
    bestRank = rank
  }
  return best
}

export interface DshRegistryResponse {
  versions?: Record<string, unknown>
  'dist-tags'?: Record<string, unknown>
  time?: Record<string, unknown>
}

/** npm 完整 packument：含 time（每个版本的发布日期）。 */
export const FULL_PACKUMENT_ACCEPT = 'application/json'
/** npm 精简 packument：体积小得多，但没有 time；只判断版本号时用它。 */
export const ABBREVIATED_PACKUMENT_ACCEPT = 'application/vnd.npm.install-v1+json, application/json'

export interface ReadDshVersionIndexOptions {
  accept?: string
  timeoutMs?: number
}

/**
 * 按候选顺序逐个读 registry，返回第一个成功解析的 packument；全部失败抛出最后一次错误。
 * 大陆环境优先镜像，所以调用方传入的顺序就是回退顺序。
 */
export async function readDshVersionIndex(
  fetchImpl: typeof fetch = fetch,
  registryCandidates: string[] = [],
  options: ReadDshVersionIndexOptions = {},
): Promise<DshRegistryResponse> {
  const seen = new Set<string>()
  let lastError: unknown = null
  for (const candidate of registryCandidates) {
    const base = candidate.trim().replace(/\/+$/, '')
    if (!base || seen.has(base)) continue
    seen.add(base)
    try {
      const response = await fetchImpl(`${base}/${DSH_PACKAGE_NAME.replace('/', '%2F')}`, {
        headers: { Accept: options.accept ?? FULL_PACKUMENT_ACCEPT, 'User-Agent': 'DSH-Launcher' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
      if (!response.ok) throw new Error(`读取 DSH npm 版本列表失败（HTTP ${response.status}）。`)
      return await response.json() as DshRegistryResponse
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('读取 DSH npm 版本列表失败。')
}

function candidateFromVersion(version: string, time?: string | null, distTag?: string | null): RuntimeVersionCandidate {
  const normalized = normalizeVersion(version)
  return {
    version: normalized,
    label: distTag ?? null,
    lts: null,
    date: time ?? null,
    prerelease: normalized.includes('-'),
  }
}

/**
 * packument → 候选列表：按版本号降序，标出「最新版」与「推荐版本」，再按渠道截断。
 * 两个标记都在截断前计算并强制保留，避免被 VERSION_LIMIT_PER_CHANNEL 切掉。
 */
export function candidatesFromPackument(data: DshRegistryResponse): RuntimeVersionCandidate[] {
  const versions = Object.keys(data.versions ?? {}).filter(validVersion)
  const tags = Object.entries(data['dist-tags'] ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && validVersion(entry[1]))
  const tagged = new Map(tags.map(([tag, version]) => [normalizeVersion(version), tag]))
  const candidates = versions
    .map(version => candidateFromVersion(version, typeof data.time?.[version] === 'string' ? data.time[version] as string : null, tagged.get(normalizeVersion(version))))
    .sort((left, right) => compareVersions(left.version, right.version))

  const newest = pickNewestDshVersion(candidates)
  const recommended = pickRecommendedDshVersion(candidates)
  if (newest) newest.isNewest = true
  if (recommended) recommended.recommended = true

  const stable = candidates.filter(candidate => !candidate.prerelease).slice(0, VERSION_LIMIT_PER_CHANNEL)
  const prerelease = candidates.filter(candidate => candidate.prerelease).slice(0, VERSION_LIMIT_PER_CHANNEL)
  const retained = candidates.filter(candidate => candidate.isNewest
    || candidate.recommended
    || RETAINED_DIST_TAGS.includes(candidate.label ?? ''))
  const selected = new Map<string, RuntimeVersionCandidate>()
  for (const item of [...stable, ...prerelease, ...retained]) selected.set(item.version, item)
  return [...selected.values()].sort((left, right) => compareVersions(left.version, right.version))
}

/** registry 版本真值 → 推荐安装/更新版本；没有任何可用版本时抛错，交给调用方回退下一个源。 */
export async function readRecommendedDshVersion(
  fetchImpl: typeof fetch,
  registryCandidates: string[],
  timeoutMs = 10_000,
): Promise<string> {
  const data = await readDshVersionIndex(fetchImpl, registryCandidates, {
    accept: ABBREVIATED_PACKUMENT_ACCEPT,
    timeoutMs,
  })
  const recommended = pickRecommendedDshVersion(candidatesFromPackument(data))
  if (!recommended) throw new Error('npm 镜像没有返回可用的版本号。')
  return recommended.version
}
