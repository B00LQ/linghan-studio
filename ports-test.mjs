/**
 * 端口与画布文档的单元验收（纯函数，不需要容器、不需要浏览器）。
 *
 * 用法: node ports-test.mjs
 *
 * 为什么要有这一条：图生视频把「端口」这件事**从画布带到了服务端**——
 * ① 服务端要替 Agent 建连线，而 Agent 没有端口这个概念；
 * ② 服务端要按入边找到「首帧是哪张图」；
 * ③ 工作流要能在没有首帧时把那条支路整条剪掉。
 *
 * 这三件事都在**看不见的地方**：错了不会崩，只会「连了线却没生效」或者
 * 「提交了一个不存在的文件名」。所以在这里逐条钉住，用内存里的文档，不碰显卡。
 */
import { CONNECTABLE_PORTS, TARGET_PORT_BY_KIND, inboundAssetUrl, resolvePrompt } from './apps/server/src/ops.ts'
import { CANVAS_NODES } from './apps/web/src/canvas/ports.ts'
import { loadWorkflows, resolveGraph } from './apps/server/src/workflow-library.ts'

let failures = 0
const log = (...a) => console.log('[ports]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

/** A document with one node, for the smaller cases. */
const doc = (nodes, edges = []) => ({ nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } })
const node = (id, kind, data = {}) => ({ id, type: 'studio', position: { x: 0, y: 0 }, data: { kind, ...data } })
const edge = (id, source, target, targetHandle) => ({
  id, source, target, ...(targetHandle === undefined ? {} : { targetHandle }),
})

log('① 服务端的「按类型选入口」必须与前端端口目录一致')
// 这条是防漂移：两边各写一份，迟早会有一边改了名字而没人发现。改错的方向很具体——
// Agent 把图片接到视频节点上会落到第一个入边（提示词）上，成为一条不生效的线。
//
// **而且必须按两头一起判**：图片接到视频上是「首帧」，接到图片上却是「参考图」。
// 只按上游类型那张表分不出这两种。
for (const [sourceKind, byTarget] of Object.entries(TARGET_PORT_BY_KIND)) {
  for (const [targetKind, handle] of Object.entries(byTarget)) {
    const spec = CANVAS_NODES.find((item) => item.kind === targetKind)
    const input = spec?.inputs.find((item) => item.id === handle)
    check(`${sourceKind} 接到 ${targetKind} 上落到「${String(handle)}」且类型对得上`,
      input !== undefined && input.kind === sourceKind,
      input === undefined ? `节点 ${targetKind} 没有 ${String(handle)} 入口` : `${targetKind}:${input.id}=${input.kind}`)
  }
}
// 反过来：每个节点的图片/文本入边都得有一张「谁往这儿接」的票，否则 Agent 根本连不上它。
// 票有两种：按类型自动选的（TARGET_PORT_BY_KIND），以及显式点名的（CONNECTABLE_PORTS，
// 「尾帧」就是这一种——它没有默认值）。
const reachable = new Set([
  ...Object.values(TARGET_PORT_BY_KIND).flatMap((byTarget) => Object.values(byTarget)),
  ...CONNECTABLE_PORTS,
])
for (const spec of CANVAS_NODES) {
  for (const input of spec.inputs) {
    if (input.kind !== 'image' && input.kind !== 'text') continue
    check(`${spec.kind} 的「${input.label}」入边有人能接`, reachable.has(input.id), [...reachable].join(','))
  }
}
// 反向也要守：能点名的端口必须真的存在于某个节点上，否则枚举里会多出一个死名字。
for (const port of CONNECTABLE_PORTS) {
  check(`可点名的 ${port} 确实是某个节点的入边`,
    CANVAS_NODES.some((spec) => spec.inputs.some((input) => input.id === port)),
    CANVAS_NODES.flatMap((spec) => spec.inputs.map((input) => `${spec.kind}:${input.id}`)).join(','))
}
// 内置工作流声明「必须要」的输入，必须是画布上真有的端口——写错一个名字的症状是
// 「生成永远被拒绝」，而人怎么也看不出哪里错了。
const builtIns = loadWorkflows('./data-does-not-exist', './apps/server/src/comfyui')
for (const workflow of builtIns) {
  for (const name of workflow.requires ?? []) {
    check(`${workflow.id} 要求的「${name}」是画布上的端口`,
      CANVAS_NODES.some((spec) => spec.inputs.some((input) => input.id === name)),
      CANVAS_NODES.flatMap((spec) => spec.inputs.map((input) => input.id)).join(','))
  }
  // optional 与 requires 不能指的是同一个名字：一个说「没人给就剪掉」，
  // 一个说「没人给就别跑」，同时声明等于自相矛盾。
  for (const name of workflow.requires ?? []) {
    check(`${workflow.id} 的「${name}」没被同时声明为 optional`, !(workflow.optional ?? []).includes(name))
  }
}

log('② 首帧/尾帧：从入边找到那张图')
const pickDoc = doc([
  node('img-1', 'image', { url: '/api/assets/aaa' }),
  node('img-2', 'image', { url: '/api/assets/bbb' }),
  node('img-empty', 'image', { url: '' }),
  node('txt-1', 'text', { text: '雨夜霓虹' }),
  node('vid-1', 'video', { url: '' }),
], [
  edge('e1', 'img-1', 'vid-1', 'first'),
  edge('e2', 'img-2', 'vid-1', 'last'),
])
check('first 取到对应那张图', inboundAssetUrl(pickDoc, 'vid-1', 'first') === '/api/assets/aaa', inboundAssetUrl(pickDoc, 'vid-1', 'first'))
check('last 取到另一张', inboundAssetUrl(pickDoc, 'vid-1', 'last') === '/api/assets/bbb', inboundAssetUrl(pickDoc, 'vid-1', 'last'))
check('没接的那个是空的', inboundAssetUrl(pickDoc, 'vid-1', 'first').length > 0 && inboundAssetUrl(pickDoc, 'img-1', 'first') === '')

