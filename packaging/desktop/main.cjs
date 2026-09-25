/**
 * 桌面窗口（Electron 外壳）。
 *
 * **为什么是「外壳」而不是把服务端搬进 Electron**：服务端用的是 `node:sqlite`，
 * 而 Electron 的 Node **没有**这个内置模块（Electron 33 / Node 20 实测：
 * `No such built-in module: node:sqlite`），它也不认 `.ts`。所以这里的分工是：
 *
 *   本文件（Electron）= 一个真窗口 + 生命周期；`node/node.exe` = 跑服务端。
 *
 * 代价是安装包大（Electron 约 180 MB + Node 约 110 MB），换来的是：
 * 没有地址栏、没有标签页、任务栏上是自己的图标、关窗口就是退出应用。
 *
 * 三件事必须做对，否则它就不像一个应用：
 * 1. **关窗口 = 退出**：服务端是子进程，窗口关了要把它带下去，不能留下一个孤儿进程占着端口。
 * 2. **单实例**：再点一次图标应当是「把已有窗口叫到前面」，而不是起第二个服务端。
 * 3. **窗口大小要记住**：存在数据目录里（`window.json`），下次还开这么大。
 *
 * 更新：启动时按 `current.txt` 决定跑 `versions/<版本>` 还是自带的 `app/`
 * （和服务端 `update.ts` 的 `activeVersionDir` 同一套约定，只是这里读不了 TS，所以重写了那五行）。
 */
const { app, BrowserWindow, shell, dialog } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const home = process.env.STUDIO_HOME && process.env.STUDIO_HOME !== '' ? process.env.STUDIO_HOME : join(__dirname, '..')
const dataDir = process.env.STUDIO_DATA_DIR && process.env.STUDIO_DATA_DIR !== '' ? process.env.STUDIO_DATA_DIR : join(home, 'data')
const bundledApp = join(home, 'app')
const nodeExe = join(home, 'node', process.platform === 'win32' ? 'node.exe' : 'node')

/** `current.txt` 指着哪个版本就跑哪个；没有就跑自带的 `app/`。 */
function activeAppDir() {
  try {
    const version = readFileSync(join(home, 'current.txt'), 'utf8').trim()
    const versioned = join(home, 'versions', version)
    if (version !== '' && existsSync(join(versioned, 'apps', 'server', 'src', 'index.ts'))) return versioned
  } catch { /* 没更新过就是正常的 */ }
  return bundledApp
}

/** 记住窗口大小与位置（存在数据目录里，卸载/搬家都不丢）。 */
const boundsFile = join(dataDir, 'window.json')
function loadBounds() {
  try {
    const parsed = JSON.parse(readFileSync(boundsFile, 'utf8'))
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') return parsed
  } catch { /* 第一次启动没有这个文件 */ }
  return { width: 1440, height: 900 }
}
function saveBounds(bounds) {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(boundsFile, JSON.stringify({ ...bounds, savedAt: new Date().toISOString() }, null, 2))
  } catch { /* 记不住就算了，不该因此报错 */ }
}

/** 等服务端起来（最多 90 秒：冷启动要装载权重，第一次可能很慢）。 */
async function waitForServer(url, timeoutMs = 90_000) {
  const started = Date.now()
  for (;;) {
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return true
    } catch { /* 还没起来 */ }
    if (Date.now() - started > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 400))
  }
}

let server = null
let window = null
/** 正在退出：窗口关闭时不要把「进程被杀」当成崩溃弹窗。 */
let quitting = false

async function startServer() {
  const appDir = activeAppDir()
  if (!existsSync(join(appDir, 'apps', 'server', 'src', 'index.ts'))) {
    dialog.showErrorBox('安装不完整', `找不到程序文件：\n${appDir}\n\n重新解压一次完整包，或删掉 current.txt 退回自带版本。`)
    app.exit(1)
    return ''
  }
  if (!existsSync(nodeExe)) {
    dialog.showErrorBox('安装不完整', `找不到运行时：\n${nodeExe}`)
    app.exit(1)
    return ''
  }
  // 端口探测与启动器共用一份（见 desktop/ports.mjs 里那段「为什么不能只绑一下试试」）。
  const { freePort } = await import(pathToFileURL(join(home, 'desktop', 'ports.mjs')).href)
  const port = await freePort(Number.parseInt(process.env.PORT ?? '8080', 10) || 8080)
  const url = `http://127.0.0.1:${String(port)}`
  server = spawn(nodeExe, ['--experimental-strip-types', join(appDir, 'apps', 'server', 'src', 'index.ts')], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STUDIO_HOME: home, STUDIO_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // 服务端的日志是排障唯一线索：写到文件，不要吞掉。
  try {
    const logPath = join(dataDir, 'desktop.log')
    mkdirSync(dataDir, { recursive: true })
    const stream = require('node:fs').createWriteStream(logPath, { flags: 'a' })
    server.stdout.pipe(stream)
    server.stderr.pipe(stream)
  } catch { /* 写不了日志也要能跑 */ }
  server.on('exit', (code) => {
    if (quitting) return
    dialog.showErrorBox('Studio 已停止', `服务端进程退出了（代码 ${String(code)}）。\n日志：${join(dataDir, 'desktop.log')}`)
    app.quit()
  })
  return (await waitForServer(url)) ? url : ''
}

async function createWindow(url) {
  const bounds = loadBounds()
  window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(typeof bounds.x === 'number' ? { x: bounds.x } : {}),
    ...(typeof bounds.y === 'number' ? { y: bounds.y } : {}),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true, // 菜单栏（文件/编辑…）对本地工具没意义，按 Alt 才出现
    backgroundColor: '#0b0d12',
    title: 'LINGHAN Studio',
    ...(existsSync(join(home, 'icon.png')) ? { icon: join(home, 'icon.png') } : {}),
    webPreferences: {
      // 只加载本机服务，不需要 Node 能力进页面：关掉是安全默认值。
      nodeIntegration: false,
      contextIsolation: true,
      // 画布上要拖文件上传，允许拖放。
      webSecurity: true,
    },
  })
  window.once('ready-to-show', () => { window.show() })
  window.on('close', () => {
    const current = window.getBounds()
    saveBounds(current)
    quitting = true
    if (server !== null) server.kill()
  })
  window.on('closed', () => { window = null })
  // 外链（文档、模型主页）走系统浏览器：应用窗口里开网页会变成「一个没有地址栏的浏览器」，很怪。
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  await window.loadURL(url)
}

// 单实例：第二次点击图标应该是把已有窗口叫到前面。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window !== null) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', () => {
    quitting = true
    if (server !== null) server.kill()
  })
  app.whenReady().then(async () => {
    const url = await startServer()
    if (url === '') { app.quit(); return }
    await createWindow(url)
  })
}
