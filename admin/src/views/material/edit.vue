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

        <!-- 编号：配件仓是货位编号（A001-7），成品仓是预定编号 —— 两仓共用同一字段、都是选填。
             成品仓语义：不填 = 标准产品，填写 = 已经预定出去的产品。
             因此「同物料 + 同规格」只要编号不同就可各占一条记录（判重口径见后端 material.upsert）。 -->
        <el-form-item :label="materialNoLabel">
          <el-input v-model="form.material_no" :placeholder="materialNoPlaceholder" />
          <div v-if="isChengpin" class="tip">
            选填。不填编号 = 标准产品；填写编号 = 已经预定出去的产品（同规格填不同编号会分成两条记录）
          </div>
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

        <!-- 期初建账：仅在「系统设置 → 期初建账模式」开启时出现，填完关掉即可 -->
        <template v-if="showOpening">
          <el-divider content-position="left">期初建账（临时录入）</el-divider>
          <el-form-item label="期初数量">
            <el-input-number v-model="openingForm.quantity" :min="0" :precision="3" :step="1" />
            <span class="tip" style="margin-left:8px">实盘有多少填多少，单位「{{ form.unit }}」</span>
          </el-form-item>
          <el-form-item label="期初金额">
            <el-input-number v-model="openingForm.amount" :min="0" :precision="2" :step="100" />
            <span class="tip" style="margin-left:8px">这批货的<b>总金额</b>（元），不是单价</span>
          </el-form-item>
          <el-form-item label="折算单价">
            <span class="opening-price">¥{{ openingUnitPrice }}</span>
            <span class="tip" style="margin-left:8px">＝ 金额 ÷ 数量，保存后成为该物料的成本价</span>
          </el-form-item>
        </template>

        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" placeholder="选填" />
        </el-form-item>

        <el-form-item label="物料照片">
          <div class="photo-row">
            <el-button size="small" :loading="photoUploading" @click="choosePhoto">
              {{ form.image_fileid ? '重新上传' : '上传照片' }}
            </el-button>
            <el-image
              v-if="form.image_fileid"
              class="photo-preview"
              :src="fullFileUrl(form.image_fileid)"
              :preview-src-list="[fullFileUrl(form.image_fileid)]"
              fit="contain"
              preview-teleported
            />
            <el-button v-if="form.image_fileid" size="small" type="danger" link @click="form.image_fileid = ''">移除</el-button>
          </div>
          <input ref="photoInput" type="file" accept="image/*" style="display:none" @change="onPhotoChange" />
        </el-form-item>

        <el-form-item v-if="isEdit">
          <span class="tip">
            当前库存：{{ detail.current_stock }} {{ form.unit }}<template v-if="canSeeCost">　成本价：¥{{ Number(detail.avg_cost || 0).toFixed(2) }}</template>
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
import { materialApi, warehouseApi, uploadFile, fullFileUrl } from '@/api'
import { canViewCost } from '@/constants/roles'
import { useUserStore } from '@/store/user'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/** 成本价是否展示：仓管端不展示（后端 material.detail 对仓管已脱敏） */
const canSeeCost = computed(() => canViewCost(userStore.roles || []))

const loading = ref(false)
const submitting = ref(false)
const categories = ref([])
const subCategories = ref([])
const warehouses = ref([])
const detail = ref({})

const isEdit = computed(() => !!route.query.id)

/* ---------------- 期初建账（2026-10-20） ----------------
 * 只有「系统设置 → 期初建账模式」开启 + 当前角色可编辑时才显示这两个字段。
 * ⚠️ 前端隐藏只是体验，真正的闸门在后端 setOpening（关掉开关后接口直接拒绝）。
 */
const openingMode = ref({ enabled: false, canEdit: false })
const openingForm = ref({ quantity: 0, amount: 0 })
const openingBaseline = ref({ quantity: 0, amount: 0 })

const showOpening = computed(
  () => isEdit.value && openingMode.value.enabled && openingMode.value.canEdit
)

