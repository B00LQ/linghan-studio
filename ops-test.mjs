/**
 * 运营底线（M4）与私人云备份（M5）的验收。
 *
 * 用法: node ops-test.mjs
 *
 * 这一条验的不是"功能"，是**「敢对外公开运营」的四个前提**加上私密备份那一条：
 *
 * 1. **限流**：注册这类公网写入口被撞的时候会 429，而且告诉对方等多久；
 * 2. **配额**：账号里的云空间满了会 413 并说清还差多少（"失败"三个字不算答案）；
 * 3. **只读降级**：`STUDIO_READONLY=1` 时写操作 503、读照常，**登录与备份仍然活着**
 *    （一个进不去也救不回来的只读模式等于把运维锁在门外）；
 * 4. **机审**：命中的内容挡在人工审核之前；接口挂了默认放行（人工是兜底），
 *    打开 `MODERATION_FAIL_CLOSED=1` 则拒绝发布；
 * 5. **AI 生成标识**：上传的 PNG 里真的躺着 `tEXt` 元数据（不是只印在页面上）；
 * 6. **私密备份**：不进主页、不进审核队列、别人打不开、作者自己看得到；
 *    删掉之后素材被回收、配额跟着降（否则配额只增不减）。
 *
 * 每个实例都是临时的、各自一个数据目录 —— 这条用例跑完不在磁盘上留东西。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { deflateSync } from 'node:zlib'

const repo = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'studio-ops-'))

let failures = 0
const log = (...a) => console.log('[ops]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort(start = 8620) {
  for (let port = start; port < start + 60; port += 1) {
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

/** 一张真 PNG（32×32）：验 AI 标识必须用真文件，随手一段字节不是 PNG。 */
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

/**
 * 起一个临时实例并等它就绪。
 * @param extraEnv - 这次要额外打开的环境变量。
 * @returns the base URL, child process, and a cookie-holding client factory.
 */
async function startServer(extraEnv) {
  const port = await freePort()
  const base = `http://127.0.0.1:${String(port)}`
  // 数据目录**不能用端口起名**：上一个实例被杀掉之后端口会被下一个实例重新捡走，
  // 于是"新实例"读到了旧实例的库 —— 第一个注册的就不是管理员了（这一条踩过）。
  const dataDir = mkdtempSync(join(scratch, 'inst-'))
  const child = spawn(process.execPath, ['--experimental-strip-types', join(repo, 'apps', 'server', 'src', 'index.ts')], {
    cwd: repo,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', STUDIO_MODE: 'cloud',
      STUDIO_DATA_DIR: dataDir, STUDIO_PUBLIC_URL: base,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (c) => { output.push(String(c)) })
  child.stderr.on('data', (c) => { output.push(String(c)) })
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, child, output }
    } catch { /* not yet */ }
    await sleep(300)
  }
  return { base, child, output, failed: true }
}

/** 一个带各自 cookie 的客户端。 */
function client(base) {
  let cookie = ''
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(init.headers ?? {}) },
    })
    const set = response.headers.getSetCookie?.() ?? []
    if (set.length > 0) cookie = set.map((item) => item.split(';')[0]).join('; ')
    const text = await response.text()
    let json = {}
    try { json = text === '' ? {} : JSON.parse(text) } catch { json = {} }
    return { status: response.status, ok: response.ok, json, text, retryAfter: response.headers.get('retry-after') }
  }
  const upload = async (bytes, mime = 'image/png') => {
    const response = await fetch(`${base}/api/v1/works/assets`, { method: 'POST', headers: { 'content-type': mime, cookie }, body: bytes })
    return { status: response.status, json: await response.json().catch(() => ({})) }
  }
  return { call, upload, cookie: () => cookie }
}

/** 一个假的机审服务：`mode` 决定它怎么答。 */
async function startModerationStub(mode) {
  const port = await freePort(8700)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      if (mode === 'down') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"boom"}')
        return
      }
      let text = ''
      try { text = String(JSON.parse(body).text ?? '') } catch { text = '' }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(text.includes('违规')
        ? '{"pass":false,"label":"测试类别","reason":"假机审：命中违规词"}'
        : '{"pass":true}')
    })
  })
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${String(port)}`, close: () => { server.close() } }
}

/** 一个假的告警接收端：把收到的正文记下来，`GET /hits` 取。 */
async function startAlertStub() {
  const port = await freePort(8760)
  const hits = []
  const server = createServer((req, res) => {
    if (req.url === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hits }))
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      hits.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${String(port)}/alert`,
    seen: async () => (await (await fetch(`http://127.0.0.1:${String(port)}/hits`)).json()).hits,
    close: () => { server.close() },
  }
}

