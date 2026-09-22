/**
 * 布局算法单测（两种节点的模型）。
 *
 * 用法: node layout-test.mjs
 *
 * layout.ts 只 `import type` 了 @xyflow/react，所以类型导入会被抹掉，
 * Node 的 TS 剥离能直接跑它——不需要为了测试再搭一套构建。
 *
 * 最重要的一条是「无重叠」：它是「布局混乱」这个抱怨的可判定形式。
 */
import { arrangeLayout, findFreeSlot, findOverlaps, footprintOf } from './apps/web/src/canvas/layout.ts'

let failures = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

/** Build a node the way the canvas does. */
const node = (id, kind, x, y) => ({ id, type: 'studio', position: { x, y }, data: { kind } })

console.log('=== 放置：找空位而不是固定偏移 ===')
check('空画布用首选位置', JSON.stringify(findFreeSlot([], { x: 100, y: 100 }, 'text')) === JSON.stringify({ x: 100, y: 100 }))

const occupied = [node('t1', 'text', 100, 100)]
const second = findFreeSlot(occupied, { x: 100, y: 100 }, 'text')
check('首选位置被占时让开', findOverlaps([...occupied, node('t2', 'text', second.x, second.y)]).length === 0,
  `落点 (${second.x},${second.y})`)

// 这一条对应真实 bug：同一个节点连续生成时，画面节点曾被放在完全相同坐标
let cursor = [node('i0', 'image', 460, 0)]
const placed = []
for (let i = 0; i < 5; i += 1) {
  const slot = findFreeSlot(cursor, { x: 460, y: 0 }, 'image')
  const created = node(`i${i + 1}`, 'image', slot.x, slot.y)
  placed.push(created)
  cursor = [...cursor, created]
}
check('连续 5 张画面互不重叠', findOverlaps(cursor).length === 0)
check('连续 5 张画面坐标各不相同', new Set(placed.map((n) => `${n.position.x},${n.position.y}`)).size === 5,
  placed.map((n) => `(${n.position.x},${n.position.y})`).join(' '))

console.log('\n=== 整理：把真实脏数据排干净 ===')
// 复刻线上那份乱画布：坐标完全相同的节点对
const messy = [
  node('text-a', 'text', 0, 0),
  node('text-b', 'text', 0, 0),      // 与上一个完全重叠
  node('image-a', 'image', 460, 0),
  node('image-b', 'image', 460, 0),  // 又一组完全重叠
  node('image-c', 'image', 240, 200),
]
const before = findOverlaps(messy).length
check('脏数据确实有重叠（前置条件）', before > 0, `${before} 处`)

const tidy = arrangeLayout(messy)
const after = findOverlaps(tidy)
check('整理后零重叠', after.length === 0, after.length === 0 ? '' : JSON.stringify(after.slice(0, 4)))

const twice = arrangeLayout(tidy)
check('整理是幂等的（再点一次不会乱跑）',
  JSON.stringify(tidy.map((n) => n.position)) === JSON.stringify(twice.map((n) => n.position)))

console.log('\n=== 整理后仍然可读：两列 ===')
const pos = (id) => tidy.find((n) => n.id === id).position
check('文本在左列', pos('text-a').x === 0 && pos('text-b').x === 0)
check('图片在右列', pos('image-a').x > pos('text-a').x && pos('image-b').x === pos('image-a').x)
check('同列节点竖向排开', pos('text-a').y !== pos('text-b').y && pos('image-a').y !== pos('image-b').y,
  `文本 ${pos('text-a').y}/${pos('text-b').y} 图片 ${pos('image-a').y}/${pos('image-b').y}`)
check('所有节点都被安排（数量不变）', tidy.length === messy.length)

console.log('\n=== 尺寸假定 ===')
const fp = ['text', 'image'].map((k) => `${k}=${footprintOf(k).w}x${footprintOf(k).h}`)
check('两种节点都有明确的占位尺寸', fp.length === 2, fp.join(' '))
check('未知类型退回文本节点尺寸', footprintOf('nonsense').w === footprintOf('text').w)
check('图片比文本高（画面是方的）', footprintOf('image').h > footprintOf('text').h)

console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
