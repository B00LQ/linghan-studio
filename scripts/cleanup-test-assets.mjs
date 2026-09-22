/**
 * 清掉早先那次「编辑验收」跑法留在素材库里的验图。
 *
 * 用法:
 *   node scripts/cleanup-test-assets.mjs            # 只列出，不删（默认）
 *   node scripts/cleanup-test-assets.mjs --yes      # 真删
 *
 * 为什么会有残留：image-edit-test 第一版只清理了「上传的那张验图」，
 * 没有清理**编辑出来的版本**（旋转/裁剪的结果是另两张新上传的素材），
 * 于是每跑一次就留下两张没人引用的孤儿图。用例已经修好了，这里收拾旧的。
 *
 * 判定用的是**三条同时成立**，而不是「看起来像测试」：
 *   1. 没有任何画布引用它（refs = 0）；
 *   2. 很小（< 64 KB）——真实生成结果是 1.5–2.4 MB 的 PNG；
 *   3. 生成时间落在这次排查窗口内（默认 2026-09-22T05:00Z 之后）。
 * 任何一条不成立都不入选，宁可漏掉也不误删：这个项目已经因此丢过两次数据。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 默认指向本仓库的 data/：脚本在 scripts/ 下，所以往上一层。
// 写死绝对路径会让别人的克隆直接跑不了（也没必要暴露作者的目录结构）。
const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.STUDIO_DATA_DIR || join(HERE, '..', 'data')
const DB = join(DATA_DIR, 'studio.sqlite')
const MAX_BYTES = 64 * 1024
const SINCE = process.argv.find((item) => item.startsWith('--since='))?.slice('--since='.length) ?? '2026-09-22T05:00:00'
const CONFIRM = process.argv.includes('--yes')

const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare(`
  SELECT a.id, a.bytes, a.mime, a.rel_path, a.created_at,
         (SELECT COUNT(*) FROM canvas c WHERE c.doc LIKE '%' || a.id || '%') AS refs
  FROM asset a
  ORDER BY a.created_at ASC
`).all()

const doomed = rows.filter((row) =>
  row.refs === 0
  && row.bytes < MAX_BYTES
  && String(row.created_at) >= SINCE)

const kept = rows.filter((row) => !doomed.includes(row))

console.log(`素材总数 ${rows.length}；候选（无引用 + < ${MAX_BYTES / 1024} KB + ${SINCE} 之后）${doomed.length} 张`)
for (const row of doomed) {
  console.log(`  ${String(row.created_at).slice(11, 19)}  ${String(row.bytes).padStart(7)}B  ${row.mime}  ${row.id.slice(0, 12)}`)
}
console.log(`\n保留 ${kept.length} 张。其中最小的 5 张（确认大图没被算进来）：`)
for (const row of kept.slice(0, 5)) {
  console.log(`  ${String(row.created_at).slice(11, 19)}  ${String(row.bytes).padStart(9)}B  ${row.id.slice(0, 12)}`)
}

// 剩下的同类小图（可能是别人的，也可能是更早的残留）只列出来，不删。
const remaining = db.prepare('SELECT id, bytes, created_at FROM asset WHERE bytes < 65536 ORDER BY created_at').all()
console.log(`\n目录里还剩 ${remaining.length} 张 < 64 KB 的小图（**没有动**，只列给你看）：`)
for (const row of remaining) {
  console.log(`  ${String(row.created_at).slice(0, 19)}  ${String(row.bytes).padStart(7)}B  ${String(row.id).slice(0, 12)}`)
}

if (!CONFIRM) {
  console.log('\n这是预演。要真删请加 --yes。')
  process.exit(0)
}

// 删之前先把字节**复制**到备份目录。删素材是不可逆的，
// 而这个项目已经丢过两次数据——那就把它变成可逆的：删错了重新上传备份文件即可，
// 内容是寻址的，重新上传会拿回同一个 id。
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(DATA_DIR, `asset-backup-${stamp}`)
mkdirSync(backupDir, { recursive: true })
let backedUp = 0
for (const row of doomed) {
  const source = join(DATA_DIR, 'assets', row.rel_path)
  if (!existsSync(source)) continue
  copyFileSync(source, join(backupDir, row.id))
  backedUp += 1
}
console.log(`\n已备份 ${backedUp} 个文件到 ${backupDir}（要还原就把它们重新上传回 /api/assets）`)

// 走服务端的删除接口而不是 rmSync：接口会**再检查一次**有没有画布引用它，
// 而且会把索引行一起删掉。手写 rmSync 正是上一次丢 450 张素材的做法。
const base = process.env.STUDIO_BASE || 'http://127.0.0.1:8080'
const password = process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
})
const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')

let removed = 0
const refused = []
for (const row of doomed) {
  const response = await fetch(`${base}/api/assets/${row.id}`, { method: 'DELETE', headers: { cookie } })
  if (response.ok) removed += 1
  else refused.push(`${row.id.slice(0, 12)} → HTTP ${response.status} ${await response.text()}`)
}
console.log(`已删除 ${removed} 张。`)
for (const line of refused) console.log(`  被拒绝：${line}`)

// 磁盘上的实际文件数：assets 目录按 id 前两位分桶，所以要递归数**文件**，
// 直接 readdir 数的是目录（这个数会骗人，我第一版就被它骗了一次）。
const countFiles = (dir) => readdirSync(dir, { withFileTypes: true })
  .reduce((sum, entry) => sum + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1), 0)
const files = countFiles(join(DATA_DIR, 'assets'))
const indexed = db.prepare('SELECT COUNT(*) AS n FROM asset').get().n
console.log(`磁盘上 ${files} 个文件 / 索引里 ${indexed} 行（索引里剩下的读的是本次连接打开时的快照，仅供参考）`)

