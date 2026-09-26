/**
 * Application shell.
 *
 * Login gate, a navigation rail, and the routed page. The rail is deliberately
 * small — home / projects / assets — because the canvas brings its own panels.
 * That is the reference product's shape, and it keeps global navigation from
 * growing into a junk drawer.
 */
import { useCallback, useEffect, useState } from 'react'
import { createCanvas, fetchSession, login, logout, type SessionInfo } from './api.ts'
import { ThemeSwitch } from './components/ThemeSwitch.tsx'
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
  /**
   * 设置是个**浮层**，不是一个页面。
   *
   * 理由：改设置的时候要看的是「界面本身变没变」（外观、后端、代理地址），
   * 把整页换成设置页就等于把参照物藏起来了。它自己的入口在左栏**最下面**
   * （和「退出」一起），因为那是「关于这套软件的杂事」，不属于日常五个入口。
   * `/settings` 这条路由仍然有效（深链接、老书签），只是打开的是同一个浮层。
   */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const route = useRoute()

  const refresh = useCallback(() => { setRefreshToken((value) => value + 1) }, [])

  /** 设置浮层：左栏那颗按钮与 `/settings` 深链接都打开它。 */
  const showSettings = settingsOpen || route.name === 'settings'
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false)
    if (route.name === 'settings') navigate('/')
  }, [route.name])

  // Esc 关掉设置：它是个窗口，窗口就该能用 Esc 关。
  useEffect(() => {
    if (!showSettings) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeSettings() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [showSettings, closeSettings])

  useEffect(() => {
    void (async () => {
      try {
        const info = await fetchSession()
        setSession(info)
        // 安装版预置了访问密码：直接填好，用户点一下「进入」就行（他也可以改）。
        if (!info.authenticated && info.defaultPassword !== undefined && info.defaultPassword !== '') {
          setPassword(info.defaultPassword)
        }
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
      const created = await createCanvas('未命名画布')
      refresh()
      if (tab === null) navigate(`/canvas/${created.canvas.id}`)
      else tab.location.href = `/canvas/${created.canvas.id}`
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
          <h1>LHIC</h1>
          <p>本地 AI 画布 · 请输入访问密码</p>
          <input
            type="password"
            value={password}
            autoFocus
            placeholder="访问密码"
            onChange={(event) => { setPassword(event.target.value) }}
          />
          {session.defaultPassword === undefined ? null : (
            <p className="gate-hint">安装版默认密码已填好（{session.defaultPassword}），点「进入」即可；登录后可在设置里改。</p>
          )}
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

  /** 设置浮层的 JSX（状态与 Esc 处理在上面）。 */
  const settingsOverlay = showSettings
    ? (
      <div className="settings-overlay" role="dialog" aria-label="设置" data-testid="settings-window">
        <div className="settings-scrim" onClick={closeSettings} />
        <section className="settings-window">
          <header className="settings-window-head">
            <img className="settings-window-logo" src="/ling-mark.png" alt="" />
            <strong>设置</strong>
            <ThemeSwitch />
            <button type="button" className="link settings-close" title="关闭（Esc）" onClick={closeSettings}>✕</button>
          </header>
          <div className="settings-window-body">
            <SettingsPage refreshToken={refreshToken} />
          </div>
        </section>
      </div>
    )
    : null

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
        <div className="brand">
          <img src="/ling-mark.png" alt="" />
          <span>LHIC</span>
          <em>伶</em>
        </div>
        {navItem('/', '首页', route.name === 'home')}
        {navItem('/projects', '项目', route.name === 'projects')}
        {navItem('/assets', '资产', route.name === 'assets')}
        {navItem('/workflows', '工作流', route.name === 'workflows')}
        <span className="nav-spacer" />
        {/* 杂事都在下面这一格：设置与退出。日常那五个入口在上面，互不打扰。 */}
        <footer>
          <button
            type="button"
            className={`nav-settings${showSettings ? ' active' : ''}`}
            data-testid="nav-settings"
            onClick={() => { setSettingsOpen(true) }}
          >
            设置
          </button>
          <span className="muted">本地算力 · {session.driver}</span>
          <button type="button" onClick={() => { void logout().then(() => { setSession(null) }) }}>退出</button>
        </footer>
      </nav>
      <main>
        {route.name === 'home' ? <HomePage onCreate={createAndOpen} refreshToken={refreshToken} /> : null}
        {route.name === 'projects' ? <ProjectsPage refreshToken={refreshToken} onChanged={refresh} /> : null}
        {route.name === 'assets' ? <AssetsPage refreshToken={refreshToken} /> : null}
        {route.name === 'workflows' ? <WorkflowsPage refreshToken={refreshToken} onChanged={refresh} /> : null}
        {route.name === 'notFound' ? (
          <div className="page">
            <h1>页面不存在</h1>
            <p className="muted">{route.path}</p>
            <button type="button" onClick={() => { navigate('/') }}>回到首页</button>
          </div>
        ) : null}
      </main>
      {settingsOverlay}
    </div>
  )
}
