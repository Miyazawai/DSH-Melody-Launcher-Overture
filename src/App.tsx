import { Layers3, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LauncherApiProvider, resolveLauncherApi, useLauncherApi } from './api/client'
import { LauncherHome } from './components/LauncherHome'
import { TopBar } from './components/TopBar'
import { Toast } from './components/Toast'
import { PackInstallDialog } from './components/dialogs/PackInstallDialog'
import { SettingsDialog } from './components/dialogs/SettingsDialog'
import { UpdateDialog } from './components/dialogs/UpdateDialog'
import { DSH_REPOSITORY } from './constants'
import { BUSY } from './hooks/use-async-action'
import { useLauncherStore } from './hooks/use-launcher-store'
import { useNavigation } from './hooks/use-navigation'
import { usePackInstall } from './hooks/use-pack-install'
import { isInstallProgressActive } from './lib/install-progress'
import type { HomeTab } from './types'
import { SettingsPanels } from './views/SettingsView'

/** 一级导航顺序（keep-mounted 渲染顺序）。 */
const HOME_TAB_ORDER: HomeTab[] = ['start', 'versions', 'plugins', 'skills', 'presets', 'packs']

/**
 * 应用根。
 * 只做三件事：提供主进程 API、组装状态与视图、挂载对话框。
 * 业务逻辑在 hooks 里，展示逻辑在 components 与 views 里。
 * 管理界面（开发人员选项）已随「暴力整合包模式」路线整体移除。
 */
export default function App() {
  const api = useMemo(() => resolveLauncherApi(), [])
  return (
    <LauncherApiProvider value={api}>
      <LauncherShell />
    </LauncherApiProvider>
  )
}

