<template>
  <div class="check-list">
    <el-card class="search-card">
      <el-form :inline="true" :model="searchForm">
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable>
            <el-option label="待盘点" value="pending" />
            <el-option label="盘点中" value="in_progress" />
            <el-option label="待审核" value="pending_review" />
            <el-option label="已完成" value="completed" />
            <el-option label="已取消" value="cancelled" />
          </el-select>
        </el-form-item>
        <el-form-item label="仓库">
          <el-select v-model="searchForm.warehouse_id" placeholder="全部仓库" clearable>
            <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">搜索</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" :loading="exporting" @click="handleExport">导出 CSV</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <template #header>
        <div class="card-header">
          <span>盘点任务列表</span>
          <el-button type="primary" size="small" @click="$router.push('/check/create')">
            <el-icon><Plus /></el-icon>创建盘点
          </el-button>
        </div>
      </template>

      <el-table :data="checkList" style="width: 100%" v-loading="loading">
        <el-table-column prop="check_no" label="盘点单号" width="180" />
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            {{ typeText(row.type) }}
          </template>
        </el-table-column>
        <el-table-column prop="warehouse_name" label="仓库" width="100" />
        <el-table-column label="盘点范围" min-width="160">
          <template #default="{ row }">
            {{ scopeText(row.scope) }}
          </template>
        </el-table-column>
        <el-table-column label="明细进度" width="140">
          <template #default="{ row }">
            {{ row.checked_count || 0 }} / {{ row.item_count || 0 }}
            <el-tag v-if="row.diff_count" type="danger" size="small" style="margin-left: 6px">
              差异 {{ row.diff_count }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="freeze_stock" label="冻结库存" width="100">
          <template #default="{ row }">
            <el-tag :type="row.freeze_stock ? 'danger' : 'info'" size="small">
              {{ row.freeze_stock ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ statusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="operator_name" label="创建人" width="100" />
        <el-table-column prop="created_at" label="创建时间" width="150">
          <template #default="{ row }">
            {{ formatDate(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click="handleView(row)">
              {{ row.status === 'pending' || row.status === 'in_progress' ? '录入' : '查看' }}
            </el-button>
            <el-button
              v-if="row.status === 'pending_review'"
              type="success"
              size="small"
              @click="handleView(row, true)"
            >
              审核
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
        @size-change="loadChecks"
        @current-change="loadChecks"
      />
    </el-card>

    <!-- 盘点详情 / 录入 -->
    <el-drawer v-model="detailVisible" :title="`盘点单 ${detail.check_no || ''}`" size="760px">
      <el-descriptions :column="2" border v-if="detail._id">
        <el-descriptions-item label="类型">{{ typeText(detail.type) }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ statusText(detail.status) }}</el-descriptions-item>
        <el-descriptions-item label="仓库">{{ detail.warehouse_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建人">{{ detail.operator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="审核人">{{ detail.reviewer_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatDate(detail.created_at) }}</el-descriptions-item>
        <el-descriptions-item label="已盘/总数" :span="2">
          {{ detail.summary ? detail.summary.checked : 0 }} / {{ detail.summary ? detail.summary.total : 0 }}
          （差异 {{ detail.summary ? detail.summary.diff : 0 }} 项）
        </el-descriptions-item>
      </el-descriptions>

      <el-table :data="detail.items || []" style="width: 100%; margin-top: 16px" max-height="440">
        <el-table-column prop="material_name" label="物料名称" min-width="140" />
        <el-table-column prop="material_spec" label="规格" width="110" />
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column prop="book_stock" label="账面库存" width="100" />
        <el-table-column label="实际库存" width="150">
          <template #default="{ row }">
            <el-input-number
              v-if="editable"
              v-model="row.actual_stock"
              :min="0"
              :precision="3"
              size="small"
              controls-position="right"
              style="width: 130px"
            />
            <span v-else>{{ row.actual_stock === null || row.actual_stock === undefined ? '-' : row.actual_stock }}</span>
          </template>
        </el-table-column>
        <el-table-column label="差异" width="100">
          <template #default="{ row }">
            <span v-if="row.actual_stock === null || row.actual_stock === undefined">-</span>
            <span
              v-else
              :class="diffOf(row) > 0 ? 'plus-text' : diffOf(row) < 0 ? 'danger-text' : ''"
            >
              {{ diffOf(row) > 0 ? '+' : '' }}{{ diffOf(row) }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <div class="drawer-footer">
          <el-button @click="detailVisible = false">关闭</el-button>

          <el-button
            v-if="editable"
            type="primary"
            :loading="submitting"
            @click="handleSubmitCheck"
          >
            提交盘点结果
          </el-button>

          <template v-if="detail.status === 'pending_review'">
            <el-button type="danger" :loading="submitting" @click="handleReview(false)">退回重盘</el-button>
            <el-button type="success" :loading="submitting" @click="handleReview(true)">审核通过并调账</el-button>
          </template>

          <el-button
            v-if="detail.status && !['completed', 'cancelled'].includes(detail.status)"
            type="warning"
            :loading="submitting"
            @click="handleCancelTask"
          >
            取消任务
          </el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { checkApi, warehouseApi, exportApi } from '@/api'

const loading = ref(false)
const submitting = ref(false)
const exporting = ref(false)
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)

const searchForm = ref({ status: '', warehouse_id: '' })

const checkList = ref([])
const warehouses = ref([])

const detailVisible = ref(false)
const detail = ref({})

/** 只有待盘点/盘点中的任务才允许录入 */
const editable = computed(() => ['pending', 'in_progress'].includes(detail.value.status))

function typeText(type) {
  const map = { full: '全盘', sample: '抽盘', partial: '抽盘', cycle: '循环盘点' }
  return map[type] || type
}

function scopeText(scope) {
  if (!scope || (!scope.categories?.length && !scope.material_ids?.length)) return '全部物料'
  if (scope.categories?.length) return `分类: ${scope.categories.join('、')}`
  return `指定 ${scope.material_ids.length} 项`
}

function statusText(status) {
  const map = {
    pending: '待盘点',
    in_progress: '盘点中',
    pending_review: '待审核',
    completed: '已完成',
    cancelled: '已取消'
  }
  return map[status] || status
}

function statusTagType(status) {
  const map = {
    pending: 'warning',
    in_progress: 'primary',
    pending_review: 'danger',
    completed: 'success',
    cancelled: 'info'
  }
  return map[status] || 'info'
}

function formatDate(date) {
  return date ? dayjs(date).format('MM-DD HH:mm') : '-'
}

/** 录入过程中实时计算差异 */
function diffOf(row) {
  const book = Number(row.book_stock || 0)
  const actual = Number(row.actual_stock || 0)
  return Number((actual - book).toFixed(3))
}

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
  } catch (err) {
    console.warn('加载仓库失败:', err.message)
  }
}

async function loadChecks() {
  loading.value = true
  try {
    const res = await checkApi.list({
      page: page.value,
      pageSize: pageSize.value,
      status: searchForm.value.status || undefined,
      warehouse_id: searchForm.value.warehouse_id || undefined
    })
    checkList.value = (res.data && res.data.list) || []
    total.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载盘点任务失败')
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  loadChecks()
}

function resetSearch() {
  searchForm.value = { status: '', warehouse_id: '' }
  page.value = 1
  loadChecks()
}

async function handleExport() {
  exporting.value = true
  try {
    const r = await exportApi.csv({
      module: 'check',
      action: 'list',
      params: {
        status: searchForm.value.status || undefined,
        warehouse_id: searchForm.value.warehouse_id || undefined
      },
      filename: `盘点任务_${dayjs().format('YYYYMMDD_HHmm')}.csv`,
      columns: [
        'check_no', 'type', 'warehouse_name', 'status', 'freeze_stock',
        'item_count', 'checked_count', 'diff_count', 'operator_name', 'created_at'
      ]
    })
    ElMessage.success(`已导出 ${r.count} 条`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

async function handleView(row, forReview = false) {
  try {
    const res = await checkApi.detail({ id: row._id })
    const data = res.data || {}
    // 未录入的项留空，由盘点人实际清点后填写（提交时只提交已填写的项）
    data.items = (data.items || []).map((it) => ({
      ...it,
      actual_stock: it.actual_stock === null || it.actual_stock === undefined
        ? null
        : Number(it.actual_stock)
    }))
    detail.value = data
    detailVisible.value = true
    if (forReview) {
      ElMessage.info('请核对差异后点击「审核通过并调账」')
    }
  } catch (err) {
    ElMessage.error(err.message || '加载盘点详情失败')
  }
}

async function handleSubmitCheck() {
  const items = (detail.value.items || [])
    .filter((it) => it.actual_stock !== null && it.actual_stock !== undefined && it.actual_stock !== '')
    .map((it) => ({ material_id: it.material_id, actual_stock: Number(it.actual_stock) }))

  if (!items.length) {
    ElMessage.warning('请至少录入一项实际库存')
    return
  }

  submitting.value = true
  try {
    const res = await checkApi.submit({ id: detail.value._id, items })
    ElMessage.success(res.message || '盘点结果已提交')
    detailVisible.value = false
    loadChecks()
  } catch (err) {
    ElMessage.error(err.message || '提交失败')
  } finally {
    submitting.value = false
  }
}

async function handleReview(approve) {
  try {
    await ElMessageBox.confirm(
      approve
        ? '审核通过后将按差异调整库存，是否继续？'
        : '确定退回该盘点任务，让其重新盘点吗？',
      '提示',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
    const res = await checkApi.review({ id: detail.value._id, approve })
    ElMessage.success(res.message || '操作成功')
    detailVisible.value = false
    loadChecks()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '审核失败')
    }
  }
}

async function handleCancelTask() {
  try {
    await ElMessageBox.confirm('确定取消该盘点任务吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await checkApi.cancel({ id: detail.value._id })
    ElMessage.success('盘点任务已取消')
    detailVisible.value = false
    loadChecks()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '取消失败')
    }
  }
}

onMounted(() => {
  loadWarehouses()
  loadChecks()
})
</script>

<style scoped>
.check-list {
  padding: 0;
}

.search-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
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
