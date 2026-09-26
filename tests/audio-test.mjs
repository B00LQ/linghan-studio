/**
 * 音频后端的单元验收（纯 Node，不需要容器、不需要真 key、不碰显卡）。
 *
 * 用法: node tests/audio-test.mjs
 *
 * 两条都值得钉住：
 * ① 占位驱动必须给一个**真能播的文件**（WAV 头对、有数据）—— 空字节在播放器里
 *    什么都不发生，而「播放器坏了」和「没配模型」是两回事；
 * ② 真驱动那段（OpenAI 兼容的 `/audio/speech`）只在配了 key 的机器上才会跑到，
 *    所以这里起一个本地假服务端，把请求形状与错误透传都验掉。
 */
import { createServer } from 'node:http'
import { audioConfigFrom, createAudioBackend, wavTone } from '../apps/server/src/audio.ts'

let failures = 0
const log = (...a) => console.log('[audio]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const deps = { store: {}, log: () => { /* 安静 */ } }

/** 一个假的 OpenAI 兼容服务端：记下请求，按脚本回音频字节。 */
const startFake = async (reply) => {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization ?? '', body: Buffer.concat(chunks).toString('utf8') })
      if (reply.status !== 200) {
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(reply.raw ?? '{}')
        return
      }
      res.writeHead(200, { 'content-type': reply.mime ?? 'audio/mpeg' })
      res.end(reply.bytes ?? Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { seen, url: `http://127.0.0.1:${String(server.address().port)}/v1`, close: () => { server.close() } }
}

log('① 占位音是一个真 WAV（不是空字节）')
const tone = wavTone(0.5)
check('RIFF/WAVE 头对', tone.subarray(0, 4).toString('latin1') === 'RIFF' && tone.subarray(8, 12).toString('latin1') === 'WAVE', tone.subarray(0, 12).toString('latin1'))
check('声明的数据长度与实际相符', tone.readUInt32LE(40) === tone.length - 44, `${String(tone.readUInt32LE(40))} vs ${String(tone.length - 44)}`)
check('16 位单声道 16 kHz', tone.readUInt16LE(22) === 1 && tone.readUInt16LE(34) === 16 && tone.readUInt32LE(24) === 16_000)
check('不是静音（有实际波形）', tone.subarray(44).some((byte) => byte !== 0))
check('首尾是淡入淡出（不爆音）', Math.abs(tone.readInt16LE(44)) < 200, String(tone.readInt16LE(44)))

log('② 没配 key = stub：能播的占位音，且如实说「没配」')
const stub = createAudioBackend(deps, () => ({}))
check('stub 驱动', stub.status().driver === 'stub', stub.status().driver)
check('configured=false', stub.status().configured === false)
check('note 里说了要设哪个变量', stub.status().note.includes('STUDIO_AUDIO_API_KEY'), stub.status().note)
const spoken = await stub.speak({ text: '那盏灯，是我最后一次见到他。' })
check('占位音是 wav', spoken.mime === 'audio/wav' && spoken.bytes.subarray(0, 4).toString('latin1') === 'RIFF', spoken.mime)
check('文本越长占位音越长（不让人以为被截断）',
  (await stub.speak({ text: '短' })).bytes.length < (await stub.speak({ text: '这是一段明显更长的台词，用来检查时长是否跟着字数走。' })).bytes.length)

log('③ 配了 key = 走 OpenAI 兼容的 /audio/speech')
const fake = await startFake({ status: 200, mime: 'audio/mpeg', bytes: Buffer.alloc(2048, 7) })
const env = { STUDIO_AUDIO_API_KEY: 'sk-test', STUDIO_AUDIO_BASE_URL: fake.url, STUDIO_AUDIO_MODEL: 'my-tts', STUDIO_AUDIO_VOICE: 'cherry' }
const live = createAudioBackend(deps, () => env)
check('驱动是 openai', live.status().driver === 'openai', live.status().driver)
check('base url 末尾斜杠被去掉', audioConfigFrom({ ...env, STUDIO_AUDIO_BASE_URL: `${fake.url}/` }).baseUrl === fake.url)
const result = await live.speak({ text: '念这一句' })
check('返回字节与 mime 对', result.bytes.length === 2048 && result.mime === 'audio/mpeg', `${String(result.bytes.length)} / ${result.mime}`)
check('音色用配置里的默认值', result.voice === 'cherry', result.voice)
const call = fake.seen[0]
check('打到 /audio/speech', call?.url === '/v1/audio/speech', String(call?.url))
check('带上了 Bearer key', call?.auth === 'Bearer sk-test', String(call?.auth))
const sent = JSON.parse(call?.body ?? '{}')
check('请求里有模型/文本/音色/格式',
  sent.model === 'my-tts' && sent.input === '念这一句' && sent.voice === 'cherry' && sent.response_format === 'mp3',
  JSON.stringify(sent))
const override = await live.speak({ text: '换一个音色', voice: 'alloy' })
check('调用方给音色会覆盖默认值', override.voice === 'alloy', override.voice)
await fake.close()

log('④ 报错要带上服务端的原话')
const denied = await startFake({ status: 401, raw: '{"error":{"message":"Invalid API key"}}' })
const deniedBackend = createAudioBackend(deps, () => ({ STUDIO_AUDIO_API_KEY: 'bad', STUDIO_AUDIO_BASE_URL: denied.url }))
let deniedMessage = ''
try { await deniedBackend.speak({ text: 'x' }) } catch (error) { deniedMessage = String(error) }
check('报错含状态码与原话', deniedMessage.includes('401') && deniedMessage.includes('Invalid API key'), deniedMessage.slice(0, 120))
await denied.close()

log('⑤ 回了空音频也算失败（不能把空文件存成素材）')
const empty = await startFake({ status: 200, bytes: Buffer.alloc(0) })
const emptyBackend = createAudioBackend(deps, () => ({ STUDIO_AUDIO_API_KEY: 'k', STUDIO_AUDIO_BASE_URL: empty.url }))
let emptyMessage = ''
try { await emptyBackend.speak({ text: 'x' }) } catch (error) { emptyMessage = String(error) }
check('空音频 → 明确报错', emptyMessage.includes('空音频'), emptyMessage.slice(0, 80))
await empty.close()

log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
