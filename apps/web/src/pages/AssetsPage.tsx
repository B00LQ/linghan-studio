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
  deleteAsset, downloadAssets, listAssetFolders, listAssets, listProjects, placeAssets,
  type AssetFolderInfo, type ProjectInfo,
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
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [notice, setNotice] = useState('')
  /** Ids waiting for the user to pick a canvas. */
  const [pending, setPending] = useState<string[]>([])

  const reload = useCallback(async (): Promise<void> => {
    const [listed, canvases, filed] = await Promise.all([listAssets(), listProjects(), listAssetFolders()])
    setAssets(listed.assets)
    setProjects(canvases.projects)
    setFolders(filed.folders)
  }, [])

  useEffect(() => {
    void reload().catch(() => { setAssets([]) })
  }, [reload, refreshToken])

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
        actions={pending.length === 0 ? undefined : (          <Menu className="place-picker" title="选择要放到的画布" label={<>放到哪张画布？<span className="caret">▾</span></>}>
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
    </div>
  )
}

