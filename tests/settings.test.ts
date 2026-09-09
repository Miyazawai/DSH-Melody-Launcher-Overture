import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adoptDetectedDsh,
  createSettingsStore,
  defaultSettings,
  mergeStoredSettings,
  usesOnDemandDsh,
  validateSettings,
} from '../electron/settings'
import type { AppSettings } from '../src/types'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

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

describe('defaultSettings', () => {
  it('prefers DSH_HOME from the environment', () => {
    const settings = defaultSettings({
      dshHomeFromEnvironment: '/custom/dsh',
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      platform: 'linux',
    })
    expect(settings.dshHome).toBe('/custom/dsh')
  })

  it('falls back to a .dsh directory under home', () => {
    const settings = defaultSettings({
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      platform: 'linux',
    })
    expect(settings.dshHome).toBe('/home/tester/.dsh')
    expect(settings.launchExecutable).toBe('npx')
    expect(settings.webPort).toBe(3080)
    expect(settings.uiTheme).toBe('deepseek')
    expect(settings.aiDeveloperMode).toBe(false)
    expect(settings.aiPrompt).toBe('')
  })

  it('uses the detected system npx when available', () => {
    const settings = defaultSettings({
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      systemNpx: 'C:\\Program Files\\nodejs\\npx.cmd',
      platform: 'win32',
    })
    expect(settings.launchExecutable).toBe('C:\\Program Files\\nodejs\\npx.cmd')
  })

  it('uses the platform default executable name without a detected runtime', () => {
    expect(defaultSettings({
      homeDirectory: 'C:\\Users\\tester',
      documentsDirectory: 'C:\\Users\\tester\\Documents',
      platform: 'win32',
    }).launchExecutable).toBe('npx.cmd')
  })
})

describe('validateSettings', () => {
  it('trims the executable and keeps the remaining fields', () => {
    const validated = validateSettings({ ...baseSettings, launchExecutable: '  npx  ' })
    expect(validated.launchExecutable).toBe('npx')
    expect(validated.launchArgs).toEqual(baseSettings.launchArgs)
  })

  it('rejects a profile name with path separators', () => {
    expect(() => validateSettings({ ...baseSettings, profileName: '../escape' })).toThrow(/整合包名称/)
  })

  it('rejects relative directories', () => {
    expect(() => validateSettings({ ...baseSettings, dshHome: 'relative/path' })).toThrow(/完整路径/)
    expect(() => validateSettings({ ...baseSettings, workspace: './work' })).toThrow(/完整路径/)
    expect(() => validateSettings({ ...baseSettings, dshInstallPath: 'relative/runtime' })).toThrow(/完整路径/)
  })

  it('rejects an install path at the disk root', () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/'
    expect(() => validateSettings({ ...baseSettings, dshInstallPath: root })).toThrow(/磁盘根目录/)
  })

  it('rejects an install path that collides with DSH_HOME', () => {
    expect(() => validateSettings({ ...baseSettings, dshInstallPath: baseSettings.dshHome })).toThrow(/不能与 DSH_HOME 相同/)
  })

  it('rejects an empty launch command', () => {
    expect(() => validateSettings({ ...baseSettings, launchExecutable: '   ' })).toThrow(/启动命令/)
  })

  it('rejects launch arguments that are not all strings', () => {
    expect(() => validateSettings({ ...baseSettings, launchArgs: ['web', 42 as unknown as string] })).toThrow(/启动参数/)
  })

  it('rejects an invalid Web port', () => {
    expect(() => validateSettings({ ...baseSettings, webPort: 0 })).toThrow(/Web 端口/)
    expect(() => validateSettings({ ...baseSettings, webPort: 65536 })).toThrow(/Web 端口/)
    expect(() => validateSettings({ ...baseSettings, webPort: 3080.5 })).toThrow(/Web 端口/)
  })

  it('coerces openAfterLaunch to a boolean', () => {
    expect(validateSettings({ ...baseSettings, openAfterLaunch: 1 as unknown as boolean }).openAfterLaunch).toBe(true)
  })

  it('normalizes Copilot developer settings and limits prompt size', () => {
    const validated = validateSettings({ ...baseSettings, aiDeveloperMode: true, aiPrompt: 'x'.repeat(25_000) })
    expect(validated.aiDeveloperMode).toBe(true)
    expect(validated.aiPrompt).toHaveLength(20_000)
  })

  it('accepts known UI themes and falls back for invalid values', () => {
    expect(validateSettings({ ...baseSettings, uiTheme: 'night' }).uiTheme).toBe('night')
    expect(validateSettings({ ...baseSettings, uiTheme: 'neon' as never }).uiTheme).toBe('deepseek')
    expect(validateSettings({ ...baseSettings, uiTheme: 'forest' as never }).uiTheme).toBe('deepseek')
    expect(validateSettings({ ...baseSettings, uiTheme: 'deepseek' }).uiTheme).toBe('deepseek')
  })
})

