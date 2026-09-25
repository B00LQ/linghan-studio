/**
 * 本地备份（M2 的「三根保险丝」里最重要的那一根）。
 *
 * 为什么必须有：按定稿的方案，**画布与原始素材只存在用户自己的机器上**，服务器不存。
 * 那么「重装系统 / 硬盘坏 / 换电脑 / 手滑删了文件夹」就等于作品永久消失。
 * 对一个用户来说是几年的东西 —— 丢一次他就不会再用这个产品了。
 *
 * 备份的东西其实就两样：
 * 1. **数据库快照**（画布、提示词、版本记录）：用 `VACUUM INTO` 做一份一致性快照，
 *    一天一份、保留最近 N 份。它很小（几百 KB），所以可以留很多天。
 * 2. **素材目录的镜像**：素材是**内容寻址**的（文件名就是内容哈希），
 *    所以「目标里没有就复制过去」天然就是增量，而且**永远不会被改写** ——
 *    所有备份点共用同一份镜像目录，不随天数膨胀。
 *
 * 恢复是**重启后生效**的：往数据目录写一个 `restore-pending`，
 * 下次启动时在打开数据库之前把它换上去。理由很实在 ——
 * 运行中替换正在使用的 SQLite 文件，是「把用户数据弄坏」的经典方式；
 * 而重启后生效既安全，又能在界面上说清楚（「已准备好，重启后生效」）。
 *
 * 备份目录可以指到**另一块盘或网盘同步目录**（OneDrive / 坚果云 / 百度网盘…）：
 * 同盘的备份挡不住硬盘坏，这一条的价值全在那儿。`suggestBackupDirs()` 负责探测常见位置。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 一个备份点。 */
export interface BackupPoint {
  /** 目录名（也是时间戳），界面上用来选恢复哪一个。 */
  id: string
  /** 什么时候做的。 */
  createdAt: string
  /** 数据库快照的字节数。 */
  bytes: number
  /** 为什么做的（每天一次 / 手动 / 恢复前自动做的保险）。 */
  reason: string
}

/** 备份的当前状态（设置页要显示的东西）。 */
export interface BackupStatus {
  /** 备份目录的绝对路径。 */
  dir: string
  /** 保留几份。 */
  keep: number
  /** 最近一次备份的时间；从没备份过是空串。 */
  lastAt: string
  /** 最近一次失败的原因；成功是空串。**失败必须让人看见**，不能悄悄失败。 */
  lastError: string
  /** 已有的备份点，新的在前。 */
  points: BackupPoint[]
  /** 素材镜像里有多少个文件、多少字节。 */
  mirrorFiles: number
  mirrorBytes: number
  /** 有没有「已准备好、等重启生效」的恢复。 */
  pendingRestore: string
  /** 探测到的网盘同步目录（可以一键指过去）。 */
  suggestions: { label: string; dir: string }[]
}

/** 备份模块的依赖。 */
export interface BackupDeps {
  /** 数据目录（数据库 + assets 都在里面）。 */
  dataDir: string
  /** 诊断输出。 */
  log: (message: string) => void
  /** 默认保留几份。 */
  keep?: number
}

/** 备份目录名（数据目录下的 `backups/`，可被设置覆盖）。 */
const BACKUPS_DIR = 'backups'

/** 恢复请求文件：存在它就表示「下次启动时用这份快照换掉当前库」。 */
const PENDING_FILE = 'restore-pending'
/** 恢复说明（写给界面看：从哪一份恢复、什么时候点的）。 */
const PENDING_INFO = 'restore-pending.json'

/** 一个时间戳当 id：目录名排序就是时间顺序（`:` 在 Windows 上不合法，换成 `-`）。 */
const stamp = (): string => new Date().toISOString().replace(/[:.]/gu, '-')

/** 目录里有多少文件、多少字节。 */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (current: string): void => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        files += 1
        try {
          bytes += statSync(path).size
        } catch { /* 读不到就只算个数 */ }
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

/**
 * 探测常见的网盘同步目录（存在才返回）。
 *
 * 这一条是「备份放哪」那个向导的关键：用户不知道自己的网盘目录在哪，
 * 但我们能替他找到。**探测不到也没关系** —— 界面里还有「自己选一个文件夹」。
 * @returns 名称与路径，按常见程度排。
 */
