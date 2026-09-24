import { Check, CopyPlus, Download } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { PackStatus } from '../../types'
import { compareDshVersions, isDshVersionOlderThan } from '../../lib/dsh-version'
import { ModalShell } from './ModalShell'

export interface PackVersionCloneDialogProps {
  packName: string
  currentVersion: string | null
  /** 本机已装的 DSH 版本（不用下载）。 */
  installedVersions: string[]
  /** registry 上可下载的版本（选中会先装再复制）。 */
  availableVersions: string[]
  busy: boolean
  onClone(request: { dshVersion: string; name?: string }): Promise<PackStatus | undefined>
  /**
   * 选中的版本本机还没装时走这里：关窗、跳到「DSH版本」页并启动下载。
   * 下载交给版本页那套有进度条的流程，本弹窗不再偷偷先装一遍。
   */
  onDownloadFirst(version: string): void
  onClose(): void
}

/**
 * 「切换版本」：复制一个新整合包去认另一个 DSH 版本，原包分毫不动。
 *
 * 名字叫切换、行为是复制，所以首句必须把它说白——旧包就是这个操作唯一的后悔药
 * （见 docs/adr/0002）。插件与 DSH 版本之间没有机器可读的约束可依据，所以不做插件兼容
 * 预检，装不上就当场失败并把原因讲清楚；但**数据格式只升不降**是 DSH 自己写死的规则，
 * 这条必须在选版本时就挡掉（见 isDshVersionOlderThan 与 electron/pack.ts 的 downgradeRejection）。
 */
export function PackVersionCloneDialog(props: PackVersionCloneDialogProps) {
  const { packName, currentVersion, installedVersions, availableVersions, busy, onClone, onDownloadFirst, onClose } = props
  const candidates = useMemo(() => [...new Set([...installedVersions, ...availableVersions])]
    .filter(version => version !== currentVersion)
    // 比当前包更旧的版本一律不列：新 DSH 已经把包里的数据就地升过格式，旧版读不动。
    .filter(version => !isDshVersionOlderThan(version, currentVersion))
    // 版本号降序：最上面就是"升到最新"这条最常见路径。
    .sort((left, right) => compareDshVersions(right, left)), [installedVersions, availableVersions, currentVersion])
  const [version, setVersion] = useState(candidates[0] ?? '')
  const [name, setName] = useState('')
  const [working, setWorking] = useState(false)
  const [done, setDone] = useState<PackStatus | null>(null)
  const hasOlderOnly = useMemo(() => currentVersion !== null
    && [...installedVersions, ...availableVersions].some(item => isDshVersionOlderThan(item, currentVersion)),
  [installedVersions, availableVersions, currentVersion])
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
    <ModalShell
      className="pack-clone-dialog"
      titleId="pack-clone-title"
      icon={<CopyPlus size={19} />}
      title="切换版本"
      onClose={onClose}
      footer={<>
        <button type="button" className="secondary-button" disabled={working} onClick={onClose}>{done ? '关闭' : '取消'}</button>
        {!done && (needsDownload ? (
          <button type="button" className="primary-command" disabled={busy || !version} onClick={() => onDownloadFirst(version)}>
            <Download size={16} />先下载 DSH {version}
          </button>
        ) : (
          <button type="button" className="primary-command" disabled={disabled} onClick={() => void cloneNow()}>
            {working ? '正在复制…' : '复制为新包'}
          </button>
        ))}
      </>}
    >
      {done ? (
        <>
          <p className="pack-clone-done"><Check size={15} />已复制出「{done.name}」，它使用 DSH {done.dshVersion}。</p>
          <p className="dialog-note">原来的「{packName}」仍是 DSH {currentVersion ?? '未标注'}，随时可以在整合包页切回去用。</p>
        </>
      ) : candidates.length === 0 ? (
        <div className="custom-api-empty">
          {hasOlderOnly ? <>
            <strong>只能往更新的版本复制</strong>
            <span>「{packName}」的数据已经被 DSH {currentVersion} 升级过存储格式，交回更旧的版本读不动。想留在旧版本，请新建一个空整合包。</span>
          </> : <>
            <strong>还没有其它 DSH 版本可用</strong>
            <span>到「DSH版本」页面装一个，再回来切换。</span>
          </>}
        </div>
      ) : (
        <>
          <p className="dialog-note">当前包「{packName}」<strong>不会有任何改动</strong>：这里是复制一个新包去用你选的版本，用不惯随时回原来那个包继续用。</p>
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
          {needsDownload
            ? <p className="dialog-note">这个版本本机还没有：先点「先下载 DSH {version}」去「DSH版本」页装好（那里有进度条），回来再复制。</p>
            : null}
          <p className="dialog-note">包内插件不会自动升级。新包里如果有的插件用不了，通常是插件还没跟上 DSH {version}。</p>
          <p className="dialog-note">这份副本连聊天记录一起复制，而<strong>数据格式只能往上升</strong>：新 DSH 跑过一次，这些记录就交不回旧版本了（所以列表里不列更旧的版本）。</p>
        </>
      )}
    </ModalShell>
  )
}
