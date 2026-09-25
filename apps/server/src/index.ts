/**
 * Studio HTTP entry point.
 *
 * One process serves the built frontend, the workspace API, the
 * OpenAI-compatible gateway, and the canvas agent bridge. The access gate wraps
 * everything except the login endpoints and static assets, because a
 * self-hosted deployment holds provider credentials server-side.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearSession, clearThrottle, clearUserCookie, hasSession, issueSession, issueUserCookie, passwordMatches, readUserToken, throttle } from './auth.ts'
import { createAgentFace } from './agent.ts'
import { createBridge } from './bridge.ts'
import { createStudioRegistry } from './workflow/nodes.ts'
import { createWorkflowRoutes } from './workflow/routes.ts'
import { loadConfig, SETTINGS, settingsView } from './config.ts'
import { thumbnail } from './png.ts'
import { loadSiteContent } from './site.ts'
import { createGateway } from './gateway.ts'
import { createJobRegistry } from './jobs.ts'
import { createTextBackend } from './text.ts'
import { createAudioBackend } from './audio.ts'
import { createAccounts, createConsoleMailer, createWebhookMailer } from './accounts.ts'
import { applyPendingRestore, createBackups } from './backup.ts'
import { applyGeneration, applyOps, applyText, inboundAssetUrl, readDocument, writeDocument } from './ops.ts'
import { openStore } from './store.ts'
import { deleteWorkflow, isBuiltIn, loadWorkflows, readWorkflow, resetWorkflow, saveWorkflow, summarize, updateWorkflow, type StudioWorkflow, type WorkflowBinding, type WorkflowNode } from './workflow-library.ts'
import { makeZip, type ZipEntry } from './zip.ts'
import { applyUpdate, checkForUpdate, installedVersions, isPortableHome, runningVersion } from './update.ts'

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

/**
 * 配置分三层：**设置页 → 环境变量 → 内置默认**。
 *
 * 存储要用的数据目录只能先按环境变量定；拿到 store 之后再把设置页的覆盖值叠上去，
 * 所以这里是「先开库、再重解析」。`previous` 传进去是为了沿用同一个 cookie 密钥 ——
 * 否则改一次设置就把所有人踢下线。
 */
const baseConfig = loadConfig()
/** 这次启动是不是「刚从备份恢复」——界面要为此说一句话。 */
let restoredFromBackup = false
// **必须在打开数据库之前**应用「待恢复」的快照（见 backup.ts 的说明）。
if (applyPendingRestore(baseConfig.dataDir, (message) => { console.log(`[studio] ${message}`) })) {
  restoredFromBackup = true
}
const store = openStore(baseConfig.dataDir)
/** 设置页写下来的覆盖值；改一次就重新读一遍（后端每次调用都会重新解析配置）。 */
let settings = store.getSettings()
const config = loadConfig(settings, baseConfig)
// 回收站保留 30 天：不设期限的话它会变成第二个「全部项目」。
const expired = store.purgeTrash(30)
if (expired > 0) console.log(`[studio] 回收站清理：${String(expired)} 个超过 30 天的画布已彻底删除`)

/**
 * 首启向导要不要出现。
 *
 * 判据是「这台部署还没被人配置过」：没设密码，而且没人点过「以后再说」。
 * 一个已经设了密码的部署不该再被向导拦住 —— 那会把线上环境当成新装的。
 */
const setupNeeded = (): boolean => config.password === '' && (settings.STUDIO_SETUP_DONE ?? '') !== '1'
/** 绿色包的根目录（启动器会设 `STUDIO_HOME`）；Docker/源码运行没有它。 */
const studioHome = process.env.STUDIO_HOME ?? ''

/**
 * 账号层（`cloud` 模式）。
 *
 * 邮件默认**打到日志**（开发与测试不需要任何外部服务）；配了 `STUDIO_MAIL_WEBHOOK`
 * 就 POST 给你自己的转发服务。真实邮件服务商留到 M4。
 */
const accounts = createAccounts({
  store,
  publicUrl: config.publicUrl,
  mailer: config.mailWebhookUrl === ''
    ? createConsoleMailer((message) => { console.log(`[studio] ${message}`) })
    : createWebhookMailer(config.mailWebhookUrl, (message) => { console.log(`[studio] ${message}`) }),
  log: (message) => { console.log(`[studio] ${message}`) },
})
/**
 * 本地备份（M2 的保险丝）。
 *
 * 备份目录存在设置里（键 `STUDIO_BACKUP_DIR`，和别的设置同一套三层取值），
 * 换位置立刻生效。**启动时如果距上次超过 20 小时就自动做一次**，
 * 之后每 6 小时检查一次 —— 用户不需要记得点任何按钮。
 */
const backups = createBackups({ dataDir: config.dataDir, log: (message) => { console.log(`[studio] ${message}`) } })
if ((settings.STUDIO_BACKUP_DIR ?? '') !== '') backups.setDir(settings.STUDIO_BACKUP_DIR as string)
const runDailyBackup = (): void => {
  // 只备份「自己管自己数据」的那种部署：cloud 模式下这个进程没有画布与素材。
  if (config.mode !== 'local') return
  if (!backups.dueForDaily()) return
  const result = backups.run('每天自动')
  if (typeof result === 'string') console.log(`[studio] 自动备份失败：${result}`)
}
if (config.mode === 'local') {
  setTimeout(runDailyBackup, 8_000)
  setInterval(runDailyBackup, 6 * 60 * 60 * 1000)
}

/** 正在进行的「绑定账号」流程的 state（一次一个，够用）。 */
let pendingCloudState = ''

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
    bridge.broadcast(shot.canvasId, 'generation_progress', { projectId: shot.canvasId, shotId, ...progress })
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

/**
 * 设置页改完之后调一次。
 *
 * 配置对象**就地**改（`Object.assign`），所以网关、Agent、作业运行器里所有已经
 * 捕获了 `config` 的闭包立刻看到新值；只有驱动把地址存成了自己的变量，需要
 * `gateway.applyConfig()` 那一声通知。文本/音频后端每次调用都重新解析，不用管。
 */
const applySettings = (): void => {
  settings = store.getSettings()
  Object.assign(config, loadConfig(settings, config))
  gateway.applyConfig()
  console.log(`[studio] 设置已更新：图像后端 ${config.imageDriver}，ComfyUI ${config.comfyuiUrl}`)
}

/** 文本/音频后端看到的环境：进程环境 **叠加** 设置页的覆盖值。 */
const backendEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...settings })

/** 文本后端：文本节点要能生成，就得有个模型；没配时是占位驱动。 */
const textBackend = createTextBackend({
  store,
  log: (message) => { console.log(`[studio] ${message}`) },
}, backendEnv)

/** 音频后端：独立的一段人声/配乐；没配时是占位驱动（合成一段真能播的 WAV）。 */
const audioBackend = createAudioBackend({
  store,
  log: (message) => { console.log(`[studio] ${message}`) },
}, backendEnv)

/**
 * 渲染作业：一次生成不再等于一个 HTTP 请求。
 *
 * 图片 6 秒时那样无所谓，视频 11 分钟就不行了 —— Node 的 fetch 默认 5 分钟放弃、
 * nginx 默认 60 秒 504、Agent 的调用同样超时，而「调用方失败」和「活干完了」
 * 会同时为真。
 *
 * 运行器在这里（而不是在 jobs.ts 里）拼装，因为写画布文档要用 ops、通知画布要用
 * bridge —— 只有这个组合根同时握着它们。
 */
