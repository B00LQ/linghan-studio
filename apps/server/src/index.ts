/**
 * Studio HTTP entry point.
 *
 * One process serves the built frontend, the workspace API, the
 * OpenAI-compatible gateway, and the canvas agent bridge. The access gate wraps
 * everything except the login endpoints and static assets, because a
 * self-hosted deployment holds provider credentials server-side.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearSession, clearThrottle, hasSession, issueSession, passwordMatches, throttle } from './auth.ts'
import { createAgentFace } from './agent.ts'
import { createBridge } from './bridge.ts'
import { createStudioRegistry } from './workflow/nodes.ts'
import { createWorkflowRoutes } from './workflow/routes.ts'
import { loadConfig } from './config.ts'
import { loadSiteContent } from './site.ts'
import { createGateway } from './gateway.ts'
import { applyOps, readDocument, writeDocument } from './ops.ts'
import { openStore } from './store.ts'
import { deleteWorkflow, isBuiltIn, loadWorkflows, readWorkflow, saveWorkflow, summarize, updateWorkflow, type StudioWorkflow, type WorkflowBinding, type WorkflowNode } from './workflow-library.ts'
import { makeZip, type ZipEntry } from './zip.ts'

/** Web bundle directory, resolved relative to this file. */
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url))

/** Content types served from the web bundle. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const config = loadConfig()
const store = openStore(config.dataDir)
// 回收站保留 30 天：不设期限的话它会变成第二个「全部项目」。
const expired = store.purgeTrash(30)
if (expired > 0) console.log(`[studio] 回收站清理：${String(expired)} 个超过 30 天的画布已彻底删除`)
const bridge = createBridge((message) => { console.log(`[studio] ${message}`) })
const gateway = createGateway({
  config,
  store,
  log: (message) => { console.log(`[studio] ${message}`) },
  // 生成进度不是「文档变了」，但它走同一条 SSE 通道：画布只需要一条连接。
  // 用 shotId 反查项目，是因为进度属于某个节点（= 某个镜头），不是某次 HTTP 请求。
  onProgress: ({ shotId, progress }) => {
    const shot = store.getShot(shotId)
    if (shot === undefined) return
    bridge.broadcast(shot.projectId, 'generation_progress', { projectId: shot.projectId, shotId, ...progress })
  },
  // 没指定就按顺序取第一套（内置的 z-image），指定了就用用户选的那套。
  resolveWorkflow: (id) => {
    const all = workflowList()
    return id === '' ? all[0] : all.find((workflow) => workflow.id === id)
  },
})

/**
 * 工作流库：内置那套 + 用户自己上传的。
 *
 * 每次请求都重新读目录，因为「刚上传完就能在画布里选中」是这个功能的核心体验，
 * 而让用户重启服务去刷新缓存不是体验。
 */
const builtInWorkflowDir = join(import.meta.dirname, 'comfyui')
const workflowList = (): StudioWorkflow[] => loadWorkflows(config.dataDir, builtInWorkflowDir)

const agent = createAgentFace({
  store,
  gateway,
  onDocumentChanged: (projectId, reason) => { bridge.broadcastDocument(projectId, reason) },
  log: (message) => { console.log(`[studio] ${message}`) },
})
const workflowRegistry = createStudioRegistry({
  renderImage: async (request) => {
    const images = await gateway.renderImage({
      prompt: request.prompt,
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.count === undefined ? {} : { count: request.count }),
    })
    return images.map((image) => ({ url: image.url, assetId: image.assetId }))
  },
  // Assets are content-addressed, so the suggested name has nowhere to live yet;
  // it stays in the signature for providers that do keep filenames.
  saveText: (text, _name) => {
    const asset = store.saveAsset(Buffer.from(text, 'utf8'), 'text/plain', 'text')
    return { assetId: asset.id }
  },
  log: (message) => { console.log(`[studio] ${message}`) },
})
const workflowRoutes = createWorkflowRoutes({
  store,
  registry: workflowRegistry,
  onDocumentChanged: (projectId, reason) => { bridge.broadcastDocument(projectId, reason) },
  log: (message) => { console.log(`[studio] ${message}`) },
})
const secureCookies = process.env.STUDIO_SECURE_COOKIES === '1'

