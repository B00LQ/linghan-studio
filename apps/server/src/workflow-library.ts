/**
 * The workflow library.
 *
 * A ComfyUI workflow is a JSON graph, and every creator's is different: a
 * different checkpoint, a LoRA in the middle, another sampler, one more upscale
 * pass. Shipping exactly one baked-in graph therefore means "you may only run my
 * workflow", which is not a product.
 *
 * So a workflow is stored as data, and the only thing the server needs to know
 * about it is **which input receives what**:
 *
 * ```
 * bindings: { prompt: { node: '6', input: 'text' },
 *             seed:   { node: '3', input: 'seed' },
 *             width:  { node: '5', input: 'width' }, … }
 * ```
 *
 * That indirection is what makes an arbitrary uploaded graph runnable without
 * understanding it. Node ids differ between workflows; the binding map is how a
 * human (or a good guess) bridges that.
 *
 * Two input conventions are supported and they converge on one execution path:
 *
 * - **`$name` placeholders** in a hand-written template (what the shipped
 *   z-image workflow uses) — bindings are derived from them on load.
 * - **An explicit binding map** — what the upload form produces.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One graph node in ComfyUI's API format. */
export interface WorkflowNode {
  class_type: string
  inputs: Record<string, unknown>
}

/** Where one logical value goes in the graph. */
export interface WorkflowBinding {
  /** Node id, as the graph keys it. */
  node: string
  /** Input name on that node. */
  input: string
}

/** What a workflow produces, inferred from the graph's output nodes. */
export type WorkflowCapability = 'image' | 'video' | 'video-edit'

/**
 * Node classes that write a video (or an animation).
 *
 * Recognising these is what lets a MiniMax-H3 / Wan video workflow live in the
 * same library as a stills workflow and be labelled honestly, instead of being
 * rejected as "not an image graph".
 */
const VIDEO_OUTPUT = /VHS_VideoCombine|SaveVideo|SaveWEBM|SaveAnimated|CreateVideo|SaveAudio|Mochi|WanVideo/iu

/** A stored workflow. */
export interface StudioWorkflow {
  /** Stable id (also the file name). */
  id: string
  /** Human title. */
  title: string
  /** What it produces. */
  capability: WorkflowCapability
  /** Where it came from, so a later operator can tell. */
  source: string
  /** Node classes it needs; checked against the local ComfyUI. */
  requiredNodes: string[]
  /** The graph, API format. */
  graph: Record<string, WorkflowNode>
  /** Which input receives prompt / width / height / steps / seed / … */
  bindings: Record<string, WorkflowBinding>
  /** Non-bound defaults, e.g. cfg, sampler, scheduler. */
  defaults: Record<string, number | string>
  /**
   * Values for `$name` placeholders that are not per-request — model file names,
   * mostly.
   *
   * The shipped workflow writes `"unet_name": "$unet"` and keeps the actual file
   * in this map, because a diff that reads `$unet` is easier to review than one
   * with a 40-character filename in it. Dropping this field silently breaks the
   * default workflow, so it is carried through every path.
   */
  models?: Record<string, string>
  /**
   * `$name` 占位符中**可选**的那些：没人给值时，那个节点连同指向它的连线一起被删掉。
   *
   * 存在的理由很具体：图生视频的首帧是一条 `LoadImage → i2v.first_frame` 的支路，
   * 而首帧是可选的（不接图就是文生视频）。没接图时如果照旧提交，`LoadImage` 会拿着
   * 一个不存在的文件名让 ComfyUI 在校验阶段拒绝——整条生成都跑不起来。
   * 声明成 optional 之后，「没有首帧」就变成「那条支路不存在」，而这正是它的语义。
   */
  optional?: string[]
  /**
   * 必须接上的输入（端口 id，如 `ref`）。
   *
   * 和 `optional` 正好相反，而且**两者都要有**：`optional` 说的是「没人给值就把这条支路
   * 剪掉」（首帧可以不接），`requires` 说的是「没人给值就别跑」（图生图没有参考图，
   * 跑出来的东西和参考图毫无关系）。只声明 optional 会让第二种情况悄悄出一张无关的图。
   */
  requires?: string[]
  /**
   * 这份内置工作流被改过（数据目录里有一份覆盖）。
   *
   * **只在内存里**：它是「读的时候算出来的事实」，不写进任何文件。
   * 写进去的话，删掉覆盖之后那份文件还会说自己被改过。
   */
  edited?: boolean
}

