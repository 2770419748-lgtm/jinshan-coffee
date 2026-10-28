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
      <el-button @click="printDialog = true">小票打印<el-tag v-if="print.auto" size="small" type="success" effect="dark" class="print-on">自动</el-tag></el-button>
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
          <div v-if="row.discountFee - (row.couponFee || 0) - (row.starFee || 0)" class="muted small">赠饮券 -¥{{ yuan(row.discountFee - (row.couponFee || 0) - (row.starFee || 0)) }}</div>
          <div v-if="row.starRedeem" class="gold small">集星换{{ row.starRedeem.name }} -¥{{ yuan(row.starFee) }}</div>
          <div v-if="row.couponFee" class="muted small">代金券 -¥{{ yuan(row.couponFee) }}</div>
          <el-tag size="small" :type="row.payStatus === 'paid' ? 'success' : row.payStatus === 'refunded' ? 'info' : 'danger'">
            {{ PAY[row.payStatus] }}{{ METHOD[row.payMethod] && row.payStatus !== 'unpaid' ? '（' + METHOD[row.payMethod] + '）' : '' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="下单时间" width="100">
        <template #default="{ row }">{{ clock(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="300">
        <template #default="{ row }">
          <el-button size="small" link @click="printOne(row)">打印</el-button>
          <el-button v-if="row.payStatus === 'unpaid' && row.status !== 'cancelled'" size="small" @click="act(row, 'paid')">已收款</el-button>
          <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="act(row, 'making')">开始制作</el-button>
          <el-button v-if="row.status === 'making'" size="small" type="primary" @click="act(row, 'done')">制作完成</el-button>
          <el-button v-if="row.status === 'pending' || row.status === 'making'" size="small" link @click="act(row, 'cancelled')">取消</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="printDialog" title="小票打印（这台电脑）" width="480px">
      <el-form label-width="110px">
        <el-form-item label="自动打印新单">
          <el-switch v-model="print.auto" />
          <span class="muted small sep">{{ print.auto ? '来新单自动打一张' : '没打开，可以在订单后面点「打印」' }}</span>
        </el-form-item>
        <el-form-item label="小票纸宽">
          <el-radio-group v-model="print.width">
            <el-radio-button :value="58">58mm</el-radio-button>
            <el-radio-button :value="80">80mm</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="每单打几张">
          <el-radio-group v-model="print.copies">
            <el-radio-button :value="1">1 张</el-radio-button>
            <el-radio-button :value="2">2 张（一张给顾客）</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item>
          <el-button @click="testPrint">打一张试试</el-button>
        </el-form-item>
      </el-form>
      <div class="tip">
        只在收银电脑上打开自动打印，别的电脑开着这个页面不会重复打。自动打印要一直开着这个页面和上面的「自动刷新」。<br>
        不想每次弹出打印框：把小票机设成 Windows 的默认打印机，再用加了 <code>--kiosk-printing</code> 的浏览器快捷方式打开后台，具体步骤见说明文档「收银电脑打小票」。
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan, clock, cnDay, specText, MODE } from '../format'
import { loadPrintSettings, savePrintSettings, printOrders } from '../receipt'

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
const print = ref(loadPrintSettings())
const printDialog = ref(false)
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
      if (print.value.auto) autoPrint(fresh)
    }
  }
  known = known || {}
  ids.forEach((id) => { known[id] = true })
}

async function autoPrint(ids) {
  try {
    printOrders(await api.coffee('ordersForPrint', { ids }), print.value)
  } catch (e) {
    ElMessage.error('自动打印没取到订单：' + e.message)
  }
}

function printOne(row) {
  printOrders([row], print.value)
}

function testPrint() {
  printOrders([{
    pickupNo: '001',
    mode: 'dine_in',
    tableNo: '5',
    createdAt: new Date().toISOString(),
    items: [
      { name: '拿铁', specs: [{ option: '大杯' }, { option: '燕麦奶' }], qty: 2, subtotal: 6400 },
      { name: '芝士蛋糕', specs: [], qty: 1, subtotal: 2800 }
    ],
    remark: '这是一张测试小票',
    totalFee: 9200,
    discountFee: 0,
    couponFee: 0,
    payFee: 9200,
    payStatus: 'paid',
    payMethod: 'counter',
    orderNo: 'TEST'
  }], print.value)
}

function reload() {
  orders.value = []
  load()
}

function cancelText(row) {
  // 用星换的单，取消后星星退回
  const stars = row.starRedeem ? '用掉的 ' + row.starRedeem.stars + ' 颗星会退回给顾客。' : ''
  if (row.payStatus !== 'paid') return '确定取消这单？' + stars
  if (row.payMethod === 'wechat') return '这单是微信支付的，取消后钱会原路退回顾客的微信。' + stars
  if (row.payMethod === 'voucher') return '这单全部用券或星星抵扣，取消后券和星星会退回给顾客。'
  if (row.payMethod === 'balance') return '这单是会员余额付的，取消后钱会退回顾客的余额。' + stars
  return '这单已在吧台收款，取消后请记得退款给顾客。' + stars
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
watch(print, savePrintSettings, { deep: true })
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
.sep { margin-left: 10px; }
.print-on { margin-left: 6px; }
.tip code { font-size: 12px; }
</style>
