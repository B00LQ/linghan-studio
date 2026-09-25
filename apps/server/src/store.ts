/**
 * Studio domain store.
 *
 * One SQLite file holds the directing model — canvases, documents, shots, takes —
 * plus the content-addressed asset index. Canvas documents live here rather than
 * in the browser so a project survives a device change and can be shared.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** A folder: the bucket a creator's canvases live in.
 *
 * Called 文件夹 in the interface, and **not** a tier you navigate: the canvas page
 * never mentions it. It is a label you can put on a canvas and filter by, which
 * is what the reference product's 「移动至文件夹」 does. */
export interface StudioFolder {
  /** Stable folder id. */
  id: string
  /** Display name. */
  name: string
  /** Creation timestamp (ISO-8601). */
  createdAt: string
  /** Last update timestamp (ISO-8601). */
  updatedAt: string
  /** How many live canvases it holds. */
  canvasCount: number
}

/** A creation project: one canvas. */
export interface StudioCanvas {
  /** Stable project id. */
  id: string
  /** Display name. */
  name: string
  /** Owning folder id; empty means "no folder". */
  folderId: string
  /** Cover asset id, or empty to fall back to the canvas's own picture. */
  coverAssetId: string
  /** When it was moved to the trash, or empty while it is live. */
  deletedAt: string
  /**
   * An asset to use as the card thumbnail when no cover has been chosen.
   *
   * Picked from the images the canvas actually contains, so a fresh canvas shows
   * its own work instead of a grey placeholder. Random per read, because a wall
   * of identical covers from the same canvas is not a wall you can scan.
   */
  previewAssetId: string
  /** Creation timestamp (ISO-8601). */
  createdAt: string
  /** Last update timestamp (ISO-8601). */
  updatedAt: string
}

/** One shot inside a canvas. */
export interface StudioShot {
  /** Stable shot id. */
  id: string
  /** Owning canvas id. */
  canvasId: string
  /** Story order within the canvas. */
  index: number
  /** Short human label. */
  title: string
  /** Prompt draft carried into generation. */
  prompt: string
  /** Directing status. */
  status: string
  /** Take the operator marked as the one to use, when they have chosen. */
  selectedTakeId: string
}

/** One generation attempt for a shot. */
export interface StudioTake {
  /** Stable take id. */
  id: string
  /** Owning shot id. */
  shotId: string
  /** Provider that produced it. */
  providerId: string
  /** Model id used. */
  model: string
  /** Outcome of the attempt. */
  status: string
  /** Asset id of the produced frame, when one exists. */
  assetId: string
  /** The request that produced this take — prompt, size, count — so a take can be re-run. */
  params: Record<string, unknown>
  /** Sampler seed, when the provider reported one. */
  seed?: number
  /** Wall-clock duration of the attempt in milliseconds. */
  latencyMs?: number
  /** Failure text, when the attempt failed. */
  error?: string
  /** Whether the operator picked this take. */
  mark: 'none' | 'selected'
  /** Creation timestamp (ISO-8601). */
  createdAt: string
}

/** Fields recorded for one generation attempt. */
export interface NewTake {
  /** Owning shot id. */
  shotId: string
  /** Provider that produced it. */
  providerId: string
  /** Model id used. */
  model: string
  /** Outcome of the attempt. */
  status: string
  /** Asset id of the produced frame, when one exists. */
  assetId?: string
  /** The request that produced this take. */
  params?: Record<string, unknown>
  /** Sampler seed, when known. */
  seed?: number
  /** Wall-clock duration in milliseconds. */
  latencyMs?: number
  /** Failure text, when the attempt failed. */
  error?: string
}

/** A stored media file. */
export interface StudioAsset {
  /** Asset id (content hash, so identical bytes deduplicate). */
  id: string
  /** Media kind. */
  kind: string
  /** MIME type. */
  mime: string
  /** Size in bytes. */
  bytes: number
  /** Path relative to the asset root. */
  relPath: string
  /** Creation timestamp (ISO-8601). */
  createdAt: string
  /** Owning asset folder id; empty means 未分组. */
  folderId: string
}

/**
 * 素材文件夹。
 *
 * 和画布的文件夹（`StudioFolder`）是**两回事**，所以两张表、两个接口：一个是「这张画布
 * 归到哪一组」，一个是「这张图归到哪一组」。合成一张表会让人以为「把图移进文件夹」
 * 会影响画布，而它不会。
 */
export interface StudioAssetFolder {
  /** Stable folder id. */
  id: string
  /** Display name. */
  name: string
  /** Creation timestamp (ISO-8601). */
  createdAt: string
  /** How many assets it holds. */
  assetCount: number
}

/**
 * 一个账号。
 *
 * 只在 `cloud` 模式里用（见 `StudioConfig.mode`）：`local` 模式是「一个访问密码」，
 * 没有也不需要账号。密码哈希用 `scrypt`（`node:crypto`），**不引入任何依赖**。
 */
export interface StudioUser {
  /** Stable user id. */
  id: string
  /** Login email, stored lowercase. */
  email: string
  /** Display name; empty means "use the part before @". */
  displayName: string
  /** `admin` 能进管理后台（M3）；第一个注册的账号自动是 admin。 */
  role: 'admin' | 'user'
  /** `banned` 之后不能再登录（会话也一起撤销）。 */
  status: 'active' | 'banned'
  /** 邮箱验证时间；空 = 还没验证（能登录，但发布作品要验证，见 M3）。 */
  emailVerifiedAt: string
  /** Creation timestamp (ISO-8601). */
  createdAt: string
  /** Last successful login, empty before the first one. */
  lastLoginAt: string
}

/** 一个登录会话（一台设备）。 */
export interface StudioSession {
  /** Stable session id；管理界面用它撤销单台设备。 */
  id: string
  /** Owning user. */
  userId: string
  /** 设备名（用户自己填的，或者客户端报的）。 */
  label: string
  /** Access token 过期时间。 */
  accessExpiresAt: string
  /** Refresh token 过期时间。 */
  refreshExpiresAt: string
  /** 撤销时间；空 = 还活着。 */
  revokedAt: string
  /** Creation timestamp. */
  createdAt: string
  /** 最后一次用到它的时间。 */
  lastSeenAt: string
}

/** How long generation has actually been taking, for the ETA display. */
export interface GenerationStats {
  /** Duration samples behind the numbers. */
  samples: number
  /** Median duration in milliseconds, or 0 when there is nothing to go on. */
  medianMs: number
  /** 90th-percentile duration in milliseconds, or 0. */
  p90Ms: number
  /** Durations of the most recent successful runs, newest first. */
  recentMs: number[]
  /**
   * The same numbers per produced asset kind, so a node can ask about its own
   * medium: a video takes minutes where a picture takes seconds, and a single
   * median covering both is wrong for both.
   */
  byKind: Record<string, { samples: number; medianMs: number; p90Ms: number }>
  /**
   * The same numbers per `kind/workflow`, keyed e.g. `video/minimax-h3-video-fast`.
   *
   * 为什么还要再分一层：同是视频，8 步和工作流 4 步的耗时差着近一倍。只按类型分档时
   * 它们的样本会算进同一个中位数，于是**两边都偏**——这正是「拿图片的中位数去预计
   * 视频」那个错误的小号版本。样本不够时**不要**退回这一档，退回的是 `byKind`。
   */
  byWorkflow: Record<string, { samples: number; medianMs: number; p90Ms: number }>
}

