<template>
  <div class="outbound-create">
    <!-- 成品仓模式提示条（纯厂长 / 成品仓管，与小程序一致） -->
    <el-alert
      v-if="chengpinMode"
      type="primary"
      :closable="false"
      class="mode-banner"
      title="🚚 成品仓出库"
      :description="isPureDirector
        ? '提交后由成品仓管拣货，拣完会通知你确认收货。'
        : '这里只能对成品仓开单；提交后由仓管拣货，拣完由提交人确认收货。'"
    />

    <el-card v-loading="pageLoading">
      <template #header>
        <div class="card-header">
          <span>{{ chengpinMode ? '成品仓出库（新建出库单）' : '新建出库单' }}</span>
          <span class="header-tip">对应小程序「成品仓出库」：选物料 → 填数量 → 选类型 → 提交</span>
        </div>
      </template>

      <el-form label-width="100px">
        <!-- 仓库：纯厂长 / 成品仓管锁死成品仓；admin 任选 -->
        <el-form-item label="出库仓库" required>
          <el-select
            v-model="warehouseId"
            placeholder="选择仓库"
            :disabled="chengpinMode"
            style="width: 240px"
            @change="onWarehouseChange"
          >
            <el-option v-for="w in availableWarehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
          <span v-if="chengpinMode" class="tip">只能对成品仓开单（配件仓领料由配件仓管开单）</span>
        </el-form-item>

        <el-form-item label="出库类型" required>
          <el-radio-group v-model="outType">
            <el-radio v-for="t in outTypes" :key="t.value" :value="t.value">{{ t.label }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>

      <!-- 选物料 -->
      <el-card class="inner-card" shadow="never">
        <template #header>
          <div class="card-header"><span>选择物料（当前仓：{{ currentWhName }}）</span></div>
        </template>
        <div class="filter-bar">
          <el-input
            v-model="keyword"
            placeholder="搜索物料名称 / 规格 / 编号"
            clearable
            style="width: 280px"
            @input="debouncedSearch"
            @clear="loadMaterials"
          />
          <!-- 分类筛选：按仓库语义切 —— 成品仓=车间，配件仓=编号分类
               （2026-10-12 用户要求：不要「成品/配件」这种大类；本仓大类恒为一个值，筛了没意义） -->
          <el-select
            v-model="subCategory"
            :placeholder="`${subCategoryLabel}（全部）`"
            clearable
            style="width: 200px"
            @change="loadMaterials"
          >
            <el-option v-for="c in subCategories" :key="c" :label="c" :value="c" />
          </el-select>
        </div>

        <el-table :data="materials" v-loading="matLoading" size="small" max-height="320">
          <el-table-column label="照片" width="70">
            <template #default="{ row }">
              <el-image
                v-if="row.image_fileid"
                :src="fullFileUrl(row.image_fileid)"
                :preview-src-list="[fullFileUrl(row.image_fileid)]"
                fit="cover"
                style="width: 36px; height: 36px; border-radius: 6px"
              />
              <span v-else class="no-photo">无图</span>
            </template>
          </el-table-column>
          <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
          <el-table-column prop="spec" label="规格" min-width="120" show-overflow-tooltip />
          <el-table-column label="库存" width="110">
            <template #default="{ row }">
              <span :class="{ 'stock-zero': Number(row.current_stock) <= 0 }">
                {{ row.current_stock }} {{ row.unit }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button
                size="small"
                :type="inCart(row._id) ? 'info' : 'primary'"
                :disabled="inCart(row._id) || Number(row.current_stock) <= 0"
                @click="addToCart(row)"
              >{{ inCart(row._id) ? '已加入' : Number(row.current_stock) <= 0 ? '缺货' : '加入' }}</el-button>
            </template>
          </el-table-column>
          <template #empty>该仓库暂无物料</template>
        </el-table>
        <div class="pager" v-if="matTotal > matPageSize">
          <el-pagination
            layout="prev, pager, next, total"
            :total="matTotal"
            :page-size="matPageSize"
            :current-page="matPage"
            @current-change="(p) => { matPage = p; loadMaterials() }"
          />
        </div>
      </el-card>

      <!-- 清单 -->
      <el-card class="inner-card" shadow="never">
        <template #header>
          <div class="card-header"><span>出库清单（{{ cart.length }} 项）</span></div>
        </template>
        <el-table :data="cart" size="small" v-if="cart.length">
          <el-table-column prop="name" label="物料" min-width="160" show-overflow-tooltip />
          <el-table-column prop="spec" label="规格" min-width="100" show-overflow-tooltip />
          <el-table-column label="库存" width="90">
            <template #default="{ row }">{{ row.current_stock }} {{ row.unit }}</template>
          </el-table-column>
          <el-table-column label="数量" width="170">
            <template #default="{ row }">
              <el-input-number
                v-model="row.quantity"
                :min="1"
                :max="Number(row.current_stock)"
                :precision="0"
                size="small"
                style="width: 130px"
              />
              <div v-if="Number(row.quantity) > Number(row.current_stock)" class="over-tip">超出库存</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ $index }">
              <el-button size="small" type="danger" link @click="cart.splice($index, 1)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="还没选物料" :image-size="60" />
      </el-card>

      <el-form label-width="100px" style="margin-top: 16px">
        <el-form-item label="用途/备注">
          <el-input v-model="remark" type="textarea" :rows="2" placeholder="选填" style="width: 420px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" size="large" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">
            提交出库（{{ cart.length }} 项）
          </el-button>
          <el-button @click="$router.push('/order/outbound')">返回列表</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { outboundApi, materialApi, warehouseApi, fullFileUrl } from '@/api'
import { useUserStore } from '@/store/user'

const router = useRouter()
const userStore = useUserStore()

const pageLoading = ref(false)
const submitting = ref(false)

/* ---------------- 角色与仓库 ----------------
 * 厂长（纯 director）：锁死成品仓，类型只有 销售/领用（与小程序「成品仓出库」一致）。
 *   ⚠️ 前端锁仓只是体验，防线在服务端 assertDirectorWarehouse（按物料归属仓再判一次）。
 * admin：全仓、全类型。
 */
const isPureDirector = computed(() =>
  userStore.hasRole('director') && !userStore.hasRole('boss') && !userStore.hasRole('admin'))

const warehouses = ref([])
const warehouseId = ref('')

const availableWarehouses = computed(() => {
  if (isPureDirector.value) {
    return warehouses.value.filter((w) => w.code === 'chengpin' || String(w.name).includes('成品'))
  }
  return warehouses.value
})

/**
 * 成品仓模式 = 纯厂长，或「只看得见成品仓」的仓管（2026-10-20 用户要求给成品仓管开单入口）。
 * 为什么不按角色写死：仓管是按 warehouse_ids 分仓的，同一个 storekeeper 可能是配件仓管，
 *   用「仓库列表里只有成品仓」来判断既覆盖厂长、也覆盖成品仓管，不会误伤双仓仓管（[1,2] 仍可任选）。
 * ⚠️ 这里只是体验：真防线是后端 outbound.submit（仓管本来就被放行）+ 仓库权限校验。
 */
const chengpinMode = computed(() => {
  const list = availableWarehouses.value
  return list.length > 0 && list.every((w) => w.code === 'chengpin')
})

const currentWhName = computed(() =>
  (warehouses.value.find((w) => w._id === warehouseId.value) || {}).name || '—')

/** 当前选中仓库的 code（peijian / chengpin）—— 决定「细分类」这个字段叫什么 */
const currentWarehouseCode = computed(() =>
  (warehouses.value.find((w) => w._id === warehouseId.value) || {}).code || '')

/**
 * 细分类的显示名（与物料列表页 / 编辑页 / 入库单页同一个口径）：
 *   成品仓 → 车间；配件仓 → 编号分类
 * ⚠️ 别拿大类当筛选（2026-10-12 用户反馈）：本仓 category 恒为「成品」或「配件」，
 *    筛了等于没筛，还会把仓库名当成分类展示出来。
 */
const subCategoryLabel = computed(() => {
  if (currentWarehouseCode.value === 'chengpin') return '车间'
  if (currentWarehouseCode.value === 'peijian') return '编号分类'
  return '分类'
})

const outTypes = computed(() => (chengpinMode.value
  ? [{ value: 'sale', label: '销售' }, { value: 'lingyong', label: '领用' }]
  : [{ value: 'lingyong', label: '领用' }, { value: 'repair', label: '维修' }, { value: 'sale', label: '销售' }]))
const outType = ref('')

/* ---------------- 物料选择 ---------------- */
const materials = ref([])
/** 细分类：成品仓=车间、配件仓=编号分类 —— 列表筛选用它 */
const subCategories = ref([])
const keyword = ref('')
const subCategory = ref('')
const matLoading = ref(false)
const matPage = ref(1)
const matPageSize = 50
const matTotal = ref(0)

let debounceTimer = null
function debouncedSearch() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { matPage.value = 1; loadMaterials() }, 300)
}

