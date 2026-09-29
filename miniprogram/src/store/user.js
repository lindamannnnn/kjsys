// 用户状态管理
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { callCloud, loginWithWechat, getToken, clearToken, setToken } from '@/utils/cloud'

export const useUserStore = defineStore('user', () => {
  // 状态
  const openid = ref('')
  const userInfo = ref(null)
  const roles = ref([])
  const isLoggedIn = ref(false)
  const isLoading = ref(false)

  // 计算属性
  const isBoss = computed(() => roles.value.includes('boss'))
  const isOut = computed(() => roles.value.includes('out'))
  const isIn = computed(() => roles.value.includes('in'))
  const isPurchase = computed(() => roles.value.includes('purchase'))
  const isStorekeeper = computed(() => roles.value.includes('storekeeper'))
  const isAdmin = computed(() => roles.value.includes('admin'))
  const isPending = computed(() => userInfo.value?.status === 'pending')
  const realName = computed(() => userInfo.value?.real_name || '')

  /**
   * 与后端一致的「我是谁」标识
   * 后端写入操作人时用 openid || username，前端判断"是不是我自己的单"也必须用同一规则，
   * 否则用账号密码登录（openid 为空）的人会看不到自己的撤销/改价按钮
   */
  const identity = computed(() => openid.value || userInfo.value?.username || '')
  const isManager = computed(() => roles.value.includes('boss') || roles.value.includes('admin'))

  /** 是否拥有任一角色（admin 视为全权） */
  function hasRole(list) {
    if (!list || !list.length) return true
    if (roles.value.includes('admin')) return true
    return list.some((r) => roles.value.includes(r))
  }

  /** 统一写入登录结果 */
  function applyLoginResult(res) {
    if (!res) return
    if (res.token) setToken(res.token)
    openid.value = res.openid || ''
    userInfo.value = res.user || null
    roles.value = res.roles || res.user?.roles || []
    isLoggedIn.value = true
  }

  /**
   * 检查登录状态
   * 本地有令牌时向后端确认一次；没有令牌时直接判定未登录
   */
  async function checkLogin() {
    if (!getToken()) {
      isLoggedIn.value = false
      return false
    }

    isLoading.value = true
    try {
      const res = await callCloud('auth', 'login')
      applyLoginResult(res)
      return true
    } catch (err) {
      console.log('登录态已失效', err)
      isLoggedIn.value = false
      if (err.code === 401) clearToken()
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 登录
   * 正式环境走 wx.login → 后端 code2session → openid
   * 开发模式（utils/cloud.js 里 DEV_MODE=true）直接用测试身份
   */
  async function login() {
    isLoading.value = true
    try {
      const res = await loginWithWechat()
      applyLoginResult(res)
      return res
    } catch (err) {
      console.error('登录失败', err)
      isLoggedIn.value = false
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /** 首次注册：提交真实姓名与手机号 */
  async function register(data) {
    const res = await callCloud('auth', 'register', data)
    if (res && res.user) {
      userInfo.value = res.user
      roles.value = res.user.roles || []
    }
    return res
  }

  /** 更新用户资料 */
  async function updateProfile(data) {
    const res = await callCloud('auth', 'updateProfile', data)
    userInfo.value = { ...(userInfo.value || {}), ...data }
    return res
  }

  /** 刷新用户信息（审核通过后可立即生效，无需重新登录） */
  async function refreshUser() {
    try {
      const user = await callCloud('auth', 'getUserInfo')
      if (user) {
        userInfo.value = user
        roles.value = user.roles || []
      }
      return user
    } catch (err) {
      console.warn('刷新用户信息失败', err)
      return null
    }
  }

  /** 退出登录 */
  function logout() {
    clearToken()
    openid.value = ''
    userInfo.value = null
    roles.value = []
    isLoggedIn.value = false
  }

  return {
    openid,
    userInfo,
    roles,
    isLoggedIn,
    isLoading,
    isBoss,
    isOut,
    isIn,
    isPurchase,
    isStorekeeper,
    isAdmin,
    isPending,
    realName,
    identity,
    isManager,
    hasRole,
    checkLogin,
    login,
    register,
    updateProfile,
    refreshUser,
    logout
  }
})
