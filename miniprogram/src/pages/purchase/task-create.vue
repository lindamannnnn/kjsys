<template>
  <view class="container">
    <!-- 仓库切换 -->
    <scroll-view v-if="warehouses.length > 1" class="wh-bar" scroll-x>
      <view
        v-for="w in warehouses"
        :key="w._id"
        class="wh-item"
        :class="{ active: Number(warehouseId) === Number(w._id) }"
        @click="switchWarehouse(w)"
      >{{ w.name }}</view>
    </scroll-view>

    <!-- 搜索物料 -->
    <view class="search-bar">
      <text class="search-icon">🔍</text>
      <input
        v-model="keyword"
        class="search-input"
        placeholder="搜索物料名称 / 规格"
        placeholder-class="ph"
        confirm-type="search"
        @confirm="loadMaterials"
      />
      <text class="search-btn" @click="loadMaterials">搜索</text>
      <!-- 仓库里没有的物料：就地建档，建完直接进采购清单 -->
      <text class="add-new-btn" @click="openCreate">＋新增</text>
    </view>

    <!-- 细分类筛选：配件仓按编号分类、成品仓按车间，与入库页一致 -->
    <scroll-view v-if="subCategories.length" class="sub-bar" scroll-x>
      <view class="sub-item" :class="{ active: activeSub === '' }" @click="selectSub('')">全部</view>
      <view
        v-for="s in subCategories"
        :key="s"
        class="sub-item"
        :class="{ active: activeSub === s }"
        @click="selectSub(s)"
      >
        {{ s }}
      </view>
    </scroll-view>

    <!-- 已选清单 -->
    <view v-if="cart.length" class="cart-box">
      <view class="cart-head">
        <text class="cart-title">采购清单（{{ cart.length }} 项）</text>
        <text class="cart-clear" @click="cart = []">清空</text>
      </view>
      <view v-for="(it, idx) in cart" :key="it.material_id" class="cart-item">
        <view class="cart-main">
          <text class="cart-name">{{ it.material_name }}{{ it.material_spec ? ' / ' + it.material_spec : '' }}</text>
          <text class="cart-stock">当前库存 {{ it.current_stock }} {{ it.unit }}</text>
        </view>
        <view class="cart-qty">
          <text class="qty-btn" @click="stepQty(idx, -1)">−</text>
          <input
            v-model="it.quantity"
            class="qty-input"
            type="number"
            @blur="normalizeQty(idx)"
          />
          <text class="qty-btn" @click="stepQty(idx, 1)">＋</text>
        </view>
        <text class="cart-del" @click="removeFromCart(idx)">删除</text>
      </view>
    </view>

    <!-- 就地建档面板（仓库没有的物料，建完自动加入采购清单） -->
    <view v-if="createVisible" class="cart-box">
      <view class="cart-head">
        <text class="cart-title">新增物料对象</text>
        <text class="cart-clear" @click="createVisible = false">收起</text>
      </view>
      <view class="create-row">
        <text class="create-label">名称 *</text>
        <input v-model="createForm.name" class="create-input" placeholder="如：火花塞" placeholder-class="ph" />
      </view>
      <view class="create-row">
        <text class="create-label">大类 *</text>
        <view class="chip-wrap">
          <view
            v-for="c in categoryOptions"
            :key="c"
            class="chip"
            :class="{ active: createForm.category === c }"
            @click="onPickCategory(c)"
          >{{ c }}</view>
        </view>
        <input
          v-if="!categoryOptions.includes(createForm.category)"
          v-model="createForm.category"
          class="create-input"
          placeholder="不在上面？手填大类"
          placeholder-class="ph"
        />
      </view>
      <!-- 选完大类后：它下面已有的细分类直接点选，没有再手填 -->
      <view v-if="createForm.category" class="create-row">
        <text class="create-label">细分类</text>
        <view v-if="subOptions.length" class="chip-wrap">
          <view
            v-for="s in subOptions"
            :key="s"
            class="chip"
            :class="{ active: createForm.sub_category === s }"
            @click="createForm.sub_category = createForm.sub_category === s ? '' : s"
          >{{ s }}</view>
        </view>
        <input
          v-if="!subOptions.length || !subOptions.includes(createForm.sub_category)"
          v-model="createForm.sub_category"
          class="create-input"
          :placeholder="subOptions.length ? '不在上面？手填细分类' : '选填，如 A005 轴承'"
          placeholder-class="ph"
        />
      </view>
      <view class="create-row">
        <text class="create-label">规格</text>
        <input v-model="createForm.spec" class="create-input" placeholder="选填，如 M14×1.25" placeholder-class="ph" />
      </view>
      <view class="create-row">
        <text class="create-label">单位</text>
        <input v-model="createForm.unit" class="create-input" placeholder="个 / 套 / 米" placeholder-class="ph" />
      </view>
      <!-- 物料照片（选填）：仓库里长什么样，一眼认出来 -->
      <view class="create-row">
        <text class="create-label">照片</text>
        <view class="upload-box" @click="chooseCreatePhoto">
          <text v-if="createUploading">上传中...</text>
          <text v-else-if="createForm.image_fileid">已上传，点击可重传</text>
          <text v-else>＋ 上传物料照片（选填）</text>
        </view>
        <image
          v-if="createForm.image_fileid"
          class="create-photo-preview"
          :src="fullFileUrl(createForm.image_fileid)"
          mode="aspectFit"
          @click="previewCreatePhoto"
        />
      </view>
      <view class="create-actions">
        <button class="create-btn" :disabled="creating" @click="onCreateSubmit">
          {{ creating ? '创建中...' : '创建并加入清单' }}
        </button>
        <text class="create-collapse" @click="createVisible = false">收起</text>
      </view>
    </view>

    <!-- 物料列表 -->
    <scroll-view class="material-list" scroll-y @scrolltolower="loadMore">
      <view
        v-for="m in materials"
        :key="m._id"
        class="material-item"
        :class="{ 'in-cart': isInCart(m._id) }"
        @click="addToCart(m)"
      >
        <view class="material-main">
          <text class="material-name">{{ m.name }}</text>
          <text class="material-sub">
            {{ m.spec || '无规格' }}{{ m.unit ? ' · ' + m.unit : '' }}
            <text v-if="m.category"> · {{ m.category }}</text>
          </text>
        </view>
        <view class="material-right">
          <text class="material-stock">库存 {{ m.current_stock }}</text>
          <text class="add-btn">{{ isInCart(m._id) ? '已加入' : '＋加入' }}</text>
        </view>
      </view>
      <view v-if="!materials.length" class="empty">没有匹配的物料，新物料在「入库登记」页搜索后点「＋新增」就地建档</view>
    </scroll-view>

    <!-- 底部：指定采购员 + 备注 + 提交 -->
    <view class="bottom-box">
      <view class="bottom-row" @click="showAssigneePicker">
        <text class="bottom-label">指定采购员</text>
        <text class="bottom-value">{{ assigneeName || '不指定（全体可领）' }}</text>
        <text class="bottom-arrow">›</text>
      </view>
      <view class="bottom-row">
        <text class="bottom-label">备注</text>
        <input
          v-model="remark"
          class="bottom-input"
          placeholder="选填，如：急用 / 走淘宝"
          placeholder-class="ph"
        />
      </view>
      <button class="btn-submit" :class="{ disabled: submitting || !canSubmit }" @click="onSubmit">
        {{ submitting ? '发布中...' : `发布采购任务（${cart.length} 项）` }}
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { materialApi, warehouseApi, purchaseApi } from '@/utils/api'
import { uploadFile, fullFileUrl } from '@/utils/cloud'

