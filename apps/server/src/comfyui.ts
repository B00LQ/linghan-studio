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

/** How long one generation may take before it is abandoned. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000

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
  /** Which stored workflow to run; the driver's default when omitted. */
  workflowId?: string
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

/** One produced image, with the seed that produced it. */
export interface ComfyUiImage {
  /** PNG bytes. */
  bytes: Buffer
  /** Sampler seed, so the take can be reproduced later. */
  seed: number
}

/** The driver surface the gateway uses. */
export interface ComfyUiDriver {
  /** Probe the server and validate the template's nodes and models. */
  selfCheck: () => Promise<ComfyUiCheck>
  /**
   * Run one generation and return PNG bytes.
   * @param request - normalized request.
   * @param onProgress - per-call progress sink, so two concurrent generations
   *   cannot mix their reports up.
   */
  generate: (request: ComfyUiRequest, onProgress?: (progress: GenerationProgress) => void) => Promise<ComfyUiImage[]>
  /** What this driver can report while working. */
  capabilities: DriverCapabilities
  /**
   * ComfyUI's node catalogue, for validating an uploaded workflow.
   * @returns the catalogue, or null when ComfyUI cannot be reached.
   */
  objectInfo: () => Promise<Record<string, { input?: { required?: Record<string, unknown[]> } }> | null>
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
  const base = options.baseUrl.replace(/\/+$/u, '')
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
   * Submit one graph and wait for its produced images.
   * @param workflow - template to run.
   * @param request - normalized request.
   * @param seed - sampler seed for this image.
   * @param batch - 1-based index of this image inside the batch, when there is more than one.
   * @param report - progress sink for this call.
   */
  const runOnce = async (
    libraryWorkflow: StudioWorkflow,
    request: ComfyUiRequest,
    seed: number,
    batch: { index: number; total: number } | undefined,
    report: (progress: GenerationProgress) => void,
  ): Promise<Buffer[]> => {
    // 一套机制运行所有工作流：上传的用显式绑定，内置的用 $占位符，
    // 两条路都收敛到 resolveGraph，驱动不需要分支。
    const graph = resolveGraph(libraryWorkflow, {
      ...libraryWorkflow.defaults,
      width: request.width,
      height: request.height,
      ...(request.steps === undefined ? {} : { steps: request.steps }),
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    }, 30_000)
    const queued = (await submit.json()) as { prompt_id?: string; error?: unknown }
    if (!submit.ok || queued.prompt_id === undefined) {
      watch.socket?.close()
      throw new Error(`ComfyUI 拒绝了工作流：${JSON.stringify(queued.error ?? queued).slice(0, 400)}`)
    }

    const deadline = Date.now() + JOB_TIMEOUT_MS
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
    if (entry === undefined) throw new Error('ComfyUI 生成超时（10 分钟）')
    if ((entry.status?.status_str ?? '') !== 'success') {
      const failure = (entry.status?.messages ?? []).find((message) => Array.isArray(message) && message[0] === 'execution_error')
      throw new Error(`ComfyUI 执行失败：${JSON.stringify(failure ?? entry.status).slice(0, 400)}`)
    }

    const images = Object.values(entry.outputs ?? {}).flatMap((node) => node.images ?? [])
    if (images.length === 0) throw new Error('ComfyUI 没有返回图片')
    report({ stage: 'saving', ...(batch === undefined ? {} : { image: batch.index, images: batch.total }) })
    const buffers: Buffer[] = []
    for (const image of images) {
      const query = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder ?? '',
        type: image.type ?? 'output',
      })
      const response = await fetchWithTimeout(`${base}/view?${query.toString()}`, {}, 60_000)
      if (!response.ok) throw new Error(`取回图片失败：${image.filename}`)
      buffers.push(Buffer.from(await response.arrayBuffer()))
    }
    return buffers
  }

  /** Node catalogue, cached briefly: the upload form may ask several times in a row. */
  let catalog: { at: number; value: Record<string, { input?: { required?: Record<string, unknown[]> } }> } | null = null
  const objectInfo = async (): Promise<Record<string, { input?: { required?: Record<string, unknown[]> } }> | null> => {
    if (catalog !== null && Date.now() - catalog.at < 30_000) return catalog.value
    try {
      const response = await fetchWithTimeout(`${base}/object_info`, {}, 60_000)
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
    async generate(request, onProgress) {
      const workflow = await template(request.workflowId ?? '')
      const started = Date.now()
      const images: ComfyUiImage[] = []
      const report = onProgress ?? options.onProgress ?? ((): void => { /* nobody is listening */ })
      // Count > 1 runs sequentially: a 12 GB card cannot hold two concurrent
      // diffusion models, and ComfyUI's own queue would serialise them anyway.
      for (let index = 0; index < request.count; index += 1) {
        const seed = Math.floor(Math.random() * 1_000_000_000)
        const batch = request.count > 1 ? { index: index + 1, total: request.count } : undefined
        for (const bytes of await runOnce(workflow, request, seed, batch, report)) images.push({ bytes, seed })
      }
      options.log(`comfyui: ${String(images.length)} 张 in ${String(Math.round((Date.now() - started) / 1000))}s`)
      return images
    },
  }
}
