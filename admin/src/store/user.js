import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authApi, setAccessToken, clearAccessToken, getAccessToken } from '@/api'

const USER_KEY = 'user_info'
const MUST_CHANGE_KEY = 'must_change_password'

/**
 * 用户状态
 * token 统一由 api/index.js 管理（localStorage key: access_token）
 */
export const useUserStore = defineStore('user', () => {
  const token = ref(getAccessToken())
  const userInfo = ref(JSON.parse(localStorage.getItem(USER_KEY) || 'null'))
  const roles = ref((userInfo.value && userInfo.value.roles) || [])
  // 首次登录（初始密码未改）时后端会打标记，未改密前除改密页外一律 403
  const mustChangePassword = ref(localStorage.getItem(MUST_CHANGE_KEY) === '1')

  const isLoggedIn = computed(() => !!token.value)
  const displayName = computed(() => {
    const u = userInfo.value
    if (!u) return '未登录'
    return u.real_name || u.nickname || u.username || '未命名用户'
  })

  function persist(user) {
    userInfo.value = user || null
    roles.value = (user && user.roles) || []
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user))
    else localStorage.removeItem(USER_KEY)
  }

  /** 写入/清除「必须改密」标记 */
  function setMustChange(flag) {
    mustChangePassword.value = !!flag
    if (flag) localStorage.setItem(MUST_CHANGE_KEY, '1')
    else localStorage.removeItem(MUST_CHANGE_KEY)
  }

  function clearMustChange() {
    setMustChange(false)
  }

  /**
   * 后台账号密码登录
   * 成功：写入令牌与用户信息（含 roles）
   * 失败：抛出中文原因由调用方提示（如「账号或密码错误」）
   */
  async function login(username, password) {
    try {
      const res = await authApi.adminLogin({ username, password })
      const data = res.data || {}
      setAccessToken(data.token)
      token.value = data.token || ''
      persist(data.user)
      setMustChange(!!data.must_change_password)
      return {
        success: true,
        user: data.user,
        roles: data.roles || [],
        mustChangePassword: !!data.must_change_password
      }
    } catch (err) {
      // 登录失败时清空残留登录态
      clearAccessToken()
      token.value = ''
      persist(null)
      setMustChange(false)
      return { success: false, message: err.message || '登录失败' }
    }
  }

  /** 拉取最新用户信息（校验令牌是否仍然有效） */
  async function refresh() {
    if (!token.value) return false
    try {
      const res = await authApi.getUserInfo()
      persist(res.data)
      return true
    } catch (err) {
      logout()
      return false
    }
  }

  /** 退出登录：清令牌 + 清状态 */
  function logout() {
    clearAccessToken()
    token.value = ''
    persist(null)
    setMustChange(false)
  }

  /** 角色判断 */
  function hasRole(...names) {
    return names.some((n) => roles.value.includes(n))
  }

  return {
    token,
    userInfo,
    roles,
    isLoggedIn,
    displayName,
    mustChangePassword,
    setMustChange,
    clearMustChange,
    login,
    logout,
    refresh,
    hasRole
  }
})
