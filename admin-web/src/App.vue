<template>
  <router-view v-if="route.meta.public" />
  <el-container v-else class="layout">
    <el-aside width="200px" class="aside">
      <div class="brand">
        <img :src="logo" alt="" />
        <div>
          <div class="brand-name">{{ shopName }}</div>
          <div class="brand-sub">管理后台</div>
        </div>
      </div>
      <el-menu :default-active="route.path" router class="menu">
        <template v-for="g in visibleMenu" :key="g.group">
          <div v-if="g.group" class="menu-group">{{ g.group }}</div>
          <el-menu-item v-for="item in g.items" :key="item.path" :index="item.path">{{ item.title }}</el-menu-item>
        </template>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="title">{{ route.meta.title }}</span>
        <el-tag v-if="isMock" type="warning" size="small" class="preview">预览 · 假数据，重新运行预览会重置</el-tag>
        <span class="spacer"></span>
        <template v-if="session.staff">
          <span>{{ session.staff.name }}</span>
          <el-tag size="small" class="role">{{ session.staff.roleName }}</el-tag>
          <el-button link @click="logout">退出</el-button>
        </template>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, session, setToken, config, isMock } from './api'
import { MENU, allowed } from './router'
import logo from './assets/logo.jpg'

const route = useRoute()
const router = useRouter()
const shopName = config().shopName || '进山咖啡'

const visibleMenu = computed(() => MENU
  .map((g) => ({ group: g.group, items: g.items.filter(allowed) }))
  .filter((g) => g.items.length))

async function logout() {
  try {
    await api.common('webLogout', { webToken: session.token })
  } catch (e) {
    // 退出失败也清掉本地登录
  }
  setToken('')
  session.staff = null
  router.replace('/login')
}
</script>

<style scoped>
.layout { height: 100%; }
.aside {
  background: #101010;
  border-right: 1px solid var(--el-border-color);
  display: flex;
  flex-direction: column;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--el-border-color);
}
.brand img {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  object-fit: cover;
}
.brand-name {
  color: var(--el-color-primary);
  font-weight: 600;
  font-size: 16px;
}
.brand-sub {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.menu {
  border-right: none;
  background: transparent;
  flex: 1;
}
.menu-group {
  padding: 16px 20px 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}
.header .title {
  font-size: 18px;
  font-weight: 600;
}
.header .spacer { flex: 1; }
.header .preview { margin-left: 12px; }
.main { background: var(--el-bg-color-page); }

/* 手机和窄屏：菜单放到顶上横着滑 */
@media (max-width: 760px) {
  .layout { flex-direction: column; height: auto; min-height: 100%; }
  .aside { width: auto !important; border-right: none; border-bottom: 1px solid var(--el-border-color); }
  .brand { padding: 10px 16px; border-bottom: none; }
  .brand img { width: 32px; height: 32px; }
  .menu { display: flex; overflow-x: auto; padding: 0 8px; }
  .menu-group { display: none; }
  .menu :deep(.el-menu-item) { height: 40px; line-height: 40px; padding: 0 12px !important; white-space: nowrap; }
  .header { flex-wrap: wrap; height: auto; padding: 10px max(16px, env(safe-area-inset-right, 0px)) 10px max(16px, env(safe-area-inset-left, 0px)); }
  .header .preview { margin-left: 0; order: 10; }
  .main { padding: 16px max(16px, env(safe-area-inset-right, 0px)) 16px max(16px, env(safe-area-inset-left, 0px)); }
}
</style>
