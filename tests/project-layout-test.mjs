/**
 * 项目页与文件夹层级验收。
 *
 * 用法: node tests/project-layout-test.mjs <baseUrl> <password>
 *
 * 这一条是为「文件夹层级好像有点问题」写的。当时的具体毛病：
 * 进了文件夹之后**文件夹墙还在**，于是「在里面」和「在外面」长得一样；
 * 根目录下文件夹和画布混在一个网格里；根目录还有个点了原地不动的「返回」。
 */
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const PORT = Number(process.env.CDP_PORT || 9261)
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('layout')

/** Poll until a probe yields something truthy. */
const until = async (probe, timeoutMs = 10_000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(250)
  }
}

/** The page's shape: what is on screen and how it is grouped. */
const shape = (session) => session.evaluate(`(() => ({
  crumbs: [...document.querySelectorAll('.wall-crumbs .crumb')].map((n) => n.textContent.trim()),
  here: (document.querySelector('.wall-crumbs .crumb.is-here')?.textContent || '').trim(),
  count: (document.querySelector('.wall-count')?.textContent || '').trim(),
  sections: [...document.querySelectorAll('.wall-section > h2')].map((h) => h.textContent.trim()),
  folders: document.querySelectorAll('.folder-card').length,
  projects: document.querySelectorAll('.project-card').length,
  createLabel: (document.querySelector('.create-card')?.textContent || '').trim(),
  empty: (document.querySelector('.wall-empty')?.textContent || '').trim(),
  backButton: [...document.querySelectorAll('.wall-crumbs button')].filter((b) => (b.textContent || '').includes('返回')).length,
}))()`)

/**
 * 这次跑法造出来的东西，以及怎么收掉。
 *
 * 一边造一边登记、最后在 finally 里收，而不是只在结尾收一次：中途崩掉的跑法
 * 会把「里面的甲」这种验收画布留在**用户的项目页**上——上一次崩掉的跑法就
 * 真的留下了三张，而且它们看起来和人自己的画布没区别。
 */
