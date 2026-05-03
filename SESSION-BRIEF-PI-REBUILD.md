# SESSION BRIEF — Portfolio Intelligence Rebuild

## Start Here
Upload this brief + the latest tarball (v2.48.4+). Read this file first, then extract and work from the codebase. This is a **rebuild** of the PI analytics layer — not a patch.

---

## Why This Rebuild

PI has been producing inaccurate, misleading numbers since it was built. The root cause is architectural: **PI re-derives revenue, expenses, and NOI from raw `monthly_actuals` using its own calculation logic** — different date filters, different property groupings, different expense math than the Finances tab. Every fix to one breaks the other. The result is a dashboard that contradicts the user's own financial data, which destroys trust and makes PI worse than useless.

### Specific failures that triggered this rebuild:
1. **Revenue mismatch** — PI showed $224K "All Time" when Finances showed $305K for the same period. Root causes: hardcoded `2020-01` start date, exclusive `<` vs inclusive `<=` month filter, different property set logic.
2. **`buildingMap` crash** — `Cannot access 'buildingMap' before initialization` crashed the entire analytics function, causing Unit Economics to show all $0.
3. **YoY Performance misleading** — expenses calculated as `monthlyOpEx × activeMonths` using a formula that doesn't match Finances. 2027 projection showed -$65K NOI and -0.94x DSCR — alarming numbers that may not reflect reality.
4. **Expense counting wrong** — child units sometimes got $0 building expenses, sometimes got full building expenses. Calendar months vs data months inconsistency.
5. **Charts confusing** — revenue bars with NOI overlay are hard to read. Projected years visually dominate actuals. Data feels "clumped together."

### The mandate from the user:
> "PI should LOOK at the finances, not build its own fucking finances. Any bank would look at this and tell me to go fuck myself."

---

## Architecture Principle: Single Source of Truth

**PI must NEVER re-derive financial numbers.** Every dollar amount in PI must trace directly to one of these sources:

| Data | Source | How PI Gets It |
|------|--------|----------------|
| Revenue (per property, per month) | `monthly_actuals` table via `getFinanceMonthlyActuals()` | Same query Finances uses — no date floor, no property re-filtering |
| Monthly costs (per property) | `getFinancesSummary().properties[].monthly_cost` | Already computed correctly with building allocations, utilities, services |
| Property list & exclusions | `getFinancesSummary().properties[]` | Excludes buildings, research, managed — same set Finances shows |
| Loan/debt data | `loans` table | Direct query, same as Finances |
| Actuals by month | `getFinanceMonthlyActuals().actuals[]` | Raw monthly_actuals rows, pre-filtered for research/managed |

**What PI adds on top (presentation, not calculation):**
- Time-period filtering (YTD, by year, all time, custom)
- YoY comparison tables
- Ramp curve visualization
- Unit economics aggregation
- DSCR trend computation
- Audience-specific views (bank, investor, internal)
- Stress testing / projections

---

## What To Rebuild

### 1. Data Loading — Use Finances as Foundation

Current PI calls `getFinancesSummary()` but then re-queries `monthly_actuals` separately with its own filters. **Stop doing that.**

```
// CORRECT approach:
const finRes = await getFinancesSummary(env, null);
const finData = await finRes.json();
const props = finData.properties;           // Property list (already filtered)
const maData = await getFinanceMonthlyActuals(env);
const actuals = maData.actuals;             // ALL actuals, no date floor
// Then filter actuals by selected time period in JS
```

The key rules:
- **No hardcoded date floors** — `periodStart` for "All Time" should capture everything
- **Inclusive month filtering** — `month >= start && month <= end` (not `<`)
- **Property set = finProps** — whatever Finances shows, PI shows. No re-querying properties.
- **Monthly cost = `fp.monthly_cost`** — already includes building allocation, utilities, services. Don't recalculate.

### 2. YoY Performance Table — Make It Accurate

The YoY table is the most important section for banks/investors. It must be bulletproof.

