import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyStockAppearance, STOCK_ACTIVE_SKIN_STATE } from '../electron/stock-appearance'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-stock-appearance-'))
  roots.push(root)
  return root
}

describe('applyStockAppearance', () => {
  it('把外观钉回 DSH 原生：active 为 null 且 initialized 为 true', async () => {
    const root = await tempRoot()
    const dshHome = path.join(root, 'pack-home')
    await expect(applyStockAppearance(dshHome)).resolves.toBe(true)
    const written = JSON.parse(await readFile(path.join(dshHome, 'skin-center-active.json'), 'utf8')) as unknown
    expect(written).toEqual(STOCK_ACTIVE_SKIN_STATE)
    expect(written).toEqual({ active: null, initialized: true })
    // 临时文件不残留。
    await expect(readFile(path.join(dshHome, 'skin-center-active.json.dsh-launcher.tmp'), 'utf8')).rejects.toThrow()
  })

  it('覆盖已有的自定义皮肤选择', async () => {
    const root = await tempRoot()
    const dshHome = path.join(root, 'pack-home')
    await writeFile(path.join(root, 'placeholder'), '', 'utf8')
    await applyStockAppearance(dshHome)
    await writeFile(path.join(dshHome, 'skin-center-active.json'), JSON.stringify({ active: 'blue-fantasy', initialized: true }), 'utf8')
    await expect(applyStockAppearance(dshHome)).resolves.toBe(true)
    const written = JSON.parse(await readFile(path.join(dshHome, 'skin-center-active.json'), 'utf8')) as { active?: unknown }
    expect(written.active).toBeNull()
  })

  it('写不进去时返回 false 而不抛（外观重置不能阻断导入）', async () => {
    const root = await tempRoot()
    // 把家目录指到一个已存在的文件上：mkdir 必然失败。
    const blocked = path.join(root, 'not-a-directory')
    await writeFile(blocked, 'x', 'utf8')
    await expect(applyStockAppearance(blocked)).resolves.toBe(false)
  })
})
