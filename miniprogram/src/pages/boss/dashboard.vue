<template>
  <view class="container">
    <!-- 身份标识（2026-10-09 加）：
         老板与厂长**共用这一页**，但能做的事完全不同（厂长多一个「成品仓出库」，
         老板是纯只读）。原来页面头部只写「数据看板」，两人进来一模一样，
         厂长会以为是「功能少了」；仓管页的头部本来就叫「仓管工作台」，这里与之对齐。
         ⚠️ 改文案时注意：验收脚本 server/tests/role-agent/ui-check.js 会断言
            「以某身份进入首页时页面出现该身份字样」，别把身份词删掉。 -->
    <view v-if="identityLabel" class="page-identity">
      <text class="pi-text">{{ identityLabel }}</text>
    </view>

    <!-- 日期切换：真实取数（2026-10-09 修 —— 原先只改本地变量，数字纹丝不动） -->
    <view class="date-tabs">
      <view
        v-for="tab in dateTabs"
        :key="tab.value"
        class="tab-item"
        :class="{ active: currentTab === tab.value }"
        @click="onTabChange(tab.value)"
      >
        {{ tab.label }}
      </view>
    </view>

    <!-- KPI 卡片 -->
    <view class="kpi-grid">
      <view class="kpi-card" v-for="kpi in kpiList" :key="kpi.label">
        <text class="kpi-value" :style="{ color: kpi.color }">{{ kpi.value }}</text>
        <text class="kpi-label">{{ kpi.label }}</text>
      </view>
    </view>

    <!-- KPI 口径说明（2026-10-09 加）：原先「库存总量」没写单位，老板不知道是件还是项，
         而各物料单位本来就不同（个/台/米），相加后只能看规模，不能当绝对数 -->
    <view class="kpi-hint">
      「库存总量」为各物料数量直接相加（各料单位不同，仅看规模趋势）；「预警物料」为已低于预警线的品类数
    </view>

    <!-- 快捷入口：按权限给，避免出现「点了才报 403」的入口 -->
    <!--   老板（2026-10-09 用户要求只读）：只看看板 + 库存流水 —— 趋势分析/库存台账/
           单据流水/库存预警 的权限已收回，这里也不再给入口
         厂长：有 库存台账/单据流水/库存预警 权限（stats.stockList/orderFlow/warning 放行 director） -->
    <view
      class="quick-actions"
      :style="{ gridTemplateColumns: 'repeat(' + actionCount + ', 1fr)' }"
    >
      <view
        v-for="act in quickActions"
        :key="act.url"
        class="action-item"
        @click="goPage(act.url)"
      >
        <text class="action-icon">{{ act.icon }}</text>
        <text class="action-text">{{ act.text }}</text>
      </view>
    </view>

    <!-- 仓库总值：老板最关心的一个数（按成本口径，不是售价） -->
    <view v-if="warehouseList.length" class="wh-value-card">
      <view class="wh-value-head">
        <text class="wh-value-title">仓库总值</text>
        <text class="wh-value-sum">合计 ¥{{ formatMoney(totalValue) }}</text>
      </view>

      <view v-for="w in warehouseList" :key="w._id || w.id" class="wh-value-row">
        <view class="wh-value-left">
          <text class="wh-name">{{ w.name }}</text>
          <text class="wh-stock">
            库存 {{ w.total_stock || 0 }} · {{ w.material_count || 0 }} 种物料
          </text>
        </view>
        <text class="wh-money">¥{{ formatMoney(w.total_value) }}</text>
      </view>

      <text class="wh-value-tip">
        按「库存数量 × 加权平均成本」计算，反映仓库存货占用的资金
      </text>
      <!-- 待补价（2026-10-20）：没定价的货成本按 0 算，总值会偏低，必须说明 -->
      <text v-if="Number(kpiData.price_pending_items) > 0" class="wh-value-tip pending-tip">
        其中 {{ kpiData.price_pending_items }} 项入库还没定价（待补价），未计入上面的金额，补齐价格后总值会更高
      </text>
    </view>

    <!-- 库存预警提示（没有预警页权限的角色不显示，避免点了 403） -->
    <view v-if="canSeeWarning && warningCount > 0" class="warning-banner" @click="goPage('/pages/boss/warning')">
      <text class="warning-icon">⚠️</text>
      <text class="warning-text">{{ warningCount }} 个物料库存不足，点击查看</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onPageShow as onShow } from '@/utils/on-page-show'
import { statsApi } from '@/utils/api'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

