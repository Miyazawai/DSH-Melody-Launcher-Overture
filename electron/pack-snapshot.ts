import { createWriteStream, existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import yazl from 'yazl'
import { assertInside, openZipPathFromFile, safeArchivePath, type OpenZipPath } from './pack-zip'

/**
 * 快照式整合包：导出 = 把整合包家目录（DSH_HOME）原样打成 zip（剔除个人数据、绝对路径相对化），
 * 导入 = 解压成新的隔离家目录。没有清单：包名取 zip 文件名、DSH 版本读包内 profile.yaml、
 * 启用状态读 package.json 的 dsh.profile.bundles。
 */

export const SNAPSHOT_META_FILENAME = 'dsh-snapshot.json'
export const SNAPSHOT_FORMAT_VERSION = 1
/** 包内插件本体目录（相对 profile 目录），file: 依赖相对化后指向这里。 */
export const SNAPSHOT_BODIES_DIR = '.dsh-launcher-plugin-bodies'

/** 快照包体积/条目限制：整包带 node_modules，按真实量级放宽，但仍有硬上限。 */
export const SNAPSHOT_ZIP_LIMITS = {
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxFiles: 400_000,
  maxUnpackedBytes: 6 * 1024 * 1024 * 1024,
}

/** 导入端路径长度预检阈值：写入走 \\?\ 前缀（Windows 无 260 限制），这里只挡极端异常值。 */
export const SNAPSHOT_MAX_PATH_LENGTH = 1000
/** 导出端给出长路径警告的阈值。 */
export const SNAPSHOT_WARN_PATH_LENGTH = 200

/**
 * Windows 长路径：`.pnpm` 目录名本身就长，目标家目录再深一点就会撞 260。
 * 写盘统一加 `\\?\` 前缀绕过限制（不改路径语义，仅本地文件系统调用用）。
 */
function nativePath(target: string): string {
  return process.platform === 'win32' ? path.toNamespacedPath(target) : target
}

export interface SnapshotLinkEntry {
  /** zip 内相对路径（正斜杠）。 */
  path: string
  /** 相对于链接自身所在目录的目标（正斜杠，可含 ../）。 */
  target: string
}

export interface SnapshotMeta {
  format: number
  platform: string
  exportedAt: string
  /** 符号链接清单：zip 里不写链接条目，由导入端按此重建。 */
  links: SnapshotLinkEntry[]
  /** 被剔除的相对路径（截断保存，供导入端核对与用户知情）。 */
  excluded: string[]
  /** 无法相对化、原样保留的依赖（包外本体已丢失）。 */
  warnings: string[]
}

export interface SnapshotPlanEntry {
  /** zip 内相对路径（正斜杠）。 */
  rel: string
  /** 源文件绝对路径；与 `data` 二选一。 */
  source?: string
  /** 已重写好的内容；与 `source` 二选一。 */
  data?: Buffer
}

export interface SnapshotPlan {
  entries: SnapshotPlanEntry[]
  links: SnapshotLinkEntry[]
  excluded: string[]
  warnings: string[]
  longPaths: string[]
  totalBytes: number
}

const EXCLUDED_TOP_LEVEL = new Set([
  '.credentials.yaml',
  '.anonymous-user-id',
  'sessions',
  'dsh-session-archive',
  'dsh-usage',
  'task-board',
  'attachments',
  'storages',
  '.dsh-module-fallback',
  '.skill-staging',
  '.preset-staging',
  '.pack-offline-import',
])

const EXCLUDED_TOP_LEVEL_PREFIXES = ['.pack-raw-staging-', '.pack-raw-preset-staging-', '.pack-offline-import-']
/** 任何层级出现即剔除的目录（DSH 自建缓存/临时目录，含绝对路径或纯临时数据）。 */
const EXCLUDED_ANYWHERE = new Set(['.dsh-module-fallback', '.skill-staging', '.preset-staging', '.pack-offline-import'])
/** pnpm 自己的元数据：含源机 store 绝对路径；导入端不跑 pnpm，交给它以后重建。 */
const EXCLUDED_PROFILE_FILES = new Set([
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.package-map.json',
])

/** 相对家目录的路径是否不进包（正斜杠、不含前导 ./）。 */
export function isSnapshotExcluded(rel: string): boolean {
  const segments = rel.split('/')
  const top = segments[0]
  if (EXCLUDED_TOP_LEVEL.has(top)) return true
  if (EXCLUDED_TOP_LEVEL_PREFIXES.some(prefix => top.startsWith(prefix))) return true
  if (segments.some(segment => EXCLUDED_ANYWHERE.has(segment))) return true
  if (segments.length === 1 && top.toLowerCase().endsWith('.log')) return true
  // profiles/<id>/node_modules 与 profiles/node_modules 下的 pnpm 元数据
  if (segments[0] === 'profiles' && segments.length >= 3) {
    if (EXCLUDED_PROFILE_FILES.has(segments.slice(2).join('/'))) return true
    if (EXCLUDED_PROFILE_FILES.has(segments.slice(1).join('/'))) return true
  }
  return false
}

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passwd|credential)/i

