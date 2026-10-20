<template>
  <!-- 面板打开时给容器加标记，用于压缩列表高度，避免物料被面板永久压住 -->
  <view class="container" :class="{ 'has-panel': !!selectedMaterial }">
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
      <!-- 新增入库项目：搜不到就地在入库页建档（面板式，不跳页），建完自动选中直接入 -->
      <view class="add-material-btn" @click="openCreate">
        <text>＋新增</text>
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

    <!-- 物料列表：点列表空白处 = 收起底部表单（物料卡片上有 .stop，不会误触） -->
    <scroll-view
      class="material-list"
      scroll-y
      @scrolltolower="loadMore"
      @click="closePanel"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
    >
      <view
        v-for="item in materialList"
        :key="item._id"
        class="material-item"
        @click.stop="onSelectMaterial(item)"
      >
        <!-- 物料照片缩略图（无照片时同尺寸占位，保证列表高度稳定）；点在图上只看大图，不加进清单 -->
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
          <text class="material-spec">{{ item.material_no ? item.material_no + ' · ' : '' }}{{ item.spec || '无规格' }}</text>
          <text v-if="item.sub_category" class="material-cat">{{ item.sub_category }}</text>
          <text class="material-stock">库存: {{ item.current_stock }} {{ item.unit }}</text>
        </view>
        <view class="material-action">
          <text class="select-text">选择</text>
        </view>
      </view>

      <view v-if="loadingMore" class="loading-more">
        <text>加载中...</text>
      </view>

      <!-- 空列表优先于「没有更多了」：搜不到东西时要给「就地新建」的出路，
           否则 noMore 分支会把空态永远挡住 -->
      <view v-else-if="materialList.length === 0" class="empty">
        <text class="empty-icon">📦</text>
        <text class="empty-text">{{ keyword ? `没找到「${keyword}」` : '暂无物料' }}</text>
        <view class="empty-create" @click="openCreate">＋ 就地新建这个物料的档案</view>
      </view>

      <view v-else-if="noMore" class="no-more">
        <text>没有更多了</text>
      </view>

      <!-- 垫底：面板是浮在列表上的，垫高后最后几个物料也能滚到面板上方点到 -->
      <view v-if="selectedMaterial" class="panel-spacer"></view>
    </scroll-view>

    <!-- 底部选中物料表单：可点右上角 ✕ 收起，也可点列表空白处收起 -->
    <view v-if="selectedMaterial" class="submit-panel">
      <view class="panel-head">
        <view class="panel-grabber"></view>
        <view class="panel-close" @click.stop="closePanel">
          <text>✕</text>
        </view>
      </view>

      <view class="selected-info">
        <text class="selected-name">{{ selectedMaterial.name }}</text>
        <text class="selected-stock">当前库存: {{ selectedMaterial.current_stock }} {{ selectedMaterial.unit }}</text>
      </view>

      <view class="form-group">
        <!-- 数量与单价并排：面板是浮层，两个短数字各占一行会让面板过高、把物料列表压没 -->
        <view class="form-row">
          <view class="form-item">
            <text class="label">入库数量</text>
            <input
              v-model="quantity"
              class="input"
              type="number"
              placeholder="请输入数量"
              placeholder-class="placeholder"
            />
          </view>

          <view class="form-item">
            <text class="label">单价（元）{{ needPrice ? '' : '· 可留空' }}</text>
            <input
              v-model="unitPrice"
              class="input"
              type="digit"
              :placeholder="needPrice ? '请输入单价' : '不确定就先不填'"
              placeholder-class="placeholder"
              @input="calcTotal"
            />
          </view>
        </view>

        <view class="form-item">
          <text class="label">小计（元）</text>
          <view v-if="!needPrice && !unitPrice" class="total-price pending">待补价</view>
          <view v-else class="total-price">
            ¥ {{ totalPrice }}
          </view>
          <text v-if="!needPrice && !unitPrice" class="price-hint">
            数量照常入账，这笔先记「待补价」，之后在电脑后台补上金额即可
          </text>
        </view>

        <view class="form-item">
          <!-- 2026-10-09：原先只能纯手输供应商，同一个供应商写法五花八门、对账难做。
               现在可手输也可从档案里选（选完仍可改），并记住上次用的。 -->
          <view class="label-row">
            <text class="label">供应商（选填）</text>
            <text class="pick-link" @click="openSupplierModal">从档案选择</text>
          </view>
          <input
            v-model="supplier"
            class="input"
            placeholder="可直接手输，或点右上角从档案选择"
            placeholder-class="placeholder"
          />
          <view v-if="recentSuppliers.length" class="chip-wrap recent-suppliers">
            <view
              v-for="s in recentSuppliers"
              :key="'recent-' + s"
              class="chip small"
              :class="{ active: supplier === s }"
              @click="supplier = s"
            >{{ s }}</view>
          </view>
        </view>

        <view class="form-item">
          <text class="label">备注（选填）</text>
          <input
            v-model="remark"
            class="input"
            placeholder="选填"
            placeholder-class="placeholder"
          />
        </view>
      </view>

      <button
        class="btn-submit"
        :disabled="!canSubmit"
        @click="onSubmit"
      >
        提交入库
      </button>
    </view>

    <!-- 新建物料档案面板：入库页就地建档，建完自动选中，接着填数量单价就能入 -->
    <view v-if="showCreate" class="submit-panel">
      <view class="panel-head">
        <view class="panel-grabber"></view>
        <view class="panel-close" @click.stop="closeCreate">
          <text>✕</text>
        </view>
      </view>

      <view class="selected-info">
        <text class="selected-name">新建物料档案</text>
        <text class="selected-stock">建好后自动选中，直接填数量单价入库</text>
      </view>

      <view class="form-group">
        <view class="form-item">
          <text class="label">名称 *</text>
          <input v-model="createForm.name" class="input" placeholder="如：火花塞" placeholder-class="placeholder" />
        </view>

        <view class="form-row">
          <view class="form-item">
            <text class="label">单位</text>
            <input v-model="createForm.unit" class="input" placeholder="个 / 套 / 米" placeholder-class="placeholder" />
          </view>
          <view class="form-item">
            <text class="label">预警库存</text>
            <input v-model="createForm.warning_stock" class="input" type="digit" placeholder="低于提示补货，默认10" placeholder-class="placeholder" />
          </view>
        </view>

        <view class="form-item">
          <text class="label">大类 *</text>
          <view class="chip-wrap">
            <view
              v-for="c in categoryOptions"
              :key="c"
              class="chip"
              :class="{ active: !customCategory && createForm.category === c }"
              @click="selectCreateCategory(c)"
            >{{ c }}</view>
            <view class="chip" :class="{ active: customCategory }" @click="selectCustomCategory">其他（手填）</view>
          </view>
          <input
            v-if="customCategory"
            v-model="createForm.category"
            class="input custom-cat"
            placeholder="请输入大类名称，如：配件 / 成品"
            placeholder-class="placeholder"
          />
        </view>

        <view class="form-item">
          <text class="label">规格型号（选填）</text>
          <input v-model="createForm.spec" class="input" placeholder="如：M14×1.25 或 型号 A001" placeholder-class="placeholder" />
          <view v-if="specOptions.length" class="chip-wrap spec-chips">
            <view
              v-for="s in specOptions"
              :key="s"
              class="chip small"
              :class="{ active: createForm.spec === s }"
              @click="createForm.spec = s"
            >{{ s }}</view>
          </view>
        </view>

        <view class="form-item">
          <text class="label">细分类（选填）</text>
          <view v-if="subCategoryOptions.length" class="chip-wrap">
            <view
              v-for="s in subCategoryOptions"
              :key="s"
              class="chip"
              :class="{ active: createForm.sub_category === s }"
              @click="createForm.sub_category = createForm.sub_category === s ? '' : s"
            >{{ s }}</view>
          </view>
          <input
            v-if="!subCategoryOptions.length || !subCategoryOptions.includes(createForm.sub_category)"
            v-model="createForm.sub_category"
            class="input"
            :placeholder="subCategoryOptions.length ? '不在上面？手填细分类' : '如某车间 / 编号类目'"
            placeholder-class="placeholder"
          />
        </view>

        <view class="form-item">
          <text class="label">物料编号（选填）</text>
          <input v-model="createForm.material_no" class="input" placeholder="如 A001-1" placeholder-class="placeholder" />
        </view>

        <view class="form-item">
          <text class="label">物料照片（选填）</text>
          <view class="upload-box" @click="chooseCreatePhoto">
            <text v-if="createUploading">上传中...</text>
            <text v-else-if="createForm.image_fileid">已上传，点击可重传</text>
            <text v-else>＋ 拍照/从相册上传</text>
          </view>
          <image
            v-if="createForm.image_fileid"
            class="create-photo-preview"
            :src="fullFileUrl(createForm.image_fileid)"
            mode="aspectFit"
            @click="previewCreatePhoto"
          />
        </view>
      </view>

      <button class="btn-submit" :disabled="!canCreate" @click="onCreateSubmit">
        {{ creating ? '创建中...' : '创建并入库' }}
      </button>
    </view>

    <!-- 供应商选择弹窗（可搜索 + 可手输兜底；关不掉的口子都留了 ✕ 与点空白关闭） -->
    <view v-if="showSupplierModal" class="supplier-mask" @click="showSupplierModal = false">
      <view class="supplier-panel" @click.stop>
        <view class="panel-head">
          <view class="panel-grabber"></view>
          <view class="panel-close" @click.stop="showSupplierModal = false">
            <text>✕</text>
          </view>
        </view>
        <view class="selected-info">
          <text class="selected-name">选择供应商</text>
          <text class="selected-stock">选中后仍可在输入框里改</text>
        </view>
        <view class="form-item">
          <input
            v-model="supplierKeyword"
            class="input"
            placeholder="搜索供应商名称 / 联系人"
            placeholder-class="placeholder"
            @input="onSupplierSearch"
          />
        </view>
        <scroll-view class="supplier-list" scroll-y>
          <view
            v-for="s in supplierList"
            :key="s._id"
            class="supplier-row"
            :class="{ active: supplier === s.name }"
            @click="selectSupplier(s)"
          >
            <text class="supplier-name">{{ s.name }}</text>
            <text class="supplier-sub">{{ s.contact || '—' }} · {{ s.phone || '—' }}</text>
          </view>
          <view v-if="!supplierLoading && supplierList.length === 0" class="supplier-empty">
            <text>没有匹配的供应商，可直接在上方输入框手输</text>
          </view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { inboundApi, materialApi, warehouseApi, supplierApi } from '@/utils/api'
