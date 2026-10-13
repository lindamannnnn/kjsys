<template>
  <view class="container">
    <!-- 盘点单信息 -->
    <view class="check-info">
      <view class="info-line">
        <text class="check-no">{{ check.check_no }}</text>
        <text class="check-type">{{ typeText(check.type) }}</text>
      </view>
      <text v-if="check.warehouse_name" class="check-meta">仓库：{{ check.warehouse_name }}</text>
      <text v-if="check.remark" class="check-meta">备注：{{ check.remark }}</text>
      <text v-if="readonly" class="check-lock">该盘点单已提交，等待审核，不能重复修改</text>
    </view>

    <!-- 录入进度 + 快捷操作 -->
    <view class="progress-bar">
      <text class="progress-text">
        已录入 {{ enteredCount }} / {{ totalCount }} 项<text v-if="diffCount"> · 有差异 {{ diffCount }} 项</text>
      </text>
      <view v-if="!readonly" class="quick-ops">
        <text class="quick-fill" @click="fillRestWithBook">其余按账面数填</text>
        <text v-if="enteredCount" class="quick-clear" @click="clearAll">清空重录</text>
      </view>
    </view>

    <!-- 盘点物料列表 -->
    <scroll-view class="material-list" scroll-y>
      <view
        v-for="(item, index) in check.items"
        :key="item.material_id"
        class="material-item"
        :class="{ entered: isEntered(item) }"
      >
        <view class="material-header">
          <text class="material-name">{{ item.material_name }}</text>
          <text class="book-stock">账面: {{ item.book_stock }}</text>
        </view>
        <view class="input-row">
          <text class="label">实际数量</text>
          <input
            v-model="item.actual_stock"
            class="input"
            type="number"
            :disabled="readonly"
            placeholder="没盘到可留空"
            placeholder-class="placeholder"
            @input="onQuantityChange(index)"
          />
        </view>
        <text v-if="item.error" class="row-error">{{ item.error }}</text>
        <view v-if="item.difference !== undefined" class="difference-row">
          <text class="label">差异</text>
          <text class="value" :class="{ positive: item.difference > 0, negative: item.difference < 0 }">
            {{ item.difference > 0 ? '+' : '' }}{{ item.difference }}
          </text>
        </view>
      </view>
    </scroll-view>

    <!-- 提交按钮 -->
    <view class="submit-bar">
      <text class="submit-tip">留空的物料不会被提交，可以下次补盘</text>
      <button
        class="btn-submit"
        :disabled="!canSubmit || readonly"
        @click="onSubmit"
      >
        {{ readonly ? '已提交，等待审核' : `提交已录入的 ${enteredCount} 项` }}
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { checkApi } from '@/utils/api'

const check = ref({})
const checkId = ref('')
const loading = ref(false)
// 提交闩锁：防止手快连点造成重复提交（后端幂等兜底，这里是第一道门）
const submitting = ref(false)

/** 是否已录入实际数量 */
function isEntered(item) {
  return item.actual_stock !== '' && item.actual_stock !== undefined && item.actual_stock !== null
}

const totalCount = computed(() => (check.value.items || []).length)

const enteredCount = computed(() => (check.value.items || []).filter(isEntered).length)

const diffCount = computed(() =>
  (check.value.items || []).filter(
    it => isEntered(it) && it.difference !== undefined && Number(it.difference) !== 0
  ).length
)

// 已提交待审核 / 已完成的盘点单不能再改（后端也会拦，这里提前告知用户）
const readonly = computed(() =>
  ['pending_review', 'completed', 'approved', 'cancelled'].includes(check.value.status)
)

const canSubmit = computed(() => {
  if (readonly.value) return false
  if (!check.value.items || !check.value.items.length) return false
  // 只要求：录入了至少一项，且已录入的项都合法
  // （整仓盘点动辄上千项，不能再要求"全部填满"）
  const entered = check.value.items.filter(isEntered)
  if (!entered.length) return false
  return entered.every(item => !item.error)
})

function typeText(type) {
  const map = {
    'full': '全盘',
    'sample': '抽盘',
    'cycle': '循环盘点'
  }
  return map[type] || type
}

