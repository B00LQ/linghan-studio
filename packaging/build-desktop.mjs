/**
 * 打绿色包（Windows x64）与自助更新包。
 *
 * 用法：
 *   node packaging/build-desktop.mjs                     # 构建前端 → 打绿色包 + 更新包
 *   node packaging/build-desktop.mjs --node <node.exe>   # 指定要捆进包里的 Node
 *   node packaging/build-desktop.mjs --url <更新包地址>  # 写进 update.json 的下载地址
 *   node packaging/build-desktop.mjs --skip-build        # 前端已经构建过，省一步
 *
 * 产出（都在 `dist-desktop/` 下）：
 * - `LINGHAN-Studio/`：可以直接双击运行的目录（自带 Node，不需要装任何东西）。
 * - `LINGHAN-Studio-<版本>-win-x64.zip`：整个目录的压缩包，发给别人用。
 * - `LINGHAN-Studio-<版本>-update.zip`：**更新包**，只有程序本身（没有 Node 与启动器）。
 *   自助更新装的就是它 —— 换 Node 运行时不该是更新的一部分。
 * - `update.json`：更新源清单（version / url / sha256 / notes）。把它放到一个
 *   HTTPS 地址上，配置 `STUDIO_UPDATE_URL` 指向它，绿色包就能自助更新了。
 * - 如果装了 Inno Setup（`ISCC.exe`），顺带编译出安装程序 `LINGHAN-Studio-<版本>-setup.exe`。
 *
 * **为什么不捆绑 ComfyUI**（这一条是许可问题，不是技术问题）：ComfyUI 是 GPL-3.0。
 * 把它的代码/二进制打进安装包里，整个安装包的再分发就要按 GPL 走 —— 而这份产品是
 * 专有许可（见 LICENSE）。所以安装包**只装 Studio 自己**，出图后端由用户在首启向导里
 * 指向他自己那份 ComfyUI（页面只填一个地址，不复制、不分发它的任何文件）。
 * 这条界线同时也是**体积**上的常识：ComfyUI 加模型动辄几十 GB，那是用户自己的算力。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const has = (name) => args.includes(`--${name}`)

const NAME = flag('name', 'LINGHAN-Studio')
const OUT = resolve(repo, flag('out', 'dist-desktop'))
const UPDATE_URL = flag('url', 'https://example.invalid/linghan-studio-<version>-update.zip')
const NOTES = flag('notes', '')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const VERSION = pkg.version
const bundle = join(OUT, NAME)

const log = (message) => { console.log(`[pack] ${message}`) }

/** 要拷进包里的（**程序本身**：服务端源码 + 前端构建产物 + package.json）。 */
const PAYLOAD = [
  { from: 'apps/server/src', to: join('app', 'apps', 'server', 'src') },
  { from: 'apps/web/dist', to: join('app', 'apps', 'web', 'dist') },
  { from: 'package.json', to: join('app', 'package.json') },
]

if (!has('skip-build')) {
  log('构建前端…')
  execFileSync('pnpm', ['--filter', '@studio/web', 'build'], { cwd: repo, stdio: 'inherit', shell: true })
}
if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) {
  console.error('[pack] 没有前端构建产物（apps/web/dist）。去掉 --skip-build 再跑一次。')
  process.exit(1)
}

log(`清理 ${bundle}`)
rmSync(bundle, { recursive: true, force: true })
mkdirSync(bundle, { recursive: true })

/** 拷贝时排掉的东西：测试、类型定义、编辑器产物 —— 包里不需要。 */
const skip = (source) => /(^|[\\/])(node_modules|__pycache__)([\\/]|$)/u.test(source)
  || /\.test\.[cm]?[jt]s$/u.test(source)

for (const entry of PAYLOAD) {
  const from = join(repo, entry.from)
  if (!existsSync(from)) {
    console.error(`[pack] 缺少 ${entry.from}`)
    process.exit(1)
  }
  cpSync(from, join(bundle, entry.to), { recursive: true, filter: (source) => !skip(source) })
  log(`拷入 ${entry.from} → ${entry.to}`)
}

// 启动器放在包根目录（它是**不会被更新**的那一层：更新换的是 app/ 那一份）。
cpSync(join(repo, 'packaging', 'launch.mjs'), join(bundle, 'launch.mjs'))

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
const launcherName = process.platform === 'win32' ? '启动 Studio.cmd' : 'start-studio.sh'
if (process.platform === 'win32') {
  writeFileSync(join(bundle, launcherName), [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'title LINGHAN Studio',
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
  name: NAME,
  version: VERSION,
  builtAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
}, null, 2)}\n`, 'utf8')

writeFileSync(join(bundle, '使用说明.txt'), [
  `${NAME} ${VERSION}`,
  '',
  '双击「' + launcherName + '」就会启动，浏览器会自动打开界面。',
  '第一次启动会有一个三步向导：设访问密码、选出图后端（可以先跳过）。',
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
].join('\r\n'), 'utf8')

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

log('打绿色包…')
const portableZip = join(OUT, `${NAME}-${VERSION}-win-x64.zip`)
const portableBytes = archive(bundle, portableZip, true)

// 更新包：只有 app/ 那一份（单层根目录，服务端解包时会自动剥掉）。
log('打更新包…')
const payloadRoot = join(bundle, 'app')
const updateZip = join(OUT, `${NAME}-${VERSION}-update.zip`)
const updateBytes = archive(payloadRoot, updateZip, false)

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
    `/DSourceDir=${bundle}`,
    `/DOutputDir=${OUT}`,
    join(repo, 'packaging', 'linghan-studio.iss'),
  ], { stdio: 'inherit' })
  installer = join(OUT, `${NAME}-${VERSION}-setup.exe`)
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
if (installer !== '') log(`  安装程序  ${installer}`)
