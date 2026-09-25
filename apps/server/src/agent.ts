/**
 * Agent tool face.
 *
 * This is the second entry point: what a human does by clicking, an external
 * Agent does by calling these tools over HTTP. Both end up mutating the same
 * document and recording the same shots and takes, which is what makes the two
 * entries genuinely equal rather than two parallel products sharing a logo.
 *
 * Every tool returns plain JSON, and every failure comes back as a message an
 * Agent can act on rather than a stack trace.
 */
import { applyOps, readDocument, resolvePrompt, writeDocument, CONNECTABLE_PORTS, type CanvasDocument, type CanvasOp } from './ops.ts'
import type { JobRequest, StudioJob } from './jobs.ts'
import type { StudioStore } from './store.ts'
import type { StudioWorkflow, WorkflowCapability } from './workflow-library.ts'

/** One tool the agent face exposes. */
export interface AgentTool {
  /** Tool name. */
  name: string
  /** What it does, for a model choosing between tools. */
  description: string
  /** JSON Schema for the input. */
  inputSchema: Record<string, unknown>
}

/** Everything the tool face needs. */
export interface AgentDeps {
  /** Domain store holding the document, shots, and takes. */
  store: StudioStore
  /**
   * Submit a render job.
   *
   * **不是**「直接渲染」：这条函数就是画布点「生成」和 `POST /api/jobs` 用的那一条，
   * 三处共用一份提交逻辑。Agent 因此不需要（也不该）自己握着网关 —— 从前它直接
   * `await gateway.renderImage`，图片 6 秒还行，视频十几分钟就和画布点击撞上同一个超时。
   */
  submitRender: (request: JobRequest) => StudioJob
  /** Read one job back, for the polling tool. */
  findJob: (id: string) => StudioJob | undefined
  /** Cancel one job. */
  cancelJob: (id: string) => Promise<boolean>
  /** Workflows this machine knows about, for kind-aware defaulting. */
  workflows: () => StudioWorkflow[]
  /** Called after a tool changes a project's document. */
  onDocumentChanged: (projectId: string, reason: string) => void
  /** Diagnostics sink. */
  log: (message: string) => void
}

