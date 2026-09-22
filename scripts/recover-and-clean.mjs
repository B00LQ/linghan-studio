/**
 * 一次性恢复/清理。
 *
 * 事故：回归跑完后我加的「自动收尾」是按「这个用例运行期间新出现的画布」删的，
 * 而它用的是 DELETE（现在=进回收站）。于是 07:23 那几分钟里你自己建的
 * 「测试一下」也被扫进了回收站。东西没丢（回收站里能还原），但这说明
 * 收尾规则写得太宽：它按时间判断，而不是按「是不是测试建的」判断。
 *
 * 这个脚本做两件事：
 * 1. 把名字不像测试的画布**全部还原**（宁可多还，不可误删）；
 * 2. 把名字确定是测试留下的画布**彻底删除**，并清掉空文件夹。
 */
const BASE = 'http://127.0.0.1:8080'
const PASSWORD = process.env.STUDIO_PASSWORD ?? 'studio-demo-2026'

const TEST_PREFIXES = [
  '交互验收', '提示词窗口验收', '连线手势验收', '布局回归', '切换项目回归',
  '外壳验收', 'Agent 双入口验收', 'Agent 实时同步验收', '端到端验收',
  '验收文件夹', '改名后的文件夹', '验收画布', '别的工作区画布',
  '孤立画布', '列表验收', '进度验收', '框选验收', '探针项目', '接口探针', '播种',
  'Take 流水线验收', 'DAG 引擎验收', '打字复现', '未命名项目（曾经乱码，已修复）',
  '在文件夹里的画布', '副本源头', '卡片改名', '待删画布', '迁移探针',
]

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
})
const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
const call = (path, init = {}) => fetch(`${BASE}${path}`, {
  ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
})

const trash = (await (await call('/api/projects?trash=1')).json()).projects ?? []
const isTest = (name) => TEST_PREFIXES.some((prefix) => name.startsWith(prefix))

const mine = trash.filter((project) => isTest(project.name))
const yours = trash.filter((project) => !isTest(project.name))

console.log(`回收站里 ${String(trash.length)} 个：疑似测试 ${String(mine.length)} 个，不像测试 ${String(yours.length)} 个`)
console.log('')
for (const project of yours) console.log(`  还原  ${project.name}（${project.deletedAt}）`)
for (const project of mine) console.log(`  彻底删  ${project.name}`)
console.log('')

for (const project of yours) {
  const response = await call(`/api/projects/${project.id}/restore`, { method: 'POST' })
  if (!response.ok) console.error(`  还原失败：${project.name}（HTTP ${String(response.status)}）`)
}
for (const project of mine) {
  const response = await call(`/api/projects/${project.id}?purge=1`, { method: 'DELETE' })
  if (!response.ok) console.error(`  删除失败：${project.name}（HTTP ${String(response.status)}）`)
}

const folders = (await (await call('/api/folders')).json()).folders ?? []
for (const folder of folders) {
  if (folder.canvasCount === 0 && folder.name.includes('文件夹')) {
    await call(`/api/folders/${folder.id}`, { method: 'DELETE' })
    console.log(`  删掉空文件夹「${folder.name}」`)
  }
}

const after = await (await call('/api/projects')).json()
const stillTrash = (await (await call('/api/projects?trash=1')).json()).projects ?? []
console.log('')
console.log(`现在：${String((after.projects ?? []).length)} 个画布在工作区，回收站剩 ${String(stillTrash.length)} 个`)
console.log('画布：', (after.projects ?? []).map((project) => project.name).join(' | ') || '（无）')
