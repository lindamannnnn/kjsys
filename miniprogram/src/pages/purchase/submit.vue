<template>
  <view class="container">
    <!-- 搜索栏 -->
    <view class="search-bar">
      <view class="search-input">
        <text class="search-icon">🔍</text>
        <input
          v-model="keyword"
          class="input"
          placeholder="搜索物料名称/规格"
          placeholder-class="placeholder"
          @input="onSearch"
        />
      </view>
      <view class="scan-btn" @click="onScan">
        <text>📷</text>
      </view>
    </view>

    <!-- 仓库切换：配件仓和成品仓的货要分开看，否则容易入错仓 -->
    <scroll-view v-if="warehouses.length > 1" class="wh-bar" scroll-x>
      <view
        v-for="w in warehouses"
        :key="w._id"
        class="wh-item"
        :class="{ active: Number(warehouseId) === Number(w._id) }"
        @click="switchWarehouse(w)"
      >
        {{ w.name }}
      </view>
    </scroll-view>

    <!-- 细分类筛选：配件仓按编号分类、成品仓按车间，与后台物料页一致 -->
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

    <!-- 物料列表 -->
    <scroll-view
      class="material-list"
      scroll-y
      @scrolltolower="loadMore"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in materialList"
        :key="item._id"
        class="material-item"
        :class="{ selected: isInCart(item._id) }"
        @click="onSelectMaterial(item)"
      >
        <view class="material-info">
          <text class="material-name">{{ item.name }}</text>
          <text class="material-spec">{{ item.material_no ? item.material_no + ' · ' : '' }}{{ item.spec || '无规格' }} | {{ item.warehouse_name || '' }}</text>
          <text v-if="item.sub_category" class="material-cat">{{ item.sub_category }}</text>
          <text class="material-stock">库存: {{ item.current_stock }} {{ item.unit }}</text>
        </view>
        <view class="material-action">
          <text v-if="isInCart(item._id)" class="in-cart">已加入</text>
          <text v-else class="select-text">加入清单</text>
        </view>
      </view>

      <view v-if="loadingMore" class="loading-more">
        <text>加载中...</text>
      </view>
      <view v-else-if="noMore" class="no-more">
        <text>没有更多了</text>
      </view>
      <view v-else-if="materialList.length === 0" class="empty">
        <text class="empty-icon">📦</text>
        <text class="empty-text">暂无物料</text>
      </view>
    </scroll-view>

    <!-- 入库清单（批量） -->
    <view class="cart-panel" :class="{ expanded: cartExpanded }">
      <view class="cart-header" @click="cartExpanded = !cartExpanded">
        <text class="cart-title">入库清单 ({{ cartList.length }} 项)</text>
        <text class="cart-toggle">{{ cartExpanded ? '▼ 收起' : '▲ 展开' }}</text>
      </view>

      <scroll-view v-if="cartExpanded" class="cart-items" scroll-y>
        <view v-for="(cartItem, index) in cartList" :key="cartItem.material_id" class="cart-item">
          <view class="cart-item-info">
            <text class="cart-item-name">{{ cartItem.material_name }}</text>
            <text class="cart-item-stock">当前库存: {{ cartItem.current_stock }} {{ cartItem.unit }}</text>
          </view>
          <view class="cart-item-qty">
            <view class="quick-qty">
              <text
                v-for="q in quickQtys"
                :key="q"
                class="quick-qty-btn"
                @click.stop="setQuickQty(index, q)"
              >{{ q }}</text>
            </view>
            <view class="qty-input-row">
              <text class="qty-btn" @click.stop="decreaseQty(index)">-</text>
              <input
                v-model="cartItem.quantity"
                class="qty-input"
                type="number"
                @input="(e) => onQtyInput(index, e)"
              />
              <text class="qty-btn" @click.stop="increaseQty(index)">+</text>
            </view>
            <input
              v-model="cartItem.unit_price"
              class="price-input"
              type="digit"
              placeholder="单价"
              @input="(e) => onPriceInput(index, e)"
            />
            <text v-if="cartItem.error" class="error-text">{{ cartItem.error }}</text>
          </view>
          <text class="remove-btn" @click.stop="removeFromCart(index)">✕</text>
        </view>
        <view v-if="cartList.length === 0" class="cart-empty">
          <text>点击上方物料加入清单</text>
        </view>
      </scroll-view>

      <!-- 供应商 + 备注 + 提交 -->
      <view v-if="cartExpanded && cartList.length > 0" class="cart-footer">
        <view class="form-item">
          <text class="label">供应商</text>
          <view class="supplier-picker" @click="openSupplierModal">
            <view class="picker-value">
              {{ supplier || '请选择供应商' }}
            </view>
            <text class="picker-arrow">▼</text>
          </view>
        </view>

        <view class="form-item">
          <text class="label">备注</text>
          <input
            v-model="remark"
            class="input"
            placeholder="选填"
            placeholder-class="placeholder"
          />
        </view>

        <view class="total-price">
          <text>合计金额：¥{{ totalPrice }}</text>
        </view>

        <button
          class="btn-submit"
          :disabled="!canSubmit"
          @click="onSubmit"
        >
          提交入库（{{ cartList.length }} 项）
        </button>
      </view>
    </view>
    <!-- 供应商选择弹窗 -->
    <view v-if="showSupplierModal" class="supplier-modal-mask" @click="showSupplierModal = false">
      <view class="supplier-modal" @click.stop>
        <view class="modal-header">
          <text class="modal-title">选择供应商</text>
          <text class="modal-close" @click="showSupplierModal = false">✕</text>
        </view>
        <view class="supplier-search">
          <input
            v-model="supplierKeyword"
            class="input"
            placeholder="搜索供应商名称/联系人"
            placeholder-class="placeholder"
            @input="loadSuppliers"
          />
        </view>
        <scroll-view class="supplier-list" scroll-y>
          <view
            v-for="s in suppliers"
            :key="s._id"
            class="supplier-item"
            :class="{ selected: supplierId === s._id }"
            @click="selectSupplier(s)"
          >
            <view class="supplier-head">
              <text class="supplier-name">{{ s.name }}</text>
              <text class="supplier-edit" @click.stop="openSupplierForm(s)">改资料</text>
            </view>
            <view class="supplier-info">
              <text class="info-item">联系人: {{ s.contact || '—' }}</text>
              <text class="info-item">电话: {{ s.phone || '—' }}</text>
              <text class="info-item">地址: {{ s.address || '—' }}</text>
              <!-- 开票与排付款计划要用（原：税号/账期传了会被静默丢弃，界面上也没地方看） -->
              <text class="info-item" :class="{ 'info-empty': !s.tax_no }">
                税号: {{ s.tax_no || '未填（开票要用）' }}
              </text>
              <text class="info-item" :class="{ 'info-empty': !s.payment_terms }">
                账期: {{ s.payment_terms || '未填（排付款计划要用）' }}
              </text>
            </view>
          </view>
          <view v-if="!supplierLoading && suppliers.length === 0" class="supplier-empty">
            <text>暂无供应商</text>
          </view>
        </scroll-view>
        <view class="supplier-foot">
          <text class="add-supplier-btn" @click="openSupplierForm(null)">＋ 新建供应商</text>
        </view>
      </view>
    </view>

    <!-- 供应商资料表单（税号 / 账期只有这里能录，不录就对账开票做不了） -->
    <view v-if="showSupplierForm" class="supplier-modal-mask" @click="showSupplierForm = false">
      <view class="supplier-modal" @click.stop>
        <view class="modal-header">
          <text class="modal-title">{{ supplierForm._id ? '修改供应商资料' : '新建供应商' }}</text>
          <text class="modal-close" @click="showSupplierForm = false">✕</text>
        </view>
        <scroll-view class="supplier-form" scroll-y>
          <view v-for="f in supplierFields" :key="f.key" class="form-row">
            <text class="form-label">{{ f.label }}</text>
            <input
              v-model="supplierForm[f.key]"
              class="form-input"
              :placeholder="f.placeholder"
              placeholder-class="placeholder"
            />
          </view>
        </scroll-view>
        <view class="supplier-foot">
          <text class="form-cancel" @click="showSupplierForm = false">取消</text>
          <text class="form-save" :class="{ disabled: savingSupplier }" @click="saveSupplier">
            {{ savingSupplier ? '保存中...' : '保存' }}
          </text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { inboundApi, materialApi, supplierApi, warehouseApi } from '@/utils/api'