function LauncherShell() {
  const api = useLauncherApi()
  const store = useLauncherStore()
  const navigation = useNavigation()
  // 整合包创建/导入是流式任务；结算后刷新包列表与快照状态。
  const packInstall = usePackInstall(() => {
    void store.refreshPacks()
    void store.refreshPackSnapshots()
  }, store.showToast)

  // 对话框开关是纯展示状态，不进 store。
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  // keep-mounted 集合：访问过的一级 tab 保持挂载，切换只切可见性。
  const visitedTabs = useRef(new Set<HomeTab>(['start']))

  useEffect(() => {
    document.documentElement.dataset.theme = store.settings?.uiTheme ?? 'deepseek'
  }, [store.settings?.uiTheme])

  const installingResource = isInstallProgressActive(store.installProgress)
  const installingDsh = store.busy === BUSY.dshInstall
    || (installingResource && store.installProgress?.kind === 'dsh')
  const installingApplication = installingResource && store.installProgress?.kind === 'application'
  // 安装会写入 Profile、Skill 或应用注册表；跨页时仍需阻止这些写操作。
  const profileMutationLocked = installingResource
  // The selector itself must not be latched by a stale install-progress event.
  // The main-process mutation guard remains authoritative while a real
  // installer is still active; only an in-flight Profile switch disables it.
  const profileSwitcherLocked = store.busy?.startsWith('profile-switch:') === true
  const runtimeBusy = store.busy === BUSY.runtime || installingResource || installingApplication || Boolean(store.busy?.startsWith('application'))

  const toggleRuntime = async () => {
    await store.toggleRuntime()
  }

  const openHarness = () => {
    if (store.runtime.url) void api.openExternal(store.runtime.url)
  }

  const closeWindow = () => void api.closeWindow()
  const minimizeWindow = () => void api.minimizeWindow()

  /** 「导入整合包」：选文件 → analyze 拿预览 → PackInstallDialog 展示 preview 态。 */
  const handlePackImport = async () => {
    const path = await api.pickPackFile()
    if (!path) return
    await packInstall.startImport(path)
  }

  if (store.loading || !store.settings || !store.profile) {
    return (
      <div className="app-loading">
        <div className="brand-mark"><Layers3 size={22} /></div>
        <LoaderCircle className="spin" size={22} />
        <span>正在读取 DSH 配置</span>
      </div>
    )
  }

  const { settings, profile } = store
  visitedTabs.current.add(navigation.homeTab)

  return (
    <div className="app-root">
      <TopBar
        activeTab={navigation.homeTab}
        openWebVisible={store.runtime.running && Boolean(store.runtime.url)}
        onSelectTab={navigation.goHome}
        onOpenHarness={openHarness}
        onMinimize={minimizeWindow}
        onClose={closeWindow}
      />
      <div className="app-content">
        <div className="surface-stage surface-launcher">
          <div className="surface-host launcher-surface-host">
            {HOME_TAB_ORDER.filter(tab => visitedTabs.current.has(tab)).map(tab => (
              <div key={tab} className={`home-tab-pane ${navigation.homeTab === tab ? '' : 'view-hidden'}`}>
                {tab === 'start' ? (
                  <LauncherHome
                    runtime={store.runtime}
                    dshInstallation={store.dshInstallation}
                    dshUpdate={store.dshUpdate}
                    launcherUpdate={store.launcherUpdate}
                    installProgress={store.installProgress?.repository === DSH_REPOSITORY ? store.installProgress : null}
                    busy={runtimeBusy}
                    installingDsh={installingDsh}
                    activeRuntimeReplacement={store.activeRuntimeReplacement}
                    bundleCount={profile.activeBundles.length}
                    pluginCount={profile.dependencyCount}
                    skillCount={store.installedSkills.length}
                    presetCount={store.installedPresets.length}
                    activePack={(() => {
                      const pack = store.packs.find(item => item.id === settings.activePackId)
                      return pack ? { name: pack.name, dshVersion: pack.dshVersion } : null
                    })()}
                    onToggleRuntime={toggleRuntime}
                    onVersionSelect={() => navigation.goHome('packs')}
                    onUpdateDsh={() => { void store.updateDsh() }}
                    onOpenLauncherUpdate={() => setUpdateOpen(true)}
                    onNavigateTab={navigation.goHome}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />
                ) : (
                  <SettingsPanels
                    tab={tab}
                    settings={settings}
                    profile={profile}
                    dshInstallation={store.dshInstallation}
                    runtimeEnvironment={store.runtimeEnvironment}
                    installedSkills={store.installedSkills}
                    installedPresets={store.installedPresets}
                    packs={store.packs}
                    busy={store.busy}
                    profileMutationLocked={profileMutationLocked}
                    installProgress={store.installProgress}
                    onRefresh={() => {
                      void store.refreshProfile()
                      void store.refreshSecondaryResources()
                      void store.refreshPacks()
                      void store.refreshRuntimeEnvironment(true)
                    }}
                    onImportPack={() => void handlePackImport()}
                    onInstallDshVersion={async version => {
                      const ok = await store.installDshVersion(version)
                      // 装版本会自动补发同名整合包（零包时还会自动激活成为当前包），
                      // 刷新包列表与 Profile/插件/技能读数让新环境立刻可见。
                      if (ok) {
                        await Promise.all([store.refreshPacks(), store.refreshProfile(), store.refreshSecondaryResources()])
                      }
                      return ok
                    }}
                    onRemoveDshVersion={store.removeDshVersion}
                    onTogglePlugin={store.togglePlugin}
                    onToggleSkill={store.toggleSkill}
                    onTogglePreset={store.togglePreset}
                    onSkillInstalled={result => {
                      store.applyCatalogSkillInstall(result)
                      // 包行计数是实时探测家目录的：装完技能刷一次让计数立刻可见。
                      void store.refreshPacks()
                    }}
                    onProfileChanged={() => {
                      void store.refreshProfile()
                      // 插件安装/启停只写包家目录，包行计数实时探测自家目录：一并刷新。
                      void store.refreshPacks()
                    }}
                    onActivatePack={store.activatePack}
                    onRenamePack={store.renamePack}
                    onCreateBlankPack={(name, dshVersion) => store.createBlankPack({ name, dshVersion })}
                    onPackDiskUsage={store.packDiskUsage}
                    onRemovePack={store.removePack}
                    onExportPack={store.exportPack}
                    onOpenDshFolder={() => void api.openDshFolder()}
                    onOpenPluginFolder={packageName => { void api.openProfilePluginFolder(packageName) }}
                    onOpenPath={targetPath => { void api.openPath(targetPath) }}
                    onNavigateTab={navigation.goHome}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          busy={store.busy === BUSY.settings || profileMutationLocked}
          onClose={() => setSettingsOpen(false)}
          onSave={async next => { if (await store.saveSettings(next)) setSettingsOpen(false) }}
        />
      )}
      {packInstall.phase !== 'idle' && (
        <PackInstallDialog
          phase={packInstall.phase}
          events={packInstall.events}
          result={packInstall.result}
          error={packInstall.error}
          analysis={packInstall.analysis}
          itemProgress={packInstall.itemProgress}
          hasSnapshot={packInstall.hasSnapshot}
          packSnapshotsAvailable={store.packSnapshotsAvailable}
          busy={store.busy !== null || packInstall.busy !== null}
          onConfirmImport={(items, name) => void packInstall.confirmImport(packInstall.importPath ?? '', items, name)}
          onRollback={() => void packInstall.rollback()}
          onActivate={packId => {
            void (async () => {
              if (await store.activatePack(packId)) packInstall.reset()
            })()
          }}
          onClose={packInstall.reset}
        />
      )}
      {updateOpen && store.launcherUpdate && (
        <UpdateDialog
          status={store.launcherUpdate}
          progress={store.launcherUpdateProgress}
          busy={store.busy === 'launcher-update-download' || store.busy === 'launcher-update-apply'}
          onDownload={() => { void store.downloadLauncherUpdate() }}
          onApply={() => { void store.applyLauncherUpdate() }}
          onClose={() => setUpdateOpen(false)}
        />
      )}
      {store.toast && <Toast toast={store.toast} onClose={store.dismissToast} />}
    </div>
  )
}