describe('mergeStoredSettings', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(mergeStoredSettings(baseSettings, null)).toEqual(baseSettings)
  })

  it('lets stored values win over the defaults', () => {
    const merged = mergeStoredSettings(baseSettings, { profileName: 'headless' })
    expect(merged.profileName).toBe('headless')
    expect(merged.dshHome).toBe(baseSettings.dshHome)
  })

  it('drops non-string launch arguments instead of failing', () => {
    const merged = mergeStoredSettings(baseSettings, {
      launchArgs: ['web', 7 as unknown as string, 'extra'],
    })
    expect(merged.launchArgs).toEqual(['web', 'extra'])
  })

  it('falls back to the default arguments when the stored value is not an array', () => {
    const merged = mergeStoredSettings(baseSettings, { launchArgs: 'web' as unknown as string[] })
    expect(merged.launchArgs).toEqual(baseSettings.launchArgs)
  })

  it('migrates a legacy --port launch argument into the Web port setting', () => {
    const merged = mergeStoredSettings(baseSettings, {
      launchArgs: ['--yes', '@deepseek-ai/dsh', 'web', '--port', '4090'],
    })
    expect(merged.webPort).toBe(4090)
  })

  it('adds safe Copilot defaults to legacy settings', () => {
    const merged = mergeStoredSettings(baseSettings, { profileName: 'web' })
    expect(merged.aiDeveloperMode).toBe(false)
    expect(merged.aiPrompt).toBe('')
    expect(merged.uiTheme).toBe('deepseek')
  })

  it('keeps a supported stored theme and discards an unknown one', () => {
    expect(mergeStoredSettings(baseSettings, { uiTheme: 'ocean' as never }).uiTheme).toBe('deepseek')
    expect(mergeStoredSettings(baseSettings, { uiTheme: 'neon' as never }).uiTheme).toBe('deepseek')
  })

  it('migrates legacy settings with automatic runtime version selection', () => {
    const defaults = defaultSettings({
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      platform: 'linux',
    })
    const merged = mergeStoredSettings(defaults, { profileName: 'web' })
    expect(merged.dshVersion).toBeNull()
    expect(merged.nodeVersion).toBeNull()
  })

  it('keeps valid explicitly selected runtime versions', () => {
    const merged = mergeStoredSettings(baseSettings, { dshVersion: 'v0.1.0-rc.7', nodeVersion: '22.19.0' })
    expect(merged.dshVersion).toBe('v0.1.0-rc.7')
    expect(merged.nodeVersion).toBe('22.19.0')
  })
})

describe('usesOnDemandDsh', () => {
  it('recognizes an npx-based launch configuration', () => {
    expect(usesOnDemandDsh(baseSettings)).toBe(true)
    expect(usesOnDemandDsh({
      ...baseSettings,
      launchExecutable: path.join('C:', 'nodejs', 'npx.cmd'),
    })).toBe(true)
  })

  it('does not match a configuration bound to a local dsh executable', () => {
    expect(usesOnDemandDsh({
      ...baseSettings,
      launchExecutable: '/opt/dsh/node_modules/.bin/dsh',
      launchArgs: ['web'],
    })).toBe(false)
  })

  it('does not match npx invoked for some other package', () => {
    expect(usesOnDemandDsh({ ...baseSettings, launchArgs: ['--yes', 'other-package'] })).toBe(false)
  })
})

