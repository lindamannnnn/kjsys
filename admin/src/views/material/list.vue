<template>
  <div class="material-list">
    <!-- 搜索栏 -->
    <el-card class="search-card">
      <el-form :inline="true" :model="searchForm">
        <el-form-item label="物料名称">
          <el-input
            v-model="searchForm.keyword"
            placeholder="搜索名称/规格/编号（如 A001-7）"
            clearable
          />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="searchForm.category" placeholder="全部分类" clearable filterable>
            <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <!-- 细分类：成品仓叫「车间」，配件仓叫「编号分类」，标签跟着仓库变 -->
        <el-form-item :label="subCategoryLabel">
          <el-select
            v-model="searchForm.sub_category"
            :placeholder="`全部${subCategoryLabel}`"
            clearable
            filterable
            :disabled="!subCategories.length"
          >
            <el-option v-for="s in subCategories" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="仓库">
          <!-- 从「配件仓物料 / 成品仓物料」菜单进来时仓库已锁定，这里只做展示 -->
          <el-tag
            v-if="isLockedWarehouse"
            :type="lockedWarehouse ? 'warning' : 'info'"
            effect="dark"
            class="wh-lock-tag"
          >
            {{ lockedWarehouseLabel }}
          </el-tag>
          <el-select v-else v-model="searchForm.warehouse_id" placeholder="全部仓库" clearable>
            <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="searchForm.showWarningOnly">仅看预警</el-checkbox>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">搜索</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" :loading="exporting" @click="handleExport">导出 CSV</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 物料列表 -->
    <el-card class="table-card">
      <template #header>
        <div class="card-header">
          <span>{{ listTitle }}</span>
          <div>
            <el-button size="small" @click="goImport">
              <el-icon><Upload /></el-icon>批量导入
            </el-button>
            <el-button type="primary" size="small" @click="handleAdd">
              <el-icon><Plus /></el-icon>新增物料
            </el-button>
          </div>
        </div>
      </template>

      <el-table :data="materialList" style="width: 100%" v-loading="loading">
        <!-- 编号只有配件仓有（成品仓按车间分，不编号），锁定成品仓时这一列没意义就藏起来 -->
        <el-table-column
          v-if="showNoColumn"
          prop="material_no"
          label="编号"
          width="90"
          sortable
        />
        <el-table-column prop="name" label="物料名称" min-width="140" />
        <el-table-column prop="spec" label="规格型号" min-width="100" />
        <el-table-column prop="category" label="分类" width="100" />
        <el-table-column prop="sub_category" :label="subCategoryLabel" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.sub_category" size="small" type="info" effect="plain">
              {{ row.sub_category }}
            </el-tag>
            <span v-else class="muted-text">—</span>
          </template>
        </el-table-column>
        <!-- 锁定仓库的页面整页都是同一个仓，仓库列就多余了 -->
        <el-table-column v-if="!isLockedWarehouse" prop="warehouse_name" label="仓库" width="100" />
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column prop="current_stock" label="当前库存" width="100" sortable>
          <template #default="{ row }">
            <span :class="{ 'danger-text': Number(row.current_stock) <= Number(row.warning_stock) }">
              {{ row.current_stock }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="warning_stock" label="预警库存" width="100" />
        <el-table-column prop="avg_cost" label="成本价" width="100">
          <template #default="{ row }">
            ¥{{ Number(row.avg_cost || 0).toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="stock_value" label="库存价值" width="120">
          <template #default="{ row }">
            ¥{{ (Number(row.avg_cost || 0) * Number(row.current_stock || 0)).toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag
              :type="Number(row.current_stock) <= Number(row.warning_stock) ? 'danger' : 'success'"
              size="small"
            >
              {{ Number(row.current_stock) <= Number(row.warning_stock) ? '预警' : '正常' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button type="danger" size="small" @click="handleDelete(row)">删除</el-button>
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
        @size-change="loadMaterials"
        @current-change="loadMaterials"
      />
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Upload } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { materialApi, warehouseApi, exportApi } from '@/api'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const exporting = ref(false)
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)

const searchForm = ref({
  keyword: '',
  category: '',
  sub_category: '',
  warehouse_id: '',
  showWarningOnly: false
})

const materialList = ref([])
const categories = ref([])
const subCategories = ref([])
const warehouses = ref([])

/* ---------------- 两仓分开：由路由 meta 指定要锁定的仓库 ---------------- */
/** 左侧「配件仓物料 / 成品仓物料」菜单进来时，meta 里会带仓库编码；从看板进来的普通列表不带 */
const lockedWarehouseCode = computed(() => route.meta.warehouseCode || '')
const isLockedWarehouse = computed(() => !!lockedWarehouseCode.value)
const lockedWarehouse = computed(() => {
  if (!lockedWarehouseCode.value) return null
  return warehouses.value.find((w) => w.code === lockedWarehouseCode.value) || null
})
/** 仓库名展示：加载中 / 已找到 / 真的没这个仓，三种状态分开，避免闪一下「未找到」 */
const lockedWarehouseLabel = computed(() => {
  if (!isLockedWarehouse.value) return ''
  if (lockedWarehouse.value) return lockedWarehouse.value.name
  return warehouses.value.length ? '仓库未找到' : '加载中…'
})
const listTitle = computed(() => {
  if (isLockedWarehouse.value && lockedWarehouse.value) {
    return `${lockedWarehouse.value.name} · 物料列表`
  }
  return '物料列表'
})
/** 实际查询用的仓库 id：锁定页用锁定的仓，普通页用下拉选的仓 */
const effectiveWarehouseId = computed(() => {
  if (isLockedWarehouse.value) return lockedWarehouse.value ? lockedWarehouse.value._id : ''
  return searchForm.value.warehouse_id || ''
})

/** 实际查询用的仓库编码（决定细分类叫什么） */
const effectiveWarehouseCode = computed(() => {
  if (lockedWarehouseCode.value) return lockedWarehouseCode.value
  const id = searchForm.value.warehouse_id
  if (!id) return ''
  const w = warehouses.value.find((x) => Number(x._id) === Number(id))
  return w ? w.code : ''
})

/**
 * 细分类的叫法跟着仓库走：
 *   成品仓 → 车间       （节能炉车间 / 工程车间 / 西厨车间）
 *   配件仓 → 编号分类   （A001 板材型材 / B004 阀件铜件 …）
 */
const subCategoryLabel = computed(() => {
  if (effectiveWarehouseCode.value === 'chengpin') return '车间'
  if (effectiveWarehouseCode.value === 'peijian') return '编号分类'
  return '细分类'
})

/** 成品仓不显示编号列（它按车间分，本来就没编号） */
const showNoColumn = computed(() => effectiveWarehouseCode.value !== 'chengpin')

/** 导出文件名：锁定仓时带上仓库名，免得两个仓导出的文件分不清 */
const exportFileName = computed(() => {
  const prefix = isLockedWarehouse.value && lockedWarehouse.value
    ? `${lockedWarehouse.value.name}_`
    : ''
  return `${prefix}物料列表_${dayjs().format('YYYYMMDD_HHmm')}.csv`
})

/** 导出表头：细分类那一列跟着仓库叫「车间」或「编号分类」 */
const exportHeaders = computed(() => [
  '编号', '物料名称', '规格型号', '分类', subCategoryLabel.value, '仓库',
  '单位', '当前库存', '预警库存', '成本价', '备注'
])

/** 当前页面对应的仓库编码，用于新增/导入时带过去 */
function currentWarehouseCode() {
  if (lockedWarehouseCode.value) return lockedWarehouseCode.value
  const id = searchForm.value.warehouse_id
  if (!id) return ''
  const w = warehouses.value.find((x) => Number(x._id) === Number(id))
  return w ? w.code : ''
}

/** 把仓库编码并进 query，保证新增/导入完能回到对应的仓库列表 */
function withWarehouseQuery(extra = {}) {
  const code = currentWarehouseCode()
  return code ? { ...extra, warehouse_code: code } : { ...extra }
}

async function loadCategories() {
  try {
    const res = await materialApi.categories({
      warehouse_id: effectiveWarehouseId.value || undefined
    })
    categories.value = (res.data && res.data.list) || []
    subCategories.value = (res.data && res.data.subCategories) || []
  } catch (err) {
    console.warn('加载分类失败:', err.message)
  }
}

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
  } catch (err) {
    console.warn('加载仓库失败:', err.message)
  }
}

async function loadMaterials() {
  loading.value = true
  try {
    const res = await materialApi.list({
      page: page.value,
      pageSize: pageSize.value,
      keyword: searchForm.value.keyword || undefined,
      category: searchForm.value.category || undefined,
      sub_category: searchForm.value.sub_category || undefined,
      warehouse_id: effectiveWarehouseId.value || undefined,
      showWarningOnly: searchForm.value.showWarningOnly || undefined
    })
    materialList.value = (res.data && res.data.list) || []
    total.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载物料失败')
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  loadMaterials()
}

function resetSearch() {
  searchForm.value = {
    keyword: '',
    category: '',
    sub_category: '',
    warehouse_id: '',
    showWarningOnly: false
  }
  page.value = 1
  loadMaterials()
}

async function handleExport() {
  exporting.value = true
  try {
    const r = await exportApi.csv({
      module: 'material',
      action: 'list',
      params: {
        keyword: searchForm.value.keyword || undefined,
        category: searchForm.value.category || undefined,
        sub_category: searchForm.value.sub_category || undefined,
        warehouse_id: effectiveWarehouseId.value || undefined,
        showWarningOnly: searchForm.value.showWarningOnly || undefined
      },
      filename: exportFileName,
      columns: [
        'material_no', 'name', 'spec', 'category', 'sub_category', 'warehouse_name', 'unit',
        'current_stock', 'warning_stock', 'avg_cost', 'remark'
      ],
      headers: exportHeaders.value
    })
    ElMessage.success(`已导出 ${r.count} 条`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

function handleAdd() {
  router.push({ path: '/material/edit', query: withWarehouseQuery() })
}

function handleEdit(row) {
  router.push({ path: '/material/edit', query: withWarehouseQuery({ id: row._id }) })
}

function goImport() {
  router.push({ path: '/material/import', query: withWarehouseQuery() })
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定要删除物料「${row.name}」吗？有库存的物料无法删除。`,
      '提示',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
    const res = await materialApi.delete({ id: row._id })
    ElMessage.success(res.message || '删除成功')
    loadMaterials()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '删除失败')
    }
  }
}

async function initPage() {
  // 支持从看板预警跳转带关键词
  if (route.query.keyword) {
    searchForm.value.keyword = String(route.query.keyword)
  }
  // 必须先拿到仓库列表，锁定仓库的页面才知道该查哪个仓
  await loadWarehouses()
  if (isLockedWarehouse.value && !lockedWarehouse.value) {
    ElMessage.warning(`没找到编码为「${lockedWarehouseCode.value}」的仓库，暂时显示全部物料`)
  }
  await loadCategories()
  loadMaterials()
}

const initialized = ref(false)

onMounted(async () => {
  await initPage()
  initialized.value = true
})

/**
 * 仓库一变（切菜单 或 普通页切换仓库下拉），筛选条件就要跟着变：
 *   · 切菜单（换仓库）→ 关键词、「仅看预警」一起归零
 *   · 分类 / 细分类 → 它们是按仓库取的，换仓后原选项已经不存在，必须清空后重拉
 * 注意：配件仓/成品仓两个菜单共用本组件，路由切换时组件会被复用、onMounted 不会再跑，
 *       所以这里同时监听 meta.warehouseCode 和 effectiveWarehouseId，缺一个就会出现
 *       「点了成品仓但列表还是配件仓的数据」。
 */
watch(
  () => [route.meta.warehouseCode || '', String(effectiveWarehouseId.value)],
  ([code, id], [oldCode, oldId]) => {
    if (code === oldCode && id === oldId) return
    if (code !== oldCode) {
      searchForm.value.keyword = ''
      searchForm.value.showWarningOnly = false
    }
    searchForm.value.category = ''
    searchForm.value.sub_category = ''
    page.value = 1
    // 首次进页面时 initPage 已经拉过一次，这里只把下拉准备好，避免重复请求
    if (!initialized.value) {
      loadCategories()
      return
    }
    loadCategories().then(loadMaterials)
  }
)
</script>

<style scoped>
.material-list {
  padding: 0;
}

.search-card {
  margin-bottom: 20px;
}

.table-card {
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

.danger-text {
  color: #e74c3c;
  font-weight: bold;
}

/* 锁定仓库时显示的仓库标签 */
.wh-lock-tag {
  font-weight: 600;
}
</style>
