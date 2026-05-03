# SESSION BRIEF — Portfolio Intel Polish Pass (v2.46.0)

## Goal
Make Portfolio Intelligence production-grade: accurate numbers, readable charts with
interactive hover tooltips, data source transparency, and professional visual polish.
The dashboard should be something you'd confidently project on a screen in front of
a banker or investor and have them understand every number at a glance.

---

## 1. ACCURACY BUGS (Critical — Fix First)

### 1A. Analytics Expense Calculation is Incomplete
**Severity: HIGH — Numbers are wrong**

The `getPortfolioAnalytics()` DSCR trend and stress test expense calculations are
missing several cost categories that `getFinancesSummary()` correctly includes:

**DSCR Trend (line ~5289) and Stress Test (line ~5318) currently:**
```js
(p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) +
(p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0) +
(isR ? (p.monthly_rent_cost || 0) : 0) + (svcMap[p.id] || 0)
```

**Missing (compare to ramp curves line ~5241 and finances summary line ~9039):**
- `monthly_insurance`
- `Math.round((annual_taxes || 0) / 12)`
- `hoa_monthly`
- For owned properties: `monthly_mortgage` (should NOT be in operating expenses for DSCR
  since DSCR = NOI / debt service, and mortgage IS the debt service — but insurance/taxes/HOA
  ARE operating expenses that reduce NOI)
- Building cost allocations for child units (`buildingAlloc` pattern from finances summary)

**Impact:** DSCR trend shows artificially high DSCR. Stress test shows artificially
large cushion before breakeven. Both mislead bankers.

**Fix approach:** Create a shared `getPropertyMonthlyCost(p, svcMap, buildingAllocMap)`
helper function used by ALL three calculations (ramp curves, DSCR trend, stress test)
to ensure consistency. This function should match what getFinancesSummary uses:
- For DSCR/stress test: operating expenses EXCLUDING mortgage (since DSCR separates
  NOI from debt service)
- For ramp curves: ALL costs INCLUDING mortgage/rent (since breakeven = total cost)

### 1B. Analytics vs Summary Number Divergence Risk
The analytics endpoint and summary endpoint calculate independently. Portfolio Intel
shows KPIs from BOTH sources on the same screen. If a user sees DSCR from analytics
(executive dashboard uses `a.portfolio_summary.current_dscr`) and a different DSCR
from the summary endpoint (`_piData.portfolio.established.dscr`), trust breaks.

**Audit needed:** Compare every KPI shown side-by-side from both sources. Document
which source each number comes from. Consider whether analytics should consume
`getFinancesSummary()` internally instead of recalculating.

---

## 2. DATA PROVENANCE — Tell Users What They're Looking At

Every section should have a small info line explaining where the data comes from and
what time period it covers. Users (and bankers) need to trust the numbers, and trust
comes from transparency.

### Per-Section Data Source Notes

**Executive Dashboard:**
- Bank DSCR: "NOI ÷ annual debt service. NOI = T12 revenue (Guesty actuals) minus
  operating expenses (property records). Debt service from active loans."
- Revenue: "Trailing 12-month booking revenue from Guesty monthly actuals."
- Occupancy: "Weighted average from Guesty actuals across all active units."

**Debt & Coverage:**
- DSCR Trend: "Monthly portfolio DSCR calculated from Guesty revenue actuals divided
  by total active loan payments. Operating expenses from property records."
- Debt Schedule: "Active loans from the Loans tab. Rates and balances as entered."

**Growth Story:**
- "Acquisition dates from property purchase_date or lease_start_date fields."

**Ramp Curves:**
- "Monthly revenue from Guesty actuals. Monthly cost = rent/mortgage + insurance +
  taxes + HOA + utilities + services. Breakeven = first month revenue exceeds cost."

**Unit Economics:**
- "Stabilized revenue = average of last 3 months of Guesty actuals. Only properties
  with 6+ months of data included in stabilized averages."

**Stress Test:**
- "Scenarios model revenue drops against trailing 12-month actuals with expenses held
  constant. DSCR = adjusted NOI ÷ annual debt service."

**Market Position:**
- "Your ADR = trailing 6-month average nightly rate from Guesty. Market data from
  PriceLabs API (base_price, recommended_base_price, forward occupancy)."

**Concentration:**
- "Revenue by city from trailing 12-month Guesty actuals."

### Implementation
Add an info icon (ⓘ) next to each section header that expands a data source note on
click or hover. Use a `<details>` or a small collapsible pattern. Keep it unobtrusive
but always accessible. Example:

