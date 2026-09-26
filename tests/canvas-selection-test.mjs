/**
 * 框选与多选工具条验收。
 *
 * 用法: node tests/canvas-selection-test.mjs <baseUrl> <password>
 *
 * 框选是纯手势，所以必须用真实鼠标拖（mousedown → 多段 mousemove → mouseup）：
 * 用 JS 直接给节点加 selected 完全绕过了「拖出来的框有没有命中」这件事，
 * 而那正是这个功能本身。
 */
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('selection')

const node = (id, kind, x, y, extra = {}) => ({ id, type: 'studio', position: { x, y }, data: { kind, ...extra } })

/** Poll until a probe yields something truthy. */
const until = async (probe, timeoutMs = 8000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(200)
  }
}

/** Screen rectangle of one node. */
const nodeRect = (id, session) => session.evaluate(`(() => {
  const el = document.querySelector('.react-flow__node[data-id="${id}"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
})()`)

/** Screen rectangle of the pane — a drag that starts outside it hits the header instead. */
const paneRect = (session) => session.evaluate(`(() => {
  const r = document.querySelector('.react-flow').getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
})()`)

/**
 * Drag a marquee between two corners, keeping both inside the pane.
 *
 * A node at world y=0 sits flush with the pane's top edge, so "30px above the
 * node" is often outside the canvas altogether — and then the press lands on the
 * header and nothing is selected at all.
 */
const marquee = async (from, to, session) => {
  const pane = await paneRect(session)
  const clamp = (point) => ({
    x: Math.min(pane.right - 4, Math.max(pane.left + 4, point.x)),
    y: Math.min(pane.bottom - 4, Math.max(pane.top + 4, point.y)),
  })
  const start = clamp(from)
  const end = clamp(to)
  await session.drag(start, end, 12)
  return { start, end }
}

const selectedIds = (session) => session.evaluate(`[...document.querySelectorAll('.react-flow__node')].filter((el) => el.querySelector('.studio-node')?.classList.contains('is-selected')).map((el) => el.getAttribute('data-id')).sort()`)

const barText = (session) => session.evaluate(`(document.querySelector('[data-testid="selection-bar"]')?.textContent || '').trim()`)

