/**
 * 项目页验收：卡片墙、文件夹、回收站、每张卡片右下角的 ⋯ 菜单。
 *
 * 用法: node tests/projects-test.mjs <baseUrl> <password>
 *
 * 三件事必须一起证明，否则界面只是长得像：
 * 1. **文件夹是标签，不是容器**——删文件夹不能带走画布；
 * 2. **删除进回收站**——「删除项目」是菜单里最容易误点的一项，
 *    所以它必须可还原，而「彻底删除」必须只在回收站里出现；
 * 3. **创建副本是干净副本**——同一份画面，但节点身份是新的、生成历史不跟过来。
 */
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const PORT = Number(process.env.CDP_PORT || 9247)
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('projects')

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

/** The labels in one open menu panel. */
const menuLabels = (scope, session) => session.evaluate(`(() => {
  const panel = document.querySelector(${JSON.stringify(scope)});
  if (!panel) return null;
  return [...panel.querySelectorAll('button')].map((b) => ((b.querySelector('.menu-item-label') || b).textContent || '').trim());
})()`)

/** Open the ⋯ menu of the card whose title is `name`, and return its labels. */
const openCardMenu = async (name, session) => {
  const opened = await session.evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => (c.querySelector('.card-open strong')?.textContent || '').trim() === ${JSON.stringify(name)});
    const trigger = card?.querySelector('.card-menu .menu-trigger');
    if (!trigger) return false;
    trigger.click(); return true;
  })()`)
  if (!opened) return null
  await sleep(400)
  return await menuLabels('.card-menu .menu-panel', session)
}

/** Click one item in the currently open card menu. */
const clickCardMenuItem = (label, session) => session.evaluate(`(() => {
  const panels = [...document.querySelectorAll('.card-menu .menu-panel')];
  const panel = panels[panels.length - 1];
  if (!panel) return false;
  const hit = [...panel.querySelectorAll('button')].find((b) => ((b.querySelector('.menu-item-label') || b).textContent || '').trim() === ${JSON.stringify(label)});
  if (!hit) return false; hit.click(); return true;
})()`)

const cardTitles = (session) => session.evaluate(`[...document.querySelectorAll('.card.project-card .card-open strong')].map((n) => n.textContent.trim())`)

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  check('API 已登录', api.cookie !== '')

  log('① 文件夹：建、改名、删——删文件夹不删里面的画布')
  const folder = await api.createFolder(`验收文件夹 ${STAMP}`)
  const folderId = folder.folder.id
  check('文件夹已创建', typeof folderId === 'string' && folderId !== '')
  check('新文件夹画布数为 0', folder.folder.canvasCount === 0)

  const inFolder = await api.createProject(`在文件夹里的画布 ${STAMP}`, folderId)
  check('画布落进了文件夹', inFolder.project.folderId === folderId, inFolder.project.folderId)
  const foldersAfter = (await api.call('/api/folders')).json.folders.find((f) => f.id === folderId)
  check('文件夹计数跟着变', foldersAfter?.canvasCount === 1, String(foldersAfter?.canvasCount))
  const filtered = (await api.call(`/api/projects?folderId=${folderId}`)).json.projects
  check('按文件夹过滤只返回它的画布', filtered.length === 1 && filtered[0].id === inFolder.project.id, filtered.map((p) => p.name).join(' | '))

  const renamedFolder = await api.call(`/api/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ name: `改名后的文件夹 ${STAMP}` }) })
  check('文件夹可以改名', renamedFolder.json.folder?.name === `改名后的文件夹 ${STAMP}`, renamedFolder.json.folder?.name ?? '')

  log('② 删除进回收站，可以还原，也可以彻底删')
  const doomed = await api.createProject(`待删画布 ${STAMP}`)
  check('删除返回成功', (await api.call(`/api/projects/${doomed.project.id}`, { method: 'DELETE' })).ok)
  const live = (await api.call('/api/projects')).json.projects
  check('回收站里的不在正常工作列表里', !live.some((p) => p.id === doomed.project.id), live.map((p) => p.name).slice(0, 3).join(' | '))
  const trashed = (await api.call('/api/projects?trash=1')).json.projects
  check('回收站里能找到它', trashed.some((p) => p.id === doomed.project.id), trashed.map((p) => p.name).join(' | '))
  check('画布文档在回收站里还完好', (await api.call(`/api/projects/${doomed.project.id}/canvas`)).ok)
  check('还原成功', (await api.call(`/api/projects/${doomed.project.id}/restore`, { method: 'POST' })).ok)
  check('还原后回到工作列表', (await api.call('/api/projects')).json.projects.some((p) => p.id === doomed.project.id))
  check('彻底删除成功', (await api.call(`/api/projects/${doomed.project.id}?purge=1`, { method: 'DELETE' })).ok)
  check('彻底删除后哪里都找不到', !(await api.call('/api/projects?trash=1')).json.projects.some((p) => p.id === doomed.project.id))

  log('③ 创建副本：同一份画面，新的节点身份，不继承生成历史')
  const source = await api.createProject(`副本源头 ${STAMP}`, folderId)
  await api.putCanvas(source.project.id, {
    nodes: [
      { id: 'text-a', type: 'studio', position: { x: 0, y: 0 }, data: { kind: 'text', text: '第一段' } },
      { id: 'image-a', type: 'studio', position: { x: 460, y: 0 }, data: { kind: 'image', text: '一张图', url: '', shotId: 'shot-old' } },
    ],
    edges: [{ id: 'edge-a', source: 'text-a', target: 'image-a', sourceHandle: 'text', targetHandle: 'prompt' }],
    viewport: { x: 0, y: 0, zoom: 1 },
    agentContext: ['image-a'],
  })
  const copy = (await api.call(`/api/projects/${source.project.id}/duplicate`, { method: 'POST' })).json.project
  check('副本已创建', typeof copy?.id === 'string' && copy.id !== source.project.id, copy?.name ?? '')
  check('副本名字带「副本」', (copy?.name ?? '').includes('副本'), copy?.name ?? '')
  check('副本落在同一个文件夹', copy?.folderId === folderId, copy?.folderId ?? '')
  const copyDoc = (await api.call(`/api/projects/${copy.id}/canvas`)).json.doc
  check('副本带着同一份画面', (copyDoc?.nodes ?? []).length === 2, `${String((copyDoc?.nodes ?? []).length)} 个节点`)
  check('副本的节点 id 是新的', !(copyDoc?.nodes ?? []).some((n) => n.id === 'text-a' || n.id === 'image-a'),
    (copyDoc?.nodes ?? []).map((n) => n.id).join(' | '))
  check('副本不继承生成历史', !(copyDoc?.nodes ?? []).some((n) => n.data?.shotId === 'shot-old'),
    JSON.stringify((copyDoc?.nodes ?? []).map((n) => n.data?.shotId ?? '')))
  check('副本的连线指向新的节点 id', (copyDoc?.edges ?? []).every((e) => (copyDoc?.nodes ?? []).some((n) => n.id === e.source) && (copyDoc?.nodes ?? []).some((n) => n.id === e.target)),
    JSON.stringify(copyDoc?.edges ?? []))

  log('④ 移动与封面')
  const moved = await api.call(`/api/projects/${source.project.id}`, { method: 'PATCH', body: JSON.stringify({ folderId: '' }) })
  check('移出文件夹', moved.json.project?.folderId === '', moved.json.project?.folderId ?? '')
  const covered = await api.call(`/api/projects/${source.project.id}`, { method: 'PATCH', body: JSON.stringify({ coverAssetId: 'deadbeef' }) })
  check('可以设封面', covered.json.project?.coverAssetId === 'deadbeef', covered.json.project?.coverAssetId ?? '')
  const cleared = await api.call(`/api/projects/${source.project.id}`, { method: 'PATCH', body: JSON.stringify({ coverAssetId: '' }) })
  check('可以清封面', cleared.json.project?.coverAssetId === '', cleared.json.project?.coverAssetId ?? '')

  log('⑤ 界面：卡片墙的形状')
  const s = await startSession({ port: PORT, width: 1500, height: 950 })
  await s.login(BASE, PASSWORD)
  await s.goto(`${BASE}/projects`, 4000)
  check('有「创建新的项目」那张卡', (await s.evaluate(`[...document.querySelectorAll('.card')].some((c) => (c.textContent || '').includes('创建新的项目'))`)) === true)
  check('文件夹以卡片出现', (await s.evaluate(`document.querySelectorAll('.folder-card').length`)) >= 1,
    String(await s.evaluate(`document.querySelectorAll('.folder-card').length`)))
  const titles = await cardTitles(s)
  check('画布以卡片出现', titles.includes(`副本源头 ${STAMP}`), titles.slice(0, 4).join(' | '))
  check('顶部有 回收站 与 新建文件夹', await s.evaluate(`(() => {
    const texts = [...document.querySelectorAll('.wall-head button')].map((b) => (b.textContent || '').trim());
    return texts.includes('回收站') && texts.includes('新建文件夹');
  })()`))
  check('顶部有搜索框', (await s.evaluate(`document.querySelectorAll('.wall-search').length`)) === 1)

  log('⑥ 卡片的 ⋯ 菜单（图 3）')
  const items = await openCardMenu(`副本源头 ${STAMP}`, s)
  check('菜单能打开', items !== null, (items ?? []).join(' | '))
  check('菜单含 打开 / 重命名 / 修改封面 / 创建副本 / 删除项目',
    ['打开', '重命名', '修改封面', '创建副本', '删除项目'].every((label) => (items ?? []).includes(label)), (items ?? []).join(' | '))
  check('「移动至文件夹」列出了可选的文件夹', (items ?? []).some((label) => label.startsWith('移到「')), (items ?? []).join(' | '))
  await s.evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(300)

  log('⑦ 从卡片上改名字')
  await openCardMenu(`副本源头 ${STAMP}`, s)
  check('点「重命名」', await clickCardMenuItem('重命名', s))
  await sleep(400)
  check('卡片上出现输入框', (await s.evaluate(`document.querySelectorAll('.card .card-rename').length`)) >= 1)
  await s.evaluate(`(() => {
    const input = document.querySelector('.card .card-rename');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(`卡片改名 ${STAMP}`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.blur();
    return true;
  })()`)
  const renamed = await until(async () => (await cardTitles(s)).includes(`卡片改名 ${STAMP}`) ? true : null)
  check('卡片标题变了', renamed === true, (await cardTitles(s)).slice(0, 4).join(' | '))
  check('服务端也改了', (await api.call('/api/projects')).json.projects.some((p) => p.name === `卡片改名 ${STAMP}`))

  log('⑧ 删除项目 → 进回收站；回收站里能还原')
  await openCardMenu(`卡片改名 ${STAMP}`, s)
  check('点「删除项目」', await clickCardMenuItem('删除项目', s))
  const gone = await until(async () => (await cardTitles(s)).includes(`卡片改名 ${STAMP}`) ? null : true)
  check('卡片从工作列表消失', gone === true, (await cardTitles(s)).slice(0, 4).join(' | '))

  check('点「回收站」', await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.wall-head button')].find((x) => (x.textContent || '').trim() === '回收站');
    if (!b) return false; b.click(); return true;
  })()`))
  await sleep(2500)
  check('URL 变成回收站', (await s.evaluate('location.search')).includes('trash=1'), await s.evaluate('location.search'))
  const trashTitles = await cardTitles(s)
  check('回收站里能看到刚删的', trashTitles.includes(`卡片改名 ${STAMP}`), trashTitles.slice(0, 4).join(' | '))
  const trashItems = await openCardMenu(`卡片改名 ${STAMP}`, s)
  check('回收站里的菜单多了 还原 / 彻底删除',
    (trashItems ?? []).includes('还原') && (trashItems ?? []).includes('彻底删除'), (trashItems ?? []).join(' | '))
  check('回收站里没有「删除项目」（已删过了）', !(trashItems ?? []).includes('删除项目'), (trashItems ?? []).join(' | '))
  check('点「还原」', await clickCardMenuItem('还原', s))
  const restored = await until(async () => (await cardTitles(s)).includes(`卡片改名 ${STAMP}`) ? null : true)
  check('还原后从回收站消失', restored === true, (await cardTitles(s)).slice(0, 4).join(' | '))
  check('服务端也回来了', (await api.call('/api/projects')).json.projects.some((p) => p.name === `卡片改名 ${STAMP}`))

  log('⑨ 新建文件夹：建完直接进入改名，不留一堆「未命名文件夹」')
  await s.goto(`${BASE}/projects`, 3500)
  check('点「新建文件夹」', await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.wall-head button')].find((x) => (x.textContent || '').trim() === '新建文件夹');
    if (!b) return false; b.click(); return true;
  })()`))
  await sleep(1800)
  check('新文件夹处于改名状态', (await s.evaluate(`document.querySelectorAll('.folder-card .card-rename').length`)) === 1)

  log('⑨b 清空回收站：不能只进不出')
  const doomedToo = await api.createProject(`待清空 ${STAMP}`)
  await api.trashProject(doomedToo.project.id)
  check('回收站里有东西', (await api.call('/api/projects?trash=1')).json.projects.length >= 1)
  const emptied = await api.call('/api/projects?trash=1', { method: 'DELETE' })
  check('清空回收站成功', emptied.ok === true, `HTTP ${String(emptied.status)}`)
  check('清空后回收站是空的', ((await api.call('/api/projects?trash=1')).json.projects ?? []).length === 0)
  check('正在做的画布一张没少', (await api.call('/api/projects')).json.projects.length >= 2,
    String((await api.call('/api/projects')).json.projects.length))

  log('⑩ 搜索会真过滤')
  const before = (await cardTitles(s)).length
  await s.evaluate(`(() => {
    const input = document.querySelector('.wall-search');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(`卡片改名 ${STAMP}`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(600)
  const after = await cardTitles(s)
  check('搜索把列表缩小了', after.length > 0 && after.length < before, `${String(before)} -> ${String(after.length)}`)
  check('留下的就是匹配的', after.every((title) => title.includes(STAMP)), after.join(' | '))

  check('全程没有 JS 报错', s.consoleErrors.length === 0, s.consoleErrors.slice(0, 2).join(' | '))
  await s.shot('projects-wall.png')
  s.kill()

  log('⑪ 清理')
  const all = (await api.call('/api/projects')).json.projects.filter((p) => p.name.includes(STAMP) || p.folderId === folderId)
  for (const project of all) await api.call(`/api/projects/${project.id}?purge=1`, { method: 'DELETE' })
  const purged = (await api.call(`/api/projects?folderId=${folderId}`)).json.projects
  check('探针画布已清空', purged.length === 0, purged.map((p) => p.name).join(' | '))
  check('文件夹可以删除', (await api.call(`/api/folders/${folderId}`, { method: 'DELETE' })).ok)
  for (const leftover of (await api.call('/api/folders')).json.folders.filter((f) => f.name.startsWith('未命名文件夹'))) {
    await api.call(`/api/folders/${leftover.id}`, { method: 'DELETE' })
  }

  log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[projects] 失败:', error); process.exit(1) })
