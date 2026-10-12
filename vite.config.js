import { defineConfig } from 'vite';

// 手机端 Web 工程配置：
// - root 指向仓库根（index.html / web.html / src/ 都在根下），让 vite 能同时找到两个入口
// - base './' 让 build 产物用相对路径，便于 Capacitor 原生壳加载
// - server.fs.allow 放开到上级，便于开发期读取项目外资源；解密核心已 vendor 到 src/core/decoders/（见该目录 package.json）
export default defineConfig({
  root: '.',
  base: './',
  server: { fs: { allow: ['..'] }, host: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 让 @rollup/plugin-commonjs 也处理源码目录：默认只转 node_modules，
    // 导致 src/core/decoders 下的普通 CJS（metadata_browser/lyricengine/lyrics）被当成 ESM、
    // 报 "default is not exported"。UMD 文件靠 Rollup 原生识别不受影响。
    commonjsOptions: {
      include: [/node_modules/, /src/],
      transformMixedEsModules: true,
    },
    // 同时产出两个入口：index.html=原生端（Capacitor 壳加载）、web.html=网页版（浏览器/直接部署）
    rollupOptions: {
      input: {
        index: 'index.html',
        web: 'web.html',
      },
    },
  },
});