const keyword = ref('')
const materialList = ref([])
const page = ref(1)
const pageSize = ref(20)
const loadingMore = ref(false)
const noMore = ref(false)
const refreshing = ref(false)

// 仓库：配件仓与成品仓的物料必须分开显示
const warehouses = ref([])
const warehouseId = ref('')

// 细分类筛选：配件仓=编号分类（A001 板材型材…），成品仓=车间
const subCategories = ref([])
const activeSub = ref('')

const cartList = ref([])
const cartExpanded = ref(true)
const supplier = ref('')
const supplierId = ref('')
const remark = ref('')
const showSupplierModal = ref(false)

const suppliers = ref([])
const supplierKeyword = ref('')
const supplierLoading = ref(false)

// 供应商资料表单（新增/修改）
// 字段名必须和后端 supplier/upsert 完全一致，其中 tax_no / payment_terms
// 原先前端根本没传，后端也丢，导致「税号、账期」录不进也查不到（李娜报的 P1-10）
const showSupplierForm = ref(false)
const savingSupplier = ref(false)
const supplierForm = ref({ _id: '', name: '', contact: '', phone: '', tax_no: '', payment_terms: '', address: '' })
const supplierFields = [
  { key: 'name', label: '名称', placeholder: '供应商名称（必填）' },
  { key: 'contact', label: '联系人', placeholder: '如：王经理' },
  { key: 'phone', label: '电话', placeholder: '如：13800000000' },
  { key: 'tax_no', label: '税号', placeholder: '开票用，如 91440600MA...' },
  { key: 'payment_terms', label: '账期', placeholder: '排付款计划用，如：月结30天' },
  { key: 'address', label: '地址', placeholder: '可不填' }
]

