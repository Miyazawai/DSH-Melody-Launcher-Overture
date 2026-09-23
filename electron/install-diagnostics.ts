/**
 * 安装失败的诊断文案。
 *
 * 起因是一条真实反馈：「整合包处理失败，DSH 0.1.5-rc.2 安装失败（代码 1）」——
 * 用户最后是在评论区里自己说出答案的（"我 node 版本太低了"），说明这句话对他毫无用处。
 * 这里把退出码翻译成「什么原因 + 该点哪里 + 环境快照 + 原始输出」，供弹窗与复制。
 */
import { MIN_NODE_VERSION, PNPM_VERSION } from './node-runtime'
import type { NodeRuntime } from './node-runtime'

/** 输出尾部保留长度：够贴出真正的报错行，又不至于把弹窗撑爆。 */
const OUTPUT_TAIL_CHARS = 4_000

const SOURCE_LABELS: Record<NonNullable<NodeRuntime['origin']>, string> = {
  bundled: '启动器自带',
  managed: '启动器下载',
  system: '本机 PATH',
}

/**
 * 认出「这是 Node/pnpm 版本不匹配」的输出特征。
 * 只收无歧义的说法：npm 的 EBADENGINE、pnpm 的 incompatible、`node:` 前缀模块
 * 认不出来（老 Node 没有）。像 `SyntaxError: Unexpected token '?'` 这种既可能是
 * 老 Node 解析不了 `??`、也可能只是坏 JSON，宁可少认也不给一个错的诊断。
 */
const ENGINE_MISMATCH_PATTERNS: RegExp[] = [
  /EBADENGINE/i,
  /unsupported engine/i,
  /incompatible with this version/i,
  /requires (?:at least )?node\.js version/i,
  /node\.js version .{0,20}is (?:too old|not supported)/i,
  /ERR_UNKNOWN_BUILTIN_MODULE/i,
  /Cannot find module 'node:/i,
]

export interface InstallFailureInfo {
  /** 动作标题，如「DSH 0.1.5-rc.2 安装」。 */
  action: string
  exitCode: number | null
  /** 命令的合并输出（stdout+stderr）。 */
  output: string
  node: NodeRuntime
  /** 该 Node 的探测结果；null 表示探不到。 */
  nodeVersion: string | null
}

/** 命中版本类问题时给一句可照做的提示；否则 null。 */
export function engineMismatchHint(output: string, nodeVersion: string | null): string | null {
  if (!ENGINE_MISMATCH_PATTERNS.some(pattern => pattern.test(output))) return null
  const actual = nodeVersion ?? '未知'
  // 这句以前写的是"去设置里关掉「使用本机安装的 Node.js」"，那个开关已经删了：
  // 现在本机 Node 只有版本达标才会被选中，所以真撞上这句时界面帮不上用户，只能回收日志。
  return `这通常是 Node 版本不匹配：本操作要求 Node ${MIN_NODE_VERSION} 以上，实际用的是 ${actual}。`
    + '启动器只在版本达标时才会用它，出现这句请把下面的日志原文发给我们。'
}

/**
 * 组装给人看的失败说明：摘要 → 可能的原因 → 环境快照 → 原始输出尾部。
 * 顺序是有意的：小白先看前两行就知道点哪里，日志留在最后供复制给 agent。
 */
export function describeInstallFailure(info: InstallFailureInfo): string {
  const code = info.exitCode ?? '未知'
  const lines = [`${info.action}失败（代码 ${code}）。`]
  const hint = engineMismatchHint(info.output, info.nodeVersion)
  if (hint) lines.push('', hint)
  lines.push(
    '',
    '—— 运行环境 ——',
    `Node：${info.node.node}`,
    `版本：${info.nodeVersion ?? '探测失败'}`,
    `来源：${SOURCE_LABELS[info.node.origin ?? 'system']}`,
    `pnpm：${PNPM_VERSION}`,
  )
  const tail = info.output.trimEnd().slice(-OUTPUT_TAIL_CHARS)
  if (tail) lines.push('', '—— 输出末尾 ——', tail)
  return lines.join('\n')
}
