import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as zlib from 'node:zlib'
import {
  cacheHitRate,
  decodeZstdFrames,
  parseProjcacheSessions,
  parseSessionLogText,
  readDshUsage,
  startOfLocalDay,
  todayTokens,
} from '../electron/dsh-usage'

const zstdCompressSync = (zlib as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync

function usageLine(type: 'assistant/chunk' | 'assistant/message', turn: number, step: number, time: number, usage: Record<string, number>) {
  return JSON.stringify(type === 'assistant/chunk'
    ? { type, seq: step, time, data: { turn, step, chunk: { type: 'usage', usage } } }
    : { type, seq: step, time, data: { turn, step, message: { role: 'assistant' }, usage } })
}

describe('parseSessionLogText', () => {
  it('同 (turn,step) 以 assistant/message 覆盖 chunk 样本，不重复计数', () => {
    const text = [
      usageLine('assistant/chunk', 1, 1, 100, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }),
      usageLine('assistant/message', 1, 1, 100, { inputTokens: 120, outputTokens: 12, cacheReadTokens: 60 }),
      usageLine('assistant/message', 1, 2, 200, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 80 }),
    ].join('\n')
    const records = parseSessionLogText(text)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ turn: 1, step: 1, input: 120, output: 12, cacheRead: 60 })
  })

  it('跳过撕裂行、非 usage 记录与缺字段行', () => {
    const text = [
      '{bad json',
      JSON.stringify({ type: 'user/message', time: 1, data: { turn: 1, step: 1 } }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1 } } }),
      usageLine('assistant/message', 2, 1, 50, { inputTokens: 5 }),
    ].join('\n')
    expect(parseSessionLogText(text)).toHaveLength(1)
  })
})

describe('decodeZstdFrames', () => {
  it.skipIf(!zstdCompressSync)('多帧拼接容器逐帧解码，尾部撕裂帧跳过', () => {
    const frame1 = zstdCompressSync!(Buffer.from('line-a\n'))
    const frame2 = zstdCompressSync!(Buffer.from('line-b\n'))
    const torn = Buffer.concat([frame2, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])])
    const text = decodeZstdFrames(Buffer.concat([frame1, torn]))
    expect(text).toContain('line-a')
    expect(text).toContain('line-b')
  })
})

describe('projcache 聚合', () => {
  const proj = (sessions: Record<string, unknown>) => ({ tables: { sessions } })
  const session = (createdAt: number, totals: Record<string, number>, lastPromptAt?: number) => ({
    identity: { createdAt },
    rows: {
      tokenUsage: { val: { totals } },
      sessionListMetadata: { val: lastPromptAt ? { lastPromptAt } : {} },
    },
  })

  it('cacheHitRate 与 todayTokens 语义', () => {
    expect(todayTokens({ uncachedInput: 100, output: 50, cacheRead: 350 })).toBe(500)
    expect(cacheHitRate({ uncachedInput: 100, output: 0, cacheRead: 300 })).toBe(0.75)
    expect(cacheHitRate({ uncachedInput: 0, output: 5, cacheRead: 0 })).toBeNull()
  })

  it('今日新建会话直接计 totals；跨天会话只取今日窗口明细', async () => {
    const now = Date.now()
    const todayStart = startOfLocalDay(now)
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-usage-'))
    await mkdir(path.join(home, 'storages'), { recursive: true })
    await writeFile(path.join(home, 'storages', 'session_projcache.json'), JSON.stringify(proj({
      'session-new': session(todayStart + 1000, { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000 }),
      'session-old': session(todayStart - 86_400_000, { uncachedInputTokens: 9999, outputTokens: 9999, cacheReadTokens: 9999 }, todayStart + 5000),
    })), 'utf8')
    const logDir = path.join(home, 'sessions', 'proj-a', 'session-old')
    await mkdir(logDir, { recursive: true })
    await writeFile(path.join(logDir, 'session.jsonl'), [
      usageLine('assistant/message', 1, 1, todayStart - 10, { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400 }),
      usageLine('assistant/message', 1, 2, todayStart + 10, { inputTokens: 300, outputTokens: 40, cacheReadTokens: 60 }),
    ].join('\n'), 'utf8')

    const result = await readDshUsage(home, now)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // 今日 = 新会话 totals(1000+200+8000) + 旧会话今日窗口(300+40+60)
    expect(result.usage.tokensToday).toBe(9200 + 400)
    // 命中率 = (8000+60) / (8000+60+1000+300)
    expect(result.usage.cacheHitRate).toBeCloseTo(8060 / 9360, 6)
  })

  it('无投影文件返回 no-data；坏 JSON 返回 error', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'dsh-usage-empty-'))
    expect((await readDshUsage(empty)).status).toBe('no-data')
    await mkdir(path.join(empty, 'storages'), { recursive: true })
    await writeFile(path.join(empty, 'storages', 'session_projcache.json'), 'not json', 'utf8')
    expect((await readDshUsage(empty)).status).toBe('error')
  })

  it('parseProjcacheSessions 容忍缺字段条目', () => {
    const map = parseProjcacheSessions(proj({
      good: session(123, { uncachedInputTokens: 1 }),
      bad: { identity: { createdAt: 1 } },
    }))
    expect([...map.keys()]).toEqual(['good'])
    expect(map.get('good')?.createdAt).toBe(123)
  })
})