function onQuantityChange(index) {
  const item = check.value.items[index]
  const raw = item.actual_stock

  if (raw === '' || raw === undefined || raw === null) {
    item.error = ''
    item.difference = undefined
    return
  }

  const num = Number(raw)
  if (!Number.isFinite(num)) {
    item.error = '请输入数字'
    item.difference = undefined
  } else if (!Number.isInteger(num)) {
    item.error = '实际数量必须是整数，不能填小数'
    item.difference = undefined
  } else if (num < 0) {
    item.error = '实际数量不能是负数'
    item.difference = undefined
  } else {
    item.error = ''
    item.difference = num - Number(item.book_stock)
  }
}

/** 把还没录的物料按账面数填入（实物与账面一致时最省事）
 *  ⚠️ 2026-10-09 加二次确认：整仓上千项，误点一次全部变成「无差异」，
 *    原先没有确认也没有反向操作，只能逐项清 —— 用户反馈会误提交。 */
async function fillRestWithBook() {
  // 数一下会被填的项，用于确认文案（没有可填的就不用弹了）
  const pending = check.value.items.filter((it) => !isEntered(it)).length
  if (!pending) {
    uni.showToast({ title: '所有物料都已录入', icon: 'none' })
    return
  }

  const confirmed = await new Promise((resolve) => {
    uni.showModal({
      title: '按账面数填充',
      content: `将把剩余 ${pending} 项全部填成账面数（视为无差异）。\n确认后可用「清空重录」撤销。`,
      confirmText: '填充',
      success: (res) => resolve(res.confirm)
    })
  })
  if (!confirmed) return

  let filled = 0
  check.value.items.forEach((item, index) => {
    if (!isEntered(item)) {
      item.actual_stock = String(item.book_stock == null ? 0 : item.book_stock)
      onQuantityChange(index)
      filled++
    }
  })
  uni.showToast({ title: `已按账面数填入 ${filled} 项`, icon: 'none' })
}

/** 清空已录入的实际数量（「其余按账面数填」点错后的反向操作） */
async function clearAll() {
  const entered = enteredCount.value
  if (!entered) return

  const confirmed = await new Promise((resolve) => {
    uni.showModal({
      title: '清空重录',
      content: `将清空已录入的 ${entered} 项实际数量，可以重新盘点。\n（不会影响账面数）`,
      confirmText: '清空',
      success: (res) => resolve(res.confirm)
    })
  })
  if (!confirmed) return

  check.value.items.forEach((item) => {
    item.actual_stock = ''
    item.error = ''
    item.difference = undefined
  })
  uni.showToast({ title: '已清空，可重新录入', icon: 'none' })
}

