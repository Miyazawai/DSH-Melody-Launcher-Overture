import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectDesktopClient, detectDesktopClients } from '../electron/desktop-client'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function programsRoot(): Promise<{ localAppData: string; programs: string }> {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-client-'))
  roots.push(localAppData)
  const programs = path.join(localAppData, 'Programs')
  await mkdir(programs, { recursive: true })
  return { localAppData, programs }
}

/** 造一个假的桌面端安装：只按真机的目录结构摆，不放任何二进制内容。 */
async function seedInstall(programs: string, name: string, options: { cli?: boolean; exe?: boolean; runtime?: string | null } = {}) {
  const root = path.join(programs, name)
  const { cli = true, exe = true, runtime = '{\n  "desktopVersion": "0.2.0-rc.2",\n  "node": "24.21.0",\n  "pnpm": "11.7.0"\n}\n' } = options
  await mkdir(path.join(root, 'resources', 'runtime', 'cli', 'bin'), { recursive: true })
  if (cli) await writeFile(path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), '@echo off\r\n', 'utf8')
  if (exe) await writeFile(path.join(root, `${name}.exe`), 'MZ', 'utf8')
  if (runtime !== null) {
    await mkdir(path.join(root, 'resources', 'runtime', 'primary-runtime'), { recursive: true })
    await writeFile(path.join(root, 'resources', 'runtime', 'primary-runtime', 'runtime.json'), runtime, 'utf8')
  }
  return root
}

describe('发现本机官方桌面端安装', () => {
  it('按目录结构认出来，并读出版本与自带工具链', async () => {
    const { localAppData, programs } = await programsRoot()
    const root = await seedInstall(programs, 'DeepSeek Harness')

    const install = await detectDesktopClient({ LOCALAPPDATA: localAppData })

    expect(install).not.toBeNull()
    expect(install?.root).toBe(root)
    expect(install?.executable).toBe(path.join(root, 'DeepSeek Harness.exe'))
    expect(install?.cli).toBe(path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    expect(install?.desktopVersion).toBe('0.2.0-rc.2')
    expect(install?.nodeVersion).toBe('24.21.0')
    expect(install?.pnpmVersion).toBe('11.7.0')
  })

  it('没有那个 dsh 命令入口就不算桌面端', async () => {
    const { localAppData, programs } = await programsRoot()
    await seedInstall(programs, 'Some Other App', { cli: false })

    expect(await detectDesktopClients({ LOCALAPPDATA: localAppData })).toEqual([])
  })

  it('有命令入口但找不到主程序时也不认（宁可不显示，别给一个点不动的入口）', async () => {
    const { localAppData, programs } = await programsRoot()
    await seedInstall(programs, 'DeepSeek Harness', { exe: false })

    expect(await detectDesktopClients({ LOCALAPPDATA: localAppData })).toEqual([])
  })

  it('主程序名与目录名不一致时，跳过 Uninstall 挑真正的应用 exe', async () => {
    const { localAppData, programs } = await programsRoot()
    const root = await seedInstall(programs, 'Harness', { exe: false })
    await writeFile(path.join(root, 'Uninstall Harness.exe'), 'MZ', 'utf8')
    await writeFile(path.join(root, 'HarnessDesktop.exe'), 'MZ', 'utf8')

    const install = await detectDesktopClient({ LOCALAPPDATA: localAppData })
    expect(install?.executable).toBe(path.join(root, 'HarnessDesktop.exe'))
  })

  it('runtime.json 读不到时仍然认出来，只是版本为空', async () => {
    const { localAppData, programs } = await programsRoot()
    await seedInstall(programs, 'DeepSeek Harness', { runtime: null })

    const install = await detectDesktopClient({ LOCALAPPDATA: localAppData })
    expect(install?.desktopVersion).toBeNull()
    expect(install?.cli).toContain('dsh.cmd')
  })

  it('同时装了多个时按版本从高到低排', async () => {
    const { localAppData, programs } = await programsRoot()
    await seedInstall(programs, 'Old', { runtime: '{"desktopVersion":"0.1.9-rc.3"}' })
    const newest = await seedInstall(programs, 'New', { runtime: '{"desktopVersion":"0.2.0-rc.2"}' })

    const all = await detectDesktopClients({ LOCALAPPDATA: localAppData })
    expect(all.map(item => item.root)).toEqual([newest, path.join(programs, 'Old')])
  })

  it('没有 LOCALAPPDATA / Program Files 时返回空，而不是抛', async () => {
    expect(await detectDesktopClients({})).toEqual([])
    const { localAppData, programs } = await programsRoot()
    await seedInstall(programs, 'DeepSeek Harness')
    // 只给 ProgramFiles、不给 LOCALAPPDATA：走另一个候选根。
    const found = await detectDesktopClients({ ProgramFiles: programs })
    expect(found).toHaveLength(1)
  })
})
