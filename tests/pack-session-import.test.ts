import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings, PackProgressEvent } from '../src/types'
import { createPackManager } from '../electron/pack'
import { upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

/**
 * 「导入聊天记录」的整合包服务层：预览 / 执行 / 撤销，加两条护栏——
 * DSH 在跑时不许动（会话日志是追加写的），以及进度横幅必须自己收口。
 */

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

async function makeEnv(): Promise<{ root: string; packsRoot: string; registryPath: string; sessionImportsRoot: string; project: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-session-'))
  roots.push(root)
  const project = path.join(root, 'project')
  await mkdir(project, { recursive: true })
  return {
    root,
    project,
    packsRoot: path.join(root, 'dsh-packs'),
    registryPath: path.join(root, 'packs.json'),
    sessionImportsRoot: path.join(root, 'pack-session-imports'),
  }
}

function record(env: ReturnType<typeof makeEnv> extends Promise<infer T> ? T : never, id: string, name: string): PackRecord {
  return {
    id,
    name,
    description: '',
    version: '1.0.0',
    dshVersion: '0.1.5-rc.2',
    homePath: path.join(env.packsRoot, id),
    source: 'created',
    installedAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    state: 'complete',
    plugins: [],
  }
}

async function writeSession(homePath: string, projectKey: string, sessionId: string, cwd: string, version = 3): Promise<string> {
  const directory = path.join(homePath, 'sessions', projectKey, sessionId)
  await mkdir(directory, { recursive: true })
  const logPath = path.join(directory, 'session.jsonl')
  await writeFile(logPath, `${JSON.stringify({ type: 'session', version, id: sessionId, cwd, createdAt: 1_700_000_000_000 })}\n`, 'utf8')
  return logPath
}

function makeManager(env: Awaited<ReturnType<typeof makeEnv>>, events: PackProgressEvent[], runtimeRunning = false) {
  let settings: AppSettings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome: path.join(env.root, 'dsh-home'),
    profileName: 'pack-a',
    activePackId: 'pack-a',
  }
  const installer = {
    readProfile: async () => ({ initialized: true, profileDir: '', manifestPath: '', plugins: [], activeBundles: [], dependencyCount: 0, disabledCount: 0 }),
    installPluginTarget: async () => {}, installNpmPackage: async () => {}, remove: async () => {},
    togglePlugin: async () => ({}), reorderPlugins: async () => [],
    installSkill: async () => ({}), installSkillPinned: async () => ({}), installPreset: async () => ({}),
    installPresetLocal: async () => {}, installSkillLocal: async () => {},
    toggleSkill: async () => [], togglePreset: async () => [],
  }
  return createPackManager({
    readSettings: async () => settings,
    saveSettings: async next => { settings = next; return next },
    readStoredSettings: async () => settings,
    registryPath: env.registryPath,
    snapshotRoot: path.join(env.root, 'pack-snapshots'),
    sessionImportsRoot: env.sessionImportsRoot,
    pluginReceiptsPath: path.join(env.root, 'plugin-installs.json'),
    presetReceiptsPath: path.join(env.root, 'preset-installs.json'),
    skillReceiptsPath: path.join(env.root, 'skill-installs.json'),
    applicationAddons: { list: async () => [], install: async () => ({}), uninstall: async () => [] },
    installer: installer as never,
    emitEvent: event => events.push(event),
    emitOutput: () => {},
    isRuntimeRunning: () => runtimeRunning,
    isInstallerBusy: () => false,
    unifiedProfiles: true,
    packsRoot: env.packsRoot,
  })
}

