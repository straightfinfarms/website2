/* =============================================================================
 * syndication.js — capital-stack & investor-return model (pure)
 * window.BRRRR.syndication
 *
 * Two structures:
 *   "equity" — investors are shareholders. They own a pro-rata slice of the
 *              SPV, earn a preferred return, then split remaining cash and the
 *              sale profit with the sponsor (who may take a promote).
 *   "debt"   — investors are LENDERS paid a premium. They do NOT own the asset;
 *              they earn a fixed rate on their principal for a term and get
 *              principal back at exit. The sponsor keeps all equity upside.
 *
 * All figures are pro-forma projections for modeling and investor reporting —
 * NOT an offer, and NOT a substitute for securities counsel.
 * ========================================================================== */
(function () {
  "use strict";
  var fmt = BRRRR.finance.fmtMoney;
  function n(v, d) { var x = parseFloat(v); return isFinite(x) ? x : (d || 0); }

  var DEFAULTS = {
    name: "New Syndication",
    structure: "equity",            // "equity" | "debt"
    purchasePrice: 250000, rehab: 50000, closingPct: 3,
    seniorLoan: 0,                  // bank/senior mortgage (ahead of investors)
    seniorRatePct: 7.25, seniorTermYears: 30,
    projAnnualNOI: 30000,           // stabilized NOI
    appreciationPct: 3,             // annual value growth
    holdYears: 5,
    exitCapPct: 7.0,                // cap rate at sale (income exit); 0 -> use appreciation
    // equity params
    prefReturnPct: 8,               // annual preferred return to LP equity
    sponsorPromotePct: 20,          // sponsor carry on profit above pref
    sponsorEquity: 0,               // sponsor's own cash in the equity
    // debt params
    lenderRatePct: 10,              // premium paid to investor-lenders
    lenderTermYears: 3,
    investors: []                   // [{id,name,amount,accredited}]
  };

  function projectValueAtExit(d) {
    var basis = n(d.purchasePrice) + n(d.rehab);
    if (n(d.exitCapPct) > 0 && n(d.projAnnualNOI) > 0) {
      return n(d.projAnnualNOI) / (n(d.exitCapPct) / 100);   // income exit
    }
    return basis * Math.pow(1 + n(d.appreciationPct) / 100, n(d.holdYears)); // appreciation exit
  }

  function seniorDebtService(d) {
    return BRRRR.finance.monthlyPayment(n(d.seniorLoan), n(d.seniorRatePct), n(d.seniorTermYears)) * 12;
  }

  function capitalStack(d) {
    var totalCost = n(d.purchasePrice) + n(d.rehab) + n(d.purchasePrice) * n(d.closingPct) / 100;
    var raised = (d.investors || []).reduce(function (s, i) { return s + n(i.amount); }, 0);
    var sponsorCash = d.structure === "equity" ? n(d.sponsorEquity) : 0;
    var funded = n(d.seniorLoan) + raised + sponsorCash;
    return { totalCost: totalCost, raised: raised, sponsorCash: sponsorCash,
      senior: n(d.seniorLoan), funded: funded, gap: totalCost - funded };
  }

  /* ---- EQUITY: pro-rata ownership, preferred return, then promote split ---- */
  function equityModel(d) {
    var stack = capitalStack(d);
    var totalEquity = stack.raised + stack.sponsorCash;
    var noi = n(d.projAnnualNOI);
    var annualCash = noi - seniorDebtService(d);           // cash available to equity
    var hold = Math.max(1, n(d.holdYears));

    // Exit
    var exitValue = projectValueAtExit(d);
    var sellCosts = exitValue * 0.06;                       // ~6% disposition
    // Senior loan roughly amortized — approximate remaining balance.
    var seniorRemaining = approxRemainingBalance(n(d.seniorLoan), n(d.seniorRatePct), n(d.seniorTermYears), hold);
    var netSaleEquity = exitValue - sellCosts - seniorRemaining;
    var saleProfit = netSaleEquity - totalEquity;          // gain returned above capital

    var investors = (d.investors || []).map(function (inv) {
      var share = totalEquity > 0 ? n(inv.amount) / totalEquity : 0;
      // Annual: preferred return first (accrues on capital), pro-rata within LP.
      var pref = n(inv.amount) * n(d.prefReturnPct) / 100;
      // Cash after total pref & sponsor promote handled at portfolio level below.
      return { id: inv.id, name: inv.name, amount: n(inv.amount), accredited: !!inv.accredited,
        share: share, pref: pref };
    });

    // Distribute annual cash: pay pref (pro-rata if short), promote on residual.
    var totalPref = investors.reduce(function (s, i) { return s + i.pref; }, 0);
    var payPref = Math.min(annualCash, totalPref);
    var residual = Math.max(0, annualCash - totalPref);
    var promote = residual * n(d.sponsorPromotePct) / 100;
    var lpResidual = residual - promote;
    investors.forEach(function (i) {
      var prefPaid = totalPref > 0 ? payPref * (i.pref / totalPref) : 0;
      var resShare = totalEquity > 0 ? lpResidual * (i.amount / totalEquity) : 0;
      i.annualCash = prefPaid + resShare;
      // Sale profit split: pro-rata of LP portion after sponsor promote on gain.
      var gainPromote = Math.max(0, saleProfit) * n(d.sponsorPromotePct) / 100;
      var lpGain = Math.max(0, saleProfit) - gainPromote;
      i.saleProfit = totalEquity > 0 ? lpGain * (i.amount / totalEquity) : 0;
      i.totalProfit = i.annualCash * hold + i.saleProfit;
      i.equityMultiple = i.amount > 0 ? (i.amount + i.totalProfit) / i.amount : 0;
      i.avgAnnualPct = i.amount > 0 ? i.totalProfit / hold / i.amount * 100 : 0;
    });

    var sponsorAnnualPromote = promote;
    var sponsorGainPromote = Math.max(0, saleProfit) * n(d.sponsorPromotePct) / 100;

    return { structure: "equity", stack: stack, totalEquity: totalEquity,
      annualCash: annualCash, dscrToInvestors: annualCash >= 0 ? Infinity : 0,
      exitValue: exitValue, netSaleEquity: netSaleEquity, saleProfit: saleProfit,
      investors: investors, hold: hold,
      sponsor: { annualPromote: sponsorAnnualPromote, gainPromote: sponsorGainPromote,
        cash: stack.sponsorCash } };
  }

  /* ---- DEBT: investors are lenders, fixed premium, principal back at term ---- */
  function debtModel(d) {
    var stack = capitalStack(d);
    var noi = n(d.projAnnualNOI);
    var seniorDS = seniorDebtService(d);
    var rate = n(d.lenderRatePct) / 100;
    var hold = Math.max(1, n(d.lenderTermYears));

    var investors = (d.investors || []).map(function (inv) {
      var annualInterest = n(inv.amount) * rate;           // interest-only premium
      var totalInterest = annualInterest * hold;
      return { id: inv.id, name: inv.name, amount: n(inv.amount), accredited: !!inv.accredited,
        annualCash: annualInterest, totalInterest: totalInterest,
        totalProfit: totalInterest, equityMultiple: n(inv.amount) > 0 ? (n(inv.amount) + totalInterest) / n(inv.amount) : 0,
        avgAnnualPct: n(d.lenderRatePct) };
    });

    var totalLenderInterest = investors.reduce(function (s, i) { return s + i.annualCash; }, 0);
    var cashAfterSenior = noi - seniorDS;
    // Coverage: can the property service investor interest after the senior loan?
    var coverage = totalLenderInterest > 0 ? cashAfterSenior / totalLenderInterest : Infinity;
    var sponsorResidual = cashAfterSenior - totalLenderInterest; // sponsor keeps the rest + all equity upside

    var exitValue = projectValueAtExit(d);

    return { structure: "debt", stack: stack, hold: hold,
      investors: investors, totalLenderInterest: totalLenderInterest,
      cashAfterSenior: cashAfterSenior, coverage: coverage, dscrToInvestors: coverage,
      exitValue: exitValue,
      sponsor: { annualResidual: sponsorResidual, keepsEquity: true } };
  }

  function approxRemainingBalance(loan, ratePct, termYears, afterYears) {
    loan = n(loan); if (loan <= 0) return 0;
    var r = n(ratePct) / 100 / 12, N = n(termYears) * 12, k = Math.min(N, n(afterYears) * 12);
    if (r === 0) return loan * (1 - k / N);
    var pmt = loan * r / (1 - Math.pow(1 + r, -N));
    return loan * Math.pow(1 + r, k) - pmt * (Math.pow(1 + r, k) - 1) / r;
  }

  function model(d) {
    d = Object.assign({}, DEFAULTS, d || {});
    return d.structure === "debt" ? debtModel(d) : equityModel(d);
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.syndication = { DEFAULTS: DEFAULTS, model: model,
    capitalStack: capitalStack, projectValueAtExit: projectValueAtExit };
})();
