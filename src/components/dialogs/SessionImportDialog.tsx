import { ArrowLeft, ArrowRight, History, MessagesSquare, ShieldAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PackStatus, SessionImportPreview, SessionImportResult, SessionImportUndoResult } from '../../types'

export interface SessionImportDialogProps {
  /** 要导入到的那个包：入口长在它的卡片上，方向永远是"别人的记录搬进我"。 */
  targetPackId: string
  targetPackName: string
  packs: PackStatus[]
  busy: boolean
  onPreview(sourcePackId: string): Promise<SessionImportPreview>
  onImport(sourcePackId: string): Promise<SessionImportResult | undefined>
  onUndo(undoId: string): Promise<SessionImportUndoResult | undefined>
  onClose(): void
}

/** 界面阶段：选源包 → 看预览确认 → 看结果（含撤销）。 */
type Phase = 'pick' | 'preview' | 'result'

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB`
}

/**
 * 「导入会话」：把另一个整合包的会话记录复制进当前这个包。
 *
 * 只复制、不移动：源包一条记录都不少。哪些记录不能搬（工作目录没了、格式比本包的
 * DSH 还新等）由主进程逐条判定后报回来，界面如实列出，不做"全部成功"的粉饰。
 */
export function SessionImportDialog(props: SessionImportDialogProps) {
  const { targetPackId, targetPackName, packs, busy, onPreview, onImport, onUndo, onClose } = props
  const [phase, setPhase] = useState<Phase>('pick')
  const [sourcePackId, setSourcePackId] = useState('')
  const [preview, setPreview] = useState<SessionImportPreview | null>(null)
  const [result, setResult] = useState<SessionImportResult | null>(null)
  const [undoNote, setUndoNote] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const candidates = packs.filter(pack => pack.id !== targetPackId)

  useEffect(() => {
    // 换目标包时一切从头来，避免带着上一个包的预览往下点。
    setPhase('pick')
    setSourcePackId('')
    setPreview(null)
    setResult(null)
    setUndoNote(null)
  }, [targetPackId])

  async function showPreview(): Promise<void> {
    if (!sourcePackId) return
    setWorking(true)
    try {
      setPreview(await onPreview(sourcePackId))
      setPhase('preview')
    } finally {
      setWorking(false)
    }
  }

  async function runImport(): Promise<void> {
    setWorking(true)
    try {
      const next = await onImport(sourcePackId)
      if (next) {
        setResult(next)
        setPhase('result')
      }
    } finally {
      setWorking(false)
    }
  }

  async function runUndo(): Promise<void> {
    if (!result?.undoId) return
    setWorking(true)
    try {
      const undone = await onUndo(result.undoId)
      if (undone) setUndoNote(undone.error ?? (undone.kept > 0 ? `已撤回 ${undone.removed} 个文件，另有 ${undone.kept} 个已被 DSH 写过、保留着。` : '已全部撤回。'))
    } finally {
      setWorking(false)
    }
  }

  const sourceName = packs.find(pack => pack.id === sourcePackId)?.name ?? ''
  const shown = result ?? preview
  const disabled = busy || working

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal session-import-dialog" role="dialog" aria-modal="true" aria-labelledby="session-import-title">
        <header>
          <div><MessagesSquare size={19} /><h2 id="session-import-title">导入会话</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="modal-content">
          <p className="dialog-note">导入到：<strong>{targetPackName}</strong></p>

          {phase === 'pick' && (candidates.length === 0 ? (
            <div className="custom-api-empty">
              <strong>本机只有这一个整合包</strong>
              <span>先新建或导入一个包，再来搬会话。</span>
            </div>
          ) : (
            <div className="dialog-choice-list">
              {candidates.map(pack => (
                <label key={pack.id} className={`dialog-choice${sourcePackId === pack.id ? ' selected' : ''}`}>
                  <input
                    type="radio"
                    name="session-import-source"
                    checked={sourcePackId === pack.id}
                    disabled={disabled}
                    onChange={() => { setSourcePackId(pack.id); setPreview(null) }}
                  />
                  <span>
                    <strong>{pack.name}</strong>
                    <small>{pack.dshVersion ? `DSH ${pack.dshVersion}` : '未标注版本'}{pack.plugins.length ? ` · ${pack.plugins.length} 个插件` : ''}</small>
                  </span>
                </label>
              ))}
              <p className="dialog-note">选中的包不会被改动：这是复制，不是移动。</p>
            </div>
          ))}

          {phase !== 'pick' && shown && (
            <div className="settings-about-rows">
              <div><span>可导入会话</span><strong>{shown.importableCount} 条</strong></div>
              <div><span>预计写入</span><strong>{megabytes(shown.importableBytes + shown.extraBytes)}</strong></div>
              <div><span>来源</span><strong>{shown.sourceName}</strong></div>
            </div>
          )}

          {shown && shown.skipped.length > 0 && (
            <ul className="session-import-skipped">
              {shown.skipped.map(item => <li key={item.reason}>{item.count} 条未导入：{item.label}</li>)}
            </ul>
          )}

          {shown && shown.formatUnverified && (
            <div className="dialog-warning">
              <p><ShieldAlert size={14} />目标包里还没有任何会话可参照，无法核对记录格式版本。</p>
              <p className="dialog-note">导入后如果 DSH 打不开某条记录，用「撤销这次导入」退回原状。</p>
            </div>
          )}

          {shown && (shown.dangling.presets.length > 0 || shown.dangling.plugins.length > 0) && (
            <p className="dialog-note">
              这些名字在目标包里不存在，相关记录能看但可能发不出新消息：
              {[...shown.dangling.presets.map(name => `预设 ${name}`), ...shown.dangling.plugins.map(name => `插件 ${name}`)].join('、')}。
            </p>
          )}

          {phase === 'result' && (
            <p className="dialog-note">
              {result && result.importableCount > 0
                ? `已复制 ${result.importableCount} 条会话记录（${result.copiedFiles} 个文件，${megabytes(result.copiedBytes)}）。切到「${targetPackName}」打开原来的项目就能看到。`
                : '没有需要导入的记录，目标包未作改动。'}
              {undoNote ? `　${undoNote}` : ''}
            </p>
          )}
        </div>
        <footer>
          {phase === 'pick' && (
            <>
              <button type="button" className="secondary-button" onClick={onClose}>取消</button>
              <button type="button" className="primary-command" disabled={disabled || !sourcePackId} onClick={() => void showPreview()}>
                {working ? '正在统计…' : '下一步'}<ArrowRight size={16} />
              </button>
            </>
          )}
          {phase === 'preview' && (
            <>
              <button type="button" className="secondary-button" disabled={disabled} onClick={() => setPhase('pick')}><ArrowLeft size={16} />上一步</button>
              <button type="button" className="primary-command" disabled={disabled} onClick={() => void runImport()}>
                {working ? '正在复制…' : `开始导入${preview && preview.importableCount > 0 ? ` ${preview.importableCount} 条` : ''}`}
              </button>
            </>
          )}
          {phase === 'result' && (
            <>
              <button
                type="button"
                className="secondary-button pack-footer-spacer"
                disabled={disabled || !result?.undoId}
                onClick={() => void runUndo()}
                title={result?.undoId ? '删掉这次复制进来的文件' : '没有写入任何文件，无需撤销'}
              >
                <History size={16} />撤销这次导入
              </button>
              <button type="button" className="primary-command" onClick={onClose}>完成</button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
