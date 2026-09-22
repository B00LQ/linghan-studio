/**
 * Crop / rotate / flip a picture, and save the result as a new version.
 *
 * Two decisions shape this component:
 *
 * 1. **Every step re-renders for real.** Instead of previewing with CSS
 *    transforms, each action runs the actual draw and shows its output. A CSS
 *    preview can disagree with the saved file — mirrored text, a crop that
 *    lands one pixel off — and the operator only finds out after uploading.
 *    Here the preview *is* the result.
 * 2. **A session, not a click.** Rotating four times and cropping twice is one
 *    intention (「这张我要这么处理」), so it produces **one** version. Uploading
 *    per click would bury the strip in near-identical entries.
 *
 * The edit stack also gives undo for free: each entry is a finished picture, so
 * going back is a pop rather than an inverse transform.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { clampRect, fitAspect, isUsable, normalizeRect, type Rect } from './crop.ts'
import { loadImage, transformImage } from './imageEdit.ts'

/** One finished state of the picture. */
interface Snapshot {
  /** Bytes to save; `null` for the untouched original. */
  blob: Blob | null
  /** Object URL to display; the original's URL is not ours to revoke. */
  url: string
  /** Whether `url` is an object URL this component must revoke. */
  owned: boolean
  width: number
  height: number
  /** What produced this state, for the step log. */
  label: string
}

/** Props for {@link ImageEditor}. */
export interface ImageEditorProps {
  /** Picture being edited, as currently displayed on the canvas. */
  url: string
  /**
   * Open straight into crop mode.
   *
   * The toolbar's 裁剪 item has already said what the operator came for; landing
   * on a generic editor and making them click 裁剪 again is one click of pure
   * ceremony.
   */
  startCropping?: boolean
  /** Called with the finished bytes and a description of what was done. */
  onSave: (blob: Blob, note: string) => Promise<void>
  /** Close without saving. */
  onClose: () => void
}

/** Ratio presets, in the order people reach for them. */
const RATIOS: { label: string; value: number | null }[] = [
  { label: '自由', value: null },
  { label: '1:1', value: 1 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '4:3', value: 4 / 3 },
]

/**
 * The editor overlay.
 * @param props - see {@link ImageEditorProps}.
 * @returns the dialog.
 */
