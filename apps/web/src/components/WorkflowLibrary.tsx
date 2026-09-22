/**
 * The workflow library.
 *
 * A ComfyUI workflow is whatever graph the creator built — a different
 * checkpoint, a LoRA in the middle, another sampler. So adding one means
 * answering a question the server cannot answer by itself: **which input
 * receives the prompt?** Everything else (which nodes exist, which model files
 * are missing) is checked automatically.
 *
 * Three things here are deliberate:
 *
 * - **Three ways in** — drag a file onto the page, pick one, or paste the JSON.
 *   The paste path exists because the usual way to get an API-format graph is to
 *   copy it out of a chat or a gist, and "save it to disk first" is a step nobody
 *   wants.
 * - **Editing, not re-importing** — the graph is almost always right; what needs
 *   fixing later is the mapping. `编辑` reopens the same form, prefilled.
 * - **Hints, never silent defaults** — the parameters shown are *the ones this
 *   workflow already uses*, plus search links for anything missing. We do not
 *   invent "official" numbers: a wrong authoritative-looking value is worse than
 *   no value.
 */
import { useEffect, useRef, useState } from 'react'
import {
  deleteWorkflow, getWorkflow, listWorkflows, saveWorkflow, updateWorkflow, validateWorkflow,
  type WorkflowBinding, type WorkflowInfo, type WorkflowVerdict,
} from '../api.ts'

/** The logical inputs worth binding, in the order the form shows them. */
const BINDABLE: { key: string; label: string; hint: string; kind: 'text' | 'number' }[] = [
  { key: 'prompt', label: '提示词', hint: '必须选。画布上写的字从这里进去', kind: 'text' },
  { key: 'negative', label: '反向提示词', hint: '可选，没有就留「不用」', kind: 'text' },
  { key: 'width', label: '宽度', hint: '接画布上的画幅设置', kind: 'number' },
  { key: 'height', label: '高度', hint: '接画布上的画幅设置', kind: 'number' },
  { key: 'steps', label: '步数', hint: '采样步数', kind: 'number' },
  { key: 'seed', label: '种子', hint: '每次生成换一个', kind: 'number' },
]

/** Search links for a missing thing — a placeholder, never a made-up deep link. */
const nodeSearch = (className: string): string => `https://github.com/search?q=${encodeURIComponent(`ComfyUI ${className}`)}&type=repositories`
const modelSearch = (fileName: string): string => `https://huggingface.co/models?search=${encodeURIComponent(fileName.replace(/\.[a-z0-9]+$/iu, ''))}`

/** Props for {@link WorkflowLibrary}. */
export interface WorkflowLibraryProps {
  /** Bumped when something outside changed. */
  refreshToken: number
  /** Called after the list changes, so other views can refresh. */
  onChanged: () => void
}

/** What the form is working on. */
interface Draft {
  /** Set when editing an existing workflow; empty when adding. */
  id: string
  title: string
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  verdict: WorkflowVerdict
  bindings: Record<string, WorkflowBinding>
}

/**
 * Render the library.
 * @param props - see {@link WorkflowLibraryProps}.
 * @returns the section.
 */
