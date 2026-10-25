<template>
  <div>
    <div class="cards" v-if="stats">
      <div class="stat primary">
        <div class="label">今天充值</div>
        <div class="value">¥{{ yuan(stats.totals.onlineFee + stats.totals.counterFee) }}</div>
        <div class="sub">{{ stats.totals.recharges }} 笔 · 送出 ¥{{ yuan(stats.totals.bonusFee) }}</div>
      </div>
      <div class="stat">
        <div class="label">今天次卡</div>
        <div class="value">卖 {{ stats.totals.cardsSold }} · 用 {{ stats.totals.cardUses }}</div>
        <div class="sub">卖卡收 ¥{{ yuan(stats.totals.cardFee) }}（不含余额办的）</div>
      </div>
      <div class="stat">
        <div class="label">顾客余额合计</div>
        <div class="value">¥{{ yuan(stats.balanceTotal) }}</div>
        <div class="sub">还没花掉的洗车储值（含赠送）</div>
      </div>
      <div class="stat">
        <div class="label">次卡剩余</div>
        <div class="value">{{ stats.cardsLeft }} 次</div>
        <div class="sub">会员期内 {{ stats.memberCount }} 人</div>
      </div>
    </div>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="会员号，或备注里的名字、手机尾号" clearable style="width: 300px; flex-grow: 0" @keyup.enter="reload" @clear="reload" />
      <el-button type="primary" @click="reload">查找</el-button>
      <span class="tip">只列打开过洗车会员中心、或在洗车店充过值办过卡的顾客。会员号和进山咖啡通用，余额分开。</span>
    </div>

    <el-table :data="members" v-loading="loading" row-key="memberNo" empty-text="还没有洗车会员" @row-click="open">
      <el-table-column label="会员号" width="110">
        <template #default="{ row }"><b class="no">{{ row.memberNo }}</b></template>
      </el-table-column>
      <el-table-column label="备注" min-width="160">
        <template #default="{ row }"><span :class="{ muted: !row.remark }">{{ row.remark || '没有备注' }}</span></template>
      </el-table-column>
      <el-table-column label="余额" width="120">
        <template #default="{ row }"><span class="gold">¥{{ yuan(row.balance) }}</span></template>
      </el-table-column>
      <el-table-column label="会员" width="170">
        <template #default="{ row }">
          <el-tag v-if="row.isMember" size="small">至 {{ row.memberUntil }}</el-tag>
          <span v-else-if="row.memberUntil" class="muted">{{ row.memberUntil }} 已到期</span>
          <span v-else class="muted">不是会员</span>
        </template>
      </el-table-column>
      <el-table-column label="累计充值" width="120">
        <template #default="{ row }">¥{{ yuan(row.totalRecharge) }}</template>
      </el-table-column>
      <el-table-column label="最近变动" width="120">
        <template #default="{ row }">{{ time(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="" width="80">
        <template #default><el-button size="small" link type="primary">详情</el-button></template>
      </el-table-column>
    </el-table>
    <div class="more" v-if="hasMore"><el-button @click="load(false)" :loading="loading">加载更多</el-button></div>

    <el-drawer v-model="drawer" :title="detail ? '会员 ' + detail.member.memberNo : '会员'" size="600px">
      <template v-if="detail">
        <div class="card">
          <div class="row">
            <div>
              <div class="muted small">洗车余额</div>
              <div class="big">¥{{ yuan(detail.member.balance) }}</div>
            </div>
            <div class="right">
              <el-tag v-if="detail.member.isMember">会员至 {{ detail.member.memberUntil }}</el-tag>
              <span v-else class="muted">{{ detail.member.memberUntil ? detail.member.memberUntil + ' 已到期' : '不是会员' }}</span>
            </div>
          </div>
          <div class="muted small">累计充值 ¥{{ yuan(detail.member.totalRecharge) }} · 送 ¥{{ yuan(detail.member.totalBonus) }} · 消费 ¥{{ yuan(detail.member.totalSpent) }}</div>
          <div class="remark">
            <el-input v-model="remark" placeholder="备注：名字、手机尾号、车牌，方便找" maxlength="30" size="small" />
            <el-button size="small" @click="saveRemark" :disabled="remark === detail.member.remark">保存备注</el-button>
          </div>
        </div>

        <div class="actions">
          <el-button type="primary" @click="toCounter">充值 / 办卡 / 用卡</el-button>
          <el-button @click="openAdjust">调整余额 / 会员</el-button>
        </div>

        <el-tabs v-model="tab">
          <el-tab-pane :label="'次卡 ' + detail.cards.length" name="cards">
            <div v-if="!detail.cards.length" class="tip">没有次卡。</div>
            <div v-for="c in detail.cards" :key="c._id" class="item">
              <div>
                <div class="item-title">{{ c.name }} <el-tag size="small" :type="c.state === 'active' ? 'success' : 'info'">{{ c.stateText }}</el-tag></div>
                <div class="muted small">剩 {{ c.remaining }} / {{ c.total }} 次 · {{ c.expiresDay ? c.expiresDay + ' 到期' : '不限期' }} · 办卡 ¥{{ yuan(c.price) }} · {{ time(c.createdAt) }}</div>
                <div class="muted small">能洗：{{ c.serviceNames.join('、') }}</div>
              </div>
              <div class="item-ops" v-if="c.state !== 'refunded'">
                <el-button size="small" @click="openCardAdjust(c)">调整</el-button>
                <el-button size="small" @click="openRefund(c)">退卡</el-button>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="余额流水" name="logs">
            <el-table :data="detail.logs" size="small" empty-text="还没有余额变动">
              <el-table-column label="时间" width="95"><template #default="{ row }">{{ time(row.createdAt) }}</template></el-table-column>
              <el-table-column label="内容" min-width="150">
                <template #default="{ row }">
                  <div>{{ row.title || row.typeName }}</div>
                  <div class="muted small">{{ row.typeName }}<span v-if="row.operatorName"> · {{ row.operatorName }}</span></div>
                  <div v-if="row.reason" class="muted small">原因：{{ row.reason }}</div>
                </template>
              </el-table-column>
              <el-table-column label="变动" width="80">
                <template #default="{ row }"><span :class="{ gold: row.amount > 0 }">{{ signed(row.amount) }}</span></template>
              </el-table-column>
              <el-table-column label="余额" width="80"><template #default="{ row }">{{ yuan(row.balance) }}</template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="次卡流水" name="cardLogs">
            <el-table :data="detail.cardLogs" size="small" empty-text="还没有次卡变动">
              <el-table-column label="时间" width="95"><template #default="{ row }">{{ time(row.createdAt) }}</template></el-table-column>
              <el-table-column label="内容" min-width="170">
                <template #default="{ row }">
                  <div>{{ row.title || row.typeName }}</div>
                  <div class="muted small">{{ cardName(row.cardId) }} · {{ row.typeName }}<span v-if="row.operatorName"> · {{ row.operatorName }}</span></div>
                  <div v-if="row.reason" class="muted small">原因：{{ row.reason }}</div>
                </template>
              </el-table-column>
              <el-table-column label="次数" width="70"><template #default="{ row }">{{ row.change > 0 ? '+' + row.change : row.change }}</template></el-table-column>
              <el-table-column label="剩" width="60"><template #default="{ row }">{{ row.remaining }}</template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane :label="'送的咖啡券 ' + detail.vouchers.length" name="vouchers">
            <el-table :data="detail.vouchers" size="small" empty-text="洗车这边还没送过券">
              <el-table-column label="券" min-width="150">
                <template #default="{ row }">
                  <div>{{ row.title }}</div>
                  <div class="muted small">¥{{ yuan(row.amount) }}{{ row.minSpend ? '，满 ' + yuan(row.minSpend) + ' 可用' : '，无门槛' }} · {{ row.lastDay }} 前有效</div>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="80"><template #default="{ row }">{{ VOUCHER_STATUS[row.status] || row.status }}</template></el-table-column>
              <el-table-column label="" width="70">
                <template #default="{ row }"><el-button v-if="row.status === 'unused'" size="small" link @click="revoke(row)">撤回</el-button></template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-drawer>

    <el-dialog v-model="adjustDialog" title="调整余额 / 会员" width="480px" :close-on-click-modal="false">
      <div class="tip">线下退了储值后扣掉余额、补偿顾客、改会员到期日都在这里，会记在流水里。</div>
      <el-form label-width="90px">
        <el-form-item label="余额">
          <el-radio-group v-model="adjust.sign" size="small">
            <el-radio-button :value="-1">扣</el-radio-button>
            <el-radio-button :value="1">加</el-radio-button>
          </el-radio-group>
          <el-input-number v-model="adjust.yuan" :min="0" :max="10000" :precision="2" :step="10" class="sep" />
          <span class="muted small sep">元</span>
        </el-form-item>
        <el-form-item label="会员到期">
          <el-radio-group v-model="adjust.untilMode" size="small">
            <el-radio-button value="keep">不改</el-radio-button>
            <el-radio-button value="set">改日期</el-radio-button>
            <el-radio-button value="clear">取消会员</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="改到" v-if="adjust.untilMode === 'set'">
          <el-date-picker v-model="adjust.until" type="date" value-format="YYYY-MM-DD" :clearable="false" />
        </el-form-item>
        <el-form-item label="原因" required>
          <el-input v-model="adjust.reason" maxlength="40" placeholder="比如：线下退款、活动补偿" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustDialog = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitAdjust">确认调整</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="cardDialog" title="调整次卡" width="460px" :close-on-click-modal="false">
      <el-form label-width="90px" v-if="cardForm.card">
        <el-form-item label="次卡">{{ cardForm.card.name }}，剩 {{ cardForm.card.remaining }} 次</el-form-item>
        <el-form-item label="次数">
          <el-input-number v-model="cardForm.times" :min="-cardForm.card.remaining" :max="999" />
          <span class="muted small sep">正数加、负数减，0 不改</span>
        </el-form-item>
        <el-form-item label="到期日">
          <el-radio-group v-model="cardForm.dayMode" size="small">
            <el-radio-button value="keep">不改</el-radio-button>
            <el-radio-button value="set">改日期</el-radio-button>
            <el-radio-button value="none">不限期</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="改到" v-if="cardForm.dayMode === 'set'">
          <el-date-picker v-model="cardForm.day" type="date" value-format="YYYY-MM-DD" :clearable="false" />
        </el-form-item>
        <el-form-item label="原因" required>
          <el-input v-model="cardForm.reason" maxlength="40" placeholder="比如：洗得不满意补一次、顾客出差延期" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cardDialog = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitCardAdjust">确认调整</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="refundDialog" title="退卡" width="480px" :close-on-click-modal="false">
      <template v-if="refundForm.card">
        <div class="tip">先按店里的退费须知把钱线下退给顾客，再在这里登记。登记后这张卡剩下的 {{ refundForm.card.remaining }} 次清零。</div>
        <div class="tip" v-if="refundNotice">退费须知：{{ refundNotice }}</div>
        <el-form label-width="100px">
          <el-form-item label="次卡">{{ refundForm.card.name }}，办卡 ¥{{ yuan(refundForm.card.price) }}，剩 {{ refundForm.card.remaining }} / {{ refundForm.card.total }} 次</el-form-item>
          <el-form-item label="退了（元）" required>
            <el-input-number v-model="refundForm.yuan" :min="0" :max="refundForm.card.price / 100" :precision="2" :step="10" />
            <span class="muted small sep">没退钱填 0</span>
          </el-form-item>
          <el-form-item label="送的咖啡券">
            <el-checkbox v-model="refundForm.revoke">办这张卡送的、还没用的一起撤回</el-checkbox>
          </el-form-item>
          <el-form-item label="原因" required>
            <el-input v-model="refundForm.reason" maxlength="40" placeholder="比如：顾客搬家" />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="refundDialog = false">取消</el-button>
        <el-button type="danger" :loading="busy" @click="submitRefund">确认退卡</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan, time, cnDay } from '../format'

