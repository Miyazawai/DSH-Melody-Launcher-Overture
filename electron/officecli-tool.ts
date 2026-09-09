import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { githubCandidateUrls } from './github-archive'
import { parseNodeArchiveChecksum } from './node-runtime'
import { downloadReleaseAsset } from './release-download'

/**
 * 启动器托管的 OfficeCLI 外部工具（机器级，所有整合包共享一份）。
 *
 * 官方预设包里的 officecli 技能依赖一个 33MB 的单一二进制（iOfficeAI/OfficeCLI）。
 * 技能自带的自愈安装走 install.ps1 → api.github.com + github.com releases，大陆直连
 * 大概率超时；这里改由启动器在启动整合包前准备好：解析 latest Release → 候选源
 * （用户配置的 GitHub 镜像优先 → 直连 → 内置公共镜像）逐个下载 → SHA256SUMS 校验
 * （拿不到清单时退回资产 size 比对）→ versions/<tag>/ 原子落盘 + active.json 指针。
 * 全程永不 throw：任何失败最多退到"本地旧版本"，再不行返回 null，由技能自愈兜底。
 */

export const OFFICECLI_RELEASE_REPO = 'iOfficeAI/OfficeCLI'
const GITHUB_API_ROOT = 'https://api.github.com'
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}
/** officecli 各平台单二进制约 33MB；放宽到 80MiB 防资产异常膨胀。 */
export const OFFICECLI_MAX_BYTES = 80 * 1024 * 1024
const SUMS_ASSET_NAME = 'SHA256SUMS'
const SUMS_MAX_BYTES = 64 * 1024
/** active.json 的"版本检查新鲜度"：24 小时内不再打 GitHub。 */
export const OFFICECLI_CHECK_TTL_MS = 24 * 60 * 60 * 1000

/** 平台 → Release 资产名 + 落盘后的可执行文件名。非 Windows（C 端形态）暂不启用。 */
export function officeCliAssetName(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): { asset: string, binary: string } | null {
  if (platform !== 'win32') return null
  const suffix = architecture === 'arm64' ? 'arm64' : 'x64'
  return { asset: `officecli-win-${suffix}.exe`, binary: 'officecli.exe' }
}

/** GitHub 资产名只允许版本号字符集，挡掉 `../` 之类的 tag 注入。 */

function safeVersionTag(tag: string): string | null {
  const trimmed = tag.trim()
  return /^v?[0-9][0-9A-Za-z._-]{0,63}$/.test(trimmed) ? trimmed : null
}

function officeCliRoot(toolsRoot: string): string {
  return path.join(toolsRoot, 'officecli')
}

function versionExePath(toolsRoot: string, tag: string, binary: string): string {
  return path.join(officeCliRoot(toolsRoot), 'versions', tag, binary)
}

interface ActivePointer {
  version: string
  checkedAt: number
}

async function readActive(root: string): Promise<ActivePointer | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8')) as Partial<ActivePointer>
    if (typeof parsed.version !== 'string' || typeof parsed.checkedAt !== 'number') return null
    const tag = safeVersionTag(parsed.version)
    return tag ? { version: tag, checkedAt: parsed.checkedAt } : null
  } catch {
    return null
  }
}

