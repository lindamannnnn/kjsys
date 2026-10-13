<template>
  <view class="container">
    <!-- 任务信息 -->
    <view class="card">
      <view class="card-header">
        <text class="task-no">{{ task.task_no }}</text>
        <text class="task-status" :class="task.status">{{ purchaseStatusText(task.status) }}</text>
      </view>

      <!-- 进度 -->
      <view class="steps">
        <view
          v-for="(s, i) in steps"
          :key="s.key"
          class="step"
          :class="{ done: s.done, current: s.current }"
        >
          <view class="step-dot">{{ s.done ? '✓' : i + 1 }}</view>
          <text class="step-name">{{ s.name }}</text>
          <view v-if="i < steps.length - 1" class="step-line" :class="{ done: steps[i + 1].done || steps[i + 1].current }"></view>
        </view>
      </view>

      <view class="card-body">
        <view class="info-row">
          <text class="label">目标仓库</text>
          <text class="value">{{ task.warehouse_name || '—' }}</text>
        </view>
        <view class="info-row">
          <text class="label">发起人</text>
          <text class="value">{{ task.creator_name }}{{ task.created_at ? ' · ' + formatDate(task.created_at) : '' }}</text>
        </view>
        <view class="info-row">
          <text class="label">指定采购员</text>
          <text class="value">{{ task.assignee_name || '未指定（全体可领）' }}</text>
        </view>
        <view class="info-row">
          <text class="label">领取人</text>
          <text class="value">{{ task.taker_name || '尚未领取' }}</text>
        </view>
        <view v-if="task.remark" class="info-row">
          <text class="label">备注</text>
          <text class="value">{{ task.remark }}</text>
        </view>
      </view>
    </view>

    <!-- 提示：按当前状态告诉用户下一步该谁做 -->
    <view v-if="tipText" class="tip-card" :class="'tip-' + task.status">
      <text class="tip-icon">{{ tipIcon }}</text>
      <text class="tip-text">{{ tipText }}</text>
    </view>

    <!-- 采购明细 -->
    <view class="card">
      <view class="card-header">
        <text class="section-title">采购明细（{{ (task.items || []).length }} 项）</text>
        <text v-if="canReceivePhase" class="recv-progress">已确认 {{ confirmedCount }}/{{ (task.items || []).length }}</text>
      </view>
      <!-- 到货即入库的说明（2026-10-09 改版：不再需要单独的「入库」步骤） -->
      <view v-if="canReceivePhase" class="recv-hint">
        <text class="recv-hint-title">点「到货入库」就实时写库存</text>
        <text class="recv-hint-text">货到多少填多少、点一下确认，库存当场加上（每次只加新增的那部分）。分几次到就分几次点。数量填错了再点一次改小，多入的部分会自动冲回。全部处理完再点最下方「完成收货」办结。</text>
      </view>
      <view class="card-body">
        <view v-for="(it, idx) in task.items || []" :key="idx" class="item-row">
          <view class="item-main">
            <text class="item-name">{{ it.material_name }}{{ it.material_spec ? ' / ' + it.material_spec : '' }}</text>
            <text class="item-sub">
              数量 {{ it.quantity }} {{ it.unit }}<template v-if="it.purchase_channel"> · {{ channelText(it) }}</template><template v-if="it.external_no"> · 单号 {{ it.external_no }}</template>
            </text>
            <!-- 逐项到货登记：点「到货入库」当场写库存（分次到货按差额累加；数量改小自动冲回）。
                 2026-10-09 改版：「到货登记」+「单项入库」两步已合并成一步。 -->
            <view v-if="canReceivePhase" class="recv-line">
              <text v-if="it.receive_status === 'stocked'" class="recv-tag stocked">
                ✓ 已入库 {{ it.stocked_qty }}{{ Number(it.quantity) - Number(it.received_qty) > 0 ? `，退 ${Number(it.quantity) - Number(it.received_qty)}` : '' }}{{ it.return_reason ? '：' + it.return_reason : '' }}
              </text>
              <text v-else-if="it.receive_status === 'received'" class="recv-tag ok">
                ✓ 已到齐 {{ it.received_qty }}/{{ it.quantity }}{{ Number(it.stocked_qty) > 0 ? `（已入库 ${it.stocked_qty}）` : '' }}
              </text>
              <text v-else-if="it.receive_status === 'partial'" class="recv-tag part">
                ◐ 实到 {{ it.received_qty }}/{{ it.quantity }}{{ Number(it.stocked_qty) > 0 ? `（已入库 ${it.stocked_qty}）` : '' }}
              </text>
              <text v-else-if="it.receive_status === 'returned'" class="recv-tag bad">
                ✕ 退 {{ Number(it.quantity) - Number(it.received_qty) }}{{ Number(it.received_qty) > 0 ? `（实到 ${it.received_qty} 已入库）` : '' }}{{ it.return_reason ? '：' + it.return_reason : '' }}
              </text>
              <!-- 办结前都能改：退货的项也能改实到数（改大 = 新到一批自动加库存，改小 = 自动冲回），办结后锁死 -->
              <template v-if="it.receive_status !== 'stocked'">
                <input
                  v-model="recvQty[it._id]"
                  class="recv-input"
                  type="number"
                  :placeholder="String(it.quantity)"
                  placeholder-class="ph"
                />
                <view class="recv-btn ok" :class="{ disabled: recvBusy }" @click="onItemReceive(it)">到货入库</view>
              </template>
              <view v-if="it.receive_status !== 'stocked'" class="recv-btn bad" :class="{ disabled: recvBusy }" @click="onItemReturn(it)">退货</view>
            </view>
            <!-- 本项已生成的入库单（分批到货会有多张；改小数量被冲回的那张标「已冲回」） -->
            <view v-if="canReceivePhase && itemInboundOrders(it).length" class="recv-orders">
              <text
                v-for="o in itemInboundOrders(it)"
                :key="o.id"
                class="recv-order-tag"
                :class="{ cancelled: o.status === 'cancelled' }"
              >{{ o.order_no }} {{ o.status === 'cancelled' ? '已冲回' : `入库 ${o.quantity}` }}</text>
            </view>
          </view>
          <view class="item-price">
            <text v-if="Number(it.unit_price) > 0" class="price-text">¥{{ formatMoney(it.unit_price) }}</text>
            <text v-else class="price-empty">未填单价</text>
          </view>
        </view>
        <view v-if="Number(task.total_amount) > 0" class="total-row">
          <text class="total-label">合计金额</text>
          <text class="total-value">¥{{ formatMoney(task.total_amount) }}</text>
        </view>
      </view>
    </view>

    <!-- 采购信息（录入后显示）。⚠️ 必须含 receiving：新口径下点过「到货入库」任务就进 receiving，
         否则货到一半时整块信息（含下面的入库单列表）会消失 -->
    <view v-if="['purchased', 'receiving', 'received'].includes(task.status)" class="card">
      <view class="card-header">
        <text class="section-title">采购信息</text>
      </view>
      <view class="card-body">
        <view class="info-row">
          <text class="label">购买方式</text>
          <text class="value">{{ task.purchase_channel || '—' }}</text>
        </view>
        <view class="info-row">
          <text class="label">外部单号</text>
          <text class="value">{{ task.external_no || '—' }}</text>
        </view>
        <view v-if="task.receipt_fileid" class="info-row">
          <text class="label">采购单据</text>
          <text class="value link" @click="previewReceipt">点击查看</text>
        </view>
        <!-- 分批到货会生成多张入库单；被「改小数量」冲回的那张标（已冲回），留痕可审计 -->
        <view v-if="(task.inbound_orders || []).length" class="info-row info-row-col">
          <text class="label">入库单（{{ (task.inbound_orders || []).length }} 张）</text>
          <view class="order-list">
            <text
              v-for="o in task.inbound_orders"
              :key="o.id"
              class="order-line"
              :class="{ cancelled: o.status === 'cancelled' }"
            >{{ o.order_no }} · {{ o.material_name }} × {{ o.quantity }}{{ Number(o.unit_price) > 0 ? ' ¥' + formatMoney(o.unit_price) : '' }}{{ o.status === 'cancelled' ? '（已冲回）' : '' }}</text>
          </view>
        </view>
        <view v-else-if="task.inbound_order_no" class="info-row">
          <text class="label">入库单号</text>
          <text class="value green">{{ task.inbound_order_no }}</text>
        </view>
      </view>
    </view>

    <!-- 退回原因 -->
    <view v-if="task.reject_reason" class="card reject-card">
      <view class="card-header">
        <text class="section-title">被退回</text>
      </view>
      <view class="card-body">
        <text class="reject-text">{{ task.reject_reason }}</text>
      </view>
    </view>

    <!-- ============ 采购录入表单（领取人本人） ============ -->
    <view v-if="entryVisible" class="card">
      <view class="card-header">
        <text class="section-title">采购录入</text>
      </view>
      <view class="card-body">
        <!-- 一键套用购买方式（2026-10-09 新增）：一张单经常是同一个渠道买的，
             逐项点一遍太累（用户走查反馈「多物料任务要重复录入十几遍」） -->
        <view v-if="entryItems.length > 1" class="entry-field">
          <text class="entry-label">一键套用购买方式</text>
          <view class="chip-wrap">
            <view
              v-for="c in channels"
              :key="'all-' + c"
              class="chip"
              :class="{ active: allSameChannel === c }"
              @click="applyChannelToAll(c)"
            >{{ c }}</view>
          </view>
          <text class="entry-hint">点一下把全部 {{ entryItems.length }} 项都设成同一渠道，个别不同再单独改；选「其他」的要逐项写明从哪里买</text>
        </view>

        <!-- 每项独立：单价 + 购买方式 + 外部单号（一张单里不同物料可能从不同地方买） -->
        <view v-for="(it, idx) in entryItems" :key="idx" class="entry-block">
          <view class="entry-block-head">
            <text class="entry-name">{{ it.material_name }}{{ it.material_spec ? ' / ' + it.material_spec : '' }}</text>
            <text class="entry-qty">× {{ it.quantity }} {{ it.unit }}</text>
          </view>
          <view class="entry-line">
            <text class="entry-label-inline">单价 ¥</text>
            <input v-model="it.unit_price" class="entry-input" type="digit" placeholder="必填" placeholder-class="ph" />
          </view>
          <view class="entry-line">
            <text class="entry-label-inline">购买方式</text>
            <view class="chip-wrap chip-wrap-inline">
              <view
                v-for="c in channels"
                :key="c"
                class="chip chip-sm"
                :class="{ active: it.purchase_channel === c }"
                @click="setChannel(it, c)"
              >{{ c }}</view>
            </view>
          </view>
          <!-- 选「其他」必须补一句说明：只留「其他」两个字，对账时查不出货是从哪买的 -->
          <view v-if="it.purchase_channel === OTHER_CHANNEL" class="entry-line">
            <text class="entry-label-inline entry-label-other">说明</text>
            <input
              v-model="it.channel_remark"
              class="entry-input entry-input-wide"
              placeholder="写明具体从哪买的，如「闲鱼二手」"
              placeholder-class="ph"
            />
          </view>
          <view class="entry-line">
            <text class="entry-label-inline">外部单号</text>
            <input v-model="it.external_no" class="entry-input entry-input-wide" placeholder="该项的订单号（选填）" placeholder-class="ph" />
          </view>
        </view>

        <view class="entry-field">
          <text class="entry-label">采购单据</text>
          <view class="upload-box" @click="chooseReceipt">
            <text v-if="uploading">上传中...</text>
            <text v-else-if="form.receipt_fileid">已上传，点击可重传</text>
            <text v-else>＋ 上传发票/截图（选填）</text>
          </view>
        </view>
      </view>
    </view>

    <!-- ============ 操作按钮 ============ -->
    <view class="action-bar">
      <!-- 采购员：领取 -->
      <button v-if="canTake" class="btn-primary" @click="onTake">领取任务</button>

      <!-- 采购员本人：提交采购信息 -->
      <button
        v-if="canEntry"
        class="btn-primary"
        :class="{ disabled: submitting }"
        @click="onEntry"
      >{{ submitting ? '提交中...' : '提交采购信息' }}</button>
      <button v-if="canEntry" class="btn-ghost" @click="entryVisible = !entryVisible">
        {{ entryVisible ? '收起录入表单' : '展开录入表单' }}
      </button>

      <!-- 仓管：完成收货（=办结，不再动库存）。库存已在每次「到货入库」时加过了 -->
      <button
        v-if="canReceive"
        class="btn-primary"
        :class="{ disabled: !allConfirmed || receiving }"
        @click="onFinalize"
      >
        {{ receiving ? '办结中...' : allConfirmed ? '完成收货' : `还有 ${totalItemCount - confirmedCount} 项未到齐` }}
      </button>
      <button v-if="canReceive" class="btn-warn" @click="onRejectBack">退回给采购员</button>

      <!-- 仓管：取消任务 -->
      <button v-if="canCancel" class="btn-danger-ghost" @click="onCancel">取消任务</button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { purchaseApi, purchaseStatusText } from '@/utils/api'
