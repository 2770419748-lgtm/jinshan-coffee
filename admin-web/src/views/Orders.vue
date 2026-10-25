<template>
  <div>
    <div class="toolbar">
      <el-radio-group v-model="status" @change="reload">
        <el-radio-button v-for="t in tabs" :key="t.key" :value="t.key">
          {{ t.name }}<span v-if="counts[t.key]" class="count">{{ counts[t.key] }}</span>
        </el-radio-button>
      </el-radio-group>
      <el-date-picker v-model="day" type="date" value-format="YYYY-MM-DD" :clearable="false" @change="reload" style="width: 150px" />
      <span class="spacer"></span>
      <el-switch v-model="autoRefresh" active-text="自动刷新、新单响铃" />
    </div>

    <el-table :data="orders" v-loading="loading" empty-text="暂时没有订单" row-key="_id">
      <el-table-column label="取餐号" width="110">
        <template #default="{ row }">
          <span class="big-no">{{ row.pickupNo }}</span>
          <div v-if="row.reserveAt"><el-tag size="small" type="warning" effect="dark">预约 {{ clock(row.reserveAt) }}</el-tag></div>
        </template>
      </el-table-column>
      <el-table-column label="桌号" width="90">
        <template #default="{ row }">
          <el-tag v-if="row.tableNo" size="small">{{ row.tableNo }} 号桌</el-tag>
          <el-tag v-else size="small" type="info">{{ MODE[row.mode] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="商品" min-width="240">
        <template #default="{ row }">
          <div v-for="(line, i) in row.items" :key="i">
            {{ line.name }}<span class="muted" v-if="line.specs.length">（{{ specText(line.specs) }}）</span> × <b>{{ line.qty }}</b>
          </div>
          <div v-if="row.remark" class="gold">备注：{{ row.remark }}</div>
        </template>
      </el-table-column>
      <el-table-column label="金额" width="140">
        <template #default="{ row }">
          <div class="gold">¥{{ yuan(row.payFee) }}</div>
          <div v-if="row.discountFee - (row.couponFee || 0)" class="muted small">赠饮券 -¥{{ yuan(row.discountFee - (row.couponFee || 0)) }}</div>
          <div v-if="row.couponFee" class="muted small">代金券 -¥{{ yuan(row.couponFee) }}</div>
          <el-tag size="small" :type="row.payStatus === 'paid' ? 'success' : row.payStatus === 'refunded' ? 'info' : 'danger'">
            {{ PAY[row.payStatus] }}{{ METHOD[row.payMethod] && row.payStatus !== 'unpaid' ? '（' + METHOD[row.payMethod] + '）' : '' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="下单时间" width="100">
        <template #default="{ row }">{{ clock(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="260">
        <template #default="{ row }">
          <el-button v-if="row.payStatus === 'unpaid' && row.status !== 'cancelled'" size="small" @click="act(row, 'paid')">已收款</el-button>
          <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="act(row, 'making')">开始制作</el-button>
          <el-button v-if="row.status === 'making'" size="small" type="primary" @click="act(row, 'done')">制作完成</el-button>
          <el-button v-if="row.status === 'pending' || row.status === 'making'" size="small" link @click="act(row, 'cancelled')">取消</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan, clock, cnDay, specText, MODE } from '../format'

const tabs = [
  { key: 'pending', name: '待制作' },
  { key: 'making', name: '制作中' },
  { key: 'done', name: '已完成' },
  { key: 'cancelled', name: '已取消' }
]
const PAY = { unpaid: '未收款', paid: '已收款', refunded: '已退款' }
const METHOD = { wechat: '微信', balance: '余额', member: '会员免费' }

const status = ref('pending')
const day = ref(cnDay())
const orders = ref([])
const counts = ref({})
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
    const res = await api.coffee('listOrders', { status: st, day: day.value })
    checkNew(res.pendingIds, res.day)
    if (st === status.value) {
      orders.value = res.orders
      counts.value = res.counts
    }
  } catch (e) {
    if (!silent) ElMessage.error(e.message)
  } finally {
    busy = false
    loading.value = false
  }
}

// 只看今天的新单
function checkNew(ids, d) {
  if (d !== cnDay()) return
  if (known) {
    const fresh = ids.filter((id) => !known[id])
    if (fresh.length) {
      audio.currentTime = 0
      audio.play().catch(() => {})
      ElMessage.success('来了 ' + fresh.length + ' 个新订单')
    }
  }
  known = known || {}
  ids.forEach((id) => { known[id] = true })
}

function reload() {
  orders.value = []
  load()
}

function cancelText(row) {
  if (row.payStatus !== 'paid') return '确定取消这单？'
  if (row.payMethod === 'wechat') return '这单是微信支付的，取消后钱会原路退回顾客的微信。'
  if (row.payMethod === 'voucher') return '这单用券抵扣，取消后券会退回给顾客。'
  if (row.payMethod === 'balance') return '这单是会员余额付的，取消后钱会退回顾客的余额。'
  return '这单已在吧台收款，取消后请记得退款给顾客。'
}

async function act(row, op) {
  if (op === 'cancelled') {
    try {
      await ElMessageBox.confirm(cancelText(row), '取消订单', { confirmButtonText: '取消订单', cancelButtonText: '不取消', type: 'warning' })
    } catch (e) {
      return
    }
  }
  try {
    if (op === 'paid') await api.coffee('markPaid', { id: row._id })
    else await api.coffee('setOrderStatus', { id: row._id, status: op })
  } catch (e) {
    ElMessage.error(e.message)
  }
  load(true)
}

function startTimer() {
  stopTimer()
  if (autoRefresh.value) timer = setInterval(() => load(true), 8000)
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
