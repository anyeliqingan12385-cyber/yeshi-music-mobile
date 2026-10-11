import { defineConfig } from 'vite';

// 手机端 Web 工程配置：
// - root 指向 src/，index.html 在此
// - base './' 让 build 产物用相对路径，便于 Capacitor 原生壳加载
// - server.fs.allow 放开到上级，允许 import 桌面端 ../core 的纯 JS 解密核心（单一真相源）
export default defineConfig({
  root: 'src',
  base: './',
  server: { fs: { allow: ['..'] }, host: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // 同时产出两个入口：index.html=原生端（Capacitor 壳加载）、web.html=网页版（浏览器/直接部署）
    rollupOptions: {
      input: {
        index: 'index.html',
        web: 'web.html',
      },
    },
  },
});
