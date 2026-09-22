/**
 * 左侧列表验收：画布 / 资产 两个页签，以及节点行的「重命名 / 复制 / 添加到 Agent / 删除」。
 *
 * 用法: node canvas-sidebar-test.mjs <baseUrl> <password>
 *
 * 这一栏存在的理由是画布一大就扫不动：列表和画布必须是同一份选择的两个视图，
 * 所以每条断言都同时看列表状态和画布状态，而不是只看列表自己高亮了没有。
 */
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('sidebar')

const node = (id, kind, x, y, extra = {}) => ({ id, type: 'studio', position: { x, y }, data: { kind, ...extra } })

/**
 * Poll until a predicate holds.
 *
 * The canvas autosaves on a 900 ms debounce, so "did that reach the server?" is
 * a question about time, not about correctness. Sleeping a fixed amount makes
 * these assertions flaky for the wrong reason.
 */
const until = async (probe, timeoutMs = 8000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(250)
  }
}

/** Click a row-menu item by label inside the n-th node row. */
const rowAction = async (index, label, session) => {
  const opened = await session.evaluate(`(() => {
    const row = [...document.querySelectorAll('.side-row')][${String(index)}];
    if (!row) return false;
    const trigger = row.querySelector('.row-menu .menu-trigger');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`)
  if (!opened) return false
  await sleep(400)
  return await session.evaluate(`(() => {
    const row = [...document.querySelectorAll('.side-row')][${String(index)}];
    const panel = row?.querySelector('.row-menu .menu-panel');
    if (!panel) return false;
    const hit = [...panel.querySelectorAll('button')].find((b) => ((b.querySelector('.menu-item-label') || b).textContent || '').trim() === ${JSON.stringify(label)});
    if (!hit) return false; hit.click(); return true;
  })()`)
}

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  const project = await api.createProject(`列表验收 ${STAMP}`)
  const projectId = project.project.id
  const seeded = {
    nodes: [
      node('text-a', 'text', 0, 0, { text: '第一段：雨夜街头' }),
      node('text-b', 'text', 0, 220, { text: '第二段：便利店的灯' }),
      node('image-a', 'image', 460, 0, { text: '一张图', url: '' }),
    ],
    edges: [{ id: 'edge-a', source: 'text-a', target: 'image-a', sourceHandle: 'text', targetHandle: 'prompt' }],
    viewport: { x: 0, y: 0, zoom: 0.8 },
  }
  check('播种画布', (await api.putCanvas(projectId, seeded)).ok)

  const s = await startSession({ port: 9249, width: 1500, height: 900 })
  await s.login(BASE, PASSWORD)
  await s.goto(`${BASE}/canvas/${projectId}`, 4500)

  log('① 画布铺满，没有常驻左栏；「画布」在底部菜单栏里点开')
  check('没有常驻左栏', (await s.evaluate(`document.querySelectorAll('.canvas-side').length`)) === 0)
  check('节点列表默认不显示', (await s.evaluate(`document.querySelectorAll('.nodes-panel').length`)) === 0)
  check('底部菜单栏有「画布」入口', await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.canvas-dock button')].find((x) => (x.textContent || '').trim() === '画布');
    if (!b) return false; b.click(); return true;
  })()`))
  await sleep(900)
  check('点开后浮出节点窗口', (await s.evaluate(`document.querySelectorAll('.nodes-panel').length`)) === 1)
  check('窗口在画布左侧', await s.evaluate(`(() => {
    const panel = document.querySelector('.nodes-panel').getBoundingClientRect();
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    return Math.abs(panel.left - pane.left) < 40 && panel.right < pane.left + pane.width / 2;
  })()`))

  log('①b 左上角：logo 菜单 + 画布名（点一下就能改名）')
  check('左上角是浮动控件', (await s.evaluate(`document.querySelectorAll('.canvas-topbar').length`)) === 1)
  check('控件里有 logo 菜单', (await s.evaluate(`document.querySelectorAll('.canvas-topbar .brand-menu').length`)) === 1)
  check('logo 菜单有明确的 ▾', (await s.evaluate(`(document.querySelector('.canvas-topbar .brand-menu .caret')?.textContent || '').includes('▾')`)) === true)
  check('控件里就是画布名', (await s.evaluate(`document.querySelectorAll('.canvas-name-button').length`)) === 1)
  const beforeName = await s.evaluate(`(document.querySelector('.canvas-name-button')?.textContent || '').trim()`)
  check('点画布名进入编辑态', await s.evaluate(`(() => { const b = document.querySelector('.canvas-name-button'); if (!b) return false; b.click(); return true })()`))
  await sleep(400)
  check('变成了输入框', (await s.evaluate(`document.querySelectorAll('.canvas-name-input').length`)) === 1)
  const renamedTo = `改名 ${STAMP}`
  await s.evaluate(`(() => {
    const input = document.querySelector('.canvas-name-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(renamedTo)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`)
  const renamedBack = await until(async () => {
    const text = await s.evaluate(`(document.querySelector('.canvas-name-button')?.textContent || '').trim()`)
    return text === renamedTo ? text : null
  })
  check('回车保存，标题变了', renamedBack === renamedTo, `"${beforeName}" -> "${String(renamedBack)}"`)
  check('服务端也记住了', await until(async () => {
    const doc = (await api.call('/api/projects')).json.projects.find((p) => p.id === projectId)
    return doc?.name === renamedTo ? true : null
  }) === true)

  log('② 节点窗口里就是这个画布的节点，并且有名字')
  const rows = await s.evaluate(`[...document.querySelectorAll('.side-row')].map((r) => ({
    kind: r.dataset.kind,
    name: (r.querySelector('.side-name')?.textContent || '').trim(),
  }))`)
  check('列出三个节点', rows.length === 3, JSON.stringify(rows))
  check('默认名字按类型编号', rows[0]?.name === '文本节点 1' && rows[1]?.name === '文本节点 2' && rows[2]?.name === '图片节点 1', JSON.stringify(rows.map((r) => r.name)))
  check('卡片表头用同一个名字', (await s.evaluate(`[...document.querySelectorAll('.studio-node header span')].map((n) => n.textContent.trim()).filter((t) => t.includes('节点'))`)).includes('图片节点 1'))

  log('③ 点列表里的行 = 选中画布上的那个节点')
  await s.evaluate(`[...document.querySelectorAll('.side-row .side-open')][1].click()`)
  await sleep(1200)
  check('该行变为选中', (await s.evaluate(`document.querySelectorAll('.side-row')[1]?.classList.contains('is-selected')`)) === true)
  check('画布上对应节点也被选中', (await s.evaluate(`document.querySelector('.react-flow__node[data-id="text-b"] .studio-node')?.classList.contains('is-selected')`)) === true)

  log('④ 行菜单四件事都在')
  await s.evaluate(`[...document.querySelectorAll('.side-row .row-menu .menu-trigger')][0].click()`)
  await sleep(500)
  const items = await s.evaluate(`[...document.querySelectorAll('.side-row .row-menu .menu-panel button')].map((b) => ((b.querySelector('.menu-item-label') || b).textContent || '').trim())`)
  check('菜单含 重命名 / 复制 / 添加到 Agent / 删除',
    ['重命名', '复制', '添加到 Agent', '删除'].every((label) => items.includes(label)), items.join(' | '))
  await s.evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(300)
  check('点别处会收起菜单', (await s.evaluate(`document.querySelectorAll('.side-row .row-menu .menu-panel').length`)) === 0)

  log('⑤ 重命名：列表、卡片、数据三处一起变，并且存得住')
  check('打开重命名', await rowAction(0, '重命名', s))
  await sleep(500)
  check('出现了行内输入框', (await s.evaluate(`document.querySelectorAll('.side-rename').length`)) === 1)
  await s.evaluate(`(() => {
    const input = document.querySelector('.side-rename');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '开场镜头');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`)
  await sleep(1200)
  check('列表显示新名字', (await s.evaluate(`(document.querySelectorAll('.side-row .side-name')[0]?.textContent || '').trim()`)) === '开场镜头')
  check('画布卡片表头也跟着变', (await s.evaluate(`document.querySelector('.react-flow__node[data-id="text-a"] header span')?.textContent.trim()`)) === '开场镜头')
  const savedNode = await until(async () => {
    const doc = (await api.getCanvas(projectId)).doc
    return (doc?.nodes ?? []).find((n) => n.id === 'text-a' && n.data?.name === '开场镜头') ?? null
  })
  check('名字写进了画布文档', savedNode !== null, JSON.stringify(savedNode?.data?.name ?? '未保存'))

  log('⑥ 添加到 Agent：行上有标记，文档里有记录，Agent 能读到')
  check('点「添加到 Agent」', await rowAction(2, '添加到 Agent', s))
  await sleep(1200)
  check('该行出现 Agent 标记', (await s.evaluate(`document.querySelectorAll('.side-row')[2]?.querySelector('.side-agent') !== null`)) === true)
  const withContext = await until(async () => {
    const doc = (await api.getCanvas(projectId)).doc
    return (doc?.agentContext ?? []).includes('image-a') ? doc : null
  })
  check('文档记录了 Agent 上下文', withContext !== null, JSON.stringify(withContext?.agentContext ?? []))
  const context = await api.agent('canvas_context', { projectId })
  check('Agent 工具读得到同一个节点', (context.result?.nodes ?? []).some((n) => n.id === 'image-a'),
    JSON.stringify(context.result ?? context).slice(0, 160))
  check('Agent 上下文里没有没被指过的节点', !(context.result?.nodes ?? []).some((n) => n.id === 'text-b'))

  log('⑦ 复制：多一个节点，但生成历史不跟过来')
  check('点「复制」', await rowAction(2, '复制', s))
  const afterCopy = await until(async () => {
    const doc = (await api.getCanvas(projectId)).doc
    return (doc?.nodes ?? []).length === 4 ? doc : null
  })
  check('画布上多了一个节点', afterCopy !== null, `${String((afterCopy?.nodes ?? []).length)} 个`)
  const copies = (afterCopy?.nodes ?? []).filter((n) => n.id !== 'image-a' && n.data?.kind === 'image')
  check('复制出来的节点没有沿用原来的生成历史', copies.length === 1 && (copies[0]?.data?.shotId === undefined || copies[0]?.data?.shotId === ''),
    JSON.stringify(copies[0]?.data?.shotId ?? ''))

  log('⑧ 删除：节点和它的连线一起走')
  check('点「删除」', await rowAction(0, '删除', s))
  const afterDelete = await until(async () => {
    const doc = (await api.getCanvas(projectId)).doc
    return (doc?.nodes ?? []).some((n) => n.id === 'text-a') ? null : doc
  })
  const ids = (afterDelete?.nodes ?? []).map((n) => n.id)
  check('节点被删掉', afterDelete !== null && !ids.includes('text-a'), ids.join(' | '))
  check('连到它的线也没了', (afterDelete?.edges ?? []).every((e) => e.source !== 'text-a' && e.target !== 'text-a'),
    JSON.stringify((afterDelete?.edges ?? []).map((e) => `${e.source}->${e.target}`)))

  log('⑨ 「资产」也是悬浮窗：分类 chip + 搜索 + 卡片墙')
  // 先关掉节点窗，再从底部菜单栏打开资产窗。
  await s.evaluate(`document.querySelector('.nodes-panel .float-close')?.click()`)
  await sleep(500)
  check('点底部菜单栏的「资产」', await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.canvas-dock button')].find((x) => (x.textContent || '').trim() === '资产');
    if (!b) return false; b.click(); return true;
  })()`))
  await sleep(1600)
  check('浮出资产窗口', (await s.evaluate(`document.querySelectorAll('.assets-panel').length`)) === 1)
  check('节点窗已被替换（同一位置不会叠两个）', (await s.evaluate(`document.querySelectorAll('.nodes-panel').length`)) === 0)
  const chips = await s.evaluate(`[...document.querySelectorAll('.assets-panel .chip')].map((c) => c.textContent.trim())`)
  check('有分类 chip（带数量）', chips.length >= 5 && chips[0].startsWith('全部'), chips.join(' | '))
  check('有搜索框', (await s.evaluate(`document.querySelectorAll('.assets-panel .side-search').length`)) === 1)
  const assetCount = await s.evaluate(`document.querySelectorAll('.assets-panel .asset-card').length`)
  const emptyState = await s.evaluate(`document.querySelectorAll('.assets-panel .asset-empty').length`)
  check('要么有素材要么说清楚为空', assetCount > 0 || emptyState === 1, `素材 ${String(assetCount)} 个`)

  log('⑨b 勾选 → 添加到画布；点图是预览，不是放置')
  if (assetCount > 0) {
    const before = (await api.getCanvas(projectId)).doc?.nodes?.length ?? 0
    // 点图现在只放大预览，画布不该有任何变化。
    await s.evaluate(`document.querySelector('.assets-panel .asset-card .asset-open').click()`)
    await sleep(700)
    check('点图弹的是预览', (await s.evaluate(`document.querySelectorAll('[data-testid="asset-preview"]').length`)) === 1)
    check('点图不会顺手放到画布上', ((await api.getCanvas(projectId)).doc?.nodes?.length ?? 0) === before, `仍是 ${String(before)} 个节点`)
    await s.evaluate(`document.querySelector('[data-testid="asset-preview"] .preview-close')?.click()`)
    await sleep(400)

    check('勾选一张', await s.evaluate(`(() => { const p = document.querySelector('.assets-panel .asset-card .pick'); if (!p) return false; p.click(); return true })()`))
    await sleep(500)
    check('点「添加到画布」', await s.evaluate(`(() => {
      const b = [...document.querySelectorAll('.assets-panel [data-testid="asset-batch"] button')].find((x) => (x.textContent || '').trim() === '添加到画布');
      if (!b) return false; b.click(); return true;
    })()`))
    const after = await until(async () => {
      const count = (await api.getCanvas(projectId)).doc?.nodes?.length ?? 0
      return count > before ? count : null
    })
    check('画布上多了这个素材', after !== null, `${String(before)} -> ${String(after ?? before)}`)
    check('放完自动收起窗口', (await s.evaluate(`document.querySelectorAll('.assets-panel').length`)) === 0)
  }
  if (assetCount > 0) {
    await s.evaluate(`(() => {
      const b = [...document.querySelectorAll('.canvas-dock button')].find((x) => (x.textContent || '').trim() === '资产');
      if (b) b.click(); return true;
    })()`)
    await sleep(1500)
    const images = await s.evaluate(`document.querySelectorAll('.assets-panel .asset-card').length`)
    await s.evaluate(`(() => {
      const chip = [...document.querySelectorAll('.assets-panel .chip')].find((c) => (c.textContent || '').trim().startsWith('音频'));
      if (chip) chip.click(); return true;
    })()`)
    await sleep(600)
    const audioCards = await s.evaluate(`document.querySelectorAll('.assets-panel .asset-card').length`)
    check('切成「音频」后不会还剩一堆图片', audioCards < images, `全部 ${String(images)} -> 音频类 ${String(audioCards)}`)
    await s.evaluate(`(() => {
      const chip = [...document.querySelectorAll('.assets-panel .chip')].find((c) => (c.textContent || '').trim().startsWith('全部'));
      if (chip) chip.click(); return true;
    })()`)
    await sleep(500)
  }
  await s.evaluate(`document.querySelector('.assets-panel .float-close')?.click()`)
  await sleep(400)

  check('全程没有 JS 报错', s.consoleErrors.length === 0, s.consoleErrors.slice(0, 2).join(' | '))
  await s.shot('canvas-sidebar.png')

  log('⑩ 重新打开节点窗：工具行与缩略图列表')
  await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.canvas-dock button')].find((x) => (x.textContent || '').trim() === '画布');
    if (b) b.click(); return true;
  })()`)
  await sleep(800)
  check('节点窗回来了', (await s.evaluate(`document.querySelectorAll('.nodes-panel').length`)) === 1)
  check('工具行有搜索框', (await s.evaluate(`document.querySelectorAll('.nodes-panel .side-search').length`)) === 1)
  check('工具行有评级筛选', ((await s.evaluate(`(document.querySelector('.nodes-panel .rating-picker .menu-trigger')?.textContent || '')`))).includes('所有评级'),
    await s.evaluate(`(document.querySelector('.nodes-panel .rating-picker .menu-trigger')?.textContent || '')`))
  check('工具行有视图切换', (await s.evaluate(`document.querySelectorAll('.nodes-panel .view-toggle').length`)) === 1)
  check('列表行带缩略图', (await s.evaluate(`document.querySelectorAll('.side-row .side-thumb').length`)) === (await s.evaluate(`document.querySelectorAll('.side-row').length`)),
    `${String(await s.evaluate(`document.querySelectorAll('.side-row .side-thumb').length`))} 个缩略图`)

  log('⑪ 搜索与评级筛选真的会过滤，不是摆设')
  const allRows = await s.evaluate(`document.querySelectorAll('.side-row').length`)
  await s.evaluate(`(() => {
    const input = document.querySelector('.nodes-panel .side-search');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '图片');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(600)
  const filtered = await s.evaluate(`[...document.querySelectorAll('.side-row .side-name')].map((n) => n.textContent.trim())`)
  check('搜索把列表缩小了', filtered.length > 0 && filtered.length < allRows, `${String(allRows)} -> ${filtered.length}：${filtered.join(' | ')}`)
  check('留下的都是匹配的', filtered.every((name) => name.includes('图片')), filtered.join(' | '))
  await s.evaluate(`(() => {
    const input = document.querySelector('.nodes-panel .side-search');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(700)
  check('清空搜索后恢复', (await s.evaluate(`document.querySelectorAll('.side-row').length`)) === allRows)

  log('⑫ 视图切换：列表 ↔ 网格')
  check('默认是列表视图', (await s.evaluate(`document.querySelector('.side-list')?.classList.contains('grid')`)) === false)
  await s.evaluate(`document.querySelector('.side-tools .view-toggle').click()`)
  await sleep(500)
  check('切到网格视图', (await s.evaluate(`document.querySelector('.side-list')?.classList.contains('grid')`)) === true)
  await s.evaluate(`document.querySelector('.side-tools .view-toggle').click()`)
  await sleep(500)
  check('切回列表视图', (await s.evaluate(`document.querySelector('.side-list')?.classList.contains('grid')`)) === false)

  await s.shot('canvas-sidebar-tools.png')
  s.kill()
  // purge=1：测试留下的画布要真的清掉；只丢进回收站等于换了地方堆。
  await api.call(`/api/projects/${projectId}?purge=1`, { method: 'DELETE' })

  log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[sidebar] 失败:', error); process.exit(1) })
