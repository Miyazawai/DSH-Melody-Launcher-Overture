import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeSnapshotZip,
  extractSnapshot,
  isSnapshotExcluded,
  lockfileHasAbsoluteFileSpecs,
  mapSnapshotPath,
  planSnapshot,
  sanitizeNpmrc,
  sanitizeProfileYaml,
  sanitizeSettingsYaml,
  writeSnapshotZip,
} from '../electron/pack-snapshot'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'dsh-snapshot-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

describe('快照剔除规则', () => {
  it('个人数据与机器相关文件不进包，配置与资源进包', () => {
    for (const rel of [
      '.credentials.yaml',
      '.anonymous-user-id',
      'sessions/abc/session.json',
      'dsh-session-archive/a.json',
      'dsh-usage/provider-snapshots.json',
      'task-board/ledger-v2.json',
      'attachments/pic.png',
      'storages/workspace.json',
      '.dsh-module-fallback/node_modules/alpha',
      '.skill-staging/x',
      '.pack-offline-import/pack/x',
      'dsh-restart.log',
      'profiles/pack-a/node_modules/.modules.yaml',
      'profiles/pack-a/node_modules/.pnpm-workspace-state-v1.json',
      'profiles/pack-a/node_modules/.package-map.json',
      'profiles/node_modules/.modules.yaml',
      'profiles/pack-a/.dsh-module-fallback/node_modules/alpha',
      // 桌宠好感度/投喂记录：个人游玩数据
      'pet.json',
      // 壁纸引擎令牌缓存：随包公开等于泄露机主凭据
      'skin-center/wallpapers/.cache',
      'skin-center/wallpapers/.cache/we-tokens.json',
    ]) {
      expect(isSnapshotExcluded(rel), rel).toBe(true)
    }
    for (const rel of [
      'settings.yaml',
      'skin-center/wallpapers/a.png',
      'skin-center/wallpapers/my-wallpaper/project/index.html',
      'skin-center-active.json',
      'skills/find-skills/SKILL.md',
      '.agent-presets/writer/preset.yaml',
      'profiles/pack-a/package.json',
      'profiles/pack-a/pnpm-lock.yaml',
      'profiles/pack-a/profile.yaml',
      'profiles/pack-a/node_modules/alpha/index.js',
    ]) {
      expect(isSnapshotExcluded(rel), rel).toBe(false)
    }
  })
})

describe('配置净化', () => {
  it('settings.yaml 去掉 onboarding 与密钥键，保留插件/模型/外观配置', () => {
    const text = [
      'ui-onboarding:',
      '  welcomeNoticeVersion: 1',
      'pet:',
      '  petId: whale-girl',
      'llm-pi-ai:',
      '  providers:',
      '    sensenova:',
      '      apiKeyEnv: SENSENOVA_API_KEY',
      '      apiKey: sk-should-not-leak',
      '      baseURL: https://api.example.com',
      'agent-default-model:',
      '  provider: ali',
      '  model: deepseek-v4-flash',
      'permission:',
      '  defaultPreset: danger-full-access',
    ].join('\n')
    const next = sanitizeSettingsYaml(text)
    expect(next).not.toContain('ui-onboarding')
    expect(next).not.toContain('sk-should-not-leak')
    expect(next).toContain('apiKeyEnv: SENSENOVA_API_KEY')
    expect(next).toContain('whale-girl')
    expect(next).toContain('danger-full-access')
    expect(next).toContain('deepseek-v4-flash')
  })

  it('.npmrc 去掉 store 路径与凭据，保留 registry', () => {
    const next = sanitizeNpmrc(['registry=https://registry.npmmirror.com', 'store-dir=C:\\Users\\x\\plugin-store', '//npm.example.com/:_authToken=secret', '//npm.example.com/:_password=abc'].join('\n'))
    expect(next).toContain('registry=https://registry.npmmirror.com')
    expect(next).not.toContain('store-dir')
    expect(next).not.toContain('secret')
    expect(next).not.toContain('_password')
  })

  it('profile.yaml 去掉机器相关字段并改写 name', () => {
    const next = sanitizeProfileYaml(['name: pack-a', 'description: hi', 'dshVersion: 0.1.2-rc.1', 'source:', '  kind: local', '  path: C:\\Users\\x', 'exportedAt: 2026-01-01'].join('\n'), 'pack-b')
    expect(next).toContain('name: pack-b')
    expect(next).not.toContain('C:\\Users\\x')
    expect(next).toContain('dshVersion: 0.1.2-rc.1')
  })

  it('lockfile 绝对 file: 记录会被识别', () => {
    expect(lockfileHasAbsoluteFileSpecs("specifier: file:C:/dsh-import-bodies/body-abc")).toBe(true)
    expect(lockfileHasAbsoluteFileSpecs('specifier: file:./.dsh-launcher-plugin-bodies/alpha')).toBe(false)
    expect(lockfileHasAbsoluteFileSpecs('specifier: ^0.3.17')).toBe(false)
  })
})

