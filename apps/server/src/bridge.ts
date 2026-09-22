/**
 * Canvas notification channel.
 *
 * A canvas dials in over SSE and is told when the project document changed. It
 * does not execute anything: operations run on the server, against the document
 * in SQLite, and a connected canvas merely refreshes.
 *
 * That inversion is the whole point. This module used to push ops *down* to the
 * browser and wait for a receipt, which meant (a) nothing worked unless a tab
 * was open, (b) the browser needed an op interpreter, and (c) the op vocabulary
 * silently drifted from the canvas schema until the two could not talk at all.
 * An Agent entry point has to work unattended, so execution moved to the side
 * that owns the data.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Protocol version the canvas handshake expects. */
export const BRIDGE_PROTOCOL_VERSION = 7

/** What the bridge exposes to the rest of the server. */
export interface StudioBridge {
  /** Handle one bridge request; false when the path is not ours. */
  handle: (req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) => Promise<boolean>
  /** Whether at least one canvas is currently watching. */
  connected: () => boolean
  /** How many canvases are watching. */
  clientCount: () => number
  /** Tell every watching canvas that the document changed. */
  broadcastDocument: (projectId: string, reason: string) => void
  /**
   * Send one arbitrary event to the canvases watching a project.
   *
   * Used by generation progress, which is not a document change: nothing was
   * written, it is just news about work in flight. Keeping it on the same
   * channel means the canvas needs one connection, not two.
   */
  broadcast: (projectId: string, type: string, payload: unknown) => void
  /** Drop every live connection. */
  close: () => void
}

/** Write a JSON response. */
function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(payload))
}

/**
 * Build the notification channel.
 * @param log - diagnostics sink.
 * @returns the bridge surface.
 */
export function createBridge(log: (message: string) => void): StudioBridge {
  /** Watch connections, keyed by client id, each remembering what it watches. */
  const clients = new Map<string, { res: ServerResponse; projectId: string }>()

  const sendEvent = (res: ServerResponse, type: string, payload: unknown): boolean => {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch {
      return false
    }
  }

  return {
    async handle(req, res, path, query) {
      if (path === '/health') {
        json(res, 200, { ok: true, clients: clients.size, protocolVersion: BRIDGE_PROTOCOL_VERSION })
        return true
      }
      if (path === '/events') {
        const clientId = query.get('clientId') ?? `client-${randomUUID()}`
        const projectId = query.get('projectId') ?? ''
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        })
        clients.set(clientId, { res, projectId })
        log(`bridge: canvas watching (${clientId}, project=${projectId || '未指定'}), clients=${String(clients.size)}`)
        sendEvent(res, 'hello', { protocolVersion: BRIDGE_PROTOCOL_VERSION, projectId })

        const forget = (): void => {
          clearInterval(keepAlive)
          if (clients.delete(clientId)) log(`bridge: canvas left (${clientId})`)
        }
        // A killed browser often sends no FIN that we notice, so the keep-alive
        // write is the only signal left — and swallowing its failure used to
        // leave `clients` permanently inflated, which made /api/health lie.
        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            forget()
          }
        }, 10_000)
        keepAlive.unref()
        req.on('close', forget)
        res.on('close', forget)
        return true
      }
      return false
    },
    connected: () => clients.size > 0,
    clientCount: () => clients.size,
    broadcast(projectId, type, payload) {
      for (const [clientId, client] of clients) {
        // An empty scope means the client did not say what it watches; it gets
        // everything, which is what a generic subscriber wants.
        if (client.projectId !== '' && projectId !== '' && client.projectId !== projectId) continue
        if (!sendEvent(client.res, type, payload)) clients.delete(clientId)
      }
    },
    broadcastDocument(projectId, reason) {
      if (clients.size === 0) return
      this.broadcast(projectId, 'document_changed', { projectId, reason })
      log(`bridge: 通知 ${String(clients.size)} 个画布（${reason}）`)
    },
    close: () => {
      for (const client of clients.values()) client.res.destroy()
      clients.clear()
    },
  }
}