const warehouses = ref([])
const warehouseId = ref('')

const keyword = ref('')
const materials = ref([])
const page = ref(1)
const hasMore = ref(true)

// 细分类筛选（配件仓=编号分类，成品仓=车间）
const subCategories = ref([])
const activeSub = ref('')

/** 读取当前仓的细分类清单 */
async function loadCategories() {
  try {
    const res = await materialApi.categories({ warehouse_id: warehouseId.value || undefined })
    subCategories.value = res.subCategories || []
    subMap.value = res.subMap || {}
  } catch (err) {
    subCategories.value = []
    subMap.value = {}
  }
}

/** 点选/再点取消 细分类 */
function selectSub(s) {
  activeSub.value = activeSub.value === s ? '' : s
  loadMaterials()
}

const cart = ref([])
const assignees = ref([])
const assigneeOpenid = ref('')
const remark = ref('')
const submitting = ref(false)

// 就地建档（仓库没有的物料直接建，建完进清单）
const createVisible = ref(false)
const creating = ref(false)
const createForm = ref({ name: '', category: '', sub_category: '', spec: '', unit: '个', image_fileid: '' })
const createUploading = ref(false)
// 大类 → 细分类映射（来自分类接口）
const subMap = ref({})

/** 大类候选：当前仓已有物料的大类 */
const categoryOptions = computed(() => {
  const fromMap = Object.keys(subMap.value)
  const set = new Set([...fromMap, ...materialsAllCache.value.map((m) => m.category).filter(Boolean)])
  return set.size ? [...set] : ['配件', '成品']
})
/** 选中大类下的已有细分类 */
const subOptions = computed(() => subMap.value[createForm.value.category] || [])

