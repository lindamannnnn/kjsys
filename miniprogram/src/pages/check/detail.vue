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
        <!-- 2026-10-09：整仓上千项时全量铺出来太重，且无差异项混在中间难挑。
             默认只看有差异的，需要时切「全部」。 -->
        <view class="diff-switch">
          <text
            class="diff-switch-item"
            :class="{ active: onlyDiff }"
            @click="onlyDiff = true"
          >仅有差异</text>
          <text
            class="diff-switch-item"
            :class="{ active: !onlyDiff }"
            @click="onlyDiff = false"
          >全部 {{ (check.items || []).length }}</text>
        </view>
      </view>
      <view class="diff-summary">
        共 {{ (check.items || []).length }} 项，其中 {{ diffCount }} 项有差异
        <text v-if="enteredCount < (check.items || []).length" class="summary-sub">
          （{{ (check.items || []).length - enteredCount }} 项未盘到）
        </text>
      </view>
      <view class="card-body">
        <view v-if="!displayItems.length" class="diff-empty">
          ✅ 本次盘点没有差异项
        </view>
        <view
          v-for="item in displayItems"
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

    <!-- 审核操作（待审核 + 管理员/厂长） -->
    <view v-if="canReview" class="review-bar">
      <button class="btn-reject" @click="onReview(false)">退回重盘</button>
      <button class="btn-approve" @click="onReview(true)">审核通过</button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { formatDate } from '@/utils/format'
import { checkApi } from '@/utils/api'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const check = ref({})
const checkId = ref('')
const loading = ref(false)
/** 差异明细是否只看有差异项（默认是；整仓上千项时全量太重） */
const onlyDiff = ref(true)

// 仅待审核状态下，管理员/厂长可审核（厂长有审核盘点的权限）
// ⚠️ 2026-10-09 用户要求：老板不再参与审核 → 去掉 boss（后端 check.review 已同步收回）
const canReview = computed(() =>
  check.value.status === 'pending_review' && userStore.hasRole(['director', 'admin'])
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

/** 差异明细实际渲染的列表：默认过滤出「已录入且有差异」的项 */
const displayItems = computed(() => {
  const items = check.value.items || []
  if (!onlyDiff.value) return items
  return items.filter(
    it => it.difference !== null && it.difference !== undefined && Number(it.difference) !== 0
  )
})

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

// 审核：通过则按差异回写库存；退回则重新盘点（可填原因）
async function onReview(approve) {
  let remark = ''

  if (!approve) {
    // 2026-10-09：退回时收集原因 —— 后端 check.review 本就支持 remark 入参，
    // 原先不传，盘点人只看到「已退回」不知道哪里要重盘，只能靠猜。
    // 用 showModal 的 editable（微信基础库 2.17.1+）拿输入，不额外开页面。
    const res = await new Promise((resolve) => {
      uni.showModal({
        title: '退回重盘',
        editable: true,
        placeholderText: '说明要重盘的原因，例如：成品仓 3 项数量对不上',
        confirmText: '确认',
        success: (r) => resolve(r)
      })
    })
    if (!res.confirm) return
    remark = (res.content || '').trim()
    if (!remark) {
      uni.showToast({ title: '请填写退回原因', icon: 'none' })
      return
    }
  } else {
    const confirmed = await new Promise((resolve) => {
      uni.showModal({
        title: '审核通过',
        content: '通过后将按差异回写库存，是否确认？',
        confirmText: '通过',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!confirmed) return
  }

  uni.showLoading({ title: '处理中...', mask: true })
  try {
    await checkApi.review({ id: checkId.value, approve, remark })
    uni.hideLoading()
    uni.showToast({ title: approve ? '审核完成' : '已退回', icon: 'success' })
    loadCheck()
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '操作失败', icon: 'none' })
  }
}

// 页面参数必须用 uni-app 的 onLoad 拿：getCurrentPages().$page.options 在
// 微信小程序端拿不到 id（H5 能拿到），导致详情页数据全空、按钮不显示（V4 实测踩坑）
onLoad((options) => {
  checkId.value = (options && options.id) || ''
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

    /* 「仅有差异 / 全部」切换（2026-10-09 新增） */
    .diff-switch {
      display: flex;
      border: 1rpx solid #e0e0e0;
      border-radius: 30rpx;
      overflow: hidden;

      .diff-switch-item {
        font-size: 22rpx;
        color: #888;
        padding: 6rpx 18rpx;

        &.active {
          background: #8A6A10;
          color: #fff;
        }
      }
    }
  }

  .diff-empty {
    padding: 40rpx 0;
    text-align: center;
    font-size: 26rpx;
    color: #27ae60;
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
