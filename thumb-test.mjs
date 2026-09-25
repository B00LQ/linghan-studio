/**
 * 缩略图的单元验收（纯函数，不需要容器、不需要显卡、不需要浏览器）。
 *
 * 用法: node thumb-test.mjs
 *
 * 为什么要有这一条：缩略图是**手写的 PNG 解码器**（服务端只用 Node 内置模块，这是部署
 * 承诺，而 Node 里没有图像库）。手写解码器的错法全都很安静——滤波器算错是整幅偏色，
 * 16 位取低字节是满屏噪点，通道搞混是红蓝互换；而画布上的小格子本来就小，人一眼看不出
 * 是缩略图错了还是原图就这样。
 *
 * 覆盖的每一种颜色型都各钉一条，外加「不支持的要拒绝」：调色板、隔行、JPEG 必须回
 * undefined，让接口回 404、调用方退回原图。**给一张错的缩略图比不给更糟。**
 */
import { deflateSync } from 'node:zlib'
import { decodePng, downscale, encodePng, thumbnail } from './apps/server/src/png.ts'

let failures = 0
const log = (...a) => console.log('[thumb]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32, so the file we build is a *legal* PNG (a decoder that skips CRC is not being tested). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()
const crc32 = (type, data) => {
  let crc = 0xffffffff
  for (const byte of Buffer.concat([Buffer.from(type, 'latin1'), data])) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(type, data), 0)
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, crc])
}

/**
 * Build a PNG by hand, with full control over the things this decoder has to survive:
 * 位深、颜色型、隔行标志、每行的滤波器。
 * @param rows - one buffer per row, **含** 行首的滤波器字节。
 */
const buildPng = ({ width, height, depth = 8, color = 2, interlace = 0, rows }) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(depth, 8)
  header.writeUInt8(color, 9)
  header.writeUInt8(0, 10)
  header.writeUInt8(0, 11)
  header.writeUInt8(interlace, 12)
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
/** One unfiltered (filter 0) row for `color`: `pixels` is flat channel data. */
const rawRow = (pixels) => Buffer.concat([Buffer.from([0]), Buffer.from(pixels)])

log('① 编码 → 解码 一来一回，像素必须一模一样')
const rgb = {
  width: 3,
  height: 2,
  channels: 3,
  data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252, 253, 254, 255, 0, 128, 64]),
}
const rgba = {
  width: 2,
  height: 2,
  channels: 4,
  data: Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]),
}
for (const [name, source] of [['RGB', rgb], ['RGBA', rgba]]) {
  const back = decodePng(encodePng(source))
  check(`${name} 往返尺寸/通道/像素都一致`,
    back !== undefined &&
      back.width === source.width &&
      back.height === source.height &&
      back.channels === source.channels &&
      back.data.equals(source.data),
    back === undefined ? '解码回 undefined' : `${String(back.width)}×${String(back.height)} ch${String(back.channels)}`)
}
// 编码器默认用 Up 滤波（每行减去上一行）。滤波本身也要能被自己解回来，
// 否则「编出来的图只有第一行是对的」这种错会一直藏着。
const gradient = {
  width: 4,
  height: 3,
  channels: 3,
  data: Buffer.from(
    Array.from({ length: 4 * 3 * 3 }, (_, index) => (index * 7) % 256),
  ),
}
const gradientBack = decodePng(encodePng(gradient))
check('多行图（走了 Up 滤波）往返一致', gradientBack?.data.equals(gradient.data) === true,
  gradientBack === undefined ? '解码回 undefined' : `首个不同的字节：${
    String(gradientBack.data.findIndex((byte, index) => byte !== gradient.data[index]))}`)

log('② 每种颜色型都要认，并归一化成 RGB / RGBA')
// 灰度：一个通道出来三个通道相等。
const gray = buildPng({ width: 2, height: 1, color: 0, rows: [rawRow([0, 255])] })
const grayOut = decodePng(gray)
check('颜色型 0（灰度）→ RGB 三通道相等',
  grayOut?.channels === 3 && grayOut.data.equals(Buffer.from([0, 0, 0, 255, 255, 255])),
  grayOut === undefined ? '解码回 undefined' : grayOut.data.toJSON().data.join(','))
// 灰度 + alpha：alpha 必须留着（缩略图丢了 alpha 会变成黑底）。
const grayAlpha = buildPng({ width: 2, height: 1, color: 4, rows: [rawRow([200, 128, 100, 0])] })
const grayAlphaOut = decodePng(grayAlpha)
check('颜色型 4（灰度+alpha）→ RGBA 且 alpha 保留',
  grayAlphaOut?.channels === 4 && grayAlphaOut.data.equals(Buffer.from([200, 200, 200, 128, 100, 100, 100, 0])),
  grayAlphaOut === undefined ? '解码回 undefined' : grayAlphaOut.data.toJSON().data.join(','))
