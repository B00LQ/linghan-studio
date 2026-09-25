/**
 * The infinite canvas.
 *
 * Interaction comes from `@xyflow/react` (MIT); everything product-specific —
 * the two node kinds, the prompt window, generation, the document — is ours.
 *
 * Two ideas shape this file:
 *
 * 1. **The canvas is the entry point.** Nodes are created by gesture: double-click
 *    for the palette, drag from a port for 「引用该节点生成」, right-click for
 *    upload/history. There is no toolbar of add buttons.
 * 2. **A picture node owns its prompt and its history.** Selecting one opens a
 *    window below the card with everything that node ever produced, the prompt,
 *    and the generate button. No separate "shot" node sits between the operator
 *    and the picture.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import { listWorkflows, type WorkflowInfo } from '../api.ts'
import { createShot, deleteAsset, downloadAssets, fetchGenerationStats, listAssets, listTakes, loadCanvas, saveCanvas, selectTake, uploadAsset, addTake, submitJob, listJobs, cancelJob, type CanvasDoc, type StudioJob, type TakeInfo } from '../api.ts'
import { arrangeLayout, arrangeSubset, findFreeSlot, findOverlaps, nodeRect } from './layout.ts'
import { NodePanel, AssetPanel } from './CanvasPanels.tsx'
import { ImageEditor } from './ImageEditor.tsx'
import { CompareView } from './CompareView.tsx'
import { NodeTools } from './NodeTools.tsx'
import { transformImage, type EditOps } from './imageEdit.ts'
import type { BrowserAsset } from '../components/AssetBrowser.tsx'
import { CANVAS_NODES, canConnect, candidatesFor, initialData, nodeLabel, portKind, producesVideo, specOf, type CanvasNodeKind, type PortKind } from './ports.ts'
import { describeProgress, type NodeProgress } from './progress.ts'

/** Data carried by every Studio node. */
export interface StudioNodeData extends Record<string, unknown> {
  /** Node vocabulary entry. */
  kind: CanvasNodeKind
  /** Operator-given name; the list falls back to 「文本节点 2」 when absent. */
  name?: string
  /** Prompt draft for `text`, prompt + echo for `image`. */
  text?: string
  /** Displayed picture for `image`. */
  url?: string
  /** Requested pixel size. */
  size?: string
  /** Requested image count. */
  count?: number
  /** Generation state. */
  status?: 'idle' | 'running' | 'failed'
  /** The generation history this node owns; created on first generate. */
  shotId?: string
  /** Take currently displayed in the card. */
  takeId?: string
  /** Ordinal of the displayed take, so the card can say which version it shows. */
  takeNumber?: number
  /** Whether the displayed take is the one marked chosen. */
  chosen?: boolean
}

/** A Studio canvas node: either a content card or a group frame. */
export type StudioNode = Node<StudioNodeData, 'studio' | 'group'>

/** Props for the canvas surface. */
export interface StudioCanvasProps {
  /** Project whose document is loaded and saved. */
  projectId: string
  /** Initial document, when the project already has one. */
  document: CanvasDoc | null
  /**
   * Page-level content for the top-left corner (product menu, canvas name).
   *
   * The canvas owns node state and renders the chrome, so the page hands its
   * navigation down as a node rather than the canvas reaching up for it.
   */
  topBar?: ReactNode
}

/** Take histories plus the actions node renderers need. */
const CanvasContext = createContext<{
  takes: Record<string, TakeInfo[]>
  /** Which node's prompt window is open; our own state, not xyflow's selection. */
  activeNodeId: string | null
  showTake: (nodeId: string, takeId: string) => void
  /** Ask the node's running job to stop. */
  cancelRun: (nodeId: string) => void
  /** Open the crop/rotate editor on the picture a node is showing. */
  editImage: (nodeId: string, options?: { crop?: boolean }) => void
  /** Apply one transform now and file the result as a new version. */
  quickEdit: (nodeId: string, ops: EditOps, label: string) => void
  /** Open the side-by-side comparison of a node's versions. */
  compare: (nodeId: string) => void
  setParam: (nodeId: string, patch: Partial<StudioNodeData>, options?: { history?: boolean }) => void
  /** Record one undo step at the start of an edit session. */
  beginEdit: () => void
  generate: (nodeId: string) => void
  runningNodeId: string | null
  /** Display name of a node — its own name, or its ordinal among its kind. */
  labelOf: (nodeId: string) => string
  /** Latest progress report for a node, when the driver reports any. */
  progressOf: (nodeId: string) => NodeProgress | null
  /** Progress display, already formatted for the node's own window. */
  statusOf: (nodeId: string) => { text: string; fraction: number | null }
  /**
   * Workflows this node can pick from — **only the ones this machine can run**.
   *
   * 缺节点的（比如官方 PDD 那条要有 ComfyUI-MiniMax-H3-PDD-Acc 插件）、缺模型的、
   * 以及没绑提示词的，都在这里就已经滤掉了，所以下拉里不会出现注定报错的条目。
   */
  runnable: WorkflowInfo[]
  /**
   * Which workflow this node will actually run.
   *
   * Shared with the dropdown so what is shown and what is submitted cannot drift
   * apart — that drift is what let a video node run an image workflow.
   */
  workflowFor: (nodeId: string, data: StudioNodeData) => string
  /** Same rule for the size control: what is shown is what is submitted. */
  sizeFor: (data: StudioNodeData) => string
}>({
  takes: {},
  activeNodeId: null,
  showTake: () => { /* replaced by the provider */ },
  cancelRun: () => { /* replaced by the provider */ },
  editImage: () => { /* replaced by the provider */ },
  quickEdit: () => { /* replaced by the provider */ },
  compare: () => { /* replaced by the provider */ },
  setParam: () => { /* replaced by the provider */ },
  beginEdit: () => { /* replaced by the provider */ },
  generate: () => { /* replaced by the provider */ },
  runningNodeId: null,
  labelOf: () => '',
  progressOf: () => null,
  statusOf: () => ({ text: '', fraction: null }),
  runnable: [],
  workflowFor: () => '',
  sizeFor: () => '1024x1024',
})

/** Distribute handles evenly down a card edge. */
function handleOffset(index: number, total: number): string {
  if (total <= 1) return '50%'
  return `${String(Math.round(((index + 1) / (total + 1)) * 100))}%`
}

/** Take 1 is the oldest; the API returns newest first. */
function ordinal(takes: TakeInfo[], takeId: string): number {
  const newestFirst = takes.findIndex((take) => take.id === takeId)
  if (newestFirst === -1) return takes.length
  return takes.length - newestFirst
}

/** Put the takes in the order they were produced. */
function oldestFirst(takes: TakeInfo[]): TakeInfo[] {
  return [...takes].reverse()
}

/**
 * The prompt input.
 *
 * Deliberately **not** a controlled component. With `value={state}` React rewrites
 * the DOM value on every keystroke, which corrupts an IME's composition region:
 * typing 「雨夜」 through pinyin produced 「yuyuy雨雨夜雨夜」 — the composition text
 * was appended instead of replaced, so typing Chinese looked like it had failed.
 *
 * So the DOM owns the text while it is being edited; state is written back. The
 * incoming value is synced in only when it differs and no composition is in
 * flight, which still covers undo and an Agent editing the same node.
 */
function PromptInput({ value, placeholder, onInput, onBegin }: {
  /** Committed text from the document. */
  value: string
  /** Placeholder shown when empty. */
  placeholder: string
  /** Called with the current text; never called mid-composition. */
  onInput: (text: string) => void
  /** Called when editing starts, so undo gets one step per edit, not per keystroke. */
  onBegin: () => void
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const composing = useRef(false)

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    if (composing.current) return
    if (element.value !== value) element.value = value
  }, [value])

  return (
    <textarea
      ref={ref}
      className="nodrag"
      defaultValue={value}
      placeholder={placeholder}
      onFocus={onBegin}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={(event) => {
        composing.current = false
        onInput(event.currentTarget.value)
      }}
      onChange={(event) => {
        // While an IME composition is in progress, leave the DOM alone: writing
        // to state here is exactly what corrupted it.
        if (composing.current) return
        onInput(event.target.value)
      }}
    />
  )
}

