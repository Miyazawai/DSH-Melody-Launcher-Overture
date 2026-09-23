import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import * as yauzl from 'yauzl'
import { afterEach, describe, expect, it } from 'vitest'
import { ZIP_INLINE_MAX_BYTES, writeZipArchive, type ZipEntryInput } from '../electron/zip-writer'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'dsh-zip-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

interface ReadEntry {
  name: string
  method: number
  /** 本地头的 bit3：尺寸/CRC 在数据后面那个 data descriptor 里，而不在本地头里。 */
  usesDescriptor: boolean
  /** bit3 置位时，紧跟数据之后的 descriptor 签名。 */
  descriptorSignature: number
  data: Buffer
}

/** 用启动器导入端真正会走的 yauzl 路径读回来，并直接核对本地头与 descriptor。 */
async function readWithYauzl(zipPath: string): Promise<ReadEntry[]> {
  const rawArchive = await readFile(zipPath)
  const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true })
  const out: ReadEntry[] = []
  for await (const entry of zipfile.eachEntry()) {
    if ((entry as unknown as { isDirectory?: boolean }).isDirectory) continue
    const stream = await zipfile.openReadStreamPromise(entry)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    // 中央目录里的 GP flag 是本地头的副本，但 descriptor 那条只写在本地头上，
    // 所以 bit3 要回到 entry 自己的本地头位置去读。
    const localFlags = rawArchive.readUInt16LE(entry.relativeOffsetOfLocalHeader + 6)
    const afterData = entry.relativeOffsetOfLocalHeader + 30 + entry.fileName.length + entry.compressedSize
    out.push({
      name: entry.fileName,
      method: entry.compressionMethod,
      usesDescriptor: (localFlags & 0x08) !== 0,
      descriptorSignature: rawArchive.readUInt32LE(afterData),
      data: Buffer.concat(chunks),
    })
  }
  return out
}

const text = 'a'.repeat(2048) + 'b'.repeat(2048)

async function buildFixtures(root: string): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>()
  const big = Buffer.from('prefix\n' + 'x'.repeat(ZIP_INLINE_MAX_BYTES + 4096))
  const incompressible = Buffer.alloc(9000)
  for (let i = 0; i < incompressible.length; i += 1) incompressible[i] = (i * 7 + (i >> 3)) & 0xff
  contents.set('empty.txt', Buffer.alloc(0))
  contents.set('tiny.json', Buffer.from('{"a":1}\n'))
  contents.set('lib/index.js', Buffer.from(text))
  contents.set('技能说明.md', Buffer.from('# 中文条目名\n'.repeat(300)))
  contents.set('big.js', big)
  contents.set('native.bin', incompressible)
  contents.set('big-store.bin', Buffer.from('y'.repeat(ZIP_INLINE_MAX_BYTES + 2048)))
  for (const [name, data] of contents) {
    const target = path.join(root, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data)
  }
  return contents
}

function entriesFor(contents: Map<string, Buffer>, root: string): ZipEntryInput[] {
  return [...contents.entries()].map(([name, data]) => ({
    name,
    source: path.join(root, name),
    size: data.length,
    level: name === 'native.bin' || name === 'big-store.bin' ? 0 : 1,
  }))
}

describe('快照 zip 写入器', () => {
  it('条目名、内容、压缩方式都能被 yauzl 原样读回', async () => {
    const root = await temporaryDirectory()
    const contents = await buildFixtures(root)
    const zipPath = path.join(root, 'out.zip')

    const result = await writeZipArchive(zipPath, entriesFor(contents, root))
    expect(result.entries).toBe(contents.size)

    const read = await readWithYauzl(zipPath)
    const byName = new Map(read.map(entry => [entry.name, entry]))
    expect([...byName.keys()].sort()).toEqual([...contents.keys()].sort())
    for (const [name, data] of contents) {
      const entry = byName.get(name)!
      expect(entry.data.equals(data), `${name} 内容应逐字节一致`).toBe(true)
      const stored = ['native.bin', 'big-store.bin', 'empty.txt', 'tiny.json'].includes(name)
      // 不可压后缀、以及 deflate 后反而变大的（空文件 2 字节、9 字节 json）都退回 store。
      expect(entry.method, `${name} 压缩方式`).toBe(stored ? 0 : 8)
    }
    // 超过整块阈值的条目走流式：本地头尺寸留空 + bit3，真值在数据后面的 descriptor 里。
    expect(byName.get('big.js')!.data.length).toBe(contents.get('big.js')!.length)
    expect(byName.get('big.js')!.usesDescriptor).toBe(true)
    expect(byName.get('big.js')!.descriptorSignature).toBe(0x08074b50)
    expect(byName.get('big-store.bin')!.usesDescriptor).toBe(true)
    expect(byName.get('big-store.bin')!.descriptorSignature).toBe(0x08074b50)
    for (const name of ['empty.txt', 'tiny.json', 'lib/index.js', '技能说明.md', 'native.bin']) {
      expect(byName.get(name)!.usesDescriptor, `${name} 不该带 data descriptor`).toBe(false)
    }
    expect(result.archiveBytes).toBe((await readFile(zipPath)).length)
  })

  it('adm-zip 也能读（导出物要经得起第三方工具与资源管理器）', async () => {
    const root = await temporaryDirectory()
    const contents = await buildFixtures(root)
    const zipPath = path.join(root, 'out.zip')
    await writeZipArchive(zipPath, entriesFor(contents, root))

    const archive = new AdmZip(zipPath)
    const entries = archive.getEntries().filter(entry => !entry.isDirectory)
    expect(entries.map(entry => entry.entryName).sort()).toEqual([...contents.keys()].sort())
    for (const entry of entries) {
      expect(entry.getData().equals(contents.get(entry.entryName)!), `${entry.entryName} 内容`).toBe(true)
    }
  })

  it('空条目、data 条目与 store 条目都合法，zip64 结束记录不影响读取', async () => {
    const root = await temporaryDirectory()
    const zipPath = path.join(root, 'out.zip')
    const emptyPath = path.join(root, 'empty')
    await writeFile(emptyPath, Buffer.alloc(0))

    await writeZipArchive(
      zipPath,
      [
        { name: 'from-buffer.txt', data: Buffer.from('inline\n'), level: 1 },
        { name: 'from-file-empty', source: emptyPath, size: 0, level: 1 },
        { name: 'stored.raw', data: Buffer.from('unchanged'), level: 0 },
      ],
      { forceZip64Eocd: true },
    )

    const read = await readWithYauzl(zipPath)
    expect(read.map(entry => entry.name)).toEqual(['from-buffer.txt', 'from-file-empty', 'stored.raw'])
    expect(read[0]!.data.toString()).toBe('inline\n')
    expect(read[1]!.data.length).toBe(0)
    expect(read[2]!.data.toString()).toBe('unchanged')
    expect(read[2]!.method).toBe(0)
    // 空文件的 crc 与尺寸本来就是 0：一旦按数值推断打上 bit3，读者会等一个不存在的 descriptor。
    expect(read[1]!.usesDescriptor).toBe(false)
    expect(read.every(entry => entry.method === 0 || entry.method === 8)).toBe(true)
  })

  it('拒绝越界的条目名', async () => {
    const root = await temporaryDirectory()
    const zipPath = path.join(root, 'out.zip')
    for (const name of ['../escape.txt', '/abs.txt', 'a\\b.txt', 'a//b', './x.txt']) {
      await expect(
        writeZipArchive(zipPath, [{ name, data: Buffer.from('x'), level: 1 }]),
      ).rejects.toThrow(/条目名/)
    }
  })
})
