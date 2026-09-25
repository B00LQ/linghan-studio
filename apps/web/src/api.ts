/** Minimal typed client for the Studio server API. */

/** Session probe result. */
export interface SessionInfo {
  authenticated: boolean
  driver: string
  models: { id: string; capability: string }[]
  requiresPassword: boolean
}

/**
 * A folder: a label you can put on a canvas and filter by.
 *
 * Not a tier you navigate — the canvas page never mentions it. This is what the
 * reference product's 「移动至文件夹」 moves a project into.
 */
export interface FolderInfo {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** How many live canvases it holds. */
  canvasCount: number
}

/** A creation project: one canvas. */
export interface ProjectInfo {
  id: string
  name: string
  /** Owning folder id; empty means "no folder". */
  folderId: string
  /** Cover asset id, or empty to fall back to the placeholder. */
  coverAssetId: string
  /** Set while the canvas sits in the trash. */
  deletedAt: string
  /**
   * Which asset to draw on the card: the chosen cover, or a random picture from
   * inside the canvas. Empty when the canvas has no picture yet.
   */
  previewAssetId: string
  createdAt: string
  updatedAt: string
}

/** One canvas document as the server stores it. */
export interface CanvasDoc {
  nodes: unknown[]
  edges: unknown[]
  viewport: { x: number; y: number; zoom: number }
  /**
   * Node ids the operator handed to the Agent as context.
   *
   * It lives in the document because it is part of the work, not part of the
   * view: an Agent reading the canvas should see exactly what the human pointed
   * at, on any device.
   */
  agentContext?: string[]
}

/** One generated image reference. */
export interface GeneratedImage {
  url: string
  /** Take recorded for this image, when the request named a shot. */
  takeId?: string
}

/** One shot: the thing a canvas generation config node stands for. */
export interface ShotInfo {
  id: string
  projectId: string
  index: number
  title: string
  prompt: string
  status: string
  selectedTakeId: string
}

/** One generation attempt recorded against a shot. */
export interface TakeInfo {
  id: string
  shotId: string
  providerId: string
  model: string
  status: string
  assetId: string
  params: Record<string, unknown>
  seed?: number
  latencyMs?: number
  error?: string
  mark: 'none' | 'selected'
  createdAt: string
}

/** One capability entry on the home page. */
export interface SiteCapability {
  id: string
  title: string
  description: string
  status: 'ready' | 'planned'
}

/** The site document served by `GET /api/site` (home-page showcase area). */
export interface SiteContent {
  brand: { name: string; tagline: string }
  capabilities: SiteCapability[]
  highlights: { id: string; title: string; body: string }[]
  showcase: {
    categories: { id: string; title: string }[]
    items: { id: string; title: string; author?: string; image?: string; category: string }[]
  }
}

/** What the active image driver can promise about progress, and what history says. */
export interface GenerationStats {
  /** Active driver id. */
  driver: string
  /** Negotiated capability: `steps` when real step progress arrives. */
  capabilities: { progress: 'steps' | 'none' }
  /** Durations learned from this machine's own successful runs. */
  estimate: {
    samples: number
    medianMs: number
    p90Ms: number
    recentMs: number[]
    /**
     * The same numbers split by what came out, because one median over both is
     * wrong for both: a 5 秒视频 takes minutes and a picture takes seconds.
     */
    byKind: Record<string, { samples: number; medianMs: number; p90Ms: number }>
    /**
     * 再按 `kind/workflow` 分一层，键如 `video/minimax-h3-video-fast`。
     *
     * 同一个视频节点换一套工作流，耗时能差近一倍（8 步 vs 4 步），只按类型分档会
     * 让两边的样本混在一起、对两边都偏。样本不够时按 `byKind` 退，而不是拿别档冒充。
     */
    byWorkflow: Record<string, { samples: number; medianMs: number; p90Ms: number }>
  }
}

/** Read progress capability and the historical duration estimate. */
export const fetchGenerationStats = (): Promise<GenerationStats> => request<GenerationStats>('/api/generation/stats')

/** What a stored workflow produces. */
export type WorkflowCapability = 'image' | 'video'

/** Where a render job is in its life. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** One render job as the server reports it. */
export interface StudioJob {
  id: string
  request: {
    projectId: string
    nodeId: string
    prompt: string
    size?: string
    count?: number
    workflowId?: string
    duration?: number
    shotId?: string
  }
  status: JobStatus
  createdAt: number
  startedAt: number
  finishedAt: number
  /** Driver progress reports, forwarded verbatim. */
  progress?: { stage?: string; value?: number; max?: number }
  /** Produced files, on success. */
  files?: { url: string; assetId: string; takeId?: string }[]
  /** Node's version count after the render. */
  takes?: number
  /** Shot the takes were recorded against (created on submit when absent). */
  shotId?: string
  error?: string
  /** 需要额外告诉人的事（例如「取消晚了一步，结果留下了」）。 */
  note?: string
}

