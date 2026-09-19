import { DSH_PACKAGE_NAME, DSH_REPOSITORY } from '../src/constants'
import type { DshInstallationStatus, DshUpdateStatus } from '../src/types'
import { compareVersions, normalizeVersion, readRecommendedDshVersion } from './dsh-release'

/** 版本号解析/比较的唯一实现在 electron/dsh-release.ts；这里再导出以保持既有导入路径可用。 */
export { compareVersions, normalizeVersion } from './dsh-release'

const GITHUB_API_ROOT = 'https://api.github.com'
const DSH_PACKAGE_PATHS = ['apps/cli/package.json', 'package.json'] as const
const DSH_VERSION_PACKAGE_NAMES = new Set([DSH_PACKAGE_NAME, '@deepseek-ai/dsh-root'])
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}

interface GitHubRepositoryResponse {
  default_branch?: unknown
}

interface GitHubContentResponse {
  content?: unknown
  encoding?: unknown
  download_url?: unknown
}

interface PackageManifest {
  name?: unknown
  version?: unknown
}

function repositoryApiUrl(path: string): string {
  return `${GITHUB_API_ROOT}/repos/${DSH_REPOSITORY}/${path}`
}

function checkedAt(): string {
  return new Date().toISOString()
}

function status(
  state: DshUpdateStatus['state'],
  localVersion: string | null,
  remoteVersion: string | null,
  message: string,
): DshUpdateStatus {
  return {
    state,
    localVersion,
    remoteVersion,
    repository: DSH_REPOSITORY,
    checkedAt: checkedAt(),
    message,
  }
}

async function requestJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, { headers: GITHUB_HEADERS })
  if (!response.ok) {
    if (response.status === 403) throw new Error('GitHub 请求额度暂时用尽。')
    throw new Error(`GitHub 返回 ${response.status}。`)
  }
  return response.json() as Promise<T>
}

function decodeContent(content: string): string {
  return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8')
}

async function readRemoteDshVersionFromGitHub(fetchImpl: typeof fetch): Promise<string> {
  const repository = await requestJson<GitHubRepositoryResponse>(
    repositoryApiUrl(''),
    fetchImpl,
  )
  const branch = typeof repository.default_branch === 'string' && repository.default_branch.length > 0
    ? repository.default_branch
    : 'master'

  let lastError: unknown = null
  for (const packagePath of DSH_PACKAGE_PATHS) {
    const endpoint = repositoryApiUrl(`contents/${packagePath}?ref=${encodeURIComponent(branch)}`)
    try {
      const content = await requestJson<GitHubContentResponse>(endpoint, fetchImpl)
      if (typeof content.content !== 'string' || content.encoding !== 'base64') {
        throw new Error('GitHub 没有返回可读取的 package.json。')
      }
      const manifest = JSON.parse(decodeContent(content.content)) as PackageManifest
      if (typeof manifest.name !== 'string' || !DSH_VERSION_PACKAGE_NAMES.has(manifest.name)
        || typeof manifest.version !== 'string' || !manifest.version.trim()) {
        throw new Error(`仓库文件不是 DSH 版本清单。`)
      }
      return manifest.version.trim()
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('未找到 DSH 版本清单。')
}

/**
 * 镜像优先读 registry，全部失败才回退 GitHub contents（仓库不可达/镜像限流时）。
 * registry 侧走与「推荐安装」完全相同的推荐版本口径，两边不会各说各话。
 */
async function readRemoteDshVersion(fetchImpl: typeof fetch, registryCandidates: string[]): Promise<string> {
  let registryError: unknown = null
  try {
    return await readRecommendedDshVersion(fetchImpl, registryCandidates)
  } catch (error) {
    registryError = error
  }
  try {
    return await readRemoteDshVersionFromGitHub(fetchImpl)
  } catch (error) {
    throw error instanceof Error ? error : registryError
  }
}

/**
 * Compare the installed DSH package with the version the launcher would install
 * (registry 推荐版本，镜像优先、官方源兜底；GitHub contents 只作最后回退，
 * 此时拿到的是仓库分支上的版本，不一定等于线上发布版)。
 * A failed check is reported as an error state and never blocks launcher startup.
 */
export async function checkDshUpdate(
  installation: DshInstallationStatus,
  fetchImpl: typeof fetch = fetch,
  registryCandidates: string[] = [],
): Promise<DshUpdateStatus> {
  const localVersion = installation.version?.trim() || null
  if (!installation.installed || !localVersion) {
    return status('not-installed', localVersion, null, '尚未安装 DSH。')
  }

  try {
    const remoteVersion = await readRemoteDshVersion(fetchImpl, registryCandidates)
    const newer = compareVersions(localVersion, remoteVersion) > 0
    return newer
      ? status('update-available', localVersion, remoteVersion, `发现 DSH 新版本 ${remoteVersion}。`)
      : status('up-to-date', localVersion, remoteVersion,
        normalizeVersion(remoteVersion) === normalizeVersion(localVersion)
          ? '当前 DSH 已是最新版本。'
          : `本地 DSH ${localVersion} 高于可更新版本 ${remoteVersion}。`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return status('error', localVersion, null, `暂时无法检查 DSH 更新：${detail}`)
  }
}

export { readRemoteDshVersion }
