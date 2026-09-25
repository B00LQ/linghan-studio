/**
 * 机审预筛（M4）。
 *
 * 这一层解决的问题是**「人工审核是最后一道，但不该是第一道」**：管理员点「通过」之前，
 * 明显不该过的内容应该已经被挡下来了（不然深夜发一条，第二天早上才能处理）。
 *
 * 一个刻意的取舍：**默认"没配 = 跳过"，不是"没配 = 全拦"**。
 * 拦下来会让整站发不出东西（一个坏掉的外部接口不该有这种权力），
 * 而放过去的东西**仍然要人工点通过**才会上主页 —— 人工就是兜底。
 * 运营上要更严的话，把 `MODERATION_FAIL_CLOSED=1` 打开：那时接口挂了 = 拒绝发布。
 *
 * 适配器形态：一个**通用 webhook**
 * ```json
 * POST <MODERATION_URL>            Authorization: Bearer <MODERATION_KEY>
 * { "kind": "text", "text": "标题\n简介\n标签" }
 * ← { "pass": false, "label": "色情", "reason": "…" }
 * ```
 * 阿里云内容安全 / 腾讯云天御的专用适配器要等真凭据才能测，所以没有先写一个"大概能跑"的。
 *
 * **图片机审故意没接**：那需要把字节或一个公网可取的地址交给服务商，
 * 而现在素材只能通过作品取（没有公开素材库）—— 这道口子要等你确认服务商怎么取图再开。
 */
/** 机审配置。 */
export interface ModerationConfig {
  /** webhook 地址；空 = 没配。 */
  url: string
  /** 鉴权 key（`Authorization: Bearer <key>`）。 */
  key: string
  /** 接口挂了/答非所问时：true = 拒绝发布，false = 放行（默认）。 */
  failClosed: boolean
  /** 超时（毫秒），默认 5 秒。 */
  timeoutMs?: number
}

/** 一次预筛的结论。 */
export interface ModerationVerdict {
  /** 放行 = true。 */
  pass: boolean
  /** 命中的类别（服务商给的原文）。 */
  label: string
  /** 给人看的理由。 */
  reason: string
  /** 这一条没经过机审（没配、或者接口挂了且 failClosed 关着）。 */
  skipped: boolean
}

/** 预筛器。 */
export interface Moderator {
  /** 配了没有（界面上要如实显示）。 */
  configured: boolean
  /** 筛一段文字。 */
  screenText: (text: string) => Promise<ModerationVerdict>
}

/**
 * 建一个机审适配器。
 * @param config - webhook 地址、key 与失败策略。
 * @param log - 一行日志。
 * @returns the moderator.
 */
export function createModeration(config: ModerationConfig, log: (message: string) => void): Moderator {
  const configured = config.url.trim() !== ''
  const timeoutMs = config.timeoutMs ?? 5_000
  const allow = (reason: string, skipped: boolean): ModerationVerdict => ({ pass: true, label: '', reason, skipped })

  return {
    configured,
    async screenText(text) {
      if (!configured) return allow('机审未配置，靠人工审核', true)
      if (text.trim() === '') return allow('没有可筛的文字', true)
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, timeoutMs)
      try {
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.key === '' ? {} : { authorization: `Bearer ${config.key}` }),
          },
          body: JSON.stringify({ kind: 'text', text }),
          signal: controller.signal,
        })
        if (!response.ok) {
          log(`机审接口回了 HTTP ${String(response.status)}`)
          return config.failClosed
            ? { pass: false, label: '', reason: `机审接口不可用（HTTP ${String(response.status)}）`, skipped: false }
            : allow(`机审接口不可用（HTTP ${String(response.status)}），已放行等人工`, true)
        }
        const payload = await response.json() as { pass?: unknown; label?: unknown; reason?: unknown }
        if (typeof payload.pass !== 'boolean') {
          // 答非所问也要说清楚：**不能把"看不懂的回答"当成"通过"**而不留痕。
          log('机审接口的回答里没有 pass 字段')
          return config.failClosed
            ? { pass: false, label: '', reason: '机审接口回答无法解析', skipped: false }
            : allow('机审接口回答无法解析，已放行等人工', true)
        }
        if (payload.pass) return { pass: true, label: '', reason: '', skipped: false }
        return {
          pass: false,
          label: typeof payload.label === 'string' ? payload.label : '未分类',
          reason: typeof payload.reason === 'string' ? payload.reason : '机审判定不宜发布',
          skipped: false,
        }
      } catch (error) {
        const why = error instanceof Error && error.name === 'AbortError' ? `机审超时（${String(timeoutMs)}ms）` : `机审调用失败：${error instanceof Error ? error.message : String(error)}`
        log(why)
        return config.failClosed ? { pass: false, label: '', reason: why, skipped: false } : allow(`${why}，已放行等人工`, true)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
