<template>
  <view class="container">
    <!-- 单据信息 -->
    <view class="card">
      <view class="card-header">
        <text class="order-no">{{ order.order_no }}</text>
        <text class="order-amount">¥{{ order.total_price }}</text>
      </view>
      <view class="card-body">
        <view class="info-row">
          <text class="label">单据状态</text>
          <text class="value">{{ statusText(order.status) }}</text>
        </view>
        <view class="info-row">
          <text class="label">仓库</text>
          <text class="value">{{ order.warehouse_name || '—' }}</text>
        </view>
        <view class="info-row">
          <text class="label">供应商</text>
          <text class="value">{{ order.supplier || '无' }}</text>
        </view>
        <view class="info-row">
          <text class="label">备注</text>
          <text class="value">{{ order.remark || '无' }}</text>
        </view>
        <view class="info-row">
          <text class="label">操作员</text>
          <text class="value">{{ order.operator_name }}</text>
        </view>
        <view class="info-row">
          <text class="label">提交时间</text>
          <text class="value">{{ formatDate(order.created_at, 'YYYY-MM-DD HH:mm:ss') }}</text>
        </view>
      </view>
    </view>

    <!-- 入库明细 -->
    <view class="card">
      <view class="items-title">入库明细（{{ itemList.length }} 项）</view>
      <view v-for="it in itemList" :key="it._id" class="item-row">
        <view class="item-main">
          <text class="item-name">{{ it.material_name }}</text>
          <text class="item-spec">{{ it.material_spec || '—' }}</text>
        </view>
        <view class="item-num">
          <text class="item-qty">{{ it.quantity }} {{ it.unit }}</text>
          <text class="item-price">¥{{ it.unit_price }} | 小计 ¥{{ it.total_price }}</text>
        </view>
      </view>
      <view v-if="itemList.length === 0" class="items-empty">
        <text>暂无明细</text>
      </view>
    </view>

    <!-- 修改单价按钮（当天可修改） -->
    <view v-if="canEditPrice" class="action-bar">
      <button class="btn-edit" @click="onEditPrice">
        修改单价
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { formatDate } from '@/utils/format'
import { inboundApi, statusText } from '@/utils/api'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const order = ref({})
const orderId = ref('')

const itemList = computed(() => order.value.items || [])

// 仅「待确认 + 本人 + 当天」允许改价（与后端规则一致；管理员另在后台处理已确认单）
const canEditPrice = computed(() => {
  if (order.value.status !== 'pending') return false
  if (!itemList.value.length) return false
  const created = new Date(order.value.created_at)
  const isToday = created.toDateString() === new Date().toDateString()
  // 身份比对与后端一致：openid 优先，账号密码登录时退回用户名
  const isOwn = !!userStore.identity && order.value.operator_openid === userStore.identity
  return isToday && isOwn
})

async function loadDetail() {
  if (!orderId.value) return
  try {
    const res = await inboundApi.detail({ id: orderId.value })
    order.value = res || {}
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  }
}

function onEditPrice() {
  const items = itemList.value
  if (!items.length) return

  // 一项：直接改；多项：先选要改哪一项（后端按 material_id 精确改，不会整单覆盖）
  if (items.length === 1) {
    askNewPrice(items[0])
    return
  }

  uni.showActionSheet({
    itemList: items.map((it, i) => `${i + 1}. ${it.material_name}（现价 ¥${it.unit_price}）`),
    success: (res) => {
      const target = items[res.tapIndex]
      if (target) askNewPrice(target)
    }
  })
}

function askNewPrice(item) {
  uni.showModal({
    title: `改价：${item.material_name}`,
    editable: true,
    placeholderText: `当前 ¥${item.unit_price}，请输入新单价`,
    success: async (res) => {
      if (!res.confirm) return
      const raw = String(res.content || '').trim()
      if (!raw) return

      const newPrice = Number(raw)
      if (!Number.isFinite(newPrice) || newPrice < 0) {
        uni.showToast({ title: '单价必须是不小于 0 的数字', icon: 'none' })
        return
      }
      if (Math.abs(newPrice - Number(item.unit_price)) < 0.001) {
        uni.showToast({ title: '单价没有变化', icon: 'none' })
        return
      }

      try {
        await inboundApi.updatePrice({
          id: orderId.value,
          items: [{ material_id: item.material_id, unit_price: Number(newPrice.toFixed(2)) }]
        })
        uni.showToast({ title: '修改成功', icon: 'success' })
        loadDetail()
      } catch (err) {
        uni.showToast({ title: err.message || '修改失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

onMounted(() => {
  const pages = getCurrentPages()
  const currentPage = pages[pages.length - 1]
  orderId.value = currentPage.$page?.options?.id || ''
  loadDetail()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding: 20rpx;
}

.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 30rpx;
    padding-bottom: 20rpx;
    border-bottom: 1rpx solid #f0f0f0;

    .order-no {
      font-size: 32rpx;
      font-weight: bold;
      color: #333;
    }

    .order-amount {
      font-size: 32rpx;
      font-weight: bold;
      color: #0B4F95;
    }
  }

  .card-body {
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 16rpx 0;

      .label {
        font-size: 26rpx;
        color: #999;
      }

      .value {
        font-size: 26rpx;
        color: #333;

        &.highlight {
          color: #0B4F95;
          font-weight: bold;
        }
      }
    }
  }
}

.items-title {
  font-size: 28rpx;
  font-weight: bold;
  color: #333;
  margin-bottom: 20rpx;
}

.item-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f0f0f0;

  &:last-child {
    border-bottom: none;
  }

  .item-main {
    flex: 1;

    .item-name {
      font-size: 28rpx;
      color: #333;
      display: block;
    }

    .item-spec {
      font-size: 22rpx;
      color: #999;
      margin-top: 6rpx;
      display: block;
    }
  }

  .item-num {
    text-align: right;

    .item-qty {
      font-size: 28rpx;
      font-weight: 500;
      color: #0B4F95;
      display: block;
    }

    .item-price {
      font-size: 22rpx;
      color: #999;
      margin-top: 6rpx;
      display: block;
    }
  }
}

.items-empty {
  text-align: center;
  padding: 40rpx;
  color: #999;
  font-size: 26rpx;
}

.action-bar {
  margin-top: 40rpx;

  .btn-edit {
    background: #0B4F95;
    color: #fff;
    border-radius: 12rpx;
    padding: 24rpx;
    font-size: 30rpx;
    width: 100%;

    &::after {
      border: none;
    }
  }
}
</style>
