/* =============================================================================
 * finder.js — Deal Finder tab: Leaflet map + nearby ranked prospects
 * window.BRRRR.finder
 * ========================================================================== */
(function () {
  "use strict";
  var F = BRRRR.finance, fmt = F.fmtMoney;
  var map, markers = [], originMarker = null, radiusCircle = null;
  var origin = null; // {lat,lng,label}

  function el(id) { return document.getElementById(id); }

  function scoreOf(p) {
    var r = F.analyze(p);
    var s = F.scoreDeal(r);
    return { r: r, s: s };
  }
  function markColor(total) {
    return total >= 78 ? "#2fbf71" : total >= 66 ? "#7bd88f" :
      total >= 52 ? "#f0b429" : "#f0616d";
  }
  function gradeClass(g) {
    if (g[0] === "A") return "g-a"; if (g[0] === "B") return "g-b";
    if (g[0] === "C") return "g-c"; if (g[0] === "D") return "g-d"; return "g-f";
  }

  function ensureMap() {
    if (map) return;
    var s = BRRRR.store.getSettings();
    origin = { lat: s.originLat, lng: s.originLng, label: s.originLabel };
    map = L.map("map").setView([origin.lat, origin.lng], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap contributors"
    }).addTo(map);

    map.on("click", function (e) { promptNewProspect(e.latlng); });
  }

  function clearMarkers() {
    markers.forEach(function (m) { map.removeLayer(m); });
    markers = [];
  }

  function markerIcon(total, grade) {
    var col = markColor(total);
    return L.divIcon({
      className: "", iconSize: [34, 34], iconAnchor: [17, 17],
      html: '<div class="mk" style="width:34px;height:34px;background:' + col + '">' + grade + '</div>'
    });
  }

  function refresh() {
    ensureMap();
    var radius = parseFloat(el("find-radius").value) || 999;
    var minRating = parseFloat(el("find-minrating").value) || 0;
    var prospects = BRRRR.store.getProspects();

    var rows = prospects.map(function (p) {
      var sc = scoreOf(p);
      var dist = (p.lat != null && origin) ?
        BRRRR.geo.haversineMiles(origin, { lat: p.lat, lng: p.lng }) : null;
      return { p: p, r: sc.r, s: sc.s, dist: dist };
    }).filter(function (x) {
      if (x.s.total < minRating) return false;
      if (x.dist != null && x.dist > radius) return false;
      return true;
    });

    // Sort by cash flow per unit desc — the key metric.
    rows.sort(function (a, b) { return b.r.cfPerUnitMo - a.r.cfPerUnitMo; });

    drawMarkers(rows, radius);
    drawTable(rows);
    el("find-count").textContent = rows.length + " within " + radius + " mi";
  }

  function drawMarkers(rows, radius) {
    clearMarkers();
    if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
    if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }

    if (origin) {
      originMarker = L.marker([origin.lat, origin.lng], {
        icon: L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9],
          html: '<div style="width:16px;height:16px;border-radius:50%;background:#4aa8ff;border:3px solid #fff;box-shadow:0 0 0 2px #4aa8ff"></div>' })
      }).addTo(map).bindPopup("Search center<br>" + (origin.label || ""));
      radiusCircle = L.circle([origin.lat, origin.lng], {
        radius: radius * 1609.34, color: "#4aa8ff", weight: 1, fillOpacity: 0.05
      }).addTo(map);
    }

    var bounds = [];
    rows.forEach(function (x) {
      if (x.p.lat == null) return;
      var m = L.marker([x.p.lat, x.p.lng], { icon: markerIcon(x.s.total, x.s.grade) })
        .addTo(map).bindPopup(popupHtml(x));
      markers.push(m);
      bounds.push([x.p.lat, x.p.lng]);
    });
    if (origin) bounds.push([origin.lat, origin.lng]);
    if (bounds.length > 1) { try { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 }); } catch (e) {} }
  }

  function popupHtml(x) {
    var p = x.p, r = x.r, s = x.s;
    return '<b>' + (p.name || "Prospect") + '</b><br>' +
      (p.address || "") + '<br>' +
      '<span class="pill ' + gradeClass(s.grade) + '">' + s.grade + '</span> ' +
      'score ' + s.total + '<br>' +
      p.units + ' units · ' + fmt(p.price) + '<br>' +
      'CF ' + fmt(r.cfPerUnitMo) + '/unit/mo · CoC ' +
      (isFinite(r.cocPct) ? r.cocPct.toFixed(1) + "%" : "∞") + '<br>' +
      '<a href="#" data-analyze="' + p.id + '">Open in Analyzer →</a>';
  }

  function drawTable(rows) {
    var tb = el("find-table").querySelector("tbody");
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty">No prospects in range. Widen the radius, lower min rating, or click the map to add one.</td></tr>';
      return;
    }
    tb.innerHTML = rows.map(function (x) {
      var r = x.r, s = x.s, p = x.p;
      return '<tr>' +
        '<td><span class="pill ' + gradeClass(s.grade) + '">' + s.grade + '</span> <span style="color:var(--muted)">' + s.total + '</span></td>' +
        '<td>' + (p.name || "—") + '<div style="color:var(--faint);font-size:11px">' + (p.address || "") + '</div></td>' +
        '<td class="num">' + (x.dist != null ? x.dist.toFixed(1) : "—") + '</td>' +
        '<td class="num">' + fmt(p.price) + '</td>' +
        '<td class="num" style="color:' + (r.cfPerUnitMo >= 0 ? "var(--buy)" : "var(--pass)") + '">' + fmt(r.cfPerUnitMo) + '</td>' +
        '<td class="num">' + (isFinite(r.cocPct) ? r.cocPct.toFixed(1) + "%" : "∞") + '</td>' +
        '<td><button class="btn ghost sm" data-analyze="' + p.id + '">Open</button> ' +
        '<button class="btn danger sm" data-del="' + p.id + '">✕</button></td>' +
        '</tr>';
    }).join("");
  }

  function openInAnalyzer(id) {
    var p = BRRRR.store.getProspects().find(function (x) { return x.id === id; });
    if (p) BRRRR.analyze.loadProspect(p);
  }

  function promptNewProspect(latlng) {
    BRRRR.ui.modal(
      '<h2>New prospect here</h2>' +
      '<p class="hint">Dropped at ' + latlng.lat.toFixed(4) + ', ' + latlng.lng.toFixed(4) +
      '. Enter the basics — full underwriting opens in the Analyzer.</p>' +
      '<div class="field"><label>Name</label><input id="np-name" value="Map prospect"></div>' +
      '<div class="row"><div class="field"><label>Units</label><input id="np-units" type="number" value="4"></div>' +
      '<div class="field"><label>Rent / unit / mo</label><input id="np-rent" type="number" value="1200"></div></div>' +
      '<div class="row"><div class="field"><label>Price</label><input id="np-price" type="number" value="450000"></div>' +
      '<div class="field"><label>Rehab</label><input id="np-rehab" type="number" value="50000"></div></div>' +
      '<div class="btnrow"><button class="btn" id="np-save">Add prospect</button>' +
      '<button class="btn ghost" id="np-cancel">Cancel</button></div>',
      function (root) {
        root.querySelector("#np-cancel").onclick = BRRRR.ui.closeModal;
        root.querySelector("#np-save").onclick = function () {
          var obj = Object.assign({}, F.DEFAULTS, {
            name: root.querySelector("#np-name").value,
            units: parseFloat(root.querySelector("#np-units").value),
            rentPerUnit: parseFloat(root.querySelector("#np-rent").value),
            price: parseFloat(root.querySelector("#np-price").value),
            rehab: parseFloat(root.querySelector("#np-rehab").value),
            lat: latlng.lat, lng: latlng.lng, source: "map"
          });
          BRRRR.store.addProspect(obj);
          BRRRR.geo.reverse(latlng.lat, latlng.lng).then(function (label) {
            if (label) { obj.address = label; BRRRR.store.setProspects(BRRRR.store.getProspects()); }
            refresh();
          });
          BRRRR.ui.closeModal();
          BRRRR.ui.toast("Prospect added");
          refresh();
        };
      });
  }

  function search() {
    var q = el("find-address").value.trim();
    if (!q) { refresh(); return; }
    BRRRR.ui.toast("Locating…");
    BRRRR.geo.geocode(q).then(function (g) {
      origin = { lat: g.lat, lng: g.lng, label: g.label };
      var s = BRRRR.store.getSettings();
      s.originLat = g.lat; s.originLng = g.lng; s.originLabel = g.label;
      BRRRR.store.setSettings(s);
      map.setView([g.lat, g.lng], 12);
      refresh();
    }).catch(function (err) {
      BRRRR.ui.toast("Couldn't find that address");
    });
  }

  function init() {
    el("btn-find").addEventListener("click", search);
    el("find-address").addEventListener("keydown", function (e) { if (e.key === "Enter") search(); });
    el("find-radius").addEventListener("input", refresh);
    el("find-minrating").addEventListener("change", refresh);
    el("btn-reset-prospects").addEventListener("click", function () {
      if (confirm("Reset prospects to the sample set? Your added prospects will be removed.")) {
        BRRRR.store.resetProspects(); refresh();
      }
    });
    // Delegated clicks for table/popup buttons.
    document.addEventListener("click", function (e) {
      var a = e.target.closest("[data-analyze]");
      if (a) { e.preventDefault(); openInAnalyzer(a.getAttribute("data-analyze")); return; }
      var d = e.target.closest("[data-del]");
      if (d) {
        e.preventDefault();
        if (confirm("Delete this prospect?")) { BRRRR.store.removeProspect(d.getAttribute("data-del")); refresh(); }
      }
    });
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.finder = { init: init, refresh: refresh, ensureMap: ensureMap };
})();
