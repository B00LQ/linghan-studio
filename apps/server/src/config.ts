/** Environment-driven configuration for the Studio server. */
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Fully resolved server configuration. */
export interface StudioConfig {
  /**
   * 运行模式。
   *
   * - `local`（默认）：今天这套 —— 画布、素材、算力、作业都在本机，一个访问密码。
   *   桌面端自带的那份服务、自托管的人用的都是它。
   * - `cloud`：服务器上的那一份 —— **只有账号**（M1），以后加作品与主页（M3）。
   *   画布类接口在 cloud 模式下**明确不可用**（那些东西只在用户机器上）。
   *
   * 为什么不是一个开关切换两套代码：两种模式共用存储层、配置与 HTTP 脚手架，
   * 分叉只发生在「暴露哪些路由」这一层。
   */
  mode: StudioMode
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
  /** ComfyUI base URL, used by the `comfyui` driver. 远端实例（用户自己租的云工坊）也填这儿。 */
  comfyuiUrl: string
  /**
   * 远端 ComfyUI 的鉴权头（Authorization: Bearer xxx / X-API-Key: xxx）。
   *
   * 本机实例留空；用户自己租的云实例通常挂在反向代理后面，需要它。
   * 「凭据只存本机」是定稿方案的一条：这个值不进服务器，也不下发到任何地方。
   */
  comfyuiAuth: string
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
  /** 云服务地址（服务器端）；本地模式拿它做「绑定账号」与发布作品。空串 = 没配。 */
  cloudUrl: string
  /** 对外可访问的地址，用于邮件里的验证/重置链接；空串时按 `http://127.0.0.1:<port>` 推。 */
  publicUrl: string
  /**
   * 邮件转发地址（webhook）。
   *
   * 空串 = **把邮件打到日志里**（开发与测试用，不需要任何外部服务）。
   * 配了就把 `{to, subject, text}` POST 过去，由你自己的转发服务去发 ——
   * 真实服务商（阿里云邮件推送 / SES / SMTP）留到 M4 再接，那时也能拿真凭据测。
   */
  mailWebhookUrl: string
  /**
   * 每个账号能上传多少 MB（云端配额，`STUDIO_QUOTA_MB`，默认 2048）。
   *
   * 配额按**上传到服务器的字节**算（`asset.owner_id`），不按作品条数：
   * 一条 4K 视频比一千张缩略图还占地方，按条数算等于没有配额。
   */
  userQuotaMb: number
  /**
   * 只读降级（`STUDIO_READONLY=1`）。
   *
   * 打开之后**所有写操作都被拒**、读照常 —— 磁盘快满、数据库要维护、
   * 或者出了事故要先把站点定住的时候，这是比"整站 500"好得多的形态。
   * 另外磁盘可用空间低于 200 MB 时会**自动**进入这个状态（自检在 degrade.ts）。
   */
  readonly: boolean
  /**
   * 前面确实挂了反向代理（`STUDIO_TRUST_PROXY=1`）时才认 `x-forwarded-for`。
   *
   * 没有反代却打开它 = 让攻击者自己填一个来源地址来绕过限流。
   */
  trustProxy: boolean
  /** 机审 webhook 地址；空 = 没配（跳过机审，全部靠人工审核）。 */
  moderationUrl: string
  /** 机审的鉴权 key。 */
  moderationKey: string
  /**
   * 机审接口挂了的时候：true = 拒绝发布，false = 放行等人工（默认）。
   *
   * 默认选"放行"是因为**人工审核本来就在后面**（每件作品都要管理员点通过），
   * 而一个坏掉的外部接口不该让整站发不出东西。
   */
  moderationFailClosed: boolean
  /**
   * 告警 webhook（`STUDIO_ALERT_WEBHOOK`）：进入只读时 POST 一句 `{"text": "…"}`。
   *
   * 空 = 不告警（只打日志）。这是"监控告警"那一项的最小实现：
   * 它要能自己找到你，而不是等你某天打开设置页才发现站点早就只读了。
   */
  alertWebhook: string
}

/** 运行模式。 */
export type StudioMode = 'local' | 'cloud'

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
  group: 'image' | 'text' | 'audio' | 'update' | 'account'
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
  {
    key: 'COMFYUI_AUTH',
    label: '远端 ComfyUI 鉴权',
    group: 'image',
    secret: true,
    hint: '只在用自己租的云实例时填；形如 Authorization: Bearer xxx（本机留空）',
    placeholder: 'Authorization: Bearer …',
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
    key: 'STUDIO_CLOUD_URL',
    label: '云服务地址',
    group: 'account',
    hint: '服务器端那一份的地址（用来绑定账号、发布作品）；只在你想发布作品时才需要',
    placeholder: 'https://studio.example.com',
  },
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

/** 开关：`1` / `true` / `yes` / `on` 都算开。 */
function flag(value: string): boolean {
  const raw = value.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
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
  const mode = pick('STUDIO_MODE')
  const port = intEnv('PORT', previous?.port ?? 8080)
  return {
    // 只有显式写了 `cloud` 才是云模式：一个拼错的变量名不该悄悄把路由换成另一套。
    mode: mode === 'cloud' ? 'cloud' : 'local',
    port,
    host: process.env.HOST?.trim() || previous?.host || '0.0.0.0',
    password,
    dataDir: resolve(dataDir !== '' ? dataDir : join(homedir(), '.studio')),
    imageDriver: driver === 'comfyui' || driver === 'ark' ? driver : 'stub',
    comfyuiUrl: pick('COMFYUI_URL') || 'http://127.0.0.1:8188',
    comfyuiAuth: pick('COMFYUI_AUTH'),
    arkApiKey: pick('ARK_API_KEY'),
    arkBaseUrl: pick('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3',
    arkModel: pick('ARK_MODEL') || 'doubao-seedream-4-0-250828',
    // A per-process secret is fine for a single instance; multi-instance
    // deployments must pin STUDIO_SECRET so sessions survive a restart.
    // **重解析时要沿用旧的那个**：否则改一次设置就把所有人踢下线。
    cookieSecret: pick('STUDIO_SECRET') || previous?.cookieSecret || randomBytes(32).toString('base64url'),
    updateUrl: pick('STUDIO_UPDATE_URL'),
    cloudUrl: pick('STUDIO_CLOUD_URL'),
    publicUrl: pick('STUDIO_PUBLIC_URL'),
    mailWebhookUrl: pick('STUDIO_MAIL_WEBHOOK'),
    userQuotaMb: intEnv('STUDIO_QUOTA_MB', 2048),
    readonly: flag(pick('STUDIO_READONLY')),
    trustProxy: flag(pick('STUDIO_TRUST_PROXY')),
    moderationUrl: pick('MODERATION_URL'),
    moderationKey: pick('MODERATION_KEY'),
    moderationFailClosed: flag(pick('MODERATION_FAIL_CLOSED')),
    alertWebhook: pick('STUDIO_ALERT_WEBHOOK'),
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
