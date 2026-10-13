<template>
  <view class="container">
    <!-- 仓管：发布任务入口 -->
    <view v-if="canCreate" class="top-bar">
      <text class="top-hint">采购任务由仓管发布，采购员领取后去购买</text>
      <text class="btn-create" @click="goCreate">+ 发布采购任务</text>
    </view>

    <!-- 关键字搜索：后端 purchase.list 支持 keyword（匹配任务号/发起人/采购员） -->
    <view class="search-bar">
      <text class="search-icon">🔍</text>
      <input
        v-model="keyword"
        class="search-input"
        placeholder="搜索任务号/发起人/采购员"
        placeholder-class="placeholder"
        @input="onSearchInput"
      />
    </view>

    <!-- 状态筛选（待领取上挂数字：采购员落地页就是这个页，光靠首页角标他看不到） -->
    <view class="filter-bar">
      <text
        v-for="tab in tabs"
        :key="tab.value"
        class="filter-tab"
        :class="{ active: currentStatus === tab.value }"
        @click="switchStatus(tab.value)"
      >{{ tab.label }}<text v-if="tabCount(tab.value)" class="tab-count">{{ tabCount(tab.value) }}</text></text>
    </view>

    <scroll-view
      class="task-list"
      scroll-y
      @scrolltolower="loadMore"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in list"
        :key="item._id"
        class="task-card"
        :class="'st-' + item.status"
        @click="goDetail(item)"
      >
        <view class="task-head">
          <text class="task-no">{{ item.task_no }}</text>
          <text class="task-status" :class="item.status">{{ purchaseStatusText(item.status) }}</text>
        </view>

        <view class="task-body">
          <text class="task-material">{{ item.material_names || '无明细' }} 等 {{ item.item_count }} 项</text>
          <view class="task-meta">
            <text class="meta-item">仓库：{{ item.warehouse_name || '—' }}</text>
            <text v-if="item.creator_name" class="meta-item">发起：{{ item.creator_name }}</text>
            <text v-if="item.taker_name" class="meta-item">采购：{{ item.taker_name }}</text>
            <text v-if="item.assignee_name" class="meta-item">指定给：{{ item.assignee_name }}</text>
          </view>
          <view v-if="item.status === 'received' || item.total_amount > 0" class="task-amount">
            <text class="amount-text">金额 ¥{{ formatMoney(item.total_amount) }}</text>
            <text v-if="item.purchase_channel" class="channel-text">· {{ item.purchase_channel }}</text>
          </view>
          <text v-if="item.reject_reason" class="task-reject">退回原因：{{ item.reject_reason }}</text>
        </view>

        <view class="task-foot">
          <text class="task-time">{{ formatDate(item.created_at) }}</text>
          <view class="task-actions">
            <text v-if="item.can_take" class="btn-take" @click.stop="takeTask(item)">领取</text>
            <text v-else-if="item.status === 'received' && item.inbound_order_no" class="task-done">
              入库单 {{ item.inbound_order_no }}
            </text>
            <text v-else class="task-view">查看详情 ›</text>
          </view>
        </view>
      </view>

      <view v-if="!loading && list.length === 0" class="empty">
        <text class="empty-icon">🛒</text>
        <text class="empty-text">{{ emptyText }}</text>
      </view>
      <view v-else-if="loading" class="empty">
        <text class="empty-text">加载中...</text>
      </view>
      <view v-if="loadingMore" class="empty">
        <text class="empty-text">加载中...</text>
      </view>
      <view v-else-if="noMore && list.length > 0" class="empty">
        <text class="empty-text">没有更多了</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { purchaseApi, purchaseStatusText } from '@/utils/api'
import { useUserStore } from '@/store/user'
import { debounce } from '@/utils/debounce'
import { formatMoney } from '@/utils/format'

const userStore = useUserStore()

const list = ref([])
const loading = ref(true)
const refreshing = ref(false)
const currentStatus = ref('')
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)
const loadingMore = ref(false)
const noMore = ref(false)

// tab 上的角标数字（后端 myTodoCount 按角色给不同口径）：
//   采购员 → can_take（能领的新任务）
//   仓管   → waiting_receive（待收料）/ receiving（收货中）
// 拿不到就全 0（不显示角标），不影响列表本身
const todoCounts = ref({})

