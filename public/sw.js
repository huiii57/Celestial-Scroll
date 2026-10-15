/* =====================================================================
   Service Worker —— 讓 App 能離線打開、離線翻閱看過的日記
   · App 外殼（html/css/js/圖示）：先給快取、背景更新
   · /api/ 的讀取（GET）：優先連網，連不上就給「上次看到的內容」
   · 寫入（POST/PATCH）一律不攔截，不會把你的寫入偷偷存起來
   改了前端檔案後，把下面的 VERSION 數字加 1，手機才會更新到新版。
   ===================================================================== */
const VERSION = 'v1';
const SHELL_CACHE = `star-shell-${VERSION}`;
const DATA_CACHE = 'star-data-v1';
const SHELL_FILES = [
  '/', '/index.html', '/app.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('star-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;               // 寫入不碰
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 只處理自己網站

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/** 資料：連得上就用最新的並順手存一份；連不上就用上次存的 */
async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()); // 只存成功的（401 等錯誤不存）
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }
}

/** 外殼：立刻給快取，同時背景抓新的，下次開啟就是新版 */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fetching = fetch(req)
    .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  if (hit) return hit;
  const res = await fetching;
  if (res) return res;
  // 離線又沒快取：導覽請求退回首頁
  if (req.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
  return Response.error();
}
