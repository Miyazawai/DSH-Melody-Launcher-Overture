import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SESSION_SKIP_LABELS,
  applySessionTransfer,
  classifySessionFormat,
  findDanglingReferences,
  listSessionEntries,
  planSessionTransfer,
  undoSessionTransfer,
} from '../electron/session-transfer'

const zstdCompressSync = (zlib as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync

let temporaryRoot = ''

async function workspace(): Promise<string> {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-transfer-'))
  return temporaryRoot
}

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  temporaryRoot = ''
})

function header(cwd: string, version = 3, id = 'session-a'): string {
  return JSON.stringify({ type: 'session', version, id, cwd, createdAt: 1_700_000_000_000, agentPreset: 'study' })
}

/** 造一个包家目录，并按给定的会话规格落盘。 */
async function createPackHome(root: string, name: string, sessions: Array<{
  projectKey: string
  id: string
  file?: string
  lines: string[]
}>): Promise<string> {
  const home = path.join(root, name)
  await mkdir(home, { recursive: true })
  for (const session of sessions) {
    const directory = path.join(home, 'sessions', session.projectKey, session.id)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, session.file ?? 'session.jsonl'), `${session.lines.join('\n')}\n`, 'utf8')
  }
  return home
}

async function exists(target: string): Promise<boolean> {
  return Boolean(await stat(target).catch(() => null))
}

