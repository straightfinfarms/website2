/* ==========================================================================
   Straight Fin Farms — Investor Platform engine (client-side)
   --------------------------------------------------------------------------
   Provides:
     - SFF.store        localStorage-backed data (deals, commitments, investors)
     - SFF.fin          underwriting + financial-statement math
     - SFF.fmt          formatting helpers
     - SFF.ui           shared nav / footer / disclaimer renderers
   No build step, no dependencies. Designed for GitHub Pages.

   Capital structure model
     Sources of capital for each property (the "capital stack"):
       1. Senior mortgage (bank)          — cheapest, first lien
       2. Investor Notes (lenders)         — paid a fixed PREMIUM, NOT owners
       3. Common A equity                  — control class (sponsor + leads)
       4. Common B equity                  — passive / preferred-economics class
     Cash-flow waterfall (annual):
       bank debt service -> investor note interest -> Common B pref return
       -> Common A/B residual split.
   ========================================================================== */
(function (global) {
  'use strict';

  var STORE_KEY = 'sff_invest_v1';
  var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby8pOYvYJBPvaTFD4ldcUnxtB5XGE81TrP70cBH2ap3QAGeOVWC0CefochRrxM97INo/exec';

  /* ----------------------------------------------------------------------
     Seed data — one live raise + a screening pipeline of candidates.
     All figures are illustrative underwriting inputs, not offers.
     ---------------------------------------------------------------------- */
  function seed() {
    return {
      version: 1,
      settings: {
        fundName: 'Balance Nature Property Fund',
        contactEmail: 'invest@straightfinfarms.com'
      },
      deals: [
        {
          id: 'kawartha-6plex',
          name: 'Kawartha Lakes 6-Plex',
          address: '212 Lindsay St, Kawartha Lakes, ON',
          type: 'Multi-residential — 6 units',
          status: 'open',                       // screening | open | funded | closed
          units: 6,
          image: 'images/Community/community Large.jpeg',
          summary: 'Fully-tenanted six-unit walk-up minutes from downtown. Below-market rents with a light-renovation turn plan to lift each suite to market on turnover.',
          // --- acquisition ---
          purchasePrice: 1240000,
          renovation: 96000,
          closingCosts: 44000,
          // --- income (annual, stabilized yr 1) ---
          grossRent: 150000,
          otherIncome: 6000,                    // laundry, parking
          vacancyPct: 0.04,
          operatingExpenses: 51000,             // taxes, insurance, utils, mgmt, R&M
          appreciationPct: 0.03,                // assumed annual
          rentGrowthPct: 0.03,
          // --- senior financing ---
          loanAmount: 868000,                   // ~70% LTV
          interestRate: 0.0575,
          amortYears: 30,
          // --- the raise (everything above the senior loan) ---
          classes: {
            note:   { label: 'Investor Note (Lender)',    target: 160000, rate: 0.09, termYears: 5 },
            common_b: { label: 'Common B (Passive Equity)', target: 276000, prefReturn: 0.07 },
            common_a: { label: 'Common A (Control Equity)', target: 76000 }
          },
          openedOn: '2026-06-01',
          targetClose: '2026-09-30'
        }
      ],
      candidates: [
        { id:'c-peterborough-8', name:'Peterborough 8-Unit', address:'44 Aylmer St, Peterborough, ON', units:8, purchasePrice:1650000, renovation:120000, closingCosts:58000, grossRent:184000, otherIncome:9000, vacancyPct:0.05, operatingExpenses:69000, loanAmount:1155000, interestRate:0.0585, amortYears:30 },
        { id:'c-lindsay-4', name:'Lindsay Fourplex', address:'9 Russell St, Lindsay, ON', units:4, purchasePrice:720000, renovation:25000, closingCosts:24000, grossRent:84000, otherIncome:3600, vacancyPct:0.04, operatingExpenses:26000, loanAmount:540000, interestRate:0.056, amortYears:30 },
        { id:'c-bobcaygeon-12', name:'Bobcaygeon 12-Unit', address:'21 Bolton St, Bobcaygeon, ON', units:12, purchasePrice:2380000, renovation:210000, closingCosts:82000, grossRent:246000, otherIncome:14000, vacancyPct:0.06, operatingExpenses:104000, loanAmount:1666000, interestRate:0.0595, amortYears:30 },
        { id:'c-fenelon-triplex', name:'Fenelon Falls Triplex', address:'5 Colborne St, Fenelon Falls, ON', units:3, purchasePrice:560000, renovation:22000, closingCosts:19000, grossRent:49000, otherIncome:0, vacancyPct:0.04, operatingExpenses:19500, loanAmount:392000, interestRate:0.057, amortYears:30 }
      ],
      // investor commitments (also mirrored to the Apps Script backend when online)
      commitments: [
        { deal:'kawartha-6plex', name:'Seed Capital — Sponsor', klass:'common_a', amount:76000, date:'2026-06-02', status:'funded' },
        { deal:'kawartha-6plex', name:'R. Chen',               klass:'common_b', amount:100000, date:'2026-06-14', status:'funded' },
        { deal:'kawartha-6plex', name:'Kawartha Angels LP',    klass:'note',     amount:120000, date:'2026-06-20', status:'funded' }
      ]
    };
  }

  /* ----------------------------------------------------------------------
     Store
     ---------------------------------------------------------------------- */
  var store = {
    _cache: null,
    load: function () {
      if (this._cache) return this._cache;
      var raw = null;
      try { raw = global.localStorage.getItem(STORE_KEY); } catch (e) {}
      if (!raw) { this._cache = seed(); this.save(); return this._cache; }
      try { this._cache = JSON.parse(raw); } catch (e) { this._cache = seed(); }
      return this._cache;
    },
    save: function () {
      try { global.localStorage.setItem(STORE_KEY, JSON.stringify(this._cache)); } catch (e) {}
    },
    reset: function () { this._cache = seed(); this.save(); return this._cache; },
    deals: function () { return this.load().deals; },
    candidates: function () { return this.load().candidates; },
    commitments: function (dealId) {
      var c = this.load().commitments;
      return dealId ? c.filter(function (x) { return x.deal === dealId; }) : c;
    },
    getDeal: function (id) { return this.deals().filter(function (d) { return d.id === id; })[0] || null; },
    addDeal: function (d) { this.load().deals.push(d); this.save(); },
    addCandidate: function (c) { this.load().candidates.push(c); this.save(); },
    removeCandidate: function (id) {
      var s = this.load(); s.candidates = s.candidates.filter(function (c) { return c.id !== id; }); this.save();
    },
    addCommitment: function (c) {
      c.date = c.date || new Date().toISOString().slice(0, 10);
      c.status = c.status || 'pledged';
      this.load().commitments.push(c);
      this.save();
      postBackend('invest_commit', c);   // best-effort mirror to backend
      return c;
    }
  };

  function postBackend(action, payload) {
    try {
      var body = new URLSearchParams();
      body.set('action', action);
      body.set('payload', JSON.stringify(payload));
      fetch(APPS_SCRIPT_URL, { method: 'POST', mode: 'no-cors', body: body }).catch(function () {});
    } catch (e) {}
  }

  /* ----------------------------------------------------------------------
     Finance engine
     ---------------------------------------------------------------------- */
  function pmtMonthly(annualRate, years, principal) {
    var r = annualRate / 12, n = years * 12;
    if (r === 0) return principal / n;
    return principal * r / (1 - Math.pow(1 + r, -n));
  }
  function annualDebtService(loan, annualRate, years) {
    if (!loan) return 0;
    return pmtMonthly(annualRate, years, loan) * 12;
  }

  var fin = {
    pmtMonthly: pmtMonthly,
    annualDebtService: annualDebtService,

    // total capital needed above the senior loan (what gets raised)
    raiseTarget: function (d) {
      return Math.max(0, totalCost(d) - (d.loanAmount || 0));
    },

    // core underwriting for a deal OR a raw candidate
    underwrite: function (d) {
      var egi = d.grossRent * (1 - (d.vacancyPct || 0)) + (d.otherIncome || 0);
      var noi = egi - (d.operatingExpenses || 0);
      var ds = annualDebtService(d.loanAmount, d.interestRate, d.amortYears);
      var noteAmt = classTarget(d, 'note');
      var noteRate = (d.classes && d.classes.note && d.classes.note.rate) || 0.09;
      var noteInterest = noteAmt * noteRate;
      var equity = Math.max(0, totalCost(d) - (d.loanAmount || 0) - noteAmt);
      var cfAfterBank = noi - ds;
      var cfToEquity = cfAfterBank - noteInterest;
      var price = d.purchasePrice || 1;
      return {
        egi: egi,
        noi: noi,
        capRate: noi / price,
        yieldOnCost: noi / totalCost(d),
        debtService: ds,
        dscr: ds ? noi / ds : Infinity,
        grm: d.grossRent ? price / d.grossRent : 0,
        expenseRatio: egi ? (d.operatingExpenses || 0) / egi : 0,
        noteAmount: noteAmt,
        noteInterest: noteInterest,
        equity: equity,
        cashFlowAfterBank: cfAfterBank,
        cashFlowToEquity: cfToEquity,
        cashOnCash: equity ? cfToEquity / equity : 0,
        breakEvenOcc: d.grossRent ? (ds + noteInterest + (d.operatingExpenses || 0)) / (d.grossRent + (d.otherIncome || 0)) : 0
      };
    },

    // score a candidate 0-100 and give a verdict for the screener
    score: function (d) {
      var u = this.underwrite(d);
      var s = 0;
      // cap rate: 6%+ excellent
      s += clamp((u.capRate - 0.045) / (0.075 - 0.045), 0, 1) * 30;
      // DSCR: 1.25+ healthy
      s += clamp((u.dscr - 1.05) / (1.45 - 1.05), 0, 1) * 25;
      // cash-on-cash: 8%+ strong
      s += clamp((u.cashOnCash - 0.03) / (0.11 - 0.03), 0, 1) * 30;
      // expense ratio: lower better (<45%)
      s += clamp((0.55 - u.expenseRatio) / (0.55 - 0.35), 0, 1) * 15;
      s = Math.round(clamp(s, 0, 100));
      var verdict = s >= 70 ? 'Makes sense' : (s >= 55 ? 'Watch' : 'Pass');
      var flags = [];
      if (u.dscr < 1.2) flags.push('Thin DSCR');
      if (u.capRate < 0.05) flags.push('Low cap rate');
      if (u.cashOnCash < 0.05) flags.push('Weak cash-on-cash');
      if (u.expenseRatio > 0.5) flags.push('High opex ratio');
      return { score: s, verdict: verdict, flags: flags, u: u };
    },

    // per-class projected returns for a deal
    classReturns: function (d) {
      var u = this.underwrite(d);
      var c = d.classes || {};
      var noteRate = (c.note && c.note.rate) || 0.09;
      var bTarget = classTarget(d, 'common_b');
      var aTarget = classTarget(d, 'common_a');
      var equity = aTarget + bTarget || 1;
      var pref = (c.common_b && c.common_b.prefReturn) || 0;
      // waterfall of cash flow to equity
      var toEquity = Math.max(0, u.cashFlowToEquity);
      var bPref = Math.min(toEquity, bTarget * pref);
      var residual = Math.max(0, toEquity - bPref);
      var bShare = residual * (bTarget / equity);
      var aShare = residual * (aTarget / equity);
      var bCash = bPref + bShare;
      var aCash = aShare;
      // appreciation split (equity only, pro-rata) — illustrative yr-1 equity build
      var apprec = (d.purchasePrice || 0) * (d.appreciationPct || 0);
      return {
        note:     { amount: u.noteAmount, cash: u.noteInterest, yield: u.noteAmount ? noteRate : 0, rate: noteRate, termYears: (c.note && c.note.termYears) || 5 },
        common_b: { amount: bTarget, cash: bCash, yield: bTarget ? bCash / bTarget : 0, apprec: apprec * (bTarget / equity), pref: pref },
        common_a: { amount: aTarget, cash: aCash, yield: aTarget ? aCash / aTarget : 0, apprec: apprec * (aTarget / equity) }
      };
    },

    // ---- financial statements (stabilized Year-1, accrual) ----
    incomeStatement: function (d) {
      var u = this.underwrite(d);
      var vacancy = d.grossRent * (d.vacancyPct || 0);
      var depreciation = ((d.purchasePrice || 0) * 0.8) / 27.5; // building portion, 27.5-yr
      var interestSenior = interestPortion(d.loanAmount, d.interestRate, d.amortYears);
      var interestNotes = u.noteInterest;
      var ebt = u.noi - depreciation - interestSenior - interestNotes;
      return {
        grossRent: d.grossRent, otherIncome: d.otherIncome || 0, vacancy: vacancy,
        egi: u.egi, operatingExpenses: d.operatingExpenses || 0, noi: u.noi,
        depreciation: depreciation, interestSenior: interestSenior, interestNotes: interestNotes,
        netIncome: ebt
      };
    },
    balanceSheet: function (d) {
      var reserve = Math.round(totalCost(d) * 0.02);
      var propertyAtCost = (d.purchasePrice || 0) + (d.renovation || 0);
      var totalAssets = propertyAtCost + reserve;
      var senior = d.loanAmount || 0;
      var notes = classTarget(d, 'note');
      var totalLiab = senior + notes;
      var commonA = classTarget(d, 'common_a');
      var commonB = classTarget(d, 'common_b');
      var equity = totalAssets - totalLiab;         // book equity plug
      return {
        propertyAtCost: propertyAtCost, cashReserve: reserve, totalAssets: totalAssets,
        seniorLoan: senior, notesPayable: notes, totalLiabilities: totalLiab,
        commonA: commonA, commonB: commonB,
        retainedEarnings: equity - commonA - commonB,
        totalEquity: equity, totalLiabEquity: totalLiab + equity
      };
    },
    cashFlow: function (d) {
      var is = this.incomeStatement(d);
      var ds = annualDebtService(d.loanAmount, d.interestRate, d.amortYears);
      var principal = ds - is.interestSenior;
      var operating = is.noi;
      var financing = -(is.interestSenior + principal + is.interestNotes);
      var distributions = Math.max(0, operating + financing);
      return {
        noi: is.noi, interestSenior: is.interestSenior, principalRepaid: principal,
        interestNotes: is.interestNotes, netFinancing: financing,
        cashBeforeDist: operating + financing, distributions: distributions
      };
    },

    capTable: function (d) {
      var a = classTarget(d, 'common_a'), b = classTarget(d, 'common_b');
      var eq = a + b || 1;
      var pricePerUnit = 1000; // $1,000 per equity unit
      return {
        pricePerUnit: pricePerUnit,
        rows: [
          { klass: 'common_a', label: 'Common A (Control)', capital: a, units: Math.round(a / pricePerUnit), pct: a / eq, votes: 'Voting' },
          { klass: 'common_b', label: 'Common B (Passive)', capital: b, units: Math.round(b / pricePerUnit), pct: b / eq, votes: 'Non-voting' }
        ],
        totalEquity: eq
      };
    }
  };

  function totalCost(d) { return (d.purchasePrice || 0) + (d.renovation || 0) + (d.closingCosts || 0); }
  function classTarget(d, k) { return (d.classes && d.classes[k] && d.classes[k].target) || 0; }
  function interestPortion(loan, rate, years) {
    // first-year interest ≈ avg of beginning & end balances * rate (close enough for illustration)
    if (!loan) return 0;
    var ds = annualDebtService(loan, rate, years);
    var r = rate / 12; var bal = loan; var interest = 0;
    for (var m = 0; m < 12; m++) { var i = bal * r; interest += i; bal -= (ds / 12 - i); }
    return interest;
  }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  fin.totalCost = totalCost;
  fin.classTarget = classTarget;

  // funding progress for a deal (raised vs target, by class)
  fin.funding = function (d) {
    var commits = store.commitments(d.id);
    var raisedBy = { note: 0, common_b: 0, common_a: 0 };
    commits.forEach(function (c) { if (raisedBy[c.klass] != null) raisedBy[c.klass] += c.amount; });
    var target = fin.raiseTarget(d);
    var raised = raisedBy.note + raisedBy.common_b + raisedBy.common_a;
    return {
      target: target, raised: raised, pct: target ? raised / target : 0,
      remaining: Math.max(0, target - raised), raisedBy: raisedBy,
      byClass: {
        note:     { target: classTarget(d, 'note'),     raised: raisedBy.note },
        common_b: { target: classTarget(d, 'common_b'), raised: raisedBy.common_b },
        common_a: { target: classTarget(d, 'common_a'), raised: raisedBy.common_a }
      }
    };
  };

  /* ----------------------------------------------------------------------
     Formatting
     ---------------------------------------------------------------------- */
  var fmt = {
    money: function (n, dp) {
      if (n == null || isNaN(n)) return '—';
      return '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
    },
    money0: function (n) { return fmt.money(n, 0); },
    pct: function (n, dp) { if (n == null || isNaN(n) || !isFinite(n)) return '—'; return (n * 100).toFixed(dp == null ? 1 : dp) + '%'; },
    x: function (n) { if (!isFinite(n)) return '∞'; return n.toFixed(2) + '×'; },
    date: function (s) { try { return new Date(s).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return s; } }
  };

  /* ----------------------------------------------------------------------
     Shared UI chrome
     ---------------------------------------------------------------------- */
  // account slot: shows sign-in or the current account + sign out (backend mode only)
  function accountSlot() {
    var b = global.SFF && global.SFF.backend;
    if (!b || !b.enabled) return '';
    var label = b.accountLabel && b.accountLabel();
    if (label) {
      return '<a href="#" onclick="SFF.backend.signOut();return false;" title="' + label + '" style="font-size:13px;">Sign out</a>';
    }
    return '<a href="login.html" style="font-weight:600;">Sign in</a>';
  }

  var ui = {
    nav: function (active) {
      var links = [
        ['portfolio.html', 'Dashboard', 'portfolio'],
        ['deal-finder.html', 'Deal Finder', 'finder'],
        ['connections.html', 'Connections', 'connections'],
        ['invest.html', 'Invest', 'invest'],
        ['investor-portal.html', 'Portal', 'portal']
      ];
      var html = '<nav class="sff-nav">' +
        '<a class="nav-logo" href="portfolio.html">Balance Nature Property Fund</a>' +
        '<button class="hamburger" onclick="this.parentNode.querySelector(\'.nav-links\').classList.toggle(\'open\')" aria-label="Menu"><span></span><span></span><span></span></button>' +
        '<div class="nav-links">' +
        links.map(function (l) {
          return '<a href="' + l[0] + '"' + (l[2] === active ? ' style="text-decoration:underline;font-weight:600;"' : '') + '>' + l[1] + '</a>';
        }).join('') +
        accountSlot() +
        '<a class="btn-book" href="onboard.html">+ ADD PROPERTY</a>' +
        '</div></nav>';
      return html;
    },
    footer: function () {
      return '<footer class="sff-footer"><div class="cols">' +
        '<div><h4>Balance Nature Property Fund</h4><p>A community-funded approach to regenerative multi-residential real estate in the Kawarthas — built by Straight Fin Farms.</p><br><p>1091 County Road 24, Dunsford, ON, K0M 1L0</p><br><p>invest@straightfinfarms.com</p></div>' +
        '<div><h4>Platform</h4><a href="portfolio.html">Portfolio Dashboard</a><a href="deal-finder.html">Deal Finder</a><a href="connections.html">Connections</a><a href="onboard.html">Onboard a Property</a><a href="invest.html">Investment Opportunities</a><a href="investor-portal.html">Investor Portal</a><a href="straight-fin-farms.html">Straight Fin Farms</a></div>' +
        '<div><h4>Participate As</h4><a href="invest.html#classes"><span class="dot a"></span>Common A — Control</a><a href="invest.html#classes"><span class="dot b"></span>Common B — Passive</a><a href="invest.html#classes"><span class="dot n"></span>Investor Note — Lender</a></div>' +
        '</div><div class="footer-bottom">&copy; 2026 Straight Fin Farms. All rights reserved. &middot; Figures shown are illustrative underwriting, not an offer to sell securities.</div></footer>';
    },
    disclaimer: function () {
      return '<div class="disclaimer"><strong>Important.</strong> This platform and all projections are for information and planning only. Nothing here is an offer to sell, or a solicitation of an offer to buy, any security, nor investment, legal, or tax advice. Any actual investment would be made only through definitive offering documents to eligible investors under available exemptions (e.g. accredited-investor / private-issuer) in accordance with applicable Canadian securities law. Real-estate investments are illiquid and carry risk of loss, including loss of principal. Projected returns are not guaranteed. Consult your own advisors.</div>';
    },
    mount: function (active) {
      var n = document.getElementById('nav'); if (n) n.innerHTML = ui.nav(active);
      var f = document.getElementById('footer'); if (f) f.innerHTML = ui.footer();
      document.querySelectorAll('[data-disclaimer]').forEach(function (el) { el.innerHTML = ui.disclaimer(); });
    }
  };

  global.SFF = { store: store, fin: fin, fmt: fmt, ui: ui, APPS_SCRIPT_URL: APPS_SCRIPT_URL, seed: seed };
})(window);
