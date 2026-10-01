/**
 * 把 `.credentials.yaml` 里非法的凭据引用名就地改成合法名字，密钥值原样保留。
 *
 * 为什么要动这个文件：DSH 0.1.1 之后 `credentials-local` 用
 * `/^[A-Za-z_][A-Za-z0-9_]*$/` 严格校验引用名，一个不合法的名字会让整个 credentials
 * 插件拒绝激活，连带 connection / authorization 等十来个插件全都起不来，整合包以退出码 1
 * 收场。这些非法名字（实测见过 `1` 和 `https://…` 当名字用）是命令行时代或手工编辑留下来的，
 * 而我们的用户是从 B 站来的普通用户——让他们打开 YAML 改键名不现实，所以启动前自动改掉。
 *
 * 三条硬约束：
 *   1. 备份只写进 userData，绝不留在 dshHome。整合包导出的隐私黑名单
 *      （`electron/pack-snapshot.ts` 的 EXCLUDED_TOP_LEVEL）认的是**精确文件名**，
 *      任何 `.credentials.yaml.*.bak` 都会被当成普通文件打进「可分享」的包里。
 *   2. 备份目录也不复用 `userData/dsh-credentials-compat`：`recoverLegacyCredentials`
 *      每次开机都会遍历那个目录里的 `*.json`，把旧内容覆盖回去，会把这里的修复冲掉。
 *   3. 只在锁内重读、只在证明「值一个都没变」之后才落盘；任何一步不确定就整次放弃，
 *      原文件保持不动。改坏凭据文件的代价远比「这次没改成」大。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isMap, isPair, isScalar, parseDocument, type Scalar, type YAMLMap } from 'yaml'
import { writeFileAtomic } from './fs-atomic'
import { CREDENTIAL_NAME, planRefRenames, type RefRename } from './credentials-refs'

const CREDENTIALS_FILENAME = '.credentials.yaml'
const SETTINGS_FILENAME = 'settings.yaml'
/** 与上游 dsh-atomic-write 的锁约定一致：同目录 `<文件>.lock`、`wx` 独占、内容 pid、0600。 */
const LOCK_WAIT_MS = 2_000
const LOCK_RETRY_DELAY_MS = [20, 50, 100, 200]
/** 每个家目录最多留几份修复备份；再多就只是占 userData 的历史噪音。 */
const MAX_JOURNAL_RECORDS = 5

export type CredentialsRepair =
  | { status: 'clean' }
  | { status: 'repaired'; renames: RefRename[]; backupPath: string; settingsRewritten: boolean }
  | { status: 'skipped'; reason: 'locked' | 'unparsable' | 'failed'; message: string }

interface RefPair {
  key: Scalar
  from: string
}

