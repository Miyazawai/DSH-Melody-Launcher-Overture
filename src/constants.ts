// 主进程与渲染进程共享的常量。
// 与 types.ts 一样，这个文件是两侧的公共契约 —— 任何一侧单独持有副本都会随时间漂移。

/** DSH 本体的 GitHub 仓库。出现在插件列表中时按本体而非普通插件处理。 */
export const DSH_REPOSITORY = 'deepseek-ai/deepseek-harness'

/**
 * 插件目录（meta-repo catalog）所在的上游仓库：目录同步与 PR 提交以它为准。
 * 注意与下面的 LAUNCHER_RELEASE_REPOSITORY（序曲独立发布线）区分。
 */
export const LAUNCHER_REPOSITORY = 'rirko/dsh-melody-launcher'

/**
 * 序曲（Overture）分支的独立发布仓库：启动器自更新检测与官方整合包发布
 * 都以它的 Release 页为准（v0.1.x 版本线、official-pack-v*.zip 资产）。
 */
export const LAUNCHER_RELEASE_REPOSITORY = 'Miyazawai/DSH-Melody-Launcher-Overture'

/**
 * 官方默认整合包的版本号：与发布到 LAUNCHER_RELEASE_REPOSITORY Release 的
 * `official-pack-v<版本>.zip` 资产名同步。启动器首启/更新后按此版本核对，
 * 本地没有同版本官方包就自动获取导入；界面上「恢复官方整合包」走同一条链。
 */
export const OFFICIAL_PACK_VERSION = '0.1.1'

/** DSH 本体的 npm 包名。检测与安装都以它为准。 */
export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

/** 未显式配置时使用的默认整合包。 */
export const DEFAULT_PROFILE_NAME = 'web'

/**
 * 内置公共 GitHub 镜像前缀（拼成 `<镜像>/<原始 URL>`）。
 * 主进程的下载候选链与设置页的镜像预选共用这一份，避免两处各写一套。
 */
export const GITHUB_MIRROR_PRESETS = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/'] as const

/** 渲染层保留的最大日志条数，超出后丢弃最旧的记录。 */
export const MAX_LOG_LINES = 500

/** 尚未取到主进程状态时的占位值。 */
export const EMPTY_RUNTIME_STATE = { running: false, pid: null, startedAt: null, url: null, port: null } as const
export const EMPTY_DSH_INSTALLATION = { installed: false, version: null, executable: null, source: null } as const

/**
 * IPC 通道名。主进程注册与 preload 调用共用这一份定义 ——
 * 此前两侧各写一遍字面量，改名时很容易只改一边。
 */
