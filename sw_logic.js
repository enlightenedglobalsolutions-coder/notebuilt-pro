// ============================================================================
//  EGS platform — service-worker logic (the tested core the SW imports)
//  Kept as its own file so the DECISIONS that make updates "just work" are
//  provable in node, and the real service worker runs this exact code via
//  importScripts — no drift between what's tested and what ships.
// ============================================================================
(function(global){

  // Cache name for an app at a version. One app can have many old caches;
  // exactly one is current.
  function cacheName(app, version){ return 'egs-' + app + '-' + version; }

  // Given every cache key on the device, which belong to THIS app but are old
  // and must be deleted on activate. Never touches other apps' caches.
  function staleCaches(keys, app, version){
    var keep = cacheName(app, version);
    return keys.filter(function(k){
      return k.indexOf('egs-' + app + '-') === 0 && k !== keep;
    });
  }

  // The strategy for a request. THE decision that removes update pain:
  // HTML/navigations are NETWORK-FIRST so a fresh deploy is picked up on the
  // next online launch with no cache-clearing; everything else is
  // stale-while-revalidate (instant from cache, refreshed in the background).
  function strategyFor(reqMode, acceptHeader){
    if(reqMode === 'navigate' || (acceptHeader || '').indexOf('text/html') >= 0)
      return 'network-first';
    return 'stale-while-revalidate';
  }

  // A version stamp is YYYY.MM.DD-HHMM — human-readable, sortable, eyeball-able.
  function isValidVersion(v){ return /^\d{4}\.\d{2}\.\d{2}-\d{4}$/.test(v); }

  // SW_DEADLINE — network-first needs a deadline, not just a .catch().
  // Offline is not the dangerous case: offline REJECTS, the catch fires, and
  // the cached shell is served. The dangerous case is a network that neither
  // answers nor fails — a captive portal, or an access point with no route
  // out. There fetch() stays pending forever, the catch never runs, and the
  // app hangs on launch with nothing on screen. Notebuilt hit this on real
  // wifi. 3.5s: long enough that a slow-but-real connection still wins, short
  // enough that nobody stares at a blank screen wondering.
  var NET_TIMEOUT_MS = 3500;

  // Resolve with the network if it answers in time, otherwise with fallback().
  // A REJECTED network also takes the fallback immediately, so the old offline
  // behaviour is preserved rather than reimplemented. Never rejects for want
  // of a network. Timers are injectable so this is testable in node.
  function raceTimeout(networkPromise, ms, fallbackFn, timers){
    /* SW_TIMER_RECEIVER — these MUST be wrappers, not bare references.
       `{set:setTimeout}` then `T.set(fn,ms)` calls setTimeout with `this === T`
       instead of the global, and Web IDL answers that with
       "TypeError: Illegal invocation". Inside this Promise executor that throw
       becomes a REJECTION, respondWith() gets a rejected promise, and every
       navigation dies with ERR_FAILED on a perfectly healthy network — which is
       exactly what 2026.08.12-1407 did to Notebuilt on device.
       Node's setTimeout ignores `this`, so no node test could ever have caught
       it; the receiver rule only exists in browsers. */
    var T = timers || { set:function(fn,ms){ return setTimeout(fn,ms); },
                        clear:function(id){ return clearTimeout(id); } };
    return new Promise(function(resolve){
      var settled = false;
      var id = T.set(function(){
        if(settled) return; settled = true;
        resolve(fallbackFn());
      }, ms);
      networkPromise.then(function(res){
        if(settled) return; settled = true; T.clear(id); resolve(res);
      }, function(){
        if(settled) return; settled = true; T.clear(id); resolve(fallbackFn());
      });
    });
  }

  var api = { cacheName:cacheName, staleCaches:staleCaches, strategyFor:strategyFor, isValidVersion:isValidVersion,
              NET_TIMEOUT_MS:NET_TIMEOUT_MS, raceTimeout:raceTimeout };
  if(typeof module !== 'undefined') module.exports = api;
  global.EGS_SW = api;

})(typeof self !== 'undefined' ? self : this);
