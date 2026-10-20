<template>
  <div class="inbound-create">
    <el-card v-loading="pageLoading">
      <template #header>
        <div class="card-header">
          <span>新建入库单</span>
          <span class="header-tip">对应小程序「入库登记」：选物料 → 填数量单价 → 提交即入库</span>
        </div>
      </template>

      <!-- 仓库 -->
      <el-form label-width="100px">
        <el-form-item label="入库仓库" required>
          <el-select
            v-model="warehouseId"
            placeholder="选择仓库"
            :disabled="warehouseLocked"
            style="width: 240px"
            @change="onWarehouseChange"
          >
            <el-option v-for="w in myWarehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
          <span v-if="warehouseLocked" class="tip">你只被分配了这一个仓库</span>
        </el-form-item>
      </el-form>

      <!-- 选物料 -->
      <el-card class="inner-card" shadow="never">
        <template #header>
          <div class="card-header">
            <span>选择物料</span>
            <div>
              <el-button size="small" type="primary" plain @click="openCreate">＋ 新增物料</el-button>
            </div>
          </div>
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
               （2026-10-12 用户要求：成品仓不要「成品/配件」这种大类，要按车间分；
                 大类对这个仓库恒为「成品」，筛了等于没筛，所以这里直接用细分类） -->
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
          <el-table-column label="当前库存" width="110">
            <template #default="{ row }">{{ row.current_stock }} {{ row.unit }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button
                size="small"
                :type="inCart(row._id) ? 'info' : 'primary'"
                :disabled="inCart(row._id)"
                @click="addToCart(row)"
              >{{ inCart(row._id) ? '已加入' : '加入' }}</el-button>
            </template>
          </el-table-column>
          <template #empty>没有匹配的物料，点右上角「＋ 新增物料」建档</template>
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
          <div class="card-header">
            <span>入库清单（{{ cart.length }} 项）</span>
            <span v-if="allowPendingPrice" class="pending-hint">
              成品仓可以先不填单价 —— 数量照常入账，这笔会记「待补价」，之后在入库单里补金额
            </span>
          </div>
        </template>
        <el-table :data="cart" size="small" v-if="cart.length">
          <el-table-column prop="name" label="物料" min-width="160" show-overflow-tooltip />
          <el-table-column prop="spec" label="规格" min-width="100" show-overflow-tooltip />
          <el-table-column label="数量" width="150">
            <template #default="{ row }">
              <el-input-number v-model="row.quantity" :min="1" :precision="0" size="small" style="width: 120px" />
            </template>
          </el-table-column>
          <el-table-column :label="allowPendingPrice ? '单价（¥，可留空）' : '单价（¥）'" width="170">
            <template #default="{ row }">
              <!-- 成品仓用普通输入框：el-input-number 清空后会回填成 0，
                   而 0 在这里是危险的（会把加权成本永久稀释），必须能真正留空 -->
              <el-input
                v-model="row.unit_price"
                :placeholder="allowPendingPrice ? '可留空' : '必填'"
                size="small"
                style="width: 130px"
              />
            </template>
          </el-table-column>
          <el-table-column label="小计" width="110">
            <template #default="{ row }">
              <span v-if="isPricePending(row)" class="pending-tag">待补价</span>
              <span v-else>¥{{ (row.quantity * row.unit_price).toFixed(2) }}</span>
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

      <!-- 整单信息 -->
      <el-form label-width="100px" style="margin-top: 16px">
        <el-form-item label="供应商">
          <el-input v-model="supplier" placeholder="选填。填了 = 采购入库；不填 = 其他入库（车间自制/盘盈等）" style="width: 420px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="remark" type="textarea" :rows="2" placeholder="选填" style="width: 420px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" size="large" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">
            提交入库单（{{ cart.length }} 项 · 合计 ¥{{ totalPrice }}）
          </el-button>
          <el-button @click="$router.push('/order/inbound')">返回列表</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 新增物料弹窗 -->
    <el-dialog v-model="createVisible" title="新增物料（建档后直接加入清单）" width="560px">
      <el-form :model="createForm" label-width="96px">
        <el-form-item label="名称" required>
          <el-input v-model="createForm.name" placeholder="如：火花塞" />
        </el-form-item>
        <el-form-item label="大类" required>
          <el-select v-model="createForm.category" placeholder="选择大类" filterable allow-create style="width: 100%">
            <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
          </el-select>
          <!-- 大类是仓库级字段：成品仓恒为「成品」、配件仓恒为「配件」。
               只有一个值时自动填好，省用户一步（仍可改，allow-create 保留） -->
          <span v-if="categories.length === 1" class="tip">
            本仓只有「{{ categories[0] }}」这一个大类，已自动填好
          </span>
        </el-form-item>
        <!-- 细分类：成品仓=车间、配件仓=编号分类，标签与选项都跟着仓库走 -->
        <el-form-item :label="subCategoryLabel">
          <el-select
            v-model="createForm.sub_category"
            :placeholder="`选填，如：${subCategoryHint}`"
            filterable
            allow-create
            clearable
            style="width: 100%"
          >
            <el-option v-for="c in subCategories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="规格型号">
          <el-input v-model="createForm.spec" placeholder="选填" />
        </el-form-item>
        <el-form-item label="单位">
          <el-input v-model="createForm.unit" placeholder="个 / 套 / 米" style="width: 160px" />
        </el-form-item>
        <el-form-item label="预警库存">
          <el-input-number v-model="createForm.warning_stock" :min="0" :precision="0" style="width: 160px" />
          <span class="tip">低于这个数会在预警里提示补货，默认 10</span>
        </el-form-item>
        <el-form-item label="照片">
          <div class="photo-row">
            <el-upload :show-file-list="false" :auto-upload="false" accept="image/*" :on-change="onPickPhoto">
              <el-button size="small" :loading="createUploading">{{ createForm.image_fileid ? '重新上传' : '上传照片' }}</el-button>
            </el-upload>
            <el-image
              v-if="createForm.image_fileid"
              :src="fullFileUrl(createForm.image_fileid)"
              :preview-src-list="[fullFileUrl(createForm.image_fileid)]"
              fit="cover"
              style="width: 48px; height: 48px; border-radius: 6px; margin-left: 10px"
            />
            <el-button v-if="createForm.image_fileid" size="small" type="danger" link @click="createForm.image_fileid = ''">移除</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="handleCreate">创建并加入清单</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { inboundApi, materialApi, warehouseApi, uploadFile, fullFileUrl } from '@/api'
