import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildDshCoreOverrides, buildManagedDshInstallArgs, buildManagedDshPnpmArgs, createRuntimeVersionService, listAvailableDshVersions, MissingDshDependencyError, resolveDshCoreOverrides } from '../electron/runtime-versions'
import type { AppSettings } from '../src/types'
import type { NodeRuntime, PnpmRuntime } from '../electron/node-runtime'

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

})

/**
 * 回归锁：随包 pnpm 那轮删掉了「Node 可下载版本列表」的 fetch，`read()` 缓存门里那句
 * `|| nodeAvailable.length === 0` 必须一起去掉——那个字段再也不会被填，留着就等于
 * 每次读环境都判定缓存过期、重新拉一遍 DSH 版本列表（比删之前更频繁联网）。
 */
describe('运行环境读缓存', () => {
  function makeService(counter: { fetches: number }) {
    const dshRoot = path.join('C:', 'dsh-launcher-test', 'dsh-runtime')
    const settings = {
      dshInstallPath: dshRoot,
      dshHome: path.join('C:', 'dsh-launcher-test', 'home'),
      dshVersion: null,
      nodeVersion: null,
      profileName: 'web',
      // 指在 dshRoot 里，读环境时就不会去探测「系统 DSH」（那条分支要跑外部命令）。
      launchExecutable: path.join(dshRoot, 'node_modules', '.bin', 'dsh.cmd'),
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
    } as unknown as AppSettings
    const githubFetch: typeof fetch = async () => {
      counter.fetches += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2026-08-20T00:00:00.000Z' } }),
      } as Response
    }
    return createRuntimeVersionService({
      dshRoot,
      nodeRoot: path.join('C:', 'dsh-launcher-test', 'node-runtime'),
      readSettings: async () => settings,
      saveSettings: async next => next,
      prepareNodeRuntime: async () => { throw new Error('读环境列表不该准备 Node') },
      preparePnpmRuntime: async () => { throw new Error('读环境列表不该准备 pnpm') },
      isRuntimeRunning: () => false,
      emitOutput: () => {},
      emitProgress: () => {},
      githubFetch,
    })
  }

  it('连续两次 read() 只联网一次', async () => {
    const counter = { fetches: 0 }
    const service = makeService(counter)

    await service.read()
    expect(counter.fetches).toBeGreaterThan(0)
    const afterFirst = counter.fetches

    await service.read()
    expect(counter.fetches).toBe(afterFirst)

    // 显式 refresh 仍然要真的去刷。
    await service.read(true)
    expect(counter.fetches).toBe(afterFirst + 1)
  })
})

describe('DSH 版本安装的网络环境', () => {
  it('pnpm 安装带上用户镜像源与代理，不再默认打官方源', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-install-net-'))
    const versionRoot = path.join(root, 'versions', '0.1.7-rc.1')
    // 0.1.7 的依赖清单里有大体积二进制包，官方源在大陆网络下会超时；
    // 这条测试守的就是「安装链有没有把镜像源交给 pnpm」。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ versions: { '0.1.7-rc.1': {} }, 'dist-tags': { latest: '0.1.7-rc.1' }, time: {} }),
    })) as unknown as typeof fetch)

    const commands: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const settings = {
      dshInstallPath: root,
      dshHome: path.join(root, 'home'),
      dshVersion: '0.1.5-rc.2',
      nodeVersion: null,
      profileName: 'pack-a',
      activePackId: 'pack-a',
      launchExecutable: path.join(versionRoot, 'node_modules', '.bin', 'dsh.cmd'),
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
      network: { npmRegistry: 'https://mirror.test', proxy: 'http://127.0.0.1:7890' },
    } as unknown as AppSettings

    try {
      const service = createRuntimeVersionService({
        dshRoot: root,
        nodeRoot: path.join(root, 'node-runtime'),
        readSettings: async () => settings,
        saveSettings: async next => next,
        prepareNodeRuntime: async () => ({ root, node: path.join(root, 'node.exe'), npm: '', npx: '', managed: false }) as NodeRuntime,
        preparePnpmRuntime: async () => ({ root, executable: path.join(root, 'pnpm.cmd') }) as PnpmRuntime,
        isRuntimeRunning: () => false,
        emitOutput: () => {},
        emitProgress: () => {},
        githubFetch: async () => { throw new Error('本条测试不该联网读版本列表') },
        runCommand: async (_executable, args, options) => {
          commands.push({ args, env: (options.env ?? {}) as NodeJS.ProcessEnv })
          const bin = path.join(versionRoot, 'node_modules', '.bin')
          const pkg = path.join(versionRoot, 'node_modules', '@deepseek-ai', 'dsh')
          await mkdir(bin, { recursive: true })
          await mkdir(pkg, { recursive: true })
          await writeFile(path.join(bin, 'dsh.cmd'), '@echo off\r\n', 'utf8')
          await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' }), 'utf8')
          return { exitCode: 0, output: '' }
        },
      })

      await service.installDsh('0.1.7-rc.1')

      const install = commands.find(command => command.args[0] === 'add')
      expect(install?.args).toContain('@deepseek-ai/dsh@0.1.7-rc.1')
      expect(install?.env.npm_config_registry).toBe('https://mirror.test')
      expect(install?.env.NPM_CONFIG_REGISTRY).toBe('https://mirror.test')
      expect(install?.env.https_proxy).toBe('http://127.0.0.1:7890')
    } finally {
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })
})
