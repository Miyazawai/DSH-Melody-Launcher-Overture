// DSH 本地会话日志用量聚合：今日 Token 与缓存命中率。
// 数据源全部在 {dshHome} 本地磁盘（DSH 自己落盘的投影与会话日志），不发起任何网络请求。
// 快速路径读会话投影里每会话的 totals（0.1.5 起是 storages/session_projcache/sessions/<id>.json
// 每会话一个文件，更早是单个 storages/session_projcache.json）；跨天活跃会话再扫
// sessions/{projectKey}/{sessionId}/ 下当天写过的那几代日志（session.jsonl / session.vN.jsonl，
// 可能带 .zstd）取逐 step 明细。

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import * as zlib from 'node:zlib'
import type { DshUsage, DshUsageResult } from '../src/types'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const zstdDecompressSync = (zlib as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync

export interface UsageRecord {
  time: number
  turn: number
  step: number
  input: number
  output: number
  cacheRead: number
}

interface TokenTotals {
  uncachedInput: number
  output: number
  cacheRead: number
}

const ZERO: TokenTotals = { uncachedInput: 0, output: 0, cacheRead: 0 }

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function sumTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return { uncachedInput: a.uncachedInput + b.uncachedInput, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead }
}

export function todayTokens(totals: TokenTotals): number {
  return totals.uncachedInput + totals.output + totals.cacheRead
}

/** 命中率 = 缓存读 /（缓存读 + 未缓存输入）；没有输入侧数据时返回 null。 */
export function cacheHitRate(totals: TokenTotals): number | null {
  const inputSide = totals.uncachedInput + totals.cacheRead
  return inputSide > 0 ? totals.cacheRead / inputSide : null
}

export function startOfLocalDay(nowMs: number): number {
  const day = new Date(nowMs)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * 按 (turn, step) 折叠：同一步在多个世代日志里会被重写，只留时间最新的那个样本。
 * 单独拆出来是因为一次读取可能横跨 `session.jsonl` 与 `session.v3.jsonl` 好几个文件。
 */
export function foldUsageRecords(records: UsageRecord[]): UsageRecord[] {
  const folded = new Map<string, UsageRecord>()
  for (const record of records) {
    const previous = folded.get(`${record.turn}:${record.step}`)
    if (!previous || record.time >= previous.time) folded.set(`${record.turn}:${record.step}`, record)
  }
  return [...folded.values()]
}

/**
 * 解析会话日志明文行，按 (turn, step) 折叠：
 * assistant/message 的 data.usage 是最终样本，assistant/chunk(usage) 是早期样本，同键后者覆盖前者、不重复计数。
 */
export function parseSessionLogText(text: string): UsageRecord[] {
  const found: UsageRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: unknown
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue // 撕裂行直接跳过
    }
    const entry = row as {
      type?: unknown
      time?: unknown
      data?: { turn?: unknown; step?: unknown; usage?: unknown; chunk?: { type?: unknown; usage?: unknown } }
    }
    if (typeof entry.time !== 'number' || typeof entry.data?.turn !== 'number' || typeof entry.data?.step !== 'number') continue
    let usage: Record<string, unknown> | undefined
    if (entry.type === 'assistant/message' && entry.data.usage && typeof entry.data.usage === 'object') {
      usage = entry.data.usage as Record<string, unknown>
    } else if (entry.type === 'assistant/chunk' && entry.data.chunk?.type === 'usage' && entry.data.chunk.usage && typeof entry.data.chunk.usage === 'object') {
      usage = entry.data.chunk.usage as Record<string, unknown>
    }
    if (!usage) continue
    found.push({
      time: entry.time,
      turn: entry.data.turn,
      step: entry.data.step,
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadTokens),
    })
  }
  return foldUsageRecords(found)
}

/** 多帧拼接的 zstd 容器逐帧解码；尾部撕裂帧解码失败时跳过。无 zstd 能力时返回空串。 */
export function decodeZstdFrames(buffer: Buffer): string {
  if (typeof zstdDecompressSync !== 'function') return ''
  let text = ''
  for (let offset = buffer.indexOf(ZSTD_MAGIC); offset >= 0; offset = buffer.indexOf(ZSTD_MAGIC, offset + 1)) {
    try {
      text += zstdDecompressSync(buffer.subarray(offset)).toString('utf8')
    } catch {
      // 帧不完整（写入中撕裂）：跳过该帧。
    }
  }
  return text
}

interface ProjcacheSession {
  createdAt: number
  lastPromptAt: number | null
  totals: TokenTotals
}

/**
 * 一条会话投影记录：`{ version, record: { identity, rows } }`。
 * 0.1.5 起每会话一个文件（`storages/session_projcache/sessions/<id>.json`）；
 * 旧版单文件里的 `tables.sessions.<id>` 就是这个 record 本身，所以两边共用本函数。
 */
export function parseProjcacheRecord(value: unknown): ProjcacheSession | null {
  const record = (value as {
    record?: {
      identity?: { createdAt?: unknown }
      rows?: { tokenUsage?: { val?: { totals?: Record<string, unknown> } }; sessionListMetadata?: { val?: { lastPromptAt?: unknown } } }
    }
  })?.record
  const totals = record?.rows?.tokenUsage?.val?.totals
  if (!record?.identity || !totals) return null
  const lastPromptAt = num(record.rows?.sessionListMetadata?.val?.lastPromptAt)
  return {
    createdAt: num(record.identity.createdAt),
    lastPromptAt: lastPromptAt > 0 ? lastPromptAt : null,
    totals: {
      uncachedInput: num(totals.uncachedInputTokens),
      output: num(totals.outputTokens),
      cacheRead: num(totals.cacheReadTokens),
    },
  }
}