export const IPC = {
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  dshDetect: 'dsh:detect-installation',
  dshUpdateCheck: 'dsh:check-update',
  runtimeEnvironmentRead: 'runtime-environment:read',
  runtimeEnvironmentInstallDsh: 'runtime-environment:install-dsh',
  runtimeEnvironmentSelectDsh: 'runtime-environment:select-dsh',
  runtimeEnvironmentRemoveDsh: 'runtime-environment:remove-dsh',
  runtimeEnvironmentInstallNode: 'runtime-environment:install-node',
  runtimeEnvironmentSelectNode: 'runtime-environment:select-node',
  runtimeEnvironmentRemoveNode: 'runtime-environment:remove-node',
  runtimeEnvironmentCancel: 'runtime-environment:cancel',
  runtimeEnvironmentOpenDshFolder: 'runtime-environment:open-dsh-folder',
  runtimeEnvironmentOpenNodeFolder: 'runtime-environment:open-node-folder',
  launcherUpdateCheck: 'launcher:update-check',
  launcherUpdateDownload: 'launcher:update-download',
  launcherUpdateApply: 'launcher:update-apply',
  credentialStatus: 'credentials:deepseek-status',
  credentialSet: 'credentials:deepseek-set',
  credentialClear: 'credentials:deepseek-clear',
  customApiList: 'custom-api:list',
  customApiSave: 'custom-api:save',
  customApiRemove: 'custom-api:remove',
  githubAuthStatus: 'github-auth:status',
  githubAuthTokenLogin: 'github-auth:token-login',
  githubAuthDeviceBegin: 'github-auth:device-begin',
  githubAuthDeviceComplete: 'github-auth:device-complete',
  githubAuthDeviceCancel: 'github-auth:device-cancel',
  githubAuthLogout: 'github-auth:logout',
  githubPullRequests: 'github:pull-requests',
  githubStarStatus: 'github:star-status',
  githubStarSet: 'github:star-set',
  chooseDirectory: 'dialog:directory',
  profileRead: 'profile:read',
  profilesList: 'profiles:list',
  profilesCreate: 'profiles:create',
  profilesClone: 'profiles:clone',
  profilesSwitch: 'profiles:switch',
  profilesDelete: 'profiles:delete',
  profilesMetadata: 'profiles:metadata',
  profilesExport: 'profiles:export',
  profilesImport: 'profiles:import',
  profilesRepositoryAnalyze: 'profiles:repository-analyze',
  profilesRepositoryImport: 'profiles:repository-import',
  profilesMatchPlugin: 'profiles:match-plugin',
  profileToggle: 'profile:toggle',
  profileReorder: 'profile:reorder',
  catalogDiscover: 'catalog:discover',
  catalogAnalyze: 'catalog:analyze',
  catalogRefreshIndex: 'catalog:refresh-index',
  catalogImportUrl: 'catalog:import-url',
  dshMarketLoad: 'dsh-market:load',
  dshMarketInstall: 'dsh-market:install',
  dshMarketUpdate: 'dsh-market:update',
  dshMarketUninstall: 'dsh-market:uninstall',
  dshMarketToggle: 'dsh-market:toggle',
  dshMarketUpdates: 'dsh-market:updates',
  pluginsInstall: 'plugins:install',
  pluginsUninstall: 'plugins:uninstall',
  pluginsTrial: 'plugins:trial',
  pluginsTrialRead: 'plugins:trial-read',
  aiInstall: 'ai:install',
  aiAdaptPlugin: 'ai:adapt-plugin',
  aiRepairRuntime: 'ai:repair-runtime',
  aiApprove: 'ai:approve',
  aiCancel: 'ai:cancel',
  aiRollback: 'ai:rollback',
  aiStatus: 'ai:status',
  aiHasSnapshot: 'ai:has-snapshot',
  aiSessionsList: 'ai-sessions:list',
  aiSessionsCreate: 'ai-sessions:create',
  aiSessionsSend: 'ai-sessions:send',
  aiSessionsModels: 'ai-sessions:models',
  aiSessionsSetModel: 'ai-sessions:set-model',
  aiSessionsCancel: 'ai-sessions:cancel',
  aiSessionsApprove: 'ai-sessions:approve',
  aiSessionsRollback: 'ai-sessions:rollback',
  aiSessionsDelete: 'ai-sessions:delete',
  skillsInstall: 'skills:install',
  skillsReadInstalled: 'skills:read-installed',
  skillsToggle: 'skills:toggle',
  skillsUninstall: 'skills:uninstall',
  applicationsInstall: 'applications:install',
  applicationsReadInstalled: 'applications:read-installed',
  applicationsToggle: 'applications:toggle',
  applicationsUninstall: 'applications:uninstall',
  presetsInstall: 'presets:install',
  presetsReadInstalled: 'presets:read-installed',
  presetsToggle: 'presets:toggle',
  presetsUninstall: 'presets:uninstall',
  presetsBuiltin: 'presets:builtin',
  skillMarketAnalyze: 'skill-market:analyze',
  skillMarketInstall: 'skill-market:install',
  skillMarketCatalog: 'skill-market:catalog',
  deepseekBalance: 'deepseek:balance',
  newsFeed: 'news:feed',
  dshUsage: 'dsh:usage',
  skillMarketInstallByName: 'skill-market:install-by-name',
  runtimeState: 'runtime:state',
  runtimeStart: 'runtime:start',
  runtimeStop: 'runtime:stop',
  packsList: 'packs:list',
  packsCreate: 'packs:create',
  packsAnalyzeImport: 'packs:analyze-import',
  packsImport: 'packs:import',
  packsExport: 'packs:export',
  packsRestoreOfficial: 'packs:restore-official',
  /** 列出 Release 上所有官方默认整合包版本。 */
  packsOfficialVersions: 'packs:official-versions',
  /** 官方整合包状态：推荐版本 / 已装版本 / 是否有更新。 */
  packsOfficialStatus: 'packs:official-status',
  /** 下载并导入指定版本的官方默认整合包。 */
  packsOfficialInstall: 'packs:official-install',
  packsPickFile: 'packs:pick-file',
  packsActivate: 'packs:activate',
  packsRename: 'packs:rename',
  packsCreateBlank: 'packs:create-blank',
  packsDiskUsage: 'packs:disk-usage',
  packsRemove: 'packs:remove',
  packsRollback: 'packs:rollback',
  packsHasSnapshot: 'packs:has-snapshot',
  packsAddPlugin: 'packs:add-plugin',
  packsAddPreset: 'packs:add-preset',
  packsAddSkill: 'packs:add-skill',
  packsAddApplication: 'packs:add-application',
  packsRemoveItem: 'packs:remove-item',
  packsToggleItem: 'packs:toggle-item',
  packsTogglePreset: 'packs:toggle-preset',
  packsToggleSkill: 'packs:toggle-skill',
  packsToggleApplication: 'packs:toggle-application',
  packsRemovePreset: 'packs:remove-preset',
  packsRemoveSkill: 'packs:remove-skill',
  packsRemoveApplication: 'packs:remove-application',
  openExternal: 'shell:open-external',
  openPath: 'shell:open-path',
  openProfilePluginFolder: 'shell:open-profile-plugin-folder',
  recommendedStatus: 'recommended:status',
  recommendedInstall: 'recommended:install',
  windowSetMode: 'window:set-mode',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
} as const

/** 主进程主动推送给渲染层的事件通道。 */
export const IPC_EVENTS = {
  runtimeOutput: 'runtime:output',
  runtimeStateChanged: 'runtime:state-changed',
  catalogAnalysisProgress: 'catalog:analysis-progress',
  dshMarketProgress: 'dsh-market:progress',
  installProgress: 'plugins:install-progress',
  launcherUpdateProgress: 'launcher:update-progress',
  pluginTrialEvent: 'plugins:trial-event',
  aiInstallEvent: 'ai:install-event',
  aiSessionEvent: 'ai-session:event',
  packProgress: 'packs:progress',
  /** 官方整合包状态变化（启动核对完成 / 有新版本）。 */
  officialPackStatus: 'packs:official-status-changed',
} as const
