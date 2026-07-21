/* =============================================================================
 * portfolio.js — Portfolio tab: track & monitor properties under management
 * window.BRRRR.portfolio
 * ========================================================================== */
(function () {
  "use strict";
  var F = BRRRR.finance, fmt = F.fmtMoney;

  function el(id) { return document.getElementById(id); }
  function n(v, d) { var x = parseFloat(v); return isFinite(x) ? x : (d || 0); }

  /* Derive live monitoring metrics for one holding. */
  function metrics(h) {
    var units = Math.max(1, n(h.units, 1));
    var occ = n(h.occupancyPct, 100) / 100;
    var grossMo = n(h.monthlyRent) * occ + n(h.otherIncomeMo);
    var opexMo = h.monthlyExpenses != null && h.monthlyExpenses !== "" ?
      n(h.monthlyExpenses) : grossMo * n(h.expenseRatioPct, 45) / 100;
    var noiMo = grossMo - opexMo;
    var debtMo = h.debtServiceMo != null && h.debtServiceMo !== "" ?
      n(h.debtServiceMo) : F.monthlyPayment(n(h.loanBalance), n(h.loanRate, 7), n(h.loanTermYears, 30));
    var cfMo = noiMo - debtMo;
    var equity = n(h.currentValue) - n(h.loanBalance);
    var dscr = debtMo > 0 ? noiMo / debtMo : Infinity;
    // BRRRR basis: all-in cost = purchase + rehab. Cash still tied up after the
    // refinance ≈ basis − current loan (the loan already handed back the rest).
    var basis = n(h.purchasePrice) + n(h.rehabInvested);
    var estCashLeft = Math.max(0, basis - n(h.loanBalance));
    var valueAdded = basis > 0 ? n(h.currentValue) - basis : 0;
    // Use the entered figure if given, else the estimate from the basis.
    var cashInvested = (h.cashInvested != null && h.cashInvested !== "") ?
      n(h.cashInvested) : (basis > 0 ? estCashLeft : 0);
    var coc = cashInvested > 0 ? cfMo * 12 / cashInvested * 100 : Infinity;
    var capRate = n(h.currentValue) > 0 ? noiMo * 12 / n(h.currentValue) * 100 : 0;
    var alerts = [];
    if (cfMo < 0) alerts.push("Negative cash flow");
    if (isFinite(dscr) && dscr < 1.2) alerts.push("DSCR below 1.2");
    if (n(h.occupancyPct, 100) < 90) alerts.push("Occupancy " + n(h.occupancyPct, 100) + "%");
    return { units: units, grossMo: grossMo, noiMo: noiMo, debtMo: debtMo, cfMo: cfMo,
      equity: equity, dscr: dscr, coc: coc, capRate: capRate, alerts: alerts,
      basis: basis, estCashLeft: estCashLeft, valueAdded: valueAdded, cashInvested: cashInvested };
  }

  function renderKPIs(list) {
    var totVal = 0, totLoan = 0, totCF = 0, totUnits = 0, totNOI = 0, totDebt = 0,
      totInvested = 0, occNum = 0, occDen = 0;
    list.forEach(function (h) {
      var m = metrics(h);
      totVal += n(h.currentValue); totLoan += n(h.loanBalance);
      totCF += m.cfMo; totUnits += m.units; totNOI += m.noiMo; totDebt += m.debtMo;
      totInvested += m.cashInvested;
      occNum += n(h.occupancyPct, 100) * m.units; occDen += m.units;
    });
    var equity = totVal - totLoan;
    var pDscr = totDebt > 0 ? totNOI / totDebt : Infinity;
    var pCoc = totInvested > 0 ? totCF * 12 / totInvested * 100 : Infinity;
    var occ = occDen > 0 ? occNum / occDen : 0;

    function kpi(k, v, cls, sub) {
      return '<div class="kpi"><div class="k">' + k + '</div><div class="v ' + (cls || "") + '">' + v +
        '</div>' + (sub ? '<div class="alert" style="color:var(--muted)">' + sub + '</div>' : "") + '</div>';
    }
    el("kpis").innerHTML =
      kpi("Portfolio value", fmt(totVal), "", list.length + " properties · " + totUnits + " units") +
      kpi("Total equity", fmt(equity), "pos", Math.round(totVal ? equity / totVal * 100 : 0) + "% of value") +
      kpi("Monthly cash flow", fmt(totCF), totCF >= 0 ? "pos" : "neg", fmt(totCF * 12) + " / yr") +
      kpi("Cash-on-cash", isFinite(pCoc) ? pCoc.toFixed(1) + "%" : "∞", "", "on " + fmt(totInvested) + " invested") +
      kpi("Portfolio DSCR", isFinite(pDscr) ? pDscr.toFixed(2) + "x" : "∞", pDscr < 1.2 ? "neg" : "", "NOI ÷ debt service") +
      kpi("Avg occupancy", Math.round(occ) + "%", occ < 90 ? "neg" : "");
  }

  function renderTable(list) {
    var tb = el("port-table").querySelector("tbody");
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="10" class="empty">No properties yet. Click “+ Add property”, or send a deal here from the Analyzer.</td></tr>';
      return;
    }
    tb.innerHTML = list.map(function (h) {
      var m = metrics(h);
      var status = m.alerts.length ?
        '<span style="color:var(--warn)">⚠ ' + m.alerts.join(", ") + '</span>' :
        '<span style="color:var(--buy)">✓ Healthy</span>';
      return '<tr>' +
        '<td>' + (h.name || "—") + '<div style="color:var(--faint);font-size:11px">' + (h.address || "") +
        (h.acquiredAt ? " · since " + h.acquiredAt : "") + '</div></td>' +
        '<td class="num">' + m.units + '</td>' +
        '<td class="num">' + fmt(h.currentValue) + '</td>' +
        '<td class="num">' + fmt(h.loanBalance) + '</td>' +
        '<td class="num">' + fmt(m.equity) + '</td>' +
        '<td class="num" style="color:' + (m.cfMo >= 0 ? "var(--buy)" : "var(--pass)") + '">' + fmt(m.cfMo) + '</td>' +
        '<td class="num">' + (isFinite(m.dscr) ? m.dscr.toFixed(2) : "∞") + '</td>' +
        '<td class="num">' + (isFinite(m.coc) ? m.coc.toFixed(1) + "%" : "∞") + '</td>' +
        '<td style="font-size:12px">' + status + '</td>' +
        '<td><button class="btn ghost sm" data-edit-h="' + h.id + '">Edit</button> ' +
        '<button class="btn danger sm" data-del-h="' + h.id + '">✕</button></td>' +
        '</tr>';
    }).join("");
  }

  function refresh() {
    var list = BRRRR.store.getPortfolio();
    renderKPIs(list);
    renderTable(list);
  }

  function fieldRow(h) {
    h = h || {};
    function tip(text) {
      return ' <span class="tip" title="' + text.replace(/"/g, "&quot;") + '">&#9432;</span>';
    }
    function f(id, lbl, val, opts) {
      opts = opts || {};
      return '<div class="field"><label>' + lbl + (opts.tip ? tip(opts.tip) : "") + '</label>' +
        '<input id="h-' + id + '" type="' + (opts.type || "number") + '"' +
        (opts.placeholder ? ' placeholder="' + opts.placeholder + '"' : "") +
        ' value="' + (val != null && val !== "" ? String(val).replace(/"/g, "&quot;") : "") + '"></div>';
    }
    return '<div class="field"><label>Property name</label><input id="h-name" value="' +
        (h.name || "").replace(/"/g, "&quot;") + '"></div>' +
      '<div class="field"><label>Address</label><input id="h-address" value="' +
        (h.address || "").replace(/"/g, "&quot;") + '"></div>' +
      '<div class="split">' +
        '<div>' +
          f("units", "Units", h.units != null ? h.units : 4) +
          f("monthlyRent", "Gross rent / mo", h.monthlyRent != null ? h.monthlyRent : 4800) +
          f("otherIncomeMo", "Other income / mo", h.otherIncomeMo || 0) +
          f("occupancyPct", "Occupancy %", h.occupancyPct != null ? h.occupancyPct : 95) +
          f("monthlyExpenses", "OpEx / mo", h.monthlyExpenses,
            { placeholder: "blank = use ratio", tip: "Actual monthly operating expenses (taxes, insurance, repairs, mgmt, reserves — NOT the mortgage). Leave blank to estimate from the expense ratio." }) +
          f("expenseRatioPct", "Expense ratio %", h.expenseRatioPct != null ? h.expenseRatioPct : 45,
            { tip: "Fallback: operating expenses as a % of collected rent, used only when OpEx/mo is blank. ~45–50% is typical for small multifamily." }) +
        '</div>' +
        '<div>' +
          f("currentValue", "Current value", h.currentValue != null ? h.currentValue : 640000,
            { tip: "Today's market value (your estimate or a broker/appraiser figure)." }) +
          f("loanBalance", "Loan balance", h.loanBalance != null ? h.loanBalance : 480000,
            { tip: "Current outstanding mortgage principal." }) +
          f("loanRate", "Loan rate %", h.loanRate != null ? h.loanRate : 7.25) +
          f("loanTermYears", "Loan term yrs", h.loanTermYears != null ? h.loanTermYears : 30) +
          f("debtServiceMo", "Debt svc / mo", h.debtServiceMo,
            { placeholder: "blank = calc", tip: "Monthly principal + interest. Leave blank to compute from loan balance, rate and term." }) +
          f("purchasePrice", "Purchase price", h.purchasePrice,
            { tip: "What you paid to acquire it. Part of your all-in basis and needed to estimate cash left in the deal." }) +
          f("rehabInvested", "Rehab invested", h.rehabInvested,
            { tip: "Total rehab / capital you put in to force value. The 'BRRRR cost' — added to purchase price to get your all-in basis." }) +
          f("cashInvested", "Cash left in deal", h.cashInvested,
            { placeholder: "blank = auto-estimate", tip: "Your own cash still tied up after refinancing = (purchase price + rehab) − current loan balance. This is the base for cash-on-cash return. $0 or negative means you pulled all your capital back out (the BRRRR win). Different from equity, which is value − loan. Leave blank to auto-estimate." }) +
          '<div class="hint" id="h-est-note" style="margin:-4px 0 10px"></div>' +
          f("acquiredAt", "Acquired (YYYY-MM-DD)", h.acquiredAt || new Date().toISOString().slice(0, 10), { type: "text" }) +
        '</div>' +
      '</div>';
  }

  function readHolding(root, base) {
    var ids = ["name", "address", "units", "monthlyRent", "otherIncomeMo", "occupancyPct",
      "monthlyExpenses", "expenseRatioPct", "currentValue", "loanBalance", "loanRate",
      "loanTermYears", "debtServiceMo", "purchasePrice", "rehabInvested", "cashInvested", "acquiredAt"];
    var o = Object.assign({}, base || {});
    ids.forEach(function (id) {
      var node = root.querySelector("#h-" + id);
      if (!node) return;
      o[id] = (id === "name" || id === "address" || id === "acquiredAt") ? node.value : node.value;
    });
    return o;
  }

  function openEditor(existing) {
    var isEdit = !!existing;
    BRRRR.ui.modal(
      '<h2>' + (isEdit ? "Edit property" : "Add property") + '</h2>' +
      '<p class="hint">Hover any &#9432; for help. Blank OpEx, debt-service and cash-left fields are auto-estimated. Metrics update on save.</p>' +
      fieldRow(existing) +
      '<div class="btnrow"><button class="btn" id="h-save">' + (isEdit ? "Save changes" : "Add property") + '</button>' +
      '<button class="btn ghost" id="h-cancel">Cancel</button></div>',
      function (root) {
        // Live "cash left in deal" estimate from the BRRRR basis.
        function q(id) { return root.querySelector("#h-" + id); }
        function updateEstimate() {
          var basis = n(q("purchasePrice").value) + n(q("rehabInvested").value);
          var loan = n(q("loanBalance").value), val = n(q("currentValue").value);
          var note = root.querySelector("#h-est-note");
          var est = Math.max(0, basis - loan);
          if (basis > 0) {
            q("cashInvested").placeholder = "auto: " + fmt(est);
            var valueAdded = val - basis, equity = val - loan;
            note.innerHTML = "All-in basis " + fmt(basis) + " &middot; est. cash left " +
              "<b style='color:" + (est <= 0 ? "var(--buy)" : "var(--ink)") + "'>" + fmt(est) + "</b>" +
              (est <= 0 ? " (all capital recovered)" : "") +
              " &middot; value added " + fmt(valueAdded) + " &middot; equity " + fmt(equity);
          } else {
            q("cashInvested").placeholder = "enter, or add purchase + rehab to estimate";
            note.textContent = "Add purchase price and rehab to auto-estimate cash left in the deal.";
          }
        }
        ["purchasePrice", "rehabInvested", "loanBalance", "currentValue"].forEach(function (id) {
          q(id).addEventListener("input", updateEstimate);
        });
        updateEstimate();

        root.querySelector("#h-cancel").onclick = BRRRR.ui.closeModal;
        root.querySelector("#h-save").onclick = function () {
          var o = readHolding(root, existing);
          if (isEdit) BRRRR.store.updateHolding(existing.id, o);
          else BRRRR.store.addHolding(o);
          BRRRR.ui.closeModal();
          BRRRR.ui.toast(isEdit ? "Property updated" : "Property added to portfolio");
          refresh();
        };
      });
  }

  /* Prefill from an Analyzer result (post-refi, stabilized). */
  function addFromAnalysis(last) {
    var i = last.input, r = last.result;
    var h = {
      name: i.name || "New hold", address: i.address || "",
      units: i.units, monthlyRent: r.grossRentMo, otherIncomeMo: 0,
      occupancyPct: 100 - (i.vacancyPct || 0),
      monthlyExpenses: Math.round(r.opex / 12),
      expenseRatioPct: Math.round(r.expenseRatio * 100),
      currentValue: Math.round(r.arv), loanBalance: Math.round(r.refiLoan),
      loanRate: i.refiRate, loanTermYears: i.refiTermYears,
      debtServiceMo: Math.round(r.refiPmt),
      purchasePrice: Math.round(i.price), rehabInvested: Math.round(i.rehab),
      cashInvested: Math.max(0, Math.round(r.cashLeftInDeal))
    };
    openEditor(null);
    // Prefill the just-opened modal.
    setTimeout(function () {
      var root = el("modal");
      Object.keys(h).forEach(function (k) {
        var node = root.querySelector("#h-" + k);
        if (node) node.value = h[k];
      });
    }, 0);
  }

  function exportData() {
    var data = JSON.stringify(BRRRR.store.exportAll(), null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "brrrr-data.json"; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function importData() {
    var input = document.createElement("input");
    input.type = "file"; input.accept = "application/json";
    input.onchange = function () {
      var file = input.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try { BRRRR.store.importAll(JSON.parse(reader.result));
          BRRRR.ui.toast("Data imported"); refresh(); BRRRR.finder.refresh(); }
        catch (e) { BRRRR.ui.toast("Invalid file"); }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  function init() {
    el("btn-add-holding").addEventListener("click", function () { openEditor(null); });
    el("btn-export").addEventListener("click", exportData);
    el("btn-import").addEventListener("click", importData);
    document.addEventListener("click", function (e) {
      var ed = e.target.closest("[data-edit-h]");
      if (ed) {
        var h = BRRRR.store.getPortfolio().find(function (x) { return x.id === ed.getAttribute("data-edit-h"); });
        if (h) openEditor(h);
        return;
      }
      var del = e.target.closest("[data-del-h]");
      if (del && confirm("Remove this property from your portfolio?")) {
        BRRRR.store.removeHolding(del.getAttribute("data-del-h")); refresh();
      }
    });
    refresh();
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.portfolio = { init: init, refresh: refresh, addFromAnalysis: addFromAnalysis, metrics: metrics };
})();
