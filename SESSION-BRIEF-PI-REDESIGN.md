# SESSION BRIEF — Portfolio Intelligence Redesign (Frontend)

## Upload this file with the tarball at the start of next session.
**Tarball:** fcp-pmr-v2.44.0.tar.gz
**Action:** Extract, validate (26/26), audit (14/14), then implement below.

---

## Context

The backend analytics endpoint `GET /api/portfolio/analytics` is BUILT and DEPLOYED in v2.44.0. It returns:

```json
{
  "ramp_curves": [{ property_id, label, start_date, months_active, monthly_cost, total_revenue, avg_monthly_revenue, stabilized_monthly_revenue, peak_monthly_revenue, breakeven_month, monthly_noi, data: [{ month_num, month, revenue, occupancy, adr }] }],
  "unit_economics": { total_units, avg_monthly_cost, avg_stabilized_revenue, avg_stabilized_noi, avg_months_to_breakeven, avg_noi_margin },
  "dscr_trend": [{ month, revenue, noi, debt_service, dscr }],
  "market_benchmarks": [{ property_id, label, your_adr, market_base_price, pl_recommended, your_occ, your_fwd_occ, market_fwd_occ, occ_vs_market }],
  "stress_test": { scenarios: [{ label, revenue, noi, dscr, cash_flow }], breakeven_revenue_drop, trailing_12_revenue, annual_debt_service },
  "concentration": [{ city, revenue, units, pct_of_total }],
  "growth_timeline": [{ property_id, label, date, type, city, state }],
  "debt_schedule": { loans: [...], total_balance, total_monthly_payment, weighted_avg_rate, debt_yield, debt_to_revenue },
  "portfolio_summary": { total_units, trail_12_revenue, trail_12_expenses, trail_12_noi, annual_debt_service, current_dscr }
}
```

The existing PI summary endpoint `GET /api/portfolio/summary` still exists and returns the original data (portfolio P&L, properties, trend, balance sheet, stabilized projections, loan recommendation, etc.).

## What To Build: Frontend Redesign of 17-portfolio-intel.js

### Design Principles
- **Profile-driven**: Bank view shows sections in DSCR/debt-first order. Investor view shows growth/returns-first order.
- **Not a rehash of Finances**: Remove all duplicated P&L content. PI is strategic intelligence, not accounting.
- **Data-driven storytelling**: Each section tells a story with charts and metrics, not just tables of numbers.

### Section Order by Audience

**Bank / Lender Profile:**
1. Executive Dashboard (headline KPIs: DSCR, LTV, Equity, Debt Yield)
2. Debt & Coverage (DSCR trend chart, debt schedule, balance sheet)
3. Property Performance Ramps (proving the model works)
4. Unit Economics (scalability proof)
5. Stress Testing (risk management)
6. Market Position (operational competence)
7. Growth Story (timeline, YoY)
8. Concentration Risk (diversification)
9. AI Narrative + History

**Investor Profile:**
1. Executive Dashboard (headline KPIs: Revenue Growth, NOI Margin, Cash-on-Cash, Units)
2. Growth Story (timeline, YoY, trajectory)
3. Property Performance Ramps
4. Unit Economics
5. Market Position
6. Debt & Coverage (lighter emphasis)
7. Concentration Risk
8. Stress Testing
9. AI Narrative + History

### Sections to Build

1. **Executive Dashboard** — 5-6 hero KPI cards. Different metrics per audience.

2. **Growth Story** — Property acquisition timeline (visual). YoY revenue chart. Unit count over time.

3. **Property Ramp Curves** — Overlaid line chart showing each property's revenue from Month 0. Color-coded by ownership type. Shows the predictable ramp pattern.

4. **Unit Economics** — Cards: avg cost per unit, avg time to breakeven, avg stabilized NOI, NOI margin. Bar chart comparing per-property stabilized revenue vs cost.

5. **Debt & Coverage** — DSCR trend line chart (18 months). Balance sheet cards. Debt schedule table with maturity dates. Weighted avg rate.

6. **Market Position** — Table: your ADR vs market, your occ vs market, with green/red delta indicators.

7. **Stress Testing** — Table/chart: revenue at -10%, -20%, -30%, -40% with resulting DSCR and cash flow. Highlight breakeven point.

8. **Concentration Risk** — Horizontal bar chart showing revenue % by city.

9. **AI Narrative** — Already built in v2.43.7. Auto-loads latest, has history.

### Functions to Keep from Current File
- `loadPortfolioIntel()` — entry point (modify to load analytics data)
- `switchPortfolioProfile()`, `switchPortfolioTimeframe()` — profile/timeframe switchers
- `_piCardHtml()` — reusable card component
- `_piMonthLabel()`, `_piK()` — formatters
- All narrative functions (`_piRenderNarrativePanel`, `_piLoadNarrativeAuto`, etc.)
- `capturePortfolioSnapshot()`, `_piRenderSnapshotHistory()`
- `_piRenderProfileManager()` — profile management UI
- Scenario functions (`loadPortfolioScenario`, `_piRenderScenarioPanel`)

### Functions to Remove/Replace
- `_piRenderSummaryCards()` — replace with new Executive Dashboard
- `_piRenderRevenueTrend()` — replace with DSCR trend + growth charts
- `_piRenderPropertyGrid()` — replace with ramp curves
- `_piRenderRampUp()` — fold into ramp curves
- `_piRenderProjectionsPanel()` / `loadPortfolioProjections()` — fold into growth story
- `_piRenderLoanRec()` — fold into debt & coverage
- `_piRenderLoanGuide()` — remove (loan guide is basic info, not intelligence)
- `piShowTip()` — rebuild for new chart tooltips

### Data Loading
`loadPortfolioIntel()` should make TWO API calls:
1. `GET /api/portfolio/summary` — existing data (portfolio totals, profile, balance sheet)
2. `GET /api/portfolio/analytics` — new analytics data (ramp curves, DSCR trend, etc.)

Store both: `_piData` (summary) and `_piAnalytics` (analytics).

### Chart Rendering
Use inline SVG for all charts (no external libraries). The platform already uses this pattern in the revenue trend chart. Keep it lightweight.

### Hard Rules
- DO NOT duplicate Finances tab content
- DO NOT show raw property P&L tables (that's Finances)
- Every section must answer "why does this matter to a bank/investor?"
- Use `_piData.profile` to determine section order and emphasis
- All monetary values use `_piK()` formatter
- All cards use `_piCardHtml()` or similar reusable pattern
