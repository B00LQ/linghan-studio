/**
 * Server-side canvas operations.
 *
 * The canvas document lives in SQLite, so operations are applied there rather
 * than by remote-controlling a browser. That is what lets an Agent work with no
 * tab open, and it means a human click and an Agent call mutate the same
 * document through the same shape — which is the entire promise of having two
 * entry points.
 *
 * The node shape here is the canvas's real shape (`kind` + `data`), not a
 * parallel vocabulary: an earlier version of this system kept its own op schema
 * and the two drifted until neither could read the other.
 */
import { randomUUID } from 'node:crypto'
import type { StudioStore } from './store.ts'

/** A canvas node as the document stores it. */
interface CanvasNode {
  id: string
  type: 'studio'
  position: { x: number; y: number }
  data: Record<string, unknown>
  [key: string]: unknown
}

/** A canvas edge as the document stores it. */
interface CanvasEdge {
  id: string
  source: string
  target: string
  [key: string]: unknown
}

/** The canvas document. */
export interface CanvasDocument {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: { x: number; y: number; zoom: number }
  /**
   * Node ids the human handed to the Agent as context.
   *
   * Stored with the work rather than in browser state: "look at these" is part
   * of what the operator meant, and an Agent must be able to read it without a
   * particular tab being open. Pruned whenever a node is deleted, so it cannot
   * accumulate references to nodes that no longer exist.
   */
  agentContext?: string[]
}

/** One operation to apply. */
export type CanvasOp =
  | { type: 'add_node'; kind: 'text' | 'image' | 'video' | 'config' | 'grid'; text?: string; size?: string; count?: number; duration?: number; x?: number; y?: number }
  | { type: 'set_text'; nodeId: string; text: string }
  | { type: 'set_config'; nodeId: string; size?: string; count?: number }
  | { type: 'connect'; from: string; to: string; port?: string }
  | { type: 'delete_node'; nodeId: string }

/** What one operation produced. */
export interface OpResult {
  /** Operation that ran. */
  type: string
  /** Node the operation concerned, when there is one. */
  nodeId?: string
  /** Edge the operation created, when there is one. */
  edgeId?: string
  /** Human-readable outcome. */
  note?: string
}

/** Read a project's document, creating an empty one when never saved. */
export function readDocument(store: StudioStore, projectId: string): CanvasDocument {
  if (store.getCanvas(projectId) === undefined) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  return readRaw(store.getCanvas(projectId) as string)
}

/**
 * Parse a stored document.
 *
 * Every top-level field must be carried through explicitly. Rebuilding the
 * object from just `nodes`/`edges`/`viewport` silently dropped the rest — and
 * since a mutation reads, edits and writes the whole document back, one Agent
 * call used to erase the human's 「添加到 Agent」 selection. Fields the canvas
 * owns belong here too, not only in the browser's type.
 */
function readRaw(raw: string): CanvasDocument {
  const empty: CanvasDocument = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return empty
    const doc = parsed as Partial<CanvasDocument>
    return {
      ...doc,
      nodes: Array.isArray(doc.nodes) ? doc.nodes : [],
      edges: Array.isArray(doc.edges) ? doc.edges : [],
      viewport: doc.viewport ?? { x: 0, y: 0, zoom: 1 },
    }
  } catch {
    return empty
  }
}

/** Persist a document. */
export function writeDocument(store: StudioStore, projectId: string, doc: CanvasDocument): void {
  store.saveCanvas(projectId, JSON.stringify(doc))
}

/** Build one node with the canvas's real shape. */
export function makeNode(kind: 'text' | 'image' | 'video' | 'config' | 'grid', options: {
  text?: string
  size?: string
  count?: number
  /** Clip length in seconds; video nodes only. */
  duration?: number
  x?: number
  y?: number
  url?: string
  takeId?: string
  takeNumber?: number
  shotId?: string
} = {}): CanvasNode {
  // `config` and `grid` are legacy kinds. Documents written by earlier versions
  // still contain them, so creating one must stay possible; the canvas converts
  // `config` to `image` on load so the operator sees the two-kind model.
  //
  // `video` 的默认值要和前端 `ports.ts` 的 `initialData('video')` **逐字一致**
  // （1344×768、5 秒、没有 count）—— 否则 Agent 建的视频节点和人在画布上建的
  // 会长得不一样，而这两条路本来就该等价。
  const base: Record<string, unknown> = kind === 'text'
    ? { kind, text: options.text ?? '' }
    : kind === 'grid'
      ? { kind, shotId: options.shotId ?? '' }
      : kind === 'config'
        ? { kind, text: options.text ?? '', size: options.size ?? '1024x1024', count: options.count ?? 1, status: 'idle' }
        : kind === 'video'
          ? { kind, text: options.text ?? '', url: options.url ?? '', size: options.size ?? '1344x768', duration: options.duration ?? 5, status: 'idle' }
          : { kind, text: options.text ?? '', url: options.url ?? '', size: options.size ?? '1024x1024', count: options.count ?? 1 }
  if (options.shotId !== undefined) base.shotId = options.shotId
  if (options.takeId !== undefined) base.takeId = options.takeId
  if (options.takeNumber !== undefined) base.takeNumber = options.takeNumber
  return {
    id: `${kind}-${randomUUID()}`,
    type: 'studio',
    position: { x: options.x ?? 0, y: options.y ?? 0 },
    data: base,
  }
}

