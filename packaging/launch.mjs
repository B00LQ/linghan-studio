/**
 * 绿色包/安装版的启动器（**这个文件会被原样拷进安装目录**，见 `build-desktop.mjs`）。
 *
 * 它做五件事，每一件都有个具体理由：
 *
 * 1. **决定跑哪一份代码**：先看 `current.txt` 指的 `versions/<版本>`，
 *    没有就跑自带的 `app/`。自助更新就是「换这个指针」，所以这段逻辑和
 *    服务端的 `update.ts` 共用一份实现（`activeVersionDir`）。
 * 2. **认两种程序布局**：发布包里服务端是**打包压缩成一个文件**的（`app/server.mjs`，
 *    见 build-desktop.mjs 里那段说明），而老版本是 TS 源码（`app/apps/server/src/index.ts`）。
 *    升级时 `app/` 会整份换掉，而启动器本身**不在更新范围内** —— 所以它必须两种都认，
 *    否则一次自助更新就会把老用户锁在门外。
 * 3. **挑端口**：先用 8080，被占了就往后找一个空的。判据是**先连一下**
 *    （见 `desktop/ports.mjs`：只「绑一下试试」在 Windows 上会被 Docker 的端口转发骗过去）。
 * 4. **开一个独立应用窗口**：装了 Electron 就用它，没装就退到 Chromium 的 `--app=` 窗口，
 *    再不行才用系统默认浏览器。`STUDIO_WINDOW=browser|app|electron` 可以强制。
 * 5. **决定数据放哪**：默认是安装目录下的 `data/`（整个文件夹拷走就是搬家），
 *    也可以用环境变量 `STUDIO_DATA_DIR` 指到别处；顺带把 `app/.env` 里的预置值读进来
 *    （安装版的默认访问密码就在那儿）。
 *
 * 它**不做**的事：不装服务、不写注册表、不改系统设置。卸载就是删文件夹
 * （`data/` 要不要留由人自己决定 —— 见 README）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnvFile } from './desktop/env.mjs'

/** 产品名（打包时会一起改；这里只是一个显示名）。 */
const PRODUCT = 'LHIC'

const home = dirname(fileURLToPath(import.meta.url))
process.env.STUDIO_HOME = home
if (process.env.STUDIO_DATA_DIR === undefined || process.env.STUDIO_DATA_DIR === '') {
  process.env.STUDIO_DATA_DIR = join(home, 'data')
}

// 自带的那一份程序永远在 `app/`（更新换的是 `versions/<版本>`，不动它）。
const bundledApp = join(home, 'app')

/**
 * 一个安装目录里的程序入口，两种布局都认。
 * @param dir - 程序目录（`app/` 或 `versions/<版本>/`）。
 * @returns 入口文件路径，找不到就是 undefined。
 */
function entryOf(dir) {
  const packed = join(dir, 'server.mjs')
  if (existsSync(packed)) return packed
  const source = join(dir, 'apps', 'server', 'src', 'index.ts')
  return existsSync(source) ? source : undefined
}

/**
 * `current.txt` / `installedVersions` 的实现。
 *
 * 老包里就是 TS 源码（`update.ts`），新包里是打包好的 `update.mjs` —— 两种都试。
 */
function updateModuleOf(dir) {
  const packed = join(dir, 'update.mjs')
  if (existsSync(packed)) return packed
  const source = join(dir, 'apps', 'server', 'src', 'update.ts')
  return existsSync(source) ? source : undefined
}

if (entryOf(bundledApp) === undefined) {
  console.error(`[studio] 安装目录不完整：在 ${bundledApp} 里找不到程序文件`)
  console.error('[studio] 重新解压一次完整包，或者按 README 里的说明重新打包。')
  process.exit(1)
}

const updateModule = updateModuleOf(bundledApp)
if (updateModule === undefined) {
  console.error('[studio] 安装目录不完整：找不到版本管理模块')
  process.exit(1)
}
const { activeVersionDir, installedVersions } = await import(pathToFileURL(updateModule).href)
const { freePort } = await import(pathToFileURL(join(home, 'desktop', 'ports.mjs')).href)

// 安装版的预置值（默认访问密码等）。放在自带那一份里，更新不会把它冲掉。
loadEnvFile(join(bundledApp, '.env'))

