import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MIN_NODE_VERSION,
  NODE_RUNTIME_VERSION,
  PNPM_VERSION,
  downloadVerifiedNodeArchive,
  ensureNodeRuntime,
  ensurePnpmRuntime,
  findManagedNodeRuntime,
  findManagedNodeRuntimes,
  findSystemNodeRuntime,
  managedNodeVersionRoot,
  managedPnpmInstallArgs,
  nodeArchiveBaseUrls,
  nodeArchiveName,
  nodeChecksumBaseUrls,
  nodeVersionAtLeast,
  parseNodeArchiveChecksum,
  pnpmExecutable,
  requiresNodeRuntime,
  resolveNodeExecutable,
  type NodeRuntime,
} from '../electron/node-runtime'
import { npmRegistryCandidates } from '../electron/proxy'

/** 当前平台上 node / npm / npx 的可执行文件名。 */
const EXECUTABLES = process.platform === 'win32'
  ? ['node.exe', 'npm.cmd', 'npx.cmd']
  : ['node', 'npm', 'npx']

/**
 * POSIX 的官方发行包把可执行文件放在 bin/ 下，Windows 的 zip 直接平铺在根目录。
 * 测试要按各自平台的真实布局造目录，否则测不出东西。
 */
const DISTRIBUTION_BIN = process.platform === 'win32' ? '.' : 'bin'

let temporaryDirectory = ''

async function makeTemporaryDirectory(): Promise<string> {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-node-runtime-'))
  return temporaryDirectory
}

async function createExecutables(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const name of EXECUTABLES) {
    await writeFile(path.join(directory, name), '', 'utf8')
  }
}

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('node runtime', () => {
  it('selects the official Windows archive for the current architecture', () => {
    expect(nodeArchiveName('x64')).toBe(`node-${NODE_RUNTIME_VERSION}-win-x64.zip`)
    expect(nodeArchiveName('arm64')).toBe(`node-${NODE_RUNTIME_VERSION}-win-arm64.zip`)
  })

  it('builds an archive name for an explicitly selected Node.js version', () => {
    expect(nodeArchiveName('v22.19.0', 'x64')).toBe('node-v22.19.0-win-x64.zip')
    expect(nodeArchiveName('22.19.0', 'arm64')).toBe('node-v22.19.0-win-arm64.zip')
  })

  it('reads the archive checksum from Node.js SHASUMS256.txt', () => {
    const archive = nodeArchiveName('x64')
    const checksum = 'a'.repeat(64)
    expect(parseNodeArchiveChecksum(`${'b'.repeat(64)}  other.zip\n${checksum}  ${archive}\n`, archive)).toBe(checksum)
    expect(parseNodeArchiveChecksum('', archive)).toBeNull()
  })

  it('maps npm and npx commands to absolute runtime executables', () => {
    const root = path.join('C:', 'portable-node')
    const runtime = {
      root,
      node: path.join(root, 'node.exe'),
      npm: path.join(root, 'npm.cmd'),
      npx: path.join(root, 'npx.cmd'),
      managed: true,
    }
    expect(resolveNodeExecutable('npx.cmd', runtime)).toBe(runtime.npx)
    // path.join 而不是硬编码反斜杠：反斜杠在 POSIX 上不是分隔符，
    // 硬编码会让这条断言只在 Windows 上成立。
    expect(resolveNodeExecutable(path.join('C:', 'old', 'npm.cmd'), runtime)).toBe(runtime.npm)
    expect(resolveNodeExecutable('custom.exe', runtime)).toBe('custom.exe')
  })

  it('keeps the managed pnpm executable in the launcher runtime directory', () => {
    const root = path.join('C:', 'dsh-launcher', 'pnpm-runtime')
    // .cmd 后缀只在 Windows 上存在；在 POSIX 上断言无扩展名的 pnpm，
    // 否则这条断言在 Linux CI 上必然失败。
    const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    expect(pnpmExecutable(root)).toBe(path.join(root, 'node_modules', '.bin', executable))
  })

  it('uses the current pnpm store format for managed plugin operations', () => {
    expect(PNPM_VERSION).toMatch(/^11\./)
  })

  it('detects commands that need Node.js on PATH', () => {
    expect(requiresNodeRuntime('npx.cmd', ['--yes', '@deepseek-ai/dsh', 'web'])).toBe(true)
    expect(requiresNodeRuntime(path.join('C:', 'runtime', 'dsh.cmd'), ['web'])).toBe(true)
    expect(requiresNodeRuntime('custom.exe', ['serve'])).toBe(false)
  })
})

