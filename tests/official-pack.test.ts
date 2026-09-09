import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureOfficialPack,
  officialPackAssetName,
  officialPackDisplayName,
} from '../electron/official-pack'
import { readPackRegistry, writePackRegistry, type PackRecord } from '../electron/pack-registry'
import { LAUNCHER_RELEASE_REPOSITORY, OFFICIAL_PACK_VERSION } from '../src/constants'
import type { PackImportOptions, PackInstallResult } from '../src/types'

const ENDPOINT = `https://api.github.com/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases/latest`
const ASSET_URL = `https://github.com/${LAUNCHER_RELEASE_REPOSITORY}/releases/download/v0.1.1/${officialPackAssetName()}`
const ZIP_BYTES = Buffer.from('SNAPSHOT-ZIP-CONTENT')

function releaseJson(withAsset: boolean): Response {
  return new Response(JSON.stringify({
    tag_name: 'v0.1.1',
    html_url: `https://github.com/${LAUNCHER_RELEASE_REPOSITORY}/releases/tag/v0.1.1`,
    assets: withAsset ? [{ name: officialPackAssetName(), browser_download_url: ASSET_URL, size: ZIP_BYTES.length }] : [],
  }), { status: 200 })
}

function fetchFor(onUrl: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => onUrl(String(input))) as typeof fetch
}

function record(id: string, extra: Partial<PackRecord> = {}): PackRecord {
  return {
    id, name: id, description: '', version: '1.0.0',
    source: 'created', installedAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    state: 'complete', plugins: [], ...extra,
  }
}

async function tempPaths(): Promise<{ root: string; registryPath: string; downloadDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-official-pack-'))
  return { root, registryPath: path.join(root, 'packs.json'), downloadDir: path.join(root, 'pack-snapshots') }
}

describe('ensureOfficialPack', () => {
  it('同版本官方包已存在时零网络、不导入', async () => {
    const { registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [record('official', { officialVersion: OFFICIAL_PACK_VERSION })])
      let touched = 0
      const outcome = await ensureOfficialPack({
        registryPath,
        importPack: async () => { touched += 1; return { id: 'x', installed: [], failures: [], state: 'complete' } },
        fetchImpl: fetchFor(() => { touched += 1; return releaseJson(true) }),
        downloadDir,
      })
      expect(outcome.outcome).toBe('present')
      expect(touched).toBe(0)
    } finally { await rm(registryPath, { force: true }).catch(() => undefined) }
  })

  it('缺失时下载导入：官方显示名 + 盖版本戳 + 清理临时 zip', async () => {
    const { root, registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [])
      const calls: Array<{ filePath: string; options?: PackImportOptions }> = []
      const outcome = await ensureOfficialPack({
        registryPath,
        importPack: async (filePath, _items, options) => {
          calls.push({ filePath, options })
          // 模拟真实导入：往注册表落一条新记录。
          const records = await readPackRegistry(registryPath)
          await writePackRegistry(registryPath, [...records, record('pack-official-imported', { name: options?.name ?? '' })])
          return { id: 'pack-official-imported', installed: [], failures: [], state: 'complete' }
        },
        fetchImpl: fetchFor(url => {
          if (url === ENDPOINT) return releaseJson(true)
          if (url === ASSET_URL) return new Response(Uint8Array.from(ZIP_BYTES), { status: 200, headers: { 'content-length': String(ZIP_BYTES.length) } })
          throw new Error(`unexpected ${url}`)
        }),
        downloadDir,
      })
      expect(outcome.outcome).toBe('imported')
      expect(calls).toHaveLength(1)
      expect(calls[0].options?.name).toBe(officialPackDisplayName())
      expect(existsSync(calls[0].filePath)).toBe(false) // finally 里删掉了临时 zip
      const records = await readPackRegistry(registryPath)
      expect(records.find(item => item.id === 'pack-official-imported')?.officialVersion).toBe(OFFICIAL_PACK_VERSION)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('Release 可达但没有官方包资产 → no-asset，不导入', async () => {
    const { root, registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [])
      let imported = false
      const outcome = await ensureOfficialPack({
        registryPath,
        importPack: async () => { imported = true; return { id: 'x', installed: [], failures: [], state: 'complete' } },
        fetchImpl: fetchFor(url => {
          if (url === ENDPOINT) return releaseJson(false)
          throw new Error(`unexpected ${url}`)
        }),
        downloadDir,
      })
      expect(outcome.outcome).toBe('no-asset')
      expect(imported).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('所有源不可达 → failed，不抛异常', async () => {
    const { root, registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [])
      const outcome = await ensureOfficialPack({
        registryPath,
        importPack: async (): Promise<PackInstallResult> => ({ id: 'x', installed: [], failures: [], state: 'complete' }),
        fetchImpl: fetchFor(() => { throw new Error('offline') }),
        downloadDir,
      })
      expect(outcome.outcome).toBe('failed')
      expect(outcome.message).toContain('GitHub Release')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('导入抛错 → failed 且临时 zip 被清理', async () => {
    const { root, registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [])
      const outcome = await ensureOfficialPack({
        registryPath,
        importPack: async () => { throw new Error('zip 结构不受支持') },
        fetchImpl: fetchFor(url => {
          if (url === ENDPOINT) return releaseJson(true)
          return new Response(Uint8Array.from(ZIP_BYTES), { status: 200, headers: { 'content-length': String(ZIP_BYTES.length) } })
        }),
        downloadDir,
      })
      expect(outcome.outcome).toBe('failed')
      expect(outcome.message).toContain('zip 结构不受支持')
      expect(existsSync(path.join(downloadDir, officialPackAssetName()))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
