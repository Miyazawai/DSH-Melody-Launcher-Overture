import { useCallback, useEffect, useRef, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { DSH_REPOSITORY, EMPTY_DSH_INSTALLATION, EMPTY_RUNTIME_STATE, MAX_LOG_LINES } from '../constants'
import { downloadProgressText, errorText } from '../lib/format'
import { launchFailureHeadline, launchFailureStageLabel } from '../lib/launch-failure'
import { finalizeInstallProgress } from '../lib/install-progress'
import { reorderProfilePlugins } from '../lib/profile-order'
import type {
  ApplicationInstallResult,
  AppSettings,
  CatalogAnalysisProgress,
  CredentialStatus,
  CustomApiProvider,
  CustomApiProviderInput,
  DshInstallationStatus,
  DshUpdateStatus,
  GitHubAuthStatus,
  InstallProgress,
  LauncherApi,
  OfficialPackRelease,
  OfficialPackStatus,
  InstalledPreset,
  InstalledSkill,
  InstalledApplicationAddon,
  LauncherUpdateProgress,
  LauncherUpdateStatus,
  ManagedPlugin,
  PackDownloadProgress,
  PackExportPrivacy,
  PackStageProgress,
  PackStatus,
  ProfileSummary,
  PluginTrialResult,
  PresetInstallResult,
  ProfileState,
  RecommendedWebUiStatus,
  RepositoryInstallResult,
  RuntimeOutput,
  RuntimeEnvironmentState,
  RuntimeFailure,
  RuntimeState,
  SkillInstallResult,
} from '../types'
import { BUSY, useAsyncAction } from './use-async-action'
import { useToast } from './use-toast'

/**
 * 启动器的领域状态与全部写操作。
 * 界面导航、对话框开关等纯展示状态不在这里 —— 那些由 App 自己持有。
 */

/** toggleRuntime 的结果，调用方据此决定是否切换到日志视图。 */
export type RuntimeToggleResult = 'installed' | 'started' | 'stopped' | 'failed'

export function pluginTrialStateKey(profileName: string, packageName: string): string {
  return `${profileName}:${packageName}`
}

export function useLauncherStore() {
  const api = useLauncherApi()
  const { toast, showToast, dismissToast } = useToast()
  const { busy, run } = useAsyncAction(showToast)

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [recommendedWebUi, setRecommendedWebUi] = useState<RecommendedWebUiStatus | null>(null)
  const [profile, setProfile] = useState<ProfileState | null>(null)
  const [runtime, setRuntime] = useState<RuntimeState>(EMPTY_RUNTIME_STATE)
  /** 最近一次 DSH 异常退出详情；用于 PCL2 式失败弹窗（日志 + 修复引导）。 */
  const [dshFailure, setDshFailure] = useState<RuntimeFailure | null>(null)
  const [dshInstallation, setDshInstallation] = useState<DshInstallationStatus>(EMPTY_DSH_INSTALLATION)
  const [dshUpdate, setDshUpdate] = useState<DshUpdateStatus | null>(null)
  const [runtimeEnvironment, setRuntimeEnvironment] = useState<RuntimeEnvironmentState | null>(null)
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdateStatus | null>(null)
  const [launcherUpdateProgress, setLauncherUpdateProgress] = useState<LauncherUpdateProgress | null>(null)
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null)
  const [pluginTrials, setPluginTrials] = useState<Record<string, PluginTrialResult>>({})
  const [installedRepositories, setInstalledRepositories] = useState<Set<string>>(new Set())
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([])
  const [installedApplications, setInstalledApplications] = useState<InstalledApplicationAddon[]>([])
  const [installedPresets, setInstalledPresets] = useState<InstalledPreset[]>([])
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>({ configured: false })
  const [customApiProviders, setCustomApiProviders] = useState<CustomApiProvider[]>([])
  const [customApiLoading, setCustomApiLoading] = useState(false)
  const [githubAuthStatus, setGitHubAuthStatus] = useState<GitHubAuthStatus>({
    authenticated: false,
    login: null,
    name: null,
    avatarUrl: null,
    scopes: [],
    method: null,
    oauthAvailable: false,
    rateLimit: null,
  })
  const githubAuthRefreshVersion = useRef(0)
  const [logs, setLogs] = useState<RuntimeOutput[]>([])
  // 真实进程输出（onRuntimeOutput）的计数：App 用它判断是否自动弹出运行日志，
  // 市场/目录同步等合成的进度日志不会计入，避免切页时灵动岛被顶出来。
  const [processLogCount, setProcessLogCount] = useState(0)
  const progressLogBuckets = useRef<Record<string, { phase: InstallProgress['phase']; bucket: number; message: string }>>({})
  const catalogProgressLogState = useRef<Record<string, string>>({})
  // 安装进度事件在 npm 下载/落盘阶段可能高频到达，每次都 setState 会引发全应用
  // 重渲染风暴（输入框都跟着卡）。按时间窗合帧：120ms 内只渲染最后一帧；
  // 完成/出错立即透传。定时器在卸载时清理。
  const installProgressFrame = useRef<{ latest: InstallProgress | null; lastFlushAt: number; timer: number | null }>({ latest: null, lastFlushAt: 0, timer: null })
  // 已提示过的运行时失败时间戳（同一失败只弹一次 toast）。
  const runtimeFailureToastedAt = useRef<string | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null)
  const [packs, setPacks] = useState<PackStatus[]>([])
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [packSnapshotsAvailable, setPackSnapshotsAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const activeRuntimeReplacement = installedApplications.find(
    application => application.enabled && application.launchMode === 'runtime-replacement',
  ) ?? null

  /** 保留原选中项；它已不存在时退回列表首项。 */
  const adoptProfile = useCallback((next: ProfileState) => {
    setProfile(next)
    setSelectedPlugin(current => current && next.plugins.some(plugin => plugin.packageName === current)
      ? current
      : next.plugins[0]?.packageName ?? null)
  }, [])

  const appendRuntimeLog = useCallback((entry: Omit<RuntimeOutput, 'timestamp'>) => {
    setLogs(current => {
      const previous = current[current.length - 1]
      if (previous && previous.channel === entry.channel && previous.level === entry.level && previous.text === entry.text) return current
      return [...current.slice(-(MAX_LOG_LINES - 1)), { ...entry, timestamp: new Date().toISOString() }]
    })
  }, [])

  useEffect(() => {
    let disposed = false
    void Promise.all([
      api.getSettings(),
      api.readProfile(),
      api.getRuntimeState(),
      // 凭据文件损坏时凭据状态未知，但不应阻塞整个启动器加载。
      api.getDeepSeekCredentialStatus().catch(error => {
        showToast({ kind: 'error', message: errorText(error) })
        return { configured: false }
      }),
      api.detectDshInstallation(),
      api.readInstalledSkills(),
      api.readInstalledApplications(),
      api.readInstalledPresets(),
      api.listPacks(),
      api.listProfiles(),
      api.packHasSnapshot(),
      api.readPluginTrials(),
      api.listCustomApiProviders().catch(() => [] as CustomApiProvider[]),
    ])
      .then(([nextSettings, nextProfile, nextRuntime, nextCredentialStatus, nextDshInstallation, nextInstalledSkills, nextInstalledApplications, nextInstalledPresets, nextPacks, nextProfiles, nextPackSnapshot, nextPluginTrials, nextCustomApiProviders]) => {
        setSettings(nextSettings)
        setProfile(nextProfile)
        setRuntime(nextRuntime)
        setCredentialStatus(nextCredentialStatus)
        setDshInstallation(nextDshInstallation)
        setInstalledSkills(nextInstalledSkills)
        setInstalledApplications(nextInstalledApplications)
        setInstalledPresets(nextInstalledPresets)
        setSelectedPlugin(nextProfile.plugins[0]?.packageName ?? null)
        setPacks(nextPacks)
        setProfiles(nextProfiles)
        setPackSnapshotsAvailable(nextPackSnapshot)
        setPluginTrials(Object.fromEntries(nextPluginTrials.map(result => [pluginTrialStateKey(result.profileName, result.packageName), result])))
        setCustomApiProviders(nextCustomApiProviders)
      })
      .catch(error => showToast({ kind: 'error', message: errorText(error) }))
      .finally(() => setLoading(false))

    // GitHub 凭据状态独立加载；读取失败时短暂重试，避免一次 IPC/启动时序问题把已登录账号卡成未登录。
    const refreshGitHubAuth = async (attempt = 0, refreshVersion?: number): Promise<void> => {
      if (disposed) return
      const version = refreshVersion ?? ++githubAuthRefreshVersion.current
      try {
        const next = await api.getGitHubAuthStatus()
        if (!disposed && version === githubAuthRefreshVersion.current) setGitHubAuthStatus(next)
        // safeStorage can become available just after the first IPC call.
        // Retry a transient unauthenticated read so a valid encrypted session
        // is not presented as logged out until the next window focus event.
        if (!next.authenticated && !disposed && attempt < 2) {
          const delay = attempt === 0 ? 250 : 1_000
          await new Promise<void>(resolve => window.setTimeout(resolve, delay))
          await refreshGitHubAuth(attempt + 1, version)
        }
      } catch {
        if (disposed || attempt >= 2) return
        const delay = attempt === 0 ? 250 : 1_000
        await new Promise<void>(resolve => window.setTimeout(resolve, delay))
        await refreshGitHubAuth(attempt + 1, version)
      }
    }
    void refreshGitHubAuth()
    const onWindowFocus = () => { void refreshGitHubAuth() }
    window.addEventListener('focus', onWindowFocus)

    // 更新检查必须在后台进行，网络不可用时不能阻塞启动页。
    void api.checkDshUpdate()
      .then(next => { if (!disposed) setDshUpdate(next) })
      .catch(() => { /* 主进程已把网络失败转换为状态；演示 API 也不应阻塞启动 */ })

    // 官方整合包状态（推荐版本 / 是否有更新）：主进程启动核对也会推一次，
    // 这里主动读一次以免事件晚到或丢失时「有新版本」徽标不出现。主进程侧已做请求合流。
    void api.readOfficialPackStatus(false)
      .then(next => { if (!disposed) setOfficialStatus(next) })
      .catch(() => { /* 状态读失败不影响整合包页其它功能 */ })

    void api.readRuntimeEnvironment()
      .then(next => { if (!disposed) setRuntimeEnvironment(next) })
      .catch(() => { /* 版本索引失败不阻塞其他页面 */ })

    // 启动器自更新：同样后台检测；发现新版本后自动开始下载，UI 提示由 AppHeader 的更新按钮承载。
    void api.checkLauncherUpdate()
      .then(next => {
        if (disposed) return
        setLauncherUpdate(next)
        if (next.state === 'update-available') {
          void api.downloadLauncherUpdate()
            .then(downloaded => { if (!disposed) setLauncherUpdate(downloaded) })
            .catch(() => { /* 下载失败由主进程收敛为 error 状态，这里静默 */ })
        }
      })
      .catch(() => { /* 主进程已把网络失败转换为 error 状态 */ })

    const handleInstallProgress = (progress: InstallProgress) => {
        const frame = installProgressFrame.current
        if (progress.phase === 'complete' || progress.phase === 'error' || progress.phase !== frame.latest?.phase) {
          // 终态与阶段切换立即渲染；挂起的尾随帧一并作废。
          if (frame.timer != null) {
            window.clearTimeout(frame.timer)
            frame.timer = null
          }
          frame.latest = progress
          frame.lastFlushAt = Date.now()
          setInstallProgress(progress)
        } else {
          frame.latest = progress
          const elapsed = Date.now() - frame.lastFlushAt
          if (elapsed >= 120) {
            frame.lastFlushAt = Date.now()
            setInstallProgress(progress)
          } else if (frame.timer == null) {
            frame.timer = window.setTimeout(() => {
              frame.timer = null
              if (frame.latest) {
                frame.lastFlushAt = Date.now()
                setInstallProgress(frame.latest)
              }
            }, 120 - elapsed)
          }
        }
        const key = `${progress.kind}:${progress.repository}`
        const bucket = Math.floor(progress.percent / 10)
        const previous = progressLogBuckets.current[key]
        const waitingHeartbeat = progress.message.startsWith('安装中 · 已等待')
        const shouldLog = !previous
          || previous.phase !== progress.phase
          || previous.bucket !== bucket
          || (waitingHeartbeat && previous.message !== progress.message)
          || progress.phase === 'error'
          || progress.phase === 'complete'
        if (shouldLog) {
          progressLogBuckets.current[key] = { phase: progress.phase, bucket, message: progress.message }
          const channel: RuntimeOutput['channel'] = progress.kind === 'dsh' ? 'runtime' : 'plugin'
          const size = progress.downloadedBytes != null
            ? ` · ${progress.downloadedBytes}${progress.totalBytes != null ? `/${progress.totalBytes}` : ''} B`
            : ''
          const entry: RuntimeOutput = {
            channel,
            level: progress.phase === 'error' ? 'error' : progress.phase === 'complete' ? 'success' : 'info',
            text: `[${progress.repository}] ${progress.message} · ${progress.percent}%${size}`,
            timestamp: new Date().toISOString(),
          }
          appendRuntimeLog(entry)
        }
      }

      const handleCatalogAnalysisProgress = (progress: CatalogAnalysisProgress) => {
        const signature = `${progress.phase}:${progress.completed}:${progress.message}`
        if (catalogProgressLogState.current[progress.repository] === signature) return
        catalogProgressLogState.current[progress.repository] = signature
        appendRuntimeLog({
          channel: 'plugin',
          level: progress.phase === 'error' ? 'error' : progress.phase === 'complete' ? 'success' : 'info',
          text: `[${progress.repository}] ${progress.message} · ${progress.completed}/${progress.total}`,
        })
      }

    const unsubscribers = [
      api.onRuntimeOutput(output => {
        appendRuntimeLog(output)
        setProcessLogCount(current => current + 1)
      }),
      api.onRuntimeState(state => {
        setRuntime(state)
        // 非正常退出（如启动参数被 DSH 拒绝）主进程会记诊断；日志抽屉已移除，
        // 这里用 toast 把原因递到用户眼前，避免「启动一会就停了」无从查起。
        const failure = state.lastFailure
        if (failure && failure.failedAt !== runtimeFailureToastedAt.current) {
          runtimeFailureToastedAt.current = failure.failedAt
          // 与弹窗共用同一套解析，避免 toast 和弹窗各说一句话。
          showToast({ kind: 'error', message: `DSH ${launchFailureStageLabel(failure.stage)}：${launchFailureHeadline(failure.diagnostics)}`.slice(0, 220) })
          setDshFailure(failure)
        }
      }),
      api.onInstallProgress(handleInstallProgress),
      api.onCatalogAnalysisProgress(handleCatalogAnalysisProgress),
      api.onDshMarketProgress(progress => {
        // 市场的插件级操作（安装/更新/卸载）与目录同步一样，只写日志行，
        // 不进入安装活动状态：避免触发灵动岛自动弹出、整合包切换/启动被短时锁定。
        if (typeof progress.message === 'string' && progress.message.trim()) {
          appendRuntimeLog({
            channel: 'plugin',
            level: progress.phase === 'error' ? 'error' : progress.phase === 'complete' ? 'success' : 'info',
            text: `[dsh-market] ${progress.message} · ${progress.percent ?? 0}%`,
          })
        }
      }),
      api.onLauncherUpdateProgress(progress => {
        setLauncherUpdateProgress(progress)
        setLauncherUpdate(current => current ? { ...current, state: progress.phase === 'applying' ? 'applying' : 'downloading' } : current)
      }),
      api.onPluginTrialEvent(result => {
        setPluginTrials(current => ({ ...current, [pluginTrialStateKey(result.profileName, result.packageName)]: result }))
        appendRuntimeLog({
          channel: 'test',
          level: result.phase === 'failed' ? 'error' : result.phase === 'passed' ? 'success' : 'info',
          text: result.phase === 'running'
            ? `插件试运行：${result.packageName}（来源整合包：${result.profileName}）`
            : result.message,
        })
      }),
    ]
    return () => {
      disposed = true
      window.removeEventListener('focus', onWindowFocus)
      unsubscribers.forEach(unsubscribe => unsubscribe())
      if (installProgressFrame.current.timer != null) {
        window.clearTimeout(installProgressFrame.current.timer)
        installProgressFrame.current.timer = null
      }
    }
  }, [api, showToast])

  const refreshProfile = useCallback(async () => {
    try {
      adoptProfile(await api.readProfile())
    } catch (error) {
      showToast({ kind: 'error', message: errorText(error) })
    }
  }, [adoptProfile, api, showToast])

  /** 插件管理页的「刷新」：整合包之外的 Skill、加载项、预设都是全局资源，需一并重读。 */
  const refreshSecondaryResources = useCallback(async () => {
    try {
      const [skills, applications, presets] = await Promise.all([
        api.readInstalledSkills(),
        api.readInstalledApplications(),
        api.readInstalledPresets(),
      ])
      setInstalledSkills(skills)
      setInstalledApplications(applications)
      setInstalledPresets(presets)
    } catch (error) {
      showToast({ kind: 'error', message: errorText(error) })
    }
  }, [api, showToast])

  const refreshCustomApiProviders = useCallback(async (): Promise<boolean> => {
    setCustomApiLoading(true)
    try {
      setCustomApiProviders(await api.listCustomApiProviders())
      return true
    } catch (error) {
      showToast({ kind: 'error', message: errorText(error) })
      return false
    } finally {
      setCustomApiLoading(false)
    }
  }, [api, showToast])

  /** 安装完成后一次性同步受影响的几处状态。 */
  const applyInstallResult = useCallback((result: RepositoryInstallResult) => {
    setSettings(result.settings)
    adoptProfile(result.profile)
    setDshInstallation(result.dshInstallation)
  }, [adoptProfile])

  const adoptCatalogInstallationState = useCallback((
    repositories: string[],
    skills: InstalledSkill[],
    applications: InstalledApplicationAddon[],
    presets: InstalledPreset[],
  ) => {
    setInstalledRepositories(new Set(repositories.map(repository => repository.toLowerCase())))
    setInstalledSkills(skills)
    setInstalledApplications(applications)
    setInstalledPresets(presets)
  }, [])

  const applyCatalogPluginInstall = useCallback((repository: string, result: RepositoryInstallResult) => {
    applyInstallResult(result)
    setInstalledRepositories(current => new Set(current).add(repository.toLowerCase()))
    if (result.packageName && result.installedProfileName) {
      const key = pluginTrialStateKey(result.installedProfileName, result.packageName)
      setPluginTrials(current => {
        const next = { ...current }
        delete next[key]
        return next
      })
    }
  }, [applyInstallResult])

  const applyCatalogSkillInstall = useCallback((result: SkillInstallResult) => {
    setInstalledSkills(result.installedSkills)
  }, [])

  const applyCatalogApplicationInstall = useCallback((result: ApplicationInstallResult) => {
    setInstalledApplications(result.installedAddons)
    adoptProfile(result.profile)
  }, [adoptProfile])

  const applyCatalogPresetInstall = useCallback((result: PresetInstallResult) => {
    setInstalledPresets(result.installedPresets)
  }, [])

  const beginInstall = useCallback((progress: InstallProgress) => {
    setInstallProgress(progress)
    appendRuntimeLog({
      channel: progress.kind === 'dsh' ? 'runtime' : 'plugin',
      level: 'info',
      text: `[${progress.repository}] ${progress.message} · ${progress.percent}%`,
    })
  }, [appendRuntimeLog])

  const finishInstall = useCallback((repository: string, succeeded = false, message = '安装失败') => {
    setInstallProgress(current => finalizeInstallProgress(current, repository, succeeded, message))
    appendRuntimeLog({
      channel: repository === DSH_REPOSITORY ? 'runtime' : 'plugin',
      level: succeeded ? 'success' : 'error',
      text: `[${repository}] ${succeeded ? '安装完成' : message}`,
    })
  }, [appendRuntimeLog])

  const installDsh = useCallback(async (): Promise<RepositoryInstallResult | undefined> => {
    setInstallProgress({
      repository: DSH_REPOSITORY,
      kind: 'dsh',
      phase: 'preparing',
      percent: 0,
      message: '正在准备本地 DSH',
    })
    const result = await run(BUSY.dshInstall, () => api.installPlugin(DSH_REPOSITORY), {
      success: installed => `本地 DSH ${installed.dshInstallation.version ?? ''} 已安装，可以启动。`,
    })
    if (!result) return undefined
    applyInstallResult(result)
    void api.checkDshUpdate().then(setDshUpdate).catch(() => undefined)
    return result
  }, [api, applyInstallResult, run])

  /**
   * 首页主按钮。尚未安装 DSH 时先完成部署，之后才是启动/停止。
   */
  const toggleRuntime = useCallback(async (): Promise<RuntimeToggleResult> => {
    const needsInstallation = !runtime.running && !dshInstallation.installed && !activeRuntimeReplacement
    if (needsInstallation) {
      const result = await installDsh()
      if (!result) return 'failed'
      return 'installed'
    }

    const wasRunning = runtime.running
    const next = await run(BUSY.runtime, () => wasRunning ? api.stopRuntime() : api.startRuntime())
    if (!next) return 'failed'
    setRuntime(next)
    return wasRunning ? 'stopped' : 'started'
  }, [activeRuntimeReplacement, dshInstallation.installed, installDsh, run, runtime.running])

  const updateDsh = useCallback(async (): Promise<boolean> => {
    const result = await installDsh()
    return result !== undefined
  }, [installDsh])

  const applyRuntimeEnvironment = useCallback(async (next: RuntimeEnvironmentState) => {
    setRuntimeEnvironment(next)
    setSettings(await api.getSettings())
    setDshInstallation(await api.detectDshInstallation())
  }, [api])

  const refreshRuntimeEnvironment = useCallback(async (refresh = false): Promise<boolean> => {
    const next = await run('runtime-environment-read', () => api.readRuntimeEnvironment(refresh), {
      onError: error => showToast({ kind: 'error', message: errorText(error) }),
    })
    if (!next) return false
    setRuntimeEnvironment(next)
    return true
  }, [api, run, showToast])

  const installDshVersion = useCallback(async (version: string): Promise<boolean> => {
    const next = await run(`runtime-dsh-install:${version}`, () => api.installDshVersion(version), {
      success: `DSH ${version} 已安装并设为当前版本。`,
      onError: error => {
        const message = errorText(error)
        setInstallProgress({ repository: version.replace(/^v/i, ''), kind: 'dsh', phase: 'error', percent: 0, message, indeterminate: false })
        showToast({ kind: 'error', message })
      },
    })
    if (!next) return false
    await applyRuntimeEnvironment(next)
    return true
  }, [api, applyRuntimeEnvironment, run, showToast])

  const selectDshVersion = useCallback(async (version: string): Promise<boolean> => {
    const next = await run(`runtime-dsh-select:${version}`, () => api.selectDshVersion(version), {
      success: `DSH ${version} 已设为当前启动版本。`,
      onError: error => showToast({ kind: 'error', message: errorText(error) }),
    })
    if (!next) return false
    await applyRuntimeEnvironment(next)
    return true
  }, [api, applyRuntimeEnvironment, run, showToast])

  const removeDshVersion = useCallback(async (version: string): Promise<boolean> => {
    const next = await run(`runtime-dsh-remove:${version}`, () => api.removeDshVersion(version), {
      success: `DSH ${version} 已删除。`,
      onError: error => showToast({ kind: 'error', message: errorText(error) }),
    })
    if (!next) return false
    await applyRuntimeEnvironment(next)
    return true
  }, [api, applyRuntimeEnvironment, run, showToast])

  const installNodeVersion = useCallback(async (version: string): Promise<boolean> => {
    const next = await run(`runtime-node-install:${version}`, () => api.installNodeVersion(version), {
      success: `Node.js ${version} 已安装并设为当前版本。`,
      onError: error => {
        const message = errorText(error)
        setInstallProgress({ repository: version.replace(/^v/i, ''), kind: 'dsh', phase: 'error', percent: 0, message, indeterminate: false })
        showToast({ kind: 'error', message })
      },
    })
    if (!next) return false
    await applyRuntimeEnvironment(next)
    return true
  }, [api, applyRuntimeEnvironment, run, showToast])

  const cancelRuntimeDownload = useCallback(async (): Promise<void> => {
    try {
      await api.cancelRuntimeEnvironmentOperation()
    } catch (error) {
      showToast({ kind: 'error', message: errorText(error) })
    }
  }, [api, appendRuntimeLog, showToast])

  const selectNodeVersion = useCallback(async (version: string | null): Promise<boolean> => {
    const next = await run(`runtime-node-select:${version ?? 'system'}`, () => api.selectNodeVersion(version), {
      success: version ? `Node.js ${version} 已设为当前运行环境。` : '已恢复使用系统 Node.js。',
      onError: error => showToast({ kind: 'error', message: errorText(error) }),
    })
    if (!next) return false
    await applyRuntimeEnvironment(next)
    return true
  }, [api, applyRuntimeEnvironment, run, showToast])

  const removeNodeVersion = useCallback(async (version: string): Promise<boolean> => {
    const next = await run(`runtime-node-remove:${version}`, () => api.removeNodeVersion(version), {
      success: `Node.js ${version} 已删除。`,
      onError: error => showToast({ kind: 'error', message: errorText(error) }),
    })
    if (!next) return false
    await applyRuntimeEnvironment(next)
    return true
  }, [api, applyRuntimeEnvironment, run, showToast])

  /** 启动器自更新：检测到新版本后自动开始后台下载（幂等，已有临时文件则跳过）。 */
  const downloadLauncherUpdate = useCallback(async (): Promise<LauncherUpdateStatus | null> => {
    const next = await run('launcher-update-download', () => api.downloadLauncherUpdate(), {
      success: status => status.state === 'downloaded'
        ? `启动器新版本已下载（${status.assetName ?? ''}）。`
        : '启动器更新正在后台下载…',
      onError: error => showToast({ kind: 'error', message: errorText(error) }),
    })
    if (next) {
      setLauncherUpdate(next)
      if (next.state !== 'downloading') setLauncherUpdateProgress(null)
    }
    return next ?? null
  }, [api, run, showToast])

  /** 用户点击「立即更新」：应用自动关闭 → 原位替换 exe → 重启。 */
  const applyLauncherUpdate = useCallback(async (): Promise<void> => {
    await run('launcher-update-apply', () => api.applyLauncherUpdate(), {
      success: '正在应用更新并重启启动器…',
      onError: error => showToast({ kind: 'error', message: errorText(error) }),
    })
  }, [api, run])

  const saveSettings = useCallback(async (next: AppSettings): Promise<boolean> => {
    const saved = await run(BUSY.settings, async () => {
      const stored = await api.saveSettings(next)
      setSettings(stored)
      setDshInstallation(await api.detectDshInstallation())
      setCredentialStatus(await api.getDeepSeekCredentialStatus())
      setCustomApiProviders(await api.listCustomApiProviders())
      await refreshProfile()
      return stored
    }, { success: '设置已保存。' })
    return saved !== undefined
  }, [api, refreshProfile, run])

  const saveApiKey = useCallback(async (apiKey: string): Promise<boolean> => {
    const status = await run(BUSY.credential, () => api.setDeepSeekApiKey(apiKey), {
      success: 'DeepSeek API Key 已保存，DSH 可立即使用。',
    })
    if (!status) return false
    setCredentialStatus(status)
    return true
  }, [api, run])

  const clearApiKey = useCallback(async (): Promise<boolean> => {
    const status = await run(BUSY.credential, () => api.clearDeepSeekApiKey(), {
      success: 'DeepSeek API Key 已清除。',
    })
    if (!status) return false
    setCredentialStatus(status)
    return true
  }, [api, run])

  const togglePlugin = useCallback(async (plugin: ManagedPlugin, enabled: boolean) => {
    const linked = installedApplications.some(application =>
      application.repository.toLowerCase() === plugin.repositoryFullName?.toLowerCase(),
    )
    const actionKey = linked && plugin.repositoryFullName
      ? `component:${plugin.repositoryFullName.toLowerCase()}`
      : plugin.packageName
    const next = await run(actionKey, () => api.togglePlugin(plugin.packageName, enabled), {
      success: linked
        ? enabled ? '协同 Plugin 与应用加载项已激活。' : '协同 Plugin 与应用加载项已停用。'
        : enabled ? '插件将在下次启动时加载。' : '插件已停用，但仍保留在本机。',
    })
    if (!next) return false
    adoptProfile(next.profile)
    setInstalledApplications(next.installedApplications)
    return true
  }, [adoptProfile, api, installedApplications, run])

  const readRecommendedWebUi = useCallback(async (): Promise<RecommendedWebUiStatus> => {
    const statusValue = await api.recommendedWebUiStatus()
    setRecommendedWebUi(statusValue)
    return statusValue
  }, [api])

  const installRecommendedWebUi = useCallback(async (options: { suspendOthers?: boolean }): Promise<boolean> => {
    const result = await run('recommended-web-ui', () => api.recommendedWebUiInstall(options), {
      success: options.suspendOthers
        ? '官方推荐整合包已安装并启用，其它插件暂不启用。'
        : '官方推荐整合包已安装并启用。',
    })
    if (result) {
      setRecommendedWebUi(result)
      await refreshProfile()
    }
    return result !== undefined
  }, [api, refreshProfile, run])

  const markRecommendedWebUiPrompted = useCallback(async (): Promise<void> => {
    if (!settings || settings.recommendedWebUiPrompted) return
    const next = { ...settings, recommendedWebUiPrompted: true }
    await api.saveSettings(next)
    setSettings(next)
  }, [api, settings])

  const toggleSkill = useCallback(async (skill: InstalledSkill, enabled: boolean) => {
    const next = await run(`skill:${skill.name}`, () => api.toggleSkill(skill.name, enabled), {
      success: enabled ? `Skill「${skill.name}」已启用。` : `Skill「${skill.name}」已停用。`,
    })
    if (next) setInstalledSkills(next)
  }, [api, run])

  const uninstallSkill = useCallback(async (skill: InstalledSkill): Promise<boolean> => {
    const next = await run(`skill-remove:${skill.name}`, () => api.uninstallSkill(skill.name), {
      success: `Skill「${skill.name}」已卸载。`,
    })
    if (!next) return false
    setInstalledSkills(next)
    return true
  }, [api, run])

  const saveCustomApi = useCallback(async (input: CustomApiProviderInput): Promise<boolean> => {
    const providers = await run(BUSY.credential, () => api.saveCustomApiProvider(input), {
      success: `${input.displayName.trim() || input.route} 已保存。`,
    })
    if (!providers) return false
    setCustomApiProviders(providers)
    return true
  }, [api, run])

  const removeCustomApi = useCallback(async (route: string): Promise<boolean> => {
    const providers = await run(BUSY.credential, () => api.removeCustomApiProvider(route), {
      success: `自定义 API「${route}」已删除。`,
    })
    if (!providers) return false
    setCustomApiProviders(providers)
    return true
  }, [api, run])

  const toggleApplication = useCallback(async (application: InstalledApplicationAddon, enabled: boolean) => {
    const linked = profile?.plugins.some(plugin =>
      plugin.repositoryFullName?.toLowerCase() === application.repository.toLowerCase(),
    ) ?? false
    const actionKey = linked
      ? `component:${application.repository.toLowerCase()}`
      : `application:${application.id}`
    const next = await run(actionKey, () => api.toggleApplication(application.id, enabled), {
      success: linked
        ? enabled ? '协同应用加载项与 Plugin 已激活。' : '协同应用加载项与 Plugin 已停用。'
        : enabled
          ? `${application.name} 已激活，将按“${application.launchMode}”模式参与下次启动。`
          : `${application.name} 已停用。`,
    })
    if (next) {
      adoptProfile(next.profile)
      setInstalledApplications(next.installedApplications)
    }
  }, [adoptProfile, api, profile, run])

  const uninstallApplication = useCallback(async (application: InstalledApplicationAddon) => {
    const next = await run(`application-remove:${application.id}`, () => api.uninstallApplication(application.id), {
      success: `${application.name} 已卸载。`,
    })
    if (next) setInstalledApplications(next)
  }, [api, run])

  const togglePreset = useCallback(async (preset: InstalledPreset, enabled: boolean) => {
    const next = await run(`preset:${preset.name}`, () => api.togglePreset(preset.name, enabled), {
      success: enabled ? `预设「${preset.name}」已启用。` : `预设「${preset.name}」已停用。`,
    })
    if (next) setInstalledPresets(next)
  }, [api, run])

  const uninstallPreset = useCallback(async (preset: InstalledPreset) => {
    const next = await run(`preset-remove:${preset.name}`, () => api.uninstallPreset(preset.name), {
      success: `预设「${preset.name}」已删除。`,
    })
    if (next) setInstalledPresets(next)
  }, [api, run])

  /** 先本地重排让拖拽有即时反馈，主进程写盘失败再回滚。 */
  const reorderPlugins = useCallback(async (packageNames: string[]) => {
    if (!profile) return
    const previous = profile
    setProfile(reorderProfilePlugins(profile, packageNames))
    const next = await run(BUSY.reorder, () => api.reorderPlugins(packageNames), {
      onError: error => {
        setProfile(previous)
        showToast({ kind: 'error', message: errorText(error) })
      },
    })
    if (next) setProfile(next)
  }, [api, profile, run, showToast])

  const uninstallPlugin = useCallback(async (plugin: ManagedPlugin) => {
    const next = await run(plugin.packageName, () => api.uninstallPlugin(plugin.packageName), {
      success: `${plugin.displayName} 已从本机完全卸载。`,
    })
    if (!next) return
    setProfile(next)
    setSelectedPlugin(next.plugins[0]?.packageName ?? null)
    if (settings) {
      const key = pluginTrialStateKey(settings.profileName, plugin.packageName)
      setPluginTrials(current => {
        const updated = { ...current }
        delete updated[key]
        return updated
      })
    }
  }, [api, run, settings])

  const trialPlugin = useCallback(async (packageName: string, profileName?: string): Promise<PluginTrialResult | undefined> => {
    const result = await run(`plugin-trial:${packageName}`, () => api.trialPlugin(packageName, profileName))
    if (result) {
      showToast({
        kind: result.phase === 'passed' ? 'success' : 'error',
        message: result.message,
      })
    }
    return result
  }, [api, run, showToast])

  // ===================== 整合包（Pack）管理 =====================

  const refreshPacks = useCallback(async () => {
    const next = await run('pack-refresh', () => api.listPacks(), {
      onError: error => showToast({ kind: 'error', message: errorText(error) }),
    })
    if (next) setPacks(next)
  }, [api, run, showToast])

  const refreshProfiles = useCallback(async () => {
    const next = await api.listProfiles()
    setProfiles(next)
    return next
  }, [api])

  const createProfile = useCallback(async (request: Parameters<LauncherApi['createProfile']>[0]) => {
    const next = await run(`profile-create:${request.name}`, () => api.createProfile(request), { success: `整合包「${request.name}」已创建。` })
    if (next) await refreshProfiles()
    return next
  }, [api, refreshProfiles, run])

  const cloneProfile = useCallback(async (sourceName: string, targetName: string, description?: string) => {
    const next = await run(`profile-clone:${targetName}`, () => api.cloneProfile(sourceName, targetName, description), { success: `整合包「${targetName}」已克隆。` })
    if (next) await refreshProfiles()
    return next
  }, [api, refreshProfiles, run])

  const switchProfile = useCallback(async (profileName: string, options?: { fillMissing?: boolean }) => {
    const target = profiles.find(item => item.id === profileName)
    const fillMissing = options?.fillMissing ?? (target && target.missingDependencies.length > 0
      ? (typeof window !== 'undefined' && window.confirm(`整合包「${profileName}」缺少 ${target.missingDependencies.length} 项依赖，是否从来源记录补齐后切换？`))
      : false)
    if (target && target.missingDependencies.length > 0 && !fillMissing) {
      // The confirmation dialog is the cancellation boundary for dependency
      // repair. Clear any stale progress left by an earlier interrupted
      // installer so Profile controls are immediately usable again.
      setInstallProgress(null)
      return undefined
    }
    const next = await run(`profile-switch:${profileName}`, async () => {
      const result = await api.switchProfile(profileName, { fillMissing })
      setSettings(result)
      await refreshProfile()
      await refreshProfiles()
      return result
    }, { success: `已切换到整合包「${profileName}」。` })
    // 依赖补齐由主进程复用安装进度事件；如果安装在准备阶段失败，
    // 某些旧版本/第三方安装器可能来不及发送 error 终态。切换请求已经
    // 结束后清除残留进度，避免整合包下拉框和导出菜单永久处于写锁状态。
    setInstallProgress(null)
    return next
  }, [api, profiles, refreshProfiles, refreshProfile, run])

  const deleteProfile = useCallback(async (profileName: string) => {
    const next = await run(`profile-delete:${profileName}`, () => api.deleteProfile(profileName), { success: `整合包「${profileName}」已删除。` })
    if (next !== undefined) await refreshProfiles()
    return next !== undefined
  }, [api, refreshProfiles, run])

  const refreshPackSnapshots = useCallback(async () => {
    try {
      setPackSnapshotsAvailable(await api.packHasSnapshot())
    } catch {
      setPackSnapshotsAvailable(false)
    }
  }, [api])

  /** 包级写操作返回单个 PackStatus，原地替换列表项，避免整表刷新闪烁。 */
  const applyPackUpdate = useCallback((next: PackStatus) => {
    setPacks(current => current.map(pack => pack.id === next.id ? next : pack))
  }, [])

  const activatePack = useCallback(async (packId: string): Promise<boolean> => {
    const next = await run(`pack-activate:${packId}`, async () => {
      const settings = await api.activatePack(packId)
      setSettings(settings)
      // 切包 = 切整个隔离环境：插件/技能/预设/运行环境读数全部随激活包家目录换脸。
      await Promise.all([refreshProfile(), refreshPacks(), refreshSecondaryResources(), refreshRuntimeEnvironment()])
      return settings
    }, { success: '已切换到该整合包，插件、技能与预设已随之更新。' })
    return next !== undefined
  }, [api, refreshPacks, refreshProfile, refreshRuntimeEnvironment, refreshSecondaryResources, run])

  const renamePack = useCallback(async (packId: string, name: string): Promise<boolean> => {
    const next = await run(`pack-rename:${packId}`, async () => {
      const pack = await api.renamePack(packId, name)
      applyPackUpdate(pack)
      return pack
    }, { success: '整合包已重命名。' })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const createBlankPack = useCallback(async (request: { name: string; dshVersion: string | null }): Promise<PackStatus | undefined> => {
    const pack = await run('pack-create-blank', async () => {
      const created = await api.createBlankPack(request)
      // 零包状态下新建会自动激活（主进程写指针）：同步 settings 与环境读数。
      setSettings(await api.getSettings())
      await Promise.all([refreshPacks(), refreshProfile(), refreshSecondaryResources()])
      return created
    }, { success: `整合包「${request.name}」已创建。` })
    return pack
  }, [api, refreshPacks, refreshProfile, refreshSecondaryResources, run, setSettings])

  const removePack = useCallback(async (packId: string): Promise<boolean> => {
    const next = await run(`pack-remove:${packId}`, async () => {
      const result = await api.removePack(packId)
      // 删的可能是激活包：主进程已把指针落到别的包/新建默认包，全量刷新环境读数。
      setSettings(await api.getSettings())
      await Promise.all([refreshPacks(), refreshProfile(), refreshSecondaryResources()])
      return result
    }, { success: '整合包及其环境数据已删除。' })
    return next !== undefined
  }, [api, refreshPacks, refreshProfile, refreshSecondaryResources, run, setSettings])

  /** 恢复官方默认整合包（下载导入在当前主进程完成后经 done 事件刷新列表，这里再兜一次）。 */
  const restoreOfficialPack = useCallback(async (): Promise<boolean> => {
    const result = await run('official-restore', () => api.restoreOfficialPack(), { success: '官方整合包已恢复。' })
    if (result) await Promise.all([refreshPacks(), refreshProfile()])
    return result !== undefined
  }, [api, run, refreshPacks, refreshProfile])

  /**
   * 官方整合包版本列表与状态：整合包页的「官方整合包」堆叠用。
   * 版本列表按需拉（打开堆叠时），状态读主进程启动核对留下的缓存，force 才重查 GitHub。
   */
  const [officialStatus, setOfficialStatus] = useState<OfficialPackStatus | null>(null)
  const [officialVersions, setOfficialVersions] = useState<OfficialPackRelease[] | null>(null)
  const [officialVersionsError, setOfficialVersionsError] = useState<string | null>(null)
  const [officialVersionsBusy, setOfficialVersionsBusy] = useState(false)

  const readOfficialPackStatus = useCallback(async (force = false): Promise<OfficialPackStatus | null> => {
    try {
      const next = await api.readOfficialPackStatus(force)
      setOfficialStatus(next)
      return next
    } catch {
      // 状态读失败不打扰用户：堆叠入口退化为「版本列表按需拉」。
      return null
    }
  }, [api])

  const refreshOfficialVersions = useCallback(async (force = false): Promise<void> => {
    setOfficialVersionsBusy(true)
    try {
      const versions = await api.listOfficialPackVersions()
      setOfficialVersions(versions)
      setOfficialVersionsError(null)
      // 列表本身就带推荐版本，顺手把状态刷新到最新（避免启动核对与列表不一致）。
      setOfficialStatus(current => current
        ? { ...current, recommended: versions[0]?.version ?? current.recommended }
        : current)
    } catch (error) {
      setOfficialVersionsError(error instanceof Error ? error.message : String(error))
    } finally {
      setOfficialVersionsBusy(false)
    }
    if (force) void readOfficialPackStatus(true)
  }, [api, readOfficialPackStatus])

  /** 下载并导入指定版本的官方整合包（重复下载同名会得到「… (2)」）。 */
  const installOfficialPackVersion = useCallback(async (version: string): Promise<boolean> => {
    const result = await run(`official-install:${version}`, () => api.installOfficialPackVersion(version), {
      success: `官方整合包 ${version} 已导入，可在整合包页切换使用。`,
    })
    if (result) {
      await Promise.all([refreshPacks(), refreshOfficialVersions(false), readOfficialPackStatus(true)])
    }
    return result !== undefined
  }, [api, run, refreshPacks, refreshOfficialVersions, readOfficialPackStatus])

  // 主进程启动核对完成后会推一次状态（发现新版本 / 首装完成），据此更新堆叠入口的「有新版本」徽标。
  useEffect(() => api.onOfficialPackStatus(status => {
    setOfficialStatus(status)
    if (status.recommended && status.installedVersions.length > 0) setOfficialVersions(null)
  }), [api])

  // 整合包后台活动（导出打包进度等）：来自主进程 packProgress 状态事件，面板上展示，
  // 否则导出这类长任务在 UI 上毫无反馈、看起来像卡死。
  const [packActivity, setPackActivity] = useState<string | null>(null)
  // 包体下载进度（官方整合包百 MB 级）：结构化数据给进度条画图，文字版进活动横幅与首页。
  const [packDownload, setPackDownload] = useState<PackDownloadProgress | null>(null)
  // 下载之后的导入阶段（解压快照 / 补装 DSH 运行时）：同一条进度条接着用，只是换成阶段文案。
  const [packStage, setPackStage] = useState<PackStageProgress | null>(null)
  useEffect(() => api.onPackProgress(event => {
    switch (event.kind) {
      case 'download':
        // 下载阶段：结构化进度给进度条，文字版同时喂给首页（那里只有一个文字位）。
        setPackDownload(event)
        setPackStage(null)
        setPackActivity(`${event.label}：${downloadProgressText(event)}`)
        return
      case 'stage':
        setPackDownload(null)
        setPackStage(event)
        setPackActivity(event.label)
        return
      case 'status':
        // 一句阶段文案：接着挂在进度条上（百分比未知），空串表示收工。
        setPackDownload(null)
        setPackStage(event.message ? { label: event.message, percent: null } : null)
        setPackActivity(event.message)
        return
      case 'extract': {
        // 解压按文件数推进：保留上一句文案当标题，百分比换成文件进度。
        const percent = event.total > 0 ? Math.min(100, Math.floor((event.done / event.total) * 100)) : null
        setPackDownload(null)
        setPackStage(current => ({ label: current?.label ?? '正在解压导入整合包…', percent }))
        setPackActivity(`正在解压导入整合包：${event.done} / ${event.total} 个文件…`)
        return
      }
      case 'item-start':
        setPackDownload(null)
        setPackStage({ label: `正在安装 ${event.packageName}…`, percent: null })
        setPackActivity(`正在安装 ${event.packageName}…`)
        return
      // phase / item-done / snapshot 是导入弹窗的明细，进度条这里保持不动，免得来回闪。
      case 'phase':
      case 'item-done':
      case 'snapshot':
        return
      default:
        setPackDownload(null)
        setPackStage(null)
        setPackActivity(null)
    }
    // 主进程侧的导入（官方整合包首启自动获取等）完成后刷新列表，无需用户手动切页。
    if (event.kind === 'done') void refreshPacks()
  }), [api, refreshPacks])

  const exportPack = useCallback(async (packId: string, privacy?: PackExportPrivacy): Promise<string | null> => {
    setPackActivity('正在导出整合包：正在打包插件与离线依赖（可能需要几分钟），完成后自动保存…')
    try {
      const path = await run(`pack-export:${packId}`, () => api.exportPack(packId, privacy))
      if (path) showToast({ kind: 'success', message: `整合包已导出到 ${path}` })
      return path ?? null
    } finally {
      setPackActivity(null)
    }
  }, [api, run, showToast])

  /** 会话搬运预览：只读，不进任务队列，失败照常弹错。 */
  const previewSessionImport = useCallback((sourcePackId: string, targetPackId: string) => (
    api.previewSessionImport(sourcePackId, targetPackId)
  ), [api])

  /** 把源包的会话记录复制进目标包；失败返回 undefined（run 已经弹过吐司）。 */
  const importSessionHistory = useCallback(async (sourcePackId: string, targetPackId: string) => {
    setPackActivity('正在复制会话记录：只新增不覆盖，源包不会有任何改动…')
    try {
      return await run(`pack-session-import:${targetPackId}`, () => api.importSessionHistory(sourcePackId, targetPackId), { success: '会话记录已导入。' })
    } finally {
      setPackActivity(null)
    }
  }, [api, run, setPackActivity])

  /** 撤销一次搬运：按 undoId 删掉我们复制过去的文件。 */
  const undoSessionImport = useCallback(async (undoId: string) => {
    setPackActivity('正在撤销这次导入…')
    try {
      return await run(`pack-session-undo:${undoId}`, () => api.undoSessionImport(undoId), { success: '已撤销这次导入。' })
    } finally {
      setPackActivity(null)
    }
  }, [api, run, setPackActivity])

  /** 升版副本：复制一个新整合包认新版本，旧包不动（它就是这个包的回滚手段）。 */
  const createVersionClone = useCallback(async (packId: string, request: { dshVersion: string; name?: string }) => {
    setPackActivity(`正在复制整合包到 DSH ${request.dshVersion}：原包不会有任何改动…`)
    try {
      return await run(`pack-clone:${packId}`, () => api.createVersionClone(packId, request), { success: '新整合包已复制出来。' })
    } finally {
      setPackActivity(null)
    }
  }, [api, run, setPackActivity])

  /** 删除确认框用的包占用字节数；失败返回 0（不弹错，静默降级）。 */
  const packDiskUsage = useCallback(async (packId: string): Promise<number> => {
    try {
      return await api.packDiskUsage(packId)
    } catch {
      return 0
    }
  }, [api])

  const exportProfile = useCallback(async (profileName: string, mode: Parameters<LauncherApi['exportProfile']>[1], options?: Parameters<LauncherApi['exportProfile']>[2]): Promise<string | null> => {
    const result = await run(`profile-export:${profileName}:${mode}`, () => api.exportProfile(profileName, mode, options))
    if (result) showToast({ kind: 'success', message: mode === 'repository' ? `整合包已同步到 ${result}` : `整合包已导出到 ${result}` })
    return result ?? null
  }, [api, run, showToast])

  const addPackPlugin = useCallback(async (packId: string, packageName: string): Promise<boolean> => {
    const next = await run(`pack-add:${packId}:${packageName}`, async () => {
      const updated = await api.addPackPlugin(packId, packageName)
      applyPackUpdate(updated)
      return updated
    }, { success: `${packageName} 已加入整合包。` })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const addPackPreset = useCallback(async (packId: string, presetName: string): Promise<boolean> => {
    const next = await run(`pack-add-preset:${packId}:${presetName}`, async () => {
      const updated = await api.addPackPreset(packId, presetName)
      applyPackUpdate(updated)
      return updated
    }, { success: `${presetName} 已加入整合包。` })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const addPackSkill = useCallback(async (packId: string, skillName: string): Promise<boolean> => {
    const next = await run(`pack-add-skill:${packId}:${skillName}`, async () => {
      const updated = await api.addPackSkill(packId, skillName)
      applyPackUpdate(updated)
      return updated
    }, { success: `${skillName} 已加入整合包。` })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const addPackApplication = useCallback(async (packId: string, addonId: string): Promise<boolean> => {
    const next = await run(`pack-add-application:${packId}:${addonId}`, async () => {
      const updated = await api.addPackApplication(packId, addonId)
      applyPackUpdate(updated)
      return updated
    }, { success: `应用加载项已加入整合包。` })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const togglePackPreset = useCallback(async (packId: string, presetName: string, enabled: boolean): Promise<boolean> => {
    const next = await run(`pack-toggle-preset:${packId}:${presetName}`, async () => {
      const updated = await api.togglePackPreset(packId, presetName, enabled)
      applyPackUpdate(updated)
      return updated
    }, { success: enabled ? '预设已启用。' : '预设已停用。' })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const togglePackSkill = useCallback(async (packId: string, skillName: string, enabled: boolean): Promise<boolean> => {
    const next = await run(`pack-toggle-skill:${packId}:${skillName}`, async () => {
      const updated = await api.togglePackSkill(packId, skillName, enabled)
      applyPackUpdate(updated)
      return updated
    }, { success: enabled ? 'Skill 已启用。' : 'Skill 已停用。' })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const togglePackApplication = useCallback(async (packId: string, addonId: string, enabled: boolean): Promise<boolean> => {
    const next = await run(`pack-toggle-application:${packId}:${addonId}`, async () => {
      const updated = await api.togglePackApplication(packId, addonId, enabled)
      applyPackUpdate(updated)
      return updated
    }, { success: enabled ? '应用加载项已启用。' : '应用加载项已停用。' })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const removePackPreset = useCallback(async (packId: string, presetName: string): Promise<boolean> => {
    const next = await run(`pack-remove-preset:${packId}:${presetName}`, async () => {
      const updated = await api.removePackPreset(packId, presetName)
      applyPackUpdate(updated)
      return updated
    }, { success: `${presetName} 已从整合包移除。` })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const removePackSkill = useCallback(async (packId: string, skillName: string): Promise<boolean> => {
    const next = await run(`pack-remove-skill:${packId}:${skillName}`, async () => {
      const updated = await api.removePackSkill(packId, skillName)
      applyPackUpdate(updated)
      return updated
    }, { success: `${skillName} 已从整合包移除。` })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const removePackApplication = useCallback(async (packId: string, addonId: string): Promise<boolean> => {
    const next = await run(`pack-remove-application:${packId}:${addonId}`, async () => {
      const updated = await api.removePackApplication(packId, addonId)
      applyPackUpdate(updated)
      return updated
    }, { success: `应用加载项已从整合包移除。` })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const togglePackItem = useCallback(async (packId: string, packageName: string, enabled: boolean): Promise<boolean> => {
    const next = await run(`pack-toggle:${packId}:${packageName}`, async () => {
      const updated = await api.togglePackItem(packId, packageName, enabled)
      applyPackUpdate(updated)
      return updated
    }, { success: enabled ? '插件已启用。' : '插件已停用。' })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const removePackItem = useCallback(async (packId: string, packageName: string): Promise<boolean> => {
    const next = await run(`pack-remove-item:${packId}:${packageName}`, async () => {
      const updated = await api.removePackItem(packId, packageName)
      applyPackUpdate(updated)
      return updated
    }, { success: `${packageName} 已从整合包移除。` })
    return next !== undefined
  }, [api, applyPackUpdate, run])

  const dismissDshFailure = useCallback(() => setDshFailure(null), [])

  return {
    // 状态
    loading,
    settings,
    profile,
    runtime,
    dshFailure,
    dshInstallation,
    dshUpdate,
    runtimeEnvironment,
    launcherUpdate,
    launcherUpdateProgress,
    installProgress,
    pluginTrials,
    installedRepositories,
    installedSkills,
    installedApplications,
    activeRuntimeReplacement,
    installedPresets,
    credentialStatus,
    customApiProviders,
    customApiLoading,
    githubAuthStatus,
    logs,
    processLogCount,
    selectedPlugin,
    selected: profile?.plugins.find(plugin => plugin.packageName === selectedPlugin) ?? null,
    packs,
    profiles,
    packSnapshotsAvailable,
    busy,
    toast,

    // 动作
    selectPlugin: setSelectedPlugin,
    clearLogs: () => setLogs([]),
    dismissToast,
    dismissDshFailure,
    showToast,
    refreshProfile,
    refreshSecondaryResources,
    refreshCustomApiProviders,
    applyInstallResult,
    adoptCatalogInstallationState,
    applyCatalogPluginInstall,
    applyCatalogSkillInstall,
    applyCatalogApplicationInstall,
    applyCatalogPresetInstall,
    beginInstall,
    finishInstall,
    toggleRuntime,
    updateDsh,
    refreshRuntimeEnvironment,
    installDshVersion,
    selectDshVersion,
    removeDshVersion,
    installNodeVersion,
    cancelRuntimeDownload,
    selectNodeVersion,
    removeNodeVersion,
    downloadLauncherUpdate,
    applyLauncherUpdate,
    saveSettings,
    saveApiKey,
    clearApiKey,
    saveCustomApi,
    removeCustomApi,
    setGitHubAuthStatus: (next: GitHubAuthStatus) => {
      // A manual login/logout supersedes any status request already in flight.
      githubAuthRefreshVersion.current += 1
      setGitHubAuthStatus(next)
    },
    togglePlugin,
    recommendedWebUi,
    readRecommendedWebUi,
    installRecommendedWebUi,
    markRecommendedWebUiPrompted,
    toggleSkill,
    uninstallSkill,
    toggleApplication,
    uninstallApplication,
    togglePreset,
    uninstallPreset,
    reorderPlugins,
    uninstallPlugin,
    trialPlugin,
    refreshPacks,
    refreshProfiles,
    createProfile,
    cloneProfile,
    switchProfile,
    deleteProfile,
    refreshPackSnapshots,
    activatePack,
    packActivity,
    packDownload,
    packStage,
    renamePack,
    createBlankPack,
    packDiskUsage,
    removePack,
    restoreOfficialPack,
    officialStatus,
    officialVersions,
    officialVersionsError,
    officialVersionsBusy,
    readOfficialPackStatus,
    refreshOfficialVersions,
    installOfficialPackVersion,
    exportPack,
    previewSessionImport,
    importSessionHistory,
    undoSessionImport,
    createVersionClone,
    exportProfile,
    addPackPlugin,
    addPackPreset,
    addPackSkill,
    addPackApplication,
    togglePackItem,
    togglePackPreset,
    togglePackSkill,
    togglePackApplication,
    removePackItem,
    removePackPreset,
    removePackSkill,
    removePackApplication,
  }
}

export type LauncherStore = ReturnType<typeof useLauncherStore>
