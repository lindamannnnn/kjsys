<template>
  <view class="container">
    <!-- 类型筛选 -->
    <view class="filter-bar">
      <text
        v-for="tab in typeTabs"
        :key="tab.value"
        class="filter-tab"
        :class="{ active: currentType === tab.value }"
        @click="currentType = tab.value; filterList()"
      >{{ tab.label }}</text>
    </view>

    <!-- 单据列表 -->
    <scroll-view
      class="order-list"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in displayList"
        :key="`${item.order_type}-${item._id}`"
        class="order-card"
        :class="{ 'out-card': item.order_type === 'out', 'in-card': item.order_type === 'in' }"
        @click="showDetail(item)"
      >
        <view class="order-header">
          <text class="order-no">{{ item.order_no }}</text>
          <text class="order-type" :class="item.order_type">
            {{ item.order_type === 'out' ? '出库' : '入库' }}
          </text>
        </view>

        <view class="order-body">
          <text class="material-name">{{ item.material_names || '无明细' }} 等 {{ item.item_count }} 项</text>
          <text class="order-detail">
            {{ item.operator_name }} 提交 | {{ formatDate(item.created_at) }}
          </text>
        </view>

        <view class="order-footer">
          <text class="operator">仓库: {{ item.warehouse_name || '—' }}</text>
          <view class="action-btns">
            <text class="btn-look" @click.stop="showDetail(item)">看库存</text>
            <text class="btn-confirm" @click.stop="confirmOrder(item)">确认</text>
            <text
              v-if="item.order_type === 'out'"
              class="btn-cancel"
              @click.stop="cancelOrder(item)"
            >驳回</text>
          </view>
        </view>
      </view>

      <view v-if="displayList.length === 0" class="empty">
        <text class="empty-icon">✅</text>
        <text class="empty-text">没有待确认的单据</text>
      </view>
    </scroll-view>

    <!-- 明细 + 当前库存（确认前先看清楚，不用跑去货架数） -->
    <view v-if="detailVisible" class="mask" @click="detailVisible = false">
      <view class="sheet" @click.stop="noop">
        <view class="sheet-title">{{ detailOrder.order_no || '单据明细' }}</view>
        <text class="sheet-sub">
          {{ detailOrder.order_type === 'out' ? '出库' : '入库' }} · {{ detailOrder.operator_name }} 提交
        </text>

        <scroll-view class="detail-list" scroll-y>
          <view
            v-for="(it, idx) in detailOrder.items || []"
            :key="idx"
            class="detail-item"
          >
            <view class="detail-main">
              <text class="detail-name">{{ it.material_name }}</text>
              <text class="detail-sub">{{ it.material_spec || '无规格' }}{{ it.unit ? ' · ' + it.unit : '' }}</text>
            </view>
            <view class="detail-nums">
              <text class="detail-qty">本次 {{ it.quantity }}</text>
              <text
                v-if="it.current_stock !== undefined && it.current_stock !== null"
                class="detail-stock"
                :class="{ danger: it.stock_enough === false }"
              >
                现存 {{ it.current_stock }}
              </text>
            </view>
            <text v-if="it.stock_enough === false" class="detail-warn">库存不足</text>
          </view>
          <view v-if="detailLoading" class="detail-empty">加载中...</view>
          <view v-else-if="!(detailOrder.items || []).length" class="detail-empty">没有明细</view>
        </scroll-view>

        <view class="detail-tip">
          库存在「提交」时就已经变动过了，确认只是把单据状态变成生效。
        </view>

        <view class="sheet-btns">
          <text class="sheet-btn ghost" @click="detailVisible = false">关闭</text>
          <text
            class="sheet-btn"
            @click="detailVisible = false; confirmOrder(detailOrder)"
          >确认这张单</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { outboundApi, inboundApi } from '@/utils/api'

const currentType = ref('all')
const typeTabs = [
  { label: '全部', value: 'all' },
  { label: '出库', value: 'out' },
  { label: '入库', value: 'in' }
]

const allPending = ref([])
const displayList = ref([])
const refreshing = ref(false)

/* ---------- 明细弹层：确认前先看清当前库存 ---------- */
const detailVisible = ref(false)
const detailLoading = ref(false)
const detailOrder = ref({})

function noop() {}

async function showDetail(item) {
  // 先用列表里已有的数据打开，避免白屏，再补拉明细
  detailOrder.value = { ...item, items: item.items || [] }
  detailVisible.value = true
  detailLoading.value = true
  try {
    const api = item.order_type === 'out' ? outboundApi : inboundApi
    const res = await api.detail({ id: item._id })
    detailOrder.value = {
      ...item,
      ...res,
      order_type: item.order_type
    }
  } catch (err) {
    uni.showToast({ title: err.message || '明细加载失败', icon: 'none' })
  } finally {
    detailLoading.value = false
  }
}

function formatDate(d) {
  const date = new Date(d)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
}

function decorate(order, orderType) {
  const items = order.items || []
  return {
    ...order,
    order_type: orderType,
    item_count: items.length,
    material_names: items.map((it) => it.material_name).filter(Boolean).join('、')
  }
}

function filterList() {
  displayList.value = currentType.value === 'all'
    ? allPending.value
    : allPending.value.filter((o) => o.order_type === currentType.value)
}

// 待确认单据：同时拉取出库与入库
async function loadData() {
  try {
    const [outRes, inRes] = await Promise.all([
      outboundApi.list({ status: 'pending', page: 1, pageSize: 50 }),
      inboundApi.list({ status: 'pending', page: 1, pageSize: 50 })
    ])
    const out = (outRes.list || []).map((o) => decorate(o, 'out'))
    const inbound = (inRes.list || []).map((o) => decorate(o, 'in'))
    allPending.value = [...out, ...inbound]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    filterList()
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    refreshing.value = false
  }
}

