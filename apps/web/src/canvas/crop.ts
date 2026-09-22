/**
 * Crop and rotate arithmetic.
 *
 * Pure, and separate from the drawing code on purpose: the fiddly parts of an
 * image editor are the ones you cannot see — a drag that starts bottom-right and
 * ends top-left, a crop rect that pokes outside the picture, a rotation that
 * swaps width and height. Those are cheap to test here and expensive to debug in
 * a canvas element.
 */

/** A rectangle in image pixels. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A point in image pixels. */
export interface Point {
  x: number
  y: number
}

/** Size of a picture. */
export interface Size {
  w: number
  h: number
}

/**
 * Turn two drag corners into a positive-size rectangle.
 *
 * Dragging up or to the left is normal and must not produce a negative width —
 * which would silently draw nothing.
 * @param from - where the drag started.
 * @param to - where the pointer is now.
 * @returns a rectangle with non-negative width and height.
 */
export function normalizeRect(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x),
    h: Math.abs(to.y - from.y),
  }
}

/**
 * Keep a rectangle inside the picture.
 *
 * A crop that runs off the edge has no pixels there, so the result would be
 * transparent or black. Clamping keeps "crop to the edge" meaning what it says.
 * @param rect - the requested rectangle.
 * @param bounds - the picture's size.
 * @returns the rectangle, pulled inside and never larger than the picture.
 */
export function clampRect(rect: Rect, bounds: Size): Rect {
  const w = Math.max(1, Math.min(Math.round(rect.w), bounds.w))
  const h = Math.max(1, Math.min(Math.round(rect.h), bounds.h))
  return {
    w,
    h,
    x: Math.max(0, Math.min(Math.round(rect.x), bounds.w - w)),
    y: Math.max(0, Math.min(Math.round(rect.y), bounds.h - h)),
  }
}

/**
 * The size a picture takes after rotating it by a quarter turn.
 *
 * 90 and 270 swap the axes; 180 and 0 do not. Getting this wrong crops the
 * result to the old width and slices the picture.
 * @param size - the original size.
 * @param degrees - rotation in degrees (any multiple of 90).
 * @returns the size after rotation.
 */
export function rotatedSize(size: Size, degrees: number): Size {
  // JavaScript keeps the sign of the left operand: -90/90 % 4 is -1, not 3, so a
  // plain modulo would treat 「左转」 as no rotation at all.
  const quarter = ((Math.round(degrees / 90) % 4) + 4) % 4
  const swapped = quarter === 1 || quarter === 3
  return swapped ? { w: size.h, h: size.w } : { w: size.w, h: size.h }
}

/**
 * Force a rectangle to an aspect ratio, keeping its centre.
 *
 * Ratio presets (1:1, 16:9) are how people actually crop; doing it by dragging
 * pixels is guesswork.
 * @param rect - the current rectangle.
 * @param aspect - width ÷ height to enforce.
 * @param bounds - the picture's size.
 * @returns the adjusted rectangle, clamped inside the picture.
 */
export function fitAspect(rect: Rect, aspect: number, bounds: Size): Rect {
  if (!Number.isFinite(aspect) || aspect <= 0) return clampRect(rect, bounds)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  // Start from the width we have, then shrink to fit each axis in turn. Two
  // passes are enough: the first can only push the height over the edge, and
  // fixing that can only make the width smaller, never larger again.
  let w = Math.min(rect.w, bounds.w)
  let h = w / aspect
  if (h > bounds.h) {
    h = bounds.h
    w = h * aspect
  }
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, bounds)
}

/** Whether a rectangle is big enough to be worth applying. */
export function isUsable(rect: Rect): boolean {
  return rect.w >= 8 && rect.h >= 8
}
