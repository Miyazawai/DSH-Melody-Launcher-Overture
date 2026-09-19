import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Installer } from '../electron/installer'
import { createRecommendedWebUiService, RECOMMENDED_WEB_UI_PACKAGE } from '../electron/recommended-web-ui'
import type { AppSettings } from '../src/types'

async function tempProfile(): Promise<{ root: string; dshHome: string; profileDir: string; manifestPath: string; settings: AppSettings }> {
  const root = await mkdtemp(path.join(tmpdir(), 'recommended-webui-'))
  const dshHome = path.join(root, 'dsh-home')
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const manifestPath = path.join(profileDir, 'package.json')
  await mkdir(profileDir, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'some-plugin'] } },
  }, null, 2)}\n`, 'utf8')
  return {
    root,
    dshHome,
    profileDir,
    manifestPath,
    settings: {
      dshInstallPath: path.join(root, 'dsh-runtime'),
      dshHome,
      profileName: 'web',
      workspace: root,
      launchExecutable: 'dsh.cmd',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
    },
  }
}

describe('recommended web ui service', () => {
  it('reports not installed before any action', async () => {
    const { root, dshHome, settings } = await tempProfile()
    const service = createRecommendedWebUiService({
      readSettings: async () => settings,
      installer: {} as unknown as Installer,
    })
    await expect(service.status()).resolves.toEqual({ installed: false, enabled: false })
    await rm(root, { recursive: true, force: true })
  })

  it('installs latest, enables the bundle, suspends other plugins and sets the stock skin', async () => {
    const { root, dshHome, profileDir, manifestPath, settings } = await tempProfile()
    const installNpmPackage = vi.fn(async (request: { packageName: string; version?: string }) => {
      expect(request.packageName).toBe(RECOMMENDED_WEB_UI_PACKAGE)
      expect(request.version).toBe('latest')
      // 模拟 dsh plugin add 的效果：写入依赖 + 进入 bundles。
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [RECOMMENDED_WEB_UI_PACKAGE]: 'latest' }
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...(manifest.dsh?.profile?.bundles ?? []), RECOMMENDED_WEB_UI_PACKAGE] } }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      return { kind: 'plugin', profile: null, settings: null, dshInstallation: null, installedProfileName: 'web', packageName: RECOMMENDED_WEB_UI_PACKAGE }
    }) as unknown as Installer['installNpmPackage']

    const service = createRecommendedWebUiService({
      readSettings: async () => settings,
      installer: { installNpmPackage } as unknown as Installer,
    })

    // 老用户路径：停用其它插件（some-plugin 应被移出 bundles）。
    await service.ensureInstall({ suspendOthers: true })

    expect(installNpmPackage).toHaveBeenCalledTimes(1)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', RECOMMENDED_WEB_UI_PACKAGE])
    const skin = JSON.parse(await readFile(path.join(dshHome, 'skin-center-active.json'), 'utf8')) as { active?: unknown }
    // 原生外观 = active: null（插件文档标注的 "stock look"）+ initialized: true
    // —— 两个条件一起堵住 seedDefaultActiveSkin 的强写作者皮肤分支。
    expect(skin).toEqual({ active: null, initialized: true })
    await expect(service.status()).resolves.toEqual({ installed: true, enabled: true })
    await rm(root, { recursive: true, force: true })
  })

  it('keeps other plugins enabled when not suspending', async () => {
    const { root, manifestPath, settings } = await tempProfile()
    const installNpmPackage = vi.fn(async () => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [RECOMMENDED_WEB_UI_PACKAGE]: 'latest' }
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...(manifest.dsh?.profile?.bundles ?? []), RECOMMENDED_WEB_UI_PACKAGE] } }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      return { kind: 'plugin', profile: null, settings: null, dshInstallation: null, installedProfileName: 'web', packageName: RECOMMENDED_WEB_UI_PACKAGE }
    }) as unknown as Installer['installNpmPackage']

    const service = createRecommendedWebUiService({
      readSettings: async () => settings,
      installer: { installNpmPackage } as unknown as Installer,
    })
    await service.ensureInstall({ suspendOthers: false })

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    expect(manifest.dsh?.profile?.bundles).toContain('some-plugin')
    expect(manifest.dsh?.profile?.bundles).toContain(RECOMMENDED_WEB_UI_PACKAGE)
    await rm(root, { recursive: true, force: true })
  })
})