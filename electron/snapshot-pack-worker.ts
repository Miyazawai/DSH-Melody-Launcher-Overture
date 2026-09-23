/**
 * 快照打包 worker：把 zip 的读文件 + CRC + deflate 搬出 Electron 主进程。
 *
 * 为什么需要：这些活以前全在主进程里跑，导出一个 392MB / 16490 文件的包时，
 * 整个启动器界面会发顿（yazl 依赖的 buffer-crc32 还是纯 JS 实现）。
 * 条目清单由主进程准备好了传来（只有几个字节的 data 内联，正文都按路径在
 * worker 里读），所以消息体积很小。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { writeZipArchive, type ZipEntryInput } from './zip-writer'

interface WorkerRequest {
  targetZipPath: string
  entries: ZipEntryInput[]
  /** 进度回传的节流间隔。 */
  progressIntervalMs?: number
}

interface WorkerResponse {
  type: 'bytes' | 'done' | 'error'
  readBytes?: number
  entries?: number
  archiveBytes?: number
  message?: string
}

const request = workerData as WorkerRequest
const post = (message: WorkerResponse): void => {
  parentPort?.postMessage(message)
}

const interval = request.progressIntervalMs ?? 200
let reported = 0
let lastPost = 0

try {
  const result = await writeZipArchive(request.targetZipPath, request.entries, {
    onBytes: bytes => {
      reported += bytes
      const now = Date.now()
      if (now - lastPost < interval) return
      lastPost = now
      post({ type: 'bytes', readBytes: reported })
    },
  })
  post({ type: 'bytes', readBytes: reported })
  post({ type: 'done', entries: result.entries, archiveBytes: result.archiveBytes })
} catch (error) {
  post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
}
