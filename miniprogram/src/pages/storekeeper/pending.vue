<template>
  <view class="container">
    <!-- 筛选：按当前环节分，仓管一眼看到自己该干什么 -->
    <view class="filter-bar">
      <text
        v-for="tab in tabs"
        :key="tab.value"
        class="filter-tab"
        :class="{ active: currentTab === tab.value }"
        @click="switchTab(tab.value)"
      >{{ tab.label }}<text v-if="tab.count" class="tab-count">{{ tab.count }}</text></text>
    </view>

    <!-- 单据列表 -->
    <scroll-view
      class="order-list"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
      @scrolltolower="onLoadMore"
    >
      <view
        v-for="item in displayList"
        :key="`${item.order_type}-${item._id}`"
        class="order-card"
        :class="{ 'out-card': item.order_type === 'out', 'in-card': item.order_type === 'in' }"
        @click="showDetail(item)"
      >
        <view class="order-header">
          <text class="order-no">{{ item.order_no }}</text>
          <view class="order-tags">
            <text class="order-status" :class="item.status">{{ statusText(item.status) }}</text>
            <text class="order-type" :class="item.order_type === 'out' ? (item.type || 'lingyong') : 'in'">
              {{ item.order_type === 'out' ? typeText(item.type) : '入库' }}
            </text>
          </view>
        </view>

        <view class="order-body">
          <text class="material-name">{{ item.material_names || '无明细' }} 等 {{ item.item_count }} 项</text>
          <text class="order-detail">
            {{ item.operator_name }} 提交 | {{ formatDate(item.created_at) }}
          </text>
        </view>

        <view class="order-footer">
          <text class="operator">仓库: {{ item.warehouse_name || '—' }}</text>
          <view class="action-btns">
            <text class="btn-look" @click.stop="showDetail(item)">看明细</text>

            <!-- 待确认：确认 → 进入待拣货 -->
            <text
              v-if="item.status === 'pending'"
              class="btn-confirm"
              @click.stop="confirmOrder(item)"
            >确认</text>

            <!-- 待拣货：拣完货通知发起人来收（领料单=领料员，成品仓出库=厂长/成品仓管） -->
            <text
              v-if="item.order_type === 'out' && item.status === 'picking'"
              class="btn-pick"
              @click.stop="pickDone(item)"
            >拣货完成</text>

            <!-- 待收货：领料员还没来收，仓管可代确认 -->
            <text
              v-if="item.order_type === 'out' && item.status === 'receiving'"
              class="btn-receive"
              @click.stop="receiveOrder(item)"
            >代确认收货</text>

            <text
              v-if="item.order_type === 'out' && ['pending', 'picking', 'receiving'].includes(item.status)"
              class="btn-cancel"
              @click.stop="rejectOrder(item)"
            >驳回</text>
          </view>
        </view>
      </view>

      <view v-if="displayList.length === 0" class="empty">
        <text class="empty-icon">✅</text>
        <text class="empty-text">{{ emptyText }}</text>
      </view>

      <view v-if="displayList.length" class="load-more">
        <text v-if="loadingMore">加载中...</text>
        <text v-else-if="allNoMore">已经到底了</text>
        <text v-else>上拉加载更多</text>
      </view>
    </scroll-view>

    <!-- 明细 + 当前库存（操作前先看清楚，不用跑去货架数） -->
    <view v-if="detailVisible" class="mask" @click="detailVisible = false">
      <view class="sheet" @click.stop="noop">
        <view class="sheet-title">{{ detailOrder.order_no || '单据明细' }}</view>
        <text class="sheet-sub">
          {{ detailOrder.order_type === 'out' ? typeText(detailOrder.type) : '入库' }} ·
          {{ statusText(detailOrder.status) }} · {{ detailOrder.operator_name }} 提交
        </text>

        <!-- 备注/原因：报废单必有 -->
        <view v-if="detailOrder.remark" class="sheet-remark">
          {{ detailOrder.order_type === 'out' && detailOrder.type === 'baofei' ? '报废原因' : '备注' }}：{{ detailOrder.remark }}
        </view>
        <!-- 报废现场照片 -->
        <view v-if="detailOrder.attachment" class="sheet-photo-box" @click="previewPhoto">
          <image class="sheet-photo" :src="fullFileUrl(detailOrder.attachment)" mode="aspectFit" />
          <text class="sheet-photo-tip">现场照片 · 点击放大</text>
        </view>

        <scroll-view class="detail-list" scroll-y>
          <view
            v-for="(it, idx) in detailOrder.items || []"
            :key="idx"
            class="detail-item"
          >
            <view class="detail-main">
              <text class="detail-name">{{ it.material_name }}</text>
              <text class="detail-sub">{{ it.material_spec || '无规格' }}{{ it.unit ? ' · ' + it.unit : '' }}</text>
            </view>
            <view class="detail-nums">
              <text class="detail-qty">本次 {{ it.quantity }}</text>
              <text
                v-if="it.current_stock !== undefined && it.current_stock !== null"
                class="detail-stock"
                :class="{ danger: it.stock_enough === false }"
              >
                现存 {{ it.current_stock }}
              </text>
            </view>
            <text v-if="it.stock_enough === false" class="detail-warn">库存不足</text>
          </view>
          <view v-if="detailLoading" class="detail-empty">加载中...</view>
          <view v-else-if="!(detailOrder.items || []).length" class="detail-empty">没有明细</view>
        </scroll-view>

        <view class="detail-tip">{{ detailTip }}</view>

        <view class="sheet-btns">
          <text class="sheet-btn ghost" @click="detailVisible = false">关闭</text>
          <text
            v-if="detailOrder.status === 'pending'"
            class="sheet-btn"
            @click="detailVisible = false; confirmOrder(detailOrder)"
          >确认这张单</text>
          <text
            v-else-if="detailOrder.order_type === 'out' && detailOrder.status === 'picking'"
            class="sheet-btn"
            @click="detailVisible = false; pickDone(detailOrder)"
          >拣货完成</text>
          <text
            v-else-if="detailOrder.order_type === 'out' && detailOrder.status === 'receiving'"
            class="sheet-btn"
            @click="detailVisible = false; receiveOrder(detailOrder)"
          >代确认收货</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { outboundApi, inboundApi, statusText, typeText } from '@/utils/api'