/**
 * Submit a render and return immediately.
 *
 * The whole point: an 11 分钟 video must not be an 11 分钟 HTTP request. Node's
 * `fetch` gives up after 5 分钟, nginx after 60 秒, and the caller's failure would
 * say nothing about work that is still running.
 */
export const submitJob = (input: {
  projectId: string
  nodeId: string
  prompt: string
  size?: string
  count?: number
  workflowId?: string
  duration?: number
  shotId?: string
}): Promise<{ job: StudioJob }> =>
  request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      projectId: input.projectId,
      nodeId: input.nodeId,
      prompt: input.prompt,
      ...(input.size === undefined ? {} : { size: input.size }),
      ...(input.count === undefined ? {} : { count: input.count }),
      ...(input.workflowId === undefined ? {} : { workflow: input.workflowId }),
      ...(input.duration === undefined ? {} : { duration: input.duration }),
      ...(input.shotId === undefined ? {} : { shotId: input.shotId }),
    }),
  })

/** One job by id. */
export const getJob = (jobId: string): Promise<{ job: StudioJob }> =>
  request(`/api/jobs/${encodeURIComponent(jobId)}`)

/** Jobs that have not finished — what a reloaded canvas re-attaches to. */
export const listJobs = (projectId: string): Promise<{ jobs: StudioJob[] }> =>
  request(`/api/jobs?projectId=${encodeURIComponent(projectId)}`)

/** Ask for a job to stop. Refused (409) once it has finished. */
export const cancelJob = (jobId: string): Promise<{ ok: boolean; job: StudioJob }> =>
  request(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })

/** One workflow as the list shows it. */
export interface WorkflowInfo {
  id: string
  title: string
  capability: WorkflowCapability
  builtIn: boolean
  source: string
  classes: string[]
  models: string[]
  /** Whether the prompt binding is set; without it the workflow cannot run. */
  ready: boolean
  /** Node classes this machine's ComfyUI does not have. */
  missingNodes: string[]
  /** Model files this machine does not have. */
  missingModels: string[]
  /** True when the active driver cannot run ComfyUI graphs at all. */
  offline: boolean
  /**
   * 必须接上的输入（端口 id，如 `ref`）。
   *
   * 画布拿它做两件事：没接就别默认选这套（接了参考图却还用着文生图，等于白连），
   * 以及生成前拦一道、给人话（而不是跑出一张和参考图无关的图）。
   */
  requires: string[]
}

/** Where one logical value goes in a workflow's graph. */
export interface WorkflowBinding {
  node: string
  input: string
}

/** One editable input found in an uploaded graph. */
export interface WorkflowCandidate {
  node: string
  input: string
  classType: string
  value: unknown
}

/** What validation reports about an uploaded graph. */
export interface WorkflowVerdict {
  classes: string[]
  missingNodes: string[]
  missingModels: { node: string; input: string; value: string }[]
  suggested: Record<string, WorkflowBinding>
  models: Record<string, { node: string; input: string; value: string }>
  candidates: WorkflowCandidate[]
  /** True when the active driver cannot run ComfyUI graphs at all. */
  offline: boolean
  note: string
}

/** List stored workflows. */
export const listWorkflows = (): Promise<{ workflows: WorkflowInfo[] }> => request('/api/workflows')

/** Validate an uploaded graph before saving it. */
export const validateWorkflow = (graph: unknown): Promise<WorkflowVerdict> =>
  request('/api/workflows/validate', { method: 'POST', body: JSON.stringify({ graph }) })

/** Save an uploaded workflow. */
export const saveWorkflow = (input: {
  title: string
  graph: unknown
  bindings: Record<string, WorkflowBinding>
  defaults?: Record<string, number | string>
}): Promise<{ workflow: WorkflowInfo }> =>
  request('/api/workflows', { method: 'POST', body: JSON.stringify(input) })

/** One workflow in full, including its graph — what editing and export need. */
export interface WorkflowDetail {
  id: string
  title: string
  capability: WorkflowCapability
  source: string
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  bindings: Record<string, WorkflowBinding>
  defaults: Record<string, number | string>
  builtIn: boolean
}

/** Read one workflow in full. */
export const getWorkflow = (workflowId: string): Promise<{ workflow: WorkflowDetail }> =>
  request(`/api/workflows/${encodeURIComponent(workflowId)}`)

/** Change an uploaded workflow's name, mapping or defaults. The graph stays. */
export const updateWorkflow = (workflowId: string, patch: {
  title?: string
  bindings?: Record<string, WorkflowBinding>
  defaults?: Record<string, number | string>
}): Promise<{ workflow: WorkflowInfo }> =>
  request(`/api/workflows/${encodeURIComponent(workflowId)}`, { method: 'PUT', body: JSON.stringify(patch) })

