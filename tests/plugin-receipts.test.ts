import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPluginReceipts, recordPluginInstall, removePluginReceipt } from '../electron/plugin-receipts'

let temporaryDirectory = ''
let receiptPath = ''

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-receipts-'))
  receiptPath = path.join(temporaryDirectory, 'plugin-installs.json')
})
afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('plugin install receipts (keyed by pack)', () => {
  it('updates one package receipt without dropping other packs', async () => {
    const base = {
      repository: 'demo/plugin',
      packageName: '@demo/plugin',
      source: 'npm' as const,
      subdirectory: null,
      version: '1.0.0',
      commit: 'a'.repeat(40),
      installedAt: '2026-08-14T00:00:00.000Z',
    }
    await recordPluginInstall(receiptPath, { ...base, packId: 'pack-web' })
    await recordPluginInstall(receiptPath, { ...base, packId: 'pack-tui' })
    await recordPluginInstall(receiptPath, { ...base, packId: 'pack-web', version: '1.1.0' })

    const receipts = await readPluginReceipts(receiptPath)
    expect(receipts).toHaveLength(2)
    expect(receipts.find(item => item.packId === 'pack-web')?.version).toBe('1.1.0')

    await removePluginReceipt(receiptPath, 'pack-web', '@demo/plugin')
    await expect(readPluginReceipts(receiptPath)).resolves.toMatchObject([{ packId: 'pack-tui' }])
  })

  it('removes only the matching pack+package pair, keeping other packages', async () => {
    const base = {
      repository: 'demo/plugin',
      packageName: '@demo/plugin',
      source: 'npm' as const,
      subdirectory: null,
      version: '1.0.0',
      commit: 'a'.repeat(40),
      installedAt: '2026-08-14T00:00:00.000Z',
    }
    await recordPluginInstall(receiptPath, { ...base, packId: 'pack-web' })
    await recordPluginInstall(receiptPath, { ...base, packageName: '@demo/other', packId: 'pack-web' })
    await recordPluginInstall(receiptPath, { ...base, packId: 'pack-tui' })

    await removePluginReceipt(receiptPath, 'pack-web', '@demo/plugin')

    const receipts = await readPluginReceipts(receiptPath)
    expect(receipts).toHaveLength(2)
    expect(receipts).toMatchObject([
      { packageName: '@demo/other', packId: 'pack-web' },
      { packageName: '@demo/plugin', packId: 'pack-tui' },
    ])
  })

  it('leaves the receipts file untouched when no record matches', async () => {
    const base = {
      repository: 'demo/plugin',
      packageName: '@demo/plugin',
      source: 'npm' as const,
      subdirectory: null,
      version: '1.0.0',
      commit: 'a'.repeat(40),
      installedAt: '2026-08-14T00:00:00.000Z',
    }
    await recordPluginInstall(receiptPath, { ...base, packId: 'pack-web' })

    // 移除不存在的 (pack, package) 组合不应改动现有记录。
    await removePluginReceipt(receiptPath, 'missing', '@demo/plugin')
    await removePluginReceipt(receiptPath, 'pack-web', '@demo/does-not-exist')

    await expect(readPluginReceipts(receiptPath)).resolves.toMatchObject([{ packageName: '@demo/plugin', packId: 'pack-web' }])
  })

  it('normalizes legacy receipts persisted with profileName', async () => {
    const base = {
      repository: 'demo/plugin',
      packageName: '@demo/plugin',
      source: 'npm' as const,
      subdirectory: null,
      version: '1.0.0',
      commit: 'a'.repeat(40),
      installedAt: '2026-08-14T00:00:00.000Z',
    }
    // 旧版磁盘格式：字段叫 profileName；读取时应归一化为 packId。
    await import('node:fs/promises').then(async fs => {
      await fs.writeFile(receiptPath, `${JSON.stringify({ version: 1, installs: [{ ...base, profileName: 'pack-web' }] }, null, 2)}\n`, 'utf8')
    })
    await expect(readPluginReceipts(receiptPath)).resolves.toMatchObject([{ packageName: '@demo/plugin', packId: 'pack-web' }])
  })
})
