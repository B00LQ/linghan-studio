/**
 * 外壳与主页验收：路由、导航、主页各区块、深链。
 *
 * 用法: node tests/site-routing-test.mjs <baseUrl> <password>
 *
 * 深链 `/canvas/<projectId>` 是这一轮的关键改动之一：以前测试靠「点侧栏里同名项目」，
 * 而项目重名时它会点到上一轮的项目，制造了间歇性失败。现在认 id。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.CDP_PORT || 9245)
const OUT = process.env.SHOT_DIR || tmpdir()

let failures = 0
const log = (...a) => console.log('[site-router]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const profile = mkdtempSync(join(tmpdir(), 'studio-site-'))
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new',
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  // 首页「新建画布创作」在新窗口打开画布；无头模式下弹窗默认被拦。
  '--disable-popup-blocking',
  'about:blank',
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
  async clickText(text) {
    return await this.evaluate(`(() => {
      const hit = [...document.querySelectorAll('button,a,[role=button]')]
        .find((n) => (n.textContent || '').trim() === ${JSON.stringify(text)});
      if (!hit) return false; hit.click(); return true;
    })()`)
  }
  async clickSelector(selector) {
    return await this.evaluate(`(() => {
      const hit = document.querySelector(${JSON.stringify(selector)});
      if (!hit) return false; hit.click(); return true;
    })()`)
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
  }
}

/** Poll until a probe yields something truthy. */
const until = async (probe, timeoutMs = 15_000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(300)
  }
}

