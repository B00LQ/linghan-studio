/**
 * 只读降级（M4）。
 *
 * 「敢对外公开运营」的第一条不是功能多，是**出事的时候站点别整个躺下**。
 * 最常见的两种事故都跟磁盘有关：素材把盘写满，或者数据库要维护。
 * 这两种情况下最糟的反应是继续接受写入 —— 写一半失败会留下半个文件、
 * 半个作品、半个会话，比干脆拒绝难收拾得多。
 *
 * 所以这里做两件事：
 *
 * 1. `STUDIO_READONLY=1` 时**人为**进入只读（部署时想定住站点就打开它）；
 * 2. 磁盘可用空间低于阈值时**自动**进入只读，并在日志里说清楚为什么。
 *
 * 只读期间刻意保留的活路（见 index.ts 的白名单）：登录、刷新会话、备份与恢复。
 * 一个进不去、也救不回来的只读模式等于把运维锁在门外。
 *
 * 自检每 30 秒最多一次：`statfs` 是系统调用，每个请求都做没必要。
 */
import { statfsSync } from 'node:fs'

/** 低于这个可用空间就自动只读。 */
export const LOW_DISK_MB = 200

/** 现在的降级状态。 */
export interface DegradeState {
  /** 只读中 = true（写操作被拒）。 */
  readonly: boolean
  /** 为什么只读（给人看的一句话）。 */
  reason: string
  /** 数据目录所在盘的可用空间（MB）。 */
  freeMb: number
  /** 这个状态是自动判断出来的，还是人为打开的。 */
  automatic: boolean
}

/** 只读闸门。 */
export interface Degrader {
  /** 读当前状态（必要时重新自检）。 */
  state: () => DegradeState
  /** 强制刷新（测试与"我刚清完磁盘"用）。 */
  refresh: () => DegradeState
}

/**
 * 建一个只读闸门。
 * @param opts - 数据目录、人为开关、以及可注入的取空间函数（测试用）。
 * @returns the degrader.
 */
export function createDegrade(opts: {
  dataDir: string
  forced: boolean
  /** 磁盘可用字节；默认用 `statfsSync`，拿不到就返回 undefined。 */
  freeBytes?: (dir: string) => number | undefined
  now?: () => number
}): Degrader {
  const now = opts.now ?? Date.now
  const read = opts.freeBytes ?? ((dir: string): number | undefined => {
    try {
      const stats = statfsSync(dir)
      return stats.bsize * stats.bavail
    } catch {
      // 拿不到就是"不知道"。**不知道不能变成"拒绝服务"** —— 那会让一个
      // 探测失败（比如数据目录在网络盘上）变成整站写不进去。
      return undefined
    }
  })

  let cached: DegradeState = {
    readonly: opts.forced,
    reason: opts.forced ? '运维把服务设成了只读（STUDIO_READONLY）' : '',
    freeMb: -1,
    automatic: false,
  }
  let checkedAt = 0

  const probe = (): DegradeState => {
    const free = read(opts.dataDir)
    const freeMb = free === undefined ? -1 : Math.floor(free / 1024 / 1024)
    if (opts.forced) {
      cached = { readonly: true, reason: '运维把服务设成了只读（STUDIO_READONLY）', freeMb, automatic: false }
      return cached
    }
    if (freeMb >= 0 && freeMb < LOW_DISK_MB) {
      cached = { readonly: true, reason: `磁盘可用空间只剩 ${String(freeMb)} MB（低于 ${String(LOW_DISK_MB)} MB），先停下写入`, freeMb, automatic: true }
      return cached
    }
    cached = { readonly: false, reason: '', freeMb, automatic: false }
    return cached
  }

  return {
    state() {
      const at = now()
      if (at - checkedAt < 30_000) return cached
      checkedAt = at
      return probe()
    },
    refresh() {
      checkedAt = now()
      return probe()
    },
  }
}
