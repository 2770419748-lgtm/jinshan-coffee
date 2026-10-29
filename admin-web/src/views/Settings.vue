<template>
  <div class="narrow" v-loading="loading">
    <el-card shadow="never" class="block" v-if="form">
      <template #header>营业时间</template>
      <el-form label-width="130px">
        <el-form-item label="开门">
          <el-time-select v-model="form.hours.open" start="00:00" step="00:15" end="23:45" :clearable="false" style="width: 140px" />
        </el-form-item>
        <el-form-item label="打烊">
          <el-time-select v-model="form.hours.close" start="00:15" step="00:15" end="23:45" :clearable="false" style="width: 140px" />
          <span class="muted hint">显示在顾客首页；预约只能约这段时间里的，每 15 分钟一档，最早 30 分钟后</span>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>收款方式</template>
      <el-form label-width="130px" v-if="form">
        <el-form-item label="微信支付商户号">
          <span v-if="form.payReady">{{ form.mchId }}</span>
          <span v-else class="muted">服务器上还没配置</span>
        </el-form-item>
        <el-form-item label="微信支付">
          <el-switch v-model="form.payEnabled" :disabled="!form.payReady && !form.payEnabled" @change="onPay" />
          <span class="muted hint">{{ form.payEnabled ? '顾客可以在小程序里直接付，也能预约' : '没打开，顾客到吧台付，不能预约' }}</span>
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
        <li>用个体户营业执照申请微信支付商户号，在商户平台「产品中心 → AppID 账号管理」里关联这个小程序的 AppID，并开通 JSAPI 支付。</li>
        <li>在商户平台「账户中心 → API 安全」里申请 API 证书、设置 APIv3 密钥。把商户号、证书序列号、证书私钥文件（apiclient_key.pem）和 APIv3 密钥填到服务器的配置文件里，重启服务器。具体步骤见代码里的 README。</li>
        <li>回到这里打开微信支付。自己先下一单付 1 分钱的试试，再取消这单，看钱有没有原路退回。</li>
      </ol>
      <div class="tip">商户平台的菜单名称可能会调整，以实际页面为准。没打开之前，小程序照常只收吧台付款。</div>
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
  if (f.hours.close <= f.hours.open) return ElMessage.warning('打烊时间要晚于开门时间')
  saving.value = true
  try {
    form.value = await api.common('saveShopSettings', { payEnabled: f.payEnabled, allowCounter: f.allowCounter, hours: f.hours })
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
