/**
 * 视频端到端验收（**不在默认回归里：一条要十几分钟**）。
 *
 * 用法: node tests/video-e2e-test.mjs <baseUrl> <password>
 *
 * 为什么要有它：一次真实出片十几分钟，而这条链路里最容易错的三处
 * （驱动判 mime、asset 存成 video、take 记 latency）都只有真跑一次才看得见。
 * 默认回归不动它，是因为把 10 分钟的回归变成 22 分钟不划算——
 * 改过视频驱动、或换了视频模型之后手动跑一次。
 *
 * 注意：它会**真的占住显卡十几分钟**。
 *
 * **不能用 fetch 发那个生成请求**：Node 的 fetch（undici）默认 5 分钟收不到响应头
 * 就报 HeadersTimeoutError，而生成要 11 分钟——客户端先死，服务端还在渲染。
 * 我第一次就是这么崩的：屏幕上一条「fetch failed」，其实片子 5 分钟后正常出了。
 */
import { request as httpRequest } from 'node:http'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8099'
const PASSWORD = process.argv[3] ?? process.env.STUDIO_PASSWORD ?? ''
const WORKFLOW = process.env.VIDEO_WORKFLOW ?? 'minimax-h3-video'
const SIZE = process.env.VIDEO_SIZE ?? '1344x768'
const DURATION = Number(process.env.VIDEO_DURATION ?? 5)
/**
 * 首帧素材 id：给了就跑**图生视频**（否则文生视频）。
 *
 * 拿一张已有的图当首帧，走 `/v1/images/generations` 的 `first_frame` 字段。
 * 断言它真的被用上了：take 里要记下这个文件名，而且**生成片的第一帧应当长得像那张图**
 * （这一条只能靠眼睛，脚本只能把两帧取出来给人看）。
 */
const FIRST_FRAME = process.env.VIDEO_FIRST_FRAME ?? ''
/** 留足余量：11 分钟是实测，冷启动或换更大的片子会更久。 */
const GENERATE_TIMEOUT_MS = 45 * 60 * 1000

let failures = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

/**
 * POST JSON with a timeout of our own choosing.
 * @param path - path on the Studio server.
 * @param body - JSON body.
 * @param cookie - session cookie.
 * @returns status and parsed body.
 */
const postJson = (path, body, cookie) => new Promise((resolve, reject) => {
  const target = new URL(`${BASE}${path}`)
  const payload = JSON.stringify(body)
  const req = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...(cookie === '' ? {} : { cookie }),
    },
  }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) < 400, json: text === '' ? {} : JSON.parse(text) })
    })
  })
  req.setTimeout(GENERATE_TIMEOUT_MS, () => { req.destroy(new Error(`请求超过 ${String(GENERATE_TIMEOUT_MS / 60_000)} 分钟`)) })
  req.on('error', reject)
  req.end(payload)
})

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})
const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
check('登录成功', login.ok, `HTTP ${String(login.status)}`)
if (!login.ok) process.exit(1)

const call = async (path, init = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  })
  const body = await response.text()
  return { status: response.status, ok: response.ok, json: body === '' ? {} : JSON.parse(body) }
}

console.log('\n=== 工作流库里有没有这套视频工作流 ===')
const list = await call('/api/workflows')
const workflow = (list.json.workflows ?? []).find((item) => item.id === WORKFLOW)
check(`找到 ${WORKFLOW}`, workflow !== undefined, (list.json.workflows ?? []).map((w) => `${w.id}:${String(w.capability)}`).join(', '))
check('它的 capability 是 video', workflow?.capability === 'video', String(workflow?.capability))
check('本机没有缺节点/缺模型', (workflow?.missingNodes ?? []).length === 0 && (workflow?.missingModels ?? []).length === 0,
  JSON.stringify({ nodes: workflow?.missingNodes, models: workflow?.missingModels }))

console.log('\n=== 造一个画布 + 镜头，然后生成 ===')
const project = (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: `视频验收 ${String(Date.now())}` }) })).json.project
const shot = (await call(`/api/projects/${project.id}/shots`, {
  method: 'POST',
  body: JSON.stringify({ title: '视频镜头', prompt: '验收' }),
})).json.shot
check('画布与镜头已建', project?.id !== undefined && shot?.id !== undefined)

