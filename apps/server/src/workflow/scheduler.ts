/**
 * Lazy workflow scheduler.
 *
 * The promise this file has to keep (PRD §4.2/§4.3): changing one node reruns
 * that node and everything downstream of it, and **nothing else** — every other
 * node's cached result is reused without touching a model.
 *
 * Two rules from PRD §8.2 shape the error handling: a failing node must not stop
 * the rest of the canvas, and a failure must be localised. So a failed node marks
 * only *its own* dependents as blocked; independent branches run to completion.
 */
import type { Registry } from './registry.ts'
import type { NodeState, Workflow } from './types.ts'
import { computeCacheKey, dirtyNodes, inputValues, topologicalOrder, upstreamOf, validateGraph } from './graph.ts'

/** Cache keys of a node's direct upstream, in edge order, skipping any that never ran. */
function upstreamCacheKeys(byId: Map<string, { cacheKey?: string }>, workflow: Workflow, id: string): string[] {
  return upstreamOf(workflow, id)
    .map((upstreamId) => byId.get(upstreamId)?.cacheKey)
    .filter((key): key is string => key !== undefined)
}

/** Progress event, for streaming to a canvas (PRD §4.4). */
export interface RunEvent {
  /** What happened. */
  type: 'node-start' | 'node-succeeded' | 'node-cached' | 'node-failed' | 'node-blocked' | 'node-disabled' | 'workflow-rejected' | 'finished'
  /** Node concerned, when there is one. */
  nodeId?: string
  /** Free-form detail: failure text, duration, counts. */
  detail?: string
  /** Milliseconds the node took, when it ran. */
  latencyMs?: number
}

/** Outcome of one run. */
export interface RunSummary {
  /** Nodes actually executed. */
  executed: string[]
  /** Nodes skipped because their cache key was unchanged. */
  cached: string[]
  /** Nodes skipped because an upstream failed. */
  blocked: string[]
  /** Nodes skipped because they are disabled. */
  disabled: string[]
  /** Nodes that failed. */
  failed: string[]
  /** Validation problems; when non-empty nothing ran. */
  problems: { kind: string; at: string; message: string }[]
  /** The workflow with updated states, results, and cache keys. */
  workflow: Workflow
}

/** Options for one run. */
export interface RunOptions {
  /** Resolve node types. */
  registry: Registry
  /** Restrict the run to these nodes (plus their downstream); omit for "whatever is dirty". */
  only?: string[]
  /** Rerun everything, ignoring caches. */
  force?: boolean
  /** Progress sink. */
  onEvent?: (event: RunEvent) => void
}

/**
 * Run a workflow, executing only what is dirty.
 * @param workflow - the workflow (not mutated; a copy comes back in the summary).
 * @param options - registry, scope, and progress sink.
 * @returns what ran, what was reused, and the updated workflow.
 */
