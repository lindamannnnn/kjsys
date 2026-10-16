<template>
  <view class="container">
    <!-- 顶部标题 -->
    <view class="header">
      <text class="title">胜龙进销存</text>
      <text class="subtitle">{{ companyName }}</text>
    </view>

    <!-- 加载中 -->
    <view v-if="isLoading" class="loading">
      <text>加载中...</text>
    </view>

    <!-- 未登录：先展示系统介绍，不做登录墙（审核要求：先让用户了解，再要求登录） -->
    <view v-else-if="!isLoggedIn" class="intro">
      <view class="intro-card">
        <text class="intro-lead">单位内部物资出入库管理系统</text>
        <text class="intro-text">
          本系统用于记录和管理使用单位自有物资的入库、领料出库、库存盘点与库存账目，
          让每一笔物资的流向都能追溯到经手人，方便使用单位内部对账与管理。
        </text>
      </view>

      <text class="section-title">系统功能</text>
      <view class="feature-list">
        <view class="feature-item">
          <text class="feature-icon">🟢</text>
          <view class="feature-main">
            <text class="feature-name">领料出库</text>
            <text class="feature-desc">领料员提交清单，仓管确认拣货，到场收货后出库</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">🔵</text>
          <view class="feature-main">
            <text class="feature-name">入库登记</text>
            <text class="feature-desc">物资到货入库，系统自动核算加权成本</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">🛒</text>
          <view class="feature-main">
            <text class="feature-name">采购任务</text>
            <text class="feature-desc">仓管发起采购，采购员购买后交回仓库收料入库</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">📦</text>
          <view class="feature-main">
            <text class="feature-name">仓管工作台</text>
            <text class="feature-desc">待办单据审核、驳回与库存查看</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">📋</text>
          <view class="feature-main">
            <text class="feature-name">库存盘点</text>
            <text class="feature-desc">发起盘点任务，盘点差异需审核通过后生效</text>
          </view>
        </view>
        <view class="feature-item">
          <text class="feature-icon">📒</text>
          <view class="feature-main">
            <text class="feature-name">库存流水</text>
            <text class="feature-desc">每笔出入库可追溯，支持按物料对账核账</text>
          </view>
        </view>
      </view>

      <view class="intro-card notice-card-plain">
        <text class="notice-title-plain">使用说明</text>
        <text class="notice-text-plain">
          本系统仅面向使用单位内部人员开放使用，不面向社会公众提供服务。
          首次使用时请用微信登录并填写真实姓名，由管理员审核通过、分配岗位权限后即可开始使用。
        </text>
      </view>

      <button class="btn-login" @click="goLogin">员工登录</button>

      <view class="legal-links">
        <text class="legal-link" @click="openDoc('user')">《用户服务协议》</text>
        <text class="legal-plain">·</text>
        <text class="legal-link" @click="openDoc('privacy')">《隐私政策》</text>
      </view>
    </view>

    <!-- 待审核 -->
    <view v-else-if="isPending" class="pending-prompt">
      <text class="prompt-text">账号审核中</text>
      <text class="prompt-sub">请等待管理员审核</text>
    </view>

    <!-- 已登录，显示角色入口 -->
    <view v-else class="logged-in">
      <!-- 待收货提醒：仓管已拣完货，等本人到场确认；确认后系统才扣库存 -->
      <view v-if="receivingList.length" class="notice-card receive-card" @click="showReceiving">
        <text class="notice-icon">📦</text>
        <view class="notice-main">
          <text class="notice-title">你有 {{ receivingList.length }} 张领料单待收货</text>
          <text class="notice-sub">
            {{ receivingList[0].order_no }} · {{ receivingList[0].warehouse_name || '仓库' }} 已拣货完成
          </text>
        </view>
        <text class="notice-arrow">›</text>
      </view>

      <!-- 被驳回提醒：提交人能立刻知道单子被退回、为什么退 -->
      <view v-if="notices.length" class="notice-card" @click="showNotices">
        <text class="notice-icon">⚠️</text>
        <view class="notice-main">
          <text class="notice-title">你有 {{ notices.length }} 张出库单被驳回</text>
          <text class="notice-sub">
            {{ notices[0].order_no }} · {{ notices[0].reject_reason || '未填写原因' }}
          </text>
        </view>
        <text class="notice-arrow">›</text>
      </view>

      <view class="role-grid">
        <!-- 车间入口 -->
        <view v-if="isOut" class="role-card role-card-out" @click="goOut">
          <view class="role-icon">🟢</view>
          <text class="role-title">领料出库</text>
          <text class="role-desc">领料员使用</text>
        </view>

        <!-- 报废入口（独立出来，不藏在出库类型里：照片+原因必填） -->
        <view v-if="isOut" class="role-card role-card-scrap" @click="goScrap">
          <view class="role-icon">🔴</view>
          <text class="role-title">报废申请</text>
          <text class="role-desc">物料损坏报废，需拍照</text>
        </view>

        <!-- 仓库入口（入库归仓管员：原「入库员 in」角色已并入 storekeeper） -->
        <view v-if="isStorekeeper" class="role-card role-card-in" @click="goIn">
          <view class="role-icon">🔵</view>
          <text class="role-title">入库登记</text>
          <text class="role-desc">仓库管理员使用</text>
        </view>

        <!-- 采购员入口：领任务 → 采购录入（只管买，不碰库存） -->
        <view v-if="isPurchase" class="role-card role-card-purchase" @click="goPurchase">
          <view class="role-icon">🛒</view>
          <text class="role-title">采购任务</text>
          <text class="role-desc">领取任务、录入单价与单号</text>
          <!-- 有新任务就报数（2026-10-09）：登录后停在首页，这个角标是
               采购员第一眼看到「有新活」的地方；列表页 tab 上另有数字 -->
          <view v-if="purchaseNew > 0" class="role-badge">{{ purchaseNew > 99 ? '99+' : purchaseNew }}</view>
        </view>

        <!-- 仓管员入口 -->
        <view v-if="isStorekeeper" class="role-card role-card-storekeeper" @click="goStorekeeper">
          <view class="role-icon">📦</view>
          <text class="role-title">仓管工作台</text>
          <text class="role-desc">确认、拣货、收料入库</text>
          <!-- 待办角标（2026-10-09 取消自动跳页后补）：
               现在登录停在首页，仓管不进工作台就看不到待办数，
               所以把「待确认+待拣货」直接挂在这张卡上 -->
          <view v-if="skTodo > 0" class="role-badge">{{ skTodo > 99 ? '99+' : skTodo }}</view>
        </view>

        <!-- 采购任务（仓管发起）：只对配件仓管/厂长/管理员显示（成品仓不需要采购） -->
        <view v-if="canCreatePurchase" class="role-card role-card-purchase" @click="goPurchaseTasks">
          <view class="role-icon">📝</view>
          <text class="role-title">发起采购</text>
          <text class="role-desc">发布采购任务给采购员</text>
        </view>

        <!-- 管理看板入口（老板 / 厂长可见；厂长落地页也是这里） -->
        <view v-if="hasRole(['boss', 'director'])" class="role-card role-card-boss" @click="goBoss">
          <view class="role-icon">🟡</view>
          <text class="role-title">{{ boardTitle }}</text>
          <text class="role-desc">{{ boardDesc }}</text>
        </view>

        <!-- 厂长入口：成品仓出库（2026-10-10 应用户要求从经营看板挪到首页，
             首页才是厂长的落点，发起动作不该藏在看板里）。
             只对「纯厂长」显示（与后端 assertDirectorWarehouse 同口径：带 boss/admin 的不算）；
             进去锁死成品仓、类型只有销售/领用，拣完货发消息回来让厂长确认 -->
        <view v-if="canFinishOut" class="role-card role-card-finishout" @click="goFinishOut">
          <view class="role-icon">🚚</view>
          <text class="role-title">成品仓出库</text>
          <text class="role-desc">发起出库，拣完通知你确认</text>
        </view>

        <!-- 盘点入口（仓库和老板可见） -->
        <view v-if="hasRole(['storekeeper', 'director'])" class="role-card role-card-check" @click="goCheck">
          <view class="role-icon">📋</view>
          <text class="role-title">库存盘点</text>
          <text class="role-desc">盘点任务与录入</text>
        </view>

        <!-- 库存流水（采购对账、仓管核流水、老板查账都能用） -->
        <view
          v-if="hasRole(['purchase', 'storekeeper', 'boss', 'director'])"
          class="role-card role-card-ledger"
          @click="goLedger"
        >
          <view class="role-icon">📒</view>
          <text class="role-title">库存流水</text>
          <text class="role-desc">每笔出入库可追溯</text>
        </view>
      </view>
    </view>

    <!-- 消息中心入口（流程重构 V2 · P1）：未读数红点 -->
    <view v-if="isLoggedIn && !isPending" class="msg-entry" @click="goMessage">
      <text class="msg-entry-icon">🔔</text>
      <text class="msg-entry-text">消息</text>
      <view v-if="unreadCount > 0" class="msg-badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</view>
      <text class="msg-entry-arrow">›</text>
    </view>

    <!-- 底部用户信息 -->
    <view v-if="isLoggedIn && !isPending" class="user-info">
      <text class="user-name">{{ userInfo?.real_name || userInfo?.nickname || '未设置姓名' }}</text>
      <text class="user-role">{{ roleText }}</text>
      <text class="user-warehouse">{{ warehouseText }}</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { useUserStore } from '@/store/user'