/** Domain surface used by the HTTP layer. */
export interface StudioStore {
  /** List folders, oldest first. */
  listFolders: () => StudioFolder[]
  /** Create a folder. */
  createFolder: (name: string) => StudioFolder
  /** Read a folder, or undefined when it does not exist. */
  getFolder: (id: string) => StudioFolder | undefined
  /** Rename a folder. */
  renameFolder: (id: string, name: string) => boolean
  /** Delete a folder; its canvases survive and become unfiled. */
  deleteFolder: (id: string) => boolean
  /**
   * List canvases, newest first.
   * @param options - `folderId` narrows to one folder, `trashed` reads the trash.
   */
  listCanvases: (options?: { folderId?: string; trashed?: boolean }) => StudioCanvas[]
  /** Create a canvas, optionally filed in a folder. */
  createCanvas: (name: string, folderId?: string) => StudioCanvas
  /** Read a project, or undefined when it does not exist. */
  getCanvas: (id: string) => StudioCanvas | undefined
  /** Rename a canvas. Returns false when it does not exist. */
  renameCanvas: (id: string, name: string) => boolean
  /** Move a canvas into a folder (empty string unfiles it). */
  moveCanvas: (id: string, folderId: string) => boolean
  /** Set a canvas's cover to one of its assets (empty string clears it). */
  setCanvasCover: (id: string, assetId: string) => boolean
  /** Copy a canvas: same document, fresh node identities, no generation history. */
  duplicateCanvas: (id: string) => StudioCanvas | undefined
  /** Move a canvas to the trash. */
  trashCanvas: (id: string) => boolean
  /** Take a canvas back out of the trash. */
  restoreCanvas: (id: string) => boolean
  /**
   * Delete trashed canvases for good.
   * @param olderThanDays - when given, only trash older than this many days goes.
   * @returns how many were removed.
   */
  purgeTrash: (olderThanDays?: number) => number
  /** Delete a canvas for good. Shots and takes cascade; assets stay. */
  deleteCanvas: (id: string) => boolean
  /** Read one canvas document, or undefined when never saved. */
  getDoc: (canvasId: string) => string | undefined
  /** Write one canvas document. */
  saveDoc: (canvasId: string, doc: string) => void
  /** Append a shot to a project. */
  addShot: (canvasId: string, title: string, prompt: string) => StudioShot
  /** Read one shot, or undefined when it does not exist. */
  getShot: (id: string) => StudioShot | undefined
  /** List a project's shots in story order. */
  listShots: (canvasId: string) => StudioShot[]
  /** Record one generation attempt. */
  addTake: (input: NewTake) => StudioTake
  /** List a shot's takes, newest first. */
  listTakes: (shotId: string) => StudioTake[]
  /** Mark one take as the chosen one for its shot. */
  selectTake: (shotId: string, takeId: string) => void
  /**
   * 删掉一条 take（某一版）。
   *
   * 一串残渣版本会长成「版本条上一堆没人看的格子」，而它们占的是真磁盘。
   * 删掉**最后一版**时连镜头也一起删：镜头是「这条生成线」的壳，
   * 没有版本了留着它只会让下一个版本接着旧线走（版本号接着往上加，看着像丢了东西）。
   * @returns 这一版是否存在并被删掉。
   */
  deleteTake: (shotId: string, takeId: string) => boolean
  /** Persist one asset's bytes and index them by content hash. */
  saveAsset: (bytes: Buffer, mime: string, kind: string) => StudioAsset
  /** Look up one asset by id. */
  getAsset: (id: string) => StudioAsset | undefined
  /**
   * How long generation has been taking on this machine.
   *
   * Read from recorded takes rather than configured: an ETA that adapts to the
   * actual card and model is useful, a hard-coded one is a lie.
   */
  generationStats: (limit?: number) => GenerationStats
  /** List assets, newest first. */
  listAssets: (limit?: number) => StudioAsset[]
  /** 素材文件夹，旧的在前面。 */
  listAssetFolders: () => StudioAssetFolder[]
  /** 新建一个素材文件夹。 */
  createAssetFolder: (name: string) => StudioAssetFolder
  /** 读一个素材文件夹。 */
  getAssetFolder: (id: string) => StudioAssetFolder | undefined
  /** 改名。返回 false 表示没有这个文件夹。 */
  renameAssetFolder: (id: string, name: string) => boolean
  /**
   * 删掉一个素材文件夹。
   *
   * **里面的素材不动**：文件夹是标签，不是容器。删标签不等于删内容 ——
   * 这是必须的，因为「删除文件夹」在别处的语义常常是连内容一起删。
   * @returns 有多少个素材被退回「未分组」；**-1 表示没有这个文件夹**。
   */
  deleteAssetFolder: (id: string) => number
  /**
   * 把若干素材移进一个文件夹（空串 = 退回未分组）。
   * @returns 真正被移动的个数。
   */
  moveAssets: (ids: string[], folderId: string) => number
  /** 按名字找素材文件夹（同名不让建两个）。 */
  findAssetFolderByName: (name: string) => StudioAssetFolder | undefined
  /**
   * Whether any canvas document still shows this asset.
   *
   * Assets are content-addressed and shared, so deleting one is only safe when
   * nothing points at it. The check is a substring scan of the stored documents,
   * which is exactly as precise as the reference itself (nodes store a URL).
   */
  assetInUse: (id: string) => boolean
  /** Delete one asset's index row and its bytes. */
  deleteAsset: (id: string) => boolean
  /**
   * 把一条 take 换成另一张素材（连续同一种编辑时「改这一版」而不是再记一版）。
   * @param takeId - the take to change.
   * @param assetId - the asset it should point at.
   * @returns whether the take existed.
   */
  updateTakeAsset: (takeId: string, assetId: string) => boolean
  /** Absolute path of one asset's bytes. */
  assetPath: (asset: StudioAsset) => string
  /**
   * Read one asset's bytes, when it exists and is still on disk.
   *
   * 存在的理由很具体：**图生视频要把画布上那张图送进 ComfyUI 的 input 目录**
   * （`LoadImage` 只认那边的文件名）。素材是内容寻址的，所以「按 id 取字节」这件事
   * 归 store 管，调用方不该自己拼路径。
   * @param id - asset id.
   * @returns the bytes, or undefined when the row or the file is gone.
   */
  readAsset: (id: string) => Buffer | undefined
  /**
   * 设置页写下的覆盖值。
   *
   * 键是**环境变量名**（`COMFYUI_URL` / `STUDIO_TEXT_API_KEY` …）：一个东西一个名字，
   * UI 里因此说得出「这个值来自环境变量还是来自设置页」。空值表示「没有覆盖」，
   * 于是退回环境变量、再退回内置默认。
   */
  getSettings: () => Record<string, string>
  /** 写一条覆盖；值给空串等于删掉这条覆盖。 */
  setSetting: (key: string, value: string) => void
  /** 删掉一条覆盖（退回环境变量/默认）。 */
  clearSetting: (key: string) => void
  /** Close the underlying database. */
  close: () => void

