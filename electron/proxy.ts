import { spawnSync } from 'node:child_process'
import type { NetworkSettings } from '../src/types'

/**
 * 网络镜像 / 代理偏好工具。
 *
 * 大陆环境默认镜像优先：npm 一律走 npmmirror，失败时调用方回退官方源；
 * 代理自动探测 Windows 系统代理（规则代理梯子开启「系统代理」后写入
 * 注册表 Internet Settings），探测到就注入子进程，让 git / codeload /
 * npm 的请求都走梯子。用户可在设置页用 network.* 覆盖这两项。
 */

export interface NetworkEnvironment {
  /** 确定可用时代入子进程的代理变量（pnpm/undici 与 git 均读取）。 */
  proxy: Record<string, string>
  /** 选中的 npm 注册表地址（默认国内镜像）。 */
  npmRegistry: string
}

/** 默认 npm 国内镜像：优先使用，网络失败再回退官方源。 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com'
/** npm 官方源：镜像不可用时的回退。 */
export const NPM_OFFICIAL_REGISTRY = 'https://registry.npmjs.org'

/**
 * npm registry 候选链：用户自填镜像 → npmmirror → 官方源。
 *
 * 大陆直连 registry.npmjs.org 经常超时，所以任何「装 npm 包」的动作都该按这个顺序试，
 * 而不是只认一个源。去重是为了用户填了 npmmirror 时不重复试两遍。
 */
export function npmRegistryCandidates(preferred?: string | null): string[] {
  return [...new Set([preferred?.trim() ?? '', DEFAULT_NPM_REGISTRY, NPM_OFFICIAL_REGISTRY].filter(Boolean))]
}

/** 读取 Windows 系统代理，规则代理梯子（Clash 等）开启「系统代理」时返回代理地址。 */
export function detectWindowsSystemProxy(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const enabled = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
      { windowsHide: true, encoding: 'utf8' },
    )
    if (enabled.status !== 0 || !/0x1(?!\d)/i.test(enabled.stdout)) return null
    const server = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { windowsHide: true, encoding: 'utf8' },
    )
    if (server.status !== 0) return null
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(server.stdout)
    if (!match?.[1]) return null
    return normalizeProxyServer(match[1].trim())
  } catch {
    return null
  }
}

function normalizeProxyServer(value: string): string | null {
  const entries = value.split(';').map(part => part.trim())
  // "http=127.0.0.1:7890;https=127.0.0.1:7891" 形式取 https 段；否则整体作为地址。
  const https = entries.find(entry => /^https=/i.test(entry)) ?? entries.find(entry => !/=/.test(entry))
  if (!https) return null
  const target = https.slice(https.indexOf('=') + 1).trim()
  if (!/^(https?:\/\/)?[\w.-]+(:\d+)?$/i.test(target)) return null
  return target.includes('://') ? target : `http://${target}`
}

/** 根据用户设置（可留空）与系统代理探测结果，构造子进程网络环境。 */
export function buildNetworkEnvironment(settings?: { network?: NetworkSettings }): NetworkEnvironment {
  const network = settings?.network
  const npmRegistry = network?.npmRegistry?.trim() || DEFAULT_NPM_REGISTRY
  const proxy = network?.proxy?.trim() || detectWindowsSystemProxy() || undefined
  const proxyEnv: Record<string, string> = {}
  if (proxy) {
    proxyEnv.http_proxy = proxy
    proxyEnv.https_proxy = proxy
    proxyEnv.HTTP_PROXY = proxy
    proxyEnv.HTTPS_PROXY = proxy
    proxyEnv.all_proxy = proxy
    proxyEnv.npm_config_proxy = proxy
    proxyEnv.npm_config_http_proxy = proxy
    proxyEnv.npm_config_https_proxy = proxy
  }
  return { proxy: proxyEnv, npmRegistry }
}