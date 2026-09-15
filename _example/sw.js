// Service worker minimo: solo para que el navegador ofrezca instalar la PWA.
// No cachea datos (Sheets siempre se pide a la red), solo el shell estatico.
const CACHE_NAME = "gastos-example-shell-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "../shared/app.js",
  "../shared/style.css",
  "../shared/icon-192.png",
  "../shared/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(SHELL_ASSETS.map((url) => cache.add(url).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.includes("sheets.googleapis.com") || url.hostname.includes("accounts.google.com")) {
    return; // nunca cachear login ni datos
  }
  // Red primero: si hay internet, siempre trae la version mas nueva del
  // shell (y la deja en cache de paso). "no-store" es clave: algunos hosts
  // estaticos mandan cache-control: max-age alto en estos archivos, asi que
  // un fetch normal podia devolver una copia vieja del cache HTTP del
  // navegador sin llegar a pedirla de nuevo - con no-store se ignora esa
  // caché siempre. Solo se usa el cache (Cache Storage propio) si la red
  // falla (offline).
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return respuesta;
      })
      .catch(() => caches.match(event.request))
  );
});
