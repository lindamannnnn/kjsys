<template>
  <view class="container">
    <!-- 搜索栏 -->
    <view class="search-bar">
      <view class="search-input">
        <text class="search-icon">🔍</text>
        <input
          v-model="keyword"
          class="input"
          placeholder="搜索物料名称/规格"
          placeholder-class="placeholder"
          @input="onSearch"
        />
      </view>
      <view class="scan-btn" @click="onScan">
        <text>📷</text>
      </view>
    </view>

    <!-- 仓库切换：配件仓和成品仓的货要分开看，否则容易入错仓 -->
    <scroll-view v-if="warehouses.length > 1" class="wh-bar" scroll-x>
      <view
        v-for="w in warehouses"
        :key="w._id"
        class="wh-item"
        :class="{ active: Number(warehouseId) === Number(w._id) }"
        @click="switchWarehouse(w)"
      >
        {{ w.name }}
      </view>
    </scroll-view>

    <!-- 细分类筛选：配件仓按编号分类、成品仓按车间，与后台物料页一致 -->
    <scroll-view v-if="subCategories.length" class="sub-bar" scroll-x>
      <view class="sub-item" :class="{ active: activeSub === '' }" @click="selectSub('')">全部</view>
      <view
        v-for="s in subCategories"
        :key="s"
        class="sub-item"
        :class="{ active: activeSub === s }"
        @click="selectSub(s)"
      >
        {{ s }}
      </view>
    </scroll-view>

    <!-- 物料列表 -->
    <scroll-view
      class="material-list"
      scroll-y
      @scrolltolower="loadMore"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in materialList"
        :key="item._id"
        class="material-item"
        @click="onSelectMaterial(item)"
      >
        <view class="material-info">
          <text class="material-name">{{ item.name }}</text>
          <text class="material-spec">{{ item.material_no ? item.material_no + ' · ' : '' }}{{ item.spec || '无规格' }}</text>
          <text v-if="item.sub_category" class="material-cat">{{ item.sub_category }}</text>
          <text class="material-stock">库存: {{ item.current_stock }} {{ item.unit }}</text>
        </view>
        <view class="material-action">
          <text class="select-text">选择</text>
        </view>
      </view>

      <view v-if="loadingMore" class="loading-more">
        <text>加载中...</text>
      </view>

      <view v-else-if="noMore" class="no-more">
        <text>没有更多了</text>
      </view>

      <view v-else-if="materialList.length === 0" class="empty">
        <text class="empty-icon">📦</text>
        <text class="empty-text">暂无物料</text>
      </view>
    </scroll-view>

    <!-- 底部选中物料表单 -->
    <view v-if="selectedMaterial" class="submit-panel">
      <view class="selected-info">
        <text class="selected-name">{{ selectedMaterial.name }}</text>
        <text class="selected-stock">当前库存: {{ selectedMaterial.current_stock }} {{ selectedMaterial.unit }}</text>
      </view>

      <view class="form-group">
        <view class="form-item">
          <text class="label">入库数量</text>
          <input
            v-model="quantity"
            class="input"
            type="number"
            placeholder="请输入数量"
            placeholder-class="placeholder"
          />
        </view>

        <view class="form-item">
          <text class="label">单价（元）</text>
          <input
            v-model="unitPrice"
            class="input"
            type="digit"
            placeholder="请输入单价"
            placeholder-class="placeholder"
            @input="calcTotal"
          />
        </view>

        <view class="form-item">
          <text class="label">小计（元）</text>
          <view class="total-price">
            ¥ {{ totalPrice }}
          </view>
        </view>

        <view class="form-item">
          <text class="label">供应商（选填）</text>
          <input
            v-model="supplier"
            class="input"
            placeholder="请输入供应商名称"
            placeholder-class="placeholder"
          />
        </view>

        <view class="form-item">
          <text class="label">备注（选填）</text>
          <input
            v-model="remark"
            class="input"
            placeholder="选填"
            placeholder-class="placeholder"
          />
        </view>
      </view>

      <button
        class="btn-submit"
        :disabled="!canSubmit"
        @click="onSubmit"
      >
        提交入库
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { inboundApi, materialApi, warehouseApi } from '@/utils/api'

// 数据
const keyword = ref('')
const materialList = ref([])
const page = ref(1)
const pageSize = ref(20)
const loadingMore = ref(false)
const noMore = ref(false)
const refreshing = ref(false)