import { formatMoney } from '@/utils/format'
import { uploadFile, fullFileUrl } from '@/utils/cloud'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()

const taskId = ref('')
const task = ref({})
const entryItems = ref([])
const entryVisible = ref(false)
const uploading = ref(false)
const submitting = ref(false)

// 收料（V5.2：逐项到货登记 + 到齐可单项入库，全部完成直接办结，不再有收料清单面板）
const receiving = ref(false)
// 逐项到货登记（V5）：每项实到数量的输入值（key = 明细 id）
const recvQty = ref({})
const recvBusy = ref(false)

/** 建档大类候选：本仓已有物料的大类 */


// 购买方式候选（2026-10-09 加入 1688 / 拼多多）
// ⚠️ 必须与后端 modules/purchase.js 的 PURCHASE_CHANNELS 完全一致，
//    后端会用白名单校验，多一个少一个都会提交失败。
const channels = ['淘宝', '京东', '1688', '拼多多', '线下', '其他']
/** 选「其他」时必须补一句说明（后端同样校验） */
const OTHER_CHANNEL = '其他'

/** 明细上的购买方式文案：「其他」带上说明，否则只看得到「其他」两个字 */
function channelText(it) {
  if (!it || !it.purchase_channel) return ''
  return it.purchase_channel === OTHER_CHANNEL && it.channel_remark
    ? `${it.purchase_channel}（${it.channel_remark}）`
    : it.purchase_channel
}

