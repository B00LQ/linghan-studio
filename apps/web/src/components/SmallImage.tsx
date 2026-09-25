/**
 * 小图：先要服务端的缩略图，做不出来就退回原图。
 *
 * 缩略图是**优化，不是功能**：服务端手写的解码器只认 PNG（JPEG 要一整个基线解码器，
 * 隔行与调色板 PNG 也不认），那些情况它会回 404 —— `onError` 里换成原图，
 * 界面因此永远有图可看，只是慢一点。**给一张错的缩略图比不给更糟**，所以宁可退。
 */
import { useEffect, useState } from 'react'
import { thumbUrl } from '../api.ts'

/** Props for {@link SmallImage}. */
export interface SmallImageProps {
  /** Asset to show. */
  assetId: string
  /** 长边上限；格子越大给得越大（按 2x 屏留余量）。 */
  size?: number
  className?: string
  alt?: string
  /** 长列表里让它懒加载。 */
  loading?: 'lazy' | 'eager'
  /** 有些地方点小图要做事（并排对比里点一下放大）。 */
  onClick?: () => void
  /** 悬停说明。 */
  title?: string
}

/**
 * Render a small preview of one asset.
 * @param props - see {@link SmallImageProps}.
 * @returns the image element.
 */
export function SmallImage({ assetId, size = 320, className, alt = '', loading = 'lazy', onClick, title }: SmallImageProps) {
  const [src, setSrc] = useState(() => thumbUrl(assetId, size))
  // 换素材要重新试一次缩略图：别把上一张的失败记在下一张头上。
  useEffect(() => { setSrc(thumbUrl(assetId, size)) }, [assetId, size])
  return (
    <img
      src={src}
      className={className}
      alt={alt}
      title={title}
      loading={loading}
      decoding="async"
      {...(onClick === undefined ? {} : { onClick })}
      onError={() => {
        const original = `/api/assets/${assetId}`
        setSrc((current) => (current === original ? current : original))
      }}
    />
  )
}
