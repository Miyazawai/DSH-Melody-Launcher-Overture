import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recoverLegacyCredentials } from '../electron/dsh-credentials-compat'
import { repairCredentialRefs, restoreRepairedCredentials } from '../electron/credentials-ref-repair'

let root = ''
let dshHome = ''
let journalRoot = ''

const credentialsPath = () => path.join(dshHome, '.credentials.yaml')

/** issue #11 报告者机器上的形状：非法引用名 + 要保住的一条合法名 + 注释 + records 段。 */
const brokenModern = [
  '# 顶部注释：这份文件是命令行时代留下来的',
  'version: 1',
  'refs:',
  '  # 段首注释：下面那条是数字名',
  '  "1": first-secret',
  '  https://www.roxyai.online: roxy-secret',
  '  DEEPSEEK_API_KEY: keep-me',
  'records:',
  '  DEEPSEEK_API_KEY:',
  '    provider: local',
  '',
].join('\n')

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-credential-refs-'))
  dshHome = path.join(root, 'dsh-home')
  journalRoot = path.join(root, 'repair-journal')
  await mkdir(dshHome, { recursive: true })
})

afterEach(async () => {
  await chmod(dshHome, 0o700).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

describe('启动前修正非法凭据引用名', () => {
  it('改名保住密钥值，注释与键序都不漂', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')

    const repair = await repairCredentialRefs(dshHome, journalRoot)
    expect(repair.status).toBe('repaired')
    const source = await readFile(credentialsPath(), 'utf8')
    const lines = source.split('\n')
    expect(source).toContain('_1: first-secret')
    expect(source).toContain('HTTPS_WWW_ROXYAI_ONLINE: roxy-secret')
    expect(source).toContain('DEEPSEEK_API_KEY: keep-me')
    expect(source).toContain('version: 1')
    expect(source).toContain('provider: local')
    expect(source).toContain('# 顶部注释')
    // 段首注释必须还压在它原来那条条目上，而不是跟着漂到新的第一条。
    const commentIndex = lines.findIndex(line => line.includes('# 段首注释'))
    expect(lines[commentIndex + 1]?.trim()).toBe('_1: first-secret')
    // 没有任何一条值被改动过。
    expect(lines.filter(line => line.includes('secret') || line.includes('keep-me'))).toHaveLength(3)
  })

  it('flat 布局只改键名，不替上游顺手升成 refs', async () => {
    await writeFile(credentialsPath(), 'https://api.old.example: legacy-secret\nDEEPSEEK_API_KEY: keep-me\n', 'utf8')

    expect((await repairCredentialRefs(dshHome, journalRoot)).status).toBe('repaired')
    const source = await readFile(credentialsPath(), 'utf8')
    expect(source).toContain('HTTPS_API_OLD_EXAMPLE: legacy-secret')
    expect(source).not.toContain('version:')
    expect(source).not.toContain('refs:')
  })

  it('第二遍什么都不改，也只留一份备份', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')

    expect((await repairCredentialRefs(dshHome, journalRoot)).status).toBe('repaired')
    expect((await repairCredentialRefs(dshHome, journalRoot)).status).toBe('clean')
    const entries = await readdir(journalRoot)
    expect(entries.filter(name => name.endsWith('.yaml'))).toHaveLength(1)
    expect(entries.filter(name => name.endsWith('.json'))).toHaveLength(1)
  })

  it('本来就没有非法名时一个文件都不产生', async () => {
    const clean = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: keep-me\n'
    await writeFile(credentialsPath(), clean, 'utf8')

    expect(await repairCredentialRefs(dshHome, journalRoot)).toEqual({ status: 'clean' })
    expect(await readFile(credentialsPath(), 'utf8')).toBe(clean)
    expect(await readdir(journalRoot).catch(() => [])).toEqual([])
  })

  it('锁被别的 DSH 进程占住时跳过，且原文件一个字节没动', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')
    await writeFile(`${credentialsPath()}.lock`, '99999\n', 'utf8')

    const repair = await repairCredentialRefs(dshHome, journalRoot)
    expect(repair.status).toBe('skipped')
    if (repair.status === 'skipped') expect(repair.reason).toBe('locked')
    expect(await readFile(credentialsPath(), 'utf8')).toBe(brokenModern)
    // 别人占的锁不能由我们删掉。
    expect(await readFile(`${credentialsPath()}.lock`, 'utf8')).toBe('99999\n')
  })

  it('文件不存在＝没配过凭据，什么都不做', async () => {
    expect(await repairCredentialRefs(dshHome, journalRoot)).toEqual({ status: 'clean' })
    expect(await readdir(journalRoot).catch(() => [])).toEqual([])
  })

  it('读不懂的文档整次放弃，绝不猜', async () => {
    const cases = [
      'version: 1\nrefs: [\n',
      'version: 1\nrefs:\n  - a\n  - b\n',
      'version: 1\nrefs:\n  ? [1, 2]\n  : x\n',
    ]
    for (const source of cases) {
      await writeFile(credentialsPath(), source, 'utf8')
      const repair = await repairCredentialRefs(dshHome, journalRoot)
      expect(repair.status).toBe('skipped')
      expect(await readFile(credentialsPath(), 'utf8')).toBe(source)
    }
  })

  it('备份只落在 userData，家目录里不多出一个文件', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')
    await writeFile(path.join(dshHome, 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n', 'utf8')

    expect((await repairCredentialRefs(dshHome, journalRoot)).status).toBe('repaired')
    // 整合包导出的隐私黑名单认的是精确文件名，任何 .credentials.yaml.* 备份留在家里都会被
    // 打进「可分享」的包里，所以这里是一道泄密回归锁。
    expect((await readdir(dshHome)).sort()).toEqual(['.credentials.yaml', 'settings.yaml'])
    const entries = await readdir(journalRoot)
    expect(entries.filter(name => name.endsWith('.yaml'))).toHaveLength(1)
  })

  it('备份与修复记录里都不出现密钥值', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')

    const repair = await repairCredentialRefs(dshHome, journalRoot)
    const entries = await readdir(journalRoot)
    const record = entries.find(name => name.endsWith('.json'))
    expect(record).toBeDefined()
    const text = await readFile(path.join(journalRoot, record ?? ''), 'utf8')
    for (const secret of ['first-secret', 'roxy-secret', 'keep-me']) {
      expect(text).not.toContain(secret)
      expect(JSON.stringify(repair)).not.toContain(secret)
    }
    // 原件的备份当然保留值——那才是能撤销的依据；它必须落在 journal 里。
    const backup = entries.find(name => name.endsWith('.yaml'))
    expect(await readFile(path.join(journalRoot, backup ?? ''), 'utf8')).toContain('first-secret')
  })

  it('settings.yaml 里指向旧名的 apiKeyEnv 一起改过来', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')
    const settings = [
      'llm-pi-ai:',
      '  providers:',
      '    roxyai:',
      '      baseURL: https://www.roxyai.online',
      '      apiKeyEnv: https://www.roxyai.online',
      '    official:',
      '      apiKeyEnv: DEEPSEEK_API_KEY',
      '',
    ].join('\n')
    await writeFile(path.join(dshHome, 'settings.yaml'), settings, 'utf8')

    const repair = await repairCredentialRefs(dshHome, journalRoot)
    expect(repair.status === 'repaired' && repair.settingsRewritten).toBe(true)
    const next = await readFile(path.join(dshHome, 'settings.yaml'), 'utf8')
    expect(next).toContain('apiKeyEnv: HTTPS_WWW_ROXYAI_ONLINE')
    // 那条本来就合法的指针不许动。
    expect(next).toContain('apiKeyEnv: DEEPSEEK_API_KEY')
    expect(next).toContain('baseURL: https://www.roxyai.online')
  })

  it('settings.yaml 读不懂时凭据照修，配置文件不写', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')
    const broken = 'llm-pi-ai:\n  providers: [\n'
    await writeFile(path.join(dshHome, 'settings.yaml'), broken, 'utf8')

    const repair = await repairCredentialRefs(dshHome, journalRoot)
    expect(repair.status).toBe('repaired')
    if (repair.status === 'repaired') expect(repair.settingsRewritten).toBe(false)
    expect(await readFile(path.join(dshHome, 'settings.yaml'), 'utf8')).toBe(broken)
    expect(await readFile(credentialsPath(), 'utf8')).toContain('_1: first-secret')
  })

  it('撤销把原文件逐字节还原', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')
    const settings = 'llm-pi-ai:\n  providers:\n    roxyai:\n      apiKeyEnv: https://www.roxyai.online\n'
    await writeFile(path.join(dshHome, 'settings.yaml'), settings, 'utf8')
    const settingsBackup = settings

    await repairCredentialRefs(dshHome, journalRoot)
    expect(await readFile(credentialsPath(), 'utf8')).not.toBe(brokenModern)

    expect(await restoreRepairedCredentials(dshHome, journalRoot)).toBe(true)
    expect(await readFile(credentialsPath(), 'utf8')).toBe(brokenModern)
    expect(await readFile(path.join(dshHome, 'settings.yaml'), 'utf8')).toBe(settingsBackup)
    expect(await readdir(journalRoot)).toEqual([])
  })

  it('旧格式凭据恢复机制不会把修复冲掉（两套备份目录必须分开）', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')

    await repairCredentialRefs(dshHome, journalRoot)
    // 每次开机都会跑一遍的那个恢复器，读的是另一个根目录。
    await recoverLegacyCredentials(path.join(root, 'dsh-credentials-compat'))
    expect(await readFile(credentialsPath(), 'utf8')).toContain('_1: first-secret')
  })

  it.runIf(process.platform !== 'win32')('家目录不可写时报失败而不是假装改好了', async () => {
    await writeFile(credentialsPath(), brokenModern, 'utf8')
    await chmod(dshHome, 0o500)

    const repair = await repairCredentialRefs(dshHome, journalRoot)
    expect(repair.status).toBe('skipped')
    if (repair.status === 'skipped') expect(repair.reason).toBe('failed')
    await chmod(dshHome, 0o700)
    expect(await readFile(credentialsPath(), 'utf8')).toBe(brokenModern)
  })
})
