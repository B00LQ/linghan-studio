/** Minimal typed client for the Studio server API. */

/** Session probe result. */
export interface SessionInfo {
  authenticated: boolean
  driver: string
  models: { id: string; capability: string }[]
  requiresPassword: boolean
  /** 首启向导要不要出现（还没设密码、也没点过「以后再说」）。 */
  setupNeeded?: boolean
  /** 运行中的版本。 */
  version?: string
  /** 数据目录；只在首启向导里给（那时还没登录，也没什么可藏的）。 */
  dataDir?: string
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

/** What the text backend is. */
export interface TextBackendInfo {
  driver: string
  model: string
  /** false = 没配模型，文本节点会给出理由而不是假装能写。 */
  configured: boolean
  /** 给操作者看的一句话。 */
  note: string
}

/**
 * 文本后端是什么。
 *
 * 和 `/api/image-backend` 对称：画布据此决定文本节点的 ↑ 能不能按、以及按不下去时
 * 该说什么。**不能写死**「未配置」—— 配了 key 的机器上那句话就成了假话。
 */
export const fetchTextBackend = (): Promise<TextBackendInfo> => request<TextBackendInfo>('/api/text-backend')

/** 音频后端：形状和文本那份一模一样（driver/model/configured/note）。 */
export const fetchAudioBackend = (): Promise<TextBackendInfo> => request<TextBackendInfo>('/api/audio-backend')

/** What a stored workflow produces. */
export type WorkflowCapability = 'image' | 'video' | 'video-edit'

/** Where a render job is in its life. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** One render job as the server reports it. */
export interface StudioJob {
  id: string
  request: {
    /** `text` / `audio` = 交给对应后端，别的都是 ComfyUI 渲染。 */
    kind?: 'render' | 'text' | 'audio'
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
  /**
   * 产出的文本（`kind: 'text'` 的作业才有）。
   *
   * 文本没有「素材」「版本」那套 —— 它不是文件，所以结果直接带在作业里。
   */
  text?: string
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
  /** 非提示词、非尺寸的取值（裁切的 start…），直接当工作流占位符的值用。 */
  params?: Record<string, number | string>
  /** `text` / `audio` = 交给对应的后端（LLM / 语音模型）；省略就是 ComfyUI 渲染。 */
  kind?: 'text' | 'audio'
  /**
   * 固定种子（复现某一版时带上）。省略就随机。
   *
   * **必须显式写进请求体**：只写进类型是不够的 —— 这个字段曾经因此被静默丢掉，
   * 而「复现这一版」看起来一切正常（同提示词、同工作流），只是抽出了另一张。
   */
  seed?: number
}): Promise<{ job: StudioJob }> =>
  request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      projectId: input.projectId,
      nodeId: input.nodeId,
      prompt: input.prompt,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      ...(input.size === undefined ? {} : { size: input.size }),
      ...(input.count === undefined ? {} : { count: input.count }),
      ...(input.workflowId === undefined ? {} : { workflow: input.workflowId }),
      ...(input.duration === undefined ? {} : { duration: input.duration }),
      ...(input.shotId === undefined ? {} : { shotId: input.shotId }),
      ...(input.params === undefined ? {} : { params: input.params }),
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
  /**
   * 这套工作流要不要提示词。剪辑/拼接不要（它们不生成画面，只裁/接），
   * 画布据此决定「提示词为空」算不算错误。
   */
  needsPrompt: boolean
  /** 采样步数（工作流 defaults 里写了才有）。版本条与下拉都要用它说「这一版几步出的」。 */
  steps?: number
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

/**
 * 首启向导：一次把这台部署配起来。
 *
 * 这是**唯一一个不用登录就能写的接口** —— 设密码这件事本身需要一个还没上锁的入口。
 * 配过一次（设了密码、或点过「以后再说」）之后它就永久 403，免得变成后门。
 * @param input - 密码（空 = 先不设，仍然开放）与设置页那些键的初值。
 */
export const submitSetup = (input: { password: string; values?: Record<string, string> }): Promise<{ ok: boolean; passwordSet: boolean; driver: string }> =>
  request('/api/setup', { method: 'POST', body: JSON.stringify(input) })

/** 更新源里那一版。 */
export interface UpdateManifestInfo {
  version: string
  url: string
  sha256: string
  notes?: string
}

/** 「有没有新版、能不能自助装」的答案。 */
export interface UpdateState {
  current: string
  latest: string
  available: boolean
  url: string
  notes: string
  configured: boolean
  error: string
  /** 绿色包（有 `current.txt` 指针）才能自助更新；Docker / 源码运行不能。 */
  selfUpdate: boolean
  /** 绿色包根目录；不是绿色包时是空串。 */
  home: string
  /** 已经装了哪些版本。 */
  installed: string[]
  manifest?: UpdateManifestInfo
}

/** 问更新源有没有新版（只读，不改磁盘）。 */
export const fetchUpdate = (): Promise<UpdateState> => request('/api/update')

/** 装最新版。装完要重启才生效 —— 正在跑的进程替换不了自己。 */
export const applyUpdate = (): Promise<{ ok: boolean; version: string; files: number; bytes: number; note: string }> =>
  request('/api/update/apply', { method: 'POST' })

/**
 * 一张素材的小图地址。
 *
 * 服务端现做缩略图（只认 PNG；其它格式回 404），所以**调用方要在 onError 里退回原图** ——
 * 缩略图是优化，不是功能。素材是内容寻址的，同一张图的缩略图永远一样，可以长期缓存。
 * @param assetId - asset to preview.
 * @param size - 长边上限（服务端会夹到 64…640）。
 * @returns the URL.
 */
export const thumbUrl = (assetId: string, size = 320): string =>
  `/api/assets/${encodeURIComponent(assetId)}/thumb?w=${String(size)}`

/** 一个可设置字段的当前状态（服务端 config.ts 的 SettingView）。 */
export interface SettingField {
  /** 环境变量名，也是提交时的键。 */
  key: string
  label: string
  group: 'image' | 'text' | 'audio' | 'update'
  secret?: boolean
  hint?: string
  placeholder?: string
  /** 非机密字段回显的值；机密字段永远是空串（不回显）。 */
  value: string
  /** 有没有值（机密字段靠它显示「已配置」）。 */
  set: boolean
  /** 这个值从哪来。 */
  source: 'settings' | 'env' | 'default'
  /** 环境变量里也有一份。 */
  fromEnv: boolean
}

/** 设置页需要的全部状态。 */
export interface SettingsState {
  settings: SettingField[]
  /** 数据目录与端口是只读展示：改它们要重启，界面上说明白。 */
  dataDir: string
  port: number
  passwordSet: boolean
}

export const fetchSettings = (): Promise<SettingsState> => request<SettingsState>('/api/settings')

/**
 * 写设置。空串 = 清掉这条覆盖（退回环境变量/默认）。
 * @param values - 只提交**改动过**的键。
 * @returns 新的状态，以及这次实际写进去的键。
 */
export const saveSettings = (values: Record<string, string>): Promise<SettingsState & { saved: string[] }> =>
  request<SettingsState & { saved: string[] }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ values }),
  })

