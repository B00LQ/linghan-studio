/**
 * Look at a picture node's versions side by side.
 *
 * The version strip on the card is a picker: it is thumbnail-sized and only ever
 * shows one at a time. Choosing between versions is a *comparison* — two pictures
 * 300px wide, one after the other, is how you end up keeping the wrong one
 * because you forgot what the previous one looked like.
 *
 * So this shows every version at once, in the order they were produced (the same
 * numbering the strip uses), with what each one cost in time and what made it.
 * Clicking a picture enlarges it; 「用这张」 is the only thing that changes which
 * version the card shows.
 */
import { useEffect, useState } from 'react'
import type { TakeInfo } from '../api.ts'

/** Props for {@link CompareView}. */
export interface CompareViewProps {
  /** Node's display name, so the header says which picture. */
  nodeLabel: string
  /** Versions of this node's history, newest first (as the API returns them). */
  takes: TakeInfo[]
  /** Take currently shown on the card. */
  currentTakeId?: string
  /** Switch the card to this version and mark it chosen. */
  onUse: (takeId: string) => void
  /** Close the overlay. */
  onClose: () => void
}

/** One line describing how a version came to be. */
function describe(take: TakeInfo): string {
  if (take.status !== 'succeeded') return take.error ?? '没做出来'
  const parts: string[] = []
  // An edit did not run a model, so reporting a duration for it would be
  // inventing information — but which operation it was is worth saying.
  const edited = take.providerId === 'studio-edit'
  parts.push(take.model === '' ? (edited ? '编辑' : '生成') : take.model)
  if (!edited && typeof take.latencyMs === 'number' && take.latencyMs > 0) {
    parts.push(`${String(Math.round(take.latencyMs / 1000))}s`)
  }
  if (typeof take.seed === 'number') parts.push(`种子 ${String(take.seed)}`)
  return parts.join(' · ')
}

/**
 * The comparison overlay.
 * @param props - see {@link CompareViewProps}.
 * @returns the dialog.
 */
export function CompareView({ nodeLabel, takes, currentTakeId, onUse, onClose }: CompareViewProps) {
  // Oldest first, matching the 第 N 版 numbering the card and strip use.
  const ordered = [...takes].reverse()
  const usable = ordered.filter((take) => take.status === 'succeeded' && take.assetId !== '')
  const [zoom, setZoom] = useState<string | null>(null)

  const zoomIndex = usable.findIndex((take) => take.id === zoom)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Leave the enlargement first: closing everything because you wanted to
        // step back out of one picture is the wrong amount of closing.
        if (zoom !== null) { setZoom(null); return }
        onClose()
        return
      }
      if (zoom === null) return
      if (event.key === 'ArrowRight' && zoomIndex >= 0 && zoomIndex < usable.length - 1) {
        setZoom((usable[zoomIndex + 1] as TakeInfo).id)
      }
      if (event.key === 'ArrowLeft' && zoomIndex > 0) {
        setZoom((usable[zoomIndex - 1] as TakeInfo).id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose, usable, zoom, zoomIndex])

  const zoomed = usable.find((take) => take.id === zoom)

  return (
    <div className="compare-view" role="dialog" aria-label="对比版本" data-testid="compare-view">
      <div className="preview-scrim" onClick={onClose} />
      <div className="compare-body">
        <header>
          <span className="compare-title">对比「{nodeLabel}」的 {ordered.length} 个版本</span>
          <span className="muted">{usable.length} 张可用</span>
          <span className="muted">点图片放大，Esc 逐步退出</span>
          <button type="button" className="link preview-close" title="关闭（Esc）" onClick={onClose}>✕</button>
        </header>

        <div className="compare-strip" data-testid="compare-strip">
          {ordered.map((take, index) => {
            const failed = take.status !== 'succeeded' || take.assetId === ''
            const isShown = take.id === currentTakeId
            return (
              <figure
                key={take.id}
                className={`compare-cell${isShown ? ' is-shown' : ''}${failed ? ' is-failed' : ''}`}
                data-take-id={take.id}
              >
                <div className="compare-frame">
                  {failed
                    ? <span className="cell-failed">{take.error ?? '失败'}</span>
                    : (
                      <img
                        src={`/api/assets/${take.assetId}`}
                        alt={`第 ${String(index + 1)} 版`}
                        title="点击放大"
                        onClick={() => { setZoom(take.id) }}
                      />
                    )}
                  {take.mark === 'selected' ? <span className="compare-badge" title="当前选用">✓ 选用</span> : null}
                </div>
                <figcaption>
                  <span className="compare-no">第 {index + 1} 版</span>
                  <span className="muted">{describe(take)}</span>
                  <span className="compare-actions">
                    {isShown
                      ? <span className="muted">正在看这张</span>
                      : (
                        <button
                          type="button"
                          className="link"
                          disabled={failed}
                          title="让这张卡片显示这一版"
                          onClick={() => { onUse(take.id) }}
                        >用这张</button>
                      )}
                  </span>
                </figcaption>
              </figure>
            )
          })}
        </div>
      </div>

      {zoomed === undefined ? null : (
        <div className="compare-zoom" data-testid="compare-zoom">
          <div className="preview-scrim" onClick={() => { setZoom(null) }} />
          <div className="zoom-body">
            <header>
              <span className="muted">{zoomIndex + 1} / {usable.length}</span>
              <span className="muted">{describe(zoomed)}</span>
              <button
                type="button"
                className="link"
                disabled={zoomed.id === currentTakeId}
                onClick={() => { onUse(zoomed.id); setZoom(null) }}
              >用这张</button>
              <button type="button" className="link preview-close" title="退出放大（Esc）" onClick={() => { setZoom(null) }}>✕</button>
            </header>
            <div className="zoom-stage">
              <button
                type="button"
                className="preview-step prev"
                title="上一张（←）"
                disabled={zoomIndex <= 0}
                onClick={() => { const previous = usable[zoomIndex - 1]; if (previous !== undefined) setZoom(previous.id) }}
              >‹</button>
              <img src={`/api/assets/${zoomed.assetId}`} alt="放大查看" />
              <button
                type="button"
                className="preview-step next"
                title="下一张（→）"
                disabled={zoomIndex >= usable.length - 1}
                onClick={() => { const next = usable[zoomIndex + 1]; if (next !== undefined) setZoom(next.id) }}
              >›</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
