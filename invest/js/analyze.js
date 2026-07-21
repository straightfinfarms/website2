/* =============================================================================
 * analyze.js — Analyzer tab: reads inputs, renders score/pricepoints/detail
 * window.BRRRR.analyze
 * ========================================================================== */
(function () {
  "use strict";
  var F = BRRRR.finance, fmt = F.fmtMoney, pct = F.fmtPct;

  var FIELDS = ["name", "address", "units", "rentPerUnit", "otherIncome", "vacancyPct",
    "taxesAnnual", "insuranceAnnual", "utilitiesAnnual", "reservesPerUnit",
    "maintenancePct", "managementPct", "expenseRatioPct", "price", "rehab",
    "downPct", "purchaseRate", "purchaseTermYears", "closingPct", "holdingMonths",
    "arvMode", "marketCapPct", "arvManual", "refiLtvPct", "refiRate",
    "refiTermYears", "refiClosingPct", "targetCashflowPerUnit", "targetCoCPct"];

  function el(id) { return document.getElementById(id); }
  function readForm() {
    var o = {};
    FIELDS.forEach(function (k) {
      var node = el("f-" + k);
      if (!node) return;
      if (k === "name" || k === "address" || k === "arvMode") o[k] = node.value;
      else o[k] = parseFloat(node.value);
    });
    return o;
  }
  function writeForm(o) {
    FIELDS.forEach(function (k) {
      var node = el("f-" + k);
      if (node && o[k] != null) node.value = o[k];
    });
    toggleArv();
  }
  function toggleArv() {
    el("arvManual-wrap").style.display = el("f-arvMode").value === "manual" ? "" : "none";
  }

  function gradeClass(g) {
    if (g[0] === "A") return "g-a"; if (g[0] === "B") return "g-b";
    if (g[0] === "C") return "g-c"; if (g[0] === "D") return "g-d"; return "g-f";
  }

  function renderDial(score) {
    var s = score.total, r = 54, c = 2 * Math.PI * r;
    var col = s >= 78 ? "#2fbf71" : s >= 66 ? "#7bd88f" : s >= 52 ? "#f0b429" : "#f0616d";
    var off = c * (1 - s / 100);
    el("dial").innerHTML =
      '<svg width="132" height="132" viewBox="0 0 132 132">' +
      '<circle cx="66" cy="66" r="' + r + '" fill="none" stroke="#243040" stroke-width="12"/>' +
      '<circle cx="66" cy="66" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="12" ' +
      'stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + off + '"/></svg>' +
      '<div class="val"><div><div class="num" style="color:' + col + '">' + s + '</div>' +
      '<div class="grade">BRRRR score · <b>' + score.grade + '</b></div></div></div>';
  }

  function renderReco(score) {
    var rc = score.recommendation;
    el("reco").innerHTML =
      '<div class="verb ' + rc.tone + '">' + rc.verb + '</div>' +
      '<div class="note">' + rc.note + '</div>' +
      '<div style="margin-top:8px" class="note">Rating: ' +
      "★".repeat(score.rating) + "☆".repeat(5 - score.rating) + '</div>';
  }

  function renderCrit(score) {
    var html = "";
    score.order.forEach(function (k) {
      var c = score.criteria[k];
      html += '<div class="line"><div class="cl">' + c.label +
        ' <span class="tag">w' + c.weight + '</span></div>' +
        '<div class="bar"><i style="width:' + Math.round(c.score) + '%"></i></div>' +
        '<div class="cv">' + c.display + '</div></div>';
    });
    el("crit").innerHTML = html;
  }

  function renderPricepoints(pp, asking) {
    function card(cls, lbl, amt, sub) {
      return '<div class="ppcard ' + (cls || "") + '"><div class="lbl">' + lbl + '</div>' +
        '<div class="amt">' + (amt == null ? "—" : fmt(amt)) + '</div>' +
        '<div class="sub">' + sub + '</div></div>';
    }
    var deltaR = pp.recoveryPrice != null ? (pp.recoveryPrice - asking) : null;
    var recSub = deltaR == null ? "Not achievable at any price" :
      (deltaR >= 0 ? "You can pay " + fmt(deltaR) + " above ask and still recover all capital" :
        "Offer " + fmt(-deltaR) + " below ask to recover all capital");
    el("pricepoints").innerHTML =
      card("hero", "Max offer to recover ALL capital (true BRRRR)", pp.recoveryPrice, recSub) +
      card("", "70% Rule — Max Allowable Offer", pp.mao70, "0.70 × ARV (" + fmt(pp.arv) + ") − rehab") +
      card("", "Target cash-on-cash (" + el("f-targetCoCPct").value + "%)", pp.cocPrice,
        pp.cocPrice == null ? "Unreachable — lower target or basis" : "Pay this to hit your CoC goal") +
      card("", "Target cash flow (" + el("f-targetCashflowPerUnit").value + "/unit)", pp.cfPrice,
        pp.cfPrice == null ? "CF target not met even at low basis" : "Pay ≤ this for target cash flow");
  }

  function tile(k, v, cls, span) {
    return '<div class="tile' + (span ? " big" : "") + '"><div class="k">' + k +
      '</div><div class="v ' + (cls || "") + '">' + v + '</div></div>';
  }
  function renderTiles(r) {
    var sign = function (x) { return x >= 0 ? "pos" : "neg"; };
    el("tiles").innerHTML =
      tile("ARV", fmt(r.arv)) +
      tile("NOI (annual)", fmt(r.noi)) +
      tile("Cash flow / mo (post-refi)", fmt(r.cfRefiMo), sign(r.cfRefiMo)) +
      tile("Cash flow / unit / mo", fmt(r.cfPerUnitMo), sign(r.cfPerUnitMo)) +
      tile("Cash invested", fmt(r.totalCashInvested)) +
      tile("Cash out at refi", fmt(r.cashOut), sign(r.cashOut)) +
      tile("Cash left in deal", fmt(r.cashLeftInDeal), r.cashLeftInDeal <= 0 ? "pos" : "") +
      tile("Capital recovered", Math.round(r.capitalRecoveredPct) + "%") +
      tile("Cash-on-cash", isFinite(r.cocPct) ? pct(r.cocPct) : "∞", "pos") +
      tile("Cap rate (purchase)", pct(r.capRatePurchase)) +
      tile("DSCR", isFinite(r.dscr) ? r.dscr.toFixed(2) + "x" : "∞") +
      tile("Rent-to-price", pct(r.rentToPricePct, 2)) +
      tile("Equity at refi", fmt(r.equityAtRefi)) +
      tile("Expense ratio", pct(r.expenseRatio * 100, 0));
  }

  function recompute() {
    var input = readForm();
    var r = F.analyze(input);
    var score = F.scoreDeal(r);
    var pp = F.pricepoints(input);
    renderDial(score); renderReco(score); renderCrit(score);
    renderPricepoints(pp, input.price);
    renderTiles(r);
    BRRRR.analyze._last = { input: input, result: r, score: score };
  }

  function loadProspect(p) {
    var merged = Object.assign({}, F.DEFAULTS, p);
    writeForm(merged);
    recompute();
    BRRRR.app.switchView("analyze");
  }

  function init() {
    FIELDS.forEach(function (k) {
      var node = el("f-" + k);
      if (node) node.addEventListener("input", recompute);
      if (node && k === "arvMode") node.addEventListener("change", function () { toggleArv(); recompute(); });
    });

    el("btn-reset-inputs").addEventListener("click", function () {
      writeForm(Object.assign({ name: "New Prospect", address: "" }, F.DEFAULTS));
      recompute();
    });

    el("btn-save-prospect").addEventListener("click", function () {
      var input = readForm();
      var last = BRRRR.analyze._last;
      var geo = last && last.savedGeo;
      var obj = Object.assign({}, input, {
        source: "manual",
        lat: geo ? geo.lat : null, lng: geo ? geo.lng : null
      });
      if (obj.lat == null && input.address) {
        BRRRR.geo.geocode(input.address).then(function (g) {
          obj.lat = g.lat; obj.lng = g.lng;
          BRRRR.store.addProspect(obj);
          BRRRR.ui.toast("Saved “" + (input.name || "prospect") + "” to Deal Finder");
          BRRRR.finder.refresh();
        }).catch(function () {
          BRRRR.store.addProspect(obj); // save without pin
          BRRRR.ui.toast("Saved (address not geocoded — drop a pin in Deal Finder)");
          BRRRR.finder.refresh();
        });
      } else {
        BRRRR.store.addProspect(obj);
        BRRRR.ui.toast("Saved “" + (input.name || "prospect") + "” to Deal Finder");
        BRRRR.finder.refresh();
      }
    });

    el("btn-send-portfolio").addEventListener("click", function () {
      var last = BRRRR.analyze._last; if (!last) return;
      BRRRR.portfolio.addFromAnalysis(last);
    });

    toggleArv();
    recompute();
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.analyze = { init: init, recompute: recompute, loadProspect: loadProspect,
    readForm: readForm, _last: null };
})();