/** The tool catalogue, in the order a model should consider them. */
export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'canvas_state',
    description: '读取某个项目的画布内容：节点（含类型、提示词、尺寸、所属镜头）与连线。做任何修改前先读它。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: '项目 id；省略则用最近更新的项目' } },
      required: [],
    },
  },
  {
    name: 'canvas_add_node',
    description:
      '在画布上添加节点。kind=text 是文本节点（写故事/设定），kind=image 是图片节点（自带提示词，可自己出图），'
      + 'kind=video 是视频节点（自带提示词，出片带声音；**一条可能十几分钟**），'
      + 'kind=trim 是裁切节点（接一段视频，cut 出其中一段；秒级），kind=concat 是拼接节点（接两段视频接成一条；秒级），'
      + 'kind=audio 是音频节点（把文字念成人声；秒级）。返回新节点 id。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        kind: { type: 'string', enum: ['text', 'image', 'video', 'trim', 'concat', 'audio'] },
        text: { type: 'string', description: '文本内容或提示词' },
        size: { type: 'string', description: '生成尺寸：图片如 1024x1024，视频只有 1344x768 / 768x448' },
        count: { type: 'number', description: '一次生成几张（只对图片有意义）' },
        duration: { type: 'number', description: '片长（秒）：视频节点默认 5，裁切节点默认 3（要裁多长）' },
        start: { type: 'number', description: '裁切从第几秒开始（只对 trim 有意义），默认 0' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'canvas_set_text',
    description: '修改某个节点的文本（提示词）。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, nodeId: { type: 'string' }, text: { type: 'string' } },
      required: ['nodeId', 'text'],
    },
  },
  {
    name: 'canvas_connect',
    description:
      '把两个节点连起来：文本节点 → 图片/视频节点表示「拿它的文本当提示词」，'
      + '图片节点 → 视频节点表示「拿它当首帧」（图生视频），图片 → 图片表示「拿它当参考图」（图生图），'
      + '视频 → 裁切/拼接节点表示「拿它当要剪的片子」。'
      + '多入口的节点默认按两头类型选（文本进提示词、图片进首帧/参考图、视频进裁切或拼接的前一段）；'
      + '要接尾帧给 port="last"、拼接的后一段给 port="in1"。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        from: { type: 'string', description: '起点节点 id（产物来自它）' },
        to: { type: 'string', description: '终点节点 id（产物进它）' },
        port: { type: 'string', enum: [...CONNECTABLE_PORTS], description: '进哪个入边；省略则按上游类型挑' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'canvas_generate',
    description:
      '用某个节点的提示词生成画面。图片和视频节点都能出（视频一条可能十几分钟）。' +
      '**它不等出完**：图片默认最多等 20 秒、视频立刻返回，返回里带 jobId。' +
      '没出完就用 job_status 接着查——在 job_status 说 succeeded 之前，' +
      '不要对用户说「已经生成好了」。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string', description: '图片或视频节点 id' },
        prompt: { type: 'string', description: '覆盖提示词；省略则用节点自身或它上游文本节点的内容' },
        size: { type: 'string', description: 'WxH；省略则用节点上选的那档' },
        count: { type: 'number', description: '出几张（只对图片有意义）' },
        workflow: { type: 'string', description: '用哪套工作流；省略则用节点上选的那套' },
        duration: { type: 'number', description: '片长（秒），只对视频工作流有意义' },
        waitMs: { type: 'number', description: '最多等多久拿结果（毫秒，上限 50000；图片默认 20000、视频默认 0）' },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'job_status',
    description:
      '查一次生成作业的状态与进度。status 为 queued/running 时还没出结果，' +
      'succeeded 时画布上的节点已经被服务端更新好了（不用再调用别的工具写画布）。',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'job_cancel',
    description:
      '中止一个还在跑的生成作业（比如方向错了的视频）。取消是尽力而为：' +
      '如果那一刻它刚好渲染完，结果会作为新版本留下，note 里会说清楚。',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'canvas_context',
    description:
      '读取人类在画布上「添加到 Agent」的那几个节点。这是人明确指给你的上下文：' +
      '当你不知道他指的是哪几个节点时，先读这个，而不是猜或者读整张画布。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: '项目 id；省略则用最近更新的项目' } },
      required: [],
    },
  },
  {
    name: 'shot_takes',
    description: '列出一个镜头（生成配置节点）的所有版本，含提示词、种子、耗时、是否已选用。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, nodeId: { type: 'string' } },
      required: ['nodeId'],
    },
  },
  {
    name: 'shot_select_take',
    description: '在某个镜头的多个版本里选定一个。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, nodeId: { type: 'string' }, takeId: { type: 'string' } },
      required: ['nodeId', 'takeId'],
    },
  },
]

/** Coerce a value to a string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Which workflow a generated node should run.
 *
 * 和画布上 `workflowFor` 同一条规矩：**先看节点自己选的那套，再退到同类里第一套**。
 * 关键是「同类」——空 id 交给服务端会解析成「第一套工作流」，那是出图的那套，
 * 放在视频节点上会出一张放不出来的 PNG（画布上正是这么错过一次）。
 * @param workflows - every workflow this machine knows about.
 * @param capability - what the node produces.
 * @param wanted - the id the node (or the caller) picked; may be empty.
 * @returns a workflow id, or empty when this machine has none of that kind.
 */
export function resolveWorkflowId(workflows: StudioWorkflow[], capability: WorkflowCapability, wanted: string): string {
  const ofKind = workflows.filter((workflow) => workflow.capability === capability)
  if (wanted !== '' && ofKind.some((workflow) => workflow.id === wanted)) return wanted
  return ofKind[0]?.id ?? ''
}

/** Waiting is bounded on purpose: see the note in `canvas_generate`. */
const MAX_WAIT_MS = 50_000

/** Clamp a caller-supplied wait into `[0, MAX_WAIT_MS]`. */
function clampWait(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.min(MAX_WAIT_MS, Math.round(ms)))
}

/**
 * Wait for a job to leave `queued`/`running`, up to `waitMs`.
 * @param find - registry lookup.
 * @param id - job id.
 * @param waitMs - how long to wait; 0 checks once and returns.
 * @returns the settled job, or undefined when it is still running (or unknown).
 */