async function loadCheck() {
  if (!checkId.value) {
    uni.showToast({ title: '盘点单不存在', icon: 'none' })
    return
  }

  loading.value = true
  try {
    const res = await checkApi.detail({ id: checkId.value })
    check.value = {
      ...res,
      items: (res.items || []).map(item => ({
        ...item,
        // 未录入的盘点项 actual_stock 为 null，输入框需转成空串
        actual_stock: item.actual_stock === null || item.actual_stock === undefined
          ? ''
          : String(item.actual_stock),
        difference: item.difference === null || item.difference === undefined
          ? undefined
          : Number(item.difference),
        error: ''
      }))
    }
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}

async function onSubmit() {
  if (!canSubmit.value) return
  // 正在提交中，忽略后续点击（连点不产生第二次提交）
  if (submitting.value) return

  const items = check.value.items
    .filter(isEntered)
    .map(item => ({
      material_id: item.material_id,
      actual_stock: Number(item.actual_stock)
    }))

  const remaining = totalCount.value - items.length
  const confirmed = await new Promise((resolve) => {
    uni.showModal({
      title: '确认提交',
      content:
        `本次提交 ${items.length} 项，其中 ${diffCount.value} 项有差异。\n` +
        (remaining > 0 ? `还有 ${remaining} 项没盘到，这次不会提交。\n` : '') +
        // 2026-10-09：老板已不参与审核（check.review = admin/director），文案跟着改，
        // 否则仓管会一直等老板点审核。
        '提交后需由管理员/厂长审核才改库存。',
      confirmText: '确认提交',
      success: (res) => resolve(res.confirm)
    })
  })
  if (!confirmed) return

  submitting.value = true
  // mask: true 会盖一层遮罩挡住点击，避免提交过程中再次触发
  uni.showLoading({ title: '提交中...', mask: true })
  try {
    await checkApi.submit({ id: checkId.value, items })
    uni.hideLoading()
    uni.showToast({ title: '提交成功，待审核', icon: 'success' })
    setTimeout(() => {
      uni.navigateBack()
    }, 1500)
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none', duration: 3000 })
  } finally {
    submitting.value = false
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
  /* 整屏高度：H5 减掉顶部导航，小程序端 --window-top 为 0（原生导航在 webview 之外）。
     列表用 flex:1 填满剩余空间，避免列表底离屏幕底差一截、露出纯背景灰带。 */
  height: 100vh;
  height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
}

.check-info {
  background: #fff;
  padding: 30rpx;
  margin-bottom: 16rpx;

  .info-line {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .check-no {
    font-size: 32rpx;
    font-weight: bold;
    color: #333;
  }

  .check-type {
    font-size: 26rpx;
    color: #8A6A10;
    background: #fef3c7;
    padding: 8rpx 20rpx;
    border-radius: 8rpx;
  }

  .check-meta {
    display: block;
    font-size: 24rpx;
    color: #999;
    margin-top: 12rpx;
  }

  .check-lock {
    display: block;
    font-size: 24rpx;
    color: #e67e22;
    margin-top: 12rpx;
  }
}

.progress-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  padding: 0 30rpx 24rpx;

  .progress-text {
    font-size: 26rpx;
    color: #666;
  }

  .quick-ops {
    display: flex;
    align-items: center;
    gap: 16rpx;
  }

  .quick-fill {
    font-size: 24rpx;
    color: #8A6A10;
    background: #fef3c7;
    padding: 8rpx 20rpx;
    border-radius: 30rpx;
  }

  .quick-clear {
    font-size: 24rpx;
    color: #e74c3c;
    background: #fdecea;
    padding: 8rpx 20rpx;
    border-radius: 30rpx;
  }
}

.material-list {
  /* 填满「盘点信息以下 → 屏幕底」，底部再垫出固定提交栏的高度（栏高实测 233rpx），
     否则滚到底时最后一张卡片会被这条栏盖住 */
  flex: 1;
  min-height: 0;
  padding: 0 20rpx;
  padding-bottom: 240rpx;
}

.material-item {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
  border-left: 6rpx solid transparent;

  &.entered {
    border-left-color: #27ae60;
  }

  .material-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20rpx;

    .material-name {
      font-size: 30rpx;
      font-weight: 500;
      color: #333;
    }

    .book-stock {
      font-size: 26rpx;
      color: #666;
    }
  }

  .input-row {
    display: flex;
    align-items: center;
    gap: 20rpx;

    .label {
      font-size: 26rpx;
      color: #666;
      width: 140rpx;
    }

    .input {
      flex: 1;
      background: #f5f5f5;
      border-radius: 12rpx;
      /* uni-app H5 给 uni-input 写死了 height:1.4em + overflow:hidden：
         只写上下 padding 会被吃掉，内层 input 塌成 1px，输入的字看不见。
         显式给高度与行高，小程序端同样成立。 */
      height: 88rpx;
      line-height: 88rpx;
      padding: 0 24rpx;
      font-size: 30rpx;
      box-sizing: border-box;
    }

    .placeholder {
      color: #999;
    }
  }

  .row-error {
    display: block;
    font-size: 22rpx;
    color: #e74c3c;
    margin-top: 10rpx;
  }

  .difference-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 20rpx;
    padding-top: 20rpx;
    border-top: 1rpx solid #f0f0f0;

    .label {
      font-size: 26rpx;
      color: #666;
    }

    .value {
      font-size: 28rpx;
      font-weight: bold;

      &.positive {
        color: #27ae60;
      }

      &.negative {
        color: #e74c3c;
      }
    }
  }
}

.submit-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  padding: 20rpx 30rpx 30rpx;
  box-shadow: 0 -4rpx 20rpx rgba(0, 0, 0, 0.1);

  .submit-tip {
    display: block;
    font-size: 22rpx;
    color: #999;
    text-align: center;
    margin-bottom: 16rpx;
  }

  .btn-submit {
    background: #8A6A10;
    color: #fff;
    border-radius: 12rpx;
    padding: 28rpx;
    font-size: 32rpx;
    width: 100%;

    &:disabled {
      background: #ccc;
    }

    &::after {
      border: none;
    }
  }
}
</style>
