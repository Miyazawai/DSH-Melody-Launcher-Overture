import { createContext, useContext } from 'react'
import type { LauncherApi } from '../types'

/**
 * 渲染层访问主进程的唯一入口。
 * 通过 context 传递而不是模块级全局，组件因此可以在测试里注入替身。
 */

let resolved: LauncherApi | null = null

/**
 * 解析渲染层 API。Electron 里就是 preload 注入的 `window.launcher`；
 * 只有浏览器演示模式才需要那份 97KB 的 demo 数据，所以按需 import，
 * 别让它进首屏 chunk（启动页要多解析一遍的就是这个 chunk）。
 */
export async function bootstrapLauncherApi(): Promise<LauncherApi> {
  if (resolved) return resolved
  if (window.launcher) {
    resolved = window.launcher
    return resolved
  }
  const { demoApi } = await import('../demo-api')
  resolved = demoApi
  return resolved
}

export function resolveLauncherApi(): LauncherApi {
  if (resolved) return resolved
  if (window.launcher) {
    resolved = window.launcher
    return resolved
  }
  throw new Error('渲染层 API 尚未初始化：请先 await bootstrapLauncherApi()。')
}

export const LauncherApiContext = createContext<LauncherApi | null>(null)

export const LauncherApiProvider = LauncherApiContext.Provider

export function useLauncherApi(): LauncherApi {
  const api = useContext(LauncherApiContext)
  if (!api) throw new Error('useLauncherApi 必须在 LauncherApiProvider 内部使用。')
  return api
}