const run = async () => {
  // ── ① 主实例：配额 1 MB，没配机审 ──────────────────────────────────────
  log('① 主实例（配额 1 MB、没配机审）')
  const main = await startServer({ STUDIO_QUOTA_MB: '1' })
  check('服务器端实例起来了', main.failed !== true, main.failed === true ? main.output.join('').slice(-300) : '')
  if (main.failed === true) { main.child.kill(); process.exit(1) }

  const boss = client(main.base)
  const author = client(main.base)
  const anon = client(main.base)
  await boss.call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: 'boss@ops.test', password: 'boss-password-1' }) })
  const authorReg = await author.call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: 'author@ops.test', password: 'author-password-1', label: '验收' }) })
  check('作者注册成功', authorReg.status === 200)

  log('② 配额：按字节算，超了要说清还差多少')
  const huge = await author.upload(Buffer.alloc(2 * 1024 * 1024, 7))
  check('超过 1 MB 的成品被拒（413）', huge.status === 413, JSON.stringify(huge.json).slice(0, 120))
  check('拒绝的理由说清了「用满了」与数字',
    typeof huge.json.error === 'string' && huge.json.error.includes('云空间用满了') && huge.json.error.includes('MB'),
    String(huge.json.error ?? ''))
  const tiny = await author.upload(makePng(1))
  check('没超的照常收', tiny.status === 200 && typeof tiny.json.asset?.id === 'string')

  log('③ AI 生成标识：PNG 里真的躺着 tEXt 元数据')
  const published = await author.call('/api/v1/works', {
    method: 'POST',
    body: JSON.stringify({ title: '带标识的一件', assetId: tiny.json.asset.id }),
  })
  const workId = published.json.work?.id ?? ''
  check('发布成功', published.status === 200 && workId !== '', JSON.stringify(published.json).slice(0, 120))
  check('没配机审时如实说明（跳过，靠人工）', published.json.notes === undefined || Array.isArray(published.json.notes))
  await boss.call(`/api/v1/admin/works/${workId}/review`, { method: 'POST', body: JSON.stringify({ status: 'approved' }) })
  const raw = Buffer.from(await (await fetch(`${main.base}/w/${workId}/asset`)).arrayBuffer())
  check('成品里带 AI-Generated 标识', raw.includes('AI-Generated'), `bytes=${String(raw.length)}`)
  check('标识是以 tEXt 块写进去的', raw.includes('tEXt'))

  log('④ 私密备份（M5）：不进主页、不进队列、别人打不开')
  const privAsset = await author.upload(makePng(5))
  const priv = await author.call('/api/v1/works', {
    method: 'POST',
    body: JSON.stringify({ title: '我的私密备份', assetId: privAsset.json.asset.id, visibility: 'private' }),
  })
  const privId = priv.json.work?.id ?? ''
  check('私密备份存进去了', priv.status === 200 && priv.json.work?.visibility === 'private', JSON.stringify(priv.json).slice(0, 120))
  check('主页上没有它', !(await anon.call('/')).text.includes('我的私密备份'))
  check('匿名打不开', (await anon.call(`/w/${privId}`)).status === 404)
  check('匿名取不到它的文件', (await anon.call(`/w/${privId}/asset`)).status === 404)
  const ownPage = await author.call(`/w/${privId}`)
  check('作者自己打得开，并看到「私密备份」', ownPage.status === 200 && ownPage.text.includes('私密备份'), `HTTP ${String(ownPage.status)}`)
  const mine = await author.call('/api/v1/works')
  check('「我的作品」里带着 visibility', (mine.json.works ?? []).some((item) => item.id === privId && item.visibility === 'private'))
  const queue = await boss.call('/api/v1/admin/works?status=pending')
  check('审核队列里没有私密备份', !(queue.json.works ?? []).some((item) => item.id === privId))

  log('⑤ 运维状态接口：配额、机审、只读都看得见')
  const ops = await boss.call('/api/v1/admin/ops')
  check('管理员能读运维状态', ops.status === 200, JSON.stringify(ops.json).slice(0, 120))
  check('报了配额上限', ops.json.quotaMb === 1, String(ops.json.quotaMb))
  check('报了每个账号用了多少', typeof ops.json.quotaUsedBy?.['author@ops.test'] === 'number', JSON.stringify(ops.json.quotaUsedBy ?? {}).slice(0, 120))
  check('如实报告「机审没配」', ops.json.moderation?.configured === false && String(ops.json.moderation?.note ?? '').includes('人工'))
  check('普通用户读不到运维状态', (await author.call('/api/v1/admin/ops')).status === 403)

  log('⑥ 删作品会回收素材，配额跟着降')
  const before = ops.json.quotaUsedBy?.['author@ops.test'] ?? 0
  const deleted = await author.call(`/api/v1/works/${privId}`, { method: 'DELETE' })
  check('删得掉', deleted.status === 200, JSON.stringify(deleted.json))
  check('回收到至少一个素材', Number(deleted.json.swept ?? 0) >= 1, String(deleted.json.swept))
  const after = (await boss.call('/api/v1/admin/ops')).json.quotaUsedBy?.['author@ops.test'] ?? 0
  check('配额跟着降下来了', after < before, `${String(before)} → ${String(after)}`)
  check('被公开作品引用的素材**没有**被误删', (await anon.call(`/w/${workId}/asset`)).status === 200)

  log('⑦ 限流：注册被撞会 429，并告诉对方等多久')
  const results = []
  for (const index of [3, 4, 5, 6]) {
    results.push(await anon.call('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `flood${String(index)}@ops.test`, password: 'flood-password-1' }),
    }))
  }
  const blocked = results.filter((item) => item.status === 429)
  check('前几次放行、后面被拦', blocked.length >= 1, results.map((item) => String(item.status)).join(','))
  check('被拦时给了 Retry-After', blocked[0]?.retryAfter !== null && blocked[0]?.retryAfter !== undefined, String(blocked[0]?.retryAfter ?? '没有'))
  check('被拦的消息里有「太频繁」', String(blocked[0]?.json.error ?? '').includes('太频繁'), String(blocked[0]?.json.error ?? ''))

  main.child.kill()
  await sleep(400)

  // ── ② 只读实例 ────────────────────────────────────────────────────────
  log('⑧ 只读降级：写被拒、读照常、登录与备份还活着')
  const alertStub = await startAlertStub()
  const ro = await startServer({ STUDIO_READONLY: '1', STUDIO_ALERT_WEBHOOK: alertStub.url })
  check('只读实例起来了', ro.failed !== true, ro.failed === true ? ro.output.join('').slice(-300) : '')
  if (ro.failed !== true) {
    const roClient = client(ro.base)
    const health = await roClient.call('/api/health')
    check('健康检查报只读', health.json.readonly === true, JSON.stringify(health.json))
    check('健康检查说得出为什么', String(health.json.readonlyReason ?? '').includes('只读'), String(health.json.readonlyReason ?? ''))
    const refused = await roClient.call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: 'x@ops.test', password: 'x-password-1' }) })
    check('注册被拒（503）', refused.status === 503, `HTTP ${String(refused.status)}`)
    check('拒绝消息说清了是只读', String(refused.json.error ?? '').includes('只读'), String(refused.json.error ?? ''))
    check('主页照常能看', (await roClient.call('/')).status === 200)
    const login = await roClient.call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'nobody@ops.test', password: 'whatever-1' }) })
    check('登录没有被只读挡住（走的是 401 而不是 503）', login.status === 401, `HTTP ${String(login.status)}`)
    // 备份是运维的活路：只读时也要能用，而且**云模式下也要能访问**
    // （它曾经被「cloud 模式一律 404」那条挡掉了，只读白名单等于白写）。
    check('云模式下备份接口也能用', (await roClient.call('/api/backup')).status === 200)
    // 云端备份**真的在跑**：启动 8 秒后会做一次「每天自动」。
    // 这一条以前是错的（那段代码写着"cloud 模式没有自己的数据"就跳过了）——
    // 它现在装着所有人的作品与上传的成品，那台机器坏了主页就没了。
    await sleep(11_000)
    const backupState = await roClient.call('/api/backup')
    check('云端实例自己做出了第一份备份',
      Array.isArray(backupState.json.points) && backupState.json.points.length >= 1,
      `points=${String(backupState.json.points?.length ?? 'n/a')}`)
    // 告警：进入只读要**自己找到你**（而不是等你哪天打开设置页才发现）。
    const alerts = await alertStub.seen()
    check('进入只读时发了告警', alerts.length >= 1, `hits=${String(alerts.length)}`)
    check('告警正文里说清了原因', alerts[0]?.includes('只读') === true, String(alerts[0] ?? '').slice(0, 120))
    // 再摸几次 health：状态没变就不该重复喊（否则告警渠道会被刷爆、然后被忽略）。
    await roClient.call('/api/health')
    await roClient.call('/api/health')
    check('状态没变就不重复喊', (await alertStub.seen()).length === alerts.length, `hits=${String((await alertStub.seen()).length)}`)
    ro.child.kill()
    await sleep(400)
  }
  alertStub.close()

  // ── ③ 机审实例（放行策略 / 拒绝策略）──────────────────────────────────
  log('⑨ 机审：命中的挡在人工之前；接口挂了默认放行')
  const stub = await startModerationStub('ok')
  const mod = await startServer({ MODERATION_URL: stub.url, MODERATION_KEY: 'test-key' })
  check('带机审的实例起来了', mod.failed !== true, mod.failed === true ? mod.output.join('').slice(-300) : '')
  if (mod.failed !== true) {
    const mAuthor = client(mod.base)
    const mReg = await mAuthor.call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: 'mod@ops.test', password: 'mod-password-1' }) })
    check('机审实例上的账号注册成功且是管理员', mReg.status === 200 && mReg.json.user?.role === 'admin', `HTTP ${String(mReg.status)} ${JSON.stringify(mReg.json).slice(0, 140)}`)
    const asset = await mAuthor.upload(makePng(11))
    const bad = await mAuthor.call('/api/v1/works', { method: 'POST', body: JSON.stringify({ title: '一段违规内容', assetId: asset.json.asset.id }) })
    check('命中的内容发布被拒（400）', bad.status === 400, `HTTP ${String(bad.status)} ${String(bad.json.error ?? '')}`)
    check('拒绝理由来自机审', String(bad.json.error ?? '').includes('假机审'), String(bad.json.error ?? ''))
    const good = await mAuthor.call('/api/v1/works', { method: 'POST', body: JSON.stringify({ title: '一段正常内容', assetId: asset.json.asset.id }) })
    check('没命中的照常进人工队列', good.status === 200 && good.json.work?.status === 'pending', JSON.stringify(good.json).slice(0, 120))
    const opsState = await mAuthor.call('/api/v1/admin/ops')
    check('运维状态里报了「机审已配」', opsState.json.moderation?.configured === true, `HTTP ${String(opsState.status)} ${JSON.stringify(opsState.json).slice(0, 160)}`)
    mod.child.kill()
    await sleep(300)
  }
  stub.close()

  const down = await startModerationStub('down')
  const open = await startServer({ MODERATION_URL: down.url })
  const strict = await startServer({ MODERATION_URL: down.url, MODERATION_FAIL_CLOSED: '1' })
  check('两个策略实例都起来了', open.failed !== true && strict.failed !== true)
  if (open.failed !== true && strict.failed !== true) {
    for (const [tag, instance, expect] of [['放行', open, 200], ['拒绝', strict, 400]]) {
      const who = client(instance.base)
      await who.call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: `${tag}@ops.test`, password: 'policy-password-1' }) })
      const asset = await who.upload(makePng(21))
      const result = await who.call('/api/v1/works', { method: 'POST', body: JSON.stringify({ title: `接口挂了（${tag}）`, assetId: asset.json.asset.id }) })
      check(`机审接口 500 时按「${tag}」处理`, result.status === expect, `HTTP ${String(result.status)} ${String(result.json.error ?? '')}`)
    }
    open.child.kill()
    strict.child.kill()
    await sleep(300)
  }
  down.close()

  rmSync(scratch, { recursive: true, force: true })
  log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[ops] 失败:', error)
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 清了就好 */ }
  process.exit(1)
})
