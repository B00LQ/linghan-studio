/**
 * 打发布包（Windows x64）与自助更新包。
 *
 * 用法：
 *   node packaging/build-desktop.mjs                        # 构建前端 → 打包 + 更新包
 *   node packaging/build-desktop.mjs --node <node.exe>      # 指定要捆进包里的 Node
 *   node packaging/build-desktop.mjs --url <更新包地址>      # 写进 update.json 的下载地址
 *   node packaging/build-desktop.mjs --default-password xxx # 安装版预置的访问密码（默认 admin）
 *   node packaging/build-desktop.mjs --skip-build           # 前端已经构建过，省一步
 *
 * 产出（都在 `dist-desktop/` 下）：
 * - `LHIC/`：可以直接双击运行的目录（自带 Node + Electron，不需要装任何东西）。
 * - `LHIC-<版本>-win-x64.zip`：整个目录的压缩包，发给别人用。
 * - `LHIC-<版本>-update.zip`：**更新包**，只有程序本身（没有 Node 与启动器）。
 * - `update.json`：更新源清单（version / url / sha256 / notes）。
 * - 装了 Inno Setup（`ISCC.exe`）还会编译出 `LHIC-<版本>-setup.exe`。
 *
 * ## 为什么服务端要**打包压缩成一个文件**（而不是直接发 `.ts` 源码）
 *
 * 这一版开始的规矩：**包里不含可读源码**。服务端用 esbuild 打成 `app/server.mjs`
 * （minify、不带 sourcemap），前端本来就是构建产物。原因很直白：绿色包解压出来
 * 就是一堆 `.ts` 文件的话，任何人拷走就能改个名字当自己的产品发。
 *
 * 说清边界：这**不是加密**，也不可能是 —— 程序要在用户机器上跑，密钥就得跟着包走，
 * 谁都能逆向。它只是把门槛从"拷走就能改"抬到"得逆向一个压缩包"，配合专有许可（LICENSE）
 * 就是这类产品的常规做法。
 *
 * 两个连带的约束：
 * 1. 内置工作流是**运行时读的 JSON**（`apps/server/src/comfyui/*.json`，靠
 *    `import.meta.dirname` 找），所以它们要单独拷到 `app/comfyui/` —— 打包之后
 *    `import.meta.dirname` 就是 `app/`。
 * 2. `launch.mjs` 与 Electron 外壳要**两种布局都认**（打包版 `server.mjs`、
 *    老版本 `apps/server/src/index.ts`）：更新时 `app/` 整份换掉，而它们不在更新范围内，
 *    不认老布局就会把老用户锁在门外。
 *
 * **为什么不捆绑 ComfyUI**（许可问题，不是技术问题）：ComfyUI 是 GPL-3.0，
 * 把它的代码/二进制打进安装包，整个包的再分发就要按 GPL 走 —— 而这份产品是专有许可。
 * 所以包里只有 LHIC 自己；出图后端由用户在首启向导里指向他自己那份 ComfyUI。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { writeIcon, writeIco } from './make-icon.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
/** 取一个参数：`--name value` 与 `--name=value` 两种写法都认（空值也算数）。 */
const flag = (name, fallback) => {
  const inline = args.find((item) => item.startsWith(`--${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 3)
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const has = (name) => args.includes(`--${name}`)

const PRODUCT = flag('name', 'LHIC')
const OUT = resolve(repo, flag('out', 'dist-desktop'))
const UPDATE_URL = flag('url', 'https://github.com/B00LQ/linghan-studio/releases/download/v<version>/LHIC-<version>-update.zip')
const NOTES = flag('notes', '')
/** 安装版预置的访问密码：下载 → 双击 → 点一下登录就能用。空串 = 不预置（走首启向导）。 */
const DEFAULT_PASSWORD = flag('default-password', 'admin')
/** 打不打 Electron（默认打：桌面端要是**应用窗口**，不是浏览器窗口）。 */
const WITH_ELECTRON = !has('no-electron')
const ELECTRON_VERSION = flag('electron-version', '33.4.11')
const mirror = process.env.ELECTRON_MIRROR ?? 'https://registry.npmmirror.com/-/binary/electron/'
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const VERSION = pkg.version
const bundle = join(OUT, PRODUCT)

const log = (message) => { console.log(`[pack] ${message}`) }

if (!has('skip-build')) {
  log('构建前端…')
  // Windows 上**故意走 `cmd /c`，不走 `shell: true`**：PowerShell 的 pnpm shim 会把
  // 每条脚本行回显到 stderr，而「打包脚本 stderr 里有内容」会让自动化误判成失败。
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'pnpm --filter @studio/web build'], { cwd: repo, stdio: 'inherit' })
  } else {
    execFileSync('pnpm', ['--filter', '@studio/web', 'build'], { cwd: repo, stdio: 'inherit' })
  }
}
if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) {
  console.error('[pack] 没有前端构建产物（apps/web/dist）。去掉 --skip-build 再跑一次。')
  process.exit(1)
}

log(`清理 ${bundle}`)
rmSync(bundle, { recursive: true, force: true })
mkdirSync(bundle, { recursive: true })

const appDir = join(bundle, 'app')
mkdirSync(appDir, { recursive: true })

/**
 * 用 esbuild 把服务端打成一个文件。
 *
 * `--platform=node` 让 `node:` 内置模块保持外置（它们本来就该外置：Node 自己提供）；
 * `--format=esm` 是因为源码就是 ESM（有 top-level await）；`--minify` 是这一版的
 * **目的之一**（见文件头那段说明）。
 */
function bundleServer() {
  /**
   * 直接跑 esbuild 的 **JS 入口**，不走 `node_modules/.bin/esbuild.cmd`。
   *
   * Node 从 18.20/20.12 起**拒绝**在没有 `shell: true` 的情况下 spawn `.cmd`/`.bat`
   * （EINVAL，防命令注入）；而配上 `shell: true` 又会把 stderr 弄脏（见上面那段说明）。
   * 用 `node <pkg>/bin/esbuild` 两个问题都没有：没有 shell，也没有 .cmd。
   */
  const esbuild = join(repo, 'node_modules', 'esbuild', 'bin', 'esbuild')
  if (!existsSync(esbuild)) {
    console.error('[pack] 找不到 esbuild。先 `pnpm install`（它是打包用的开发依赖）。')
    process.exit(1)
  }
  const common = ['--bundle', '--platform=node', '--format=esm', '--target=node24', '--minify', '--legal-comments=none']
  const run = (entry, outfile) => {
    log(`打包 ${entry} → ${outfile}`)
    execFileSync(process.execPath, [
      esbuild,
      join(repo, 'apps', 'server', 'src', entry),
      ...common,
      `--outfile=${join(appDir, outfile)}`,
    ], { cwd: repo, stdio: 'inherit' })
  }
  run('index.ts', 'server.mjs')
  // 启动器与 Electron 外壳要用版本指针那几个函数（`activeVersionDir` / `installedVersions`）。
  // 单独打一份小包，好过在三个地方各抄一遍五行逻辑。
  run('update.ts', 'update.mjs')
}
bundleServer()

// 内置工作流是运行时读的 JSON（靠 import.meta.dirname 找），打包后要在 app/ 旁边。
cpSync(join(repo, 'apps', 'server', 'src', 'comfyui'), join(appDir, 'comfyui'), { recursive: true })
log('内置工作流已就位（app/comfyui）')
// 前端构建产物：打包布局下服务端认 `app/web`（见 index.ts 的 findWebDist）。
cpSync(join(repo, 'apps', 'web', 'dist'), join(appDir, 'web'), { recursive: true })
log('前端产物已就位（app/web）')
cpSync(join(repo, 'package.json'), join(appDir, 'package.json'))

/**
 * 安装版预置值。
 *
 * 只预置两件事：访问密码，以及「这个密码是预置的」这个事实（服务端据此在
 * 本机请求里把密码告诉登录页，让它预填）。用户改过密码之后服务端就不再下发它。
 */
if (DEFAULT_PASSWORD !== '') {
  writeFileSync(join(appDir, '.env'), [
    '# 安装版的预置值。改这里等于改默认密码；界面上改过之后以界面为准。',
    `STUDIO_PASSWORD=${DEFAULT_PASSWORD}`,
    `STUDIO_DEFAULT_PASSWORD=${DEFAULT_PASSWORD}`,
    '',
  ].join('\n'), 'utf8')
  log(`已预置访问密码（${DEFAULT_PASSWORD}）：装完点一下「进入」就能用`)
}

// 启动器放在包根目录（它是**不会被更新**的那一层：更新换的是 app/ 那一份）。
cpSync(join(repo, 'packaging', 'launch.mjs'), join(bundle, 'launch.mjs'))
// 桌面窗口外壳（Electron 主进程 + 端口探测 + .env 读取）也放在不会被更新的那一层。
cpSync(join(repo, 'packaging', 'desktop'), join(bundle, 'desktop'), { recursive: true })
// 图标：任务栏、快捷方式与安装程序里那张脸（.ico 是 Windows 那些地方唯一认的格式）。
writeIcon(join(bundle, 'icon.png'))
writeIco(join(bundle, 'icon.ico'))
log('桌面外壳与图标已就位（desktop/、icon.png、icon.ico）')

/**
 * Electron：**独立应用窗口**要用它（没有地址栏、没有标签页、任务栏上是自己）。
 *
 * 它只做窗口，服务端仍由自带的 `node/node.exe` 跑 —— 因为 Electron 的 Node
 * **没有** `node:sqlite`（实测 Electron 33 / Node 20：`No such built-in module`），
 * 服务端搬不进去。代价是包大一倍多，换来的是它看起来、用起来都是一个应用。
 */
if (WITH_ELECTRON) {
  const cache = join(OUT, '.electron')
  const dist = join(cache, 'node_modules', 'electron', 'dist')
  if (!existsSync(join(dist, 'electron.exe'))) {
    log(`下载 Electron ${ELECTRON_VERSION}（约 180 MB，走 ${mirror}）…`)
    rmSync(cache, { recursive: true, force: true })
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'package.json'), '{"name":"electron-download","private":true}\n', 'utf8')
    try {
      execFileSync(`npm install electron@${ELECTRON_VERSION} --no-audit --no-fund --loglevel=error`, {
        cwd: cache,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ELECTRON_MIRROR: mirror },
      })
    } catch (error) {
      log(`Electron 下载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (existsSync(join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron'))) {
    cpSync(dist, join(bundle, 'electron'), { recursive: true })
    log('Electron 已打进包：双击启动的是**独立应用窗口**（无地址栏/标签页）')
  } else {
    log('没有可用的 Electron：这个包会用 Chromium 的 --app= 窗口，或退到系统浏览器。')
    log(`想拿到真应用窗口：设 ELECTRON_MIRROR 后重跑，或先手动 node ${join(repo, 'packaging', 'build-desktop.mjs')} --electron-version=<版本>。`)
  }
}

// Node 运行时：默认用「正在跑这个脚本的那个 node」，所以构建机器上是什么版本，
// 用户拿到就是什么版本 —— 这个产品的部署承诺里写着「只需要 Node 24」。
const nodeSource = resolve(flag('node', process.execPath))
if (!existsSync(nodeSource)) {
  console.error(`[pack] 找不到 Node 可执行文件：${nodeSource}`)
  process.exit(1)
}
mkdirSync(join(bundle, 'node'), { recursive: true })
const nodeTarget = join(bundle, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
cpSync(nodeSource, nodeTarget)
log(`捆入 Node：${nodeSource} → node/${nodeTarget.split(/[\\/]/u).pop()}`)

// 双击就能跑。**故意保留这个控制台窗口**：它是日志与报错唯一的出口，
// 藏起来的话「启动失败」就变成「什么都没发生」。
const launcherName = process.platform === 'win32' ? `启动 ${PRODUCT}.cmd` : 'start-studio.sh'
if (process.platform === 'win32') {
  writeFileSync(join(bundle, launcherName), [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    `title ${PRODUCT}`,
    '"%~dp0node\\node.exe" "%~dp0launch.mjs"',
    'echo.',
    'echo 已退出。按任意键关闭这个窗口。',
    'pause >nul',
    '',
  ].join('\r\n'), 'utf8')
} else {
  writeFileSync(join(bundle, launcherName), '#!/bin/sh\ncd "$(dirname "$0")"\nexec ./node/node ./launch.mjs\n', 'utf8')
}

writeFileSync(join(bundle, 'version.json'), `${JSON.stringify({
  name: PRODUCT,
  version: VERSION,
  builtAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
}, null, 2)}\n`, 'utf8')

writeFileSync(join(bundle, '使用说明.txt'), [
  `${PRODUCT} ${VERSION}`,
  '',
  `双击「${launcherName}」就会启动，应用窗口会自动打开。`,
  DEFAULT_PASSWORD === ''
    ? '第一次启动会有一个向导：设访问密码、选出图后端（可以先跳过）。'
    : `第一次打开会让你输访问密码：已经预置好了（${DEFAULT_PASSWORD}），登录页会自动填上，点「进入」即可。`,
  DEFAULT_PASSWORD === '' ? '' : '想换成自己的密码：进设置页改（改完之后预置的那个就失效了）。',
  '',
  '数据（画布、生成的图、上传的素材）都在这个文件夹的 data\\ 里：',
  '  · 想搬家/备份 → 整个文件夹拷走；',
  '  · 想放到别的盘 → 设环境变量 STUDIO_DATA_DIR 指向那个目录。',
  '',
  '出图需要另外一份 ComfyUI（本机显卡）或火山方舟的 Key —— 这个包里不含模型，',
  '也不含 ComfyUI（它是 GPL 软件，不随本产品分发）。在向导或设置页里填地址即可。',
  '',
  '卸载就是删掉这个文件夹。删之前先把 data\\ 里想要的东西拷出来。',
  '',
  '端口默认 8080，被占用时会自动往后找一个；窗口里会打印实际地址。',
  '',
].filter((line) => line !== undefined).join('\r\n'), 'utf8')

/** 打 zip：Windows 用 Compress-Archive，其它平台用 zip。 */
function archive(sourcePath, zipPath, insideFolder) {
  rmSync(zipPath, { force: true })
  if (process.platform === 'win32') {
    const command = insideFolder
      ? `Compress-Archive -LiteralPath '${sourcePath}' -DestinationPath '${zipPath}' -Force`
      : `Compress-Archive -Path '${join(sourcePath, '*')}' -DestinationPath '${zipPath}' -Force`
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' })
  } else {
    execFileSync('zip', ['-qr', zipPath, insideFolder ? '.' : '*'], { cwd: sourcePath, stdio: 'inherit' })
  }
  return statSync(zipPath).size
}

log('打发布包…')
const portableZip = join(OUT, `${PRODUCT}-${VERSION}-win-x64.zip`)
const portableBytes = archive(bundle, portableZip, true)

// 更新包：只有 app/ 那一份（单层根目录，服务端解包时会自动剥掉）。
log('打更新包…')
const updateZip = join(OUT, `${PRODUCT}-${VERSION}-update.zip`)
const updateBytes = archive(appDir, updateZip, false)

const sha256 = createHash('sha256').update(readFileSync(updateZip)).digest('hex')
const manifestPath = join(OUT, 'update.json')
writeFileSync(manifestPath, `${JSON.stringify({
  version: VERSION,
  url: UPDATE_URL.replace('<version>', VERSION),
  sha256,
  notes: NOTES,
}, null, 2)}\n`, 'utf8')

// 有 Inno Setup 就顺手把安装程序编译出来；没有就说清楚缺什么，而不是假装成功。
let installer = ''
const isccCandidates = [
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  join(homedir(), 'AppData', 'Local', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
]
const iscc = isccCandidates.find((candidate) => existsSync(candidate))
if (iscc !== undefined) {
  log('编译安装程序（Inno Setup）…')
  execFileSync(iscc, [
    `/DAppVersion=${VERSION}`,
    `/DProduct=${PRODUCT}`,
    `/DSourceDir=${bundle}`,
    `/DOutputDir=${OUT}`,
    `/DLangDir=${join(repo, 'packaging', 'languages')}`,
    join(repo, 'packaging', 'lhic.iss'),
  ], { stdio: 'inherit' })
  installer = join(OUT, `${PRODUCT}-${VERSION}-setup.exe`)
} else {
  log('没找到 Inno Setup（ISCC.exe），跳过安装程序。')
  log('想生成 setup.exe：装 https://jrsoftware.org/isdl.php 之后重跑这个脚本，')
  log('或直接分发绿色包 zip —— 它不需要安装，解压就能用。')
}

log('完成：')
log(`  目录      ${bundle}`)
log(`  绿色包    ${portableZip}  ${(portableBytes / 1024 / 1024).toFixed(1)} MB`)
log(`  更新包    ${updateZip}  ${(updateBytes / 1024 / 1024).toFixed(1)} MB`)
log(`  更新清单  ${manifestPath}`)
log(`            sha256 ${sha256.slice(0, 16)}…`)
if (installer !== '') {
  log(`  安装程序  ${installer}  ${(statSync(installer).size / 1024 / 1024).toFixed(1)} MB`)
}