function onPickCategory(c) {
  createForm.value.category = c
  // 换大类后清掉不属于它的细分类
  if (!subOptions.value.includes(createForm.value.sub_category)) {
    createForm.value.sub_category = ''
  }
}
const materialsAllCache = ref([])

function openCreate() {
  createForm.value = { name: keyword.value.trim(), category: '', sub_category: '', spec: '', unit: '个', image_fileid: '' }
  createVisible.value = true
  // 拉本仓物料给大类候选（只拉一次）
  if (!materialsAllCache.value.length) {
    materialApi.list({ warehouse_id: warehouseId.value || undefined, page: 1, pageSize: 500 })
      .then((res) => { materialsAllCache.value = res.list || [] })
      .catch(() => { materialsAllCache.value = [] })
  }
}

/** 建档照片：选/拍 → 上传 */
function chooseCreatePhoto() {
  uni.chooseImage({
    count: 1,
    success: async (res) => {
      const filePath = res.tempFilePaths && res.tempFilePaths[0]
      if (!filePath) return
      createUploading.value = true
      try {
        createForm.value.image_fileid = await uploadFile(filePath, 'materials')
      } catch (err) {
        uni.showToast({ title: err.message || '上传失败', icon: 'none' })
      } finally {
        createUploading.value = false
      }
    }
  })
}

function previewCreatePhoto() {
  uni.previewImage({ urls: [fullFileUrl(createForm.value.image_fileid)] })
}

async function onCreateSubmit() {
  const f = createForm.value
  if (!f.name.trim() || !f.category.trim()) {
    uni.showToast({ title: '名称和大类必填', icon: 'none' })
    return
  }
  if (creating.value) return
  creating.value = true
  try {
    const res = await materialApi.upsert({
      name: f.name.trim(),
      category: f.category.trim(),
      sub_category: f.sub_category.trim(),
      spec: f.spec.trim(),
      unit: f.unit.trim() || '个',
      warehouse_id: warehouseId.value,
      image_fileid: f.image_fileid || ''
    })
    uni.showToast({ title: `「${f.name.trim()}」已建档`, icon: 'none' })
    createVisible.value = false
    // 建完直接加入采购清单（默认数量 1）
    addToCart({
      _id: res._id, name: f.name.trim(), spec: f.spec.trim(),
      unit: f.unit.trim() || '个', current_stock: 0, warehouse_id: warehouseId.value
    })
    materialsAllCache.value = [] // 让下次建档的大类候选包含新大类
  } catch (err) {
    uni.showToast({ title: err.message || '创建失败', icon: 'none', duration: 3000 })
  } finally {
    creating.value = false
  }
}

const assigneeName = computed(() => {
  const a = assignees.value.find((x) => x.openid === assigneeOpenid.value)
  return a ? a.name : ''
})

const canSubmit = computed(() => cart.value.length > 0 && !!warehouseId.value)

