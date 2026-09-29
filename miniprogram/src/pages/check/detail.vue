<template>
  <view class="container">
    <!-- 盘点单信息 -->
    <view class="card">
      <view class="card-header">
        <text class="check-no">{{ check.check_no }}</text>
        <text class="check-status" :class="check.status">{{ statusText(check.status) }}</text>
      </view>
      <view class="card-body">
        <view class="info-row">
          <text class="label">盘点类型</text>
          <text class="value">{{ typeText(check.type) }}</text>
        </view>
        <view class="info-row">
          <text class="label">创建时间</text>
          <text class="value">{{ formatDate(check.created_at, 'YYYY-MM-DD HH:mm:ss') }}</text>
        </view>
        <view class="info-row">
          <text class="label">完成时间</text>
          <text class="value">{{ formatDate(check.completed_at, 'YYYY-MM-DD HH:mm:ss') || '未完成' }}</text>
        </view>
        <view class="info-row">
          <text class="label">操作员</text>
          <text class="value">{{ check.operator_name }}</text>
        </view>
        <view class="info-row">
          <text class="label">审核人</text>
          <text class="value">{{ check.reviewer_name || '未审核' }}</text>
        </view>
        <view v-if="check.remark" class="info-row">
          <text class="label">备注</text>
          <text class="value remark-value">{{ check.remark }}</text>
        </view>
      </view>
    </view>

    <!-- 盘点差异明细 -->
    <view class="card">
      <view class="card-header">
        <text class="section-title">盘点差异明细</text>
      </view>
      <view class="diff-summary">
        共 {{ (check.items || []).length }} 项，其中 {{ diffCount }} 项有差异
        <text v-if="enteredCount < (check.items || []).length" class="summary-sub">
          （{{ (check.items || []).length - enteredCount }} 项未盘到）
        </text>
      </view>
      <view class="card-body">
        <view
          v-for="item in check.items"
          :key="item.material_id"
          class="difference-item"
        >
          <view class="material-info">
            <text class="material-name">{{ item.material_name }}</text>
          </view>
          <view class="stock-info">
            <view class="stock-row">
              <text class="label">账面库存</text>
              <text class="value">{{ item.book_stock }}</text>
            </view>
            <view class="stock-row">
              <text class="label">实际库存</text>
              <text class="value">{{ actualText(item.actual_stock) }}</text>
            </view>
            <view class="stock-row">
              <text class="label">差异</text>
              <text class="value" :class="{ positive: item.difference > 0, negative: item.difference < 0 }">
                {{ diffText(item.difference) }}
              </text>
            </view>
          </view>
        </view>
      </view>
    </view>

    <!-- 审核操作（待审核 + 老板/管理员） -->
    <view v-if="canReview" class="review-bar">
      <button class="btn-reject" @click="onReview(false)">退回重盘</button>
      <button class="btn-approve" @click="onReview(true)">审核通过</button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { formatDate } from '@/utils/format'
import { checkApi } from '@/utils/api'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const check = ref({})
const checkId = ref('')
const loading = ref(false)

// 仅待审核状态下，老板/管理员可审核
const canReview = computed(() =>
  check.value.status === 'pending_review' && userStore.hasRole(['boss', 'admin'])
)

const enteredCount = computed(() =>
  (check.value.items || []).filter(
    it => it.actual_stock !== null && it.actual_stock !== undefined
  ).length
)

const diffCount = computed(() =>
  (check.value.items || []).filter(
    it => it.difference !== null && it.difference !== undefined && Number(it.difference) !== 0
  ).length
)

function statusText(status) {
  const map = {
    'pending': '待盘点',
    'in_progress': '盘点中',
    'pending_review': '待审核',
    'completed': '已完成',
    'cancelled': '已取消'
  }
  return map[status] || status
}

function typeText(type) {
  const map = {
    'full': '全盘',
    'sample': '抽盘',
    'cycle': '循环盘点'
  }
  return map[type] || type
}

