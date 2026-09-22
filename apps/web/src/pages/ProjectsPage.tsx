/**
 * Projects — the canvas wall.
 *
 * The shape follows the reference product: a card grid whose first tile creates
 * a canvas, folder cards beside it, and every project card carrying a `⋯` menu
 * (打开 / 重命名 / 修改封面 / 创建副本 / 移动至文件夹 / 删除项目).
 *
 * Two deliberate differences from a plain file browser:
 *
 * - **Deleting moves to the trash**, and 回收站 is a view of this same page
 *   (`?trash=1`) with 还原 and 彻底删除. Deleting is the easiest item to hit by
 *   accident and a canvas is the only place the work lives.
 * - **A folder is a label, not a container.** Deleting a folder unfiles its
 *   canvases instead of taking them with it, so the two destructive actions here
 *   have very different blast radii — which is exactly why they are separate.
 *
 * `?folder=` and `?trash=1` are real URLs, so "this folder" and "the trash" are
 * linkable and survive a reload.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createFolder, createProject, deleteFolder, duplicateProject, emptyTrash, listFolders, listProjects,
  moveProject, purgeProject, renameFolder, renameProject, restoreProject, setProjectCover,
  trashProject, loadCanvas,
  type FolderInfo, type ProjectInfo,
} from '../api.ts'
import { Menu, MenuItem } from '../components/Menu.tsx'
import { ProjectCardMenu } from '../components/ProjectCardMenu.tsx'
import { navigate, useSearch } from '../router.ts'

/** Props for the projects page. */
export interface ProjectsPageProps {
  /** Bumped by the shell so the list reloads after a change elsewhere. */
  refreshToken: number
  /** Tell the shell something changed, so other views refresh too. */
  onChanged: () => void
}

/** Format a timestamp the way a person reads it. */
function when(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getFullYear())}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/**
 * Render the canvas wall.
 * @param props - refresh signal and change callback.
 * @returns the projects page.
 */
