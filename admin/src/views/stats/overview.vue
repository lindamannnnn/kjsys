<template>
  <div class="stats-overview">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>出入库统计</span>
          <el-radio-group v-if="canTrend" v-model="days" size="small" @change="loadTrend">
            <el-radio-button :value="7">近 7 天</el-radio-button>
            <el-radio-button :value="30">近 30 天</el-radio-button>
            <el-radio-button :value="90">近 90 天</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <el-row v-if="canTrend" :gutter="20" v-loading="trendLoading">
        <el-col :span="12">
          <el-card shadow="never">
            <template #header>出库统计</template>
            <div class="stat-value">{{ outboundSum.orders }} 单</div>
            <div class="stat-detail">总数量: {{ outboundSum.qty }}</div>
          </el-card>
        </el-col>
        <el-col :span="12">
          <el-card shadow="never">
            <template #header>入库统计</template>
            <div class="stat-value">{{ inboundSum.orders }} 单</div>
            <div class="stat-detail">总金额: ¥{{ inboundSum.amount.toLocaleString() }}</div>
          </el-card>
        </el-col>
      </el-row>

      <div v-if="!canTrend" class="trend-tip">
        趋势汇总（出库/入库单数与金额）只有管理员能看。下面可以查你要的：单据流水、库存台账、仓库对比。
      </div>
    </el-card>

    <el-card class="tab-card">
      <el-tabs v-model="activeTab">
        <!-- 趋势明细（仅管理员：stats.trend 只放行 admin） -->
        <el-tab-pane label="出入库趋势" name="trend" v-if="canTrend">
          <el-table :data="trendList" style="width: 100%" v-loading="trendLoading">
            <el-table-column prop="date" label="日期" width="140" />
            <el-table-column prop="outbound_orders" label="出库单数" sortable />
            <el-table-column prop="outbound_qty" label="出库数量" sortable />
            <el-table-column prop="inbound_orders" label="入库单数" sortable />
            <el-table-column prop="inbound_amount" label="入库金额" sortable>
              <template #default="{ row }">
                ¥{{ Number(row.inbound_amount || 0).toLocaleString() }}
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 单据流水 -->
        <el-tab-pane label="单据流水" name="orderFlow">
          <el-form :inline="true" class="filter-form">
            <el-form-item label="类型">
              <el-select v-model="flowQuery.type" placeholder="全部" clearable style="width: 120px">
                <el-option label="出库" value="outbound" />
                <el-option label="入库" value="inbound" />
              </el-select>
            </el-form-item>
            <el-form-item label="状态">
              <el-select v-model="flowQuery.status" placeholder="全部" clearable style="width: 120px">
                <el-option label="待确认" value="pending" />
                <el-option label="待拣货" value="picking" />
                <el-option label="待收货" value="receiving" />
                <el-option label="已完成" value="completed" />
                <el-option label="已驳回" value="rejected" />
                <el-option label="已作废" value="cancelled" />
              </el-select>
            </el-form-item>
            <el-form-item label="操作员">
              <el-input v-model="flowQuery.operator" placeholder="操作员姓名" clearable style="width: 140px" />
            </el-form-item>
            <el-form-item label="日期">
              <el-date-picker
                v-model="flowRange"
                type="daterange"
                value-format="YYYY-MM-DD"
                range-separator="至"
                start-placeholder="开始日期"
                end-placeholder="结束日期"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="loadOrderFlow">查询</el-button>
              <el-button @click="resetFlowQuery">重置</el-button>
              <el-button type="success" :loading="exporting" @click="exportOrderFlow">导出 CSV</el-button>
            </el-form-item>
          </el-form>

          <el-table :data="flowList" style="width: 100%" v-loading="flowLoading" row-key="rowKey">
            <el-table-column label="类型" width="80">
              <template #default="{ row }">
                <el-tag :type="row.kind === 'outbound' ? 'danger' : 'success'" size="small">
                  {{ row.kind === 'outbound' ? '出库' : '入库' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="order_no" label="单号" width="170" />
            <el-table-column prop="material_names" label="物料" show-overflow-tooltip />
            <el-table-column prop="total_qty" label="数量" width="90" sortable />
            <!-- 金额：仓管端按行脱敏（配件仓入库单保留 / 成品仓不下发），整列无值时收起 -->
            <el-table-column v-if="showFlowAmount" prop="total_amount" label="金额" width="110">
              <template #default="{ row }">
                ¥{{ Number(row.total_amount || 0).toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column prop="warehouse_name" label="仓库" width="100" />
            <el-table-column prop="operator_name" label="操作员" width="100" />
            <el-table-column prop="status" label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="orderStatusTagType(row.status)" size="small">
                  {{ orderStatusText(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="created_at" label="时间" width="150">
              <template #default="{ row }">
                {{ formatDateTime(row.created_at) }}
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="flowPage"
            v-model:page-size="flowPageSize"
            :total="flowTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            class="pagination"
            @size-change="loadOrderFlow"
            @current-change="loadOrderFlow"
          />
        </el-tab-pane>

        <!-- 库存台账 -->
        <el-tab-pane label="库存台账" name="stockList">
          <el-form :inline="true" class="filter-form">
            <el-form-item label="关键词">
              <el-input v-model="stockQuery.keyword" placeholder="物料名称/规格" clearable style="width: 180px" />
            </el-form-item>
            <el-form-item label="分类">
              <el-select v-model="stockQuery.category" placeholder="全部分类" clearable style="width: 160px">
                <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
              </el-select>
            </el-form-item>
            <el-form-item label="仓库">
              <el-select v-model="stockQuery.warehouse_id" placeholder="全部仓库" clearable style="width: 140px">
                <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-checkbox v-model="stockQuery.showWarningOnly">仅看预警</el-checkbox>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="loadStockList">查询</el-button>
              <el-button @click="resetStockQuery">重置</el-button>
              <el-button type="success" :loading="exporting" @click="exportStockList">导出 CSV</el-button>
            </el-form-item>
          </el-form>

          <el-table :data="stockList" style="width: 100%" v-loading="stockLoading">
            <el-table-column prop="name" label="物料名称" min-width="140" />
            <el-table-column prop="spec" label="规格" min-width="100" />
            <el-table-column prop="category" label="分类" width="100" />
            <el-table-column prop="warehouse_name" label="仓库" width="100" />
            <el-table-column prop="unit" label="单位" width="70" />
            <el-table-column prop="current_stock" label="当前库存" width="100" sortable>
              <template #default="{ row }">
                <span :class="{ 'danger-text': Number(row.current_stock) <= Number(row.warning_stock) }">
                  {{ row.current_stock }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="warning_stock" label="预警库存" width="100" />
            <!-- 成本价 / 库存价值：仓管端不展示（后端 stats.stockList 已脱敏） -->
            <el-table-column v-if="canSeeCost" prop="avg_cost" label="成本价" width="100">
              <template #default="{ row }">
                ¥{{ Number(row.avg_cost || 0).toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column v-if="canSeeCost" prop="stock_value" label="库存价值" width="120" sortable>
              <template #default="{ row }">
                ¥{{ Number(row.stock_value || 0).toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }">
                <el-button size="small" @click="openStockFlow(row)">库存流水</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="stockPage"
            v-model:page-size="stockPageSize"
            :total="stockTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            class="pagination"
            @size-change="loadStockList"
            @current-change="loadStockList"
          />
        </el-tab-pane>

        <!-- 仓库对比 -->
        <el-tab-pane label="仓库对比" name="warehouse">
          <div class="export-bar">
            <el-button type="success" size="small" :loading="exporting" @click="exportWarehouse">
              导出 CSV
            </el-button>
          </div>
          <el-table :data="warehouseList" style="width: 100%" v-loading="warehouseLoading">
            <el-table-column prop="code" label="仓库编码" width="140" />
            <el-table-column prop="name" label="仓库名称" />
            <el-table-column prop="material_count" label="物料数" sortable />
            <el-table-column prop="total_stock" label="库存总量" sortable />
            <!-- 库存价值：仓管端不展示（后端 stats.warehouseSummary 已脱敏） -->
            <el-table-column v-if="canSeeCost" prop="total_value" label="库存价值" sortable>
              <template #default="{ row }">
                ¥{{ Number(row.total_value || 0).toLocaleString() }}
              </template>
            </el-table-column>
            <el-table-column prop="warning_count" label="预警物料" sortable />
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 库存流水抽屉 -->
    <el-drawer v-model="flowDrawer" :title="`库存流水 - ${currentMaterial.material_name || ''}`" size="640px">
      <el-table :data="stockFlowList" style="width: 100%" v-loading="stockFlowLoading">
        <el-table-column prop="created_at" label="时间" width="150">
          <template #default="{ row }">
            {{ formatDateTime(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column prop="change_type" label="类型" width="110">
          <template #default="{ row }">
            {{ changeTypeText(row.change_type) }}
          </template>
        </el-table-column>
        <el-table-column prop="change_quantity" label="变动" width="90">
          <template #default="{ row }">
            <span :class="Number(row.change_quantity) >= 0 ? 'plus-text' : 'danger-text'">
              {{ Number(row.change_quantity) >= 0 ? '+' : '' }}{{ row.change_quantity }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="after_stock" label="结存" width="90" />
        <el-table-column prop="related_order_id" label="关联单号" width="160" />
        <el-table-column prop="operator_name" label="操作员" width="100" />
      </el-table>

      <el-pagination
        v-model:current-page="stockFlowPage"
        :page-size="stockFlowPageSize"
        :total="stockFlowTotal"
        layout="total, prev, pager, next"
        class="pagination"
        @current-change="loadStockFlow"
      />
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import {
  statsApi,
  materialApi,
  warehouseApi,
  exportApi
} from '@/api'
import { useUserStore } from '@/store/user'
import { canViewCost } from '@/constants/roles'

const userStore = useUserStore()

/**
 * 「出入库趋势」用的是 stats.trend —— 后端**只放行 admin**（老板/厂长/仓管都没有）。
 * 之前这里是所有人都在跑：非管理员一进来就弹「加载失败」+ 上面两张汇总卡永远是 0，
 * 看着像系统坏了，其实是权限不够。
 * 现在：非 admin 直接不显示趋势汇总与趋势 tab，默认落在「单据流水」（他们有权看）。
 */
const canTrend = computed(() => userStore.hasRole('admin'))

/**
 * 金额是否展示（2026-10-10）：仓管端只看数量、不看钱。
 * ⚠️ 后端已脱敏（stats.stockList / warehouseSummary 对仓管不返回金额），
 *    这里是体验层 —— 免得留下列头却是整列「¥0.00」。
 */
const canSeeCost = computed(() => canViewCost(userStore.roles || []))

const activeTab = ref(canTrend.value ? 'trend' : 'orderFlow')
const exporting = ref(false)

/* ---------------- 趋势 ---------------- */
const days = ref(7)
const trendLoading = ref(false)
const trendList = ref([])

const outboundSum = computed(() =>
  trendList.value.reduce(
    (acc, r) => ({
      orders: acc.orders + Number(r.outbound_orders || 0),
      qty: acc.qty + Number(r.outbound_qty || 0)
    }),
    { orders: 0, qty: 0 }
  )
)

const inboundSum = computed(() =>
  trendList.value.reduce(
    (acc, r) => ({
      orders: acc.orders + Number(r.inbound_orders || 0),
      amount: acc.amount + Number(r.inbound_amount || 0)
    }),
    { orders: 0, amount: 0 }
  )
)

async function loadTrend() {
  trendLoading.value = true
  try {
    const res = await statsApi.trend({ days: days.value })
    trendList.value = (res.data && res.data.list) || []
  } catch (err) {
    ElMessage.error(err.message || '加载趋势失败')
  } finally {
    trendLoading.value = false
  }
}

/* ---------------- 单据流水 ---------------- */
const flowLoading = ref(false)
const flowList = ref([])

/**
 * 单据流水的「金额」列是否展示（2026-10-10）：**按数据判断** ——
 * 后端 orderFlow 对仓管只脱敏成品仓单据，配件仓入库单金额保留（采购对账用），
 * 所以配件仓管仍看得到该列，成品仓管看不到（整列无值 → 隐藏）。
 */
const showFlowAmount = computed(() => flowList.value.some((r) => r.total_amount != null))

const flowTotal = ref(0)
const flowPage = ref(1)
const flowPageSize = ref(10)
const flowRange = ref([])
const flowQuery = ref({ type: '', status: '', operator: '' })

async function loadOrderFlow() {
  flowLoading.value = true
  try {
    const params = {
      page: flowPage.value,
      pageSize: flowPageSize.value,
      type: flowQuery.value.type || undefined,
      status: flowQuery.value.status || undefined,
      operator: flowQuery.value.operator || undefined
    }
    if (flowRange.value && flowRange.value.length === 2) {
      params.startDate = flowRange.value[0]
      params.endDate = flowRange.value[1]
    }
    const res = await statsApi.orderFlow(params)
    // 表格 key 需用 `${kind}-${_id}`，出库/入库可能存在相同 id
    flowList.value = ((res.data && res.data.list) || []).map((r) => ({
      ...r,
      rowKey: `${r.kind}-${r._id}`
    }))
    flowTotal.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载单据流水失败')
  } finally {
    flowLoading.value = false
  }
}

function resetFlowQuery() {
  flowQuery.value = { type: '', status: '', operator: '' }
  flowRange.value = []
  flowPage.value = 1
  loadOrderFlow()
}

async function exportOrderFlow() {
  exporting.value = true
  try {
    const params = {
      type: flowQuery.value.type || undefined,
      status: flowQuery.value.status || undefined,
      operator: flowQuery.value.operator || undefined
    }
    if (flowRange.value && flowRange.value.length === 2) {
      params.startDate = flowRange.value[0]
      params.endDate = flowRange.value[1]
    }
    const r = await exportApi.csv({
      module: 'stats',
      action: 'orderFlow',
      params,
      filename: `单据流水_${dayjs().format('YYYYMMDD_HHmm')}.csv`,
      columns: [
        'kind', 'order_no', 'material_names', 'total_qty',
        // 金额列跟随页面展示逻辑（成品仓管整列无值时一并去掉，免得导出空列）
        ...(canSeeCost.value || showFlowAmount.value ? ['total_amount'] : []),
        'warehouse_name', 'operator_name', 'status', 'created_at'
      ]
    })
    ElMessage.success(`已导出 ${r.count} 条`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

/* ---------------- 库存台账 ---------------- */
const stockLoading = ref(false)
const stockList = ref([])
const stockTotal = ref(0)
const stockPage = ref(1)
const stockPageSize = ref(10)
const stockQuery = ref({ keyword: '', category: '', warehouse_id: '', showWarningOnly: false })

const categories = ref([])
const warehouses = ref([])

async function loadStockList() {
  stockLoading.value = true
  try {
    const res = await statsApi.stockList({
      page: stockPage.value,
      pageSize: stockPageSize.value,
      keyword: stockQuery.value.keyword || undefined,
      category: stockQuery.value.category || undefined,
      warehouse_id: stockQuery.value.warehouse_id || undefined,
      showWarningOnly: stockQuery.value.showWarningOnly || undefined
    })
    stockList.value = (res.data && res.data.list) || []
    stockTotal.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载库存台账失败')
  } finally {
    stockLoading.value = false
  }
}

function resetStockQuery() {
  stockQuery.value = { keyword: '', category: '', warehouse_id: '', showWarningOnly: false }
  stockPage.value = 1
  loadStockList()
}

async function exportStockList() {
  exporting.value = true
  try {
    const r = await exportApi.csv({
      module: 'stats',
      action: 'stockList',
      params: {
        keyword: stockQuery.value.keyword || undefined,
        category: stockQuery.value.category || undefined,
        warehouse_id: stockQuery.value.warehouse_id || undefined,
        showWarningOnly: stockQuery.value.showWarningOnly || undefined
      },
      filename: `库存台账_${dayjs().format('YYYYMMDD_HHmm')}.csv`,
      columns: [
        'name', 'spec', 'category', 'warehouse_name', 'unit',
        'current_stock', 'warning_stock',
        // 成本价 / 库存价值：仓管端不导出（后端 stats.stockList 已脱敏）
        ...(canSeeCost.value ? ['avg_cost', 'stock_value'] : [])
      ]
    })
    ElMessage.success(`已导出 ${r.count} 条`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

/* ---------------- 库存流水 ---------------- */
const flowDrawer = ref(false)
const stockFlowLoading = ref(false)
const stockFlowList = ref([])
const stockFlowTotal = ref(0)
const stockFlowPage = ref(1)
const stockFlowPageSize = ref(20)
const currentMaterial = ref({})

function openStockFlow(row) {
  currentMaterial.value = row
  stockFlowPage.value = 1
  flowDrawer.value = true
  loadStockFlow()
}

async function loadStockFlow() {
  stockFlowLoading.value = true
  try {
    const res = await statsApi.stockFlow({
      material_id: currentMaterial.value._id,
      page: stockFlowPage.value,
      pageSize: stockFlowPageSize.value
    })
    stockFlowList.value = (res.data && res.data.list) || []
    stockFlowTotal.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载库存流水失败')
  } finally {
    stockFlowLoading.value = false
  }
}

function changeTypeText(type) {
  const map = {
    inbound: '入库',
    inbound_cancel: '入库撤销',
    outbound: '出库',
    outbound_cancel: '出库撤销',
    check: '盘点调整',
    check_cancel: '盘点撤销',
    adjust: '手工调整',
    transfer: '调拨'
  }
  return map[type] || type
}

/* ---------------- 仓库对比 ---------------- */
const warehouseLoading = ref(false)
const warehouseList = ref([])

async function loadWarehouseSummary() {
  warehouseLoading.value = true
  try {
    const res = await statsApi.warehouseSummary()
    warehouseList.value = (res.data && res.data.list) || []
  } catch (err) {
    ElMessage.error(err.message || '加载仓库对比失败')
  } finally {
    warehouseLoading.value = false
  }
}

async function exportWarehouse() {
  exporting.value = true
  try {
    const r = await exportApi.csv({
      module: 'stats',
      action: 'warehouseSummary',
      filename: `仓库汇总_${dayjs().format('YYYYMMDD_HHmm')}.csv`,
      // 库存价值：仓管端不导出（后端 stats.warehouseSummary 已脱敏）
      columns: [
        'code', 'name', 'material_count', 'total_stock',
        ...(canSeeCost.value ? ['total_value'] : []),
        'warning_count'
      ]
    })
    ElMessage.success(`已导出 ${r.count} 条`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

/* ---------------- 通用 ---------------- */
function orderStatusText(status) {
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

function orderStatusTagType(status) {
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

function formatDateTime(v) {
  return v ? dayjs(v).format('MM-DD HH:mm') : '-'
}

async function loadBasics() {
  try {
    const [catRes, whRes] = await Promise.all([
      materialApi.categories(),
      warehouseApi.list()
    ])
    categories.value = (catRes.data && catRes.data.list) || []
    warehouses.value = (whRes.data && whRes.data.list) || []
  } catch (err) {
    // 下拉数据失败不阻断页面
    console.warn('加载筛选项失败:', err.message)
  }
}

onMounted(() => {
  // 非管理员不调 stats.trend，免得一进页面就弹 403 的「加载失败」
  if (canTrend.value) loadTrend()
  loadOrderFlow()
  loadStockList()
  loadWarehouseSummary()
  loadBasics()
})
</script>

<style scoped>
.stats-overview {
  padding: 0;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 非管理员看到趋势区被收起来时的说明（不然页面上部会莫名其妙空一块） */
.trend-tip {
  font-size: 13px;
  color: #909399;
  background: #f4f4f5;
  border-radius: 4px;
  padding: 10px 14px;
}

.stat-value {
  font-size: 32px;
  font-weight: bold;
  color: #1a1a2e;
}

.stat-detail {
  font-size: 14px;
  color: #999;
  margin-top: 8px;
}

.tab-card {
  margin-top: 20px;
}

.filter-form {
  margin-bottom: 12px;
}

.export-bar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}

.danger-text {
  color: #e74c3c;
  font-weight: bold;
}

.plus-text {
  color: #27ae60;
  font-weight: bold;
}
</style>
