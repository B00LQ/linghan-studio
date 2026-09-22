/**
 * 清理回归测试留下的画布。
 *
 * 用法:
 *   node scripts/cleanup-test-projects.mjs                          # 只列出，不删（默认）
 *   node scripts/cleanup-test-projects.mjs --yes                    # 真的删
 *   node scripts/cleanup-test-projects.mjs --yes --keep-recent=20   # 保留最近 20 个
 *   node scripts/cleanup-test-projects.mjs --yes --include-unnamed  # 连「未命名画布」一起清
 *
 * 为什么要单独一个脚本：跑一次全量回归会建 20 多个画布，日积月累就把
 * 「最近画布」和项目页糊满了。测试自己会在结束时清理，但中途失败的那些会留下。
 *
 * 安全策略：
 * - 默认 dry-run，不删任何东西
 * - 只删名字命中**已知测试前缀**的画布，不按时间、不按「看起来像测试」猜
 * - 打印每个将被删除的名字，删之前先让人看见
 * - 素材库不碰：它是内容寻址、跨项目共享的
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dryRun = !args.includes('--yes')
const keepRecentArg = args.find((a) => a.startsWith('--keep-recent='))
const keepRecent = Number(keepRecentArg?.replace('--keep-recent=', '') ?? '0')
const BASE = args.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8080'

/** 测试脚本建过的名字前缀。新增用例时把前缀加到这里。 */
const TEST_PREFIXES = [
  '交互验收', '提示词窗口验收', '连线手势验收', '布局回归', '切换项目回归',
  '外壳验收', 'Agent 双入口验收', 'Agent 实时同步验收', '端到端验收',
  '验收文件夹', '改名后的文件夹', '验收画布', '别的工作区画布',
  '孤立画布', '列表验收', '进度验收', '框选验收', '探针项目', '接口探针', '播种',
  'Take 流水线验收', 'DAG 引擎验收', '打字复现', '未命名项目（曾经乱码，已修复）',
  '在文件夹里的画布', '副本源头', '卡片改名', '待删画布', '迁移探针',
]

/**
 * 「未命名画布」不在默认名单里：那正是用户点「新建画布创作」得到的第一张画布，
 * 也可能是他刚开始做的东西。要一起清就显式加开关。
 */
const UNNAMED = ['未命名画布', '未命名项目']

/** 测试建过的文件夹前缀。删文件夹只解绑，不删画布。 */
const FOLDER_PREFIXES = ['验收文件夹', '改名后的文件夹', '未命名文件夹']

/** 从本机数据目录读出密码，省得每次手输。 */
function passwordFromEnvFile() {
  try {
    const raw = readFileSync(join(import.meta.dirname, '..', '.env.local'), 'utf8')
    const line = raw.split(/\r?\n/u).find((item) => item.startsWith('STUDIO_PASSWORD='))
    return line?.slice('STUDIO_PASSWORD='.length).trim() ?? ''
  } catch {
    return ''
  }
}

const password = process.env.STUDIO_PASSWORD ?? process.argv.find((a) => a.startsWith('--password='))?.replace('--password=', '') ?? passwordFromEnvFile()
if (password === '') {
  console.error('缺少密码：设 STUDIO_PASSWORD，或加 --password=xxx，或在 studio/.env.local 里写 STUDIO_PASSWORD=xxx')
  process.exit(2)
}

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
})
if (!login.ok) {
  console.error(`登录失败：HTTP ${String(login.status)}`)
  process.exit(1)
}
const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
const projects = (await (await fetch(`${BASE}/api/projects?trash=1`, { headers: { cookie } })).json()).projects ?? []
// 回收站里的也要一起收，否则它们只是看不见，并没有走。
const live = ((await (await fetch(`${BASE}/api/projects`, { headers: { cookie } })).json()).projects ?? []).map((p) => p.id)

const matched = projects.filter((project) => TEST_PREFIXES.some((prefix) => project.name.startsWith(prefix))
  || (args.includes('--include-unnamed') && UNNAMED.some((prefix) => project.name.startsWith(prefix))))
const keep = new Set(projects.slice(0, keepRecent).map((project) => project.id))
const doomed = matched.filter((project) => !live.includes(project.id) || !keep.has(project.id))

const manifest = (await (await fetch(`${BASE}/api/folders`, { headers: { cookie } })).json()).folders ?? []
const emptyFolders = manifest.filter((folder) => FOLDER_PREFIXES.some((prefix) => folder.name.startsWith(prefix)))
const emptySpaces = emptyFolders

console.log(`共 ${String(projects.length)} 个画布（含回收站），其中 ${String(matched.length)} 个名字像测试留下的`)
if (keepRecent > 0) console.log(`保留最近 ${String(keepRecent)} 个（--keep-recent）`)
console.log('')
for (const project of doomed) console.log(`  ${dryRun ? '将删除' : '删除'}  画布  ${project.name}${project.deletedAt === '' ? '' : '（在回收站里）'}`)
for (const folder of emptyFolders) console.log(`  ${dryRun ? '将删除' : '删除'}  文件夹「${folder.name}」（里面的画布会变成未归档）`)
console.log('')

if (doomed.length === 0 && emptySpaces.length === 0) {
  console.log('没有需要清理的。')
  process.exit(0)
}
if (dryRun) {
  console.log(`以上 ${String(doomed.length)} 个画布、${String(emptySpaces.length)} 个文件夹只是列出，没有删除。确认无误后加 --yes 再跑一次。`)
  process.exit(0)
}

let removed = 0
for (const project of doomed) {
  // purge=1：清库要真的清掉，只丢进回收站等于没清。
  const response = await fetch(`${BASE}/api/projects/${encodeURIComponent(project.id)}?purge=1`, { method: 'DELETE', headers: { cookie } })
  if (response.ok) removed += 1
  else console.error(`  删除失败：${project.name}（HTTP ${String(response.status)}）`)
}
let goneSpaces = 0
for (const folder of emptyFolders) {
  const response = await fetch(`${BASE}/api/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE', headers: { cookie } })
  if (response.ok) goneSpaces += 1
  else console.error(`  删除失败：${folder.name}（HTTP ${String(response.status)}）`)
}
console.log(`已删除 ${String(removed)} 个画布、${String(goneSpaces)} 个文件夹；素材库未改动。`)
