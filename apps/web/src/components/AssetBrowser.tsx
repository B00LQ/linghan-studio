/**
 * The asset browser: one component, two homes.
 *
 * It is the same library in both places — the canvas's floating 资产 window and
 * the shell's 资产 page — so the filter, the sort and the batch actions must not
 * drift between them. The only differences are the shell around it and what
 * clicking a card does (place it on the canvas vs. nothing).
 *
 * Four things here are load-bearing rather than cosmetic:
 *
 * - **Paging.** A library of 500 full-size PNGs is ~700 MB. Rendering all of them
 *   at once is what made this page freeze.
 * - **Batch actions.** Selecting ten assets and then doing something one at a
 *   time is not a workflow. 全选 works over the *filtered* set, not just the page
 *   that happens to be rendered — otherwise "select all" quietly means "select 60".
 * - **素材文件夹 are labels, not containers.** Deleting one keeps every asset in it
 *   (they go back to 未分组), which is why the confirmation says so in words.
 * - **两个页签共用一份筛选与选择**：素材 (卡片墙) 与 管理 (一张表)。切页签不该
 *   把「我已经选好的 12 个」清掉 —— 那正是「先挑出来、再换个视图核对」的用法。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  createAssetFolder, deleteAssetFolder, moveAssets, renameAssetFolder,
  type AssetFolderInfo, type AssetInfo,
} from '../api.ts'
import { SmallImage } from './SmallImage.tsx'
import { Menu, MenuItem } from './Menu.tsx'

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

/** 未分组 in the folder filter/selects; not a folder id (ids are uuids). */
const UNFILED = '__unfiled'

