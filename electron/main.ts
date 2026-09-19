import { app, BrowserWindow, net, safeStorage, shell } from 'electron'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppSettings, OfficialPackRelease, OfficialPackStatus, PackInstallResult, RuntimeOutput, WindowMode } from '../src/types'
import { ACP_RUNTIME_DIRNAME, CREDENTIALS_LOCK_DIRNAME, createAiInstaller, healCredentialsLock, type AiInstaller } from './ai-install'
import { createApplicationAddonManager, type ApplicationAddonManager } from './application-addons'
import { applyWindowMode, createMainWindow, createRendererChannel } from './app-window'
import { createCatalogSyncService, type CatalogSyncService } from './catalog-sync'
import { createCopilotSessionManager, type CopilotSessionManager } from './copilot-sessions'
import { createDshMarketService, type DshMarketService } from './dsh-market'
import { runCommand } from './command'
import { readDeepSeekApiKey } from './credentials'
import { resolveAgentApiForModel, resolveCopilotAgentApi } from './copilot-api'
import { findInstalledDsh } from './dsh-install'
import { compareVersions } from './dsh-release'
import { buildPluginCommandArgs, createInstaller, syncProfilePnpmConfig, validateLocalPluginDirectory, type Installer } from './installer'
import { registerIpcHandlers } from './ipc'
import { createLauncherUpdater, type LauncherUpdater } from './launcher-update'
import { createGitHubAuthService, type GitHubAuthService } from './github-auth'
import { buildNetworkEnvironment } from './proxy'
import {
  ensureNodeRuntime,
  ensurePnpmRuntime,
  findSystemNodeRuntime,
  resolveNodeExecutable,
  type NodeRuntime,
  type NodeRuntimeProgress,
  type PnpmRuntime,
} from './node-runtime'
import { createProxyAwareFetch } from './network'
import { packUsesOfficeCliSkills, resolveOfficeCliExecutable } from './officecli-tool'
import { ensureOfficialPackVersion, listOfficialPackVersions, type OfficialPackListDeps } from './official-pack'
import { createPackManager, type InstallInstaller, type PackInstallTarget, type PackManager } from './pack'
import { migrateToPackHomesV2 } from './pack-migration'
import { readPackRegistry } from './pack-registry'
import { createPluginTrialManager, type PluginTrialManager } from './plugin-trial'
import { readPluginReceipts, recordPluginInstall } from './plugin-receipts'
import { approveAllIgnoredBuilds } from './plugin-install'
import { configureProcessTracker, shutdownTrackedProcesses, withExecutableDirectoryOnPath } from './process'
import { createProcessSupervisor, type ProcessSupervisor } from './process-supervisor'
import { readProfile, reorderPlugins, togglePlugin } from './profile'
import { createRecommendedWebUiService, type RecommendedWebUiService } from './recommended-web-ui'
import { consolidatePluginPool, createProfileService, ensureProfileWorkspaceConfig, migrateLegacyPacks, type ProfileService } from './profile-service'
import { installPresetFromDirectory } from './preset-install'
import { installSkillFromDirectory } from './skill-install'
import { createRendererEvents } from './renderer-events'
import { createRuntimeController, type RuntimeController } from './runtime'
import { createRuntimeVersionService, ensureDshVersionInstalled, findManagedDshVersions, type RuntimeVersionService } from './runtime-versions'
import { createSettingsStore, defaultSettings, type SettingsStore } from './settings'
import { createTray, type TrayController } from './tray'
import { recoverLegacyCredentials } from './dsh-credentials-compat'

/**
 * 应用入口与装配根。
 * 这里只负责「谁依赖谁」，具体行为都在各自的模块里。
 */

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
// 窗口图标与托盘图标共用同一资源；dev 取 public/，打包取 dist/。
const launcherIconPath = path.join(moduleDirectory, app.isPackaged ? '../dist/launcher-icon.png' : '../public/launcher-icon.png')

let mainWindow: BrowserWindow | null = null
let processSupervisor: ProcessSupervisor | null = null
let quitCleanupStarted = false
let allowFinalQuit = false
// 关闭按钮只隐藏到托盘；before-quit 置位后放行真正的关闭。
let isQuitting = false
let tray: TrayController | null = null
let backgroundNoticeShown = false

const getWindow = (): BrowserWindow | null => mainWindow
const events = createRendererEvents(createRendererChannel(getWindow))

interface Services {
  settings: SettingsStore
  pluginReceiptsPath: string
  runtime: RuntimeController
  installer: Installer
  pluginTrial: PluginTrialManager
  aiInstaller: AiInstaller
  copilot: CopilotSessionManager
  packManager: PackManager
  launcherUpdater: LauncherUpdater
  githubAuth: GitHubAuthService
  applicationAddons: ApplicationAddonManager
  catalogSync: CatalogSyncService
  dshMarket: DshMarketService
  recommendedWebUi: RecommendedWebUiService
  runtimeVersions: RuntimeVersionService
  profiles: ProfileService
  profilePoolReady: Promise<void>
  /** 手动恢复官方整合包（整合包页按钮）；失败抛错给渲染层。 */
  restoreOfficialPack: () => Promise<PackInstallResult>
  /** 列出 Release 上所有官方整合包版本（按版本降序）。 */
  listOfficialPackVersions: () => Promise<OfficialPackRelease[]>
  /** 官方整合包状态；`force` = 强制重新查 GitHub，否则用启动核对的缓存。 */
  readOfficialPackStatus: (force?: boolean) => Promise<OfficialPackStatus>
  /** 下载并导入指定版本的官方整合包；失败抛错给渲染层。 */
  installOfficialPackVersion: (version: string) => Promise<PackInstallResult>
  /** 启动核对：无官方包则自动装推荐版本，有更新则只通知不改动。 */
  officialPackBootstrap: () => Promise<void>
}

// app.getPath 依赖 app 就绪，因此服务在 whenReady 之后才装配。
let services: Services | null = null

