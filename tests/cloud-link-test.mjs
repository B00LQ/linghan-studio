/**
 * 「桌面端绑定账号」的验收（M2 的最后一环，也是 M3 发布的前提）。
 *
 * 用法: node tests/cloud-link-test.mjs
 *
 * 为什么单独一条：这是**两套系统之间的一次握手**（桌面端 ↔ 服务器端），而且是安全相关的：
 * 一次性码、state 防串号、码用过就作废、撤销之后立刻失效。
 * 光看代码看不出来，所以这里真起两个实例，把整条链路走一遍：
 *
 *   桌面端生成 state → 云端授权页（模拟用户点「授权」）→ 一次性码 → 回跳到桌面端 →
 *   桌面端拿码换令牌并落库 → 桌面端能读到自己的邮箱
 *
 * 附带验两条安全线：**码不能用第二次**、**state 不对不给绑**。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 用例都在 tests/ 下，仓库根在上一层。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'studio-link-'))

let failures = 0
const log = (...a) => console.log('[cloud-link]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort(start) {
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

const start = (port, env) => {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(repo, 'apps', 'server', 'src', 'index.ts')], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (c) => { output.push(String(c)) })
  child.stderr.on('data', (c) => { output.push(String(c)) })
  return { child, output }
}

const up = async (base) => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return true
    } catch { /* not yet */ }
    await sleep(300)
  }
  return false
}

const client = (base) => {
  let cookie = ''
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(init.headers ?? {}) },
    })
    const set = response.headers.getSetCookie?.() ?? []
    if (set.length > 0) cookie = set.map((item) => item.split(';')[0]).join('; ')
    const text = await response.text()
    return { status: response.status, ok: response.ok, json: text === '' ? {} : JSON.parse(text) }
  }
  return { call, cookie: () => cookie }
}

const run = async () => {
  const cloudPort = await freePort(8520)
  const localPort = await freePort(cloudPort + 1)
  const cloudBase = `http://127.0.0.1:${String(cloudPort)}`
  const localBase = `http://127.0.0.1:${String(localPort)}`

  const cloud = start(cloudPort, {
    STUDIO_MODE: 'cloud',
    STUDIO_DATA_DIR: join(scratch, 'cloud-data'),
    STUDIO_PUBLIC_URL: cloudBase,
  })
  const local = start(localPort, {
    STUDIO_MODE: 'local',
    STUDIO_DATA_DIR: join(scratch, 'local-data'),
    STUDIO_PASSWORD: 'link-test-pw',
    STUDIO_IMAGE_DRIVER: 'stub',
    STUDY_IGNORE: '',
  })
  check('服务器端实例起来了', await up(cloudBase), cloud.output.join('').slice(-200))
  check('桌面端实例起来了', await up(localBase), local.output.join('').slice(-200))

  const cloudApi = client(cloudBase)
  const localApi = client(localBase)
  await localApi.call('/api/login', { method: 'POST', body: JSON.stringify({ password: 'link-test-pw' }) })

  log('① 桌面端还没绑定，也没有云服务地址')
  const before = (await localApi.call('/api/cloud')).json
  check('状态是「未绑定」', before.bound === false, JSON.stringify(before))
  check('没填云服务地址时给出人话', String((await localApi.call('/api/cloud/login', { method: 'POST' })).json.error).includes('云服务地址'),
    JSON.stringify((await localApi.call('/api/cloud/login', { method: 'POST' })).json))

  log('② 在桌面端设置里填上云服务地址')
  const saved = await localApi.call('/api/settings', { method: 'PUT', body: JSON.stringify({ values: { STUDIO_CLOUD_URL: cloudBase } }) })
  check('云服务地址存下来了', saved.json.saved?.includes('STUDIO_CLOUD_URL') === true, JSON.stringify(saved.json.saved))
  check('状态里报出了地址', (await localApi.call('/api/cloud')).json.cloudUrl === cloudBase)

  log('③ 点「绑定账号」：拿到要打开的授权页地址')
  const started = await localApi.call('/api/cloud/login', { method: 'POST' })
  check('给了授权页地址与 state', typeof started.json.url === 'string' && typeof started.json.state === 'string', JSON.stringify(started.json).slice(0, 140))
  const authUrl = new URL(started.json.url)
  check('授权页在云服务上', authUrl.origin === cloudBase && authUrl.pathname === '/desktop-auth', authUrl.pathname)
  check('回跳地址是本机服务（只允许回环）', String(authUrl.searchParams.get('redirect')).startsWith(localBase), String(authUrl.searchParams.get('redirect')))

  const authPage = await fetch(started.json.url)
  const authHtml = await authPage.text()
  check('授权页能打开、并且说明了它要做什么',
    authPage.status === 200 && authHtml.includes('授权这台电脑') && authHtml.includes('LINGHAN Studio'), `HTTP ${String(authPage.status)}`)

  log('④ 云端：注册一个账号（模拟用户在授权页上登录）')
  const email = `link-${String(Date.now()).slice(-6)}@example.com`
  const registered = await cloudApi.call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'link-test-password', label: '授权页' }) })
  check('云端账号建好了', registered.status === 200, JSON.stringify(registered.json).slice(0, 100))

  log('⑤ 云端发一次性码（页面上点「授权这台电脑」就是这一步）')
  const issued = await cloudApi.call('/api/v1/auth/desktop/issue', { method: 'POST', body: '{}' })
  check('拿到一次性码', issued.status === 200 && typeof issued.json.code === 'string', JSON.stringify(issued.json).slice(0, 100))
  const code = issued.json.code

  log('⑥ state 不对不给绑（防串号）')
  const wrongState = await fetch(`${localBase}/api/cloud/callback?code=${code}&state=not-the-right-state`)
  check('state 不匹配时拒绝', wrongState.status === 400, `HTTP ${String(wrongState.status)}`)

  log('⑦ 回跳：桌面端用码换令牌')
  const callback = await fetch(`${localBase}/api/cloud/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(started.json.state)}`)
  const callbackHtml = await callback.text()
  check('回跳成功并给了能看的页面', callback.status === 200 && callbackHtml.includes('绑定成功'), `HTTP ${String(callback.status)}`)
  const after = (await localApi.call('/api/cloud')).json
  check('桌面端已经是「已绑定」', after.bound === true, JSON.stringify(after))
  check('并且读到了自己的邮箱', after.email === email, `${String(after.email)} vs ${email}`)

  log('⑧ 码是一次性的')
  const again = await fetch(`${localBase}/api/cloud/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(started.json.state)}`)
  check('同一个码再用一次会被拒', again.status === 400, `HTTP ${String(again.status)}`)

  log('⑨ 云端能看到这次授权留下的设备')
  const sessions = await cloudApi.call('/api/v1/auth/sessions')
  check('设备列表里有「桌面端」这一条', (sessions.json.sessions ?? []).some((item) => item.label === '桌面端'),
    JSON.stringify((sessions.json.sessions ?? []).map((s) => s.label)))

  log('⑩ 解绑：桌面端不再持有令牌')
  check('解绑成功', (await localApi.call('/api/cloud/logout', { method: 'POST' })).status === 200)
  check('状态回到未绑定', (await localApi.call('/api/cloud')).json.bound === false)

  cloud.child.kill()
  local.child.kill()
  await sleep(500)
  rmSync(scratch, { recursive: true, force: true })
  log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[cloud-link] 失败:', error)
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 清了就好 */ }
  process.exit(1)
})