/** settings.yaml 字段级过滤：去掉 onboarding 与疑似密钥键，保留插件/模型/外观配置。 */
export function sanitizeSettingsYaml(text: string): string {
  const document = parseYamlObject(text)
  if (!document) return text
  delete document['ui-onboarding']
  scrubSecrets(document)
  return stringifyYaml(document, { lineWidth: 0 })
}

function scrubSecrets(node: Record<string, unknown>): void {
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      scrubSecrets(value as Record<string, unknown>)
      continue
    }
    // `apiKeyEnv` 只是环境变量名，不是密钥本体，保留。
    if (SECRET_KEY_RE.test(key) && !/env$/i.test(key)) delete node[key]
  }
}

/** .npmrc：只保留 registry 之类可移植配置，去掉 store 路径与任何凭据。 */
export function sanitizeNpmrc(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(line => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return true
      if (/^store-dir\s*=/i.test(trimmed)) return false
      if (/(_auth|_authToken|password|_password|token)\s*=/i.test(trimmed)) return false
      return true
    })
    .join('\n')
}

/** profile.yaml：去掉机器相关字段（source.path / exportedAt），可选改写 name。 */
export function sanitizeProfileYaml(text: string, newName?: string): string {
  const document = parseYamlObject(text)
  if (!document) return text
  if (newName) document.name = newName
  document.exportedAt = null
  const source = document.source
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    delete (source as Record<string, unknown>).path
  }
  return stringifyYaml(document, { lineWidth: 0 })
}