import { debounce } from '@/utils/debounce'
import { uploadFile, fullFileUrl } from '@/utils/cloud'

// 数据
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

const selectedMaterial = ref(null)
const quantity = ref('')
const unitPrice = ref('')
const supplier = ref('')
const remark = ref('')
// 提交闩锁：防止手快连点造成重复提交（后端幂等兜底，这里是第一道门）
const submitting = ref(false)

// 计算属性
// 当前选中物料所在的仓库（用来判断是不是成品仓）
const currentWarehouse = computed(() => {
  const wid = selectedMaterial.value && selectedMaterial.value.warehouse_id
  if (!wid) return null
  return warehouses.value.find((w) => Number(w._id) === Number(wid)) || null
})

// 是否必须填单价（2026-10-20）
//   成品仓：销售端还没接入，客户那边暂时拿不到价格 → 允许留空，记为「待补价」
//   其他仓（配件仓）：买来要跟采购价对账，缺价事后核不出来 → 必须填
// 口径取「不是成品仓就必须填」，多一个仓进来时默认从严，不会误放开。
const needPrice = computed(() => String((currentWarehouse.value || {}).code || '') !== 'chengpin')

const totalPrice = computed(() => {
  const q = Number(quantity.value) || 0
  const p = Number(unitPrice.value) || 0
  return (q * p).toFixed(2)
})

