/**
 * 画布可用性验收：脏数据整理、加节点看得见、项目切换、布局不乱。
 *
 * 用法: node tests/canvas-ux-test.mjs <baseUrl> <password>
 *
 * 关键点是**先用 API 播种一份刻意重叠的画布**，再断言「整理后零重叠」——
 * 没有前半句（确实重叠），后半句毫无意义。
 * 重叠一律用**屏幕上真实的渲染矩形**判定，而不是节点坐标：数据里不重叠，
 * 也可能因为尺寸估错而压在一起。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9235)
const OUT = process.env.SHOT_DIR || tmpdir()

let failures = 0
const log = (...a) => console.log('[canvas-ux]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const profile = mkdtempSync(join(tmpdir(), 'studio-ux-'))
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new',
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' })

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)) } }, 40000)
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result?.value
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
  }
  async doubleClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    for (const count of [1, 2]) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count, buttons: 1 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count, buttons: 0 })
    }
  }
  async clickText(text) {
    return await this.evaluate(`(() => {
      const hit = [...document.querySelectorAll('button,[role=button]')]
        .find((n) => (n.textContent || '').trim() === ${JSON.stringify(text)});
      if (!hit) return false; hit.click(); return true;
    })()`)
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
  }
}

/** 真实渲染矩形的两两相交；几像素的贴边不算乱，真的压住才算。 */
const overlapProbe = `(() => {
  const nodes = [...document.querySelectorAll('.react-flow__node')]
    .map((el) => ({ id: el.getAttribute('data-id') || '?', kind: (el.querySelector('.studio-node') || {}).dataset?.kind || '?', r: el.getBoundingClientRect() }))
    .filter((n) => n.r.width > 4 && n.r.height > 4);
  const bad = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i].r, b = nodes[j].r;
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 3 && oy > 3) bad.push({ a: nodes[i].id.slice(0, 18), b: nodes[j].id.slice(0, 18), ox: Math.round(ox), oy: Math.round(oy) });
  }
  return { total: nodes.length, bad };
})()`

/** 有多少节点落在画布可视区内。 */
const visibleProbe = `(() => {
  const pane = document.querySelector('.react-flow');
  if (!pane) return { total: 0, offscreen: [] };
  const p = pane.getBoundingClientRect();
  const offscreen = [...document.querySelectorAll('.react-flow__node')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.right < p.left || r.left > p.right || r.bottom < p.top || r.top > p.bottom;
  }).map((el) => el.getAttribute('data-id'));
  return { total: document.querySelectorAll('.react-flow__node').length, offscreen };
})()`