describe('整合包会话记录搬运', () => {
  it('预览报条数与来源；执行只写目标包，源包分毫未动', async () => {
    const env = await makeEnv()
    const events: PackProgressEvent[] = []
    const manager = makeManager(env, events)
    await mkdir(path.join(env.packsRoot, 'pack-a'), { recursive: true })
    await mkdir(path.join(env.packsRoot, 'pack-b'), { recursive: true })
    const sourceLog = await writeSession(path.join(env.packsRoot, 'pack-a'), '--project--', 'session-a', env.project)
    await writeSession(path.join(env.packsRoot, 'pack-b'), '--other--', 'session-b', env.project)
    await upsertPackRecord(env.registryPath, record(env, 'pack-a', '旧包'))
    await upsertPackRecord(env.registryPath, record(env, 'pack-b', '新包'))

    const preview = await manager.previewSessionImport('pack-a', 'pack-b')
    expect(preview).toMatchObject({
      sourceName: '旧包',
      targetName: '新包',
      importableCount: 1,
      skipped: [],
      formatUnverified: false,
    })

    const result = await manager.importSessionHistory('pack-a', 'pack-b')
    expect(result).toMatchObject({ copiedFiles: 1, importableCount: 1 })
    expect(result.undoId).toMatch(/^\d+$/)
    const landed = path.join(env.packsRoot, 'pack-b', 'sessions', '--project--', 'session-a', 'session.jsonl')
    expect(await readFile(landed, 'utf8')).toContain('"session-a"')
    // 源包只被读：它的日志与目录都还在原样。
    expect(await readdir(path.join(env.packsRoot, 'pack-a', 'sessions', '--project--'))).toEqual(['session-a'])
    expect(await readFile(sourceLog, 'utf8')).toContain('"session-a"')
    // 与导出同一条规矩：最后一件必须是收口事件，否则界面横幅停在「已复制 1 个文件」。
    expect(events.at(-1)).toEqual({ kind: 'status', message: '' })
  })

  it('撤销删掉复制进来的文件并清掉清单；再撤销就找不到凭据', async () => {
    const env = await makeEnv()
    const manager = makeManager(env, [])
    await mkdir(path.join(env.packsRoot, 'pack-a'), { recursive: true })
    await mkdir(path.join(env.packsRoot, 'pack-b'), { recursive: true })
    await writeSession(path.join(env.packsRoot, 'pack-a'), '--project--', 'session-a', env.project)
    await upsertPackRecord(env.registryPath, record(env, 'pack-a', '旧包'))
    await upsertPackRecord(env.registryPath, record(env, 'pack-b', '新包'))

    const result = await manager.importSessionHistory('pack-a', 'pack-b')
    const landed = path.join(env.packsRoot, 'pack-b', 'sessions', '--project--', 'session-a', 'session.jsonl')
    expect(await readFile(landed, 'utf8')).toContain('session-a')

    expect(await manager.undoSessionImport(result.undoId)).toMatchObject({ removed: 1, kept: 0 })
    expect(await readdir(path.join(env.sessionImportsRoot))).toEqual([])
    await expect(manager.undoSessionImport(result.undoId)).rejects.toThrow('找不到这次导入的记录')
  })

  it('DSH 正在写日志时拒绝执行，也拒绝撤销', async () => {
    const env = await makeEnv()
    const manager = makeManager(env, [], true)
    await mkdir(path.join(env.packsRoot, 'pack-a'), { recursive: true })
    await writeSession(path.join(env.packsRoot, 'pack-a'), '--project--', 'session-a', env.project)
    await upsertPackRecord(env.registryPath, record(env, 'pack-a', '旧包'))
    await upsertPackRecord(env.registryPath, record(env, 'pack-b', '新包'))

    await expect(manager.importSessionHistory('pack-a', 'pack-b')).rejects.toThrow('DSH 运行时正在运行')
    await expect(manager.undoSessionImport('1700000000000')).rejects.toThrow('DSH 运行时正在运行')
    // 预览是只读的，运行中也允许（界面要能先给人看规模）。
    expect((await manager.previewSessionImport('pack-a', 'pack-b')).importableCount).toBe(1)
  })

  it('自己搬自己直接拒绝；撤销凭据只认数字', async () => {
    const env = await makeEnv()
    const manager = makeManager(env, [])
    await mkdir(path.join(env.packsRoot, 'pack-a'), { recursive: true })
    await upsertPackRecord(env.registryPath, record(env, 'pack-a', '旧包'))

    await expect(manager.previewSessionImport('pack-a', 'pack-a')).rejects.toThrow('源包和目标包是同一个')
    await expect(manager.undoSessionImport('../../packs')).rejects.toThrow('撤销凭据无效')
  })
})

