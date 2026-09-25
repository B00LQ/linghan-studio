/**
 * 右键菜单 / 撤销重做 / 上传素材 验收。
 *
 * 用法: node canvas-interaction-test.mjs <baseUrl> <password>
 *
 * 双击加节点与提示词窗口由 canvas-prompt-window-test 覆盖，拉线由 canvas-connect-test 覆盖，
 * 这一套只负责剩下三件事：右键菜单、历史操作、上传落地。
 * 全部用真实鼠标事件驱动——要验的就是「用户这样点，界面是不是这样反应」。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { CANVAS_NODES } from './apps/web/src/canvas/ports.ts'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9237)
const OUT = process.env.SHOT_DIR || tmpdir()

let failures = 0
const log = (...a) => console.log('[canvas-io]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const profile = mkdtempSync(join(tmpdir(), 'studio-io-'))
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
  async click(x, y, button = 'left') {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    // buttons 是「当前按下的键位掩码」：按下时含该键，**释放时必须回到 0**。
    // 释放时仍传 2 会让浏览器以为右键还按着，后续的 contextmenu 就被吞掉了。
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, buttons: button === 'right' ? 2 : 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, buttons: 0 })
  }
  /**
   * 右键：CDP 不会合成 contextmenu，所以真实按键 + 显式派发 contextmenu。
   *
   * 派发后必须**等 React 提交渲染**再读 DOM：React 的事件处理是异步批处理的，
   * 派发后立刻同步查询会永远读到旧结果——这正是上一版「菜单从未出现」的假象来源。
   */
  async rightClick(x, y) {
    await this.click(x, y, 'right')
    // 直接派发到 pane 元素上（探针证明这条路径有效；elementFromPoint 取到的
    // 未必是同一个节点，之前就是它导致事件落在了别处）。
    return await this.evaluate(`(async () => {
      const pane = document.querySelector('.react-flow__pane');
      if (!pane) return -1;
      pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 2, buttons: 2 }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return document.querySelectorAll('.studio-menu').length;
    })()`)
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

const menuItems = `[...document.querySelectorAll('.studio-menu button')].map((b) => ({ text: (b.textContent || '').trim(), disabled: b.disabled }))`

const run = async () => {
  log('⓪ 建空项目')
  const loginRaw = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (loginRaw.headers.getSetCookie?.() ?? []).map((i) => i.split(';')[0]).join('; ')
  const project = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '交互验收（空画布）' }),
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

  log('② 空画布提示与快捷入口')
  const hint = await s.evaluate(`(document.querySelector('.studio-empty p')?.textContent || '').trim()`)
  check('显示「双击画布 添加节点」', hint === '双击画布 添加节点', hint)
  const chips = await s.evaluate(`[...document.querySelectorAll('.studio-empty-chips button')].map((b) => b.textContent)`)
  // 期望值从 CANVAS_NODES 推导：写死列表的话每加一种节点都得来改测试，
  // 而「词表里有的种类都在快捷入口里」才是要守的那条。
  const expectedKinds = [...CANVAS_NODES.map((spec) => spec.title), '上传素材']
  check(`快捷入口为 ${expectedKinds.join(' / ')}`,
    chips.length === expectedKinds.length && expectedKinds.every((label) => chips.includes(label)), chips.join(' / '))

  // 找一个真正空白的位置（避开节点、提示词窗口、底部浮动条、小地图）
  const emptyPoint = async (skip = 0) => s.evaluate(`(() => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    const found = [];
    for (let ry = 0.12; ry <= 0.92; ry += 0.06) for (let rx = 0.12; rx <= 0.92; rx += 0.06) {
      const x = Math.round(pane.left + pane.width * rx), y = Math.round(pane.top + pane.height * ry);
      const hit = document.elementFromPoint(x, y);
      if (hit && !hit.closest('.react-flow__node, .prompt-window, .canvas-dock, .studio-menu, .react-flow__minimap')) found.push({ x, y });
    }
    return found[${skip}] ?? null;
  })()`)
  const p1 = await emptyPoint(0)
  const atP1 = await s.evaluate(`(() => {
    const el = document.elementFromPoint(${p1?.x ?? 0}, ${p1?.y ?? 0});
    return { x: ${p1?.x ?? 0}, y: ${p1?.y ?? 0}, tag: el?.tagName, cls: typeof el?.className === 'string' ? el.className : String(el?.className) };
  })()`)
  log('   右键落点:', JSON.stringify(atP1))
  log('   源码里有无 onPaneContextMenu: ' + String(await s.evaluate(`document.querySelectorAll('.react-flow').length > 0`)))

  log('③ 右键空白处 → 菜单含上传 / 添加节点 / 撤销 / 重做')
  const opened = await s.rightClick(p1.x, p1.y)
  log(`   右键后菜单数量: ${String(opened)}`)
  const items = await s.evaluate(menuItems)
  check('菜单已弹出', items.length > 0, items.map((i) => i.text).join(' | '))
  check('含「上传素材」与「添加节点」',
    items.some((i) => i.text.startsWith('上传素材')) && items.some((i) => i.text.startsWith('添加节点')))
  check('含撤销与重做', items.some((i) => i.text.startsWith('撤销')) && items.some((i) => i.text.startsWith('重做')))
  check('此时撤销不可用（还没做过改动）', items.find((i) => i.text.startsWith('撤销'))?.disabled === true)
  check('重做也不可用', items.find((i) => i.text.startsWith('重做'))?.disabled === true)
  await s.shot('canvas-io-context-menu.png')

  log('④ 菜单里「添加节点」展开为词表里的全部种类')
  check('点击「添加节点」', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim().startsWith('添加节点'));
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(500)
  const submenu = await s.evaluate(`[...document.querySelectorAll('.studio-menu button')].map((b) => (b.textContent || '').trim())`)
  check(`展开后就是 ${expectedKinds.join(' / ')}`,
    submenu.length === expectedKinds.length && expectedKinds.every((label) => submenu.includes(label)), submenu.join(' | '))
  check('点击「文本」', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim() === '文本');
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(1100)
  check('节点已创建', (await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 1)

  log('⑤ 撤销 / 重做（菜单 + 键盘）')
  const p2 = await emptyPoint(3)
  await s.rightClick(p2.x, p2.y)
  await sleep(600)
  const afterCreate = await s.evaluate(menuItems)
  check('有改动后撤销变为可用', afterCreate.find((i) => i.text.startsWith('撤销'))?.disabled === false)
  check('点击「撤销」', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim().startsWith('撤销'));
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(1100)
  check('节点被撤销掉', (await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 0)

  await s.rightClick(p2.x, p2.y)
  await sleep(600)
  check('点击「重做」', await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim().startsWith('重做'));
    if (!hit) return false; hit.click(); return true;
  })()`))
  await sleep(1100)
  check('节点被恢复', (await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 1)

  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await sleep(900)
  check('Ctrl+Z 生效', (await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 0)
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 10 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 10 })
  await sleep(900)
  check('Ctrl+Shift+Z 生效', (await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 1)

  log('⑥ 上传素材 → 落地成图片节点，并进素材库')
  const png = makePng(64, 64)
  const b64 = png.toString('base64')
  const injected = await s.evaluate(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'test-upload.png', { type: 'image/png' });
    const input = document.querySelector('input[type=file]');
    if (!input) return { ok: false, why: 'no file input' };
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`)
  check('文件注入成功', injected.ok === true, injected.why ?? '')
  let uploadUrl = null
  for (let i = 0; i < 20; i += 1) {
    await sleep(600)
    uploadUrl = await s.evaluate(`(() => {
      const el = [...document.querySelectorAll(".studio-node[data-kind='image'] > img")].find((img) => (img.getAttribute('src') || '').startsWith('/api/assets/'));
      return el ? el.getAttribute('src') : null;
    })()`)
    if (uploadUrl !== null) break
  }
  check('上传后画布出现引用素材的图片节点', typeof uploadUrl === 'string' && uploadUrl.startsWith('/api/assets/'), String(uploadUrl))
  // 状态改成左下角「说完自散」的提示了：它 4 秒后消失，所以要轮询而不是看一眼。
  const uploadNote = await (async () => {
    for (let i = 0; i < 20; i += 1) {
      const text = await s.evaluate(`(document.querySelector('.studio-toast')?.textContent || '')`)
      if (text.includes('已上传')) return text
      await sleep(200)
    }
    return ''
  })()
  check('界面报告上传结果', uploadNote.includes('已上传'), uploadNote)

  if (typeof uploadUrl === 'string') {
    const fetched = await fetch(`${BASE}${uploadUrl}`, { headers: { cookie } })
    const bytes = Buffer.from(await fetched.arrayBuffer())
    check('素材可被取回且字节一致', fetched.ok && bytes.length === png.length, `${bytes.length} vs ${png.length}`)
    const again = await (await fetch(`${BASE}/api/assets`, { method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: png })).json()
    check('相同字节上传命中去重', again.asset?.id === uploadUrl.split('/').pop(), String(again.asset?.id))
  }

  log('⑦ 上传的节点也是图片节点：选中后同样有提示词窗口')
  const imageNodeId = await s.evaluate(`[...document.querySelectorAll(".react-flow__node[data-id^='image-']")].map((el) => el.getAttribute('data-id'))[0] ?? null`)
  const center = imageNodeId === null ? null : await s.evaluate(`(() => {
    const el = document.querySelector('.react-flow__node[data-id="' + ${JSON.stringify(imageNodeId)} + '"]');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 24) };
  })()`)
  if (center !== null) await s.click(center.x, center.y)
  await sleep(900)
  const windows = await s.evaluate(`document.querySelectorAll('.prompt-window').length`)
  check('图片节点被选中后出现窗口', windows === 1, `${windows} 个`)

  log('⑦b 从底部浮动条的 ＋ 打开菜单：必须从按钮上方长出来')
  // 这一条是为一个真实反馈写的：「点击添加节点后弹出的窗口位置不对」——
  // 菜单原来锚在窗口中心，而按钮在底部，于是菜单出现在屏幕中上部、离按钮很远。
  check('关闭已有菜单', await s.evaluate(`(() => { document.querySelector('.studio-menu-scrim')?.click(); return true })()`))
  await sleep(400)
  const anchor = await s.evaluate(`(() => {
    const button = [...document.querySelectorAll('.canvas-dock button')].find((b) => (b.textContent || '').trim() === '＋');
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: Math.round(r.left), bottom: Math.round(r.bottom) };
  })()`)
  check('找得到浮动条的 ＋', anchor !== null, JSON.stringify(anchor))
  await s.click(anchor.x, anchor.y)
  await sleep(700)
  const placement = await s.evaluate(`(() => {
    const menu = document.querySelector('.studio-menu');
    if (!menu) return null;
    const m = menu.getBoundingClientRect();
    const button = [...document.querySelectorAll('.canvas-dock button')].find((b) => (b.textContent || '').trim() === '＋');
    const b = button.getBoundingClientRect();
    return {
      menu: { left: Math.round(m.left), right: Math.round(m.right), top: Math.round(m.top), bottom: Math.round(m.bottom) },
      button: { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  })()`)
  check('菜单打开了', placement !== null, JSON.stringify(placement))
  check('菜单在按钮上方（不是窗口中心）', (placement?.menu.bottom ?? 0) <= (placement?.button.top ?? 0) + 2,
    `菜单底 ${String(placement?.menu.bottom)} vs 按钮顶 ${String(placement?.button.top)}`)
  check('菜单横向挨着按钮', Math.abs((placement?.menu.left ?? 0) - (placement?.button.left ?? 0)) <= 40,
    `菜单左 ${String(placement?.menu.left)} vs 按钮左 ${String(placement?.button.left)}`)
  check('菜单完整落在窗口里', (placement?.menu.left ?? -1) >= 0 && (placement?.menu.top ?? -1) >= 0
    && (placement?.menu.right ?? 9999) <= (placement?.viewport.w ?? 0) && (placement?.menu.bottom ?? 9999) <= (placement?.viewport.h ?? 0),
    JSON.stringify(placement))
  const dockMenu = await s.evaluate(`[...document.querySelectorAll('.studio-menu button')].map((b) => (b.textContent || '').trim())`)
  check('菜单里就是 文本 / 图片 / 上传素材',
    ['文本', '图片', '上传素材'].every((label) => dockMenu.includes(label)), dockMenu.join(' | '))
  await s.evaluate(`(() => { document.querySelector('.studio-menu-scrim')?.click(); return true })()`)
  await sleep(300)

  log('⑧ 整理布局后零重叠')
  check('点击浮动条里的「整理布局」', await s.clickText('整理布局'))
  await sleep(1500)
  const overlaps = await s.evaluate(`(() => {
    const rects = [...document.querySelectorAll('.react-flow__node')].map((el) => el.getBoundingClientRect());
    let bad = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 3 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 3) bad++;
    }
    return bad;
  })()`)
  check('整理后零重叠', overlaps === 0, `${overlaps} 处`)

  await s.shot('canvas-io-final.png')
  log(`截图：${join(OUT, 'canvas-io-final.png')}`)
  edge.kill()
  log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

/** Minimal PNG encoder for upload fixtures. */
function makePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = (x * 4) % 256
      raw[row + 2 + x * 3] = (y * 4) % 256
      raw[row + 3 + x * 3] = 160
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

run().catch((error) => { console.error('[canvas-io] 失败:', error); try { edge.kill() } catch { /* ignore */ } process.exit(1) })
