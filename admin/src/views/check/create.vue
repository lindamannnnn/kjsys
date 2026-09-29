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

        <el-form-item label="盘点范围" v-if="form.type !== 'full'">
          <el-select v-model="form.categories" multiple placeholder="选择分类（不选 = 该仓库全部物料）">
            <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
          </el-select>
          <div class="tip">共 {{ materialTotal }} 个物料可选；仅勾选分类时按分类生成盘点明细</div>
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
              :label="u.real_name || u.nickname"
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
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { checkApi, warehouseApi, materialApi, userApi } from '@/api'

const router = useRouter()

const loading = ref(false)
const submitting = ref(false)

const warehouses = ref([])
const categories = ref([])
const assignees = ref([])
const materialTotal = ref(0)

const form = ref({
  warehouse_id: '',
  type: 'full',
  categories: [],
  freeze_stock: true,
  assignee_openids: []
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

/** 切换仓库时刷新分类与物料数量 */
async function handleWarehouseChange() {
  form.value.categories = []
  try {
    const [catRes, matRes] = await Promise.all([
      materialApi.categories({ warehouse_id: form.value.warehouse_id }),
      materialApi.list({ warehouse_id: form.value.warehouse_id, page: 1, pageSize: 1 })
    ])
    categories.value = (catRes.data && catRes.data.list) || []
    materialTotal.value = (matRes.data && matRes.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载盘点范围失败')
  }
}

/** 仅小程序用户才有 openid，可作为盘点人员 */
async function loadAssignees() {
  try {
    const res = await userApi.list({ page: 1, pageSize: 200, status: 'active' })
    assignees.value = ((res.data && res.data.list) || []).filter((u) => u.openid)
  } catch (err) {
    console.warn('加载盘点人员失败:', err.message)
  }
}

async function handleSubmit() {
  if (!form.value.warehouse_id) {
    ElMessage.warning('请选择要盘点的仓库')
    return
  }

  // 没选分类 = 整仓盘点。物料多时明细可能上千条，先二次确认再放行
  const isFullScan = !(form.value.categories && form.value.categories.length)
  if (isFullScan) {
    try {
      await ElMessageBox.confirm(
        '你没有选择分类，这将盘点该仓库的全部物料，明细可能上千条、工作量很大。确定要整仓盘点吗？',
        '整仓盘点确认',
        {
          confirmButtonText: '确定整仓盘点',
          cancelButtonText: '我去选分类',
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
      scope: { categories: form.value.categories, material_ids: [] },
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