async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    // 采购任务只针对配件仓（2026-10-12 用户定稿）：成品不需要采购，切换条只留配件仓
    warehouses.value = (res.list || []).filter((w) => w.code === 'peijian')
    if (warehouses.value.length) {
      warehouseId.value = warehouses.value[0]._id
      await Promise.all([loadMaterials(), loadAssignees(), loadCategories()])
    }
  } catch (err) {
    uni.showToast({ title: err.message || '仓库加载失败', icon: 'none' })
  }
}

async function loadAssignees() {
  try {
    const res = await purchaseApi.assignees()
    assignees.value = res.list || []
  } catch (err) {
    assignees.value = []
  }
}

async function loadMaterials(reset = true) {
  if (!warehouseId.value) return
  if (reset) {
    page.value = 1
    hasMore.value = true
  }
  try {
    const res = await materialApi.list({
      warehouse_id: warehouseId.value,
      keyword: keyword.value.trim(),
      sub_category: activeSub.value || undefined,
      page: page.value,
      pageSize: 30
    })
    const rows = res.list || []
    materials.value = reset ? rows : [...materials.value, ...rows]
    hasMore.value = rows.length >= 30
  } catch (err) {
    if (reset) materials.value = []
    uni.showToast({ title: err.message || '物料加载失败', icon: 'none' })
  }
}

function loadMore() {
  if (!hasMore.value) return
  page.value += 1
  loadMaterials(false)
}

async function switchWarehouse(w) {
  if (Number(warehouseId.value) === Number(w._id)) return
  if (cart.value.length) {
    const ok = await new Promise((resolve) => {
      uni.showModal({
        title: '切换仓库',
        content: '一张采购任务只能有一个仓库的物料，切换会清空当前清单。',
        confirmText: '确认切换',
        cancelText: '取消',
        success: (r) => resolve(!!r.confirm)
      })
    })
    if (!ok) return
    cart.value = []
  }
  warehouseId.value = w._id
  keyword.value = ''
  activeSub.value = ''
  loadCategories()
  await loadMaterials()
}

function isInCart(id) {
  return cart.value.some((it) => Number(it.material_id) === Number(id))
}

function addToCart(m) {
  if (isInCart(m._id)) return
  cart.value.push({
    material_id: m._id,
    material_name: m.name,
    material_spec: m.spec || '',
    unit: m.unit || '',
    current_stock: m.current_stock,
    quantity: 1
  })
}

function removeFromCart(idx) {
  cart.value.splice(idx, 1)
}

function stepQty(idx, delta) {
  const it = cart.value[idx]
  const next = Number(it.quantity || 0) + delta
  it.quantity = next < 1 ? 1 : next
}

function normalizeQty(idx) {
  const it = cart.value[idx]
  let n = parseInt(it.quantity, 10)
  if (!Number.isFinite(n) || n < 1) n = 1
  it.quantity = n
}

function showAssigneePicker() {
  if (!assignees.value.length) {
    uni.showToast({ title: '还没有采购员账号', icon: 'none' })
    return
  }
  const names = ['不指定（全体可领）', ...assignees.value.map((a) => a.name)]
  uni.showActionSheet({
    itemList: names,
    success: (res) => {
      if (res.tapIndex === 0) assigneeOpenid.value = ''
      else assigneeOpenid.value = assignees.value[res.tapIndex - 1].openid
    }
  })
}

async function onSubmit() {
  if (submitting.value) return
  if (!canSubmit.value) {
    uni.showToast({ title: '请先选择仓库并加入物料', icon: 'none' })
    return
  }

  // 数量兜底：防止留下空或 0
  for (let i = 0; i < cart.value.length; i++) normalizeQty(i)

  submitting.value = true
  uni.showLoading({ title: '发布中...', mask: true })
  try {
    const res = await purchaseApi.create({
      warehouse_id: warehouseId.value,
      assignee_openid: assigneeOpenid.value || undefined,
      remark: remark.value.trim(),
      items: cart.value.map((it) => ({
        material_id: it.material_id,
        quantity: Number(it.quantity)
      }))
    })
    uni.hideLoading()

    const taskNo = res.task_no || ''
    cart.value = []
    remark.value = ''
    assigneeOpenid.value = ''

    uni.showModal({
      title: '发布成功',
      content: `采购单号：${taskNo}\n已通知${assigneeName.value ? '指定采购员' : '采购员来领取'}。`,
      confirmText: '查看任务',
      cancelText: '继续发布',
      success: (r) => {
        if (r.confirm) {
          uni.redirectTo({ url: '/pages/purchase/tasks' })
        } else {
          loadMaterials()
        }
      }
    })
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '发布失败', icon: 'none', duration: 3000 })
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  loadWarehouses()
})
</script>

