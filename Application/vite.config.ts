import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * 渲染层构建配置。
 * 产物输出到 dist/renderer，由主进程以 file:// 方式加载，因此 base 必须是相对路径。
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
