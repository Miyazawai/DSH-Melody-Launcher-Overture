import path from 'node:path'
import type {
  ApplicationInstallTarget,
  ApplicationLaunchMode,
  ApplicationRepositoryAnalysis,
} from '../src/types'
import { isSafePackageName, isSafeRepositoryName, repositoryFullNameFromSpecifier } from './profile'
import { requestNpmMetadata } from './proxy'

export const APPLICATION_MANIFEST_PATH = '.dsh-launcher/addon.json'

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}

const LAUNCH_MODES = new Set<ApplicationLaunchMode>([
  'runtime-replacement',
  'after-runtime',
  'standalone',
])
const PLATFORMS = new Set(['win32', 'darwin', 'linux'] as const)
const IGNORED_PACKAGE_DIRECTORIES = new Set([
  'node_modules',
  'fixtures',
  'fixture',
  'tests',
  'test',
  'examples',
  'example',
  'vendor',
  'dist',
])

interface RawApplicationManifest {
  schemaVersion?: unknown
  id?: unknown
  name?: unknown
  description?: unknown
  type?: unknown
  launchMode?: unknown
  install?: {
    provider?: unknown
    package?: unknown
    version?: unknown
  }
  launch?: {
    bin?: unknown
    args?: unknown
  }
  platforms?: unknown
  provides?: unknown
}

interface PackageManifest {
  name?: unknown
  version?: unknown
  description?: unknown
  repository?: unknown
  homepage?: unknown
  bin?: unknown
  peerDependencies?: Record<string, unknown>
  dsh?: { bundle?: { patch?: unknown } }
  build?: {
    appId?: unknown
    productName?: unknown
    win?: unknown
    mac?: unknown
    linux?: unknown
  }
}

interface GitHubTree {
  tree?: Array<{ path: string; type: 'blob' | 'tree' }>
}

