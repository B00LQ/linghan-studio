/**
 * ComfyUI driver.
 *
 * The canvas speaks OpenAI-shaped image calls; this driver translates one of
 * those into a ComfyUI workflow submission and turns the produced files back
 * into bytes. The workflow itself lives in `comfyui/z-image-turbo.json` in API
 * format, with `$placeholder` values substituted per request — so swapping
 * models means editing one JSON file, not this driver.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveGraph, suggestBindings, type StudioWorkflow } from './workflow-library.ts'

/** Default directory holding API-format workflow templates. */
const TEMPLATE_DIR = join(import.meta.dirname, 'comfyui')

/** How long one image generation may take before it is abandoned. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000

/**
 * How long one *video* generation may take.
 *
 * A different number, not a bigger one for everyone: a 5 秒 720p clip on a
 * 12 GB card measured 128 s of model staging before the first step, so the
 * image limit would kill a run that is working perfectly.
 */
const VIDEO_JOB_TIMEOUT_MS = 45 * 60 * 1000

/**
 * MIME by file extension.
 *
 * The driver used to assume every returned file was a PNG, which was true while
 * the only backend was an image model. A video workflow returns mp4 (and an
 * audio track inside it), and a wrong mime is not cosmetic: the asset library
 * picks the `<video>`/`<img>` element from it, and the stored file extension
 * comes from it too.
 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
}

/** Guess a mime type from the filename ComfyUI gave back. */
function mimeOfFile(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const ext = dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * The asset kind for a mime type — same vocabulary as the asset library.
 * @param mime - the file's mime type.
 * @returns `image`, `video`, `audio`, or `text`.
 */
function kindOfMime(mime: string): string {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'text'
}

/** How long to wait for the ComfyUI probe. */
const PROBE_TIMEOUT_MS = 5_000

/** What a self-check found. */
export interface ComfyUiCheck {
  /** Whether the server answered at all. */
  reachable: boolean
  /** Node classes the template needs but the server does not expose. */
  missingNodes: string[]
  /** Model files the template names but the server does not offer. */
  missingModels: string[]
  /** Reported ComfyUI version, when reachable. */
  version?: string
}

/** One generation request after normalization. */
export interface ComfyUiRequest {
  /** Prompt text. */
  prompt: string
  /** Target width in pixels. */
  width: number
  /** Target height in pixels. */
  height: number
  /** Number of images to produce. */
  count: number
  /** Override for sampler steps. */
  steps?: number
  /**
   * Clip length in seconds, for workflows that make video.
   *
   * Forwarded as a plain number and nothing more: how seconds become frames —
   * MiniMax H3 only accepts lengths of `5 + 17n` — is the workflow's business,
   * so the arithmetic lives in the graph (`ComfyMathExpression`) next to the
   * model it constrains, not here.
   */
  duration?: number
  /** Which stored workflow to run; the driver's default when omitted. */
  workflowId?: string
  /**
   * 输入图：**名字就是工作流里那个 `$占位符` 的名字**，也是画布节点的端口 id
   * （首帧 = `first`、尾帧 = `last`、参考图 = `ref`）。
   *
   * 名字用端口 id 而不是另起一套（从前叫 `firstFrame`），是为了**不要再有一张对照表**：
   * 服务端按入边填这张表，工作流用不到的键它自己会忽略。多一套命名就多一处会漂的地方。
   */
  inputs?: Record<string, { bytes: Buffer; name: string }>
  /**
   * 剪辑参数这类「非提示词、非尺寸」的取值，直接当工作流占位符的值用
   * （例如裁切的 `$start` / `$duration`）。
   *
   * 不把它们做成一个个具名字段（duration/steps/…）：那是「每加一个功能就改一次
   * 驱动签名」的路子，而工作流本来就是数据，多给几个键它自己会忽略。
   */
  params?: Record<string, number | string>
  /**
   * 固定种子。
   *
   * 省略就随机。「用这一版的参数再跑一次」要把它带上 —— 同参数 + 同种子才是复现，
   * 只同参数那是「再抽一次」。一批多张时从它开始按张递增。
   */
  seed?: number
}

/**
 * One progress report from the backend.
 *
 * Deliberately about *work*, not about ComfyUI: a cloud provider that reports
 * percentages, or one that reports nothing at all, maps onto the same shape.
 */
export interface GenerationProgress {
  /** Which stage the backend is in. */
  stage: 'queued' | 'sampling' | 'saving'
  /** Steps finished, when the backend counts them. */
  value?: number
  /** Steps total, when the backend counts them. */
  max?: number
  /** How many images of the batch are already done, 1-based. */
  image?: number
  /** How many images the batch has. */
  images?: number
}

/**
 * What a driver can promise about progress.
 *
 * Negotiated rather than assumed: the canvas asks the server what the active
 * driver supports and renders accordingly. A driver that reports nothing still
 * gets a sensible elapsed-time + historical-ETA display, so bringing up a new
 * provider cannot break the progress UI.
 */
export interface DriverCapabilities {
  /** `steps` when real step progress arrives; `none` when it does not. */
  progress: 'steps' | 'none'
}

/** Driver construction options. */
export interface ComfyUiOptions {
  /** ComfyUI base URL. */
  baseUrl: string
  /** Override for the template directory (tests). */
  templateDir?: string
  /** 远端实例的鉴权头（`Authorization: Bearer …`）；本机留空。 */
  authHeader?: string
  /** Diagnostics sink. */
  log: (message: string) => void
  /** Progress sink; omitted in tests and scripts that do not care. */
  onProgress?: (progress: GenerationProgress) => void
  /**
   * Resolve a workflow by id, or the default one when the id is empty.
   *
   * Injected rather than read from disk here, because the library (what the
   * operator uploaded) and the driver (how to run it) are different concerns.
   */
  resolveWorkflow?: (id: string) => StudioWorkflow | undefined
}

/**
 * One file a workflow produced, with the seed that produced it.
 *
 * Called an artifact rather than an image because a video workflow returns an
 * mp4 with an audio track — and naming that an image is how the mime type ended
 * up hardcoded in the first place.
 */
export interface ComfyUiArtifact {
  /** The bytes, exactly as ComfyUI served them. */
  bytes: Buffer
  /** Detected from the output filename. */
  mime: string
  /** `image` / `video` / `audio` / `text`, for the asset library. */
  kind: string
  /** Sampler seed, so the take can be reproduced later. */
  seed: number
}

/** The driver surface the gateway uses. */
export interface ComfyUiDriver {
  /** Probe the server and validate the template's nodes and models. */
  selfCheck: () => Promise<ComfyUiCheck>
  /**
   * Run one generation and return the files it produced.
   * @param request - normalized request.
   * @param onProgress - per-call progress sink, so two concurrent generations
   *   cannot mix their reports up.
   * @param onQueued - called with ComfyUI's prompt id the moment it accepts the
   *   work, so a caller can cancel *this* render later instead of interrupting
   *   whatever happens to be running.
   */
  generate: (
    request: ComfyUiRequest,
    onProgress?: (progress: GenerationProgress) => void,
    onQueued?: (comfyPromptId: string) => void,
  ) => Promise<ComfyUiArtifact[]>
  /**
   * Stop one submitted render.
   *
   * Queue deletion first, interrupt second: `POST /interrupt` has no prompt id
   * and stops whatever is executing, so it is only correct once we know our own
   * work is the thing running.
   */
  abort: (comfyPromptId: string) => Promise<void>
  /** What this driver can report while working. */
  capabilities: DriverCapabilities
  /**
   * ComfyUI's node catalogue, for validating an uploaded workflow.
   * @returns the catalogue, or null when ComfyUI cannot be reached.
   */
  objectInfo: () => Promise<Record<string, { input?: { required?: Record<string, unknown[]> } }> | null>
  /**
   * 换一个 ComfyUI 地址（设置页改完立刻生效）。
   *
   * 顺手清掉两处缓存：节点目录是按旧地址探的，模板缓存也不该跨实例留着。
   * @param baseUrl - the new base URL.
   */
  setBase: (baseUrl: string) => void
  /**
   * 换一个鉴权头（远端实例用）。
   *
   * 与 `setBase` 一样是**就地改**：设置页改完立刻生效，不用重启。
   * @param header - 一整行 `Authorization: Bearer xxx`；空串表示不带鉴权。
   */
  setAuth: (header: string) => void
}

/** Fetch with a hard timeout, so a hung ComfyUI cannot pin a request forever. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Watch one prompt's progress over ComfyUI's WebSocket.
 *
 * ComfyUI only streams to the client id that submitted the prompt, so this
 * connection has to exist before the submission — hence the `ready` promise the
 * caller awaits before posting the graph. Progress is a nicety: if the socket
 * cannot be opened, generation proceeds and the canvas falls back to ETA.
 * @param base - ComfyUI base URL.
 * @param clientId - client id the prompt will be submitted under.
 * @param onProgress - progress sink.
 * @param log - diagnostics sink.
 * @returns the socket plus a promise that resolves once it is open (or failed).
 */
function watchProgress(
  base: string,
  clientId: string,
  onProgress: (progress: GenerationProgress) => void,
  log: (message: string) => void,
): { socket: WebSocket | undefined; ready: Promise<void> } {
  const url = `${base.replace(/^http/u, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`
  let socket: WebSocket | undefined
  try {
    socket = new WebSocket(url)
  } catch (error) {
    log(`comfyui: 进度通道打不开（${error instanceof Error ? error.message : String(error)}），退回 ETA 显示`)
    return { socket: undefined, ready: Promise.resolve() }
  }
  let promptId = ''
  const ready = new Promise<void>((resolve) => {
    // A socket that never opens must not delay the actual work.
    const settle = setTimeout(() => { resolve() }, 1500)
    socket?.addEventListener('open', () => { clearTimeout(settle); resolve() })
    socket?.addEventListener('error', () => {
      clearTimeout(settle)
      log('comfyui: 进度通道出错，退回 ETA 显示')
      resolve()
    })
    socket?.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let message: { type?: string; data?: Record<string, unknown> }
      try {
        message = JSON.parse(event.data) as typeof message
      } catch {
        return
      }
      const data = message.data ?? {}
      const id = typeof data.prompt_id === 'string' ? data.prompt_id : ''
      if (id !== '') promptId = id
      // This socket sees the whole queue, so other clients' steps are filtered out.
      if (promptId !== '' && id !== '' && id !== promptId) return
      if (message.type === 'progress') {
        const value = typeof data.value === 'number' ? data.value : undefined
        const max = typeof data.max === 'number' ? data.max : undefined
        onProgress({ stage: 'sampling', ...(value === undefined ? {} : { value }), ...(max === undefined ? {} : { max }) })
        return
      }
      if (message.type === 'execution_start') onProgress({ stage: 'sampling' })
      if (message.type === 'executing' && (data.node === null || data.node === undefined)) onProgress({ stage: 'saving' })
    })
  })
  return { socket, ready }
}

