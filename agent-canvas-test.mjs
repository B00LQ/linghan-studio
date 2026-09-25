/**
 * Agent 双入口验收：外部 Agent 通过 HTTP 独立完成「建节点 → 连线 → 出图 → 选版本」。
 *
 * 用法: node agent-canvas-test.mjs <baseUrl> <password>
 *
 * 关键在于**全程不打开浏览器**：libtv 的 Agent 入口是无人值守路径，
 * 如果它依赖「有人开着画布标签页」，那就不叫第二入口。脚本开头会显式断言
 * 当前没有任何画布连接。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'

let cookie = ''
let failures = 0
const log = (...a) => console.log('[agent-test]', ...a)

/** Call an endpoint with the session cookie attached. */
async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let payload = {}
  try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { raw: text.slice(0, 200) } }
  return { status: response.status, ok: response.ok, payload }
}

/** Assert a condition and keep a running failure count. */
function check(label, condition, detail = '') {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

/** Invoke one agent tool. */
const tool = (name, input = {}) => call('/api/agent/call', { method: 'POST', body: JSON.stringify({ name, input }) })

/**
 * Poll a submitted job to a terminal state.
 *
 * 生成是作业：提交返回 jobId，结果用 job_status 收。图片冷启动要 70–90 秒
 * （第一次出图要装载权重），所以等待上限给足；已经在终态的直接返回。
 * @param submitted - the result of `canvas_generate` (or already a job status).
 * @param seconds - how long to keep asking.
 * @returns the last status seen.
 */
const settle = async (submitted, seconds = 240) => {
  let status = submitted
  const jobId = submitted?.jobId
  if (typeof jobId !== 'string' || jobId === '') return status
  const deadline = Date.now() + seconds * 1000
  while ((status?.status === 'queued' || status?.status === 'running') && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 500) })
    status = (await tool('job_status', { jobId })).payload.result
  }
  return status
}

