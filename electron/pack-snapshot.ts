import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import yazl from 'yazl'
import { assertInside, openZipPathFromFile, safeArchivePath, type OpenZipPath } from './pack-zip'
import { profileManifestName } from './profile-service'
import { writeZipArchive, ZIP64_CONTENT_THRESHOLD_BYTES, type ZipEntryInput } from './zip-writer'

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
  /**
   * 这次导出被显式放行的隐私类别（缺省=全脱敏）。写进元数据是为了让导入端按同一份
   * 清单放行——否则导出的隐私条目会在解压时被同一道黑名单再剔一遍，等于白导。
   */
  private?: SnapshotPrivacyCategory[]
}

/**
 * 导出时可勾选带出的隐私类别（见 docs/adr/0001）。
 * 默认都不带：那份黑名单是「导出件可以放心发给别人」的唯一保证。
 */
export type SnapshotPrivacyCategory = 'credentials' | 'sessions'

export interface SnapshotPrivacyInclude {
  credentials?: boolean
  sessions?: boolean
}

/** 每个类别对应家目录里的哪些顶层条目。settings.yaml 的密钥另算（见 scrubSecrets）。 */
const PRIVACY_TOP_LEVEL: Record<SnapshotPrivacyCategory, ReadonlySet<string>> = {
  credentials: new Set(['.credentials.yaml']),
  // 登记表 storages/ 不在这里：DSH 扫 sessions/ 会自建，投影缓存搬过去反而是脏的。
  sessions: new Set(['sessions', 'dsh-session-archive', 'attachments']),
}

export function privacyIncludeFromList(list: SnapshotPrivacyCategory[] | undefined): SnapshotPrivacyInclude {
  return { credentials: list?.includes('credentials'), sessions: list?.includes('sessions') }
}

export function privacyListFromInclude(include: SnapshotPrivacyInclude): SnapshotPrivacyCategory[] {
  const out: SnapshotPrivacyCategory[] = []
  if (include.credentials) out.push('credentials')
  if (include.sessions) out.push('sessions')
  return out
}

export interface SnapshotPlanEntry {
  /** zip 内相对路径（正斜杠）。 */
  rel: string
  /** 源文件绝对路径；与 `data` 二选一。 */
  source?: string
  /** 源文件字节数（用于进度总量）。 */
  size?: number
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
  /** 这次导出被放行的隐私类别，随元数据一起写进包里。 */
  privacy?: SnapshotPrivacyCategory[]
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
  'pet.json',
  '.dsh-module-fallback',
  '.skill-staging',
  '.preset-staging',
  '.pack-offline-import',
])

const EXCLUDED_TOP_LEVEL_PREFIXES = ['.pack-raw-staging-', '.pack-raw-preset-staging-', '.pack-offline-import-']
/** 任何层级出现即剔除的目录（DSH 自建缓存/临时目录，含绝对路径或纯临时数据）。 */
const EXCLUDED_ANYWHERE = new Set(['.dsh-module-fallback', '.skill-staging', '.preset-staging', '.pack-offline-import'])
/** 具体路径前缀（相对家目录）：装的是本地凭据或平台令牌缓存，随包公开会泄露机主身份。 */
const EXCLUDED_PATH_PREFIXES = ['skin-center/wallpapers/.cache']
/** pnpm 自己的元数据：含源机 store 绝对路径；导入端不跑 pnpm，交给它以后重建。 */
const EXCLUDED_PROFILE_FILES = new Set([
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.package-map.json',
])

