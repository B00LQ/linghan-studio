/**
 * 备份与导出的验收（M2 的「三根保险丝」）。
 *
 * 用法: node tests/backup-test.mjs
 *
 * 为什么单独一条：**备份的价值全在「出事那一刻」，而平时它看起来什么都没做。**
 * 所以这里不验「按钮点了返回 200」，而是真的做一遍：
 * 备份 → 再改数据 → 恢复 → 重启 → 断言「改的那部分没了、备份里的还在」。
 * 素材镜像是增量的（内容寻址），恢复之后图还得在 —— 不然备份只是半份。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

// 用例都在 tests/ 下，仓库根在上一层。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'studio-backup-'))
const dataDir = join(scratch, 'data')
const backupDir = join(scratch, 'backup-on-another-disk')

let failures = 0
const log = (...a) => console.log('[backup]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort(start = 8480) {
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

/** 起一个 local 模式的临时实例（备份是本地模式的功能）。 */
function start(port) {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(repo, 'apps', 'server', 'src', 'index.ts')], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      STUDIO_MODE: 'local',
      STUDIO_DATA_DIR: dataDir,
      STUDIO_PASSWORD: 'backup-test-pw',
      STUDIO_IMAGE_DRIVER: 'stub',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (chunk) => { output.push(String(chunk)) })
  child.stderr.on('data', (chunk) => { output.push(String(chunk)) })
  return { child, output }
}

const up = async (base) => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return await response.json()
    } catch { /* not yet */ }
    await sleep(300)
  }
  return null
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