// RGB / RGBA 原样。
const rgbOut = decodePng(buildPng({ width: 1, height: 2, color: 2, rows: [rawRow([1, 2, 3]), rawRow([4, 5, 6])] }))
check('颜色型 2（RGB）两个像素都在', rgbOut?.data.equals(Buffer.from([1, 2, 3, 4, 5, 6])) === true,
  rgbOut === undefined ? '解码回 undefined' : rgbOut.data.toJSON().data.join(','))
const rgbaOut = decodePng(buildPng({ width: 1, height: 1, color: 6, rows: [rawRow([9, 8, 7, 6])] }))
check('颜色型 6（RGBA）四通道都在', rgbaOut?.data.equals(Buffer.from([9, 8, 7, 6])) === true,
  rgbaOut === undefined ? '解码回 undefined' : rgbaOut.data.toJSON().data.join(','))
// 16 位：取**高**字节。取低字节的症状是「整幅图变成噪点」——8 位量化噪声被当成了亮度。
const deep = buildPng({ width: 1, height: 1, depth: 16, color: 2, rows: [rawRow([0x12, 0x34, 0xab, 0xcd, 0x00, 0xff])] })
const deepOut = decodePng(deep)
check('16 位取高字节', deepOut?.data.equals(Buffer.from([0x12, 0xab, 0x00])) === true,
  deepOut === undefined ? '解码回 undefined' : deepOut.data.toJSON().data.join(','))