function openSupplierForm(s) {
  supplierForm.value = s
    ? {
        _id: s._id,
        name: s.name || '',
        contact: s.contact || '',
        phone: s.phone || '',
        tax_no: s.tax_no || '',
        payment_terms: s.payment_terms || '',
        address: s.address || ''
      }
    : { _id: '', name: '', contact: '', phone: '', tax_no: '', payment_terms: '', address: '' }
  showSupplierForm.value = true
}

async function saveSupplier() {
  if (savingSupplier.value) return
  const f = supplierForm.value
  if (!String(f.name || '').trim()) {
    uni.showToast({ title: '供应商名称不能为空', icon: 'none' })
    return
  }
  savingSupplier.value = true
  try {
    const payload = {
      name: String(f.name).trim(),
      contact: String(f.contact || '').trim(),
      phone: String(f.phone || '').trim(),
      tax_no: String(f.tax_no || '').trim(),
      payment_terms: String(f.payment_terms || '').trim(),
      address: String(f.address || '').trim()
    }
    if (f._id) payload._id = f._id
    await supplierApi.upsert(payload)
    uni.showToast({ title: f._id ? '已更新' : '已新建', icon: 'success' })
    // 刚改的就是当前选中的供应商时，同步单头上的名字（避免名字改了单头还是旧的）
    if (f._id && Number(f._id) === Number(supplierId.value)) supplier.value = payload.name
    showSupplierForm.value = false
    supplierKeyword.value = ''
    await loadSuppliers()
  } catch (err) {
    uni.showToast({ title: err.message || '保存失败', icon: 'none' })
  } finally {
    savingSupplier.value = false
  }
}

const quickQtys = [10, 50, 100, 500]

const totalPrice = computed(() => {
  return cartList.value.reduce((sum, item) => {
    const q = Number(item.quantity) || 0
    const p = Number(item.unit_price) || 0
    return sum + q * p
  }, 0).toFixed(2)
})

const canSubmit = computed(() => {
  if (cartList.value.length === 0) return false
  if (!supplier.value) return false
  return cartList.value.every(item => {
    const q = Number(item.quantity)
    const p = Number(item.unit_price)
    return q > 0 && Number.isInteger(q) && p > 0 && !item.error
  })
})