const canSubmit = computed(() => {
  if (!selectedMaterial.value) return false
  if (!quantity.value || Number(quantity.value) <= 0) return false
  // 成品仓允许单价留空（待补价）；只要填了就必须大于 0
  if (!needPrice.value && String(unitPrice.value || '').trim() === '') return true
  return Number(unitPrice.value) > 0
})

// 搜索物料
function onSearch() {
  page.value = 1
  noMore.value = false
  loadMaterials()
}

// 搜索框输入防抖（统一走 utils/debounce）：近 2000 条物料下逐字请求会卡
const onSearchInput = debounce(onSearch, 300)

/* ---------- 供应商：从档案选择 + 记住上次用过的（2026-10-09 新增） ---------- */
const showSupplierModal = ref(false)
const supplierKeyword = ref('')
const supplierList = ref([])
const supplierLoading = ref(false)
const RECENT_KEY = 'last_suppliers'

// 最近用过的供应商（本机记住，避免每次重新输入造成同一家写法不一致）
const recentSuppliers = ref(uni.getStorageSync(RECENT_KEY) || [])

const onSupplierSearch = debounce(loadSuppliers, 300)

async function loadSuppliers() {
  supplierLoading.value = true
  try {
    const res = await supplierApi.list({
      keyword: supplierKeyword.value || undefined,
      page: 1,
      pageSize: 50
    })
    supplierList.value = res.list || []
  } catch (err) {
    supplierList.value = []
    uni.showToast({ title: err.message || '供应商加载失败', icon: 'none' })
  } finally {
    supplierLoading.value = false
  }
}