describe('adoptDetectedDsh', () => {
  const detected = { installed: true, version: '1.2.3', executable: '/opt/dsh/dsh', source: 'system' as const }

  it('switches an on-demand configuration to the detected executable', () => {
    const next = adoptDetectedDsh(baseSettings, detected)
    expect(next.launchExecutable).toBe('/opt/dsh/dsh')
    expect(next.launchArgs).toEqual(['web'])
  })

  it('leaves an already bound configuration untouched', () => {
    const bound = { ...baseSettings, launchExecutable: '/existing/dsh', launchArgs: ['web'] }
    expect(adoptDetectedDsh(bound, detected)).toBe(bound)
  })

  it('leaves the configuration untouched when nothing was detected', () => {
    expect(adoptDetectedDsh(baseSettings, {
      installed: false,
      version: null,
      executable: null,
      source: null,
    })).toBe(baseSettings)
  })
})

describe('createSettingsStore 派生激活包家目录（真隔离咽喉点）', () => {
  async function fixture(options: { activePackId?: string | null; homeFor?: (settings: AppSettings) => Promise<string | null> } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'settings-derive-'))
    temporaryRoots.push(root)
    const filePath = path.join(root, 'settings.json')
    const base = { ...baseSettings, activePackId: options.activePackId ?? null }
    await writeFile(filePath, JSON.stringify(base), 'utf8')
    const store = createSettingsStore({
      filePath,
      createDefaults: () => base,
      detectInstalledDsh: async () => ({ installed: false, version: null, executable: null, source: null }),
      resolvePackHome: options.homeFor,
    })
    return { store, filePath, root }
  }

  it('read() 返回激活包的私有家目录，readStored() 保持默认家目录', async () => {
    const { store } = await fixture({
      activePackId: 'pack-a',
      homeFor: async () => '/packs/pack-a',
    })
    expect((await store.read()).dshHome).toBe('/packs/pack-a')
    expect((await store.readStored()).dshHome).toBe('/home/tester/.dsh')
  })

  it('无激活包或注册表无目录时不派生', async () => {
    const noPack = await fixture()
    expect((await noPack.store.read()).dshHome).toBe('/home/tester/.dsh')
    const missing = await fixture({ activePackId: 'pack-a', homeFor: async () => null })
    expect((await missing.store.read()).dshHome).toBe('/home/tester/.dsh')
  })

  it('save() 剥离派生值：整包回传 read() 结果不会把包目录写进 settings.json', async () => {
    const { store, filePath } = await fixture({
      activePackId: 'pack-a',
      homeFor: async () => '/packs/pack-a',
    })
    const derived = await store.read()
    expect(derived.dshHome).toBe('/packs/pack-a')
    const saved = await store.save({ ...derived, webPort: 3081 })
    const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as AppSettings
    expect(onDisk.dshHome).toBe('/home/tester/.dsh')
    expect(onDisk.activePackId).toBe('pack-a')
    expect(saved.dshHome).toBe('/packs/pack-a') // 返回值仍是派生态
  })

  it('save() 保留用户主动改动的 dshHome（与派生值不同则视为编辑默认家目录）', async () => {
    const { store, filePath } = await fixture({
      activePackId: 'pack-a',
      homeFor: async () => '/packs/pack-a',
    })
    await store.save({ ...baseSettings, activePackId: 'pack-a', dshHome: '/moved/default-home' })
    const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as AppSettings
    expect(onDisk.dshHome).toBe('/moved/default-home')
  })

  it('activePackId 在 merge/validate 中存活', () => {
    const merged = mergeStoredSettings(baseSettings, { activePackId: 'pack-x' })
    expect(merged.activePackId).toBe('pack-x')
    const validated = validateSettings({ ...baseSettings, activePackId: 'pack-x' })
    expect(validated.activePackId).toBe('pack-x')
    expect(validateSettings(baseSettings).activePackId).toBeNull()
  })
})
