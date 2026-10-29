<template>
  <div class="narrow" v-loading="loading">
    <template v-if="form">
      <el-alert v-if="problems.length" type="warning" :closable="false" show-icon class="block" :title="'开放外送前还要填：' + problems.join('、')" />
      <el-alert v-else-if="!open" type="info" :closable="false" show-icon class="block" title="都填好了，打开下面的「开放外送」并保存，顾客就能在小程序首页点「外送」下单了" />
      <el-alert v-else type="success" :closable="false" show-icon class="block" :title="'外送已开放' + (sandbox ? '（测试版：叫的骑手都是微信的测试单，不会真的来）' : '')" />
      <el-alert v-if="storeSyncError" type="error" :closable="false" show-icon class="block" :title="'设置已保存，但没同步到微信同城配送的门店：' + storeSyncError" />

      <el-card shadow="never" class="block">
        <template #header>开放外送</template>
        <el-form label-width="150px">
          <el-form-item label="开放外送">
            <el-switch v-model="form.enabled" />
            <span class="muted hint">{{ form.enabled ? '顾客能在小程序里下外送单，送到家' : '关着时小程序首页不显示「外送」' }}</span>
          </el-form-item>
        </el-form>
        <div class="tip">外送单必须在线付款（微信支付或会员余额），付完店员才看得到；15 分钟没付自动取消。</div>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>店的地址</template>
        <el-form label-width="150px">
          <el-form-item label="店名">
            <el-input v-model="form.store.name" maxlength="20" placeholder="骑手看到的店名，比如：进山咖啡" />
          </el-form-item>
          <el-form-item label="省 / 市 / 区县">
            <div class="loc">
              <el-input v-model="form.store.province" maxlength="10" placeholder="四川省" />
              <el-input v-model="form.store.city" maxlength="10" placeholder="内江市" />
              <el-input v-model="form.store.area" maxlength="10" placeholder="东兴区" />
            </div>
          </el-form-item>
          <el-form-item label="街道">
            <el-input v-model="form.store.street" maxlength="20" placeholder="选填，比如：东兴街道" />
          </el-form-item>
          <el-form-item label="详细地址">
            <el-input v-model="form.store.house" maxlength="40" placeholder="路名门牌号，骑手按这个来取货" />
          </el-form-item>
          <el-form-item label="店里电话">
            <el-input v-model="form.store.phone" maxlength="20" placeholder="顾客、骑手有事打这个电话" />
          </el-form-item>
          <el-form-item label="店的位置">
            <div class="loc">
              <el-input v-model="form.lat" placeholder="纬度，比如 29.58" @input="pasteLocation" />
              <el-input v-model="form.lng" placeholder="经度，比如 105.07" />
            </div>
            <div class="muted hint full">
              算配送距离用。打开 <a href="https://lbs.qq.com/getPoint/" target="_blank" rel="noopener">腾讯地图坐标拾取器</a>，搜店名、点一下店的位置，把坐标整个粘到「纬度」框里（前面是纬度、后面是经度，会自动分开）。
              要用腾讯地图的坐标，和小程序里顾客选地址用的是同一套；百度地图的坐标会差几百米。
            </div>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>外送时间和范围</template>
        <el-form label-width="150px">
          <el-form-item label="外送时间">
            <el-time-picker v-model="form.open" format="HH:mm" value-format="HH:mm" placeholder="开始" style="width: 120px" />
            <span class="sep">到</span>
            <el-time-picker v-model="form.close" format="HH:mm" value-format="HH:mm" placeholder="结束" style="width: 120px" />
            <span class="muted hint" v-if="shopHours">不填就按店铺营业时间 {{ shopHours.open }}–{{ shopHours.close }}</span>
          </el-form-item>
          <el-form-item label="配送范围（公里）">
            <el-input-number v-model="form.radiusKm" :min="0.1" :max="50" :precision="1" :step="1" :value-on-clear="null" />
            <span class="muted hint">按直线距离算，超出的地址下不了单</span>
          </el-form-item>
          <el-form-item label="预计多久送到">
            <el-input-number v-model="form.etaMinutes" :min="5" :max="240" :step="5" :value-on-clear="null" />
            <span class="muted hint">分钟，选填，结算页给顾客看</span>
          </el-form-item>
          <el-form-item label="外送须知">
            <el-input v-model="form.notice" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="选填，结算页给顾客看，比如：超出范围可以到店自取" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>起送价和配送费（顾客付）</template>
        <el-form label-width="150px">
          <el-form-item label="起送价（元）">
            <el-input-number v-model="form.minOrder" :min="0" :max="1000" :precision="2" :step="5" :value-on-clear="null" />
            <span class="muted hint">商品满多少才送，不限填 0</span>
          </el-form-item>
          <el-form-item label="配送费（元）">
            <el-input-number v-model="form.baseFee" :min="0" :max="1000" :precision="2" :step="1" :value-on-clear="null" />
            <span class="muted hint">起步距离以内收这么多，不收填 0</span>
          </el-form-item>
          <el-form-item label="起步距离（公里）">
            <el-input-number v-model="form.baseKm" :min="0" :max="50" :precision="1" :step="1" :value-on-clear="null" />
            <span class="muted hint">超出这个距离才按公里加收</span>
          </el-form-item>
          <el-form-item label="超出每公里加（元）">
            <el-input-number v-model="form.perKmFee" :min="0" :max="1000" :precision="2" :step="1" :value-on-clear="null" />
            <span class="muted hint">不加收填 0；不足 1 公里按 1 公里算</span>
          </el-form-item>
          <el-form-item label="满多少免配送费">
            <el-input-number v-model="form.freeAbove" :min="0" :max="1000" :precision="2" :step="10" :value-on-clear="null" />
            <span class="muted hint">元，按商品金额算；不免填 0</span>
          </el-form-item>
          <el-form-item label="顾客看到的">
            <span>{{ ruleText }}</span>
          </el-form-item>
        </el-form>
        <div class="tip">顾客付的配送费是店里自己定的；用第三方配送时，配送公司按它的实时报价从门店的运费余额里扣，两笔在「每日汇总」里分开记。</div>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>谁来送</template>
        <el-form label-width="150px">
          <el-form-item label="配送方式">
            <el-radio-group v-model="form.provider">
              <el-radio value="self">店员自己送</el-radio>
              <el-radio value="wechat">微信同城配送（顺丰同城、达达）</el-radio>
            </el-radio-group>
            <div class="muted hint full">不管选哪个，订单页都能点「店员送出」，叫不到骑手时自己送。</div>
          </el-form-item>
          <template v-if="form.provider === 'wechat'">
            <el-form-item label="自动叫骑手">
              <el-switch v-model="form.autoCall" />
              <span class="muted hint">{{ form.autoCall ? '点「开始制作」时自动叫骑手' : '关着时在订单页手动点「叫骑手」' }}</span>
            </el-form-item>
            <el-form-item label="派单方式">
              <el-radio-group v-model="form.wechatPattern">
                <el-radio value="price">价格优先（比价后发给便宜的那家）</el-radio>
                <el-radio value="prefer">优先用指定的那家</el-radio>
              </el-radio-group>
              <el-select v-if="form.wechatPattern === 'prefer'" v-model="form.wechatPrefer" placeholder="选一家" style="width: 140px; margin-top: 8px">
                <el-option v-for="c in carrierList" :key="c.id" :label="c.name" :value="c.id" />
              </el-select>
              <div class="muted hint full">一单只发给一家配送公司，不会几家同时来抢；叫不到再手动重新叫。</div>
            </el-form-item>
          </template>
        </el-form>
      </el-card>

      <div class="actions">
        <el-button type="primary" size="large" :loading="saving" @click="save">保存设置</el-button>
      </div>

      <el-card shadow="never" class="block" v-if="form.provider === 'wechat'">
        <template #header>微信同城配送</template>
        <el-form label-width="150px">
          <el-form-item label="服务器密钥">
            <span v-if="wechat.ready" class="ok">已配置{{ wechat.sandbox ? '（测试版，用微信的测试环境）' : '' }}</span>
            <span v-else class="muted">还没配置。要先在小程序后台开通同城配送、生成 API 安全密钥，再填到服务器的配置文件里，见说明文档「外送配送」。</span>
          </el-form-item>
          <el-form-item label="配送状态推送">
            <span v-if="wechat.notify" class="ok">已打开，骑手接单、取货、送达马上更新</span>
            <span v-else class="muted">没打开（要 HTTPS 域名），服务器每分钟查一次进度</span>
          </el-form-item>
          <el-form-item label="门店">
            <span v-if="storeId">已开通，门店编号 {{ storeId }}</span>
            <span v-else class="muted">还没开通</span>
            <el-button class="sep" :disabled="!wechat.ready" :loading="busy === 'store'" @click="setupStore">{{ storeId ? '按上面的设置更新门店' : '开通门店' }}</el-button>
            <div class="muted hint full">用上面填的店名、地址、电话、位置和派单方式开通（先保存设置）。开通后改了这些，保存时会自动同步过去。</div>
          </el-form-item>
          <template v-if="storeId">
            <el-form-item label="运费余额">
              <el-button :loading="busy === 'balance'" @click="loadBalance">查余额</el-button>
              <div class="full" v-if="balances">
                <div v-for="b in balances" :key="b.carrier">{{ b.carrierName }}：<b>¥{{ yuan(b.balance) }}</b></div>
                <div v-if="!balances.length" class="muted">还没有充过</div>
              </div>
              <div class="muted hint full">运费要先给每家配送公司分别预充值，叫骑手时按实时报价扣；50 元起充，充的钱一个月内有效，没用完原路退回。</div>
            </el-form-item>
            <el-form-item label="充运费">
              <el-select v-model="chargeCarrier" placeholder="给哪家充" style="width: 140px">
                <el-option v-for="c in carrierList" :key="c.id" :label="c.name" :value="c.id" />
              </el-select>
              <el-input-number v-model="chargeYuan" :min="50" :max="10000" :step="50" class="sep" />
              <span class="sep">元</span>
              <el-button type="primary" class="sep" :loading="busy === 'charge'" @click="charge">生成付款码</el-button>
              <div class="full charge" v-if="chargeQr">
                <img :src="chargeQr" alt="充值付款码" />
                <div class="muted">用微信扫这个码付款，付完点「查余额」看到账没有。</div>
              </div>
            </el-form-item>
          </template>
        </el-form>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { api } from '../api'
