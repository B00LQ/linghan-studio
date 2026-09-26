/**
 * Self-update for the **portable/desktop** layout.
 *
 * 这件事只在「绿色包」这种部署方式下成立，所以这里把边界写清楚：
 *
 * - **能自助更新的是绿色包**：目录里有一个 `current.txt` 指着 `versions/<版本>`，
 *   启动器按它决定跑哪一份。更新 = 下载 → 校验 → 解到一个新目录 → 改指针 → 重启。
 *   正在跑的进程不会被替换（Windows 上文件还被占着），所以「重启后生效」是实话，
 *   而不是偷懒 —— 这一点界面上也会说。
 * - **Docker 与源码运行不能自助更新**：镜像 / 仓库怎么升级是另一套事，
 *   接口会明确回「这个部署方式不能自助更新」。
 * - **校验的是 sha256，不是签名**：清单本身是可信来源的话，它挡的是下载损坏与半截包，
 *   **不挡**一个被篡改的清单。签名要另一整套（密钥、发布流程），这一版没有。
 * - **解包按白名单式清理**：绝对路径、`..`、盘符、反斜杠一律拒绝（zip-slip 是
 *   最经典的「更新器把自己写到系统目录」的洞），并限制文件数与总字节数。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { readZip, type ReadZipEntry } from './zip.ts'

/** 一个更新包最多下多大（默认 512 MB，够放前端产物与源码）。 */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

/** 解包后的上限：条目数与总字节数（防一个坏包把磁盘塞满）。 */
const MAX_FILES = 20_000
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024

/** 更新源清单里我们认的字段。 */
export interface UpdateManifest {
  /** 最新版本号，如 `0.2.0`。 */
  version: string
  /** 直接下载地址（http/https）。 */
  url: string
  /** 包的 sha256（十六进制）。**必须有** —— 没有就不更新。 */
  sha256: string
  /** 这一版改了什么（可选，显示给人看）。 */
  notes?: string
}

/** 一次「看看有没有新版」的结果。 */
export interface UpdateInfo {
  /** 当前运行的版本。 */
  current: string
  /** 更新源里最新的版本；没配置更新源时是空串。 */
  latest: string
  /** 是否有新版。 */
  available: boolean
  /** 下载地址。 */
  url: string
  /** 更新说明。 */
  notes: string
  /** 是否配置了更新源。 */
  configured: boolean
  /** 这次检查失败的原因（网络、清单格式…）；成功时是空串。 */
  error: string
  /**
   * 读到的清单。
   *
   * 一起带出来是**故意的**：安装那一步必须装更新源说的那一版，
   * 不能由请求体指定地址（否则这个接口就成了「让服务器下载并运行任意 zip」的洞）。
   * 顺带也省掉第二次网络请求。
   */
  manifest?: UpdateManifest
}

/** 运行中的版本，来自 package.json（**单一来源**，不在代码里再写一份）。 */
export function runningVersion(): string {
  /**
   * 两个位置都试，因为程序有两种布局：
   * - 打包布局：`app/server.mjs` 旁边就有 `app/package.json`（`./`）；
   * - 源码布局：`apps/server/src/update.ts` 往上三层才是仓库根的 package.json。
   *
   * 顺序不能反：打包版从 `app/server.mjs` 往上三层会走到安装目录**外面**
   * （甚至撞上构建机仓库根那份 package.json），于是「更新完了还是老版本号」。
   */
  const candidates = [new URL('./package.json', import.meta.url), new URL('../../../package.json', import.meta.url)]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    } catch { /* 换下一个位置 */ }
  }
  return '0.0.0'
}

/**
 * Compare two dotted versions.
 * @returns negative when `a` is older, 0 when equal, positive when newer.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] => value.split('.').map((piece) => Number.parseInt(piece, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** 清单里的 URL 只允许 http/https（`file:` 之类一律不认）。 */
function safeUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

/** Parse a manifest, rejecting anything we cannot act on. */
export function parseManifest(value: unknown): UpdateManifest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const url = typeof record.url === 'string' ? safeUrl(record.url) : ''
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim().toLowerCase() : ''
  if (version === '' || url === '') return undefined
  // 没有 sha256 就不更新：更新器最不该做的事是「装一个来路不明的包」。
  if (!/^[0-9a-f]{64}$/u.test(sha256)) return undefined
  return {
    version,
    url,
    sha256,
    ...(typeof record.notes === 'string' ? { notes: record.notes } : {}),
  }
}

