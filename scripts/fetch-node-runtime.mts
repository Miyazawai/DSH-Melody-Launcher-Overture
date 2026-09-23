/**
 * 准备随启动器一起分发的运行时：vendor/node（含 npm）与 vendor/pnpm。
 *
 *   npm run fetch:runtimes            准备（已就绪则跳过）
 *   npm run fetch:runtimes -- --force 重新准备
 *
 * 为什么要随包：启动器过去会优先用 PATH 上找到的第一个 Node（只查文件在不在、
 * 不查版本），而 pnpm 钉在 11.21.0（要求 node>=22.13）——本机装了老 Node 的用户
 * 就得到一句「DSH 安装失败（代码 1）」。自带一份，本机装过什么都不影响；
 * pnpm 也带上，首启的运行时准备就完全不联网。
 *
 * 下载/校验/安装全部复用运行期那套实现（installManagedNodeRuntime、
 * ensurePnpmRuntime），不在脚本里重写第二份逻辑。
 *
 * 【当前未接入打包】electron-builder 的 extraResources 会无条件剥掉 node_modules
 * 目录——实测两种 filter 写法（前缀通配与不带前缀的通配）都拦不住：
 * 产物里 resources/node 只有 node.exe 与三个 .cmd 壳，npm.cmd 指向的
 * node_modules/npm/bin/npm-cli.js 根本不存在；vendor/pnpm 的唯一内容就是
 * node_modules，所以整目录一个文件都没进去。
 * 因此 package.json 里既没有 vendor/* 的 extraResources，package:win 也不跑本脚本。
 * 运行期侧由 `usableRuntime()` 按文件确认 npm 是否存在，缺 npm 就拒用这份随包 Node，
 * 自动回落到托管下载（与改造前一致），所以「未接入」不会造成回归。
 * 要把随包真正落地，需要改成「打包成一个归档 + 首启解到 userData」——
 * 因为解包由我们自己做完，归档内部有什么目录不受打包器约束。
 */
import { readdirSync, statSync } from 'node:fs'
import { cp, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import {
  ensurePnpmRuntime,
  installManagedNodeRuntime,
  NODE_RUNTIME_VERSION,
  normalizeNodeVersion,
  pnpmExecutable,
  PNPM_VERSION,
  runtimePaths,
  type NodeRuntime,
} from '../electron/node-runtime'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_ROOT = path.join(REPO_ROOT, 'vendor')
const NODE_TARGET = path.join(VENDOR_ROOT, 'node')
const PNPM_TARGET = path.join(VENDOR_ROOT, 'pnpm')
const NODE_STAGING = path.join(VENDOR_ROOT, '.node-staging')
const PNPM_STAGING = path.join(VENDOR_ROOT, '.pnpm-staging')

/** 随包路径按平台布局拼：Windows 的 zip 平铺，POSIX 多一层 bin/。 */
function vendorNodeRuntime(root: string): NodeRuntime {
  return runtimePaths(root, true, 'distribution-root')
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

/** 随包体积要报出来：这是「自带运行时」这个方案的直接代价。 */
function directoryBytes(target: string): number {
  let total = 0
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const name of readdirSync(current)) {
      const full = path.join(current, name)
      const info = statSync(full)
      if (info.isDirectory()) stack.push(full)
      else total += info.size
    }
  }
  return total
}

/** 以 `node -v` 为准，不信任目录名：随包内容与常量漂移过一次就再也不会一致。 */
async function reportedNodeVersion(executable: string): Promise<string | null> {
  try {
    await stat(executable)
  } catch {
    return null
  }
  return new Promise<string | null>(resolve => {
    execFile(executable, ['-v'], { windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.trim())
    })
  })
}

async function readPnpmVersion(root: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'node_modules', 'pnpm', 'package.json'), 'utf8')) as { version?: unknown }
    await stat(pnpmExecutable(root))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

