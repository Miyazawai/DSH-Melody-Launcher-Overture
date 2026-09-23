/**
 * 整合包导出/导入耗时基准（本地开发用，不进 CI）。
 *
 *   npx vite-node scripts/perf-pack-bench.mts
 *
 * 用仓库里真实的官方整合包 zip 作输入，量四段：
 *   1. 导入解压   extractSnapshot
 *   2. 导出扫描   planSnapshot（目录遍历 + 文本重写）
 *   3. 导出打包   writeSnapshotZip（压缩 + 写盘）
 *   4. 纯目录遍历：串行逐文件 lstat vs 有限并发，用来单独看 stat 这项开销占多少
 * 结果打到 stdout，改动前后各跑一次对比。
 */
import { existsSync } from 'node:fs'
import { lstat, readdir, rm, mkdir, stat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Yazl from 'yazl'
import {
  describeSnapshotZip,
  extractSnapshot,
  planSnapshot,
  writeSnapshotZip,
} from '../electron/pack-snapshot'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_ZIP = path.join(REPO_ROOT, 'release', 'official-pack-v0.1.5-rc.2.1.zip')
const WORK_DIR = path.join(REPO_ROOT, '.bench-tmp')
const HOME_DIR = path.join(WORK_DIR, 'home')
const OUT_ZIP = path.join(WORK_DIR, 'out.zip')

/** 改动前的打包写法（yazl + 默认 level 6 + 逐条目 stat），用来同轮 A/B 对比。 */
async function writeWithYazlLevel6(plan: { entries: Array<{ rel: string; source?: string; data?: Buffer }> }, targetZipPath: string): Promise<void> {
  const zip = new Yazl.ZipFile()
  for (const entry of plan.entries) {
    if (entry.data) {
      zip.addBuffer(entry.data, entry.rel)
      continue
    }
    if (!entry.source) continue
    const info = await stat(entry.source).catch(() => null)
    if (!info) continue
    const sourcePath = entry.source
    zip.addReadStreamLazy(entry.rel, { size: info.size }, callback => callback(null, createReadStream(sourcePath)))
  }
  zip.addBuffer(Buffer.from('{ "format": 1 }\n', 'utf8'), 'dsh-snapshot.json')
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(targetZipPath)
    output.on('error', reject)
    output.on('close', resolve)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output)
    zip.end()
  })
}

interface Timing {
  label: string
  seconds: number
  detail?: string
}

const timings: Timing[] = []

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

async function elapsed<T>(label: string, fn: () => Promise<{ detail?: string }>): Promise<void> {
  const started = Date.now()
  const { detail } = await fn()
  timings.push({ label, seconds: (Date.now() - started) / 1000, detail })
}

/** 串行逐文件 lstat：与 pack-snapshot.ts walk() 改动前的形态一致。 */
async function walkSerial(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name)
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!dirent.isFile()) continue
      const info = await lstat(full).catch(() => null)
      if (!info) continue
      files += 1
      bytes += info.size
    }
  }
  return { files, bytes }
}

/** 有限并发 lstat：同一批 dirent 一次性发起，避免逐条 await 串行化系统调用。 */
async function walkBatched(dir: string, concurrency = 32): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    const targets: string[] = []
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name)
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        stack.push(full)
        continue
      }
      if (dirent.isFile()) targets.push(full)
    }
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency)
      const infos = await Promise.all(batch.map(target => lstat(target).catch(() => null)))
      for (const info of infos) {
        if (!info) continue
        files += 1
        bytes += info.size
      }
    }
  }
  return { files, bytes }
}

