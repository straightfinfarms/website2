/* =============================================================================
 * geo.js — geocoding (OpenStreetMap Nominatim) + distance helpers
 * window.BRRRR.geo
 * No API key required. Nominatim usage policy: <=1 req/sec, identify app.
 * ========================================================================== */
(function () {
  "use strict";

  function haversineMiles(a, b) {
    var R = 3958.8; // earth radius, miles
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  var lastCall = 0;
  function throttle() {
    var now = Date.now();
    var wait = Math.max(0, 1100 - (now - lastCall));
    lastCall = now + wait;
    return new Promise(function (r) { setTimeout(r, wait); });
  }

  // Forward geocode: address string -> {lat,lng,label}
  function geocode(query) {
    return throttle().then(function () {
      var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
        encodeURIComponent(query);
      return fetch(url, { headers: { "Accept": "application/json" } });
    }).then(function (res) {
      if (!res.ok) throw new Error("Geocoding failed (" + res.status + ")");
      return res.json();
    }).then(function (arr) {
      if (!arr || !arr.length) throw new Error("Address not found");
      return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon),
        label: arr[0].display_name };
    });
  }

  // Reverse geocode: {lat,lng} -> label (best-effort, may fail silently)
  function reverse(lat, lng) {
    return throttle().then(function () {
      var url = "https://nominatim.openstreetmap.org/reverse?format=json&lat=" +
        lat + "&lon=" + lng;
      return fetch(url, { headers: { "Accept": "application/json" } });
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j && j.display_name ? j.display_name : null; })
      .catch(function () { return null; });
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.geo = { haversineMiles: haversineMiles, geocode: geocode, reverse: reverse };
})();