// 仓库：配件仓与成品仓的物料必须分开显示
const warehouses = ref([])
const warehouseId = ref('')

// 细分类筛选：配件仓=编号分类（A001 板材型材…），成品仓=车间
const subCategories = ref([])
const activeSub = ref('')

const selectedMaterial = ref(null)
const quantity = ref('')
const unitPrice = ref('')
const supplier = ref('')
const remark = ref('')

// 计算属性
const totalPrice = computed(() => {
  const q = Number(quantity.value) || 0
  const p = Number(unitPrice.value) || 0
  return (q * p).toFixed(2)
})

const canSubmit = computed(() => {
  return selectedMaterial.value &&
         quantity.value &&
         Number(quantity.value) > 0 &&
         unitPrice.value &&
         Number(unitPrice.value) > 0
})

// 搜索物料
function onSearch() {
  page.value = 1
  noMore.value = false
  loadMaterials()
}

/** 读取仓库列表（只有一个仓库时切换条自动隐藏） */
async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    const list = res.list || []
    warehouses.value = list
    if (list.length && !warehouseId.value) {
      warehouseId.value = list[0]._id
    }
  } catch (err) {
    console.warn('加载仓库失败', err)
  }
}

/** 切换仓库：清空当前列表并重拉 */
function switchWarehouse(w) {
  if (Number(warehouseId.value) === Number(w._id)) return
  warehouseId.value = w._id
  activeSub.value = ''
  page.value = 1
  noMore.value = false
  materialList.value = []
  loadCategories()
  loadMaterials()
}

/** 读取当前仓库的细分类清单（配件仓=编号分类，成品仓=车间） */
async function loadCategories() {
  try {
    const res = await materialApi.categories({ warehouse_id: warehouseId.value || undefined })
    subCategories.value = res.subCategories || []
  } catch (err) {
    subCategories.value = []
  }
}

/** 点选/再点取消 细分类筛选 */
function selectSub(s) {
  activeSub.value = activeSub.value === s ? '' : s
  page.value = 1
  noMore.value = false
  loadMaterials()
}

// 加载物料列表
async function loadMaterials() {
  loadingMore.value = true
  try {
    const res = await materialApi.list({
      keyword: keyword.value,
      warehouse_id: warehouseId.value || undefined,
      sub_category: activeSub.value || undefined,
      page: page.value,
      pageSize: pageSize.value
    })
    const list = res.list || []
    materialList.value = page.value === 1 ? list : [...materialList.value, ...list]
    noMore.value = list.length === 0 || materialList.value.length >= (res.total || 0)
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loadingMore.value = false
    refreshing.value = false
  }
}

// 加载更多
function loadMore() {
  if (!noMore.value && !loadingMore.value) {
    page.value++
    loadMaterials()
  }
}

// 下拉刷新
function onRefresh() {
  page.value = 1
  noMore.value = false
  loadMaterials()
}

// 扫码
function onScan() {
  uni.scanCode({
    success: (res) => {
      keyword.value = res.result
      onSearch()
    }
  })
}

// 选择物料
function onSelectMaterial(item) {
  selectedMaterial.value = item
  quantity.value = ''
  unitPrice.value = ''
  supplier.value = ''
  remark.value = ''
}

// 计算小计
function calcTotal() {
  // 自动计算，无需操作
}

// 提交入库
async function onSubmit() {
  if (!canSubmit.value) return

  const material = selectedMaterial.value
  if (!material || !material.warehouse_id) {
    uni.showToast({ title: '物料缺少仓库信息，请重新选择', icon: 'none' })
    return
  }

  const items = [{
    material_id: material._id,
    material_name: material.name,
    material_spec: material.spec,
    quantity: Number(quantity.value),
    unit: material.unit,
    unit_price: Number(unitPrice.value)
  }]

  uni.showLoading({ title: '提交中...' })
  try {
    const res = await inboundApi.submit({
      items,
      supplier: supplier.value,
      remark: remark.value,
      warehouse_id: material.warehouse_id
    })

    uni.hideLoading()
    uni.vibrateShort()

    uni.showToast({
      title: `入库成功 ${res.order_no || ''}`,
      icon: 'none',
      duration: 2000
    })

    // 清空表单
    selectedMaterial.value = null
    quantity.value = ''
    unitPrice.value = ''
    supplier.value = ''
    remark.value = ''

    // 重新拉取列表，刷新库存
    onRefresh()
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none', duration: 3000 })
  }
}