/** 一张 24×24 的 PNG（当素材用）。 */
function makePng(seed = 1) {
  const width = 24
  const height = 24
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4
      raw[at] = (x * 9 + seed * 13) % 256
      raw[at + 1] = (y * 7 + seed * 29) % 256
      raw[at + 2] = 128
      raw[at + 3] = 255
    }
  }
  const crcTable = (() => {
    const table = new Int32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let value = i
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      table[i] = value
    }
    return table
  })()
  const crc32 = (buffer) => {
    let crc = -1
    for (const byte of buffer) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0)
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
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const run = async () => {
  const port = await freePort()
  const base = `http://127.0.0.1:${String(port)}`
  let server = start(port)
  const health = await up(base)
  check('临时实例起来了', health !== null, JSON.stringify(health ?? server.output.join('').slice(-300)))
  if (health === null) { server.child.kill(); process.exit(1) }
  check('local 模式（备份是本地模式的功能）', health.mode === 'local', String(health.mode))

  const api = client(base)
  await api.call('/api/login', { method: 'POST', body: JSON.stringify({ password: 'backup-test-pw' }) })

  log('① 备份状态：位置、保留份数、网盘探测')
  const status0 = (await api.call('/api/backup')).json
  check('能读到备份状态', typeof status0.dir === 'string' && status0.dir !== '', JSON.stringify(status0).slice(0, 120))
  check('默认备份目录在数据目录下', status0.dir.includes('backups'), status0.dir)
  check('保留份数是 7', status0.keep === 7, String(status0.keep))
  check('给了「网盘同步目录」的建议字段（没有也可以为空）', Array.isArray(status0.suggestions), JSON.stringify(status0.suggestions))

  log('② 造点数据：一张画布 + 一个素材')
  const canvas = (await api.call('/api/canvases', { method: 'POST', body: JSON.stringify({ name: '备份验收画布' }) })).json.canvas
  check('画布建好了', typeof canvas?.id === 'string', String(canvas?.id))
  const uploaded = await fetch(`${base}/api/assets`, {
    method: 'POST', headers: { 'content-type': 'image/png', cookie: api.cookie() }, body: makePng(1),
  })
  const asset = (await uploaded.json()).asset
  check('素材上传成功', typeof asset?.id === 'string', String(asset?.id))
  await api.call(`/api/canvases/${canvas.id}/doc`, {
    method: 'PUT',
    body: JSON.stringify({
      doc: {
        nodes: [{ id: 'image-a', type: 'studio', position: { x: 0, y: 0 }, data: { kind: 'image', url: `/api/assets/${asset.id}`, text: '备份前的画面' } }],
        edges: [], viewport: { x: 0, y: 0, zoom: 1 },
      },
    }),
  })

  log('③ 做一次备份：数据库快照 + 素材镜像')
  const made = await api.call('/api/backup', { method: 'POST' })
  check('备份成功', made.status === 200 && typeof made.json.point?.id === 'string', JSON.stringify(made.json).slice(0, 160))
  const pointId = made.json.point?.id ?? ''
  check('备份目录里出现了快照', existsSync(join(status0.dir, 'snapshots', pointId, 'studio.sqlite')), pointId)
  check('素材被镜像过去了（内容寻址 → 增量）',
    existsSync(join(status0.dir, 'assets', asset.id.slice(0, 2), `${asset.id}.png`)),
    join(status0.dir, 'assets', asset.id.slice(0, 2)))
  const status1 = (await api.call('/api/backup')).json
  check('状态里能看到这一份', status1.points.some((item) => item.id === pointId), JSON.stringify(status1.points.map((p) => p.id)))
  check('素材镜像有计数', status1.mirrorFiles >= 1 && status1.mirrorBytes > 0, JSON.stringify({ files: status1.mirrorFiles, bytes: status1.mirrorBytes }))

  log('④ 改位置：指到「另一块盘」，下一份就落在那里')
  const moved = await api.call('/api/backup/config', { method: 'PUT', body: JSON.stringify({ dir: backupDir }) })
  check('改备份目录成功', moved.status === 200 && moved.json.status.dir === backupDir, JSON.stringify(moved.json.status?.dir))
  const second = await api.call('/api/backup', { method: 'POST' })
  check('新的一份落在新目录里', second.status === 200 && existsSync(join(backupDir, 'snapshots', second.json.point.id, 'studio.sqlite')),
    String(second.json.point?.id))
  check('新位置也有素材镜像', existsSync(join(backupDir, 'assets', asset.id.slice(0, 2), `${asset.id}.png`)))

  log('⑤ 备份之后继续改：这是恢复时要「退回去」的部分')
  await api.call(`/api/canvases/${canvas.id}/doc`, {
    method: 'PUT',
    body: JSON.stringify({
      doc: {
        nodes: [{ id: 'image-a', type: 'studio', position: { x: 0, y: 0 }, data: { kind: 'image', url: `/api/assets/${asset.id}`, text: '备份之后改的' } }],
        edges: [], viewport: { x: 0, y: 0, zoom: 1 },
      },
    }),
  })
  const changed = (await api.call(`/api/canvases/${canvas.id}/doc`)).json.doc
  check('现在的文档是「备份之后改的」', changed.nodes[0].data.text === '备份之后改的', String(changed.nodes[0].data.text))

  log('⑥ 导出画布包（换电脑靠它）')
  const exported = await fetch(`${base}/api/canvases/${canvas.id}/export`, { headers: { cookie: api.cookie() } })
  const zip = Buffer.from(await exported.arrayBuffer())
  check('导出返回 zip', exported.ok && exported.headers.get('content-type') === 'application/zip', `HTTP ${String(exported.status)}`)
  check('zip 里装的是 PK 头', zip[0] === 0x50 && zip[1] === 0x4b, `${String(zip.length)} 字节`)
  const inside = zip.toString('latin1')
  check('包里带画布文档', inside.includes('canvas.json'))
  check('包里带那张素材', inside.includes(`${asset.id}.png`), `${String(zip.length)} 字节`)
  check('包里记着导出的格式与版本', inside.includes('linghan-canvas'))

  log('⑦ 恢复：从备份点回去，重启后生效')
  const currentPoint = second.json.point.id
  const restored = await api.call('/api/backup/restore', { method: 'POST', body: JSON.stringify({ id: currentPoint }) })
  check('恢复请求被接受', restored.status === 200 && String(restored.json.note).includes('重启'), JSON.stringify(restored.json).slice(0, 160))
  check('数据目录里出现「待恢复」标记', existsSync(join(dataDir, 'restore-pending')))
  check('恢复前自动备份了当前状态（恢复错了还能回来）',
    ((await api.call('/api/backup')).json.points ?? []).some((item) => String(item.reason).includes('恢复前')),
    JSON.stringify(((await api.call('/api/backup')).json.points ?? []).map((p) => p.reason)))

  // 重启：启动时应用待恢复的快照。
  server.child.kill()
  await sleep(900)
  server = start(port)
  const health2 = await up(base)
  check('重启后起来了', health2 !== null, health2 === null ? server.output.join('').slice(-300) : '')
  check('日志里说明了「已从备份恢复」', server.output.join('').includes('已从备份恢复'), server.output.join('').slice(-200))
  const api2 = client(base)
  await api2.call('/api/login', { method: 'POST', body: JSON.stringify({ password: 'backup-test-pw' }) })
  const afterRestore = (await api2.call(`/api/canvases/${canvas.id}/doc`)).json.doc
  check('文档退回到备份那天的内容', afterRestore?.nodes?.[0]?.data?.text === '备份前的画面', String(afterRestore?.nodes?.[0]?.data?.text))
  // 素材接口返回的是二进制，不能走那个会 JSON.parse 的辅助函数（那是这套用例踩过的坑）。
  const assetStillThere = await fetch(`${base}/api/assets/${asset.id}`, { headers: { cookie: api2.cookie() } })
  check('恢复之后素材还在（说明镜像是真的恢复了）', assetStillThere.status === 200, `HTTP ${String(assetStillThere.status)}`)
  check('拿回来还是那张图的字节', Buffer.from(await assetStillThere.arrayBuffer()).equals(makePng(1)))

  log('⑧ 保留份数：只留最近 7 份')
  for (let i = 0; i < 9; i += 1) await api2.call('/api/backup', { method: 'POST' })
  const pruned = (await api2.call('/api/backup')).json
  check('备份点不超过保留份数', (pruned.points ?? []).length <= 7, `${String((pruned.points ?? []).length)} 份`)
  check('留下的是最近的那些（最早的已经被清掉）', !(pruned.points ?? []).some((item) => item.id === pointId), `${String((pruned.points ?? []).length)} 份`)

  server.child.kill()
  await sleep(500)
  rmSync(scratch, { recursive: true, force: true })
  log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[backup] 失败:', error)
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 清了就好 */ }
  process.exit(1)
})