/** One canvas node's rendering. */
function StudioNodeView({ id, data, selected }: NodeProps<StudioNode>) {
  const { takes, activeNodeId, showTake, cancelRun, editImage, quickEdit, compare, setParam, beginEdit, generate, runningNodeId, labelOf, statusOf, runnable, workflowFor, sizeFor } = useContext(CanvasContext)
  const spec = specOf(data.kind)
  const history = typeof data.shotId === 'string' && data.shotId !== '' ? (takes[data.shotId] ?? []) : []
  const running = runningNodeId === id || data.status === 'running'
  // The window follows our own active-node state rather than xyflow's `selected`
  // flag: xyflow owns its selection internally, and marking a node selected by
  // hand did not always take — so the window occasionally appeared on, or
  // belonged to, the wrong node.
  const active = activeNodeId === id

  return (
    <div className={`studio-node ${selected ? 'is-selected' : ''}`} data-kind={data.kind}>
      {/* 图像工具条：贴在卡片上方，**选中这个节点时才出现**。
          它管的是「已经存在的这张画面」，和下方提示词窗口（管怎么再生成一张）
          是两件事，所以不放在同一个窗口里。 */}
      {active && data.kind === 'image' && typeof data.url === 'string' && data.url !== '' ? (
        <NodeTools
          takeCount={history.length}
          onQuickEdit={(ops, label) => { quickEdit(id, ops, label) }}
          onCrop={() => { editImage(id, { crop: true }) }}
          onCompare={() => { compare(id) }}
        />
      ) : null}
      {(spec?.inputs ?? []).map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          style={{ top: handleOffset(index, spec?.inputs.length ?? 1) }}
          title={`${port.label}（${port.kind}）`}
          className={`port port-${port.kind}`}
        />
      ))}

      <header>
        <span>{labelOf(id) || spec?.title || data.kind}</span>
        {running ? <span className="dot running" /> : null}
        {data.status === 'failed' ? <span className="dot failed" /> : null}
        {data.kind !== 'text' && typeof data.takeNumber === 'number'
          ? <span className={`take-badge ${data.chosen === true ? 'is-chosen' : ''}`}>
            {data.chosen === true ? '✓ ' : ''}第 {String(data.takeNumber)} 版
          </span>
          : null}
        {data.kind !== 'text' && history.length > 1 && typeof data.takeNumber !== 'number'
          ? <span className="shot-meta">{history.length} {producesVideo(String(data.kind)) ? '条' : '张'}</span>
          : null}
      </header>

      {data.kind === 'text' ? (
        <div className="body">{data.text ?? ''}</div>
      ) : typeof data.url === 'string' && data.url !== '' ? (
        // 视频用真正的播放器：MiniMax H3 出的 mp4 里带音轨，
        // 「有没有声音」是这个模型的一半卖点，用静音缩略图糊弄过去等于藏了一半。
        producesVideo(String(data.kind))
          ? <video className="node-video" src={data.url} controls playsInline preload="metadata" />
          : <img src={data.url} alt={data.text ?? '生成结果'} />
      ) : (
        <div className="empty-card">
          <div className="placeholder" />
          <p>尝试：</p>
          <ul>
            <li>在下方输入提示词，按 ↑ 生成</li>
            <li>或从左侧文本节点拉线接入提示词</li>
            {producesVideo(String(data.kind)) ? <li>视频很慢：本机 12 GB 卡上一条约几分钟</li> : null}
          </ul>
        </div>
      )}

      {/* 选中后才有：贴着卡片下方的提示词窗口。 */}
      {active && spec !== undefined ? (
        <div className="prompt-window nodrag" onDoubleClick={(event) => { event.stopPropagation() }}>
          {spec.picture && history.length > 0 ? (
            <div className="history" title="点击切换这张卡片显示的画面">
              {oldestFirst(history).map((take, index) => (
                <button
                  type="button"
                  key={take.id}
                  className={`history-cell ${take.id === data.takeId ? 'is-shown' : ''} ${take.mark === 'selected' ? 'is-chosen' : ''}`}
                  title={take.status === 'failed' ? (take.error ?? '生成失败') : `第 ${String(index + 1)} 版 · ${String(Math.round((take.latencyMs ?? 0) / 1000))}s`}
                  onClick={() => { showTake(id, take.id) }}
                >
                  {take.status === 'succeeded' && take.assetId !== ''
                    ? (producesVideo(String(data.kind))
                      // 缩略图也要是个视频元素：<img src="....mp4"> 什么都不显示。
                      ? <video src={`/api/assets/${take.assetId}`} muted playsInline preload="metadata" />
                      : <img src={`/api/assets/${take.assetId}`} alt={`第 ${String(index + 1)} 版`} />)
                    : <span className="cell-failed">失败</span>}
                  <span className="cell-no">{index + 1}</span>
                </button>
              ))}
            </div>
          ) : null}
          <PromptInput
            value={typeof data.text === 'string' ? data.text : ''}
            placeholder={spec.placeholder}
            onBegin={() => { beginEdit() }}
            onInput={(text) => { setParam(id, { text }, { history: false }) }}
          />
          {/* 进度与预计时间单独一行、紧贴生成按钮上方：
              放在按钮左边时会把模型名挤成省略号，而这些字是人要盯着看的。 */}
          {spec.picture && statusOf(id).text !== '' ? (
            <div className={`run-row${running ? ' is-running' : ''}`} data-testid="run-status">
              {statusOf(id).fraction === null ? null : (
                <span className="run-bar"><i style={{ width: `${String(Math.round((statusOf(id).fraction ?? 0) * 100))}%` }} /></span>
              )}
              <span className="run-text">{statusOf(id).text}</span>
              {/* 视频一条十几分钟，「点了只能等」是不能接受的：这里给一个出口。 */}
              {running ? (
                <button
                  type="button"
                  className="link nodrag"
                  data-testid="cancel-run"
                  title="中止这次生成"
                  onClick={() => { cancelRun(id) }}
                >取消</button>
              ) : null}
            </div>
          ) : null}
          <div className="bar">
            <span className="model">
              {spec.picture ? '本地 ComfyUI' : '未配置文本模型'}
            </span>
            {spec.picture ? (
              <>
                {/* 用哪套工作流是这个节点的属性：换了一套就该一直用它，
                    而不是每次都去工作流页重选。
                    没有「默认工作流」这个选项：那等于把「第一套」再写一遍，
                    用户看到两个条目其实是一回事。
                    按**节点类型**筛，不按「图片」筛：视频节点只该看到视频工作流，
                    否则它会拿到一套出图的工作流，然后卡在一个永远不出现的视频上。 */}
                <select
                  className="nodrag workflow-select"
                  title={spec.capability === 'video-edit'
                    ? '用哪套剪辑工作流'
                    : data.kind === 'video' ? '用哪套工作流出视频（在「工作流」页导入）' : '用哪套工作流出图（在「工作流」页导入）'}
                  value={workflowFor(id, data)}
                  onChange={(event) => { setParam(id, { workflow: event.target.value }) }}
                >
                  {runnable.filter((item) => item.capability === spec.capability).map((item) => (
                    <option key={item.id} value={item.id}>{item.title}</option>
                  ))}
                </select>
                {/* 画幅只对「生成」类工作流有意义：剪辑/拼接沿用源片子的画幅。 */}
                {spec.capability === 'video-edit' ? null : (
                  <select
                    className="nodrag"
                    value={sizeFor(data)}
                    onChange={(event) => { setParam(id, { size: event.target.value }) }}
                  >
                    {data.kind === 'video' ? (
                      <>
                        {/* 只列已经实测过的两档：这套模型的可用分辨率桶不是随便填的，
                            没试过的值不该摆在菜单里当承诺。 */}
                        <option value="1344x768">1344×768（768p）</option>
                        <option value="768x448">768×448（快一倍）</option>
                      </>
                    ) : (
                      <>
                        <option value="1024x1024">1024×1024</option>
                        <option value="1280x720">1280×720</option>
                        <option value="768x512">768×512</option>
                      </>
                    )}
                  </select>
                )}
                {spec.capability === 'video-edit' ? (
                  // 剪辑/拼接**没有画幅也没有张数**，所以参数条只给裁切的两个数：
                  // 从第几秒开始、要几秒。拼接什么都不用给（顺序由左右两个入口决定）。
                  data.kind === 'trim' ? (
                    <>
                      <input
                        className="nodrag clip-number"
                        type="number"
                        min={0}
                        step={0.5}
                        title="从第几秒开始"
                        value={String(typeof data.start === 'number' ? data.start : 0)}
                        onChange={(event) => { setParam(id, { start: Math.max(0, Number(event.target.value)) }) }}
                      />
                      <input
                        className="nodrag clip-number"
                        type="number"
                        min={0.5}
                        step={0.5}
                        title="要几秒"
                        value={String(typeof data.duration === 'number' ? data.duration : 3)}
                        onChange={(event) => { setParam(id, { duration: Math.max(0.5, Number(event.target.value)) }) }}
                      />
                    </>
                  ) : null
                ) : data.kind === 'video' ? (
                  // 时长按模型的帧数约束给：MiniMax H3 只接受 5+17n 帧，
                  // 所以这里给的是「约几秒」而不是精确秒数（图里那段算式会把它对齐）。
                  <select
                    className="nodrag"
                    title="片长。模型只接受特定帧数，所以是「约」"
                    value={String(typeof data.duration === 'number' ? data.duration : 5)}
                    onChange={(event) => { setParam(id, { duration: Number(event.target.value) }) }}
                  >
                    <option value="3">约 3 秒</option>
                    <option value="5">约 5 秒</option>
                    <option value="7">约 7 秒</option>
                  </select>
                ) : (
                  <select
                    className="nodrag"
                    value={String(typeof data.count === 'number' ? data.count : 1)}
                    onChange={(event) => { setParam(id, { count: Number(event.target.value) }) }}
                  >
                    {[1, 2, 3, 4].map((n) => <option key={n} value={String(n)}>{n} 张</option>)}
                  </select>
                )}
              </>
            ) : null}
            {/* 进度与预计时间单独一行、紧贴生成按钮上方。 */}
            <button
              type="button"
              className="send nodrag"
              disabled={running || spec.generateBlocked !== undefined}
              title={spec.generateBlocked ?? '生成'}
              onClick={() => { generate(id) }}
            >
              {running ? '…' : '↑'}
            </button>
          </div>
        </div>
      ) : null}

      {(spec?.outputs ?? []).map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          style={{ top: handleOffset(index, spec?.outputs.length ?? 1) }}
          title={`${port.label}（${port.kind}）—— 拖出可生成下游节点`}
          className={`port port-${port.kind}`}
        />
      ))}
    </div>
  )
}

const nodeTypes = { studio: StudioNodeView, group: GroupNodeView }

/** Height of a group frame's title bar. */
const GROUP_HEADER = 28

/**
 * A group frame.
 *
 * Built on xyflow's parent/child relation rather than on a list of ids, because
 * the point of 打组 is that the frame **carries its members**: drag the frame and
 * everything inside moves with it, and dropping a node inside joins it. A group
 * that only existed in a side list would be a label, not a group.
 */
function GroupNodeView({ data, selected }: NodeProps<StudioNode>) {
  return (
    <div className={`studio-group${selected ? ' is-selected' : ''}`}>
      <header>
        <span className="group-name">{typeof data.name === 'string' && data.name !== '' ? data.name : '组'}</span>
      </header>
    </div>
  )
}

/**
 * Read the text feeding one node, following a single inbound edge.
 *
 * Looks for the edge whose **source is a text node**, not simply the first
 * inbound edge: a node can have several inputs (a video node has a prompt port,
 * and a picture input is coming), and 「第一条入边」 would then answer '' whenever
 * the other kind happened to be wired first.
 */
function inboundText(nodeId: string, nodes: StudioNode[], edges: Edge[]): string {
  for (const edge of edges.filter((item) => item.target === nodeId)) {
    const node = nodes.find((item) => item.id === edge.source)
    if (node?.data.kind === 'text') return node.data.text ?? ''
  }
  return ''
}

/** Remove the keys xyflow adds to items it renders, leaving a structural document. */
function stripViewState(items: unknown[]): unknown[] {
  return items.map((item) => {
    const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) }
    delete copy.selected
    delete copy.dragging
    return copy
  })
}

/**
 * Normalize a stored document before it becomes canvas state.
 *
 * Three jobs, all of them about not letting history leak into the present:
 *
 * - `selected` made the next load treat a stale highlight as a real click, which
 *   silently redirected a generation to the wrong node.
 * - `status: 'running'` left a node spinning forever, since a page load means no
 *   generation is in flight.
 * - The document may contain node kinds that no longer exist. 「镜头」 nodes are
 *   converted to picture nodes so the work done in them survives; version boards
 *   held no content of their own and are dropped.
 */
function fromDocument(raw: unknown[]): StudioNode[] {
  const kept: StudioNode[] = []
  for (const item of stripViewState(raw)) {
    if (typeof item !== 'object' || item === null || !('id' in item)) continue
    const node = item as StudioNode
    // Stored documents may hold kinds that no longer exist, so the raw value is
    // read as a string rather than as the current union.
    const kind = String(node.data?.kind ?? '')
    if (kind === 'grid') continue
    if (kind === 'config') {
      const converted: StudioNode = {
        ...node,
        data: {
          ...node.data,
          kind: 'image',
          status: 'idle' as const,
          size: typeof node.data.size === 'string' ? node.data.size : '1024x1024',
          count: typeof node.data.count === 'number' ? node.data.count : 1,
        },
      }
      kept.push(converted)
      continue
    }
    kept.push(node.data?.status === 'running' ? { ...node, data: { ...node.data, status: 'idle' as const } } : node)
  }
  return kept
}

/**
 * Give stored edges explicit port ids.
 *
 * Edges written before ports existed have no `sourceHandle`/`targetHandle`.
 * They only ever joined the single first port of each node, so naming that port
 * is a faithful migration rather than a guess. Edges touching a dropped node are
 * discarded with it.
 */
function normalizeEdges(raw: unknown[], nodes: StudioNode[]): Edge[] {
  const kindOf = (id: unknown): string => {
    const node = nodes.find((item) => item.id === id)
    return typeof node?.data.kind === 'string' ? node.data.kind : ''
  }
  const alive = new Set(nodes.map((node) => node.id))
  return stripViewState(raw)
    .filter((item): item is Edge => typeof item === 'object' && item !== null && 'id' in item)
    .filter((edge) => alive.has(edge.source) && alive.has(edge.target))
    .map((edge) => ({
      ...edge,
      sourceHandle: edge.sourceHandle ?? specOf(kindOf(edge.source))?.outputs[0]?.id ?? null,
      targetHandle: edge.targetHandle ?? specOf(kindOf(edge.target))?.inputs[0]?.id ?? null,
    }))
}

/**
 * Render the canvas for one project.
 * @param props - project id and initial document.
 * @returns the canvas surface.
 */