/** Bytes as something a person reads (素材列表上全是 MB 量级）。 */
const sizeText = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${String(Math.round(bytes / 1024))} KB`

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
  /** 素材文件夹。宿主负责加载（它已经有刷新素材的时机，多拉一个列表不添乱）。 */
  folders?: AssetFolderInfo[] | undefined
  /** 文件夹或归类变过之后叫宿主重新拉一遍（素材与文件夹一起）。 */
  onChanged?: (() => void) | undefined
  /** 一句要说给用户听的话（建同名文件夹被拒之类）。 */
  onNotice?: ((message: string) => void) | undefined
  /** Batch: put these on a canvas. Omitted when there is nowhere to put them. */
  onPlaceMany?: (ids: string[]) => void
  /** Batch: download as one archive. */
  onDownload?: (ids: string[]) => void
  /** Batch: 发布到主页（上传给云端、等审核，本地原件不动）。 */
  onPublish?: ((ids: string[]) => void) | undefined
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
  const { assets, title, note, actions, folders = [], onChanged, onNotice, onPlaceMany, onDownload, onPublish, onDelete, notice } = props
  const [tab, setTab] = useState<'library' | 'manage'>('library')
  const [kind, setKind] = useState('all')
  /** `all`, 未分组, or a folder id. */
  const [folder, setFolder] = useState<string>('all')
  const [sort, setSort] = useState<AssetSort>('newest')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [shown, setShown] = useState(PAGE)
  /** The asset being previewed full-size, if any. */
  const [preview, setPreview] = useState<string | null>(null)
  /** 正在起名/改名的那一个（内联输入框，不用浏览器弹窗：那东西挡不住、也测不了）。 */
  const [naming, setNaming] = useState<{ mode: 'new' } | { mode: 'rename'; id: string } | null>(null)
  const [draft, setDraft] = useState('')

  const folderOf = (asset: BrowserAsset): string => asset.folderId ?? ''

  const visible = useMemo(() => {
    const filter = ASSET_KINDS.find((item) => item.id === kind) ?? ASSET_KINDS[0]
    const needle = query.trim().toLowerCase()
    const kept = assets.filter((asset) => (filter?.match(asset) ?? true)
      && (needle === '' || asset.mime.toLowerCase().includes(needle))
      && (folder === 'all' || (folder === UNFILED ? folderOf(asset) === '' : folderOf(asset) === folder)))
    // A copy before sorting: `sort` mutates, and the caller's array is React state.
    const sorted = [...kept]
    if (sort === 'newest') sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (sort === 'oldest') sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (sort === 'largest') sorted.sort((a, b) => b.bytes - a.bytes)
    return sorted
  }, [assets, kind, query, sort, folder])

  const counts = useMemo(() => {
    const table: Record<string, number> = {}
    for (const item of ASSET_KINDS) table[item.id] = assets.filter((asset) => item.match(asset)).length
    return table
  }, [assets])

  const unfiledCount = useMemo(() => assets.filter((asset) => folderOf(asset) === '').length, [assets])
  const totalBytes = useMemo(() => visible.reduce((sum, asset) => sum + asset.bytes, 0), [visible])

  // 选中的文件夹被删掉之后，筛选值要跟着退回去，否则看到的是一片空墙而没人知道为什么。
  useEffect(() => {
    if (folder === 'all' || folder === UNFILED) return
    if (!folders.some((item) => item.id === folder)) setFolder('all')
  }, [folders, folder])

  const allPicked = visible.length > 0 && visible.every((asset) => picked.includes(asset.id))
  const toggle = (id: string): void => {
    setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }
  const batched = picked.length > 0

  /** 跑一个归类动作，成功就刷新，失败就把服务端那句话原样说出来。 */
  const act = (work: Promise<unknown>, fallback: string): void => {
    void work
      .then(() => { onChanged?.() })
      .catch((problem: unknown) => { onNotice?.(problem instanceof Error ? problem.message : fallback) })
  }

  const submitName = (): void => {
    const name = draft.trim()
    if (naming === null || name === '') { setNaming(null); setDraft(''); return }
    if (naming.mode === 'new') act(createAssetFolder(name), '建文件夹失败')
    else act(renameAssetFolder(naming.id, name), '改名失败')
    setNaming(null)
    setDraft('')
  }

  return (
    <div className="asset-browser">
      <header className="asset-browser-head">
        <strong>{title}</strong>
        <span className="muted">{note ?? `${String(assets.length)} 个素材 · 相同文件只存一份`}</span>
        {actions}
      </header>

      {/* 两个页签：素材是卡片墙（挑图），管理是一张表（核对体积、批量归类）。
          同一个库、同一份筛选与选择 —— 切页签不清空已选。 */}
      <div className="asset-tabs" role="tablist" data-testid="asset-tabs">
        <button
          type="button" role="tab" aria-selected={tab === 'library'}
          className={tab === 'library' ? 'active' : ''}
          onClick={() => { setTab('library') }}
        >素材</button>
        <button
          type="button" role="tab" aria-selected={tab === 'manage'}
          className={tab === 'manage' ? 'active' : ''}
          onClick={() => { setTab('manage') }}
        >管理</button>
        <span className="muted asset-tabs-note">
          {tab === 'manage'
            ? `${String(visible.length)} 个 · 合计 ${sizeText(totalBytes)}`
            : '点图看大图，勾选后可批量操作'}
        </span>
      </div>

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

      {/* 素材文件夹。
          它是**标签**：删掉文件夹里面的素材一个都不少（退回未分组），确认框里也这么写。 */}
      <div className="asset-folders" data-testid="asset-folders">
        <span className="folder-title">素材文件夹</span>
        <button
          type="button"
          className={`folder-chip${folder === 'all' ? ' active' : ''}`}
          title="全部素材"
          onClick={() => { setFolder('all'); setShown(PAGE) }}
        >全部<span className="chip-count">{assets.length}</span></button>
        <button
          type="button"
          className={`folder-chip${folder === UNFILED ? ' active' : ''}`}
          title="没有放进任何文件夹的素材"
          onClick={() => { setFolder(UNFILED); setShown(PAGE) }}
        >未分组<span className="chip-count">{unfiledCount}</span></button>
        {folders.map((item) => (naming?.mode === 'rename' && naming.id === item.id ? (
          <form
            key={item.id}
            className="folder-form"
            onSubmit={(event) => { event.preventDefault(); submitName() }}
          >
            <input
              autoFocus value={draft} aria-label="文件夹名" placeholder="文件夹名"
              onChange={(event) => { setDraft(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Escape') { setNaming(null); setDraft('') } }}
            />
            <button type="submit">确定</button>
            <button type="button" className="link" onClick={() => { setNaming(null); setDraft('') }}>取消</button>
          </form>
        ) : (
          <div key={item.id} className={`folder-chip-wrap${folder === item.id ? ' active' : ''}`}>
            <button
              type="button"
              className={`folder-chip${folder === item.id ? ' active' : ''}`}
              title={`${item.name}（${String(item.assetCount)}）`}
              onClick={() => { setFolder(item.id); setShown(PAGE) }}
            >
              <span className="folder-glyph" aria-hidden="true">▸</span>{item.name}
              <span className="chip-count">{item.assetCount}</span>
            </button>
            <Menu className="row-menu" align="right" title="文件夹操作" label="⋯">
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); setNaming({ mode: 'rename', id: item.id }); setDraft(item.name) }}>重命名</MenuItem>
                  <div className="menu-sep" />
                  <MenuItem
                    danger
                    onClick={() => {
                      close()
                      if (!window.confirm(`删除文件夹「${item.name}」？里面的 ${String(item.assetCount)} 个素材不会被删，会退回「未分组」。`)) return
                      act(deleteAssetFolder(item.id), '删除文件夹失败')
                    }}
                  >删除文件夹</MenuItem>
                </>
              )}
            </Menu>
          </div>
        )))}
        {naming?.mode === 'new' ? (
          <form className="folder-form" onSubmit={(event) => { event.preventDefault(); submitName() }}>
            <input
              autoFocus value={draft} aria-label="文件夹名" placeholder="文件夹名"
              onChange={(event) => { setDraft(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Escape') { setNaming(null); setDraft('') } }}
            />
            <button type="submit">确定</button>
            <button type="button" className="link" onClick={() => { setNaming(null); setDraft('') }}>取消</button>
          </form>
        ) : (
          <button
            type="button"
            className="folder-new"
            data-testid="folder-new"
            onClick={() => { setNaming({ mode: 'new' }); setDraft('') }}
          >＋ 新建文件夹</button>
        )}
      </div>

      {notice === undefined || notice === '' ? null : <p className="asset-notice">{notice}</p>}

      {tab === 'library' ? (
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
      ) : (
        /* 管理：一张表。卡片墙适合挑图，不适合核对「哪个占地方」「哪些还没归类」。 */
        <div className="asset-manage" data-testid="asset-manage">
          {visible.length === 0
            ? <p className="side-empty">没有符合当前筛选的素材。</p>
            : (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>素材</th><th>类型</th><th>体积</th><th>创建时间</th><th>文件夹</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.slice(0, shown).map((asset) => (
                      <tr key={asset.id} className={picked.includes(asset.id) ? 'is-picked' : ''}>
                        <td className="who">
                          <button
                            type="button" className="pick" role="checkbox"
                            aria-checked={picked.includes(asset.id)}
                            aria-label={picked.includes(asset.id) ? '取消选择' : '选择'}
                            onClick={() => { toggle(asset.id) }}
                          >{picked.includes(asset.id) ? '✓' : ''}</button>
                          {asset.mime.startsWith('image/')
                            ? <SmallImage assetId={asset.id} size={64} onClick={() => { setPreview(asset.id) }} title="点开看大图" />
                            : <span className="file">{asset.kind}</span>}
                          <code title={asset.id}>{asset.id.slice(0, 8)}</code>
                        </td>
                        <td>{asset.kind}</td>
                        <td>{sizeText(asset.bytes)}</td>
                        <td>{asset.createdAt.slice(0, 16).replace('T', ' ')}</td>
                        <td>
                          <select
                            className="asset-row-folder"
                            aria-label="所在文件夹"
                            value={folderOf(asset)}
                            onChange={(event) => { act(moveAssets([asset.id], event.target.value), '归类失败') }}
                          >
                            <option value="">未分组</option>
                            {folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                          </select>
                        </td>
                        <td>
                          {onDelete === undefined ? null : (
                            <button
                              type="button" className="link danger"
                              onClick={() => {
                                if (!window.confirm('删除这个素材？被画布用着的会被跳过。')) return
                                onDelete([asset.id])
                              }}
                            >删除</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
      )}

      {/* 批量操作条贴在容器底部。
          放在顶部会随滚动跑掉，而「选中之后要做什么」恰恰是看了一圈、滚到下面时才决定的。 */}
      {batched ? (
        <div className="asset-batch" data-testid="asset-batch">
          <span className="count">已选 {picked.length} 个</span>
          {onPlaceMany === undefined ? null : (
            <button type="button" onClick={() => { onPlaceMany(picked); setPicked([]) }}>添加到画布</button>
          )}
          {onPublish === undefined ? null : (
            <button type="button" data-testid="asset-publish" onClick={() => { onPublish(picked) }}>发布到主页</button>
          )}
          {onDownload === undefined ? null : (
            <button type="button" onClick={() => { onDownload(picked) }}>下载</button>
          )}
          <select
            className="asset-move"
            aria-label="移入文件夹"
            value=""
            onChange={(event) => {
              const target = event.target.value
              if (target === '') return
              act(moveAssets(picked, target === UNFILED ? '' : target), '归类失败')
              setPicked([])
            }}
          >
            <option value="">移入文件夹…</option>
            <option value={UNFILED}>未分组</option>
            {folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
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
