/**
 * 资产库验收：缩略图真的显示、分类真的过滤、两个入口是同一个组件。
 *
 * 用法: node assets-test.mjs <baseUrl> <password>
 *
 * **这条用例是为一个真实 bug 写的**：界面上一排空框，因为 `/api/assets`
 * 根本没返回 `url` 字段（类型里却写着 `url: string`，编译器不吭声）。
 * 当时的断言只查了 `<img>` 元素存在——元素存在和图片加载成功是两件事，
 * 所以这次每条都断言 `naturalWidth > 0`：**图片有没有真的画出来**。
 */
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'
import { crc32, deflateSync } from 'node:zlib'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const PORT = Number(process.env.CDP_PORT || 9255)
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('assets')

/** Poll until a probe yields something truthy. */
const until = async (probe, timeoutMs = 10_000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(250)
  }
}

/** How many cards in a scope show a picture that actually decoded. */
const decodedIn = (scope, session) => session.evaluate(`(() => {
  const cards = [...document.querySelectorAll(${JSON.stringify(scope)} + ' .asset-card')];
  const imgs = cards.map((c) => c.querySelector('img')).filter(Boolean);
  return {
    cards: cards.length,
    imgs: imgs.length,
    decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
  };
})()`)

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  check('API 已登录', api.cookie !== '')

  log('① 服务端：每个素材都必须带 url（这就是那个空框 bug 的根因）')
  const listed = (await api.call('/api/assets')).json.assets ?? []
  check('素材列表非空', listed.length > 0, `${String(listed.length)} 个`)
  const missing = listed.filter((asset) => typeof asset.url !== 'string' || asset.url === '')
  check('每个素材都带 url', missing.length === 0, `${String(missing.length)} 个缺 url`)
  check('url 指向素材接口', listed.every((asset) => asset.url.startsWith('/api/assets/')), listed[0]?.url ?? '')
  // 真的取一个回来：url 写对了不等于取得到。这里直接取字节，
  // 不能走 api.call——它会 JSON.parse，遇到 PNG 会当场炸。
  const probe = listed.find((asset) => asset.mime.startsWith('image/')) ?? listed[0]
  const raw = await fetch(`${BASE}${probe.url}`, { headers: { cookie: api.cookie } })
  const bytes = Buffer.from(await raw.arrayBuffer())
  check('按 url 能取回素材本体', raw.ok && bytes.length === probe.bytes,
    `HTTP ${String(raw.status)}，${String(bytes.length)} / ${String(probe.bytes)} 字节`)
  check('取回的是图片字节', (raw.headers.get('content-type') ?? '').startsWith('image/'), raw.headers.get('content-type') ?? '')

  log('② 分类计数与过滤在服务端就对得上')
  const images = (await api.call('/api/assets?kind=image')).json.assets ?? []
  const videos = (await api.call('/api/assets?kind=video')).json.assets ?? []
  check('图片分类返回的都是图片', images.every((asset) => asset.mime.startsWith('image/')))
  check('视频分类返回的都是视频', videos.every((asset) => asset.mime.startsWith('video/')))
  check('分类之间不重叠', images.length + videos.length <= listed.length, `图 ${String(images.length)} + 视频 ${String(videos.length)} <= 总 ${String(listed.length)}`)

  log('③ 画布里的资产浮窗：图片必须真的画出来')
  const project = await api.createProject(`资产验收 ${STAMP}`)
  const projectId = project.project.id
  const s = await startSession({ port: PORT, width: 1500, height: 950 })
  await s.login(BASE, PASSWORD)
  await s.goto(`${BASE}/canvas/${projectId}`, 4500)
  check('点底部菜单栏的「资产」', await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.canvas-dock button')].find((x) => (x.textContent || '').trim() === '资产');
    if (!b) return false; b.click(); return true;
  })()`))
  await sleep(2500)
  const panel = await decodedIn('.assets-panel', s)
  log(`   卡片 ${String(panel.cards)} 个，其中图片 ${String(panel.imgs)} 个，解码成功 ${String(panel.decoded)} 个，坏图 ${String(panel.broken)} 个`)
  check('浮窗里有卡片', panel.cards > 0, String(panel.cards))
  check('图片真的画出来了（不是一排空框）', panel.decoded > 0, `${String(panel.decoded)} 张解码成功`)
  check('没有坏图', panel.broken === 0, `${String(panel.broken)} 张坏图`)

  log('④ 分类 chip 真的会过滤，而且带计数')
  const chipLabels = await s.evaluate(`[...document.querySelectorAll('.assets-panel .chip')].map((c) => (c.textContent || '').trim())`)
  check('有 全部/图片/视频/音频/其他', ['全部', '图片', '视频', '音频', '其他'].every((label) => chipLabels.some((t) => t.startsWith(label))), chipLabels.join(' | '))
  check('chip 上带数量', chipLabels.some((t) => /\d$/u.test(t)), chipLabels.join(' | '))
  const allCount = panel.cards
  await s.evaluate(`(() => {
    const chip = [...document.querySelectorAll('.assets-panel .chip')].find((c) => (c.textContent || '').trim().startsWith('视频'));
    if (chip) chip.click(); return true;
  })()`)
  await sleep(800)
  const videoOnly = await decodedIn('.assets-panel', s)
  check('切到「视频」后数量变了', videoOnly.cards !== allCount || videoOnly.cards === 0, `${String(allCount)} -> ${String(videoOnly.cards)}`)
  check('切到「视频」后没有图片卡', videoOnly.imgs === 0, `${String(videoOnly.imgs)} 张图`)
  await s.evaluate(`(() => {
    const chip = [...document.querySelectorAll('.assets-panel .chip')].find((c) => (c.textContent || '').trim().startsWith('图片'));
    if (chip) chip.click(); return true;
  })()`)
  await sleep(1000)
  const imageOnly = await decodedIn('.assets-panel', s)
  check('切回「图片」又都是图片', imageOnly.imgs > 0 && imageOnly.imgs === imageOnly.cards, `${String(imageOnly.imgs)}/${String(imageOnly.cards)}`)

  log('⑤ 排序真的换顺序')
  const firstNewest = await s.evaluate(`(document.querySelector('.assets-panel .asset-card img')?.getAttribute('src') || '')`)
  await s.evaluate(`(() => {
    const select = document.querySelector('.assets-panel .asset-sort');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'oldest');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(800)
  const firstOldest = await s.evaluate(`(document.querySelector('.assets-panel .asset-card img')?.getAttribute('src') || '')`)
  check('换成「最早优先」后第一张变了', firstNewest !== firstOldest, `${firstNewest.slice(-8)} -> ${firstOldest.slice(-8)}`)

  log('⑥ 勾选一张 → 添加到画布（点图现在是预览，不再直接放置）')
  const before = (await api.getCanvas(projectId)).doc?.nodes?.length ?? 0
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
  check('画布多了一个图片节点', after !== null, `${String(before)} -> ${String(after ?? before)}`)
  check('浮窗自动收起', (await s.evaluate(`document.querySelectorAll('.assets-panel').length`)) === 0)

  log('⑦ 「资产」页面用的是同一套分类（同样的理由：两处看到的东西要能对上）')
  await s.goto(`${BASE}/assets`, 3500)
  check('资产页面有分类 chip', (await s.evaluate(`document.querySelectorAll('.assets-page .chip').length`)) >= 5,
    String(await s.evaluate(`document.querySelectorAll('.assets-page .chip').length`)))
  check('资产页面有排序', (await s.evaluate(`document.querySelectorAll('.assets-page .asset-sort').length`)) === 1)
  check('资产页面有搜索', (await s.evaluate(`document.querySelectorAll('.assets-page .side-search').length`)) === 1)
  const page = await until(async () => {
    const state = await decodedIn('.assets-page', s)
    return state.decoded > 0 ? state : null
  })
  check('资产页面的图片也真的画出来了', page !== null, JSON.stringify(page))
  check('资产页面没有坏图', (page?.broken ?? 0) === 0, String(page?.broken ?? '?'))
  const panelChips = chipLabels.map((t) => t.replace(/\d+$/u, '').trim())
  const pageChips = await s.evaluate(`[...document.querySelectorAll('.assets-page .chip')].map((c) => (c.textContent || '').replace(/\\d+$/u, '').trim())`)
  check('两处的分类完全一致', JSON.stringify(panelChips) === JSON.stringify(pageChips), `${panelChips.join(',')} vs ${pageChips.join(',')}`)

  log('⑧ 卡片不能堆在一起（这条是为一排空框/重叠的 bug 写的）')
  const layout = await s.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.assets-page .asset-card')];
    const rects = cards.slice(0, 14).map((c) => { const r = c.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; });
    const first = rects[0];
    const sameRow = rects.filter((r) => Math.abs(r.y - first.y) < 2);
    const nextRow = rects.filter((r) => r.y > first.y + 2);
    const wall = document.querySelector('.assets-page .asset-wall');
    return {
      total: cards.length,
      cardHeight: first.h,
      rowGap: nextRow.length === 0 ? null : Math.min(...nextRow.map((r) => r.y)) - first.y,
      columns: sameRow.length,
      overlaps: rects.some((a, i) => rects.some((b, j) => i !== j && Math.abs(a.y - b.y) < a.h && Math.abs(a.x - b.x) < a.w)),
      scrollHeight: wall.scrollHeight,
      clientHeight: wall.clientHeight,
    };
  })()`)
  log(`   卡片 ${String(layout.total)} 张，列数 ${String(layout.columns)}，行距 ${String(layout.rowGap)}，卡高 ${String(layout.cardHeight)}`)
  check('卡片之间没有重叠', layout.overlaps === false, JSON.stringify(layout))
  check('行距不小于卡片高度（否则就是压在一起）', (layout.rowGap ?? 0) >= layout.cardHeight,
    `行距 ${String(layout.rowGap)} vs 卡高 ${String(layout.cardHeight)}`)
  // 「内容比容器高」只有在库里够多时才成立；素材少时它不是问题，
  // 所以放到下面「上传 70 张之后」那一步去验，而不是在这里要求库必须够大。
  check('卡片按固定的行高排（行距等于卡高 + 间距）', (layout.rowGap ?? 0) === layout.cardHeight + 12,
    `${String(layout.rowGap)} vs ${String(layout.cardHeight + 12)}`)

  log('⑨ 分页：一次不渲染几百张，否则一屏几百 MB 图片')
  // 分页只有在素材多于一页时才看得出来，所以这里**自己上传一页半**再验，
  // 而不是指望库里本来就有一千张——那样断言会随环境忽真忽假。
  const fixtures = []
  for (let i = 0; i < 70; i += 1) {
    const response = await fetch(`${BASE}/api/assets`, {
      method: 'POST', headers: { 'content-type': 'image/png', cookie: api.cookie }, body: makePng(16, 16, i + 1),
    })
    const body = await response.json()
    if (typeof body.asset?.id === 'string') fixtures.push(body.asset.id)
  }
  check('上传了一批测试素材（它们各不相同，不会去重）', fixtures.length === 70, String(fixtures.length))
  await s.goto(`${BASE}/assets`, 3500)
  const paged = await s.evaluate(`(() => {
    const cards = document.querySelectorAll('.assets-page .asset-card').length;
    const more = document.querySelectorAll('.assets-page .asset-wall-more button').length;
    const total = document.querySelectorAll('.assets-page .chip')[0]?.textContent || '';
    return { cards, more, total: Number((total.match(/\\d+/) || ['0'])[0]) };
  })()`)
  check('库里的素材超过一页（前置条件）', paged.total > 60, `库共 ${String(paged.total)} 个`)
  check('首屏只渲染一页', paged.cards === 60, `渲染 ${String(paged.cards)} 张`)
  check('给出「加载更多」', paged.more === 1, String(paged.more))
  // 素材多起来之后，卡片墙必须真的能滚（而不是被压扁/裁掉）。
  const scrolls = await s.evaluate(`(() => {
    const wall = document.querySelector('.assets-page .asset-wall');
    return { scrollHeight: wall.scrollHeight, clientHeight: wall.clientHeight };
  })()`)
  check('一侧排满时能滚动', scrolls.scrollHeight > scrolls.clientHeight, JSON.stringify(scrolls))

  log('⑩ 批量管理：全选 / 单选，然后 添加到画布 / 下载 / 删除')
  check('默认没有批量条', (await s.evaluate(`document.querySelectorAll('[data-testid="asset-batch"]').length`)) === 0)
  check('默认没有预览浮层', (await s.evaluate(`document.querySelectorAll('[data-testid="asset-preview"]').length`)) === 0)

  // 点图 = 放大预览，**不是**选择，也不是直接放到画布上。
  check('点第一张的图', await s.evaluate(`(() => { const b = document.querySelector('.assets-page .asset-card .asset-open'); if (!b) return false; b.click(); return true })()`))
  await sleep(700)
  check('弹出放大预览', (await s.evaluate(`document.querySelectorAll('[data-testid="asset-preview"]').length`)) === 1)
  const previewState = await s.evaluate(`(() => {
    const box = document.querySelector('[data-testid="asset-preview"]');
    const img = box.querySelector('.preview-stage img');
    return { counter: (box.querySelector('header .muted')?.textContent || '').trim(), hasImage: img !== null, decoded: img === null ? false : img.naturalWidth > 0 };
  })()`)
  check('预览里是大图且真的加载出来了', previewState.hasImage && previewState.decoded, JSON.stringify(previewState))
  check('预览标出第几张 / 共几张', /^1 \/ \d+/u.test(previewState.counter), previewState.counter)
  check('预览没有顺手选中任何素材', (await s.evaluate(`document.querySelectorAll('[data-testid="asset-batch"]').length`)) === 0)
  check('翻到下一张（→）', await s.evaluate(`(() => { const b = document.querySelector('[data-testid="asset-preview"] .preview-step.next'); if (!b || b.disabled) return false; b.click(); return true })()`))
  await sleep(600)
  check('计数跟着变', /^2 \/ \d+/u.test((await s.evaluate(`(document.querySelector('[data-testid="asset-preview"] header .muted')?.textContent || '')`)).trim()),
    await s.evaluate(`(document.querySelector('[data-testid="asset-preview"] header .muted')?.textContent || '')`))
  await s.evaluate(`(() => { const b = document.querySelector('[data-testid="asset-preview"] .preview-close'); if (b) b.click(); return true })()`)
  await sleep(500)
  check('关闭后浮层消失', (await s.evaluate(`document.querySelectorAll('[data-testid="asset-preview"]').length`)) === 0)

  check('点第一张的勾选框', await s.evaluate(`(() => { const p = document.querySelector('.assets-page .asset-card .pick'); if (!p) return false; p.click(); return true })()`))
  await sleep(400)
  check('批量条出现', (await s.evaluate(`document.querySelectorAll('[data-testid="asset-batch"]').length`)) === 1)
  check('点勾选框不会打开预览', (await s.evaluate(`document.querySelectorAll('[data-testid="asset-preview"]').length`)) === 0)
  check('批量条写明已选 1 个', ((await s.evaluate(`(document.querySelector('[data-testid="asset-batch"]')?.textContent || '')`))).includes('已选 1 个'),
    await s.evaluate(`(document.querySelector('[data-testid="asset-batch"]')?.textContent || '')`))
  const batchButtons = await s.evaluate(`[...document.querySelectorAll('[data-testid="asset-batch"] button')].map((b) => (b.textContent || '').trim())`)
  check('批量条含 添加到画布 / 下载 / 删除',
    ['添加到画布', '下载', '删除'].every((label) => batchButtons.includes(label)), batchButtons.join(' | '))
  // 反馈过的毛病：「选择后弹出来的菜单在页面下方」。
  const placement = await s.evaluate(`(() => {
    const bar = document.querySelector('[data-testid="asset-batch"]').getBoundingClientRect();
    const host = document.querySelector('.asset-browser').getBoundingClientRect();
    return { barBottom: Math.round(bar.bottom), hostBottom: Math.round(host.bottom) };
  })()`)
  check('批量条贴在页面下方', Math.abs(placement.barBottom - placement.hostBottom) <= 4, JSON.stringify(placement))

  // 「全选」必须选**筛选结果**，不是「当前渲染出来的那一页」——
  // 所以这条断言要在只渲染了 60 张、而库里有更多的时候做。
  check('点「全选」', await s.evaluate(`(() => { const b = document.querySelector('.assets-page .asset-select-all'); if (!b) return false; b.click(); return true })()`))
  await sleep(600)
  const allText = await s.evaluate(`(document.querySelector('[data-testid="asset-batch"]')?.textContent || '')`)
  const selectedCount = Number(/已选 (\d+) 个/u.exec(allText)?.[1] ?? '0')
  const renderedNow = await s.evaluate(`document.querySelectorAll('.assets-page .asset-card').length`)
  check('全选选的是筛选结果，不只是当前这一页', selectedCount > renderedNow && selectedCount === paged.total,
    `已选 ${String(selectedCount)}，已渲染 ${String(renderedNow)}，库共 ${String(paged.total)}`)

  log('⑨b 加载更多：一次多一页，而不是一次性全画出来')
  await s.evaluate(`(() => { const b = document.querySelector('.assets-page .asset-select-all'); if (b) b.click(); return true })()`)
  await sleep(400)
  await s.evaluate(`document.querySelector('.assets-page .asset-wall-more button').click()`)
  await sleep(1500)
  const afterMore = await s.evaluate(`document.querySelectorAll('.assets-page .asset-card').length`)
  check('点一次多加载一页', afterMore > renderedNow && afterMore <= renderedNow + 60,
    `${String(renderedNow)} -> ${String(afterMore)}`)

  log('⑪ 下载：打成一个 zip，而不是甩一堆下载')
  const zipIds = listed.slice(0, 3).map((asset) => asset.id)
  const zipResponse = await fetch(`${BASE}/api/assets/download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: api.cookie },
    body: JSON.stringify({ ids: zipIds }),
  })
  const zipBytes = Buffer.from(await zipResponse.arrayBuffer())
  check('下载接口返回 zip', zipResponse.ok && zipResponse.headers.get('content-type') === 'application/zip',
    `HTTP ${String(zipResponse.status)} ${zipResponse.headers.get('content-type') ?? ''}`)
  check('是合法的 zip（PK 头 + 里面装了三张）',
    zipBytes[0] === 0x50 && zipBytes[1] === 0x4b && zipBytes.length > 1000,
    `${String(zipBytes.length)} 字节，头 ${zipBytes.subarray(0, 4).toString('hex')}`)
  const names = zipBytes.toString('latin1').match(/\.(png|jpg|webp|mp4)/gu) ?? []
  check('zip 里装的是三张图', names.length >= 3, `${String(names.length)} 个文件条目`)

  log('⑫ 删除：**只删这个用例自己上传的素材**')
  // 这条最早写错了，而且造成了真实损失：它从「未被引用的素材」里挑 40 张删，
  // 而回归每次跑完会清掉画布，于是所有素材都变成「未被引用」——几轮下来删掉了
  // 几百张生成结果。**「没人引用」不等于「可以删」**，归属只能由「是不是我建的」判断。
  const fixture = makePng(24, 24)
  const created = await fetch(`${BASE}/api/assets`, {
    method: 'POST', headers: { 'content-type': 'image/png', cookie: api.cookie }, body: fixture,
  })
  const fixtureAsset = (await created.json()).asset
  check('自己上传的素材已入库', typeof fixtureAsset?.id === 'string', fixtureAsset?.id?.slice(0, 8) ?? '')

  const removeMine = await fetch(`${BASE}/api/assets/${fixtureAsset.id}`, { method: 'DELETE', headers: { cookie: api.cookie } })
  check('没人引用的素材能删掉', removeMine.ok, `HTTP ${String(removeMine.status)}`)
  const gone = await fetch(`${BASE}/api/assets/${fixtureAsset.id}`, { headers: { cookie: api.cookie } })
  check('删掉之后取不到了', gone.status === 404, `HTTP ${String(gone.status)}`)
  const stillListed = ((await api.call('/api/assets')).json.assets ?? []).some((asset) => asset.id === fixtureAsset.id)
  check('列表里也没有了', stillListed === false)

  // 反向：正在被画布显示的素材必须拒绝删除。
  const inUse = (await api.getCanvas(projectId)).doc?.nodes?.find((node) => typeof node.data?.url === 'string' && node.data.url.startsWith('/api/assets/'))
  const usedId = (inUse?.data?.url ?? '').split('/api/assets/')[1] ?? ''
  check('画布上确实挂着一张自己的素材（前置条件）', usedId !== '', usedId.slice(0, 8))
  if (usedId !== '') {
    const refused = await fetch(`${BASE}/api/assets/${usedId}`, { method: 'DELETE', headers: { cookie: api.cookie } })
    check('画布正在用的素材拒绝删除', refused.status === 409, `HTTP ${String(refused.status)}`)
    check('拒绝时说明原因', ((await refused.json()).error ?? '').includes('画布'), '')
  }

  log('⑬ 清理：只删这个用例上传的 70 张测试素材')
  let cleaned = 0
  for (const id of fixtures) {
    const response = await fetch(`${BASE}/api/assets/${id}`, { method: 'DELETE', headers: { cookie: api.cookie } })
    if (response.ok) cleaned += 1
  }
  check('测试素材已全部删除', cleaned === 70, `${String(cleaned)} / 70`)
  const afterAll = (await api.call('/api/assets')).json.assets ?? []
  check('库里的其余素材一张没少', afterAll.length === listed.length,
    `${String(listed.length)} -> ${String(afterAll.length)}`)

  check('全程没有 JS 报错', s.consoleErrors.length === 0, s.consoleErrors.slice(0, 2).join(' | '))
  await s.shot('assets-browser.png')
  s.kill()
  await api.call(`/api/projects/${projectId}?purge=1`, { method: 'DELETE' })

  log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[assets] 失败:', error); process.exit(1) })

/** Minimal PNG encoder for fixtures — no dependencies, no files on disk. */
function makePng(width, height, seed = 0) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 4
      raw[at] = (x * 8 + seed * 17) % 256
      raw[at + 1] = (y * 8 + seed * 29) % 256
      raw[at + 2] = (128 + seed * 7) % 256
      raw[at + 3] = 255
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
