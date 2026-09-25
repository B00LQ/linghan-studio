/**
 * The asset browser: one component, two homes.
 *
 * It is the same library in both places — the canvas's floating 资产 window and
 * the shell's 资产 page — so the filter, the sort and the batch actions must not
 * drift between them. The only differences are the shell around it and what
 * clicking a card does (place it on the canvas vs. nothing).
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 * - **Paging.** A library of 500 full-size PNGs is ~700 MB. Rendering all of them
 *   at once is what made this page freeze.
 * - **Batch actions.** Selecting ten assets and then doing something one at a
 *   time is not a workflow. 全选 works over the *filtered* set, not just the page
 *   that happens to be rendered — otherwise "select all" quietly means "select 60".
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AssetInfo } from '../api.ts'
import { SmallImage } from './SmallImage.tsx'

/** One asset as the browser needs it. */
export type BrowserAsset = AssetInfo & { createdAt: string }

/** A category chip. `match` decides membership by MIME, which is what we store. */
export interface AssetKind {
  /** Stable id, also the API's `kind` filter. */
  id: string
  /** Chip label. */
  label: string
  /** Whether an asset belongs here. */
  match: (asset: BrowserAsset) => boolean
}

/** The categories we can honestly derive from stored metadata. */
export const ASSET_KINDS: AssetKind[] = [
  { id: 'all', label: '全部', match: () => true },
  { id: 'image', label: '图片', match: (asset) => asset.mime.startsWith('image/') },
  { id: 'video', label: '视频', match: (asset) => asset.mime.startsWith('video/') },
  { id: 'audio', label: '音频', match: (asset) => asset.mime.startsWith('audio/') },
  { id: 'other', label: '其他', match: (asset) => !/^(image|video|audio)\//u.test(asset.mime) },
]

/** Sort orders the browser offers. */
export type AssetSort = 'newest' | 'oldest' | 'largest'

/** Labels for the sort menu. */
export const ASSET_SORT_LABEL: Record<AssetSort, string> = {
  newest: '最新优先',
  oldest: '最早优先',
  largest: '按体积',
}

/** How many cards are rendered at a time. */
const PAGE = 60

/** Props for {@link AssetBrowser}. */
export interface AssetBrowserProps {
  /** The library. */
  assets: BrowserAsset[]
  /** Title shown above the grid. */
  title: string
  /** Extra note next to the title. */
  note?: string
  /** Right-hand side of the header (a close button, say). */
  actions?: ReactNode
  /** Batch: put these on a canvas. Omitted when there is nowhere to put them. */
  onPlaceMany?: (ids: string[]) => void
  /** Batch: download as one archive. */
  onDownload?: (ids: string[]) => void
  /** Batch: delete. The server refuses assets a canvas still shows. */
  onDelete?: (ids: string[]) => void
  /** A message to show after a batch action (success or refusal). */
  notice?: string | undefined
}

/**
 * Render the browser.
 * @param props - see {@link AssetBrowserProps}.
 * @returns the browser.
 */
export function AssetBrowser(props: AssetBrowserProps) {
  const { assets, title, note, actions, onPlaceMany, onDownload, onDelete, notice } = props
  const [kind, setKind] = useState('all')
  const [sort, setSort] = useState<AssetSort>('newest')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [shown, setShown] = useState(PAGE)
  /** The asset being previewed full-size, if any. */
  const [preview, setPreview] = useState<string | null>(null)

  const visible = useMemo(() => {
    const filter = ASSET_KINDS.find((item) => item.id === kind) ?? ASSET_KINDS[0]
    const needle = query.trim().toLowerCase()
    const kept = assets.filter((asset) => (filter?.match(asset) ?? true)
      && (needle === '' || asset.mime.toLowerCase().includes(needle)))
    // A copy before sorting: `sort` mutates, and the caller's array is React state.
    const sorted = [...kept]
    if (sort === 'newest') sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (sort === 'oldest') sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (sort === 'largest') sorted.sort((a, b) => b.bytes - a.bytes)
    return sorted
  }, [assets, kind, query, sort])

  const counts = useMemo(() => {
    const table: Record<string, number> = {}
    for (const item of ASSET_KINDS) table[item.id] = assets.filter((asset) => item.match(asset)).length
    return table
  }, [assets])

  const allPicked = visible.length > 0 && visible.every((asset) => picked.includes(asset.id))
  const toggle = (id: string): void => {
    setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }
  const batched = picked.length > 0

  return (
    <div className="asset-browser">
      <header className="asset-browser-head">
        <strong>{title}</strong>
        <span className="muted">{note ?? `${String(assets.length)} 个素材 · 相同文件只存一份`}</span>
        {actions}
      </header>

      <div className="side-tools asset-tools">
        {ASSET_KINDS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`chip${item.id === kind ? ' active' : ''}`}
            title={`${item.label}（${String(counts[item.id] ?? 0)}）`}
            onClick={() => { setKind(item.id); setShown(PAGE) }}
          >
            {item.label}
            <span className="chip-count">{counts[item.id] ?? 0}</span>
          </button>
        ))}
        <input
          className="side-search"
          value={query}
          placeholder="搜索资产"
          onChange={(event) => { setQuery(event.target.value); setShown(PAGE) }}
        />
        <select
          className="asset-sort"
          aria-label="排序"
          value={sort}
          onChange={(event) => { setSort(event.target.value as AssetSort) }}
        >
          {(Object.keys(ASSET_SORT_LABEL) as AssetSort[]).map((key) => (
            <option key={key} value={key}>{ASSET_SORT_LABEL[key]}</option>
          ))}
        </select>
        <button
          type="button"
          className="asset-select-all"
          title="全选当前筛选出的素材（不只是这一页）"
          onClick={() => { setPicked(allPicked ? [] : visible.map((asset) => asset.id)) }}
        >
          {allPicked ? '取消全选' : '全选'}
        </button>
      </div>

      {notice === undefined || notice === '' ? null : <p className="asset-notice">{notice}</p>}

      <div className="asset-wall">
        {assets.length === 0
          ? (
            <div className="asset-empty">
              <span className="glyph" aria-hidden="true">▢</span>
              <strong>没有资产</strong>
              <p className="muted">生成的画面和上传的素材都会出现在这里。</p>
            </div>
          )
          : visible.length === 0
            ? <p className="side-empty">没有符合当前筛选的素材。</p>
            : (
              <>
                {visible.slice(0, shown).map((asset) => {
                  const isPicked = picked.includes(asset.id)
                  return (
                    <div
                      key={asset.id}
                      className={`asset-card${isPicked ? ' is-picked' : ''}`}
                      data-kind={asset.kind}
                    >
                      {/* 点图 = 放大看；**只有**点方框才是选择。
                          以前点图会直接把它放到画布上，于是「看一眼」和「要这张」分不开。 */}
                      <button
                        type="button"
                        className="asset-open"
                        title={`${asset.mime} · ${String(Math.round(asset.bytes / 1024))} KB · 点开看大图`}
                        onClick={() => { setPreview(asset.id) }}
                      >
                        {asset.mime.startsWith('image/')
                          ? <SmallImage assetId={asset.id} size={320} />
                          : <span className="file">{asset.kind}</span>}
                      </button>
                      <button
                        type="button"
                        className="pick"
                        role="checkbox"
                        aria-checked={isPicked}
                        aria-label={isPicked ? '取消选择' : '选择'}
                        onClick={() => { toggle(asset.id) }}
                      >
                        {isPicked ? '✓' : ''}
                      </button>
                      <span className="asset-meta">{String(Math.round(asset.bytes / 1024))} KB</span>
                    </div>
                  )
                })}
                {visible.length > shown ? (
                  <div className="asset-wall-more">
                    <button type="button" onClick={() => { setShown((current) => current + PAGE) }}>
                      加载更多（还有 {visible.length - shown} 个）
                    </button>
                  </div>
                ) : null}
              </>
            )}
      </div>

      {/* 批量操作条贴在容器底部。
          放在顶部会随滚动跑掉，而「选中之后要做什么」恰恰是看了一圈、滚到下面时才决定的。 */}
      {batched ? (
        <div className="asset-batch" data-testid="asset-batch">
          <span className="count">已选 {picked.length} 个</span>
          {onPlaceMany === undefined ? null : (
            <button type="button" onClick={() => { onPlaceMany(picked); setPicked([]) }}>添加到画布</button>
          )}
          {onDownload === undefined ? null : (
            <button type="button" onClick={() => { onDownload(picked) }}>下载</button>
          )}
          {onDelete === undefined ? null : (
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!window.confirm(`删除选中的 ${String(picked.length)} 个素材？被画布用着的会被跳过。`)) return
                onDelete(picked)
              }}
            >删除</button>
          )}
          <button type="button" className="link" onClick={() => { setPicked([]) }}>取消选择</button>
        </div>
      ) : null}

      {preview === null ? null : (
        <AssetPreview
          assets={visible}
          currentId={preview}
          onStep={setPreview}
          onClose={() => { setPreview(null) }}
          onDownload={(id) => { onDownload?.([id]) }}
        />
      )}
    </div>
  )
}

