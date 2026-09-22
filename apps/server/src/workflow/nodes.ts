/**
 * The studio's node catalogue.
 *
 * PRD §3.2.3 lists five categories and fifteen-odd node types. All of them are
 * declared here so the graph, the ports, and the UI can be built against the
 * complete vocabulary — but only the ones this deployment can actually execute
 * get an executor. The rest fail with a specific reason ("未配置视频供应商")
 * rather than a stack trace, because a node that silently does nothing is worse
 * than one that says what it is missing.
 */
import { port, type NodeTypeSpec, type Registry } from './registry.ts'
import { createRegistry } from './registry.ts'

/** What the catalogue needs from the rest of the server. */
export interface CatalogueDeps {
  /** Render images through the existing gateway (local ComfyUI or cloud). */
  renderImage: (request: { prompt: string; size?: string; count?: number }) => Promise<{ url: string; assetId: string }[]>
  /** Persist a small text artefact and return its asset id. */
  saveText: (text: string, name: string) => { assetId: string }
  /** Diagnostics. */
  log: (message: string) => void
}

/** Read a string parameter. */
function paramString(params: Record<string, unknown>, key: string, fallback = ''): string {
  const value = params[key]
  return typeof value === 'string' ? value : fallback
}

/** Read a number parameter. */
function paramNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Extract text from an input value that may be a string or a list of strings. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(asText).filter((item) => item !== '').join('\n')
  if (value !== null && typeof value === 'object') {
    const text = (value as Record<string, unknown>).text
    if (typeof text === 'string') return text
  }
  return ''
}

/** Collect asset ids from an input that may be one descriptor or many. */
function asAssets(value: unknown): { assetId: string; url: string }[] {
  const items = Array.isArray(value) ? value : [value]
  const assets: { assetId: string; url: string }[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const images = record.images
    if (Array.isArray(images)) assets.push(...asAssets(images))
    else if (typeof record.assetId === 'string') assets.push({ assetId: record.assetId, url: paramString(record, 'url') })
    else if (typeof record.id === 'string') assets.push({ assetId: record.id, url: paramString(record, 'url') })
  }
  return assets
}

/**
 * Build the studio node catalogue.
 * @param deps - gateway access, text storage, diagnostics.
 * @returns a registry with every node type declared.
 */
