import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from '../electron/fs-atomic'

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'fs-atomic-'))
}

/** 整份载荷写成一句 JSON：撕裂后必然解析失败或只剩半截。 */
function payload(tag: string, bytes: number) {
  return JSON.stringify({ tag, body: 'x'.repeat(bytes) })
}

describe('writeFileAtomic', () => {
  it('写入并读回，父目录不存在时自动建', async () => {
    const root = await workspace()
    const target = path.join(root, 'nested', 'settings.json')
    await writeFileAtomic(target, payload('a', 16))
    expect(JSON.parse(await readFile(target, 'utf8')).tag).toBe('a')
  })

  it('两个写者并发打同一条路径：结果必须是其中一份完整载荷，不能是拼接体', async () => {
    const root = await workspace()
    const target = path.join(root, 'receipts.json')
    const left = payload('left', 4096)
    const right = payload('right', 64)
    // 一大一小交替：固定临时名时，小那份会在大那份还没写完时把同一个文件 rename 走。
    for (let round = 0; round < 40; round += 1) {
      await Promise.all([writeFileAtomic(target, left), writeFileAtomic(target, right)])
      const text = await readFile(target, 'utf8')
      expect(() => JSON.parse(text)).not.toThrow()
      expect([left, right]).toContain(text)
    }
  })

  it('目标已存在时直接覆盖，不需要预先删除', async () => {
    const root = await workspace()
    const target = path.join(root, 'registry.json')
    await writeFile(target, 'stale', 'utf8')
    await writeFileAtomic(target, 'fresh')
    expect(await readFile(target, 'utf8')).toBe('fresh')
  })

  it('rename 失败时抛错并收掉临时文件，目录里不攒残留', async () => {
    const root = await workspace()
    // 目标位置放一个目录：rename 覆盖必然失败（POSIX EISDIR / Windows EPERM 重试后仍失败）。
    const target = path.join(root, 'config.json')
    await writeFileAtomic(target, payload('first', 8))
    await rm(target)
    await mkdir(target)
    await expect(writeFileAtomic(target, payload('second', 8))).rejects.toThrow()
    expect(await readdir(root)).toEqual(['config.json'])
  })

  // Windows 上重命名覆盖一个正被打开的目标会 EPERM——旧代码为此退回截断直写，
  // 那正是撕裂的成因。这条锁住新语义：写失败可以，把已有完好内容截断不行。
  it.skipIf(process.platform !== 'win32')('rename 被并发读者挡住时抛错，且不截断已有内容', async () => {
    const root = await workspace()
    const target = path.join(root, 'packs.json')
    const original = payload('original', 4096)
    await writeFileAtomic(target, original)
    const handle = await open(target, 'r+')
    try {
      await expect(writeFileAtomic(target, payload('replacement', 8192), { fallbackToDirectWrite: true })).rejects.toThrow()
    } finally {
      await handle.close()
    }
    expect(await readFile(target, 'utf8')).toBe(original)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  // POSIX 权限位；Windows 上 mode 不参与访问控制，跳过而不是写成恒真断言。
  it.skipIf(process.platform === 'win32')('mode 作用到最终文件：凭据文件不能留成 0644', async () => {
    const root = await workspace()
    const target = path.join(root, 'credentials.json')
    await writeFileAtomic(target, '{}', { mode: 0o600 })
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })
})
