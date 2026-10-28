<template>
  <div class="narrow" v-loading="loading">
    <template v-if="form">
      <el-alert v-if="problems.length" type="warning" :closable="false" show-icon class="block" :title="'开放预约前还要填：' + problems.join('、')" />
      <el-alert v-else-if="!open" type="info" :closable="false" show-icon class="block" title="都填好了，打开下面的「开放预约」并保存，顾客就能在洗车小程序里预约了" />
      <el-alert v-else type="success" :closable="false" show-icon class="block" title="预约已开放" />

      <el-card shadow="never" class="block">
        <template #header>开放预约</template>
        <el-form label-width="150px">
          <el-form-item label="开放预约">
            <el-switch v-model="form.bookingEnabled" />
            <span class="muted hint">{{ form.bookingEnabled ? '顾客能在小程序里预约' : '关着时顾客只能看项目和价格，约不了' }}</span>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>店铺信息</template>
        <el-form label-width="150px">
          <el-form-item label="店名">
            <el-input v-model="form.shopName" maxlength="20" placeholder="比如：黑镜车体护理车房" />
          </el-form-item>
          <el-form-item label="地址">
            <el-input v-model="form.address" maxlength="60" placeholder="显示在小程序首页，顾客点了能导航" />
          </el-form-item>
          <el-form-item label="电话">
            <el-input v-model="form.phone" maxlength="20" placeholder="顾客取消、改约时打这个电话" />
          </el-form-item>
          <el-form-item label="店的位置">
            <div class="loc">
              <el-input v-model="form.lat" placeholder="纬度，比如 30.657" @input="pasteLocation" />
              <el-input v-model="form.lng" placeholder="经度，比如 104.066" />
            </div>
            <div class="muted hint full">
              算上门距离用。打开 <a href="https://lbs.qq.com/getPoint/" target="_blank" rel="noopener">腾讯地图坐标拾取器</a>，搜店名、点一下店的位置，把坐标整个粘到「纬度」框里（前面是纬度、后面是经度，会自动分开）。
              要用腾讯地图的坐标，和小程序里顾客选地址用的是同一套；百度地图的坐标会差几百米。
            </div>
          </el-form-item>
          <el-form-item label="预约须知">
            <el-input v-model="form.notice" type="textarea" :rows="3" maxlength="300" show-word-limit placeholder="显示在预约页，比如：请提前清空车内贵重物品；上门服务需要有水源和车位" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>预约时段和名额</template>
        <el-form label-width="150px">
          <el-form-item label="营业时间">
            <el-time-picker v-model="form.open" format="HH:mm" value-format="HH:mm" placeholder="开门" style="width: 120px" />
            <span class="sep">到</span>
            <el-time-picker v-model="form.close" format="HH:mm" value-format="HH:mm" placeholder="打烊" style="width: 120px" />
          </el-form-item>
          <el-form-item label="每段多长（分钟）">
            <el-input-number v-model="form.slotMinutes" :min="10" :max="480" :step="10" :value-on-clear="null" placeholder="比如 60" />
            <span class="muted hint">一天按这个长度切成一段一段让顾客选</span>
          </el-form-item>
          <el-form-item label="到店每段接几单">
            <el-input-number v-model="form.storeCapacity" :min="0" :max="99" :value-on-clear="null" />
            <span class="muted hint">一般是洗车位个数；不做到店填 0</span>
          </el-form-item>
          <el-form-item label="上门每段接几单">
            <el-input-number v-model="form.doorCapacity" :min="0" :max="99" :value-on-clear="null" />
            <span class="muted hint">一般是能出门的技师人数；不做上门填 0</span>
          </el-form-item>
          <el-form-item label="能约几天内">
            <el-input-number v-model="form.bookDays" :min="1" :max="60" :value-on-clear="null" />
            <span class="muted hint">1 就是只能约今天</span>
          </el-form-item>
          <el-form-item label="至少提前（分钟）">
            <el-input-number v-model="form.leadMinutes" :min="0" :max="10080" :step="30" :value-on-clear="null" />
            <span class="muted hint">离开始不到这么久的时段就约不了了</span>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>上门服务</template>
        <div class="tip" v-if="!(form.doorCapacity > 0)">「上门每段接几单」是 0 时不做上门，下面可以先不填。</div>
        <el-form label-width="150px">
          <el-form-item label="服务半径（公里）">
            <el-input-number v-model="form.doorRadiusKm" :min="0.1" :max="200" :precision="1" :step="1" :value-on-clear="null" />
            <span class="muted hint">按直线距离算</span>
          </el-form-item>
          <el-form-item label="上门费（元）">
            <el-input-number v-model="form.doorFee" :min="0" :max="10000" :precision="2" :step="5" :value-on-clear="null" />
            <span class="muted hint">不收填 0</span>
          </el-form-item>
          <el-form-item label="超出半径">
            <el-radio-group v-model="form.outOfRange">
              <el-radio value="reject">不接，让顾客选到店</el-radio>
              <el-radio value="fee">接，另外加收</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="超出加收（元）" v-if="form.outOfRange === 'fee'">
            <el-input-number v-model="form.outOfRangeFee" :min="0" :max="10000" :precision="2" :step="5" :value-on-clear="null" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>取消和完成</template>
        <el-form label-width="150px">
          <el-form-item label="免费取消（分钟）">
            <el-input-number v-model="form.freeCancelMinutes" :min="0" :max="10080" :step="30" :value-on-clear="null" />
            <span class="muted hint">开始前这么久以前取消，钱和次卡全退</span>
          </el-form-item>
          <el-form-item label="之后再取消">
            <el-radio-group v-model="form.lateCancel">
              <el-radio value="deny">不能在线取消，打电话</el-radio>
              <el-radio value="fee">能取消，扣一笔钱</el-radio>
              <el-radio value="free">照样全退</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="扣多少（元）" v-if="form.lateCancel === 'fee'">
            <el-input-number v-model="form.lateCancelFee" :min="0" :max="10000" :precision="2" :step="5" :value-on-clear="null" />
            <span class="muted hint">用次卡的单扣掉那 1 次</span>
          </el-form-item>
          <el-form-item label="自动确认（小时）">
            <el-input-number v-model="form.autoConfirmHours" :min="1" :max="720" :value-on-clear="null" />
            <span class="muted hint">技师点完成后，顾客这么久没确认就自动算完成</span>
          </el-form-item>
        </el-form>
        <div class="tip">技师出发以后顾客不能在线取消，要打电话给店里，由店长在「预约订单」里取消（全额退）。</div>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>付款方式</template>
        <el-form label-width="150px">
          <el-form-item label="洗车商户号">
            <span v-if="payReady">{{ mchId }}</span>
            <span v-else class="muted">服务器上还没配置（洗车和咖啡的执照不同，要单独申请商户号）</span>
          </el-form-item>
          <el-form-item label="微信支付">
            <el-switch v-model="form.payEnabled" :disabled="!payReady && !form.payEnabled" />
            <span class="muted hint">顾客预约时在线付，15 分钟内不付自动取消</span>
          </el-form-item>
          <el-form-item label="到店付款">
            <el-switch v-model="form.payLater" />
            <span class="muted hint">顾客先约，洗完由技师收钱（现金、收款码）后在小程序里登记</span>
          </el-form-item>
          <el-form-item label="会员余额">
            <span :class="memberEnabled ? 'ok' : 'muted'">{{ memberEnabled ? '已打开' : '没打开' }}</span>
            <span class="muted hint">在「储值和次卡」里开关</span>
          </el-form-item>
        </el-form>
      </el-card>

      <div class="actions">
        <el-button type="primary" size="large" :loading="saving" @click="save">保存设置</el-button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const FEES = ['doorFee', 'outOfRangeFee', 'lateCancelFee']
