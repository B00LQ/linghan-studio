/** Browser entry point. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App.tsx'

const container = document.getElementById('root')
if (container === null) throw new Error('缺少 #root 容器')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
