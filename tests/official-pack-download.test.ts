import { describe, expect, it } from 'vitest'
import { GITHUB_PUBLIC_MIRRORS } from '../electron/github-archive'
import {
  downloadOfficialPackAsset,
  officialPackCandidateUrls,
  officialPackSourceLabel,
} from '../electron/official-pack-download'

const ASSET_URL = 'https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/releases/download/v0.1.2/official-pack-v0.1.5-rc.2.1.zip'
const FAST_MIRROR = `${GITHUB_PUBLIC_MIRRORS[0]}${ASSET_URL}`
const SLOW_MIRROR = `${GITHUB_PUBLIC_MIRRORS[1]}${ASSET_URL}`

/** 测试用阈值：都调到几十毫秒，跑得快且不影响逻辑。 */
const TUNING = { firstByteMs: 150, stallMs: 300, probeMs: 100, floorBytesPerSecond: 1024 * 1024 }
/** 整套测试并行跑时定时器会被拖慢，用到「断流」判定的用例给宽一点。 */
const SLACK_TUNING = { ...TUNING, firstByteMs: 400, stallMs: 1500, probeMs: 200 }

interface StreamPlan {
  /** 每块字节数；0 表示连接上但一个字节都不吐（模拟卡死）。 */
  chunkBytes: number
  intervalMs: number
  /** 计划吐多少块；`stall: true` 时吐完就装死（不关闭流）。 */
  chunks: number
  stall?: boolean
  status?: number
}

/** 假 fetch：按计划吐块，并记录被请求过的 URL（供断言「换源顺序」而不依赖定时器精度）。 */
function streamingFetch(plans: Record<string, StreamPlan>, fallback?: StreamPlan, requested: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requested.push(url)
    const template = plans[url] ?? fallback
    if (!template) return new Response('', { status: 404 })
    if (template.status && template.status >= 400) return new Response('', { status: template.status })
    // 每次请求都用一份独立的进度副本：同一个 plan 可能被多个候选源（甚至同一源的两轮）复用。
    const plan: StreamPlan = { ...template }

    const signal = init?.signal ?? null
    const total = plan.chunkBytes * template.chunks
    let closed = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const finish = (error?: Error) => {
          if (closed) return
          closed = true
          clearInterval(timer)
          if (error) controller.error(error)
          else controller.close()
        }
        const timer = setInterval(() => {
          if (signal?.aborted) { finish(new Error('aborted')); return }
          if (plan.chunks <= 0) {
            if (plan.stall) return
            finish()
            return
          }
          plan.chunks -= 1
          controller.enqueue(new Uint8Array(plan.chunkBytes))
          if (plan.chunks === 0 && !plan.stall) finish()
        }, plan.intervalMs)
        signal?.addEventListener('abort', () => finish(new Error('aborted')))
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-length': String(total) } })
  }) as typeof fetch
}

describe('officialPackCandidateUrls', () => {
  it('用户镜像第一、直连其次、内置公共镜像垫底', () => {
    expect(officialPackCandidateUrls(ASSET_URL)).toEqual([ASSET_URL, ...GITHUB_PUBLIC_MIRRORS.map(p => `${p}${ASSET_URL}`)])
    expect(officialPackCandidateUrls(ASSET_URL, 'https://mirror.example')).toEqual([
      `https://mirror.example/${ASSET_URL}`,
      ASSET_URL,
      ...GITHUB_PUBLIC_MIRRORS.map(p => `${p}${ASSET_URL}`),
    ])
  })

  it('源名字：直连说人话，镜像显示域名', () => {
    expect(officialPackSourceLabel(ASSET_URL, ASSET_URL)).toBe('GitHub 直连')
    expect(officialPackSourceLabel(FAST_MIRROR, ASSET_URL)).toBe('gh-proxy.com')
  })
})

