/* DEPRECATED — 此文件已废弃，请勿使用。
 *
 * 真正的 PWA Service Worker 是 public/sw.js（被 web.html 注册）。
 * 原生入口 src/main.js 也不再在此注册 SW（原生壳用 Capacitor 自有 WebView，无需 SW）。
 *
 * 本文件仅作为占位保留，因为当前沙箱的安全删除钩子对 src/ 下文件不可用，
 * 无法物理删除。它不会被任何入口 import，也不会进入 vite 构建产物，可安全忽略。
 */
