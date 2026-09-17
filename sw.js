// Service Worker：缓存静态资源，实现离线可用
// 缓存名必须随资源列表改动一起升版：策略是 cache-first，
// 不升版的话老用户会一直命中旧缓存，看不到新功能。
const CACHE = 'ledger-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/bill.js',
  './js/db.js',
  './js/seed.js',
  './js/charts.js',
  './js/util.js',
  './vendor/echarts.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      // 命中缓存：直接返回，并在后台刷新
      if (cached) {
        fetch(e.request)
          .then((res) => {
            if (res && res.status === 200) caches.open(CACHE).then((c) => c.put(e.request, res));
          })
          .catch(() => {});
        return cached;
      }
      // 未命中：联网获取并缓存
      return fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      });
    })
  );
});
