<template>
  <div class="dashboard" v-loading="loading">
    <!-- 统计卡片 -->
    <el-row :gutter="20" class="stat-cards">
      <el-col :span="6" v-for="card in statCards" :key="card.title">
        <el-card class="stat-card" :body-style="{ padding: '20px' }">
          <div class="stat-icon" :style="{ background: card.color }">
            <el-icon :size="28" color="#fff"><component :is="card.icon" /></el-icon>
          </div>
          <div class="stat-info">
            <p class="stat-value">{{ card.value }}</p>
            <p class="stat-title">{{ card.title }}</p>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 待办提醒 -->
    <el-row :gutter="20" class="quick-actions">
      <el-col :span="24">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>待办提醒</span>
              <el-button size="small" @click="loadData">
                <el-icon><Refresh /></el-icon>刷新
              </el-button>
            </div>
          </template>
          <div class="pending-list">
            <el-tag type="warning" effect="plain">
              待确认出库单：{{ stats.pending_outbound || 0 }}
            </el-tag>
            <el-tag type="warning" effect="plain">
              待确认入库单：{{ stats.pending_inbound || 0 }}
            </el-tag>
            <el-tag type="danger" effect="plain">
              待审核用户：{{ stats.pending_users || 0 }}
            </el-tag>
            <el-tag type="danger" effect="plain">
              进行中盘点：{{ stats.pending_checks || 0 }}
            </el-tag>
            <el-tag type="info" effect="plain">
              零库存物料：{{ stats.zero_count || 0 }}
            </el-tag>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 快捷入口 -->
    <el-row :gutter="20" class="quick-actions">
      <el-col :span="24">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>快捷操作</span>
            </div>
          </template>
          <div class="action-buttons">
            <el-button type="primary" @click="$router.push('/order/outbound')">
              <el-icon><Download /></el-icon>出库单
            </el-button>
            <el-button type="success" @click="$router.push('/order/inbound')">
              <el-icon><Upload /></el-icon>入库单
            </el-button>
            <el-button type="warning" @click="$router.push('/check/create')">
              <el-icon><Checked /></el-icon>创建盘点
            </el-button>
            <el-button type="info" @click="$router.push('/material/list')">
              <el-icon><Box /></el-icon>物料管理
            </el-button>
            <el-button @click="$router.push('/user/list')">
              <el-icon><User /></el-icon>用户管理
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 预警提示 -->
    <el-row :gutter="20" v-if="warningList.length > 0">
      <el-col :span="24">
        <el-card>
          <template #header>
            <div class="card-header">
              <span class="warning-title">⚠️ 库存预警</span>
              <el-tag type="danger">{{ warningTotal }} 个物料</el-tag>
            </div>
          </template>
          <el-table :data="warningList" style="width: 100%">
            <el-table-column prop="name" label="物料名称" />
            <el-table-column prop="spec" label="规格" />
            <el-table-column prop="warehouse_name" label="仓库" width="120" />
            <el-table-column prop="current_stock" label="当前库存">
              <template #default="{ row }">
                <span class="danger-text">{{ row.current_stock }} {{ row.unit }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="warning_stock" label="预警库存" />
            <el-table-column prop="shortage" label="缺口" width="100" />
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button
                  size="small"
                  type="primary"
                  @click="$router.push({ path: '/material/list', query: { keyword: row.name } })"
                >
                  去查看
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 最近单据 -->
    <el-row :gutter="20" class="recent-orders">
      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>最近出库</span>
              <el-link type="primary" @click="$router.push('/order/outbound')">查看全部</el-link>
            </div>
          </template>
          <el-table :data="recentOutbound" style="width: 100%" size="small">
            <el-table-column prop="order_no" label="单号" width="150" />
            <el-table-column prop="material_names" label="物料" show-overflow-tooltip />
            <el-table-column prop="total_qty" label="数量" width="70" />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="statusTagType(row.status)" size="small">
                  {{ statusText(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="created_at" label="时间" width="100">
              <template #default="{ row }">
                {{ formatDate(row.created_at) }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>最近入库</span>
              <el-link type="primary" @click="$router.push('/order/inbound')">查看全部</el-link>
            </div>
          </template>
          <el-table :data="recentInbound" style="width: 100%" size="small">
            <el-table-column prop="order_no" label="单号" width="150" />
            <el-table-column prop="material_names" label="物料" show-overflow-tooltip />
            <el-table-column prop="total_qty" label="数量" width="70" />
            <el-table-column prop="total_amount" label="金额" width="100">
              <template #default="{ row }">
                ¥{{ row.total_amount }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Download,
  Upload,
  Checked,
  Box,
  User,
  TrendCharts,
  Warning,
  Refresh
} from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { statsApi } from '@/api'

const loading = ref(false)

const stats = ref({
  material_count: 0,
  total_stock: 0,
  total_value: 0,
  warning_count: 0,
  zero_count: 0,
  today_outbound_orders: 0,
  today_outbound_qty: 0,
  today_inbound_orders: 0,
  today_inbound_qty: 0,
  today_inbound_amount: 0,
  pending_outbound: 0,
  pending_inbound: 0,
  pending_users: 0,
  pending_checks: 0
})

const warningList = ref([])
const warningTotal = ref(0)
const recentOutbound = ref([])
const recentInbound = ref([])

/** 状态文案（单据状态：pending / confirmed / rejected / cancelled） */
function statusText(status) {
  const map = {
    pending: '待确认',
    confirmed: '已确认',
    rejected: '已驳回',
    cancelled: '已作废'
  }
  return map[status] || status
}

function statusTagType(status) {
  const map = {
    pending: 'warning',
    confirmed: 'success',
    rejected: 'danger',
    cancelled: 'info'
  }
  return map[status] || 'info'
}

function formatDate(date) {
  return date ? dayjs(date).format('MM-DD HH:mm') : '-'
}

async function loadData() {
  loading.value = true
  try {
    const [overviewRes, warningRes, outRes, inRes] = await Promise.all([
      statsApi.overview(),
      statsApi.warning({ page: 1, pageSize: 10 }),
      statsApi.orderFlow({ page: 1, pageSize: 5, type: 'outbound' }),
      statsApi.orderFlow({ page: 1, pageSize: 5, type: 'inbound' })
    ])

    stats.value = overviewRes.data || stats.value
    warningList.value = (warningRes.data && warningRes.data.list) || []
    warningTotal.value = (warningRes.data && warningRes.data.total) || 0
    recentOutbound.value = (outRes.data && outRes.data.list) || []
    recentInbound.value = (inRes.data && inRes.data.list) || []
  } catch (err) {
    ElMessage.error(err.message || '加载数据失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
})

const statCards = computed(() => [
  {
    // 命名统一（来自 4 角色使用者测试 P2-1-06）：
    // 这个值口径是「单数」，原来只写"今日出库"，老板误以为是出库数量；
    // 金额口径全站统一叫「库存价值」（台账/仓库对比/物料列表都是这个词）。
    title: '今日出库单数',
    value: stats.value.today_outbound_orders || 0,
    icon: Download,
    color: '#e74c3c'
  },
  {
    title: '今日入库单数',
    value: stats.value.today_inbound_orders || 0,
    icon: Upload,
    color: '#27ae60'
  },
  {
    title: '库存总量',
    value: stats.value.total_stock || 0,
    icon: Box,
    color: '#3498db'
  },
  {
    title: '库存价值',
    value: '¥' + Number(stats.value.total_value || 0).toLocaleString(),
    icon: TrendCharts,
    color: '#8A6A10'
  },
  {
    title: '预警物料',
    value: stats.value.warning_count || 0,
    icon: Warning,
    color: '#f39c12'
  }
])
</script>

<style scoped>
.dashboard {
  padding: 0;
}

.stat-cards {
  margin-bottom: 20px;
}

.stat-card {
  display: flex;
  align-items: center;
  border-radius: 12px;
  border: none;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  margin-bottom: 12px;
}

.stat-card :deep(.el-card__body) {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
}

.stat-icon {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.stat-info {
  flex: 1;
}

.stat-value {
  font-size: 24px;
  font-weight: bold;
  color: #1a1a2e;
  margin-bottom: 4px;
}

.stat-title {
  font-size: 13px;
  color: #999;
}

.quick-actions {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.warning-title {
  color: #f39c12;
}

.action-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.pending-list {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.danger-text {
  color: #e74c3c;
  font-weight: bold;
}

.recent-orders {
  margin-bottom: 20px;
}
</style>
