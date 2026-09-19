import type { ManagedPlugin } from '../types'

/** 把值转成给人看的字符串。全部为纯函数，时间相关的依赖由调用方注入。 */

/** 1200 → "1.2k"。 */
export function formatStars(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** Formats byte counts for compact progress labels. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** unitIndex
  const digits = unitIndex === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(digits)} ${units[unitIndex]}`
}

/** 下载速率：1258291 → "1.2 MB/s"。未知或非正数返回空串（界面据此不显示这一段）。 */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

/** 下载进度百分比；总量未知时返回 null（界面退回不确定态进度条）。 */
export function downloadPercent(received: number, total: number | null): number | null {
  if (total == null || total <= 0) return null
  return Math.min(100, Math.max(0, Math.floor((received / total) * 100)))
}

/** 一行式下载进度文案："45%（56 MB / 119 MB） · 2.4 MB/s · 经 gh-proxy.com"。 */
export function downloadProgressText(progress: { received: number; total: number | null; speed: number | null; source: string }): string {
  const percent = downloadPercent(progress.received, progress.total)
  const amount = percent == null
    ? `已下载 ${formatBytes(progress.received)}`
    : `${percent}%（${formatBytes(progress.received)} / ${formatBytes(progress.total as number)}）`
  return [amount, formatSpeed(progress.speed), `经 ${progress.source}`].filter(Boolean).join(' · ')
}

/** ISO 时间串 → "3 分钟前" / "2 天前" / "8月14日"。 */
export function formatRelativeTime(value: string, now: number = Date.now()): string {
  const diff = now - new Date(value).getTime()
  const minutes = Math.max(1, Math.floor(diff / 60_000))
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value))
}

/** 插件列表里的方块头像文字。 */
export function pluginInitial(plugin: ManagedPlugin): string {
  return plugin.displayName.trim().slice(0, 2).toUpperCase()
}

/** 把任意抛出物转成可展示的文案。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
