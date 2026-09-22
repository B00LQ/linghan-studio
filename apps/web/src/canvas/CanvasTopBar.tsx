/**
 * The canvas page's top-left control.
 *
 * ```
 * ◆ ▾   画布名
 * ```
 *
 * Floats over the canvas instead of occupying a column: the canvas is the page,
 * and a permanent sidebar next to it was spending a fifth of the screen on
 * something you look at twice a session.
 *
 * The name is **edited in place**. Clicking it turns the label into a field;
 * Enter or clicking anywhere else saves. There is no dropdown here any more —
 * switching canvases is what 全部项目 is for, and a picker that opens on the same
 * click as "rename" would make both actions unreliable.
 */
import { useEffect, useRef, useState } from 'react'
import { Menu, MenuItem } from '../components/Menu.tsx'

/** Props for {@link CanvasTopBar}. */
export interface CanvasTopBarProps {
  /** Name of the canvas being edited. */
  canvasName: string
  /** Leave for the home page. */
  onHome: () => void
  /** Open the project list. */
  onAllProjects: () => void
  /** Create a canvas and open it in a new window. */
  onCreateProject: () => void
  /** Move this canvas to the trash. */
  onDeleteProject: () => void
  /** Save a new name. */
  onRenameCanvas: (name: string) => void
}

/**
 * Render the floating top-left control.
 * @param props - see {@link CanvasTopBarProps}.
 * @returns the control.
 */
export function CanvasTopBar(props: CanvasTopBarProps) {
  const { canvasName, onHome, onAllProjects, onCreateProject, onDeleteProject, onRenameCanvas } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(canvasName)
  const input = useRef<HTMLInputElement | null>(null)

  // The name can change underneath us (an Agent rename, a reload); never leave a
  // stale draft in the field.
  useEffect(() => {
    if (!editing) setDraft(canvasName)
  }, [canvasName, editing])

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const save = (): void => {
    if (!editing) return
    setEditing(false)
    const name = draft.trim()
    // An empty name would leave a nameless card in the project list, so it is
    // treated as "never mind" rather than as a rename to nothing.
    if (name === '' || name === canvasName) { setDraft(canvasName); return }
    onRenameCanvas(name)
  }

  return (
    <div className="canvas-topbar">
      <Menu className="brand-menu" title="菜单：回到主页 / 全部项目 / 创建项目 / 删除项目" label={
        <>
          <span className="mark" aria-hidden="true" />
          <span className="caret">▾</span>
        </>
      }>
        {(close) => (
          <>
            <MenuItem onClick={() => { close(); onHome() }}>回到主页</MenuItem>
            <MenuItem onClick={() => { close(); onAllProjects() }}>全部项目</MenuItem>
            <MenuItem onClick={() => { close(); onCreateProject() }}>创建项目</MenuItem>
            <div className="menu-sep" />
            <MenuItem danger onClick={() => { close(); onDeleteProject() }}>删除项目</MenuItem>
          </>
        )}
      </Menu>

      <span className="topbar-divider" aria-hidden="true" />

      {editing ? (
        <input
          ref={input}
          className="canvas-name-input nodrag"
          aria-label="画布名称"
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save()
            if (event.key === 'Escape') { setEditing(false); setDraft(canvasName) }
          }}
        />
      ) : (
        <button
          type="button"
          className="canvas-name-button"
          title="点一下改名字（回车或点别处保存）"
          onClick={() => { setEditing(true) }}
        >
          {canvasName}
        </button>
      )}
    </div>
  )
}