function parseYamlObject(text: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** lockfile 里是否残留指向盘符的 file: 记录（这类记录跨机不可用）。 */
export function lockfileHasAbsoluteFileSpecs(text: string): boolean {
  return /file:[A-Za-z]:[/\\]/.test(text) || /file:\/\/?[A-Za-z]:/.test(text)
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

async function walk(home: string, current: string, plan: SnapshotPlan): Promise<void> {
  let dirents
  try {
    dirents = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of dirents) {
    const full = path.join(current, dirent.name)
    const rel = toPosix(path.relative(home, full))
    if (isSnapshotExcluded(rel)) {
      if (plan.excluded.length < 200) plan.excluded.push(rel)
      continue
    }
    if (dirent.isSymbolicLink()) {
      const link = await resolveLink(home, full, rel)
      if (link) plan.links.push(link)
      continue
    }
    if (dirent.isDirectory()) {
      await walk(home, full, plan)
      continue
    }
    if (!dirent.isFile()) continue
    const info = await lstat(full).catch(() => null)
    if (!info) continue
    plan.totalBytes += info.size
    if (rel.length > SNAPSHOT_WARN_PATH_LENGTH && plan.longPaths.length < 50) plan.longPaths.push(rel)
    plan.entries.push({ rel, source: full })
  }
}

/** 链接目标在包内 → 记成相对链接；在包外（store、旧 staging）→ 丢弃，DSH 会重建。 */
async function resolveLink(home: string, linkPath: string, rel: string): Promise<SnapshotLinkEntry | null> {
  const target = await readlink(linkPath).catch(() => null)
  if (!target) return null
  const absoluteTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target)
  const resolvedHome = path.resolve(home)
  const resolvedTarget = path.resolve(absoluteTarget)
  if (resolvedTarget !== resolvedHome && !resolvedTarget.startsWith(`${resolvedHome}${path.sep}`)) return null
  return { path: rel, target: toPosix(path.relative(path.dirname(linkPath), resolvedTarget)) }
}

/** 扫描家目录并完成文本重写（不改动源目录）。 */
export async function planSnapshot(home: string, options: { packId: string }): Promise<SnapshotPlan> {
  const plan: SnapshotPlan = { entries: [], links: [], excluded: [], warnings: [], longPaths: [], totalBytes: 0 }
  await walk(home, home, plan)
  await rewriteEntries(home, options.packId, plan)
  return plan
}

async function rewriteEntries(home: string, packId: string, plan: SnapshotPlan): Promise<void> {
  const profileRel = `profiles/${packId}`
  const profileDir = path.join(home, 'profiles', packId)
  const bodiesRel = `${profileRel}/${SNAPSHOT_BODIES_DIR}`
  const drop = new Set<string>()
  const byRel = new Map(plan.entries.map(entry => [entry.rel, entry]))

  const rewriteText = async (rel: string, transform: (text: string) => string | null): Promise<void> => {
    const entry = byRel.get(rel)
    if (!entry?.source) return
    const text = await readFile(entry.source, 'utf8').catch(() => null)
    if (text === null) return
    const next = transform(text)
    if (next === null) {
      drop.add(rel)
      return
    }
    if (next !== text) entry.data = Buffer.from(next, 'utf8')
  }

  await rewriteText('settings.yaml', sanitizeSettingsYaml)
  await rewriteText(`${profileRel}/.npmrc`, sanitizeNpmrc)
  await rewriteText(`${profileRel}/profile.yaml`, text => sanitizeProfileYaml(text))
  // lockfile 里的 file: 记录写死了源机绝对路径；node_modules 已随包，导入不需要它。
  await rewriteText(`${profileRel}/pnpm-lock.yaml`, text => (lockfileHasAbsoluteFileSpecs(text) ? null : text))

  const packageRel = `${profileRel}/package.json`
  const packageEntry = byRel.get(packageRel)
  if (packageEntry?.source) {
    const text = await readFile(packageEntry.source, 'utf8').catch(() => null)
    if (text !== null) {
      const { text: rewritten, bodies } = await relativizeProfilePackageJson(text, profileDir, profileRel, bodiesRel, plan)
      packageEntry.data = Buffer.from(rewritten, 'utf8')
      void bodies
    }
  }

  if (drop.size > 0) plan.entries = plan.entries.filter(entry => !drop.has(entry.rel))
}

/**
 * 把 package.json 里指向包外的 `file:` 依赖相对化：本体（目录或 tgz）收进
 * `profiles/<id>/.dsh-launcher-plugin-bodies/…`，spec 改成相对 profile 目录的路径。
 */
async function relativizeProfilePackageJson(
  text: string,
  profileDir: string,
  profileRel: string,
  bodiesRel: string,
  plan: SnapshotPlan,
): Promise<{ text: string; bodies: number }> {
  let parsed: { dependencies?: Record<string, unknown>; [key: string]: unknown }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { text, bodies: 0 }
  }
  const dependencies = parsed.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return { text, bodies: 0 }
  let bodies = 0
  for (const [packageName, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const rawTarget = spec.slice('file:'.length)
    const resolved = await resolveBodySource(profileDir, packageName, rawTarget)
    if (!resolved) {
      plan.warnings.push(`${packageName} 的本体已不在磁盘上，file: 路径保持原样（对方导入后需要重新安装该插件）。`)
      continue
    }
    const bodyName = rawTarget.toLowerCase().endsWith('.tgz') ? `${packageName.replace(/[/@]/g, '-')}.tgz` : packageName
    const bodyRel = `${bodiesRel}/${bodyName}`
    if (resolved.isFile) {
      plan.entries.push({ rel: bodyRel, source: resolved.sourcePath })
    } else {
      const added = await collectDirectory(resolved.sourcePath, bodyRel, plan)
      if (added === 0) {
        plan.warnings.push(`${packageName} 的本体目录为空，file: 路径保持原样。`)
        continue
      }
    }
    dependencies[packageName] = `file:./${SNAPSHOT_BODIES_DIR}/${bodyName}`
    bodies += 1
  }
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, bodies }
}

