import type { LaunchFailureStage } from '../types'

/**
 * 启动失败的文案规则，主进程与渲染层共用一份。
 *
 * 放这里而不是 electron/runtime.ts：渲染层不能 import 主进程模块（会把 electron
 * 依赖拖进浏览器包），而 headline 的解析规则两边都得一样——否则弹窗说的和 toast
 * 说的是两句话。
 */

/** 失败阶段的用户可读名字：诊断首行、弹窗标题、给 agent 的提示词都用它。 */
export const LAUNCH_STAGE_LABELS: Record<LaunchFailureStage, string> = {
  port: '准备本地端口',
  spawn: '拉起 DSH 进程',
  exited: '运行中退出',
}

/** 弹窗标题：让用户一眼看出是"没起来"还是"起来又停了"。 */
export const LAUNCH_STAGE_TITLES: Record<LaunchFailureStage, string> = {
  port: 'DSH 启动失败：端口不可用',
  spawn: 'DSH 启动失败：进程没能拉起',
  exited: 'DSH 进程异常退出',
}

/** 诊断里属于"元信息"的前缀，挑原因时要跳过。 */
const METRIC_PREFIXES = ['失败阶段：', '启动命令：', '工作目录：', '退出代码：', '期望端口：', '常见原因：']

/** 从诊断文本里挑一句当"哪里出错了"：跳过元信息，取第一句实质内容。 */
export function launchFailureHeadline(diagnostics: string): string {
  const lines = diagnostics.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.find(line => !METRIC_PREFIXES.some(prefix => line.startsWith(prefix)))
    ?? '进程没有输出更多信息'
}

/** 取诊断首行的阶段标签；取不到就按"运行中退出"处理（历史数据没有这一行）。 */
export function launchFailureStageLabel(stage: LaunchFailureStage | undefined): string {
  return LAUNCH_STAGE_LABELS[stage ?? 'exited']
}
