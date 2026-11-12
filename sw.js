/* Service worker do site Poliana Rebouças — permite instalar o app e abrir mesmo com internet instável */
const CACHE = 'pr-app-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // Firebase, fontes e APIs vão direto à rede
  if (req.mode === 'navigate') { // páginas: rede primeiro (conteúdo sempre atual), cache se estiver offline
    e.respondWith(fetch(req).then(r => { if (r.ok) { const k = url.pathname.endsWith('cliente.html') ? './cliente.html' : './index.html'; caches.open(CACHE).then(c => c.put(k, r.clone())); } return r; })
      .catch(() => caches.match(url.pathname.endsWith('cliente.html') ? './cliente.html' : './index.html').then(h => h || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok) caches.open(CACHE).then(c => c.put(req, r.clone()));
    return r;
  })));
});
