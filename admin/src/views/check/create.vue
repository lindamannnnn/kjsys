<template>
  <div class="check-create">
    <el-card v-loading="loading">
      <template #header>
        <div class="card-header">
          <span>创建盘点任务</span>
        </div>
      </template>

      <el-form :model="form" label-width="120px">
        <el-form-item label="盘点仓库" required>
          <el-select v-model="form.warehouse_id" placeholder="请选择要盘点的仓库" @change="handleWarehouseChange">
            <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
        </el-form-item>

        <el-form-item label="盘点类型">
          <el-radio-group v-model="form.type">
            <el-radio value="full">全盘</el-radio>
            <el-radio value="sample">抽盘</el-radio>
            <el-radio value="cycle">循环盘点</el-radio>
          </el-radio-group>
        </el-form-item>

        <!-- 盘点范围：按仓库语义切 —— 成品仓=车间，配件仓=编号分类
             （2026-10-12 用户要求：原来用大类筛，成品仓恒为「成品」，勾不勾都等于整仓盘，
               失去了「按车间盘」的能力 → 改用 sub_category） -->
        <el-form-item label="盘点范围" v-if="form.type !== 'full'">
          <el-select
            v-model="form.subCategories"
            multiple
            :placeholder="`选择${subCategoryLabel}（不选 = 该仓库全部物料）`"
            style="width: 420px"
          >
            <el-option v-for="c in subCategories" :key="c" :label="c" :value="c" />
          </el-select>
          <div class="tip">共 {{ materialTotal }} 个物料可选；按{{ subCategoryLabel }}生成盘点明细</div>
        </el-form-item>

        <el-form-item label="冻结库存">
          <el-switch v-model="form.freeze_stock" />
          <span class="tip">盘点期间禁止出入库</span>
        </el-form-item>

        <el-form-item label="盘点人员" v-if="assignees.length">
          <el-select v-model="form.assignee_openids" multiple placeholder="选择参与盘点的小程序用户">
            <el-option
              v-for="u in assignees"
              :key="u._id"
              :label="u.name"
              :value="u.openid"
            />
          </el-select>
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="handleSubmit">
            创建盘点任务
          </el-button>
          <el-button @click="$router.push('/check/list')">取消</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { checkApi, warehouseApi, materialApi, userApi } from '@/api'

const router = useRouter()

const loading = ref(false)
const submitting = ref(false)

const warehouses = ref([])
/** 细分类选项：成品仓=车间、配件仓=编号分类（盘点范围的真正维度） */
const subCategories = ref([])
const assignees = ref([])
const materialTotal = ref(0)

const form = ref({
  warehouse_id: '',
  type: 'full',
  /** 细分类（车间 / 编号分类）—— 盘点范围 */
  subCategories: [],
  freeze_stock: true,
  assignee_openids: []
})

/** 当前选中仓库的 code（peijian / chengpin）—— 决定范围这一栏叫什么 */
const currentWarehouseCode = computed(() => {
  const w = warehouses.value.find((x) => Number(x._id) === Number(form.value.warehouse_id))
  return (w && w.code) || ''
})

/**
 * 细分类的显示名（与物料列表 / 编辑页 / 建单页同一个口径）：
 *   成品仓 → 车间；配件仓 → 编号分类
 * ⚠️ 不要用大类（category）做范围：成品仓恒为「成品」、配件仓恒为「配件」，
 *    勾不勾都等于整仓盘（2026-10-12 用户反馈）。
 */
const subCategoryLabel = computed(() => {
  if (currentWarehouseCode.value === 'chengpin') return '车间'
  if (currentWarehouseCode.value === 'peijian') return '编号分类'
  return '分类'
})

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
    if (warehouses.value.length) {
      form.value.warehouse_id = warehouses.value[0]._id
      await handleWarehouseChange()
    }
  } catch (err) {
    ElMessage.error(err.message || '加载仓库失败')
  }
}

/** 切换仓库时刷新「范围」选项与物料数量 */
async function handleWarehouseChange() {
  form.value.subCategories = []
  try {
    const [catRes, matRes] = await Promise.all([
      materialApi.categories({ warehouse_id: form.value.warehouse_id }),
      materialApi.list({ warehouse_id: form.value.warehouse_id, page: 1, pageSize: 1 })
    ])
    // 用细分类（车间 / 编号分类），不是大类
    subCategories.value = (catRes.data && catRes.data.subCategories) || []
    materialTotal.value = (matRes.data && matRes.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载盘点范围失败')
  }
}

/** 盘点人员候选：后端只回「有 openid 的小程序用户」（后台账号进不了小程序，当不了执行人） */
async function loadAssignees() {
  try {
    const res = await userApi.assignees()
    assignees.value = (res.data && res.data.list) || []
  } catch (err) {
    // 这里原来只 console.warn，结果仓管进来看到的是「人员下拉凭空消失」，查不出原因。
    // 现在明确告诉用户：要么权限不够、要么后端没更新。
    ElMessage.warning(err.message || '加载盘点人员失败，可先不指定人员直接创建')
  }
}

async function handleSubmit() {
  if (!form.value.warehouse_id) {
    ElMessage.warning('请选择要盘点的仓库')
    return
  }

  // 没选范围 = 整仓盘点。物料多时明细可能上千条，先二次确认再放行
  const isFullScan = !(form.value.subCategories && form.value.subCategories.length)
  if (isFullScan) {
    try {
      await ElMessageBox.confirm(
        `你没有选择${subCategoryLabel.value}，这将盘点该仓库的全部物料，明细可能上千条、工作量很大。确定要整仓盘点吗？`,
        '整仓盘点确认',
        {
          confirmButtonText: '确定整仓盘点',
          cancelButtonText: `我去选${subCategoryLabel.value}`,
          type: 'warning'
        }
      )
    } catch (e) {
      return
    }
  }

  submitting.value = true
  try {
    const res = await checkApi.create({
      type: form.value.type,
      warehouse_id: form.value.warehouse_id,
      // categories 传空：大类是仓库级字段（成品仓恒为「成品」），不参与范围；
      // 真正的范围维度是 sub_categories（车间 / 编号分类）
      scope: { categories: [], sub_categories: form.value.subCategories, material_ids: [] },
      assignee_openids: form.value.assignee_openids,
      freeze_stock: form.value.freeze_stock,
      confirm_full_scan: isFullScan
    })
    ElMessage.success(res.message || '盘点任务创建成功')
    router.push('/check/list')
  } catch (err) {
    ElMessage.error(err.message || '创建盘点任务失败')
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  loading.value = true
  try {
    await Promise.all([loadWarehouses(), loadAssignees()])
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.check-create {
  padding: 0;
}

.card-header {
  font-weight: 600;
}

.tip {
  margin-left: 12px;
  font-size: 13px;
  color: #999;
}
</style>