describe('路径映射', () => {
  it('profiles/<源id> 整体映射到新 id', () => {
    expect(mapSnapshotPath('profiles/pack-a/package.json', 'pack-a', 'pack-b')).toBe('profiles/pack-b/package.json')
    expect(mapSnapshotPath('profiles/pack-a', 'pack-a', 'pack-b')).toBe('profiles/pack-b')
    expect(mapSnapshotPath('settings.yaml', 'pack-a', 'pack-b')).toBe('settings.yaml')
    expect(mapSnapshotPath('profiles/pack-other/x', 'pack-a', 'pack-b')).toBe('profiles/pack-other/x')
  })
})

describe('快照导出 / 导入闭环', () => {
  async function makeHome(): Promise<string> {
    const home = await temporaryDirectory('dsh-snapshot-home-')
    await mkdir(path.join(home, 'profiles', 'pack-a', 'node_modules', 'alpha'), { recursive: true })
    await mkdir(path.join(home, 'skills', 'my-skill'), { recursive: true })
    await mkdir(path.join(home, 'sessions', 'abc'), { recursive: true })
    await mkdir(path.join(home, 'skin-center', 'wallpapers'), { recursive: true })
    // 官方预设包形态：包自带 officecli 二进制，必须原样随快照搬运。
    await mkdir(path.join(home, 'tools', 'officecli'), { recursive: true })
    await writeFile(path.join(home, 'tools', 'officecli', 'officecli.exe'), 'MZ-fake-binary')
    await writeFile(path.join(home, '.credentials.yaml'), 'records:\n  ALI_API_KEY: secret\n')
    await writeFile(path.join(home, 'sessions', 'abc', 'session.json'), '{"secret":true}')
    await writeFile(path.join(home, 'settings.yaml'), 'ui-onboarding:\n  v: 1\npet:\n  petId: whale-girl\n')
    await writeFile(path.join(home, 'skin-center', 'wallpapers', 'a.png'), 'png')
    await writeFile(path.join(home, 'skills', 'my-skill', 'SKILL.md'), '# skill')
    await writeFile(path.join(home, 'profiles', 'pack-a', 'profile.yaml'), 'name: pack-a\ndshVersion: 0.1.2-rc.1\nsource:\n  kind: local\n  path: C:\\old\n')
    await writeFile(path.join(home, 'profiles', 'pack-a', 'package.json'), JSON.stringify({
      name: 'dsh-profile-pack-a',
      private: true,
      dependencies: { alpha: 'file:C:/dsh-import-bodies/body-abc123' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha'] } },
    }, null, 2))
    await writeFile(path.join(home, 'profiles', 'pack-a', 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha:\n        specifier: file:C:/dsh-import-bodies/body-abc123\n")
    await writeFile(path.join(home, 'profiles', 'pack-a', '.npmrc'), 'registry=https://registry.npmmirror.com\nstore-dir=C:\\Users\\x\\plugin-store\n')
    await writeFile(path.join(home, 'profiles', 'pack-a', 'node_modules', 'alpha', 'package.json'), '{"name":"alpha","version":"1.2.3"}')
    await writeFile(path.join(home, 'profiles', 'pack-a', 'node_modules', 'alpha', 'index.js'), 'module.exports = 1\n')
    // 包内符号链接（隔离布局的形态）：应记入 links 并在导入端重建。
    const linkTarget = path.join(home, 'profiles', 'pack-a', 'node_modules', 'alpha')
    const linkPath = path.join(home, 'profiles', 'pack-a', 'node_modules', 'alpha-link')
    await symlink(linkTarget, linkPath, 'junction').catch(() => undefined)
    return home
  }

  async function makeExternalBody(): Promise<string> {
    const body = await temporaryDirectory('dsh-snapshot-body-')
    await writeFile(path.join(body, 'package.json'), '{"name":"alpha","version":"1.2.3"}')
    await writeFile(path.join(body, 'index.js'), 'module.exports = 2\n')
    return body
  }

  it('导出不含个人数据/绝对路径，导入后能重建环境与链接', async () => {
    const home = await makeHome()
    const externalBody = await makeExternalBody()
    // 让 file: 指向包外的真实本体，验证本体被收进包内并相对化。
    await writeFile(path.join(home, 'profiles', 'pack-a', 'package.json'), JSON.stringify({
      name: 'dsh-profile-pack-a',
      private: true,
      dependencies: { alpha: `file:${externalBody.replace(/\\/g, '/')}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha'] } },
    }, null, 2))

    const plan = await planSnapshot(home, { packId: 'pack-a' })
    const zipPath = path.join(await temporaryDirectory('dsh-snapshot-out-'), 'pack-a.zip')
    const progress: Array<[number, number]> = []
    await writeSnapshotZip(plan, zipPath, { onProgress: (written, total) => progress.push([written, total]) })
    // 进度按真实读取字节上报：结束时必须报满，且总字节数大于 0。
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1])
    expect(progress.at(-1)?.[1]).toBeGreaterThan(0)

    const entries = new AdmZip(zipPath).getEntries().map(entry => entry.entryName)
    expect(entries).toContain('dsh-snapshot.json')
    expect(entries).toContain('settings.yaml')
    expect(entries).toContain('profiles/pack-a/package.json')
    expect(entries).toContain('profiles/pack-a/node_modules/alpha/index.js')
    expect(entries).toContain('profiles/pack-a/.dsh-launcher-plugin-bodies/alpha/index.js')
    expect(entries).toContain('skin-center/wallpapers/a.png')
    expect(entries).toContain('tools/officecli/officecli.exe')
    // 个人数据一个都不在。
    expect(entries.some(name => name.startsWith('sessions/'))).toBe(false)
    expect(entries).not.toContain('.credentials.yaml')
    // 绝对路径与机器相关文件都不在。
    expect(entries).not.toContain('profiles/pack-a/pnpm-lock.yaml')
    expect(entries).not.toContain('profiles/pack-a/node_modules/.modules.yaml')

    const archive = new AdmZip(zipPath)
    const packageJson = archive.getEntry('profiles/pack-a/package.json')!.getData().toString('utf8')
    expect(packageJson).toContain('file:./.dsh-launcher-plugin-bodies/alpha')
    expect(packageJson).not.toContain('dsh-import-bodies')
    expect(packageJson).not.toContain(externalBody.replace(/\\/g, '/'))
    const settings = archive.getEntry('settings.yaml')!.getData().toString('utf8')
    expect(settings).not.toContain('ui-onboarding')
    expect(settings).toContain('whale-girl')
    const profileYaml = archive.getEntry('profiles/pack-a/profile.yaml')!.getData().toString('utf8')
    expect(profileYaml).not.toContain('C:\\old')
    const meta = JSON.parse(archive.getEntry('dsh-snapshot.json')!.getData().toString('utf8')) as { links: Array<{ path: string; target: string }> }
    expect(meta.links.map(link => link.path)).toContain('profiles/pack-a/node_modules/alpha-link')

    // 预览：不解压整包即可读出源包 id 与 DSH 版本。
    const description = await describeSnapshotZip(zipPath)
    expect(description?.profileId).toBe('pack-a')
    expect(description?.dshVersion).toBe('0.1.2-rc.1')
    expect(description?.pluginNames).toEqual(['alpha'])
    // 导入到新家目录：id 改名 + 结构重建。
    const target = await temporaryDirectory('dsh-snapshot-import-')
    const result = await extractSnapshot(zipPath, target, { newId: 'pack-b' })
    expect(result.profileId).toBe('pack-b')
    expect(existsSync(path.join(target, 'profiles', 'pack-b', 'node_modules', 'alpha', 'index.js'))).toBe(true)
    expect(existsSync(path.join(target, 'profiles', 'pack-b', '.dsh-launcher-plugin-bodies', 'alpha', 'index.js'))).toBe(true)
    expect(existsSync(path.join(target, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
    // 包自带工具原样落地（官方预设包「导入即用」的硬承诺）。
    expect((await readFile(path.join(target, 'tools', 'officecli', 'officecli.exe'))).toString('utf8')).toBe('MZ-fake-binary')
    expect(existsSync(path.join(target, 'sessions'))).toBe(false)
    expect(existsSync(path.join(target, '.credentials.yaml'))).toBe(false)
    expect(existsSync(path.join(target, 'profiles', 'pack-a'))).toBe(false)
    const importedPackage = JSON.parse(await readFile(path.join(target, 'profiles', 'pack-b', 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> }
    expect(importedPackage.name).toBe('dsh-profile-pack-b')
    expect(importedPackage.dependencies.alpha).toBe('file:./.dsh-launcher-plugin-bodies/alpha')
    const importedProfileYaml = await readFile(path.join(target, 'profiles', 'pack-b', 'profile.yaml'), 'utf8')
    expect(importedProfileYaml).toContain('name: pack-b')
    // 符号链接被重建（junction 或实体副本都算成功）。
    expect(existsSync(path.join(target, 'profiles', 'pack-b', 'node_modules', 'alpha-link', 'package.json'))).toBe(true)
  })

  it('profiles/node_modules 是 workspace 级目录，不会被当成整合包 Profile', async () => {
    const root = await temporaryDirectory('dsh-snapshot-ws-')
    const zipPath = path.join(root, 'ws.zip')
    const archive = new AdmZip()
    archive.addFile('profiles/node_modules/.bin/dsh', Buffer.from('shim'))
    archive.addFile('profiles/node_modules/pnpm-workspace.yaml', Buffer.from('packages:\n  - .\n'))
    archive.addFile('profiles/pack-a/profile.yaml', Buffer.from('name: pack-a\ndshVersion: 0.1.2-rc.1\n'))
    archive.addFile('profiles/pack-a/package.json', Buffer.from('{"name":"dsh-profile-pack-a","dependencies":{"alpha":"file:./.dsh-launcher-plugin-bodies/alpha"}}'))
    archive.writeZip(zipPath)
    const description = await describeSnapshotZip(zipPath)
    expect(description?.profileId).toBe('pack-a')
    expect(description?.dshVersion).toBe('0.1.2-rc.1')
  })

  it('本体已不在磁盘时保留原 spec 并给出警告', async () => {    const home = await temporaryDirectory('dsh-snapshot-home2-')
    await mkdir(path.join(home, 'profiles', 'pack-a'), { recursive: true })
    await writeFile(path.join(home, 'profiles', 'pack-a', 'package.json'), JSON.stringify({
      name: 'dsh-profile-pack-a',
      dependencies: { ghost: 'file:C:/gone/body-zzz' },
    }))
    const plan = await planSnapshot(home, { packId: 'pack-a' })
    expect(plan.warnings.join('\n')).toContain('ghost')
    expect(plan.entries.find(entry => entry.rel === 'profiles/pack-a/package.json')).toBeTruthy()
  })
})
