import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearDeepSeekApiKey,
  getDeepSeekCredentialStatus,
  setDeepSeekApiKey,
} from '../electron/credentials'

let temporaryHome = ''

beforeEach(async () => {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-credentials-'))
})

afterEach(async () => {
  await rm(temporaryHome, { recursive: true, force: true })
})

describe('DeepSeek credential management', () => {
  it('reports an absent credential without creating a file', async () => {
    await expect(getDeepSeekCredentialStatus(temporaryHome)).resolves.toEqual({ configured: false })
  })

  it('stores the credential in the official DSH credentials document', async () => {
    const result = await setDeepSeekApiKey(temporaryHome, '  sk-test-value  ')
    const content = await readFile(path.join(temporaryHome, '.credentials.yaml'), 'utf8')

    expect(result).toEqual({ configured: true })
    expect(content).toContain('DEEPSEEK_API_KEY: sk-test-value')
    expect(JSON.stringify(result)).not.toContain('sk-test-value')
    await expect(getDeepSeekCredentialStatus(temporaryHome)).resolves.toEqual({ configured: true })
  })

  it('preserves unrelated credentials and comments when replacing and clearing the key', async () => {
    const credentialsFile = path.join(temporaryHome, '.credentials.yaml')
    await writeFile(credentialsFile, '# keep this comment\nOPENAI_API_KEY: openai-secret\nDEEPSEEK_API_KEY: old-secret\n', 'utf8')

    await setDeepSeekApiKey(temporaryHome, 'new-secret')
    let content = await readFile(credentialsFile, 'utf8')
    expect(content).toContain('# keep this comment')
    expect(content).toContain('OPENAI_API_KEY: openai-secret')
    expect(content).toContain('DEEPSEEK_API_KEY: new-secret')

    await clearDeepSeekApiKey(temporaryHome)
    content = await readFile(credentialsFile, 'utf8')
    expect(content).toContain('OPENAI_API_KEY: openai-secret')
    expect(content).not.toContain('DEEPSEEK_API_KEY')
  })

  it('reads and updates the versioned refs format without flattening metadata', async () => {
    const credentialsFile = path.join(temporaryHome, '.credentials.yaml')
    await writeFile(credentialsFile, `version: 1
refs:
  DEEPSEEK_API_KEY: modern-secret
  OTHER_TOKEN: other-secret
records:
  DEEPSEEK_API_KEY:
    provider: local
`, 'utf8')

    await expect(getDeepSeekCredentialStatus(temporaryHome)).resolves.toEqual({ configured: true })
    await setDeepSeekApiKey(temporaryHome, 'updated-secret')
    let content = await readFile(credentialsFile, 'utf8')
    expect(content).toContain('version: 1')
    expect(content).toContain('DEEPSEEK_API_KEY: updated-secret')
    expect(content).toContain('records:')
    expect(content).toContain('OTHER_TOKEN: other-secret')

    await clearDeepSeekApiKey(temporaryHome)
    content = await readFile(credentialsFile, 'utf8')
    expect(content).toContain('version: 1')
    expect(content).toContain('records:')
    const parsed = parseDocument(content).toJS() as { refs?: Record<string, string>; records?: Record<string, unknown> }
    expect(parsed.refs?.DEEPSEEK_API_KEY).toBeUndefined()
    expect(parsed.records?.DEEPSEEK_API_KEY).toBeDefined()
  })

  it('rejects blank keys and malformed credential documents', async () => {
    await expect(setDeepSeekApiKey(temporaryHome, '   ')).rejects.toThrow('API Key 不能为空')
    await writeFile(path.join(temporaryHome, '.credentials.yaml'), '- not\n- a mapping\n', 'utf8')
    await expect(setDeepSeekApiKey(temporaryHome, 'sk-test')).rejects.toThrow('必须是 Key 与密钥组成的映射')
  })

  it('still reads and saves the DeepSeek key when the document carries illegal ref names', async () => {
    // issue #11 的连带症状：文件里只要有一条名字非法（`1`、一条 URL），以前整个读写都会抛，
    // 用户在启动器里连 DeepSeek 的 Key 都存不进去。非法条目本身交给启动前的自动改名。
    await writeFile(
      path.join(temporaryHome, '.credentials.yaml'),
      'version: 1\nrefs:\n  "1": legacy-secret\n  DEEPSEEK_API_KEY: deepseek-secret\n',
      'utf8',
    )

    await expect(getDeepSeekCredentialStatus(temporaryHome)).resolves.toEqual({ configured: true })
    await expect(setDeepSeekApiKey(temporaryHome, 'sk-replaced')).resolves.toEqual({ configured: true })

    const content = await readFile(path.join(temporaryHome, '.credentials.yaml'), 'utf8')
    expect(content).toContain('DEEPSEEK_API_KEY: sk-replaced')
    expect(content).toContain('"1": legacy-secret')
  })

  it('treats an empty value as unusable without failing the whole document', async () => {
    await writeFile(
      path.join(temporaryHome, '.credentials.yaml'),
      'version: 1\nrefs:\n  BROKEN_TOKEN: ""\n  DEEPSEEK_API_KEY: deepseek-secret\n',
      'utf8',
    )

    await expect(getDeepSeekCredentialStatus(temporaryHome)).resolves.toEqual({ configured: true })
  })
})
