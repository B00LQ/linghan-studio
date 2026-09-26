/**
 * 数据库体检：扫乱码 + 修脏数据。
 *
 * 背景：早期用 PowerShell 的 Invoke-RestMethod 建项目时没带 charset，
 * 请求体按 ASCII 编码，中文被替换成问号，于是库里留下了名叫 "?????" 的项目。
 * 这个脚本既查全部乱码，也把这类脏数据改回正常名字。
 *
 * 用法（容器内）: node /tmp/db-scan.cjs
 */
const { DatabaseSync } = require('node:sqlite')

const db = new DatabaseSync('/data/studio.sqlite')

// 问号串 / 替换符 / UTF-8 被当 GBK 解读后的典型残迹
const BAD = /(\?{2,})|(\uFFFD)|(锟斤拷)|(鍚|鎬|锛|鈥|馃|鍜|鐨|涓)/
const hits = []

const scanTable = (table, columns) => {
  for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
    for (const column of columns) {
      const value = row[column]
      if (typeof value === 'string' && BAD.test(value)) {
        hits.push({ table, id: String(row.id).slice(0, 8), column, value: value.slice(0, 60) })
      }
    }
  }
}

scanTable('project', ['name'])
scanTable('shot', ['title', 'prompt'])
scanTable('take', ['params_json', 'error'])
scanTable('canvas', ['doc'])

console.log('=== 全库乱码扫描 ===')
if (hits.length === 0) console.log('  未发现乱码')
for (const hit of hits) console.log('  ', hit.table, hit.id, hit.column, JSON.stringify(hit.value))

console.log('=== 清理被降级替换的项目名 ===')
const junk = db.prepare("SELECT id, name FROM project WHERE name LIKE '%?%'").all()
for (const project of junk) {
  db.prepare('UPDATE project SET name = ? WHERE id = ?').run('未命名项目（曾经乱码，已修复）', project.id)
  console.log('  ', project.id.slice(0, 8), JSON.stringify(project.name), '-> 已修正')
}
if (junk.length === 0) console.log('  没有需要清理的')

console.log('=== 项目列表 ===')
for (const project of db.prepare('SELECT id, name FROM project ORDER BY created_at').all()) {
  console.log('  ', project.id.slice(0, 8), JSON.stringify(project.name))
}

db.close()
