/**
 * MiniMax H3 视频工作流的静态验收。
 *
 * 用法: node minimax-workflow-test.mjs [comfyuiUrl]
 *
 * 为什么要有这一条：这套工作流一次要跑十几分钟，**任何字段名写错都要等十几分钟
 * 才知道**（或者更糟：ComfyUI 直接拒绝，而人以为「视频就是慢」）。所以这里在提交
 * 之前把图逐节点对着 ComfyUI 自己的 /object_info 核一遍：
 * 节点类存在吗、必填输入齐吗、枚举值在不在候选里。
 *
 * **每一份内置视频工作流都要过一遍。** 加了「4 步加速」这条之后，只验一条就等于
 * 另一条没人看着——而它恰恰是最需要看着的那条（新蒸馏、新步数，还没跑过几次）。
 *
 * 这条不需要 Studio 容器，只需要 ComfyUI 在跑。
 */
import { loadWorkflows, resolveGraph } from './apps/server/src/workflow-library.ts'

const COMFY = process.argv[2] ?? process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'
const BUILT_IN_DIR = './apps/server/src/comfyui'
/** 内置视频工作流名单。新增一份要加在这里，否则它会悄悄溜过验收。 */
const EXPECTED = ['minimax-h3-video', 'minimax-h3-video-fast', 'minimax-h3-video-pdd']

let failures = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

console.log('=== 内置视频工作流都在 ===')
const workflows = loadWorkflows('./data-does-not-exist', BUILT_IN_DIR)
const videos = workflows.filter((item) => item.capability === 'video')
check('至少有一份视频工作流', videos.length > 0, workflows.map((w) => `${w.id}(${w.capability})`).join(', '))
for (const id of EXPECTED) {
  check(`内置里有 ${id}`, videos.some((item) => item.id === id))
}
if (videos.length === 0) process.exit(1)

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

