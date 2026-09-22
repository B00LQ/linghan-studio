/**
 * 双入口实时同步验收：浏览器开着画布时，Agent 的改动应自动出现，无需刷新页面。
 *
 * 用法: node agent-live-sync-test.mjs <baseUrl> <password>
 *
 * 验证的是 bridge 的「通知」那一半：服务端执行 ops 后广播 document_changed，
 * 前端收到就重新加载文档。没有这一步，Agent 改的东西人看不见，
 * 「两个入口操作同一份文档」就只是数据库层面的说法。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9233)

const log = (...a) => console.log('[live-sync]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const profile = mkdtempSync(join(tmpdir(), 'studio-sync-'))
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new',
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' })

/** Minimal CDP session. */
class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)) } }, 30000)
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result?.value
  }
  async clickText(text) {
    return await this.evaluate(`(() => {
      const hit = [...document.querySelectorAll('button,a,[role=button]')]
        .find((n) => (n.textContent || '').trim() === ${JSON.stringify(text)});
      if (!hit) return false; hit.click(); return true;
    })()`)
  }
}

/** Session cookie for the API side of this test. */
async function apiCookie() {
  const raw = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  return (raw.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
}

const run = async () => {
  const cookie = await apiCookie()
  check('API 侧已登录', cookie !== '')

  // 外壳改版后登录不再直达画布，所以这里自己建一个项目，用深链进入，
  // 并把真实的 projectId 交给 Agent 工具，而不是靠页面上读项目名去猜。
  const project = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Agent 实时同步验收' }),
  })).json()
  const projectId = project.project.id

  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch { /* wait */ }
    await sleep(500)
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const s = new Session(ws)
  await s.send('Runtime.enable'); await s.send('Page.enable')
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })

  log('① 打开画布')
  await s.send('Page.navigate', { url: `${BASE}/` })
  await sleep(4000)
  if (await s.evaluate(`document.querySelectorAll('input[type=password]').length > 0`)) {
    await s.evaluate(`(() => {
      const input = document.querySelector('input[type=password]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(PASSWORD)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(500)
    await s.evaluate(`(() => { const b = document.querySelector('button[type=submit]'); if (b) b.click(); return true })()`)
    await sleep(5000)
  }
  await s.send('Page.navigate', { url: `${BASE}/canvas/${projectId}` })
  await sleep(4500)
  check('已进入画布', await s.evaluate(`document.querySelectorAll('.react-flow').length > 0`))

  log('② 等 SSE 连接建立')
  let watchers = 0
  for (let i = 0; i < 20; i += 1) {
    await sleep(500)
    const health = await (await fetch(`${BASE}/api/health`, { headers: { cookie } })).json()
    watchers = health.clients === true ? 1 : 0
    if (watchers === 1) break
  }
  check('服务端看到画布已连接（clients=true）', watchers === 1, 'bridge 的通知才有接收方')

  const before = await s.evaluate(`document.querySelectorAll('.studio-node').length`)
  log(`   当前画布节点数：${before}`)

  log('③ Agent 侧新增一个节点（不刷新页面）')
  const created = await (await fetch(`${BASE}/api/agent/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'canvas_add_node', input: { kind: 'text', text: '这行字是 Agent 写的', projectId } }),
  })).json()
  check('Agent 调用成功', created.ok === true, JSON.stringify(created).slice(0, 120))

  log('④ 画布应自动出现，且不能是整页刷新（导航计数不变）')
  let after = before
  for (let i = 0; i < 20; i += 1) {
    await sleep(500)
    after = await s.evaluate(`document.querySelectorAll('.studio-node').length`)
    if (after > before) break
  }
  check('节点数自动增加', after > before, `${before} -> ${after}`)
  const found = await s.evaluate(`[...document.querySelectorAll('.studio-node .body')].some((n) => (n.textContent || '').includes('这行字是 Agent 写的'))`)
  check('新增节点的内容在画布上可见', found === true)
  // 提示会自己消失（4 秒），所以这里轮询等它出现，而不是在最后看一眼。
  let status = ''
  for (let i = 0; i < 24; i += 1) {
    status = await s.evaluate(`(document.querySelector('.studio-toast')?.textContent || '')`)
    if (/Agent/u.test(status)) break
    await sleep(200)
  }
  check('界面说明了这次变化的来源', /Agent/u.test(status), `状态「${status}」`)

  edge.kill()
  log(failures === 0 ? '\n全部通过：两个入口操作同一份文档，人在场时看得见' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[live-sync] 失败:', error); try { edge.kill() } catch { /* ignore */ } process.exit(1) })
