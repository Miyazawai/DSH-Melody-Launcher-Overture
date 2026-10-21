import { Check, Folder, Gamepad2, Globe, ImagePlus, Info, LoaderCircle, Palette, Rocket, RotateCcw, Wrench, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import packageMetadata from '../../../package.json'
import { useLauncherApi } from '../../api/client'
import { GITHUB_MIRROR_PRESETS } from '../../constants'
import { ACCENT_PRESETS, DEFAULT_THEME_ACCENT, appearanceImageUrl, clampBackgroundOpacity, clampPanelOpacity } from '../../lib/appearance'
import type { AppSettings, AppearanceSettings, UiTheme } from '../../types'

/**
 * 启动器设置：按 C 端实际需要分组——外观 / 启动 / 网络 / 官方推荐 / 关于；
 * 启动命令、端口、Copilot 提示词等开发者向字段收进默认折叠的「高级设置」。
 */

interface SettingsDialogProps {
  settings: AppSettings
  busy: boolean
  onClose: () => void
  onSave: (settings: AppSettings) => void
  /** 实时预览：把草稿里的 appearance 交给根组件应用；null = 回落到已保存设置。 */
  onPreview: (appearance: AppearanceSettings | null) => void
}

const UI_THEMES: Array<{ id: UiTheme; label: string }> = [
  { id: 'deepseek', label: '日间' },
  { id: 'night', label: '夜间' },
]

/** 下拉里代表「手填地址」的哨兵值，不会真的存进设置。 */
const CUSTOM_MIRROR = '__custom__'
/** 比较镜像地址时忽略首尾空格与结尾斜杠（手敲的常常少一个 `/`）。 */
const normalizeMirror = (value: string): string => value.trim().replace(/\/+$/, '')

function SettingsGroup({ icon, title, desc, children }: { icon: ReactNode; title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <header><span className="settings-group-icon">{icon}</span><h3>{title}</h3>{desc && <p>{desc}</p>}</header>
      {children}
    </section>
  )
}

export function SettingsDialog({ settings, busy, onClose, onSave, onPreview }: SettingsDialogProps) {
  const api = useLauncherApi()
  const [draft, setDraft] = useState(settings)
  // 参数在界面上是一整行文本，保存时才切成数组。
  const [argsText, setArgsText] = useState(settings.launchArgs.join(' '))
  // 镜像下拉的当前档位：空 = 自动、预设前缀之一、或「自定义」。
  const mirrorValue = draft.network?.githubMirror ?? ''
  const matchedPreset = GITHUB_MIRROR_PRESETS.find(prefix => normalizeMirror(prefix) === normalizeMirror(mirrorValue) && mirrorValue.trim() !== '')
  const mirrorPreset = mirrorValue.trim() === '' ? '' : (matchedPreset ?? CUSTOM_MIRROR)

  const chooseDirectory = async (kind: 'dshInstallPath' | 'dshHome' | 'workspace') => {
    const chosen = await api.chooseDirectory(kind)
    if (chosen) setDraft(current => ({ ...current, [kind]: chosen }))
  }

  // 外观草稿：每次改动都同步给根组件做实时预览；保存前不落盘。
  const appearance: AppearanceSettings = draft.appearance ?? {}
  const theme = draft.uiTheme ?? 'deepseek'
  const previewAppearance = (next: AppSettings) => {
    setDraft(next)
    onPreview(next.appearance ?? null)
  }
  const updateAppearance = (patch: Partial<AppearanceSettings>) => {
    const merged = { ...appearance, ...patch }
    const cleaned = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    ) as AppearanceSettings
    previewAppearance({ ...draft, appearance: Object.keys(cleaned).length > 0 ? cleaned : undefined })
  }
  const resetAppearance = () => previewAppearance({ ...draft, appearance: undefined })
  const chooseAppearanceImage = async (kind: 'background' | 'logo') => {
    const picked = await api.chooseAppearanceImage(kind)
    if (!picked) return
    updateAppearance(kind === 'background' ? { backgroundPath: picked.path } : { logoPath: picked.path })
  }
  const fileLabel = (target: string | undefined): string => (target ? target.split(/[\\/]/).pop() ?? target : '')

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><Gamepad2 size={19} /><h2 id="settings-title">启动器设置</h2></div><button type="button" className="icon-button settings-close-button" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onClose() }} aria-label="关闭设置"><X size={18} /></button></header>
        <div className="modal-content settings-groups">
          <SettingsGroup icon={<Palette size={16} />} title="外观" desc="界面主题、主题色与外观；保存后立即生效。">
            <div className="theme-options" role="radiogroup" aria-label="界面主题">
              {UI_THEMES.map(option => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.id}
                  className={`theme-option ${theme === option.id ? 'selected' : ''}`}
                  onClick={() => setDraft({ ...draft, uiTheme: option.id })}
                >
                  <span className={`theme-swatch ${option.id}`} aria-hidden="true"><i /><i /><i /></span>
                  <span>{option.label}</span>
                  {theme === option.id && <Check size={14} />}
                </button>
              ))}
            </div>

            <div className="appearance-field">
              <span className="appearance-label">主题色</span>
              <div className="appearance-swatches" role="radiogroup" aria-label="主题色">
                {ACCENT_PRESETS.map(preset => {
                  const selected = (appearance.accent ?? null) === preset.color
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`appearance-swatch ${preset.color ? '' : 'auto'} ${selected ? 'selected' : ''}`}
                      style={preset.color ? { background: preset.color } : undefined}
                      title={preset.label}
                      onClick={() => updateAppearance({ accent: preset.color ?? undefined })}
                    >
                      {preset.color === null && <span>自动</span>}
                    </button>
                  )
                })}
                <label className="appearance-custom-color" title="自定义主题色">
                  <input
                    type="color"
                    value={appearance.accent ?? DEFAULT_THEME_ACCENT[theme]}
                    onChange={event => updateAppearance({ accent: event.target.value })}
                  />
                  <span>自定义</span>
                </label>
              </div>
            </div>

            <label className="appearance-slider-row">
              <span>面板透明度</span>
              <input
                type="range"
                min={20}
                max={100}
                step={1}
                value={Math.round(clampPanelOpacity(appearance.panelOpacity ?? 1) * 100)}
                onChange={event => updateAppearance({ panelOpacity: Number(event.currentTarget.value) / 100 })}
              />
              <em>{Math.round(clampPanelOpacity(appearance.panelOpacity ?? 1) * 100)}%</em>
            </label>

            <div className="appearance-image-row">
              <span>背景图片</span>
              <div className="appearance-image-actions">
                <button type="button" className="secondary-button" onClick={() => void chooseAppearanceImage('background')}>
                  <ImagePlus size={14} />选择图片…
                </button>
                {appearance.backgroundPath && (
                  <button type="button" className="secondary-button" onClick={() => updateAppearance({ backgroundPath: undefined, backgroundOpacity: undefined })}>清除</button>
                )}
                <small title={appearance.backgroundPath ?? ''}>{appearance.backgroundPath ? fileLabel(appearance.backgroundPath) || '已选择' : '跟随主题色渐变'}</small>
              </div>
            </div>

            {appearance.backgroundPath && (
              <label className="appearance-slider-row">
                <span>背景透明度</span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={Math.round(clampBackgroundOpacity(appearance.backgroundOpacity ?? 1) * 100)}
                  onChange={event => updateAppearance({ backgroundOpacity: Number(event.currentTarget.value) / 100 })}
                />
                <em>{Math.round(clampBackgroundOpacity(appearance.backgroundOpacity ?? 1) * 100)}%</em>
              </label>
            )}

            <div className="appearance-image-row">
              <span>启动器头像</span>
              <div className="appearance-image-actions">
                <img
                  className="appearance-logo-preview"
                  src={appearanceImageUrl(appearance.logoPath) ?? `${import.meta.env.BASE_URL}launcher-logo.png`}
                  alt=""
                />
                <button type="button" className="secondary-button" onClick={() => void chooseAppearanceImage('logo')}>
                  <ImagePlus size={14} />选择图片…
                </button>
                {appearance.logoPath && (
                  <button type="button" className="secondary-button" onClick={() => updateAppearance({ logoPath: undefined })}>清除</button>
                )}
                <small>仅替换首页头像</small>
              </div>
            </div>

            <div className="appearance-actions">
              <button type="button" className="secondary-button" onClick={resetAppearance}>
                <RotateCcw size={14} />恢复外观默认
              </button>
            </div>
          </SettingsGroup>
          <SettingsGroup icon={<Rocket size={16} />} title="启动" desc="DSH 本体目录存放程序与依赖；DSH_HOME 存放整合包、配置、插件和 Skills。">
            <label className="form-field"><span>本体安装目录</span><div className="path-input"><input value={draft.dshInstallPath} onChange={event => setDraft({ ...draft, dshInstallPath: event.target.value })} /><button type="button" onClick={() => void chooseDirectory('dshInstallPath')} title="选择 DSH 本体安装目录"><Folder size={17} /></button></div></label>
            <label className="form-field"><span>DSH_HOME</span><div className="path-input"><input value={draft.dshHome} onChange={event => setDraft({ ...draft, dshHome: event.target.value })} /><button type="button" onClick={() => void chooseDirectory('dshHome')} title="选择 DSH_HOME"><Folder size={17} /></button></div></label>
            <label className="check-field"><input type="checkbox" checked={draft.openAfterLaunch} onChange={event => setDraft({ ...draft, openAfterLaunch: event.target.checked })} /><span><strong>启动后打开 Harness</strong><small>识别到本地 Web 地址时，在默认浏览器中打开。</small></span></label>
          </SettingsGroup>
          <SettingsGroup icon={<Globe size={16} />} title="网络" desc="默认使用国内 npm 镜像（npmmirror），并自动跟随 Windows 系统代理；留空即可。">
            <label className="form-field"><span>npm 镜像</span><input value={draft.network?.npmRegistry ?? ''} placeholder="https://registry.npmmirror.com" onChange={event => setDraft({ ...draft, network: { ...draft.network, npmRegistry: event.target.value } })} /></label>
            <label className="form-field"><span>代理地址</span><input value={draft.network?.proxy ?? ''} placeholder="留空自动探测系统代理；如 http://127.0.0.1:7890" onChange={event => setDraft({ ...draft, network: { ...draft.network, proxy: event.target.value } })} /></label>
            {/* 镜像从「裸文本框」改成预设下拉：国内用户最容易卡在这一格，选一个比手敲 URL 现实。 */}
            <label className="form-field">
              <span>GitHub 镜像</span>
              <select value={mirrorPreset} onChange={event => {
                const value = event.target.value
                setDraft({ ...draft, network: { ...draft.network, githubMirror: value === CUSTOM_MIRROR ? (draft.network?.githubMirror ?? '') : value } })
              }}>
                <option value="">自动（直连太慢或断流时自动换公共镜像）</option>
                {GITHUB_MIRROR_PRESETS.map(prefix => <option key={prefix} value={prefix}>{prefix.replace(/^https?:\/\//, '').replace(/\/$/, '')}</option>)}
                <option value={CUSTOM_MIRROR}>自定义…</option>
              </select>
            </label>
            {mirrorPreset === CUSTOM_MIRROR && (
              <label className="form-field"><span>自定义镜像</span><input value={draft.network?.githubMirror ?? ''} placeholder="如 https://gh-proxy.com" onChange={event => setDraft({ ...draft, network: { ...draft.network, githubMirror: event.target.value } })} /></label>
            )}
            <p className="settings-group-note">下载整合包 / 插件 / DSH 时优先走这里的镜像；选「自动」则先试直连，8 秒无响应或速度低于 300KB/s 就自动切到公共镜像（整合包页会显示当前用的是哪一个）。</p>
          </SettingsGroup>
          <SettingsGroup icon={<Info size={16} />} title="关于">
            <div className="settings-about-rows">
              <div><span>启动器版本</span><strong>v{packageMetadata.version}</strong></div>
            </div>
          </SettingsGroup>
          <details className="settings-group settings-advanced">
            <summary><span className="settings-group-icon"><Wrench size={16} /></span>高级设置<small>启动命令、端口、Copilot 提示词——一般不需要改动</small></summary>
            <label className="form-field"><span>可执行文件</span><input value={draft.launchExecutable} onChange={event => setDraft({ ...draft, launchExecutable: event.target.value })} /></label>
            <label className="form-field"><span>参数</span><input value={argsText} onChange={event => setArgsText(event.target.value)} /></label>
            <label className="form-field"><span>首选 Web 端口</span><input type="number" min={1} max={65535} step={1} value={draft.webPort} onChange={event => setDraft({ ...draft, webPort: Number(event.target.value) })} /></label>
            <label className="form-field"><span>工作目录</span><div className="path-input"><input value={draft.workspace} onChange={event => setDraft({ ...draft, workspace: event.target.value })} /><button type="button" onClick={() => void chooseDirectory('workspace')} title="选择工作目录"><Folder size={17} /></button></div></label>
            <p className="settings-advanced-note">DSH Copilot：默认模式会把自定义内容追加到内置提示词；开发者模式可替换基础提示词，但凭据保护、工作区边界和操作审批始终有效。</p>
            <label className="check-field"><input type="checkbox" checked={Boolean(draft.aiDeveloperMode)} onChange={event => setDraft({ ...draft, aiDeveloperMode: event.target.checked })} /><span><strong>开发者模式</strong><small>允许使用下面的内容替换 Copilot 基础 persona。</small></span></label>
            <label className="form-field copilot-prompt-field"><span>AI 分析提示词</span><textarea rows={7} value={draft.aiPrompt ?? ''} placeholder="留空使用内置 DSH Copilot 提示词。" onChange={event => setDraft({ ...draft, aiPrompt: event.target.value })} /><small>{draft.aiDeveloperMode ? '当前：替换基础 persona；固定安全规则仍会自动追加。' : '当前：作为附加开发指引追加到内置提示词。'}</small></label>
            <div className="settings-inline-actions"><button type="button" className="secondary-button" onClick={() => setDraft({ ...draft, aiPrompt: '' })}>恢复默认提示词</button></div>
          </details>
        </div>
        <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-command" disabled={busy} onClick={() => onSave({ ...draft, launchArgs: argsText.trim().split(/\s+/).filter(Boolean) })}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}保存设置</button></footer>
      </section>
    </div>
  )
}
