import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import type { InstalledSkill } from '../src/types'

export interface ParsedSkill {
  name: string
  description: string
  modelInvocable: boolean
  userInvocable: boolean
  content: string
}

export function isSkillName(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function invocationPolicy(data: Record<string, unknown>): Pick<ParsedSkill, 'modelInvocable' | 'userInvocable'> {
  const legacyKeys = ['disableModelInvocation', 'modelInvocable', 'userInvocable']
  if (legacyKeys.some(key => Object.hasOwn(data, key))) throw new Error('legacy invocation frontmatter is unsupported')
  return {
    modelInvocable: frontmatterBoolean(data, 'disable-model-invocation') !== true,
    userInvocable: frontmatterBoolean(data, 'user-invocable') !== false,
  }
}

export function parseSkillDocument(raw: string): ParsedSkill | null {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return null
  const start = firstLineEnd + 1
  let lineStart = start
  let closingStart = -1
  let bodyStart = raw.length
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closingStart = lineStart
      bodyStart = nextNewline < 0 ? raw.length : nextNewline + 1
      break
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  if (closingStart < 0) return null

  let data: unknown
  try {
    data = parse(raw.slice(start, closingStart))
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const fields = data as Record<string, unknown>
  const name = fields.name
  const description = fields.description
  if (typeof name !== 'string' || !name || !isSkillName(name)) return null
  if (typeof description !== 'string' || !description) return null
  try {
    return {
      name,
      description,
      ...invocationPolicy(fields),
      content: raw.slice(bodyStart).trim(),
    }
  } catch {
    return null
  }
}

export async function readInstalledSkills(dshHome: string): Promise<InstalledSkill[]> {
  const root = path.join(dshHome, 'skills')
  const installed: InstalledSkill[] = []
  const readEntries = async (sourceRoot: string, enabled: boolean): Promise<void> => {
    let sourceEntries: Dirent<string>[]
    try {
      sourceEntries = await readdir(sourceRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of sourceEntries) {
      const format = entry.isDirectory() ? 'bundle' : entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? 'flat' : null
      if (!format || entry.name === '.system') continue
      const skillPath = format === 'bundle' ? path.join(sourceRoot, entry.name, 'SKILL.md') : path.join(sourceRoot, entry.name)
      try {
        const parsed = parseSkillDocument(await readFile(skillPath, 'utf8'))
        if (!parsed) continue
        installed.push({
          name: parsed.name,
          description: parsed.description,
          path: format === 'bundle' ? path.dirname(skillPath) : skillPath,
          format,
          enabled,
          modelInvocable: parsed.modelInvocable,
          userInvocable: parsed.userInvocable,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  await readEntries(root, true)
  await readEntries(path.join(root, '.disabled'), false)
  const unique = new Map<string, InstalledSkill>()
  for (const skill of installed) {
    const previous = unique.get(skill.name)
    if (!previous || skill.enabled || !previous.enabled) unique.set(skill.name, skill)
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** Move a Skill between the DSH-visible root and the hidden disabled directory. */
export async function toggleInstalledSkill(dshHome: string, name: string, enabled: boolean): Promise<InstalledSkill[]> {
  const root = path.join(dshHome, 'skills')
  const current = await readInstalledSkills(dshHome)
  const skill = current.find(item => item.name === name)
  if (!skill) throw new Error(`未找到本地 Skill：${name}`)
  if (skill.enabled === enabled) return current

  const disabledRoot = path.join(root, '.disabled')
  const source = skill.path
  const destination = enabled
    ? path.join(root, skill.format === 'bundle' ? path.basename(source) : path.basename(source))
    : path.join(disabledRoot, skill.format === 'bundle' ? path.basename(source) : path.basename(source))
  await mkdir(path.dirname(destination), { recursive: true })
  try {
    await rename(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`无法${enabled ? '启用' : '停用'} Skill「${name}」：目标位置已存在同名文件`)
    }
    throw error
  }
  return readInstalledSkills(dshHome)
}

/** 彻底删除一个已安装 Skill（技能包目录或单文件；停用中的也一并删掉）。 */
export async function uninstallInstalledSkill(dshHome: string, name: string): Promise<InstalledSkill[]> {
  const current = await readInstalledSkills(dshHome)
  const skill = current.find(item => item.name === name)
  if (!skill) throw new Error(`未找到本地 Skill：${name}`)
  await rm(skill.path, { recursive: true, force: true })
  return readInstalledSkills(dshHome)
}
