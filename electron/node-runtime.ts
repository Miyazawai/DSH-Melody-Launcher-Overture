import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { formatCommandLine, spawnCommand, trackSpawnedProcess, withExecutableDirectoryOnPath } from './process'
import { npmRegistryCandidates } from './proxy'

export const NODE_RUNTIME_VERSION = 'v24.19.0'
export const PNPM_VERSION = '11.21.0'

/**
 * 允许启动器使用的最低 Node 版本。
 *
 * 取证（2026-09-22，registry 实测）：pnpm@11.21.0 的 `engines.node` 是 `>=22.13`，
 * 这是硬约束——低于它 pnpm 直接以退出码 1 结束，用户看到的就是「DSH 安装失败（代码 1）」。
 * DSH 本体包（@deepseek-ai/dsh@0.1.5-rc.2）与核心组合层（dsh-base / cordis / dsh-acp-app）
 * 都没有声明 `engines`，所以门槛只由 pnpm 决定。升级 PNPM_VERSION 时必须重新核对该值。
 */
export const MIN_NODE_VERSION = '22.13.0'

/** 探测本机 node 的超时：拿不到版本就当不达标，不能因此卡住启动。 */
const NODE_VERSION_PROBE_TIMEOUT_MS = 3_000

/** Node 官方发行包根目录，也是 SHASUMS256.txt 的唯一权威来源。 */
export const NODE_DIST_OFFICIAL_BASE = 'https://nodejs.org/dist'
/**
 * 大陆可用的发行包镜像。顺序按 2026-09-22 本机实测（各取同一段 4MB）：
 * huaweicloud 6.3MB/s、npmmirror 4.4MB/s、nodejs.org 1.7MB/s——两处镜像都比直连官方快 2.5 倍以上。
 * npmmirror 放前面是为了和设置里默认的 npm 镜像保持一致（huaweicloud 紧随其后，第一个源挂了才轮到它）。
 */
const NODE_DIST_MIRROR_BASES: readonly string[] = [
  'https://registry.npmmirror.com/-/binary/node',
  'https://mirrors.huaweicloud.com/nodejs',
]

/** 35MB 的包走 nodejs.org 直连在大陆常慢到超时，所以下载源把镜像排在前面。 */
export function nodeArchiveBaseUrls(version: string = NODE_RUNTIME_VERSION): string[] {
  const normalized = normalizeNodeVersion(version)
  return [...NODE_DIST_MIRROR_BASES, NODE_DIST_OFFICIAL_BASE].map(base => `${base}/${normalized}`)
}

/**
 * 校验清单的源却要把官方放最前：镜像的 SHASUMS256.txt 和它自己的 zip 出自同一台机器，
 * 拿它校验同源下载下来的文件等于没校验。只有官方清单取不到时才退到镜像——那种情况
 * 至少还拦得住"传到一半断了"，并且在日志里说明信任级别降了。
 * （2026-09-22 实测三处的 SHASUMS256.txt 逐字节相同，所以退回镜像不是因为镜像会滞后。）
 */
export function nodeChecksumBaseUrls(version: string = NODE_RUNTIME_VERSION): string[] {
  const normalized = normalizeNodeVersion(version)
  return [`${NODE_DIST_OFFICIAL_BASE}/${normalized}`, ...NODE_DIST_MIRROR_BASES.map(base => `${base}/${normalized}`)]
}

/** 读一次 SHASUMS256.txt 的超时：宁可换下一个源，也不能让「准备运行环境」卡死在这一步。 */
const NODE_CHECKSUM_TIMEOUT_MS = 8_000

/** 从 URL 里取个短名字放进日志和进度文案，失败也不该因此让下载报错。 */
function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface NodeRuntime {
  root: string
  node: string
  npm: string
  npx: string
  managed: boolean
  /**
   * 这份 Node 从哪来——失败提示要告诉用户该去关哪个开关，光有 managed 分不出
   * 「随包自带」和「下载来的托管版本」。旧数据可能没有，读时用 unknown 兜底。
   */
  origin?: 'bundled' | 'managed' | 'system'
}

export interface PnpmRuntime {
  root: string
  executable: string
}

export interface NodeRuntimeProgress {
  percent: number
  message: string
  downloadedBytes?: number
  totalBytes?: number
}