export function suggestBackupDirs(): { label: string; dir: string }[] {
  const home = homedir()
  const candidates: { label: string; dir: string }[] = [
    { label: 'OneDrive', dir: process.env.OneDrive ?? join(home, 'OneDrive') },
    { label: '坚果云', dir: join(home, 'Nutstore', '我的坚果云') },
    { label: '坚果云（旧目录）', dir: join(home, 'Nutstore Files') },
    { label: '百度网盘（工作空间）', dir: join(home, 'BaiduNetdiskWorkspace') },
    { label: '百度网盘（下载目录）', dir: join(home, 'Documents', 'BaiduNetdiskDownload') },
    { label: '阿里云盘', dir: join(home, 'AliyunDrive') },
    { label: 'Dropbox', dir: join(home, 'Dropbox') },
    { label: 'iCloud Drive', dir: join(home, 'iCloudDrive') },
    { label: 'Google Drive', dir: join(home, 'Google Drive') },
  ]
  return candidates.filter((item) => item.dir !== '' && existsSync(item.dir))
}

/** 备份模块。 */
export interface Backups {
  /** 当前状态。 */
  status: () => BackupStatus
  /** 改备份目录（设置页/向导里选）。 */
  setDir: (dir: string) => void
  /** 现在做一次备份。 */
  run: (reason?: string) => BackupPoint | string
  /** 准备恢复（重启后生效）。 */
  requestRestore: (id: string) => true | string
  /** 该不该做今天的备份（启动与定时器都用它）。 */
  dueForDaily: () => boolean
}

/**
 * 建备份模块。
 * @param deps - 数据目录、诊断、保留份数。
 * @returns the backups API.
 */