import { yuan } from '../format'

const FEES = ['minOrder', 'baseFee', 'perKmFee', 'freeAbove']
const NUMBERS = ['radiusKm', 'baseKm', 'etaMinutes']
// 微信同城配送这边可选的两家（同一个门店可以都充值）
const CARRIERS = ['SFTC', 'DADA']

const loading = ref(false)
const saving = ref(false)
const busy = ref('')
const form = ref(null)
const problems = ref([])
const open = ref(false)
const shopHours = ref(null)
const storeId = ref('')
const storeSyncError = ref('')
const wechat = ref({ ready: false, sandbox: false, notify: false, carriers: {} })
const balances = ref(null)
const chargeCarrier = ref('')
const chargeYuan = ref(100)
const chargeQr = ref('')

const sandbox = computed(() => form.value && form.value.provider === 'wechat' && wechat.value.sandbox)
const carrierList = computed(() => CARRIERS.map((id) => ({ id, name: wechat.value.carriers[id] || id })))

const toYuan = (fen) => (fen === null || fen === undefined ? null : fen / 100)
const toFen = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100))

// 顾客在结算页看到的配送费规则（和小程序里的写法一样）
const ruleText = computed(() => {
  const f = form.value
  if (f.baseFee === null || f.radiusKm === null) return '（填好配送费和范围后显示）'
  const parts = []
  if (!f.baseFee && !f.perKmFee) parts.push('免配送费')
  else if (f.perKmFee && f.baseKm) parts.push(f.baseKm + ' 公里内' + (f.baseFee ? ' ' + f.baseFee + ' 元' : '免费') + '，超出每公里加 ' + f.perKmFee + ' 元')
  else if (f.perKmFee) parts.push((f.baseFee ? '起步 ' + f.baseFee + ' 元，' : '') + '每公里 ' + f.perKmFee + ' 元')
  else parts.push('配送费 ' + f.baseFee + ' 元')
  if (f.freeAbove && (f.baseFee || f.perKmFee)) parts.push('商品满 ' + f.freeAbove + ' 元免配送费')
  parts.push('送 ' + f.radiusKm + ' 公里内')
  if (f.minOrder) parts.push(f.minOrder + ' 元起送')
  return parts.join('；')
})

