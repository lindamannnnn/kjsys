<template>
  <div class="order-outbound">
    <el-card class="search-card">
      <el-form :inline="true" :model="searchForm">
        <el-form-item label="单号">
          <el-input v-model="searchForm.keyword" placeholder="搜索单号" clearable />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable>
            <el-option label="待确认" value="pending" />
            <el-option label="待拣货" value="picking" />
            <el-option label="待收货" value="receiving" />
            <el-option label="已完成" value="completed" />
            <el-option label="已驳回" value="rejected" />
            <el-option label="已作废" value="cancelled" />
          </el-select>
        </el-form-item>
        <el-form-item label="仓库">
          <el-select v-model="searchForm.warehouse_id" placeholder="全部仓库" clearable>
            <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">搜索</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" :loading="exporting" @click="handleExport">导出 CSV</el-button>
          <!-- 新建出库单：厂长（成品仓出库）与管理员；仓管在小程序里也没有这个入口 -->
          <el-button
            v-if="canCreate"
            type="warning"
            @click="$router.push('/order/outbound-create')"
          >新建出库单</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="table-card">
      <el-table :data="orderList" style="width: 100%" v-loading="loading">
        <el-table-column prop="order_no" label="单号" width="180" />
        <el-table-column label="物料明细" min-width="220">
          <template #default="{ row }">
            <span>{{ itemsSummary(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="总数量" width="100" sortable :sort-by="(row) => totalQty(row)">
          <template #default="{ row }">
            {{ totalQty(row) }}
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="typeTagType(row.type)" size="small">
              {{ typeText(row.type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="warehouse_name" label="仓库" width="100" />
        <el-table-column prop="operator_name" label="操作员" width="100" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ statusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="150">
          <template #default="{ row }">
            {{ formatDate(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="handleView(row)">查看</el-button>
            <el-button
              v-if="row.status === 'pending' && canConfirmRole"
              type="success"
              size="small"
              @click="handleConfirm(row)"
            >
              确认
            </el-button>
            <el-button
              v-if="row.status === 'picking' && canConfirmRole"
              type="primary"
              size="small"
              @click="handlePickDone(row)"
            >
              拣货完成
            </el-button>
            <el-button
              v-if="row.status === 'receiving' && canReceiveRole"
              type="success"
              size="small"
              @click="handleReceive(row)"
            >
              代确认收货
            </el-button>
            <el-button
              v-if="canReject(row)"
              type="danger"
              size="small"
              @click="handleReject(row)"
            >
              驳回
            </el-button>
            <el-button
              v-if="canCancel(row)"
              type="warning"
              size="small"
              @click="handleCancel(row)"
            >
              撤销
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        class="pagination"
        @size-change="loadOrders"
        @current-change="loadOrders"
      />
    </el-card>

    <!-- 单据详情 -->
    <el-dialog v-model="detailVisible" title="出库单详情" width="720px">
      <el-descriptions :column="2" border v-if="detail._id">
        <el-descriptions-item label="单号">{{ detail.order_no }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ statusText(detail.status) }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ typeText(detail.type) }}</el-descriptions-item>
        <el-descriptions-item label="仓库">{{ detail.warehouse_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="操作员">{{ detail.operator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatDate(detail.created_at) }}</el-descriptions-item>
        <el-descriptions-item label="确认人">{{ detail.confirm_operator_name || '-' }}</el-descriptions-item>
        <!-- V2 四阶段：拣货、收货各自留痕，否则出了事查不到是谁经手的 -->
        <el-descriptions-item label="拣货人">{{ detail.pick_operator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="拣货时间">{{ formatFull(detail.picked_at) }}</el-descriptions-item>
        <el-descriptions-item label="收货人">{{ detail.receive_operator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="收货时间">{{ formatFull(detail.received_at) }}</el-descriptions-item>
        <el-descriptions-item label="库存扣减">
          <el-tag :type="Number(detail.stock_deducted) === 1 ? 'success' : 'info'" size="small">
            {{ Number(detail.stock_deducted) === 1 ? '已扣减' : '未扣减' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="驳回原因">{{ detail.reject_reason || '-' }}</el-descriptions-item>
        <!-- 追责链要完整：提交人/确认人/驳回人都有，不能缺作废人（王总 P2-3-06） -->
        <el-descriptions-item label="作废人">{{ detail.cancel_operator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="作废原因">{{ detail.cancel_reason || '-' }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="2">{{ detail.remark || '-' }}</el-descriptions-item>
      </el-descriptions>

      <el-table :data="detail.items || []" style="width: 100%; margin-top: 16px">
        <el-table-column type="index" label="#" width="60" />
        <el-table-column prop="material_name" label="物料名称" />
        <el-table-column prop="material_spec" label="规格" />
        <el-table-column prop="quantity" label="数量" width="100" />
        <el-table-column prop="unit" label="单位" width="80" />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { outboundApi, warehouseApi, exportApi } from '@/api'
import { useUserStore } from '@/store/user'
import { allowsWarehouse } from '@/constants/warehouse-scope'

const userStore = useUserStore()

/* ---------- 按角色显隐操作按钮（后端才是防线，这里只管「别让人点了才发现 403」） ---------- */
function has(...names) {
  const roles = userStore.roles || []
  return names.some((n) => roles.includes(n))
}
/** 与后端 middleware/auth.js 的 operatorOf / identityOf 同口径：openid 优先，后台账号用 username */
function myIdentity() {
  const u = userStore.userInfo || {}
  return u.openid || u.username || ''
}
// 确认 / 拣货完成：只给仓管与管理员
const canConfirmRole = computed(() => has('storekeeper', 'admin'))
// 代确认收货：领料员/采购/仓管/管理员/厂长都可以（厂长发起成品仓出库后由他确认）
const canReceiveRole = computed(() => has('out', 'purchase', 'storekeeper', 'admin', 'director'))
// 新建出库单：厂长（成品仓出库）+ 管理员 + 成品仓管（2026-10-20 用户要求开入口）
// ⚠️ 配件仓管同样是 storekeeper，但该页声明了 warehouseCode=chengpin，他点进去会被路由弹回，
//    所以这里也按「管不管成品仓」再挡一次，别让人点了才发现进不去。
const canCreate = computed(() =>
  has('admin', 'director') || (has('storekeeper') && allowsWarehouse('chengpin')))

const loading = ref(false)
const exporting = ref(false)
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const dateRange = ref([])

const searchForm = ref({
  keyword: '',
  status: '',
  warehouse_id: ''
})

const orderList = ref([])
const warehouses = ref([])

const detailVisible = ref(false)
const detail = ref({})

function typeText(type) {
  const map = {
    lingyong: '领用',
    xiaoshou: '销售',
    baofei: '报废',
    zengpin: '赠品',
    repair: '维修',
    tiaozheng: '调整'
  }
  return map[type] || type || '-'
}

function typeTagType(type) {
  const map = {
    lingyong: 'primary',
    xiaoshou: 'success',
    baofei: 'danger',
    zengpin: 'warning',
    repair: 'info',
    tiaozheng: 'info'
  }
  return map[type] || 'info'
}

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

/** 详情里带年份，跨年单据不至于看错 */
function formatFull(date) {
  return date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-'
}

/** 驳回：待确认 / 待拣货 / 待收货 三个状态都能驳回（这三个状态下库存还没扣，不必回补） */
function canReject(row) {
  // outbound.reject 只放行 仓管/管理员 —— 老板、采购、厂长看到按钮点了就是 403
  if (!has('storekeeper', 'admin')) return false
  return ['pending', 'picking', 'receiving'].includes(row.status)
}

/** 撤销：进行中都能撤；已完成只有管理员能撤（撤了库存得回补） */
function canCancel(row) {
  const isAdmin = has('admin')
  const isStorekeeper = has('storekeeper')
  const isOwner = !!row.operator_openid && row.operator_openid === myIdentity()

  // ⚠️ 这里必须和后端 outbound.cancel 的分档一一对应（那边没有 roleRules 条目，
  //    唯一防线就是它内部那几个 if），否则按钮会「点得动但永远 403」：
  //      pending   → 本人 或 管理员
  //      picking   → 本人 或 仓管 或 管理员
  //      receiving → 仓管 或 管理员（货已在交接，提交人不能自己撤）
  //      completed → 仅管理员（会回补库存，属账目调整）
  switch (row.status) {
    case 'pending':
      return isOwner || isAdmin
    case 'picking':
      return isOwner || isStorekeeper || isAdmin
    case 'receiving':
      return isStorekeeper || isAdmin
    case 'completed':
      return isAdmin
    default:
      return false
  }
}

/** 一单含多个物料，列表页做聚合展示 */
function itemsSummary(row) {
  const items = row.items || []
  if (!items.length) return '-'
  return items.map((i) => `${i.material_name}×${i.quantity}`).join('、')
}

function totalQty(row) {
  return (row.items || []).reduce((s, i) => s + Number(i.quantity || 0), 0)
}

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
  } catch (err) {
    console.warn('加载仓库失败:', err.message)
  }
}

async function loadOrders() {
  loading.value = true
  try {
    const params = {
      page: page.value,
      pageSize: pageSize.value,
      keyword: searchForm.value.keyword || undefined,
      status: searchForm.value.status || undefined,
      warehouse_id: searchForm.value.warehouse_id || undefined
    }
    if (dateRange.value && dateRange.value.length === 2) {
      params.startDate = dateRange.value[0]
      params.endDate = dateRange.value[1]
    }

    const res = await outboundApi.list(params)
    orderList.value = (res.data && res.data.list) || []
    total.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载出库单失败')
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  loadOrders()
}

function resetSearch() {
  searchForm.value = { keyword: '', status: '', warehouse_id: '' }
  dateRange.value = []
  page.value = 1
  loadOrders()
}

async function handleExport() {
  exporting.value = true
  try {
    const params = {
      keyword: searchForm.value.keyword || undefined,
      status: searchForm.value.status || undefined,
      warehouse_id: searchForm.value.warehouse_id || undefined
    }
    if (dateRange.value && dateRange.value.length === 2) {
      params.startDate = dateRange.value[0]
      params.endDate = dateRange.value[1]
    }
    const r = await exportApi.csv({
      module: 'outbound',
      action: 'list',
      params,
      filename: `出库单_${dayjs().format('YYYYMMDD_HHmm')}.csv`,
      // 按明细拆行：一张单含几项物料就导出几行，对账时物料级信息不丢
      transform: (row) => {
        const items = row.items || []
        const base = {
          order_no: row.order_no,
          type_text: typeText(row.type),
          warehouse_name: row.warehouse_name || '',
          operator_name: row.operator_name || '',
          status_text: statusText(row.status),
          created_at: row.created_at,
          confirm_operator_name: row.confirm_operator_name || '',
          cancel_operator_name: row.cancel_operator_name || '',
          cancel_reason: row.cancel_reason || '',
          remark: row.remark || ''
        }
        if (!items.length) {
          return [{ ...base, material_name: '', material_spec: '', quantity: '', unit: '' }]
        }
        return items.map((it) => ({
          ...base,
          material_name: it.material_name,
          material_spec: it.material_spec || '',
          quantity: it.quantity,
          unit: it.unit || ''
        }))
      },
      columns: [
        'order_no', 'type_text', 'warehouse_name', 'operator_name', 'status_text',
        'material_name', 'material_spec', 'quantity', 'unit',
        'created_at', 'confirm_operator_name', 'cancel_operator_name', 'cancel_reason', 'remark'
      ]
    })
    ElMessage.success(`已导出 ${r.count} 行（含明细）`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

async function handleView(row) {
  try {
    const res = await outboundApi.detail({ id: row._id })
    detail.value = res.data || {}
    detailVisible.value = true
  } catch (err) {
    ElMessage.error(err.message || '加载详情失败')
  }
}

async function handleConfirm(row) {
  try {
    await ElMessageBox.confirm(`确定确认出库单「${row.order_no}」吗？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await outboundApi.confirm({ id: row._id })
    ElMessage.success('确认成功，已进入待拣货')
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '确认失败')
    }
  }
}

/** 仓管拣完货 → 待收货，并通知领料员来收 */
async function handlePickDone(row) {
  try {
    await ElMessageBox.confirm(
      `确认出库单「${row.order_no}」已拣货完成？确认后会通知领料员来收货。`,
      '拣货完成',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
    await outboundApi.pickDone({ id: row._id })
    ElMessage.success('已标记拣货完成，已通知领料员收货')
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '操作失败')
    }
  }
}

/** 代领料员确认收货 —— 整个流程只有这一步真正扣库存 */
async function handleReceive(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `代「${row.operator_name || '领料员'}」确认已收到出库单「${row.order_no}」的物料？确认后库存才会真正扣减，且不能再驳回。请填写代收说明：`,
      '代确认收货',
      {
        confirmButtonText: '确认收货并扣减库存',
        cancelButtonText: '取消',
        type: 'warning',
        inputPlaceholder: '例如：领料员本人已签字，由仓管代录',
        inputValidator: (v) => (v && v.trim() ? true : '请填写代收说明，方便事后追查')
      }
    )
    await outboundApi.receive({ id: row._id })
    ElMessage.success(`已完成收货，库存已扣减（代收说明：${String(value).trim()}）`)
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '收货失败')
    }
  }
}

async function handleReject(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `确定驳回出库单「${row.order_no}」吗？驳回后领料员可修改重新提交；该单若已扣过库存会自动回补。`,
      '驳回出库单',
      {
        confirmButtonText: '确定驳回',
        cancelButtonText: '取消',
        inputPlaceholder: '请输入驳回原因',
        inputValidator: (v) => (v && v.trim()) || '请填写驳回原因'
      }
    )
    await outboundApi.reject({ id: row._id, reason: value })
    ElMessage.success('已驳回')
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '驳回失败')
    }
  }
}

async function handleCancel(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `撤销出库单「${row.order_no}」后不可恢复；该单若已扣过库存会自动回补。请填写作废原因：`,
      '撤销出库单',
      {
        confirmButtonText: '确认撤销',
        cancelButtonText: '取消',
        type: 'warning',
        inputPlaceholder: '例如：车间报错数量，需重新开单',
        inputValidator: (v) => (v && v.trim() ? true : '请填写原因，方便事后追查')
      }
    )
    await outboundApi.cancel({ id: row._id, reason: String(value || '').trim() })
    ElMessage.success('撤销成功')
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '撤销失败')
    }
  }
}

onMounted(() => {
  loadWarehouses()
  loadOrders()
})
</script>

<style scoped>
.order-outbound {
  padding: 0;
}

.search-card {
  margin-bottom: 20px;
}

.table-card {
  margin-bottom: 20px;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}
</style>