/** Delete an uploaded workflow. Built-ins are shipped files and cannot go. */
export const deleteWorkflow = (workflowId: string): Promise<{ ok: boolean }> =>
  request(`/api/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' })

/** Read the site content; served read-only and updated by the operator. */
export const fetchSite = (): Promise<SiteContent> => request<SiteContent>('/api/site')

/** Send a request and surface server-side error text. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  const payload = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  if (!response.ok) {
    const error = payload.error
    throw new Error(typeof error === 'string' ? error : `请求失败（HTTP ${String(response.status)}）`)
  }
  return payload as T
}

/** Probe the session. */
export const fetchSession = (): Promise<SessionInfo> => request<SessionInfo>('/api/session')

/** Exchange the deployment password for a session cookie. */
export const login = (password: string): Promise<{ authenticated: boolean }> =>
  request('/api/login', { method: 'POST', body: JSON.stringify({ password }) })

/** Clear the session. */
export const logout = (): Promise<{ authenticated: boolean }> => request('/api/logout', { method: 'POST' })

/** List folders, oldest first. */
export const listFolders = (): Promise<{ folders: FolderInfo[] }> => request('/api/folders')

/** Create a folder. */
export const createFolder = (name: string): Promise<{ folder: FolderInfo }> =>
  request('/api/folders', { method: 'POST', body: JSON.stringify({ name }) })

/** Rename a folder. */
export const renameFolder = (folderId: string, name: string): Promise<{ folder: FolderInfo }> =>
  request(`/api/folders/${encodeURIComponent(folderId)}`, { method: 'PATCH', body: JSON.stringify({ name }) })

/** Delete a folder. Its canvases survive and become unfiled. */
export const deleteFolder = (folderId: string): Promise<{ ok: boolean }> =>
  request(`/api/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' })

/** List canvases, newest first; narrow by folder, or read the trash. */
export const listProjects = (options: { folderId?: string; trashed?: boolean } = {}): Promise<{ projects: ProjectInfo[] }> => {
  const query = new URLSearchParams()
  if (options.folderId !== undefined && options.folderId !== '') query.set('folderId', options.folderId)
  if (options.trashed === true) query.set('trash', '1')
  const suffix = query.toString()
  return request(`/api/projects${suffix === '' ? '' : `?${suffix}`}`)
}

/** Create a canvas, optionally filed in a folder. */
export const createProject = (name: string, folderId?: string): Promise<{ project: ProjectInfo }> =>
  request('/api/projects', { method: 'POST', body: JSON.stringify({ name, ...(folderId === undefined ? {} : { folderId }) }) })

/** Rename a canvas. */
export const renameProject = (projectId: string, name: string): Promise<{ project: ProjectInfo }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ name }) })

/** Move a canvas into a folder (empty string unfiles it). */
export const moveProject = (projectId: string, folderId: string): Promise<{ project: ProjectInfo }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ folderId }) })

/** Set which asset is the canvas's cover (empty string clears it). */
export const setProjectCover = (projectId: string, coverAssetId: string): Promise<{ project: ProjectInfo }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ coverAssetId }) })

/** Copy a canvas: same document, fresh node identities, no generation history. */
export const duplicateProject = (projectId: string): Promise<{ project: ProjectInfo }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/duplicate`, { method: 'POST' })

/** Move a canvas to the trash. */
export const trashProject = (projectId: string): Promise<{ ok: boolean }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })

/** Take a canvas back out of the trash. */
export const restoreProject = (projectId: string): Promise<{ project: ProjectInfo }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/restore`, { method: 'POST' })

/** Delete a canvas for good. Only offered from the trash. */
export const purgeProject = (projectId: string): Promise<{ ok: boolean }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: 'DELETE' })

/** Empty the trash. The server also drops anything older than 30 days on start. */
export const emptyTrash = (): Promise<{ ok: boolean; removed: number }> =>
  request('/api/projects?trash=1', { method: 'DELETE' })

/**
 * Download a set of assets as one archive.
 *
 * One file rather than N downloads: browsers block the second and third
 * programmatic download, so "download these ten" would silently give you one.
 * @param ids - asset ids to include.
 */
