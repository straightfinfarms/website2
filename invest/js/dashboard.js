/* =============================================================================
 * dashboard.js — Dashboard tab: KPIs, insight engine, integration roadmap
 * window.BRRRR.dashboard
 * ========================================================================== */
(function () {
  "use strict";
  var F = BRRRR.finance, fmt = F.fmtMoney;
  function el(id) { return document.getElementById(id); }

  function enrichHoldings() {
    return BRRRR.store.getPortfolio().map(function (h) {
      return { h: h, m: BRRRR.portfolio.metrics(h) };
    });
  }
  function enrichProspects() {
    return BRRRR.store.getProspects().map(function (p) {
      var r = F.analyze(p); return { p: p, r: r, s: F.scoreDeal(r) };
    });
  }

  function kpi(k, v, cls, sub) {
    return '<div class="kpi"><div class="k">' + k + '</div><div class="v ' + (cls || "") + '">' + v +
      '</div>' + (sub ? '<div class="alert" style="color:var(--muted)">' + sub + '</div>' : "") + '</div>';
  }

  function levelDot(level) {
    var c = level === "risk" ? "var(--pass)" : level === "opportunity" ? "var(--buy)" : "var(--accent)";
    return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + c + ';margin-right:7px"></span>';
  }

  function render() {
    var holdings = enrichHoldings();
    var prospects = enrichProspects();
    var ins = BRRRR.insights.generate(holdings, prospects);
    var s = ins.summary;

    // KPI strip
    el("dash-kpis").innerHTML =
      kpi("Portfolio value", fmt(s.value), "", s.count + " properties") +
      kpi("Equity", fmt(s.equity), "pos", Math.round(s.value ? s.equity / s.value * 100 : 0) + "% of value") +
      kpi("Monthly cash flow", fmt(s.cfMo), s.cfMo >= 0 ? "pos" : "neg", fmt(s.cfMo * 12) + "/yr") +
      kpi("Blended CoC", (isFinite(s.coc) ? s.coc.toFixed(1) : "—") + "%", "") +
      kpi("Portfolio LTV", Math.round(s.ltv * 100) + "%", s.ltv > 0.78 ? "neg" : "") +
      kpi("Extractable equity", fmt(s.extractable), "", "to 75% LTV");

    // Grow vs diversify hero
    var rc = ins.recommendation;
    el("dash-reco").innerHTML =
      '<div class="k" style="color:var(--muted);text-transform:uppercase;letter-spacing:.5px;font-size:12px">Strategic call</div>' +
      '<div class="verb ' + rc.tone + '" style="font-size:24px;font-weight:800;margin:4px 0">' + rc.verb + '</div>' +
      '<div class="note" style="color:var(--muted)">' + rc.note + '</div>';

    // Portfolio-level insights
    var pf = ins.portfolio.length ? ins.portfolio.map(function (c) {
      return '<div class="tile" style="text-align:left"><div>' + levelDot(c.level) +
        '<b>' + c.title + '</b></div><div class="note" style="color:var(--muted);font-size:12.5px;margin-top:4px">' + c.detail + '</div></div>';
    }).join("") : '<div class="hint">No portfolio-level flags. Add properties to unlock concentration & leverage analysis.</div>';
    el("dash-portfolio-insights").innerHTML = pf;

    // Per-property opportunities
    var pp = ins.perProperty.length ? ins.perProperty.map(function (p) {
      var cards = p.cards.map(function (c) {
        return '<div style="margin:6px 0">' + levelDot(c.level) + '<b>' + c.title + '</b>' +
          '<div class="note" style="color:var(--muted);font-size:12.5px;margin:2px 0 0 15px">' + c.detail + '</div></div>';
      }).join("");
      return '<div class="card" style="margin-bottom:12px;box-shadow:none;border:1px solid var(--line)">' +
        '<div style="display:flex;justify-content:space-between"><b>' + p.name + '</b>' +
        '<span class="tag">' + Math.round(p.ltv * 100) + '% LTV · ' + fmt(p.value) + '</span></div>' + cards + '</div>';
    }).join("") : '<div class="empty">Add properties in the Portfolio tab to see per-property growth opportunities.</div>';
    el("dash-property-insights").innerHTML = pp;
  }

  var INTEGRATIONS = [
    { k: "Bank & lenders", d: "Plaid / MX — auto-import balances, mortgage statements, transactions.", icon: "🏦" },
    { k: "Airbnb / STR", d: "Airbnb & Guesty — occupancy, nightly revenue, cleaning turnovers.", icon: "🏠" },
    { k: "Utilities", d: "Arcadia / Urjanet — electric, water, gas usage & bills per unit.", icon: "💡" },
    { k: "Accounting", d: "QuickBooks / Xero — sync the general ledger and P&L.", icon: "📒" },
    { k: "Public records", d: "County assessor & recorder — taxes, deeds, permits, comps.", icon: "🏛️" },
    { k: "Vendors & services", d: "Cleaning, maintenance, hospitality — dispatch & track work orders.", icon: "🧰" }
  ];
  function renderIntegrations() {
    el("dash-integrations").innerHTML = INTEGRATIONS.map(function (i) {
      return '<div class="tile" style="display:flex;gap:10px;align-items:flex-start">' +
        '<div style="font-size:22px">' + i.icon + '</div><div style="flex:1">' +
        '<div style="font-weight:700">' + i.k + '</div>' +
        '<div class="note" style="color:var(--muted);font-size:12px;margin:2px 0 6px">' + i.d + '</div>' +
        '<button class="btn ghost sm" data-connect="' + i.k + '">Connect</button></div></div>';
    }).join("");
  }

  function init() {
    renderIntegrations();
    document.addEventListener("click", function (e) {
      var c = e.target.closest("[data-connect]");
      if (c) {
        BRRRR.ui.modal(
          '<h2>Connect ' + c.getAttribute("data-connect") + '</h2>' +
          '<p class="hint">Live data connections use OAuth and require RealMo’s secure backend (Phase 2). ' +
          'They can’t run in this browser-only build because they need server-held API secrets and token storage.</p>' +
          '<p class="note" style="color:var(--muted)">On the roadmap this opens the provider’s secure login, ' +
          'and once authorized the dashboard streams live balances, revenue, usage and bills into your properties automatically.</p>' +
          '<div class="btnrow"><button class="btn" id="ci-ok">Got it</button></div>',
          function (root) { root.querySelector("#ci-ok").onclick = BRRRR.ui.closeModal; });
      }
    });
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.dashboard = { init: init, render: render };
})();
