// 原子写：先写唯一临时名，再 rename 覆盖到目标。
//
// 三条都得成立，缺任何一条都对应过真实事故：
//   1. 临时名必须唯一（pid + 毫秒 + 进程内序号）。固定 `.tmp` 名在两个并发写者下会写进
//      同一个文件，谁后 rename 就把对方半截载荷一起带走 —— 读者拿到的是两份 JSON 拼起来的
//      撕裂文件，而且不报错，直到下次读它才炸。
//   2. Windows 上 rename 覆盖已存在目标会被 Defender / 索引器瞬时占用（EPERM），
//      重试几百毫秒就能过去；这一步失败的用户后果是"配置没保存"。
//   3. 失败要收掉临时文件。唯一名不会像固定名那样被下次写覆盖"自愈"，崩溃残留会越攒越多，
//      还会被整合包导出当成包内文件带走。

import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const RENAME_RETRY_DELAY_MS = [20, 50, 100, 200]

/** rename 覆盖失败里可以等一下再试的那几个码。 */
function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY'
}

async function renameOverwrite(source: string, target: string): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAY_MS.length; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      if (!isRetryableRenameError(error)) throw error
      lastError = error
      const delay = RENAME_RETRY_DELAY_MS[attempt]
      if (delay !== undefined) await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

/** 同一毫秒内的两次写也要拿到不同名字，所以序号必须带在名字里。 */
let temporaryWriteSequence = 0

export interface AtomicWriteOptions {
  /** 目标文件权限，如凭据文件的 0o600。 */
  mode?: number
  /** 目标所在目录的权限，如 0o700。 */
  dirMode?: number
  /**
   * rename 始终失败时，是否退回"直接写目标"。
   *
   * 直接写会先截断再写，读者能在中间看到半截文件——所以它只在**目标还不存在**时才放行：
   * 那种情况下没有完好内容可破坏。目标已存在时宁可抛错，因为对注册表/收据这类用户数据，
   * 撕坏（= 用户的包整列表消失）远比这次写失败（可以重试）严重得多。
   */
  fallbackToDirectWrite?: boolean
}

/** 每个进程内只扫一次的目录集合：唯一临时名的崩溃残留不需要每次写都翻一遍目录。 */
const sweptDirectories = new Set<string>()

async function sweepStaleTemps(directory: string, targetPath: string): Promise<void> {
  if (sweptDirectories.has(directory)) return
  sweptDirectories.add(directory)
  const entries = await readdir(directory).catch(() => null)
  if (!entries) return
  const prefix = `${path.basename(targetPath)}.`
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
    const stale = await stat(path.join(directory, entry)).then(info => info.mtimeMs < cutoff).catch(() => false)
    if (stale) await rm(path.join(directory, entry), { force: true }).catch(() => undefined)
  }
}

/** 原子写入文本或二进制内容；失败时不留临时文件，也不留下半截目标文件。 */
export async function writeFileAtomic(targetPath: string, data: string | Buffer, options: AtomicWriteOptions = {}): Promise<void> {
  const directory = path.dirname(targetPath)
  await mkdir(directory, { recursive: true, ...(options.dirMode !== undefined ? { mode: options.dirMode } : {}) })
  await sweepStaleTemps(directory, targetPath)
  temporaryWriteSequence += 1
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.${temporaryWriteSequence}.tmp`
  const modeOptions = options.mode !== undefined ? { mode: options.mode } : {}
  try {
    await writeFile(temporary, data, { ...modeOptions, flag: 'wx' })
    try {
      await renameOverwrite(temporary, targetPath)
    } catch (error) {
      if (!options.fallbackToDirectWrite) throw error
      // 目标已存在时绝不截断重写：那正是并发读者读到撕裂 JSON 的成因。
      const targetExists = await stat(targetPath).then(() => true, () => false)
      if (targetExists) throw error
      await writeFile(targetPath, data, modeOptions)
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    // rename 保留临时文件的权限位，但 umask / Windows 上未必如预期，显式补一次。
    if (options.mode !== undefined) await chmod(targetPath, options.mode)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
