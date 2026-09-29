<template>
  <div class="order-inbound">
    <el-card class="search-card">
      <el-form :inline="true" :model="searchForm">
        <el-form-item label="单号">
          <el-input v-model="searchForm.keyword" placeholder="搜索单号" clearable />
        </el-form-item>
        <el-form-item label="供应商">
          <el-input v-model="searchForm.supplier" placeholder="搜索供应商" clearable />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable>
            <el-option label="待确认" value="pending" />
            <el-option label="已确认" value="confirmed" />
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
        <el-table-column label="总数量" width="100">
          <template #default="{ row }">
            {{ totalQty(row) }}
          </template>
        </el-table-column>
        <el-table-column prop="total_price" label="总金额" width="120">
          <template #default="{ row }">
            ¥{{ Number(row.total_price || 0).toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="supplier" label="供应商" width="140">
          <template #default="{ row }">
            {{ row.supplier || '-' }}
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
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="handleView(row)">查看</el-button>
            <el-button
              v-if="row.status === 'pending'"
              type="success"
              size="small"
              @click="handleConfirm(row)"
            >
              确认
            </el-button>
            <el-button
              v-if="row.status === 'pending' || row.status === 'confirmed'"
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
    <el-dialog v-model="detailVisible" title="入库单详情" width="760px">
      <el-descriptions :column="2" border v-if="detail._id">
        <el-descriptions-item label="单号">{{ detail.order_no }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ statusText(detail.status) }}</el-descriptions-item>
        <el-descriptions-item label="供应商">{{ detail.supplier || '-' }}</el-descriptions-item>
        <el-descriptions-item label="仓库">{{ detail.warehouse_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="操作员">{{ detail.operator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatDate(detail.created_at) }}</el-descriptions-item>
        <el-descriptions-item label="总金额">¥{{ Number(detail.total_price || 0).toFixed(2) }}</el-descriptions-item>
        <el-descriptions-item label="确认人">{{ detail.confirm_operator_name || '-' }}</el-descriptions-item>
        <!-- 追责链要完整：不能缺作废人（王总 P2-3-06） -->
        <el-descriptions-item label="作废人">{{ detail.cancel_operator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="作废原因">{{ detail.cancel_reason || '-' }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="2">{{ detail.remark || '-' }}</el-descriptions-item>
      </el-descriptions>

      <el-table :data="detail.items || []" style="width: 100%; margin-top: 16px">
        <el-table-column type="index" label="#" width="60" />
        <el-table-column prop="material_name" label="物料名称" />
        <el-table-column prop="material_spec" label="规格" width="110" />
        <el-table-column prop="quantity" label="数量" width="90" />
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column prop="unit_price" label="单价" width="100">
          <template #default="{ row }">
            ¥{{ Number(row.unit_price || 0).toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="total_price" label="小计" width="110">
          <template #default="{ row }">
            ¥{{ Number(row.total_price || 0).toFixed(2) }}
          </template>
        </el-table-column>
      </el-table>

      <template #footer v-if="detail.status === 'pending'">
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="handleUpdatePrice">修改单价</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { inboundApi, warehouseApi, exportApi } from '@/api'

const loading = ref(false)
const exporting = ref(false)
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const dateRange = ref([])

const searchForm = ref({
  keyword: '',
  supplier: '',
  status: '',
  warehouse_id: ''
})

const orderList = ref([])
const warehouses = ref([])

const detailVisible = ref(false)
const detail = ref({})

function statusText(status) {
  const map = {
    pending: '待确认',
    confirmed: '已确认',
    rejected: '已驳回',
    cancelled: '已作废'
  }
  return map[status] || status
}

function statusTagType(status) {
  const map = {
    pending: 'warning',
    confirmed: 'success',
    rejected: 'danger',
    cancelled: 'info'
  }
  return map[status] || 'info'
}

function formatDate(date) {
  return date ? dayjs(date).format('MM-DD HH:mm') : '-'
}

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
      supplier: searchForm.value.supplier || undefined,
      status: searchForm.value.status || undefined,
      warehouse_id: searchForm.value.warehouse_id || undefined
    }
    if (dateRange.value && dateRange.value.length === 2) {
      params.startDate = dateRange.value[0]
      params.endDate = dateRange.value[1]
    }

    const res = await inboundApi.list(params)
    orderList.value = (res.data && res.data.list) || []
    total.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载入库单失败')
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  loadOrders()
}

function resetSearch() {
  searchForm.value = { keyword: '', supplier: '', status: '', warehouse_id: '' }
  dateRange.value = []
  page.value = 1
  loadOrders()
}

async function handleExport() {
  exporting.value = true
  try {
    const params = {
      keyword: searchForm.value.keyword || undefined,
      supplier: searchForm.value.supplier || undefined,
      status: searchForm.value.status || undefined,
      warehouse_id: searchForm.value.warehouse_id || undefined
    }
    if (dateRange.value && dateRange.value.length === 2) {
      params.startDate = dateRange.value[0]
      params.endDate = dateRange.value[1]
    }
    const r = await exportApi.csv({
      module: 'inbound',
      action: 'list',
      params,
      filename: `入库单_${dayjs().format('YYYYMMDD_HHmm')}.csv`,
      // 按明细拆行：采购对账要看每一料的单价与小计，原来只导单头对不上账
      transform: (row) => {
        const items = row.items || []
        const base = {
          order_no: row.order_no,
          supplier: row.supplier || '',
          warehouse_name: row.warehouse_name || '',
          operator_name: row.operator_name || '',
          status_text: statusText(row.status),
          total_price: row.total_price,
          created_at: row.created_at,
          confirm_operator_name: row.confirm_operator_name || '',
          cancel_operator_name: row.cancel_operator_name || '',
          cancel_reason: row.cancel_reason || '',
          remark: row.remark || ''
        }
        if (!items.length) {
          return [{
            ...base,
            material_name: '', material_spec: '', quantity: '', unit: '',
            unit_price: '', line_amount: ''
          }]
        }
        return items.map((it) => ({
          ...base,
          material_name: it.material_name,
          material_spec: it.material_spec || '',
          quantity: it.quantity,
          unit: it.unit || '',
          unit_price: it.unit_price == null ? '' : it.unit_price,
          line_amount: it.total_price == null ? '' : it.total_price
        }))
      },
      columns: [
        'order_no', 'supplier', 'warehouse_name', 'operator_name', 'status_text',
        'material_name', 'material_spec', 'quantity', 'unit', 'unit_price', 'line_amount',
        'total_price', 'created_at', 'confirm_operator_name', 'cancel_operator_name',
        'cancel_reason', 'remark'
      ]
    })
    ElMessage.success(`已导出 ${r.count} 行（含明细与单价）`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

async function handleView(row) {
  try {
    const res = await inboundApi.detail({ id: row._id })
    detail.value = res.data || {}
    detailVisible.value = true
  } catch (err) {
    ElMessage.error(err.message || '加载详情失败')
  }
}

async function handleConfirm(row) {
  try {
    await ElMessageBox.confirm(`确定确认入库单「${row.order_no}」吗？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await inboundApi.confirm({ id: row._id })
    ElMessage.success('确认成功')
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '确认失败')
    }
  }
}

async function handleCancel(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `撤销入库单「${row.order_no}」后，库存会回退。请填写作废原因：`,
      '撤销入库单',
      {
        confirmButtonText: '确认撤销',
        cancelButtonText: '取消',
        type: 'warning',
        inputPlaceholder: '例如：供应商送错货，已退回',
        inputValidator: (v) => (v && v.trim() ? true : '请填写原因，方便事后追查')
      }
    )
    await inboundApi.cancel({ id: row._id, reason: String(value || '').trim() })
    ElMessage.success('撤销成功，库存已回退')
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '撤销失败')
    }
  }
}

async function handleUpdatePrice() {
  try {
    const { value } = await ElMessageBox.prompt(
      '输入新的单价，该单所有明细将统一按此单价重算（仅本人当天未确认单据可改）',
      '修改入库单价',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputPlaceholder: '如 12.50',
        inputValidator: (v) => (v !== '' && Number(v) >= 0) || '请输入有效的单价'
      }
    )
    await inboundApi.updatePrice({ id: detail.value._id, unit_price: Number(value) })
    ElMessage.success('单价已修改')
    detailVisible.value = false
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '修改单价失败')
    }
  }
}

onMounted(() => {
  loadWarehouses()
  loadOrders()
})
</script>

<style scoped>
.order-inbound {
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