/** What the check needs from the outside world (injectable so tests can fake it). */
export interface UpdateDeps {
  /** Extra headers/behaviour for the HTTP calls. */
  fetchImpl?: typeof fetch
  /** Timeout for one HTTP call, in milliseconds. */
  timeoutMs?: number
}

/** One HTTP call with a timeout, because a hung update source must not hang the server. */
async function get(url: string, deps: UpdateDeps): Promise<Response> {
  const impl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, deps.timeoutMs ?? 20_000)
  try {
    return await impl(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the update source whether there is something newer.
 * @param options - current version and the manifest URL (empty = not configured).
 * @param deps - injectable HTTP bits.
 * @returns what to show the operator.
 */
export async function checkForUpdate(
  options: { current?: string; manifestUrl: string },
  deps: UpdateDeps = {},
): Promise<UpdateInfo> {
  const current = options.current ?? runningVersion()
  const base: UpdateInfo = { current, latest: '', available: false, url: '', notes: '', configured: false, error: '' }
  const manifestUrl = safeUrl(options.manifestUrl)
  if (manifestUrl === '') return base
  try {
    const response = await get(manifestUrl, deps)
    if (!response.ok) return { ...base, configured: true, error: `更新源回 HTTP ${String(response.status)}` }
    const manifest = parseManifest(await response.json())
    if (manifest === undefined) return { ...base, configured: true, error: '更新源的内容看不懂（缺 version/url/sha256）' }
    return {
      current,
      latest: manifest.version,
      available: compareVersions(manifest.version, current) > 0,
      url: manifest.url,
      notes: manifest.notes ?? '',
      configured: true,
      error: '',
      manifest,
    }
  } catch (error) {
    return { ...base, configured: true, error: error instanceof Error ? error.message : '连不上更新源' }
  }
}

/** 解包结果的摘要。 */
export interface AppliedUpdate {
  /** 落地目录（相对 home 的路径也给一份，方便显示）。 */
  dir: string
  /** 写了多少个文件。 */
  files: number
  /** 解出多少字节。 */
  bytes: number
}

/** 条目名是否安全（zip-slip 防线：绝对路径、`..`、盘符、反斜杠都不行）。 */
export function safeEntryName(name: string): string | undefined {
  const normalized = name.replace(/\\/gu, '/')
  if (normalized === '' || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)) return undefined
  const pieces = normalized.split('/').filter((piece) => piece !== '' && piece !== '.')
  if (pieces.length === 0 || pieces.some((piece) => piece === '..')) return undefined
  return posix.join(...pieces)
}

/**
 * 把包里的条目整理成「相对更新目录」的路径。
 *
 * 发行包的 zip 通常外面还套一层目录（`LINGHAN-Studio/…`）。如果**所有**条目都在
 * 同一个顶层目录下，就把这层剥掉，否则原样 —— 剥错了会把文件铺到错误的层级里。
 */
export function stripCommonRoot(entries: ReadZipEntry[]): { name: string; bytes: Buffer }[] | undefined {
  const cleaned: { name: string; bytes: Buffer }[] = []
  for (const entry of entries) {
    const name = safeEntryName(entry.name)
    if (name === undefined) return undefined
    cleaned.push({ name, bytes: entry.bytes })
  }
  const first = cleaned[0]
  if (first === undefined) return undefined
  const root = first.name.split('/')[0] ?? ''
  if (root === '' || !cleaned.every((entry) => entry.name.startsWith(`${root}/`))) return cleaned
  return cleaned.map((entry) => ({ name: entry.name.slice(root.length + 1), bytes: entry.bytes }))
}

/**
 * Download, verify and stage an update.
 *
 * 落地方式：解到 `versions/.staging-<版本>`，成功后再改名成 `versions/<版本>`，
 * 最后写 `current.txt`。**顺序很重要** —— 中途失败时留下的只是一个暂存目录，
 * 指针还指着老版本，程序照样能启动。
 * @param options - home directory, version, url, sha256.
 * @param deps - injectable HTTP bits.
 * @returns a summary, or a string describing why it refused.
 */
export async function applyUpdate(
  options: { home: string; version: string; url: string; sha256: string },
  deps: UpdateDeps = {},
): Promise<AppliedUpdate | string> {
  const url = safeUrl(options.url)
  if (url === '') return '更新包的地址不是 http/https'
  if (!/^[0-9a-f]{64}$/u.test(options.sha256)) return '更新源没有给 sha256，拒绝安装'
  if (!/^[0-9A-Za-z._-]+$/u.test(options.version)) return '版本号里有不安全的字符'

  let response: Response
  try {
    response = await get(url, { ...deps, timeoutMs: deps.timeoutMs ?? 120_000 })
  } catch (error) {
    return `下载失败：${error instanceof Error ? error.message : String(error)}`
  }
  if (!response.ok) return `下载失败：HTTP ${String(response.status)}`
  const announced = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(announced) && announced > MAX_DOWNLOAD_BYTES) return '更新包太大'

  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.length === 0) return '更新包是空的'
  if (archive.length > MAX_DOWNLOAD_BYTES) return '更新包太大'
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== options.sha256) return `包的 sha256 对不上（拿到 ${digest.slice(0, 12)}…）`

  const entries = readZip(archive)
  if (entries === undefined) return '更新包不是能读的 zip（或已损坏）'
  const files = stripCommonRoot(entries)
  if (files === undefined) return '更新包里的路径不安全，已拒绝'
  if (files.length === 0 || files.length > MAX_FILES) return `更新包里的文件数不对（${String(files.length)} 个）`
  const total = files.reduce((sum, entry) => sum + entry.bytes.length, 0)
  if (total > MAX_TOTAL_BYTES) return '解出来的内容太大'

  const versionsDir = join(options.home, 'versions')
  const staging = join(versionsDir, `.staging-${options.version}`)
  const target = join(versionsDir, options.version)
  try {
    rmSync(staging, { recursive: true, force: true })
    for (const entry of files) {
      const destination = join(staging, entry.name)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, entry.bytes)
    }
    // 老目录直接换掉：更新的语义就是「这一版替换掉那一版」。
    rmSync(target, { recursive: true, force: true })
    mkdirSync(versionsDir, { recursive: true })
    renameSync(staging, target)
    writeFileSync(join(options.home, 'current.txt'), `${options.version}\n`)
  } catch (error) {
    return `落地失败：${error instanceof Error ? error.message : String(error)}`
  }
  return { dir: target, files: files.length, bytes: total }
}