const preferred = Number.parseInt(process.env.PORT ?? '8080', 10)
const port = await freePort(Number.isFinite(preferred) ? preferred : 8080)
process.env.PORT = String(port)
process.env.HOST = process.env.HOST ?? '127.0.0.1'

const versioned = activeVersionDir(home)
const appDir = versioned ?? bundledApp
const entry = entryOf(appDir)
if (entry === undefined) {
  console.error(`[studio] 找不到程序文件：${appDir}`)
  console.error('[studio] 更新装坏了的话，删掉 current.txt 就会退回自带那一份。')
  process.exit(1)
}
// 更新下来的那一份也允许带自己的 `.env`（覆盖安装时的预置值）。
if (appDir !== bundledApp) loadEnvFile(join(appDir, '.env'))

const url = `http://127.0.0.1:${String(port)}/`
console.log('─'.repeat(60))
console.log(`  ${PRODUCT}`)
console.log(`  界面：${url}`)
console.log(`  数据：${process.env.STUDIO_DATA_DIR}`)
console.log(`  程序：${appDir}${versioned === undefined ? '（自带版本）' : ''}`)
console.log(`  已有版本：${installedVersions(home).join('、') || '（只有自带这一份）'}`)
console.log('  关掉应用窗口就是退出；数据不会丢（都在数据目录里）。')
console.log('─'.repeat(60))

/**
 * 开窗口。三种方式，从「最像应用」往后退：
 *
 * 1. **Electron**（`electron/` 里有运行时）：真应用窗口 —— 没有地址栏、没有标签页，
 *    任务栏上是它自己，关窗口就等于退出。
 * 2. **Chromium 的 `--app=`**（Edge/Chrome 在场但没有 Electron）：同样是无地址栏的窗口，
 *    只是外壳是浏览器厂商的。用一个**专用 profile 目录**，免得跟人自己开的浏览器互相影响。
 * 3. **系统默认浏览器**：最后一条路。这时它是网页，但至少能用。
 *
 * `STUDIO_WINDOW=browser|app|electron` 可以强制（排障用）。
 * 测试与无头环境用 `STUDIO_NO_BROWSER=1` 全关掉。
 */
function openWindow() {
  const mode = process.env.STUDIO_WINDOW ?? 'auto'
  const electronExe = join(home, 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron')
  const shell = join(home, 'desktop', 'main.cjs')
  /** 窗口进程退出 = 用户关掉了应用：把服务端一起带走，不留占着端口的孤儿。 */
  const follow = (child) => { child.on('exit', () => { process.kill(process.pid, 'SIGTERM') }) }
  if (mode !== 'browser' && mode !== 'app' && existsSync(electronExe) && existsSync(shell)) {
    follow(spawn(electronExe, [join(home, 'desktop')], { stdio: 'ignore' }))
    return 'electron'
  }
  const chromium = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find((candidate) => existsSync(candidate))
  if (mode !== 'browser' && chromium !== undefined) {
    // `--app=` 去掉地址栏与标签页；专用 profile 让窗口大小/位置记得住，也不碰用户的浏览器。
    follow(spawn(chromium, [
      `--app=${url}`,
      `--user-data-dir=${join(home, 'window-profile')}`,
      '--window-size=1440,900',
      '--no-first-run',
      '--no-default-browser-check',
    ], { stdio: 'ignore' }))
    return 'app'
  }
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
    child.unref()
    return 'browser'
  } catch {
    console.log(`[studio] 没能自动打开窗口，手动访问 ${url} 就行`)
    return 'none'
  }
}

// 只有真的要给人看的时候才开窗口：测试与无头环境用 STUDIO_NO_BROWSER=1 关掉。
if (process.env.STUDIO_NO_BROWSER !== '1') {
  setTimeout(() => {
    const opened = openWindow()
    console.log(`[studio] 窗口方式：${opened}`)
  }, 900)
}

try {
  await import(pathToFileURL(entry).href)
} catch (error) {
  console.error('[studio] 启动失败：', error)
  console.error('[studio] 这个窗口先别关，把上面的报错抄下来（或截图）。')
  process.exitCode = 1
}
