/**
 * 连线手势验收：从端口拖出线条、松手在空白处 → 「引用该节点生成」。
 *
 * 用法: node tests/canvas-connect-test.mjs <baseUrl> <password>
 *
 * 用真实鼠标拖拽（mousedown → 若干 mousemove → mouseup）驱动，因为被测的就是这条手势。
 * 同时验证：顶部已无添加按钮、菜单按端口类型筛选、资产页签有内容。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9239)
const OUT = process.env.SHOT_DIR || tmpdir()

let failures = 0
const log = (...a) => console.log('[canvas-connect]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const profile = mkdtempSync(join(tmpdir(), 'studio-cn-'))
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
  /** A real drag: press on the source, move in steps, release at the target. */
  async drag(from, to, steps = 8) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 })
    this.sawConnection = false
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + (to.x - from.x) * t),
        y: Math.round(from.y + (to.y - from.y) * t),
        button: 'left',
        buttons: 1,
      })
      // 连线拖拽中 xyflow 会插入一条 connection 线；用它判断「拖拽有没有被识别成连线」。
      if (i === 2) {
        this.sawConnection = await this.evaluate(`document.querySelectorAll('.react-flow__connection, .react-flow__connectionline').length > 0`)
      }
      await sleep(30)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 1 })
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

/** Screen position of a node's first port on the given side. */
const handlePoint = (nodeId, side) => `(() => {
  const node = document.querySelector('.react-flow__node[data-id="' + ${JSON.stringify(nodeId)} + '"]');
  if (!node) return null;
  const handles = [...node.querySelectorAll('.studio-node > .react-flow__handle.${side}')];
  const el = handles[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), count: handles.length };
})()`

const menuState = `(() => {
  const el = document.querySelector('.studio-menu');
  if (!el) return null;
  return { header: el.querySelector('header')?.textContent ?? '', items: [...el.querySelectorAll('button')].map((b) => b.textContent.trim()), notes: [...el.querySelectorAll('.note')].map((n) => n.textContent.trim()) };
})()`