async function writeActive(root: string, pointer: ActivePointer): Promise<void> {
  await mkdir(root, { recursive: true })
  // 指针文件本身不需要原子换名（读到半截 = JSON.parse 失败 = 当没有），直接覆盖写。
  await writeFile(path.join(root, 'active.json'), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
}

// 候选下载顺序（用户镜像 → 直连 → 内置公共镜像）统一来自 github-archive.githubCandidateUrls。

interface ResolvedOfficeCliRelease {
  tag: string
  binaryUrl: string
  binarySize: number
  sumsUrl: string | null
}

async function resolveLatestRelease(
  assetName: string,
  options: { mirror?: string; fetchImpl: typeof fetch },
): Promise<ResolvedOfficeCliRelease | null> {
  const endpoint = `${GITHUB_API_ROOT}/repos/${OFFICECLI_RELEASE_REPO}/releases/latest`
  for (const url of githubCandidateUrls(endpoint, options.mirror)) {
    try {
      const response = await options.fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12_000) })
      if (!response.ok) continue
      const release = await response.json() as {
        tag_name?: unknown
        assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>
      }
      const tag = safeVersionTag(typeof release.tag_name === 'string' ? release.tag_name : '')
      const assets = Array.isArray(release.assets) ? release.assets : []
      const binary = assets.find(entry => entry?.name === assetName && typeof entry.browser_download_url === 'string')
      if (!tag || !binary) continue
      const sums = assets.find(entry => entry?.name === SUMS_ASSET_NAME && typeof entry.browser_download_url === 'string')
      return {
        tag,
        binaryUrl: String(binary.browser_download_url),
        binarySize: Number(binary.size) || 0,
        sumsUrl: sums ? String(sums.browser_download_url) : null,
      }
    } catch {
      // 单个候选失败继续下一个；全失败由调用方退到旧版本。
    }
  }
  return null
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export interface OfficeCliEnsureOptions {
  mirror?: string
  fetchImpl?: typeof fetch
  onProgress?: (received: number, totalBytes: number | null) => void
  /** 测试注入：平台与"当前时间"。 */
  platform?: NodeJS.Platform
  architecture?: string
  now?: () => number
  /** 单源断流判定（连续无字节即掐掉换源）与单源硬顶；默认 15s / 300s。 */
  stallMs?: number
  candidateMaxMs?: number
}

/** 带断流看门狗的下载：慢但仍在动的源不限速（镜像吞吐差异大），彻底停摆才掐。 */
async function downloadWithStallGuard(
  url: string,
  maxBytes: number,
  options: OfficeCliEnsureOptions,
): Promise<Buffer> {
  const stallMs = options.stallMs ?? 15_000
  const hardMs = options.candidateMaxMs ?? 300_000
  const controller = new AbortController()
  const hard = AbortSignal.timeout(hardMs)
  hard.addEventListener('abort', () => controller.abort())
  let lastByteAt = Date.now()
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > stallMs) controller.abort()
  }, Math.max(500, Math.floor(stallMs / 4)))
  try {
    return await downloadReleaseAsset(url, maxBytes, (received, total) => {
      lastByteAt = Date.now()
      options.onProgress?.(received, total)
    }, options.fetchImpl ?? fetch, controller.signal)
  } finally {
    clearInterval(watchdog)
  }
}

/** 同一托管根目录的 ensure 并发合并成一次下载（启动重试 / 双窗口场景）。 */
const ensureInFlight = new Map<string, Promise<string | null>>()

/**
 * 确保 officecli 二进制可用，返回其绝对路径；不可用（平台不支持 / 网络全挂 /
 * 校验不过）返回 null，绝不抛异常、绝不阻塞启动流程。
 */
export function ensureOfficeCli(toolsRoot: string, options: OfficeCliEnsureOptions = {}): Promise<string | null> {
  const key = `${path.resolve(toolsRoot).toLowerCase()}:${options.platform ?? process.platform}:${options.architecture ?? process.arch}`
  const running = ensureInFlight.get(key)
  if (running) return running
  const task = ensureOfficeCliInner(toolsRoot, options).finally(() => ensureInFlight.delete(key))
  ensureInFlight.set(key, task)
  return task
}

