/**
 * DSH 凭据引用名（credential ref）的合法化规则。
 *
 * 单独成一个纯模块是因为两侧都要用同一套判定：启动器读写 `.credentials.yaml` 时用它，
 * 启动前把旧文件里非法的名字改成合法名字时也用它。改名规则必须**幂等**——同一份文件
 * 改第二次时应当一条都不用改，否则每次启动都会重写凭据文件、每次都会多一份备份。
 */

/** 与上游 `@deepseek-ai/dsh-credentials` 的 REF_PATTERN 逐字一致。 */
export const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 上游不限制引用名长度，这里截断只是为了人类可读；预留 8 个字符给 `_2`、`_3`
 * 这类去重后缀，加完后缀仍然不会超过 MAX_REF_NAME。
 */
const BASE_LIMIT = 120
const MAX_REF_NAME = 128
const FALLBACK_NAME = 'CREDENTIAL'

export interface RefRename {
  from: string
  to: string
}

/**
 * 把一个非法引用名转成合法标识符；合法名原样返回。
 *
 * 一律大写有两个理由：与 `credentialNameForRoute()` 生成的名字风格一致；且大写后的结果
 * 永远不会撞上 YAML 的小写保留字（`true`/`null`/`inf`/`~`），这样改写后的键一定能以无引号
 * 的 PLAIN 标量写出去，再被 DSH 读回成同一个字符串。
 */
export function normalizeRefName(name: string): string {
  if (CREDENTIAL_NAME.test(name)) return name
  let base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!base) base = FALLBACK_NAME
  if (!/^[A-Za-z_]/.test(base)) base = `_${base}`
  base = base.slice(0, BASE_LIMIT).replace(/_+$/, '')
  return base || FALLBACK_NAME
}

/**
 * 按文档顺序给非法名字分配新名字。
 *
 * 关键约束：**合法名永不改写、永不改值**。若某个非法名规范化后正好撞上已存在的合法名
 * （`deepseek-api-key` 撞 `DEEPSEEK_API_KEY`），非法那条拿 `_2` 后缀，而不是去动那条本来
 * 就能用的——这是「改名不会把一个原本能启动的整合包改坏」的核心保证。
 */
export function planRefRenames(names: readonly string[]): RefRename[] {
  const taken = new Set(names.filter(name => CREDENTIAL_NAME.test(name)))
  const renames: RefRename[] = []
  for (const name of names) {
    if (CREDENTIAL_NAME.test(name)) continue
    const base = normalizeRefName(name)
    let candidate = base
    for (let suffix = 2; taken.has(candidate); suffix += 1) {
      candidate = `${base.slice(0, MAX_REF_NAME - String(suffix).length - 1)}_${suffix}`
    }
    taken.add(candidate)
    renames.push({ from: name, to: candidate })
  }
  return renames
}

/** 一行可读的改名摘要；只含名字，绝不含密钥值。 */
export function describeRefRenames(renames: readonly RefRename[]): string {
  return renames.map(rename => `${rename.from}→${rename.to}`).join('、')
}