function tabCount(value) {
  if (value === 'open') return Number(todoCounts.value.can_take || 0)
  if (value === 'purchased') return Number(todoCounts.value.waiting_receive || 0)
  if (value === 'receiving') return Number(todoCounts.value.receiving || 0)
  return 0
}

async function loadTodoCount() {
  try {
    const res = await purchaseApi.myTodoCount()
    todoCounts.value = res || {}
  } catch (err) {
    todoCounts.value = {}
  }
}

const tabs = [
  { label: '全部', value: '' },
  { label: '待领取', value: 'open' },
  { label: '采购中', value: 'taken' },
  { label: '待收料', value: 'purchased' },
  { label: '收货中', value: 'receiving' },
  { label: '已入库', value: 'received' }
]

// 发起采购单：仓管 / 管理员 / 厂长（2026-10-09 老板只读后收回 boss）
const canCreate = computed(() => userStore.hasRole(['storekeeper', 'admin', 'director']))

const emptyText = computed(() => {
  if (currentStatus.value === 'open') return '暂无可领取的采购任务'
  if (currentStatus.value) return '该状态下暂无任务'
  return '暂无采购任务'
})

// 搜索框输入防抖（统一走 utils/debounce，避免每敲一个字发一次请求）
const onSearchInput = debounce(() => {
  page.value = 1
  noMore.value = false
  loadList()
}, 300)

function formatDate(d) {
  if (!d) return ''
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

async function loadList() {
  if (loadingMore.value) return

  loadingMore.value = true
  // 只有第一页才显示整页 loading；下拉刷新/加载更多保留原列表
  if (page.value === 1) loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    if (currentStatus.value) params.status = currentStatus.value
    if (keyword.value.trim()) params.keyword = keyword.value.trim()
    const res = await purchaseApi.list(params)
    const rows = res.list || []
    list.value = page.value === 1 ? rows : [...list.value, ...rows]
    // 判据统一：本页不足 pageSize，或已加载数 >= total → 没有更多
    noMore.value = rows.length < pageSize.value || list.value.length >= (res.total || 0)
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none', duration: 3000 })
    // 失败不置 noMore（保留可重试）；仅首屏失败清空，避免残留旧数据
    if (page.value === 1) list.value = []
  } finally {
    loadingMore.value = false
    loading.value = false
    refreshing.value = false
  }
}

function switchStatus(v) {
  currentStatus.value = v
  page.value = 1
  noMore.value = false
  loadList()
}

function onRefresh() {
  page.value = 1
  noMore.value = false
  loadList()
}

function loadMore() {
  if (!noMore.value && !loadingMore.value) {
    page.value++
    loadList()
  }
}

function goCreate() {
  uni.navigateTo({ url: '/pages/purchase/task-create' })
}

function goDetail(item) {
  uni.navigateTo({ url: `/pages/purchase/task-detail?id=${item._id}` })
}