// 页面加载
onMounted(async () => {
  await loadWarehouses()
  loadCategories()
  loadMaterials()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding-bottom: 500rpx;
}

/* 仓库切换条 */
.wh-bar {
  white-space: nowrap;
  padding: 16rpx 20rpx;
  background: #fff;
  border-bottom: 1rpx solid #f0f0f0;

  .wh-item {
    display: inline-block;
    padding: 12rpx 36rpx;
    margin-right: 16rpx;
    border-radius: 36rpx;
    background: #f5f5f5;
    font-size: 26rpx;
    color: #666;
    line-height: 1.6;

    &.active {
      background: #0B4F95;
      color: #fff;
      font-weight: bold;
    }
  }
}

/* 细分类筛选条 */
.sub-bar {
  white-space: nowrap;
  padding: 10rpx 20rpx;
  background: #fff;
  border-bottom: 1rpx solid #f0f0f0;

  .sub-item {
    display: inline-block;
    padding: 8rpx 22rpx;
    margin-right: 12rpx;
    border-radius: 26rpx;
    background: #f0f0f0;
    font-size: 22rpx;
    color: #666;
    line-height: 1.5;

    &.active {
      background: #0B4F95;
      color: #fff;
    }
  }
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 20rpx;
  padding: 20rpx;
  background: #fff;
  position: sticky;
  top: 0;
  z-index: 100;

  .search-input {
    flex: 1;
    display: flex;
    align-items: center;
    background: #f5f5f5;
    border-radius: 40rpx;
    padding: 16rpx 24rpx;

    .search-icon {
      font-size: 28rpx;
      margin-right: 12rpx;
    }

    .input {
      flex: 1;
      font-size: 28rpx;
    }

    .placeholder {
      color: #999;
    }
  }

  .scan-btn {
    width: 80rpx;
    height: 80rpx;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 36rpx;
  }
}

.material-list {
  padding: 20rpx;
  height: calc(100vh - 690rpx);
}

.material-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .material-info {
    flex: 1;

    .material-name {
      font-size: 30rpx;
      font-weight: 500;
      color: #333;
      display: block;
    }

    .material-spec {
      font-size: 24rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }

    .material-cat {
      font-size: 22rpx;
      color: #0B4F95;
      margin-top: 6rpx;
      display: block;
    }

    .material-stock {
      font-size: 26rpx;
      color: #666;
      margin-top: 8rpx;
      display: block;
    }
  }

  .material-action {
    .select-text {
      font-size: 26rpx;
      color: #0B4F95;
      font-weight: 500;
    }
  }
}

.loading-more, .no-more, .empty {
  text-align: center;
  padding: 40rpx;
  color: #999;
  font-size: 26rpx;
}

.empty {
  .empty-icon {
    font-size: 80rpx;
    display: block;
    margin-bottom: 20rpx;
  }
}

.submit-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
  padding-bottom: calc(30rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(30rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -4rpx 20rpx rgba(0, 0, 0, 0.1);

  .selected-info {
    margin-bottom: 30rpx;
    padding-bottom: 20rpx;
    border-bottom: 1rpx solid #f0f0f0;

    .selected-name {
      font-size: 32rpx;
      font-weight: bold;
      color: #333;
      display: block;
    }

    .selected-stock {
      font-size: 26rpx;
      color: #666;
      margin-top: 8rpx;
      display: block;
    }
  }

  .form-group {
    margin-bottom: 30rpx;

    .form-item {
      margin-bottom: 24rpx;

      .label {
        font-size: 26rpx;
        color: #666;
        display: block;
        margin-bottom: 12rpx;
      }

      .input {
        background: #f5f5f5;
        border-radius: 12rpx;
        padding: 20rpx 24rpx;
        font-size: 30rpx;
        width: 100%;
        box-sizing: border-box;
      }

      .placeholder {
        color: #999;
      }

      .total-price {
        background: #f5f5f5;
        border-radius: 12rpx;
        padding: 20rpx 24rpx;
        font-size: 32rpx;
        font-weight: bold;
        color: #0B4F95;
      }
    }
  }

  .btn-submit {
    background: #0B4F95;
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
