<template>
  <div>
    <el-card shadow="never" class="block">
      <template #header>洗车储值设置</template>
      <el-form label-width="120px" v-loading="loading">
        <el-form-item label="会员储值">
          <el-switch v-model="form.enabled" />
          <span class="muted small sep">{{ form.enabled ? '顾客能在洗车小程序里充值、用余额付预约和办卡' : '没打开，顾客看不到充值，也不能用余额付' }}</span>
        </el-form-item>
        <el-form-item label="储值说明">
          <el-input v-model="form.notice" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="显示在会员中心，比如：储值金额只能在本店洗车使用，不能提现，和进山咖啡的余额分开" />
        </el-form-item>
        <el-form-item label="退费须知">
          <el-input v-model="form.refundNotice" type="textarea" :rows="3" maxlength="300" show-word-limit placeholder="显示给顾客看，退卡、退储值时按这个算，比如：次卡按已用次数原价扣除后退还剩余金额" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="saveSettings">保存设置</el-button>
          <span class="muted small sep">{{ payEnabled ? '洗车的微信支付已开通，顾客能自己在小程序里充值、办卡。' : '洗车的微信支付还没开通，顾客到店付钱，店员在「到店收银」里充值、办卡。' }}</span>
        </el-form-item>
      </el-form>
    </el-card>

    <div class="toolbar">
      <span class="tip">充值档位：顾客付多少、送多少、送几天会员。会员期内预约有会员价的项目按会员价算。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openPlan(null)">新增档位</el-button>
    </div>
    <el-table :data="plans" row-key="_id" class="block" empty-text="还没有充值档位">
      <el-table-column label="顺序" width="90">
        <template #default="{ $index }">
          <el-button size="small" link :disabled="$index === 0" @click="move('plans', $index, -1)">↑</el-button>
          <el-button size="small" link :disabled="$index === plans.length - 1" @click="move('plans', $index, 1)">↓</el-button>
        </template>
      </el-table-column>
      <el-table-column label="名称" min-width="140">
        <template #default="{ row }">
          <div class="gold">{{ row.title }}</div>
          <div class="muted small" v-if="row.desc">{{ row.desc }}</div>
        </template>
      </el-table-column>
      <el-table-column label="收" width="100"><template #default="{ row }">¥{{ yuan(row.price) }}</template></el-table-column>
      <el-table-column label="送" width="100"><template #default="{ row }">¥{{ yuan(row.bonus) }}</template></el-table-column>
      <el-table-column label="到账" width="100"><template #default="{ row }">¥{{ yuan(row.price + row.bonus) }}</template></el-table-column>
      <el-table-column label="送会员" width="100"><template #default="{ row }">{{ row.memberDays ? row.memberDays + ' 天' : '不送' }}</template></el-table-column>
      <el-table-column label="上架" width="80">
        <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(v) => setEnabled('plans', row, v)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openPlan(row)">编辑</el-button>
          <el-button size="small" link @click="remove('plans', row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="toolbar">
      <span class="tip">次卡：比如「精洗 10 次卡」，买了以后预约时直接抵掉项目价，或者到店直接扣次数。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openType(null)" :disabled="!services.length">新增次卡</el-button>
    </div>
    <div v-if="!services.length" class="tip">先在「服务项目」里加上项目，次卡要选能用在哪些项目上。</div>
    <el-table :data="cardTypes" row-key="_id" empty-text="还没有次卡">
      <el-table-column label="顺序" width="90">
        <template #default="{ $index }">
          <el-button size="small" link :disabled="$index === 0" @click="move('cardTypes', $index, -1)">↑</el-button>
          <el-button size="small" link :disabled="$index === cardTypes.length - 1" @click="move('cardTypes', $index, 1)">↓</el-button>
        </template>
      </el-table-column>
      <el-table-column label="名称" min-width="140">
        <template #default="{ row }">
          <div class="gold">{{ row.name }}</div>
          <div class="muted small" v-if="row.desc">{{ row.desc }}</div>
        </template>
      </el-table-column>
      <el-table-column label="价格" width="100"><template #default="{ row }">¥{{ yuan(row.price) }}</template></el-table-column>
      <el-table-column label="次数" width="80"><template #default="{ row }">{{ row.times }} 次</template></el-table-column>
      <el-table-column label="有效期" width="100"><template #default="{ row }">{{ row.validDays ? row.validDays + ' 天' : '不限期' }}</template></el-table-column>
      <el-table-column label="能用在" min-width="140"><template #default="{ row }">{{ serviceText(row.serviceIds) }}</template></el-table-column>
      <el-table-column label="上架" width="80">
        <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(v) => setEnabled('cardTypes', row, v)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openType(row)">编辑</el-button>
          <el-button size="small" link @click="remove('cardTypes', row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="planDialog" :title="plan._id ? '编辑充值档位' : '新增充值档位'" width="500px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="充多少（元）" required>
          <el-input-number v-model="plan.priceYuan" :min="0.01" :max="10000" :precision="2" :step="50" />
        </el-form-item>
        <el-form-item label="送多少（元）">
          <el-input-number v-model="plan.bonusYuan" :min="0" :max="10000" :precision="2" :step="50" />
          <span class="muted small sep">0 就是不送</span>
        </el-form-item>
        <el-form-item label="送会员天数">
          <el-input-number v-model="plan.memberDays" :min="0" :max="3650" :step="30" />
          <span class="muted small sep">0 就是不送</span>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="plan.title" maxlength="16" show-word-limit :placeholder="planAutoTitle" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="plan.desc" maxlength="40" placeholder="选填，比如「最划算」" />
        </el-form-item>
        <el-form-item label="上架"><el-switch v-model="plan.enabled" /></el-form-item>
      </el-form>
      <div class="tip">充值满多少送咖啡券在「送咖啡券」里配。改金额只影响以后的充值。</div>
      <template #footer>
        <el-button @click="planDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="savePlan">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="typeDialog" :title="type._id ? '编辑次卡' : '新增次卡'" width="520px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="名称" required>
          <el-input v-model="type.name" maxlength="20" placeholder="比如：精洗 10 次卡" />
        </el-form-item>
        <el-form-item label="价格（元）" required>
          <el-input-number v-model="type.priceYuan" :min="0.01" :max="10000" :precision="2" :step="50" />
        </el-form-item>
        <el-form-item label="次数" required>
          <el-input-number v-model="type.times" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="有效天数" required>
          <el-input-number v-model="type.validDays" :min="0" :max="3650" :step="30" :value-on-clear="null" />
          <span class="muted small sep">从办卡当天算；不限期填 0</span>
        </el-form-item>
        <el-form-item label="能用在" required>
          <el-checkbox-group v-model="type.serviceIds">
            <el-checkbox v-for="s in services" :key="s._id" :value="s._id">{{ s.name }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="type.desc" maxlength="60" placeholder="选填，比如：上门也能用，上门费另付" />
        </el-form-item>
        <el-form-item label="上架"><el-switch v-model="type.enabled" /></el-form-item>
      </el-form>
      <div class="tip">改次卡只影响以后办的卡，顾客手里的卡次数、到期日不变。</div>
      <template #footer>
        <el-button @click="typeDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveType">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan } from '../format'