import { warehouseApi, outboundApi, inboundApi, messageApi, purchaseApi } from '@/utils/api'

const userStore = useUserStore()

const companyName = ref('胜龙汽配')
const warehouseList = ref([])
// 近 7 天自己提交、被仓管驳回的出库单
const notices = ref([])
// 待收货的领料单（仓管已拣完货，等本人到场确认）
const receivingList = ref([])
// 未读消息数（首页红点，流程重构 V2 · P1 消息中心）
const unreadCount = ref(0)
// 采购员可领取的新任务数（首页「采购任务」卡片右上角角标）
const purchaseNew = ref(0)
// 仓管工作台的待办数（待确认 + 待拣货），挂在「仓管工作台」卡片右上角
const skTodo = ref(0)

async function loadNotices() {
  if (!userStore.isLoggedIn) return
  try {
    const res = await outboundApi.myNotice()
    notices.value = res.rejected_list || []
    receivingList.value = res.receiving_list || []
  } catch (err) {
    // 提醒拿不到不影响主流程，安静跳过
    notices.value = []
    receivingList.value = []
  }
}

// 未读消息数：首页红点用。拿不到就当作 0，不打扰用户
async function loadUnread() {
  if (!userStore.isLoggedIn) return
  try {
    const res = await messageApi.unreadCount()
    unreadCount.value = res.unread || 0
  } catch (err) {
    unreadCount.value = 0
  }
}

