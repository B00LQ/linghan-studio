/** Browser entry point. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App.tsx'
import { applyTheme, readThemePref, resolveTheme } from './theme.ts'

// 首帧由 index.html 里那段内联脚本定；这里补一次，保证刷新/热更新之后也一致。
applyTheme(resolveTheme(readThemePref()))

const container = document.getElementById('root')
if (container === null) throw new Error('缺少 #root 容器')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
