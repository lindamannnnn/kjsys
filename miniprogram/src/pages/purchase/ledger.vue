<template>
  <view class="container">
    <!-- 筛选 -->
    <view class="filter">
      <view class="search-row">
        <text class="search-icon">🔍</text>
        <input
          v-model="keyword"
          class="input"
          placeholder="按物料名称搜索（可不填，看全部）"
          placeholder-class="ph"
          @input="onKeyword"
        />
        <text v-if="pickedMaterial" class="clear" @click="clearMaterial">✕</text>
      </view>

      <view v-if="suggestions.length" class="suggestions">
        <view
          v-for="m in suggestions"
          :key="m._id"
          class="suggestion"
          @click="pickMaterial(m)"
        >
          <text class="sug-name">{{ m.name }}</text>
          <text class="sug-spec">{{ m.spec || '无规格' }} · 现存 {{ m.current_stock }}</text>
        </view>
      </view>

      <view class="date-row">
        <picker mode="date" :value="startDate" @change="onStartChange">
          <text class="date-btn" :class="{ empty: !startDate }">{{ startDate || '开始日期' }}</text>
        </picker>
        <text class="date-sep">至</text>
        <picker mode="date" :value="endDate" @change="onEndChange">
          <text class="date-btn" :class="{ empty: !endDate }">{{ endDate || '结束日期' }}</text>
        </picker>
        <text class="reset" @click="resetFilter">重置</text>
      </view>
    </view>

    <!-- 汇总 -->
    <view class="summary">
      <text class="sum-item">共 {{ total }} 笔</text>
      <text class="sum-item">
        净变动
        <text class="sum-net" :class="net >= 0 ? 'up' : 'down'">
          {{ net > 0 ? '+' : '' }}{{ net }}
        </text>
      </text>
    </view>

    <!-- 流水列表 -->
    <scroll-view
      class="list"
      scroll-y
      @scrolltolower="loadMore"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view v-for="(it, idx) in list" :key="idx" class="item">
        <view class="item-head">
          <text class="item-name">{{ it.material_name }}</text>
          <text class="item-qty" :class="Number(it.change_quantity) >= 0 ? 'up' : 'down'">
            {{ Number(it.change_quantity) > 0 ? '+' : '' }}{{ it.change_quantity }}
          </text>
        </view>
        <view class="item-body">
          <text class="item-type">{{ it.change_type_text || changeTypeText(it.change_type) }}</text>
          <text v-if="it.warehouse_name" class="item-warehouse">{{ it.warehouse_name }}</text>
        </view>
        <view class="item-foot">
          <text class="item-no">{{ it.order_no || '—' }}</text>
          <text class="item-time">{{ formatDate(it.created_at, 'MM-DD HH:mm') }}</text>
        </view>
        <text v-if="it.operator_name" class="item-op">经手人：{{ it.operator_name }}</text>
      </view>

      <view v-if="loading" class="tip">加载中...</view>
      <view v-else-if="noMore && list.length" class="tip">没有更多了</view>
      <view v-else-if="!list.length" class="empty">
        <text class="empty-icon">📄</text>
        <text class="empty-text">这段时间没有库存流水</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { statsApi, materialApi, changeTypeText } from '@/utils/api'
import { formatDate } from '@/utils/format'

const keyword = ref('')
const suggestions = ref([])
const pickedMaterial = ref(null)
const startDate = ref('')
const endDate = ref('')

const list = ref([])
const total = ref(0)
const net = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const noMore = ref(false)
const refreshing = ref(false)

let searchTimer = null

/** 物料搜索（输入防抖，避免每敲一个字就打一次接口） */
function onKeyword() {
  if (searchTimer) clearTimeout(searchTimer)
  const kw = keyword.value.trim()
  if (!kw) {
    suggestions.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    try {
      const res = await materialApi.list({ keyword: kw, page: 1, pageSize: 8 })
      suggestions.value = res.list || []
    } catch (err) {
      suggestions.value = []
    }
  }, 300)
}

function pickMaterial(m) {
  pickedMaterial.value = m
  keyword.value = m.name
  suggestions.value = []
  reload()
}

function clearMaterial() {
  pickedMaterial.value = null
  keyword.value = ''
  suggestions.value = []
  reload()
}

