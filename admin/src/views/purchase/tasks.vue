<template>
  <div class="purchase-tasks">
    <!-- 概览：一眼看到哪一摊活卡在谁手上 -->
    <el-row :gutter="16" class="stat-row">
      <el-col v-for="(s, i) in statCards" :key="s.key" :span="4" :offset="i === 0 ? 2 : 0">
        <el-card class="stat-card" shadow="never" @click="filterByStatus(s.key)">
          <div class="stat-label">{{ s.label }}</div>
          <div class="stat-value" :style="{ color: s.color }">{{ stats[s.key] || 0 }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="search-card">
      <el-form :inline="true" :model="searchForm">
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable style="width: 140px">
            <el-option v-for="(label, val) in STATUS_TEXT" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>
        <el-form-item label="仓库">
          <el-select v-model="searchForm.warehouse_id" placeholder="全部仓库" clearable style="width: 160px">
            <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input
            v-model="searchForm.keyword"
            placeholder="任务号 / 发布人 / 采购员"
            clearable
            style="width: 220px"
            @keyup.enter="handleSearch"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">搜索</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button v-if="canCreate" type="success" @click="openCreate">＋ 发布采购任务</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="table-card">
      <el-table :data="taskList" style="width: 100%" v-loading="loading">
        <el-table-column prop="task_no" label="任务号" width="170" />
        <el-table-column prop="warehouse_name" label="仓库" width="100" />
        <el-table-column label="物料明细" min-width="220">
          <template #default="{ row }">{{ itemsSummary(row) }}</template>
        </el-table-column>
        <el-table-column label="项数" width="70" align="center">
          <template #default="{ row }">{{ row.item_count || (row.items || []).length }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="采购员" width="110">
          <template #default="{ row }">
            <span v-if="row.taker_name">{{ row.taker_name }}</span>
            <el-tag v-else-if="row.assignee_name" type="info" size="small">指定：{{ row.assignee_name }}</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <!-- 金额：仓管端不展示（后端 purchase.list 已脱敏） -->
        <el-table-column v-if="canSeeCost" label="实际金额" width="110" align="right">
          <template #default="{ row }">
            {{ Number(row.total_amount) > 0 ? `¥${Number(row.total_amount).toFixed(2)}` : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="购买方式" width="100">
          <template #default="{ row }">{{ row.purchase_channel || '-' }}</template>
        </el-table-column>
        <el-table-column prop="created_at" label="发布时间" width="140">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openDetail(row)">查看</el-button>
            <el-button v-if="row.can_take" type="primary" size="small" @click="handleTake(row)">领取</el-button>
            <el-button
              v-if="row.status === 'taken' && row.is_mine"
              type="primary"
              size="small"
              @click="openEntry(row)"
            >
              采购录入
            </el-button>
            <el-button
              v-if="['purchased', 'receiving'].includes(row.status) && canStore"
              type="success"
              size="small"
              @click="openReceive(row)"
            >
              收料入库
            </el-button>
            <el-button
              v-if="row.status === 'purchased' && canStore"
              type="warning"
              size="small"
              @click="handleRejectBack(row)"
            >
              退回
            </el-button>
            <el-button
              v-if="canCancelTask(row) && canStore"
              type="danger"
              size="small"
              @click="handleCancel(row)"
            >
              取消
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
        @size-change="loadTasks"
        @current-change="loadTasks"
      />
    </el-card>

    <!-- 发布采购任务 -->
    <el-dialog v-model="createVisible" title="发布采购任务" width="780px">
      <el-form :model="createForm" label-width="90px">
        <el-form-item label="目标仓库">
          <el-select v-model="createForm.warehouse_id" placeholder="选择要采购到哪个仓" style="width: 240px">
            <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="指定采购员">
          <el-select
            v-model="createForm.assignee_openid"
            placeholder="不指定 = 全体采购员都可领"
            clearable
            style="width: 240px"
          >
            <el-option v-for="a in assignees" :key="a.openid" :label="a.name" :value="a.openid" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购物料">
          <div class="pick-material-col">
            <!-- 细分类（编号分类）chips 条：横向滚动，没有下拉上限；点哪个就列出哪个分类的物料 -->
            <div v-if="subCategoryChips.length" class="sub-cat-bar">
              <span
                class="sub-cat-chip"
                :class="{ active: selectedSubCategory === '' }"
                @click="selectSubCategory('')"
              >全部</span>
              <span
                v-for="s in subCategoryChips"
                :key="s"
                class="sub-cat-chip"
                :class="{ active: selectedSubCategory === s }"
                @click="selectSubCategory(s)"
              >{{ s }}</span>
            </div>
            <div class="pick-material-row">
              <el-select
                v-model="pickedMaterialId"
                filterable
                remote
                :remote-method="searchMaterials"
                :loading="materialLoading"
                placeholder="输入名称 / 规格 / 编号搜索物料"
                style="flex: 1"
                @focus="onMaterialFocus"
                @change="addMaterial"
              >
                <el-option
                  v-for="m in materialOptions"
                  :key="m._id"
                  :label="`${m.name}${m.spec ? ' | ' + m.spec : ''}（现存 ${m.current_stock ?? 0}）`"
                  :value="m._id"
                />
              </el-select>
              <el-button type="primary" plain @click="openMaterialCreate">＋ 新增物料</el-button>
            </div>
          </div>
        </el-form-item>
      </el-form>

      <el-table :data="createForm.items" style="width: 100%" size="small">
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="material_name" label="物料名称" />
        <el-table-column prop="material_spec" label="规格" width="140" />
        <el-table-column label="数量" width="140">
          <template #default="{ row }">
            <el-input-number v-model="row.quantity" :min="1" size="small" style="width: 110px" />
          </template>
        </el-table-column>
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column label="操作" width="80">
          <template #default="{ $index }">
            <el-button type="danger" size="small" link @click="createForm.items.splice($index, 1)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-form :model="createForm" label-width="90px" style="margin-top: 12px">
        <el-form-item label="备注">
          <el-input v-model="createForm.remark" type="textarea" :rows="2" placeholder="选填，例如：车间急用，本周必须到货" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">发布任务</el-button>
      </template>
    </el-dialog>

    <!-- 新增物料（就地建档，建完直接加入采购清单） -->
    <el-dialog v-model="materialCreateVisible" title="新增物料" width="480px" append-to-body>
      <el-form :model="materialForm" label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="materialForm.name" placeholder="物料名称" />
        </el-form-item>
        <el-form-item label="规格">
          <el-input v-model="materialForm.spec" placeholder="选填，例如：M6×20" />
        </el-form-item>
        <el-form-item label="大类">
          <el-select
            v-model="materialForm.category"
            filterable
            allow-create
            default-first-option
            placeholder="选择已有大类，或直接输入新大类"
            style="width: 100%"
          >
            <el-option v-for="c in categoryOptions" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="细分类">
          <el-select
            v-model="materialForm.sub_category"
            filterable
            allow-create
            default-first-option
            placeholder="选填，选择或输入细分类"
            style="width: 100%"
          >
            <el-option v-for="s in subCategoryOptions" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="单位">
          <el-input v-model="materialForm.unit" placeholder="默认：个" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="materialCreateVisible = false">取消</el-button>
        <el-button type="primary" :loading="materialSaving" @click="submitMaterialCreate">保存并加入清单</el-button>
      </template>
    </el-dialog>

    <!-- 任务详情 -->
    <el-dialog v-model="detailVisible" title="采购任务详情" width="820px">
      <el-descriptions :column="2" border v-if="detail._id">
        <el-descriptions-item label="任务号">{{ detail.task_no }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusTagType(detail.status)" size="small">{{ statusText(detail.status) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="仓库">{{ detail.warehouse_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="发布人">{{ detail.creator_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="指定采购员">{{ detail.assignee_name || '未指定（谁都能领）' }}</el-descriptions-item>
        <el-descriptions-item label="领取人">{{ detail.taker_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="领取时间">{{ formatFull(detail.taken_at) }}</el-descriptions-item>
        <el-descriptions-item label="采购完成">{{ formatFull(detail.purchased_at) }}</el-descriptions-item>
        <el-descriptions-item label="收料入库">{{ formatFull(detail.received_at) }}</el-descriptions-item>
        <el-descriptions-item label="入库单号">{{ detail.inbound_order_no || '-' }}</el-descriptions-item>
        <el-descriptions-item label="购买方式">{{ detail.purchase_channel || '-' }}</el-descriptions-item>
        <el-descriptions-item label="外部单号">{{ detail.external_no || '-' }}</el-descriptions-item>
        <!-- 实际总额 / 实际单价：仓管端不展示（后端 purchase.detail 已脱敏） -->
        <el-descriptions-item v-if="canSeeCost" label="实际总额">
          {{ Number(detail.total_amount) > 0 ? `¥${Number(detail.total_amount).toFixed(2)}` : '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="退回原因">{{ detail.reject_reason || '-' }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="2">{{ detail.remark || '-' }}</el-descriptions-item>
      </el-descriptions>

      <el-table :data="detail.items || []" style="width: 100%; margin-top: 16px" size="small">
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="material_name" label="物料名称" />
        <el-table-column prop="material_spec" label="规格" width="150" />
        <el-table-column prop="quantity" label="数量" width="80" />
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column v-if="canSeeCost" label="实际单价" width="110" align="right">
          <template #default="{ row }">
            {{ Number(row.unit_price) > 0 ? `¥${Number(row.unit_price).toFixed(2)}` : '未填' }}
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <!-- 采购录入 -->
    <el-dialog v-model="entryVisible" title="采购录入（填实际单价）" width="780px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="按实际付款金额逐项填写单价，系统会按这些单价计算这批货的入库成本。"
        style="margin-bottom: 14px"
      />
      <el-form :model="entryForm" label-width="90px">
        <el-form-item label="购买方式">
          <el-radio-group v-model="entryForm.purchase_channel">
            <el-radio-button v-for="c in PURCHASE_CHANNELS" :key="c" :value="c">{{ c }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <!-- 选「其他」必须写清楚具体渠道，否则账上只剩「其他」两个字，对账查不出货从哪来 -->
        <el-form-item v-if="entryForm.purchase_channel === '其他'" label="渠道说明">
          <el-input
            v-model="entryForm.channel_remark"
            placeholder="写明具体从哪买的，如「闲鱼二手」"
            style="width: 320px"
          />
        </el-form-item>
        <el-form-item label="外部单号">
          <el-input v-model="entryForm.external_no" placeholder="淘宝/京东订单号，或线下送货单号" style="width: 320px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="entryForm.remark" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
      </el-form>

      <el-table :data="entryForm.items" style="width: 100%" size="small">
        <el-table-column prop="material_name" label="物料名称" />
        <el-table-column prop="material_spec" label="规格" width="140" />
        <el-table-column prop="quantity" label="数量" width="80" />
        <el-table-column label="实际单价（元）" width="180">
          <template #default="{ row }">
            <el-input-number v-model="row.unit_price" :min="0" :precision="2" :step="1" size="small" style="width: 150px" />
          </template>
        </el-table-column>
        <el-table-column label="小计" width="110" align="right">
          <template #default="{ row }">
            ¥{{ (Number(row.unit_price || 0) * Number(row.quantity || 0)).toFixed(2) }}
          </template>
        </el-table-column>
      </el-table>

      <div class="entry-total">
        合计：<span class="amount">¥{{ entryTotal.toFixed(2) }}</span>
      </div>

      <template #footer>
        <el-button @click="entryVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEntry">提交，等待仓管收料</el-button>
      </template>
    </el-dialog>

    <!-- 收料入库：逐项登记（与小程序 task-detail 同口径，2026-10-12 对齐） -->
    <el-dialog v-model="receiveVisible" title="收料入库" width="720px">
      <el-alert
        type="info"
        :closable="false"
        title="货到多少填多少，点「到货入库」当场写库存；分几次到就分几次点。数量填错再点一次改小，多入的部分会自动冲回。全部处理完再点「完成收货」办结。"
        style="margin-bottom: 12px"
      />
      <div class="recv-progress">已确认 {{ recvConfirmed }} / {{ recvItems.length }}</div>
      <div v-for="it in recvItems" :key="it._id" class="recv-item">
        <div class="recv-item-info">
          <div class="recv-item-name">
            {{ it.material_name }}{{ it.material_spec ? ' / ' + it.material_spec : '' }}
            <el-tag :type="recvTagType(it)" size="small" class="recv-tag">{{ recvStatusText(it) }}</el-tag>
          </div>
          <div class="recv-item-sub">
            采购 {{ it.quantity }} {{ it.unit }}
            <template v-if="canSeeCost && Number(it.unit_price) > 0"> · 单价 ¥{{ Number(it.unit_price).toFixed(2) }}</template>
            <template v-if="it.purchase_channel"> · {{ it.purchase_channel }}</template>
          </div>
        </div>
        <!-- 已入库的项锁死；其余可继续登记/改数/退货（办结前都能改） -->
        <div v-if="it.receive_status !== 'stocked'" class="recv-item-actions">
          <el-input-number
            v-model="recvQty[it._id]"
            :min="0"
            :max="Number(it.quantity)"
            size="small"
            style="width: 130px"
          />
          <el-button type="success" size="small" :loading="recvBusy" @click="onItemReceive(it)">到货入库</el-button>
          <el-button type="danger" size="small" plain :loading="recvBusy" @click="onItemReturn(it)">退货</el-button>
        </div>
        <div v-else class="recv-item-done">✓ 已入库 {{ it.stocked_qty }} {{ it.unit }}</div>
      </div>
      <template #footer>
        <el-button @click="receiveVisible = false">关闭</el-button>
        <el-button type="primary" :loading="recvBusy" :disabled="!recvAllConfirmed" @click="submitReceive">
          {{ recvAllConfirmed ? '完成收货' : `还有 ${recvItems.length - recvConfirmed} 项未到齐` }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { purchaseApi, materialApi, warehouseApi } from '@/api'
import { useUserStore } from '@/store/user'
import { canViewCost } from '@/constants/roles'

const userStore = useUserStore()
const route = useRoute()

/** 与服务端 modules/purchase.js 的 STATUS_TEXT 保持一致，避免两边叫法不同 */
const STATUS_TEXT = {
  open: '待领取',
  taken: '采购中',
  purchased: '待收料',
  // receiving 是分批到货的中间态（2026-10-09 到货即入库后很常见）：
  // 漏了这一项，后台列表的状态列会显示空白
  receiving: '收货中',
  received: '已入库',
  cancelled: '已取消'
}
// ⚠️ 与服务端 modules/purchase.js 的 PURCHASE_CHANNELS 同步（少了会被后端白名单拒掉）
const PURCHASE_CHANNELS = ['淘宝', '京东', '1688', '拼多多', '线下', '其他']

const loading = ref(false)
const submitting = ref(false)
const materialLoading = ref(false)
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)

const taskList = ref([])
const warehouses = ref([])
const assignees = ref([])
const materialOptions = ref([])
const pickedMaterialId = ref(null)

// 采购物料的分类筛选 + 就地建档（2026-10-12 用户要求）
const categoryOptions = ref([])       // 大类列表（新增物料弹窗用）
const subMap = ref({})                // 大类 → 细分类 映射（新增物料弹窗用）
const subCategoryChips = ref([])      // 细分类（编号分类）列表 → 横向 chips 条
const selectedSubCategory = ref('')   // 选中的细分类（'' = 全部）
const materialCreateVisible = ref(false)
const materialSaving = ref(false)
const materialForm = ref({ name: '', spec: '', category: '', sub_category: '', unit: '个' })

/** 新增物料弹窗里，细分类跟着所选大类走（可选已有的，也能直接输新的） */
const subCategoryOptions = computed(() => subMap.value[materialForm.value.category] || [])

const searchForm = ref({ status: '', warehouse_id: '', keyword: '' })
const stats = ref({ open: 0, taken: 0, purchased: 0, received: 0 })

const createVisible = ref(false)
const createForm = ref({ warehouse_id: '', assignee_openid: '', items: [], remark: '' })

const detailVisible = ref(false)
const detail = ref({})

const entryVisible = ref(false)
const entryForm = ref({ id: '', purchase_channel: '线下', channel_remark: '', external_no: '', remark: '', items: [] })

// 收料入库：逐项登记（2026-10-12 对齐小程序）
const receiveVisible = ref(false)
const receiveTask = ref({})
const recvItems = ref([])
const recvQty = ref({})          // 每项实到数量（key = 明细 id）
const recvBusy = ref(false)

/** 完成口径：到齐(received) / 剩余退货(returned) / 已入库(stocked) —— 与小程序一致 */
const recvConfirmed = computed(() =>
  recvItems.value.filter((it) => ['received', 'returned', 'stocked'].includes(it.receive_status)).length)
const recvAllConfirmed = computed(() => recvItems.value.length > 0 && recvConfirmed.value === recvItems.value.length)

const roles = computed(() => userStore.roles || [])
const canCreate = computed(() => roles.value.some((r) => ['storekeeper', 'boss', 'admin', 'director'].includes(r)))
// 收料/退回/取消：与后端 roleRules 对齐（storekeeper/admin）；老板只读不该看到这些写按钮
const canStore = computed(() => roles.value.some((r) => ['storekeeper', 'admin'].includes(r)))

/**
 * 金额是否展示（2026-10-10）：仓管端只看数量、不看钱。
 * ⚠️ 后端 purchase.list/detail 对仓管已脱敏（total_amount / unit_price 不下发），
 *    这里是体验层 —— 免得留下列头却是整列「-」。
 *    采购员填单价的「采购录入」弹窗不受影响。
 */
const canSeeCost = computed(() => canViewCost(roles.value))

const statCards = [
  { key: 'open', label: '待领取', color: '#E6A23C' },
  { key: 'taken', label: '采购中', color: '#409EFF' },
  { key: 'purchased', label: '待收料', color: '#8A6A10' },
  // 到货即入库后「收货中」很常见（货到了一部分、还没办结），单独给一张卡
  { key: 'receiving', label: '收货中', color: '#16A085' },
  { key: 'received', label: '已入库', color: '#67C23A' }
]

const entryTotal = computed(() =>
  (entryForm.value.items || []).reduce(
    (s, i) => s + Number(i.unit_price || 0) * Number(i.quantity || 0),
    0
  )
)

function statusText(status) {
  return STATUS_TEXT[status] || status || '-'
}

function statusTagType(status) {
  const map = {
    open: 'warning',
    taken: 'primary',
    purchased: 'warning',
    received: 'success',
    cancelled: 'info'
  }
  return map[status] || 'info'
}

function formatTime(date) {
  return date ? dayjs(date).format('MM-DD HH:mm') : '-'
}

function formatFull(date) {
  return date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-'
}

function itemsSummary(row) {
  const items = row.items || []
  if (!items.length) return row.material_names || '-'
  return items.map((i) => `${i.material_name}×${i.quantity}`).join('、')
}

function canCancelTask(row) {
  return ['open', 'taken', 'purchased'].includes(row.status)
}

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    // 采购任务只针对配件仓（2026-10-12 用户定稿）：成品不需要采购，筛选与新建都只留配件仓
    warehouses.value = ((res.data && res.data.list) || []).filter((w) => w.code === 'peijian')
  } catch (err) {
    console.warn('加载仓库失败:', err.message)
  }
}

async function loadAssignees() {
  try {
    const res = await purchaseApi.assignees()
    assignees.value = (res.data && res.data.list) || []
  } catch (err) {
    console.warn('加载采购员列表失败:', err.message)
  }
}

async function loadTasks() {
  loading.value = true
  try {
    const res = await purchaseApi.list({
      page: page.value,
      pageSize: pageSize.value,
      status: searchForm.value.status || undefined,
      warehouse_id: searchForm.value.warehouse_id || undefined,
      keyword: searchForm.value.keyword || undefined
    })
    taskList.value = (res.data && res.data.list) || []
    total.value = (res.data && res.data.total) || 0
    refreshStats()
  } catch (err) {
    ElMessage.error(err.message || '加载采购任务失败')
  } finally {
    loading.value = false
  }
}

/** 概览数字按状态各拉一次总数（只取 total，不取列表） */
async function refreshStats() {
  const keys = statCards.map((s) => s.key)
  const next = { ...stats.value }
  await Promise.all(
    keys.map(async (k) => {
      try {
        const r = await purchaseApi.list({ status: k, page: 1, pageSize: 1 })
        next[k] = (r.data && r.data.total) || 0
      } catch (err) {
        next[k] = next[k] || 0
      }
    })
  )
  stats.value = next
}

function filterByStatus(status) {
  searchForm.value.status = searchForm.value.status === status ? '' : status
  page.value = 1
  loadTasks()
}

function handleSearch() {
  page.value = 1
  loadTasks()
}

function resetSearch() {
  searchForm.value = { status: '', warehouse_id: '', keyword: '' }
  page.value = 1
  loadTasks()
}

/* ---------------- 发布采购任务 ---------------- */

function openCreate() {
  createForm.value = { warehouse_id: '', assignee_openid: '', items: [], remark: '' }
  // 采购任务只针对配件仓：只剩一个仓时直接默认选中，省一步
  if (warehouses.value.length === 1) createForm.value.warehouse_id = warehouses.value[0]._id
  pickedMaterialId.value = null
  materialOptions.value = []
  selectedSubCategory.value = ''
  createVisible.value = true
  if (!assignees.value.length) loadAssignees()
  loadCategories()
}

/** 物料分类（配件仓）：大类给「新增物料」弹窗用，细分类给筛选 chips 条用 */
async function loadCategories() {
  try {
    const res = await materialApi.categories({ warehouse_id: createForm.value.warehouse_id || undefined })
    categoryOptions.value = (res.data && res.data.list) || []
    subMap.value = (res.data && res.data.subMap) || {}
    subCategoryChips.value = (res.data && res.data.subCategories) || []
  } catch (err) {
    categoryOptions.value = []
    subMap.value = {}
    subCategoryChips.value = []
  }
}

async function searchMaterials(kw) {
  const hasKw = kw && String(kw).trim()
  const sub = selectedSubCategory.value
  // 既没输入、也没选具体细分类（在「全部」上）→ 不搜（避免空关键词拉一大堆）
  if (!hasKw && !sub) {
    materialOptions.value = []
    return
  }
  materialLoading.value = true
  try {
    const res = await materialApi.list({
      keyword: hasKw ? String(kw).trim() : undefined,
      sub_category: sub || undefined,
      warehouse_id: createForm.value.warehouse_id || undefined,
      page: 1,
      pageSize: 50
    })
    materialOptions.value = (res.data && res.data.list) || []
  } catch (err) {
    materialOptions.value = []
  } finally {
    materialLoading.value = false
  }
}

/** 点细分类 chip：列出该分类下的物料（「全部」则清空等输入） */
function selectSubCategory(s) {
  selectedSubCategory.value = s
  searchMaterials('')
}

/** 聚焦时若还没选项且已选具体细分类，补一次（让下拉不是空的） */
function onMaterialFocus() {
  if (!materialOptions.value.length && selectedSubCategory.value) searchMaterials('')
}

function addMaterial(id) {
  const m = materialOptions.value.find((x) => x._id === id)
  pickedMaterialId.value = null
  if (!m) return
  addMaterialDirect(m)
}

/** 把一条物料加进采购清单（已存在则数量 +1）。供「选择」与「就地建档」共用 */
function addMaterialDirect(m) {
  const existed = createForm.value.items.find((i) => i.material_id === m._id)
  if (existed) {
    existed.quantity += 1
    ElMessage.info(`「${m.name}」已在清单里，数量改为 ${existed.quantity}`)
    return
  }
  createForm.value.items.push({
    material_id: m._id,
    material_name: m.name,
    material_spec: m.spec || '',
    unit: m.unit || '',
    quantity: 1
  })
}

/* ---------------- 就地建档（新增物料） ---------------- */

function openMaterialCreate() {
  if (!createForm.value.warehouse_id) return ElMessage.warning('请先选择目标仓库')
  // 细分类默认带上当前筛选的 chip，少选一次；大类留空让操作者选
  materialForm.value = { name: '', spec: '', category: '', sub_category: selectedSubCategory.value || '', unit: '个' }
  materialCreateVisible.value = true
}

async function submitMaterialCreate() {
  const f = materialForm.value
  if (!f.name || !String(f.name).trim()) return ElMessage.warning('请填写物料名称')
  materialSaving.value = true
  try {
    const res = await materialApi.upsert({
      name: String(f.name).trim(),
      spec: String(f.spec || '').trim(),
      category: String(f.category || '').trim(),
      sub_category: String(f.sub_category || '').trim(),
      unit: String(f.unit || '').trim() || '个',
      warehouse_id: createForm.value.warehouse_id
      // ⚠️ 不传 current_stock：后端拒绝直接改库存（库存只能走入库单/盘点），新建默认 0
    })
    const newId = res.data && res.data._id
    ElMessage.success(res.message || '物料已建档')
    materialCreateVisible.value = false
    // 建完直接加入采购清单
    if (newId) {
      addMaterialDirect({ _id: newId, name: f.name.trim(), spec: String(f.spec || '').trim(), unit: String(f.unit || '').trim() || '个' })
    }
    // 可能建出了新分类，刷新分类选项
    loadCategories()
  } catch (err) {
    ElMessage.error(err.message || '建档失败')
  } finally {
    materialSaving.value = false
  }
}

async function submitCreate() {
  const f = createForm.value
  if (!f.warehouse_id) return ElMessage.warning('请选择要采购到哪个仓库')
  if (!f.items.length) return ElMessage.warning('请至少添加一项要采购的物料')

  submitting.value = true
  try {
    const res = await purchaseApi.create({
      warehouse_id: f.warehouse_id,
      assignee_openid: f.assignee_openid || undefined,
      remark: f.remark || undefined,
      items: f.items.map((i) => ({ material_id: i.material_id, quantity: i.quantity }))
    })
    ElMessage.success(res.message || `采购任务已发布（${(res.data && res.data.task_no) || ''}）`)
    createVisible.value = false
    page.value = 1
    loadTasks()
  } catch (err) {
    ElMessage.error(err.message || '发布失败')
  } finally {
    submitting.value = false
  }
}

/* ---------------- 领取 / 录入 / 收料 ---------------- */

async function handleTake(row) {
  try {
    await ElMessageBox.confirm(`确定领取采购任务「${row.task_no}」吗？`, '领取任务', {
      confirmButtonText: '领取',
      cancelButtonText: '取消',
      type: 'info'
    })
    const res = await purchaseApi.take({ id: row._id })
    ElMessage.success(res.message || '领取成功')
    loadTasks()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(err.message || '领取失败')
  }
}

function openEntry(row) {
  entryForm.value = {
    id: row._id,
    // 任务级渠道存的是各项去重后的拼接串（如「淘宝 / 线下」），拿去当单选项会一个都匹配不上，
    // 只在不含分隔符时才回填，否则落回默认值让操作者自己选
    purchase_channel: PURCHASE_CHANNELS.includes(row.purchase_channel) ? row.purchase_channel : '线下',
    channel_remark: '',
    external_no: row.external_no || '',
    remark: '',
    items: (row.items || []).map((i) => ({
      _id: i._id,
      material_id: i.material_id,
      material_name: i.material_name,
      material_spec: i.material_spec || '',
      quantity: i.quantity,
      unit: i.unit || '',
      unit_price: Number(i.unit_price) > 0 ? Number(i.unit_price) : 0
    }))
  }
  entryVisible.value = true
}

async function submitEntry() {
  const f = entryForm.value
  if (!f.purchase_channel) return ElMessage.warning('请选择购买方式')
  // 选「其他」必须说明具体渠道：后端也会校验，这里先拦住，免得白跑一趟
  if (f.purchase_channel === '其他' && !String(f.channel_remark || '').trim()) {
    return ElMessage.warning('购买方式选了「其他」，请填写渠道说明')
  }
  if (!f.items.length) return ElMessage.warning('该任务没有明细')

  submitting.value = true
  try {
    const res = await purchaseApi.entry({
      id: f.id,
      purchase_channel: f.purchase_channel,
      external_no: f.external_no || undefined,
      remark: f.remark || undefined,
      items: f.items.map((i) => ({
        _id: i._id,
        material_id: i.material_id,
        unit_price: Number(i.unit_price || 0),
        // 后台是整单一个渠道，所以说明也按整单下发给每一项（后端按明细存）
        channel_remark: f.purchase_channel === '其他' ? String(f.channel_remark || '').trim() : ''
      }))
    })
    ElMessage.success(res.message || '采购信息已提交，等待仓管收料')
    entryVisible.value = false
    loadTasks()
  } catch (err) {
    ElMessage.error(err.message || '提交失败')
  } finally {
    submitting.value = false
  }
}

/* ---------------- 收料入库：逐项登记（与小程序 task-detail 同口径，2026-10-12） ---------------- */

/** 打开收料弹窗：拉最新明细，实到输入框默认填「已实到，没登记过则默认采购数」 */
async function openReceive(row) {
  try {
    const res = await purchaseApi.detail({ id: row._id })
    const t = res.data || {}
    receiveTask.value = t
    recvItems.value = t.items || []
    const qtyMap = {}
    for (const it of recvItems.value) {
      qtyMap[it._id] = Number(it.received_qty) > 0 ? Number(it.received_qty) : Number(it.quantity)
    }
    recvQty.value = qtyMap
    receiveVisible.value = true
  } catch (err) {
    ElMessage.error(err.message || '加载任务明细失败')
  }
}

/** 收料后刷新明细（留在弹窗里继续登记下一项） */
async function reloadReceive() {
  if (!receiveTask.value._id) return
  const res = await purchaseApi.detail({ id: receiveTask.value._id })
  const t = res.data || {}
  receiveTask.value = t
  recvItems.value = t.items || []
  const qtyMap = { ...recvQty.value }
  for (const it of recvItems.value) {
    // 已登记过的回填实到数，没登记过的保持输入框里的值
    if (Number(it.received_qty) > 0) qtyMap[it._id] = Number(it.received_qty)
  }
  recvQty.value = qtyMap
}

/** 逐项状态文案（与小程序一致） */
function recvStatusText(it) {
  const s = it.receive_status || 'pending'
  if (s === 'stocked') return `✓ 已入库 ${it.stocked_qty}`
  if (s === 'received') return `✓ 已到齐 ${it.received_qty}/${it.quantity}`
  if (s === 'partial') return `◐ 实到 ${it.received_qty}/${it.quantity}`
  if (s === 'returned') return `✕ 退 ${Number(it.quantity) - Number(it.received_qty)}${it.return_reason ? '：' + it.return_reason : ''}`
  return '未登记'
}
function recvTagType(it) {
  const s = it.receive_status || 'pending'
  if (s === 'stocked' || s === 'received') return 'success'
  if (s === 'partial') return 'warning'
  if (s === 'returned') return 'danger'
  return 'info'
}

/** 逐项到货登记 + 当场入账：填的是该项实到总数，后端按差额动库存 */
async function onItemReceive(it) {
  if (recvBusy.value) return
  const qty = Number(recvQty.value[it._id])
  if (!Number.isFinite(qty) || qty <= 0) {
    return ElMessage.warning('实到数量要大于 0；没到请点「退货」')
  }
  if (qty > Number(it.quantity)) {
    return ElMessage.warning(`最多 ${it.quantity}（采购数量）`)
  }
  const stocked = Number(it.stocked_qty) || 0
  const delta = qty - stocked
  const stockLine = delta > 0
    ? `库存将增加 ${delta}${stocked > 0 ? `（本项已入账 ${stocked}）` : ''}。`
    : (delta < 0 ? `库存将冲回 ${-delta}（本项已入账 ${stocked}）。` : `库存不变（本项已入账 ${stocked}）。`)
  try {
    await ElMessageBox.confirm(
      `「${it.material_name}」实到 ${qty} ${it.unit || ''}（采购 ${it.quantity}）？\n${stockLine}`,
      '到货入库',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' }
    )
  } catch (e) {
    return
  }
  recvBusy.value = true
  try {
    const r = await purchaseApi.receiveItem({ id: receiveTask.value._id, item_id: it._id, action: 'receive', received_qty: qty })
    const touched = (r.data && r.data.inbound_orders) || []
    const added = touched.filter((t) => t.action === 'created').reduce((s, t) => s + Number(t.quantity), 0)
    const backed = touched.filter((t) => t.action === 'cancelled').reduce((s, t) => s + Number(t.quantity), 0)
    const tip = added > 0
      ? `已入库 ${added}，本项累计 ${r.data && r.data.stocked_qty}`
      : (backed > 0 ? `已冲回 ${backed}，本项剩 ${r.data && r.data.stocked_qty}` : '数量未变，库存未动')
    ElMessage.success(tip)
    await reloadReceive()
    loadTasks()
  } catch (err) {
    ElMessage.error(err.message || '操作失败')
  } finally {
    recvBusy.value = false
  }
}

/** 退货：剩余数量不要了（已到货的部分已经入库，库存保留） */
async function onItemReturn(it) {
  if (recvBusy.value) return
  const arrived = Number(it.received_qty) || 0
  const left = Number(it.quantity) - arrived
  if (left <= 0) return ElMessage.warning('该项已到齐，没有可退的')
  let reason = ''
  try {
    const r = await ElMessageBox.prompt(
      `退 ${left} ${it.unit || ''}，可填原因（破损/不合格）`,
      `退货「${it.material_name}」`,
      { confirmButtonText: '确认退货', cancelButtonText: '取消', inputPlaceholder: '选填' }
    )
    reason = String((r && r.value) || '').trim()
  } catch (e) {
    return
  }
  recvBusy.value = true
  try {
    await purchaseApi.receiveItem({
      id: receiveTask.value._id, item_id: it._id, action: 'return', return_reason: reason
    })
    ElMessage.success('已标记退货')
    await reloadReceive()
    loadTasks()
  } catch (err) {
    ElMessage.error(err.message || '操作失败')
  } finally {
    recvBusy.value = false
  }
}

/** 完成收货（=办结，不再动库存；库存在每次「到货入库」时已加过） */
async function submitReceive() {
  recvBusy.value = true
  try {
    const res = await purchaseApi.receive({ id: receiveTask.value._id })
    ElMessage.success(res.message || '已完成收货')
    receiveVisible.value = false
    loadTasks()
  } catch (err) {
    ElMessage.error(err.message || '办结失败')
  } finally {
    recvBusy.value = false
  }
}


async function handleRejectBack(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `把「${row.task_no}」退回给采购员重新录入？请说明哪里不对：`,
      '退回采购任务',
      {
        confirmButtonText: '确认退回',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：单价填成了含税价，需改为不含税',
        inputValidator: (v) => (v && v.trim() ? true : '必须填写退回原因，采购员需要知道哪里不对')
      }
    )
    const res = await purchaseApi.rejectBack({ id: row._id, reason: String(value).trim() })
    ElMessage.success(res.message || '已退回采购员')
    loadTasks()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(err.message || '退回失败')
  }
}

async function handleCancel(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `取消采购任务「${row.task_no}」后不可恢复。请填写取消原因：`,
      '取消采购任务',
      {
        confirmButtonText: '确认取消',
        cancelButtonText: '再想想',
        type: 'warning',
        inputPlaceholder: '例如：车间改图纸，这批不采购了',
        inputValidator: (v) => (v && v.trim() ? true : '请填写原因，方便事后追查')
      }
    )
    const res = await purchaseApi.cancel({ id: row._id, reason: String(value).trim() })
    ElMessage.success(res.message || '已取消')
    loadTasks()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(err.message || '取消失败')
  }
}

async function openDetail(row) {
  try {
    const res = await purchaseApi.detail({ id: row._id })
    detail.value = res.data || {}
    detailVisible.value = true
  } catch (err) {
    ElMessage.error(err.message || '加载详情失败')
  }
}

onMounted(() => {
  // 从数据看板的采购状态卡点进来时，带上对应的状态筛选
  const st = String(route.query.status || '')
  if (st && Object.keys(STATUS_TEXT).includes(st)) searchForm.value.status = st
  loadWarehouses()
  loadAssignees()
  loadTasks()
})
</script>

<style scoped>
.purchase-tasks {
  padding: 0;
}

.stat-row {
  margin-bottom: 16px;
}

.stat-card {
  cursor: pointer;
  text-align: center;
}

.stat-label {
  font-size: 13px;
  color: #909399;
  margin-bottom: 6px;
}

.stat-value {
  font-size: 24px;
  font-weight: 500;
}

.search-card {
  margin-bottom: 16px;
}

.table-card {
  margin-bottom: 16px;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}

.entry-total {
  margin-top: 14px;
  text-align: right;
  font-size: 14px;
}

.entry-total .amount {
  font-size: 20px;
  color: #8A6A10;
  font-weight: 500;
}

/* 采购物料区：细分类 chips 条 + 搜索行 */
.pick-material-col {
  width: 100%;
}

/* 横向滚动的细分类条：没有下拉框的选项上限，多少分类都能横着滑 */
.sub-cat-bar {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 2px 2px 8px;
  margin-bottom: 8px;
  scrollbar-width: thin;
}

.sub-cat-chip {
  flex-shrink: 0;
  padding: 4px 14px;
  font-size: 13px;
  line-height: 20px;
  border-radius: 20px;
  background: #f0f2f5;
  color: #606266;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  border: 1px solid transparent;
}

.sub-cat-chip:hover {
  background: #e6e9ef;
}

.sub-cat-chip.active {
  background: #8A6A10;
  color: #fff;
}

/* 搜索选择器 + 新增按钮 横排 */
.pick-material-row {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: center;
}

/* 收料入库弹窗（逐项登记） */
.recv-progress {
  font-size: 13px;
  color: #909399;
  margin-bottom: 10px;
}

.recv-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 4px;
  border-bottom: 1px solid #f0f0f0;
}

.recv-item:last-child {
  border-bottom: none;
}

.recv-item-info {
  flex: 1;
  min-width: 0;
}

.recv-item-name {
  font-size: 14px;
  color: #303133;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.recv-item-sub {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.recv-item-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.recv-item-done {
  color: #67c23a;
  font-size: 14px;
  font-weight: 500;
  flex-shrink: 0;
}
</style>
