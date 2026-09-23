/**
 * 快照专用的最小 ZIP 写入器：顺序写、UTF-8 条目名、store / deflate、
 * 尺寸未知时走 data descriptor，条目数超过 0xffff 时补 zip64 结束记录。
 *
 * 为什么不用 yazl：真机官方包 16490 个文件 / 392MB，yazl 光条目机制就要 3.6s
 * （每条目 5 个流对象 + buffer-crc32 的纯 JS CRC + 逐条目建 deflate 上下文）。
 * 换成「小文件一次 readFile + 原生 zlib.crc32 + deflateRawSync」后同一棵树实测 6.6s。
 *
 * 不做每条目 zip64：调用方（writeSnapshotZip）在内容总量逼近 4GB 前退回 yazl，
 * 所以条目体积与整体偏移都在 uint32 内；只有条目数可能撑破 uint16，那才需要 zip64 EOCD。
 */
import { createReadStream } from 'node:fs'
import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { PassThrough, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as zlib from 'node:zlib'

const STORE_METHOD = 0
const DEFLATE_METHOD = 8

const FLAG_DATA_DESCRIPTOR = 0x08
const FLAG_UTF8_NAME = 0x800

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const DESCRIPTOR_SIGNATURE = 0x08074b50
const CENTRAL_SIGNATURE = 0x02014b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const EOCD_SIGNATURE = 0x06054b50

const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const DESCRIPTOR_SIZE = 16
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff

/** 条目时间戳固定：为拿 mtime 给每个文件补一次 stat 不划算，解出落盘时时间戳也会重设。 */
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1

/** 这个大小以内一次读进内存压缩；超过走流式，避免把大文件整块驻留。 */
export const ZIP_INLINE_MAX_BYTES = 4 * 1024 * 1024

/** 内容总量超过它就别用本写入器（不写每条目 zip64），交给 yazl 兜底。 */
export const ZIP64_CONTENT_THRESHOLD_BYTES = 3_500 * 1024 * 1024

export interface ZipEntryInput {
  /** zip 内路径（正斜杠、不带前导 `/`、不含 `.` / `..` 段）。 */
  name: string
  /** 内容来源：`source`（文件路径）与 `data`（已就绪内容）二选一。 */
  source?: string
  data?: Buffer
  /** `source` 的字节数；给出可省一次 stat。 */
  size?: number
  /** 0 = store；1–9 = deflate 档位。 */
  level: number
}

export interface ZipWriterOptions {
  /** 每落一个条目回调一次已读取的未压缩字节数（导出进度）。 */
  onBytes?: (readBytes: number) => void
  /** 强制写 zip64 结束记录，给条目数溢出路径留个可测的抓手。 */
  forceZip64Eocd?: boolean
}

export interface ZipWriteResult {
  entries: number
  sourceBytes: number
  archiveBytes: number
}

type Crc32Fn = (data: Uint8Array, value?: number) => number

/** Node ≥ 20.15 才有原生 crc32；没有就退回表法实现。 */
const nativeCrc32 = (zlib as unknown as { crc32?: Crc32Fn }).crc32

let crcTable: Uint32Array | null = null

function fallbackCrc32(data: Uint8Array, seed = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let current = index
      for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
      crcTable[index] = current >>> 0
    }
  }
  let crc = ~seed
  for (let index = 0; index < data.length; index += 1) {
    crc = (crc >>> 8) ^ crcTable![(crc ^ data[index]!) & 0xff]!
  }
  return (~crc) >>> 0
}

function crc32Update(seed: number, data: Uint8Array): number {
  return nativeCrc32 ? nativeCrc32(data, seed) >>> 0 : fallbackCrc32(data, seed)
}

function localHeader(
  name: Buffer,
  method: number,
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  descriptor: boolean,
): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE)
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
  header.writeUInt16LE(20, 4)
  // bit3 只能显式给：空文件的 crc 与尺寸本来就是 0，按数值推断会留给读者一个
  // 永远不会出现的 data descriptor（node_modules 里空文件很常见）。
  header.writeUInt16LE(FLAG_UTF8_NAME | (descriptor ? FLAG_DATA_DESCRIPTOR : 0), 6)
  header.writeUInt16LE(method, 8)
  header.writeUInt16LE(DOS_TIME, 10)
  header.writeUInt16LE(DOS_DATE, 12)
  header.writeUInt32LE(crc >>> 0, 14)
  header.writeUInt32LE(compressedSize >>> 0, 18)
  header.writeUInt32LE(uncompressedSize >>> 0, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return header
}