export function ProjectsPage({ refreshToken, onChanged }: ProjectsPageProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [query, setQuery] = useState('')
  const [cover, setCover] = useState<{ project: ProjectInfo; images: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const search = useSearch()
  const folder = search.get('folder') ?? ''
  const trash = search.get('trash') === '1'

  const reload = useCallback(async (): Promise<void> => {
    const [listed, spaces] = await Promise.all([
      listProjects(trash ? { trashed: true } : (folder === '' ? {} : { folderId: folder })),
      listFolders(),
    ])
    setProjects(listed.projects)
    setFolders(spaces.folders)
  }, [folder, trash])

  useEffect(() => {
    void reload().catch(() => { setProjects([]); setFolders([]) })
  }, [reload, refreshToken])

  const createCanvas = async (): Promise<void> => {
    setBusy(true)
    try {
      const created = await createProject(`未命名画布 ${String(projects.length + 1)}`, folder)
      onChanged()
      navigate(`/canvas/${created.project.id}`)
    } finally {
      setBusy(false)
    }
  }

  const addFolder = async (): Promise<void> => {
    const created = await createFolder(`未命名文件夹 ${String(folders.length + 1)}`)
    await reload()
    onChanged()
    // 直接进入改名状态，否则用户拿到的是一堆「未命名文件夹 1/2/3」。
    setRenamingFolder(created.folder.id)
    setFolderDraft(created.folder.name)
  }

  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  const [projectDraft, setProjectDraft] = useState('')

  /**
   * Commit a folder rename.
   *
   * Called directly on Enter *and* on blur. Doing it only via `blur()` made Enter
   * depend on the field actually holding focus — which is exactly what a
   * programmatic fill in a test does not have, and what a user loses if focus
   * moved for any reason.
   */
  const commitFolderRename = useCallback(async (id: string, name: string): Promise<void> => {
    setRenamingFolder(null)
    const trimmed = name.trim()
    if (trimmed === '') return
    await renameFolder(id, trimmed)
    await reload()
    onChanged()
  }, [onChanged, reload])

  const commitProjectRename = useCallback(async (id: string, name: string): Promise<void> => {
    setRenamingProject(null)
    const trimmed = name.trim()
    if (trimmed === '') return
    await renameProject(id, trimmed)
    await reload()
    onChanged()
  }, [onChanged, reload])

  /** Open the cover picker: the images already on that canvas, and nothing else. */
  const openCover = async (project: ProjectInfo): Promise<void> => {
    try {
      const { doc } = await loadCanvas(project.id)
      const images = (doc?.nodes ?? [])
        .map((node) => (node as { data?: { url?: unknown } }).data?.url)
        .filter((url): url is string => typeof url === 'string' && url.startsWith('/api/assets/'))
      setCover({ project, images })
    } catch {
      setCover({ project, images: [] })
    }
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return projects
    return projects.filter((project) => project.name.toLowerCase().includes(needle))
  }, [projects, query])

  const currentFolder = folders.find((item) => item.id === folder)
  /** Inside a folder the level must be visible; at the root there is nothing above. */
  const inFolder = !trash && currentFolder !== undefined

  return (
    <div className="page wall">
      <header className="wall-head">
        {/* 面包屑，而不是一个「返回」：在根目录时它就该什么都不显示，
            而不是给一个点了原地不动的死链接。 */}
        <nav className="wall-crumbs" aria-label="位置">
          <button
            type="button"
            className={`crumb${inFolder || trash ? '' : ' is-here'}`}
            onClick={() => { navigate('/projects') }}
            disabled={!inFolder && !trash}
          >
            {trash ? '回收站' : '全部项目'}
          </button>
          {inFolder ? (
            <>
              <span className="crumb-sep" aria-hidden="true">›</span>
              <span className="crumb is-here">{currentFolder.name}</span>
            </>
          ) : null}
        </nav>
        <span className="wall-count">
          {trash
            ? `${String(visible.length)} 张画布`
            : inFolder
              ? `${String(visible.length)} 张画布`
              : `${String(folders.length)} 个文件夹 · ${String(visible.length)} 张画布`}
        </span>
        <div className="wall-actions">
          <input
            type="text"
            className="wall-search"
            value={query}
            placeholder="搜索画布"
            onChange={(event) => { setQuery(event.target.value) }}
          />
          {trash
            ? (
              <>
                <button type="button" onClick={() => { navigate('/projects') }}>回到项目</button>
                <button
                  type="button"
                  className="danger"
                  disabled={visible.length === 0}
                  title="彻底删除回收站里的所有画布，不能撤销"
                  onClick={() => {
                    if (!window.confirm(`彻底删除回收站里的 ${String(visible.length)} 个画布？这一步不能撤销。`)) return
                    void emptyTrash().then(() => { void reload(); onChanged() })
                  }}
                >清空回收站</button>
              </>
            )
            : (
              <>
                <button type="button" onClick={() => { navigate('/projects?trash=1') }}>回收站</button>
                {/* 文件夹是平的，所以在哪一层新建都一样，按钮就一直在这儿。 */}
                <button type="button" onClick={() => { void addFolder() }}>新建文件夹</button>
              </>
            )}
        </div>
      </header>

      {trash && visible.length === 0 ? <p className="wall-empty">回收站是空的。</p> : null}

      {/* 根目录：文件夹单独一段，画布单独一段。混在一个网格里看不出层级。 */}
      {!trash && !inFolder && folders.length > 0 ? (
        <section className="wall-section">
          <h2>文件夹<span className="count">{folders.length}</span></h2>
          <div className="card-grid">
            {folders.map((item) => (
              <article className="card folder-card" key={item.id}>
                <button type="button" className="card-open" onClick={() => { navigate(`/projects?folder=${item.id}`) }}>
                  <span className="folder-tile" aria-hidden="true"><span className="folder-tab" /></span>
                  {renamingFolder === item.id ? (
                    <input
                      className="card-rename"
                      autoFocus
                      value={folderDraft}
                      onClick={(event) => { event.stopPropagation() }}
                      onChange={(event) => { setFolderDraft(event.target.value) }}
                      onBlur={() => { void commitFolderRename(item.id, folderDraft) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void commitFolderRename(item.id, folderDraft)
                        if (event.key === 'Escape') { setRenamingFolder(null); setFolderDraft('') }
                      }}
                    />
                  ) : <strong>{item.name}</strong>}
                  <span className="muted">{item.canvasCount === 0 ? '空文件夹' : `${String(item.canvasCount)} 张画布`}</span>
                </button>
                <Menu className="card-menu" align="right" title="文件夹操作" label="⋯">
                  {(close) => (
                    <>
                      <MenuItem onClick={() => { close(); navigate(`/projects?folder=${item.id}`) }}>打开</MenuItem>
                      <MenuItem onClick={() => { close(); setRenamingFolder(item.id); setFolderDraft(item.name) }}>重命名</MenuItem>
                      <div className="menu-sep" />
                      <MenuItem danger onClick={() => {
                        close()
                        // 只解绑，不删里面的画布——文件夹是标签，不是容器。
                        if (!window.confirm(`删除文件夹「${item.name}」？里面的画布不会被删除，只会变成未归档。`)) return
                        void deleteFolder(item.id).then(() => { void reload(); onChanged() })
                      }}>删除文件夹</MenuItem>
                    </>
                  )}
                </Menu>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {!trash ? (
        <section className="wall-section">
          <h2>
            {inFolder ? '画布' : '画布'}
            {visible.length === 0 ? null : <span className="count">{visible.length}</span>}
          </h2>
          <div className="card-grid">
            <button type="button" className="card create-card" disabled={busy} onClick={() => { void createCanvas() }}>
              <span className="plus" aria-hidden="true">＋</span>
              <span>{busy ? '正在创建…' : inFolder ? '在这里新建画布' : '创建新的项目'}</span>
            </button>

            {visible.map((project) => (
              <article className="card project-card" key={project.id}>
                <button type="button" className="card-open" onClick={() => { navigate(`/canvas/${project.id}`) }}>
                  {/* 没设封面时用画布自己的某张图（随机取）：一排同款灰底没法扫。 */}
                  {project.previewAssetId === ''
                    ? <span className="cover" />
                    : <img className="cover" src={`/api/assets/${project.previewAssetId}`} alt="" />}
                  {renamingProject === project.id ? (
                    <input
                      className="card-rename"
                      autoFocus
                      value={projectDraft}
                      onClick={(event) => { event.stopPropagation() }}
                      onChange={(event) => { setProjectDraft(event.target.value) }}
                      onBlur={() => { void commitProjectRename(project.id, projectDraft) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void commitProjectRename(project.id, projectDraft)
                        if (event.key === 'Escape') { setRenamingProject(null); setProjectDraft('') }
                      }}
                    />
                  ) : <strong>{project.name}</strong>}
                  <span className="muted">{when(project.deletedAt === '' ? project.updatedAt : project.deletedAt)}</span>
                </button>
                <ProjectCardMenu
                  project={project}
                  folders={folders}
                  onOpen={() => { navigate(`/canvas/${project.id}`) }}
                  onRename={() => { setRenamingProject(project.id); setProjectDraft(project.name) }}
                  onCover={() => { void openCover(project) }}
                  onDuplicate={() => { void duplicateProject(project.id).then(() => { void reload(); onChanged() }) }}
                  onMove={(folderId) => { void moveProject(project.id, folderId).then(reload) }}
                  onDelete={() => {
                    if (project.deletedAt === '') {
                      void trashProject(project.id).then(() => { void reload(); onChanged() })
                      return
                    }
                    if (!window.confirm(`彻底删除「${project.name}」？这一步不能撤销。`)) return
                    void purgeProject(project.id).then(() => { void reload(); onChanged() })
                  }}
                  onRestore={() => { void restoreProject(project.id).then(() => { void reload(); onChanged() }) }}
                />
              </article>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="wall-empty">
              {query.trim() === ''
                ? (inFolder ? '这个文件夹是空的。' : '还没有画布。')
                : '没有匹配的画布。'}
            </p>
          ) : null}
        </section>
      ) : (
        <section className="wall-section">
          <div className="card-grid">
            {visible.map((project) => (
              <article className="card project-card" key={project.id}>
                <button type="button" className="card-open" onClick={() => { navigate(`/canvas/${project.id}`) }}>
                  {project.previewAssetId === ''
                    ? <span className="cover" />
                    : <img className="cover" src={`/api/assets/${project.previewAssetId}`} alt="" />}
                  <strong>{project.name}</strong>
                  <span className="muted">删除于 {when(project.deletedAt)}</span>
                </button>
                <ProjectCardMenu
                  project={project}
                  folders={folders}
                  onOpen={() => { navigate(`/canvas/${project.id}`) }}
                  onRename={() => { setRenamingProject(project.id); setProjectDraft(project.name) }}
                  onCover={() => { void openCover(project) }}
                  onDuplicate={() => { void duplicateProject(project.id).then(() => { void reload(); onChanged() }) }}
                  onMove={(folderId) => { void moveProject(project.id, folderId).then(reload) }}
                  onDelete={() => {
                    if (!window.confirm(`彻底删除「${project.name}」？这一步不能撤销。`)) return
                    void purgeProject(project.id).then(() => { void reload(); onChanged() })
                  }}
                  onRestore={() => { void restoreProject(project.id).then(() => { void reload(); onChanged() }) }}
                />
              </article>
            ))}
          </div>
        </section>
      )}

      {cover !== null ? (
        <>
          <div className="studio-menu-scrim" onClick={() => { setCover(null) }} />
          <div className="cover-panel" role="dialog" aria-label="修改封面">
            <header>
              <strong>给「{cover.project.name}」选封面</strong>
              <button type="button" className="link" onClick={() => { setCover(null) }}>关闭</button>
            </header>
            {cover.images.length === 0
              ? <p className="muted">这个画布上还没有画面。先在画布里生成或上传一张，再回来选。</p>
              : (
                <div className="cover-grid">
                  {cover.images.map((url) => (
                    <button
                      key={url}
                      type="button"
                      className="cover-choice"
                      title="设为封面"
                      onClick={() => {
                        const assetId = url.split('/api/assets/')[1] ?? ''
                        setCover(null)
                        void setProjectCover(cover.project.id, assetId).then(() => { void reload(); onChanged() })
                      }}
                    >
                      <img src={url} alt="" />
                    </button>
                  ))}
                </div>
              )}
            {cover.project.coverAssetId === '' ? null : (
              <button type="button" onClick={() => {
                setCover(null)
                void setProjectCover(cover.project.id, '').then(() => { void reload(); onChanged() })
              }}>移除封面</button>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
