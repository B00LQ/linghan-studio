/**
 * 应用图标（`icon.png` + `icon.ico`）。
 *
 * 源图就是产品标记本身：`apps/web/public/ling-mark.png`（深色圆角底 + 白色印章）。
 * **不再自己画一个**：界面上、任务栏里、安装程序里、开始菜单里应该是同一张脸，
 * 各画一版迟早会有一版忘了改。
 *
 * 为什么还要 `.ico`：Windows 的任务栏、快捷方式与 Inno Setup 只认 `.ico`
 * （`SetupIconFile` 收 PNG 会直接报 "Icon file is invalid"）。ICO 从 Vista 起
 * 可以内嵌 PNG，所以这里把源图缩成几种尺寸再按 ICO 的目录结构拼起来 ——
 * 几十行、零依赖，用的是服务端那个 PNG 编解码器。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, downscale, encodePng } from '../apps/server/src/png.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 产品标记（界面上那份）。 */
export const MARK_PNG = join(REPO, 'apps', 'web', 'public', 'ling-mark.png')

/** ICO 里放哪几种尺寸；Windows 会在不同场合各取一种（16 是任务栏小图标，256 是超大图标）。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * 写一张 PNG 图标。
 * @param path - 输出路径。
 * @param size - 边长（方形）。
 */
export function writeIcon(path, size = 256) {
  const raster = decodePng(readFileSync(MARK_PNG))
  writeFileSync(path, encodePng(downscale(raster, size)))
}

/**
 * 写一个 Windows `.ico`（内嵌 PNG）。
 * @param path - 输出路径。
 * @param sourcePng - 源图；默认用产品标记。
 * @param sizes - 要放进去的尺寸。
 */
export function writeIco(path, sourcePng = MARK_PNG, sizes = ICO_SIZES) {
  const raster = decodePng(readFileSync(sourcePng))
  const images = sizes.map((size) => ({ size, bytes: encodePng(downscale(raster, size)) }))

  // ICONDIR：保留位 0、类型 1（图标）、条目数。
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  // 每个条目 16 字节；图像数据紧跟在目录之后。
  let offset = 6 + images.length * 16
  const entries = images.map((image) => {
    const entry = Buffer.alloc(16)
    // 宽高各一字节：256 写 0（那一格放不下 256）。
    entry[0] = image.size >= 256 ? 0 : image.size
    entry[1] = image.size >= 256 ? 0 : image.size
    entry[2] = 0 // 调色板数（真彩色为 0）
    entry[3] = 0 // 保留
    entry.writeUInt16LE(1, 4) // 色彩平面
    entry.writeUInt16LE(32, 6) // 位深
    entry.writeUInt32LE(image.bytes.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += image.bytes.length
    return entry
  })

  writeFileSync(path, Buffer.concat([header, ...entries, ...images.map((image) => image.bytes)]))
}