type ProgressListener = (progress: NodeRuntimeProgress) => void
type OutputListener = (level: 'info' | 'error', text: string) => void

/** 同一版本只允许一个下载任务；不同版本可以并行准备。 */
const installationPromises = new Map<string, Promise<NodeRuntime>>()
let pnpmInstallationPromise: Promise<PnpmRuntime> | null = null

/**
 * 可执行文件相对于 root 的两种摆放方式。
 *
 * - `bin-directory`：root 本身就是存放可执行文件的目录，例如 PATH 里的 `/usr/bin`。
 * - `distribution-root`：root 是官方发行包解压后的根目录，例如 `node-v24.19.0-linux-x64/`。
 *
 * Windows 上两者一致（zip 与 PATH 目录都是三个文件平铺）；
 * POSIX 上发行包把可执行文件放在 `bin/` 子目录里，差一层。
 */
type RuntimeLayout = 'bin-directory' | 'distribution-root'

export function runtimePaths(root: string, managed: boolean, layout: RuntimeLayout): NodeRuntime {
  if (process.platform === 'win32') {
    return {
      root,
      node: path.join(root, 'node.exe'),
      npm: path.join(root, 'npm.cmd'),
      npx: path.join(root, 'npx.cmd'),
      managed,
    }
  }
  const binary = layout === 'distribution-root' ? path.join(root, 'bin') : root
  return {
    root,
    node: path.join(binary, 'node'),
    npm: path.join(binary, 'npm'),
    npx: path.join(binary, 'npx'),
    managed,
  }
}

function isCompleteRuntime(runtime: NodeRuntime): boolean {
  return existsSync(runtime.node) && existsSync(runtime.npm) && existsSync(runtime.npx)
}

export function pnpmExecutable(runtimeRoot: string): string {
  return process.platform === 'win32'
    ? path.join(runtimeRoot, 'node_modules', '.bin', 'pnpm.cmd')
    : path.join(runtimeRoot, 'node_modules', '.bin', 'pnpm')
}

function isCompletePnpmRuntime(runtime: PnpmRuntime): boolean {
  return existsSync(runtime.executable)
}