function isInCart(materialId) {
  return cartList.value.some(item => item.material_id === materialId)
}

function onSearch() {
  page.value = 1
  noMore.value = false
  loadMaterials()
}

/** 读取仓库列表（只有一个仓库时切换条自动隐藏） */
async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    const list = res.list || []
    warehouses.value = list
    if (list.length && !warehouseId.value) {
      warehouseId.value = list[0]._id
    }
  } catch (err) {
    console.warn('加载仓库失败', err)
  }
}

/** 切换仓库：清空当前列表并重拉 */
function switchWarehouse(w) {
  if (Number(warehouseId.value) === Number(w._id)) return
  warehouseId.value = w._id
  activeSub.value = ''
  page.value = 1
  noMore.value = false
  materialList.value = []
  loadCategories()
  loadMaterials()
}

/** 读取当前仓库的细分类清单（配件仓=编号分类，成品仓=车间） */
async function loadCategories() {
  try {
    const res = await materialApi.categories({ warehouse_id: warehouseId.value || undefined })
    subCategories.value = res.subCategories || []
  } catch (err) {
    subCategories.value = []
  }
}

/** 点选/再点取消 细分类筛选 */
function selectSub(s) {
  activeSub.value = activeSub.value === s ? '' : s
  page.value = 1
  noMore.value = false
  loadMaterials()
}

// 加载物料列表（真实接口）
async function loadMaterials() {
  loadingMore.value = true
  try {
    const res = await materialApi.list({
      keyword: keyword.value,
      warehouse_id: warehouseId.value || undefined,
      sub_category: activeSub.value || undefined,
      page: page.value,
      pageSize: pageSize.value
    })
    const list = res.list || []
    materialList.value = page.value === 1 ? list : [...materialList.value, ...list]
    noMore.value = list.length === 0 || materialList.value.length >= (res.total || 0)
  } catch (err) {
    uni.showToast({ title: err.message || '加载失败', icon: 'none' })
  } finally {
    loadingMore.value = false
    refreshing.value = false
  }
}

function loadMore() {
  if (!noMore.value && !loadingMore.value) {
    page.value++
    loadMaterials()
  }
}

function onRefresh() {
  page.value = 1
  noMore.value = false
  loadMaterials()
}

function onScan() {
  uni.scanCode({
    success: (res) => {
      keyword.value = res.result
      onSearch()
    }
  })
}

// 打开供应商弹窗并拉取供应商档案
function openSupplierModal() {
  showSupplierModal.value = true
  loadSuppliers()
}

async function loadSuppliers() {
  supplierLoading.value = true
  try {
    const res = await supplierApi.list({ keyword: supplierKeyword.value, page: 1, pageSize: 50 })
    suppliers.value = res.list || []
  } catch (err) {
    uni.showToast({ title: err.message || '供应商加载失败', icon: 'none' })
  } finally {
    supplierLoading.value = false
  }
}

// 选择物料
function onSelectMaterial(item) {
  if (isInCart(item._id)) {
    uni.showToast({ title: '已在清单中', icon: 'none' })
    return
  }

  cartList.value.push({
    material_id: item._id,
    material_name: item.name,
    material_spec: item.spec,
    unit: item.unit,
    current_stock: item.current_stock,
    warehouse_id: item.warehouse_id,
    quantity: '1',
    unit_price: '',
    error: ''
  })
  cartExpanded.value = true
}

function removeFromCart(index) {
  cartList.value.splice(index, 1)
}

function onQtyInput(index, e) {
  const val = e.detail.value
  const num = Number(val)
  const item = cartList.value[index]

  if (val === '') {
    item.error = ''
    return
  }
  if (!Number.isInteger(num)) {
    item.error = '数量请输入整数'
  } else if (num <= 0) {
    item.error = '数量必须大于0'
  } else {
    item.error = ''
  }
}

function onPriceInput(index, e) {
  const val = e.detail.value
  const num = Number(val)
  const item = cartList.value[index]

  if (val === '') {
    return
  }
  if (isNaN(num) || num <= 0) {
    item.error = '单价必须大于0'
  } else if (item.error === '单价必须大于0') {
    item.error = ''
  }
}

