import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AppSettings } from '../src/types'
import { ensureNodeRuntime } from '../electron/node-runtime'
import { createPackManager, type InstallInstaller } from '../electron/pack'
import { readProfile } from '../electron/profile'

/**
 * 真机导出回归：对真实安装的整合包跑一遍完整导出，断言离线依赖 tarball 与 lockfile
 * 确实进了 zip。默认跳过（会打上百个 npm tarball，几分钟），需要时：
 *   DSH_REAL_PACK_EXPORT=1 [DSH_REAL_PACK_ID=pack-test] npx vitest run tests/pack-export.real.test.ts
 */
const runRealExport = process.env.DSH_REAL_PACK_EXPORT === '1'
const userData = process.env.APPDATA ? path.join(process.env.APPDATA, 'dsh-launcher') : ''
const packId = process.env.DSH_REAL_PACK_ID ?? 'pack-test'

let workRoot: string | null = null
afterAll(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe.runIf(runRealExport && userData !== '')('真实整合包导出', () => {
  it('导出 zip 应带离线依赖 tarball 与 lockfile', async () => {
    const settingsPath = path.join(userData, 'settings.json')
    const receiptsPath = path.join(userData, 'plugin-installs.json')
    const readSettings = async (): Promise<AppSettings> =>
      JSON.parse(await readFile(settingsPath, 'utf8')) as AppSettings
    const installer = {
      readProfile: (dshHome: string, profileName: string) => readProfile(dshHome, profileName, receiptsPath),
      installPluginTarget: async () => {}, installNpmPackage: async () => {}, remove: async () => ({}),
      togglePlugin: async () => [], reorderPlugins: async () => [], installSkill: async () => ({}),
      installSkillPinned: async () => ({}), installPreset: async () => ({}), installPresetLocal: async () => {},
      toggleSkill: async () => [], togglePreset: async () => [], installSkillLocal: async () => {},
    } as unknown as InstallInstaller
    const manager = createPackManager({
      readSettings,
      saveSettings: async next => next,
      registryPath: path.join(userData, 'packs.json'),
      manifestRoot: path.join(userData, 'pack-manifests'),
      snapshotRoot: path.join(userData, 'pack-snapshots'),
      pluginReceiptsPath: receiptsPath,
      presetReceiptsPath: path.join(userData, 'preset-installs.json'),
      skillReceiptsPath: path.join(userData, 'skill-installs.json'),
      installer,
      applicationAddons: { list: async () => [], install: async () => ({}), uninstall: async () => [] },
      emitOutput: () => {},
      emitEvent: () => {},
      isRuntimeRunning: () => false,
      isInstallerBusy: () => false,
      unifiedProfiles: true,
      packsRoot: path.join(userData, 'dsh-packs'),
      readStoredSettings: readSettings,
      getNodeExecutable: async () => (await ensureNodeRuntime(path.join(userData, 'node-runtime'))).node,
    })
    workRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-real-export-'))
    const zipPath = path.join(workRoot, `${packId}.zip`)
    await mkdir(path.dirname(zipPath), { recursive: true })
    const result = await manager.exportPack(packId, 'light', zipPath)
    const info = await stat(result.zipPath)
    const AdmZip = (await import('adm-zip')).default
    const entries = new AdmZip(result.zipPath).getEntries().map(entry => entry.entryName)
    const tarballs = entries.filter(name => name.startsWith('dependency-tarballs/'))
    console.log(`[real-export] ${result.zipPath} size=${(info.size / 1048576).toFixed(1)}MB tarballs=${tarballs.length}`)
    expect(entries).toContain('dsh-pack.yaml')
    expect(entries).toContain('pnpm-lock.yaml')
    expect(tarballs.length).toBeGreaterThan(0)
  }, 20 * 60 * 1000)
})
