/**
 * 工作流库验收。
 *
 * 用法: node workflow-library-test.mjs <baseUrl> <password>
 *
 * 这件事的成败只有一条标准：**自己上传的一套工作流，能不能真的出一张图。**
 * 所以这套用例不只是「存进去了、列出来了」——最后一步是用上传的工作流
 * 走一次真实生成，并且断言那次生成用的是新工作流（换了模型/采样器就看得出来）。
 *
 * 用的图是内置 z-image 工作流的**改写版**：换掉模型文件名、插一个 LoraLoader、
 * 步数改成 12。它需要的模型本机没有，所以顺便验证「缺模型会提前告警」。
 */
import { apiSession, reporter, sleep, startSession } from './test-session.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8080'
const PASSWORD = process.argv[3] || process.env.STUDIO_PASSWORD || 'studio-demo-2026'
const PORT = Number(process.env.CDP_PORT || 9259)
const STAMP = new Date().toISOString().slice(11, 19)
const { log, check, failures } = reporter('workflows')

/** Poll until a probe yields something truthy. */
const until = async (probe, timeoutMs = 15_000) => {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(250)
  }
}

/** The built-in graph, so the fixture is a real workflow rather than a sketch. */
const baseGraph = async (api) => {
  const listed = (await api.call('/api/workflows')).json.workflows
  const builtIn = listed.find((workflow) => workflow.builtIn)
  // 服务端不吐整张图（列表只给摘要），所以从内置那份读回来。
  const raw = await fetch(`${BASE}/api/workflows`, { headers: { cookie: api.cookie } })
  return { listed, builtIn, raw: await raw.text() }
}