// 档位和次卡的增删改排序接口名
const OPS = {
  plans: { flag: 'setPlanFlags', sort: 'sortPlans', remove: 'deletePlan', what: '档位', name: (r) => r.title, gone: '顾客不能再充这一档，已经充进去的钱不受影响' },
  cardTypes: { flag: 'setCardTypeFlags', sort: 'sortCardTypes', remove: 'deleteCardType', what: '次卡', name: (r) => r.name, gone: '顾客不能再办这种卡，已经办了的卡照常能用' }
}

const loading = ref(false)
const saving = ref(false)
const form = ref({ enabled: false, notice: '', refundNotice: '' })
const plans = ref([])
const cardTypes = ref([])
const services = ref([])
const payEnabled = ref(false)
const planDialog = ref(false)
const plan = ref({})
const typeDialog = ref(false)
const type = ref({})
const lists = { plans, cardTypes }

const fen = (v) => Math.round(Number(v || 0) * 100)
const planAutoTitle = computed(() => {
  const p = plan.value
  return '不填自动叫「充 ' + yuan(fen(p.priceYuan)) + (p.bonusYuan ? ' 送 ' + yuan(fen(p.bonusYuan)) : '') + '」'
})

function serviceText(ids) {
  return (ids || []).map((id) => (services.value.find((s) => s._id === id) || {}).name).filter(Boolean).join('、') || '—'
}

