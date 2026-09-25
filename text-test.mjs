/**
 * 文本后端的单元验收（纯 Node，不需要容器、不需要真 key、不碰显卡）。
 *
 * 用法: node text-test.mjs
 *
 * 为什么要有这一条：文本这条路的**真实分支**（OpenAI 兼容那段）只有在配了 key 的机器上
 * 才会跑到，而那台机器通常不是开发机。所以这里起一个本地假服务端，把请求形状、
 * 响应解析和报错都钉住 —— 真接上模型时，链路已经是对的。
 */
import { createServer } from 'node:http'
import { createTextBackend, textConfigFrom } from './apps/server/src/text.ts'

let failures = 0
const log = (...a) => console.log('[text]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

/** 一个假的 OpenAI 兼容服务端，把收到的请求记下来，按脚本回应。 */
const startFake = async (reply) => {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization ?? '', body })
      const { status, payload, raw } = reply
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(raw ?? JSON.stringify(payload))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { seen, url: `http://127.0.0.1:${String(port)}/v1`, close: () => { server.close() } }
}

const deps = { store: {}, log: () => { /* 安静 */ } }

log('① 没配 key = stub：占位文本，且如实说「没配」')
const stub = createTextBackend(deps, {})
check('stub 驱动', stub.status().driver === 'stub', stub.status().driver)
check('configured=false', stub.status().configured === false)
check('note 里说了要设哪个变量', stub.status().note.includes('STUDIO_TEXT_API_KEY'), stub.status().note)
const placeholder = await stub.generate({ prompt: '雨夜霓虹', context: '上一句' })
check('占位文本带上了指令', placeholder.includes('雨夜霓虹') && placeholder.includes('上一句'), placeholder.slice(0, 60))
check('占位文本自称占位（不冒充模型）', placeholder.includes('占位'), placeholder.slice(0, 40))

log('② 配了 key = 走 OpenAI 兼容的 /chat/completions')
const fake = await startFake({ status: 200, payload: { choices: [{ message: { content: '  写好的三行文本  ' } }] } })
const env = {
  STUDIO_TEXT_API_KEY: 'sk-test',
  STUDIO_TEXT_BASE_URL: fake.url,
  STUDIO_TEXT_MODEL: 'my-model',
}
const live = createTextBackend(deps, env)
check('驱动是 openai', live.status().driver === 'openai', live.status().driver)
check('model 报的是配的那个', live.status().model === 'my-model', live.status().model)
check('base url 末尾斜杠被去掉', textConfigFrom({ ...env, STUDIO_TEXT_BASE_URL: `${fake.url}/` }).baseUrl === fake.url, textConfigFrom(env).baseUrl)
const text = await live.generate({ prompt: '写三行', context: '之前的段落' })
check('返回内容去掉了首尾空白', text === '写好的三行文本', JSON.stringify(text))
const call = fake.seen[0]
check('打到 /chat/completions', call?.url === '/v1/chat/completions', String(call?.url))
check('带上了 Bearer key', call?.auth === 'Bearer sk-test', String(call?.auth))
const sent = JSON.parse(call?.body ?? '{}')
check('请求里带了模型名', sent.model === 'my-model', String(sent.model))
check('指令与「已有的内容」都进了 user 消息',
  String(sent.messages?.[1]?.content).includes('写三行') && String(sent.messages?.[1]?.content).includes('之前的段落'),
  JSON.stringify(sent.messages?.[1]?.content).slice(0, 80))
check('有一条 system 消息定风格', sent.messages?.[0]?.role === 'system', String(sent.messages?.[0]?.role))
await fake.close()

log('③ 报错要带上服务端的原话（401/404/429 的处理方式完全不同）')
const denied = await startFake({ status: 401, raw: '{"error":{"message":"Invalid API key"}}' })
const deniedBackend = createTextBackend(deps, { STUDIO_TEXT_API_KEY: 'bad', STUDIO_TEXT_BASE_URL: denied.url })
let deniedMessage = ''
try { await deniedBackend.generate({ prompt: 'x' }) } catch (error) { deniedMessage = String(error) }
check('报错含状态码', deniedMessage.includes('401'), deniedMessage.slice(0, 80))
check('报错含服务端原话', deniedMessage.includes('Invalid API key'), deniedMessage.slice(0, 120))
await denied.close()

log('④ 回了空内容也算失败（不能把空白写进人的节点）')
const empty = await startFake({ status: 200, payload: { choices: [{ message: { content: '   ' } }] } })
const emptyBackend = createTextBackend(deps, { STUDIO_TEXT_API_KEY: 'k', STUDIO_TEXT_BASE_URL: empty.url })
let emptyMessage = ''
try { await emptyBackend.generate({ prompt: 'x' }) } catch (error) { emptyMessage = String(error) }
check('空内容 → 明确报错', emptyMessage.includes('空内容'), emptyMessage.slice(0, 80))
await empty.close()

log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
