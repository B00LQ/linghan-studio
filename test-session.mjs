/**
 * Shared harness for the browser-driven acceptance tests.
 *
 * Every canvas test needs the same four things: a logged-in API session, a
 * headless Edge with a CDP session, a way to evaluate expressions in the page,
 * and real input events (synthesizing clicks in JS is blind to clipping and to
 * hit-testing, which is exactly what several of these tests exist to catch).
 *
 * New tests should use this instead of copying the class again.
 *
 * 用法:
 *   import { startSession, apiSession } from './test-session.mjs'
 *   const api = await apiSession(BASE, PASSWORD)
 *   const project = await api.createProject('验收画布')
 *   const s = await startSession({ port: 9250, width: 1500, height: 900 })
 *   await s.login(BASE, PASSWORD)
 *   await s.goto(`${BASE}/canvas/${project.project.id}`)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default Edge location on Windows. */
export const EDGE_PATH = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

/** Sleep. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Log in over HTTP and return the project/canvas helpers for the API side.
 * @param base - server origin.
 * @param password - deployment password.
 * @returns cookie plus helpers that reuse it.
 */
export async function apiSession(base, password) {
  const loginRaw = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = (loginRaw.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
    })
    const body = await response.text()
    return { status: response.status, ok: response.ok, body, json: body === '' ? {} : JSON.parse(body) }
  }
  return {
    cookie,
    call,
    /** Create a canvas, optionally filed in a folder. */
    createProject: async (name, folderId) =>
      (await call('/api/canvases', { method: 'POST', body: JSON.stringify({ name, ...(folderId === undefined ? {} : { folderId }) }) })).json,
    /** Create a folder. */
    createFolder: async (name) => (await call('/api/folders', { method: 'POST', body: JSON.stringify({ name }) })).json,
    /** Move a canvas to the trash (or purge it with `purge`). */
    trashProject: async (projectId, purge = false) =>
      call(`/api/canvases/${projectId}${purge ? '?purge=1' : ''}`, { method: 'DELETE' }),
    createShot: async (projectId, title, prompt) =>
      (await call(`/api/canvases/${projectId}/shots`, { method: 'POST', body: JSON.stringify({ title, prompt }) })).json,
    /** Write a whole canvas document. */
    putCanvas: async (projectId, doc) => call(`/api/canvases/${projectId}/doc`, { method: 'PUT', body: JSON.stringify({ doc }) }),
    /** Read a whole canvas document. */
    getCanvas: async (projectId) => (await call(`/api/canvases/${projectId}/doc`)).json,
    /** Call one Agent tool. */
    agent: async (name, input) => (await call('/api/agent/call', { method: 'POST', body: JSON.stringify({ name, input }) })).json,
  }
}

/** One CDP session against a freshly launched headless Edge. */
export class CdpSession {
  constructor(ws, process, shotDir) {
    this.ws = ws
    this.edge = process
    this.shotDir = shotDir
    this.id = 0
    this.pending = new Map()
    this.consoleErrors = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
        return
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        // Autofill and favicon noise is not a page bug; keep the rest.
        const text = message.params.entry.text
        if (!/autocomplete|favicon/i.test(text)) this.consoleErrors.push(text)
      }
    })
  }

  send(method, params = {}, timeoutMs = 40000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)) }
      }, timeoutMs)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval failed')
    return result.result?.value
  }

  /** Navigate and wait for the app to settle. */
  async goto(url, settleMs = 4000) {
    await this.send('Page.navigate', { url })
    await sleep(settleMs)
  }

  /** Type the deployment password into the login gate when it is showing. */
  async login(base, password) {
    await this.goto(`${base}/`, 4000)
    if (!(await this.evaluate(`document.querySelectorAll('input[type=password]').length > 0`))) return false
    await this.evaluate(`(() => {
      const input = document.querySelector('input[type=password]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(password)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(600)
    await this.evaluate(`(() => { const b = document.querySelector('button[type=submit]'); if (b) b.click(); return true })()`)
    await sleep(5000)
    return true
  }

  /** Click a real mouse position. */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 })
  }

  /** Double click a real mouse position. */
  async doubleClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    for (const count of [1, 2]) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count, buttons: 1 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count, buttons: 1 })
    }
  }

  /** A real drag: press on the source, move in steps, release at the target. */
  async drag(from, to, steps = 8) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 })
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + (to.x - from.x) * t),
        y: Math.round(from.y + (to.y - from.y) * t),
        button: 'left',
        buttons: 1,
      })
      await sleep(30)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 1 })
  }

  /** Click the first button whose trimmed text matches exactly. */
  async clickText(text) {
    return await this.evaluate(`(() => {
      const hit = [...document.querySelectorAll('button,[role=button]')]
        .find((n) => (n.textContent || '').trim() === ${JSON.stringify(text)});
      if (!hit) return false; hit.click(); return true;
    })()`)
  }

  /** Click the first element matching a selector. */
  async clickSelector(selector) {
    return await this.evaluate(`(() => {
      const hit = document.querySelector(${JSON.stringify(selector)});
      if (!hit) return false; hit.click(); return true;
    })()`)
  }

  /** Type one character through real key events (for IME-free text input). */
  async typeChar(char) {
    const code = char.codePointAt(0) ?? 0
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, unmodifiedText: char, key: char, code: `Key${char.toUpperCase()}` })
    await this.send('Input.dispatchKeyEvent', { type: 'char', text: char, unmodifiedText: char })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char, code: `Key${char.toUpperCase()}`, windowsVirtualKeyCode: code })
  }

  /** Whether the point hits the given selector — real hit-testing, not layout. */
  async hitsAt(x, y, selector) {
    return await this.evaluate(`(() => {
      const el = document.elementsFromPoint(${String(x)}, ${String(y)}).find((n) => n.closest(${JSON.stringify(selector)}) !== null);
      return el !== undefined;
    })()`)
  }

  /** Save a screenshot for the human to look at later. */
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    const path = join(this.shotDir, name)
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }

  /** Close the browser. */
  kill() {
    try { this.edge.kill() } catch { /* already gone */ }
  }
}

/**
 * Launch a headless Edge and connect.
 * @param opts - port, viewport size, and screenshot directory.
 * @returns the session.
 */
export async function startSession(opts = {}) {
  const port = Number(opts.port ?? process.env.CDP_PORT ?? 9250)
  const width = opts.width ?? 1500
  const height = opts.height ?? 900
  const shotDir = opts.shotDir ?? process.env.SHOT_DIR ?? tmpdir()
  const profile = mkdtempSync(join(tmpdir(), 'studio-test-'))
  const edge = spawn(EDGE_PATH, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // 首页「新建画布创作」在新窗口打开画布；无头模式下弹窗默认被拦，
    // 不关掉这个开关就测不出「首页留在原地」这件事。
    '--disable-popup-blocking',
    'about:blank',
  ], { stdio: 'ignore' })

  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) break
    } catch { /* not up yet */ }
    await sleep(500)
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const session = new CdpSession(ws, edge, shotDir)
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  await session.send('Log.enable')
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  return session
}

/**
 * A tiny assertion log shared by every suite.
 * @param tag - prefix shown on each line.
 * @returns `check`, `done`, and the running failure count.
 */
export function reporter(tag) {
  let failures = 0
  return {
    log: (...args) => { console.log(`[${tag}]`, ...args) },
    check: (label, condition, detail = '') => {
      console.log(`[${tag}] ${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
      if (!condition) failures += 1
    },
    failures: () => failures,
  }
}
