// Service worker: lưu sẵn giao diện để app chạy được khi không có mạng.
// Đổi VERSION mỗi khi cập nhật mã nguồn để iPhone tải bản mới.
const VERSION = 'qlbc-v11';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'scan.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' để luôn lấy tệp mới từ máy chủ, không dùng bản cũ còn trong bộ nhớ đệm của trình duyệt.
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Tệp chưa có trong bộ nhớ (ví dụ bộ đọc chữ trong vendor/) thì tải về rồi lưu lại để lần sau dùng không cần mạng.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
