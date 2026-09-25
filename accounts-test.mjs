/**
 * 账号验收（M1）：注册 / 登录 / 会话 / 邮箱验证 / 重置密码。
 *
 * 用法: node accounts-test.mjs
 *
 * 为什么单独一条：这是**对外发布的接口**（桌面端会带着它发出去），而且它守的是
 * 「谁能代表某个人」这件事。它有几个不能靠肉眼看的性质，所以逐条钉住：
 *
 * - 密码**不含明文入库**（scrypt），令牌**只存哈希**；
 * - 登录失败与邮箱不存在**返回同一句话**（不然登录接口就是个「查邮箱是否注册过」的工具）；
 * - 令牌**一次性**（用过的验证/重置链接不能再用）；
 * - 重置密码后**所有会话失效**（这正是「怀疑号被盗」时要的效果）。
 *
 * 它起一个**临时 cloud 实例**（自己的数据目录、自己的端口），不需要浏览器、
 * 不需要邮箱服务：邮件默认打到日志，测试从日志里把链接抠出来。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'studio-accounts-'))

let failures = 0
const log = (...a) => console.log('[accounts]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一个空闲端口（先连一下：Docker 转发占着 8080 时「绑一下试试」会被骗过去）。 */
async function freePort(start = 8450) {
  const { createServer } = await import('node:http')
  const { connect } = await import('node:net')
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

const run = async () => {
  const port = await freePort()
  const base = `http://127.0.0.1:${String(port)}`
  const child = spawn(process.execPath, ['--experimental-strip-types', join(repo, 'apps', 'server', 'src', 'index.ts')], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      STUDIO_MODE: 'cloud',
      STUDIO_DATA_DIR: join(scratch, 'data'),
      STUDIO_PUBLIC_URL: base,
      STUDIO_PASSWORD: '',
      STUDIO_MAIL_WEBHOOK: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (chunk) => { output.push(String(chunk)) })
  child.stderr.on('data', (chunk) => { output.push(String(chunk)) })
  /** 从服务端日志里抠出邮件里的链接（默认 mailer 就是打到日志）。 */
  const mailLink = (kind) => {
    const text = output.join('')
    const matches = [...text.matchAll(new RegExp(`/(verify-email|reset-password)\\?token=([A-Za-z0-9_-]+)`, 'gu'))]
      .filter((match) => match[1] === kind)
    return matches.length === 0 ? '' : (matches[matches.length - 1]?.[2] ?? '')
  }

  const up = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        const response = await fetch(`${base}/api/health`)
        if (response.ok) return await response.json()
      } catch { /* not yet */ }
      await sleep(300)
    }
    return null
  })()
  check('cloud 模式的实例起来了', up !== null, up === null ? output.join('').slice(-400) : JSON.stringify(up))
  if (up === null) { child.kill(); process.exit(1) }
  check('健康检查报出模式', up.mode === 'cloud', String(up.mode))

  /** 一个带 cookie 的调用器。 */
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    const text = await response.text()
    const cookies = (response.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0])
    return { status: response.status, ok: response.ok, json: text === '' ? {} : JSON.parse(text), cookies }
  }
  const bearer = (token) => ({ authorization: `Bearer ${token}` })

  log('① cloud 模式没有画布/素材/算力（那些只在用户机器上）')
  const noCanvas = await call('/api/canvases')
  check('画布接口明确不可用（404 且说清原因）',
    noCanvas.status === 404 && String(noCanvas.json.error).includes('桌面端'), `HTTP ${String(noCanvas.status)}`)
  const noJobs = await call('/api/jobs', { method: 'POST', body: '{}' })
  check('作业接口也不可用', noJobs.status === 404, `HTTP ${String(noJobs.status)}`)

  log('② 注册：密码强度、邮箱形状、重复邮箱')
  const weak = await call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: 'a@b.com', password: '123' }) })
  check('密码太短被拒', weak.status === 400 && String(weak.json.error).includes('至少'), JSON.stringify(weak.json))
  const badEmail = await call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: 'not-an-email', password: 'longenough1' }) })
  check('邮箱形状不对被拒', badEmail.status === 400, JSON.stringify(badEmail.json))

  const email = `owner-${String(Date.now()).slice(-6)}@example.com`
  const password = 'correct-horse-battery'
  const registered = await call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName: '提出者', label: '验收浏览器' }) })
  check('注册成功', registered.status === 200 && registered.json.user?.email === email, JSON.stringify(registered.json).slice(0, 160))
  check('第一个账号是管理员（服务器刚搭起来总得有人能进后台）', registered.json.user?.role === 'admin', String(registered.json.user?.role))
  check('邮箱还没验证', registered.json.user?.emailVerified === false)
  check('注册时就把会话给了（不用再登一次）', typeof registered.json.tokens?.accessToken === 'string' && typeof registered.json.tokens?.refreshToken === 'string')
  check('注册也能带上设备名（不然设备列表里是一长串 User-Agent）',
    ((await call('/api/v1/auth/sessions', { headers: bearer(registered.json.tokens.accessToken) })).json.sessions ?? [])[0]?.label === '验收浏览器',
    JSON.stringify(((await call('/api/v1/auth/sessions', { headers: bearer(registered.json.tokens.accessToken) })).json.sessions ?? [])[0] ?? {}))
  check('网页端也拿到了 cookie', registered.cookies.some((item) => item.startsWith('studio_user=')), registered.cookies.join(' | '))

  const duplicate = await call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) })
  check('重复邮箱被拒（这里必须说清，不然人会一直重试）', duplicate.status === 409, `HTTP ${String(duplicate.status)}`)

  log('③ 登录：错密码与不存在的邮箱回同一句话')
  const wrongPassword = await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'wrong-password-here' }) })
  const noSuchUser = await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever-long' }) })
  check('错密码 → 401', wrongPassword.status === 401, `HTTP ${String(wrongPassword.status)}`)
  check('不存在的邮箱 → 401', noSuchUser.status === 401, `HTTP ${String(noSuchUser.status)}`)
  check('两者的话**一模一样**（不然就是个查邮箱是否注册过的工具）',
    wrongPassword.json.error === noSuchUser.json.error, `${String(wrongPassword.json.error)} vs ${String(noSuchUser.json.error)}`)

  const loggedIn = await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password, label: '验收机' }) })
  check('登录成功', loggedIn.status === 200 && typeof loggedIn.json.tokens?.accessToken === 'string', JSON.stringify(loggedIn.json).slice(0, 120))
  const access = loggedIn.json.tokens.accessToken
  const refresh = loggedIn.json.tokens.refreshToken

  log('④ 会话：me / 刷新轮换 / 登出撤销 / 设备列表')
  const me = await call('/api/v1/auth/me', { headers: bearer(access) })
  check('带 Bearer 能读到自己', me.status === 200 && me.json.user?.email === email, JSON.stringify(me.json).slice(0, 120))
  check('me 里没有密码哈希之类的字段', !JSON.stringify(me.json).includes('scrypt'), JSON.stringify(me.json).slice(0, 160))
  check('没带令牌读不到', (await call('/api/v1/auth/me')).status === 401)

  const refreshed = await call('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: refresh }) })
  check('刷新换到新的一对', refreshed.status === 200 && refreshed.json.tokens.accessToken !== access, JSON.stringify(refreshed.json).slice(0, 100))
  check('旧刷新令牌**立刻失效**（轮换而不是复制）',
    (await call('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: refresh }) })).status === 401)
  const access2 = refreshed.json.tokens.accessToken

  const sessions = await call('/api/v1/auth/sessions', { headers: bearer(access2) })
  check('能看到自己的设备', (sessions.json.sessions ?? []).length >= 2, JSON.stringify(sessions.json).slice(0, 200))
  check('设备带了名字与时间', (sessions.json.sessions ?? []).every((item) => typeof item.label === 'string' && typeof item.lastSeenAt === 'string'))

  log('⑤ 邮箱验证：邮件链接点开就能用，而且是一次性的')
  const verifyToken = mailLink('verify-email')
  check('邮件里有验证链接（默认 mailer 打到日志）', verifyToken !== '', verifyToken.slice(0, 12))
  // 邮件里的链接是**页面**（不是 API）：点开就该看到结果，不该是「页面不存在」。
  const verifyPage = await fetch(`${base}/verify-email?token=${verifyToken}`)
  const verifyHtml = await verifyPage.text()
  check('点开链接是一个能用的页面', verifyPage.status === 200 && verifyHtml.includes('邮箱验证成功'), `HTTP ${String(verifyPage.status)}`)
  check('同一个链接再点一次就说「无效」（一次性）',
    (await fetch(`${base}/verify-email?token=${verifyToken}`)).status === 400)
  const verified = await call('/api/v1/auth/me', { headers: bearer(access2) })
  check('接口里也变成已验证', verified.json.user?.emailVerified === true, JSON.stringify(verified.json).slice(0, 120))

  log('⑥ 忘记密码 → 重置 → 所有会话失效')
  const forgot = await call('/api/v1/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) })
  check('忘记密码对存在的邮箱回「已发送」', forgot.status === 200, JSON.stringify(forgot.json))
  const forgotUnknown = await call('/api/v1/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: 'nobody@example.com' }) })
  check('对不存在的邮箱**回一样的话**（不泄露注册状态）', forgotUnknown.json.note === forgot.json.note, `${String(forgotUnknown.json.note)} vs ${String(forgot.json.note)}`)
  const resetToken = mailLink('reset-password')
  check('邮件里有重置链接', resetToken !== '', resetToken.slice(0, 12))
  const resetPage = await fetch(`${base}/reset-password?token=${resetToken}`)
  const resetHtml = await resetPage.text()
  check('重置链接也是一页能填表的地方',
    resetPage.status === 200 && resetHtml.includes('设置新密码') && resetHtml.includes('type="password"'),
    `HTTP ${String(resetPage.status)}`)

  const newPassword = 'a-brand-new-password'
  const reset = await call('/api/v1/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: resetToken, password: newPassword }) })
  check('重置成功', reset.status === 200, JSON.stringify(reset.json))
  check('重置后旧会话立刻失效',
    (await call('/api/v1/auth/me', { headers: bearer(access2) })).status === 401)
  check('旧密码登不进去了',
    (await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).status === 401)
  const withNew = await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password: newPassword }) })
  check('新密码能登录', withNew.status === 200 && typeof withNew.json.tokens?.accessToken === 'string', JSON.stringify(withNew.json).slice(0, 100))

  log('⑦ 登出撤销')
  const toLogout = withNew.json.tokens
  check('登出', (await call('/api/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: toLogout.refreshToken }) })).status === 200)
  check('登出后访问令牌也不能用了', (await call('/api/v1/auth/me', { headers: bearer(toLogout.accessToken) })).status === 401)
  check('登出后刷新令牌也不能用了',
    (await call('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: toLogout.refreshToken }) })).status === 401)

  log('⑨ 服务器端有一页能点的界面（不懂命令行的人也要能看见）')
  const page = await fetch(`${base}/`)
  const pageHtml = await page.text()
  check('根路径是账号页（不是画布 SPA）',
    page.status === 200 && pageHtml.includes('注册') && pageHtml.includes('登录') && pageHtml.includes('服务器端'),
    `HTTP ${String(page.status)}`)
  check('页面上说清了「画布与算力在你自己的桌面端里」',
    pageHtml.includes('画布、素材、算力都在你自己的桌面端里'))
  check('页面上有设备列表与撤销（账号能自己管）',
    pageHtml.includes('登录过的设备') && pageHtml.includes('撤销'))
  check('/account 也是同一页', (await fetch(`${base}/account`)).status === 200)

  log('⑩ 没配发信服务时，验证链接在页面上就能点（配了 webhook 就自动消失）')
  const devMailAnon = await call('/api/v1/auth/dev-mail')
  check('未登录读不到别人的邮件', devMailAnon.status === 401, `HTTP ${String(devMailAnon.status)}`)
  const freshEmail = `demo-${String(Date.now()).slice(-6)}@example.com`
  const fresh = await call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: freshEmail, password: 'demo-password-1' }) })
  const freshToken = fresh.json.tokens?.accessToken ?? ''
  const devMail = await call('/api/v1/auth/dev-mail', { headers: bearer(freshToken) })
  check('登录后能看到**自己**那一封开发邮件', (devMail.json.mails ?? []).length > 0, JSON.stringify(devMail.json).slice(0, 120))
  check('里面就是验证链接', String(devMail.json.mails?.[0]?.text ?? '').includes('/verify-email?token='))

  log('⑧ 数据库里存的是哈希，不是明文')
  child.kill()
  await sleep(600)
  const dbPath = join(scratch, 'data', 'studio.sqlite')
  check('库文件在', existsSync(dbPath), dbPath)
  if (existsSync(dbPath)) {
    // **WAL 模式**：数据可能还在 `-wal` 里，没合并进主文件。
    // 只读主文件会得到「什么都没有」的假安全感（连明文检查都会"通过"）。
    const all = ['', '-wal', '-shm']
      .map((suffix) => (existsSync(`${dbPath}${suffix}`) ? readFileSync(`${dbPath}${suffix}`) : Buffer.alloc(0)))
    const text = Buffer.concat(all).toString('latin1')
    check('库里没有明文密码', !text.includes(newPassword) && !text.includes(password))
    check('库里没有明文令牌', !text.includes(access2) && !text.includes(toLogout.refreshToken))
    check('库里有 scrypt 哈希（说明走的是对的算法）', text.includes('scrypt$'))
  }

  rmSync(scratch, { recursive: true, force: true })
  log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[accounts] 失败:', error)
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 清了就好 */ }
  process.exit(1)
})
