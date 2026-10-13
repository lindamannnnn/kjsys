<template>
  <view class="container">
    <!-- 单据信息 -->
    <view class="card">
      <view class="card-header">
        <text class="order-no">{{ order.order_no }}</text>
        <text class="order-status" :class="order.status">{{ statusText(order.status) }}</text>
      </view>

      <!-- 流程进度：待确认 → 待拣货 → 待收货 → 已完成 -->
      <view class="steps">
        <view
          v-for="(s, i) in steps"
          :key="s.key"
          class="step"
          :class="{ done: s.done, current: s.current }"
        >
          <view class="step-dot">{{ s.done ? '✓' : i + 1 }}</view>
          <text class="step-name">{{ s.name }}</text>
          <view v-if="i < steps.length - 1" class="step-line" :class="{ done: steps[i + 1].done || steps[i + 1].current }"></view>
        </view>
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
        <view v-if="order.attachment" class="info-row">
          <text class="label">现场照片</text>
          <text class="value link" @click="previewAttachment">点击查看</text>
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

    <!-- 库存状态提示：让领料员知道现在到底扣没扣 -->
    <view v-if="order.status === 'receiving'" class="tip-card tip-blue">
      <text class="tip-icon">📦</text>
      <text class="tip-text">
        仓管已拣货完成，请到场核对实物。点下方「确认收货」后系统才扣减库存。
      </text>
    </view>
    <view v-else-if="order.status === 'picking'" class="tip-card tip-purple">
      <text class="tip-icon">⏳</text>
      <text class="tip-text">仓管正在拣货，拣完会给你发消息，届时回来确认收货即可。</text>
    </view>

    <!-- 出库明细（逐项） -->
    <view class="card">
      <view class="card-header">
        <text class="section-title">领料明细（{{ (order.items || []).length }} 项）</text>
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

    <!-- 流转记录：谁确认、谁拣货、谁收货，一条都不少，便于追责 -->
    <view v-if="hasFlowInfo" class="card">
      <view class="card-header">
        <text class="section-title">流转记录</text>
      </view>
      <view class="card-body">
        <view v-if="order.confirm_operator_name" class="info-row">
          <text class="label">确认人</text>
          <text class="value">{{ order.confirm_operator_name }}{{ order.confirmed_at ? ' · ' + formatDate(order.confirmed_at, 'MM-DD HH:mm') : '' }}</text>
        </view>
        <view v-if="order.pick_operator_name" class="info-row">
          <text class="label">拣货人</text>
          <text class="value">{{ order.pick_operator_name }}{{ order.picked_at ? ' · ' + formatDate(order.picked_at, 'MM-DD HH:mm') : '' }}</text>
        </view>
        <view v-if="order.receive_operator_name" class="info-row">
          <text class="label">收货人</text>
          <text class="value">{{ order.receive_operator_name }}{{ order.received_at ? ' · ' + formatDate(order.received_at, 'MM-DD HH:mm') : '' }}</text>
        </view>
        <view v-if="order.reject_operator_name" class="info-row">
          <text class="label">驳回人</text>
          <text class="value">{{ order.reject_operator_name }}</text>
        </view>
        <view v-if="order.reject_reason" class="info-row">
          <text class="label">驳回原因</text>
          <text class="value warn">{{ order.reject_reason }}</text>
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

    <!-- 操作区 -->
    <view v-if="canReceive" class="action-bar">
      <button class="btn-receive" @click="onReceive">确认收货（扣减库存）</button>
      <text class="action-hint">请先核对实物与清单一致再确认</text>
    </view>

    <view v-if="canCancel" class="action-bar">
      <button class="btn-cancel" @click="onCancel">撤销此单</button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { formatDate } from '@/utils/format'
import { outboundApi, statusText, typeText } from '@/utils/api'
import { fullFileUrl } from '@/utils/cloud'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const order = ref({})
const canCancel = ref(false)
const canReceive = ref(false)
const orderId = ref('')

/** 四步进度：已完成的前三步按时间戳判断，最后一步看 status */
const steps = computed(() => {
  const o = order.value
  const reachedReceive = ['receiving', 'completed'].includes(o.status)
  const reachedPick = ['receiving', 'completed'].includes(o.status)
  const reachedConfirm = ['picking', 'receiving', 'completed'].includes(o.status)
  const done = o.status === 'completed'
  return [
    { key: 'submit', name: '已提交', done: true, current: o.status === 'pending' },
    { key: 'confirm', name: '仓管确认', done: reachedConfirm, current: o.status === 'picking' },
    { key: 'pick', name: '拣货完成', done: reachedPick, current: o.status === 'receiving' },
    { key: 'receive', name: '确认收货', done, current: false }
  ]
})

const hasFlowInfo = computed(() => {
  const o = order.value
  return !!(o.confirm_operator_name || o.pick_operator_name || o.receive_operator_name
    || o.reject_reason || o.cancel_operator_name)
})

