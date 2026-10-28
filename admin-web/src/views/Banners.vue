<template>
  <div>
    <div class="toolbar">
      <span class="tip">顾客首页顶部轮流播放，按这里的顺序。一张都没配的时候，自动放最近上架的商品和书。图片建议 750×400。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openEdit(null)">新增轮播</el-button>
    </div>

    <el-table :data="banners" v-loading="loading" row-key="_id" empty-text="还没配轮播，现在首页自动放最近上架的商品和书">
      <el-table-column label="预览" width="190">
        <template #default="{ row }">
          <div class="thumb" :class="{ off: !row.enabled }">
            <CloudImage :src="row.preview ? row.preview.image : row.image" text="进山" />
          </div>
        </template>
      </el-table-column>
      <el-table-column label="点开去哪" width="190">
        <template #default="{ row }">
          <el-tag size="small">{{ KINDS[row.kind] }}</el-tag>
          <span v-if="row.targetName" class="target">{{ row.targetName }}</span>
          <div v-if="row.broken" class="danger small">{{ row.kind === 'book' ? '书' : '商品' }}已下架，顾客看不到</div>
        </template>
      </el-table-column>
      <el-table-column label="文字" min-width="200">
        <template #default="{ row }">
          <div>{{ row.preview ? row.preview.title : row.title }}</div>
          <div class="muted small">{{ row.preview ? row.preview.subtitle : row.subtitle }}</div>
        </template>
      </el-table-column>
      <el-table-column label="显示" width="80">
        <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(v) => setEnabled(row, v)" /></template>
      </el-table-column>
      <el-table-column label="顺序" width="100">
        <template #default="{ $index }">
          <el-button size="small" link :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
          <el-button size="small" link :disabled="$index === banners.length - 1" @click="move($index, 1)">下移</el-button>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="form._id ? '编辑轮播' : '新增轮播'" width="620px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="点开去哪">
          <el-radio-group v-model="form.kind" @change="form.targetId = ''">
            <el-radio-button v-for="(name, key) in KINDS" :key="key" :value="key">{{ name }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.kind === 'product' || form.kind === 'book'" :label="form.kind === 'product' ? '哪个商品' : '哪本书'" required>
          <el-select v-model="form.targetId" filterable :placeholder="targets.length ? '选一个' : '还没有上架的'" style="width: 100%">
            <el-option v-for="t in targets" :key="t._id" :label="t.name" :value="t._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="图片">
          <div>
            <ImageUpload v-model="form.image" dir="banners" :width="300" :height="160" />
            <div class="muted small" v-if="!form.image && fallback">不传图就用{{ form.kind === 'book' ? '书封面' : '商品图' }}</div>
          </div>
        </el-form-item>
        <el-form-item label="大标题"><el-input v-model="form.title" maxlength="16" show-word-limit :placeholder="HINTS[form.kind][0]" /></el-form-item>
        <el-form-item label="小字"><el-input v-model="form.subtitle" maxlength="24" show-word-limit :placeholder="HINTS[form.kind][1]" /></el-form-item>
        <el-form-item label="显示"><el-switch v-model="form.enabled" /></el-form-item>
      </el-form>
      <div class="tip">商品或书下架以后，这张轮播会自动不显示，重新上架又会出来。</div>
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
import CloudImage from '../components/CloudImage.vue'
import ImageUpload from '../components/ImageUpload.vue'

const KINDS = { product: '商品', book: '书', coupons: '领券中心', none: '只放图片' }
const HINTS = {
  product: ['不填用商品名', '不填显示「新品上市」'],
  book: ['不填用书名', '不填显示「新书上架」'],
  coupons: ['不填显示「领券中心」', '不填显示「代金券限时领取」'],
  none: ['选填', '选填']
}

const banners = ref([])
const options = ref({ products: [], books: [] })
const loading = ref(false)
const dialog = ref(false)
const saving = ref(false)
const form = ref({ kind: 'product' })

const targets = computed(() => (form.value.kind === 'book' ? options.value.books : form.value.kind === 'product' ? options.value.products : []))
const fallback = computed(() => {
  const t = targets.value.find((x) => x._id === form.value.targetId)
  return t ? t.image : ''
})

async function load() {
  loading.value = true
  try {
    banners.value = await api.common('listBanners')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function setEnabled(row, value) {
  row.enabled = value
  try {
    await api.common('setBannerFlags', { id: row._id, enabled: value })
    load()
  } catch (e) {
    row.enabled = !value
    ElMessage.error(e.message)
  }
}

async function move(index, delta) {
  const list = banners.value.slice()
  const [item] = list.splice(index, 1)
  list.splice(index + delta, 0, item)
  banners.value = list
  try {
    await api.common('sortBanners', { ids: list.map((b) => b._id) })
  } catch (e) {
    ElMessage.error(e.message)
    load()
  }
}

async function openEdit(row) {
  const b = row || { kind: 'product', targetId: '', image: '', title: '', subtitle: '', enabled: true }
  form.value = { _id: b._id, kind: b.kind, targetId: b.targetId || '', image: b.image || '', title: b.title || '', subtitle: b.subtitle || '', enabled: b.enabled !== false }
  dialog.value = true
  try {
    const opts = await api.common('bannerOptions')
    // 指向的商品或书已经下架了，也放进列表，免得保存时丢掉
    if (row && row.targetId) {
      const list = row.kind === 'book' ? opts.books : opts.products
      if (list && !list.some((x) => x._id === row.targetId)) list.push({ _id: row.targetId, name: (row.targetName || '原来选的') + '（已下架）', image: '' })
    }
    options.value = opts
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function save() {
  const f = form.value
  if ((f.kind === 'product' || f.kind === 'book') && !f.targetId) return ElMessage.warning(f.kind === 'product' ? '请选择一个商品' : '请选择一本书')
  if (f.kind === 'none' && !f.image) return ElMessage.warning('只放图片的轮播要上传一张图')
  const banner = { kind: f.kind, targetId: f.targetId, image: f.image, title: f.title.trim(), subtitle: f.subtitle.trim(), enabled: f.enabled }
  if (f._id) banner._id = f._id
  saving.value = true
  try {
    await api.common('saveBanner', { banner })
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
    await ElMessageBox.confirm('删除这张轮播？只是暂时不想放的话，关掉「显示」就好。', '删除轮播', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.common('deleteBanner', { id: row._id })
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.thumb {
  width: 160px;
  height: 85px;
}
.thumb.off { opacity: 0.4; }
.target { margin-left: 6px; }
.small { font-size: 12px; }
.danger { color: var(--el-color-danger); }
.tip { margin-top: 4px; }
</style>