// 录入表单项的购买方式点选（嵌套 v-for 里内联赋值在小程序端会失灵，用具名方法）
function setChannel(it, c) {
  it.purchase_channel = c
  // 从「其他」换到别的渠道时把说明清掉，免得下次又选「其他」时
  // 带着上一次的旧说明直接通过校验（残留数据比不填更危险）
  if (c !== OTHER_CHANNEL) it.channel_remark = ''
}

/** 全部明细是否已用同一个购买方式（用于「一键套用」的选中态） */
const allSameChannel = computed(() => {
  const list = entryItems.value
  if (!list.length) return ''
  const first = list[0].purchase_channel
  return first && list.every(it => it.purchase_channel === first) ? first : ''
})

/** 一键把全部明细的购买方式设为同一个渠道 */
function applyChannelToAll(c) {
  if (!entryItems.value.length) return
  entryItems.value.forEach((it) => { it.purchase_channel = c })
  uni.showToast({ title: `已把 ${entryItems.value.length} 项设为「${c}」`, icon: 'none' })
}

const form = ref({
  purchase_channel: '',
  external_no: '',
  receipt_fileid: ''
})

/** 四步：发布 → 领取 → 采购完成 → 收货办结（库存已在逐项「到货入库」时加过） */
const steps = computed(() => {
  const s = task.value.status
  const reachedTake = ['taken', 'purchased', 'receiving', 'received'].includes(s)
  const reachedBuy = ['purchased', 'receiving', 'received'].includes(s)
  const done = s === 'received'
  return [
    { key: 'create', name: '已发布', done: true, current: s === 'open' },
    { key: 'take', name: '已领取', done: reachedTake, current: s === 'taken' },
    { key: 'buy', name: '采购完成', done: reachedBuy, current: ['purchased', 'receiving'].includes(s) },
    { key: 'receive', name: '收货办结', done, current: false }
  ]
})

