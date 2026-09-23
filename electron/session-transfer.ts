// 会话记录跨包搬运：把源包的会话历史复制进目标包。
//
// 边界（见 docs/adr/0003、docs/adr/0004）：
//   带   sessions/<项目键>/<会话 id>/**、dsh-session-archive/**、attachments/**
//   不带 storages/workspace.json（DSH 扫 sessions/ 自建，写它只会破坏用户已有的清单）、
//        storages/session_projcache*（可重建缓存，搬过去反而是脏的）、
//        API 配置与预设/插件（会话里引用的名字若目标包没有，只提示、不自动装）。
//
// 三条上游硬规则决定了"哪些会话不能直接拷"：
//   1. 会话头的 cwd 必须解析到真实存在的目录，否则 DSH 扫到也静默不显示（indexHeader 的 invalidSessionPaths）；
//   2. 项目目录里直接躺着平铺日志会让 DSH 启动抛 legacyLayout；
//   3. 会话头版本超出目标 DSH 的迁移链会让目标包启动时抛错。
// 所以这里是"逐条判定 + 跳过并报原因"，而不是整目录 cp -r。

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { decodeZstdFrames } from './dsh-usage'

/** 会话日志名：0 世代是 session.jsonl，之后 session.vN.jsonl，都可能再带 .zstd。 */
const SESSION_LOG_PATTERN = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/** 除 sessions/ 之外随会话一并合并的包内目录（按内容寻址，天然去重）。 */
const EXTRA_RECORD_DIRECTORIES = ['dsh-session-archive', 'attachments'] as const

export type SessionSkipReason =
  | 'no-logs'
  | 'unreadable-header'
  | 'legacy-layout'
  | 'missing-cwd'
  | 'already-present'
  | 'newer-format'

/** 结果屏上给人看的说法，一条一个短句。 */
export const SESSION_SKIP_LABELS: Record<SessionSkipReason, string> = {
  'no-logs': '目录里没有会话日志',
  'unreadable-header': '读不出会话头，不敢拷',
  'legacy-layout': '这个项目还是旧版平铺布局，拷过去会让目标包启动报错',
  'missing-cwd': '会话对应的工作目录已经不在了，DSH 不会显示它',
  'already-present': '目标包里已经有同一条会话',
  'newer-format': '记录格式比目标包的 DSH 版本更新，读不了',
}

export interface SessionLogShape {
  generation: number
  compressed: boolean
  bytes: number
}

export interface SessionEntry {
  /** 会话目录名（`session-<uuid>`；子代理是裸 uuid）。 */
  id: string
  /** 由绝对 cwd 派生的项目目录名。 */
  projectKey: string
  /** 会话头里记的工作目录；null 表示头读不出来。 */
  cwd: string | null
  /** 会话头的 format 版本号；null 表示读不出来。 */
  formatVersion: number | null
  logs: SessionLogShape[]
  bytes: number
  skip: SessionSkipReason | null
}

export interface SessionTransferPlan {
  sourceHome: string
  targetHome: string
  entries: SessionEntry[]
  importableCount: number
  importableBytes: number
  /** 被跳过的会话按原因归组，预览与结果屏都用它。 */
  skipped: Array<{ reason: SessionSkipReason; count: number }>
  /** 目标包一条可比会话都没有时版本门只能放行，要如实标出来。 */
  formatUnverified: boolean
  /** 随会话合并的归档与附件字节数。 */
  extraBytes: number
}

function logFileName(log: SessionLogShape): string {
  return `session${log.generation === 0 ? '' : `.v${log.generation}`}.jsonl${log.compressed ? '.zstd' : ''}`
}

/** 只解第一行；不是合法 JSON 就当读不到（宁可判不可用，也不要拷进去再炸）。 */
async function readSessionHeader(logPath: string): Promise<{ cwd?: unknown; version?: unknown } | null> {
  const buffer = await readFile(logPath).catch(() => null)
  if (buffer === null) return null
  const text = logPath.endsWith('.zstd') ? decodeZstdFrames(buffer) : buffer.toString('utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      return JSON.parse(trimmed) as { cwd?: unknown; version?: unknown }
    } catch {
      return null
    }
  }
  return null
}

