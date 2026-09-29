<template>
  <div class="password-page">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="title">修改密码</span>
          <el-tag v-if="mustChange" type="danger" effect="dark">首次登录，请先修改初始密码</el-tag>
        </div>
      </template>

      <el-alert
        v-if="mustChange"
        type="warning"
        :closable="false"
        show-icon
        title="为了账号安全，请先把初始密码改成只有你自己知道的密码"
        description="未修改之前，系统会限制你使用其它功能。改完即可正常使用。"
        class="tip"
      />

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="110px"
        class="form"
      >
        <el-form-item label="当前密码" prop="old_password">
          <el-input
            v-model="form.old_password"
            type="password"
            show-password
            placeholder="请输入当前使用的密码"
          />
        </el-form-item>

        <el-form-item label="新密码" prop="new_password">
          <el-input
            v-model="form.new_password"
            type="password"
            show-password
            placeholder="至少 6 位，建议字母加数字"
          />
        </el-form-item>

        <el-form-item label="确认新密码" prop="confirm">
          <el-input
            v-model="form.confirm"
            type="password"
            show-password
            placeholder="再输入一次新密码"
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="submit">保存新密码</el-button>
          <el-button v-if="!mustChange" @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { authApi } from '@/api'
import { useUserStore } from '@/store/user'

const router = useRouter()
const userStore = useUserStore()

const formRef = ref(null)
const submitting = ref(false)
const form = ref({ old_password: '', new_password: '', confirm: '' })

const mustChange = computed(() => userStore.mustChangePassword)

const rules = {
  old_password: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  new_password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '新密码不能少于 6 位', trigger: 'blur' }
  ],
  confirm: [
    { required: true, message: '请再输入一次新密码', trigger: 'blur' },
    {
      validator: (rule, value, cb) => {
        if (value !== form.value.new_password) cb(new Error('两次输入的新密码不一致'))
        else cb()
      },
      trigger: 'blur'
    }
  ]
}

async function submit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  if (form.value.new_password === form.value.old_password) {
    ElMessage.warning('新密码不能和当前密码相同')
    return
  }

  submitting.value = true
  try {
    await authApi.changePassword({
      old_password: form.value.old_password,
      new_password: form.value.new_password
    })
    userStore.clearMustChange()
    reset()
    ElMessage.success('密码修改成功')
    router.replace('/dashboard')
  } catch (err) {
    ElMessage.error(err.message || '修改失败')
  } finally {
    submitting.value = false
  }
}

function reset() {
  form.value = { old_password: '', new_password: '', confirm: '' }
  if (formRef.value) formRef.value.clearValidate()
}
</script>

<style scoped>
.password-page {
  max-width: 640px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-header .title {
  font-size: 16px;
  font-weight: 600;
}

.tip {
  margin-bottom: 20px;
}

.form {
  padding-top: 4px;
}
</style>
