import { describe, expect, it } from 'vitest'
import {
  VERSION_LIMIT_PER_CHANNEL,
  candidatesFromPackument,
  pickNewestDshVersion,
  pickRecommendedDshVersion,
  validVersion,
} from '../electron/dsh-release'
import type { RuntimeVersionCandidate } from '../src/types'

const candidate = (version: string): RuntimeVersionCandidate => ({
  version,
  label: null,
  lts: null,
  date: null,
  prerelease: version.includes('-'),
})

describe('pickRecommendedDshVersion', () => {
  it('稳定优先：有正式版就选正式版，哪怕预发布版版本号更高', () => {
    expect(pickRecommendedDshVersion([
      candidate('0.1.6-alpha.1'),
      candidate('0.1.4'),
      candidate('0.1.5-rc.2'),
    ])?.version).toBe('0.1.4')
  })

  it('同级取新：同一渠道里取版本号最高的', () => {
    expect(pickRecommendedDshVersion([
      candidate('0.1.5-rc.1'),
      candidate('0.1.5-rc.2'),
    ])?.version).toBe('0.1.5-rc.2')
  })

  it('rc 优先于版本号更高的 alpha（成熟度优先于版本号）', () => {
    expect(pickRecommendedDshVersion([
      candidate('0.1.6-alpha.1'),
      candidate('0.1.5-rc.1'),
    ])?.version).toBe('0.1.5-rc.1')
  })

  it('同渠道内 rc.2 胜过 rc.10 之外的数字排序陷阱', () => {
    expect(pickRecommendedDshVersion([candidate('0.1.0-rc.9'), candidate('0.1.0-rc.10')])?.version).toBe('0.1.0-rc.10')
  })

  it('只有 alpha 时就取最高的 alpha；空列表返回 null', () => {
    expect(pickRecommendedDshVersion([candidate('0.1.6-alpha.1'), candidate('0.1.6-alpha.2')])?.version).toBe('0.1.6-alpha.2')
    expect(pickRecommendedDshVersion([])).toBeNull()
  })

  it('结果不依赖输入顺序', () => {
    const list = [candidate('0.1.5-rc.2'), candidate('0.1.5-rc.1'), candidate('0.1.6-alpha.1')]
    expect(pickRecommendedDshVersion(list)?.version).toBe('0.1.5-rc.2')
    expect(pickRecommendedDshVersion([...list].reverse())?.version).toBe('0.1.5-rc.2')
  })
})

describe('pickNewestDshVersion', () => {
  it('取版本号最高者（可能是不稳定的渠道）', () => {
    expect(pickNewestDshVersion([candidate('0.1.5-rc.2'), candidate('0.1.6-alpha.1')])?.version).toBe('0.1.6-alpha.1')
    expect(pickNewestDshVersion([])).toBeNull()
  })
})

describe('candidatesFromPackument', () => {
  /** 上游真实形态：latest 停在旧的 rc.1，rc.2 只打了 next，版本号最高的是 alpha。 */
  const upstreamPackument = {
    versions: { '0.1.6-alpha.1': {}, '0.1.5-rc.2': {}, '0.1.5-rc.1': {} },
    'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.1' },
    time: { '0.1.6-alpha.1': '2026-09-15T09:17:40.717Z' },
  }

  it('标记最新版与推荐版本，不被 npm 的 latest 标签带偏', () => {
    const result = candidatesFromPackument(upstreamPackument)
    expect(result.map(item => item.version)).toEqual(['0.1.6-alpha.1', '0.1.5-rc.2', '0.1.5-rc.1'])
    expect(result.find(item => item.isNewest)?.version).toBe('0.1.6-alpha.1')
    expect(result.find(item => item.recommended)?.version).toBe('0.1.5-rc.2')
    expect(result.find(item => item.version === '0.1.5-rc.1')?.label).toBe('latest')
    expect(result.find(item => item.version === '0.1.6-alpha.1')?.date).toBe('2026-09-15T09:17:40.717Z')
  })

  it('推荐版本被同类版本挤出截断窗口时仍然保留', () => {
    const versions: Record<string, unknown> = { ...upstreamPackument.versions }
    for (let index = 1; index <= VERSION_LIMIT_PER_CHANNEL + 8; index += 1) versions[`0.1.7-alpha.${index}`] = {}
    const result = candidatesFromPackument({ ...upstreamPackument, versions })
    expect(result.find(item => item.recommended)?.version).toBe('0.1.5-rc.2')
    expect(result.find(item => item.isNewest)?.version).toBe(`0.1.7-alpha.${VERSION_LIMIT_PER_CHANNEL + 8}`)
    // 推荐版本被保留下来，而不是只剩一堆 alpha。
    expect(result.some(item => !item.version.startsWith('0.1.7-alpha'))).toBe(true)
  })

  it('过滤非法版本号与非法 dist-tag 值', () => {
    const result = candidatesFromPackument({
      versions: { '1.0.0': {}, invalid: {}, 'not-a-version': {} },
      'dist-tags': { latest: '1.0.0', broken: 'not-a-version' },
    })
    expect(result.map(item => item.version)).toEqual(['1.0.0'])
    expect(result[0]).toMatchObject({ isNewest: true, recommended: true, label: 'latest' })
  })

  it('空 packument 返回空数组', () => {
    expect(candidatesFromPackument({})).toEqual([])
  })
})

describe('validVersion', () => {
  it('只接受三段式版本号与带预发布后缀的形式', () => {
    expect(validVersion('0.1.6-alpha.1')).toBe(true)
    expect(validVersion('v1.2.3')).toBe(true)
    expect(validVersion('1.2')).toBe(false)
    expect(validVersion('invalid')).toBe(false)
  })
})