function centralHeader(
  name: Buffer,
  method: number,
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  localHeaderAt: number,
): Buffer {
  const record = Buffer.alloc(CENTRAL_HEADER_SIZE)
  record.writeUInt32LE(CENTRAL_SIGNATURE, 0)
  record.writeUInt16LE(20, 4)
  record.writeUInt16LE(20, 6)
  record.writeUInt16LE(FLAG_UTF8_NAME, 8)
  record.writeUInt16LE(method, 10)
  record.writeUInt16LE(DOS_TIME, 12)
  record.writeUInt16LE(DOS_DATE, 14)
  record.writeUInt32LE(crc >>> 0, 16)
  record.writeUInt32LE(compressedSize >>> 0, 20)
  record.writeUInt32LE(uncompressedSize >>> 0, 24)
  record.writeUInt16LE(name.length, 28)
  record.writeUInt16LE(0, 30)
  record.writeUInt16LE(0, 32)
  record.writeUInt16LE(0, 34)
  record.writeUInt16LE(0, 36)
  // `<<` 是有符号 32 位，0o100664 << 16 会变负数，必须 >>> 0 收回无符号。
  record.writeUInt32LE((0o100664 << 16) >>> 0, 38)
  record.writeUInt32LE(localHeaderAt >>> 0, 42)
  return Buffer.concat([record, name])
}

function assertEntryName(name: string, encoded: Buffer): void {
  if (!name) throw new Error('zip 条目名不能为空。')
  if (name.startsWith('/') || name.includes('\\')) throw new Error(`zip 条目名不合法：${name}`)
  if (name.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`zip 条目名不合法：${name}`)
  }
  if (encoded.length > UINT16_MAX) throw new Error(`zip 条目名过长：${name}`)
}

/** 同时在途的条目数：读一个文件要一次打开/读/关闭，Windows 上单次不贵但架不住上万次串起来。 */
const PIPELINE_WINDOW = 8

interface PreparedEntry {
  /** 本地头 + 条目名 + 数据，一次定位写入。 */
  block: Buffer
  name: Buffer
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
}

/** 小条目准备：读 + CRC + 同步 deflate。压不动就退回 store（deflate 后变大是常态，不该倒贴体积）。 */
async function prepareInlineEntry(entry: ZipEntryInput, name: Buffer): Promise<PreparedEntry> {
  const raw = entry.data ?? (await readFile(entry.source!))
  const { method, payload } = entry.level === 0
    ? { method: STORE_METHOD, payload: raw }
    : (() => {
      const deflated = zlib.deflateRawSync(raw, { level: entry.level })
      return deflated.length >= raw.length ? { method: STORE_METHOD, payload: raw } : { method: DEFLATE_METHOD, payload: deflated }
    })()
  const crc = crc32Update(0, raw)
  return {
    block: Buffer.concat([localHeader(name, method, crc, payload.length, raw.length, false), name, payload]),
    name,
    method,
    crc,
    compressedSize: payload.length,
    uncompressedSize: raw.length,
  }
}

/** 大文件：边读边算 CRC，压缩后直接定位写入。 */
async function streamEntry(
  fh: FileHandle,
  sourcePath: string,
  name: Buffer,
  at: number,
  level: number,
): Promise<{ method: number; crc: number; compressedSize: number; uncompressedSize: number }> {
  const method = level === 0 ? STORE_METHOD : DEFLATE_METHOD
  let crc = 0
  let uncompressedSize = 0
  let compressedSize = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      crc = crc32Update(crc, bytes)
      uncompressedSize += bytes.length
      callback(null, bytes)
    },
  })
  const compressor = level === 0 ? new PassThrough() : zlib.createDeflateRaw({ level })
  let position = at + LOCAL_HEADER_SIZE + name.length
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      fh.write(bytes, 0, bytes.length, position).then(
        () => {
          position += bytes.length
          compressedSize += bytes.length
          callback()
        },
        error => callback(error instanceof Error ? error : new Error(String(error))),
      )
    },
  })
  // 本地头先占位（尺寸与 CRC 还不知道），真值写在尾后的 data descriptor 与中央目录里。
  const head = Buffer.concat([localHeader(name, method, 0, 0, 0, true), name])
  await fh.write(head, 0, head.length, at)
  await pipeline(createReadStream(sourcePath), counter, compressor, sink)
  return { method, crc, compressedSize, uncompressedSize }
}

