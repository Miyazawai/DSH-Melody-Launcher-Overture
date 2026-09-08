import type { ProfileState } from '../types'

/**
 * 按新的加载顺序重排整合包。
 * 拖拽时先本地应用一次，等主进程写盘返回后再用真实结果覆盖 ——
 * 失败则回滚到调用前的快照。
 */
export function reorderProfilePlugins(profile: ProfileState, packageNames: string[]): ProfileState {
  const orderByName = new Map(packageNames.map((name, index) => [name, index + 1]))
  const fallbackOrder = 999

  return {
    ...profile,
    activeBundles: packageNames,
    plugins: [...profile.plugins]
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
        return (orderByName.get(a.packageName) ?? fallbackOrder) - (orderByName.get(b.packageName) ?? fallbackOrder)
      })
      .map(plugin => ({ ...plugin, order: orderByName.get(plugin.packageName) ?? null })),
  }
}

/** 按界面中的完整列表位置，恢复当前已激活插件的实际加载顺序。 */
export function activeOrderFromDisplay(displayOrder: string[], activePackageNames: string[]): string[] {
  const active = new Set(activePackageNames)
  return displayOrder.filter(packageName => active.has(packageName))
}

/** 在有序列表里把某一项朝一个方向挪一格，越界时返回 null。 */
export function movePackage(packageNames: string[], packageName: string, direction: -1 | 1): string[] | null {
  const names = [...packageNames]
  const index = names.indexOf(packageName)
  const target = index + direction
  if (index < 0 || target < 0 || target >= names.length) return null
  ;[names[index], names[target]] = [names[target], names[index]]
  return names
}

/** 把 dragged 项插入到 target 项的位置，无法完成时返回 null。 */
export function movePackageTo(packageNames: string[], dragged: string, target: string): string[] | null {
  if (dragged === target) return null
  const names = [...packageNames]
  const from = names.indexOf(dragged)
  const to = names.indexOf(target)
  if (from < 0 || to < 0) return null
  names.splice(to, 0, names.splice(from, 1)[0])
  return names
}
