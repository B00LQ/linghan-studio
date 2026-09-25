/**
 * 生成应用图标（`icon.png`）。
 *
 * 用服务端那个零依赖 PNG 编码器直接画像素，而不是塞一个来路不明的图：
 * 图标是这个应用在任务栏与安装程序里唯一的脸，而它只有几十行。
 *
 * 画的是：深色圆角底 + 一条亮蓝色的斜带（和界面里的强调色同一个色号）。
 * 简单、可复现、看得出是有意为之 —— 比 Electron 默认那个原子图标强。
 */
import { writeFileSync } from 'node:fs'
import { encodePng } from '../apps/server/src/png.ts'

/** 圆角矩形的覆盖率（0–1），用来做抗锯齿的 alpha。 */
function coverage(x, y, size, radius) {
  // 到最近圆角圆心的距离（超出核心矩形时才算圆角区）
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  const distance = Math.hypot(x - cx, y - cy)
  return Math.max(0, Math.min(1, radius - distance + 0.5))
}

/**
 * 画一张图标并写盘。
 * @param path - where to write the PNG.
 * @param size - edge length in pixels (Square icons only; 256 is what Windows wants).
 */
export function writeIcon(path, size = 256) {
  const data = Buffer.alloc(size * size * 4)
  const radius = size * 0.22
  const accent = [122, 162, 255]
  const base = [11, 13, 18]
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4
      // 斜带：|x + y - size| 落在带宽里就是亮色（左下到右上）。
      const band = Math.abs(x + (size - y) - size) < size * 0.13
      const inner = Math.abs(x + (size - y) - size) < size * 0.06
      const color = band ? (inner ? [180, 205, 255] : accent) : base
      data[at] = color[0]
      data[at + 1] = color[1]
      data[at + 2] = color[2]
      data[at + 3] = Math.round(255 * coverage(x + 0.5, y + 0.5, size, radius))
    }
  }
  writeFileSync(path, encodePng({ width: size, height: size, channels: 4, data }))
}
