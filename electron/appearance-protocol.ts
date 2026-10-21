import { net, protocol } from 'electron'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { APPEARANCE_SCHEME, resolveAppearanceAssetName } from './appearance'

/**
 * 外观图片的自定义协议。
 * 渲染层在 dev（http://127.0.0.1:4173）下加载 file:// 会被 webSecurity 拦掉，
 * 所以统一走 dsh-appearance://<background|logo>.<ext>，handler 只映射到
 * userData/appearance/ 下的两个固定文件名——协议本身不暴露任意路径读取。
 */

/** 必须在 app ready 之前调用（registerSchemesAsPrivileged 的硬性要求）。 */
export function registerAppearanceScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APPEARANCE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

/** app ready 之后调用；只放行 userData/appearance 下的两张固定图，且不缓存（换图立即生效）。 */
export function registerAppearanceProtocol(directory: string): void {
  protocol.handle(APPEARANCE_SCHEME, async request => {
    const name = resolveAppearanceAssetName(request.url)
    if (!name) return new Response('Not found', { status: 404 })
    const filePath = path.join(directory, name)
    const info = await stat(filePath).catch(() => null)
    if (!info?.isFile()) return new Response('Not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(filePath).toString())
    return new Response(response.body, {
      status: 200,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    })
  })
}