**Per year, compute:**
- **Units**: Count of properties that had ANY actuals in that year (not total portfolio size)
- **Added**: New properties that had their first actual in that year
- **Revenue**: Sum of `total_revenue` from actuals for that year — straight from the DB, no manipulation
- **Expenses**: Sum of each property's `monthly_cost × months_active_in_year` — where `months_active` = number of months that property has actuals in that year
- **NOI**: Revenue - Expenses
- **Margin**: NOI / Revenue
- **DSCR**: NOI / Annual Debt Service
- **Occupancy**: Average `occupancy_pct` across all actuals for that year (weighted by property-months)
- **Rev/Unit**: Revenue / Units

**For projected years:**
- Use trailing actuals to project, clearly label as "~2026 Projected" with tilde prefix
- Base projection on actual run-rate from recent months, not on theoretical stabilized revenue
- Show the methodology: "Based on [X] months of data at $[Y]/mo run rate"

**Do NOT:**
- Show expenses that don't match Finances
- Use `monthlyOpEx × 12` when a property was only active for 3 months
- Show DSCR for years where debt service is $0 (show "—" instead)

### 3. Executive Dashboard Cards — Clear and Honest

Current cards show confusing/contradictory numbers. Rebuild with these cards:

**For Internal audience:**
| Card | Value | Source |
|------|-------|--------|
| Revenue | Sum of actuals for selected period | `actuals.reduce(total_revenue)` |
| NOI | Revenue - Expenses | Derived from above |
| DSCR | NOI / Debt Service | Only show if debt > 0 |
| Units | Count of properties with actuals | Active units only |
| Avg Occupancy | Weighted average | From actuals |
| YoY Growth | Compare to same period last year | Only show if comp data exists |

**For Bank/Investor audience:**
- Same numbers, different emphasis
- Lead with DSCR, NOI Margin, Debt Yield
- Hide if data doesn't support (< 6 months history)

### 4. Charts — Clean and Readable

**YoY Revenue Bar Chart:**
- One bar per year, actual years only (no projections in the main chart)
- Revenue bar in solid blue
- NOI line overlay (not a second bar)
- Clear axis labels, no overlapping text
- Projected years in a separate, clearly delineated section

**Ramp Curves:**
- Keep the per-property monthly revenue timeline
- Show breakeven line (monthly cost) as a dotted horizontal
- Remove clutter — no more than 6 properties visible at once, use pagination or filtering

### 5. Unit Economics — Derive from Real Data

- **Avg Monthly Cost**: Average of `fp.monthly_cost` across active properties (from Finances)
- **Avg Stabilized Revenue**: Average monthly revenue for properties with 6+ months of data (from last 3 months of actuals)
- **Avg Unit NOI**: Stabilized Revenue - Monthly Cost
- **Breakeven**: Month number where cumulative revenue first exceeded cumulative cost
- **Active Units**: Count of properties that generated revenue in the selected period

### 6. Stress Testing — Keep but Fix

The stress test scenarios are useful for investors. Keep them but ensure they use the correct base numbers (from the rebuilt revenue/expense pipeline).

### 7. Concentration Analysis — Keep

Geographic and property-type concentration is useful. Just make sure the revenue numbers come from the same source as everything else.

