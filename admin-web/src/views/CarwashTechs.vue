<template>
  <div class="narrow">
    <div class="toolbar">
      <span class="tip">技师在洗车小程序里接单、出发、开始、完成，到店收钱、给会员扣次卡。技师只看得到待接的单和派给自己的单的地址、电话。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openInvite">邀请技师</el-button>
    </div>
    <el-table :data="list" v-loading="loading" empty-text="还没有技师">
      <el-table-column label="称呼">
        <template #default="{ row }">{{ row.name }}<span class="muted" v-if="row.isMe">（我）</span></template>
      </el-table-column>
      <el-table-column label="角色" width="140" prop="roleName" />
      <el-table-column label="操作" width="100">
        <template #default="{ row }"><el-button v-if="canRemove(row)" link size="small" @click="remove(row)">移除</el-button></template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="inviteDialog" title="邀请技师" width="420px" @closed="invite = null">
      <template v-if="!invite">
        <el-radio-group v-model="role" class="roles">
          <el-radio value="technician">洗车技师（接单、到店收银）</el-radio>
          <el-radio value="carwash_manager" v-if="isOwner">洗车店长（管洗车的全部，看不到咖啡）</el-radio>
        </el-radio-group>
      </template>
      <template v-else>
        <div class="code">{{ invite.code }}</div>
        <div class="center muted">角色：{{ invite.roleName }} · 24 小时内有效，只能用一次</div>
        <div class="tip center">让技师打开洗车小程序，进入「我的」，点底部的「我是员工，用邀请码绑定」，输入这 6 位数字。</div>
      </template>
      <template #footer>
        <el-button v-if="!invite" type="primary" :loading="busy" @click="createInvite">生成邀请码</el-button>
        <el-button v-else @click="inviteDialog = false">好的</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, session } from '../api'

const list = ref([])
const loading = ref(false)
const inviteDialog = ref(false)
const role = ref('technician')
const invite = ref(null)
const busy = ref(false)

const isOwner = computed(() => session.staff && session.staff.role === 'owner')

function canRemove(row) {
  if (row.isMe || row.role === 'owner') return false
  return row.role === 'technician' || isOwner.value
}

async function load() {
  loading.value = true
  try {
    list.value = await api.carwash('listTechs')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function openInvite() {
  role.value = 'technician'
  inviteDialog.value = true
}

async function createInvite() {
  busy.value = true
  try {
    invite.value = await api.carwash('createTechInvite', { role: role.value })
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('移除「' + row.name + '」？移除后不能再接单、不能登录后台。已经派给这位技师的单要改派给别人。', '移除', { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.carwash('removeTech', { id: row.id })
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.roles { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.code {
  font-size: 40px;
  font-weight: 700;
  letter-spacing: 8px;
  text-align: center;
  color: var(--el-color-primary);
  margin: 8px 0;
}
.center { text-align: center; }
</style>
