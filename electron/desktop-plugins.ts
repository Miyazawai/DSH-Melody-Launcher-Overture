/**
 * 管理官方桌面端（DSH Desktop）自己的插件。
 *
 * 三条从盘上读来的事实决定了这个模块的形状，别按我们自家包的思路去改它：
 *
 *   1. 唯一被允许的外部写入通道是桌面端自带的那个 `dsh.cmd`：它以自己的 exe 当 Node、
 *      以 `manageDesktopProfile: true` 起 CLI，并把包操作转给它自带的 pnpm。npm 装的
 *      `dsh` 会直接拒绝 `--profile desktop`（`rejectElectronProfile`），所以我们既不能
 *      用自己的 runtime 去装，也不能自己改它的 `package.json`。
 *   2. 它的 `plugin` 子命令只转发 pnpm 参数（add / remove / why），**没有 enable/disable**。
 *      启用与停用属于它自己插件管理页和 `.plugin-manager` 状态目录的事，我们手改
 *      `dsh.profile.bundles` 只会让两边对不上。所以这里不提供开关。
 *   3. 绝不复用 `installer.runPluginCommand()`：那条路每次都调 `syncProfilePnpmConfig()`，
 *      会把 `store-dir` 指到我们的插件池里——等于把它的依赖落点搬进我们家。
 *
 * 也不登记 plugin receipt：收据是跨包搬运与切换整合包时重建插件的依据，
 * 给一个我们不该管的目录立收据，等于邀请那些机制去写它。
 *
 * 家目录一律用**未派生**的那个（`readStoredSettings().dshHome`）：`settings.read().dshHome`
 * 会随激活包变成它的私有家目录，而桌面端永远住在默认家目录里。
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { AppSettings, DesktopPluginState, ManagedPlugin, RuntimeOutput } from '../src/types'
import { runCommand, type CommandOptions } from './command'
import { detectDesktopClient, type DesktopClientInstall } from './desktop-client'
import { applyDesktopRegistry, readDesktopRegistry, restoreDesktopRegistry } from './desktop-npmrc'
import { isSafePackageName, isSafeRepositoryName, readProfile } from './profile'
import { buildNetworkEnvironment } from './proxy'

const execFileAsync = promisify(execFile)

/** 桌面端 profile 的固定名字；官方文档写明这个目录由 Electron 独占。 */
export const DESKTOP_PROFILE = 'desktop'
const INSTALL_TIMEOUT_MS = 20 * 60_000
const RUNNING_CACHE_MS = 3_000

export interface DesktopPluginSpecifier {
  kind: 'github' | 'npm'
  /** github：owner/repo；npm：不含版本的包名。 */
  name: string
  version?: string
}

export interface DesktopPluginsOptions {
  /** 未派生的设置：桌面端只住在默认家目录，不能跟着激活包漂移。 */
  readStoredSettings: () => Promise<AppSettings>
  emitOutput: (level: RuntimeOutput['level'], text: string) => void
  /** 覆盖检测入口，测试用。 */
  detectClient?: () => Promise<DesktopClientInstall | null>
  runCommand?: (executable: string, args: string[], options: CommandOptions) => Promise<{ exitCode: number | null; output: string }>
  /** 镜像原配置的备份目录，必须在 dshHome 之外。 */
  journalRoot: string
}

export interface DesktopPluginsService {
  status(): Promise<DesktopPluginState>
  install(target: DesktopPluginSpecifier): Promise<void>
  uninstall(packageName: string): Promise<void>
  applyMirror(): Promise<void>
  restoreMirror(): Promise<void>
  open(): Promise<void>
  isBusy(): boolean
}

/**
 * 把「手动添加」解析出来的目标拼成它吃得下的参数。
 * 两段都先过白名单再进命令数组——Windows 上这条命令要过 cmd.exe 批处理行，
 * 白名单是唯一一道防线（见 electron/process.ts 的引号包裹）。
 */
export function desktopPluginSpecifier(target: DesktopPluginSpecifier): string {
  if (target.kind === 'github') {
    if (!isSafeRepositoryName(target.name)) throw new Error('GitHub 仓库名称无效。')
    return `github:${target.name}`
  }
  if (!isSafePackageName(target.name)) throw new Error('插件名称无效。')
  if (target.version === undefined) return target.name
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(target.version)) throw new Error('版本格式无效。')
  return `${target.name}@${target.version}`
}

