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
  | { type: 'connect'; from: string; to: string }
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
      const edge: CanvasEdge = { id: `edge-${randomUUID()}`, source: op.from, target: op.to }
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

/** Read the prompt a config node would use: its own text, else its inbound text node. */
export function resolvePrompt(doc: CanvasDocument, node: CanvasNode): string {
  const own = typeof node.data.text === 'string' ? node.data.text.trim() : ''
  if (own !== '') return own
  const source = doc.edges.find((edge) => edge.target === node.id)?.source
  if (source === undefined) return ''
  const upstream = doc.nodes.find((item) => item.id === source)
  return upstream?.data.kind === 'text' && typeof upstream.data.text === 'string' ? upstream.data.text.trim() : ''
}
