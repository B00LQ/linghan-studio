/**
 * 主题（跟随系统 / 亮 / 暗）。
 *
 * 三件事，都是刻意的：
 *
 * 1. **默认跟随系统**（`auto`）。用户机器是浅色就该是浅色，而不是我们替他决定。
 * 2. **解析完再写到 `data-theme` 上**，CSS 里就只需要「深色一套、浅色一套」，
 *    不用在 `@media (prefers-color-scheme: light)` 里把整套 token 再抄一遍
 *    （抄两遍迟早有一遍忘了改）。
 * 3. **首屏之前就定下来**：真正的第一帧由 `index.html` 里那段内联脚本负责，
 *    这个模块只负责「改」与「跟着系统变」—— 否则浅色用户会先看到一帧深色。
 */
import { useEffect, useState } from 'react'

/** 用户的选择。`auto` = 跟着系统走。 */
export type ThemePref = 'auto' | 'light' | 'dark'

/** 实际生效的那一套。 */
export type ThemeResolved = 'light' | 'dark'

/** localStorage 的键（内联脚本里也硬编码了同一个字符串，改一处要改两处）。 */
const KEY = 'studio.theme'

/** 读用户的选择；读不到（或值坏了）就当没选过。 */
export function readThemePref(): ThemePref {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'auto'
  } catch {
    return 'auto'
  }
}

/** 系统现在是哪一套。 */
export function systemTheme(): ThemeResolved {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** 用户的偏好最终落到哪一套。 */
export function resolveTheme(pref: ThemePref): ThemeResolved {
  return pref === 'auto' ? systemTheme() : pref
}

/** 把某一套写进 `<html data-theme>`。 */
export function applyTheme(resolved: ThemeResolved): void {
  document.documentElement.dataset.theme = resolved
}

/** 存下偏好并立刻生效。 */
export function setThemePref(pref: ThemePref): ThemeResolved {
  try {
    if (pref === 'auto') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, pref)
  } catch { /* 隐私模式下写不了：不影响这次生效 */ }
  const resolved = resolveTheme(pref)
  applyTheme(resolved)
  return resolved
}

/**
 * 跟着系统变（只在用户选了 `auto` 时才有影响）。
 * @param onChange - 系统主题变了之后要做的事（通常是重画设置页那三个选项的高亮）。
 * @returns 取消订阅。
 */
export function watchSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const handler = (): void => {
    if (readThemePref() !== 'auto') return
    applyTheme(systemTheme())
    onChange()
  }
  media.addEventListener('change', handler)
  return () => { media.removeEventListener('change', handler) }
}

/**
 * 现在生效的是哪一套（跟着 `<html data-theme>` 走）。
 *
 * 给那些**必须拿到具体值**的地方用：React Flow 的 `colorMode` 与缩略图的配色
 * 是 JS 属性，读不到 CSS 变量 —— 它们靠这个 hook 在切主题时重新渲染。
 * @returns `'light'` 或 `'dark'`。
 */
export function useThemeResolved(): ThemeResolved {
  const read = (): ThemeResolved => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [value, setValue] = useState<ThemeResolved>(read)
  useEffect(() => {
    const observer = new MutationObserver(() => { setValue(read()) })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    setValue(read())
    return () => { observer.disconnect() }
  }, [])
  return value
}
