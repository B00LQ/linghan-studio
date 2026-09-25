/** Environment-driven configuration for the Studio server. */
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Fully resolved server configuration. */
export interface StudioConfig {
  /** HTTP port. */
  port: number
  /** Bind host. */
  host: string
  /** Access password; empty disables the login gate (local development only). */
  password: string
  /** Directory holding the database and generated assets. */
  dataDir: string
  /** Image backend the gateway dispatches to. */
  imageDriver: 'stub' | 'comfyui' | 'ark'
  /** ComfyUI base URL, used by the `comfyui` driver. */
  comfyuiUrl: string
  /** Volcengine Ark API key, used by the `ark` driver. */
  arkApiKey: string
  /** Volcengine Ark base URL. */
  arkBaseUrl: string
  /** Ark model id for image generation. */
  arkModel: string
  /** Secret signing the session cookie. */
  cookieSecret: string
  /** 更新源清单地址（绿色包自助更新用）；空串 = 没有更新源。 */
  updateUrl: string
}

/**
 * 设置页能改的东西。
 *
 * **键就是环境变量名**，不另起一套：一个东西一个名字，界面上因此说得出
 * 「这个值来自环境变量还是来自设置页」，而文档里写的变量名与这里永远一致。
 */
export interface SettingSpec {
  /** 环境变量名，也是存储与 API 的键。 */
  key: string
  /** 界面上那一行写什么。 */
  label: string
  /** 归在哪个分组下。 */
  group: 'image' | 'text' | 'audio' | 'update'
  /** 机密：读回来时打码，界面上也不回显。 */
  secret?: boolean
  /** 一句说明/取值提示。 */
  hint?: string
  /** 输入框的占位示例。 */
  placeholder?: string
}

/** 设置页的字段表。顺序就是界面顺序。 */
export const SETTINGS: SettingSpec[] = [
  {
    key: 'STUDIO_IMAGE_DRIVER',
    label: '图像后端',
    group: 'image',
    hint: 'stub（占位图，不需要任何依赖）／comfyui（本机显卡）／ark（火山方舟）',
    placeholder: 'comfyui',
  },
  {
    key: 'COMFYUI_URL',
    label: 'ComfyUI 地址',
    group: 'image',
    hint: '容器里要用 host.docker.internal 指向宿主机；本机直跑就用 127.0.0.1',
    placeholder: 'http://host.docker.internal:8188',
  },
  { key: 'ARK_API_KEY', label: '方舟 Key', group: 'image', secret: true, hint: '只有图像后端选 ark 时才用得到' },
  { key: 'ARK_MODEL', label: '方舟模型', group: 'image', placeholder: 'doubao-seedream-4-0-250828' },
  {
    key: 'STUDIO_TEXT_API_KEY',
    label: '文本模型 Key',
    group: 'text',
    secret: true,
    hint: '任何 OpenAI 兼容的接口都行（ChatGPT / DeepSeek / Moonshot / 方舟）',
    placeholder: 'sk-…',
  },
  { key: 'STUDIO_TEXT_BASE_URL', label: '文本接口地址', group: 'text', placeholder: 'https://api.deepseek.com/v1' },
  { key: 'STUDIO_TEXT_MODEL', label: '文本模型名', group: 'text', placeholder: 'deepseek-chat' },
  { key: 'STUDIO_AUDIO_API_KEY', label: '语音模型 Key', group: 'audio', secret: true, placeholder: 'sk-…' },
  { key: 'STUDIO_AUDIO_BASE_URL', label: '语音接口地址', group: 'audio', placeholder: 'https://api.openai.com/v1' },
  { key: 'STUDIO_AUDIO_MODEL', label: '语音模型名', group: 'audio', placeholder: 'gpt-4o-mini-tts' },
  { key: 'STUDIO_AUDIO_VOICE', label: '音色', group: 'audio', placeholder: 'alloy' },
  {
    key: 'STUDIO_UPDATE_URL',
    label: '更新源',
    group: 'update',
    hint: '一个 JSON 清单的地址（version / url / sha256），绿色包才能自助更新；留空表示不检查更新',
    placeholder: 'https://…/studio-latest.json',
  },
]