/** Guess what a graph produces from the classes it uses. */
export function inferCapability(graph: Record<string, WorkflowNode>): WorkflowCapability {
  return Object.values(graph).some((node) => VIDEO_OUTPUT.test(node.class_type)) ? 'video' : 'image'
}

/** Model-ish file extensions we treat as a checkpoint/LoRA reference. */
const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|gguf|bin)$/iu

/** Input names that mean "this is the prompt". */
const PROMPT_INPUTS = ['text', 'prompt', 'positive', 'string']

/** What a validation run reports back. */
export interface WorkflowCheck {
  /** Node classes used by the graph. */
  classes: string[]
  /** Classes the local ComfyUI does not have. */
  missingNodes: string[]
  /** Model files the graph names but the server does not offer. */
  missingModels: { node: string; input: string; value: string }[]
  /** Bindings we guessed, for the operator to confirm or change. */
  suggested: Record<string, WorkflowBinding>
  /** Every model-file reference found, keyed `node.input`. */
  models: Record<string, { node: string; input: string; value: string }>
  /** Editable inputs we found, for the mapping form. */
  candidates: { node: string; input: string; classType: string; value: unknown }[]
}

/** Read a string input. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A node input that references another node looks like `[id, outputIndex]`. */
function isLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
}

/**
 * Derive bindings from `$name` placeholders.
 *
 * The shipped workflow is hand-written with `$unet`-style markers because that is
 * readable in a diff. Deriving the bindings here means the *executor* only ever
 * deals with one mechanism.
 * @param graph - the graph to scan.
 * @returns a binding per placeholder name.
 */
export function bindingsFromPlaceholders(graph: Record<string, WorkflowNode>): Record<string, WorkflowBinding> {
  const found: Record<string, WorkflowBinding> = {}
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      const name = str(value)
      if (!name.startsWith('$')) continue
      found[name.slice(1)] = { node: nodeId, input }
    }
  }
  return found
}

/**
 * Guess which input is the prompt, the size, the step count and so on.
 *
 * Deliberately a guess, and deliberately a *reported* one: the upload form shows
 * these as the defaults and the operator confirms them. A workflow whose prompt
 * binding is wrong produces an image of nothing, which is much harder to debug
 * than a dropdown that was left on the wrong row.
 * @param graph - the uploaded graph.
 * @returns suggested bindings, plus the model references found.
 */