const jobs = createJobRegistry({
  log: (message) => { console.log(`[studio] ${message}`) },
  // 每次状态变化都推给正在看这块画布的人；刷新过的页面则靠 /api/jobs 重新接上。
  onChange: (job) => {
    bridge.broadcast(job.request.projectId, 'job', job)
  },
  abort: async (comfyPromptId) => { await gateway.abortRender(comfyPromptId) },
  async run(job, hooks) {
    const request = job.request
    // 文本作业走的是同一条「提交 → 状态 → 结果」的路，只是干活的换成了 LLM，
    // 结果也不是文件而是文本。放在同一个注册表里，画布与 Agent 都不必学第二套。
    if (request.kind === 'text') {
      // 「接着写」的素材由**调用方显式给**（画布给的是上游文本节点的内容）。
      // 不能拿节点自己那段字当上下文：那段字已经是指令了，再当一次上下文，
      // 模型会把同一句话读两遍 —— 占位驱动的输出里一眼就能看见这件事。
      const context = typeof request.params?.context === 'string' ? request.params.context : ''
      const text = await textBackend.generate({
        prompt: request.prompt,
        ...(context.trim() === '' ? {} : { context }),
      })
      const current = readDocument(store, request.projectId)
      const applied = applyText(current, { nodeId: request.nodeId, text })
      if (applied) {
        writeDocument(store, request.projectId, current)
        // reason 用 'render'：这是「我自己这次生成完事了」，不该把人正在编辑的选中清掉。
        bridge.broadcastDocument(request.projectId, 'render')
      }
      return { files: [], takes: 0, shotId: '', text }
    }
    // 音频作业：干活的换成语音模型，结果是**文件**（所以它和渲染那条一样走素材 + take
    // + 写回画布，也和渲染一样「失败也要留一条 take」——不然「失败也留痕」又是空话）。
    if (request.kind === 'audio') {
      const model = audioBackend.status().model
      let audioShotId = request.shotId ?? ''
      if (audioShotId === '' || store.getShot(audioShotId) === undefined) {
        audioShotId = store.addShot(request.projectId, request.prompt.slice(0, 40) || '配音', request.prompt).id
      }
      const before = store.listTakes(audioShotId)
      const started = Date.now()
      try {
        const speech = await audioBackend.speak({ text: request.prompt })
        const asset = store.saveAsset(speech.bytes, speech.mime, 'audio')
        const take = store.addTake({
          shotId: audioShotId,
          providerId: 'studio-audio',
          model,
          status: 'succeeded',
          assetId: asset.id,
          params: { prompt: request.prompt, voice: speech.voice },
          latencyMs: Date.now() - started,
        })
        const files = [{ url: `/api/assets/${asset.id}`, assetId: asset.id, takeId: take.id }]
        const doc = readDocument(store, request.projectId)
        const applied = applyGeneration(doc, {
          nodeId: request.nodeId,
          shotId: audioShotId,
          prompt: request.prompt,
          historyLength: before.length,
          files,
        })
        if (applied) {
          writeDocument(store, request.projectId, doc)
          bridge.broadcastDocument(request.projectId, 'render')
        }
        return { files, takes: store.listTakes(audioShotId).length, shotId: audioShotId }
      } catch (error) {
        // 失败也记一条：这一版的参数、耗时、原因都留着，画布上能看见、能点一下重试。
        store.addTake({
          shotId: audioShotId,
          providerId: 'studio-audio',
          model,
          status: 'failed',
          params: { prompt: request.prompt },
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    // 镜头：没有就现建一个，和画布点击、Agent 调用走的是同一条路。
    let shotId = request.shotId ?? ''
    if (shotId === '' || store.getShot(shotId) === undefined) {
      // 剪辑/拼接没有提示词，镜头标题会空着——那不好看也不好找，给一句通用的。
      shotId = store.addShot(request.projectId, request.prompt.slice(0, 40) || '剪辑', request.prompt).id
    }
    const history = store.listTakes(shotId)
    // 入边上的输入图（首帧/尾帧/参考图）。**端口 id 就是工作流里的占位符名**
    // （`first` / `last` / `ref`），所以这里只按端口名收一遍就够了——不需要
    // 「端口 → 占位符」的第二张对照表，工作流用不到的键它自己会忽略。
    // 只读这一份文档解析连线；落盘前会再读一次，因为渲染这十几分钟里别人可能改了画布，
    // 拿旧的这份去写会把他的改动覆盖掉。
    const before = readDocument(store, request.projectId)
    const inputs: Record<string, string> = {}
    for (const edge of before.edges) {
      if (edge.target !== request.nodeId) continue
      const name = String(edge.targetHandle ?? '')
      if (name === '' || inputs[name] !== undefined) continue
      const url = inboundAssetUrl(before, request.nodeId, name)
      if (url !== '') inputs[name] = url
    }
    const files = await gateway.renderImage({
      prompt: request.prompt,
      shotId,
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.count === undefined ? {} : { count: request.count }),
      ...(request.workflowId === undefined ? {} : { workflowId: request.workflowId }),
      ...(request.duration === undefined ? {} : { duration: request.duration }),
      ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
      ...(request.params === undefined ? {} : { params: request.params }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    }, {
      onQueued: hooks.queued,
      onProgress: (progress) => { hooks.progress(progress as unknown as Record<string, unknown>) },
    })

    // 落进文档这件事由**服务端**做：没有浏览器开着的时候，那次生成也该出现在画布上。
    const doc = readDocument(store, request.projectId)
    const applied = applyGeneration(doc, {
      nodeId: request.nodeId,
      shotId,
      prompt: request.prompt,
      historyLength: history.length,
      files,
    })
    if (applied) {
      writeDocument(store, request.projectId, doc)
      // reason 用 'render' 而不是 'generate'：画布要区分「我自己这次生成完事了」
      // 和「别的入口改了文档」——前者不该把人正在编辑的选中状态清掉。
      bridge.broadcastDocument(request.projectId, 'render')
    }
    return {
      files,
      takes: store.listTakes(shotId).length,
      shotId,
    }
  },
})

/**
 * Agent 的生成走**同一个作业注册表**。
 *
 * 从前它直接 `await gateway.renderImage`：图片 6 秒还行，让 Agent 出一段视频就会
 * 撞上和画布点击同一个超时，而「调用方失败」和「活干完了」会同时为真。
 * 现在它只负责「提交 + 有上限地等」，干活、写回文档、记 take 全在这一个注册表里 ——
 * 所以 Agent 不必也不该自己握着网关（`AgentDeps` 里已经没有它了）。
 *
 * 装配顺序也因此变了：作业注册表要先于 Agent 建好。
 */
const agent = createAgentFace({
  store,
  submitRender: (request) => jobs.submit(request),
  findJob: (id) => jobs.get(id),
  cancelJob: async (id) => jobs.cancel(id),
  workflows: workflowList,
  onDocumentChanged: (projectId, reason) => { bridge.broadcastDocument(projectId, reason) },
  log: (message) => { console.log(`[studio] ${message}`) },
})
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

/**
 * Accept only `{ name: "file.safetensors" }`.
 *
 * 这是「换模型/换量化档」的入口（债务第 15 条）：文件名是纯文本，只做两件必须做的事 ——
 * **去掉路径分隔符**（一个模型名不该能指到目录外）与去掉空值。
 */
function parseModels(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const models: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue
    const name = raw.trim().replace(/[\\/]/gu, '').slice(0, 200)
    if (key.trim() === '' || name === '') continue
    models[key.trim()] = name
  }
  return models
}

/** Send a JSON response. */
function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 把用户可控的文本塞进 HTML 之前转义（这两页会回显服务端的错误信息）。 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] ?? character))
}

/**
 * 极简 HTML 页（邮箱验证 / 重置密码用）。
 *
 * 刻意不引入模板：这两页只服务一封邮件里的链接，样式跟着品牌色走就行。
 * @param title - 页面标题与主标题。
 * @param body - 已经拼好的正文（**调用方负责转义**）。
 * @returns 完整的 HTML 文本。
 */
