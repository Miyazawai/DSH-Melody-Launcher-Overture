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

/** npm 元数据的候选顺序：官方在前，镜像兜底。 */
const NPM_METADATA_REGISTRIES: readonly string[] = [NPM_OFFICIAL_REGISTRY, DEFAULT_NPM_REGISTRY]

/** 单个源的元数据请求上限：官方源在大陆是"挂住不回"而非快速报错，不设上限会拖死整页。 */
const NPM_METADATA_TIMEOUT_MS = 10_000

/**
 * 按候选源请求 npm 元数据（包 manifest / `/latest` / 指定版本），返回第一个给出确定答案的响应。
 *
 * 顺序与 npmRegistryCandidates() **刻意相反**：这里读的是版本元数据，而 npmmirror 的同步有
 * 延迟——镜像在前会把"最新版"解析成比官方旧的一个版本，用户装到的东西和官网列表不一致。
 * 元数据请求只是一个几 KB 的 JSON，官方能连上时很快，所以让它先答，只有真连不上/超时才让镜像代答。
 *
 * 404 也算确定答案（包或版本确实不存在），不再往下问；其余非 2xx 与网络异常才换源。
 */
export async function requestNpmMetadata(
  registryPath: string,
  fetchImpl: typeof fetch = fetch,
  init: RequestInit = {},
): Promise<Response> {
  const failures: string[] = []
  for (const registry of NPM_METADATA_REGISTRIES) {
    const host = registry.replace(/^https:\/\//, '')
    try {
      const response = await fetchImpl(`${registry}${registryPath}`, {
        ...init,
        headers: { Accept: 'application/json', 'User-Agent': 'DSH-Launcher', ...(init.headers as Record<string, string> | undefined) },
        signal: init.signal ?? AbortSignal.timeout(NPM_METADATA_TIMEOUT_MS),
      })
      if (response.status === 404 || response.ok) return response
      failures.push(`${host} 返回 HTTP ${response.status}`)
    } catch (error) {
      failures.push(`${host} ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`读取 npm 元数据失败：${failures.join('；')}`)
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