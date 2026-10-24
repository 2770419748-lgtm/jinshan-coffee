<template>
  <div class="login">
    <div class="box">
      <img class="logo" :src="logo" alt="进山咖啡" />
      <div class="title">管理后台</div>
      <el-alert v-if="notice" :title="notice" type="warning" :closable="false" show-icon class="notice" />
      <el-form @submit.prevent="submit" label-position="top">
        <el-form-item label="账号">
          <el-input v-model="username" autocomplete="username" placeholder="在小程序里设置的账号" size="large" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="password" type="password" autocomplete="current-password" show-password size="large" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" size="large" class="submit" :loading="loading" native-type="submit">登录</el-button>
      </el-form>
      <div class="tip help">还没有账号？店主和员工在小程序里打开「我的 → 管理后台 → 电脑网页后台」设置账号和密码。</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, session, setToken } from '../api'
import { firstPage } from '../router'
import logo from '../assets/logo.jpg'

const route = useRoute()
const router = useRouter()
const username = ref('')
const password = ref('')
const loading = ref(false)

const notice = computed(() => {
  if (route.query.error) return String(route.query.error)
  if (route.query.expired) return '登录已过期，请重新登录'
  return ''
})

async function submit() {
  if (loading.value) return
  if (!username.value.trim() || !password.value) {
    ElMessage.warning('请填写账号和密码')
    return
  }
  loading.value = true
  try {
    const res = await api.common('webLogin', { username: username.value, password: password.value })
    setToken(res.token)
    session.staff = res.staff
    const next = typeof route.query.next === 'string' && route.query.next !== '/login' ? route.query.next : firstPage()
    router.replace(next)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 50% 20%, #221d13, #0b0b0b 60%);
}
.box {
  width: 360px;
  padding: 32px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 16px;
}
.logo {
  display: block;
  width: 160px;
  height: 160px;
  margin: 0 auto;
  object-fit: cover;
}
.title {
  text-align: center;
  color: var(--el-color-primary);
  letter-spacing: 6px;
  margin: 4px 0 20px;
}
.notice { margin-bottom: 16px; }
.submit { width: 100%; margin-top: 8px; }
.help { margin-top: 16px; }
</style>
