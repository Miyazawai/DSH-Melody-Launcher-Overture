import { ChevronLeft, ChevronRight } from 'lucide-react'

/** 长列表底部分页条（资源市场、DSH Market 共用）。 */

interface CatalogPaginationProps {
  page: number
  pageCount: number
  /** 分页条左侧的整句说明：各列表口径不同，由调用方给全句。 */
  summary: string
  /** 可访问名，说明这组上一页/下一页控制的是哪类列表。 */
  label: string
  loading?: boolean
  disabled?: boolean
  onPageChange: (page: number) => void
}

export function CatalogPagination({ page, pageCount, summary, label, loading = false, disabled = false, onPageChange }: CatalogPaginationProps) {
  const normalizedPageCount = Math.max(1, pageCount)
  const controlsDisabled = loading || disabled

  return (
    <div className="catalog-pagination" role="navigation" aria-label={label}>
      <p>{summary}</p>
      <div className="catalog-page-controls">
        <button type="button" disabled={controlsDisabled || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页" title="上一页"><ChevronLeft size={17} /></button>
        <span aria-live="polite">第 {page} / {normalizedPageCount} 页</span>
        <button type="button" disabled={controlsDisabled || page >= normalizedPageCount} onClick={() => onPageChange(page + 1)} aria-label="下一页" title="下一页"><ChevronRight size={17} /></button>
      </div>
    </div>
  )
}
