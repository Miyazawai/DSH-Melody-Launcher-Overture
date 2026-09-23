import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LAUNCHER_RELEASE_REPOSITORY } from '../src/constants'
import type { LauncherUpdateProgress, LauncherUpdateStatus } from '../src/types'
import { compareVersions, normalizeVersion } from './dsh-update'
import { downloadReleaseAsset } from './release-download'

/**
 * 启动器自更新：启动时检测 GitHub Release 是否有新版本 → 自动后台下载新 exe
 * （带进度）→ 原位替换当前 portable exe 并重启。检测逻辑与 dsh-update 对齐：
 * 任何网络/解析失败都收敛成 error 状态，绝不阻塞启动。
 */

const GITHUB_API_ROOT = 'https://api.github.com'
/** api.github.com 的镜像前缀（按顺序尝试）。直连被匿名限流（403）或连接失败时，
 * 镜像用自己的出口绕过官方限额，读取同一个 Release 元数据。 */
const GITHUB_API_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/'] as const
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}
/** 新 exe 体积上限（portable 约 91MB，放宽到 512MiB 防极端情况）。 */
const MAX_LAUNCHER_BYTES = 512 * 1024 * 1024

interface GitHubReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
}

interface GitHubLatestRelease {
  tag_name?: unknown
  html_url?: unknown
  /** Release 正文（发布时自动生成的更新说明）。 */
  body?: unknown
  assets?: unknown
}

export interface ResolvedLauncherAsset {
  name: string
  size: number
  url: string
}

/** 从 /releases/latest 响应里解析出唯一 portable exe 资产；缺失即抛错。 */
export function resolvePortableAsset(release: GitHubLatestRelease): ResolvedLauncherAsset {
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  if (!tag) throw new Error('Release 返回异常（缺少版本号）。')
  const assets = Array.isArray(release.assets) ? release.assets : []
  const found = assets.find(entry => {
    const candidate = entry as GitHubReleaseAsset | null
    return Boolean(candidate)
      && typeof candidate?.name === 'string'
      && candidate.name.endsWith('-portable.exe')
      && typeof candidate?.browser_download_url === 'string'
  })
  if (!found) throw new Error('新版本没有可下载的便携版安装包。')
  const resolved = found as GitHubReleaseAsset & { name: string; browser_download_url: string }
  return {
    name: resolved.name,
    size: Number.isFinite(resolved.size) ? Number(resolved.size) : 0,
    url: resolved.browser_download_url,
  }
}

async function fetchLatestRelease(fetchImpl: typeof fetch): Promise<{ tag: string; htmlUrl: string; notes: string | null; asset: ResolvedLauncherAsset }> {
  const endpoint = `${GITHUB_API_ROOT}/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases/latest`
  const candidates = [endpoint, ...GITHUB_API_MIRRORS.map(prefix => `${prefix}${endpoint}`)]
  const failures: string[] = []
  for (const url of candidates) {
    try {
      const response = await fetchImpl(url, { headers: GITHUB_HEADERS })
      if (!response.ok) {
        failures.push(url === endpoint
          ? response.status === 403 ? 'GitHub 请求额度暂时用尽。' : `GitHub 返回 ${response.status}。`
          : `镜像返回 ${response.status}。`)
        continue
      }
      const release = await response.json() as GitHubLatestRelease
      const asset = resolvePortableAsset(release)
      const rawNotes = typeof release.body === 'string' ? release.body.trim() : ''
      return {
        tag: typeof release.tag_name === 'string' ? release.tag_name : '',
        htmlUrl: typeof release.html_url === 'string' ? release.html_url : '',
        // 正文截到 4000 字符：详情弹窗展示用，超长部分去 Release 页看。
        notes: rawNotes ? rawNotes.slice(0, 4000) : null,
        asset,
      }
    } catch (error) {
      failures.push(url === endpoint ? errorMessage(error) : '镜像不可用。')
    }
  }
  throw new Error(failures.join('；'))
}

function checkedAt(): string {
  return new Date().toISOString()
}

/** 网络层失败要翻成中文：这里拼的是 failures.join('；')，直接进用户可见的更新失败文案。 */
const NETWORK_ERROR_TEXT: Record<string, string> = {
  ECONNREFUSED: '连不上 GitHub（连接被拒绝，通常是代理没开）。',
  ETIMEDOUT: '连 GitHub 超时。',
  ECONNRESET: '连 GitHub 的连接被重置。',
  ENOTFOUND: '解析不到 GitHub 域名（离线或 DNS 被劫持）。',
  EAI_AGAIN: 'DNS 暂时解析失败。',
}

