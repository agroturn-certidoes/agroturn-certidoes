// Service worker: deixa o site instalável como app e abrir a "casca" (telas e estilos) mesmo sem internet.
// Estratégia "rede primeiro": sempre tenta buscar a versão mais nova; só usa a cópia guardada se estiver
// offline. A API (planilha) é de outro endereço e nunca passa por aqui — pedidos e lista sempre são ao vivo.
const CACHE = "certidoes-v1";
const CASCA = [
  "./", "index.html", "styles.css", "app.js", "config.js", "manifest.webmanifest",
  "assets/logo-horizontal.png", "assets/icone.png", "assets/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // só arquivos do próprio site
  e.respondWith(
    // "no-cache" = pergunta ao servidor se mudou (barato), em vez de confiar na cópia do navegador
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || (req.mode === "navigate" ? caches.match("index.html") : undefined)))
  );
});
