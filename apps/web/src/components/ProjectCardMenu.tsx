/**
 * The `⋯` menu on a canvas card, in one place.
 *
 * The home page's 最近画布 and the project wall show the same cards, so they must
 * offer the same actions — a menu that exists on one page and not the other is
 * how "where do I rename this?" becomes a hunt.
 */
import { Menu, MenuItem } from './Menu.tsx'
import type { FolderInfo, ProjectInfo } from '../api.ts'

/** Props for {@link ProjectCardMenu}. */
export interface ProjectCardMenuProps {
  /** The canvas this menu belongs to. */
  project: ProjectInfo
  /** Folders available to move into. */
  folders: FolderInfo[]
  /** Open the canvas. */
  onOpen: () => void
  /** Start renaming it. */
  onRename: () => void
  /** Pick a cover image. */
  onCover: () => void
  /** Copy the canvas. */
  onDuplicate: () => void
  /** Move it into a folder (empty string unfiles it). */
  onMove: (folderId: string) => void
  /** Delete it: to the trash when live, for good when already trashed. */
  onDelete: () => void
  /** Take it back out of the trash (only shown for trashed canvases). */
  onRestore?: () => void
}

/**
 * Render the menu.
 * @param props - see {@link ProjectCardMenuProps}.
 * @returns the `⋯` trigger and its panel.
 */
export function ProjectCardMenu(props: ProjectCardMenuProps) {
  const { project, folders, onOpen, onRename, onCover, onDuplicate, onMove, onDelete, onRestore } = props
  const trashed = project.deletedAt !== ''

  return (
    <Menu className="card-menu" align="right" title="项目操作" label="⋯">
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); onOpen() }}>打开</MenuItem>
          <MenuItem onClick={() => { close(); onRename() }}>重命名</MenuItem>
          <MenuItem onClick={() => { close(); onCover() }}>修改封面</MenuItem>
          <MenuItem onClick={() => { close(); onDuplicate() }}>创建副本</MenuItem>
          <div className="menu-sep" />
          {folders.length === 0
            ? <p className="note">还没有文件夹，先去「项目」页新建一个</p>
            : (
              <>
                <MenuItem onClick={() => { close(); onMove('') }}>移出文件夹</MenuItem>
                {folders.map((folder) => (
                  <MenuItem
                    key={folder.id}
                    active={folder.id === project.folderId}
                    onClick={() => { close(); onMove(folder.id) }}
                  >
                    移到「{folder.name}」
                  </MenuItem>
                ))}
              </>
            )}
          <div className="menu-sep" />
          {trashed
            ? (
              <>
                {onRestore === undefined ? null : <MenuItem onClick={() => { close(); onRestore() }}>还原</MenuItem>}
                <MenuItem danger onClick={() => { close(); onDelete() }}>彻底删除</MenuItem>
              </>
            )
            : <MenuItem danger onClick={() => { close(); onDelete() }}>删除项目</MenuItem>}
        </>
      )}
    </Menu>
  )
}
