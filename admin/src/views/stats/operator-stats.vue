<template>
  <div class="operator-stats">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>人员绩效统计</span>
          <el-select v-model="days" size="small" style="width: 130px" @change="loadStats">
            <el-option :label="'近 7 天'" :value="7" />
            <el-option :label="'近 30 天'" :value="30" />
            <el-option :label="'近 90 天'" :value="90" />
          </el-select>
        </div>
      </template>

      <el-table :data="operatorList" style="width: 100%" v-loading="loading">
        <el-table-column prop="name" label="姓名" min-width="140" />
        <el-table-column prop="out_orders" label="出库单数" sortable width="120" />
        <el-table-column prop="out_qty" label="出库数量" sortable width="120" />
        <el-table-column prop="in_orders" label="入库单数" sortable width="120" />
        <el-table-column prop="in_amount" label="入库金额" sortable width="140">
          <template #default="{ row }">
            ¥{{ Number(row.in_amount || 0).toLocaleString() }}
          </template>
        </el-table-column>
        <el-table-column prop="check_tasks" label="盘点任务" sortable width="120" />
        <el-table-column prop="login_times" label="后台登录次数" sortable width="140" />
        <el-table-column prop="last_active" label="最后操作时间" width="160">
          <template #default="{ row }">
            {{ row.last_active ? formatDate(row.last_active) : '-' }}
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && operatorList.length === 0" description="所选时间范围内暂无操作记录" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import { statsApi } from '@/api'

const days = ref(30)
const loading = ref(false)
const operatorList = ref([])

function formatDate(date) {
  return date ? dayjs(date).format('MM-DD HH:mm') : '-'
}

/** 把 outbound / inbound / checks / logins 四份统计按「操作人」合并成一张表 */
function mergeByOperator(data) {
  const map = new Map()

  const ensure = (name) => {
    const key = name || '未署名'
    if (!map.has(key)) {
      map.set(key, {
        name: key,
        out_orders: 0,
        out_qty: 0,
        in_orders: 0,
        in_amount: 0,
        check_tasks: 0,
        login_times: 0,
        last_active: null
      })
    }
    return map.get(key)
  }

  for (const r of data.outbound || []) {
    const row = ensure(r.operator_name)
    row.out_orders += Number(r.orders || 0)
    row.out_qty += Number(r.qty || 0)
  }
  for (const r of data.inbound || []) {
    const row = ensure(r.operator_name)
    row.in_orders += Number(r.orders || 0)
    row.in_amount += Number(r.amount || 0)
  }
  for (const r of data.checks || []) {
    ensure(r.operator_name).check_tasks += Number(r.tasks || 0)
  }
  for (const r of data.logins || []) {
    const row = ensure(r.user_name)
    row.login_times += Number(r.times || 0)
    if (r.last_at && (!row.last_active || dayjs(r.last_at).isAfter(dayjs(row.last_active)))) {
      row.last_active = r.last_at
    }
  }

  return Array.from(map.values()).sort((a, b) => b.out_orders + b.in_orders - (a.out_orders + a.in_orders))
}

async function loadStats() {
  loading.value = true
  try {
    const res = await statsApi.operatorStats({ days: days.value })
    operatorList.value = mergeByOperator(res.data || {})
  } catch (err) {
    ElMessage.error(err.message || '加载人员绩效失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadStats()
})
</script>

<style scoped>
.operator-stats {
  padding: 0;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
