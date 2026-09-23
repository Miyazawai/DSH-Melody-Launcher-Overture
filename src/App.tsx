import { Layers3, LoaderCircle } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LauncherApiProvider, resolveLauncherApi, useLauncherApi } from './api/client'
import { LauncherHome } from './components/LauncherHome'
import { TopBar } from './components/TopBar'
import { Toast } from './components/Toast'
import { DshFailureDialog } from './components/dialogs/DshFailureDialog'
import { SettingsDialog } from './components/dialogs/SettingsDialog'
import { UpdateDialog } from './components/dialogs/UpdateDialog'
import { DSH_REPOSITORY } from './constants'
import { BUSY } from './hooks/use-async-action'
import { useLauncherStore } from './hooks/use-launcher-store'
import { useNavigation } from './hooks/use-navigation'
import { usePackInstall } from './hooks/use-pack-install'
import { isInstallProgressActive } from './lib/install-progress'
import { HOME_TAB_ORDER } from './lib/nav'
import type { HomeTab } from './types'

// 启动页只看得到 LauncherHome；整合包/插件/技能/预设/版本这一整块面板（以及导入对话框）
// 拆成按需加载的 chunk，首屏要解析的 JS 就少一截。
const SettingsPanels = lazy(() => import('./views/SettingsView').then(module => ({ default: module.SettingsPanels })))
const PackInstallDialog = lazy(() => import('./components/dialogs/PackInstallDialog').then(module => ({ default: module.PackInstallDialog })))
const SessionImportDialog = lazy(() => import('./components/dialogs/SessionImportDialog').then(module => ({ default: module.SessionImportDialog })))
const PackExportDialog = lazy(() => import('./components/dialogs/PackExportDialog').then(module => ({ default: module.PackExportDialog })))
const PackVersionCloneDialog = lazy(() => import('./components/dialogs/PackVersionCloneDialog').then(module => ({ default: module.PackVersionCloneDialog })))

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

  /** 本机已安装的 DSH 版本集合：导入的整合包若要求缺失版本，安装前需确认下载。 */
  const installedDshVersions = useMemo(
    () => new Set((store.runtimeEnvironment?.dshInstalled ?? []).map(item => item.version)),
    [store.runtimeEnvironment],
  )

  // 对话框开关是纯展示状态，不进 store。
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  // 「导入会话」的目标包 id（入口长在那个包的卡片上）。
  const [sessionImportTarget, setSessionImportTarget] = useState<string | null>(null)
  // 「导出」对话框对应的包 id（隐私勾选项在那里决定）。
  const [exportTarget, setExportTarget] = useState<string | null>(null)
  // 「切换版本」（升版副本）对话框对应的包 id。
  const [cloneTarget, setCloneTarget] = useState<string | null>(null)
  // keep-mounted 集合：访问过的一级 tab 保持挂载，切换只切可见性。
  const visitedTabs = useRef(new Set<HomeTab>(['start']))

  useEffect(() => {
    document.documentElement.dataset.theme = store.settings?.uiTheme ?? 'deepseek'
  }, [store.settings?.uiTheme])

  const installingResource = isInstallProgressActive(store.installProgress)
  const installingDsh = store.busy === BUSY.dshInstall
    || (installingResource && store.installProgress?.kind === 'dsh')
  const installingApplication = installingResource && store.installProgress?.kind === 'application'
  // 安装会写入整合包、Skill 或应用注册表；跨页时仍需阻止这些写操作。
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
                    launchActivity={store.packActivity}
                    onToggleRuntime={toggleRuntime}
                    onOpenWeb={openHarness}
                    onVersionSelect={() => navigation.goHome('packs')}
                    onUpdateDsh={() => { void store.updateDsh() }}
                    onOpenLauncherUpdate={() => setUpdateOpen(true)}
                    onNavigateTab={navigation.goHome}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />
                ) : (
                  <Suspense fallback={null}>
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
                    onUninstallSkill={store.uninstallSkill}
                    profileMutationLocked={profileMutationLocked}
                    installProgress={store.installProgress}
                    onRefresh={() => {
                      void store.refreshProfile()
                      void store.refreshSecondaryResources()
                      void store.refreshPacks()
                      void store.refreshRuntimeEnvironment(true)
                    }}
                    onImportPack={() => void handlePackImport()}
                    onImportPackPath={path => { void packInstall.startImport(path) }}
                    onRestoreOfficialPack={() => { void store.restoreOfficialPack() }}
                    officialStatus={store.officialStatus}
                    officialVersions={store.officialVersions}
                    officialVersionsError={store.officialVersionsError}
                    officialVersionsBusy={store.officialVersionsBusy}
                    onReadOfficialPackStatus={store.readOfficialPackStatus}
                    onRefreshOfficialVersions={store.refreshOfficialVersions}
                    onInstallOfficialPackVersion={store.installOfficialPackVersion}
                    onInstallDshVersion={async version => {
                      const ok = await store.installDshVersion(version)
                      // 装版本会自动补发同名整合包（零包时还会自动激活成为当前包），
                      // 刷新包列表与整合包/插件/技能读数让新环境立刻可见。
                      if (ok) {
                        await Promise.all([store.refreshPacks(), store.refreshProfile(), store.refreshSecondaryResources()])
                      }
                      return ok
                    }}
                    onRemoveDshVersion={store.removeDshVersion}
                    onTogglePlugin={store.togglePlugin}
                    onUninstallPlugin={async plugin => { await store.uninstallPlugin(plugin); return true }}
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
                    packActivity={store.packActivity}
                    packDownload={store.packDownload}
                    packStage={store.packStage}
                    onRenamePack={store.renamePack}
                    onCreateBlankPack={(name, dshVersion) => store.createBlankPack({ name, dshVersion })}
                    onPackDiskUsage={store.packDiskUsage}
                    onRemovePack={store.removePack}
                    onRequestExport={packId => setExportTarget(packId)}
                    onImportSessions={packId => setSessionImportTarget(packId)}
                    onCloneVersion={packId => setCloneTarget(packId)}
                    onOpenDshFolder={() => void api.openDshFolder()}
                    onOpenPluginFolder={packageName => { void api.openProfilePluginFolder(packageName) }}
                    onOpenPath={targetPath => { void api.openPath(targetPath) }}
                    onNavigateTab={navigation.goHome}
                  />
                  </Suspense>
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
        <Suspense fallback={null}>
          <PackInstallDialog
          phase={packInstall.phase}
          events={packInstall.events}
          result={packInstall.result}
          error={packInstall.error}
          analysis={packInstall.analysis}
          itemProgress={packInstall.itemProgress}
          hasSnapshot={packInstall.hasSnapshot}
          packSnapshotsAvailable={store.packSnapshotsAvailable}
          installedDshVersions={installedDshVersions}
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
        </Suspense>
      )}
      {sessionImportTarget && (
        <Suspense fallback={null}>
          <SessionImportDialog
            targetPackId={sessionImportTarget}
            targetPackName={store.packs.find(pack => pack.id === sessionImportTarget)?.name ?? sessionImportTarget}
            packs={store.packs}
            busy={store.busy !== null || profileMutationLocked}
            onPreview={sourcePackId => store.previewSessionImport(sourcePackId, sessionImportTarget)}
            onImport={async sourcePackId => {
              const done = await store.importSessionHistory(sourcePackId, sessionImportTarget)
              if (done) void store.refreshPacks()
              return done
            }}
            onUndo={undoId => store.undoSessionImport(undoId)}
            onClose={() => setSessionImportTarget(null)}
          />
        </Suspense>
      )}
      {exportTarget && (
        <Suspense fallback={null}>
          <PackExportDialog
            packName={store.packs.find(pack => pack.id === exportTarget)?.name ?? exportTarget}
            busy={store.busy !== null || profileMutationLocked}
            onExport={privacy => store.exportPack(exportTarget, privacy)}
            onClose={() => setExportTarget(null)}
          />
        </Suspense>
      )}
      {cloneTarget && (
        <Suspense fallback={null}>
          <PackVersionCloneDialog
            packName={store.packs.find(pack => pack.id === cloneTarget)?.name ?? cloneTarget}
            currentVersion={store.packs.find(pack => pack.id === cloneTarget)?.dshVersion ?? null}
            installedVersions={(store.runtimeEnvironment?.dshInstalled ?? []).map(item => item.version)}
            availableVersions={(store.runtimeEnvironment?.dshAvailable ?? []).map(item => item.version)}
            busy={store.busy !== null || profileMutationLocked}
            onClone={async request => {
              const created = await store.createVersionClone(cloneTarget, request)
              if (created) void store.refreshPacks()
              return created
            }}
            onClose={() => setCloneTarget(null)}
          />
        </Suspense>
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
      {store.dshFailure && (
        <DshFailureDialog failure={store.dshFailure} onClose={store.dismissDshFailure} />
      )}
      {store.toast && <Toast toast={store.toast} onClose={store.dismissToast} />}
    </div>
  )
}