export function WorkflowLibrary({ refreshToken, onChanged }: WorkflowLibraryProps) {
  const [list, setList] = useState<WorkflowInfo[]>([])
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const reload = async (): Promise<void> => {
    try {
      const result = await listWorkflows()
      setList(result.workflows)
    } catch {
      setList([])
    }
  }

  useEffect(() => { void reload() }, [refreshToken])

  /**
   * Accept either a raw API-format graph or a file this app exported.
   *
   * Exporting writes `{ title, graph, bindings }` so a workflow can be handed to
   * someone else; importing that same file has to keep working, or the round trip
   * is broken at the second half.
   */
  const openDraft = async (text: string, fallbackTitle: string): Promise<void> => {
    setNotice('')
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const wrapped = typeof parsed.graph === 'object' && parsed.graph !== null
      const graph = (wrapped ? parsed.graph : parsed) as Draft['graph']
      const verdict = await validateWorkflow(graph)
      setDraft({
        id: '',
        title: typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : fallbackTitle,
        graph,
        verdict,
        bindings: Object.fromEntries(
          Object.entries((wrapped ? parsed.bindings : verdict.suggested) as Record<string, WorkflowBinding> ?? {})
            .filter(([, binding]) => binding?.node !== undefined && binding.node !== ''),
        ),
      })
      setPasting(false)
      setPasted('')
    } catch (problem) {
      setNotice(problem instanceof Error ? problem.message : '这个文件读不了（要 JSON）')
    }
  }

  /** Reopen the form for an existing workflow, graph and mapping intact. */
  const editExisting = async (id: string): Promise<void> => {
    setNotice('')
    try {
      const { workflow } = await getWorkflow(id)
      const verdict = await validateWorkflow(workflow.graph)
      setDraft({ id, title: workflow.title, graph: workflow.graph, verdict, bindings: workflow.bindings })
    } catch (problem) {
      setNotice(problem instanceof Error ? problem.message : '打不开这套工作流')
    }
  }

  /** Download a workflow so it can be handed to another machine. */
  const exportWorkflow = async (id: string): Promise<void> => {
    try {
      const { workflow } = await getWorkflow(id)
      const payload = JSON.stringify({
        title: workflow.title,
        source: workflow.source,
        capability: workflow.capability,
        bindings: workflow.bindings,
        defaults: workflow.defaults,
        graph: workflow.graph,
      }, null, 2)
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${workflow.title}.json`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
    } catch (problem) {
      setNotice(problem instanceof Error ? problem.message : '导出失败')
    }
  }

  const commit = async (): Promise<void> => {
    if (draft === null) return
    if (draft.bindings.prompt === undefined) {
      setNotice('还没选「提示词」接哪个输入——不选的话生成出来是空的')
      return
    }
    try {
      if (draft.id === '') {
        const saved = await saveWorkflow({ title: draft.title, graph: draft.graph, bindings: draft.bindings })
        setNotice(`已添加「${saved.workflow.title}」，现在可以在画布的提示词窗口里选它`)
      } else {
        await updateWorkflow(draft.id, { title: draft.title, bindings: draft.bindings })
        setNotice('改好了。画布里已经选着它的节点下次生成就会用新设置')
      }
      setDraft(null)
      await reload()
      onChanged()
    } catch (problem) {
      setNotice(problem instanceof Error ? problem.message : '保存失败')
    }
  }

  /** The values this workflow already uses for whatever is bound. */
  const currentValues = draft === null ? [] : BINDABLE.flatMap((field) => {
    const binding = draft.bindings[field.key]
    if (binding === undefined) return []
    const value = draft.graph[binding.node]?.inputs?.[binding.input]
    return value === undefined ? [] : [{ label: field.label, at: `${binding.node}.${binding.input}`, value: String(value) }]
  })

  return (
    <div className="workflow-library">
      <header className="workflow-head">
        <h2>工作流</h2>
        <span className="muted">{list.length} 套 · 在 ComfyUI 里跑，画布上直接选</span>
        <button type="button" className="primary" onClick={() => { fileInput.current?.click() }}>＋ 导入工作流</button>
        <button type="button" onClick={() => { setPasting(!pasting) }}>粘贴 JSON</button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) void file.text().then((text) => openDraft(text, file.name.replace(/\.json$/iu, '')))
          }}
        />
      </header>

      {/* 拖进来就行：最常见的来源是聊天窗口里复制出来的一段 JSON。 */}
      <div
        className={`workflow-drop${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => { setDragging(false) }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files[0]
          if (file !== undefined) void file.text().then((text) => openDraft(text, file.name.replace(/\.json$/iu, '')))
        }}
      >
        <strong>把 ComfyUI 导出的 JSON 拖到这里</strong>
        <span className="muted">
          必须是 <code>Workflow → Export (API)</code> 导出的那种（点 Save 存的是界面格式，提交不了）
        </span>
      </div>

      {pasting ? (
        <div className="workflow-paste">
          <textarea
            value={pasted}
            placeholder='把 API 格式的 JSON 粘在这里，然后点「解析」'
            onChange={(event) => { setPasted(event.target.value) }}
          />
          <button type="button" className="primary" onClick={() => { void openDraft(pasted, '粘贴的工作流') }}>解析</button>
        </div>
      ) : null}

      {notice === '' ? null : <p className="workflow-notice">{notice}</p>}

      <div className="workflow-cards">
        {list.map((workflow) => (
          <article className={`workflow-card${workflow.ready ? '' : ' not-ready'}`} key={workflow.id}>
            <header>
              <strong>{workflow.title}</strong>
              <span className={`badge ${workflow.capability}`}>{workflow.capability === 'video' ? '视频' : '图片'}</span>
              {workflow.builtIn ? <span className="badge">内置</span> : null}
            </header>
            <p className="muted">
              {workflow.ready ? '可以调用' : '还不能调用：没绑定提示词'}
              {' · '}
              {workflow.classes.length} 个节点
              {workflow.models.length === 0 ? '' : ` · ${String(workflow.models.length)} 个模型文件`}
            </p>
            {/* 别人下载之后最想知道的就是这个：本机还差什么。 */}
            {workflow.offline ? null : (
              workflow.missingNodes.length === 0 && workflow.missingModels.length === 0
                ? <p className="workflow-ok">本机节点和模型都齐了</p>
                : (
                  <div className="workflow-missing">
                    {workflow.missingNodes.length === 0 ? null : (
                      <p>
                        缺 {workflow.missingNodes.length} 个节点：
                        {workflow.missingNodes.map((name) => (
                          <a key={name} href={nodeSearch(name)} target="_blank" rel="noreferrer">{name}</a>
                        ))}
                      </p>
                    )}
                    {workflow.missingModels.length === 0 ? null : (
                      <p>
                        缺 {workflow.missingModels.length} 个模型文件：
                        {workflow.missingModels.map((name) => (
                          <a key={name} href={modelSearch(name)} target="_blank" rel="noreferrer">{name}</a>
                        ))}
                      </p>
                    )}
                    <p className="muted">点名字去搜；节点用 ComfyUI-Manager 的「Install Missing Custom Nodes」最快。</p>
                  </div>
                )
            )}
            {workflow.models.length === 0 ? null : (
              <ul className="workflow-models">
                {workflow.models.slice(0, 3).map((model) => (
                  <li key={model}>
                    {model}
                    {' '}
                    <a href={modelSearch(model)} target="_blank" rel="noreferrer" title="在 HuggingFace 上搜这个模型">查</a>
                  </li>
                ))}
                {workflow.models.length > 3 ? <li className="muted">还有 {workflow.models.length - 3} 个…</li> : null}
              </ul>
            )}
            {workflow.capability === 'video' ? (
              // 视频工作流能存能校验，但画布上还没有视频节点，调用不了。如实说，别给个假按钮。
              <p className="muted">画布上还没有视频节点，暂时不能调用</p>
            ) : null}
            <div className="workflow-actions">
              <button type="button" onClick={() => { void exportWorkflow(workflow.id) }}>导出</button>
              {workflow.builtIn
                ? <span className="muted">内置的不能改</span>
                : (
                  <>
                    <button type="button" onClick={() => { void editExisting(workflow.id) }}>编辑</button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        if (!window.confirm(`删除工作流「${workflow.title}」？`)) return
                        void deleteWorkflow(workflow.id).then(() => { void reload(); onChanged() })
                      }}
                    >删除</button>
                  </>
                )}
            </div>
          </article>
        ))}
      </div>

      {draft === null ? null : (
        <div className="workflow-mapping" role="dialog" aria-label="工作流字段映射">
          <header>
            <strong>{draft.id === '' ? '这套工作流里，什么是什么？' : '修改这套工作流'}</strong>
            <button type="button" className="link" onClick={() => { setDraft(null) }}>取消</button>
          </header>

          <label className="field">
            <span>名字</span>
            <input value={draft.title} onChange={(event) => { setDraft({ ...draft, title: event.target.value }) }} />
          </label>

          {draft.verdict.offline ? <p className="workflow-warn">{draft.verdict.note}</p> : null}
          {draft.verdict.missingNodes.length === 0 ? null : (
            <div className="workflow-warn">
              <strong>本机 ComfyUI 缺少这些节点</strong>
              <ul>
                {draft.verdict.missingNodes.map((name) => (
                  <li key={name}>
                    {name}
                    {' · '}
                    <a href={nodeSearch(name)} target="_blank" rel="noreferrer">去搜这个自定义节点</a>
                  </li>
                ))}
              </ul>
              <span className="muted">装节点用 ComfyUI-Manager 里的「Install Missing Custom Nodes」最省事。</span>
            </div>
          )}
          {draft.verdict.missingModels.length === 0 ? null : (
            <div className="workflow-warn">
              <strong>本机没有这些模型文件</strong>
              <ul>
                {draft.verdict.missingModels.map((item) => (
                  <li key={`${item.node}.${item.input}`}>
                    {item.value}
                    {' · '}
                    <a href={modelSearch(item.value)} target="_blank" rel="noreferrer">去 HuggingFace 搜</a>
                  </li>
                ))}
              </ul>
              <span className="muted">下好之后放进 ComfyUI 的 models 目录里对应的子文件夹。</span>
            </div>
          )}
          {draft.verdict.missingNodes.length === 0 && draft.verdict.missingModels.length === 0 && !draft.verdict.offline
            ? <p className="workflow-ok">节点和模型本机都有。</p>
            : null}

          {BINDABLE.map((field) => {
            const binding = draft.bindings[field.key]
            const option = binding === undefined ? '' : `${binding.node}.${binding.input}`
            const options = draft.verdict.candidates
              .filter((candidate) => (field.kind === 'text' ? typeof candidate.value === 'string' : typeof candidate.value === 'number'))
              .map((candidate) => ({ value: `${candidate.node}.${candidate.input}`, label: `${candidate.node}.${candidate.input}　${candidate.classType}　现在=${String(candidate.value).slice(0, 18)}` }))
            return (
              <label className="field" key={field.key}>
                <span>{field.label}<em className="muted">{field.hint}</em></span>
                <select
                  value={option}
                  onChange={(event) => {
                    const [node = '', input = ''] = event.target.value.split('.')
                    const next = { ...draft.bindings }
                    if (node === '') delete next[field.key]
                    else next[field.key] = { node, input }
                    setDraft({ ...draft, bindings: next })
                  }}
                >
                  <option value="">（不用）</option>
                  {options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
            )
          })}

          {/* 参数参考：只列**这套工作流自己当前的值**。
              我们不知道每个模型的「官方推荐」，编一个看着权威的错数字比不写更糟。 */}
          {currentValues.length === 0 ? null : (
            <details className="workflow-params" open>
              <summary>参数参考（这套工作流现在用的值）</summary>
              <ul>
                {currentValues.map((item) => (
                  <li key={item.at}>
                    <span className="muted">{item.label}</span>
                    <code>{item.at}</code>
                    <strong>{item.value}</strong>
                  </li>
                ))}
              </ul>
              <p className="muted">
                这些数来自你自己的工作流，改它们请回 ComfyUI 改图再导入。
                换模型时最常踩的两个坑：编码器（CLIP）与 VAE 必须和主模型配对，否则偏色；
                LoRA 的强度没有通用值，看它的模型卡。
              </p>
            </details>
          )}

          <footer>
            <button type="button" className="primary" onClick={() => { void commit() }}>
              {draft.id === '' ? '保存' : '保存修改'}
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}
