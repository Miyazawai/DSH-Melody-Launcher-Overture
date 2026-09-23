import { Check, CopyPlus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { PackStatus } from '../../types'

export interface PackVersionCloneDialogProps {
  packName: string
  currentVersion: string | null
  /** 本机已装的 DSH 版本（不用下载）。 */
  installedVersions: string[]
  /** registry 上可下载的版本（选中会先装再复制）。 */
  availableVersions: string[]
  busy: boolean
  onClone(request: { dshVersion: string; name?: string }): Promise<PackStatus | undefined>
  onClose(): void
}

/**
 * 「切换版本」：复制一个新整合包去认另一个 DSH 版本，原包分毫不动。
 *
 * 名字叫切换、行为是复制，所以首句必须把它说白——旧包就是这个操作唯一的后悔药
 * （见 docs/adr/0002）。刻意不做兼容性预检：插件与 DSH 版本之间没有任何机器可读的
 * 约束可依据，装不上就当场失败并把原因讲清楚。
 */
export function PackVersionCloneDialog(props: PackVersionCloneDialogProps) {
  const { packName, currentVersion, installedVersions, availableVersions, busy, onClone, onClose } = props
  const candidates = useMemo(() => [...new Set([...installedVersions, ...availableVersions])]
    .filter(version => version !== currentVersion)
    // 版本号降序：最上面就是"升到最新"这条最常见路径。
    .sort((left, right) => (left === right ? 0 : left < right ? 1 : -1)), [installedVersions, availableVersions, currentVersion])
  const [version, setVersion] = useState(candidates[0] ?? '')
  const [name, setName] = useState('')
  const [working, setWorking] = useState(false)
  const [done, setDone] = useState<PackStatus | null>(null)
  const needsDownload = version !== '' && !installedVersions.includes(version)
  const resolvedName = name.trim() || `${packName} · DSH ${version}`
  const disabled = busy || working || !version

  async function cloneNow(): Promise<void> {
    setWorking(true)
    try {
      const created = await onClone({ dshVersion: version, name: resolvedName })
      if (created) setDone(created)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal pack-clone-dialog" role="dialog" aria-modal="true" aria-labelledby="pack-clone-title">
        <header>
          <div><CopyPlus size={19} /><h2 id="pack-clone-title">切换版本</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="modal-content">
          {done ? (
            <>
              <p className="pack-clone-done"><Check size={15} />已复制出「{done.name}」，它使用 DSH {done.dshVersion}。</p>
              <p className="dialog-note">原来的「{packName}」仍是 DSH {currentVersion ?? '未标注'}，随时可以在整合包页切回去用。</p>
            </>
          ) : candidates.length === 0 ? (
            <div className="custom-api-empty">
              <strong>还没有其它 DSH 版本可用</strong>
              <span>到「DSH版本」页面装一个，再回来切换。</span>
            </div>
          ) : (
            <>
              <p className="dialog-note">当前包「{packName}」<strong>不会有任何改动</strong>：这里是复制一个新包去用你选的版本，用不惯随时切回来。</p>
              <div className="dialog-choice-list pack-clone-versions">
                {candidates.map(candidate => (
                  <label key={candidate} className={`dialog-choice${version === candidate ? ' selected' : ''}`}>
                    <input
                      type="radio"
                      name="pack-clone-version"
                      checked={version === candidate}
                      disabled={disabled}
                      onChange={() => { setVersion(candidate); setName('') }}
                    />
                    <span>
                      <strong>DSH {candidate}</strong>
                      <small>{installedVersions.includes(candidate) ? '本机已装' : '需要下载（约 100MB）'}</small>
                    </span>
                  </label>
                ))}
              </div>
              <label className="form-field">
                <span>新包名称</span>
                <input type="text" value={resolvedName} disabled={disabled} onChange={event => setName(event.target.value)} />
              </label>
              {needsDownload && <p className="dialog-note">会先下载并安装 DSH {version}，再复制包内内容；期间不要关机。</p>}
              <p className="dialog-note">包内插件不会自动升级。新包里如果有的插件用不了，通常是插件还没跟上 DSH {version}。</p>
            </>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={working} onClick={onClose}>{done ? '关闭' : '取消'}</button>
          {!done && (
            <button type="button" className="primary-command" disabled={disabled} onClick={() => void cloneNow()}>
              {working ? '正在复制…' : '复制为新包'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
