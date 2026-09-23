import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { DSH_PACKAGE_NAME } from '../src/constants'
import type { AppSettings, LaunchFailureStage, RuntimeFailure, RuntimeOutput, RuntimeState } from '../src/types'
import { LAUNCH_STAGE_LABELS } from '../src/lib/launch-failure'
import type { ApplicationLaunchPlan, ApplicationLaunchSpec } from './application-addons'
import { requiresNodeRuntime, resolveNodeExecutable, type NodeRuntime } from './node-runtime'
import { pathExists } from './profile'
import { formatCommandLine, spawnCommand, withExecutableDirectoryOnPath } from './process'
import { buildNetworkEnvironment } from './proxy'
import {
  detectDshCredentialsFormat,
  isLegacyCredentialsFormatError,
  prepareLegacyCredentials,
  type LegacyCredentialsSession,
} from './dsh-credentials-compat'

/** DSH 进程的生命周期：启动、停止、输出转发与状态广播。 */

/** 从进程输出里识别本地服务地址。 */
export function extractLocalUrl(text: string): string | null {
  const match = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s]*)?/i)
  return match?.[0] ?? null
}

/** 构造 DSH 子进程的环境变量。 */
export function runtimeEnvironment(
  settings: AppSettings,
  base: NodeJS.ProcessEnv,
  pnpm?: { storeRoot?: string; registry?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, DSH_HOME: settings.dshHome, FORCE_COLOR: '0' }
  // Web 端内置更新器 spawn 的系统 pnpm 会继承本进程环境；把 store/registry
  // 与启动器对齐，避免 ERR_PNPM_UNEXPECTED_STORE 或绕开镜像源直连 npmjs。
  if (pnpm?.storeRoot) {
    env.npm_config_store_dir = pnpm.storeRoot
    env.NPM_CONFIG_STORE_DIR = pnpm.storeRoot
    env.pnpm_config_store_dir = pnpm.storeRoot
    env.PNPM_CONFIG_STORE_DIR = pnpm.storeRoot
  }
  if (pnpm?.registry) {
    env.npm_config_registry = pnpm.registry
    env.NPM_CONFIG_REGISTRY = pnpm.registry
  }
  return env
}

export const PORT_FALLBACK_ATTEMPTS = 10

/** 只有明确的 DSH Web 启动命令才注入 --port，避免破坏用户的其他自定义命令。 */
export function isDshWebLaunch(executable: string, args: string[]): boolean {
  const executableName = path.basename(executable).toLowerCase()
  const invokesDsh = executableName === 'dsh' || executableName === 'dsh.cmd' || args.includes(DSH_PACKAGE_NAME)
  const launchesWeb = args.includes('web') || args.some((value, index) => value === '--profile' && args[index + 1] === 'web')
  return invokesDsh && launchesWeb
}

/** 用设置中的首选端口替换可能存在的旧 --port 参数。 */
export function withDshWebPort(executable: string, args: string[], port: number): string[] {
  if (!isDshWebLaunch(executable, args)) return [...args]
  const next: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--port') {
      index += 1
      continue
    }
    if (value.startsWith('--port=')) continue
    next.push(value)
  }
  // DSH Web opens the default browser by itself unless this flag is set.
  // The launcher opens the URL after observing the ready output, so allowing
  // both behaviors would open the same Web page twice.
  if (!next.includes('--no-open')) next.push('--no-open')
  return [...next, '--port', String(port)]
}

/**
 * 整合包的 profile 名不是默认 `web` 时，把 `web` 子命令别名换成显式的
 * `--profile <名>` 前缀：`web` 是 `--profile web` 的硬编码别名，不接受父级
 * `--profile`（实测报 "web takes none of parent --profile"，进程即刻退出）。
 * `dsh --profile <名> --no-open --port N` 以该 profile 启动同一个 web 应用；
 * 用户参数里已自带 --profile 时不覆盖。默认 web 保持原样不动。
 */
export function withDshProfile(args: string[], profileName: string | null | undefined): string[] {
  if (!profileName || profileName === 'web') return [...args]
  if (args.includes('--profile')) return [...args]
  // npx 形态（--yes <pkg> web）下 --profile 必须落在包名之后、npx 旗标之后：
  // 直接用 web 子命令 token 的位置做替换点。
  const webIndex = args.findIndex((value, index) =>
    value === 'web' && (index === 0 || args[index - 1] === DSH_PACKAGE_NAME))
  if (webIndex === -1) return ['--profile', profileName, ...args]
  return [...args.slice(0, webIndex), '--profile', profileName, ...args.slice(webIndex + 1)]
}