/**
 * Write a finished generation onto the node that asked for it.
 *
 * Shared by the two server-side callers — the Agent tool face and the render job
 * runner — because 「生成好了之后画布上应该发生什么」 must not be two different
 * answers. (The browser applies the same three fields itself, from the same
 * response, which is why they are exactly these three.)
 * @param doc - document to mutate in place.
 * @param input - which node, what was asked, and what came back.
 * @returns whether the node was found.
 */
export function applyGeneration(doc: CanvasDocument, input: {
  /** Node that asked for the render. */
  nodeId: string
  /** Shot the takes were recorded against; recorded on the node so the version strip has a source. */
  shotId?: string
  /** Prompt used, so a node with no text records what made it. */
  prompt: string
  /** Existing revision count, so the new one can be numbered. */
  historyLength: number
  /** Produced files, newest take first. */
  files: { url: string; takeId?: string }[]
}): boolean {
  const anchor = doc.nodes.find((node) => node.id === input.nodeId)
  if (anchor === undefined) return false
  anchor.data.status = 'idle'
  if (input.shotId !== undefined && input.shotId !== '') anchor.data.shotId = input.shotId
  if (anchor.data.text === '') anchor.data.text = input.prompt
  const first = input.files[0]
  if (first === undefined) return true
  // 画面落在节点自己身上，其余的张数成为它的其他版本。
  anchor.data.url = first.url
  anchor.data.takeNumber = input.historyLength + 1
  if (first.takeId === undefined) delete anchor.data.takeId
  else anchor.data.takeId = first.takeId
  return true
}

/**
 * Apply operations to a document, in order, without writing it.
 *
 * Kept separate from persistence so a caller can apply a batch and decide
 * afterwards whether the result is worth saving.
 * @param doc - document to mutate in place.
 * @param ops - operations to apply.
 * @returns one result per operation.
 */
export function applyOps(doc: CanvasDocument, ops: CanvasOp[]): OpResult[] {
  const results: OpResult[] = []
  const findNode = (id: string): CanvasNode | undefined => doc.nodes.find((node) => node.id === id)

  for (const op of ops) {
    if (op.type === 'add_node') {
      const index = doc.nodes.length
      const node = makeNode(op.kind, {
        ...(op.text === undefined ? {} : { text: op.text }),
        ...(op.size === undefined ? {} : { size: op.size }),
        ...(op.count === undefined ? {} : { count: op.count }),
        ...(op.duration === undefined ? {} : { duration: op.duration }),
        x: op.x ?? 80 + index * 40,
        y: op.y ?? 80 + index * 30,
      })
      doc.nodes.push(node)
      results.push({ type: op.type, nodeId: node.id, note: `已添加 ${op.kind} 节点` })
      continue
    }

    if (op.type === 'set_text' || op.type === 'set_config') {
      const node = findNode(op.nodeId)
      if (node === undefined) throw new Error(`节点不存在：${op.nodeId}`)
      if (op.type === 'set_text') {
        node.data.text = op.text
      } else {
        if (op.size !== undefined) node.data.size = op.size
        if (op.count !== undefined) node.data.count = op.count
      }
      results.push({ type: op.type, nodeId: node.id, note: '已更新节点' })
      continue
    }

    if (op.type === 'connect') {
      const from = findNode(op.from)
      const to = findNode(op.to)
      if (from === undefined) throw new Error(`起点节点不存在：${op.from}`)
      if (to === undefined) throw new Error(`终点节点不存在：${op.to}`)
      const existing = doc.edges.find((edge) => edge.source === op.from && edge.target === op.to)
      if (existing !== undefined) {
        results.push({ type: op.type, edgeId: existing.id, note: '连线已存在' })
        continue
      }
      // 端口按**上游产品的类型**挑默认入口（见 TARGET_PORT_BY_SOURCE）：Agent 没有
      // 端口这个概念，而视频节点有三个入边。想接尾帧就显式给 `port`。
      // 这里只写一个 handle id，不校验目标节点有没有这个入口——目标节点有哪些入边是
      // **画布目录**（前端 ports.ts）的事，客户端加载时会照它解释；写错的那条边不会
      // 被 resolvePrompt / inboundImageUrl 采用，所以最多是一条不生效的线，不会出错图。
      const port = op.port ?? TARGET_PORT_BY_SOURCE[String(from.data.kind ?? '')]
      const edge: CanvasEdge = {
        id: `edge-${randomUUID()}`,
        source: op.from,
        target: op.to,
        ...(port === undefined ? {} : { targetHandle: port }),
      }
      doc.edges.push(edge)
      results.push({ type: op.type, edgeId: edge.id, note: '已连线' })
      continue
    }

    if (op.type === 'delete_node') {
      const node = findNode(op.nodeId)
      if (node === undefined) throw new Error(`节点不存在：${op.nodeId}`)
      doc.nodes = doc.nodes.filter((item) => item.id !== op.nodeId)
      doc.edges = doc.edges.filter((edge) => edge.source !== op.nodeId && edge.target !== op.nodeId)
      // 从 Agent 上下文里也摘掉：人指给 Agent 的节点已经不存在了，
      // 留着这个 id 只会让文档慢慢积累指向空气的引用。
      if (Array.isArray(doc.agentContext)) {
        doc.agentContext = doc.agentContext.filter((id) => id !== op.nodeId)
      }
      results.push({ type: op.type, nodeId: op.nodeId, note: '已删除节点及其连线' })
      continue
    }

    throw new Error(`未知操作：${JSON.stringify(op)}`)
  }

  return results
}

