import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PackManifest } from '../src/types'
import { readPackRegistry, upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { readPluginReceipts, recordPluginInstall } from '../electron/plugin-receipts'
import { readPresetReceipts, recordPresetInstall } from '../electron/preset-receipts'
import { readSkillReceipts, recordSkillInstall } from '../electron/skill-receipts'
import { readPackManifest, writePackManifest } from '../electron/pack-manifest-store'
import { serializePackManifest } from '../electron/pack-manifest'

/**
 * 0.1.3 整理把 13 处"写临时文件 + rename"收敛到 electron/fs-atomic.ts。
 * 这些调用点此前共用一个固定 `.tmp` 名：两个写者打同一条路径时，后 rename 的会把
 * 对方还没写完的半截载荷一起带走，读者拿到撕裂 JSON（本仓库真出过这起事故）。
 *
 * 现有测试全是顺序写，抓不到这个 bug 类，所以这里专门做并发写 + 并发读：
 * 断言任何一次读都必须是可解析的完整文件，且目录里不留 .tmp 残留。
 */

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dml-write-integrity-'))
  temporaryRoots.push(root)
  return root
}

function packRecord(id: string): PackRecord {
  return {
    id, name: id, description: '', version: '1.0.0',
    homePath: path.join('/tmp', id), source: 'created',
    installedAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    state: 'complete', plugins: [],
  }
}

const pluginReceipt = (packageName: string) => ({
  repository: 'demo/plugin', packageName, packId: 'pack-web', source: 'npm' as const,
  subdirectory: null, version: '1.0.0', commit: 'a'.repeat(40), installedAt: '2026-08-14T00:00:00.000Z',
})

const presetReceipt = (name: string) => ({
  name, repository: 'yjh051108/dsh-router-standard', sourcePath: `preset/${name}`,
  revision: 'e'.repeat(40), installedAt: '2026-08-23T00:00:00.000Z',
})

const skillReceipt = (name: string) => ({
  name, format: 'bundle' as const, repository: 'yjh051108/dsh-skills', sourcePath: `skills/${name}`,
  revision: 'c'.repeat(40), installedAt: '2026-08-23T00:00:00.000Z',
})

const manifest = (description: string): PackManifest => ({
  name: 'Alpha', description, version: '1.0.0', plugins: [{ packageName: '@demo/plugin', source: 'npm' }],
})

/**
 * 交替写与读，断言**任何一次读都拿到完整可解析的文件**。
 *
 * 只测撕裂，不要求"读者零延迟死循环打同一条路径时写仍成功"——那是人造最坏情况：
 * Windows 上 rename 覆盖一个正被读者打开的文件会 EPERM，旧代码正是为了绕开它才
 * 退回截断直写，而那恰恰是撕裂的来源。现在改成抛错（数据完好优先），所以这里
 * 写失败允许重试，撕裂不允许发生。
 */
async function storm(label: string, write: (index: number) => Promise<unknown>, read: () => Promise<unknown>) {
  const torn: string[] = []
  let written = 0
  for (let index = 0; index < 24; index++) {
    try {
      await write(index)
      written++
    } catch {
      // EPERM（读者正持有目标）允许：数据没坏，调用方重试即可。
    }
    // 每写一次，读几回——覆盖"rename 落地那一刻读者看到什么"。
    for (let probe = 0; probe < 4; probe++) {
      try {
        await read()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          torn.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
  }
  expect(torn.slice(0, 3), `${label}：读到过撕裂内容`).toEqual([])
  expect(written, `${label}：至少要有写入成功，否则这条断言是空的`).toBeGreaterThan(12)
}

describe('迁移到 fs-atomic 后的写入完整性', () => {
  it('packs.json：并发 upsert 不产生撕裂，最终记录数正确', async () => {
    const root = await workspace()
    const registryPath = path.join(root, 'packs.json')
    await storm('registry', index => upsertPackRecord(registryPath, packRecord(`pack-${index % 6}`)), async () => readPackRegistry(registryPath))
    expect(await readPackRegistry(registryPath)).toHaveLength(6)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('三类 receipts：并发记录不撕裂', async () => {
    const root = await workspace()
    const pluginPath = path.join(root, 'plugin-installs.json')
    const presetPath = path.join(root, 'preset-installs.json')
    const skillPath = path.join(root, 'skill-installs.json')
    await storm('plugin', index => recordPluginInstall(pluginPath, pluginReceipt(`@demo/plugin-${index % 5}`)), () => readPluginReceipts(pluginPath))
    await storm('preset', index => recordPresetInstall(presetPath, presetReceipt(`preset-${index % 4}`)), () => readPresetReceipts(presetPath))
    await storm('skill', index => recordSkillInstall(skillPath, skillReceipt(`skill-${index % 7}`)), () => readSkillReceipts(skillPath))
    expect(await readPluginReceipts(pluginPath)).toHaveLength(5)
    expect(await readPresetReceipts(presetPath)).toHaveLength(4)
    expect(await readSkillReceipts(skillPath)).toHaveLength(7)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('包清单 yaml：并发写后仍是合法 YAML 且能读回', async () => {
    const root = await workspace()
    const manifestRoot = path.join(root, 'manifests')
    await storm('manifest', index => writePackManifest(manifestRoot, 'pack-web', manifest(`第 ${index} 次描述，长度不一` + '。'.repeat(index % 200))), () => readPackManifest(manifestRoot, 'pack-web'))
    const written = await readFile(path.join(manifestRoot, 'pack-web.yaml'), 'utf8')
    expect(written).toContain('name: Alpha')
    expect(serializePackManifest(manifest('x'))).toContain('name: Alpha')
    expect((await readdir(manifestRoot)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('唯一临时名不累积：上一次运行留下的陈旧 .tmp 在本进程首次写该目录时被收掉', async () => {
    const root = await workspace()
    const registryPath = path.join(root, 'packs.json')
    // 伪造"上次进程死在 rename 之前"留下的唯一名临时文件，时间戳拨到两小时前。
    const stale = `${registryPath}.99999.${Date.now() - 7_200_000}.1.tmp`
    await writeFile(stale, 'garbage', 'utf8')
    // 清扫按 mtime 判陈旧，所以要把文件时间拨回两小时前，光改文件名里的时间戳没用。
    const twoHoursAgo = new Date(Date.now() - 7_200_000)
    await utimes(stale, twoHoursAgo, twoHoursAgo)
    await upsertPackRecord(registryPath, packRecord('pack-tui'))
    expect(await readdir(root)).not.toContain(path.basename(stale))
    expect(await readPackRegistry(registryPath)).toHaveLength(1)
  })
})
