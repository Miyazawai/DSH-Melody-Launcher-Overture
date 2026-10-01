import { LoaderCircle, PackagePlus } from 'lucide-react'
import { useState } from 'react'
import { useLauncherApi } from '../../api/client'
import { errorText } from '../../lib/format'
import { parsePluginAddInput } from '../../lib/plugin-add'
import { ModalShell } from './ModalShell'

interface PluginAddDialogProps {
  /** 插件装进哪个整合包：安装永远落在当前激活的那个包上。 */
  profileName: string | null
  onClose: () => void
  /** 装完让上层重读当前包的插件列表。 */
  onInstalled: () => Promise<void> | void
}

/**
 * 手动添加插件（issue #10）：填 GitHub 地址或 npm 包名就能装，不依赖 DSH Market 目录，
 * 也不调用 GitHub 的分析接口——市场页打不开的时候这两点才是要紧的。
 */
export function PluginAddDialog({ profileName, onClose, onInstalled }: PluginAddDialogProps) {
  const api = useLauncherApi()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    let target: ReturnType<typeof parsePluginAddInput>
    try {
      target = parsePluginAddInput(value)
    } catch (cause) {
      setError(errorText(cause))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (target.kind === 'github') await api.installPlugin(target.name)
      else await api.installPluginFromNpm({ packageName: target.name, ...(target.version !== undefined ? { version: target.version } : {}) })
      await onInstalled()
      onClose()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      className="plugin-add-dialog"
      titleId="plugin-add-title"
      icon={<PackagePlus size={19} />}
      title="手动添加插件"
      onClose={onClose}
      closeDisabled={busy}
      footer={<>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="primary-command" disabled={busy || value.trim() === ''} onClick={() => void submit()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <PackagePlus size={16} />}安装
        </button>
      </>}
    >
      <label className="form-field">
        <span>GitHub 地址或 npm 包名</span>
        <input
          type="text"
          value={value}
          autoFocus
          disabled={busy}
          placeholder="https://github.com/owner/dsh-example 或 @scope/dsh-example@1.2.3"
          onChange={event => { setValue(event.target.value); setError(null) }}
          onKeyDown={event => { if (event.key === 'Enter') void submit() }}
        />
      </label>
      {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError(null)}>忽略</button></div>}
      <p className="dialog-note">
        会装进当前整合包{profileName ? <>「<strong>{profileName}</strong>」</> : null}，并在下次启动 DSH 时生效。切换整合包后请切到目标包再装。
      </p>
      <p className="dialog-note">这条入口不需要插件市场能打开：它直接让 DSH 按你填的来源装，不查精选目录、也不读 GitHub 的接口。</p>
      <p className="dialog-note">npm 包名可以不写版本号（装最新版）。带 <code>@version</code> 时写 <code>1.2.3</code>、<code>0.1.7-rc.1</code> 或 <code>latest</code>。</p>
      <p className="dialog-note">填 GitHub 地址时给到<strong>仓库</strong>就行，不用精确到子目录；monorepo 里的子包建议填它的 npm 包名，装完才是可比的版本号。</p>
      <p className="dialog-note">如果装完提示「DSH 没有把它识别为有效 Bundle」，说明这个包本身不是 DSH 插件，或者还缺插件补丁文件。</p>
    </ModalShell>
  )
}
