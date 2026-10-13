<template>
  <view class="container">
    <!-- 说明 -->
    <view class="intro-card">
      <text class="intro-title">报废申请</text>
      <text class="intro-text">物料损坏/报废在这里登记。必须上传现场照片并写明原因，提交后由仓管确认出库。</text>
    </view>

    <!-- 选物料 -->
    <view class="card">
      <view class="card-header">
        <text class="section-title">报废物料<text class="req">*</text></text>
      </view>
      <view class="card-body">
        <view v-if="!selected" class="search-box">
          <input
            v-model="keyword"
            class="input"
            placeholder="搜索物料名称 / 编号 / 规格"
            placeholder-class="ph"
            @input="onSearch"
          />
          <view
            v-for="m in searchList"
            :key="m._id"
            class="hit"
            @click="onPick(m)"
          >
            <text class="hit-name">{{ m.name }}{{ m.spec ? ' / ' + m.spec : '' }}</text>
            <text class="hit-sub">{{ m.material_no || '' }} {{ m.warehouse_name || '' }}</text>
          </view>
          <view v-if="searched && !searchList.length" class="empty-hint">没找到，换个关键词试试</view>
        </view>
        <view v-else class="selected-box">
          <view class="selected-info">
            <text class="selected-name">{{ selected.name }}{{ selected.spec ? ' / ' + selected.spec : '' }}</text>
            <text class="selected-sub">{{ selected.material_no || '' }} {{ selected.warehouse_name || '' }}</text>
          </view>
          <text class="link" @click="onUnpick">重选</text>
        </view>
      </view>
    </view>

    <!-- 数量 -->
    <view class="card">
      <view class="card-body">
        <view class="field">
          <text class="field-label">报废数量<text class="req">*</text></text>
          <input v-model="quantity" class="input" type="number" placeholder="填正整数" placeholder-class="ph" />
        </view>
      </view>
    </view>

    <!-- 现场照片（必传） -->
    <view class="card">
      <view class="card-body">
        <view class="field">
          <text class="field-label">现场照片<text class="req">*</text></text>
          <view class="upload-box" @click="choosePhoto">
            <text v-if="uploading">上传中...</text>
            <text v-else-if="attachment">已上传，点击可重拍</text>
            <text v-else>＋ 拍照/从相册上传</text>
          </view>
          <image v-if="attachment" class="preview" :src="fullFileUrl(attachment)" mode="aspectFit" @click="previewPhoto" />
        </view>
      </view>
    </view>

    <!-- 报废原因（必填） -->
    <view class="card">
      <view class="card-body">
        <view class="field">
          <text class="field-label">报废原因<text class="req">*</text></text>
          <textarea
            v-model="remark"
            class="textarea"
            placeholder="如：加工报废 / 来料破损 / 存放生锈…"
            placeholder-class="ph"
            maxlength="200"
          />
        </view>
      </view>
    </view>

    <view class="action-bar">
      <button class="btn-primary" :class="{ disabled: !canSubmit || submitting }" @click="onSubmit">
        {{ submitting ? '提交中...' : '提交报废申请' }}
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { outboundApi, materialApi } from '@/utils/api'
import { uploadFile, fullFileUrl } from '@/utils/cloud'

const keyword = ref('')
const searchList = ref([])
const searched = ref(false)
const selected = ref(null)
const quantity = ref('')
const attachment = ref('')
const uploading = ref(false)
const remark = ref('')
const submitting = ref(false)

let searchTimer = null

const canSubmit = computed(() =>
  !!selected.value &&
  Number.isInteger(Number(quantity.value)) && Number(quantity.value) > 0 &&
  !!attachment.value &&
  !!remark.value.trim())

function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    const kw = keyword.value.trim()
    if (!kw) { searchList.value = []; searched.value = false; return }
    try {
      const res = await materialApi.list({ keyword: kw, page: 1, pageSize: 10 })
      searchList.value = res.list || []
      searched.value = true
    } catch (err) {
      searchList.value = []
    }
  }, 300)
}

function onPick(m) {
  selected.value = m
  searchList.value = []
  keyword.value = ''
  searched.value = false
}

function onUnpick() {
  selected.value = null
}

function choosePhoto() {
  uni.chooseImage({
    count: 1,
    success: async (res) => {
      const filePath = res.tempFilePaths && res.tempFilePaths[0]
      if (!filePath) return
      uploading.value = true
      try {
        attachment.value = await uploadFile(filePath, 'scrap')
      } catch (err) {
        uni.showToast({ title: err.message || '上传失败', icon: 'none' })
      } finally {
        uploading.value = false
      }
    }
  })
}

