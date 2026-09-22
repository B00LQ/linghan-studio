/**
 * Take 流水线验收：生成 → 自动落 take → 版本历史 → 选用 → 失败也留痕。
 *
 * 用法: node take-pipeline-test.mjs <baseUrl> <password>
 *
 * 这个脚本刻意走 HTTP 而不是直接调 store：要验的是「画布生成时 take 会不会
 * 自动产生」这条链路，包括服务端中间那一层。它会真的出图（本地 ComfyUI 热态约 6s/张）。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'

let cookie = ''
const log = (...a) => console.log('[take-test]', ...a)
let failures = 0

/** Call the API with the session cookie attached. */
async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let payload = {}
  try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { raw: text } }
  return { status: response.status, ok: response.ok, payload }
}

/** Assert a condition and keep a running failure count. */
function check(label, condition, detail = '') {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const run = async () => {
  log('① 登录')
  const login = await call('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })
  check('登录成功', login.ok, `HTTP ${login.status}`)
  const setCookie = login.payload === undefined ? '' : ''
  // fetch 不会暴露 Set-Cookie，改用服务端回的 header 不方便；这里直接用 cookie jar 的替代方案：
  // 重新登录并读取 response.headers.getSetCookie()
  const raw = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  const cookies = raw.headers.getSetCookie?.() ?? []
  cookie = cookies.map((item) => item.split(';')[0]).join('; ')
  check('拿到会话 cookie', cookie !== '', setCookie)

  log('② 建项目 + 建镜头')
  const project = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Take 流水线验收' }) })
  check('项目已创建', project.ok)
  const projectId = project.payload.project?.id
  const shot = await call(`/api/projects/${projectId}/shots`, {
    method: 'POST',
    body: JSON.stringify({ title: '验收镜头', prompt: '测试提示词' }),
  })
  check('镜头已创建', shot.ok)
  const shotId = shot.payload.shot?.id
  check('新镜头没有选定 take', shot.payload.shot?.selectedTakeId === '')

  log('③ 连续生成两次（同一镜头 = 两个版本）')
  const prompt = '测试用画面：一盏台灯，深色桌面，电影感'
  const first = await call('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({ model: 'studio-image', prompt, size: '1024x1024', n: 1, shotId }),
  })
  check('第一次生成成功', first.ok, first.ok ? '' : JSON.stringify(first.payload).slice(0, 200))
  check('响应里带回了 takeId', typeof first.payload.data?.[0]?.takeId === 'string')

  const second = await call('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({ model: 'studio-image', prompt, size: '1024x1024', n: 1, shotId }),
  })
  check('第二次生成成功', second.ok)

  log('④ 版本历史')
  const takes = await call(`/api/shots/${shotId}/takes`)
  const list = takes.payload.takes ?? []
  check('两个版本都已记录', list.length === 2, `实际 ${list.length}`)
  check('版本按时间倒序（最新在前）', list.length === 2 && list[0].createdAt >= list[1].createdAt)
  const newest = list[0] ?? {}
  check('记录了提示词', newest.params?.prompt === prompt, JSON.stringify(newest.params))
  check('记录了尺寸', newest.params?.size === '1024x1024')
  check('记录了耗时', typeof newest.latencyMs === 'number' && newest.latencyMs > 0, `${newest.latencyMs}ms`)
  check('记录了种子（重拍可复现的前提）', typeof newest.seed === 'number', `seed=${newest.seed}`)
  check('记录了产出素材', typeof newest.assetId === 'string' && newest.assetId.length === 32)
  check('两次生成的种子不同', list[0]?.seed !== list[1]?.seed, `${list[0]?.seed} vs ${list[1]?.seed}`)
  check('初始状态都不是已选用', list.every((take) => take.mark === 'none'))

  log('⑤ 选用一个版本')
  const chosen = list[1]?.id
  const selected = await call(`/api/shots/${shotId}/select`, { method: 'POST', body: JSON.stringify({ takeId: chosen }) })
  check('选用成功', selected.ok)
  const after = await call(`/api/shots/${shotId}/takes`)
  const afterList = after.payload.takes ?? []
  check('恰好一个版本被标记为已选用', afterList.filter((take) => take.mark === 'selected').length === 1)
  check('被标记的正是选中的那个', afterList.find((take) => take.mark === 'selected')?.id === chosen)
  const shots = await call(`/api/projects/${projectId}/shots`)
  check('镜头记住了选定的 take', shots.payload.shots?.[0]?.selectedTakeId === chosen)
  check('镜头状态推进到 locked', shots.payload.shots?.[0]?.status === 'locked', shots.payload.shots?.[0]?.status)

  log('⑥ 拒绝无效输入（不能让脏数据进库）')
  const badTake = await call(`/api/shots/${shotId}/select`, { method: 'POST', body: JSON.stringify({ takeId: 'not-a-real-take' }) })
  check('选用不存在的 take 返回 404', badTake.status === 404, `HTTP ${badTake.status}`)
  const badShot = await call('/api/shots/does-not-exist/takes')
  const badShotPost = await call('/api/shots/does-not-exist/takes', { method: 'POST', body: '{}' })
  check('给不存在的镜头记 take 返回 404', badShotPost.status === 404, `HTTP ${badShotPost.status}`)
  check('不存在的镜头历史为空', (badShot.payload.takes ?? []).length === 0)

  log('⑦ 未知 shotId 不能拖垮生成')
  const stray = await call('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({ model: 'studio-image', prompt, size: '1024x1024', n: 1, shotId: 'not-a-real-shot' }),
  })
  check('带无效 shotId 仍然出图成功（只是不记 take）', stray.ok, `HTTP ${stray.status}`)
  check('无效 shotId 时不返回 takeId', stray.payload.data?.[0]?.takeId === undefined)

  log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[take-test] 异常:', error)
  process.exit(1)
})