import { fullFileUrl } from '@/utils/cloud'

const currentTab = ref('all')

const allOrders = ref([])
const displayList = ref([])
const refreshing = ref(false)

/* ---------- 分页：每类待办单据各自独立，互不影响 ---------- */
const PAGE_SIZE = 50
// 每类当前已请求到第几页 / 是否已取完
const pages = ref({ pending: 1, picking: 1, receiving: 1, inbound: 1 })
const noMore = ref({ pending: false, picking: false, receiving: false, inbound: false })
const loadingMore = ref(false)
// 每类已加载的单据（decorate 后）
const catList = ref({ pending: [], picking: [], receiving: [], inbound: [] })
const CATS = ['pending', 'picking', 'receiving', 'inbound']

const counts = ref({ pending: 0, picking: 0, receiving: 0, inPending: 0 })

const tabs = computed(() => [
  { label: '全部', value: 'all', count: allOrders.value.length },
  { label: '待确认', value: 'pending', count: counts.value.pending + counts.value.inPending },
  { label: '待拣货', value: 'picking', count: counts.value.picking },
  { label: '待收货', value: 'receiving', count: counts.value.receiving }
])

const emptyText = computed(() => {
  const map = {
    all: '当前没有待办单据',
    pending: '没有待确认的单据',
    picking: '没有待拣货的单据',
    receiving: '没有等待收货的单据'
  }
  return map[currentTab.value] || '没有待办单据'
})

/* ---------- 明细弹层 ---------- */
const detailVisible = ref(false)
const detailLoading = ref(false)
const detailOrder = ref({})

function noop() {}

function previewPhoto() {
  if (detailOrder.value.attachment) {
    uni.previewImage({ urls: [fullFileUrl(detailOrder.value.attachment)] })
  }
}

/** 明细弹窗底部说明：按单据类型说对应的话（报废单不讲「收货」那套） */
const detailTip = computed(() => {
  const o = detailOrder.value
  if (o.order_type === 'out' && o.type === 'baofei') {
    return '报废单：确认后立刻出库，库存当场扣减，单据办结。照片和报废原因是凭证，请核对后再确认。'
  }
  if (o.order_type === 'out') {
    // ⚠️ 别写死「领料员」：成品仓出库（销售）由厂长或成品仓管发起，流程里根本没有领料员。
    //    后端 notifyOperator(order.operator_openid) 通知的永远是「发起人」——
    //    领料单的发起人是领料员，成品仓出库的发起人是厂长/成品仓管。用「发起人」对所有类型都成立。
    return '出库单：确认后进入「待拣货」，拣完货系统会通知发起人来收；库存要等发起人确认收货时才扣减。'
  }
  return '入库单：确认只是让单据生效（入库时已加库存）。'
})

