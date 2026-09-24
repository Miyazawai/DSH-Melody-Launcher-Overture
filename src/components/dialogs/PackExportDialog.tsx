import { Package, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { PackExportPrivacy } from '../../types'
import { ModalShell } from './ModalShell'

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
  const anyPrivacy = credentials || sessions

  function exportNow(): void {
    if (anyPrivacy && !warned) {
      setWarned(true)
      return
    }
    // 立刻关窗：主进程是先弹原生保存框、选完位置才开始打包（大包要几分钟）。
    // 弹窗留着会在这段时间里挡死界面，而且 store.exportPack 已经在整合包页
    // 驱动 packStage 进度条 + 完成 toast，这里再挂一个静态「正在导出…」是第二套进度。
    onClose()
    void onExport({ credentials, sessions })
  }

  return (
    <ModalShell
      className="pack-export-dialog"
      titleId="pack-export-title"
      icon={<Package size={19} />}
      title={`导出「${packName}」`}
      onClose={onClose}
      footer={<>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        {warned ? (
          <button type="button" className="danger-button" disabled={busy} onClick={exportNow}>我已明白，继续导出</button>
        ) : (
          <button type="button" className="primary-command" disabled={busy} onClick={exportNow}>导出</button>
        )}
      </>}
    >
      {warned ? (
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
            <input type="checkbox" checked={credentials} disabled={busy} onChange={event => { setCredentials(event.target.checked); setWarned(false) }} />
            <span>
              <strong>附带 API 密钥</strong>
              <small>把这台机器上配置的模型密钥一起打进包。拿到包的人可以直接用它花你的额度。</small>
            </span>
          </label>
          <label className={`dialog-choice${sessions ? ' selected' : ''}`}>
            <input type="checkbox" checked={sessions} disabled={busy} onChange={event => { setSessions(event.target.checked); setWarned(false) }} />
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
    </ModalShell>
  )
}
