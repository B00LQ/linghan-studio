/**
 * 一次性验证：把 Z-Image Turbo 的 API 格式工作流直接打到 ComfyUI，确认能出图。
 * 用法: node comfyui-smoke.mjs [templateJson] [prompt]
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 相对脚本自身定位模板，换台机器/换个克隆目录都能跑。
const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = process.argv[2] ?? join(HERE, 'apps/server/src/comfyui/z-image-turbo.json')
const PROMPT = process.argv[3] ?? '雨夜霓虹街头，电影感广角，湿地面反光，霓虹招牌'
const BASE = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'

const log = (...a) => console.log('[smoke]', ...a)

/** 深度替换字符串占位符（"$name"）。 */
function substitute(value, vars) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const key = value.slice(1)
    if (!(key in vars)) throw new Error(`模板占位符未提供: ${key}`)
    return vars[key]
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]))
  }
  return value
}

const template = JSON.parse(await readFile(TEMPLATE, 'utf8'))
const vars = {
  ...template.models,
  ...template.defaults,
  prompt: PROMPT,
  seed: Math.floor(Math.random() * 1_000_000_000),
  prefix: 'studio_smoke',
}
const graph = substitute(template.graph, vars)

log('提交工作流，seed =', vars.seed)
const submit = await fetch(`${BASE}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: 'studio-smoke' }),
})
const submitted = await submit.json()
if (!submit.ok) {
  log('提交失败：', JSON.stringify(submitted, null, 2).slice(0, 1200))
  process.exit(1)
}
const promptId = submitted.prompt_id
log('已入队 prompt_id =', promptId)

const started = Date.now()
let entry
for (let i = 0; i < 240; i += 1) {
  await new Promise((r) => setTimeout(r, 1500))
  const history = await (await fetch(`${BASE}/history/${promptId}`)).json()
  entry = history[promptId]
  if (entry !== undefined) break
  if (i % 8 === 0) log(`  等待中… ${String(Math.round((Date.now() - started) / 1000))}s`)
}
if (entry === undefined) {
  log('超时：240 次轮询内没有结果')
  process.exit(1)
}

const status = entry.status?.status_str ?? 'unknown'
log(`状态: ${status}  耗时 ${String(Math.round((Date.now() - started) / 1000))}s`)
if (entry.status?.messages) {
  for (const message of entry.status.messages) {
    if (Array.isArray(message) && message[0] === 'execution_error') {
      log('执行错误：', JSON.stringify(message[1]).slice(0, 800))
    }
  }
}

const outputs = entry.outputs ?? {}
const images = Object.values(outputs).flatMap((node) => node.images ?? [])
if (images.length === 0) {
  log('没有产出图片。输出节点：', JSON.stringify(outputs).slice(0, 600))
  process.exit(1)
}
for (const image of images) {
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
  const response = await fetch(`${BASE}/view?${query.toString()}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  log(`产出: ${image.filename}  ${String(bytes.length)} 字节  PNG=${String(isPng)}  ${String(width)}x${String(height)}`)
}
log('✅ 本地 ComfyUI 出图链路通过')