function increaseQty(index) {
  const item = cartList.value[index]
  const num = Number(item.quantity) || 0
  item.quantity = String(num + 1)
  onQtyInput(index, { detail: { value: item.quantity } })
}

function decreaseQty(index) {
  const item = cartList.value[index]
  const num = Number(item.quantity) || 0
  if (num > 1) {
    item.quantity = String(num - 1)
    onQtyInput(index, { detail: { value: item.quantity } })
  }
}

function setQuickQty(index, q) {
  const item = cartList.value[index]
  item.quantity = String(q)
  onQtyInput(index, { detail: { value: item.quantity } })
}

// 选择供应商（带完整信息）
function selectSupplier(s) {
  supplier.value = s.name
  supplierId.value = s._id
  showSupplierModal.value = false
}

function onSubmit() {
  if (!canSubmit.value) return

  // 二次确认
  uni.showModal({
    title: '确认提交',
    content: `共 ${cartList.value.length} 项物料\n合计金额: ¥${totalPrice.value}\n供应商: ${supplier.value}`,
    confirmText: '确认提交',
    cancelText: '再检查一下',
    success: (res) => {
      if (res.confirm) {
        doSubmit()
      }
    }
  })
}

// 提交入库单（采购走入库模块）
async function doSubmit() {
  const items = cartList.value.map((it) => ({
    material_id: it.material_id,
    material_name: it.material_name,
    material_spec: it.material_spec,
    quantity: Number(it.quantity),
    unit: it.unit,
    unit_price: Number(it.unit_price)
  }))
  // 注意：这个局部变量不能叫 warehouseId，
  // 否则会遮蔽上面模块级的「当前筛选仓库」，导致筛选状态被误改
  const orderWarehouseId = cartList.value[0] && cartList.value[0].warehouse_id
  const itemCount = items.length
  const total = totalPrice.value

  uni.showLoading({ title: '提交中...' })
  try {
    const res = await inboundApi.submit({
      items,
      supplier: supplier.value,
      supplier_id: supplierId.value,
      remark: remark.value,
      warehouse_id: orderWarehouseId
    })

    uni.hideLoading()
    uni.vibrateShort()

    cartList.value = []
    supplier.value = ''
    supplierId.value = ''
    remark.value = ''

    uni.showModal({
      title: '入库成功',
      content: `单号: ${res.order_no}\n共 ${itemCount} 项物料\n合计: ¥${total}`,
      confirmText: '查看记录',
      cancelText: '继续入库',
      success: (r) => {
        if (r.confirm) {
          uni.navigateTo({ url: '/pages/purchase/history' })
        }
      }
    })
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none', duration: 3000 })
  }
}

onMounted(async () => {
  await loadWarehouses()
  loadCategories()
  loadMaterials()
  loadSuppliers()
})
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding-bottom: 600rpx;
}

/* 仓库切换条 */
.wh-bar {
  white-space: nowrap;
  padding: 16rpx 20rpx;
  background: #fff;
  border-bottom: 1rpx solid #f0f0f0;

  .wh-item {
    display: inline-block;
    padding: 12rpx 36rpx;
    margin-right: 16rpx;
    border-radius: 36rpx;
    background: #f5f5f5;
    font-size: 26rpx;
    color: #666;
    line-height: 1.6;

    &.active {
      background: #0B4F95;
      color: #fff;
      font-weight: bold;
    }
  }
}

/* 细分类筛选条 */
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
      background: #0B4F95;
      color: #fff;
    }
  }
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 20rpx;
  padding: 20rpx;
  background: #fff;
  position: sticky;
  top: 0;
  z-index: 100;

  .search-input {
    flex: 1;
    display: flex;
    align-items: center;
    background: #f5f5f5;
    border-radius: 40rpx;
    padding: 16rpx 24rpx;

    .search-icon {
      font-size: 28rpx;
      margin-right: 12rpx;
    }

    .input {
      flex: 1;
      font-size: 28rpx;
    }

    .placeholder {
      color: #999;
    }
  }

  .scan-btn {
    width: 80rpx;
    height: 80rpx;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 36rpx;
  }
}

.material-list {
  padding: 20rpx;
  height: calc(100vh - 790rpx);
}