/** 相对家目录的路径是否不进包（正斜杠、不含前导 ./）。 */
export function isSnapshotExcluded(rel: string, include: SnapshotPrivacyInclude = {}): boolean {
  const segments = rel.split('/')
  const top = segments[0]
  if (EXCLUDED_TOP_LEVEL.has(top)) {
    // 黑名单从"硬剔除"降级成"默认不导出"：只有用户在导出框里勾过的那一类才放行。
    for (const category of Object.keys(PRIVACY_TOP_LEVEL) as SnapshotPrivacyCategory[]) {
      if (include[category] && PRIVACY_TOP_LEVEL[category].has(top)) return false
    }
    return true
  }
  if (EXCLUDED_TOP_LEVEL_PREFIXES.some(prefix => top.startsWith(prefix))) return true
  if (segments.some(segment => EXCLUDED_ANYWHERE.has(segment))) return true
  if (EXCLUDED_PATH_PREFIXES.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) return true
  if (segments.length === 1 && top.toLowerCase().endsWith('.log')) return true
  // profiles/<id>/node_modules 与 profiles/node_modules 下的 pnpm 元数据
  if (segments[0] === 'profiles' && segments.length >= 3) {
    if (EXCLUDED_PROFILE_FILES.has(segments.slice(2).join('/'))) return true
    if (EXCLUDED_PROFILE_FILES.has(segments.slice(1).join('/'))) return true
  }
  return false
}

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passwd|credential)/i

/**
 * settings.yaml 字段级过滤：去掉 onboarding 与疑似密钥键，保留插件/模型/外观配置。
 * `keepSecrets` 只在用户勾了「附带 API 密钥」时为真——onboarding 仍然照删。
 */
export function sanitizeSettingsYaml(text: string, keepSecrets = false): string {
  const document = parseYamlObject(text)
  if (!document) return text
  delete document['ui-onboarding']
  if (!keepSecrets) scrubSecrets(document)
  return stringifyYaml(document, { lineWidth: 0 })
}

