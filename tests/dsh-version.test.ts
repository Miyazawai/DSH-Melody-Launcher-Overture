import { describe, expect, it } from 'vitest'
import { compareDshVersions, dshChannelMeta, dshChannelRank, groupDshVersionsByChannel, isDshVersionOlderThan, parseDshVersion } from '../src/lib/dsh-version'
import type { RuntimeVersionCandidate } from '../src/types'

const candidate = (version: string, extra: Partial<RuntimeVersionCandidate> = {}): RuntimeVersionCandidate => ({
  version,
  label: null,
  lts: null,
  date: null,
  prerelease: version.includes('-'),
  ...extra,
})

describe('parseDshVersion', () => {
  it('把主版本号与预发布渠道拆开，正式版渠道为空', () => {
    expect(parseDshVersion('0.1.6-alpha.1')).toEqual({ base: '0.1.6', channel: 'alpha', prerelease: 'alpha.1' })
    expect(parseDshVersion('v0.1.5-rc.2')).toEqual({ base: '0.1.5', channel: 'rc', prerelease: 'rc.2' })
    expect(parseDshVersion('0.1.5')).toEqual({ base: '0.1.5', channel: null, prerelease: null })
    expect(parseDshVersion('0.2.0-nightly.20260915')).toEqual({ base: '0.2.0', channel: 'nightly', prerelease: 'nightly.20260915' })
    expect(parseDshVersion('0.1.5+build.7')).toEqual({ base: '0.1.5', channel: null, prerelease: null })
  })
})

describe('dshChannelRank', () => {
  it('正式版 0、rc 1、beta 2、alpha 3、未知渠道 4', () => {
    expect(dshChannelRank('0.1.5')).toBe(0)
    expect(dshChannelRank('0.1.5-rc.1')).toBe(1)
    expect(dshChannelRank('0.1.5-beta.1')).toBe(2)
    expect(dshChannelRank('0.1.6-alpha.1')).toBe(3)
    expect(dshChannelRank('0.1.6-canary.1')).toBe(4)
  })
})

describe('dshChannelMeta', () => {
  it('给出中文名、配色档位与稳定性说明', () => {
    expect(dshChannelMeta(null)).toMatchObject({ name: '正式版', tone: 'stable' })
    expect(dshChannelMeta('rc')).toMatchObject({ name: '候选发布版', tone: 'rc' })
    expect(dshChannelMeta('beta')).toMatchObject({ name: '公测版', tone: 'beta' })
    expect(dshChannelMeta('alpha')).toMatchObject({ name: '内测版', tone: 'alpha' })
    expect(dshChannelMeta('canary')).toMatchObject({ name: 'canary 预览', tone: 'other' })
  })
})

describe('groupDshVersionsByChannel', () => {
  it('按渠道归堆，组序为 正式版 → rc → beta → alpha → 其它，组内保持输入顺序', () => {
    const groups = groupDshVersionsByChannel([
      candidate('0.1.6-alpha.1'),
      candidate('0.1.5-rc.2'),
      candidate('0.1.5-rc.1'),
      candidate('0.2.0-canary.1'),
      candidate('0.1.4'),
      candidate('0.1.5-beta.1'),
    ])
    expect(groups.map(group => group.key)).toEqual(['stable', 'rc', 'beta', 'alpha', 'canary'])
    expect(groups.map(group => group.meta.name)).toEqual(['正式版', '候选发布版', '公测版', '内测版', 'canary 预览'])
    expect(groups[1]?.candidates.map(item => item.version)).toEqual(['0.1.5-rc.2', '0.1.5-rc.1'])
  })

  it('保留已安装项（不在数据层剔除），空列表返回空数组', () => {
    const installed = candidate('0.1.5-rc.1')
    const groups = groupDshVersionsByChannel([installed])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.candidates).toEqual([installed])
    expect(groupDshVersionsByChannel([])).toEqual([])
  })
})

describe('compareDshVersions / isDshVersionOlderThan', () => {
  it('core 高的更新，且不被字符串比较坑到（0.1.10 > 0.1.9）', () => {
    expect(compareDshVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareDshVersions('0.1.7-rc.1', '0.1.5-rc.3')).toBeGreaterThan(0)
    expect(isDshVersionOlderThan('0.1.5-rc.3', '0.1.7-rc.1')).toBe(true)
    expect(isDshVersionOlderThan('0.1.7-rc.1', '0.1.5-rc.3')).toBe(false)
  })

  it('正式版高于它自己的任何预发布，预发布逐段按 SemVer 比', () => {
    expect(compareDshVersions('0.1.7', '0.1.7-rc.1')).toBeGreaterThan(0)
    // rc > alpha（字母段按字典序），rc.2 > rc.1（数字段按数值）。
    expect(compareDshVersions('0.1.7-rc.2', '0.1.7-alpha.9')).toBeGreaterThan(0)
    // 前缀全等时字段多的一方更新。
    expect(compareDshVersions('0.1.7-rc.1.1', '0.1.7-rc.1')).toBeGreaterThan(0)
    expect(isDshVersionOlderThan('0.1.7', '0.1.7')).toBe(false)
  })

  it('v 前缀与构建元数据不影响判断', () => {
    expect(compareDshVersions('v0.1.7+build.9', '0.1.7')).toBe(0)
  })

  it('任一侧读不出来就不判旧：宁可不拦，也不凭猜出来的版本拒绝用户', () => {
    expect(isDshVersionOlderThan(null, '0.1.7-rc.1')).toBe(false)
    expect(isDshVersionOlderThan('0.1.5-rc.2', null)).toBe(false)
    expect(isDshVersionOlderThan(undefined, undefined)).toBe(false)
  })
})
