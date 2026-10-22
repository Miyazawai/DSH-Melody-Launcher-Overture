import { describe, expect, it } from 'vitest'
import {
  ACCENT_PATTERN,
  appearanceImageUrl,
  appearanceVariables,
  clampBackgroundOpacity,
  clampPanelOpacity,
  hasBackgroundImage,
  mixHex,
  nextAppearanceImageVersion,
  rgbaFromHex,
} from '../src/lib/appearance'

describe('外观颜色派生', () => {
  it('按比例混色', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#7c5cff', '#000000', 0.14)).toBe('#6b4fdb')
  })

  it('rgba 保留 alpha', () => {
    expect(rgbaFromHex('#2b7cd8', 0.42)).toBe('rgba(43, 124, 216, 0.42)')
  })

  it('只接受 #rrggbb', () => {
    expect(ACCENT_PATTERN.test('#7c5cff')).toBe(true)
    expect(ACCENT_PATTERN.test('7c5cff')).toBe(false)
    expect(ACCENT_PATTERN.test('#7c5cf')).toBe(false)
  })
})

describe('appearanceVariables', () => {
  it('日间：整套 accent 派生 + 底色渐变', () => {
    const variables = appearanceVariables({ accent: '#7c5cff' }, 'deepseek')
    expect(variables['--accent']).toBe('#7c5cff')
    expect(variables['--accent-hover']).toBe('#6b4fdb')
    expect(variables['--accent-soft']).toBe('#efebff')
    expect(variables['--focus-ring']).toBe('rgba(124, 92, 255, 0.42)')
    expect(variables['--scrollbar-thumb']).toBe('rgba(124, 92, 255, 0.46)')
    expect(variables['--scrollbar-thumb-hover']).toBe('rgba(124, 92, 255, 0.78)')
    expect(variables['--topbar-bg']).toBe('var(--accent)')
    expect(variables['--topbar-active-bg']).toBeUndefined()
    expect(variables['--topbar-active-ink']).toBeUndefined()
    expect(variables['--app-bg']).toBe('#eeeaff')
    expect(variables['--workspace-bg']).toBe('#f7f5ff')
  })

  it('夜间：补上上游硬编码的顶栏胶囊 token', () => {
    const variables = appearanceVariables({ accent: '#7c5cff' }, 'night')
    expect(variables['--topbar-active-bg']).toBe('rgba(124, 92, 255, 0.22)')
    expect(variables['--topbar-active-ink']).toBe('#a18aff')
    expect(variables['--topbar-bg']).toBeUndefined()
    expect(variables['--app-bg']).toBe(mixHex('#7c5cff', '#0d1117', 0.90))
    expect(variables['--workspace-bg']).toBe(mixHex('#7c5cff', '#0d1117', 0.955))
  })

  it('未自定义主题色：不碰 accent 与底色，默认外观与上游一致', () => {
    const variables = appearanceVariables(undefined, 'deepseek')
    expect(variables['--accent']).toBeUndefined()
    expect(variables['--app-bg']).toBeUndefined()
    expect(variables['--workspace-bg']).toBeUndefined()
    expect(variables['--panel-opacity']).toBe('1')
  })

  it('透明度按各自区间钳制', () => {
    expect(clampPanelOpacity(0.05)).toBe(0.2)
    expect(clampPanelOpacity(3)).toBe(1)
    expect(clampBackgroundOpacity(0.01)).toBe(0.1)
    const variables = appearanceVariables({ panelOpacity: 0.05, backgroundPath: '/x/background.png', backgroundOpacity: 0.01 }, 'deepseek')
    expect(variables['--panel-opacity']).toBe('0.2')
    expect(variables['--bg-opacity']).toBe('0.1')
  })

  it('没有背景图时不写 --bg-opacity', () => {
    expect(appearanceVariables({ panelOpacity: 0.5 }, 'deepseek')['--bg-opacity']).toBeUndefined()
  })
})

describe('appearanceImageUrl', () => {
  it('把存储路径映射到自定义协议', () => {
    expect(appearanceImageUrl('C:\\Users\\a\\AppData\\Roaming\\dsh-launcher\\appearance\\background.png')).toBe('dsh-appearance://background.png')
    expect(appearanceImageUrl('/home/a/appearance/logo.webp')).toBe('dsh-appearance://logo.webp')
  })

  it('演示/测试用的 data URL 原样透传', () => {
    expect(appearanceImageUrl('data:image/svg+xml;charset=utf-8,abc')).toBe('data:image/svg+xml;charset=utf-8,abc')
  })

  it('拒绝非白名单文件名', () => {
    expect(appearanceImageUrl('/tmp/evil.exe')).toBeNull()
    expect(appearanceImageUrl('')).toBeNull()
    expect(appearanceImageUrl(null)).toBeNull()
  })

  it('同一路径换图时用版本参数区分 URL（否则渲染层会复用旧图）', () => {
    const stored = 'C:\\Users\\a\\AppData\\Roaming\\dsh-launcher\\appearance\\background.png'
    expect(appearanceImageUrl(stored, 1700000000000)).toBe('dsh-appearance://background.png?v=1700000000000')
    expect(appearanceImageUrl(stored, 1700000000001)).not.toBe(appearanceImageUrl(stored, 1700000000000))
  })

  it('没有版本号或版本号非法时退回原来的 URL', () => {
    const stored = '/home/a/appearance/logo.webp'
    expect(appearanceImageUrl(stored)).toBe('dsh-appearance://logo.webp')
    expect(appearanceImageUrl(stored, Number.NaN)).toBe('dsh-appearance://logo.webp')
    expect(appearanceImageUrl(stored, 0)).toBe('dsh-appearance://logo.webp')
    expect(appearanceImageUrl(stored, -5)).toBe('dsh-appearance://logo.webp')
  })

  it('下一版图片版本号严格大于旧值', () => {
    expect(nextAppearanceImageVersion(undefined)).toBeGreaterThan(0)
    expect(nextAppearanceImageVersion(123)).toBeGreaterThan(123)
    expect(nextAppearanceImageVersion(1700000000000)).toBeGreaterThan(1700000000000)
  })

  it('hasBackgroundImage 只认可加载的图', () => {
    expect(hasBackgroundImage({ backgroundPath: '/a/background.jpg' })).toBe(true)
    expect(hasBackgroundImage({ backgroundPath: '/a/evil.png' })).toBe(false)
    expect(hasBackgroundImage(undefined)).toBe(false)
  })
})