/** 「测一下」的结果。 */
export interface BackendTest {
  target: string
  ok: boolean
  detail?: string
  driver?: string
  problems?: string[]
  note?: string
}

/**
 * 测一个后端通不通。
 *
 * 文本/音频只问「有哪些模型」，不真生成 —— 在设置页上点一下不该花人的钱。
 * @param target - which backend to probe.
 * @returns the verdict.
 */
export const testBackend = (target: 'image' | 'text' | 'audio'): Promise<BackendTest> =>
  request<BackendTest>('/api/settings/test', { method: 'POST', body: JSON.stringify({ target }) })

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

/**
 * 把一条版本换成另一张素材（连续同一种编辑时「改这一版」）。
 *
 * 换下来的那张图如果没人再引用，服务端会顺手删掉 —— 连续旋转的中间态不该堆在素材库里。
 * @param shotId - the shot the version belongs to.
 * @param takeId - the version to change.
 * @param assetId - the asset it should point at.
 * @returns the updated take.
 */
export const replaceTakeAsset = (shotId: string, takeId: string, assetId: string): Promise<{ take: TakeInfo }> =>
  request(`/api/shots/${encodeURIComponent(shotId)}/takes/${encodeURIComponent(takeId)}/asset`, {
    method: 'POST',
    body: JSON.stringify({ assetId }),
  })

/** One stored asset as the server describes it. */
export interface AssetInfo {
  id: string
  kind: string
  mime: string
  bytes: number
  url: string
  /** Owning asset folder id; empty means 未分组. */
  folderId?: string
}

/** One asset folder, with how many assets are in it. */
export interface AssetFolderInfo {
  id: string
  name: string
  createdAt: string
  assetCount: number
}

/** List stored assets, newest first. */
export const listAssets = (): Promise<{ assets: (AssetInfo & { createdAt: string })[] }> => request('/api/assets')

/** List asset folders (labels, not containers — deleting one keeps its assets). */
export const listAssetFolders = (): Promise<{ folders: AssetFolderInfo[] }> => request('/api/asset-folders')

/** Create an asset folder. The server refuses a name that is already taken. */
export const createAssetFolder = (name: string): Promise<{ folder: AssetFolderInfo }> =>
  request('/api/asset-folders', { method: 'POST', body: JSON.stringify({ name }) })

/** Rename an asset folder. */
export const renameAssetFolder = (folderId: string, name: string): Promise<{ folder: AssetFolderInfo }> =>
  request(`/api/asset-folders/${encodeURIComponent(folderId)}`, { method: 'PATCH', body: JSON.stringify({ name }) })

/**
 * Delete an asset folder.
 * @returns how many assets were sent back to 未分组 (they are **not** deleted).
 */
export const deleteAssetFolder = (folderId: string): Promise<{ ok: boolean; unfiled: number }> =>
  request(`/api/asset-folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' })

/**
 * Move assets into a folder.
 * @param folderId - target folder, or empty string to send them back to 未分组.
 */
export const moveAssets = (ids: string[], folderId: string): Promise<{ ok: boolean; moved: number }> =>
  request('/api/assets/move', { method: 'POST', body: JSON.stringify({ ids, folderId }) })

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
