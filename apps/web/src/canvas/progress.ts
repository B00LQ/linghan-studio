/**
 * Generation progress and time estimates.
 *
 * Pure on purpose: what the operator sees next to the generate button is a
 * formatting decision with edge cases (no estimate yet, steps without a total,
 * a batch of four, a run that overran its estimate), and those are easier to
 * pin down in a test than in a component.
 *
 * The shape is negotiated: `supportsSteps` comes from the server, which asks the
 * active driver. A provider that reports nothing still gets a useful display,
 * so adding a cloud backend cannot break this.
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
  /** Whether the active driver reports steps at all. */
  supportsSteps: boolean
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

/**
 * Describe what is happening with one node's generation.
 * @param input - see {@link ProgressInput}.
 * @returns the label, bar fill, and remaining time.
 */
export function describeProgress(input: ProgressInput): ProgressView {
  const { running, progress, estimateMs, elapsedMs, supportsSteps } = input
  if (!running) {
    // Idle: an ETA learned from this machine's own history, or nothing at all.
    return { text: estimateMs > 0 ? `约 ${String(seconds(estimateMs))} 秒` : '', fraction: null, remainingMs: null }
  }

  const value = progress?.value
  const max = progress?.max
  const countable = supportsSteps && typeof value === 'number' && typeof max === 'number' && max > 0
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
  if (remainingMs !== null) parts.push(remainingMs === 0 ? '即将完成' : `预计 ${String(seconds(remainingMs))} 秒`)

  return { text: parts.join(' · '), fraction, remainingMs }
}
