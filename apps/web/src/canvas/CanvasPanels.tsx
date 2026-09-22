/**
 * The canvas's two floating panels: 画布 (node locator) and 资产 (media library).
 *
 * Both used to be a permanent left column. They are floating windows now because
 * neither is something you watch — you open one, find the thing, and go back to
 * the canvas filling the screen. The 画布 button is a **locator**: it lists every
 * node so you can jump to the one that is off-screen, which is the only reason to
 * want a list of the canvas you are already looking at.
 *
 * Selecting a row selects the node on the canvas and brings it into view — the
 * list and the canvas are two views of one selection, not two states.
 */
import { useEffect, useMemo, useState } from 'react'
import { AssetBrowser, type BrowserAsset } from '../components/AssetBrowser.tsx'
import { Menu, MenuItem } from '../components/Menu.tsx'
import { nodeLabel, specOf, type NamedLike } from './ports.ts'

/** A node as the locator needs to see it. */
export interface PanelNode extends NamedLike {
  data: { kind?: unknown; name?: unknown; url?: unknown; text?: unknown; chosen?: unknown }
}

/** Props shared by both panels. */
export interface PanelChromeProps {
  /** Close the panel. */
  onClose: () => void
}

/** Props for the node locator. */
export interface NodePanelProps extends PanelChromeProps {
  /** Nodes on this canvas, in document order. */
  nodes: PanelNode[]
  /** Currently selected node id, shared with the canvas. */
  selectedId: string | null
  /** Node ids the operator handed to the Agent as context. */
  agentIds: string[]
  /** Select a node (the canvas shows its window and scrolls it into view). */
  onSelect: (nodeId: string) => void
  /** Rename a node. */
  onRename: (nodeId: string, name: string) => void
  /** Duplicate a node next to the original. */
  onDuplicate: (nodeId: string) => void
  /** Delete a node and the edges touching it. */
  onDelete: (nodeId: string) => void
  /** Toggle whether a node is part of the Agent's context. */
  onToggleAgent: (nodeId: string) => void
}

/** Props for the asset library. */
export interface AssetPanelProps extends PanelChromeProps {
  /** Media library contents. */
  assets: BrowserAsset[]
  /** Drop several at once (the single-asset path is「勾选 → 添加到画布」). */
  onPlaceMany: (ids: string[]) => void
  /** Download the picked ones as one archive. */
  onDownload: (ids: string[]) => void
  /** Delete the picked ones (the server refuses any a canvas still shows). */
  onDelete: (ids: string[]) => void
  /** Feedback line shown above the grid. */
  notice?: string
}

/** How the node list is laid out. */
type ViewMode = 'list' | 'grid'

/** Rating filter — ours is 「这张画面被选用了没有」, which is what 评级 means here. */
type Rating = 'all' | 'chosen' | 'loose'

const RATING_LABEL: Record<Rating, string> = { all: '所有评级', chosen: '已选用', loose: '未选用' }

/**
 * Render the node locator.
 * @param props - see {@link NodePanelProps}.
 * @returns the floating panel.
 */