async function hasRequiredPnpmVersion(runtime: PnpmRuntime): Promise<boolean> {
  if (!isCompletePnpmRuntime(runtime)) return false
  try {
    const manifestPath = path.join(runtime.root, 'node_modules', 'pnpm', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
    return manifest.version === PNPM_VERSION
  } catch {
    return false
  }
}

/** PATH 上结构完整的本机 Node 候选（按 PATH 顺序，Program Files 视为最前）。 */
export function systemNodeCandidates(environment: NodeJS.ProcessEnv = process.env): NodeRuntime[] {
  const entries = (environment.PATH ?? environment.Path ?? environment.path ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  if (process.platform === 'win32') {
    entries.unshift(path.join(environment.ProgramFiles ?? 'C:\\Program Files', 'nodejs'))
  }
  const candidates: NodeRuntime[] = []
  for (const entry of entries) {
    // PATH 里的每一项本身就是可执行文件所在的目录。
    const runtime = runtimePaths(entry.replace(/^"|"$/g, ''), false, 'bin-directory')
    if (isCompleteRuntime(runtime)) candidates.push({ ...runtime, origin: 'system' })
  }
  return candidates
}

export function findSystemNodeRuntime(environment: NodeJS.ProcessEnv = process.env): NodeRuntime | null {
  return systemNodeCandidates(environment)[0] ?? null
}

/**
 * 比较 Node 版本号（`22.13`、`v22.13.0`、`24.0.0-rc.1` 都收）。
 * 缺省的段按 0 补：门槛写成 `22.13` 也能正确判定。
 */
export function nodeVersionAtLeast(version: string, minimum: string = MIN_NODE_VERSION): boolean {
  const parse = (value: string): { parts: number[]; prerelease: boolean } | null => {
    if (typeof value !== 'string') return null
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?/.exec(value.trim())
    if (!match) return null
    return {
      parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
      prerelease: value.includes('-'),
    }
  }
  const floor = parse(minimum)
  // 门槛本身写错时不该把用户全挡在外面。
  if (!floor) return true
  const actual = parse(version)
  if (!actual) return false
  for (let index = 0; index < 3; index += 1) {
    if (actual.parts[index] !== floor.parts[index]) return actual.parts[index]! > floor.parts[index]!
  }
  // 同版本号时预发布版算低于正式版。
  return !actual.prerelease || floor.prerelease
}

const versionProbeCache = new Map<string, Promise<string | null>>()

/** 探一个 node 可执行文件的真实版本；超时或异常一律 null（视为不达标）。 */
export function probeNodeVersion(nodeExecutable: string): Promise<string | null> {
  const key = path.resolve(nodeExecutable)
  const cached = versionProbeCache.get(key)
  if (cached) return cached
  const probe = new Promise<string | null>(resolve => {
    execFile(
      key,
      ['-p', 'process.versions.node'],
      { timeout: NODE_VERSION_PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const text = stdout.trim().replace(/^v/, '')
        resolve(/^\d+\.\d+\.\d+/.test(text) ? text : null)
      },
    )
  })
  versionProbeCache.set(key, probe)
  return probe
}

/** 版本达标的本机 Node。不达标的候选（含探不到版本的）一律不采用。 */
export async function findQualifiedSystemNodeRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  minimum: string = MIN_NODE_VERSION,
  probe: (nodeExecutable: string) => Promise<string | null> = probeNodeVersion,
): Promise<NodeRuntime | null> {
  for (const candidate of systemNodeCandidates(environment)) {
    const version = await probe(candidate.node)
    if (version && nodeVersionAtLeast(version, minimum)) return candidate
  }
  return null
}

export function normalizeNodeVersion(version: string): string {
  const normalized = version.trim()
  return normalized.startsWith('v') ? normalized : `v${normalized}`
}

export function managedNodeVersionRoot(runtimeRoot: string, version: string): string {
  return path.join(runtimeRoot, 'versions', normalizeNodeVersion(version))
}

export function nodeArchiveName(versionOrArchitecture = NODE_RUNTIME_VERSION, architecture = process.arch): string {
  // 保留旧的 nodeArchiveName('x64') 调用约定，同时支持 nodeArchiveName('v22.14.0', 'x64')。
  const isArchitecture = versionOrArchitecture === 'x64' || versionOrArchitecture === 'arm64'
  const version = isArchitecture ? NODE_RUNTIME_VERSION : versionOrArchitecture
  const selectedArchitecture = isArchitecture ? versionOrArchitecture : architecture
  const archiveArchitecture = selectedArchitecture === 'arm64' ? 'arm64' : 'x64'
  return `node-${normalizeNodeVersion(version)}-win-${archiveArchitecture}.zip`
}

export function parseNodeArchiveChecksum(checksums: string, archiveName: string): string | null {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (match?.[2] === archiveName) return match[1].toLowerCase()
  }
  return null
}

function versionFromNodeDirectory(directory: string): string | null {
  const match = directory.match(/^node-(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-(?:x64|arm64)$/i)
  return match ? normalizeNodeVersion(match[1]) : null
}

export interface ManagedNodeVersion {
  version: string
  runtime: NodeRuntime
  root: string
  source: 'launcher' | 'legacy'
}

export async function findManagedNodeRuntimes(runtimeRoot: string): Promise<ManagedNodeVersion[]> {
  if (!existsSync(runtimeRoot)) return []
  const entries = await readdir(runtimeRoot, { withFileTypes: true })
  const roots: Array<{ root: string; source: 'launcher' | 'legacy' }> = []
  const versionsRoot = path.join(runtimeRoot, 'versions')
  const versionEntries = await readdir(versionsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of versionEntries) {
    if (entry.isDirectory()) roots.push({ root: path.join(versionsRoot, entry.name), source: 'launcher' })
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('node-v')) roots.push({ root: path.join(runtimeRoot, entry.name), source: 'legacy' })
  }
  const found: ManagedNodeVersion[] = []
  for (const item of roots) {
    const runtime = runtimePaths(item.root, true, 'distribution-root')
    const version = item.source === 'launcher'
      ? (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i.test(path.basename(item.root)) ? normalizeNodeVersion(path.basename(item.root)) : null)
      : versionFromNodeDirectory(path.basename(item.root))
    if (version && isCompleteRuntime(runtime)) found.push({ version, runtime, root: item.root, source: item.source })
  }
  return found.sort((left, right) => right.version.localeCompare(left.version, 'en'))
}