// 服务器给的设置 → 表单（钱换成元，没填的是空）
function fill(res) {
  const s = res.settings
  const f = {
    enabled: s.enabled,
    store: Object.assign({}, s.store),
    lat: s.location ? String(s.location.lat) : '',
    lng: s.location ? String(s.location.lng) : '',
    open: s.hours ? s.hours.open : '',
    close: s.hours ? s.hours.close : '',
    notice: s.notice,
    provider: s.provider,
    autoCall: s.autoCall,
    wechatPattern: s.wechatPattern,
    wechatPrefer: s.wechatPrefer
  }
  NUMBERS.forEach((k) => { f[k] = s[k] === null || s[k] === undefined ? null : s[k] })
  FEES.forEach((k) => { f[k] = toYuan(s[k]) })
  form.value = f
  problems.value = res.problems
  open.value = res.open
  // 没单独设外送时间时，用的就是店铺营业时间
  shopHours.value = s.hours ? null : res.hours
  storeId.value = s.wechatStoreId
  storeSyncError.value = res.storeSyncError || ''
  wechat.value = res.wechat
}

async function load() {
  loading.value = true
  try {
    fill(await api.coffee('getDeliverySettings'))
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
  if ((f.open && !f.close) || (!f.open && f.close)) return ElMessage.warning('外送时间开始、结束都要填')
  if ((f.lat && !f.lng) || (!f.lat && f.lng)) return ElMessage.warning('店的位置纬度、经度都要填')
  const settings = {
    enabled: f.enabled,
    store: f.store,
    location: f.lat ? { lat: f.lat, lng: f.lng } : null,
    hours: f.open ? { open: f.open, close: f.close } : null,
    notice: f.notice,
    provider: f.provider,
    autoCall: f.autoCall,
    wechatPattern: f.wechatPattern,
    wechatPrefer: f.wechatPattern === 'prefer' ? f.wechatPrefer : ''
  }
  NUMBERS.forEach((k) => { settings[k] = f[k] })
  FEES.forEach((k) => { settings[k] = toFen(f[k]) })
  saving.value = true
  try {
    fill(await api.coffee('saveDeliverySettings', { settings }))
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function setupStore() {
  busy.value = 'store'
  try {
    fill(await api.coffee('setupWechatStore'))
    ElMessage.success('门店已开通')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = ''
  }
}

async function loadBalance() {
  busy.value = 'balance'
  try {
    balances.value = await api.coffee('courierBalance')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = ''
  }
}

async function charge() {
  if (!chargeCarrier.value) return ElMessage.warning('先选给哪家配送公司充')
  busy.value = 'charge'
  chargeQr.value = ''
  try {
    const { payurl } = await api.coffee('courierCharge', { carrier: chargeCarrier.value, amount: Math.round(chargeYuan.value * 100) })
    chargeQr.value = await QRCode.toDataURL(payurl, { width: 220, margin: 1 })
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<style scoped>
.block { margin-bottom: 16px; }
.hint { margin-left: 10px; font-size: 12px; }
.hint.full { margin-left: 0; width: 100%; line-height: 1.7; margin-top: 4px; }
.hint a { color: var(--el-color-primary); }
.sep { margin-left: 8px; }
.loc { display: flex; gap: 8px; width: 100%; }
.loc .el-input { max-width: 200px; }
.full { width: 100%; margin-top: 6px; }
.ok { color: var(--el-color-success); }
.charge img { width: 220px; height: 220px; display: block; margin-bottom: 6px; }
.actions { margin: 8px 0 24px; }
</style>