/** 导出侧的隐私勾选走的是同一条"包与包之间搬运"的路，护栏也放一起测。 */
describe('整合包导出隐私勾选', () => {
  it('默认导出不带隐私也不留警告文件；勾了才有，且包内有勿转发警告', async () => {
    const env = await makeEnv()
    const manager = makeManager(env, [])
    const home = path.join(env.packsRoot, 'pack-a')
    await mkdir(home, { recursive: true })
    await writeSession(home, '--project--', 'session-a', env.project)
    await writeFile(path.join(home, '.credentials.yaml'), 'records:\n  ALI_API_KEY: secret-value\n', 'utf8')
    await writeFile(path.join(home, 'settings.yaml'), 'providers:\n  - name: ali\n    apiKey: sk-keep-me\n', 'utf8')
    await upsertPackRecord(env.registryPath, record(env, 'pack-a', '我的包'))

    const plainZip = path.join(env.root, 'plain.zip')
    await manager.exportPack('pack-a', {}, plainZip)
    const AdmZip = (await import('adm-zip')).default
    const plain = new AdmZip(plainZip).getEntries().map(entry => entry.entryName)
    expect(plain).not.toContain('sessions/--project--/session-a/session.jsonl')
    expect(plain).not.toContain('.credentials.yaml')
    expect(plain).not.toContain('_PRIVATE-DO-NOT-SHARE.txt')
    expect(new AdmZip(plainZip).getEntry('settings.yaml')!.getData().toString('utf8')).not.toContain('sk-keep-me')

    const privateZip = path.join(env.root, 'private.zip')
    await manager.exportPack('pack-a', { credentials: true, sessions: true }, privateZip)
    const archive = new AdmZip(privateZip)
    const entries = archive.getEntries().map(entry => entry.entryName)
    expect(entries).toContain('sessions/--project--/session-a/session.jsonl')
    expect(entries).toContain('.credentials.yaml')
    expect(entries).toContain('_PRIVATE-DO-NOT-SHARE.txt')
    expect(archive.getEntry('settings.yaml')!.getData().toString('utf8')).toContain('sk-keep-me')
    const warning = archive.getEntry('_PRIVATE-DO-NOT-SHARE.txt')!.getData().toString('utf8')
    expect(warning).toContain('API 密钥')
    expect(warning).toContain('会话记录')
    expect(warning).toContain('我的包')
  })
})

