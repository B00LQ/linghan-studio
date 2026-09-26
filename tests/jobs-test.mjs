/**
 * 渲染作业的生命周期验收。
 *
 * 用法: node tests/jobs-test.mjs [baseUrl] [password]
 *
 * 这条要证明的是「一次生成不再等于一个 HTTP 请求」到底成立不成立，所以每一条都
 * 对着一个具体承诺：
 *   - 提交**立刻**返回（11 分钟的活儿不能让人等 11 分钟才拿到 job id）
 *   - 没有浏览器开着，结果也会落进画布文档（否则刷新一下就白跑了）
 *   - 进度能被查到
 *   - 能取消，而且取消之后状态是「已取消」而不是一个红错误
 *   - 刷新后的页面能重新接上（`GET /api/jobs?projectId=` 就是在跑的那些）
 *
 * 用的是出图工作流（约 6-10 秒），不是视频 —— 队列的正确性与片子多长无关，
 * 而十几分钟一条的测试没法天天跑。视频那条在 video-e2e-test.mjs。
 */
import { apiSession, reporter, sleep } from './test-session.mjs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] ?? process.env.STUDIO_PASSWORD ?? ''
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('jobs')

/** Poll until a probe yields something truthy. */
const until = async (probe, timeoutMs = 60_000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(400)
  }
}