export async function runWorkflow(workflow: Workflow, options: RunOptions): Promise<RunSummary> {
  const { registry } = options
  const emit = options.onEvent ?? ((): void => { /* no listener */ })
  const working = cloneWorkflow(workflow)

  const problems = validateGraph(working, registry.info)
  if (problems.length > 0) {
    emit({ type: 'workflow-rejected', detail: problems.map((problem) => problem.message).join('；') })
    return { executed: [], cached: [], blocked: [], disabled: [], failed: [], problems, workflow: working }
  }

  const summary: RunSummary = { executed: [], cached: [], blocked: [], disabled: [], failed: [], problems: [], workflow: working }
  const byId = new Map(working.nodes.map((node) => [node.id, node]))

  // Nodes that must run: dirty ones (or the requested subset) plus their downstream.
  const scheduled = dirtyNodes(working, {
    ...(options.only === undefined ? {} : { only: options.only }),
    ...(options.force === true ? { force: true } : {}),
  })

  for (const id of working.nodes.map((node) => node.id)) {
    const node = byId.get(id)
    if (node === undefined) continue
    if (node.disabled === true) {
      node.state = 'disabled'
      summary.disabled.push(id)
      emit({ type: 'node-disabled', nodeId: id })
      continue
    }
    if (!scheduled.has(id)) {
      // Not dirty: reuse the cached result untouched. This is the whole point of
      // the scheduler — no executor call happens on this path.
      if (node.state === 'success') {
        summary.cached.push(id)
        emit({ type: 'node-cached', nodeId: id })
      }
      continue
    }
  }

  for (const id of topologicalOrder(working, scheduled)) {
    const node = byId.get(id)
    if (node === undefined) continue

    // A dependency that failed, was blocked, or is disabled makes this node
    // unrunnable. Other branches keep going: PRD §8.2 forbids one failure from
    // stopping the canvas. A disabled upstream blocks rather than silently
    // feeding stale output — "skip this step" cannot mean "use yesterday's data".
    const upstream = upstreamOf(working, id)
    const brokenUpstream = upstream.find((upstreamId) => {
      const state = byId.get(upstreamId)?.state
      return state === 'failed' || state === 'blocked' || state === 'disabled'
    })
    if (brokenUpstream !== undefined) {
      node.state = 'blocked'
      const reason = `上游节点未成功：${brokenUpstream}`
      node.error = reason
      summary.blocked.push(id)
      emit({ type: 'node-blocked', nodeId: id, detail: reason })
      continue
    }

    const spec = registry.get(node.type)
    if (spec?.run === undefined) {
      node.state = 'failed'
      node.error = spec?.unavailable ?? `节点类型 ${node.type} 没有执行器`
      summary.failed.push(id)
      emit({ type: 'node-failed', nodeId: id, detail: node.error })
      continue
    }

    const inputs = inputValues(working, node)
    const missing = spec.inputs
      .filter((input) => input.required === true)
      .filter((input) => inputs[input.name] === undefined)
      .map((input) => input.name)
    if (missing.length > 0) {
      node.state = 'failed'
      node.error = `缺少必填输入：${missing.join('、')}`
      summary.failed.push(id)
      emit({ type: 'node-failed', nodeId: id, detail: node.error })
      continue
    }

    const logs: string[] = []
    node.state = 'running'
    summary.executed.push(id)
    emit({ type: 'node-start', nodeId: id })

    const started = Date.now()
    try {
      const outputs = await spec.run({
        node: { id: node.id, type: node.type, params: node.params },
        inputs,
        log: (message) => { logs.push(message) },
      })
      node.outputs = outputs
      node.state = 'success'
      // Cleared rather than set to undefined: `exactOptionalPropertyTypes` treats
      // an explicit undefined as a different thing from "absent".
      delete node.error
      // The key is computed *here*, with upstream outputs already in place, and
      // stored alongside the result. Computing it before the run instead made
      // every node look dirty forever: on the first run the upstream had not
      // produced anything yet, so the key recorded then could never match the
      // one recomputed afterwards — and the cache never hit once.
      node.cacheKey = computeCacheKey(node, inputValues(working, node), upstreamCacheKeys(byId, working, id))
      node.latencyMs = Date.now() - started
      node.logs = logs
      emit({ type: 'node-succeeded', nodeId: id, latencyMs: node.latencyMs, detail: `产出 ${Object.keys(outputs).join('/')}` })
    } catch (error) {
      node.state = 'failed'
      node.error = error instanceof Error ? error.message : String(error)
      node.latencyMs = Date.now() - started
      node.logs = logs
      summary.failed.push(id)
      emit({ type: 'node-failed', nodeId: id, detail: node.error, latencyMs: node.latencyMs })
    }
  }

  emit({
    type: 'finished',
    detail: `执行 ${String(summary.executed.length)} · 复用缓存 ${String(summary.cached.length)} · 阻塞 ${String(summary.blocked.length)} · 失败 ${String(summary.failed.length)}`,
  })
  return summary
}

/** Deep-copy a workflow so a run never mutates the caller's object. */
function cloneWorkflow(workflow: Workflow): Workflow {
  return {
    version: workflow.version,
    nodes: workflow.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      params: structuredClone(node.params),
      ...(node.outputs === undefined ? {} : { outputs: structuredClone(node.outputs) }),
      ...(node.logs === undefined ? {} : { logs: [...node.logs] }),
    })),
    edges: workflow.edges.map((edge) => ({ ...edge })),
  }
}

/** Terminal state of one node after a run, for callers that only want the verdict. */
export function stateOf(summary: RunSummary, nodeId: string): NodeState | undefined {
  return summary.workflow.nodes.find((node) => node.id === nodeId)?.state
}