function onStartChange(e) {
  startDate.value = e.detail.value
  reload()
}

function onEndChange(e) {
  endDate.value = e.detail.value
  reload()
}

function resetFilter() {
  pickedMaterial.value = null
  keyword.value = ''
  suggestions.value = []
  startDate.value = ''
  endDate.value = ''
  reload()
}

async function load(reset = false) {
  if (loading.value) return
  if (reset) {
    page.value = 1
    noMore.value = false
  }
  if (noMore.value) return

  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    if (pickedMaterial.value) params.material_id = pickedMaterial.value._id
    if (startDate.value && endDate.value) {
      params.startDate = startDate.value
      params.endDate = endDate.value
    }

    const res = await statsApi.stockFlow(params)
    const rows = res.list || []
    list.value = reset ? rows : [...list.value, ...rows]
    total.value = res.total || 0
    net.value = Number(res.net_quantity || 0)
    noMore.value = rows.length < pageSize.value || list.value.length >= total.value
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function reload() {
  load(true)
}

function loadMore() {
  if (noMore.value) return
  page.value++
  load()
}

function onRefresh() {
  load(true)
}

onMounted(() => {
  load(true)
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
}

.filter {
  background: #fff;
  padding: 20rpx;

  .search-row {
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

    .ph {
      color: #999;
    }

    .clear {
      font-size: 28rpx;
      color: #999;
      padding: 0 8rpx;
    }
  }

  .suggestions {
    margin-top: 12rpx;
    background: #fff;
    border: 1rpx solid #eee;
    border-radius: 12rpx;
    overflow: hidden;

    .suggestion {
      padding: 20rpx;
      border-bottom: 1rpx solid #f5f5f5;

      &:last-child {
        border-bottom: none;
      }

      .sug-name {
        font-size: 28rpx;
        color: #333;
        display: block;
      }

      .sug-spec {
        font-size: 22rpx;
        color: #999;
        margin-top: 4rpx;
        display: block;
      }
    }
  }

  .date-row {
    display: flex;
    align-items: center;
    gap: 16rpx;
    margin-top: 20rpx;

    .date-btn {
      font-size: 26rpx;
      color: #333;
      background: #f5f5f5;
      padding: 12rpx 24rpx;
      border-radius: 8rpx;

      &.empty {
        color: #999;
      }
    }

    .date-sep {
      font-size: 24rpx;
      color: #999;
    }

    .reset {
      margin-left: auto;
      font-size: 26rpx;
      color: #0B4F95;
    }
  }
}

.summary {
  display: flex;
  justify-content: space-between;
  padding: 20rpx 30rpx;
  background: #eef3f9;

  .sum-item {
    font-size: 26rpx;
    color: #555;
  }

  .sum-net {
    font-weight: bold;

    &.up {
      color: #c0392b;
    }

    &.down {
      color: #0F7A3D;
    }
  }
}

.list {
  height: calc(100vh - 320rpx);
  padding: 20rpx;
}

.item {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.05);

  .item-head {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .item-name {
      flex: 1;
      font-size: 28rpx;
      color: #333;
      font-weight: 500;
    }

    .item-qty {
      font-size: 30rpx;
      font-weight: bold;
      margin-left: 16rpx;

      &.up {
        color: #c0392b;
      }

      &.down {
        color: #0F7A3D;
      }
    }
  }

  .item-body {
    display: flex;
    gap: 16rpx;
    margin-top: 10rpx;

    .item-type {
      font-size: 22rpx;
      color: #0B4F95;
      background: #eaf1fa;
      padding: 4rpx 12rpx;
      border-radius: 6rpx;
    }

    .item-warehouse {
      font-size: 22rpx;
      color: #999;
      line-height: 1.8;
    }
  }

  .item-foot {
    display: flex;
    justify-content: space-between;
    margin-top: 12rpx;

    .item-no {
      font-size: 22rpx;
      color: #666;
    }

    .item-time {
      font-size: 22rpx;
      color: #999;
    }
  }

  .item-op {
    display: block;
    font-size: 22rpx;
    color: #999;
    margin-top: 6rpx;
  }
}

.tip {
  text-align: center;
  padding: 30rpx;
  color: #999;
  font-size: 24rpx;
}

.empty {
  text-align: center;
  padding: 120rpx 40rpx;

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
</style>