```html
<details style="display:inline;">
  <summary style="cursor:help;font-size:0.65rem;color:var(--text3);display:inline;">
    ⓘ Data source
  </summary>
  <div style="...">Revenue: Guesty monthly actuals. Expenses: property records...</div>
</details>
```

---

## 3. INTERACTIVE HOVER TOOLTIPS (Replace SVG `<title>`)

SVG native `<title>` tooltips are:
- Delayed (browser waits ~1 second)
- Unstyled (plain OS tooltip, no formatting, no colors)
- Can't show multi-line data or calculations
- Don't follow the cursor

**Replace with the dashboard chart tooltip pattern** (see `00-dashboard.js` lines 280-340):
1. Create invisible `<rect>` hit zones over each data point/column
2. Add a positioned `<div>` tooltip element after the SVG
3. Wire up mouseenter/mousemove/mouseleave via `setTimeout` after render
4. Show rich formatted HTML with actual breakdown data

### Tooltip Content by Chart

**DSCR Trend (hover on dot):**
```
┌─────────────────────────────┐
│ Apr '25                     │
│ ● DSCR: 1.42x              │
│   Revenue:  $18,400         │
│   Expenses: $12,100         │
│   NOI:      $6,300          │
│   Debt Svc: $4,430/mo       │
│                             │
│   ↑ 0.15x from prev month  │
└─────────────────────────────┘
```

**Ramp Curves (hover on line segment/dot):**
```
┌─────────────────────────────┐
│ 123 Main St — Month 8       │
│ Revenue:    $4,200           │
│ Occupancy:  72%              │
│ ADR:        $195             │
│ Monthly Cost: $2,800         │
│ NOI:        $1,400           │
│ ✓ Past breakeven (Mo 5)     │
└─────────────────────────────┘
```

**Unit Economics Bars (hover on bar):**
```
┌─────────────────────────────┐
│ 123 Main St                  │
│ Monthly Cost:    $2,800      │
│ Stabilized Rev:  $4,200      │
│ NOI:            $1,400       │
│ Margin:          33%         │
│ Breakeven:       Month 3     │
└─────────────────────────────┘
```

**Stress Test Bars (hover on bar):**
```
┌─────────────────────────────┐
│ -20% Revenue Scenario        │
│ Revenue:   $142K             │
│ NOI:       $38K              │
│ DSCR:      1.12x  ⚠ Tight   │
│ Cash Flow: $5.2K             │
└─────────────────────────────┘
```

**Concentration Bars (hover on bar):**
```
┌─────────────────────────────┐
│ Middletown, CT               │
│ Revenue: $98,400 (52%)       │
│ 4 units                      │
│ Avg Rev/Unit: $2,050/mo      │
└─────────────────────────────┘
```

### Implementation Approach
Create a shared tooltip helper since all charts need the same pattern:

```js
// Reusable: creates tooltip div, returns { id, show(html, x, y), hide() }
function _piCreateTooltip(containerId) {
  // Returns tooltip ID to reference in setTimeout wiring
}

function _piWireTooltips(svgContainerId, tooltipId, hitZoneSelector, dataLookup) {
  // Generic wiring: mouseenter shows, mousemove positions, mouseleave hides
}
```