describe('downloadOfficialPackAsset', () => {
  it('直连慢到不达标 → 自动换镜像并完整下载', async () => {
    const requested: string[] = []
    const result = await downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: streamingFetch({
        // 直连：8KB / 30ms ≈ 270KB/s，远低于 1MB/s 下限（但首字节来得够快，
        // 命中的是「速度下限」而不是「等首字节超时」，两条路径分别有别的用例覆盖）。
        [ASSET_URL]: { chunkBytes: 8 * 1024, intervalMs: 30, chunks: 50 },
        // 镜像：256KB / 5ms，秒过。
        [FAST_MIRROR]: { chunkBytes: 256 * 1024, intervalMs: 5, chunks: 4 },
      }, undefined, requested),
      maxBytes: 100 * 1024 * 1024,
      tuning: TUNING,
    })
    expect(result.source).toBe('gh-proxy.com')
    expect(result.buffer.length).toBe(1024 * 1024)
    // 换源顺序：先试直连、再换镜像（按请求顺序断言，不看进度事件的时序）。
    expect(requested).toEqual([ASSET_URL, FAST_MIRROR])
  })

  it('直连连不上（一直不吐字节）→ 等首字节超时后换源', async () => {
    let sawDirect = false
    const result = await downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: streamingFetch({
        [ASSET_URL]: { chunkBytes: 0, intervalMs: 50, chunks: 0, stall: true },
        [FAST_MIRROR]: { chunkBytes: 128 * 1024, intervalMs: 5, chunks: 2 },
      }),
      maxBytes: 100 * 1024 * 1024,
      tuning: SLACK_TUNING,
      onProgress: progress => { if (progress.source === 'GitHub 直连') sawDirect = true },
    })
    expect(result.source).toBe('gh-proxy.com')
    expect(sawDirect).toBe(false)
  })

  it('下到一半断流 → 换源重来并成功', async () => {
    const result = await downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: streamingFetch({
        // 吐 3 块后装死（不关闭）：命中断流守卫。
        [ASSET_URL]: { chunkBytes: 64 * 1024, intervalMs: 20, chunks: 3, stall: true },
        [SLOW_MIRROR]: { chunkBytes: 200 * 1024, intervalMs: 5, chunks: 2 },
      }),
      maxBytes: 100 * 1024 * 1024,
      // 下限调到不可能达到，隔离出「断流」这一条守卫。
      tuning: { ...SLACK_TUNING, floorBytesPerSecond: 10 ** 9 },
    })
    expect(result.source).toBe('ghfast.top')
    expect(result.buffer.length).toBe(400 * 1024)
  })

  it('所有源都慢 → 第二轮按实测速度挑最快的那条跑完（不再因慢中断）', async () => {
    const result = await downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: streamingFetch({
        // 直连 40KB/s、镜像 400KB/s：都低于 1MB/s 下限（第二轮按实测速度选镜像，不设下限）。
        [ASSET_URL]: { chunkBytes: 4 * 1024, intervalMs: 100, chunks: 40 },
        [FAST_MIRROR]: { chunkBytes: 40 * 1024, intervalMs: 100, chunks: 4 },
      }),
      maxBytes: 100 * 1024 * 1024,
      tuning: SLACK_TUNING,
    })
    expect(result.source).toBe('gh-proxy.com')
    expect(result.buffer.length).toBe(40 * 1024 * 4)
  })

  it('所有源都不可用 → 抛出带原因的错误，不静默成功', async () => {
    await expect(downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: streamingFetch({}),
      maxBytes: 100 * 1024 * 1024,
      tuning: TUNING,
    })).rejects.toThrow('官方整合包下载失败')
  })

  it('超过体积上限的响应直接拒绝（不把超大资产读进内存）', async () => {
    await expect(downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: streamingFetch({}, { chunkBytes: 1024, intervalMs: 5, chunks: 10 }),
      maxBytes: 512,
      tuning: TUNING,
    })).rejects.toThrow('过大')
  })
})