// 采购员的新任务数：后端 myTodoCount 对采购员返回 can_take（可直接领取的）
// 只有采购员才需要这个数，其他角色问它要么返 0、要么是别的口径，所以先判角色再发请求
async function loadPurchaseNew() {
  if (!userStore.isLoggedIn || !userStore.isPurchase) {
    purchaseNew.value = 0
    return
  }
  try {
    const res = await purchaseApi.myTodoCount()
    purchaseNew.value = Number(res.can_take || 0)
  } catch (err) {
    purchaseNew.value = 0
  }
}

// 仓管工作台的待办数：待确认（出库+入库）+ 待拣货。
// 待收货是等领料员上门，不算仓管的待办压力（与 storekeeper/dashboard 同口径）。
async function loadSkTodo() {
  if (!userStore.isLoggedIn || !userStore.isStorekeeper) {
    skTodo.value = 0
    return
  }
  const safe = (p) => p.catch(() => ({ count: 0 }))
  try {
    const [outP, inP, outPk] = await Promise.all([
      safe(outboundApi.pendingCount()),
      safe(inboundApi.pendingCount()),
      safe(outboundApi.pickingCount())
    ])
    skTodo.value = (outP.count || 0) + (inP.count || 0) + (outPk.count || 0)
  } catch (err) {
    skTodo.value = 0
  }
}

function goMessage() {
  uni.navigateTo({ url: '/pages/message/list' })
}

