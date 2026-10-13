<template>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <h1>胜龙进销存</h1>
        <p>后台管理系统</p>
      </div>

      <el-form :model="form" class="login-form">
        <el-form-item>
          <el-input
            v-model="form.username"
            placeholder="用户名"
            prefix-icon="User"
            size="large"
          />
        </el-form-item>

        <el-form-item>
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            prefix-icon="Lock"
            size="large"
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-form-item>
          <el-button
            type="primary"
            size="large"
            class="login-btn"
            :loading="loading"
            @click="handleLogin"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>

      <div class="login-footer">
        <p>仅限胜龙汽配内部使用</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import { canAccessPath, roleHome } from '@/constants/menu'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const loading = ref(false)
const form = ref({
  username: '',
  password: ''
})

async function handleLogin() {
  if (!form.value.username || !form.value.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }

  loading.value = true

  try {
    const result = await userStore.login(form.value.username, form.value.password)
    if (result.success) {
      ElMessage.success('登录成功')
      /*
       * 登录后去哪儿：
       *   ① 无权限页的 redirect 目标一律不理（否则仓管被 /user/list 的 redirect 带进去，
       *      守卫再把他弹回首页 + 弹一句「没权限」，白挨一次警告）；
       *   ② 其余情况只认「这个角色自己的首页」——仓管/厂长/采购各自落自己那套界面。
       */
      const roles = result.roles || []
      const redirect = route.query.redirect ? String(route.query.redirect) : ''
      const home = roleHome(roles)
      // 带查询串的 redirect（如 /material/list?keyword=x）要拿纯路径去做权限判断
      const redirectPath = redirect.split('?')[0].split('#')[0]
      router.replace(redirect && canAccessPath(redirectPath, roles) ? redirect : home)
    } else {
      // store 已捕获接口错误，message 即后端返回的中文原因（如「账号或密码错误」）
      ElMessage.error(result.message || '登录失败')
    }
  } catch (err) {
    ElMessage.error(err.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-container {
  /* --app-h 由 utils/viewport-fit.js 同步；取不到时退回 100vh */
  min-height: var(--app-h, 100vh);
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
}

.login-card {
  width: 400px;
  background: #fff;
  border-radius: 16px;
  padding: 48px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.login-header {
  text-align: center;
  margin-bottom: 40px;
}

.login-header h1 {
  font-size: 28px;
  color: #1a1a2e;
  margin-bottom: 8px;
}

.login-header p {
  font-size: 14px;
  color: #999;
}

.login-form {
  margin-top: 20px;
}

.login-btn {
  width: 100%;
  background: #1a1a2e;
  border-color: #1a1a2e;
}

.login-btn:hover {
  background: #2a2a4e;
  border-color: #2a2a4e;
}

.login-footer {
  text-align: center;
  margin-top: 30px;
  padding-top: 20px;
  border-top: 1px solid #f0f0f0;
}

.login-footer p {
  font-size: 12px;
  color: #999;
}
</style>
