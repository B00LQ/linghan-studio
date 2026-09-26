/**
 * DAG 工作流 HTTP 验收（**真实出图**）。
 *
 * 用法: node tests/workflow-api-test.mjs <baseUrl> <password>
 *
 * 引擎单测已经用假执行器数清了「谁被执行」。这一套要证明的是**真模型**上同样成立：
 * 第一次运行真的调了本地 ComfyUI 出图（约 6 秒），第二次原样运行必须
 * **零执行、零模型调用、毫秒级返回** —— 这正是 PRD 最核心的那条承诺。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'

let cookie = ''
let failures = 0
const log = (...a) => console.log('[workflow-api]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

/** Call the API with the session cookie. */
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

/** A three-node chain: prompt → 出图 → 导出清单. */
const chainWorkflow = (prompt) => ({
  version: 1,
  nodes: [
    { id: 'n-text', type: 'text.input', position: { x: 0, y: 0 }, params: { text: prompt }, state: 'idle' },
    { id: 'n-image', type: 'image.generate', position: { x: 400, y: 0 }, params: { size: '768x512', count: 1 }, state: 'idle' },
    { id: 'n-export', type: 'export.manifest', position: { x: 800, y: 0 }, params: { name: 'wfx' }, state: 'idle' },
  ],
  edges: [
    { id: 'e1', from: 'n-text', fromPort: 'text', to: 'n-image', toPort: 'prompt' },
    { id: 'e2', from: 'n-image', fromPort: 'image', to: 'n-export', toPort: 'image' },
  ],
})

const stateOf = (wf, id) => wf.nodes.find((n) => n.id === id).state

