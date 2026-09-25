/**
 * The audio backend.
 *
 * 视频自带声音，但**独立的一段音频**（旁白、配乐）是另一件事。和文本那条一样，
 * 只支持一种接口：OpenAI 兼容的 `/audio/speech` —— 把文本念出来，回音频字节。
 * 配好 base url + key + 模型/音色就能用。
 *
 * 没配 key 时是**占位驱动**：它合成一段**真的 WAV**（一个短音，带淡入淡出）。
 * 为什么不回空字节：空文件在播放器里什么都不发生，而「播放器坏了」和「没配模型」
 * 是两回事 —— 一段能播放的占位音把这两种情况分得清清楚楚，也让整条链（作业 →
 * 素材 → 画布上的播放器 → 版本）在没有 key 的机器上就能被走通、被测。
 */
import type { StudioStore } from './store.ts'

/** What the audio backend is asked for. */
export interface SpeechRequest {
  /** 要念的内容（或交给模型的描述）。 */
  text: string
  /** 音色；省略用配置里的默认值。 */
  voice?: string
}

/** One produced piece of audio. */
export interface SpeechResult {
  bytes: Buffer
  mime: string
  /** 实际用到的音色，记进 take 里以便重跑。 */
  voice: string
}

/** What the active audio driver can do. */
export interface AudioBackend {
  driver: string
  model: string
  /** false = 没配模型，出的是占位音。 */
  configured: boolean
  /** 给操作者看的一句话。 */
  note: string
}

/** The audio backend surface the HTTP layer mounts. */
export interface StudioAudioBackend {
  status: () => AudioBackend
  speak: (request: SpeechRequest) => Promise<SpeechResult>
  /**
   * 探一下通不通（只问「有哪些模型」，不花合成的钱）——设置页上「测一下」用它。
   * @returns 一句人话 + 是否可用。
   */
  probe: () => Promise<{ ok: boolean; detail: string }>
}

/** Everything the audio backend needs. */
export interface AudioBackendDeps {
  store: StudioStore
  log: (message: string) => void
}

/** How the driver is configured, resolved from the environment. */
interface AudioConfig {
  driver: 'stub' | 'openai'
  baseUrl: string
  apiKey: string
  model: string
  voice: string
  /** mp3 最省事（各家都支持），要 wav 也能配。 */
  format: string
  timeoutMs: number
}

/**
 * Read the audio-driver configuration.
 * @param env - process environment.
 * @returns the resolved config; `stub` when no key is set.
 */
export function audioConfigFrom(env: NodeJS.ProcessEnv): AudioConfig {
  const key = (env.STUDIO_AUDIO_API_KEY ?? '').trim()
  const base = (env.STUDIO_AUDIO_BASE_URL ?? '').trim()
  const model = (env.STUDIO_AUDIO_MODEL ?? '').trim()
  const voice = (env.STUDIO_AUDIO_VOICE ?? '').trim()
  const format = (env.STUDIO_AUDIO_FORMAT ?? '').trim()
  return {
    // 没给 key 就是 stub：一个「配了一半」的驱动比没配更难查（发出去才发现 401）。
    driver: key === '' ? 'stub' : 'openai',
    baseUrl: (base === '' ? 'https://api.openai.com/v1' : base).replace(/\/+$/u, ''),
    apiKey: key,
    model: model === '' ? 'gpt-4o-mini-tts' : model,
    voice: voice === '' ? 'alloy' : voice,
    format: format === '' ? 'mp3' : format,
    timeoutMs: Number(env.STUDIO_AUDIO_TIMEOUT_MS ?? 120_000),
  }
}

/**
 * 合成一段占位音（16 位单声道 WAV）。
 *
 * 手写 44 字节的头 + 一段正弦：Node 里没有音频库，而这里要的只是「一个真能播的文件」。
 * 带淡入淡出，否则首尾会「啪」一声——那是文件本身的问题，不该让人以为是播放器坏了。
 * @param seconds - how long the tone lasts.
 * @param hz - tone frequency.
 * @param sampleRate - samples per second.
 * @returns a complete WAV file.
 */
export function wavTone(seconds = 1.2, hz = 440, sampleRate = 16_000): Buffer {
  const samples = Math.floor(seconds * sampleRate)
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const fade = Math.min(1, index / 400, (samples - index) / 400)
    const value = Math.round(Math.sin((2 * Math.PI * hz * index) / sampleRate) * 0.25 * fade * 32_767)
    data.writeInt16LE(value, index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** 扩展名 → mime。stub 出 wav，真驱动多半出 mp3。 */
const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/wav',
}

/**
 * Build the audio backend.
 * @param deps - store and logger.
 * @param envSource - 当前环境（默认 process.env）。**每次调用都重新解析**，所以设置页
 *   改完 key / 地址立刻生效；测试也可以塞一份假环境进来。
 * @returns the backend surface.
 */
export function createAudioBackend(deps: AudioBackendDeps, envSource: () => NodeJS.ProcessEnv = () => process.env): StudioAudioBackend {
  const cfg = (): AudioConfig => audioConfigFrom(envSource())

  const status = (): AudioBackend => {
    const config = cfg()
    return config.driver === 'stub'
      ? {
        driver: 'stub',
        model: '占位音',
        configured: false,
        note: '没有配置语音模型：设 STUDIO_AUDIO_API_KEY（以及需要的 STUDIO_AUDIO_BASE_URL / _MODEL / _VOICE）才能真出人声',
      }
      : {
        driver: 'openai',
        model: config.model,
        configured: true,
        note: `OpenAI 兼容接口：${config.baseUrl}，模型 ${config.model}，音色 ${config.voice}`,
      }
  }

  /** 探一下通不通：只问模型列表，不合成一段音频。 */
  const probe = async (): Promise<{ ok: boolean; detail: string }> => {
    const config = cfg()
    if (config.driver === 'stub') return { ok: false, detail: '没有配置 Key（当前是占位音）' }
    try {
      const response = await fetch(`${config.baseUrl}/models`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return { ok: false, detail: `接口回了 HTTP ${String(response.status)}` }
      return { ok: true, detail: `地址通，模型 ${config.model}，音色 ${config.voice}` }
    } catch (error) {
      return { ok: false, detail: `连不上 ${config.baseUrl}：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const speak = async (request: SpeechRequest): Promise<SpeechResult> => {
    const config = cfg()
    const voice = request.voice === undefined || request.voice.trim() === '' ? config.voice : request.voice.trim()
    if (config.driver === 'stub') {
      // 时长按字数粗略给：占位音也该「长一点的话更长」，否则人以为长文本被截断了。
      const seconds = Math.min(8, Math.max(0.8, request.text.trim().length / 12))
      return { bytes: wavTone(seconds), mime: 'audio/wav', voice }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, config.timeoutMs)
    try {
      const response = await fetch(`${config.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, input: request.text, voice, response_format: config.format }),
        signal: controller.signal,
      })
      if (!response.ok) {
        // 服务端的原话要带上：401/404/422 的处理方式完全不同，猜不出来是哪一种。
        const raw = await response.text()
        throw new Error(`语音模型返回 HTTP ${String(response.status)}：${raw.slice(0, 300)}`)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0) throw new Error('语音模型返回了空音频')
      const mime = MIME_BY_FORMAT[config.format] ?? 'audio/mpeg'
      deps.log(`audio: ${config.model} 返回 ${String(Math.round(bytes.length / 1024))} KB ${mime}`)
      return { bytes, mime, voice }
    } finally {
      clearTimeout(timer)
    }
  }

  return { status, speak, probe }
}
