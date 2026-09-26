/**
 * 作品发布与审核的验收（M3）。
 *
 * 用法: node tests/works-test.mjs
 *
 * 为什么单独一条：这是**「必须管理员点过才上主页」**那条要求的落地，
 * 而且它牵扯三类人看到的东西不一样（公众 / 作者 / 管理员）。
 * 光看代码看不出「待审作品会不会被匿名的人打开」，所以这里逐条钉住：
 *
 * - 待审：主页没有、匿名打不开、作者与管理员能预览；
 * - 通过：主页出现、匿名能看、成品与快照图可取；
 * - **素材只能通过作品取**：拿别的素材 id 拼进来要 404（没有公开素材库）；
 * - 被拒：作者能看到理由、主页看不到；
 * - 举报 → 管理员看到 → 下架并处理。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

// 用例都在 tests/ 下，仓库根在上一层。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'studio-works-'))

let failures = 0
const log = (...a) => console.log('[works]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort(start = 8580) {
  const { createServer } = await import('node:http')
  const { connect } = await import('node:net')
  for (let port = start; port < start + 40; port += 1) {
    const taken = await new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.setTimeout(300, () => { socket.destroy(); resolve(false) })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
    })
    if (taken) continue
    const free = await new Promise((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  return start
}

/** 一张 32×32 的 PNG（成品与快照图都用它）。 */
function makePng(seed = 1) {
  const width = 32
  const height = 32
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4
      raw[at] = (x * 5 + seed * 11) % 256
      raw[at + 1] = (y * 3 + seed * 7) % 256
      raw[at + 2] = 200
      raw[at + 3] = 255
    }
  }
  const table = (() => {
    const values = new Int32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let value = i
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      values[i] = value
    }
    return values
  })()
  const crc32 = (buffer) => {
    let crc = -1
    for (const byte of buffer) crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0)
    return (crc ^ -1) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const run = async () => {
  const port = await freePort()
  const base = `http://127.0.0.1:${String(port)}`
  const child = spawn(process.execPath, ['--experimental-strip-types', join(repo, 'apps', 'server', 'src', 'index.ts')], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STUDIO_MODE: 'cloud', STUDIO_DATA_DIR: join(scratch, 'data'), STUDIO_PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (c) => { output.push(String(c)) })
  child.stderr.on('data', (c) => { output.push(String(c)) })
  const up = await (async () => {
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch(`${base}/api/health`)
        if (response.ok) return true
      } catch { /* not yet */ }
      await sleep(300)
    }
    return false
  })()
  check('服务器端实例起来了', up, up ? '' : output.join('').slice(-300))
  if (!up) { child.kill(); process.exit(1) }

  /** 一个带各自 cookie 的客户端。 */
  const client = () => {
    let cookie = ''
    const call = async (path, init = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(init.headers ?? {}) },
      })
      const set = response.headers.getSetCookie?.() ?? []
      if (set.length > 0) cookie = set.map((item) => item.split(';')[0]).join('; ')
      const text = await response.text()
      // 页面（HTML）与素材（二进制）都会走到这儿：**不要 JSON.parse 崩掉**，
      // 读不出来就当空对象 —— 这一条以前在别的用例里踩过两次。
      let json = {}
      try {
        json = text === '' ? {} : JSON.parse(text)
      } catch {
        json = {}
      }
      return { status: response.status, ok: response.ok, json, text }
    }
    const upload = async (bytes) => {
      const response = await fetch(`${base}/api/v1/works/assets`, {
        method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: bytes,
      })
      return { status: response.status, json: await response.json().catch(() => ({})) }
    }
    return { call, upload, cookie: () => cookie }
  }

  const boss = client()
  const author = client()
  const anon = client()

  log('① 两个账号：第一个注册的是管理员，第二个是作者')
  const bossReg = await boss.call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: 'boss@example.com', password: 'boss-password-1', displayName: '站长', label: '验收' }) })
  const authorReg = await author.call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: 'author@example.com', password: 'author-password-1', displayName: '画师小王', label: '验收' }) })
  check('站长是管理员', bossReg.json.user?.role === 'admin', String(bossReg.json.user?.role))
  check('作者是普通用户', authorReg.json.user?.role === 'user', String(authorReg.json.user?.role))
  check('管理员能进后台页', (await boss.call('/admin')).status === 200)
  check('普通用户进不了后台页', (await author.call('/admin')).status === 403)
  check('普通用户读不到待审队列', (await author.call('/api/v1/admin/works')).status === 403)

  log('② 作者发布一件带画布的作品（默认待审）')
  const main = await author.upload(makePng(1))
  const shot = await author.upload(makePng(2))
  check('成品上传成功', main.status === 200 && typeof main.json.asset?.id === 'string', JSON.stringify(main.json).slice(0, 80))
  const snapshot = JSON.stringify({
    nodes: [
      { id: 'text-1', data: { kind: 'text', text: '雨夜霓虹街头，胶片颗粒' } },
      { id: 'image-1', data: { kind: 'image', text: '雨夜霓虹街头，胶片颗粒', url: `/blob/${shot.json.asset.id}` } },
    ],
    edges: [{ source: 'text-1', target: 'image-1', targetHandle: 'prompt' }],
  })
  const published = await author.call('/api/v1/works', { method: 'POST', body: JSON.stringify({ title: '雨夜霓虹', summary: '第一件作品', tags: '赛博,夜景', assetId: main.json.asset.id, snapshot }) })
  const workId = published.json.work?.id ?? ''
  check('发布成功且状态是待审', published.status === 200 && published.json.work?.status === 'pending', JSON.stringify(published.json).slice(0, 120))
  check('没标题不给发', (await author.call('/api/v1/works', { method: 'POST', body: JSON.stringify({ assetId: main.json.asset.id }) })).status === 400)
  check('不是图片/视频不给传', (await fetch(`${base}/api/v1/works/assets`, { method: 'POST', headers: { 'content-type': 'text/plain', cookie: author.cookie() }, body: 'hello' })).status === 400)

  log('③ 待审期间：主页没有、匿名打不开、作者与管理员能预览')
  check('主页还没有它', !(await anon.call('/')).text.includes('雨夜霓虹'))
  check('匿名打不开待审作品', (await anon.call(`/w/${workId}`)).status === 404, String((await anon.call(`/w/${workId}`)).status))
  const own = await author.call(`/w/${workId}`)
  check('作者能预览自己的待审作品，并看到「待审」', own.status === 200 && own.text.includes('待审'), `HTTP ${String(own.status)}`)
  check('管理员也能预览', (await boss.call(`/w/${workId}`)).status === 200)
  check('待审期间成品也取不到（匿名）', (await anon.call(`/w/${workId}/asset`)).status === 404)
  const queue = await boss.call('/api/v1/admin/works?status=pending')
  check('待审队列里有它', (queue.json.works ?? []).some((item) => item.id === workId), JSON.stringify(queue.json).slice(0, 140))
  check('队列里带着作者名与「带画布」', (queue.json.works ?? []).every((item) => typeof item.author === 'string') && (queue.json.works ?? [])[0]?.hasSnapshot === true)

  log('④ 管理员点「通过」→ 主页可见')
  check('审核通过', (await boss.call(`/api/v1/admin/works/${workId}/review`, { method: 'POST', body: JSON.stringify({ status: 'approved' }) })).status === 200)
  const home = await anon.call('/')
  check('主页出现了它', home.text.includes('雨夜霓虹'))
  check('主页卡片指向作品页', home.text.includes(`/w/${workId}`))
  const page = await anon.call(`/w/${workId}`)
  check('匿名能打开作品页', page.status === 200, `HTTP ${String(page.status)}`)
  check('作品页有成品地址', page.text.includes(`/w/${workId}/asset`))
  check('作品页有「查看画布」', page.text.includes('查看画布'))
  check('作品页标了「AI 生成」（合规要求）', page.text.includes('AI 生成'))
  check('作品页能看到提示词（学习参考的价值在这儿）', page.text.includes('雨夜霓虹街头，胶片颗粒'))
  check('作品页的作者名不是完整邮箱', !page.text.includes('author@example.com'), page.text.match(/画师小王/u)?.[0] ?? '没找到作者名')
  check('成品能取到', (await anon.call(`/w/${workId}/asset`)).status === 200)
  check('快照里的图能取到', (await anon.call(`/w/${workId}/blob/${shot.json.asset.id}`)).status === 200)

  log('⑤ 素材只能通过作品取（没有公开素材库）')
  const stranger = await author.upload(makePng(99))
  check('另一张没被作品引用的素材取不到', (await anon.call(`/w/${workId}/blob/${stranger.json.asset.id}`)).status === 404)
  check('没有「按 id 取任意素材」的公开接口',
    (await anon.call(`/api/v1/works/assets/${stranger.json.asset.id}`)).status === 404,
    `HTTP ${String((await anon.call(`/api/v1/works/assets/${stranger.json.asset.id}`)).status)}`)

  log('⑥ 举报 → 管理员看到 → 下架并处理')
  const reported = await anon.call(`/api/v1/works/${workId}/report`, { method: 'POST', body: JSON.stringify({ reason: '怀疑不是自己做的' }) })
  check('匿名也能举报', reported.status === 200, JSON.stringify(reported.json))
  const reports = await boss.call('/api/v1/admin/reports')
  check('管理员能看到举报', (reports.json.reports ?? []).some((item) => item.workId === workId), JSON.stringify(reports.json).slice(0, 120))
  const reportId = (reports.json.reports ?? []).find((item) => item.workId === workId)?.id ?? ''
  check('下架', (await boss.call(`/api/v1/admin/works/${workId}/review`, { method: 'POST', body: JSON.stringify({ status: 'hidden', note: '举报处理' }) })).status === 200)
  check('下架之后主页看不到', !(await anon.call('/')).text.includes('雨夜霓虹'))
  check('下架之后匿名打不开', (await anon.call(`/w/${workId}`)).status === 404)
  check('作者仍能看到自己的作品与下架原因', (await author.call(`/w/${workId}`)).text.includes('举报处理'))
  check('标记举报已处理', (await boss.call(`/api/v1/admin/reports/${reportId}/handle`, { method: 'POST', body: '{}' })).status === 200)

  log('⑦ 被拒：作者看得到理由，主页看不到')
  const second = await author.call('/api/v1/works', { method: 'POST', body: JSON.stringify({ title: '第二件', assetId: main.json.asset.id }) })
  const secondId = second.json.work?.id ?? ''
  check('拒绝要带理由', (await boss.call(`/api/v1/admin/works/${secondId}/review`, { method: 'POST', body: JSON.stringify({ status: 'rejected', note: '画面里有水印' }) })).status === 200)
  check('主页没有它', !(await anon.call('/')).text.includes('第二件'))
  check('作者看得到拒绝理由', (await author.call(`/w/${secondId}`)).text.includes('画面里有水印'))
  check('没带画布的作品页会说明「没有附带画布」', (await author.call(`/w/${secondId}`)).text.includes('没有附带画布'))

  log('⑧ 作者能删掉自己的作品')
  check('删掉', (await author.call(`/api/v1/works/${secondId}`, { method: 'DELETE' })).status === 200)
  check('删完就没了', (await author.call(`/w/${secondId}`)).status === 404)
  check('别人的作品删不掉', (await anon.call(`/api/v1/works/${workId}`, { method: 'DELETE' })).status === 404)

  child.kill()
  await sleep(500)
  rmSync(scratch, { recursive: true, force: true })
  log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[works] 失败:', error)
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 清了就好 */ }
  process.exit(1)
})
