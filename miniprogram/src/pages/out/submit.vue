<template>
  <view class="container">
    <!-- 成品仓出库模式提示（厂长）：仓库已锁定，不给切 -->
    <view v-if="isFinishedOut" class="mode-banner">
      <text class="mode-title">🚚 成品仓出库</text>
      <text class="mode-desc">提交后由成品仓管拣货，拣完会通知你确认收货</text>
    </view>

    <!-- 搜索栏 -->
    <view class="search-bar">
      <view class="search-input">
        <text class="search-icon">🔍</text>
        <input
          v-model="keyword"
          class="input"
          placeholder="搜索物料名称/规格"
          placeholder-class="placeholder"
          @input="onSearchInput"
        />
      </view>
      <view class="scan-btn" @click="onScan">
        <text>📷</text>
      </view>
    </view>

    <!-- 仓库切换：配件仓和成品仓的货要分开看，否则容易领错仓 -->
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
        :class="{ disabled: stockVisible && item.current_stock <= 0, selected: isInCart(item._id) }"
        @click="onSelectMaterial(item)"
      >
        <!--
          物料照片缩略图。
          ⚠️ 没有照片时也占同样大小（显示「无图」）——不然列表高度会随有没有照片忽高忽低，
             用户滑动手感很差，看起来还像加载失败。
          ⚠️ 点缩略图只看大图，不能顺手把料加进清单，所以 @click 要 .stop。
        -->
        <image
          v-if="item.image_fileid"
          class="material-thumb"
          :src="fullFileUrl(item.image_fileid)"
          mode="aspectFill"
          @click.stop="previewMaterial(item)"
        />
        <view v-else class="material-thumb material-thumb-empty">
          <text>无图</text>
        </view>
        <view class="material-info">
          <text class="material-name">{{ item.name }}</text>
          <text class="material-spec">{{ item.material_no ? item.material_no + ' · ' : '' }}{{ item.spec || '无规格' }} | {{ item.warehouse_name }}</text>
          <text v-if="item.sub_category" class="material-cat">{{ item.sub_category }}</text>
          <text v-if="stockVisible" class="material-stock" :class="{ warning: item.current_stock <= item.warning_stock }">
            库存: {{ item.current_stock }} {{ item.unit }}
          </text>
        </view>
        <view class="material-action">
          <text v-if="isInCart(item._id)" class="in-cart">已加入</text>
          <text v-else class="select-text">{{ stockVisible && item.current_stock <= 0 ? '缺货' : '加入清单' }}</text>
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

    <!-- 领料清单（批量） -->
    <view class="cart-panel" :class="{ expanded: cartExpanded }">
      <view class="cart-header" @click="toggleCart">
        <text class="cart-title">{{ cartTitle }}</text>
        <text v-if="cartList.length" class="cart-toggle">{{ cartExpanded ? '▼ 收起' : '▲ 展开' }}</text>
      </view>

      <scroll-view v-if="cartExpanded && cartList.length > 0" class="cart-items" scroll-y>
        <view v-for="(cartItem, index) in cartList" :key="cartItem.material_id" class="cart-item">
          <view class="cart-item-info">
            <text class="cart-item-name">{{ cartItem.material_name }}</text>
            <text v-if="stockVisible" class="cart-item-stock">库存: {{ cartItem.current_stock }} {{ cartItem.unit }}</text>
          </view>
          <view class="cart-item-qty">
            <!-- 数量快捷键 -->
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
            <text v-if="cartItem.error" class="error-text">{{ cartItem.error }}</text>
          </view>
          <text class="remove-btn" @click.stop="removeFromCart(index)">✕</text>
        </view>
      </scroll-view>

      <!-- 出库类型 + 备注 + 提交 -->
      <view v-if="cartExpanded && cartList.length > 0" class="cart-footer">
        <view class="form-item">
          <text class="label">出库类型</text>
          <picker
            class="picker"
            :range="outTypes"
            range-key="label"
            @change="onTypeChange"
          >
            <view class="picker-value">
              {{ selectedType?.label || '请选择类型' }}
            </view>
          </picker>
        </view>

        <view class="form-item">
          <text class="label">用途/备注</text>
          <input
            v-model="remark"
            class="input"
            placeholder="选填"
            placeholder-class="placeholder"
          />
        </view>

        <button
          class="btn-submit"
          :disabled="!canSubmit"
          @click="onSubmit"
        >
          提交出库（{{ cartList.length }} 项）
        </button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { outboundApi, materialApi, warehouseApi } from '@/utils/api'
import { debounce } from '@/utils/debounce'
import { fullFileUrl } from '@/utils/cloud'

// 搜索 + 列表
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

