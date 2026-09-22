/**
 * Graph algorithms: validation, ordering, dirty propagation, cache identity.
 *
 * Everything here is pure — no store, no network, no model. That is deliberate:
 * the PRD calls lazy scheduling the product's core differentiator, so it has to
 * be verifiable in isolation rather than only through a running canvas.
 */
import { createHash } from 'node:crypto'
import type { GraphProblem, NodeCategory, PortSpec, Workflow, WorkflowNode } from './types.ts'

/** A node type as the graph layer needs to see it. */
export interface TypeInfo {
  /** Registry key. */
  type: string
  /** Category, for grouping in a UI. */
  category: NodeCategory
  /** Display title. */
  title: string
  /** Input ports. */
  inputs: PortSpec[]
  /** Output ports. */
  outputs: PortSpec[]
  /** Whether an executor is wired up. Absent means "declared, not configured". */
  runnable: boolean
}

/** Look up a node type. */
export type TypeLookup = (type: string) => TypeInfo | undefined

/**
 * Validate a workflow before it runs.
 *
 * Cycles are the important one: the PRD promises the scheduler can never spin,
 * and a cycle is the only way a dependency walk could.
 * @param workflow - workflow to check.
 * @param lookup - node type resolver.
 * @returns every problem found; empty means the workflow may run.
 */
export function validateGraph(workflow: Workflow, lookup: TypeLookup): GraphProblem[] {
  const problems: GraphProblem[] = []
  const seen = new Set<string>()
  const byId = new Map<string, WorkflowNode>()

  for (const node of workflow.nodes) {
    if (seen.has(node.id)) problems.push({ kind: 'duplicate-id', at: node.id, message: `节点 id 重复：${node.id}` })
    seen.add(node.id)
    byId.set(node.id, node)
    if (lookup(node.type) === undefined) {
      problems.push({ kind: 'unknown-type', at: node.id, message: `未知节点类型：${node.type}` })
    }
  }

  for (const edge of workflow.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) {
      problems.push({ kind: 'dangling-edge', at: edge.id, message: `连线指向不存在的节点：${edge.from} → ${edge.to}` })
      continue
    }
    const fromType = lookup(from.type)
    const toType = lookup(to.type)
    if (fromType === undefined || toType === undefined) continue
    const outPort = fromType.outputs.find((port) => port.name === edge.fromPort)
    const inPort = toType.inputs.find((port) => port.name === edge.toPort)
    if (outPort === undefined) {
      problems.push({ kind: 'missing-port', at: edge.id, message: `${fromType.title} 没有输出端口「${edge.fromPort}」` })
      continue
    }
    if (inPort === undefined) {
      problems.push({ kind: 'missing-port', at: edge.id, message: `${toType.title} 没有输入端口「${edge.toPort}」` })
      continue
    }
    if (outPort.type !== inPort.type) {
      problems.push({
        kind: 'type-mismatch',
        at: edge.id,
        message: `类型不匹配：${fromType.title}.${outPort.name}(${outPort.type}) 不能连到 ${toType.title}.${inPort.name}(${inPort.type})`,
      })
    }
  }

  const cyclic = findCycle(workflow)
  if (cyclic.length > 0) {
    problems.push({
      kind: 'cycle',
      at: cyclic.join(' → '),
      message: `检测到环形依赖：${cyclic.join(' → ')}。工作流必须是有向无环图。`,
    })
  }

  return problems
}

/**
 * Find one dependency cycle, if any.
 *
 * Iterative depth-first search with colouring: white = unvisited, grey = on the
 * current path, black = finished. A grey neighbour is a back edge, and the grey
 * stack from that point on is the cycle.
 * @param workflow - workflow to inspect.
 * @returns the cycle as a node id path, or an empty array when acyclic.
 */
export function findCycle(workflow: Workflow): string[] {
  const adjacency = new Map<string, string[]>()
  for (const node of workflow.nodes) adjacency.set(node.id, [])
  for (const edge of workflow.edges) {
    const list = adjacency.get(edge.from)
    if (list !== undefined && adjacency.has(edge.to)) list.push(edge.to)
  }

  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const colour = new Map<string, number>()
  for (const node of workflow.nodes) colour.set(node.id, WHITE)

  for (const start of workflow.nodes) {
    if (colour.get(start.id) !== WHITE) continue
    const path: string[] = []
    const stack: { id: string; next: number }[] = [{ id: start.id, next: 0 }]
    colour.set(start.id, GREY)
    path.push(start.id)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame === undefined) break
      const neighbours = adjacency.get(frame.id) ?? []
      if (frame.next >= neighbours.length) {
        colour.set(frame.id, BLACK)
        stack.pop()
        path.pop()
        continue
      }
      const target = neighbours[frame.next]
      frame.next += 1
      if (target === undefined) continue
      const state = colour.get(target)
      if (state === GREY) {
        const start2 = path.indexOf(target)
        return [...path.slice(start2 === -1 ? 0 : start2), target]
      }
      if (state === WHITE) {
        colour.set(target, GREY)
        path.push(target)
        stack.push({ id: target, next: 0 })
      }
    }
  }
  return []
}

/**
 * Dependency-first ordering over the given node ids.
 *
 * Nodes outside `subset` are ignored as if absent, so the scheduler can order
 * just the part it intends to run.
 * @param workflow - workflow.
 * @param subset - node ids to order.
 * @returns node ids, upstream before downstream.
 */
