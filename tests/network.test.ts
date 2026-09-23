import { describe, expect, it, vi } from 'vitest'
import { createProxyAwareFetch } from '../electron/network'
import { npmRegistryCandidates, requestNpmMetadata } from '../electron/proxy'

describe('proxy-aware Electron fetch adapter', () => {
  it('routes standard fetch requests through the injected Chromium network layer', async () => {
    const chromiumFetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const fetchImpl = createProxyAwareFetch(chromiumFetch)
    const url = new URL('https://raw.githubusercontent.com/example/repository/main/package.json')

    await fetchImpl(url, { headers: { Authorization: 'Bearer test-token' } })

    expect(chromiumFetch).toHaveBeenCalledOnce()
    expect(chromiumFetch).toHaveBeenCalledWith(url.href, {
      headers: { Authorization: 'Bearer test-token' },
    })
  })
})

const OFFICIAL = 'https://registry.npmjs.org'
const MIRROR = 'https://registry.npmmirror.com'

describe('npm 元数据源顺序：官方优先、连不上才回落镜像', () => {
  it('官方能答就不问镜像', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL): Promise<Response> => new Response('{"version":"1.2.3"}', { status: 200 }))
    const response = await requestNpmMetadata('/pkg/latest', fetchImpl)
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${OFFICIAL}/pkg/latest`)
  })

  it('官方超时才让镜像代答', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).startsWith(OFFICIAL)) throw new Error('fetch failed')
      return new Response('{"version":"1.2.3"}', { status: 200 })
    })
    const response = await requestNpmMetadata('/pkg/latest', fetchImpl)
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(`${MIRROR}/pkg/latest`)
  })

  it('官方回 404 当确定答案，不再问镜像', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response('not found', { status: 404 }))
    const response = await requestNpmMetadata('/pkg/latest', fetchImpl)
    expect(response.status).toBe(404)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('两个源都没答时，报错里带上各自主机', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => { throw new Error('ETIMEDOUT') })
    await expect(requestNpmMetadata('/pkg/latest', fetchImpl)).rejects.toThrow(/registry\.npmjs\.org[\s\S]*registry\.npmmirror\.com/)
  })

  // 顺序刻意相反：装包要快（镜像在前），元数据要准（镜像同步有延迟，在前会解析到旧版本）。
  // 谁哪天把它们"统一"了，这条会红。
  it('元数据顺序与装包顺序相反', async () => {
    expect(npmRegistryCandidates()).toEqual([MIRROR, OFFICIAL])
    const seen: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      seen.push(String(input))
      return new Response('{}', { status: 200 })
    })
    await requestNpmMetadata('/pkg/latest', fetchImpl)
    expect(seen[0]?.startsWith(OFFICIAL)).toBe(true)
  })
})