/** 待收货：单张直接进详情，多张让本人挑（确认收货后系统才扣库存） */
function showReceiving() {
  const list = receivingList.value
  if (!list.length) return
  if (list.length === 1) {
    uni.navigateTo({ url: `/pages/out/detail?id=${list[0]._id}` })
    return
  }
  uni.showActionSheet({
    itemList: list.slice(0, 6).map(n => `${n.order_no}（${n.item_count || 0} 项）`),
    success: (res) => {
      const target = list[res.tapIndex]
      if (target) uni.navigateTo({ url: `/pages/out/detail?id=${target._id}` })
    }
  })
}

function showNotices() {
  const lines = notices.value
    .slice(0, 5)
    .map(n => `${n.order_no}：${n.reject_reason || '未填写原因'}（${n.reject_operator_name || '仓管'}）`)
    .join('\n')
  uni.showModal({
    title: '被驳回的出库单',
    content: lines || '暂无',
    showCancel: false,
    confirmText: '知道了'
  })
}

const isLoading = computed(() => userStore.isLoading)
const isLoggedIn = computed(() => userStore.isLoggedIn)
const isPending = computed(() => userStore.isPending)
const isOut = computed(() => userStore.isOut)
const isPurchase = computed(() => userStore.isPurchase)
const isStorekeeper = computed(() => userStore.isStorekeeper)
const userInfo = computed(() => userStore.userInfo)
const roles = computed(() => userStore.roles)

const hasRole = (list) => userStore.hasRole(list)

/**
 * 我是否管配件仓（2026-10-12）：采购任务只针对配件仓。
 * warehouseList 是后端按「我可管仓库」过滤后的结果，含 code 字段；
 * 厂长/管理员两仓都能管 → 恒 true；成品仓管 → false。
 */
const hasPartsWarehouse = computed(() =>
  warehouseList.value.some((w) => w.code === 'peijian'))

/**
 * 「发起采购」入口可见性：配件仓管 / 厂长 / 管理员。
 * 成品仓管看不到（成品不需要采购）；后端 purchase.create 也拦，这里只是提前藏入口。
 */
const canCreatePurchase = computed(() =>
  userStore.hasRole(['director']) || (userStore.isStorekeeper && hasPartsWarehouse.value))

// 老板 vs 厂长共用同一个看板页：文案要分开，否则厂长点进「老板看板」很别扭
const isPureDirector = computed(() => !userStore.hasRole(['boss']) && userStore.hasRole(['director']))
const boardTitle = computed(() => (isPureDirector.value ? '经营看板' : '老板看板'))
const boardDesc = computed(() => (isPureDirector.value ? '两仓库存与金额' : '数据查看与管理'))

const roleText = computed(() => {
  const roleMap = {
    'out': '领料员',
    'purchase': '采购员',
    'storekeeper': '仓管员',
    'director': '厂长',
    'boss': '老板',
    'admin': '管理员'
  }
  return roles.value.map(r => roleMap[r] || r).join(' / ')
})

const warehouseText = computed(() => {
  if (!warehouseList.value.length) return ''
  if (userStore.isBoss || userStore.isAdmin) return '全部仓库'

  const ids = (userInfo.value?.warehouse_ids || []).map(String)
  if (!ids.length) return '未分配仓库'

  const names = warehouseList.value
    .filter(w => ids.includes(String(w._id || w.id)))
    .map(w => w.name)

  return names.length ? names.join(' / ') : '未分配仓库'
})

function goLogin() {
  uni.navigateTo({ url: '/pages/login/login' })
}

// 打开协议页（用户服务协议 / 隐私政策）
function openDoc(type) {
  uni.navigateTo({ url: `/pages/agreement/${type}` })
}

function goOut() {
  uni.navigateTo({ url: '/pages/out/submit' })
}

function goScrap() {
  uni.navigateTo({ url: '/pages/out/scrap' })
}

function goIn() {
  uni.navigateTo({ url: '/pages/in/submit' })
}

function goPurchase() {
  // 采购员：看任务列表（可领 + 我的）
  uni.navigateTo({ url: '/pages/purchase/tasks' })
}

function goPurchaseTasks() {
  // 仓管：直接去发布采购任务
  uni.navigateTo({ url: '/pages/purchase/task-create' })
}