// 确认单据
function confirmOrder(item) {
  const isOut = item.order_type === 'out'
  uni.showModal({
    title: '确认单据',
    content: isOut
      ? `确认 ${item.order_no} 吗？\n这张出库单在提交时就已经扣了库存，确认只是让单据生效、之后不能再改。`
      : `确认 ${item.order_no} 吗？\n这张入库单在提交时就已经加了库存，确认只是让单据生效、之后不能再改。`,
    confirmText: '确认生效',
    cancelText: '再想想',
    success: async (res) => {
      if (!res.confirm) return
      try {
        if (isOut) {
          await outboundApi.confirm({ id: item._id })
        } else {
          await inboundApi.confirm({ id: item._id })
        }
        uni.showToast({ title: '已确认', icon: 'success' })
        loadData()
      } catch (err) {
        uni.showToast({ title: err.message || '确认失败', icon: 'none' })
      }
    }
  })
}

// 驳回出库单据（回补已扣的库存）
function cancelOrder(item) {
  uni.showModal({
    title: '驳回单据',
    editable: true,
    placeholderText: '必须写明驳回原因，提交人能收到',
    confirmText: '驳回',
    cancelText: '取消',
    confirmColor: '#e74c3c',
    success: async (res) => {
      if (!res.confirm) return
      const reason = String(res.content || '').trim()
      if (!reason) {
        uni.showToast({ title: '请写明驳回原因', icon: 'none' })
        return
      }
      try {
        await outboundApi.reject({ id: item._id, reason })
        uni.showToast({ title: '已驳回，库存已回补', icon: 'success' })
        loadData()
      } catch (err) {
        uni.showToast({ title: err.message || '驳回失败', icon: 'none' })
      }
    }
  })
}

function onRefresh() {
  loadData()
}

onMounted(() => {
  loadData()
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
  gap: 20rpx;
  border-bottom: 1rpx solid #f0f0f0;

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
  border-left: 6rpx solid transparent;

  &.out-card {
    border-left-color: #e74c3c;
  }

  &.in-card {
    border-left-color: #27ae60;
  }

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

  .order-body {
    margin-bottom: 16rpx;

    .material-name {
      font-size: 28rpx;
      color: #333;
      display: block;
    }

    .order-detail {
      font-size: 22rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }

    .stock-check {
      margin-top: 12rpx;
      padding: 12rpx;
      border-radius: 8rpx;
      font-size: 22rpx;

      &.warning {
        background: #fff3cd;
      }

      .enough {
        color: #155724;
      }

      .not-enough {
        color: #856404;
      }
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

    .action-btns {
      display: flex;
      gap: 16rpx;

      .btn-look {
        font-size: 24rpx;
        color: #6b5b95;
        background: #efeaf7;
        padding: 8rpx 20rpx;
        border-radius: 8rpx;
      }

      .btn-confirm {
        font-size: 24rpx;
        color: #fff;
        background: #27ae60;
        padding: 8rpx 24rpx;
        border-radius: 8rpx;
      }

      .btn-cancel {
        font-size: 24rpx;
        color: #fff;
        background: #e74c3c;
        padding: 8rpx 24rpx;
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

.mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 1000;
  display: flex;
  align-items: flex-end;
}

.sheet {
  width: 100%;
  max-height: 82vh;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;

  .sheet-title {
    font-size: 32rpx;
    font-weight: bold;
    color: #333;
    text-align: center;
  }

  .sheet-sub {
    display: block;
    font-size: 24rpx;
    color: #999;
    text-align: center;
    margin-top: 10rpx;
    margin-bottom: 20rpx;
  }

  .detail-list {
    flex: 1;
    max-height: 46vh;

    .detail-item {
      padding: 20rpx 0;
      border-bottom: 1rpx solid #f5f5f5;

      .detail-main {
        .detail-name {
          font-size: 28rpx;
          color: #333;
          display: block;
        }

        .detail-sub {
          font-size: 22rpx;
          color: #999;
          margin-top: 4rpx;
          display: block;
        }
      }

      .detail-nums {
        display: flex;
        align-items: center;
        gap: 24rpx;
        margin-top: 10rpx;

        .detail-qty {
          font-size: 26rpx;
          color: #333;
        }

        .detail-stock {
          font-size: 26rpx;
          color: #27ae60;

          &.danger {
            color: #e74c3c;
            font-weight: bold;
          }
        }
      }

      .detail-warn {
        display: block;
        font-size: 22rpx;
        color: #e74c3c;
        margin-top: 6rpx;
      }
    }

    .detail-empty {
      text-align: center;
      padding: 60rpx;
      color: #999;
      font-size: 26rpx;
    }
  }

  .detail-tip {
    margin-top: 20rpx;
    padding: 18rpx;
    background: #fdf6e3;
    border-radius: 12rpx;
    font-size: 22rpx;
    color: #8a6a10;
    line-height: 1.6;
  }

  .sheet-btns {
    display: flex;
    gap: 20rpx;
    margin-top: 24rpx;

    .sheet-btn {
      flex: 1;
      text-align: center;
      font-size: 28rpx;
      color: #fff;
      background: #27ae60;
      padding: 22rpx;
      border-radius: 12rpx;

      &.ghost {
        background: #f0f0f0;
        color: #666;
      }
    }
  }
}
</style>