const twice = doc([
  node('img-a', 'image', { url: '/api/assets/old' }),
  node('img-b', 'image', { url: '/api/assets/new' }),
  node('vid-2', 'video', {}),
], [edge('e1', 'img-a', 'vid-2', 'first'), edge('e2', 'img-b', 'vid-2', 'first')])
check('同一个口上接了两条时取最后一条（后连的是最新意图）',
  inboundAssetUrl(twice, 'vid-2', 'first') === '/api/assets/new', inboundAssetUrl(twice, 'vid-2', 'first'))

const noUrl = doc([
  node('img-empty', 'image', { url: '' }),
  node('vid-3', 'video', {}),
], [edge('e1', 'img-empty', 'vid-3', 'first')])
check('上游还没出图时当作「没有首帧」', inboundAssetUrl(noUrl, 'vid-3', 'first') === '')

// Agent 建的边没有 handle（它的 canvas_connect 现在会补，但旧文档里没有），
// 所以「没有 handle」也必须能被首帧认出来——判据是上游有没有画面，不是边长什么样。
const legacy = doc([
  node('img-1', 'image', { url: '/api/assets/legacy' }),
  node('vid-4', 'video', {}),
], [edge('e1', 'img-1', 'vid-4')])
check('没有 handle 的旧边也算候选', inboundAssetUrl(legacy, 'vid-4', 'first') === '/api/assets/legacy', inboundAssetUrl(legacy, 'vid-4', 'first'))
const legacyText = doc([
  node('txt-1', 'text', { text: 'x' }),
  node('vid-5', 'video', {}),
], [edge('e1', 'txt-1', 'vid-5')])
check('接到视频上的文本不会被当成首帧', inboundAssetUrl(legacyText, 'vid-5', 'first') === '')

log('③ 提示词只认文本那条入边（视频节点现在还有图片入边）')
const promptDoc = doc([
  node('txt-1', 'text', { text: '雨夜霓虹街头' }),
  node('img-1', 'image', { url: '/api/assets/aaa' }),
  node('vid-6', 'video', {}),
], [
  // 故意让图片那条**排在前面**：从前「取第一条入边」的实现会因此读不到文本。
  edge('e1', 'img-1', 'vid-6', 'first'),
  edge('e2', 'txt-1', 'vid-6', 'prompt'),
])
check('接了首帧之后仍然读得到上游文本',
  resolvePrompt(promptDoc, promptDoc.nodes[2]) === '雨夜霓虹街头', resolvePrompt(promptDoc, promptDoc.nodes[2]))
check('只有图片入边时提示词是空的', resolvePrompt(doc([
  node('img-1', 'image', { url: '/api/assets/aaa' }),
  node('vid-7', 'video', {}),
], [edge('e1', 'img-1', 'vid-7', 'first')]), { id: 'vid-7', data: { kind: 'video' } }) === '')
check('节点自己的文本优先', resolvePrompt(promptDoc, { id: 'x', data: { kind: 'video', text: '自己写的' } }) === '自己写的')

log('④ 可选支路：没人给值就整条剪掉（首帧不接时不能提交 LoadImage）')
const workflow = {
  id: 'probe', title: 'probe', capability: 'video', source: '', requiredNodes: [],
  defaults: { width: 8, height: 8 },
  models: {},
  optional: ['firstFrame', 'lastFrame'],
  bindings: {},
  graph: {
    loadFirst: { class_type: 'LoadImage', inputs: { image: '$firstFrame' } },
    loadLast: { class_type: 'LoadImage', inputs: { image: '$lastFrame' } },
    consumer: { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '$prompt', first_frame: ['loadFirst', 0], last_frame: ['loadLast', 0], width: '$width' } },
  },
}
const pruned = resolveGraph(workflow, { ...workflow.defaults, prompt: 'x' })
check('没有首帧时不提交 LoadImage', pruned.loadFirst === undefined && pruned.loadLast === undefined, Object.keys(pruned).join(','))
check('指向它的连线也一起没了', pruned.consumer.inputs.first_frame === undefined && pruned.consumer.inputs.last_frame === undefined,
  JSON.stringify(pruned.consumer.inputs))
check('其余输入原样在', pruned.consumer.inputs.prompt === 'x' && pruned.consumer.inputs.width === 8, JSON.stringify(pruned.consumer.inputs))
const framed = resolveGraph(workflow, { ...workflow.defaults, prompt: 'x', firstFrame: 'up.png' })
check('给了首帧就带上，且尾帧那条仍然没有',
  framed.loadFirst?.inputs.image === 'up.png' && framed.consumer.inputs.first_frame?.[0] === 'loadFirst' && framed.loadLast === undefined,
  JSON.stringify({ loadFirst: framed.loadFirst, loadLast: framed.loadLast }))
// 没声明成 optional 的占位符不能被剪：那会变成「悄悄少跑一个节点」，比报错难查得多。
const notOptional = { ...workflow, optional: [] }
const kept = resolveGraph(notOptional, { ...notOptional.defaults, prompt: 'x' })
check('没声明 optional 的占位符不会被剪掉（宁可让 ComfyUI 报错）',
  kept.loadFirst?.inputs.image === '$firstFrame', JSON.stringify(kept.loadFirst?.inputs))

log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
