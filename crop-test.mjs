/**
 * 裁剪/旋转的算术单测。
 *
 * 用法: node crop-test.mjs
 *
 * crop.ts 不碰 DOM，所以能直接在 Node 里跑。这里挑的每一条都对应一个
 * 「画面上看不出来但结果是错的」的情况：反向拖拽、越界的裁剪框、
 * 旋转后宽高没换、比例预选框比原图还大。
 */
import { clampRect, fitAspect, isUsable, normalizeRect, rotatedSize } from './apps/web/src/canvas/crop.ts'

let failures = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const PICTURE = { w: 1024, h: 1024 }

console.log('=== 拖拽方向：左上拖和右下拖必须一样 ===')
const downRight = normalizeRect({ x: 100, y: 100 }, { x: 400, y: 300 })
const upLeft = normalizeRect({ x: 400, y: 300 }, { x: 100, y: 100 })
check('右下拖得到正尺寸', downRight.w === 300 && downRight.h === 200, JSON.stringify(downRight))
check('左上拖结果完全相同', JSON.stringify(downRight) === JSON.stringify(upLeft))
// 负宽度会让 drawImage 画出一片空白——用户看到的是「裁剪之后什么都没有」
check('宽度永远是正的', normalizeRect({ x: 500, y: 500 }, { x: 100, y: 500 }).w === 400)
check('高度永远是正的', normalizeRect({ x: 500, y: 500 }, { x: 500, y: 100 }).h === 400)

console.log('\n=== 越界：裁剪框不能跑到画面外面 ===')
const outside = clampRect({ x: 900, y: 900, w: 400, h: 400 }, PICTURE)
check('右下越界被拉回', outside.x + outside.w <= PICTURE.w && outside.y + outside.h <= PICTURE.h,
  JSON.stringify(outside))
const negative = clampRect({ x: -50, y: -80, w: 200, h: 200 }, PICTURE)
check('负坐标被拉回 0', negative.x === 0 && negative.y === 0)
const bigger = clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, PICTURE)
check('比原图大就缩到原图', bigger.w === PICTURE.w && bigger.h === PICTURE.h)
const tiny = clampRect({ x: 10, y: 10, w: 0, h: 0 }, PICTURE)
check('零尺寸不会变成 0 宽（否则导出失败）', tiny.w >= 1 && tiny.h >= 1, JSON.stringify(tiny))
check('裁剪框整数化（canvas 不接受小数）',
  Object.values(clampRect({ x: 1.6, y: 2.4, w: 100.5, h: 99.5 }, PICTURE)).every(Number.isInteger))

console.log('\n=== 旋转：90/270 必须换宽高 ===')
const wide = { w: 1280, h: 720 }
check('不旋转尺寸不变', JSON.stringify(rotatedSize(wide, 0)) === JSON.stringify(wide))
check('180 度尺寸不变', JSON.stringify(rotatedSize(wide, 180)) === JSON.stringify(wide))
check('90 度换成竖的', rotatedSize(wide, 90).w === 720 && rotatedSize(wide, 90).h === 1280,
  JSON.stringify(rotatedSize(wide, 90)))
check('270 度也是竖的', JSON.stringify(rotatedSize(wide, 270)) === JSON.stringify(rotatedSize(wide, 90)))
check('360 度回到原样', JSON.stringify(rotatedSize(wide, 360)) === JSON.stringify(wide))
// 连续两次 90 度等于一次 180 度：这是「连点两下看起来没歪」的依据
check('负数角度也认（左转）', JSON.stringify(rotatedSize(wide, -90)) === JSON.stringify(rotatedSize(wide, 90)))

console.log('\n=== 比例预设：1:1 和 16:9 ===')
const square = fitAspect({ x: 300, y: 300, w: 400, h: 200 }, 1, PICTURE)
check('1:1 真的是正方形', Math.abs(square.w - square.h) <= 1, `${square.w}x${square.h}`)
check('1:1 保持在画面内', square.x >= 0 && square.y >= 0 && square.x + square.w <= PICTURE.w)
check('1:1 中心没跑（围绕原选区中心）', Math.abs(square.x + square.w / 2 - 500) <= 1)
const film = fitAspect({ x: 0, y: 0, w: 1024, h: 1024 }, 16 / 9, PICTURE)
check('16:9 比例正确', Math.abs(film.w / film.h - 16 / 9) < 0.02, `${film.w.toFixed(0)}x${film.h.toFixed(0)}`)
check('16:9 不超出画面宽', film.w <= PICTURE.w)
const portrait = fitAspect({ x: 0, y: 0, w: 1024, h: 1024 }, 9 / 16, PICTURE)
check('9:16 比例正确', Math.abs(portrait.w / portrait.h - 9 / 16) < 0.02, `${portrait.w.toFixed(0)}x${portrait.h.toFixed(0)}`)
check('非法比例不炸', fitAspect({ x: 0, y: 0, w: 100, h: 100 }, 0, PICTURE).w === 100)

console.log('\n=== 可用性判断 ===')
check('整张画面可用', isUsable(PICTURE))
check('误点出来的一两像素不算', !isUsable({ x: 0, y: 0, w: 3, h: 300 }))

console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