<style lang="scss" scoped>
.container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
}

.wh-bar {
  background: #fff;
  padding: 16rpx 20rpx;
  white-space: nowrap;
  border-bottom: 1rpx solid #f0f0f0;

  .wh-item {
    display: inline-block;
    padding: 10rpx 26rpx;
    margin-right: 16rpx;
    font-size: 26rpx;
    color: #666;
    background: #f5f5f5;
    border-radius: 30rpx;

    &.active {
      background: #6b5b95;
      color: #fff;
    }
  }
}

/* 细分类筛选条（与入库页同款，配件仓=编号分类、成品仓=车间） */
.sub-bar {
  white-space: nowrap;
  padding: 10rpx 20rpx;
  background: #fff;
  border-bottom: 1rpx solid #f0f0f0;

  .sub-item {
    display: inline-block;
    padding: 8rpx 22rpx;
    margin-right: 12rpx;
    border-radius: 26rpx;
    background: #f0f0f0;
    font-size: 22rpx;
    color: #666;
    line-height: 1.5;

    &.active {
      background: #6b5b95;
      color: #fff;
    }
  }
}

.search-bar {
  display: flex;
  align-items: center;
  background: #fff;
  padding: 16rpx 20rpx;
  gap: 14rpx;

  .search-icon {
    font-size: 28rpx;
  }

  .search-input {
    flex: 1;
    font-size: 28rpx;
    color: #333;
    background: #f5f5f5;
    border-radius: 30rpx;
    padding: 14rpx 24rpx;
  }

  .search-btn {
    font-size: 26rpx;
    color: #6b5b95;
    padding: 8rpx 12rpx;
  }
}

.cart-box {
  background: #fff;
  margin: 16rpx 20rpx 0;
  border-radius: 16rpx;
  padding: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
  /* 清单项多时限高内滚，别把底部发布区顶出屏幕 */
  max-height: 42vh;
  overflow-y: auto;

  .cart-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12rpx;

    .cart-title {
      font-size: 28rpx;
      font-weight: bold;
      color: #333;
    }

    .cart-clear {
      font-size: 24rpx;
      color: #e74c3c;
    }
  }

  .cart-item {
    display: flex;
    align-items: center;
    padding: 14rpx 0;
    border-bottom: 1rpx solid #f7f7f7;

    &:last-child {
      border-bottom: none;
    }

    .cart-main {
      flex: 1;

      .cart-name {
        font-size: 26rpx;
        color: #333;
        display: block;
      }

      .cart-stock {
        font-size: 22rpx;
        color: #999;
        margin-top: 4rpx;
        display: block;
      }
    }

    .cart-qty {
      display: flex;
      align-items: center;
      gap: 8rpx;
      margin-right: 16rpx;

      .qty-btn {
        width: 46rpx;
        height: 46rpx;
        line-height: 46rpx;
        text-align: center;
        background: #f0f0f0;
        border-radius: 8rpx;
        font-size: 30rpx;
        color: #666;
      }

      .qty-input {
        width: 90rpx;
        height: 46rpx;
        text-align: center;
        font-size: 26rpx;
        background: #f8f8f8;
        border-radius: 8rpx;
      }
    }

    .cart-del {
      font-size: 24rpx;
      color: #e74c3c;
    }
  }
}

