/**
 * Generation progress and time estimates.
 *
 * Pure on purpose: what the operator sees next to the generate button is a
 * formatting decision with edge cases (no estimate yet, steps without a total,
 * a batch of four, a run that overran its estimate), and those are easier to
 * pin down in a test than in a component.
 *
 * **步数是数据说了算。** 服务端问过驱动「你报不报步数」，但那个答案不该在这里当闸门：
 * 它是客户端挂载时取一次的，而失败的那一次（服务重启、网络抖一下）会把整页的进度显示
 * 永久降级成「生成中」——数字明明每一步都在推过来。谁送来了 `value`/`max`，就报谁；
 * 驱动什么都不送时 `progress` 是空的，自然只说「生成中」，所以这层协商并没有丢，它只是
 * 不再有权否定已经送到的数据。
 */

/** One progress report, as the server sends it. */
export interface NodeProgress {
  /** Step finished. */
  value?: number
  /** Steps total. */
  max?: number
  /** Stage name: `queued` | `sampling` | `saving`. */
  stage?: string
  /** 1-based index of the image being produced, when the batch has several. */
  image?: number
  /** Size of the batch. */
  images?: number
}

/** Everything the display depends on. */
export interface ProgressInput {
  /** Whether a generation is in flight for this node. */
  running: boolean
  /** Latest report, when one arrived. */
  progress: NodeProgress | null
  /** Historical median duration in milliseconds; 0 when there is no history. */
  estimateMs: number
  /** How long the current run has been going, in milliseconds. */
  elapsedMs: number
}

/** What to render. */
export interface ProgressView {
  /** Short label, empty when there is nothing worth saying. */
  text: string
  /** 0–1 fill for the bar, or null when progress is not countable. */
  fraction: number | null
  /** Milliseconds left against the estimate, or null when unknown. */
  remainingMs: number | null
}

/** Seconds, rounded, never below 1 — "0 秒" reads like a stall. */
function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000))
}

/** A span that can run long: 46 秒, 3 分, 11 分 6 秒. */
function duration(ms: number): string {
  const total = seconds(ms)
  if (total < 90) return `${String(total)} 秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(rest)} 秒`
}

export { duration as formatDuration }

/**
 * Describe what is happening with one node's generation.
 * @param input - see {@link ProgressInput}.
 * @returns the label, bar fill, and remaining time.
 */
export function describeProgress(input: ProgressInput): ProgressView {
  const { running, progress, estimateMs, elapsedMs } = input
  if (!running) {
    // Idle: an ETA learned from this machine's own history, or nothing at all.
    return { text: estimateMs > 0 ? `约 ${String(seconds(estimateMs))} 秒` : '', fraction: null, remainingMs: null }
  }

  const value = progress?.value
  const max = progress?.max
  const countable = typeof value === 'number' && typeof max === 'number' && max > 0
  const fraction = countable ? Math.min(1, value / max) : null

  const remainingMs = estimateMs > 0 ? Math.max(0, estimateMs - elapsedMs) : null
  const parts: string[] = []
  if (countable) parts.push(`${String(value)}/${String(max)} 步`)
  else if (progress?.stage === 'queued') parts.push('排队中')
  else if (progress?.stage === 'saving') parts.push('保存中')
  else parts.push('生成中')
  if (typeof progress?.images === 'number' && progress.images > 1 && typeof progress.image === 'number') {
    parts.push(`第 ${String(progress.image)}/${String(progress.images)} 张`)
  }
  // 估算用完之后**不再许诺**：从前这里写「即将完成」，而一条超时的活儿可能还要跑
  // 十分钟（12 GB 卡上的视频就是），那四个字就成了假话。改成说事实——已经跑了多久，
  // 它每秒都在长，正好回答「是不是卡住了」。
  if (remainingMs !== null) {
    parts.push(remainingMs === 0 ? `已用 ${duration(elapsedMs)}` : `预计 ${String(seconds(remainingMs))} 秒`)
  }

  return { text: parts.join(' · '), fraction, remainingMs }
}
