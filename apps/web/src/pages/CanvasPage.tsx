/**
 * Canvas page.
 *
 * The canvas is its own page: `/canvas/<projectId>` loads one document and hands
 * it to the canvas. The id comes from the URL rather than from "whatever the list
 * had selected", which is what makes a canvas linkable, reloadable, and
 * unambiguous when several canvases share a name — and it is what lets the page
 * be opened in its own window from the project list.
 *
 * There is no folder here on purpose: folders organise the project list, and the
 * canvas page only ever needs to say which canvas this is and let you rename it.
 */
import { useCallback, useEffect, useState } from 'react'
import { createCanvas, listCanvases, loadCanvas, renameCanvas, trashCanvas, type CanvasDoc, type CanvasInfo } from '../api.ts'
import { CanvasTopBar } from '../canvas/CanvasTopBar.tsx'
import { StudioCanvas } from '../canvas/StudioCanvas.tsx'
import { navigate } from '../router.ts'

/** Props for the canvas page. */
export interface CanvasPageProps {
  /** Project id taken from the route. */
  projectId: string
}

/**
 * Render one project's canvas.
 * @param props - the project id.
 * @returns the canvas page.
 */
export function CanvasPage({ projectId }: CanvasPageProps) {
  // 状态是「三选一」而不是把「加载中」和「空画布」都塞进 doc：
  // 服务端对从没保存过的项目返回的正是 doc: null，
  // 如果 null 同时表示「还在加载」，新建的项目就会永远停在「正在打开画布…」。
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; doc: CanvasDoc | null } | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [project, setProject] = useState<CanvasInfo | null>(null)
  const [siblings, setSiblings] = useState<CanvasInfo[]>([])

  useEffect(() => {
    setState({ status: 'loading' })
    void loadCanvas(projectId)
      .then((result) => { setState({ status: 'ready', doc: result.doc }) })
      .catch((problem: unknown) => {
        setState({ status: 'error', message: problem instanceof Error ? problem.message : '打开失败' })
      })
  }, [projectId])

  /** Re-read the picker: the canvas's own name and what else exists. */
  const refreshPicker = useCallback(async (): Promise<void> => {
    const listed = await listCanvases()
    setProject(listed.canvases.find((item) => item.id === projectId) ?? null)
    setSiblings(listed.canvases)
  }, [projectId])

  useEffect(() => {
    void refreshPicker().catch(() => { /* the canvas itself still works */ })
  }, [refreshPicker])

  const canvasName = project?.name ?? projectId.slice(0, 8)

  /** 新建画布：在新窗口打开——画布是独立页面。 */
  const addCanvas = useCallback(async (): Promise<void> => {
    // 先同步开一个空窗口：异步 await 之后浏览器不再把 window.open 当成用户手势，
    // 会被拦成弹窗。开完再填地址是这里唯一可靠的做法。
    const tab = window.open('', '_blank')
    try {
      const created = await createCanvas(`未命名画布 ${String(siblings.length + 1)}`, project?.folderId)
      if (tab === null) navigate(`/canvas/${created.canvas.id}`)
      else tab.location.href = `/canvas/${created.canvas.id}`
    } catch {
      tab?.close()
    }
  }, [project, siblings.length])

  /** 改画布名：改完刷新左栏，让标题立刻变。 */
  const applyCanvasName = useCallback(async (name: string): Promise<void> => {
    await renameCanvas(projectId, name)
    await refreshPicker()
  }, [projectId, refreshPicker])

  /** 删除当前画布：进回收站，然后回主页——这个页面已经不存在了。 */
  const removeCanvas = async (): Promise<void> => {
    if (project === null) return
    if (!window.confirm(`把画布「${project.name}」移到回收站？可以在项目页的回收站里还原。`)) return
    await trashCanvas(project.id)
    navigate('/')
  }

  if (state.status === 'error') {
    return (
      <div className="page">
        <header className="page-head"><h1>打不开这个画布</h1></header>
        <p className="muted">{state.message}</p>
        <button type="button" onClick={() => { navigate('/projects') }}>返回项目列表</button>
      </div>
    )
  }

  if (state.status === 'loading') {
    // The canvas itself treats a missing document as "new project", so waiting
    // here is what keeps a slow load from looking like an empty canvas.
    return <div className="page"><p className="muted">正在打开画布…</p></div>
  }

  return (
    <div className="canvas-view">
      <StudioCanvas
        key={projectId}
        projectId={projectId}
        document={state.doc}
        topBar={(
          <CanvasTopBar
            canvasName={canvasName}
            onHome={() => { navigate('/') }}
            onAllProjects={() => { navigate('/projects') }}
            onCreateProject={() => { void addCanvas() }}
            onDeleteProject={() => { void removeCanvas() }}
            onRenameCanvas={(name) => { void applyCanvasName(name) }}
          />
        )}
      />
    </div>
  )
}
