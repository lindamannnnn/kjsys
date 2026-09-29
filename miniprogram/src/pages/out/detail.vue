<template>
  <view class="container">
    <!-- 单据信息 -->
    <view class="card">
      <view class="card-header">
        <text class="order-no">{{ order.order_no }}</text>
        <text class="order-status" :class="order.status">{{ statusText(order.status) }}</text>
      </view>
      <view class="card-body">
        <view class="info-row">
          <text class="label">所属仓库</text>
          <text class="value">{{ order.warehouse_name }}</text>
        </view>
        <view class="info-row">
          <text class="label">出库类型</text>
          <text class="value">{{ typeText(order.type) }}</text>
        </view>
        <view class="info-row">
          <text class="label">用途/备注</text>
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

    <!-- 出库明细（逐项） -->
    <view class="card">
      <view class="card-header">
        <text class="section-title">出库明细（{{ (order.items || []).length }} 项）</text>
      </view>
      <view class="card-body">
        <view
          v-for="(it, index) in (order.items || [])"
          :key="index"
          class="item-row"
        >
          <view class="item-main">
            <text class="item-name">{{ it.material_name }}{{ it.material_spec ? ' / ' + it.material_spec : '' }}</text>
            <text
              v-if="it.current_stock !== undefined && it.current_stock !== null"
              class="item-stock"
            >现存 {{ it.current_stock }} {{ it.unit || '' }}</text>
          </view>
          <text class="item-qty">{{ it.quantity }} {{ it.unit }}</text>
        </view>
        <view v-if="!(order.items || []).length" class="info-row">
          <text class="label">明细</text>
          <text class="value">无明细</text>
        </view>
      </view>
    </view>

    <!-- 审批 / 确认 / 作废信息（如有）
         王总报的 P2-3-06：提交人、确认人、驳回人都有，唯独缺作废人——
         追责链断了（谁把这单作废的、为什么，得能在单子上看到） -->
    <view
      v-if="order.confirm_operator_name || order.reject_reason || order.cancel_operator_name"
      class="card"
    >
      <view class="card-header">
        <text class="section-title">审批信息</text>
      </view>
      <view class="card-body">
        <view v-if="order.confirm_operator_name" class="info-row">
          <text class="label">确认人</text>
          <text class="value">{{ order.confirm_operator_name }}</text>
        </view>
        <view v-if="order.confirmed_at" class="info-row">
          <text class="label">确认时间</text>
          <text class="value">{{ formatDate(order.confirmed_at, 'YYYY-MM-DD HH:mm:ss') }}</text>
        </view>
        <view v-if="order.reject_operator_name" class="info-row">
          <text class="label">驳回人</text>
          <text class="value">{{ order.reject_operator_name }}</text>
        </view>
        <view v-if="order.reject_reason" class="info-row">
          <text class="label">驳回原因</text>
          <text class="value">{{ order.reject_reason }}</text>
        </view>
        <view v-if="order.cancel_operator_name" class="info-row">
          <text class="label">作废人</text>
          <text class="value">{{ order.cancel_operator_name }}</text>
        </view>
        <view v-if="order.cancel_reason" class="info-row">
          <text class="label">作废原因</text>
          <text class="value">{{ order.cancel_reason }}</text>
        </view>
      </view>
    </view>

    <!-- 撤销按钮（10分钟内可撤销） -->
    <view v-if="canCancel" class="action-bar">
      <button class="btn-cancel" @click="onCancel">
        撤销此单
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { formatDate } from '@/utils/format'
import { outboundApi, statusText, typeText } from '@/utils/api'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const order = ref({})
const canCancel = ref(false)
const orderId = ref('')

async function loadDetail() {
  if (!orderId.value) return
  try {
    const res = await outboundApi.detail({ id: orderId.value })
    order.value = res || {}

    // 待确认 + 10 分钟内 + 本人操作才可撤销
    // 身份比对必须和后端一致（openid 优先，账号密码登录时退回用户名），否则自己的单也看不到撤销按钮
    const createdTime = new Date(order.value.created_at).getTime()
    const isWithin10Min = (Date.now() - createdTime) < 10 * 60 * 1000
    const isOwnOrder = !!userStore.identity && order.value.operator_openid === userStore.identity
    canCancel.value = order.value.status === 'pending' && isWithin10Min && isOwnOrder
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  }
}

function onCancel() {
  uni.showModal({
    title: '撤销此单',
    editable: true,
    placeholderText: '撤销原因（选填）· 撤销后已扣的库存会回补',
    confirmText: '撤销',
    cancelText: '再想想',
    success: async (res) => {
      if (!res.confirm) return
      const reason = String(res.content || '').trim()
      try {
        await outboundApi.cancel({ id: orderId.value, reason })
        uni.showToast({ title: '撤销成功', icon: 'success' })
        setTimeout(() => {
          uni.navigateBack()
        }, 1500)
      } catch (err) {
        uni.showToast({ title: err.message || '撤销失败', icon: 'none', duration: 3000 })
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

    .order-status {
      font-size: 24rpx;
      padding: 8rpx 16rpx;
      border-radius: 8rpx;

      &.pending {
        background: #fff3cd;
        color: #856404;
      }

      &.confirmed {
        background: #d4edda;
        color: #155724;
      }

      &.approved {
        background: #d4edda;
        color: #155724;
      }

      &.cancelled {
        background: #e2e3e5;
        color: #4b5157;
      }

      &.rejected {
        background: #f8d7da;
        color: #721c24;
      }

      &.completed {
        background: #d1ecf1;
        color: #0c5460;
      }
    }

    .section-title {
      font-size: 28rpx;
      font-weight: 500;
      color: #333;
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
          color: #0F7A3D;
          font-weight: bold;
        }
      }
    }

    .item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16rpx 0;
      border-bottom: 1rpx solid #f7f7f7;

      &:last-child {
        border-bottom: none;
      }

      .item-main {
        flex: 1;

        .item-name {
          font-size: 26rpx;
          color: #333;
          display: block;
        }

        .item-stock {
          font-size: 22rpx;
          color: #999;
          margin-top: 6rpx;
          display: block;
        }
      }

      .item-qty {
        font-size: 26rpx;
        color: #0F7A3D;
        font-weight: bold;
      }
    }
  }
}

.action-bar {
  margin-top: 40rpx;

  .btn-cancel {
    background: #e74c3c;
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
