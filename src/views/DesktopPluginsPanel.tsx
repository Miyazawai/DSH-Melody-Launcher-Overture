import { Check, ExternalLink, LoaderCircle, PackagePlus, Puzzle, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { PluginAddDialog } from '../components/dialogs/PluginAddDialog'
import { errorText } from '../lib/format'
import type { DesktopPluginState, LauncherApi } from '../types'

/**
 * 官方桌面端的插件面板。
 *
 * 与「已安装 / DSH Market」两个分段的根本区别：这里操作的不是我们托管的整合包，而是桌面端
 * 自己独占的那个环境。所以行上没有启用/停用开关——它的 `dsh plugin` 只转发 pnpm 的
 * add/remove/why，启停归它自己的插件管理页与 `.plugin-manager` 状态目录管，我们手改
 * bundles 只会让两边对不上。这件事写在界面上，而不是等用户找了才发现没有。
 */

async function refreshStatus(api: LauncherApi, apply: (next: DesktopPluginState) => void, fail: (message: string) => void): Promise<void> {
  try {
    apply(await api.desktopStatus())
  } catch (cause) {
    fail(errorText(cause))
  }
}

function useDesktopStatus() {
  const api = useLauncherApi()
  const [state, setState] = useState<DesktopPluginState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    await refreshStatus(api, setState, message => {
      setError(message)
      setState(null)
    })
    setLoading(false)
  }, [api])

  useEffect(() => { void reload() }, [reload])
  return { state, error, setError, loading, reload }
}

export function DesktopPluginsPanel() {
  const api = useLauncherApi()
  const { state, error, setError, loading, reload } = useDesktopStatus()
  const [busy, setBusy] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await action()
      await reload()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(null)
    }
  }

  if (loading && state === null) return <div className="settings-hint">正在检测官方桌面端…</div>
  if (state === null || !state.installed) {
    return <div className="settings-empty"><Puzzle size={20} />{error ?? '没有检测到官方桌面端。装好之后再回来这里，它的环境会自己出现在列表里。'}</div>
  }

  const plugins = state.plugins ?? []
  const mirrorApplied = state.registry !== null && state.registry === state.mirrorRegistry
  return (
    <>
      <div className="settings-panel-heading">
        <div className="settings-panel-title">
          <Puzzle size={17} /><span>官方桌面端</span>
          {state.version && <span className="settings-count">{state.version}</span>}
          {state.running && <span className="settings-row-badge"><Check size={12} />运行中</span>}
        </div>
        <div className="settings-market-heading-actions">
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void act('open', () => api.desktopOpen())}><ExternalLink size={14} />打开桌面端</button>
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void reload()}><RefreshCw size={14} className={loading ? 'spin' : undefined} />重新检测</button>
        </div>
      </div>
      <div className="settings-hint">
        这是 DeepSeek 官方桌面端自己的环境，不归启动器托管：启动器只能读它的插件清单，并通过它自带的命令装卸插件。
        <strong>启用与停用请回到桌面端自己的插件管理页</strong>——它那条命令只支持安装与卸载，我们替它改开关会和它内部状态对不上。
      </div>
      {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError(null)}>忽略</button></div>}

      <div className="desktop-mirror-row">
        <div className="desktop-mirror-copy">
          <strong>让桌面端走国内镜像</strong>
          <span>
            {state.registry
              ? <>当前 registry：<code>{state.registry}</code></>
              : <>当前未配置，走它自己的默认源{state.running ? '（桌面端正在运行，改完要重启才生效）' : ''}</>}
          </span>
        </div>
        {state.registry !== null && (
          <button type="button" className="secondary-button" disabled={busy !== null || mirrorApplied} onClick={() => void act('mirror', () => api.desktopApplyMirror())}>
            {busy === 'mirror' ? <LoaderCircle size={14} className="spin" /> : null}改为 {state.mirrorRegistry}
          </button>
        )}
        {state.registry !== null && (
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void act('mirror-restore', () => api.desktopRestoreMirror())}>
            {busy === 'mirror-restore' ? <LoaderCircle size={14} className="spin" /> : null}恢复原样
          </button>
        )}
        {state.registry === null && (
          <button type="button" className="primary-command" disabled={busy !== null} onClick={() => void act('mirror', () => api.desktopApplyMirror())}>
            {busy === 'mirror' ? <LoaderCircle size={14} className="spin" /> : null}设为 {state.mirrorRegistry}
          </button>
        )}
      </div>
      <div className="settings-hint">只改它自己 profile 的 <code>registry</code> 一个键；第一次改动前会备份原配置，随时可以恢复。不会把它的依赖池指到启动器目录。</div>

      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Puzzle size={17} /><span>它装的插件</span>{plugins.length > 0 && <span className="settings-count">{plugins.length}</span>}</div>
        <div className="settings-market-heading-actions">
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setAddOpen(true)}><PackagePlus size={14} />手动添加</button>
        </div>
      </div>
      {plugins.length === 0
        ? <div className="settings-empty"><Puzzle size={20} />桌面端目前只有它自带的核心组件，没装任何外部插件。</div>
        : (
          <div className="settings-list">
            {plugins.map(plugin => {
              const working = busy === `uninstall:${plugin.packageName}`
              return (
                <div key={plugin.packageName} className={`settings-row ${working ? 'is-working' : ''}`}>
                  <div className="settings-row-copy">
                    <strong>{plugin.displayName}</strong>
                    <span>{plugin.version}{plugin.description ? ` · ${plugin.description}` : ''}</span>
                  </div>
                  <div className="settings-row-actions">
                    {working
                      ? <LoaderCircle size={15} className="spin" />
                      : <button type="button" className="icon-button" title={`卸载 ${plugin.displayName}`} aria-label={`卸载 ${plugin.displayName}`} disabled={busy !== null} onClick={() => void act(`uninstall:${plugin.packageName}`, () => api.desktopUninstall(plugin.packageName))}><Trash2 size={16} /></button>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      {addOpen && (
        <PluginAddDialog
          profileName="官方桌面端"
          desktop
          onClose={() => setAddOpen(false)}
          onInstalled={() => reload()}
        />
      )}
    </>
  )
}

/**
 * 整合包列表里的那一行：自己拉状态、没装就整个不渲染，所以它不需要从上层接任何数据。
 * 「管理插件」只跳到插件页——为了「顺手选中某个分段」再把状态穿三层，不值。
 */
export function DesktopPackRow({ onManagePlugins }: { onManagePlugins: () => void }) {
  const { state } = useDesktopStatus()
  if (!state?.installed) return null
  const count = state.plugins?.length ?? 0
  return (
    <div className="settings-row settings-desktop-row">
      <div className="settings-row-copy">
        <strong>官方桌面端</strong>
        <span>
          {state.version ? `DSH Desktop ${state.version}` : 'DSH Desktop'}
          {' · '}
          {count > 0 ? `已装 ${count} 个插件` : '没有外部插件'}
          {state.running ? ' · 正在运行' : ''}
        </span>
      </div>
      <div className="settings-row-actions">
        <span className="settings-row-badge"><Check size={12} />官方</span>
        <button type="button" className="secondary-button" onClick={onManagePlugins}>管理插件</button>
      </div>
    </div>
  )
}
