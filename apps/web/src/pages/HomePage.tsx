/**
 * Home.
 *
 * The product's front door: what you can do, what you were doing, and what this
 * thing is. Structure first — the showcase wall is driven by `GET /api/site`
 * (an operator-editable JSON), so re-designing it later never means touching
 * this component's data flow, only its markup.
 *
 * Capability entries marked `planned` are shown but not clickable: an empty
 * promise is worse than a visible "not yet".
 */
import { useEffect, useState } from 'react'
import {
  duplicateCanvas, fetchSite, listFolders, listCanvases, moveCanvas, trashCanvas,
  type FolderInfo, type CanvasInfo, type SiteContent,
} from '../api.ts'
import { ProjectCardMenu } from '../components/ProjectCardMenu.tsx'
import { SmallImage } from '../components/SmallImage.tsx'
import { navigate } from '../router.ts'

/** Props for the home page. */
export interface HomePageProps {
  /** Create a project and open it; returns nothing, navigation happens here. */
  onCreate: () => Promise<void>
  /** Bumped by the shell whenever projects changed elsewhere. */
  refreshToken: number
}

/** Format a timestamp the way a person reads it. */
function when(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getMonth() + 1)}月${String(at.getDate())}日 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * Render the home page.
 * @param props - creation callback and a refresh signal.
 * @returns the home page.
 */
export function HomePage({ onCreate, refreshToken }: HomePageProps) {
  const [site, setSite] = useState<SiteContent | null>(null)
  const [projects, setProjects] = useState<CanvasInfo[]>([])
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [busy, setBusy] = useState(false)
  /** Bumped after an action on a card, to re-read the list. */
  const [localToken, setLocalToken] = useState(0)
  const refresh = (): void => { setLocalToken((value) => value + 1) }

  useEffect(() => {
    void fetchSite().then(setSite).catch(() => { setSite(null) })
  }, [])
  useEffect(() => {
    void listCanvases().then((result) => { setProjects(result.canvases) }).catch(() => { setProjects([]) })
    void listFolders().then((result) => { setFolders(result.folders) }).catch(() => { setFolders([]) })
  }, [refreshToken, localToken])

  const recent = projects.slice(0, 8)
  const folderName = (folderId: string): string => folders.find((item) => item.id === folderId)?.name ?? ''
  const categories = site?.showcase.categories ?? []
  const [category, setCategory] = useState('all')
  const items = (site?.showcase.items ?? []).filter((item) => category === 'all' || item.category === category)

  return (
    <div className="home">
      {/* 首屏：大留白 + 一团很慢的光。光晕是纯 CSS 的（不跑 JS、不动布局），
          系统开了「减少动态效果」它就停住 —— 见 styles.css 的 hero-aurora。 */}
      <header className="home-hero">
        <div className="hero-aurora" aria-hidden="true">
          <span className="orb gold" />
          <span className="orb cool" />
          <span className="veil" />
        </div>
        <div className="hero-inner">
          <img className="hero-logo" src="/ling-mark.png" alt="" />
          <p className="hero-kicker">LINGHAN</p>
          <h1>{site?.brand.name ?? 'LHIC'}</h1>
          <p className="hero-tagline">
            {site?.brand.tagline ?? '本地算力优先的 AI 创作台：画布、素材与生成历史都留在你自己的机器上。'}
          </p>
          <div className="hero-actions">
            <button
              type="button"
              className="home-create"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void onCreate().finally(() => { setBusy(false) })
              }}
            >
              <span className="plus">＋</span>
              <span>{busy ? '正在创建…' : '新建画布创作'}</span>
            </button>
            <button type="button" className="hero-ghost" onClick={() => { navigate('/projects') }}>我的画布</button>
          </div>
          <p className="hero-foot">
            {projects.length === 0 ? '还没有画布 —— 从上面那颗按钮开始。' : `已有 ${String(projects.length)} 张画布`}
          </p>
        </div>
      </header>

      {/* 能力只留一行小标签：首页要的是**留白**，不是把功能表摊开。
          想看细节的人把鼠标停上去（title 里有那句说明）。 */}
      <section className="home-block home-block-tight">
        <div className="capability-chips">
          {(site?.capabilities ?? []).map((capability) => (
            <span
              key={capability.id}
              className={`cap-chip ${capability.status}`}
              title={capability.description}
            >
              {capability.title}
            </span>
          ))}
        </div>
      </section>

      <section className="home-block">
        <div className="home-block-head">
          <h2>最近画布</h2>          <button type="button" className="link" onClick={() => { navigate('/projects') }}>查看全部 ›</button>
        </div>
        {recent.length === 0
          ? <p className="muted">还没有画布。点上面的「新建画布创作」开始。</p>
          : (
            <div className="project-row">
              {recent.map((project) => (
                <article className="project-card" key={project.id}>
                  <button type="button" className="card-open" onClick={() => { navigate(`/canvas/${project.id}`) }}>
                    {/* 没设封面时用画布里的某一张图——比一块灰底有用得多。 */}
                    {project.previewAssetId === ''
                      ? <span className="thumb" />
                      : <SmallImage className="thumb" assetId={String(project.previewAssetId)} size={320} />}
                    <span className="name">{project.name}</span>
                    <span className="time">
                      {folderName(project.folderId) === '' ? '' : `${folderName(project.folderId)} · `}{when(project.updatedAt)}
                    </span>
                  </button>
                  <ProjectCardMenu
                    project={project}
                    folders={folders}
                    onOpen={() => { navigate(`/canvas/${project.id}`) }}
                    onRename={() => { navigate('/projects') }}
                    onCover={() => { navigate('/projects') }}
                    onDuplicate={() => { void duplicateCanvas(project.id).then(refresh) }}
                    onMove={(folderId) => { void moveCanvas(project.id, folderId).then(refresh) }}
                    onDelete={() => {
                      if (!window.confirm(`把画布「${project.name}」移到回收站？可以在项目页的回收站里还原。`)) return
                      void trashCanvas(project.id).then(refresh)
                    }}
                  />
                </article>
              ))}
            </div>
          )}
      </section>

      <section className="home-block">
        <h2>为什么用它</h2>
        <div className="highlight-row">
          {(site?.highlights ?? []).map((highlight) => (
            <div key={highlight.id} className="highlight-card">
              <strong>{highlight.title}</strong>
              <p>{highlight.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 展示区没有内容时整块不渲染。
          挂一个空区块加一句「内容由 site.json 驱动」，是拿运营方的待办当产品界面——
          访客看到的是一个坏掉的板块。有内容它自然会出现。 */}
      {(site?.showcase.items ?? []).length === 0 ? null : (
        <section className="home-block">
          <div className="home-block-head">
            <h2>展示</h2>
            <div className="category-tabs">
              {categories.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={category === entry.id ? 'active' : ''}
                  onClick={() => { setCategory(entry.id) }}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          </div>
          {items.length === 0
            ? <p className="muted">这个分类下还没有作品。</p>
            : (
              <div className="showcase-grid">
                {items.map((item) => (
                  <article key={item.id} className="showcase-card">
                    {item.image === undefined ? <span className="cover" /> : <img src={item.image} alt={item.title} />}
                    <strong>{item.title}</strong>
                    {item.author === undefined ? null : <span className="author">{item.author}</span>}
                  </article>
                ))}
              </div>
            )}
        </section>
      )}
    </div>
  )
}
