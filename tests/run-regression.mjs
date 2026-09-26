/**
 * Studio 全量回归。
 *
 * 用法:
 *   node tests/run-regression.mjs [baseUrl] [password] [--only=a,b] [--skip=a,b]
 *
 * 这些用例是「一次做完、按顺序跑」的：先跑不依赖浏览器的（快、定位准），
 * 再跑需要 Edge/CDP 的（慢），最后跑会真的调用 ComfyUI 出图的（最慢）。
 * 每个用例都在自己的子进程里跑，一个挂了不影响后面的。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://127.0.0.1:8080'
const PASSWORD = positional[1] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'

const listArg = (flag) => (process.argv.find((a) => a.startsWith(`--${flag}=`)) ?? '').replace(`--${flag}=`, '')
const only = listArg('only').split(',').map((s) => s.trim()).filter(Boolean)
const skip = listArg('skip').split(',').map((s) => s.trim()).filter(Boolean)

/** 顺序 = 依赖从少到多；`slow: true` 的用例会真的走一遍出图。 */
const SUITES = [
  { name: 'layout', script: 'layout-test.mjs', args: [] },
  { name: 'progress', script: 'progress-test.mjs', args: [] },
  { name: 'ports', script: 'ports-test.mjs', args: [] },
  // 手写 PNG 编解码器的单测：颜色型/位深/滤波器/不支持格式/缩放算术。
  // 这一条特别值——解码器错了不会崩，只会安静地把图变样（16 位取错字节 = 满屏噪点）。
  { name: 'thumb', script: 'thumb-test.mjs', args: [] },
  { name: 'text', script: 'text-test.mjs', args: [] },
  { name: 'audio', script: 'audio-test.mjs', args: [] },
  { name: 'workflow-engine', script: 'workflow-engine-test.mjs', args: [] },
  // 账号（M1）：自己起一个 **cloud 模式**的临时实例（不需要浏览器、不需要邮箱服务），
  // 验注册/登录/会话轮换/邮箱验证/重置密码，以及「库里只存哈希」。
  { name: 'accounts', script: 'accounts-test.mjs', args: [] },
  // 桌面端绑定账号（M2）：起**两个**实例（cloud + local），把「浏览器回跳」整条链路走一遍，
  // 附带验「state 不对不给绑」「码只能用一次」「只能从本机回跳」。
  { name: 'cloud-link', script: 'cloud-link-test.mjs', args: [] },
  // 作品发布与审核（M3）：自己起 cloud + local 两个实例，验**「管理员点过才上主页」**
  // 这条要求的每个棱角——待审匿名打不开、作者/管理员能预览、通过后主页出现、
  // 素材只能通过作品取（拼别的素材 id 要 404）、被拒有理由、举报→下架闭环。
  { name: 'works', script: 'works-test.mjs', args: [] },
  // 备份（M2）：自己起一个 local 实例，做备份 → 改数据 → 恢复 → 重启，验「真的退回去了」；
  // 顺带验导出画布包与「只留 7 份」。
  { name: 'backup', script: 'backup-test.mjs', args: [] },
  // 运营底线（M4）与私人云备份（M5）：限流 / 配额 / 只读降级 / 机审 /
  // AI 生成标识进 PNG / 私密备份不进主页 / 删作品回收素材。
  // 自己起**四个**临时实例（默认、只读、带机审、机审接口挂掉）——都不依赖真凭据。
  { name: 'ops', script: 'ops-test.mjs', args: [] },
  { name: 'workflow-api', script: 'workflow-api-test.mjs', args: [BASE, PASSWORD] },
  { name: 'take-pipeline', script: 'take-pipeline-test.mjs', args: [BASE, PASSWORD] },
  { name: 'agent-canvas', script: 'agent-canvas-test.mjs', args: [BASE, PASSWORD] },
  { name: 'site-routing', script: 'site-routing-test.mjs', args: [BASE, PASSWORD] },
  { name: 'projects', script: 'projects-test.mjs', args: [BASE, PASSWORD] },
  { name: 'project-layout', script: 'project-layout-test.mjs', args: [BASE, PASSWORD] },
  { name: 'image-edit', script: 'image-edit-test.mjs', args: [BASE, PASSWORD] },
  // 单测而不是浏览器：只算裁剪/旋转的算术，不需要容器，也不碰 ComfyUI。
  { name: 'crop', script: 'crop-test.mjs', args: [] },
  // 视频工作流的**静态**验收：对着 ComfyUI 的 /object_info 逐节点核字段名。
  // 必须单独跑，因为一次真实生成要十几分钟——字段名写错不能等那么久才发现。
  // 不需要 Studio 容器，只需要 ComfyUI 在跑。
  { name: 'builtin-workflow', script: 'builtin-workflow-test.mjs', args: [] },
  // 画布上的视频节点：不出一段真片（那要十几分钟），但用一段真 mp4 验
  // 「浏览器到底解没解出画面」——<img src="x.mp4"> 什么都不显示。
  { name: 'canvas-video', script: 'canvas-video-test.mjs', args: [BASE, PASSWORD] },
  // 渲染作业的生命周期：提交立刻返回、没有浏览器也写回文档、能取消、刷新能接上。
  // 用出图（6-10 秒）验，不拿出片（十几分钟）——队列的正确性与片子多长无关。
  { name: 'jobs', script: 'jobs-test.mjs', args: [BASE, PASSWORD] },
  { name: 'assets', script: 'assets-test.mjs', args: [BASE, PASSWORD] },
  // 发布对话框（M3，界面侧）：入口在不在、字段齐不齐、按钮写的是「提交待审」还是
  // 「已发布」、文案有没有把 `**` 原样显示出来。**故意不点提交** —— 这台机器可能绑了真账号。
  { name: 'publish-ui', script: 'publish-ui-test.mjs', args: [BASE, PASSWORD] },
  { name: 'workflows', script: 'workflow-library-test.mjs', args: [BASE, PASSWORD], slow: true },
  { name: 'canvas-typing', script: 'canvas-typing-test.mjs', args: [BASE, PASSWORD] },
  { name: 'canvas-connect', script: 'canvas-connect-test.mjs', args: [BASE, PASSWORD] },
  { name: 'canvas-sidebar', script: 'canvas-sidebar-test.mjs', args: [BASE, PASSWORD] },
  { name: 'canvas-prompt-window', script: 'canvas-prompt-window-test.mjs', args: [BASE, PASSWORD] },
  { name: 'canvas-interaction', script: 'canvas-interaction-test.mjs', args: [BASE, PASSWORD] },
  { name: 'canvas-selection', script: 'canvas-selection-test.mjs', args: [BASE, PASSWORD] },
  { name: 'canvas-ux', script: 'canvas-ux-test.mjs', args: [BASE, PASSWORD], slow: true },
  { name: 'generation-progress', script: 'generation-progress-test.mjs', args: [BASE, PASSWORD], slow: true },
  { name: 'agent-live-sync', script: 'agent-live-sync-test.mjs', args: [BASE, PASSWORD] },
  // 打包与自助更新：**自己打一个绿色包**（会构建前端）、用包里自带的 Node 跑起来、
  // 在界面上走一遍首启向导、再起一个本地更新源让它更新并重启验证。
  // 不依赖 Studio 容器，但比别的用例慢（一次前端构建 + 两次启动）。
  { name: 'desktop', script: 'desktop-test.mjs', args: [], slow: true },
  { name: 'e2e-studio', script: 'e2e-studio.mjs', args: [BASE, PASSWORD], slow: true },
]