log('③ 五种滤波器都要能反算')
// 逐行用 filter 0/1/2/3/4。行内容随便给，判据是「解出来的和原始像素一致」。
// 用 3 通道 8 位，bpp = 3，所以第 4 个字节开始才吃得到左边/左上。
const pixelsOf = (row) => row
const filters = [
  { type: 0, encode: (row) => row },
  { type: 1, encode: (row, previous) => row.map((value, index) => (value - (index >= 3 ? row[index - 3] : 0)) & 0xff) },
  { type: 2, encode: (row, previous) => row.map((value, index) => (value - (previous?.[index] ?? 0)) & 0xff) },
  {
    type: 3,
    encode: (row, previous) => row.map((value, index) => {
      const left = index >= 3 ? row[index - 3] : 0
      const up = previous?.[index] ?? 0
      return (value - Math.floor((left + up) / 2)) & 0xff
    }),
  },
  {
    type: 4,
    encode: (row, previous) => row.map((value, index) => {
      const left = index >= 3 ? row[index - 3] : 0
      const up = previous?.[index] ?? 0
      const upLeft = index >= 3 ? (previous?.[index - 3] ?? 0) : 0
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      return (value - (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff
    }),
  },
]
const wanted = [[10, 20, 30, 40, 50, 60, 70, 80, 90], [200, 190, 180, 170, 160, 150, 140, 130, 120], [5, 250, 5, 250, 5, 250, 5, 250, 5]]
const filteredRows = wanted.map((row, index) => {
  const filter = filters[index % filters.length]
  return Buffer.concat([Buffer.from([filter.type]), Buffer.from(filter.encode(pixelsOf(row), wanted[index - 1]))])
})
const filteredOut = decodePng(buildPng({ width: 3, height: 3, color: 2, rows: filteredRows }))
check('滤波器 0/1/2/3/4 各自反算正确',
  filteredOut !== undefined && Buffer.concat(wanted.map((row) => Buffer.from(row))).equals(filteredOut.data),
  filteredOut === undefined ? '解码回 undefined' : `${filteredOut.data.toJSON().data.join(',')} ≠ ${wanted.flat().join(',')}`)

log('④ 不支持的必须拒绝（回 undefined，让接口回 404、前端退回原图）')
const palette = (() => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(3, 9)
  return Buffer.concat([
    SIGNATURE, chunk('IHDR', header),
    chunk('PLTE', Buffer.from([255, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
})()
check('调色板（颜色型 3）被拒', decodePng(palette) === undefined)
check('隔行（Adam7）被拒',
  decodePng(buildPng({ width: 2, height: 2, color: 2, interlace: 1, rows: [rawRow([1, 2, 3, 4, 5, 6]), rawRow([7, 8, 9, 10, 11, 12])] })) === undefined)
check('位深 4 被拒',
  decodePng(buildPng({ width: 2, height: 1, depth: 4, color: 0, rows: [rawRow([0x12])] })) === undefined)
check('JPEG 被拒', decodePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) === undefined)
check('空文件/截断被拒', decodePng(Buffer.alloc(0)) === undefined && decodePng(encodePng(rgb).subarray(0, 40)) === undefined)
check('JPEG 的缩略图请求拿不到图', thumbnail(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), 64) === undefined)

log('⑤ 缩小是按块平均，不是丢像素')
// 4×4 全 100 → 2×2 必须还是 100（丢像素会碰巧也对，所以下面再放一块不均匀的）。
const flat = { width: 4, height: 4, channels: 3, data: Buffer.alloc(4 * 4 * 3, 100) }
const flatSmall = downscale(flat, 2)
check('4×4 → 2×2，均匀块平均值不变',
  flatSmall.width === 2 && flatSmall.height === 2 && flatSmall.data.every((byte) => byte === 100),
  `${String(flatSmall.width)}×${String(flatSmall.height)} ${flatSmall.data.toJSON().data.join(',')}`)
// 2×2 块 [10,20,30,60] → 平均 30。丢像素会得到 10 或 60，两者都判错。
const block = { width: 2, height: 2, channels: 3, data: Buffer.from([10, 10, 10, 20, 20, 20, 30, 30, 30, 60, 60, 60]) }
const blockSmall = downscale(block, 1)
check('2×2 → 1×1 取的是平均（30）而不是某个像素',
  blockSmall.width === 1 && blockSmall.data.equals(Buffer.from([30, 30, 30])),
  blockSmall.data.toJSON().data.join(','))
// alpha 也要一起平均，否则半透明边缘会变硬。
const blockAlpha = { width: 2, height: 2, channels: 4, data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 200]) }
check('alpha 一起平均', downscale(blockAlpha, 1).data.equals(Buffer.from([0, 0, 0, 75])) === true,
  downscale(blockAlpha, 1).data.toJSON().data.join(','))
// 已经够小就原样返回（不能放大：放大的缩略图比原图还大）。
const small = { width: 8, height: 6, channels: 3, data: Buffer.alloc(8 * 6 * 3, 7) }
check('长边已达标时原样返回（不放大）', downscale(small, 320) === small)
// 长边 1000 缩到 320：整数倍是 ceil(1000/320)=4 → 250×128。
const wide = { width: 1000, height: 512, channels: 3, data: Buffer.alloc(1000 * 512 * 3, 3) }
const wideSmall = downscale(wide, 320)
check('1000×512 → 250×128（长边落到 320 以内）',
  wideSmall.width === 250 && wideSmall.height === 128, `${String(wideSmall.width)}×${String(wideSmall.height)}`)
// 长宽都小于等于 maxDim 的一边也要缩：判据是长边，不是面积。
const tall = { width: 40, height: 800, channels: 3, data: Buffer.alloc(40 * 800 * 3, 9) }
check('竖图按高算倍数（800 → 长边 ≤ 320）', Math.max(tall.height, tall.width) > 320 && downscale(tall, 320).height <= 320,
  `${String(downscale(tall, 320).width)}×${String(downscale(tall, 320).height)}`)

log('⑥ thumbnail：端到端，体积要真的小下来')
// 造一张「有内容」的图：必须是**真噪声**，纯色或规律数据会被 deflate 压到几百字节，
// 那样量出来的「体积收益」是压缩算法的功劳，不是缩放的。
const noisy = (() => {
  const data = Buffer.alloc(512 * 512 * 3)
  let state = 0x2545f491
  for (let index = 0; index < data.length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
    data[index] = (state >>> 16) & 0xff
  }
  return { width: 512, height: 512, channels: 3, data }
})()
const noisyPng = encodePng(noisy)
const smallPng = thumbnail(noisyPng, 320)
const smallBack = smallPng === undefined ? undefined : decodePng(smallPng)
check('缩略图能解码回来', smallBack !== undefined)
check('长边缩到 320 以内', smallBack !== undefined && Math.max(smallBack.width, smallBack.height) <= 320,
  smallBack === undefined ? 'undefined' : `${String(smallBack.width)}×${String(smallBack.height)}`)
// 512² 缩到长边 320 时倍数是 ceil(512/320)=2 → 256²，面积正好是四分之一。
check('面积少了 3 倍以上（512² → 256²）',
  smallBack !== undefined && smallBack.width * smallBack.height * 3 <= noisy.width * noisy.height,
  smallBack === undefined ? 'undefined' : `${String(smallBack.width * smallBack.height)} vs ${String(noisy.width * noisy.height)}`)
check('体积明显变小（至少小一半）', smallPng !== undefined && smallPng.length * 2 < noisyPng.length,
  smallPng === undefined ? 'undefined' : `${String(noisyPng.length)} → ${String(smallPng.length)} 字节`)
check('已经够小的图不会被放大', (() => {
  const tiny = thumbnail(encodePng({ width: 16, height: 16, channels: 3, data: Buffer.alloc(16 * 16 * 3, 200) }), 320)
  const back = tiny === undefined ? undefined : decodePng(tiny)
  return back?.width === 16 && back.height === 16
})())
// maxDim 的默认值是 320：路由不传参数时用的就是它。
check('默认长边就是 320', (() => {
  const back = decodePng(thumbnail(noisyPng) ?? Buffer.alloc(0))
  return back !== undefined && Math.max(back.width, back.height) === 256
})(), '512² 默认缩到 256²（ceil(512/320)=2）')

log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
