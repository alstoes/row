// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Uses the same Supabase project URL + publishable key as
// topbar.js / gym.html. To make your own copy, replace both with
// your project's values (or the PASTE- placeholders for
// local-only mode).
//
// Several pages can share one app_state row (health.html and
// po-water.html both use the 'health' row). Each page only owns
// the keys it lists, and a push keeps the keys the page doesn't
// own, so one page never wipes another page's data.
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://aguskytxkthswvjduziv.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_RrByCgLzJfDYeUGuxynNww_fViibZDD';

  // Stringify with sorted object keys. Postgres jsonb reorders keys,
  // so a plain JSON.stringify can't tell "same data" from "changed".
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) {
        return JSON.stringify(k) + ':' + canon(v[k]);
      }).join(',') + '}';
    }
    return JSON.stringify(v);
  }
  function parseStored(raw) {
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false;
    let lastSyncedSig = null;   // canon() of the row as we last saw/sent it
    let remoteBase = {};        // the full row, including keys other pages own
    let localVersion = 0;       // bumps on every local change to a synced key
    let pending = false;        // local changes not yet confirmed by the server

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v != null) out[k] = parseStored(v);
      }
      return out;
    }
    // Row to send: keys other pages own (from the last known row) + ours.
    function buildPayload() {
      const out = {};
      for (const k of Object.keys(remoteBase)) {
        if (!matches(k)) out[k] = remoteBase[k];
      }
      return Object.assign(out, collect());
    }

    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    function onLocalChange(k) {
      if (suppressSync || !matches(k)) return;
      localVersion++;
      pending = true;
      schedulePush();
    }
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { onLocalChange(k); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { onLocalChange(k); } catch (e) {}
    };

    // keepLocalOnly: on first load, keep synced keys this device has but
    // the server doesn't (they get pushed up) instead of deleting them.
    function applyRemote(remote, keepLocalOnly) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const local = localStorage.getItem(k);
          if (local == null || canon(parseStored(local)) !== canon(remote[k])) {
            try { origSet(k, JSON.stringify(remote[k])); changed = true; } catch (e) {}
          }
        }
        if (!keepLocalOnly) {
          for (const k of listAllKeys()) {
            if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
          }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }

    async function pushNow() {
      if (!supa) return;
      const ver = localVersion;
      const payload = buildPayload();
      const sig = canon(payload);
      if (sig === lastSyncedSig) { if (ver === localVersion) pending = false; return; }
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: payload, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) {
          lastSyncedSig = sig;
          remoteBase = payload;
          if (ver === localVersion) pending = false;
        }
      } catch (e) {}
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }

    function flushOnUnload() {
      if (!pending) return;
      const payload = buildPayload();
      const sig = canon(payload);
      if (sig === lastSyncedSig) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: payload, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(function () {});
        lastSyncedSig = sig;
      } catch (e) {}
    }

    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error) {
          const remote = (data && data.data && typeof data.data === 'object') ? data.data : {};
          remoteBase = remote;
          lastSyncedSig = canon(remote);
          if (!pending) applyRemote(remote, true);
          // Push if this device has synced keys the server lacks.
          if (canon(buildPayload()) !== lastSyncedSig) { pending = true; schedulePush(); }
        }
      } catch (e) {}
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, function (payload) {
          const d = payload.new && payload.new.data;
          if (!d || typeof d !== 'object') return;
          const sig = canon(d);
          if (sig === lastSyncedSig) return;   // echo of our own push
          remoteBase = d;
          if (pending) return;                 // unsent local edits win; next push overwrites
          lastSyncedSig = sig;
          applyRemote(d, false);
        })
        .subscribe();
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('online', function () { if (pending) schedulePush(); });
    window.addEventListener('storage', function (e) {
      if (e.key && matches(e.key)) { localVersion++; pending = true; schedulePush(); }
    });
  };
})();
