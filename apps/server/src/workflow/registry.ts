/**
 * Node registry.
 *
 * PRD §8.3 asks for pluggable nodes and a model pool that can grow without
 * touching the canvas layer. A registry is how that promise is kept: the
 * scheduler knows nothing about image or video, only about node types that
 * declare ports and an executor.
 */
import type { PortSpec } from './types.ts'
import type { NodeCategory, PortType } from './types.ts'
import type { TypeInfo } from './graph.ts'

/** What an executor receives. */
export interface RunContext {
  /** Node being executed. */
  node: { id: string; type: string; params: Record<string, unknown> }
  /** Values arriving on input ports. */
  inputs: Record<string, unknown>
  /** Append a line to the node's log. */
  log: (message: string) => void
}

/** What an executor returns: one value per output port. */
export type Executor = (context: RunContext) => Promise<Record<string, unknown>>

/** A node type definition. */
export interface NodeTypeSpec {
  /** Registry key, stored on nodes. */
  type: string
  /** Category, for UI grouping. */
  category: NodeCategory
  /** Display title. */
  title: string
  /** One-line description, shown on hover (PRD §7). */
  description?: string
  /** Input ports. */
  inputs: PortSpec[]
  /** Output ports. */
  outputs: PortSpec[]
  /** Default parameters. */
  params?: Record<string, unknown>
  /** Executor; omit to declare a node the product cannot run yet. */
  run?: Executor
  /** Why it cannot run, when `run` is absent. Surfaced instead of a vague failure. */
  unavailable?: string
}

/** The registry surface. */
export interface Registry {
  /** Look up a type. */
  get: (type: string) => NodeTypeSpec | undefined
  /** All registered types. */
  all: () => NodeTypeSpec[]
  /** Register or replace a type. */
  register: (spec: NodeTypeSpec) => void
  /** Graph-layer view of a type. */
  info: (type: string) => TypeInfo | undefined
}

/**
 * Build a registry.
 * @param specs - initial node types.
 * @returns the registry.
 */
export function createRegistry(specs: NodeTypeSpec[] = []): Registry {
  const types = new Map<string, NodeTypeSpec>()
  for (const spec of specs) types.set(spec.type, spec)

  return {
    get: (type) => types.get(type),
    all: () => [...types.values()],
    register(spec) {
      if (types.has(spec.type)) throw new Error(`节点类型已注册：${spec.type}`)
      types.set(spec.type, spec)
    },
    info(type) {
      const spec = types.get(type)
      if (spec === undefined) return undefined
      return {
        type: spec.type,
        category: spec.category,
        title: spec.title,
        inputs: spec.inputs,
        outputs: spec.outputs,
        runnable: spec.run !== undefined,
      }
    },
  }
}

/** Convenience helper for declaring a port. */
export function port(name: string, type: PortType, required = false, description?: string): PortSpec {
  return { name, type, required, ...(description === undefined ? {} : { description }) }
}