// 未录入的实际库存为 null
function actualText(value) {
  return value === null || value === undefined ? '未录入' : value
}

// 未录入时差异为 null
function diffText(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  return `${n > 0 ? '+' : ''}${n}`
}

async function loadCheck() {
  if (!checkId.value) {
    uni.showToast({ title: '盘点单不存在', icon: 'none' })
    return
  }

  loading.value = true
  try {
    const res = await checkApi.detail({ id: checkId.value })
    check.value = { ...res, items: res.items || [] }
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}

// 审核：通过则按差异回写库存，退回则重新盘点
async function onReview(approve) {
  const confirmed = await new Promise((resolve) => {
    uni.showModal({
      title: approve ? '审核通过' : '退回重盘',
      content: approve ? '通过后将按差异回写库存，是否确认？' : '退回后需重新盘点，是否确认？',
      success: (res) => resolve(res.confirm)
    })
  })
  if (!confirmed) return

  uni.showLoading({ title: '处理中...' })
  try {
    await checkApi.review({ id: checkId.value, approve })
    uni.hideLoading()
    uni.showToast({ title: approve ? '审核完成' : '已退回', icon: 'success' })
    loadCheck()
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '操作失败', icon: 'none' })
  }
}

onMounted(() => {
  const pages = getCurrentPages()
  const currentPage = pages[pages.length - 1]
  checkId.value = currentPage.$page?.options?.id || ''
  loadCheck()
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

    .check-no {
      font-size: 32rpx;
      font-weight: bold;
      color: #333;
    }
    .check-status {
      font-size: 24rpx;
      padding: 8rpx 16rpx;
      border-radius: 8rpx;

      &.pending {
        background: #fff3cd;
        color: #856404;
      }

      &.in_progress {
        background: #cce5ff;
        color: #004085;
      }

      &.pending_review {
        background: #e8daef;
        color: #4a235a;
      }

      &.completed {
        background: #d4edda;
        color: #155724;
      }

      &.cancelled {
        background: #e2e3e5;
        color: #4b5157;
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
      padding: 12rpx 0;

      .label {
        font-size: 26rpx;
        color: #999;
      }

      .value {
        font-size: 26rpx;
        color: #333;

        &.remark-value {
          flex: 1;
          text-align: right;
          margin-left: 20rpx;
          color: #666;
        }
      }
    }
  }

  .diff-summary {
    font-size: 24rpx;
    color: #666;
    padding-bottom: 20rpx;
    border-bottom: 1rpx solid #f7f7f7;
    margin-bottom: 10rpx;

    .summary-sub {
      color: #999;
    }
  }
}

.difference-item {
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f0f0f0;

  &:last-child {
    border-bottom: none;
  }

  .material-info {
    margin-bottom: 16rpx;

    .material-name {
      font-size: 28rpx;
      font-weight: 500;
      color: #333;
    }
  }

  .stock-info {
    background: #f9f9f9;
    border-radius: 12rpx;
    padding: 20rpx;

    .stock-row {
      display: flex;
      justify-content: space-between;
      padding: 8rpx 0;

      .label {
        font-size: 24rpx;
        color: #999;
      }

      .value {
        font-size: 24rpx;
        color: #333;

        &.positive {
          color: #27ae60;
          font-weight: bold;
        }

        &.negative {
          color: #e74c3c;
          font-weight: bold;
        }
      }
    }
  }
}

.review-bar {
  display: flex;
  gap: 20rpx;
  margin-top: 30rpx;

  button {
    flex: 1;
    border-radius: 12rpx;
    font-size: 30rpx;

    &::after {
      border: none;
    }
  }

  .btn-reject {
    background: #f5f5f5;
    color: #e74c3c;
  }

  .btn-approve {
    background: #8A6A10;
    color: #fff;
  }
}
</style>
