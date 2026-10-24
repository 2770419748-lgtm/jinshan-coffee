<template>
  <div class="narrow" v-loading="loading">
    <el-card shadow="never" class="block">
      <template #header>收款方式</template>
      <el-form label-width="130px" v-if="form">
        <el-form-item label="微信支付商户号">
          <el-input v-model="form.mchId" maxlength="12" placeholder="开通后填，8 到 12 位数字" style="width: 260px" />
        </el-form-item>
        <el-form-item label="微信支付">
          <el-switch v-model="form.payEnabled" @change="onPay" />
          <span class="muted hint">{{ form.payEnabled ? '顾客可以在小程序里直接付' : '没打开，顾客到吧台付' }}</span>
        </el-form-item>
        <el-form-item label="也能到吧台付" v-if="form.payEnabled">
          <el-switch v-model="form.allowCounter" />
          <span class="muted hint">{{ form.allowCounter ? '顾客下单时可以选到吧台付' : '只能在线付' }}</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>怎么开通微信支付</template>
      <ol class="steps">
        <li>用个体户营业执照申请微信支付商户号，在商户平台把这个小程序的 AppID 关联上。</li>
        <li>在微信开发者工具打开「云开发控制台」，在「设置」里找到微信支付配置，添加商户号；商户号管理员在微信里确认授权。</li>
        <li>回到这里填商户号、打开微信支付。自己先下一单付 1 分钱的试试，再取消这单，看钱有没有原路退回。</li>
      </ol>
      <div class="tip">控制台的菜单名称可能会调整，以实际页面为准。没打开之前，小程序照常只收吧台付款。</div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const form = ref(null)
const loading = ref(false)
const saving = ref(false)

async function load() {
  loading.value = true
  try {
    form.value = await api.common('getShopSettings')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

// 关掉微信支付时只能到吧台付款
function onPay(on) {
  if (!on) form.value.allowCounter = true
}

async function save() {
  const f = form.value
  const mchId = f.mchId.trim()
  if (mchId && !/^\d{8,12}$/.test(mchId)) return ElMessage.warning('商户号是 8 到 12 位数字')
  if (f.payEnabled && !mchId) return ElMessage.warning('打开微信支付前先填商户号')
  saving.value = true
  try {
    form.value = await api.common('saveShopSettings', { payEnabled: f.payEnabled, mchId, allowCounter: f.allowCounter })
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
.narrow { max-width: 760px; }
.block { margin-bottom: 16px; }
.hint {
  margin-left: 12px;
  font-size: 13px;
}
.steps {
  margin: 0 0 12px;
  padding-left: 20px;
  line-height: 1.9;
}
</style>
