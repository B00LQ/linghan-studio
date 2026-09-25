/**
 * 内置工作流的静态验收（视频 + 图片，全部）。
 *
 * 用法: node builtin-workflow-test.mjs [comfyuiUrl]
 *
 * 为什么要有这一条：视频工作流一次要跑十几分钟，**任何字段名写错都要等十几分钟
 * 才知道**（或者更糟：ComfyUI 直接拒绝，而人以为「视频就是慢」）。图片虽然只有几秒，
 * 但「图里少一个必填输入」这类错在画布上表现为一句含糊的失败，同样难查。
 * 所以这里在提交之前把图逐节点对着 ComfyUI 自己的 /object_info 核一遍：
 * 节点类存在吗、必填输入齐吗、枚举值在不在候选里。
 *
 * **每一份内置工作流都要过一遍。** 只验一条就等于另一条没人看着——而新加的那条
 * 恰恰最需要看着（新模型、新步数，还没跑过几次）。
 *
 * 这条不需要 Studio 容器，只需要 ComfyUI 在跑。
 */
import { loadWorkflows, resolveGraph } from './apps/server/src/workflow-library.ts'

const COMFY = process.argv[2] ?? process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'
const BUILT_IN_DIR = './apps/server/src/comfyui'
/** 内置工作流名单。新增一份要加在这里，否则它会悄悄溜过验收。 */
const EXPECTED = [
  'z-image-turbo',
  'z-image-turbo-img2img',
  'minimax-h3-video',
  'minimax-h3-video-fast',
  'minimax-h3-video-pdd',
]

let failures = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

console.log('=== 内置工作流都在 ===')
const workflows = loadWorkflows('./data-does-not-exist', BUILT_IN_DIR)
for (const id of EXPECTED) {
  const found = workflows.find((item) => item.id === id)
  check(`内置里有 ${id}`, found !== undefined, found === undefined ? workflows.map((w) => w.id).join(', ') : found.capability)
}
const builtIns = EXPECTED.map((id) => workflows.find((item) => item.id === id)).filter((item) => item !== undefined)
if (builtIns.length === 0) process.exit(1)

console.log('\n=== 逐节点对照 ComfyUI 的 /object_info ===')
let info = null
try {
  const response = await fetch(`${COMFY}/object_info`, { signal: AbortSignal.timeout(20_000) })
  info = await response.json()
  check('ComfyUI 可达', true, COMFY)
} catch (error) {
  check('ComfyUI 可达', false, `连不上 ${COMFY}：${String(error)}`)
}

/**
 * 蒸馏 LoRA 的步数。
 *
 * 从文件名里读，因为那是唯一写着的地方：`…turbo_4step_v1.0_768p…` → 4。
 * 非蒸馏（没有 turbo_Nstep）返回 0，表示「不认识」，那条不参与配对断言。
 */
const distillSteps = (workflow) => {
  const match = /turbo_(\d+)step/u.exec(String(workflow.models?.lora ?? ''))
  return match === null ? 0 : Number(match[1])
}

/** 一次「像真请求那样」的取值：defaults + 全部可选/必需输入 + 请求本身会带的那些。 */
const valuesFor = (workflow, extra = {}) => ({
  ...workflow.defaults,
  prompt: '探针提示词',
  seed: 4242,
  prefix: 'studio',
  width: 1344,
  height: 768,
  duration: 5,
  ...Object.fromEntries([...(workflow.optional ?? []), ...(workflow.requires ?? [])].map((name) => [name, `probe-${name}.png`])),
  ...extra,
})