/** 列表里直接领取：省一步进详情 */
function takeTask(item) {
  uni.showModal({
    title: '领取采购任务',
    content: `领取 ${item.task_no}？\n领取后这项任务就归你负责，请尽快购买并录入采购信息。`,
    confirmText: '领取',
    cancelText: '再看看',
    success: async (res) => {
      if (!res.confirm) return
      try {
        await purchaseApi.take({ id: item._id })
        uni.showToast({ title: '领取成功', icon: 'success' })
        loadList()
        setTimeout(() => goDetail(item), 800)
      } catch (err) {
        uni.showToast({ title: err.message || '领取失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

const __pageShowHandler = () => {
  page.value = 1
  noMore.value = false
  loadList()
  loadTodoCount()
}
onMounted(() => {
  __pageShowHandler()
  onShow(__pageShowHandler)
})
</script>

<style lang="scss" scoped>
.container {
  /* ⚠️ 2026-10-09：原为 min-height:100vh，scroll-view 会被内容顶开、由页面整体滚动，
     @scrolltolower 永远不触发（上拉加载形同虚设）。
     按项目铁律改成固定高度 + flex 列，列表用 flex:1 + min-height:0 自己滚。 */
  height: 100vh;
  height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  background: #f5f5f5;
  display: flex;
  flex-direction: column;
}

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  padding: 24rpx;
  border-bottom: 1rpx solid #f0f0f0;

  .top-hint {
    flex: 1;
    font-size: 22rpx;
    color: #999;
    margin-right: 16rpx;
  }

  .btn-create {
    font-size: 26rpx;
    color: #fff;
    background: #6b5b95;
    padding: 14rpx 26rpx;
    border-radius: 30rpx;
    flex-shrink: 0;
  }
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 16rpx;
  background: #fff;
  padding: 16rpx 24rpx;
  border-bottom: 1rpx solid #f0f0f0;

  .search-icon {
    font-size: 28rpx;
  }

  .search-input {
    flex: 1;
    height: 88rpx;
    line-height: 88rpx;
    padding: 0 24rpx;
    background: #f5f5f5;
    border-radius: 40rpx;
    font-size: 28rpx;
    box-sizing: border-box;
  }

  .placeholder {
    color: #999;
  }
}

.filter-bar {
  display: flex;
  background: #fff;
  padding: 16rpx 20rpx 20rpx;
  gap: 14rpx;
  border-bottom: 1rpx solid #f0f0f0;

  .filter-tab {
    padding: 10rpx 22rpx;
    font-size: 24rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 30rpx;

    &.active {
      background: #6b5b95;
      color: #fff;

      /* 选中时红字看不清，跟主色一起变白 */
      .tab-count {
        color: #fff;
      }
    }

    /* tab 右上角数字：待领取/待收料/收货中 有几单没处理 */
    .tab-count {
      font-size: 22rpx;
      margin-left: 6rpx;
      color: #e74c3c;
      font-weight: bold;
    }
  }
}

.task-list {
  flex: 1;
  /* min-height:0 必写：否则 flex 子项被内容顶开，滚动落在页面而不是这个 scroll-view */
  min-height: 0;
  padding: 20rpx;
}

.task-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
  border-left: 6rpx solid #ddd;

  &.st-open {
    border-left-color: #f39c12;
  }

  &.st-taken {
    border-left-color: #3498db;
  }

  &.st-purchased {
    border-left-color: #6b5b95;
  }

  &.st-receiving {
    border-left-color: #16a085;
  }

  &.st-received {
    border-left-color: #27ae60;
  }

  &.st-cancelled {
    border-left-color: #bbb;
    opacity: 0.75;
  }

  .task-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14rpx;

    .task-no {
      font-size: 28rpx;
      font-weight: bold;
      color: #333;
    }

    .task-status {
      font-size: 22rpx;
      padding: 6rpx 16rpx;
      border-radius: 8rpx;

      &.open {
        background: #fff3cd;
        color: #856404;
      }

      &.taken {
        background: #d6eaf8;
        color: #1b4f72;
      }

      &.purchased {
        background: #efeaf7;
        color: #5b4b8a;
      }

      &.receiving {
        background: #d1f2eb;
        color: #0e6655;
      }

      &.received {
        background: #d4edda;
        color: #155724;
      }

      &.cancelled {
        background: #e2e3e5;
        color: #4b5157;
      }
    }
  }

  .task-body {
    .task-material {
      font-size: 28rpx;
      color: #333;
      display: block;
      margin-bottom: 10rpx;
    }

    .task-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 16rpx;

      .meta-item {
        font-size: 22rpx;
        color: #999;
      }
    }

    .task-amount {
      margin-top: 12rpx;

      .amount-text {
        font-size: 26rpx;
        font-weight: bold;
        color: #e67e22;
      }

      .channel-text {
        font-size: 22rpx;
        color: #999;
        margin-left: 8rpx;
      }
    }

    .task-reject {
      display: block;
      margin-top: 10rpx;
      font-size: 22rpx;
      color: #e74c3c;
    }
  }

  .task-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 18rpx;
    padding-top: 16rpx;
    border-top: 1rpx solid #f5f5f5;

    .task-time {
      font-size: 22rpx;
      color: #bbb;
    }

    .task-actions {
      display: flex;
      align-items: center;
      gap: 16rpx;

      .btn-take {
        font-size: 24rpx;
        color: #fff;
        background: #f39c12;
        padding: 8rpx 26rpx;
        border-radius: 8rpx;
      }

      .task-done {
        font-size: 22rpx;
        color: #27ae60;
      }

      .task-view {
        font-size: 24rpx;
        color: #6b5b95;
      }
    }
  }
}

.empty {
  text-align: center;
  padding: 100rpx 0;

  .empty-icon {
    font-size: 80rpx;
    display: block;
    margin-bottom: 20rpx;
  }

  .empty-text {
    font-size: 26rpx;
    color: #999;
  }
}
</style>
