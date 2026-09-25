/**
 * Site content.
 *
 * The home page's showcase area is the operator's, not the user's: it is served
 * read-only to everyone and edited in one place. For now that place is a JSON
 * file in the data directory (`<dataDir>/site.json`) — updating the home page
 * must not require rebuilding the app or shipping a release.
 *
 * When the accounts/credits service exists (batch F), this same shape moves
 * behind it; the client only ever calls `GET /api/site`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One capability entry shown on the home page. */
export interface SiteCapability {
  /** Stable id. */
  id: string
  /** Label. */
  title: string
  /** One-line explanation. */
  description: string
  /** Whether it works today; `planned` entries are shown but not clickable. */
  status: 'ready' | 'planned'
}

/** One differentiator card. */
export interface SiteHighlight {
  /** Stable id. */
  id: string
  /** Card title. */
  title: string
  /** Card body. */
  body: string
}

/** One showcase entry. */
export interface SiteShowcaseItem {
  /** Stable id. */
  id: string
  /** Title. */
  title: string
  /** Author, when credited. */
  author?: string
  /** Cover image URL, when there is one. */
  image?: string
  /** Category id this item belongs to. */
  category: string
}

/** The whole site document. */
export interface SiteContent {
  /** Brand block. */
  brand: { name: string; tagline: string }
  /** Capability entries. */
  capabilities: SiteCapability[]
  /** Differentiator cards. */
  highlights: SiteHighlight[]
  /** Showcase wall. */
  showcase: {
    /** Category tabs; `all` is implicit. */
    categories: { id: string; title: string }[]
    /** Entries. */
    items: SiteShowcaseItem[]
  }
}

/**
 * The content a fresh install shows.
 *
 * Deliberately about *this* product rather than borrowed marketing: the three
 * things that are actually true of a local-first tool, and an honest note on
 * what is not built yet.
 */
export const DEFAULT_SITE: SiteContent = {
  brand: {
    name: 'Studio',
    tagline: '本地算力的 AI 创作台',
  },
  capabilities: [
    { id: 'local-image', title: '本地出图', description: '接你自己的 ComfyUI，热态约 6 秒一张', status: 'ready' },
    // 文本这条按「能配什么」写：任何 OpenAI 兼容的 LLM 都能接（ChatGPT / DeepSeek /
    // Moonshot / 火山方舟…），没配 key 时是占位文本 —— 那句话得说出来，否则人以为
    // 是模型写得差。
    { id: 'text', title: '文本', description: '写故事、场景与角色设定；接任意 OpenAI 兼容的 LLM（未配置时返回占位文本）', status: 'ready' },
    // 视频这条按实测写：MiniMax H3 在 12 GB 卡上 768p 一条 5 秒片约十几分钟，
    // 「热态 6 秒一张」那种速度的话不能套用，说了反而误导。
    // 4 步蒸馏那条**先不写倍数**：采样步数确实减半，但端到端还压着模型装载与解码
    // 两笔固定开销，倍数只有量出来才算数。
    { id: 'video', title: '视频生成（含音频）', description: 'MiniMax H3 本地出片，5 秒 768p 约十几分钟；另有 4 步蒸馏工作流', status: 'ready' },
    { id: 'audio', title: '音频生成', description: '待接入语音供应商', status: 'planned' },
    { id: 'edit', title: '智能剪辑', description: '待接入', status: 'planned' },
    { id: 'director', title: '导演台', description: '待接入', status: 'planned' },
  ],
  highlights: [
    { id: 'local', title: '算力在你自己手里', body: '用本机显卡出图，不排队、不按次计费；断网也能继续。' },
    { id: 'own', title: '作品归你自己', body: '画布与素材存在本地，随时可整体备份带走。' },
    { id: 'audit', title: '每一次生成都留痕', body: '提示词、种子、耗时、失败原因都记着，能复现、能重拍。' },
  ],
  showcase: {
    categories: [
      { id: 'all', title: '全部' },
      { id: 'scene', title: '场景' },
      { id: 'character', title: '角色' },
      { id: 'product', title: '产品' },
    ],
    // 空展示墙是诚实的默认值：不放别人的作品冒充自己的。
    items: [],
  },
}

/** Where an operator can override the content without touching code. */
export const SITE_FILE = 'site.json'

/**
 * Read the effective site content: the override file when present and valid,
 * otherwise the built-in default.
 * @param dataDir - directory holding the override file.
 * @param log - diagnostics sink.
 * @returns the content to serve.
 */
export function loadSiteContent(dataDir: string, log: (message: string) => void): SiteContent {
  const path = join(dataDir, SITE_FILE)
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') throw new Error('顶层不是对象')
    const candidate = parsed as Partial<SiteContent>
    // Merge over the default so a partial file still yields a complete page.
    return {
      brand: { ...DEFAULT_SITE.brand, ...(candidate.brand ?? {}) },
      capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities : DEFAULT_SITE.capabilities,
      highlights: Array.isArray(candidate.highlights) ? candidate.highlights : DEFAULT_SITE.highlights,
      showcase: {
        categories: Array.isArray(candidate.showcase?.categories) ? candidate.showcase.categories : DEFAULT_SITE.showcase.categories,
        items: Array.isArray(candidate.showcase?.items) ? candidate.showcase.items : [],
      },
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // A missing file is the normal case; a broken one is worth a line.
    if (!reason.includes('ENOENT')) log(`site: ${SITE_FILE} 读取失败（${reason}），使用内置默认内容`)
    return DEFAULT_SITE
  }
}
