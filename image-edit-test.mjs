/**
 * 图像工具栏、裁剪旋转与对比查看的浏览器验收。
 *
 * 用法: node image-edit-test.mjs <baseUrl> <password>
 *
 * 这里测的是单测覆盖不到的那一半：**指针坐标到图片像素的换算**，
 * 以及工具栏到底长在卡片的哪一侧。
 * crop.ts 的算术是对的，但如果浮层和图片没有严格等大、或者缩放比算错，
 * 用户拖出来的框和鼠标位置就会错开——画面上看得出来，测试里看不出来，
 * 除非像这里一样自己拖一次再量框的位置。
 *
 * 用的是非正方形图（1280×720），因为「宽高要换」这件事只有非正方形能验出来。
 */
import { gradientPng } from './apps/server/src/png.ts'
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const PORT = Number(process.env.CDP_PORT || 9262)
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('edit')

const SOURCE_W = 1280
const SOURCE_H = 720

/**
 * Base color for this run's fixture.
 *
 * Deliberately unique per run. Assets are content-addressed, so an identical
 * fixture in two runs collapses into **one** asset id — and then a canvas left
 * behind by an earlier crashed run keeps that shared asset 「in use」, which makes
 * this run's cleanup fail with a 409 that has nothing to do with this run.
 */
const FIXTURE_COLOR = [40 + (Date.now() % 160), 90, 210]

/** Poll until a probe yields something truthy. */
const until = async (probe, timeoutMs = 15_000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(250)
  }
}

/** Where the toolbar and the card are, and what the toolbar offers. */
const layoutShape = (session) => session.evaluate(`(() => {
  const tools = document.querySelector('[data-testid="node-tools"]');
  const node = document.querySelector('.studio-node[data-kind="image"]');
  const win = document.querySelector('.prompt-window');
  if (!node) return null;
  const nb = node.getBoundingClientRect();
  const tb = tools ? tools.getBoundingClientRect() : null;
  return {
    hasTools: tools !== null,
    // 工具条与卡片之间的净空：负数表示压在卡片上方，正数表示掉到下方。
    gap: tb === null ? null : (tb.bottom <= nb.top ? Math.round(nb.top - tb.bottom) : Math.round(tb.top - nb.bottom)),
    where: tb === null ? null : (tb.bottom <= nb.top ? 'above' : 'below'),
    toolsBox: tb === null ? null : { x: Math.round(tb.x), y: Math.round(tb.y), w: Math.round(tb.width), h: Math.round(tb.height) },
    nodeBox: { x: Math.round(nb.x), y: Math.round(nb.y), w: Math.round(nb.width), h: Math.round(nb.height) },
    // 工具条不能长在提示词窗口里面——它已经搬出去了。
    toolsInsideWindow: win !== null && win.querySelector('[data-testid="node-tools"]') !== null,
    windowHasEditLink: win !== null && [...win.querySelectorAll('button')].some((b) => (b.textContent || '').includes('编辑画面')),
    menuItems: [...document.querySelectorAll('[data-testid="tools-menu"] .tool-btn')].map((b) => (b.textContent || '').replace(/[▾›]/g, '').trim()),
    hasCompare: document.querySelector('[data-testid="compare-open"]') !== null,
  };
})()`)

/** What the editor currently shows. */
const editorShape = (session) => session.evaluate(`(() => {
  const box = document.querySelector('[data-testid="image-editor"]');
  if (!box) return null;
  const sizeText = (document.querySelector('[data-testid="editor-size"]')?.textContent || '').trim();
  const frame = document.querySelector('.editor-frame');
  const img = frame?.querySelector('img');
  const rect = document.querySelector('[data-testid="crop-rect"]');
  const fb = frame?.getBoundingClientRect();
  const ib = img?.getBoundingClientRect();
  const rb = rect?.getBoundingClientRect();
  return {
    size: sizeText,
    cropping: frame?.classList.contains('is-cropping') === true,
    frame: fb ? { x: fb.x, y: fb.y, w: fb.width, h: fb.height } : null,
    img: ib ? { x: ib.x, y: ib.y, w: ib.width, h: ib.height } : null,
    crop: rb ? { x: rb.x - (fb?.x || 0), y: rb.y - (fb?.y || 0), w: rb.width, h: rb.height } : null,
    steps: (document.querySelector('.editor-steps')?.textContent || '').trim(),
    saveEnabled: !(document.querySelector('[data-testid="editor-save"]')?.disabled),
  };
})()`)