for (const workflow of builtIns) {
  const tag = `[${workflow.id}] `
  const perKindTag = `[${workflow.id}] `
  console.log(`\n=== ${workflow.id}（${workflow.capability}）===`)
  check(`${tag}节点数 ≥ 6`, Object.keys(workflow.graph).length >= 6, String(Object.keys(workflow.graph).length))

  // 蒸馏 LoRA 和步数必须配对。4 步蒸馏跑 8 步、8 步蒸馏跑 4 步，都是**不在训练日程
  // 上**——画质会掉，而画布上看不出来（片子照样出得来，只是更糊/更抖）。这条断言
  // 存在的唯一理由就是：这种错没有任何运行时症状。
  const distill = distillSteps(workflow)
  if (distill > 0) {
    check(`${tag}步数与蒸馏配对（${String(distill)} 步 LoRA）`,
      Number(workflow.defaults.steps) === distill,
      `lora=${String(workflow.models?.lora)} steps=${String(workflow.defaults.steps)}`)
  }

  console.log(`--- ${perKindTag}占位符都有人提供 ---`)
  const declared = new Set([
    ...Object.keys(workflow.models ?? {}),
    ...Object.keys(workflow.defaults),
    // 声明为**可选**的占位符：没人给值时那条支路会被整条剪掉
    // （见 workflow-library 的 pruneOptional），所以「没有提供者」对它们是正常状态。
    ...(workflow.optional ?? []),
    // 声明为**必需**的：由画布按入边提供（图生图的参考图、图生视频的首帧），
    // 或者由 `/v1` 的调用方显式指定。
    ...(workflow.requires ?? []),
    // 驱动按请求传的
    'prompt', 'seed', 'prefix', 'width', 'height', 'steps', 'duration',
  ])
  const placeholders = new Set()
  for (const node of Object.values(workflow.graph)) {
    for (const value of Object.values(node.inputs ?? {})) {
      if (typeof value === 'string' && value.startsWith('$')) placeholders.add(value.slice(1))
    }
  }
  const orphans = [...placeholders].filter((name) => !declared.has(name))
  check(`${tag}没有无人提供的占位符`, orphans.length === 0, orphans.join(', '))
  // optional / requires 里写错一个名字（firstframe）不会有任何症状——那条支路照样被
  // 提交，只是没人剪它。所以「声明的名字必须是图里真有的占位符」要单独守一条。
  for (const name of workflow.optional ?? []) {
    check(`${tag}optional 的 ${name} 确实是图里的占位符`, placeholders.has(name), [...placeholders].join(','))
  }
  for (const name of workflow.requires ?? []) {
    check(`${tag}requires 的 ${name} 确实是图里的占位符`, placeholders.has(name), [...placeholders].join(','))
  }
  // 模型文件名要有值：这几条是「写错名字要等十几分钟才知道」的重点。
  // 蒸馏那一格按工作流**实际挂的是哪个**来查：社区 turbo 挂 `$lora`，官方 PDD 挂 `$pdd`。
  const distillKey = placeholders.has('pdd') ? 'pdd' : 'lora'
  for (const key of ['unet', 'clip', 'vae', ...(placeholders.has(distillKey) ? [distillKey] : [])]) {
    check(`${tag}$ ${key} 在 models 里有值`, typeof workflow.models?.[key] === 'string' && workflow.models[key] !== '', workflow.models?.[key])
  }

  console.log(`--- ${perKindTag}解析成可提交的图（模拟一次真实请求）---`)
  const resolved = resolveGraph(workflow, valuesFor(workflow))
  const leftover = []
  for (const [id, node] of Object.entries(resolved)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (typeof value === 'string' && value.startsWith('$')) leftover.push(`${id}.${input}=${value}`)
    }
  }
  check(`${tag}解析后没有残留的 $占位符`, leftover.length === 0, leftover.join(', '))
  // 请求本身的值要真的落进图里。逐字段找一遍，而不是认死节点 id（不同工作流 id 不同）。
  const landed = (needle) => Object.values(resolved).some((node) =>
    Object.values(node.inputs ?? {}).some((value) => value === needle))
  check(`${tag}提示词写进了图里`, landed('探针提示词'))
  check(`${tag}种子写进了图里`, landed(4242))
  check(`${tag}宽高写进了图里`, landed(1344) && landed(768))
  // 可选/必需输入要真的接上（`$ref` 解析成了文件名，而不是留在图上）。
  for (const name of [...(workflow.optional ?? []), ...(workflow.requires ?? [])]) {
    check(`${tag}「${name}」接上时真的进了图`, landed(`probe-${name}.png`), `probe-${name}.png`)
  }

  // 可选支路：不接的时候必须**整条消失**，否则 ComfyUI 会拿一个不存在的文件名
  // 在校验阶段拒掉整次生成。上面的「没有残留 $占位符」守的就是这件事，
  // 这里再单独说一遍「剪掉了哪个节点」，失败时看得懂。
  if ((workflow.optional ?? []).length > 0) {
    const bare = valuesFor(workflow)
    for (const name of workflow.optional ?? []) delete bare[name]
    const pruned = resolveGraph(workflow, bare)
    const optionalNodes = Object.entries(workflow.graph)
      .filter(([, node]) => Object.values(node.inputs ?? {}).some((value) => typeof value === 'string' && (workflow.optional ?? []).includes(value.slice(1))))
      .map(([id]) => id)
    const survivors = optionalNodes.filter((id) => pruned[id] !== undefined)
    check(`${tag}不接可选输入时那 ${String(optionalNodes.length)} 个节点被剪掉`, survivors.length === 0, survivors.join(','))
  }

  console.log(`--- ${perKindTag}视频专有：帧数约束 ---`)
  if (workflow.capability === 'video') {
    // autogrow 输入的键名是**扁平的 `values.a`**，不是嵌套字典。
    // 这一条我搞错过一次，而且方向是「本来对、看了类型定义之后改错了」：
    // `Autogrow.Type = dict[str, Any]` 说的是 execute() 收到的参数形状，
    // 框架会把所有 `values.*` 收集成那个 dict；而**提示里要给的**是扁平键。
    // 依据不是文档，是 ComfyUI 自己的校验器：它回的是
    // `required_input_missing, input_name: "values.a"`。
    check(`${tag}autogrow 用扁平键 values.a（不是嵌套字典）`,
      Array.isArray(resolved.length?.inputs['values.a']) && resolved.length.inputs.values === undefined,
      JSON.stringify({ dotted: resolved.length?.inputs['values.a'], nested: resolved.length?.inputs.values }))
    const mathValues = { a: resolved.length?.inputs['values.a'] }
    check(`${tag}values.a 指向 duration 节点`, mathValues.a?.[0] === 'duration', JSON.stringify(mathValues.a))
    check(`${tag}帧数算式还在（5+17n 的约束）`,
      typeof resolved.length?.inputs.expression === 'string' && resolved.length.inputs.expression.includes('% 17'),
      String(resolved.length?.inputs.expression))
    const expression = String(resolved.length?.inputs.expression ?? '')
    // 按**完整标识符**取变量，别用单字符匹配：我第一版用 /[a-z]/ 再剔除 'maxround'，
    // 结果把变量 a 也一起剔掉了（'maxround'.includes('a') 为真），检查空转还显示通过。
    const identifiers = [...new Set(expression.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [])]
    const FUNCTIONS = new Set(['max', 'min', 'round', 'abs', 'sum', 'int', 'float', 'floor', 'ceil', 'pow', 'sqrt'])
    const variables = identifiers.filter((name) => !FUNCTIONS.has(name))
    const uncovered = variables.filter((name) => mathValues[name] === undefined)
    check(`${tag}算式里确实用到了变量（不是空检查）`, variables.length > 0, variables.join(','))
    check(`${tag}算式变量没有漏提供的`, uncovered.length === 0, `用到 ${variables.join(',')}；缺 ${uncovered.join(',')}`)
  }

  if (info === null) continue
  for (const [id, node] of Object.entries(resolved)) {
    const schema = info[node.class_type]
    if (schema === undefined) {
      check(`${tag}节点类存在：${node.class_type}`, false, `#${id} 不在 /object_info 里`)
      continue
    }
    const required = Object.keys(schema.input?.required ?? {})
    const inputs = node.inputs ?? {}
    // ComfyUI 的校验器认的是**扁平键**：autogrow 输入 `values` 要写成 `values.a`，
    // 而不是 `values: {a: …}`。所以「必填输入在不在」要按这个规则判
    // （我第一版按嵌套字典判，于是把对的写法判成错的、把错的判成对的）。
    const missing = required.filter((name) => {
      if (name in inputs) return false
      const spec = schema.input.required[name]
      const isAutogrow = Array.isArray(spec) && spec[0] === 'COMFY_AUTOGROW_V3'
      return isAutogrow ? !Object.keys(inputs).some((key) => key.startsWith(`${name}.`)) : true
    })
    if (missing.length > 0) {
      check(`${tag}#${id} ${node.class_type} 必填输入齐`, false, `缺 ${missing.join(', ')}`)
      continue
    }
    // 枚举值：给了标量才检查，连接跳过。
    const wrong = []
    for (const [input, value] of Object.entries(inputs)) {
      const spec = schema.input?.required?.[input] ?? schema.input?.optional?.[input]
      if (!Array.isArray(spec) || !Array.isArray(spec[0])) continue
      if (Array.isArray(value)) continue
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const options = spec[0]
      // 枚举是**动态**的两种要跳过：
      // ① SaveVideo 的 format 这类，候选里带对象；
      // ② LoadImage 的 image —— 它列的是 ComfyUI input 目录里现有的文件，而我们那个
      //    文件名要等驱动**上传之后**才存在（上传先于提交，见 comfyui.ts 的 uploadImage），
      //    静态测试比不了。判据是它自己的 `image_upload` 标记，不是猜。
      if (options.some((item) => typeof item === 'object')) continue
      if (Array.isArray(spec[1]) === false && spec[1]?.image_upload === true) continue
      if (!options.includes(value)) wrong.push(`${input}=${JSON.stringify(value)}`)
    }
    check(`${tag}#${id} ${node.class_type}`, wrong.length === 0, wrong.length === 0 ? '' : `枚举值不在候选里：${wrong.join(', ')}`)
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