async function loadMaterials() {
  if (!warehouseId.value) { materials.value = []; return }
  matLoading.value = true
  try {
    const res = await materialApi.list({
      warehouse_id: warehouseId.value,
      keyword: keyword.value.trim() || undefined,
      // 按细分类筛（车间 / 编号分类）；大类对本仓恒为一个值，筛了没意义
      sub_category: subCategory.value || undefined,
      page: matPage.value,
      pageSize: matPageSize
    })
    materials.value = (res.data && res.data.list) || []
    matTotal.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载物料失败')
  } finally {
    matLoading.value = false
  }
}

async function onWarehouseChange() {
  keyword.value = ''
  subCategory.value = ''
  matPage.value = 1
  cart.value = []
  try {
    const catRes = await materialApi.categories({ warehouse_id: warehouseId.value })
    subCategories.value = (catRes.data && catRes.data.subCategories) || []
  } catch (err) { /* 分类拿不到不挡路 */ }
  await loadMaterials()
}

/* ---------------- 清单 ---------------- */
const cart = ref([])

const inCart = (id) => cart.value.some((i) => i._id === id)

function addToCart(row) {
  if (inCart(row._id)) return
  if (Number(row.current_stock) <= 0) return
  cart.value.push({
    _id: row._id,
    name: row.name,
    spec: row.spec || '',
    unit: row.unit || '个',
    current_stock: row.current_stock,
    warehouse_id: row.warehouse_id,
    quantity: 1
  })
}

