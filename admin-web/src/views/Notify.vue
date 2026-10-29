<template>
  <div class="narrow" v-loading="loading">
    <el-card shadow="never" class="block">
      <template #header>
        <div class="head">
          <span>微信通知顾客</span>
          <el-button size="small" @click="load">刷新模板</el-button>
        </div>
      </template>
      <el-alert v-if="data.templatesError" type="warning" :closable="false" show-icon class="alert" :title="data.templatesError" />
      <el-alert v-else-if="loaded && !data.templates.length" type="info" :closable="false" show-icon class="alert"
        title="公众平台「我的模板」里还没有模板，按下面的步骤先选一个，再回来点「刷新模板」。" />
      <el-form label-width="130px">
        <el-form-item label="取餐通知">
          <el-select v-model="form.orderReady" placeholder="不发" clearable style="width: 100%; max-width: 460px">
            <el-option v-for="t in data.templates" :key="t.templateId" :label="t.title + '（' + t.fields.join('、') + '）'" :value="t.templateId" />
          </el-select>
          <div class="muted hint full">顾客下单时点「允许」，店员点「制作完成」后顾客微信里收到通知。</div>
        </el-form-item>
        <el-form-item label="借书到期提醒">
          <el-select v-model="form.rentalDue" placeholder="不发" clearable style="width: 100%; max-width: 460px">
            <el-option v-for="t in data.templates" :key="t.templateId" :label="t.title + '（' + t.fields.join('、') + '）'" :value="t.templateId" />
          </el-select>
          <div class="muted hint full">按小时借书的，借书时点「允许」，到期前 {{ data.dueMinutes || 10 }} 分钟提醒还书。包天的不提醒。</div>
        </el-form-item>
        <el-form-item label="点通知打开">
          <el-radio-group v-model="form.state">
            <el-radio-button value="formal">正式版</el-radio-button>
            <el-radio-button value="trial">体验版</el-radio-button>
            <el-radio-button value="developer">开发版</el-radio-button>
          </el-radio-group>
          <div class="muted hint full">小程序还没发布时，用开发者工具「预览」扫码测试选开发版，用体验版测试选体验版；发布以后改回正式版。</div>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="block" v-for="k in kinds" :key="k.key" v-show="data[k.key]">
      <template #header>{{ k.name }}会这样填：{{ data[k.key] && data[k.key].title }}</template>
      <el-table :data="(data[k.key] && data[k.key].preview) || []" size="small">
        <el-table-column prop="label" label="模板里的字段" width="160" />
        <el-table-column prop="use" label="填什么" width="140" />
        <el-table-column prop="value" label="例子" />
      </el-table>
      <div class="tip">按字段名称自动对应。哪一项填得不合适，可以在公众平台换一个模板，或者选模板时少勾那个关键词。</div>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>怎么选模板</template>
      <ol class="steps">
        <li>小程序要先在公众平台「设置 → 基本设置 → 服务类目」里设好餐饮类目，模板库里才有餐饮相关的模板。</li>
        <li>公众平台左边菜单「订阅消息」→「公共模板库」，搜「取餐」，选一个比如「取餐提醒」，勾上取餐号、商品名称、门店名称、温馨提示这些关键词，提交。</li>
        <li>再搜「到期」或「借阅」，给借书选一个到期提醒的模板，勾上物品名称（或书名）、到期时间、温馨提示。</li>
        <li>回到这里点「刷新模板」，在上面选好，保存。</li>
      </ol>
      <div class="tip">微信规定顾客点一次「允许」只能收一条通知，所以每次下单都会问一次。顾客点了「总是保持以上选择」后就不再弹窗。公众平台的菜单和模板名称可能会调整，以实际页面为准。</div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const kinds = [
  { key: 'orderReady', name: '取餐通知' },
  { key: 'rentalDue', name: '借书到期提醒' }
]
const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)
const data = ref({ templates: [], templatesError: '', orderReady: null, rentalDue: null, state: 'formal' })
const form = ref({ orderReady: '', rentalDue: '', state: 'formal' })

function fill(res) {
  data.value = res
  form.value = {
    orderReady: res.orderReady ? res.orderReady.templateId : '',
    rentalDue: res.rentalDue ? res.rentalDue.templateId : '',
    state: res.state
  }
}

async function load() {
  loading.value = true
  try {
    fill(await api.common('getNotifySettings'))
    loaded.value = true
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    fill(await api.common('saveNotifySettings', {
      orderReady: form.value.orderReady || '',
      rentalDue: form.value.rentalDue || '',
      state: form.value.state
    }))
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.block { margin-bottom: 16px; }
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.alert { margin-bottom: 16px; }
.hint { font-size: 13px; line-height: 1.6; }
.full { width: 100%; }
.steps {
  margin: 0 0 12px;
  padding-left: 20px;
  line-height: 1.9;
}
</style>