const run = async () => {
  log('⓪ 造两个项目（一个空、一个带内容），并给站点内容写一份覆盖文件')
  const loginRaw = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (loginRaw.headers.getSetCookie?.() ?? []).map((i) => i.split(';')[0]).join('; ')
  const api = (path, init = {}) => fetch(`${BASE}${path}`, {
    ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  })

  const alpha = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '外壳验收-A' }) })).json()
  const beta = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '外壳验收-B' }) })).json()
  await api(`/api/projects/${beta.project.id}/canvas`, {
    method: 'PUT',
    body: JSON.stringify({
      doc: {
        nodes: [{ id: 'text-1', type: 'studio', position: { x: 0, y: 0 }, data: { kind: 'text', text: 'B 项目的节点' } }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    }),
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
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })

  log('① 登录后落在主页')
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
  check('URL 是根路径', (await s.evaluate(`location.pathname`)) === '/', await s.evaluate(`location.pathname`))
  // 判据按**标签**来，不写死个数：导航在长（工作流、设置都是后加的），
  // 而这条要证的是「五个入口都在」，不是「正好四个按钮」。
  const navLabels = await s.evaluate(`[...document.querySelectorAll('.studio-nav > button')].map((b) => b.textContent.trim())`)
  check('左侧导航出现', ['首页', '项目', '资产', '工作流', '设置'].every((label) => navLabels.includes(label)),
    navLabels.join('/'))
  check('显示主页', (await s.evaluate(`document.querySelectorAll('.home').length`)) === 1)

  log('② 主页各区块（图4 的框架）')
  const home = await s.evaluate(`(() => ({
    brand: document.querySelector('.home-hero h1')?.textContent ?? '',
    tagline: document.querySelector('.home-hero p')?.textContent ?? '',
    create: document.querySelector('.home-create')?.textContent ?? '',
    sections: [...document.querySelectorAll('.home-block h2')].map((h) => h.textContent),
    capabilities: document.querySelectorAll('.capability').length,
    planned: document.querySelectorAll('.capability.planned').length,
    ready: document.querySelectorAll('.capability.ready').length,
    highlights: document.querySelectorAll('.highlight-card').length,
    categories: document.querySelectorAll('.category-tabs button').length,
    showcaseItems: document.querySelectorAll('.showcase-card').length,
    recent: document.querySelectorAll('.project-card').length,
  }))()`)
  log('   主页结构:', JSON.stringify(home))
  check('品牌与标语来自站点内容', home.brand !== '' && home.tagline !== '')
  check('「新建画布创作」在', home.create.includes('新建'))
  // 展示区的内容由 site.json 驱动；没有内容时整块不该出现（挂个空板块等于展示一个坏掉的区域）。
  const showcaseHeading = home.sections.includes('展示')
  check('展示区没有内容时不渲染', home.showcaseItems > 0 ? showcaseHeading : !showcaseHeading,
    `站点内容里 ${String(home.showcaseItems)} 条展示项，标题${showcaseHeading ? '出现' : '未出现'}：${home.sections.join(' / ')}`)
  check('核心区块齐备（能力 / 最近画布 / 为什么用它）',
    ['能力', '最近画布', '为什么用它'].every((name) => home.sections.includes(name)), home.sections.join(' / '))
  check('能力入口渲染', home.capabilities >= 6, `${home.capabilities} 个`)
  // 期望值来自站点内容本身，不写死数字：视频那条从 planned 变成 ready 时
  // 「>= 4」就假失败了 —— 而真正要守的是「界面上标成待接入的，正好是内容里标 planned 的那些」。
  const siteContent = await (await api('/api/site')).json()
  const plannedInContent = (siteContent.capabilities ?? []).filter((item) => item.status === 'planned').length
  const readyInContent = (siteContent.capabilities ?? []).filter((item) => item.status === 'ready').length
  check('未接入的能力如实标注', home.planned === plannedInContent && home.ready === readyInContent,
    `界面 ${String(home.planned)} 待接入 / ${String(home.ready)} 就绪；内容 ${String(plannedInContent)} / ${String(readyInContent)}`)
  check('特色卡来自站点内容', home.highlights === 3)
  // 分类页签长在展示区里面，所以展示区不渲染时它们也不该在。
  check('没有展示项时连分类页签都不渲染', home.showcaseItems > 0 ? home.categories >= 1 : home.categories === 0,
    `展示项 ${String(home.showcaseItems)} 条，分类页签 ${String(home.categories)} 个`)
  check('最近项目列出刚建的两个', home.recent >= 2, `${home.recent} 个`)
  await s.shot('home.png')

  log('②b 首页点「新建画布创作」→ 新窗口打开画布，首页留在原地')
  // 首页和画布是两个独立页面：创作不该把正在看的首页顶掉。
  const targetsBefore = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).length
  check('点「新建画布创作」', await s.clickSelector('.home-create'))
  const opened = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    return targets.find((item) => item.type === 'page' && /\/canvas\//u.test(item.url)) ?? null
  })
  const targetsAfter = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).length
  check('画布在新窗口里打开了', opened !== null, opened?.url ?? '没有出现新窗口')
  check('确实多了一个窗口', targetsAfter > targetsBefore, `${String(targetsBefore)} -> ${String(targetsAfter)}`)
  check('首页留在原地（没有被顶掉）', (await s.evaluate('location.pathname')) === '/', await s.evaluate('location.pathname'))
  check('首页上的「新建画布创作」还在', (await s.evaluate(`document.querySelectorAll('.home-create').length`)) === 1)
  // 这一步建的画布叫「未命名画布」，和用户自己点出来的名字一样——
  // 所以必须由这个用例自己收掉，不能指望按名字清库。
  const madeId = (opened?.url ?? '').split('/canvas/')[1] ?? ''
  if (madeId !== '') {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${opened.id}`)
    const purge = await api(`/api/projects/${madeId}?purge=1`, { method: 'DELETE' })
    log(`   收掉这一步建的画布：${purge.ok ? '已删除' : `失败 HTTP ${String(purge.status)}`}`)
  }

  log('③ 导航到项目页')
  check('点「项目」', await s.clickText('项目'))
  await sleep(1500)
  check('URL 变为 /projects', (await s.evaluate(`location.pathname`)) === '/projects')
  const listed = await s.evaluate(`[...document.querySelectorAll('.card.project-card .card-open strong')].map((n) => n.textContent)`)
  check('项目列表含两个验收项目', listed.includes('外壳验收-A') && listed.includes('外壳验收-B'), listed.slice(0, 4).join(' | '))
  check('页面有「创建新的项目」入口', (await s.evaluate(`[...document.querySelectorAll('.create-card')].some((c) => (c.textContent || '').includes('创建新的项目'))`)) === true)

  log('④ 导航到资产页')
  check('点「资产」', await s.clickText('资产'))
  await sleep(1200)
  check('URL 变为 /assets', (await s.evaluate(`location.pathname`)) === '/assets')
  check('资产页渲染', (await s.evaluate(`document.querySelectorAll('.asset-grid, .page .muted').length`)) >= 1)

  log('⑤ 深链直接打开某个画布（不经过任何点击）')
  await s.send('Page.navigate', { url: `${BASE}/canvas/${beta.project.id}` })
  await sleep(4500)
  if (await s.evaluate(`document.querySelectorAll('input[type=password]').length > 0`)) {
    // 深链会先撞上登录门；登录后应回到这个深链
    await s.evaluate(`(() => {
      const input = document.querySelector('input[type=password]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(PASSWORD)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(500)
    await s.evaluate(`(() => { const b = document.querySelector('button[type=submit]'); if (b) b.click(); return true })()`)
    await sleep(4000)
  }
  check('URL 仍是那个深链', (await s.evaluate(`location.pathname`)) === `/canvas/${beta.project.id}`, await s.evaluate(`location.pathname`))
  check('画布本体加载', (await s.evaluate(`document.querySelectorAll('.react-flow').length`)) === 1)
  const nodeText = await s.evaluate(`[...document.querySelectorAll('.studio-node .body')].map((n) => n.textContent).join('|')`)
  check('载入的正是 B 项目的节点', nodeText.includes('B 项目的节点'), nodeText)
  // 画布是独立页面：没有第二条全局导航，也没有左栏——画布铺满，控件浮在上面。
  check('画布页没有全局导航条', (await s.evaluate(`document.querySelectorAll('.studio-nav').length`)) === 0)
  check('画布页没有常驻左栏', (await s.evaluate(`document.querySelectorAll('.canvas-side').length`)) === 0)
  check('左上角是浮动的 logo + 画布名', (await s.evaluate(`document.querySelectorAll('.canvas-topbar').length`)) === 1)
  await s.clickSelector('.canvas-topbar .brand-menu .menu-trigger')
  await sleep(500)
  const menuItems = await s.evaluate(`[...document.querySelectorAll('.brand-menu .menu-panel .menu-item-label')].map((n) => n.textContent.trim())`)
  check('logo 菜单里是 回到主页 / 全部项目 / 创建项目 / 删除项目',
    ['回到主页', '全部项目', '创建项目', '删除项目'].every((label) => menuItems.includes(label)), menuItems.join(' | '))
  await s.evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(300)
  // 那个位置显示的是画布自己的名字。
  check('左上角显示画布名', ((await s.evaluate(`(document.querySelector('.canvas-name-button')?.textContent || '')`))).includes('外壳验收-B'),
    await s.evaluate(`(document.querySelector('.canvas-name-button')?.textContent || '')`))
  // 底部菜单栏里是「画布 / 资产」两个入口。
  const dock = await s.evaluate(`(document.querySelector('.canvas-dock')?.textContent || '').trim()`)
  check('底部菜单栏含 画布 / 资产 / 整理布局', dock.includes('画布') && dock.includes('资产') && dock.includes('整理布局'), dock)
  await s.shot('canvas-deeplink.png')

  log('⑥ 刷新页面仍是同一个画布（深链可重载）')
  await s.evaluate(`location.reload()`)
  await sleep(4500)
  check('重载后仍在 B 画布', (await s.evaluate(`location.pathname`)) === `/canvas/${beta.project.id}`)
  check('重载后节点还在', (await s.evaluate(`[...document.querySelectorAll('.studio-node .body')].map((n) => n.textContent).join('|')`)).includes('B 项目的节点'))

  log('⑦ 切到另一个画布，内容随之改变')
  await s.send('Page.navigate', { url: `${BASE}/canvas/${alpha.project.id}` })
  await sleep(4000)
  check('URL 换成 A 的画布', (await s.evaluate(`location.pathname`)) === `/canvas/${alpha.project.id}`)
  check('A 是空画布', (await s.evaluate(`[...document.querySelectorAll('.studio-node .body')].map((n) => n.textContent).join('|')`)) === '')

  log('⑧ 未知路径显示 404 页而不是白屏')
  await s.send('Page.navigate', { url: `${BASE}/nope/nope` })
  await sleep(3500)
  const notFound = await s.evaluate(`document.body.textContent || ''`)
  check('给出「页面不存在」', notFound.includes('页面不存在'), notFound.slice(0, 40))
  check('提供回首页的出口', await s.clickText('回到首页'))
  await sleep(1200)
  check('回到主页', (await s.evaluate(`document.querySelectorAll('.home').length`)) === 1)

  log('⑨ 浏览器后退键可用')
  await s.evaluate(`history.back()`)
  await sleep(1500)
  check('后退回到未知路径', (await s.evaluate(`document.body.textContent || ''`)).includes('页面不存在'))

  edge.kill()
  log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[site-router] 失败:', error); try { edge.kill() } catch { /* ignore */ } process.exit(1) })
