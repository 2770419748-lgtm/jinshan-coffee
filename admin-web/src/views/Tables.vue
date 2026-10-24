<template>
  <div>
    <div class="toolbar">
      <el-input v-model="tableNo" placeholder="桌号，比如 1、A3" maxlength="8" style="width: 200px" @keyup.enter="add" />
      <el-button type="primary" @click="add">添加桌号</el-button>
      <span class="spacer"></span>
      <el-checkbox v-model="trial">生成体验版桌码（小程序发布前测试用）</el-checkbox>
    </div>

    <div class="grid" v-loading="loading">
      <div v-for="t in tables" :key="t._id" class="table-card">
        <div class="no">{{ t.tableNo }} 号桌</div>
        <div class="code">
          <CloudImage v-if="t.qrcode" :src="t.qrcode" fit="contain" />
          <div v-else class="muted none">还没生成桌码</div>
        </div>
        <div class="muted small" v-if="t.qrcode">{{ t.qrcodeEnv === 'trial' ? '体验版桌码' : '正式版桌码' }}</div>
        <div class="ops">
          <el-button size="small" type="primary" :loading="busy === t._id" @click="gen(t)">{{ t.qrcode ? '重新生成' : '生成桌码' }}</el-button>
          <el-button size="small" v-if="t.qrcode" @click="download(t)">下载</el-button>
          <el-button size="small" link @click="remove(t)">删除</el-button>
        </div>
      </div>
    </div>
    <el-empty v-if="!loading && !tables.length" description="还没有桌号" />
    <div class="tip">正式版桌码要等小程序发布上线后才能扫开。下载后打印出来贴在桌上，顾客扫码点单会自动带上桌号。</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, tempUrl } from '../api'
import CloudImage from '../components/CloudImage.vue'

const tables = ref([])
const tableNo = ref('')
const trial = ref(false)
const loading = ref(false)
const busy = ref('')

async function load() {
  loading.value = true
  try {
    tables.value = await api.coffee('listTables')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function add() {
  if (!tableNo.value.trim()) return
  try {
    await api.coffee('saveTable', { tableNo: tableNo.value })
    tableNo.value = ''
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function gen(t) {
  busy.value = t._id
  try {
    await api.coffee('genTableCode', { id: t._id, envVersion: trial.value ? 'trial' : 'release' })
    ElMessage.success(t.tableNo + ' 号桌的桌码生成好了')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = ''
  }
}

async function download(t) {
  const url = await tempUrl(t.qrcode)
  if (url) window.open(url, '_blank')
}

async function remove(t) {
  try {
    await ElMessageBox.confirm('删除 ' + t.tableNo + ' 号桌？已经贴出去的桌码扫了会提示失效。', '删除桌号', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.coffee('deleteTable', { id: t._id })
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  min-height: 80px;
}
.table-card {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  padding: 14px;
  text-align: center;
}
.no {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-color-primary);
}
.code {
  width: 140px;
  height: 140px;
  margin: 10px auto 4px;
}
.none {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  font-size: 13px;
}
.small { font-size: 12px; }
.ops { margin-top: 8px; }
.tip { margin-top: 16px; }
</style>