export function suggestBindings(graph: Record<string, WorkflowNode>): {
  suggested: Record<string, WorkflowBinding>
  models: Record<string, { node: string; input: string; value: string }>
  candidates: { node: string; input: string; classType: string; value: unknown }[]
} {
  const suggested: Record<string, WorkflowBinding> = {}
  const models: Record<string, { node: string; input: string; value: string }> = {}
  const candidates: { node: string; input: string; classType: string; value: unknown }[] = []

  /** Which node feeds a given sampler input. */
  const upstreamOf = (samplerId: string, input: string): string => {
    const value = graph[samplerId]?.inputs?.[input]
    return isLink(value) ? value[0] : ''
  }

  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (isLink(value)) continue
      const text = str(value)
      if (text.startsWith('$')) suggested[text.slice(1)] = { node: nodeId, input }
      // 任何指向模型文件的输入都记下来：换模型、加 LoRA 都会在这里出现，
      // 而校验「本机有没有这个文件」正是上传时最该拦住的事。
      if (MODEL_EXT.test(text)) models[`${nodeId}.${input}`] = { node: nodeId, input, value: text }
      // 可编辑的输入：数字、字符串、枚举（下拉）——映射表单让用户从这里挑。
      if (typeof value === 'number' || typeof value === 'string' || Array.isArray(value)) {
        candidates.push({ node: nodeId, input, classType: node.class_type, value })
      }
    }
  }

  const samplers = Object.entries(graph).filter(([, node]) => /KSampler|SamplerCustom/iu.test(node.class_type))
  const sampler = samplers[0]
  if (sampler !== undefined) {
    const [samplerId] = sampler
    for (const input of ['steps', 'cfg', 'sampler_name', 'scheduler', 'seed', 'noise_seed', 'denoise']) {
      if (graph[samplerId]?.inputs?.[input] !== undefined) {
        const key = input === 'noise_seed' ? 'seed' : input
        suggested[key] ??= { node: samplerId, input }
      }
    }
    // 正向提示词：优先取 KSampler 的 positive 上游那个有 text 输入的节点。
    const positive = upstreamOf(samplerId, 'positive')
    const negative = upstreamOf(samplerId, 'negative')
    const pick = (nodeId: string): WorkflowBinding | undefined => {
      if (nodeId === '') return undefined
      const inputs = graph[nodeId]?.inputs ?? {}
      const name = PROMPT_INPUTS.find((candidate) => typeof inputs[candidate] === 'string')
      return name === undefined ? undefined : { node: nodeId, input: name }
    }
    suggested.prompt ??= pick(positive) ?? { node: '', input: '' }
    const negativeBinding = pick(negative)
    if (negativeBinding !== undefined) suggested.negative = negativeBinding
  }

  // 没找到就退到「第一个有 text 输入的节点」，总比空着强，并且会被标成「猜的」。
  if (suggested.prompt === undefined || suggested.prompt.node === '') {
    const fallback = candidates.find((item) => item.input === 'text' && typeof item.value === 'string')
    if (fallback !== undefined) suggested.prompt = { node: fallback.node, input: fallback.input }
  }

  const latent = Object.entries(graph).find(([, node]) =>
    /Empty.*Latent|LatentImage/iu.test(node.class_type) && node.inputs.width !== undefined)
  if (latent !== undefined) {
    suggested.width = { node: latent[0], input: 'width' }
    suggested.height = { node: latent[0], input: 'height' }
  }

  return { suggested, models, candidates }
}

/**
 * Drop the graph nodes that belong to an optional branch nobody filled in.
 *
 * 只删一层：被删节点的**下游**保留其余输入（比如 `i2v` 的 `first_frame` 是可选的，
 * 所以删掉它正好）。如果某个下游的**必填**输入依赖被删的节点，ComfyUI 会在校验时
 * 明确说出「哪个节点缺哪个输入」——那比我们在这里猜要好。
 * @param graph - resolved graph, mutated in place.
 * @param optional - placeholder names declared optional by the workflow.
 */
function pruneOptional(graph: Record<string, WorkflowNode>, optional: string[]): void {
  if (optional.length === 0) return
  const wanted = new Set(optional.map((name) => `$${name}`))
  const dropped = new Set<string>()
  for (const [id, node] of Object.entries(graph)) {
    const unresolved = Object.values(node.inputs ?? {}).some((value) => typeof value === 'string' && wanted.has(value))
    if (unresolved) dropped.add(id)
  }
  if (dropped.size === 0) return
  for (const id of dropped) delete graph[id]
  for (const node of Object.values(graph)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (isLink(value) && dropped.has(value[0])) delete node.inputs[input]
    }
  }
}

/**
 * Fill a workflow's graph with this request's values.
 *
 * Values are applied through the binding map; anything left over is applied to
 * `$placeholder` inputs. Both mechanisms land in the same cloned graph, so the
 * driver never branches.
 * @param workflow - the workflow to resolve.
 * @param values - prompt, seed, width, height, steps, …
 * @returns a fresh graph ready to submit.
 */
export function resolveGraph(workflow: StudioWorkflow, values: Record<string, unknown>): Record<string, WorkflowNode> {
  const graph = JSON.parse(JSON.stringify(workflow.graph)) as Record<string, WorkflowNode>
  // `models` first: a per-request value must win over a fixed model file name.
  const all: Record<string, unknown> = { ...workflow.models, ...values }
  const bindings = Object.keys(workflow.bindings).length > 0
    ? workflow.bindings
    : bindingsFromPlaceholders(workflow.graph)

  for (const [key, binding] of Object.entries(bindings)) {
    const value = all[key]
    if (value === undefined || binding.node === '') continue
    const node = graph[binding.node]
    if (node === undefined) continue
    node.inputs[binding.input] = value
  }

  // `$name` inputs that no binding claimed still resolve, so a hand-written file
  // with an extra marker does not blow up mid-run.
  for (const node of Object.values(graph)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      const name = str(value)
      if (name.startsWith('$') && all[name.slice(1)] !== undefined) node.inputs[input] = all[name.slice(1)]
    }
  }
  // 可选支路：留在图里的 `$name` 已经确定没人给值了（上面两轮都没解析掉它们）。
  pruneOptional(graph, workflow.optional ?? [])
  return graph
}