const VOUCHER_STATUS = { unused: '没用', used: '已用', expired: '已过期', revoked: '已撤回' }

const router = useRouter()
const members = ref([])
const keyword = ref('')
const loading = ref(false)
const hasMore = ref(false)
const stats = ref(null)
const drawer = ref(false)
const detail = ref(null)
const tab = ref('cards')
const remark = ref('')
const refundNotice = ref('')
const adjustDialog = ref(false)
const adjust = ref({})
const cardDialog = ref(false)
const cardForm = ref({})
const refundDialog = ref(false)
const refundForm = ref({})
const busy = ref(false)
let page = 0

const signed = (fen) => (fen > 0 ? '+' : fen < 0 ? '-' : '') + yuan(Math.abs(fen || 0))
const cardName = (id) => ((detail.value && detail.value.cards.find((c) => c._id === id)) || {}).name || '次卡'

async function load(reset) {
  if (reset) page = 0
  loading.value = true
  try {
    const res = await api.carwash('listMembers', { keyword: keyword.value, page })
    page++
    members.value = reset ? res.members : members.value.concat(res.members)
    hasMore.value = res.hasMore
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function reload() {
  load(true)
}

async function loadStats() {
  try {
    stats.value = await api.carwash('memberSummary', {})
  } catch (e) {
    // 汇总没出来不影响找会员
  }
}

async function loadDetail(no) {
  try {
    detail.value = await api.carwash('getMemberDetail', { memberNo: no })
    remark.value = detail.value.member.remark
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function open(row) {
  detail.value = null
  tab.value = 'cards'
  drawer.value = true
  await loadDetail(row.memberNo)
}

async function refresh() {
  await loadDetail(detail.value.member.memberNo)
  load(true)
  loadStats()
}

async function run(fn, done) {
  busy.value = true
  try {
    await fn()
    ElMessage.success(done || '已保存')
    return true
  } catch (e) {
    ElMessage.error(e.message)
    return false
  } finally {
    busy.value = false
  }
}

async function saveRemark() {
  if (await run(() => api.carwash('setMemberRemark', { memberNo: detail.value.member.memberNo, remark: remark.value }), '备注已保存')) refresh()
}

function toCounter() {
  router.push({ path: '/cw/counter', query: { no: detail.value.member.memberNo } })
}

function openAdjust() {
  const m = detail.value.member
  adjust.value = { sign: -1, yuan: 0, untilMode: 'keep', until: m.memberUntil || cnDay(), reason: '' }
  adjustDialog.value = true
}

async function submitAdjust() {
  const a = adjust.value
  const m = detail.value.member
  const amount = a.sign * Math.round(Number(a.yuan || 0) * 100)
  const params = { memberNo: m.memberNo, amount, reason: a.reason.trim() }
  if (a.untilMode === 'set') params.memberUntil = a.until
  if (a.untilMode === 'clear') params.memberUntil = ''
  if (!amount && params.memberUntil === undefined) return ElMessage.warning('金额和会员到期日都没改')
  if (!params.reason) return ElMessage.warning('请写上原因，比如「线下退款」')
  if (amount < 0 && -amount > m.balance) return ElMessage.warning('余额只有 ¥' + yuan(m.balance))
  if (await run(() => api.carwash('adjustMember', params), '已调整')) {
    adjustDialog.value = false
    refresh()
  }
}

function openCardAdjust(card) {
  cardForm.value = { card, times: 0, dayMode: 'keep', day: card.expiresDay || cnDay(), reason: '' }
  cardDialog.value = true
}

async function submitCardAdjust() {
  const f = cardForm.value
  const params = { cardId: f.card._id, times: f.times || 0, reason: f.reason.trim() }
  if (f.dayMode === 'set') params.expiresDay = f.day
  if (f.dayMode === 'none') params.expiresDay = ''
  if (!params.times && params.expiresDay === undefined) return ElMessage.warning('次数和到期日都没改')
  if (!params.reason) return ElMessage.warning('请写上原因')
  if (await run(() => api.carwash('adjustCard', params), '已调整')) {
    cardDialog.value = false
    refresh()
  }
}

async function openRefund(card) {
  refundForm.value = { card, yuan: 0, revoke: true, reason: '' }
  refundDialog.value = true
  try {
    refundNotice.value = (await api.carwash('getMemberSettings')).settings.refundNotice
  } catch (e) {
    refundNotice.value = ''
  }
}

async function submitRefund() {
  const f = refundForm.value
  if (!f.reason.trim()) return ElMessage.warning('请写上退卡原因')
  try {
    await ElMessageBox.confirm('确认已经线下退给顾客 ¥' + yuan(Math.round(Number(f.yuan || 0) * 100)) + '？退卡后不能恢复。', '退卡', { confirmButtonText: '确认退卡', cancelButtonText: '再想想', type: 'warning' })
  } catch (e) {
    return
  }
  let res = null
  const ok = await run(async () => {
    res = await api.carwash('refundCard', { cardId: f.card._id, refundFee: Math.round(Number(f.yuan || 0) * 100), reason: f.reason.trim(), revokeVouchers: f.revoke })
  }, '已退卡')
  if (ok) {
    if (res && res.revoked) ElMessage.success('撤回了 ' + res.revoked + ' 张咖啡券')
    refundDialog.value = false
    refresh()
  }
}

async function revoke(v) {
  let reason
  try {
    const res = await ElMessageBox.prompt('撤回「' + v.title + '」？撤回后顾客在咖啡店就用不了这张券了。', '撤回咖啡券', {
      confirmButtonText: '撤回',
      cancelButtonText: '不撤回',
      inputPlaceholder: '原因，比如：顾客退了储值',
      inputValidator: (s) => (String(s || '').trim() ? true : '请写上原因')
    })
    reason = res.value.trim()
  } catch (e) {
    return
  }
  if (await run(() => api.carwash('revokeVoucher', { id: v._id, reason }), '已撤回')) refresh()
}

onMounted(() => {
  load(true)
  loadStats()
})
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
.value { font-size: 24px; font-weight: 700; margin: 6px 0; color: var(--el-color-primary); }
.sub { font-size: 12px; color: var(--el-text-color-secondary); }
.no { letter-spacing: 1px; }
.small { font-size: 12px; }
.more { text-align: center; margin-top: 12px; }
.card {
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  padding: 16px;
  background: linear-gradient(135deg, #1d1d1d, #111);
  margin-bottom: 16px;
}
.row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.right { text-align: right; }
.big { font-size: 30px; font-weight: 700; }
.remark { display: flex; gap: 8px; margin-top: 12px; }
.actions { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
}
.item-title { font-weight: 600; }
.item-ops { display: flex; gap: 6px; flex-shrink: 0; }
.sep { margin-left: 8px; }
</style>
