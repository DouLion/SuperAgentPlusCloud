import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// dev 模式下 Center 地址；可用 CENTER_URL 覆盖。
// 接口统一位于 /sap-cloud/api，代理时不做 rewrite，直接转发到 Center。
const CENTER = process.env.CENTER_URL || 'http://127.0.0.1:8787';

export default defineConfig({
  base: '/sap-cloud/',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/sap-cloud/api': {
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