/** 客户动过才提交，避免每次改个备注都写一条期初流水 */
const openingDirty = computed(
  () =>
    Number(openingForm.value.quantity) !== Number(openingBaseline.value.quantity) ||
    Number(openingForm.value.amount) !== Number(openingBaseline.value.amount)
)

/** 金额 ÷ 数量 = 折算单价（仅用于展示，实际由后端按同样口径落库） */
const openingUnitPrice = computed(() => {
  const q = Number(openingForm.value.quantity) || 0
  const a = Number(openingForm.value.amount) || 0
  return q > 0 ? (a / q).toFixed(2) : '0.00'
})

async function loadOpeningMode() {
  try {
    const res = await materialApi.getOpeningMode()
    const d = res.data || {}
    openingMode.value = { enabled: !!d.enabled, canEdit: !!d.canEdit }
  } catch (e) {
    // 接口不存在或网络异常时静默降级为「不显示」，不能因此挡住正常编辑
    openingMode.value = { enabled: false, canEdit: false }
  }
}

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

/** 是否成品仓 */
const isChengpin = computed(() => currentWarehouseCode.value === 'chengpin')

/** 编号输入框标签：成品仓就叫「编号」，配件仓沿用「XX编号」 */
const materialNoLabel = computed(() =>
  isChengpin.value ? '编号' : subCategoryLabel.value + '编号'
)

/** 编号输入框占位提示：成品仓的编号=预定编号，语义与配件仓不同 */
const materialNoPlaceholder = computed(() =>
  isChengpin.value ? '选填（同仓库下不可重复）' : '如 A001-7（同仓库下不可重复）'
)

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
  remark: '',
  image_fileid: ''
})

// 物料照片
const photoInput = ref(null)
const photoUploading = ref(false)
function choosePhoto() {
  photoInput.value && photoInput.value.click()
}
async function onPhotoChange(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  photoUploading.value = true
  try {
    form.value.image_fileid = await uploadFile(file, 'materials')
    ElMessage.success('照片已上传')
  } catch (err) {
    ElMessage.error(err.message || '上传失败')
  } finally {
    photoUploading.value = false
    e.target.value = ''
  }
}

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
      remark: d.remark || '',
      image_fileid: d.image_fileid || ''
    }
    // 期初字段的初值 = 当前库存 + 当前库存金额，客户照着现状改；
    // 没改就不提交，避免每次只改个备注也写出一条期初流水。
    const curQty = Number(d.current_stock) || 0
    const curCost = Number(d.avg_cost) || 0
    openingBaseline.value = { quantity: curQty, amount: Number((curQty * curCost).toFixed(2)) }
    openingForm.value = { ...openingBaseline.value }
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
      remark: form.value.remark,
      image_fileid: form.value.image_fileid
    }
    if (form.value._id) payload._id = form.value._id

    const res = await materialApi.upsert(payload)

    // 期初数量/金额：档案存好之后再单独写（要走库存流水，不能混在档案接口里）
    let openingMsg = ''
    if (showOpening.value && openingDirty.value) {
      try {
        const r2 = await materialApi.setOpening({
          id: form.value._id,
          quantity: Number(openingForm.value.quantity) || 0,
          amount: Number(openingForm.value.amount) || 0
        })
        openingMsg = '；' + (r2.message || '期初已建账')
        // 写成功了就把基线跟着改掉，避免返回上一页再进来时又被当成"改过"
        openingBaseline.value = { ...openingForm.value }
      } catch (e2) {
        // 档案已经存进去了，这里必须说清楚，不能笼统报"保存失败"
        ElMessage.error('物料档案已保存，但期初数量/金额没写进去：' + (e2.message || '未知错误'))
        submitting.value = false
        return
      }
    }

    ElMessage.success((res.message || (isEdit.value ? '更新成功' : '创建成功')) + openingMsg)
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
    if (isEdit.value) await loadOpeningMode()
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

/* 期初建账折算单价：数字要醒目，客户靠它核对单价有没有填错 */
.opening-price {
  font-size: 16px;
  font-weight: 600;
  color: #e6541f;
}

.photo-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.photo-preview {
  width: 96px;
  height: 96px;
  border-radius: 8px;
  background: #f5f5f5;
}
</style>
