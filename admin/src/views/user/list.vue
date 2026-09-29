<template>
  <div class="user-list">
    <!-- 搜索栏 -->
    <el-card class="search-card">
      <el-form :inline="true" :model="searchForm">
        <el-form-item label="关键词">
          <el-input v-model="searchForm.keyword" placeholder="姓名/手机号/账号" clearable />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="searchForm.role" placeholder="全部角色" clearable>
            <el-option v-for="r in ROLES" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable>
            <el-option label="正常" value="active" />
            <el-option label="待审核" value="pending" />
            <el-option label="已禁用" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">搜索</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" :loading="exporting" @click="handleExport">导出 CSV</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 用户列表 -->
    <el-card class="table-card">
      <template #header>
        <div class="card-header">
          <span>用户列表</span>
          <el-button type="primary" size="small" @click="handleAdd">
            <el-icon><Plus /></el-icon>新增用户
          </el-button>
        </div>
      </template>

      <el-table :data="userList" style="width: 100%" v-loading="loading">
        <el-table-column prop="avatar" label="头像" width="80">
          <template #default="{ row }">
            <el-avatar :size="40" :src="row.avatar">
              {{ (row.real_name || row.nickname || row.username || 'U').charAt(0) }}
            </el-avatar>
          </template>
        </el-table-column>
        <el-table-column prop="real_name" label="姓名" width="120">
          <template #default="{ row }">
            {{ row.real_name || '—' }}
          </template>
        </el-table-column>
        <el-table-column prop="username" label="登录账号" width="140">
          <template #default="{ row }">
            {{ row.username || '（小程序用户）' }}
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="130" />
        <el-table-column label="角色" min-width="180">
          <template #default="{ row }">
            <el-tag
              v-for="role in row.roles"
              :key="role"
              :type="roleTag(role)"
              size="small"
              style="margin-right: 4px"
            >
              {{ roleLabel(role) }}
            </el-tag>
            <span v-if="!row.roles || !row.roles.length" class="muted">未分配</span>
          </template>
        </el-table-column>
        <el-table-column label="可操作仓库" min-width="140">
          <template #default="{ row }">
            {{ warehouseNames(row.warehouse_ids) }}
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="STATUS_TAG[row.status] || 'info'" size="small">
              {{ STATUS_TEXT[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="last_login_at" label="最后登录" width="150">
          <template #default="{ row }">
            {{ formatDate(row.last_login_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'pending'" type="success" size="small" @click="handleApprove(row)">
              审核
            </el-button>
            <el-button type="primary" size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button size="small" @click="handleResetPassword(row)">重置密码</el-button>
            <el-button
              v-if="row.status === 'active'"
              type="danger"
              size="small"
              @click="handleDisable(row)"
            >
              禁用
            </el-button>
            <el-button
              v-else-if="row.status === 'disabled'"
              type="success"
              size="small"
              @click="handleEnable(row)"
            >
              启用
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
        @size-change="loadUsers"
        @current-change="loadUsers"
      />
    </el-card>

    <!-- 审核弹窗 -->
    <el-dialog v-model="approveDialogVisible" title="审核用户" width="520px">
      <el-form :model="approveForm" label-width="100px">
        <el-form-item label="用户">
          <span>{{ approveForm.real_name || approveForm.nickname || approveForm.username }}</span>
        </el-form-item>
        <el-form-item label="分配角色" required>
          <el-checkbox-group v-model="approveForm.roles">
            <el-checkbox v-for="r in ROLES" :key="r.value" :value="r.value">
              {{ r.label }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="可操作仓库">
          <el-checkbox-group v-model="approveForm.warehouse_ids">
            <el-checkbox v-for="w in warehouses" :key="w._id" :value="w._id">
              {{ w.name }}
            </el-checkbox>
          </el-checkbox-group>
          <div class="tip">不勾选表示不限制仓库</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="approveDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmApprove">确认审核通过</el-button>
      </template>
    </el-dialog>

    <!-- 新增 / 编辑弹窗 -->
    <el-dialog v-model="formDialogVisible" :title="form._id ? '编辑用户' : '新增用户'" width="520px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="登录账号">
          <el-input v-model="form.username" placeholder="登录用的账号" />
        </el-form-item>
        <el-form-item v-if="!form._id" label="初始密码">
          <el-input v-model="form.password" placeholder="不少于 6 位" show-password />
        </el-form-item>
        <el-form-item label="真实姓名" required>
          <el-input v-model="form.real_name" placeholder="请输入真实姓名" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="form.phone" placeholder="选填" />
        </el-form-item>
        <el-form-item label="角色" required>
          <el-checkbox-group v-model="form.roles">
            <el-checkbox v-for="r in ROLES" :key="r.value" :value="r.value">
              {{ r.label }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="可操作仓库">
          <el-checkbox-group v-model="form.warehouse_ids">
            <el-checkbox v-for="w in warehouses" :key="w._id" :value="w._id">
              {{ w.name }}
            </el-checkbox>
          </el-checkbox-group>
          <div class="tip">不勾选表示不限制仓库</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmForm">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { userApi, warehouseApi, exportApi } from '@/api'
import { ROLES, STATUS_TEXT, STATUS_TAG, roleLabel, roleTag } from '@/constants/roles'

const loading = ref(false)
const submitting = ref(false)
const exporting = ref(false)
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)

const searchForm = ref({
  keyword: '',
  role: '',
  status: ''
})

const userList = ref([])
const warehouses = ref([])

const approveDialogVisible = ref(false)
const approveForm = ref({
  _id: '',
  real_name: '',
  nickname: '',
  username: '',
  roles: [],
  warehouse_ids: []
})

const formDialogVisible = ref(false)
const form = ref({
  _id: '',
  username: '',
  password: '',
  real_name: '',
  phone: '',
  roles: [],
  warehouse_ids: []
})

/** 仓库 id 统一为数字，兼容后端返回字符串的情况 */
function normalizeIds(list) {
  return (list || []).map((v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v))
}

function warehouseNames(ids) {
  if (!ids || !ids.length) return '全部'
  return ids
    .map((id) => {
      const w = warehouses.value.find((x) => x._id === id)
      return w ? w.name : id
    })
    .join('、')
}

function formatDate(date) {
  return date ? dayjs(date).format('MM-DD HH:mm') : '从未登录'
}

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
  } catch (err) {
    ElMessage.error(err.message || '加载仓库失败')
  }
}

async function loadUsers() {
  loading.value = true
  try {
    const res = await userApi.list({
      page: page.value,
      pageSize: pageSize.value,
      keyword: searchForm.value.keyword || undefined,
      role: searchForm.value.role || undefined,
      status: searchForm.value.status || undefined
    })
    userList.value = (res.data && res.data.list) || []
    total.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载用户失败')
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  loadUsers()
}

function resetSearch() {
  searchForm.value = { keyword: '', role: '', status: '' }
  page.value = 1
  loadUsers()
}

async function handleExport() {
  exporting.value = true
  try {
    const r = await exportApi.csv({
      module: 'user',
      action: 'list',
      params: {
        keyword: searchForm.value.keyword || undefined,
        role: searchForm.value.role || undefined,
        status: searchForm.value.status || undefined
      },
      filename: `用户列表_${dayjs().format('YYYYMMDD_HHmm')}.csv`,
      columns: ['real_name', 'username', 'phone', 'roles', 'warehouse_ids', 'status', 'last_login_at', 'created_at']
    })
    ElMessage.success(`已导出 ${r.count} 条`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

/* ---------------- 新增 / 编辑 ---------------- */
function handleAdd() {
  form.value = {
    _id: '',
    username: '',
    password: '',
    real_name: '',
    phone: '',
    roles: [],
    warehouse_ids: []
  }
  formDialogVisible.value = true
}

function handleEdit(row) {
  form.value = {
    _id: row._id,
    username: row.username || '',
    password: '',
    real_name: row.real_name || '',
    phone: row.phone || '',
    roles: [...(row.roles || [])],
    warehouse_ids: normalizeIds(row.warehouse_ids)
  }
  formDialogVisible.value = true
}

async function confirmForm() {
  if (!form.value.real_name) {
    ElMessage.warning('请输入真实姓名')
    return
  }
  if (!form.value.roles.length) {
    ElMessage.warning('请至少分配一个角色')
    return
  }

  submitting.value = true
  try {
    if (form.value._id) {
      // 编辑：基础资料 + 角色/仓库
      await userApi.update({
        id: form.value._id,
        real_name: form.value.real_name,
        phone: form.value.phone,
        username: form.value.username || undefined
      })
      await userApi.updateRole({
        id: form.value._id,
        roles: form.value.roles,
        warehouse_ids: form.value.warehouse_ids
      })
      ElMessage.success('保存成功')
    } else {
      if (!form.value.username) {
        ElMessage.warning('请输入登录账号')
        submitting.value = false
        return
      }
      if (!form.value.password || form.value.password.length < 6) {
        ElMessage.warning('初始密码不能少于 6 位')
        submitting.value = false
        return
      }
      await userApi.create({
        username: form.value.username,
        password: form.value.password,
        real_name: form.value.real_name,
        phone: form.value.phone,
        roles: form.value.roles,
        warehouse_ids: form.value.warehouse_ids
      })
      ElMessage.success('账号创建成功')
    }
    formDialogVisible.value = false
    loadUsers()
  } catch (err) {
    ElMessage.error(err.message || '保存失败')
  } finally {
    submitting.value = false
  }
}

/* ---------------- 审核 ---------------- */
function handleApprove(row) {
  approveForm.value = {
    _id: row._id,
    real_name: row.real_name,
    nickname: row.nickname,
    username: row.username,
    roles: [...(row.roles || [])],
    warehouse_ids: normalizeIds(row.warehouse_ids)
  }
  approveDialogVisible.value = true
}

async function confirmApprove() {
  if (approveForm.value.roles.length === 0) {
    ElMessage.warning('请至少分配一个角色')
    return
  }

  submitting.value = true
  try {
    await userApi.approve({
      id: approveForm.value._id,
      roles: approveForm.value.roles,
      warehouse_ids: approveForm.value.warehouse_ids
    })
    ElMessage.success('审核通过')
    approveDialogVisible.value = false
    loadUsers()
  } catch (err) {
    ElMessage.error(err.message || '审核失败')
  } finally {
    submitting.value = false
  }
}

/* ---------------- 重置密码 ---------------- */
async function handleResetPassword(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `为用户「${row.real_name || row.username}」设置新密码`,
      '重置密码',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputPlaceholder: '不少于 6 位',
        inputValidator: (v) => (v && v.length >= 6) || '密码不能少于 6 位'
      }
    )
    await userApi.resetPassword({ id: row._id, new_password: value })
    ElMessage.success('密码已重置')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '重置密码失败')
    }
  }
}

/* ---------------- 禁用 / 启用 ---------------- */
async function handleDisable(row) {
  try {
    await ElMessageBox.confirm(
      `确定要禁用用户「${row.real_name || row.username}」吗？`,
      '提示',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
    await userApi.disable({ id: row._id })
    ElMessage.success('已禁用')
    loadUsers()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '禁用失败')
    }
  }
}

async function handleEnable(row) {
  try {
    await userApi.enable({ id: row._id })
    ElMessage.success('已启用')
    loadUsers()
  } catch (err) {
    ElMessage.error(err.message || '启用失败')
  }
}

onMounted(() => {
  loadWarehouses()
  loadUsers()
})
</script>

<style scoped>
.user-list {
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

.tip {
  font-size: 12px;
  color: #999;
  line-height: 1.6;
}

.muted {
  color: #c0c4cc;
}
</style>
