<template>
  <div class="narrow">
    <div class="toolbar">
      <el-input v-model="no" placeholder="顾客的会员号" clearable style="width: 220px; flex-grow: 0" @keyup.enter="find" />
      <el-button type="primary" :loading="loading" @click="find">查找</el-button>
      <span class="tip">让顾客打开洗车小程序「我的 → 会员中心」报会员号（和进山咖啡的会员号是同一个）。</span>
    </div>

    <template v-if="m">
      <div class="card">
        <div class="row">
          <div>
            <div class="muted small">会员号 {{ m.member.memberNo }}<span v-if="m.member.remark"> · {{ m.member.remark }}</span></div>
            <div class="big">¥{{ yuan(m.member.balance) }}</div>
            <div class="muted small">洗车余额（和咖啡的余额分开算）</div>
          </div>
          <div class="right">
            <el-tag v-if="m.member.isMember">会员至 {{ m.member.memberUntil }}</el-tag>
            <span v-else class="muted small">{{ m.member.memberUntil ? m.member.memberUntil + ' 已到期' : '不是会员' }}</span>
          </div>
        </div>
        <div class="actions">
          <el-button type="primary" :disabled="!m.plans.length" @click="rechargeDialog = true">充值</el-button>
          <el-button :disabled="!m.cardTypes.length" @click="sellDialog = true">办次卡</el-button>
          <span class="muted small" v-if="!m.plans.length && !m.cardTypes.length">还没有上架的充值档位和次卡，店长在「储值和次卡」里配</span>
        </div>
      </div>

      <div class="section">能用的次卡</div>
      <div v-if="!m.cards.length" class="tip">这位顾客没有能用的次卡。</div>
      <div v-for="c in m.cards" :key="c._id" class="item">
        <div>
          <div class="item-title">{{ c.name }} <span class="gold">剩 {{ c.remaining }} 次</span><span class="muted small"> / 共 {{ c.total }} 次</span></div>
          <div class="muted small">能洗：{{ c.serviceNames.join('、') || '—' }} · {{ c.expiresDay ? c.expiresDay + ' 到期' : '不限期' }}</div>
        </div>
        <el-button type="primary" plain @click="openUse(c)">用一次</el-button>
      </div>
    </template>

    <el-dialog v-model="rechargeDialog" title="充值" width="460px">
      <div class="tip">先收顾客的钱（现金或收款码），再点对应的档位。</div>
      <div v-for="p in (m ? m.plans : [])" :key="p._id" class="plan" @click="recharge(p)">
        <div>
          <div class="gold plan-title">{{ p.title }}</div>
          <div class="muted small">收 ¥{{ yuan(p.price) }}，到账 ¥{{ yuan(p.price + p.bonus) }}<span v-if="p.memberDays">，送 {{ p.memberDays }} 天会员</span></div>
        </div>
        <el-button size="small" type="primary" plain :loading="busy">充这档</el-button>
      </div>
    </el-dialog>

    <el-dialog v-model="sellDialog" title="办次卡" width="460px">
      <div class="tip">先收顾客的钱（现金或收款码），再点对应的次卡。</div>
      <div v-for="t in (m ? m.cardTypes : [])" :key="t._id" class="plan" @click="sell(t)">
        <div>
          <div class="gold plan-title">{{ t.name }}</div>
          <div class="muted small">¥{{ yuan(t.price) }} · {{ t.times }} 次 · {{ t.validDays ? t.validDays + ' 天有效' : '不限期' }}</div>
          <div class="muted small" v-if="t.desc">{{ t.desc }}</div>
        </div>
        <el-button size="small" type="primary" plain :loading="busy">办这张</el-button>
      </div>
    </el-dialog>

    <el-dialog v-model="useDialog" title="用一次次卡" width="420px" :close-on-click-modal="false">
      <template v-if="useTarget">
        <div>{{ useTarget.name }}，现在剩 <b class="gold">{{ useTarget.remaining }}</b> 次，用完剩 {{ useTarget.remaining - 1 }} 次。</div>
        <div class="muted small">能洗：{{ useTarget.serviceNames.join('、') }}</div>
        <el-input v-model="useNote" maxlength="20" placeholder="备注，选填，比如车牌" class="note" />
      </template>
      <template #footer>
        <el-button @click="useDialog = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="useCard">确认扣 1 次</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan } from '../format'