---

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/worker.js` | ~17,500 | Monolith backend — PI functions start around line 4617 |
| `frontend/parts/js/17-portfolio-intel.js` | ~850 | PI frontend rendering |

### Backend functions to rebuild:
- `getPortfolioIntelSummary()` (~line 4617) — Main PI summary endpoint. This is the big one.
- `_getPortfolioAnalyticsInner()` (~line 5215) — Deeper analytics (ramp curves, unit economics, DSCR trend, YoY). Called by `/api/portfolio/analytics`.

### Backend functions to KEEP AS-IS:
- `getFinancesSummary()` — Source of truth for costs. Don't touch.
- `getFinanceMonthlyActuals()` — Source of truth for actuals. Don't touch.
- `capturePortfolioSnapshot()` — Snapshot system, fine as-is.
- `generatePortfolioScenario()` — Scenario modeling, fine but should use rebuilt numbers.

### Frontend to rebuild:
- `17-portfolio-intel.js` — The entire rendering layer. Keep the structure (tabs, cards, sections) but rebuild the data display logic.

---

## Implementation Plan

### Phase 1: Backend — `getPortfolioIntelSummary()` rebuild
1. Load data from `getFinancesSummary()` and `getFinanceMonthlyActuals()` — no independent queries
2. Apply time-period filtering to actuals in JS (not SQL)
3. Compute per-property period revenue from filtered actuals
4. Use `fp.monthly_cost` from Finances for all expense calculations
5. Build YoY table from actuals grouped by year
6. Return clean, verified numbers

### Phase 2: Backend — `_getPortfolioAnalyticsInner()` rebuild
1. Same data loading approach — Finances as foundation
2. Ramp curves use per-property actuals timeline
3. Unit economics derived from real actuals + Finances costs
4. DSCR trend uses real monthly numbers
5. Stress test uses verified base numbers

### Phase 3: Frontend — `17-portfolio-intel.js` rebuild
1. Executive Dashboard cards — clear, accurate, sourced
2. YoY table — bulletproof numbers, clean layout
3. Charts — readable, not clumped
4. Ramp curves — per-property with breakeven overlay
5. Unit Economics section — real numbers
6. Debt & Coverage — from loans table

### Phase 4: Verification
1. Compare PI "All Time" Revenue to Finances "All Time" Revenue — must match exactly
2. Compare PI per-property revenue to Finances per-property actuals — must match
3. Compare PI expenses to Finances monthly costs — must match
4. Test all time periods: YTD, last year, all time, custom range
5. Test with bank/investor audience profiles

---

## Validation Checklist (Must Pass Before Delivery)

- [ ] PI "All Time" Revenue === Finances "All Time" Revenue (exact match)
- [ ] PI per-property revenue matches Finances actuals for same period
- [ ] PI expenses use `fp.monthly_cost` from Finances (not re-derived)
- [ ] YoY table units count = properties with actuals in that year
- [ ] YoY expenses = sum of (monthly_cost × months_active) per property per year
- [ ] No hardcoded date floors (no `2020-01` or similar)
- [ ] Month filtering is inclusive (`<=` not `<`)
- [ ] DSCR only shown when debt > 0
- [ ] Projected years clearly labeled with `~` prefix
- [ ] Charts are readable — no overlapping text, clear axis labels
- [ ] All quality gates pass (validate.js 27 checks, audit.js 14 checks, node --check)
- [ ] Version bumped

---

## Business Context Reminders

- **Portfolio mix**: 4 owned properties, 8 rental arbitrage. Most units are rental (not owned assets).
- **Buildings**: Multi-family buildings are parents — child units inherit split costs. Buildings excluded from property lists.
- **Managed/Research**: Jupiter FL is managed (owner's property). Palm City is research only. Both excluded from portfolio KPIs.
- **Hostfully import**: Historical pre-Guesty data layered into `monthly_actuals`. Airbnb rows auto-skipped (Guesty has them).
- **This dashboard is for banks and investors**. Every number must be defensible. If data is insufficient, say so — don't estimate and present as fact.

---

## What NOT To Do

1. **Don't re-query `monthly_actuals` with your own filters** — use `getFinanceMonthlyActuals()`
2. **Don't calculate monthly costs from property fields** — use `fp.monthly_cost` from Finances
3. **Don't show projections as actuals** — always prefix with `~` or `Est.`
4. **Don't show misleading DSCR** — negative DSCR from projected years terrifies investors for wrong reasons
5. **Don't make charts that require explanation** — if someone needs you to explain what a chart means, the chart failed
6. **Don't build complex intermediate state** — simpler code = fewer discrepancy bugs

---

## Files In Tarball
```
src/worker.js              — monolith backend (~17,500 lines)
frontend/parts/js/          — 20 frontend modules (00-dashboard through 19-import)
frontend/parts/app-html.html — main HTML template
dist/worker.js              — built worker
package.json                — version (bump every build!)
build.js, validate.js, audit.js, deploy.sh
.last-deployed-version      — version bump tracker (validate.js checks this)
DEPLOYMENTS.md, README.md
SESSION-BRIEF-*.md          — session briefs
```
