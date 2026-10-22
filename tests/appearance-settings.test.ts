import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeStoredSettings, validateSettings } from '../electron/settings'
import type { AppSettings } from '../src/types'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-appearance-settings-'))
  temporaryRoots.push(root)
  return root
}

const baseSettings: AppSettings = {
  dshInstallPath: '/home/tester/.dsh-runtime',
  dshHome: '/home/tester/.dsh',
  profileName: 'web',
  workspace: '/home/tester/Documents',
  launchExecutable: 'npx',
  launchArgs: ['--yes', '@deepseek-ai/dsh', 'web'],
  webPort: 3080,
  openAfterLaunch: true,
}

describe('appearance 校验（mergeStoredSettings）', () => {
  it('旧存档没有 appearance 时照常读', () => {
    const merged = mergeStoredSettings(baseSettings, { ...baseSettings })
    expect(merged.appearance).toBeUndefined()
  })

  it('归一化 accent 并钳制两个透明度', () => {
    const merged = mergeStoredSettings(baseSettings, {
      ...baseSettings,
      appearance: { accent: '#ABCDEF', panelOpacity: 0.05, backgroundOpacity: 3 },
    })
    expect(merged.appearance).toEqual({ accent: '#abcdef', panelOpacity: 0.2, backgroundOpacity: 1 })
  })

  it('非法主题色整体丢弃，其余合法字段保留', () => {
    const merged = mergeStoredSettings(baseSettings, {
      ...baseSettings,
      appearance: { accent: 'blue', panelOpacity: 0.6 },
    })
    expect(merged.appearance).toEqual({ panelOpacity: 0.6 })
  })

  it('结构不对的 appearance 直接丢弃，不抛错', () => {
    expect(mergeStoredSettings(baseSettings, { ...baseSettings, appearance: 'oops' as never }).appearance).toBeUndefined()
    expect(mergeStoredSettings(baseSettings, { ...baseSettings, appearance: [] as never }).appearance).toBeUndefined()
  })

  it('保留存在的图片路径，丢弃不存在的路径', async () => {
    const root = await temporaryRoot()
    const existing = path.join(root, 'background.png')
    await writeFile(existing, Buffer.from('png'))

    const kept = mergeStoredSettings(baseSettings, {
      ...baseSettings,
      appearance: { backgroundPath: existing },
    })
    expect(kept.appearance?.backgroundPath).toBe(path.resolve(existing))

    const dropped = mergeStoredSettings(baseSettings, {
      ...baseSettings,
      appearance: { backgroundPath: path.join(root, 'missing.png') },
    })
    expect(dropped.appearance).toBeUndefined()
  })

  it('保留图片版本号（只随对应图片路径一起保留）', async () => {
    const root = await temporaryRoot()
    const background = path.join(root, 'background.png')
    const logo = path.join(root, 'logo.webp')
    await writeFile(background, Buffer.from('png'))
    await writeFile(logo, Buffer.from('webp'))

    const kept = mergeStoredSettings(baseSettings, {
      ...baseSettings,
      appearance: { backgroundPath: background, backgroundVersion: 1700000000000, logoPath: logo, logoVersion: 42 },
    })
    expect(kept.appearance?.backgroundVersion).toBe(1700000000000)
    expect(kept.appearance?.logoVersion).toBe(42)

    const pathMissing = mergeStoredSettings(baseSettings, {
      ...baseSettings,
      appearance: { backgroundPath: path.join(root, 'missing.png'), backgroundVersion: 7 },
    })
    expect(pathMissing.appearance?.backgroundVersion).toBeUndefined()

    const invalid = mergeStoredSettings(baseSettings, {
      ...baseSettings,
      appearance: { backgroundPath: background, backgroundVersion: -1, logoPath: logo, logoVersion: Number.NaN },
    })
    expect(invalid.appearance?.backgroundVersion).toBeUndefined()
    expect(invalid.appearance?.logoVersion).toBeUndefined()
  })

  it('拒绝非图片扩展名与超过 10MB 的图片', async () => {
    const root = await temporaryRoot()
    const exe = path.join(root, 'logo.exe')
    const huge = path.join(root, 'huge.png')
    await writeFile(exe, Buffer.from('x'))
    await writeFile(huge, Buffer.alloc(10 * 1024 * 1024 + 1))

    expect(mergeStoredSettings(baseSettings, { ...baseSettings, appearance: { logoPath: exe } }).appearance).toBeUndefined()
    expect(mergeStoredSettings(baseSettings, { ...baseSettings, appearance: { backgroundPath: huge } }).appearance).toBeUndefined()
  })
})

describe('appearance 校验（validateSettings）', () => {
  it('保存时保留合法 appearance 并返回归一化结果', async () => {
    const root = await temporaryRoot()
    const logo = path.join(root, 'logo.webp')
    await writeFile(logo, Buffer.from('webp'))
    const saved = validateSettings({
      ...baseSettings,
      appearance: { accent: '#123456', logoPath: logo, panelOpacity: 0.4 },
    })
    expect(saved.appearance).toEqual({ accent: '#123456', panelOpacity: 0.4, logoPath: path.resolve(logo) })
  })

  it('保存非法 appearance 不抛错，只丢弃非法项', () => {
    const saved = validateSettings({
      ...baseSettings,
      appearance: { accent: '#12', panelOpacity: 99 },
    })
    expect(saved.appearance).toEqual({ panelOpacity: 1 })
  })
})
