/* =============================================================================
 * syndicate.js — Syndication tab: deals, cap table, investors, prospectus
 * window.BRRRR.syndicate
 * ========================================================================== */
(function () {
  "use strict";
  var F = BRRRR.finance, SY = BRRRR.syndication, fmt = F.fmtMoney;
  function el(id) { return document.getElementById(id); }
  function n(v, d) { var x = parseFloat(v); return isFinite(x) ? x : (d || 0); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var current = null; // selected deal id

  function render() {
    var deals = BRRRR.store.getDeals();
    var list = deals.length ? deals.map(function (d) {
      var m = SY.model(d);
      var badge = d.structure === "debt" ? "Debt · lenders" : "Equity · shares";
      return '<div class="tile" style="text-align:left;cursor:pointer" data-deal="' + d.id + '">' +
        '<div style="display:flex;justify-content:space-between;gap:8px">' +
        '<b>' + esc(d.name) + '</b><span class="tag">' + badge + '</span></div>' +
        '<div class="note" style="color:var(--muted);font-size:12px;margin-top:4px">' +
        (d.investors.length) + ' investor' + (d.investors.length === 1 ? '' : 's') + ' · raised ' +
        fmt(m.stack.raised) + (m.stack.gap > 1000 ? ' · gap ' + fmt(m.stack.gap) : ' · fully funded') + '</div></div>';
    }).join("") : '<div class="empty">No syndications yet. Create one to model a multi-investor deal.</div>';
    el("synd-list").innerHTML = list;
    if (current) renderDetail(current);
  }

  function structureFields(d) {
    var isDebt = d.structure === "debt";
    var common =
      row(f("s-purchasePrice", "Purchase price", d.purchasePrice), f("s-rehab", "Rehab", d.rehab)) +
      row(f("s-seniorLoan", "Senior loan (bank)", d.seniorLoan), f("s-seniorRatePct", "Senior rate %", d.seniorRatePct)) +
      row(f("s-projAnnualNOI", "Stabilized NOI / yr", d.projAnnualNOI), f("s-exitCapPct", "Exit cap %", d.exitCapPct));
    var eq =
      row(f("s-prefReturnPct", "Preferred return %", d.prefReturnPct), f("s-sponsorPromotePct", "Sponsor promote %", d.sponsorPromotePct)) +
      row(f("s-sponsorEquity", "Sponsor cash", d.sponsorEquity), f("s-holdYears", "Hold years", d.holdYears));
    var debt =
      row(f("s-lenderRatePct", "Lender premium % / yr", d.lenderRatePct), f("s-lenderTermYears", "Loan term (yrs)", d.lenderTermYears)) +
      '<p class="hint">Investors are lenders: fixed premium, interest-only, principal returned at term. They are NOT owners — the sponsor keeps all equity, cash flow above the premium, and appreciation.</p>';
    return common + '<h3>' + (isDebt ? "Debt terms" : "Equity terms") + '</h3>' + (isDebt ? debt : eq);
  }
  function f(id, lbl, val, type) {
    return '<div class="field"><label>' + lbl + '</label><input id="' + id + '" type="' + (type || "number") +
      '" value="' + (val != null ? esc(val) : "") + '"></div>';
  }
  function row(a, b) { return '<div class="row">' + a + b + '</div>'; }

  function gradeClass(x) { return x >= 1.8 ? "g-a" : x >= 1.4 ? "g-b" : x >= 1.1 ? "g-c" : "g-d"; }

  function renderDetail(id) {
    var d = BRRRR.store.getDeals().find(function (x) { return x.id === id; });
    if (!d) { el("synd-detail").innerHTML = '<div class="empty">Select a syndication.</div>'; return; }
    current = id;
    var m = SY.model(d);
    var isDebt = d.structure === "debt";

    // Cap stack summary
    var stack = m.stack;
    var stackHtml =
      '<div class="tiles">' +
      tile("Total project cost", fmt(stack.totalCost)) +
      tile("Senior debt", fmt(stack.senior)) +
      tile(isDebt ? "Lender capital" : "Equity raised", fmt(stack.raised)) +
      tile("Funding gap", fmt(stack.gap), stack.gap > 1000 ? "neg" : "pos") +
      (isDebt ? tile("Investor coverage", isFinite(m.coverage) ? m.coverage.toFixed(2) + "x" : "∞",
          m.coverage < 1.2 ? "neg" : "pos") :
        tile("Cash to equity / yr", fmt(m.annualCash), m.annualCash >= 0 ? "pos" : "neg")) +
      (isDebt ? tile("Sponsor residual / yr", fmt(m.sponsor.annualResidual)) :
        tile("Projected exit value", fmt(m.exitValue))) +
      '</div>';

    // Investor table
    var rows = m.investors.map(function (i) {
      var role = isDebt ? "Lender" : (i.share * 100).toFixed(1) + "% owner";
      return '<tr>' +
        '<td>' + esc(i.name) + (i.accredited ? ' <span class="tag">accredited</span>' : '') + '</td>' +
        '<td class="num">' + fmt(i.amount) + '</td>' +
        '<td>' + role + '</td>' +
        '<td class="num">' + fmt(i.annualCash) + '</td>' +
        '<td class="num">' + fmt(i.totalProfit) + '</td>' +
        '<td class="num"><span class="pill ' + gradeClass(i.equityMultiple) + '">' + i.equityMultiple.toFixed(2) + 'x</span></td>' +
        '<td class="num">' + i.avgAnnualPct.toFixed(1) + '%</td>' +
        '<td><button class="btn ghost sm" data-invview="' + i.id + '">View</button> ' +
        '<button class="btn danger sm" data-invdel="' + i.id + '">✕</button></td></tr>';
    }).join("");
    var invTable = m.investors.length ?
      '<table><thead><tr><th>Investor</th><th class="num">' + (isDebt ? "Loan" : "Contribution") +
      '</th><th>Position</th><th class="num">Cash/yr</th><th class="num">Total profit</th>' +
      '<th class="num">Multiple</th><th class="num">~Ann.</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' :
      '<div class="empty">No investors yet. Add investors to build the cap table.</div>';

    el("synd-detail").innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<h2 style="margin:0">' + esc(d.name) + '</h2>' +
        '<span class="tag">' + (isDebt ? "Debt · investors as lenders" : "Equity · shareholders") + '</span>' +
        '<div style="margin-left:auto" class="btnrow">' +
          '<button class="btn sm" id="synd-addinv">+ Investor</button>' +
          '<button class="btn ghost sm" id="synd-edit">Edit terms</button>' +
          '<button class="btn ghost sm" id="synd-prospectus">Prospectus</button>' +
          '<button class="btn danger sm" id="synd-del">Delete</button>' +
        '</div></div>' +
      '<h3>Capital stack</h3>' + stackHtml +
      '<h3>Investors &amp; projected returns</h3>' +
      '<div style="overflow:auto">' + invTable + '</div>' +
      '<p class="hint">Projections are pro-forma for modeling & reporting only — not an offer of securities. ' +
      'Raising capital from investors is regulated; see the compliance note.</p>';
  }
  function tile(k, v, cls) {
    return '<div class="tile"><div class="k">' + k + '</div><div class="v ' + (cls || "") + '">' + v + '</div></div>';
  }

  /* ---- Editors ---- */
  function openDealEditor(existing) {
    var d = Object.assign({}, SY.DEFAULTS, existing || {});
    var isEdit = !!existing;
    BRRRR.ui.modal(
      '<h2>' + (isEdit ? "Edit syndication" : "New syndication") + '</h2>' +
      '<div class="field"><label>Deal name</label><input id="s-name" value="' + esc(d.name) + '"></div>' +
      '<div class="field"><label>Structure</label><select id="s-structure">' +
        '<option value="equity"' + (d.structure === "equity" ? " selected" : "") + '>Equity — investors are shareholders</option>' +
        '<option value="debt"' + (d.structure === "debt" ? " selected" : "") + '>Debt — investors are lenders paid a premium</option>' +
      '</select></div>' +
      '<div id="s-structfields">' + structureFields(d) + '</div>' +
      '<div class="btnrow"><button class="btn" id="s-save">' + (isEdit ? "Save" : "Create") + '</button>' +
      '<button class="btn ghost" id="s-cancel">Cancel</button></div>',
      function (root) {
        function collect() {
          var o = { name: root.querySelector("#s-name").value, structure: root.querySelector("#s-structure").value };
          ["purchasePrice", "rehab", "seniorLoan", "seniorRatePct", "projAnnualNOI", "exitCapPct",
           "prefReturnPct", "sponsorPromotePct", "sponsorEquity", "holdYears",
           "lenderRatePct", "lenderTermYears"].forEach(function (k) {
            var node = root.querySelector("#s-" + k); if (node) o[k] = n(node.value);
          });
          return o;
        }
        root.querySelector("#s-structure").addEventListener("change", function () {
          var merged = Object.assign({}, SY.DEFAULTS, collect());
          root.querySelector("#s-structfields").innerHTML = structureFields(merged);
        });
        root.querySelector("#s-cancel").onclick = BRRRR.ui.closeModal;
        root.querySelector("#s-save").onclick = function () {
          var o = collect();
          if (isEdit) BRRRR.store.updateDeal(existing.id, o);
          else { var created = BRRRR.store.addDeal(o); current = created.id; }
          BRRRR.ui.closeModal(); BRRRR.ui.toast(isEdit ? "Deal updated" : "Syndication created"); render();
        };
      });
  }

  function openInvestorEditor(dealId) {
    BRRRR.ui.modal(
      '<h2>Add investor</h2>' +
      '<div class="field"><label>Name</label><input id="i-name" value=""></div>' +
      '<div class="field"><label>Contribution / loan ($)</label><input id="i-amount" type="number" value="25000"></div>' +
      '<div class="field"><label><input id="i-acc" type="checkbox" style="width:auto;margin-right:6px">Accredited investor (self-attested)</label></div>' +
      '<p class="hint">Verifying accredited status and collecting subscription docs happens in the compliant onboarding flow (Phase 2).</p>' +
      '<div class="btnrow"><button class="btn" id="i-save">Add</button>' +
      '<button class="btn ghost" id="i-cancel">Cancel</button></div>',
      function (root) {
        root.querySelector("#i-cancel").onclick = BRRRR.ui.closeModal;
        root.querySelector("#i-save").onclick = function () {
          var d = BRRRR.store.getDeals().find(function (x) { return x.id === dealId; });
          if (!d) return;
          d.investors.push({ id: BRRRR.store.uid(), name: root.querySelector("#i-name").value || "Investor",
            amount: n(root.querySelector("#i-amount").value), accredited: root.querySelector("#i-acc").checked });
          BRRRR.store.updateDeal(dealId, { investors: d.investors });
          BRRRR.ui.closeModal(); BRRRR.ui.toast("Investor added"); render();
        };
      });
  }

  /* ---- Per-investor transparency view ---- */
  function investorView(dealId, invId) {
    var d = BRRRR.store.getDeals().find(function (x) { return x.id === dealId; });
    var m = SY.model(d);
    var i = m.investors.find(function (x) { return x.id === invId; });
    if (!i) return;
    var isDebt = d.structure === "debt";
    BRRRR.ui.modal(
      '<h2>' + esc(i.name) + '</h2>' +
      '<p class="hint">Deal: <b>' + esc(d.name) + '</b> · ' + (isDebt ? "Lender position" : "Equity position") + '</p>' +
      '<div class="tiles">' +
        tile(isDebt ? "Amount lent" : "Capital contributed", fmt(i.amount)) +
        tile(isDebt ? "Position" : "Ownership", isDebt ? "Secured lender" : (i.share * 100).toFixed(1) + "%") +
        tile(isDebt ? "Premium / yr" : "Cash distributions / yr", fmt(i.annualCash)) +
        tile("Projected total profit", fmt(i.totalProfit), "pos") +
        tile("Equity multiple", i.equityMultiple.toFixed(2) + "x") +
        tile("Avg annual return", i.avgAnnualPct.toFixed(1) + "%") +
      '</div>' +
      '<p class="note" style="color:var(--muted);margin-top:12px">' +
      (isDebt ?
        "As a lender you receive a fixed " + d.lenderRatePct + "% premium on your principal, paid from the property’s cash flow, with principal returned at the end of the " + d.lenderTermYears + "-year term. You do not share in appreciation or losses of the asset." :
        "As a shareholder you own " + (i.share * 100).toFixed(1) + "% of the SPV, earn a " + d.prefReturnPct + "% preferred return, then share in cash flow and sale profit after the sponsor’s " + d.sponsorPromotePct + "% promote.") +
      '</p>' +
      '<p class="hint">This is each partner’s live, transparent position. In Phase 2 every investor logs into their own secure portal showing exactly this, plus statements and documents.</p>' +
      '<div class="btnrow"><button class="btn" id="iv-ok">Close</button></div>',
      function (root) { root.querySelector("#iv-ok").onclick = BRRRR.ui.closeModal; });
  }

  /* ---- Prospectus (the shareable "perspective") ---- */
  function prospectus(dealId) {
    var d = BRRRR.store.getDeals().find(function (x) { return x.id === dealId; });
    var m = SY.model(d);
    var isDebt = d.structure === "debt";
    var terms = isDebt ?
      '<tr><td>Investor role</td><td>Secured lender (not an owner)</td></tr>' +
      '<tr><td>Premium</td><td>' + d.lenderRatePct + '% / yr, interest-only</td></tr>' +
      '<tr><td>Term</td><td>' + d.lenderTermYears + ' years, principal returned at maturity</td></tr>' +
      '<tr><td>Coverage</td><td>' + (isFinite(m.coverage) ? m.coverage.toFixed(2) + 'x' : '∞') + ' NOI-after-senior ÷ premium</td></tr>' :
      '<tr><td>Investor role</td><td>Equity shareholder in the SPV</td></tr>' +
      '<tr><td>Preferred return</td><td>' + d.prefReturnPct + '% / yr</td></tr>' +
      '<tr><td>Sponsor promote</td><td>' + d.sponsorPromotePct + '% of profit above pref</td></tr>' +
      '<tr><td>Hold / exit</td><td>' + d.holdYears + ' yrs · projected exit ' + fmt(m.exitValue) + '</td></tr>';
    var invRows = m.investors.map(function (i) {
      return '<tr><td>' + esc(i.name) + '</td><td style="text-align:right">' + fmt(i.amount) + '</td>' +
        '<td style="text-align:right">' + (isDebt ? "lender" : (i.share * 100).toFixed(1) + "%") + '</td>' +
        '<td style="text-align:right">' + i.equityMultiple.toFixed(2) + 'x</td>' +
        '<td style="text-align:right">' + i.avgAnnualPct.toFixed(1) + '%</td></tr>';
    }).join("");

    var html =
      '<h2 style="margin-top:0">Investment Prospectus — ' + esc(d.name) + '</h2>' +
      '<p class="hint">Generated ' + new Date().toISOString().slice(0, 10) + ' · pro-forma, for discussion only</p>' +
      '<h3>The opportunity</h3>' +
      '<table><tbody>' +
      '<tr><td>All-in project cost</td><td style="text-align:right">' + fmt(m.stack.totalCost) + '</td></tr>' +
      '<tr><td>Senior financing</td><td style="text-align:right">' + fmt(m.stack.senior) + '</td></tr>' +
      '<tr><td>Capital to raise</td><td style="text-align:right">' + fmt(m.stack.raised + Math.max(0, m.stack.gap)) + '</td></tr>' +
      '<tr><td>Stabilized NOI</td><td style="text-align:right">' + fmt(d.projAnnualNOI) + '/yr</td></tr>' +
      '</tbody></table>' +
      '<h3>Terms</h3><table><tbody>' + terms + '</tbody></table>' +
      '<h3>Investors</h3><table><thead><tr><th>Name</th><th style="text-align:right">Amount</th>' +
      '<th style="text-align:right">Stake</th><th style="text-align:right">Multiple</th><th style="text-align:right">~Ann.</th></tr></thead>' +
      '<tbody>' + (invRows || '<tr><td colspan="5">Open for subscription</td></tr>') + '</tbody></table>' +
      '<p class="hint" style="margin-top:14px">This document is a financial model, not an offer to sell or a solicitation to buy any security. ' +
      'Any actual offering must comply with applicable securities laws and be made only through definitive legal documents reviewed by counsel.</p>' +
      '<div class="btnrow"><button class="btn" id="pr-print">Print / Save PDF</button>' +
      '<button class="btn ghost" id="pr-close">Close</button></div>';
    BRRRR.ui.modal(html, function (root) {
      root.querySelector("#pr-close").onclick = BRRRR.ui.closeModal;
      root.querySelector("#pr-print").onclick = function () { window.print(); };
    });
  }

  function init() {
    el("synd-new").addEventListener("click", function () { openDealEditor(null); });
    document.addEventListener("click", function (e) {
      var d = e.target.closest("[data-deal]");
      if (d) { renderDetail(d.getAttribute("data-deal")); return; }
      if (e.target.id === "synd-addinv") { openInvestorEditor(current); return; }
      if (e.target.id === "synd-edit") {
        openDealEditor(BRRRR.store.getDeals().find(function (x) { return x.id === current; })); return; }
      if (e.target.id === "synd-prospectus") { prospectus(current); return; }
      if (e.target.id === "synd-del") {
        if (confirm("Delete this syndication?")) { BRRRR.store.removeDeal(current); current = null; render(); }
        return; }
      var iv = e.target.closest("[data-invview]");
      if (iv) { investorView(current, iv.getAttribute("data-invview")); return; }
      var idl = e.target.closest("[data-invdel]");
      if (idl) {
        var deal = BRRRR.store.getDeals().find(function (x) { return x.id === current; });
        if (deal) { deal.investors = deal.investors.filter(function (x) { return x.id !== idl.getAttribute("data-invdel"); });
          BRRRR.store.updateDeal(current, { investors: deal.investors }); render(); }
        return; }
    });
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.syndicate = { init: init, render: render };
})();
