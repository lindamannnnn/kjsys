<template>
  <view class="container">
    <!-- 类型筛选 -->
    <view class="filter-bar">
      <text
        v-for="tab in typeTabs"
        :key="tab.value"
        class="filter-tab"
        :class="{ active: currentType === tab.value }"
        @click="onTypeChange(tab.value)"
      >{{ tab.label }}</text>

      <picker class="warehouse-picker" :range="warehouseNames" @change="onWarehouseChange">
        <view class="picker-value">{{ currentWarehouseName }} ▼</view>
      </picker>
    </view>

    <!-- 单据列表 -->
    <scroll-view
      class="order-list"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
      @scrolltolower="onLoadMore"
    >
      <view
        v-for="item in displayList"
        :key="`${item.kind}-${item._id}`"
        class="order-card"
        @click="goDetail(item)"
      >
        <view class="order-header">
          <text class="order-no">{{ item.order_no }}</text>
          <view class="header-right">
            <text class="order-type" :class="item.kind === 'outbound' ? 'out' : 'in'">
              {{ item.kind === 'outbound' ? '出库' : '入库' }}
            </text>
            <text class="order-status" :class="item.status">{{ statusText(item.status) }}</text>
          </view>
        </view>

        <view class="order-body">
          <text class="material-name">{{ item.material_names || '无明细' }}</text>
          <text class="order-detail">
            {{ item.total_qty }}
            <!-- 金额：后端 orderFlow 只对「成品仓」单据向仓管脱敏，
                 配件仓入库单金额保留（采购对账用）→ 按数据有无判断即可 -->
            <text v-if="item.kind === 'inbound' && item.total_amount != null"> | 金额 ¥{{ formatMoney(item.total_amount) }}</text>
          </text>
        </view>

        <view class="order-footer">
          <text class="operator">{{ item.operator_name }} | {{ formatDate(item.created_at) }}</text>
          <view class="footer-right">
            <text class="warehouse">{{ item.warehouse_name || '—' }}</text>
            <!-- 已确认的单据可以作废 -->
            <text
              v-if="item.status === 'confirmed' || item.status === 'completed'"
              class="btn-cancel-small"
              @click.stop="cancelOrder(item)"
            >作废</text>
          </view>
        </view>
      </view>

      <view v-if="displayList.length === 0" class="empty">
        <text class="empty-icon">📋</text>
        <text class="empty-text">暂无单据</text>
      </view>

      <view v-if="displayList.length" class="load-more">
        <text v-if="loadingMore">加载中...</text>
        <text v-else-if="noMore">已经到底了</text>
        <text v-else>上拉加载更多</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { statsApi, warehouseApi, outboundApi, inboundApi, statusText } from '@/utils/api'
import { formatMoney } from '@/utils/format'

const currentType = ref('all')
const currentWarehouse = ref('all')
const typeTabs = [
  { label: '全部', value: 'all' },
  { label: '出库', value: 'out' },
  { label: '入库', value: 'in' }
]

const typeMap = { all: '', out: 'outbound', in: 'inbound' }

const warehouseList = ref([])
const allOrders = ref([])
const displayList = ref([])
const refreshing = ref(false)

/* ---------- 分页 ---------- */
const PAGE_SIZE = 100
const page = ref(1)
const noMore = ref(false)
const loadingMore = ref(false)

const warehouseNames = computed(() => ['全部仓库', ...warehouseList.value.map((w) => w.name)])
const currentWarehouseName = computed(() => {
  if (currentWarehouse.value === 'all') return '全部仓库'
  const w = warehouseList.value.find((x) => (x._id || x.id) === currentWarehouse.value)
  return w ? w.name : '全部仓库'
})

