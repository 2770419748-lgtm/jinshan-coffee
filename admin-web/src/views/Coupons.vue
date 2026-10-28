<template>
  <div>
    <div class="toolbar">
      <span class="tip">顾客在首页「领券中心」自己领，下单时自动抵扣。一单用一张，可以和赠饮券一起用。停发后领不到了，已经领的照样能用。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openEdit(null)">新增代金券</el-button>
    </div>

    <el-table :data="coupons" v-loading="loading" row-key="_id" empty-text="还没有代金券，新增一张，比如「满 30 减 5」">
      <el-table-column label="面额" width="90">
        <template #default="{ row }"><span class="amount">¥{{ yuan(row.amount) }}</span></template>
      </el-table-column>
      <el-table-column label="名称" min-width="150">
        <template #default="{ row }">
          <div>{{ row.title }}</div>
          <div class="muted small">{{ row.minSpend ? '满 ' + yuan(row.minSpend) + ' 元可用' : '无门槛' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="有效期" width="130">
        <template #default="{ row }">领取后 {{ row.validDays }} 天</template>
      </el-table-column>
      <el-table-column label="每人限领" width="90">
        <template #default="{ row }">{{ row.perUser }} 张</template>
      </el-table-column>
      <el-table-column label="已领 / 总数" width="120">
        <template #default="{ row }">{{ row.claimed }} / {{ row.total || '不限' }}</template>
      </el-table-column>
      <el-table-column label="已用" width="70" prop="used" />
      <el-table-column label="发放" width="80">
        <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(v) => setEnabled(row, v)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="form._id ? '编辑代金券' : '新增代金券'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="减多少（元）" required>
          <el-input-number v-model="form.amountYuan" :min="0.01" :max="200" :precision="2" :step="1" />
        </el-form-item>
        <el-form-item label="满多少可用">
          <el-input-number v-model="form.minYuan" :min="0" :max="1000" :precision="2" :step="5" />
          <span class="muted small sep">元，0 就是无门槛</span>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.title" maxlength="16" show-word-limit :placeholder="autoTitle" />
        </el-form-item>
        <el-form-item label="有效天数">
          <el-input-number v-model="form.validDays" :min="1" :max="365" />
          <span class="muted small sep">领取当天算第 1 天</span>
        </el-form-item>
        <el-form-item label="一共发几张">
          <el-input-number v-model="form.total" :min="0" :max="100000" />
          <span class="muted small sep">0 就是不限量</span>
        </el-form-item>
        <el-form-item label="每人限领">
          <el-input-number v-model="form.perUser" :min="1" :max="10" />
        </el-form-item>
        <el-form-item label="发放"><el-switch v-model="form.enabled" /></el-form-item>
      </el-form>
      <div class="tip" v-if="form.claimed">已经领走 {{ form.claimed }} 张。改金额、门槛只影响之后领的券，已领的按领取时的算。</div>
      <div class="tip">门槛按用完赠饮券以后还要付的钱算，最多抵到 0 元。</div>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan } from '../format'

const coupons = ref([])
const loading = ref(false)
const dialog = ref(false)
const saving = ref(false)
const form = ref({})

const fen = (v) => Math.round(Number(v || 0) * 100)
const autoTitle = computed(() => {
  const f = form.value
  const amount = yuan(fen(f.amountYuan))
  return '不填自动叫「' + (f.minYuan ? '满' + yuan(fen(f.minYuan)) + '减' + amount : amount + '元无门槛券') + '」'
})

async function load() {
  loading.value = true
  try {
    coupons.value = await api.coffee('adminListCoupons')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function setEnabled(row, value) {
  row.enabled = value
  try {
    await api.coffee('setCouponFlags', { id: row._id, enabled: value })
  } catch (e) {
    row.enabled = !value
    ElMessage.error(e.message)
  }
}

function openEdit(row) {
  const c = row || { amount: 500, minSpend: 3000, title: '', validDays: 7, total: 0, perUser: 1, enabled: true, claimed: 0 }
  form.value = {
    _id: c._id,
    amountYuan: c.amount / 100,
    minYuan: (c.minSpend || 0) / 100,
    title: row ? c.title : '',
    validDays: c.validDays,
    total: c.total || 0,
    perUser: c.perUser || 1,
    enabled: c.enabled !== false,
    claimed: c.claimed || 0
  }
  dialog.value = true
}

async function save() {
  const f = form.value
  const amount = fen(f.amountYuan)
  const minSpend = fen(f.minYuan)
  if (!amount) return ElMessage.warning('请填写减多少钱')
  if (minSpend && minSpend < amount) return ElMessage.warning('门槛不能低于减免金额')
  const coupon = { amount, minSpend, title: f.title.trim(), validDays: f.validDays, total: f.total || 0, perUser: f.perUser, enabled: f.enabled }
  if (f._id) coupon._id = f._id
  saving.value = true
  try {
    await api.coffee('saveCoupon', { coupon })
    ElMessage.success('已保存')
    dialog.value = false
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('删除「' + row.title + '」？删除后顾客领不到了，已经领的照样能用。只是暂停的话，关掉「发放」就好。', '删除代金券', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.coffee('deleteCoupon', { id: row._id })
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.amount {
  color: var(--el-color-primary);
  font-size: 18px;
  font-weight: 600;
}
.small { font-size: 12px; }
.sep { margin-left: 8px; }
.tip { margin-top: 4px; }
</style>
