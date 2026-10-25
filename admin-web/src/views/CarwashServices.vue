<template>
  <div>
    <div class="toolbar">
      <span class="tip">顾客在洗车小程序首页看到的项目和价格。会员价只给会员期内的顾客；价格都在服务器上按这里算。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openEdit(null)">新增项目</el-button>
    </div>
    <el-table :data="list" v-loading="loading" row-key="_id" empty-text="还没有服务项目，新增一个，比如「标准洗车」">
      <el-table-column label="顺序" width="90">
        <template #default="{ $index }">
          <el-button size="small" link :disabled="$index === 0" @click="move($index, -1)">↑</el-button>
          <el-button size="small" link :disabled="$index === list.length - 1" @click="move($index, 1)">↓</el-button>
        </template>
      </el-table-column>
      <el-table-column label="图" width="76">
        <template #default="{ row }"><div class="thumb"><CloudImage :src="row.image" :text="row.name" /></div></template>
      </el-table-column>
      <el-table-column label="项目" min-width="160">
        <template #default="{ row }">
          <div>{{ row.name }}</div>
          <div class="muted small" v-if="row.desc">{{ row.desc }}</div>
        </template>
      </el-table-column>
      <el-table-column label="价格" width="100">
        <template #default="{ row }"><span class="gold">¥{{ yuan(row.price) }}</span></template>
      </el-table-column>
      <el-table-column label="会员价" width="100">
        <template #default="{ row }">
          <span v-if="row.memberPrice !== null && row.memberPrice !== undefined">¥{{ yuan(row.memberPrice) }}</span>
          <span v-else class="muted">没有</span>
        </template>
      </el-table-column>
      <el-table-column label="大约" width="90">
        <template #default="{ row }">{{ row.minutes ? minutes(row.minutes) : '' }}</template>
      </el-table-column>
      <el-table-column label="方式" width="110">
        <template #default="{ row }">{{ (row.modes || []).map((m) => CW_MODE[m]).join('、') }}</template>
      </el-table-column>
      <el-table-column label="上架" width="80">
        <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(v) => setEnabled(row, v)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="form._id ? '编辑项目' : '新增项目'" width="520px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="名称" required><el-input v-model="form.name" maxlength="20" placeholder="比如：标准洗车、精洗、打蜡" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.desc" maxlength="60" placeholder="选填，比如：外观泡沫洗 + 轮毂 + 内饰吸尘" /></el-form-item>
        <el-form-item label="图片"><ImageUpload v-model="form.image" dir="carwash" /></el-form-item>
        <el-form-item label="价格（元）" required>
          <el-input-number v-model="form.priceYuan" :min="0.01" :max="10000" :precision="2" :step="10" />
        </el-form-item>
        <el-form-item label="会员价（元）">
          <el-input-number v-model="form.memberYuan" :min="0" :max="10000" :precision="2" :step="10" :value-on-clear="null" />
          <span class="muted small sep">没有会员价就空着</span>
        </el-form-item>
        <el-form-item label="大约多久">
          <el-input-number v-model="form.minutes" :min="1" :max="1440" :step="10" :value-on-clear="null" />
          <span class="muted small sep">分钟，只是给顾客看，不想写就空着</span>
        </el-form-item>
        <el-form-item label="怎么做" required>
          <el-checkbox-group v-model="form.modes">
            <el-checkbox value="store">到店</el-checkbox>
            <el-checkbox value="door">上门</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="上架"><el-switch v-model="form.enabled" /></el-form-item>
      </el-form>
      <div class="tip">改价格只影响以后的预约，已经约了的单按下单时的价格。</div>
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
import { yuan, minutes, CW_MODE } from '../format'
import CloudImage from '../components/CloudImage.vue'
import ImageUpload from '../components/ImageUpload.vue'

const list = ref([])
const loading = ref(false)
const saving = ref(false)
const dialog = ref(false)
const form = ref({})

const fen = (v) => Math.round(Number(v || 0) * 100)

async function load() {
  loading.value = true
  try {
    list.value = await api.carwash('adminListServices')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function openEdit(row) {
  const s = row || { name: '', desc: '', image: '', price: null, memberPrice: null, minutes: null, modes: ['store'], enabled: true }
  form.value = {
    _id: s._id,
    name: s.name,
    desc: s.desc || '',
    image: s.image || '',
    priceYuan: s.price ? s.price / 100 : undefined,
    memberYuan: s.memberPrice === null || s.memberPrice === undefined ? null : s.memberPrice / 100,
    minutes: s.minutes || null,
    modes: (s.modes || []).slice(),
    enabled: s.enabled !== false
  }
  dialog.value = true
}

async function save() {
  const f = form.value
  if (!f.name.trim()) return ElMessage.warning('请填项目名称')
  if (!f.priceYuan) return ElMessage.warning('请填价格')
  if (!f.modes.length) return ElMessage.warning('请选到店还是上门')
  const service = {
    name: f.name.trim(),
    desc: f.desc.trim(),
    image: f.image,
    price: fen(f.priceYuan),
    memberPrice: f.memberYuan === null || f.memberYuan === undefined ? null : fen(f.memberYuan),
    minutes: f.minutes || null,
    modes: f.modes,
    enabled: f.enabled
  }
  if (f._id) service._id = f._id
  saving.value = true
  try {
    await api.carwash('saveService', { service })
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
    await api.carwash('setServiceFlags', { id: row._id, enabled: value })
  } catch (e) {
    row.enabled = !value
    ElMessage.error(e.message)
  }
}

async function move(index, delta) {
  const next = list.value.slice()
  const [item] = next.splice(index, 1)
  next.splice(index + delta, 0, item)
  list.value = next
  try {
    await api.carwash('sortServices', { ids: next.map((s) => s._id) })
  } catch (e) {
    ElMessage.error(e.message)
    load()
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('删除「' + row.name + '」？已经约了的单不受影响。只是暂停的话，关掉「上架」就好。', '删除项目', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.carwash('deleteService', { id: row._id })
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.thumb { width: 52px; height: 52px; }
.small { font-size: 12px; }
.sep { margin-left: 10px; }
</style>
