import { Check, Package, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'
import type { PackExportPrivacy } from '../../types'

export interface PackExportDialogProps {
  packName: string
  busy: boolean
  onExport(privacy: PackExportPrivacy): Promise<string | null>
  onClose(): void
}

/**
 * 导出整合包：默认全脱敏，两项隐私内容要用户主动勾。
 *
 * 勾了就必须再过一道"这包发出去收不回来"的确认——一旦带密钥的包被转发，损失不可逆。
 * 文件名上的「·含隐私」后缀与包内的警告文件由主进程负责加（见 docs/adr/0001）。
 */
export function PackExportDialog(props: PackExportDialogProps) {
  const { packName, busy, onExport, onClose } = props
  const [credentials, setCredentials] = useState(false)
  const [sessions, setSessions] = useState(false)
  const [warned, setWarned] = useState(false)
  const [working, setWorking] = useState(false)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const anyPrivacy = credentials || sessions
  const disabled = busy || working

  async function exportNow(): Promise<void> {
    if (anyPrivacy && !warned) {
      setWarned(true)
      return
    }
    setWorking(true)
    try {
      const path = await onExport({ credentials, sessions })
      if (path) setSavedTo(path)
      else onClose()
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal pack-export-dialog" role="dialog" aria-modal="true" aria-labelledby="pack-export-title">
        <header>
          <div><Package size={19} /><h2 id="pack-export-title">导出「{packName}」</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="modal-content">
          {savedTo ? (
            <p className="pack-export-done"><Check size={15} />已导出到 {savedTo}</p>
          ) : warned ? (
            <div className="dialog-warning">
              <p className="pack-export-warning-title"><ShieldAlert size={16} />这个压缩包里会有你的隐私</p>
              <ul>
                {credentials && <li>API 密钥：任何人拿到这个包，都能直接用它调用你的账号、花你的额度。</li>}
                {sessions && <li>会话记录：包含你说过的话、收发过的文件，以及你的文件夹路径和用户名。</li>}
              </ul>
              <p className="dialog-note">发出去就收不回来了。确认这是你要的，再往下走。</p>
            </div>
          ) : (
            <>
              <p className="dialog-note">默认导出的整合包不含任何私人数据，可以直接发给别人。要带走自己的东西时再勾下面两项。</p>
              <label className={`dialog-choice${credentials ? ' selected' : ''}`}>
                <input type="checkbox" checked={credentials} disabled={disabled} onChange={event => { setCredentials(event.target.checked); setWarned(false) }} />
                <span>
                  <strong>附带 API 密钥</strong>
                  <small>把这台机器上配置的模型密钥一起打进包。拿到包的人可以直接用它花你的额度。</small>
                </span>
              </label>
              <label className={`dialog-choice${sessions ? ' selected' : ''}`}>
                <input type="checkbox" checked={sessions} disabled={disabled} onChange={event => { setSessions(event.target.checked); setWarned(false) }} />
                <span>
                  <strong>附带会话记录</strong>
                  <small>对话内容、会话里收发过的文件，以及你电脑上的文件夹路径。</small>
                </span>
              </label>
              {sessions && (
                <p className="dialog-note">会话记录只在<strong>项目放在完全相同路径</strong>的那台电脑上看得到；换机器请先拷贝项目文件夹，否则导入后一条都不会显示。</p>
              )}
            </>
          )}
        </div>
        <footer>
          {savedTo ? (
            <button type="button" className="primary-command" onClick={onClose}>完成</button>
          ) : (
            <>
              <button type="button" className="secondary-button" disabled={disabled} onClick={onClose}>取消</button>
              {warned ? (
                <button type="button" className="danger-button" disabled={disabled} onClick={() => void exportNow()}>
                  {working ? '正在导出…' : '我已明白，继续导出'}
                </button>
              ) : (
                <button type="button" className="primary-command" disabled={disabled} onClick={() => void exportNow()}>
                  {working ? '正在导出…' : '导出'}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
