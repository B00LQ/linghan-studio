/**
 * The toolbar that sits above a picture node.
 *
 * Kept out of the prompt window on purpose. The prompt window is about *making*
 * a picture — what to draw, how big, how many; the toolbar is about what to do
 * with the picture that already exists. Mixing the two made the window a list of
 * unrelated things, and editing controls that only appear for one kind of card
 * belong next to the card itself, where the picture is.
 *
 * Menus open on hover *and* on click. Hover is what a mouse expects of a menu
 * bar; click is what a trackpad, a keyboard user, and a test can rely on. The
 * submenus are nested inside the item that owns them — when they were siblings a
 * diagonal mouse move crossed the gap and closed the menu before you reached it.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { EditOps } from './imageEdit.ts'

/** Props for {@link NodeTools}. */
export interface NodeToolsProps {
  /** How many versions this node has, for the compare entry. */
  takeCount: number
  /** Apply a transform now, saving the result as a new version. */
  onQuickEdit: (ops: EditOps, label: string) => void
  /** Open the editor in crop mode. */
  onCrop: () => void
  /** Open the side-by-side version comparison. */
  onCompare: () => void
}

/** One submenu's contents. */
interface MenuAction {
  label: string
  run: () => void
}

/**
 * The node toolbar.
 * @param props - see {@link NodeToolsProps}.
 * @returns the toolbar.
 */
export function NodeTools({ takeCount, onQuickEdit, onCrop, onCompare }: NodeToolsProps) {
  const [open, setOpen] = useState<'edit' | null>(null)
  const [sub, setSub] = useState<'rotate' | 'mirror' | null>(null)
  /** Whether the bar had to go below the card to stay on screen. */
  const [below, setBelow] = useState(false)
  const barRef = useRef<HTMLDivElement | null>(null)

  // A bar above the card is invisible when the card is at the top of the
  // viewport, and 「点了节点但没出现菜单」 reads as a broken button. Measure the
  // card and flip under it if there is no room.
  //
  // **平移/缩放之后要重新量。** 从前只在挂载时量一次，于是「打开着工具条把卡片拖到
  // 顶部」会把它裁掉，只能关掉再点一下。xyflow 把 pan/zoom 写成
  // `.react-flow__viewport` 的 transform，所以盯它的 style 就够了 —— 不用为了这一条
  // 把视口状态穿过整个 context。观察者是按帧合并的，且值没变时 React 不会重渲染。
  useLayoutEffect(() => {
    const host = barRef.current?.closest('.studio-node')
    if (host === null || host === undefined) return
    // 52px covers the bar's own height plus the gap.
    const measure = (): void => { setBelow(host.getBoundingClientRect().top < 52) }
    measure()
    const viewport = host.closest('.react-flow__viewport')
    if (viewport === null) return
    const observer = new MutationObserver(measure)
    observer.observe(viewport, { attributes: true, attributeFilter: ['style'] })
    return () => { observer.disconnect() }
  }, [])

  const rotate: MenuAction[] = [
    { label: '左转 90°', run: () => { onQuickEdit({ rotate: -90 }, '左转 90°') } },
    { label: '右转 90°', run: () => { onQuickEdit({ rotate: 90 }, '右转 90°') } },
    { label: '旋转 180°', run: () => { onQuickEdit({ rotate: 180 }, '旋转 180°') } },
  ]
  const mirror: MenuAction[] = [
    { label: '水平翻转', run: () => { onQuickEdit({ flipX: true }, '水平翻转') } },
    { label: '垂直翻转', run: () => { onQuickEdit({ flipY: true }, '垂直翻转') } },
  ]

  const close = (): void => { setOpen(null); setSub(null) }

  return (
    <div
      className={`node-tools nodrag${below ? ' is-below' : ''}`}
      ref={barRef}
      data-testid="node-tools"
      onDoubleClick={(event) => { event.stopPropagation() }}
    >
      <div
        className="tool"
        onMouseEnter={() => { setOpen('edit') }}
        onMouseLeave={() => { close() }}
      >
        <button
          type="button"
          className={`tool-btn${open === 'edit' ? ' is-open' : ''}`}
          data-testid="tools-image-edit"
          title="对这张画面本身做处理"
          onClick={() => { setOpen(open === 'edit' ? null : 'edit'); setSub(null) }}
        >图像编辑 <span className="caret">▾</span></button>

        {open !== 'edit' ? null : (
          <div className="tool-menu" data-testid="tools-menu">
            <div
              className="tool-row has-sub"
              onMouseEnter={() => { setSub('rotate') }}
              onMouseLeave={() => { setSub(null) }}
            >
              <button
                type="button"
                className={`tool-btn${sub === 'rotate' ? ' is-open' : ''}`}
                data-testid="tools-rotate"
                onClick={() => { setSub(sub === 'rotate' ? null : 'rotate') }}
              >旋转 <span className="caret">›</span></button>
              {sub !== 'rotate' ? null : (
                <div className="tool-sub" data-testid="tools-rotate-sub">
                  {rotate.map((item) => (
                    <button
                      type="button"
                      key={item.label}
                      className="tool-btn"
                      onClick={() => { close(); item.run() }}
                    >{item.label}</button>
                  ))}
                </div>
              )}
            </div>

            <div
              className="tool-row has-sub"
              onMouseEnter={() => { setSub('mirror') }}
              onMouseLeave={() => { setSub(null) }}
            >
              <button
                type="button"
                className={`tool-btn${sub === 'mirror' ? ' is-open' : ''}`}
                data-testid="tools-mirror"
                onClick={() => { setSub(sub === 'mirror' ? null : 'mirror') }}
              >镜像 <span className="caret">›</span></button>
              {sub !== 'mirror' ? null : (
                <div className="tool-sub" data-testid="tools-mirror-sub">
                  {mirror.map((item) => (
                    <button
                      type="button"
                      key={item.label}
                      className="tool-btn"
                      onClick={() => { close(); item.run() }}
                    >{item.label}</button>
                  ))}
                </div>
              )}
            </div>

            <div className="tool-row">
              <button
                type="button"
                className="tool-btn"
                data-testid="tools-crop"
                title="拖出要保留的区域"
                onClick={() => { close(); onCrop() }}
              >裁剪…</button>
            </div>
          </div>
        )}
      </div>

      {takeCount > 1 ? (
        <button
          type="button"
          className="tool-btn"
          data-testid="compare-open"
          title="把这张的所有版本并排看"
          onClick={() => { close(); onCompare() }}
        >对比 {takeCount} 个版本</button>
      ) : null}
    </div>
  )
}
