<template>
  <div class="role-list">
    <el-card class="role-card">
      <template #header>
        <div class="card-header">
          <span>角色管理</span>
          <span class="muted">系统内置 6 种固定角色，不支持自定义新增/删除</span>
        </div>
      </template>

      <el-table :data="roleList" style="width: 100%" v-loading="loading">
        <el-table-column prop="label" label="角色名称" width="140">
          <template #default="{ row }">
            <el-tag :type="row.tag" size="small">{{ row.label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="value" label="角色编码" width="130" />
        <el-table-column prop="description" label="权限说明" min-width="300" />
        <el-table-column prop="user_count" label="用户数" width="100" sortable />
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click="filterByRole(row.value)">
              查看用户
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="user-card">
      <template #header>
        <div class="card-header">
          <span>
            该角色下的用户
            <el-tag v-if="activeRole" size="small" style="margin-left: 8px">{{ activeRoleLabel }}</el-tag>
          </span>
          <div>
            <el-select
              v-model="activeRole"
              placeholder="全部角色"
              clearable
              size="small"
              style="width: 160px; margin-right: 8px"
              @change="handleRoleChange"
            >
              <el-option v-for="r in ROLES" :key="r.value" :label="r.label" :value="r.value" />
            </el-select>
            <el-button size="small" @click="loadUsers">刷新</el-button>
          </div>
        </div>
      </template>

      <el-table :data="userList" style="width: 100%" v-loading="userLoading">
        <el-table-column prop="real_name" label="姓名" width="140">
          <template #default="{ row }">
            {{ row.real_name || '—' }}
          </template>
        </el-table-column>
        <el-table-column prop="username" label="登录账号" width="160">
          <template #default="{ row }">
            {{ row.username || '（小程序用户）' }}
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="140" />
        <el-table-column label="角色" min-width="200">
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
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="STATUS_TAG[row.status] || 'info'" size="small">
              {{ STATUS_TEXT[row.status] || row.status }}
            </el-tag>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { userApi } from '@/api'
import { ROLES, STATUS_TEXT, STATUS_TAG, roleLabel, roleTag } from '@/constants/roles'

const loading = ref(false)
const userLoading = ref(false)

const roleList = ref(ROLES.map((r) => ({ ...r, user_count: 0 })))

const activeRole = ref('')
const userList = ref([])
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)

const activeRoleLabel = computed(() => roleLabel(activeRole.value))

/** 统计每个角色下的用户数（后端支持 role 参数精确筛选） */
async function loadRoleCounts() {
  loading.value = true
  try {
    const results = await Promise.all(
      ROLES.map((r) => userApi.list({ role: r.value, page: 1, pageSize: 1 }))
    )
    roleList.value = ROLES.map((r, i) => ({
      ...r,
      user_count: (results[i].data && results[i].data.total) || 0
    }))
  } catch (err) {
    ElMessage.error(err.message || '加载角色统计失败')
  } finally {
    loading.value = false
  }
}

async function loadUsers() {
  userLoading.value = true
  try {
    const res = await userApi.list({
      page: page.value,
      pageSize: pageSize.value,
      role: activeRole.value || undefined
    })
    userList.value = (res.data && res.data.list) || []
    total.value = (res.data && res.data.total) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载用户失败')
  } finally {
    userLoading.value = false
  }
}

function filterByRole(role) {
  activeRole.value = role
  page.value = 1
  loadUsers()
}

function handleRoleChange() {
  page.value = 1
  loadUsers()
}

onMounted(() => {
  loadRoleCounts()
  loadUsers()
})
</script>

<style scoped>
.role-list {
  padding: 0;
}

.role-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.muted {
  font-size: 12px;
  color: #999;
  font-weight: normal;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}
</style>