function errorMessage(error: unknown): string {
  // fetch 失败时真实错误码在 cause 上，error.message 只有没信息量的 "fetch failed"。
  const code = (error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code
  if (typeof code === 'string' && NETWORK_ERROR_TEXT[code]) return NETWORK_ERROR_TEXT[code]
  return error instanceof Error ? error.message : String(error)
}

interface PendingUpdate {
  tag: string
  htmlUrl: string
  asset: ResolvedLauncherAsset
}

interface UpdateSnapshot {
  status: LauncherUpdateStatus
  pending: PendingUpdate | null
}

/** 一次 fetch 完成「版本比较 + 状态构造」，供纯函数与服务共用。 */
async function readUpdate(getVersion: () => string, fetchImpl: typeof fetch): Promise<UpdateSnapshot> {
  const localVersion = normalizeVersion(getVersion())
  try {
    const release = await fetchLatestRelease(fetchImpl)
    const remoteVersion = normalizeVersion(release.tag)
    if (compareVersions(localVersion, remoteVersion) > 0) {
      return {
        status: {
          state: 'update-available',
          localVersion,
          remoteVersion,
          releaseUrl: release.htmlUrl || null,
          releaseNotes: release.notes,
          assetName: release.asset.name,
          assetSize: release.asset.size || null,
          checkedAt: checkedAt(),
          message: `发现新版本 ${remoteVersion}。`,
        },
        pending: { tag: release.tag, htmlUrl: release.htmlUrl, asset: release.asset },
      }
    }
    return {
      status: {
        state: 'up-to-date',
        localVersion,
        remoteVersion,
        releaseUrl: release.htmlUrl || null,
        assetName: null,
        assetSize: null,
        checkedAt: checkedAt(),
        message: '当前启动器已是最新版本。',
      },
      pending: null,
    }
  } catch (error) {
    return {
      status: {
        state: 'error',
        localVersion,
        remoteVersion: null,
        releaseUrl: null,
        assetName: null,
        assetSize: null,
        checkedAt: checkedAt(),
        message: `暂时无法检查更新：${errorMessage(error)}`,
      },
      pending: null,
    }
  }
}

/** 纯检测：比较本地版本与最新 Release，返回状态。网络失败返回 error 状态。 */
export async function checkLauncherUpdate(
  getVersion: () => string,
  fetchImpl: typeof fetch,
): Promise<LauncherUpdateStatus> {
  const snapshot = await readUpdate(getVersion, fetchImpl)
  return snapshot.status
}

/** 生成原位替换 + 重启的批处理脚本（Windows cmd）。替换失败也清理脚本自身，不留残留。 */
export function buildApplyScript(execBase: string, tempPath: string, execPath: string): string {
  return [
    '@echo off',
    'set /a tries=0',
    ':wait',
    // tasklist/find 用 System32 全路径：即使 PATH 被 MSYS/Git Bash 污染，也能拿到 Windows 自带的实现。
    `%SystemRoot%\\System32\\tasklist.exe /fi "imagename eq ${execBase}" 2>nul | %SystemRoot%\\System32\\find.exe /i "${execBase}" >nul`,
    'if %errorlevel% equ 0 (',
    '  set /a tries+=1',
    '  if %tries% lss 120 (',
    '    timeout /t 1 /nobreak >nul',
    '    goto wait',
    '  )',
    ')',
    `move /y "${tempPath}" "${execPath}" >nul`,
    'if not errorlevel 1 start "" "' + execPath + '"',
    // 无论替换成功与否都删除脚本：move 失败说明目标被占用（旧实例还在），
    // 残留的 cmd 没有继续执行的意义，下次启动器更新会重新生成。
    'del "%~f0"',
    '',
  ].join('\r\n')
}

export interface LauncherUpdaterOptions {
  /** 本地启动器版本。 */
  getVersion: () => string
  /** userData 目录，下载缓存与替换脚本放这里。 */
  userDataPath: string
  /** 当前运行的可执行文件路径；测试注入。缺省 process.execPath。 */
  getExecPath?: () => string
  /** 带 GitHub 鉴权的 fetch；缺省用全局 fetch。 */
  githubFetch?: typeof fetch
  /** 进度事件（下载百分比 / 应用阶段）。 */
  emitProgress: (progress: LauncherUpdateProgress) => void
  /** 测试注入的 spawn。缺省 node:child_process spawn。 */
  spawnProcess?: typeof nodeSpawn
  /** 测试注入的进程退出。缺省 process.exit。 */
  exitProcess?: (code?: number) => never
}

export interface LauncherUpdater {
  check(): Promise<LauncherUpdateStatus>
  download(): Promise<LauncherUpdateStatus>
  apply(): Promise<void>
}

export function createLauncherUpdater(options: LauncherUpdaterOptions): LauncherUpdater {
  const doFetch = options.githubFetch ?? fetch
  const updateRoot = path.join(options.userDataPath, 'launcher-update')
  let status: LauncherUpdateStatus = {
    state: 'up-to-date',
    localVersion: null,
    remoteVersion: null,
    releaseUrl: null,
    assetName: null,
    assetSize: null,
    checkedAt: null,
    message: '',
  }
  let pending: PendingUpdate | null = null
  let downloading: Promise<LauncherUpdateStatus> | null = null

  async function check(): Promise<LauncherUpdateStatus> {
    const snapshot = await readUpdate(options.getVersion, doFetch)
    pending = snapshot.pending
    status = snapshot.status
    return status
  }

  async function download(): Promise<LauncherUpdateStatus> {
    if (status.state === 'downloaded' || status.state === 'downloading' || status.state === 'applying') return status
    if (status.state !== 'update-available' || !pending) return status
    if (downloading) return downloading
    downloading = performDownload()
    try {
      return await downloading
    } finally {
      downloading = null
    }
  }

  async function performDownload(): Promise<LauncherUpdateStatus> {
    const target = pending as PendingUpdate
    const targetPath = path.join(updateRoot, target.asset.name)
    try {
      const existing = await stat(targetPath).catch(() => null)
      if (existing && target.asset.size > 0 && existing.size === target.asset.size) {
        status = { ...status, state: 'downloaded', message: '更新已就绪，可以重启应用。' }
        return status
      }
      status = { ...status, state: 'downloading', message: '正在下载更新…' }
      const buffer = await downloadReleaseAsset(
        target.asset.url,
        MAX_LAUNCHER_BYTES,
        (received, total) => {
          options.emitProgress({
            phase: 'downloading',
            percent: total ? Math.round(Math.min(1, received / total) * 100) : 0,
            downloadedBytes: received,
            totalBytes: total ?? undefined,
          })
        },
        doFetch,
      )
      if (target.asset.size > 0 && buffer.length !== target.asset.size) {
        throw new Error(`下载内容不完整（${buffer.length} ≠ ${target.asset.size} 字节）。`)
      }
      await mkdir(updateRoot, { recursive: true })
      await writeFile(targetPath, buffer)
      status = { ...status, state: 'downloaded', message: '更新已就绪，可以重启应用。' }
      return status
    } catch (error) {
      status = { ...status, state: 'error', message: `更新下载失败：${errorMessage(error)}` }
      return status
    }
  }

  async function apply(): Promise<void> {
    if (status.state !== 'downloaded' || !pending) {
      throw new Error('没有已下载的启动器更新。')
    }
    const target = pending as PendingUpdate
    const execPath = (options.getExecPath ?? (() => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath))()
    // 开发模式（process.execPath 指向 node_modules/electron 等）没有独立的便携包，
    // 原位替换会把下载的新启动器 move 到 Electron 二进制上，破坏开发环境。只允许便携版更新。
    if (!process.env.PORTABLE_EXECUTABLE_FILE && !path.basename(execPath).toLowerCase().includes('-portable')) {
      throw new Error('当前以开发模式运行，自动更新仅支持便携版启动器。')
    }
    const execBase = path.basename(execPath)
    const tempPath = path.join(updateRoot, target.asset.name)
    const scriptPath = path.join(updateRoot, `apply-${process.pid}.cmd`)
    await mkdir(updateRoot, { recursive: true })
    await writeFile(scriptPath, buildApplyScript(execBase, tempPath, execPath))
    status = { ...status, state: 'applying', message: '正在替换并重启应用…' }
    options.emitProgress({ phase: 'applying', percent: 100 })
    // cmd 是控制台程序：detached spawn 会让 Windows 给它新建一个可见的黑色终端
    // （Node 的 windowsHide 在此组合下不生效）。改用 wscript 隐藏启动 cmd，
    // 并通过 vbs 的自删保持目录干净。
    const vbsPath = path.join(updateRoot, `apply-${process.pid}.vbs`)
    await writeFile(vbsPath, [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run """${scriptPath}""", 0, False`,
      'CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName',
      '',
    ].join('\r\n'))
    const doSpawn = options.spawnProcess ?? nodeSpawn
    const child = doSpawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: updateRoot,
    })
    child.unref()
    const doExit = options.exitProcess ?? (code => process.exit(code))
    doExit(0)
  }

  return { check, download, apply }
}
