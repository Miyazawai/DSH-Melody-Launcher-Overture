import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'
import type { AppSettings } from '../src/types'
import { createPackManager, type InstallInstaller } from '../electron/pack'
import { readProfile } from '../electron/profile'

/**
 * 真机快照回归：导出真实整合包 → 导入到隔离的临时环境 → 真启动一次 DSH。
 * 默认跳过（要打包/解压上百 MB 并拉起 DSH），需要时：
 *   DSH_REAL_PACK_SNAPSHOT=1 npx vitest run tests/pack-snapshot.real.test.ts
 * 只写临时目录与临时注册表，不动用户的整合包与设置。
 */
const userData = 'C:/Users/Miyazawa i/AppData/Roaming/dsh-launcher'
const outRoot = path.join(os.tmpdir(), 'dml-drill')
const dshCli = path.join(userData, 'dsh-runtime', 'versions', '0.1.2-rc.1', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

async function realSettings(): Promise<AppSettings> {
  return JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')) as AppSettings
}

function makeInstaller(receiptsPath: string): InstallInstaller {
  return {
    readProfile: (dshHome: string, profileName: string) => readProfile(dshHome, profileName, receiptsPath),
    installPluginTarget: async () => {}, installNpmPackage: async () => {}, remove: async () => ({}),
    togglePlugin: async () => [], reorderPlugins: async () => [], installSkill: async () => ({}),
    installSkillPinned: async () => ({}), installPreset: async () => ({}), installPresetLocal: async () => {},
    toggleSkill: async () => [], togglePreset: async () => [], installSkillLocal: async () => {},
  } as unknown as InstallInstaller
}

function realManager() {
  return createPackManager({
    readSettings: realSettings,
    saveSettings: async next => next,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    snapshotRoot: path.join(userData, 'pack-snapshots'),
    pluginReceiptsPath: path.join(userData, 'plugin-installs.json'),
    presetReceiptsPath: path.join(userData, 'preset-installs.json'),
    skillReceiptsPath: path.join(userData, 'skill-installs.json'),
    installer: makeInstaller(path.join(userData, 'plugin-installs.json')),
    applicationAddons: { list: async () => [], install: async () => ({}), uninstall: async () => [] },
    emitOutput: () => {},
    emitEvent: event => { if (event.kind === 'status') console.log('[status]', event.message) },
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    unifiedProfiles: true,
    packsRoot: path.join(userData, 'dsh-packs'),
    readStoredSettings: realSettings,
  })
}

async function makeScratchEnv() {
  const root = await mkdtemp(path.join(process.env.APPDATA ?? os.tmpdir(), 'dsh-launcher-drill-env-'))
  const packsRoot = path.join(root, 'dsh-packs')
  const registryPath = path.join(root, 'packs.json')
  await mkdir(packsRoot, { recursive: true })
  await writeFile(registryPath, JSON.stringify({ version: 1, records: [] }))
  let stored: AppSettings = { ...(await realSettings()), activePackId: null, profileName: 'web' }
  const readStoredSettings = async () => stored
  const readSettings = async () => {
    const records = JSON.parse(await readFile(registryPath, 'utf8')).records as Array<{ id: string; homePath?: string }>
    const active = records.find(record => record.id === stored.activePackId)
    return active?.homePath ? { ...stored, dshHome: active.homePath } : stored
  }
  const manager = createPackManager({
    readSettings,
    saveSettings: async next => { stored = next; return next },
    registryPath,
    manifestRoot: path.join(root, 'pack-manifests'),
    snapshotRoot: path.join(root, 'snapshots'),
    pluginReceiptsPath: path.join(root, 'plugin-installs.json'),
    presetReceiptsPath: path.join(root, 'preset-installs.json'),
    skillReceiptsPath: path.join(root, 'skill-installs.json'),
    installer: makeInstaller(path.join(root, 'plugin-installs.json')),
    applicationAddons: { list: async () => [], install: async () => ({}), uninstall: async () => [] },
    emitOutput: (level, text) => console.log(`[out:${level}]`, text.slice(0, 160)),
    emitEvent: event => {
      if (event.kind === 'status') console.log('[status]', event.message)
      if (event.kind === 'done') console.log('[done]', JSON.stringify(event.result))
    },
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    unifiedProfiles: true,
    packsRoot,
    readStoredSettings,
    ensureDshVersionInstalled: async () => {},
  })
  return { root, packsRoot, manager }
}

/** 真启动一次 DSH，等端口起来（或超时），然后整棵进程树杀掉。 */
async function launchCheck(home: string, packId: string, port: number): Promise<boolean> {
  const child = spawn(process.execPath, [dshCli, '--profile', packId, '--no-open', '--port', String(port)], {
    cwd: home,
    env: {
      ...process.env,
      DSH_HOME: home,
      CI: 'true',
      FORCE_COLOR: '0',
      PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`,
    },
    windowsHide: true,
  })
  let output = ''
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })
  let up = false
  for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (child.exitCode !== null) break
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
      up = response.status < 500
    } catch { /* 还没起来 */ }
  }
  if (child.exitCode !== null) console.log(`[launch] 进程提前退出 code=${child.exitCode}\n${output.slice(-1200)}`)
  else console.log(`[launch] up=${up} 输出尾部：${output.slice(-400).replace(/\n/g, ' | ')}`)
  if (child.pid) {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('close', () => resolve())
      killer.on('error', () => resolve())
    })
  }
  return up
}

const runRealDrill = process.env.DSH_REAL_PACK_SNAPSHOT === '1'

describe.runIf(runRealDrill)('真机快照演练（DSH_REAL_PACK_SNAPSHOT=1）', () => {
  it('导出两个布局的包 → 导入到隔离环境 → 真启动', async () => {
    await mkdir(outRoot, { recursive: true })
    const manager = realManager()
    const zipPaths: Record<string, string> = {}
    for (const packId of ['pack-test', 'pack-test-2']) {
      const zipPath = path.join(outRoot, `${packId}.zip`)
      const existing = process.env.DSH_REAL_PACK_SNAPSHOT_REUSE === '1' ? await stat(zipPath).catch(() => null) : null
      if (existing && existing.size > 50 * 1024 * 1024) {
        console.log(`[export] 复用已有 ${packId}.zip ${(existing.size / 1048576).toFixed(1)}MB`)
      } else {
        const startedAt = Date.now()
        await manager.exportPack(packId, undefined, zipPath)
        const info = await stat(zipPath)
        console.log(`[export] ${packId} → ${(info.size / 1048576).toFixed(1)}MB，用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)
      }
      zipPaths[packId] = zipPath
    }

    let firstScratchHome = ''
    for (const [packId, label] of [['pack-test', 'hoisted'], ['pack-test-2', 'isolated']] as const) {
      const scratch = await makeScratchEnv()
      const startedImport = Date.now()
      const result = await scratch.manager.importPack(zipPaths[packId], [], { name: `drill-${label}` })
      console.log(`[import:${label}] id=${result.id} plugins=${result.installed.join(',') || '（无）'} 用时 ${((Date.now() - startedImport) / 1000).toFixed(0)}s`)
      const home = path.join(scratch.packsRoot, result.id)
      const profileDir = path.join(home, 'profiles', result.id)
      console.log(`[home:${label}]`, (await readdir(home)).join(' '))
      console.log(`[profile:${label}]`, (await readdir(profileDir)).join(' '))
      const pkg = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> }
      console.log(`[package.json:${label}] name=${pkg.name} deps=${JSON.stringify(pkg.dependencies ?? {})}`)
      console.log(`[excluded:${label}] credentials=${existsSync(path.join(home, '.credentials.yaml'))} sessions=${existsSync(path.join(home, 'sessions'))} storages=${existsSync(path.join(home, 'storages'))}`)
      console.log(`[settings:${label}]`, await readFile(path.join(home, 'settings.yaml'), 'utf8').then(text => text.slice(0, 100).replace(/\n/g, ' | ')).catch(() => '（无 settings.yaml）'))
      console.log(`[node_modules:${label}]`, (await readdir(path.join(profileDir, 'node_modules'))).length, '个顶层条目')
      if (label === 'isolated') {
        const link = path.join(profileDir, 'node_modules', '@linxin666')
        console.log(`[junction:${label}] @linxin666 存在=${existsSync(link)}`)
        const launched = await launchCheck(home, result.id, 3458)
        console.log(`[launch:${label}] 启动成功=${launched}`)
      }
      if (packId === 'pack-test') {
        firstScratchHome = home
        const launched = await launchCheck(home, result.id, 3457)
        console.log(`[launch:${label}] 启动成功=${launched}`)
      }
      await rm(scratch.root, { recursive: true, force: true })
    }
    console.log('[done] 演练家目录：', firstScratchHome)
  }, 30 * 60 * 1000)
})
