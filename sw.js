const CACHE = 'texte-net-v3';
const ASSETS = [
  './', './index.html', './cleaner.js', './summarizer.js', './books.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './maskable-512.png'
];

// Fichiers lourds et immuables : dossier vendor (version complète) ou fichiers à la racine (version à plat)
const HEAVY = /\/vendor\/|\.(mjs|wasm|gz|pfb|ttf|icc)$|\/(tesseract[^/]*|jszip[^/]*|jbig2[^/]*|openjpeg[^/]*)\.js$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// - bibliothèques lourdes (jamais modifiées) : cache d'abord, rempli à la première utilisation.
// - le reste de l'application : réseau d'abord (mises à jour rapides), cache en secours hors connexion.
// Les appels aux services de traduction (autres origines) ne passent pas par ici.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (HEAVY.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && !url.search) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
