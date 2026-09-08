import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isSafePackageName,
  isSafeProfileName,
  isSafeRepositoryName,
  readProfile,
  repositoryFullNameFromSpecifier,
  reorderPlugins,
  togglePlugin,
} from '../electron/profile'
import { recordPluginInstall } from '../electron/plugin-receipts'

let temporaryHome = ''
const profileName = 'web'

async function seedProfile(): Promise<string> {
  const profileDir = path.join(temporaryHome, 'profiles', profileName)
  await mkdir(path.join(profileDir, 'node_modules', '@demo', 'vision'), { recursive: true })
  await mkdir(path.join(profileDir, 'node_modules', '@demo', 'sidebar'), { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {
      '@demo/vision': 'github:demo/vision#abc123',
      '@demo/sidebar': '2.0.0',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@demo/vision'],
      },
    },
  }, null, 2))
  await writeFile(path.join(profileDir, 'node_modules', '@demo', 'vision', 'package.json'), JSON.stringify({
    name: '@demo/vision',
    version: '1.2.0',
    description: 'Vision tools',
    repository: { url: 'git+https://github.com/demo/vision.git' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(path.join(profileDir, 'node_modules', '@demo', 'sidebar', 'package.json'), JSON.stringify({
    name: '@demo/sidebar',
    version: '2.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(path.join(profileDir, 'node_modules', '@demo', 'vision', 'cordis.patch.yml'), '[]\n')
  await writeFile(path.join(profileDir, 'node_modules', '@demo', 'sidebar', 'cordis.patch.yml'), '[]\n')
  return profileDir
}

beforeEach(async () => {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-test-'))
})

afterEach(async () => {
  await rm(temporaryHome, { recursive: true, force: true })
})

describe('profile management', () => {
  it('reads active and inactive bundles from the official profile manifest', async () => {
    await seedProfile()
    const state = await readProfile(temporaryHome, profileName)

    expect(state.initialized).toBe(true)
    expect(state.activeBundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@demo/vision',
    ])
    expect(state.plugins.find(plugin => plugin.packageName === '@demo/vision')).toMatchObject({
      enabled: true,
      version: '1.2.0',
      repositoryFullName: 'demo/vision',
      compatible: true,
    })
    expect(state.plugins.find(plugin => plugin.packageName === '@demo/sidebar')).toMatchObject({
      enabled: false,
      compatible: true,
    })
  })

  it('toggles third-party plugins without removing their dependency', async () => {
    const profileDir = await seedProfile()
    const disabled = await togglePlugin(temporaryHome, profileName, '@demo/vision', false)
    expect(disabled.activeBundles).not.toContain('@demo/vision')
    expect(disabled.plugins.find(plugin => plugin.packageName === '@demo/vision')?.enabled).toBe(false)

    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@demo/vision']).toBe('github:demo/vision#abc123')

    const enabled = await togglePlugin(temporaryHome, profileName, '@demo/sidebar', true)
    expect(enabled.activeBundles.at(-1)).toBe('@demo/sidebar')
  })

  it('uses the install receipt when a local file dependency has no repository field', async () => {
    await seedProfile()
    const receiptPath = path.join(temporaryHome, 'plugin-installs.json')
    await recordPluginInstall(receiptPath, {
      repository: 'demo/sidebar',
      packageName: '@demo/sidebar',
      packId: profileName,
      source: 'archive-subdirectory',
      subdirectory: 'sidebar',
      version: '2.0.0',
      commit: 'abc123',
      installedAt: new Date().toISOString(),
    })

    const state = await readProfile(temporaryHome, profileName, receiptPath)
    expect(state.plugins.find(plugin => plugin.packageName === '@demo/sidebar')).toMatchObject({
      repositoryFullName: 'demo/sidebar',
      repository: 'https://github.com/demo/sidebar',
    })
  })

  it('persists an exact load order and protects core layers', async () => {
    await seedProfile()
    const reordered = await reorderPlugins(temporaryHome, profileName, [
      '@deepseek-ai/dsh-base',
      '@demo/vision',
      '@deepseek-ai/dsh-web-app',
    ])
    expect(reordered.activeBundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@demo/vision',
      '@deepseek-ai/dsh-web-app',
    ])
    await expect(togglePlugin(temporaryHome, profileName, '@deepseek-ai/dsh-base', false))
      .rejects.toThrow('核心组合层不能停用')
  })
})

describe('external input validation', () => {
  it('accepts normal names and rejects command-like input', () => {
    expect(isSafeProfileName('web-dev_2')).toBe(true)
    expect(isSafeProfileName('../web')).toBe(false)
    expect(isSafeRepositoryName('owner/dsh-plugin')).toBe(true)
    expect(isSafeRepositoryName('owner/repo && whoami')).toBe(false)
    expect(isSafePackageName('@scope/plugin-name')).toBe(true)
    expect(isSafePackageName('plugin; Remove-Item')).toBe(false)
  })

  it('recognizes GitHub dependency and codeload repository specifiers', () => {
    expect(repositoryFullNameFromSpecifier('github:anywhere-labs/deepseek-harness-desktop')).toBe('anywhere-labs/deepseek-harness-desktop')
    expect(repositoryFullNameFromSpecifier('https://codeload.github.com/Small-tailqwq/dsh-deep-whale/tar.gz/abc123')).toBe('Small-tailqwq/dsh-deep-whale')
    expect(repositoryFullNameFromSpecifier('git+https://github.com/demo/sidebar/tree/main/packages/plugin')).toBe('demo/sidebar')
    expect(repositoryFullNameFromSpecifier('1.2.0')).toBeUndefined()
  })
})
