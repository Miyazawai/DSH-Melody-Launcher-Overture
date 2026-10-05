/**
 * 发现本机装了的官方桌面端（DSH Desktop）。
 *
 * 只读盘，不写任何东西，也不查注册表（注册表查询要走子进程，以前那种同步 `reg query`
 * 会把主进程事件循环冻住，见 electron/proxy.ts 的教训）。判定依据用它自己的目录结构，
 * 不猜产品名：装好后必然有 `resources/runtime/cli/bin/dsh.cmd`——那是桌面端塞给我们的
 * 那个 `dsh` 命令（拿自己的 exe 当 Node 跑 `dsh-desktop-host/lib/cli.js`），也正是我们
 * 唯一被允许的插件操作入口。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export interface DesktopClientInstall {
  /** 安装根目录，里面有 `<目录名>.exe`。 */
  root: string
  executable: string
  /** 桌面端自带的 `dsh` 命令入口。 */
  cli: string
  /** 桌面端版本，如 `0.2.0-rc.2`；读不到为 null。 */
  desktopVersion: string | null
  /** 它自带的 Node / pnpm 版本，仅用于展示「装插件用的是它自己的工具链」。 */
  nodeVersion: string | null
  pnpmVersion: string | null
}

const CLI_SEGMENTS = ['resources', 'runtime', 'cli', 'bin', 'dsh.cmd']
const RUNTIME_SEGMENTS = ['resources', 'runtime', 'primary-runtime', 'runtime.json']

async function isFile(candidate: string): Promise<boolean> {
  const info = await stat(candidate).catch(() => null)
  return info?.isFile() === true
}

/** electron-builder 的产物是 `<安装目录名>.exe`；同目录还有 `Uninstall *.exe`，不能选它。 */
async function findExecutable(root: string, directoryName: string): Promise<string | null> {
  const preferred = path.join(root, `${directoryName}.exe`)
  if (await isFile(preferred)) return preferred
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const candidate = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map(entry => entry.name)
    .find(name => !/^uninstall/i.test(name) && !/^update-/i.test(name))
  return candidate ? path.join(root, candidate) : null
}

async function readRuntimeJson(root: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, ...RUNTIME_SEGMENTS), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function inspectCandidate(root: string): Promise<DesktopClientInstall | null> {
  const cli = path.join(root, ...CLI_SEGMENTS)
  if (!(await isFile(cli))) return null
  const directoryName = path.basename(root)
  const executable = await findExecutable(root, directoryName)
  if (!executable) return null
  const runtime = await readRuntimeJson(root)
  const text = (key: string): string | null => typeof runtime[key] === 'string' ? runtime[key] as string : null
  return {
    root,
    executable,
    cli,
    desktopVersion: text('desktopVersion'),
    nodeVersion: text('node'),
    pnpmVersion: text('pnpm'),
  }
}

/** 预发布号比较只看数字段：`0.2.0-rc.2` > `0.1.7-rc.1`。 */
function versionKey(version: string | null): number[] {
  if (!version) return []
  return version.split(/[.\-+]/).map(part => Number.parseInt(part, 10)).filter(Number.isFinite)
}

function newer(left: DesktopClientInstall, right: DesktopClientInstall): boolean {
  const a = versionKey(left.desktopVersion)
  const b = versionKey(right.desktopVersion)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta > 0
  }
  return false
}

async function children(directory: string | undefined): Promise<string[]> {
  if (!directory) return []
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory()).map(entry => path.join(directory, entry.name))
}

/**
 * 找出本机所有桌面端安装，按版本从高到低返回。
 *
 * 只扫 `%LOCALAPPDATA%\Programs` 与两个 Program Files 的一层子目录：electron-builder 的
 * 每用户安装就落在这里，再深就要猜目录布局了。找不到返回空数组——那是「没装」，不是错误。
 */
export async function detectDesktopClients(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopClientInstall[]> {
  const roots = [
    ...(await children(env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : undefined)),
    ...(await children(env.ProgramFiles ?? env.PROGRAMFILES)),
    ...(await children(env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'])),
  ]
  const found: DesktopClientInstall[] = []
  for (const root of roots) {
    const install = await inspectCandidate(root)
    if (install) found.push(install)
  }
  return found.sort((left, right) => (newer(left, right) ? -1 : newer(right, left) ? 1 : 0))
}

/** 最常见的情形：要么装了一个，要么没装。 */
export async function detectDesktopClient(env: NodeJS.ProcessEnv = process.env): Promise<DesktopClientInstall | null> {
  return (await detectDesktopClients(env))[0] ?? null
}