/** The card's version strip and the picture it shows. */
const stripShape = (session) => session.evaluate(`(() => {
  const img = document.querySelector('.studio-node[data-kind="image"] img');
  return {
    cells: document.querySelectorAll('.prompt-window .history-cell').length,
    toolLabel: (document.querySelector('[data-testid="compare-open"]')?.textContent || '').trim(),
    cardUrl: img ? img.getAttribute('src') : '',
    cardW: img ? img.naturalWidth : 0,
    cardH: img ? img.naturalHeight : 0,
  };
})()`)

/** Click a button by its visible text, inside an optional scope. */
const clickByText = async (session, scope, text) => session.evaluate(`(() => {
  const hit = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')]
    .find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
  if (!hit) return false;
  hit.click();
  return true;
})()`)

/**
 * What this run created, and how to remove it.
 *
 * Registered as soon as each thing exists and run from a `finally`, because a
 * suite that dies halfway otherwise leaves a canvas behind — and a leftover
 * canvas keeps its pictures 「in use」 for every later run, which turns into a
 * cleanup failure that has nothing to do with the run that reports it.
 */
const cleanupSteps = []
/** The headless browser, once one exists, so cleanup can close it too. */
let browser = null
/**
 * Every picture this run put in the library.
 *
 * Tracked as it appears, not guessed at the end. **编辑出来的版本也是这次跑法造的**：
 * 旋转和裁剪的结果都是新上传的素材，一开始我只删了那张验图，
 * 于是每跑一次就在素材库里留下两张孤儿图——留下的东西越多，越像「垃圾」，
 * 越容易在下一次清理里被误删（这个项目已经因此丢过两次数据）。
 */
const trackedAssets = new Set()
const trackAsset = (id) => {
  if (typeof id !== 'string' || id === '' || trackedAssets.has(id)) return
  trackedAssets.add(id)
  // 先删画布、再删素材：文档还引用着它时服务端会拒绝（409）。
  cleanupSteps.unshift(async () => {
    const result = await api.call(`/api/assets/${id}`, { method: 'DELETE' })
    // 收拾失败必须说出来。上一版把异常吞了，于是三条删除全以 409 失败，
    // 而屏幕上只有「验收用的 3 张图都已清理 ✗」——真因得自己去猜。
    if (!result.ok) console.error(`[edit] 清理素材 ${id.slice(0, 12)} 失败：HTTP ${String(result.status)} ${result.body}`)
  })
}
const cleanup = async () => {
  // **先关浏览器，再收数据。** 顺序反了会有竞态：点一下节点就产生一次
  // 「选中变化」→ 画布变脏 → 900ms 后自动保存。若那一次保存正好落在
  // 「已经删掉画布、还没删素材」之间，服务端就会认为素材还被引用着而拒绝删除
  // （409），而屏幕上只看到一条「图没清掉」。这个失败是间歇性的——
  // 第一版就是这么飘过去一次。
  browser?.kill()
  if (browser !== null) await sleep(300)
  for (const step of cleanupSteps.reverse()) {
    try { await step() } catch (error) { console.error('[edit] 清理步骤抛错：', error) }
  }
}

/** The API session, filled in by {@link run} so cleanup steps can use it. */
let api = null