// first：第一次进来才把设置填进表单，之后只刷新档位和次卡，没保存的改动不丢
async function load(first) {
  loading.value = true
  try {
    const res = await api.carwash('getMemberSettings')
    if (first) form.value = Object.assign({}, res.settings)
    plans.value = res.plans
    cardTypes.value = res.cardTypes
    services.value = res.services
    payEnabled.value = res.payEnabled
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  saving.value = true
  try {
    await api.carwash('saveMemberSettings', form.value)
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function setEnabled(kind, row, value) {
  row.enabled = value
  try {
    await api.carwash(OPS[kind].flag, { id: row._id, enabled: value })
  } catch (e) {
    row.enabled = !value
    ElMessage.error(e.message)
  }
}

async function move(kind, index, delta) {
  const list = lists[kind].value.slice()
  const [item] = list.splice(index, 1)
  list.splice(index + delta, 0, item)
  lists[kind].value = list
  try {
    await api.carwash(OPS[kind].sort, { ids: list.map((p) => p._id) })
  } catch (e) {
    ElMessage.error(e.message)
    load(false)
  }
}

async function remove(kind, row) {
  const op = OPS[kind]
  try {
    await ElMessageBox.confirm('删除「' + op.name(row) + '」？删除后' + op.gone + '。只是暂停的话，关掉「上架」就好。', '删除' + op.what, { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.carwash(op.remove, { id: row._id })
    load(false)
  } catch (e) {
    ElMessage.error(e.message)
  }
}

function openPlan(row) {
  const p = row || { price: null, bonus: 0, memberDays: 0, title: '', desc: '', enabled: true }
  plan.value = {
    _id: p._id,
    priceYuan: p.price ? p.price / 100 : undefined,
    bonusYuan: (p.bonus || 0) / 100,
    memberDays: p.memberDays || 0,
    title: row ? p.title : '',
    desc: p.desc || '',
    enabled: p.enabled !== false
  }
  planDialog.value = true
}

async function savePlan() {
  const p = plan.value
  const data = { price: fen(p.priceYuan), bonus: fen(p.bonusYuan), memberDays: p.memberDays || 0, title: p.title.trim(), desc: p.desc.trim(), enabled: p.enabled }
  if (!data.price) return ElMessage.warning('请填写充值金额')
  if (p._id) data._id = p._id
  saving.value = true
  try {
    await api.carwash('savePlan', { plan: data })
    ElMessage.success('已保存')
    planDialog.value = false
    load(false)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

function openType(row) {
  const t = row || { name: '', price: null, times: null, validDays: null, serviceIds: [], desc: '', enabled: true }
  type.value = {
    _id: t._id,
    name: t.name,
    priceYuan: t.price ? t.price / 100 : undefined,
    times: t.times || undefined,
    validDays: t.validDays === null || t.validDays === undefined ? null : t.validDays,
    serviceIds: (t.serviceIds || []).slice(),
    desc: t.desc || '',
    enabled: t.enabled !== false
  }
  typeDialog.value = true
}

async function saveType() {
  const t = type.value
  if (!t.name.trim()) return ElMessage.warning('请填次卡名称')
  if (!t.priceYuan) return ElMessage.warning('请填价格')
  if (!t.times) return ElMessage.warning('请填次数')
  if (t.validDays === null || t.validDays === undefined) return ElMessage.warning('请填有效天数，不限期填 0')
  if (!t.serviceIds.length) return ElMessage.warning('请选能用在哪些项目上')
  const data = { name: t.name.trim(), price: fen(t.priceYuan), times: t.times, validDays: t.validDays, serviceIds: t.serviceIds, desc: t.desc.trim(), enabled: t.enabled }
  if (t._id) data._id = t._id
  saving.value = true
  try {
    await api.carwash('saveCardType', { cardType: data })
    ElMessage.success('已保存')
    typeDialog.value = false
    load(false)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

onMounted(() => load(true))
</script>

<style scoped>
.block { margin-bottom: 16px; }
.small { font-size: 12px; }
.sep { margin-left: 10px; }
</style>