describe('会话记录跨包搬运', () => {
  it('合格会话被复制过去，撤销能删干净（含空目录）', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const source = await createPackHome(root, 'pack-a', [{ projectKey: '--project--', id: 'session-a', lines: [header(project), JSON.stringify({ type: 'assistant/message', time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 5 } } })] }])
    const target = await createPackHome(root, 'pack-b', [{ projectKey: '--other--', id: 'session-b', lines: [header(project, 3, 'session-b')] }])

    const plan = await planSessionTransfer(source, target)
    expect(plan.importableCount).toBe(1)
    expect(plan.skipped).toEqual([])

    const manifest = await applySessionTransfer(plan)
    expect(manifest.files).toHaveLength(1)
    const copied = path.join(target, 'sessions', '--project--', 'session-a', 'session.jsonl')
    expect(await exists(copied)).toBe(true)
    expect(await readFile(copied, 'utf8')).toContain('"agentPreset":"study"')

    const undo = await undoSessionTransfer(manifest)
    expect(undo).toMatchObject({ removed: 1, kept: 0 })
    expect(await exists(copied)).toBe(false)
    // 复制时创建出来的两层空目录也要收掉，不能留 --project--/session-a 空壳。
    expect(await exists(path.join(target, 'sessions', '--project--'))).toBe(false)
    // 目标包原有的会话一条都不该少。
    expect(await readdir(path.join(target, 'sessions', '--other--'))).toEqual(['session-b'])
  })

  it('同一条会话不重复搬，工作目录不存在的直接跳过并报原因', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const gone = path.join(root, 'deleted-project')
    const source = await createPackHome(root, 'pack-a', [
      { projectKey: '--project--', id: 'session-a', lines: [header(project)] },
      { projectKey: '--gone--', id: 'session-gone', lines: [header(gone, 3, 'session-gone')] },
    ])
    const target = await createPackHome(root, 'pack-b', [
      { projectKey: '--project--', id: 'session-a', lines: [header(project)] },
    ])

    const plan = await planSessionTransfer(source, target)
    expect(plan.importableCount).toBe(0)
    // skipped 的顺序跟 readdir 走，跨平台不保证，按原因排完再比。
    expect([...plan.skipped].sort((a, b) => a.reason.localeCompare(b.reason))).toEqual([
      { reason: 'already-present', count: 1 },
      { reason: 'missing-cwd', count: 1 },
    ])
    for (const item of plan.skipped) expect(SESSION_SKIP_LABELS[item.reason]).toBeTruthy()
  })

  it('旧版平铺布局整个项目跳过（DSH 读到会抛 legacyLayout）', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const source = path.join(root, 'pack-a')
    await mkdir(path.join(source, 'sessions', '--flat--'), { recursive: true })
    await writeFile(path.join(source, 'sessions', '--flat--', 'session.jsonl'), `${header(project)}\n`, 'utf8')
    await mkdir(path.join(source, 'sessions', '--flat--', 'session-legacy'), { recursive: true })
    await writeFile(path.join(source, 'sessions', '--flat--', 'session-legacy', 'session.jsonl'), `${header(project)}\n`, 'utf8')
    const target = await createPackHome(root, 'pack-b', [])

    const plan = await planSessionTransfer(source, target)
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]).toMatchObject({ skip: 'legacy-layout' })
    expect(plan.importableCount).toBe(0)
  })

  it('比目标 DSH 更新的记录格式不搬；目标包没有可比会话时标 unverified', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const source = await createPackHome(root, 'pack-a', [{ projectKey: '--project--', id: 'session-new', lines: [header(project, 9, 'session-new')] }])
    const oldTarget = await createPackHome(root, 'pack-b', [{ projectKey: '--other--', id: 'session-old', lines: [header(project, 3, 'session-old')] }])
    const emptyTarget = path.join(root, 'pack-empty')
    await mkdir(emptyTarget, { recursive: true })

    expect((await planSessionTransfer(source, oldTarget)).skipped).toEqual([{ reason: 'newer-format', count: 1 }])

    const unverified = await planSessionTransfer(source, emptyTarget)
    expect(unverified.importableCount).toBe(1)
    expect(unverified.formatUnverified).toBe(true)
    expect(classifySessionFormat(3, [])).toBe('unverified')
    expect(classifySessionFormat(4, [3, 5])).toBe('allow')
    expect(classifySessionFormat(6, [3, 5])).toBe('newer-format')
    // 读不出头的会话不敢拷，归到 newer-format 而不是"格式更新"。
    expect(classifySessionFormat(null, [3])).toBe('newer-format')
  })

  it('附件按路径合并且不覆盖目标已有文件；归档目录一并带过去', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const source = await createPackHome(root, 'pack-a', [{ projectKey: '--project--', id: 'session-a', lines: [header(project)] }])
    const target = await createPackHome(root, 'pack-b', [{ projectKey: '--other--', id: 'session-b', lines: [header(project, 3, 'session-b')] }])
    await mkdir(path.join(source, 'attachments', 'v1', 'objects', 'aa'), { recursive: true })
    await writeFile(path.join(source, 'attachments', 'v1', 'objects', 'aa', 'a'.repeat(64)), 'source-bytes', 'utf8')
    await mkdir(path.join(target, 'attachments', 'v1', 'objects', 'aa'), { recursive: true })
    await writeFile(path.join(target, 'attachments', 'v1', 'objects', 'aa', 'a'.repeat(64)), 'keep-me', 'utf8')
    await mkdir(path.join(source, 'dsh-session-archive'), { recursive: true })
    await writeFile(path.join(source, 'dsh-session-archive', 'one.json'), '{}', 'utf8')

    const plan = await planSessionTransfer(source, target)
    expect(plan.extraBytes).toBeGreaterThan(0)
    await applySessionTransfer(plan)

    expect(await readFile(path.join(target, 'attachments', 'v1', 'objects', 'aa', 'a'.repeat(64)), 'utf8')).toBe('keep-me')
    expect(await exists(path.join(target, 'attachments', 'v1', 'objects', 'aa', `${'b'.repeat(64)}`))).toBe(false)
    expect(await exists(path.join(target, 'dsh-session-archive', 'one.json'))).toBe(true)
  })

  it('搬过来的会话被 DSH 追加过就不假装撤销', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const source = await createPackHome(root, 'pack-a', [{ projectKey: '--project--', id: 'session-a', lines: [header(project)] }])
    const target = await createPackHome(root, 'pack-b', [{ projectKey: '--other--', id: 'session-b', lines: [header(project, 3, 'session-b')] }])

    const manifest = await applySessionTransfer(await planSessionTransfer(source, target))
    const copied = path.join(target, 'sessions', '--project--', 'session-a', 'session.jsonl')
    await writeFile(copied, `${await readFile(copied, 'utf8')}appended\n`, 'utf8')

    expect(await undoSessionTransfer(manifest)).toMatchObject({ removed: 0, kept: 1 })
    expect(await readFile(copied, 'utf8')).toContain('appended')
  })

  it('storages 一律不碰：登记表与投影缓存都留在原地', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const source = await createPackHome(root, 'pack-a', [{ projectKey: '--project--', id: 'session-a', lines: [header(project)] }])
    await mkdir(path.join(source, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(path.join(source, 'storages', 'workspace.json'), '{"unit":{"version":2}}', 'utf8')
    await writeFile(path.join(source, 'storages', 'session_projcache', 'sessions', 'session-a.json'), '{}', 'utf8')
    const target = await createPackHome(root, 'pack-b', [{ projectKey: '--other--', id: 'session-b', lines: [header(project, 3, 'session-b')] }])

    await applySessionTransfer(await planSessionTransfer(source, target))
    expect(await exists(path.join(target, 'storages'))).toBe(false)
    expect((await listSessionEntries(target)).map(entry => entry.id).sort()).toEqual(['session-a', 'session-b'])
  })

  it('悬空引用报出目标包没有的预设与插件', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const source = await createPackHome(root, 'pack-a', [{
      projectKey: '--project--',
      id: 'session-a',
      lines: [header(project), JSON.stringify({ type: 'tool/call', data: { plugin: 'user-approval' } })],
    }])
    const target = await createPackHome(root, 'pack-b', [])
    await mkdir(path.join(target, '.agent-presets'), { recursive: true })
    await writeFile(path.join(target, '.agent-presets', 'study.yaml'), '{}', 'utf8')
    await mkdir(path.join(target, 'profiles', 'pack-b', 'node_modules', 'user-approval'), { recursive: true })

    const plan = await planSessionTransfer(source, target)
    expect(plan.importableCount).toBe(1)
    // 缺预设的包：预设 study 在目标包存在 → 不报；插件同名也存在 → 不报。
    expect(await findDanglingReferences(plan, target)).toEqual({ presets: [], plugins: [] })

    const bare = path.join(root, 'pack-bare')
    await mkdir(bare, { recursive: true })
    expect(await findDanglingReferences(plan, bare)).toEqual({ presets: ['study'], plugins: ['user-approval'] })
  })

  it.skipIf(!zstdCompressSync)('.zstd 会话日志认得，世代号也认得', async () => {
    const root = await workspace()
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    const source = path.join(root, 'pack-a')
    const directory = path.join(source, 'sessions', '--project--', 'session-a')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'session.v3.jsonl.zstd'), zstdCompressSync!(Buffer.from(`${header(project, 3)}\n`)))
    const target = await createPackHome(root, 'pack-b', [{ projectKey: '--other--', id: 'session-b', lines: [header(project, 3, 'session-b')] }])

    const entries = await listSessionEntries(source)
    expect(entries[0]).toMatchObject({ formatVersion: 3, skip: null, logs: [{ generation: 3, compressed: true }] })
    expect((await planSessionTransfer(source, target)).importableCount).toBe(1)
  })
})