/**
 * Validate a graph against what the local ComfyUI can do.
 *
 * ⚠️ **占位符必须先换成真实文件名**（第三个参数）：内置工作流的图里写的是 `$unet`，
 * 真正的文件名放在 `models` 表里（那样 diff 才读得懂）。不换的话，`suggestBindings`
 * 只认字面量文件名，于是内置工作流的「本机缺哪些模型」**永远是空的** ——
 * 而这个检查恰恰是别人接手时最想知道的事（也正因如此，缺权重时界面会报「都齐了」，
 * 然后生成在校验阶段失败）。
 * @param graph - the graph to check.
 * @param objectInfo - ComfyUI's object info, or null when unavailable.
 * @param workflowModels - `$name` → 文件名（内置工作流的 `models` 表）。
 */
export function checkWorkflow(
  graph: Record<string, WorkflowNode>,
  objectInfo: Record<string, { input?: { required?: Record<string, unknown[]> } }> | null,
  workflowModels: Record<string, string> = {},
): WorkflowCheck {
  const resolved: Record<string, WorkflowNode> = {}
  for (const [id, node] of Object.entries(graph)) {
    const inputs: Record<string, unknown> = {}
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      const text = str(value)
      const replacement = text.startsWith('$') ? workflowModels[text.slice(1)] : undefined
      inputs[input] = replacement ?? value
    }
    resolved[id] = { ...node, inputs }
  }
  const classes = [...new Set(Object.values(resolved).map((node) => node.class_type))]
  const { suggested, models } = suggestBindings(resolved)
  const candidates = suggestBindings(resolved).candidates
  const missingNodes = objectInfo === null ? [] : classes.filter((name) => !(name in objectInfo))

  const missingModels: { node: string; input: string; value: string }[] = []
  if (objectInfo !== null) {
    for (const reference of Object.values(models)) {
      const classType = resolved[reference.node]?.class_type ?? ''
      const options = objectInfo[classType]?.input?.required?.[reference.input]
      const list = Array.isArray(options) && Array.isArray(options[0]) ? (options[0] as unknown[]).map(String) : null
      // 拿不到选项列表就不断言缺文件——那是猜，不如不说。
      if (list !== null && !list.includes(reference.value)) missingModels.push(reference)
    }
  }
  return { classes, missingNodes, missingModels, suggested, models, candidates }
}

/**
 * Marker so the list can tell built-in from uploaded.
 *
 * 顺序也是**默认值**：`workflowFor` 取同类里第一个，所以 8 步那份留在前面 —— 新节点
 * 默认跑的仍是已知能出片的那条，快的这条要人选。这不是保守，是「换默认值」和「多给
 * 一个选项」是两件事：前者会在人没准备好时改变产出质量。
 */
const BUILT_IN = new Set(['z-image-turbo', 'z-image-turbo-img2img', 'minimax-h3-video', 'minimax-h3-video-fast', 'minimax-h3-video-pdd', 'video-trim', 'video-concat'])

/** A stored workflow plus its provenance. */
export interface WorkflowSummary {
  id: string
  title: string
  capability: WorkflowCapability
  builtIn: boolean
  source: string
  /** Node classes it needs. */
  classes: string[]
  /** Model files it names, deduplicated. */
  models: string[]
  /** Whether the prompt binding is set (a workflow without one cannot run). */
  ready: boolean
  /**
   * 这套工作流要不要提示词。
   *
   * 剪辑/拼接不要（它们不生成画面，只是在容器层面裁/接），画布据此决定「提示词为空」
   * 算不算错误——对生成类工作流是错，对剪辑类不是。
   */
  needsPrompt: boolean
  /**
   * 必须接上的输入（端口 id）。
   *
   * 画布要拿它做两件事：**没接就别默认选它**（接了参考图之后默认还落在文生图上，
   * 等于「连了却没用」），以及生成前拦一道、给人话而不是让它跑出一张无关的图。
   */
  requires: string[]
  /**
   * 采样步数（如果这套工作流在 defaults 里写了 `steps`）。
   *
   * 界面需要它，因为**同一套模型的不同配方在标题上看不出来**：默认那条标题里
   * 没有步数，4 步那条有。而「这一版是几步出的」恰恰是版本之间最实在的差别之一
   * （快多少、细节差多少都从这儿来）。取 defaults 而不是去图里数节点：
   * defaults 就是跑的时候真正用的那个值。
   */
  steps?: number
  /** 内置工作流被改过（有覆盖）。 */
  edited?: boolean
}

