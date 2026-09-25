/**
 * The text backend.
 *
 * 文本节点要能生成，得有模型；而「接哪家」不该写死在代码里 —— 从 ChatGPT 到
 * DeepSeek、Moonshot、火山方舟，**能用的是同一套 OpenAI 兼容的 `/chat/completions`**。
 * 所以这里只有一个驱动：配好 base url + key + 模型名就能用。
 *
 * 和图像那条路一样，没配的时候有一个 **stub**：它回的是一段确定的占位文本，
 * 用来验证「整条链路通不通」（节点变忙 → 作业 → 结果写回节点），不需要任何外部依赖。
 * 有了它，这个功能在没买 key 的机器上也**能被测**，而不是靠肉眼看。
 *
 * 不做流式：画布上的文本节点是「按一下、出结果」，流式要另开一条进度通道，
 * 而它换来的只是「看着字一个个蹦出来」。先不做。
 */
import type { StudioStore } from './store.ts'

/** What the text backend is asked for. */
export interface TextRequest {
  /** 指令/提示词：想让模型写什么。 */
  prompt: string
  /** 想让它接着写的内容（上游文本 / 节点里已有的文本），可为空。 */
  context?: string
}

/** What the active text driver can do. */
export interface TextBackend {
  /** Driver id, for logs and the UI. */
  driver: string
  /** Model name that will be used. */
  model: string
  /** Whether a real model is configured (false = stub). */
  configured: boolean
  /** One line for the operator, in their language. */
  note: string
}

/** The text backend surface the HTTP layer mounts. */
export interface StudioTextBackend {
  /** What the active driver is, without making a call. */
  status: () => TextBackend
  /** Generate one piece of text. */
  generate: (request: TextRequest) => Promise<string>
  /**
   * 探一下通不通（只问「有哪些模型」，不花生成的钱）——设置页上「测一下」用它。
   * @returns 一句人话 + 是否可用。
   */
  probe: () => Promise<{ ok: boolean; detail: string }>
}

/** Everything the text backend needs. */
export interface TextBackendDeps {
  /** Where the text lands (used to count characters for the log). */
  store: StudioStore
  /** Diagnostics sink. */
  log: (message: string) => void
}

/** How the driver is configured, resolved from the environment. */
interface TextConfig {
  driver: 'stub' | 'openai'
  baseUrl: string
  apiKey: string
  model: string
  /** How long to wait for the model before giving up. */
  timeoutMs: number
}

/**
 * Read the text-driver configuration.
 *
 * 名字与图像那侧对称（`STUDIO_IMAGE_DRIVER` / `ARK_API_KEY`）：**一个前缀管一种能力**，
 * 免得半年后没人记得哪个变量是给谁的。
 * @param env - process environment.
 * @returns the resolved config; `stub` when nothing is set.
 */
export function textConfigFrom(env: NodeJS.ProcessEnv): TextConfig {
  const key = (env.STUDIO_TEXT_API_KEY ?? '').trim()
  const base = (env.STUDIO_TEXT_BASE_URL ?? '').trim()
  const model = (env.STUDIO_TEXT_MODEL ?? '').trim()
  // 没给 key 就是 stub：一个「配了一半」的驱动比没配更难查（发出去才发现 401）。
  const driver: TextConfig['driver'] = key === '' ? 'stub' : 'openai'
  return {
    driver,
    baseUrl: (base === '' ? 'https://api.openai.com/v1' : base).replace(/\/+$/u, ''),
    apiKey: key,
    model: model === '' ? 'gpt-4o-mini' : model,
    timeoutMs: Number(env.STUDIO_TEXT_TIMEOUT_MS ?? 120_000),
  }
}

/**
 * Build the text backend.
 * @param deps - store and logger.
 * @param envSource - 当前环境（默认 process.env）。**每次调用都重新解析**，所以设置页
 *   改完 key / 地址立刻生效，不必重启；测试也可以塞一份假环境进来。
 * @returns the backend surface.
 */
export function createTextBackend(deps: TextBackendDeps, envSource: () => NodeJS.ProcessEnv = () => process.env): StudioTextBackend {
  /** 每次用之前重新解析一遍：几个字符串操作，换来「改完就生效」。 */
  const cfg = (): TextConfig => textConfigFrom(envSource())

  const status = (): TextBackend => {
    const config = cfg()
    return config.driver === 'stub'
      ? {
        driver: 'stub',
        model: '占位文本',
        configured: false,
        note: '没有配置文本模型：设 STUDIO_TEXT_API_KEY（以及需要的 STUDIO_TEXT_BASE_URL / STUDIO_TEXT_MODEL）才能真出文本',
      }
      : {
        driver: 'openai',
        model: config.model,
        configured: true,
        note: `OpenAI 兼容接口：${config.baseUrl}，模型 ${config.model}`,
      }
  }

  /**
   * 探一下这个后端通不通：**只问「有没有模型」**（`GET /models`），
   * 不真生成一段文本 —— 设置页上点「测一下」不该花人的钱。
   * @returns 一句人话 + 是否可用。
   */
  const probe = async (): Promise<{ ok: boolean; detail: string }> => {
    const config = cfg()
    if (config.driver === 'stub') return { ok: false, detail: '没有配置 Key（当前是占位文本）' }
    try {
      const response = await fetch(`${config.baseUrl}/models`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return { ok: false, detail: `接口回了 HTTP ${String(response.status)}` }
      return { ok: true, detail: `地址通，模型 ${config.model}` }
    } catch (error) {
      return { ok: false, detail: `连不上 ${config.baseUrl}：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 占位文本：把指令原样嵌进去，让人一眼看出「这是占位、不是模型写的」。 */
  const placeholder = (request: TextRequest): string => {
    const heading = request.prompt.trim() === '' ? '（没有给指令）' : request.prompt.trim()
    const carried = request.context === undefined || request.context.trim() === ''
      ? ''
      : `\n\n接着上面那句继续：\n${request.context.trim()}`
    return `［占位文本 · 未配置文本模型］\n\n你想让模型做的是：\n${heading}${carried}`
  }

  const generate = async (request: TextRequest): Promise<string> => {
    const config = cfg()
    if (config.driver === 'stub') return placeholder(request)
    const messages: { role: 'system' | 'user'; content: string }[] = [
      {
        role: 'system',
        content: '你是一位影视编剧与分镜师。用简洁、可拍的中文写作：写场景、动作、镜头与声音。'
          + '直接给出文本本身，不要解释你在做什么，不要用 Markdown 标题。',
      },
      {
        role: 'user',
        content: request.context === undefined || request.context.trim() === ''
          ? request.prompt
          : `${request.prompt}\n\n【已有的内容】\n${request.context}`,
      },
    ]
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, config.timeoutMs)
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, temperature: 0.8 }),
        signal: controller.signal,
      })
      const raw = await response.text()
      if (!response.ok) {
        // 把服务端的原话带上：401/404/429 的处理方式完全不同，而我们猜不出来是哪一种。
        throw new Error(`文本模型返回 HTTP ${String(response.status)}：${raw.slice(0, 300)}`)
      }
      const body = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] }
      const text = body.choices?.[0]?.message?.content
      if (typeof text !== 'string' || text.trim() === '') throw new Error('文本模型返回了空内容')
      deps.log(`text: ${config.model} 返回 ${String(text.length)} 字`)
      return text.trim()
    } finally {
      clearTimeout(timer)
    }
  }

  return { status, generate, probe }
}