interface RepairRecord {
  schema: 1
  dshHome: string
  createdAt: string
  targetPath: string
  backupPath: string
  settingsPath?: string
  settingsBackupPath?: string
  renames: RefRename[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 锁被别人占住＝这次不做；连锁文件都写不出去＝目录本身有问题，两者要在诊断里分开说。 */
type LockOutcome = 'acquired' | 'contended' | 'unwritable'

async function acquireDocumentLock(targetPath: string): Promise<LockOutcome> {
  const lockPath = `${targetPath}.lock`
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAY_MS.length; attempt += 1) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      return 'acquired'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') return 'unwritable'
      if (attempt === LOCK_RETRY_DELAY_MS.length) return 'contended'
      const delay = LOCK_RETRY_DELAY_MS[attempt] ?? 0
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  return 'unwritable'
}

/**
 * 找出需要改名的引用名。
 *
 * 支持两种布局：`version: 1` + `refs:` 的新布局，以及没有 `version` 的旧 flat 布局。
 * flat 布局这里**只改键名、不顺手升布局**——上游 `credentials-local` 自己会在读到合法名字后
 * 把 flat 文档迁成 `refs`，两个写者抢同一次迁移只会互相踩。
 */
function planCredentialsDocument(source: string): { document: ReturnType<typeof parseDocument>; pairs: RefPair[]; renames: RefRename[] } | { error: string } {
  const document = parseDocument(source || '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) return { error: 'DSH 凭据文件读不出合法 YAML。' }
  const root = document.contents
  if (!isMap(root)) return { error: 'DSH 凭据文件顶层不是映射。' }

  const refsPair = root.items.find(item => isPair(item) && isScalar(item.key) && String(item.key.value) === 'refs')
  let section: YAMLMap
  const skip = new Set<string>()
  if (refsPair !== undefined && isMap(refsPair.value)) {
    section = refsPair.value
  } else if (refsPair !== undefined) {
    return { error: 'DSH 凭据文件的 refs 不是凭据映射。' }
  } else {
    section = root
    skip.add('version')
    skip.add('records')
  }

  const pairs: RefPair[] = []
  for (const item of section.items) {
    // 复合键（`? [1, 2] :`）一出现就说明这份文档超出了「名字→密钥」的形状，整次放弃。
    if (!isPair(item) || !isScalar(item.key)) return { error: 'DSH 凭据文件里有无法识别的键写法。' }
    const from = String(item.key.value ?? '')
    if (skip.has(from) || from === '') continue
    pairs.push({ key: item.key, from })
  }
  return { document, pairs, renames: planRefRenames(pairs.map(pair => pair.from)) }
}

/** 原地改键标量：不 delete+set，注释、键序、段首注释的归属才都不会漂。 */
function applyRenames(pairs: RefPair[], renames: RefRename[]): void {
  const target = new Map(renames.map(rename => [rename.from, rename.to]))
  for (const pair of pairs) {
    const to = target.get(pair.from)
    if (to === undefined) continue
    pair.key.value = to
    // 只把样式打回无引号 PLAIN；不能同时钉显式 tag，否则 yaml 会把 `!!str` 一起印进文件。
    // 新名字一律以字母或下划线开头，PLAIN 解析回来必然还是字符串。
    pair.key.type = 'PLAIN'
  }
}

function refEntries(source: string): Array<[string, unknown]> | null {
  const document = parseDocument(source || '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) return null
  const value = document.toJS() as unknown
  if (!isRecord(value)) return null
  if (isRecord(value.refs)) return Object.entries(value.refs)
  const { version: _version, records: _records, ...rest } = value
  return Object.entries(rest)
}

function recordsSection(source: string): string {
  const document = parseDocument(source || '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) return '<unreadable>'
  const value = document.toJS() as { records?: unknown }
  return JSON.stringify(value?.records ?? null)
}

/**
 * 落盘前的自证：改名之后的文档必须「每个名字都合法」，且所有密钥值一个不多一个不少
 * （多集相等），records 段逐字不变。做不到就当修复失败，不写盘。
 */
function verifyRepair(beforeSource: string, afterSource: string): string | null {
  const before = refEntries(beforeSource)
  const after = refEntries(afterSource)
  if (!before || !after) return '改名后的凭据文件读不回来。'
  const illegal = after.find(([name]) => !CREDENTIAL_NAME.test(name))
  if (illegal) return `改名后仍有非法引用名：${illegal[0]}`
  const signature = (entries: Array<[string, unknown]>): string =>
    entries.map(([, value]) => JSON.stringify(value)).sort().join('|')
  if (signature(before) !== signature(after)) return '改名前后密钥值对不上，放弃写入。'
  if (recordsSection(beforeSource) !== recordsSection(afterSource)) return '改名动到了 records 段，放弃写入。'
  return null
}

/** settings.yaml 里 provider 的 apiKeyEnv 指的是引用名；旧名非法时它本来就解析不到，改成新名才是修好。 */
function planSettingsRewrite(source: string, renames: RefRename[]): string | null {
  const document = parseDocument(source || '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0 || !isMap(document.contents)) return null
  const namespacePair = document.contents.items.find(item => isPair(item) && isScalar(item.key) && String(item.key.value) === 'llm-pi-ai')
  if (namespacePair === undefined || !isMap(namespacePair.value)) return null
  const providersPair = namespacePair.value.items.find(item => isPair(item) && isScalar(item.key) && String(item.key.value) === 'providers')
  if (providersPair === undefined || !isMap(providersPair.value)) return null
  const target = new Map(renames.map(rename => [rename.from, rename.to]))
  let changed = false
  for (const provider of providersPair.value.items) {
    if (!isPair(provider) || !isMap(provider.value)) continue
    for (const field of provider.value.items) {
      if (!isPair(field) || !isScalar(field.key) || String(field.key.value) !== 'apiKeyEnv') continue
      if (!isScalar(field.value)) continue
      const current = field.value.value
      if (typeof current === 'string' && target.has(current)) {
        field.value.value = target.get(current)
        changed = true
      }
    }
  }
  return changed ? document.toString({ lineWidth: 0 }) : null
}

/** 家目录名带中文/盘符，落盘文件名只用它的哈希前缀。 */
function homeId(dshHome: string): string {
  return createHash('sha256').update(path.resolve(dshHome)).digest('hex').slice(0, 12)
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

async function pruneJournal(journalRoot: string, prefix: string): Promise<void> {
  const entries = await readdir(journalRoot).catch(() => [])
  const backups = entries.filter(name => name.startsWith(prefix) && name.endsWith('.yaml')).sort().reverse()
  for (const name of backups.slice(MAX_JOURNAL_RECORDS)) {
    await rm(path.join(journalRoot, name), { force: true }).catch(() => undefined)
    await rm(path.join(journalRoot, `${name.slice(0, -'.yaml'.length)}.json`), { force: true }).catch(() => undefined)
  }
}

async function writeBackup(journalRoot: string, content: string, name: string): Promise<void> {
  await writeFile(path.join(journalRoot, name), content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

/**
 * 启动前修复一份凭据文档。调用方在「DSH 还没被拉起来」的时刻用它，因此正常情况下
 * 没有并发写者；外部 DSH / 命令行 dsh 还活着时靠与上游同款的写锁互斥，抢不到就跳过。
 */
export async function repairCredentialRefs(dshHome: string, journalRoot: string): Promise<CredentialsRepair> {
  const targetPath = path.join(dshHome, CREDENTIALS_FILENAME)
  const lock = await acquireDocumentLock(targetPath)
  if (lock === 'contended') {
    return { status: 'skipped', reason: 'locked', message: '凭据文件正被其它 DSH 进程写入，本次跳过改名。' }
  }
  if (lock === 'unwritable') {
    return { status: 'skipped', reason: 'failed', message: 'DSH 家目录不可写，凭据引用名这次没能修正。' }
  }
  try {
    let source: string
    try {
      source = await readFile(targetPath, 'utf8')
    } catch (error) {
      // 文件不存在＝还没配过凭据（AI 会话把它临时搬走时也是这个形状），什么都不做。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'clean' }
      return { status: 'skipped', reason: 'failed', message: '读不到 DSH 凭据文件。' }
    }

    const plan = planCredentialsDocument(source)
    if ('error' in plan) return { status: 'skipped', reason: 'unparsable', message: plan.error }
    if (plan.renames.length === 0) return { status: 'clean' }

    applyRenames(plan.pairs, plan.renames)
    const nextSource = plan.document.toString({ lineWidth: 0 })
    const problem = verifyRepair(source, nextSource)
    if (problem) return { status: 'skipped', reason: 'failed', message: problem }

    const settingsPath = path.join(dshHome, SETTINGS_FILENAME)
    let settingsSource: string | null = null
    let nextSettings: string | null = null
    try {
      settingsSource = await readFile(settingsPath, 'utf8')
      nextSettings = planSettingsRewrite(settingsSource, plan.renames)
    } catch {
      settingsSource = null
    }

    const prefix = `${homeId(dshHome)}-${stamp()}`
    const backupPath = path.join(journalRoot, `${prefix}.yaml`)
    const metadataPath = path.join(journalRoot, `${prefix}.json`)
    const settingsBackupPath = settingsSource !== null && nextSettings !== null
      ? path.join(journalRoot, `${prefix}.settings.yaml`)
      : null
    const record: RepairRecord = {
      schema: 1,
      dshHome: path.resolve(dshHome),
      createdAt: new Date().toISOString(),
      targetPath,
      backupPath,
      ...(settingsBackupPath !== null ? { settingsPath, settingsBackupPath } : {}),
      renames: plan.renames,
    }

    await mkdir(journalRoot, { recursive: true, mode: 0o700 })
    const settingsBackupName = settingsBackupPath === null ? null : `${prefix}.settings.yaml`
    try {
      await writeBackup(journalRoot, source, `${prefix}.yaml`)
      if (settingsBackupName !== null && settingsSource !== null) {
        await writeBackup(journalRoot, settingsSource, settingsBackupName)
      }
      await writeFile(metadataPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      // 0600/0700 与上游写凭据文件的模式逐位一致；顺带把组/其他用户可读的文件收窄，
      // 那正是 DSH 在 POSIX 上开读之前要求的（assertOwnerOnly）。
      await writeFileAtomic(targetPath, nextSource, { mode: 0o600, dirMode: 0o700 })
    } catch (error) {
      for (const orphan of [metadataPath, backupPath, settingsBackupName === null ? null : path.join(journalRoot, settingsBackupName)]) {
        if (orphan !== null) await rm(orphan, { force: true }).catch(() => undefined)
      }
      const code = (error as NodeJS.ErrnoException).code
      return { status: 'skipped', reason: 'failed', message: `凭据文件写入失败${code ? `（${code}）` : ''}，原文件保持不变。` }
    }

    let settingsRewritten = false
    if (settingsBackupPath !== null && nextSettings !== null) {
      try {
        await writeFileAtomic(settingsPath, nextSettings, { mode: 0o600, dirMode: 0o700 })
        settingsRewritten = true
      } catch {
        // 凭据已经修好；settings 里那条指针本来就指着一个 DSH 读不到的名字，改不改都不更糟。
      }
    }
    await pruneJournal(journalRoot, `${homeId(dshHome)}-`)
    return { status: 'repaired', renames: plan.renames, backupPath, settingsRewritten }
  } finally {
    await rm(`${targetPath}.lock`, { force: true }).catch(() => undefined)
  }
}

/**
 * 撤销最近一次修复：把备份原样写回去。
 *
 * 没有开关、没有界面按钮：备份路径会出现在启动日志和失败诊断里，用户或外部 agent 拿它
 * 就能还原。留一个可编程入口，是为了让「撤销」这件事在测试里也必须真的成立。
 */
export async function restoreRepairedCredentials(dshHome: string, journalRoot: string): Promise<boolean> {
  const entries = await readdir(journalRoot).catch(() => [])
  const prefix = `${homeId(dshHome)}-`
  const candidate = entries.filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort().at(-1)
  if (!candidate) return false
  const record = JSON.parse(await readFile(path.join(journalRoot, candidate), 'utf8')) as Partial<RepairRecord>
  if (!record.backupPath || !record.targetPath) return false
  const backupSource = await readFile(record.backupPath, 'utf8').catch(() => null)
  if (backupSource === null) return false
  await writeFileAtomic(record.targetPath, backupSource, { mode: 0o600, dirMode: 0o700 })
  if (record.settingsPath && record.settingsBackupPath) {
    const settingsSource = await readFile(record.settingsBackupPath, 'utf8').catch(() => null)
    if (settingsSource !== null) await writeFileAtomic(record.settingsPath, settingsSource, { mode: 0o600, dirMode: 0o700 })
  }
  await rm(path.join(journalRoot, candidate), { force: true }).catch(() => undefined)
  await rm(record.backupPath, { force: true }).catch(() => undefined)
  if (record.settingsBackupPath) await rm(record.settingsBackupPath, { force: true }).catch(() => undefined)
  return true
}
