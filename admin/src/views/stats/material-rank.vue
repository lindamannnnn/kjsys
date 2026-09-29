<template>
  <div class="material-rank">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>物料出入库排行</span>
          <div class="header-actions">
            <el-select v-model="days" size="small" style="width: 120px" @change="loadRank">
              <el-option :label="'近 7 天'" :value="7" />
              <el-option :label="'近 30 天'" :value="30" />
              <el-option :label="'近 90 天'" :value="90" />
            </el-select>
            <el-radio-group v-model="rankType" size="small" @change="loadRank">
              <el-radio-button value="outbound">出库排行</el-radio-button>
              <el-radio-button value="inbound">入库排行</el-radio-button>
            </el-radio-group>
          </div>
        </div>
      </template>

      <el-table :data="rankList" style="width: 100%" v-loading="loading">
        <el-table-column type="index" label="排名" width="80" />
        <el-table-column prop="material_name" label="物料名称" min-width="160" />
        <el-table-column prop="qty" label="数量" sortable width="140">
          <template #default="{ row }">
            {{ formatNum(row.qty) }}
          </template>
        </el-table-column>
        <el-table-column v-if="rankType === 'inbound'" prop="amount" label="金额" sortable width="160">
          <template #default="{ row }">
            ¥{{ Number(row.amount || 0).toLocaleString() }}
          </template>
        </el-table-column>
        <el-table-column v-else prop="orders" label="涉及单据数" sortable width="140" />
      </el-table>

      <el-empty v-if="!loading && rankList.length === 0" description="所选时间范围内暂无出入库记录" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { statsApi } from '@/api'

const rankType = ref('outbound')
const days = ref(30)
const loading = ref(false)

const outboundList = ref([])
const inboundList = ref([])

const rankList = computed(() =>
  rankType.value === 'inbound' ? inboundList.value : outboundList.value
)

function formatNum(v) {
  const n = Number(v || 0)
  return Number.isInteger(n) ? n : n.toFixed(3)
}

async function loadRank() {
  loading.value = true
  try {
    const res = await statsApi.materialRank({ days: days.value, limit: 50 })
    const data = res.data || {}
    outboundList.value = data.outbound || []
    inboundList.value = data.inbound || []
  } catch (err) {
    ElMessage.error(err.message || '加载排行失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadRank()
})
</script>

<style scoped>
.material-rank {
  padding: 0;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}
</style>