function previewAttachment() {
  if (order.value.attachment) {
    uni.previewImage({ urls: [fullFileUrl(order.value.attachment)] })
  }
}

async function loadDetail() {
  if (!orderId.value) return
  try {
    const res = await outboundApi.detail({ id: orderId.value })
    order.value = res || {}
    refreshActions()
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  }
}

function refreshActions() {
  const o = order.value
  // 身份比对必须和后端一致（openid 优先，账号密码登录时退回用户名）
  const isOwnOrder = !!userStore.identity && o.operator_openid === userStore.identity
  // 2026-10-09 老板只读：出库单的确认收货不再给老板
  const canManage = userStore.hasRole(['storekeeper', 'admin'])

  // 待确认 + 本人 → 可撤销（不限时：pending 态没动库存，随时可撤无副作用）
  canCancel.value = o.status === 'pending' && isOwnOrder

  // 待收货 → 领料员本人或仓管可确认收货
  canReceive.value = o.status === 'receiving' && (isOwnOrder || canManage)
}

function onReceive() {
  uni.showModal({
    title: '确认收货',
    content: '确认已收到全部物料？\n确认后系统会扣减库存，单据完成，不能再改。',
    confirmText: '确认收货',
    cancelText: '再看看',
    success: async (res) => {
      if (!res.confirm) return
      uni.showLoading({ title: '处理中...', mask: true })
      try {
        await outboundApi.receive({ id: orderId.value })
        uni.hideLoading()
        uni.showToast({ title: '已确认收货', icon: 'success' })
        await loadDetail()
      } catch (err) {
        uni.hideLoading()
        uni.showToast({ title: err.message || '确认失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

function onCancel() {
  uni.showModal({
    title: '撤销此单',
    editable: true,
    placeholderText: '撤销原因（选填）· 撤销后若已扣库存会回补',
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

// 页面参数必须用 uni-app 的 onLoad 拿：getCurrentPages().$page.options 在
// 微信小程序端拿不到 id（H5 能拿到），导致详情页数据全空、按钮不显示（V4 实测踩坑）
onLoad((options) => {
  orderId.value = (options && options.id) || ''
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
    margin-bottom: 24rpx;
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

      &.picking {
        background: #efeaf7;
        color: #5b4b8a;
      }

      &.receiving {
        background: #d1ecf1;
        color: #0c5460;
      }

      &.confirmed {
        background: #d4edda;
        color: #155724;
      }

      &.completed {
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
        flex-shrink: 0;
      }

      .value {
        font-size: 26rpx;
        color: #333;
        text-align: right;
        margin-left: 20rpx;

        &.link {
          color: #0B4F95;
          text-decoration: underline;
        }

        &.warn {
          color: #e74c3c;
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

/* 四步进度 */
.steps {
  display: flex;
  align-items: flex-start;
  margin-bottom: 24rpx;

  .step {
    flex: 1;
    position: relative;
    text-align: center;

    .step-dot {
      width: 48rpx;
      height: 48rpx;
      line-height: 48rpx;
      border-radius: 50%;
      background: #e8e8e8;
      color: #999;
      font-size: 24rpx;
      margin: 0 auto 10rpx;
      position: relative;
      z-index: 2;
    }

    .step-name {
      font-size: 20rpx;
      color: #999;
      display: block;
    }

    .step-line {
      position: absolute;
      top: 24rpx;
      left: 50%;
      width: 100%;
      height: 2rpx;
      background: #e8e8e8;
      z-index: 1;

      &.done {
        background: #27ae60;
      }
    }

    &.done {
      .step-dot {
        background: #27ae60;
        color: #fff;
      }

      .step-name {
        color: #27ae60;
      }
    }

    &.current {
      .step-dot {
        background: #6b5b95;
        color: #fff;
      }

      .step-name {
        color: #6b5b95;
        font-weight: bold;
      }
    }
  }
}

.tip-card {
  display: flex;
  gap: 16rpx;
  border-radius: 12rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;

  &.tip-blue {
    background: #e8f4f8;
    border: 1rpx solid #b6e0ec;
  }

  &.tip-purple {
    background: #f3effa;
    border: 1rpx solid #d9cff0;
  }

  .tip-icon {
    font-size: 32rpx;
  }

  .tip-text {
    flex: 1;
    font-size: 24rpx;
    color: #555;
    line-height: 1.6;
  }
}

.action-bar {
  margin-top: 40rpx;

  .btn-receive {
    background: #27ae60;
    color: #fff;
    border-radius: 12rpx;
    padding: 24rpx;
    font-size: 32rpx;
    font-weight: bold;
    width: 100%;

    &::after {
      border: none;
    }
  }

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

  .action-hint {
    display: block;
    text-align: center;
    font-size: 22rpx;
    color: #999;
    margin-top: 14rpx;
  }
}
</style>
