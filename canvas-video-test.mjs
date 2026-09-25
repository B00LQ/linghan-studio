/**
 * 画布上的视频节点验收（不需要出片，所以很快）。
 *
 * 用法: node canvas-video-test.mjs [baseUrl] [password]
 *
 * 为什么要单独有一条：视频节点最要紧的不是「后端能出 mp4」（那有 video-e2e-test 管），
 * 而是**这张卡有没有把它放出来**。`<img src="x.mp4">` 什么都不显示，
 * 而元素存在 ≠ 画出来了 —— 所以这里量的是 `videoWidth > 0`（和图片那条 `naturalWidth > 0`
 * 是同一个道理：程序化点击和 getBoundingClientRect 对「没渲染」是盲的）。
 *
 * 素材是自己上传的一段真 mp4（从本机 ComfyUI 的输出里取），跑完自己删掉。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] ?? process.env.STUDIO_PASSWORD ?? ''
const PORT = Number(process.env.CDP_PORT || 9263)
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('canvas-video')

/** ComfyUI 的输出目录：拿一段真 mp4，而不是伪造字节。 */
const OUTPUT_DIR = process.env.COMFYUI_OUTPUT ?? 'E:/AI/ComfyUI/output'

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

const cleanupSteps = []
let browser = null
const cleanup = async () => {
  browser?.kill()
  if (browser !== null) await sleep(300)
  for (const step of cleanupSteps.reverse()) {
    try { await step() } catch (error) { console.error('[canvas-video] 清理失败：', error) }
  }
}

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  check('API 已登录', api.cookie !== '')

  log('① 找一段真 mp4 上传（不伪造字节）')
  const fixture = process.env.VIDEO_FIXTURE ?? ''
  const candidates = fixture !== ''
    ? (existsSync(fixture) ? [fixture] : [])
    : (existsSync(OUTPUT_DIR) ? readdirSync(OUTPUT_DIR).filter((name) => name.endsWith('.mp4')).map((name) => join(OUTPUT_DIR, name)) : [])
  // 依赖「本机 ComfyUI 出过视频」是有意的：拿真 mp4 才验得出「浏览器能不能解出画面」。
  // 但失败信息必须给出路，而不是只说一句 ✗。
  check('本机有可用的 mp4', candidates.length > 0,
    `没找到；设 VIDEO_FIXTURE=<某个.mp4> 或先在 ComfyUI 里出一段（找过 ${fixture !== '' ? fixture : OUTPUT_DIR}）`)
  if (candidates.length === 0) { await cleanup(); process.exit(1) }
  const { readFileSync, statSync } = await import('node:fs')
  const picked = candidates.map((path) => ({ path, size: statSync(path).size })).sort((a, b) => a.size - b.size)[0]
  const bytes = readFileSync(picked.path)
  const upload = await fetch(`${BASE}/api/assets`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', cookie: api.cookie },
    body: bytes,
  })
  check('上传成功', upload.status === 200, `HTTP ${String(upload.status)}`)
  const asset = (await upload.json()).asset
  check('素材被记成 video', asset?.kind === 'video', `${String(asset?.kind)} / ${String(asset?.mime)}`)
  cleanupSteps.unshift(() => api.call(`/api/assets/${asset.id}`, { method: 'DELETE' }))

  log('② 造一张带「视频」节点的画布')
  const project = (await api.createProject(`视频节点验收 ${STAMP}`)).project
  cleanupSteps.push(() => api.call(`/api/projects/${project.id}?purge=1`, { method: 'DELETE' }))
  const shot = (await api.call(`/api/projects/${project.id}/shots`, {
    method: 'POST',
    body: JSON.stringify({ title: '视频镜头', prompt: '验收' }),
  })).json.shot
  const take = (await api.call(`/api/shots/${shot.id}/takes`, {
    method: 'POST',
    body: JSON.stringify({ assetId: asset.id, status: 'succeeded', providerId: 'fixture', model: '验收视频', latencyMs: 653_000 }),
  })).json.take
  check('版本已记录', typeof take?.id === 'string' && take.id !== '')

  await api.putCanvas(project.id, {
    nodes: [{
      id: 'video-verify',
      type: 'studio',
      position: { x: 0, y: 0 },
      data: {
        kind: 'video',
        text: '雨夜灯笼',
        url: `/api/assets/${asset.id}`,
        shotId: shot.id,
        takeId: take.id,
        takeNumber: 1,
        size: '1344x768',
        duration: 5,
      },
    }],
    edges: [],
    viewport: { x: 420, y: 240, zoom: 1 },
  })

  const s = await startSession({ port: PORT, width: 1500, height: 950 })
  browser = s
  await s.login(BASE, PASSWORD)
  await s.goto(`${BASE}/canvas/${project.id}`, 4500)

  log('③ 卡片上是不是真的有个能放的播放器')
  const box = await until(() => s.evaluate(`(() => {
    const el = document.querySelector('.studio-node[data-kind="video"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 10) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 20), w: Math.round(r.width), h: Math.round(r.height) };
  })()`))
  check('画布上出现了视频节点', box !== null, JSON.stringify(box))
  // 视频卡应当比图片卡宽（360 vs 300）——这是 CSS 里给 video 单独写的那条
  check('视频卡按 16:9 排（比图片卡宽）', (box?.w ?? 0) >= 340, `宽 ${String(box?.w)}`)

  const player = await until(() => s.evaluate(`(() => {
    const v = document.querySelector('.studio-node[data-kind="video"] video.node-video');
    if (!v) return null;
    // videoWidth 才是「真的解出了画面」的证据；元素存在不算。
    return { src: v.getAttribute('src'), videoWidth: v.videoWidth, videoHeight: v.videoHeight, hasControls: v.controls, readyState: v.readyState };
  })()`), 20_000)
  check('卡片里是 <video> 而不是 <img>', player !== null, JSON.stringify(player))
  check('播放器控件的存在（不是静音缩略图）', player?.hasControls === true)
  check('真的解出了画面（videoWidth > 0）', (player?.videoWidth ?? 0) > 0,
    `${String(player?.videoWidth)}×${String(player?.videoHeight)}  readyState=${String(player?.readyState)}`)
  check('src 指向这个素材', (player?.src ?? '').includes(asset.id), String(player?.src))

  log('④ 提示词窗口：只列视频工作流、给的是时长而不是张数')
  if (box !== null) await s.click(box.x, box.y)
  await sleep(800)
  check('选中后出现提示词窗口', (await s.evaluate(`document.querySelectorAll('.prompt-window').length`)) === 1)
  const bar = await s.evaluate(`(() => {
    const win = document.querySelector('.prompt-window');
    if (!win) return null;
    const selects = [...win.querySelectorAll('select')];
    return {
      workflowOptions: selects[0] ? [...selects[0].options].map((o) => ({ value: o.value, text: o.text })) : [],
      workflowValue: selects[0] ? selects[0].value : '',
      allSelectTexts: selects.map((sel) => [...sel.options].map((o) => o.text).join('|')),
      hasDuration: selects.some((sel) => [...sel.options].some((o) => o.text.includes('约'))),
      hasCount: selects.some((sel) => [...sel.options].some((o) => o.text.includes('张'))),
    };
  })()`)
  log(`   工作流下拉: ${JSON.stringify(bar?.workflowOptions)}`)
  check('工作流下拉只列视频工作流', (bar?.workflowOptions ?? []).length > 0
    && (bar?.workflowOptions ?? []).every((o) => !o.text.includes('Z-Image')), JSON.stringify(bar?.workflowOptions))
  check('默认选中的是视频工作流', (bar?.workflowValue ?? '').includes('minimax'), String(bar?.workflowValue))
  check('有时长（约几秒）而不是张数', bar?.hasDuration === true && bar?.hasCount === false, JSON.stringify(bar?.allSelectTexts))

  log('⑤ 版本条上是视频缩略图（<img src=mp4> 会什么都不显示）')
  const thumb = await s.evaluate(`(() => {
    const cell = document.querySelector('.prompt-window .history-cell');
    if (!cell) return null;
    const v = cell.querySelector('video');
    return { hasVideo: v !== null, hasImg: cell.querySelector('img') !== null };
  })()`)
  check('版本格用的是 video 元素', thumb?.hasVideo === true, JSON.stringify(thumb))
  check('版本格里没有 <img>', thumb?.hasImg === false, JSON.stringify(thumb))

  console.log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  await cleanup()
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch(async (error) => {
  console.error('[canvas-video] 崩了：', error)
  await cleanup()
  process.exit(1)
})