const run = async () => {
  log('① 登录并建立会话')
  const raw = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = (raw.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
  check('拿到会话 cookie', cookie !== '')

  log('② 连接状态（「无人值守」这一条要看它）')
  // 如果操作者正开着画布页面，浏览器的 EventSource 会保持连接，clients 必然为 true。
  // 那是人在用产品，不是缺陷。所以：
  //   - 默认：只报告，不影响判定；
  //   - REQUIRE_UNATTENDED=1：硬性要求零连接——用在一个没有浏览器的独立实例上，
  //     那才是「Agent 不需要有人开着画布」的干净证据。
  const requireUnattended = process.env.REQUIRE_UNATTENDED === '1'
  let clients = true
  for (let i = 0; i < 16; i += 1) {
    const health = await call('/api/health')
    clients = health.payload.clients === true
    if (!clients) break
    if (!requireUnattended) break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  if (requireUnattended) {
    check('确认没有任何画布连接', clients === false, clients ? '仍有连接，无法证明无人值守' : '')
  } else {
    log(`   clients=${String(clients)}${clients ? '（有人在看画布，属正常）' : '（无人连接）'}`)
    log('   提示：要证明无人值守，请用 REQUIRE_UNATTENDED=1 跑在一个没有浏览器的实例上')
  }

  log('③ 工具面')
  const catalogue = await call('/api/agent/tools')
  const names = (catalogue.payload.tools ?? []).map((t) => t.name)
  // 8 个：画布读写 5 个（state / add_node / set_text / connect / generate）、
  // 人类指定的 Agent 上下文 1 个、镜头历史 2 个。断言确切数字是为了让
  // 「工具悄悄多一个或少一个」必须被人看见，而不是被 includes 蒙过去。
  // 10 个 = 8 个画布/版本工具 + job_status / job_cancel（生成改成作业之后补的）。
  check('工具清单可读', catalogue.ok && names.length === 10, `${names.length} 个：${names.join(', ')}`)
  check('工具面带「人类指的上下文」这一个', names.includes('canvas_context'),
    `当前工具：${names.join(', ')}`)
  check('工具面带查作业与取消作业', names.includes('job_status') && names.includes('job_cancel'),
    `当前工具：${names.join(', ')}`)
  check('每个工具都带 JSON Schema', (catalogue.payload.tools ?? []).every((t) => t.inputSchema?.type === 'object'))
  const kinds = catalogue.payload.tools?.find((t) => t.name === 'canvas_add_node')?.inputSchema?.properties?.kind?.enum ?? []
  check('节点类型是 文本 / 图片 / 视频', kinds.length === 3 && ['text', 'image', 'video'].every((k) => kinds.includes(k)), kinds.join(','))

  log('④ 建一个干净的项目')
  const project = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Agent 双入口验收' }) })
  const projectId = project.payload.project?.id
  check('项目已创建', typeof projectId === 'string' && projectId.length > 0)

  const empty = await tool('canvas_state', { projectId })
  check('新画布是空的', (empty.payload.result?.nodes ?? []).length === 0)

  log('⑤ Agent 搭出「文本 → 图片」结构')
  const prompt = 'Agent 生成：旧书店的木质书架，午后斜光，尘埃'
  const textNode = await tool('canvas_add_node', { projectId, kind: 'text', text: prompt, x: 0, y: 0 })
  const textId = textNode.payload.result?.nodeId
  check('文本节点已建', typeof textId === 'string' && textId.startsWith('text-'), String(textId))

  const imageNode = await tool('canvas_add_node', { projectId, kind: 'image', size: '1024x1024', count: 1, x: 420, y: 0 })
  const imageId = imageNode.payload.result?.nodeId
  check('图片节点已建', typeof imageId === 'string' && imageId.startsWith('image-'), String(imageId))

  const edge = await tool('canvas_connect', { projectId, from: textId, to: imageId })
  check('连线已建立', edge.payload.result?.ok === true, String(edge.payload.result?.edgeId))

  log('⑥ 生成：提交立刻返回，结果用 job_status 收（冷启动出图要 70–90 秒）')
  // waitMs 默认图片 20 秒、视频 0。**20 秒不够冷启动**（第一次出图要装载权重），
  // 所以用例必须照真实用法来：先提交拿 jobId，再轮询到终态。
  // 这不是测试的将就——工具的描述里就是这么要求调用方的。
  const firstSubmitted = await tool('canvas_generate', { projectId, nodeId: imageId })
  check('立刻返回了 jobId（没把 HTTP 请求挂在渲染上）',
    firstSubmitted.ok && typeof firstSubmitted.payload.result?.jobId === 'string',
    JSON.stringify(firstSubmitted.payload).slice(0, 160))
  check('提示词从上游文本节点解析出来', firstSubmitted.payload.result?.prompt === prompt)

  const first = await settle(firstSubmitted.payload.result)
  const shotId = first?.shotId
  check('出图成功', first?.status === 'succeeded' && (first?.files ?? []).length === 1, JSON.stringify(first).slice(0, 160))
  check('自动建立了版本历史', typeof shotId === 'string' && shotId.length > 0, String(shotId))
  check('产出了 take', typeof first?.files?.[0]?.takeId === 'string')

  const secondSubmitted = await tool('canvas_generate', { projectId, nodeId: imageId, prompt: `${prompt}（第二版：更暗）` })
  const second = await settle(secondSubmitted.payload.result)
  check('第二次生成成功，累计两张', second?.takesSoFar === 2, `takesSoFar=${String(second?.takesSoFar)}`)
  check('两次用的是同一个节点的历史', second?.shotId === shotId)

  log('⑦ 版本与选用')
  const takes = await tool('shot_takes', { projectId, nodeId: imageId })
  const list = takes.payload.result?.takes ?? []
  check('读到 2 个版本', list.length === 2, `${list.length} 个`)
  check('版本带种子与耗时（重拍可复现）', typeof list[0]?.seed === 'number' && typeof list[0]?.latencyMs === 'number',
    `seed=${String(list[0]?.seed)} latency=${String(list[0]?.latencyMs)}ms`)
  const picked = await tool('shot_select_take', { projectId, nodeId: imageId, takeId: list[1].id })
  check('选用成功', picked.payload.result?.ok === true)
  const after = await tool('shot_takes', { projectId, nodeId: imageId })
  check('恰好一个版本被标记为已选用', (after.payload.result?.takes ?? []).filter((t) => t.mark === 'selected').length === 1)

  log('⑧ 画面落在图片节点自己身上')
  const state = await tool('canvas_state', { projectId })
  const nodes = state.payload.result?.nodes ?? []
  const target = nodes.find((n) => n.id === imageId)
  check('图片节点带上了画面地址', typeof target?.url === 'string' && target.url.startsWith('/api/assets/'), String(target?.url))
  check('图片节点记住了自己的历史', target?.shotId === shotId)
  check('画布上没有多余的图片节点', nodes.filter((n) => n.kind === 'image').length === 1,
    `${nodes.filter((n) => n.kind === 'image').length} 个`)
  check('连线还在', (state.payload.result?.edges ?? []).length === 1)

  const doc = await call(`/api/projects/${projectId}/canvas`)
  check('文档已持久化（浏览器加载的就是这份）', (doc.payload.doc?.nodes ?? []).length === nodes.length)

  log('⑨ 错误必须是可读的答案，不是 500')
  const badNode = await tool('canvas_generate', { projectId, nodeId: textId })
  check('对文本节点生成 → 400 且说明原因', badNode.status === 400 && /只有图片或视频节点能生成/u.test(badNode.payload.error ?? ''), String(badNode.payload.error))

  const noPrompt = await tool('canvas_add_node', { projectId, kind: 'image' })
  const emptyGen = await tool('canvas_generate', { projectId, nodeId: noPrompt.payload.result.nodeId })
  check('空提示词 → 400 且给出补救办法', emptyGen.status === 400 && /提示词为空/u.test(emptyGen.payload.error ?? ''), String(emptyGen.payload.error))

  const unknown = await tool('canvas_teleport', { projectId })
  check('未知工具 → 400 且列出可用工具', unknown.status === 400 && /可用工具/u.test(unknown.payload.error ?? ''), String(unknown.payload.error).slice(0, 80))

  const badProject = await tool('canvas_state', { projectId: 'not-a-project' })
  check('不存在的项目 → 400', badProject.status === 400 && /项目不存在/u.test(badProject.payload.error ?? ''))

  const badKind = await tool('canvas_add_node', { projectId, kind: 'audio' })
  check('非法节点类型 → 400', badKind.status === 400 && /kind 必须是/u.test(badKind.payload.error ?? ''), String(badKind.payload.error))

  log('⑩ 生成是作业：不等到出完也能接着查（Agent 出视频靠这条）')
  // waitMs=0：立刻返回 jobId。从前这条路会把 HTTP 请求挂到渲染结束 ——
  // 图片 6 秒还行，让 Agent 出一段视频就必超时，而且「调用方失败」与「活干完了」
  // 会同时为真。现在提交与结果是两件事。
  const submitted = await tool('canvas_generate', { projectId, nodeId: imageId, prompt: `${prompt}（异步这一版）`, waitMs: 0 })
  const jobId = submitted.payload.result?.jobId
  check('立即返回了 jobId', typeof jobId === 'string' && jobId.length > 0, String(jobId))
  check('没有假装出完（不带 produced）', submitted.payload.result?.produced === undefined,
    JSON.stringify(submitted.payload.result).slice(0, 140))
  check('返回里明说还没出结果', /job_status/u.test(submitted.payload.result?.note ?? ''), String(submitted.payload.result?.note).slice(0, 80))

  const status = await settle(submitted.payload.result)
  check('轮询到了 succeeded', status?.status === 'succeeded', JSON.stringify(status).slice(0, 160))
  check('结果里有素材地址', (status?.files ?? []).length === 1 && String(status.files[0].url).startsWith('/api/assets/'),
    JSON.stringify(status?.files ?? []).slice(0, 120))
  check('版本数跟着涨到 3', status?.takesSoFar === 3, `takesSoFar=${String(status?.takesSoFar)}`)

  // 这条是关键：Agent 一次都没写画布，画面仍然出现在节点上 —— 因为写画布是**服务端**
  // 在作业里做的（也就是「没有浏览器开着也算数」的同一件事）。
  const afterAsync = await tool('canvas_state', { projectId })
  const asyncNode = (afterAsync.payload.result?.nodes ?? []).find((n) => n.id === imageId)
  check('服务端把新画面写进了画布', asyncNode?.url === status?.files?.[0]?.url, String(asyncNode?.url))

  const cancelDone = await tool('job_cancel', { jobId })
  check('取消一个已结束的作业 → 如实拒绝', cancelDone.payload.result?.ok === false && /已经结束/u.test(cancelDone.payload.result?.reason ?? ''),
    JSON.stringify(cancelDone.payload.result))
  const noJob = await tool('job_status', { jobId: 'job-nope' })
  check('查不存在的作业 → 400 且说明作业不落盘', noJob.status === 400 && /没有这个作业/u.test(noJob.payload.error ?? ''), String(noJob.payload.error))

  log('⑪ Agent 也能建视频节点（从前服务端连这个 kind 都没有）')
  const videoNode = await tool('canvas_add_node', { projectId, kind: 'video', text: '雨夜霓虹街头，纸灯笼在雨中轻晃', duration: 3 })
  const videoId = videoNode.payload.result?.nodeId
  check('视频节点已建', typeof videoId === 'string' && videoId.startsWith('video-'), String(videoId))
  const withVideo = await call(`/api/projects/${projectId}/canvas`)
  const videoData = (withVideo.payload.doc?.nodes ?? []).find((n) => n.id === videoId)?.data
  check('默认值和人建的视频节点一致（1344x768、片长按传入的 3 秒）',
    videoData?.size === '1344x768' && videoData?.duration === 3,
    JSON.stringify({ size: videoData?.size, duration: videoData?.duration }))

  log(failures === 0 ? '\n全部通过：Agent 在无人值守下完成了与人点击等价的创作流程' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[agent-test] 异常:', error)
  process.exit(1)
})
