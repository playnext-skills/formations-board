/* The Playbook Caller service worker.
   Bump VERSION whenever index.html, the manifest or an icon changes: the old cache is
   dropped on activate and the page shows a "reload to update" toast. */
var VERSION = 'formations-board-v10';
var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png'
];
var NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(VERSION).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== VERSION; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

function withTimeout(promise, ms){
  return new Promise(function(resolve, reject){
    var t = setTimeout(function(){ reject(new Error('timeout')); }, ms);
    promise.then(function(v){ clearTimeout(t); resolve(v); }, function(err){ clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // external links (glossary sources) pass through

  if (req.mode === 'navigate'){
    // Network first (revalidated, never the HTTP cache) so a deploy shows up on the next open;
    // cached shell when offline or slow.
    e.respondWith(
      withTimeout(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }), NAV_TIMEOUT_MS).then(function(res){
        var copy = res.clone();
        caches.open(VERSION).then(function(c){ c.put('./index.html', copy); });
        return res;
      }).catch(function(){
        return caches.match('./index.html');
      })
    );
    return;
  }

  // Everything else (manifest, icons): cache first, refresh in the background.
  e.respondWith(
    caches.match(req).then(function(cached){
      var network = fetch(req).then(function(res){
        if (res && res.ok){ var copy = res.clone(); caches.open(VERSION).then(function(c){ c.put(req, copy); }); }
        return res;
      }).catch(function(){ return cached; });
      return cached || network;
    })
  );
});

self.addEventListener('message', function(e){
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