function formatDate(d) {
  const date = new Date(d)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function onTypeChange(value) {
  currentType.value = value
  loadData()
}

function onWarehouseChange(e) {
  const idx = Number(e.detail.value)
  if (idx === 0) {
    currentWarehouse.value = 'all'
  } else {
    const w = warehouseList.value[idx - 1]
    currentWarehouse.value = w ? (w._id || w.id) : 'all'
  }
  filterList()
}

// 仓库维度前端过滤（orderFlow 返回的是 warehouse_name）
function filterList() {
  if (currentWarehouse.value === 'all') {
    displayList.value = allOrders.value
    return
  }
  const w = warehouseList.value.find((x) => (x._id || x.id) === currentWarehouse.value)
  const name = w ? w.name : ''
  displayList.value = allOrders.value.filter((o) => o.warehouse_name === name)
}

function goDetail(item) {
  const url = item.kind === 'outbound'
    ? `/pages/out/detail?id=${item._id}`
    : `/pages/in/detail?id=${item._id}`
  uni.navigateTo({ url })
}

// 作废单据（回算库存）
function cancelOrder(item) {
  uni.showModal({
    title: '作废单据',
    editable: true,
    placeholderText: '必须写作废原因，方便事后追查',
    confirmText: '作废',
    cancelText: '取消',
    confirmColor: '#e74c3c',
    success: async (res) => {
      if (!res.confirm) return
      const reason = String(res.content || '').trim()
      if (!reason) {
        uni.showToast({ title: '请写明作废原因', icon: 'none' })
        return
      }
      try {
        if (item.kind === 'outbound') {
          await outboundApi.cancel({ id: item._id, reason })
        } else {
          await inboundApi.cancel({ id: item._id, reason })
        }
        uni.showToast({ title: '已作废，库存已回算', icon: 'success' })
        loadData()
      } catch (err) {
        uni.showToast({ title: err.message || '作废失败', icon: 'none' })
      }
    }
  })
}

function onRefresh() {
  loadData()
}

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    warehouseList.value = res.list || []
  } catch (err) {
    uni.showToast({ title: err.message || '仓库加载失败', icon: 'none' })
  }
}

// 单据流水（出库 + 入库合并）
function orderFlowParams(p) {
  return {
    page: p,
    pageSize: PAGE_SIZE,
    type: typeMap[currentType.value] || undefined
  }
}

// 下拉刷新 / 切类型：页码归 1，列表整体替换（不追加）
async function loadData() {
  page.value = 1
  noMore.value = false
  try {
    const res = await statsApi.orderFlow(orderFlowParams(page.value))
    const list = res.list || []
    allOrders.value = list
    if (list.length < PAGE_SIZE || list.length >= (res.total ?? Infinity)) noMore.value = true
    filterList()
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    refreshing.value = false
  }
}

/** 上拉加载更多：追加下一页 */
async function onLoadMore() {
  if (noMore.value || loadingMore.value) return
  loadingMore.value = true
  const next = page.value + 1
  try {
    const res = await statsApi.orderFlow(orderFlowParams(next))
    const list = res.list || []
    page.value = next
    allOrders.value = [...allOrders.value, ...list]
    if (list.length < PAGE_SIZE || allOrders.value.length >= (res.total ?? Infinity)) noMore.value = true
    filterList()
  } catch (err) {
    uni.showToast({ title: err.message || '加载更多失败', icon: 'none' })
  } finally {
    loadingMore.value = false
  }
}

// 首次进入即加载（onMounted 兜底，防止页面生命周期在某些端不触发导致空白）
// 之后每次页面重新显示时刷新（含从子页面返回），所以点完确认回到工作台红点会同步
const __pageShowHandler = () => {
  loadWarehouses()
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
}

.filter-bar {
  display: flex;
  background: #fff;
  padding: 20rpx;
  gap: 16rpx;
  border-bottom: 1rpx solid #f0f0f0;
  align-items: center;

  .filter-tab {
    padding: 12rpx 24rpx;
    font-size: 26rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 30rpx;

    &.active {
      background: #6b5b95;
      color: #fff;
    }
  }

  .warehouse-picker {
    margin-left: auto;
    background: #f5f5f5;
    padding: 12rpx 20rpx;
    border-radius: 30rpx;

    .picker-value {
      font-size: 24rpx;
      color: #333;
    }
  }
}

.order-list {
  padding: 20rpx;
  height: calc(100vh - 100rpx);
}

.order-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .order-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16rpx;

    .order-no {
      font-size: 28rpx;
      font-weight: bold;
      color: #333;
    }

    .header-right {
      display: flex;
      gap: 12rpx;

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

        &.confirmed, &.completed {
          background: #d4edda;
          color: #155724;
        }

        &.cancelled {
          background: #f8d7da;
          color: #721c24;
        }
      }
    }
  }

  .order-body {
    margin-bottom: 16rpx;

    .material-name {
      font-size: 28rpx;
      color: #333;
      display: block;
    }

    .order-detail {
      font-size: 24rpx;
      color: #666;
      margin-top: 8rpx;
      display: block;
    }
  }

  .order-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .operator {
      font-size: 22rpx;
      color: #999;
    }

    .footer-right {
      display: flex;
      align-items: center;
      gap: 16rpx;

      .warehouse {
        font-size: 22rpx;
        color: #6b5b95;
      }

      .btn-cancel-small {
        font-size: 22rpx;
        color: #e74c3c;
        padding: 4rpx 16rpx;
        border: 1rpx solid #e74c3c;
        border-radius: 8rpx;
      }
    }
  }
}

.empty {
  text-align: center;
  padding: 80rpx 0;

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

.load-more {
  text-align: center;
  padding: 30rpx 0;
  font-size: 24rpx;
  color: #999;
}
</style>
