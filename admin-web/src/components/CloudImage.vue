<template>
  <img v-if="url" :src="url" :class="['cloud-img', fit]" alt="" />
  <div v-else class="cloud-img placeholder">{{ text }}</div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { tempUrl } from '../api'

// 云存储里的图片（cloud://）要先换成临时网址才能在网页里显示
const props = defineProps({
  src: { type: String, default: '' },
  text: { type: String, default: '' },
  fit: { type: String, default: 'cover' }
})
const url = ref('')

watch(() => props.src, async (src) => {
  url.value = ''
  if (!src) return
  try {
    url.value = await tempUrl(src)
  } catch (e) {
    url.value = ''
  }
}, { immediate: true })
</script>

<style scoped>
.cloud-img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 6px;
  background: #211f1c;
}
.cloud-img.cover { object-fit: cover; }
.cloud-img.contain { object-fit: contain; }
.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 12px;
  padding: 4px;
  box-sizing: border-box;
  color: var(--el-color-primary);
  overflow: hidden;
}
</style>