export async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(error => resolve(error === undefined))
    })
  })
}

/** 从首选端口开始向后寻找；到达 65535 后从 1 继续。 */
export async function findAvailableWebPort(
  preferredPort: number,
  attempts = PORT_FALLBACK_ATTEMPTS,
  isAvailable: (port: number) => Promise<boolean> = isLoopbackPortAvailable,
): Promise<number | null> {
  const total = Math.max(1, Math.min(65535, Math.floor(attempts)))
  for (let offset = 0; offset < total; offset += 1) {
    const port = ((preferredPort - 1 + offset) % 65535) + 1
    if (await isAvailable(port)) return port
  }
  return null
}

const STDERR_CAPTURE_LIMIT = 24_000
/** officecli 工具首次准备（含 33MB 下载）等待启动的硬顶，超时后台继续。 */
const OFFICE_CLI_PREPARE_TIMEOUT_MS = 180_000

export interface RuntimeControllerOptions {
  readSettings: () => Promise<AppSettings>
  /** 确保有可用的 Node.js，返回其可执行文件位置。 */
  prepareNodeRuntime: () => Promise<NodeRuntime>
  /** 配置的工作目录不存在时的回落目录。 */
  fallbackWorkspace: () => string
  emitOutput: (level: RuntimeOutput['level'], text: string) => void
  emitState: (state: RuntimeState) => void
  openExternal: (url: string) => void
  resolveApplicationLaunchPlan?: () => Promise<ApplicationLaunchPlan>
  spawnProcess?: typeof spawnCommand
  stopProcess?: (processToStop: ChildProcessWithoutNullStreams) => Promise<void>
  /** 启动旧版 DSH 时使用的临时凭据兼容备份目录。 */
  legacyCredentialsBackupRoot?: string
  /** 启动器 pnpm 插件仓库根目录（插件装在 plugin-store 下），供 DSH 子进程继承。 */
  packageStoreRoot?: string
  /** DSH 子进程应使用的 npm 镜像源（默认 npmmirror）。 */
  npmRegistry?: string
  /**
   * 准备机器级外部工具 officecli（含 officecli 技能的整合包首次启动时经镜像下载），
   * 返回可执行文件绝对路径或 null（不需要/拿不到）。永不抛异常。
   */
  prepareOfficeCliTool?: (settings: AppSettings, onProgress: (received: number, totalBytes: number | null) => void) => Promise<string | null>
}

export interface RuntimeController {
  state(): RuntimeState
  failure(): RuntimeFailure | null
  isRunning(): boolean
  start(): Promise<RuntimeState>
  stop(): Promise<RuntimeState>
}

