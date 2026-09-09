import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureOfficeCli,
  officeCliAssetName,
  packUsesOfficeCliSkills,
  OFFICECLI_RELEASE_REPO,
} from '../electron/officecli-tool'

const LATEST_ENDPOINT = `https://api.github.com/repos/${OFFICECLI_RELEASE_REPO}/releases/latest`
const BINARY_URL = 'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.0/officecli-win-x64.exe'
const SUMS_URL = 'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.0/SHA256SUMS'
const BINARY = Buffer.from('OFFICECLI-BINARY-BYTES')

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function latestResponse() {
  return new Response(JSON.stringify({
    tag_name: 'v1.0.0',
    assets: [
      { name: 'officecli-win-x64.exe', size: BINARY.length, browser_download_url: BINARY_URL },
      { name: 'SHA256SUMS', size: 64, browser_download_url: SUMS_URL },
    ],
  }), { status: 200 })
}

function sumsResponse(hash = sha256(BINARY)) {
  return new Response(`${hash}  officecli-win-x64.exe\n`, { status: 200 })
}

/** 记录每个 URL 的尝试；handler 按完整 URL 决定响应。 */
function spyFetch(handler: (url: string) => Response) {
  const attempts: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input)
    attempts.push(url)
    return handler(url)
  }) as typeof fetch
  return { fetchImpl, attempts }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.shift()!().catch(() => undefined)
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-officecli-tool-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function win32Ensure(toolsRoot: string, options: Parameters<typeof ensureOfficeCli>[1]) {
  return ensureOfficeCli(toolsRoot, { platform: 'win32', architecture: 'x64', ...options })
}

describe('officeCliAssetName', () => {
  it('win32 映射 exe 资产；其他平台暂不启用（返回 null）', () => {
    expect(officeCliAssetName('win32', 'x64')).toEqual({ asset: 'officecli-win-x64.exe', binary: 'officecli.exe' })
    expect(officeCliAssetName('win32', 'arm64')?.asset).toBe('officecli-win-arm64.exe')
    expect(officeCliAssetName('darwin', 'arm64')).toBeNull()
    expect(officeCliAssetName('linux', 'x64')).toBeNull()
  })
})

