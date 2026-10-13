<template>
  <view class="container">
    <!-- 仓库切换 -->
    <view class="warehouse-bar">
      <text
        v-for="w in warehouses"
        :key="w._id"
        class="warehouse-tab"
        :class="{ active: currentWarehouse === w._id }"
        @click="onWarehouseChange(w._id)"
      >{{ w.name }}</text>
    </view>

    <!-- 搜索 -->
    <view class="search-bar">
      <input
        v-model="keyword"
        class="search-input"
        placeholder="搜索物料"
        placeholder-class="placeholder"
        @input="onSearch"
      />
    </view>

    <!-- 细分类筛选（配件仓按编号分类 / 成品仓按车间） -->
    <scroll-view v-if="subCategories.length" class="sub-bar" scroll-x>
      <view
        class="sub-chip"
        :class="{ active: activeSub === '' }"
        @click="onSubChange('')"
      >全部</view>
      <view
        v-for="s in subCategories"
        :key="s"
        class="sub-chip"
        :class="{ active: activeSub === s }"
        @click="onSubChange(s)"
      >{{ s }}</view>
    </scroll-view>

    <!-- 库存列表 -->
    <scroll-view
      class="stock-list"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
      @scrolltolower="onLoadMore"
    >
      <view
        v-for="item in displayList"
        :key="item._id"
        class="stock-card"
      >
        <!-- 物料照片缩略图（无照片时同尺寸占位，保证列表高度稳定） -->
        <image
          v-if="item.image_fileid"
          class="material-thumb"
          :src="fullFileUrl(item.image_fileid)"
          mode="aspectFill"
          @click.stop="previewMaterial(item)"
        />
        <view v-else class="material-thumb material-thumb-empty">
          <text>无图</text>
        </view>
        <view class="stock-info">
          <text class="material-name">{{ item.name }}</text>
          <text class="material-spec">{{ item.spec }} | {{ item.category }}</text>
        </view>
        <view class="stock-qty">
          <text class="qty-value" :class="{ warning: item.current_stock <= item.warning_stock }">
            {{ item.current_stock }}
          </text>
          <text class="qty-unit">{{ item.unit }}</text>
          <text v-if="item.current_stock <= item.warning_stock" class="warning-tag">预警</text>
        </view>
      </view>

      <view v-if="displayList.length === 0" class="empty">
        <text class="empty-icon">📦</text>
        <text class="empty-text">暂无物料</text>
      </view>

      <view v-if="displayList.length" class="load-more">
        <text v-if="loadingMore">加载中...</text>
        <text v-else-if="noMore">已经到底了</text>
        <text v-else>上拉加载更多</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { statsApi, warehouseApi, materialApi } from '@/utils/api'
import { debounce } from '@/utils/debounce'
import { fullFileUrl } from '@/utils/cloud'

const warehouses = ref([])
const currentWarehouse = ref('')
const keyword = ref('')
const displayList = ref([])
const refreshing = ref(false)
const subCategories = ref([])
const activeSub = ref('')

/* ---------- 分页 ---------- */
const PAGE_SIZE = 100
const page = ref(1)
const noMore = ref(false)
const loadingMore = ref(false)

/* ---------- 物料照片 ---------- */
/**
 * 看物料大图。
 * 台账是拿来点货的：货架上同名同规格的料不少，有照片对着看一眼比读规格快得多。
 * 照片由管理员/仓管在后台物料档案里维护，没有照片就没有可点的东西。
 */
function previewMaterial(item) {
  if (!item || !item.image_fileid) return
  uni.previewImage({ urls: [fullFileUrl(item.image_fileid)] })
}

function onWarehouseChange(id) {
  currentWarehouse.value = id
  activeSub.value = ''
  loadCategories()
  loadStock()
}

function onSubChange(s) {
  activeSub.value = activeSub.value === s ? '' : s
  loadStock()
}

async function loadCategories() {
  try {
    const res = await materialApi.categories({ warehouse_id: currentWarehouse.value || undefined })
    subCategories.value = res.subCategories || []
  } catch (err) {
    subCategories.value = []
  }
}

// 搜索防抖：统一走 @/utils/debounce，避免每敲一个字打一次接口
const onSearch = debounce(() => loadStock(), 300)

// 库存台账（真实接口）
function stockParams(p) {
  return {
    page: p,
    pageSize: PAGE_SIZE,
    keyword: keyword.value,
    sub_category: activeSub.value || undefined,
    warehouse_id: currentWarehouse.value || undefined
  }
}