const tipText = computed(() => {
  const s = task.value.status
  const map = {
    open: '等待采购员领取。如果你是指定人，请尽快领取并购买。',
    taken: '采购员正在采购。买完后在下方录入单价、购买方式和订单号，提交给仓管收料。',
    purchased: '采购员已提交采购信息，等仓管核对实物：货到了就在下面每项点「到货入库」，库存会当场加上。',
    receiving: '货件正在分批到货：每项填实到数量后点「到货入库」，库存当场加上（分次到货只加新增的那部分）。全部处理完点最下方「完成收货」办结。',
    received: '已完成：入库单已生成、库存已增加（在每次「到货入库」时就已加上）。',
    cancelled: '该任务已取消。'
  }
  return map[s] || ''
})

const tipIcon = computed(() => {
  const map = { open: '📢', taken: '🛒', purchased: '📦', receiving: '📥', received: '✅', cancelled: '🚫' }
  return map[task.value.status] || 'ℹ️'
})

const isMine = computed(() => !!task.value.is_mine)
const canTake = computed(() => !!task.value.can_take)
const canEntry = computed(() => task.value.status === 'taken' && isMine.value)
// 2026-10-09 老板只读：采购收料动作不再给老板
const canReceive = computed(() =>
  ['purchased', 'receiving'].includes(task.value.status) && userStore.hasRole(['storekeeper', 'admin']))
// 逐项到货登记阶段（仓管在待收料/收货中可见每项的到货/退货按钮）
const canReceivePhase = canReceive
// 完成口径：数量到齐(received) / 剩余退货(returned) / 已单项入库(stocked)
const confirmedCount = computed(() =>
  (task.value.items || []).filter((it) => ['received', 'returned', 'stocked'].includes(it.receive_status)).length)
const totalItemCount = computed(() => (task.value.items || []).length)
// 已开始逐项登记 → 必须每项都完成才能整单入库
// 已开始逐项登记（用于控制 tips 等展示；完成入库一律要求全部到齐）
const perItemStarted = computed(() =>
  (task.value.items || []).some((it) => it.receive_status && it.receive_status !== 'pending'))
const allConfirmed = computed(() => totalItemCount.value > 0 && confirmedCount.value === totalItemCount.value)
const canCancel = computed(() =>
  ['open', 'taken', 'purchased', 'receiving'].includes(task.value.status)
  && userStore.hasRole(['storekeeper', 'admin']))