// 清单（批量模式）
const cartList = ref([]) // [{ material_id, material_name, unit, current_stock, quantity, error }]
const cartExpanded = ref(true)
const remark = ref('')
const selectedType = ref(null)
// 提交闩锁：防止手快连点造成重复提交（后端幂等兜底，这里是第一道门）
const submitting = ref(false)

// 空清单时不开抽屉：展开也只是给一句提示，白占 60px，还把列表最后一张卡片压住。
// 提示改由栏头文案承担，加料后行为与以前完全一致（默认展开、可收起、显示提交表单）。
const cartTitle = computed(() =>
  cartList.value.length ? `领料清单 (${cartList.value.length} 项)` : '领料清单 · 点下方物料加入'
)
function toggleCart() {
  if (!cartList.value.length) return
  cartExpanded.value = !cartExpanded.value
}

// ===== 成品仓出库模式（厂长用，2026-10-09 新增）=====
// 厂长面板点「成品仓出库」进来会带 ?wh=chengpin：
//   锁定仓库（只有一个仓库时切仓条自动隐藏）、出库类型换成成品出库常用的「销售/领用」。
// ⚠️ 这里锁死只是体验，不是防线：后端 outbound.submit 里的 assertDirectorWarehouse
//    会再按物料实际所属仓库判一次，改 URL 参数绕不过去。
const lockedWhCode = ref('')
const isFinishedOut = computed(() => !!lockedWhCode.value)

// 数量快捷键
const quickQtys = [10, 50, 100, 500]

const outTypes = computed(() => (isFinishedOut.value
  ? [{ value: 'sale', label: '销售' }, { value: 'lingyong', label: '领用' }]
  : [{ value: 'lingyong', label: '领用' }, { value: 'repair', label: '维修' }]))

// 领料员看不到库存（服务端脱敏后 current_stock 不存在），此时不做本地库存校验，
// 缺不缺货由仓管确认时把关（不够会退单并写原因）
const stockVisible = computed(() =>
  materialList.value.length > 0 && materialList.value[0].current_stock !== undefined)

