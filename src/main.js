import './style.css';
import { initApp } from './app.js';

const root = document.getElementById('app');
if (root) initApp(root);

// PWA：注册 Service Worker（浏览器/WebView 中可用；Capacitor 原生壳下无 SW 也无害）
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}
