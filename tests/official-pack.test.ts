import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  dshVersionOfOfficialPack,
  ensureOfficialPackVersion,
  listOfficialPackVersions,
  officialPackAssetName,
  officialPackDisplayName,
  type OfficialPackDeps,
} from '../electron/official-pack'
import { readPackRegistry, writePackRegistry, type PackRecord } from '../electron/pack-registry'
import { LAUNCHER_RELEASE_REPOSITORY } from '../src/constants'
import type { PackImportOptions } from '../src/types'

const RELEASES_ENDPOINT = `https://api.github.com/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases?per_page=100`
const LATEST_ENDPOINT = `https://api.github.com/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases/latest`
const ZIP_BYTES = Buffer.from('SNAPSHOT-ZIP-CONTENT')

function assetNameUrl(version: string, tag: string): string {
  return `https://github.com/${LAUNCHER_RELEASE_REPOSITORY}/releases/download/${tag}/${officialPackAssetName(version)}`
}

function releaseFixture(tag: string, body: string | null, versions: string[], extra: Record<string, unknown> = {}): unknown {
  return {
    tag_name: tag,
    body,
    published_at: '2026-09-15T16:00:00.000Z',
    draft: false,
    assets: versions.map(version => ({
      name: officialPackAssetName(version),
      browser_download_url: assetNameUrl(version, tag),
      size: ZIP_BYTES.length,
    })),
    ...extra,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

function zipResponse(url: string): Response {
  if (!url.endsWith('.zip')) throw new Error(`unexpected ${url}`)
  return new Response(Uint8Array.from(ZIP_BYTES), { status: 200, headers: { 'content-length': String(ZIP_BYTES.length) } })
}

function fetchFor(onUrl: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => onUrl(String(input))) as typeof fetch
}

function record(id: string, extra: Partial<PackRecord> = {}): PackRecord {
  return {
    id, name: id, description: '', version: '1.0.0',
    source: 'snapshot', installedAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    state: 'complete', plugins: [], ...extra,
  }
}

async function tempPaths(): Promise<{ root: string; registryPath: string; downloadDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-official-pack-'))
  return { root, registryPath: path.join(root, 'packs.json'), downloadDir: path.join(root, 'pack-snapshots') }
}

describe('dshVersionOfOfficialPack', () => {
  it('去掉尾部序号还原适配的 DSH 版本', () => {
    expect(dshVersionOfOfficialPack('0.1.5-rc.2.1')).toBe('0.1.5-rc.2')
    expect(dshVersionOfOfficialPack('0.1.6-alpha.1.2')).toBe('0.1.6-alpha.1')
    expect(dshVersionOfOfficialPack('0.2.0.3')).toBe('0.2.0')
  })

  it('旧命名（包版本 = 启动器版本，与 DSH 无关）解不出来就返回 null，不猜', () => {
    // 去掉尾段后 `0.1` 不是合法版本号 → 名字里没编码 DSH 版本，宁可「未标注」。
    expect(dshVersionOfOfficialPack('0.1.1')).toBeNull()
    expect(dshVersionOfOfficialPack('0.1.9')).toBeNull()
  })
})

describe('listOfficialPackVersions', () => {
  it('扫全部 Release，按版本降序，DSH 版本优先取 Release 正文', async () => {
    const versions = await listOfficialPackVersions({
      fetchImpl: fetchFor(url => {
        if (url !== RELEASES_ENDPOINT) throw new Error(`unexpected ${url}`)
        return jsonResponse([
          releaseFixture('v0.1.1', 'web-all: 0.3.18\n dsh: 0.1.2-rc.1', ['0.1.2-rc.1.1']),
          releaseFixture('v0.1.2', 'web-all: 0.3.22\ndsh: 0.1.5-rc.2', ['0.1.5-rc.2.1', '0.1.5-rc.2.2']),
          releaseFixture('v0.0.9', null, ['9.9.9'], { draft: true }),
        ])
      }),
    })
    expect(versions.map(item => item.version)).toEqual(['0.1.5-rc.2.2', '0.1.5-rc.2.1', '0.1.2-rc.1.1'])
    expect(versions[0]?.dshVersion).toBe('0.1.5-rc.2')
    expect(versions[2]?.dshVersion).toBe('0.1.2-rc.1')
    expect(versions[0]?.releaseTag).toBe('v0.1.2')
    expect(versions[0]?.assetUrl).toBe(assetNameUrl('0.1.5-rc.2.2', 'v0.1.2'))
    // 草稿 Release 不进列表。
    expect(versions.some(item => item.version === '9.9.9')).toBe(false)
  })

  it('正文没记 DSH 版本时从版本号推导', async () => {
    const versions = await listOfficialPackVersions({
      fetchImpl: fetchFor(() => jsonResponse([releaseFixture('v0.2.0', null, ['0.1.5-rc.2.4'])])),
    })
    expect(versions[0]?.dshVersion).toBe('0.1.5-rc.2')
  })

  it('旧命名 + 正文无元信息 → dshVersion 为 null（不许拿包版本号冒充）', async () => {
    // 真机现状：official-pack-v0.1.1.zip 挂在启动器的 v0.1.1 Release 上，正文是更新日志，没有 dsh: 行。
    const versions = await listOfficialPackVersions({
      fetchImpl: fetchFor(() => jsonResponse([
        releaseFixture('v0.1.1', '# v0.1.1 — 下载即用：官方默认整合包 + Office 技能\n\n## ✨ 新增\n\n- 官方默认整合包…', ['0.1.1']),
        releaseFixture('v0.1.2', 'web-all: 0.3.22\ndsh: 0.1.5-rc.2', ['0.1.5-rc.2.1']),
      ])),
    })
    expect(versions.map(item => item.version)).toEqual(['0.1.5-rc.2.1', '0.1.1'])
    expect(versions[1]?.dshVersion).toBeNull()
  })

  it('限流 403 给出可读错误；直连失败时走镜像候选', async () => {
    await expect(listOfficialPackVersions({
      fetchImpl: fetchFor(() => new Response('', { status: 403 })),
    })).rejects.toThrow('额度')

    const seen: string[] = []
    const versions = await listOfficialPackVersions({
      fetchImpl: fetchFor(url => {
        seen.push(url)
        if (url === `https://gh-proxy.com/${RELEASES_ENDPOINT}`) {
          return jsonResponse([releaseFixture('v0.1.2', null, ['0.1.5-rc.2.1'])])
        }
        return new Response('', { status: 502 })
      }),
    })
    expect(versions.map(item => item.version)).toEqual(['0.1.5-rc.2.1'])
    expect(seen.length).toBeGreaterThan(1)
  })
})

describe('ensureOfficialPackVersion', () => {
  it('该版本已导入时零网络、不导入', async () => {
    const { registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [record('official', { officialVersion: '0.1.5-rc.2.1' })])
      let touched = 0
      const outcome = await ensureOfficialPackVersion({
        registryPath,
        importPack: async () => { touched += 1; return { id: 'x', installed: [], failures: [], state: 'complete' } },
        fetchImpl: fetchFor(() => { touched += 1; return jsonResponse([]) }),
        downloadDir,
      }, '0.1.5-rc.2.1')
      expect(outcome.outcome).toBe('present')
      expect(touched).toBe(0)
    } finally { await rm(registryPath, { force: true }).catch(() => undefined) }
  })

  it('缺失时下载导入：官方显示名 + 盖版本戳 + 外观回原生 + 清理临时 zip', async () => {
    const { root, registryPath, downloadDir } = await tempPaths()
    const packHome = path.join(root, 'packs', 'pack-test')
    try {
      await writePackRegistry(registryPath, [])
      const calls: Array<{ filePath: string; options?: PackImportOptions }> = []
      const deps: OfficialPackDeps = {
        registryPath,
        importPack: async (filePath, _items, options) => {
          calls.push({ filePath, options })
          // 模拟真实导入：往注册表落一条带家目录的新记录。
          const records = await readPackRegistry(registryPath)
          await writePackRegistry(registryPath, [
            ...records,
            record('pack-test', { name: options?.name ?? '', homePath: packHome }),
          ])
          return { id: 'pack-test', installed: [], failures: [], state: 'complete' }
        },
        fetchImpl: fetchFor(url => {
          if (url === RELEASES_ENDPOINT) return jsonResponse([releaseFixture('v0.1.2', 'dsh: 0.1.5-rc.2', ['0.1.5-rc.2.1'])])
          return zipResponse(url)
        }),
        downloadDir,
      }

      const outcome = await ensureOfficialPackVersion(deps, '0.1.5-rc.2.1')

      expect(outcome.outcome).toBe('imported')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.options?.name).toBe(officialPackDisplayName('0.1.5-rc.2.1'))
      expect(calls[0]?.options?.name).toBe('官方默认整合包 0.1.5-rc.2.1')
      expect(existsSync(calls[0]!.filePath)).toBe(false)
      const records = await readPackRegistry(registryPath)
      expect(records.find(item => item.id === 'pack-test')?.officialVersion).toBe('0.1.5-rc.2.1')
      // 导入后外观被钉回 DSH 原生：skin-center 的 seed 需要 active===null 且未初始化才会覆盖。
      await expect(readFile(path.join(packHome, 'skin-center-active.json'), 'utf8')).resolves
        .toBe('{\n  "active": null,\n  "initialized": true\n}\n')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('Release 列表读不到时回退 releases/latest 取同名资产', async () => {
    const { root, registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [])
      const outcome = await ensureOfficialPackVersion({
        registryPath,
        importPack: async () => {
          const records = await readPackRegistry(registryPath)
          await writePackRegistry(registryPath, [...records, record('pack-test')])
          return { id: 'pack-test', installed: [], failures: [], state: 'complete' }
        },
        fetchImpl: fetchFor(url => {
          if (url === LATEST_ENDPOINT) {
            return jsonResponse({ tag_name: 'v0.1.2', assets: [{ name: officialPackAssetName('0.1.5-rc.2.1'), browser_download_url: assetNameUrl('0.1.5-rc.2.1', 'v0.1.2'), size: ZIP_BYTES.length }] })
          }
          if (url.endsWith('.zip')) return zipResponse(url)
          // 列表端点（含镜像候选）全部不可达。
          return new Response('', { status: 502 })
        }),
        downloadDir,
      }, '0.1.5-rc.2.1')
      expect(outcome.outcome).toBe('imported')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('资产不存在 → no-asset，不导入', async () => {
    const { root, registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [])
      let imported = false
      const outcome = await ensureOfficialPackVersion({
        registryPath,
        importPack: async () => { imported = true; return { id: 'x', installed: [], failures: [], state: 'complete' } },
        fetchImpl: fetchFor(url => {
          if (url === RELEASES_ENDPOINT) return jsonResponse([releaseFixture('v0.1.2', null, ['0.1.5-rc.2.1'])])
          if (url === LATEST_ENDPOINT) return jsonResponse({ tag_name: 'v0.1.2', assets: [] })
          return new Response('', { status: 404 })
        }),
        downloadDir,
      }, '0.1.9-rc.9.1')
      expect(outcome.outcome).toBe('no-asset')
      expect(imported).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('全部源不可达 → failed，不抛异常', async () => {
    const { root, registryPath, downloadDir } = await tempPaths()
    try {
      await writePackRegistry(registryPath, [])
      const outcome = await ensureOfficialPackVersion({
        registryPath,
        importPack: async () => ({ id: 'x', installed: [], failures: [], state: 'complete' }),
        fetchImpl: fetchFor(() => { throw new Error('offline') }),
        downloadDir,
      }, '0.1.5-rc.2.1')
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
      const outcome = await ensureOfficialPackVersion({
        registryPath,
        importPack: async () => { throw new Error('zip 结构不受支持') },
        fetchImpl: fetchFor(url => {
          if (url === RELEASES_ENDPOINT) return jsonResponse([releaseFixture('v0.1.2', null, ['0.1.5-rc.2.1'])])
          return zipResponse(url)
        }),
        downloadDir,
      }, '0.1.5-rc.2.1')
      expect(outcome.outcome).toBe('failed')
      expect(outcome.message).toContain('zip 结构不受支持')
      expect(existsSync(path.join(downloadDir, officialPackAssetName('0.1.5-rc.2.1')))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
