<template>
  <div class="screen-root">
    <!-- ===== 顶栏 ===== -->
    <header class="scr-head">
      <div class="head-left">
        <span class="logo-badge">胜龙</span>
        <div class="logo-txts">
          <span class="logo-text">胜龙进销存</span>
          <span class="logo-sub">SHENGLONG ERP · DATA CENTER</span>
        </div>
      </div>

      <div class="head-mid">
        <span class="big-title">数据大屏</span>
        <span class="clock">{{ clock }}</span>
      </div>

      <div class="head-right">
        <span class="updated">
          <em class="pulse-dot" />{{ lastUpdated ? `更新于 ${lastUpdated}` : '数据加载中…' }}
        </span>
        <button class="scr-btn" :class="{ on: autoRefresh }" @click="toggleAuto">
          自动刷新 {{ autoRefresh ? '开' : '关' }}
        </button>
        <button class="scr-btn" @click="loadAll(true)">刷新</button>
        <button class="scr-btn" @click="toggleFull">{{ isFull ? '退出全屏' : '全屏' }}</button>
        <button class="scr-btn ghost" @click="exitScreen">返回后台</button>
      </div>
    </header>

    <p v-if="errMsg" class="scr-err">{{ errMsg }}</p>

    <!-- ===== KPI（全部来自 stats.overview，老板可见） ===== -->
    <section class="kpi-row">
      <div v-for="k in kpis" :key="k.label" class="kpi" :class="`tone-${k.tone || 'blue'}`">
        <span class="kpi-icon">{{ k.icon }}</span>
        <div class="kpi-body">
          <p class="kpi-val">
            <small v-if="k.prefix" class="kpi-pre">{{ k.prefix }}</small>{{ k.value }}<small v-if="k.unit" class="kpi-unit">{{ k.unit }}</small>
          </p>
          <p class="kpi-label">{{ k.label }}</p>
        </div>
      </div>
    </section>

    <!-- ===== 第一排 ===== -->
    <section class="scr-row row-a">
      <!-- 仓库库存与总值 -->
      <div class="panel">
        <span class="p-corners" />
        <h3 class="panel-t">仓库库存与总值</h3>
        <div class="panel-b two-col">
          <div class="chart-box pie-wrap">
            <v-chart v-if="warehouses.length" class="chart" :option="optWarehouse" autoresize />
            <div v-if="warehouses.length" class="pie-center">
              <span>合计</span>
              <b>¥{{ fmtMoney(ov.total_value) }}</b>
            </div>
            <p v-else class="empty">暂无仓库数据</p>
          </div>
          <ul class="wh-list">
            <li v-for="w in warehouses" :key="w._id">
              <p class="wh-name">{{ w.name }}</p>
              <p class="wh-money">¥{{ fmtMoney(w.total_value) }}</p>
              <p class="wh-meta">{{ fmtNum(w.total_stock) }} 件 · {{ w.material_count }} 种物料</p>
            </li>
          </ul>
        </div>
      </div>

      <!-- 单据环节概览 -->
      <div class="panel">
        <span class="p-corners" />
        <h3 class="panel-t">单据环节概览</h3>
        <div class="panel-b col">
          <div class="chart-box">
            <v-chart v-if="!stageAllZero" class="chart" :option="optStage" autoresize />
            <p v-else class="empty">✅ 各环节均无待办单据</p>
          </div>
          <div class="mini-row">
            <div class="mini">
              <span>今日入库金额</span><b class="c-in">¥{{ fmtMoney(ov.today_inbound_amount) }}</b>
            </div>
            <div class="mini">
              <span>今日出库金额</span><b class="c-out">¥{{ fmtMoney(ov.today_outbound_amount) }}</b>
            </div>
            <div class="mini">
              <span>本月出库单</span><b>{{ ov.month_outbound_orders || 0 }}</b>
            </div>
          </div>
        </div>
      </div>

      <!-- 库存预警 -->
      <div class="panel">
        <span class="p-corners" />
        <h3 class="panel-t">库存预警 <em class="panel-note">共 {{ ov.warning_count || 0 }} 项</em></h3>
        <div class="panel-b">
          <ul class="list warn-list">
            <li v-for="w in warnings" :key="w._id">
              <span class="sev" :class="`sev-${w.severity}`">{{ sevText(w.severity) }}</span>
              <span class="cell-main">{{ w.name }}</span>
              <span class="cell-sub">{{ w.warehouse_name || '-' }}</span>
              <span class="cell-num danger">缺口 {{ w.shortage }} {{ w.unit || '' }}</span>
            </li>
            <li v-if="!warnings.length" class="empty-li">暂无库存预警</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ===== 第二排 ===== -->
    <section class="scr-row row-b">
      <!-- 物料排行 -->
      <div class="panel">
        <span class="p-corners" />
        <h3 class="panel-t">
          物料排行 TOP10
          <span class="tabs">
            <em :class="{ on: rankMode === 'outbound' }" @click="rankMode = 'outbound'">出库</em>
            <em :class="{ on: rankMode === 'inbound' }" @click="rankMode = 'inbound'">入库</em>
          </span>
        </h3>
        <div class="panel-b">
          <div class="chart-box">
            <v-chart v-if="rankList.length" class="chart" :option="optRank" autoresize />
            <p v-else class="empty">近 30 天暂无{{ rankMode === 'outbound' ? '出库' : '入库' }}记录</p>
          </div>
        </div>
      </div>

      <!-- 库存金额 TOP（库存台账） -->
      <div class="panel">
        <span class="p-corners" />
        <h3 class="panel-t">库存金额 TOP10 <em class="panel-note">台账</em></h3>
        <div class="panel-b">
          <ul class="list value-list">
            <li v-for="(m, i) in topValue" :key="m._id">
              <span class="rank-no" :class="`r${i + 1}`">{{ i + 1 }}</span>
              <span class="cell-main">{{ m.name }}</span>
              <span class="cell-sub">{{ m.current_stock }} × ¥{{ fmtMoney(m.avg_cost) }}</span>
              <span class="cell-num">¥{{ fmtMoney(m.stock_value) }}</span>
            </li>
            <li v-if="!topValue.length" class="empty-li">暂无库存数据</li>
          </ul>
        </div>
      </div>

      <!-- 单据流水 -->
      <div class="panel">
        <span class="p-corners" />
        <h3 class="panel-t">单据流水 <em class="panel-note">最近 {{ orders.length }} 张</em></h3>
        <div class="panel-b">
          <ul class="list order-list">
            <li v-for="o in orders" :key="`${o.kind}-${o._id}`">
              <span class="tag" :class="`tag-${o.kind}`">{{ o.kind === 'inbound' ? '入' : '出' }}</span>
              <span class="ord-no">{{ o.order_no }}</span>
              <span class="cell-main ellip">{{ o.material_names || '-' }}</span>
              <span class="cell-sub">{{ o.total_qty }} 件</span>
              <span class="cell-num">¥{{ fmtMoney(o.total_amount) }}</span>
            </li>
            <li v-if="!orders.length" class="empty-li">暂无单据（还没有发生过出入库）</li>
          </ul>
        </div>
      </div>

      <!-- 人员绩效 -->
      <div class="panel">
        <span class="p-corners" />
        <h3 class="panel-t">人员绩效 <em class="panel-note">近 30 天</em></h3>
        <div class="panel-b col">
          <div class="chart-box">
            <v-chart v-if="operators.length" class="chart" :option="optOperator" autoresize />
            <p v-else class="empty">近 30 天暂无操作记录</p>
          </div>
          <ul class="list login-list">
            <li v-for="l in logins" :key="l.user_name">
              <span class="cell-main">{{ l.user_name }}</span>
              <span class="cell-sub">{{ l.times }} 次登录</span>
            </li>
            <li v-if="!logins.length" class="empty-li">暂无登录记录</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ===== 底部滚动库存流水 ===== -->
    <footer class="scr-ticker">
      <span class="tk-label"><em class="pulse-dot" />库存流水</span>
      <div class="tk-view">
        <div
          class="tk-track"
          :style="flows.length ? { animationDuration: `${tickerSec}s` } : {}"
        >
          <span v-for="(f, i) in tickerItems" :key="i" class="tk-item">
            <em class="tk-type">{{ flowTypeText(f.change_type) }}</em>
            <span class="tk-name">{{ f.material_name }}</span>
            <b :class="Number(f.change_quantity) >= 0 ? 'up' : 'down'">
              {{ Number(f.change_quantity) >= 0 ? '+' : '' }}{{ f.change_quantity }}
            </b>
            <em class="tk-meta">
              {{ f.warehouse_name || '全仓' }} · {{ f.operator_name || '-' }} · {{ fmtTime(f.created_at) }}
            </em>
          </span>
          <span v-if="!flows.length" class="tk-item tk-none">
            暂无库存流水（系统还没有发生过出入库）
          </span>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup>
