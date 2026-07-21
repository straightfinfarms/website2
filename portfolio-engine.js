/* ==========================================================================
   Straight Fin Farms — Portfolio Operating System engine
   --------------------------------------------------------------------------
   Extends the SFF namespace (loaded after invest-platform.js) with:
     - SFF.pf        portfolio store (properties, connections, vendors, work orders)
     - SFF.perf      per-property performance + DSCR + BRRRR + refi math
     - SFF.insights  grow-vs-diversify + opportunity engine

   Built for the individual BRRRR / STR investor first; the data model is
   multi-property and multi-owner so it scales to enterprise portfolios.

   NOTE ON CONNECTIONS: bank / Airbnb / utility / government integrations run
   in SANDBOX mode here (seeded feed data, simulated OAuth). Wiring them to
   live APIs (Plaid, Airbnb, hydro, municipal tax) requires a backend that
   holds OAuth secrets — this layer is architected to plug into that later.
   ========================================================================== */
(function (global) {
  'use strict';
  if (!global.SFF) { console.warn('portfolio-engine: SFF core not loaded'); return; }
  var SFF = global.SFF;
  var PF_KEY = 'sff_portfolio_v1';

  var DAYS_PER_MONTH = 30.4;

  /* ----------------------------------------------------------------------
     Seed portfolio — three owned properties covering the core strategies:
       1. Short-term rental (Airbnb)      — single owner
       2. BRRRR in refinance stage        — single owner
       3. Buy-and-hold triplex            — multiple investors (transparency)
     ---------------------------------------------------------------------- */
  function seedPortfolio() {
    return {
      version: 1,
      owner: { name: 'You', email: 'invest@straightfinfarms.com' },
      properties: [
        {
          id: 'p-dunsford-cabin', name: 'Dunsford Lakehouse (STR)', address: '1091 County Rd 24, Dunsford, ON',
          type: 'Single-family — short-term rental', strategy: 'STR', units: 1,
          image: 'images/Waterfront/hero-dock-rainbow.jpg',
          acquiredOn: '2023-05-12', purchasePrice: 640000, currentValue: 795000, rehab: 38000, cashInvested: 205000,
          mortgage: { lender: 'RBC Royal Bank', balance: 452000, rate: 0.0559, amortYears: 25, monthlyPayment: 3080 },
          str: { adr: 340, occupancy: 0.62, channel: 'Airbnb', cleaningFeeMonthly: 900 },
          otherMonthly: 0,
          expenses: { taxMonthly: 420, insuranceMonthly: 190, utilitiesMonthly: 360, maintenanceMonthly: 300, hoaMonthly: 0, mgmtPct: 0.10 },
          owners: [{ name: 'You', role: 'Owner-operator', klass: 'common_a', equityPct: 1.0, capital: 205000 }],
          connections: ['conn-rbc', 'conn-airbnb', 'conn-hydro', 'conn-qbo'],
          vendors: ['v-clean', 'v-hospitality'],
          brrrr: null
        },
        {
          id: 'p-lindsay-duplex', name: 'Lindsay Duplex (BRRRR)', address: '9 Russell St, Lindsay, ON',
          type: 'Duplex — long-term rental', strategy: 'BRRRR', units: 2,
          image: 'images/Community/community Large.jpeg',
          acquiredOn: '2025-11-03', purchasePrice: 470000, currentValue: 585000, rehab: 72000, cashInvested: 168000,
          mortgage: { lender: 'Meridian CU', balance: 329000, rate: 0.0605, amortYears: 30, monthlyPayment: 1980 },
          monthlyRent: 4300, marketRent: 4300, otherMonthly: 120,
          expenses: { taxMonthly: 360, insuranceMonthly: 150, utilitiesMonthly: 90, maintenanceMonthly: 215, hoaMonthly: 0, mgmtPct: 0.08 },
          owners: [{ name: 'You', role: 'Owner', klass: 'common_a', equityPct: 1.0, capital: 168000 }],
          connections: ['conn-meridian', 'conn-qbo'],
          vendors: ['v-maint'],
          brrrr: { stage: 'refinance', stages: { buy: true, rehab: true, rent: true, refinance: false, repeat: false }, arv: 585000, refiLtv: 0.75 }
        },
        {
          id: 'p-peterborough-triplex', name: 'Peterborough Triplex', address: '44 Aylmer St, Peterborough, ON',
          type: 'Triplex — long-term rental', strategy: 'buy-hold', units: 3,
          image: 'images/Community/IMG_5302 Large.jpeg',
          acquiredOn: '2024-08-19', purchasePrice: 720000, currentValue: 812000, rehab: 26000, cashInvested: 236000,
          mortgage: { lender: 'TD Canada Trust', balance: 540000, rate: 0.0575, amortYears: 30, monthlyPayment: 3150 },
          monthlyRent: 5850, marketRent: 6450, otherMonthly: 220,
          expenses: { taxMonthly: 540, insuranceMonthly: 210, utilitiesMonthly: 140, maintenanceMonthly: 300, hoaMonthly: 0, mgmtPct: 0.08 },
          owners: [
            { name: 'You', role: 'Managing partner', klass: 'common_a', equityPct: 0.50, capital: 118000 },
            { name: 'R. Chen', role: 'Passive investor', klass: 'common_b', equityPct: 0.34, capital: 80000 },
            { name: 'Kawartha Angels LP', role: 'Lender (note)', klass: 'note', equityPct: 0.16, capital: 38000 }
          ],
          connections: ['conn-td', 'conn-qbo'],
          vendors: ['v-maint', 'v-facilities'],
          brrrr: null
        }
      ],
      connections: [
        { id: 'conn-rbc', provider: 'RBC Royal Bank', category: 'bank', status: 'connected', lastSync: '2026-07-21', accounts: ['Chequing ••4021', 'Mortgage ••8830'], via: 'Open Banking (sandbox)' },
        { id: 'conn-meridian', provider: 'Meridian Credit Union', category: 'bank', status: 'connected', lastSync: '2026-07-20', accounts: ['Business ••1174'], via: 'Open Banking (sandbox)' },
        { id: 'conn-td', provider: 'TD Canada Trust', category: 'bank', status: 'connected', lastSync: '2026-07-21', accounts: ['Property ops ••6650'], via: 'Open Banking (sandbox)' },
        { id: 'conn-airbnb', provider: 'Airbnb', category: 'str', status: 'connected', lastSync: '2026-07-21', accounts: ['Dunsford Lakehouse'], via: 'Airbnb API (sandbox)' },
        { id: 'conn-hydro', provider: 'Hydro One', category: 'utility', status: 'connected', lastSync: '2026-07-19', accounts: ['Account ••3390'], via: 'Utility API (sandbox)' },
        { id: 'conn-qbo', provider: 'QuickBooks Online', category: 'accounting', status: 'connected', lastSync: '2026-07-21', accounts: ['Balance Nature Ltd.'], via: 'OAuth (sandbox)' },
        { id: 'conn-tax', provider: 'City of Kawartha Lakes — Property Tax', category: 'government', status: 'available', lastSync: null, accounts: [], via: 'Municipal portal' },
        { id: 'conn-vrbo', provider: 'Vrbo', category: 'str', status: 'available', lastSync: null, accounts: [], via: 'Vrbo API' }
      ],
      vendors: [
        { id: 'v-clean', name: 'Kawartha Clean Co.', category: 'cleaning', rating: 4.8, rate: '$95 / turnover', properties: ['p-dunsford-cabin'] },
        { id: 'v-hospitality', name: 'North Star Hospitality', category: 'hospitality', rating: 4.9, rate: '12% of STR revenue', properties: ['p-dunsford-cabin'] },
        { id: 'v-maint', name: 'FixIt Property Maintenance', category: 'maintenance', rating: 4.6, rate: '$85 / hr', properties: ['p-lindsay-duplex', 'p-peterborough-triplex'] },
        { id: 'v-facilities', name: 'GreenScape Facilities', category: 'facilities', rating: 4.7, rate: 'Retainer $320/mo', properties: ['p-peterborough-triplex'] }
      ],
      workOrders: [
        { id: 'wo1', propertyId: 'p-dunsford-cabin', vendorId: 'v-clean', title: 'Guest turnover clean', status: 'scheduled', cost: 95, date: '2026-07-23' },
        { id: 'wo2', propertyId: 'p-lindsay-duplex', vendorId: 'v-maint', title: 'Unit B — faucet + drywall patch', status: 'open', cost: 340, date: '2026-07-25' },
        { id: 'wo3', propertyId: 'p-peterborough-triplex', vendorId: 'v-facilities', title: 'Quarterly grounds + gutters', status: 'done', cost: 320, date: '2026-07-08' }
      ],
      marketplace: [
        { id: 'm-clean2', name: 'Sparkle STR Cleaning', category: 'cleaning', rating: 4.7, rate: '$85 / turnover', area: 'Kawartha Lakes' },
        { id: 'm-maint2', name: 'Trent Valley Handyman', category: 'maintenance', rating: 4.5, rate: '$75 / hr', area: 'Peterborough' },
        { id: 'm-hosp2', name: 'LakeStay Guest Management', category: 'hospitality', rating: 4.8, rate: '15% of revenue', area: 'Kawarthas' },
        { id: 'm-fac2', name: 'Northern Snow & Grounds', category: 'facilities', rating: 4.6, rate: 'Seasonal contract', area: 'Central ON' }
      ]
    };
  }

  /* ----------------------------------------------------------------------
     Store
     ---------------------------------------------------------------------- */
  var pf = {
    _cache: null,
    load: function () {
      if (this._cache) return this._cache;
      var raw = null; try { raw = global.localStorage.getItem(PF_KEY); } catch (e) {}
      if (!raw) { this._cache = seedPortfolio(); this.save(); return this._cache; }
      try { this._cache = JSON.parse(raw); } catch (e) { this._cache = seedPortfolio(); }
      return this._cache;
    },
    save: function () { try { global.localStorage.setItem(PF_KEY, JSON.stringify(this._cache)); } catch (e) {} },
    reset: function () { this._cache = seedPortfolio(); this.save(); return this._cache; },
    properties: function () { return this.load().properties; },
    getProperty: function (id) { return this.properties().filter(function (p) { return p.id === id; })[0] || null; },
    connections: function () { return this.load().connections; },
    getConnection: function (id) { return this.connections().filter(function (c) { return c.id === id; })[0] || null; },
    vendors: function () { return this.load().vendors; },
    getVendor: function (id) { return this.vendors().filter(function (v) { return v.id === id; })[0] || null; },
    workOrders: function (propertyId) {
      var w = this.load().workOrders;
      return propertyId ? w.filter(function (o) { return o.propertyId === propertyId; }) : w;
    },
    marketplace: function () { return this.load().marketplace || []; },
    addProperty: function (p) { this.load().properties.push(p); this.save(); return p; },
    updateConnection: function (id, patch) {
      var c = this.getConnection(id); if (c) { Object.assign(c, patch); this.save(); } return c;
    },
    setOwners: function (propertyId, owners) {
      var p = this.getProperty(propertyId); if (p) { p.owners = owners; this.save(); }
    }
  };

  /* ----------------------------------------------------------------------
     Performance engine
     ---------------------------------------------------------------------- */
  var perf = {
    grossMonthly: function (p) {
      if (p.strategy === 'STR' && p.str) return p.str.adr * DAYS_PER_MONTH * p.str.occupancy + (p.otherMonthly || 0);
      return (p.monthlyRent || 0) + (p.otherMonthly || 0);
    },
    opexMonthly: function (p) {
      var e = p.expenses || {};
      var mgmt = (e.mgmtPct || 0) * this.grossMonthly(p);
      return (e.taxMonthly || 0) + (e.insuranceMonthly || 0) + (e.utilitiesMonthly || 0) +
             (e.maintenanceMonthly || 0) + (e.hoaMonthly || 0) + mgmt;
    },
    of: function (p) {
      var gross = this.grossMonthly(p);
      var opex = this.opexMonthly(p);
      var noiM = gross - opex;
      var mtg = (p.mortgage && p.mortgage.monthlyPayment) || 0;
      var cfM = noiM - mtg;
      var value = p.currentValue || 0;
      var bal = (p.mortgage && p.mortgage.balance) || 0;
      var annualNOI = noiM * 12, annualDS = mtg * 12;
      var invested = p.cashInvested || Math.max(1, (p.purchasePrice || 0) - bal + (p.rehab || 0));
      return {
        grossMonthly: gross, opexMonthly: opex, noiMonthly: noiM, mortgageMonthly: mtg, cashFlowMonthly: cfM,
        annualNOI: annualNOI, annualCashFlow: cfM * 12,
        dscr: annualDS ? annualNOI / annualDS : Infinity,
        capRate: value ? annualNOI / value : 0,
        equity: value - bal, ltv: value ? bal / value : 0,
        cashInvested: invested, cashOnCash: invested ? (cfM * 12) / invested : 0,
        appreciation: (p.currentValue || 0) - (p.purchasePrice || 0),
        occupancy: p.strategy === 'STR' && p.str ? p.str.occupancy : null,
        // cash-out refi headroom at 75% LTV
        refiMaxLoan: value * 0.75,
        refiExtractable: Math.max(0, value * 0.75 - bal)
      };
    },
    // aggregate across the whole portfolio
    portfolio: function () {
      var props = pf.properties();
      var agg = { count: props.length, units: 0, value: 0, debt: 0, equity: 0, cashFlowMonthly: 0, annualNOI: 0, annualDS: 0, invested: 0 };
      props.forEach(function (p) {
        var u = perf.of(p);
        agg.units += p.units || 0;
        agg.value += p.currentValue || 0;
        agg.debt += (p.mortgage && p.mortgage.balance) || 0;
        agg.equity += u.equity;
        agg.cashFlowMonthly += u.cashFlowMonthly;
        agg.annualNOI += u.annualNOI;
        agg.annualDS += u.mortgageMonthly * 12;
        agg.invested += u.cashInvested;
      });
      agg.blendedDSCR = agg.annualDS ? agg.annualNOI / agg.annualDS : Infinity;
      agg.blendedCapRate = agg.value ? agg.annualNOI / agg.value : 0;
      agg.blendedLTV = agg.value ? agg.debt / agg.value : 0;
      agg.cashOnCash = agg.invested ? (agg.cashFlowMonthly * 12) / agg.invested : 0;
      agg.totalRefiExtractable = props.reduce(function (s, p) { return s + perf.of(p).refiExtractable; }, 0);
      return agg;
    },
    // an investor's slice of a property (transparency)
    ownerShare: function (p, ownerName) {
      var o = (p.owners || []).filter(function (x) { return x.name === ownerName; })[0];
      if (!o) return null;
      var u = perf.of(p);
      if (o.klass === 'note') {
        // lender: fixed premium on capital, not equity upside
        var rate = 0.09;
        return { role: o.role, klass: o.klass, capital: o.capital, isLender: true,
          equityValue: o.capital, annualCash: o.capital * rate, share: null };
      }
      return { role: o.role, klass: o.klass, capital: o.capital, isLender: false, share: o.equityPct,
        equityValue: u.equity * o.equityPct, annualCash: u.annualCashFlow * o.equityPct,
        appreciation: u.appreciation * o.equityPct };
    }
  };

  /* ----------------------------------------------------------------------
     Insights engine — where to grow, when to diversify
     ---------------------------------------------------------------------- */
  var insights = {
    forProperty: function (p) {
      var u = perf.of(p);
      var out = [];
      // BRRRR / cash-out refinance headroom
      if (u.refiExtractable > 15000) {
        out.push({ type: 'refi', level: 'opportunity', icon: '↗',
          title: 'Cash-out refinance available',
          body: 'At 75% LTV you could pull out about ' + SFF.fmt.money0(u.refiExtractable) + ' in trapped equity to redeploy into the next deal — the "Repeat" in BRRRR.',
          value: u.refiExtractable });
      }
      // under-market rent
      if (p.marketRent && p.monthlyRent && p.marketRent > p.monthlyRent * 1.03) {
        var lift = (p.marketRent - p.monthlyRent) * 12;
        out.push({ type: 'rent', level: 'opportunity', icon: '↗',
          title: 'Rents are below market',
          body: 'Bringing rents to market on turnover adds about ' + SFF.fmt.money0(lift) + '/yr in income — roughly ' + SFF.fmt.money0(lift / 0.06) + ' of value at a 6% cap.',
          value: lift });
      }
      // STR occupancy / pricing
      if (p.strategy === 'STR' && u.occupancy != null && u.occupancy < 0.7) {
        out.push({ type: 'str', level: 'opportunity', icon: '◎',
          title: 'STR occupancy has headroom',
          body: 'Occupancy is ' + SFF.fmt.pct(u.occupancy, 0) + '. Dynamic pricing and a second channel (Vrbo) could lift it toward 75%+ — connect Vrbo from the Connections hub.',
          value: null });
      }
      // DSCR risk
      if (u.dscr < 1.2) {
        out.push({ type: 'risk', level: 'watch', icon: '⚠',
          title: 'Thin debt-service coverage',
          body: 'DSCR is ' + u.dscr.toFixed(2) + '×. Lenders want 1.20×+. Watch rate resets and keep a reserve; a small rent lift restores headroom.',
          value: null });
      }
      // negative or thin cash flow
      if (u.cashFlowMonthly < 0) {
        out.push({ type: 'risk', level: 'watch', icon: '⚠',
          title: 'Negative monthly cash flow',
          body: 'This property runs ' + SFF.fmt.money0(u.cashFlowMonthly) + '/mo. Refi, rent lift, or expense cuts needed to turn it positive.',
          value: null });
      }
      if (!out.length) out.push({ type: 'ok', level: 'ok', icon: '✓', title: 'Performing to plan', body: 'No action flagged — cash flow, DSCR and equity are all healthy.', value: null });
      return out;
    },
    // portfolio-level: grow existing vs diversify vs acquire
    forPortfolio: function () {
      var agg = perf.portfolio();
      var props = pf.properties();
      var out = [];

      // concentration by city
      var byCity = {};
      props.forEach(function (p) {
        var city = (p.address.split(',')[1] || 'Unknown').trim();
        byCity[city] = (byCity[city] || 0) + (p.currentValue || 0);
      });
      var cities = Object.keys(byCity);
      var topCity = cities.sort(function (a, b) { return byCity[b] - byCity[a]; })[0];
      var topShare = agg.value ? byCity[topCity] / agg.value : 0;
      if (topShare > 0.45 && props.length >= 2) {
        out.push({ level: 'diversify', icon: '⤢', title: 'Consider geographic diversification',
          body: SFF.fmt.pct(topShare, 0) + ' of portfolio value sits in ' + topCity + '. Adding a property in a different market reduces concentration risk. The Deal Finder can screen new markets.',
          cta: ['Screen new markets', 'deal-finder.html'] });
      }
      // strong equity + low leverage → grow
      if (agg.totalRefiExtractable > 40000) {
        out.push({ level: 'grow', icon: '↗', title: 'You can grow without new cash',
          body: 'About ' + SFF.fmt.money0(agg.totalRefiExtractable) + ' of equity is extractable across the portfolio at 75% LTV — enough to fund the down payment on the next acquisition (classic BRRRR recycle).',
          cta: ['Onboard the next property', 'onboard.html'] });
      }
      // strategy mix
      var strat = {}; props.forEach(function (p) { strat[p.strategy] = (strat[p.strategy] || 0) + 1; });
      if (!strat.STR) {
        out.push({ level: 'grow', icon: '◎', title: 'No short-term rental exposure',
          body: 'Your portfolio is all long-term hold. A single STR in a strong tourism market (like the Kawarthas) can lift blended cash-on-cash meaningfully.', cta: ['Find opportunities', 'deal-finder.html'] });
      }
      // healthy overall
      if (agg.blendedDSCR >= 1.3 && agg.cashFlowMonthly > 0) {
        out.push({ level: 'ok', icon: '✓', title: 'Portfolio is on solid footing',
          body: 'Blended DSCR of ' + agg.blendedDSCR.toFixed(2) + '× and ' + SFF.fmt.money0(agg.cashFlowMonthly) + '/mo net cash flow. Good base to scale from.', cta: null });
      }
      return { agg: agg, byCity: byCity, cards: out };
    }
  };

  SFF.pf = pf;
  SFF.perf = perf;
  SFF.insights = insights;
  SFF.seedPortfolio = seedPortfolio;
})(window);
