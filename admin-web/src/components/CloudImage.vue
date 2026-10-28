<template>
  <img v-if="url" :src="url" :class="['cloud-img', fit]" alt="" />
  <div v-else class="cloud-img placeholder">{{ text }}</div>
</template>

<script setup>
import { computed } from 'vue'
import { imageUrl } from '../api'

// 服务器上的图片（/uploads/...），没有图片时显示文字
const props = defineProps({
  src: { type: String, default: '' },
  text: { type: String, default: '' },
  fit: { type: String, default: 'cover' }
})
const url = computed(() => imageUrl(props.src))
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