import { useUserStore } from '@/store/user'

const router = useRouter()
const userStore = useUserStore()

const pageLoading = ref(false)
const submitting = ref(false)

/* ---------------- 仓库（仓管只看自己管的仓） ---------------- */
const warehouses = ref([])
const warehouseId = ref('')

/** 我能操作的仓库：admin 全部；仓管按 warehouse_ids 收敛（后端 requireWarehouseAccess 是防线） */
const myWarehouses = computed(() => {
  if (userStore.hasRole('admin')) return warehouses.value
  const ids = ((userStore.userInfo && userStore.userInfo.warehouse_ids) || []).map(Number)
  if (!ids.length) return warehouses.value // 没配 = 不隔离（老账号兼容）
  return warehouses.value.filter((w) => ids.includes(Number(w._id)))
})
const warehouseLocked = computed(() => myWarehouses.value.length === 1)

/** 当前选中仓库的 code（peijian / chengpin）—— 决定「细分类」这个字段叫什么 */
const currentWarehouseCode = computed(() => {
  const w = myWarehouses.value.find((x) => Number(x._id) === Number(warehouseId.value))
  return (w && w.code) || ''
})

/**
 * 成品仓允许入库单价留空（记为「待补价」）
 * 2026-10-20：销售端还没接入，客户那边暂时给不出价格。
 * 配件仓不放开的理由：买来要跟采购价/发票对账，缺价事后核不出来。
 * 口径取「不是成品仓就必须填价」，将来多一个仓默认从严，不会误放开。
 */
const allowPendingPrice = computed(() => currentWarehouseCode.value === 'chengpin')

/**
 * 细分类的显示名（与物料列表页 / 编辑页同一个口径）：
 *   成品仓 → 车间；配件仓 → 编号分类
 * ⚠️ 不要用大类来筛（2026-10-12 用户反馈）：成品仓的 category 恒为「成品」、
 *    配件仓恒为「配件」，拿它当筛选条件等于没筛，且会把「成品」这种仓库名当分类展示。
 */
const subCategoryLabel = computed(() => {
  if (currentWarehouseCode.value === 'chengpin') return '车间'
  if (currentWarehouseCode.value === 'peijian') return '编号分类'
  return '分类'
})

/** 建档时给细分类输入框一个贴合本仓的例子 */
const subCategoryHint = computed(() =>
  currentWarehouseCode.value === 'chengpin' ? '工程车间' : 'A001 板材型材')

/* ---------------- 物料选择 ---------------- */
const materials = ref([])
/** 大类：仓库级，成品仓恒为「成品」、配件仓恒为「配件」（建档时才用） */
const categories = ref([])
/** 细分类：成品仓=车间、配件仓=编号分类 —— 列表筛选与建档都用它 */
const subCategories = ref([])
const keyword = ref('')
/** 列表筛选用的细分类（不是大类） */
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
    const d = catRes.data || {}
    categories.value = d.list || []
    subCategories.value = d.subCategories || []
  } catch (err) { /* 分类拿不到不挡路 */ }
  await loadMaterials()
}

/* ---------------- 清单 ---------------- */
const cart = ref([])

const inCart = (id) => cart.value.some((i) => i._id === id)

