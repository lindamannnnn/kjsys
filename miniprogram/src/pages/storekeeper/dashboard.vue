<template>
  <view class="container">
    <!-- 顶部统计 -->
    <view class="stats-bar">
      <view class="stat-item">
        <text class="stat-value">{{ pendingCount }}</text>
        <text class="stat-label">待确认</text>
      </view>
      <view class="stat-item">
        <text class="stat-value" :class="{ highlight: pickingCount > 0 }">{{ pickingCount }}</text>
        <text class="stat-label">待拣货</text>
      </view>
      <view class="stat-item">
        <text class="stat-value">{{ receivingCount }}</text>
        <text class="stat-label">待收货</text>
      </view>
      <view class="stat-item">
        <text class="stat-value">{{ todayCount }}</text>
        <text class="stat-label">今日单据</text>
      </view>
    </view>

    <!-- 功能入口 -->
    <view class="menu-grid">
      <view class="menu-card" @click="goPending">
        <view class="menu-icon">📋</view>
        <text class="menu-title">待办单据</text>
        <text class="menu-desc">确认 → 拣货 → 收货</text>
        <view v-if="todoCount > 0" class="badge">{{ todoCount }}</view>
      </view>

      <!-- 采购任务只针对配件仓（2026-10-12）：成品仓管不显示这张卡片 -->
      <view v-if="hasPartsWarehouse" class="menu-card" @click="goPurchaseTasks">
        <view class="menu-icon">🛒</view>
        <text class="menu-title">采购任务</text>
        <text class="menu-desc">发起采购、收料入库</text>
        <!-- 未结单角标（2026-10-09）：采购员买完的货堆在门口等着收料，
             这一步没做完库存就一直是空的，必须让仓管一眼看到 -->
        <view v-if="purchaseTodo > 0" class="badge">{{ purchaseTodo > 99 ? '99+' : purchaseTodo }}</view>
      </view>

      <view class="menu-card" @click="goStock">
        <view class="menu-icon">📦</view>
        <text class="menu-title">本仓库存</text>
        <text class="menu-desc">查看本仓库存</text>
      </view>

      <view class="menu-card" @click="goCheck">
        <view class="menu-icon">✅</view>
        <text class="menu-title">盘点</text>
        <text class="menu-desc">库存盘点任务</text>
      </view>

      <view class="menu-card" @click="goOrders">
        <view class="menu-icon">📊</view>
        <text class="menu-title">全部流水</text>
        <text class="menu-desc">查看本仓所有单据</text>
      </view>
    </view>

    <!-- 待确认单据预览 -->
    <view v-if="pendingList.length > 0" class="section">
      <view class="section-header">
        <text class="section-title">待办单据</text>
        <text class="section-more" @click="goPending">查看全部 →</text>
      </view>
      <view
        v-for="item in pendingList.slice(0, 3)"
        :key="`${item.order_type}-${item._id}`"
        class="order-preview"
        @click="goDetail(item)"
      >
        <view class="order-preview-header">
          <text class="order-no">{{ item.order_no }}</text>
          <view class="order-tags">
            <text class="order-status" :class="item.status">{{ statusText(item.status) }}</text>
            <text class="order-type" :class="item.order_type">{{ item.order_type === 'out' ? '领料' : '入库' }}</text>
          </view>
        </view>
        <text class="order-info">{{ item.operator_name }} 提交 | {{ item.item_count }} 项</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { statsApi, outboundApi, inboundApi, purchaseApi, statusText, warehouseApi } from '@/utils/api'

// 采购任务只针对配件仓（2026-10-12 用户定稿）：成品仓管看不到「采购任务」卡片
const warehouseList = ref([])
const hasPartsWarehouse = computed(() => warehouseList.value.some((w) => w.code === 'peijian'))

const pendingList = ref([])
const pendingCount = ref(0)      // 待确认（出库 + 入库）
const pickingCount = ref(0)      // 待拣货（领料单确认之后）
const receivingCount = ref(0)    // 待收货（等领料员来收）
const todayCount = ref(0)
const stockCount = ref(0)
const purchaseTodo = ref(0)      // 采购任务未结单（待收料 + 收货中）

/** 仓管真正要动手的：待确认 + 待拣货（待收货是等领料员，不算待办压力） */
const todoCount = computed(() => pendingCount.value + pickingCount.value)

function goPending() {
  uni.navigateTo({ url: '/pages/storekeeper/pending' })
}

function goOrders() {
  uni.navigateTo({ url: '/pages/storekeeper/orders' })
}

function goStock() {
  uni.navigateTo({ url: '/pages/storekeeper/stock' })
}

function goCheck() {
  uni.navigateTo({ url: '/pages/check/list' })
}

function goPurchaseTasks() {
  uni.navigateTo({ url: '/pages/purchase/tasks' })
}

function goDetail(item) {
  const url = item.order_type === 'out'
    ? `/pages/out/detail?id=${item._id}`
    : `/pages/in/detail?id=${item._id}`
  uni.navigateTo({ url })
}

