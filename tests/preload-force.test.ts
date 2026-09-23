import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/constants'

/**
 * preload 的形状对 tsc 是宽松的：零参箭头可以合法赋给声明了可选参数的
 * LauncherApi 成员，所以 `readOfficialPackStatus: () => invoke(ch)` 这种漏转发
 * 编译期发现不了——调用方明明传了 force，主进程永远收到 undefined。
 * 0.1.3 整理时就是这么一个真实缺陷（其余三个带 force 的成员当时是对的）。
 * 这里把四个成员逐个钉住，防止同类改动再溜过去。
 */

const captured = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  calls: [] as unknown[][],
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { captured.api = api },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => { captured.calls.push(args); return Promise.resolve(null) },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  },
  webUtils: { getPathForFile: () => 'C:/tmp/file' },
}))

// 传 false 的那个用例是故意的：证明转发的是实参，而不是写死的 true。
const FORCE_MEMBERS: Array<[string, boolean, string]> = [
  ['checkDshMarketUpdates', true, IPC.dshMarketUpdates],
  ['deepseekBalance', true, IPC.deepseekBalance],
  ['dshUsage', false, IPC.dshUsage],
  ['readOfficialPackStatus', true, IPC.packsOfficialStatus],
]

describe('preload 把 force 转发给主进程', () => {
  it.each(FORCE_MEMBERS)('%s 带 force 调用 ipcRenderer.invoke', async (name, force, channel) => {
    await import('../electron/preload')
    const method = captured.api[name]
    expect(typeof method, `${name} 应当挂在 preload 暴露给渲染层的 API 上`).toBe('function')
    captured.calls.length = 0
    ;(method as (value: boolean) => unknown)(force)
    expect(captured.calls).toEqual([[channel, force]])
  })
})
