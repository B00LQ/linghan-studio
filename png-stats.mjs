/**
 * PNG 体检：零依赖解码 PNG，统计像素分布，回答一个很具体的问题——
 * 「这张图是正常画面，还是全黑 / 全白 / 噪声？」
 *
 * 用途：换推理后端（cu128 → cu130）、换模型、换采样器之后，出图快得可疑时，
 * 用它先排除「算出垃圾但很快返回」。没有视觉模型的环境里，这是最便宜的守门员。
 *
 * 用法: node png-stats.mjs <a.png> [b.png ...]
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

/** 按 PNG 规范把一张图解成每像素 RGB 采样。 */
function decodePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) throw new Error('不是 PNG（签名不匹配）')
  }

  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  const idat = []

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  if (depth !== 8) throw new Error(`暂不支持位深 ${depth}（本工具只处理 8 位）`)
  if (interlace !== 0) throw new Error('暂不支持隔行扫描')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (channels === undefined) throw new Error(`暂不支持颜色类型 ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let pos = 0

  // 逐行反过滤：每一行开头是过滤器类型，随后是 stride 字节数据。
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? Buffer.alloc(stride) : out.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`未知过滤器 ${filter}`)
      cur[x] = value & 0xff
    }
  }

  return { width, height, channels, pixels: out }
}

/** 统计亮度与饱和像素比例。 */
function stats({ width, height, channels, pixels }) {
  let sum = 0
  let sumSq = 0
  let count = 0
  let pureBlack = 0
  let pureWhite = 0
  const histogram = new Array(16).fill(0)
  for (let i = 0; i < pixels.length; i += channels) {
    const r = pixels[i]
    const g = channels >= 3 ? pixels[i + 1] : r
    const b = channels >= 3 ? pixels[i + 2] : r
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    sum += luma
    sumSq += luma * luma
    count += 1
    if (r === 0 && g === 0 && b === 0) pureBlack += 1
    if (r === 255 && g === 255 && b === 255) pureWhite += 1
    histogram[Math.min(15, luma >> 4)] += 1
  }
  const mean = sum / count
  const variance = sumSq / count - mean * mean
  return {
    mean,
    stddev: Math.sqrt(Math.max(0, variance)),
    pureBlackRatio: pureBlack / count,
    pureWhiteRatio: pureWhite / count,
    histogram,
    distinctBuckets: histogram.filter((n) => n / count > 0.005).length,
  }
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法: node png-stats.mjs <a.png> [b.png ...]')
  process.exit(2)
}

for (const file of files) {
  try {
    const bytes = readFileSync(file)
    const image = decodePng(bytes)
    const s = stats(image)
    const verdict =
      s.stddev < 2 ? '⚠ 近乎纯色（疑似空白图）'
        : s.distinctBuckets <= 2 ? '⚠ 层次极少（疑似退化）'
          : s.pureBlackRatio > 0.9 || s.pureWhiteRatio > 0.9 ? '⚠ 大片纯黑/纯白'
            : '✓ 正常画面'
    console.log(
      `${file.split(/[\\/]/).pop()}  ${image.width}x${image.height}  ${(bytes.length / 1024).toFixed(0)} KB  ` +
      `亮度 ${s.mean.toFixed(1)}  标准差 ${s.stddev.toFixed(1)}  纯黑 ${(s.pureBlackRatio * 100).toFixed(1)}%  ` +
      `直方图档位 ${s.distinctBuckets}/16  ${verdict}`,
    )
  } catch (error) {
    console.log(`${file.split(/[\\/]/).pop()}  解码失败: ${error.message}`)
  }
}
