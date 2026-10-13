<template>
  <div class="dashboard" v-loading="loading">
    <!-- 统计卡片 -->
    <el-row :gutter="20" class="stat-cards">
      <el-col :span="6" v-for="card in statCards" :key="card.title">
        <el-card class="stat-card" :body-style="{ padding: '20px' }">
          <div class="stat-icon" :style="{ background: card.color }">
            <el-icon :size="28" color="#fff"><component :is="card.icon" /></el-icon>
          </div>
          <div class="stat-info">
            <p class="stat-value">{{ card.value }}</p>
            <p class="stat-title">{{ card.title }}</p>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 待办提醒 -->
    <el-row :gutter="20" class="quick-actions">
      <el-col :span="24">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>待办提醒</span>
              <el-button size="small" @click="loadData">
                <el-icon><Refresh /></el-icon>刷新
              </el-button>
            </div>
          </template>
          <div class="pending-list">
            <el-tag type="warning" effect="plain">
              待确认出库单：{{ stats.pending_outbound || 0 }}
            </el-tag>
            <!-- V2 新增的两个环节：不显示出来，货卡在哪个环节就没人知道 -->
            <el-tag
              type="primary"
              effect="plain"
              style="cursor: pointer"
              @click="$router.push('/order/outbound')"
            >
              待拣货：{{ stats.picking_outbound || 0 }}
            </el-tag>
            <el-tag
              type="primary"
              effect="plain"
              style="cursor: pointer"
              @click="$router.push('/order/outbound')"
            >
              待收货：{{ stats.receiving_outbound || 0 }}
            </el-tag>
            <el-tag type="warning" effect="plain">
              待确认入库单：{{ stats.pending_inbound || 0 }}
            </el-tag>
            <!-- 待审核用户只有管理员/老板能看到（user.list 只放行这两个角色） -->
            <el-tag v-if="canUser" type="danger" effect="plain">
              待审核用户：{{ stats.pending_users || 0 }}
            </el-tag>
            <el-tag type="danger" effect="plain">
              进行中盘点：{{ stats.pending_checks || 0 }}
            </el-tag>
            <el-tag type="info" effect="plain">
              零库存物料：{{ stats.zero_count || 0 }}
            </el-tag>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 采购任务状态（2026-10-12 用户要求：看板直接看到采购任务进度，点状态卡跳到对应筛选）
         ⚠️ 采购任务只针对配件仓：成品仓的货是车间做的、不需要采购 →
            纯成品仓后台（只辖 chengpin）整块不显示，见 showPurchaseTask -->
    <el-row v-if="showPurchaseTask" :gutter="20" class="quick-actions">
      <el-col :span="24">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>采购任务</span>
              <el-button size="small" text type="primary" @click="$router.push('/order/purchase-tasks')">
                进入采购任务 →
              </el-button>
            </div>
          </template>
          <div class="purchase-stat-row">
            <div
              v-for="s in purchaseStats"
              :key="s.key"
              class="purchase-stat-item"
              :style="{ borderTop: `3px solid ${s.color}` }"
              @click="goPurchaseTasks(s.key)"
            >
              <div class="purchase-stat-num" :style="{ color: s.color }">{{ s.value }}</div>
              <div class="purchase-stat-label">{{ s.label }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 快捷入口 -->
    <el-row :gutter="20" class="quick-actions">
      <el-col :span="24">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>快捷操作</span>
            </div>
          </template>
          <div class="action-buttons">
            <el-button type="primary" @click="$router.push('/order/outbound')">
              <el-icon><Download /></el-icon>出库单
            </el-button>
            <el-button v-if="canInbound" type="success" @click="$router.push('/order/inbound')">
              <el-icon><Upload /></el-icon>入库单
            </el-button>
            <el-button v-if="canCheck" type="warning" @click="$router.push('/check/create')">
              <el-icon><Checked /></el-icon>创建盘点
            </el-button>
            <!-- 月结表入口（2026-10-13 用户要求）：只给老板/厂长看数 -->
            <el-button v-if="canMonthly" type="danger" plain @click="$router.push('/stats/monthly')">
              <el-icon><Calendar /></el-icon>月结表
            </el-button>
            <el-button v-if="canMaterial" type="info" @click="$router.push('/material/list')">
              <el-icon><Box /></el-icon>物料管理
            </el-button>
            <el-button v-if="canUser" @click="$router.push('/user/list')">
              <el-icon><User /></el-icon>用户管理
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 预警提示 -->
    <el-row :gutter="20" v-if="warningList.length > 0">
      <el-col :span="24">
        <el-card>
          <template #header>
            <div class="card-header">
              <span class="warning-title">⚠️ 库存预警</span>
              <el-tag type="danger">{{ warningTotal }} 个物料</el-tag>
            </div>
          </template>
          <el-table :data="warningList" style="width: 100%">
            <el-table-column prop="name" label="物料名称" />
            <el-table-column prop="spec" label="规格" />
            <el-table-column prop="warehouse_name" label="仓库" width="120" />
            <el-table-column prop="current_stock" label="当前库存">
              <template #default="{ row }">
                <span class="danger-text">{{ row.current_stock }} {{ row.unit }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="warning_stock" label="预警库存" />
            <el-table-column prop="shortage" label="缺口" width="100" />
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button
                  size="small"
                  type="primary"
                  @click="$router.push({ path: '/material/list', query: { keyword: row.name } })"
                >
                  去查看
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 最近单据 -->
    <el-row :gutter="20" class="recent-orders">
      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>最近出库</span>
              <el-link type="primary" @click="$router.push('/order/outbound')">查看全部</el-link>
            </div>
          </template>
          <el-table :data="recentOutbound" style="width: 100%" size="small">
            <el-table-column prop="order_no" label="单号" width="150" />
            <el-table-column prop="material_names" label="物料" show-overflow-tooltip />
            <el-table-column prop="total_qty" label="数量" width="70" />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="statusTagType(row.status)" size="small">
                  {{ statusText(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="created_at" label="时间" width="100">
              <template #default="{ row }">
                {{ formatDate(row.created_at) }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>最近入库</span>
              <el-link type="primary" @click="$router.push('/order/inbound')">查看全部</el-link>
            </div>
          </template>
          <el-table :data="recentInbound" style="width: 100%" size="small">
            <el-table-column prop="order_no" label="单号" width="150" />
            <el-table-column prop="material_names" label="物料" show-overflow-tooltip />
            <el-table-column prop="total_qty" label="数量" width="70" />
            <!-- 入库金额：仓管端只保留**配件仓**单据的金额（后端 orderFlow 按行脱敏，
                 成品仓的行拿不到 total_amount）→ 整列是否有值取决于数据，故按数据判断 -->
            <el-table-column v-if="showInboundAmount" prop="total_amount" label="金额" width="100">
              <template #default="{ row }">
                ¥{{ row.total_amount }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Download,
  Upload,
  Checked,
  Box,
  User,
  TrendCharts,
  Warning,
  Refresh,
  Calendar
} from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { statsApi, purchaseApi, warehouseApi } from '@/api'
import { useUserStore } from '@/store/user'
import { canViewCost } from '@/constants/roles'
import { inPartsScope, resolveWarehouseCodes } from '@/constants/warehouse-scope'

const userStore = useUserStore()

/**
 * 快捷操作按钮按角色显隐。
 * ⚠️ 这些按钮跳到别的页面，而路由守卫 + 后端 roleRules 都会挡；
 *   前端提前藏掉只是「别让人点了才发现进不去」。
 */
const canUser = computed(() => userStore.hasRole('admin', 'boss'))
const canInbound = computed(() => userStore.hasRole('admin', 'boss', 'storekeeper'))
const canCheck = computed(() => userStore.hasRole('admin', 'storekeeper', 'director'))
const canMaterial = computed(() => userStore.hasRole('admin', 'boss', 'storekeeper', 'director'))
// 月结表入口只给老板/厂长（2026-10-13 用户要求）；admin 从侧边栏「数据统计→月结表」进
const canMonthly = computed(() => userStore.hasRole('boss', 'director'))

/**
 * 金额是否展示（2026-10-10）：仓管端只看数量、不看钱。
 * ⚠️ 后端已脱敏（stats.overview 对仓管不返回 total_value 等），
 *    这里只是「不显示空卡片 / 空列」的体验层，别当前端防线用。
 */
const canSeeCost = computed(() => canViewCost(userStore.roles || []))

const router = useRouter()
const loading = ref(false)

const stats = ref({
  material_count: 0,
  total_stock: 0,
  total_value: 0,
  warning_count: 0,
  zero_count: 0,
  today_outbound_orders: 0,
  today_outbound_qty: 0,
  today_inbound_orders: 0,
  today_inbound_qty: 0,
  today_inbound_amount: 0,
  pending_outbound: 0,
  picking_outbound: 0,
  receiving_outbound: 0,
  pending_inbound: 0,
  pending_users: 0,
  pending_checks: 0
})

const warningList = ref([])
const warningTotal = ref(0)
const recentOutbound = ref([])
const recentInbound = ref([])

// 采购任务状态统计（2026-10-12）：看板直接看到采购进度，与采购任务页的状态卡同口径
const purchaseStats = ref([
  { key: 'open', label: '待领取', color: '#E6A23C', value: 0 },
  { key: 'taken', label: '采购中', color: '#409EFF', value: 0 },
  { key: 'purchased', label: '待收料', color: '#8A6A10', value: 0 },
  { key: 'receiving', label: '收货中', color: '#16A085', value: 0 },
  { key: 'received', label: '已入库', color: '#67C23A', value: 0 }
])

/**
 * 是否显示「采购任务」整块（2026-10-12 用户要求）：
 * 采购任务只针对**配件仓** —— 成品仓的货是车间做的，不需要采购。
 * 所以纯成品仓后台（只辖 chengpin）不该看到这块，连统计请求都不发。
 * ⚠️ 口径统一在 constants/warehouse-scope.js，与侧边栏菜单用的是同一个函数。
 */
const myWarehouseCodes = ref(null)
const showPurchaseTask = computed(() => inPartsScope(myWarehouseCodes.value))

/** 取「我能看的仓库」——只为判定采购任务区块显隐，失败按「不隔离」处理（宁可多显示） */
function applyWarehouseScope(res) {
  myWarehouseCodes.value = resolveWarehouseCodes(
    userStore.userInfo,
    (res && res.data && res.data.list) || []
  )
}

/** 各状态各拉一次 total（只取数字，不取列表）；某状态失败不影响其他 */
async function loadPurchaseStats() {
  if (!showPurchaseTask.value) return
  await Promise.all(
    purchaseStats.value.map(async (s) => {
      try {
        const r = await purchaseApi.list({ status: s.key, page: 1, pageSize: 1 })
        s.value = (r.data && r.data.total) || 0
      } catch (err) {
        s.value = 0
      }
    })
  )
}

/** 点状态卡 → 跳到采购任务页并带上状态筛选 */
function goPurchaseTasks(status) {
  router.push({ path: '/order/purchase-tasks', query: { status } })
}

/**
 * 「最近入库」的金额列是否展示（2026-10-10）：**按数据判断** ——
 * 后端对仓管只脱敏**成品仓**单据，配件仓单据金额保留（采购对账用），
 * 所以配件仓管仍能看到该列，成品仓管看不到（整列无值 → 隐藏）。
 */
const showInboundAmount = computed(() => recentInbound.value.some((r) => r.total_amount != null))

/** 状态文案（V2 出库四阶段：pending/picking/receiving/completed + 驳回/作废） */
function statusText(status) {
  const map = {
    pending: '待确认',
    picking: '待拣货',
    receiving: '待收货',
    completed: '已完成',
    confirmed: '已确认',
    rejected: '已驳回',
    cancelled: '已作废'
  }
  return map[status] || status
}

function statusTagType(status) {
  const map = {
    pending: 'warning',
    picking: 'primary',
    receiving: 'primary',
    completed: 'success',
    confirmed: 'success',
    rejected: 'danger',
    cancelled: 'info'
  }
  return map[status] || 'info'
}

function formatDate(date) {
  return date ? dayjs(date).format('MM-DD HH:mm') : '-'
}

async function loadData() {
  loading.value = true
  try {
    const [overviewRes, warningRes, outRes, inRes, whRes] = await Promise.all([
      statsApi.overview(),
      statsApi.warning({ page: 1, pageSize: 10 }),
      statsApi.orderFlow({ page: 1, pageSize: 5, type: 'outbound' }),
      statsApi.orderFlow({ page: 1, pageSize: 5, type: 'inbound' }),
      // 仓库范围只为判定「采购任务」区块显隐；拿不到（如角色无 warehouse.list）就按不隔离处理
      warehouseApi.list().catch(() => null)
    ])

    stats.value = overviewRes.data || stats.value
    warningList.value = (warningRes.data && warningRes.data.list) || []
    warningTotal.value = (warningRes.data && warningRes.data.total) || 0
    recentOutbound.value = (outRes.data && outRes.data.list) || []
    recentInbound.value = (inRes.data && inRes.data.list) || []
    applyWarehouseScope(whRes)
    // 采购任务状态统计独立加载，失败不影响看板主数据
    loadPurchaseStats()
  } catch (err) {
    ElMessage.error(err.message || '加载数据失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
})

const statCards = computed(() => [
  {
    // 命名统一（来自 4 角色使用者测试 P2-1-06）：
    // 这个值口径是「单数」，原来只写"今日出库"，老板误以为是出库数量；
    // 金额口径全站统一叫「库存价值」（台账/仓库对比/物料列表都是这个词）。
    title: '今日出库单数',
    value: stats.value.today_outbound_orders || 0,
    icon: Download,
    color: '#e74c3c'
  },
  {
    title: '今日入库单数',
    value: stats.value.today_inbound_orders || 0,
    icon: Upload,
    color: '#27ae60'
  },
  {
    title: '库存总量',
    value: stats.value.total_stock || 0,
    icon: Box,
    color: '#3498db'
  },
  // 库存价值：仓管端不展示（2026-10-10，后端 stats.overview 已对仓管脱敏）
  ...(canSeeCost.value
    ? [{
        title: '库存价值',
        value: '¥' + Number(stats.value.total_value || 0).toLocaleString(),
        icon: TrendCharts,
        color: '#8A6A10'
      }]
    : []),
  {
    title: '预警物料',
    value: stats.value.warning_count || 0,
    icon: Warning,
    color: '#f39c12'
  }
])
</script>

<style scoped>
.dashboard {
  padding: 0;
}

.stat-cards {
  margin-bottom: 20px;
}

.stat-card {
  display: flex;
  align-items: center;
  border-radius: 12px;
  border: none;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  margin-bottom: 12px;
}

.stat-card :deep(.el-card__body) {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
}

.stat-icon {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.stat-info {
  flex: 1;
}

.stat-value {
  font-size: 24px;
  font-weight: bold;
  color: #1a1a2e;
  margin-bottom: 4px;
}

.stat-title {
  font-size: 13px;
  color: #999;
}

.quick-actions {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.warning-title {
  color: #f39c12;
}

.action-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.pending-list {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

/* 采购任务状态卡：横排五格，点哪格跳哪个状态 */
.purchase-stat-row {
  display: flex;
  gap: 12px;
}

.purchase-stat-item {
  flex: 1;
  background: #f7f8fa;
  border-radius: 8px;
  padding: 16px 10px;
  text-align: center;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.purchase-stat-item:hover {
  transform: translateY(-2px);
}

.purchase-stat-num {
  font-size: 26px;
  font-weight: bold;
  line-height: 1.2;
}

.purchase-stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}

.danger-text {
  color: #e74c3c;
  font-weight: bold;
}

.recent-orders {
  margin-bottom: 20px;
}
</style>