/** Where uploaded workflows live. */
const folderOf = (dataDir: string): string => join(dataDir, 'workflows')

/** 随程序发布的那几份模板就在这个文件旁边（`comfyui/*.json`）。 */
const BUILT_IN_DIR = join(import.meta.dirname, 'comfyui')

/**
 * 内置工作流的**覆盖层**放在哪。
 *
 * 单独一个子目录，而不是直接改 `workflows/` 里那份：那个目录是「用户上传的」，
 * 两种来源混在一起之后，「这份到底是谁的」就再也说不清了（列表里也会多出一条
 * 同 id 的重复项）。
 */
const overridesOf = (dataDir: string): string => join(dataDir, 'workflows', 'overrides')

/**
 * 一份覆盖：只放**改过的**顶层字段。
 *
 * 顶层浅合并（`{...内置, ...覆盖}`）是有意的：`graph` / `models` / `bindings` / `defaults`
 * 每一块都是一个整体，半合并（比如按节点 id 合并 graph）会产出「一半是新的、一半是旧的」
 * 的第三种工作流 —— 那种东西跑出来的结果没人能预期。要改就整块换。
 */
type WorkflowOverride = Partial<Pick<StudioWorkflow, 'title' | 'capability' | 'graph' | 'bindings' | 'defaults' | 'models' | 'optional' | 'requires'>>

/** 读一份覆盖（没有就 undefined）。 */
function readOverride(dataDir: string, id: string): WorkflowOverride | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(overridesOf(dataDir), `${id}.json`), 'utf8')) as WorkflowOverride
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 这份内置工作流有没有被改过。 */
export function hasOverride(dataDir: string, id: string): boolean {
  return readOverride(dataDir, id) !== undefined
}

/**
 * Read every workflow: the shipped one plus whatever was uploaded.
 * @param dataDir - Studio's data directory.
 * @param builtInDir - directory holding the shipped templates.
 * @returns workflows, oldest first, with the built-in first.
 */
export function loadWorkflows(dataDir: string, builtInDir: string): StudioWorkflow[] {
  const workflows: StudioWorkflow[] = []

  const readOne = (file: string, id: string): StudioWorkflow | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StudioWorkflow>
      if (typeof parsed.graph !== 'object' || parsed.graph === null) return undefined
      const graph = parsed.graph as Record<string, WorkflowNode>
      // A hand-written file may carry neither bindings nor defaults; fill them in
      // rather than reject it, because it is the file we ship.
      const bindings = parsed.bindings ?? bindingsFromPlaceholders(graph)
      return {
        id: parsed.id ?? id,
        title: parsed.title ?? id,
        capability: parsed.capability ?? inferCapability(graph),
        source: parsed.source ?? '',
        requiredNodes: parsed.requiredNodes ?? [...new Set(Object.values(graph).map((node) => node.class_type))],
        graph,
        bindings,
        defaults: parsed.defaults ?? {},
        models: parsed.models ?? {},
        optional: parsed.optional ?? [],
        requires: parsed.requires ?? [],
      }
    } catch {
      return undefined
    }
  }

  for (const name of ['z-image-turbo.json', 'z-image-turbo-img2img.json', 'minimax-h3-video.json', 'minimax-h3-video-fast.json', 'minimax-h3-video-pdd.json', 'video-trim.json', 'video-concat.json']) {
    const parsed = readOne(join(builtInDir, name), name.replace(/\.json$/u, ''))
    if (parsed === undefined) continue
    // 内置的可以被**改**（债务第 10/15 条）：改动存成一份覆盖，随程序发布的那份文件
    // 一个字节都不动 —— 于是「改坏了」永远能退回去，升级也不会把人的改动覆盖掉。
    const override = readOverride(dataDir, parsed.id)
    workflows.push(override === undefined ? parsed : { ...parsed, ...override, edited: true })
  }
  try {
    for (const name of readdirSync(folderOf(dataDir))) {
      if (!name.endsWith('.json')) continue
      const parsed = readOne(join(folderOf(dataDir), name), name.replace(/\.json$/u, ''))
      if (parsed !== undefined) workflows.push(parsed)
    }
  } catch {
    // No uploads yet is the normal case on a fresh install.
  }
  return workflows
}