const run = async () => {
  log('⓪ 用 API 播种一份「重叠的画布」，让回归测的是用户真正遇到的那个 bug')
  const loginRaw = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (loginRaw.headers.getSetCookie?.() ?? []).map((i) => i.split(';')[0]).join('; ')
  const api = (path, init = {}) => fetch(`${BASE}${path}`, {
    ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  })

  const seeded = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '布局回归（重叠画布）' }) })).json()
  const seededId = seeded.project?.id
  // 照抄真实 bug 的形态：**坐标完全相同**。
  const node = (id, kind, x, y, extra = {}) => ({ id, type: 'studio', position: { x, y }, data: { kind, ...extra } })
  const seededDoc = {
    nodes: [
      node('text-seed-a', 'text', 0, 0, { text: '第一段提示词' }),
      node('text-seed-b', 'text', 0, 0, { text: '第二段提示词，与上一段完全重叠' }),
      node('image-seed-a', 'image', 460, 0, { text: '第一张', url: '' }),
      node('image-seed-b', 'image', 460, 0, { text: '第二张，与上一张完全重叠', url: '' }),
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }
  check('播种画布成功', (await api(`/api/projects/${seededId}/canvas`, { method: 'PUT', body: JSON.stringify({ doc: seededDoc }) })).ok, `project=${seededId?.slice(0, 8)}`)

  // 另建一个只含 1 个节点的项目，用于检验「切换项目时画布会不会跟着换」
  const other = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '切换项目回归' }) })).json()
  await api(`/api/projects/${other.project.id}/canvas`, {
    method: 'PUT',
    body: JSON.stringify({ doc: { nodes: [node('text-only', 'text', 0, 0, { text: '这个项目只有一个节点' })], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }),
  })

  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch { /* wait */ }
    await sleep(500)
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const s = new Session(ws)
  await s.send('Runtime.enable'); await s.send('Page.enable')
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })

  log('① 登录并打开刚播种的项目')
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
    await sleep(600)
    await s.evaluate(`(() => { const b = document.querySelector('button[type=submit]'); if (b) b.click(); return true })()`)
    await sleep(5000)
  }
  // 用深链直接打开这个项目：以前靠「点侧栏里同名的项目」，重名时会点到上一轮的。
  await s.send('Page.navigate', { url: `${BASE}/canvas/${seededId}` })
  await sleep(4000)
  check('进入画布', await s.evaluate(`document.querySelectorAll('.react-flow').length > 0`))
  check('画布已加载播种内容', (await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)) >= 4)

  log('② 项目列表里不应有乱码')
  await s.send('Page.navigate', { url: `${BASE}/projects` })
  await sleep(2500)
  const names = await s.evaluate(`[...document.querySelectorAll('.project-list button, .project-list a')].map((n) => n.textContent)`)
  const garbled = names.filter((n) => /\?{2,}/.test(n))
  check('项目页没有问号乱码', garbled.length === 0, garbled.join(' | '))
  await s.send('Page.navigate', { url: `${BASE}/canvas/${seededId}` })
  await sleep(3000)

  log('③ 整理布局：这是用户抱怨「布局混乱」的那份画布')
  const beforeTidy = await s.evaluate(overlapProbe)
  log(`   整理前：${beforeTidy.total} 个可见节点，${beforeTidy.bad.length} 处重叠`)
  check('播种的脏画布确实在屏幕上重叠（前置条件）', beforeTidy.bad.length > 0, JSON.stringify(beforeTidy.bad.slice(0, 2)))
  check('点击浮动条里的「整理布局」', await s.clickText('整理布局'))
  await sleep(1800)
  const afterTidy = await s.evaluate(overlapProbe)
  check('整理后屏幕上零重叠', afterTidy.bad.length === 0,
    afterTidy.bad.length === 0 ? `${afterTidy.total} 个节点` : JSON.stringify(afterTidy.bad.slice(0, 3)))
  const tidyVisible = await s.evaluate(visibleProbe)
  check('整理会把全部节点纳进视野', tidyVisible.offscreen.length === 0, tidyVisible.offscreen.join(','))

  log('④ 双击加节点必须看得见（「点了没效果」的直接检验）')
  const nodesBefore = await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)
  const pane = await s.evaluate(`(() => { const r = document.querySelector('.react-flow').getBoundingClientRect(); return { x: Math.round(r.x + r.width * 0.62), y: Math.round(r.y + r.height * 0.62) } })()`)
  await s.doubleClick(pane.x, pane.y)
  await sleep(700)
  check('面板已弹出', (await s.evaluate(`document.querySelectorAll('.studio-menu').length`)) === 1)
  check('选「图片」', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim() === '图片');
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(1300)
  const afterAdd = await s.evaluate(visibleProbe)
  const newestVisible = await s.evaluate(`(() => {
    const pane = document.querySelector('.react-flow');
    const p = pane.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.react-flow__node')];
    const last = nodes[nodes.length - 1];
    if (!last) return false;
    const r = last.getBoundingClientRect();
    return !(r.right < p.left || r.left > p.right || r.bottom < p.top || r.top > p.bottom);
  })()`)
  check('节点数增加', afterAdd.total > nodesBefore, `${nodesBefore} -> ${afterAdd.total}`)
  // 视野会聚焦到刚加的节点上，可见总数可能反而变少——所以断言落在「新节点自己可见」。
  check('刚加的节点出现在视野内', newestVisible === true, `屏外共 ${afterAdd.offscreen.length} 个（聚焦后属正常）`)
  check('加完仍然零重叠', (await s.evaluate(overlapProbe)).bad.length === 0)

  log('⑤ 在提示词窗口里生成，画面必须出现在卡片上')
  const promptWin = await s.evaluate(`document.querySelectorAll('.prompt-window').length`)
  check('新节点被选中，窗口随之出现', promptWin === 1, `${promptWin} 个`)
  const prompt = '布局回归：雨后的老城区巷子，积水倒影，暖黄路灯'
  await s.evaluate(`(() => {
    const el = document.querySelector('.prompt-window textarea');
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(prompt)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(600)
  const cards = () => s.evaluate(`document.querySelectorAll('.react-flow__node.selected .studio-node > img').length`)
  const beforeGen = await cards()
  check('点窗口里的 ↑', await s.evaluate(`(() => { const b = document.querySelector('.prompt-window .send'); if (!b || b.disabled) return false; b.click(); return true })()`))
  let afterGen = beforeGen
  for (let i = 0; i < 60; i += 1) {
    await sleep(1500)
    afterGen = await cards()
    if (afterGen > beforeGen) break
  }
  check('画面出现在该节点卡片上', afterGen > beforeGen, `${beforeGen} -> ${afterGen}`)
  check('生成后布局仍然零重叠', (await s.evaluate(overlapProbe)).bad.length === 0)

  await s.shot('canvas-ux-after.png')
  log(`截图：${join(OUT, 'canvas-ux-after.png')}`)

  log('⑥ 用深链切换项目，画布必须跟着换')
  const beforeSwitch = await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)
  await s.send('Page.navigate', { url: `${BASE}/canvas/${other.project.id}` })
  await sleep(4000)
  const afterSwitch = await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)
  const switchedText = await s.evaluate(`[...document.querySelectorAll(".studio-node[data-kind='text'] .body")].map((n) => n.textContent).join('|')`)
  check('画布换成了另一个项目的内容', afterSwitch !== beforeSwitch, `${beforeSwitch} -> ${afterSwitch} 个节点`)
  check('显示的正是那个项目的内容', switchedText.includes('这个项目只有一个节点'), switchedText.slice(0, 60))

  edge.kill()
  log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[canvas-ux] 失败:', error); try { edge.kill() } catch { /* ignore */ } process.exit(1) })