const cleanupSteps = []
const cleanup = async () => {
  for (const step of cleanupSteps.reverse()) {
    try { await step() } catch { /* 收拾失败不能盖住真正的失败 */ }
  }
}

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  check('API 已登录', api.cookie !== '')

  log('① 造两层：一个文件夹 + 里面两张画布 + 外面一张')
  const folder = await api.createFolder(`层级验收 ${STAMP}`)
  const folderId = folder.folder.id
  cleanupSteps.push(() => api.call(`/api/folders/${folderId}`, { method: 'DELETE' }))
  for (const name of [`里面的甲 ${STAMP}`, `里面的乙 ${STAMP}`]) {
    const created = (await api.createProject(name, folderId)).project
    cleanupSteps.push(() => api.call(`/api/projects/${created.id}?purge=1`, { method: 'DELETE' }))
  }
  const outside = (await api.createProject(`外面的 ${STAMP}`)).project
  cleanupSteps.push(() => api.call(`/api/projects/${outside.id}?purge=1`, { method: 'DELETE' }))
  check('文件夹里有 2 张', ((await api.call(`/api/projects?folderId=${folderId}`)).json.projects ?? []).length === 2)

  const s = await startSession({ port: PORT, width: 1500, height: 950 })
  await s.login(BASE, PASSWORD)
  await s.goto(`${BASE}/projects`, 4000)

  log('② 根目录：面包屑只有「全部项目」，且它不可点（上面没有上一层）')
  const root = await shape(s)
  log(`   ${JSON.stringify(root)}`)
  check('面包屑只有「全部项目」', root.crumbs.length === 1 && root.crumbs[0] === '全部项目', root.crumbs.join(' › '))
  check('「全部项目」是当前位置', root.here === '全部项目', root.here)
  check('根目录没有「返回」这种死控件', root.backButton === 0, String(root.backButton))
  check('计数同时说明文件夹和画布', /个文件夹/.test(root.count) && /张画布/.test(root.count), root.count)

  log('③ 根目录分两段：文件夹一段、画布一段')
  check('有「文件夹」这一段', root.sections.some((t) => t.startsWith('文件夹')), root.sections.join(' | '))
  check('有「画布」这一段', root.sections.some((t) => t.startsWith('画布')), root.sections.join(' | '))
  const folderSectionFirst = root.sections.findIndex((t) => t.startsWith('文件夹')) < root.sections.findIndex((t) => t.startsWith('画布'))
  check('文件夹排在画布前面', folderSectionFirst === true, root.sections.join(' | '))
  check('看得到那个文件夹', root.folders >= 1, String(root.folders))
  check('根目录也能看到未归档的画布', root.projects >= 1, String(root.projects))

  log('④ 进文件夹：层级要看得出来，且不该再显示文件夹墙')
  check('点开文件夹', await s.evaluate(`(() => {
    const card = [...document.querySelectorAll('.folder-card')].find((c) => (c.textContent || '').includes(${JSON.stringify(`层级验收 ${STAMP}`)}));
    const open = card?.querySelector('.card-open');
    if (!open) return false; open.click(); return true;
  })()`))
  await sleep(2000)
  check('URL 带上文件夹', (await s.evaluate('location.search')).includes(`folder=${folderId}`), await s.evaluate('location.search'))
  const inner = await shape(s)
  log(`   ${JSON.stringify(inner)}`)
  check('面包屑是「全部项目 › 文件夹名」', inner.crumbs.length === 2 && inner.crumbs[0] === '全部项目' && inner.crumbs[1] === `层级验收 ${STAMP}`, inner.crumbs.join(' › '))
  check('当前层标在文件夹上', inner.here === `层级验收 ${STAMP}`, inner.here)
  check('文件夹墙消失了（里面只有画布）', inner.folders === 0, String(inner.folders))
  check('只剩「画布」一段', inner.sections.length === 1 && inner.sections[0].startsWith('画布'), inner.sections.join(' | '))
  check('只显示这个文件夹里的 2 张', inner.projects === 2, String(inner.projects))
  check('新建卡改口说「在这里新建画布」', inner.createLabel.includes('在这里新建画布'), inner.createLabel)

  log('⑤ 面包屑能点回上一层')
  check('点「全部项目」', await s.evaluate(`(() => {
    const crumb = [...document.querySelectorAll('.wall-crumbs button')].find((b) => (b.textContent || '').trim() === '全部项目');
    if (!crumb) return false; crumb.click(); return true;
  })()`))
  await sleep(1800)
  check('回到根目录（URL 干净）', (await s.evaluate('location.search')) === '', await s.evaluate('location.search'))
  const back = await shape(s)
  check('文件夹墙回来了', back.folders >= 1, String(back.folders))
  check('又分成两段', back.sections.length >= 2, back.sections.join(' | '))

  log('⑥ 空文件夹要说清楚，而不是空着')
  const emptyFolder = await api.createFolder(`空文件夹 ${STAMP}`)
  cleanupSteps.push(() => api.call(`/api/folders/${emptyFolder.folder.id}`, { method: 'DELETE' }))
  await s.goto(`${BASE}/projects?folder=${emptyFolder.folder.id}`, 3500)
  const emptyShape = await shape(s)
  check('空文件夹有说明', emptyShape.empty.includes('空的'), emptyShape.empty)
  check('空文件夹里只有新建卡', emptyShape.projects === 0 && emptyShape.createLabel.includes('在这里新建画布'), JSON.stringify(emptyShape))

  log('⑦ 在文件夹里新建 → 落在那个文件夹')
  const before = ((await api.call(`/api/projects?folderId=${emptyFolder.folder.id}`)).json.projects ?? []).length
  check('点新建卡', await s.evaluate(`(() => { const b = document.querySelector('.create-card'); if (!b) return false; b.click(); return true })()`))
  const landed = await until(async () => {
    const now = ((await api.call(`/api/projects?folderId=${emptyFolder.folder.id}`)).json.projects ?? []).length
    return now > before ? now : null
  })
  check('新画布落在这个文件夹里', landed === before + 1, `${String(before)} -> ${String(landed ?? before)}`)

  log('⑧ 回收站是第三种状态，不能和文件夹混')
  await api.trashProject(outside.id)
  await s.goto(`${BASE}/projects?trash=1`, 3500)
  const trashShape = await shape(s)
  check('回收站面包屑只有一层', trashShape.crumbs.length === 1 && trashShape.crumbs[0] === '回收站', trashShape.crumbs.join(' › '))
  check('回收站里没有文件夹', trashShape.folders === 0, String(trashShape.folders))
  check('回收站里没有新建卡', trashShape.createLabel === '', trashShape.createLabel)

  check('全程没有 JS 报错', s.consoleErrors.length === 0, s.consoleErrors.slice(0, 2).join(' | '))
  await s.shot('project-layout.png')
  s.kill()

  log('⑨ 清理')
  await cleanup()

  log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch(async (error) => {
  console.error('[layout] 失败:', error)
  // 崩了也要收：留下的验收画布会出现在用户的项目页上，而且看不出是验收数据。
  await cleanup()
  process.exit(1)
})