/** Summarize one workflow for the list view. */
export function summarize(workflow: StudioWorkflow): WorkflowSummary {
  const binding = workflow.bindings.prompt
  // 「要不要提示词」= 图里有 `$prompt`，**或者**上传的工作流把提示词绑到了某个输入上。
  // 只看 `$prompt` 会把「有绑定、只是没用占位符」的导入工作流判成不要提示词，
  // 那是错的（它照样要人写提示词）。
  const needsPrompt = binding !== undefined
    || Object.values(workflow.graph).some((node) => Object.values(node.inputs ?? {}).some((value) => value === '$prompt'))
  const promptReady = !needsPrompt || (binding !== undefined && binding.node !== '' && binding.input !== '')
  return {
    id: workflow.id,
    title: workflow.title,
    capability: workflow.capability,
    builtIn: BUILT_IN.has(workflow.id),
    source: workflow.source,
    classes: [...new Set(Object.values(workflow.graph).map((node) => node.class_type))],
    // 只列**文件**：`models` 里还放着 clipType/weightDtype 这类枚举值，
    // 把 lumina2、default 当成模型文件名字列出来是在误导人。
    models: [...new Set([
      ...Object.values(workflow.models ?? {}),
      ...Object.values(workflow.graph).flatMap((node) => Object.values(node.inputs ?? {}).map(str)),
    ].filter((value) => MODEL_EXT.test(value)))],
    ready: promptReady,
    needsPrompt,
    requires: workflow.requires ?? [],
    /** 内置工作流被改过（存在一份覆盖）。界面据此显示「已改过」与「恢复内置默认」。 */
    ...(workflow.edited === true ? { edited: true } : {}),
    // `steps` 在内置 JSON 里既有数字也有字符串（PDD 那条写的是 "4"），两种都认。
    ...(Number.isFinite(Number(workflow.defaults?.steps)) && workflow.defaults?.steps !== undefined
      ? { steps: Number(workflow.defaults.steps) }
      : {}),
  }
}

/**
 * Save an uploaded workflow.
 * @param dataDir - Studio's data directory.
 * @param input - title, graph, bindings, defaults.
 * @returns the stored workflow.
 */
export function saveWorkflow(dataDir: string, input: {
  title: string
  graph: Record<string, WorkflowNode>
  bindings: Record<string, WorkflowBinding>
  defaults?: Record<string, number | string>
  source?: string
}): StudioWorkflow {
  const folder = folderOf(dataDir)
  mkdirSync(folder, { recursive: true })
  // 文件名即 id，所以只保留安全字符：这是唯一一处用户输入会碰到磁盘路径的地方。
  const slug = input.title.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60)
  const id = `${slug === '' ? 'workflow' : slug}-${randomUUID().slice(0, 6)}`
  const workflow: StudioWorkflow = {
    id,
    title: input.title.trim() === '' ? '未命名工作流' : input.title.trim(),
    capability: inferCapability(input.graph),
    source: input.source ?? '上传',
    requiredNodes: [...new Set(Object.values(input.graph).map((node) => node.class_type))],
    graph: input.graph,
    bindings: input.bindings,
    defaults: input.defaults ?? {},
    models: {},
  }
  writeFileSync(join(folder, `${id}.json`), JSON.stringify(workflow, null, 2), 'utf8')
  return workflow
}

/** Delete an uploaded workflow. Built-ins are shipped files and cannot be removed. */
export function deleteWorkflow(dataDir: string, id: string): boolean {
  if (BUILT_IN.has(id) || id.includes('/') || id.includes('\\')) return false
  try {
    rmSync(join(folderOf(dataDir), `${id}.json`))
    return true
  } catch {
    return false
  }
}

