<template>
  <div>
    <div class="toolbar">
      <el-radio-group v-model="status" @change="reload">
        <el-radio-button v-for="t in tabs" :key="t.key" :value="t.key">
          {{ t.name }}<span v-if="counts[t.key]" class="count">{{ counts[t.key] }}</span>
        </el-radio-button>
      </el-radio-group>
      <el-date-picker v-if="status === 'returned' || status === 'cancelled'" v-model="day" type="date" value-format="YYYY-MM-DD" :clearable="false" @change="reload" style="width: 150px" />
      <span class="spacer"></span>
      <el-switch v-model="autoRefresh" active-text="自动刷新、新借书单响铃" />
    </div>

    <el-table :data="rentals" v-loading="loading" empty-text="暂时没有记录" row-key="_id">
      <el-table-column label="借书号" width="90">
        <template #default="{ row }"><span class="big-no">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column label="书" min-width="180">
        <template #default="{ row }">
          <div>《{{ row.bookTitle }}》</div>
          <div class="muted small" v-if="row.bookAuthor">{{ row.bookAuthor }}</div>
          <div class="gold small" v-if="row.remark">备注：{{ row.remark }}</div>
        </template>
      </el-table-column>
      <el-table-column label="计费" width="170">
        <template #default="{ row }">
          <div>{{ rentalBrief(row) }}</div>
          <div class="muted small" v-if="row.voucherCount">送了 {{ row.voucherCount }} 张赠饮券</div>
        </template>
      </el-table-column>
      <el-table-column label="租金" width="120">
        <template #default="{ row }">
          <div class="gold">¥{{ yuan(row.fee) }}</div>
          <el-tag size="small" :type="row.payStatus === 'paid' ? 'success' : row.payStatus === 'refunded' ? 'info' : 'danger'">
            {{ PAY[row.payStatus] }}{{ row.payStatus === 'paid' && row.payMethod === 'wechat' ? '（微信）' : '' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" min-width="200">
        <template #default="{ row }">
          <div class="small muted">下单 {{ time(row.createdAt) }}</div>
          <template v-if="row.status === 'reading'">
            <div v-if="row.ruleType === 'day'">包天，今天打烊前还</div>
            <div v-else :class="{ danger: row.overtimeNow && row.overtimeNow.fee }">
              {{ left(row.dueAtMs, now) }}（{{ clock(row.dueAtMs) }} 到期）
              <div v-if="row.overtimeNow && row.overtimeNow.fee">现在还书要补 ¥{{ yuan(row.overtimeNow.fee) }}</div>
            </div>
          </template>
          <div v-if="row.returnedAt" class="small muted">还书 {{ time(row.returnedAt) }}</div>
          <div v-if="row.overtimePayStatus === 'unpaid'" class="danger">超时 {{ minutes(row.overtimeMinutes) }}，待收 ¥{{ yuan(row.overtimeFee) }}</div>
          <div v-if="row.overtimePayStatus === 'paid'" class="ok small">超时费 ¥{{ yuan(row.overtimeFee) }} 已收</div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="230">
        <template #default="{ row }">
          <el-button v-if="row.status === 'pending' && row.payStatus === 'unpaid'" size="small" @click="act(row, 'markRentalPaid')">已收款</el-button>
          <el-button v-if="row.status === 'pending' && row.payStatus === 'paid'" size="small" type="primary" @click="act(row, 'handOut')">交书，开始计时</el-button>
          <el-button v-if="row.status === 'reading'" size="small" type="primary" @click="act(row, 'returnBook')">还书</el-button>
          <el-button v-if="row.overtimePayStatus === 'unpaid'" size="small" @click="act(row, 'markOvertimePaid')">超时费已收</el-button>
          <el-button v-if="row.status === 'pending' || row.status === 'reading'" size="small" link @click="act(row, 'adminCancelRental')">取消</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan, time, clock, left, minutes, cnDay, rentalBrief } from '../format'

const tabs = [
  { key: 'pending', name: '待取书' },
  { key: 'reading', name: '在读' },
  { key: 'returned', name: '已归还' },
  { key: 'cancelled', name: '已取消' }
]
const PAY = { unpaid: '未收款', paid: '已收款', refunded: '已退款' }

const status = ref('pending')
const day = ref(cnDay())
const rentals = ref([])
const counts = ref({})
const now = ref(Date.now())
const loading = ref(false)
const autoRefresh = ref(true)
const audio = new Audio('./new-order.wav')
let known = null
let timer = null
let busy = false

async function load(silent) {
  if (busy) return
  busy = true
  if (!silent) loading.value = true
  const st = status.value
  try {
    const res = await api.book('listRentals', { status: st, day: day.value })
    checkNew(res.pendingIds)
    if (st === status.value) {
      rentals.value = res.rentals
      counts.value = res.counts
      now.value = res.serverNow
    }
  } catch (e) {
    if (!silent) ElMessage.error(e.message)
  } finally {
    busy = false
    loading.value = false
  }
}

function checkNew(ids) {
  if (known) {
    const fresh = ids.filter((id) => !known[id])
    if (fresh.length) {
      audio.currentTime = 0
      audio.play().catch(() => {})
      ElMessage.success('来了 ' + fresh.length + ' 个借书单')
    }
  }
  known = known || {}
  ids.forEach((id) => { known[id] = true })
}

function reload() {
  rentals.value = []
  load()
}

function cancelPayText(r) {
  if (r.payStatus !== 'paid' || !r.fee) return '。'
  if (r.payMethod === 'wechat') return '，租金 ¥' + yuan(r.fee) + ' 会原路退回顾客的微信。'
  return '，这单已收款 ¥' + yuan(r.fee) + '，记得退给顾客。'
}

const CONFIRM = {
  handOut: (r) => ['把《' + r.bookTitle + '》交给 ' + r.code + ' 号顾客，' + (r.ruleType === 'hourly' ? '现在开始计时 ' + r.hours + ' 小时。' : '今天打烊前还。'), '交书'],
  returnBook: (r) => ['确认《' + r.bookTitle + '》已经还回来了？', '还书'],
  adminCancelRental: (r) => [(r.status === 'reading' ? '确认书已经拿回来了。' : '') + '取消后书会放回书架' + cancelPayText(r), '取消借阅']
}

async function act(row, action) {
  if (CONFIRM[action]) {
    const [text, title] = CONFIRM[action](row)
    try {
      await ElMessageBox.confirm(text, title, { confirmButtonText: '确定', cancelButtonText: '再想想' })
    } catch (e) {
      return
    }
  }
  try {
    const res = await api.book(action, { id: row._id })
    if (action === 'markRentalPaid' && res.voucherCount) ElMessage.success('已收款，送了 ' + res.voucherCount + ' 张赠饮券')
    if (action === 'adminCancelRental' && res.refunded) ElMessage.success('已取消，租金原路退回顾客微信')
    if (action === 'returnBook' && res.overtimeFee) {
      ElMessageBox.alert('超时 ' + res.overtimeMinutes + ' 分钟，按 ' + res.overtimeHours + ' 小时算，要补 ¥' + yuan(res.overtimeFee) + '。收到后在「已归还」里点「超时费已收」。', '要收超时费')
    }
  } catch (e) {
    ElMessage.error(e.message)
  }
  load(true)
}

function startTimer() {
  stopTimer()
  if (autoRefresh.value) timer = setInterval(() => load(true), 15000)
}
function stopTimer() {
  if (timer) clearInterval(timer)
  timer = null
}

watch(autoRefresh, startTimer)
onMounted(() => {
  load()
  startTimer()
})
onBeforeUnmount(stopTimer)
</script>

<style scoped>
.count {
  margin-left: 4px;
  font-size: 12px;
}
.small { font-size: 12px; }
</style>