export function createStudioRegistry(deps: CatalogueDeps): Registry {
  const specs: NodeTypeSpec[] = [
    /* ---------- 输入资源节点 ---------- */
    {
      type: 'text.input',
      category: 'input',
      title: '文本',
      description: '一段文案或提示词。',
      inputs: [],
      outputs: [port('text', 'text', false, '文本内容')],
      params: { text: '' },
      run: async ({ node }) => ({ text: paramString(node.params, 'text') }),
    },
    {
      type: 'script.input',
      category: 'input',
      title: '剧本导入',
      description: '整段剧本或文案，供后续拆分。',
      inputs: [],
      outputs: [port('script', 'text', false, '剧本全文')],
      params: { script: '' },
      run: async ({ node }) => ({ script: paramString(node.params, 'script') }),
    },
    {
      type: 'asset.reference',
      category: 'input',
      title: '素材引用',
      description: '引用素材库里的图片，作为参考图。',
      inputs: [],
      outputs: [port('image', 'image', false, '引用的图片')],
      params: { assetId: '', url: '' },
      run: async ({ node }) => ({ image: { assetId: paramString(node.params, 'assetId'), url: paramString(node.params, 'url') } }),
    },

    /* ---------- AI 生成节点 ---------- */
    {
      type: 'llm.script-breakdown',
      category: 'generate',
      title: 'LLM 剧本拆分',
      description: '把剧本拆成场次与分镜。',
      inputs: [port('script', 'text', true, '剧本全文')],
      outputs: [port('shots', 'text', false, '分镜列表（JSON）')],
      params: {},
      unavailable: '未配置文本模型（LLM）供应商，剧本拆分暂不可用',
    },
    {
      type: 'prompt.compose',
      category: 'generate',
      title: '提示词拼接',
      description: '把多段文本合成一条提示词，可加前缀后缀。',
      inputs: [port('base', 'text', false), port('extra', 'text', false)],
      outputs: [port('text', 'text', false, '合成后的提示词')],
      params: { prefix: '', suffix: '', separator: '，' },
      run: async ({ node, inputs }) => {
        const parts = [asText(inputs.base), asText(inputs.extra)].map((item) => item.trim()).filter((item) => item !== '')
        const prefix = paramString(node.params, 'prefix')
        const suffix = paramString(node.params, 'suffix')
        const joined = [prefix, parts.join(paramString(node.params, 'separator', '，')), suffix]
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .join('')
        return { text: joined }
      },
    },
    {
      type: 'image.generate',
      category: 'generate',
      title: '图像生成',
      description: '按提示词出图，默认走本地 ComfyUI。',
      inputs: [port('prompt', 'text', true, '提示词')],
      outputs: [port('image', 'image', false, '生成的图片')],
      params: { size: '1024x1024', count: 1 },
      run: async ({ node, inputs, log }) => {
        const prompt = asText(inputs.prompt).trim()
        if (prompt === '') throw new Error('提示词为空')
        const size = paramString(node.params, 'size', '1024x1024')
        const count = paramNumber(node.params, 'count', 1)
        log(`生成 ${String(count)} 张 ${size}：${prompt.slice(0, 40)}`)
        const images = await deps.renderImage({ prompt, size, count })
        return { image: images.map((image) => ({ assetId: image.assetId, url: image.url })) }
      },
    },
    {
      type: 'video.generate',
      category: 'generate',
      title: '视频生成',
      description: '文生视频或图生视频。',
      inputs: [port('prompt', 'text', false), port('image', 'image', false, '首帧参考图')],
      outputs: [port('video', 'video', false, '生成的视频')],
      params: { durationSec: 5, aspect: '16:9' },
      unavailable: '未配置视频供应商（需要云端 Key，或先验证本地小模型）',
    },
    {
      type: 'audio.tts',
      category: 'generate',
      title: '语音配音',
      description: '文本转语音。',
      inputs: [port('text', 'text', true, '台词')],
      outputs: [port('audio', 'audio', false, '音频')],
      params: { voice: 'default' },
      unavailable: '未配置 TTS 供应商',
    },
    {
      type: 'text.subtitle',
      category: 'generate',
      title: '字幕生成',
      description: '从台词生成字幕文件。',
      inputs: [port('text', 'text', true, '台词')],
      outputs: [port('subtitle', 'manifest', false, '字幕数据')],
      params: { format: 'srt' },
      run: async ({ node, inputs, log }) => {
        const text = asText(inputs.text).trim()
        if (text === '') throw new Error('台词为空')
        // Timing needs a real audio track; until TTS exists, emit one cue per
        // line with placeholder timings rather than pretending to be accurate.
        const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
        const cues = lines.map((line, index) => `${String(index + 1)}\n00:00:${String(index * 3).padStart(2, '0')},000 --> 00:00:${String(index * 3 + 3).padStart(2, '0')},000\n${line}\n`)
        log(`生成 ${String(cues.length)} 条字幕（时间轴待接入 TTS 后校准）`)
        const saved = deps.saveText(cues.join('\n'), `subtitle-${node.id}.srt`)
        return { subtitle: { assetId: saved.assetId, format: paramString(node.params, 'format', 'srt'), lines: cues.length } }
      },
    },

    /* ---------- 画面控制节点 ---------- */
    {
      type: 'control.character',
      category: 'control',
      title: '角色一致性',
      description: '注入角色锚点描述与参考图，维持跨镜头一致。',
      inputs: [port('prompt', 'text', false), port('reference', 'image', false)],
      outputs: [port('text', 'text', false, '注入锚点后的提示词'), port('image', 'image', false, '参考图')],
      params: { anchor: '' },
      run: async ({ node, inputs }) => {
        const anchor = paramString(node.params, 'anchor').trim()
        const base = asText(inputs.prompt).trim()
        return {
          text: anchor === '' ? base : `${anchor}${base === '' ? '' : `，${base}`}`,
          image: inputs.reference,
        }
      },
    },
    {
      type: 'control.shot-params',
      category: 'control',
      title: '镜头参数',
      description: '设定景别、机位、运动与画幅。',
      inputs: [port('prompt', 'text', false)],
      outputs: [port('text', 'text', false, '追加镜头描述后的提示词')],
      params: { shotSize: 'MS', cameraMove: 'static', aspect: '16:9' },
      run: async ({ node, inputs }) => {
        const vocabulary: Record<string, string> = {
          ELS: '大远景', LS: '全景', MS: '中景', CU: '特写', ECU: '大特写',
          static: '固定机位', pan: '横摇', tilt: '俯仰', dolly: '推轨', zoom: '变焦', handheld: '手持', crane: '摇臂', orbit: '环绕',
        }
        const size = vocabulary[paramString(node.params, 'shotSize', 'MS')] ?? '中景'
        const move = vocabulary[paramString(node.params, 'cameraMove', 'static')] ?? '固定机位'
        const base = asText(inputs.prompt).trim()
        const suffix = `${size}，${move}`
        return { text: base === '' ? suffix : `${base}，${suffix}` }
      },
    },

    /* ---------- 后期处理节点 ---------- */
    {
      type: 'video.concat',
      category: 'post',
      title: '剪辑拼接',
      description: '把多段视频按顺序拼成一条。',
      inputs: [port('video', 'video', false, '视频片段')],
      outputs: [port('video', 'video', false, '拼接结果')],
      params: {},
      unavailable: '未配置视频供应商：没有可拼接的片段',
    },
    {
      type: 'video.trim',
      category: 'post',
      title: '片段裁切',
      description: '按时间区间裁切视频。',
      inputs: [port('video', 'video', true)],
      outputs: [port('video', 'video', false)],
      params: { startSec: 0, endSec: 5 },
      unavailable: '未配置视频供应商',
    },
    {
      type: 'audio.mix',
      category: 'post',
      title: '音频混音',
      description: '混合配音与音效。',
      inputs: [port('audio', 'audio', false)],
      outputs: [port('audio', 'audio', false)],
      params: {},
      unavailable: '未配置音频处理供应商',
    },

    /* ---------- 输出导出节点 ---------- */
    {
      type: 'export.manifest',
      category: 'output',
      title: '导出清单',
      description: '汇总上游产物，输出一份可交付的清单文件。',
      inputs: [port('image', 'image', false), port('video', 'video', false), port('text', 'text', false)],
      outputs: [port('manifest', 'manifest', false, '清单')],
      params: { name: 'export' },
      run: async ({ node, inputs, log }) => {
        const images = asAssets(inputs.image)
        const payload = {
          name: paramString(node.params, 'name', 'export'),
          createdAt: new Date().toISOString(),
          images,
          text: asText(inputs.text),
          note: '视频/音频产物接入供应商后一并列入',
        }
        const saved = deps.saveText(JSON.stringify(payload, null, 2), `${paramString(node.params, 'name', 'export')}.json`)
        log(`清单已生成：${String(images.length)} 张图片`)
        return { manifest: { assetId: saved.assetId, images: images.length } }
      },
    },
    {
      type: 'export.package',
      category: 'output',
      title: '成片导出',
      description: '打包成片与素材。',
      inputs: [port('video', 'video', false), port('manifest', 'manifest', false)],
      outputs: [port('manifest', 'manifest', false)],
      params: {},
      unavailable: '未配置视频供应商：暂无可导出的成片',
    },
  ]

  const registry = createRegistry(specs)
  deps.log(`workflow: 注册 ${String(specs.length)} 种节点，其中 ${String(specs.filter((spec) => spec.run !== undefined).length)} 种可执行`)
  return registry
}