const canSubmit = computed(() =>
  warehouseId.value && outType.value && cart.value.length > 0 &&
  cart.value.every((i) => {
    const q = Number(i.quantity)
    return Number.isInteger(q) && q > 0 && q <= Number(i.current_stock)
  }))

/* ---------------- 提交 ---------------- */
const remark = ref('')

async function handleSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    const items = cart.value.map((i) => ({
      material_id: i._id,
      material_name: i.name,
      quantity: Number(i.quantity),
      warehouse_id: i.warehouse_id
    }))
    const res = await outboundApi.submit({
      warehouse_id: warehouseId.value,
      items,
      type: outType.value,
      remark: String(remark.value || '').trim()
    })
    const orderNo = (res.data && res.data.order_no) || ''
    ElMessage.success(
      isPureDirector.value
        ? `出库单 ${orderNo} 已提交，等成品仓管拣货，拣完会通知你确认`
        : userStore.hasRole('storekeeper')
          ? `出库单 ${orderNo} 已提交，可在「出库单」里确认拣货`
          : `出库单 ${orderNo} 已提交，等待仓管确认拣货`
    )
    router.push('/order/outbound')
  } catch (err) {
    ElMessage.error(err.message || '提交失败')
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  pageLoading.value = true
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
    if (availableWarehouses.value.length) {
      warehouseId.value = availableWarehouses.value[0]._id
      await onWarehouseChange()
    }
  } catch (err) {
    ElMessage.error(err.message || '加载仓库失败')
  } finally {
    pageLoading.value = false
  }
})
</script>

<style scoped>
.mode-banner {
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-tip {
  font-size: 12px;
  color: #909399;
  font-weight: normal;
}

.inner-card {
  margin-bottom: 16px;
}

.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.pager {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}

.no-photo {
  font-size: 12px;
  color: #c0c4cc;
}

.tip {
  font-size: 12px;
  color: #909399;
  margin-left: 8px;
}

.stock-zero {
  color: #c0c4cc;
}

.over-tip {
  font-size: 12px;
  color: #e74c3c;
  margin-top: 2px;
}
</style>
