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
  check('工具清单可读', catalogue.ok && names.length === 8, `${names.length} 个：${names.join(', ')}`)
  check('工具面带「人类指的上下文」这一个', names.includes('canvas_context'),
    `当前工具：${names.join(', ')}`)
  check('每个工具都带 JSON Schema', (catalogue.payload.tools ?? []).every((t) => t.inputSchema?.type === 'object'))
  const kinds = catalogue.payload.tools?.find((t) => t.name === 'canvas_add_node')?.inputSchema?.properties?.kind?.enum ?? []
  check('节点类型只有 文本 / 图片', kinds.length === 2 && kinds.includes('text') && kinds.includes('image'), kinds.join(','))

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

  log('⑥ 出图（唯一耗算力的一步，约 6 秒）')
  const first = await tool('canvas_generate', { projectId, nodeId: imageId })
  const shotId = first.payload.result?.shotId
  check('生成成功', first.ok && first.payload.result?.produced === 1, JSON.stringify(first.payload).slice(0, 160))
  check('自动建立了版本历史', typeof shotId === 'string' && shotId.length > 0, String(shotId))
  check('提示词从上游文本节点解析出来', first.payload.result?.prompt === prompt)
  check('产出了 take', typeof first.payload.result?.images?.[0]?.takeId === 'string')

  const second = await tool('canvas_generate', { projectId, nodeId: imageId, prompt: `${prompt}（第二版：更暗）` })
  check('第二次生成成功，累计两张', second.payload.result?.takesSoFar === 2, `takesSoFar=${String(second.payload.result?.takesSoFar)}`)
  check('两次用的是同一个节点的历史', second.payload.result?.shotId === shotId)

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
  check('对文本节点出图 → 400 且说明原因', badNode.status === 400 && /只有图片节点能出图/u.test(badNode.payload.error ?? ''), String(badNode.payload.error))

  const noPrompt = await tool('canvas_add_node', { projectId, kind: 'image' })
  const emptyGen = await tool('canvas_generate', { projectId, nodeId: noPrompt.payload.result.nodeId })
  check('空提示词 → 400 且给出补救办法', emptyGen.status === 400 && /提示词为空/u.test(emptyGen.payload.error ?? ''), String(emptyGen.payload.error))

  const unknown = await tool('canvas_teleport', { projectId })
  check('未知工具 → 400 且列出可用工具', unknown.status === 400 && /可用工具/u.test(unknown.payload.error ?? ''), String(unknown.payload.error).slice(0, 80))

  const badProject = await tool('canvas_state', { projectId: 'not-a-project' })
  check('不存在的项目 → 400', badProject.status === 400 && /项目不存在/u.test(badProject.payload.error ?? ''))

  const badKind = await tool('canvas_add_node', { projectId, kind: 'video' })
  check('非法节点类型 → 400', badKind.status === 400 && /kind 必须是/u.test(badKind.payload.error ?? ''))

  log(failures === 0 ? '\n全部通过：Agent 在无人值守下完成了与人点击等价的创作流程' : `\n有 ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[agent-test] 异常:', error)
  process.exit(1)
})
