import type { AppSettings } from '../src/types'
import type { Installer } from './installer'
import { readProfile, updateBundles } from './profile'
import { applyStockAppearance } from './stock-appearance'

/**
 * 「官方推荐整合包」DSH Web UI 全家桶：安装 latest、启用、可选停用其它插件、
 * 并把皮肤切到官方默认外观。
 *
 * 注意：这个服务的 UI 入口在 v0.1.1 已被「官方默认整合包」机制取代（见 CHANGELOG），
 * 渲染层只保留了 store 方法、已无人调用。外观重置逻辑已抽到 stock-appearance.ts 共用。
 */

/** 官方推荐整合包：DSH Web UI 全家桶。 */
export const RECOMMENDED_WEB_UI_PACKAGE = '@linxin666/dsh-web-ui-all'

/** 核心组合层：始终保留，不参与“停用其它插件”。 */
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'])

export interface RecommendedWebUiOptions {
  readSettings: () => Promise<AppSettings>
  installer: Installer
}

export interface RecommendedWebUiStatus {
  installed: boolean
  enabled: boolean
}

export interface RecommendedWebUiService {
  isBusy(): boolean
  status(): Promise<RecommendedWebUiStatus>
  ensureInstall(options: { suspendOthers?: boolean }): Promise<RecommendedWebUiStatus>
}

export function createRecommendedWebUiService(options: RecommendedWebUiOptions): RecommendedWebUiService {
  let busy = false

  async function status(): Promise<RecommendedWebUiStatus> {
    const settings = await options.readSettings()
    const profile = await readProfile(settings.dshHome, settings.profileName)
    const plugin = profile.plugins.find(item => item.packageName === RECOMMENDED_WEB_UI_PACKAGE)
    return { installed: Boolean(plugin), enabled: plugin?.enabled ?? false }
  }

  async function ensureInstall(request: { suspendOthers?: boolean }): Promise<RecommendedWebUiStatus> {
    if (busy) throw new Error('官方推荐整合包安装正在进行，请稍候。')
    busy = true
    try {
      const settings = await options.readSettings()
      // 安装 latest 并自动启用（installer 自带 Bundle 校验与 receipt）。
      await options.installer.installNpmPackage({
        packageName: RECOMMENDED_WEB_UI_PACKAGE,
        version: 'latest',
        repository: 'recommended:dsh-web-ui',
      })
      // 老用户：先把其它非核心插件暂不启用，避免与全家桶兼容性冲突（可在启动项管理重新开启）。
      if (request.suspendOthers) {
        await updateBundles(settings.dshHome, settings.profileName, bundles =>
          bundles.filter(name => CORE_BUNDLES.has(name) || name === RECOMMENDED_WEB_UI_PACKAGE),
        )
      }
      await applyStockAppearance(settings.dshHome)
      return status()
    } finally {
      busy = false
    }
  }

  return { isBusy: () => busy, status, ensureInstall }
}