function addToCart(row) {
  if (inCart(row._id)) return
  cart.value.push({
    _id: row._id,
    name: row.name,
    spec: row.spec || '',
    unit: row.unit || '个',
    quantity: 1,
    // 默认留空而不是 0：成品仓本来就没有价格，填 0 反而会被当成零成本
    unit_price: ''
  })
}

/** 某一行的单价是否还没填（待补价） */
const isPricePending = (row) =>
  row.unit_price === null || row.unit_price === undefined || String(row.unit_price).trim() === ''

const totalPrice = computed(() =>
  cart.value.reduce((s, i) => s + i.quantity * (Number(i.unit_price) || 0), 0).toFixed(2))

const canSubmit = computed(() => {
  if (!warehouseId.value || !cart.value.length) return false
  if (!cart.value.every((i) => Number.isInteger(Number(i.quantity)) && Number(i.quantity) > 0)) return false
  return cart.value.every((i) => {
    const raw = String(i.unit_price === null || i.unit_price === undefined ? '' : i.unit_price).trim()
    if (raw === '') return allowPendingPrice.value // 只有成品仓能留空
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 // 填了就必须是大于 0 的数字
  })
})

/* ---------------- 新增物料 ---------------- */
const createVisible = ref(false)
const creating = ref(false)
const createUploading = ref(false)
const createForm = ref({})

function openCreate() {
  createForm.value = {
    name: keyword.value.trim(), unit: '个', warning_stock: 10,
    // 大类自动取本仓唯一的大类（成品仓=成品 / 配件仓=配件），省用户一步
    category: categories.value[0] || '',
    // 细分类顺着列表当前的筛选带过来（正在看哪个车间，新建的大概率也是它）
    sub_category: subCategory.value || '',
    spec: '', material_no: '', image_fileid: ''
  }
  createVisible.value = true
}

async function onPickPhoto(file) {
  if (!file || !file.raw) return
  createUploading.value = true
  try {
    createForm.value.image_fileid = await uploadFile(file.raw, 'materials')
    ElMessage.success('照片已上传')
  } catch (err) {
    ElMessage.error(err.message || '上传失败')
  } finally {
    createUploading.value = false
  }
}

async function handleCreate() {
  const f = createForm.value
  if (!String(f.name || '').trim()) return ElMessage.warning('物料名称不能为空')
  if (!String(f.category || '').trim()) return ElMessage.warning('请选择大类')
  creating.value = true
  try {
    const res = await materialApi.upsert({
      name: f.name.trim(),
      unit: f.unit || '个',
      category: f.category.trim(),
      sub_category: String(f.sub_category || '').trim(),
      spec: String(f.spec || '').trim(),
      warning_stock: Number(f.warning_stock) || 10,
      warehouse_id: warehouseId.value,
      image_fileid: f.image_fileid || ''
    })
    const created = res.data || {}
    ElMessage.success('物料已创建')
    createVisible.value = false
    // 直接加入清单（_id 拿不到就刷新列表后按名称找——后端 upsert 返回 _id）
    addToCart({
      _id: created._id,
      name: f.name.trim(),
      spec: f.spec || '',
      unit: f.unit || '个'
    })
    await loadMaterials()
  } catch (err) {
    ElMessage.error(err.message || '创建失败')
  } finally {
    creating.value = false
  }
}

/* ---------------- 提交 ---------------- */
async function handleSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    const items = cart.value.map((i) => {
      const raw = String(i.unit_price === null || i.unit_price === undefined ? '' : i.unit_price).trim()
      return {
        material_id: i._id,
        material_name: i.name,
        material_spec: i.spec,
        quantity: Number(i.quantity),
        unit: i.unit,
        // 留空 → null（不是 0）：后端据此记为「待补价」，不参与加权成本
        unit_price: raw === '' ? null : Number(raw)
      }
    })
    const sup = String(supplier.value || '').trim()
    const res = await inboundApi.submit({
      warehouse_id: warehouseId.value,
      items,
      supplier: sup,
      // 沿用小程序口径：填了供应商 = 采购入库；没填 = 其他入库（车间自制/盘盈等）
      type: sup ? 'purchase' : 'other',
      remark: String(remark.value || '').trim()
    })
    ElMessage.success(`入库单 ${(res.data && res.data.order_no) || ''} 已提交，等待确认`)
    router.push('/order/inbound')
  } catch (err) {
    ElMessage.error(err.message || '提交失败')
  } finally {
    submitting.value = false
  }
}

const supplier = ref('')
const remark = ref('')

onMounted(async () => {
  pageLoading.value = true
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
    if (myWarehouses.value.length) {
      warehouseId.value = myWarehouses.value[0]._id
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
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

/* 待补价：正常状态，不是错误 —— 用琥珀色提示，别做成红色看起来像报错 */
.pending-tag {
  color: #b26a00;
  background: #fff7e6;
  border: 1px solid #ffe0a3;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 12px;
}

.pending-hint {
  font-size: 12px;
  color: #b26a00;
  font-weight: normal;
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

.photo-row {
  display: flex;
  align-items: center;
}
</style>