/**
 * Read the prompt a node would use: its own text, else its inbound text node.
 *
 * **只看文本那条入边。** 从前这里取「第一条入边」，在只有文本一种入边时没错；
 * 但视频节点现在还能接首帧/尾帧（图片），接了图之后「第一条入边」很可能就是那张图，
 * 于是上游的文本节点被漏掉——提示词悄悄变成空。
 * @param doc - canvas document.
 * @param node - the node asking.
 * @returns the prompt text, or empty.
 */
export function resolvePrompt(doc: CanvasDocument, node: CanvasNode): string {
  const own = typeof node.data.text === 'string' ? node.data.text.trim() : ''
  if (own !== '') return own
  for (const edge of doc.edges.filter((item) => item.target === node.id)) {
    const upstream = doc.nodes.find((item) => item.id === edge.source)
    const text = typeof upstream?.data.text === 'string' ? upstream.data.text.trim() : ''
    if (upstream?.data.kind === 'text' && text !== '') return text
  }
  return ''
}

/**
 * Which inbound port receives a given kind of upstream product.
 *
 * 服务端也得知道「端口」这件事：Agent 的 `canvas_connect` 没有端口这个概念，而视频
 * 节点现在有三个入边（提示词 / 首帧 / 尾帧）。没有这张表，Agent 把图片接到视频节点上
 * 会落到**第一个**入边（提示词）上——那是一条连了却什么都不做的线。
 *
 * 这份映射**必须**与 `apps/web/src/canvas/ports.ts` 的目录一致，所以
 * `ports-test.mjs` 会拿两边的目录对一遍：不一致就红，而不是等一个人肉发现。
 */
export const TARGET_PORT_BY_SOURCE: Record<string, string | undefined> = {
  text: 'prompt',
  image: 'first',
}

/**
 * Port ids an Agent may name explicitly on a connection.
 *
 * 「首帧」有默认值（图片自动进首帧），「尾帧」没有——所以它只能被显式点名。
 * 这份常量同时是**工具 schema 的枚举**与测试的判据，避免枚举在 schema 里另抄一遍。
 */
export const CONNECTABLE_PORTS = ['prompt', 'first', 'last'] as const

/**
 * The asset url feeding one inbound image port of a node.
 *
 * 图生视频的首帧/尾帧就是这么来的：入边指向的那个图片节点带什么素材，就用什么当首帧。
 * 解析发生在**服务端**，所以画布点击、Agent 调用、作业运行器三条路都自动支持，
 * 不需要客户端把图再传一遍（它已经在素材库里了）。
 * @param doc - canvas document.
 * @param nodeId - the consuming node.
 * @param handle - inbound handle id (`first` / `last`).
 * @returns the upstream image's asset url, or empty when nothing usable is connected.
 */
export function inboundImageUrl(doc: CanvasDocument, nodeId: string, handle: string): string {
  // 没有 targetHandle 的边（旧文档，以及 Agent 用 canvas_connect 建的）也算候选：
  // Agent 没有「端口」这个概念，它的边只会是「把某个节点的产物接到这个节点上」。
  // 真正决定能不能当首帧的是**上游有没有画面**（`data.url`），所以这里不必先判类型——
  // 接到视频节点上的文本节点没有 url，自然被排除。
  // 同一个口上有多条时取**最后一条**：后连的那条是人的最新意图。
  const edges = doc.edges.filter((edge) => edge.target === nodeId
    && (String(edge.targetHandle ?? '') === handle || edge.targetHandle === undefined))
  const edge = edges[edges.length - 1]
  if (edge === undefined) return ''
  const source = doc.nodes.find((item) => item.id === edge.source)
  const url = source?.data.url
  // 上游节点存在但还没出图（url 为空）时也返回空：那时「没有首帧」才是事实。
  return typeof url === 'string' ? url : ''
}
