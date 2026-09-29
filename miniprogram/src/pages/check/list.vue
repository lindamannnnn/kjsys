<template>
  <view class="container">
    <!-- 盘点任务列表 -->
    <scroll-view
      class="check-list"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in checkList"
        :key="item._id"
        class="check-item"
        :class="item.status"
        @click="goDetail(item)"
      >
        <view class="check-header">
          <text class="check-no">{{ item.check_no }}</text>
          <text class="check-status" :class="item.status">{{ statusText(item.status) }}</text>
        </view>
        <view class="check-body">
          <view class="info-row">
            <text class="label">盘点类型</text>
            <text class="value">{{ typeText(item.type) }}</text>
          </view>
          <view class="info-row">
            <text class="label">盘点范围</text>
            <text class="value">{{ scopeText(item.scope) }}</text>
          </view>
          <view class="info-row">
            <text class="label">物料数量</text>
            <text class="value">{{ item.item_count || 0 }} 项</text>
          </view>
          <view class="info-row">
            <text class="label">已盘 / 差异</text>
            <text class="value">{{ item.checked_count || 0 }} / {{ item.diff_count || 0 }}</text>
          </view>
          <view class="info-row">
            <text class="label">创建时间</text>
            <text class="value">{{ formatDate(item.created_at, 'YYYY-MM-DD HH:mm') }}</text>
          </view>
        </view>
        <view class="check-footer">
          <text class="operator">创建人: {{ item.operator_name }}</text>
          <text v-if="item.status === 'pending'" class="action-text">开始盘点 →</text>
          <text v-else-if="item.status === 'in_progress'" class="action-text">继续盘点 →</text>
          <text v-else class="action-text">查看详情 →</text>
        </view>
      </view>

      <view v-if="checkList.length === 0" class="empty">
        <text class="empty-icon">📋</text>
        <text class="empty-text">暂无盘点任务</text>
      </view>
    </scroll-view>

    <!-- 新建盘点任务 -->
    <view class="create-bar">
      <button class="btn-create" @click="openCreate">＋ 新建盘点任务</button>
    </view>

    <!-- 新建盘点：类型 / 仓库 / 范围 -->
    <view v-if="createVisible" class="mask" @click="createVisible = false">
      <view class="sheet" @click.stop="noop">
        <view class="sheet-title">新建盘点任务</view>

        <view class="sheet-row">
          <text class="sheet-label">盘点类型</text>
          <picker :range="typeOptions" range-key="label" :value="typeIndex" @change="onTypeChange">
            <view class="sheet-value">{{ typeOptions[typeIndex].label }} ▾</view>
          </picker>
        </view>

        <view class="sheet-row">
          <text class="sheet-label">盘点仓库</text>
          <picker
            :range="warehouseOptions"
            range-key="name"
            :value="warehouseIndex"
            @change="onWarehouseChange"
          >
            <view class="sheet-value">
              {{ currentWarehouse ? currentWarehouse.name : '加载中...' }} ▾
            </view>
          </picker>
        </view>

        <view class="sheet-row">
          <text class="sheet-label">盘点范围</text>
          <view class="sheet-value" @click="openMaterialPicker">
            <text v-if="pickedMaterials.length" class="picked-text">已选 {{ pickedMaterials.length }} 项物料</text>
            <text v-else class="warn-text">整仓（全部物料）</text>
            <text class="link"> 选择物料 ›</text>
          </view>
        </view>

        <view v-if="!pickedMaterials.length" class="tip-box">
          不选物料 = 盘点该仓库全部物料，明细很多。日常盘点建议点「选择物料」只挑要盘的货。
        </view>

        <button class="sheet-btn" :disabled="creating" @click="doCreate">
          {{ creating ? '创建中...' : '创建盘点任务' }}
        </button>
      </view>
    </view>

    <!-- 选物料弹层 -->
    <view v-if="pickerVisible" class="mask" @click="pickerVisible = false">
      <view class="sheet tall" @click.stop="noop">
        <view class="sheet-title">选择要盘点的物料</view>
        <view class="picker-search">
          <input
            v-model="pickerKeyword"
            class="picker-input"
            placeholder="搜索物料名称 / 规格"
            placeholder-class="placeholder"
            @input="onPickerSearch"
          />
        </view>
        <scroll-view class="picker-list" scroll-y @scrolltolower="loadMorePicker">
          <view
            v-for="m in pickerList"
            :key="m._id"
            class="picker-item"
            :class="{ picked: isPicked(m._id) }"
            @click="togglePick(m)"
          >
            <view class="picker-item-main">
              <text class="picker-name">{{ m.name }}</text>
              <text class="picker-sub">{{ m.spec || '无规格' }} · 库存 {{ m.current_stock }} {{ m.unit }}</text>
            </view>
            <text class="picker-check">{{ isPicked(m._id) ? '✓' : '' }}</text>
          </view>
          <view v-if="pickerLoading" class="picker-empty">加载中...</view>
          <view v-else-if="!pickerList.length" class="picker-empty">没有匹配的物料</view>
        </scroll-view>
        <view class="picker-foot">
          <text class="picker-count">已选 {{ pickedMaterials.length }} 项</text>
          <view class="picker-btns">
            <text class="picker-btn ghost" @click="clearPicked">清空</text>
            <text class="picker-btn" @click="pickerVisible = false">确定</text>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { formatDate } from '@/utils/format'
