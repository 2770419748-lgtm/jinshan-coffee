<template>
  <div>
    <div class="toolbar">
      <span class="tip">顾客借书时从上架的规则里选。改价只影响之后的新单。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openEdit(null)">新增规则</el-button>
    </div>

    <el-table :data="rules" v-loading="loading" empty-text="还没有计费规则，可以新增，也可以到「书目管理」导入示例">
      <el-table-column label="名称" min-width="140">
        <template #default="{ row }">
          <div>{{ row.name }} <el-tag size="small">{{ RULE_TYPE[row.type] }}</el-tag></div>
          <div class="muted small" v-if="row.desc">{{ row.desc }}</div>
        </template>
      </el-table-column>
      <el-table-column label="价格" width="180">
        <template #default="{ row }"><span class="gold">{{ row.summary }}</span></template>
      </el-table-column>
      <el-table-column label="详细" min-width="260">
        <template #default="{ row }">
          <span v-if="row.type === 'hourly'">可选 {{ row.minHours }} 到 {{ row.maxHours }} 小时；超时按小时补，宽限 {{ row.graceMinutes }} 分钟</span>
          <span v-else-if="row.freeCups">
            送 {{ row.freeCups }} 杯：{{ row.freeProducts.length ? row.freeProducts.map((p) => p.name).join('、') : '任选饮品' }}<template v-if="row.freeMaxFee">，每杯最多抵 ¥{{ yuan(row.freeMaxFee) }}</template>
          </span>
          <span v-else class="muted">不送饮品</span>
        </template>
      </el-table-column>
      <el-table-column label="上架" width="80">
        <template #default="{ row }"><el-switch :model-value="row.onShelf" @change="(v) => setShelf(row, v)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="130">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="form._id ? '编辑规则' : '新增规则'" width="600px" :close-on-click-modal="false">
      <el-form label-width="130px">
        <el-form-item label="名称" required><el-input v-model="form.name" maxlength="16" placeholder="比如 按小时、包天送咖啡" /></el-form-item>
        <el-form-item label="计费方式">
          <el-radio-group v-model="form.type">
            <el-radio-button value="hourly">按小时</el-radio-button>
            <el-radio-button value="day">包天</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="form.type === 'hourly' ? '每小时（元）' : '每天（元）'" required>
          <el-input-number v-model="form.priceYuan" :min="0" :max="1000" :precision="2" />
        </el-form-item>
        <template v-if="form.type === 'hourly'">
          <el-form-item label="可选小时数">
            <el-input-number v-model="form.minHours" :min="1" :max="24" /> <span class="sep">到</span>
            <el-input-number v-model="form.maxHours" :min="form.minHours" :max="24" />
          </el-form-item>
          <el-form-item label="宽限（分钟）">
            <el-input-number v-model="form.graceMinutes" :min="0" :max="60" />
            <span class="muted small sep">超时不到这么久不收钱</span>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="送几杯"><el-input-number v-model="form.freeCups" :min="0" :max="5" /></el-form-item>
          <template v-if="form.freeCups">
            <el-form-item label="每杯最多抵（元）">
              <el-input-number v-model="form.freeMaxYuan" :min="0" :max="1000" :precision="2" />
              <span class="muted small sep">0 表示按整杯抵</span>
            </el-form-item>
            <el-form-item label="能换哪些饮品">
              <el-select v-model="form.freeIds" multiple filterable placeholder="不选就是菜单上任选" style="width: 100%">
                <el-option v-for="p in products" :key="p._id" :label="p.name" :value="p._id" />
              </el-select>
            </el-form-item>
          </template>
        </template>
        <el-form-item label="说明"><el-input v-model="form.desc" maxlength="60" placeholder="选填，顾客能看到" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="form.sort" /></el-form-item>
        <el-form-item label="上架"><el-switch v-model="form.onShelf" /></el-form-item>
      </el-form>
      <div class="tip" v-if="form.type === 'hourly'">顾客借书时选几个小时先付钱，从交书开始计时。超过时间（扣掉宽限）按每小时价格补，不满 1 小时按 1 小时算。</div>
      <div class="tip" v-else>当天打烊前还书。送的饮品在收款后变成赠饮券，当天点单时自动抵扣。</div>
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
import { yuan, RULE_TYPE } from '../format'

const rules = ref([])
const products = ref([])
const loading = ref(false)
const dialog = ref(false)
const saving = ref(false)
const form = ref({})

async function load() {
  loading.value = true
  try {
    rules.value = await api.book('adminListRules')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function setShelf(row, value) {
  row.onShelf = value
  try {
    await api.book('setRuleFlags', { id: row._id, onShelf: value })
  } catch (e) {
    row.onShelf = !value
    ElMessage.error(e.message)
  }
}

async function openEdit(row) {
  const r = row || { name: '', type: 'hourly', price: 800, minHours: 1, maxHours: 8, graceMinutes: 10, freeCups: 0, freeProducts: [], freeMaxFee: 0, desc: '', sort: rules.value.length, onShelf: true }
  form.value = {
    _id: r._id,
    name: r.name,
    type: r.type,
    priceYuan: r.price / 100,
    minHours: r.minHours || 1,
    maxHours: r.maxHours || 8,
    graceMinutes: r.graceMinutes === undefined ? 10 : r.graceMinutes,
    freeCups: r.freeCups || 0,
    freeMaxYuan: (r.freeMaxFee || 0) / 100,
    freeIds: (r.freeProducts || []).map((p) => p.id),
    oldFree: r.freeProducts || [],
    desc: r.desc || '',
    sort: r.sort || 0,
    onShelf: r.onShelf !== false
  }
  dialog.value = true
  try {
    const menu = await api.coffee('getMenu')
    const list = menu.products.map((p) => ({ _id: p._id, name: p.name }))
    // 已经下架的赠饮商品也留着，免得保存时丢掉
    form.value.oldFree.forEach((p) => { if (!list.some((x) => x._id === p.id)) list.push({ _id: p.id, name: p.name + '（已下架）' }) })
    products.value = list
  } catch (e) {
    products.value = []
  }
}

const fen = (v) => Math.round(Number(v || 0) * 100)

async function save() {
  const f = form.value
  if (!f.name.trim()) return ElMessage.warning('请填写规则名称')
  const rule = { name: f.name, type: f.type, price: fen(f.priceYuan), desc: f.desc, sort: f.sort || 0, onShelf: f.onShelf }
  if (f.type === 'hourly') {
    Object.assign(rule, { minHours: f.minHours, maxHours: f.maxHours, graceMinutes: f.graceMinutes })
  } else {
    Object.assign(rule, {
      freeCups: f.freeCups,
      freeMaxFee: fen(f.freeMaxYuan),
      freeProducts: f.freeIds.map((id) => {
        const p = products.value.find((x) => x._id === id)
        return { id, name: p ? p.name.replace(/（已下架）$/, '') : '' }
      })
    })
  }
  if (f._id) rule._id = f._id
  saving.value = true
  try {
    await api.book('saveRule', { rule })
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
    await ElMessageBox.confirm('删除规则「' + row.name + '」？已经下的单不受影响。', '删除规则', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.book('deleteRule', { id: row._id })
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.small { font-size: 12px; }
.sep { margin: 0 8px; }
.tip { margin-top: 4px; }
</style>