async function ensureOfficeCliInner(toolsRoot: string, options: OfficeCliEnsureOptions): Promise<string | null> {
  const asset = officeCliAssetName(options.platform ?? process.platform, options.architecture ?? process.arch)
  if (!asset) return null
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now?.() ?? Date.now()
  const root = officeCliRoot(toolsRoot)

  const staleUsable = async (): Promise<string | null> => {
    const active = await readActive(root)
    if (!active) return null
    const exe = versionExePath(toolsRoot, active.version, asset.binary)
    return existsSync(exe) ? exe : null
  }

  const active = await readActive(root)
  const activeExe = active ? versionExePath(toolsRoot, active.version, asset.binary) : null
  if (active && activeExe && existsSync(activeExe) && now - active.checkedAt < OFFICECLI_CHECK_TTL_MS) {
    return activeExe
  }

  const release = await resolveLatestRelease(asset.asset, { mirror: options.mirror, fetchImpl })
  if (!release) return staleUsable()

  const target = versionExePath(toolsRoot, release.tag, asset.binary)
  if (existsSync(target)) {
    await writeActive(root, { version: release.tag, checkedAt: now }).catch(() => undefined)
    return target
  }

  // 校验基准优先取官方 SHA256SUMS；清单不可得时退回 release 资产 size。
  let expectedHash: string | null = null
  if (release.sumsUrl) {
    for (const url of githubCandidateUrls(release.sumsUrl, options.mirror)) {
      try {
        const text = (await downloadWithStallGuard(url, SUMS_MAX_BYTES, { ...options, onProgress: undefined })).toString('utf8')
        expectedHash = parseNodeArchiveChecksum(text, asset.asset)
        if (expectedHash) break
      } catch {
        // 换下一个候选源。
      }
    }
  }
  if (!expectedHash && release.binarySize <= 0) return staleUsable()

  await mkdir(path.dirname(target), { recursive: true })
  for (const url of githubCandidateUrls(release.binaryUrl, options.mirror)) {
    try {
      const buffer = await downloadWithStallGuard(url, OFFICECLI_MAX_BYTES, options)
      if (expectedHash) {
        const actual = createHash('sha256').update(buffer).digest('hex')
        if (actual !== expectedHash) continue
      } else if (release.binarySize > 0 && buffer.length !== release.binarySize) {
        continue
      }
      const tmp = `${target}.${process.pid}.tmp`
      await mkdir(path.dirname(tmp), { recursive: true })
      await writeFile(tmp, buffer)
      await rename(tmp, target)
      await writeActive(root, { version: release.tag, checkedAt: now })
      // 只保留当前版本，旧目录尽力回收（失败不影响本次启动）。
      const versionsRoot = path.join(root, 'versions')
      for (const entry of await readdir(versionsRoot, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && entry.name !== release.tag) {
          await rm(path.join(versionsRoot, entry.name), { recursive: true, force: true }).catch(() => undefined)
        }
      }
      return target
    } catch {
      // 这个源失败（超时/404/过大），换下一个候选。
    }
  }
  return staleUsable()
}

/** 包内自带二进制的约定位置：<包家目录>/tools/officecli/officecli.exe，随快照原样搬运。 */
export function bundledOfficeCliPath(
  dshHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(dshHome, 'tools', 'officecli', platform === 'win32' ? 'officecli.exe' : 'officecli')
}

/** 系统 PATH 里是否已经有一个 officecli（用户自装 / 技能自愈装过）——有就复用，不再下载。 */
export function findOfficeCliOnSystem(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const exe = platform === 'win32' ? 'officecli.exe' : 'officecli'
  const entries = (environment.PATH ?? environment.Path ?? environment.path ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  for (const entry of entries) {
    const candidate = path.join(entry.replace(/^"|"$/g, ''), exe)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 解析可用的 officecli 可执行文件，优先级：
 * 1. 整合包自带（tools/officecli/）——官方预设包的主路径，导入即有、零网络；
 * 2. 系统 PATH 已有——用户自装过，直接复用；
 * 3. 启动器托管目录（24h 缓存，未命中走镜像下载链）——野生包兜底。
 * 任何一级拿不到都安静落到下一级，全拿不到返回 null。
 */
export async function resolveOfficeCliExecutable(
  dshHome: string,
  toolsRoot: string,
  options: OfficeCliEnsureOptions & { environment?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const bundled = bundledOfficeCliPath(dshHome, platform)
  if (existsSync(bundled)) return bundled
  const system = findOfficeCliOnSystem(options.environment ?? process.env, platform)
  if (system) return system
  return ensureOfficeCli(toolsRoot, options)
}

/**
 * 这个整合包是否用到了 officecli 技能（技能目录名前缀判定，不看内容不解析，
 * 出错一律当作"不需要"）。启用的与 .disabled/ 里的都算——重新启用就不该再等下载。
 */
export async function packUsesOfficeCliSkills(dshHome: string): Promise<boolean> {
  for (const dir of [path.join(dshHome, 'skills'), path.join(dshHome, 'skills', '.disabled')]) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      if (entries.some(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith('officecli'))) return true
    } catch {
      // 目录不存在 = 没有技能。
    }
  }
  return false
}
