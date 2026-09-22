/**
 * Workflow HTTP surface.
 *
 * The workflow is stored *inside* the project's canvas document rather than in a
 * table of its own. Doc 13 §5 explains why: this codebase already paid once for
 * keeping two parallel models of the same thing (the old agent bridge invented
 * its own op vocabulary and drifted until neither side could read the other).
 * One document, one truth.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Registry } from './registry.ts'
import type { Workflow } from './types.ts'
import { runWorkflow } from './scheduler.ts'
import type { StudioStore } from '../store.ts'

/** Everything the workflow routes need. */
export interface WorkflowRouteDeps {
  /** Domain store, which holds the canvas document. */
  store: StudioStore
  /** Node catalogue. */
  registry: Registry
  /** Tell watching canvases the document changed. */
  onDocumentChanged: (projectId: string, reason: string) => void
  /** Diagnostics. */
  log: (message: string) => void
}

/** Write a JSON response. */
function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(payload))
}

/** Read a request body as UTF-8 text. */
async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse a JSON object body. */
function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Read the document as a mutable record, tolerating a document that was never saved. */
function readDoc(store: StudioStore, projectId: string): Record<string, unknown> {
  const raw = store.getCanvas(projectId)
  if (raw === undefined) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { nodes: [], edges: [] }
  } catch {
    return { nodes: [], edges: [] }
  }
}

/** Extract the workflow section, if the document has one. */
function readWorkflow(doc: Record<string, unknown>): Workflow | null {
  const value = doc.workflow
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Partial<Workflow>
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null
  return { version: candidate.version ?? 1, nodes: candidate.nodes, edges: candidate.edges }
}

/** A sane blank workflow. */
function emptyWorkflow(): Workflow {
  return { version: 1, nodes: [], edges: [] }
}

/**
 * Build the workflow route handler.
 * @param deps - store, registry, change notification, diagnostics.
 * @returns a handler returning false for paths it does not own.
 */
export function createWorkflowRoutes(deps: WorkflowRouteDeps): {
  handle: (req: IncomingMessage, res: ServerResponse, pathname: string, method: string) => Promise<boolean>
} {
  return {
    async handle(req, res, pathname, method) {
      if (pathname === '/api/workflow/nodes' && method === 'GET') {
        json(res, 200, {
          nodes: deps.registry.all().map((spec) => ({
            type: spec.type,
            category: spec.category,
            title: spec.title,
            description: spec.description ?? '',
            inputs: spec.inputs,
            outputs: spec.outputs,
            params: spec.params ?? {},
            // A node the product cannot run yet says so, instead of failing vaguely later.
            runnable: spec.run !== undefined,
            ...(spec.unavailable === undefined ? {} : { unavailable: spec.unavailable }),
          })),
        })
        return true
      }

      const workflowMatch = /^\/api\/projects\/([^/]+)\/workflow$/u.exec(pathname)
      if (workflowMatch !== null) {
        const projectId = decodeURIComponent(workflowMatch[1] as string)
        if (deps.store.getProject(projectId) === undefined) {
          json(res, 404, { error: '项目不存在' })
          return true
        }
        if (method === 'GET') {
          json(res, 200, { workflow: readWorkflow(readDoc(deps.store, projectId)) ?? emptyWorkflow() })
          return true
        }
        if (method === 'PUT' || method === 'POST') {
          const body = parseJson(await readText(req))
          const incoming = body.workflow
          if (incoming === null || typeof incoming !== 'object' || !Array.isArray((incoming as Workflow).nodes)) {
            json(res, 400, { error: 'workflow 必须是含 nodes / edges 的对象' })
            return true
          }
          const doc = readDoc(deps.store, projectId)
          doc.workflow = incoming
          deps.store.saveCanvas(projectId, JSON.stringify(doc))
          deps.onDocumentChanged(projectId, 'workflow-saved')
          json(res, 200, { ok: true })
          return true
        }
      }

      const runMatch = /^\/api\/projects\/([^/]+)\/workflow\/run$/u.exec(pathname)
      if (runMatch !== null && method === 'POST') {
        const projectId = decodeURIComponent(runMatch[1] as string)
        if (deps.store.getProject(projectId) === undefined) {
          json(res, 404, { error: '项目不存在' })
          return true
        }
        const body = parseJson(await readText(req))
        const doc = readDoc(deps.store, projectId)
        const stored = readWorkflow(doc)
        const incoming = body.workflow
        const workflow = (incoming !== null && typeof incoming === 'object' && Array.isArray((incoming as Workflow).nodes)
          ? (incoming as Workflow)
          : stored) ?? emptyWorkflow()

        const only = Array.isArray(body.only) ? body.only.filter((id): id is string => typeof id === 'string') : undefined
        const force = body.force === true
        const started = Date.now()
        const summary = await runWorkflow(workflow, {
          registry: deps.registry,
          ...(only === undefined ? {} : { only }),
          ...(force ? { force: true } : {}),
        })

        // Persist the results — cache keys and outputs are what make the next run
        // cheap, so losing them on reload would throw the whole mechanism away.
        doc.workflow = summary.workflow
        deps.store.saveCanvas(projectId, JSON.stringify(doc))
        deps.onDocumentChanged(projectId, 'workflow-run')

        const elapsedMs = Date.now() - started
        deps.log(`workflow: 执行 ${String(summary.executed.length)} · 复用 ${String(summary.cached.length)} · 阻塞 ${String(summary.blocked.length)} · 失败 ${String(summary.failed.length)}（${String(elapsedMs)}ms）`)
        json(res, summary.problems.length > 0 ? 400 : 200, {
          ok: summary.problems.length === 0,
          elapsedMs,
          executed: summary.executed,
          cached: summary.cached,
          blocked: summary.blocked,
          failed: summary.failed,
          problems: summary.problems,
          workflow: summary.workflow,
        })
        return true
      }

      return false
    },
  }
}
