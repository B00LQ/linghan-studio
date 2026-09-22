/**
 * DAG 引擎验收：惰性调度、缓存复用、环检测、失败隔离、规模。
 *
 * 用法: node workflow-engine-test.mjs
 *
 * 引擎不依赖任何模型，所以这里**完全不联网、不出图**——用假的执行器精确计数
 * 「某个节点到底有没有被执行」。PRD 最核心的那条承诺是
 * 「参数无变更、上游输入无变更，直接命中缓存，跳过模型推理」，
 * 那就必须能数出「模型调用次数」，而不是靠感觉说变快了。
 *
 * 直接跑 TS：Node 的类型剥离会抹掉 `import type`，服务端模块本身没有编译产物依赖。
 */
import { createRegistry, port } from './apps/server/src/workflow/registry.ts'
import { runWorkflow } from './apps/server/src/workflow/scheduler.ts'
import { validateGraph, withDownstream, dirtyNodes, cacheKeysOf } from './apps/server/src/workflow/graph.ts'

let failures = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

/** Counts executions per node, so cache reuse is measured rather than assumed. */
const calls = new Map()
const bump = (id) => calls.set(id, (calls.get(id) ?? 0) + 1)
const callCount = (id) => calls.get(id) ?? 0
const resetCalls = () => calls.clear()

/** A registry with deterministic fake executors. */
const registry = createRegistry([
  {
    type: 'src', category: 'input', title: '源',
    inputs: [], outputs: [port('text', 'text')], params: { text: 'hello' },
    run: async ({ node, }) => { bump(node.id); return { text: String(node.params.text) } },
  },
  {
    type: 'upper', category: 'generate', title: '转大写',
    inputs: [port('text', 'text', true)], outputs: [port('text', 'text')], params: {},
    run: async ({ node, inputs }) => { bump(node.id); await new Promise((r) => setTimeout(r, 5)); return { text: String(inputs.text).toUpperCase() } },
  },
  {
    type: 'wrap', category: 'post', title: '加壳',
    inputs: [port('text', 'text', true)], outputs: [port('text', 'text')], params: { tag: 'x' },
    run: async ({ node, inputs }) => { bump(node.id); return { text: `[${String(node.params.tag)}]${String(inputs.text)}` } },
  },
  {
    type: 'boom', category: 'generate', title: '必失败',
    inputs: [port('text', 'text', false)], outputs: [port('text', 'text')], params: {},
    run: async ({ node }) => { bump(node.id); throw new Error('故意失败') },
  },
  {
    type: 'slowimage', category: 'generate', title: '假出图',
    inputs: [port('text', 'text', true)], outputs: [port('image', 'image')], params: {},
    run: async ({ node, inputs }) => { bump(node.id); return { image: { assetId: `asset-${node.id}`, url: '/x.png', from: inputs.text } } },
  },
  {
    // 无人工延时：规模测试要量的是引擎本身，不是假执行器的 sleep。
    type: 'noop', category: 'post', title: '空转',
    inputs: [port('text', 'text', false)], outputs: [port('text', 'text')], params: {},
    run: async ({ node, inputs }) => { bump(node.id); return { text: String(inputs.text ?? '') } },
  },
])

const node = (id, type, params = {}) => ({ id, type, position: { x: 0, y: 0 }, params, state: 'idle' })
const edge = (from, to, fromPort = 'text', toPort = 'text') => ({ id: `${from}->${to}`, from, fromPort, to, toPort })

/** Chain: src → upper → wrap */
const chain = () => ({
  version: 1,
  nodes: [node('s', 'src', { text: 'hello' }), node('u', 'upper'), node('w', 'wrap', { tag: 'T' })],
  edges: [edge('s', 'u'), edge('u', 'w')],
})

console.log('=== 1. DAG 合法性 ===')
{
  const cyclic = { version: 1, nodes: [node('a', 'upper'), node('b', 'upper')], edges: [edge('a', 'b'), edge('b', 'a')] }
  const problems = validateGraph(cyclic, registry.info)
  check('检测出环形依赖', problems.some((p) => p.kind === 'cycle'), problems.find((p) => p.kind === 'cycle')?.message ?? '')

  const mismatch = { version: 1, nodes: [node('s', 'src'), node('u', 'upper')], edges: [edge('s', 'u', 'text', 'text')] }
  check('合法连线无问题', validateGraph(mismatch, registry.info).length === 0)

  const wrongPort = { version: 1, nodes: [node('s', 'src'), node('u', 'upper')], edges: [edge('s', 'u', 'text', 'nope')] }
  check('端口不存在被拒绝', validateGraph(wrongPort, registry.info).some((p) => p.kind === 'missing-port'))

  const unknown = { version: 1, nodes: [node('z', 'nope')], edges: [] }
  check('未知节点类型被拒绝', validateGraph(unknown, registry.info).some((p) => p.kind === 'unknown-type'))

  const dangling = { version: 1, nodes: [node('s', 'src')], edges: [edge('s', 'ghost')] }
  check('悬空连线被拒绝', validateGraph(dangling, registry.info).some((p) => p.kind === 'dangling-edge'))
}

