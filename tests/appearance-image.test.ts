import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAppearanceAssetName, storeAppearanceImage } from '../electron/appearance'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-appearance-'))
  temporaryRoots.push(root)
  return root
}

describe('storeAppearanceImage', () => {
  it('把选中的图片复制进外观目录并返回固定路径', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'pick.png')
    await writeFile(source, Buffer.from('png-bytes'))
    const directory = path.join(root, 'userData', 'appearance')

    const stored = await storeAppearanceImage(source, 'background', directory)

    expect(stored.path).toBe(path.join(directory, 'background.png'))
    expect(stored.url).toBe('dsh-appearance://background.png')
    expect(await readFile(stored.path, 'utf8')).toBe('png-bytes')
  })

  it('同一用途换图时清掉旧文件（含不同扩展名），另一用途不受影响', async () => {
    const root = await temporaryRoot()
    const directory = path.join(root, 'appearance')
    const png = path.join(root, 'a.png')
    const jpg = path.join(root, 'b.jpg')
    const logo = path.join(root, 'logo.webp')
    await writeFile(png, Buffer.from('a'))
    await writeFile(jpg, Buffer.from('b'))
    await writeFile(logo, Buffer.from('c'))

    await storeAppearanceImage(png, 'background', directory)
    await storeAppearanceImage(logo, 'logo', directory)
    await storeAppearanceImage(jpg, 'background', directory)

    expect((await readdir(directory)).sort()).toEqual(['background.jpg', 'logo.webp'])
  })

  it('拒绝非图片扩展名与超过 10MB 的文件', async () => {
    const root = await temporaryRoot()
    const directory = path.join(root, 'appearance')
    const exe = path.join(root, 'evil.exe')
    const huge = path.join(root, 'huge.png')
    await writeFile(exe, Buffer.from('x'))
    await writeFile(huge, Buffer.alloc(10 * 1024 * 1024 + 1))

    await expect(storeAppearanceImage(exe, 'background', directory)).rejects.toThrow('仅支持')
    await expect(storeAppearanceImage(huge, 'background', directory)).rejects.toThrow('10MB')
    await expect(storeAppearanceImage(path.join(root, 'missing.png'), 'background', directory)).rejects.toThrow('不存在')
  })
})

describe('resolveAppearanceAssetName', () => {
  it('只放行两张固定图', () => {
    expect(resolveAppearanceAssetName('dsh-appearance://background.png')).toBe('background.png')
    expect(resolveAppearanceAssetName('dsh-appearance://logo.WEBP')).toBe('logo.webp')
    expect(resolveAppearanceAssetName('dsh-appearance://background.png/../secret.png')).toBe('background.png')
  })

  it('拒绝任意路径读取与陌生协议', () => {
    expect(resolveAppearanceAssetName('dsh-appearance://secret.png')).toBeNull()
    expect(resolveAppearanceAssetName('dsh-appearance://../../secret.png')).toBeNull()
    expect(resolveAppearanceAssetName('file:///C:/secret.png')).toBeNull()
    expect(resolveAppearanceAssetName('not a url')).toBeNull()
  })
})
