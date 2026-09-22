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
  duplicateProject, fetchSite, listFolders, listProjects, moveProject, trashProject,
  type FolderInfo, type ProjectInfo, type SiteContent,
} from '../api.ts'
import { ProjectCardMenu } from '../components/ProjectCardMenu.tsx'
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
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [busy, setBusy] = useState(false)
  /** Bumped after an action on a card, to re-read the list. */
  const [localToken, setLocalToken] = useState(0)
  const refresh = (): void => { setLocalToken((value) => value + 1) }

  useEffect(() => {
    void fetchSite().then(setSite).catch(() => { setSite(null) })
  }, [])
  useEffect(() => {
    void listProjects().then((result) => { setProjects(result.projects) }).catch(() => { setProjects([]) })
    void listFolders().then((result) => { setFolders(result.folders) }).catch(() => { setFolders([]) })
  }, [refreshToken, localToken])

  const recent = projects.slice(0, 8)
  const folderName = (folderId: string): string => folders.find((item) => item.id === folderId)?.name ?? ''
  const categories = site?.showcase.categories ?? []
  const [category, setCategory] = useState('all')
  const items = (site?.showcase.items ?? []).filter((item) => category === 'all' || item.category === category)

  return (
    <div className="home">
      <header className="home-hero">
        <h1>{site?.brand.name ?? 'Studio'}</h1>
        <p>{site?.brand.tagline ?? '本地算力的 AI 创作台'}</p>
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
      </header>

      <section className="home-block">
        <h2>能力</h2>
        <div className="capability-row">
          {(site?.capabilities ?? []).map((capability) => (
            <div key={capability.id} className={`capability ${capability.status}`} title={capability.description}>
              <strong>{capability.title}</strong>
              <span>{capability.description}</span>
            </div>
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
                      : <img className="thumb" src={`/api/assets/${project.previewAssetId}`} alt="" />}
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
                    onDuplicate={() => { void duplicateProject(project.id).then(refresh) }}
                    onMove={(folderId) => { void moveProject(project.id, folderId).then(refresh) }}
                    onDelete={() => {
                      if (!window.confirm(`把画布「${project.name}」移到回收站？可以在项目页的回收站里还原。`)) return
                      void trashProject(project.id).then(refresh)
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
