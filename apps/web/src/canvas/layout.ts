/**
 * Canvas layout.
 *
 * Two columns now, because there are two node kinds: prompts on the left,
 * pictures on the right. The previous version reserved a vertical "band" per
 * shot so that a shot's frames stayed together — that whole notion is gone with
 * the shot node, and with it the band arithmetic that used to be the trickiest
 * part of this file.
 *
 * Placement is a search for a free rectangle rather than a fixed offset: reusing
 * one coordinate for every generation is exactly how images ended up stacked on
 * top of each other, which read as "generate did nothing".
 */
import type { Node } from '@xyflow/react'

/** What one node needs on screen, in world units. */
export interface Footprint {
  /** Width. */
  w: number
  /** Height. */
  h: number
}

/** Footprints per kind; pictures are tall because the frame is square. */
const TEXT: Footprint = { w: 260, h: 150 }
const IMAGE: Footprint = { w: 320, h: 430 }

/** The footprint for a node kind. */
export function footprintOf(kind: string): Footprint {
  return kind === 'image' ? IMAGE : TEXT
}

/** A group is a frame around other nodes, not content: layout leaves it alone. */
export function isGroup(node: { data?: { kind?: unknown } }): boolean {
  return kindOf(node) === 'group'
}

/** Gap between siblings and between columns. */
const GAP_Y = 36
const GAP_X = 160

/** Column origins. */
const COLUMN = { text: 0, image: 460 }

/** A node as the layout code needs to see it. */
interface Placed {
  position: { x: number; y: number }
  data?: { kind?: unknown }
}

/** Read a node's kind defensively. */
function kindOf(node: { data?: { kind?: unknown } }): string {
  return typeof node.data?.kind === 'string' ? node.data.kind : ''
}

/** Rectangle for one node, using its kind's footprint. */
export function nodeRect(node: Placed): { x: number; y: number; w: number; h: number } {
  const size = footprintOf(kindOf(node))
  return { x: node.position.x, y: node.position.y, w: size.w, h: size.h }
}

/** Whether two rectangles overlap, allowing a shared margin. */
export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  margin = 0,
): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin
}

/**
 * Find a position near `preferred` where a node of `kind` collides with nothing.
 *
 * Scans downward in the same column first — that is where a reader expects the
 * next sibling — then moves right and retries.
 * @param nodes - nodes already on the canvas.
 * @param preferred - where the caller would like the node.
 * @param kind - node kind, which decides the footprint.
 * @returns a free position.
 */
export function findFreeSlot(nodes: Placed[], preferred: { x: number; y: number }, kind: string): { x: number; y: number } {
  const size = footprintOf(kind)
  const occupied = nodes.map(nodeRect)
  let x = preferred.x
  for (let column = 0; column < 8; column += 1) {
    let y = preferred.y
    for (let row = 0; row < 30; row += 1) {
      const candidate = { x, y, w: size.w, h: size.h }
      if (!occupied.some((rect) => rectsOverlap(candidate, rect, 12))) return { x, y }
      y += size.h + GAP_Y
    }
    x += size.w + GAP_X
  }
  return { x, y: preferred.y }
}

/** Every overlapping pair among the given nodes; empty means a clean layout. */
export function findOverlaps(nodes: ({ id: string } & Placed)[]): { a: string; b: string }[] {
  // A group frame unavoidably contains its children, so counting it as an
  // overlap would make a tidy canvas look broken.
  const content = nodes.filter((node) => !isGroup(node))
  const pairs: { a: string; b: string }[] = []
  for (let i = 0; i < content.length; i += 1) {
    const first = content[i]
    if (first === undefined) continue
    for (let j = i + 1; j < content.length; j += 1) {
      const second = content[j]
      if (second === undefined) continue
      if (rectsOverlap(nodeRect(first), nodeRect(second))) pairs.push({ a: first.id, b: second.id })
    }
  }
  return pairs
}

/**
 * Re-arrange every node into two readable columns.
 * @param nodes - current nodes.
 * @returns the same nodes with new positions.
 */
export function arrangeLayout<T extends Node>(nodes: T[]): T[] {
  const moved = new Map<string, { x: number; y: number }>()

  const stack = (list: T[], x: number, size: Footprint): number => {
    let y = 0
    for (const node of list) {
      moved.set(node.id, { x, y })
      y += size.h + GAP_Y
    }
    return y
  }

  const content = nodes.filter((node) => !isGroup(node))
  const texts = content.filter((node) => kindOf(node) !== 'image')
  const images = content.filter((node) => kindOf(node) === 'image')
  stack(texts, COLUMN.text, TEXT)
  stack(images, COLUMN.image, IMAGE)

  return nodes.map((node) => {
    const position = moved.get(node.id)
    return position === undefined ? node : { ...node, position }
  })
}

/**
 * Tidy only the given nodes, leaving the rest of the canvas where it is.
 *
 * A selection toolbar's 「整理这 N 个」 has to be local: re-arranging the whole
 * canvas because two nodes were selected would move work the operator had
 * deliberately placed. The group is packed into the same two-column shape,
 * anchored at the group's own top-left corner so it stays where they put it.
 * @param nodes - every node on the canvas.
 * @param ids - ids of the nodes to re-arrange.
 * @returns the same nodes with the selected ones repositioned.
 */
export function arrangeSubset<T extends Node>(nodes: T[], ids: string[]): T[] {
  const wanted = new Set(ids)
  const chosen = nodes.filter((node) => wanted.has(node.id) && !isGroup(node))
  if (chosen.length < 2) return nodes

  const anchorX = Math.min(...chosen.map((node) => node.position.x))
  const anchorY = Math.min(...chosen.map((node) => node.position.y))
  // Texts first, then pictures, so the group reads left-to-right like the canvas.
  const ordered = [
    ...chosen.filter((node) => kindOf(node) !== 'image'),
    ...chosen.filter((node) => kindOf(node) === 'image'),
  ]

  const moved = new Map<string, { x: number; y: number }>()
  const cursors: { text: number; image: number } = { text: anchorY, image: anchorY }
  for (const node of ordered) {
    const column: 'text' | 'image' = kindOf(node) === 'image' ? 'image' : 'text'
    const size = footprintOf(column)
    moved.set(node.id, { x: anchorX + COLUMN[column], y: cursors[column] })
    cursors[column] += size.h + GAP_Y
  }

  return nodes.map((node) => {
    const position = moved.get(node.id)
    return position === undefined ? node : { ...node, position }
  })
}
