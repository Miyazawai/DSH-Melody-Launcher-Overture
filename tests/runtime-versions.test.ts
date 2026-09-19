import { describe, expect, it } from 'vitest'
import { buildDshCoreOverrides, buildManagedDshInstallArgs, buildManagedDshPnpmArgs, listAvailableDshVersions, MissingDshDependencyError, resolveDshCoreOverrides } from '../electron/runtime-versions'
import { listAvailableNodeVersions } from '../electron/node-runtime'

describe('runtime version indexes', () => {
  it('derives exact DSH core overrides from registry manifests', () => {
    expect(buildDshCoreOverrides('v0.1.1-rc.1', [
      {
        dependencies: {
          '@deepseek-ai/dsh-base': '^0.1.1-rc.1',
          '@deepseek-ai/dsh-web-app': '^0.1.1-rc.1',
          '@deepseek-ai/cordis': '^4.0.1',
          lodash: '^4.0.0',
        },
        peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.1-rc.1' },
      },
    ])).toEqual({
      '@deepseek-ai/dsh-base': '0.1.1-rc.1',
      '@deepseek-ai/dsh-web-app': '0.1.1-rc.1',
      '@deepseek-ai/dsh-tools': '0.1.1-rc.1',
    })
  })

  it('uses a lockfile, bounded registry retries, and deferred scripts for DSH installs', () => {
    expect(buildManagedDshInstallArgs('C:\\dsh\\versions\\0.1.1-rc.1', '0.1.1-rc.1')).toEqual([
      'install',
      '--prefix',
      'C:\\dsh\\versions\\0.1.1-rc.1',
      '--save-exact',
      '--package-lock=true',
      '--no-audit',
      '--no-fund',
      '--progress=true',
      '--loglevel=verbose',
      '--ignore-scripts',
      '--prefer-offline',
      '--fetch-timeout=30000',
      '--fetch-retries=1',
      '--fetch-retry-factor=2',
      '--fetch-retry-mintimeout=1000',
      '--fetch-retry-maxtimeout=10000',
      '@deepseek-ai/dsh@0.1.1-rc.1',
    ])
    expect(buildManagedDshPnpmArgs('C:\\dsh\\versions\\0.1.1-rc.1', 'v0.1.1-rc.1')).toEqual([
      'add',
      '--dir',
      'C:\\dsh\\versions\\0.1.1-rc.1',
      '--save-exact',
      '--lockfile=true',
      '--ignore-scripts',
      '--reporter=append-only',
      '--fetch-timeout=30000',
      '--fetch-retries=1',
      '@deepseek-ai/dsh@0.1.1-rc.1',
    ])
  })

  it('fails before pnpm when a DSH core dependency is not published', async () => {
    const fetchImpl: typeof fetch = async input => {
      const url = String(input)
      if (url.toLowerCase().includes('%2fdsh-tasks-local/')) return { ok: false, status: 404 } as Response
      return {
        ok: true,
        status: 200,
        json: async () => ({ dependencies: { '@deepseek-ai/dsh-tasks-local': '0.0.1-rc.1' } }),
      } as Response
    }

    await expect(resolveDshCoreOverrides('0.0.1-rc.1', fetchImpl)).rejects.toBeInstanceOf(MissingDshDependencyError)
    await expect(resolveDshCoreOverrides('0.0.1-rc.1', fetchImpl)).rejects.toThrow('@deepseek-ai/dsh-tasks-local')
  })

  it('keeps DSH versions semver ordered and marks npm dist tags', async () => {
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        versions: {
          '1.0.0': {},
          '1.0.0-rc.9': {},
          '1.0.0-rc.10': {},
          '0.9.0': {},
          invalid: {},
        },
        'dist-tags': { latest: '1.0.0', next: '1.0.0-rc.10' },
        time: { '1.0.0': '2026-08-20T00:00:00.000Z' },
      }),
    } as Response)

    const candidates = await listAvailableDshVersions(fetchImpl)

    expect(candidates.map(item => item.version)).toEqual(['1.0.0', '1.0.0-rc.10', '1.0.0-rc.9', '0.9.0'])
    expect(candidates[0]?.label).toBe('latest')
    expect(candidates[1]?.label).toBe('next')
    // 有正式版时它是推荐安装版本，同时也是版本号最高者。
    expect(candidates[0]?.isNewest).toBe(true)
    expect(candidates[0]?.recommended).toBe(true)
    expect(candidates.filter(item => item.isNewest)).toHaveLength(1)
    expect(candidates.filter(item => item.recommended)).toHaveLength(1)
  })

  it('可下载列表按渠道口径带回最新版与推荐版本标记', async () => {
    // 上游真实形态：latest 停在旧的 rc.1，rc.2 只打了 next，版本号最高的是 alpha。
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        versions: { '0.1.6-alpha.1': {}, '0.1.5-rc.2': {}, '0.1.5-rc.1': {} },
        'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.1' },
      }),
    } as Response)

    const candidates = await listAvailableDshVersions(fetchImpl, ['https://registry.npmmirror.com'])

    expect(candidates.find(item => item.isNewest)?.version).toBe('0.1.6-alpha.1')
    expect(candidates.find(item => item.recommended)?.version).toBe('0.1.5-rc.2')
    expect(candidates.some(item => item.version === '0.1.5-rc.1' && item.label === 'latest')).toBe(true)
  })

  it('镜像失败时回退下一个 registry，全部失败才抛错', async () => {
    const packument = { versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } }
    const urls: string[] = []
    const fetchImpl: typeof fetch = async input => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('https://registry.npmjs.org')) {
        return { ok: true, status: 200, json: async () => packument } as Response
      }
      return { ok: false, status: 404 } as Response
    }
    const candidates = await listAvailableDshVersions(fetchImpl, ['https://registry.npmmirror.com', 'https://registry.npmjs.org'])
    expect(candidates.map(item => item.version)).toEqual(['1.0.0'])
    expect(urls).toHaveLength(2)

    const allFail: typeof fetch = async () => ({ ok: false, status: 503 } as Response)
    await expect(listAvailableDshVersions(allFail, ['https://a.example', 'https://b.example'])).rejects.toThrow('HTTP 503')
  })

  it('normalizes Node.js index entries and identifies prereleases', async () => {
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { version: 'v24.19.0', date: '2026-08-20', lts: 'Krypton' },
        { version: 'v25.0.0-nightly20260820', date: '2026-08-20', lts: false },
      ],
    } as Response)

    await expect(listAvailableNodeVersions(fetchImpl)).resolves.toEqual([
      { version: 'v24.19.0', label: 'Krypton', lts: 'Krypton', date: '2026-08-20', prerelease: false },
      { version: 'v25.0.0-nightly20260820', label: null, lts: false, date: '2026-08-20', prerelease: true },
    ])
  })
})
