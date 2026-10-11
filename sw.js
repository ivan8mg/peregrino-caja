// Guarda la app en el equipo para que abra sin internet.
const CACHE = "peregrino-v1";
const ARCHIVOS = ["./", "index.html", "styles.css", "app.js", "data/catalogo-inicial.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Archivos de la app: primero la copia guardada, y se actualiza en segundo plano. Fuentes: igual.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const guardado = await c.match(e.request, { ignoreSearch: true });
      const red = fetch(e.request).then((r) => { if (r.ok || r.type === "opaque") c.put(e.request, r.clone()); return r; }).catch(() => guardado);
      return guardado || red;
    })
  );
});