function openSupplierModal() {
  showSupplierModal.value = true
  supplierKeyword.value = ''
  loadSuppliers()
}

function selectSupplier(s) {
  supplier.value = s.name
  rememberSupplier(s.name)
  showSupplierModal.value = false
}

/** 记住最近用过的供应商（最多 5 个，最近优先） */
function rememberSupplier(name) {
  if (!name) return
  const list = [name, ...(recentSuppliers.value || []).filter((x) => x !== name)].slice(0, 5)
  recentSuppliers.value = list
  uni.setStorageSync(RECENT_KEY, list)
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

// 加载物料列表
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

// 加载更多
function loadMore() {
  if (!noMore.value && !loadingMore.value) {
    page.value++
    loadMaterials()
  }
}

// 下拉刷新
function onRefresh() {
  page.value = 1
  noMore.value = false
  loadMaterials()
}

// 扫码
function onScan() {
  uni.scanCode({
    success: (res) => {
      keyword.value = res.result
      onSearch()
    }
  })
}

// 找不到物料时就地建档：不跳页，面板里建完自动选中，接着填数量单价入库
const showCreate = ref(false)
const creating = ref(false)
const customCategory = ref(false)
const createForm = ref({ name: '', unit: '个', warning_stock: '', category: '', sub_category: '', spec: '', material_no: '', image_fileid: '' })
const existingAll = ref([]) // 本仓已有物料（生成大类/规格候选）

const categoryOptions = computed(() => {
  const set = new Set(existingAll.value.map((m) => m.category).filter(Boolean))
  return set.size ? [...set] : ['配件', '成品']
})

/** 规格候选：限当前大类，避免把别类的规格选过来 */
const specOptions = computed(() => {
  const list = existingAll.value
    .filter((m) => !createForm.value.category || m.category === createForm.value.category)
    .map((m) => m.spec)
    .filter(Boolean)
  return [...new Set(list)].slice(0, 40)
})

/** 细分类候选：限当前大类下已有的（选完大类直接点，没有再手填） */
const subCategoryOptions = computed(() => {
  const list = existingAll.value
    .filter((m) => createForm.value.category && m.category === createForm.value.category)
    .map((m) => m.sub_category)
    .filter(Boolean)
  return [...new Set(list)].slice(0, 40)
})

const canCreate = computed(() =>
  !!createForm.value.name.trim() && !!createForm.value.category.trim() && !!warehouseId.value && !creating.value
)

function selectCreateCategory(c) {
  customCategory.value = false
  createForm.value.category = c
  // 换大类后清掉不属于它的细分类
  if (!subCategoryOptions.value.includes(createForm.value.sub_category)) {
    createForm.value.sub_category = ''
  }
}
function selectCustomCategory() {
  customCategory.value = true
  createForm.value.category = ''
}

async function openCreate() {
  // 搜索关键词直接当默认名称，少打一遍字
  createForm.value = {
    name: keyword.value.trim(), unit: '个', warning_stock: '',
    category: '', sub_category: '', spec: '', material_no: '', image_fileid: ''
  }
  customCategory.value = false
  closePanel()
  showCreate.value = true
  try {
    const res = await materialApi.list({ warehouse_id: warehouseId.value || undefined, page: 1, pageSize: 500 })
    existingAll.value = res.list || []
  } catch (err) {
    existingAll.value = []
  }
}

function closeCreate() {
  showCreate.value = false
}

/** 建档照片上传/预览 */
const createUploading = ref(false)
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
  if (!canCreate.value) return
  creating.value = true
  uni.showLoading({ title: '创建中...', mask: true })
  try {
    const payload = {
      name: createForm.value.name.trim(),
      spec: createForm.value.spec.trim(),
      category: createForm.value.category.trim(),
      sub_category: createForm.value.sub_category.trim(),
      unit: createForm.value.unit.trim() || '个',
      warehouse_id: warehouseId.value,
      material_no: createForm.value.material_no.trim(),
      image_fileid: createForm.value.image_fileid || ''
    }
    // 预警库存留空用后端默认值（10），不要传空串把它变成 0
    const ws = String(createForm.value.warning_stock || '').trim()
    if (ws) payload.warning_stock = ws

    const res = await materialApi.upsert(payload)
    uni.hideLoading()
    uni.vibrateShort()
    uni.showToast({ title: `「${payload.name}」已建档`, icon: 'none' })
    showCreate.value = false

    // 刷新列表并自动选中新物料，直接接着入库
    keyword.value = payload.name
    page.value = 1
    noMore.value = false
    await loadMaterials()
    const created = materialList.value.find((m) => String(m._id) === String(res._id))
      || materialList.value[0]
    if (created) onSelectMaterial(created)
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '创建失败', icon: 'none', duration: 3000 })
  } finally {
    creating.value = false
  }
}

