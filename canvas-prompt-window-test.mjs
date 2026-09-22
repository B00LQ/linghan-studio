/**
 * 新节点模型验收：两种节点、选中才出现的提示词窗口、窗口内生成、多版本。
 *
 * 用法: node canvas-prompt-window-test.mjs <baseUrl> <password>
 *
 * 三件事必须用真实点击验证，因为它们都是「看起来没反应」的高发区：
 * 未选中时不出现窗口、选中后窗口落在卡片下方、生成按钮在窗口里且真的出图。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const PROMPT = process.env.PROMPT || '废车站的候车厅，斜射的晨光，尘埃'
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9241)
const OUT = process.env.SHOT_DIR || tmpdir()

let failures = 0
const log = (...a) => console.log('[prompt-window]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const profile = mkdtempSync(join(tmpdir(), 'studio-pw-'))
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
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 })
  }
  async doubleClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    for (const count of [1, 2]) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count, buttons: 1 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count, buttons: 1 })
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

const nodeRects = `[...document.querySelectorAll('.react-flow__node')].map((el) => {
  const r = el.getBoundingClientRect();
  return { id: el.getAttribute('data-id'), kind: (el.querySelector('.studio-node') || {}).dataset?.kind, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})`

const run = async () => {
  log('⓪ 建空项目')
  const loginRaw = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (loginRaw.headers.getSetCookie?.() ?? []).map((i) => i.split(';')[0]).join('; ')
  const project = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '提示词窗口验收' }),
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

  log('② 顶部不再有状态条；底部居中有浮动条')
  const statusbar = await s.evaluate(`document.querySelectorAll('.studio-statusbar').length`)
  check('顶部状态条已取消', statusbar === 0, `${String(statusbar)} 条`)
  const dock = await s.evaluate(`(() => {
    const el = document.querySelector('.canvas-dock');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    return {
      text: (el.textContent || '').trim(),
      centerX: Math.round(r.x + r.width / 2),
      paneCenterX: Math.round(pane.x + pane.width / 2),
      bottom: Math.round(innerHeight - r.bottom),
    };
  })()`)
  check('存在画布底部浮动条', dock !== null, JSON.stringify(dock))
  check('浮动条里含缩放与整理布局', /%/.test(dock?.text ?? '') && (dock?.text ?? '').includes('整理布局'), dock?.text)
  // 「画布下方居中」= 在**画布区域**内居中（画布从侧栏右侧开始），不是整个窗口居中。
  check('浮动条在画布区域内居中', dock !== null && Math.abs(dock.centerX - dock.paneCenterX) < 30,
    `中心 ${dock?.centerX} vs 画布中心 ${dock?.paneCenterX}`)
  check('浮动条贴近画布底部', dock !== null && dock.bottom < 40, `距底 ${dock?.bottom}px`)

  log('③ 菜单只有「文本」和「图片」')
  const pane = await s.evaluate(`(() => { const r = document.querySelector('.react-flow').getBoundingClientRect(); return { x: Math.round(r.x + r.width * 0.6), y: Math.round(r.y + r.height * 0.55) } })()`)
  await s.doubleClick(pane.x, pane.y)
  await sleep(700)
  const items = await s.evaluate(`[...document.querySelectorAll('.studio-menu button')].map((b) => (b.textContent || '').trim())`)
  check('菜单项为 文本 / 图片 / 上传素材',
    items.length === 3 && items.includes('文本') && items.includes('图片') && items.includes('上传素材'),
    items.join(' | '))
  check('没有镜头、也没有版本宫格', !items.some((t) => t.includes('镜头') || t.includes('宫格')))

  log('④ 未选中节点时，下方没有提示词窗口')
  check('创建图片节点', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim() === '图片');
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(1300)
  const rects = await s.evaluate(nodeRects)
  check('图片节点已创建', rects.length === 1 && rects[0].kind === 'image', JSON.stringify(rects))
  const windowsWhileSelected = await s.evaluate(`document.querySelectorAll('.prompt-window').length`)
  check('刚创建（选中）时窗口出现', windowsWhileSelected === 1, `${windowsWhileSelected} 个`)
  // 点空白处取消选中
  // 点空白处取消选中。必须避开提示词窗口本身——否则点的是窗口里的输入框。
  const clickAt = await s.evaluate(`(() => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    for (let ry = 0.12; ry <= 0.92; ry += 0.06) {
      for (let rx = 0.12; rx <= 0.92; rx += 0.06) {
        const x = Math.round(pane.left + pane.width * rx), y = Math.round(pane.top + pane.height * ry);
        const hit = document.elementFromPoint(x, y);
        if (hit && !hit.closest('.react-flow__node, .prompt-window, .canvas-dock, .studio-menu, .react-flow__minimap')) return { x, y, on: hit.className };
      }
    }
    return null;
  })()`)
  const beforeBlur = await s.evaluate(`({ nodeSelected: document.querySelector('.react-flow__node')?.classList.contains('selected') })`)
  log(`   取消选中：点 (${clickAt?.x},${clickAt?.y})（空白），节点当前 selected=${String(beforeBlur.nodeSelected)}`)
  // 探针：mousedown 有没有真的到页面？到了却不清窗口，才是应用侧的问题。
  await s.evaluate(`(() => {
    window.__md = 0;
    document.querySelector('.studio-body').addEventListener('mousedown', () => { window.__md += 1 }, true);
    return true;
  })()`)
  await s.click(clickAt.x, clickAt.y)
  await sleep(900)
  const probe = await s.evaluate(`({ down: window.__md, windows: document.querySelectorAll('.prompt-window').length })`)
  log(`   探针：mousedown=${probe.down}，窗口数=${probe.windows}`)
  const afterState = await s.evaluate(`({ nodeSelected: document.querySelector('.react-flow__node')?.classList.contains('selected') })`)
  log(`   点击后节点 selected=${String(afterState.nodeSelected)}`)
  const windowsAfterBlur = await s.evaluate(`document.querySelectorAll('.prompt-window').length`)
  check('点空白取消选中后窗口消失', windowsAfterBlur === 0, `${windowsAfterBlur} 个（节点 selected=${String(afterState.nodeSelected)}）`)
  await s.shot('prompt-window-unselected.png')

  log('⑤ 点节点 → 窗口出现在卡片下方（不是别处）')
  const nodeCenter = { x: Math.round(rects[0].x + rects[0].w / 2), y: Math.round(rects[0].y + 30) }
  await s.click(nodeCenter.x, nodeCenter.y)
  await sleep(1000)
  const geometry = await s.evaluate(`(() => {
    const node = document.querySelector('.react-flow__node');
    const win = document.querySelector('.prompt-window');
    if (!node || !win) return null;
    const n = node.getBoundingClientRect(), w = win.getBoundingClientRect();
    return {
      winTop: Math.round(w.top), nodeBottom: Math.round(n.bottom),
      overlapX: Math.min(n.right, w.right) - Math.max(n.left, w.left),
      winLeft: Math.round(w.left), nodeLeft: Math.round(n.left),
      nodeCenterX: Math.round(n.left + n.width / 2),
      winCenterX: Math.round(w.left + w.width / 2),
      overhangLeft: Math.round(n.left - w.left),
      overhangRight: Math.round(w.right - n.right),
      hasTextarea: !!win.querySelector('textarea'),
      placeholder: win.querySelector('textarea')?.placeholder ?? '',
      hasSend: !!win.querySelector('.send'),
      model: win.querySelector('.model')?.textContent ?? '',
    };
  })()`)
  check('提示词窗口出现', geometry !== null)
  check('窗口在卡片下方', geometry !== null && geometry.winTop >= geometry.nodeBottom, `窗口顶 ${geometry?.winTop} vs 卡片底 ${geometry?.nodeBottom}`)
  check('窗口与卡片横向有重叠（对齐同一列）', (geometry?.overlapX ?? 0) > 40, `重叠 ${geometry?.overlapX}px`)
  // 窗口比卡片宽（460 vs 300），所以对齐方式是可选的：左对齐会让右边伸出一大截，
  // 看着像挂错了地方。要求是**水平居中**，两侧伸出量对称。
  const centerDelta = Math.abs((geometry?.winCenterX ?? 0) - (geometry?.nodeCenterX ?? 0))
  check('窗口水平居中对齐卡片', centerDelta <= 2,
    `卡片中心 ${geometry?.nodeCenterX} vs 窗口中心 ${geometry?.winCenterX}（差 ${centerDelta}px）`)
  const overhangDelta = Math.abs((geometry?.overhangLeft ?? 0) - (geometry?.overhangRight ?? 0))
  check('两侧伸出量对称', overhangDelta <= 2,
    `左 ${geometry?.overhangLeft}px / 右 ${geometry?.overhangRight}px`)
  check('窗口里有输入框与生成按钮', geometry?.hasTextarea === true && geometry?.hasSend === true)
  check('占位文案是图片节点的', (geometry?.placeholder ?? '').includes('文字生图'), geometry?.placeholder)
  check('底部显示模型', /ComfyUI/.test(geometry?.model ?? ''), geometry?.model)

  // 关键：窗口必须真的能被点到。
  // getBoundingClientRect 与程序化 .click() 对 overflow 裁剪是盲的——曾经
  // `.studio-node { overflow:hidden }` 把窗口整个裁掉，而上面的断言全部通过。
  // 只有 elementsFromPoint 反映屏幕上真实的命中情况。
  const hit = await s.evaluate(`(() => {
    const win = document.querySelector('.prompt-window');
    const ta = win.querySelector('textarea');
    const send = win.querySelector('.send');
    const at = (el) => {
      const r = el.getBoundingClientRect();
      const stack = document.elementsFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      return { top: typeof stack[0]?.className === 'string' ? stack[0].className.split(' ')[0] : String(stack[0]?.tagName), reachable: stack.includes(el) };
    };
    return { textarea: at(ta), send: at(send), windowReachable: document.elementsFromPoint(${geometry?.winLeft ?? 0} + 10, ${geometry?.winTop ?? 0} + 10).some((el) => el.closest('.prompt-window') !== null) };
  })()`)
  check('输入框在屏幕上真的可点（未被裁剪）', hit.textarea.reachable === true, `栈顶是 ${hit.textarea.top}`)
  check('生成按钮在屏幕上真的可点（未被裁剪）', hit.send.reachable === true, `栈顶是 ${hit.send.top}`)
  check('窗口区域没有被其它元素盖住', hit.windowReachable === true)

  log('⑥ 在窗口里输入 → 点窗口里的 ↑ 生成（顶部没有生成按钮）')
  await s.evaluate(`(() => {
    const el = document.querySelector('.prompt-window textarea');
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(PROMPT)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(500)
  const typed = await s.evaluate(`document.querySelector('.prompt-window textarea').value`)
  check('提示词已写入节点', typed === PROMPT, typed.slice(0, 20))

  const images = () => s.evaluate(`document.querySelectorAll(".studio-node[data-kind='image'] > img").length`)
  const before = await images()
  check('点击窗口里的 ↑', await s.evaluate(`(() => { const b = document.querySelector('.prompt-window .send'); if (!b || b.disabled) return false; b.click(); return true })()`))
  // 首次等待必须覆盖 ComfyUI 的**冷启动**（搬 11 GB 权重进显存，约 80–90 秒）。
  // 热态只要 6 秒，但测试常在刚起服务时跑——等待窗口按冷启动给，否则会把
  // 「还在生成」误判成「生成失败」。
  let after = before
  for (let i = 0; i < 120; i += 1) {
    await sleep(1500)
    after = await images()
    if (after > before) break
  }
  check('图片出现在节点卡片里', after === before + 1, `${before} -> ${after}`)

  log('⑦ 再生成一次：版本累积，窗口里能看到全部')
  const second = await s.evaluate(`(() => { const b = document.querySelector('.prompt-window .send'); if (!b || b.disabled) return false; b.click(); return true })()`)
  check('再次点击 ↑', second === true)
  let cells = 0
  for (let i = 0; i < 60; i += 1) {
    await sleep(1500)
    cells = await s.evaluate(`document.querySelectorAll('.prompt-window .history-cell').length`)
    if (cells >= 2) break
  }
  check('窗口里出现 2 个版本缩略图', cells === 2, `${cells} 个`)
  const badge = await s.evaluate(`(document.querySelector(".studio-node[data-kind='image'] .take-badge")?.textContent || '').trim()`)
  check('卡片角标显示当前是第几版', /第 \d+ 版/.test(badge), badge)

  log('⑧ 点旧版本 → 卡片切换显示，并标记为选用')
  const beforeUrl = await s.evaluate(`document.querySelector(".studio-node[data-kind='image'] > img").getAttribute('src')`)
  check('点击第一个版本', await s.evaluate(`(() => { const c = document.querySelector('.prompt-window .history-cell'); if (!c) return false; c.click(); return true })()`))
  // 选用标记要等两件事：把选用写回服务端，再把这份历史读回来。
  // 固定 sleep 在机器忙的时候会偶发失败，所以这里轮询到出现为止。
  let chosen = 0
  for (let i = 0; i < 20; i += 1) {
    await sleep(400)
    chosen = await s.evaluate(`document.querySelectorAll('.prompt-window .history-cell.is-chosen').length`)
    if (chosen === 1) break
  }
  const afterUrl = await s.evaluate(`document.querySelector(".studio-node[data-kind='image'] > img").getAttribute('src')`)
  check('卡片显示的画面已切换', beforeUrl !== afterUrl, `${beforeUrl?.slice(-8)} -> ${afterUrl?.slice(-8)}`)
  check('被点击的版本标了选用', chosen === 1, `${chosen} 个`)
  await s.shot('prompt-window-selected.png')

  log('⑨ 文本节点：窗口也有，但生成按钮因缺供应商而禁用且说明原因')
  await s.click(pane.x + 260, pane.y - 200)
  await sleep(600)
  await s.doubleClick(pane.x + 260, pane.y - 200)
  await sleep(700)
  check('创建文本节点', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim() === '文本');
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(1300)
  const textWindow = await s.evaluate(`(() => {
    const win = [...document.querySelectorAll('.prompt-window')].pop();
    if (!win) return null;
    const send = win.querySelector('.send');
    return { placeholder: win.querySelector('textarea')?.placeholder ?? '', model: win.querySelector('.model')?.textContent ?? '', disabled: send?.disabled, title: send?.getAttribute('title') ?? '' };
  })()`)
  check('文本节点窗口占位文案不同', (textWindow?.placeholder ?? '').includes('故事'), textWindow?.placeholder)
  check('生成按钮禁用', textWindow?.disabled === true)
  check('并说明为什么禁用', /未配置文本模型/.test(textWindow?.title ?? ''), textWindow?.title)

  log('⑩ 整理布局在浮动条里，点击有效')
  const beforeTidy = await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)
  check('点击浮动条里的「整理布局」', await s.clickText('整理布局'))
  await sleep(1500)
  const overlaps = await s.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.react-flow__node')].map((el) => el.getBoundingClientRect());
    let bad = 0;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 3 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 3) bad++;
    }
    return bad;
  })()`)
  check('节点数量不变', (await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)) === beforeTidy)
  check('整理后零重叠', overlaps === 0, `${overlaps} 处`)

  edge.kill()
  log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[prompt-window] 失败:', error); try { edge.kill() } catch { /* ignore */ } process.exit(1) })
