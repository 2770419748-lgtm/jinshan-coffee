<template>
  <div class="narrow">
    <div class="toolbar">
      <span class="tip">咖啡师只能进咖啡后台，书籍管理员只能进书籍后台。员工先要在小程序里用邀请码绑定，才能设网页账号。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="inviteDialog = true">邀请员工</el-button>
    </div>
    <el-table :data="list" v-loading="loading">
      <el-table-column label="称呼">
        <template #default="{ row }">{{ row.name }}<span class="muted" v-if="row.isMe">（我）</span></template>
      </el-table-column>
      <el-table-column label="角色" width="220">
        <template #default="{ row }">
          <el-select :model-value="row.role" size="small" @change="(v) => changeRole(row, v)">
            <el-option v-for="r in ROLE_OPTIONS" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="网页后台账号" width="180">
        <template #default="{ row }">
          <template v-if="row.webUsername">{{ row.webUsername }} <el-button link size="small" @click="clearWeb(row)">停用</el-button></template>
          <span v-else class="muted">没开通</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }"><el-button v-if="!row.isMe" link size="small" @click="remove(row)">移除</el-button></template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="inviteDialog" title="邀请员工" width="420px" @closed="invite = null">
      <template v-if="!invite">
        <el-radio-group v-model="role" class="roles">
          <el-radio v-for="r in ROLE_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</el-radio>
        </el-radio-group>
      </template>
      <template v-else>
        <div class="code">{{ invite.code }}</div>
        <div class="center muted">角色：{{ invite.roleName }} · 24 小时内有效，只能用一次</div>
        <div class="tip center">让员工打开小程序，进入「我的」，点底部的「我是店员，用邀请码绑定」，输入这 6 位数字。</div>
      </template>
      <template #footer>
        <el-button v-if="!invite" type="primary" @click="createInvite">生成邀请码</el-button>
        <el-button v-else @click="inviteDialog = false">好的</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { ROLE_OPTIONS } from '../format'

const list = ref([])
const loading = ref(false)
const inviteDialog = ref(false)
const role = ref('barista')
const invite = ref(null)

async function load() {
  loading.value = true
  try {
    list.value = await api.common('listStaff')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function run(fn) {
  try {
    await fn()
  } catch (e) {
    ElMessage.error(e.message)
  }
  load()
}

function changeRole(row, value) {
  run(() => api.common('updateStaff', { id: row.id, role: value }))
}

async function confirm(text, title) {
  try {
    await ElMessageBox.confirm(text, title, { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' })
    return true
  } catch (e) {
    return false
  }
}

async function clearWeb(row) {
  if (await confirm('「' + row.name + '」在电脑上会马上退出登录。', '停用网页后台')) run(() => api.common('clearWebAccount', { id: row.id }))
}

async function remove(row) {
  if (await confirm('移除后「' + row.name + '」就进不了后台了。', '移除员工')) run(() => api.common('removeStaff', { id: row.id }))
}

async function createInvite() {
  try {
    invite.value = await api.common('createInvite', { role: role.value })
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.narrow { max-width: 900px; }
.roles {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.code {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: 10px;
  text-align: center;
  color: var(--el-color-primary);
  margin: 8px 0;
}
.center { text-align: center; }
</style>