function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} · LINGHAN Studio</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d12; color: #e8ecf4;
         font: 14px/1.7 system-ui, "Microsoft YaHei", sans-serif; }
  .card { width: min(420px, 90vw); padding: 28px; background: #141821; border: 1px solid #263041; border-radius: 14px; }
  h1 { margin: 0 0 12px; font-size: 18px; }
  p { margin: 0 0 10px; }
  .muted { color: #8b97a8; font-size: 13px; }
  .ok { color: #7ad1a3; } .bad { color: #ff8f8f; }
  input { width: 100%; box-sizing: border-box; margin-bottom: 10px; padding: 9px 10px; border-radius: 8px;
          border: 1px solid #263041; background: #0b0d12; color: #e8ecf4; font-size: 14px; }
  button { width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #7aa2ff; color: #0b0d12;
           font-size: 14px; font-weight: 600; cursor: pointer; }
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></body></html>`
}

/**
 * 「授权这台电脑」页（浏览器回跳登录的那一半）。
 *
 * 流程：桌面端打开这一页 → 用户在这里登录（如果还没登录）→ 点「授权」→
 * 页面拿一次性码 → 回跳给本机服务（`http://127.0.0.1:<端口>/api/cloud/callback`）。
 * **密码不经过桌面应用**，码是一次性的、5 分钟过期。
 *
 * `redirect` 只允许本机回环地址：这是防止有人拿这一页把码骗到自己的服务器上。
 * @param redirect - 本机服务给的回跳地址。
 * @param state - 桌面端生成的随机串（回跳时原样带回，用来防串号）。
 * @returns 完整的 HTML 文本。
 */
function desktopAuthPage(redirect: string, state: string): string {
  const safeRedirect = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//u.test(redirect) ? redirect : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>授权这台电脑 · LINGHAN Studio</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d12; color: #e8ecf4;
         font: 14px/1.7 system-ui, "Microsoft YaHei", sans-serif; }
  .card { width: min(420px, 90vw); padding: 28px; background: #141821; border: 1px solid #263041; border-radius: 14px; }
  h1 { margin: 0 0 10px; font-size: 18px; }
  p { margin: 0 0 10px; }
  .muted { color: #8b97a8; font-size: 13px; }
  .ok { color: #7ad1a3; } .bad { color: #ff8f8f; }
  input { width: 100%; box-sizing: border-box; margin-bottom: 10px; padding: 9px 10px; border-radius: 8px;
          border: 1px solid #263041; background: #0b0d12; color: #e8ecf4; font-size: 14px; }
  button { width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #7aa2ff; color: #0b0d12;
           font-size: 14px; font-weight: 600; cursor: pointer; margin-bottom: 8px; }
  button.ghost { background: transparent; color: #8b97a8; border: 1px solid #263041; font-weight: 400; }
</style></head>
<body><div class="card">
  <h1>授权这台电脑</h1>
  <p class="muted">桌面端要用你的账号发布作品。授权之后，桌面端拿到的是**可以随时撤销**的登录凭据，密码不会经过它。</p>
  <div id="login" style="display:none">
    <label class="muted">邮箱</label><input id="email" type="email" autocomplete="email" />
    <label class="muted">密码</label><input id="password" type="password" autocomplete="current-password" />
    <button id="signin">登录并继续</button>
  </div>
  <div id="grant" style="display:none">
    <p class="muted">已登录：<span id="who"></span></p>
    <button id="authorize">授权这台电脑</button>
  </div>
  <p class="muted" id="note"></p>
  <script>
    const redirect = ${JSON.stringify(safeRedirect)};
    const state = ${JSON.stringify(state)};
    const $ = (id) => document.getElementById(id);
    const say = (text, bad) => { $('note').className = bad ? 'bad' : 'muted'; $('note').textContent = text; };
    const api = async (path, init = {}) => {
      const response = await fetch('/api/v1/auth' + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
      return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
    };
    const show = async () => {
      const { ok, body } = await api('/me');
      $('login').style.display = ok ? 'none' : 'block';
      $('grant').style.display = ok ? 'block' : 'none';
      if (ok) $('who').textContent = body.user.email;
      if (!redirect) say('这个授权链接不完整（缺少回跳地址），请回到桌面端点一次「绑定账号」。', true);
    };
    $('signin').addEventListener('click', async () => {
      say('正在登录…');
      const { ok, body } = await api('/login', { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value, label: '浏览器（授权桌面端）' }) });
      if (!ok) { say(body.error || '登录失败', true); return; }
      say('');
      await show();
    });
    $('authorize').addEventListener('click', async () => {
      if (!redirect) return;
      say('正在授权…');
      const { ok, body } = await api('/desktop/issue', { method: 'POST', body: '{}' });
      if (!ok) { say(body.error || '授权失败', true); return; }
      location.href = redirect + '?code=' + encodeURIComponent(body.code) + '&state=' + encodeURIComponent(state);
    });
    void show();
  </script>
</div></body></html>`
}

/**
 * 服务器端（cloud 模式）的账号页。
 *
 * 为什么现在就做这一页：**服务器端的东西不该只有懂命令行的人能看见**。
 * 它也是 M3 那个正式网页界面的种子（那时候加上作品与主页）。
 *
 * 一页搞定：注册 / 登录 / 看自己的账号 / 设备列表与撤销 / 忘记密码。
 * @param consoleMail - 邮件是不是只打在日志里（没配转发）——是的话页面会把验证链接直接显示出来。
 * @returns 完整的 HTML 文本。
 */
function accountPage(consoleMail: boolean): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>账号 · LINGHAN Studio（服务器端）</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; background: #0b0d12; color: #e8ecf4;
         font: 14px/1.7 system-ui, "Microsoft YaHei", sans-serif; padding: 28px 16px; }
  .wrap { width: min(760px, 100%); margin: 0 auto; }
  .card { padding: 20px 22px; background: #141821; border: 1px solid #263041; border-radius: 14px; margin-bottom: 14px; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  h2 { margin: 0 0 12px; font-size: 15px; }
  p { margin: 0 0 10px; }
  .muted { color: #8b97a8; font-size: 13px; }
  .ok { color: #7ad1a3; } .bad { color: #ff8f8f; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 640px) { .cols { grid-template-columns: 1fr; } }
  label { display: block; font-size: 12px; color: #8b97a8; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; margin-bottom: 10px; padding: 9px 10px; border-radius: 8px;
          border: 1px solid #263041; background: #0b0d12; color: #e8ecf4; font-size: 14px; }
  button { padding: 9px 14px; border: 0; border-radius: 8px; background: #7aa2ff; color: #0b0d12;
           font-size: 13px; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; color: #8b97a8; border: 1px solid #263041; font-weight: 400; }
  button.danger { background: transparent; color: #ff8f8f; border: 1px solid #3a2530; font-weight: 400; }
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid #1d2431; }
  .row:first-of-type { border-top: 0; }
  .row .grow { flex: 1; min-width: 0; }
  code { font-size: 12px; color: #cfe0ff; word-break: break-all; }
  .tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid #263041; color: #8b97a8; }
  .tag.ok { border-color: #2c4a3a; color: #7ad1a3; }
  .tag.bad { border-color: #4a2c2c; color: #ff8f8f; }
</style></head>
<body><div class="wrap">
  <div class="card">
    <h1>LINGHAN Studio · 服务器端</h1>
    <p class="muted">这台服务器**只管账号与作品展示**。画布、素材、算力都在你自己的桌面端里，
      不在这台机器上（这也是为什么这里没有画布列表）。</p>
    <div id="who" class="muted">正在读取登录状态…</div>
  </div>

  <div id="guest">
    <div class="cols">
      <div class="card">
        <h2>注册</h2>
        <label>邮箱</label><input id="reg-email" type="email" autocomplete="email" />
        <label>密码（至少 8 位）</label><input id="reg-password" type="password" autocomplete="new-password" />
        <label>怎么称呼你（可留空）</label><input id="reg-name" />
        <button id="reg-submit">注册</button>
        <p class="muted" id="reg-note"></p>
      </div>
      <div class="card">
        <h2>登录</h2>
        <label>邮箱</label><input id="log-email" type="email" autocomplete="email" />
        <label>密码</label><input id="log-password" type="password" autocomplete="current-password" />
        <button id="log-submit">登录</button>
        <p class="muted">忘记密码？填上面的邮箱，点下面这个。</p>
        <button class="ghost" id="forgot">发一封重置密码的邮件</button>
        <p class="muted" id="log-note"></p>
      </div>
    </div>
  </div>

  <div id="me" style="display:none">
    <div class="card">
      <h2>我的账号</h2>
      <div class="row"><span class="grow" id="me-email"></span><span id="me-role" class="tag"></span><span id="me-verified" class="tag"></span></div>
      <div class="row"><span class="grow muted">注册时间</span><span id="me-created" class="muted"></span></div>
      <div class="row">
        <button class="ghost" id="resend">重新发验证邮件</button>
        <button class="danger" id="logout">退出登录</button>
      </div>
      <p class="muted" id="me-note"></p>
      ${consoleMail ? `
      <div id="devmail" style="display:none">
        <p class="muted">这台服务器**还没有配发信服务**，所以验证邮件只打在了服务器日志里。
          为了让你能点，最近一封的内容显示在这里（配好发信服务后这段会自动消失）：</p>
        <div class="row"><code id="devmail-text"></code></div>
      </div>` : ''}
    </div>
    <div class="card">
      <h2>登录过的设备</h2>
      <p class="muted">一条就是一次登录。发现不认识的设备，点「撤销」它就得重新登录。</p>
      <div id="sessions"></div>
    </div>
  </div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const say = (el, text, bad) => { const node = $(el); node.className = bad ? 'bad' : 'muted'; node.textContent = text; };
  const api = async (path, init = {}) => {
    const response = await fetch('/api/v1/auth' + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  };
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const render = (user) => {
    const signedIn = user !== null;
    $('guest').style.display = signedIn ? 'none' : 'block';
    $('me').style.display = signedIn ? 'block' : 'none';
    if (!signedIn) { $('who').textContent = '当前未登录。注册或登录之后，这里会显示你的账号与设备。'; return; }
    $('who').textContent = '已登录：' + user.email;
    $('me-email').textContent = user.email + (user.displayName ? '（' + user.displayName + '）' : '');
    $('me-role').textContent = user.role === 'admin' ? '管理员' : '普通用户';
    $('me-verified').className = 'tag ' + (user.emailVerified ? 'ok' : 'bad');
    $('me-verified').textContent = user.emailVerified ? '邮箱已验证' : '邮箱未验证';
    $('me-created').textContent = new Date(user.createdAt).toLocaleString('zh-CN');
    void loadSessions();
    void loadDevMail();
  };

  const loadSessions = async () => {
    const { body } = await api('/sessions');
    const rows = body.sessions ?? [];
    $('sessions').innerHTML = rows.length === 0 ? '<p class="muted">还没有记录。</p>' : rows.map((item) => (
      '<div class="row"><span class="grow">' + escape(item.label || '未命名的设备') +
      '<br /><span class="muted">最近使用 ' + new Date(item.lastSeenAt).toLocaleString('zh-CN') + '</span></span>' +
      (item.revoked ? '<span class="tag">已撤销</span>' : '<button class="danger" data-revoke="' + escape(item.id) + '">撤销</button>') +
      '</div>'
    )).join('');
    for (const button of document.querySelectorAll('[data-revoke]')) {
      button.addEventListener('click', async () => {
        await api('/sessions/' + button.getAttribute('data-revoke'), { method: 'DELETE' });
        void loadSessions();
      });
    }
  };

  const loadDevMail = async () => {
    ${consoleMail ? `
    const { ok, body } = await api('/dev-mail');
    if (!ok || (body.mails ?? []).length === 0) { $('devmail').style.display = 'none'; return; }
    $('devmail').style.display = 'block';
    $('devmail-text').textContent = body.mails[0].text;
    ` : ''}
  };

  const refresh = async () => {
    const { ok, body } = await api('/me');
    render(ok ? body.user : null);
  };

  $('reg-submit').addEventListener('click', async () => {
    say('reg-note', '正在注册…');
    const { ok, body } = await api('/register', { method: 'POST', body: JSON.stringify({
      email: $('reg-email').value, password: $('reg-password').value, displayName: $('reg-name').value, label: '浏览器',
    }) });
    if (!ok) { say('reg-note', body.error || '注册失败', true); return; }
    say('reg-note', '注册成功。');
    await refresh();
  });

  $('log-submit').addEventListener('click', async () => {
    say('log-note', '正在登录…');
    const { ok, body } = await api('/login', { method: 'POST', body: JSON.stringify({
      email: $('log-email').value, password: $('log-password').value, label: '浏览器',
    }) });
    if (!ok) { say('log-note', body.error || '登录失败', true); return; }
    say('log-note', '');
    await refresh();
  });

  $('forgot').addEventListener('click', async () => {
    const { body } = await api('/forgot-password', { method: 'POST', body: JSON.stringify({ email: $('log-email').value }) });
    say('log-note', body.note || '已处理');
  });

  $('resend').addEventListener('click', async () => {
    const { body } = await api('/resend-verification', { method: 'POST', body: JSON.stringify({ email: $('me-email').textContent.split('（')[0] }) });
    say('me-note', body.note || '已处理');
    void loadDevMail();
  });

  $('logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST', body: '{}' });
    await refresh();
  });

  void refresh();
</script>
</body></html>`
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
  // 首启向导要能在**还没有密码的时候**走完 —— 自举是它唯一存在的理由。
  // 它自己会把门关死（配过之后就 403），所以这不是一个常开的洞。
  if (pathname === '/api/setup') return false
  /**
   * 「绑定账号」的回跳也要能免登录进来。
   *
   * 它是**浏览器从云端跳回来的**那一下：那个浏览器可能没在这个本机服务上登录过
   * （换个浏览器、或者刚重装）。要求它带本机会话会让绑定在某些情况下莫名其妙失败。
   * 这个接口自己有三道锁：**只认本机回环来源**、`state` 必须与这次流程对得上、
   * 授权码一次性且 5 分钟过期。它拿不到任何数据，只能把一次授权落成令牌。
   */
  if (pathname === '/api/cloud/callback') return false
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
      /**
       * 画布（作品）的接口正名（债务第 8 条）：路径是 `/api/canvases`，
       * 存储层是 `canvas` 表 —— 界面从第一天就说「画布」，代码里不该再叫 `project`。
       *
       * **旧路径 `/api/projects` 仍然能用**：这是对外发布过的接口，
       * 「改个名字就把别人的脚本打死」不该发生。别名在这里统一改写一次，
       * 下面的处理器一份就够（两套路由迟早会跑偏）。
       * 只在 URL 层面改写，所以下游（工作流路由、文档路由）一起就正名了。
       */
      const canvasPath = pathname.startsWith('/api/projects')
        ? `/api/canvases${pathname.slice('/api/projects'.length)}`
        : pathname

      if (pathname === '/api/health') {
        json(res, 200, { ok: true, mode: config.mode, driver: config.imageDriver, clients: bridge.connected() })
        return
      }

      /**
       * 账号接口（`cloud` 模式）。
       *
       * 全部在 `/api/v1/auth/` 下：这是**对外发布的接口**（桌面端会带着它发出去），
       * 所以从第一天就带版本号 —— 以后加字段、改行为都得留在 v1 里往下兼容。
       *
       * 会话有两种携带方式，同一套服务端：
       * - 网页端：httpOnly cookie（`studio_user`），未登录跳登录页；
       * - 桌面端：`Authorization: Bearer <accessToken>`，刷新用 body 里的 refreshToken。
       */
      if (config.mode === 'cloud' && pathname.startsWith('/api/v1/auth/')) {
        const route = pathname.slice('/api/v1/auth/'.length)
        const body = method === 'POST' ? parseJson(await readText(req)) : {}
        /** 从 cookie 或 Bearer 里取访问令牌。 */
        const accessTokenOf = (): string => {
          const header = req.headers.authorization ?? ''
          if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
          return readUserToken(req, config.cookieSecret) ?? ''
        }
        const publicUser = (user: { id: string; email: string; displayName: string; role: string; emailVerifiedAt: string; createdAt: string; lastLoginAt: string }): Record<string, unknown> => ({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          emailVerified: user.emailVerifiedAt !== '',
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        })

        if (route === 'register' && method === 'POST') {
          const result = await accounts.register({
            email: typeof body.email === 'string' ? body.email : '',
            password: typeof body.password === 'string' ? body.password : '',
            ...(typeof body.displayName === 'string' && body.displayName !== '' ? { displayName: body.displayName } : {}),
          })
          if ('message' in result) {
            json(res, result.status, { error: result.message })
            return
          }
          // 注册完直接给会话：让「注册→验证邮箱」之间不用再登录一次。
          const tokens = (await accounts.login({
            email: result.user.email,
            password: typeof body.password === 'string' ? body.password : '',
            // 设备名：客户端能报就报，报不了才退到 User-Agent（那一长串没人看得懂）。
            label: typeof body.label === 'string' && body.label !== '' ? body.label : (req.headers['user-agent']?.slice(0, 60) ?? ''),
          }))
          if ('message' in tokens) {
            json(res, 200, { user: publicUser(result.user), verificationSent: true })
            return
          }
          issueUserCookie(res, tokens.tokens.accessToken, config.cookieSecret, secureCookies)
          json(res, 200, { user: publicUser(tokens.user), tokens: tokens.tokens, verificationSent: true })
          return
        }

        if (route === 'login' && method === 'POST') {
          const address = req.socket.remoteAddress ?? 'unknown'
          // 限流按「来源地址」：按邮箱限流会让攻击者用别人的邮箱把对方锁在门外。
          if (throttle(address)) {
            json(res, 429, { error: '尝试过于频繁，请稍后再试' })
            return
          }
          const result = await accounts.login({
            email: typeof body.email === 'string' ? body.email : '',
            password: typeof body.password === 'string' ? body.password : '',
            label: typeof body.label === 'string' && body.label !== '' ? body.label : (req.headers['user-agent']?.slice(0, 60) ?? ''),
          })
          if ('message' in result) {
            json(res, result.status, { error: result.message })
            return
          }
          clearThrottle(address)
          issueUserCookie(res, result.tokens.accessToken, config.cookieSecret, secureCookies)
          json(res, 200, { user: publicUser(result.user), tokens: result.tokens })
          return
        }

        if (route === 'refresh' && method === 'POST') {
          const result = await accounts.refresh(typeof body.refreshToken === 'string' ? body.refreshToken : '')
          if ('message' in result) {
            json(res, result.status, { error: result.message })
            return
          }
          issueUserCookie(res, result.tokens.accessToken, config.cookieSecret, secureCookies)
          json(res, 200, { user: publicUser(result.user), tokens: result.tokens })
          return
        }

        if (route === 'logout' && method === 'POST') {
          const token = typeof body.refreshToken === 'string' && body.refreshToken !== '' ? body.refreshToken : accessTokenOf()
          accounts.logout(token)
          clearUserCookie(res)
          json(res, 200, { ok: true })
          return
        }

        if (route === 'me' && method === 'GET') {
          const user = accounts.me(accessTokenOf())
          if (user === undefined) {
            json(res, 401, { error: '需要登录' })
            return
          }
          json(res, 200, { user: publicUser(user) })
          return
        }

        if (route === 'verify-email' && method === 'POST') {
          const result = await accounts.verifyEmail(typeof body.token === 'string' ? body.token : '')
          if ('message' in result) {
            json(res, result.status, { error: result.message })
            return
          }
          json(res, 200, { user: publicUser(result) })
          return
        }

        if (route === 'resend-verification' && method === 'POST') {
          await accounts.resendVerification(typeof body.email === 'string' ? body.email : '')
          // 无论邮箱存不存在都回同一句：这个接口不该变成「查邮箱是否注册过」的工具。
          json(res, 200, { ok: true, note: '如果这个邮箱注册过且还没验证，验证邮件已经发出' })
          return
        }

        if (route === 'forgot-password' && method === 'POST') {
          await accounts.requestPasswordReset(typeof body.email === 'string' ? body.email : '')
          json(res, 200, { ok: true, note: '如果这个邮箱注册过，重置邮件已经发出（1 小时内有效）' })
          return
        }

        if (route === 'reset-password' && method === 'POST') {
          const result = await accounts.resetPassword(
            typeof body.token === 'string' ? body.token : '',
            typeof body.password === 'string' ? body.password : '',
          )
          if ('message' in result) {
            json(res, result.status, { error: result.message })
            return
          }
          clearUserCookie(res)
          json(res, 200, { ok: true, note: '密码已改，所有设备都需要重新登录' })
          return
        }

        // 桌面端登录：① 浏览器里已登录的人点「授权这台电脑」→ 拿一次性码；
        // ② 浏览器把码回跳给本机服务；③ 本机服务用码换长期令牌（不经过浏览器）。
        if (route === 'desktop/issue' && method === 'POST') {
          const user = accounts.me(accessTokenOf())
          if (user === undefined) {
            json(res, 401, { error: '需要登录' })
            return
          }
          json(res, 200, { code: accounts.issueDesktopCode(user.id), expiresInSeconds: 300 })
          return
        }
        if (route === 'desktop/claim' && method === 'POST') {
          const result = await accounts.claimDesktopCode(typeof body.code === 'string' ? body.code : '')
          if ('message' in result) {
            json(res, result.status, { error: result.message })
            return
          }
          json(res, 200, { user: publicUser(result.user), tokens: result.tokens })
          return
        }

        if (route === 'dev-mail' && method === 'GET') {
          // 只在「邮件根本没真发出去」时存在（没配 webhook），而且只给当前登录用户自己的那几封。
          if (config.mailWebhookUrl !== '') {
            json(res, 404, { error: '这台服务器配了邮件转发，邮件是真的发出去了' })
            return
          }
          const user = accounts.me(accessTokenOf())
          if (user === undefined) {
            json(res, 401, { error: '需要登录' })
            return
          }
          json(res, 200, { mails: accounts.devMails(user.email) })
          return
        }

        if (route === 'sessions' && method === 'GET') {
          const user = accounts.me(accessTokenOf())
          if (user === undefined) {
            json(res, 401, { error: '需要登录' })
            return
          }
          json(res, 200, {
            sessions: accounts.listSessions(user.id).map((session) => ({
              id: session.id,
              label: session.label,
              createdAt: session.createdAt,
              lastSeenAt: session.lastSeenAt,
              expiresAt: session.refreshExpiresAt,
              revoked: session.revokedAt !== '',
            })),
          })
          return
        }

        const sessionRevoke = /^sessions\/([^/]+)$/u.exec(route)
        if (sessionRevoke !== null && method === 'DELETE') {
          const user = accounts.me(accessTokenOf())
          if (user === undefined) {
            json(res, 401, { error: '需要登录' })
            return
          }
          const ok = accounts.revokeSession(user.id, decodeURIComponent(sessionRevoke[1] as string))
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '没有这个会话' })
          return
        }

        json(res, 404, { error: `未知的账号接口 ${method} ${pathname}` })
        return
      }

      /**
       * cloud 模式**没有**画布、素材、算力、作业 —— 那些东西只在用户自己的机器上
       * （见 docs/19）。所以这里明确回 404 并说清原因，
       * 而不是「能访问但永远是空的」：后者会让人以为是 bug。
       */
      if (config.mode === 'cloud' && (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) && pathname !== '/api/health') {
        json(res, 404, { error: '这是服务器端（cloud 模式）：画布、素材与算力都在你自己的桌面端里，不在这台服务器上' })
        return
      }

      if (config.mode === 'cloud' && method === 'GET' && pathname === '/desktop-auth') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(desktopAuthPage(url.searchParams.get('redirect') ?? '', url.searchParams.get('state') ?? ''))
        return
      }

      if (config.mode === 'cloud' && method === 'GET' && (pathname === '/' || pathname === '/account')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(accountPage(config.mailWebhookUrl === ''))
        return
      }

      /**
       * 邮件里那两个链接落到的页面（`/verify-email`、`/reset-password`）。
       *
       * 为什么在这里手写两页 HTML 而不是等前端：**邮件链接必须点开就能用**。
       * 等 SPA 里做页面（M3）意味着 M1 的验证邮件点开是「页面不存在」——那种半成品比没有更糟。
       * 这两页只有几十行、零依赖；M3 做正式页面时把它们换掉即可。
       */
      if (config.mode === 'cloud' && method === 'GET' && (pathname === '/verify-email' || pathname === '/reset-password')) {
        const token = url.searchParams.get('token') ?? ''
        if (pathname === '/verify-email') {
          const result = await accounts.verifyEmail(token)
          const ok = !('message' in result)
          res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
          res.end(htmlPage(ok ? '邮箱已验证' : '链接无效', ok
            ? '<p class="ok">邮箱验证成功，可以关掉这个页面回到应用了。</p>'
            : `<p class="bad">${escapeHtml('message' in result ? result.message : '')}</p><p class="muted">验证链接 1 小时内有效、且只能用一次；需要的话在应用里重新发一封。</p>`))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(htmlPage('设置新密码', `
          <p class="muted">设置一个新密码（至少 8 位）。改完所有设备都要重新登录。</p>
          <input id="password" type="password" placeholder="新密码" autocomplete="new-password" />
          <input id="repeat" type="password" placeholder="再说一遍" autocomplete="new-password" />
          <button id="submit">设置新密码</button>
          <p id="result" class="muted"></p>
          <script>
            const token = ${JSON.stringify(token)};
            document.getElementById('submit').addEventListener('click', async () => {
              const password = document.getElementById('password').value;
              const repeat = document.getElementById('repeat').value;
              const out = document.getElementById('result');
              if (password !== repeat) { out.className = 'bad'; out.textContent = '两次输入的密码不一样'; return; }
              out.className = 'muted'; out.textContent = '正在提交…';
              const response = await fetch('/api/v1/auth/reset-password', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ token, password }),
              });
              const body = await response.json().catch(() => ({}));
              if (response.ok) { out.className = 'ok'; out.textContent = '密码已改，所有设备都需要重新登录。可以关掉这个页面了。'; }
              else { out.className = 'bad'; out.textContent = body.error || ('失败：HTTP ' + response.status); }
            });
          </script>`))
        return
      }

      if (pathname === '/api/session') {
        json(res, 200, {
          // 没设密码时「登录门已关闭」= 已认证。**这一条以前是错的**：那时 authenticated
          // 仍然只看 cookie，于是未设密码的部署会掉进「登录 → 还是没登录 → 再登录」的循环，
          // 每个 /api/ 请求都 401。首启向导正是从「还没设密码」开始的，所以这个洞
          // 在新的绿色包上会立刻暴露（也说明它一直在那儿，只是没人从零跑过一遍）。
          authenticated: config.password === '' || hasSession(req, config.cookieSecret),
          driver: config.imageDriver,
          models: gateway.models(),
          requiresPassword: config.password !== '',
          // 首启向导：没设密码、也没说过「以后再说」时，把这个人请到向导里。
          // 判据放在服务端而不是前端，因为「该不该引导」是部署状态，不是界面状态。
          setupNeeded: setupNeeded(),
          version: runningVersion(),
          // 数据目录只在向导里给：那时还没登录，而向导要告诉人「东西存在哪」。
          ...(setupNeeded() ? { dataDir: config.dataDir } : {}),
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

      // 没设密码 = **登录门已关闭**（本机自用）。这一条必须与 /api/session 的
      // `authenticated` 口径一致，否则界面说「已登录」而接口全回 401。
      if (config.password !== '' && requiresSession(pathname) && !hasSession(req, config.cookieSecret)) {
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
      // 工作流路由也认正名后的路径（入口处已经把旧名改写掉了）。
      if (await workflowRoutes.handle(req, res, canvasPath, method)) return

      if (pathname === '/api/image-backend' && method === 'GET') {
        json(res, 200, await gateway.backend())
        return
      }

      // 文本后端（文本节点靠它出字）。和 /api/image-backend 对称：画布据此决定
      // ↑ 按钮能不能按、以及按不下去时该说什么。
      if (pathname === '/api/text-backend' && method === 'GET') {
        json(res, 200, textBackend.status())
        return
      }

      // 音频后端（音频节点靠它出人声）。同一套形状：configured + note 给画布用。
      if (pathname === '/api/audio-backend' && method === 'GET') {
        json(res, 200, audioBackend.status())
        return
      }

      // 首启向导：**唯一一个不用登录就能写的接口**，而且只在「还没配置过」时能用。
      // 允许它存在的理由是自举：设密码这件事本身需要一个还没上锁的入口。
      // 一旦设过密码或点过「以后再说」，它就永久关门（403），免得变成后门。
      if (pathname === '/api/setup' && method === 'POST') {
        if (!setupNeeded()) {
          json(res, 403, { error: '这台部署已经配置过了，请到设置页修改' })
          return
        }
        const body = parseJson(await readText(req))
        const password = typeof body.password === 'string' ? body.password : ''
        if (password !== '' && password.length < 6) {
          json(res, 400, { error: '密码至少 6 位（这台机器上的人能改你的画布）' })
          return
        }
        // 只有字段表里的键能被写进来（和 /api/settings 同一条规矩）。
        const allowed = new Set(SETTINGS.map((item) => item.key))
        const values = typeof body.values === 'object' && body.values !== null ? body.values as Record<string, unknown> : {}
        for (const [key, raw] of Object.entries(values)) {
          if (!allowed.has(key)) continue
          store.setSetting(key, typeof raw === 'string' ? raw.trim() : '')
        }
        if (password !== '') store.setSetting('STUDIO_PASSWORD', password)
        store.setSetting('STUDIO_SETUP_DONE', '1')
        applySettings()
        // 当场就把这个人登进去：向导刚让他设的密码，转头再让他输一遍是没道理的。
        if (config.password !== '') issueSession(res, config.cookieSecret, secureCookies)
        json(res, 200, {
          ok: true,
          passwordSet: config.password !== '',
          driver: config.imageDriver,
        })
        return
      }

      // 更新：检查（只读）与安装（改磁盘）。两者都要登录。
      if (pathname === '/api/update' && method === 'GET') {
        const info = await checkForUpdate({ manifestUrl: config.updateUrl })
        json(res, 200, {
          ...info,
          // 能不能自助更新由**部署方式**决定：绿色包（STUDIO_HOME 下有自带那份程序）能，
          // Docker / 源码运行不能。
          selfUpdate: isPortableHome(studioHome),
          home: studioHome === '' ? '' : studioHome,
          installed: studioHome === '' ? [] : installedVersions(studioHome),
        })
        return
      }
      if (pathname === '/api/update/apply' && method === 'POST') {
        if (studioHome === '') {
          json(res, 400, { error: '这个部署方式不能自助更新（Docker 请拉新镜像，源码运行请 git pull）' })
          return
        }
        // 装哪一版以**更新源**为准，不接受请求体指定地址：否则这个接口就成了
        // 「让服务器下载并运行任意 zip」的洞。
        const info = await checkForUpdate({ manifestUrl: config.updateUrl })
        if (info.error !== '') {
          json(res, 400, { error: info.error })
          return
        }
        if (!info.available) {
          json(res, 400, { error: '已经是最新版了' })
          return
        }
        const manifest = info.manifest
        if (manifest === undefined) {
          json(res, 400, { error: '更新源的内容看不懂（缺 version/url/sha256）' })
          return
        }
        const applied = await applyUpdate({ home: studioHome, version: manifest.version, url: manifest.url, sha256: manifest.sha256 })
        if (typeof applied === 'string') {
          json(res, 400, { error: applied })
          return
        }
        json(res, 200, {
          ok: true,
          version: manifest.version,
          files: applied.files,
          bytes: applied.bytes,
          note: '已经装好了，重启 Studio 之后生效（正在跑的进程替换不了自己）',
        })
        return
      }

      // 设置页：读 / 写 / 测。
      if (pathname === '/api/settings' && method === 'GET') {
        json(res, 200, {
          settings: settingsView(settings),
          // 只读的那几项也一并给出：它们改了要重启（数据目录、端口），但人想知道现在是哪个。
          dataDir: config.dataDir,
          port: config.port,
          passwordSet: config.password !== '',
        })
        return
      }
      if (pathname === '/api/settings' && method === 'PUT') {
        const body = parseJson(await readText(req))
        const values = typeof body.values === 'object' && body.values !== null
          ? body.values as Record<string, unknown>
          : {}
        // **只认字段表里那几个键**：设置页不该能把任意环境变量名写进存储。
        const allowed = new Set(SETTINGS.map((item) => item.key))
        const saved: string[] = []
        for (const [key, raw] of Object.entries(values)) {
          if (!allowed.has(key)) continue
          store.setSetting(key, typeof raw === 'string' ? raw.trim() : '')
          saved.push(key)
        }
        if (saved.length > 0) applySettings()
        json(res, 200, { settings: settingsView(settings), saved })
        return
      }
      if (pathname === '/api/settings/test' && method === 'POST') {
        const body = parseJson(await readText(req))
        const target = typeof body.target === 'string' ? body.target : ''
        if (target === 'image') {
          json(res, 200, { target, ...(await gateway.backend()) })
          return
        }
        if (target === 'text' || target === 'audio') {
          const backend = target === 'text' ? textBackend : audioBackend
          const probe = await backend.probe()
          json(res, 200, { target, ok: probe.ok, detail: probe.detail, ...backend.status() })
          return
        }
        json(res, 400, { error: 'target 必须是 image / text / audio' })
        return
      }

      // 渲染作业：提交立刻返回，之后靠查/推。长任务（视频十几分钟）不能挂在
      // 一个 HTTP 请求上——见 createJobRegistry 上面的说明。
      if (pathname === '/api/jobs' && method === 'POST') {
        const body = parseJson(await readText(req))
        const projectId = typeof body.projectId === 'string' ? body.projectId : ''
        const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        // 查的是**画布实体**，不是文档：一张还没保存过的画布也该能接作业。
        if (store.getCanvas(projectId) === undefined) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        // 提示词为空**不一定**是错：剪辑/拼接那类工作流根本不生成画面，图里没有 `$prompt`。
        // 该不该要提示词由**工作流**说了算（summarize().needsPrompt），不是一刀切——
        // 一刀切的症状是「点生成什么也没发生，只回一句 400」。
        const chosen = workflowList().find((item) => item.id === (typeof body.workflow === 'string' ? body.workflow : ''))
        const needsPrompt = chosen === undefined || summarize(chosen).needsPrompt
        if (nodeId === '' || (prompt === '' && needsPrompt)) {
          json(res, 400, { error: '缺少 nodeId 或 prompt' })
          return
        }
        // 被禁用的节点不跑（债务第 22 条）。**这条必须在服务端也拦**：
        // 禁用是文档里的一个字段，而 Agent 走的是 HTTP —— 只在界面上拦住，
        // 就成了「人按不动、Agent 照样跑」，而那正是最不该发生的一种不一致。
        const disabledNode = readDocument(store, projectId).nodes
          .find((node) => (node as { id?: unknown }).id === nodeId) as { data?: { disabled?: unknown } } | undefined
        if (disabledNode?.data?.disabled === true) {
          json(res, 409, { error: '这个节点被禁用了（画布上右键可以启用）' })
          return
        }
        const job = jobs.submit({
          // 文本/音频节点提交的是「后端作业」：同样的注册表，干活的换成 LLM 或语音模型。
          ...(body.kind === 'text' || body.kind === 'audio' ? { kind: body.kind } : {}),
          projectId,
          nodeId,
          prompt,
          ...(typeof body.size === 'string' && body.size !== '' ? { size: body.size } : {}),
          ...(typeof body.count === 'number' ? { count: body.count } : {}),
          ...(typeof body.workflow === 'string' && body.workflow !== '' ? { workflowId: body.workflow } : {}),
          ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
          ...(typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
            ? { params: body.params as Record<string, number | string> }
            : {}),
          // 固定种子：画布上的「复现这一版」就是靠它把这一版原样再跑一遍。
          ...(typeof body.seed === 'number' ? { seed: body.seed } : {}),
          ...(typeof body.shotId === 'string' && body.shotId !== '' ? { shotId: body.shotId } : {}),
        })
        // 202：请求已被接受，活儿还没干完。这不是错误状态。
        json(res, 202, { job })
        return
      }
      if (pathname === '/api/jobs' && method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? undefined
        // 默认只给「还没跑完的」：刷新后的画布要接上的正是这些。
        // 想看全部（含已结束的）得显式要，否则历史会越堆越长。
        const all = url.searchParams.get('all') === '1'
        json(res, 200, { jobs: all ? jobs.list(projectId) : jobs.active(projectId) })
        return
      }
      const jobMatch = /^\/api\/jobs\/([^/]+)$/u.exec(pathname)
      if (jobMatch !== null) {
        const jobId = decodeURIComponent(jobMatch[1] as string)
        const job = jobs.get(jobId)
        if (job === undefined) {
          json(res, 404, { error: '作业不存在（服务端重启会丢掉未完成的作业）' })
          return
        }
        if (method === 'GET') {
          json(res, 200, { job })
          return
        }
        if (method === 'DELETE') {
          const accepted = await jobs.cancel(jobId)
          json(res, accepted ? 200 : 409, accepted ? { ok: true, job: jobs.get(jobId) } : { error: '这个作业已经结束了' })
          return
        }
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

      /**
       * 画布（作品）的 HTTP 面。
       *
       * 路径已在请求入口处从旧名 `/api/projects` 改写成 `/api/canvases`（见那里的说明）。
       */
      if (canvasPath === '/api/canvases' && method === 'DELETE') {
        // 整站清空回收站：`DELETE /api/canvases?trash=1`。
        const purged = store.purgeTrash()
        console.log(`[studio] trash emptied: ${String(purged)} 个画布`)
        json(res, 200, { ok: true, removed: purged })
        return
      }
      if (canvasPath === '/api/canvases' && method === 'GET') {
        const folderId = url.searchParams.get('folderId')
        const trashed = url.searchParams.get('trash') === '1'
        const canvases = store.listCanvases({
            ...(folderId === null || folderId === '' ? {} : { folderId }),
          ...(trashed ? { trashed: true } : {}),
        })
        // canvases 是正名后的字段；projects 一起给，旧客户端读得到。
        json(res, 200, { canvases, projects: canvases })
        return
      }
      if (canvasPath === '/api/canvases' && method === 'POST') {
        const body = parseJson(await readText(req))
        const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : '未命名画布'
        const folderId = typeof body.folderId === 'string' && body.folderId !== '' ? body.folderId : undefined
        const canvas = store.createCanvas(name, folderId)
        json(res, 200, { canvas, project: canvas })
        return
      }

      const projectMatch = /^\/api\/canvases\/([^/]+)$/u.exec(canvasPath)
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
          if (!store.renameCanvas(projectId, name)) {
            json(res, 404, { error: '画布不存在' })
            return
          }
        }
        if (typeof body.folderId === 'string') {
          if (!store.moveCanvas(projectId, body.folderId)) {
            json(res, 404, { error: '画布不存在' })
            return
          }
        }
        if (typeof body.coverAssetId === 'string') {
          if (!store.setCanvasCover(projectId, body.coverAssetId)) {
            json(res, 404, { error: '画布不存在' })
            return
          }
        }
        const canvas = store.getCanvas(projectId)
        json(res, 200, { canvas, project: canvas })
        return
      }
      if (projectMatch !== null && method === 'DELETE') {
        const projectId = decodeURIComponent(projectMatch[1] as string)
        // 默认是**进回收站**，只有显式 purge=1 才真的删。
        // 「删除画布」是菜单里最容易误点的一项，不该不可撤销。
        const purge = url.searchParams.get('purge') === '1'
        const done = purge ? store.deleteCanvas(projectId) : store.trashCanvas(projectId)
        if (!done) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        console.log(`[studio] canvas ${purge ? 'purged' : 'trashed'}: ${projectId.slice(0, 8)}`)
        json(res, 200, { ok: true })
        return
      }

      const duplicateMatch = /^\/api\/canvases\/([^/]+)\/duplicate$/u.exec(canvasPath)
      if (duplicateMatch !== null && method === 'POST') {
        const projectId = decodeURIComponent(duplicateMatch[1] as string)
        const copy = store.duplicateCanvas(projectId)
        if (copy === undefined) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        json(res, 200, { canvas: copy, project: copy })
        return
      }

      const restoreMatch = /^\/api\/canvases\/([^/]+)\/restore$/u.exec(canvasPath)
      if (restoreMatch !== null && method === 'POST') {
        const projectId = decodeURIComponent(restoreMatch[1] as string)
        if (!store.restoreCanvas(projectId)) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        const canvas = store.getCanvas(projectId)
        json(res, 200, { canvas, project: canvas })
        return
      }

      // 文档：`/api/canvases/<id>/doc`（旧路径是 `/api/projects/<id>/canvas`，
      // 由上面那次统一改写照顾到了 —— 所以这里只留正名后的那一个）。
      const canvasMatch = /^\/api\/canvases\/([^/]+)\/(?:doc|canvas)$/u.exec(canvasPath)
      if (canvasMatch !== null) {
        const projectId = decodeURIComponent(canvasMatch[1] as string)
        if (store.getCanvas(projectId) === undefined) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        if (method === 'GET') {
          const raw = store.getDoc(projectId)
          let doc: unknown = null
          if (raw !== undefined) {
            try { doc = JSON.parse(raw) } catch { doc = null }
          }
          json(res, 200, { doc })
          return
        }
        if (method === 'PUT' || method === 'POST') {
          const body = parseJson(await readText(req))
          store.saveDoc(projectId, JSON.stringify(body.doc ?? body))
          json(res, 200, { ok: true })
          return
        }
      }

      const shotsMatch = /^\/api\/canvases\/([^/]+)\/shots$/u.exec(canvasPath)
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

      // 删掉某一版（take）。
      //
      // 一件必须做对的事：**画布上那张卡片可能正显示着这一版**。只删数据库里的行，
      // 卡片就会指向一个不存在的素材（裂图），而裂图比「多一个版本」严重得多。
      // 所以这里顺手把文档也改掉：
      // 优先切到剩下最新的一版；一版都不剩就把这张卡片清空（回到「还没生成」的样子）。
      const takeDeleteMatch = /^\/api\/shots\/([^/]+)\/takes\/([^/]+)$/u.exec(pathname)
      if (takeDeleteMatch !== null && method === 'DELETE') {
        const shotId = decodeURIComponent(takeDeleteMatch[1] as string)
        const takeId = decodeURIComponent(takeDeleteMatch[2] as string)
        const shot = store.getShot(shotId)
        if (shot === undefined) {
          json(res, 404, { error: '镜头不存在' })
          return
        }
        const before = store.listTakes(shotId)
        const target = before.find((take) => take.id === takeId)
        if (target === undefined) {
          json(res, 404, { error: '这一版不存在' })
          return
        }
        store.deleteTake(shotId, takeId)
        const remaining = store.listTakes(shotId)
        // 文档修正：正显示这一版的卡片要换一张（或清空）。
        const doc = readDocument(store, shot.canvasId)
        const next = remaining.find((take) => take.status === 'succeeded' && take.assetId !== '')
        let touched = false
        for (const node of doc.nodes) {
          const data = node.data as Record<string, unknown> | undefined
          if (data === undefined || data.shotId !== shotId) continue
          const showsThis = data.takeId === takeId || data.takeId === undefined || data.takeId === ''
          if (!showsThis) continue
          touched = true
          if (next === undefined) {
            delete data.url
            delete data.takeId
            delete data.takeNumber
            delete data.chosen
            data.status = 'idle'
            // 镜头已经没了（最后一版）：把 shotId 也摘掉，下次生成是全新的一条线。
            if (remaining.length === 0) delete data.shotId
          } else {
            data.url = `/api/assets/${next.assetId}`
            data.takeId = next.id
            // 版本序号按**剩下的这一串**重算：删掉中间某一版之后，
            // 存着的旧序号会指着别的版本（「第 3 版」显示的是第 2 版）。
            data.takeNumber = remaining.length - remaining.findIndex((take) => take.id === next.id)
            data.chosen = next.mark === 'selected'
          }
        }
        if (touched) {
          writeDocument(store, shot.canvasId, doc)
          bridge.broadcastDocument(shot.canvasId, 'take-deleted')
        }
        /**
         * 最后才清素材，而且**必须在文档改完之后**：删掉的那一版如果正是卡片显示的，
         * 文档在这一刻之前还引用着它（`assetInUse` 为真），先问就永远清不掉 ——
         * 界面上的确认框写着「素材也一起清掉」，那就得真的清掉。
         */
        let assetRemoved = false
        if (target.assetId !== '' && !remaining.some((take) => take.assetId === target.assetId) && !store.assetInUse(target.assetId)) {
          assetRemoved = store.deleteAsset(target.assetId)
        }
        json(res, 200, {
          ok: true,
          remaining: remaining.length,
          shotGone: remaining.length === 0,
          assetRemoved,
          shown: next === undefined ? '' : next.id,
        })
        return
      }

      // 把一条 take 换成另一张素材：连续同一种编辑（连点四次右转）时**改这一版**，
      // 而不是往版本条上堆四版。换下来的那张图没人用了就顺手删掉。
      const takeAssetMatch = /^\/api\/shots\/([^/]+)\/takes\/([^/]+)\/asset$/u.exec(pathname)
      if (takeAssetMatch !== null && method === 'POST') {
        const shotId = decodeURIComponent(takeAssetMatch[1] as string)
        const takeId = decodeURIComponent(takeAssetMatch[2] as string)
        const body = parseJson(await readText(req))
        const assetId = typeof body.assetId === 'string' ? body.assetId : ''
        if (store.getShot(shotId) === undefined) {
          json(res, 404, { error: '镜头不存在' })
          return
        }
        const take = store.listTakes(shotId).find((item) => item.id === takeId)
        if (take === undefined) {
          json(res, 404, { error: '版本不存在' })
          return
        }
        if (assetId === '' || store.getAsset(assetId) === undefined) {
          json(res, 400, { error: '素材不存在' })
          return
        }
        store.updateTakeAsset(takeId, assetId)
        json(res, 200, { take: store.listTakes(shotId).find((item) => item.id === takeId) })
        return
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
          // `models` 一起传：内置工作流的图里是 `$unet` 这样的占位符，
          // 不换真名字的话「本机缺哪个模型」永远是空的。
          const check = await gateway.checkWorkflow(workflow.graph, workflow.models ?? {})
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
        // 二次修改：只换绑定/默认值/名字/模型文件名，图不动——图是从 ComfyUI 导出来的，
        // 通常是对的。**内置的也改得**：改动写成一份覆盖，随程序发布的那份文件不动
        // （债务第 10/15 条：换量化档、改 PDD 的 nfe 以前只能导出→改→再导入）。
        const workflowId = decodeURIComponent(workflowMatch[1] as string)
        const body = parseJson(await readText(req))
        const updated = updateWorkflow(config.dataDir, workflowId, {
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(body.bindings === undefined ? {} : { bindings: parseBindings(body.bindings) }),
          ...(typeof body.defaults === 'object' && body.defaults !== null ? { defaults: body.defaults as Record<string, number | string> } : {}),
          ...(typeof body.models === 'object' && body.models !== null ? { models: parseModels(body.models) } : {}),
        })
        if (updated === undefined) {
          json(res, 404, { error: '工作流不存在' })
          return
        }
        json(res, 200, { workflow: summarize(updated) })
        return
      }
      // 内置工作流「恢复出厂」：删掉那份覆盖。上传的那种请直接删（DELETE）。
      const workflowResetMatch = /^\/api\/workflows\/([^/]+)\/reset$/u.exec(pathname)
      if (workflowResetMatch !== null && method === 'POST') {
        const workflowId = decodeURIComponent(workflowResetMatch[1] as string)
        if (!isBuiltIn(workflowId)) {
          json(res, 400, { error: '只有内置工作流有「恢复内置默认」——上传的那份直接删或者改就行' })
          return
        }
        const found = readWorkflow(config.dataDir, builtInWorkflowDir, workflowId)
        json(res, 200, { ok: true, reset: resetWorkflow(config.dataDir, workflowId), workflow: found === undefined ? null : summarize(found) })
        return
      }
      if (workflowMatch !== null && method === 'DELETE') {
        const workflowId = decodeURIComponent(workflowMatch[1] as string)
        if (!deleteWorkflow(config.dataDir, workflowId)) {
          json(res, 409, { error: '内置工作流不能删除（它是随程序发布的文件）——要改就在原地改，或者点「恢复内置默认」退回去' })
          return
        }
        json(res, 200, { ok: true })
        return
      }

      /**
       * 绑定账号（本地模式）。
       *
       * 桌面端/本机服务**不需要账号也能用**（画布、算力、备份都在本机）；
       * 账号只为一件事：**发布作品**到服务器。
       *
       * 绑定走「浏览器回跳」：本机服务生成 state → 让用户去云端的 `/desktop-auth` 登录并授权 →
       * 浏览器把一次性码回跳到本机服务的 `/api/cloud/callback` → **本机服务**用码换令牌。
       * 密码因此永远不经过这个应用；令牌存在本机设置里，随时可以在云端撤销。
       */
      if (pathname === '/api/cloud' && method === 'GET') {
        const token = settings.STUDIO_CLOUD_TOKEN ?? ''
        let email = ''
        let role = ''
        if (token !== '' && config.cloudUrl !== '') {
          try {
            const response = await fetch(`${config.cloudUrl.replace(/\/+$/u, '')}/api/v1/auth/me`, {
              headers: { authorization: `Bearer ${token}` },
            })
            if (response.ok) {
              const body = await response.json() as { user?: { email?: string; role?: string } }
              email = body.user?.email ?? ''
              role = body.user?.role ?? ''
            }
          } catch {
            // 连不上云服务不算错：下面的 bound 仍为 true，界面会说明「暂时连不上」。
          }
        }
        json(res, 200, {
          cloudUrl: config.cloudUrl,
          bound: token !== '',
          email,
          role,
          reachable: email !== '' || token === '',
        })
        return
      }
      if (pathname === '/api/cloud/login' && method === 'POST') {
        if (config.cloudUrl === '') {
          json(res, 400, { error: '还没填云服务地址：先去设置页的「账号」一节填上服务器地址' })
          return
        }
        const state = randomBytes(16).toString('base64url')
        pendingCloudState = state
        const redirect = `http://127.0.0.1:${String(config.port)}/api/cloud/callback`
        const target = `${config.cloudUrl.replace(/\/+$/u, '')}/desktop-auth?redirect=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`
        json(res, 200, { url: target, state })
        return
      }
      if (pathname === '/api/cloud/callback' && method === 'GET') {
        const code = url.searchParams.get('code') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const fail = (message: string, status = 400): void => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
          res.end(htmlPage('绑定失败', `<p class="bad">${escapeHtml(message)}</p>`))
        }
        // 免登录接口，所以来源必须是本机回环：别人从外面打过来也不该能落令牌。
        const from = req.socket.remoteAddress ?? ''
        if (!(from === '127.0.0.1' || from === '::1' || from === '::ffff:127.0.0.1')) {
          fail('这个回跳只能从本机发起', 403)
          return
        }
        if (pendingCloudState === '' || state !== pendingCloudState) {
          fail('这次授权对不上号（state 不匹配）。回到桌面端重新点一次「绑定账号」。')
          return
        }
        if (code === '') {
          fail('没有拿到授权码。回到桌面端重新点一次「绑定账号」。')
          return
        }
        try {
          const response = await fetch(`${config.cloudUrl.replace(/\/+$/u, '')}/api/v1/auth/desktop/claim`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
          })
          const body = await response.json() as { user?: { email?: string }; tokens?: { accessToken?: string; refreshToken?: string }; error?: string }
          if (!response.ok || typeof body.tokens?.accessToken !== 'string') {
            fail(body.error ?? `云端拒绝了这次授权（HTTP ${String(response.status)}）`)
            return
          }
          store.setSetting('STUDIO_CLOUD_TOKEN', body.tokens.accessToken)
          store.setSetting('STUDIO_CLOUD_REFRESH', body.tokens.refreshToken ?? '')
          applySettings()
          pendingCloudState = ''
          console.log(`[studio] 已绑定账号：${body.user?.email ?? '（未知）'}`)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(htmlPage('绑定成功', `<p class="ok">已绑定账号 ${escapeHtml(body.user?.email ?? '')}，可以关掉这个页面回到 Studio 了。</p>`))
        } catch (error) {
          fail(`连不上云服务：${error instanceof Error ? error.message : String(error)}`, 502)
        }
        return
      }
      if (pathname === '/api/cloud/logout' && method === 'POST') {
        store.setSetting('STUDIO_CLOUD_TOKEN', '')
        store.setSetting('STUDIO_CLOUD_REFRESH', '')
        applySettings()
        json(res, 200, { ok: true })
        return
      }

      // 备份：看状态 / 改位置 / 现在做一次 / 从某一份恢复（重启后生效）。
      if (pathname === '/api/backup' && method === 'GET') {
        json(res, 200, { ...backups.status(), restoredFromBackup })
        return
      }
      if (pathname === '/api/backup' && method === 'POST') {
        const result = backups.run('手动')
        json(res, typeof result === 'string' ? 500 : 200, typeof result === 'string' ? { error: result } : { point: result, status: backups.status() })
        return
      }
      if (pathname === '/api/backup/config' && method === 'PUT') {
        const body = parseJson(await readText(req))
        const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
        if (dir === '') {
          json(res, 400, { error: '备份目录不能为空' })
          return
        }
        try {
          backups.setDir(dir)
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : '这个目录用不了' })
          return
        }
        // 存进设置，重启后仍然用它。
        store.setSetting('STUDIO_BACKUP_DIR', dir)
        applySettings()
        json(res, 200, { status: backups.status() })
        return
      }
      if (pathname === '/api/backup/restore' && method === 'POST') {
        const body = parseJson(await readText(req))
        const id = typeof body.id === 'string' ? body.id : ''
        const result = backups.requestRestore(id)
        if (result !== true) {
          json(res, 400, { error: result })
          return
        }
        json(res, 200, {
          ok: true,
          note: '已经准备好了：重启 Studio 之后就是这份备份里的数据（重启前当前状态也自动备份了一份）',
          status: backups.status(),
        })
        return
      }

      /**
       * 导出画布包：一个 zip，里面有画布文档 + 它用到的素材 + 用到的内置工作流。
       *
       * 「东西只在本机」这个决定之下，**换电脑靠它**：导出 → 拷到新机器 → 导入。
       * 素材按内容寻址去重，所以包里同一张图只会出现一次。
       */
      const exportMatch = /^\/api\/canvases\/([^/]+)\/export$/u.exec(canvasPath)
      if (exportMatch !== null && method === 'GET') {
        const canvasId = decodeURIComponent(exportMatch[1] as string)
        const canvas = store.getCanvas(canvasId)
        if (canvas === undefined) {
          json(res, 404, { error: '画布不存在' })
          return
        }
        const doc = readDocument(store, canvasId)
        const used = new Set<string>()
        for (const node of doc.nodes) {
          const url = (node.data as { url?: unknown } | undefined)?.url
          if (typeof url !== 'string') continue
          const match = /\/api\/assets\/([^/]+)/u.exec(url)
          if (match !== null) used.add(match[1] as string)
        }
        const entries: ZipEntry[] = [{
          name: 'canvas.json',
          bytes: Buffer.from(JSON.stringify({
            format: 'linghan-canvas',
            version: 1,
            exportedAt: new Date().toISOString(),
            name: canvas.name,
            doc: JSON.parse(JSON.stringify(doc)) as unknown,
          }, null, 2), 'utf8'),
        }]
        let missing = 0
        for (const assetId of used) {
          const asset = store.getAsset(assetId)
          if (asset === undefined) continue
          try {
            entries.push({ name: `assets/${assetId}${extOf(asset.relPath)}`, bytes: await readFile(store.assetPath(asset)) })
          } catch {
            missing += 1
          }
        }
        // 用到的内置工作流一起带上：换台机器如果没有这套工作流，画布是跑不起来的。
        const workflowIds = new Set<string>()
        for (const node of doc.nodes) {
          const id = (node.data as { workflow?: unknown } | undefined)?.workflow
          if (typeof id === 'string' && id !== '') workflowIds.add(id)
        }
        for (const workflow of workflowList()) {
          if (!workflowIds.has(workflow.id) || isBuiltIn(workflow.id)) continue
          entries.push({ name: `workflows/${workflow.id}.json`, bytes: Buffer.from(JSON.stringify(workflow, null, 2), 'utf8') })
        }
        const archive = makeZip(entries)
        console.log(`[studio] 导出画布包：${canvas.name}（${String(entries.length)} 个文件，${String(missing)} 个素材读不到）`)
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': String(archive.length),
          'content-disposition': `attachment; filename="linghan-canvas-${String(Date.now())}.zip"`,
        })
        res.end(archive)
        return
      }

      // 素材文件夹：**标签，不是容器**。所以只有 建 / 改名 / 删 三个动作，
      // 删掉文件夹时里面的素材一个都不会少（退回未分组）——这件事在界面上也写着，
      // 因为「删除文件夹」在别处的语义常常是连内容一起删。
      if (pathname === '/api/asset-folders' && method === 'GET') {
        json(res, 200, { folders: store.listAssetFolders() })
        return
      }
      if (pathname === '/api/asset-folders' && method === 'POST') {
        const body = parseJson(await readText(req))
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          json(res, 400, { error: '文件夹要有名字' })
          return
        }
        // 同名不让建两个：一列「参考图 / 参考图」谁也分不清哪个是哪个。
        if (store.findAssetFolderByName(name) !== undefined) {
          json(res, 409, { error: `已经有一个叫「${name}」的文件夹了` })
          return
        }
        json(res, 200, { folder: store.createAssetFolder(name) })
        return
      }
      const assetFolderMatch = /^\/api\/asset-folders\/([^/]+)$/u.exec(pathname)
      if (assetFolderMatch !== null && (method === 'PATCH' || method === 'DELETE')) {
        const folderId = decodeURIComponent(assetFolderMatch[1] as string)
        if (store.getAssetFolder(folderId) === undefined) {
          json(res, 404, { error: '文件夹不存在' })
          return
        }
        if (method === 'DELETE') {
          json(res, 200, { ok: true, unfiled: store.deleteAssetFolder(folderId) })
          return
        }
        const body = parseJson(await readText(req))
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          json(res, 400, { error: '文件夹要有名字' })
          return
        }
        const clash = store.findAssetFolderByName(name)
        if (clash !== undefined && clash.id !== folderId) {
          json(res, 409, { error: `已经有一个叫「${name}」的文件夹了` })
          return
        }
        store.renameAssetFolder(folderId, name)
        json(res, 200, { folder: store.getAssetFolder(folderId) })
        return
      }

      // 素材列表：画布的资产浮窗与项目页共用。
      // **必须带上 url**：客户端拿它当 <img src>，少一个字段界面上就是一排空框，
      // 而类型里写着 `url: string`，编译器根本不会提醒。
      if (pathname === '/api/assets' && method === 'GET') {
        const kind = url.searchParams.get('kind')
        const folder = url.searchParams.get('folder')
        const limit = Number(url.searchParams.get('limit') ?? '500')
        json(res, 200, {
          assets: store.listAssets(Number.isFinite(limit) ? Math.min(2000, Math.max(1, limit)) : 500)
            .map((asset) => ({ ...asset, url: `/api/assets/${asset.id}` }))
            .filter((asset) => kind === null || kind === '' || kind === 'all' || asset.mime.startsWith(`${kind}/`))
            // `folder=none` 是「未分组」这个筛选值本身，不是某个文件夹的 id（id 是 uuid）。
            .filter((asset) => folder === null || folder === '' || folder === 'all'
              || (folder === 'none' ? asset.folderId === '' : asset.folderId === folder)),
        })
        return
      }

      // 把素材移进/移出文件夹（`folderId` 给空串就是退回未分组）。
      if (pathname === '/api/assets/move' && method === 'POST') {
        const body = parseJson(await readText(req))
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id): id is string => typeof id === 'string')
        const folderId = typeof body.folderId === 'string' ? body.folderId : ''
        if (ids.length === 0) {
          json(res, 400, { error: '没有选中任何素材' })
          return
        }
        if (folderId !== '' && store.getAssetFolder(folderId) === undefined) {
          json(res, 404, { error: '文件夹不存在' })
          return
        }
        json(res, 200, { ok: true, moved: store.moveAssets(ids, folderId) })
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
      const placeMatch = /^\/api\/canvases\/([^/]+)\/place$/u.exec(canvasPath)
      if (placeMatch !== null && method === 'POST') {
        const projectId = decodeURIComponent(placeMatch[1] as string)
        if (store.getCanvas(projectId) === undefined) {
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

      /**
       * 缩略图。
       *
       * 卡片与版本条上那些小格子原本直接拉原图：这台机器上 159 张 PNG 平均 1.28 MB，
       * 资产窗一屏 60 张就是 68 MB。缩到 320px 长边之后一屏是几百 KB。
       *
       * 缓存写在数据目录里（`thumbs/<id>-<size>.png`）：素材是内容寻址的，同一张图的
       * 缩略图永远一样，所以生成一次就够了。不支持的格式（JPEG、隔行、调色板）回 404，
       * **让调用方退回原图** —— 给一张错的缩略图比不给更糟。
       */
      const thumbMatch = /^\/api\/assets\/([^/]+)\/thumb$/u.exec(pathname)
      if (thumbMatch !== null && method === 'GET') {
        const asset = store.getAsset(decodeURIComponent(thumbMatch[1] as string))
        if (asset === undefined) {
          json(res, 404, { error: '素材不存在' })
          return
        }
        const size = Math.min(640, Math.max(64, Number.parseInt(url.searchParams.get('w') ?? '320', 10) || 320))
        const cached = join(config.dataDir, 'thumbs', `${asset.id}-${String(size)}.png`)
        try {
          const body = await readFile(cached)
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' })
          res.end(body)
          return
        } catch {
          // 没有缓存：现做一张。
        }
        let made: Buffer | undefined
        try {
          made = thumbnail(await readFile(store.assetPath(asset)), size)
        } catch {
          made = undefined
        }
        if (made === undefined) {
          json(res, 404, { error: '这张素材做不出缩略图（格式不支持），请直接用原图' })
          return
        }
        try {
          await mkdir(join(config.dataDir, 'thumbs'), { recursive: true })
          await writeFile(cached, made)
        } catch (error) {
          // 写不进缓存也要把图发出去：缓存是优化，不是功能。
          console.log(`[studio] 缩略图缓存写入失败：${String(error)}`)
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(made)
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
