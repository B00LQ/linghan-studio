/**
 * 生成进度与预计时间验收。
 *
 * 用法: node generation-progress-test.mjs <baseUrl> <password>
 *
 * 这件事的价值全在「人盯着按钮旁边那几秒」上，所以断言必须来自真实出图过程：
 * 跑起来要报步数、进度条要真的在长、跑完要回到空闲文案。
 * 只查 DOM 里有没有那个元素是证明不了任何事情的。
 *
 * **代价：真出图两次**（ComfyUI 热态各约 6 秒）。第二次是必要的——
 * 「预计时间」来自本机历史耗时，只有先跑一次、再跑一次，
 * 才能证明这个数字是**学来的**而不是写死的。冷启动（没有任何历史）时
 * 那一次也顺便验证了另一条规则：没有历史就不编造估计。
 */
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('progress')

const node = (id, kind, x, y, extra = {}) => ({ id, type: 'studio', position: { x, y }, data: { kind, ...extra } })

/** What the run row currently says, plus the bar's fill fraction. Null when absent. */
const runRow = (session) => session.evaluate(`(() => {
  const row = document.querySelector('.prompt-window .run-row');
  if (!row) return null;
  const bar = row.querySelector('.run-bar > i');
  return {
    text: (row.querySelector('.run-text')?.textContent || '').trim(),
    running: row.classList.contains('is-running'),
    width: bar === null ? null : Math.round(parseFloat(bar.style.width || '0')),
  };
})()`)

/** Poll until a probe yields something truthy. */
const until = async (probe, timeoutMs = 10_000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(250)
  }
}