for (const video of videos) {
  const tag = `[${video.id}] `
  console.log(`\n=== ${video.id} ===`)
  check(`${tag}capability 是 video`, video.capability === 'video', video.capability)
  check(`${tag}节点数 ≥ 15`, Object.keys(video.graph).length >= 15, String(Object.keys(video.graph).length))

  // 蒸馏 LoRA 和步数必须配对。4 步蒸馏跑 8 步、8 步蒸馏跑 4 步，都是**不在训练日程
  // 上**——画质会掉，而画布上看不出来（片子照样出得来，只是更糊/更抖）。这条断言
  // 存在的唯一理由就是：这种错没有任何运行时症状。
  const distill = distillSteps(video)
  if (distill > 0) {
    check(`${tag}步数与蒸馏配对（${String(distill)} 步 LoRA）`,
      Number(video.defaults.steps) === distill,
      `lora=${String(video.models?.lora)} steps=${String(video.defaults.steps)}`)
  }

  console.log(`\n--- ${video.id}：占位符都有人提供 ---`)
  const declared = new Set([
    ...Object.keys(video.models ?? {}),
    ...Object.keys(video.defaults),
    // 声明为**可选**的占位符（图生视频的首帧/尾帧）：没人给值时那条支路会被整条剪掉
    // （见 workflow-library 的 pruneOptional），所以「没有提供者」对它们是正常状态。
    ...(video.optional ?? []),
    // 驱动按请求传的
    'prompt', 'seed', 'prefix', 'width', 'height', 'steps', 'duration',
  ])
  const placeholders = new Set()
  for (const node of Object.values(video.graph)) {
    for (const value of Object.values(node.inputs ?? {})) {
      if (typeof value === 'string' && value.startsWith('$')) placeholders.add(value.slice(1))
    }
  }
  const orphans = [...placeholders].filter((name) => !declared.has(name))
  check(`${tag}没有无人提供的占位符`, orphans.length === 0, orphans.join(', '))
  // optional 里写错一个名字（firstframe）不会有任何症状——那条支路照样被提交，
  // 只是没人剪它。所以「声明的可选名必须是图里真有的占位符」要单独守一条。
  for (const name of video.optional ?? []) {
    check(`${tag}optional 的 ${name} 确实是图里的占位符`, placeholders.has(name), [...placeholders].join(','))
  }
  // 这条要单独说：模型文件名写错的话 ComfyUI 会报「缺模型」，
  // 但那是运行时的报错；这里保证的是「名字确实来自 models 段」。
  // 蒸馏那一格按工作流**实际挂的是哪个**来查：社区 turbo 那份挂 `$lora`，
  // 官方 PDD 那份挂的是 `$pdd`（两者不能共存，见 PDD 那份的 source）。
  const distillKey = placeholders.has('pdd') ? 'pdd' : 'lora'
  for (const key of ['unet', 'clip', 'vae', 'audioVae', distillKey]) {
    check(`${tag}$ ${key} 在 models 里有值`, typeof video.models?.[key] === 'string' && video.models[key] !== '', video.models?.[key])
  }

  console.log(`\n--- ${video.id}：解析成可提交的图（模拟一次真实请求）---`)
  const resolved = resolveGraph(video, {
    ...video.defaults,
    prompt: '探针提示词',
    seed: 4242,
    prefix: 'studio',
    width: 1344,
    height: 768,
    duration: 5,
  })
  const leftover = []
  for (const [id, node] of Object.entries(resolved)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (typeof value === 'string' && value.startsWith('$')) leftover.push(`${id}.${input}=${value}`)
    }
  }
  check(`${tag}解析后没有残留的 $占位符`, leftover.length === 0, leftover.join(', '))
  check(`${tag}种子被写进 RandomNoise`, resolved.noise?.inputs.noise_seed === 4242, String(resolved.noise?.inputs.noise_seed))
  check(`${tag}提示词被写进 MiniMaxH3ImageToVideo`, resolved.i2v?.inputs.prompt === '探针提示词')
  check(`${tag}宽高被写进 MiniMaxH3ImageToVideo`, resolved.i2v?.inputs.width === 1344 && resolved.i2v?.inputs.height === 768)
  check(`${tag}时长交给了算式节点而不是直接当帧数`,
    resolved.duration?.inputs.value === 5 && typeof resolved.i2v?.inputs.length === 'object',
    JSON.stringify(resolved.i2v?.inputs.length))
  check(`${tag}帧数算式还在（5+17n 的约束）`,
    typeof resolved.length?.inputs.expression === 'string' && resolved.length.inputs.expression.includes('% 17'),
    String(resolved.length?.inputs.expression))
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
  check(`${tag}values.a 指向 duration 节点`,
    mathValues.a?.[0] === 'duration', JSON.stringify(mathValues.a))
  const expression = String(resolved.length?.inputs.expression ?? '')
  // 按**完整标识符**取变量，别用单字符匹配：我第一版用 /[a-z]/ 再剔除 'maxround'，
  // 结果把变量 a 也一起剔掉了（'maxround'.includes('a') 为真），检查空转还显示通过。
  const identifiers = [...new Set(expression.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [])]
  const FUNCTIONS = new Set(['max', 'min', 'round', 'abs', 'sum', 'int', 'float', 'floor', 'ceil', 'pow', 'sqrt'])
  const variables = identifiers.filter((name) => !FUNCTIONS.has(name))
  const uncovered = variables.filter((name) => mathValues[name] === undefined)
  check(`${tag}算式里确实用到了变量（不是空检查）`, variables.length > 0, variables.join(','))
  check(`${tag}算式变量没有漏提供的`, uncovered.length === 0, `用到 ${variables.join(',')}；缺 ${uncovered.join(',')}`)

  // 可选支路（图生视频的首帧/尾帧）。不接图时那条 `LoadImage → first_frame` 必须
  // **整条消失**：留在图里的话，ComfyUI 会拿一个不存在的文件名在校验阶段拒掉整次生成。
  // 上面那条「没有残留 $占位符」其实已经在守这件事了——被剪掉的节点不会留下 `$firstFrame`。
  console.log(`\n--- ${video.id}：可选支路（首帧/尾帧）---`)
  check(`${tag}没接首帧时不提交 loadFirst`, resolved.loadFirst === undefined, Object.keys(resolved).filter((key) => key.startsWith('load')).join(',') || '（已剪掉）')
  check(`${tag}没接首帧时 i2v 也没有 first_frame 输入`, resolved.i2v?.inputs.first_frame === undefined, JSON.stringify(resolved.i2v?.inputs.first_frame))
  const framed = resolveGraph(video, {
    ...video.defaults,
    prompt: '探针提示词',
    seed: 4242,
    prefix: 'studio',
    width: 1344,
    height: 768,
    duration: 5,
    firstFrame: 'probe-first.png',
    lastFrame: 'probe-last.png',
  })
  check(`${tag}接了首帧就带上那条支路`,
    framed.loadFirst?.inputs.image === 'probe-first.png' && framed.i2v?.inputs.first_frame?.[0] === 'loadFirst',
    JSON.stringify({ loadFirst: framed.loadFirst?.inputs, link: framed.i2v?.inputs.first_frame }))
  check(`${tag}尾帧同理`,
    framed.loadLast?.inputs.image === 'probe-last.png' && framed.i2v?.inputs.last_frame?.[0] === 'loadLast',
    JSON.stringify({ loadLast: framed.loadLast?.inputs, link: framed.i2v?.inputs.last_frame }))
  check(`${tag}requiredNodes 里写了 LoadImage`, video.requiredNodes.includes('LoadImage'), video.requiredNodes.join(','))
  // LoadImage 的 `image` 是**动态**下拉（本机 input 目录里的文件列表），所以不能像别的
  // 枚举那样比对取值：那个名字要等驱动**上传之后**才存在。这里只确认本机有这类节点，
  // 真正的校验在运行时（上传先于提交，见 comfyui.ts 的 uploadImage）。
  check(`${tag}本机有 LoadImage 节点`, info === null || info.LoadImage !== undefined, info === null ? '（未连 ComfyUI，跳过）' : '')

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
      // 动态组合框（SaveVideo 的 format）不是字符串数组，跳过。
      if (options.some((item) => typeof item === 'object')) continue
      if (!options.includes(value)) wrong.push(`${input}=${JSON.stringify(value)}`)
    }
    check(`${tag}#${id} ${node.class_type}`, wrong.length === 0, wrong.length === 0 ? '' : `枚举值不在候选里：${wrong.join(', ')}`)
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