/**
 * Build the ComfyUI driver.
 * @param options - base URL, template directory, and diagnostics.
 * @returns the driver surface.
 */
export function createComfyUiDriver(options: ComfyUiOptions): ComfyUiDriver {
  // **可变**：设置页改完地址要立刻生效，不必重启容器。所有用到 base 的地方都读这个
  // 变量本身，所以 setBase 之后下一次请求就走新地址。
  let base = options.baseUrl.replace(/\/+$/u, '')
  /**
   * 远端实例的鉴权头（形如 `Authorization: Bearer xxx`）。
   *
   * 本机 ComfyUI 不需要它；用户自己租的云实例通常挂在反向代理后面，需要。
   * 设置页里是一个字段（`COMFYUI_AUTH`），改完立刻生效。
   */
  let authHeader = options.authHeader ?? ''
  const directory = options.templateDir ?? TEMPLATE_DIR
  let cached: StudioWorkflow | undefined

  /**
   * The workflow to run.
   *
   * Prefers whatever the library hands back — that is where uploads live — and
   * falls back to the shipped template file so the driver still works when nobody
   * wired a library in (scripts, tests).
   */
  const template = async (id = ''): Promise<StudioWorkflow> => {
    const fromLibrary = options.resolveWorkflow?.(id)
    if (fromLibrary !== undefined) return fromLibrary
    if (cached !== undefined && id === '') return cached
    const raw = await readFile(join(directory, 'z-image-turbo.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StudioWorkflow>
    const built: StudioWorkflow = {
      id: parsed.id ?? 'z-image-turbo',
      title: parsed.title ?? 'Z-Image Turbo 文生图',
      capability: parsed.capability ?? 'image',
      source: parsed.source ?? '',
      requiredNodes: parsed.requiredNodes ?? [],
      graph: parsed.graph ?? {},
      bindings: parsed.bindings ?? {},
      defaults: parsed.defaults ?? {},
      models: parsed.models ?? {},
      optional: parsed.optional ?? [],
      requires: parsed.requires ?? [],
    }
    if (id === '') cached = built
    return built
  }

  const selfCheck = async (): Promise<ComfyUiCheck> => {
    const workflow = await template()
    let objectInfo: Record<string, { input?: { required?: Record<string, unknown[]> } }>
    let version: string | undefined
    try {
      const stats = await fetchWithTimeout(`${base}/system_stats`, {}, PROBE_TIMEOUT_MS)
      if (!stats.ok) return { reachable: false, missingNodes: [], missingModels: [] }
      const statsBody = (await stats.json()) as { system?: { comfyui_version?: string } }
      version = statsBody.system?.comfyui_version
      const response = await fetchWithTimeout(`${base}/object_info`, {}, 60_000)
      objectInfo = (await response.json()) as typeof objectInfo
    } catch {
      return { reachable: false, missingNodes: [], missingModels: [] }
    }

    const missingNodes = workflow.requiredNodes.filter((node) => !(node in objectInfo))
    const optionsOf = (node: string, input: string): string[] => {
      const list = objectInfo[node]?.input?.required?.[input]
      const first = Array.isArray(list) ? list[0] : undefined
      return Array.isArray(first) ? (first as string[]) : []
    }
    const missingModels: string[] = []
    const check = (available: string[], wanted: string): void => {
      if (wanted !== '' && !available.includes(wanted)) missingModels.push(wanted)
    }
    // 从图里认出模型文件，而不是写死三个 loader 的名字——
    // 上传的工作流可能用 GGUFLoader、LoraLoader 或别的东西。
    const { models } = suggestBindings(workflow.graph)
    for (const reference of Object.values(models)) {
      const classType = workflow.graph[reference.node]?.class_type ?? ''
      check(optionsOf(classType, reference.input), reference.value)
    }

    return { reachable: true, missingNodes, missingModels, ...(version === undefined ? {} : { version }) }
  }

  /**
   * Put one picture into ComfyUI's input directory.
   *
   * `LoadImage` 只接受「已经在 ComfyUI input 里的文件名」，所以画布上的图必须先过去
   * 一趟。文件名由调用方给（我们用素材 id）：内容寻址，同一张图重复用不会在那边堆副本，
   * 而且 `overwrite=true` 让重传同名文件是幂等的。
   * @param frame - bytes plus the file name to store it under.
   * @returns the name ComfyUI reports back (it may live in a subfolder).
   */
  const uploadImage = async (frame: { bytes: Buffer; name: string }): Promise<string> => {
    const form = new FormData()
    form.append('image', new Blob([frame.bytes]), frame.name)
    form.append('overwrite', 'true')
    const response = await fetchWithTimeout(`${base}/upload/image`, { method: 'POST', body: form }, 120_000)
    if (!response.ok) throw new Error(`把首帧送到 ComfyUI 失败：HTTP ${String(response.status)}`)
    const saved = (await response.json()) as { name?: string; subfolder?: string }
    if (typeof saved.name !== 'string' || saved.name === '') throw new Error('ComfyUI 上传成功但没回文件名')
    // subfolder 非空时，`LoadImage` 要的是「子目录/文件名」。丢掉它就会去找一个
    // 不存在的文件，而报错只说「找不到图」——那种错最难查。
    return saved.subfolder === undefined || saved.subfolder === '' ? saved.name : `${saved.subfolder}/${saved.name}`
  }

  /**
   * Submit one graph and wait for the files it produced.
   * @param libraryWorkflow - template to run.
   * @param request - normalized request.
   * @param seed - sampler seed for this run.
   * @param batch - 1-based index of this run inside the batch, when there is more than one.
   * @param report - progress sink for this call.
   */
  const runOnce = async (
    libraryWorkflow: StudioWorkflow,
    request: ComfyUiRequest,
    seed: number,
    batch: { index: number; total: number } | undefined,
    report: (progress: GenerationProgress) => void,
    onQueued?: (comfyPromptId: string) => void,
  ): Promise<{ bytes: Buffer; mime: string; kind: string }[]> => {
    // 输入图先送过去。顺序在这里是**故意**的：提交之前必须已经在 input 目录里，
    // 否则 ComfyUI 会在校验阶段就拒绝（找不到图）。
    const inputValues: Record<string, string> = {}
    for (const [name, image] of Object.entries(request.inputs ?? {})) {
      inputValues[name] = await uploadImage(image)
    }
    // 工作流声明了「必须有」的输入却没人给（比如选了图生图但没接参考图）：
    // **在这里拦住**，而不是让它跑出一张和参考图毫无关系的图。
    const missing = (libraryWorkflow.requires ?? []).filter((name) => inputValues[name] === undefined)
    if (missing.length > 0) {
      throw new Error(`工作流「${libraryWorkflow.title}」需要接上输入：${missing.join('、')}（图生图要参考图、图生视频要首帧），这次没有`)
    }

    // 一套机制运行所有工作流：上传的用显式绑定，内置的用 $占位符，
    // 两条路都收敛到 resolveGraph，驱动不需要分支。
    const graph = resolveGraph(libraryWorkflow, {
      ...libraryWorkflow.defaults,
      ...inputValues,
      ...(request.params ?? {}),
      width: request.width,
      height: request.height,
      ...(request.steps === undefined ? {} : { steps: request.steps }),
      ...(request.duration === undefined ? {} : { duration: request.duration }),
      prompt: request.prompt,
      seed,
      prefix: 'studio',
    })

    // The progress socket has to be up before the prompt is submitted: ComfyUI
    // only streams to the client id that owns the prompt.
    const clientId = `studio-${String(Date.now())}-${String(seed)}`
    const watch = watchProgress(base, clientId, (progress) => {
      report({ ...progress, ...(batch === undefined ? {} : { image: batch.index, images: batch.total }) })
    }, options.log)
    await watch.ready
    report({ stage: 'queued', ...(batch === undefined ? {} : { image: batch.index, images: batch.total }) })

    const submit = await fetchWithTimeout(`${base}/prompt`, {
      method: 'POST',
      headers: withAuth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    }, 30_000)
    const queued = (await submit.json()) as { prompt_id?: string; error?: unknown; node_errors?: unknown }
    if (!submit.ok || queued.prompt_id === undefined) {
      watch.socket?.close()
      // ComfyUI 把「哪个节点哪个输入不合格」放在 **node_errors** 里，
      // 而 error 本身只有一句 "Prompt outputs failed validation"。
      // 只报后者等于让人去猜——这正是我踩过的：一个字段名写错，
      // 报错信息里完全看不出来是哪一个。
      const nodeErrors = queued.node_errors === undefined || Object.keys(queued.node_errors as object).length === 0
        ? ''
        : ` 逐节点错误：${JSON.stringify(queued.node_errors).slice(0, 900)}`
      throw new Error(`ComfyUI 拒绝了工作流：${JSON.stringify(queued.error ?? queued).slice(0, 400)}${nodeErrors}`)
    }
    onQueued?.(queued.prompt_id)

    const timeoutMs = libraryWorkflow.capability === 'video' ? VIDEO_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    let entry: { outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>; status?: { status_str?: string; messages?: unknown[] } } | undefined
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const history = await fetchWithTimeout(`${base}/history/${queued.prompt_id}`, {}, 15_000)
        const body = (await history.json()) as Record<string, typeof entry>
        entry = body[queued.prompt_id as string]
        if (entry !== undefined) break
      }
    } finally {
      watch.socket?.close()
    }
    if (entry === undefined) {
      throw new Error(`ComfyUI 生成超时（${String(Math.round(timeoutMs / 60_000))} 分钟）`)
    }
    if ((entry.status?.status_str ?? '') !== 'success') {
      const failure = (entry.status?.messages ?? []).find((message) => Array.isArray(message) && message[0] === 'execution_error')
      throw new Error(`ComfyUI 执行失败：${JSON.stringify(failure ?? entry.status).slice(0, 400)}`)
    }

    // Every output node files its result under `images`, whatever it is: the
    // native video nodes (`SaveVideo` / `SaveWEBM`) put an mp4 there too, with an
    // `animated` flag beside it. So the mime has to come from the filename — the
    // key name is not evidence of the type.
    //
    // **但只取「汇点」节点的产物。** 预览型节点也会报 outputs：`LoadVideo` 把读进来的
    // 文件当成一次输出（`images` + `animated`），于是「把所有 outputs 平铺」这条在剪辑
    // 链路里会把**输入那段片子**当成产物返回——症状是「点了裁切，出来的还是原来那段」，
    // 而 HTTP 一切正常、take 也记了。真正的产物只可能来自没有被任何节点消费的节点。
    const consumed = new Set<string>()
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs ?? {})) {
        if (Array.isArray(value) && typeof value[0] === 'string') consumed.add(value[0])
      }
    }
    const produced = Object.entries(entry.outputs ?? {})
      .filter(([id]) => !consumed.has(id))
      .flatMap(([, node]) => node.images ?? [])
    if (produced.length === 0) throw new Error('ComfyUI 没有返回任何文件')
    report({ stage: 'saving', ...(batch === undefined ? {} : { image: batch.index, images: batch.total }) })
    const files: { bytes: Buffer; mime: string; kind: string }[] = []
    for (const file of produced) {
      const query = new URLSearchParams({
        filename: file.filename,
        subfolder: file.subfolder ?? '',
        type: file.type ?? 'output',
      })
      const response = await fetchWithTimeout(`${base}/view?${query.toString()}`, {}, 120_000)
      if (!response.ok) throw new Error(`取回文件失败：${file.filename}`)
      const mime = mimeOfFile(file.filename)
      files.push({ bytes: Buffer.from(await response.arrayBuffer()), mime, kind: kindOfMime(mime) })
    }
    return files
  }

  /** Node catalogue, cached briefly: the upload form may ask several times in a row. */
  let catalog: { at: number; value: Record<string, { input?: { required?: Record<string, unknown[]> } }> } | null = null

  /**
   * 给发往 ComfyUI 的请求加上鉴权头（远端实例用）。
   *
   * 用户填的是一整行 `Authorization: Bearer xxx`（也可能是 `X-API-Key: xxx`），
   * 这样不用猜是哪家的鉴权方案；填错了「测一下」会直接报出来。
   */
  const withAuth = (headers: Record<string, string>): Record<string, string> => {
    const text = authHeader.trim()
    const separator = text.indexOf(':')
    if (text === '' || separator <= 0) return headers
    return { ...headers, [text.slice(0, separator).trim()]: text.slice(separator + 1).trim() }
  }

  const objectInfo = async (): Promise<Record<string, { input?: { required?: Record<string, unknown[]> } }> | null> => {
    if (catalog !== null && Date.now() - catalog.at < 30_000) return catalog.value
    try {
      const response = await fetchWithTimeout(`${base}/object_info`, { headers: withAuth({}) }, 60_000)
      if (!response.ok) return null
      const value = (await response.json()) as Record<string, { input?: { required?: Record<string, unknown[]> } }>
      catalog = { at: Date.now(), value }
      return value
    } catch {
      return null
    }
  }

  return {
    selfCheck,
    capabilities: { progress: 'steps' },
    objectInfo,
    setAuth(header) {
      authHeader = header ?? ''
      // 换了实例/凭据，按旧实例探出来的目录与模板缓存都不算数了。
      catalog = null
      cached = undefined
      options.log(`comfyui: 鉴权头已${authHeader === '' ? '清空' : '更新'}`)
    },
    setBase(baseUrl) {
      base = baseUrl.replace(/\/+$/u, '')
      catalog = null
      cached = undefined
      options.log(`comfyui: 地址改为 ${base}`)
    },
    async generate(request, onProgress, onQueued) {
      const workflow = await template(request.workflowId ?? '')
      const started = Date.now()
      const artifacts: ComfyUiArtifact[] = []
      const report = onProgress ?? options.onProgress ?? ((): void => { /* nobody is listening */ })
      // Count > 1 runs sequentially: a 12 GB card cannot hold two concurrent
      // diffusion models, and ComfyUI's own queue would serialise them anyway.
      for (let index = 0; index < request.count; index += 1) {
        // 给了种子就用它：**「用这一版的参数再跑一次」要包括种子**，否则那只是
        // 「同样的提示词再抽一次」，而不是复现。一批多张时按 index 递进，
        // 否则四张会一模一样。
        const seed = request.seed === undefined
          ? Math.floor(Math.random() * 1_000_000_000)
          : (request.seed + index) % 1_000_000_000
        const batch = request.count > 1 ? { index: index + 1, total: request.count } : undefined
        for (const file of await runOnce(workflow, request, seed, batch, report, onQueued)) {
          artifacts.push({ ...file, seed })
        }
      }
      options.log(`comfyui: ${String(artifacts.length)} 个产物 in ${String(Math.round((Date.now() - started) / 1000))}s`)
      return artifacts
    },
    async abort(comfyPromptId) {
      // 已经跑完的不要去动它：下面那步 interrupt 会打到**下一个**任务身上。
      try {
        const history = await fetchWithTimeout(`${base}/history/${comfyPromptId}`, {}, 10_000)
        if (history.ok) {
          const body = (await history.json()) as Record<string, unknown>
          if (body[comfyPromptId] !== undefined) {
            options.log(`comfyui: ${comfyPromptId.slice(0, 8)} 已经跑完，无需中止`)
            return
          }
        }
      } catch {
        // 查不到就当它还在跑，继续往下走。
      }
      try {
        const removed = await fetchWithTimeout(`${base}/queue`, {
          method: 'POST',
          headers: withAuth({ 'content-type': 'application/json' }),
          body: JSON.stringify({ delete: [comfyPromptId] }),
        }, 10_000)
        if (removed.ok) {
          const body = (await removed.json()) as { delete?: number }
          if ((body.delete ?? 0) > 0) {
            options.log(`comfyui: 已从队列删除 ${comfyPromptId.slice(0, 8)}`)
            return
          }
        }
      } catch (error) {
        options.log(`comfyui: 队列删除失败 ${String(error)}`)
      }
      // 还在队列里没轮到 / 已经删不掉 → 它就是在跑的那个。
      const stopped = await fetchWithTimeout(`${base}/interrupt`, { method: 'POST' }, 10_000)
      options.log(`comfyui: interrupt ${comfyPromptId.slice(0, 8)} → HTTP ${String(stopped.status)}`)
    },
  }
}