export async function findManagedNodeRuntime(runtimeRoot: string, requestedVersion?: string | null): Promise<NodeRuntime | null> {
  const runtimes = await findManagedNodeRuntimes(runtimeRoot)
  if (requestedVersion) {
    const normalized = normalizeNodeVersion(requestedVersion)
    return runtimes.find(item => item.version === normalized)?.runtime ?? null
  }
  return runtimes[0]?.runtime ?? null
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadFile(url: string, target: string, onProgress: (ratio: number, downloadedBytes: number, totalBytes: number | null) => void): Promise<void> {
  const existingSize = existsSync(target) ? (await stat(target)).size : 0
  const response = await fetch(url, {
    redirect: 'follow',
    headers: existingSize > 0 ? { Range: `bytes=${existingSize}-` } : undefined,
  })
  if (response.status === 416 && existingSize > 0) {
    onProgress(1, existingSize, existingSize)
    return
  }
  if (!response.ok || !response.body) throw new Error(`下载 Node.js 运行环境失败（HTTP ${response.status}）。`)
  const resumed = response.status === 206 && existingSize > 0
  const contentLength = Number(response.headers.get('content-length'))
  const contentRange = response.headers.get('content-range')
  const rangeTotal = contentRange ? Number(contentRange.split('/').at(-1)) : Number.NaN
  const total = Number.isFinite(rangeTotal) ? rangeTotal : (resumed ? existingSize : 0) + contentLength
  const file = await open(target, resumed ? 'a' : 'w')
  let received = resumed ? existingSize : 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      await file.write(chunk)
      received += chunk.byteLength
      onProgress(
        Number.isFinite(total) && total > 0 ? Math.min(received / total, 1) : 0,
        received,
        Number.isFinite(total) && total > 0 ? total : null,
      )
    }
  } finally {
    await file.close()
  }
}

/**
 * 逐个源试读 SHASUMS256.txt，返回第一个能解析出当前安装包的 SHA256。
 * 全部读不到才报错——绝不能"没有校验信息就照样装"。
 */
async function readNodeArchiveChecksum(
  archiveName: string,
  bases: string[],
  onOutput?: OutputListener,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const failures: string[] = []
  const officialHost = urlHost(NODE_DIST_OFFICIAL_BASE)
  for (const base of bases) {
    const host = urlHost(base)
    const url = `${base}/SHASUMS256.txt`
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(NODE_CHECKSUM_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const checksum = parseNodeArchiveChecksum(await response.text(), archiveName)
      if (!checksum) throw new Error('清单里没有当前 Windows 安装包')
      if (host !== officialHost) {
        onOutput?.('info', `官方校验清单不可用，改用镜像 ${host} 的清单（只能保证传输完整，不能保证来源可信）。`)
      }
      return checksum
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${host}：${reason}`)
      onOutput?.('error', `读取 ${url} 失败：${reason}`)
    }
  }
  throw new Error(`读取 Node.js 校验信息失败（${failures.join('；')}）。`)
}

/** 记下 zip 是哪个源写的：换源时必须先把上一个源的残留删掉，见 downloadVerifiedNodeArchive。 */
async function ensureArchiveBelongsToSource(archivePath: string, markerPath: string, base: string): Promise<void> {
  const previous = await readFile(markerPath, 'utf8').catch(() => null)
  if (previous?.trim() === base) return
  await rm(archivePath, { force: true })
  await writeFile(markerPath, base, 'utf8')
}

/**
 * 按候选源下载发行包，直到某个源的产物能通过 expectedChecksum。
 *
 * 两条规则：
 * - **绝不跨源续传**。downloadFile 支持 Range 续传，但把 A 源的半截和 B 源的偏移量拼起来
 *   必然过不了 SHA256，而报错长得像"下载损坏"，很难查。所以换源前靠 `.source` 旁记文件
 *   判断残留属于谁，不属于当前源就先删。
 * - 校验只认内容：本地已有的包只要 SHA256 对得上就直接用，不管它是哪年哪个源下的。
 */
export async function downloadVerifiedNodeArchive(options: {
  archivePath: string
  markerPath: string
  bases: string[]
  archiveName: string
  expectedChecksum: string
  onProgress?: (ratio: number, downloadedBytes: number, totalBytes: number | null, source: string) => void
  onOutput?: OutputListener
  download?: typeof downloadFile
  checksumOf?: (filePath: string) => Promise<string>
}): Promise<void> {
  const { archivePath, markerPath, bases, archiveName, expectedChecksum } = options
  const checksumOf = options.checksumOf ?? sha256
  const download = options.download ?? downloadFile
  if (existsSync(archivePath) && await checksumOf(archivePath) === expectedChecksum) return

  const failures: string[] = []
  for (const base of bases) {
    const source = urlHost(base)
    await ensureArchiveBelongsToSource(archivePath, markerPath, base)
    try {
      await download(`${base}/${archiveName}`, archivePath, (ratio, downloadedBytes, totalBytes) => {
        options.onProgress?.(ratio, downloadedBytes, totalBytes, source)
      })
      if (await checksumOf(archivePath) === expectedChecksum) return
      failures.push(`${source}：安装包校验不匹配`)
      options.onOutput?.('error', `从 ${source} 下载的 Node.js 安装包校验不匹配，换下一个源。`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${source}：${reason}`)
      options.onOutput?.('error', `从 ${source} 下载失败：${reason}`)
    }
  }
  await rm(archivePath, { force: true })
  throw new Error(`下载 Node.js 运行环境失败（已试 ${failures.join('；')}）。`)
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