async function resolveBodySource(
  profileDir: string,
  packageName: string,
  rawTarget: string,
): Promise<{ sourcePath: string; isFile: boolean } | null> {
  const candidates = [
    path.isAbsolute(rawTarget) ? rawTarget : path.resolve(profileDir, rawTarget),
    path.join(profileDir, 'node_modules', ...packageName.split('/')),
  ]
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null)
    if (!info) continue
    if (info.isDirectory() || (info.isFile() && candidate.toLowerCase().endsWith('.tgz'))) {
      return { sourcePath: candidate, isFile: info.isFile() }
    }
  }
  return null
}

/** 把一个目录树加进快照计划（返回加入的文件数）。 */
async function collectDirectory(sourceDir: string, targetRel: string, plan: SnapshotPlan): Promise<number> {
  let added = 0
  const stack: Array<{ dir: string; rel: string }> = [{ dir: sourceDir, rel: targetRel }]
  while (stack.length > 0) {
    const current = stack.pop()!
    const dirents = await readdir(current.dir, { withFileTypes: true }).catch(() => [])
    for (const dirent of dirents) {
      const full = path.join(current.dir, dirent.name)
      const rel = `${current.rel}/${dirent.name}`
      if (dirent.isDirectory()) {
        stack.push({ dir: full, rel })
        continue
      }
      if (!dirent.isFile()) continue
      const info = await lstat(full).catch(() => null)
      if (!info) continue
      plan.totalBytes += info.size
      plan.entries.push({ rel, source: full })
      added += 1
    }
  }
  return added
}

export interface WriteSnapshotOptions {
  onProgress?: (done: number, total: number) => void
}

/** 把快照计划写成 zip（流式，zip64 自动）。 */
export async function writeSnapshotZip(
  plan: SnapshotPlan,
  targetZipPath: string,
  options: WriteSnapshotOptions = {},
): Promise<void> {
  const zip = new yazl.ZipFile()
  const total = plan.entries.length + 1
  let done = 0
  for (const entry of plan.entries) {
    if (entry.data) zip.addBuffer(entry.data, entry.rel)
    else if (entry.source) zip.addFile(entry.source, entry.rel)
    done += 1
    options.onProgress?.(done, total)
  }
  const meta: SnapshotMeta = {
    format: SNAPSHOT_FORMAT_VERSION,
    platform: process.platform,
    exportedAt: new Date().toISOString(),
    links: plan.links,
    excluded: plan.excluded,
    warnings: plan.warnings,
  }
  zip.addBuffer(Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'), SNAPSHOT_META_FILENAME)
  options.onProgress?.(total, total)
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(targetZipPath)
    output.on('error', reject)
    output.on('close', resolve)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output)
    zip.end()
  })
}

export interface SnapshotInspection {
  meta: SnapshotMeta | null
  /** 包内 profile 目录名（源包 id）。 */
  profileId: string | null
  dshVersion: string | null
  fileCount: number
  unpackedBytes: number
}

/** 判断一个已打开的 zip 是否是快照包：根下有 settings.yaml / 元数据 / profiles/<id>/<file>。 */
export function looksLikeSnapshot(entries: ReadonlyArray<{ entryName: string; isDirectory: boolean }>): boolean {
  for (const entry of entries) {
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    if (safe === 'settings.yaml' || safe === SNAPSHOT_META_FILENAME) return true
    if (safe.startsWith('profiles/') && safe.split('/').length >= 3) return true
  }
  return false
}

