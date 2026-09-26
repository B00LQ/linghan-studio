/**
 * 绿色包与自助更新的验收。
 *
 * 用法: node tests/desktop-test.mjs
 *
 * 为什么值得单独一条：**打包与更新是「跑一遍才知道对不对」的那类东西**。
 * 绿色包里少一个文件、启动器指错了目录、更新包解开少一层、sha256 校验写反 ——
 * 这些在源码运行时全都看不出来，而用户拿到的是一个双击没反应的文件夹。
 *
 * 这条用例真的做三件事（不是模拟）：
 * ① 打一个绿色包出来，用**包里自带的 Node** 把它跑起来；
 * ② 走一遍首启向导的接口，并确认配过之后那个接口就关门了（不会变成后门）；
 * ③ 起一个本地「更新源」，打一个更新包，让运行中的实例去下载、校验、落地，
 *    **重启一次**并断言它真的跑在新版本上（指针换没换，只有重启才知道）。
 *
 * 全程只在临时目录与 `dist-desktop/` 里动手，不碰用户的 data/。
 */
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSession } from './test-session.mjs'

// 用例都在 tests/ 下，仓库根在上一层。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const STAMP = Date.now().toString().slice(-6)
const scratch = join(tmpdir(), `studio-desktop-${STAMP}`)
const dataDir = join(scratch, 'data')
const bundle = join(repo, 'dist-desktop', 'LINGHAN-Studio')
const NEW_VERSION = '9.9.9'
const PASSWORD = 'desktop-test-pw'
/** 这一条要真开一个浏览器（向导是界面功能），端口避开别的用例。 */
const CDP_PORT = Number(process.env.CDP_PORT || 9266)

let failures = 0
const log = (...a) => console.log('[desktop]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 起一个进程，返回句柄与累积的输出（用来在失败时看到原因）。 */
function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  const output = []
  child.stdout?.on('data', (chunk) => { output.push(String(chunk)) })
  child.stderr?.on('data', (chunk) => { output.push(String(chunk)) })
  return { child, output }
}

/** 轮询直到某个探针成功（或超时）。 */
async function until(probe, timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(300)
  }
}

/** 一个能监听的端口。 */
async function freePort() {
  for (let port = 8300; port < 8400; port += 1) {
    const free = await new Promise((resolvePort) => {
      const probe = createServer()
      probe.once('error', () => { resolvePort(false) })
      probe.once('listening', () => { probe.close(() => { resolvePort(true) }) })
      probe.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  return 8300
}

/** 带 cookie 的最小 API 客户端。 */
function client(base) {
  let cookie = ''
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(init.headers ?? {}) },
    })
    const set = response.headers.getSetCookie?.() ?? []
    if (set.length > 0) cookie = set.map((item) => item.split(';')[0]).join('; ')
    const text = await response.text()
    return { status: response.status, ok: response.ok, json: text === '' ? {} : JSON.parse(text) }
  }
  return { call, cookie: () => cookie }
}

/** zip 一个目录的**内容**（不带顶层目录），Windows 用 Compress-Archive。 */
function zipContents(dir, zipPath) {
  rmSync(zipPath, { force: true })
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${join(dir, '*')}' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' })
  return readFileSync(zipPath)
}

