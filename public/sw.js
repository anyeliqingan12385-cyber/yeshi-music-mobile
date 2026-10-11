/* 极简 Service Worker：缓存 App 壳，使网页版可「添加到主屏幕」当作安装的应用使用。
 * 仅缓存静态资源；音频文件由用户从本地文件夹选取，不进缓存。 */
const CACHE = 'yeshi-web-v1';
// 仅缓存稳定存在的壳资源；构建后被哈希改名的 JS/CSS 由 fetch 回源时按需缓存。
// 注意：不能写 './web/main.js' 这类构建后不复存在的路径，否则 cache.addAll 抛错导致 SW 永不激活。
const SHELL = ['./', './index.html', './web.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // 导航请求：优先网络，失败回退到首页
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./')));
    return;
  }
  // 静态资源：缓存优先，回源并更新
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