function previewPhoto() {
  uni.previewImage({ urls: [fullFileUrl(attachment.value)] })
}

async function onSubmit() {
  if (submitting.value) return
  if (!selected.value) { uni.showToast({ title: '请先选择物料', icon: 'none' }); return }
  const q = Number(quantity.value)
  if (!Number.isInteger(q) || q <= 0) { uni.showToast({ title: '报废数量要是正整数', icon: 'none' }); return }
  if (!attachment.value) { uni.showToast({ title: '请上传现场照片', icon: 'none' }); return }
  if (!remark.value.trim()) { uni.showToast({ title: '请填写报废原因', icon: 'none' }); return }

  submitting.value = true
  uni.showLoading({ title: '提交中...', mask: true })
  try {
    await outboundApi.submit({
      type: 'baofei',
      items: [{ material_id: selected.value._id, quantity: q }],
      remark: remark.value.trim(),
      attachment: attachment.value
    })
    uni.hideLoading()
    uni.showModal({
      title: '已提交',
      content: '报废申请已提交，仓管确认后库存才会扣减。',
      showCancel: false,
      confirmText: '知道了',
      success: () => uni.navigateBack()
    })
  } catch (err) {
    uni.hideLoading()
    uni.showToast({ title: err.message || '提交失败', icon: 'none', duration: 3000 })
  } finally {
    submitting.value = false
  }
}
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #f5f5f5;
  padding-bottom: 40rpx;
}

.intro-card {
  background: #fdecea;
  margin: 20rpx;
  border-radius: 16rpx;
  padding: 24rpx;

  .intro-title {
    font-size: 30rpx;
    font-weight: bold;
    color: #c0392b;
    display: block;
  }

  .intro-text {
    font-size: 24rpx;
    color: #8a4b42;
    margin-top: 8rpx;
    display: block;
    line-height: 1.6;
  }
}

.card {
  background: #fff;
  margin: 20rpx;
  border-radius: 16rpx;
  padding: 24rpx;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);

  .card-header {
    margin-bottom: 16rpx;
  }

  .section-title {
    font-size: 28rpx;
    font-weight: 600;
    color: #333;
  }
}

.req { color: #e74c3c; }

.search-box {
  .hit {
    padding: 18rpx 8rpx;
    border-bottom: 1rpx solid #f5f5f5;

    .hit-name { font-size: 28rpx; color: #333; display: block; }
    .hit-sub { font-size: 22rpx; color: #999; display: block; margin-top: 4rpx; }
  }

  .empty-hint {
    font-size: 24rpx;
    color: #999;
    padding: 20rpx 0;
    text-align: center;
  }
}

.selected-box {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f6f9f4;
  border-radius: 12rpx;
  padding: 20rpx;

  .selected-name { font-size: 28rpx; color: #333; font-weight: 500; display: block; }
  .selected-sub { font-size: 22rpx; color: #999; display: block; margin-top: 4rpx; }
}

.link { font-size: 24rpx; color: #0B4F95; }

.field {
  .field-label {
    font-size: 26rpx;
    color: #333;
    display: block;
    margin-bottom: 12rpx;
  }
}

.input {
  height: 80rpx;
  line-height: 80rpx;
  background: #f5f5f5;
  border-radius: 12rpx;
  padding: 0 24rpx;
  font-size: 28rpx;
  box-sizing: border-box;
}

.textarea {
  background: #f5f5f5;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  font-size: 28rpx;
  min-height: 140rpx;
  width: 100%;
  box-sizing: border-box;
}

.ph { color: #bbb; }

.upload-box {
  font-size: 26rpx;
  color: #c0392b;
  background: #fdecea;
  border-radius: 12rpx;
  padding: 30rpx;
  text-align: center;
}

.preview {
  width: 100%;
  height: 320rpx;
  margin-top: 16rpx;
  border-radius: 12rpx;
  background: #f5f5f5;
}

.action-bar {
  margin: 30rpx 20rpx;

  .btn-primary {
    background: #c0392b;
    color: #fff;
    border-radius: 12rpx;
    padding: 24rpx;
    font-size: 30rpx;
    width: 100%;

    &.disabled { opacity: 0.5; }
    &::after { border: none; }
  }
}
</style>