const run = async () => {
  api = await apiSession(BASE, PASSWORD)
  check('API 已登录', api.cookie !== '')

  log('① 造一张真实画面：上传 1280×720 的图，挂到一个镜头的第一个版本上')
  const project = (await api.createProject(`编辑验收 ${STAMP}`)).project
  cleanupSteps.push(() => api.call(`/api/projects/${project.id}?purge=1`, { method: 'DELETE' }))
  const shot = (await api.call(`/api/projects/${project.id}/shots`, {
    method: 'POST',
    body: JSON.stringify({ title: `编辑镜头 ${STAMP}`, prompt: '验收' }),
  })).json.shot
  const png = gradientPng(SOURCE_W, SOURCE_H, FIXTURE_COLOR)
  const upload = await fetch(`${BASE}/api/assets`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', cookie: api.cookie },
    body: png,
  })
  check('上传按预期返回', upload.status === 200, String(upload.status))
  const asset = (await upload.json()).asset
  trackAsset(asset.id)
  const take = (await api.call(`/api/shots/${shot.id}/takes`, {
    method: 'POST',
    body: JSON.stringify({ assetId: asset.id, status: 'succeeded', providerId: 'fixture', model: '验收图' }),
  })).json.take
  check('版本已记录', typeof take?.id === 'string' && take.id !== '')

  // 镜头记下来了还不够：画布上得有节点才点得到。节点是**文档**里的东西，
  // 所以直接把文档写进去，而不是靠生成一次图（那要等 ComfyUI，几十秒）。
  await api.call(`/api/projects/${project.id}/canvas`, {
    method: 'PUT',
    body: JSON.stringify({
      doc: {
        nodes: [{
          id: 'image-verify',
          type: 'studio',
          position: { x: 0, y: 0 },
          data: {
            kind: 'image',
            text: '验收图',
            url: `/api/assets/${asset.id}`,
            shotId: shot.id,
            takeId: take.id,
            takeNumber: 1,
            size: '1280x720',
            count: 1,
          },
        }],
        edges: [],
        viewport: { x: 420, y: 260, zoom: 1 },
      },
    }),
  })

  const s = await startSession({ port: PORT, width: 1500, height: 950 })
  browser = s
  await s.login(BASE, PASSWORD)
  /**
   * Register every picture this shot now refers to.
   *
   * Called after each edit: the edit's result is a brand-new uploaded asset, and
   * 「编辑出来的那张」 is exactly as much this run's to clean up as the fixture was.
   */
  const trackShotAssets = async () => {
    const list = (await api.call(`/api/shots/${shot.id}/takes`)).json.takes
    for (const item of list) trackAsset(item.assetId)
  }
  await s.goto(`${BASE}/canvas/${project.id}`, 4500)

  log('② 没选中时没有工具栏；点中卡片之后才出现，而且长在卡片上方')
  const beforeSelect = await layoutShape(s)
  check('卡片出现在画布上', beforeSelect !== null)
  check('未选中时没有工具栏', beforeSelect?.hasTools === false)

  const nodeBox = await until(() => s.evaluate(`(() => {
    const el = document.querySelector('.studio-node[data-kind="image"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 10) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 20) };
  })()`))
  check('卡片可见', nodeBox !== null, JSON.stringify(nodeBox))
  if (nodeBox !== null) await s.click(nodeBox.x, nodeBox.y)
  await sleep(700)
  check('选中后出现提示词窗口', (await s.evaluate(`document.querySelectorAll('.prompt-window').length`)) === 1)

  const afterSelect = await until(async () => {
    const shape = await layoutShape(s)
    return shape?.hasTools === true ? shape : null
  })
  check('选中后出现工具栏', afterSelect !== null)
  log(`   工具条 ${JSON.stringify(afterSelect?.toolsBox)} 卡片 ${JSON.stringify(afterSelect?.nodeBox)}`)
  // 用户要的就是「节点上方」：整条工具条必须落在卡片上边界之上，且紧贴（留白很小）。
  check('工具栏贴在卡片上方', afterSelect?.where === 'above', String(afterSelect?.where))
  check('工具栏没有飘远（贴着的）', (afterSelect?.gap ?? 999) <= 16, `净空 ${String(afterSelect?.gap)}px`)
  check('工具栏不宽于卡片太多', (afterSelect?.toolsBox?.w ?? 999) <= (afterSelect?.nodeBox?.w ?? 0) + 40,
    `${String(afterSelect?.toolsBox?.w)} vs ${String(afterSelect?.nodeBox?.w)}`)
  check('工具栏不在提示词窗口里', afterSelect?.toolsInsideWindow === false)
  check('提示词窗口里不再有「编辑画面」', afterSelect?.windowHasEditLink === false)

  log('③ 鼠标放在「图像编辑」上：菜单里是旋转 / 镜像 / 裁剪')
  await s.evaluate(`document.querySelector('[data-testid="tools-image-edit"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`)
  const hovered = await until(() => s.evaluate(`!!document.querySelector('[data-testid="tools-menu"]')`))
  check('悬停即展开菜单', hovered === true)
  const menu = await layoutShape(s)
  log(`   菜单项：${JSON.stringify(menu?.menuItems)}`)
  check('菜单里有旋转', (menu?.menuItems ?? []).some((t) => t.includes('旋转')), JSON.stringify(menu?.menuItems))
  check('菜单里有镜像', (menu?.menuItems ?? []).some((t) => t.includes('镜像')))
  check('菜单里有裁剪', (menu?.menuItems ?? []).some((t) => t.includes('裁剪')))

  log('④ 一级子菜单：旋转里有左转/右转/180')
  await clickByText(s, '[data-testid="tools-menu"]', '旋转')
  const rotateSub = await until(() => s.evaluate(`(() => {
    const sub = document.querySelector('[data-testid="tools-rotate-sub"]');
    return sub ? [...sub.querySelectorAll('.tool-btn')].map((b) => (b.textContent || '').trim()) : null;
  })()`))
  check('旋转子菜单出现', Array.isArray(rotateSub), JSON.stringify(rotateSub))
  check('左转 90° 在旋转里', (rotateSub ?? []).some((t) => t.includes('左转')))
  check('右转 90° 在旋转里', (rotateSub ?? []).some((t) => t.includes('右转')))
  check('旋转 180° 在旋转里', (rotateSub ?? []).some((t) => t.includes('180')))

  log('⑤ 点「右转 90°」直接生效：多一个版本，宽高互换')
  const beforeRotate = (await api.call(`/api/shots/${shot.id}/takes`)).json.takes.length
  await clickByText(s, '[data-testid="tools-rotate-sub"]', '右转')
  const rotatedTake = await until(async () => {
    const takes = (await api.call(`/api/shots/${shot.id}/takes`)).json.takes
    return takes.length === beforeRotate + 1 ? takes[0] : null
  }, 25_000)
  check('多了一个版本', rotatedTake !== null, `${beforeRotate} → ${String((await api.call(`/api/shots/${shot.id}/takes`)).json.takes.length)}`)
  check('记的是编辑而不是模型', rotatedTake?.providerId === 'studio-edit', rotatedTake?.providerId)
  check('记下了「右转 90°」', (rotatedTake?.model ?? '').includes('右转'), rotatedTake?.model)
  await trackShotAssets()
  const rotated = await until(async () => {
    const shape = await stripShape(s)
    return shape.cardW > 0 && shape.cardH > shape.cardW ? shape : null
  }, 15_000)
  // 1280×720 右转后应当变成 720×1280（竖的）——这一条只能靠 naturalWidth 验。
  check('卡片上的图变成竖的', rotated !== null, `${String(rotated?.cardW)}×${String(rotated?.cardH)}`)
  check('宽度正好是原来的高', rotated?.cardW === SOURCE_H, String(rotated?.cardW))
  check('高度正好是原来的宽', rotated?.cardH === SOURCE_W, String(rotated?.cardH))

  log('⑥ 裁剪：从菜单进去，编辑器直接就是裁剪模式')
  await s.evaluate(`document.querySelector('[data-testid="tools-image-edit"]').click()`)
  await until(() => s.evaluate(`!!document.querySelector('[data-testid="tools-crop"]')`))
  await s.evaluate(`document.querySelector('[data-testid="tools-crop"]').click()`)
  const opened = await until(async () => {
    const shape = await editorShape(s)
    return shape?.frame !== null && shape?.size !== '' ? shape : null
  })
  check('编辑器打开', opened !== null)
  log(`   ${JSON.stringify(opened)}`)
  check('编辑器报出当前尺寸 720 × 1280', opened?.size === `${SOURCE_H} × ${SOURCE_W}`, opened?.size)
  check('一进来就是裁剪模式', opened?.cropping === true)
  check('默认框就是整张图', (opened?.crop?.w ?? 0) > 100, JSON.stringify(opened?.crop))
  // 浮层必须和图片严格重合，否则坐标换算里就少了一个偏移量。
  const aligned = opened !== null && Math.abs(opened.frame.w - opened.img.w) < 1.5
    && Math.abs(opened.frame.h - opened.img.h) < 1.5
    && Math.abs(opened.frame.x - opened.img.x) < 1.5
    && Math.abs(opened.frame.y - opened.img.y) < 1.5
  check('裁剪浮层与图片完全重合', aligned, opened === null ? '' : JSON.stringify({ frame: opened.frame, img: opened.img }))
  check('没改动时不能存', opened?.saveEnabled === false)

  log('⑦ 拖一个框，量它到底落在哪')
  // 用真实鼠标事件而不是自己派发 PointerEvent：合成事件的 pointerId 不是
  // 「活动指针」，组件里的 setPointerCapture 会直接抛错——那是测试的假象，
  // 真用户拖的时候一切正常。
  const frameBox = await s.evaluate(`(() => {
    const b = document.querySelector('.editor-frame').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  })()`)
  await s.drag(
    { x: frameBox.x + frameBox.w * 0.25, y: frameBox.y + frameBox.h * 0.25 },
    { x: frameBox.x + frameBox.w * 0.75, y: frameBox.y + frameBox.h * 0.75 },
    10,
  )
  await sleep(400)
  const afterDrag = await editorShape(s)
  log(`   拖动后 ${JSON.stringify(afterDrag?.crop)}（浮层 ${frameBox.w.toFixed(1)}×${frameBox.h.toFixed(1)}）`)
  const halfW = frameBox.w * 0.5
  const halfH = frameBox.h * 0.5
  check('框的宽度等于拖动距离', afterDrag !== null && Math.abs(afterDrag.crop.w - halfW) < 3,
    `框 ${afterDrag?.crop.w.toFixed(1)} vs 拖动 ${halfW.toFixed(1)}`)
  check('框的高度等于拖动距离', afterDrag !== null && Math.abs(afterDrag.crop.h - halfH) < 3,
    `框 ${afterDrag?.crop.h.toFixed(1)} vs 拖动 ${halfH.toFixed(1)}`)
  check('框的左上角就在起点', afterDrag !== null && Math.abs(afterDrag.crop.x - halfW / 2) < 3,
    `框 x=${afterDrag?.crop.x.toFixed(1)} 期望 ${(halfW / 2).toFixed(1)}`)

  log('⑧ 比例预设 1:1，应用并存成新版本')
  await clickByText(s, '.crop-bar', '1:1')
  await sleep(250)
  const squared = await editorShape(s)
  check('切成正方形', squared !== null && Math.abs(squared.crop.w - squared.crop.h) < 3, JSON.stringify(squared?.crop))

  await clickByText(s, '.crop-bar', '应用裁剪')
  const cropped = await until(async () => {
    const shape = await editorShape(s)
    return shape?.steps.includes('裁剪') ? shape : null
  }, 20_000)
  check('裁剪已应用', cropped !== null, cropped?.steps)

  const beforeSave = (await api.call(`/api/shots/${shot.id}/takes`)).json.takes.length
  await s.evaluate(`document.querySelector('[data-testid="editor-save"]').click()`)
  const saved = await until(async () => {
    const open = await s.evaluate(`!!document.querySelector('[data-testid="image-editor"]')`)
    return open ? null : true
  }, 25_000)
  check('保存后编辑器关闭', saved === true)

  const takes = (await api.call(`/api/shots/${shot.id}/takes`)).json.takes
  check('镜头又多了一个版本', takes.length === beforeSave + 1, `${beforeSave} → ${takes.length}`)
  check('新版本说明了改了什么', typeof takes[0]?.model === 'string' && takes[0].model.includes('裁剪'), takes[0]?.model)
  check('两次编辑是两张不同的图', takes[0]?.assetId !== takes[1]?.assetId)
  await trackShotAssets()

  const strip = await until(async () => {
    const shape = await stripShape(s)
    return shape.cells >= 3 ? shape : null
  })
  check('卡片上有三个版本', strip !== null, JSON.stringify(strip))
  check('卡片显示的是最新版本', strip?.cardUrl.includes(takes[0]?.assetId ?? 'x'), strip?.cardUrl)
  check('对比入口报的是三个版本', (strip?.toolLabel ?? '').includes('3'), strip?.toolLabel)

  log('⑨ 对比查看：三个并排，能切回最早的版本')
  await s.evaluate(`document.querySelector('[data-testid="compare-open"]').click()`)
  const compare = await until(() => s.evaluate(`(() => {
    const box = document.querySelector('[data-testid="compare-view"]');
    if (!box) return null;
    const cells = [...document.querySelectorAll('[data-testid="compare-strip"] .compare-cell')];
    return {
      cells: cells.length,
      shown: document.querySelectorAll('[data-testid="compare-strip"] .compare-cell.is-shown').length,
      useButtons: [...document.querySelectorAll('[data-testid="compare-strip"] .compare-cell .link')].filter((b) => b.textContent.includes('用这张')).length,
      nums: [...document.querySelectorAll('[data-testid="compare-strip"] .compare-no')].map((n) => n.textContent.trim()),
      // 并排：横向不重叠，而且都在可视区域内。
      boxes: cells.map((c) => { const b = c.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) } }),
    };
  })()`))
  check('对比视图打开了', compare !== null)
  log(`   ${JSON.stringify(compare)}`)
  check('三个都在', compare?.cells === 3, String(compare?.cells))
  check('编号按时间顺序（旧的是第 1 版）', compare?.nums[0] === '第 1 版', (compare?.nums ?? []).join(' '))
  check('并排而不是叠在一起', compare !== null && compare.boxes.every((box, index) => index === 0 || box.x >= compare.boxes[index - 1].x + compare.boxes[index - 1].w - 2),
    JSON.stringify(compare?.boxes))
  check('当前显示的那张被标出', compare?.shown === 1, String(compare?.shown))
  check('另外两张可以「用这张」', compare?.useButtons === 2, String(compare?.useButtons))

  await s.evaluate(`(() => { [...document.querySelectorAll('[data-testid="compare-strip"] .compare-cell')]
    .find((c) => (c.textContent || '').includes('第 1 版'))
    .querySelector('.link').click() })()`)
  const switched = await until(async () => {
    const shape = await stripShape(s)
    return shape.cardUrl.includes(asset.id) ? shape : null
  }, 15_000)
  check('切回第 1 版后卡片显示原图', switched !== null, switched?.cardUrl)
  check('原图尺寸又回来说明切的是原图', switched?.cardW === SOURCE_W && switched?.cardH === SOURCE_H,
    `${String(switched?.cardW)}×${String(switched?.cardH)}`)
  const chosen = (await api.call(`/api/shots/${shot.id}/takes`)).json.takes
  check('选用状态写回服务端', chosen.some((t) => t.mark === 'selected'), JSON.stringify(chosen.map((t) => t.mark)))

  log('⑩ 卡片贴到视口顶部时，工具栏翻到卡片下方（否则整条被裁掉）')
  // 先离开画布页再改文档：页面上的自动保存是防抖的，改完文档后它可能又把手里的
  // 旧 viewport 写回去——那样这一步测的就是竞态，而不是翻不翻。
  await s.goto('about:blank', 500)
  const doc = (await api.getCanvas(project.id)).doc
  doc.viewport = { x: 420, y: 12, zoom: 1 }
  await api.putCanvas(project.id, doc)
  await s.goto(`${BASE}/canvas/${project.id}`, 4500)

  const topNode = await until(() => s.evaluate(`(() => {
    const el = document.querySelector('.studio-node[data-kind="image"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 10) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 20), top: Math.round(r.top) };
  })()`))
  check('卡片被放到贴近顶部', (topNode?.top ?? 999) < 52, `top=${String(topNode?.top)}`)
  if (topNode !== null) await s.click(topNode.x, topNode.y)
  const flipped = await until(async () => {
    const shape = await layoutShape(s)
    return shape?.hasTools === true ? shape : null
  })
  check('工具栏仍然出现（没有因为没地方放而消失）', flipped !== null)
  log(`   工具条 ${JSON.stringify(flipped?.toolsBox)} 卡片 ${JSON.stringify(flipped?.nodeBox)}`)
  check('翻到了卡片下方', flipped?.where === 'below', String(flipped?.where))
  check('翻转后也是贴着的', (flipped?.gap ?? 999) <= 16, `净空 ${String(flipped?.gap)}px`)

  // 清理：先删自己建的那张画布，再删自己上传的那张图。
  await cleanup()
  check('验收画布已清理', (await api.call('/api/projects')).json.projects.every((p) => p.id !== project.id))
  const left = (await api.call('/api/assets')).json.assets.filter((item) => trackedAssets.has(item.id))
  check(`验收用的 ${String(trackedAssets.size)} 张图都已清理`, left.length === 0, left.map((i) => i.id).join(' '))

  const failed = failures()
  console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项未通过`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch(async (error) => {
  console.error('[edit] 崩了：', error)
  // 崩了也要收拾：否则这次留下的画布会一直引用着图片，让**下一次**清理失败。
  await cleanup()
  process.exit(1)
})
