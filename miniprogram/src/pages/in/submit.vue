<template>
  <!-- 面板打开时给容器加标记，用于压缩列表高度，避免物料被面板永久压住 -->
  <view class="container" :class="{ 'has-panel': !!selectedMaterial }">
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

    <!-- 物料列表：点列表空白处 = 收起底部表单（物料卡片上有 .stop，不会误触） -->
    <scroll-view
      class="material-list"
      scroll-y
      @scrolltolower="loadMore"
      @click="closePanel"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in materialList"
        :key="item._id"
        class="material-item"
        @click.stop="onSelectMaterial(item)"
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

      <!-- 垫底：面板是浮在列表上的，垫高后最后几个物料也能滚到面板上方点到 -->
      <view v-if="selectedMaterial" class="panel-spacer"></view>
    </scroll-view>

    <!-- 底部选中物料表单：可点右上角 ✕ 收起，也可点列表空白处收起 -->
    <view v-if="selectedMaterial" class="submit-panel">
      <view class="panel-head">
        <view class="panel-grabber"></view>
        <view class="panel-close" @click.stop="closePanel">
          <text>✕</text>
        </view>
      </view>

      <view class="selected-info">
        <text class="selected-name">{{ selectedMaterial.name }}</text>
        <text class="selected-stock">当前库存: {{ selectedMaterial.current_stock }} {{ selectedMaterial.unit }}</text>
      </view>

      <view class="form-group">
        <!-- 数量与单价并排：面板是浮层，两个短数字各占一行会让面板过高、把物料列表压没 -->
        <view class="form-row">
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
// 提交闩锁：防止手快连点造成重复提交（后端幂等兜底，这里是第一道门）
const submitting = ref(false)

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

// 选择物料：再点一次同一物料 = 收起面板（避免"只进不出"）
function onSelectMaterial(item) {
  if (selectedMaterial.value && String(selectedMaterial.value._id) === String(item._id)) {
    closePanel()
    return
  }
  selectedMaterial.value = item
  quantity.value = ''
  unitPrice.value = ''
  supplier.value = ''
  remark.value = ''
}

// 收起底部表单：点 ✕、点列表空白处、再点同一物料都会走这里
function closePanel() {
  if (!selectedMaterial.value) return
  selectedMaterial.value = null
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
  // 正在提交中，忽略后续点击（连点不产生第二张单）
  if (submitting.value) return

  const material = selectedMaterial.value
  if (!material || !material.warehouse_id) {
    uni.showToast({ title: '物料缺少仓库信息，请重新选择', icon: 'none' })
    return
  }

  // 供应商是选填（与界面上「供应商（选填）」一致）：
  // 不是所有入库都有供应商 —— 车间自制、盘盈调整这类本就没有「跟谁买的」，
  // 强制填写会让这类货入不了账，所以这里不拦。
  // 「有没有供应商」由提交时的 type 体现，见下方 type 的处理。

  const items = [{
    material_id: material._id,
    material_name: material.name,
    material_spec: material.spec,
    quantity: Number(quantity.value),
    unit: material.unit,
    unit_price: Number(unitPrice.value)
  }]

  submitting.value = true
  // mask: true 会盖一层遮罩挡住点击，避免提交过程中再次触发
  uni.showLoading({ title: '提交中...', mask: true })
  try {
    const res = await inboundApi.submit({
      items,
      supplier: supplier.value,
      // 按「有没有填供应商」定单据类型：
      //   填了 → 采购入库（后台对账口径，后端会强制要供应商）
      //   没填 → 其他入库（车间自制、盘盈调整等，后端不强制）
      // 这里显式传，避免走后端默认值 purchase 而被当成采购入库卡住
      type: String(supplier.value || '').trim() ? 'purchase' : 'other',
      remark: remark.value,
      warehouse_id: material.warehouse_id
    })

    uni.hideLoading()
    uni.vibrateShort()

    uni.showToast({
      // 重复提交（上一次其实已成功）时说明是同一张单，避免用户以为入了两次
      title: res.__duplicated
        ? `该笔已提交过 ${res.order_no || ''}`
        : `入库成功 ${res.order_no || ''}`,
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
  } finally {
    submitting.value = false
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
  /* 整屏高度：H5 端顶部有导航条要减掉，小程序端这两个变量为 0（原生导航在 webview 之外）。
     用 var() 带兜底，两端都成立。
     不要再写 min-height:100vh + 列表 calc(100vh - 固定值)：那套魔法数字一旦对不上，
     列表底就会离屏幕底差一截，露出一条纯背景的灰带（实测差 143px）。 */
  height: 100vh;
  height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
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
      /* 同 .form-item .input：uni-input 默认 1.4em 高会裁字，必须显式给高度 */
      height: 44rpx;
      line-height: 44rpx;
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
  /* 弹性填满「筛选条以下 → 屏幕底」的全部剩余空间，不再用 calc(100vh - N) */
  flex: 1;
  min-height: 0; /* flex 子项默认 min-height:auto，会被内容顶开导致整页可滚动 */
  padding: 20rpx;
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
}

/* 面板打开时垫高列表，让最后一个物料也能滚到面板上方（面板是浮层，不占布局）。
   高度对齐面板的 max-height(82vh)，这样任何屏幕尺寸下最后一张卡片都能滚出面板。 */
.panel-spacer {
  height: 82vh;
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
  z-index: 200;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 16rpx 30rpx 30rpx;
  padding-bottom: calc(30rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(30rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -4rpx 20rpx rgba(0, 0, 0, 0.1);
  /* 小屏兜底：面板最高不超过视口 82%，装不下时面板内部滚动，按钮不会被顶出屏幕 */
  max-height: 82vh;
  overflow-y: auto;
  box-sizing: border-box;

  /* 顶部把手 + 收起按钮：面板不再"只进不出" */
  .panel-head {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 56rpx;
    margin-bottom: 10rpx;

    .panel-grabber {
      width: 80rpx;
      height: 8rpx;
      border-radius: 8rpx;
      background: #dcdcdc;
    }

    .panel-close {
      position: absolute;
      right: -10rpx;
      top: 0;
      width: 56rpx;
      height: 56rpx;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 30rpx;
      color: #999;
      line-height: 1;
    }
  }

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
    margin-bottom: 24rpx;

    /* 并排一行：数量 + 单价 */
    .form-row {
      display: flex;
      gap: 20rpx;

      .form-item {
        flex: 1;
        min-width: 0;
      }
    }

    .form-item {
      margin-bottom: 18rpx;

      .label {
        font-size: 26rpx;
        color: #666;
        display: block;
        margin-bottom: 10rpx;
      }

      .input {
        background: #f5f5f5;
        border-radius: 12rpx;
        /* uni-app H5 给 uni-input 写死了 height:1.4em + overflow:hidden，
           只写 padding 会被吃掉、文字被裁（实测外层框只有 22px、内层 input 只有 1px）。
           这里显式给高度与行高，双端都成立，同时把点击热区做到 88rpx。 */
        height: 88rpx;
        line-height: 88rpx;
        padding: 0 24rpx;
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
        height: 88rpx;
        line-height: 88rpx;
        padding: 0 24rpx;
        box-sizing: border-box;
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