/** Largest upload accepted; the canvas only needs stills and short clips so far. */
const UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024

/** File extension of a stored asset path, for download names. */
function extOf(relPath: string): string {
  return extname(relPath) === '' ? '.bin' : extname(relPath)
}

/**
 * Accept only a real ComfyUI API-format graph.
 *
 * The check is deliberately strict about the *shape* and says why when it fails,
 * because the usual mistake is exporting the UI format (which has `nodes` and
 * `links` and cannot be submitted) rather than `Workflow → Export (API)`.
 * @param value - whatever the client sent.
 * @returns the graph, or null when it is not one.
 */
function parseGraph(value: unknown): Record<string, WorkflowNode> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return null
  const graph: Record<string, WorkflowNode> = {}
  for (const [id, raw] of entries) {
    if (typeof raw !== 'object' || raw === null) return null
    const node = raw as { class_type?: unknown; inputs?: unknown }
    if (typeof node.class_type !== 'string' || node.class_type === '') return null
    if (typeof node.inputs !== 'object' || node.inputs === null) return null
    graph[id] = { class_type: node.class_type, inputs: node.inputs as Record<string, unknown> }
  }
  return graph
}

/** Accept only `{ name: { node, input } }` bindings. */
function parseBindings(value: unknown): Record<string, WorkflowBinding> {
  if (typeof value !== 'object' || value === null) return {}
  const bindings: Record<string, WorkflowBinding> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as { node?: unknown; input?: unknown }
    if (typeof item.node !== 'string' || typeof item.input !== 'string') continue
    if (item.node === '' || item.input === '') continue
    bindings[key] = { node: item.node, input: item.input }
  }
  return bindings
}

/** Send a JSON response. */
function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** Read a request body as text, bounded to 16 MiB. */
async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > 16 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read a request body as bytes, bounded by `limit`. */
async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > limit) throw new Error(`文件过大（上限 ${String(Math.round(limit / 1024 / 1024))} MB）`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Map a MIME type to the asset kind the library stores. */
function kindOfMime(mime: string): string {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'text'
}

/** Parse a JSON object body. */
function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Serve one file from the web bundle, falling back to the SPA entry. */
async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const relative = normalize(pathname).replace(/^([/\\])+/u, '')
  const candidate = resolve(join(WEB_DIST, relative))
  const target = candidate.startsWith(resolve(WEB_DIST)) && extname(candidate) !== '' ? candidate : join(WEB_DIST, 'index.html')
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('未找到前端构建产物，请先运行 pnpm build')
  }
}

/** Whether a path requires an authenticated session. */
function requiresSession(pathname: string): boolean {
  if (pathname === '/api/health' || pathname === '/api/session' || pathname === '/api/login' || pathname === '/api/logout') return false
  return pathname.startsWith('/api/') || pathname.startsWith('/v1/') || pathname.startsWith('/proxy/')
}