/** 读快照包头部：元数据 + 源包 id + DSH 版本（只读少量条目，不解压整包）。 */
export async function inspectSnapshotZip(handle: OpenZipPath): Promise<SnapshotInspection> {
  let meta: SnapshotMeta | null = null
  let profileId: string | null = null
  let dshVersion: string | null = null
  let fileCount = 0
  let unpackedBytes = 0
  for (const entry of handle.entries) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    fileCount += 1
    unpackedBytes += entry.declaredSize || 0
    if (safe === SNAPSHOT_META_FILENAME) {
      const data = await handle.readEntryData(entry, 4 * 1024 * 1024)
      try {
        meta = JSON.parse(data.toString('utf8')) as SnapshotMeta
      } catch {
        meta = null
      }
      continue
    }
    const segments = safe.split('/')
    // profiles/<id>/profile.yaml 才是一个整合包 Profile 的标志：
    // 家目录里还有 workspace 级的 profiles/node_modules，不能把它当包。
    if (segments[0] !== 'profiles' || segments.length !== 3 || segments[2] !== 'profile.yaml') continue
    if (segments[1] === 'node_modules') continue
    const data = await handle.readEntryData(entry, 256 * 1024)
    const text = data.toString('utf8')
    const name = readYamlField(text, 'name')
    if (profileId === null) profileId = name || segments[1]
    const version = readYamlField(text, 'dshVersion')
    if (version) dshVersion = version
  }
  return { meta, profileId, dshVersion, fileCount, unpackedBytes }
}

