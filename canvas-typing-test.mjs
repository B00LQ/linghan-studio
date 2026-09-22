/**
 * 复现：在提示词窗口里真实打字。
 *
 * 用法: node typing-repro.mjs <baseUrl> <password>
 *
 * 关键在于用 **Input.dispatchKeyEvent 逐个字符**，而不是设 textarea.value——
 * 设 value 会绕过焦点、组合输入、以及每次按键后的重渲染，正好看不见「打字失败」。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9243)

const log = (...a) => console.log('[typing]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'studio-type-'))
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)) } }, 30000)
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
  /** 真实按键：每个字符一次 keyDown（带 text）+ keyUp，和手打一样。 */
  async typeChar(ch) {
    const code = ch.toUpperCase()
    const vk = ch.toUpperCase().charCodeAt(0)
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code: `Key${code}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${code}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  }
}

const state = `(() => {
  const ta = document.querySelector('.prompt-window textarea');
  const active = document.activeElement;
  return {
    value: ta ? ta.value : '(没有输入框)',
    focused: ta ? active === ta : false,
    activeTag: active ? active.tagName : null,
    activeClass: active && typeof active.className === 'string' ? active.className.split(' ')[0] : null,
    windows: document.querySelectorAll('.prompt-window').length,
  };
})()`

const run = async () => {
  const name = `打字复现 ${Date.now()}`
  const loginRaw = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (loginRaw.headers.getSetCookie?.() ?? []).map((i) => i.split(';')[0]).join('; ')
  const project = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name }),
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

  log('① 登录')
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

  log('② 刷新后仍能用深链打开刚建的项目')
  await s.evaluate(`location.reload()`)
  await sleep(5000)
  await s.send('Page.navigate', { url: `${BASE}/canvas/${project.project.id}` })
  await sleep(4000)
  log('   打开项目:', await s.evaluate(`document.querySelectorAll('.react-flow').length > 0`))

  log('③ 双击空白处 → 建图片节点')
  const pane = await s.evaluate(`(() => { const r = document.querySelector('.react-flow').getBoundingClientRect(); return { x: Math.round(r.x + r.width * 0.45), y: Math.round(r.y + r.height * 0.45) } })()`)
  await s.doubleClick(pane.x, pane.y)
  await sleep(700)
  await s.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.studio-menu button')].find((b) => (b.textContent || '').trim() === '图片');
    if (hit) hit.click(); return true;
  })()`)
  await sleep(1400)
  log('   节点与窗口:', JSON.stringify(await s.evaluate(state)))

  log('④ 点进输入框，逐字真实打字')
  const box = await s.evaluate(`(() => {
    const el = document.querySelector('.prompt-window textarea');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`)
  await s.click(box.x, box.y)
  await sleep(500)
  log('   点后状态:', JSON.stringify(await s.evaluate(state)))

  const text = 'yeyu jiedao'
  for (const ch of text) {
    await s.typeChar(ch)
    await sleep(120)
    const now = await s.evaluate(state)
    log(`   打了「${ch}」→ 值=「${now.value}」 焦点在输入框=${now.focused} 活动元素=${now.activeTag}.${now.activeClass} 窗口数=${now.windows}`)
  }

  const final = await s.evaluate(state)
  log('')
  log(`期望值: 「${text}」`)
  log(`实际值: 「${final.value}」`)
  const asciiOk = final.value === text
  log(asciiOk ? '✓ 英文打字正常' : `✗ 英文打字失败（丢了 ${text.length - final.value.length} 个字符）`)

  log('')
  log('⑤ 中文输入法（composition）：这是与敲字母完全不同的路径')
  await s.evaluate(`(() => { const ta = document.querySelector('.prompt-window textarea'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); return true })()`)
  await sleep(600)

  /** 组合输入中的每一步都要看：值有没有被 React 用 state 回写冲掉。 */
  let imeOk = true
  for (const step of ['yu', 'yuy', '雨', '雨夜']) {
    await s.send('Input.imeSetComposition', { text: step, selectionStart: step.length, selectionEnd: step.length })
    await sleep(400)
    const during = await s.evaluate(state)
    log(`   组合中「${step}」→ 输入框显示「${during.value}」 焦点=${during.focused}`)
  }

  // 输入法「上屏」：把组合中的文字提交
  await s.send('Input.insertText', { text: '雨夜街头' })
  await sleep(700)
  const committed = await s.evaluate(state)
  log(`   上屏后 → 输入框显示「${committed.value}」`)
  if (!committed.value.includes('雨夜街头')) {
    imeOk = false
    log('   ✗ 中文输入失败：上屏的文字没有留住')
  } else {
    log('   ✓ 中文输入正常')
  }

  // 再确认它真的进了节点数据（不只是停在 DOM 上）
  await sleep(1200)
  const persisted = await s.evaluate(`(() => {
    const ta = document.querySelector('.prompt-window textarea');
    return ta ? ta.value : '(没有输入框)';
  })()`)
  log(`   1.2 秒后（经历了自动保存与状态同步）输入框仍是「${persisted}」`)
  if (persisted !== committed.value) imeOk = false

  edge.kill()
  process.exit(asciiOk && imeOk ? 0 : 1)
}

run().catch((error) => { console.error('[typing] 异常:', error); try { edge.kill() } catch { /* ignore */ } process.exit(1) })