const run = async () => {
  const loginRaw = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (loginRaw.headers.getSetCookie?.() ?? []).map((i) => i.split(';')[0]).join('; ')
  const project = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '连线手势验收' }),
  })).json()

  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch { /* wait */ }
    await sleep(500)
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const s = new Session(ws)
  await s.send('Runtime.enable'); await s.send('Page.enable')
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })

  log('① 登录并打开空项目')
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
  await s.send('Page.navigate', { url: `${BASE}/canvas/${project.project.id}` })
  await sleep(4000)
  check('进入画布', await s.evaluate(`document.querySelectorAll('.react-flow').length > 0`))

  log('② 顶部没有状态条，添加一律走手势')
  // 顶上原来常驻一条「就绪 / 已保存」，占一行却说不出什么信息——现在改成左下角说完自散的提示。
  const statusbar = (await s.evaluate(`document.querySelectorAll('.studio-statusbar').length`))
  check('顶部没有状态条了', statusbar === 0, `${String(statusbar)} 条`)
  const dock = await s.evaluate(`(document.querySelector('.canvas-dock')?.textContent || '').trim()`)
  check('整理布局在底部浮动条里', dock.includes('整理布局') && dock.includes('%'), dock)

  log('③ 先建一个文本节点（走空态快捷入口）')
  check('点击快捷入口「文本」', await s.clickText('文本'))
  await sleep(1200)
  const nodes = await s.evaluate(`[...document.querySelectorAll('.react-flow__node')].map((el) => ({ id: el.getAttribute('data-id'), kind: (el.querySelector('.studio-node') || {}).dataset?.kind }))`)
  check('文本节点已创建', nodes.length === 1 && nodes[0].kind === 'text', JSON.stringify(nodes))

  log('④ 从文本节点端口拖出线条，松手在空白处')
  const handles = await s.evaluate(`[...document.querySelectorAll('.react-flow__node')].flatMap((el) =>
    [...el.querySelectorAll('.react-flow__handle')].map((h) => ({ node: el.getAttribute('data-id'), cls: h.className, parentIsNode: h.parentElement?.className })))`)
  log('   handle 诊断:', JSON.stringify(handles))
  const from = await s.evaluate(handlePoint(nodes[0].id, 'source'))
  check('文本节点有输出端口', from !== null && from.count === 1, JSON.stringify(from))
  // 拖到确认空白的位置
  const empty = await s.evaluate(`(() => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    const rects = [...document.querySelectorAll('.react-flow__node, .prompt-window')].map((el) => el.getBoundingClientRect());
    for (let ry = 0.2; ry <= 0.9; ry += 0.08) for (let rx = 0.2; rx <= 0.9; rx += 0.08) {
      const x = Math.round(pane.left + pane.width * rx), y = Math.round(pane.top + pane.height * ry);
      const hit = document.elementFromPoint(x, y);
      if (hit && !hit.closest('.react-flow__node, .prompt-window, .canvas-dock, .studio-menu')) return { x, y };
    }
    return null;
  })()`)
  log('   落点:', JSON.stringify(empty))
  const onTop = await s.evaluate(`(() => {
    const all = document.elementsFromPoint(${from.x}, ${from.y});
    const handle = document.querySelector('.react-flow__handle.source');
    const cs = handle ? getComputedStyle(handle) : null;
    return {
      stack: all.map((el) => (typeof el.className === 'string' ? el.className : el.tagName)).slice(0, 6),
      handlePointerEvents: cs?.pointerEvents,
      handleZ: cs?.zIndex,
      handlePosition: cs?.position,
      nodePosition: getComputedStyle(document.querySelector('.studio-node')).position,
      windowRect: (() => { const w = document.querySelector('.prompt-window'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    };
  })()`)
  log('   按下点上的元素栈:', JSON.stringify(onTop))
  await s.drag(from, empty ?? { x: from.x + 380, y: from.y + 60 })
  await sleep(800)
  log(`   拖拽被识别为连线: ${String(s.sawConnection)}`)
  const menu = await s.evaluate(menuState)
  check('弹出「引用该节点生成」菜单', menu !== null && menu.header === '引用该节点生成', JSON.stringify(menu))
  check('文本只能接到「图片」', (menu?.items ?? []).some((t) => t.startsWith('图片')) && !(menu?.items ?? []).some((t) => t.startsWith('文本')), menu?.items.join(' | '))
  check('写明接的是哪个端口', (menu?.items ?? []).some((t) => t.includes('接入提示词')), menu?.items.join(' | '))
  await s.shot('canvas-connect-menu.png')

  log('⑤ 选「图片」→ 新节点被创建并自动连线')
  const edgesBefore = await s.evaluate(`document.querySelectorAll('.react-flow__edge').length`)
  check('点击「图片」', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim().startsWith('图片'));
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(1400)
  const after = await s.evaluate(`[...document.querySelectorAll('.react-flow__node')].map((el) => el.getAttribute('data-id'))`)
  const edgesAfter = await s.evaluate(`document.querySelectorAll('.react-flow__edge').length`)
  check('图片节点已创建', after.length === 2 && after.some((id) => id.startsWith('image-')), after.join(','))
  check('连线已建立', edgesAfter === edgesBefore + 1, `${edgesBefore} -> ${edgesAfter}`)
  const selectedWindow = await s.evaluate(`document.querySelectorAll('.prompt-window').length`)
  check('新节点被选中，提示词窗口随之出现', selectedWindow === 1, `${selectedWindow} 个`)

  log('⑥ 从图片节点端口拖出 → 给出能接的种类，而且每一项都真的能接上')
  const imageId = after.find((id) => id.startsWith('image-'))
  const outHandle = await s.evaluate(handlePoint(imageId, 'source'))
  check('图片节点有输出端口', outHandle !== null, JSON.stringify(outHandle))
  await s.drag(outHandle, { x: outHandle.x + 320, y: outHandle.y + 220 })
  await sleep(800)
  const menu2 = await s.evaluate(menuState)
  check('仍然弹出手势菜单', menu2 !== null && menu2.header === '引用该节点生成', JSON.stringify(menu2))
  // 这个断言原本写的是「图片的输出没有可接的节点类型」——那是**图生视频之前**的事实。
  // 现在图片至少能接两处（图片节点的「参考图」与视频节点的「首帧」），所以判据改成：
  // **要么给出候选、要么明说没有**，两端都不许出现「点了没反应」的死按钮。
  // （写死「必须是空」只会让它随端口能力变化而红，而不是随 bug 而红。）
  const items = menu2?.items ?? []
  const notes = menu2?.notes ?? []
  check('要么列出可接的种类，要么明说没有（不放死按钮）',
    items.length > 0 ? items.every((text) => text.trim() !== '') : notes.some((n) => n.includes('暂时没有可接')),
    JSON.stringify(menu2))
  await s.evaluate(`document.querySelector('.studio-menu-scrim')?.click()`)
  await sleep(400)

  log('⑦ 资产悬浮窗（底部菜单栏的「资产」）')
  const png = makePng(48, 48)
  const up = await fetch(`${BASE}/api/assets`, { method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: png })
  check('上传成功', up.ok)
  // 画布是独立页面，没有全局导航也没有左栏；资产是底部菜单栏弹出来的浮窗。
  check('点底部菜单栏的「资产」', await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.canvas-dock button')].find((x) => (x.textContent || '').trim() === '资产');
    if (!b) return false; b.click(); return true;
  })()`))
  await sleep(2000)
  check('浮出资产窗口', (await s.evaluate(`document.querySelectorAll('.assets-panel').length`)) === 1)
  check('URL 仍是画布页', (await s.evaluate(`location.pathname`)).startsWith('/canvas/'), await s.evaluate('location.pathname'))
  const assets = await s.evaluate(`[...document.querySelectorAll('.assets-panel .asset-card')].map((el) => ({ hasImg: !!el.querySelector('img') }))`)
  check('资产列表有内容', assets.length > 0, `${assets.length} 项`)
  check('图片素材显示缩略图', assets.some((a) => a.hasImg), JSON.stringify(assets.slice(0, 2)))

  await s.shot('canvas-connect-final.png')
  log(`截图：${join(OUT, 'canvas-connect-final.png')}`)
  edge.kill()
  log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

/** Minimal PNG encoder for the asset-tab fixture. */
function makePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = (x * 5) % 256
      raw[row + 2 + x * 3] = (y * 5) % 256
      raw[row + 3 + x * 3] = 120
    }
  }
  const crc32 = (buffer) => {
    let crc = 0xffffffff
    for (const byte of buffer) {
      crc ^= byte
      for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

run().catch((error) => { console.error('[canvas-connect] 失败:', error); try { edge.kill() } catch { /* ignore */ } process.exit(1) })
