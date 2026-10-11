import './style.css';

// 单一入口统一处理两种运行环境：
// - 原生壳（Capacitor 注入 window.Capacitor + Filesystem 插件）→ 走原生扫描逻辑
// - 纯浏览器（含「添加到主屏幕」的 PWA / 桌面浏览器）→ 跳到网页版入口（文件选择器形态）
// 这样 index.html 在任意环境都不会因缺少原生桥而崩溃。
const root = document.getElementById('app');
if (typeof window !== 'undefined' && !window.Capacitor) {
  window.location.replace('./web.html');
} else if (root) {
  import('./app.js')
    .then((m) => m.initApp && m.initApp(root))
    .catch(() => {});
}