function scrubSecrets(node: Record<string, unknown>): void {
  for (const key of Object.keys(node)) {
    // `apiKeyEnv` 只是环境变量名，不是密钥本体，保留；名字像密钥的一律先删，
    // 省得值是列表时（`tokens: [...]`）连键都逃过过滤。
    if (SECRET_KEY_RE.test(key) && !/env$/i.test(key)) {
      delete node[key]
      continue
    }
    const value = node[key]
    if (Array.isArray(value)) {
      // 列表里也藏得住密钥（自定义供应商就是一列对象）：以前只递归普通对象，
      // 于是 `providers: [ { apiKey: ... } ]` 会原样跟着"全脱敏"的包发出去。
      for (const item of value) {
        if (item && typeof item === 'object' && !Array.isArray(item)) scrubSecrets(item as Record<string, unknown>)
      }
      continue
    }
    if (value && typeof value === 'object') scrubSecrets(value as Record<string, unknown>)
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

/**
 * 目录并发度与单次 stat 批量。node_modules 的形态是「海量目录 × 少量文件」，
 * 逐目录、逐文件 await 会把几万次系统调用串成一条链：真机 16490 个文件的包，
 * 串行 stat 1.10s、32 并发 0.37s（scripts/perf-pack-bench.mts 实测）。
 */
const SCAN_DIRECTORY_CONCURRENCY = 8
const SCAN_STAT_BATCH = 64

/** 家目录遍历：目录队列 + 文件 stat 批量并发；符号链接只登记，不实体化。 */
async function walk(home: string, root: string, plan: SnapshotPlan, include: SnapshotPrivacyInclude): Promise<void> {
  const queue: string[] = [root]
  let cursor = 0
  const drain = async (): Promise<void> => {
    while (cursor < queue.length) {
      const current = queue[cursor++]!
      let dirents
      try {
        dirents = await readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      const files: Array<{ full: string; rel: string }> = []
      const links: Array<{ full: string; rel: string }> = []
      for (const dirent of dirents) {
        const full = path.join(current, dirent.name)
        const rel = toPosix(path.relative(home, full))
        if (isSnapshotExcluded(rel, include)) {
          if (plan.excluded.length < 200) plan.excluded.push(rel)
          continue
        }
        if (dirent.isSymbolicLink()) {
          links.push({ full, rel })
          continue
        }
        if (dirent.isDirectory()) {
          queue.push(full)
          continue
        }
        if (dirent.isFile()) files.push({ full, rel })
      }
      for (let i = 0; i < files.length; i += SCAN_STAT_BATCH) {
        const batch = files.slice(i, i + SCAN_STAT_BATCH)
        const infos = await Promise.all(batch.map(file => lstat(file.full).catch(() => null)))
        batch.forEach((file, index) => {
          const info = infos[index]
          if (!info) return
          if (file.rel.length > SNAPSHOT_WARN_PATH_LENGTH && plan.longPaths.length < 50) plan.longPaths.push(file.rel)
          plan.entries.push({ rel: file.rel, source: file.full, size: info.size })
        })
      }
      for (let i = 0; i < links.length; i += SCAN_STAT_BATCH) {
        const batch = links.slice(i, i + SCAN_STAT_BATCH)
        const resolved = await Promise.all(batch.map(link => resolveLink(home, link.full, link.rel)))
        for (const link of resolved) if (link) plan.links.push(link)
      }
    }
  }
  await Promise.all(Array.from({ length: SCAN_DIRECTORY_CONCURRENCY }, () => drain()))
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
export async function planSnapshot(home: string, options: { packId: string; include?: SnapshotPrivacyInclude }): Promise<SnapshotPlan> {
  const plan: SnapshotPlan = { entries: [], links: [], excluded: [], warnings: [], longPaths: [], totalBytes: 0 }
  await walk(home, home, plan, options.include ?? {})
  await rewriteEntries(home, options.packId, plan, options.include ?? {})
  plan.privacy = privacyListFromInclude(options.include ?? {})
  return plan
}

async function rewriteEntries(home: string, packId: string, plan: SnapshotPlan, include: SnapshotPrivacyInclude): Promise<void> {
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

  await rewriteText('settings.yaml', text => sanitizeSettingsYaml(text, Boolean(include.credentials)))
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
  // 按最终条目重算总量：被丢弃的条目（如含绝对路径的 lockfile）不能算进进度分母。
  plan.totalBytes = plan.entries.reduce((sum, entry) => sum + (entry.data?.length ?? entry.size ?? 0), 0)
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
      plan.entries.push({ rel: bodyRel, source: resolved.sourcePath, size: resolved.size })
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
): Promise<{ sourcePath: string; isFile: boolean; size: number } | null> {
  const candidates = [
    path.isAbsolute(rawTarget) ? rawTarget : path.resolve(profileDir, rawTarget),
    path.join(profileDir, 'node_modules', ...packageName.split('/')),
  ]
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null)
    if (!info) continue
    if (info.isDirectory() || (info.isFile() && candidate.toLowerCase().endsWith('.tgz'))) {
      return { sourcePath: candidate, isFile: info.isFile(), size: info.size }
    }
  }
  return null
}

/** 把一个目录树加进快照计划（返回加入的文件数）。插件本体可能很大，走实体文件。 */
async function collectDirectory(sourceDir: string, targetRel: string, plan: SnapshotPlan): Promise<number> {
  let added = 0
  const stack: Array<{ dir: string; rel: string }> = [{ dir: sourceDir, rel: targetRel }]
  while (stack.length > 0) {
    const current = stack.pop()!
    const dirents = await readdir(current.dir, { withFileTypes: true }).catch(() => [])
    const files: Array<{ full: string; rel: string }> = []
    for (const dirent of dirents) {
      const full = path.join(current.dir, dirent.name)
      const rel = `${current.rel}/${dirent.name}`
      if (dirent.isDirectory()) {
        stack.push({ dir: full, rel })
        continue
      }
      if (dirent.isFile()) files.push({ full, rel })
    }
    for (let i = 0; i < files.length; i += SCAN_STAT_BATCH) {
      const batch = files.slice(i, i + SCAN_STAT_BATCH)
      const infos = await Promise.all(batch.map(file => lstat(file.full).catch(() => null)))
      batch.forEach((file, index) => {
        const info = infos[index]
        if (!info) return
        plan.entries.push({ rel: file.rel, source: file.full, size: info.size })
        added += 1
      })
    }
  }
  return added
}

export interface WriteSnapshotOptions {
  /** 按已读取的原始字节回调（限流：默认最多每 500ms 一次，结束时必报）。 */
  onProgress?: (writtenBytes: number, totalBytes: number) => void
}

/** 压不动的后缀：deflate 对它们只是白烧 CPU，直接 store（压缩方法 0），体积几乎不变。 */
const STORE_ONLY_SUFFIXES = /\.(node|dll|exe|so|dylib|lib|a|pyd|dat|bin|png|jpe?g|gif|webp|avif|ico|bmp|tiff|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|webm|mkv|zip|tgz|gz|bz2|xz|zst|br|7z|jar|pdf|glb|onnx|safetensors)$/i

/** 这么小的条目不值得为它建一次 deflate 上下文——整合包里九成文件都小于 1KB。 */
const STORE_BELOW_BYTES = 1024

/** 文本档位。整包都是 node_modules 文本，1 档吞吐约为 6 档的 2.7 倍，体积多 15% 左右。 */
const TEXT_DEFLATE_LEVEL = 1

/**
 * 单个条目的 deflate 档位：`0` = store（不压缩）。
 * 纯函数，导出以便单测锁定「不剔除任何内容、只改压缩方式」这条边界。
 */
export function snapshotCompressionLevel(rel: string, size: number): number {
  if (size < STORE_BELOW_BYTES) return 0
  if (STORE_ONLY_SUFFIXES.test(rel)) return 0
  return TEXT_DEFLATE_LEVEL
}

function snapshotMetaBuffer(plan: SnapshotPlan): Buffer {
  const meta: SnapshotMeta = {
    format: SNAPSHOT_FORMAT_VERSION,
    platform: process.platform,
    exportedAt: new Date().toISOString(),
    links: plan.links,
    excluded: plan.excluded,
    warnings: plan.warnings,
    ...(plan.privacy && plan.privacy.length > 0 ? { private: plan.privacy } : {}),
  }
  return Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

/** 把扫描好的计划条目换成写入器认识的形态（含压缩档位；缺 size 的少数条目补一次 stat）。 */
async function zipEntriesFromPlan(plan: SnapshotPlan, meta: Buffer): Promise<ZipEntryInput[]> {
  const entries: ZipEntryInput[] = []
  for (const entry of plan.entries) {
    if (entry.data) {
      entries.push({ name: entry.rel, data: entry.data, level: snapshotCompressionLevel(entry.rel, entry.data.length) })
      continue
    }
    if (!entry.source) continue
    // 字节数在扫描阶段就记进 plan 了：这里再 stat 一遍是真机 16490 个文件白跑 1.1s。
    const size = entry.size ?? (await stat(entry.source).catch(() => null))?.size
    if (size === undefined) continue
    entries.push({ name: entry.rel, source: entry.source, size, level: snapshotCompressionLevel(entry.rel, size) })
  }
  entries.push({ name: SNAPSHOT_META_FILENAME, data: meta, level: snapshotCompressionLevel(SNAPSHOT_META_FILENAME, meta.length) })
  return entries
}

/**
 * 打包 worker 脚本的位置：构建产物里是同目录 .js，源码态（vite-node / vitest）是同目录 .ts。
 * 找不到就返回 null，由调用方退回进程内打包。
 */
function resolveSnapshotWorkerScript(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of ['snapshot-pack-worker.js', 'snapshot-pack-worker.mjs', 'snapshot-pack-worker.ts']) {
    const target = path.join(here, candidate)
    if (existsSync(target)) return target
  }
  return null
}

/** 在 worker 里打包。worker 报的是累计字节数，所以调用方要覆盖而不是累加。 */
async function writeSnapshotZipInWorker(
  scriptPath: string,
  entries: ZipEntryInput[],
  targetZipPath: string,
  onReadBytes: (cumulativeBytes: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(scriptPath, { workerData: { targetZipPath, entries } })
    let settled = false
    const stop = (error?: Error): void => {
      if (settled) return
      settled = true
      worker.terminate().catch(() => undefined)
      if (error) reject(error)
      else resolve()
    }
    worker.on('message', (message: { type?: string; readBytes?: number; message?: string }) => {
      if (message?.type === 'bytes') {
        onReadBytes(Number(message.readBytes) || 0)
        return
      }
      if (message?.type === 'done') stop()
      else if (message?.type === 'error') stop(new Error(message.message ?? '打包失败。'))
    })
    worker.on('error', error => stop(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => stop(code === 0 ? undefined : new Error(`打包 worker 退出码 ${code}。`)))
  })
}

/**
 * 把快照计划写成 zip。进度按真实读取的未压缩字节数上报。
 * 内容总量逼近 4GB 时本模块的写入器字段会撑破 uint32，那种包退回 yazl（它带 zip64）。
 */
export async function writeSnapshotZip(
  plan: SnapshotPlan,
  targetZipPath: string,
  options: WriteSnapshotOptions = {},
): Promise<void> {
  const meta = snapshotMetaBuffer(plan)
  // 进度分母要含元数据条目，否则收尾会报出「比总量还多」的字节数。
  const totalBytes = (plan.totalBytes || plan.entries.reduce((sum, entry) => sum + (entry.data?.length ?? entry.size ?? 0), 0)) + meta.length
  let written = 0
  let lastReportAt = 0
  const report = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastReportAt < 500) return
    lastReportAt = now
    options.onProgress?.(written, totalBytes)
  }
  if (totalBytes > ZIP64_CONTENT_THRESHOLD_BYTES) {
    await writeSnapshotZipWithYazl(plan, targetZipPath, meta, bytes => {
      written += bytes
      report()
    })
    report(true)
    return
  }
  const entries = await zipEntriesFromPlan(plan, meta)
  const workerScript = resolveSnapshotWorkerScript()
  if (workerScript) {
    try {
      await writeSnapshotZipInWorker(workerScript, entries, targetZipPath, bytes => {
        written = bytes
        report()
      })
      report(true)
      return
    } catch {
      // worker 起不来（构建产物缺文件、平台限制）不能让导出陪葬：清零后在进程内重打一遍。
      written = 0
    }
  }
  await writeZipArchive(targetZipPath, entries, {
    onBytes: bytes => {
      written += bytes
      report()
    },
  })
  report(true)
}