describe('ensureOfficeCli', () => {
  it('平台不支持时返回 null 且不产生任何网络请求', async () => {
    const root = await tempRoot()
    const { fetchImpl, attempts } = spyFetch(() => latestResponse())
    await expect(ensureOfficeCli(root, { platform: 'darwin', fetchImpl })).resolves.toBeNull()
    expect(attempts).toHaveLength(0)
  })

  it('全新安装：latest → 校验 → versions/<tag>/officecli.exe 落盘 + active.json', async () => {
    const root = await tempRoot()
    const { fetchImpl, attempts } = spyFetch(url => {
      if (url === LATEST_ENDPOINT) return latestResponse()
      if (url === SUMS_URL) return sumsResponse()
      if (url === BINARY_URL) return new Response(Uint8Array.from(BINARY), { status: 200, headers: { 'content-length': String(BINARY.length) } })
      throw new Error(`unexpected ${url}`)
    })
    const exe = await win32Ensure(root, { fetchImpl, now: () => 1_000 })
    expect(exe).toBe(path.join(root, 'officecli', 'versions', 'v1.0.0', 'officecli.exe'))
    if (!exe) throw new Error('预期已安装 officecli.exe')
    const content = await readFileSafe(exe)
    expect(content?.equals(BINARY)).toBe(true)
    expect(attempts.filter(url => url === BINARY_URL)).toHaveLength(1)
    // 24 小时 TTL 内二次调用零网络、返回同一路径。
    const before = attempts.length
    const second = await win32Ensure(root, { fetchImpl, now: () => 2_000 })
    expect(second).toBe(exe)
    expect(attempts.length).toBe(before)
  })

  it('用户配置的 GitHub 镜像排在候选链首位，且只有镜像可达也能成功', async () => {
    const root = await tempRoot()
    const mirror = 'https://my.mirror/'
    const { fetchImpl, attempts } = spyFetch(url => {
      if (url.startsWith(mirror)) {
        if (url.endsWith('/releases/latest')) return latestResponse()
        if (url.endsWith('/SHA256SUMS')) return sumsResponse()
        return new Response(Uint8Array.from(BINARY), { status: 200, headers: { 'content-length': String(BINARY.length) } })
      }
      throw new Error('direct blocked')
    })
    const exe = await win32Ensure(root, { fetchImpl, mirror, now: () => 1_000 })
    expect(exe).not.toBeNull()
    // applyGitHubMirror 会去掉镜像尾部斜杠再拼接原 URL。
    expect(attempts[0]).toBe(`https://my.mirror/${LATEST_ENDPOINT}`)
  })

  it('第一个源的二进制哈希不对 → 换下一个源重试成功', async () => {
    const root = await tempRoot()
    const mirror = 'https://tampered.mirror'
    const { fetchImpl, attempts } = spyFetch(url => {
      if (url === LATEST_ENDPOINT || url.startsWith(`${mirror}/${LATEST_ENDPOINT}`)) return latestResponse()
      if (url.endsWith('/SHA256SUMS')) return sumsResponse()
      if (url.startsWith(`${mirror}/${BINARY_URL}`)) {
        return new Response(Uint8Array.from(Buffer.from('TAMPERED')), { status: 200, headers: { 'content-length': '9' } })
      }
      if (url === BINARY_URL) return new Response(Uint8Array.from(BINARY), { status: 200, headers: { 'content-length': String(BINARY.length) } })
      throw new Error(`unexpected ${url}`)
    })
    const exe = await win32Ensure(root, { fetchImpl, mirror, now: () => 1_000 })
    expect(exe).not.toBeNull()
    expect(attempts).toContain(`${mirror}/${BINARY_URL}`)
    expect(attempts).toContain(BINARY_URL)
  })

  it('SHA256SUMS 拿不到时退回资产 size 校验；size 不符不安装', async () => {
    const root = await tempRoot()
    const { fetchImpl } = spyFetch(url => {
      if (url === LATEST_ENDPOINT) return new Response(JSON.stringify({
        tag_name: 'v9.9.9',
        assets: [{ name: 'officecli-win-x64.exe', size: 12345, browser_download_url: 'https://github.com/x/releases/download/v9.9.9/officecli-win-x64.exe' }],
      }), { status: 200 })
      if (url.includes('officecli-win-x64.exe')) return new Response(Uint8Array.from(Buffer.from('short')), { status: 200, headers: { 'content-length': '5' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(win32Ensure(root, { fetchImpl, now: () => 1_000 })).resolves.toBeNull()
  })

  it('解析全失败但有本地旧版（哪怕超过 TTL）→ 退到旧版路径', async () => {
    const root = await tempRoot()
    const installed = await win32Ensure(root, {
      fetchImpl: spyFetch(url => {
        if (url === LATEST_ENDPOINT) return latestResponse()
        if (url === SUMS_URL) return sumsResponse()
        return new Response(Uint8Array.from(BINARY), { status: 200, headers: { 'content-length': String(BINARY.length) } })
      }).fetchImpl,
      now: () => 1_000,
    })
    expect(installed).not.toBeNull()
    const { fetchImpl } = spyFetch(() => { throw new Error('offline') })
    const again = await win32Ensure(root, { fetchImpl, now: () => 1_000 + 25 * 3_600_000 })
    expect(again).toBe(installed)
  })

  it('全新环境且所有源失败 → null，不产生半截文件', async () => {
    const root = await tempRoot()
    const { fetchImpl } = spyFetch(() => { throw new Error('offline') })
    await expect(win32Ensure(root, { fetchImpl, now: () => 1_000 })).resolves.toBeNull()
    const entries = await readdirSafe(root)
    expect(entries.filter(name => name.includes('officecli.exe'))).toHaveLength(0)
  })

  it('TTL 过期后重新解析：同 tag 已在盘上则不再下载二进制', async () => {
    const root = await tempRoot()
    const first = spyFetch(url => {
      if (url === LATEST_ENDPOINT) return latestResponse()
      if (url === SUMS_URL) return sumsResponse()
      return new Response(Uint8Array.from(BINARY), { status: 200, headers: { 'content-length': String(BINARY.length) } })
    })
    await win32Ensure(root, { fetchImpl: first.fetchImpl, now: () => 1_000 })
    const second = spyFetch(url => {
      if (url === LATEST_ENDPOINT) return latestResponse()
      throw new Error(`should not fetch ${url}`)
    })
    const exe = await win32Ensure(root, { fetchImpl: second.fetchImpl, now: () => 1_000 + 25 * 3_600_000 })
    expect(exe).not.toBeNull()
    expect(second.attempts.some(url => url.includes('officecli-win-x64.exe'))).toBe(false)
  })

  it('并发调用合并成一次下载（单飞）', async () => {
    const root = await tempRoot()
    const { fetchImpl, attempts } = spyFetch(url => {
      if (url === LATEST_ENDPOINT) return latestResponse()
      if (url === SUMS_URL) return sumsResponse()
      return new Response(Uint8Array.from(BINARY), { status: 200, headers: { 'content-length': String(BINARY.length) } })
    })
    const [left, right] = await Promise.all([
      win32Ensure(root, { fetchImpl, now: () => 1_000 }),
      win32Ensure(root, { fetchImpl, now: () => 1_000 }),
    ])
    expect(left).toBe(right)
    expect(attempts.filter(url => url === LATEST_ENDPOINT)).toHaveLength(1)
  })
})

describe('packUsesOfficeCliSkills', () => {
  it('skills/ 或 skills/.disabled/ 下存在 officecli* 目录即算需要', async () => {
    const home = await tempRoot()
    expect(await packUsesOfficeCliSkills(home)).toBe(false)
    await mkdir(path.join(home, 'skills', 'find-skills'), { recursive: true })
    expect(await packUsesOfficeCliSkills(home)).toBe(false)
    await mkdir(path.join(home, 'skills', 'officecli-docx'), { recursive: true })
    expect(await packUsesOfficeCliSkills(home)).toBe(true)
    await rm(path.join(home, 'skills', 'officecli-docx'), { recursive: true, force: true })
    await mkdir(path.join(home, 'skills', '.disabled', 'officecli'), { recursive: true })
    expect(await packUsesOfficeCliSkills(home)).toBe(true)
  })
})

async function readFileSafe(target: string): Promise<Buffer | null> {
  try { return await readFile(target) } catch { return null }
}
async function readdirSafe(target: string): Promise<string[]> {
  try { return await readdir(target) } catch { return [] }
}