/** 每个键的取值来源，界面据此说「它来自哪」。 */
export type SettingSource = 'settings' | 'env' | 'default'

/** 一个字段的当前状态，给设置页看。 */
export interface SettingView extends SettingSpec {
  /** 非机密字段回显原值；机密字段回空串，只用 `set` 说有没有。 */
  value: string
  /** 有没有值（机密字段靠它显示「已配置」）。 */
  set: boolean
  /** 这个值从哪来。 */
  source: SettingSource
  /** 环境变量里也有一份（用来提示「环境变量里也设了，清掉设置页这条会退回它」）。 */
  fromEnv: boolean
}

/** Read a positive integer environment variable. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** 一个键的原始值：设置页优先，其次环境变量。 */
function layer(overrides: Record<string, string>, key: string): string {
  const stored = (overrides[key] ?? '').trim()
  if (stored !== '') return stored
  return process.env[key]?.trim() ?? ''
}

/**
 * Resolve configuration from the settings store layered over the environment.
 *
 * 顺序是**设置页 → 环境变量 → 内置默认**。这样两种用法都成立：想用环境变量部署的人
 * 什么都不用改，而界面上改过的值一定压得住它（否则「改了没反应」最难查）。
 * @param overrides - values stored by the settings page.
 * @param previous - the config in force now; its cookie secret is reused so that
 *   re-resolving (after a settings change) does not log everyone out.
 * @returns the resolved configuration, ready to be assigned over the live one.
 */
export function loadConfig(overrides: Record<string, string> = {}, previous?: StudioConfig): StudioConfig {
  const pick = (key: string): string => layer(overrides, key)
  const password = pick('STUDIO_PASSWORD')
  const dataDir = pick('STUDIO_DATA_DIR')
  const driver = pick('STUDIO_IMAGE_DRIVER')
  return {
    port: intEnv('PORT', previous?.port ?? 8080),
    host: process.env.HOST?.trim() || previous?.host || '0.0.0.0',
    password,
    dataDir: resolve(dataDir !== '' ? dataDir : join(homedir(), '.studio')),
    imageDriver: driver === 'comfyui' || driver === 'ark' ? driver : 'stub',
    comfyuiUrl: pick('COMFYUI_URL') || 'http://127.0.0.1:8188',
    arkApiKey: pick('ARK_API_KEY'),
    arkBaseUrl: pick('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3',
    arkModel: pick('ARK_MODEL') || 'doubao-seedream-4-0-250828',
    // A per-process secret is fine for a single instance; multi-instance
    // deployments must pin STUDIO_SECRET so sessions survive a restart.
    // **重解析时要沿用旧的那个**：否则改一次设置就把所有人踢下线。
    cookieSecret: pick('STUDIO_SECRET') || previous?.cookieSecret || randomBytes(32).toString('base64url'),
    updateUrl: pick('STUDIO_UPDATE_URL'),
  }
}

/**
 * Describe every settable field for the settings page.
 * @param overrides - values stored by the settings page.
 * @returns one view per field, in table order.
 */
export function settingsView(overrides: Record<string, string>): SettingView[] {
  return SETTINGS.map((spec) => {
    const stored = (overrides[spec.key] ?? '').trim()
    const fromEnv = (process.env[spec.key] ?? '').trim() !== ''
    const value = stored !== '' ? stored : (process.env[spec.key] ?? '').trim()
    const source: SettingSource = stored !== '' ? 'settings' : fromEnv ? 'env' : 'default'
    return {
      ...spec,
      // 机密**不回显**：界面只需要知道「有没有」，把 key 发回浏览器是没必要的暴露。
      value: spec.secret === true ? '' : value,
      set: value !== '',
      source,
      fromEnv,
    }
  })
}