/**
 * 解压一律用 Windows 自带 bsdtar 的绝对路径。裸 `tar.exe` 会先命中 Git Bash / MSYS
 * 的 /usr/bin/tar，它读不懂 `C:\…`（报 "Cannot connect to C: resolve failed"），
 * 从 MSYS 终端里启动启动器的人就会卡在「准备 Node 运行环境」这一步。
 */
function systemTarExecutable(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return path.join(windowsRoot, 'System32', 'tar.exe')
}

export async function installManagedNodeRuntime(
  runtimeRoot: string,
  version = NODE_RUNTIME_VERSION,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
): Promise<NodeRuntime> {
  if (process.platform !== 'win32') {
    throw new Error('未检测到 Node.js。自动准备运行环境目前仅支持 Windows。')
  }

  const normalizedVersion = normalizeNodeVersion(version)
  const archiveName = nodeArchiveName(normalizedVersion)
  const extractedName = archiveName.slice(0, -4)
  const finalRoot = managedNodeVersionRoot(runtimeRoot, normalizedVersion)
  const existing = runtimePaths(finalRoot, true, 'distribution-root')
  if (isCompleteRuntime(existing)) return existing

  const nonce = `${process.pid}-${Date.now()}`
  const archivePath = path.join(runtimeRoot, archiveName)
  const archiveSourceMarker = `${archivePath}.source`
  const stagingRoot = path.join(runtimeRoot, `.node-runtime-${nonce}`)
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(path.dirname(finalRoot), { recursive: true })
  await mkdir(stagingRoot, { recursive: true })

  try {
    onProgress?.({ percent: 3, message: '正在读取 Node.js 校验信息' })
    const expectedChecksum = await readNodeArchiveChecksum(archiveName, nodeChecksumBaseUrls(normalizedVersion), onOutput)

    let lastTick = ''
    await downloadVerifiedNodeArchive({
      archivePath,
      markerPath: archiveSourceMarker,
      bases: nodeArchiveBaseUrls(normalizedVersion),
      archiveName,
      expectedChecksum,
      onOutput,
      onProgress: (ratio, downloadedBytes, totalBytes, source) => {
        const percent = 8 + Math.round(ratio * 67)
        // 换源时百分比可能原地不动甚至倒退，那也要发出去——否则用户看到的是一条
        // 停住的进度条，而实际正在从第二个源重下。
        if (`${source}:${percent}` !== lastTick) {
          lastTick = `${source}:${percent}`
          onProgress?.({ percent, message: `正在下载 Node.js ${normalizedVersion}（${source}）`, downloadedBytes, totalBytes: totalBytes ?? undefined })
        }
      },
    })
    onProgress?.({ percent: 78, message: '正在校验 Node.js 安装包' })

    onProgress?.({ percent: 84, message: '正在解压 Node.js 运行环境' })
    const tarExecutable = systemTarExecutable()
    const extractor = trackSpawnedProcess(spawn(tarExecutable, ['-xf', archivePath, '-C', stagingRoot], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    onOutput?.('info', `命令：${formatCommandLine(tarExecutable, ['-xf', archivePath, '-C', stagingRoot])}\n工作目录：${runtimeRoot}`)
    let extractionError = ''
    extractor.stdout.on('data', chunk => onOutput?.('info', chunk.toString('utf8')))
    extractor.stderr.on('data', chunk => {
      const text = chunk.toString('utf8')
      extractionError += text
      onOutput?.('error', text)
    })
    const exitCode = await waitForExit(extractor)
    onOutput?.(exitCode === 0 ? 'info' : 'error', `命令退出：${exitCode}`)
    if (exitCode !== 0) throw new Error(`解压 Node.js 运行环境失败：${extractionError.trim() || `代码 ${exitCode}`}`)

    const stagedRoot = path.join(stagingRoot, extractedName)
    const stagedRuntime = runtimePaths(stagedRoot, true, 'distribution-root')
    if (!isCompleteRuntime(stagedRuntime)) throw new Error('Node.js 运行环境解压后文件不完整。')
    await rm(finalRoot, { recursive: true, force: true })
    await rename(stagedRoot, finalRoot)
    const installed = runtimePaths(finalRoot, true, 'distribution-root')
    await rm(archivePath, { force: true })
    await rm(archiveSourceMarker, { force: true })
    onProgress?.({ percent: 100, message: `Node.js ${normalizedVersion} 已就绪` })
    return installed
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface NodeRuntimeSelection {
  /** 随包内置 Node 的根目录（官方发行包解压后的目录）。 */
  bundledRoot?: string | null
  /** 覆盖 PATH 来源，供测试注入。 */
  environment?: NodeJS.ProcessEnv
  /** 覆盖版本探测，供测试固定结果；默认走真实 probeNodeVersion。 */
  probeVersion?: (nodeExecutable: string) => Promise<string | null>
}

/** 随包/托管目录在 POSIX 下把可执行文件放在 bin/，Windows 下平铺（runtimePaths 会忽略）。 */
const DISTRIBUTION_LAYOUT: RuntimeLayout = 'distribution-root'

/** 结构完整且版本达标的现成 runtime 才敢直接用（随包内容可能与常量漂移）。 */
async function usableRuntime(
  runtime: NodeRuntime,
  probe: (nodeExecutable: string) => Promise<string | null>,
): Promise<boolean> {
  if (!isCompleteRuntime(runtime)) return false
  /**
   * npm 必须按文件确认，不能只看 npm.cmd 在不在：electron-builder 的 extraResources
   * 会无条件剥掉 `node_modules` 目录（实测两种 filter 写法都拦不住），于是包里的
   * `npm.cmd` 指向一个不存在的 npm-cli.js。少了 npm 的「完整」Node 会让后面装 pnpm
   * 那步直接失败，所以这里拒掉，让它回落到托管下载那条本来就工作的路径。
   */
  if (!existsSync(path.join(runtime.root, 'node_modules', 'npm', 'package.json'))) return false
  const version = await probe(runtime.node)
  return version !== null && nodeVersionAtLeast(version)
}

/**
 * 挑一个可用的 Node 运行环境。顺序是刻意排的：
 *
 *   1. 显式指定版本 → 该版本的托管安装（开发者钉住某个版本排查问题）；
 *   2. 本机 Node → **探测版本达标就用**，省掉一次 35MB 下载；
 *   3. 随包内置 → 开发态 vendor/（发布包目前不含它，见 fetch-node-runtime.mts 顶部）；
 *   4. 托管下载 → 兜底。
 *
 * 关键是第 2 步的门控：旧实现只看 PATH 上有没有 `node.exe`/`npm.cmd`/`npx.cmd`
 * 三个文件，**不探版本**。本机装着老 Node 的用户因此直接撞上
 * 「DSH 安装失败（代码 1）」（pnpm 11 要求 node>=22.13），而**没装 Node 的人反而正常**。
 * 现在不达标就自动跳到后面的路，用户不需要知道 Node 是什么。
 */
export async function ensureNodeRuntime(
  runtimeRoot: string,
  onProgress?: ProgressListener,
  requestedVersion?: string | null,
  onOutput?: OutputListener,
  selection: NodeRuntimeSelection = {},
): Promise<NodeRuntime> {
  const probe = selection.probeVersion ?? probeNodeVersion
  if (requestedVersion) {
    const pinned = await findManagedNodeRuntime(runtimeRoot, requestedVersion)
    if (pinned) return { ...pinned, origin: 'managed' }
  } else {
    const system = await findQualifiedSystemNodeRuntime(selection.environment ?? process.env, MIN_NODE_VERSION, probe)
    if (system) return system
    if (selection.bundledRoot) {
      const bundled = runtimePaths(selection.bundledRoot, true, DISTRIBUTION_LAYOUT)
      if (await usableRuntime(bundled, probe)) return { ...bundled, origin: 'bundled' }
    }
    // 已经下载过的托管 runtime（可能是历史版本）只要达标就别再下一份。
    const managedAny = await findManagedNodeRuntime(runtimeRoot)
    if (managedAny && await usableRuntime(managedAny, probe)) return { ...managedAny, origin: 'managed' }
    const managedDefault = await findManagedNodeRuntime(runtimeRoot, NODE_RUNTIME_VERSION)
    if (managedDefault) return { ...managedDefault, origin: 'managed' }
  }
  const version = normalizeNodeVersion(requestedVersion ?? NODE_RUNTIME_VERSION)
  const key = `${path.resolve(runtimeRoot)}:${version}`.toLowerCase()
  const existing = installationPromises.get(key)
  if (existing) return existing
  const installation = installManagedNodeRuntime(runtimeRoot, version, onProgress, onOutput)
    .then(runtime => ({ ...runtime, origin: 'managed' as const }))
    .finally(() => {
      installationPromises.delete(key)
    })
  installationPromises.set(key, installation)
  return installation
}

/**
 * `npm install pnpm@<PNPM_VERSION>` 的参数。
 *
 * registry 必须显式指定：不指定时 npm 用用户全局 `.npmrc`，没有就走官方源，
 * 大陆环境于是卡在 registry.npmjs.org 上——和「装好启动器却装不上插件」是同一类反馈。
 * `--fetch-timeout` 默认 5 分钟，坏源上等于永久卡住；压到 30 秒，让候选链来得及换源。
 */
export function managedPnpmInstallArgs(runtimeRoot: string, registry: string): string[] {
  return [
    'install',
    '--prefix', runtimeRoot,
    '--registry', registry,
    '--save-exact',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--fetch-timeout=30000',
    '--fetch-retry-maxtimeout=30000',
    '--loglevel=verbose',
    `pnpm@${PNPM_VERSION}`,
  ]
}

async function runNpmPnpmInstall(
  runtimeRoot: string,
  nodeRuntime: NodeRuntime,
  registry: string,
  onOutput?: OutputListener,
): Promise<{ exitCode: number; diagnostics: string }> {
  const args = managedPnpmInstallArgs(runtimeRoot, registry)
  onOutput?.('info', `命令：${formatCommandLine(nodeRuntime.npm, args)}\n工作目录：${runtimeRoot}`)
  const child = spawnCommand(nodeRuntime.npm, args, {
    cwd: runtimeRoot,
    env: withExecutableDirectoryOnPath(nodeRuntime.node, {
      ...process.env,
      FORCE_COLOR: '0',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    }),
  })
  let diagnostics = ''
  child.stdout.on('data', chunk => onOutput?.('info', chunk.toString('utf8')))
  child.stderr.on('data', chunk => {
    const text = chunk.toString('utf8')
    diagnostics = `${diagnostics}${text}`.slice(-8_000)
    onOutput?.('error', text)
  })
  const exitCode = await waitForExit(child)
  onOutput?.(exitCode === 0 ? 'info' : 'error', `命令退出：${exitCode}`)
  return { exitCode, diagnostics }
}

async function installManagedPnpmRuntime(
  runtimeRoot: string,
  nodeRuntime: NodeRuntime,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
  registryCandidates: string[] = npmRegistryCandidates(),
): Promise<PnpmRuntime> {
  const runtime = { root: runtimeRoot, executable: pnpmExecutable(runtimeRoot) }
  if (await hasRequiredPnpmVersion(runtime)) return runtime

  await mkdir(runtimeRoot, { recursive: true })
  let lastExitCode = 1
  let lastDiagnostics = ''
  for (const [index, registry] of registryCandidates.entries()) {
    const host = urlHost(registry)
    onProgress?.({ percent: 10, message: index === 0 ? '正在准备 pnpm 插件运行环境' : `正在换源准备 pnpm 插件运行环境（${host}）` })
    let attempt: { exitCode: number; diagnostics: string }
    try {
      attempt = await runNpmPnpmInstall(runtimeRoot, nodeRuntime, registry, onOutput)
    } catch (error) {
      // npm 本身没跑起来（被杀软拦、路径不存在）也算这个源的一次失败，继续往后试并留在汇总信息里。
      const reason = error instanceof Error ? error.message : String(error)
      onOutput?.('error', `从 ${host} 安装 pnpm 时命令没跑起来：${reason}`)
      attempt = { exitCode: 1, diagnostics: reason }
    }
    lastExitCode = attempt.exitCode
    lastDiagnostics = attempt.diagnostics
    // 装没装上以 pnpm 的 package.json 为准，不以 npm 退出码为准：npm 会因无关告警退非 0，
    // 也会退 0 却没把包放对地方（prefix 目录里已有别的依赖时）。
    if (await hasRequiredPnpmVersion(runtime)) {
      onProgress?.({ percent: 100, message: `pnpm ${PNPM_VERSION} 已就绪` })
      return runtime
    }
    onOutput?.('error', `从 ${host} 安装 pnpm ${PNPM_VERSION} 未成功${index + 1 < registryCandidates.length ? '，换下一个源。' : '。'}`)
  }
  throw new Error(`pnpm 插件运行环境准备失败（已试 ${registryCandidates.map(urlHost).join(' → ')}）${lastDiagnostics ? `：${lastDiagnostics.trim()}` : `（代码 ${lastExitCode}）`}`)
}

export interface PnpmRuntimeSelection {
  /** 随包 pnpm 的根目录（内含 `node_modules/pnpm` 与 `node_modules/.bin/pnpm.cmd`）。 */
  bundledRoot?: string | null
  /** npm registry 候选链；缺省时用「npmmirror → 官方源」，调用方有用户设置时应把自己的镜像放第一位。 */
  registryCandidates?: string[]
}

export async function ensurePnpmRuntime(
  runtimeRoot: string,
  nodeRuntime: NodeRuntime,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
  selection: PnpmRuntimeSelection = {},
): Promise<PnpmRuntime> {
  // 随包 pnpm 优先：命中就不碰 npm、不联网。判版本靠读 package.json，不 spawn pnpm。
  if (selection.bundledRoot) {
    const bundled = { root: selection.bundledRoot, executable: pnpmExecutable(selection.bundledRoot) }
    if (await hasRequiredPnpmVersion(bundled)) return bundled
  }
  const existing = { root: runtimeRoot, executable: pnpmExecutable(runtimeRoot) }
  if (await hasRequiredPnpmVersion(existing)) return existing
  if (!pnpmInstallationPromise) {
    pnpmInstallationPromise = installManagedPnpmRuntime(runtimeRoot, nodeRuntime, onProgress, onOutput, selection.registryCandidates).finally(() => {
      pnpmInstallationPromise = null
    })
  }
  return pnpmInstallationPromise
}

export function resolveNodeExecutable(executable: string, runtime: NodeRuntime): string {
  const name = path.basename(executable).toLowerCase()
  if (name === 'node' || name === 'node.exe') return runtime.node
  if (name === 'npm' || name === 'npm.cmd') return runtime.npm
  if (name === 'npx' || name === 'npx.cmd') return runtime.npx
  return executable
}

export function requiresNodeRuntime(executable: string, args: string[]): boolean {
  const name = path.basename(executable).toLowerCase()
  return ['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'dsh', 'dsh.cmd'].includes(name)
    || args.includes('@deepseek-ai/dsh')
    || executable.toLowerCase().includes('dsh-runtime')
}