/**
 * 本页身份：老板（只读看数）/ 厂长（看数 + 成品仓出库）/ 管理员（后台误入时的兜底）。
 * ⚠️ 判断顺序不能反：一个账号可能同时挂 boss + director（历史上出现过），
 *    以「最高身份」为准，避免显示成厂长却看不到成品仓出库入口。
 */
const identityLabel = computed(() => {
  if (userStore.hasRole(['boss'])) return '老板'
  if (userStore.hasRole(['director'])) return '厂长'
  if (userStore.hasRole(['admin'])) return '管理员'
  return ''
})

// 快捷入口按权限给（2026-10-09 最终口径）：
//   - 老板（只读）：库存台账 / 单据流水 / 库存预警 / 库存流水 —— 与厂长看到的一致
//     ⚠️ 只是「看」，老板没有任何写/审动作（审核、驳回、作废、入库的后端权限都已收回）
//   - 厂长：同上四项（stats.stockList/orderFlow/warning/stockFlow 均放行 director）
//   - 趋势分析（stats.trend）只放行 admin，小程序端不显示，免得点了报 403
const quickActions = computed(() => {
  const list = []
  if (userStore.hasRole(['boss', 'director'])) {
    list.push(
      { icon: '📦', text: '库存台账', url: '/pages/boss/stock' },
      { icon: '📋', text: '单据流水', url: '/pages/boss/orders' },
      { icon: '⚠️', text: '库存预警', url: '/pages/boss/warning' }
    )
  }
  list.push({ icon: '📒', text: '库存流水', url: '/pages/purchase/ledger' })
  return list
})

// 预警横幅点进去是预警页 → 没这个权限的角色干脆不显示横幅
const canSeeWarning = computed(() => userStore.hasRole(['boss', 'director']))

// 2026-10-10：「成品仓出库」入口已挪到首页（pages/index/index.vue 的角色卡片）。
//   原因：取消自动跳页后首页才是厂长的落点，发起动作不该藏在看板里；
//   后端 assertDirectorWarehouse 不变，「纯 director」仍被限死在成品仓。

// 快捷入口列数跟着实际入口数走（老板只有 1 个入口时不要留 3 个空位）
const actionCount = computed(() => Math.max(quickActions.value.length, 1))

const currentTab = ref('today')
const dateTabs = [
  { label: '今天', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '本月', value: 'month' }
]

/** 当前周期标签（今天/本周/本月）——KPI 名称跟着它变，用户才知道自己在看哪个周期 */
const periodLabel = computed(
  () => (dateTabs.find(t => t.value === currentTab.value) || dateTabs[0]).label
)

const loading = ref(false)

const kpiData = ref({
  period_outbound_orders: 0,
  period_inbound_orders: 0,
  total_stock: 0,
  warning_count: 0
})

const warningCount = computed(() => kpiData.value.warning_count || 0)

/* ---------- 仓库总值（P5）：成品仓 / 配件仓各自的库存总值 ---------- */
const warehouseList = ref([])

const totalValue = computed(() =>
  warehouseList.value.reduce((s, w) => s + Number(w.total_value || 0), 0))

/** 金额格式化：过万用「万」，避免一串数字看不过来 */
function formatMoney(v) {
  const n = Number(v || 0)
  if (!Number.isFinite(n)) return '0'
  if (n >= 100000000) return (n / 100000000).toFixed(2) + ' 亿'
  if (n >= 10000) return (n / 10000).toFixed(2) + ' 万'
  return n.toFixed(2)
}

async function loadWarehouseSummary() {
  try {
    const res = await statsApi.warehouseSummary()
    warehouseList.value = res.list || []
  } catch (err) {
    // 总值拿不到不影响其他看板指标
    warehouseList.value = []
  }
}

const kpiList = computed(() => [
  // 命名统一（P2-1-06）：「单数」二字必须带，否则老板会当成出库数量
  // 2026-10-09：前两项随日期周期变化（今天/本周/本月），标签同步改，避免「本月」下还写「今日」
  { label: `${periodLabel.value}出库单数`, value: kpiData.value.period_outbound_orders || 0, color: '#e74c3c' },
  { label: `${periodLabel.value}入库单数`, value: kpiData.value.period_inbound_orders || 0, color: '#27ae60' },
  // 后两项是「当前快照」而非周期累计，不随日期切换变化
  { label: '库存总量', value: kpiData.value.total_stock || 0, color: '#3498db' },
  { label: '预警物料', value: kpiData.value.warning_count || 0, color: '#f39c12' }
])

function goPage(url) {
  uni.navigateTo({ url })
}

/** 切换周期 → 真实重新取数 */
function onTabChange(value) {
  if (currentTab.value === value) return
  currentTab.value = value
  loadData()
}