Each SVG chart assigns unique IDs and stores data in `window._piChartData_xxx`
for tooltip lookups (same pattern as dashboard's `window._projData`).

---

## 4. CHART VISUAL IMPROVEMENTS

### General Chart Polish
- **Font size:** Bump axis labels from 8-9px to 10-11px. Currently too small on
  mobile and even on desktop. Use `font-size:10px` minimum for all SVG text.
- **Axis labels:** Add Y-axis title text (rotated) like "DSCR" or "Revenue ($)"
  so the chart is self-explanatory even without reading the section header.
- **Grid lines:** Make them slightly more visible — current `opacity:0.4` with
  `stroke-dasharray:2,4` is very faint. Try `opacity:0.5` with `stroke-dasharray:3,4`.
- **Current month indicator:** On DSCR trend, highlight the most recent month with
  a slightly larger dot and a subtle background band.
- **Color legend:** Move legends from below the chart to a floating position in the
  top-right corner of the chart area (inside the SVG) so they're visible while
  reading the chart.

### DSCR Trend Chart
- Add a subtle green zone fill above 1.25x (safe zone) and red zone fill below 1.0x
  (danger zone) so the chart immediately communicates health status visually
- Show month-over-month change arrows (▲/▼) next to the most recent data point
- Consider making the chart taller (200-220px instead of 180px) for better readability

### Ramp Curves Chart
- **Thicker lines for fewer properties** — with 3-5 properties, use stroke-width 2.5;
  with 10+, drop to 1.5 so lines don't overlap into mush
- **Hover highlight:** When hovering a property line, bold it and dim the others
  (set other lines to opacity 0.2). This requires JS wiring.
- Add a horizontal dashed line showing average monthly cost across all properties
  (the "breakeven line") so it's visually obvious which properties are above/below

### Unit Economics Bar Chart
- Add a thin vertical line or marker showing NOI (revenue bar minus cost bar length)
  so the profit gap is immediately visible
- Consider a "NOI" label at the end of each pair showing the delta

### Stress Test Bar Chart
- Add subtle background color bands: green for DSCR ≥ 1.25, yellow for 1.0-1.25,
  red for < 1.0
- Make the current scenario bar slightly thicker/bolder

### Concentration Chart
- Use CSS `%` width instead of SVG — the current div-based approach already works
  but could use a subtle gradient fill and rounded ends for visual polish
- Add total portfolio revenue somewhere so percentages have context

### Growth Timeline
- Add unit count milestone markers ("3 units", "5 units", "8 units") above the timeline
- Make dots larger for purchased vs rental to emphasize the portfolio mix

---

## 5. READABILITY & COLLISION FIXES

### Known Issues
- **SVG text clipping:** Month labels on DSCR trend and ramp charts can collide when
  there are many data points. Use `text-anchor:middle` and skip labels dynamically
  based on available space (current skip-every-3rd is OK for 18 months but check
  edge cases with 6 months or 24 months).
- **Table header truncation:** Market Position table has 8 columns — on mobile, the
  horizontal scroll works but headers "PL Recommended" and "Occ Delta" may not be
  obvious. Consider shorter labels or a responsive stacked layout for mobile.
- **Card text overflow:** Executive dashboard KPI cards with long values like
  "$1.2M/yr" or "1.42x" need to not overflow their container. Use
  `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` on the value div.
- **DM Mono font:** Verify it's actually loaded. If the Google Font fails to load,
  monospace numbers fall back to system monospace which changes the layout. Consider
  adding `'Courier New', monospace` as explicit fallback in the font-family stack.

### Mobile Specific
- Growth timeline connector lines use `position:absolute` with `right:-50%` which
  can break on narrow screens. Test with 10+ properties on a 375px viewport.
- KPI card grid `minmax(150px, 1fr)` might show 1 column on very narrow screens
  — verify this looks decent and doesn't waste too much vertical space.

---

## 6. SMALL ENHANCEMENTS

- **Click-to-property:** In ramp curves detail table, market position table, and
  unit economics chart, make property names clickable to open that property's detail
  page: `onclick="openProperty(${propertyId})"` — the property_id is available in
  all the analytics data.

- **Empty state messages:** When a section has no data (e.g., no PriceLabs data for
  market position, no loans for debt coverage), show a helpful message explaining
  what to set up, not just hiding the section silently. Example: "Connect PriceLabs
  to see market benchmarks" or "Add loans in the Loans tab to see debt coverage."

- **Print-friendly:** Add a `@media print` consideration — SVG charts should print
  with light backgrounds, dark text, and no interactive hover elements.

---

## File References
- `frontend/parts/js/17-portfolio-intel.js` — main file to edit (~1179 lines)
- `frontend/parts/js/00-dashboard.js` lines 200-340 — reference tooltip implementation
- `src/worker.js` line 5181 — `getPortfolioAnalytics()` backend (expense fix needed)
- `src/worker.js` line 8857 — `getFinancesSummary()` (reference for correct expense calc)
- `src/worker.js` line 9039 — per-property expense calculation (the correct one)
- `frontend/parts/styles.css` — global styles, `.comp-table`, `.card-header`

## Approach
1. Fix backend accuracy bug first (expense calculation)
2. Build shared tooltip infrastructure
3. Upgrade each chart one at a time (DSCR → Ramp → Unit Econ → Stress → Concentration)
4. Add data source notes to each section
5. Polish readability/fonts/spacing
6. Test on mobile viewport (375px)

## Version
Bump to v2.46.0. This is a polish/accuracy pass — no new sections, no new endpoints.