const wanted = SUITES.filter((s) => (only.length === 0 || only.includes(s.name)) && !skip.includes(s.name))
if (wanted.length === 0) {
  console.error('[regression] 没有匹配的用例:', { only, skip })
  process.exit(2)
}

/**
 * Delete the canvases a suite created.
 *
 * Most suites build a canvas to work on and never delete it, so a full run used
 * to leave ~20 behind and the workspace filled up with 「提示词窗口验收」 every
 * day. Cleaning up per suite (rather than per test file) means a new suite gets
 * this for free.
 *
 * Two rules keep this from ever touching real work:
 *
 * 1. **Only ids that appeared during that suite** are candidates.
 * 2. **Only names that match a known test prefix** are deleted. Time alone is not
 *    evidence of authorship: an earlier version deleted everything created while
 *    a suite ran, and swept up a canvas the user had just made. It went to the
 *    trash, not to oblivion, but the rule was still wrong.
 *
 * Deletion is `?purge=1` — a sweep that only trashes just moves the mess.
 */
const TEST_PREFIXES = [
  '交互验收', '提示词窗口验收', '连线手势验收', '布局回归', '切换项目回归',
  '外壳验收', 'Agent 双入口验收', 'Agent 实时同步验收', '端到端验收',
  '验收文件夹', '改名后的文件夹', '验收画布', '别的工作区画布',
  '孤立画布', '列表验收', '进度验收', '框选验收', '探针项目', '接口探针', '播种',
  'Take 流水线验收', 'DAG 引擎验收', '打字复现', '未命名项目（曾经乱码，已修复）',
  '在文件夹里的画布', '副本源头', '卡片改名', '待删画布', '迁移探针',
]