.material-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  &.selected {
    border: 2rpx solid #0B4F95;
  }

  .material-info {
    flex: 1;

    .material-name {
      font-size: 30rpx;
      font-weight: 500;
      color: #333;
      display: block;
    }

    .material-spec {
      font-size: 24rpx;
      color: #999;
      margin-top: 8rpx;
      display: block;
    }

    .material-cat {
      font-size: 22rpx;
      color: #0B4F95;
      margin-top: 6rpx;
      display: block;
    }

    .material-stock {
      font-size: 26rpx;
      color: #666;
      margin-top: 8rpx;
      display: block;
    }
  }

  .material-action {
    .select-text {
      font-size: 26rpx;
      color: #0B4F95;
      font-weight: 500;
    }

    .in-cart {
      font-size: 26rpx;
      color: #999;
    }
  }
}

.loading-more, .no-more, .empty {
  text-align: center;
  padding: 40rpx;
  color: #999;
  font-size: 26rpx;
}

.empty {
  .empty-icon {
    font-size: 80rpx;
    display: block;
    margin-bottom: 20rpx;
  }
}

.cart-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  box-shadow: 0 -4rpx 20rpx rgba(0, 0, 0, 0.1);
  max-height: 75vh;
  padding-bottom: constant(safe-area-inset-bottom);
  padding-bottom: env(safe-area-inset-bottom);

  .cart-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 24rpx 30rpx;
    border-bottom: 1rpx solid #f0f0f0;

    .cart-title {
      font-size: 30rpx;
      font-weight: bold;
      color: #333;
    }

    .cart-toggle {
      font-size: 24rpx;
      color: #999;
    }
  }

  .cart-items {
    max-height: 400rpx;
    padding: 0 30rpx;

    .cart-item {
      display: flex;
      align-items: flex-start;
      padding: 20rpx 0;
      border-bottom: 1rpx solid #f0f0f0;
      gap: 16rpx;

      .cart-item-info {
        flex: 1;

        .cart-item-name {
          font-size: 28rpx;
          color: #333;
          display: block;
        }

        .cart-item-stock {
          font-size: 22rpx;
          color: #999;
          margin-top: 4rpx;
          display: block;
        }
      }

      .cart-item-qty {
        .quick-qty {
          display: flex;
          gap: 8rpx;
          margin-bottom: 8rpx;

          .quick-qty-btn {
            font-size: 20rpx;
            color: #0B4F95;
            background: #e3f2fd;
            padding: 4rpx 12rpx;
            border-radius: 6rpx;
          }
        }

        .qty-input-row {
          display: flex;
          align-items: center;
          gap: 8rpx;
          margin-bottom: 8rpx;

          .qty-btn {
            width: 48rpx;
            height: 48rpx;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #f5f5f5;
            border-radius: 8rpx;
            font-size: 28rpx;
            color: #333;
          }

          .qty-input {
            width: 100rpx;
            height: 48rpx;
            text-align: center;
            background: #f5f5f5;
            border-radius: 8rpx;
            font-size: 26rpx;
          }
        }

        .price-input {
          width: 180rpx;
          height: 48rpx;
          background: #fff8e1;
          border-radius: 8rpx;
          font-size: 26rpx;
          padding: 0 16rpx;
          text-align: center;
        }

        .error-text {
          display: block;
          font-size: 20rpx;
          color: #e74c3c;
          margin-top: 4rpx;
        }
      }

      .remove-btn {
        font-size: 28rpx;
        color: #e74c3c;
        padding: 8rpx;
      }
    }

    .cart-empty {
      text-align: center;
      padding: 40rpx;
      color: #999;
      font-size: 26rpx;
    }
  }

  .cart-footer {
    padding: 20rpx 30rpx 30rpx;

    .form-item {
      margin-bottom: 20rpx;

      .label {
        font-size: 26rpx;
        color: #666;
        display: block;
        margin-bottom: 12rpx;
      }

      .input {
        background: #f5f5f5;
        border-radius: 12rpx;
        padding: 20rpx 24rpx;
        font-size: 30rpx;
        width: 100%;
        box-sizing: border-box;
      }

      .placeholder {
        color: #999;
      }

      .picker {
        background: #f5f5f5;
        border-radius: 12rpx;
        padding: 20rpx 24rpx;

        .picker-value {
          font-size: 30rpx;
          color: #333;
        }
      }

      .supplier-picker {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #f5f5f5;
        border-radius: 12rpx;
        padding: 20rpx 24rpx;

        .picker-value {
          font-size: 30rpx;
          color: #333;
        }

        .picker-arrow {
          font-size: 24rpx;
          color: #999;
        }
      }
    }

    .total-price {
      font-size: 30rpx;
      font-weight: bold;
      color: #0B4F95;
      text-align: right;
      margin-bottom: 16rpx;
    }

    .btn-submit {
      background: #0B4F95;
      color: #fff;
      border-radius: 12rpx;
      padding: 28rpx;
      font-size: 32rpx;
      width: 100%;
      margin-top: 10rpx;

      &:disabled {
        background: #ccc;
      }

      &::after {
        border: none;
      }
    }
  }
}

