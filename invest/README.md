# BRRRR Deal Lab — Multi-Family Investment Analyzer

A self-contained web app for assessing multi-family properties, computing
purchasing pricepoints & BRRRR recommendations, finding cash-flowing deals
near an address on a map, and monitoring a portfolio of properties under
management. **Cash flow is the key metric** throughout.

Live path (GitHub Pages): `https://straightfinfarms.com/invest/`

No build step, no backend. Pure static HTML/CSS/JS. All of your data
(prospects, portfolio) is stored locally in your browser via `localStorage`.

## The three tools

### 1. Analyzer (`Analyzer` tab)
Enter a property's numbers and everything recalculates live:
- **BRRRR score (0–100) + letter grade + buy/pass recommendation.**
- **Purchasing pricepoints** — what to pay to hit each goal:
  - *Max offer to recover ALL capital* — the true BRRRR target (the price at
    which your cash-out refinance returns 100% of the cash you put in).
  - *70% Rule MAO* — `0.70 × ARV − rehab`.
  - *Target cash-on-cash price* and *target cash-flow price*.
- Full underwriting detail: NOI, ARV, cash-in/cash-out, DSCR, cap rate, CoC,
  rent-to-price, equity at refi, expense ratio.

You can **Save to Deal Finder** (adds a map pin) or **Add to Portfolio**.

### 2. Deal Finder (`Deal Finder` tab)
- Type an address/place → the map centers there (OpenStreetMap + Leaflet).
- Saved prospects within your radius are ranked **by cash flow per unit** and
  drawn as color-coded, grade-labeled markers (green = strong, red = pass).
- Filter by minimum rating. **Click the map to drop a new prospect.**
- Open any deal straight into the Analyzer.

### 3. Portfolio (`Portfolio` tab)
Track & monitor properties you own:
- Portfolio KPIs: total value, equity, monthly cash flow, cash-on-cash,
  portfolio DSCR, average occupancy.
- Per-property live metrics with health alerts (negative cash flow, DSCR < 1.2,
  low occupancy).
- Export / import all your data as JSON for backup.

## The BRRRR scoring model

Score is a weighted 0–100 blend, deliberately **cash-flow dominant**:

| Criterion | Weight | Why |
|---|---|---|
| Cash flow / unit / month | **35** | The key. Everything else is secondary. |
| Capital recovered at refi | 20 | BRRRR only "repeats" if you get your cash back. |
| Cash-on-cash return | 15 | Return on the capital you *don't* recover. |
| DSCR | 12 | Lender safety / resilience. |
| Cap rate (on purchase) | 10 | Value relative to income. |
| Rent-to-price ("1% rule") | 8 | Quick income-density sanity check. |

Grades: A+ (90+) … F (<40). Recommendation bands: **Strong Buy** (≥78),
**Buy/Negotiate** (≥66), **Marginal** (≥52), **Pass** (<52) — each also
requires positive cash flow to earn a buy.

## Methodology notes / assumptions

- **ARV** can be income-based (`stabilized NOI ÷ market cap rate`) or entered
  manually.
- **Refinance** assumes short seasoning (purchase-loan payoff ≈ original
  balance). Cash-out = `refi loan − purchase loan − refi closing`.
- **Post-refi cash flow** drives scoring — it reflects the property once it's
  stabilized and long-term financed. At high rates with a market cap rate below
  the mortgage constant you'll see negative leverage (thin cash flow); that is
  real and the model surfaces it rather than hiding it.
- Expenses are itemized when provided, otherwise estimated from an expense
  ratio. Reserves and management are always counted.
- Pricepoints are solved numerically so every dependent cost (down payment,
  closing, holding) stays internally consistent at each candidate price.

**This is an underwriting aid, not financial advice.** Verify rents, comps,
taxes, insurance, and lender terms before making offers.

## Files
```
invest/
  index.html          app shell + tabs
  css/app.css         styles
  js/finance.js       underwriting + BRRRR scoring + pricepoint solver (pure)
  js/store.js         localStorage persistence + seed market data
  js/geo.js           geocoding (OSM Nominatim) + distance
  js/analyze.js       Analyzer tab UI
  js/finder.js        Deal Finder map/tab UI
  js/portfolio.js     Portfolio tab UI
  js/app.js           bootstrap, tab nav, toast/modal helpers
  vendor/leaflet/     Leaflet 1.9.4 (vendored — no CDN dependency)
```

Map tiles and address geocoding are fetched at runtime from OpenStreetMap in
the visitor's browser; everything else runs offline.