const NUMBERS = ['slotMinutes', 'storeCapacity', 'doorCapacity', 'bookDays', 'leadMinutes', 'doorRadiusKm', 'freeCancelMinutes', 'autoConfirmHours']

const loading = ref(false)
const saving = ref(false)
const form = ref(null)
const problems = ref([])
const open = ref(false)
const payReady = ref(false)
const mchId = ref('')
const memberEnabled = ref(false)

const toYuan = (fen) => (fen === null || fen === undefined ? null : fen / 100)
const toFen = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100))

// 服务器给的设置 → 表单（钱换成元，没填的是空）
function fill(res) {
  const s = res.settings
  const f = {
    shopName: s.shopName,
    address: s.address,
    phone: s.phone,
    lat: s.location ? String(s.location.lat) : '',
    lng: s.location ? String(s.location.lng) : '',
    notice: s.notice,
    bookingEnabled: s.bookingEnabled,
    payEnabled: s.payEnabled,
    payLater: s.payLater,
    open: s.hours ? s.hours.open : '',
    close: s.hours ? s.hours.close : '',
    outOfRange: s.outOfRange || '',
    lateCancel: s.lateCancel || ''
  }
  NUMBERS.forEach((k) => { f[k] = s[k] === null || s[k] === undefined ? null : s[k] })
  FEES.forEach((k) => { f[k] = toYuan(s[k]) })
  form.value = f
  problems.value = res.problems
  open.value = res.open
  payReady.value = res.payReady
  mchId.value = res.mchId
  memberEnabled.value = res.memberEnabled
}

async function load() {
  loading.value = true
  try {
    fill(await api.carwash('getSettings'))
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

// 从腾讯地图复制来的「纬度,经度」整个粘进纬度框时自动分开
function pasteLocation(value) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value || '')
  if (m) {
    form.value.lat = m[1]
    form.value.lng = m[2]
  }
}

async function save() {
  const f = form.value
  if ((f.open && !f.close) || (!f.open && f.close)) return ElMessage.warning('营业时间开门、打烊都要填')
  if ((f.lat && !f.lng) || (!f.lat && f.lng)) return ElMessage.warning('店的位置纬度、经度都要填')
  const settings = {
    shopName: f.shopName,
    address: f.address,
    phone: f.phone,
    location: f.lat ? { lat: f.lat, lng: f.lng } : null,
    notice: f.notice,
    bookingEnabled: f.bookingEnabled,
    payEnabled: f.payEnabled,
    payLater: f.payLater,
    hours: f.open ? { open: f.open, close: f.close } : null,
    outOfRange: f.outOfRange || null,
    lateCancel: f.lateCancel || null
  }
  NUMBERS.forEach((k) => { settings[k] = f[k] })
  FEES.forEach((k) => { settings[k] = toFen(f[k]) })
  saving.value = true
  try {
    fill(await api.carwash('saveSettings', { settings }))
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
.hint { margin-left: 10px; font-size: 12px; }
.hint.full { margin-left: 0; width: 100%; line-height: 1.7; margin-top: 4px; }
.hint a { color: var(--el-color-primary); }
.sep { margin: 0 8px; color: var(--el-text-color-secondary); }
.loc { display: flex; gap: 8px; width: 100%; }
.loc .el-input { max-width: 200px; }
.actions { margin: 8px 0 24px; }
</style>
