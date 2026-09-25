/**
 * Application shell.
 *
 * Login gate, a navigation rail, and the routed page. The rail is deliberately
 * small — home / projects / assets — because the canvas brings its own panels.
 * That is the reference product's shape, and it keeps global navigation from
 * growing into a junk drawer.
 */
import { useCallback, useEffect, useState } from 'react'
import { createProject, fetchSession, login, logout, type SessionInfo } from './api.ts'
import { AssetsPage } from './pages/AssetsPage.tsx'
import { CanvasPage } from './pages/CanvasPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { ProjectsPage } from './pages/ProjectsPage.tsx'
import { SetupPage } from './pages/SetupPage.tsx'
import { WorkflowsPage } from './pages/WorkflowsPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import { navigate, useRoute } from './router.ts'

/** Application root. */
export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** Bumped whenever data changed elsewhere, so a page can reload its list. */
  const [refreshToken, setRefreshToken] = useState(0)
  const route = useRoute()

  const refresh = useCallback(() => { setRefreshToken((value) => value + 1) }, [])

  useEffect(() => {
    void (async () => {
      try {
        const info = await fetchSession()
        setSession(info)
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : '初始化失败')
      }
    })()
  }, [])

  /**
   * Open a canvas — in a new window when we can.
   *
   * The home page and a canvas are two separate pages: a canvas is where you
   * work, and losing the home page (or the list you were reading) the moment you
   * create one is the wrong trade. `window.open` has to happen synchronously in
   * the click handler, before the `await`, or the browser stops treating it as a
   * user gesture and blocks it.
   */
  const createAndOpen = useCallback(async () => {
    const tab = window.open('', '_blank')
    try {
      const created = await createProject('未命名画布')
      refresh()
      if (tab === null) navigate(`/canvas/${created.project.id}`)
      else tab.location.href = `/canvas/${created.project.id}`
    } catch (problem) {
      tab?.close()
      throw problem
    }
  }, [refresh])

  if (session === null) {
    return <div className="gate"><p>{error === '' ? '正在连接…' : error}</p></div>
  }

  // 首启向导挡在最前面（比登录还前）：它要做的第一件事就是设一个密码。
  // 做成「门」而不是一个路由 —— 一个能被 URL 绕过去的新手引导等于没有。
  if (session.setupNeeded === true) {
    return (
      <SetupPage
        session={session}
        onDone={() => {
          void fetchSession().then((info) => { setSession(info); refresh() }).catch(() => { setSession(null) })
        }}
      />
    )
  }

  if (!session.authenticated) {
    return (
      <div className="gate">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            setError('')
            void login(password)
              .then(() => fetchSession())
              .then((info) => {
                setSession(info)
                setPassword('')
                refresh()
              })
              .catch((problem: unknown) => { setError(problem instanceof Error ? problem.message : '登录失败') })
              .finally(() => { setBusy(false) })
          }}
        >
          <h1>Studio</h1>
          <p>AI 创作台 · 请输入访问密码</p>
          <input
            type="password"
            value={password}
            autoFocus
            placeholder="访问密码"
            onChange={(event) => { setPassword(event.target.value) }}
          />
          <button type="submit" disabled={busy}>{busy ? '登录中…' : '进入'}</button>
          {error !== '' ? <span className="error">{error}</span> : null}
        </form>
      </div>
    )
  }

  const navItem = (path: string, title: string, active: boolean) => (
    <button
      key={path}
      type="button"
      className={active ? 'active' : ''}
      onClick={() => {
        navigate(path)
        // Leaving the canvas to look at a list should reflect the latest state.
        refresh()
      }}
    >
      {title}
    </button>
  )

  // 画布是独立页面：它自带一整列左栏（logo 菜单 + 画布名 + 列表），
  // 所以这里不再给它套全局导航条——两条左导航会互相抢「我在哪、怎么走」这个问题。
  if (route.name === 'canvas') {
    return (
      <div className="shell single">
        <main>
          <CanvasPage projectId={route.projectId} />
        </main>
      </div>
    )
  }

  return (
    <div className="shell">
      <nav className="studio-nav">
        <div className="brand">Studio</div>
        {navItem('/', '首页', route.name === 'home')}
        {navItem('/projects', '项目', route.name === 'projects')}
        {navItem('/assets', '资产', route.name === 'assets')}
        {navItem('/workflows', '工作流', route.name === 'workflows')}
        {navItem('/settings', '设置', route.name === 'settings')}
        <span className="nav-spacer" />
        <footer>
          <span className="muted">本地算力 · {session.driver}</span>
          <button type="button" onClick={() => { void logout().then(() => { setSession(null) }) }}>退出</button>
        </footer>
      </nav>
      <main>
        {route.name === 'home' ? <HomePage onCreate={createAndOpen} refreshToken={refreshToken} /> : null}
        {route.name === 'projects' ? <ProjectsPage refreshToken={refreshToken} onChanged={refresh} /> : null}
        {route.name === 'assets' ? <AssetsPage refreshToken={refreshToken} /> : null}
        {route.name === 'workflows' ? <WorkflowsPage refreshToken={refreshToken} onChanged={refresh} /> : null}
        {route.name === 'settings' ? <SettingsPage refreshToken={refreshToken} /> : null}
        {route.name === 'notFound' ? (
          <div className="page">
            <h1>页面不存在</h1>
            <p className="muted">{route.path}</p>
            <button type="button" onClick={() => { navigate('/') }}>回到首页</button>
          </div>
        ) : null}
      </main>
    </div>
  )
}