.material-list {
  flex: 1;
  min-height: 0; /* flex 子项默认 min-height:auto，内容一多就把底部发布区顶出屏幕 */
  padding: 16rpx 20rpx;

  .material-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #fff;
    border-radius: 14rpx;
    padding: 22rpx;
    margin-bottom: 14rpx;
    box-shadow: 0 2rpx 6rpx rgba(0, 0, 0, 0.05);

    &.in-cart {
      background: #f6f3fb;
    }

    .material-main {
      flex: 1;

      .material-name {
        font-size: 28rpx;
        color: #333;
        display: block;
      }

      .material-sub {
        font-size: 22rpx;
        color: #999;
        margin-top: 6rpx;
        display: block;
      }
    }

    .material-right {
      text-align: right;

      .material-stock {
        font-size: 22rpx;
        color: #999;
        display: block;
        margin-bottom: 8rpx;
      }

      .add-btn {
        font-size: 24rpx;
        color: #6b5b95;
        background: #efeaf7;
        padding: 8rpx 20rpx;
        border-radius: 8rpx;
      }
    }
  }

  .empty {
    text-align: center;
    padding: 80rpx 40rpx;
    font-size: 24rpx;
    color: #999;
  }
}

.bottom-box {
  background: #fff;
  padding: 20rpx 24rpx 30rpx;
  box-shadow: 0 -2rpx 10rpx rgba(0, 0, 0, 0.06);

  .bottom-row {
    display: flex;
    align-items: center;
    padding: 16rpx 0;
    border-bottom: 1rpx solid #f7f7f7;

    .bottom-label {
      width: 180rpx;
      font-size: 26rpx;
      color: #666;
      flex-shrink: 0;
    }

    .bottom-value {
      flex: 1;
      font-size: 26rpx;
      color: #333;
      text-align: right;
    }

    .bottom-arrow {
      font-size: 30rpx;
      color: #ccc;
      margin-left: 10rpx;
    }

    .bottom-input {
      flex: 1;
      font-size: 26rpx;
      color: #333;
      text-align: right;
    }
  }

  .btn-submit {
    margin-top: 24rpx;
    background: #6b5b95;
    color: #fff;
    border-radius: 12rpx;
    padding: 24rpx;
    font-size: 30rpx;
    font-weight: bold;

    &::after {
      border: none;
    }

    &.disabled {
      background: #c9c2da;
    }
  }
}

.ph {
  color: #bbb;
}

.upload-box {
  font-size: 26rpx;
  color: #6b5b95;
  background: #efeaf7;
  border-radius: 10rpx;
  padding: 24rpx;
  text-align: center;
}

.create-photo-preview {
  width: 100%;
  height: 280rpx;
  margin-top: 14rpx;
  border-radius: 10rpx;
  background: #f5f5f5;
}

/* 搜索栏的＋新增 */
.add-new-btn {
  flex-shrink: 0;
  font-size: 24rpx;
  color: #6b5b95;
  background: #efeaf7;
  border-radius: 30rpx;
  padding: 10rpx 22rpx;
  margin-left: 12rpx;
}

/* 就地建档面板 */
.create-row {
  margin-top: 18rpx;

  .create-label {
    font-size: 24rpx;
    color: #666;
    display: block;
    margin-bottom: 10rpx;
  }

  .create-input {
    background: #f8f8f8;
    border-radius: 10rpx;
    height: 72rpx;
    line-height: 72rpx;
    padding: 0 20rpx;
    font-size: 26rpx;
    width: 100%;
    box-sizing: border-box;
  }
}

.chip-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  margin-bottom: 12rpx;

  .chip {
    padding: 8rpx 22rpx;
    font-size: 24rpx;
    color: #666;
    background: #f0f0f0;
    border-radius: 26rpx;

    &.active {
      background: #6b5b95;
      color: #fff;
    }
  }
}

.create-actions {
  display: flex;
  align-items: center;
  gap: 24rpx;
  margin-top: 24rpx;

  .create-btn {
    flex: 1;
    margin-top: 0;
  }

  .create-collapse {
    font-size: 26rpx;
    color: #999;
    padding: 12rpx 8rpx;
  }
}

.create-btn {
  background: #6b5b95;
  color: #fff;
  border-radius: 12rpx;
  padding: 20rpx;
  font-size: 28rpx;
  width: 100%;

  &:disabled {
    background: #c9c2da;
  }

  &::after {
    border: none;
  }
}
</style>