async function loadData() {
  loading.value = true
  try {
    // 周期必须传给后端（原先不传，切换日期毫无反应）
    const res = await statsApi.overview({ period: currentTab.value })
    kpiData.value = {
      // 后端在 today 周期下 period_* 与 today_* 数值一致，统一读 period_* 即可
      period_outbound_orders: res.period_outbound_orders || 0,
      period_inbound_orders: res.period_inbound_orders || 0,
      total_stock: res.total_stock || 0,
      warning_count: res.warning_count || 0,
      // 待补价项数（2026-10-20）：成品仓上线初期拿不到价格，
      //   这部分货的成本是 0 → 仓库总值会偏低，必须说清楚，否则老板会以为钱少了
      price_pending_items: res.price_pending_items || 0
    }
    await loadWarehouseSummary()
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}

// 首次进入即加载（onMounted 兜底，防止页面生命周期在某些端不触发导致空白）
// 之后每次页面重新显示时刷新（含从子页面返回），所以点完确认回到工作台红点会同步
const __pageShowHandler = () => {
  loadData()
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
  padding: 20rpx;
}

/* 身份标识：老板／厂长共用本页，用一个小胶囊说清「现在是谁的视角」 */
.page-identity {
  display: flex;
  margin-bottom: 16rpx;
  padding: 0 6rpx;
}

.pi-text {
  font-size: 24rpx;
  color: #8A6A10;
  font-weight: bold;
  background: #FBF3D8;
  border: 1rpx solid #E8D9A0;
  border-radius: 999rpx;
  padding: 6rpx 22rpx;
}

.date-tabs {
  display: flex;
  background: #fff;
  border-radius: 12rpx;
  padding: 8rpx;
  margin-bottom: 20rpx;

  .tab-item {
    flex: 1;
    text-align: center;
    padding: 20rpx;
    font-size: 28rpx;
    color: #666;
    border-radius: 8rpx;
    transition: all 0.3s;

    &.active {
      background: #8A6A10;
      color: #fff;
      font-weight: 500;
    }
  }
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20rpx;
  margin-bottom: 20rpx;
}

.kpi-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  text-align: center;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .kpi-value {
    font-size: 48rpx;
    font-weight: bold;
    display: block;
  }

  .kpi-label {
    font-size: 26rpx;
    color: #666;
    margin-top: 12rpx;
    display: block;
  }
}

.kpi-hint {
  font-size: 22rpx;
  color: #9aa5b1;
  line-height: 1.6;
  margin: -6rpx 0 20rpx;
  padding: 0 6rpx;
}

.quick-actions {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20rpx;
  margin-bottom: 20rpx;

  .action-item {
    background: #fff;
    border-radius: 16rpx;
    padding: 30rpx 20rpx;
    text-align: center;
    box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

    .action-icon {
      font-size: 48rpx;
      display: block;
      margin-bottom: 12rpx;
    }

    .action-text {
      font-size: 24rpx;
      color: #666;
      display: block;
    }
  }
}

.wh-value-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .wh-value-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding-bottom: 20rpx;
    border-bottom: 1rpx solid #f0f0f0;

    .wh-value-title {
      font-size: 30rpx;
      font-weight: bold;
      color: #333;
    }

    .wh-value-sum {
      font-size: 32rpx;
      font-weight: bold;
      color: #e67e22;
    }
  }

  .wh-value-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 22rpx 0;
    border-bottom: 1rpx solid #f7f7f7;

    &:last-of-type {
      border-bottom: none;
    }

    .wh-value-left {
      .wh-name {
        font-size: 28rpx;
        color: #333;
        display: block;
      }

      .wh-stock {
        font-size: 22rpx;
        color: #999;
        margin-top: 6rpx;
        display: block;
      }
    }

    .wh-money {
      font-size: 32rpx;
      font-weight: bold;
      color: #c0392b;
    }
  }

  .wh-value-tip {
    display: block;
    margin-top: 14rpx;
    font-size: 22rpx;
    color: #bbb;
    line-height: 1.6;

    /* 待补价提示：琥珀色，和"说明文字"区分开，醒目但不报警 */
    &.pending-tip {
      margin-top: 8rpx;
      color: #B26A00;
      background: #FFF7E6;
      border-radius: 8rpx;
      padding: 8rpx 12rpx;
    }
  }
}

.warning-banner {
  display: flex;
  align-items: center;
  gap: 16rpx;
  background: #fff3cd;
  border: 1rpx solid #ffc107;
  border-radius: 12rpx;
  padding: 24rpx;

  .warning-icon {
    font-size: 36rpx;
  }

  .warning-text {
    font-size: 26rpx;
    color: #856404;
  }
}
</style>
