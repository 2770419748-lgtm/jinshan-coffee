<template>
  <div>
    <div class="toolbar">
      <span class="tip">顾客在洗车店充值或办次卡后，自动送进山咖啡的代金券。券在两个小程序「我的券」里都看得到，只能在咖啡店用，点单时自动抵扣。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openEdit(null)">新增规则</el-button>
    </div>
    <el-table :data="rules" v-loading="loading" row-key="_id" empty-text="还没有送券规则">
      <el-table-column label="规则" min-width="260">
        <template #default="{ row }">
          <div>{{ row.text }}</div>
          <div class="muted small" v-if="row.title">券名：{{ row.title }}</div>
        </template>
      </el-table-column>
      <el-table-column label="送出 / 用掉" width="120">
        <template #default="{ row }">{{ row.issued }} / {{ row.used }} 张</template>
      </el-table-column>
      <el-table-column label="启用" width="80">
        <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(v) => setEnabled(row, v)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="tip">
      充值有几条规则时，只按满足条件的最高一档送（充 500 不会同时拿「满 300」和「满 500」两档）；办次卡按这种卡的所有规则送。
      同一笔充值、同一张卡只送一次。顾客退卡时可以在「会员管理」里把送的券一起撤回。
    </div>

    <el-dialog v-model="dialog" :title="form._id ? '编辑送券规则' : '新增送券规则'" width="520px" :close-on-click-modal="false">
      <el-form label-width="120px">
        <el-form-item label="什么时候送" required>
          <el-radio-group v-model="form.trigger">
            <el-radio value="recharge">充值满多少</el-radio>
            <el-radio value="card" :disabled="!cardTypes.length">办某种次卡</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="充值满（元）" v-if="form.trigger === 'recharge'" required>
          <el-input-number v-model="form.minYuan" :min="0.01" :max="10000" :precision="2" :step="50" />
          <span class="muted small sep">按顾客实际付的钱算，不算赠送</span>
        </el-form-item>
        <el-form-item label="办哪种卡" v-else required>
          <el-select v-model="form.cardTypeId" placeholder="选一种次卡">
            <el-option v-for="t in cardTypes" :key="t._id" :label="t.name" :value="t._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="送几张" required>
          <el-input-number v-model="form.count" :min="1" :max="20" />
        </el-form-item>
        <el-form-item label="每张抵（元）" required>
          <el-input-number v-model="form.amountYuan" :min="0.01" :max="200" :precision="2" :step="5" />
        </el-form-item>
        <el-form-item label="满多少可用（元）">
          <el-input-number v-model="form.minSpendYuan" :min="0" :max="10000" :precision="2" :step="5" />
          <span class="muted small sep">无门槛填 0</span>
        </el-form-item>
        <el-form-item label="有效天数" required>
          <el-input-number v-model="form.validDays" :min="1" :max="365" />
          <span class="muted small sep">从送券当天算</span>
        </el-form-item>
        <el-form-item label="券名">
          <el-input v-model="form.title" maxlength="16" :placeholder="'不填叫「洗车送 ¥' + yuan(fen(form.amountYuan)) + ' 咖啡券」'" />
        </el-form-item>
        <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
      </el-form>
      <div class="tip">改规则只影响以后送的券，已经送出去的不变。</div>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan } from '../format'

const rules = ref([])
const cardTypes = ref([])
const loading = ref(false)
const saving = ref(false)
const dialog = ref(false)
const form = ref({})

const fen = (v) => Math.round(Number(v || 0) * 100)

async function load() {
  loading.value = true
  try {
    const res = await api.carwash('listLinkRules')
    rules.value = res.rules
    cardTypes.value = res.cardTypes
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function openEdit(row) {
  const r = row || { trigger: 'recharge', minAmount: null, cardTypeId: '', count: 1, amount: null, minSpend: 0, validDays: null, title: '', enabled: true }
  form.value = {
    _id: r._id,
    trigger: r.trigger,
    minYuan: r.minAmount ? r.minAmount / 100 : undefined,
    cardTypeId: r.cardTypeId || '',
    count: r.count,
    amountYuan: r.amount ? r.amount / 100 : undefined,
    minSpendYuan: (r.minSpend || 0) / 100,
    validDays: r.validDays || undefined,
    title: r.title || '',
    enabled: r.enabled !== false
  }
  dialog.value = true
}

async function save() {
  const f = form.value
  if (f.trigger === 'recharge' && !f.minYuan) return ElMessage.warning('请填充值满多少')
  if (f.trigger === 'card' && !f.cardTypeId) return ElMessage.warning('请选办哪种次卡时送')
  if (!f.amountYuan) return ElMessage.warning('请填每张抵多少')
  if (!f.validDays) return ElMessage.warning('请填有效天数')
  const rule = {
    trigger: f.trigger,
    minAmount: f.trigger === 'recharge' ? fen(f.minYuan) : 0,
    cardTypeId: f.trigger === 'card' ? f.cardTypeId : '',
    count: f.count,
    amount: fen(f.amountYuan),
    minSpend: fen(f.minSpendYuan),
    validDays: f.validDays,
    title: f.title.trim(),
    enabled: f.enabled
  }
  if (f._id) rule._id = f._id
  saving.value = true
  try {
    await api.carwash('saveLinkRule', { rule })
    ElMessage.success('已保存')
    dialog.value = false
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function setEnabled(row, value) {
  row.enabled = value
  try {
    await api.carwash('setLinkRuleFlags', { id: row._id, enabled: value })
  } catch (e) {
    row.enabled = !value
    ElMessage.error(e.message)
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('删除这条规则？已经送出去的券不受影响。只是暂停的话，关掉「启用」就好。', '删除送券规则', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.carwash('deleteLinkRule', { id: row._id })
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.small { font-size: 12px; }
.sep { margin-left: 10px; }
.tip { margin-top: 12px; }
</style>
