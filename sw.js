const C="words16-v7",CORE=["./","index.html","lib.js","store.js","ingest.js","units.js","tracks.js","pdf.min.js","pdf.worker.min.js","manifest.json","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(CORE)))});
self.addEventListener("activate",e=>e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!=C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{
  const r=e.request;if(r.method!="GET")return;
  const audio=new URL(r.url).pathname.includes("/audio/");
  // аудио: сначала кэш (оно не меняется); остальное: сначала сеть, чтобы обновления приходили сразу
  e.respondWith(audio
    ? caches.match(r).then(h=>h||fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp))}return res}))
    : fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp))}return res}).catch(()=>caches.match(r).then(h=>h||caches.match("index.html"))));
});
