import { parseGitHubImportUrl } from './github-import'

/**
 * 「手动添加插件」的输入解析（issue #10）。
 *
 * 只有一个输入框、不给来源单选：GitHub 链接与 npm 包名的形状差异足够大，可以判定出来。
 * 判定结果决定了走哪条安装路径（`dsh plugin add github:owner/repo` 或
 * `dsh plugin add <name>[@<version>]`），两条都不碰精选目录、也不碰 GitHub 分析接口——
 * 这正是市场页打不开时需要的性质。
 */

export interface PluginAddTarget {
  kind: 'github' | 'npm'
  /** github：owner/repo；npm：不含版本的包名。 */
  name: string
  version?: string
  /** 一行确认文案。 */
  display: string
}

/** 与主进程 `isSafePackageName` / `validateNpmVersion` 同一套形状；这里是提前一轮，报错更好看。 */
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const NPM_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/
/** 裸 `owner/repo`：带斜杠又不像包名，只可能是仓库。 */
const BARE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const SCP_LINK = /^git@/i
const HOST_WITH_PATH = /[A-Za-z0-9-]+\.[A-Za-z]{2,}[:/]/i

const PACKAGE_HINT = '插件名称无效：请输入 npm 包名（如 dsh-example 或 @scope/dsh-example），也可以填 GitHub 仓库链接。'

export function parsePluginAddInput(value: string): PluginAddTarget {
  const input = value.trim()
  if (!input) throw new Error('请输入 GitHub 仓库链接或 npm 包名。')

  // 链接形状一律交给 GitHub 解析器：它报错说的是「只支持 GitHub 仓库链接」，
  // 比让一个 gitlab 地址掉进包名分支、吐一句含糊的「插件名称无效」有用得多。
  const looksLikeLink = URL_SCHEME.test(input)
    || SCP_LINK.test(input)
    || HOST_WITH_PATH.test(input)
    || /^github:/i.test(input)
    || BARE_REPOSITORY.test(input)
  if (looksLikeLink) {
    const parsed = parseGitHubImportUrl(input)
    return { kind: 'github', name: parsed.fullName, display: `GitHub 仓库 ${parsed.fullName}` }
  }

  // `@scope/name` 的 @ 在 0 位，不算版本分隔符。
  const separator = input.lastIndexOf('@')
  const packageName = separator > 0 ? input.slice(0, separator) : input
  const version = separator > 0 ? input.slice(separator + 1) : undefined
  if (!NPM_PACKAGE.test(packageName)) throw new Error(PACKAGE_HINT)
  if (version !== undefined && !NPM_VERSION.test(version)) {
    throw new Error('版本格式无效：可以写 1.2.3、0.1.7-rc.1 或 latest，也可以不写版本号装最新版。')
  }
  return {
    kind: 'npm',
    name: packageName,
    ...(version !== undefined && version !== '' ? { version } : {}),
    display: `npm 包 ${packageName}${version ? `@${version}` : ''}`,
  }
}
