<template>
  <div class="monthly-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>月结表</span>
          <el-tag size="small" type="info">期初 / 本月收入 / 本月发出 / 期末结存</el-tag>
        </div>
      </template>

      <!-- 筛选 -->
      <div class="filter-bar">
        <el-date-picker
          v-model="month"
          type="month"
          placeholder="选择月份"
          format="YYYY 年 MM 月"
          value-format="YYYY-MM"
          :clearable="false"
          style="width: 160px"
          @change="load"
        />
        <el-select
          v-model="warehouseId"
          placeholder="选择仓库"
          style="width: 180px"
          @change="load"
        >
          <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
        </el-select>
        <el-button type="primary" :loading="loading" @click="load">查询</el-button>
        <el-button type="success" :loading="exporting" @click="handleExport">导出 Excel</el-button>
      </div>

      <div class="report-title" v-if="list.length || !loading">
        {{ companyName }}{{ monthTitle }}{{ warehouseName }}月报表
      </div>
      <div class="tip" v-if="canCost">
        金额口径：收入按入库单真实单价；期末/发出/期初按当前移动平均成本近似（系统未记录逐时点成本）。
      </div>
      <div class="tip" v-else>按你的角色，金额列已隐藏，仅显示数量。</div>

      <el-table :data="list" v-loading="loading" border size="small" max-height="620" class="monthly-table">
        <el-table-column type="index" label="#" width="50" fixed />
        <el-table-column prop="material_no" label="产品编号" width="110" fixed>
          <template #default="{ row }">{{ row.material_no || '—' }}</template>
        </el-table-column>
        <el-table-column prop="name" label="产品名称" min-width="220" show-overflow-tooltip fixed />
        <el-table-column prop="spec" label="产品规格" min-width="170" show-overflow-tooltip />
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column :label="subCategoryLabel" width="110">
          <template #default="{ row }">{{ row.sub_category || '—' }}</template>
        </el-table-column>

        <el-table-column label="期初结存" align="center">
          <el-table-column label="数量" width="100" align="right">
            <template #default="{ row }">{{ fmtQty(row.begin_qty) }}</template>
          </el-table-column>
          <el-table-column v-if="canCost" label="金额" width="120" align="right">
            <template #default="{ row }">{{ fmtMoney(row.begin_amount) }}</template>
          </el-table-column>
        </el-table-column>

        <el-table-column label="本月收入" align="center">
          <el-table-column label="数量" width="100" align="right">
            <template #default="{ row }">{{ fmtQty(row.in_qty) }}</template>
          </el-table-column>
          <el-table-column v-if="canCost" label="单价" width="110" align="right">
            <template #default="{ row }">{{ row.in_qty > 0 ? fmtMoney(row.in_price) : '' }}</template>
          </el-table-column>
          <el-table-column v-if="canCost" label="金额" width="120" align="right">
            <template #default="{ row }">{{ fmtMoney(row.in_amount) }}</template>
          </el-table-column>
        </el-table-column>

        <el-table-column label="本月发出" align="center">
          <el-table-column label="数量" width="100" align="right">
            <template #default="{ row }">{{ fmtQty(row.out_qty) }}</template>
          </el-table-column>
          <el-table-column v-if="canCost" label="金额" width="120" align="right">
            <template #default="{ row }">{{ fmtMoney(row.out_amount) }}</template>
          </el-table-column>
        </el-table-column>

        <el-table-column label="期末结存" align="center">
          <el-table-column label="数量" width="100" align="right">
            <template #default="{ row }">{{ fmtQty(row.end_qty) }}</template>
          </el-table-column>
          <el-table-column v-if="canCost" label="金额" width="130" align="right">
            <template #default="{ row }">{{ fmtMoney(row.end_amount) }}</template>
          </el-table-column>
        </el-table-column>
      </el-table>

      <!-- 合计 -->
      <div class="summary-bar" v-if="list.length">
        <span>合计：</span>
        <span>期初 {{ fmtQty(summary.begin_qty) }}<template v-if="canCost"> / {{ fmtMoney(summary.begin_amount) }}</template></span>
        <span>收入 {{ fmtQty(summary.in_qty) }}<template v-if="canCost"> / {{ fmtMoney(summary.in_amount) }}</template></span>
        <span>发出 {{ fmtQty(summary.out_qty) }}<template v-if="canCost"> / {{ fmtMoney(summary.out_amount) }}</template></span>
        <span>期末 {{ fmtQty(summary.end_qty) }}<template v-if="canCost"> / {{ fmtMoney(summary.end_amount) }}</template></span>
      </div>
      <el-empty v-if="!loading && !list.length" description="该仓库暂无物料" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import { statsApi, warehouseApi } from '@/api'
import { useUserStore } from '@/store/user'
import { canViewCost } from '@/constants/roles'

const userStore = useUserStore()
const canCost = computed(() => canViewCost(userStore.roles))

const loading = ref(false)
const exporting = ref(false)
const month = ref(dayjs().format('YYYY-MM'))
const warehouseId = ref('')
const warehouses = ref([])
const list = ref([])
const summary = ref({})
const companyName = ref('胜龙')
const warehouseName = ref('')

const monthTitle = computed(() => {
  const [y, m] = String(month.value || '').split('-')
  return y && m ? `${y}年${Number(m)}月份` : ''
})

/** 细分类列名跟着仓库语义走（成品仓=车间、配件仓=编号分类） */
const subCategoryLabel = computed(() => {
  const w = warehouses.value.find((x) => Number(x._id) === Number(warehouseId.value))
  if (w && w.code === 'chengpin') return '车间'
  if (w && w.code === 'peijian') return '编号分类'
  return '分类'
})

const fmtQty = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : '0'
}
const fmtMoney = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function loadWarehouses() {
  const res = await warehouseApi.list()
  warehouses.value = (res.data && res.data.list) || []
  if (!warehouseId.value && warehouses.value.length) {
    // 默认优先成品仓（本功能主要为成品仓月结）；没有成品仓则取第一个
    const cp = warehouses.value.find((w) => w.code === 'chengpin')
    warehouseId.value = (cp || warehouses.value[0])._id
  }
}

async function load() {
  if (!warehouseId.value) return
  loading.value = true
  try {
    const res = await statsApi.monthly({ month: month.value, warehouse_id: warehouseId.value })
    const d = res.data || {}
    list.value = d.list || []
    summary.value = d.summary || {}
    companyName.value = d.company_name || '胜龙'
    warehouseName.value = d.warehouse_name || ''
  } catch (err) {
    ElMessage.error(err.message || '加载月结表失败')
  } finally {
    loading.value = false
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const res = await statsApi.monthlyExport({ month: month.value, warehouse_id: warehouseId.value })
    const d = res.data || {}
    if (!d.content_base64) throw new Error('导出内容为空')
    const bin = atob(d.content_base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = d.filename || `月报表_${month.value}.xlsx`
    a.click()
    URL.revokeObjectURL(a.href)
    ElMessage.success('已导出 ' + (d.filename || '月报表'))
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  try {
    await loadWarehouses()
  } catch (err) {
    ElMessage.error(err.message || '加载仓库失败')
  }
  await load()
})
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
}
.filter-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.report-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}
.tip {
  font-size: 12px;
  color: #999;
  margin-bottom: 10px;
}
.summary-bar {
  margin-top: 12px;
  display: flex;
  gap: 18px;
  font-size: 13px;
  font-weight: 600;
  flex-wrap: wrap;
}
</style>
