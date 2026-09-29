<template>
  <div class="material-import">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>批量导入物料</span>
        </div>
      </template>

      <el-steps :active="currentStep" align-center>
        <el-step title="下载模板" />
        <el-step title="上传文件" />
        <el-step title="确认导入" />
      </el-steps>

      <div class="step-content">
        <!-- 步骤 1：下载模板 -->
        <div v-if="currentStep === 0" class="step-1">
          <el-alert type="info" :closable="false">
            <p>请先下载 CSV 模板，按照模板格式填写物料信息（表头请勿修改）</p>
          </el-alert>
          <el-button type="primary" @click="downloadTemplate">
            <el-icon><Download /></el-icon>下载模板
          </el-button>
          <el-button @click="currentStep = 1">下一步</el-button>
        </div>

        <!-- 步骤 2：上传文件 -->
        <div v-if="currentStep === 1" class="step-2">
          <el-form :inline="true" class="warehouse-form">
            <el-form-item label="导入到仓库">
              <el-select
                v-model="warehouseId"
                placeholder="请选择仓库"
                style="width: 200px"
                :disabled="warehouseLocked"
              >
                <el-option v-for="w in warehouses" :key="w._id" :label="w.name" :value="w._id" />
              </el-select>
              <span v-if="warehouseLocked && lockedWarehouseName" class="lock-hint">
                已固定为「{{ lockedWarehouseName }}」，避免导错仓
              </span>
            </el-form-item>
          </el-form>

          <el-upload
            class="upload-area"
            drag
            action="#"
            :auto-upload="false"
            :show-file-list="false"
            accept=".csv"
            :on-change="handleFileChange"
          >
            <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
            <div class="el-upload__text">
              将文件拖到此处，或 <em>点击上传</em>
            </div>
            <template #tip>
              <div class="el-upload__tip">只能上传 CSV 文件（可用 Excel 另存为 CSV）</div>
            </template>
          </el-upload>

          <div v-if="fileName" class="file-preview">
            <p>已选择文件: {{ fileName }}</p>
            <el-button type="primary" @click="parseFile">解析文件</el-button>
            <el-button @click="resetFile">重新选择</el-button>
          </div>

          <el-button class="back-btn" @click="currentStep = 0">上一步</el-button>
        </div>

        <!-- 步骤 3：确认导入 -->
        <div v-if="currentStep === 2" class="step-3">
          <el-alert type="success" :closable="false">
            <p>共解析到 {{ importData.length }} 条物料数据（重复的同名同规格物料将自动跳过）</p>
          </el-alert>

          <el-alert
            v-if="ignoredStockColumn"
            type="warning"
            :closable="false"
            show-icon
            style="margin-top: 12px"
          >
            <p>文件里的「初始库存」列已被忽略。库存只能由采购入库、盘点和出库产生，不能靠导入凭空写数。</p>
          </el-alert>

          <el-table :data="importData" style="width: 100%" max-height="400">
            <el-table-column prop="name" label="物料名称" />
            <el-table-column prop="spec" label="规格" />
            <el-table-column prop="category" label="分类" />
            <el-table-column prop="unit" label="单位" />
            <el-table-column prop="warning_stock" label="预警库存" width="100" />
          </el-table>

          <div class="step-actions">
            <el-button @click="currentStep = 1">上一步</el-button>
            <el-button type="primary" :loading="importing" @click="confirmImport">
              确认导入 {{ importData.length }} 条
            </el-button>
          </div>
        </div>

        <!-- 导入结果 -->
        <div v-if="importResult" class="import-result">
          <el-alert
            :type="importResult.failed > 0 ? 'warning' : 'success'"
            :closable="false"
            show-icon
          >
            <p>
              导入完成：新增 {{ importResult.success }} 条，跳过重复 {{ importResult.skipped }} 条，
              失败 {{ importResult.failed }} 条
            </p>
          </el-alert>
          <el-table
            v-if="importResult.errors && importResult.errors.length"
            :data="importResult.errors"
            style="width: 100%; margin-top: 12px"
            max-height="240"
          >
            <el-table-column prop="name" label="物料名称" />
            <el-table-column prop="error" label="失败原因" />
          </el-table>
          <div class="step-actions">
            <el-button type="primary" @click="goMaterialList">查看物料列表</el-button>
            <el-button @click="restart">再导入一批</el-button>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Download, UploadFilled } from '@element-plus/icons-vue'
import { materialApi, warehouseApi } from '@/api'

const router = useRouter()
const route = useRoute()

const currentStep = ref(0)
const fileName = ref('')
const rawFile = ref(null)
const importData = ref([])
const importing = ref(false)
const importResult = ref(null)
// 上传的文件里是否带了「初始库存」列（带了就提示会被忽略）
const ignoredStockColumn = ref(false)

const warehouses = ref([])
const warehouseId = ref('')

/** 当前选中仓库的名字，用于「已固定为 xx」提示 */
const lockedWarehouseName = computed(() => {
  const w = warehouses.value.find((x) => Number(x._id) === Number(warehouseId.value))
  return w ? w.name : ''
})

function downloadTemplate() {
  // 模板只含物料档案字段。库存不允许通过导入设置（否则会出现"凭空有库存、查不到任何流水"）
  const sample = [
    ['物料名称（必填）', '规格型号', '分类', '单位', '预警库存'],
    ['示例-机油滤芯', 'OIL-003', '滤清器', '个', '10']
  ]
  const csv = sample.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '物料导入模板.csv'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  ElMessage.success('模板下载成功')
}