/** 旧版单文件投影（`storages/session_projcache.json`）里的全部会话。 */
export function parseProjcacheSessions(json: unknown): Map<string, ProjcacheSession> {
  const out = new Map<string, ProjcacheSession>()
  const tables = (json as { tables?: { sessions?: Record<string, unknown> } })?.tables?.sessions
  if (!tables || typeof tables !== 'object') return out
  for (const [sessionId, entry] of Object.entries(tables)) {
    const session = parseProjcacheRecord({ record: entry })
    if (session) out.set(sessionId, session)
  }
  return out
}

/** 两种落盘形状都读：先试每会话一个文件的新目录，空/不存在再退回单文件旧版。 */
async function readProjcacheSessions(dshHome: string): Promise<Map<string, ProjcacheSession>> {
  const directory = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  const files = await readdir(directory).catch(() => null)
  if (files) {
    const out = new Map<string, ProjcacheSession>()
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await readFile(path.join(directory, file), 'utf8').catch(() => null)
      if (raw === null) continue
      try {
        const session = parseProjcacheRecord(JSON.parse(raw))
        if (session) out.set(file.slice(0, -'.json'.length), session)
      } catch {
        // 撕裂或版本不认识：跳过这一条，而不是让整个用量页报错。
      }
    }
    if (out.size > 0) return out
  }
  const legacy = await readFile(path.join(dshHome, 'storages', 'session_projcache.json'), 'utf8').catch(() => null)
  if (legacy === null) return new Map()
  // 旧版只有一个文件，读不懂就是真读不懂：让它抛给上层报 error，别伪装成"没有数据"。
  return parseProjcacheSessions(JSON.parse(legacy))
}

/** 会话日志的落盘名：0 世代是 session.jsonl，之后每代 session.vN.jsonl，都可能再带 .zstd。 */
const SESSION_LOG_PATTERN = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

/** 在 sessions/{projectKey}/{sessionId}/ 下找会话日志；mtime 早于 sinceMs 直接跳过。 */
async function readSessionRecords(dshHome: string, sessionId: string, sinceMs: number): Promise<UsageRecord[]> {
  const sessionsRoot = path.join(dshHome, 'sessions')
  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch {
    return []
  }
  const found: UsageRecord[] = []
  for (const project of projects) {
    const directory = path.join(sessionsRoot, project, sessionId)
    const entries = await readdir(directory).catch(() => null)
    if (!entries) continue
    for (const file of entries.filter(name => SESSION_LOG_PATTERN.test(name))) {
      const logPath = path.join(directory, file)
      try {
        const info = await stat(logPath)
        if (info.mtimeMs < sinceMs) continue
        const text = file.endsWith('.zstd') ? decodeZstdFrames(await readFile(logPath)) : await readFile(logPath, 'utf8')
        found.push(...parseSessionLogText(text))
      } catch {
        // 读到一半被 DSH 改写了：这一代跳过，其它代仍会累计。
      }
    }
  }
  // 同一 (turn, step) 跨世代各留最新样本，避免重写过的日志被重复计数。
  return foldUsageRecords(found)
}

export async function readDshUsage(dshHome: string, nowMs = Date.now()): Promise<DshUsageResult> {
  try {
    const sessions = await readProjcacheSessions(dshHome)
    if (sessions.size === 0) return { status: 'no-data' }

    const todayStart = startOfLocalDay(nowMs)
    let today: TokenTotals = ZERO
    let overall: TokenTotals = ZERO
    for (const [sessionId, session] of sessions) {
      overall = sumTotals(overall, session.totals)
      if (session.createdAt >= todayStart) {
        // 今天新建的会话：totals 全部计为今日。
        today = sumTotals(today, session.totals)
        continue
      }
      if (session.lastPromptAt !== null && session.lastPromptAt >= todayStart) {
        // 跨天活跃会话：只取今日时间窗内的逐 step 明细。
        for (const record of await readSessionRecords(dshHome, sessionId, todayStart)) {
          if (record.time >= todayStart) {
            today = sumTotals(today, { uncachedInput: record.input, output: record.output, cacheRead: record.cacheRead })
          }
        }
      }
    }
    const usage: DshUsage = {
      tokensToday: todayTokens(today),
      cacheHitRate: cacheHitRate(today) ?? cacheHitRate(overall),
    }
    return { status: 'ok', usage }
  } catch (cause) {
    return { status: 'error', message: cause instanceof Error ? cause.message : '读取本地用量失败' }
  }
}

/** 60 秒内存缓存 + in-flight 去重（同 deepseek-balance 模式）。 */
export function createDshUsageService(deps: { readDshHome: () => Promise<string>; cacheMs?: number }) {
  const cacheMs = deps.cacheMs ?? 60_000
  let cached: { at: number; dshHome: string; result: DshUsageResult } | null = null
  let inflight: Promise<DshUsageResult> | null = null
  return {
    async get(force = false): Promise<DshUsageResult> {
      const dshHome = await deps.readDshHome()
      if (!force && cached && cached.dshHome === dshHome && Date.now() - cached.at < cacheMs) return cached.result
      if (inflight) return inflight
      inflight = (async () => {
        try {
          const result = await readDshUsage(dshHome)
          cached = { at: Date.now(), dshHome, result }
          return result
        } finally {
          inflight = null
        }
      })()
      return inflight
    },
  }
}