/** Read one workflow in full, including its graph. */
export function readWorkflow(dataDir: string, builtInDir: string, id: string): StudioWorkflow | undefined {
  return loadWorkflows(dataDir, builtInDir).find((workflow) => workflow.id === id)
}

/** Whether a workflow is a shipped file rather than an upload. */
export function isBuiltIn(id: string): boolean {
  return BUILT_IN.has(id)
}

/**
 * Change a workflow in place.
 *
 * The graph is usually right — it came out of ComfyUI — and what a creator wants
 * to fix later is the mapping: the prompt ended up on the wrong encoder, or the
 * step count should follow the node instead of a fixed number. Re-importing the
 * whole file to change one dropdown is the kind of friction that makes a feature
 * unused.
 *
 * **内置工作流也改得**（债务第 10/15 条）：改动写成一份覆盖
 * （`data/workflows/overrides/<id>.json`），随程序发布的那份文件一个字节都不动。
 * 于是「改坏了」永远能退回去，升级也不会把人的改动冲掉。
 * 这条以前是「内置不能编辑」，而代价很具体：换量化档、改模型文件名、改 PDD 的 nfe
 * 都得走「导出 → 改 → 再导入」，得到一条 id 不同的新工作流 —— 画布上每个节点都得重选。
 * @param dataDir - Studio's data directory.
 * @param id - workflow to change.
 * @param patch - fields to replace; omitted fields stay.
 * @returns the updated workflow, or undefined when it does not exist.
 */
export function updateWorkflow(dataDir: string, id: string, patch: {
  title?: string
  bindings?: Record<string, WorkflowBinding>
  defaults?: Record<string, number | string>
  /** 模型/权重文件名（`$name` → 文件名）。换量化档、换 VAE 都在这儿改。 */
  models?: Record<string, string>
}): StudioWorkflow | undefined {
  if (isBuiltIn(id)) {
    // 内置：只留「改过的字段」。空 patch 不写文件（否则「打开又保存」会平白多一份覆盖）。
    const base = loadWorkflows(dataDir, BUILT_IN_DIR).find((workflow) => workflow.id === id)
    if (base === undefined) return undefined
    const patchFields: WorkflowOverride = {
      ...(patch.title === undefined || patch.title.trim() === '' ? {} : { title: patch.title.trim() }),
      ...(patch.bindings === undefined ? {} : { bindings: patch.bindings }),
      ...(patch.defaults === undefined ? {} : { defaults: patch.defaults }),
      ...(patch.models === undefined ? {} : { models: patch.models }),
    }
    if (Object.keys(patchFields).length === 0) return base
    // 和已有覆盖合并：改两次不该把第一次的改动丢掉。
    const merged: WorkflowOverride = { ...readOverride(dataDir, id), ...patchFields }
    mkdirSync(overridesOf(dataDir), { recursive: true })
    writeFileSync(join(overridesOf(dataDir), `${id}.json`), JSON.stringify(merged, null, 2), 'utf8')
    return { ...base, ...merged, edited: true }
  }
  let raw: string
  try {
    raw = readFileSync(join(folderOf(dataDir), `${id}.json`), 'utf8')
  } catch {
    return undefined
  }
  const parsed = JSON.parse(raw) as StudioWorkflow
  const next: StudioWorkflow = {
    ...parsed,
    title: patch.title === undefined || patch.title.trim() === '' ? parsed.title : patch.title.trim(),
    bindings: patch.bindings ?? parsed.bindings,
    defaults: patch.defaults ?? parsed.defaults,
    // `exactOptionalPropertyTypes`：`models` 是可选的，显式给 undefined 不算合法值，
    // 所以「没改」的时候连键都不加。
    ...(patch.models === undefined ? {} : { models: patch.models }),
  }
  writeFileSync(join(folderOf(dataDir), `${id}.json`), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 把一份内置工作流退回出厂状态（删掉覆盖）。上传的那种走 `deleteWorkflow`。
 * @param dataDir - Studio's data directory.
 * @param id - built-in workflow id.
 * @returns whether an override was removed.
 */
export function resetWorkflow(dataDir: string, id: string): boolean {
  if (!isBuiltIn(id)) return false
  try {
    rmSync(join(overridesOf(dataDir), `${id}.json`))
    return true
  } catch {
    return false
  }
}
