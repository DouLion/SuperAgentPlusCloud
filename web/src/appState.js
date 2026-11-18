// 面板共享状态：AI 配置在设置页修改后，侧边栏徽标需要立刻反映。
// 用一个小 reactive 对象避免事件总线，也避免每个页面各自缓存。
import { reactive } from 'vue';
import { api } from './api.js';

export const appState = reactive({
  ai: { configured: false, model: '', base_url: '' },
});

/** 从 Center 拉取 AI 配置并写入共享状态。 */
export async function refreshAiHealth() {
  try {
    appState.ai = await api.getAiHealth();
  } catch {
    appState.ai = { configured: false, model: '', base_url: '' };
  }
}