/**
 * 这个目录是不是一个「绿色包」（有自带那一份程序）。
 *
 * 判据不能是 `current.txt` —— 它要等**第一次更新之后**才存在，而恰恰是那次更新
 * 需要这个判断成立。所以看的是「自带那份程序在不在」，也就是安装目录的形态。
 * @param home - bundle root.
 * @returns whether self-update can be offered here.
 */
export function isPortableHome(home: string): boolean {
  if (home === '') return false
  // 两种布局都算绿色包：打包版（app/server.mjs）与老版本（app/apps/server/src/index.ts）。
  return existsSync(join(home, 'app', 'server.mjs'))
    || existsSync(join(home, 'app', 'apps', 'server', 'src', 'index.ts'))
}

/**
 * 启动器用的那份逻辑：`current.txt` 指着哪个目录就跑哪个。
 *
 * 启动器（绿色包里的 `launch.mjs`）与测试都调它，所以「指针怎么读」只有一份实现。
 * @param home - bundle root.
 * @returns the app directory to run, or undefined when the layout does not apply.
 */
export function activeVersionDir(home: string): string | undefined {
  if (!existsSync(join(home, 'current.txt'))) return undefined
  let version = ''
  try {
    version = readFileSync(join(home, 'current.txt'), 'utf8').trim()
  } catch {
    return undefined
  }
  if (version === '' || !/^[0-9A-Za-z._-]+$/u.test(version)) return undefined
  const dir = join(home, 'versions', version)
  return existsSync(dir) ? dir : undefined
}

/** 已经装了哪些版本（显示「可以回退到哪一版」用）。 */
export function installedVersions(home: string): string[] {
  try {
    return readdirSync(join(home, 'versions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => compareVersions(b, a))
  } catch {
    return []
  }
}