export function topologicalOrder(workflow: Workflow, subset?: Set<string>): string[] {
  const include = (id: string): boolean => subset === undefined || subset.has(id)
  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const node of workflow.nodes) {
    if (!include(node.id)) continue
    indegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }
  for (const edge of workflow.edges) {
    if (!include(edge.from) || !include(edge.to)) continue
    adjacency.get(edge.from)?.push(edge.to)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }

  // Preserve document order among ready nodes, so runs are reproducible.
  const order = workflow.nodes.map((node) => node.id).filter((id) => include(id))
  const ready = order.filter((id) => (indegree.get(id) ?? 0) === 0)
  const result: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()
    if (id === undefined) break
    result.push(id)
    for (const next of adjacency.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1
      indegree.set(next, left)
      if (left === 0) ready.push(next)
    }
  }
  return result
}

/**
 * Every node reachable downstream from the given set, including the set itself.
 *
 * This is the "dirty node + all dependents" rule of PRD §4.2.
 * @param workflow - workflow.
 * @param ids - starting nodes.
 * @returns affected node ids.
 */
export function withDownstream(workflow: Workflow, ids: Iterable<string>): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const node of workflow.nodes) adjacency.set(node.id, [])
  for (const edge of workflow.edges) adjacency.get(edge.from)?.push(edge.to)

  const affected = new Set<string>()
  const queue = [...ids]
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) continue
    if (affected.has(id)) continue
    affected.add(id)
    for (const next of adjacency.get(id) ?? []) queue.push(next)
  }
  return affected
}

/** Direct upstream node ids of one node, in edge order. */
export function upstreamOf(workflow: Workflow, id: string): string[] {
  return workflow.edges.filter((edge) => edge.to === id).map((edge) => edge.from)
}

/** Collect the values arriving at each input port of a node. */
export function inputValues(workflow: Workflow, node: WorkflowNode): Record<string, unknown> {
  const inputs: Record<string, unknown> = {}
  for (const edge of workflow.edges) {
    if (edge.to !== node.id) continue
    const source = workflow.nodes.find((item) => item.id === edge.from)
    if (source === undefined) continue
    const value = source.outputs?.[edge.fromPort]
    if (value === undefined) continue
    // Several edges may feed one port; keep them all rather than last-wins.
    const existing = inputs[edge.toPort]
    if (existing === undefined) inputs[edge.toPort] = value
    else if (Array.isArray(existing)) existing.push(value)
    else inputs[edge.toPort] = [existing, value]
  }
  return inputs
}

/**
 * Cache identity of a node (PRD §4.3): type + params + upstream input identity.
 *
 * Upstream identity is taken from the upstream nodes' own cache keys rather than
 * from their values, so a deep chain invalidates correctly without hashing large
 * payloads — and a node whose upstream is unchanged keeps its key even after a
 * sibling branch reruns.
 * @param node - node to identify.
 * @param inputs - values arriving at its ports.
 * @param upstreamKeys - cache keys of its direct upstream nodes, in stable order.
 * @returns a hex digest.
 */
export function computeCacheKey(node: WorkflowNode, inputs: Record<string, unknown>, upstreamKeys: string[]): string {
  const payload = JSON.stringify({
    type: node.type,
    params: sortKeys(node.params),
    inputs: sortKeys(inputs),
    upstream: [...upstreamKeys].sort(),
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

/**
 * Which nodes must run.
 *
 * A node is dirty when its cache key no longer matches the stored one, when it
 * has never succeeded, or when the caller forces it. PRD §4.2 then requires the
 * whole downstream of every dirty node to rerun.
 * @param workflow - workflow.
 * @param options - forced node ids, or a request to run everything.
 * @returns the ids that need execution, including downstream.
 */
export function dirtyNodes(workflow: Workflow, options: { only?: string[]; force?: boolean } = {}): Set<string> {
  const keys = cacheKeysOf(workflow)
  const result = new Set<string>()

  // An explicit scope wins outright: "rerun this node" must not drag in every
  // other node that happens to be stale, or a targeted re-render would quietly
  // become a full-canvas run.
  if (options.only !== undefined) {
    for (const id of withDownstream(workflow, options.only)) result.add(id)
  } else if (options.force === true) {
    for (const node of workflow.nodes) result.add(node.id)
  } else {
    const seeds: string[] = []
    for (const node of workflow.nodes) {
      if (node.state !== 'success') seeds.push(node.id)
      else if (node.cacheKey === undefined || node.cacheKey !== keys.get(node.id)) seeds.push(node.id)
    }
    for (const id of withDownstream(workflow, seeds)) result.add(id)
  }

  for (const node of workflow.nodes) if (node.disabled === true) result.delete(node.id)
  return result
}

/**
 * Recompute every node's cache key from the current parameters and wiring.
 *
 * Keys are resolved upstream-first, so a single pass suffices on a DAG.
 * @param workflow - workflow.
 * @returns node id → cache key.
 */
export function cacheKeysOf(workflow: Workflow): Map<string, string> {
  const keys = new Map<string, string>()
  for (const id of topologicalOrder(workflow)) {
    const node = workflow.nodes.find((item) => item.id === id)
    if (node === undefined) continue
    const upstream = upstreamOf(workflow, id)
      .map((upstreamId) => keys.get(upstreamId))
      .filter((key): key is string => key !== undefined)
    keys.set(id, computeCacheKey(node, inputValues(workflow, node), upstream))
  }
  return keys
}

/** Recursively sort object keys, so equal content hashes equally. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sortKeys(source[key])]))
  }
  return value
}