function createServices(): Services {
  const userData = app.getPath('userData')
  const managedDshRoot = path.join(userData, 'dsh-runtime')
  const managedNodeRoot = path.join(userData, 'node-runtime')
  const managedPnpmRoot = path.join(userData, 'pnpm-runtime')
  const pluginSourceRoot = path.join(userData, 'plugin-sources')
  const pluginReceiptsPath = path.join(userData, 'plugin-installs.json')
  const presetReceiptsPath = path.join(userData, 'preset-installs.json')
  const skillReceiptsPath = path.join(userData, 'skill-installs.json')
  const skillSourceRoot = path.join(userData, 'skill-sources')
  const applicationRoot = path.join(userData, 'application-addons')
  const packsJsonPath = path.join(userData, 'packs.json')
  const packsRoot = path.join(userData, 'dsh-packs')
  // 机器级外部工具（officecli 等）的托管根目录：跨整合包共享，不随快照进包。
  const officeCliToolsRoot = path.join(userData, 'dsh-tools')
  const proxyAwareFetch = createProxyAwareFetch((input, init) => net.fetch(input, init))
  const githubAuth = createGitHubAuthService({
    filePath: path.join(userData, 'github-auth.bin'),
    clientId: process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID,
    fetchImpl: proxyAwareFetch,
    cipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    },
  })
  const catalogSync = createCatalogSyncService({
    fetchImpl: githubAuth.fetch,
    getAuthStatus: () => githubAuth.getStatus(),
    pendingDir: path.join(userData, 'catalog', 'pending'),
    onFlush: result => events.output('plugin', result.submitted > 0 ? 'success' : 'error', result.message),
  })

  let settings: SettingsStore

  /**
   * 准备 Node.js 运行环境，并把下载进度写进日志。
   * 进度每跨越 10% 记一条，避免刷屏。
   */
  const prepareNodeRuntime = (
    source: RuntimeOutput['channel'],
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ): Promise<NodeRuntime> => {
    let lastBucket = -1
    return settings.read().then(currentSettings => ensureNodeRuntime(managedNodeRoot, progress => {
      const bucket = Math.floor(progress.percent / 10)
      if (bucket !== lastBucket || progress.percent === 100) {
        lastBucket = bucket
        events.output(source, 'info', `${progress.message}（${progress.percent}%）`)
      }
      onProgress?.(progress)
    }, currentSettings.nodeVersion, (level, text) => events.output(source, level, text)))
  }

  const preparePnpmRuntime = (
    source: RuntimeOutput['channel'],
    nodeRuntime: NodeRuntime,
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ): Promise<PnpmRuntime> => {
    let lastBucket = -1
    return ensurePnpmRuntime(managedPnpmRoot, nodeRuntime, progress => {
      const bucket = Math.floor(progress.percent / 10)
      if (bucket !== lastBucket || progress.percent === 100) {
        lastBucket = bucket
        events.output(source, 'info', `${progress.message}（${progress.percent}%）`)
      }
      onProgress?.(progress)
    }, (level, text) => events.output(source, level, text))
  }

  /**
   * 启动前准备 officecli：包里有 officecli 技能才动；下载进度既写日志
   * （runtime 通道，由控制器输出）也进整合包活动横幅（packActivity，5% 分桶节流），
   * 结束（成功或失败）清空横幅。永不抛异常。
   */
  const prepareOfficeCliTool = async (
    current: AppSettings,
    onProgress: (received: number, total: number | null) => void,
  ): Promise<string | null> => {
    let bannerShown = false
    let lastPercent = -1
    try {
      if (!(await packUsesOfficeCliSkills(current.dshHome))) return null
      return await resolveOfficeCliExecutable(current.dshHome, officeCliToolsRoot, {
        mirror: current.network?.githubMirror,
        fetchImpl: proxyAwareFetch,
        onProgress: (received, total) => {
          onProgress(received, total)
          const percent = total && total > 0 ? Math.floor((received / total) * 100) : -1
          if (percent !== lastPercent) {
            lastPercent = percent
            bannerShown = true
            events.packProgress({ kind: 'status', message: `正在准备 Office 工具（首次约 33MB）${percent >= 0 ? `：${percent}%` : ''}…` })
          }
        },
      })
    } catch {
      return null
    } finally {
      if (bannerShown) events.packProgress({ kind: 'status', message: '' })
    }
  }

  settings = createSettingsStore({
    filePath: path.join(userData, 'settings.json'),
    createDefaults: () => defaultSettings({
      dshHomeFromEnvironment: process.env.DSH_HOME,
      homeDirectory: os.homedir(),
      documentsDirectory: app.getPath('documents'),
      systemNpx: findSystemNodeRuntime()?.npx,
      dshInstallPath: managedDshRoot,
    }),
    detectInstalledDsh: (settings: AppSettings) => findInstalledDsh({
      managedRoot: settings.dshInstallPath,
      configuredExecutable: settings.launchExecutable,
    }),
    // 整合包真隔离的咽喉点：read() 返回的 dshHome 即激活包的私有家目录（缺省 = 默认家目录）。
    resolvePackHome: async current => {
      if (!current.activePackId) return null
      const records = await readPackRegistry(packsJsonPath)
      return records.find(record => record.id === current.activePackId)?.homePath ?? null
    },
  })

  let applicationAddons: ApplicationAddonManager
  let installer: Installer
  const runtime = createRuntimeController({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('runtime'),
    fallbackWorkspace: () => app.getPath('documents'),
    emitOutput: (level, text) => events.output('runtime', level, text),
    emitState: state => events.runtimeState(state),
    openExternal: url => void shell.openExternal(url),
    resolveApplicationLaunchPlan: () => applicationAddons.launchPlan(),
    legacyCredentialsBackupRoot: path.join(userData, 'dsh-credentials-compat'),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    prepareOfficeCliTool,
  })
  const profileService = createProfileService({
    dshHome: () => settings.read().then(value => value.dshHome),
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    pluginReceiptsPath,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    packBodiesRoot: () => settings.read().then(value => path.join(value.dshHome, '.dsh-launcher-pack-bodies')),
    isRuntimeRunning: () => runtime.isRunning(),
    fillMissingDependencies: async (profileName, missing) => {
      const current = await settings.read()
      const receipts = await readPluginReceipts(pluginReceiptsPath)
      const pluginStoreRoot = path.join(userData, 'plugin-store')
      const profileRoot = path.join(current.dshHome, 'profiles')
      const targetProfileDir = path.join(profileRoot, profileName)
      // A link-only repair must never auto-install DSH peer packages from npm.
      // Normalize legacy/imported Profiles before invoking pnpm so unpublished
      // preview peers remain supplied by the selected DSH runtime.
      await ensureProfileWorkspaceConfig(targetProfileDir)

      // Legacy/imported Profiles can contain only `*` dependency ranges even
      // though another Profile already has the exact local source. Reuse that
      // source before asking pnpm for offline registry metadata; this preserves
      // one physical plugin body while keeping each Profile's link layer and
      // activation order independent.
      const sourceSpecs = new Map<string, string>()
      const siblingEntries = await readdir(profileRoot, { withFileTypes: true }).catch(() => [])
      for (const sibling of siblingEntries) {
        if (!sibling.isDirectory() || sibling.name === profileName) continue
        const siblingManifestPath = path.join(profileRoot, sibling.name, 'package.json')
        let siblingManifest: { dependencies?: Record<string, unknown> } | null = null
        try {
          siblingManifest = JSON.parse(await readFile(siblingManifestPath, 'utf8')) as { dependencies?: Record<string, unknown> }
        } catch {
          continue
        }
        for (const packageName of missing) {
          if (sourceSpecs.has(packageName)) continue
          const candidate = siblingManifest.dependencies?.[packageName]
          if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.trim() === '*') continue
          if (candidate.startsWith('file:')) {
            const rawPath = candidate.slice('file:'.length)
            const sourcePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(path.dirname(siblingManifestPath), rawPath)
            try {
              const sourceManifest = JSON.parse(await readFile(path.join(sourcePath, 'package.json'), 'utf8')) as { version?: unknown }
              const version = typeof sourceManifest.version === 'string' && sourceManifest.version.trim()
                ? sourceManifest.version.trim().replace(/[^0-9A-Za-z._+-]/g, '_')
                : 'local'
              const sharedSource = path.join(current.dshHome, '.dsh-launcher-plugin-bodies', ...packageName.split('/'), version)
              if (path.resolve(sourcePath) !== path.resolve(sharedSource)) {
                await mkdir(path.dirname(sharedSource), { recursive: true })
                try {
                  await readFile(path.join(sharedSource, 'package.json'), 'utf8')
                } catch {
                  await cp(sourcePath, sharedSource, { recursive: true })
                }
              }
              sourceSpecs.set(packageName, `file:${sharedSource}`)
            } catch {
              // Stale file references are not reusable sources.
            }
          } else if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.trim())) {
            sourceSpecs.set(packageName, candidate.trim())
          }
        }
      }

      if (sourceSpecs.size > 0) {
        const targetManifestPath = path.join(targetProfileDir, 'package.json')
        try {
          const targetManifest = JSON.parse(await readFile(targetManifestPath, 'utf8')) as { dependencies?: Record<string, string> }
          const dependencies = { ...(targetManifest.dependencies ?? {}) }
          const repaired: string[] = []
          for (const packageName of missing) {
            const currentSpec = dependencies[packageName]
            const sourceSpec = sourceSpecs.get(packageName)
            if (!sourceSpec || (currentSpec && currentSpec !== '*' && !/[<>=*^~]/.test(currentSpec))) continue
            dependencies[packageName] = sourceSpec
            repaired.push(`${packageName} → ${sourceSpec}`)
          }
          if (repaired.length > 0) {
            await writeFile(targetManifestPath, `${JSON.stringify({ ...targetManifest, dependencies }, null, 2)}\n`, 'utf8')
            events.output('plugin', 'info', `已从其他整合包复用 ${repaired.length} 个插件来源：${repaired.join('、')}`)
          }
        } catch {
          // The subsequent pnpm command reports a precise manifest error.
        }
      }

      let offlineNode: NodeRuntime | null = null
      let offlinePnpm: PnpmRuntime | null = null
      let offlineInstallAttempted = false
      for (const packageName of missing) {
        const receipt = receipts.find(item => item.packId === profileName && item.packageName === packageName)
        if (!receipt) {
          // A cloned/imported Profile may have no launcher receipt while its
          // exact package is already present in the shared pnpm store. Try an
          // offline link-only install before asking the user to source it.
          if (!offlineInstallAttempted) {
            offlineInstallAttempted = true
            offlineNode ??= await prepareNodeRuntime('plugin')
            offlinePnpm ??= await preparePnpmRuntime('plugin', offlineNode)
            await syncProfilePnpmConfig(targetProfileDir, buildNetworkEnvironment(current).npmRegistry, pluginStoreRoot)
            const result = await runCommand(offlinePnpm.executable, ['install', '--dir', targetProfileDir, '--offline', '--no-frozen-lockfile', '--config.auto-install-peers=false', '--store-dir', pluginStoreRoot], {
              cwd: targetProfileDir,
              env: withExecutableDirectoryOnPath(offlinePnpm.executable, withExecutableDirectoryOnPath(offlineNode.node, {
                ...process.env,
                DSH_HOME: current.dshHome,
                npm_config_store_dir: pluginStoreRoot,
                NPM_CONFIG_STORE_DIR: pluginStoreRoot,
                pnpm_config_store_dir: pluginStoreRoot,
                PNPM_CONFIG_STORE_DIR: pluginStoreRoot,
                CI: 'true',
              })),
              onOutput: (text, level) => events.output('plugin', level, text),
            })
            if (result.exitCode !== 0) throw new Error(`插件「${packageName}」无法从共享插件池补齐，请检查来源记录。`)
          }
          continue
        }
        const repository = receipt.repository.match(/^(?:https?:\/\/github\.com\/|github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1]
        if (receipt.source === 'npm') {
          await installer.installNpmPackage({ packageName, version: receipt.version ?? undefined }, profileName)
        } else if (repository) {
          await installer.installPluginTarget({
            repository,
            defaultBranch: receipt.defaultBranch ?? 'main',
            targetId: receipt.targetId ?? `${packageName}:.`,
            ...(receipt.commit ? { commit: receipt.commit } : {}),
          }, profileName)
        } else {
          throw new Error(`插件「${packageName}」的来源记录无效，无法自动补齐。`)
        }
      }
      // Keep the selected DSH home/profile invariant explicit for future
      // installers that consult settings while repairing links.
      if (current.dshHome !== (await settings.read()).dshHome) throw new Error('DSH_HOME 在补齐依赖期间发生变化。')
    },
  })

  /** 整合包导入期间补装 DSH 运行时：把安装进度接力到整合包页的进度条（见上面的 emitProgress）。 */
  let relayDshProgressToPack = false

  const runtimeVersions = createRuntimeVersionService({
    dshRoot: managedDshRoot,
    nodeRoot: managedNodeRoot,
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    isRuntimeRunning: () => runtime.isRunning(),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => {
      events.installProgress(progress)
      // 整合包导入过程中会先补装缺失的 DSH 运行时（约 100MB），那段时间整合包页只有一条死进度条；
      // 把这一段并进 packProgress，用户在包页也能看到「正在准备 DSH x.y.z · 45%」。
      if (relayDshProgressToPack && progress.kind === 'dsh') {
        events.packProgress({ kind: 'stage', label: progress.message, percent: progress.percent })
      }
    },
    githubFetch: githubAuth.fetch,
    // 装一个 DSH 版本只下载版本本体；整合包仅由「新建 / 导入」产生。
  })

  applicationAddons = createApplicationAddonManager({
    registryPath: path.join(userData, 'application-addons.json'),
    installRoot: applicationRoot,
    readSettings: () => settings.read(),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    isRuntimeRunning: () => runtime.isRunning(),
    githubFetch: githubAuth.fetch,
    packageStoreRoot: path.join(userData, 'plugin-store'),
  })

  installer = createInstaller({
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    pluginSourceRoot,
    pluginReceiptsPath,
    packageStoreRoot: path.join(userData, 'plugin-store'),
    presetReceiptsPath,
    skillReceiptsPath,
    skillSourceRoot,
    skillMarketCachePath: path.join(userData, 'skill-market-cache.json'),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    isRuntimeRunning: () => runtime.isRunning(),
    githubFetch: githubAuth.fetch,
  })

  // 官方推荐整合包（DSH Web UI 全家桶）：用 installer 装 latest，
  // 避免依赖市场目录与 git 子路径回退。
  const recommendedWebUi = createRecommendedWebUiService({
    readSettings: () => settings.read(),
    installer,
  })

  // This service deliberately does not use the unified resource-market
  // analyzers or installers. It mirrors dsh-market's curated registry and
  // package command rules behind a separate API surface.
  const dshMarket = createDshMarketService({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('plugin'),
    preparePnpmRuntime: node => preparePnpmRuntime('plugin', node),
    fetchImpl: githubAuth.fetch,
    packageStoreRoot: path.join(userData, 'plugin-store'),
    cachePath: path.join(userData, 'dsh-market-cache.json'),
    emitProgress: progress => events.dshMarketProgress(progress),
    emitOutput: (level, text) => events.output('plugin', level, text),
  })

  const pluginTrial = createPluginTrialManager({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('plugin'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('plugin', nodeRuntime),
    trialRoot: path.join(userData, 'plugin-trials'),
    resultsPath: path.join(userData, 'plugin-trial-results.json'),
    emitOutput: (level, text) => events.output('test', level, text),
    emitResult: result => events.pluginTrial(result),
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
  })

  let packManager: PackManager | null = null
  const copilot = createCopilotSessionManager({
    filePath: path.join(userData, 'copilot-sessions.json'),
    runtimeRoot: path.join(userData, ACP_RUNTIME_DIRNAME),
    snapshotRoot: path.join(userData, 'ai-snapshots'),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    readSettings: () => settings.read(),
    readApiKey: dshHome => readDeepSeekApiKey(dshHome),
    resolveAgentApi: dshHome => resolveCopilotAgentApi(dshHome),
    resolveAgentApiForModel: (dshHome, provider, model) => resolveAgentApiForModel(dshHome, provider, model),
    prepareNodeRuntime: () => prepareNodeRuntime('ai'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('ai', nodeRuntime),
    emitEvent: event => events.aiSessionEvent(event),
    emitOutput: (level, text) => events.output('ai', level, text),
    mutationBlockReason: () => {
      if (runtime.isRunning()) return '请先停止 DSH 运行时'
      if (installer.isBusy()) return '资源安装正在进行'
      if (pluginTrial.isBusy()) return '插件试运行正在进行'
      if (applicationAddons.isBusy()) return '应用加载项操作正在进行'
      if (dshMarket.isBusy()) return 'DSH Market 操作正在进行'
      if (packManager?.isBusy()) return '整合包操作正在进行'
      return null
    },
  })

  const aiInstaller = createAiInstaller({
    readSettings: () => settings.read(),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    prepareNodeRuntime: () => prepareNodeRuntime('ai'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('ai', nodeRuntime),
    acpRuntimeRoot: path.join(userData, ACP_RUNTIME_DIRNAME),
    snapshotRoot: path.join(userData, 'ai-snapshots'),
    emitOutput: (level, text) => events.output('ai', level, text),
    emitEvent: event => {
      events.aiInstallEvent(event)
      void copilot.updateLegacy(event)
    },
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
    analyzePlugin: (repository, defaultBranch) => installer.analyzePlugin(repository, defaultBranch),
    readApiKey: dshHome => readDeepSeekApiKey(dshHome),
    githubFetch: githubAuth.fetch,
  })

  /**
   * 整合包离线导入（zip 内的 plugin-bodies）用 `file:` specifier 安装。
   * 真实 installer 的 installPluginTarget 只接受 GitHub 仓库分析，无法直接
   * 安装本地目录，因此这里在组装层用 DSH CLI 插件命令补上最小通路。
   */
  async function installPackLocalDirectory(target: PackInstallTarget): Promise<void> {
    const originalDirectory = validateLocalPluginDirectory(target.localDirectory)
    // Windows 下 pnpm 的 `file:` spec 无法解析含空格/非 ASCII 的路径（spec 会在空格处被
    // 截断，pnpm 报 ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER）。用户主目录常含空格
    // （如 C:\Users\Miyazawa i\…），因此先把本体复制到盘根的无空格 staging 目录再安装；
    // pnpm 会把内容硬链接进其 store，staging 装完即删，不影响已安装插件。
    const needsStaging = process.platform === 'win32' && /[\s\u00A0]/.test(originalDirectory)
    const installDirectory = needsStaging ? await stageBodyForPnpm(originalDirectory) : originalDirectory
    const current = await settings.read()
    const nodeRuntime = await prepareNodeRuntime('plugin')
    const pnpmRuntime = await preparePnpmRuntime('plugin', nodeRuntime)
    const executable = resolveNodeExecutable(current.launchExecutable, nodeRuntime)
    const commandArgs = buildPluginCommandArgs(current, executable, ['add', `file:${installDirectory.replace(/\\/g, '/')}`], target.profileName)
    const environment = withExecutableDirectoryOnPath(
      pnpmRuntime.executable,
      withExecutableDirectoryOnPath(nodeRuntime.node, {
        ...process.env,
        DSH_HOME: current.dshHome,
        // CI 模式让 pnpm 用 append-only reporter：无 TTY 时也实时输出解析/下载进度行，
        // 否则导入对话框的日志区在拉取依赖的几分钟里看起来像卡死。
        CI: 'true',
        npm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
        NPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
        pnpm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
        PNPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
        FORCE_COLOR: '0',
      }),
    )
    const onOutput = (text: string, level: string) => events.output('plugin', level as 'error' | 'info' | 'success', text)
    // pnpm 的输出走插件日志通道，导入对话框看不到；这里把关键进度行节流转发进
    // packProgress 流，让对话框日志区在拉取依赖的几分钟里持续有新内容。
    let lastRelayAt = 0
    const relayToDialog = (line: string) => {
      const now = Date.now()
      if (now - lastRelayAt < 4000) return
      lastRelayAt = now
      const trimmed = line.trim().slice(0, 160)
      if (trimmed) events.packProgress({ kind: 'status', message: trimmed })
    }
    const onInstallOutput = (text: string, level: string) => {
      onOutput(text, level)
      for (const line of text.split(/\r?\n/)) {
        if (line.includes('Progress:') || line.includes('Done in') || line.includes('ERR_PNPM')) relayToDialog(line)
      }
    }
    const runAdd = () => runCommand(executable, commandArgs, {
      cwd: current.workspace,
      env: environment,
      onOutput: onInstallOutput,
    })
    try {
      events.packProgress({ kind: 'status', message: '离线本体安装：该包未内置依赖，正在联网拉取（约几分钟）。用新版启动器重新导出，即可把依赖打进包内实现免联网安装。' })
      let result = await runAdd()
      // pnpm 默认拒绝依赖里的构建脚本（cloudflared/node-pty 等）并以非零码退出。
      // 与官方安装链路一致：批准被忽略的构建后自动重试一次。
      if (result.exitCode !== 0 && result.output.includes('ERR_PNPM_IGNORED_BUILDS')) {
        const workspacePath = path.join(current.dshHome, 'profiles', target.profileName, 'pnpm-workspace.yaml')
        const approved = await approveAllIgnoredBuilds(workspacePath, result.output)
        if (approved.length > 0) {
          onOutput(`已允许 ${approved.length} 个被忽略的构建脚本，正在自动重试。`, 'info')
          result = await runAdd()
        }
      }
      if (result.exitCode !== 0) throw new Error(`插件安装失败（代码 ${result.exitCode}），请查看运行日志。`)
    } finally {
      // staging 目录用完即删（成功或失败都清），避免在盘根留垃圾。
      if (installDirectory !== originalDirectory) {
        await rm(installDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    let version: string | null = null
    try {
      const packageManifest = JSON.parse(await readFile(path.join(originalDirectory, 'package.json'), 'utf8')) as { version?: unknown }
      version = typeof packageManifest.version === 'string' ? packageManifest.version : null
    } catch {
      // 版本读取失败可忽略，receipt 的 version 允许为 null。
    }
    await recordPluginInstall(pluginReceiptsPath, {
      repository: `file:${originalDirectory}`,
      packageName: target.packageName,
      packId: target.profileName,
      source: 'local-directory',
      subdirectory: null,
      version,
      commit: '',
      installedAt: new Date().toISOString(),
    })
  }

  /** 在系统盘根的无空格目录下建唯一 staging 目录，把离线本体复制进去，返回其路径。 */
  async function stageBodyForPnpm(sourceDirectory: string): Promise<string> {
    const systemRoot = path.parse(process.env.windir ?? 'C:\\Windows').root || 'C:\\'
    const stagingRoot = path.join(systemRoot, 'dsh-import-bodies')
    await mkdir(stagingRoot, { recursive: true })
    const destination = await mkdtemp(path.join(stagingRoot, 'body-'))
    await cp(sourceDirectory, destination, { recursive: true })
    return destination
  }

  const packInstaller: InstallInstaller = {
    async installPluginTarget(target) {
      if (target.source === 'local-directory') {
        await installPackLocalDirectory(target)
        return
      }
      if (!target.repository) throw new Error('缺少来源仓库，无法安装。')
      // 真实 installer 按 analysis.targets 的 id 定位，id 形如 `<packageName>:<subdir|.>`。
      const targetId = target.subdirectory ? `${target.packageName}:${target.subdirectory}` : `${target.packageName}:.`
      const request: {
        repository: string
        defaultBranch: string
        targetId: string
        commit?: string
        version?: string
      } = { repository: target.repository, defaultBranch: 'main', targetId }
      // 转发整合包声明的 pin：github 用固定 commit，npm 用固定 version（0.0.0 是占位符，不转发）。
      if (target.source === 'github' && target.commit) request.commit = target.commit
      if (target.source === 'npm' && target.version && target.version !== '0.0.0') request.version = target.version
      await installer.installPluginTarget(request, target.profileName)
    },
    installNpmPackage: (request, profileOverride) => installer.installNpmPackage(request, profileOverride),
    remove: (packageName, profileName) => installer.remove(packageName, profileName),
    readProfile: (dshHome, profileName) => readProfile(dshHome, profileName, pluginReceiptsPath),
    togglePlugin: (dshHome, profileName, packageName, enabled) => togglePlugin(dshHome, profileName, packageName, enabled, pluginReceiptsPath),
    reorderPlugins: (dshHome, profileName, packageNames) => reorderPlugins(dshHome, profileName, packageNames, pluginReceiptsPath),
    // raw 整合包导入的技能：从本地 staging 目录全局安装（bundle 目录或 flat 单文件）。
    installSkillLocal: (dshHome, skill) => installSkillFromDirectory(dshHome, skill.name, skill.format, skill.sourceDir),
    installSkill: request => installer.installSkill(request),
    installSkillPinned: request => installer.installSkillPinned(request),
    toggleSkill: (name, enabled) => installer.toggleSkill(name, enabled),
    installPreset: request => installer.installPreset(request),
    installPresetLocal: (dshHome, preset) => installPresetFromDirectory(dshHome, preset.name, preset.sourceDir),
    togglePreset: (name, enabled) => installer.togglePreset(name, enabled),
  }

  packManager = createPackManager({
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    registryPath: packsJsonPath,
    manifestRoot: path.join(userData, 'pack-manifests'),
    snapshotRoot: path.join(userData, 'pack-snapshots'),
    pluginReceiptsPath,
    presetReceiptsPath,
    skillReceiptsPath,
    installer: packInstaller,
    applicationAddons,
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitEvent: event => events.packProgress(event),
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
    unifiedProfiles: true,
    packsRoot,
    readStoredSettings: () => settings.readStored(),
    ensureDshVersionInstalled: async version => {
      const current = await settings.read()
      const installed = await findManagedDshVersions(current.dshInstallPath)
      if (installed.some(item => item.version === version)) return
      // 导入过程中补装运行时：先给一条明确的阶段提示，再把安装进度接力到整合包页。
      events.packProgress({ kind: 'stage', label: `正在准备 DSH ${version}（本机未安装，需要先下载运行时）`, percent: null })
      relayDshProgressToPack = true
      try {
        await ensureDshVersionInstalled(installed, next => runtimeVersions.installDsh(next), version)
      } catch (error) {
        // 补装失败就根本不会走到导入，也就没有后续事件来收掉上面那条阶段横幅；自己收口。
        events.packProgress({ kind: 'status', message: '' })
        throw error
      } finally {
        relayDshProgressToPack = false
      }
    },
    selectDshVersion: async version => {
      await runtimeVersions.selectDsh(version)
    },
    getNodeExecutable: async () => {
      try {
        return (await prepareNodeRuntime('plugin')).node
      } catch {
        return null
      }
    },
    offlinePackInstall: async ({ tarballDir, profileDir, onOutput }) => {
      const current = await settings.read()
      const nodeRuntime = await prepareNodeRuntime('plugin')
      const pnpmRuntime = await preparePnpmRuntime('plugin', nodeRuntime)
      const environment = withExecutableDirectoryOnPath(
        pnpmRuntime.executable,
        withExecutableDirectoryOnPath(nodeRuntime.node, {
          ...process.env,
          DSH_HOME: current.dshHome,
          npm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
          NPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
          pnpm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
          PNPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
          CI: 'true',
          FORCE_COLOR: '0',
        }),
      )
      const entries = (await readdir(tarballDir)).filter(file => file.endsWith('.tgz')).sort()
      if (entries.length === 0) throw new Error('离线包内没有依赖 tarball。')
      for (let index = 0; index < entries.length; index += 40) {
        const batch = entries.slice(index, index + 40).map(file => path.join(tarballDir, file).replace(/\\/g, '/'))
        const result = await runCommand(pnpmRuntime.executable, ['store', 'add', ...batch], {
          cwd: profileDir,
          env: environment,
          onOutput: (text, level) => onOutput(text),
        })
        if (result.exitCode !== 0) throw new Error(`离线依赖入库失败（代码 ${result.exitCode}）`)
      }
      // prefer-offline：store 里有的直接用，个别缺失的包联网补齐（比 --offline 全有全无更稳）。
      const install = await runCommand(pnpmRuntime.executable, ['install', '--prefer-offline'], {
        cwd: profileDir,
        env: environment,
        onOutput: (text, level) => onOutput(text),
      })
      if (install.exitCode !== 0) throw new Error(`离线安装失败（代码 ${install.exitCode}）`)
    },
  })

  /**
   * 官方默认整合包：列版本 / 读状态 / 按版本下载导入共用一份状态缓存
   * （启动核对也写它，渲染层随后读到的就是同一结果）。
   * 进度走 packProgress status 事件（整合包页横幅），导入成功广播 done 让渲染层刷新列表。
   */
  let officialStatusCache: OfficialPackStatus | null = null
  /** 进行中的核对：启动核对与渲染层同时要状态时合流成一次 GitHub 查询。 */
  let officialCheckInFlight: Promise<OfficialPackStatus> | null = null

  const officialListDeps = async (): Promise<OfficialPackListDeps> => {
    const current = await settings.read()
    return { fetchImpl: proxyAwareFetch, mirror: current.network?.githubMirror }
  }

  const readInstalledOfficialVersions = async (): Promise<string[]> => {
    const records = await readPackRegistry(packsJsonPath)
    const versions = new Set<string>()
    for (const record of records) {
      const version = record.officialVersion?.trim()
      if (version) versions.add(version)
    }
    // 版本号降序：第一项即本机最新的官方包。
    return [...versions].sort((left, right) => compareVersions(right, left))
  }

  const resolveOfficialPackStatus = async (force: boolean): Promise<OfficialPackStatus> => {
    if (!force && officialStatusCache) return officialStatusCache
    if (officialCheckInFlight) return officialCheckInFlight
    officialCheckInFlight = (async () => {
      const installedVersions = await readInstalledOfficialVersions()
      try {
        const releases = await listOfficialPackVersions(await officialListDeps())
        const recommended = releases[0]?.version ?? null
        const newestInstalled = installedVersions[0] ?? null
        officialStatusCache = {
          recommended,
          installedVersions,
          updateAvailable: Boolean(recommended && newestInstalled && compareVersions(newestInstalled, recommended) > 0),
          error: null,
          checkedAt: new Date().toISOString(),
        }
      } catch (error) {
        officialStatusCache = {
          recommended: null,
          installedVersions,
          updateAvailable: false,
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        }
      }
      return officialStatusCache
    })()
    try {
      return await officialCheckInFlight
    } finally {
      officialCheckInFlight = null
    }
  }

  /**
   * 下载并导入指定版本的官方整合包；`version` 缺省时用推荐版本（Release 里最新）。
   * `announce` = 用户主动触发：失败要抛错给界面；否则只记日志，不打扰启动。
   */
  const runOfficialPack = async (announce: boolean, version?: string): Promise<PackInstallResult | null> => {
    let target = version?.trim() ?? ''
    if (!target) {
      const status = await resolveOfficialPackStatus(true)
      if (!status.recommended) {
        if (announce) throw new Error(status.error ?? '没有可用的官方整合包版本。')
        if (status.error) events.output('plugin', 'error', `官方整合包版本核对失败：${status.error}`)
        return null
      }
      target = status.recommended
    }

    // 下载进度：250ms 节流（进度条够顺滑又不刷爆 IPC），速度用指数滑动平均抹平抖动，
    // 换源时速度重新起算（source 变了就丢弃旧速度，否则镜像的快速率会被直连的慢速率拖着）。
    let lastProgressAt = 0
    let lastReceived = 0
    let lastReceivedAt = Date.now()
    let smoothedSpeed = 0
    let lastSource = ''
    let announcedDownloadDone = false
    const outcome = await ensureOfficialPackVersion({
      registryPath: packsJsonPath,
      importPack: (filePath, items, options) => packManager!.importPack(filePath, items, options),
      fetchImpl: proxyAwareFetch,
      mirror: (await settings.read()).network?.githubMirror,
      downloadDir: path.join(userData, 'pack-snapshots'),
      onProgress: ({ received, total, source }) => {
        const now = Date.now()
        const finished = total != null && total > 0 && received >= total
        if (source !== lastSource) {
          lastSource = source
          smoothedSpeed = 0
          lastReceived = received
          lastReceivedAt = now
        }
        const elapsed = (now - lastReceivedAt) / 1000
        if (elapsed >= 0.5) {
          const instant = (received - lastReceived) / elapsed
          smoothedSpeed = smoothedSpeed > 0 ? smoothedSpeed * 0.6 + instant * 0.4 : instant
          lastReceived = received
          lastReceivedAt = now
        }
        if (now - lastProgressAt < 250 && !finished) return
        lastProgressAt = now
        events.packProgress({
          kind: 'download',
          label: `官方整合包 ${target}`,
          received,
          total: total && total > 0 ? total : null,
          speed: smoothedSpeed > 0 ? smoothedSpeed : null,
          source,
        })
        // 下载完成到真正导入完成之间还有写盘、解压、补装 DSH 运行时，几十秒到几分钟；
        // 这里立刻交棒给阶段提示，别让进度条停在 100% 一动不动。
        if (finished && !announcedDownloadDone) {
          announcedDownloadDone = true
          events.packProgress({ kind: 'stage', label: '下载完成，正在写入并解压整合包…', percent: null })
        }
      },
    }, target).catch((error: unknown) => {
      // 下载或导入中途失败时，后面的收口语句根本走不到，下载条/阶段横幅会一直挂在界面上。
      events.packProgress({ kind: 'status', message: '' })
      throw error
    })
    events.packProgress({ kind: 'status', message: '' })
    if (outcome.outcome === 'imported' && outcome.result) {
      officialStatusCache = null
      if (outcome.source) events.output('plugin', 'info', `官方整合包 ${target} 已下载（来源：${outcome.source}）。`)
      events.packProgress({ kind: 'done', result: outcome.result })
      return outcome.result
    }
    if (announce) {
      if (outcome.outcome === 'present') throw new Error(`官方整合包 ${target} 已存在。`)
      throw new Error(outcome.message ?? `官方整合包 ${target} 获取失败。`)
    }
    if (outcome.outcome === 'failed') {
      events.output('plugin', 'error', `官方整合包自动获取失败：${outcome.message ?? '未知原因'}`)
    }
    return null
  }

  const restoreOfficialPack = async (): Promise<PackInstallResult> => {
    const result = await runOfficialPack(true)
    if (!result) throw new Error('官方整合包获取失败。')
    return result
  }

  const installOfficialPackVersion = async (version: string): Promise<PackInstallResult> => {
    const result = await runOfficialPack(true, version)
    if (!result) throw new Error(`官方整合包 ${version} 获取失败。`)
    return result
  }

  /**
   * 启动核对两段式：
   * - 本机**一个官方包都没有**（全新用户）→ 自动导入推荐版本，保证开箱可用；
   * - 已有官方包但存在更新版本 → **只写状态并通知渲染层**挂「有新版本」，不静默拉几百 MB。
   */
  const officialPackBootstrap = async () => {
    try {
      const status = await resolveOfficialPackStatus(true)
      if (status.installedVersions.length === 0 && status.recommended) {
        await runOfficialPack(false, status.recommended)
      }
      events.officialPackStatus(await resolveOfficialPackStatus(false))
    } catch (error) {
      events.output('plugin', 'error', `官方整合包自动获取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const launcherUpdater = createLauncherUpdater({
    getVersion: () => app.getVersion(),
    userDataPath: userData,
    githubFetch: githubAuth.fetch,
    emitProgress: progress => events.launcherUpdateProgress(progress),
  })

  // 启动自愈：上次 AI 会话若在凭据锁期间崩溃（进程被杀、finally 未跑），
  // .credentials.yaml 会滞留在锁目录，这里把它还原回 dshHome。
  void settings
    .read()
    .then(current => healCredentialsLock(current.dshHome, path.join(userData, CREDENTIALS_LOCK_DIRNAME)))
    .catch(() => { /* 设置未就绪可忽略，锁会在下次 AI 会话前置处理 */ })

  const profilePoolReady = migrateLegacyPacks({
    dshHome: () => settings.read().then(value => value.dshHome),
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    pluginReceiptsPath,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    isRuntimeRunning: () => runtime.isRunning(),
  }).then(async () => {
    const current = await settings.read()
    const result = await consolidatePluginPool(current.dshHome)
    if (result.dependencies > 0) events.output('plugin', 'info', `已将 ${result.dependencies} 个整合包插件依赖归并到共享插件池。`)
  }).then(async () => {
    await migrateToPackHomesV2({
      registryPath: packsJsonPath,
      readStoredSettings: () => settings.readStored(),
      saveSettings: next => settings.save(next),
      isRuntimeRunning: () => runtime.isRunning(),
    })
  }).catch(error => events.output('plugin', 'error', `旧整合包/插件池迁移失败：${error instanceof Error ? error.message : String(error)}`))

  return { settings, pluginReceiptsPath, runtime, installer, launcherUpdater, pluginTrial, aiInstaller, copilot, packManager: packManager!, githubAuth, applicationAddons, catalogSync, dshMarket, recommendedWebUi, runtimeVersions, profiles: profileService, profilePoolReady, restoreOfficialPack, listOfficialPackVersions: async () => listOfficialPackVersions(await officialListDeps()), readOfficialPackStatus: force => resolveOfficialPackStatus(force === true), installOfficialPackVersion, officialPackBootstrap }
}

function openMainWindow(): void {
  const window = createMainWindow({
    preloadPath: path.join(moduleDirectory, 'preload.mjs'),
    iconPath: launcherIconPath,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    indexPath: path.join(moduleDirectory, '../dist/index.html'),
    onClosed: () => { mainWindow = null },
  })
  // 点 X 或 Alt+F4 只隐藏到托盘继续后台运行；托盘菜单「退出」经 app.quit()
  // 触发 before-quit 置位 isQuitting 后，这里才放行关闭。
  window.on('close', event => {
    if (isQuitting) return
    event.preventDefault()
    window.hide()
    if (!backgroundNoticeShown) {
      backgroundNoticeShown = true
      tray?.notifyBackground()
    }
  })
  mainWindow = window
}

/** 从托盘或第二实例唤起主窗口；窗口不存在时重建。 */
function showMainWindow(): void {
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    openMainWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  // 无边框透明窗口从后台唤起时常抢不到焦点，短暂置顶可确保激活。
  window.setAlwaysOnTop(true, 'screen-saver')
  window.show()
  window.focus()
  window.setAlwaysOnTop(false, 'screen-saver')
}

// 第二个实例直接退出，由已运行实例通过 second-instance 唤起前台窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
}

app.whenReady().then(async () => {
  await recoverLegacyCredentials(path.join(app.getPath('userData'), 'dsh-credentials-compat')).catch(error => {
    console.error('[credentials] 旧版 DSH 凭据恢复失败。', error)
  })
  try {
    processSupervisor = await createProcessSupervisor({
      root: path.join(app.getPath('userData'), 'process-supervisor'),
      onError: message => console.error(`[process-supervisor] ${message}`),
    })
    configureProcessTracker(processSupervisor)
  } catch (error) {
    console.error('[process-supervisor] 启动失败，退出时只能执行普通清理。', error)
  }
  services = createServices()
  registerIpcHandlers({
    ...services,
    skillsShIndexPath: path.join(app.getPath('userData'), 'skills-sh-index.json'),
    newsCachePath: path.join(app.getPath('userData'), 'juya-news-cache.json'),
    getWindow,
    setWindowMode: (mode: WindowMode) => applyWindowMode(mainWindow, mode),
  })
  await services.profilePoolReady
  openMainWindow()
  // 官方整合包首启/更新核对：后台进行，不挡窗口。
  void services.officialPackBootstrap()
  tray = createTray({ iconPath: launcherIconPath, showMainWindow })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function waitForIdle(check: () => boolean): Promise<void> {
  if (!check()) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (!check()) {
        clearInterval(timer)
        resolve()
      }
    }, 100)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function shutdownLauncherProcesses(): Promise<void> {
  const current = services
  // 先让监督器对仍在运行的根进程做快照；若 DSH 派生了脱离父进程树的服务，
  // 必须在正常停止根进程前收集它们，否则关闭后无法再定位微信机器人 PID。
  const supervisorShutdown = processSupervisor?.shutdown().catch(error => {
    console.error('[process-supervisor] 清理子进程失败。', error)
  }) ?? Promise.resolve()
  const gracefulTasks: Promise<unknown>[] = []
  if (current?.runtime.isRunning()) gracefulTasks.push(current.runtime.stop())
  if (current?.pluginTrial.isBusy()) gracefulTasks.push(current.pluginTrial.cancel())
  if (current?.aiInstaller.isBusy()) gracefulTasks.push(current.aiInstaller.cancel())
  if (current?.copilot.isBusy()) gracefulTasks.push(current.copilot.shutdown())
  if (current?.packManager.isBusy()) gracefulTasks.push(waitForIdle(() => current.packManager.isBusy()))
  if (current?.installer.isBusy()) gracefulTasks.push(waitForIdle(() => current.installer.isBusy()))
  if (current?.applicationAddons.isBusy()) gracefulTasks.push(waitForIdle(() => current.applicationAddons.isBusy()))

  const graceful = Promise.allSettled(gracefulTasks)
  await Promise.race([Promise.all([graceful, supervisorShutdown]), delay(2_000)])
  await supervisorShutdown
  // 监督器处理完整树后，主进程再用本地句柄兜底，覆盖通信丢失或快速关闭。
  await shutdownTrackedProcesses().catch(error => {
    console.error('[process-tracker] 清理子进程失败。', error)
  })
  configureProcessTracker(null)
  await Promise.race([graceful, delay(800)])

  if (current) {
    try {
      const settings = await current.settings.read()
      await healCredentialsLock(
        settings.dshHome,
        path.join(app.getPath('userData'), CREDENTIALS_LOCK_DIRNAME),
      )
    } catch (error) {
      console.error('[shutdown] AI 凭据文件还原失败。', error)
    }
  }
}

// 无论是正常关闭还是安装过程中退出，所有由启动器登记的进程树都必须一起结束。
app.on('before-quit', event => {
  if (allowFinalQuit) return
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  // 放行窗口 close：清理完成后窗口随退出流程正常关闭。
  isQuitting = true
  void shutdownLauncherProcesses().finally(() => {
    allowFinalQuit = true
    app.quit()
  })
})

// will-quit 在 before-quit 清理完成后触发，此时移除托盘图标。
app.on('will-quit', () => {
  tray?.destroy()
  tray = null
})
