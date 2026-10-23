import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { APPEARANCE_IMAGE_EXTENSIONS, MAX_APPEARANCE_IMAGE_BYTES, appearanceAssetName } from '../src/lib/appearance'
import type { AppearanceImageKind } from '../src/types'

/**
 * 外观图片的落盘通道。
 * 用户选的原图会被**复制**进 userData/appearance/：原图之后被移动/删除不影响外观，
 * 渲染层也只需要加载启动器自己目录里的固定文件（自定义协议只放行这一层）。
 * 本文件不依赖 electron，复制/校验逻辑可以直接单测。
 */

/** 渲染层加载外观图片的自定义协议；main 启动时登记，只映射 userData/appearance 下的两张图。 */
export const APPEARANCE_SCHEME = 'dsh-appearance'

const APPEARANCE_ASSET_PATTERN = /^(?:background|logo)\.(?:png|jpe?g|webp)$/i

/**
 * 纯函数：把请求 URL 解析成 appearance 目录里的安全文件名；非法请求返回 null。
 * 与协议 handler 共用，保证「协议只放行两张固定图」这条边界可被单测。
 */
export function resolveAppearanceAssetName(requestUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APPEARANCE_SCHEME}:`) return null
  const raw = parsed.hostname
    ? decodeURIComponent(parsed.hostname)
    : decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  if (!APPEARANCE_ASSET_PATTERN.test(raw)) return null
  return raw.toLowerCase()
}

/** 只接受 png/jpg/jpeg/webp；其余扩展名一律拒绝，避免把可执行内容塞进外观目录。 */
export function resolveAppearanceExtension(filePath: string): string | null {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  return APPEARANCE_IMAGE_EXTENSIONS.has(extension) ? extension : null
}

export interface StoredAppearanceImage {
  /** 复制进 userData/appearance/ 后的绝对路径（写进 settings.appearance.*Path）。 */
  path: string
  /** 渲染层可直接用的自定义协议 URL。 */
  url: string
}

/**
 * 校验并复制一张外观图片。
 * 同一用途（background / logo）只保留一份：换扩展名时先清掉旧文件，避免 appearance/ 里堆孤儿。
 */
export async function storeAppearanceImage(
  sourcePath: string,
  kind: AppearanceImageKind,
  directory: string,
): Promise<StoredAppearanceImage> {
  const extension = resolveAppearanceExtension(sourcePath)
  if (!extension) throw new Error('外观图片仅支持 png / jpg / jpeg / webp。')
  const info = await stat(sourcePath).catch(() => null)
  if (!info?.isFile()) throw new Error('所选路径不存在或不是文件。')
  if (info.size > MAX_APPEARANCE_IMAGE_BYTES) throw new Error('图片不能超过 10MB。')

  await mkdir(directory, { recursive: true })
  for (const entry of await readdir(directory)) {
    if (entry.toLowerCase().startsWith(`${kind}.`)) {
      await rm(path.join(directory, entry), { force: true })
    }
  }

  const target = path.join(directory, appearanceAssetName(kind, extension))
  await copyFile(sourcePath, target)
  return { path: target, url: `dsh-appearance://${path.basename(target)}` }
}