// 供应商选择弹窗
.supplier-modal-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
  display: flex;
  align-items: flex-end;
}

.supplier-modal {
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  width: 100%;
  max-height: 70vh;

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 30rpx;
    border-bottom: 1rpx solid #f0f0f0;

    .modal-title {
      font-size: 32rpx;
      font-weight: bold;
      color: #333;
    }

    .modal-close {
      font-size: 32rpx;
      color: #999;
      padding: 10rpx;
    }
  }

  .supplier-search {
    padding: 20rpx 20rpx 0;

    .input {
      background: #f5f5f5;
      border-radius: 12rpx;
      padding: 16rpx 24rpx;
      font-size: 28rpx;
    }

    .placeholder {
      color: #999;
    }
  }

  .supplier-empty {
    text-align: center;
    padding: 40rpx;
    color: #999;
    font-size: 26rpx;
  }

  .supplier-list {
    max-height: 50vh;
    padding: 20rpx;

    .supplier-item {
      padding: 24rpx;
      border-bottom: 1rpx solid #f0f0f0;
      border-radius: 12rpx;
      margin-bottom: 12rpx;
      background: #f8f8f8;

      &.selected {
        background: #e3f2fd;
        border: 2rpx solid #0B4F95;
      }

      .supplier-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12rpx;

        .supplier-name {
          font-size: 30rpx;
          font-weight: bold;
          color: #333;
        }

        .supplier-edit {
          font-size: 24rpx;
          color: #0B4F95;
          padding: 6rpx 16rpx;
          border: 1rpx solid #0B4F95;
          border-radius: 20rpx;
        }
      }

      .supplier-info {
        .info-item {
          display: block;
          font-size: 24rpx;
          color: #666;
          margin-top: 6rpx;

          // 税号/账期没填时用红色提示，让采购知道对账开票会卡在哪
          &.info-empty {
            color: #e74c3c;
          }
        }
      }
    }
  }

  .supplier-foot {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 40rpx;
    padding: 24rpx 30rpx 40rpx;
    border-top: 1rpx solid #f0f0f0;

    .add-supplier-btn {
      font-size: 28rpx;
      color: #0B4F95;
      padding: 16rpx 40rpx;
      border: 2rpx dashed #0B4F95;
      border-radius: 12rpx;
    }

    .form-cancel,
    .form-save {
      flex: 1;
      text-align: center;
      font-size: 30rpx;
      padding: 20rpx 0;
      border-radius: 12rpx;
    }

    .form-cancel {
      color: #666;
      background: #f5f5f5;
      margin-right: 20rpx;
    }

    .form-save {
      color: #fff;
      background: #0B4F95;

      &.disabled {
        opacity: 0.6;
      }
    }
  }

  .supplier-form {
    max-height: 50vh;
    padding: 20rpx 30rpx 0;

    .form-row {
      margin-bottom: 24rpx;

      .form-label {
        display: block;
        font-size: 26rpx;
        color: #333;
        margin-bottom: 10rpx;
      }

      .form-input {
        background: #f5f5f5;
        border-radius: 12rpx;
        padding: 18rpx 24rpx;
        font-size: 28rpx;
      }

      .placeholder {
        color: #999;
      }
    }
  }
}
</style>
