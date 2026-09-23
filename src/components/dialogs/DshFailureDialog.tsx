import { Check, Copy, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import packageMetadata from '../../../package.json'
import type { RuntimeFailure } from '../../types'
import { ModalShell } from './ModalShell'

/**
 * PCL2 式启动失败弹窗：错误摘要 + 完整诊断 + 一键复制「修复引导提示词」。
 * 数据来自主进程记录的 RuntimeFailure（启动命令 / 工作目录 / 退出代码 / stderr）。
 */

export interface DshFailureDialogProps {
  failure: RuntimeFailure
  onClose: () => void
}

/** 把一段文本放进剪贴板：优先 async Clipboard，回退 execCommand（file:// 下也能用）。 */
function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value).then(() => true).catch(() => Promise.resolve(legacyCopy(value)))
  }
  return Promise.resolve(legacyCopy(value))
}

function legacyCopy(value: string): boolean {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

export function DshFailureDialog({ failure, onClose }: DshFailureDialogProps) {
  const [copied, setCopied] = useState(false)

  const { headline, lines } = useMemo(() => {
    const lines = failure.diagnostics.split('\n').map(line => line.trim()).filter(Boolean)
    const headline = lines.find(line => !line.startsWith('启动命令') && !line.startsWith('工作目录') && !line.startsWith('退出代码'))
      ?? '进程没有输出诊断信息'
    return { headline, lines }
  }, [failure])

  const fixPrompt = useMemo(() => {
    const time = new Date(failure.failedAt).toLocaleString('zh-CN', { hour12: false })
    return [
      '你是 DeepSeek Harness（DSH）的启动诊断与修复助手。下面是一次启动失败的完整诊断，请定位根因并给出可执行、最小改动的修复步骤。',
      '',
      '## 环境',
      `- 启动器：DSH 旋律启动器（序曲 Overture）v${packageMetadata.version}`,
      `- 整合包：${failure.profileName || '未知'}`,
      `- 失败时间：${time}`,
      '',
      '## 诊断输出',
      failure.diagnostics.trim(),
      '',
      '## 约束与建议',
      '- 问题发生在整合包隔离环境内：若与插件 / 技能 / 预设相关，请在包内修复（调整或更换对应组件、依赖版本），不要修改 DSH 本体。',
      '- 若诊断不足以定位，请先给出下一步排查命令。',
    ].join('\n')
  }, [failure])

  const handleCopy = () => {
    void copyText(fixPrompt).then(ok => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1600) } })
  }

  return (
    <ModalShell
      className="dsh-failure-dialog"
      titleId="dsh-failure-title"
      icon={<TriangleAlert size={19} />}
      title="DSH 进程异常退出"
      onClose={onClose}
      footer={<>
        <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
        <button type="button" className={`primary-command${copied ? ' is-copied' : ''}`} onClick={handleCopy}>
          {copied ? <Check size={16} /> : <Copy size={16} />}{copied ? '已复制' : '复制修复引导提示词'}
        </button>
      </>}
    >
      <p className="dsh-failure-headline">{headline}</p>
      <div className="dsh-failure-meta">
        <span className="dsh-failure-chip">整合包：{failure.profileName || '未知'}</span>
        <span className="dsh-failure-chip">{new Date(failure.failedAt).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>
      <pre className="dsh-failure-log" role="log">{failure.diagnostics.trim()}</pre>
      <p className="dsh-failure-hint">
        把「修复引导提示词」复制给其它 AI 助手或原版 DSH，让它带着完整日志直接开始修复。
      </p>
    </ModalShell>
  )
}
