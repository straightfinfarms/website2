/* ==========================================================================
   Balance Nature Property Fund — backend integration (Supabase)
   --------------------------------------------------------------------------
   Bridges the static site to a real backend WITHOUT rewriting the pages.

   How it works:
     - Reads window.SFF_CONFIG (from sff-config.js).
     - If keys are blank -> DEMO MODE: SFF.ready() runs immediately and the
       existing localStorage stores are used unchanged.
     - If keys are present -> BACKEND MODE: loads supabase-js, checks the
       session, hydrates SFF.pf / SFF.store in-memory caches from the database
       (so all the existing synchronous page code keeps working), and wraps the
       store mutators to write changes back to Supabase (shared across devices
       and co-investors).

   Public API:
     SFF.backend.enabled            -> boolean
     SFF.backend.user               -> {id,email,...} | null  (after ready)
     SFF.backend.signUp/signIn/signOut/resetPassword
     SFF.backend.addMember(propId, email)   -> grant a co-investor access
     SFF.ready(opts, cb)            -> run cb once data is available
     SFF.boot(active, opts, cb)     -> ready() + ui.mount(active) + cb()
        opts.auth: true  -> redirect to login.html if not signed in
                   false -> allow anonymous (public pages)
   ========================================================================== */
(function (global) {
  'use strict';
  var SFF = global.SFF || (global.SFF = {});
  var cfg = global.SFF_CONFIG || {};
  var SUPA_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

  var backend = {
    enabled: !!(cfg.supabaseUrl && cfg.supabaseAnonKey),
    client: null,
    user: null,
    _hydrated: false
  };
  SFF.backend = backend;

  /* ---------- dynamic loader for supabase-js ---------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (global.supabase && global.supabase.createClient) return resolve();
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function getClient() {
    if (backend.client) return backend.client;
    backend.client = global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return backend.client;
  }

  /* ---------- auth API (used by login.html + nav) ---------- */
  backend.ensureClient = function () {
    if (!backend.enabled) return Promise.reject(new Error('Backend not configured'));
    return loadScript(SUPA_JS).then(getClient);
  };
  backend.signUp = function (email, password, fullName) {
    return backend.ensureClient().then(function (sb) {
      return sb.auth.signUp({ email: email, password: password, options: { data: { full_name: fullName || '' } } });
    });
  };
  backend.signIn = function (email, password) {
    return backend.ensureClient().then(function (sb) {
      return sb.auth.signInWithPassword({ email: email, password: password });
    });
  };
  backend.signOut = function () {
    return backend.ensureClient().then(function (sb) { return sb.auth.signOut(); })
      .then(function () { location.href = 'login.html'; });
  };
  backend.resetPassword = function (email) {
    return backend.ensureClient().then(function (sb) {
      return sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/login.html' });
    });
  };
  backend.getSession = function () {
    return backend.ensureClient().then(function (sb) { return sb.auth.getSession(); })
      .then(function (r) { return r.data.session; });
  };
  backend.addMember = function (propId, email) {
    return backend.ensureClient().then(function (sb) {
      return sb.rpc('add_property_member', { p_id: propId, p_email: email });
    });
  };

  /* ---------- hydrate caches from the database ---------- */
  function hydrate() {
    if (backend._hydrated) return Promise.resolve();
    var sb = backend.client, uid = backend.user.id;

    return Promise.all([
      sb.from('properties').select('id,data,member_ids'),
      sb.from('connections').select('id,data'),
      sb.from('deals').select('id,data'),
      sb.from('commitments').select('data')
    ]).then(function (res) {
      var props = (res[0].data || []).map(function (r) { return Object.assign({}, r.data, { _memberIds: r.member_ids }); });
      var conns = (res[1].data || []).map(function (r) { return r.data; });
      var deals = (res[2].data || []).map(function (r) { return r.data; });
      var commits = (res[3].data || []).map(function (r) { return r.data; });

      // first login for this account -> seed a sample portfolio so it isn't empty
      if (!props.length && !deals.length) {
        return seedForUser().then(hydrateAfterSeed);
      }
      applyCaches(props, conns, deals, commits);
    });

    function hydrateAfterSeed() {
      return Promise.all([
        sb.from('properties').select('id,data,member_ids'),
        sb.from('connections').select('id,data'),
        sb.from('deals').select('id,data'),
        sb.from('commitments').select('data')
      ]).then(function (res) {
        applyCaches(
          (res[0].data || []).map(function (r) { return r.data; }),
          (res[1].data || []).map(function (r) { return r.data; }),
          (res[2].data || []).map(function (r) { return r.data; }),
          (res[3].data || []).map(function (r) { return r.data; })
        );
      });
    }
  }

  function applyCaches(props, conns, deals, commits) {
    // ----- portfolio cache (SFF.pf) -----
    if (SFF.pf) {
      var pcache = SFF.pf.load();               // ensures shape / marketplace defaults
      pcache.properties = props;
      pcache.connections = conns.length ? conns : pcache.connections;
      pcache.vendors = dedupById([].concat.apply([], props.map(function (p) { return p.vendorDetails || []; })));
      pcache.workOrders = [].concat.apply([], props.map(function (p) { return p.workOrders || []; }));
      SFF.pf._cache = pcache;
    }
    // ----- crowdfunding cache (SFF.store) -----
    if (SFF.store) {
      var scache = SFF.store.load();
      if (deals.length) scache.deals = deals;
      scache.commitments = commits;
      SFF.store._cache = scache;
    }
    backend._hydrated = true;
    wrapMutators();
  }

  function dedupById(arr) {
    var seen = {}, out = [];
    arr.forEach(function (x) { if (x && x.id && !seen[x.id]) { seen[x.id] = 1; out.push(x); } });
    return out;
  }

  /* ---------- seed a new account with the demo data ---------- */
  function seedForUser() {
    var sb = backend.client, uid = backend.user.id;
    var seedPf = SFF.seedPortfolio ? SFF.seedPortfolio() : { properties: [], connections: [] };
    var seedStore = SFF.seed ? SFF.seed() : { deals: [], commitments: [] };

    // embed vendor detail + work orders into each property so a property row is self-contained
    var vById = {}; (seedPf.vendors || []).forEach(function (v) { vById[v.id] = v; });
    var woByProp = {}; (seedPf.workOrders || []).forEach(function (w) { (woByProp[w.propertyId] = woByProp[w.propertyId] || []).push(w); });

    var propRows = (seedPf.properties || []).map(function (p) {
      var data = Object.assign({}, p);
      data.vendorDetails = (p.vendors || []).map(function (id) { return vById[id]; }).filter(Boolean);
      data.workOrders = woByProp[p.id] || [];
      return { id: p.id, created_by: uid, member_ids: [uid], data: data };
    });
    var connRows = (seedPf.connections || []).map(function (c) { return { id: c.id, user_id: uid, data: c }; });
    var dealRows = (seedStore.deals || []).map(function (d) { return { id: d.id, created_by: uid, is_public: true, data: d }; });

    var tasks = [];
    if (propRows.length) tasks.push(sb.from('properties').upsert(propRows, { onConflict: 'id' }));
    if (connRows.length) tasks.push(sb.from('connections').upsert(connRows, { onConflict: 'user_id,id' }));
    if (dealRows.length) tasks.push(sb.from('deals').upsert(dealRows, { onConflict: 'id' }));

    return Promise.all(tasks).then(function () {
      // seed commitments only where the deal has none yet
      return sb.from('commitments').select('id').limit(1).then(function (r) {
        if ((r.data || []).length) return;
        var crows = (seedStore.commitments || []).map(function (c) { return { deal_id: c.deal, user_id: uid, data: c }; });
        if (crows.length) return sb.from('commitments').insert(crows);
      });
    });
  }

  /* ---------- write-through: mirror mutations to Supabase ---------- */
  function wrapMutators() {
    var sb = backend.client, uid = backend.user.id;

    if (SFF.pf) {
      wrap(SFF.pf, 'addProperty', function (p) {
        var row = { id: p.id, created_by: uid, member_ids: [uid], data: p };
        sb.from('properties').upsert(row, { onConflict: 'id' }).then(logErr('addProperty'));
      });
      wrap(SFF.pf, 'setOwners', function (propertyId) {
        var p = SFF.pf.getProperty(propertyId);
        if (p) sb.from('properties').update({ data: p, updated_at: nowIso() }).eq('id', propertyId).then(logErr('setOwners'));
      });
      wrap(SFF.pf, 'updateConnection', function (id) {
        var c = SFF.pf.getConnection(id);
        if (c) sb.from('connections').upsert({ id: id, user_id: uid, data: c }, { onConflict: 'user_id,id' }).then(logErr('updateConnection'));
      });
    }
    if (SFF.store) {
      wrap(SFF.store, 'addDeal', function (d) {
        sb.from('deals').upsert({ id: d.id, created_by: uid, is_public: true, data: d }, { onConflict: 'id' }).then(logErr('addDeal'));
      });
      wrap(SFF.store, 'addCommitment', function (c) {
        sb.from('commitments').insert({ deal_id: c.deal, user_id: uid, data: c }).then(logErr('addCommitment'));
      });
    }
  }
  function wrap(obj, name, after) {
    if (!obj[name] || obj[name].__wrapped) return;
    var orig = obj[name];
    var fn = function () {
      var ret = orig.apply(obj, arguments);
      try { after.apply(null, arguments); } catch (e) { console.warn('write-through', name, e); }
      return ret;
    };
    fn.__wrapped = true;
    obj[name] = fn;
  }
  function logErr(op) { return function (r) { if (r && r.error) console.warn('Supabase ' + op + ':', r.error.message); }; }
  function nowIso() { try { return new Date().toISOString(); } catch (e) { return null; } }

  /* ---------- boot gate ---------- */
  SFF.ready = function (opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};

    if (!backend.enabled) {                 // DEMO MODE
      if (opts.auth) showBanner('Demo mode — data is stored in this browser only. Add your Supabase keys in sff-config.js to enable real logins and shared data.');
      return cb();
    }

    backend.ensureClient()
      .then(function () { return backend.getSession(); })
      .then(function (session) {
        if (!session) {
          if (opts.auth === false) { return cb(); }        // public page, anonymous ok
          var next = encodeURIComponent(location.pathname.replace(/^\//, '') + location.search);
          location.href = 'login.html?next=' + next;
          return;
        }
        backend.user = session.user;
        return hydrate().then(cb);
      })
      .catch(function (err) {
        console.error('Backend init failed, falling back to demo data:', err);
        showBanner('Could not reach the backend — showing local demo data.');
        cb();
      });
  };

  SFF.boot = function (active, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    SFF.ready(opts, function () {
      if (SFF.ui && SFF.ui.mount) SFF.ui.mount(active);
      if (cb) cb();
    });
  };

  /* ---------- small notice banner ---------- */
  function showBanner(msg) {
    if (document.getElementById('sff-banner')) return;
    var d = document.createElement('div');
    d.id = 'sff-banner';
    d.style.cssText = 'background:#f4ead1;color:#8a651e;font-size:13px;text-align:center;padding:8px 14px;font-family:Inter,sans-serif;';
    d.textContent = msg;
    document.body.insertBefore(d, document.body.firstChild);
  }

  /* ---------- expose current account for the nav ---------- */
  backend.accountLabel = function () {
    if (!backend.enabled) return null;
    return backend.user ? (backend.user.email || 'Account') : null;
  };
})(window);