async function requestWithRetry(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchImpl(url, init)
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
  throw new Error(`连接应用加载项来源失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function safeBranch(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && !value.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(value)
}

function safeAddonId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(value)
}

function safeBinName(value: string): boolean {
  return Boolean(value) && value.length <= 120 && !/[\\/]/.test(value)
}

function githubApiPath(repository: string, suffix: string): string {
  const [owner, name] = repository.split('/')
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${suffix}`
}

function rawFileUrl(repository: string, revision: string, filePath: string): string {
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/')
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${encodedRepository}/${encodeURIComponent(revision)}/${encodedPath}`
}

async function fetchCommit(repository: string, branch: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await requestWithRetry(githubApiPath(repository, `commits/${encodeURIComponent(branch)}`), {
    headers: GITHUB_HEADERS,
  }, fetchImpl)
  if (response.status === 403) throw new Error('GitHub 请求额度暂时用尽，请稍后重试。')
  if (!response.ok) throw new Error(`读取应用加载项仓库失败（HTTP ${response.status}）。`)
  const result = await response.json() as { sha?: unknown }
  if (typeof result.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(result.sha)) {
    throw new Error('GitHub 没有返回有效的提交版本。')
  }
  return result.sha
}

async function fetchManifest(
  repository: string,
  revision: string,
  fetchImpl: typeof fetch,
): Promise<RawApplicationManifest | null> {
  const response = await requestWithRetry(rawFileUrl(repository, revision, APPLICATION_MANIFEST_PATH), {
    headers: { 'User-Agent': 'DSH-Launcher' },
  }, fetchImpl)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`读取应用加载项清单失败（HTTP ${response.status}）。`)
  try {
    return await response.json() as RawApplicationManifest
  } catch {
    throw new Error(`应用加载项清单 ${APPLICATION_MANIFEST_PATH} 不是有效 JSON。`)
  }
}

async function fetchTree(repository: string, commit: string, fetchImpl: typeof fetch): Promise<GitHubTree> {
  const response = await requestWithRetry(githubApiPath(repository, `git/trees/${commit}?recursive=1`), {
    headers: GITHUB_HEADERS,
  }, fetchImpl)
  if (response.status === 403) throw new Error('GitHub 请求额度暂时用尽，请稍后重试。')
  if (!response.ok) throw new Error(`读取应用加载项仓库目录失败（HTTP ${response.status}）。`)
  return response.json() as Promise<GitHubTree>
}

async function fetchPackageManifest(
  repository: string,
  revision: string,
  packagePath: string,
  fetchImpl: typeof fetch,
): Promise<PackageManifest | null> {
  const response = await requestWithRetry(rawFileUrl(repository, revision, packagePath), {
    headers: { 'User-Agent': 'DSH-Launcher' },
  }, fetchImpl)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`读取 ${packagePath} 失败（HTTP ${response.status}）。`)
  try {
    return await response.json() as PackageManifest
  } catch {
    return null
  }
}

async function fetchPublishedPackage(packageName: string, fetchImpl: typeof fetch): Promise<PackageManifest | null> {
  const response = await requestNpmMetadata(`/${encodeURIComponent(packageName)}/latest`, fetchImpl)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`读取 npm 包 ${packageName} 失败（HTTP ${response.status}）。`)
  try {
    return await response.json() as PackageManifest
  } catch {
    return null
  }
}

function stringList(value: unknown, field: string, maximum = 32): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string')) {
    throw new Error(`应用加载项清单中的 ${field} 格式无效。`)
  }
  return value.map(item => item.trim()).filter(Boolean)
}

export function applicationTargetFromManifest(
  repository: string,
  manifest: RawApplicationManifest,
  platform: NodeJS.Platform = process.platform,
): ApplicationInstallTarget {
  if (manifest.schemaVersion !== 1 || manifest.type !== 'application') {
    throw new Error('应用加载项清单版本或类型不受支持。')
  }
  const addonId = typeof manifest.id === 'string' ? manifest.id.trim().toLowerCase() : ''
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : ''
  const packageName = typeof manifest.install?.package === 'string' ? manifest.install.package.trim() : ''
  const version = typeof manifest.install?.version === 'string' && manifest.install.version.trim()
    ? manifest.install.version.trim()
    : null
  const binName = typeof manifest.launch?.bin === 'string' ? manifest.launch.bin.trim() : ''
  const launchMode = manifest.launchMode
  if (!safeAddonId(addonId)) throw new Error('应用加载项清单中的 id 无效。')
  if (!name || name.length > 120) throw new Error('应用加载项清单中的 name 无效。')
  if (manifest.install?.provider !== 'npm') throw new Error('当前只支持 npm 应用加载项。')
  if (!isSafePackageName(packageName)) throw new Error('应用加载项清单中的 npm 包名无效。')
  if (version && !isExactNpmVersion(version)) throw new Error('应用加载项清单必须声明精确的 npm 版本。')
  if (!safeBinName(binName)) throw new Error('应用加载项清单中的启动入口无效。')
  if (typeof launchMode !== 'string' || !LAUNCH_MODES.has(launchMode as ApplicationLaunchMode)) {
    throw new Error('应用加载项清单中的 launchMode 无效。')
  }
  const rawPlatforms = manifest.platforms === undefined
    ? ['win32', 'darwin', 'linux']
    : stringList(manifest.platforms, 'platforms', 3)
  if (rawPlatforms.length === 0 || rawPlatforms.some(item => !PLATFORMS.has(item as 'win32' | 'darwin' | 'linux'))) {
    throw new Error('应用加载项清单中的 platforms 无效。')
  }
  const platforms = rawPlatforms as Array<'win32' | 'darwin' | 'linux'>
  return {
    id: `${addonId}:.`,
    addonId,
    name,
    description: description || `${name} 应用加载项`,
    provider: 'npm',
    packageName,
    version,
    binName,
    launchMode: launchMode as ApplicationLaunchMode,
    launchArgs: stringList(manifest.launch?.args, 'launch.args'),
    platforms,
    supported: platforms.includes(platform as 'win32' | 'darwin' | 'linux'),
    verified: true,
    provides: stringList(manifest.provides, 'provides'),
  }
}

function validRelativeBinPath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'))
  return normalized !== '..' && !normalized.startsWith('../')
}

function binEntry(manifest: PackageManifest, packageName: string): { name: string; path: string } | null {
  const fallbackName = packageName.split('/').at(-1) ?? packageName
  if (typeof manifest.bin === 'string') {
    return validRelativeBinPath(manifest.bin) ? { name: fallbackName, path: manifest.bin } : null
  }
  if (!manifest.bin || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin)) return null
  const entries = Object.entries(manifest.bin as Record<string, unknown>)
    .filter((entry): entry is [string, string] => safeBinName(entry[0])
      && typeof entry[1] === 'string'
      && validRelativeBinPath(entry[1]))
  if (entries.length === 0) return null
  const preferred = entries.find(([name]) => name === packageName)
    ?? entries.find(([name]) => name === fallbackName)
    ?? entries.sort(([left], [right]) => left.localeCompare(right))[0]
  return { name: preferred[0], path: preferred[1] }
}

function hasElectronHostSignal(manifest: PackageManifest): boolean {
  return typeof manifest.peerDependencies?.electron === 'string'
    || typeof manifest.build?.appId === 'string'
}

function bundlePatchPath(packagePath: string, manifest: PackageManifest): string | null {
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !patch || path.posix.isAbsolute(patch)) return null
  const directory = path.posix.dirname(packagePath) === '.' ? '' : path.posix.dirname(packagePath)
  const normalized = path.posix.normalize(path.posix.join(directory, patch))
  if (normalized === '..' || normalized.startsWith('../')) return null
  return normalized.replace(/^\.\//, '')
}

function manifestRepository(manifest: PackageManifest): string | undefined {
  let value: string | undefined
  if (typeof manifest.repository === 'string') value = manifest.repository
  else if (manifest.repository && typeof manifest.repository === 'object') {
    const url = (manifest.repository as { url?: unknown }).url
    if (typeof url === 'string') value = url
  }
  if (!value && typeof manifest.homepage === 'string') value = manifest.homepage
  return repositoryFullNameFromSpecifier(value)
}

function isExactNpmVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
}

function exactPublishedVersion(manifest: PackageManifest): string | null {
  return typeof manifest.version === 'string' && isExactNpmVersion(manifest.version)
    ? manifest.version
    : null
}

function addonIdFromPackage(packageName: string): string | null {
  const value = packageName.toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 80)
    .replace(/[^a-z0-9]+$/g, '')
  return safeAddonId(value) ? value : null
}

function inferredPlatforms(manifest: PackageManifest): Array<'win32' | 'darwin' | 'linux'> {
  const platforms: Array<'win32' | 'darwin' | 'linux'> = []
  if (manifest.build?.win !== undefined) platforms.push('win32')
  if (manifest.build?.mac !== undefined) platforms.push('darwin')
  if (manifest.build?.linux !== undefined) platforms.push('linux')
  return platforms.length > 0 ? platforms : ['win32', 'darwin', 'linux']
}

function displayName(manifest: PackageManifest, packageName: string): string {
  const productName = manifest.build?.productName
  if (typeof productName === 'string' && productName.trim() && productName.trim().length <= 120) {
    return productName.trim()
  }
  return packageName.split('/').at(-1)?.replace(/[-_]+/g, ' ') || packageName
}

async function targetWithPublishedVersion(
  repository: string,
  target: ApplicationInstallTarget,
  fetchImpl: typeof fetch,
): Promise<ApplicationInstallTarget> {
  if (target.version) return target
  const published = await fetchPublishedPackage(target.packageName, fetchImpl)
  const version = published && exactPublishedVersion(published)
  if (!published || published.name !== target.packageName || !version) {
    throw new Error(`npm 上没有可验证的 ${target.packageName} 正式版本。`)
  }
  const publishedRepository = manifestRepository(published)
  if (publishedRepository && publishedRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`${target.packageName} 的 npm 仓库声明与来源仓库不一致。`)
  }
  const declaredBin = typeof published.bin === 'object' && published.bin !== null && !Array.isArray(published.bin)
    ? (published.bin as Record<string, unknown>)[target.binName]
    : target.binName === target.packageName.split('/').at(-1) ? published.bin : undefined
  if (typeof declaredBin !== 'string' || !validRelativeBinPath(declaredBin)) {
    throw new Error(`npm 包没有声明 ${target.binName} 启动入口。`)
  }
  return { ...target, version }
}

async function inferApplicationTargets(
  repository: string,
  commit: string,
  fetchImpl: typeof fetch,
  platform: NodeJS.Platform,
): Promise<ApplicationInstallTarget[]> {
  const tree = await fetchTree(repository, commit, fetchImpl)
  const entries = tree.tree ?? []
  const files = new Set(entries.filter(entry => entry.type === 'blob').map(entry => entry.path))
  const packagePaths = entries
    .filter(entry => entry.type === 'blob' && (entry.path === 'package.json' || entry.path.endsWith('/package.json')))
    .map(entry => entry.path)
    .filter(packagePath => {
      const segments = packagePath.split('/')
      return segments.length <= 3
        && !segments.slice(0, -1).some(segment => IGNORED_PACKAGE_DIRECTORIES.has(segment.toLowerCase()))
    })
    .slice(0, 24)

  const candidates = await Promise.all(packagePaths.map(async packagePath => ({
    packagePath,
    manifest: await fetchPackageManifest(repository, commit, packagePath, fetchImpl),
  })))
  const targets: ApplicationInstallTarget[] = []
  for (const { packagePath, manifest } of candidates) {
    if (!manifest || typeof manifest.name !== 'string' || !isSafePackageName(manifest.name)) continue
    const packageName = manifest.name
    const patchPath = bundlePatchPath(packagePath, manifest)
    if (!patchPath || !files.has(patchPath) || !hasElectronHostSignal(manifest) || !binEntry(manifest, packageName)) continue

    const published = await fetchPublishedPackage(packageName, fetchImpl)
    const version = published && exactPublishedVersion(published)
    if (!published || published.name !== packageName || !version) continue
    if (!published.dsh?.bundle?.patch || !hasElectronHostSignal(published) || !binEntry(published, packageName)) continue
    if (manifestRepository(published)?.toLowerCase() !== repository.toLowerCase()) continue

    const addonId = addonIdFromPackage(packageName)
    const executable = binEntry(published, packageName)
    if (!addonId || !executable) continue
    const platforms = inferredPlatforms(published)
    const directory = path.posix.dirname(packagePath) === '.' ? '' : path.posix.dirname(packagePath)
    targets.push({
      id: `${addonId}:${directory || '.'}`,
      addonId,
      name: displayName(published, packageName),
      description: typeof published.description === 'string' && published.description.trim()
        ? published.description.trim()
        : `${displayName(published, packageName)} 应用加载项`,
      provider: 'npm',
      packageName,
      version,
      binName: executable.name,
      launchMode: 'runtime-replacement',
      launchArgs: [],
      platforms,
      supported: platforms.includes(platform as 'win32' | 'darwin' | 'linux'),
      verified: false,
      provides: [],
    })
  }

  return [...new Map(targets.map(target => [target.packageName.toLowerCase(), target])).values()]
}

export async function analyzeApplicationRepository(
  repository: string,
  defaultBranch: string,
  fetchImpl: typeof fetch = fetch,
  platform: NodeJS.Platform = process.platform,
): Promise<ApplicationRepositoryAnalysis> {
  if (!isSafeRepositoryName(repository) || !safeBranch(defaultBranch)) {
    throw new Error('仓库名称或默认分支无效。')
  }

  const commit = await fetchCommit(repository, defaultBranch, fetchImpl)
  const manifest = await fetchManifest(repository, commit, fetchImpl)
  if (manifest) {
    const target = await targetWithPublishedVersion(
      repository,
      applicationTargetFromManifest(repository, manifest, platform),
      fetchImpl,
    )
    return {
      repository,
      defaultBranch,
      installability: target.supported ? 'ready' : 'unsupported',
      summary: target.supported
        ? `检测到可安装的应用加载项 ${target.name}（${target.launchMode}）。`
        : `${target.name} 不支持当前操作系统。`,
      targets: [target],
    }
  }

  const targets = await inferApplicationTargets(repository, commit, fetchImpl, platform)
  const supportedTargets = targets.filter(target => target.supported)
  if (targets.length === 0) {
    return {
      repository,
      defaultBranch,
      installability: 'invalid',
      summary: `没有找到 ${APPLICATION_MANIFEST_PATH}，也没有检测到可验证的 DSH Electron 应用宿主。`,
      targets: [],
    }
  }
  return {
    repository,
    defaultBranch,
    installability: supportedTargets.length === 0
      ? 'unsupported'
      : targets.length > 1 ? 'choice' : 'ready',
    summary: supportedTargets.length === 0
      ? '检测到 DSH Electron 应用宿主，但当前操作系统不受支持。'
      : targets.length > 1
        ? `根据仓库与 npm 清单检测到 ${targets.length} 个应用加载项，请选择需要的组件。`
        : `根据仓库与 npm 清单检测到应用加载项 ${targets[0].name}。`,
    targets,
  }
}