import { checkApi, materialApi, statsApi } from '@/utils/api'

const checkList = ref([])
const refreshing = ref(false)

/* ---------- 新建盘点：类型 / 仓库 / 范围 ---------- */
const createVisible = ref(false)
const creating = ref(false)

const typeOptions = [
  { label: '全盘', type: 'full' },
  { label: '抽盘', type: 'sample' },
  { label: '循环盘', type: 'cycle' }
]
const typeIndex = ref(0)

const warehouseOptions = ref([])
const warehouseIndex = ref(0)
const currentWarehouse = computed(() => warehouseOptions.value[warehouseIndex.value] || null)

// 已选物料；为空表示整仓盘点
const pickedMaterials = ref([])
const pickerVisible = ref(false)
const pickerKeyword = ref('')
const pickerList = ref([])
const pickerPage = ref(1)
const pickerNoMore = ref(false)
const pickerLoading = ref(false)

function noop() {}

async function loadWarehouses() {
  try {
    // warehouseSummary 已按当前账号的仓库权限过滤，避免选到无权仓库后创建被拒
    const res = await statsApi.warehouseSummary()
    warehouseOptions.value = res.list || []
    if (warehouseIndex.value >= warehouseOptions.value.length) warehouseIndex.value = 0
  } catch (err) {
    uni.showToast({ title: err.message || '仓库加载失败', icon: 'none' })
  }
}

function openCreate() {
  createVisible.value = true
  if (!warehouseOptions.value.length) loadWarehouses()
}

function onTypeChange(e) {
  typeIndex.value = Number(e.detail.value)
}

function onWarehouseChange(e) {
  warehouseIndex.value = Number(e.detail.value)
  // 换仓库后，之前选的物料属于别的仓库，必须清掉
  pickedMaterials.value = []
}

function openMaterialPicker() {
  if (!currentWarehouse.value) {
    uni.showToast({ title: '仓库还没加载好，请稍后重试', icon: 'none' })
    return
  }
  pickerVisible.value = true
  pickerKeyword.value = ''
  pickerPage.value = 1
  pickerNoMore.value = false
  pickerList.value = []
  loadPicker()
}

async function loadPicker() {
  if (pickerLoading.value || pickerNoMore.value) return
  const wh = currentWarehouse.value
  if (!wh) return
  pickerLoading.value = true
  try {
    const res = await materialApi.list({
      keyword: pickerKeyword.value,
      warehouse_id: wh._id,
      page: pickerPage.value,
      pageSize: 30
    })
    const list = res.list || []
    pickerList.value = pickerPage.value === 1 ? list : [...pickerList.value, ...list]
    pickerNoMore.value = list.length < 30
  } catch (err) {
    uni.showToast({ title: err.message || '物料加载失败', icon: 'none' })
  } finally {
    pickerLoading.value = false
  }
}