export function StudioCanvas({ projectId, document, topBar }: StudioCanvasProps) {
  const initialNodes = useMemo<StudioNode[]>(    () => fromDocument(document?.nodes ?? []),
    // The document is the source of truth only on mount; later edits own state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  )
  const initialEdges = useMemo<Edge[]>(
    () => normalizeEdges(document?.edges ?? [], fromDocument(document?.nodes ?? [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges)
  const [status, setStatus] = useState('就绪')
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')
  const [runningNodeId, setRunningNodeId] = useState<string | null>(null)
  /**
   * Which node's prompt window is open.
   *
   * Ours, not xyflow's: xyflow keeps its selection internally and a node marked
   * selected by hand was not always adopted, which made the prompt window land on
   * the wrong node now and then. The `selected` flag is still set on the node so
   * the outline matches.
   */
  const [selection, setSelection] = useState<string | null>(null)
  const [zoom, setZoom] = useState(document?.viewport?.zoom ?? 1)
  /** Which floating panel is open, if any. */
  const [panel, setPanel] = useState<'nodes' | 'assets' | null>(null)
  const [menu, setMenu] = useState<
    | { kind: 'nodes' | 'context'; screenX: number; screenY: number; worldX: number; worldY: number; flipY?: number }
    | { kind: 'fromNode'; screenX: number; screenY: number; worldX: number; worldY: number; sourceNodeId: string; sourceHandleId: string; sourcePortKind: PortKind }
    | null
  >(null)
  const [takes, setTakes] = useState<Record<string, TakeInfo[]>>({})
  /** Picture currently open in the crop/rotate editor, and what to start from. */
  const [editing, setEditing] = useState<{ nodeId: string; url: string; crop?: boolean } | null>(null)
  /** Node whose versions are open in the side-by-side comparison. */
  const [comparing, setComparing] = useState<string | null>(null)
  const [assets, setAssets] = useState<BrowserAsset[]>([])
  /** Feedback line under the asset browser's toolbar. */
  const [assetNotice, setAssetNotice] = useState('')
  /** Node ids handed to the Agent; persisted with the document. */
  const [agentIds, setAgentIds] = useState<string[]>(document?.agentContext ?? [])
  /** Latest progress report per node, keyed by node id. */
  const [progress, setProgress] = useState<Record<string, NodeProgress>>({})
  /**
   * 历史耗时，按产物类型分开。**它必须能重取**，两个原因：
   *
   * ① 这一次请求可能正好撞上服务重启而失败 —— 从前它失败就等于「这台机器没有历史」，
   *    而且一失败就是一整页会话，标签从此闭嘴；
   * ② 每跑完一条活儿中位数就变了，一个长会话里该越跑越准，而不是等下次刷新页面。
   */
  const [stats, setStats] = useState<{
    medianMs: number
    /** 按产物类型分开的历史耗时；视频和图片不能共用一个中位数。 */
    byKind: Record<string, { samples: number; medianMs: number; p90Ms: number }>
    /** 再按 `kind/workflow` 分开；同类的不同工作流耗时差近一倍，混在一起两边都偏。 */
    byWorkflow: Record<string, { samples: number; medianMs: number; p90Ms: number }>
  }>({ medianMs: 0, byKind: {}, byWorkflow: {} })
  /**
   * 重取历史耗时。挂载时一次、每跑完一条活儿再一次 —— 失败只是「暂时没有估计」，
   * 下一次还有机会，不会把这一页钉死在初始状态。
   */
  const refreshStats = useCallback(() => {
    void fetchGenerationStats()
      .then((result) => {
        setStats({
          medianMs: result.estimate.medianMs,
          byKind: result.estimate.byKind ?? {},
          byWorkflow: result.estimate.byWorkflow ?? {},
        })
      })
      .catch(() => { /* 没有估计也是一种正常状态：标签少说一句话而已 */ })
  }, [])
  /** Workflows this canvas can choose from; loaded once per mount. */
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  /** Re-render tick while something is running, so the ETA counts down. */
  const [tick, setTick] = useState(0)
  /**
   * The floating note, and when it should go away.
   *
   * 「就绪」 is not worth a permanent bar, and neither is 「已保存」 — but a failure
   * and a generation result are. So the note appears when there is something to
   * say and fades on its own; errors stay until the next action.
   */
  const [statusNote, setStatusNote] = useState('')
  const [statusTone, setStatusTone] = useState<'info' | 'bad'>('info')
  const viewportRef = useRef(document?.viewport ?? { x: 0, y: 0, zoom: 1 })
  const dirtyRef = useRef(false)
  const editSeq = useRef(0)
  const nodeSeq = useRef(0)
  const flowRef = useRef<ReactFlowInstance<StudioNode, Edge> | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const uploadAtRef = useRef<{ worldX: number; worldY: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const addButtonRef = useRef<HTMLButtonElement | null>(null)
  /**
   * Where the popup menu actually sits.
   *
   * Measured rather than guessed: the old version clamped against a hard-coded
   * 260×340, so a taller menu (「添加节点」 with upload and history) ran off the
   * bottom of the screen, and opening it from the dock's ＋ put it under the dock.
   * Now the real box is measured and pulled back inside the viewport, flipping
   * above the click point when there is no room below.
   */
  const [menuAt, setMenuAt] = useState<{ left: number; top: number; measured: boolean }>({ left: 0, top: 0, measured: false })
  useLayoutEffect(() => {
    const element = menuRef.current
    if (menu === null || element === null) return
    const box = element.getBoundingClientRect()
    const margin = 10
    // 弹窗默认放在 (screenX, screenY) 的右下方；量出真实尺寸后拉回视口内。
    const fitsBelow = menu.screenY + box.height <= window.innerHeight - margin
    // 放不下就往上翻。翻转的基准是 `flipY`（锚点元素的**顶边**），
    // 不是 `screenY`——后者是元素的底边，拿它减去高度会让菜单正好盖住那颗按钮。
    const top = fitsBelow
      ? menu.screenY
      : Math.max(margin, (menu.kind === 'fromNode' ? menu.screenY : (menu.flipY ?? menu.screenY)) - box.height)
    const left = Math.min(Math.max(margin, menu.screenX), Math.max(margin, window.innerWidth - box.width - margin))
    setMenuAt({ left, top, measured: true })
  }, [menu])
  /** When the current run started, for the elapsed-time half of the ETA. */
  /**
   * Job in flight per node, by node id.
   *
   * A node may only have one, and knowing *which* one is what lets a late report
   * from an older run be ignored instead of landing on a busy card.
   */
  const jobsByNode = useRef<Map<string, string>>(new Map())
  /** When each node's current run started, so the ETA can count down per node. */
  const runStartedAt = useRef<Map<string, number>>(new Map())
  /**
   * Which node owns which generation history.
   *
   * Progress frames arrive keyed by shot id, but a node only learns its shot id
   * *after* its first generation returns — so looking the node up in `nodes`
   * used to drop every frame of the very first run. The map is filled the moment
   * a shot is created, and kept in step from the nodes afterwards.
   */
  const shotToNode = useRef(new Map<string, string>())
  const historyRef = useRef<{ past: { nodes: StudioNode[]; edges: Edge[] }[]; future: { nodes: StudioNode[]; edges: Edge[] }[] }>({ past: [], future: [] })
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 })

  /** Freshest snapshots, for work that must not read a stale closure. */
  const nodesRef = useRef<StudioNode[]>(nodes)
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  const edgesRef = useRef<Edge[]>(edges)
  useEffect(() => { edgesRef.current = edges }, [edges])
  const selectionRef = useRef<string | null>(selection)
  useEffect(() => { selectionRef.current = selection }, [selection])

  /** Freshness of the note: transient things fade, failures stay. */
  useEffect(() => {
    const transient = status === '就绪' || status === ''
      ? (saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : '')
      : status
    if (transient === '') { setStatusNote(''); return }
    setStatusNote(transient)
    // 失败要留在屏幕上等人看见；「已保存」这种成功提示自己消失就好。
    const bad = /失败|错误|不能|不存在/.test(transient)
    setStatusTone(bad ? 'bad' : 'info')
    if (bad) return
    const timer = setTimeout(() => { setStatusNote('') }, transient === '已保存' ? 1500 : 4000)
    return () => { clearTimeout(timer) }
  }, [status, saveState])

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    editSeq.current += 1
  }, [])

  /** Record the document before a structural change. */
  const checkpoint = useCallback(() => {
    historyRef.current.past.push({ nodes: nodesRef.current, edges: edgesRef.current })
    if (historyRef.current.past.length > 50) historyRef.current.past.shift()
    historyRef.current.future = []
    setHistoryDepth({ past: historyRef.current.past.length, future: 0 })
  }, [])

  const undo = useCallback(() => {
    const previous = historyRef.current.past.pop()
    if (previous === undefined) {
      setStatus('没有可撤销的操作')
      return
    }
    historyRef.current.future.push({ nodes: nodesRef.current, edges: edgesRef.current })
    setNodes(previous.nodes)
    setEdges(previous.edges)
    selectOnly(null)
    markDirty()
    setHistoryDepth({ past: historyRef.current.past.length, future: historyRef.current.future.length })
    setStatus('已撤销')
  }, [markDirty, setEdges, setNodes])

  const redo = useCallback(() => {
    const next = historyRef.current.future.pop()
    if (next === undefined) {
      setStatus('没有可重做的操作')
      return
    }
    historyRef.current.past.push({ nodes: nodesRef.current, edges: edgesRef.current })
    setNodes(next.nodes)
    setEdges(next.edges)
    selectOnly(null)
    markDirty()
    setHistoryDepth({ past: historyRef.current.past.length, future: historyRef.current.future.length })
    setStatus('已重做')
  }, [markDirty, setEdges, setNodes])

  /** Select exactly one node.
   *
   * xyflow owns selection, and a node created programmatically is not selected
   * by it — so the prompt window would never open on the node just created. The
   * `selected` flag on the node object is the way to say it. */
  /**
   * Select exactly one node: sets xyflow's outline flag *and* our own state,
   * which is what actually decides whose prompt window is open.
   */
  const selectOnly = useCallback((id: string | null) => {
    setSelection(id)
    setNodes((current) => current.map((node) => {
      const shouldSelect = node.id === id
      return (node.selected ?? false) === shouldSelect ? node : { ...node, selected: shouldSelect }
    }))
  }, [setNodes])

  /** Move the viewport so the given nodes are visible. */
  const focusNodes = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setTimeout(() => {
      void flowRef.current?.fitView({ nodes: ids.map((id) => ({ id })), duration: 420, padding: 0.3, maxZoom: 1 })
    }, 60)
  }, [])

  /** Read a node's takes, caching them under its history id. */
  const loadTakes = useCallback(async (shotId: string): Promise<TakeInfo[]> => {
    try {
      const result = await listTakes(shotId)
      setTakes((current) => ({ ...current, [shotId]: result.takes }))
      return result.takes
    } catch {
      // A failed history fetch must not block generation; the strip stays empty.
      return []
    }
  }, [])

  // Debounced autosave: the document is small, so a whole-document write keeps
  // the server contract trivial.
  useEffect(() => {
    if (!dirtyRef.current) return
    const seq = editSeq.current
    const timer = setTimeout(() => {
      const doc = {
        nodes: stripViewState(nodes),
        edges: stripViewState(edges),
        viewport: viewportRef.current,
        agentContext: agentIds,
      } as CanvasDoc
      void saveCanvas(projectId, doc)
        .then(() => {
          setSaveState('saved')
          if (editSeq.current === seq) dirtyRef.current = false
          if (remotePendingRef.current) {
            remotePendingRef.current = false
            void reloadDocument()
          }
        })
        .catch(() => { setSaveState('error') })
    }, 900)
    return () => { clearTimeout(timer) }
  }, [nodes, edges, agentIds, projectId])

  const onConnect = useCallback((connection: Connection) => {
    checkpoint()
    markDirty()
    setEdges((current) => addEdge(connection, current))
  }, [checkpoint, markDirty, setEdges])

  /** Add a node of the given kind, placed near `position` without overlapping. */
  const addNode = useCallback((kind: CanvasNodeKind, position?: { x: number; y: number }): string => {
    checkpoint()
    markDirty()
    nodeSeq.current += 1
    const id = `${kind}-${String(Date.now())}-${String(nodeSeq.current)}`
    const slot = findFreeSlot(nodesRef.current, position ?? { x: 120, y: 120 }, kind)
    setNodes((current) => [...current, {
      id,
      type: 'studio' as const,
      position: slot,
      data: initialData(kind) as StudioNodeData,
    }])
    selectOnly(id)
    focusNodes([id])
    return id
  }, [checkpoint, focusNodes, markDirty, setNodes])

  const addNodeAt = useCallback((kind: CanvasNodeKind, at: { worldX: number; worldY: number }) => {
    setMenu(null)
    addNode(kind, { x: at.worldX, y: at.worldY })
  }, [addNode])

  /** Create a node at the drop point and wire it to the handle the drag started from. */
  const addConnectedNode = useCallback((
    kind: CanvasNodeKind,
    at: { worldX: number; worldY: number },
    from: { sourceNodeId: string; sourceHandleId: string; targetPortId: string },
  ) => {
    setMenu(null)
    checkpoint()
    markDirty()
    nodeSeq.current += 1
    const id = `${kind}-${String(Date.now())}-${String(nodeSeq.current)}`
    const slot = findFreeSlot(nodesRef.current, { x: at.worldX, y: at.worldY }, kind)
    setNodes((current) => [...current, { id, type: 'studio' as const, position: slot, data: initialData(kind) as StudioNodeData }])
    setEdges((current) => addEdge({
      id: `edge-${String(Date.now())}-${String(nodeSeq.current)}`,
      source: from.sourceNodeId,
      sourceHandle: from.sourceHandleId,
      target: id,
      targetHandle: from.targetPortId,
    }, current))
    selectOnly(id)
    focusNodes([id])
    setStatus(`已创建并连接：${specOf(kind)?.title ?? kind}`)
  }, [checkpoint, focusNodes, markDirty, setEdges, setNodes])

  /** Re-arrange the whole canvas into prompts | pictures. */
  const tidyLayout = useCallback(() => {
    if (nodesRef.current.length === 0) {
      setStatus('画布是空的')
      return
    }
    checkpoint()
    markDirty()
    const before = findOverlaps(nodesRef.current).length
    setNodes((current) => arrangeLayout(current))
    setStatus(before === 0 ? '已按「提示词 → 图片」重排' : `已重排，解开了 ${String(before)} 处重叠`)
    setTimeout(() => { void flowRef.current?.fitView({ duration: 420, padding: 0.2 }) }, 80)
  }, [checkpoint, markDirty, setNodes])

  /** Rename a node. An empty name clears it, so the list falls back to the ordinal. */
  const renameNode = useCallback((nodeId: string, name: string) => {
    checkpoint()
    markDirty()
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, name: name.trim() } }
      : node))
    setStatus(name.trim() === '' ? '已恢复默认名称' : `已重命名为「${name.trim()}」`)
  }, [checkpoint, markDirty, setNodes])

  /**
   * Duplicate a node next to itself.
   *
   * The copy is a new node with its own empty history: reusing the original's
   * `shotId` would make two cards claim the same generation history, and undoing
   * one card's version would visibly change the other.
   */
  const duplicateNode = useCallback((nodeId: string) => {
    const source = nodesRef.current.find((node) => node.id === nodeId)
    if (source === undefined) return
    checkpoint()
    markDirty()
    nodeSeq.current += 1
    const id = `${source.data.kind}-${String(Date.now())}-${String(nodeSeq.current)}`
    const data: StudioNodeData = { ...source.data, status: 'idle' }
    delete data.shotId
    delete data.takeId
    delete data.takeNumber
    delete data.chosen
    const slot = findFreeSlot(nodesRef.current, { x: source.position.x + 60, y: source.position.y + 60 }, source.data.kind)
    setNodes((current) => [...current, { id, type: 'studio' as const, position: slot, data }])
    selectOnly(id)
    focusNodes([id])
    setStatus('已复制节点（生成历史不会跟过来）')
  }, [checkpoint, focusNodes, markDirty, setNodes])

  /** Delete a node; the edges touching it go too. */
  const deleteNode = useCallback((nodeId: string) => {
    checkpoint()
    markDirty()
    setNodes((current) => current.filter((node) => node.id !== nodeId))
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
    setAgentIds((current) => current.filter((id) => id !== nodeId))
    if (selectionRef.current === nodeId) selectOnly(null)
    setStatus('已删除节点')
  }, [checkpoint, markDirty, selectOnly, setEdges, setNodes])

  /** Add or remove a node from the Agent's context. */
  const toggleAgentNode = useCallback((nodeId: string) => {
    markDirty()
    setAgentIds((current) => {
      const next = current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]
      setStatus(next.includes(nodeId) ? '已加入 Agent 上下文' : '已从 Agent 上下文移除')
      return next
    })
  }, [markDirty])

  // ── 框选（多选）后的批量动作 ─────────────────────────────────────────────
  // 单选走节点自身（提示词窗口），多选走工具条。两者共用 xyflow 的 selected
  // 标记，所以列表、卡片描边与工具条不会各说各话。

  /** Delete several nodes and every edge touching them. */
  const deleteNodes = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    const doomed = new Set(ids)
    checkpoint()
    markDirty()
    setNodes((current) => current.filter((node) => !doomed.has(node.id)))
    setEdges((current) => current.filter((edge) => !doomed.has(edge.source) && !doomed.has(edge.target)))
    setAgentIds((current) => current.filter((id) => !doomed.has(id)))
    setSelection(null)
    setStatus(`已删除 ${String(ids.length)} 个节点`)
  }, [checkpoint, markDirty, setEdges, setNodes])

  /** Duplicate several nodes, keeping their offsets and dropping their histories. */
  const duplicateNodes = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    const sources = nodesRef.current.filter((node) => ids.includes(node.id))
    if (sources.length === 0) return
    checkpoint()
    markDirty()
    const created: StudioNode[] = []
    for (const source of sources) {
      nodeSeq.current += 1
      const data: StudioNodeData = { ...source.data, status: 'idle' }
      delete data.shotId
      delete data.takeId
      delete data.takeNumber
      delete data.chosen
      created.push({
        id: `${source.data.kind}-${String(Date.now())}-${String(nodeSeq.current)}`,
        type: 'studio' as const,
        // A fixed offset keeps the copies readable; `findFreeSlot` then lifts each
        // one clear of whatever is already there.
        position: findFreeSlot([...nodesRef.current, ...created], { x: source.position.x + 60, y: source.position.y + 60 }, source.data.kind),
        data,
      })
    }
    setNodes((current) => [...current, ...created])
    // Select the copies: the next action is almost always about them.
    const newIds = new Set(created.map((node) => node.id))
    setNodes((current) => current.map((node) => (node.selected === true) === newIds.has(node.id) ? node : { ...node, selected: newIds.has(node.id) }))
    setSelection(null)
    setStatus(`已复制 ${String(created.length)} 个节点（生成历史不会跟过来）`)
  }, [checkpoint, markDirty, setNodes])

  /** Add several nodes to the Agent's context at once. */
  const addSelectedToAgent = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    markDirty()
    setAgentIds((current) => [...new Set([...current, ...ids])])
    setStatus(`已把 ${String(ids.length)} 个节点加入 Agent 上下文`)
  }, [markDirty])

  /** Tidy only the selected nodes, leaving the rest of the canvas alone. */
  const tidySelection = useCallback((ids: string[]) => {
    if (ids.length < 2) return
    checkpoint()
    markDirty()
    setNodes((current) => arrangeSubset(current, ids))
    setStatus(`已整理选中的 ${String(ids.length)} 个节点`)
  }, [checkpoint, markDirty, setNodes])

  /** Clear the selection, including xyflow's own flags. */
  const clearSelection = useCallback(() => {
    setSelection(null)
    setNodes((current) => current.some((node) => node.selected === true)
      ? current.map((node) => node.selected === true ? { ...node, selected: false } : node)
      : current)
  }, [setNodes])

  /** Group the selected nodes into a frame that carries them when it moves. */
  const groupSelection = useCallback((ids: string[]) => {
    // A group of one is just a slower way to move a node.
    const members = nodesRef.current.filter((node) => ids.includes(node.id) && node.data.kind !== 'group')
    if (members.length < 2) {
      setStatus('至少选两个节点才能打组')
      return
    }
    checkpoint()
    markDirty()
    // The frame is the bounding box of its members, with room for a title bar.
    const boxes = members.map((node) => nodeRect(node))
    const pad = 24
    const left = Math.min(...boxes.map((box) => box.x)) - pad
    const top = Math.min(...boxes.map((box) => box.y)) - pad - GROUP_HEADER
    const right = Math.max(...boxes.map((box) => box.x + box.w)) + pad
    const bottom = Math.max(...boxes.map((box) => box.y + box.h)) + pad
    const groupId = `group-${String(Date.now())}`
    const group: StudioNode = {
      id: groupId,
      type: 'group',
      position: { x: left, y: top },
      width: right - left,
      height: bottom - top,
      data: { kind: 'group', name: `组 ${String(nodesRef.current.filter((n) => n.data.kind === 'group').length + 1)}` },
      selected: false,
    }
    const memberIds = new Set(members.map((node) => node.id))
    setNodes((current) => [
      // The frame goes first so it paints underneath its children.
      group,
      ...current.map((node) => memberIds.has(node.id)
        // xyflow positions a child *relative to its parent*, so the coordinates
        // have to be rebased or every member jumps by the frame's offset.
        ? { ...node, parentId: groupId, extent: 'parent' as const, position: { x: node.position.x - left, y: node.position.y - top }, selected: false }
        : node),
    ])
    setSelection(null)
    setStatus(`已把 ${String(members.length)} 个节点打成一组`)
  }, [checkpoint, markDirty, setNodes])

  /** Dissolve a group: the members stay exactly where they are. */
  const ungroupNode = useCallback((groupId: string) => {
    const group = nodesRef.current.find((node) => node.id === groupId)
    if (group === undefined) return
    checkpoint()
    markDirty()
    const offset = group.position
    setNodes((current) => current
      .filter((node) => node.id !== groupId)
      .map((node): StudioNode => {
        if (node.parentId !== groupId) return node
        // `exactOptionalPropertyTypes` means "no longer a child" is expressed by
        // rebuilding the node without those keys, not by setting them to undefined.
        const freed = { ...node }
        delete freed.parentId
        delete freed.extent
        return { ...freed, position: { x: node.position.x + offset.x, y: node.position.y + offset.y } }
      }))
    setStatus('已取消打组（节点留在原处）')
  }, [checkpoint, markDirty, setNodes])

  /**
   * 这台机器**现在真能跑**的工作流。
   *
   * 工作流页会把「缺哪个节点、缺哪个模型」列出来，但节点卡片上的下拉从前不管这些：
   * 加了官方 PDD 加速那条之后（它依赖 ComfyUI-MiniMax-H3-PDD-Acc 插件和
   * `models/pdd_acc/` 里那个 1.4 GB 的头库文件），没装的人会在菜单里看到一个注定
   * 报错的选项。这和画幅菜单只放实测过的两档是同一条规矩——**菜单是承诺，不打算
   * 兑现的别摆上去**。
   *
   * ComfyUI 连不上时 `missingNodes`/`missingModels` 是空的（问不出来就不乱说），
   * 所以这里不会因为「问不到」把菜单清空：那种情况该在生成那一刻如实报错。
   */
  const runnable = useMemo(() => workflows.filter((item) =>
    item.ready && item.missingNodes.length === 0 && item.missingModels.length === 0), [workflows])

  /** 这个节点上接了哪些入边（端口 id）。判断「工作流要的输入有没有接上」靠它。 */
  const connectedPorts = useCallback((nodeId: string): Set<string> => new Set(
    edges
      .filter((edge) => edge.target === nodeId && typeof edge.targetHandle === 'string' && edge.targetHandle !== '')
      .map((edge) => String(edge.targetHandle)),
  ), [edges])

  /**
   * Which workflow this node will actually run.
   *
   * **One function for both** the dropdown's displayed value and what gets
   * submitted. They used to be computed separately: the dropdown fell back to
   * 「第一套匹配本节点类型的」, while the request only carried `data.workflow` —
   * empty until someone touched the dropdown. So the server quietly used *its*
   * default. On an image node that default happened to be the same workflow and
   * nobody noticed; on a video node it meant a video node ran an **image**
   * workflow, 「3 秒完成」, and the card filled with a PNG that cannot play.
   *
   * 两条规矩：
   * ① 选过的那条如果**已经不可用**（插件被删、模型被移走），不能继续按它显示——
   *    显示什么就提交什么，所以退回一条可用的；
   * ② **没选过**时优先挑「它要的输入已经接上了」的那一套。图片节点接了参考图之后
   *    默认还落在文生图上，等于「连了却没用」——那正是这个端口最该避免的观感。
   *    显式选过的那条**不会**被这条顶掉：人挑了图生图却没接图，该在生成那一刻
   *    收到一句「缺参考图」，而不是被悄悄换成别的。
   */
  const workflowFor = useCallback((nodeId: string, data: StudioNodeData): string => {
    // 筛的是 **capability 而不是 kind**：裁切/拼接的 kind 是 trim/concat，但它们跑的是
    // `video-edit` 那一类工作流（LoadVideo → Video Slice / ConcatenateVideo）。少了这一层，
    // 剪辑节点会在下拉里看到一整套 MiniMax H3 生成工作流。
    const want = specOf(String(data.kind ?? ''))?.capability
    if (want === undefined) return ''
    const available = runnable.filter((item) => item.capability === want)
    const chosen = typeof data.workflow === 'string' ? data.workflow : ''
    // 空字符串也是「没选过」：下拉里没有「默认」这个条目（那等于把第一条再写一遍，
    // 用户看到两个条目其实是一回事）。
    const explicit = available.find((item) => item.id === chosen)
    if (explicit !== undefined) return explicit.id
    const connected = connectedPorts(nodeId)
    const fits = available.find((item) => (item.requires ?? []).every((name) => connected.has(name)))
    return fits?.id ?? available[0]?.id ?? ''
  }, [connectedPorts, runnable])

  /**
   * 这套工作流要的输入里，还有哪些没接上（端口 id）。
   * @param nodeId - the node about to run.
   * @param workflowId - the workflow it will run.
   * @returns the missing port ids, empty when it is ready.
   */
  const missingInputs = useCallback((nodeId: string, workflowId: string): string[] => {
    const connected = connectedPorts(nodeId)
    return (workflows.find((item) => item.id === workflowId)?.requires ?? []).filter((name) => !connected.has(name))
  }, [connectedPorts, workflows])

  /**
   * The size this node will actually ask for — same rule as {@link workflowFor}:
   * 下拉显示什么就提交什么。`initialData` 会给每种节点写好默认尺寸，所以这条只在
   * 手写文档/旧文档缺字段时才起作用；但「显示一个值、发另一个值」这个坑刚在
   * 工作流上咬过一次，同一个控件里不想留第二份。
   */
  const sizeFor = useCallback((data: StudioNodeData): string => {
    if (typeof data.size === 'string' && data.size !== '') return data.size
    if (specOf(String(data.kind ?? ''))?.capability === 'video-edit') return '1024x1024'
    return specOf(String(data.kind ?? ''))?.kind === 'video' ? '1344x768' : '1024x1024'
  }, [])

  /**
   * Put a job's state onto the node that asked for it.
   *
   * Called from three places — right after submitting, from the event stream,
   * and once on load for jobs that were already running — because those are the
   * same piece of news arriving by different routes. A page that reloads in the
   * middle of an 11 分钟 render re-attaches here and shows the same thing the
   * page that pressed the button saw.
   * @param job - the job as the server describes it.
   */
  const settleJob = useCallback(async (job: StudioJob) => {
    const nodeId = job.request.nodeId
    const known = jobsByNode.current.get(nodeId)
    // A job we know about but that is not this one is stale news (an earlier run
    // that finished after a newer one started): applying it would put an old
    // picture on a card that is busy making a new one.
    if (known !== undefined && known !== job.id) return

    if (job.status === 'queued' || job.status === 'running') {
      if (known === undefined) {
        // Re-attached after a reload: same bookkeeping the submitting page did.
        jobsByNode.current.set(nodeId, job.id)
        if (job.startedAt > 0) runStartedAt.current.set(nodeId, job.startedAt)
        setRunningNodeId(nodeId)
        markDirty()
        setNodes((current) => current.map((node) => node.id === nodeId
          ? { ...node, data: { ...node.data, status: 'running' as const } }
          : node))
      }
      if (job.progress !== undefined) {
        setProgress((current) => ({ ...current, [nodeId]: job.progress as NodeProgress }))
      }
      return
    }

    // Terminal: clear the run state first, so the card stops looking busy even if
    // the rest below has nothing to do.
    jobsByNode.current.delete(nodeId)
    runStartedAt.current.delete(nodeId)
    setRunningNodeId((current) => (current === nodeId ? null : current))
    setProgress((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })

    // **每次改到节点数据都要标脏。** 防抖保存只在 dirty 为真时写盘，而这条路径
    // 整段渲染期间只改 `progress`（不是 nodes）——不标脏的话，作业完成时写进节点的
    // shotId/url **永远不会存到服务端**。旧实现是靠「渲染期间多次 setNodes 不断重置
    // 那个 900ms 定时器」侥幸成立的，是一连串巧合，不是设计。
    markDirty()

    // 刚落地的这条活儿就是最新的样本：重取一次，下一条同类的估计立刻更准。
    refreshStats()

    if (job.status === 'cancelled') {
      // 取消晚了一步的话，结果其实已经作为新版本留下了 —— 卡片要显示它，
      // 提示也要说出来，不能让人以为「取消了却多出一张」是 bug。
      const late = job.files?.[0]
      setNodes((current) => current.map((node) => node.id === nodeId
        ? {
          ...node,
          data: {
            ...node.data,
            status: 'idle' as const,
            ...(late === undefined
              ? {}
              : {
                url: late.url,
                ...(late.takeId === undefined ? {} : { takeId: late.takeId }),
                takeNumber: job.takes ?? node.data.takeNumber,
              }),
            ...(job.shotId === undefined || job.shotId === '' ? {} : { shotId: job.shotId }),
          },
        }
        : node))
      if (job.shotId !== undefined && job.shotId !== '') {
        shotToNode.current.set(job.shotId, nodeId)
        await loadTakes(job.shotId)
      }
      setStatus(job.note ?? '已取消')
      return
    }
    if (job.status === 'failed') {
      setNodes((current) => current.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'failed' as const } }
        : node))
      setStatus(job.error ?? '生成失败')
      return
    }

    const first = job.files?.[0]
    const listed = first === undefined
      ? {}
      : { url: first.url, ...(first.takeId === undefined ? {} : { takeId: first.takeId }), takeNumber: job.takes ?? 1 }
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
        ...node,
        data: {
          ...node.data,
          status: 'idle' as const,
          ...(job.shotId === undefined || job.shotId === '' ? {} : { shotId: job.shotId }),
          ...listed,
        },
      }
      : node))
    if (job.shotId !== undefined && job.shotId !== '') {
      shotToNode.current.set(job.shotId, nodeId)
      await loadTakes(job.shotId)
    }
    const count = job.files?.length ?? 0
    const kind = nodesRef.current.find((node) => node.id === nodeId)?.data.kind
    setStatus(kind === 'video'
      ? '视频已生成'
      : `已生成 ${String(count)} 张（该节点共 ${String(job.takes ?? count)} 张）`)
  }, [loadTakes, markDirty, refreshStats, setNodes])

  /** Ask for a node's running job to stop. */
  const cancelRun = useCallback(async (nodeId: string) => {
    const jobId = jobsByNode.current.get(nodeId)
    if (jobId === undefined) {
      setStatus('这个节点现在没有在跑的作业')
      return
    }
    setStatus('正在取消…')
    try {
      const { job } = await cancelJob(jobId)
      // 服务端把取消也当成一次状态变化推回来，这里顺手落一次，
      // 免得在没有 SSE 连接（比如测试里）的场合看不到结果。
      void settleJob(job)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '取消失败')
    }
  }, [settleJob])

  /**
   * Generate for one node.
   *
   * Submits a **job** and returns: a render is no longer an HTTP request. An
   * 11 分钟 video held open as a request dies to Node's own 5 分钟 fetch timeout,
   * to nginx's 60 秒, to anything — and the caller's failure would say nothing
   * about work that is still running. So the click returns at once, progress
   * arrives on the existing event stream, and the outcome lands in `settleJob`.
   *
   * A picture node still produces into its own history: the first file becomes
   * what the card shows, and every file of the batch becomes a version the
   * operator can flip through. Nothing is silently dropped when 张数 > 1.
   */
  const generate = useCallback(async (nodeId: string) => {
    const target = nodesRef.current.find((node) => node.id === nodeId)
    if (target === undefined) return
    const spec = specOf(target.data.kind)
    if (spec === undefined) return
    if (spec.generateBlocked !== undefined) {
      setStatus(spec.generateBlocked)
      return
    }
    // 同一个节点同时只跑一件：第二次点击只会让 ComfyUI 排两个一样的队。
    if (jobsByNode.current.has(nodeId)) {
      setStatus('这个节点已经在跑了')
      return
    }
    const prompt = (target.data.text ?? '').trim() || inboundText(nodeId, nodesRef.current, edgesRef.current)
    // 剪辑/拼接不生成画面，提示词为空是对的（那套工作流里根本没有 `$prompt`）。
    if (prompt === '' && spec.capability !== 'video-edit') {
      setStatus('提示词为空：在节点下方写，或从文本节点拉线接入')
      return
    }
    /**
     * 解析不出工作流就**不要提交**。
     *
     * 从前这里不带 workflowId 就发出去了，服务端于是用自己的默认那套 —— 对视频节点
     * 来说那是出图的工作流，结果是「3 秒完成，画框里一张放不出来的图」。
     * 拿不到就明说，别让服务端替我挑一套错的。
     */
    const workflowId = workflowFor(nodeId, target.data)
    if (workflowId === '') {
      // 两种「没有」要分清：真的没导入过，还是导入了但这台机器跑不了（缺节点、
      // 缺模型）。下拉里后者是不显示的，所以这里必须说出来，否则人只会觉得
      // 「明明有工作流却说没有」。
      const sameKind = workflows.filter((item) => item.capability === spec.capability)
      setStatus(sameKind.length === 0
        ? `没有可用于「${spec.title}」节点的工作流：去「工作流」页导入一套`
        : `「${spec.title}」的工作流这台机器现在跑不了（缺节点或缺模型）：去「工作流」页看缺什么`)
      return
    }
    // 这套工作流要的输入没接上（图生图没接参考图）：**现在就说**，别让它跑出一张
    // 和参考图毫无关系的图——那种结果比一句拒绝难查得多。缺的是端口 id，
    // 人看到的是标签，所以翻一道。
    const missing = missingInputs(nodeId, workflowId)
    if (missing.length > 0) {
      const labels = missing.map((name) => spec.inputs.find((input) => input.id === name)?.label ?? name)
      setStatus(`这套工作流需要接上「${labels.join('、')}」：把上游节点的输出连到这个节点的对应入口`)
      return
    }

    setRunningNodeId(nodeId)
    runStartedAt.current.set(nodeId, Date.now())
    setProgress((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, status: 'running' as const } } : node))
    try {
      // The history id is the node's own; the operator never sees a "shot".
      // 先建好：第一帧进度可能在节点自己知道 shotId 之前就到了。
      let shotId = typeof target.data.shotId === 'string' ? target.data.shotId : ''
      if (shotId === '') {
        const created = await createShot(projectId, prompt.slice(0, 40), prompt)
        shotId = created.shot.id
        shotToNode.current.set(shotId, nodeId)
      }
      const { job } = await submitJob({
        projectId,
        nodeId,
        prompt,
        shotId,
        size: sizeFor(target.data),
        count: typeof target.data.count === 'number' ? target.data.count : 1,
        workflowId,
        // 片长只对视频类工作流有意义；别的图里没有 $duration，多传一个数字它也不认。
        ...(typeof target.data.duration === 'number' ? { duration: target.data.duration } : {}),
        // 剪辑参数（从第几秒开始）走 params：工作流用不到的键它自己忽略，
        // 所以这里不需要「哪种节点传哪些参数」的对照表。
        ...(typeof target.data.start === 'number' ? { params: { start: target.data.start } } : {}),
      })
      jobsByNode.current.set(nodeId, job.id)
      setStatus(spec.kind === 'video'
        ? '已提交：视频要十几分钟，可以先去干别的'
        : spec.capability === 'video-edit' ? '已提交：剪辑不用显卡，几秒就完' : '已提交…')
      void settleJob(job)
    } catch (error) {
      // 提交本身失败是**同步**失败（画布不存在、缺字段、服务端拒绝），
      // 如实报错，不要让它看起来像「在跑」。
      markDirty()
      setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, status: 'failed' as const } } : node))
      setStatus(error instanceof Error ? error.message : '提交失败')
      setRunningNodeId(null)
      runStartedAt.current.delete(nodeId)
    }
  }, [markDirty, missingInputs, projectId, setNodes, settleJob, workflowFor])

  /** Show a specific version in the card, and remember it as the chosen one.
   *
   * One action, one meaning: "这张就是我要的". Marking a chosen take is what the
   * data model is for, and clicking a version is exactly when the operator knows.
   *
   * Takes the list to read from rather than using state, because a version that
   * was created a moment ago (a crop, say) is not in state yet — and the caller
   * that just created it is the one that knows about it.
   */
  const showTakeIn = useCallback((nodeId: string, takeId: string, list: TakeInfo[]) => {
    const take = list.find((item) => item.id === takeId)
    if (take === undefined || take.assetId === '') return
    markDirty()
    setNodes((current) => current.map((item) => item.id === nodeId
      ? {
        ...item,
        data: {
          ...item.data,
          url: `/api/assets/${take.assetId}`,
          takeId: take.id,
          takeNumber: ordinal(list, take.id),
          chosen: true,
        },
      }
      : item))
  }, [markDirty, setNodes])

  const showTake = useCallback((nodeId: string, takeId: string) => {
    const node = nodesRef.current.find((item) => item.id === nodeId)
    const shotId = typeof node?.data.shotId === 'string' ? node.data.shotId : ''
    showTakeIn(nodeId, takeId, takes[shotId] ?? [])
    void selectTake(shotId, takeId)
      .then(() => loadTakes(shotId))
      .catch(() => { setStatus('标记选用失败') })
  }, [loadTakes, showTakeIn, takes])

  /**
   * Change a parameter.
   *
   * `history: false` is for continuous editing (typing): the caller records one
   * step up front via `beginEdit`, so undo goes back a whole edit rather than one
   * character at a time — and typing does not push a history entry per keystroke.
   */
  const setParam = useCallback((nodeId: string, patch: Partial<StudioNodeData>, options: { history?: boolean } = {}) => {
    if (options.history !== false) checkpoint()
    markDirty()
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node))
  }, [checkpoint, markDirty, setNodes])

  /** Start an edit session: one undo step covers everything typed until the next one. */
  const beginEdit = useCallback(() => { checkpoint() }, [checkpoint])

  /**
   * Save an edited picture as a new version of the node's history.
   *
   * Recording it as a take rather than silently replacing the card's picture is
   * what keeps 「这一版我裁过」 visible: the version strip shows it, the original
   * is still one click away, and the edit cannot be mistaken for what the model
   * produced.
   */
  const saveEdit = useCallback(async (nodeId: string, blob: Blob, note: string) => {
    const node = nodesRef.current.find((item) => item.id === nodeId)
    if (node === undefined) return
    setStatus('正在保存新版本…')
    try {
      const { asset } = await uploadAsset(blob)
      const shotId = typeof node.data.shotId === 'string' ? node.data.shotId : ''
      if (shotId === '') {
        // No history yet (an uploaded or placed picture): the edit becomes the
        // card's picture, and there is no version to file it under.
        checkpoint()
        setNodes((current) => current.map((item) => item.id === nodeId
          ? { ...item, data: { ...item.data, url: asset.url } }
          : item))
        markDirty()
        setEditing(null)
        setStatus(`已保存编辑结果（这张还没有版本记录）`)
        return
      }
      const { take } = await addTake(shotId, asset.id, note)
      const list = await loadTakes(shotId)
      checkpoint()
      showTakeIn(nodeId, take.id, list)
      void selectTake(shotId, take.id).catch(() => { /* the card already shows it */ })
      setEditing(null)
      setStatus(`已保存为新版本：${note}`)
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : '保存失败')
    }
  }, [checkpoint, loadTakes, markDirty, setNodes, showTakeIn])

  /** Open the crop/rotate editor for the picture a node currently shows. */
  const editImage = useCallback((nodeId: string, options: { crop?: boolean } = {}) => {
    const node = nodesRef.current.find((item) => item.id === nodeId)
    const url = typeof node?.data.url === 'string' ? node.data.url : ''
    if (url === '') { setStatus('这张卡片还没有画面'); return }
    setEditing({ nodeId, url, ...(options.crop === true ? { crop: true } : {}) })
  }, [])

  /**
   * Apply one transform straight away and file it as a new version.
   *
   * The menu's one-click items are for edits you already know you want — turning
   * a picture on its side should not require opening an editor and confirming.
   * Anything interactive (the crop rectangle) still opens the editor.
   */
  const quickEdit = useCallback((nodeId: string, ops: EditOps, label: string) => {
    const node = nodesRef.current.find((item) => item.id === nodeId)
    const url = typeof node?.data.url === 'string' ? node.data.url : ''
    if (url === '') { setStatus('这张卡片还没有画面'); return }
    setStatus(`正在${label}…`)
    void transformImage(url, ops)
      .then(async (blob) => { await saveEdit(nodeId, blob, label) })
      .catch((cause: unknown) => {
        setStatus(`失败：${cause instanceof Error ? cause.message : '这一步没做成'}`)
      })
  }, [saveEdit])

  /** Open the side-by-side comparison for a node's versions. */
  const compare = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((item) => item.id === nodeId)
    const shotId = typeof node?.data.shotId === 'string' ? node.data.shotId : ''
    const list = takes[shotId] ?? []
    if (list.length < 2) { setStatus('只有一个版本，没什么可对比的'); return }
    setComparing(nodeId)
  }, [takes])

  // The document is the source of truth, and an Agent writes to it directly.
  // This canvas only observes: when told the document changed, it reloads.
  const remotePendingRef = useRef(false)
  const reloadDocument = useCallback(async (reason: 'agent' | 'render' = 'agent') => {
    if (dirtyRef.current) {
      remotePendingRef.current = true
      setStatus('Agent 改动了画布；本地改动保存后会同步过来')
      return
    }
    try {
      const { doc } = await loadCanvas(projectId)
      const next = doc ?? { nodes: [], edges: [], viewport: viewportRef.current }
      const loadedNodes = fromDocument(next.nodes)
      setNodes(loadedNodes)
      setEdges(normalizeEdges(next.edges, loadedNodes))
      setAgentIds(Array.isArray(next.agentContext) ? next.agentContext : [])
      /**
       * Keep the operator's selection.
       *
       * Reloading means 「别处改了文档」, not 「取消你的选择」. This matters most for
       * the operator's own render: the server writes the document when a job
       * finishes, so clearing the selection here would close the prompt window at
       * the exact moment they are waiting to see the result — kicking them out of
       * the place they were working.
       */
      const keep = selectionRef.current
      selectOnly(keep !== null && loadedNodes.some((node) => node.id === keep) ? keep : null)
      setStatus(reason === 'render' ? '生成完成' : '画布已随 Agent 的改动更新')
    } catch {
      // A failed refresh is not worth interrupting the operator over.
    }
  }, [projectId, selectOnly, setEdges, setNodes])

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource(`/api/agent/events?projectId=${encodeURIComponent(projectId)}`)
    /**
     * Re-attach to whatever is already running.
     *
     * Called on connect *and* on every reconnect (`hello` is sent each time), so
     * a dropped stream heals itself: without this, news that arrived while the
     * page was away would be lost and the card would sit at 「在跑」 forever.
     */
    const reattach = (): void => {
      void listJobs(projectId)
        .then(({ jobs }) => { for (const job of jobs) void settleJob(job) })
        .catch(() => { /* no jobs is a valid state */ })
    }
    source.addEventListener('hello', () => { reattach() })
    source.addEventListener('document_changed', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { projectId?: string; reason?: string }
        if (payload.projectId !== undefined && payload.projectId !== projectId) return
        // 自己这次生成完成 vs 别的入口改了文档：说法不一样，行为也不一样
        // （生成完成后选中要留着，Agent 改动则由来已久地清掉选中）。
        void reloadDocument(payload.reason === 'render' ? 'render' : 'agent')
      } catch { /* ignore malformed frames */ }
    })
    // Progress rides the same connection as document changes: one stream per
    // canvas, and progress is news rather than a document edit.
    source.addEventListener('generation_progress', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { shotId?: string } & NodeProgress
        if (typeof payload.shotId !== 'string' || payload.shotId === '') return
        const nodeId = shotToNode.current.get(payload.shotId)
        if (nodeId === undefined) return
        setProgress((current) => ({ ...current, [nodeId]: payload }))
      } catch { /* ignore malformed frames */ }
    })
    // 作业状态：提交、进度、成功、失败、取消都走这一条。这是「刷新之后还能接上」
    // 的另一半（另一半是 hello 时拉一次 /api/jobs）。
    source.addEventListener('job', (event) => {
      try {
        const job = JSON.parse((event as MessageEvent<string>).data) as StudioJob
        if (job.request.projectId !== projectId) return
        void settleJob(job)
      } catch { /* ignore malformed frames */ }
    })
    return () => { source.close() }
  }, [projectId, reloadDocument, settleJob])

  // 历史耗时与可选工作流。历史**每个画布取一次**，跑完活儿再取（见 refreshStats）。
  useEffect(() => {
    refreshStats()
    void listWorkflows()
      .then((result) => { setWorkflows(result.workflows) })
      .catch(() => { setWorkflows([]) })
  }, [projectId, refreshStats])

  // The ETA counts down, so it needs a clock. Only while something runs.
  useEffect(() => {
    if (runningNodeId === null) return
    const timer = setInterval(() => { setTick((value) => value + 1) }, 500)
    return () => { clearInterval(timer) }
  }, [runningNodeId])

  // Load the take history for every node that has one, not just the selected
  // node: cards show their version count before you click them.
  const shotIds = useMemo(
    () => [...new Set(nodes.map((node) => (typeof node.data.shotId === 'string' ? node.data.shotId : '')).filter((id) => id !== ''))],
    [nodes],
  )
  // Keep the shot → node map warm for every node that already knows its history.
  useEffect(() => {
    for (const node of nodes) {
      const shotId = typeof node.data.shotId === 'string' ? node.data.shotId : ''
      if (shotId !== '') shotToNode.current.set(shotId, node.id)
    }
  }, [nodes])
  useEffect(() => {
    for (const shotId of shotIds) {
      if (takes[shotId] === undefined) void loadTakes(shotId)
    }
  }, [loadTakes, shotIds, takes])

  // Keep cards in step with their history: a node showing the newest version
  // must reflect it once the history arrives.
  useEffect(() => {
    setNodes((current) => {
      let changed = false
      const next = current.map((node) => {
        const shotId = typeof node.data.shotId === 'string' ? node.data.shotId : ''
        if (shotId === '' || node.data.kind !== 'image') return node
        const history = takes[shotId]
        if (history === undefined || history.length === 0) return node
        const known = typeof node.data.takeId === 'string' && history.some((take) => take.id === node.data.takeId)
        const shown = known
          ? history.find((take) => take.id === node.data.takeId)
          : (history.find((take) => take.mark === 'selected') ?? history[0])
        if (shown === undefined || shown.assetId === '') return node
        const url = `/api/assets/${shown.assetId}`
        const number = ordinal(history, shown.id)
        const chosen = shown.mark === 'selected'
        if (node.data.url === url && node.data.takeNumber === number && node.data.chosen === chosen) return node
        changed = true
        return { ...node, data: { ...node.data, url, takeId: shown.id, takeNumber: number, chosen } }
      })
      return changed ? next : current
    })
  }, [setNodes, takes])

  const takesContext = useMemo(() => ({
    takes,
    activeNodeId: selection,
    showTake,
    cancelRun,
    editImage,
    quickEdit,
    compare,
    setParam,
    beginEdit,
    generate: (nodeId: string) => { void generate(nodeId) },
    runningNodeId,
    labelOf: (nodeId: string) => nodeLabel(nodes, nodeId),
    progressOf: (nodeId: string) => progress[nodeId] ?? null,
    statusOf: (nodeId: string) => {
      const report = progress[nodeId] ?? null
      const node = nodes.find((item) => item.id === nodeId)
      /**
       * 预计时间按**这个节点产出什么、用哪套工作流**来取，而且只用同类同工作流的历史。
       *
       * 两个层次都不能省：从前这里会退回全局中位数（几乎全是图片的），于是一条 10 分钟
       * 的视频显示「预计 十几秒」，然后在接下来的十分钟里一直停在超时状态；只按类型分
       * 也还不够——同是视频，8 步和 4 步差着近一倍，混在一个中位数里两边都偏。
       * 没有样本时宁可**不说**——步数与进度条已经在如实报进展了。
       */
      const kind = String(node?.data.kind ?? '')
      // 产出什么**资产**：视频类（含裁切/拼接）都产出 video。
      const assetKind = producesVideo(kind) ? 'video' : kind === 'image' ? 'image' : ''
      // 只有「生成类」节点才允许退到「同类中位数」：裁切/拼接产出的也是 video，
      // 但它们是秒级的 —— 拿生成那条 8 分钟的中位数去预估剪辑，等于把刚修过的
      // 那个谎（拿图片的中位数去预计视频）又说一遍。
      const generative = assetKind !== '' && specOf(kind)?.capability === assetKind
      // 先精确到「这一类 + 这一套工作流」，没有才退到「这一类」，再没有就不说。
      const exact = assetKind === '' || node === undefined
        ? undefined
        : stats.byWorkflow[`${assetKind}/${workflowFor(node.id, node.data)}`]
      const estimateMs = exact?.medianMs ?? (generative ? (stats.byKind[assetKind]?.medianMs ?? 0) : 0)
      // 开始时间按节点记：两件活同时跑时，一个全局时间戳会让两边的倒计时都错。
      const startedAt = runStartedAt.current.get(nodeId) ?? 0
      const view = describeProgress({
        running: runningNodeId === nodeId || node?.data.status === 'running',
        progress: report,
        estimateMs,
        elapsedMs: startedAt === 0 ? 0 : Date.now() - startedAt,
      })
      return { text: view.text, fraction: view.fraction }
    },
    runnable,
    workflowFor,
    sizeFor,
    // `tick` is not read: it exists so the ETA above is recomputed every 500 ms.
  }), [beginEdit, cancelRun, compare, editImage, generate, nodes, progress, quickEdit, runningNodeId, runnable, selection, setParam, showTake, sizeFor, stats, takes, tick, workflowFor])

  // 左键双击空白处 → 添加节点面板。
  //
  // 必须用捕获阶段的原生监听：xyflow 默认 zoomOnDoubleClick 为 true，它在 pane 上
  // 处理双击并阻止冒泡，挂在容器上的 React 合成事件永远收不到。
  useEffect(() => {
    const container = bodyRef.current
    if (container === null) return
    const onDoubleClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('.prompt-window, .studio-menu') !== null) return
      if (target !== null && target.closest('.react-flow__node') !== null) return
      const position = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 0, y: 0 }
      setMenu({ kind: 'nodes', screenX: event.clientX, screenY: event.clientY, worldX: position.x, worldY: position.y })
    }
    // 点空白 = 关掉提示词窗口（回到未选中状态）。
    // 同样走捕获阶段：xyflow 的 onPaneClick 并不总能收到合成点击，
    // 而「窗口没关掉」正是这个不一致的表现。
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target === null) return
      // 浮层也算「画布的一部分」：编辑器/对比是**针对已选中节点**打开的面板，
      // 点它里面的按钮不该被当成「点了空白」，否则一转图节点就被取消选中，
      // 关掉编辑器之后提示词窗口也没了。
      if (target.closest('.react-flow__node, .prompt-window, .studio-menu, .canvas-dock, .react-flow__minimap, .image-editor, .compare-view') !== null) return
      setSelection(null)
    }
    container.addEventListener('dblclick', onDoubleClick, true)
    container.addEventListener('mousedown', onPointerDown, true)
    return () => {
      container.removeEventListener('dblclick', onDoubleClick, true)
      container.removeEventListener('mousedown', onPointerDown, true)
    }
  }, [])

  // Keyboard shortcuts, matching the reference product's context menu hints.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) {
        if (event.key === 'Escape') (target as HTMLElement).blur()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      }
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [redo, undo])

  /** Reload the shared media library, which the sidebar's 资产 tab lists. */
  const refreshAssets = useCallback(async (): Promise<void> => {
    try {
      const result = await listAssets()
      setAssets(result.assets)
    } catch {
      // The library is a convenience; a failed listing must not break the canvas.
    }
  }, [])

  useEffect(() => { void refreshAssets() }, [refreshAssets])

  /** Select a node from the sidebar: same selection, plus bring it into view. */
  const selectFromList = useCallback((nodeId: string) => {
    selectOnly(nodeId)
    focusNodes([nodeId])
  }, [focusNodes, selectOnly])

  /**
   * Which nodes are selected, read from xyflow's own flags.
   *
   * A marquee drag sets `selected` on several nodes at once, and we deliberately
   * do not intercept its selection events (that is what used to make the prompt
   * window land on the wrong node), so the flags are the honest source.
   */
  const selectedIds = useMemo(() => nodes.filter((node) => node.selected === true).map((node) => node.id), [nodes])

  /**
   * The single group frame currently selected, if any.
   *
   * Selecting a frame is a different situation from selecting nodes: inside a
   * group the useful actions are 取消打组 and 选中成员, not 打组 again.
   */
  const selectedGroup = nodes.find((node) => node.selected === true && node.data.kind === 'group')
  const selectedGroupId = selectedGroup?.id ?? ''
  const groupName = selectedGroup === undefined ? '' : nodeLabel(nodes, selectedGroup.id)

  /** Open the file picker; the chosen file lands where the menu was opened. */
  const beginUpload = useCallback((at: { worldX: number; worldY: number } | null) => {
    uploadAtRef.current = at
    setMenu(null)
    uploadRef.current?.click()
  }, [])

  /** Store an uploaded file and drop a picture node referencing it. */
  const handleUploaded = useCallback(async (file: File) => {
    const at = uploadAtRef.current ?? { worldX: 0, worldY: 0 }
    uploadAtRef.current = null
    setStatus(`上传中…（${(file.size / 1024 / 1024).toFixed(1)} MB）`)
    try {
      const { asset } = await uploadAsset(file)
      checkpoint()
      markDirty()
      nodeSeq.current += 1
      const id = `image-${String(Date.now())}-${String(nodeSeq.current)}`
      const slot = findFreeSlot(nodesRef.current, { x: at.worldX, y: at.worldY }, 'image')
      setNodes((current) => [...current, {
        id,
        type: 'studio' as const,
        position: slot,
        // Uploaded material uses the same node shape as a generated frame, so it
        // flows through layout, export and the agent tools without a special case.
        data: { kind: 'image' as const, url: asset.url, text: `上传：${file.name}` },
      }])
      selectOnly(id)
      focusNodes([id])
      void refreshAssets()
      setStatus(`已上传 ${asset.kind}（${(asset.bytes / 1024).toFixed(0)} KB）`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '上传失败')
    }
  }, [checkpoint, focusNodes, markDirty, refreshAssets, setNodes])

  /** Drop an existing asset onto the canvas as a picture node at a given slot. */
  const placeAssetAt = useCallback((asset: BrowserAsset, index: number) => {
    checkpoint()
    markDirty()
    nodeSeq.current += 1
    const id = `image-${String(Date.now())}-${String(nodeSeq.current)}`
    // 多张一起放时按网格排开，而不是每张都去找最近的空位——那样会一路向右排成一条线。
    const center = flowRef.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      ?? { x: 120, y: 120 }
    const preferred = index === 0
      ? center
      : { x: center.x + (index % 3) * 360, y: center.y + Math.floor(index / 3) * 470 }
    const slot = findFreeSlot(nodesRef.current, preferred, 'image')
    setNodes((current) => [...current, {
      id,
      type: 'studio' as const,
      position: slot,
      data: { kind: 'image' as const, url: asset.url, text: '来自素材库' },
    }])
    return id
  }, [checkpoint, markDirty, setNodes])

  /** Delete assets, and report honestly what the server refused. */
  const removeAssets = useCallback(async (ids: string[]): Promise<void> => {
    let removed = 0
    let refused = 0
    for (const id of ids) {
      try {
        await deleteAsset(id)
        removed += 1
      } catch {
        refused += 1
      }
    }
    await refreshAssets()
    setAssetNotice(refused === 0
      ? `已删除 ${String(removed)} 个素材`
      : `删了 ${String(removed)} 个；${String(refused)} 个还有画布在用，先从画布上删掉那张图`)
  }, [refreshAssets])

  /** Zoom steps, kept in state so the toolbar can show the level. */
  const syncZoom = useCallback(() => {
    const instance = flowRef.current
    if (instance !== null) setZoom(instance.getZoom())
  }, [])

  return (
    <div className="studio-canvas">
      <div className="studio-main">
      <div className="studio-body" ref={bodyRef}>
        {/* 左上角悬浮：logo 菜单 + 画布名。画布铺满整屏，不再为它留一列。 */}
        {topBar === undefined ? null : <div className="canvas-topbar-slot">{topBar}</div>}
        <CanvasContext.Provider value={takesContext}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(instance) => { flowRef.current = instance }}
            onNodesChange={(changes) => { markDirty(); onNodesChange(changes) }}
            onEdgesChange={(changes) => { markDirty(); onEdgesChange(changes) }}
            onConnect={onConnect}
            // 端口有类型，连线就按类型拦一道：把文本接到视频的「首帧」上不该画出
            // 一条线来 —— 一条连上却什么都不做的线，比连不上更让人困惑
            // （视频节点现在有三个入边：提示词、首帧、尾帧）。
            isValidConnection={(connection) => {
              const kindAt = (id: string | null | undefined): string => {
                const node = nodesRef.current.find((item) => item.id === id)
                return typeof node?.data.kind === 'string' ? node.data.kind : ''
              }
              const from = portKind(kindAt(connection.source), connection.sourceHandle ?? null, 'source')
              const to = portKind(kindAt(connection.target), connection.targetHandle ?? null, 'target')
              return from !== undefined && to !== undefined && canConnect(from, to)
            }}
            // 从端口拖线、松手在空白处 → 「引用该节点生成」。菜单按端口类型筛选。
            onConnectEnd={(event, connectionState) => {
              const state = connectionState as unknown as {
                fromNode?: { id: string; data?: StudioNodeData } | null
                fromHandle?: { id?: string | null } | null
                toNode?: { id: string } | null
              }
              if (state.toNode != null) return
              const source = state.fromNode
              if (source == null) return
              const nodeKind = typeof source.data?.kind === 'string' ? source.data.kind : ''
              const handleId = state.fromHandle?.id ?? null
              const kind = portKind(nodeKind, handleId, 'source')
              if (kind === undefined) return
              const pointer = event as MouseEvent
              const world = flowRef.current?.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY }) ?? { x: 0, y: 0 }
              setMenu({
                kind: 'fromNode',
                screenX: pointer.clientX,
                screenY: pointer.clientY,
                worldX: world.x,
                worldY: world.y,
                sourceNodeId: source.id,
                sourceHandleId: handleId ?? '',
                sourcePortKind: kind,
              })
            }}
            // 右键空白处 → 菜单（上传 / 添加节点 / 撤销 / 重做）
            onPaneContextMenu={(event) => {
              event.preventDefault()
              const native = event as unknown as MouseEvent
              const position = flowRef.current?.screenToFlowPosition({ x: native.clientX, y: native.clientY }) ?? { x: 0, y: 0 }
              setMenu({ kind: 'context', screenX: native.clientX, screenY: native.clientY, worldX: position.x, worldY: position.y })
            }}
            onNodeDoubleClick={(_event, node) => { selectOnly(node.id); focusNodes([node.id]) }}
            onNodeClick={(_event, node) => { selectOnly(node.id) }}
            // 框住**恰好一个**节点时，等同于「点它一下」：打开它的提示词窗口。
            // 从前框住一个什么都不会发生——多选工具条只在 2 个以上出现，于是「框住一个」
            // 看起来像没选中（而人接着要做的就是给它写提示词）。
            // 用 onSelectionEnd 而不是 onSelectionChange：后者在 mousedown 阶段就会发一次
            // 仍含旧节点的选择（见下面的说明），采纳它会把刚关掉的窗口又打开。
            // 框住多个不动 selection：那是「操作这一批」，归多选工具条管。
            onSelectionEnd={() => {
              const picked = (flowRef.current?.getNodes() ?? []).filter((node) => node.selected === true)
              if (picked.length === 1 && picked[0] !== undefined) selectOnly(picked[0].id)
            }}
            // 刻意**不**监听 onSelectionChange：xyflow 在处理 mousedown 时会先发一次
            // 仍含旧节点的选中事件，而「点空白关窗口」的捕获监听已经先跑过，
            // 采纳那个事件会把刚关掉的窗口又打开。窗口只认显式动作：
            // 点节点（onNodeClick）开，点空白（捕获 mousedown）关。
            onMoveStart={() => { setMenu(null) }}
            onMoveEnd={(_event, viewport) => { viewportRef.current = viewport; setZoom(viewport.zoom); markDirty() }}
            defaultViewport={viewportRef.current}
            fitView={document === null}
            // 双击画布是「添加节点」，不是缩放。
            zoomOnDoubleClick={false}
            // 左键拖空白 = 框选。平移仍在：中键拖动，或按住空格拖。
            // 不用右键平移，因为右键要留给上下文菜单，两者会互相打架。
            selectionOnDrag
            panOnDrag={[1]}
            selectionMode={SelectionMode.Partial}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <MiniMap pannable zoomable />
            {/* 框选之后：选中的这一批能做什么。单选用节点自己的提示词窗口，
                多选只有这里能操作，所以工具条只在「选了 2 个以上」时出现——
                它一出现就说明「你现在操作的是这一批」。 */}
            {selectedIds.length >= 2 || selectedGroupId !== '' ? (
              <Panel position="top-center" className="selection-bar" data-testid="selection-bar">
                <span className="selection-count">
                  {selectedGroupId === '' ? `已选 ${String(selectedIds.length)} 个` : `组：${groupName}`}
                </span>
                <span className="dock-sep" />
                {selectedGroupId === '' ? (
                  <>
                    <button type="button" title="只整理选中的这些节点，其它不动" onClick={() => { tidySelection(selectedIds) }}>整理</button>
                    <button type="button" title="把这一批打成一个组，拖动组框会带着它们一起走" onClick={() => { groupSelection(selectedIds) }}>打组</button>
                    <button type="button" title="复制这一批（生成历史不会跟过来）" onClick={() => { duplicateNodes(selectedIds) }}>复制</button>
                    <button type="button" title="把这批节点交给 Agent 当上下文" onClick={() => { addSelectedToAgent(selectedIds) }}>添加到 Agent</button>
                    <button type="button" className="danger" title="删除这一批节点及其连线" onClick={() => { deleteNodes(selectedIds) }}>删除</button>
                  </>
                ) : (
                  <>
                    <button type="button" title="解散这个组，节点留在原处" onClick={() => { ungroupNode(selectedGroupId) }}>取消打组</button>
                    <button type="button" title="选中组里的全部节点" onClick={() => { selectOnly(null); setNodes((current) => current.map((node) => node.parentId === selectedGroupId ? { ...node, selected: true } : node)) }}>选中成员</button>
                  </>
                )}
                <span className="dock-sep" />
                <button type="button" title="取消选择" onClick={() => { clearSelection() }}>取消选择</button>
              </Panel>
            ) : null}
            {/* 画布底部居中：两个面板入口 + 缩放 + 整理布局。 */}
            <Panel position="bottom-center" className="canvas-dock">
              <button
                type="button"
                className={panel === 'nodes' ? 'active' : ''}
                title="画布节点：快速定位到某一个节点"
                onClick={() => { setPanel(panel === 'nodes' ? null : 'nodes') }}
              >画布</button>
              <button
                type="button"
                className={panel === 'assets' ? 'active' : ''}
                title="我的资产：生成的画面与上传的素材"
                onClick={() => { setPanel(panel === 'assets' ? null : 'assets') }}
              >资产</button>
              <span className="dock-sep" />
              <button ref={addButtonRef} type="button" title="添加节点" onClick={() => {
                const center = flowRef.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 0, y: 0 }
                // 锚在这颗按钮上，而不是窗口中心：菜单应该从你点的地方长出来。
                // 浮动条在底部，所以下面的空间不够，测量那一步会把它翻到按钮上方。
                const rect = addButtonRef.current?.getBoundingClientRect()
                setMenu({
                  kind: 'nodes',
                  screenX: rect?.left ?? window.innerWidth / 2,
                  screenY: (rect?.bottom ?? window.innerHeight / 2) + 6,
                  flipY: (rect?.top ?? window.innerHeight / 2) - 6,
                  worldX: center.x,
                  worldY: center.y,
                })
              }}>＋</button>
              <span className="dock-sep" />
              <button type="button" title="缩小" onClick={() => { flowRef.current?.zoomOut(); setTimeout(syncZoom, 260) }}>−</button>
              <button type="button" className="zoom-level" title="重置为 100%" onClick={() => { flowRef.current?.zoomTo(1, { duration: 220 }); setTimeout(syncZoom, 260) }}>
                {String(Math.round(zoom * 100))}%
              </button>
              <button type="button" title="放大" onClick={() => { flowRef.current?.zoomIn(); setTimeout(syncZoom, 260) }}>＋</button>
              <button type="button" title="适应画布" onClick={() => { void flowRef.current?.fitView({ duration: 300, padding: 0.2 }); setTimeout(syncZoom, 360) }}>⤢</button>
              <span className="dock-sep" />
              <button type="button" onClick={() => { tidyLayout() }}>整理布局</button>
            </Panel>
          </ReactFlow>
        </CanvasContext.Provider>

        {/* 编辑与对比是「整块画面」的操作，所以铺满窗口而不是挤在浮窗里：
            裁剪要看得清细节，对比要同时放下好几张。 */}
        {editing === null ? null : (
          <ImageEditor
            url={editing.url}
            {...(editing.crop === true ? { startCropping: true } : {})}
            onSave={(blob, note) => saveEdit(editing.nodeId, blob, note)}
            onClose={() => { setEditing(null) }}
          />
        )}
        {comparing === null ? null : (() => {
          const node = nodes.find((item) => item.id === comparing)
          const shotId = typeof node?.data.shotId === 'string' ? node.data.shotId : ''
          return (
            <CompareView
              nodeLabel={nodeLabel(nodes, comparing)}
              mediaKind={node !== undefined && producesVideo(String(node.data.kind)) ? 'video' : 'image'}
              takes={takes[shotId] ?? []}
              {...(typeof node?.data.takeId === 'string' ? { currentTakeId: node.data.takeId } : {})}
              onUse={(takeId) => { showTake(comparing, takeId) }}
              onClose={() => { setComparing(null) }}
            />
          )
        })()}

        {/* 两个面板都浮在画布上方（不是占一列）：看一眼、找到东西、回到画布。 */}
        {panel === 'nodes' ? (
          <NodePanel
            nodes={nodes}
            selectedId={selection}
            agentIds={agentIds}
            onSelect={(nodeId) => { selectFromList(nodeId) }}
            onRename={renameNode}
            onDuplicate={duplicateNode}
            onDelete={deleteNode}
            onToggleAgent={toggleAgentNode}
            onClose={() => { setPanel(null) }}
          />
        ) : null}
        {panel === 'assets' ? (
          <AssetPanel
            assets={assets}
            notice={assetNotice}
            onPlaceMany={(ids) => {
              // 多张一次放下：按网格排开，不叠在一起。
              for (const [index, id] of ids.entries()) {
                const asset = assets.find((item) => item.id === id)
                if (asset === undefined) continue
                placeAssetAt(asset, index)
              }
              setPanel(null)
              setStatus(`已把 ${String(ids.length)} 个素材放到画布上`)
            }}
            onDownload={(ids) => {
              void downloadAssets(ids).catch((problem: unknown) => {
                setAssetNotice(problem instanceof Error ? problem.message : '打包失败')
              })
            }}
            onDelete={(ids) => { void removeAssets(ids) }}
            onClose={() => { setPanel(null) }}
          />
        ) : null}

        {/* 空画布提示：入口写在画布中央，而不是让人去工具栏里找。 */}
        {nodes.length === 0 ? (
          <div className="studio-empty">
            <p>双击画布 添加节点</p>
            <div className="studio-empty-chips">
              {CANVAS_NODES.map((spec) => (
                <button
                  type="button"
                  key={spec.kind}
                  // 三种节点各给一个落点：都写 80 的话图片和视频会叠在同一个位置。
                  onClick={() => { addNode(spec.kind, { x: spec.kind === 'text' ? -360 : spec.kind === 'image' ? 40 : 440, y: -80 }) }}
                >
                  {spec.title}
                </button>
              ))}
              <button type="button" onClick={() => { beginUpload({ worldX: 820, worldY: -80 }) }}>上传素材</button>
            </div>
          </div>
        ) : null}

        {menu !== null ? (
          <>
            <div className="studio-menu-scrim" onClick={() => { setMenu(null) }} onContextMenu={(event) => { event.preventDefault(); setMenu(null) }} />
            <div
              className="studio-menu"
              ref={menuRef}
              style={{ left: menuAt.left, top: menuAt.top, visibility: menuAt.measured ? 'visible' : 'hidden' }}
            >
              {menu.kind === 'nodes' ? (
                <>
                  <header>添加节点</header>
                  {CANVAS_NODES.map((spec) => (
                    <button type="button" key={spec.kind} title={spec.description} onClick={() => { addNodeAt(spec.kind, menu) }}>
                      {spec.title}
                    </button>
                  ))}
                  <div className="sep" />
                  <header>添加资源</header>
                  <button type="button" onClick={() => { beginUpload(menu) }}>上传素材</button>
                </>
              ) : menu.kind === 'fromNode' ? (
                <>
                  <header>引用该节点生成</header>
                  {candidatesFor(menu.sourcePortKind, { excludeKind: nodes.find((n) => n.id === menu.sourceNodeId)?.data.kind as string }).map(({ spec, port }) => (
                    <button
                      type="button"
                      key={spec.kind}
                      title={spec.description}
                      onClick={() => {
                        addConnectedNode(spec.kind, menu, {
                          sourceNodeId: menu.sourceNodeId,
                          sourceHandleId: menu.sourceHandleId,
                          targetPortId: port.id,
                        })
                      }}
                    >
                      {spec.title}
                      <span className="hint">接入{port.label}</span>
                    </button>
                  ))}
                  {candidatesFor(menu.sourcePortKind).length === 0 ? <p className="note">这个输出暂时没有可接的节点类型</p> : null}
                </>
              ) : (
                <>
                  <button type="button" onClick={() => { beginUpload(menu) }}>上传素材</button>
                  <button type="button" onClick={() => { setMenu({ ...menu, kind: 'nodes' }) }}>添加节点<span className="hint">›</span></button>
                  <div className="sep" />
                  <button type="button" disabled={historyDepth.past === 0} onClick={() => { setMenu(null); undo() }}>
                    撤销<span className="hint">{historyDepth.past === 0 ? '' : `${String(historyDepth.past)} 步`}</span>
                  </button>
                  <button type="button" disabled={historyDepth.future === 0} onClick={() => { setMenu(null); redo() }}>
                    重做<span className="hint">{historyDepth.future === 0 ? '' : `${String(historyDepth.future)} 步`}</span>
                  </button>
                </>
              )}
            </div>
          </>
        ) : null}

        <input
          ref={uploadRef}
          type="file"
          accept="image/*,video/*,audio/*"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Reset so choosing the same file twice still fires a change event.
            event.target.value = ''
            if (file !== undefined) void handleUploaded(file)
          }}
        />
        {/* 状态改成左下角的一小块，且说完就自己消失。
            原来顶上常驻一条「就绪 / 已保存」，占一行高度却说不出什么信息。 */}
        {statusNote === '' ? null : (
          <div className={`studio-toast ${statusTone}`}>{statusNote}</div>
        )}
      </div>
      </div>
    </div>
  )
}