console.log('\n=== 2. 首次运行：全部执行 ===')
resetCalls()
let wf = chain()
let summary = await runWorkflow(wf, { registry })
check('三个节点都执行了', summary.executed.length === 3, summary.executed.join(','))
check('没有失败', summary.failed.length === 0)
check('结果正确传递', summary.workflow.nodes.find((n) => n.id === 'w').outputs.text === '[T]HELLO',
  String(summary.workflow.nodes.find((n) => n.id === 'w').outputs.text))
check('每个节点都被调用一次', callCount('s') === 1 && callCount('u') === 1 && callCount('w') === 1,
  `s=${callCount('s')} u=${callCount('u')} w=${callCount('w')}`)

console.log('\n=== 3. 原样再跑：必须全部命中缓存（PRD 核心承诺）===')
resetCalls()
wf = summary.workflow
summary = await runWorkflow(wf, { registry })
check('没有任何节点被执行', summary.executed.length === 0, summary.executed.join(','))
check('三个节点全部复用缓存', summary.cached.length === 3, summary.cached.join(','))
check('执行器调用次数为 0（真的没碰模型）', [...calls.values()].reduce((a, b) => a + b, 0) === 0,
  `调用 ${[...calls.values()].reduce((a, b) => a + b, 0)} 次`)

console.log('\n=== 4. 改末端节点：只重跑它自己 ===')
resetCalls()
wf = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'w' ? { ...n, params: { tag: 'NEW' } } : n)) }
summary = await runWorkflow(wf, { registry })
check('只执行了末端节点', summary.executed.length === 1 && summary.executed[0] === 'w', summary.executed.join(','))
check('上游被复用', summary.cached.includes('s') && summary.cached.includes('u'), summary.cached.join(','))
check('上游执行器没被调用', callCount('s') === 0 && callCount('u') === 0)
check('结果已更新', summary.workflow.nodes.find((n) => n.id === 'w').outputs.text === '[NEW]HELLO')

console.log('\n=== 5. 改中游节点：它自己 + 全部下游重跑，上游不动 ===')
resetCalls()
wf = summary.workflow
wf = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'u' ? { ...n, params: { ...n.params, force: 1 } } : n)) }
summary = await runWorkflow(wf, { registry })
check('执行了中游与下游', summary.executed.sort().join(',') === 'u,w', summary.executed.join(','))
check('最上游复用缓存', summary.cached.join(',') === 's', summary.cached.join(','))
check('最上游执行器没被调用', callCount('s') === 0, `s=${callCount('s')}`)

console.log('\n=== 6. 改上游：整条链重跑 ===')
resetCalls()
wf = summary.workflow
wf = { ...wf, nodes: wf.nodes.map((n) => (n.id === 's' ? { ...n, params: { text: 'changed' } } : n)) }
summary = await runWorkflow(wf, { registry })
check('三个节点全部重跑', summary.executed.length === 3, summary.executed.join(','))
check('结果贯穿到末端', summary.workflow.nodes.find((n) => n.id === 'w').outputs.text === '[NEW]CHANGED')

console.log('\n=== 7. 失败隔离：一条分支挂掉，另一条照常跑完 ===')
resetCalls()
const branched = {
  version: 1,
  nodes: [node('s', 'src'), node('bad', 'boom'), node('good', 'upper'), node('after-bad', 'wrap', { tag: 'B' }), node('after-good', 'wrap', { tag: 'G' })],
  edges: [edge('s', 'bad'), edge('bad', 'after-bad'), edge('s', 'good'), edge('good', 'after-good')],
}
summary = await runWorkflow(branched, { registry })
const stateOf = (id) => summary.workflow.nodes.find((n) => n.id === id).state
check('失败节点被标记 failed', stateOf('bad') === 'failed', String(summary.workflow.nodes.find((n) => n.id === 'bad').error))
check('它的下游被标记 blocked（而不是永远等在那）', stateOf('after-bad') === 'blocked')
check('独立分支照常成功', stateOf('good') === 'success' && stateOf('after-good') === 'success')
check('失败不影响其它分支的执行', summary.executed.includes('good') && summary.executed.includes('after-good'))
check('blocked 的下游没有被执行', !summary.executed.includes('after-bad'))

