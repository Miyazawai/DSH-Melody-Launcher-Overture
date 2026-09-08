import { useCallback, useEffect, useRef, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { errorText } from '../lib/format'
import type { PackAnalysis, PackInstallResult } from '../types'
import { useAsyncAction } from './use-async-action'
import type { ToastState } from './use-toast'

/**
 * 整合包创建 / 导入的渲染层流式状态机。
 *
 * 与 use-ai-install 相同：任务事件走 onPackProgress 流，createPack / importPack 的
 * Promise 只负责「兜底结算」——真实主进程先流式推事件再 resolve；demo API 只 resolve
 * 不推事件，因此结算函数里要在两者之间做幂等保护（settledRef）。
 *
 * phase 语义：
 *  - idle       对话框关闭 / 初始
 *  - preview    导入流程：analyze 完成后展示可勾选清单
 *  - installing 创建或导入正在执行（事件流或等待 Promise）
 *  - done       得到 PackInstallResult
 *  - error      解析或安装失败
 */

export type PackInstallPhase = 'idle' | 'preview' | 'installing' | 'done' | 'error'

/** 对话框日志里的一条记录。 */
export interface PackInstallLogEntry {
  id: number
  kind: 'status' | 'item' | 'error' | 'success'
  text: string
}

/** item-start / item-done 驱动的逐项进度。 */
export interface PackItemProgress {
  current: string | null
  done: number
  total: number
}

const IDLE_ITEM_PROGRESS: PackItemProgress = { current: null, done: 0, total: 0 }

export function usePackInstall(onSettled: () => void, showToast: (toast: ToastState) => void) {
  const api = useLauncherApi()
  const { busy, run } = useAsyncAction(showToast)

  const [phase, setPhase] = useState<PackInstallPhase>('idle')
  const [events, setEvents] = useState<PackInstallLogEntry[]>([])
  const [result, setResult] = useState<PackInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<PackAnalysis | null>(null)
  const [importPath, setImportPath] = useState<string | null>(null)
  const [itemProgress, setItemProgress] = useState<PackItemProgress>(IDLE_ITEM_PROGRESS)
  const [hasSnapshot, setHasSnapshot] = useState(false)

  /** 当前任务是否已结算，避免 Promise 与事件双重结算。 */
  const settledRef = useRef(false)
  const settledCallbackRef = useRef(onSettled)
  settledCallbackRef.current = onSettled
  const nextLogId = useRef(0)

  const appendLog = useCallback((kind: PackInstallLogEntry['kind'], text: string) => {
    nextLogId.current += 1
    setEvents(current => [...current, { id: nextLogId.current, kind, text }])
  }, [])

  /** 结算一次（done / error 都只触发一次 onSettled，由调用方刷新包列表）。 */
  const finish = useCallback(() => {
    if (settledRef.current) return
    settledRef.current = true
    settledCallbackRef.current()
  }, [])

  /** 清空一次任务的所有临时状态，但保留 phase（由调用方决定下一个 phase）。 */
  const resetTask = useCallback(() => {
    nextLogId.current = 0
    settledRef.current = false
    setEvents([])
    setResult(null)
    setError(null)
    setAnalysis(null)
    setImportPath(null)
    setItemProgress(IDLE_ITEM_PROGRESS)
    setHasSnapshot(false)
  }, [])

  /** Promise 兜底结算：拿到结果后写入 done（若事件流已结算则跳过）。 */
  const adoptResult = useCallback((next: PackInstallResult) => {
    if (settledRef.current) return
    setResult(next)
    setPhase('done')
    setItemProgress(current => ({ current: null, done: next.installed.length, total: current.total || next.installed.length }))
    const failureText = next.failures.length > 0 ? `，${next.failures.length} 个失败` : ''
    appendLog('success', `完成：成功安装 ${next.installed.length} 个组件${failureText}。`)
    finish()
  }, [appendLog, finish])

  /** Promise 兜底结算：出错写入 error。 */
  const adoptError = useCallback((err: unknown) => {
    if (settledRef.current) return
    const message = errorText(err)
    setError(message)
    setPhase('error')
    appendLog('error', message)
    finish()
  }, [appendLog, finish])

  /** 订阅主进程的流式进度事件。 */
  useEffect(() => {
    const unsubscribe = api.onPackProgress(event => {
      switch (event.kind) {
        case 'status':
          appendLog('status', event.message)
          break
        case 'phase':
          setItemProgress(current => ({ ...current, total: event.itemTotal ?? current.total }))
          break
        case 'item-start':
          setItemProgress(current => ({ ...current, current: event.packageName, total: current.total || 0 }))
          appendLog('item', `开始安装 ${event.packageName}${event.offline ? '（离线本体）' : ''}…`)
          break
        case 'item-done':
          setItemProgress(current => ({ current: null, done: current.done + 1, total: current.total }))
          appendLog(
            event.ok ? 'success' : 'error',
            event.ok ? `已安装 ${event.packageName}` : `安装 ${event.packageName} 失败：${event.reason ?? '未知原因'}`,
          )
          break
        case 'snapshot':
          setHasSnapshot(true)
          appendLog('status', '已为当前整合包生成配置快照，可一键还原。')
          break
        case 'done':
          setResult(event.result)
          setPhase('done')
          // done 事件不覆盖逐项累计的 done 计数：item-done 已按项累加，结果里只统计成功的数量。
          setItemProgress(current => ({ current: null, done: current.done, total: current.total }))
          appendLog('success', `整合包处理完成：成功安装 ${event.result.installed.length} 个组件。`)
          finish()
          break
        case 'cancelled':
          setError('任务已取消。')
          setPhase('error')
          appendLog('error', '任务已取消。')
          finish()
          break
        case 'error':
          setError(event.message)
          setPhase('error')
          appendLog('error', event.message)
          finish()
          break
      }
    })
    return unsubscribe
  }, [api, appendLog, finish])

  /** 自建整合包：直接进入安装流程。 */
  const startCreate = useCallback(async (
    name: string,
    description: string,
    packageNames: string[],
    presetNames: string[] = [],
    skillNames: string[] = [],
    applicationIds: string[] = [],
  ): Promise<boolean> => {
    resetTask()
    setPhase('installing')
    setItemProgress({ current: null, done: 0, total: packageNames.length + presetNames.length + skillNames.length + applicationIds.length })
    appendLog('status', `开始创建整合包「${name}」…`)
    try {
      const next = await api.createPack({ name, description, packageNames, presetNames, skillNames, applicationIds })
      adoptResult(next)
      return true
    } catch (err) {
      adoptError(err)
      return false
    }
  }, [adoptError, adoptResult, api, appendLog, resetTask])

  /** 导入整合包：先 analyze 拿预览，进入 preview 态。 */
  const startImport = useCallback(async (path: string): Promise<PackAnalysis | undefined> => {
    resetTask()
    setPhase('installing')
    appendLog('status', '正在解析整合包文件…')
    try {
      const next = await api.analyzePackImport(path)
      setAnalysis(next)
      setImportPath(path)
      setPhase('preview')
      const available = next.items.filter(item => item.available).length
      appendLog('status', `解析完成：${next.name}（共 ${next.items.length} 个组件，${available} 个可安装）。`)
      return next
    } catch (err) {
      adoptError(err)
      return undefined
    }
  }, [adoptError, api, appendLog, resetTask])

  /** 预览确认后真正执行导入；name 仅在 raw 扫描导入（可编辑包名）时传入。 */
  const confirmImport = useCallback(async (path: string, selectedItems: string[], name?: string): Promise<boolean> => {
    nextLogId.current = 0
    settledRef.current = false
    setEvents([])
    setResult(null)
    setError(null)
    setItemProgress({ current: null, done: 0, total: selectedItems.length })
    setHasSnapshot(false)
    setPhase('installing')
    appendLog('status', `开始导入整合包（${selectedItems.length} 个组件）…`)
    try {
      const next = await api.importPack(path, selectedItems, name && name.trim() ? { name: name.trim() } : undefined)
      adoptResult(next)
      return true
    } catch (err) {
      adoptError(err)
      return false
    }
  }, [adoptError, adoptResult, api, appendLog])

  /** 一次性动作：还原安装前的配置快照。 */
  const rollback = useCallback(async () => {
    const next = await run('pack-rollback', () => api.rollbackPack())
    if (next) appendLog('status', `已还原整合包「${next.profileName}」（${next.restored} 个文件）。`)
    return next
  }, [api, appendLog, run])

  /** 关闭对话框，回到初始态。 */
  const reset = useCallback(() => {
    resetTask()
    setPhase('idle')
  }, [resetTask])

  const active = phase === 'installing'
  const settled = phase === 'done' || phase === 'error'

  return {
    phase,
    events,
    result,
    error,
    analysis,
    importPath,
    itemProgress,
    hasSnapshot,
    busy,
    active,
    settled,
    startCreate,
    startImport,
    confirmImport,
    rollback,
    reset,
  }
}

export type PackInstallState = ReturnType<typeof usePackInstall>