/** yazl 兜底路径：只在包内容大到会撑破 uint32 字段时才走。 */
async function writeSnapshotZipWithYazl(
  plan: SnapshotPlan,
  targetZipPath: string,
  meta: Buffer,
  onWritten: (bytes: number) => void,
): Promise<void> {
  const zip = new yazl.ZipFile()
  /**
   * 给一个源文件套上计数流：yazl 的 addFile 不暴露读取进度，而直接监听源流会抢在
   * yazl 之前把数据流干，必须用 Transform 让 yazl 消费它的可读端来统计进度。
   */
  const makeCounterStream = (sourcePath: string): Transform => {
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        onWritten(chunk.length)
        callback(null, chunk)
      },
    })
    const source = createReadStream(sourcePath)
    source.on('error', error => counter.destroy(error instanceof Error ? error : new Error(String(error))))
    source.pipe(counter)
    return counter
  }
  for (const entry of plan.entries) {
    if (entry.data) {
      zip.addBuffer(entry.data, entry.rel, { compressionLevel: snapshotCompressionLevel(entry.rel, entry.data.length) })
      onWritten(entry.data.length)
      continue
    }
    if (!entry.source) continue
    const sourcePath = entry.source
    const size = entry.size ?? (await stat(sourcePath).catch(() => null))?.size
    if (size === undefined) continue
    // 懒创建：yazl 走到这个条目才真的去开文件。一次把上万个条目全挂上读取流的话，
    // 每个都会占一个文件句柄并预读几十 KB（真机 392MB 包实测峰值 RSS 393MB → 318MB）。
    zip.addReadStreamLazy(entry.rel, { size, compressionLevel: snapshotCompressionLevel(entry.rel, size) }, callback => callback(null, makeCounterStream(sourcePath)))
  }
  zip.addBuffer(meta, SNAPSHOT_META_FILENAME)
  onWritten(meta.length)
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
 * 解压并发度。单个 yauzl 句柄一次只能开一条读流，16490 个文件就得一条条串完
 * 「开文件 → inflate → 写 → 关」。真机官方包实测：单句柄 25.3s、4 句柄 19.7s、
 * 8 句柄 15.3s、16 句柄反而回到 19.0s（每多开一个句柄要多解析一遍中央目录），
 * 所以取 8。
 */
