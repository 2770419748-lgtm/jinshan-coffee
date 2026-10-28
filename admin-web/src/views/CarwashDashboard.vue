<template>
  <div>
    <div class="toolbar">
      <el-date-picker
        v-model="range"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="到"
        start-placeholder="开始"
        end-placeholder="结束"
        :shortcuts="shortcuts"
        :clearable="false"
        style="width: 280px; flex-grow: 0"
        @change="load"
      />
      <el-button @click="load" :loading="loading">刷新</el-button>
      <span class="spacer"></span>
      <el-button @click="exportCsv" :disabled="!orders">导出表格</el-button>
    </div>

    <div class="cards" v-if="orders && member">
      <div class="stat primary">
        <div class="label">合计实收</div>
        <div class="value">¥{{ yuan(totalCash) }}</div>
        <div class="sub">预约 ¥{{ yuan(orderCash) }} · 充值 ¥{{ yuan(rechargeCash) }} · 卖卡 ¥{{ yuan(member.totals.cardFee) }}</div>
      </div>
      <div class="stat">
        <div class="label">预约</div>
        <div class="value">{{ orders.totals.orders }} 单</div>
        <div class="sub">到店 {{ orders.totals.store }} · 上门 {{ orders.totals.door }} · 已完成 {{ orders.totals.finished }} · 取消 {{ orders.totals.cancelled }}</div>
      </div>
      <div class="stat">
        <div class="label">还没收的钱</div>
        <div class="value" :class="{ danger: orders.totals.unpaidFee }">¥{{ yuan(orders.totals.unpaidFee) }}</div>
        <div class="sub">选了到店付、技师还没登记收款的</div>
      </div>
      <div class="stat">
        <div class="label">收款方式</div>
        <div class="value small">微信 ¥{{ yuan(orders.totals.wechatFee + member.totals.onlineFee + member.totals.cardOnlineFee) }}</div>
        <div class="sub">到店收 ¥{{ yuan(orders.totals.counterFee + member.totals.counterFee + member.totals.cardCounterFee) }} · 余额付 ¥{{ yuan(orders.totals.balanceFee) }}</div>
      </div>
      <div class="stat">
        <div class="label">次卡</div>
        <div class="value small">卖 {{ member.totals.cardsSold }} 张 · 用 {{ member.totals.cardUses }} 次</div>
        <div class="sub">顾客手里还剩 {{ member.cardsLeft }} 次</div>
      </div>
      <div class="stat">
        <div class="label">洗车储值</div>
        <div class="value small">充 ¥{{ yuan(rechargeCash) }} · 送 ¥{{ yuan(member.totals.bonusFee) }}</div>
        <div class="sub">余额消费 ¥{{ yuan(member.totals.spentFee - member.totals.refundFee) }} · 顾客余额合计 ¥{{ yuan(member.balanceTotal) }}</div>
      </div>
    </div>

    <el-alert
      v-if="orders && orders.totals.cancelFee"
      type="info"
      :closable="false"
      show-icon
      class="block"
      :title="'取消的单按规则扣了 ¥' + yuan(orders.totals.cancelFee) + '（没退给顾客的部分），不算在上面的实收里'"
    />

    <el-card shadow="never" class="block" v-if="rows.length > 1">
      <template #header>每天明细</template>
      <el-table :data="rows" size="small" max-height="420">
        <el-table-column prop="day" label="日期" width="110" />
        <el-table-column label="预约" prop="orders" />
        <el-table-column label="到店" prop="store" />
        <el-table-column label="上门" prop="door" />
        <el-table-column label="取消" prop="cancelled" />
        <el-table-column label="预约实收"><template #default="{ row }">¥{{ yuan(row.orderCash) }}</template></el-table-column>
        <el-table-column label="余额付"><template #default="{ row }">¥{{ yuan(row.balance) }}</template></el-table-column>
        <el-table-column label="用卡次数" prop="cardUses" />
        <el-table-column label="充值"><template #default="{ row }">¥{{ yuan(row.recharge) }}</template></el-table-column>
        <el-table-column label="卖卡"><template #default="{ row }">¥{{ yuan(row.cardFee) }}</template></el-table-column>
        <el-table-column label="合计实收"><template #default="{ row }"><span class="gold">¥{{ yuan(row.total) }}</span></template></el-table-column>
      </el-table>
    </el-card>

    <div class="tip">预约按服务日期统计，充值和卖卡按发生日期统计。“实收”只算真收到的钱：预约的微信支付和到店收款、充值本金、卖次卡（用余额办的卡不算，钱在充值时算过了）。用余额、次卡付的预约不算进实收。</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { yuan, cnDay, addDays, downloadCsv } from '../format'

const today = cnDay()
const range = ref([today, today])
const orders = ref(null)
const member = ref(null)
const loading = ref(false)

const monthStart = today.slice(0, 8) + '01'
const shortcuts = [
  { text: '今天', value: () => [today, today] },
  { text: '昨天', value: () => [addDays(today, -1), addDays(today, -1)] },
  { text: '最近 7 天', value: () => [addDays(today, -6), today] },
  { text: '本月', value: () => [monthStart, today] },
  { text: '最近 30 天', value: () => [addDays(today, -29), today] }
]

const orderCash = computed(() => orders.value.totals.wechatFee + orders.value.totals.counterFee)
const rechargeCash = computed(() => member.value.totals.onlineFee + member.value.totals.counterFee)
const totalCash = computed(() => orderCash.value + rechargeCash.value + member.value.totals.cardFee)

const rows = computed(() => {
  if (!orders.value || !member.value) return []
  return orders.value.days.map((o, i) => {
    const m = member.value.days[i]
    const orderPaid = o.wechatFee + o.counterFee
    const recharge = m.onlineFee + m.counterFee
    return {
      day: o.day,
      orders: o.orders,
      store: o.store,
      door: o.door,
      cancelled: o.cancelled,
      orderCash: orderPaid,
      balance: o.balanceFee,
      cardUses: m.cardUses,
      recharge,
      cardFee: m.cardFee,
      total: orderPaid + recharge + m.cardFee
    }
  })
})

async function load() {
  loading.value = true
  try {
    const [from, to] = range.value
    const [o, m] = await Promise.all([
      api.carwash('daySummary', { from, to }),
      api.carwash('memberSummary', { from, to })
    ])
    orders.value = o
    member.value = m
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function exportCsv() {
  const header = ['日期', '预约单数', '到店', '上门', '取消', '预约实收(元)', '余额付(元)', '用卡次数', '充值(元)', '卖卡(元)', '合计实收(元)']
  const body = rows.value.map((r) => [r.day, r.orders, r.store, r.door, r.cancelled, yuan(r.orderCash), yuan(r.balance), r.cardUses, yuan(r.recharge), yuan(r.cardFee), yuan(r.total)])
  downloadCsv('洗车汇总_' + range.value[0] + '_' + range.value[1] + '.csv', [header].concat(body))
}

onMounted(load)
</script>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.stat {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  padding: 16px;
}
.stat.primary { border-color: var(--el-color-primary); }
.label { color: var(--el-text-color-secondary); font-size: 13px; }
.value { font-size: 26px; font-weight: 700; margin: 6px 0; color: var(--el-color-primary); }
.value.small { font-size: 20px; }
.value.danger { color: var(--el-color-danger); }
.sub { font-size: 12px; color: var(--el-text-color-secondary); }
.block { margin-bottom: 16px; }
</style>