console.log('\n=== 8. 禁用节点不参与调度 ===')
resetCalls()
const withDisabled = {
  version: 1,
  nodes: [node('s', 'src'), { ...node('u', 'upper'), disabled: true }, node('w', 'wrap', { tag: 'T' })],
  edges: [edge('s', 'u'), edge('u', 'w')],
}
summary = await runWorkflow(withDisabled, { registry })
check('禁用节点不被执行', !summary.executed.includes('u') && summary.disabled.includes('u'))
check('依赖它的下游被阻塞', summary.workflow.nodes.find((n) => n.id === 'w').state === 'blocked')

console.log('\n=== 9. 未配置供应商的节点给出明确原因，而不是含糊失败 ===')
{
  const { createStudioRegistry } = await import('./apps/server/src/workflow/nodes.ts')
  const studio = createStudioRegistry({
    renderImage: async () => [{ url: '/x.png', assetId: 'a1' }],
    saveText: () => ({ assetId: 'a2' }),
    log: () => {},
  })
  const video = { version: 1, nodes: [node('v', 'video.generate')], edges: [] }
  const result = await runWorkflow(video, { registry: studio })
  const error = result.workflow.nodes.find((n) => n.id === 'v').error ?? ''
  check('视频节点明确说缺什么', /未配置视频供应商/.test(error), error)
  check('节点类型完整注册（≥15 种）', studio.all().length >= 15, `${studio.all().length} 种`)
  const runnable = studio.all().filter((s) => s.run !== undefined).length
  check('其中一部分现在就能跑', runnable >= 8, `${runnable} 种可执行`)
}

console.log('\n=== 10. 规模：200 节点 ===')
{
  resetCalls()
  const nodes = []
  const edges = []
  for (let i = 0; i < 200; i += 1) {
    nodes.push(node(`n${i}`, i === 0 ? 'src' : 'noop'))
    if (i > 0) edges.push(edge(`n${i - 1}`, `n${i}`))
  }
  const big = { version: 1, nodes, edges }
  const started = Date.now()
  const first = await runWorkflow(big, { registry })
  const firstMs = Date.now() - started
  check('200 节点全部执行成功', first.executed.length === 200 && first.failed.length === 0, `${firstMs}ms`)

  resetCalls()
  const started2 = Date.now()
  const second = await runWorkflow(first.workflow, { registry })
  const secondMs = Date.now() - started2
  check('原样重跑全部命中缓存', second.cached.length === 200 && second.executed.length === 0)
  check('零模型调用', [...calls.values()].reduce((a, b) => a + b, 0) === 0)
  check('缓存重跑是秒级以下', secondMs < 1000, `${secondMs}ms（相对首轮 ${firstMs}ms）`)

  resetCalls()
  const started3 = Date.now()
  const changed = { ...first.workflow, nodes: first.workflow.nodes.map((n, i) => (i === 100 ? { ...n, params: { ...n.params, tweak: 1 } } : n)) }
  const third = await runWorkflow(changed, { registry })
  const thirdMs = Date.now() - started3
  // 第 100 个节点变了 → 它自己 + 后面 99 个下游；前 100 个必须原样复用
  check('只重跑中游及其下游（100 个）', third.executed.length === 100, `执行 ${third.executed.length}`)
  check('前 100 个节点全部复用缓存', third.cached.length === 100, `复用 ${third.cached.length}`)
  check('局部更新显著快于全量首轮', thirdMs < firstMs, `${thirdMs}ms vs 全量 ${firstMs}ms`)
}

console.log('\n=== 11. 依赖集合计算 ===')
{
  const wf2 = { version: 1, nodes: [node('a', 'src'), node('b', 'upper'), node('c', 'wrap'), node('d', 'wrap')], edges: [edge('a', 'b'), edge('b', 'c'), edge('b', 'd')] }
  const affected = withDownstream(wf2, ['b'])
  check('下游传播包含自身', affected.has('b') && affected.has('c') && affected.has('d'))
  check('不包含无关上游', !affected.has('a'))
  const dirty = dirtyNodes({ ...wf2, nodes: wf2.nodes.map((n) => ({ ...n, state: 'success' })) }, { only: ['c'] })
  check('指定节点只影响它自己（无下游）', dirty.size === 1 && dirty.has('c'))
  check('缓存键稳定（同内容同键）', cacheKeysOf(wf2).get('c') === cacheKeysOf(wf2).get('d'),
    '两个 wrap 节点参数与上游相同，键应一致')
}

console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
