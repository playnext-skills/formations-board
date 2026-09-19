/* The Playbook Caller service worker.
   Bump VERSION whenever index.html, the manifest or an icon changes: the old cache is
   dropped on activate and the page shows a "reload to update" toast.
   Hosting facts this file is written against: Cloudflare Pages redirects /index.html to /
   (308), so the shell is cached under './' only, and a redirected or error response is
   never stored for a navigation. */
var VERSION = 'formations-board-v18';
var SHELL = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png'
];
var NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(VERSION).then(function(c){
    // Bypass the HTTP cache so a VERSION bump never re-precaches a week-old icon.
    return c.addAll(SHELL.map(function(u){ return new Request(u, { cache: 'reload' }); }));
  }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== VERSION; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

function cacheable(res){ return !!res && res.ok && !res.redirected && res.type === 'basic'; }
function putShell(res){
  return caches.open(VERSION).then(function(c){ return c.put('./', res); }).catch(function(){});
}

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase, Stripe, external links pass through

  if (req.mode === 'navigate'){
    // Network first, revalidated. The network promise keeps running past the timeout so a
    // slow but fresh copy still lands in the cache for the next open (stale-while-revalidate).
    var network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' }).then(function(res){
      if (cacheable(res)) putShell(res.clone());
      return res;
    });
    var timer = new Promise(function(_, reject){ setTimeout(function(){ reject(new Error('timeout')); }, NAV_TIMEOUT_MS); });
    e.respondWith(
      Promise.race([network, timer]).then(function(res){
        // A redirect (e.g. /index.html -> /) is handed back untouched; the browser follows it.
        if (res.type === 'opaqueredirect' || res.redirected) return res;
        // 2xx and 4xx (including the branded 404 page) are real answers; only a 5xx falls back to the shell.
        if (res.status < 500) return res;
        return caches.match('./').then(function(hit){ return hit || res; });
      }).catch(function(){
        network.catch(function(){});
        return caches.match('./').then(function(hit){ return hit || new Response('Offline and no cached copy yet. Open the app once while online.', { status: 503, headers: { 'Content-Type': 'text/plain' } }); });
      })
    );
    return;
  }

  // Everything else (manifest, icons): cache first, refresh in the background.
  e.respondWith(
    caches.match(req).then(function(cached){
      var refresh = fetch(req).then(function(res){
        if (cacheable(res)){ var copy = res.clone(); caches.open(VERSION).then(function(c){ return c.put(req, copy); }).catch(function(){}); }
        return res;
      }).catch(function(){ return cached; });
      return cached || refresh;
    })
  );
});

self.addEventListener('message', function(e){
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
