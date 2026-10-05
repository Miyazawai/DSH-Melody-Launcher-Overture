/**
 * 让官方桌面端走国内镜像：只改它 profile 的 `.npmrc` 里的 `registry` 一个键。
 *
 * 为什么单独写一份而不复用 `installer.ts` 的 `syncProfilePnpmConfig()`：那个函数是给
 * 我们自己的包用的，会连 `store-dir` 一起写（把依赖池指到启动器家里的 plugin-store）。
 * 对桌面端那么干等于把它以后所有安装的落点都搬到我们目录下——它哪天换布局或卸载重装，
 * 那一池子链接就成了悬案。所以这里只动 registry，其它键（包括用户自己写的）原样保留。
 *
 * 生效依据是从盘上读来的，不是猜的：桌面端文档写明它的包操作「用自带 pnpm + 常规 user 与
 * profile 配置」，所以 profile 级 `.npmrc` 真的会被吃到。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'

const NPMRC_FILENAME = '.npmrc'
const MANAGED_KEY = 'registry'

export interface DesktopRegistryChange {
  changed: boolean
  /** 首次改动前把原件备份在这里；恢复原样靠它。 */
  backupPath: string | null
}

function isHttpRegistry(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** 只替换/追加 `registry=`，其余行（含注释与用户自填键）逐字保留。 */
function rewriteRegistry(source: string, registry: string): string {
  const lines = source.split(/\r?\n/)
  const kept: string[] = []
  let replaced = false
  for (const line of lines) {
    const key = /^[ \t]*([^=#][^=]*?)[ \t]*=/.exec(line)?.[1]?.trim().toLowerCase()
    if (key === MANAGED_KEY) {
      if (!replaced) {
        kept.push(`${MANAGED_KEY}=${registry}`)
        replaced = true
      }
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  if (!replaced) kept.push(`${MANAGED_KEY}=${registry}`)
  return `${kept.join('\n')}\n`
}

function npmrcPath(profileDir: string): string {
  return path.join(profileDir, NPMRC_FILENAME)
}

function recordPaths(journalRoot: string, profileDir: string): { metadataPath: string; backupPath: string } {
  const id = createHash('sha256').update(path.resolve(profileDir)).digest('hex').slice(0, 12)
  return {
    metadataPath: path.join(journalRoot, `${id}.npmrc.json`),
    backupPath: path.join(journalRoot, `${id}.npmrc`),
  }
}

interface RegistryRecord {
  schema: 1
  profileDir: string
  /** 原件内容；null 表示改之前根本没有 .npmrc，恢复=删掉我们写的那个。 */
  hadFile: boolean
  appliedRegistry: string | null
}

/** 当前 registry 是否已经是这个值——界面用它决定按钮显示「配置」还是「已配置」。 */
export async function readDesktopRegistry(profileDir: string): Promise<string | null> {
  const source = await readFile(npmrcPath(profileDir), 'utf8').catch(() => null)
  if (source === null) return null
  // 取最后一条 registry=，与 npm 自己的「后写覆盖先写」一致。
  let current: string | null = null
  for (const line of source.split(/\r?\n/)) {
    const match = /^[ \t]*registry[ \t]*=(.*)$/.exec(line)
    if (match?.[1] !== undefined) current = match[1].trim()
  }
  return current
}

/** 把桌面端的 registry 指向给定镜像；首次改动前备份原件到 userData 侧。 */
export async function applyDesktopRegistry(
  profileDir: string,
  registry: string,
  journalRoot: string,
): Promise<DesktopRegistryChange> {
  const target = registry.trim()
  if (!isHttpRegistry(target)) throw new Error('镜像地址必须是 http(s) 链接。')
  const file = npmrcPath(profileDir)
  const source = await readFile(file, 'utf8').catch(() => null)
  if (source !== null && (await readDesktopRegistry(profileDir)) === target) return { changed: false, backupPath: null }

  const { metadataPath, backupPath } = recordPaths(journalRoot, profileDir)
  const existingRecord = await readFile(metadataPath, 'utf8').catch(() => null)
  const record: RegistryRecord = existingRecord !== null
    ? JSON.parse(existingRecord) as RegistryRecord
    : { schema: 1, profileDir: path.resolve(profileDir), hadFile: source !== null, appliedRegistry: null }

  await mkdir(journalRoot, { recursive: true, mode: 0o700 })
  if (existingRecord === null) {
    if (source !== null) await writeFile(backupPath, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await writeFile(metadataPath, `${JSON.stringify({ ...record, appliedRegistry: target } satisfies RegistryRecord)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } else {
    await writeFile(metadataPath, `${JSON.stringify({ ...record, appliedRegistry: target } satisfies RegistryRecord)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  await writeFileAtomic(file, rewriteRegistry(source ?? '', target), { mode: 0o600, dirMode: 0o700 })
  return { changed: true, backupPath: record.hadFile ? backupPath : null }
}

/** 恢复原样：有原件就写回去，原来没有 .npmrc 就把我们写的那个删掉。 */
export async function restoreDesktopRegistry(profileDir: string, journalRoot: string): Promise<boolean> {
  const { metadataPath, backupPath } = recordPaths(journalRoot, profileDir)
  const raw = await readFile(metadataPath, 'utf8').catch(() => null)
  if (raw === null) return false
  const record = JSON.parse(raw) as Partial<RegistryRecord>
  const file = npmrcPath(profileDir)
  if (record.hadFile === true) {
    const original = await readFile(backupPath, 'utf8').catch(() => null)
    if (original === null) return false
    await writeFileAtomic(file, original, { mode: 0o600, dirMode: 0o700 })
  } else {
    await rm(file, { force: true })
  }
  await rm(backupPath, { force: true }).catch(() => undefined)
  await rm(metadataPath, { force: true }).catch(() => undefined)
  return true
}