export const downloadAssets = async (ids: string[]): Promise<void> => {
  const response = await fetch('/api/assets/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!response.ok) {
    const text = await response.text()
    let message = `打包失败（HTTP ${String(response.status)}）`
    try {
      const payload = JSON.parse(text) as { error?: unknown }
      if (typeof payload.error === 'string') message = payload.error
    } catch { /* keep the generic message */ }
    throw new Error(message)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `studio-assets-${String(Date.now())}.zip`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}

/** Delete one asset. Refused while a canvas still shows it. */
export const deleteAsset = (assetId: string): Promise<{ ok: boolean }> =>
  request(`/api/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' })

/** Put assets onto a canvas as picture nodes. */
export const placeAssets = (projectId: string, ids: string[]): Promise<{ ok: boolean; placed: number }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/place`, { method: 'POST', body: JSON.stringify({ ids }) })

/** Read one project's canvas. */
export const loadCanvas = (projectId: string): Promise<{ doc: CanvasDoc | null }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/canvas`)

/** Write one project's canvas. */
export const saveCanvas = (projectId: string, doc: CanvasDoc): Promise<{ ok: boolean }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/canvas`, { method: 'PUT', body: JSON.stringify({ doc }) })

/** Create a shot — the canvas calls this the first time a config node generates. */
export const createShot = (projectId: string, title: string, prompt: string): Promise<{ shot: ShotInfo }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/shots`, {
    method: 'POST',
    body: JSON.stringify({ title, prompt }),
  })

/** List a shot's takes, newest first. */
export const listTakes = (shotId: string): Promise<{ takes: TakeInfo[] }> =>
  request(`/api/shots/${encodeURIComponent(shotId)}/takes`)

/** Mark one take as the chosen one for its shot. */
export const selectTake = (shotId: string, takeId: string): Promise<{ ok: boolean }> =>
  request(`/api/shots/${encodeURIComponent(shotId)}/select`, {
    method: 'POST',
    body: JSON.stringify({ takeId }),
  })

/**
 * Record an already-produced picture as a take of a shot.
 *
 * Used for pictures that did not come from a model — a crop or a rotation. They
 * belong in the version strip like any other version, for two reasons: the
 * original stays reachable, and 「这一版我是裁过的」 does not become an invisible
 * fact that the next person has to guess from the picture.
 * @param shotId - the shot this picture is a version of.
 * @param assetId - stored picture to record.
 * @param note - what was done to it, shown in the version strip's tooltip.
 * @returns the created take.
 */
export const addTake = (shotId: string, assetId: string, note: string): Promise<{ take: TakeInfo }> =>
  request(`/api/shots/${encodeURIComponent(shotId)}/takes`, {
    method: 'POST',
    body: JSON.stringify({
      assetId,
      providerId: 'studio-edit',
      model: note,
      status: 'succeeded',
      params: { edit: note },
      latencyMs: 0,
    }),
  })

/** One stored asset as the server describes it. */
export interface AssetInfo {
  id: string
  kind: string
  mime: string
  bytes: number
  url: string
}

/** List stored assets, newest first. */
export const listAssets = (): Promise<{ assets: (AssetInfo & { createdAt: string })[] }> => request('/api/assets')

/**
 * Upload bytes into the project's asset library.
 *
 * The body is the file itself rather than multipart: the server stores bytes by
 * content hash, so there is no filename or form field worth encoding.
 *
 * Takes a `Blob` rather than a `File` because not every asset comes from a file
 * picker — a cropped or rotated picture is produced in the browser and has no
 * name until the server gives it a content hash.
 * @param file - file chosen by the operator, or bytes produced in the browser.
 * @returns the stored asset.
 */
export const uploadAsset = async (file: Blob): Promise<{ asset: AssetInfo }> => {
  const response = await fetch('/api/assets', {
    method: 'POST',
    headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
    body: file,
  })
  const text = await response.text()
  const payload = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  if (!response.ok) {
    const error = payload.error
    throw new Error(typeof error === 'string' ? error : `上传失败（HTTP ${String(response.status)}）`)
  }
  return payload as { asset: AssetInfo }
}

/**
 * Generate through the Studio gateway.
 *
 * One call for both media: which one comes back is decided by the workflow the
 * node picked (`capability`), not by the endpoint — the same node → gateway →
 * driver path that made 「Agent 画的」and「人画的」indistinguishable.
 */
export const generateImages = (input: { prompt: string; size?: string; count?: number; shotId?: string; workflowId?: string; duration?: number }): Promise<{ data: GeneratedImage[] }> =>
  request('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({
      model: 'studio-image',
      prompt: input.prompt,
      n: input.count ?? 1,
      ...(input.size === undefined ? {} : { size: input.size }),
      // Naming the shot is what turns a generation into a recorded take.
      ...(input.shotId === undefined || input.shotId === '' ? {} : { shotId: input.shotId }),
      // Which stored workflow to run; the server uses its default when empty.
      ...(input.workflowId === undefined || input.workflowId === '' ? {} : { workflow: input.workflowId }),
      // Clip length in seconds; only video workflows have a $duration to fill.
      ...(input.duration === undefined ? {} : { duration: input.duration }),
    }),
  })
