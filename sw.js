// Кэш приложения для работы без интернета.
// Стратегия: сначала сеть (всегда свежая версия), при отсутствии связи — кэш.
// При изменении файлов увеличь номер версии.
const CACHE = 'notespanel-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/folders/most.png', 'icons/folders/vozvraty.png'];
const NETWORK_TIMEOUT = 3500;

self.addEventListener('install', (e) => {
  // cache: 'reload' — мимо HTTP-кэша браузера, чтобы не сохранить старые файлы
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
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

// Свои файлы: пробуем сеть, при ошибке или долгом ответе отдаём кэш. Чужие запросы не трогаем.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    network.catch(() => {});
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch (err) { /* нет сети */ }
    const cached = await cache.match(e.request, { ignoreSearch: true });
    return cached || network;
  })());
});

/* ---------------- Push-уведомления ----------------
   Сервер (Apps Script) присылает push без текста — текст забираем из его очереди.
   Адрес и секрет берём из данных приложения в IndexedDB. */

function readSettings() {
  return new Promise((resolve) => {
    const r = indexedDB.open('notespanel');
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      try {
        const q = r.result.transaction('kv').objectStore('kv').get('state');
        q.onsuccess = () => resolve(q.result?.settings || null);
        q.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    };
  });
}

async function fetchOutbox() {
  const s = await readSettings();
  if (!s?.syncUrl) return [];
  const r = await fetch(s.syncUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: s.syncSecret, action: 'outbox' }),
  });
  const j = await r.json();
  return j.ok ? j.data || [] : [];
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let msgs = [];
    try { msgs = await fetchOutbox(); } catch (err) {}
    const seen = await caches.open('push-seen');
    const fresh = [];
    for (const m of msgs) {
      const key = new Request('./__seen/' + encodeURIComponent(m.id));
      if (await seen.match(key)) continue;
      await seen.put(key, new Response('1'));
      fresh.push(m);
    }
    // iOS требует показать уведомление на каждый push
    if (!fresh.length) fresh.push(msgs[msgs.length - 1] || { id: 'ping', title: 'Заметки', body: 'Есть напоминание' });
    for (const m of fresh) {
      await self.registration.showNotification(m.title, { body: m.body || '', tag: m.id, icon: 'icons/icon-192.png', data: { url: './' } });
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (list.length) return list[0].focus();
    return self.clients.openWindow('./');
  })());
});
