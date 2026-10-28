<template>
  <div>
    <div class="cal" v-loading="calLoading">
      <div v-for="d in calendar" :key="d.day" class="day" :class="{ active: d.day === day }" @click="pick(d.day)">
        <div class="d-label">{{ dayLabel(d.day) }}</div>
        <div class="d-count">{{ d.store + d.door }} 单</div>
        <div class="d-sub" v-if="d.capacity.store">到店 {{ d.store }}/{{ d.capacity.store }}</div>
        <div class="d-sub" v-if="d.capacity.door">上门 {{ d.door }}/{{ d.capacity.door }}</div>
        <div class="d-pending" v-if="d.pending">{{ d.pending }} 单待接</div>
      </div>
    </div>

    <div class="toolbar">
      <el-date-picker v-model="day" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width: 150px" @change="pick" />
      <el-radio-group v-model="status" size="small" @change="loadOrders">
        <el-radio-button value="">全部 {{ total }}</el-radio-button>
        <el-radio-button v-for="(t, k) in CW_STATUS" :key="k" :value="k">{{ t }} {{ counts[k] || 0 }}</el-radio-button>
      </el-radio-group>
      <span class="spacer"></span>
      <el-button @click="refresh" :loading="loading">刷新</el-button>
    </div>

    <el-table :data="orders" v-loading="loading" row-key="_id" empty-text="这天还没有预约">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="detail">
            <div>单号 {{ row.orderNo }} · 下单 {{ time(row.createdAt) }}<span v-if="row.memberNo"> · 会员号 {{ row.memberNo }}</span></div>
            <div v-if="row.remark">备注：{{ row.remark }}</div>
            <div>
              项目价 ¥{{ yuan(row.servicePrice) }}<span v-if="row.memberPriced">（会员价 ¥{{ yuan(row.unitPrice) }}）</span>
              <span v-if="row.mode === 'door'"> · 距离 {{ row.distanceKm }} 公里 · 上门费 ¥{{ yuan(row.doorFee) }}<span v-if="row.extraFee">，超出范围加 ¥{{ yuan(row.extraFee) }}</span></span>
              <span v-if="row.cardId"> · 次卡「{{ row.cardName }}」抵 ¥{{ yuan(row.cardCover) }}</span>
            </div>
            <div v-if="row.status === 'cancelled'" class="muted">
              取消原因：{{ row.cancelReason || '无' }}<span v-if="row.cancelledByName">（{{ row.cancelledByName }}）</span>
              <span v-if="row.cancelFee"> · 扣 ¥{{ yuan(row.cancelFee) }}</span>
              <span v-if="row.refundFee"> · 退回 ¥{{ yuan(row.refundFee) }}{{ row.refundStatus === 'offline' ? '（到店付的钱，要线下退给顾客）' : '' }}</span>
            </div>
            <div class="muted" v-if="row.finishedAt">完成确认：{{ row.finishedBy === 'auto' ? '到时间自动确认' : '顾客确认' }} {{ time(row.finishedAt) }}</div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="时段" width="110">
        <template #default="{ row }"><b>{{ clock(row.slotStart) }}</b><span class="muted">-{{ clock(row.slotEnd) }}</span></template>
      </el-table-column>
      <el-table-column label="项目" min-width="130">
        <template #default="{ row }">
          <div>{{ row.serviceName }}</div>
          <el-tag size="small" :type="row.mode === 'door' ? 'warning' : 'info'">{{ row.modeText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="顾客和车" min-width="170">
        <template #default="{ row }">
          <div>{{ row.contactName || '顾客' }} <span class="muted">{{ row.contactPhone }}</span></div>
          <div class="small"><b v-if="row.plate">{{ row.plate }}</b> <span class="muted">{{ row.carModel }}</span></div>
          <div class="small muted" v-if="row.address">{{ row.address.place }} {{ row.address.detail }}</div>
        </template>
      </el-table-column>
      <el-table-column label="金额" width="150">
        <template #default="{ row }">
          <div class="gold">¥{{ yuan(row.payFee) }}<span v-if="row.cardId" class="muted small">（次卡）</span></div>
          <div class="small" :class="row.payStatus === 'unpaid' && row.status !== 'cancelled' ? 'danger' : 'muted'">{{ payText(row) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="技师" width="100">
        <template #default="{ row }">{{ row.techName || '' }}<span v-if="!row.techName" class="muted">没派</span></template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }"><el-tag size="small" :type="CW_STATUS_TAG[row.status]">{{ row.statusText }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <div class="ops">
            <el-button v-if="row.status === 'pending' || row.status === 'confirmed'" size="small" @click="openAssign(row)">{{ row.techId ? '改派' : '派单' }}</el-button>
            <el-button v-for="n in nextSteps(row)" :key="n.status" size="small" type="primary" plain @click="advance(row, n)">{{ n.label }}</el-button>
            <el-button v-if="row.payStatus === 'unpaid' && row.status !== 'cancelled'" size="small" @click="collect(row)">收款</el-button>
            <el-button v-if="OPEN.indexOf(row.status) !== -1" size="small" link @click="cancel(row)">取消</el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
    <div class="tip">在线付款的单付完才会出现在这里。技师在洗车小程序里接单；店长也可以在这里派单、推进、收款。取消会把钱和次卡全退给顾客（到店付的钱要线下退）。</div>

    <el-dialog v-model="assignDialog" title="派给哪位技师" width="400px">
      <el-radio-group v-model="techId" class="techs">
        <el-radio v-for="t in techs" :key="t.id" :value="t.id">{{ t.name }} <span class="muted small">{{ t.roleName }}</span></el-radio>
      </el-radio-group>
      <div v-if="!techs.length" class="tip">还没有技师，先到「技师管理」生成邀请码。</div>
      <template #footer>
        <el-button @click="assignDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!techId" :loading="busy" @click="assign">派单</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan, time, clock, cnDay, addDays, CW_STATUS, CW_STATUS_TAG, CW_PAY } from '../format'

const OPEN = ['pending', 'confirmed', 'departed', 'serving', 'done']
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const today = cnDay()

const day = ref(today)
const status = ref('')
const orders = ref([])
const counts = ref({})
const calendar = ref([])
const loading = ref(false)
const calLoading = ref(false)
const techs = ref([])
const assignDialog = ref(false)
const techId = ref('')
const busy = ref(false)
let target = null
let timer = null

const total = computed(() => Object.keys(counts.value).reduce((s, k) => s + counts.value[k], 0))

function dayLabel(d) {
  if (d === today) return '今天'
  if (d === addDays(today, 1)) return '明天'
  return d.slice(5) + ' 周' + WEEK[new Date(d + 'T00:00:00Z').getUTCDay()]
}

function payText(o) {
  if (o.payStatus === 'refunded') return '已退款'
  if (o.payStatus === 'paid') {
    if (!o.payFee) return '次卡全抵'
    return (CW_PAY[o.payMethod] || '已付') + (o.refundFee ? ' · 退 ¥' + yuan(o.refundFee) : '')
  }
  if (o.status === 'cancelled') return '没付'
  return '到店付，还没收'
}

function nextSteps(o) {
  if (o.status === 'confirmed') return o.mode === 'door' ? [{ status: 'departed', label: '出发' }] : [{ status: 'serving', label: '开始' }]
  if (o.status === 'departed') return [{ status: 'serving', label: '开始' }]
  if (o.status === 'serving') return [{ status: 'done', label: '完成' }]
  return []
}

async function loadOrders() {
  loading.value = true
  try {
    const res = await api.carwash('adminOrders', { day: day.value, status: status.value })
    orders.value = res.orders
    counts.value = res.counts
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function loadCalendar() {
  calLoading.value = true
  try {
    // 日历从今天开始排 14 天；选的日子不在里面时从那天开始
    const from = day.value < today || day.value > addDays(today, 13) ? day.value : today
    calendar.value = (await api.carwash('calendar', { from, days: 14 })).days
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    calLoading.value = false
  }
}

function refresh() {
  loadOrders()
  loadCalendar()
}

function pick(d) {
  day.value = d
  status.value = ''
  refresh()
}

async function openAssign(row) {
  target = row
  techId.value = row.techId || ''
  try {
    techs.value = await api.carwash('listTechs')
  } catch (e) {
    return ElMessage.error(e.message)
  }
  assignDialog.value = true
}

async function assign() {
  busy.value = true
  try {
    await api.carwash('assignOrder', { id: target._id, techId: techId.value })
    ElMessage.success('已派单')
    assignDialog.value = false
    refresh()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}

async function advance(row, n) {
  try {
    await api.carwash('advanceOrder', { id: row._id, status: n.status })
    refresh()
  } catch (e) {
    ElMessage.error(e.message)
    refresh()
  }
}

async function collect(row) {
  try {
    await ElMessageBox.confirm('已经收到顾客 ¥' + yuan(row.payFee) + '（现金或收款码）？', '登记收款', { confirmButtonText: '已收到', cancelButtonText: '还没有' })
  } catch (e) {
    return
  }
  try {
    await api.carwash('collectPay', { id: row._id })
    ElMessage.success('已登记')
    refresh()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function cancel(row) {
  let reason
  try {
    const res = await ElMessageBox.prompt('取消 ' + clock(row.slotStart) + ' ' + row.serviceName + '？付过的钱和次卡全退给顾客。', '取消预约', {
      confirmButtonText: '确认取消',
      cancelButtonText: '不取消',
      inputPlaceholder: '原因，比如：顾客电话说不来了、下雨',
      inputValidator: (v) => (String(v || '').trim() ? true : '请写上原因')
    })
    reason = res.value.trim()
  } catch (e) {
    return
  }
  try {
    await api.carwash('staffCancelOrder', { id: row._id, reason })
    ElMessage.success(row.payStatus === 'paid' && row.payMethod === 'counter' ? '已取消，到店收的钱记得线下退给顾客' : '已取消')
    refresh()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(() => {
  refresh()
  timer = setInterval(() => {
    if (!document.hidden && !assignDialog.value) refresh()
  }, 60000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.cal {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 8px;
  margin-bottom: 12px;
}
.day {
  flex: 0 0 104px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  padding: 8px 10px;
  background: var(--el-bg-color);
  cursor: pointer;
}
.day.active { border-color: var(--el-color-primary); }
.d-label { font-size: 13px; color: var(--el-text-color-secondary); }
.d-count { font-size: 18px; font-weight: 600; margin: 2px 0; }
.d-sub { font-size: 12px; color: var(--el-text-color-secondary); }
.d-pending { font-size: 12px; color: var(--el-color-warning); margin-top: 2px; }
.small { font-size: 12px; }
.ops { display: flex; flex-wrap: wrap; gap: 6px; }
.ops .el-button + .el-button { margin-left: 0; }
.detail { padding: 4px 16px; line-height: 1.9; font-size: 13px; }
.techs { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.tip { margin-top: 12px; }
</style>