async function main(): Promise<void> {
  if (!existsSync(SAMPLE_ZIP)) {
    console.error(`找不到样本包：${SAMPLE_ZIP}`)
    process.exitCode = 1
    return
  }
  const sampleStats = await stat(SAMPLE_ZIP)
  console.log(`样本包：${path.basename(SAMPLE_ZIP)}（${mb(sampleStats.size)}MB）`)
  console.log(`临时目录：${WORK_DIR}`)
  // --reuse：跳过 392MB 解包与遍历，直接在已解好的家目录上反复 A/B 打包。
  // 跨轮次不可比（同一台机器上未改动的代码曾测出 25s 与 57s 两份），只有同轮交替才可信。
  const reuse = process.argv.includes('--reuse') && existsSync(path.join(HOME_DIR, 'profiles'))
  if (!reuse) {
    await rm(WORK_DIR, { recursive: true, force: true })
    await mkdir(HOME_DIR, { recursive: true })
  }

  const info = await describeSnapshotZip(SAMPLE_ZIP)
  if (!info) {
    console.error('样本包不是快照包，无法基准。')
    process.exitCode = 1
    return
  }
  console.log(`包内条目：${info.fileCount} 个文件，解压约 ${mb(info.unpackedBytes)}MB，profileId=${info.profileId}`)

  const sourceProfileId = info.profileId ?? 'bench'

  if (reuse) {
    console.log('--reuse：跳过解包与遍历统计')
  } else {
    await elapsed('导入解压 extractSnapshot', async () => {
      const result = await extractSnapshot(SAMPLE_ZIP, HOME_DIR, { newId: sourceProfileId })
      return { detail: `链接 ${result.links}，跳过 ${result.skipped}` }
    })

    await elapsed('遍历 stat 串行', async () => {
      const r = await walkSerial(HOME_DIR)
      return { detail: `${r.files} 文件 / ${mb(r.bytes)}MB` }
    })

    await elapsed('遍历 stat 并发32', async () => {
      const r = await walkBatched(HOME_DIR)
      return { detail: `${r.files} 文件 / ${mb(r.bytes)}MB` }
    })
  }

  // 打包这一项必须 A/B 同轮对比：跨轮次不可比（同一台机器上未改动的代码
  // 曾测出 25s 与 57s 两份结果，是磁盘/杀软状态漂移，不是代码差异）。
  const plan = await (async () => {
    let captured: Awaited<ReturnType<typeof planSnapshot>> | null = null
    await elapsed('导出扫描 planSnapshot', async () => {
      captured = await planSnapshot(HOME_DIR, { packId: sourceProfileId })
      return { detail: `${captured.entries.length} 条目 / ${mb(captured.totalBytes)}MB` }
    })
    return captured!
  })()

  const baselineZip = path.join(WORK_DIR, 'out-yazl6.zip')
  const baselineRuns: number[] = []
  const optimizedRuns: number[] = []
  for (let round = 0; round < 2; round += 1) {
    const baselineStarted = Date.now()
    await writeWithYazlLevel6(plan, baselineZip)
    baselineRuns.push((Date.now() - baselineStarted) / 1000)
    const optimizedStarted = Date.now()
    await writeSnapshotZip(plan, OUT_ZIP, {})
    optimizedRuns.push((Date.now() - optimizedStarted) / 1000)
  }
  const packSeconds = Math.min(...optimizedRuns)
  const baselineSeconds = Math.min(...baselineRuns)
  const out = await stat(OUT_ZIP)
  const baselineOut = await stat(baselineZip)

  console.log('\n===== 基准结果 =====')
  for (const timing of timings) {
    console.log(`${timing.label.padEnd(34)} ${timing.seconds.toFixed(2)}s  ${timing.detail ?? ''}`)
  }
  console.log(`打包 yazl level6      ${baselineSeconds.toFixed(2)}s  ${mb(baselineOut.size)}`)
  console.log(`打包 新写入器+降档     ${packSeconds.toFixed(2)}s  ${mb(out.size)}`)
  console.log(`                       提速 ${(baselineSeconds / packSeconds).toFixed(2)}×，体积 ${(out.size / baselineOut.size).toFixed(2)}×`)
  console.log(`导出物保留在 ${OUT_ZIP}（unzip -t 校验完手动删 .bench-tmp）`)
}

await main()