const canSubmit = computed(() => {
  if (cartList.value.length === 0) return false
  if (!selectedType.value) return false
  return cartList.value.every(item => {
    const q = Number(item.quantity)
    const stockOk = !stockVisible.value || q <= Number(item.current_stock || 0)
    return q > 0 && Number.isInteger(q) && stockOk && !item.error
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

// 搜索框输入防抖（统一走 utils/debounce）：避免每敲一个字都请求一次。
// 模板 @input 已改绑这个包装函数；onSearch 保留原名给扫码等需要立即搜索的场景用。
const onSearchInput = debounce(onSearch, 300)

/** 读取仓库列表（只有一个仓库时切换条自动隐藏） */
async function loadWarehouses() {
  try {
    const res = await warehouseApi.list()
    let list = res.list || []
    // 成品仓出库模式：只留锁定的那个仓库 → 切换条因长度为 1 自动隐藏
    if (lockedWhCode.value) {
      const hit = list.find(
        (w) => String(w.code) === lockedWhCode.value || String(w._id) === lockedWhCode.value
      )
      if (!hit) {
        uni.showToast({ title: '找不到指定仓库，请改用普通领料入口', icon: 'none', duration: 3000 })
      }
      list = hit ? [hit] : list
    }
    warehouses.value = list
    if (list.length && (!warehouseId.value || lockedWhCode.value)) {
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

// 加入清单
/**
 * 看物料大图。
 * 领料员最怕的就是「名字规格都对、拿错型号」——货架上长得像的料太多，
 * 有照片就能当面核一遍（照片由管理员在后台物料档案里维护）。
 */
function previewMaterial(item) {
  if (!item || !item.image_fileid) return
  uni.previewImage({ urls: [fullFileUrl(item.image_fileid)] })
}

function onSelectMaterial(item) {
  if (stockVisible.value && item.current_stock <= 0) {
    uni.showToast({ title: '该物料缺货', icon: 'none' })
    return
  }  if (isInCart(item._id)) {
    uni.showToast({ title: '已在清单中', icon: 'none' })
    return
  }

  // 一张出库单只能是一个仓库的货（混仓会导致单据记错仓库、扣错库存）
  const first = cartList.value[0]
  if (first && Number(first.warehouse_id) !== Number(item.warehouse_id)) {
    uni.showModal({
      title: '不能跨仓库领料',
      showCancel: false,
      confirmText: '知道了',
      content: `清单里已经是「${first.warehouse_name || '其他仓库'}」的物料。\n一张出库单只能装同一个仓库的货，请先提交或清空清单后，再领「${item.warehouse_name || '另一仓库'}」的物料。`
    })
    return
  }

  cartList.value.push({
    material_id: item._id,
    material_name: item.name,
    material_spec: item.spec,
    unit: item.unit,
    current_stock: item.current_stock,
    warehouse_id: item.warehouse_id,
    warehouse_name: item.warehouse_name || '',
    quantity: '1',
    error: ''
  })
  cartExpanded.value = true
}

function removeFromCart(index) {
  cartList.value.splice(index, 1)
}

// 数量操作
function onQtyInput(index, e) {
  const val = e.detail.value
  const num = Number(val)
  const item = cartList.value[index]

  if (val === '') {
    item.error = ''
    return
  }
  if (!Number.isInteger(num)) {
    item.error = '请输入整数'
  } else if (num <= 0) {
    item.error = '数量必须大于0'
  } else if (num > item.current_stock) {
    item.error = `超出库存(最多${item.current_stock})`
  } else {
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
  } else {
    // 数量已是 1 再点「-」= 不要这项了，直接从清单移除（比留着 1 再长按删除顺手）
    const name = item.material_name
    cartList.value.splice(index, 1)
    uni.showToast({ title: `已移除「${name}」`, icon: 'none' })
  }
}

function setQuickQty(index, q) {
  const item = cartList.value[index]
  item.quantity = String(q)
  onQtyInput(index, { detail: { value: item.quantity } })
}

function onTypeChange(e) {
  // ⚠️ outTypes 是 computed（成品仓模式要换成销售/领用），脚本里必须 .value——
  //    模板里会自动拆包所以 :range="outTypes" 没事，但这里按下标取值不拆包就永远是 undefined
  //    （2026-10-10 真机事故：类型选不了、提交按钮一直灰）
  selectedType.value = outTypes.value[e.detail.value]
}

// 提交出库（批量）
async function onSubmit() {
  if (!canSubmit.value) return
  // 正在提交中，忽略后续点击（连点不产生第二张单）
  if (submitting.value) return

  // 仓库取清单里物料的真实归属仓库（不再写死兜底值）
  const wid = cartList.value[0] && cartList.value[0].warehouse_id
  if (!wid) {
    uni.showToast({ title: '物料缺少仓库信息，请移除后重新选择', icon: 'none' })
    return
  }
  if (cartList.value.some(it => Number(it.warehouse_id) !== Number(wid))) {
    uni.showModal({
      title: '不能跨仓库领料',
      showCancel: false,
      confirmText: '知道了',
      content: '清单里混了不同仓库的物料，请分开提交。'
    })
    return
  }

  const items = cartList.value.map(item => ({
    material_id: item.material_id,
    material_name: item.material_name,
    material_spec: item.material_spec,
    quantity: Number(item.quantity),
    unit: item.unit
  }))
  const itemCount = items.length

  submitting.value = true
  // mask: true 会盖一层遮罩挡住点击，避免提交过程中再次触发
  uni.showLoading({ title: '提交中...', mask: true })
  try {
    const res = await outboundApi.submit({
      items,
      type: selectedType.value.value,
      remark: remark.value,
      warehouse_id: wid
    })

    uni.hideLoading()
    uni.vibrateShort()

    const orderNo = res.order_no || ''

    // 清空清单
    cartList.value = []
    remark.value = ''
    selectedType.value = null

    uni.showModal({
      // 上一次其实已成功、这次是重复提交（后端返回原单）时，文案要说清，避免用户以为下了两单
      title: res.__duplicated ? '这笔已提交成功' : '领料单已提交',
      content: res.__duplicated
        ? `上一次提交其实已经成功，这是同一张单\n单号: ${orderNo}`
        : `单号: ${orderNo}\n共 ${itemCount} 项\n仓管确认拣货后会发消息通知你来收货`,
      confirmText: '查看记录',
      cancelText: '继续领料',
      success: (r) => {
        if (r.confirm) {
          uni.navigateTo({ url: '/pages/out/history' })
        }
      }
    })
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none', duration: 3000 })
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await loadWarehouses()
  loadCategories()
  loadMaterials()
})

/**
 * 「再来一单」（2026-10-09 新增）
 * 从出库历史的某张单带过来 → 把原单明细预填进清单，数量可改，避免重复领料时重新一个个搜。
 * 注意：库存可能已被脱敏（领料员看不到），预填后仍需仓管确认时把关。
 */
async function prefillFromOrder(orderId) {
  uni.showLoading({ title: '载入原单…', mask: true })
  try {
    const res = await outboundApi.detail({ id: orderId })
    const items = res.items || []
    if (!items.length) {
      uni.hideLoading()
      uni.showToast({ title: '原单没有明细，无法再来一单', icon: 'none' })
      return
    }

    cartList.value = items.map(it => ({
      material_id: it.material_id,
      material_name: it.material_name,
      material_spec: it.material_spec,
      unit: it.unit,
      current_stock: it.current_stock,
      warehouse_id: res.warehouse_id,
      warehouse_name: res.warehouse_name || '',
      quantity: String(it.quantity || 1),
      error: ''
    }))

    // 单据类型沿用原单（领用/维修）；取不到就让用户自己选
    // ⚠️ outTypes 是 computed，脚本里用要 .value（见 onTypeChange 的注释）
    const t = outTypes.value.find(x => x.value === res.type)
    if (t) selectedType.value = t

    // 切到原单所在仓库，避免「物料列表是 A 仓、清单却是 B 仓」的错配
    if (res.warehouse_id) {
      warehouseId.value = res.warehouse_id
      activeSub.value = ''
      await loadCategories()
      page.value = 1
      noMore.value = false
      await loadMaterials()
    }

    cartExpanded.value = true
    uni.hideLoading()
    uni.showToast({ title: `已载入原单 ${items.length} 项，请核对数量`, icon: 'none' })
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '载入原单失败', icon: 'none' })
  }
}

// 页面参数必须用 onLoad 拿（小程序端 getCurrentPages().$page.options 拿不到）
onLoad((options) => {
  if (options && options.from_order) {
    prefillFromOrder(options.from_order)
  }
  // 成品仓出库模式（厂长面板进来）：wh=chengpin 或 wh=2
  if (options && options.wh) lockedWhCode.value = String(options.wh)
})
</script>

<style lang="scss" scoped>
.container {
  /* 整屏高度：H5 减掉顶部导航，小程序端 --window-top 为 0（原生导航在 webview 之外）。
     列表用 flex:1 填满剩余空间，避免列表底离屏幕底差一截、露出纯背景灰带。 */
  height: 100vh;
  height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
}

/* 成品仓出库模式提示条（厂长专属入口） */
.mode-banner {
  display: flex;
  flex-direction: column;
  background: #eef6ff;
  border-bottom: 1rpx solid #cfe4f7;
  padding: 20rpx 24rpx;

  .mode-title {
    font-size: 28rpx;
    font-weight: bold;
    color: #1b4f72;
  }

  .mode-desc {
    font-size: 22rpx;
    color: #5d7c94;
    margin-top: 6rpx;
  }
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
      background: #0F7A3D;
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
      background: #0F7A3D;
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
  /* 填满「筛选条以下 → 屏幕底」，底部再垫出领料清单栏的高度（栏高实测 90rpx），
     否则滚到底时最后一张卡片会被这条固定栏盖住 */
  flex: 1;
  min-height: 0;
  padding: 20rpx;
  padding-bottom: calc(100rpx + env(safe-area-inset-bottom));
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

  /* 物料照片缩略图：有图/无图都占同样大小，列表高度才稳定 */
  .material-thumb {
    width: 96rpx;
    height: 96rpx;
    border-radius: 12rpx;
    margin-right: 20rpx;
    flex-shrink: 0;
    background: #f2f3f5;
  }

  .material-thumb-empty {
    display: flex;
    align-items: center;
    justify-content: center;

    text {
      font-size: 20rpx;
      color: #c0c4cc;
    }
  }

  &.disabled {
    opacity: 0.5;
  }

  &.selected {
    border: 2rpx solid #0F7A3D;
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
      color: #0F7A3D;
      margin-top: 6rpx;
      display: block;
    }

    .material-stock {
      font-size: 26rpx;
      color: #666;
      margin-top: 8rpx;
      display: block;

      &.warning {
        color: #e74c3c;
        font-weight: bold;
      }
    }
  }

  .material-action {
    .select-text {
      font-size: 26rpx;
      color: #0F7A3D;
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

// 清单面板
.cart-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  box-shadow: 0 -4rpx 20rpx rgba(0, 0, 0, 0.1);
  max-height: 70vh;
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
            color: #0F7A3D;
            background: #e8f5e9;
            padding: 4rpx 12rpx;
            border-radius: 6rpx;
          }
        }

        .qty-input-row {
          display: flex;
          align-items: center;
          gap: 8rpx;

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
        /* uni-app H5 给 uni-input 写死了 height:1.4em + overflow:hidden：
           只写上下 padding 会被吃掉，内层 input 塌成 1px，输入的字看不见。
           显式给高度与行高，小程序端同样成立。 */
        height: 88rpx;
        line-height: 88rpx;
        padding: 0 24rpx;
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
    }

    .btn-submit {
      background: #0F7A3D;
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
</style>
