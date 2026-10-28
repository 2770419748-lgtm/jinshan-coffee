<template>
  <div>
    <div class="cards" v-if="stats">
      <div class="stat primary">
        <div class="label">顾客手里的星星</div>
        <div class="value">{{ stats.stars }} 颗</div>
        <div class="sub">{{ stats.holders }} 位顾客有星</div>
      </div>
      <div class="stat">
        <div class="label">累计发出</div>
        <div class="value">{{ stats.earned }} 颗</div>
        <div class="sub">消费得的，加上店主补的</div>
      </div>
      <div class="stat">
        <div class="label">累计换掉</div>
        <div class="value">{{ stats.used }} 颗</div>
        <div class="sub">按现在的规则约 {{ form.need ? Math.floor(stats.used / form.need) : 0 }} 杯</div>
      </div>
    </div>

    <el-card shadow="never">
      <template #header>集星设置</template>
      <el-form label-width="120px" v-loading="loading">
        <el-form-item label="集星">
          <el-switch v-model="form.enabled" />
          <span class="muted small sep">{{ form.enabled ? '顾客在小程序里买一杯得一颗星，攒够了下单时免费换一杯' : '没打开，顾客看不到集星' }}</span>
        </el-form-item>
        <el-form-item label="几颗星换一杯">
          <el-input-number v-model="form.need" :min="1" :max="100" :step="1" />
        </el-form-item>
        <el-form-item label="买哪些得星">
          <el-radio-group v-model="form.earnAll">
            <el-radio :value="true">全部商品</el-radio>
            <el-radio :value="false">指定分类</el-radio>
          </el-radio-group>
          <el-checkbox-group v-if="!form.earnAll" v-model="form.earnCategories" class="full">
            <el-checkbox v-for="c in categories" :key="c._id" :value="c._id">{{ c.name }}</el-checkbox>
          </el-checkbox-group>
          <div class="muted small full">每件得 1 颗星，出餐、收款后到账；用券或用星免费的那杯不得星。</div>
        </el-form-item>
        <el-form-item label="能换哪些">
          <el-radio-group v-model="form.redeemAll">
            <el-radio :value="true">全部商品</el-radio>
            <el-radio :value="false">指定分类</el-radio>
          </el-radio-group>
          <el-checkbox-group v-if="!form.redeemAll" v-model="form.redeemCategories" class="full">
            <el-checkbox v-for="c in categories" :key="c._id" :value="c._id">{{ c.name }}</el-checkbox>
          </el-checkbox-group>
          <div class="muted small full">顾客下单时打开「用星换一杯」，在能换的商品里免费最贵的那一杯，每单限一杯。</div>
        </el-form-item>
        <el-form-item label="每杯最多抵">
          <el-input-number v-model="form.maxYuan" :min="0" :max="1000" :precision="2" :step="5" />
          <span class="muted small sep">元，0 就是整杯免费（比如填 25，换 32 元的手冲要补 7 元）</span>
        </el-form-item>
        <el-form-item label="有效天数">
          <el-input-number v-model="form.validDays" :min="0" :max="3650" :step="30" />
          <span class="muted small sep">0 就是一直有效；填 365 就是每颗星得到后一年内有效</span>
        </el-form-item>
        <el-form-item label="顾客看到的规则">
          <ol class="rules">
            <li v-for="(line, i) in rules" :key="i">{{ line }}</li>
          </ol>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
          <span class="muted small sep">在店里买了没用小程序的，可以在「会员储值」里按会员号给顾客加星。</span>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { yuan } from '../format'

const loading = ref(false)
const saving = ref(false)
const categories = ref([])
const stats = ref(null)
const form = ref({ enabled: false, need: 10, earnAll: true, earnCategories: [], redeemAll: true, redeemCategories: [], maxYuan: 0, validDays: 0 })

const names = (ids) => categories.value.filter((c) => ids.indexOf(c._id) !== -1).map((c) => '「' + c.name + '」').join('')

// 和小程序「集星」页上写的一样
const rules = computed(() => {
  const f = form.value
  const maxFee = Math.round((f.maxYuan || 0) * 100)
  return [
    '每买一件' + (f.earnAll ? '' : names(f.earnCategories)) + '商品得 1 颗星，出餐后到账；到吧台付款的，店员确认收款后到账。',
    '集满 ' + f.need + ' 颗星，下单时能免费换一杯' + (f.redeemAll ? '' : '（限' + names(f.redeemCategories) + '）') + (maxFee ? '，最多抵 ¥' + yuan(maxFee) : '') + '，每单限换一杯。',
    '用券或用星免费的那一杯不得星。',
    f.validDays ? '每颗星从得到那天起 ' + f.validDays + ' 天内有效，换的时候先用最早的。' : '星星一直有效。',
    '订单取消后，用掉的星星会退回。'
  ]
})

async function load() {
  loading.value = true
  try {
    const res = await api.coffee('getStarSettings')
    const s = res.settings
    form.value = {
      enabled: s.enabled,
      need: s.need,
      earnAll: s.earnAll,
      earnCategories: s.earnCategories.slice(),
      redeemAll: s.redeemAll,
      redeemCategories: s.redeemCategories.slice(),
      maxYuan: s.maxFee / 100,
      validDays: s.validDays
    }
    categories.value = res.categories
    stats.value = res.stats
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function save() {
  const f = form.value
  if (!f.earnAll && !f.earnCategories.length) return ElMessage.warning('请选择买哪些分类得星')
  if (!f.redeemAll && !f.redeemCategories.length) return ElMessage.warning('请选择能换哪些分类')
  saving.value = true
  try {
    await api.coffee('saveStarSettings', {
      settings: {
        enabled: f.enabled,
        need: f.need,
        earnAll: f.earnAll,
        earnCategories: f.earnAll ? [] : f.earnCategories,
        redeemAll: f.redeemAll,
        redeemCategories: f.redeemAll ? [] : f.redeemCategories,
        maxFee: Math.round((f.maxYuan || 0) * 100),
        validDays: f.validDays || 0
      }
    })
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
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.stat {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  padding: 16px;
}
.stat.primary {
  border-color: var(--el-color-primary);
  background: linear-gradient(135deg, #2a2316, #141312);
}
.label {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.value {
  font-size: 26px;
  font-weight: 700;
  margin: 6px 0;
  color: var(--el-color-primary);
}
.sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.small { font-size: 12px; }
.sep { margin-left: 10px; }
.full { width: 100%; }
.rules {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
  color: var(--el-text-color-regular);
}
</style>
