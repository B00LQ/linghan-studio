/**
 * Workflow graph types.
 *
 * A workflow is a DAG: nodes are vertices, edges are directed data references.
 * The vocabulary is deliberately close to the canvas document — the canvas *is*
 * the workflow, so there is exactly one source of truth (see doc 13 §5).
 */

/** What flows along an edge. Used to reject nonsensical connections. */
export type PortType = 'text' | 'image' | 'video' | 'audio' | 'manifest'

/** Where a node sits in the production chain. */
export type NodeCategory = 'input' | 'generate' | 'control' | 'post' | 'output'

/**
 * Node lifecycle.
 *
 * `blocked` is ours, not the PRD's: when an upstream node fails, its dependents
 * cannot run, and calling them "待执行" forever would hide the real cause.
 */
export type NodeState = 'idle' | 'running' | 'success' | 'failed' | 'disabled' | 'blocked'

/** One input or output port on a node type. */
export interface PortSpec {
  /** Port name, unique within its node type and side. */
  name: string
  /** What may flow through it. */
  type: PortType
  /** Whether the node can run without it. */
  required?: boolean
  /** Shown on hover (PRD §7). */
  description?: string
}

/** One node in a workflow. */
export interface WorkflowNode {
  /** Stable id. */
  id: string
  /** Registry key. */
  type: string
  /** Human label; defaults to the type's title. */
  name?: string
  /** World coordinates. */
  position: { x: number; y: number }
  /** Node parameters. */
  params: Record<string, unknown>
  /** Lifecycle state. */
  state: NodeState
  /** Excluded from scheduling when true. */
  disabled?: boolean
  /**
   * Hash of type + params + upstream cache keys.
   * Equal to the stored value means the cached result still holds (PRD §4.3).
   */
  cacheKey?: string
  /**
   * Port name → output value. Values are descriptors — text, or asset ids —
   * never file bytes (PRD §6.2).
   */
  outputs?: Record<string, unknown>
  /** Failure message, when the last run failed. */
  error?: string
  /** Run log lines, newest last. */
  logs?: string[]
  /** Duration of the last execution in milliseconds. */
  latencyMs?: number
}

/** One directed data reference. */
export interface WorkflowEdge {
  /** Stable id. */
  id: string
  /** Source node id. */
  from: string
  /** Output port on the source. */
  fromPort: string
  /** Target node id. */
  to: string
  /** Input port on the target. */
  toPort: string
}

/** A whole workflow. */
export interface Workflow {
  /** Schema version, so a stored document can be migrated. */
  version: number
  /** Nodes by id order. */
  nodes: WorkflowNode[]
  /** Directed edges. */
  edges: WorkflowEdge[]
}

/** Why a workflow cannot run. */
export interface GraphProblem {
  /** What kind of problem. */
  kind: 'cycle' | 'unknown-type' | 'missing-port' | 'type-mismatch' | 'duplicate-id' | 'dangling-edge'
  /** Node or edge the problem concerns. */
  at: string
  /** Message for the operator. */
  message: string
}