  // ── 账号（cloud 模式）────────────────────────────────────────────────────
  /** 建账号。邮箱重复会抛（`UNIQUE` 约束）——调用方负责先查。 */
  createUser: (input: { email: string; passwordHash: string; displayName?: string; role?: 'admin' | 'user' }) => StudioUser
  /** 按邮箱查（大小写不敏感：存的是小写）。 */
  getUserByEmail: (email: string) => StudioUser | undefined
  /** 按 id 查。 */
  getUserById: (id: string) => StudioUser | undefined
  /**
   * 读密码哈希。
   *
   * **故意单独一个方法**：`StudioUser` 里没有这一列，所以它不会被顺手带到任何接口响应里。
   * 只有账号层（校验密码）会调它。
   */
  getUserPasswordHash: (id: string) => string | undefined
  /** 有多少个账号（用来判断「第一个注册的是管理员」）。 */
  countUsers: () => number
  /** 记一次成功登录。 */
  touchUserLogin: (userId: string) => void
  /** 标记邮箱已验证。 */
  markEmailVerified: (userId: string, at: string) => void
  /** 改密码（重置密码用）。 */
  setUserPassword: (userId: string, passwordHash: string) => void
  /** 列表（管理后台用）。 */
  listUsers: (limit?: number) => StudioUser[]

  /** 存一次性令牌的哈希（验证邮箱 / 重置密码）。 */
  createAuthToken: (input: { userId: string; kind: string; tokenHash: string; expiresAt: string }) => void
  /** 按哈希找未用、未过期的令牌。 */
  findAuthToken: (kind: string, tokenHash: string, nowIso: string) => { id: string; userId: string } | undefined
  /** 标记令牌已用（一次性）。 */
  consumeAuthToken: (id: string, at: string) => void

