import { writeFileAtomic } from './fs-atomic'
import path from 'node:path'

/**
 * 把整合包的外观钉回「DSH 原生无皮肤 / 无自定义壁纸」。
 *
 * skin-center 的 seed 逻辑（插件源码 `seedDefaultActiveSkin`）只在
 * `initialized` 为假**且** `active` 为 null 时才强写回作者默认皮肤，所以这里同时写
 * `active: null`（插件自己文档标注的 "stock look" 标记）与 `initialized: true`，
 * 两个条件一起堵住——既保证导入后是原生外观，也不会在之后反复覆盖用户手动选的皮肤。
 */

export const STOCK_ACTIVE_SKIN_STATE = { active: null, initialized: true } as const

export function activeSkinStatePath(dshHome: string): string {
  return path.join(dshHome, 'skin-center-active.json')
}

/** 原子写；失败返回 false 且不抛——外观重置是附带效果，不该阻断导入。 */
export async function applyStockAppearance(dshHome: string): Promise<boolean> {
  try {
    const target = activeSkinStatePath(dshHome)
    const body = `${JSON.stringify(STOCK_ACTIVE_SKIN_STATE, null, 2)}\n`
    await writeFileAtomic(target, body, { fallbackToDirectWrite: true })
    return true
  } catch {
    return false
  }
}
