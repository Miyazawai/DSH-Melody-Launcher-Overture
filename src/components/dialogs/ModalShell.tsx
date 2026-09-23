import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

/**
 * 弹窗骨架：遮罩 + section + header（图标 / 标题 / 右上角关闭）+ 内容区 + footer。
 *
 * 抽出来的理由不是省那几行，而是抄写会让每份各自漂移：叉在不在右上角、
 * aria-labelledby 有没有、Escape 通不通、内容区包不包 .modal-content——
 * 之前 7 个弹窗就是 7 个答案。样式契约见 styles.css 的 `.modal > header`。
 */
export interface ModalShellProps {
  /** 同时作为 aria-labelledby 指向的 h2 id，需全应用唯一。 */
  titleId: string
  icon: ReactNode
  title: ReactNode
  /** 追加在 .modal 上的本弹窗专属类（宽度与内容区覆盖都挂在它下面）。 */
  className: string
  onClose: () => void
  /** 关闭按钮禁用（如安装进行中）。为真时 Escape 同样不放行。 */
  closeDisabled?: boolean
  /** 点遮罩是否关闭。"必须做出选择"的弹窗（更新提示）设 false。 */
  dismissOnBackdrop?: boolean
  footer?: ReactNode
  children: ReactNode
}

export function ModalShell(props: ModalShellProps) {
  const { titleId, icon, title, className, onClose, closeDisabled = false, dismissOnBackdrop = true, footer, children } = props

  useEffect(() => {
    if (closeDisabled) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeDisabled, onClose])

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={dismissOnBackdrop ? (event => { if (event.currentTarget === event.target) onClose() }) : undefined}
    >
      <section className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <div>{icon}<h2 id={titleId}>{title}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={closeDisabled} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="modal-content">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  )
}