const started = Date.now()
// 用 http.request 而不是 fetch：见文件头的说明（fetch 默认 5 分钟就放弃）。
const response = await postJson('/v1/images/generations', {
  model: 'studio-image',
  prompt: 'Cinematic close-up of a red paper lantern swaying in the rain at night, neon reflections on wet stone, slow steady camera, film grain. Ambient rain and distant traffic.',
  size: SIZE,
  n: 1,
  shotId: shot.id,
  workflow: WORKFLOW,
  duration: DURATION,
  ...(FIRST_FRAME === '' ? {} : { first_frame: FIRST_FRAME }),
}, cookie)
const payload = response.json
const seconds = Math.round((Date.now() - started) / 1000)
check('生成返回 200', response.ok, `HTTP ${String(response.status)} 用时 ${String(seconds)}s ${response.ok ? '' : JSON.stringify(payload).slice(0, 400)}`)
if (!response.ok) {
  await call(`/api/projects/${project.id}?purge=1`, { method: 'DELETE' })
  process.exit(1)
}
const url = payload.data?.[0]?.url
check('返回了一个素材地址', typeof url === 'string' && url.startsWith('/api/assets/'), String(url))
console.log(`  生成耗时 ${String(seconds)} 秒（含模型装载）`)

console.log('\n=== 素材是视频，不是被当成图片存下来的 ===')
const head = await fetch(`${BASE}${url}`, { headers: { cookie } })
check('素材可下载', head.ok, `HTTP ${String(head.status)}`)
check('content-type 是 video/mp4', (head.headers.get('content-type') ?? '').includes('video/mp4'), String(head.headers.get('content-type')))
const bytes = Buffer.from(await head.arrayBuffer())
check('字节数 > 100 KB（不是一张图）', bytes.length > 100_000, `${String(bytes.length)} 字节`)
check('是合法 mp4（ftyp box）', bytes.subarray(4, 8).toString('latin1') === 'ftyp', bytes.subarray(4, 12).toString('latin1'))

const assets = (await call('/api/assets')).json.assets ?? []
const stored = assets.find((item) => url.endsWith(item.id))
check('素材库里 kind 记的是 video', stored?.kind === 'video', JSON.stringify({ kind: stored?.kind, mime: stored?.mime }))

console.log('\n=== take 与 ETA 统计 ===')
const takes = (await call(`/api/shots/${shot.id}/takes`)).json.takes ?? []
check('记了一条成功的 take', takes.length === 1 && takes[0]?.status === 'succeeded', JSON.stringify(takes.map((t) => t.status)))
check('take 上有耗时', (takes[0]?.latencyMs ?? 0) > 60_000, `${String(Math.round((takes[0]?.latencyMs ?? 0) / 1000))}s`)
// 图生视频时，首帧是哪张图必须落在 take 里：光看提示词分不出「这一版是从哪张图起的」。
if (FIRST_FRAME !== '') {
  const recorded = takes[0]?.params?.images?.first
  check('take 里记下了首帧', typeof recorded === 'string' && recorded.startsWith(FIRST_FRAME),
    `${String(recorded)}（用的是 ${FIRST_FRAME}）`)
}
const stats = (await call('/api/generation/stats')).json
check('ETA 统计里有 video 这一档', stats.estimate?.byKind?.video !== undefined, JSON.stringify(stats.estimate?.byKind ?? {}))
check('video 的中位数明显大于 image 那一档（没有被混在一起）',
  (stats.estimate?.byKind?.video?.medianMs ?? 0) >= (stats.estimate?.byKind?.image?.medianMs ?? 0),
  JSON.stringify(stats.estimate))

console.log('\n=== 清理（只删这次造的画布与素材）===')
const purged = await call(`/api/projects/${project.id}?purge=1`, { method: 'DELETE' })
check('画布已删除', purged.ok, `HTTP ${String(purged.status)}`)
if (stored !== undefined) {
  const removed = await call(`/api/assets/${stored.id}`, { method: 'DELETE' })
  check('素材已删除', removed.ok, `HTTP ${String(removed.status)} ${removed.ok ? '' : JSON.stringify(removed.json)}`)
}

console.log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
