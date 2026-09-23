import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './fs-atomic'

/**
 * Agent 预设安装凭据。
 *
 * 预设是全局资源（`~/.dsh/.agent-presets/<name>`），不像插件那样绑定 Profile。
 * 记录来源信息用于：
 *  - 创建整合包时把已安装预设写入清单；
 *  - 导出整合包时生成可重新安装的 `presets` 段；
 *  - 后续删包清理时区分“这个预设是不是由某个整合包带来的”。
 */
export interface PresetInstallReceipt {
  name: string
  /** 子模块仓库（meta-repo 分析确定），不是父 meta-repo。 */
  repository: string
  /** 子模块内预设目录，如 `preset/router-standard`。 */
  sourcePath: string
  /** 精确 pin commit。 */
  revision: string
  installedAt: string
}

interface ReceiptFile {
  version: 1
  installs: PresetInstallReceipt[]
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

export async function readPresetReceipts(filePath: string): Promise<PresetInstallReceipt[]> {
  return (await readReceiptFile(filePath)).installs
}

export async function recordPresetInstall(filePath: string, receipt: PresetInstallReceipt): Promise<void> {
  const current = await readReceiptFile(filePath)
  const installs = current.installs.filter(item => item.name !== receipt.name)
  installs.push(receipt)
  await writeReceiptFile(filePath, { version: 1, installs })
}

export async function removePresetReceipt(filePath: string, name: string): Promise<void> {
  const current = await readReceiptFile(filePath)
  const installs = current.installs.filter(item => item.name !== name)
  if (installs.length === current.installs.length) return
  await writeReceiptFile(filePath, { version: 1, installs })
}
