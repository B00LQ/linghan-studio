/**
 * 限流（M4）。
 *
 * 为什么要有：`/api/v1/auth/login` 与 `/api/v1/works/assets` 都在公网上。
 * 没有限流的话，一个脚本可以拿字典撞密码、也可以把磁盘塞满 —— 这两件事
 * 都不是"以后再说"的问题，是公开运营的前置条件。
 *
 * 三个刻意的选择：
 *
 * 1. **滑动窗口、按 key 计数**，不是固定窗口：固定窗口在窗口边界上能放过两倍流量，
 *    也正是撞库最喜欢钻的那一瞬。
 * 2. **计数器只在内存里**。单进程部署下这是对的（重启即清零，代价可接受）；
 *    多实例时它退化成"每个实例各限一份"，这条限制写在文档里，不假装它不存在。
 * 3. **只认 `x-forwarded-for` 的第一个地址，而且必须显式打开**（`STUDIO_TRUST_PROXY=1`）。
 *    没有反代却信这个头，等于让攻击者自己填一个 key 来绕过限流。
 */
import type { IncomingHttpHeaders } from 'node:http'

/** 一条限流规则。 */
export interface RateLimitRule {
  /** 窗口长度（毫秒）。 */
  windowMs: number
  /** 窗口内允许的次数。 */
  max: number
}

/** 一次限流的判定结果。 */
export interface RateLimitDecision {
  /** 放行 = true。 */
  ok: boolean
  /** 被拦时：还要等几秒（给 `Retry-After`）。 */
  retryAfterSec: number
  /** 当前窗口里已经记了几次（含这一次需要时）。 */
  hits: number
}

/** 计数器。 */
export interface RateLimiter {
  /** 记一次。被拦的那一次**也记**，否则持续攻击会一直踩在阈值上却永远不延长等待。 */
  hit: (key: string, rule: RateLimitRule) => RateLimitDecision
  /** 清掉（`prefix` 为空 = 全清；测试与"登录成功后清零"用）。 */
  reset: (prefix?: string) => void
  /** 现在跟踪着多少个 key（给状态页/测试看）。 */
  size: () => number
}

/**
 * 建一个内存限流器。
 * @param now - 取当前时间（测试注入用）。
 * @returns the limiter.
 */
export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const table = new Map<string, number[]>()

  const prune = (key: string, windowMs: number, at: number): number[] => {
    const kept = (table.get(key) ?? []).filter((stamp) => at - stamp < windowMs)
    table.set(key, kept)
    return kept
  }

  return {
    hit(key, rule) {
      const at = now()
      const kept = prune(key, rule.windowMs, at)
      if (kept.length >= rule.max) {
        const oldest = kept[0] ?? at
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + rule.windowMs - at) / 1000)), hits: kept.length }
      }
      kept.push(at)
      // 顺手回收：一个 key 一次都没留下说明它已经过期，表不该无限长。
      if (table.size > 4_000) {
        for (const [other, stamps] of table) {
          if (stamps.length === 0 || at - (stamps[stamps.length - 1] ?? 0) > 3_600_000) table.delete(other)
        }
      }
      return { ok: true, retryAfterSec: 0, hits: kept.length }
    },
    reset(prefix) {
      if (prefix === undefined || prefix === '') { table.clear(); return }
      for (const key of [...table.keys()]) {
        if (key.startsWith(prefix)) table.delete(key)
      }
    },
    size() { return table.size },
  }
}

/**
 * 这次请求的来源地址。
 *
 * `trustProxy` 为真时才有资格看 `x-forwarded-for`（部署清单里会写清楚：
 * 只有前面确实挂了 Nginx/Caddy 才打开它）。
 * @param headers - request headers.
 * @param remote - socket 的对端地址。
 * @param trustProxy - 是否信任反代头。
 * @returns an address to count against.
 */
export function clientIp(headers: IncomingHttpHeaders, remote: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-for']
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const first = (raw ?? '').split(',')[0]?.trim()
    if (first !== undefined && first !== '') return first
  }
  return remote === undefined || remote === '' ? 'unknown' : remote
}
