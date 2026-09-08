// 整合包（Pack）导出：从整合包家目录的 node_modules 收集插件本体，组合成可导出的压缩包。
// 纯函数 + fs，不依赖 Electron。

import { access } from 'node:fs/promises'
import path from 'node:path'
import type { PackManifest } from '../src/types'
import { isSafePackageName } from './profile'
import { buildPackZip, buildPackZipToFile } from './pack-zip'

export interface PackBodyCollection {
  bodies: Map<string, string>
  missing: string[]
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 收集整合包家目录 node_modules 中每个包名对应的目录；scoped 包为 node_modules/@scope/pkg，缺失的记入 missing。
 * packageName 必须通过安全校验，且拼接后的路径不得越出 node_modules，防止路径穿越。
 */
export async function collectPackBodies(
  packProfileDir: string,
  packageNames: string[],
): Promise<PackBodyCollection> {
  const bodies = new Map<string, string>()
  const missing: string[] = []
  const nodeModulesDir = path.join(packProfileDir, 'node_modules')
  for (const packageName of packageNames) {
    if (!isSafePackageName(packageName)) {
      missing.push(packageName)
      continue
    }
    const directory = path.join(nodeModulesDir, ...packageName.split('/'))
    const relative = path.relative(nodeModulesDir, directory)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      missing.push(packageName)
      continue
    }
    if (await exists(directory)) bodies.set(packageName, directory)
    else missing.push(packageName)
  }
  return { bodies, missing }
}

/** 组合出导出用的压缩包字节；缺失的本体会被跳过并返回其包名。 */
export async function buildPackExport(
  packProfileDir: string,
  manifest: PackManifest,
  packageNames: string[],
  launcherConfig?: string,
): Promise<{ zip: Uint8Array; missing: string[] }> {
  const { bodies, missing } = await collectPackBodies(packProfileDir, packageNames)
  return { zip: buildPackZip(manifest, bodies, launcherConfig), missing }
}

/** 流式把导出包写入指定文件；缺失的本体会被跳过并返回其包名。 */
export async function buildPackExportToFile(
  packProfileDir: string,
  manifest: PackManifest,
  packageNames: string[],
  outputPath: string,
  presetDirs: Map<string, string> = new Map(),
  launcherConfig?: string,
  offline?: { tarballDir: string; lockfileText: string },
): Promise<{ zipPath: string; missing: string[] }> {
  const { bodies, missing } = await collectPackBodies(packProfileDir, packageNames)
  await buildPackZipToFile(manifest, bodies, outputPath, presetDirs, launcherConfig, offline)
  return { zipPath: outputPath, missing }
}

// ===========================================================================
// 全离线导出支持：把 profile 依赖打成 npm tarball，随包携带；导入端灌入
// pnpm store 后配合 lockfile 即可完全离线安装（pnpm install --offline）。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, mkdir } from 'node:fs/promises'

export interface DependencyTarballCollection {
  /** tarball 输出目录；null 表示收集失败（导入将回退在线安装）。 */
  tarballDir: string | null
  /** profile 的 pnpm-lock.yaml 文本；null 表示本包没有可用的 lockfile。 */
  lockfileText: string | null
  /** 解析到的依赖总数。 */
  total: number
  /** 打包失败的依赖（>0 时整体视为失败，tarballDir 为 null）。 */
  failed: string[]
}

/** 在 node 发行版目录里探测 npm-cli.js。 */
export function findNpmCli(nodeExecutable: string): string | null {
  const dir = path.dirname(nodeExecutable)
  for (const candidate of [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function packOnce(nodeExecutable: string, npmCli: string, packageDir: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [npmCli, 'pack', packageDir, '--pack-destination', destination, '--silent'], {
      windowsHide: true,
    })
    let stderrText = ''
    child.stderr?.on('data', chunk => { stderrText += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`npm pack 退出码 ${code}：${stderrText.trim().slice(-300)}`))
    })
  })
}

interface DependencyTarget { name: string; version: string; packageDir: string }

/** 从包目录的 package.json 读取 name/version（hoisted 扁平布局用）。 */
async function targetFromPackageJson(packageDir: string): Promise<DependencyTarget | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return null
    if (!isSafePackageName(manifest.name)) return null
    if (!/^v?\d+[.\d-]|^v?\d+\d*/.test(manifest.version) && !manifest.version.includes('-')) return null
    return { name: manifest.name, version: manifest.version, packageDir }
  } catch {
    return null
  }
}

/** hoisted 扁平 node_modules 布局：顶层每个目录（@scope 展开）就是一个包。 */
async function enumerateHoistedTargets(nodeModulesDir: string): Promise<DependencyTarget[]> {
  const targets: DependencyTarget[] = []
  for (const entry of await readdir(nodeModulesDir)) {
    if (entry.startsWith('.') || entry === 'bin') continue
    const dir = path.join(nodeModulesDir, entry)
    if (entry.startsWith('@')) {
      for (const sub of await readdir(dir)) {
        const target = await targetFromPackageJson(path.join(dir, sub))
        if (target) targets.push(target)
      }
    } else {
      const target = await targetFromPackageJson(dir)
      if (target) targets.push(target)
    }
  }
  return targets
}

/**
 * 把整合包环境依赖（node_modules 里的每个真实包）打成 npm tarball。
 * 全部成功才返回 tarballDir；任一失败返回 null（调用方回退在线导入）。
 */
export async function collectDependencyTarballs(
  packProfileDir: string,
  outputDir: string,
  options: {
    nodeExecutable: string
    concurrency?: number
    onProgress?: (done: number, total: number, name: string) => void
  },
): Promise<DependencyTarballCollection> {
  let lockfileText: string | null = null
  try {
    lockfileText = await readFile(path.join(packProfileDir, 'pnpm-lock.yaml'), 'utf8')
  } catch {
    return { tarballDir: null, lockfileText: null, total: 0, failed: [] }
  }

  // 整合包环境的 node_modules 是扁平实体布局：顶层每个目录（@scope 展开）就是一个包。
  const targets = await enumerateHoistedTargets(path.join(packProfileDir, 'node_modules'))
  if (targets.length === 0) return { tarballDir: null, lockfileText, total: 0, failed: [] }

  const npmCli = findNpmCli(options.nodeExecutable)
  if (!npmCli) return { tarballDir: null, lockfileText, total: targets.length, failed: ['npm-cli 不可用'] }

  await mkdir(outputDir, { recursive: true })
  const failed: string[] = []
  let done = 0
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8))
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const target = targets[cursor]
      cursor += 1
      try {
        await packOnce(options.nodeExecutable, npmCli, target.packageDir, outputDir)
      } catch {
        failed.push(`${target.name}@${target.version}`)
      }
      done += 1
      options.onProgress?.(done, targets.length, target.name)
    }
  })
  await Promise.all(workers)
  if (failed.length > 0) return { tarballDir: null, lockfileText, total: targets.length, failed }
  return { tarballDir: outputDir, lockfileText, total: targets.length, failed }
}
