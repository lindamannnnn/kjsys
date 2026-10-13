<template>
  <div class="message-list">
    <el-card class="filter-card">
      <div class="filter-bar">
        <el-radio-group v-model="onlyUnread" @change="reload">
          <el-radio-button :value="false">全部消息</el-radio-button>
          <el-radio-button :value="true">
            只看未读<span v-if="unread"> （{{ unread }}）</span>
          </el-radio-button>
        </el-radio-group>
        <el-button type="primary" plain :disabled="!unread" :loading="marking" @click="handleMarkAll">
          全部标为已读
        </el-button>
      </div>
    </el-card>

    <el-card class="list-card">
      <el-empty v-if="!loading && !list.length" :description="onlyUnread ? '没有未读消息' : '暂时没有消息'" />

      <div v-else class="msg-list" v-loading="loading">
        <div
          v-for="m in list"
          :key="m._id"
          class="msg-item"
          :class="{ 'is-unread': !m.is_read, 'is-clickable': !!jumpTarget(m) }"
          @click="openMessage(m)"
        >
          <div class="msg-head">
            <span class="msg-dot" v-if="!m.is_read"></span>
            <span class="msg-title">{{ m.title }}</span>
            <el-tag size="small" :type="typeTagType(m.type)">{{ typeText(m.type) }}</el-tag>
            <span class="msg-time">{{ formatTime(m.created_at) }}</span>
          </div>
          <div class="msg-body">{{ m.content }}</div>
          <div class="msg-foot" v-if="m.ref_no">
            <span class="msg-ref">关联单号：{{ m.ref_no }}</span>
            <span v-if="jumpTarget(m)" class="msg-jump">点击查看 →</span>
          </div>
        </div>
      </div>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        class="pagination"
        @size-change="load"
        @current-change="load"
      />
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import { messageApi } from '@/api'

const router = useRouter()

const loading = ref(false)
const marking = ref(false)
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const unread = ref(0)
const onlyUnread = ref(false)
const list = ref([])

/** 消息类型中文名（与服务端 services/message.js 的 MSG_TYPE 一一对应） */
const TYPE_TEXT = {
  outbound_submitted: '领料待确认',
  outbound_picked: '待收货',
  outbound_rejected: '领料被驳回',
  outbound_received: '领料已收货',
  purchase_task_assigned: '采购任务指派',
  purchase_task_open: '新采购任务',
  purchase_done: '采购待收料',
  purchase_received: '采购已入库',
  check_pending_review: '盘点待审核'
}

function typeText(type) {
  return TYPE_TEXT[type] || '通知'
}

function typeTagType(type) {
  if (type === 'outbound_rejected') return 'danger'
  if (type === 'outbound_picked' || type === 'purchase_done') return 'warning'
  if (type === 'purchase_received' || type === 'outbound_received') return 'success'
  return 'primary'
}

function formatTime(v) {
  return v ? dayjs(v).format('MM-DD HH:mm') : '-'
}

/** 点击消息能跳到对应的业务页面（跳不过去就只标已读） */
function jumpTarget(m) {
  const map = {
    outbound: '/order/outbound',
    inbound: '/order/inbound',
    purchase_task: '/order/purchase-tasks',
    // 盘点待审：跳到盘点列表，在那儿查看差异并审核
    check: '/check/list'
  }
  return map[m.ref_type] || ''
}

async function load() {
  loading.value = true
  try {
    const res = await messageApi.list({
      page: page.value,
      pageSize: pageSize.value,
      only_unread: onlyUnread.value || undefined
    })
    list.value = (res.data && res.data.list) || []
    total.value = (res.data && res.data.total) || 0
    unread.value = (res.data && res.data.unread) || 0
  } catch (err) {
    ElMessage.error(err.message || '加载消息失败')
  } finally {
    loading.value = false
  }
}

function reload() {
  page.value = 1
  load()
}

async function handleMarkAll() {
  marking.value = true
  try {
    const res = await messageApi.markAllRead()
    ElMessage.success(res.message || '已全部标为已读')
    load()
  } catch (err) {
    ElMessage.error(err.message || '操作失败')
  } finally {
    marking.value = false
  }
}

async function openMessage(m) {
  // 先置已读，再跳转；置已读失败也不该挡住跳转
  if (!m.is_read) {
    try {
      await messageApi.markRead({ id: m._id })
      m.is_read = 1
      unread.value = Math.max(0, unread.value - 1)
    } catch (err) {
      /* 已读失败不影响跳转 */
    }
  }
  const target = jumpTarget(m)
  if (target) router.push(target)
}

onMounted(load)
</script>

<style scoped>
.message-list {
  padding: 0;
}

.filter-card {
  margin-bottom: 16px;
}

.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.list-card {
  min-height: 300px;
}

.msg-list {
  display: flex;
  flex-direction: column;
}

.msg-item {
  padding: 14px 12px;
  border-bottom: 1px solid #f0f0f0;
  transition: background 0.15s;
}

.msg-item:last-child {
  border-bottom: none;
}

.msg-item.is-clickable {
  cursor: pointer;
}

.msg-item.is-clickable:hover {
  background: #fafafa;
}

.msg-item.is-unread {
  background: #fdfaf3;
}

.msg-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.msg-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #E6A23C;
  flex: none;
}

.msg-title {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}

.msg-time {
  margin-left: auto;
  font-size: 12px;
  color: #909399;
}

.msg-body {
  margin-top: 6px;
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
}

.msg-foot {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: #909399;
}

.msg-jump {
  color: #8A6A10;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}
</style>
