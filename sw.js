// Guarda la app en el equipo para que abra sin internet.
const CACHE = "peregrino-v7";
const ARCHIVOS = ["./", "index.html", "styles.css", "app.js", "data/catalogo-inicial.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "vendor/xlsx.full.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Con internet se usa la versión nueva (si responde en 4 s); sin internet, la copia guardada.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.hostname.endsWith("google.com") || url.hostname.endsWith("googleusercontent.com")) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const guardado = await c.match(e.request, { ignoreSearch: true });
      const red = fetch(e.request).then((r) => { if (r.ok || r.type === "opaque") c.put(e.request, r.clone()); return r; });
      if (!guardado) return red;
      const limite = new Promise((ok) => setTimeout(() => ok(guardado), 4000));
      return Promise.race([red.catch(() => guardado), limite]);
    })
  );
});