async function prepareNode(force: boolean): Promise<NodeRuntime> {
  const target = vendorNodeRuntime(NODE_TARGET)
  if (!force && await reportedNodeVersion(target.node) === normalizeNodeVersion(NODE_RUNTIME_VERSION)) {
    console.log(`vendor/node 已是 ${NODE_RUNTIME_VERSION}，跳过下载。`)
    return target
  }

  await rm(NODE_TARGET, { recursive: true, force: true })
  // 不清 staging 里的 zip：下载中途失败重跑时能复用（校验通过就跳过下载）。
  const installed = await installManagedNodeRuntime(NODE_STAGING, NODE_RUNTIME_VERSION, progress => {
    console.log(`  node ${progress.percent}% ${progress.message}`)
  }, (level, text) => {
    if (level === 'error') console.error(text.trimEnd())
  })

  // 装完再断言一次：否则「自带 Node」会变成「带了一份旧 Node」。
  if (await reportedNodeVersion(installed.node) !== normalizeNodeVersion(NODE_RUNTIME_VERSION)) {
    throw new Error(`装好的 Node 版本与 NODE_RUNTIME_VERSION=${NODE_RUNTIME_VERSION} 不一致。`)
  }
  // 官方发行包解压在 versions/<版本>/ 下；随包要稳定的 vendor/node（package.json 里不写版本号）。
  await cp(path.dirname(installed.node), NODE_TARGET, { recursive: true })
  await rm(NODE_STAGING, { recursive: true, force: true })
  console.log(`已准备 vendor/node：${NODE_RUNTIME_VERSION}，约 ${megabytes(directoryBytes(NODE_TARGET))}MB`)
  return target
}

async function preparePnpm(nodeRuntime: NodeRuntime, force: boolean): Promise<void> {
  if (!force && await readPnpmVersion(PNPM_TARGET) === PNPM_VERSION) {
    console.log(`vendor/pnpm 已是 pnpm ${PNPM_VERSION}，跳过安装。`)
    return
  }

  await rm(PNPM_TARGET, { recursive: true, force: true })
  await rm(PNPM_STAGING, { recursive: true, force: true })
  // 复用运行期那条安装路径（npm install --prefix … pnpm@<版本>）；传随包 Node，
  // 保证连「装 pnpm」这一步也不碰本机环境。
  const built = await ensurePnpmRuntime(PNPM_STAGING, nodeRuntime, progress => {
    console.log(`  pnpm ${progress.percent}% ${progress.message}`)
  }, (level, text) => {
    if (level === 'error') console.error(text.trimEnd())
  })

  /**
   * 裁掉 artifacts/（约 16.7MB）：那是 pnpm 预编译 exe 用的同一份 bundle 副本。
   * 启动器只走 node_modules/.bin/pnpm.cmd → bin/pnpm.mjs → dist/。
   *
   * 下面的版本断言挡得住「装错版本」，挡不住「pnpm 改了布局导致裁错」——
   * 所以升 PNPM_VERSION 之后，除了跑本脚本还要真跑一次 `pnpm add <包>` 验收。
   */
  await rm(path.join(built.root, 'node_modules', 'pnpm', 'artifacts'), { recursive: true, force: true })
  await cp(path.join(built.root, 'node_modules'), path.join(PNPM_TARGET, 'node_modules'), { recursive: true })
  await rm(PNPM_STAGING, { recursive: true, force: true })

  const version = await readPnpmVersion(PNPM_TARGET)
  if (version !== PNPM_VERSION) {
    throw new Error(`vendor/pnpm 的 version 是 ${version ?? '读不到'}，与 PNPM_VERSION=${PNPM_VERSION} 不一致。`)
  }
  console.log(`已准备 vendor/pnpm：pnpm ${PNPM_VERSION}，约 ${megabytes(directoryBytes(PNPM_TARGET))}MB`)
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('非 Windows：跳过随包运行时准备（打包目标是 win portable）。')
    return
  }
  const force = process.argv.includes('--force')
  const nodeRuntime = await prepareNode(force)
  await preparePnpm(nodeRuntime, force)
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