/** 读一个会话目录：只认会话日志，其它名字（`session.v3.meta.json` 之类）一律忽略。 */
async function readSessionDirectory(dshHome: string, projectKey: string, sessionId: string): Promise<SessionEntry> {
  const directory = path.join(dshHome, 'sessions', projectKey, sessionId)
  const logs: SessionLogShape[] = []
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const match = SESSION_LOG_PATTERN.exec(name)
    if (!match) continue
    const info = await stat(path.join(directory, name)).catch(() => null)
    if (!info?.isFile()) continue
    logs.push({ generation: match[1] ? Number(match[1]) : 0, compressed: Boolean(match[2]), bytes: info.size })
  }
  const entry: SessionEntry = {
    id: sessionId,
    projectKey,
    cwd: null,
    formatVersion: null,
    logs,
    bytes: logs.reduce((total, log) => total + log.bytes, 0),
    skip: logs.length === 0 ? 'no-logs' : null,
  }
  if (entry.skip === null) {
    // 世代最高的那份是当前在写的，会话头就在它第一行。
    const newest = [...logs].sort((a, b) => b.generation - a.generation)[0]!
    const header = await readSessionHeader(path.join(directory, logFileName(newest)))
    if (header) {
      entry.cwd = typeof header.cwd === 'string' ? header.cwd : null
      entry.formatVersion = typeof header.version === 'number' ? header.version : null
    } else {
      entry.skip = 'unreadable-header'
    }
  }
  return entry
}

/** 会话头里的 cwd 还在不在。DSH 自己要求它能解析成目录，否则等于导过去也看不见。 */
async function cwdExists(cwd: string | null): Promise<boolean> {
  if (!cwd) return false
  return Boolean(await stat(cwd).then(info => info.isDirectory()).catch(() => false))
}

/**
 * 版本号门：拿目标包里已有会话的头版本当参照。
 * 目标包一条会话都没有时没有可比对象，只能放行并标 unverified——不做假装判定。
 */
export function classifySessionFormat(entryVersion: number | null, targetVersions: number[]): 'allow' | 'newer-format' | 'unverified' {
  if (entryVersion === null) return 'newer-format'
  if (targetVersions.length === 0) return 'unverified'
  return entryVersion > Math.max(...targetVersions) ? 'newer-format' : 'allow'
}

/** 列出包里全部会话；平铺布局的整个项目按 legacy-layout 跳过。 */
export async function listSessionEntries(dshHome: string): Promise<SessionEntry[]> {
  const root = path.join(dshHome, 'sessions')
  const entries: SessionEntry[] = []
  for (const projectKey of await readdir(root).catch(() => [] as string[])) {
    const projectDirectory = path.join(root, projectKey)
    const names = await readdir(projectDirectory).catch(() => [] as string[])
    if (names.some(name => SESSION_LOG_PATTERN.test(name))) {
      // 项目目录里直接躺着日志 = 旧版平铺布局，DSH 读到就抛；整项目不碰。
      for (const name of names) {
        if (!await stat(path.join(projectDirectory, name)).then(info => info.isDirectory()).catch(() => false)) continue
        const entry = await readSessionDirectory(dshHome, projectKey, name)
        entry.skip = 'legacy-layout'
        entries.push(entry)
      }
      continue
    }
    for (const name of names) {
      if (!await stat(path.join(projectDirectory, name)).then(info => info.isDirectory()).catch(() => false)) continue
      entries.push(await readSessionDirectory(dshHome, projectKey, name))
    }
  }
  return entries
}

async function directoryBytes(root: string): Promise<number> {
  if (!await stat(root).then(info => info.isDirectory()).catch(() => false)) return 0
  let total = 0
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name)
      if (item.isDirectory()) await walk(full)
      else total += (await stat(full).catch(() => null))?.size ?? 0
    }
  }
  await walk(root)
  return total
}

