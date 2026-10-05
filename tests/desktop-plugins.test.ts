import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandOptions } from '../electron/command'
import { createDesktopPluginsService, desktopPluginSpecifier } from '../electron/desktop-plugins'
import { readProfile } from '../electron/profile'
import type { AppSettings, ManagedPlugin } from '../src/types'

vi.mock('../electron/profile', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/profile')>()
  return { ...actual, readProfile: vi.fn() }
})
// 镜像值来自 buildNetworkEnvironment，而它会触发一次系统代理探测（真起 reg.exe）。
// 测试里要的是确定性，不是真探测。
vi.mock('../electron/proxy', () => ({
  buildNetworkEnvironment: () => ({ proxy: {}, npmRegistry: 'https://registry.npmmirror.com' }),
}))

let root = ''
let dshHome = ''
let settings: AppSettings
let calls: Array<{ executable: string; args: string[]; options: CommandOptions }>

const plugin = (packageName: string, repositoryFullName?: string): ManagedPlugin => ({
  packageName,
  displayName: packageName,
  version: '1.0.0',
  description: '',
  enabled: true,
  builtin: false,
  locked: false,
  compatible: true,
  order: 1,
  ...(repositoryFullName ? { repositoryFullName } : {}),
})

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-plugins-'))
  dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles', 'desktop'), { recursive: true })
  calls = []
  settings = {
    dshInstallPath: path.join(root, 'runtime'),
    dshHome,
    profileName: 'web',
    workspace: root,
    launchExecutable: 'dsh.cmd',
    launchArgs: ['web'],
    webPort: 3080,
    openAfterLaunch: true,
  }
  vi.resetAllMocks()
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function harness(options: {
  installed?: boolean
  exitCode?: number
  plugins?: ManagedPlugin[]
} = {}) {
  const { installed = true, exitCode = 0, plugins = [] } = options
  vi.mocked(readProfile).mockResolvedValue({
    initialized: true,
    profileDir: path.join(dshHome, 'profiles', 'desktop'),
    manifestPath: path.join(dshHome, 'profiles', 'desktop', 'package.json'),
    plugins,
    activeBundles: plugins.map(item => item.packageName),
    dependencyCount: plugins.length,
    disabledCount: 0,
  })
  const service = createDesktopPluginsService({
    readStoredSettings: async () => settings,
    emitOutput: () => {},
    journalRoot: path.join(root, 'journal'),
    detectClient: async () => (installed ? {
      root: path.join(root, 'DeepSeek Harness'),
      executable: path.join(root, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      cli: path.join(root, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      desktopVersion: '0.2.0-rc.2',
      nodeVersion: '24.21.0',
      pnpmVersion: '11.7.0',
    } : null),
    runCommand: async (executable, args, commandOptions) => {
      calls.push({ executable, args, options: commandOptions })
      return { exitCode, output: exitCode === 0 ? '' : 'npm ERR! 404 Not Found' }
    },
  })
  return service
}

describe('桌面端插件：只走它自带的命令', () => {
  it('拼出的是它的 cli + plugin --profile desktop add', async () => {
    const service = harness({ plugins: [plugin('demo-plugin')] })

    await service.install({ kind: 'npm', name: 'demo-plugin', version: '1.2.3' })

    const add = calls.find(call => call.args.includes('add'))
    expect(add?.args).toEqual(['plugin', '--profile', 'desktop', 'add', 'demo-plugin@1.2.3'])
    expect(add?.executable).toContain(path.join('resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    // 我们自己的 npx / --yes @deepseek-ai/dsh 那套前缀绝不能出现在这条链路上。
    expect(add?.executable).not.toBe('dsh.cmd')
    expect(add?.args).not.toContain('--yes')
  })

  it('工作目录与 DSH_HOME 都落在默认家目录下的 desktop profile', async () => {
    // 服务只拿得到 readStoredSettings（未派生的那份），所以它不可能跟着激活包漂移。
    const service = harness({ plugins: [plugin('demo-plugin')] })
    await service.install({ kind: 'npm', name: 'demo-plugin' })
    expect(calls[0]?.options.env?.DSH_HOME).toBe(dshHome)
    expect(calls[0]?.options.cwd).toBe(path.join(dshHome, 'profiles', 'desktop'))
  })

  it('GitHub 来源拼成 github:owner/repo', async () => {
    const service = harness({ plugins: [plugin('demo-plugin', 'owner/repo')] })
    await service.install({ kind: 'github', name: 'owner/repo' })
    expect(calls.find(call => call.args.includes('add'))?.args.at(-1)).toBe('github:owner/repo')
  })

  it('命令返回 0 但它的列表里没有这个插件时，判失败而不是假装装好', async () => {
    const service = harness({ plugins: [] })
    await expect(service.install({ kind: 'npm', name: 'demo-plugin' })).rejects.toThrow(/列表里没有/)
  })

  it('卸载同样回读确认；还在列表里就报错', async () => {
    const stillThere = harness({ plugins: [plugin('demo-plugin')] })
    await expect(stillThere.uninstall('demo-plugin')).rejects.toThrow(/还在它的列表里/)

    const gone = harness({ plugins: [] })
    await gone.uninstall('demo-plugin')
    expect(calls.find(call => call.args.includes('remove'))?.args).toEqual(['plugin', '--profile', 'desktop', 'remove', 'demo-plugin'])
  })

  it('非零退出码把它的输出尾巴带出来', async () => {
    const service = harness({ exitCode: 1, plugins: [plugin('demo-plugin')] })
    await expect(service.install({ kind: 'npm', name: 'demo-plugin' })).rejects.toThrow(/404 Not Found/)
  })

  it('没装桌面端时：状态说没装，任何写操作都不发起命令', async () => {
    const service = harness({ installed: false })
    expect(await service.status()).toEqual({ installed: false })
    await expect(service.install({ kind: 'npm', name: 'demo-plugin' })).rejects.toThrow(/没有检测到/)
    expect(calls).toEqual([])
  })

  it('不安全的名字在起子进程之前就被拒', async () => {
    const service = harness()
    await expect(service.install({ kind: 'npm', name: 'bad package' })).rejects.toThrow(/名称无效/)
    await expect(service.install({ kind: 'github', name: 'owner/repo/extra' })).rejects.toThrow(/仓库名称无效/)
    await expect(service.uninstall('rm -rf /')).rejects.toThrow(/名称无效/)
    expect(calls).toEqual([])
  })

  it('同一时刻只允许一个桌面端操作', async () => {
    const service = harness({ plugins: [plugin('demo-plugin')] })
    const first = service.install({ kind: 'npm', name: 'demo-plugin' })
    await expect(service.install({ kind: 'npm', name: 'other-plugin' })).rejects.toThrow(/正在安装插件/)
    await first
  })

  it('状态里只列它自己装的外部插件，核心 bundle 不出现', async () => {
    const service = harness({ plugins: [plugin('demo-plugin')] })
    vi.mocked(readProfile).mockResolvedValueOnce({
      initialized: true,
      profileDir: '',
      manifestPath: '',
      plugins: [
        { ...plugin('@deepseek-ai/dsh-base'), builtin: true },
        plugin('demo-plugin'),
      ],
      activeBundles: [],
      dependencyCount: 1,
      disabledCount: 0,
    })
    const status = await service.status()
    expect(status.installed).toBe(true)
    expect(status.plugins?.map(item => item.packageName)).toEqual(['demo-plugin'])
    expect(status.pluginCount).toBe(1)
    expect(status.mirrorRegistry).toBe('https://registry.npmmirror.com')
  })
})

describe('桌面端参数拼接', () => {
  it('版本必须像版本号，且长度受限', () => {
    expect(desktopPluginSpecifier({ kind: 'npm', name: 'a-b' })).toBe('a-b')
    expect(desktopPluginSpecifier({ kind: 'npm', name: 'a-b', version: '0.1.7-rc.1' })).toBe('a-b@0.1.7-rc.1')
    expect(() => desktopPluginSpecifier({ kind: 'npm', name: 'a-b', version: '1.0 latest' })).toThrow(/版本格式无效/)
    expect(() => desktopPluginSpecifier({ kind: 'npm', name: 'a-b', version: '-x' })).toThrow(/版本格式无效/)
  })
})