export function createBackups(deps: BackupDeps): Backups {
  const keep = deps.keep ?? 7
  const dataDir = deps.dataDir
  /** 备份目录：存在设置里的那个，默认数据目录下的 `backups/`。 */
  let dir = join(dataDir, BACKUPS_DIR)
  /** 最近一次失败（给人看）。 */
  let lastError = ''

  const snapshotsRoot = (): string => join(dir, 'snapshots')
  const mirrorRoot = (): string => join(dir, 'assets')

  /** 读所有备份点（目录名就是时间戳，倒序）。 */
  const points = (): BackupPoint[] => {
    const root = snapshotsRoot()
    let names: string[] = []
    try {
      names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
    return names.sort().reverse().map((name) => {
      const dbFile = join(root, name, 'studio.sqlite')
      let bytes = 0
      try {
        bytes = statSync(dbFile).size
      } catch { /* 空的备份点也算存在，界面会显示 0 */ }
      let reason = ''
      try {
        reason = readFileSync(join(root, name, 'reason.txt'), 'utf8').trim()
      } catch { /* 老备份没有这个文件 */ }
      return { id: name, createdAt: name.replace(/-(\d\d)-(\d\d)-(\d\d)/u, ':$1:$2.$3').slice(0, 19), bytes, reason }
    })
  }

  /** 删掉超出保留份数的旧备份。 */
  const prune = (): void => {
    const all = points()
    for (const stale of all.slice(keep)) {
      try {
        rmSync(join(snapshotsRoot(), stale.id), { recursive: true, force: true })
        deps.log(`backup: 删掉旧备份 ${stale.id}`)
      } catch { /* 删不掉就留着，不该因此报错 */ }
    }
  }

  /** 把素材目录镜像过去（内容寻址 → 目标里没有才复制，天然增量）。 */
  const mirrorAssets = (): { files: number; bytes: number; failed: number } => {
    const source = join(dataDir, 'assets')
    if (!existsSync(source)) return { files: 0, bytes: 0, failed: 0 }
    let failed = 0
    const copy = (from: string, to: string): void => {
      mkdirSync(to, { recursive: true })
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const sourcePath = join(from, entry.name)
        const targetPath = join(to, entry.name)
        if (entry.isDirectory()) {
          copy(sourcePath, targetPath)
          continue
        }
        if (existsSync(targetPath)) continue
        try {
          copyFileSync(sourcePath, targetPath)
        } catch {
          failed += 1
        }
      }
    }
    try {
      copy(source, mirrorRoot())
    } catch {
      failed += 1
    }
    const measured = measure(mirrorRoot())
    return { ...measured, failed }
  }

  return {
    status() {
      const all = points()
      const mirror = measure(mirrorRoot())
      let pending = ''
      try {
        const info = JSON.parse(readFileSync(join(dataDir, PENDING_INFO), 'utf8')) as { id?: unknown; at?: unknown }
        pending = typeof info.id === 'string' ? info.id : '待恢复'
      } catch { /* 没有待恢复 */ }
      return {
        dir,
        keep,
        lastAt: all[0]?.createdAt ?? '',
        lastError,
        points: all,
        mirrorFiles: mirror.files,
        mirrorBytes: mirror.bytes,
        pendingRestore: pending,
        suggestions: suggestBackupDirs(),
      }
    },

    setDir(next) {
      const target = next.trim()
      if (target === '') return
      dir = target
      mkdirSync(dir, { recursive: true })
      deps.log(`backup: 备份目录改为 ${dir}`)
    },

    run(reason = '手动') {
      lastError = ''
      try {
        mkdirSync(join(snapshotsRoot(), stamp()), { recursive: true })
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        return lastError
      }
      const id = readdirSync(snapshotsRoot()).sort().reverse()[0] as string
      const target = join(snapshotsRoot(), id, 'studio.sqlite')
      try {
        // 单独开一个连接做 `VACUUM INTO`：它不打断正在跑的服务器，产出的是**一致性快照**。
        const source = new DatabaseSync(join(dataDir, 'studio.sqlite'))
        source.exec(`VACUUM INTO '${target.replace(/'/gu, "''")}'`)
        source.close()
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        deps.log(`backup: 失败 ${lastError}`)
        return lastError
      }
      const mirrored = mirrorAssets()
      writeFileSync(join(snapshotsRoot(), id, 'reason.txt'), `${reason}\n`, 'utf8')
      if (mirrored.failed > 0) lastError = `有 ${String(mirrored.failed)} 个素材没复制成功（磁盘满/占用？）`
      prune()
      deps.log(`backup: ${id}（数据库 ${String(Math.round(statSync(target).size / 1024))} KB，素材镜像 ${String(mirrored.files)} 个文件）`)
      const created = points().find((point) => point.id === id)
      return created ?? { id, createdAt: id, bytes: 0, reason }
    },

    requestRestore(id) {
      const source = join(snapshotsRoot(), id, 'studio.sqlite')
      if (!existsSync(source)) return '没有这个备份点'
      // 恢复之前**先把当前状态也备份一份**：恢复错了还能回来。
      this.run('恢复前自动备份')
      try {
        copyFileSync(source, join(dataDir, PENDING_FILE))
        writeFileSync(join(dataDir, PENDING_INFO), JSON.stringify({ id, at: new Date().toISOString() }, null, 2), 'utf8')
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      deps.log(`backup: 已准备从 ${id} 恢复（下次启动生效）`)
      return true
    },

    dueForDaily() {
      const lastAt = points()[0]?.createdAt ?? ''
      if (lastAt === '') return true
      // 目录名是 `2026-09-25T12-30-00-000Z`，还原成时间再比。
      const parsed = Date.parse(lastAt.replace(/T(\d\d)-(\d\d)-(\d\d)/u, 'T$1:$2:$3'))
      if (!Number.isFinite(parsed)) return true
      return Date.now() - parsed > 20 * 60 * 60 * 1000
    },
  }
}

/**
 * 启动时应用「待恢复」的快照。
 *
 * **必须在 `openStore` 之前调用**：运行中替换 SQLite 文件是弄坏用户数据的经典方式，
 * 所以恢复是写一个标记、重启后生效。
 * @param dataDir - 数据目录。
 * @param log - 诊断输出。
 * @returns 有没有真的恢复（界面据此提示「已从备份恢复」）。
 */
export function applyPendingRestore(dataDir: string, log: (message: string) => void): boolean {
  const pending = join(dataDir, PENDING_FILE)
  if (!existsSync(pending)) return false
  const target = join(dataDir, 'studio.sqlite')
  try {
    // WAL/SHM 是上一个库的残留：不删掉的话新库会带着旧日志启动。
    for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true })
    cpSync(pending, target)
    rmSync(pending, { force: true })
    rmSync(join(dataDir, PENDING_INFO), { force: true })
    log('已从备份恢复（这次启动用的是备份里的那份数据）')
    return true
  } catch (error) {
    log(`应用备份失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
