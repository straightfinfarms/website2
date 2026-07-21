/* =============================================================================
 * insights.js — portfolio insight & opportunity engine (pure)
 * window.BRRRR.insights
 *
 * Rule-based. Takes ENRICHED holdings (holding + computed metrics) and
 * ENRICHED prospects (prospect + analysis + score), returns prioritized
 * insight cards plus a grow-vs-diversify recommendation. No DOM.
 * ========================================================================== */
(function () {
  "use strict";
  var F = BRRRR.finance, fmt = F.fmtMoney;

  function n(v) { var x = parseFloat(v); return isFinite(x) ? x : 0; }
  function haversine(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    return BRRRR.geo.haversineMiles({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
  }

  /* holdings: [{ h, m }]  (m from portfolio.metrics, plus value/loan on h)
   * prospects: [{ p, r, s }] (r=analyze result, s=score)                     */
  function generate(holdings, prospects) {
    var perProperty = [];
    var portfolio = [];
    holdings = holdings || []; prospects = prospects || [];

    // ---- Per-property signals ----
    holdings.forEach(function (x) {
      var h = x.h, m = x.m;
      var value = n(h.currentValue), loan = n(h.loanBalance);
      var ltv = value > 0 ? loan / value : 0;
      var cards = [];

      // Cash-out refi capacity: room up to 75% LTV that could be redeployed.
      var maxLoan = 0.75 * value;
      var extract = maxLoan - loan;
      if (value > 0 && extract > 15000 && ltv < 0.68) {
        cards.push({ level: "opportunity", title: "Cash-out refi capacity",
          detail: "At " + Math.round(ltv * 100) + "% LTV you could pull ~" + fmt(extract) +
            " (to 75% LTV) to redeploy into the next deal — the BRRRR 'Repeat'." });
      }
      // DSCR risk.
      if (isFinite(m.dscr) && m.dscr < 1.25) {
        cards.push({ level: "risk", title: "Thin DSCR (" + m.dscr.toFixed(2) + "x)",
          detail: "Debt coverage is tight. Raise rents, cut expenses, or refinance before rates or vacancy squeeze it." });
      }
      // Negative cash flow.
      if (m.cfMo < 0) {
        cards.push({ level: "risk", title: "Negative cash flow",
          detail: "Losing " + fmt(-m.cfMo) + "/mo. Re-underwrite: rents, expense leaks, or a rate-and-term refi." });
      }
      // Operational efficiency (expense ratio high).
      var er = m.grossMo > 0 ? (m.grossMo - m.noiMo) / m.grossMo : 0;
      if (er > 0.55) {
        cards.push({ level: "opportunity", title: "Expense ratio " + Math.round(er * 100) + "%",
          detail: "Above the ~50% norm. Shop insurance, appeal taxes, sub-meter utilities, or renegotiate management to lift NOI." });
      }
      // Lease-up.
      if (n(h.occupancyPct) && n(h.occupancyPct) < 92) {
        cards.push({ level: "opportunity", title: "Occupancy " + n(h.occupancyPct) + "%",
          detail: "Every point of occupancy is pure NOI. Lease-up push or turn stale units." });
      }
      // Value-add realized (equity build).
      if (m.valueAdded > 25000 && m.basis > 0) {
        cards.push({ level: "info", title: "Value created " + fmt(m.valueAdded),
          detail: "You've forced " + fmt(m.valueAdded) + " above your " + fmt(m.basis) +
            " basis. Consider harvesting via refi or 1031 into scale." });
      }
      // Top performer.
      if (isFinite(m.dscr) && m.dscr >= 1.5 && (m.coc === Infinity || m.coc >= 12) && m.cfMo > 0) {
        cards.push({ level: "info", title: "Top performer",
          detail: "Strong coverage and return. Use its profile as the template when sourcing the next buy." });
      }
      if (cards.length) perProperty.push({ id: h.id, name: h.name || "Property", cards: cards, ltv: ltv, value: value });
    });

    // ---- Portfolio-level ----
    var totVal = 0, totLoan = 0, totCF = 0, totInvested = 0, cocSum = 0, cocW = 0;
    holdings.forEach(function (x) {
      totVal += n(x.h.currentValue); totLoan += n(x.h.loanBalance);
      totCF += x.m.cfMo; totInvested += x.m.cashInvested;
      if (isFinite(x.m.coc)) { cocSum += x.m.coc * x.m.cashInvested; cocW += x.m.cashInvested; }
    });
    var portLtv = totVal > 0 ? totLoan / totVal : 0;
    var portEquity = totVal - totLoan;
    var portCoC = cocW > 0 ? cocSum / cocW : (totInvested > 0 ? totCF * 12 / totInvested * 100 : 0);
    var extractable = Math.max(0, 0.75 * totVal - totLoan);

    if (holdings.length >= 2) {
      // Geographic concentration: share of value within 15 mi of the largest holding.
      var anchor = holdings.slice().sort(function (a, b) { return n(b.h.currentValue) - n(a.h.currentValue); })[0].h;
      var near = 0;
      holdings.forEach(function (x) {
        var d = haversine(anchor, x.h);
        if (d == null || d <= 15) near += n(x.h.currentValue);
      });
      var conc = totVal > 0 ? near / totVal : 0;
      if (conc > 0.7) {
        portfolio.push({ level: "risk", title: "Geographic concentration",
          detail: Math.round(conc * 100) + "% of value sits in one submarket. A local shock (jobs, taxes, insurance) hits the whole portfolio — diversify metros as you scale." });
      }
    }
    // Leverage.
    if (holdings.length && portLtv > 0.78) {
      portfolio.push({ level: "risk", title: "High leverage (" + Math.round(portLtv * 100) + "% LTV)",
        detail: "Little equity cushion. Prioritize paydown or stabilizing cash flow over new acquisitions." });
    } else if (holdings.length && portLtv < 0.45) {
      portfolio.push({ level: "opportunity", title: "Under-levered (" + Math.round(portLtv * 100) + "% LTV)",
        detail: "You're sitting on ~" + fmt(extractable) + " of extractable equity to 75% LTV. Capacity to acquire without new cash." });
    }

    // ---- Grow vs diversify ----
    var recommendation = growOrDiversify(holdings, prospects, { portCoC: portCoC, extractable: extractable, portLtv: portLtv });

    return { perProperty: perProperty, portfolio: portfolio, recommendation: recommendation,
      summary: { value: totVal, equity: portEquity, cfMo: totCF, ltv: portLtv,
        coc: portCoC, extractable: extractable, count: holdings.length } };
  }

  function growOrDiversify(holdings, prospects, ctx) {
    // Best available new deal by score, that also cash-flows.
    var ranked = prospects.filter(function (x) { return x.r.cfPerUnitMo > 0; })
      .sort(function (a, b) { return b.s.total - a.s.total; });
    var best = ranked[0];

    if (!holdings.length) {
      return { verb: "ACQUIRE", tone: "buy",
        note: best ? "No holdings yet. Your strongest sourced deal is “" + best.p.name + "” (grade " +
          best.s.grade + "). Start the portfolio there." :
          "No holdings and no sourced deals — use the Deal Finder to build a pipeline." };
    }
    var bestCoC = best && isFinite(best.r.cocPct) ? best.r.cocPct : (best ? 999 : null);
    // If under-levered with real extractable equity AND a new deal clearly beats
    // the portfolio's marginal return -> diversify with recycled capital.
    if (best && ctx.extractable > 30000 && ctx.portLtv < 0.7 &&
        (bestCoC == null || bestCoC >= ctx.portCoC * 1.15 || best.s.total >= 72)) {
      return { verb: "DIVERSIFY", tone: "ok",
        note: "You have ~" + fmt(ctx.extractable) + " of extractable equity and “" + best.p.name +
          "” (grade " + best.s.grade + ", CF " + fmt(best.r.cfPerUnitMo) + "/unit) projects returns above your " +
          ctx.portCoC.toFixed(0) + "% portfolio average. Recycle equity into it rather than paying down." };
    }
    // Otherwise optimize what you own.
    return { verb: "OPTIMIZE EXISTING", tone: "warn",
      note: ctx.portLtv >= 0.7 ?
        "Leverage is already full and no sourced deal clearly beats your current returns — focus on NOI growth and paydown before adding doors." :
        "No sourced deal clearly beats your existing returns right now. Push rents, cut expenses, and refinance winners; keep sourcing in the Deal Finder." };
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.insights = { generate: generate };
})();