const run = async () => {
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })

  log('① 打一个绿色包出来')
  execFileSync('node', ['packaging/build-desktop.mjs'], { cwd: repo, stdio: 'inherit' })
  const nodeExe = join(bundle, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  check('包里有自带的 Node', existsSync(nodeExe), nodeExe)
  check('包里有启动器', existsSync(join(bundle, 'launch.mjs')))
  check('包里有服务端源码', existsSync(join(bundle, 'app', 'apps', 'server', 'src', 'index.ts')))
  check('包里有前端构建产物', existsSync(join(bundle, 'app', 'apps', 'web', 'dist', 'index.html')))
  check('包里有 package.json（版本号的单一来源）', existsSync(join(bundle, 'app', 'package.json')))
  check('包里有双击入口', existsSync(join(bundle, process.platform === 'win32' ? '启动 Studio.cmd' : 'start-studio.sh')))
  check('包里有使用说明', existsSync(join(bundle, '使用说明.txt')))
  const manifest = JSON.parse(readFileSync(join(repo, 'dist-desktop', 'update.json'), 'utf8'))
  check('更新清单里带着 sha256 与版本', /^[0-9a-f]{64}$/u.test(manifest.sha256) && manifest.version === pkg.version,
    `${manifest.version} ${manifest.sha256.slice(0, 12)}…`)
  check('更新包里没有 Node 运行时（更新不该换运行时）',
    !readFileSync(join(repo, 'dist-desktop', `LINGHAN-Studio-${pkg.version}-update.zip`)).toString('latin1').includes('node/node.exe'))

  log('② 用包里自带的 Node 跑起来（不碰用户的数据目录）')
  const port = await freePort()
  const base = `http://127.0.0.1:${String(port)}`
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    STUDIO_DATA_DIR: dataDir,
    STUDIO_NO_BROWSER: '1',
    // 别把开发机上那份 .env 的密码带进来（否则向导不会出现）。
    STUDIO_PASSWORD: '',
  }
  const first = start(nodeExe, [join(bundle, 'launch.mjs')], { cwd: bundle, env })
  const health = await until(async () => {
    try {
      const response = await fetch(`${base}/api/health`)
      return response.ok ? await response.json() : null
    } catch { return null }
  }, 40_000)
  check('绿色包能启动并响应 /api/health', health !== null, health === null ? first.output.join('').slice(-400) : JSON.stringify(health))
  if (health === null) {
    first.child.kill()
    log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
    process.exit(1)
  }

  const api = client(base)
  const session = (await api.call('/api/session')).json
  check('新装的部署要引导（setupNeeded）', session.setupNeeded === true, JSON.stringify(session))
  check('会话里带着版本与数据目录', session.version === pkg.version && String(session.dataDir).includes('studio-desktop'),
    `${String(session.version)} ${String(session.dataDir)}`)
  check('数据目录是包里那个（不是 ~/.studio）', existsSync(join(dataDir, 'studio.sqlite')), dataDir)

  log('③ 首启向导：在界面上走一遍（新用户看到的第一屏就是它）')
  // 校验（密码太短）走接口先验一次：它不该写进任何东西。
  check('密码太短会被拒（400）', (await api.call('/api/setup', { method: 'POST', body: JSON.stringify({ password: '123' }) })).status === 400)

  const browser = await startSession({ port: CDP_PORT, width: 1400, height: 950 })
  await browser.goto(base, 5000)
  check('新装的部署先弹首启向导（不是空画布）',
    (await browser.evaluate(`document.querySelectorAll('[data-testid="setup-wizard"]').length`)) === 1)
  check('向导是四步', (await browser.evaluate(`document.querySelectorAll('[data-testid="setup-steps"] span').length`)) === 4)
  check('第一屏说得出数据目录在哪',
    (await browser.evaluate(`(document.querySelector('[data-testid="setup-wizard"]')?.textContent || '').includes('studio-desktop')`)))
  check('点「下一步」进第二步', await browser.evaluate(`(() => { const b = document.querySelector('[data-testid="setup-next"]'); if (!b) return false; b.click(); return true })()`))
  await sleep(500)
  const typeInto = async (selector, value) => browser.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await typeInto('[data-testid="setup-password"]', '123')
  await typeInto('[data-testid="setup-password-repeat"]', '123')
  await browser.evaluate(`document.querySelector('[data-testid="setup-next"]').click()`)
  await sleep(500)
  check('太短的密码在这一步就被拦下（不等到最后一步才说）',
    (await browser.evaluate(`(document.querySelector('[data-testid="setup-error"]')?.textContent || '')`)).includes('6 位'),
    await browser.evaluate(`(document.querySelector('[data-testid="setup-error"]')?.textContent || '')`))
  await typeInto('[data-testid="setup-password"]', PASSWORD)
  await typeInto('[data-testid="setup-password-repeat"]', PASSWORD)
  await browser.evaluate(`document.querySelector('[data-testid="setup-next"]').click()`)
  await sleep(500)
  check('到了选后端那一步', (await browser.evaluate(`document.querySelectorAll('[data-testid="setup-driver-stub"]').length`)) === 1)
  check('默认是「先不接」（不需要任何依赖）',
    (await browser.evaluate(`document.querySelector('[data-testid="setup-driver-stub"]').className`)).includes('active'))
  check('点「完成」', await browser.evaluate(`(() => { const b = document.querySelector('[data-testid="setup-finish"]'); if (!b) return false; b.click(); return true })()`))
  await until(async () => (await browser.evaluate(`document.querySelectorAll('[data-testid="setup-done"]').length`)) === 1, 15_000)
  check('向导给出「配好了」那一屏', (await browser.evaluate(`document.querySelectorAll('[data-testid="setup-done"]').length`)) === 1)
  check('点「进入画布」', await browser.evaluate(`(() => { const b = document.querySelector('[data-testid="setup-done"]'); if (!b) return false; b.click(); return true })()`))
  const entered = await until(async () => (await browser.evaluate(`document.querySelectorAll('.studio-nav').length`)) === 1, 10_000)
  check('进了应用（向导没再拦住）', entered === true)
  check('全程没有 JS 报错', browser.consoleErrors.length === 0, browser.consoleErrors.slice(0, 2).join(' | '))
  browser.kill()

  log('④ 向导写过的东西真的生效了（并且那个接口就此关门）')
  const after = (await api.call('/api/session')).json
  check('配过之后不再引导', after.setupNeeded === false, JSON.stringify(after))
  check('密码已经生效', after.requiresPassword === true)
  check('向导接口永久关门（403）',
    (await api.call('/api/setup', { method: 'POST', body: JSON.stringify({ password: 'whatever' }) })).status === 403)
  check('未登录不能读设置', (await fetch(`${base}/api/settings`)).status === 401)
  const fresh = client(base)
  const login = await fresh.call('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })
  check('用向导里设的密码能登进来（界面写的就是对的）', login.status === 200 && fresh.cookie() !== '', JSON.stringify(login.json))
  check('登进来之后能读设置', (await fresh.call('/api/settings')).status === 200)

  log('⑤ 自助更新：本地更新源 → 下载 → 校验 → 落地 → 重启生效')
  // 更新包 = 现在这份 app/ 的完整副本，只把版本号改掉并塞一个标记文件。
  const payloadSource = join(scratch, 'payload')
  cpSync(join(bundle, 'app'), payloadSource, { recursive: true })
  const nextPkg = JSON.parse(readFileSync(join(payloadSource, 'package.json'), 'utf8'))
  nextPkg.version = NEW_VERSION
  writeFileSync(join(payloadSource, 'package.json'), `${JSON.stringify(nextPkg, null, 2)}\n`, 'utf8')
  writeFileSync(join(payloadSource, 'UPDATED.txt'), `更新到 ${NEW_VERSION}\n`, 'utf8')
  const updateZip = join(scratch, `update-${NEW_VERSION}.zip`)
  const updateBytes = zipContents(payloadSource, updateZip)
  const goodSha = createHash('sha256').update(updateBytes).digest('hex')

  // 「更新源」：一个只发清单与包的本地 HTTP 服务。
  let manifestBody = { version: NEW_VERSION, url: '', sha256: goodSha, notes: '打包验收' }
  const feedPort = await freePort()
  const feed = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/update.zip')) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(updateBytes.length) })
      res.end(updateBytes)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(manifestBody))
  })
  await new Promise((resolveListen) => { feed.listen(feedPort, '127.0.0.1', resolveListen) })
  const feedBase = `http://127.0.0.1:${String(feedPort)}`
  manifestBody.url = `${feedBase}/update.zip`

  // 通过设置页把更新源写进去（走的是产品自己的路径，不是测试专用的后门）。
  const saved = await fresh.call('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ values: { STUDIO_UPDATE_URL: `${feedBase}/latest.json` } }),
  })
  check('设置页能写入更新源', saved.json.saved?.includes('STUDIO_UPDATE_URL') === true, JSON.stringify(saved.json.saved))

  const checked = await fresh.call('/api/update')
  check('检查到有新版本', checked.json.available === true && checked.json.latest === NEW_VERSION, JSON.stringify(checked.json))
  check('认出这是绿色包（可以自助更新）', checked.json.selfUpdate === true, JSON.stringify(checked.json))
  check('版本号来自 package.json，不是写死的', checked.json.current === pkg.version, String(checked.json.current))

  // 反例先验：sha256 不对、清单缺 sha256 —— 都必须拒绝。
  const savedSha = manifestBody.sha256
  manifestBody.sha256 = 'f'.repeat(64)
  const badSha = await fresh.call('/api/update/apply', { method: 'POST' })
  check('sha256 对不上时拒绝安装', badSha.status === 400 && String(badSha.json.error).includes('sha256'), JSON.stringify(badSha.json))
  manifestBody.sha256 = savedSha
  const savedVersion = manifestBody.version
  manifestBody = { version: savedVersion, url: `${feedBase}/update.zip`, notes: '' }
  const noSha = await fresh.call('/api/update/apply', { method: 'POST' })
  check('清单里没有 sha256 时拒绝安装（宁可不错）',
    noSha.status === 400 && String(noSha.json.error).includes('sha256'), JSON.stringify(noSha.json))
  manifestBody = { version: savedVersion, url: `${feedBase}/update.zip`, sha256: savedSha, notes: '打包验收' }

  const applied = await fresh.call('/api/update/apply', { method: 'POST' })
  check('安装成功', applied.status === 200 && applied.json.version === NEW_VERSION, JSON.stringify(applied.json))
  check('明确说了要重启才生效', String(applied.json.note ?? '').includes('重启'), String(applied.json.note))
  const versioned = join(bundle, 'versions', NEW_VERSION)
  check('新版本落在 versions/<版本>/ 里', existsSync(join(versioned, 'UPDATED.txt')) && existsSync(join(versioned, 'apps', 'server', 'src', 'index.ts')))
  check('current.txt 指向新版本', readFileSync(join(bundle, 'current.txt'), 'utf8').trim() === NEW_VERSION)
  check('老程序还在（回退只要改指针）', existsSync(join(bundle, 'app', 'apps', 'server', 'src', 'index.ts')))

  log('⑥ 重启一次：它必须真的跑在新版本上')
  first.child.kill()
  await sleep(1200)
  const second = start(nodeExe, [join(bundle, 'launch.mjs')], { cwd: bundle, env })
  const up = await until(async () => {
    try {
      const response = await fetch(`${base}/api/session`)
      return response.ok ? await response.json() : null
    } catch { return null }
  }, 40_000)
  check('重启后起来了', up !== null, up === null ? second.output.join('').slice(-400) : '')
  check('跑的是新版本（指针真的生效了）', up?.version === NEW_VERSION, `${String(up?.version)} vs ${NEW_VERSION}`)
  check('数据没丢：设置还在（不用重新走向导）', up?.setupNeeded === false && up?.requiresPassword === true)
  check('更新下来的那个文件在（就是新版那份代码）', existsSync(join(versioned, 'UPDATED.txt')))
  second.child.kill()
  await sleep(600)

  log('⑦ 不是绿色包时不许自助更新（Docker / 源码运行）')
  const plainPort = await freePort()
  const plainBase = `http://127.0.0.1:${String(plainPort)}`
  const plain = start(process.execPath, [
    '--experimental-strip-types', join(repo, 'apps', 'server', 'src', 'index.ts'),
  ], {
    cwd: repo,
    env: { ...process.env, PORT: String(plainPort), HOST: '127.0.0.1', STUDIO_DATA_DIR: join(scratch, 'plain'), STUDIO_HOME: '' },
  })
  const plainUp = await until(async () => {
    try {
      const response = await fetch(`${plainBase}/api/health`)
      return response.ok
    } catch { return false }
  }, 40_000)
  check('直接跑源码也能起来（对照组）', plainUp === true, plainUp ? '' : plain.output.join('').slice(-300))
  const plainClient = client(plainBase)
  const plainApply = await plainClient.call('/api/update/apply', { method: 'POST' })
  check('没有 STUDIO_HOME 时回「这个部署方式不能自助更新」',
    plainApply.status === 400 && String(plainApply.json.error).includes('不能自助更新'), JSON.stringify(plainApply.json))
  plain.child.kill()
  await sleep(500)

  feed.close()
  rmSync(scratch, { recursive: true, force: true })
  log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[desktop] 失败:', error)
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 清了就好 */ }
  process.exit(1)
})
