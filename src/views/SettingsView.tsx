import {
  ArrowLeft,
  BookOpen,
  Check,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Maximize2,
  Minus,
  Package,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Store,
  Trash2,
  TrendingUp,
  Wand2,
  X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { useLauncherStore } from '../hooks/use-launcher-store'
import { formatBytes } from '../lib/format'
import { SkeletonStrip } from '../components/Skeleton'
import { DshMarketView } from './DshMarketView'
import {
  SKILL_CATEGORIES,
  SKILL_MARKET_SOURCES,
  collectSkillMarketEntries,
  collectSkillsShEntries,
  filterSkillMarketEntries,
  formatInstalls,
  partitionDshVersions,
  type SkillCategory,
  type SkillMarketEntry,
  type SkillMarketSource,
  type SkillMarketSourceKind,
} from '../lib/skill-market'
import type {
  AppSettings,
  BuiltinAgentPreset,
  HomeTab,
  DshInstallationStatus,
  InstalledPreset,
  InstalledSkill,
  InstallProgress,
  ManagedPlugin,
  PackStatus,
  ProfileState,
  RuntimeEnvironmentState,
  RuntimeVersionCandidate,
  SkillInstallResult,
  SkillRepositoryAnalysis,
  SkillsShSkill,
} from '../types'

/**
 * C 端「设置」页：启动页齿轮入口进来的全屏简洁管理页。
 * 顶栏=返回（左上）+ 窗口键（最右）；左竖栏=四个分类 + 刷新/开发者模式；
 * 右内容=当前分类面板。版本直接点列表下载；插件内嵌 DSH Market；技能内嵌双源技能市场。
 * 视觉沿用现有主题体系。
 */

interface SettingsPanelsProps {
  settings: AppSettings
  /** 一级导航当前 tab（start 由 LauncherHome 承担，不进这里）。 */
  tab: Exclude<HomeTab, 'start'>
  profile: ProfileState
  dshInstallation: DshInstallationStatus
  runtimeEnvironment: RuntimeEnvironmentState | null
  installedSkills: InstalledSkill[]
  installedPresets: InstalledPreset[]
  packs: PackStatus[]
  busy: string | null
  profileMutationLocked: boolean
  installProgress: InstallProgress | null
  onRefresh: () => void
  onImportPack: () => void
  onInstallDshVersion: (version: string) => Promise<boolean>
  onRemoveDshVersion: (version: string) => Promise<boolean>
  onTogglePlugin: (plugin: ManagedPlugin, enabled: boolean) => Promise<boolean>
  onUninstallPlugin: (plugin: ManagedPlugin) => Promise<boolean>
  onToggleSkill: (skill: InstalledSkill, enabled: boolean) => void
  onTogglePreset: (preset: InstalledPreset, enabled: boolean) => void
  onSkillInstalled: (result: SkillInstallResult) => void
  onProfileChanged: () => void
  onActivatePack: (packId: string) => Promise<boolean>
  onRenamePack: (packId: string, name: string) => Promise<boolean>
  onCreateBlankPack: (name: string, dshVersion: string | null) => Promise<PackStatus | undefined>
  onPackDiskUsage: (packId: string) => Promise<number>
  onRemovePack: (packId: string) => Promise<boolean>
  onExportPack: (packId: string) => Promise<string | null>
  onOpenDshFolder: () => void
  onOpenPluginFolder: (packageName: string) => void
  onOpenPath: (targetPath: string) => void
  /** 跳转到一级导航的某个 tab（零包引导用：去版本页下载 / 插件技能页安装）。 */
  onNavigateTab: (tab: HomeTab) => void
}

export function SettingsPanels({
  settings,
  tab,
  profile,
  dshInstallation,
  runtimeEnvironment,
  installedSkills,
  installedPresets,
  packs,
  busy,
  profileMutationLocked,
  installProgress,
  onRefresh,
  onImportPack,
  onInstallDshVersion,
  onRemoveDshVersion,
  onTogglePlugin,
  onUninstallPlugin,
  onToggleSkill,
  onTogglePreset,
  onSkillInstalled,
  onProfileChanged,
  onActivatePack,
  onRenamePack,
  onCreateBlankPack,
  onPackDiskUsage,
  onRemovePack,
  onExportPack,
  onOpenDshFolder,
  onOpenPluginFolder,
  onOpenPath,
  onNavigateTab,
}: SettingsPanelsProps) {
  const activePack = useMemo(() => {
    const direct = packs.find(pack => pack.id === settings.profileName)
    if (direct) return direct
    return packs.find(pack => pack.id === settings.activePackId) ?? null
  }, [packs, settings.activePackId, settings.profileName])

  const locked = busy !== null || profileMutationLocked

  return (
    <div className="home-tab-page">
      <main className="settings-content">
          {tab === 'versions' && (
            <SettingsVersions
              environment={runtimeEnvironment}
              installed={Boolean(dshInstallation.installed)}
              busy={locked}
              installProgress={installProgress}
              onInstall={onInstallDshVersion}
              onRemove={onRemoveDshVersion}
              onOpenFolder={onOpenDshFolder}
              onRefresh={onRefresh}
              refreshLocked={locked}
            />
          )}
          {tab === 'plugins' && (
            <SettingsPluginsTab
              profile={profile}
              busy={locked}
              onTogglePlugin={onTogglePlugin}
              onUninstallPlugin={onUninstallPlugin}
              onOpenPluginFolder={onOpenPluginFolder}
              onProfileChanged={onProfileChanged}
              onRefresh={onRefresh}
              refreshLocked={locked}
            />
          )}
          {tab === 'skills' && (
            <SettingsSkillsTab
              installedSkills={installedSkills}
              busy={locked}
              dshHome={settings.dshHome}
              onToggleSkill={onToggleSkill}
              onSkillInstalled={onSkillInstalled}
              onRefresh={onRefresh}
              refreshLocked={locked}
              onOpenPath={onOpenPath}
            />
          )}
          {tab === 'presets' && (
            <SettingsPresetsTab
              installedPresets={installedPresets}
              busy={locked}
              dshHome={settings.dshHome}
              onTogglePreset={onTogglePreset}
              onOpenPath={onOpenPath}
              onRefresh={onRefresh}
              refreshLocked={locked}
            />
          )}
          {tab === 'packs' && (
            <SettingsPacks
              packs={packs}
              activePack={activePack}
              busy={locked}
              dshInstalledVersions={(runtimeEnvironment?.dshInstalled ?? []).map(item => item.version)}
              onRefresh={onRefresh}
              onImport={onImportPack}
              onCreateBlank={async (name, dshVersion) => {
                const created = await onCreateBlankPack(name, dshVersion)
                return created !== undefined
              }}
              onActivate={id => { void onActivatePack(id) }}
              onRename={async (id, name) => onRenamePack(id, name)}
              onExport={id => { void onExportPack(id) }}
              onRemove={onRemovePack}
              onDiskUsage={onPackDiskUsage}
              onNavigateTab={onNavigateTab}
            />
          )}
      </main>
    </div>
  )
}

/** 面板标题行右侧的轻量刷新钮（取代悬浮在页面角上的孤立按钮）。 */
function PanelRefresh({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" className="settings-panel-refresh" onClick={onClick} disabled={disabled}>
      <RefreshCw size={13} className={disabled ? 'spin' : undefined} /><span>刷新</span>
    </button>
  )
}

function SettingsVersions({
  environment,
  installed,
  busy,
  installProgress,
  onInstall,
  onRemove,
  onOpenFolder,
  onRefresh,
  refreshLocked,
}: {
  environment: RuntimeEnvironmentState | null
  installed: boolean
  busy: boolean
  installProgress: InstallProgress | null
  onInstall: (version: string) => Promise<boolean>
  onRemove: (version: string) => Promise<boolean>
  onOpenFolder: () => void
  onRefresh: () => void
  refreshLocked: boolean
}) {
  const [expandedGroup, setExpandedGroup] = useState<'stable' | 'prerelease' | null>(null)
  const [removingVersion, setRemovingVersion] = useState<string | null>(null)
  const dshProgress = installProgress && installProgress.kind === 'dsh'
    && installProgress.phase !== 'complete' && installProgress.phase !== 'error'
    ? installProgress : null

  if (!environment) {
    return <div className="settings-empty"><LoaderCircle className="spin" size={20} />正在读取 DSH 版本</div>
  }

  const installedVersions = new Set(environment.dshInstalled.map(item => item.version))
  const { stable, prerelease } = partitionDshVersions(environment.dshAvailable, installedVersions)

  return (
    <div className="settings-stack">
      <section className="settings-panel">
        <div className="settings-panel-heading">
          <div className="settings-panel-title"><Cpu size={17} /><span>已安装版本</span></div>
          <div className="settings-market-heading-actions">
            <PanelRefresh onClick={onRefresh} disabled={refreshLocked} />
            <button type="button" className="icon-button" onClick={onOpenFolder} title="打开 DSH 版本文件夹" aria-label="打开 DSH 版本文件夹"><FolderOpen size={16} /></button>
          </div>
        </div>
        <div className="settings-current">
          <span>当前整合包使用</span>
          <strong>{environment.dshSelectedVersion ?? '未绑定'}</strong>
        </div>
        <div className="settings-hint">本页只负责版本的下载与删除；切换环境请到「整合包」页（每个 DSH 版本对应一个自动整合包）。</div>
        {removingVersion && (
          <div className="settings-progress">
            <LoaderCircle size={14} className="spin" />
            <span>正在卸载 {removingVersion}（清理版本目录里的依赖文件）…</span>
            <div className="settings-progress-track indeterminate" />
          </div>
        )}
        <div className="settings-list">
          {environment.dshInstalled.map(item => (
            <ResourceRow
              key={item.version}
              title={item.version}
              subtitle={item.source === 'legacy' ? '旧目录' : undefined}
              enabled={item.selected}
              selected={item.selected}
              busy={busy || removingVersion !== null}
              onRemove={item.removable ? () => {
                const warning = item.selected
                  ? `「${item.version}」是当前整合包在用的版本，卸载后会自动切换到其它已装版本。确定卸载？`
                  : `确定卸载 DSH ${item.version}？`
                if (!window.confirm(warning)) return
                setRemovingVersion(item.version)
                void onRemove(item.version).finally(() => setRemovingVersion(null))
              } : undefined}
            />
          ))}
          {environment.dshInstalled.length === 0 && (
            <div className="settings-empty">{installed ? '该版本未出现在列表中，刷新后再试。' : '尚未安装任何版本；在下方「可下载版本」里点一个即可。'}</div>
          )}
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-heading">
          <div className="settings-panel-title"><Download size={17} /><span>可下载版本</span></div>
        </div>
        {dshProgress && (
          <div className="settings-progress">
            <LoaderCircle size={14} className="spin" />
            <span>{dshProgress.message}</span>
            <div className={`settings-progress-track ${dshProgress.indeterminate || dshProgress.percent === 0 ? 'indeterminate' : 'determinate'}`}>
              {!dshProgress.indeterminate && dshProgress.percent > 0 && <span style={{ width: `${dshProgress.percent}%` }} />}
            </div>
            {!dshProgress.indeterminate && dshProgress.percent > 0 && <strong>{dshProgress.percent}%</strong>}
          </div>
        )}
        <div className="settings-hint">点「下载」安装该版本并生成一个同名整合包；到整合包页切换即可使用，不会动当前环境。</div>
        {stable.length === 0 && prerelease.length === 0 && <div className="settings-empty">registry 里没有更多可下载的版本。</div>}
        <VersionGroup
          title="稳定版"
          candidates={stable}
          expanded={expandedGroup === 'stable'}
          onToggle={() => setExpandedGroup(value => value === 'stable' ? null : 'stable')}
          busy={busy || dshProgress !== null}
          installedVersions={installedVersions}
          onInstall={onInstall}
        />
        <VersionGroup
          title="预发布版"
          candidates={prerelease}
          expanded={expandedGroup === 'prerelease'}
          onToggle={() => setExpandedGroup(value => value === 'prerelease' ? null : 'prerelease')}
          busy={busy || dshProgress !== null}
          installedVersions={installedVersions}
          onInstall={onInstall}
        />
      </section>
    </div>
  )
}

/** 可下载版本分组：默认只露 5 条，组内可展开；已安装的保留在列表里标「已安装」，最新发行版标「最新版」。 */
function VersionGroup({
  title,
  candidates,
  expanded,
  onToggle,
  busy,
  installedVersions,
  onInstall,
}: {
  title: string
  candidates: RuntimeVersionCandidate[]
  expanded: boolean
  onToggle: () => void
  busy: boolean
  installedVersions: ReadonlySet<string>
  onInstall: (version: string) => Promise<boolean>
}) {
  if (candidates.length === 0) return null
  const shown = expanded ? candidates : candidates.slice(0, 5)
  return (
    <div className="settings-version-group">
      <div className="settings-version-group-head">
        <span className="settings-version-group-title">{title}<em>{candidates.length}</em></span>
        {candidates.length > 5 && (
          <button type="button" className="settings-nav-link" onClick={onToggle}>{expanded ? '收起' : `展开全部 ${candidates.length} 个`}</button>
        )}
      </div>
      <div className="settings-list">
        {shown.map(candidate => {
          const installed = installedVersions.has(candidate.version)
          return (
            <div key={candidate.version} className={`settings-row ${installed ? 'installed' : ''}`}>
              <div className="settings-row-copy">
                <strong>
                  {candidate.version}
                  {candidate.label === 'latest' && <span className="settings-row-badge latest">最新版</span>}
                </strong>
                <span>{[candidate.label === 'latest' ? null : candidate.label, candidate.date ? candidate.date.slice(0, 10) : null, candidate.prerelease ? '预发布' : null].filter(Boolean).join(' · ') || 'npm registry'}</span>
              </div>
              <div className="settings-row-actions">
                {installed
                  ? <span className="settings-row-badge"><Check size={12} />已安装</span>
                  : <button type="button" className="secondary-button" disabled={busy} onClick={() => { void onInstall(candidate.version) }}>
                    {busy ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}下载
                  </button>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SettingsPluginsTab({
  profile,
  busy,
  onTogglePlugin,
  onUninstallPlugin,
  onOpenPluginFolder,
  onProfileChanged,
  onRefresh,
  refreshLocked,
}: {
  profile: ProfileState
  busy: boolean
  onTogglePlugin: (plugin: ManagedPlugin, enabled: boolean) => Promise<boolean>
  onUninstallPlugin: (plugin: ManagedPlugin) => Promise<boolean>
  onOpenPluginFolder: (packageName: string) => void
  onProfileChanged: () => void
  onRefresh: () => void
  refreshLocked: boolean
}) {
  const store = useLauncherStore()
  const [subView, setSubView] = useState<'installed' | 'market'>('installed')
  return (
    <div className="settings-stack">
      <div className="settings-segmented" role="tablist" aria-label="插件视图">
        <button type="button" role="tab" aria-selected={subView === 'installed'} className={subView === 'installed' ? 'active' : ''} onClick={() => setSubView('installed')}>已安装</button>
        <button type="button" role="tab" aria-selected={subView === 'market'} className={subView === 'market' ? 'active' : ''} onClick={() => setSubView('market')}>DSH Market</button>
      </div>
      {/* 两个子视图都保持挂载，切换只切可见性：DSH Market 不再每次重建+重拉目录 */}
      <div className={subView === 'installed' ? undefined : 'view-hidden'}>
        <section className="settings-panel">
          <div className="settings-panel-heading">
            <div className="settings-panel-title"><Layers3 size={17} /><span>已安装插件</span>{profile.plugins.length > 0 && <span className="settings-count">{profile.plugins.length}</span>}</div>
            <PanelRefresh onClick={onRefresh} disabled={refreshLocked} />
          </div>
          <div className="settings-hint">开关决定插件在下次启动时是否加载；停用不会删除本体。</div>
          <div className="settings-list">
            {profile.plugins.map(plugin => (
              <ResourceRow
                key={plugin.packageName}
                title={plugin.displayName}
                subtitle={plugin.builtin ? 'DSH 核心组合层' : plugin.version}
                locked={plugin.locked}
                enabled={plugin.enabled}
                busy={busy}
                working={store.busy === plugin.packageName}
                onToggle={enabled => { void onTogglePlugin(plugin, enabled) }}
                onRemove={!plugin.locked ? () => { void onUninstallPlugin(plugin) } : undefined}
                onOpenFolder={plugin.builtin ? undefined : () => onOpenPluginFolder(plugin.packageName)}
              />
            ))}
            {profile.plugins.length === 0 && <div className="settings-empty">当前环境还没有插件；切到「DSH Market」点安装。</div>}
          </div>
        </section>
      </div>
      <div className={subView === 'market' ? undefined : 'view-hidden'}>
        <section className="settings-panel">
          <DshMarketView embedded onProfileChanged={onProfileChanged} />
        </section>
      </div>
    </div>
  )
}

function SettingsSkillsTab({
  installedSkills,
  busy,
  dshHome,
  onToggleSkill,
  onSkillInstalled,
  onRefresh,
  refreshLocked,
  onOpenPath,
}: {
  installedSkills: InstalledSkill[]
  busy: boolean
  dshHome: string
  onToggleSkill: (skill: InstalledSkill, enabled: boolean) => void
  onSkillInstalled: (result: SkillInstallResult) => void
  onRefresh: () => void
  refreshLocked: boolean
  onOpenPath: (targetPath: string) => void
}) {
  const store = useLauncherStore()
  const [subView, setSubView] = useState<'installed' | 'market'>('installed')
  return (
    <div className="settings-stack">
      <div className="settings-segmented" role="tablist" aria-label="技能视图">
        <button type="button" role="tab" aria-selected={subView === 'installed'} className={subView === 'installed' ? 'active' : ''} onClick={() => setSubView('installed')}>已安装</button>
        <button type="button" role="tab" aria-selected={subView === 'market'} className={subView === 'market' ? 'active' : ''} onClick={() => setSubView('market')}>技能市场</button>
      </div>
      <div className={subView === 'installed' ? undefined : 'view-hidden'}>
        <SettingsSection
          title="已安装技能"
          empty={installedSkills.length === 0}
          emptyText="还没有安装技能——切到「技能市场」点一下就能装。"
          onOpenFolder={() => onOpenPath(dshHome)}
          actions={<PanelRefresh onClick={onRefresh} disabled={refreshLocked} />}
        >
          {installedSkills.map(skill => (
            <ResourceRow
              key={skill.name}
              title={skill.name}
              subtitle={skill.description || skill.path}
              enabled={skill.enabled}
              busy={busy}
              working={store.busy === skill.name}
              onToggle={enabled => onToggleSkill(skill, enabled)}
              onOpenFolder={() => onOpenPath(skill.path)}
            />
          ))}
        </SettingsSection>
      </div>
      <div className={subView === 'market' ? undefined : 'view-hidden'}>
        <SkillMarketPanel
          installedSkills={installedSkills}
          busy={busy}
          onInstalled={onSkillInstalled}
          onRefresh={onRefresh}
          refreshLocked={refreshLocked}
        />
      </div>
    </div>
  )
}

function SettingsPresetsTab({
  installedPresets,
  busy,
  dshHome,
  onTogglePreset,
  onOpenPath,
  onRefresh,
  refreshLocked,
}: {
  installedPresets: InstalledPreset[]
  busy: boolean
  dshHome: string
  onTogglePreset: (preset: InstalledPreset, enabled: boolean) => void
  onOpenPath: (targetPath: string) => void
  onRefresh: () => void
  refreshLocked: boolean
}) {
  const api = useLauncherApi()
  const store = useLauncherStore()
  const [builtin, setBuiltin] = useState<BuiltinAgentPreset[] | null>(null)
  useEffect(() => {
    let alive = true
    void api.presetsBuiltin()
      .then(list => { if (alive) setBuiltin(list) })
      .catch(() => { if (alive) setBuiltin([]) })
    return () => { alive = false }
  }, [api])
  return (
    <div className="settings-stack">
      <section className="settings-panel">
        <div className="settings-panel-heading">
          <div className="settings-panel-title"><Wand2 size={17} /><span>内置预设</span>{builtin !== null && builtin.length > 0 && <span className="settings-count">{builtin.length}</span>}</div>
          <PanelRefresh onClick={onRefresh} disabled={refreshLocked} />
        </div>
        <div className="settings-hint">随 DSH 一起发布，在 DSH 界面里切换工作模式；启动器只读展示。</div>
        {builtin === null && <div className="settings-empty"><LoaderCircle size={18} className="spin" />正在读取内置预设…</div>}
        {builtin !== null && builtin.length === 0 && <div className="settings-empty">当前 DSH 版本没有发现内置预设。</div>}
        <div className="settings-list">
          {(builtin ?? []).map(preset => (
            <div key={preset.name} className="settings-row">
              <div className="settings-row-copy">
                <strong>{preset.displayName}</strong>
                <span>{preset.description || preset.name}</span>
              </div>
              <div className="settings-row-actions">
                <span className="settings-row-badge">内置</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <SettingsSection
        title="已安装预设"
        empty={installedPresets.length === 0}
        emptyText="本机还没有安装预设。"
        onOpenFolder={() => onOpenPath(`${dshHome}\.agent-presets`)}
      >
        {installedPresets.map(preset => (
          <ResourceRow
            key={preset.name}
            title={preset.name}
            subtitle={preset.enabled ? preset.path : `已停用（${preset.path}）`}
            enabled={preset.enabled}
            busy={busy}
            working={store.busy === preset.name}
            onToggle={enabled => onTogglePreset(preset, enabled)}
            onOpenFolder={() => onOpenPath(preset.path)}
          />
        ))}
      </SettingsSection>
    </div>
  )
}

interface SkillSourceState {
  status: 'loading' | 'ready' | 'failed'
  analysis: SkillRepositoryAnalysis | null
  error: string | null
}

/** 技能市场首屏最多渲染的卡片数：目录有数千条，全量渲染会让每次切页重排几千个 DOM（卡顿主因）。 */
const SKILL_MARKET_PAGE = 120

/** 单卡 memo：目录/筛选不变时，App 其它状态更新不重渲染这几千张卡。 */
const SkillMarketCard = memo(function SkillMarketCard({
  entry,
  busy,
  isBusy,
  onInstall,
  onToggle,
  onOpenRepo,
}: {
  entry: SkillMarketEntry
  busy: boolean
  isBusy: boolean
  onInstall: (entry: SkillMarketEntry) => void
  onToggle: (name: string, enabled: boolean) => void
  onOpenRepo: (url: string) => void
}) {
  const repositoryUrl = entry.target?.sourceRepository ?? entry.source.repository
  return (
    <article className="skill-market-card">
      <div className="skill-market-card-head">
        <div>
          <h2>{entry.name}</h2>
          {entry.displayName !== entry.name && <span>{entry.displayName}</span>}
        </div>
        {entry.installed
          ? <span className="settings-row-badge"><Check size={12} />已装</span>
          : entry.installs != null && <span className="skill-market-installs"><TrendingUp size={11} />{formatInstalls(entry.installs)}</span>}
      </div>
      <div className="skill-market-meta">
        <span>{entry.category}</span>
        {entry.origin === 'repo' && <span>{entry.format === 'bundle' ? '技能包' : '单文件'}</span>}
        <span>{entry.origin === 'index' ? entry.source.repository : entry.source.label}</span>
      </div>
      <p>{entry.displayDescription || '暂无描述'}</p>
      {/* 卡脚与 DSH Market 对齐：仓库链接在左，安装/开关在右 */}
      <div className="skill-market-card-foot">
        <button type="button" className="dsh-market-link" onClick={() => onOpenRepo(`https://github.com/${repositoryUrl}`)}><ExternalLink size={12} />仓库</button>
        <span className="dsh-market-grow" />
        {entry.installed ? (
          <label className="switch" title={entry.enabled ? '停用技能' : '启用技能'}>
            <input type="checkbox" checked={entry.enabled} disabled={busy} onChange={event => onToggle(entry.name, event.target.checked)} />
            <span />
          </label>
        ) : (
          <button type="button" className="primary-command" disabled={busy || isBusy} onClick={() => onInstall(entry)}>
            {isBusy ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}安装
          </button>
        )}
      </div>
    </article>
  )
})

function SkillMarketPanel({
  installedSkills,
  busy,
  onInstalled,
  onRefresh,
  refreshLocked,
}: {
  installedSkills: InstalledSkill[]
  busy: boolean
  onInstalled: (result: SkillInstallResult) => void
  onRefresh: () => void
  refreshLocked: boolean
}) {
  const api = useLauncherApi()
  const [catalog, setCatalog] = useState<{ status: 'loading' | 'ready' | 'failed'; skills: SkillsShSkill[]; error: string | null }>({ status: 'loading', skills: [], error: null })
  const [sources, setSources] = useState<Record<string, SkillSourceState>>({})
  const [query, setQuery] = useState('')
  const [sourceKind, setSourceKind] = useState<'all' | SkillMarketSourceKind>('all')
  const [category, setCategory] = useState<'all' | SkillCategory>('all')
  const [busyName, setBusyName] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [shown, setShown] = useState(SKILL_MARKET_PAGE)

  // 通用技能 = skills.sh 目录索引（主进程聚合+缓存）；DSH 社区 = 精选仓库归档分析。
  const loadCatalog = useCallback((refresh?: boolean) => {
    setCatalog(current => ({ status: 'loading', skills: current.skills, error: null }))
    api.skillMarketCatalog(refresh)
      .then(skills => setCatalog({ status: 'ready', skills, error: null }))
      .catch((cause: unknown) => {
        console.error('[skill-market] skills.sh catalog', cause)
        setCatalog(current => ({ status: 'failed', skills: current.skills, error: cause instanceof Error ? cause.message : 'skills.sh 目录读取失败' }))
      })
  }, [api])

  const loadSource = useCallback((source: SkillMarketSource) => {
    setSources(current => ({ ...current, [source.repository]: { status: 'loading', analysis: current[source.repository]?.analysis ?? null, error: null } }))
    api.skillMarketAnalyze(source.repository, source.defaultBranch)
      .then(analysis => setSources(current => ({ ...current, [source.repository]: { status: 'ready', analysis, error: null } })))
      .catch((cause: unknown) => {
        console.error(`[skill-market] ${source.repository}`, cause)
        setSources(current => ({ ...current, [source.repository]: { status: 'failed', analysis: current[source.repository]?.analysis ?? null, error: cause instanceof Error ? cause.message : '读取失败' } }))
      })
  }, [api])

  useEffect(() => {
    loadCatalog()
  }, [loadCatalog])

  useEffect(() => {
    SKILL_MARKET_SOURCES.forEach(loadSource)
  }, [loadSource])

  const analyses = useMemo(() => {
    const map: Record<string, SkillRepositoryAnalysis | null> = {}
    for (const source of SKILL_MARKET_SOURCES) map[source.repository] = sources[source.repository]?.analysis ?? null
    return map
  }, [sources])
  const entries = useMemo(() => [
    ...collectSkillsShEntries(catalog.skills, installedSkills),
    ...collectSkillMarketEntries(analyses, installedSkills),
  ], [catalog.skills, analyses, installedSkills])
  const visible = useMemo(() => filterSkillMarketEntries(entries, query, sourceKind, category), [entries, query, sourceKind, category])
  // 筛选条件变化时回到首屏页数，避免"加载更多"状态跨筛选残留。
  useEffect(() => {
    setShown(SKILL_MARKET_PAGE)
  }, [query, sourceKind, category])
  const loading = catalog.status === 'loading' || SKILL_MARKET_SOURCES.some(source => (sources[source.repository]?.status ?? 'loading') === 'loading')
  const allFailed = catalog.status === 'failed' && SKILL_MARKET_SOURCES.every(source => sources[source.repository]?.status === 'failed')

  const install = useCallback(async (entry: SkillMarketEntry) => {
    setBusyName(entry.name)
    setInstallError(null)
    try {
      const result = entry.origin === 'index'
        ? await api.skillMarketInstallByName({ sourceRepository: entry.source.repository, skillId: entry.name })
        : await api.skillMarketInstall({
          repository: entry.target?.sourceRepository ?? entry.source.repository,
          target: entry.target!,
        })
      onInstalled(result)
    } catch (cause) {
      console.error(`[skill-market] install ${entry.name}`, cause)
      setInstallError(`安装「${entry.name}」失败：${cause instanceof Error ? cause.message : '未知错误'}`)
    } finally {
      setBusyName(null)
    }
  }, [api, onInstalled])
  // 传给 memo 卡片的回调必须稳定，否则每次渲染都会击穿 memo。
  const handleInstall = useCallback((entry: SkillMarketEntry) => { void install(entry) }, [install])
  const handleToggle = useCallback((name: string, enabled: boolean) => {
    void api.toggleSkill(name, enabled).then(onRefresh)
  }, [api, onRefresh])
  const handleOpenRepo = useCallback((url: string) => { void api.openExternal(url) }, [api])

  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Store size={17} /><span>技能市场</span>{entries.length > 0 && <span className="settings-count">{entries.length}</span>}</div>
        <div className="settings-market-heading-actions">
          {/* 刷新 = 重刷本机资源 + 强制重拉 skills.sh 目录（绕过缓存） */}
          <PanelRefresh onClick={() => { onRefresh(); loadCatalog(true) }} disabled={refreshLocked} />
          <button type="button" className="settings-nav-link" onClick={() => void api.openExternal('https://skills.sh')} title="skills.sh 开放目录（浏览）"><ExternalLink size={13} />在 skills.sh 浏览更多</button>
        </div>
      </div>
      <div className="settings-market-toolbar">
        <label className="settings-market-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索技能名称或描述" /></label>
        <div className="settings-market-chips">
          {([['all', '全部'], ['general', '通用技能'], ['dsh', 'DSH 社区']] as const).map(([id, label]) => (
            <button key={id} type="button" className={sourceKind === id ? 'active' : ''} onClick={() => setSourceKind(id)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="settings-market-chips settings-market-categories">
        <button type="button" className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>全部分类</button>
        {SKILL_CATEGORIES.map(item => (
          <button key={item} type="button" className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>
        ))}
      </div>
      {catalog.status === 'loading' && <SkeletonStrip label="正在读取 skills.sh 目录（数千个技能，首次稍慢）…" />}
      {catalog.status === 'failed' && (
        <div className="settings-market-source failed">
          <span>skills.sh 目录：{catalog.error}</span>
          <button type="button" className="settings-nav-link" onClick={() => loadCatalog(true)}>重试</button>
        </div>
      )}
      {SKILL_MARKET_SOURCES.map(source => {
        const state = sources[source.repository]
        if (state?.status === 'ready') return null
        if (state?.status === 'failed') {
          return (
            <div key={source.repository} className="settings-market-source failed">
              <span>{source.label}：{state.error}</span>
              <button type="button" className="settings-nav-link" onClick={() => loadSource(source)}>重试</button>
            </div>
          )
        }
        return <SkeletonStrip key={source.repository} label={`正在读取 ${source.label}…`} />
      })}
      {allFailed && <div className="error-banner"><span>技能目录与社区仓库都读取失败。若你的网络需要代理才能访问外网，请在「开发者模式 → 网络」配置代理或 GitHub 镜像后重试。</span><button type="button" onClick={() => { loadCatalog(); SKILL_MARKET_SOURCES.forEach(loadSource) }}>全部重试</button></div>}
      {installError && <div className="error-banner"><span>{installError}</span><button type="button" onClick={() => setInstallError(null)}>忽略</button></div>}
      {!loading && !allFailed && visible.length === 0 && <div className="settings-empty"><Search size={20} />没有匹配的技能。</div>}
      <div className="skill-market-grid">
        {visible.slice(0, shown).map(entry => (
          <SkillMarketCard
            key={entry.key}
            entry={entry}
            busy={busy}
            isBusy={busyName === entry.name}
            onInstall={handleInstall}
            onToggle={handleToggle}
            onOpenRepo={handleOpenRepo}
          />
        ))}
      </div>
      {visible.length > shown && (
        <div className="skill-market-more">
          <button type="button" className="secondary-button" onClick={() => setShown(current => current + SKILL_MARKET_PAGE)}>
            加载更多（还有 {visible.length - shown} 个）
          </button>
        </div>
      )}
    </section>
  )
}

function SettingsSection({
  title,
  empty,
  emptyText,
  onOpenFolder,
  actions,
  children,
}: {
  title: string
  empty: boolean
  emptyText: string
  onOpenFolder: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><BookOpen size={17} /><span>{title}</span></div>
        <div className="settings-market-heading-actions">
          {actions}
          <button type="button" className="icon-button" onClick={onOpenFolder} title={`打开${title}文件夹`} aria-label={`打开${title}文件夹`}><FolderOpen size={16} /></button>
        </div>
      </div>
      {empty ? <div className="settings-empty">{emptyText}</div> : <div className="settings-list">{children}</div>}
    </section>
  )
}

function SettingsPacks({
  packs,
  activePack,
  busy,
  dshInstalledVersions,
  onRefresh,
  onImport,
  onCreateBlank,
  onActivate,
  onRename,
  onExport,
  onRemove,
  onDiskUsage,
  onNavigateTab,
}: {
  packs: PackStatus[]
  activePack: PackStatus | null
  busy: boolean
  dshInstalledVersions: string[]
  onRefresh: () => void
  onImport: () => void
  onCreateBlank: (name: string, dshVersion: string | null) => Promise<boolean>
  onActivate: (packId: string) => void
  onRename: (packId: string, name: string) => Promise<boolean>
  onExport: (packId: string) => void
  onRemove: (packId: string) => Promise<boolean>
  onDiskUsage: (packId: string) => Promise<number>
  onNavigateTab: (tab: HomeTab) => void
}) {
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newVersion, setNewVersion] = useState<string>('')
  const [removing, setRemoving] = useState<string | null>(null)
  const createNameInputRef = useRef<HTMLInputElement>(null)

  const openCreateForm = () => {
    setCreating(true)
    setNewName('')
    setNewVersion(dshInstalledVersions.at(-1) ?? '')
    // 表单一打开就把焦点放进来，省得用户先点一下；同时把光标定到尾部（如果未来想加默认值）。
    requestAnimationFrame(() => createNameInputRef.current?.focus())
  }

  const confirmRemove = async (pack: PackStatus) => {
    const bytes = await onDiskUsage(pack.id).catch(() => 0)
    const size = bytes > 0 ? `（占用 ${formatBytes(bytes)}）` : ''
    const activeNote = activePack?.id === pack.id
      ? (packs.length === 1
        ? '\n这是最后一个整合包：删除后启动器会引导你重新创建。'
        : '\n这是当前激活的整合包：删除后会自动切换到其它环境。')
      : ''
    if (!window.confirm(`确定删除整合包「${pack.name}」${size}吗？\n它的插件、技能、预设、配置与会话会一并删除，不可恢复；共享的 DSH 版本保留。${activeNote}`)) return
    setRemoving(pack.id)
    try {
      await onRemove(pack.id)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Package size={17} /><span>整合包</span>{packs.length > 0 && <span className="settings-count">{packs.length}</span>}</div>
        <div className="settings-market-heading-actions">
          <PanelRefresh onClick={onRefresh} disabled={busy} />
          <button type="button" className="secondary-button" onClick={() => { creating ? setCreating(false) : openCreateForm() }} disabled={busy}>新建整合包</button>
          <button type="button" className="primary-command" onClick={onImport} disabled={busy}><Download size={15} />导入整合包</button>
        </div>
      </div>
      <div className="settings-hint">每个整合包是一套真隔离环境（DSH 版本 + 插件 + 技能 + 预设 + 配置 + 会话），互不串扰；整合包只由新建或导入产生，缺少的 DSH 版本会自动下载。</div>
      {creating && (
        <div className="settings-pack-create">
          <input
            ref={createNameInputRef}
            className="settings-pack-name-input"
            placeholder="整合包名称（字母/数字/-_）"
            value={newName}
            autoFocus
            onChange={event => setNewName(event.target.value)}
          />
          <select className="settings-pack-version-select" value={newVersion} onChange={event => setNewVersion(event.target.value)}>
            {dshInstalledVersions.length === 0
              ? <option value="" disabled>暂无已安装版本</option>
              : dshInstalledVersions.map(version => <option key={version} value={version}>DSH {version}</option>)}
          </select>
          <button
            type="button"
            className="primary-command"
            disabled={busy || newName.trim() === '' || newVersion === ''}
            onClick={() => { void onCreateBlank(newName.trim(), newVersion || null).then(ok => { if (ok) setCreating(false) }) }}
          >创建</button>
          <button type="button" className="secondary-button" onClick={() => setCreating(false)}>取消</button>
        </div>
      )}
      {creating && dshInstalledVersions.length === 0 && (
        <div className="settings-pack-create-hint">
          <span>还没有已安装的 DSH 版本，先去下载一个，再创建整合包。</span>
          <button type="button" className="secondary-button" onClick={() => onNavigateTab('versions')}>去下载版本</button>
        </div>
      )}
      {packs.length === 0 && !creating && (
        <div className="packs-onboarding">
          <div className="packs-onboarding-icon"><Package size={26} /></div>
          <h3>还没有任何整合包</h3>
          <p>三步搭好你的第一套环境：</p>
          <ol className="packs-onboarding-steps">
            <li>
              <span className="packs-onboarding-step-no">1</span>
              <span className="packs-onboarding-step-text">下载 DSH 版本{dshInstalledVersions.length > 0 ? `（已有 ${dshInstalledVersions.length} 个）` : ''}</span>
              <button type="button" className="secondary-button" onClick={() => onNavigateTab('versions')}>去下载 →</button>
            </li>
            <li>
              <span className="packs-onboarding-step-no">2</span>
              <span className="packs-onboarding-step-text">新建一个整合包并选择这个版本（没有激活包时会自动启用）</span>
              <button type="button" className="primary-command" onClick={openCreateForm} disabled={busy}>新建整合包</button>
            </li>
            <li>
              <span className="packs-onboarding-step-no">3</span>
              <span className="packs-onboarding-step-text">到插件 / 技能页安装扩展</span>
              <span className="packs-onboarding-step-links">
                <button type="button" className="secondary-button" onClick={() => onNavigateTab('plugins')}>插件</button>
                <button type="button" className="secondary-button" onClick={() => onNavigateTab('skills')}>技能</button>
              </span>
            </li>
          </ol>
          <p className="packs-onboarding-foot">也可以导入他人分享的 .zip 整合包，缺少的版本会自动下载。</p>
        </div>
      )}
      {activePack && !activePack.dshVersion && packs.length > 0 && (
        <div className="settings-pack-create-hint">
          <span>当前整合包「{activePack.name}」还没有绑定 DSH 版本，启动前请先下载一个版本。</span>
          <button type="button" className="secondary-button" onClick={() => onNavigateTab('versions')}>去下载版本</button>
        </div>
      )}
      <div className="settings-list">
        {packs.map(pack => {
          const isActive = activePack?.id === pack.id
          const counts = [
            `${pack.plugins.length} 插件`,
            ...(pack.skills?.length ? [`${pack.skills.length} 技能`] : []),
            ...(pack.presets?.length ? [`${pack.presets.length} 预设`] : []),
            ...(pack.applications?.length ? [`${pack.applications.length} 应用`] : []),
          ].join(' · ')
          return (
            <div key={pack.id} className={`settings-pack-row ${isActive ? 'active' : ''}`}>
              <div className="settings-pack-copy">
                {renaming?.id === pack.id ? (
                  <span className="settings-pack-rename">
                    <input
                      className="settings-pack-name-input"
                      value={renaming.value}
                      autoFocus
                      onChange={event => setRenaming({ id: pack.id, value: event.target.value })}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && renaming.value.trim()) void onRename(pack.id, renaming.value.trim()).then(ok => { if (ok) setRenaming(null) })
                        if (event.key === 'Escape') setRenaming(null)
                      }}
                    />
                    <button type="button" className="secondary-button" disabled={busy || !renaming.value.trim()} onClick={() => void onRename(pack.id, renaming.value.trim()).then(ok => { if (ok) setRenaming(null) })}>保存</button>
                    <button type="button" className="icon-button" onClick={() => setRenaming(null)} title="取消重命名" aria-label="取消重命名"><X size={14} /></button>
                  </span>
                ) : (
                  <span className="settings-pack-title-line">
                    <strong>{pack.name}</strong>
                    <span className="settings-pack-badge">v{pack.version}</span>
                    <button type="button" className="icon-button settings-pack-edit" onClick={() => setRenaming({ id: pack.id, value: pack.name })} title="重命名" aria-label="重命名"><Pencil size={13} /></button>
                  </span>
                )}
                <span>
                  {pack.dshVersion ? `DSH ${pack.dshVersion}` : 'DSH 未绑定'}
                  {counts ? ` · ${counts}` : ' · 空白环境'}
                  {pack.state !== 'complete' ? ' · 未完成安装' : ''}
                </span>
              </div>
              <div className="settings-pack-actions">
                {removing === pack.id ? (
                  <span className="settings-pack-removing">
                    <LoaderCircle size={13} className="spin" />删除中
                    <span className="settings-progress-track indeterminate" aria-hidden="true" />
                  </span>
                ) : (
                  <>
                    {isActive
                      ? <span className="settings-pack-active"><Check size={13} />当前使用</span>
                      : pack.state === 'complete'
                        ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onActivate(pack.id)}>切换</button>
                        : pack.state === 'partial'
                          ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onActivate(pack.id)} title="重新进入该包环境">继续</button>
                          : <span className="settings-pack-state">未完成安装</span>}
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => onExport(pack.id)} title="导出为压缩包（不含会话与登录）">导出</button>
                    <button type="button" className="icon-button" disabled={busy} onClick={() => { void confirmRemove(pack) }} title="删除整合包（连同环境数据）" aria-label="删除整合包"><Trash2 size={15} /></button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ResourceRow({
  title,
  subtitle,
  enabled,
  selected = false,
  locked = false,
  busy,
  working = false,
  onToggle,
  onSelect,
  onRemove,
  onOpenFolder,
}: {
  title: string
  subtitle?: string
  enabled: boolean
  /** 版本行：勾选态显示「当前」，不参与开关语义。 */
  selected?: boolean
  locked?: boolean
  busy: boolean
  /** 该行自身有一个动作在执行（如卸载中）：行尾转圈，替换开关/删除按钮。 */
  working?: boolean
  onToggle?: (enabled: boolean) => void
  onSelect?: () => void
  onRemove?: () => void
  onOpenFolder?: () => void
}) {
  return (
    <div className={`settings-row ${enabled && !selected ? 'enabled' : ''}${working ? ' is-working' : ''}`}>
      <div className="settings-row-copy">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="settings-row-actions">
        {selected && <span className="settings-row-badge"><Check size={12} />当前</span>}
        {working ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <>
            {onToggle && (
              <label className="switch" title={enabled ? '停用' : '启用'}>
                <input type="checkbox" checked={enabled} disabled={busy} onChange={event => onToggle(event.target.checked)} />
                <span />
              </label>
            )}
            {!onToggle && onSelect && !selected && (
              <button type="button" className="secondary-button" disabled={busy || locked} onClick={onSelect}>使用</button>
            )}
            {onRemove && (
              <button type="button" className="icon-button" disabled={busy} onClick={onRemove} title="删除" aria-label={`删除 ${title}`}><Trash2 size={14} /></button>
            )}
          </>
        )}
        {onOpenFolder && (
          <button type="button" className="icon-button" onClick={onOpenFolder} title="打开文件夹" aria-label={`打开 ${title} 文件夹`}><FolderOpen size={15} /></button>
        )}
      </div>
    </div>
  )
}