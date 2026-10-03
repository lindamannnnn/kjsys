<template>
  <view class="container">
    <!-- 筛选与批量操作 -->
    <view class="filter-bar">
      <view class="tabs">
        <text
          class="filter-tab"
          :class="{ active: !onlyUnread }"
          @click="switchTab(false)"
        >全部</text>
        <text
          class="filter-tab"
          :class="{ active: onlyUnread }"
          @click="switchTab(true)"
        >未读{{ unread ? ' (' + unread + ')' : '' }}</text>
      </view>
      <text v-if="unread > 0" class="read-all" @click="handleReadAll">全部已读</text>
    </view>

    <scroll-view
      class="msg-list"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in list"
        :key="item._id"
        class="msg-card"
        :class="{ unread: !item.is_read }"
        @click="openMessage(item)"
      >
        <view class="msg-head">
          <text class="msg-title">{{ item.title }}</text>
          <text class="msg-time">{{ formatTime(item.created_at) }}</text>
        </view>

        <text v-if="item.content" class="msg-content">{{ item.content }}</text>

        <view v-if="item.ref_no" class="msg-ref">
          <text class="ref-no">单号 {{ item.ref_no }}</text>
          <text class="ref-go">查看 ›</text>
        </view>

        <view v-if="!item.is_read" class="unread-dot"></view>
      </view>

      <view v-if="loading" class="empty">
        <text class="empty-text">加载中...</text>
      </view>
      <view v-else-if="list.length === 0" class="empty">
        <text class="empty-icon">🔔</text>
        <text class="empty-text">{{ onlyUnread ? '没有未读消息' : '暂无消息' }}</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { messageApi } from '@/utils/api'

const list = ref([])
const unread = ref(0)
const loading = ref(true)
const refreshing = ref(false)
const onlyUnread = ref(false)

/** 相对时间：刚发生的说「刚刚 / x 分钟前」，今天说「今天 hh:mm」，更早说「m/d hh:mm」 */
function formatTime(d) {
  if (!d) return ''
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff >= 0 && diff < 60 * 1000) return '刚刚'
  if (diff >= 0 && diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`

  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`
  return `${date.getMonth() + 1}/${date.getDate()} ${hm}`
}

async function loadList() {
  try {
    const res = await messageApi.list({ only_unread: onlyUnread.value, page: 1, pageSize: 50 })
    list.value = res.list || []
    unread.value = res.unread || 0
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function switchTab(next) {
  if (onlyUnread.value === next) return
  onlyUnread.value = next
  loading.value = true
  loadList()
}

/** 点击消息：先本地置已读让界面立刻响应，再按关联单据跳转 */
function openMessage(item) {
  if (!item.is_read) {
    item.is_read = 1
    unread.value = Math.max(0, unread.value - 1)
    // 标记失败不打断跳转（用户主要目的是看单据）
    messageApi.markRead({ _id: item._id }).catch(() => {})
  }

  if (item.ref_type === 'outbound' && item.ref_id) {
    uni.navigateTo({ url: `/pages/out/detail?id=${item.ref_id}` })
  } else if (item.ref_type === 'inbound' && item.ref_id) {
    uni.navigateTo({ url: `/pages/in/detail?id=${item.ref_id}` })
  }
}

function handleReadAll() {
  uni.showModal({
    title: '全部已读',
    content: '把所有未读消息标记为已读？',
    success: async (res) => {
      if (!res.confirm) return
      try {
        await messageApi.markAllRead()
        list.value = list.value.map((m) => ({ ...m, is_read: 1 }))
        unread.value = 0
        uni.showToast({ title: '已全部标记已读', icon: 'success' })
      } catch (err) {
        uni.showToast({ title: err.message || '操作失败', icon: 'none' })
      }
    }
  })
}

function onRefresh() {
  refreshing.value = true
  loadList()
}

// 首次进入即加载（onMounted 兜底）；之后每次页面重新显示（含从单据详情返回）都刷新
const __pageShowHandler = () => {
  loadList()
}
onMounted(() => {
  __pageShowHandler()
  onShow(__pageShowHandler)
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
}

.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  padding: 20rpx;
  border-bottom: 1rpx solid #f0f0f0;

  .tabs {
    display: flex;
    gap: 20rpx;
  }

  .filter-tab {
    padding: 12rpx 24rpx;
    font-size: 26rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 30rpx;

    &.active {
      background: #1a1a2e;
      color: #fff;
    }
  }

  .read-all {
    font-size: 24rpx;
    color: #6b5b95;
    padding: 8rpx 16rpx;
  }
}

.msg-list {
  padding: 20rpx;
  height: calc(100vh - 100rpx);
}

.msg-card {
  position: relative;
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
  border-left: 6rpx solid transparent;

  // 未读：左侧竖条 + 白底高亮；已读：弱化
  &.unread {
    border-left-color: #e74c3c;
    background: #fffdfd;
  }

  .msg-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16rpx;

    .msg-title {
      flex: 1;
      font-size: 28rpx;
      font-weight: bold;
      color: #333;
    }

    .msg-time {
      font-size: 22rpx;
      color: #999;
      flex-shrink: 0;
    }
  }

  .msg-content {
    display: block;
    font-size: 25rpx;
    color: #666;
    margin-top: 12rpx;
    line-height: 1.6;
  }

  .msg-ref {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16rpx;
    padding-top: 14rpx;
    border-top: 1rpx solid #f5f5f5;

    .ref-no {
      font-size: 22rpx;
      color: #999;
    }

    .ref-go {
      font-size: 22rpx;
      color: #6b5b95;
    }
  }

  .unread-dot {
    position: absolute;
    top: 24rpx;
    right: 24rpx;
    width: 14rpx;
    height: 14rpx;
    border-radius: 50%;
    background: #e74c3c;
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
</style>
