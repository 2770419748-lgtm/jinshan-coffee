<template>
  <div class="upload">
    <div class="preview" :style="{ width: width + 'px', height: height + 'px' }" @click="pick">
      <CloudImage v-if="modelValue" :src="modelValue" />
      <div v-else class="empty">{{ uploading ? '上传中…' : '+ 上传图片' }}</div>
    </div>
    <el-button v-if="modelValue" link size="small" @click="$emit('update:modelValue', '')">移除</el-button>
    <input ref="input" type="file" accept="image/*" hidden @change="onFile" />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { uploadImage } from '../api'
import CloudImage from './CloudImage.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  dir: { type: String, required: true },
  width: { type: Number, default: 120 },
  height: { type: Number, default: 120 }
})
const emit = defineEmits(['update:modelValue'])
const input = ref(null)
const uploading = ref(false)

function pick() {
  if (!uploading.value) input.value.click()
}

async function onFile(e) {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.warning('图片太大了，请选 5MB 以内的')
    return
  }
  uploading.value = true
  try {
    emit('update:modelValue', await uploadImage(file, props.dir))
  } catch (err) {
    ElMessage.error('上传失败：' + (err.message || '请稍后再试'))
  } finally {
    uploading.value = false
  }
}
</script>

<style scoped>
.upload {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.preview {
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  cursor: pointer;
  overflow: hidden;
}
.empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