// 看物料大图：入库登记时要对着实物核一遍，避免入库入错型号
function previewMaterial(item) {
  if (!item || !item.image_fileid) return
  uni.previewImage({ urls: [fullFileUrl(item.image_fileid)] })
}

// 选择物料：再点一次同一物料 = 收起面板（避免"只进不出"）
function onSelectMaterial(item) {
  if (selectedMaterial.value && String(selectedMaterial.value._id) === String(item._id)) {
    closePanel()
    return
  }
  selectedMaterial.value = item
  quantity.value = ''
  unitPrice.value = ''
  supplier.value = ''
  remark.value = ''
}

// 收起底部表单：点 ✕、点列表空白处、再点同一物料都会走这里
function closePanel() {
  if (!selectedMaterial.value) return
  selectedMaterial.value = null
  quantity.value = ''
  unitPrice.value = ''
  supplier.value = ''
  remark.value = ''
}

// 计算小计
function calcTotal() {
  // 自动计算，无需操作
}

// 提交入库
async function onSubmit() {
  if (!canSubmit.value) return
  // 正在提交中，忽略后续点击（连点不产生第二张单）
  if (submitting.value) return

  const material = selectedMaterial.value
  if (!material || !material.warehouse_id) {
    uni.showToast({ title: '物料缺少仓库信息，请重新选择', icon: 'none' })
    return
  }

  // 供应商是选填（与界面上「供应商（选填）」一致）：
  // 不是所有入库都有供应商 —— 车间自制、盘盈调整这类本就没有「跟谁买的」，
  // 强制填写会让这类货入不了账，所以这里不拦。
  // 「有没有供应商」由提交时的 type 体现，见下方 type 的处理。

  // 单价留空 → 传 null（**不能传 0**）：后端据此识别为「待补价」，
  // 数量照常入账、不参与加权成本；传 0 会被当成零成本把均价稀释掉。
  const rawPrice = String(unitPrice.value || '').trim()
  const items = [{
    material_id: material._id,
    material_name: material.name,
    material_spec: material.spec,
    quantity: Number(quantity.value),
    unit: material.unit,
    unit_price: rawPrice === '' ? null : Number(rawPrice)
  }]

  submitting.value = true
  // mask: true 会盖一层遮罩挡住点击，避免提交过程中再次触发
  uni.showLoading({ title: '提交中...', mask: true })
  try {
    const res = await inboundApi.submit({
      items,
      supplier: supplier.value,
      // 按「有没有填供应商」定单据类型：
      //   填了 → 采购入库（后台对账口径，后端会强制要供应商）
      //   没填 → 其他入库（车间自制、盘盈调整等，后端不强制）
      // 这里显式传，避免走后端默认值 purchase 而被当成采购入库卡住
      type: String(supplier.value || '').trim() ? 'purchase' : 'other',
      remark: remark.value,
      warehouse_id: material.warehouse_id
    })

    uni.hideLoading()
    uni.vibrateShort()

    // 记住这次用的供应商，下次可直接点选（同供应商写法保持一致，方便对账）
    if (String(supplier.value || '').trim()) rememberSupplier(String(supplier.value).trim())

    uni.showToast({
      // 重复提交（上一次其实已成功）时说明是同一张单，避免用户以为入了两次
      title: res.__duplicated
        ? `该笔已提交过 ${res.order_no || ''}`
        : `入库成功 ${res.order_no || ''}`,
      icon: 'none',
      duration: 2000
    })

    // 清空表单
    selectedMaterial.value = null
    quantity.value = ''
    unitPrice.value = ''
    supplier.value = ''
    remark.value = ''

    // 重新拉取列表，刷新库存
    onRefresh()
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none', duration: 3000 })
  } finally {
    submitting.value = false
  }
}