const cleanupSteps = []
const cleanup = async () => {
  for (const step of cleanupSteps.reverse()) {
    try { await step() } catch (error) { console.error('[jobs] 清理失败：', error) }
  }
}

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  check('API 已登录', api.cookie !== '')

  // 素材数是这次验收的**收尾判据**：作业跑出来的东西必须一张不剩。
  // 加这条之前，清理顺序写错让我每次跑都在库里多留两张，而用例自己全绿。
  const assetsBefore = ((await api.call('/api/assets')).json.assets ?? []).length

  log('① 造一张画布：一个图片节点（作业要把结果写回它）')
  const project = (await api.createProject(`作业验收 ${STAMP}`)).project
  cleanupSteps.push(() => api.call(`/api/projects/${project.id}?purge=1`, { method: 'DELETE' }))
  await api.putCanvas(project.id, {
    nodes: [{
      id: 'image-job',
      type: 'studio',
      position: { x: 0, y: 0 },
      data: { kind: 'image', text: '一只在窗台上的橘猫，午后侧光', url: '', size: '768x512', count: 1 },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  })

  log('② 提交必须立刻返回（这是整个功能的意义）')
  const submittedAt = Date.now()
  const submit = await api.call('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, nodeId: 'image-job', prompt: '一只在窗台上的橘猫，午后侧光', size: '768x512', count: 1 }),
  })
  const submitMs = Date.now() - submittedAt
  check('提交返回 202（不是 200：活儿没干完）', submit.status === 202, `HTTP ${String(submit.status)}`)
  const job = submit.json.job
  check('拿到了 job id', typeof job?.id === 'string' && job.id !== '', String(job?.id))
  // 出图要 6-10 秒；提交若超过 2 秒就说明它其实在等渲染。
  check('提交耗时远小于渲染耗时（< 2 秒）', submitMs < 2000, `${String(submitMs)}ms`)
  check('刚提交时状态是 queued 或 running', job?.status === 'queued' || job?.status === 'running', String(job?.status))
  check('返回体里带上请求（谁、哪张画布、哪个节点）',
    job?.request?.nodeId === 'image-job' && job?.request?.projectId === project.id, JSON.stringify(job?.request))

  log('③ 在跑的时候，列表里能查到它（刷新后的页面就是靠这个接上的）')
  const active = await api.call(`/api/jobs?projectId=${project.id}`)
  check('活动列表包含这个作业', (active.json.jobs ?? []).some((item) => item.id === job.id), JSON.stringify((active.json.jobs ?? []).map((j) => j.status)))
  /**
   * 清理按**出处**来，不按「记住的那一个 id」。
   *
   * 取消是尽力而为：如果渲染在取消到达之前就完成了，素材和 take 是**真的**存下来了
   * （取消只让这个作业报「已取消」）。所以把「这个画布所有镜头的所有 take 的素材」
   * 收掉，才能保证不收错、也不留残渣。这些镜头全是这个用例自己建的。
   *
   * **顺序是三步，一个都不能换：**
   *   ① 先读 take 拿到素材 id（画布一删，镜头级联消失，就再也查不出来了）；
   *   ② 再删画布（**否则素材删不掉**：作业运行器把产物的 url 写进了节点，
   *      服务端会以「还有画布在用这个素材」拒绝删除，409）；
   *   ③ 最后删素材。
   * 我在这里错了两次：第一次先删画布 → 读不到 take → 一张都没删到；
   * 第二次先删素材 → 被 409 挡住 → 每次留一张。
   */
  cleanupSteps.push(async () => {
    const assetIds = []
    try {
      const shots = (await api.call(`/api/projects/${project.id}/shots`)).json.shots ?? []
      for (const one of shots) {
        const takes = (await api.call(`/api/shots/${one.id}/takes`)).json.takes ?? []
        for (const take of takes) {
          if (typeof take.assetId === 'string' && take.assetId !== '') assetIds.push(take.assetId)
        }
      }
    } catch { /* 读不到就只删画布，别让清理本身抛出去 */ }
    await api.call(`/api/projects/${project.id}?purge=1`, { method: 'DELETE' })
    for (const assetId of assetIds) {
      const removed = await api.call(`/api/assets/${assetId}`, { method: 'DELETE' })
      if (!removed.ok) console.error(`[jobs] 素材 ${assetId.slice(0, 8)} 没删掉：HTTP ${String(removed.status)}`)
    }
  })

  log('④ 等它做完，并记录过程中是否查到过进度')
  let sawProgress = false
  const done = await until(async () => {
    const one = await api.call(`/api/jobs/${job.id}`)
    const current = one.json.job
    if (current?.progress !== undefined && current.progress !== null) sawProgress = true
    return current !== undefined && (current.status === 'succeeded' || current.status === 'failed') ? current : null
  }, 90_000)
  check('作业跑到了终态', done !== null, String(done?.status))
  check('成功（不是失败）', done?.status === 'succeeded', String(done?.error ?? ''))
  const file = done?.files?.[0]
  check('产出了一个素材', typeof file?.url === 'string' && file.url.startsWith('/api/assets/'), String(file?.url))
  check('记了 take', typeof file?.takeId === 'string' && file.takeId !== '', String(file?.takeId))
  check('带回了 shotId（画布要用它取版本条）', typeof done?.shotId === 'string' && done.shotId !== '', String(done?.shotId))
  check('带回了版本总数', typeof done?.takes === 'number' && done.takes >= 1, String(done?.takes))
  check('过程中查到过进度', sawProgress, sawProgress ? '' : '一次都没查到（进度只走了 SSE？那刷新后就看不到进度了）')

  log('⑤ 关键一条：没有浏览器开着，结果也写进了画布文档')
  const doc = (await api.call(`/api/projects/${project.id}/canvas`)).json.doc
  const node = doc?.nodes?.find((item) => item.id === 'image-job')
  check('节点的 url 是这次生成的产物', node?.data?.url === file?.url, `${String(node?.data?.url)} vs ${String(file?.url)}`)
  check('节点记了 takeId', node?.data?.takeId === file?.takeId, String(node?.data?.takeId))
  check('节点记了版本号', node?.data?.takeNumber === done?.takes, `${String(node?.data?.takeNumber)} vs ${String(done?.takes)}`)
  check('节点不再是 running 状态', node?.data?.status === 'idle', String(node?.data?.status))

  log('⑥ 结束的作业不再出现在活动列表里')
  const after = await api.call(`/api/jobs?projectId=${project.id}`)
  check('活动列表里没有它了', !(after.json.jobs ?? []).some((item) => item.id === job.id), JSON.stringify((after.json.jobs ?? []).map((j) => j.status)))

  log('⑦ 取消：再发一个，然后在它跑的时候取消')
  const second = (await api.call('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, nodeId: 'image-job', prompt: '一只在窗台上的橘猫，夜色', size: '768x512', count: 1 }),
  })).json.job
  check('第二个作业已提交', typeof second?.id === 'string', String(second?.id))
  // 立刻取消：这时它多半还在排队或刚起头。
  const cancelled = await api.call(`/api/jobs/${second.id}`, { method: 'DELETE' })
  check('取消被接受（200）', cancelled.status === 200, `HTTP ${String(cancelled.status)} ${JSON.stringify(cancelled.json).slice(0, 200)}`)
  const settled = await until(async () => {
    const one = await api.call(`/api/jobs/${second.id}`)
    const current = one.json.job
    return current !== undefined && (current.status === 'cancelled' || current.status === 'failed' || current.status === 'succeeded') ? current : null
  }, 60_000)
  check('最终状态是 cancelled（不是 failed）', settled?.status === 'cancelled', String(settled?.status))
  check('取消的原因如实写着', settled?.error === '已取消', String(settled?.error))

  log('⑧ 边角：已结束的作业取消会被拒、不存在的作业 404、缺字段 400')
  const again = await api.call(`/api/jobs/${second.id}`, { method: 'DELETE' })
  check('取消已结束的作业 → 409', again.status === 409, `HTTP ${String(again.status)}`)
  const missing = await api.call('/api/jobs/not-a-real-job-id')
  check('查不存在的作业 → 404 且说明原因', missing.status === 404 && String(missing.json.error).includes('重启'), JSON.stringify(missing.json))
  const bad = await api.call('/api/jobs', { method: 'POST', body: JSON.stringify({ projectId: project.id, nodeId: '', prompt: '' }) })
  check('缺 nodeId/prompt → 400', bad.status === 400, `HTTP ${String(bad.status)}`)
  const noProject = await api.call('/api/jobs', { method: 'POST', body: JSON.stringify({ projectId: 'nope', nodeId: 'x', prompt: 'y' }) })
  check('画布不存在 → 404', noProject.status === 404, `HTTP ${String(noProject.status)}`)

  /**
   * 取消是尽力而为：如果那次渲染在取消到达前已经完成，素材与 take 是**真的**存下来的，
   * 而它落地的时间可能比这个用例的清理还晚（实测就是这样漏掉一张素材）。
   * 所以清之前先等 GPU 真的空下来 —— 等一个**条件**，不是睡一个固定时长。
   */
  log('⑨ 等 ComfyUI 真正空下来再清理（否则在飞的那次渲染会在清完之后落地）')
  const comfy = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'
  const quiet = await until(async () => {
    try {
      const queue = await (await fetch(`${comfy}/queue`, { signal: AbortSignal.timeout(5000) })).json()
      return (queue.queue_running?.length ?? 0) === 0 && (queue.queue_pending?.length ?? 0) === 0
    } catch { return null }
  }, 120_000)
  check('GPU 已经空下来', quiet !== null, quiet === null ? '等了两分钟还在跑' : '')
  // 队列空了 ≠ 落盘完成：驱动还在轮询（间隔 1.2s）→ 取字节 → 写素材 → 记 take。
  // 「取消晚了一步」的那次渲染正卡在这一段，它的素材会在清理之后才出现。
  // 这里的状态不可直接观测，所以睡一个够长的固定时长 —— 代价 5 秒，换来收尾干净。
  await new Promise((resolve) => setTimeout(resolve, 5000))
  // 取消晚了一步的话，服务端会明说结果留下了，而不是让人以为凭空多出一张。
  if (settled?.files !== undefined && settled.files.length > 0) {
    check('取消晚了一步时，如实说明结果留下了', typeof settled.note === 'string' && settled.note.includes('留下了'), String(settled.note))
  }

  await cleanup()
  check('验收画布已清理', (await api.call('/api/projects')).json.projects.every((item) => item.id !== project.id))
  const assetsAfter = ((await api.call('/api/assets')).json.assets ?? []).length
  check('作业产出的素材一张不剩', assetsAfter === assetsBefore, `${String(assetsBefore)} -> ${String(assetsAfter)}`)

  console.log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch(async (error) => {
  console.error('[jobs] 崩了：', error)
  await cleanup()
  process.exit(1)
})
