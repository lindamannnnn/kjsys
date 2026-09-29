<template>
  <div class="logs-page">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="title">操作日志</span>
          <div class="header-actions">
            <span class="hint">谁在什么时候做了什么，都在这里</span>
            <el-button type="primary" plain :loading="exporting" @click="exportCsv">导出</el-button>
          </div>
        </div>
      </template>

      <!-- 筛选 -->
      <el-form :inline="true" class="filter-form">
        <el-form-item label="关键词">
          <el-input
            v-model="query.keyword"
            placeholder="操作人 / 内容 / 单据号"
            clearable
            style="width: 220px"
            @keyup.enter="search"
          />
        </el-form-item>

        <el-form-item label="动作">
          <el-select v-model="query.action" placeholder="全部动作" clearable style="width: 190px">
            <el-option
              v-for="a in actionOptions"
              :key="a.value"
              :label="a.label"
              :value="a.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="时间">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 260px"
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" @click="search">查询</el-button>
          <el-button @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="list" v-loading="loading" border stripe>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>

        <el-table-column prop="user_name" label="操作人" width="130">
          <template #default="{ row }">{{ row.user_name || '—' }}</template>
        </el-table-column>

        <el-table-column label="角色" width="110">
          <template #default="{ row }">{{ roleText(row.role) }}</template>
        </el-table-column>

        <el-table-column label="动作" width="140">
          <template #default="{ row }">{{ actionText(row.action) }}</template>
        </el-table-column>

        <el-table-column prop="detail" label="内容" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">{{ row.detail || '—' }}</template>
        </el-table-column>

        <el-table-column label="对象" width="110">
          <template #default="{ row }">
            <span v-if="row.target_type || row.target_id">
              {{ targetText(row.target_type) }}{{ row.target_id ? ' #' + row.target_id : '' }}
            </span>
            <span v-else>—</span>
          </template>
        </el-table-column>

        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <el-tag :type="isFail(row.result) ? 'danger' : 'success'" size="small">
              {{ isFail(row.result) ? '失败' : '成功' }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="ip" label="IP" width="130">
          <template #default="{ row }">{{ row.ip || '—' }}</template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pager"
        background
        layout="total, sizes, prev, pager, next, jumper"
        :total="total"
        :current-page="query.page"
        :page-size="query.pageSize"
        :page-sizes="[20, 50, 100, 200]"
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { userApi, exportApi } from '@/api'
import { roleLabel } from '@/constants/roles'

/** 动作 → 中文（与后端写入 operation_logs.action 的值一一对应） */
const ACTION_TEXT = {
  login: '小程序登录',
  register: '注册申请',
  admin_login: '后台登录',
  change_password: '修改密码',
  outbound_submit: '提交出库单',
  outbound_confirm: '确认出库单',
  outbound_cancel: '撤销出库单',
  outbound_reject: '驳回出库单',
  inbound_submit: '提交入库单',
  inbound_confirm: '确认入库单',
  inbound_cancel: '作废入库单',
  inbound_update_price: '修改入库单价',
  check_create: '创建盘点单',
  check_submit: '提交盘点结果',
  check_review: '审核盘点单',
  check_review_reject: '退回盘点单',
  check_cancel: '取消盘点单',
  user_approve: '审核用户',
  user_create: '新增用户',
  user_reset_password: '重置用户密码',
  user_update_role: '调整用户角色'
}

/** 对象类型 → 中文 */
const TARGET_TEXT = {
  user: '用户',
  order: '单据',
  material: '物料',
  check: '盘点单',
  supplier: '供应商',
  warehouse: '仓库'
}

const list = ref([])
const total = ref(0)
const loading = ref(false)
const exporting = ref(false)
const dateRange = ref([])
const actionOptions = ref([])
const query = ref({ page: 1, pageSize: 20, keyword: '', action: '' })

function actionText(a) {
  return ACTION_TEXT[a] || a || '—'
}

function targetText(t) {
  return TARGET_TEXT[t] || t || '对象'
}

function roleText(role) {
  if (!role) return '—'
  // role 字段可能是单个角色，也可能被存成 "a,b"
  return String(role)
    .split(',')
    .map((r) => roleLabel(r.trim()))
    .filter(Boolean)
    .join(' / ')
}

function isFail(result) {
  return String(result || '').toLowerCase() === 'fail'
}

function formatTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function buildParams() {
  const params = {
    page: query.value.page,
    pageSize: query.value.pageSize,
    keyword: query.value.keyword,
    action: query.value.action
  }
  if (Array.isArray(dateRange.value) && dateRange.value.length === 2) {
    params.startDate = dateRange.value[0]
    params.endDate = dateRange.value[1]
  }
  return params
}

async function load() {
  loading.value = true
  try {
    const res = await userApi.logs(buildParams())
    const data = res.data || {}
    list.value = data.list || []
    total.value = data.total || 0

    // 动作下拉：首次加载时按已有日志聚合出来，并带上条数
    if (Array.isArray(data.actions) && data.actions.length) {
      actionOptions.value = data.actions.map((a) => ({
        value: a.action,
        label: `${actionText(a.action)}（${a.c}）`
      }))
    }
  } catch (err) {
    ElMessage.error(err.message || '加载失败')
  } finally {
    loading.value = false
  }
}

function search() {
  query.value.page = 1
  load()
}

function resetQuery() {
  query.value = { page: 1, pageSize: query.value.pageSize, keyword: '', action: '' }
  dateRange.value = []
  load()
}

function onPageChange(page) {
  query.value.page = page
  load()
}

function onSizeChange(size) {
  query.value.pageSize = size
  query.value.page = 1
  load()
}

async function exportCsv() {
  exporting.value = true
  try {
    const res = await exportApi.csv({
      module: 'user',
      action: 'logs',
      params: buildParams(),
      filename: `操作日志_${new Date().toISOString().slice(0, 10)}.csv`,
      columns: [
        'created_at',
        'user_name',
        'role',
        'action',
        'detail',
        'target_type',
        'target_id',
        'result',
        'ip'
      ]
    })
    ElMessage.success(`已导出 ${res.count} 条`)
  } catch (err) {
    ElMessage.error(err.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-header .title {
  font-size: 16px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-actions .hint {
  font-size: 12px;
  color: #909399;
}

.filter-form {
  margin-bottom: 8px;
}

.pager {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