/** 出计划：预览屏要的信息都在这里，不做任何写入。 */
export async function planSessionTransfer(sourceHome: string, targetHome: string): Promise<SessionTransferPlan> {
  const sourceEntries = await listSessionEntries(sourceHome)
  const targetEntries = await listSessionEntries(targetHome)
  const targetVersions = targetEntries.map(entry => entry.formatVersion).filter((value): value is number => value !== null)
  const targetPaths = new Set(targetEntries.map(entry => `${entry.projectKey}/${entry.id}`))
  let formatUnverified = false

  for (const entry of sourceEntries) {
    if (entry.skip) continue
    if (targetPaths.has(`${entry.projectKey}/${entry.id}`)) {
      entry.skip = 'already-present'
      continue
    }
    if (!await cwdExists(entry.cwd)) {
      entry.skip = 'missing-cwd'
      continue
    }
    const verdict = classifySessionFormat(entry.formatVersion, targetVersions)
    if (verdict === 'newer-format') entry.skip = 'newer-format'
    else if (verdict === 'unverified') formatUnverified = true
  }

  const kept = sourceEntries.filter(entry => entry.skip === null)
  const grouped = new Map<SessionSkipReason, number>()
  for (const entry of sourceEntries) {
    if (entry.skip) grouped.set(entry.skip, (grouped.get(entry.skip) ?? 0) + 1)
  }
  let extraBytes = 0
  for (const directory of EXTRA_RECORD_DIRECTORIES) {
    extraBytes += await directoryBytes(path.join(sourceHome, directory))
  }

  return {
    sourceHome,
    targetHome,
    entries: sourceEntries,
    importableCount: kept.length,
    importableBytes: kept.reduce((total, entry) => total + entry.bytes, 0),
    skipped: [...grouped].map(([reason, count]) => ({ reason, count })),
    formatUnverified,
    extraBytes,
  }
}

/** 复制过程中落盘的清单，撤销全靠它。 */
export interface TransferManifest {
  version: 1
  targetHome: string
  createdAt: string
  files: Array<{ relative: string; bytes: number; mtimeMs: number }>
}

export interface TransferProgress {
  files: number
  bytes: number
}

/**
 * 把计划内的东西复制进目标包。
 *
 * 只新增、遇到同路径就跳过，绝不覆盖目标包已有文件——因此撤销可以是
 * "按清单删掉我们建的那些"，不必事先整目录快照几百 MB。
 */
export async function applySessionTransfer(
  plan: SessionTransferPlan,
  options: { onProgress?: (progress: TransferProgress) => void; manifest?: TransferManifest } = {},
): Promise<TransferManifest> {
  const manifest: TransferManifest = options.manifest ?? { version: 1, targetHome: plan.targetHome, createdAt: new Date().toISOString(), files: [] }
  const progress: TransferProgress = { files: 0, bytes: 0 }
  for (const entry of plan.entries.filter(item => item.skip === null)) {
    const relative = path.join('sessions', entry.projectKey, entry.id)
    await copyFileTree(path.join(plan.sourceHome, relative), path.join(plan.targetHome, relative), manifest, progress, options.onProgress)
  }
  for (const directory of EXTRA_RECORD_DIRECTORIES) {
    await copyFileTree(path.join(plan.sourceHome, directory), path.join(plan.targetHome, directory), manifest, progress, options.onProgress)
  }
  return manifest
}

/** 逐文件复制（要记清单）；目标已有同路径就跳过。 */
async function copyFileTree(
  sourceDirectory: string,
  targetDirectory: string,
  manifest: TransferManifest,
  progress: TransferProgress,
  onProgress: ((progress: TransferProgress) => void) | undefined,
): Promise<void> {
  if (!await stat(sourceDirectory).then(info => info.isDirectory()).catch(() => false)) return
  const stack: Array<{ from: string; to: string }> = [{ from: sourceDirectory, to: targetDirectory }]
  while (stack.length > 0) {
    const current = stack.pop()!
    await mkdir(current.to, { recursive: true })
    for (const item of await readdir(current.from, { withFileTypes: true })) {
      const from = path.join(current.from, item.name)
      const to = path.join(current.to, item.name)
      if (item.isDirectory()) {
        stack.push({ from, to })
        continue
      }
      if (!await stat(from).then(info => info.isFile()).catch(() => false)) continue
      if (await stat(to).then(target => target.isFile()).catch(() => false)) continue
      await pipeline(createReadStream(from), createWriteStream(to, { flags: 'wx' }))
      // 清单记的是目标文件自己的大小与时间：撤销时比的是它，不是源文件（拷过去 mtime 就变了）。
      const written = await stat(to).catch(() => null)
      if (!written) continue
      manifest.files.push({ relative: path.relative(manifest.targetHome, to), bytes: written.size, mtimeMs: written.mtimeMs })
      progress.files += 1
      progress.bytes += written.size
      onProgress?.(progress)
    }
  }
}