/**
 * PATH 里的每一项本身就是 bin 目录，官方发行包的根目录在 POSIX 上还多一层 bin/。
 * 这两种布局曾经混用同一套拼接逻辑，导致 findSystemNodeRuntime
 * 在任何 POSIX 系统上都必然返回 null。
 */
describe('node runtime discovery', () => {
  it('finds a system runtime in a directory listed on PATH', async () => {
    const binDirectory = await makeTemporaryDirectory()
    await createExecutables(binDirectory)

    const found = findSystemNodeRuntime({
      PATH: binDirectory,
      // Windows 会优先看 Program Files\nodejs，指向不存在的位置以保证结果确定。
      ProgramFiles: path.join(binDirectory, 'absent'),
    })

    expect(found).not.toBeNull()
    expect(found?.managed).toBe(false)
    expect(found?.node).toBe(path.join(binDirectory, EXECUTABLES[0]))
    expect(found?.npm).toBe(path.join(binDirectory, EXECUTABLES[1]))
    expect(found?.npx).toBe(path.join(binDirectory, EXECUTABLES[2]))
  })

  it('skips PATH entries that only have some of the executables', async () => {
    const root = await makeTemporaryDirectory()
    const partial = path.join(root, 'partial')
    await mkdir(partial, { recursive: true })
    await writeFile(path.join(partial, EXECUTABLES[0]), '', 'utf8')

    expect(findSystemNodeRuntime({
      PATH: partial,
      ProgramFiles: path.join(root, 'absent'),
    })).toBeNull()
  })

  it('returns null when no PATH entry has a runtime', async () => {
    const root = await makeTemporaryDirectory()
    expect(findSystemNodeRuntime({
      PATH: path.join(root, 'nowhere'),
      ProgramFiles: path.join(root, 'absent'),
    })).toBeNull()
  })

  it('finds a managed runtime laid out as an extracted distribution', async () => {
    const runtimeRoot = await makeTemporaryDirectory()
    const distribution = path.join(runtimeRoot, `node-${NODE_RUNTIME_VERSION}-win-x64`)
    await createExecutables(path.join(distribution, DISTRIBUTION_BIN))

    const found = await findManagedNodeRuntime(runtimeRoot)

    expect(found).not.toBeNull()
    expect(found?.managed).toBe(true)
    expect(found?.root).toBe(distribution)
    expect(found?.npm).toBe(path.join(distribution, DISTRIBUTION_BIN, EXECUTABLES[1]))
  })

  it('prefers the newest managed distribution', async () => {
    const runtimeRoot = await makeTemporaryDirectory()
    for (const version of ['node-v20.0.0-win-x64', 'node-v24.19.0-win-x64']) {
      await createExecutables(path.join(runtimeRoot, version, DISTRIBUTION_BIN))
    }

    const found = await findManagedNodeRuntime(runtimeRoot)

    expect(found?.root).toBe(path.join(runtimeRoot, 'node-v24.19.0-win-x64'))
  })

  it('discovers launcher-managed versions under the versions directory', async () => {
    const runtimeRoot = await makeTemporaryDirectory()
    const selectedVersion = 'v22.19.0'
    const versionRoot = managedNodeVersionRoot(runtimeRoot, selectedVersion)
    await createExecutables(path.join(versionRoot, DISTRIBUTION_BIN))

    const versions = await findManagedNodeRuntimes(runtimeRoot)

    expect(versions).toHaveLength(1)
    expect(versions[0]?.version).toBe(selectedVersion)
    expect(versions[0]?.source).toBe('launcher')
    expect(versions[0]?.root).toBe(versionRoot)
    expect((await findManagedNodeRuntime(runtimeRoot, selectedVersion))?.root).toBe(versionRoot)
  })

  it('ignores an incomplete managed distribution', async () => {
    const runtimeRoot = await makeTemporaryDirectory()
    const distribution = path.join(runtimeRoot, 'node-v24.19.0-win-x64', DISTRIBUTION_BIN)
    await mkdir(distribution, { recursive: true })
    await writeFile(path.join(distribution, EXECUTABLES[0]), '', 'utf8')

    expect(await findManagedNodeRuntime(runtimeRoot)).toBeNull()
  })
})