/** 顺序把条目写成一个 zip 文件。 */
export async function writeZipArchive(
  outputPath: string,
  entries: Iterable<ZipEntryInput>,
  options: ZipWriterOptions = {},
): Promise<ZipWriteResult> {
  const fh = await open(outputPath, 'w')
  const centralRecords: Buffer[] = []
  const pending: Array<{ task: Promise<PreparedEntry>; settled: Promise<void> }> = []
  let offset = 0
  let count = 0
  let sourceBytes = 0
  try {
    /** 结清一个在途条目：准备阶段的读+压缩与其它条目是重叠的，这里只按序落盘。 */
    const flushOne = async (): Promise<void> => {
      const item = pending.shift()
      if (!item) return
      // settled 只为把「已经失败的准备」标记为已处理，避免它在队列里变成 unhandledRejection。
      await item.settled
      const prepared = await item.task
      const headerAt = offset
      await fh.write(prepared.block, 0, prepared.block.length, headerAt)
      offset += prepared.block.length
      centralRecords.push(
        centralHeader(prepared.name, prepared.method, prepared.crc, prepared.compressedSize, prepared.uncompressedSize, headerAt),
      )
      sourceBytes += prepared.uncompressedSize
      options.onBytes?.(prepared.uncompressedSize)
      count += 1
    }
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8')
      assertEntryName(entry.name, nameBuf)
      if (!entry.data && !entry.source) throw new Error(`zip 条目既没有 source 也没有 data：${entry.name}`)
      const size = entry.data?.length
        ?? entry.size
        ?? (await stat(entry.source!).catch(() => null))?.size
      // 源文件在扫描之后被删掉了：跳过这一条，别让整次导出陪葬。
      if (size === undefined) continue
      if (size <= ZIP_INLINE_MAX_BYTES) {
        const task = prepareInlineEntry(entry, nameBuf)
        pending.push({ task, settled: task.then(() => undefined, () => undefined) })
        if (pending.length >= PIPELINE_WINDOW) await flushOne()
        continue
      }
      // 大条目要直接往输出文件里流式写，先把在途的小条目按序结清，偏移才不会错位。
      while (pending.length > 0) await flushOne()
      const headerAt = offset
      const streamed = await streamEntry(fh, entry.source!, nameBuf, headerAt, entry.level)
      const descriptor = Buffer.alloc(DESCRIPTOR_SIZE)
      descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0)
      descriptor.writeUInt32LE(streamed.crc >>> 0, 4)
      descriptor.writeUInt32LE(streamed.compressedSize >>> 0, 8)
      descriptor.writeUInt32LE(streamed.uncompressedSize >>> 0, 12)
      // descriptor 紧跟在压缩数据后面：offset 还停在这条目开头，不能直接拿来用。
      const descriptorAt = headerAt + LOCAL_HEADER_SIZE + nameBuf.length + streamed.compressedSize
      await fh.write(descriptor, 0, descriptor.length, descriptorAt)
      offset = descriptorAt + descriptor.length
      centralRecords.push(
        centralHeader(nameBuf, streamed.method, streamed.crc, streamed.compressedSize, streamed.uncompressedSize, headerAt),
      )
      sourceBytes += streamed.uncompressedSize
      options.onBytes?.(streamed.uncompressedSize)
      count += 1
    }
    while (pending.length > 0) await flushOne()
    const centralDirectoryAt = offset
    for (const record of centralRecords) {
      await fh.write(record, 0, record.length, offset)
      offset += record.length
    }
    const centralDirectorySize = offset - centralDirectoryAt
    if (count > UINT16_MAX || options.forceZip64Eocd === true) {
      const zip64EocdAt = offset
      const zip64Eocd = Buffer.alloc(56)
      zip64Eocd.writeUInt32LE(ZIP64_EOCD_SIGNATURE, 0)
      zip64Eocd.writeBigUInt64LE(BigInt(zip64Eocd.length - 12), 4)
      zip64Eocd.writeUInt16LE(45, 12)
      zip64Eocd.writeUInt16LE(20, 14)
      zip64Eocd.writeUInt32LE(0, 16)
      zip64Eocd.writeUInt32LE(0, 20)
      zip64Eocd.writeBigUInt64LE(BigInt(count), 24)
      zip64Eocd.writeBigUInt64LE(BigInt(count), 32)
      zip64Eocd.writeBigUInt64LE(BigInt(centralDirectorySize), 40)
      zip64Eocd.writeBigUInt64LE(BigInt(centralDirectoryAt), 48)
      await fh.write(zip64Eocd, 0, zip64Eocd.length, zip64EocdAt)
      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0)
      locator.writeUInt32LE(0, 4)
      // locator 里记的是 zip64 EOCD 本身的起始位置，不是它后面。
      locator.writeBigUInt64LE(BigInt(zip64EocdAt), 8)
      locator.writeUInt32LE(1, 16)
      await fh.write(locator, 0, locator.length, zip64EocdAt + zip64Eocd.length)
      offset = zip64EocdAt + zip64Eocd.length + locator.length
    }
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(Math.min(count, UINT16_MAX), 8)
    eocd.writeUInt16LE(Math.min(count, UINT16_MAX), 10)
    eocd.writeUInt32LE(Math.min(centralDirectorySize, UINT32_MAX), 12)
    eocd.writeUInt32LE(Math.min(centralDirectoryAt, UINT32_MAX), 16)
    eocd.writeUInt16LE(0, 20)
    await fh.write(eocd, 0, eocd.length, offset)
    return { entries: count, sourceBytes, archiveBytes: offset + eocd.length }
  } finally {
    await fh.close()
  }
}