// 页面加载
onMounted(async () => {
  await loadWarehouses()
  loadCategories()
  loadMaterials()
})
</script>

<style lang="scss" scoped>
.container {
  /* 整屏高度：H5 端顶部有导航条要减掉，小程序端这两个变量为 0（原生导航在 webview 之外）。
     用 var() 带兜底，两端都成立。
     不要再写 min-height:100vh + 列表 calc(100vh - 固定值)：那套魔法数字一旦对不上，
     列表底就会离屏幕底差一截，露出一条纯背景的灰带（实测差 143px）。 */
  height: 100vh;
  height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
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
      /* 同 .form-item .input：uni-input 默认 1.4em 高会裁字，必须显式给高度 */
      height: 44rpx;
      line-height: 44rpx;
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

  .add-material-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 22rpx;
    height: 60rpx;
    background: #efeaf7;
    border-radius: 30rpx;
    flex-shrink: 0;

    text {
      font-size: 24rpx;
      color: #6b5b95;
    }
  }
}

.material-list {
  /* 弹性填满「筛选条以下 → 屏幕底」的全部剩余空间，不再用 calc(100vh - N) */
  flex: 1;
  min-height: 0; /* flex 子项默认 min-height:auto，会被内容顶开导致整页可滚动 */
  padding: 20rpx;
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
}

/* 面板打开时垫高列表，让最后一个物料也能滚到面板上方（面板是浮层，不占布局）。
   高度对齐面板的 max-height(82vh)，这样任何屏幕尺寸下最后一张卡片都能滚出面板。 */
.panel-spacer {
  height: 82vh;
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

  .empty-create {
    display: inline-block;
    margin-top: 20rpx;
    padding: 14rpx 36rpx;
    background: #0B4F95;
    color: #fff;
    font-size: 26rpx;
    border-radius: 30rpx;
  }
}

/* 建档面板里的 chips（大类/规格候选） */
.chip-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 14rpx;
  margin-bottom: 14rpx;

  .chip {
    padding: 10rpx 24rpx;
    font-size: 24rpx;
    color: #666;
    background: #f0f0f0;
    border-radius: 26rpx;

    &.active {
      background: #0B4F95;
      color: #fff;
    }

    &.small {
      padding: 6rpx 18rpx;
      font-size: 22rpx;
    }
  }
}

.custom-cat {
  margin-top: 6rpx;
}

.spec-chips {
  margin-top: 14rpx;
  margin-bottom: 0;
}

