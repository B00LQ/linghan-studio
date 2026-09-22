/**
 * Crop / rotate / flip a picture in the browser.
 *
 * The browser already ships a decoder for every format we can display, so the
 * cheapest correct way to edit an image is to let it do the work: draw with a
 * transform into an offscreen canvas, then read the result back as a PNG blob.
 * The output is a real file, so a cropped picture can be downloaded, reused as a
 * node, or fed back into a workflow — not just displayed differently.
 */
import type { Rect } from './crop'
import { rotatedSize } from './crop'

/** Everything a single edit pass can do to a picture. */
export interface EditOps {
  /** Clockwise rotation in degrees. */
  rotate?: number
  /** Mirror left-to-right. */
  flipX?: boolean
  /** Mirror top-to-bottom. */
  flipY?: boolean
  /** Region to keep, in source pixels. */
  crop?: Rect
}

/** What an editor needs to know about a picture before it can offer controls. */
export interface ImageInfo {
  url: string
  width: number
  height: number
}

/**
 * Load a picture and report its natural size.
 *
 * Canvas work needs the *decoded* pixels, so this resolves only once the browser
 * has actually decoded the file — a URL alone is not enough.
 * @param url - image URL, same-origin or CORS-permitted.
 * @returns the loaded element and its natural size.
 */
export function loadImage(url: string): Promise<{ image: HTMLImageElement; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('这张图片读不出来，可能源文件已经不在磁盘上了'))
    image.src = url
  })
}

/**
 * Apply crop / rotate / flip and return a PNG.
 *
 * The transform is written the way the user thinks about it — first crop the
 * region you selected, then rotate what is left — so the crop rectangle never
 * has to be expressed in rotated coordinates.
 * @param source - picture URL.
 * @param ops - the edits to apply.
 * @returns a PNG blob of the result.
 */
export async function transformImage(source: string, ops: EditOps): Promise<Blob> {
  const { image, width, height } = await loadImage(source)
  const crop = ops.crop ?? { x: 0, y: 0, w: width, h: height }
  const rotated = rotatedSize({ w: crop.w, h: crop.h }, ops.rotate ?? 0)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rotated.w))
  canvas.height = Math.max(1, Math.round(rotated.h))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('这台设备不支持画布编辑')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(canvas.width / 2, canvas.height / 2)
  if (ops.rotate) ctx.rotate((ops.rotate * Math.PI) / 180)
  ctx.scale(ops.flipX ? -1 : 1, ops.flipY ? -1 : 1)
  // Draw the crop region centred, which is what the rotation above expects.
  ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, -crop.w / 2, -crop.h / 2, crop.w, crop.h)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
  if (!blob) throw new Error('这张图片导出失败了')
  return blob
}

/** Read a picture's natural size without keeping the element around. */
export async function imageInfo(url: string): Promise<ImageInfo> {
  const { width, height } = await loadImage(url)
  return { url, width, height }
}
