/**
 * A small popup menu.
 *
 * The canvas header, the workspace picker and every list-row action menu use the
 * same shape: a trigger button, a panel below it, and three ways out (choose an
 * item, click elsewhere, press Escape). One implementation keeps those three
 * exits consistent instead of re-inventing them per call site.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Props for {@link Menu}. */
export interface MenuProps {
  /** Trigger content — usually the current value plus a caret. */
  label: ReactNode
  /**
   * Identity class for this menu.
   *
   * It lands on the wrapper, not the trigger, so both parts can be addressed as
   * a unit: `.canvas-picker .menu-trigger` and `.canvas-picker .menu-panel` are
   * siblings, and styling or testing one without the other is how menus get
   * half-styled or half-tested.
   */
  className?: string
  /** Panel alignment relative to the trigger. */
  align?: 'left' | 'right'
  /** Rendered panel content; call `close` after an item is chosen. */
  children: (close: () => void) => ReactNode
  /** Disable the trigger without unmounting it. */
  disabled?: boolean
  /** Tooltip / accessible description for the trigger. */
  title?: string
}

/**
 * Render a trigger that opens a panel.
 * @param props - see {@link MenuProps}.
 * @returns the menu.
 */
export function Menu({ label, className, align = 'left', children, disabled = false, title }: MenuProps) {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // Capture phase: the canvas below also listens for mousedown (it closes the
    // prompt window on empty clicks), and the menu must win the race for clicks
    // that land inside its own panel.
    const onDown = (event: MouseEvent): void => {
      if (host.current !== null && !host.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`menu${className === undefined ? '' : ` ${className}`}`} ref={host}>
      <button
        type="button"
        className="menu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        title={title}
        disabled={disabled}
        onClick={() => { setOpen((value) => !value) }}
      >
        {label}
      </button>
      {open ? <div className={`menu-panel ${align}`} role="menu">{children(() => { setOpen(false) })}</div> : null}
    </div>
  )
}

/** Props for {@link MenuItem}. */
export interface MenuItemProps {
  /** Click handler; the menu closes itself around it. */
  onClick: () => void
  /** Row content. */
  children: ReactNode
  /** Mark the currently selected row. */
  active?: boolean
  /** Render as destructive (delete). */
  danger?: boolean
  /** Second line, right-aligned (counts, sizes, shortcuts). */
  note?: string
}

/**
 * One row inside a {@link Menu}.
 * @param props - see {@link MenuItemProps}.
 * @returns the row.
 */
export function MenuItem({ onClick, children, active = false, danger = false, note }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${active ? ' active' : ''}${danger ? ' danger' : ''}`}
      onClick={onClick}
    >
      <span className="menu-item-label">{children}</span>
      {note === undefined ? null : <span className="menu-item-note">{note}</span>}
    </button>
  )
}