/** Props for {@link AssetPreview}. */
interface AssetPreviewProps {
  /** The set being stepped through (the filtered list, in order). */
  assets: BrowserAsset[]
  /** Which one is showing. */
  currentId: string
  /** Move to another one. */
  onStep: (id: string) => void
  /** Close the viewer. */
  onClose: () => void
  /** Download just this one. */
  onDownload: (id: string) => void
}

/**
 * Full-size viewer.
 *
 * Arrow keys and Esc, because a viewer you cannot step through with the keyboard
 * is a viewer you close and reopen for every image.
 * @param props - see {@link AssetPreviewProps}.
 * @returns the overlay.
 */
function AssetPreview({ assets, currentId, onStep, onClose, onDownload }: AssetPreviewProps) {
  const index = assets.findIndex((asset) => asset.id === currentId)
  const asset = assets[index]

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowRight' && index >= 0 && index < assets.length - 1) onStep((assets[index + 1] as BrowserAsset).id)
      if (event.key === 'ArrowLeft' && index > 0) onStep((assets[index - 1] as BrowserAsset).id)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [assets, index, onClose, onStep])

  if (asset === undefined) return null

  return (
    <div className="asset-preview" role="dialog" aria-label="预览" data-testid="asset-preview">
      <div className="preview-scrim" onClick={onClose} />
      <div className="preview-body">
        <header>
          <span className="muted">{index + 1} / {assets.length}</span>
          <span className="muted">{asset.mime} · {String(Math.round(asset.bytes / 1024))} KB</span>
          <button type="button" className="link" onClick={() => { onDownload(asset.id) }}>下载</button>
          <button type="button" className="link preview-close" title="关闭（Esc）" onClick={onClose}>✕</button>
        </header>
        <div className="preview-stage">
          <button
            type="button"
            className="preview-step prev"
            title="上一张（←）"
            disabled={index <= 0}
            onClick={() => { const previous = assets[index - 1]; if (previous !== undefined) onStep(previous.id) }}
          >‹</button>
          {asset.mime.startsWith('video/')
            ? <video src={asset.url} controls autoPlay />
            : asset.mime.startsWith('audio/')
              ? <audio src={asset.url} controls autoPlay />
              : <img src={asset.url} alt="" />}
          <button
            type="button"
            className="preview-step next"
            title="下一张（→）"
            disabled={index >= assets.length - 1}
            onClick={() => { const next = assets[index + 1]; if (next !== undefined) onStep(next.id) }}
          >›</button>
        </div>
      </div>
    </div>
  )
}
