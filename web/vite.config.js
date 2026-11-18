import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// dev 模式下 Center 地址；可用 CENTER_URL 覆盖。
// 接口没有 /api 前缀，因此代理按已知 API 前缀匹配，避免把 Vite 的 HMR 请求转发出去。
const CENTER = process.env.CENTER_URL || 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '^/(healthz|projects|trunk-items|trunk-changes|impact-items|requirements|tasks|submissions|ai|events)': {
        target: CENTER,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
