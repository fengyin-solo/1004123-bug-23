import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { bindSession, reconcileStorage } from './api/local-service'
import { useSessionStore } from './stores/session'
import './styles/global.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// 动作流转统一从会话里取操作人，只读角色执行写操作在数据层被拒绝。
const session = useSessionStore(pinia)
bindSession(() => ({ operator: session.operator, role: session.role }))
// 先修正历史脏数据（镜像状态、残留标记、重复条目），再挂页面。
reconcileStorage()

app.use(router)
app.mount('#app')