function onPickerSearch() {
  pickerPage.value = 1
  pickerNoMore.value = false
  pickerList.value = []
  loadPicker()
}

function loadMorePicker() {
  if (pickerNoMore.value || pickerLoading.value) return
  pickerPage.value++
  loadPicker()
}

function isPicked(id) {
  return pickedMaterials.value.some(m => m._id === id)
}

function togglePick(m) {
  const idx = pickedMaterials.value.findIndex(x => x._id === m._id)
  if (idx >= 0) {
    pickedMaterials.value.splice(idx, 1)
  } else {
    pickedMaterials.value.push({ _id: m._id, name: m.name })
  }
}

function clearPicked() {
  pickedMaterials.value = []
}

// 创建盘点任务
async function doCreate() {
  const wh = currentWarehouse.value
  if (!wh) {
    uni.showToast({ title: '请先选择仓库', icon: 'none' })
    return
  }

  // 整仓盘点：物料多时强行提醒一次，避免误建上千条明细
  // 后端对「未选物料 + 物料数较多」有二次确认守卫，必须显式带上 confirm_full_scan
  const isFullScan = !pickedMaterials.value.length
  if (isFullScan && Number(wh.material_count) > 200) {
    const goOn = await new Promise((resolve) => {
      uni.showModal({
        title: '确认整仓盘点？',
        content: `「${wh.name}」有 ${wh.material_count} 项物料，整仓盘点会生成同样多的明细，工作量大。建议改成抽盘，只选要盘的物料。`,
        confirmText: '仍要整仓',
        cancelText: '我去选物料',
        success: (r) => resolve(r.confirm)
      })
    })
    if (!goOn) {
      openMaterialPicker()
      return
    }
  }

  creating.value = true
  uni.showLoading({ title: '创建中...', mask: true })
  try {
    const created = await checkApi.create({
      type: typeOptions[typeIndex.value].type,
      warehouse_id: wh._id,
      scope: {
        material_ids: pickedMaterials.value.map(m => m._id),
        categories: []
      },
      // 不选物料 = 整仓，用户已在界面上确认过
      confirm_full_scan: isFullScan
    })
    uni.hideLoading()
    createVisible.value = false
    pickedMaterials.value = []
    uni.showToast({ title: '盘点任务已创建', icon: 'success' })
    loadChecks()
    if (created && created._id) {
      const newId = created._id
      setTimeout(() => {
        uni.navigateTo({ url: `/pages/check/submit?id=${newId}` })
      }, 800)
    }
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '创建失败', icon: 'none', duration: 3000 })
  } finally {
    creating.value = false
  }
}

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

function scopeText(scope) {
  if (!scope) return '全部物料'
  if (scope.categories?.length) return `分类: ${scope.categories.join(',')}`
  if (scope.material_ids?.length) return `指定 ${scope.material_ids.length} 项`
  return '全部物料'
}

function goDetail(item) {
  if (item.status === 'pending' || item.status === 'in_progress') {
    uni.navigateTo({ url: `/pages/check/submit?id=${item._id}` })
  } else {
    uni.navigateTo({ url: `/pages/check/detail?id=${item._id}` })
  }
}

function onRefresh() {
  loadChecks()
}

async function loadChecks() {
  try {
    const res = await checkApi.list({ page: 1, pageSize: 100 })
    checkList.value = res.list || []
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    refreshing.value = false
  }
}

