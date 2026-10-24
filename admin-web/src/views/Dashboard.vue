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
      <el-button @click="exportCsv" :disabled="!coffee">导出表格</el-button>
    </div>

    <div class="cards" v-if="coffee && book">
      <div class="stat primary">
        <div class="label">合计实收</div>
        <div class="value">¥{{ yuan(totalPaid) }}</div>
        <div class="sub">咖啡 ¥{{ yuan(coffee.totals.paidFee) }} · 借书 ¥{{ yuan(book.totals.paidFee + book.totals.overtimePaid) }}</div>
      </div>
      <div class="stat">
        <div class="label">咖啡订单</div>
        <div class="value">{{ coffee.totals.orders }} 单</div>
        <div class="sub">取消 {{ coffee.totals.cancelled }} 单</div>
      </div>
      <div class="stat">
        <div class="label">借书</div>
        <div class="value">{{ book.totals.rentals }} 次</div>
        <div class="sub">租金 ¥{{ yuan(book.totals.paidFee) }} · 超时费 ¥{{ yuan(book.totals.overtimePaid) }}</div>
      </div>
      <div class="stat">
        <div class="label">还没收的钱</div>
        <div class="value" :class="{ danger: totalUnpaid }">¥{{ yuan(totalUnpaid) }}</div>
        <div class="sub">咖啡 ¥{{ yuan(coffee.totals.unpaidFee) }} · 借书 ¥{{ yuan(book.totals.unpaidFee + book.totals.overtimeUnpaid) }}</div>
      </div>
      <div class="stat">
        <div class="label">赠饮券</div>
        <div class="value">发 {{ book.totals.vouchersIssued }} · 用 {{ coffee.totals.vouchersUsed }}</div>
        <div class="sub">抵扣 ¥{{ yuan(coffee.totals.discountFee) }}</div>
      </div>
      <div class="stat">
        <div class="label">收款方式</div>
        <div class="value small">吧台 ¥{{ yuan(coffee.totals.counterFee + book.totals.counterFee) }}</div>
        <div class="sub">微信支付 ¥{{ yuan(coffee.totals.wechatFee + book.totals.wechatFee) }}</div>
      </div>
    </div>

    <el-alert
      v-if="coffee && (coffee.totals.cancelledPaidFee || book.totals.cancelledPaidFee)"
      type="warning"
      :closable="false"
      show-icon
      class="refund"
      :title="'有收过款又取消的单，共 ¥' + yuan(coffee.totals.cancelledPaidFee + book.totals.cancelledPaidFee) + '，记得确认已经退给顾客'"
    />

    <el-card shadow="never" class="block" v-if="rows.length > 1">
      <template #header>每天明细</template>
      <el-table :data="rows" size="small" max-height="420">
        <el-table-column prop="day" label="日期" width="110" />
        <el-table-column label="咖啡单数" prop="orders" />
        <el-table-column label="咖啡实收"><template #default="{ row }">¥{{ yuan(row.coffeePaid) }}</template></el-table-column>
        <el-table-column label="赠饮抵扣"><template #default="{ row }">¥{{ yuan(row.discount) }}</template></el-table-column>
        <el-table-column label="借书次数" prop="rentals" />
        <el-table-column label="租金实收"><template #default="{ row }">¥{{ yuan(row.bookPaid) }}</template></el-table-column>
        <el-table-column label="超时费"><template #default="{ row }">¥{{ yuan(row.overtime) }}</template></el-table-column>
        <el-table-column label="合计实收"><template #default="{ row }"><span class="gold">¥{{ yuan(row.total) }}</span></template></el-table-column>
      </el-table>
    </el-card>

    <div class="two" v-if="coffee && book">
      <el-card shadow="never" class="block">
        <template #header>咖啡卖得最多</template>
        <el-table :data="coffee.products.slice(0, 15)" size="small" empty-text="这段时间还没有订单">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column prop="name" label="商品" />
          <el-table-column prop="qty" label="杯数" width="80" />
          <el-table-column label="金额" width="100"><template #default="{ row }">¥{{ yuan(row.amount) }}</template></el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never" class="block">
        <template #header>借书计费方式</template>
        <el-table :data="book.rules" size="small" empty-text="这段时间还没有人借书">
          <el-table-column prop="name" label="计费方式" />
          <el-table-column prop="count" label="次数" width="80" />
          <el-table-column label="租金" width="100"><template #default="{ row }">¥{{ yuan(row.amount) }}</template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="tip">金额按下单日期统计；“实收”只算已经收款的单，取消的单不算。</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { yuan, cnDay, addDays, downloadCsv } from '../format'

const today = cnDay()
const range = ref([today, today])
const coffee = ref(null)
const book = ref(null)
const loading = ref(false)

const monthStart = today.slice(0, 8) + '01'
const shortcuts = [
  { text: '今天', value: () => [today, today] },
  { text: '昨天', value: () => [addDays(today, -1), addDays(today, -1)] },
  { text: '最近 7 天', value: () => [addDays(today, -6), today] },
  { text: '本月', value: () => [monthStart, today] },
  { text: '最近 30 天', value: () => [addDays(today, -29), today] }
]

const totalPaid = computed(() => coffee.value.totals.paidFee + book.value.totals.paidFee + book.value.totals.overtimePaid)
const totalUnpaid = computed(() => coffee.value.totals.unpaidFee + book.value.totals.unpaidFee + book.value.totals.overtimeUnpaid)

const rows = computed(() => {
  if (!coffee.value || !book.value) return []
  return coffee.value.days.map((c, i) => {
    const b = book.value.days[i]
    return {
      day: c.day,
      orders: c.orders,
      coffeePaid: c.paidFee,
      discount: c.discountFee,
      rentals: b.rentals,
      bookPaid: b.paidFee,
      overtime: b.overtimePaid,
      total: c.paidFee + b.paidFee + b.overtimePaid
    }
  })
})

async function load() {
  loading.value = true
  try {
    const [from, to] = range.value
    const [c, b] = await Promise.all([api.coffee('daySummary', { from, to }), api.book('daySummary', { from, to })])
    coffee.value = c
    book.value = b
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function exportCsv() {
  const header = ['日期', '咖啡单数', '咖啡实收(元)', '赠饮抵扣(元)', '借书次数', '租金实收(元)', '超时费(元)', '合计实收(元)']
  const body = rows.value.map((r) => [r.day, r.orders, yuan(r.coffeePaid), yuan(r.discount), r.rentals, yuan(r.bookPaid), yuan(r.overtime), yuan(r.total)])
  const products = coffee.value.products.map((p) => [p.name, p.qty, yuan(p.amount)])
  downloadCsv('进山汇总_' + range.value[0] + '_' + range.value[1] + '.csv', [header].concat(body, [[], ['商品', '杯数', '金额(元)']], products))
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
.stat.primary {
  border-color: var(--el-color-primary);
  background: linear-gradient(135deg, #2a2316, #141312);
}
.label {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.value {
  font-size: 26px;
  font-weight: 700;
  margin: 6px 0;
  color: var(--el-color-primary);
}
.value.small { font-size: 20px; }
.value.danger { color: var(--el-color-danger); }
.sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.refund { margin-bottom: 16px; }
.block { margin-bottom: 16px; }
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 900px) {
  .two { grid-template-columns: 1fr; }
}
</style>
