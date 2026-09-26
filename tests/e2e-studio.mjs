/**
 * Studio 端到端验收：登录 → 建配置节点 → 输入提示词 → 生成 → 检查画布出现图片。
 * 用法: node tests/e2e-studio.mjs <baseUrl> <password>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8099'
const PASSWORD = process.argv[3] || 'test-pass-123'
const PROMPT = process.env.PROMPT || '雨夜霓虹街头，电影感广角，湿地面反光'
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9231)
const OUT = process.env.SHOT_DIR || tmpdir()

const log = (...a) => console.log('[studio-e2e]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'studio-edge-'))
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new',
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' })

class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); return
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') this.errors.push(m.params.entry.text)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)) } }, 60000)
    })
  }
  async evaluate(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
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
  async doubleClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    for (const count of [1, 2]) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count, buttons: 1 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count, buttons: 1 })
    }
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
    log('截图:', join(OUT, name))
  }
}

const main = async () => {
  // 外壳现在是「首页 + 项目列表 + 画布」，所以先建一个专属项目，用深链进入，
  // 不再依赖「登录后直接落到某个画布上」。
  const loginRaw = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (loginRaw.headers.getSetCookie?.() ?? []).map((i) => i.split(';')[0]).join('; ')
  const project = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: `端到端验收 ${new Date().toISOString().slice(0, 19)}` }),
  })).json()
  log('验收项目:', project.project?.name, project.project?.id?.slice(0, 8))

  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch { /* wait */ }
    await sleep(500)
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const s = new Session(ws)
  await s.send('Runtime.enable'); await s.send('Page.enable'); await s.send('Log.enable')
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })

  log('打开', BASE)
  await s.send('Page.navigate', { url: `${BASE}/` })
  await sleep(4000)

  log('① 登录')
  const hasGate = await s.evaluate(`document.querySelectorAll('input[type=password]').length > 0`)
  log('   登录页存在:', hasGate)
  if (hasGate) {
    await s.evaluate(`(() => {
      const input = document.querySelector('input[type=password]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(PASSWORD)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(600)
    log('   提交:', await s.evaluate(`(() => { const b = document.querySelector('button[type=submit]'); if (!b) return false; b.click(); return true; })()`))
    await sleep(5000)
  }
  await s.send('Page.navigate', { url: `${BASE}/canvas/${project.project.id}` })
  await sleep(4000)
  log('   进入画布:', await s.evaluate(`document.querySelectorAll('.react-flow').length > 0`))

  log('② 新建图片节点（双击画布 → 面板 → 图片）')
  const pane = await s.evaluate(`(() => { const r = document.querySelector('.react-flow').getBoundingClientRect(); return { x: Math.round(r.x + r.width * 0.35), y: Math.round(r.y + r.height * 0.4) } })()`)
  await s.doubleClick(pane.x, pane.y)
  await sleep(700)
  log('   双击打开面板:', await s.evaluate(`document.querySelectorAll('.studio-menu').length === 1`))
  log('   选择图片:', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim() === '图片');
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(1500)
  const hasWindow = await s.evaluate(`document.querySelectorAll('.prompt-window textarea').length > 0`)
  log('   提示词窗口出现（选中才有）:', hasWindow)

  log('③ 在节点下方的窗口里输入提示词')
  if (hasWindow) {
    // 先清空：项目是复用的，输入框里可能残留上一次的提示词，
    // 直接 insertText 会变成拼接，之后那句「输入框内容」的断言就失去意义。
    await s.evaluate(`(() => {
      const el = document.querySelector('.prompt-window textarea');
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(300)
    const box = await s.evaluate(`(() => {
      const el = document.querySelector('.prompt-window textarea');
      el.focus(); el.click();
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    }
    await sleep(500)
    await s.send('Input.insertText', { text: PROMPT })
    await sleep(800)
    const typed = await s.evaluate(`document.querySelector('.prompt-window textarea').value`)
    log('   输入框内容:', JSON.stringify(typed))
    if (typed !== PROMPT) log('   ⚠ 输入框内容与预期不一致，生成结果可信度存疑')
  }

  // 项目是复用的，画布上还留着上一轮跑出来的画面。所以必须比较「生成前后的差值」——
  // 用 images > 0 当成功条件的话，它在什么都没生成时就已经成立了。
  const countImages = () => s.evaluate(`document.querySelectorAll('.studio-node > .node-media > img').length`)
  const attempts = Number(process.env.GEN_ATTEMPTS || 60)
  const waitForImages = async (target) => {
    for (let i = 0; i < attempts; i += 1) {
      await sleep(1500)
      const current = await countImages()
      if (current >= target) return current
    }
    return await countImages()
  }

  const before = await countImages()
  log(`④ 点窗口里的 ↑ 生成（画布当前已有 ${before} 张画面，必须看到增加）`)
  // 诊断（曾用来定位「按钮被禁用」的间歇失败）：确认窗口挂在哪个节点上。
  const diag = await s.evaluate(`(() => {
    const active = [...document.querySelectorAll('.react-flow__node')].find((el) => el.querySelector('.prompt-window'));
    const send = active?.querySelector('.prompt-window .send');
    return {
      nodes: document.querySelectorAll('.react-flow__node').length,
      windows: document.querySelectorAll('.prompt-window').length,
      activeNode: active?.getAttribute('data-id') ?? null,
      sendDisabled: send?.disabled ?? null,
    };
  })()`)
  log('   窗口归属:', JSON.stringify(diag))
  log('   点击:', await s.evaluate(`(() => { const b = document.querySelector('.prompt-window .send'); if (!b || b.disabled) return false; b.click(); return true })()`))
  let images = await waitForImages(before + 1)
  const status = await s.evaluate(`(document.querySelector('.studio-status')?.textContent || '')`)
  log(`   ⚡ 第一次：画面 ${before} -> ${images}，状态「${status}」`)

  log('⑤ 再生成一次（成为该节点的第 2 个版本）')
  log('   点击:', await s.evaluate(`(() => { const b = document.querySelector('.prompt-window .send'); if (!b || b.disabled) return false; b.click(); return true })()`))
  images = await waitForImages(images + 1)
  const status2 = await s.evaluate(`(document.querySelector('.studio-status')?.textContent || '')`)
  log(`   ⚡ 第二次：画面 -> ${images}，状态「${status2}」`)

  log('⑥ 版本历史（生成即入 take，点开节点就能看到全部）')
  // 画面出现 ≠ 版本历史已经走完：loadTakes 是在 setNodes 之后才 await 的。
  // 断言必须轮询等待，否则测的是「渲染得多快」而不是「功能对不对」。
  const waitForCount = async (expression, target) => {
    let current = 0
    for (let i = 0; i < 20; i += 1) {
      current = await s.evaluate(expression)
      if (current >= target) return current
      await sleep(500)
    }
    return current
  }
  const versionCells = await waitForCount(`document.querySelectorAll('.prompt-window .history-cell').length`, 2)
  const badge = await s.evaluate(`(document.querySelector(".studio-node[data-kind='image'] .take-badge")?.textContent || '').trim()`)
  log(`   窗口里 ${versionCells} 个版本缩略图；卡片角标「${badge}」`)

  log('⑦ 点旧版本 → 卡片切换显示，并标记为选用')
  // 必须是**当前选中**的那个节点：项目是复用的，画布上还有历史节点，
  // 用 .studio-node[data-kind=image] 会取到第一个，断言就测了别的节点。
  const cardImage = `document.querySelector('.react-flow__node.selected .studio-node > .node-media > img')?.getAttribute('src') ?? ''`
  const beforeUrl = await s.evaluate(cardImage)
  const clicked = await s.evaluate(`(() => { const c = document.querySelector('.prompt-window .history-cell'); if (!c) return false; c.click(); return true })()`)
  const picked = await waitForCount(`document.querySelectorAll('.prompt-window .history-cell.is-chosen').length`, 1)
  await sleep(900)
  const afterUrl = await s.evaluate(cardImage)
  log(`   点击旧版本: ${clicked}；已选用标记 ${picked} 个；画面切换: ${beforeUrl !== afterUrl}`)

  const nodes = await s.evaluate(`document.querySelectorAll('.studio-node').length`)
  log(`   画布节点总数: ${nodes}`)
  await s.shot('studio-after-generate.png')

  const grew = images > before
  const ok = grew && versionCells === 2 && picked === 1 && beforeUrl !== afterUrl && !/失败|为空|先选中/u.test(status2)
  if (!ok) log(`   ⚠ 未通过：新增画面=${String(grew)} 版本数=${String(versionCells)} 已选用=${String(picked)} 画面切换=${String(beforeUrl !== afterUrl)} 状态=「${status2}」`)
  if (s.errors.length) log('页面错误:', s.errors.slice(0, 5))
  edge.kill()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('[studio-e2e] 失败:', e); try { edge.kill() } catch { /* ignore */ } process.exit(1) })