// 下拉刷新 / 切仓 / 切分类 / 搜索：页码归 1，列表整体替换（不追加）
async function loadStock() {
  page.value = 1
  noMore.value = false
  try {
    const res = await statsApi.stockList(stockParams(page.value))
    const list = res.list || []
    displayList.value = list
    if (list.length < PAGE_SIZE || list.length >= (res.total ?? Infinity)) noMore.value = true
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    refreshing.value = false
  }
}

/** 上拉加载更多：追加下一页 */
async function onLoadMore() {
  if (noMore.value || loadingMore.value) return
  loadingMore.value = true
  const next = page.value + 1
  try {
    const res = await statsApi.stockList(stockParams(next))
    const list = res.list || []
    page.value = next
    displayList.value = [...displayList.value, ...list]
    if (list.length < PAGE_SIZE || displayList.value.length >= (res.total ?? Infinity)) noMore.value = true
  } catch (err) {
    uni.showToast({ title: err.message || '加载更多失败', icon: 'none' })
  } finally {
    loadingMore.value = false
  }
}

async function loadWarehouses() {
  const res = await warehouseApi.list()
  warehouses.value = (res.list || []).map((w) => ({ _id: w._id || w.id, name: w.name }))
  if (warehouses.value.length && !currentWarehouse.value) {
    currentWarehouse.value = warehouses.value[0]._id
  }
  loadCategories()
}

function onRefresh() {
  loadStock()
}

// 首次进入即加载（onMounted 兜底，防止页面生命周期在某些端不触发导致空白）
// 之后每次页面重新显示时刷新（含从子页面返回），所以点完确认回到工作台红点会同步
const __pageShowHandler = async () => {
  try {
    await loadWarehouses()
  } catch (err) {
    uni.showToast({ title: err.message || '仓库加载失败', icon: 'none' })
  }
  loadStock()
}
onMounted(() => {
  __pageShowHandler()      // 首屏一定加载（onMounted 兜底，不依赖任何注册成功与否）
  onShow(__pageShowHandler)  // 之后每次页面重新显示（含从子页返回）都刷新
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
}

.warehouse-bar {
  display: flex;
  background: #fff;
  padding: 20rpx;
  gap: 20rpx;
  border-bottom: 1rpx solid #f0f0f0;

  .warehouse-tab {
    flex: 1;
    text-align: center;
    padding: 16rpx;
    font-size: 28rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 12rpx;

    &.active {
      background: #6b5b95;
      color: #fff;
      font-weight: bold;
    }
  }
}

.search-bar {
  padding: 20rpx;
  background: #fff;
  border-bottom: 1rpx solid #f0f0f0;

  .search-input {
    background: #f5f5f5;
    border-radius: 40rpx;
    padding: 16rpx 24rpx;
    font-size: 28rpx;
  }

  .placeholder {
    color: #999;
  }
}

.sub-bar {
  background: #fff;
  padding: 12rpx 20rpx 16rpx;
  white-space: nowrap;
  border-bottom: 1rpx solid #f0f0f0;

  .sub-chip {
    display: inline-block;
    padding: 10rpx 24rpx;
    margin-right: 16rpx;
    font-size: 24rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 28rpx;

    &.active {
      background: #efeaf7;
      color: #6b5b95;
      font-weight: 500;
    }
  }
}

.stock-list {
  padding: 20rpx;
  height: calc(100vh - 200rpx);
}

.stock-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  /* 物料照片缩略图：有图/无图都占同样大小，列表高度才稳定 */
  .material-thumb {
    width: 88rpx;
    height: 88rpx;
    border-radius: 12rpx;
    margin-right: 20rpx;
    flex-shrink: 0;
    background: #f2f3f5;
  }

  .material-thumb-empty {
    display: flex;
    align-items: center;
    justify-content: center;

    text {
      font-size: 20rpx;
      color: #c0c4cc;
    }
  }

  .stock-info {
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
  }

  .stock-qty {
    text-align: right;

    .qty-value {
      font-size: 40rpx;
      font-weight: bold;
      color: #333;

      &.warning {
        color: #e74c3c;
      }
    }

    .qty-unit {
      font-size: 22rpx;
      color: #999;
      margin-left: 4rpx;
    }

    .warning-tag {
      display: block;
      font-size: 20rpx;
      color: #e74c3c;
      margin-top: 4rpx;
    }
  }
}

.empty {
  text-align: center;
  padding: 80rpx 0;

  .empty-icon {
    font-size: 80rpx;
    display: block;
    margin-bottom: 20rpx;
  }

  .empty-text {
    font-size: 26rpx;
    color: #999;
  }
}

.load-more {
  text-align: center;
  padding: 30rpx 0;
  font-size: 24rpx;
  color: #999;
}
</style>