// 待办单据预览（待确认 + 待拣货的出库单，以及待确认的入库单）
async function loadPendingPreview() {
  try {
    const safe = (p) => p.catch(() => ({ list: [] }))
    const [outPending, outPicking, inPending] = await Promise.all([
      safe(outboundApi.list({ status: 'pending', page: 1, pageSize: 3 })),
      safe(outboundApi.list({ status: 'picking', page: 1, pageSize: 3 })),
      safe(inboundApi.list({ status: 'pending', page: 1, pageSize: 3 }))
    ])
    const out = [
      ...(outPending.list || []),
      ...(outPicking.list || [])
    ].map((o) => ({ ...o, order_type: 'out', item_count: (o.items || []).length }))
    const inbound = (inPending.list || []).map((o) => ({
      ...o, order_type: 'in', item_count: (o.items || []).length
    }))
    pendingList.value = [...out, ...inbound]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  } catch (err) {
    pendingList.value = []
  }
}

async function loadData() {
  try {
    const safe = (p) => p.catch(() => ({ count: 0 }))
    const [overview, outPending, inPending, outPicking, outReceiving, purchaseCount, whs] = await Promise.all([
      statsApi.overview(),
      safe(outboundApi.pendingCount()),
      safe(inboundApi.pendingCount()),
      safe(outboundApi.pickingCount()),
      // 待收货没有单独的计数接口，用列表长度（最多取 50 条够显示）
      safe(outboundApi.list({ status: 'receiving', page: 1, pageSize: 50 })),
      // 采购任务未结单（待收料 + 收货中）——角标用
      safe(purchaseApi.myTodoCount()),
      // 我可管的仓库（判断要不要显示「采购任务」卡片）
      safe(warehouseApi.list())
    ])

    warehouseList.value = (whs && whs.list) || []
    todayCount.value = (overview.today_outbound_orders || 0) + (overview.today_inbound_orders || 0)
    stockCount.value = overview.material_count || 0
    pendingCount.value = (outPending.count || 0) + (inPending.count || 0)
    pickingCount.value = outPicking.count || 0
    receivingCount.value = (outReceiving.list || []).length
    // 后端仓管分支返回 waiting_receive（待收料）+ receiving（收货中），total 即两者之和
    purchaseTodo.value = Number(purchaseCount.total || 0)

    await loadPendingPreview()
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  }
}

// 首次进入即加载（onMounted 兜底，防止页面生命周期在某些端不触发导致空白）
// 之后每次页面重新显示时刷新（含从子页面返回），所以点完确认回到工作台红点会同步
const __pageShowHandler = () => {
  loadData()
}
onMounted(() => {
  __pageShowHandler()      // 首屏一定加载（onMounted 兜底，不依赖任何注册成功与否）
  onShow(__pageShowHandler)  // 之后每次页面重新显示（含从子页返回）都刷新
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding: 20rpx;
}

.stats-bar {
  display: flex;
  background: #fff;
  border-radius: 16rpx;
  padding: 26rpx 10rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .stat-item {
    flex: 1;
    text-align: center;

    .stat-value {
      font-size: 42rpx;
      font-weight: bold;
      color: #6b5b95;
      display: block;

      &.highlight {
        color: #e74c3c;
      }
    }

    .stat-label {
      font-size: 22rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }
  }
}

.menu-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20rpx;
  margin-bottom: 20rpx;
}

.menu-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  position: relative;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .menu-icon {
    font-size: 48rpx;
    margin-bottom: 16rpx;
  }

  .menu-title {
    font-size: 30rpx;
    font-weight: bold;
    color: #333;
    display: block;
  }

  .menu-desc {
    font-size: 22rpx;
    color: #999;
    margin-top: 8rpx;
    display: block;
  }

  .badge {
    position: absolute;
    top: 16rpx;
    right: 16rpx;
    background: #e74c3c;
    color: #fff;
    font-size: 20rpx;
    padding: 4rpx 12rpx;
    border-radius: 20rpx;
    min-width: 32rpx;
    text-align: center;
  }
}

.section {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20rpx;

    .section-title {
      font-size: 30rpx;
      font-weight: bold;
      color: #333;
    }

    .section-more {
      font-size: 24rpx;
      color: #6b5b95;
    }
  }
}

.order-preview {
  padding: 20rpx;
  background: #f8f8f8;
  border-radius: 12rpx;
  margin-bottom: 12rpx;

  .order-preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8rpx;

    .order-no {
      font-size: 26rpx;
      font-weight: 500;
      color: #333;
    }

    .order-tags {
      display: flex;
      align-items: center;
      gap: 10rpx;

      .order-status {
        font-size: 20rpx;
        padding: 4rpx 12rpx;
        border-radius: 6rpx;

        &.pending {
          background: #fff3cd;
          color: #856404;
        }

        &.picking {
          background: #efeaf7;
          color: #5b4b8a;
        }

        &.receiving {
          background: #d1ecf1;
          color: #0c5460;
        }
      }

      .order-type {
        font-size: 20rpx;
        padding: 4rpx 12rpx;
        border-radius: 6rpx;
        color: #fff;

        &.out {
          background: #e74c3c;
        }

        &.in {
          background: #27ae60;
        }
      }
    }
  }

  .order-info {
    font-size: 22rpx;
    color: #666;
  }
}
</style>