export function ImageEditor({ url, startCropping = false, onSave, onClose }: ImageEditorProps) {
  const [stack, setStack] = useState<Snapshot[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cropMode, setCropMode] = useState(startCropping)
  const [cropRect, setCropRect] = useState<Rect | null>(null)
  const [ratio, setRatio] = useState<number | null>(null)
  const [dragFrom, setDragFrom] = useState<{ x: number; y: number } | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)

  /**
   * Object URLs this component created and therefore must revoke.
   *
   * Kept in a ref rather than derived from state because the cleanup runs when
   * state is already frozen; revoking from a `setStack` updater would leak
   * whichever URLs React decided not to re-render.
   */
  const ownedRef = useRef<string[]>([])

  const current = stack.at(-1)

  const release = useCallback((objectUrl: string) => {
    URL.revokeObjectURL(objectUrl)
    ownedRef.current = ownedRef.current.filter((item) => item !== objectUrl)
  }, [])

  const push = useCallback((next: Snapshot) => {
    setStack((list) => {
      const previous = list.at(-1)
      // The original belongs to the caller; everything after it is ours.
      if (previous?.owned === true) release(previous.url)
      return [...list, next]
    })
  }, [release])

  // Measure the incoming picture so the first frame already knows its size, and
  // can be the true original — undo back to here must not be a re-encode.
  useEffect(() => {
    let cancelled = false
    setError('')
    void loadImage(url)
      .then(({ width, height }) => {
        if (cancelled) return
        setStack([{ blob: null, url, owned: false, width, height, label: '原图' }])
        // 直接从工具栏的「裁剪」进来时，先把框摆成整张图：
        // 空着的画面上没有可拖的边界，人不知道从哪里开始。
        if (startCropping) setCropRect({ x: 0, y: 0, w: width, h: height })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '这张图片读不出来')
      })
    return () => { cancelled = true }
  }, [startCropping, url])

  // Release everything we still own when the editor goes away.
  useEffect(() => () => {
    for (const objectUrl of ownedRef.current) URL.revokeObjectURL(objectUrl)
    ownedRef.current = []
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Esc leaves crop mode first: closing the whole editor because you wanted
      // out of a rectangle would throw away every step before it.
      if (cropMode) { setCropMode(false); setCropRect(null); setRatio(null); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [cropMode, onClose])

  const display = useMemo(() => {
    if (current === undefined) return { w: 0, h: 0, scale: 1 }
    const budgetW = Math.min(window.innerWidth * 0.62, 900)
    const budgetH = Math.min(window.innerHeight * 0.56, 620)
    // Never scale above 1: enlarging a picture to inspect it only adds blur.
    const scale = Math.min(budgetW / current.width, budgetH / current.height, 1)
    return { w: current.width * scale, h: current.height * scale, scale }
  }, [current])

  /** Run one edit against the current picture and push the result. */
  const apply = useCallback(async (ops: Parameters<typeof transformImage>[1], label: string) => {
    if (current === undefined || busy) return
    setBusy(true)
    setError('')
    let objectUrl = ''
    try {
      const blob = await transformImage(current.url, ops)
      objectUrl = URL.createObjectURL(blob)
      const { width, height } = await loadImage(objectUrl)
      ownedRef.current.push(objectUrl)
      push({ blob, url: objectUrl, owned: true, width, height, label })
      setCropMode(false)
      setCropRect(null)
      setRatio(null)
    } catch (cause) {
      if (objectUrl !== '') URL.revokeObjectURL(objectUrl)
      setError(cause instanceof Error ? cause.message : '这一步没做成')
    } finally {
      setBusy(false)
    }
  }, [busy, current, push])

  const undo = useCallback(() => {
    const last = stack.at(-1)
    if (last === undefined || stack.length <= 1) return
    if (last.owned) release(last.url)
    setStack((list) => list.slice(0, -1))
    setCropMode(false)
    setCropRect(null)
    setRatio(null)
    setError('')
  }, [release, stack])

  /** Pointer position as image pixels. */
  const pointAt = useCallback((event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const layer = layerRef.current
    if (layer === null) return null
    const box = layer.getBoundingClientRect()
    // The layer is exactly the displayed picture, so this needs no offset term —
    // only the display-to-image scale.
    return {
      x: (event.clientX - box.left) / display.scale,
      y: (event.clientY - box.top) / display.scale,
    }
  }, [display.scale])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!cropMode || current === undefined) return
    const point = pointAt(event)
    if (point === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragFrom(point)
    setCropRect({ x: point.x, y: point.y, w: 0, h: 0 })
  }, [cropMode, current, pointAt])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragFrom === null || current === undefined) return
    const point = pointAt(event)
    if (point === null) return
    setCropRect(clampRect(normalizeRect(dragFrom, point), { w: current.width, h: current.height }))
  }, [current, dragFrom, pointAt])

  const onPointerUp = useCallback(() => { setDragFrom(null) }, [])

  const chooseRatio = useCallback((value: number | null) => {
    setRatio(value)
    if (value === null || current === undefined) return
    const bounds = { w: current.width, h: current.height }
    const base = cropRect !== null && isUsable(cropRect)
      ? cropRect
      // No rectangle drawn yet: start from the whole picture, not from nothing.
      : { x: 0, y: 0, w: current.width, h: current.height }
    setCropRect(fitAspect(base, value, bounds))
  }, [cropRect, current])

  const note = stack.slice(1).map((item) => item.label).join('、')
  const changed = stack.length > 1

  return (
    <div className="image-editor" role="dialog" aria-label="编辑画面" data-testid="image-editor">
      <div className="preview-scrim" onClick={onClose} />
      <div className="editor-body">
        <header>
          <span className="editor-title">编辑这张画面</span>
          {current === undefined
            ? null
            : <span className="muted" data-testid="editor-size">{current.width} × {current.height}</span>}
          <span className="editor-steps muted">{stack.slice(1).map((item) => item.label).join(' → ')}</span>
          <button type="button" className="link" disabled={!changed || busy} title="退回到上一步" onClick={undo}>撤销一步</button>
          <button type="button" className="link preview-close" title="关闭（Esc）" onClick={onClose}>✕</button>
        </header>

        {error === '' ? null : <p className="editor-error" role="alert">{error}</p>}

        <div className="editor-stage">
          {current === undefined
            ? <p className="muted">正在读取画面…</p>
            : (
              <div
                className={`editor-frame${cropMode ? ' is-cropping' : ''}`}
                ref={layerRef}
                style={{ width: display.w, height: display.h }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <img src={current.url} alt="正在编辑的画面" draggable={false} />
                {cropRect === null || !cropMode ? null : (
                  <>
                    {/* Four shades instead of one translucent box: 「留下的是哪块」
                        has to be obvious, and a tint over a picture is not. */}
                    <div className="crop-shade" style={{ left: 0, top: 0, width: display.w, height: cropRect.y * display.scale }} />
                    <div className="crop-shade" style={{ left: 0, top: (cropRect.y + cropRect.h) * display.scale, width: display.w, height: Math.max(0, display.h - (cropRect.y + cropRect.h) * display.scale) }} />
                    <div className="crop-shade" style={{ left: 0, top: cropRect.y * display.scale, width: cropRect.x * display.scale, height: cropRect.h * display.scale }} />
                    <div className="crop-shade" style={{ left: (cropRect.x + cropRect.w) * display.scale, top: cropRect.y * display.scale, width: Math.max(0, display.w - (cropRect.x + cropRect.w) * display.scale), height: cropRect.h * display.scale }} />
                    <div
                      className="crop-rect"
                      style={{
                        left: cropRect.x * display.scale,
                        top: cropRect.y * display.scale,
                        width: cropRect.w * display.scale,
                        height: cropRect.h * display.scale,
                      }}
                      data-testid="crop-rect"
                    >
                      <span className="crop-size">{Math.round(cropRect.w)} × {Math.round(cropRect.h)}</span>
                    </div>
                  </>
                )}
              </div>
            )}
        </div>

        <div className="editor-tools">
          <span className="tool-group">
            <button type="button" className="link" disabled={current === undefined || busy} title="左转 90 度"
              onClick={() => { void apply({ rotate: -90 }, '左转 90°') }}>↺ 左转</button>
            <button type="button" className="link" disabled={current === undefined || busy} title="右转 90 度"
              onClick={() => { void apply({ rotate: 90 }, '右转 90°') }}>↻ 右转</button>
            <button type="button" className="link" disabled={current === undefined || busy} title="旋转 180 度"
              onClick={() => { void apply({ rotate: 180 }, '旋转 180°') }}>↕ 180°</button>
          </span>
          <span className="tool-group">
            <button type="button" className="link" disabled={current === undefined || busy} title="水平翻转"
              onClick={() => { void apply({ flipX: true }, '水平翻转') }}>⇋ 水平</button>
            <button type="button" className="link" disabled={current === undefined || busy} title="垂直翻转"
              onClick={() => { void apply({ flipY: true }, '垂直翻转') }}>⇅ 垂直</button>
          </span>
          <span className="tool-group">
            <button type="button" className={`link${cropMode ? ' is-on' : ''}`} disabled={current === undefined || busy}
              title="在画面上拖出要保留的区域"
              onClick={() => {
                if (cropMode) { setCropMode(false); setCropRect(null); setRatio(null); return }
                setCropMode(true)
                if (current !== undefined) setCropRect({ x: 0, y: 0, w: current.width, h: current.height })
              }}>▣ 裁剪</button>
          </span>
        </div>

        {!cropMode ? null : (
          <div className="crop-bar">
            <span className="muted">拖出要保留的区域</span>
            {RATIOS.map((item) => (
              <button
                type="button"
                key={item.label}
                className={`link${ratio === item.value ? ' is-on' : ''}`}
                onClick={() => { chooseRatio(item.value) }}
              >{item.label}</button>
            ))}
            <button
              type="button"
              className="link primary-link"
              disabled={cropRect === null || !isUsable(cropRect) || busy}
              onClick={() => {
                if (cropRect === null) return
                void apply({ crop: cropRect }, `裁剪 ${String(Math.round(cropRect.w))}×${String(Math.round(cropRect.h))}`)
              }}
            >应用裁剪</button>
          </div>
        )}

        <footer>
          <span className="muted">{changed ? `已改：${note}` : '还没改动'}</span>
          <button type="button" className="link" onClick={onClose}>取消</button>
          <button
            type="button"
            className="link primary-link"
            data-testid="editor-save"
            disabled={!changed || busy}
            title={changed ? '存成这张画面的新版本' : '先做一步改动'}
            onClick={() => {
              const blob = current?.blob
              if (blob === null || blob === undefined) return
              void onSave(blob, note)
            }}
          >{busy ? '处理中…' : '存为新版本'}</button>
        </footer>
      </div>
    </div>
  )
}