/**
 * 后台 · 数据大屏
 *
 * ⚠️ 数据口径铁律（本次需求原文：「显示所有老板能看到的数据」）：
 *   本页**只调用老板有权限的接口**，一项都不多调：
 *     stats.overview / warehouseSummary / stockList / orderFlow / warning / stockFlow
 *     / materialRank / operatorStats
 *   **刻意不用 stats.trend** —— 它只放行 admin，若调了，老板登后台进这页会整块 403 变空白。
 *   加新面板前先确认该接口的 roleRules 里有 boss。
 *
 * 页面是 Layout **之外**的独立全屏路由（/screen），自带深色底，不占侧边栏。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import dayjs from 'dayjs'
import { statsApi } from '@/api'

use([CanvasRenderer, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent])

const router = useRouter()

// ---------- 状态 ----------
const ov = ref({})
const warehouses = ref([])
const warnings = ref([])
const orders = ref([])
const flows = ref([])
const topValue = ref([])
const rankData = ref({ outbound: [], inbound: [] })
const rankMode = ref('outbound')
const operators = ref([])
const logins = ref([])

const errMsg = ref('')
const lastUpdated = ref('')
const clock = ref(dayjs().format('YYYY-MM-DD HH:mm:ss'))
const autoRefresh = ref(true)
const isFull = ref(false)

let clockTimer = null
let refreshTimer = null

// ---------- 格式化 ----------
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
/** 金额：过万折「万」、过亿折「亿」，保留 2 位（大屏一屏要放下） */
function fmtMoney(v) {
  const n = num(v)
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)} 万`
  return n.toFixed(2)
}
const fmtNum = (v) => num(v).toLocaleString('zh-CN')
const fmtTime = (t) => (t ? dayjs(t).format('MM-DD HH:mm') : '-')
const sevText = (s) => ({ out_of_stock: '断货', critical: '紧急', low: '偏低' }[s] || '偏低')
const flowTypeText = (t) =>
  ({ inbound: '入库', outbound: '出库', check: '盘点', adjust: '调整', scrap: '报废' }[t] || t || '')
const rankText = (t) =>
  ({ purchase: '采购入库', lingyong: '领用出库', weixiu: '维修出库', check: '盘点调整', adjust: '库存调整' }[t] || '')

// ---------- KPI ----------
const kpis = computed(() => [
  { label: '物料种类', value: fmtNum(ov.value.material_count), unit: '种', tone: 'blue', icon: '🗂️' },
  { label: '库存总量', value: fmtNum(ov.value.total_stock), unit: '件', tone: 'cyan', icon: '📊' },
  { label: '库存总值', value: fmtMoney(ov.value.total_value), prefix: '¥', tone: 'gold', icon: '💰' },
  { label: '预警物料', value: fmtNum(ov.value.warning_count), unit: '项', tone: num(ov.value.warning_count) ? 'red' : 'blue', icon: '⚠️' },
  { label: '零库存', value: fmtNum(ov.value.zero_count), unit: '项', tone: num(ov.value.zero_count) ? 'orange' : 'blue', icon: '⛔' },
  { label: '今日入库单', value: fmtNum(ov.value.today_inbound_orders), unit: '张', tone: 'cyan', icon: '📥' },
  { label: '今日出库单', value: fmtNum(ov.value.today_outbound_orders), unit: '张', tone: 'orange', icon: '📤' },
  { label: '本月出库单', value: fmtNum(ov.value.month_outbound_orders), unit: '张', tone: 'blue', icon: '📅' }
])

// ---------- 图表 option（深色底统一配色） ----------
const AXIS_LINE = '#1d3a5c'
const AXIS_TEXT = '#7ea6cd'
const TOOLTIP = {
  backgroundColor: 'rgba(6, 22, 41, 0.96)',
  borderColor: '#2b7bb6',
  borderWidth: 1,
  padding: [8, 12],
  textStyle: { color: '#dbe9f8', fontSize: 12 },
  extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,.45); border-radius: 8px;'
}

// 仓库总值占比
const optWarehouse = computed(() => ({
  tooltip: {
    ...TOOLTIP,
    trigger: 'item',
    formatter: (p) => `${p.name}<br/>¥${fmtMoney(p.value)}（${p.percent}%）`
  },
  legend: {
    bottom: 0,
    icon: 'circle',
    itemWidth: 9,
    itemHeight: 9,
    textStyle: { color: AXIS_TEXT, fontSize: 12 }
  },
  color: ['#22c9d8', '#f2a93b', '#7d7ce0', '#39c07a'],
  series: [
    {
      type: 'pie',
      radius: ['52%', '72%'],
      center: ['50%', '43%'],
      avoidLabelOverlap: true,
      itemStyle: {
        borderColor: '#06182b',
        borderWidth: 3,
        borderRadius: 5,
        shadowBlur: 14,
        shadowColor: 'rgba(0, 0, 0, 0.5)'
      },
      emphasis: {
        scale: true,
        scaleSize: 5,
        itemStyle: { shadowBlur: 22, shadowColor: 'rgba(0, 0, 0, 0.55)' }
      },
      label: { color: '#cfe3f7', fontSize: 12, formatter: '{b}\n{d}%' },
      labelLine: { lineStyle: { color: '#3d6f9e' } },
      data: warehouses.value.map((w) => ({ name: w.name, value: num(w.total_value) }))
    }
  ]
}))

// 单据环节（待办）柱状。全为 0 时不画图（否则 6 根零高柱子只剩 6 个悬空「0」，
// 看着像图表坏了）——改由模板走空态文案
const stageItems = computed(() => [
  { name: '待确认出库', value: num(ov.value.pending_outbound) },
  { name: '待拣货', value: num(ov.value.picking_outbound) },
  { name: '待收货', value: num(ov.value.receiving_outbound) },
  { name: '待确认入库', value: num(ov.value.pending_inbound) },
  { name: '进行中盘点', value: num(ov.value.pending_checks) },
  { name: '待审核用户', value: num(ov.value.pending_users) }
])
const stageAllZero = computed(() => stageItems.value.every((s) => s.value === 0))

const optStage = computed(() => ({
  tooltip: { ...TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
  grid: { left: 8, right: 12, top: 20, bottom: 4, containLabel: true },
  xAxis: {
    type: 'category',
    data: stageItems.value.map((s) => s.name),
    axisLine: { lineStyle: { color: AXIS_LINE } },
    axisTick: { show: false },
    axisLabel: { color: AXIS_TEXT, fontSize: 10, interval: 0 },
    splitLine: { show: false }
  },
  yAxis: {
    type: 'value',
    minInterval: 1,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: AXIS_TEXT, fontSize: 11 },
    splitLine: { lineStyle: { color: AXIS_LINE, type: 'dashed' } }
  },
  series: [
    {
      type: 'bar',
      barWidth: '44%',
      data: stageItems.value.map((s) => s.value),
      showBackground: true,
      backgroundStyle: { color: 'rgba(29, 58, 92, 0.3)', borderRadius: [4, 4, 0, 0] },
      itemStyle: {
        borderRadius: [5, 5, 0, 0],
        shadowBlur: 10,
        shadowColor: 'rgba(53, 168, 232, 0.35)',
        shadowOffsetY: 0,
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: '#43e6ff' },
            { offset: 0.55, color: '#1d9bd1' },
            { offset: 1, color: 'rgba(23, 110, 190, 0.25)' }
          ]
        }
      },
      emphasis: {
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: '#aef1ff' },
              { offset: 1, color: '#2aa5d8' }
            ]
          }
        }
      },
      label: { show: true, position: 'top', color: '#cfe3f7', fontSize: 11, fontWeight: 600 }
    }
  ]
}))

// 物料排行 TOP10（横向条，倒序让第一名在最上面）
const rankList = computed(() => rankData.value[rankMode.value] || [])
/** 去掉名字前的 [XXX] 标记再截断，否则「[RA-SCR]演示物料A」会被截成只剩标记 */
const shortName = (name, n = 8) =>
  String(name || '').replace(/^\[[^\]]*\]/, '').trim().slice(0, n)
const optRank = computed(() => {
  const arr = [...rankList.value].reverse()
  return {
    tooltip: { ...TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 6, right: 48, top: 8, bottom: 4, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: { lineStyle: { color: AXIS_LINE, type: 'dashed' } }
    },
    yAxis: {
      type: 'category',
      data: arr.map((r) => shortName(r.material_name)),
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 }
    },
    series: [
      {
        type: 'bar',
        // 只有一条数据时，band 会占满整块高度 → 柱子被拉成一整块。
        // 限制最大宽度，条数少时也只是细条，不糊满面板。
        barMaxWidth: 22,
        data: arr.map((r) => num(r.qty)),
        showBackground: true,
        backgroundStyle: { color: 'rgba(29, 58, 92, 0.3)', borderRadius: [0, 5, 5, 0] },
        itemStyle: {
          borderRadius: [0, 5, 5, 0],
          shadowBlur: 8,
          shadowColor: rankMode.value === 'outbound' ? 'rgba(242, 169, 59, 0.3)' : 'rgba(34, 201, 216, 0.3)',
          color: rankMode.value === 'outbound' ? '#f2a93b' : '#22c9d8'
        },
        emphasis: { itemStyle: { shadowBlur: 16 } },
        label: { show: true, position: 'right', color: '#cfe3f7', fontSize: 11, fontWeight: 600 }
      }
    ]
  }
})

// 人员绩效（出库单数）
const optOperator = computed(() => {
  const arr = [...operators.value].reverse().slice(-8)
  return {
    tooltip: { ...TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 6, right: 36, top: 8, bottom: 4, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: { lineStyle: { color: AXIS_LINE, type: 'dashed' } }
    },
    yAxis: {
      type: 'category',
      data: arr.map((r) => String(r.operator_name || '未知').slice(0, 6)),
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 }
    },
    series: [
      {
        type: 'bar',
        // 同上：只有 1 个操作人时别把柱子拉成一整块
        barMaxWidth: 22,
        data: arr.map((r) => num(r.orders)),
        showBackground: true,
        backgroundStyle: { color: 'rgba(29, 58, 92, 0.3)', borderRadius: [0, 5, 5, 0] },
        itemStyle: {
          borderRadius: [0, 5, 5, 0],
          shadowBlur: 8,
          shadowColor: 'rgba(125, 124, 224, 0.35)',
          color: '#7d7ce0'
        },
        emphasis: { itemStyle: { shadowBlur: 16 } },
        label: { show: true, position: 'right', color: '#cfe3f7', fontSize: 11, fontWeight: 600 }
      }
    ]
  }
})

// 底部滚动流水：内容复制一份，配合 translateX(-50%) 做无缝滚动
const tickerItems = computed(() => (flows.value.length ? [...flows.value, ...flows.value] : []))
const tickerSec = computed(() => Math.max(24, flows.value.length * 4))

// ---------- 取数 ----------
function apply(key, data) {
  switch (key) {
    case 'overview': ov.value = data || {}; break
    case 'warehouseSummary': warehouses.value = data.list || []; break
    case 'warning': warnings.value = data.list || []; break
    case 'orderFlow': orders.value = data.list || []; break
    case 'stockFlow': flows.value = data.list || []; break
    case 'stockList': topValue.value = (data.list || []).slice(0, 10); break
    case 'materialRank': rankData.value = { outbound: data.outbound || [], inbound: data.inbound || [] }; break
    case 'operatorStats':
      operators.value = data.outbound || []
      logins.value = data.logins || []
      break
  }
}

async function loadAll() {
  // ⚠️ 只调老板有权限的接口（见文件头说明）
  const jobs = [
    ['overview', statsApi.overview()],
    ['warehouseSummary', statsApi.warehouseSummary()],
    ['warning', statsApi.warning({ page: 1, pageSize: 8 })],
    ['stockList', statsApi.stockList({ page: 1, pageSize: 10 })],
    ['orderFlow', statsApi.orderFlow({ page: 1, pageSize: 12 })],
    ['stockFlow', statsApi.stockFlow({ page: 1, pageSize: 15 })],
    ['materialRank', statsApi.materialRank({ days: 30, limit: 10 })],
    ['operatorStats', statsApi.operatorStats({ days: 30 })]
  ]

  const settled = await Promise.allSettled(jobs.map(([, p]) => p))
  const failed = []
  settled.forEach((r, i) => {
    const key = jobs[i][0]
    if (r.status !== 'fulfilled') { failed.push(`${key}(网络)`); return }
    const body = r.value || {}
    if (body.code !== 0) { failed.push(`${key}(${body.message || body.code})`); return }
    apply(key, body.data || {})
  })

  errMsg.value = failed.length ? `以下数据未能加载：${failed.join('、')}` : ''
  lastUpdated.value = dayjs().format('HH:mm:ss')
}

// ---------- 交互 ----------
function toggleAuto() {
  autoRefresh.value = !autoRefresh.value
  setupRefreshTimer()
}

function setupRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer)
  if (autoRefresh.value) {
    refreshTimer = setInterval(() => { loadAll() }, 30000)
  }
}

function toggleFull() {
  const el = document.documentElement
  if (document.fullscreenElement) document.exitFullscreen?.()
  else el.requestFullscreen?.()
}

function onFsChange() {
  isFull.value = !!document.fullscreenElement
}

function exitScreen() {
  if (document.fullscreenElement) document.exitFullscreen?.()
  router.push('/dashboard')
}

onMounted(() => {
  loadAll()
  clockTimer = setInterval(() => { clock.value = dayjs().format('YYYY-MM-DD HH:mm:ss') }, 1000)
  setupRefreshTimer()
  document.addEventListener('fullscreenchange', onFsChange)
})

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer)
  if (refreshTimer) clearInterval(refreshTimer)
  document.removeEventListener('fullscreenchange', onFsChange)
})
</script>

<style scoped>
/* ================================================================
   数据大屏 · 视觉规范（深色科技风）
   目标：挂办公室电视 / 显示器上一眼专业。
   只用 CSS，不动任何数据逻辑与 class 命名（verify-admin-screen.js 依赖这些类）
   ================================================================ */

/* ---------- 字体与数字 ---------- */
.screen-root {
  position: fixed;
  left: 0;
  top: 0;
  /* 跟随实际可见区域（页面级缩放下 vw/vh 不重算），取不到时退回 100vw/100vh */
  width: var(--app-w, 100vw);
  height: var(--app-h, 100vh);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px 16px;
  /* 背景：多层径向光晕 + 主渐变，营造「深处有光」的层次感 */
  background:
    radial-gradient(1400px 700px at 50% -12%, rgba(35, 120, 195, 0.30) 0%, transparent 62%),
    radial-gradient(900px 520px at 10% 112%, rgba(43, 80, 165, 0.20) 0%, transparent 62%),
    radial-gradient(900px 520px at 90% 112%, rgba(115, 60, 170, 0.13) 0%, transparent 62%),
    linear-gradient(180deg, #051426 0%, #030b16 100%);
  color: #dbe9f8;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  overflow: hidden;
  z-index: 100;
}
/* 细点阵网格底纹（数据大屏的“科技底”），四角淡出 */
.screen-root::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(80, 160, 220, 0.10) 1px, transparent 1px);
  background-size: 26px 26px;
  mask-image: radial-gradient(closest-side at 50% 40%, rgba(0,0,0,.9), transparent 78%);
  -webkit-mask-image: radial-gradient(closest-side at 50% 40%, rgba(0,0,0,.9), transparent 78%);
}

/* 所有数字走等宽数字字体，列对齐不跳动 */
.kpi-val, .wh-money, .mini b, .cell-num, .clock, .rank-no {
  font-variant-numeric: tabular-nums;
  font-family: 'DIN Alternate', 'Bahnschrift', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

/* ---------- 入场微动画（克制的上浮，不晃眼） ---------- */
@keyframes rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}
.kpi, .panel, .scr-head, .scr-ticker { animation: rise 0.45s ease both; }
.kpi:nth-child(1) { animation-delay: 0.00s } .kpi:nth-child(2) { animation-delay: 0.04s }
.kpi:nth-child(3) { animation-delay: 0.08s } .kpi:nth-child(4) { animation-delay: 0.12s }
.kpi:nth-child(5) { animation-delay: 0.16s } .kpi:nth-child(6) { animation-delay: 0.20s }
.kpi:nth-child(7) { animation-delay: 0.24s } .kpi:nth-child(8) { animation-delay: 0.28s }

/* ================================================================
   顶栏
   ================================================================ */
.scr-head {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  border-radius: 10px;
  border: 1px solid rgba(43, 123, 182, 0.4);
  background: linear-gradient(90deg, rgba(13, 55, 94, 0.9), rgba(9, 36, 64, 0.9) 50%, rgba(13, 55, 94, 0.9));
  box-shadow: inset 0 0 30px rgba(35, 140, 220, 0.16), 0 4px 18px rgba(0, 0, 0, 0.35);
}
/* 顶栏底部一条渐变光带 */
.scr-head::after {
  content: '';
  position: absolute; left: 2%; right: 2%; bottom: -1px; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(53, 224, 255, 0.85) 50%, transparent);
  filter: blur(0.3px);
}

.head-left { display: flex; align-items: center; gap: 10px; }
.logo-badge {
  width: 40px; height: 40px;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; letter-spacing: 1px;
  color: #04263c;
  background: linear-gradient(135deg, #43e6ff, #1d9bd1);
  border-radius: 9px;
  box-shadow: 0 0 14px rgba(53, 224, 255, 0.45), inset 0 0 8px rgba(255,255,255,0.25);
}
.logo-txts { display: flex; flex-direction: column; line-height: 1.15; }
.logo-text {
  font-size: 20px; font-weight: 700; letter-spacing: 2px;
  background: linear-gradient(180deg, #ffffff, #7fd4ff);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.logo-sub { font-size: 10px; letter-spacing: 2px; color: #5d89ad; }

.head-mid { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.big-title {
  font-size: 24px; font-weight: 800; letter-spacing: 10px; padding-left: 10px;
  background: linear-gradient(180deg, #ffffff 0%, #9fdcff 55%, #35a8e8 100%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  text-shadow: 0 0 18px rgba(53, 224, 255, 0.35);
}
.clock { font-size: 15px; font-weight: 600; color: #7fe3ff; letter-spacing: 2px; }

.head-right { display: flex; align-items: center; gap: 8px; }
.updated {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: #6f9dc6; margin-right: 6px; white-space: nowrap;
}
.pulse-dot {
  width: 7px; height: 7px; border-radius: 50%; background: #39dea0;
  box-shadow: 0 0 0 0 rgba(57, 222, 160, 0.55);
  animation: pulse 1.6s ease-out infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(57, 222, 160, 0.55); }
  70% { box-shadow: 0 0 0 9px rgba(57, 222, 160, 0); }
  100% { box-shadow: 0 0 0 0 rgba(57, 222, 160, 0); }
}

.scr-btn {
  cursor: pointer;
  font-size: 12px;
  padding: 7px 13px;
  border-radius: 7px;
  color: #a8cdea;
  background: rgba(23, 82, 133, 0.5);
  border: 1px solid rgba(47, 142, 203, 0.55);
  backdrop-filter: blur(4px);
  transition: all 0.18s;
}
.scr-btn:hover {
  color: #fff;
  background: rgba(35, 128, 199, 0.7);
  border-color: #35a8e8;
  box-shadow: 0 0 12px rgba(53, 168, 232, 0.35);
}
.scr-btn.on {
  color: #04240f; background: linear-gradient(135deg, #3ce9a8, #22c47e);
  border-color: #39dea0; font-weight: 600; box-shadow: 0 0 12px rgba(57, 222, 160, 0.35);
}
.scr-btn.ghost { background: transparent; }

.scr-err {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: #ffcf8a;
  background: rgba(120, 70, 10, 0.4);
  border: 1px solid rgba(242, 169, 59, 0.5);
  border-radius: 6px;
}

/* ================================================================
   KPI 条
   ================================================================ */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 12px;
}
.kpi {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid rgba(43, 123, 182, 0.32);
  background: linear-gradient(180deg, rgba(13, 52, 88, 0.85), rgba(7, 26, 47, 0.85));
  overflow: hidden;
  transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
}
.kpi:hover {
  transform: translateY(-2px);
  border-color: rgba(53, 224, 255, 0.55);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35), 0 0 18px rgba(53, 224, 255, 0.18);
}
/* 顶部渐变高光 */
.kpi::before {
  content: '';
  position: absolute; left: 0; right: 0; top: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--k-accent, #2f8ecb), transparent);
}
.kpi-icon {
  flex: none;
  width: 40px; height: 40px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px;
  border-radius: 10px;
  background: rgba(43, 123, 182, 0.18);
  border: 1px solid rgba(43, 123, 182, 0.3);
  box-shadow: inset 0 0 10px rgba(53, 224, 255, 0.08);
}
.kpi-body { min-width: 0; }
.kpi-val {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
  color: #eaf4ff;
  white-space: nowrap;
}
.kpi-pre { font-size: 15px; margin-right: 2px; color: #8fc4e8; }
.kpi-unit { font-size: 13px; margin-left: 3px; color: #7ea6cd; font-weight: 500; }
.kpi-label { margin: 4px 0 0; font-size: 12px; color: #7ea6cd; letter-spacing: 1px; }

/* 各色调 */
.kpi { --k-accent: #2f8ecb; }
.tone-cyan { --k-accent: #22c9d8; } .tone-cyan .kpi-val { color: #6ee7f5; }
.tone-gold { --k-accent: #f2a93b; } .tone-gold .kpi-val { color: #ffd66b; }
.tone-red { --k-accent: #ef4f4f; } .tone-red .kpi-val { color: #ff8f8f; }
.tone-orange { --k-accent: #f2872b; } .tone-orange .kpi-val { color: #ffb765; }

/* ================================================================
   面板
   ================================================================ */
.scr-row { display: grid; gap: 12px; min-height: 0; }
.row-a { grid-template-columns: 1fr 1fr 1fr; flex: 1.05; }
.row-b { grid-template-columns: 1fr 1fr 1fr 1fr; flex: 1; }

.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid rgba(43, 123, 182, 0.32);
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(11, 44, 76, 0.62), rgba(6, 22, 40, 0.62));
  backdrop-filter: blur(3px);
  box-shadow: inset 0 0 30px rgba(30, 120, 200, 0.07), 0 4px 16px rgba(0, 0, 0, 0.28);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.panel:hover {
  border-color: rgba(53, 224, 255, 0.5);
  box-shadow: inset 0 0 30px rgba(30, 120, 200, 0.1), 0 6px 22px rgba(0, 0, 0, 0.35), 0 0 18px rgba(53, 224, 255, 0.14);
}
/* 四角科技角标：8 段线性渐变拼 4 个「┌ ┐ └ ┘」，单元素搞定（不动伪元素） */
.p-corners {
  position: absolute; inset: 0;
  pointer-events: none;
  border-radius: 10px;
  opacity: 0.55;
  background:
    linear-gradient(to right, #35e0ff 14px, transparent 0) top left / 16px 2px,
    linear-gradient(to bottom, #35e0ff 14px, transparent 0) top left / 2px 16px,
    linear-gradient(to left, #35e0ff 14px, transparent 0) top right / 16px 2px,
    linear-gradient(to bottom, #35e0ff 14px, transparent 0) top right / 2px 16px,
    linear-gradient(to right, #35e0ff 14px, transparent 0) bottom left / 16px 2px,
    linear-gradient(to top, #35e0ff 14px, transparent 0) bottom left / 2px 16px,
    linear-gradient(to left, #35e0ff 14px, transparent 0) bottom right / 16px 2px,
    linear-gradient(to top, #35e0ff 14px, transparent 0) bottom right / 2px 16px;
  background-repeat: no-repeat;
}

.panel-t {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  font-size: 14px;
  font-weight: 600;
  color: #d9ecff;
  letter-spacing: 2px;
  border-bottom: 1px solid rgba(29, 58, 92, 0.9);
  background: linear-gradient(90deg, rgba(24, 92, 150, 0.4), transparent 60%);
}
.panel-t::before {
  content: '';
  width: 3px; height: 14px; border-radius: 2px;
  background: linear-gradient(180deg, #43e6ff, #1d9bd1);
  box-shadow: 0 0 9px rgba(53, 224, 255, 0.7);
}
/* 标题下压一条很细的高光 */
.panel-t::after {
  content: '';
  position: absolute; left: 12px; right: 12px; bottom: -1px; height: 1px;
  background: linear-gradient(90deg, rgba(53, 224, 255, 0.7), transparent 40%);
}
.panel-note { font-style: normal; font-size: 11px; color: #6f9dc6; font-weight: 400; margin-left: auto; letter-spacing: 0; }

.panel-b { flex: 1; min-height: 0; padding: 8px 10px 10px; overflow: hidden; }
.panel-b.col { display: flex; flex-direction: column; gap: 6px; }
.panel-b.two-col { display: grid; grid-template-columns: 1.05fr 1fr; gap: 6px; }

.chart-box { flex: 1; min-height: 0; }
.chart { width: 100%; height: 100%; min-height: 130px; }
.empty { margin: 0; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #5c86ad; }

/* 饼图中心「合计」覆盖层（纯展示，不改图表逻辑） */
.pie-wrap { position: relative; }
.pie-center {
  position: absolute;
  left: 50%; top: 43%;
  transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  pointer-events: none;
}
.pie-center span { font-size: 11px; color: #7ea6cd; letter-spacing: 2px; }
.pie-center b {
  font-size: 17px; color: #ffd66b; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* ---------- 列表 ---------- */
.list { list-style: none; margin: 0; padding: 0; height: 100%; overflow: hidden; }
.list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  font-size: 12.5px;
  border-bottom: 1px dashed rgba(29, 58, 92, 0.7);
  border-radius: 4px;
  transition: background 0.15s;
}
.list li:nth-child(even) { background: rgba(20, 62, 100, 0.14); }
.list li:hover { background: rgba(43, 123, 182, 0.18); }
.cell-main { color: #d7e8f8; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-sub { color: #7ea6cd; font-size: 11.5px; white-space: nowrap; }
.cell-num { color: #9fe8c8; font-weight: 600; white-space: nowrap; }
.cell-num.danger { color: #ff9b6b; }
.empty-li { justify-content: center; color: #5c86ad; font-size: 12px; border-bottom: none !important; background: none !important; height: 100%; }

/* 仓库明细卡 */
.wh-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; }
.wh-list li {
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid rgba(43, 123, 182, 0.35);
  background: linear-gradient(90deg, rgba(16, 62, 104, 0.6), rgba(10, 34, 60, 0.6));
  box-shadow: inset 0 0 14px rgba(53, 224, 255, 0.05);
}
.wh-name { margin: 0; font-size: 12.5px; color: #9dc2e2; letter-spacing: 1px; }
.wh-money { margin: 2px 0; font-size: 20px; font-weight: 700; color: #ffd66b; }
.wh-meta { margin: 0; font-size: 11.5px; color: #6f9dc6; }

/* 迷你数字 */
.mini-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.mini {
  display: flex; flex-direction: column; gap: 2px;
  padding: 7px 9px; border-radius: 8px;
  border: 1px solid rgba(43, 123, 182, 0.35);
  background: rgba(14, 52, 88, 0.45);
}
.mini span { font-size: 11px; color: #7ea6cd; }
.mini b { font-size: 15px; color: #eaf4ff; }
.mini .c-in { color: #6ee7f5; }
.mini .c-out { color: #ffb765; }

/* 预警等级 */
.sev {
  flex: none; font-size: 11px; padding: 1px 7px; border-radius: 4px; white-space: nowrap; font-weight: 600;
}
.sev-out_of_stock { color: #fff; background: linear-gradient(135deg, #e04545, #b62b2b); box-shadow: 0 0 8px rgba(224, 69, 69, 0.4); }
.sev-critical { color: #ffe2c2; background: linear-gradient(135deg, #c06a12, #9a4d08); }
.sev-low { color: #d9f5e6; background: linear-gradient(135deg, #237f56, #18623f); }

/* 排行序号 & 单据入出标签 */
.rank-no {
  flex: none; width: 19px; height: 19px; line-height: 19px; text-align: center;
  font-size: 11px; border-radius: 4px; color: #0b2136; background: #6f9dc6; font-weight: 700;
}
.rank-no.r1 { background: linear-gradient(135deg, #ffd66b, #e0a93b); box-shadow: 0 0 8px rgba(255, 214, 107, 0.45); }
.rank-no.r2 { background: linear-gradient(135deg, #e8eef5, #b9c4d2); }
.rank-no.r3 { background: linear-gradient(135deg, #eeb482, #cf8a52); }
.tag {
  flex: none; width: 19px; height: 19px; line-height: 19px; text-align: center;
  font-size: 11px; border-radius: 4px; font-weight: 700;
}
.tag-inbound { color: #04241a; background: linear-gradient(135deg, #4fd6b0, #22b187); }
.tag-outbound { color: #2a1400; background: linear-gradient(135deg, #f2b64b, #d98a1f); }
.ord-no { flex: none; width: 118px; font-size: 11.5px; color: #8fc4e8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.login-list { flex: none; max-height: 82px; overflow: hidden; }

/* 排行面板右上角 出/入 切换 */
.tabs { margin-left: auto; display: inline-flex; border: 1px solid rgba(43, 123, 182, 0.5); border-radius: 6px; overflow: hidden; }
.tabs em {
  font-style: normal; font-size: 11px; padding: 2px 10px; cursor: pointer; color: #7ea6cd;
  background: rgba(10, 30, 52, 0.6);
  transition: all 0.15s;
}
.tabs em.on { color: #04263c; background: #35c9e8; font-weight: 600; }

/* ================================================================
   底部滚动库存流水
   ================================================================ */
.scr-ticker {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  padding: 0 14px;
  border: 1px solid rgba(43, 123, 182, 0.4);
  border-radius: 10px;
  background: linear-gradient(90deg, rgba(13, 55, 94, 0.8), rgba(8, 32, 58, 0.8));
  box-shadow: inset 0 0 24px rgba(35, 140, 220, 0.1);
  overflow: hidden;
}
.tk-label {
  flex: none; display: flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: #7fe3ff; padding-right: 12px;
  border-right: 1px solid rgba(43, 123, 182, 0.5); letter-spacing: 2px; white-space: nowrap;
}
.tk-view { flex: 1; overflow: hidden; }
.tk-track { display: flex; gap: 46px; white-space: nowrap; animation: tk-move 40s linear infinite; }
.tk-track:hover { animation-play-state: paused; }
.tk-item { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: #cfe3f7; }
.tk-type {
  font-style: normal; font-size: 11px; padding: 1px 6px; border-radius: 4px;
  color: #9fd8ff; background: rgba(35, 128, 199, 0.35); border: 1px solid rgba(53, 168, 232, 0.4);
}
.tk-name { color: #eaf4ff; }
.tk-item .up { color: #6ee7f5; }
.tk-item .down { color: #ffb765; }
.tk-meta { font-style: normal; font-size: 11px; color: #6f9dc6; }
.tk-none { color: #5c86ad; }
@keyframes tk-move {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}

/* 窄屏兜底（大屏按 1920×1080 设计，这里只保证不撑破） */
@media (max-width: 1500px) {
  .kpi-row { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .row-b { grid-template-columns: repeat(2, 1fr); }
  .screen-root { overflow: auto; }
}
</style>
