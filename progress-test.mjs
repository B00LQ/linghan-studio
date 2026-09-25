/**
 * 生成进度与预计时间的文案验收（纯函数，不需要浏览器）。
 *
 * 用法: node progress-test.mjs
 *
 * 这些字符串是用户在按钮旁边直接看到的东西，所以按「人会怎么读」来断言：
 * 有步进就报步进、没有就报生成中、有历史就报预计几秒、估算用完就如实报已用多久，
 * 而不是显示负数或者 0 秒。
 */
import { describeProgress } from './apps/web/src/canvas/progress.ts'

let failures = 0
const log = (...a) => console.log('[progress]', ...a)
const check = (label, condition, detail = '') => {
  log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

const base = { running: true, progress: null, estimateMs: 6000, elapsedMs: 0 }

log('① 空闲：只报历史估计')
check('有历史时给出约几秒', describeProgress({ ...base, running: false }).text === '约 6 秒', describeProgress({ ...base, running: false }).text)
check('没有历史时不编造', describeProgress({ ...base, running: false, estimateMs: 0 }).text === '')
check('空闲时没有进度条', describeProgress({ ...base, running: false }).fraction === null)

log('② 有步进：报步数 + 预计剩余')
const stepping = describeProgress({ ...base, progress: { value: 3, max: 12, stage: 'sampling' }, elapsedMs: 2000 })
check('文案含 3/12 步', stepping.text.includes('3/12 步'), stepping.text)
check('文案含预计剩余', stepping.text.includes('预计 4 秒'), stepping.text)
check('进度条比例正确', stepping.fraction === 0.25, String(stepping.fraction))

log('③ 没有步进：说生成中，但仍然给 ETA')
const blind = describeProgress({ ...base, progress: { stage: 'sampling' }, elapsedMs: 2000 })
check('驱动没报数字时不显示步数', !blind.text.includes('步'), blind.text)
check('仍然显示生成中', blind.text.includes('生成中'), blind.text)
check('仍然显示预计剩余', blind.text.includes('预计 4 秒'), blind.text)
check('没有进度条可填', blind.fraction === null)

// 这条是「刷新之后只剩『生成中』」那次 bug 的回归。
//
// 从前显示步数还要过一道闸门：supportsSteps，来自挂载时**只取一次**的驱动能力查询。
// 那一次请求撞上服务重启就失败，于是整页会话都认定「这个驱动不报步数」——服务端每一步
// 都在推，卡片上却只有「生成中」。现在步数只认数据：说「不支持」的调用方也挡不住已经
// 送到的数字。
log('③b 步数由数据说了算，能力标记无权否决')
const ignoreFlag = describeProgress({ ...base, supportsSteps: false, progress: { value: 3, max: 12 } })
check('明说「不支持步进」也照样报步数', ignoreFlag.text.includes('3/12 步'), ignoreFlag.text)
check('进度条也照样有', ignoreFlag.fraction === 0.25, String(ignoreFlag.fraction))

log('④ 排队与保存要分得清')
check('排队阶段说排队中', describeProgress({ ...base, progress: { stage: 'queued' } }).text.includes('排队中'))
check('保存阶段说保存中', describeProgress({ ...base, progress: { stage: 'saving' } }).text.includes('保存中'))

log('⑤ 一批多张：报第几张')
const batch = describeProgress({ ...base, progress: { value: 4, max: 10, stage: 'sampling', image: 2, images: 4 }, elapsedMs: 1000 })
check('文案含第 2/4 张', batch.text.includes('第 2/4 张'), batch.text)
check('单张时不啰嗦', !describeProgress({ ...base, progress: { image: 1, images: 1 } }).text.includes('张'))

log('⑥ 超时：不显示负数，也不显示 0 秒，更不许诺「即将完成」')
const overrun = describeProgress({ ...base, progress: { value: 20, max: 20 }, elapsedMs: 30_000 })
check('剩余时间为 0 而不是负数', overrun.remainingMs === 0, String(overrun.remainingMs))
// 从前这里写「即将完成」。一条 12 GB 卡上的视频可以超时十分钟，那四个字就是假话；
// 现在改说事实：已经跑了多久。
check('不再说「即将完成」', !overrun.text.includes('即将完成'), overrun.text)
check('改说已经用了多久', overrun.text.includes('已用 30 秒'), overrun.text)
// 「0 秒」要作为**独立数值**不出现；从前写成 /0 秒/ 太松，
// 「已用 30 秒」里的「0 秒」也算命中（这条是改了文案之后才暴露的假失败）。
check('没有 0 秒这种说法', !/(?<!\d)0 秒/u.test(overrun.text), overrun.text)
// 长活儿（10 分钟的片）要说成分，不能报「已用 632 秒」。
const longRun = describeProgress({ ...base, progress: { value: 6, max: 8 }, elapsedMs: 632_000 })
check('长活儿按分报', longRun.text.includes('已用 10 分 32 秒'), longRun.text)
check('长活儿也不再提预计（估算早用完了）', !longRun.text.includes('预计'), longRun.text)

log('⑦ 没有历史估计时不编造剩余时间')
const unknown = describeProgress({ ...base, estimateMs: 0, progress: { value: 1, max: 10 }, elapsedMs: 500 })
check('剩余时间为 null', unknown.remainingMs === null)
check('文案不含预计', !unknown.text.includes('预计'), unknown.text)
check('但仍然报步数', unknown.text.includes('1/10 步'), unknown.text)

log('⑧ 边界：max 为 0 或缺失时不能除零')
check('max=0 不产生进度条', describeProgress({ ...base, progress: { value: 1, max: 0 } }).fraction === null)
check('只有 value 不产生进度条', describeProgress({ ...base, progress: { value: 5 } }).fraction === null)

log(failures === 0 ? '\n全部通过' : `\n有 ${String(failures)} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