const run = async () => {
  const api = await apiSession(BASE, PASSWORD)
  check('API 已登录', api.cookie !== '')

  log('① 内置工作流在列表里，并且是「可以调用」的')
  const listed = (await api.call('/api/workflows')).json.workflows ?? []
  check('列表非空', listed.length >= 1, JSON.stringify(listed.map((w) => w.title)))
  const builtIn = listed.find((workflow) => workflow.builtIn)
  check('内置工作流存在', builtIn !== undefined, JSON.stringify(listed[0] ?? {}))
  check('内置工作流标了「可以调用」', builtIn?.ready === true, String(builtIn?.ready))
  check('内置工作流是图片能力', builtIn?.capability === 'image', String(builtIn?.capability))
  // 内置那套用 $unet 占位符取模型名，摘要也必须把它算进去——
  // 曾经因为把 models 字段从类型里去掉，默认工作流会拿 "$unet" 去提交。
  check('内置工作流的模型文件数得出来', (builtIn?.models ?? []).length === 3, JSON.stringify(builtIn?.models))

  log('② 校验：不是 API 格式的要被拦住，并且说清楚怎么导出')
  const wrong = await api.call('/api/workflows/validate', { method: 'POST', body: JSON.stringify({ graph: { nodes: [], links: [] } }) })
  check('UI 格式被拒绝', wrong.status === 400, `HTTP ${String(wrong.status)}`)
  check('提示里点名 Export (API)', (wrong.json.error ?? '').includes('Export (API)'), wrong.json.error ?? '')
  const empty = await api.call('/api/workflows/validate', { method: 'POST', body: JSON.stringify({ graph: {} }) })
  check('空图被拒绝', empty.status === 400, `HTTP ${String(empty.status)}`)

  log('③ 校验一份真实上传图：认出节点、认出模型、认出提示词该绑哪')
  // 用内置 z-image 的图做底子，改成「换了模型 + 加了 LoRA + 步数 12」。
  const serverGraph = await (async () => {
    // 内置文件在服务端，这里用一份等价的 API 格式图；字段与 z-image 一致。
    return {
      1: { class_type: 'UNETLoader', inputs: { unet_name: 'my_own_model_v2.safetensors', weight_dtype: 'default' } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b_fp8_mixed.safetensors', type: 'lumina2' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
      4: { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['2', 0], lora_name: 'my_style_lora.safetensors', strength_model: 0.8, strength_clip: 0.8 } },
      5: { class_type: 'CLIPTextEncode', inputs: { text: '雨夜霓虹街头', clip: ['4', 1] } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      7: { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      8: { class_type: 'KSampler', inputs: { seed: 1, steps: 12, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0] } },
      9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
      10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'studio_upload' } },
    }
  })()

  const verdict = (await api.call('/api/workflows/validate', { method: 'POST', body: JSON.stringify({ graph: serverGraph }) })).json
  check('校验返回了节点清单', (verdict.classes ?? []).length >= 8, JSON.stringify(verdict.classes))
  check('认出了 LoRA 节点', (verdict.classes ?? []).includes('LoraLoader'), JSON.stringify(verdict.classes))
  check('认出了全部四个模型文件（含 LoRA）', Object.keys(verdict.models ?? {}).length === 4,
    JSON.stringify(Object.values(verdict.models ?? {}).map((m) => m.value)))
  check('缺的模型被点名（换过的那两个本机没有）',
    (verdict.missingModels ?? []).some((item) => item.value === 'my_own_model_v2.safetensors')
    && (verdict.missingModels ?? []).some((item) => item.value === 'my_style_lora.safetensors'),
    JSON.stringify(verdict.missingModels))
  check('已有的模型不误报', !(verdict.missingModels ?? []).some((item) => item.value === 'ae.safetensors'),
    JSON.stringify(verdict.missingModels))
  check('提示词猜到了正向编码节点', verdict.suggested?.prompt?.node === '5', JSON.stringify(verdict.suggested?.prompt))
  check('反向提示词也认出来了', verdict.suggested?.negative?.node === '6', JSON.stringify(verdict.suggested?.negative))
  check('宽高绑在空 latent 上', verdict.suggested?.width?.node === '7' && verdict.suggested?.height?.node === '7',
    JSON.stringify(verdict.suggested?.width))
  check('步数绑在 KSampler 上', verdict.suggested?.steps?.node === '8', JSON.stringify(verdict.suggested?.steps))

  log('④ 保存：不绑提示词会被拒绝（否则生成出来是空的）')
  const noPrompt = await api.call('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({ title: `没绑提示词 ${STAMP}`, graph: serverGraph, bindings: {} }),
  })
  check('服务端允许保存但标记为不可调用', noPrompt.status === 200 && noPrompt.json.workflow?.ready === false,
    `HTTP ${String(noPrompt.status)} ready=${String(noPrompt.json.workflow?.ready)}`)
  const noPromptId = noPrompt.json.workflow?.id ?? ''
  if (noPromptId !== '') await api.call(`/api/workflows/${noPromptId}`, { method: 'DELETE' })

  log('⑤ 保存一份可用的：把模型换回本机有的，这样它真的能出图')
  const runnable = JSON.parse(JSON.stringify(serverGraph))
  runnable[1].inputs.unet_name = 'z_image_turbo_int8_convrot.safetensors'
  delete runnable[4]
  runnable[5].inputs.clip = ['2', 0]
  runnable[6].inputs.clip = ['2', 0]
  runnable[8].inputs.model = ['1', 0]
  const saved = (await api.call('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      title: `上传验收 ${STAMP}`,
      graph: runnable,
      bindings: {
        prompt: { node: '5', input: 'text' },
        negative: { node: '6', input: 'text' },
        width: { node: '7', input: 'width' },
        height: { node: '7', input: 'height' },
        steps: { node: '8', input: 'steps' },
        seed: { node: '8', input: 'seed' },
      },
      source: '用例上传',
    }),
  })).json.workflow
  check('保存成功', typeof saved?.id === 'string', saved?.title ?? '')
  check('保存后标为可调用', saved?.ready === true, String(saved?.ready))
  check('出现在列表里', ((await api.call('/api/workflows')).json.workflows ?? []).some((w) => w.id === saved.id))

  log('⑥ 侧边栏里的独立页面：能看到它，也能选到画布里')
  const s = await startSession({ port: PORT, width: 1500, height: 950 })
  await s.login(BASE, PASSWORD)
  await s.goto(`${BASE}/`, 4500)
  const navLabels = await s.evaluate(`[...document.querySelectorAll('.studio-nav > button')].map((b) => b.textContent.trim())`)
  check('侧边栏有「工作流」', navLabels.includes('工作流'), navLabels.join(' / '))
  check('主页不再单独给工作流一块', (await s.evaluate(`document.querySelectorAll('.home .workflow-library').length`)) === 0)
  check('点「工作流」进独立页面', await s.clickText('工作流'))
  await sleep(1500)
  check('URL 是 /workflows', (await s.evaluate('location.pathname')) === '/workflows', await s.evaluate('location.pathname'))
  check('页面上有工作流库', (await s.evaluate(`document.querySelectorAll('.workflows-page .workflow-library').length`)) === 1)
  const titles = await s.evaluate(`[...document.querySelectorAll('.workflow-card header strong')].map((n) => n.textContent.trim())`)
  check('卡片里有刚上传的那套', titles.includes(`上传验收 ${STAMP}`), titles.join(' | '))
  check('有「导入工作流」按钮', (await s.evaluate(`[...document.querySelectorAll('.workflow-head button')].some((b) => (b.textContent || '').includes('导入工作流'))`)) === true)

  log('⑥b 三种导入方式都在')
  check('有拖拽区', (await s.evaluate(`document.querySelectorAll('.workflow-drop').length`)) === 1)
  check('提示了要 Export (API)', ((await s.evaluate(`(document.querySelector('.workflow-drop')?.textContent || '')`))).includes('Export (API)'),
    await s.evaluate(`(document.querySelector('.workflow-drop')?.textContent || '')`))
  check('点「粘贴 JSON」展开粘贴框', await s.evaluate(`(() => { const b = [...document.querySelectorAll('.workflow-head button')].find((x) => (x.textContent || '').includes('粘贴 JSON')); if (!b) return false; b.click(); return true })()`))
  await sleep(400)
  check('粘贴框出现', (await s.evaluate(`document.querySelectorAll('.workflow-paste textarea').length`)) === 1)

  log('⑥c 粘贴一份 JSON 也能导入，并给出「缺什么 + 去哪找」')
  await s.evaluate(`(() => {
    const box = document.querySelector('.workflow-paste textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, ${JSON.stringify(JSON.stringify(serverGraph))});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(400)
  check('点「解析」', await s.evaluate(`(() => { const b = document.querySelector('.workflow-paste button'); if (!b) return false; b.click(); return true })()`))
  await sleep(1800)
  check('弹出了映射表单', (await s.evaluate(`document.querySelectorAll('.workflow-mapping').length`)) === 1)
  const warnings = await s.evaluate(`[...document.querySelectorAll('.workflow-mapping .workflow-warn')].map((n) => n.textContent.trim())`)
  check('点名了缺的模型', warnings.some((t) => t.includes('my_own_model_v2.safetensors')), warnings.join(' || ').slice(0, 200))
  const links = await s.evaluate(`[...document.querySelectorAll('.workflow-mapping .workflow-warn a')].map((a) => a.href)`)
  check('缺的模型/节点各带一条搜索链接', links.length >= 2 && links.every((href) => href.startsWith('https://')), links.slice(0, 3).join(' | '))
  const hints = await s.evaluate(`(document.querySelector('.workflow-mapping .workflow-params')?.textContent || '')`)
  check('给了参数参考（这套工作流当前的值）', hints.includes('参数参考') && hints.includes('步数'), hints.slice(0, 160))
  check('参数参考标明了出处，没冒充官方推荐', hints.includes('来自你自己的工作流'), hints.slice(-160))
  check('取消映射表单', await s.evaluate(`(() => { const b = document.querySelector('.workflow-mapping header .link'); if (!b) return false; b.click(); return true })()`))
  await sleep(400)
  check('表单已关闭', (await s.evaluate(`document.querySelectorAll('.workflow-mapping').length`)) === 0)

  log('⑥d 二次修改：不用重新导入')
  check('点刚上传那套的「编辑」', await s.evaluate(`(() => {
    const card = [...document.querySelectorAll('.workflow-card')].find((c) => (c.querySelector('header strong')?.textContent || '').includes(${JSON.stringify(`上传验收 ${STAMP}`)}));
    const button = [...(card?.querySelectorAll('button') ?? [])].find((b) => (b.textContent || '').trim() === '编辑');
    if (!button) return false; button.click(); return true;
  })()`))
  await sleep(2000)
  check('打开的是「修改」表单且已预填', (await s.evaluate(`(document.querySelector('.workflow-mapping header strong')?.textContent || '').includes('修改')`)) === true,
    await s.evaluate(`(document.querySelector('.workflow-mapping header strong')?.textContent || '')`))
  const prefilled = await s.evaluate(`(() => {
    const title = document.querySelector('.workflow-mapping .field input')?.value ?? '';
    const promptSelect = [...document.querySelectorAll('.workflow-mapping select')][0];
    return { title, prompt: promptSelect?.value ?? '' };
  })()`)
  check('名字预填了', prefilled.title.includes(`上传验收 ${STAMP}`), prefilled.title)
  check('提示词绑定预填了', prefilled.prompt === '5.text', prefilled.prompt)
  // 改一下：把步数换成不绑定，然后保存。
  await s.evaluate(`(() => {
    const selects = [...document.querySelectorAll('.workflow-mapping select')];
    const steps = selects[4];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(steps, '');
    steps.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(400)
  check('点「保存修改」', await s.evaluate(`(() => { const b = document.querySelector('.workflow-mapping footer button'); if (!b) return false; b.click(); return true })()`))
  await sleep(1500)
  check('表单关闭且提示已保存', ((await s.evaluate(`(document.querySelector('.workflow-notice')?.textContent || '')`))).includes('改好了'),
    await s.evaluate(`(document.querySelector('.workflow-notice')?.textContent || '')`))
  const afterEdit = await s.evaluate(`(() => {
    const card = [...document.querySelectorAll('.workflow-card')].find((c) => (c.querySelector('header strong')?.textContent || '').includes(${JSON.stringify(`上传验收 ${STAMP}`)}));
    return card !== undefined;
  })()`)
  check('改完还在列表里', afterEdit === true)
  const stepsGone = await s.evaluate(`(async () => {
    const response = await fetch('/api/workflows/${saved.id}', { headers: { accept: 'application/json' } });
    const body = await response.json();
    return body.workflow.bindings.steps === undefined;
  })()`)
  check('服务端真的按修改存了（步数绑定已移除）', stepsGone === true)

  log('⑥e 导出：能把工作流交给别人，别人也能看到自己缺什么')
  check('导出按钮存在', (await s.evaluate(`[...document.querySelectorAll('.workflow-card button')].some((b) => (b.textContent || '').trim() === '导出')`)) === true)
  const exported = await s.evaluate(`(async () => {
    const response = await fetch('/api/workflows/${saved.id}');
    const body = await response.json();
    return { hasGraph: Object.keys(body.workflow.graph).length, hasBindings: Object.keys(body.workflow.bindings).length, title: body.workflow.title };
  })()`)
  check('导出内容含完整图与绑定', exported.hasGraph >= 8 && exported.hasBindings >= 4, JSON.stringify(exported))
  // 列表里直接报「本机缺什么」——这是接手的人第一个问题。
  const listedAgain = (await api.call('/api/workflows')).json.workflows ?? []
  const mine = listedAgain.find((w) => w.id === saved.id)
  check('列表带上「缺什么」字段', Array.isArray(mine?.missingNodes) && Array.isArray(mine?.missingModels),
    JSON.stringify({ nodes: mine?.missingNodes, models: mine?.missingModels }))
  check('刚上传的这套本机不缺东西', (mine?.missingModels ?? ['x']).length === 0 && (mine?.missingNodes ?? ['x']).length === 0,
    JSON.stringify({ nodes: mine?.missingNodes, models: mine?.missingModels }))
  check('卡片上写了「本机节点和模型都齐了」', (await s.evaluate(`(() => {
    const card = [...document.querySelectorAll('.workflow-card')].find((c) => (c.querySelector('header strong')?.textContent || '').includes(${JSON.stringify(`上传验收 ${STAMP}`)}));
    return (card?.textContent || '').includes('都齐了');
  })()`)) === true)

  log('⑦ 用这套工作流真的出一张图（这才叫「能在画布里调用」）')
  const project = await api.createProject(`工作流出图验收 ${STAMP}`)
  const projectId = project.project.id
  await s.goto(`${BASE}/canvas/${projectId}`, 4000)
  await s.doubleClick(700, 400)
  await sleep(700)
  await s.evaluate(`(() => { const b = [...document.querySelectorAll('.studio-menu button')].find((x) => (x.textContent || '').trim() === '图片'); if (b) b.click(); return true })()`)
  await sleep(1500)
  const options = await s.evaluate(`[...document.querySelectorAll('.prompt-window .workflow-select option')].map((o) => o.textContent.trim())`)
  check('提示词窗口里有工作流下拉', options.length >= 2, options.join(' | '))
  check('下拉里含刚上传的那套', options.some((t) => t.includes(`上传验收 ${STAMP}`)), options.join(' | '))

  await s.evaluate(`(() => {
    const select = document.querySelector('.prompt-window .workflow-select');
    const option = [...select.options].find((o) => o.textContent.includes(${JSON.stringify(`上传验收 ${STAMP}`)}));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(600)
  check('节点记住了选择（写进画布文档）', await until(async () => {
    const doc = (await api.call(`/api/projects/${projectId}/canvas`)).json.doc
    return (doc?.nodes ?? []).some((node) => node.data?.workflow === saved.id) ? true : null
  }) === true)

  await s.evaluate(`(() => {
    const input = document.querySelector('.prompt-window textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '雨夜的便利店门口，暖色灯箱，胶片颗粒');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(400)
  check('点生成', await s.evaluate(`(() => { const b = document.querySelector('.prompt-window .send'); if (!b || b.disabled) return false; b.click(); return true })()`))
  const generated = await until(async () => {
    const doc = (await api.call(`/api/projects/${projectId}/canvas`)).json.doc
    const node = (doc?.nodes ?? []).find((item) => typeof item.data?.url === 'string' && item.data.url.startsWith('/api/assets/'))
    return node === undefined ? null : node
  }, 120_000)
  check('上传的工作流真的出图了', generated !== null, generated?.data?.url ?? '没有产出')
  if (generated !== null) {
    const shotId = generated.data?.shotId ?? ''
    const takes = shotId === '' ? [] : ((await api.call(`/api/shots/${shotId}/takes`)).json.takes ?? [])
    check('记了一次成功的 take', takes.some((take) => take.status === 'succeeded'), JSON.stringify(takes.map((t) => t.status)))
    const params = takes[0]?.params ?? {}
    check('take 里记着用的是哪次请求', typeof params.prompt === 'string' && params.prompt.includes('便利店'), JSON.stringify(params).slice(0, 120))
  }

  log('⑧ 删除：上传的能删，内置的不能')
  check('删掉自己上传的那套', (await api.call(`/api/workflows/${saved.id}`, { method: 'DELETE' })).ok)
  check('列表里没有了', !((await api.call('/api/workflows')).json.workflows ?? []).some((w) => w.id === saved.id))
  const refuse = await api.call(`/api/workflows/${builtIn.id}`, { method: 'DELETE' })
  check('内置工作流拒绝删除', refuse.status === 409, `HTTP ${String(refuse.status)}`)

  check('全程没有 JS 报错', s.consoleErrors.length === 0, s.consoleErrors.slice(0, 2).join(' | '))
  await s.shot('workflow-library.png')
  s.kill()
  await api.call(`/api/projects/${projectId}?purge=1`, { method: 'DELETE' })

  log(failures() === 0 ? '\n全部通过' : `\n有 ${String(failures())} 项未通过`)
  process.exit(failures() === 0 ? 0 : 1)
}

run().catch((error) => { console.error('[workflows] 失败:', error); process.exit(1) })
