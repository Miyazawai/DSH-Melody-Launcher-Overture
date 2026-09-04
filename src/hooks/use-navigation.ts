import { useCallback, useState } from 'react'
import type { HomeTab } from '../types'

/**
 * 界面导航：一级导航拍平后只剩一个 surface；管理界面（开发人员选项）已随
 * 「暴力整合包模式」路线移除，这里只维护启动 surface 内的当前 tab。
 */
export function useNavigation() {
  const [homeTab, setHomeTab] = useState<HomeTab>('start')

  return {
    homeTab,
    goHome: useCallback((tab: HomeTab) => setHomeTab(tab), []),
  }
}
