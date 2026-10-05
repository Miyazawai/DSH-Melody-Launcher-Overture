import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDesktopRegistry, readDesktopRegistry, restoreDesktopRegistry } from '../electron/desktop-npmrc'

let root = ''
let profileDir = ''
let journalRoot = ''
const npmrc = () => path.join(profileDir, '.npmrc')

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-npmrc-'))
  profileDir = path.join(root, 'profiles', 'desktop')
  journalRoot = path.join(root, 'journal')
  await mkdir(profileDir, { recursive: true })
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const MIRROR = 'https://registry.npmmirror.com'

describe('给桌面端配镜像：只动 registry 一个键', () => {
  it('原来没有 .npmrc 时写一个出来，恢复就是把文件删掉', async () => {
    const change = await applyDesktopRegistry(profileDir, MIRROR, journalRoot)
    expect(change.changed).toBe(true)
    expect(change.backupPath).toBeNull()
    expect(await readFile(npmrc(), 'utf8')).toBe(`registry=${MIRROR}\n`)

    expect(await restoreDesktopRegistry(profileDir, journalRoot)).toBe(true)
    await expect(readFile(npmrc(), 'utf8')).rejects.toThrow()
    expect(await readdir(journalRoot)).toEqual([])
  })

  it('保留用户自己写的其它键与注释，尤其不碰 store-dir', async () => {
    const original = [
      '# 我自己加的',
      'store-dir=D:\\my-own-store',
      'auto-install-peers=false',
      'registry=https://registry.npmjs.org',
      '',
    ].join('\n')
    await writeFile(npmrc(), original, 'utf8')

    const change = await applyDesktopRegistry(profileDir, MIRROR, journalRoot)
    const next = await readFile(npmrc(), 'utf8')

    expect(next).toContain('registry=https://registry.npmmirror.com')
    expect(next).not.toContain('registry=https://registry.npmjs.org')
    expect(next).toContain('store-dir=D:\\my-own-store')
    expect(next).toContain('auto-install-peers=false')
    expect(next).toContain('# 我自己加的')
    // 备份的是改之前的原件，逐字节。
    expect(await readFile(change.backupPath ?? '', 'utf8')).toBe(original)
  })

  it('同一个镜像重复点不再写盘、也不新增备份', async () => {
    await applyDesktopRegistry(profileDir, MIRROR, journalRoot)
    const second = await applyDesktopRegistry(profileDir, MIRROR, journalRoot)
    expect(second.changed).toBe(false)
    expect(await readdir(journalRoot)).toHaveLength(1)
  })

  it('换第二个镜像时仍然只有一条 registry，且备份是最初那份原件', async () => {
    await writeFile(npmrc(), 'registry=https://registry.npmjs.org\n', 'utf8')
    const first = await applyDesktopRegistry(profileDir, MIRROR, journalRoot)
    const backupBefore = await readFile(first.backupPath ?? '', 'utf8')

    await applyDesktopRegistry(profileDir, 'https://registry.example.com', journalRoot)
    const next = await readFile(npmrc(), 'utf8')

    expect(next.match(/^registry=/gm)).toHaveLength(1)
    expect(next).toContain('registry=https://registry.example.com')
    // 恢复原样要能回到 npmjs，而不是回到中间态 npmmirror。
    expect(await readFile(first.backupPath ?? '', 'utf8')).toBe(backupBefore)
    expect(await restoreDesktopRegistry(profileDir, journalRoot)).toBe(true)
    expect(await readFile(npmrc(), 'utf8')).toBe('registry=https://registry.npmjs.org\n')
  })

  it('读当前 registry：没有文件返回 null，多条取最后一条', async () => {
    expect(await readDesktopRegistry(profileDir)).toBeNull()
    await writeFile(npmrc(), 'registry=https://a.example\nregistry=https://b.example\n', 'utf8')
    expect(await readDesktopRegistry(profileDir)).toBe('https://b.example')
  })

  it('拒绝把不像链接的东西写进别人的配置', async () => {
    await expect(applyDesktopRegistry(profileDir, 'not-a-url', journalRoot)).rejects.toThrow(/http\(s\)/)
    await expect(applyDesktopRegistry(profileDir, 'file:///C:/evil', journalRoot)).rejects.toThrow(/http\(s\)/)
    await expect(readFile(npmrc(), 'utf8')).rejects.toThrow()
  })
})