export function createRuntimeController(options: RuntimeControllerOptions): RuntimeController {
  const startProcess = options.spawnProcess ?? spawnCommand
  const runtimeEnv = (settings: AppSettings, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
    runtimeEnvironment(settings, base, {
      storeRoot: options.packageStoreRoot || undefined,
      registry: options.npmRegistry ?? buildNetworkEnvironment(settings).npmRegistry,
    })
  let child: ChildProcessWithoutNullStreams | null = null
  const companions = new Map<string, ChildProcessWithoutNullStreams>()
  let companionTimer: NodeJS.Timeout | null = null
  let startedAt: string | null = null
  let url: string | null = null
  let port: number | null = null
  let lastFailure: RuntimeFailure | null = null
  let launchMode: RuntimeState['launchMode'] = 'web'
  let applicationAddonId: string | null = null
  let applicationAddonName: string | null = null
  let legacyCredentialsSession: LegacyCredentialsSession | null = null
  let startPromise: Promise<RuntimeState> | null = null

  const state = (): RuntimeState => ({
    running: child !== null,
    pid: child?.pid ?? null,
    startedAt,
    url,
    port,
    launchMode,
    applicationAddonId,
    applicationAddonName,
    lastFailure,
  })

  const broadcast = () => options.emitState(state())

  const restoreLegacyCredentials = async (): Promise<void> => {
    const session = legacyCredentialsSession
    legacyCredentialsSession = null
    if (!session) return
    try {
      await session.restore()
    } catch (error) {
      // Do not include the credentials path contents or any secret in the
      // message. The original DSH error remains the useful diagnostic.
      options.emitOutput('error', `旧版 DSH 凭据格式恢复失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const killProcessTree = async (processToStop: ChildProcessWithoutNullStreams): Promise<void> => {
    if (options.stopProcess) {
      await options.stopProcess(processToStop)
      return
    }
    if (process.platform === 'win32' && processToStop.pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(processToStop.pid), '/t', '/f'], { windowsHide: true })
      await new Promise<void>(resolve => {
        killer.once('error', () => resolve())
        killer.once('exit', () => resolve())
      })
      return
    }
    processToStop.kill('SIGTERM')
  }

  const stopCompanions = async (): Promise<void> => {
    if (companionTimer) {
      clearTimeout(companionTimer)
      companionTimer = null
    }
    const running = [...companions.values()]
    companions.clear()
    await Promise.allSettled(running.map(killProcessTree))
  }

  /**
   * 启动前准备机器级 officecli 工具：3 分钟硬顶（慢网下不无限拖住「启动」按钮），
   * 超时/失败按 null 走——后台那次下载仍会完成，下次启动直接命中缓存。
   */
  const prepareOfficeCliToolForLaunch = async (settings: AppSettings): Promise<string | null> => {
    if (!options.prepareOfficeCliTool) return null
    let lastBucket = -1
    const attempt = (async (): Promise<string | null> => {
      try {
        return await options.prepareOfficeCliTool!(settings, (received, total) => {
          const bucket = total && total > 0 ? Math.floor((received / total) * 20) : -1
          if (bucket !== lastBucket) {
            lastBucket = bucket
            const percent = total && total > 0 ? `（${Math.floor((received / total) * 100)}%）` : ''
            options.emitOutput('info', `Office 工具下载中${percent}`)
          }
        })
      } catch {
        return null
      }
    })()
    let timer: NodeJS.Timeout | null = null
    const capped = await Promise.race<string | null>([
      attempt,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), OFFICE_CLI_PREPARE_TIMEOUT_MS) }),
    ])
    if (timer) clearTimeout(timer)
    if (capped === null) {
      attempt.then(exe => {
        if (exe) options.emitOutput('info', 'Office 工具已在后台准备完成，下次启动整合包即可使用。')
      }).catch(() => undefined)
    }
    return capped
  }

  const startCompanions = (
    specs: ApplicationLaunchSpec[],
    settings: AppSettings,
    extraPathExecutable: string | null = null,
  ): void => {
    if (companionTimer) {
      clearTimeout(companionTimer)
      companionTimer = null
    }
    for (const spec of specs) {
      if (companions.has(spec.id)) continue
      try {
        let environment = withExecutableDirectoryOnPath(spec.executable, runtimeEnv(settings, process.env))
        if (extraPathExecutable) environment = withExecutableDirectoryOnPath(extraPathExecutable, environment)
        const companion = startProcess(spec.executable, spec.args, { cwd: spec.cwd, env: environment })
        companions.set(spec.id, companion)
        options.emitOutput('info', `伴随应用命令：${formatCommandLine(spec.executable, spec.args)}\n工作目录：${spec.cwd}`)
        options.emitOutput('info', `伴随应用已启动：${spec.name}`)
        companion.stdout.on('data', chunk => options.emitOutput('info', `[${spec.name}] ${chunk.toString('utf8')}`))
        companion.stderr.on('data', chunk => options.emitOutput('error', `[${spec.name}] ${chunk.toString('utf8')}`))
        companion.once('error', error => options.emitOutput('error', `${spec.name} 启动失败：${error.message}`))
        companion.once('exit', code => {
          companions.delete(spec.id)
          options.emitOutput(code === 0 ? 'success' : 'error', `${spec.name} 已退出（代码 ${code ?? '未知'}）`)
        })
      } catch (error) {
        options.emitOutput('error', `${spec.name} 启动失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async function startOnce(): Promise<RuntimeState> {
    if (child) return state()

    const settings = await options.readSettings()
    // 所有启动失败都从这里落，诊断第一行带阶段：弹窗与提示词才知道该往哪边查——
    // 端口/拉起失败多半是环境问题，运行中退出才可能是 DSH 本身的问题。
    const recordLaunchFailure = (stage: LaunchFailureStage, lines: string[]): void => {
      lastFailure = {
        profileName: settings.profileName,
        stage,
        diagnostics: [`失败阶段：${LAUNCH_STAGE_LABELS[stage]}`, ...lines.filter(Boolean)].join('\n').slice(-STDERR_CAPTURE_LIMIT),
        failedAt: new Date().toISOString(),
      }
    }
    const defaultCwd = (await pathExists(settings.workspace)) ? settings.workspace : options.fallbackWorkspace()
    const applicationPlan = options.resolveApplicationLaunchPlan
      ? await options.resolveApplicationLaunchPlan()
      : { replacement: null, companions: [] }
    const replacement = applicationPlan.replacement
    const cwd = replacement?.cwd ?? defaultCwd

    let executable = replacement?.executable ?? settings.launchExecutable
    let environment = runtimeEnv(settings, process.env)
    let launchArgs = replacement?.args ?? settings.launchArgs
    if (requiresNodeRuntime(executable, launchArgs)) {
      const nodeRuntime = await options.prepareNodeRuntime()
      executable = resolveNodeExecutable(executable, nodeRuntime)
      environment = withExecutableDirectoryOnPath(nodeRuntime.node, environment)
    }
    const officeCliExe = await prepareOfficeCliToolForLaunch(settings)
    if (officeCliExe) environment = withExecutableDirectoryOnPath(officeCliExe, environment)
    // A replacement host is commonly launched as `node entry.js`. Probe the
    // entry script, not node.exe, so an add-on's bundled DSH version can select
    // the correct credentials schema.
    const credentialsProbeExecutable = replacement?.args[0] ?? executable

    launchMode = replacement ? 'application-replacement' : 'web'
    applicationAddonId = replacement?.id ?? null
    applicationAddonName = replacement?.name ?? null
    if (replacement) {
      port = null
      options.emitOutput('info', `启动模式：${replacement.name} 替代普通 DSH Web`)
    } else if (isDshWebLaunch(executable, launchArgs)) {
      const selectedPort = await findAvailableWebPort(settings.webPort)
      if (selectedPort === null) {
        const message = `从端口 ${settings.webPort} 开始连续检测 ${PORT_FALLBACK_ATTEMPTS} 个端口，均不可用。`
        options.emitOutput('error', message)
        recordLaunchFailure('port', [
          message,
          `期望端口：${settings.webPort}（可在「设置 → Web 端口」改）`,
          `启动命令：${formatCommandLine(executable, launchArgs)}`,
          '常见原因：上一个没退干净的 DSH 还占着端口，或被本机其它服务占用。',
        ])
        broadcast()
        throw new Error(message)
      }
      port = selectedPort
      launchArgs = withDshWebPort(executable, launchArgs, selectedPort)
      launchArgs = withDshProfile(launchArgs, settings.profileName)
      if (selectedPort === settings.webPort) {
        options.emitOutput('info', `Web 端口：${selectedPort}`)
      } else {
        options.emitOutput('info', `首选端口 ${settings.webPort} 已被占用，自动改用 ${selectedPort}。`)
      }
    } else {
      port = null
    }

    const commandLine = formatCommandLine(executable, launchArgs)
    options.emitOutput('info', `启动：${commandLine}`)
    options.emitOutput('info', `工作目录：${cwd}`)

    lastFailure = null
    let stderrOutput = ''
    let diagnosticOutput = ''
    // DSH 可能先后输出 localhost、127.0.0.1 或带不同路径的同一服务地址。
    // 自动打开只属于本次启动，不应因后续日志中的地址格式变化再次拉起浏览器。
    let browserOpened = false
    let legacyFallbackEligible = false
    let legacyFallbackAttempted = false
    let initialLegacyCredentials = false
    const selectedLaunchPort = port

    if (options.legacyCredentialsBackupRoot) {
      const format = await detectDshCredentialsFormat(settings.dshVersion ?? null, credentialsProbeExecutable)
      initialLegacyCredentials = format === 'legacy'
      legacyFallbackEligible = format === 'unknown'
    }

    const handleData = (level: RuntimeOutput['level']) => (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      diagnosticOutput = `${diagnosticOutput}${text}`.slice(-STDERR_CAPTURE_LIMIT)
      if (level === 'error') stderrOutput = `${stderrOutput}${text}`.slice(-STDERR_CAPTURE_LIMIT)
      options.emitOutput(level, text)
      const foundUrl = extractLocalUrl(text)
      if (foundUrl && foundUrl !== url) {
        url = foundUrl
        broadcast()
        if (!replacement && settings.openAfterLaunch && !browserOpened) {
          browserOpened = true
          options.openExternal(foundUrl)
        }
        startCompanions(applicationPlan.companions, settings, officeCliExe)
      }
    }

    const scheduleCompanions = () => {
      if (applicationPlan.companions.length === 0) return
      companionTimer = setTimeout(() => startCompanions(applicationPlan.companions, settings, officeCliExe), 5_000)
      companionTimer.unref()
    }

    let launchAttempt: (useLegacyCredentials: boolean) => Promise<void>
    const handleExit = async (code: number | null) => {
      // stop() 会先把 child 置空，据此区分主动停止与意外退出。
      const expected = child === null
      child = null
      port = null
      void stopCompanions()

      if (!expected && code !== 0 && legacyFallbackEligible && !legacyFallbackAttempted && isLegacyCredentialsFormatError(diagnosticOutput)) {
        legacyFallbackAttempted = true
        await restoreLegacyCredentials()
        lastFailure = null
        options.emitOutput('info', '无法确认 DSH 版本且新版凭据格式不兼容，正在切换旧版格式重试一次。')
        try {
          await launchAttempt(true)
          return
        } catch (error) {
          options.emitOutput('error', `旧版凭据格式重试启动失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      await restoreLegacyCredentials()
      if (!expected && code !== 0 && stderrOutput.includes('EADDRINUSE')) {
        options.emitOutput('error', '选中的本地端口在启动过程中被其他进程占用，请重新启动，启动器会继续选择其他可用端口。')
      }
      if (!expected && code !== 0) {
        recordLaunchFailure('exited', [
          `启动命令：${commandLine}`,
          `工作目录：${cwd}`,
          `退出代码：${code ?? '未知'}`,
          '',
          diagnosticOutput.trim() || '进程没有输出诊断信息。',
        ])
      }
      const processName = replacement?.name ?? 'DSH'
      options.emitOutput(code === 0 || expected ? 'success' : 'error', `${processName} 已退出（代码 ${code ?? '未知'}）`)
      broadcast()
    }

    launchAttempt = async (useLegacyCredentials: boolean): Promise<void> => {
      if (useLegacyCredentials && options.legacyCredentialsBackupRoot) {
        legacyCredentialsSession = await prepareLegacyCredentials(
          settings.dshHome,
          settings.dshVersion ?? null,
          credentialsProbeExecutable,
          options.legacyCredentialsBackupRoot,
          { force: true },
        )
        if (legacyCredentialsSession) options.emitOutput('info', '正在使用旧版 DSH 凭据格式重试，停止后自动恢复。')
      }

      let started: ChildProcessWithoutNullStreams
      try {
        started = startProcess(executable, launchArgs, { cwd, env: environment })
      } catch (error) {
        // 同步抛错＝进程根本没起来（可执行文件不存在、路径非法、EPERM）。
        // 不记就只剩一条 toast，用户和 agent 都不知道死在哪。
        const message = error instanceof Error ? error.message : String(error)
        recordLaunchFailure('spawn', [
          `原因：${message}`,
          `启动命令：${commandLine}`,
          `工作目录：${cwd}`,
          error instanceof Error ? (error.stack ?? '') : '',
        ])
        broadcast()
        await restoreLegacyCredentials()
        throw error
      }
      child = started
      port = selectedLaunchPort
      startedAt = new Date().toISOString()
      url = null
      broadcast()
      started.stdout.on('data', handleData('info'))
      started.stderr.on('data', handleData('error'))

      started.once('error', error => {
        recordLaunchFailure('spawn', [
          `原因：${error.message}`,
          `启动命令：${commandLine}`,
          `工作目录：${cwd}`,
          diagnosticOutput,
          error.stack ?? '',
        ])
        options.emitOutput('error', `启动失败：${error.message}`)
        void stopCompanions()
        void restoreLegacyCredentials()
        broadcast()
      })
      started.once('exit', code => { void handleExit(code) })
      scheduleCompanions()
    }

    await launchAttempt(initialLegacyCredentials)

    return state()
  }

  async function start(): Promise<RuntimeState> {
    if (child) return state()
    if (startPromise) return startPromise

    const pending = startOnce()
    startPromise = pending
    try {
      return await pending
    } finally {
      if (startPromise === pending) startPromise = null
    }
  }

  async function stop(): Promise<RuntimeState> {
    const running = child
    if (!running) {
      await stopCompanions()
      await restoreLegacyCredentials()
      return state()
    }
    child = null
    port = null
    applicationAddonId = null
    applicationAddonName = null

    await Promise.allSettled([killProcessTree(running), stopCompanions()])
    await restoreLegacyCredentials()

    options.emitOutput('info', '已发送停止请求。')
    broadcast()
    return state()
  }

  return {
    state,
    failure: () => lastFailure,
    isRunning: () => child !== null,
    start,
    stop,
  }
}
