// DSH 版本号解析与渠道标识的唯一实现。
// 主进程（electron/dsh-release.ts 的「稳定优先、同级取新」推荐规则）与渲染层（版本页分组展示）
// 都从这里取，避免两边各写一套解析导致界面与安装口径不一致。
//
// 关键约定：渠道一律从版本串本身解析（0.1.6-alpha.1 的渠道是 alpha），不采信 npm dist-tag——
// dist-tag 是发布者自起的别名，常与版本串对不上（例如 next 标签指向 rc 版本）。

import type { RuntimeVersionCandidate } from '../types'

export type DshChannelTone = 'stable' | 'rc' | 'beta' | 'alpha' | 'other'

interface ChannelDefinition {
  /** 渠道中文名。 */
  name: string
  tone: DshChannelTone
  /** 稳定性排名，数字越小越稳定；正式版为 0。 */
  rank: number
  /** 悬停说明：这个渠道有多稳。 */
  hint: string
}

const CHANNEL_DEFINITIONS: Record<string, ChannelDefinition> = {
  rc: { name: '候选发布版', tone: 'rc', rank: 1, hint: '候选发布（release candidate）：若无重大问题，它将直接成为正式版。' },
  beta: { name: '公测版', tone: 'beta', rank: 2, hint: '公测预览：功能基本冻结，主要还在修 bug。' },
  alpha: { name: '内测版', tone: 'alpha', rank: 3, hint: '内测预览：功能可能变动、稳定性差，仅供尝鲜。' },
}

const STABLE_DEFINITION: ChannelDefinition = {
  name: '正式版',
  tone: 'stable',
  rank: 0,
  hint: '正式发布版本：定稿发布，推荐长期使用。',
}

/** 未识别渠道（dev、nightly、自定义）排在所有已知渠道之后。 */
const UNKNOWN_RANK = 4

/** 分组展示顺序：正式版 → rc → beta → alpha → 其它（按渠道名）。 */
const CHANNEL_DISPLAY_ORDER = ['rc', 'beta', 'alpha']

export interface ParsedDshVersion {
  /** 主版本号（去掉预发布后缀与构建元数据），如 0.1.6。 */
  base: string
  /** 预发布渠道（小写）；正式版为 null。 */
  channel: string | null
  /** 预发布后缀原文，如 alpha.1；正式版为 null。 */
  prerelease: string | null
}

export function parseDshVersion(version: string): ParsedDshVersion {
  const normalized = version.trim().replace(/^v/i, '').split('+')[0] ?? ''
  const dash = normalized.indexOf('-')
  if (dash < 0) return { base: normalized, channel: null, prerelease: null }
  const prerelease = normalized.slice(dash + 1)
  const channel = prerelease.split('.')[0]?.trim().toLowerCase()
  return { base: normalized.slice(0, dash), channel: channel || null, prerelease: prerelease || null }
}

/** 渠道稳定性排名：正式版 0、rc 1、beta 2、alpha 3、其它 4。 */
export function dshChannelRank(version: string): number {
  const { channel } = parseDshVersion(version)
  if (!channel) return STABLE_DEFINITION.rank
  return CHANNEL_DEFINITIONS[channel]?.rank ?? UNKNOWN_RANK
}

export interface DshChannelMeta {
  /** 渠道中文名，如「候选发布版」。 */
  name: string
  tone: DshChannelTone
  hint: string
}

export function dshChannelMeta(channel: string | null): DshChannelMeta {
  const definition = channel === null
    ? STABLE_DEFINITION
    : CHANNEL_DEFINITIONS[channel]
      ?? { name: `${channel} 预览`, tone: 'other' as const, rank: UNKNOWN_RANK, hint: '其它预览渠道：稳定性没有保证。' }
  return { name: definition.name, tone: definition.tone, hint: definition.hint }
}

function channelSortKey(channel: string | null): [number, string] {
  if (channel === null) return [0, '']
  const index = CHANNEL_DISPLAY_ORDER.indexOf(channel)
  return index >= 0 ? [index + 1, channel] : [CHANNEL_DISPLAY_ORDER.length + 1, channel]
}

export interface DshVersionChannelGroup {
  /** 分组键：正式版为 'stable'，其余为渠道名。 */
  key: string
  meta: DshChannelMeta
  candidates: RuntimeVersionCandidate[]
}

/**
 * 按发布渠道归堆，组序为 正式版 → rc → beta → alpha → 其它。
 * 组内保持传入顺序（registry 已是版本号降序）；已安装项由界面标「已安装」，不在数据层剔除。
 */
export function groupDshVersionsByChannel(candidates: readonly RuntimeVersionCandidate[]): DshVersionChannelGroup[] {
  const buckets = new Map<string | null, RuntimeVersionCandidate[]>()
  for (const candidate of candidates) {
    const { channel } = parseDshVersion(candidate.version)
    const bucket = buckets.get(channel)
    if (bucket) bucket.push(candidate)
    else buckets.set(channel, [candidate])
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => {
      const [leftRank, leftName] = channelSortKey(left)
      const [rightRank, rightName] = channelSortKey(right)
      return leftRank !== rightRank ? leftRank - rightRank : leftName.localeCompare(rightName)
    })
    .map(([channel, items]) => ({ key: channel ?? 'stable', meta: dshChannelMeta(channel), candidates: items }))
}