/** Click generate and sample the row every 150 ms until the run finishes. */
const runOnce = async (s, budgetMs = 90_000) => {
  const startedAt = Date.now()
  check('点了生成按钮', await s.clickSelector('.prompt-window .send'))
  const samples = []
  for (let i = 0; i < 600; i += 1) {
    await sleep(150)
    const sample = await runRow(s)
    if (sample !== null) samples.push({ ...sample, at: Date.now() - startedAt })
    if (samples.some((item) => item.running) && sample !== null && !sample.running) break
    if (Date.now() - startedAt > budgetMs) break
  }
  return samples
}

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  check('API 已登录', api.cookie !== '')

  log('① 服务端：进度能力是协商出来的，不是写死的')
  const stats = (await api.call('/api/generation/stats')).json
  check('统计接口可用', typeof stats.driver === 'string', JSON.stringify(stats).slice(0, 140))
  check('驱动声明了进度能力', stats.capabilities?.progress === 'steps' || stats.capabilities?.progress === 'none', String(stats.capabilities?.progress))
  check('当前驱动（ComfyUI）声明支持步进', stats.capabilities?.progress === 'steps', String(stats.capabilities?.progress))
  const samples0 = stats.estimate?.samples ?? 0
  const median0 = stats.estimate?.medianMs ?? 0
  const hadHistory = samples0 > 0 && median0 > 0
  log(`   开跑前历史样本：${String(samples0)} 个，中位 ${String(median0)} ms ${hadHistory ? '' : '（冷启动：这一次要验证「不编造估计」）'}`)
  check('样本数与中位数一致（有样本就必须给出中位数）', (samples0 === 0) === (median0 === 0), `samples=${String(samples0)} median=${String(median0)}`)

  const project = await api.createProject(`进度验收 ${STAMP}`)
  const projectId = project.project.id
  await api.putCanvas(projectId, {
    nodes: [node('image-a', 'image', 0, 0, { text: '雨夜的便利店门口，暖色灯箱，胶片颗粒' })],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  })

  const s = await startSession({ port: 9251, width: 1500, height: 900 })
  await s.login(BASE, PASSWORD)
  await s.goto(`${BASE}/canvas/${projectId}`, 4500)

  log('② 空闲时的诚实行为：有历史就给估计，没历史就不编')
  await s.clickSelector('.react-flow__node[data-id="image-a"] .studio-node')
  await sleep(1200)
  const idle = await runRow(s)
  if (hadHistory) {
    check('窗口里有进度行', idle !== null, JSON.stringify(idle))
    check('空闲文案是「约 N 秒」', idle !== null && /^约 \d+ 秒$/u.test(idle.text), idle?.text ?? '')
    check('空闲时不显示进度条', idle?.width === null, String(idle?.width))
    check('空闲时不是运行样式', idle?.running === false)
  } else {
    // 没有历史却说得出「约 N 秒」，那就是编的。
    check('没有历史时不编造估计', idle === null || idle.text === '', JSON.stringify(idle))
    log('   （冷启动：这一条断言的是「宁可什么都不说」）')
  }

  log('③ 第一次生成：跑起来必须报步数与进度（真出图一次）')
  const first = await runOnce(s)
  const firstRunning = first.filter((item) => item.running)
  const distinct = [...new Set(firstRunning.map((item) => item.text))]
  log(`   采样 ${String(first.length)} 次，其中运行中 ${String(firstRunning.length)} 次`)
  check('捕捉到了运行中的状态', firstRunning.length > 0, JSON.stringify(first.slice(0, 2)))
  check('运行文案含步数（真步进，不是假进度）', firstRunning.some((item) => /\d+\/\d+ 步/u.test(item.text)), distinct.join(' | '))
  const withBar = firstRunning.filter((item) => item.width !== null)
  check('有步进时出现进度条', withBar.length > 0, `${String(withBar.length)} 次带进度条`)
  check('进度条确实在前进', withBar.length >= 2 && (withBar[withBar.length - 1].width ?? 0) > (withBar[0].width ?? 0),
    withBar.map((item) => `${String(item.width)}%`).join(' -> '))
  check('进度不会超过 100%', withBar.every((item) => (item.width ?? 0) <= 100), withBar.map((item) => String(item.width)).join(','))
  if (hadHistory) {
    check('有历史时运行文案含预计时间', firstRunning.some((item) => item.text.includes('预计') || item.text.includes('即将完成')), distinct.join(' | '))
  }

  log('④ 出图本身成功了（否则上面那些都只是动画）')
  // 画布是防抖保存的，所以要等它写到服务端，而不是睡固定时长。
  const shotId = await until(async () => {
    const doc = (await api.call(`/api/projects/${projectId}/canvas`)).json.doc
    const id = (doc?.nodes ?? []).find((n) => n.id === 'image-a')?.data?.shotId ?? ''
    return id === '' ? null : id
  })
  check('节点记下了自己的生成历史', shotId !== null, String(shotId ?? '还没保存').slice(0, 8))
  if (shotId === null) {
    s.kill()
    log(`\n有 ${String(failures())} 项未通过`)
    process.exit(1)
  }
  const history = (await api.call(`/api/shots/${shotId}/takes`)).json.takes ?? []
  check('历史里有一次成功的尝试', history.some((take) => take.status === 'succeeded'), JSON.stringify(history.map((t) => t.status)))
  check('这次尝试记了耗时（ETA 的数据就是它）', history.some((take) => typeof take.latencyMs === 'number' && take.latencyMs > 0),
    JSON.stringify(history.map((t) => t.latencyMs)))

  log('⑤ 重载后：ETA 是用刚跑出来的数据算的（证明它是学来的，不是写死的）')
  await s.goto(`${BASE}/canvas/${projectId}`, 4500)
  await s.clickSelector('.react-flow__node[data-id="image-a"] .studio-node')
  await sleep(1200)
  const afterReload = await runRow(s)
  check('现在空闲文案给出「约 N 秒」', afterReload !== null && /^约 \d+ 秒$/u.test(afterReload.text), afterReload?.text ?? '没有进度行')
  const stats2 = (await api.call('/api/generation/stats')).json
  /**
   * 「ETA 是学来的」这条判据不能写成「样本数变多了」。
   *
   * 统计只读**最近 20 条** take（这是有意的：预计时间该跟着最近的机器状态走，
   * 而不是被三个月前的数据拖住），所以样本数到 20 就到顶了 —— 库里攒够之后，
   * `samples` 会一直是 20，那条断言就永远红着（它并不是「刚修好的功能坏了」）。
   * 真正要证的是「刚跑出来的那一次**进了**统计」，所以判据落在最近样本的第一条上。
   */
  const newestTake = ((await api.call(`/api/shots/${shotId}/takes`)).json.takes ?? [])
    .find((take) => take.status === 'succeeded' && typeof take.latencyMs === 'number')
  const recent = stats2.estimate?.recentMs ?? []
  check('刚跑出来的那一次真的进了统计（不是读的旧数据）',
    newestTake !== undefined && recent[0] === newestTake.latencyMs,
    `最近样本 ${JSON.stringify(recent.slice(0, 3))} vs 本次 ${String(newestTake?.latencyMs)}`)
  check('中位数落在刚才那次耗时的量级上', (stats2.estimate?.medianMs ?? 0) > 500, `${String(stats2.estimate?.medianMs ?? 0)} ms`)

  log('⑥ 有历史之后再生成一次：运行中就要报预计剩余')
  const second = await runOnce(s)
  const secondRunning = second.filter((item) => item.running)
  const distinct2 = [...new Set(secondRunning.map((item) => item.text))]
  check('第二次也捕捉到运行中', secondRunning.length > 0, JSON.stringify(second.slice(0, 2)))
  check('运行文案含步数', secondRunning.some((item) => /\d+\/\d+ 步/u.test(item.text)), distinct2.join(' | '))
  check('运行文案含预计时间', secondRunning.some((item) => item.text.includes('预计') || item.text.includes('即将完成')), distinct2.join(' | '))

  log('⑦ 跑完回到空闲文案（不留一个卡住的进度条）')
  const settled = await until(async () => {
    const row = await runRow(s)
    return row !== null && !row.running ? row : null
  })
  check('回到非运行状态', settled?.running === false, JSON.stringify(settled))
  check('回到「约 N 秒」', settled !== null && /^约 \d+ 秒$/u.test(settled.text), settled?.text ?? '')
  check('进度条已消失', settled?.width === null, String(settled?.width))

  log('⑧ 用这一版的参数再跑一次（债务第 21 条：重拍 / 重试）')
  // 这一节**真点一次**「复现这一版」，因为它要验的正是客户端怎么组装那个请求：
  // 参数漏了哪一项、种子忘了带，都只在点下去之后才看得出来。代价是多出一次图（约 6 秒）。
  const before = (await api.call(`/api/shots/${shotId}/takes`)).json.takes ?? []
  const shown = before[0] ?? null
  const rerunButton = await s.evaluate(`(() => {
    const el = document.querySelector('[data-testid="rerun-take"]');
    return el === null ? null : { label: (el.textContent || '').trim(), title: el.title || '', disabled: el.disabled };
  })()`)
  check('版本条下面出现了「复现这一版」', rerunButton !== null && rerunButton.label.includes('复现'), JSON.stringify(rerunButton))
  check('提示里说清了是「同参数同种子」', (rerunButton?.title ?? '').includes('种子'), rerunButton?.title ?? '')
  if (rerunButton !== null) {
    await s.clickSelector('[data-testid="rerun-take"]')
    const regenerated = await until(async () => {
      const takes = (await api.call(`/api/shots/${shotId}/takes`)).json.takes ?? []
      return takes.length > before.length ? takes : null
    }, 120_000)
    check('重跑落在**同一条版本线**上（不是另起一条）',
      regenerated !== null && regenerated.length === before.length + 1,
      `${String(before.length)} -> ${String(regenerated?.length ?? 0)} 版`)
    const fresh = regenerated?.[0]
    check('新版本的种子与那一版相同（这才叫复现，不是再抽一次）',
      fresh?.seed !== undefined && fresh.seed === shown?.seed,
      `旧 ${String(shown?.seed)} / 新 ${String(fresh?.seed)}`)
    check('新版本的提示词与那一版相同',
      fresh?.params?.prompt === shown?.params?.prompt,
      JSON.stringify({ old: shown?.params?.prompt, fresh: fresh?.params?.prompt }).slice(0, 120))
    check('新版本的工作流与那一版相同',
      fresh?.params?.workflow === shown?.params?.workflow,
      `${String(shown?.params?.workflow)} -> ${String(fresh?.params?.workflow)}`)
  }

  log('⑨ 版本格上要看得出「这一版是几步、哪套工作流、多久出的」（债务第 19 条）')
  // 数据一直在 take 的 `params.workflow` 里，缺的只是把它说出来。这一节查的就是那几句话：
  // 悬停说明 + 格子上那个步数角标（步数是版本之间最实在的差别之一）。
  const cell = await s.evaluate(`(() => {
    const cells = [...document.querySelectorAll('.prompt-window .history-cell')];
    const last = cells[cells.length - 1];
    return last === undefined ? null : {
      count: cells.length,
      title: last.title || '',
      steps: [...last.querySelectorAll('[data-testid="cell-steps"]')].map((el) => (el.textContent || '').trim()),
    };
  })()`)
  check('版本条上有格子', (cell?.count ?? 0) > 0, JSON.stringify(cell))
  check('悬停说明里有工作流与耗时', /版 · .+ · /u.test(cell?.title ?? ''), cell?.title ?? '')
  check('悬停说明里说了这套是几步', /步/u.test(cell?.title ?? ''), cell?.title ?? '')
  check('格子上直接印着步数角标', (cell?.steps ?? []).some((text) => /^\d+步$/u.test(text)), JSON.stringify(cell?.steps))
  // 下拉也要说得出速度差别：标题后面接「几步」与「本机约 N 分」（有样本时）。
  const option = await s.evaluate(`(() => {
    const select = document.querySelector('.prompt-window select.workflow-select');
    if (select === null) return null;
    const chosen = select.options[select.selectedIndex];
    return { count: select.options.length, label: chosen?.textContent || '', hint: chosen?.title || '' };
  })()`)
  check('工作流下拉里带着步数', /步/u.test(option?.label ?? ''), option?.label ?? '')
  // 「本机约 N」只有在**这台机器跑过这套工作流**时才该出现 —— 没有样本时宁可不说。
  // 所以这条判据跟着服务端的统计走，而不是硬要求它一定在。
  const estimate = (await api.call('/api/generation/stats')).json?.estimate ?? {}
  const buckets = Object.keys(estimate.byWorkflow ?? {})
  check(buckets.length > 0 ? '有样本时下拉里会说「本机约多久」' : '没有样本时下拉里不编时间',
    buckets.length > 0 ? /本机约/u.test(option?.label ?? '') : !/本机约/u.test(option?.label ?? ''),
    `${buckets.join(',') || '（还没有样本）'} → ${option?.label ?? ''}`)
  check('悬停说明里讲了步数的取舍', (option?.hint ?? '').length > 0, (option?.hint ?? '').split('\n')[0] ?? '')

  check('全程没有 JS 报错', s.consoleErrors.length === 0, s.consoleErrors.slice(0, 2).join(' | '))
  await s.shot('generation-progress.png')
  s.kill()

  log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[progress] 失败:', error); process.exit(1) })
