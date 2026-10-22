import type { AppearanceImageKind, AppearanceSettings, UiTheme } from '../types'

/**
 * 外观派生的纯函数层：设置 → CSS 变量 map。
 * 不碰 DOM，供渲染层应用变量、设置面板做实时预览，也便于直接单测。
 * 公式与 prototype/index.html 的 apply() 一致；差异只有一处已在下方注明。
 */

/** 各主题的默认强调色；未自定义 accent 时用它推导「跟随主题色」的背景渐变。 */
export const DEFAULT_THEME_ACCENT: Record<UiTheme, string> = {
  deepseek: '#2b7cd8',
  night: '#4d9fea',
}

export const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/

/** 设置面板的预设色卡；color = null 表示「跟随主题」。 */
export const ACCENT_PRESETS: ReadonlyArray<{ label: string; color: string | null }> = [
  { label: '跟随主题', color: null },
  { label: '经典蓝', color: '#2b7cd8' },
  { label: '紫罗兰', color: '#7c5cff' },
  { label: '青碧', color: '#12a594' },
  { label: '琥珀', color: '#d97706' },
  { label: '玫红', color: '#e11d48' },
  { label: '草绿', color: '#65a30d' },
  { label: '石墨', color: '#475569' },
]

export const APPEARANCE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])

/**
 * 图片落在 userData/appearance/ 下的固定文件名：换图即换内容，路径不变。
 * 因此渲染层拼 URL 时必须带 appearanceVersion（见 appearanceImageUrl），
 * 否则同一路径的 URL 不变，React 与浏览器都会继续显示旧图。
 */
export function appearanceAssetName(kind: AppearanceImageKind, extension: string): string {
  return `${kind}.${extension.replace(/^\./, '').toLowerCase()}`
}

const APPEARANCE_ASSET_PATTERN = /^(?:background|logo)\.(?:png|jpe?g|webp)$/i

/**
 * 渲染层把「设置里存的绝对路径」换成可加载的 URL。
 * 正常文件走自定义协议 dsh-appearance://（main 里注册，只允许 userData/appearance 下的两张图）；
 * demoApi / 测试可以塞 data: URL，原样返回。
 *
 * version 是图片内容版本：复制件文件名固定，换图后路径与 URL 都不变，
 * 渲染层（React 属性 diff / 浏览器图片缓存）会继续显示旧图。带上 ?v= 后
 * 每次换图都是新 URL，协议端会忽略查询串，只认文件名。
 */
export function appearanceImageUrl(imagePath: string | null | undefined, version?: number): string | null {
  if (!imagePath) return null
  if (/^(?:data:|https?:|blob:)/i.test(imagePath)) return imagePath
  const name = imagePath.split(/[\\/]/).pop() ?? ''
  if (!APPEARANCE_ASSET_PATTERN.test(name)) return null
  const token = typeof version === 'number' && Number.isFinite(version) && version > 0
    ? `?v=${Math.trunc(version)}`
    : ''
  return `dsh-appearance://${name}${token}`
}

/** 选图后生成新的内容版本：至少比旧值大，跨会话也不会撞回旧 URL。 */
export function nextAppearanceImageVersion(current?: number): number {
  return Math.max(Date.now(), typeof current === 'number' && Number.isFinite(current) ? Math.trunc(current) + 1 : 0)
}

/** 会被 appearance 覆盖的全部根变量；应用前逐条 remove，避免换主题/清空后残留。 */
export const APPEARANCE_VARIABLE_KEYS: readonly string[] = [
  '--accent',
  '--accent-hover',
  '--accent-soft',
  '--focus-ring',
  '--scrollbar-thumb',
  '--scrollbar-thumb-hover',
  '--topbar-bg',
  '--topbar-active-bg',
  '--topbar-active-ink',
  '--app-bg',
  '--workspace-bg',
  '--panel-opacity',
  '--bg-opacity',
]

export function clampPanelOpacity(value: number): number {
  return Math.min(1, Math.max(0.2, value))
}

export function clampBackgroundOpacity(value: number): number {
  return Math.min(1, Math.max(0.1, value))
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const expanded = value.length === 3
    ? value.split('').map(char => char + char).join('')
    : value.slice(0, 6)
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ]
}

function toHex(rgb: number[]): string {
  return `#${rgb.map(channel => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')}`
}

/** 把 a 按 t（0–1）混向 b；与原型 mix() 同式。 */
export function mixHex(a: string, b: string, t: number): string {
  const left = hexToRgb(a)
  const right = hexToRgb(b)
  return toHex(left.map((channel, index) => channel + (right[index] - channel) * t))
}

export function rgbaFromHex(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * 设置 → 根元素 CSS 变量。
 * - 设了 accent：整套 accent 派生 + 底色渐变（否则「背景透明度调低透出主题色渐变」会透出默认蓝）
 * - 未设 accent：不碰 accent 与底色，保持上游各主题的固定值（默认外观与上游像素级一致）
 * - panelOpacity 始终写：默认 1 时 color-mix 结果与原值等价
 * - 背景图存在时写 --bg-opacity；图片 URL 不在本函数里，由渲染层挂到图层上
 */
export function appearanceVariables(appearance: AppearanceSettings | undefined, theme: UiTheme): Record<string, string> {
  const variables: Record<string, string> = {}
  const accent = appearance?.accent && ACCENT_PATTERN.test(appearance.accent)
    ? appearance.accent.toLowerCase()
    : null

  if (accent) {
    variables['--accent'] = accent
    variables['--accent-hover'] = theme === 'night' ? mixHex(accent, '#ffffff', 0.18) : mixHex(accent, '#000000', 0.14)
    variables['--accent-soft'] = theme === 'night' ? mixHex(accent, '#0d1117', 0.80) : mixHex(accent, '#ffffff', 0.88)
    variables['--focus-ring'] = rgbaFromHex(accent, 0.42)
    variables['--scrollbar-thumb'] = rgbaFromHex(accent, 0.46)
    variables['--scrollbar-thumb-hover'] = rgbaFromHex(accent, 0.78)
    // 夜间顶栏底色保持深色（上游契约），只派生高亮胶囊；上游把这两个 token 硬编码成蓝色。
    if (theme === 'night') {
      variables['--topbar-active-bg'] = rgbaFromHex(accent, 0.22)
      variables['--topbar-active-ink'] = mixHex(accent, '#ffffff', 0.28)
    } else {
      variables['--topbar-bg'] = 'var(--accent)'
    }
    const base = theme === 'night' ? '#0d1117' : '#ffffff'
    variables['--app-bg'] = mixHex(accent, base, theme === 'night' ? 0.90 : 0.87)
    variables['--workspace-bg'] = mixHex(accent, base, theme === 'night' ? 0.955 : 0.94)
  }

  variables['--panel-opacity'] = String(clampPanelOpacity(appearance?.panelOpacity ?? 1))
  if (appearance?.backgroundPath) {
    variables['--bg-opacity'] = String(clampBackgroundOpacity(appearance.backgroundOpacity ?? 1))
  }
  return variables
}

/** 背景图是否存在（有值才算图片态；空字符串按无图处理）。 */
export function hasBackgroundImage(appearance: AppearanceSettings | undefined): boolean {
  return Boolean(appearance?.backgroundPath && appearanceImageUrl(appearance.backgroundPath))
}