let cachedCookie = ''
/** Log in once and reuse the cookie for cleanup. */
const sessionCookie = async () => {
  if (cachedCookie !== '') return cachedCookie
  const raw = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  })
  cachedCookie = (raw.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
  return cachedCookie
}

const listProjects = async () => {
  const cookie = await sessionCookie()
  const response = await fetch(`${BASE}/api/projects`, { headers: { cookie } })
  if (!response.ok) return null
  return (await response.json()).projects ?? []
}

/** Purge every test-named canvas created since `before`. */
const sweep = async (before) => {
  if (before === null) return
  const cookie = await sessionCookie()
  const fresh = (await listProjects() ?? []).filter((project) =>
    !before.includes(project.id) && TEST_PREFIXES.some((prefix) => project.name.startsWith(prefix)))
  for (const project of fresh) {
    await fetch(`${BASE}/api/projects/${encodeURIComponent(project.id)}?purge=1`, { method: 'DELETE', headers: { cookie } })
  }
  if (fresh.length > 0) {
    console.log(`[regression] 🧹 收尾：彻底删除这个用例建过的 ${String(fresh.length)} 个画布（${fresh.map((p) => p.name).join('、')}）`)
  }
}

const runOne = (suite) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(process.execPath, [join(HERE, suite.script), ...suite.args], {
    cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
  child.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
  child.on('close', (code) => resolve({ ...suite, code, ms: Date.now() - started, out }))
})

console.log(`[regression] base=${BASE} 用例=${wanted.length} 个\n`)
const results = []
for (const suite of wanted) {
  console.log(`\n${'='.repeat(72)}\n[regression] ▶ ${suite.name} (${suite.script})\n${'='.repeat(72)}`)
  const before = await listProjects()
  const r = await runOne(suite)
  await sweep(before === null ? null : before.map((project) => project.id))
  console.log(`[regression] ${r.code === 0 ? '✅ 通过' : '❌ 失败'} ${suite.name} — ${(r.ms / 1000).toFixed(1)}s`)
  results.push(r)
}

const failed = results.filter((r) => r.code !== 0)
console.log(`\n${'='.repeat(72)}\n[regression] 汇总：${results.length - failed.length}/${results.length} 通过`)
for (const r of results) {
  const bad = r.code === 0 ? '' : (r.out.split('\n').filter((l) => l.includes('❌') || l.includes('未通过')).slice(-3).join(' / ') || `exit ${r.code}`)
  console.log(`  ${r.code === 0 ? '✅' : '❌'} ${r.name.padEnd(22)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${bad}`)
}
process.exit(failed.length === 0 ? 0 : 1)