export function NodePanel(props: NodePanelProps) {
  const { nodes, selectedId, agentIds, onSelect, onRename, onDuplicate, onDelete, onToggleAgent, onClose } = props
  const [view, setView] = useState<ViewMode>('list')
  const [rating, setRating] = useState<Rating>('all')
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  // A node deleted while its name was being edited must not leave a dangling editor.
  useEffect(() => {
    if (renaming !== null && !nodes.some((node) => node.id === renaming)) {
      setRenaming(null)
      setDraft('')
    }
  }, [nodes, renaming])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return nodes.filter((node) => {
      if (needle !== '' && !nodeLabel(nodes, node.id).toLowerCase().includes(needle)) return false
      if (rating === 'chosen') return node.data.chosen === true
      if (rating === 'loose') return node.data.chosen !== true
      return true
    })
  }, [nodes, query, rating])

  const beginRename = (nodeId: string): void => {
    setRenaming(nodeId)
    setDraft(nodeLabel(nodes, nodeId))
  }

  const commitRename = (): void => {
    if (renaming === null) return
    const name = draft.trim()
    onRename(renaming, name)
    setRenaming(null)
    setDraft('')
  }

  return (
    <section className="float-panel nodes-panel" aria-label="画布节点">
      <header className="float-head">
        <strong>画布</strong>
        <span className="muted">{nodes.length} 个节点</span>
        <button type="button" className="link float-close" title="关闭" onClick={onClose}>✕</button>
      </header>

      <div className="side-tools">
        <input
          className="side-search"
          value={query}
          placeholder="搜索节点"
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <Menu className="rating-picker" title="按评级筛选" label={<>{RATING_LABEL[rating]}<span className="caret">▾</span></>}>
          {(close) => (
            <>
              {(Object.keys(RATING_LABEL) as Rating[]).map((key) => (
                <MenuItem key={key} active={key === rating} onClick={() => { close(); setRating(key) }}>
                  {RATING_LABEL[key]}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <button
          type="button"
          className="icon view-toggle"
          title={view === 'list' ? '切换为网格视图' : '切换为列表视图'}
          aria-label="切换视图"
          onClick={() => { setView(view === 'list' ? 'grid' : 'list') }}
        >
          <span className="glyph">{view === 'list' ? '☰' : '▦'}</span>
        </button>
      </div>

      <div className={`side-list ${view}`}>
        {nodes.length === 0
          ? <p className="side-empty">这个画布还没有节点。双击画布添加。</p>
          : visible.length === 0
            ? <p className="side-empty">没有符合当前筛选的节点。</p>
            : visible.map((node) => {
              const kind = String(node.data.kind ?? '')
              const spec = specOf(kind)
              const name = nodeLabel(nodes, node.id)
              const inAgent = agentIds.includes(node.id)
              const thumb = typeof node.data.url === 'string' && node.data.url !== '' ? node.data.url : ''
              return (
                <div key={node.id} className={`side-row${node.id === selectedId ? ' is-selected' : ''}`} data-kind={kind}>
                  {renaming === node.id ? (
                    <input
                      className="side-rename"
                      autoFocus
                      value={draft}
                      onChange={(event) => { setDraft(event.target.value) }}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename()
                        if (event.key === 'Escape') { setRenaming(null); setDraft('') }
                      }}
                    />
                  ) : (
                    <button type="button" className="side-open" onClick={() => { onSelect(node.id) }}>
                      {thumb === ''
                        ? <span className={`side-thumb kind-${kind}`} title={spec?.title ?? kind}><span className="glyph">{kind === 'image' ? '▢' : '≡'}</span></span>
                        : <span className="side-thumb"><img src={thumb} alt="" /></span>}
                      <span className="side-name">{name}</span>
                      {inAgent ? <span className="side-agent" title="已加入 Agent 上下文">Agent</span> : null}
                    </button>
                  )}
                  <Menu className="row-menu" align="right" title="节点操作" label="⋯">
                    {(close) => (
                      <>
                        <MenuItem onClick={() => { close(); beginRename(node.id) }}>重命名</MenuItem>
                        <MenuItem onClick={() => { close(); onDuplicate(node.id) }}>复制</MenuItem>
                        <MenuItem onClick={() => { close(); onToggleAgent(node.id) }}>
                          {inAgent ? '从 Agent 移除' : '添加到 Agent'}
                        </MenuItem>
                        <div className="menu-sep" />
                        <MenuItem danger onClick={() => { close(); onDelete(node.id) }}>删除</MenuItem>
                      </>
                    )}
                  </Menu>
                </div>
              )
            })}
      </div>
    </section>
  )
}

/**
 * Render the asset library.
 * @param props - see {@link AssetPanelProps}.
 * @returns the floating panel.
 */
export function AssetPanel(props: AssetPanelProps) {
  const { assets, onPlaceMany, onDownload, onDelete, notice, onClose } = props
  return (
    <section className="float-panel assets-panel" aria-label="我的资产">
      {/* 和「资产」页面用的是同一个浏览器组件：分类、排序、分页、预览、批量操作不会两边跑偏。 */}
      <AssetBrowser
        assets={assets}
        title="我的资产"
        note={`${String(assets.length)} 个素材 · 点图看大图，勾选后可批量操作`}
        notice={notice}
        actions={<button type="button" className="link float-close" title="关闭" onClick={onClose}>✕</button>}
        onPlaceMany={onPlaceMany}
        onDownload={onDownload}
        onDelete={onDelete}
      />
    </section>
  )
}
