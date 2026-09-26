/**
 * 外观三选一（跟随系统 / 浅色 / 深色）。
 *
 * 放在设置窗的标题栏上：**改外观的时候要能同时看见界面本身**。
 * 藏进设置页第三屏的话，用户得「改一下 → 退出去看 → 不满意 → 再进来」，那是折磨。
 */
import { useEffect, useState } from 'react'
import { readThemePref, setThemePref, watchSystemTheme, type ThemePref } from '../theme.ts'

/** 三个选项的文案。顺序就是界面顺序：默认那项在最前。 */
const CHOICES: readonly (readonly [ThemePref, string])[] = [
  ['auto', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
]

/**
 * 渲染外观选择器。
 * @returns the switcher.
 */
export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(readThemePref())

  // 选了「跟随系统」时，系统换了主题要把高亮跟上（否则高亮与实际情况会不一致）。
  useEffect(() => watchSystemTheme(() => { setPref(readThemePref()) }), [])

  return (
    <div className="theme-choices" role="radiogroup" aria-label="外观">
      {CHOICES.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={pref === id}
          className={pref === id ? 'active' : ''}
          onClick={() => { setPref(setThemePref(id)) }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