function readYamlField(text: string, field: string): string | null {
  const match = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm').exec(text)
  if (!match) return null
  const value = match[1].trim().replace(/^['"]|['"]$/g, '')
  return value || null
}

export interface SnapshotDescription extends SnapshotInspection {
  /** profile package.json 里的非核心依赖（= 包内插件）。 */
  pluginNames: string[]
  description: string
}

/** 预览用：判断并读取快照包（不解压整包）；不是快照包时返回 null。 */
export async function describeSnapshotZip(zipPath: string): Promise<SnapshotDescription | null> {
  const handle = await openZipPathFromFile(zipPath, SNAPSHOT_ZIP_LIMITS)
  try {
    if (!looksLikeSnapshot(handle.entries)) return null
    const inspection = await inspectSnapshotZip(handle)
    const pluginNames = await readSnapshotPluginNames(handle, inspection.profileId)
    const sizeMb = Math.round(inspection.unpackedBytes / (1024 * 1024))
    return {
      ...inspection,
      pluginNames,
      description: `快照整合包：${inspection.fileCount} 个文件，解压约 ${sizeMb}MB。`,
    }
  } finally {
    await handle.close()
  }
}

async function readSnapshotPluginNames(handle: OpenZipPath, profileId: string | null): Promise<string[]> {
  if (!profileId) return []
  const target = `profiles/${profileId}/package.json`
  for (const entry of handle.entries) {
    if (entry.isDirectory) continue
    if (safeArchivePath(entry.entryName) !== target) continue
    const data = await handle.readEntryData(entry, 4 * 1024 * 1024)
    try {
      const parsed = JSON.parse(data.toString('utf8')) as { dependencies?: Record<string, unknown> }
      return Object.keys(parsed.dependencies ?? {}).filter(name => !name.startsWith('@deepseek-ai/dsh-'))
    } catch {
      return []
    }
  }
  return []
}

export interface ExtractSnapshotOptions {
  /** 新包 id：包内 profiles/<源id> 整体映射到 profiles/<新id>。 */
  newId: string
  onProgress?: (done: number, total: number) => void
}

export interface ExtractSnapshotResult {
  profileId: string
  links: number
  skipped: number
  longPaths: string[]
}

/**
 * 解压快照到家目录：流式写盘、zip-slip 校验、profile 目录改名、重建符号链接。
 * 不做任何联网/安装动作——node_modules 随包而来，解开即用。
 */
export async function extractSnapshot(
  zipPath: string,
  home: string,
  options: ExtractSnapshotOptions,
): Promise<ExtractSnapshotResult> {
  const handle = await openZipPathFromFile(zipPath, SNAPSHOT_ZIP_LIMITS)
  const longPaths: string[] = []
  let links = 0
  let skipped = 0
  try {
    const inspection = await inspectSnapshotZip(handle)
    const sourceProfileId = inspection.profileId
    if (!sourceProfileId) throw new Error('快照包内没有找到 profiles/<整合包> 目录。')
    const total = handle.entries.length
    let done = 0
    for (const entry of handle.entries) {
      done += 1
      options.onProgress?.(done, total)
      if (entry.isDirectory) continue
      const safe = safeArchivePath(entry.entryName)
      if (!safe || safe === SNAPSHOT_META_FILENAME || isSnapshotExcluded(safe)) {
        // 别人造的包也要挡：按同一份剔除清单兜底。
        skipped += 1
        continue
      }
      const mapped = mapSnapshotPath(safe, sourceProfileId, options.newId)
      const target = path.join(home, ...mapped.split('/'))
      assertInside(home, target)
      if (target.length > SNAPSHOT_MAX_PATH_LENGTH) {
        if (longPaths.length < 50) longPaths.push(mapped)
        continue
      }
      await handle.writeEntryToFile(entry, nativePath(target), { maxEntryBytes: SNAPSHOT_ZIP_LIMITS.maxUnpackedBytes })
    }
    for (const link of inspection.meta?.links ?? []) {
      const safeLink = safeArchivePath(link.path)
      if (!safeLink || isSnapshotExcluded(safeLink)) continue
      const mapped = mapSnapshotPath(safeLink, sourceProfileId, options.newId)
      const linkPath = path.join(home, ...mapped.split('/'))
      assertInside(home, linkPath)
      if (linkPath.length > SNAPSHOT_MAX_PATH_LENGTH) continue
      const targetAbsolute = path.resolve(path.dirname(linkPath), link.target)
      if (!existsSync(targetAbsolute)) {
        skipped += 1
        continue
      }
      await mkdir(nativePath(path.dirname(linkPath)), { recursive: true })
      await rm(nativePath(linkPath), { recursive: true, force: true }).catch(() => undefined)
      try {
        await symlink(targetAbsolute, nativePath(linkPath), 'junction')
        links += 1
      } catch {
        // 建链接失败（权限/文件系统）就退化成实体副本，保证包仍可启动。
        try {
          await cp(nativePath(targetAbsolute), nativePath(linkPath), { recursive: true })
          links += 1
        } catch {
          skipped += 1
        }
      }
    }
    await finalizeExtractedProfile(home, options.newId)
    return { profileId: options.newId, links, skipped, longPaths }
  } finally {
    await handle.close()
  }
}

/** 包内路径映射：profiles/<源id>/… → profiles/<新id>/…，其余原样。 */
export function mapSnapshotPath(rel: string, sourceId: string, newId: string): string {
  if (sourceId === newId) return rel
  if (rel === `profiles/${sourceId}`) return `profiles/${newId}`
  const prefix = `profiles/${sourceId}/`
  if (rel.startsWith(prefix)) return `profiles/${newId}/${rel.slice(prefix.length)}`
  return rel
}

/** 解压后修正包内自带 id 的字段（profile.yaml.name / package.json.name）。 */
async function finalizeExtractedProfile(home: string, newId: string): Promise<void> {
  const profileDir = path.join(home, 'profiles', newId)
  const profileYaml = path.join(profileDir, 'profile.yaml')
  const profileText = await readFile(profileYaml, 'utf8').catch(() => null)
  if (profileText !== null) await writeFile(profileYaml, sanitizeProfileYaml(profileText, newId), 'utf8')
  const packageJson = path.join(profileDir, 'package.json')
  const packageText = await readFile(packageJson, 'utf8').catch(() => null)
  if (packageText === null) return
  try {
    const parsed = JSON.parse(packageText) as { name?: unknown }
    parsed.name = `dsh-pack-${newId}`
    await writeFile(packageJson, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  } catch {
    // 坏 JSON 留给启动诊断去报。
  }
}