/**
 * 0.1.5-rc 起的真实落盘形状：投影是每会话一个文件、日志名带世代号。
 * 这两处以前都只认旧版，导致用量页对现役整合包恒 no-data。
 */
describe('用量读取认 0.1.5 的落盘形状', () => {
  const record = (createdAt: number, totals: Record<string, number>, lastPromptAt?: number) => ({
    version: 7,
    record: {
      identity: { formatVersion: 3, createdAt, cwd: 'C:\\proj', isSeeded: false, inheritedEventCount: 0 },
      rows: {
        tokenUsage: { ver: 1, seq: 3, val: { totals } },
        sessionListMetadata: { ver: 1, seq: 4, val: lastPromptAt ? { blank: false, lastPromptAt } : { blank: false } },
      },
    },
  })

  async function homeWithPerRecordCache(...entries: Array<[string, unknown]>): Promise<string> {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-usage-per-record-'))
    const directory = path.join(home, 'storages', 'session_projcache', 'sessions')
    await mkdir(directory, { recursive: true })
    for (const [sessionId, value] of entries) {
      // 字符串按原样落盘，用来伪造撕裂文件。
      await writeFile(path.join(directory, `${sessionId}.json`), typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
    }
    return home
  }

  it('每会话一个文件的投影目录能读出今日用量', async () => {
    const now = Date.now()
    const todayStart = startOfLocalDay(now)
    const home = await homeWithPerRecordCache(
      ['session-a', record(todayStart + 1000, { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000 })],
    )

    const result = await readDshUsage(home, now)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.usage.tokensToday).toBe(9200)
  })

  it('读不懂的单条投影只跳过这一条，不让整页报错', async () => {
    const now = Date.now()
    const todayStart = startOfLocalDay(now)
    const home = await homeWithPerRecordCache(
      ['torn', '{ not json'],
      ['session-a', record(todayStart + 1000, { uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 1 })],
    )

    const result = await readDshUsage(home, now)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.usage.tokensToday).toBe(12)
  })

  it('投影目录存在但空着时，退回旧版单文件', async () => {
    const now = Date.now()
    const todayStart = startOfLocalDay(now)
    const home = await homeWithPerRecordCache()
    await writeFile(path.join(home, 'storages', 'session_projcache.json'), JSON.stringify({
      tables: { sessions: { 'session-old': { identity: { createdAt: todayStart + 500 }, rows: { tokenUsage: { val: { totals: { uncachedInputTokens: 7, outputTokens: 3 } } } } } } },
    }), 'utf8')

    const result = await readDshUsage(home, now)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.usage.tokensToday).toBe(10)
  })

  it('世代文件名 session.vN.jsonl 认得，跨世代同一步不重复计数', async () => {
    const now = Date.now()
    const todayStart = startOfLocalDay(now)
    const home = await homeWithPerRecordCache(
      ['session-x', record(todayStart - 86_400_000, { uncachedInputTokens: 9999, outputTokens: 9999, cacheReadTokens: 9999 }, todayStart + 5000)],
    )
    const logDir = path.join(home, 'sessions', '--c-proj--', 'session-x')
    await mkdir(logDir, { recursive: true })
    const step = (turn: number, seq: number, time: number, input: number) => usageLine('assistant/message', turn, seq, time, { inputTokens: input, outputTokens: 0, cacheReadTokens: 0 })
    // 第二代日志是重写出来的：它重复了第一步（值还变了），并多出第二步。
    await writeFile(path.join(logDir, 'session.v2.jsonl'), [step(1, 1, todayStart + 10, 300)].join('\n'), 'utf8')
    await writeFile(path.join(logDir, 'session.v3.jsonl'), [step(1, 1, todayStart + 20, 500), step(1, 2, todayStart + 30, 40)].join('\n'), 'utf8')
    // 干扰项：不该被当成本会话日志的名字。
    await writeFile(path.join(logDir, 'session.v3.meta.json'), '{}', 'utf8')

    const result = await readDshUsage(home, now)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // 折叠后是 (1,1)=500（取较晚样本）+ (1,2)=40，而不是 300+500+40。
    expect(result.usage.tokensToday).toBe(540)
  })
})