function handleFileChange(file) {
  const f = file && file.raw ? file.raw : file
  rawFile.value = f || null
  fileName.value = (f && f.name) || ''
  importData.value = []
  importResult.value = null
  ignoredStockColumn.value = false
}

function resetFile() {
  rawFile.value = null
  fileName.value = ''
  importData.value = []
  ignoredStockColumn.value = false
}

/** 解析 CSV 文本（支持引号包裹、逗号与换行） */
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch === '\r') {
      // 忽略
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''))
}

async function parseFile() {
  // el-upload 已禁用手动列表，优先用 on-change 缓存的原始文件
  let file = rawFile.value
  if (!file) {
    const input = document.querySelector('.upload-area input[type=file]')
    file = input && input.files && input.files[0]
  }

  if (!file) {
    ElMessage.warning('请先选择 CSV 文件')
    return
  }

  try {
    const text = await file.text()
    const rows = parseCsv(text)
    if (rows.length < 2) {
      ElMessage.warning('文件内容为空或格式不正确')
      return
    }

    // 第一行为表头。既接受下载模板的中文表头，也接受英文表头（历史文件）
    const header = rows[0].map((h) => String(h).trim().toLowerCase())
    const HEADER_ALIASES = {
      name: ['name', '物料名称', '物料名称（必填）', '名称', '物料'],
      spec: ['spec', '规格型号', '规格'],
      category: ['category', '分类'],
      unit: ['unit', '单位'],
      warning_stock: ['warning_stock', '预警库存', '警戒库存', '安全库存'],
      current_stock: ['current_stock', '初始库存', '期初库存', '库存']
    }
    const idx = (key) => {
      const aliases = HEADER_ALIASES[key] || [key]
      for (const a of aliases) {
        const i = header.indexOf(a)
        if (i >= 0) return i
      }
      return -1
    }

    // 文件里带了库存列 → 明确告知会被忽略（后端也会拒绝写库存）
    ignoredStockColumn.value = idx('current_stock') >= 0

    const items = []
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      const name = String(r[idx('name')] || '').trim()
      if (!name) continue
      items.push({
        name,
        spec: String(r[idx('spec')] || '').trim(),
        category: String(r[idx('category')] || '').trim(),
        unit: String(r[idx('unit')] || '').trim() || '个',
        warning_stock: Number(r[idx('warning_stock')] || 10) || 10
      })
    }

    if (!items.length) {
      ElMessage.warning('未解析到有效物料数据（请检查 name 列是否填写）')
      return
    }

    importData.value = items
    currentStep.value = 2
  } catch (err) {
    ElMessage.error('解析文件失败：' + (err.message || '未知错误'))
  }
}

async function confirmImport() {
  if (!warehouseId.value) {
    ElMessage.warning('请选择导入到哪个仓库')
    return
  }

  importing.value = true
  try {
    const materials = importData.value.map((it) => ({ ...it, warehouse_id: warehouseId.value }))
    const res = await materialApi.import({ materials })
    importResult.value = res.data || { total: materials.length, success: 0, skipped: 0, failed: 0, errors: [] }
    ElMessage.success(res.message || '导入完成')
  } catch (err) {
    ElMessage.error(err.message || '导入失败')
  } finally {
    importing.value = false
  }
}

/** 列表页带过来的仓库编码：导入完要回到同一个仓库的列表 */
const backWarehouseCode = computed(() => String(route.query.warehouse_code || ''))
/** 从某个仓库的列表进来时，锁定导入到该仓，防止导错地方 */
const warehouseLocked = computed(() => !!backWarehouseCode.value)

/** 返回到对的物料列表：从配件仓/成品仓进来的，就回那个仓 */
function goMaterialList() {
  if (backWarehouseCode.value === 'peijian') return router.push('/material/parts')
  if (backWarehouseCode.value === 'chengpin') return router.push('/material/product')
  return router.push('/material/list')
}

function restart() {
  currentStep.value = 1
  importResult.value = null
  resetFile()
}

onMounted(async () => {
  try {
    const res = await warehouseApi.list()
    warehouses.value = (res.data && res.data.list) || []
    // 默认导入到配件仓；若从某个仓库的列表进来，就用那个仓
    const wanted = backWarehouseCode.value
      ? warehouses.value.find((w) => w.code === backWarehouseCode.value)
      : null
    const peijian = wanted || warehouses.value.find((w) => w.code === 'peijian')
    warehouseId.value = peijian ? peijian._id : (warehouses.value[0] && warehouses.value[0]._id) || ''
  } catch (err) {
    ElMessage.error(err.message || '加载仓库失败')
  }
})
</script>

<style scoped>
.material-import {
  padding: 0;
}

.step-content {
  margin-top: 40px;
  padding: 20px;
  text-align: center;
}

.upload-area {
  margin-bottom: 20px;
}

.file-preview {
  margin: 20px 0;
}

.step-actions {
  margin-top: 20px;
}

.back-btn {
  margin-top: 20px;
}

.warehouse-form {
  margin-bottom: 16px;
}

/* 从某个仓库列表进来时，提示导入仓库已固定 */
.lock-hint {
  margin-left: 10px;
  font-size: 12px;
  color: #e6a23c;
}

.import-result {
  margin-top: 24px;
  text-align: left;
}

/* el-upload tip 内容为说明文字，保持左对齐 */
.step-content :deep(.el-upload__tip) {
  text-align: center;
}
</style>