const EXTRACT_CONCURRENCY = 8
const EXTRACT_MKDIR_BATCH = 32

interface ExtractWork {
  /** 中央目录里的条目下标（各句柄读到的顺序一致，用它对位）。 */
  index: number
  target: string
  dir: string
}

/** 一个分片：自己开一个 zip 句柄，把分到的条目解出来。 */
async function extractShard(
  zipPath: string,
  shard: ExtractWork[],
  onDone: () => void,
): Promise<void> {
  const handle = await openZipPathFromFile(zipPath, SNAPSHOT_ZIP_LIMITS)
  try {
    for (const item of shard) {
      const entry = handle.entries[item.index]
      if (!entry) continue
      await handle.writeEntryToFile(entry, item.target, {
        maxEntryBytes: SNAPSHOT_ZIP_LIMITS.maxUnpackedBytes,
        skipMkdir: true,
      })
      onDone()
    }
  } finally {
    await handle.close()
  }
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
  const longPaths: string[] = []
  let skipped = 0
  const work: ExtractWork[] = []
  const handle = await openZipPathFromFile(zipPath, SNAPSHOT_ZIP_LIMITS)
  let sourceProfileId: string
  let snapshotLinks: SnapshotLinkEntry[]
  try {
    const inspection = await inspectSnapshotZip(handle)
    const found = inspection.profileId
    if (!found) throw new Error('快照包内没有找到 profiles/<整合包> 目录。')
    sourceProfileId = found
    snapshotLinks = inspection.meta?.links ?? []
    // 包自己声明带了哪些隐私条目，解压时才按同一份清单放行；
    // 没声明（别人的包、旧版本包）就一律照黑名单剔除。
    const include = privacyIncludeFromList(inspection.meta?.private)
    handle.entries.forEach((entry, index) => {
      if (entry.isDirectory) return
      const safe = safeArchivePath(entry.entryName)
      // 别人造的包也要挡：按同一份剔除清单兜底。
      if (!safe || safe === SNAPSHOT_META_FILENAME || isSnapshotExcluded(safe, include)) {
        skipped += 1
        return
      }
      const mapped = mapSnapshotPath(safe, sourceProfileId, options.newId)
      const target = path.join(home, ...mapped.split('/'))
      assertInside(home, target)
      if (target.length > SNAPSHOT_MAX_PATH_LENGTH) {
        if (longPaths.length < 50) longPaths.push(mapped)
        return
      }
      const nativeTarget = nativePath(target)
      work.push({ index, target: nativeTarget, dir: nativePath(path.dirname(nativeTarget)) })
    })
  } finally {
    await handle.close()
  }

  // 目录先去重一次建完：省掉每个条目一次的递归 mkdir（万级条目时这是主要开销之一）。
  const directories = [...new Set(work.map(item => item.dir))]
  for (let i = 0; i < directories.length; i += EXTRACT_MKDIR_BATCH) {
    await Promise.all(directories.slice(i, i + EXTRACT_MKDIR_BATCH).map(dir => mkdir(dir, { recursive: true })))
  }

  const total = work.length
  let done = 0
  const shards: ExtractWork[][] = Array.from({ length: Math.min(EXTRACT_CONCURRENCY, total) || 1 }, () => [])
  work.forEach((item, position) => shards[position % shards.length]!.push(item))
  const onDone = (): void => {
    done += 1
    options.onProgress?.(done, total)
  }
  await Promise.all(shards.map(shard => extractShard(zipPath, shard, onDone)))

  let links = 0
  for (const link of snapshotLinks) {
    const safeLink = safeArchivePath(link.path)
    if (!safeLink || isSnapshotExcluded(safeLink)) continue
    const mapped = mapSnapshotPath(safeLink, sourceProfileId, options.newId)
    const linkPath = path.join(home, ...mapped.split('/'))
    assertInside(home, linkPath)
    if (linkPath.length > SNAPSHOT_MAX_PATH_LENGTH) continue
    const targetAbsolute = path.resolve(path.dirname(linkPath), link.target)
    const targetExists = await lstat(targetAbsolute).then(() => true, () => false)
    if (!targetExists) {
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
    parsed.name = profileManifestName(newId)
    await writeFile(packageJson, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  } catch {
    // 坏 JSON 留给启动诊断去报。
  }
}