/** 把清单写盘，供「撤销这次导入」使用。 */
export async function writeTransferManifest(manifestPath: string, manifest: TransferManifest): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * 按清单撤销：只删"我们建的、且之后没人动过"的文件。
 * 目标包可能已经在用这些会话（DSH 往日志里追加过），那种情况保留文件并如实报数——
 * 不能假装回到了导入前，否则用户以为今天的对话还在，其实被删了。
 */
export async function undoSessionTransfer(manifest: TransferManifest): Promise<{ removed: number; kept: number; error?: string }> {
  if (!await stat(manifest.targetHome).then(info => info.isDirectory()).catch(() => false)) {
    return { removed: 0, kept: manifest.files.length, error: '目标包目录已经不在了，没有可撤销的内容' }
  }
  let removed = 0
  let kept = 0
  const createdDirectories: string[] = []
  for (const file of manifest.files) {
    const target = path.join(manifest.targetHome, file.relative)
    const info = await stat(target).catch(() => null)
    if (!info) continue
    if (info.size === file.bytes && Math.abs(info.mtimeMs - file.mtimeMs) < 1) {
      await rm(target, { force: true })
      createdDirectories.push(path.dirname(target))
      removed += 1
    } else {
      kept += 1
    }
  }
  // 由深到浅收掉空目录，不留 sessions/<项目键>/ 这种空壳。
  for (const directory of [...new Set(createdDirectories)].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
    let current = directory
    while (current.startsWith(manifest.targetHome + path.sep)) {
      const leftovers = await readdir(current).catch(() => null)
      if (leftovers === null || leftovers.length > 0) break
      await rm(current, { recursive: true, force: true }).catch(() => undefined)
      current = path.dirname(current)
    }
  }
  return { removed, kept }
}

export interface DanglingReferences {
  presets: string[]
  plugins: string[]
}

/**
 * 会话里引用了、目标包里不存在的项目与插件。
 *
 * 只判这两类是有原因的：预设看目标包 `.agent-presets` 下有没有同名项、插件看
 * `profiles` 里各包的 `node_modules` 有没有装过，都能一次 readdir 精确核对；
 * 供应商写在 settings.yaml 里，结构没核实过，宁可不报也不瞎报。
 */
export async function findDanglingReferences(plan: SessionTransferPlan, targetHome: string): Promise<DanglingReferences> {
  const presets = new Set<string>()
  const plugins = new Set<string>()
  for (const entry of plan.entries.filter(item => item.skip === null)) {
    for (const log of entry.logs) {
      const raw = await readFile(path.join(plan.sourceHome, 'sessions', entry.projectKey, entry.id, logFileName(log))).catch(() => null)
      if (raw === null) continue
      const text = log.compressed ? decodeZstdFrames(raw) : raw.toString('utf8')
      for (const line of text.split('\n')) {
        const preset = /"agentPreset":"([^"]+)"/.exec(line)?.[1]
        if (preset) presets.add(preset)
        const plugin = /"plugin":"([^"]+)"/.exec(line)?.[1]
        if (plugin) plugins.add(plugin)
      }
    }
  }
  const knownPresets = new Set((await readdir(path.join(targetHome, '.agent-presets')).catch(() => [] as string[]))
    .map(name => name.replace(/\.(ya?ml|json)$/i, '')))
  const knownPlugins = new Set<string>()
  for (const profile of await readdir(path.join(targetHome, 'profiles')).catch(() => [] as string[])) {
    for (const name of await readdir(path.join(targetHome, 'profiles', profile, 'node_modules')).catch(() => [] as string[])) {
      if (name.startsWith('.') || name.startsWith('@')) continue
      knownPlugins.add(name)
    }
  }
  return {
    presets: [...presets].filter(name => !knownPresets.has(name)).sort(),
    plugins: [...plugins].filter(name => !knownPlugins.has(name)).sort(),
  }
}
