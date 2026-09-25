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
import { applyGeneration, applyOps, makeNode, readDocument, resolvePrompt, writeDocument, type CanvasDocument, type CanvasOp } from './ops.ts'
import type { StudioGateway } from './gateway.ts'
import type { StudioStore } from './store.ts'

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
  /** Gateway used to render images. */
  gateway: StudioGateway
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
    description: '在画布上添加节点。kind=text 是文本节点（写故事/设定），kind=image 是图片节点（自带提示词，可自己出图）。返回新节点 id。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        kind: { type: 'string', enum: ['text', 'image'] },
        text: { type: 'string', description: '文本内容或提示词' },
        size: { type: 'string', description: '生成尺寸，如 1024x1024' },
        count: { type: 'number', description: '一次生成几张' },
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
    description: '把两个节点连起来。提示词节点 → 生成配置节点，表示后者用前者的文本作为提示词。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'canvas_generate',
    description:
      '用某个节点的提示词出图。图片节点自己就是生成目标：出图后画面落在该节点上，并成为它的一个版本。' +
      '这是唯一会耗时和消耗算力的工具，生成一张约 6 秒。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string', description: '图片节点 id' },
        prompt: { type: 'string', description: '覆盖提示词；省略则用节点自身或它上游文本节点的内容' },
        size: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['nodeId'],
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
      if (kind !== 'text' && kind !== 'image') throw new Error(`kind 必须是 text / image，收到：${kind}`)
      let created = ''
      mutate(projectId, 'add_node', (doc) => {
        const op: CanvasOp = {
          type: 'add_node',
          kind,
          ...(input.text === undefined ? {} : { text: text(input.text) }),
          ...(input.size === undefined ? {} : { size: text(input.size) }),
          ...(typeof input.count === 'number' ? { count: input.count } : {}),
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
        const [result] = applyOps(doc, [{ type: 'connect', from: text(input.from), to: text(input.to) }])
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
      // 图片节点自己就是生成目标；`config` 是旧文档里的镜头节点，仍然支持，
      // 但它的产物要新开画面节点（它自己不是一张图）。
      if (kind !== 'image' && kind !== 'config') {
        throw new Error(`只有图片节点能出图，${nodeId} 是 ${kind}`)
      }

      const prompt = text(input.prompt).trim() || resolvePrompt(doc, node)
      if (prompt === '') throw new Error('提示词为空：给这个节点写提示词，或连一个文本节点到它')

      // The history is created lazily and remembered on the node, exactly as the
      // canvas does it — an Agent-driven generation must be indistinguishable
      // from a human-driven one.
      let shotId = typeof node.data.shotId === 'string' ? node.data.shotId : ''
      if (shotId === '' || deps.store.getShot(shotId) === undefined) {
        shotId = deps.store.addShot(projectId, prompt.slice(0, 40), prompt).id
      }

      const history = deps.store.listTakes(shotId)
      const size = text(input.size).trim() || (typeof node.data.size === 'string' ? node.data.size : '1024x1024')
      const count = typeof input.count === 'number' ? input.count : (typeof node.data.count === 'number' ? node.data.count : 1)

      deps.log(`agent: 生成 ${prompt.slice(0, 30)}… (history ${shotId.slice(0, 8)}, ${String(count)} 张)`)
      const images = await deps.gateway.renderImage({ prompt, size, count, shotId })

      mutate(projectId, 'generate', (target) => {
        // 落点逻辑与作业运行器共用（见 ops.applyGeneration）：
        // 「生成好了之后画布上应该发生什么」只能有一个答案。
        const anchor = target.nodes.find((item) => item.id === nodeId)
        if (anchor === undefined) return
        if (kind === 'image') {
          applyGeneration(target, {
            nodeId,
            shotId,
            prompt,
            historyLength: history.length,
            files: images.map((image) => ({ url: image.url, ...(image.takeId === undefined ? {} : { takeId: image.takeId }) })),
          })
          return
        }
        anchor.data.shotId = shotId
        anchor.data.status = 'idle'
        if (anchor.data.text === '') anchor.data.text = prompt
        const originX = anchor.position.x + 460
        const originY = anchor.position.y
        images.forEach((image, index) => {
          target.nodes.push(makeNode('image', {
            text: prompt,
            url: image.url,
            x: originX,
            y: originY + index * 300,
            ...(image.takeId === undefined ? {} : { takeId: image.takeId }),
            takeNumber: history.length + index + 1,
          }))
        })
      })

      return {
        projectId,
        shotId,
        prompt,
        produced: images.length,
        nodeId,
        images: images.map((image) => ({ url: image.url, takeId: image.takeId })),
        takesSoFar: deps.store.listTakes(shotId).length,
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