async function waitForJob(find: (id: string) => StudioJob | undefined, id: string, waitMs: number): Promise<StudioJob | undefined> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const job = find(id)
    if (job === undefined) return undefined
    if (job.status !== 'queued' && job.status !== 'running') return job
    if (Date.now() >= deadline) return undefined
    // 250 ms 一跳：6 秒的图片最多多等 0.25 秒，而十几分钟的视频本来就不等。
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
}

/**
 * Build the tool face.
 * @param deps - store, gateway, change notification, and diagnostics.
 * @returns a dispatcher plus the catalogue.
 */
export function createAgentFace(deps: AgentDeps): {
  tools: () => AgentTool[]
  call: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>
} {
  /** Resolve which project a call concerns, defaulting to the most recent. */
  const project = (input: Record<string, unknown>): string => {
    const requested = text(input.projectId).trim()
    if (requested !== '') {
      if (deps.store.getProject(requested) === undefined) throw new Error(`项目不存在：${requested}`)
      return requested
    }
    const newest = deps.store.listProjects()[0]
    if (newest === undefined) throw new Error('还没有任何项目，先在 Studio 里创建一个')
    return newest.id
  }

  /** Load a document, run a mutation, save it, and tell watching canvases. */
  const mutate = (projectId: string, reason: string, mutateDoc: (doc: CanvasDocument) => void): CanvasDocument => {
    const doc = readDocument(deps.store, projectId)
    mutateDoc(doc)
    writeDocument(deps.store, projectId, doc)
    deps.onDocumentChanged(projectId, reason)
    return doc
  }

  /** Summarize a node for agent consumption. */
  const summarize = (node: CanvasDocument['nodes'][number]): Record<string, unknown> => ({
    id: node.id,
    kind: node.data.kind,
    ...(typeof node.data.name === 'string' && node.data.name !== '' ? { name: node.data.name } : {}),
    text: typeof node.data.text === 'string' ? node.data.text : '',
    ...(node.data.kind === 'image' || node.data.kind === 'config' ? { size: node.data.size, count: node.data.count } : {}),
    ...(typeof node.data.url === 'string' && node.data.url !== '' ? { url: node.data.url } : {}),
    ...(typeof node.data.shotId === 'string' && node.data.shotId !== '' ? { shotId: node.data.shotId } : {}),
    ...(typeof node.data.takeNumber === 'number' ? { takeNumber: node.data.takeNumber } : {}),
    position: node.position,
  })

  const call = async (name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name === 'canvas_state') {
      const projectId = project(input)
      const doc = readDocument(deps.store, projectId)
      return {
        projectId,
        nodes: doc.nodes.map(summarize),
        edges: doc.edges.map((edge) => ({ id: edge.id, from: edge.source, to: edge.target })),
      }
    }

    if (name === 'canvas_context') {
      const projectId = project(input)
      const doc = readDocument(deps.store, projectId)
      const ids = Array.isArray(doc.agentContext) ? doc.agentContext : []
      const wanted = new Set(ids)
      return {
        projectId,
        // A node removed from the canvas is dropped here too, so the Agent never
        // receives a dangling reference it would have to reason about.
        nodes: doc.nodes.filter((node) => wanted.has(node.id)).map(summarize),
        note: ids.length === 0 ? '人类还没有把任何节点加入 Agent 上下文' : '',
      }
    }

    if (name === 'canvas_add_node') {
      const projectId = project(input)
      const kind = text(input.kind)
      const canvasKinds = ['text', 'image', 'video', 'trim', 'concat', 'audio'] as const
      if (!canvasKinds.includes(kind as typeof canvasKinds[number])) {
        throw new Error(`kind 必须是 ${canvasKinds.join(' / ')}，收到：${kind}`)
      }
      let created = ''
      mutate(projectId, 'add_node', (doc) => {
        const op: CanvasOp = {
          type: 'add_node',
          kind: kind as typeof canvasKinds[number],
          ...(input.text === undefined ? {} : { text: text(input.text) }),
          ...(input.size === undefined ? {} : { size: text(input.size) }),
          ...(typeof input.count === 'number' ? { count: input.count } : {}),
          ...(typeof input.duration === 'number' ? { duration: input.duration } : {}),
          ...(typeof input.start === 'number' ? { start: input.start } : {}),
          ...(typeof input.x === 'number' ? { x: input.x } : {}),
          ...(typeof input.y === 'number' ? { y: input.y } : {}),
        }
        const [result] = applyOps(doc, [op])
        created = result?.nodeId ?? ''
      })
      return { projectId, nodeId: created }
    }

    if (name === 'canvas_set_text') {
      const projectId = project(input)
      const nodeId = text(input.nodeId)
      mutate(projectId, 'set_text', (doc) => {
        applyOps(doc, [{ type: 'set_text', nodeId, text: text(input.text) }])
      })
      return { projectId, nodeId, ok: true }
    }

    if (name === 'canvas_connect') {
      const projectId = project(input)
      let edgeId = ''
      mutate(projectId, 'connect', (doc) => {
        const [result] = applyOps(doc, [{
          type: 'connect',
          from: text(input.from),
          to: text(input.to),
          ...(text(input.port).trim() === '' ? {} : { port: text(input.port).trim() }),
        }])
        edgeId = result?.edgeId ?? ''
      })
      return { projectId, edgeId, ok: true }
    }

    if (name === 'canvas_generate') {
      const projectId = project(input)
      const nodeId = text(input.nodeId)
      const doc = readDocument(deps.store, projectId)
      const node = doc.nodes.find((item) => item.id === nodeId)
      if (node === undefined) throw new Error(`节点不存在：${nodeId}`)
      const kind = String(node.data.kind)
      // 只有「自己就是一张画面」的节点能生成。旧文档里的 `config`（镜头）节点曾经
      // 走一条单独的路（产物新开图片节点），但本机含回收站一个都没有 —— 与其长期
      // 维护两条生成路径（两套行为要一直对齐），不如只留一条，让它也走作业。
      if (kind !== 'image' && kind !== 'video') {
        throw new Error(`只有图片或视频节点能生成，${nodeId} 是 ${kind}`)
      }

      const prompt = text(input.prompt).trim() || resolvePrompt(doc, node)
      if (prompt === '') throw new Error('提示词为空：给这个节点写提示词，或连一个文本节点到它')

      // 工作流按**节点类型**挑。空 id 直接交给服务端会拿到「第一套」——那是出图的
      // 那套，放在视频节点上就会出一张放不出来的 PNG（画布上正是这么错过一次）。
      const wanted = text(input.workflow).trim() || (typeof node.data.workflow === 'string' ? node.data.workflow : '')
      const capability: WorkflowCapability = kind === 'video' ? 'video' : 'image'
      const workflowId = resolveWorkflowId(deps.workflows(), capability, wanted)
      const size = text(input.size).trim() || (typeof node.data.size === 'string' ? node.data.size : '')
      const count = typeof input.count === 'number' ? input.count : (typeof node.data.count === 'number' ? node.data.count : undefined)
      const duration = typeof input.duration === 'number'
        ? input.duration
        : (kind === 'video' && typeof node.data.duration === 'number' ? node.data.duration : undefined)

      deps.log(`agent: 提交生成 ${prompt.slice(0, 30)}…（${kind}${workflowId === '' ? '' : `，${workflowId}`}）`)
      // **复用节点上已有的镜头。** 不传的话作业运行器每次都会新建一个，于是同一个
      // 节点的第二张图会落到另一条版本线上——旧实现是在这里读 `node.data.shotId` 的，
      // 改走作业时我漏了这一步，是旧用例（「两次用的是同一个节点的历史」）把它抓出来的。
      const existingShot = typeof node.data.shotId === 'string' ? node.data.shotId : ''
      const reuse = existingShot !== '' && deps.store.getShot(existingShot) !== undefined
      // **走作业，不再同步等。** 镜头与版本由运行器去建、结果由运行器写回画布文档，
      // 与画布点击完全同一条路 —— 「生成好了之后画布上应该发生什么」只有一个答案。
      const job = deps.submitRender({
        projectId,
        nodeId,
        prompt,
        ...(reuse ? { shotId: existingShot } : {}),
        ...(size === '' ? {} : { size }),
        ...(count === undefined ? {} : { count }),
        ...(workflowId === '' ? {} : { workflowId }),
        ...(duration === undefined ? {} : { duration }),
      })

      // 有上限地等：图片默认 20 秒（够出完，调用方不用在两步之间折腾自己），
      // 视频默认 0（十几分钟的活儿，等 20 秒纯粹是白等）。上限 50 秒是因为
      // nginx 默认 60 秒就 504 —— 等得比它久，等于没等。
      const waitMs = clampWait(typeof input.waitMs === 'number' ? input.waitMs : (kind === 'video' ? 0 : 20_000))
      const settled = await waitForJob(deps.findJob, job.id, waitMs)

      if (settled === undefined) {
        return {
          projectId,
          nodeId,
          jobId: job.id,
          status: job.status,
          kind,
          prompt,
          note: `还没出结果（${kind === 'video' ? '视频一条要十几分钟' : '这次比平时久'}）：用 job_status 查 jobId=${job.id}。`
            + '画布上的节点会在出完之后自己更新，所以**不要**说「已经生成好了」。',
        }
      }
      if (settled.status === 'failed') throw new Error(`生成失败：${settled.error ?? '未知原因'}`)

      const files = settled.files ?? []
      return {
        projectId,
        nodeId,
        jobId: settled.id,
        status: settled.status,
        kind,
        prompt,
        ...(settled.shotId === undefined ? {} : { shotId: settled.shotId }),
        produced: files.length,
        files: files.map((file) => ({ url: file.url, ...(file.takeId === undefined ? {} : { takeId: file.takeId }) })),
        takesSoFar: settled.takes ?? 0,
      }
    }

    if (name === 'job_status') {
      const jobId = text(input.jobId).trim()
      const job = deps.findJob(jobId)
      // 作业只活在服务进程里：重启会丢掉未完成的那些（已完成的 take 与素材都在库里）。
      if (job === undefined) throw new Error(`没有这个作业：${jobId}（作业不落盘，服务重启会丢）`)
      const running = job.status === 'queued' || job.status === 'running'
      return {
        jobId: job.id,
        projectId: job.request.projectId,
        nodeId: job.request.nodeId,
        status: job.status,
        progress: job.progress ?? null,
        ...(job.error === undefined ? {} : { error: job.error }),
        ...(job.note === undefined ? {} : { note: job.note }),
        ...(job.shotId === undefined ? {} : { shotId: job.shotId }),
        files: (job.files ?? []).map((file) => ({ url: file.url, ...(file.takeId === undefined ? {} : { takeId: file.takeId }) })),
        takesSoFar: job.takes ?? 0,
        hint: running
          ? '还在跑：过一会儿再查一次，别对用户说已经生成好了'
          : '已结束，画布上的节点已经由服务端更新过（不需要再调用工具写画布）',
      }    }

    if (name === 'job_cancel') {
      const jobId = text(input.jobId).trim()
      const accepted = await deps.cancelJob(jobId)
      const job = deps.findJob(jobId)
      return {
        jobId,
        ok: accepted,
        status: job?.status ?? 'unknown',
        ...(job?.note === undefined ? {} : { note: job.note }),
        ...(accepted ? {} : { reason: job === undefined ? '没有这个作业（作业不落盘，服务重启会丢）' : '它已经结束了，取消不了' }),
      }
    }

    if (name === 'shot_takes') {
      const projectId = project(input)
      const doc = readDocument(deps.store, projectId)
      const node = doc.nodes.find((item) => item.id === text(input.nodeId))
      const shotId = node === undefined ? '' : (typeof node.data.shotId === 'string' ? node.data.shotId : '')
      if (shotId === '') return { projectId, takes: [], note: '这个节点还没有生成过，因此还没有镜头与版本' }
      return { projectId, shotId, takes: deps.store.listTakes(shotId) }
    }

    if (name === 'shot_select_take') {
      const projectId = project(input)
      const doc = readDocument(deps.store, projectId)
      const node = doc.nodes.find((item) => item.id === text(input.nodeId))
      const shotId = node === undefined ? '' : (typeof node.data.shotId === 'string' ? node.data.shotId : '')
      if (shotId === '') throw new Error('这个节点还没有生成过，没有可选的版本')
      const takeId = text(input.takeId)
      if (!deps.store.listTakes(shotId).some((take) => take.id === takeId)) throw new Error(`该镜头下没有这个版本：${takeId}`)
      deps.store.selectTake(shotId, takeId)
      deps.onDocumentChanged(projectId, 'select_take')
      return { projectId, shotId, takeId, ok: true }
    }

    throw new Error(`未知工具：${name}。可用工具：${AGENT_TOOLS.map((tool) => tool.name).join(', ')}`)
  }

  return { tools: () => AGENT_TOOLS, call }
}
