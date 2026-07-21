/* =============================================================================
 * finance.js — BRRRR & multi-family underwriting engine
 * Pure functions. No DOM. Exposed on window.BRRRR.finance
 *
 * BRRRR = Buy, Rehab, Rent, Refinance, Repeat. The whole game is: buy below
 * value, force appreciation with a rehab, stabilize rents, then cash-out
 * refinance to pull your capital back out so you can repeat. The KEY metric,
 * per the owner's mandate, is CASH FLOW — everything else is secondary.
 * ========================================================================== */
(function () {
  "use strict";

  var DEFAULTS = {
    units: 4,
    rentPerUnit: 1250,        // avg market rent per unit / month (stabilized)
    otherIncome: 0,           // laundry, parking, storage / month (total)
    vacancyPct: 6,            // economic vacancy %
    // Operating expenses. If itemized are 0 we fall back to expenseRatioPct.
    taxesAnnual: 0,
    insuranceAnnual: 0,
    maintenancePct: 8,        // % of EGI
    managementPct: 8,         // % of EGI
    utilitiesAnnual: 0,
    reservesPerUnit: 300,     // capex reserves / unit / year
    expenseRatioPct: 45,      // used only if itemized expenses are blank
    // Purchase / acquisition
    price: 250000,
    rehab: 50000,
    downPct: 25,
    purchaseRate: 8.5,        // acquisition/bridge loan rate %
    purchaseTermYears: 30,
    closingPct: 3,            // closing costs as % of price
    holdingMonths: 6,         // months of holding/rehab carrying cost
    // ARV & refinance
    arvMode: "income",        // "income" -> NOI/marketCap ; "manual" -> arvManual
    arvManual: 420000,
    marketCapPct: 7.25,       // market cap rate for income-based ARV
    refiLtvPct: 75,           // cash-out refi loan-to-value
    refiRate: 7.25,
    refiTermYears: 30,
    refiClosingPct: 2,        // refi closing as % of new loan
    // Targets used for pricepoints & scoring
    targetCashflowPerUnit: 150,   // $/unit/month goal
    targetCoCPct: 12              // cash-on-cash goal %
  };

  function num(v, d) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : (d || 0);
  }

  // Standard amortizing payment. annualRate in %, term in years.
  function monthlyPayment(loan, annualRatePct, termYears) {
    loan = num(loan);
    var r = num(annualRatePct) / 100 / 12;
    var n = num(termYears) * 12;
    if (loan <= 0 || n <= 0) return 0;
    if (r === 0) return loan / n;
    return loan * r / (1 - Math.pow(1 + r, -n));
  }

  /* Core underwriting. Takes a merged input object, returns a rich result. */
  function analyze(raw) {
    var i = Object.assign({}, DEFAULTS, raw || {});
    var units = Math.max(1, num(i.units, 1));

    // ---- Income ----
    var grossRentMo = num(i.rentPerUnit) * units + num(i.otherIncome);
    var gsiAnnual = grossRentMo * 12;                         // gross scheduled income
    var vacancyLoss = gsiAnnual * num(i.vacancyPct) / 100;
    var egi = gsiAnnual - vacancyLoss;                        // effective gross income

    // ---- Operating expenses ----
    var itemized = num(i.taxesAnnual) + num(i.insuranceAnnual) +
      num(i.utilitiesAnnual) + num(i.reservesPerUnit) * units +
      egi * num(i.maintenancePct) / 100 + egi * num(i.managementPct) / 100;
    var usedItemized = (num(i.taxesAnnual) + num(i.insuranceAnnual) + num(i.utilitiesAnnual)) > 0;
    var opex = usedItemized ? itemized : egi * num(i.expenseRatioPct) / 100;
    var noi = egi - opex;                                     // net operating income
    var expenseRatio = egi > 0 ? opex / egi : 0;

    // ---- ARV (after-repair value) ----
    var arv;
    if (i.arvMode === "manual") {
      arv = num(i.arvManual);
    } else {
      var cap = num(i.marketCapPct) / 100;
      arv = cap > 0 ? noi / cap : 0;                          // income approach
    }

    // ---- Acquisition financing ----
    var downPayment = num(i.price) * num(i.downPct) / 100;
    var purchaseLoan = num(i.price) - downPayment;
    var closingCosts = num(i.price) * num(i.closingPct) / 100;
    var purchasePmt = monthlyPayment(purchaseLoan, i.purchaseRate, i.purchaseTermYears);
    var holdingCosts = purchasePmt * num(i.holdingMonths);
    var totalCashInvested = downPayment + closingCosts + num(i.rehab) + holdingCosts;

    // ---- Purchase-phase cash flow (before refi) ----
    var cfPurchaseAnnual = noi - purchasePmt * 12;

    // ---- Cash-out refinance ----
    var refiLoan = arv * num(i.refiLtvPct) / 100;
    var refiClosing = refiLoan * num(i.refiClosingPct) / 100;
    // Assume short seasoning: purchase loan payoff ~= original balance.
    var cashOut = refiLoan - purchaseLoan - refiClosing;
    var refiPmt = monthlyPayment(refiLoan, i.refiRate, i.refiTermYears);
    var cfRefiAnnual = noi - refiPmt * 12;
    var cfRefiMo = cfRefiAnnual / 12;
    var cfPerUnitMo = cfRefiMo / units;

    // Capital recovery — the essence of BRRRR.
    var cashRecovered = Math.max(0, cashOut);
    var cashLeftInDeal = totalCashInvested - cashRecovered;
    var capitalRecoveredPct = totalCashInvested > 0 ? cashRecovered / totalCashInvested * 100 : 0;

    // ---- Return metrics ----
    var capRatePurchase = num(i.price) > 0 ? noi / num(i.price) * 100 : 0;
    var capRateArv = arv > 0 ? noi / arv * 100 : 0;
    var cocPct;
    if (cashLeftInDeal <= 0) cocPct = Infinity;               // all capital recovered
    else cocPct = cfRefiAnnual / cashLeftInDeal * 100;
    var dscr = refiPmt > 0 ? noi / (refiPmt * 12) : Infinity;
    var rentToPricePct = num(i.price) > 0 ? grossRentMo / num(i.price) * 100 : 0; // "1% rule"
    var grm = gsiAnnual > 0 ? num(i.price) / gsiAnnual : 0;   // gross rent multiplier
    var equityAtRefi = arv - refiLoan;
    var totalProfitIfSold = arv - num(i.price) - num(i.rehab) - closingCosts;

    return {
      inputs: i, units: units,
      grossRentMo: grossRentMo, gsiAnnual: gsiAnnual, vacancyLoss: vacancyLoss,
      egi: egi, opex: opex, expenseRatio: expenseRatio, noi: noi,
      arv: arv,
      downPayment: downPayment, purchaseLoan: purchaseLoan, closingCosts: closingCosts,
      purchasePmt: purchasePmt, holdingCosts: holdingCosts, totalCashInvested: totalCashInvested,
      cfPurchaseAnnual: cfPurchaseAnnual,
      refiLoan: refiLoan, refiClosing: refiClosing, refiPmt: refiPmt,
      cashOut: cashOut, cashRecovered: cashRecovered, cashLeftInDeal: cashLeftInDeal,
      capitalRecoveredPct: capitalRecoveredPct,
      cfRefiAnnual: cfRefiAnnual, cfRefiMo: cfRefiMo, cfPerUnitMo: cfPerUnitMo,
      capRatePurchase: capRatePurchase, capRateArv: capRateArv,
      cocPct: cocPct, dscr: dscr, rentToPricePct: rentToPricePct, grm: grm,
      equityAtRefi: equityAtRefi, totalProfitIfSold: totalProfitIfSold
    };
  }

  /* -------------------------------------------------------------------------
   * BRRRR SCORE — 0..100, weighted, CASH FLOW dominant.
   *
   * Criteria & weights (sum = 100):
   *   Cash flow / unit / month ....... 35   (THE key)
   *   Capital recovered at refi % .... 20   (BRRRR only works if you get $ back)
   *   Cash-on-cash return % .......... 15
   *   DSCR (lender safety) ........... 12
   *   Cap rate (on purchase) ......... 10
   *   Rent-to-price ("1% rule") ......  8
   * Each criterion is scored 0..100 on a domain-tuned curve, then weighted.
   * ---------------------------------------------------------------------- */
  function lerpScore(x, lo, hi) {                // linear 0..100 between lo..hi
    if (x <= lo) return 0;
    if (x >= hi) return 100;
    return (x - lo) / (hi - lo) * 100;
  }

  function scoreDeal(r) {
    var c = {};
    // Cash flow / unit / month: <=$0 => 0, $200+/unit => 100.
    c.cashflow = { weight: 35, label: "Cash flow / unit / mo",
      value: r.cfPerUnitMo, display: fmtMoney(r.cfPerUnitMo) + "/unit",
      score: r.cfPerUnitMo <= 0 ? Math.max(0, 20 + r.cfPerUnitMo / 5) // penalty band
        : lerpScore(r.cfPerUnitMo, 0, 200) };
    // Capital recovered: 60% => 50, 100%+ => 100.
    c.recovery = { weight: 20, label: "Capital recovered",
      value: r.capitalRecoveredPct, display: Math.round(r.capitalRecoveredPct) + "%",
      score: lerpScore(r.capitalRecoveredPct, 40, 100) };
    // Cash-on-cash: infinite (all $ out) => 100; 8% => 55; 20%+ => 100.
    c.coc = { weight: 15, label: "Cash-on-cash return",
      value: r.cocPct, display: isFinite(r.cocPct) ? r.cocPct.toFixed(1) + "%" : "∞ (all cash out)",
      score: !isFinite(r.cocPct) ? 100 : (r.cocPct < 0 ? 0 : lerpScore(r.cocPct, 4, 20)) };
    // DSCR: 1.0 => 0, 1.25 => 60, 1.5+ => 100.
    c.dscr = { weight: 12, label: "DSCR",
      value: r.dscr, display: isFinite(r.dscr) ? r.dscr.toFixed(2) + "x" : "∞",
      score: !isFinite(r.dscr) ? 100 : lerpScore(r.dscr, 1.0, 1.5) };
    // Cap rate: 5% => 40, 8%+ => 100.
    c.cap = { weight: 10, label: "Cap rate",
      value: r.capRatePurchase, display: r.capRatePurchase.toFixed(2) + "%",
      score: lerpScore(r.capRatePurchase, 4, 9) };
    // Rent-to-price: 0.7% => 40, 1.2%+ => 100.
    c.rent = { weight: 8, label: "Rent-to-price",
      value: r.rentToPricePct, display: r.rentToPricePct.toFixed(2) + "%",
      score: lerpScore(r.rentToPricePct, 0.6, 1.3) };

    var keys = ["cashflow", "recovery", "coc", "dscr", "cap", "rent"];
    var total = 0;
    keys.forEach(function (k) { total += c[k].score * c[k].weight / 100; });
    total = Math.max(0, Math.min(100, total));

    return { total: Math.round(total), grade: grade(total),
      rating: ratingStars(total), criteria: c, order: keys,
      recommendation: recommend(total, r) };
  }

  function grade(s) {
    if (s >= 90) return "A+"; if (s >= 85) return "A"; if (s >= 80) return "A-";
    if (s >= 75) return "B+"; if (s >= 70) return "B"; if (s >= 65) return "B-";
    if (s >= 60) return "C+"; if (s >= 55) return "C"; if (s >= 50) return "C-";
    if (s >= 40) return "D"; return "F";
  }
  function ratingStars(s) { return Math.max(1, Math.round(s / 20)); } // 1..5

  function recommend(score, r) {
    var cf = r.cfPerUnitMo, rec = r.capitalRecoveredPct;
    if (score >= 78 && cf > 0)
      return { verb: "STRONG BUY", tone: "buy",
        note: "Cash flows " + fmtMoney(cf) + "/unit and recovers " + Math.round(rec) + "% of capital. A textbook BRRRR." };
    if (score >= 66 && cf > 0)
      return { verb: "BUY / NEGOTIATE", tone: "ok",
        note: "Solid cash flow. Push price toward the pricepoints below to lift capital recovery and CoC." };
    if (score >= 52)
      return { verb: "MARGINAL", tone: "warn",
        note: cf <= 0 ? "Cash flow is thin or negative — the deal only works at a lower basis." :
          "Workable but tight. Re-trade the price or trim rehab before committing." };
    return { verb: "PASS", tone: "pass",
      note: cf <= 0 ? "Negative cash flow at this price. Walk unless the seller moves substantially." :
        "Returns don't justify the risk at this basis." };
  }

  /* -------------------------------------------------------------------------
   * PRICEPOINTS — the purchase prices that hit specific goals.
   * Solved numerically (binary search) against a fresh analyze() each step,
   * so every downstream cost (down payment, closing, holding) stays consistent.
   * ---------------------------------------------------------------------- */
  function solvePrice(base, metricFn, target, lo, hi) {
    // metricFn(result) increases as price DECREASES, so we search downward.
    lo = lo || 1000; hi = hi || Math.max(base.price * 2, 100000);
    var best = null;
    for (var it = 0; it < 60; it++) {
      var mid = (lo + hi) / 2;
      var r = analyze(Object.assign({}, base, { price: mid }));
      var m = metricFn(r);
      if (m >= target) { best = mid; lo = mid; } else { hi = mid; }
    }
    return best; // highest price that still meets/exceeds target, or null
  }

  function pricepoints(raw) {
    var i = Object.assign({}, DEFAULTS, raw || {});
    var arvR = analyze(i);
    var arv = arvR.arv, rehab = num(i.rehab);

    // 70% rule Maximum Allowable Offer.
    var mao70 = 0.70 * arv - rehab;

    // Full-capital-recovery price: highest price where cash-out >= cash invested.
    var recoveryPrice = solvePrice(i, function (r) { return r.capitalRecoveredPct; }, 100);

    // Target cash-on-cash price.
    var cocPrice = solvePrice(i, function (r) {
      return isFinite(r.cocPct) ? r.cocPct : 999;
    }, num(i.targetCoCPct));

    // Target cash-flow-per-unit price (CF is price-independent post-refi, but
    // capital recovery is not — so we report the price where CF target is met
    // AND capital recovery is maximized; practically this equals recoveryPrice
    // when CF>0, else null). We report the CF target status separately.
    var cfPrice = solvePrice(i, function (r) { return r.cfPerUnitMo; }, num(i.targetCashflowPerUnit));

    return {
      arv: arv,
      mao70: mao70,
      recoveryPrice: recoveryPrice,
      cocPrice: cocPrice,
      cfPrice: cfPrice,
      askingResult: arvR
    };
  }

  /* Formatting helpers shared across the app. */
  function fmtMoney(v, cents) {
    if (!isFinite(v)) return "—";
    var n = Math.round(v * (cents ? 100 : 1)) / (cents ? 100 : 1);
    return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US",
      { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  }
  function fmtPct(v, dp) { return isFinite(v) ? v.toFixed(dp == null ? 1 : dp) + "%" : "∞"; }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.finance = {
    DEFAULTS: DEFAULTS, analyze: analyze, scoreDeal: scoreDeal,
    pricepoints: pricepoints, monthlyPayment: monthlyPayment,
    fmtMoney: fmtMoney, fmtPct: fmtPct, grade: grade
  };
})();