/** 升版副本（docs/adr/0002）：复制出新包认新版本，旧包一个字节都不改。 */
describe('整合包升版副本', () => {
  async function makeSourcePack(env: Awaited<ReturnType<typeof makeEnv>>, id = 'pack-a'): Promise<string> {
    const home = path.join(env.packsRoot, id)
    const profile = path.join(home, 'profiles', id)
    await mkdir(path.join(profile, 'node_modules', 'alpha'), { recursive: true })
    await writeFile(path.join(profile, 'profile.yaml'), `name: ${id}\ndshVersion: 0.1.5-rc.1\nsource:\n  kind: local\n`)
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: `dsh-profile-${id}`, private: true, dependencies: { alpha: 'file:./node_modules/alpha' } }))
    await writeFile(path.join(profile, 'node_modules', 'alpha', 'index.js'), 'module.exports = 1\n')
    await writeFile(path.join(home, 'settings.yaml'), 'pet:\n  petId: whale-girl\n')
    await writeSession(home, '--project--', 'session-a', env.project)
    await writeFile(path.join(home, '.credentials.yaml'), 'records:\n  ALI_API_KEY: secret-value\n')
    await upsertPackRecord(env.registryPath, record(env, id, id === 'pack-a' ? '旧包' : '新包'))
    return home
  }

  it('复制出的新包认新版本，旧包目录分毫未动', async () => {
    const env = await makeEnv()
    const manager = makeManager(env, [])
    const sourceHome = await makeSourcePack(env)
    const before = await readdir(sourceHome)

    const created = await manager.createVersionClone('pack-a', { dshVersion: '0.1.5-rc.2' })
    expect(created).toMatchObject({ name: '旧包 · DSH 0.1.5-rc.2', dshVersion: '0.1.5-rc.2' })
    // id 由名字经 packProfileName 派生（中文名会塌成一串 -），只要求它不与旧包同名。
    expect(created.id).not.toBe('pack-a')

    const newHome = path.join(env.packsRoot, created.id)
    const profileYaml = await readFile(path.join(newHome, 'profiles', created.id, 'profile.yaml'), 'utf8')
    expect(profileYaml).toContain(`name: ${created.id}`)
    expect(profileYaml).toContain('dshVersion: 0.1.5-rc.2')
    // 自己的东西要跟着走：凭据、聊天记录、插件本体都在。
    expect(await readFile(path.join(newHome, '.credentials.yaml'), 'utf8')).toContain('secret-value')
    expect(await readFile(path.join(newHome, 'sessions', '--project--', 'session-a', 'session.jsonl'), 'utf8')).toContain('session-a')
    expect(await readFile(path.join(newHome, 'profiles', created.id, 'node_modules', 'alpha', 'index.js'), 'utf8')).toContain('module.exports')
    // 登记表/投影缓存不搬：DSH 扫目录自建。
    expect(await existsDir(path.join(newHome, 'storages'))).toBe(false)
    // 旧包原样：目录名一个没多、profile.yaml 里还是老版本。
    expect(await readdir(sourceHome)).toEqual(before)
    expect(await readFile(path.join(sourceHome, 'profiles', 'pack-a', 'profile.yaml'), 'utf8')).toContain('dshVersion: 0.1.5-rc.1')
  })

  it('目标版本要先装好；装失败不留半个包也不写注册表', async () => {
    const env = await makeEnv()
    const events: PackProgressEvent[] = []
    let settings: AppSettings = {
      ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
      dshHome: path.join(env.root, 'dsh-home'),
      profileName: 'pack-a',
      activePackId: 'pack-a',
    }
    const attempts: string[] = []
    const manager = createPackManager({
      readSettings: async () => settings,
      saveSettings: async next => { settings = next; return next },
      readStoredSettings: async () => settings,
      registryPath: env.registryPath,
      snapshotRoot: path.join(env.root, 'pack-snapshots'),
      sessionImportsRoot: env.sessionImportsRoot,
      pluginReceiptsPath: path.join(env.root, 'plugin-installs.json'),
      presetReceiptsPath: path.join(env.root, 'preset-installs.json'),
      skillReceiptsPath: path.join(env.root, 'skill-installs.json'),
      applicationAddons: { list: async () => [], install: async () => ({}), uninstall: async () => [] },
      installer: { readProfile: async () => ({ initialized: true, profileDir: '', manifestPath: '', plugins: [], activeBundles: [], dependencyCount: 0, disabledCount: 0 }) } as never,
      emitEvent: event => events.push(event),
      emitOutput: () => {},
      isRuntimeRunning: () => false,
      isInstallerBusy: () => false,
      unifiedProfiles: true,
      packsRoot: env.packsRoot,
      ensureDshVersionInstalled: async version => { attempts.push(version); throw new Error(`DSH ${version} 安装失败`) },
    })
    await makeSourcePack(env)

    await expect(manager.createVersionClone('pack-a', { dshVersion: '9.9.9' })).rejects.toThrow('安装失败')
    expect(attempts).toEqual(['9.9.9'])
    const records = await import('../electron/pack-registry').then(module => module.readPackRegistry(env.registryPath))
    expect(records.map(item => item.id)).toEqual(['pack-a'])
    expect(await existsDir(path.join(env.packsRoot, 'pack-a-dsh-9-9-9'))).toBe(false)
    // 失败也要收口横幅（否则界面停在「正在准备 DSH 9.9.9」）。
    expect(events.at(-1)).toEqual({ kind: 'status', message: '' })
  })
})

async function existsDir(target: string): Promise<boolean> {
  return Boolean(await readdir(target).then(() => true).catch(() => false))
}