const run = async () => {
  log('① 登录')
  const raw = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = (raw.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
  check('拿到会话 cookie', cookie !== '')

  log('② 节点目录')
  const catalogue = await call('/api/workflow/nodes')
  const nodes = catalogue.payload.nodes ?? []
  check('节点目录可读', catalogue.ok && nodes.length >= 15, `${nodes.length} 种`)
  const video = nodes.find((n) => n.type === 'video.generate')
  check('未配置的节点类型如实标注', video?.runnable === false && /未配置视频供应商/.test(video.unavailable ?? ''),
    String(video?.unavailable).slice(0, 40))
  check('可执行节点带端口与参数 schema',
    nodes.filter((n) => n.runnable).every((n) => Array.isArray(n.inputs) && Array.isArray(n.outputs) && typeof n.params === 'object'))

  log('③ 建项目并写入工作流')
  const project = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'DAG 引擎验收' }) })
  const projectId = project.payload.project?.id
  check('项目已创建', typeof projectId === 'string')
  const prompt = '工作流验收：废弃车站的候车厅，斜射的晨光，尘埃'
  const saved = await call(`/api/projects/${projectId}/workflow`, { method: 'PUT', body: JSON.stringify({ workflow: chainWorkflow(prompt) }) })
  check('工作流已保存', saved.ok)
  const reloaded = await call(`/api/projects/${projectId}/workflow`)
  check('工作流可读回（与画布同一份文档）', (reloaded.payload.workflow?.nodes ?? []).length === 3)

  log('④ 首次运行：必须真的调模型出图')
  const first = await call(`/api/projects/${projectId}/workflow/run`, { method: 'POST', body: '{}' })
  check('运行成功', first.ok && first.payload.problems.length === 0, JSON.stringify(first.payload.problems ?? ''))
  check('三个节点都执行了', (first.payload.executed ?? []).length === 3, String(first.payload.elapsedMs) + 'ms')
  check('耗时说明真的出了图（本地热态约 6 秒）', first.payload.elapsedMs > 2000, `${first.payload.elapsedMs}ms`)
  const imageNode = first.payload.workflow.nodes.find((n) => n.id === 'n-image')
  check('出图节点有产物', Array.isArray(imageNode.outputs?.image) && imageNode.outputs.image.length === 1,
    JSON.stringify(imageNode.outputs).slice(0, 80))
  check('导出节点拿到了素材 id', typeof first.payload.workflow.nodes.find((n) => n.id === 'n-export').outputs?.manifest?.assetId === 'string')
  check('每个节点都写了缓存键', first.payload.workflow.nodes.every((n) => typeof n.cacheKey === 'string'))

  log('⑤ 原样再运行：PRD 核心承诺——零执行、零模型调用')
  const second = await call(`/api/projects/${projectId}/workflow/run`, { method: 'POST', body: '{}' })
  check('零节点执行', (second.payload.executed ?? []).length === 0, `执行了 ${(second.payload.executed ?? []).join(',')}`)
  check('三个节点全部复用缓存', (second.payload.cached ?? []).length === 3)
  check('返回是毫秒级（对比首轮 ' + String(first.payload.elapsedMs) + 'ms）', second.payload.elapsedMs < 200,
    `${second.payload.elapsedMs}ms`)
  const speedup = Math.round(first.payload.elapsedMs / Math.max(1, second.payload.elapsedMs))
  log(`   → 第二次比第一次快约 ${speedup} 倍`)

  log('⑥ 只改提示词：整条链重跑；只改导出名：只跑它自己')
  const changedPrompt = chainWorkflow(`${prompt}（改过的提示词）`)
  // 沿用缓存键，模拟「在已有工作流上改一个参数」
  changedPrompt.nodes = changedPrompt.nodes.map((n) => {
    const previous = second.payload.workflow.nodes.find((p) => p.id === n.id)
    return { ...n, outputs: previous.outputs, cacheKey: previous.cacheKey, state: previous.state }
  })
  const third = await call(`/api/projects/${projectId}/workflow/run`, { method: 'POST', body: JSON.stringify({ workflow: changedPrompt }) })
  check('改提示词后三个节点全部重跑', (third.payload.executed ?? []).length === 3, (third.payload.executed ?? []).join(','))

  const onlyExport = chainWorkflow(`${prompt}（改过的提示词）`)
  onlyExport.nodes = onlyExport.nodes.map((n) => {
    const previous = third.payload.workflow.nodes.find((p) => p.id === n.id)
    const params = n.id === 'n-export' ? { name: 'wfx2' } : n.params
    return { ...n, params, outputs: previous.outputs, cacheKey: previous.cacheKey, state: previous.state }
  })
  const fourth = await call(`/api/projects/${projectId}/workflow/run`, { method: 'POST', body: JSON.stringify({ workflow: onlyExport }) })
  check('只改末端节点时只跑末端', (fourth.payload.executed ?? []).join(',') === 'n-export', (fourth.payload.executed ?? []).join(','))
  check('出图节点被复用（没再调模型）', (fourth.payload.cached ?? []).includes('n-image'))
  check('这一次也是毫秒级', fourth.payload.elapsedMs < 200, `${fourth.payload.elapsedMs}ms`)

  log('⑦ 环检测：非法工作流必须被拒绝，且不执行任何节点')
  const cyclic = {
    version: 1,
    nodes: [
      { id: 'a', type: 'prompt.compose', position: { x: 0, y: 0 }, params: {}, state: 'idle' },
      { id: 'b', type: 'prompt.compose', position: { x: 0, y: 0 }, params: {}, state: 'idle' },
    ],
    edges: [
      { id: 'e1', from: 'a', fromPort: 'text', to: 'b', toPort: 'base' },
      { id: 'e2', from: 'b', fromPort: 'text', to: 'a', toPort: 'base' },
    ],
  }
  const rejected = await call(`/api/projects/${projectId}/workflow/run`, { method: 'POST', body: JSON.stringify({ workflow: cyclic }) })
  check('环形依赖被拒绝（HTTP 400）', rejected.status === 400)
  check('给出了环的具体路径', /环形依赖/.test(rejected.payload.problems?.[0]?.message ?? ''), String(rejected.payload.problems?.[0]?.message).slice(0, 50))
  check('没有执行任何节点', (rejected.payload.executed ?? []).length === 0)

  log('⑧ 类型不匹配的连线必须被拒绝')
  const mismatch = {
    version: 1,
    nodes: [
      { id: 'v', type: 'video.generate', position: { x: 0, y: 0 }, params: {}, state: 'idle' },
      { id: 't', type: 'text.input', position: { x: 0, y: 0 }, params: { text: 'x' }, state: 'idle' },
    ],
    edges: [{ id: 'e1', from: 't', fromPort: 'text', to: 'v', toPort: 'image' }],
  }
  const bad = await call(`/api/projects/${projectId}/workflow/run`, { method: 'POST', body: JSON.stringify({ workflow: mismatch }) })
  check('类型不匹配被拒绝', bad.status === 400 && /类型不匹配/.test(bad.payload.problems?.[0]?.message ?? ''),
    String(bad.payload.problems?.[0]?.message).slice(0, 60))

  log('⑨ 失败隔离：视频节点没供应商，但独立分支照常完成')
  const mixed = {
    version: 1,
    nodes: [
      { id: 'txt', type: 'text.input', position: { x: 0, y: 0 }, params: { text: '一句话' }, state: 'idle' },
      { id: 'vid', type: 'video.generate', position: { x: 400, y: 0 }, params: {}, state: 'idle' },
      { id: 'sub', type: 'text.subtitle', position: { x: 0, y: 200 }, params: {}, state: 'idle' },
    ],
    edges: [
      { id: 'e1', from: 'txt', fromPort: 'text', to: 'vid', toPort: 'prompt' },
      { id: 'e2', from: 'txt', fromPort: 'text', to: 'sub', toPort: 'text' },
    ],
  }
  const mixedRun = await call(`/api/projects/${projectId}/workflow/run`, { method: 'POST', body: JSON.stringify({ workflow: mixed }) })
  check('视频节点失败', (mixedRun.payload.failed ?? []).includes('vid'))
  check('字幕分支成功（失败被隔离）', stateOf(mixedRun.payload.workflow, 'sub') === 'success')
  check('失败原因是可读的一句话', /未配置视频供应商/.test(mixedRun.payload.workflow.nodes.find((n) => n.id === 'vid').error ?? ''))

  log(failures === 0 ? '\n全部通过：真实模型上，未变更的节点确实不再调用模型' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[workflow-api] 异常:', error); process.exit(1) })
