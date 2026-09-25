/**
 * Render jobs.
 *
 * A render used to *be* an HTTP request: `/v1/images/generations` held the
 * connection until ComfyUI finished. That is fine for a 6 秒 image and wrong for
 * an 11 分钟 video — Node's own `fetch` gives up after 5 分钟, nginx answers 504
 * after 60 秒, and an Agent's HTTP call dies the same way. Worse, the caller's
 * failure said nothing about the work: the render kept going and the take was
 * recorded, so "调用失败" and "活干完了" were both true.
 *
 * So a render is a **job**: submitted in one request, watched by polling or by
 * the canvas's existing event stream, cancellable, and *applied to the canvas
 * document by the server* — which is what makes it work with no browser open at
 * all. Every field here is deliberately plain JSON so a job can cross the wire
 * as-is.
 *
 * Not persisted: a job is work in flight, and a server restart ends it (the
 * in-process coroutine that was driving ComfyUI dies with the process). What
 * survives a restart is the take, because that is what the take table is for.
 */
import { randomUUID } from 'node:crypto'

/** Where a job is in its life. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** What to render. Mirrors the gateway's render request, plus where it belongs. */
export interface JobRequest {
  /**
   * 这是什么活。
   *
   * `render`（默认）走 ComfyUI 出图/出片；`text` 是把一段提示词交给 LLM、把结果写回
   * **文本节点**。两者共用同一个注册表与同一套「提交立刻返回、状态靠查/推」的形状 ——
   * 一次 LLM 调用也可能几十秒，它同样不该挂在一个 HTTP 请求上。
   */
  kind?: 'render' | 'text'
  /** Canvas the result should be written into. */
  projectId: string
  /** Node that asked for it. */
  nodeId: string
  /** Prompt text. */
  prompt: string
  /** `WxH`; the workflow's own default when omitted. */
  size?: string
  /** How many to produce. */
  count?: number
  /** Which stored workflow to run. */
  workflowId?: string
  /** Clip length in seconds, for video workflows. */
  duration?: number
  /** Existing shot to record takes against; empty means "create one". */
  shotId?: string
  /**
   * 非提示词、非尺寸的取值，直接当工作流占位符的值用
   * （裁切的 `start` / `duration`，以后别的编辑节点也走这里）。
   */
  params?: Record<string, number | string>
}

/** One produced file as a job reports it. */
export interface JobFile {
  /** Served URL of the stored asset. */
  url: string
  /** Asset id. */
  assetId: string
  /** Take recorded for it, when there was a shot. */
  takeId?: string
}

/** One render, from submission to outcome. */
export interface StudioJob {
  id: string
  request: JobRequest
  status: JobStatus
  /** Epoch milliseconds. */
  createdAt: number
  /** When the runner actually started; 0 while still queued. */
  startedAt: number
  /** When it reached a terminal state; 0 while unfinished. */
  finishedAt: number
  /** Latest driver progress report, forwarded verbatim for the canvas. */
  progress?: Record<string, unknown>
  /** Produced files, on success. */
  files?: JobFile[]
  /** How many versions the node has now, so the card can number the new one. */
  takes?: number
  /** Shot the takes were recorded against. */
  shotId?: string
  /**
   * 产出的文本，`kind: 'text'` 时才有。
   *
   * 文本没有「素材」「版本」这套（它不是文件），所以结果直接带在作业里，
   * 由画布写进那个文本节点。
   */
  text?: string
  /** Why it failed, or that it was cancelled. */
  error?: string
  /**
   * Something the operator needs told, when the outcome is not what the status
   * alone says.
   *
   * The case that exists today: a cancel that arrived *after* the render had
   * already finished. The status is still 「已取消」（那是人的意图），but the
   * asset and the take are real — saying only 「已取消」 would let a new version
   * appear out of nowhere.
   */
  note?: string
  /**
   * ComfyUI's prompt id, once submitted there.
   *
   * Kept so cancelling can address the *right* work: deleting from ComfyUI's
   * queue needs this id, and interrupting is a blunt instrument that stops
   * whatever happens to be running.
   */
  comfyPromptId?: string
}

/** What the runner reports back. */
export interface JobOutcome {
  /** Produced files. */
  files: JobFile[]
  /** Node's version count after the render. */
  takes: number
  /**
   * Shot the takes landed on.
   *
   * Resolved by the runner (it creates one when the request had none), and sent
   * back so the canvas can record it on the node and refresh the version strip
   * without a second round trip.
   */
  shotId: string
  /** 产出的文本；只有 `kind: 'text'` 的作业会带。 */
  text?: string
}

/** What the registry needs from its owner. */
export interface JobRegistryDeps {
  /**
   * Do the work. Throwing fails the job; the message is kept as-is because the
   * operator is the one who has to read it.
   */
  run: (job: StudioJob, hooks: {
    /** The runner calls this the moment ComfyUI accepts the prompt. */
    queued: (comfyPromptId: string) => void
    /** Progress reports, forwarded to the canvas as they arrive. */
    progress: (progress: Record<string, unknown>) => void
  }) => Promise<JobOutcome>
  /**
   * Stop the work at the source.
   *
   * Called with the ComfyUI prompt id when we have one; when we do not, the job
   * has not reached ComfyUI yet and simply must not start.
   */
  abort: (comfyPromptId: string) => Promise<void>
  /** Called on every state change, so watching canvases can be told. */
  onChange: (job: StudioJob) => void
  /** Diagnostics sink. */
  log: (message: string) => void
}