/**
 * 选择顺序必须与「本机 Node 版本不能再成为失败原因」这条承诺一致。
 * 探测全部注入：否则测试结果会跟着跑测试的这台机器的 Node 版本变。
 */
describe('node runtime 选择顺序', () => {
  /** 按路径片段决定探测到的版本，其余走 fallback。 */
  function probeVersions(rules: Record<string, string | null>, fallback: string | null) {
    return async (executable: string): Promise<string | null> => {
      for (const [needle, version] of Object.entries(rules)) {
        if (executable.includes(needle)) return version
      }
      return fallback
    }
  }

  async function fixture(): Promise<{ root: string; managedRoot: string; managed: string; systemBin: string }> {
    const root = await makeTemporaryDirectory()
    const managedRoot = path.join(root, 'managed')
    const managed = path.join(managedRoot, `node-${NODE_RUNTIME_VERSION}-win-x64`)
    await createExecutables(path.join(managed, DISTRIBUTION_BIN))
    const systemBin = path.join(root, 'system-bin')
    await createExecutables(systemBin)
    return { root, managedRoot, managed, systemBin }
  }

  /** 随包 Node 要连 npm 一起才算可用（打包器会剥掉 node_modules，见 usableRuntime）。 */
  async function createNpmPackage(runtimeRoot: string): Promise<void> {
    const npmDir = path.join(runtimeRoot, 'node_modules', 'npm', 'bin')
    await mkdir(npmDir, { recursive: true })
    await writeFile(path.join(runtimeRoot, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', version: '11.17.0' }), 'utf8')
    await writeFile(path.join(npmDir, 'npm-cli.js'), '', 'utf8')
  }

  /** 造一份「本机装了 Node」的机器：PATH 上只有 system-bin 这一项。 */
  function environmentFor(root: string, systemBin: string): NodeJS.ProcessEnv {
    return { PATH: systemBin, ProgramFiles: path.join(root, 'absent') }
  }

  it('本机达标就直接用，连随包那份都不看（省掉一次 35MB 下载）', async () => {
    const { root, managedRoot, managed, systemBin } = await fixture()
    const bundled = path.join(root, 'bundled')
    await createExecutables(path.join(bundled, DISTRIBUTION_BIN))
    await createNpmPackage(bundled)

    const runtime = await ensureNodeRuntime(managedRoot, undefined, null, undefined, {
      bundledRoot: bundled,
      environment: environmentFor(root, systemBin),
      probeVersion: probeVersions({ 'system-bin': '24.0.0' }, '24.19.0'),
    })

    expect(runtime.root).toBe(systemBin)
    expect(runtime.managed).toBe(false)
    expect(runtime.origin).toBe('system')
    expect(runtime.root).not.toBe(bundled)
  })

  it('本机版本正好在门槛下沿也算达标', async () => {
    const { root, managedRoot, managed, systemBin } = await fixture()

    const runtime = await ensureNodeRuntime(managedRoot, undefined, null, undefined, {
      environment: environmentFor(root, systemBin),
      probeVersion: probeVersions({ 'system-bin': MIN_NODE_VERSION }, '24.19.0'),
    })

    expect(runtime.root).toBe(systemBin)
    expect(runtime.origin).toBe('system')
  })

  it('本机不达标才轮到随包那份（要连 npm 一起在）', async () => {
    const { root, managedRoot, managed, systemBin } = await fixture()
    const bundled = path.join(root, 'bundled')
    await createExecutables(path.join(bundled, DISTRIBUTION_BIN))
    await createNpmPackage(bundled)

    const runtime = await ensureNodeRuntime(managedRoot, undefined, null, undefined, {
      bundledRoot: bundled,
      environment: environmentFor(root, systemBin),
      probeVersion: probeVersions({ 'system-bin': '18.20.4', bundled: '24.19.0' }, '24.19.0'),
    })

    expect(runtime.root).toBe(bundled)
    expect(runtime.origin).toBe('bundled')
    expect(runtime.root).not.toBe(managed)
  })

  it('随包 Node 缺 npm 时拒用（打包器剥掉 node_modules 的真实后果）', async () => {
    const { root, managedRoot, managed, systemBin } = await fixture()
    const bundled = path.join(root, 'bundled')
    // node.exe / npm.cmd / npx.cmd 三个壳都在（isCompleteRuntime 会点头），
    // 但 npm 本体不在——选中它就会让后面「用 npm 装 pnpm」直接失败。
    await createExecutables(path.join(bundled, DISTRIBUTION_BIN))

    const runtime = await ensureNodeRuntime(managedRoot, undefined, null, undefined, {
      bundledRoot: bundled,
      environment: environmentFor(root, systemBin),
      probeVersion: probeVersions({ 'system-bin': '18.20.4', bundled: '24.19.0' }, '24.19.0'),
    })

    expect(runtime.root).toBe(managed)
    expect(runtime.origin).toBe('managed')
    expect(runtime.root).not.toBe(bundled)
  })

  it('本机版本低于门槛时不用它，也不因为没有随包就报错', async () => {
    const { root, managedRoot, managed, systemBin } = await fixture()

    const runtime = await ensureNodeRuntime(managedRoot, undefined, null, undefined, {
      environment: environmentFor(root, systemBin),
      // 22.12.9 只差一点点，正是「装了 Node 反而装不上 pnpm」的那类机器。
      probeVersion: probeVersions({ 'system-bin': '22.12.9' }, '24.19.0'),
    })

    expect(runtime.root).toBe(managed)
    expect(runtime.root).not.toBe(systemBin)
  })

  it('随包内容版本过旧（与常量漂移）时不使用随包', async () => {
    const { root, managedRoot, managed, systemBin } = await fixture()
    const bundled = path.join(root, 'bundled')
    await createExecutables(path.join(bundled, DISTRIBUTION_BIN))
    await createNpmPackage(bundled)

    const runtime = await ensureNodeRuntime(managedRoot, undefined, null, undefined, {
      bundledRoot: bundled,
      environment: environmentFor(root, systemBin),
      probeVersion: probeVersions({ 'system-bin': '18.20.4', bundled: '16.20.2' }, '24.19.0'),
    })

    expect(runtime.root).toBe(managed)
  })

  it('探不到版本就当不达标（宁可不复用也不冒退 1 的险）', async () => {
    const { root, managedRoot, managed, systemBin } = await fixture()

    const runtime = await ensureNodeRuntime(managedRoot, undefined, null, undefined, {
      environment: environmentFor(root, systemBin),
      probeVersion: probeVersions({}, null),
    })

    expect(runtime.root).toBe(managed)
  })
})

describe('node 版本门槛判定', () => {
  it('按 pnpm 11 的 >=22.13 划线', () => {
    expect(nodeVersionAtLeast('22.13.0', MIN_NODE_VERSION)).toBe(true)
    expect(nodeVersionAtLeast('22.13.1', MIN_NODE_VERSION)).toBe(true)
    expect(nodeVersionAtLeast('22.12.9', MIN_NODE_VERSION)).toBe(false)
    expect(nodeVersionAtLeast('18.20.4', MIN_NODE_VERSION)).toBe(false)
    expect(nodeVersionAtLeast('v24.19.0', MIN_NODE_VERSION)).toBe(true)
    // 同版本号的预发布算低于正式版
    expect(nodeVersionAtLeast('22.13.0-rc.1', MIN_NODE_VERSION)).toBe(false)
  })

  it('门槛与版本号写法容错，但读不懂的版本一律算不达标', () => {
    expect(nodeVersionAtLeast('23.0.0', '22.13')).toBe(true)
    expect(nodeVersionAtLeast('22.13.0', '22.13')).toBe(true)
    expect(nodeVersionAtLeast('not-a-version', MIN_NODE_VERSION)).toBe(false)
    // 门槛自己写错时不该把所有人挡在外面
    expect(nodeVersionAtLeast('18.0.0', '完全不是版本号')).toBe(true)
  })
})

/** 随包 pnpm 的判定：命中就不该有联网安装那一步。 */
describe('pnpm runtime 选择', () => {
  const binName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

  async function createPnpmTree(root: string, version: string): Promise<string> {
    const packageDir = path.join(root, 'node_modules', 'pnpm')
    await mkdir(packageDir, { recursive: true })
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'pnpm', version }), 'utf8')
    const binDir = path.join(root, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, binName), '', 'utf8')
    return root
  }

  /** npm 指向不存在的路径：一旦真的尝试安装就会炸出来，正好当「不许安装」的探针。 */
  function nodeWithBrokenNpm(root: string): NodeRuntime {
    return {
      root,
      node: path.join(root, 'node.exe'),
      npm: path.join(root, 'definitely-missing-npm.cmd'),
      npx: path.join(root, 'definitely-missing-npx.cmd'),
      managed: true,
    }
  }

  it('随包 pnpm 版本命中时直接用，不触发安装', async () => {
    const root = await makeTemporaryDirectory()
    const bundled = await createPnpmTree(path.join(root, 'bundled-pnpm'), PNPM_VERSION)

    const runtime = await ensurePnpmRuntime(
      path.join(root, 'userData-pnpm'),
      nodeWithBrokenNpm(root),
      undefined,
      undefined,
      { bundledRoot: bundled },
    )

    expect(runtime.root).toBe(bundled)
    expect(runtime.executable).toBe(path.join(bundled, 'node_modules', '.bin', binName))
  })

  it('随包版本与 PNPM_VERSION 不符时不硬用，继续往后找', async () => {
    const root = await makeTemporaryDirectory()
    const staleBundled = await createPnpmTree(path.join(root, 'stale-pnpm'), '10.0.0')
    const managed = await createPnpmTree(path.join(root, 'userData-pnpm'), PNPM_VERSION)

    const runtime = await ensurePnpmRuntime(managed, nodeWithBrokenNpm(root), undefined, undefined, {
      bundledRoot: staleBundled,
    })

    expect(runtime.root).toBe(managed)
  })

  it('随包目录残缺（没有 .bin 壳）时不算命中', async () => {
    const root = await makeTemporaryDirectory()
    const halfBuilt = path.join(root, 'half-pnpm')
    await mkdir(path.join(halfBuilt, 'node_modules', 'pnpm'), { recursive: true })
    await writeFile(path.join(halfBuilt, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', version: PNPM_VERSION }), 'utf8')
    const managed = await createPnpmTree(path.join(root, 'userData-pnpm'), PNPM_VERSION)

    const runtime = await ensurePnpmRuntime(managed, nodeWithBrokenNpm(root), undefined, undefined, {
      bundledRoot: halfBuilt,
    })

    expect(runtime.root).toBe(managed)
  })
})