function goStorekeeper() {
  uni.navigateTo({ url: '/pages/storekeeper/dashboard' })
}

function goBoss() {
  uni.navigateTo({ url: '/pages/boss/dashboard' })
}

/**
 * 厂长专属「成品仓出库」（首页入口，2026-10-10 从经营看板挪来）
 * 老板是只读角色、管理员走后台，都不给这个写入口。
 * ⚠️ 这里锁死只是体验，不是防线：后端 outbound.submit 里的 assertDirectorWarehouse
 *    会按物料实际所属仓库再判一次，改 URL 参数绕不过去。
 */
const canFinishOut = computed(() =>
  userStore.hasRole(['director']) && !userStore.hasRole(['boss', 'admin']))

function goFinishOut() {
  // wh=chengpin → out/submit 锁死成品仓、隐藏切仓条、类型换成销售/领用
  uni.navigateTo({ url: '/pages/out/submit?wh=chengpin' })
}

function goCheck() {
  uni.navigateTo({ url: '/pages/check/list' })
}

function goLedger() {
  uni.navigateTo({ url: '/pages/purchase/ledger' })
}

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    warehouseList.value = res.list || []
  } catch (err) {
    console.warn('仓库加载失败', err)
  }
}

/**
 * 登录后的数据加载（首页红点/角标）
 *
 * ⚠️ 2026-10-09 修（真 bug）：原实现是 `await checkLogin()` 之后直接
 *   `if (isLoggedIn) { 一把梭加载 }`，但 App.vue 的 onLaunch 也在跑
 *   checkLogin →「没有令牌就 login()」，两边是**并发**的：
 *   页面这一侧经常先跑完 checkLogin（此刻令牌还没落盘 → 直接返回 false），
 *   于是整块加载被跳过 —— 表现就是**冷启动进首页时「消息红点 / 采购任务角标 /
 *   待收货提醒」全是空的**，退出再进（这时令牌已落盘）才正常。
 *   开发者工具里令牌常驻，所以这个竞态一直没暴露。
 *   修法：加载动作收口成 loadAfterLogin()，再加一个登录态 watch 兜底补一次。
 *
 * ⚠️ 2026-10-09 二改（用户反馈）：**取消「登录后自动推进某个页面」**。
 *   原来这里会调 autoEnterRoleHome() 把人直接送进某一个页面（领料员→提交页、
 *   采购员→任务列表、仓管→工作台、老板/厂长→看板），代价是：
 *     ① 首页会「跳一下」闪走；② 被推进单页的角色看不到首页上的
 *        「待收货提醒 / 驳回提醒 / 未读消息红点」。
 *   现在所有角色登录后都停在本页（首页已经按角色只显示自己的入口卡片），
 *   要点哪个功能自己点。`utils/role-home.js` 随之弃用删除。
 */
let loadedAfterLogin = false
function loadAfterLogin() {
  if (loadedAfterLogin || !userStore.isLoggedIn) return
  loadedAfterLogin = true
  loadWarehouses()
  loadNotices()
  loadUnread()        // 未读消息红点（从消息页返回时也会刷新）
  loadPurchaseNew()   // 采购员新任务角标（从任务列表返回时也会刷新）
  loadSkTodo()        // 仓管工作台待办角标（从工作台返回时也会刷新）
}

// App 启动登录晚于页面 onMounted 时，靠这个补上（不补就永远是空红点）
watch(() => userStore.isLoggedIn, (v) => { if (v) loadAfterLogin() })