/** Click a button inside the selection toolbar by label. */
const barAction = (label, session) => session.evaluate(`(() => {
  const bar = document.querySelector('[data-testid="selection-bar"]');
  if (!bar) return false;
  const hit = [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
  if (!hit) return false; hit.click(); return true;
})()`)

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  const project = await api.createProject(`框选验收 ${STAMP}`)
  const projectId = project.project.id
  // 四个节点散开摆：左边两个文本、右边两个图片，方便分别框住。
  // viewport 特意带正偏移：世界坐标 y=0 的节点会紧贴画布上沿，
  // 于是「从节点左上方开始拖」的起点落在节点身上——那会变成拖动节点，而不是框选。
  await api.putCanvas(projectId, {
    nodes: [
      node('text-a', 'text', 0, 0, { text: '第一段' }),
      node('text-b', 'text', 0, 260, { text: '第二段' }),
      node('image-c', 'image', 620, 0, { text: '第一张' }),
      node('image-d', 'image', 620, 500, { text: '第二张' }),
    ],
    edges: [{ id: 'edge-a', source: 'text-a', target: 'image-c', sourceHandle: 'text', targetHandle: 'prompt' }],
    viewport: { x: 120, y: 180, zoom: 0.8 },
  })

  const s = await startSession({ port: 9253, width: 1500, height: 900 })
  await s.login(BASE, PASSWORD)
  await s.goto(`${BASE}/canvas/${projectId}`, 4500)
  check('画布加载', (await s.evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 4)

  log('① 没有选择时，没有工具条')
  check('工具条不存在', (await barText(s)) === '')

  log('② 左键拖出选框：只框住左边的两个文本节点')
  const pane = await paneRect(s)
  const a = await nodeRect('text-a', s)
  const b = await nodeRect('text-b', s)
  check('拿得到节点位置', a !== null && b !== null, JSON.stringify({ a, b }))
  // 从两个文本节点的左上方拖到它们的右下方；端点会被夹进画布区域。
  const marqueePath = await marquee({ x: a.left - 40, y: a.top - 40 }, { x: a.right + 30, y: b.bottom + 30 }, s)
  log(`   拖拽 ${JSON.stringify(marqueePath.start)} → ${JSON.stringify(marqueePath.end)}`)
  check('拖拽端点都在画布区域内',
    marqueePath.start.x > pane.left && marqueePath.start.y > pane.top && marqueePath.end.y < pane.bottom,
    JSON.stringify({ pane, marqueePath }))
  await sleep(900)
  const picked = await until(async () => {
    const ids = await selectedIds(s)
    return ids.length > 0 ? ids : null
  })
  check('框选选中了节点（不是拖动画布）', picked !== null, JSON.stringify(picked))
  check('选中的正是被框住的两个', JSON.stringify(picked) === JSON.stringify(['text-a', 'text-b']), JSON.stringify(picked))

  log('③ 工具条出现并说明选了几个')
  const bar = await barText(s)
  check('工具条出现', bar !== '', bar)
  check('工具条写明已选数量', bar.includes('已选 2 个'), bar)
  const actions = await s.evaluate(`[...document.querySelectorAll('[data-testid="selection-bar"] button')].map((b) => (b.textContent || '').trim())`)
  check('工具条含 整理 / 复制 / 添加到 Agent / 删除',
    ['整理', '复制', '添加到 Agent', '删除'].every((label) => actions.includes(label)), actions.join(' | '))

  log('④ 整理：只动选中的两个，别的节点位置不变')
  const beforeImageC = await nodeRect('image-c', s)
  check('点「整理」', await barAction('整理', s))
  await sleep(900)
  const movedTextB = await nodeRect('text-b', s)
  const afterImageC = await nodeRect('image-c', s)
  // 同一列的节点整理后 x 不变、y 变成固定间距——所以比的是 top，不是 left。
  check('选中的节点被重排了', movedTextB !== null && Math.abs(movedTextB.top - (b?.top ?? 0)) > 4, `top ${String(b?.top)} -> ${String(movedTextB?.top)}`)
  check('重排后不再重叠', movedTextB !== null && movedTextB.top > (a?.bottom ?? 0), `文本节点 b 的 top ${String(movedTextB?.top)} vs a 的 bottom ${String(a?.bottom)}`)
  check('没选中的节点一动不动', afterImageC?.left === beforeImageC?.left && afterImageC?.top === beforeImageC?.top,
    `${JSON.stringify(beforeImageC)} -> ${JSON.stringify(afterImageC)}`)

  log('⑤ 添加到 Agent：两个都进文档，Agent 读得到')
  check('点「添加到 Agent」', await barAction('添加到 Agent', s))
  const context = await until(async () => {
    const doc = (await api.call(`/api/projects/${projectId}/canvas`)).json.doc
    return (doc?.agentContext ?? []).length >= 2 ? doc.agentContext : null
  })
  check('两个节点都进了 Agent 上下文', context !== null && context.includes('text-a') && context.includes('text-b'), JSON.stringify(context ?? []))
  const agentView = await api.agent('canvas_context', { projectId })
  check('Agent 工具读得到这两个', (agentView.result?.nodes ?? []).length === 2, JSON.stringify((agentView.result?.nodes ?? []).map((n) => n.id)))

  log('⑥ 复制：多出两个节点，且不继承生成历史')
  const beforeCopy = (await api.getCanvas(projectId)).doc?.nodes?.length ?? 0
  check('点「复制」', await barAction('复制', s))
  const afterCopy = await until(async () => {
    const count = (await api.getCanvas(projectId)).doc?.nodes?.length ?? 0
    return count > beforeCopy ? count : null
  })
  check('节点数 +2', afterCopy === beforeCopy + 2, `${String(beforeCopy)} -> ${String(afterCopy ?? beforeCopy)}`)

  log('⑦ 取消选择：工具条收起')
  // 复制之后选中的是副本，先重新框住一批节点再取消。
  await marquee({ x: pane.left + 10, y: pane.top + 10 }, { x: pane.left + 520, y: pane.top + 620 }, s)
  await sleep(800)
  const bar2 = await barText(s)
  if (bar2 !== '') {
    check('点「取消选择」', await barAction('取消选择', s))
    await sleep(600)
  }
  check('工具条收起了', (await barText(s)) === '', await barText(s))
  check('节点描边也清掉了', (await selectedIds(s)).length === 0, JSON.stringify(await selectedIds(s)))

  log('⑧ 删除：节点与连线一起走，且不影响没选中的')
  const c = await nodeRect('text-a', s)
  const d = await nodeRect('text-b', s)
  await marquee({ x: c.left - 30, y: c.top - 30 }, { x: Math.max(c.right, d.right) + 30, y: d.bottom + 30 }, s)
  await sleep(800)
  const pickedAgain = await selectedIds(s)
  check('重新框住了两个文本节点', pickedAgain.length >= 2, JSON.stringify(pickedAgain))
  check('点「删除」', await barAction('删除', s))
  const afterDelete = await until(async () => {
    const doc = (await api.getCanvas(projectId)).doc
    return (doc?.nodes ?? []).some((n) => n.id === 'text-a') ? null : doc
  })
  const remaining = (afterDelete?.nodes ?? []).map((n) => n.id)
  check('被选中的节点删掉了', afterDelete !== null && !remaining.includes('text-a') && !remaining.includes('text-b'), remaining.join(' | '))
  check('没选中的图片节点还在', remaining.includes('image-c') && remaining.includes('image-d'), remaining.join(' | '))
  check('连着被删节点的线也没了', (afterDelete?.edges ?? []).every((e) => e.source !== 'text-a' && e.target !== 'text-a'),
    JSON.stringify((afterDelete?.edges ?? []).map((e) => `${e.source}->${e.target}`)))

  log('⑨ 打组：框选两个 → 打组 → 组框带着成员一起走')
  // 前面的步骤已经挪过、复制过节点，所以这里按实际位置框，不用固定坐标——
  // 固定坐标会随画布状态漂移，那种断言迟早会变成假红或假绿。
  const spans = await s.evaluate(`[...document.querySelectorAll('.react-flow__node')].map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })`)
  const box = {
    left: Math.min(...spans.map((r) => r.left)),
    top: Math.min(...spans.map((r) => r.top)),
    right: Math.max(...spans.map((r) => r.right)),
    bottom: Math.max(...spans.map((r) => r.bottom)),
  }
  await marquee({ x: box.left - 24, y: box.top - 24 }, { x: box.right + 24, y: box.bottom + 24 }, s)
  await sleep(900)
  const groupChosen = await selectedIds(s)
  check('框住了至少两个节点', groupChosen.length >= 2, JSON.stringify(groupChosen))
  if (groupChosen.length >= 2) {
    check('点「打组」', await barAction('打组', s))
    const grouped = await until(async () => {
      const doc = (await api.getCanvas(projectId)).doc
      return (doc?.nodes ?? []).some((n) => n.data?.kind === 'group') ? doc : null
    })
    const groupNode = (grouped?.nodes ?? []).find((n) => n.data?.kind === 'group')
    check('文档里出现了组', groupNode !== undefined, JSON.stringify((grouped?.nodes ?? []).map((n) => n.data?.kind)))
    const members = (grouped?.nodes ?? []).filter((n) => n.parentId === groupNode?.id)
    check('被选中的节点成了组员', members.length >= 2, `${String(members.length)} 个成员`)
    check('组框在画布上渲染出来了', (await s.evaluate(`document.querySelectorAll('.studio-group').length`)) === 1)

    // 拖动组框：成员必须跟着走，否则「组」只是个标签。
    const groupId = groupNode?.id ?? ''
    const before = await s.evaluate(`(() => {
      const el = document.querySelector('.react-flow__node[data-id="${groupId}"]');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + 14) };
    })()`)
    const memberBefore = await s.evaluate(`[...document.querySelectorAll('.react-flow__node')].filter((el) => el.getAttribute('data-id') !== '${groupId}').map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-id'), x: Math.round(r.left) }; })`)
    await s.drag(before, { x: before.x + 120, y: before.y + 90 }, 10)
    await sleep(900)
    const memberAfter = await s.evaluate(`[...document.querySelectorAll('.react-flow__node')].filter((el) => el.getAttribute('data-id') !== '${groupId}').map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-id'), x: Math.round(r.left) }; })`)
    const moved = memberBefore.some((m) => (memberAfter.find((n) => n.id === m.id)?.x ?? m.x) !== m.x)
    check('拖动组框时成员跟着动了', moved, `${JSON.stringify(memberBefore.slice(0, 2))} -> ${JSON.stringify(memberAfter.slice(0, 2))}`)

    log('⑨b 取消打组：组框消失，节点留在原处')
    const memberPosBefore = await s.evaluate(`[...document.querySelectorAll('.react-flow__node')].filter((el) => el.getAttribute('data-id') !== '${groupId}').map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-id'), x: Math.round(r.left), y: Math.round(r.top) }; })`)
    await s.evaluate(`document.querySelector('.react-flow__node[data-id="${groupId}"] .studio-group')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await s.evaluate(`(() => { const el = document.querySelector('.react-flow__node[data-id="${groupId}"]'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`)
    await sleep(700)
    const ungrouped = await barAction('取消打组', s)
    check('点「取消打组」', ungrouped)
    const afterUngroup = await until(async () => {
      const doc = (await api.getCanvas(projectId)).doc
      return (doc?.nodes ?? []).some((n) => n.data?.kind === 'group') ? null : doc
    })
    check('文档里没有组框了', afterUngroup !== null, JSON.stringify(afterUngroup) === 'null' ? '还在' : 'ok')
    check('画布上也不再有组框', (await s.evaluate(`document.querySelectorAll('.studio-group').length`)) === 0)
    const memberPosAfter = await s.evaluate(`[...document.querySelectorAll('.react-flow__node')].map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-id'), x: Math.round(r.left), y: Math.round(r.top) }; })`)
    const stayed = memberPosBefore.every((m) => {
      const now = memberPosAfter.find((n) => n.id === m.id)
      return now === undefined || (Math.abs(now.x - m.x) <= 2 && Math.abs(now.y - m.y) <= 2)
    })
    check('取消打组后节点留在原处（不动一下）', stayed, `${JSON.stringify(memberPosBefore.slice(0, 2))} -> ${JSON.stringify(memberPosAfter.slice(0, 2))}`)
  } else {
    check('框选到足够多的节点用于打组', false, `只选到 ${String(groupChosen.length)} 个`)
  }

  log('⑩ 框选没有弄坏另外两个手势')
  // 找一块真的空白：删掉两个节点后，剩下的位置不好猜，所以从画布右下角往回找。
  const empty = await s.evaluate(`(() => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    const candidates = [[-80, -80], [-160, -80], [-80, -160], [-240, -120]];
    for (const [dx, dy] of candidates) {
      const x = Math.round(pane.right + dx), y = Math.round(pane.bottom + dy);
      const hit = document.elementsFromPoint(x, y);
      if (hit.some((n) => n.classList?.contains('react-flow__node'))) continue;
      if (hit.some((n) => n.classList?.contains('react-flow__pane'))) return { x, y };
    }
    return null;
  })()`)
  check('找得到一块空白', empty !== null, JSON.stringify(empty))
  if (empty !== null) {
    await s.doubleClick(empty.x, empty.y)
    await sleep(900)
  }
  check('双击空白仍能打开添加节点面板', (await s.evaluate(`document.querySelectorAll('.studio-menu').length`)) === 1)
  await s.evaluate(`document.querySelector('.studio-menu-scrim')?.click()`)
  await sleep(400)
  const dock = await s.evaluate(`(document.querySelector('.canvas-dock')?.textContent || '').trim()`)
  check('底部浮动条仍在（缩放 / 整理布局）', dock.includes('%') && dock.includes('整理布局'), dock)

  check('全程没有 JS 报错', s.consoleErrors.length === 0, s.consoleErrors.slice(0, 2).join(' | '))
  await s.shot('canvas-selection.png')
  s.kill()
  // purge=1：测试留下的画布要真的清掉；只丢进回收站等于换了地方堆。
  await api.call(`/api/projects/${projectId}?purge=1`, { method: 'DELETE' })

  log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[selection] 失败:', error); process.exit(1) })
