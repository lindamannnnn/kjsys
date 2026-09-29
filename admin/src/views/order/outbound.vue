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
            <el-option label="已确认" value="confirmed" />
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
        <el-table-column label="操作" width="230" fixed="right">
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
              v-if="row.status === 'pending'"
              type="danger"
              size="small"
              @click="handleReject(row)"
            >
              驳回
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
    <el-dialog v-model="detailVisible" title="出库单详情" width="720px">
      <el-descriptions :column="2" border v-if="detail._id">
        <el-descriptions-item label="单号">{{ detail.order_no }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ statusText(detail.status) }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ typeText(detail.type) }}</el-descriptions-item>
        <el-descriptions-item label="仓库">{{ detail.warehouse_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="操作员">{{ detail.operator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatDate(detail.created_at) }}</el-descriptions-item>
        <el-descriptions-item label="确认人">{{ detail.confirm_operator_name || '-' }}</el-descriptions-item>
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
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { outboundApi, warehouseApi, exportApi } from '@/api'

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
    ElMessage.success('确认成功')
    loadOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '确认失败')
    }
  }
}

async function handleReject(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `确定驳回收库单「${row.order_no}」吗？驳回后库存将回补。`,
      '驳回出库单',
      {
        confirmButtonText: '确定驳回',
        cancelButtonText: '取消',
        inputPlaceholder: '请输入驳回原因',
        inputValidator: (v) => (v && v.trim()) || '请填写驳回原因'
      }
    )
    await outboundApi.reject({ id: row._id, reason: value })
    ElMessage.success('已驳回，库存已回补')
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
      `撤销出库单「${row.order_no}」后，已扣的库存会回补。请填写作废原因：`,
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
    ElMessage.success('撤销成功，库存已回补')
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