function formatDate(d) {
  if (!d) return ''
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 取本项已生成的入库单（到货即入库后一批一张，改小数量冲回的那张 status='cancelled'）
 *  后端 source_item_id 是数字主键，前端明细主键是 _id，必须转字符串比，否则恒不相等 */
function itemInboundOrders(it) {
  const sid = String(it && it._id)
  return (task.value.inbound_orders || []).filter((o) => String(o.source_item_id) === sid)
}

async function loadDetail() {
  if (!taskId.value) return
  try {
    const res = await purchaseApi.detail({ id: taskId.value })
    task.value = res || {}

    // 录入表单以服务端明细为准重建，避免重复提交时漏项（含规格、每项渠道/单号回填）
    entryItems.value = (task.value.items || []).map((it) => ({
      material_id: it.material_id,
      material_name: it.material_name,
      material_spec: it.material_spec || '',
      unit: it.unit,
      quantity: it.quantity,
      unit_price: Number(it.unit_price) > 0 ? String(it.unit_price) : '',
      purchase_channel: it.purchase_channel || '',
      channel_remark: it.channel_remark || '',
      external_no: it.external_no || ''
    }))

    // 采购单据回填（渠道/单号已挪到明细级）
    form.value.receipt_fileid = task.value.receipt_fileid || ''

    // 逐项到货输入框：有实到填实到（分次累加就改大它），没登记过默认采购数
    const qtyMap = {}
    for (const it of task.value.items || []) {
      qtyMap[it._id] = Number(it.received_qty) > 0 ? String(it.received_qty) : String(it.quantity)
    }
    recvQty.value = qtyMap

    // 采购中且是我的任务 → 默认展开录入表单
    if (task.value.status === 'taken' && task.value.is_mine) entryVisible.value = true
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none', duration: 3000 })
  }
}

function previewReceipt() {
  const url = fullFileUrl(task.value.receipt_fileid)
  if (!url) return
  uni.previewImage({ urls: [url] })
}

function chooseReceipt() {
  uni.chooseImage({
    count: 1,
    success: async (res) => {
      const path = (res.tempFilePaths || [])[0]
      if (!path) return
      uploading.value = true
      try {
        const url = await uploadFile(path, 'purchase')
        form.value.receipt_fileid = url
        uni.showToast({ title: '上传成功', icon: 'success' })
      } catch (err) {
        uni.showToast({ title: err.message || '上传失败', icon: 'none' })
      } finally {
        uploading.value = false
      }
    }
  })
}

function onTake() {
  uni.showModal({
    title: '领取采购任务',
    content: `领取 ${task.value.task_no}？领取后请尽快购买并录入采购信息。`,
    confirmText: '领取',
    cancelText: '再看看',
    success: async (res) => {
      if (!res.confirm) return
      try {
        await purchaseApi.take({ id: taskId.value })
        uni.showToast({ title: '领取成功', icon: 'success' })
        loadDetail()
      } catch (err) {
        uni.showToast({ title: err.message || '领取失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

async function onEntry() {
  if (submitting.value) return
  for (const it of entryItems.value) {
    if (String(it.unit_price).trim() === '') {
      uni.showToast({ title: `请填写「${it.material_name}」的单价`, icon: 'none' })
      return
    }
    if (!it.purchase_channel) {
      uni.showToast({ title: `请选「${it.material_name}」的购买方式`, icon: 'none' })
      return
    }
    // 选「其他」必须写清楚是哪个渠道：只留「其他」两个字，对账时等于没填
    if (it.purchase_channel === OTHER_CHANNEL && !String(it.channel_remark || '').trim()) {
      uni.showToast({ title: `「${it.material_name}」选了「其他」，请写明从哪买的`, icon: 'none', duration: 3000 })
      return
    }
  }

  submitting.value = true
  uni.showLoading({ title: '提交中...', mask: true })
  try {
    await purchaseApi.entry({
      id: taskId.value,
      receipt_fileid: form.value.receipt_fileid,
      items: entryItems.value.map((it) => ({
        material_id: it.material_id,
        unit_price: Number(it.unit_price),
        purchase_channel: it.purchase_channel,
        channel_remark: String(it.channel_remark || '').trim(),
        external_no: String(it.external_no || '').trim()
      }))
    })
    uni.hideLoading()
    uni.showToast({ title: '已提交，等待仓管收料', icon: 'success' })
    entryVisible.value = false
    loadDetail()
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none', duration: 3000 })
  } finally {
    submitting.value = false
  }
}
/** 逐项到货登记 + 当场入账：填的是该项的实到总数（分次到货就改大它），
 *  后端只按「本次实到 − 已入账」的差额动库存。 */
async function onItemReceive(it) {
  if (recvBusy.value) return
  const raw = String(recvQty.value[it._id] ?? '').trim()
  const qty = raw === '' ? Number(it.quantity) : Number(raw)
  if (!Number.isFinite(qty) || qty <= 0) {
    uni.showToast({ title: '实到数量要大于 0；没到请点「退货」', icon: 'none' })
    return
  }
  if (qty > Number(it.quantity)) {
    uni.showToast({ title: `最多 ${it.quantity}（采购数量）`, icon: 'none' })
    return
  }

  // 弹窗里直接写清「这次库存会怎么变」，避免仓管以为只是登记、不知道已经加账
  const stocked = Number(it.stocked_qty) || 0
  const delta = qty - stocked
  const stockLine = delta > 0
    ? `库存将增加 ${delta}${stocked > 0 ? `（本项已入账 ${stocked}）` : ''}。`
    : (delta < 0 ? `库存将冲回 ${-delta}（本项已入账 ${stocked}）。` : `库存不变（本项已入账 ${stocked}）。`)
  const confirmed = await new Promise((resolve) => {
    uni.showModal({
      title: '到货入库',
      content: `「${it.material_name}」实到 ${qty} ${it.unit || ''}（采购 ${it.quantity}）？\n${stockLine}`,
      confirmText: '确认',
      success: (r) => resolve(r.confirm)
    })
  })
  if (!confirmed) return

  recvBusy.value = true
  uni.showLoading({ title: '入库中...', mask: true })
  try {
    const r = await purchaseApi.receiveItem({ id: taskId.value, item_id: it._id, action: 'receive', received_qty: qty })
    uni.hideLoading()
    // ⚠️ callCloud 只 resolve(body.data)，**拿不到 body.message**（见 utils/cloud.js），
    //    原来写 `r.message || 兜底` 会永远走兜底、提示干瘪。这里自己按差额拼。
    //    文案要短：小程序 toast 只显示两行，超过会被截断。
    const touched = r.inbound_orders || []
    const added = touched.filter((t) => t.action === 'created').reduce((s, t) => s + Number(t.quantity), 0)
    const backed = touched.filter((t) => t.action === 'cancelled').reduce((s, t) => s + Number(t.quantity), 0)
    const tip = added > 0
      ? `已入库 ${added}，本项累计 ${r.stocked_qty}`
      : (backed > 0 ? `已冲回 ${backed}，本项剩 ${r.stocked_qty}` : '数量未变，库存未动')
    uni.showToast({ title: tip, icon: 'none', duration: 2500 })
    await loadDetail()
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '操作失败', icon: 'none' })
  } finally {
    recvBusy.value = false
  }
}

/** 退货：剩余数量不要了（已到货的部分已经入库，库存保留） */
function onItemReturn(it) {
  if (recvBusy.value) return
  const arrived = Number(it.received_qty) || 0
  const left = Number(it.quantity) - arrived
  if (left <= 0) {
    uni.showToast({ title: '该项已到齐，没有可退的', icon: 'none' })
    return
  }
  uni.showModal({
    title: `退货「${it.material_name}」`,
    editable: true,
    placeholderText: `退 ${left} ${it.unit || ''}，可填原因（破损/不合格）`,
    confirmText: '确认退货',
    success: async (res) => {
      if (!res.confirm) return
      recvBusy.value = true
      uni.showLoading({ title: '处理中...', mask: true })
      try {
        await purchaseApi.receiveItem({
          id: taskId.value, item_id: it._id, action: 'return',
          return_reason: (res.content || '').trim()
        })
        uni.hideLoading()
        uni.showToast({ title: '已标记退货', icon: 'success' })
        await loadDetail()
      } catch (err) {
        uni.hideLoading()
        uni.showToast({ title: err.message || '操作失败', icon: 'none' })
      } finally {
        recvBusy.value = false
      }
    }
  })
}

/** 完成收货（=办结）：库存已在每次「到货入库」时结清，这一步只收尾、不再动库存。
 *  例外：老单（改版前只登记到货、还没入账）会出现在下方拦截里，让仓管补点一次「到货入库」。 */
function onFinalize() {
  if (receiving.value) return
  if (!allConfirmed.value) {
    uni.showToast({ title: `还有 ${totalItemCount.value - confirmedCount.value} 项没到齐/未退货`, icon: 'none' })
    return
  }
  const items = task.value.items || []
  const unaccounted = items.filter((it) => Number(it.received_qty) > Number(it.stocked_qty))
  if (unaccounted.length) {
    uni.showToast({
      title: `有 ${unaccounted.length} 项实到还没入账，请回去点一次「到货入库」`,
      icon: 'none',
      duration: 3000
    })
    return
  }
  const totalStocked = items.reduce((s, it) => s + (Number(it.stocked_qty) || 0), 0)
  uni.showModal({
    title: '完成收货',
    content: `确认办结这张采购任务？本次共入库 ${totalStocked}，库存已在每次「到货入库」时加上，这一步不再改库存。`,
    confirmText: '完成收货',
    cancelText: '再核对',
    success: async (r) => {
      if (!r.confirm) return
      receiving.value = true
      uni.showLoading({ title: '办结中...', mask: true })
      try {
        const res = await purchaseApi.receive({ id: taskId.value })
        uni.hideLoading()
        const brief = res.inbound_order_no || ''
        uni.showModal({
          title: '已办结',
          content: (res.inbound_order_count
            ? `共生成 ${res.inbound_order_count} 张入库单${brief ? `（${brief}）` : ''}，库存已在到货时加好。`
            : (res.message || '任务已办结')),
          showCancel: false,
          confirmText: '知道了'
        })
        loadDetail()
      } catch (err) {
        uni.hideLoading()
        uni.showToast({ title: err.message || '办结失败', icon: 'none', duration: 3000 })
      } finally {
        receiving.value = false
      }
    }
  })
}

function onRejectBack() {
  uni.showModal({
    title: '退回给采购员',
    editable: true,
    placeholderText: '写明哪里不对（如：单价有误 / 数量不符）',
    confirmText: '退回',
    cancelText: '取消',
    confirmColor: '#e67e22',
    success: async (res) => {
      if (!res.confirm) return
      const reason = String(res.content || '').trim()
      if (!reason) {
        uni.showToast({ title: '请写明退回原因', icon: 'none' })
        return
      }
      try {
        await purchaseApi.rejectBack({ id: taskId.value, reason })
        uni.showToast({ title: '已退回采购员', icon: 'success' })
        loadDetail()
      } catch (err) {
        uni.showToast({ title: err.message || '操作失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

function onCancel() {
  uni.showModal({
    title: '取消采购任务',
    editable: true,
    placeholderText: '取消原因（选填）',
    confirmText: '取消任务',
    cancelText: '再想想',
    confirmColor: '#e74c3c',
    success: async (res) => {
      if (!res.confirm) return
      const reason = String(res.content || '').trim()
      try {
        await purchaseApi.cancel({ id: taskId.value, reason })
        uni.showToast({ title: '已取消', icon: 'success' })
        loadDetail()
      } catch (err) {
        uni.showToast({ title: err.message || '取消失败', icon: 'none', duration: 3000 })
      }
    }
  })
}

// 页面参数必须用 uni-app 的 onLoad 拿：getCurrentPages().$page.options 在
// 微信小程序端拿不到 id（H5 能拿到），导致详情页数据全空、按钮不显示（V4 实测踩坑）
onLoad((options) => {
  taskId.value = (options && options.id) || ''
  loadDetail()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding: 20rpx 20rpx 60rpx;
}

.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 28rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  &.reject-card {
    border-left: 8rpx solid #e74c3c;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20rpx;
    padding-bottom: 18rpx;
    border-bottom: 1rpx solid #f0f0f0;

    .recv-progress {
      font-size: 22rpx;
      color: #6b5b95;
      background: #efeaf7;
      padding: 4rpx 14rpx;
      border-radius: 8rpx;
    }

    .task-no {
      font-size: 32rpx;
      font-weight: bold;
      color: #333;
    }

    .task-status {
      font-size: 24rpx;
      padding: 8rpx 18rpx;
      border-radius: 8rpx;

      &.open {
        background: #fff3cd;
        color: #856404;
      }

      &.taken {
        background: #d6eaf8;
        color: #1b4f72;
      }

      &.purchased {
        background: #efeaf7;
        color: #5b4b8a;
      }

      &.received {
        background: #d4edda;
        color: #155724;
      }

      &.cancelled {
        background: #e2e3e5;
        color: #4b5157;
      }
    }

    .section-title {
      font-size: 28rpx;
      font-weight: 500;
      color: #333;
    }
  }

  /* 到货即入库的说明条（只给仓管看，说明「点一下就真加库存」） */
  .recv-hint {
    background: #eaf7f0;
    border: 1rpx solid #bfe6d1;
    border-radius: 12rpx;
    padding: 20rpx 22rpx;
    margin-bottom: 20rpx;

    .recv-hint-title {
      display: block;
      font-size: 25rpx;
      font-weight: 600;
      color: #0F7A3D;
      margin-bottom: 8rpx;
    }

    .recv-hint-text {
      display: block;
      font-size: 22rpx;
      color: #4c6b5a;
      line-height: 1.7;
    }
  }
}

.steps {
  display: flex;
  align-items: flex-start;
  margin-bottom: 22rpx;

  .step {
    flex: 1;
    position: relative;
    text-align: center;

    .step-dot {
      width: 46rpx;
      height: 46rpx;
      line-height: 46rpx;
      border-radius: 50%;
      background: #e8e8e8;
      color: #999;
      font-size: 22rpx;
      margin: 0 auto 10rpx;
      position: relative;
      z-index: 2;
    }

    .step-name {
      font-size: 20rpx;
      color: #999;
      display: block;
    }

    .step-line {
      position: absolute;
      top: 23rpx;
      left: 50%;
      width: 100%;
      height: 2rpx;
      background: #e8e8e8;
      z-index: 1;

      &.done {
        background: #27ae60;
      }
    }

    &.done {
      .step-dot {
        background: #27ae60;
        color: #fff;
      }

      .step-name {
        color: #27ae60;
      }
    }

    &.current {
      .step-dot {
        background: #6b5b95;
        color: #fff;
      }

      .step-name {
        color: #6b5b95;
        font-weight: bold;
      }
    }
  }
}

.card-body {
  .info-row {
    display: flex;
    justify-content: space-between;
    padding: 14rpx 0;

    /* 入库单可能多张，要竖着铺开，不能用两端对齐的横排 */
    &.info-row-col {
      display: block;

      .order-list {
        margin-top: 10rpx;

        .order-line {
          display: block;
          font-size: 22rpx;
          color: #1b4f72;
          line-height: 1.8;

          &.cancelled {
            color: #999;
            text-decoration: line-through;
          }
        }
      }
    }

    .label {
      font-size: 26rpx;
      color: #999;
      flex-shrink: 0;
    }

    .value {
      font-size: 26rpx;
      color: #333;
      text-align: right;
      margin-left: 20rpx;

      &.link {
        color: #6b5b95;
      }

      &.green {
        color: #27ae60;
      }
    }
  }

  .item-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16rpx 0;
    border-bottom: 1rpx solid #f7f7f7;

    &:last-child {
      border-bottom: none;
    }

    .item-main {
      flex: 1;

      .item-name {
        font-size: 26rpx;
        color: #333;
        display: block;
      }

      .item-sub {
        font-size: 22rpx;
        color: #999;
        margin-top: 6rpx;
        display: block;
      }

      /* 逐项到货确认行 */
      .recv-line {
        display: flex;
        align-items: center;
        gap: 12rpx;
        margin-top: 10rpx;
        flex-wrap: wrap;

        .recv-tag {
          font-size: 22rpx;
          padding: 4rpx 14rpx;
          border-radius: 8rpx;

          &.ok { background: #d4edda; color: #155724; }
          &.part { background: #fff3cd; color: #856404; }
          &.bad { background: #f8d7da; color: #721c24; }
          &.stocked { background: #d6eaf8; color: #1b4f72; }
        }

        .recv-input {
          width: 120rpx;
          height: 56rpx;
          line-height: 56rpx;
          background: #f5f5f5;
          border-radius: 10rpx;
          padding: 0 16rpx;
          font-size: 26rpx;
          box-sizing: border-box;
        }

        .recv-btn {
          font-size: 24rpx;
          padding: 10rpx 26rpx;
          border-radius: 28rpx;

          &.ok { background: #0F7A3D; color: #fff; }
          &.bad { background: #fdecea; color: #c0392b; }
          &.disabled { opacity: 0.5; }
        }
      }

      /* 本项已生成的入库单（一批一张；被冲回的那张灰掉划掉） */
      .recv-orders {
        margin-top: 10rpx;

        .recv-order-tag {
          display: inline-block;
          font-size: 20rpx;
          color: #1b4f72;
          background: #eaf2f8;
          border-radius: 6rpx;
          padding: 2rpx 12rpx;
          margin: 0 10rpx 8rpx 0;

          &.cancelled {
            color: #999;
            background: #f0f0f0;
            text-decoration: line-through;
          }
        }
      }
    }

    .item-price {
      .price-text {
        font-size: 26rpx;
        color: #e67e22;
        font-weight: bold;
      }

      .price-empty {
        font-size: 22rpx;
        color: #ccc;
      }
    }
  }

  .total-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16rpx;
    padding-top: 18rpx;
    border-top: 1rpx dashed #eee;

    .total-label {
      font-size: 26rpx;
      color: #666;
    }

    .total-value {
      font-size: 32rpx;
      font-weight: bold;
      color: #e67e22;
    }
  }

  .reject-text {
    font-size: 26rpx;
    color: #e74c3c;
    line-height: 1.6;
  }
}

.tip-card {
  display: flex;
  gap: 16rpx;
  border-radius: 12rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;

  &.tip-open {
    background: #fff8e6;
    border: 1rpx solid #f7dfa5;
  }

  &.tip-taken {
    background: #eaf4fb;
    border: 1rpx solid #bedcf0;
  }

  &.tip-purchased {
    background: #f3effa;
    border: 1rpx solid #d9cff0;
  }

  &.tip-received {
    background: #eafaf0;
    border: 1rpx solid #b9e6cb;
  }

  &.tip-cancelled {
    background: #f0f0f0;
    border: 1rpx solid #ddd;
  }

  .tip-icon {
    font-size: 32rpx;
  }

  .tip-text {
    flex: 1;
    font-size: 24rpx;
    color: #555;
    line-height: 1.6;
  }
}

/* 采购录入表单 */
.entry-block {
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f7f7;

  &:last-child {
    border-bottom: none;
  }
}

.entry-block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;

  .entry-name {
    font-size: 27rpx;
    color: #333;
    font-weight: 500;
  }

  .entry-qty {
    font-size: 22rpx;
    color: #999;
  }
}

.entry-line {
  display: flex;
  align-items: center;
  margin-top: 12rpx;

  .entry-label-inline {
    font-size: 24rpx;
    color: #999;
    width: 130rpx;
    flex-shrink: 0;
  }

  /* 「其他」的说明是必填，标签给个提示色：别让人以为是和「外部单号」一样的选填 */
  .entry-label-other {
    color: #e67e22;
    font-weight: bold;
  }

  .entry-input {
    flex: 1;
    height: 60rpx;
    font-size: 26rpx;
    background: #f8f8f8;
    border-radius: 8rpx;
    padding: 0 16rpx;
  }

  .entry-input-wide {
    flex: 1;
  }
}

.chip-wrap-inline {
  margin-bottom: 0;

  .chip-sm {
    padding: 6rpx 20rpx;
    font-size: 22rpx;
  }
}

.entry-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f7f7;

  .entry-name {
    font-size: 26rpx;
    color: #333;
    flex: 1;
  }

  .entry-price {
    display: flex;
    align-items: center;

    .entry-unit {
      font-size: 24rpx;
      color: #999;
    }

    .entry-input {
      width: 140rpx;
      height: 56rpx;
      text-align: center;
      font-size: 28rpx;
      background: #f8f8f8;
      border-radius: 8rpx;
      margin: 0 10rpx;
    }

    .entry-total {
      font-size: 22rpx;
      color: #999;
    }
  }
}

.entry-field {
  margin-top: 22rpx;

  .entry-label {
    font-size: 26rpx;
    color: #666;
    display: block;
    margin-bottom: 14rpx;

    .req {
      color: #e74c3c;
      margin-left: 6rpx;
    }
  }

  /* 辅助说明（一键套用那行的提示语） */
  .entry-hint {
    display: block;
    font-size: 22rpx;
    color: #9aa5b1;
    margin-top: 12rpx;
    line-height: 1.6;
  }

  .entry-line-input {
    font-size: 26rpx;
    color: #333;
    background: #f8f8f8;
    border-radius: 10rpx;
    padding: 18rpx 20rpx;
  }
}

.chip-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}

.chip {
  padding: 12rpx 30rpx;
  font-size: 26rpx;
  color: #666;
  background: #f5f5f5;
  border-radius: 30rpx;

  &.active {
    background: #6b5b95;
    color: #fff;
  }
}

.upload-box {
  font-size: 26rpx;
  color: #6b5b95;
  background: #efeaf7;
  border-radius: 10rpx;
  padding: 22rpx;
  text-align: center;
}

.link {
  font-size: 24rpx;
  color: #6b5b95;
}

.action-bar {
  margin-top: 30rpx;

  button {
    border-radius: 12rpx;
    padding: 24rpx;
    font-size: 30rpx;
    margin-bottom: 18rpx;

    &::after {
      border: none;
    }
  }

  .btn-primary {
    background: #6b5b95;
    color: #fff;
    font-weight: bold;

    &.disabled {
      background: #c9c2da;
    }
  }

  .btn-ghost {
    background: #f0f0f0;
    color: #666;
    font-size: 28rpx;
  }

  .btn-warn {
    background: #e67e22;
    color: #fff;
  }

  .btn-danger-ghost {
    background: #fff;
    color: #e74c3c;
    border: 1rpx solid #f5c6c0;
  }
}

.ph {
  color: #bbb;
}
</style>
