import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { CredentialStatus } from '../src/types'
import { writeFileAtomic } from './fs-atomic'

const DEEPSEEK_CREDENTIAL = 'DEEPSEEK_API_KEY'
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertCredentialName(name: string): void {
  if (!CREDENTIAL_NAME.test(name)) throw new Error('凭据名称格式无效。')
}

function credentialsPath(dshHome: string): string {
  return path.join(dshHome, '.credentials.yaml')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readCredentialSource(dshHome: string): Promise<string | null> {
  try {
    return await readFile(credentialsPath(dshHome), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseCredentials(source: string) {
  const document = parseDocument(source || '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error('DSH 凭据文件格式无效，请先在 DSH 中修复后重试。')
  }

  const value = document.toJS() as unknown
  if (value === null) return { document, values: {} as Record<string, string>, modern: false }
  if (!isRecord(value)) {
    throw new Error('DSH 凭据文件必须是 Key 与密钥组成的映射。')
  }

  // DSH 0.1.1+ stores credentials under refs and keeps metadata such as
  // version/records at the document root. The launcher must operate on refs
  // without flattening or validating those metadata fields as secrets.
  const modern = value.version === 1 && Object.prototype.hasOwnProperty.call(value, 'refs')
  const values = modern ? value.refs : value
  if (!isRecord(values)) {
    throw new Error('DSH 凭据文件的 refs 必须是凭据映射。')
  }
  // 旧环境/手工编辑留下的文件里可能混着 DSH 读不懂的条目（名字是 `1` 或一条 URL）。
  // 这些条目在启动前会被自动改成合法写法（见 credentials-ref-repair），但在启动发生之前，
  // 启动器自己的读与写不能因为它们而整体失败——否则用户连 DeepSeek 的 Key 都存不进去。
  // 所以这里只把无法使用的条目挡在外面，其余照常工作。
  const readable: Record<string, string> = {}
  for (const [name, secret] of Object.entries(values)) {
    if (!CREDENTIAL_NAME.test(name) || typeof secret !== 'string' || secret.length === 0) continue
    readable[name] = secret
  }
  return { document, values: readable, modern }
}

async function writeCredentialDocument(dshHome: string, content: string): Promise<void> {
  // 走统一的原子写：凭据文件已存在时绝不截断重写，Windows 上 Defender 瞬时占用导致的
  // EPERM 也有重试表兜底（以前这里手写 temp+rename，没有重试，保存密钥会偶发失败）。
  await writeFileAtomic(credentialsPath(dshHome), content, { mode: 0o600, dirMode: 0o700 })
}

export async function getDeepSeekCredentialStatus(dshHome: string): Promise<CredentialStatus> {
  try {
    return { configured: await hasCredential(dshHome, DEEPSEEK_CREDENTIAL) }
  } catch (error) {
    // 凭据文件里若残留无效条目（旧版本/手工编辑污染），不向界面抛出异常，
    // 而是把状态降级为未配置并附上原因，避免启动器每次启动都打错误 toast。
    return { configured: false, parseError: error instanceof Error ? error.message : 'DSH 凭据文件读取失败。' }
  }
}

export async function readCredential(dshHome: string, name: string): Promise<string | null> {
  assertCredentialName(name)
  const source = await readCredentialSource(dshHome)
  if (source === null) return null
  const { values } = parseCredentials(source)
  return values[name] ?? null
}

export async function hasCredential(dshHome: string, name: string): Promise<boolean> {
  return Boolean(await readCredential(dshHome, name))
}

export async function setCredential(dshHome: string, name: string, secret: string): Promise<void> {
  assertCredentialName(name)
  const normalized = secret.trim()
  if (!normalized) throw new Error('API Key 不能为空。')
  const source = await readCredentialSource(dshHome)
  const { document, modern } = parseCredentials(source ?? '{}\n')
  if (modern) document.setIn(['refs', name], normalized)
  else document.set(name, normalized)
  await writeCredentialDocument(dshHome, document.toString({ lineWidth: 0 }))
}

export async function removeCredential(dshHome: string, name: string): Promise<boolean> {
  assertCredentialName(name)
  const source = await readCredentialSource(dshHome)
  if (source === null) return false
  const { document, values, modern } = parseCredentials(source)
  if (!values[name]) return false
  if (modern) document.deleteIn(['refs', name])
  else document.delete(name)
  await writeCredentialDocument(dshHome, document.toString({ lineWidth: 0 }))
  return true
}

/**
 * 内部读取 DeepSeek API Key，仅供主进程 AI 安装时注入 ACP 子进程环境。
 * 文件缺失返回 null。返回值绝不打日志。
 */
export async function readDeepSeekApiKey(dshHome: string): Promise<string | null> {
  return readCredential(dshHome, DEEPSEEK_CREDENTIAL)
}

export async function setDeepSeekApiKey(dshHome: string, apiKey: string): Promise<CredentialStatus> {
  await setCredential(dshHome, DEEPSEEK_CREDENTIAL, apiKey)
  return { configured: true }
}

export async function clearDeepSeekApiKey(dshHome: string): Promise<CredentialStatus> {
  await removeCredential(dshHome, DEEPSEEK_CREDENTIAL)
  return { configured: false }
}