.submit-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 200;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 16rpx 30rpx 30rpx;
  padding-bottom: calc(30rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(30rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -4rpx 20rpx rgba(0, 0, 0, 0.1);
  /* 小屏兜底：面板最高不超过视口 82%，装不下时面板内部滚动，按钮不会被顶出屏幕 */
  max-height: 82vh;
  overflow-y: auto;
  box-sizing: border-box;

  /* 顶部把手 + 收起按钮：面板不再"只进不出" */
  .panel-head {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 56rpx;
    margin-bottom: 10rpx;

    .panel-grabber {
      width: 80rpx;
      height: 8rpx;
      border-radius: 8rpx;
      background: #dcdcdc;
    }

    .panel-close {
      position: absolute;
      right: -10rpx;
      top: 0;
      width: 56rpx;
      height: 56rpx;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 30rpx;
      color: #999;
      line-height: 1;
    }
  }

  .selected-info {
    margin-bottom: 30rpx;
    padding-bottom: 20rpx;
    border-bottom: 1rpx solid #f0f0f0;

    .selected-name {
      font-size: 32rpx;
      font-weight: bold;
      color: #333;
      display: block;
    }

    .selected-stock {
      font-size: 26rpx;
      color: #666;
      margin-top: 8rpx;
      display: block;
    }
  }

  .form-group {
    margin-bottom: 24rpx;

    /* 并排一行：数量 + 单价 */
    .form-row {
      display: flex;
      gap: 20rpx;

      .form-item {
        flex: 1;
        min-width: 0;
      }
    }

    .form-item {
      margin-bottom: 18rpx;

      .label {
        font-size: 26rpx;
        color: #666;
        display: block;
        margin-bottom: 10rpx;
      }

      .input {
        background: #f5f5f5;
        border-radius: 12rpx;
        /* uni-app H5 给 uni-input 写死了 height:1.4em + overflow:hidden，
           只写 padding 会被吃掉、文字被裁（实测外层框只有 22px、内层 input 只有 1px）。
           这里显式给高度与行高，双端都成立，同时把点击热区做到 88rpx。 */
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

      .total-price {
        background: #f5f5f5;
        border-radius: 12rpx;
        height: 88rpx;
        line-height: 88rpx;
        padding: 0 24rpx;
        box-sizing: border-box;
        font-size: 32rpx;
        font-weight: bold;
        color: #0B4F95;
      }

      /* 待补价：不是错误，是「这笔金额以后再补」的正常状态 */
      .total-price.pending {
        color: #B26A00;
        background: #FFF7E6;
      }

      .price-hint {
        display: block;
        margin-top: 10rpx;
        font-size: 22rpx;
        line-height: 1.5;
        color: #B26A00;
      }
    }
  }

  .btn-submit {
    background: #0B4F95;
    color: #fff;
    border-radius: 12rpx;
    padding: 28rpx;
    font-size: 32rpx;
    width: 100%;

    &:disabled {
      background: #ccc;
    }

    &::after {
      border: none;
    }
  }
}

.upload-box {
  font-size: 26rpx;
  color: #0B4F95;
  background: #e8f1fb;
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

/* ---------- 供应商：从档案选择（2026-10-09 新增） ---------- */
.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10rpx;

  .label {
    margin-bottom: 0;
  }

  .pick-link {
    font-size: 24rpx;
    color: #0B4F95;
  }
}

.recent-suppliers {
  margin-top: 12rpx;
}

.supplier-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 90;
  display: flex;
  align-items: flex-end;
}

.supplier-panel {
  width: 100%;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 10rpx 30rpx 40rpx;
  max-height: 82vh;
  overflow-y: auto;

  .form-item {
    margin: 18rpx 0;

    .input {
      background: #f5f5f5;
      border-radius: 12rpx;
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
  }

  .supplier-list {
    max-height: 52vh;

    .supplier-row {
      padding: 24rpx 20rpx;
      border-bottom: 1rpx solid #f0f0f0;

      &.active {
        background: #eef5ff;
      }

      .supplier-name {
        display: block;
        font-size: 30rpx;
        color: #333;
      }

      .supplier-sub {
        display: block;
        font-size: 24rpx;
        color: #999;
        margin-top: 6rpx;
      }
    }

    .supplier-empty {
      padding: 40rpx 0;
      text-align: center;
      font-size: 26rpx;
      color: #999;
    }
  }
}
</style>