async function showDetail(item) {
  detailOrder.value = { ...item, items: item.items || [] }
  detailVisible.value = true
  detailLoading.value = true
  try {
    const api = item.order_type === 'out' ? outboundApi : inboundApi
    const res = await api.detail({ id: item._id })
    detailOrder.value = { ...item, ...res, order_type: item.order_type }
  } catch (err) {
    uni.showToast({ title: err.message || '明细加载失败', icon: 'none' })
  } finally {
    detailLoading.value = false
  }
}

function formatDate(d) {
  if (!d) return ''
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
}

function decorate(order, orderType) {
  const items = order.items || []
  return {
    ...order,
    order_type: orderType,
    item_count: items.length,
    material_names: items.map((it) => it.material_name).filter(Boolean).join('、')
  }
}

function switchTab(v) {
  currentTab.value = v
  filterList()
}

function filterList() {
  const v = currentTab.value
  let list = allOrders.value
  if (v === 'pending') list = list.filter((o) => o.status === 'pending')
  else if (v === 'picking') list = list.filter((o) => o.status === 'picking')
  else if (v === 'receiving') list = list.filter((o) => o.status === 'receiving')
  displayList.value = list
}

/** 按类别取一页（inbound 走入库接口，其余走出库接口） */
function fetchCat(cat) {
  const params = {
    status: cat === 'inbound' ? 'pending' : cat,
    page: pages.value[cat],
    pageSize: PAGE_SIZE
  }
  return cat === 'inbound' ? inboundApi.list(params) : outboundApi.list(params)
}

/** 按类别把接口原始数据装饰成列表项 */
function decorateCat(cat, list) {
  const orderType = cat === 'inbound' ? 'in' : 'out'
  return (list || []).map((o) => decorate(o, orderType))
}