onMounted(() => {
  loadChecks()
  loadWarehouses()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding: 20rpx;
}

.check-list {
  height: calc(100vh - 200rpx);
}

.check-item {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  &.pending {
    border-left: 8rpx solid #f39c12;
  }

  &.in_progress {
    border-left: 8rpx solid #3498db;
  }

  &.pending_review {
    border-left: 8rpx solid #9b59b6;
  }

  &.completed {
    border-left: 8rpx solid #27ae60;
  }

  &.cancelled {
    border-left: 8rpx solid #95a5a6;
  }

  .check-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20rpx;

    .check-no {
      font-size: 28rpx;
      font-weight: 500;
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
  }

  .check-body {
    margin-bottom: 20rpx;

    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8rpx 0;

      .label {
        font-size: 26rpx;
        color: #999;
      }

      .value {
        font-size: 26rpx;
        color: #333;
      }
    }
  }

  .check-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 20rpx;
    border-top: 1rpx solid #f0f0f0;

    .operator {
      font-size: 24rpx;
      color: #999;
    }

    .action-text {
      font-size: 26rpx;
      color: #8A6A10;
      font-weight: 500;
    }
  }
}

.empty {
  text-align: center;
  padding: 100rpx 40rpx;

  .empty-icon {
    font-size: 80rpx;
    display: block;
    margin-bottom: 20rpx;
  }

  .empty-text {
    font-size: 28rpx;
    color: #999;
  }
}

.create-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 20rpx;
  background: #fff;
  box-shadow: 0 -4rpx 20rpx rgba(0, 0, 0, 0.1);

  .btn-create {
    background: #8A6A10;
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

/* ---------- 弹层（新建盘点 / 选物料） ---------- */
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
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
  box-sizing: border-box;

  &.tall {
    height: 80vh;
    display: flex;
    flex-direction: column;
  }

  .sheet-title {
    font-size: 32rpx;
    font-weight: bold;
    color: #333;
    margin-bottom: 30rpx;
    text-align: center;
  }

  .sheet-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 24rpx 0;
    border-bottom: 1rpx solid #f0f0f0;

    .sheet-label {
      font-size: 28rpx;
      color: #666;
    }

    .sheet-value {
      font-size: 28rpx;
      color: #333;

      .picked-text {
        color: #8A6A10;
        font-weight: 500;
      }

      .warn-text {
        color: #e67e22;
      }

      .link {
        color: #8A6A10;
      }
    }
  }

  .tip-box {
    margin-top: 24rpx;
    padding: 20rpx;
    background: #fdf6e3;
    border-radius: 12rpx;
    font-size: 24rpx;
    color: #8a6a10;
    line-height: 1.6;
  }

  .sheet-btn {
    margin-top: 40rpx;
    background: #8A6A10;
    color: #fff;
    border-radius: 12rpx;
    padding: 26rpx;
    font-size: 30rpx;
    width: 100%;

    &:disabled {
      background: #ccc;
    }

    &::after {
      border: none;
    }
  }
}

.picker-search {
  padding-bottom: 20rpx;

  .picker-input {
    background: #f5f5f5;
    border-radius: 40rpx;
    padding: 18rpx 28rpx;
    font-size: 28rpx;
    width: 100%;
    box-sizing: border-box;
  }

  .placeholder {
    color: #999;
  }
}

.picker-list {
  flex: 1;
  height: 0;

  .picker-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 24rpx 8rpx;
    border-bottom: 1rpx solid #f5f5f5;

    &.picked {
      background: #f6f9f3;
    }

    .picker-item-main {
      flex: 1;

      .picker-name {
        font-size: 28rpx;
        color: #333;
        display: block;
      }

      .picker-sub {
        font-size: 22rpx;
        color: #999;
        margin-top: 6rpx;
        display: block;
      }
    }

    .picker-check {
      width: 60rpx;
      text-align: center;
      font-size: 32rpx;
      color: #27ae60;
      font-weight: bold;
    }
  }

  .picker-empty {
    text-align: center;
    padding: 60rpx;
    color: #999;
    font-size: 26rpx;
  }
}

.picker-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 24rpx;
  border-top: 1rpx solid #f0f0f0;

  .picker-count {
    font-size: 26rpx;
    color: #666;
  }

  .picker-btns {
    display: flex;
    gap: 20rpx;

    .picker-btn {
      font-size: 28rpx;
      color: #fff;
      background: #8A6A10;
      padding: 14rpx 40rpx;
      border-radius: 40rpx;

      &.ghost {
        background: #f0f0f0;
        color: #666;
      }
    }
  }
}
</style>
