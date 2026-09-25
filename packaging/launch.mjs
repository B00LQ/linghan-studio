/**
 * 绿色包的启动器（**这个文件会被原样拷进安装目录**，见 `build-desktop.mjs`）。
 *
 * 它只做四件事，每一件都有个具体理由：
 *
 * 1. **决定跑哪一份代码**：先看 `current.txt` 指的 `versions/<版本>`，
 *    没有就跑自带的 `app/`。自助更新就是「换这个指针」，所以这段逻辑和
 *    服务端的 `update.ts` 共用一份实现（`activeVersionDir`）。
 * 2. **决定数据放哪**：默认是安装目录下的 `data/`（整个文件夹拷走就是搬家），
 *    也可以用环境变量 `STUDIO_DATA_DIR` 指到别处。
 * 3. **挑端口**：先用 8080，被占了就往后找到一个空的。绿色包不该因为「端口被占」
 *    这种理由启动失败，而失败的提示又往往看不懂。
 * 4. **把浏览器叫起来**：这是一个本地服务，人期待的是「双击 → 看到界面」。
 *
 * 它**不做**的事：不装服务、不写注册表、不改系统设置。卸载就是删文件夹
 * （`data/` 要不要留由人自己决定 —— 见 README）。
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const home = dirname(fileURLToPath(import.meta.url))
process.env.STUDIO_HOME = home
if (process.env.STUDIO_DATA_DIR === undefined || process.env.STUDIO_DATA_DIR === '') {
  process.env.STUDIO_DATA_DIR = join(home, 'data')
}

// 自带的那一份程序永远在 `app/`（更新换的是 `versions/<版本>`，不动它）。
// 指针怎么读**只有一份实现**，就在服务端的 `update.ts` 里 —— 启动器 import 它，
// 而不是再抄一遍（两边各写一份，迟早会有一边改了而没人发现）。
const bundledApp = join(home, 'app')
if (!existsSync(join(bundledApp, 'apps', 'server', 'src', 'index.ts'))) {
  console.error(`[studio] 安装目录不完整：找不到 ${bundledApp}`)
  console.error('[studio] 重新解压一次完整包，或者按 README 里的说明重新打包。')
  process.exit(1)
}
const { activeVersionDir, installedVersions } = await import(pathToFileURL(join(bundledApp, 'apps', 'server', 'src', 'update.ts')).href)

/** 从 `preferred` 开始找一个能监听的端口。 */
async function freePort(preferred) {
  for (let port = preferred; port < preferred + 120; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = createServer()
      probe.once('error', () => { resolve(false) })
      probe.once('listening', () => { probe.close(() => { resolve(true) }) })
      probe.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  return preferred
}

const preferred = Number.parseInt(process.env.PORT ?? '8080', 10)
const port = await freePort(Number.isFinite(preferred) ? preferred : 8080)
process.env.PORT = String(port)
process.env.HOST = process.env.HOST ?? '127.0.0.1'

const versioned = activeVersionDir(home)
const appDir = versioned ?? bundledApp
if (!existsSync(join(appDir, 'apps', 'server', 'src', 'index.ts'))) {
  console.error(`[studio] 找不到程序文件：${appDir}`)
  console.error('[studio] 更新装坏了的话，删掉 current.txt 就会退回自带那一份。')
  process.exit(1)
}

const url = `http://127.0.0.1:${String(port)}/`
console.log('─'.repeat(60))
console.log('  LINGHAN Studio')
console.log(`  界面：${url}`)
console.log(`  数据：${process.env.STUDIO_DATA_DIR}`)
console.log(`  程序：${appDir}${versioned === undefined ? '（自带版本）' : ''}`)
console.log(`  已有版本：${installedVersions(home).join('、') || '（只有自带这一份）'}`)
console.log('  关掉这个窗口就是退出；数据不会丢（都在数据目录里）。')
console.log('─'.repeat(60))

// 只有真的要给人看的时候才开浏览器：测试与无头环境用 STUDIO_NO_BROWSER=1 关掉。
if (process.env.STUDIO_NO_BROWSER !== '1') {
  setTimeout(() => {
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      child.unref()
    } catch {
      console.log(`[studio] 没能自动打开浏览器，手动访问 ${url} 就行`)
    }
  }, 900)
}

try {
  await import(pathToFileURL(join(appDir, 'apps', 'server', 'src', 'index.ts')).href)
} catch (error) {
  console.error('[studio] 启动失败：', error)
  console.error('[studio] 这个窗口先别关，把上面的报错抄下来（或截图）。')
  process.exitCode = 1
}