const route = useRoute()
const no = ref(typeof route.query.no === 'string' ? route.query.no : '')
const m = ref(null)
const loading = ref(false)
const busy = ref(false)
const rechargeDialog = ref(false)
const sellDialog = ref(false)
const useDialog = ref(false)
const useTarget = ref(null)
const useNote = ref('')
let nonce = ''

// 请求号：同一次「用一次」连点两下、网络重发，服务器只扣一次
function newNonce() {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function find() {
  const v = no.value.trim()
  if (!v) return ElMessage.warning('请输入会员号')
  loading.value = true
  try {
    m.value = await api.carwash('staffFindMember', { memberNo: v })
  } catch (e) {
    m.value = null
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function reload() {
  try {
    m.value = await api.carwash('staffFindMember', { memberNo: m.value.member.memberNo })
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function recharge(plan) {
  const memberNo = m.value.member.memberNo
  const gift = plan.memberDays ? '，送 ' + plan.memberDays + ' 天会员' : ''
  try {
    await ElMessageBox.confirm('已经收到顾客 ¥' + yuan(plan.price) + '（现金或收款码）。给会员 ' + memberNo + ' 充 ¥' + yuan(plan.price + plan.bonus) + gift + '。', '确认收到钱了吗', { confirmButtonText: '确认充值', cancelButtonText: '再想想' })
  } catch (e) {
    return
  }
  busy.value = true
  try {
    const res = await api.carwash('counterRecharge', { memberNo, planId: plan._id })
    ElMessage.success('已充值，余额 ¥' + yuan(res.balance) + (res.vouchers ? '，送了 ' + res.vouchers + ' 张咖啡券' : ''))
    rechargeDialog.value = false
    reload()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}

async function sell(type) {
  const memberNo = m.value.member.memberNo
  try {
    await ElMessageBox.confirm('已经收到顾客 ¥' + yuan(type.price) + '（现金或收款码）。给会员 ' + memberNo + ' 开一张「' + type.name + '」（' + type.times + ' 次）。', '确认收到钱了吗', { confirmButtonText: '确认办卡', cancelButtonText: '再想想' })
  } catch (e) {
    return
  }
  busy.value = true
  try {
    await api.carwash('counterSellCard', { memberNo, typeId: type._id })
    ElMessage.success('已办卡')
    sellDialog.value = false
    reload()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}

function openUse(card) {
  useTarget.value = card
  useNote.value = ''
  nonce = newNonce()
  useDialog.value = true
}

async function useCard() {
  busy.value = true
  try {
    const res = await api.carwash('staffUseCard', { memberNo: m.value.member.memberNo, cardId: useTarget.value._id, nonce, note: useNote.value.trim() })
    ElMessage.success((res.duplicate ? '刚才已经扣过了，' : '已扣 1 次，') + '还剩 ' + res.remaining + ' 次')
    useDialog.value = false
    reload()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  if (no.value) find()
})
</script>

<style scoped>
.small { font-size: 12px; }
.card {
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 12px;
  padding: 16px;
  background: linear-gradient(135deg, #1d1d1d, #111);
  margin-bottom: 16px;
}
.row { display: flex; justify-content: space-between; align-items: flex-start; }
.right { text-align: right; }
.big { font-size: 30px; font-weight: 700; margin: 4px 0; }
.actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.section { font-size: 13px; color: var(--el-text-color-secondary); margin: 8px 0; }
.item, .plan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  margin-top: 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--el-bg-color);
}
.plan { cursor: pointer; }
.plan:hover { border-color: var(--el-color-primary); }
.item-title, .plan-title { font-weight: 600; }
.note { margin-top: 12px; }
</style>
