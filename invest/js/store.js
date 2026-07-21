/* =============================================================================
 * store.js — persistence (localStorage) + seed market data
 * window.BRRRR.store
 * ========================================================================== */
(function () {
  "use strict";

  var K_PROSPECTS = "brrrr.prospects.v1";
  var K_PORTFOLIO = "brrrr.portfolio.v1";
  var K_SETTINGS = "brrrr.settings.v1";

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }
  function uid() {
    return "p" + Date.now().toString(36) + Math.floor((performance.now() % 1) * 1e6).toString(36)
      + Math.floor(1000 + (performance.now() * 7 % 8999)).toString(36);
  }

  /* Seed prospects — realistic sample multi-family listings around a metro so
   * the map/finder is useful out of the box. Coordinates are around
   * Columbus, OH (a common cash-flow BRRRR market). Users add/replace these. */
  var SEED = [
    { name: "Maple Ave Quad", address: "1284 Maple Ave, Columbus, OH", lat: 39.9899, lng: -82.9781,
      units: 4, rentPerUnit: 1195, price: 241000, rehab: 55000, arvMode: "income", marketCapPct: 7.0 },
    { name: "Franklin St Triplex", address: "742 Franklin St, Columbus, OH", lat: 39.9601, lng: -82.9955,
      units: 3, rentPerUnit: 1150, price: 159000, rehab: 42000, arvMode: "income", marketCapPct: 7.25 },
    { name: "Hilltop 6-plex", address: "355 Wheatland Ave, Columbus, OH", lat: 39.9520, lng: -83.0700,
      units: 6, rentPerUnit: 1050, price: 292000, rehab: 90000, arvMode: "income", marketCapPct: 7.5 },
    { name: "Clintonville Duplex", address: "88 Como Ave, Columbus, OH", lat: 40.0430, lng: -83.0155,
      units: 2, rentPerUnit: 1495, price: 186000, rehab: 30000, arvMode: "income", marketCapPct: 6.5 },
    { name: "Weinland Park 8-unit", address: "1490 N 4th St, Columbus, OH", lat: 39.9990, lng: -82.9970,
      units: 8, rentPerUnit: 1095, price: 405000, rehab: 120000, arvMode: "income", marketCapPct: 7.25 },
    { name: "Grandview Fourplex", address: "1155 W 1st Ave, Columbus, OH", lat: 39.9835, lng: -83.0430,
      units: 4, rentPerUnit: 1650, price: 465000, rehab: 40000, arvMode: "income", marketCapPct: 6.25 },
    { name: "Linden Triplex", address: "2401 Cleveland Ave, Columbus, OH", lat: 40.0210, lng: -82.9760,
      units: 3, rentPerUnit: 1025, price: 108000, rehab: 60000, arvMode: "income", marketCapPct: 7.75 }
  ];

  function seededProspects() {
    return SEED.map(function (s) {
      var full = Object.assign({}, BRRRR.finance.DEFAULTS, s, {
        id: uid(), createdAt: "seed", source: "sample"
      });
      return full;
    });
  }

  function getProspects() {
    var p = load(K_PROSPECTS, null);
    if (p === null) { p = seededProspects(); save(K_PROSPECTS, p); }
    return p;
  }
  function setProspects(list) { save(K_PROSPECTS, list); }
  function addProspect(obj) {
    var list = getProspects();
    obj.id = obj.id || uid();
    obj.createdAt = obj.createdAt || new Date().toISOString();
    list.push(obj);
    setProspects(list);
    return obj;
  }
  function removeProspect(id) {
    setProspects(getProspects().filter(function (p) { return p.id !== id; }));
  }
  function resetProspects() { var s = seededProspects(); setProspects(s); return s; }

  /* Portfolio — properties under management. */
  function getPortfolio() { return load(K_PORTFOLIO, []); }
  function setPortfolio(list) { save(K_PORTFOLIO, list); }
  function addHolding(obj) {
    var list = getPortfolio();
    obj.id = obj.id || uid();
    obj.acquiredAt = obj.acquiredAt || new Date().toISOString().slice(0, 10);
    list.push(obj);
    setPortfolio(list);
    return obj;
  }
  function updateHolding(id, patch) {
    var list = getPortfolio();
    var idx = list.findIndex(function (h) { return h.id === id; });
    if (idx >= 0) { list[idx] = Object.assign({}, list[idx], patch); setPortfolio(list); }
    return list[idx];
  }
  function removeHolding(id) {
    setPortfolio(getPortfolio().filter(function (h) { return h.id !== id; }));
  }

  /* Syndication deals / SPVs. */
  function getDeals() { return load("brrrr.deals.v1", []); }
  function setDeals(list) { save("brrrr.deals.v1", list); }
  function addDeal(obj) {
    var list = getDeals();
    obj.id = obj.id || uid();
    obj.createdAt = obj.createdAt || new Date().toISOString();
    obj.investors = obj.investors || [];
    list.push(obj); setDeals(list); return obj;
  }
  function updateDeal(id, patch) {
    var list = getDeals(), idx = list.findIndex(function (d) { return d.id === id; });
    if (idx >= 0) { list[idx] = Object.assign({}, list[idx], patch); setDeals(list); return list[idx]; }
  }
  function removeDeal(id) { setDeals(getDeals().filter(function (d) { return d.id !== id; })); }

  function getSettings() {
    return load(K_SETTINGS, {
      targetCashflowPerUnit: 150, targetCoCPct: 12, marketCapPct: 6.5,
      originLat: 39.9612, originLng: -82.9988, originLabel: "Columbus, OH"
    });
  }
  function setSettings(s) { save(K_SETTINGS, s); }

  function exportAll() {
    return { prospects: getProspects(), portfolio: getPortfolio(), deals: getDeals(),
      settings: getSettings(), exportedAt: new Date().toISOString() };
  }
  function importAll(data) {
    if (data.prospects) setProspects(data.prospects);
    if (data.portfolio) setPortfolio(data.portfolio);
    if (data.deals) setDeals(data.deals);
    if (data.settings) setSettings(data.settings);
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.store = {
    uid: uid,
    getProspects: getProspects, setProspects: setProspects, addProspect: addProspect,
    removeProspect: removeProspect, resetProspects: resetProspects,
    getPortfolio: getPortfolio, setPortfolio: setPortfolio, addHolding: addHolding,
    updateHolding: updateHolding, removeHolding: removeHolding,
    getDeals: getDeals, setDeals: setDeals, addDeal: addDeal,
    updateDeal: updateDeal, removeDeal: removeDeal,
    getSettings: getSettings, setSettings: setSettings,
    exportAll: exportAll, importAll: importAll
  };
})();