// 首次进入即加载（onMounted 兜底，防止页面生命周期在某些端不触发导致空白）
// 之后每次页面重新显示时刷新（含从子页面返回），所以点完确认回到工作台红点会同步
const __pageShowHandler = async () => {
  await userStore.checkLogin()
  loadedAfterLogin = false   // 每次回到首页都重新拉一次（红点/角标要跟得上）
  loadAfterLogin()
}
onMounted(() => {
  __pageShowHandler()      // 首屏一定加载（onMounted 兜底，不依赖任何注册成功与否）
  onShow(__pageShowHandler)  // 之后每次页面重新显示（含从子页返回）都刷新
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  padding: 40rpx;
  background: #f5f5f5;
}

.header {
  text-align: center;
  margin-bottom: 60rpx;
  padding-top: 60rpx;

  .title {
    font-size: 48rpx;
    font-weight: bold;
    color: #1a1a2e;
    display: block;
  }

  .subtitle {
    font-size: 28rpx;
    color: #666;
    margin-top: 16rpx;
    display: block;
  }
}

.loading {
  text-align: center;
  padding: 100rpx 0;
  color: #999;
}

.pending-prompt {
  text-align: center;
  padding: 100rpx 40rpx;

  .prompt-text {
    font-size: 32rpx;
    color: #333;
    display: block;
    margin-bottom: 20rpx;
  }

  .prompt-sub {
    font-size: 26rpx;
    color: #999;
    display: block;
    margin-bottom: 40rpx;
  }
}

/* ===== 未登录时的系统介绍（审核要求：先可浏览，再登录） ===== */
.intro {
  padding-bottom: 40rpx;
}

.intro-card {
  background: #fff;
  border-radius: 20rpx;
  padding: 36rpx;
  margin-bottom: 32rpx;
  box-shadow: 0 4rpx 16rpx rgba(0, 0, 0, 0.06);

  .intro-lead {
    font-size: 32rpx;
    font-weight: bold;
    color: #1a1a2e;
    display: block;
    margin-bottom: 16rpx;
  }

  .intro-text {
    font-size: 27rpx;
    color: #555;
    line-height: 1.8;
    display: block;
  }
}

.section-title {
  font-size: 30rpx;
  font-weight: bold;
  color: #1a1a2e;
  display: block;
  margin: 8rpx 0 24rpx;
}

.feature-list {
  margin-bottom: 32rpx;
}

.feature-item {
  display: flex;
  align-items: flex-start;
  background: #fff;
  border-radius: 16rpx;
  padding: 28rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 10rpx rgba(0, 0, 0, 0.05);

  .feature-icon {
    font-size: 40rpx;
    margin-right: 22rpx;
    line-height: 1.2;
  }

  .feature-main {
    flex: 1;

    .feature-name {
      font-size: 29rpx;
      font-weight: 500;
      color: #1a1a2e;
      display: block;
      margin-bottom: 8rpx;
    }

    .feature-desc {
      font-size: 24rpx;
      color: #888;
      line-height: 1.6;
      display: block;
    }
  }
}

.notice-card-plain {
  background: #f7f8fa;
  box-shadow: none;
  border: 1rpx solid #e8e8ef;

  .notice-title-plain {
    font-size: 28rpx;
    font-weight: bold;
    color: #1a1a2e;
    display: block;
    margin-bottom: 14rpx;
  }

  .notice-text-plain {
    font-size: 25rpx;
    color: #666;
    line-height: 1.8;
    display: block;
  }
}

.btn-login {
  background: #1a1a2e;
  color: #fff;
  border-radius: 50rpx;
  padding: 28rpx;
  font-size: 32rpx;
  margin-top: 16rpx;

  &::after {
    border: none;
  }
}

.legal-links {
  text-align: center;
  margin-top: 32rpx;

  .legal-link {
    font-size: 24rpx;
    color: #0B4F95;
  }

  .legal-plain {
    font-size: 24rpx;
    color: #bbb;
    padding: 0 10rpx;
  }
}

.notice-card {
  display: flex;
  align-items: center;
  gap: 20rpx;
  background: #fff5f5;
  border: 1rpx solid #ffd6d6;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;

  /* 待收货：蓝绿色调，与「被驳回」的红色警示区分开 */
  &.receive-card {
    background: #eef8fb;
    border-color: #bfe3ee;

    .notice-title {
      color: #0c5460;
    }
  }

  .notice-icon {
    font-size: 40rpx;
  }

  .notice-main {
    flex: 1;

    .notice-title {
      font-size: 28rpx;
      color: #c0392b;
      font-weight: 500;
      display: block;
    }

    .notice-sub {
      font-size: 22rpx;
      color: #999;
      margin-top: 6rpx;
      display: block;
    }
  }

  .notice-arrow {
    font-size: 36rpx;
    color: #c0392b;
  }
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24rpx;
}

.role-card {
  background: #fff;
  border-radius: 20rpx;
  padding: 40rpx 30rpx;
  text-align: center;
  box-shadow: 0 4rpx 16rpx rgba(0, 0, 0, 0.08);
  transition: transform 0.2s;
  /* 角标定位基准（采购任务卡片右上角的数字红点） */
  position: relative;

  &:active {
    transform: scale(0.98);
  }

  /* 卡片右上角数字角标：卡片是深色渐变底、文字是白的，
     红底白字在两种底色上都能看清（不要用半透明白，会糊在渐变里） */
  .role-badge {
    position: absolute;
    top: 14rpx;
    right: 14rpx;
    min-width: 36rpx;
    height: 36rpx;
    line-height: 36rpx;
    padding: 0 12rpx;
    border-radius: 18rpx;
    background: #e74c3c;
    color: #fff;
    font-size: 22rpx;
    font-weight: bold;
    text-align: center;
    box-shadow: 0 2rpx 8rpx rgba(231, 76, 60, 0.4);
  }

  &-out {
    background: linear-gradient(135deg, #0F7A3D, #0d8a45);
  }

  &-scrap {
    background: linear-gradient(135deg, #c0392b, #d4493c);
  }

  &-in {
    background: linear-gradient(135deg, #0B4F95, #0d5cab);
  }

  &-purchase {
    background: linear-gradient(135deg, #0B4F95, #0d5cab);
  }

  &-storekeeper {
    background: linear-gradient(135deg, #2c5f2d, #3d7a3f);
  }

  &-boss {
    background: linear-gradient(135deg, #8A6A10, #a07d14);
  }

  /* 成品仓出库（厂长专属）：橙色系，与绿色的「领料出库」区分开——
     领料出库是从配件仓领料，这个是厂长从成品仓发货 */
  &-finishout {
    background: linear-gradient(135deg, #B85C0F, #D4761B);
  }

  &-check {
    background: linear-gradient(135deg, #6b5b95, #7d6ba8);
  }

  // ⚠️ 每加一类卡片都必须在这里配背景色：下面 .role-title/.role-desc 是白字，
  //    漏配就会掉回 .role-card 的白底 → 白底白字，整张卡只剩图标没有文字
  //    （「库存流水」卡就是这么消失过一轮）。
  &-ledger {
    background: linear-gradient(135deg, #157a87, #1a94a3);
  }

  .role-icon {
    font-size: 60rpx;
    margin-bottom: 20rpx;
  }

  .role-title {
    font-size: 32rpx;
    font-weight: bold;
    color: #fff;
    display: block;
    margin-bottom: 12rpx;
  }

  .role-desc {
    font-size: 24rpx;
    color: rgba(255, 255, 255, 0.8);
    display: block;
  }
}

.msg-entry {
  display: flex;
  align-items: center;
  margin-top: 60rpx;
  padding: 26rpx 30rpx;
  background: #fff;
  border-radius: 16rpx;

  .msg-entry-icon {
    font-size: 32rpx;
    margin-right: 16rpx;
  }

  .msg-entry-text {
    flex: 1;
    font-size: 28rpx;
    color: #333;
    font-weight: 500;
  }

  .msg-badge {
    min-width: 36rpx;
    height: 36rpx;
    line-height: 36rpx;
    padding: 0 10rpx;
    border-radius: 18rpx;
    background: #e74c3c;
    color: #fff;
    font-size: 22rpx;
    text-align: center;
  }

  .msg-entry-arrow {
    font-size: 32rpx;
    color: #ccc;
    margin-left: 12rpx;
  }
}

.user-info {
  margin-top: 60rpx;
  text-align: center;
  padding: 30rpx;
  background: #fff;
  border-radius: 16rpx;

  .user-name {
    font-size: 30rpx;
    color: #333;
    font-weight: 500;
    display: block;
  }

  .user-role {
    font-size: 24rpx;
    color: #999;
    margin-top: 8rpx;
    display: block;
  }

  .user-warehouse {
    font-size: 22rpx;
    color: #8A6A10;
    margin-top: 8rpx;
    display: block;
  }
}
</style>
