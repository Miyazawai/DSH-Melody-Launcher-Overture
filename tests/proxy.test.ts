import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildNetworkEnvironment,
  configureSystemProxyDetection,
  detectWindowsSystemProxy,
  refreshWindowsSystemProxy,
} from '../electron/proxy'

const ENABLE_ON = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n    ProxyEnable    REG_DWORD    0x1\n'
const ENABLE_OFF = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n    ProxyEnable    REG_DWORD    0x0\n'
const SERVER = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n    ProxyServer    REG_SZ    127.0.0.1:7890\n'

const realPlatform = process.platform

/** 假装是 Windows：这两个函数只在 win32 上探测，其余平台直接返回 null。 */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  stubPlatform('win32')
  // 默认注入一个「没开系统代理」的读法：任何用例都绝不会真的去起 reg.exe。
  configureSystemProxyDetection(async () => ENABLE_OFF)
})

afterEach(() => {
  stubPlatform(realPlatform)
  configureSystemProxyDetection()
  vi.useRealTimers()
})

describe('系统代理探测：异步 + 缓存，绝不在事件循环上同步查注册表', () => {
  it('开过系统代理时解析出 http 代理地址', async () => {
    configureSystemProxyDetection(async valueName => (valueName === 'ProxyEnable' ? ENABLE_ON : SERVER))

    await expect(refreshWindowsSystemProxy()).resolves.toBe('http://127.0.0.1:7890')
    expect(detectWindowsSystemProxy()).toBe('http://127.0.0.1:7890')
  })

  it('缓存命中时不再起子进程；同步读方只读缓存', async () => {
    const reader = vi.fn(async (valueName: string) => (valueName === 'ProxyEnable' ? ENABLE_ON : SERVER))
    configureSystemProxyDetection(reader)

    await refreshWindowsSystemProxy()
    expect(reader).toHaveBeenCalledTimes(2)
    // 装一个大依赖时 buildNetworkEnvironment 会被调用十几轮，这里十几轮都必须是零子进程。
    for (let index = 0; index < 12; index += 1) expect(detectWindowsSystemProxy()).toBe('http://127.0.0.1:7890')
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('代理关闭时不去查 ProxyServer', async () => {
    const reader = vi.fn(async () => ENABLE_OFF)
    configureSystemProxyDetection(reader)

    await expect(refreshWindowsSystemProxy()).resolves.toBeNull()
    expect(reader).toHaveBeenCalledTimes(1)
    expect(detectWindowsSystemProxy()).toBeNull()
  })

  it('注册表读失败当作没开代理，不把异常抛给调用方', async () => {
    configureSystemProxyDetection(async () => { throw new Error('reg 挂了') })

    await expect(refreshWindowsSystemProxy()).resolves.toBeNull()
    expect(detectWindowsSystemProxy()).toBeNull()
  })

  it('缓存过期时后台重探，本次调用仍立刻返回上一个已知值', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
    let enabled = true
    configureSystemProxyDetection(async valueName => {
      if (valueName !== 'ProxyEnable') return SERVER
      return enabled ? ENABLE_ON : ENABLE_OFF
    })
    await refreshWindowsSystemProxy()
    expect(detectWindowsSystemProxy()).toBe('http://127.0.0.1:7890')

    enabled = false
    vi.setSystemTime(new Date('2026-10-01T00:01:30Z'))
    // 关掉系统代理后的第一次读取仍拿到旧值（不等子进程），但已经把重探排上了。
    expect(detectWindowsSystemProxy()).toBe('http://127.0.0.1:7890')
    await vi.advanceTimersByTimeAsync(0)
    expect(detectWindowsSystemProxy()).toBeNull()
  })

  it('非 Windows 完全不探测', async () => {
    const reader = vi.fn(async () => ENABLE_ON)
    stubPlatform('linux')
    configureSystemProxyDetection(reader)

    await expect(refreshWindowsSystemProxy()).resolves.toBeNull()
    expect(detectWindowsSystemProxy()).toBeNull()
    expect(reader).not.toHaveBeenCalled()
  })
})

describe('子进程网络环境', () => {
  it('用户手填的代理优先于系统代理探测结果', async () => {
    configureSystemProxyDetection(async valueName => (valueName === 'ProxyEnable' ? ENABLE_ON : SERVER))
    await refreshWindowsSystemProxy()

    const network = buildNetworkEnvironment({ network: { proxy: 'http://127.0.0.1:8888' } })
    expect(network.proxy.https_proxy).toBe('http://127.0.0.1:8888')
  })

  it('没手填代理时用探测到的系统代理', async () => {
    configureSystemProxyDetection(async valueName => (valueName === 'ProxyEnable' ? ENABLE_ON : SERVER))
    await refreshWindowsSystemProxy()

    const network = buildNetworkEnvironment({})
    expect(network.proxy.https_proxy).toBe('http://127.0.0.1:7890')
  })
})
