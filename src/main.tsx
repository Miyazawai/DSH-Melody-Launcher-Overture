import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { bootstrapLauncherApi } from './api/client'
import './styles.css'

// API 先解析完再挂载：浏览器演示模式要等那份 demo 数据拉下来，
// 否则首屏组件里任何一次 resolveLauncherApi() 都会拿到空实现。
void bootstrapLauncherApi().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
