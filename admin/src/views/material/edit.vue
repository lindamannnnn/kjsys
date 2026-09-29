<template>
  <div class="material-edit">
    <el-card v-loading="loading">
      <template #header>
        <div class="card-header">
          <span>{{ isEdit ? '编辑物料' : '新增物料' }}</span>
        </div>
      </template>

      <el-form :model="form" label-width="100px">
        <el-form-item label="物料名称" required>
          <el-input v-model="form.name" placeholder="请输入物料名称" />
        </el-form-item>

        <el-form-item label="规格型号">
          <el-input v-model="form.spec" placeholder="请输入规格型号" />
        </el-form-item>

        <el-form-item label="分类">
          <el-select
            v-model="form.category"
            placeholder="选择或直接输入分类"
            filterable
            allow-create
            default-first-option
            clearable
          >
            <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>

        <!-- 编号：配件仓用（A001-7 这种），成品仓按车间分、不编号，所以成品仓下隐藏 -->
        <el-form-item v-if="showMaterialNo" :label="subCategoryLabel + '编号'">
          <el-input v-model="form.material_no" placeholder="如 A001-7（同仓库下不可重复）" />
        </el-form-item>

        <el-form-item :label="subCategoryLabel">
          <el-select
            v-model="form.sub_category"
            :placeholder="`选择或直接输入${subCategoryLabel}`"
            filterable
            allow-create
            default-first-option
            clearable
          >
            <el-option v-for="s in subCategories" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>

        <el-form-item label="所属仓库" required>
          <el-select v-model="form.warehouse_id" placeholder="请选择所属仓库" :disabled="isEdit">
            <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
          <div v-if="isEdit" class="tip">仓库不支持在此修改</div>
        </el-form-item>

        <el-form-item label="单位">
          <el-input v-model="form.unit" placeholder="请输入单位（如：个、套、条）" />
        </el-form-item>

        <el-form-item label="预警库存">
          <el-input-number v-model="form.warning_stock" :min="0" />
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" placeholder="选填" />
        </el-form-item>

        <el-form-item v-if="isEdit">
          <span class="tip">
            当前库存：{{ detail.current_stock }} {{ form.unit }}　成本价：¥{{ Number(detail.avg_cost || 0).toFixed(2) }}
            （库存与成本由出入库自动维护）
          </span>
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
          <el-button @click="backToList">取消</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { materialApi, warehouseApi } from '@/api'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const submitting = ref(false)
const categories = ref([])
const subCategories = ref([])
const warehouses = ref([])
const detail = ref({})

const isEdit = computed(() => !!route.query.id)

/** 当前所选仓库的编码（决定细分类叫什么） */
const currentWarehouseCode = computed(() => {
  const w = warehouses.value.find((x) => String(x._id) === String(form.value.warehouse_id))
  return w ? w.code : ''
})

/** 成品仓叫「车间」，配件仓叫「编号分类」 */
const subCategoryLabel = computed(() => {
  if (currentWarehouseCode.value === 'chengpin') return '车间'
  if (currentWarehouseCode.value === 'peijian') return '编号分类'
  return '细分类'
})

/** 成品仓不编号，隐藏编号输入框 */
const showMaterialNo = computed(() => currentWarehouseCode.value !== 'chengpin')

/** 列表页带过来的仓库编码：新增/保存后要回到同一个仓库的列表 */
const backWarehouseCode = computed(() => String(route.query.warehouse_code || ''))

/** 返回到对的物料列表：从配件仓/成品仓进来的，就回那个仓 */
function backToList() {
  if (backWarehouseCode.value === 'peijian') return router.push('/material/parts')
  if (backWarehouseCode.value === 'chengpin') return router.push('/material/product')
  return router.push('/material/list')
}

const form = ref({
  _id: '',
  name: '',
  spec: '',
  category: '',
  sub_category: '',
  material_no: '',
  warehouse_id: '',
  unit: '个',
  warning_stock: 10,
  remark: ''
})

async function loadBasics() {
  try {
    const [catRes, whRes] = await Promise.all([
      materialApi.categories(),
      warehouseApi.list()
    ])
    categories.value = (catRes.data && catRes.data.list) || []
    warehouses.value = (whRes.data && whRes.data.list) || []

    // 新增时预选仓库：优先用列表页带过来的仓库，没有就选第一个
    if (!isEdit.value && warehouses.value.length) {
      const picked = backWarehouseCode.value
        ? warehouses.value.find((w) => w.code === backWarehouseCode.value)
        : null
      form.value.warehouse_id = picked ? picked._id : warehouses.value[0]._id
    }
    // 细分类选项是按仓库取的（车间 / 编号分类），仓库定了才能拉
    await loadSubCategories()
  } catch (err) {
    ElMessage.error(err.message || '加载基础数据失败')
  }
}

/** 拉取当前所选仓库的细分类选项 */
async function loadSubCategories() {
  const wid = form.value.warehouse_id
  if (!wid) {
    subCategories.value = []
    return
  }
  try {
    const res = await materialApi.categories({ warehouse_id: wid })
    subCategories.value = (res.data && res.data.subCategories) || []
  } catch (err) {
    console.warn('加载细分类失败:', err.message)
  }
}

async function loadDetail(id) {
  try {
    const res = await materialApi.detail({ id })
    const d = res.data || {}
    detail.value = d
    form.value = {
      _id: d._id,
      name: d.name || '',
      spec: d.spec || '',
      category: d.category || '',
      sub_category: d.sub_category || '',
      material_no: d.material_no || '',
      warehouse_id: d.warehouse_id || '',
      unit: d.unit || '个',
      warning_stock: Number(d.warning_stock || 0),
      remark: d.remark || ''
    }
  } catch (err) {
    ElMessage.error(err.message || '加载物料详情失败')
    backToList()
  }
}

async function handleSubmit() {
  if (!form.value.name) {
    ElMessage.warning('请输入物料名称')
    return
  }
  if (!form.value.warehouse_id) {
    ElMessage.warning('请选择所属仓库')
    return
  }

  submitting.value = true
  try {
    const payload = {
      name: form.value.name,
      spec: form.value.spec,
      category: form.value.category,
      sub_category: form.value.sub_category,
      material_no: form.value.material_no,
      unit: form.value.unit,
      warehouse_id: form.value.warehouse_id,
      warning_stock: form.value.warning_stock,
      remark: form.value.remark
    }
    if (form.value._id) payload._id = form.value._id

    const res = await materialApi.upsert(payload)
    ElMessage.success(res.message || (isEdit.value ? '更新成功' : '创建成功'))
    backToList()
  } catch (err) {
    ElMessage.error(err.message || '保存失败')
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  loading.value = true
  try {
    if (isEdit.value) await loadDetail(route.query.id)
    await loadBasics()
  } finally {
    loading.value = false
  }
})

/**
 * 新增时可以换仓库，仓库一变细分类选项就得跟着换。
 * 注意 oldId 为空时直接跳过 —— 那是编辑页载入详情 / 新增页设默认仓库的首次赋值，
 * 此时 form 里可能已经带着详情的细分类，清空就丢了。
 */
watch(
  () => form.value.warehouse_id,
  async (id, oldId) => {
    if (String(id) === String(oldId)) return
    if (!oldId) return
    form.value.sub_category = ''
    await loadSubCategories()
  }
)
</script>

<style scoped>
.material-edit {
  padding: 0;
}

.card-header {
  font-weight: 600;
}

.tip {
  font-size: 12px;
  color: #999;
  line-height: 1.6;
}
</style>