export function createDesktopPluginsService(options: DesktopPluginsOptions): DesktopPluginsService {
  const execute = options.runCommand ?? runCommand
  const detect = options.detectClient ?? (() => detectDesktopClient())
  let active: string | null = null
  let runningCache: { value: boolean; at: number } | null = null

  const desktopHome = async (): Promise<string> => (await options.readStoredSettings()).dshHome
  const profileDir = (dshHome: string) => path.join(dshHome, 'profiles', DESKTOP_PROFILE)

  /** 按进程名探测：它常被用户自己打开，不是我们 spawn 的子进程。 */
  async function isRunning(executable: string): Promise<boolean> {
    if (process.platform !== 'win32') return false
    if (runningCache && Date.now() - runningCache.at < RUNNING_CACHE_MS) return runningCache.value
    const name = path.basename(executable)
    let value = false
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { windowsHide: true, encoding: 'utf8', timeout: 4_000 })
      value = stdout.toLowerCase().includes(name.toLowerCase())
    } catch {
      // tasklist 读不到就当作没运行：宁可漏报，也不要因为探测失败把安装按钮锁死。
      value = false
    }
    runningCache = { value, at: Date.now() }
    return value
  }

  async function requireClient(): Promise<{ client: DesktopClientInstall; dshHome: string }> {
    const client = await detect()
    if (!client) throw new Error('没有检测到官方桌面端（DSH Desktop）。请先把它装上。')
    return { client, dshHome: await desktopHome() }
  }

  /** 只读它自己的清单；核心 bundle 是它自带的，既不能卸也不该出现在我们的列表里。 */
  async function readPlugins(dshHome: string): Promise<ManagedPlugin[]> {
    const profile = await readProfile(dshHome, DESKTOP_PROFILE).catch(() => null)
    if (!profile) return []
    return profile.plugins.filter(plugin => !plugin.builtin)
  }

  async function runDesktopPlugin(args: string[], label: string) {
    const { client, dshHome } = await requireClient()
    const result = await execute(client.cli, ['plugin', '--profile', DESKTOP_PROFILE, ...args], {
      cwd: profileDir(dshHome),
      env: { ...process.env, DSH_HOME: dshHome, FORCE_COLOR: '0', CI: 'true' },
      timeoutMs: INSTALL_TIMEOUT_MS,
      onOutput: (text, level) => options.emitOutput(level, text),
    })
    if (result.exitCode !== 0) {
      throw new Error(`${label}失败（代码 ${result.exitCode ?? '未知'}）：${result.output.slice(-600)}`)
    }
    return { client, dshHome }
  }

  function begin(task: string): void {
    if (active) throw new Error(`桌面端正在${active}，请等待完成。`)
    active = task
  }

  return {
    isBusy: () => active !== null,

    async status(): Promise<DesktopPluginState> {
      const client = await detect()
      if (!client) return { installed: false }
      const dshHome = await desktopHome()
      const running = await isRunning(client.executable)
      const plugins = await readPlugins(dshHome)
      return {
        installed: true,
        version: client.desktopVersion,
        executable: client.executable,
        running,
        pluginCount: plugins.length,
        plugins,
        registry: await readDesktopRegistry(profileDir(dshHome)),
        mirrorRegistry: buildNetworkEnvironment({ network: (await options.readStoredSettings()).network }).npmRegistry,
      }
    },

    async install(target: DesktopPluginSpecifier): Promise<void> {
      const specifier = desktopPluginSpecifier(target)
      begin('安装插件')
      try {
        const { client, dshHome } = await runDesktopPlugin(['add', specifier], '桌面端插件安装')
        const plugins = await readPlugins(dshHome)
        const matched = target.kind === 'github'
          ? plugins.some(plugin => plugin.repositoryFullName === target.name)
          : plugins.some(plugin => plugin.packageName === target.name)
        // 它的 CLI 可能返回 0 却什么都没装，只有回读它的清单能证明真装上了。
        if (!matched) {
          throw new Error('桌面端命令执行完毕，但它的插件列表里没有出现这个插件。请到桌面端自己的插件管理页确认。')
        }
        options.emitOutput('success', `已为桌面端安装 ${target.name}。`)
        if (await isRunning(client.executable)) options.emitOutput('info', '桌面端正在运行：新插件要重启桌面端之后才会加载。')
      } finally {
        active = null
      }
    },

    async uninstall(packageName: string): Promise<void> {
      if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')
      begin('卸载插件')
      try {
        const { client, dshHome } = await runDesktopPlugin(['remove', packageName], '桌面端插件卸载')
        const plugins = await readPlugins(dshHome)
        if (plugins.some(plugin => plugin.packageName === packageName)) {
          throw new Error('桌面端命令执行完毕，但插件还在它的列表里。请重启桌面端后再试。')
        }
        options.emitOutput('success', `已从桌面端卸载 ${packageName}。`)
        if (await isRunning(client.executable)) options.emitOutput('info', '桌面端正在运行：要重启桌面端才会彻底不再加载它。')
      } finally {
        active = null
      }
    },

    async applyMirror(): Promise<void> {
      const dshHome = await desktopHome()
      const registry = buildNetworkEnvironment({ network: (await options.readStoredSettings()).network }).npmRegistry
      const change = await applyDesktopRegistry(profileDir(dshHome), registry, options.journalRoot)
      options.emitOutput('success', change.changed
        ? `已让桌面端走 ${registry}${change.backupPath ? '（原配置已备份，可一键恢复）' : ''}。`
        : `桌面端已经在用 ${registry}，没有改动。`)
    },

    async restoreMirror(): Promise<void> {
      const dshHome = await desktopHome()
      const restored = await restoreDesktopRegistry(profileDir(dshHome), options.journalRoot)
      if (!restored) throw new Error('没有找到可恢复的原始配置。')
      options.emitOutput('success', '已恢复桌面端原来的 registry 配置。')
    },

    async open(): Promise<void> {
      const { client } = await requireClient()
      // 它自己有进程级单例锁：重复调用只会把窗口带到前台，不会开出第二个。
      const child = spawn(client.executable, [], { detached: true, stdio: 'ignore', cwd: path.dirname(client.executable) })
      child.on('error', error => options.emitOutput('error', `打不开桌面端：${error instanceof Error ? error.message : String(error)}`))
      child.unref()
      runningCache = null
      options.emitOutput('info', '正在打开官方桌面端。')
    },
  }
}