/** 把各分类已加载的数据合成 allOrders（保持原排序），再交给 filterList 显示 */
function rebuildAllOrders() {
  const c = catList.value
  allOrders.value = [
    ...c.pending,
    ...c.picking,
    ...c.receiving,
    ...c.inbound
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  filterList()
}

// 每一类都取完 = 全部到底了（底部提示用）
const allNoMore = computed(() => CATS.every((c) => noMore.value[c]))

/**
 * 待办数据：领料单三个环节都可能要仓管动手，入库单只有待确认
 * 逐个接口用 catch 兜底，某个环节查不到不影响其他环节显示
 * ⚠️ 下拉刷新路径：页码归 1、列表整体替换（不追加）
 */
async function loadData() {
  const safe = (p) => p.catch(() => ({ list: [] }))
  pages.value = { pending: 1, picking: 1, receiving: 1, inbound: 1 }
  noMore.value = { pending: false, picking: false, receiving: false, inbound: false }
  try {
    const results = await Promise.all(CATS.map((cat) => safe(fetchCat(cat))))
    const next = { pending: [], picking: [], receiving: [], inbound: [] }
    CATS.forEach((cat, i) => {
      const list = results[i].list || []
      next[cat] = decorateCat(cat, list)
      noMore.value[cat] = list.length < PAGE_SIZE
    })
    catList.value = next

    counts.value = {
      pending: next.pending.length,
      picking: next.picking.length,
      receiving: next.receiving.length,
      inPending: next.inbound.length
    }

    rebuildAllOrders()
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    refreshing.value = false
  }
}

/** 上拉加载更多：对「还没取完」的每一类各取下一页并追加 */
async function onLoadMore() {
  const pendingCats = CATS.filter((cat) => !noMore.value[cat])
  if (!pendingCats.length || loadingMore.value) return
  loadingMore.value = true
  const results = await Promise.all(pendingCats.map((cat) => {
    pages.value[cat] += 1
    return fetchCat(cat).then(
      (res) => ({ cat, list: res.list || [] }),
      (error) => ({ cat, error })
    )
  }))
  let failed = false
  results.forEach(({ cat, list, error }) => {
    if (error) {
      // 失败回退页码，保证还能重试；noMore 保持不变
      failed = true
      pages.value[cat] -= 1
      return
    }
    catList.value[cat] = [...catList.value[cat], ...decorateCat(cat, list)]
    if (list.length < PAGE_SIZE) noMore.value[cat] = true
  })
  rebuildAllOrders()
  if (failed) uni.showToast({ title: '加载更多失败', icon: 'none' })
  loadingMore.value = false
}

/** 确认单据：领料单 → 待拣货；入库单 → 已确认 */
function confirmOrder(item) {
  const isOut = item.order_type === 'out'
  const isScrap = isOut && item.type === 'baofei'
  uni.showModal({
    title: isScrap ? '确认报废' : '确认单据',
    content: isScrap
      ? `确认 ${item.order_no} 报废吗？\n确认后立刻出库：库存当场扣减，单据办结。照片和原因请先看明细核对。`
      : isOut
        ? `确认 ${item.order_no} 吗？\n确认后进入「待拣货」，请按清单备货；拣完点「拣货完成」通知发起人来收。\n库存要等发起人确认收货时才扣减。`
        : `确认 ${item.order_no} 吗？\n入库单在提交时已经加了库存，确认只是让单据生效。`,
    confirmText: '确认',
    cancelText: '再想想',
    confirmColor: isScrap ? '#c0392b' : '#007aff',
    success: async (res) => {
      if (!res.confirm) return
      try {
        if (isOut) await outboundApi.confirm({ id: item._id })
        else await inboundApi.confirm({ id: item._id })
        uni.showToast({ title: isScrap ? '已报废出库' : isOut ? '已确认，请拣货' : '已确认', icon: 'success' })
        loadData()
      } catch (err) {
        uni.showToast({ title: err.message || '确认失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

/** 拣货完成：进入待收货并通知发起人（领料单是领料员，成品仓出库是厂长/成品仓管） */
function pickDone(item) {
  uni.showModal({
    title: '拣货完成',
    content: `确认 ${item.order_no} 已备好货？\n确认后系统会发消息通知发起人来收货。`,
    confirmText: '已备好',   // wx.showModal 硬限制：按钮文案不能超过 4 个汉字，超了弹窗直接不弹
    cancelText: '还没好',
    success: async (res) => {
      if (!res.confirm) return
      try {
        await outboundApi.pickDone({ id: item._id })
        uni.showToast({ title: '已通知发起人来收货', icon: 'success' })
        loadData()
      } catch (err) {
        uni.showToast({ title: err.message || '操作失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

/** 代领料员确认收货（库存此刻扣减） */
function receiveOrder(item) {
  uni.showModal({
    title: '代确认收货',
    content: `确认 ${item.order_no} 的物料已被领走？\n确认后系统会立即扣减库存，单据完成。`,
    confirmText: '确认收货',
    cancelText: '取消',
    success: async (res) => {
      if (!res.confirm) return
      try {
        await outboundApi.receive({ id: item._id })
        uni.showToast({ title: '已确认收货，库存已扣减', icon: 'success' })
        loadData()
      } catch (err) {
        uni.showToast({ title: err.message || '操作失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

/** 驳回（待确认 / 待拣货 / 待收货都能驳回，退回领料员） */
function rejectOrder(item) {
  uni.showModal({
    title: '驳回单据',
    editable: true,
    placeholderText: '必须写明驳回原因，提交人能收到',
    confirmText: '驳回',
    cancelText: '取消',
    confirmColor: '#e74c3c',
    success: async (res) => {
      if (!res.confirm) return
      const reason = String(res.content || '').trim()
      if (!reason) {
        uni.showToast({ title: '请写明驳回原因', icon: 'none' })
        return
      }
      try {
        const r = await outboundApi.reject({ id: item._id, reason })
        uni.showToast({ title: '已驳回，已通知提交人', icon: 'success' })
        loadData()
      } catch (err) {
        uni.showToast({ title: err.message || '驳回失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

function onRefresh() {
  loadData()
}

// 首次进入即加载（onMounted 兜底）；之后每次页面重新显示（含从子页返回）都刷新
const __pageShowHandler = () => {
  loadData()
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
  background: #fff;
  padding: 20rpx;
  gap: 16rpx;
  border-bottom: 1rpx solid #f0f0f0;

  .filter-tab {
    padding: 12rpx 20rpx;
    font-size: 26rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 30rpx;

    &.active {
      background: #6b5b95;
      color: #fff;
    }

    .tab-count {
      font-size: 22rpx;
      margin-left: 6rpx;
    }
  }
}

.order-list {
  padding: 20rpx;
  height: calc(100vh - 100rpx);
}

.order-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
  border-left: 6rpx solid transparent;

  &.out-card {
    border-left-color: #e74c3c;
  }

  &.in-card {
    border-left-color: #27ae60;
  }

  .order-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16rpx;

    .order-no {
      font-size: 28rpx;
      font-weight: bold;
      color: #333;
    }

    .order-tags {
      display: flex;
      align-items: center;
      gap: 10rpx;

      .order-status {
        font-size: 20rpx;
        padding: 4rpx 12rpx;
        border-radius: 6rpx;

        &.pending {
          background: #fff3cd;
          color: #856404;
        }

        &.picking {
          background: #efeaf7;
          color: #5b4b8a;
        }

        &.receiving {
          background: #d1ecf1;
          color: #0c5460;
        }
      }

      .order-type {
        font-size: 20rpx;
        padding: 4rpx 12rpx;
        border-radius: 6rpx;
        color: #fff;

        &.out, &.lingyong {
          background: #e74c3c;
        }

        &.baofei {
          background: #7b241c;
        }

        &.in {
          background: #27ae60;
        }
      }
    }
  }

  .order-body {
    margin-bottom: 16rpx;

    .material-name {
      font-size: 28rpx;
      color: #333;
      display: block;
    }

    .order-detail {
      font-size: 22rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }
  }

  .order-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .operator {
      font-size: 22rpx;
      color: #999;
    }

    .action-btns {
      display: flex;
      gap: 12rpx;

      .btn-look {
        font-size: 24rpx;
        color: #6b5b95;
        background: #efeaf7;
        padding: 8rpx 18rpx;
        border-radius: 8rpx;
      }

      .btn-confirm {
        font-size: 24rpx;
        color: #fff;
        background: #27ae60;
        padding: 8rpx 20rpx;
        border-radius: 8rpx;
      }

      .btn-pick {
        font-size: 24rpx;
        color: #fff;
        background: #6b5b95;
        padding: 8rpx 20rpx;
        border-radius: 8rpx;
      }

      .btn-receive {
        font-size: 24rpx;
        color: #fff;
        background: #0c7ea8;
        padding: 8rpx 20rpx;
        border-radius: 8rpx;
      }

      .btn-cancel {
        font-size: 24rpx;
        color: #fff;
        background: #e74c3c;
        padding: 8rpx 20rpx;
        border-radius: 8rpx;
      }
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

  .sheet-remark {
    font-size: 26rpx;
    color: #333;
    background: #fff8e6;
    border-radius: 10rpx;
    padding: 16rpx 20rpx;
    margin-bottom: 16rpx;
    line-height: 1.5;
  }

  .sheet-photo-box {
    margin-bottom: 16rpx;
    text-align: center;

    .sheet-photo {
      width: 100%;
      height: 300rpx;
      border-radius: 12rpx;
      background: #f5f5f5;
    }

    .sheet-photo-tip {
      display: block;
      font-size: 22rpx;
      color: #999;
      margin-top: 8rpx;
    }
  }

  .detail-list {
    flex: 1;
    max-height: 46vh;

    .detail-item {
      padding: 20rpx 0;
      border-bottom: 1rpx solid #f5f5f5;

      .detail-main {
        .detail-name {
          font-size: 28rpx;
          color: #333;
          display: block;
        }

        .detail-sub {
          font-size: 22rpx;
          color: #999;
          margin-top: 4rpx;
          display: block;
        }
      }

      .detail-nums {
        display: flex;
        align-items: center;
        gap: 24rpx;
        margin-top: 10rpx;

        .detail-qty {
          font-size: 26rpx;
          color: #333;
        }

        .detail-stock {
          font-size: 26rpx;
          color: #27ae60;

          &.danger {
            color: #e74c3c;
            font-weight: bold;
          }
        }
      }

      .detail-warn {
        display: block;
        font-size: 22rpx;
        color: #e74c3c;
        margin-top: 6rpx;
      }
    }

    .detail-empty {
      text-align: center;
      padding: 60rpx;
      color: #999;
      font-size: 26rpx;
    }
  }

  .detail-tip {
    margin-top: 20rpx;
    padding: 18rpx;
    background: #fdf6e3;
    border-radius: 12rpx;
    font-size: 22rpx;
    color: #8a6a10;
    line-height: 1.6;

    .tip-strong {
      font-weight: bold;
      color: #a0760a;
    }
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
      background: #27ae60;
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