/** Reduce a proxied path to the route key the gateway matches on. */
function routeKey(pathname: string): string {
  const proxied = /^\/(?:proxy|v1)(?=\/)(.*)$/u.exec(pathname)
  if (proxied !== null) {
    const rest = proxied[1] as string
    try {
      if (rest.startsWith('http')) return new URL(rest).pathname
    } catch { /* keep the raw remainder */ }
    return `/${rest}`
  }
  return pathname
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://studio.invalid')
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    try {
      if (pathname === '/api/health') {
        json(res, 200, { ok: true, driver: config.imageDriver, clients: bridge.connected() })
        return
      }

      if (pathname === '/api/session') {
        json(res, 200, {
          authenticated: hasSession(req, config.cookieSecret),
          driver: config.imageDriver,
          models: gateway.models(),
          requiresPassword: config.password !== '',
        })
        return
      }

      if (pathname === '/api/login' && method === 'POST') {
        const address = req.socket.remoteAddress ?? 'unknown'
        const body = parseJson(await readText(req))
        const submitted = typeof body.password === 'string' ? body.password : ''
        if (config.password === '') {
          json(res, 200, { authenticated: true, note: '未设置 STUDIO_PASSWORD，登录门已关闭' })
          return
        }
        if (throttle(address)) {
          json(res, 429, { error: '尝试过于频繁，请稍后再试' })
          return
        }
        if (!passwordMatches(submitted, config.password)) {
          json(res, 401, { error: '密码不正确' })
          return
        }
        clearThrottle(address)
        issueSession(res, config.cookieSecret, secureCookies)
        json(res, 200, { authenticated: true })
        return
      }

      if (pathname === '/api/logout' && method === 'POST') {
        clearSession(res)
        json(res, 200, { authenticated: false })
        return
      }

      if (requiresSession(pathname) && !hasSession(req, config.cookieSecret)) {
        json(res, 401, { error: '需要登录' })
        return
      }

      // Canvas agent bridge: the notification channel a watching canvas dials.
      if (pathname.startsWith('/api/agent')) {
        const rest = pathname.replace('/api/agent', '') || '/'
        // The tool face is the second entry point — what an Agent calls instead
        // of clicking. It runs server-side, so it works with no browser open.
        if (rest === '/tools' && method === 'GET') {
          json(res, 200, { tools: agent.tools() })
          return
        }
        if (rest === '/call' && method === 'POST') {
          const body = parseJson(await readText(req))
          const name = typeof body.name === 'string' ? body.name : ''
          const input = typeof body.input === 'object' && body.input !== null ? (body.input as Record<string, unknown>) : {}
          try {
            json(res, 200, { ok: true, result: await agent.call(name, input) })
          } catch (error) {
            // A tool failure is a normal answer an Agent must be able to read and
            // recover from, not a 500.
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (await bridge.handle(req, res, rest, url.searchParams)) return
        json(res, 404, { error: '未知的 bridge 路由' })
        return
      }

      // OpenAI-compatible gateway (also reachable through /proxy for CORS).
      if (pathname.startsWith('/v1/') || pathname.startsWith('/proxy/')) {
        if (await gateway.handle(req, res, routeKey(pathname))) return
        json(res, 404, { error: '未知的网关路由' })
        return
      }

      // Workspace API.
      if (await workflowRoutes.handle(req, res, pathname, method)) return

      if (pathname === '/api/image-backend' && method === 'GET') {
        json(res, 200, await gateway.backend())
        return
      }

      // 生成进度与预计时间：能力由驱动协商（有步进就报步进，没有就退回历史耗时）。
      if (pathname === '/api/generation/stats' && method === 'GET') {
        json(res, 200, {
          driver: config.imageDriver,
          capabilities: gateway.capabilities(),
          estimate: store.generationStats(),
        })
        return
      }
      // 文件夹：画布上的一个标签，不是一个要导航进去的层级。
      if (pathname === '/api/folders' && method === 'GET') {
        json(res, 200, { folders: store.listFolders() })
        return
      }
      if (pathname === '/api/folders' && method === 'POST') {
        const body = parseJson(await readText(req))
        const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : '未命名文件夹'
        json(res, 200, { folder: store.createFolder(name) })
        return
      }
      const folderMatch = /^\/api\/folders\/([^/]+)$/u.exec(pathname)
      if (folderMatch !== null) {
        const folderId = decodeURIComponent(folderMatch[1] as string)
        if (method === 'PATCH') {
          const body = parseJson(await readText(req))
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          if (name === '') {
            json(res, 400, { error: '名字不能为空' })
            return
          }
          if (!store.renameFolder(folderId, name)) {
            json(res, 404, { error: '文件夹不存在' })
            return
          }
          json(res, 200, { folder: store.getFolder(folderId) })
          return
        }
        if (method === 'DELETE') {
          // 删文件夹不删里面的东西：它只是标签，画布会变成「未归档」。
          if (!store.deleteFolder(folderId)) {
            json(res, 404, { error: '文件夹不存在' })
            return
          }
          json(res, 200, { ok: true })
          return
        }
      }

      if (pathname === '/api/projects' && method === 'DELETE') {
        // 整站清空回收站：`DELETE /api/projects?trash=1`。
        const purged = store.purgeTrash()
        console.log(`[studio] trash emptied: ${String(purged)} 个画布`)
        json(res, 200, { ok: true, removed: purged })
        return
      }
      if (pathname === '/api/projects' && method === 'GET') {
        const folderId = url.searchParams.get('folderId')
        const trashed = url.searchParams.get('trash') === '1'
        json(res, 200, {
          projects: store.listProjects({
            ...(folderId === null || folderId === '' ? {} : { folderId }),
            ...(trashed ? { trashed: true } : {}),
          }),
        })
        return
      }
      if (pathname === '/api/projects' && method === 'POST') {
        const body = parseJson(await readText(req))
        const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : '未命名画布'
        const folderId = typeof body.folderId === 'string' && body.folderId !== '' ? body.folderId : undefined
        json(res, 200, { project: store.createProject(name, folderId) })
        return
      }

      const projectMatch = /^\/api\/projects\/([^/]+)$/u.exec(pathname)
      if (projectMatch !== null && method === 'PATCH') {
        const projectId = decodeURIComponent(projectMatch[1] as string)
        const body = parseJson(await readText(req))
        // 一次请求可以只改一件事（名字 / 归属文件夹 / 封面），也可以一起改。
        if (typeof body.name === 'string') {
          const name = body.name.trim()
          if (name === '') {
            json(res, 400, { error: '名字不能为空' })
            return
          }
          if (!store.renameProject(projectId, name)) {
            json(res, 404, { error: '画布不存在' })
            return
          }
        }
        if (typeof body.folderId === 'string') {
          if (!store.moveProject(projectId, body.folderId)) {
            json(res, 404, { error: '画布不存在' })
            return
          }
        }
        if (typeof body.coverAssetId === 'string') {
          if (!store.setProjectCover(projectId, body.coverAssetId)) {
            json(res, 404, { error: '画布不存在' })
            return
          }
        }
        json(res, 200, { project: store.getProject(projectId) })
        return
      }
      if (projectMatch !== null && method === 'DELETE') {
        const projectId = decodeURIComponent(projectMatch[1] as string)
        // 默认是**进回收站**，只有显式 purge=1 才真的删。
        // 「删除项目」是菜单里最容易误点的一项，不该不可撤销。
        const purge = url.searchParams.get('purge') === '1'
        const done = purge ? store.deleteProject(projectId) : store.trashProject(projectId)
        if (!done) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        console.log(`[studio] project ${purge ? 'purged' : 'trashed'}: ${projectId.slice(0, 8)}`)
        json(res, 200, { ok: true })
        return
      }

      const duplicateMatch = /^\/api\/projects\/([^/]+)\/duplicate$/u.exec(pathname)
      if (duplicateMatch !== null && method === 'POST') {
        const projectId = decodeURIComponent(duplicateMatch[1] as string)
        const copy = store.duplicateProject(projectId)
        if (copy === undefined) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        json(res, 200, { project: copy })
        return
      }

      const restoreMatch = /^\/api\/projects\/([^/]+)\/restore$/u.exec(pathname)
      if (restoreMatch !== null && method === 'POST') {
        const projectId = decodeURIComponent(restoreMatch[1] as string)
        if (!store.restoreProject(projectId)) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        json(res, 200, { project: store.getProject(projectId) })
        return
      }

      const canvasMatch = /^\/api\/projects\/([^/]+)\/canvas$/u.exec(pathname)
      if (canvasMatch !== null) {
        const projectId = decodeURIComponent(canvasMatch[1] as string)
        if (store.getProject(projectId) === undefined) {
          json(res, 404, { error: '项目不存在' })
          return
        }
        if (method === 'GET') {
          const raw = store.getCanvas(projectId)
          let doc: unknown = null
          if (raw !== undefined) {
            try { doc = JSON.parse(raw) } catch { doc = null }
          }
          json(res, 200, { doc })
          return
        }
        if (method === 'PUT' || method === 'POST') {
          const body = parseJson(await readText(req))
          store.saveCanvas(projectId, JSON.stringify(body.doc ?? body))
          json(res, 200, { ok: true })
          return
        }
      }

      const shotsMatch = /^\/api\/projects\/([^/]+)\/shots$/u.exec(pathname)
      if (shotsMatch !== null) {
        const projectId = decodeURIComponent(shotsMatch[1] as string)
        if (method === 'GET') {
          json(res, 200, { shots: store.listShots(projectId) })
          return
        }
        if (method === 'POST') {
          const body = parseJson(await readText(req))
          const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : '未命名镜头'
          const prompt = typeof body.prompt === 'string' ? body.prompt : ''
          json(res, 200, { shot: store.addShot(projectId, title, prompt) })
          return
        }
      }

      const takesMatch = /^\/api\/shots\/([^/]+)\/takes$/u.exec(pathname)
      if (takesMatch !== null) {
        const shotId = decodeURIComponent(takesMatch[1] as string)
        if (method === 'GET') {
          json(res, 200, { takes: store.listTakes(shotId) })
          return
        }
        if (method === 'POST') {
          const body = parseJson(await readText(req))
          if (store.getShot(shotId) === undefined) {
            json(res, 404, { error: '镜头不存在' })
            return
          }
          const take = store.addTake({
            shotId,
            providerId: typeof body.providerId === 'string' ? body.providerId : config.imageDriver,
            model: typeof body.model === 'string' ? body.model : '',
            status: typeof body.status === 'string' ? body.status : 'succeeded',
            ...(typeof body.assetId === 'string' ? { assetId: body.assetId } : {}),
            ...(typeof body.error === 'string' ? { error: body.error } : {}),
            ...(typeof body.latencyMs === 'number' ? { latencyMs: body.latencyMs } : {}),
            ...(typeof body.params === 'object' && body.params !== null ? { params: body.params as Record<string, unknown> } : {}),
          })
          json(res, 200, { take })
          return
        }
      }

      // Mark one take as the chosen one for its shot, so the version strip has a
      // single answer to "which one are we using".
      const selectMatch = /^\/api\/shots\/([^/]+)\/select$/u.exec(pathname)
      if (selectMatch !== null && method === 'POST') {
        const shotId = decodeURIComponent(selectMatch[1] as string)
        const body = parseJson(await readText(req))
        const takeId = typeof body.takeId === 'string' ? body.takeId : ''
        if (store.getShot(shotId) === undefined) {
          json(res, 404, { error: '镜头不存在' })
          return
        }
        if (!store.listTakes(shotId).some((take) => take.id === takeId)) {
          json(res, 404, { error: '该镜头下没有这个 take' })
          return
        }
        store.selectTake(shotId, takeId)
        json(res, 200, { ok: true })
        return
      }

      // 站点内容：主页展示区。所有人只读；管理员改 dataDir 下的 site.json 即可更新，
      // 不需要重新构建或发版。将来并入账号服务时，客户端仍然只认这个接口。
      if (pathname === '/api/site' && method === 'GET') {
        json(res, 200, loadSiteContent(config.dataDir, (message) => { console.log(`[studio] ${message}`) }))
        return
      }

      // 工作流库：列出 / 校验 / 保存 / 删除。
      if (pathname === '/api/workflows' && method === 'GET') {
        // 列表顺带报「本机缺什么」：别人下载之后最想知道的就是这个，
        // 而不是打开映射表单才发现少了两个模型。
        const workflows = workflowList()
        const enriched = await Promise.all(workflows.map(async (workflow) => {
          const check = await gateway.checkWorkflow(workflow.graph)
          return {
            ...summarize(workflow),
            missingNodes: check.missingNodes,
            missingModels: check.missingModels.map((item) => item.value),
            offline: check.offline,
          }
        }))
        json(res, 200, { workflows: enriched })
        return
      }
      // 先把图读进来，看它用了哪些节点、缺哪些模型，**再**决定要不要存。
      // 让用户传完才发现跑不了，是把校验做在了最没用的地方。
      if (pathname === '/api/workflows/validate' && method === 'POST') {
        const body = parseJson(await readText(req))
        const graph = parseGraph(body.graph)
        if (graph === null) {
          json(res, 400, { error: '这不是 ComfyUI 的 API 格式工作流。请在 ComfyUI 里用 Workflow → Export (API) 导出，而不是 Save。' })
          return
        }
        json(res, 200, await gateway.checkWorkflow(graph))
        return
      }
      if (pathname === '/api/workflows' && method === 'POST') {
        const body = parseJson(await readText(req))
        const graph = parseGraph(body.graph)
        if (graph === null) {
          json(res, 400, { error: '这不是 ComfyUI 的 API 格式工作流' })
          return
        }
        const bindings = parseBindings(body.bindings)
        const defaults = typeof body.defaults === 'object' && body.defaults !== null ? (body.defaults as Record<string, number | string>) : {}
        const saved = saveWorkflow(config.dataDir, {
          title: typeof body.title === 'string' ? body.title : '',
          graph,
          bindings,
          defaults,
          source: typeof body.source === 'string' && body.source !== '' ? body.source : '上传',
        })
        console.log(`[studio] workflow saved: ${saved.id}（${String(Object.keys(graph).length)} 个节点）`)
        json(res, 200, { workflow: summarize(saved) })
        return
      }
      const workflowMatch = /^\/api\/workflows\/([^/]+)$/u.exec(pathname)
      if (workflowMatch !== null && method === 'GET') {
        // 完整一份（含 graph）：编辑和导出都要它。
        const workflowId = decodeURIComponent(workflowMatch[1] as string)
        const found = readWorkflow(config.dataDir, builtInWorkflowDir, workflowId)
        if (found === undefined) {
          json(res, 404, { error: '工作流不存在' })
          return
        }
        json(res, 200, { workflow: { ...found, builtIn: isBuiltIn(found.id) } })
        return
      }
      if (workflowMatch !== null && method === 'PUT') {
        // 二次修改：只换绑定/默认值/名字，图不动——图是从 ComfyUI 导出来的，通常是对的。
        const workflowId = decodeURIComponent(workflowMatch[1] as string)
        const body = parseJson(await readText(req))
        const updated = updateWorkflow(config.dataDir, workflowId, {
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(body.bindings === undefined ? {} : { bindings: parseBindings(body.bindings) }),
          ...(typeof body.defaults === 'object' && body.defaults !== null ? { defaults: body.defaults as Record<string, number | string> } : {}),
        })
        if (updated === undefined) {
          json(res, 409, { error: '改不了：要么不存在，要么是内置工作流（它是随程序发布的文件）' })
          return
        }
        json(res, 200, { workflow: summarize(updated) })
        return
      }
      if (workflowMatch !== null && method === 'DELETE') {
        const workflowId = decodeURIComponent(workflowMatch[1] as string)
        if (!deleteWorkflow(config.dataDir, workflowId)) {
          json(res, 409, { error: '内置工作流不能删除（它是随程序发布的文件）' })
          return
        }
        json(res, 200, { ok: true })
        return
      }

      // 素材列表：画布的资产浮窗与项目页共用。
      // **必须带上 url**：客户端拿它当 <img src>，少一个字段界面上就是一排空框，
      // 而类型里写着 `url: string`，编译器根本不会提醒。
      if (pathname === '/api/assets' && method === 'GET') {
        const kind = url.searchParams.get('kind')
        const limit = Number(url.searchParams.get('limit') ?? '500')
        json(res, 200, {
          assets: store.listAssets(Number.isFinite(limit) ? Math.min(2000, Math.max(1, limit)) : 500)
            .map((asset) => ({ ...asset, url: `/api/assets/${asset.id}` }))
            .filter((asset) => kind === null || kind === '' || kind === 'all' || asset.mime.startsWith(`${kind}/`)),
        })
        return
      }

      // 批量下载：一次打成一个 zip，而不是甩十个下载让浏览器拦掉。
      if (pathname === '/api/assets/download' && method === 'POST') {
        const body = parseJson(await readText(req))
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
        if (ids.length === 0) {
          json(res, 400, { error: '没有选中任何素材' })
          return
        }
        const entries: ZipEntry[] = []
        for (const id of ids) {
          const asset = store.getAsset(id)
          if (asset === undefined) continue
          try {
            entries.push({ name: `${asset.kind}-${asset.id.slice(0, 8)}${extOf(asset.relPath)}`, bytes: await readFile(store.assetPath(asset)) })
          } catch { /* a missing file is skipped, not fatal */ }
        }
        if (entries.length === 0) {
          json(res, 404, { error: '这些素材都取不到了' })
          return
        }
        const archive = makeZip(entries)
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': String(archive.length),
          'content-disposition': `attachment; filename="studio-assets-${String(Date.now())}.zip"`,
        })
        res.end(archive)
        return
      }

      // 删素材：被画布引用的不许删——删了那张画布上的图就变成裂图。
      const assetDeleteMatch = /^\/api\/assets\/([^/]+)$/u.exec(pathname)
      if (assetDeleteMatch !== null && method === 'DELETE') {
        const assetId = decodeURIComponent(assetDeleteMatch[1] as string)
        if (store.getAsset(assetId) === undefined) {
          json(res, 404, { error: '素材不存在' })
          return
        }
        if (store.assetInUse(assetId)) {
          // 409 而不是 400：请求没问题，是当前状态不允许。
          json(res, 409, { error: '还有画布在用这个素材，先从画布上删掉那张图' })
          return
        }
        store.deleteAsset(assetId)
        json(res, 200, { ok: true })
        return
      }

      // 把素材放到某张画布上（资产页没有画布上下文，所以要显式指定）。
      const placeMatch = /^\/api\/projects\/([^/]+)\/place$/u.exec(pathname)
      if (placeMatch !== null && method === 'POST') {
        const projectId = decodeURIComponent(placeMatch[1] as string)
        if (store.getProject(projectId) === undefined) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        const body = parseJson(await readText(req))
        const ids = (Array.isArray(body.ids) ? body.ids : [])
          .filter((id): id is string => typeof id === 'string')
          .filter((id) => store.getAsset(id) !== undefined)
        if (ids.length === 0) {
          json(res, 400, { error: '没有可放的素材' })
          return
        }
        // 一次 applyOps 放完：网格排布，一次放十张不会叠成一摞。
        const doc = readDocument(store, projectId)
        applyOps(doc, ids.map((id, index) => ({
          type: 'add_node' as const,
          kind: 'image' as const,
          text: '来自素材库',
          url: `/api/assets/${id}`,
          x: 460 + (index % 3) * 360,
          y: Math.floor(index / 3) * 470,
        })))
        writeDocument(store, projectId, doc)
        bridge.broadcastDocument(projectId, 'place-assets')
        json(res, 200, { ok: true, placed: ids.length })
        return
      }
      // 内容寻址存储会把相同字节去重，所以重复上传同一张图不会占用额外空间。
      if (pathname === '/api/assets' && method === 'POST') {
        const mime = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''
        if (mime === '' || mime === 'application/octet-stream') {
          json(res, 400, { error: '缺少 content-type，无法判断素材类型' })
          return
        }
        try {
          const bytes = await readBytes(req, UPLOAD_LIMIT_BYTES)
          if (bytes.length === 0) {
            json(res, 400, { error: '文件是空的' })
            return
          }
          const asset = store.saveAsset(bytes, mime, kindOfMime(mime))
          console.log(`[studio] upload: ${asset.kind} ${String(bytes.length)} bytes -> ${asset.id.slice(0, 8)}`)
          json(res, 200, { asset: { id: asset.id, kind: asset.kind, mime: asset.mime, bytes: asset.bytes, url: `/api/assets/${asset.id}` } })
        } catch (error) {
          json(res, 413, { error: error instanceof Error ? error.message : '上传失败' })
        }
        return
      }

      const assetMatch = /^\/api\/assets\/([^/]+)$/u.exec(pathname)
      if (assetMatch !== null && method === 'GET') {
        const asset = store.getAsset(decodeURIComponent(assetMatch[1] as string))
        if (asset === undefined) {
          json(res, 404, { error: '素材不存在' })
          return
        }
        try {
          const body = await readFile(store.assetPath(asset))
          res.writeHead(200, { 'content-type': asset.mime, 'cache-control': 'public, max-age=31536000, immutable' })
          res.end(body)
        } catch {
          json(res, 404, { error: '素材文件缺失' })
        }
        return
      }

      if (method === 'GET' || method === 'HEAD') {
        await serveStatic(res, pathname)
        return
      }

      json(res, 404, { error: `未知路由 ${method} ${pathname}` })
    } catch (error) {
      console.error('[studio] request failed:', error)
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      else res.end()
    }
  })()
})

server.listen(config.port, config.host, () => {
  console.log(`[studio] listening on http://${config.host}:${String(config.port)}`)
  console.log(`[studio] data dir: ${config.dataDir}`)
  console.log(`[studio] image driver: ${config.imageDriver}${config.password === '' ? '  ⚠ 未设置 STUDIO_PASSWORD，登录门已关闭' : ''}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    bridge.close()
    store.close()
    server.close(() => { process.exit(0) })
  })
}