/**
 * 35MB 的发行包只认 nodejs.org 是大陆用户「第一次启动转十分钟」的那一类反馈。
 * 网络与校验都用假实现，这里只验三条规则：源顺序、不跨源续传、校验只认内容。
 */
describe('Node 发行包多源下载', () => {
  const archiveName = 'node-v24.19.0-win-x64.zip'
  const bases = nodeArchiveBaseUrls('24.19.0')

  it('下载源镜像在前、官方源兜底；校验清单反过来以官方源为先', () => {
    expect(bases.map(base => new URL(base).host)).toEqual([
      'registry.npmmirror.com',
      'mirrors.huaweicloud.com',
      'nodejs.org',
    ])
    const checksumBases = nodeChecksumBaseUrls('24.19.0')
    expect(new URL(checksumBases[0] ?? '').host).toBe('nodejs.org')
    expect(checksumBases).toHaveLength(bases.length)
  })

  it('第一个源校验不过就换下一个，用通过的那个', async () => {
    const root = await makeTemporaryDirectory()
    const archivePath = path.join(root, archiveName)
    const attempted: string[] = []

    await downloadVerifiedNodeArchive({
      archivePath,
      markerPath: `${archivePath}.source`,
      bases,
      archiveName,
      expectedChecksum: 'good',
      checksumOf: async () => (attempted.length === 1 ? 'bad' : 'good'),
      download: async (url, target) => {
        attempted.push(url)
        await writeFile(target, 'payload', 'utf8')
      },
    })

    expect(attempted).toEqual([`${bases[0]}/${archiveName}`, `${bases[1]}/${archiveName}`])
  })

  it('换源前清掉上一个源的残留：绝不拿 A 源的半截去续传 B 源', async () => {
    const root = await makeTemporaryDirectory()
    const archivePath = path.join(root, archiveName)
    const seenOnEntry: Array<string | null> = []

    await downloadVerifiedNodeArchive({
      archivePath,
      markerPath: `${archivePath}.source`,
      bases,
      archiveName,
      // 用文件内容当"校验和"：第二个源写的 B 才对得上。
      expectedChecksum: 'B',
      checksumOf: async file => await readFile(file, 'utf8').catch(() => ''),
      download: async (_url, target) => {
        seenOnEntry.push(await readFile(target, 'utf8').catch(() => null))
        await writeFile(target, seenOnEntry.length === 1 ? 'A-partial' : 'B', 'utf8')
      },
    })

    expect(seenOnEntry).toEqual([null, null])
  })

  it('本地已有的包内容对得上时一次都不下载', async () => {
    const root = await makeTemporaryDirectory()
    const archivePath = path.join(root, archiveName)
    await writeFile(archivePath, 'payload', 'utf8')

    await downloadVerifiedNodeArchive({
      archivePath,
      markerPath: `${archivePath}.source`,
      bases,
      archiveName,
      expectedChecksum: 'payload',
      checksumOf: async () => 'payload',
      download: async () => {
        throw new Error('不该再下载')
      },
    })
  })

  it('全部源都失败时报错带着每个源的原因，并删掉坏文件', async () => {
    const root = await makeTemporaryDirectory()
    const archivePath = path.join(root, archiveName)

    await expect(downloadVerifiedNodeArchive({
      archivePath,
      markerPath: `${archivePath}.source`,
      bases,
      archiveName,
      expectedChecksum: 'never',
      checksumOf: async () => 'wrong',
      download: async (_url, target) => {
        await writeFile(target, 'junk', 'utf8')
      },
    })).rejects.toThrow('registry.npmmirror.com：安装包校验不匹配')

    expect(await readFile(archivePath, 'utf8').catch(() => null)).toBeNull()
  })
})

describe('pnpm 安装的源选择', () => {
  it('npm 参数显式带 --registry，并把坏源上的等待压到 30 秒', () => {
    const args = managedPnpmInstallArgs('C:\\runtime\\pnpm-runtime', 'https://registry.npmmirror.com')
    const at = args.indexOf('--registry')
    expect(args.slice(at, at + 2)).toEqual(['--registry', 'https://registry.npmmirror.com'])
    expect(args).toContain('--fetch-timeout=30000')
    expect(args.at(-1)).toBe(`pnpm@${PNPM_VERSION}`)
  })

  it('候选链：用户镜像 → npmmirror → 官方源，填了镜像也不重复试', () => {
    expect(npmRegistryCandidates('https://mirror.example')).toEqual([
      'https://mirror.example',
      'https://registry.npmmirror.com',
      'https://registry.npmjs.org',
    ])
    expect(npmRegistryCandidates('   ')).toEqual(['https://registry.npmmirror.com', 'https://registry.npmjs.org'])
    expect(npmRegistryCandidates('https://registry.npmmirror.com')).toEqual(['https://registry.npmmirror.com', 'https://registry.npmjs.org'])
  })
})
