import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import App from './App.vue'
import router from './router'
import { installViewportFit } from './utils/viewport-fit'

// 让整页高度跟随「实际可见区域」：页面级缩放（CSS zoom）下 CSS 的 100vh 不会重算，
// 会把整页渲染成视口高的 1/N，下方留白。详见 utils/viewport-fit.js
installViewportFit()

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')
