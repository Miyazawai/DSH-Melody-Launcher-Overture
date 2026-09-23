import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './fs-atomic'
import { parse, stringify } from 'yaml'
import { repositoryFullNameFromSpecifier } from './profile'

const BUILD_KEY_PATTERN = /(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@[^\s,]+/gi
const BUILD_KEY_VALID_PATTERN = /^(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@[^\s,]+$/i

export function ignoredBuildKeys(output: string): string[] {
  const plainText = output.replace(/\x1b\[[0-9;]*m/g, '')
  const sections = [...plainText.matchAll(/Ignored build scripts:\s*([^\r\n]+)/gi)]
  return [...new Set(sections.flatMap(match => match[1].match(BUILD_KEY_PATTERN) ?? []))]
}

/**
 * 解析 pnpm 11 的 `GIT_DEP_PREPARE_NOT_ALLOWED` 报错提示块，提取需要加入
 * allowBuilds 的 git 托管包构建键（形如 `<name>@<depPath>`）。
 */
export function gitPrepareBuildKeys(output: string): string[] {
  const plainText = output.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = plainText.split(/\r?\n/)
  const keys: string[] = []
  let collecting = false
  for (const line of lines) {
    if (collecting) {
      if (/^\S/.test(line) && line.trim() !== '') collecting = false
      else {
        const match = line.match(/^\s*((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@[^\s,]+)\s*:\s*(?:true|false)/)
        if (match) keys.push(match[1])
      }
      continue
    }
    if (/^allowBuilds\s*:/.test(line.trim())) collecting = true
  }
  return [...new Set(keys)]
}

function buildKeyRepository(buildKey: string): string | undefined {
  const separator = buildKey.search(/@(?=(?:git\+)?https?:\/\/|github:)/i)
  return separator < 0 ? undefined : repositoryFullNameFromSpecifier(buildKey.slice(separator + 1))
}

export async function approveIgnoredGitHubBuilds(
  workspacePath: string,
  output: string,
  repository: string,
): Promise<string[]> {
  const expectedRepository = repository.toLowerCase()
  const matchingKeys = ignoredBuildKeys(output).filter(key => buildKeyRepository(key)?.toLowerCase() === expectedRepository)
  if (matchingKeys.length === 0) return []

  return approveBuildKeys(workspacePath, matchingKeys)
}

/** 批准 pnpm 报告的全部被忽略构建脚本（等价于 `pnpm approve-builds`）。 */
export async function approveAllIgnoredBuilds(workspacePath: string, output: string): Promise<string[]> {
  return approveBuildKeys(workspacePath, ignoredBuildKeys(output))
}

export async function approveBuildKeys(workspacePath: string, buildKeys: string[]): Promise<string[]> {
  return setBuildKeys(workspacePath, buildKeys, true)
}

/** 将清单明确声明不需要的可选原生构建记录为 false，避免 pnpm 每次重复阻塞。 */
export async function denyBuildKeys(workspacePath: string, buildKeys: string[]): Promise<string[]> {
  return setBuildKeys(workspacePath, buildKeys, false)
}

async function setBuildKeys(workspacePath: string, buildKeys: string[], allowed: boolean): Promise<string[]> {
  const matchingKeys = [...new Set(buildKeys)].filter(key => BUILD_KEY_VALID_PATTERN.test(key))
  if (matchingKeys.length === 0 || matchingKeys.length > 64) return []

  let source = ''
  try {
    source = await readFile(workspacePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parsed = source.trim() ? parse(source) : {}
  const workspace = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  const currentAllowBuilds = workspace.allowBuilds
  const allowBuilds = currentAllowBuilds && typeof currentAllowBuilds === 'object' && !Array.isArray(currentAllowBuilds)
    ? currentAllowBuilds as Record<string, unknown>
    : {}
  // 丢弃 pnpm 写入的非法占位（如 `name: set this to true or false`），只保留布尔值。
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(allowBuilds)) {
    if (typeof value === 'boolean') cleaned[key] = value
    else if (typeof value === 'string' && (value === 'true' || value === 'false')) cleaned[key] = value === 'true'
  }
  const changed = matchingKeys.filter(key => cleaned[key] !== allowed)
  const onlyCleanup = changed.length === 0 && Object.keys(cleaned).length !== Object.keys(allowBuilds).length
  if (changed.length === 0 && !onlyCleanup) return []
  for (const key of changed) cleaned[key] = allowed
  workspace.allowBuilds = cleaned

  await writeFileAtomic(workspacePath, stringify(workspace, { lineWidth: 0 }), { fallbackToDirectWrite: true })
  return changed
}
