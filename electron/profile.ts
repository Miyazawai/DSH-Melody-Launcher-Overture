import { access, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ManagedPlugin, ProfileState } from '../src/types'
import { readPluginReceipts } from './plugin-receipts'

interface PackageManifest {
  name?: string
  version?: string
  description?: string
  repository?: string | { type?: string; url?: string }
  dependencies?: Record<string, string>
  dsh?: {
    profile?: { bundles?: string[] }
    bundle?: { patch?: string }
  }
}

const CORE_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

function profilePaths(dshHome: string, profileName: string) {
  const profileDir = path.join(dshHome, 'profiles', profileName)
  return { profileDir, manifestPath: path.join(profileDir, 'package.json') }
}

function repositoryUrl(manifest: PackageManifest): string | undefined {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (!raw) return undefined
  return raw.replace(/^git\+/, '').replace(/\.git$/, '')
}

export function repositoryFullNameFromSpecifier(value?: string): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().replace(/^git\+/, '')
  const urlMatch = /(?:github\.com[/:]|codeload\.github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(normalized)
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2].replace(/\.git$/i, '')}`
  const shortcutMatch = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/i.exec(normalized)
  return shortcutMatch ? `${shortcutMatch[1]}/${shortcutMatch[2]}` : undefined
}

function displayName(packageName: string): string {
  return packageName.split('/').at(-1)?.replace(/^dsh[-_]?/i, '').replace(/[-_]+/g, ' ') || packageName
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

interface ResolvedDependency {
  manifest: PackageManifest | null
  bundleAvailable: boolean
}

async function bundlePatchExists(packageDirectory: string, manifest: PackageManifest | null): Promise<boolean> {
  const patchFile = manifest?.dsh?.bundle?.patch
  if (!patchFile || path.isAbsolute(patchFile)) return false
  const resolved = path.resolve(packageDirectory, patchFile)
  if (resolved !== packageDirectory && !resolved.startsWith(`${packageDirectory}${path.sep}`)) return false
  try {
    await access(resolved)
    return true
  } catch {
    return false
  }
}

async function resolveDependencyManifest(profileDir: string, packageName: string): Promise<ResolvedDependency> {
  const directPath = path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json')
  let manifestPath = directPath
  try {
    manifestPath = await realpath(directPath)
  } catch {
    // Keep the direct path for nodeLinker layouts where realpath is unavailable.
  }
  const manifest = await readJson<PackageManifest>(manifestPath)
  return {
    manifest,
    bundleAvailable: await bundlePatchExists(path.dirname(manifestPath), manifest),
  }
}

export async function readProfile(dshHome: string, profileName: string, pluginReceiptsPath?: string): Promise<ProfileState> {
  const { profileDir, manifestPath } = profilePaths(dshHome, profileName)
  const manifest = await readJson<PackageManifest>(manifestPath)
  if (!manifest) {
    return {
      initialized: false,
      profileDir,
      manifestPath,
      plugins: [],
      activeBundles: [],
      dependencyCount: 0,
      disabledCount: 0,
    }
  }

  const profileBundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const allNames = [...new Set([...profileBundles, ...dependencies])]
  let receipts: Awaited<ReturnType<typeof readPluginReceipts>> = []
  if (pluginReceiptsPath) {
    try {
      receipts = await readPluginReceipts(pluginReceiptsPath)
    } catch {
      // 安装收据只是来源补充，损坏时不能阻塞 Profile 本身的读取。
    }
  }
  const manifests = new Map<string, ResolvedDependency>()
  await Promise.all(dependencies.map(async packageName => {
    manifests.set(packageName, await resolveDependencyManifest(profileDir, packageName))
  }))

  const managedComponents: ManagedPlugin[] = allNames
    .map(packageName => {
      const resolvedDependency = manifests.get(packageName)
      const dependencyManifest = resolvedDependency?.manifest
      const enabled = profileBundles.includes(packageName)
      const builtin = !dependencies.includes(packageName)
      const compatible = builtin || enabled || Boolean(resolvedDependency?.bundleAvailable)
      const manifestRepo = repositoryUrl(dependencyManifest ?? {})
      const dependencyRepo = repositoryFullNameFromSpecifier(manifest.dependencies?.[packageName])
      const receiptRepo = repositoryFullNameFromSpecifier(receipts.find(receipt =>
        receipt.packId === profileName && receipt.packageName === packageName,
      )?.repository)
      const repositoryFullName = dependencyRepo ?? repositoryFullNameFromSpecifier(manifestRepo) ?? receiptRepo
      // Always expose a browser-ready GitHub URL when the source can be normalized.
      // This also fixes manifests that use `github:owner/repo`, `git+https://...`,
      // or a repository URL containing `/tree/<branch>/<subdirectory>`.
      const repo = repositoryFullName
        ? `https://github.com/${repositoryFullName}`
        : manifestRepo
      return {
        packageName,
        displayName: displayName(packageName),
        version: dependencyManifest?.version ?? (builtin ? '随 DSH 提供' : '未知版本'),
        description: dependencyManifest?.description ?? (builtin ? 'DeepSeek Harness 核心组合层' : '未提供插件说明'),
        repository: repo,
        repositoryFullName,
        enabled,
        builtin,
        locked: CORE_BUNDLES.has(packageName),
        compatible,
        order: enabled
          ? profileBundles.indexOf(packageName) + 1
          : null,
      }
    })
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      if (a.order !== null && b.order !== null) return a.order - b.order
      return a.packageName.localeCompare(b.packageName)
    })

  return {
    initialized: true,
    profileDir,
    manifestPath,
    plugins: managedComponents,
    activeBundles: profileBundles,
    dependencyCount: managedComponents.filter(plugin => !plugin.builtin).length,
    disabledCount: managedComponents.filter(plugin => !plugin.enabled).length,
  }
}

