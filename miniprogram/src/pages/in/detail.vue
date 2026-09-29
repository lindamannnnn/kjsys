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
          <text class="label">所属仓库</text>
          <text class="value">{{ order.warehouse_name }}</text>
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

    <!-- 入库明细（逐项，含单价与小计） -->
    <view class="card">
      <view class="card-header">
        <text class="section-title">入库明细（{{ (order.items || []).length }} 项）</text>
      </view>
      <view class="card-body">
        <view
          v-for="(it, index) in (order.items || [])"
          :key="index"
          class="info-row"
        >
          <text class="label">{{ it.material_name }}{{ it.material_spec ? ' / ' + it.material_spec : '' }}</text>
          <text class="value highlight">{{ it.quantity }} {{ it.unit }} × ¥{{ it.unit_price }} = ¥{{ it.total_price }}</text>
        </view>
        <view v-if="!(order.items || []).length" class="info-row">
          <text class="label">明细</text>
          <text class="value">无明细</text>
        </view>
      </view>
    </view>

    <!-- 审批 / 确认 / 作废信息（追责链：提交人 → 确认人 / 驳回人 / 作废人）
         原来入库详情连「确认人」都不显示，作废更是查不到谁干的（王总 P2-3-06） -->
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

    <!-- 修改单价按钮 -->
    <view v-if="canEditPrice" class="action-bar">
      <button class="btn-edit" @click="onEditPrice">
        {{ order.status === 'confirmed' ? '改价（会重算成本价）' : '修改单价' }}
      </button>
    </view>

    <!-- 改价弹层：多明细逐项改，避免整单被覆盖成同一个价 -->
    <view v-if="priceVisible" class="mask" @click="priceVisible = false">
      <view class="sheet" @click.stop="noop">
        <view class="sheet-title">修改单价</view>
        <text class="sheet-sub">只改要改的那几项，其余保持原价</text>

        <scroll-view class="price-list" scroll-y>
          <view v-for="(it, idx) in priceItems" :key="idx" class="price-row">
            <view class="price-main">
              <text class="price-name">{{ it.material_name }}</text>
              <text class="price-sub">
                数量 {{ it.quantity }} {{ it.unit }} · 原价 ¥{{ it.origin_price }}
              </text>
            </view>
            <input
              v-model="it.new_price"
              class="price-input"
              type="digit"
              placeholder="新单价"
              placeholder-class="placeholder"
            />
          </view>
        </scroll-view>

        <view v-if="priceTip" class="price-tip">{{ priceTip }}</view>

        <view v-if="order.status === 'confirmed'" class="price-warn">
          该单已确认，改价会同步重算库存加权成本并留下流水记录。
        </view>

        <view class="sheet-btns">
          <text class="sheet-btn ghost" @click="priceVisible = false">取消</text>
          <text class="sheet-btn" @click="submitPrice">保存</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { formatDate } from '@/utils/format'
import { inboundApi } from '@/utils/api'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const order = ref({})
const canEditPrice = ref(false)
const orderId = ref('')

/* ---------- 改价弹层 ---------- */
const priceVisible = ref(false)
const priceItems = ref([])
const priceTip = ref('')

function noop() {}

async function loadDetail() {
  if (!orderId.value) return
  try {
    const res = await inboundApi.detail({ id: orderId.value })
    order.value = res || {}

    const isManager = userStore.hasRole(['boss', 'admin'])
    // 身份比对与后端一致：openid 优先，账号密码登录时退回用户名
    const isOwnOrder = !!userStore.identity && order.value.operator_openid === userStore.identity
    const isToday = new Date(order.value.created_at).toDateString() === new Date().toDateString()

    // 待确认：本人当天可改（管理不限当天）；已确认：只有老板/管理员能改
    canEditPrice.value =
      (order.value.status === 'pending' && (isManager || (isOwnOrder && isToday))) ||
      (order.value.status === 'confirmed' && isManager)
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  }
}

function onEditPrice() {
  priceItems.value = (order.value.items || []).map(it => ({
    material_id: it.material_id,
    material_name: it.material_name,
    quantity: it.quantity,
    unit: it.unit,
    origin_price: Number(it.unit_price),
    new_price: String(it.unit_price)
  }))
  priceTip.value = ''
  if (!priceItems.value.length) {
    uni.showToast({ title: '该单据没有明细', icon: 'none' })
    return
  }
  priceVisible.value = true
}

async function submitPrice() {
  // 只提交真正改动过的明细（后端按 material_id 精确改，不会再整单覆盖）
  const changed = []
  for (const it of priceItems.value) {
    const raw = String(it.new_price === null || it.new_price === undefined ? '' : it.new_price).trim()
    if (!raw) {
      priceTip.value = `「${it.material_name}」的单价不能留空`
      return
    }
    const p = Number(raw)
    if (!Number.isFinite(p) || p < 0) {
      priceTip.value = `「${it.material_name}」的单价必须是不小于 0 的数字`
      return
    }
    if (Math.abs(p - it.origin_price) > 0.001) {
      changed.push({ material_id: it.material_id, unit_price: Number(p.toFixed(2)) })
    }
  }

  if (!changed.length) {
    priceTip.value = '单价没有变化，不需要保存'
    return
  }

  uni.showLoading({ title: '保存中...' })
  try {
    await inboundApi.updatePrice({ id: orderId.value, items: changed })
    uni.hideLoading()
    priceVisible.value = false
    uni.showToast({ title: `已改 ${changed.length} 项单价`, icon: 'success' })
    loadDetail()
  } catch (err) {
    uni.hideLoading()
    priceTip.value = err.message || '修改失败'
  }
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

/* ---------- 改价弹层 ---------- */
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

  .price-list {
    flex: 1;
    max-height: 46vh;

    .price-row {
      display: flex;
      align-items: center;
      gap: 20rpx;
      padding: 20rpx 0;
      border-bottom: 1rpx solid #f5f5f5;

      .price-main {
        flex: 1;

        .price-name {
          font-size: 28rpx;
          color: #333;
          display: block;
        }

        .price-sub {
          font-size: 22rpx;
          color: #999;
          margin-top: 6rpx;
          display: block;
        }
      }

      .price-input {
        width: 180rpx;
        background: #f5f5f5;
        border-radius: 12rpx;
        padding: 16rpx 20rpx;
        font-size: 28rpx;
        text-align: center;
        box-sizing: border-box;
      }

      .placeholder {
        color: #bbb;
      }
    }
  }

  .price-tip {
    margin-top: 20rpx;
    padding: 18rpx;
    background: #fdecea;
    border-radius: 12rpx;
    font-size: 22rpx;
    color: #c0392b;
    line-height: 1.6;
  }

  .price-warn {
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
      background: #0B4F95;
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