  /** 建会话（登录）。 */
  createSession: (input: {
    userId: string; accessHash: string; refreshHash: string; label: string
    accessExpiresAt: string; refreshExpiresAt: string
  }) => StudioSession
  /** 按访问令牌哈希找会话。 */
  findSessionByAccess: (accessHash: string) => StudioSession | undefined
  /** 按刷新令牌哈希找会话。 */
  findSessionByRefresh: (refreshHash: string) => StudioSession | undefined
  /** 轮换令牌（刷新即换新的一对）。 */
  rotateSession: (sessionId: string, input: { accessHash: string; refreshHash: string; accessExpiresAt: string; refreshExpiresAt: string }) => void
  /** 记一次使用。 */
  touchSession: (sessionId: string, at: string) => void
  /** 撤销一个会话。 */
  revokeSession: (sessionId: string, at: string) => void
  /** 撤销一个用户的全部会话（改密码、封禁时用）。 */
  revokeUserSessions: (userId: string, at: string) => void
  /** 列出某人的会话（管理自己的设备）。 */
  listSessions: (userId: string) => StudioSession[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folder (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS canvas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_id TEXT,
  cover_asset_id TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS canvas_doc (
  canvas_id TEXT PRIMARY KEY REFERENCES canvas(id) ON DELETE CASCADE,
  doc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shot (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES canvas(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  selected_take_id TEXT
);
CREATE INDEX IF NOT EXISTS shot_by_canvas ON shot(canvas_id, idx);
-- 设置页写下来的覆盖值：**键就是环境变量名**（一个东西一个名字，UI 里也说得出「它来自哪」）。
-- 环境变量仍然有效：存储里的值优先，清掉某一条就退回环境变量/默认值。
CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS take (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  asset_id TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  seed INTEGER,
  latency_ms INTEGER,
  error TEXT,
  mark TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS take_by_shot ON take(shot_id, created_at DESC);
CREATE TABLE IF NOT EXISTS asset (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  folder_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
-- 素材文件夹。**故意和画布文件夹分开**（见 StudioAssetFolder 的注释）。
CREATE TABLE IF NOT EXISTS asset_folder (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- 账号（只在 cloud 模式用得上；local 模式一个访问密码就够，表空着）。
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
-- 一次性令牌：邮箱验证 / 重置密码。**只存哈希**，明文只在邮件里出现一次。
CREATE TABLE IF NOT EXISTS auth_token (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_token_by_hash ON auth_token(token_hash);
-- 会话（一个设备一行）：访问令牌与刷新令牌**都只存哈希**，可单独撤销。
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  access_hash TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_by_refresh ON session(refresh_hash);
CREATE INDEX IF NOT EXISTS session_by_user ON session(user_id, created_at DESC);
`

/** A row as `node:sqlite` hands it back. */
type Row = Record<string, unknown>

/** Read a text column. */
function text(row: Row, column: string): string {
  const value = row[column]
  return typeof value === 'string' ? value : ''
}

/** Read an integer column. */
function integer(row: Row, column: string): number {
  const value = row[column]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

/** Read a nullable integer column. */
function optionalInteger(row: Row, column: string): number | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Add a column to an existing table when an older database lacks it.
 *
 * `CREATE TABLE IF NOT EXISTS` silently does nothing on a database that already
 * has the table, so a column added to the schema above would never reach a
 * database created by an earlier version. This is the whole migration story:
 * additive columns, applied in place, no data rewritten.
 */
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/** Whether a table exists. */
function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/** Whether a table already has a column. */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
  return columns.some((row) => text(row, 'name') === column)
}

/**
 * 表名正名：`project` → `canvas`，`canvas`（文档）→ `canvas_doc`。
 *
 * 债务第 8 条：界面上从第一天就说「画布」，存储层却一直叫 `project` ——
 * 于是每读一次代码都要在脑子里翻译一遍，而「项目」和「画布」在这个产品里
 * **本来就是同一个东西**（一张画布就是一个作品）。
 *
 * **必须在 `SCHEMA` 之前跑**：SCHEMA 里有 `CREATE TABLE IF NOT EXISTS canvas`，
 * 而旧库里 `canvas` 正是那张文档表 —— 先建表的话，重命名会撞在一个刚建出来的空表上。
 * 判定「旧布局」的依据是 `project` 表还在。
 *
 * 这是唯一一处会动用户已有数据的迁移，所以先做一份**一致性快照**（`VACUUM INTO`）：
 * 动别人的作品必须有退路，而这一步只花几毫秒。
 */
function migrateNames(db: DatabaseSync, dbPath: string): void {
  if (!hasTable(db, 'project')) return
  try {
    const backup = `${dbPath}.before-canvas-rename`
    db.exec(`VACUUM INTO '${backup.replace(/'/gu, "''")}'`)
  } catch (error) {
    // 备份失败就**不要动**：宁可这次不迁移，也不能在没有退路的情况下改表名。
    console.log(`[studio] 跳过表名迁移（备份失败）：${String(error)}`)
    return
  }
  // 顺序不能反：先把 `canvas` 这个名字让出来，`project` 才能拿走它。
  if (hasTable(db, 'canvas') && !hasTable(db, 'canvas_doc')) {
    db.exec('ALTER TABLE canvas RENAME TO canvas_doc')
    db.exec('ALTER TABLE canvas_doc RENAME COLUMN project_id TO canvas_id')
  }
  db.exec('ALTER TABLE project RENAME TO canvas')
  db.exec('ALTER TABLE shot RENAME COLUMN project_id TO canvas_id')
  console.log('[studio] 存储层正名：project → canvas、canvas → canvas_doc（原库已备份为 .before-canvas-rename）')
}

/**
 * Bring an existing database up to the current schema.
 *
 * Order is the whole story: `CREATE TABLE IF NOT EXISTS` leaves an existing table
 * untouched, so anything that *depends* on a new column (an index, say) must run
 * after the column is added. An earlier version put such an index in SCHEMA and
 * the server refused to start on a database that predated the column.
 */
function migrate(db: DatabaseSync): void {
  // 工作区 → 文件夹：同一个东西的正名，数据不动。
  // 界面上一开始就只该有「文件夹」这一层，
  // 存储层跟着改，免得以后每读一次代码都要在脑子里翻译一遍。
  if (hasTable(db, 'workspace') && !hasTable(db, 'folder')) {
    db.exec('ALTER TABLE workspace RENAME TO folder')
  }
  if (hasColumn(db, 'canvas', 'workspace_id') && !hasColumn(db, 'canvas', 'folder_id')) {
    db.exec('ALTER TABLE canvas RENAME COLUMN workspace_id TO folder_id')
  }
  ensureColumn(db, 'canvas', 'folder_id', 'TEXT')
  ensureColumn(db, 'canvas', 'cover_asset_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'canvas', 'deleted_at', 'TEXT')
  ensureColumn(db, 'shot', 'selected_take_id', 'TEXT')
  ensureColumn(db, 'take', 'params_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn(db, 'take', 'seed', 'INTEGER')
  ensureColumn(db, 'take', 'latency_ms', 'INTEGER')
  ensureColumn(db, 'take', 'error', 'TEXT')
  ensureColumn(db, 'take', 'mark', "TEXT NOT NULL DEFAULT 'none'")
  ensureColumn(db, 'asset', 'folder_id', "TEXT NOT NULL DEFAULT ''")
  db.exec('CREATE INDEX IF NOT EXISTS canvas_by_folder ON canvas(folder_id, updated_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS asset_by_folder ON asset(folder_id, created_at DESC)')
}

/**
 * Open (or create) the Studio database.
 * @param dataDir - directory holding the database and asset files.
 * @returns the domain store.
 */
export function openStore(dataDir: string): StudioStore {
  const assetRoot = join(dataDir, 'assets')
  mkdirSync(assetRoot, { recursive: true })
  const dbPath = join(dataDir, 'studio.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // 正名在**建表之前**跑（见 migrateNames 的说明）。
  migrateNames(db, dbPath)
  db.exec(SCHEMA)
  migrate(db)

  const now = (): string => new Date().toISOString()

  /** 一行 user → 领域对象。 */
  const readUser = (row: Row): StudioUser => {
    const role = text(row, 'role')
    const status = text(row, 'status')
    return {
      id: text(row, 'id'),
      email: text(row, 'email'),
      displayName: text(row, 'display_name'),
      role: role === 'admin' ? 'admin' : 'user',
      status: status === 'banned' ? 'banned' : 'active',
      emailVerifiedAt: text(row, 'email_verified_at'),
      createdAt: text(row, 'created_at'),
      lastLoginAt: text(row, 'last_login_at'),
    }
  }

  /** 一行 session → 领域对象（**不含令牌哈希**：那两列永远不出存储层）。 */
  const readSession = (row: Row): StudioSession => ({
    id: text(row, 'id'),
    userId: text(row, 'user_id'),
    label: text(row, 'label'),
    accessExpiresAt: text(row, 'access_expires_at'),
    refreshExpiresAt: text(row, 'refresh_expires_at'),
    revokedAt: text(row, 'revoked_at'),
    createdAt: text(row, 'created_at'),
    lastSeenAt: text(row, 'last_seen_at'),
  })

  /** The columns a user row is read from, in one place. */
  const USER_COLUMNS = 'id, email, display_name, role, status, email_verified_at, created_at, last_login_at'
  /** The columns a session row is read from. */
  const SESSION_COLUMNS = 'id, user_id, label, access_expires_at, refresh_expires_at, revoked_at, created_at, last_seen_at'

  /** The columns a canvas row is read from, in one place. */
  const CANVAS_COLUMNS = 'id, name, folder_id, cover_asset_id, deleted_at, created_at, updated_at'

  /**
   * Pull a random image out of a stored canvas document.
   *
   * Node data carries `/api/assets/<id>` in its `url`, so the document is the
   * honest index of "what is on this canvas" — no second table to keep in sync.
   * @param doc - the stored document, or undefined.
   * @returns an asset id, or empty when the canvas has no picture.
   */
  const previewOf = (doc: string | undefined): string => {
    if (doc === undefined) return ''
    try {
      const parsed = JSON.parse(doc) as { nodes?: { data?: { url?: unknown } }[] }
      const ids = (parsed.nodes ?? [])
        .map((node) => (typeof node.data?.url === 'string' ? node.data.url : ''))
        .map((url) => (/^\/api\/assets\/([A-Za-z0-9]+)$/u.exec(url)?.[1] ?? ''))
        .filter((id) => id !== '')
      if (ids.length === 0) return ''
      return ids[Math.floor(Math.random() * ids.length)] ?? ''
    } catch {
      return ''
    }
  }

  const readCanvas = (row: Row): StudioCanvas => ({
    id: text(row, 'id'),
    name: text(row, 'name'),
    folderId: text(row, 'folder_id'),
    coverAssetId: text(row, 'cover_asset_id'),
    deletedAt: text(row, 'deleted_at'),
    previewAssetId: '',
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })

  return {
    listFolders() {
      return (db.prepare(`
        SELECT f.id, f.name, f.created_at, f.updated_at, COUNT(p.id) AS canvas_count
        FROM folder f LEFT JOIN canvas p ON p.folder_id = f.id AND p.deleted_at IS NULL
        GROUP BY f.id ORDER BY f.created_at
      `).all() as Row[]).map((row) => ({
        id: text(row, 'id'),
        name: text(row, 'name'),
        createdAt: text(row, 'created_at'),
        updatedAt: text(row, 'updated_at'),
        canvasCount: integer(row, 'canvas_count'),
      }))
    },
    createFolder(name) {
      const stamp = now()
      const id = randomUUID()
      db.prepare('INSERT INTO folder (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, stamp, stamp)
      return { id, name, createdAt: stamp, updatedAt: stamp, canvasCount: 0 }
    },
    getFolder(id) {
      const row = db.prepare('SELECT id, name, created_at, updated_at FROM folder WHERE id = ?').get(id) as Row | undefined
      if (row === undefined) return undefined
      const count = db.prepare('SELECT COUNT(*) AS n FROM canvas WHERE folder_id = ? AND deleted_at IS NULL').get(id) as Row | undefined
      return {
        id: text(row, 'id'),
        name: text(row, 'name'),
        createdAt: text(row, 'created_at'),
        updatedAt: text(row, 'updated_at'),
        canvasCount: integer(count ?? {}, 'n'),
      }
    },
    renameFolder(id, name) {
      const result = db.prepare('UPDATE folder SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id)
      return Number(result.changes) > 0
    },
    deleteFolder(id) {
      if (db.prepare('SELECT id FROM folder WHERE id = ?').get(id) === undefined) return false
      // A folder is a label, not a container: deleting it must not take the work
      // inside. The canvases survive and become unfiled.
      db.prepare("UPDATE canvas SET folder_id = NULL WHERE folder_id = ?").run(id)
      db.prepare('DELETE FROM folder WHERE id = ?').run(id)
      return true
    },
    listCanvases(options = {}) {
      const trashed = options.trashed === true
      // The trash is a separate view, never mixed into the working list.
      const where: string[] = [trashed ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL']
      const params: string[] = []
      if (options.folderId !== undefined && options.folderId !== '') {
        where.push('folder_id = ?')
        params.push(options.folderId)
      }
      const order = trashed ? 'deleted_at DESC' : 'updated_at DESC'
      const rows = db.prepare(`SELECT ${CANVAS_COLUMNS} FROM canvas WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...params) as Row[]
      return rows.map((row) => {
        const canvas = readCanvas(row)
        // 没设封面时，从这张画布自己的图里随机挑一张当缩略图。
        if (canvas.coverAssetId !== '') return { ...canvas, previewAssetId: canvas.coverAssetId }
        const docRow = db.prepare('SELECT doc FROM canvas_doc WHERE canvas_id = ?').get(canvas.id) as Row | undefined
        return { ...canvas, previewAssetId: previewOf(docRow === undefined ? undefined : text(docRow, 'doc')) }
      })
    },
    createCanvas(name, folderId) {
      const stamp = now()
      const id = randomUUID()
      // A folder id that does not exist would hide the canvas from every folder
      // view, so an unknown one becomes "no folder" rather than a dangling link.
      const owner = folderId !== undefined && db.prepare('SELECT id FROM folder WHERE id = ?').get(folderId) !== undefined
        ? folderId
        : ''
      db.prepare('INSERT INTO canvas (id, name, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, owner, stamp, stamp)
      return { id, name, folderId: owner, coverAssetId: '', deletedAt: '', previewAssetId: '', createdAt: stamp, updatedAt: stamp }
    },
    getCanvas(id) {
      const row = db.prepare(`SELECT ${CANVAS_COLUMNS} FROM canvas WHERE id = ?`).get(id) as Row | undefined
      return row === undefined ? undefined : readCanvas(row)
    },
    renameCanvas(id, name) {
      // `updated_at` moves too: the name is part of the work, and a rename should
      // not look like an edit that never happened in 「最近画布」.
      const result = db.prepare('UPDATE canvas SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id)
      return Number(result.changes) > 0
    },
    moveCanvas(id, folderId) {
      const target = folderId !== '' && db.prepare('SELECT id FROM folder WHERE id = ?').get(folderId) !== undefined ? folderId : ''
      const result = db.prepare('UPDATE canvas SET folder_id = ?, updated_at = ? WHERE id = ?').run(target === '' ? null : target, now(), id)
      return Number(result.changes) > 0
    },
    setCanvasCover(id, assetId) {
      const result = db.prepare('UPDATE canvas SET cover_asset_id = ? WHERE id = ?').run(assetId, id)
      return Number(result.changes) > 0
    },
    duplicateCanvas(id) {
      const source = this.getCanvas(id)
      if (source === undefined) return undefined
      const stamp = now()
      const copyId = randomUUID()
      db.prepare('INSERT INTO canvas (id, name, folder_id, cover_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(copyId, `${source.name} 副本`, source.folderId === '' ? null : source.folderId, source.coverAssetId, stamp, stamp)
      // The document comes along, but every node gets a new identity and loses its
      // generation history: two canvases sharing a shot id would make one canvas's
      // version list change when the other generates.
      const raw = db.prepare('SELECT doc FROM canvas_doc WHERE canvas_id = ?').get(id) as Row | undefined
      if (raw !== undefined) {
        let doc = text(raw, 'doc')
        try {
          const parsed = JSON.parse(doc) as { nodes?: { id?: string; data?: Record<string, unknown> }[] }
          const renames = new Map<string, string>()
          for (const node of parsed.nodes ?? []) {
            if (typeof node.id !== 'string') continue
            const next = `${node.id.split('-')[0] ?? 'node'}-${randomUUID().slice(0, 8)}`
            renames.set(node.id, next)
            node.id = next
            if (node.data !== undefined) {
              delete node.data.shotId
              delete node.data.takeId
              delete node.data.takeNumber
              delete node.data.chosen
              node.data.status = 'idle'
            }
          }
          const edges = (parsed as { edges?: { id?: string; source?: string; target?: string }[] }).edges ?? []
          for (const edge of edges) {
            if (typeof edge.source === 'string') edge.source = renames.get(edge.source) ?? edge.source
            if (typeof edge.target === 'string') edge.target = renames.get(edge.target) ?? edge.target
            edge.id = `edge-${randomUUID().slice(0, 8)}`
          }
          doc = JSON.stringify(parsed)
        } catch {
          // An unparseable document would be copied verbatim; a canvas that opens
          // empty is worse than one that opens exactly as it was.
        }
        db.prepare('INSERT INTO canvas_doc (canvas_id, doc, updated_at) VALUES (?, ?, ?)').run(copyId, doc, stamp)
      }
      return this.getCanvas(copyId)
    },
    trashCanvas(id) {
      // 删除进回收站，不是消失：画布是用户唯一的作品载体，
      // 一次误点不该有不可撤销的后果。
      const result = db.prepare('UPDATE canvas SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id)
      return Number(result.changes) > 0
    },
    restoreCanvas(id) {
      const result = db.prepare('UPDATE canvas SET deleted_at = NULL WHERE id = ?').run(id)
      return Number(result.changes) > 0
    },
    purgeTrash(olderThanDays) {
      // 回收站不能只进不出：没有期限的话，它会变成第二个「全部项目」。
      if (olderThanDays === undefined) {
        const result = db.prepare('DELETE FROM canvas WHERE deleted_at IS NOT NULL').run()
        return Number(result.changes)
      }
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
      const result = db.prepare('DELETE FROM canvas WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff)
      return Number(result.changes)
    },
    deleteCanvas(id) {
      // Canvas, shots and takes cascade (foreign keys are on). Assets do not:
      // they are content-addressed and shared, so one project's deletion must not
      // pull the bytes out from under another project that also references them.
      const result = db.prepare('DELETE FROM canvas WHERE id = ?').run(id)
      return Number(result.changes) > 0
    },
    getDoc(canvasId) {
      const row = db.prepare('SELECT doc FROM canvas_doc WHERE canvas_id = ?').get(canvasId) as Row | undefined
      return row === undefined ? undefined : text(row, 'doc')
    },
    saveDoc(canvasId, doc) {
      const stamp = now()
      db.prepare('INSERT INTO canvas_doc (canvas_id, doc, updated_at) VALUES (?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at')
        .run(canvasId, doc, stamp)
      db.prepare('UPDATE canvas SET updated_at = ? WHERE id = ?').run(stamp, canvasId)
    },
    addShot(canvasId, title, prompt) {
      const row = db.prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM shot WHERE canvas_id = ?').get(canvasId) as Row | undefined
      const id = randomUUID()
      const index = integer(row ?? {}, 'next')
      db.prepare('INSERT INTO shot (id, canvas_id, idx, title, prompt, status) VALUES (?, ?, ?, ?, ?, ?)').run(id, canvasId, index, title, prompt, 'draft')
      return { id, canvasId, index, title, prompt, status: 'draft', selectedTakeId: '' }
    },
    getShot(id) {
      const row = db.prepare('SELECT id, canvas_id, idx, title, prompt, status, selected_take_id FROM shot WHERE id = ?').get(id) as Row | undefined
      if (row === undefined) return undefined
      return {
        id: text(row, 'id'),
        canvasId: text(row, 'canvas_id'),
        index: integer(row, 'idx'),
        title: text(row, 'title'),
        prompt: text(row, 'prompt'),
        status: text(row, 'status'),
        selectedTakeId: text(row, 'selected_take_id'),
      }
    },
    listShots(canvasId) {
      return (db.prepare('SELECT id, canvas_id, idx, title, prompt, status, selected_take_id FROM shot WHERE canvas_id = ? ORDER BY idx').all(canvasId) as Row[])
        .map((row) => ({
          id: text(row, 'id'),
          canvasId: text(row, 'canvas_id'),
          index: integer(row, 'idx'),
          title: text(row, 'title'),
          prompt: text(row, 'prompt'),
          status: text(row, 'status'),
          selectedTakeId: text(row, 'selected_take_id'),
        }))
    },
    addTake(input) {
      const stamp = now()
      const id = randomUUID()
      db.prepare(
        'INSERT INTO take (id, shot_id, provider_id, model, status, asset_id, params_json, seed, latency_ms, error, mark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        input.shotId,
        input.providerId,
        input.model,
        input.status,
        input.assetId ?? '',
        JSON.stringify(input.params ?? {}),
        input.seed ?? null,
        input.latencyMs ?? null,
        input.error ?? null,
        'none',
        stamp,
      )
      return {
        id,
        shotId: input.shotId,
        providerId: input.providerId,
        model: input.model,
        status: input.status,
        assetId: input.assetId ?? '',
        params: input.params ?? {},
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
        ...(input.error === undefined ? {} : { error: input.error }),
        mark: 'none' as const,
        createdAt: stamp,
      }
    },
    listTakes(shotId) {
      return (db.prepare('SELECT id, shot_id, provider_id, model, status, asset_id, params_json, seed, latency_ms, error, mark, created_at FROM take WHERE shot_id = ? ORDER BY created_at DESC').all(shotId) as Row[])
        .map((row) => {
          let params: Record<string, unknown> = {}
          try {
            const parsed: unknown = JSON.parse(text(row, 'params_json') || '{}')
            if (typeof parsed === 'object' && parsed !== null) params = parsed as Record<string, unknown>
          } catch { /* keep the empty object */ }
          const seed = optionalInteger(row, 'seed')
          const latencyMs = optionalInteger(row, 'latency_ms')
          const error = text(row, 'error')
          return {
            id: text(row, 'id'),
            shotId: text(row, 'shot_id'),
            providerId: text(row, 'provider_id'),
            model: text(row, 'model'),
            status: text(row, 'status'),
            assetId: text(row, 'asset_id'),
            params,
            ...(seed === undefined ? {} : { seed }),
            ...(latencyMs === undefined ? {} : { latencyMs }),
            ...(error === '' ? {} : { error }),
            mark: text(row, 'mark') === 'selected' ? ('selected' as const) : ('none' as const),
            createdAt: text(row, 'created_at'),
          }
        })
    },
    selectTake(shotId, takeId) {
      db.prepare('UPDATE take SET mark = ? WHERE shot_id = ?').run('none', shotId)
      db.prepare('UPDATE take SET mark = ? WHERE id = ? AND shot_id = ?').run('selected', takeId, shotId)
      db.prepare('UPDATE shot SET selected_take_id = ? WHERE id = ?').run(takeId, shotId)
      db.prepare('UPDATE shot SET status = ? WHERE id = ?').run('locked', shotId)
    },
    deleteTake(shotId, takeId) {
      const exists = db.prepare('SELECT id FROM take WHERE id = ? AND shot_id = ?').get(takeId, shotId)
      if (exists === undefined) return false
      db.prepare('DELETE FROM take WHERE id = ?').run(takeId)
      const left = db.prepare('SELECT COUNT(*) AS n FROM take WHERE shot_id = ?').get(shotId) as Row | undefined
      // 最后一版被删掉 = 这条生成线没有内容了：镜头也一起删，
      // 免得下一次生成接着旧线把版本号继续往上加（看起来像丢了东西）。
      if (integer(left ?? {}, 'n') === 0) db.prepare('DELETE FROM shot WHERE id = ?').run(shotId)
      return true
    },
    saveAsset(bytes, mime, kind) {
      const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
      const existing = db.prepare('SELECT id, kind, mime, bytes, rel_path, folder_id, created_at FROM asset WHERE id = ?').get(id) as Row | undefined
      if (existing !== undefined) {
        return { id, kind: text(existing, 'kind'), mime: text(existing, 'mime'), bytes: integer(existing, 'bytes'), relPath: text(existing, 'rel_path'), createdAt: text(existing, 'created_at'), folderId: text(existing, 'folder_id') }
      }
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'video/mp4' ? 'mp4' : 'png'
      const relPath = join(id.slice(0, 2), `${id}.${ext}`)
      const absolute = join(assetRoot, relPath)
      mkdirSync(join(assetRoot, id.slice(0, 2)), { recursive: true })
      writeFileSync(absolute, bytes)
      const stamp = now()
      db.prepare('INSERT INTO asset (id, kind, mime, bytes, rel_path, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, kind, mime, bytes.length, relPath, stamp)
      return { id, kind, mime, bytes: bytes.length, relPath, createdAt: stamp, folderId: '' }
    },
    getAsset(id) {
      const row = db.prepare('SELECT id, kind, mime, bytes, rel_path, folder_id, created_at FROM asset WHERE id = ?').get(id) as Row | undefined
      if (row === undefined) return undefined
      return { id, kind: text(row, 'kind'), mime: text(row, 'mime'), bytes: integer(row, 'bytes'), relPath: text(row, 'rel_path'), createdAt: text(row, 'created_at'), folderId: text(row, 'folder_id') }
    },
    generationStats(limit = 20) {
      // Only successful runs count: a failure's duration says nothing about how
      // long the next good image will take.
      //
      // 素材类型来自 asset 表（join），不新加列：视频 take 的资产本来就是 video，
      // 这个事实数据库里已经有了。
      const rows = db.prepare(
        // `workflow` 从 params_json 里取（key 用 kind/workflow）。用 json_valid 兜一层：
        // 一行坏 JSON 不该让整个统计端点挂掉——那个端点还担着画布上的进度显示。
        `SELECT t.latency_ms AS latency_ms, a.kind AS asset_kind,
                CASE WHEN json_valid(t.params_json) THEN json_extract(t.params_json, '$.workflow') END AS workflow_id
         FROM take t LEFT JOIN asset a ON a.id = t.asset_id
         WHERE t.status = 'succeeded' AND t.latency_ms IS NOT NULL AND t.latency_ms > 0
         ORDER BY t.created_at DESC LIMIT ?`,
      ).all(limit) as Row[]
      const durationsOf = (subset: Row[]): number[] =>
        subset.map((row) => integer(row, 'latency_ms')).filter((value) => value > 0)
      const shape = (durations: number[]): { samples: number; medianMs: number; p90Ms: number; recentMs: number[] } => {
        if (durations.length === 0) return { samples: 0, medianMs: 0, p90Ms: 0, recentMs: [] }
        const sorted = [...durations].sort((a, b) => a - b)
        const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0
        // 偶数个样本时中位数是**中间两个的平均**。从前这里直接用 `at(0.5)`，
        // 取到的是上中位（样本 2 个时等于最大值）——那是分位数估计，不是中位数，
        // 在样本很少的视频档上会稳定偏悲观。
        const middle = sorted.length / 2
        const medianMs = sorted.length % 2 === 0 && sorted.length > 1
          ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
          : at(0.5)
        return { samples: durations.length, medianMs, p90Ms: at(0.9), recentMs: durations.slice(0, 5) }
      }

      // 按类型分开统计，因为**混在一起的答案是错的**：视频一条十几分钟、图片几秒，
      // 合起来算中位数会对两者都给出一个自信而错误的预计时间
      // （「预计 7 秒」然后跑 13 分钟——比不显示预计时间更糟）。
      const byKind: Record<string, { samples: number; medianMs: number; p90Ms: number }> = {}
      for (const kind of ['image', 'video', 'audio']) {
        const subset = rows.filter((row) => text(row, 'asset_kind') === kind)
        const shaped = shape(durationsOf(subset))
        if (shaped.samples > 0) byKind[kind] = { samples: shaped.samples, medianMs: shaped.medianMs, p90Ms: shaped.p90Ms }
      }

      // 再按「类型 + 工作流」分一层：同一个视频节点换一套工作流，耗时能差近一倍。
      const groups = new Map<string, Row[]>()
      for (const row of rows) {
        const kind = text(row, 'asset_kind')
        const workflowId = text(row, 'workflow_id')
        // 没记工作流的（旧 take、或「服务端自己挑的默认那套」）只进 byKind 那一档。
        if (kind === '' || workflowId === '') continue
        const bucket = groups.get(`${kind}/${workflowId}`)
        if (bucket === undefined) groups.set(`${kind}/${workflowId}`, [row])
        else bucket.push(row)
      }
      const byWorkflow: Record<string, { samples: number; medianMs: number; p90Ms: number }> = {}
      for (const [key, subset] of groups) {
        const shaped = shape(durationsOf(subset))
        if (shaped.samples > 0) byWorkflow[key] = { samples: shaped.samples, medianMs: shaped.medianMs, p90Ms: shaped.p90Ms }
      }

      return { ...shape(durationsOf(rows)), byKind, byWorkflow }
    },
    listAssets(limit = 200) {
      return (db.prepare('SELECT id, kind, mime, bytes, rel_path, folder_id, created_at FROM asset ORDER BY created_at DESC LIMIT ?').all(limit) as Row[])
        .map((row) => ({
          id: text(row, 'id'),
          kind: text(row, 'kind'),
          mime: text(row, 'mime'),
          bytes: integer(row, 'bytes'),
          relPath: text(row, 'rel_path'),
          createdAt: text(row, 'created_at'),
          folderId: text(row, 'folder_id'),
        }))
    },
    listAssetFolders() {
      return (db.prepare(`
        SELECT f.id, f.name, f.created_at, COUNT(a.id) AS asset_count
        FROM asset_folder f LEFT JOIN asset a ON a.folder_id = f.id
        GROUP BY f.id ORDER BY f.created_at
      `).all() as Row[]).map((row) => ({
        id: text(row, 'id'),
        name: text(row, 'name'),
        createdAt: text(row, 'created_at'),
        assetCount: integer(row, 'asset_count'),
      }))
    },
    createAssetFolder(name) {
      const stamp = now()
      const id = randomUUID()
      db.prepare('INSERT INTO asset_folder (id, name, created_at) VALUES (?, ?, ?)').run(id, name, stamp)
      return { id, name, createdAt: stamp, assetCount: 0 }
    },
    getAssetFolder(id) {
      const row = db.prepare('SELECT id, name, created_at FROM asset_folder WHERE id = ?').get(id) as Row | undefined
      if (row === undefined) return undefined
      const count = db.prepare('SELECT COUNT(*) AS n FROM asset WHERE folder_id = ?').get(id) as Row | undefined
      return {
        id: text(row, 'id'),
        name: text(row, 'name'),
        createdAt: text(row, 'created_at'),
        assetCount: integer(count ?? {}, 'n'),
      }
    },
    findAssetFolderByName(name) {
      const row = db.prepare('SELECT id, name, created_at FROM asset_folder WHERE name = ?').get(name) as Row | undefined
      if (row === undefined) return undefined
      const count = db.prepare('SELECT COUNT(*) AS n FROM asset WHERE folder_id = ?').get(text(row, 'id')) as Row | undefined
      return {
        id: text(row, 'id'),
        name: text(row, 'name'),
        createdAt: text(row, 'created_at'),
        assetCount: integer(count ?? {}, 'n'),
      }
    },
    renameAssetFolder(id, name) {
      const result = db.prepare('UPDATE asset_folder SET name = ? WHERE id = ?').run(name, id)
      return Number(result.changes) > 0
    },
    deleteAssetFolder(id) {
      if (db.prepare('SELECT id FROM asset_folder WHERE id = ?').get(id) === undefined) return -1
      // 标签，不是容器：删掉文件夹，里面的素材一个都不能少（退回未分组）。
      const moved = db.prepare("UPDATE asset SET folder_id = '' WHERE folder_id = ?").run(id)
      db.prepare('DELETE FROM asset_folder WHERE id = ?').run(id)
      return Number(moved.changes)
    },
    moveAssets(ids, folderId) {
      if (ids.length === 0) return 0
      const statement = db.prepare('UPDATE asset SET folder_id = ? WHERE id = ?')
      let moved = 0
      for (const id of ids) moved += Number(statement.run(folderId, id).changes)
      return moved
    },
    assetPath(asset) {
      return join(assetRoot, asset.relPath)
    },
    readAsset(id) {
      const asset = this.getAsset(id)
      if (asset === undefined) return undefined
      try {
        return readFileSync(join(assetRoot, asset.relPath))
      } catch {
        // 索引还在、文件没了（被人从磁盘上删掉）——那不是崩溃，是「读不到」。
        return undefined
      }
    },
    assetInUse(id) {
      // A canvas document holds `/api/assets/<id>` in its node data, so a LIKE
      // scan answers "is this still on someone's canvas" without a join table.
      const row = db.prepare("SELECT COUNT(*) AS n FROM canvas_doc WHERE doc LIKE ?").get(`%/api/assets/${id}%`) as Row | undefined
      return integer(row ?? {}, 'n') > 0
    },
    updateTakeAsset(takeId, assetId) {
      const row = db.prepare('SELECT id FROM take WHERE id = ?').get(takeId) as Row | undefined
      if (row === undefined) return false
      db.prepare('UPDATE take SET asset_id = ? WHERE id = ?').run(assetId, takeId)
      return true
    },
    deleteAsset(id) {
      const asset = this.getAsset(id)
      if (asset === undefined) return false
      db.prepare('DELETE FROM asset WHERE id = ?').run(id)
      try {
        rmSync(join(assetRoot, asset.relPath), { force: true })
      } catch {
        // A missing file is not a failure: the index is the source of truth and
        // the row is already gone.
      }
      return true
    },
    getSettings() {
      const rows = db.prepare('SELECT key, value FROM setting').all() as Row[]
      const values: Record<string, string> = {}
      for (const row of rows) values[text(row, 'key')] = text(row, 'value')
      return values
    },
    setSetting(key, value) {
      if (value === '') { this.clearSetting(key); return }
      db.prepare(
        'INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(key, value, new Date().toISOString())
    },
    clearSetting(key) {
      db.prepare('DELETE FROM setting WHERE key = ?').run(key)
    },
    close() {
      db.close()
    },

    // ── 账号（cloud 模式）──────────────────────────────────────────────────
    createUser(input) {
      const id = randomUUID()
      const stamp = now()
      const email = input.email.trim().toLowerCase()
      db.prepare('INSERT INTO user (id, email, password_hash, display_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, email, input.passwordHash, input.displayName ?? '', input.role ?? 'user', 'active', stamp)
      return {
        id,
        email,
        displayName: input.displayName ?? '',
        role: input.role ?? 'user',
        status: 'active',
        emailVerifiedAt: '',
        createdAt: stamp,
        lastLoginAt: '',
      }
    },
    getUserByEmail(email) {
      const row = db.prepare(`SELECT ${USER_COLUMNS} FROM user WHERE email = ?`).get(email.trim().toLowerCase()) as Row | undefined
      return row === undefined ? undefined : readUser(row)
    },
    getUserById(id) {
      const row = db.prepare(`SELECT ${USER_COLUMNS} FROM user WHERE id = ?`).get(id) as Row | undefined
      return row === undefined ? undefined : readUser(row)
    },
    getUserPasswordHash(id) {
      const row = db.prepare('SELECT password_hash FROM user WHERE id = ?').get(id) as Row | undefined
      return row === undefined ? undefined : text(row, 'password_hash')
    },
    countUsers() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM user').get() as Row | undefined
      return integer(row ?? {}, 'n')
    },
    touchUserLogin(userId) {
      db.prepare('UPDATE user SET last_login_at = ? WHERE id = ?').run(now(), userId)
    },
    markEmailVerified(userId, at) {
      db.prepare('UPDATE user SET email_verified_at = ? WHERE id = ?').run(at, userId)
    },
    setUserPassword(userId, passwordHash) {
      db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(passwordHash, userId)
    },
    listUsers(limit = 200) {
      return (db.prepare(`SELECT ${USER_COLUMNS} FROM user ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[]).map(readUser)
    },

    createAuthToken(input) {
      db.prepare('INSERT INTO auth_token (id, user_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), input.userId, input.kind, input.tokenHash, input.expiresAt, now())
    },
    findAuthToken(kind, tokenHash, nowIso) {
      const row = db.prepare('SELECT id, user_id FROM auth_token WHERE kind = ? AND token_hash = ? AND used_at IS NULL AND expires_at > ?')
        .get(kind, tokenHash, nowIso) as Row | undefined
      return row === undefined ? undefined : { id: text(row, 'id'), userId: text(row, 'user_id') }
    },
    consumeAuthToken(id, at) {
      db.prepare('UPDATE auth_token SET used_at = ? WHERE id = ?').run(at, id)
    },

    createSession(input) {
      const id = randomUUID()
      const stamp = now()
      db.prepare(`INSERT INTO session (id, user_id, access_hash, refresh_hash, label, access_expires_at, refresh_expires_at, created_at, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.userId, input.accessHash, input.refreshHash, input.label, input.accessExpiresAt, input.refreshExpiresAt, stamp, stamp)
      return {
        id,
        userId: input.userId,
        label: input.label,
        accessExpiresAt: input.accessExpiresAt,
        refreshExpiresAt: input.refreshExpiresAt,
        revokedAt: '',
        createdAt: stamp,
        lastSeenAt: stamp,
      }
    },
    findSessionByAccess(accessHash) {
      const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE access_hash = ?`).get(accessHash) as Row | undefined
      return row === undefined ? undefined : readSession(row)
    },
    findSessionByRefresh(refreshHash) {
      const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE refresh_hash = ?`).get(refreshHash) as Row | undefined
      return row === undefined ? undefined : readSession(row)
    },
    rotateSession(sessionId, input) {
      db.prepare('UPDATE session SET access_hash = ?, refresh_hash = ?, access_expires_at = ?, refresh_expires_at = ?, last_seen_at = ? WHERE id = ?')
        .run(input.accessHash, input.refreshHash, input.accessExpiresAt, input.refreshExpiresAt, now(), sessionId)
    },
    touchSession(sessionId, at) {
      db.prepare('UPDATE session SET last_seen_at = ? WHERE id = ?').run(at, sessionId)
    },
    revokeSession(sessionId, at) {
      db.prepare('UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, sessionId)
    },
    revokeUserSessions(userId, at) {
      db.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, userId)
    },
    listSessions(userId) {
      return (db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as Row[]).map(readSession)
    },
  }
}