export async function updateBundles(
  dshHome: string,
  profileName: string,
  transform: (bundles: string[], manifest: PackageManifest) => string[],
  pluginReceiptsPath?: string,
): Promise<ProfileState> {
  const { profileDir, manifestPath } = profilePaths(dshHome, profileName)
  const manifest = await readJson<PackageManifest>(manifestPath)
  if (!manifest) throw new Error('此配置尚未初始化。请先启动 DSH，或从“资源市场”安装一个 Plugin。')

  const existing = [...(manifest.dsh?.profile?.bundles ?? [])]
  const next = transform(existing, manifest)
  if (new Set(next).size !== next.length) throw new Error('插件顺序中存在重复项。')
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: next },
  }
  await mkdir(profileDir, { recursive: true })
  const temporaryPath = `${manifestPath}.dsh-launcher.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, manifestPath)
  } catch {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await unlink(temporaryPath).catch(() => undefined)
  }
  return readProfile(dshHome, profileName, pluginReceiptsPath)
}

export async function togglePlugin(
  dshHome: string,
  profileName: string,
  packageName: string,
  enabled: boolean,
  pluginReceiptsPath?: string,
): Promise<ProfileState> {
  return updateBundles(dshHome, profileName, (bundles, manifest) => {
    if (CORE_BUNDLES.has(packageName) && !enabled) {
      throw new Error('核心组合层不能停用，否则 DSH 无法正常启动。')
    }
    const available = new Set([...bundles, ...Object.keys(manifest.dependencies ?? {})])
    if (!available.has(packageName)) throw new Error('插件已不在当前配置中，请刷新后重试。')
    if (enabled && !bundles.includes(packageName)) return [...bundles, packageName]
    if (!enabled) return bundles.filter(name => name !== packageName)
    return bundles
  }, pluginReceiptsPath)
}

export async function reorderPlugins(
  dshHome: string,
  profileName: string,
  packageNames: string[],
  pluginReceiptsPath?: string,
): Promise<ProfileState> {
  return updateBundles(dshHome, profileName, bundles => {
    if (packageNames.length !== bundles.length) throw new Error('新的加载顺序不完整，请刷新后重试。')
    const current = new Set(bundles)
    if (packageNames.some(name => !current.has(name))) throw new Error('新的加载顺序包含未知插件。')
    return packageNames
  }, pluginReceiptsPath)
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export function isSafeProfileName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)
}

export function isSafeRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
}

export function isSafePackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)
}
