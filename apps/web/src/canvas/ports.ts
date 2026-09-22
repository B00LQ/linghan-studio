/**
 * Canvas node catalogue and port model.
 *
 * Two node kinds, deliberately: 文本 and 图片. An earlier version also had a
 * separate "shot" node and a "version board" node, and the concept count — not
 * the code — is what made the canvas hard to read. The image node now owns its
 * own prompt, its own generation, and its own history, which is the model the
 * reference product uses.
 *
 * Ports still have types, because the 「引用该节点生成」menu has to answer "what
 * can consume what I just dragged out?".
 */

/** What a port carries. */
export type PortKind = 'text' | 'image'

/** Node kinds the canvas can draw. */
export type CanvasNodeKind = 'text' | 'image' | 'group'

/** One port on a canvas node. */
export interface PortDef {
  /** Handle id, stored on the edge as sourceHandle / targetHandle. */
  id: string
  /** What it carries. */
  kind: PortKind
  /** Label shown on hover. */
  label: string
}

/** One node kind the canvas understands. */
export interface CanvasNodeSpec {
  /** Node kind stored in node data. */
  kind: CanvasNodeKind
  /** Title shown in menus and on the card. */
  title: string
  /** One-line explanation for the menu. */
  description: string
  /** Inbound ports. */
  inputs: PortDef[]
  /** Outbound ports. */
  outputs: PortDef[]
  /** Placeholder for the prompt window. */
  placeholder: string
  /** Whether the window offers 画幅 / 张数 controls. */
  picture: boolean
  /** Why generate cannot run, when it cannot. */
  generateBlocked?: string
}

/**
 * The catalogue. Order is menu order.
 *
 * `group` is deliberately **not** in here: a group is made by selecting nodes and
 * pressing 打组, not by picking it from the add menu, and an empty group is not a
 * thing anyone wants.
 */
export const CANVAS_NODES: CanvasNodeSpec[] = [
  {
    kind: 'text',
    title: '文本',
    description: '写下故事、场景或角色设定',
    inputs: [],
    outputs: [{ id: 'text', kind: 'text', label: '文本' }],
    placeholder: '写下你想讲的故事、场景或角色设定。例如：一个来自未来的机器人，在城市屋顶看星星。',
    picture: false,
    generateBlocked: '未配置文本模型（LLM）供应商',
  },
  {
    kind: 'image',
    title: '图片',
    description: '文字生图；也可以接入上游文本作为提示词',
    inputs: [{ id: 'prompt', kind: 'text', label: '提示词' }],
    outputs: [{ id: 'image', kind: 'image', label: '画面' }],
    placeholder: '可直接文字生图，或接入上游文本。例如：废车站的候车厅，斜射的晨光，尘埃',
    picture: true,
  },
]

/** Look up a spec by node kind. */
export function specOf(kind: string): CanvasNodeSpec | undefined {
  return CANVAS_NODES.find((spec) => spec.kind === kind)
}

/** The kind a port carries, when the node kind and port id are known. */
export function portKind(nodeKind: string, handleId: string | null, side: 'source' | 'target'): PortKind | undefined {
  const spec = specOf(nodeKind)
  if (spec === undefined) return undefined
  const ports = side === 'source' ? spec.outputs : spec.inputs
  // A missing handle id means an edge written before ports existed; those only
  // ever connected the single first port, so that is the honest default.
  const port = handleId === null ? ports[0] : ports.find((item) => item.id === handleId)
  return port?.kind
}

/** Whether an output kind may feed an input kind. */
export function canConnect(from: PortKind, to: PortKind): boolean {
  return from === to
}

/** Node kinds that could accept the given output, with the port that would receive it. */
export function candidatesFor(
  from: PortKind,
  opts: { excludeKind?: string } = {},
): { spec: CanvasNodeSpec; port: PortDef }[] {
  const found: { spec: CanvasNodeSpec; port: PortDef }[] = []
  for (const spec of CANVAS_NODES) {
    if (spec.kind === opts.excludeKind) continue
    const port = spec.inputs.find((input) => canConnect(from, input.kind))
    if (port !== undefined) found.push({ spec, port })
  }
  return found
}

/** Node data for a freshly created node of the given kind. */
export function initialData(kind: CanvasNodeKind, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (kind === 'text') return { kind, text: '', ...extra }
  return { kind, text: '', url: '', size: '1024x1024', count: 1, ...extra }
}

/** The shape {@link nodeLabel} needs — a node list, not the full xyflow type. */
export interface NamedLike {
  id: string
  data: { kind?: unknown; name?: unknown }
}

/**
 * The name a node answers to.
 *
 * A node has an identity even before anyone names it: 「文本节点 2」 is derived
 * from the node's position among its own kind, so the sidebar list, the card
 * header and the node's row menu all agree without storing anything. Renaming
 * writes `data.name`, which then wins.
 * @param nodes - the canvas's nodes, in document order.
 * @param id - the node to name.
 * @returns the display name.
 */
export function nodeLabel(nodes: NamedLike[], id: string): string {
  const node = nodes.find((item) => item.id === id)
  if (node === undefined) return ''
  const explicit = typeof node.data.name === 'string' ? node.data.name.trim() : ''
  if (explicit !== '') return explicit
  const kind = String(node.data.kind ?? '')
  if (kind === 'group') return '组'
  const sameKind = nodes.filter((item) => String(item.data.kind ?? '') === kind)
  const ordinal = sameKind.findIndex((item) => item.id === id) + 1
  return `${specOf(kind)?.title ?? kind}节点 ${String(ordinal)}`
}
