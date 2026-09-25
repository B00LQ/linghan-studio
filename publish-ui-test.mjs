/**
 * 「发布到主页」对话框的验收（M3，界面侧）。
 *
 * 用法: node publish-ui-test.mjs [baseUrl] [password]
 *
 * 为什么单独一条：发布这条路的**服务端**已经有 works-test.mjs 逐条钉住了，
 * 但界面上的对话框没人验过。这里只钉四件在浏览器里才算数的事：
 *
 * 1. 批量条上真的有「发布到主页」这个入口（不是只有代码里存在）；
 * 2. 点开之后对话框出现，字段齐全；
 * 3. 文案里**没有字面的 `**`**（Markdown 写到 JSX 里会原样显示，这个坑踩过两次）；
 * 4. 「取消」真的关得掉。
 *
 * **故意不点提交**：这台机器可能已经绑了账号，点下去就是往真账号里发作品。
 * 「未绑定时的报错」由 works-test.mjs 在临时实例上验（那里没有真账号可伤）。
 */
import { apiSession, reporter, startSession } from './test-session.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'

const { check, log, failures } = reporter('publish-ui')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const api = await apiSession(BASE, PASSWORD)
const listed = await api.call('/api/assets')
check('素材接口可用（有东西可发布）', listed.ok && Array.isArray(listed.json.assets) && listed.json.assets.length > 0,
  `status=${String(listed.status)} count=${String(listed.json.assets?.length ?? 0)}`)

const session = await startSession({ port: 9286, width: 1500, height: 950 })
try {
  await session.login(BASE, PASSWORD)
  await session.goto(`${BASE}/assets`, 5000)

  const wallReady = await session.evaluate(`document.querySelectorAll('.asset-card').length > 0`)
  check('资产页出现卡片墙', wallReady === true)

  // 勾第一个（选择框，不是图——点图是放大预览）。
  await session.clickSelector('.asset-card .pick')
  await sleep(500)
  const batched = await session.evaluate(`document.querySelector('[data-testid=asset-batch]') !== null`)
  check('勾选后出现批量操作条', batched === true)

  const hasEntry = await session.evaluate(`document.querySelector('[data-testid=asset-publish]') !== null`)
  check('批量条上有「发布到主页」入口', hasEntry === true)

  await session.clickSelector('[data-testid=asset-publish]')
  await sleep(600)

  const panel = await session.evaluate(`(() => {
    const box = document.querySelector('[data-testid=publish-panel]');
    if (box === null) return null;
    return {
      text: box.innerText,
      title: document.querySelector('[data-testid=publish-title]')?.value ?? null,
      tags: document.querySelector('[data-testid=publish-tags]') !== null,
      canvas: document.querySelector('[data-testid=publish-canvas]') !== null,
      submit: document.querySelector('[data-testid=publish-submit]')?.innerText?.trim() ?? null,
    };
  })()`)
  check('对话框打开了', panel !== null)
  if (panel !== null) {
    check('标题有默认值（不用对着空框发呆）', typeof panel.title === 'string' && panel.title !== '', `title=${String(panel.title)}`)
    check('标签与画布选择都在', panel.tags === true && panel.canvas === true)
    check('按钮写的是「提交待审」而不是「已发布」', panel.submit === '提交待审', `submit=${String(panel.submit)}`)
    check('文案里没有字面的 **', !panel.text.includes('**'))
    check('文案明说「要管理员点通过」', panel.text.includes('通过'))
  }

  // 私密备份（M5）：勾上之后按钮与说明都要跟着变 ——
  // 一个勾选框如果不改变任何字，用户没法确认自己勾上的是什么意思。
  await session.clickSelector('[data-testid=publish-private]')
  await sleep(500)
  const priv = await session.evaluate(`(() => {
    const box = document.querySelector('[data-testid=publish-panel]');
    return {
      checked: document.querySelector('[data-testid=publish-private]')?.checked ?? null,
      submit: document.querySelector('[data-testid=publish-submit]')?.innerText?.trim() ?? null,
      text: box === null ? '' : box.innerText,
    };
  })()`)
  check('勾得上「只备份到我的账号」', priv.checked === true)
  check('按钮变成「存到我的云账号」', priv.submit === '存到我的云账号', `submit=${String(priv.submit)}`)
  check('说明改成「别人看不到」', priv.text.includes('别人看不到'))

  await session.clickText('取消')
  await sleep(500)
  const closed = await session.evaluate(`document.querySelector('[data-testid=publish-panel]') === null`)
  check('「取消」关得掉对话框', closed === true)

  const shot = await session.shot('publish-dialog.png')
  log(`截图: ${shot}`)
} finally {
  session.kill()
}

const total = failures()
log(total === 0 ? '全部通过' : `${String(total)} 项失败`)
process.exit(total === 0 ? 0 : 1)
