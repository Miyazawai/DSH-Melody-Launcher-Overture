import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './fs-atomic'

/**
 * Skill 安装凭据。
 *
 * Skill 是全局资源（`~/.dsh/skills/`）。记录来源信息用于：
 *  - 自建整合包时把已安装 Skill 写入清单；
 *  - 导出整合包时生成可重新安装的 `skills` 段；
 *  - 删包清理时区分“这个 Skill 是不是由某个整合包带来的”。
 */
export interface SkillInstallReceipt {
  name: string
  format: 'bundle' | 'flat'
  repository: string
  sourcePath: string
  revision: string
  installedAt: string
}

interface ReceiptFile {
  version: 1
  installs: SkillInstallReceipt[]
}

async function readReceiptFile(filePath: string): Promise<ReceiptFile> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<ReceiptFile>
    return {
      version: 1,
      installs: Array.isArray(value.installs) ? value.installs : [],
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, installs: [] }
  }
}

async function writeReceiptFile(filePath: string, value: ReceiptFile): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, { fallbackToDirectWrite: true })
}

export async function readSkillReceipts(filePath: string): Promise<SkillInstallReceipt[]> {
  return (await readReceiptFile(filePath)).installs
}

export async function recordSkillInstall(filePath: string, receipt: SkillInstallReceipt): Promise<void> {
  const current = await readReceiptFile(filePath)
  const installs = current.installs.filter(item => item.name !== receipt.name)
  installs.push(receipt)
  await writeReceiptFile(filePath, { version: 1, installs })
}

export async function removeSkillReceipt(filePath: string, name: string): Promise<void> {
  const current = await readReceiptFile(filePath)
  const installs = current.installs.filter(item => item.name !== name)
  if (installs.length === current.installs.length) return
  await writeReceiptFile(filePath, { version: 1, installs })
}