/** The registry surface. */
export interface JobRegistry {
  /** Queue one render and return immediately. */
  submit: (request: JobRequest) => StudioJob
  /** One job, or undefined. */
  get: (id: string) => StudioJob | undefined
  /** Jobs that have not finished, newest first; optionally for one canvas. */
  active: (projectId?: string) => StudioJob[]
  /** Every job still known, newest first — for diagnostics. */
  list: (projectId?: string) => StudioJob[]
  /**
   * Ask for a job to stop.
   * @returns whether the request was accepted (false when the job is unknown or already finished).
   */
  cancel: (id: string) => Promise<boolean>
}

/** How many finished jobs to keep for inspection. */
const KEEP_FINISHED = 50

/**
 * Build the registry.
 * @param deps - runner, abort, notification sink and logger.
 * @returns the registry surface.
 */
export function createJobRegistry(deps: JobRegistryDeps): JobRegistry {
  /** Insertion-ordered, which is also submission order. */
  const jobs = new Map<string, StudioJob>()

  const publish = (job: StudioJob): void => {
    try {
      deps.onChange(job)
    } catch (error) {
      // A notification failure must never fail the render.
      deps.log(`jobs: 通知失败 ${String(error)}`)
    }
  }

  /** Drop the oldest finished jobs so a long session cannot grow without bound. */
  const prune = (): void => {
    const finished = [...jobs.values()].filter((job) => job.status !== 'queued' && job.status !== 'running')
    if (finished.length <= KEEP_FINISHED) return
    for (const job of finished.slice(0, finished.length - KEEP_FINISHED)) jobs.delete(job.id)
  }

  const start = (job: StudioJob): void => {
    job.status = 'running'
    job.startedAt = Date.now()
    publish(job)
    void deps.run(job, {
      queued: (comfyPromptId) => { job.comfyPromptId = comfyPromptId },
      progress: (progress) => { job.progress = progress; publish(job) },
    }).then((outcome) => {
      if (job.status === 'cancelled') {
        // 取消晚了一步：渲染已经完成，素材与 take 是真的。仍然报「已取消」（那是
        // 人的意图），但要把「结果留下了」说出来——否则画布上会凭空多出一个版本，
        // 而界面上只写着「已取消」。
        if (outcome.files.length > 0) {
          job.files = outcome.files
          job.takes = outcome.takes
          job.shotId = outcome.shotId
          job.note = '已取消，但这次渲染刚好已经完成，结果作为新版本留下了'
        }
        job.finishedAt = Date.now()
        publish(job)
        return
      }
      job.status = 'succeeded'
      job.files = outcome.files
      job.takes = outcome.takes
      job.shotId = outcome.shotId
      // 文本作业没有文件，结果就是这个字段；画布据此写进文本节点。
      if (outcome.text !== undefined) job.text = outcome.text
      job.finishedAt = Date.now()
      deps.log(`jobs: ${job.id.slice(0, 8)} 成功（${String(outcome.files.length)} 个产物）`)
      publish(job)
      prune()
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (job.status === 'cancelled') {
        job.error = '已取消'
      } else {
        job.status = 'failed'
        job.error = message
      }
      job.finishedAt = Date.now()
      deps.log(`jobs: ${job.id.slice(0, 8)} ${job.status}：${message.slice(0, 200)}`)
      publish(job)
      prune()
    })
  }

  return {
    submit(request) {
      const job: StudioJob = {
        id: randomUUID(),
        request,
        status: 'queued',
        createdAt: Date.now(),
        startedAt: 0,
        finishedAt: 0,
      }
      jobs.set(job.id, job)
      publish(job)
      // Start on the next tick: the caller gets its job id before any work
      // begins, which is the entire point of the endpoint.
      setImmediate(() => { start(job) })
      return job
    },
    get: (id) => jobs.get(id),
    active: (projectId) => [...jobs.values()]
      .filter((job) => (job.status === 'queued' || job.status === 'running')
        && (projectId === undefined || job.request.projectId === projectId)),
    list: (projectId) => [...jobs.values()]
      .filter((job) => projectId === undefined || job.request.projectId === projectId)
      .reverse(),
    async cancel(id) {
      const job = jobs.get(id)
      if (job === undefined) return false
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return false
      // Mark first: the runner may be between "ComfyUI accepted" and "we stored
      // the prompt id", and the mark is what turns a later failure into 已取消
      // rather than a red error the operator did not cause.
      job.status = 'cancelled'
      job.error = '已取消'
      publish(job)
      if (job.comfyPromptId !== undefined) {
        try {
          await deps.abort(job.comfyPromptId)
        } catch (error) {
          deps.log(`jobs: 中止失败 ${String(error)}`)
        }
      }
      return true
    },
  }
}
