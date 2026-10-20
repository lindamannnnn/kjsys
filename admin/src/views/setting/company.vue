<template>
  <div class="setting-company">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>系统设置</span>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <!-- 仓库管理 -->
        <el-tab-pane label="仓库管理" name="warehouse">
          <el-alert type="info" :closable="false" class="tip-alert">
            <p>物料按仓库分档管理（配件仓 / 成品仓）。仓库编码创建后不可修改，库存数据实时统计。</p>
          </el-alert>

          <div class="toolbar">
            <el-button type="primary" size="small" @click="handleAdd">
              <el-icon><Plus /></el-icon>新增仓库
            </el-button>
            <el-button size="small" :loading="loading" @click="loadAll">刷新</el-button>
          </div>

          <el-table :data="warehouseList" style="width: 100%" v-loading="loading">
            <el-table-column prop="code" label="仓库编码" width="140" />
            <el-table-column prop="name" label="仓库名称" min-width="140" />
            <el-table-column prop="material_count" label="物料数" width="110" sortable />
            <el-table-column prop="total_stock" label="库存总量" width="120" sortable />
            <el-table-column prop="total_value" label="库存价值" width="140" sortable>
              <template #default="{ row }">
                ¥{{ Number(row.total_value || 0).toLocaleString() }}
              </template>
            </el-table-column>
            <el-table-column prop="warning_count" label="预警物料" width="110" sortable>
              <template #default="{ row }">
                <el-tag :type="row.warning_count > 0 ? 'danger' : 'success'" size="small">
                  {{ row.warning_count }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="sort_order" label="排序" width="90" />
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" size="small" @click="handleEdit(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 角色与权限说明 -->
        <el-tab-pane label="角色与权限" name="roles">
          <el-table :data="ROLES" style="width: 100%">
            <el-table-column prop="label" label="角色名称" width="140">
              <template #default="{ row }">
                <el-tag :type="row.tag" size="small">{{ row.label }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="value" label="角色编码" width="130" />
            <el-table-column prop="description" label="权限说明" />
          </el-table>
          <div class="tip">角色为系统内置，如需调整请到「用户管理」中为用户分配角色。</div>
        </el-tab-pane>

        <!-- 期初建账模式（2026-10-20）：上线初期由客户自己填数量与金额，填完关掉 -->
        <el-tab-pane label="期初建账" name="opening">
          <el-alert type="warning" :closable="false" class="tip-alert">
            <p>
              <b>这是上线初期用的一次性开关。</b>开启后，「编辑物料」页会多出
              <b>「期初数量」</b>和<b>「期初金额」</b>两格，客户可以对着自己现有的表格一条条填。
            </p>
            <p>
              填完请把它关掉：关掉后字段消失，<b>接口也会同步拒绝写入</b>（不是只把界面藏起来）。
            </p>
            <p>
              填写时会真实改动库存，并在「库存流水」留下 <code>opening</code> 类型的记录
              （含操作人与时间），不是直接改数字。
            </p>
          </el-alert>

          <div class="opening-row">
            <span class="opening-label">期初建账录入模式</span>
            <el-switch
              v-model="openingEnabled"
              :loading="openingSaving"
              :disabled="!canEditOpening"
              active-text="已开启"
              inactive-text="已关闭"
              @change="handleToggleOpening"
            />
            <span v-if="!canEditOpening" class="tip">只有管理员或老板可以改这个开关。</span>
          </div>

          <div v-if="openingEnabled" class="opening-hint">
            现在可以到「物料管理 → 配件仓/成品仓 → 编辑」里填期初数量与金额了。
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 新增 / 编辑仓库 -->
    <el-dialog v-model="dialogVisible" :title="form._id ? '编辑仓库' : '新增仓库'" width="480px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="仓库编码" required>
          <el-input
            v-model="form.code"
            placeholder="如 peijian / chengpin"
            :disabled="!!form._id"
          />
          <div v-if="form._id" class="tip">仓库编码创建后不可修改</div>
        </el-form-item>
        <el-form-item label="仓库名称" required>
          <el-input v-model="form.name" placeholder="如 配件仓" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort_order" :min="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { warehouseApi, statsApi, materialApi } from '@/api'
import { ROLES } from '@/constants/roles'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const activeTab = ref('warehouse')
const loading = ref(false)
const submitting = ref(false)

/* ---------------- 期初建账开关 ---------------- */
const openingEnabled = ref(false)
const openingSaving = ref(false)
/** 只有 admin / boss 能改（后端 roleRules 同口径，前端只是别让人白点） */
const canEditOpening = computed(() => {
  const roles = userStore.roles || []
  return roles.includes('admin') || roles.includes('boss')
})

async function loadOpeningMode() {
  try {
    const res = await materialApi.getOpeningMode()
    const d = res.data || {}
    openingEnabled.value = !!d.enabled
  } catch (e) {
    console.warn('读取期初建账开关失败:', e.message)
  }
}

async function handleToggleOpening(val) {
  openingSaving.value = true
  try {
    const res = await materialApi.setOpeningMode({ enabled: val })
    ElMessage.success(res.message || '已更新')
    await loadOpeningMode()
  } catch (e) {
    // 失败要把开关拨回去，不能让界面显示成"已开启"但其实没生效
    openingEnabled.value = !val
    ElMessage.error(e.message || '切换失败')
  } finally {
    openingSaving.value = false
  }
}

const warehouseList = ref([])

const dialogVisible = ref(false)
const form = ref({ _id: '', code: '', name: '', sort_order: 0 })

/**
 * 仓库列表用 warehouseApi.list（含物料数/库存），
 * 价值与预警数由 statsApi.warehouseSummary 补齐
 */
async function loadAll() {
  loading.value = true
  try {
    const [whRes, sumRes] = await Promise.all([
      warehouseApi.list(),
      statsApi.warehouseSummary()
    ])
    const list = (whRes.data && whRes.data.list) || []
    const summaryMap = new Map(
      ((sumRes.data && sumRes.data.list) || []).map((s) => [s._id, s])
    )
    warehouseList.value = list.map((w) => ({
      ...w,
      total_value: summaryMap.has(w._id) ? summaryMap.get(w._id).total_value : w.total_value || 0,
      warning_count: summaryMap.has(w._id) ? summaryMap.get(w._id).warning_count : w.warning_count || 0
    }))
  } catch (err) {
    ElMessage.error(err.message || '加载仓库失败')
  } finally {
    loading.value = false
  }
}

function handleAdd() {
  form.value = { _id: '', code: '', name: '', sort_order: (warehouseList.value.length + 1) }
  dialogVisible.value = true
}

function handleEdit(row) {
  form.value = {
    _id: row._id,
    code: row.code,
    name: row.name,
    sort_order: Number(row.sort_order || 0)
  }
  dialogVisible.value = true
}

async function confirmSave() {
  if (!form.value.name || !String(form.value.name).trim()) {
    ElMessage.warning('请输入仓库名称')
    return
  }
  if (!form.value._id && !form.value.code) {
    ElMessage.warning('请输入仓库编码')
    return
  }

  submitting.value = true
  try {
    const payload = { name: form.value.name, sort_order: form.value.sort_order }
    if (form.value._id) payload._id = form.value._id
    else payload.code = form.value.code

    const res = await warehouseApi.upsert(payload)
    ElMessage.success(res.message || '保存成功')
    dialogVisible.value = false
    loadAll()
  } catch (err) {
    ElMessage.error(err.message || '保存失败')
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  loadAll()
  // 开关状态必须从后端读，不能默认成"已关闭"——否则客户明明开着，
  // 管理页却显示关闭，会让人以为要重新开一次
  loadOpeningMode()
})
</script>

<style scoped>
.setting-company {
  padding: 0;
}

.card-header {
  font-weight: 600;
}

.tip-alert {
  margin-bottom: 16px;
}

.toolbar {
  margin-bottom: 12px;
}

.tip {
  font-size: 12px;
  color: #999;
  line-height: 1.6;
}

/* 期初建账开关 */
.opening-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0 12px;
}

.opening-label {
  font-weight: 600;
  color: #303133;
}

.opening-hint {
  margin-top: 4px;
  padding: 10px 12px;
  background: #f0f9eb;
  border-left: 3px solid #67c23a;
  border-radius: 4px;
  font-size: 13px;
  color: #529b2e;
}
</style>
