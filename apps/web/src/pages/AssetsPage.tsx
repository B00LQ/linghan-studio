/**
 * Assets page.
 *
 * The same library the canvas's floating 资产 window shows, in a page instead of a
 * window — one component, so the categories, the sort, the paging and the batch
 * actions cannot drift between the two.
 *
 * The one thing this page must add is a **destination**: 添加到画布 has to ask
 * which canvas, because there is no canvas context here.
 *
 * Content-addressed: the same bytes uploaded twice appear once.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  deleteAsset, downloadAssets, listAssetFolders, listAssets, listCanvases, placeAssets, publishWork,
  type AssetFolderInfo, type CanvasInfo,
} from '../api.ts'
import { AssetBrowser, type BrowserAsset } from '../components/AssetBrowser.tsx'
import { Menu, MenuItem } from '../components/Menu.tsx'

/** Props for the assets page. */
export interface AssetsPageProps {
  /** Bumped by the shell after an upload elsewhere. */
  refreshToken: number
}

/**
 * Render the asset library.
 * @param props - refresh signal.
 * @returns the assets page.
 */
export function AssetsPage({ refreshToken }: AssetsPageProps) {
  const [assets, setAssets] = useState<BrowserAsset[]>([])
  const [folders, setFolders] = useState<AssetFolderInfo[]>([])
  const [projects, setProjects] = useState<CanvasInfo[]>([])
  const [notice, setNotice] = useState('')
  /** Ids waiting for the user to pick a canvas. */
  const [pending, setPending] = useState<string[]>([])

  const reload = useCallback(async (): Promise<void> => {
    const [listed, canvases, filed] = await Promise.all([listAssets(), listCanvases(), listAssetFolders()])
    setAssets(listed.assets)
    setProjects(canvases.canvases)
    setFolders(filed.folders)
  }, [])

  useEffect(() => {
    void reload().catch(() => { setAssets([]) })
  }, [reload, refreshToken])

  /** 要发布的那一件（打开对话框用的状态）。 */
  const [publish, setPublish] = useState<{ assetId: string; title: string; tags: string; summary: string; canvasId: string; withCanvas: boolean; privateOnly: boolean } | null>(null)
  const [publishBusy, setPublishBusy] = useState(false)

  /**
   * 发布到主页。
   *
   * 服务端做三件事：**压缩**（PNG 缩到长边 1600 重编码；JPEG/视频原样）、
   * 上传成品与（可选的）画布快照素材、落一件**待审**作品。
   * 所以这里要如实告诉用户「提交了、等审核」，而不是「已经发布了」。
   */
  const submitPublish = useCallback(async (): Promise<void> => {
    if (publish === null) return
    setPublishBusy(true)
    setNotice('正在压缩并上传（大文件要一会儿）…')
    try {
      const result = await publishWork({
        assetId: publish.assetId,
        title: publish.title.trim() === '' ? '未命名作品' : publish.title.trim(),
        ...(publish.summary.trim() === '' ? {} : { summary: publish.summary.trim() }),
        ...(publish.tags.trim() === '' ? {} : { tags: publish.tags.trim() }),
        ...(publish.canvasId === '' ? {} : { canvasId: publish.canvasId }),
        withCanvas: publish.withCanvas && publish.canvasId !== '',
        ...(publish.privateOnly ? { visibility: 'private' as const } : {}),
      })
      setPublish(null)
      setNotice(`${result.note}${result.notes.length === 0 ? '' : `（${result.notes.join('；')}）`}`)
    } catch (problem) {
      setNotice(problem instanceof Error ? problem.message : '发布失败')
    } finally {
      setPublishBusy(false)
    }
  }, [publish])

  /** Delete what can be deleted, and say plainly what could not. */
  const remove = useCallback(async (ids: string[]): Promise<void> => {
    let removed = 0
    const refused: string[] = []
    for (const id of ids) {
      try {
        await deleteAsset(id)
        removed += 1
      } catch {
        refused.push(id)
      }
    }
    await reload()
    setNotice(refused.length === 0
      ? `已删除 ${String(removed)} 个素材`
      : `删了 ${String(removed)} 个；${String(refused.length)} 个还有画布在用，先从画布上删掉那张图`)
  }, [reload])

  return (
    <div className="page assets-page">
      <AssetBrowser
        assets={assets}
        folders={folders}
        title="资产"
        note={`${String(assets.length)} 个素材 · 点图看大图，勾选后可批量操作`}
        notice={notice}
        onChanged={() => { void reload() }}
        onNotice={setNotice}
        onDownload={(ids) => { void downloadAssets(ids).catch((problem: unknown) => { setNotice(problem instanceof Error ? problem.message : '打包失败') }) }}
        onDelete={(ids) => { void remove(ids) }}
        onPlaceMany={(ids) => { setPending(ids); setNotice('') }}
        onPublish={(ids) => {
          const first = assets.find((asset) => asset.id === ids[0])
          if (first === undefined) return
          setPublish({
            assetId: first.id,
            // 默认标题给一个能改的起点，省得人对着空框发呆。
            title: (first.kind === 'video' ? '一段视频' : '一张作品'),
            tags: '', summary: '',
            // 默认带上第一张画布：多数人发布的就是刚做的那张画布。
            canvasId: projects[0]?.id ?? '',
            withCanvas: true,
            // 默认是**发布**（要审核）；「只备份」是一个要人手勾的选择 ——
            // 默认偷偷不公开，比默认公开更让人措手不及。
            privateOnly: false,
          })
          setNotice('')
        }}
        actions={pending.length === 0 ? undefined : (
          <Menu className="place-picker" title="选择要放到的画布" label={<>放到哪张画布？<span className="caret">▾</span></>}>
            {(close) => (
              <>
                <div className="menu-title">已选 {pending.length} 个素材</div>
                {projects.map((project) => (
                  <MenuItem
                    key={project.id}
                    onClick={() => {
                      close()
                      const ids = pending
                      setPending([])
                      void placeAssets(project.id, ids)
                        .then((result) => { setNotice(`已把 ${String(result.placed)} 个素材放到「${project.name}」`) })
                        .catch((problem: unknown) => { setNotice(problem instanceof Error ? problem.message : '放置失败') })
                    }}
                  >
                    {project.name}
                  </MenuItem>
                ))}
                <div className="menu-sep" />
                <MenuItem onClick={() => { close(); setPending([]) }}>取消</MenuItem>
              </>
            )}
          </Menu>
        )}
      />

      {/* 发布到主页：成品 + 可选附带画布。**提交后是待审**（管理员点过才上主页），
          所以文案说的是「提交」，不说「已发布」。 */}
      {publish === null ? null : (
        <>
          <div className="studio-menu-scrim" onClick={() => { if (!publishBusy) setPublish(null) }} />
          <div className="publish-panel" role="dialog" aria-label="发布到主页" data-testid="publish-panel">
            <header>
              <strong>发布到主页</strong>
              <button type="button" className="link" disabled={publishBusy} onClick={() => { setPublish(null) }}>取消</button>
            </header>
            <label className="field">
              <span>标题</span>
              <input
                value={publish.title} data-testid="publish-title"
                onChange={(event) => { setPublish({ ...publish, title: event.target.value }) }}
              />
            </label>
            <label className="field">
              <span>标签<em className="muted">逗号分隔，例如：赛博,夜景</em></span>
              <input
                value={publish.tags} data-testid="publish-tags"
                onChange={(event) => { setPublish({ ...publish, tags: event.target.value }) }}
              />
            </label>
            <label className="field">
              <span>一句话简介<em className="muted">可留空</em></span>
              <input
                value={publish.summary}
                onChange={(event) => { setPublish({ ...publish, summary: event.target.value }) }}
              />
            </label>
            <label className="field">
              <span>附带画布<em className="muted">别人能点「查看画布」看到提示词与结构（推荐）</em></span>
              <select
                value={publish.withCanvas ? publish.canvasId : ''}
                data-testid="publish-canvas"
                onChange={(event) => {
                  const value = event.target.value
                  setPublish({ ...publish, canvasId: value, withCanvas: value !== '' })
                }}
              >
                <option value="">不带画布</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label className="field check">
              <input
                type="checkbox"
                data-testid="publish-private"
                checked={publish.privateOnly}
                onChange={(event) => { setPublish({ ...publish, privateOnly: event.target.checked }) }}
              />
              <span>只备份到我的账号（不公开）<em className="muted">不进主页、不需要审核，只有你自己能打开</em></span>
            </label>
            <p className="muted">
              {publish.privateOnly
                ? '这是一份私密备份：只上传压缩后的成品与快照图片，原始素材留在你机器上，别人看不到。'
                : '只上传压缩后的成品与快照图片，原始素材留在你机器上。提交后需要管理员在后台点「通过」才会出现在主页。'}
            </p>
            <footer>
              <button type="button" className="primary" data-testid="publish-submit" disabled={publishBusy} onClick={() => { void submitPublish() }}>
                {publishBusy ? '正在上传…' : publish.privateOnly ? '存到我的云账号' : '提交待审'}
              </button>
            </footer>
          </div>
        </>
      )}
    </div>
  )
}

