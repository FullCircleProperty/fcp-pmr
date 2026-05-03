# SESSION BRIEF — PI Expense Data Fixes (v2.48.1)

## Problem
YoY Performance in Portfolio Intel showed contradictory expenses — going up and down between years when they should only ever stay the same or increase as units are added. Made the entire PI section look unreliable for bank/investor pitches.

## Root Causes (3 bugs in `getPortfolioAnalytics()`)

### Bug 1: Child units got $0 building expenses
**Where:** `propCostInfo` construction (line ~5329)
**What:** The opex calculation read `p.monthly_insurance`, `p.annual_taxes`, `p.hoa_monthly`, `p.monthly_mortgage` directly from each property row. For child units of a multi-family building, these fields are empty — the costs live on the parent building record. So child units showed $0 for insurance, taxes, HOA, and mortgage.
**Impact:** Multi-family units appeared nearly cost-free in YoY table, making NOI look artificially high.
**Fix:** Load parent building records, split building costs (insurance, taxes, HOA, mortgage) by child count, and apply to each child unit.

### Bug 2: Expenses tied to data-months, not calendar months
**Where:** YoY expense loop (line ~5530)
**What:** `activeMonths = yrMonths.length` — where `yrMonths` is the number of months with actual booking data, NOT calendar months. For 2024 with only 3 months of Guesty data but 12 months of real expenses, expenses showed `opex × 3` instead of `opex × 12`. Then 2025 with full data showed `opex × 12`, making expenses appear to quadruple.
**Impact:** Expenses went up and down arbitrarily based on data availability, not business reality.
**Fix:** Use calendar months (12 for past years, elapsed months for current year) adjusted by property start date. Expenses reflect real-world obligations regardless of booking data completeness.

### Bug 3: Child units missing acquisition dates
**Where:** `propCostInfo.startMonth` and ramp curve `startDate`
**What:** `pushBuildingToUnits()` pushes address/city/state but NOT `purchase_date`. Child units fell back to `created_at` (when added to PMR) instead of building acquisition date, causing incorrect start-of-operations timing.
**Fix:** Fall through to parent building's `purchase_date` when child unit's own date is missing.

## Why This Matters
The PI Summary tab (`getPortfolioIntelSummary`) actually handled all of this correctly — it used `getFinancesSummary()` as single source of truth and properly split building costs. But `getPortfolioAnalytics()` (YoY table, DSCR trend, ramp curves) did its own independent calculation that skipped building hierarchy entirely. Classic parallel-engine bug.

## What Changed
- `src/worker.js` — `getPortfolioAnalytics()` function:
  - Added building data loading for child unit cost inheritance
  - `propCostInfo`: splits building insurance/taxes/HOA/mortgage by child count
  - `propCostInfo`: uses parent purchase_date when child has none
  - YoY loop: calendar months instead of data-months for expenses
  - Ramp curves: same child-unit cost splitting and date inheritance
- `package.json` — version 2.48.0 → 2.48.1

## Expected Behavior After Fix
- Expenses in YoY table should monotonically increase (or stay flat) as units are added
- Child units of multi-family buildings show their proportional share of building costs
- Ramp curves show correct monthly cost including building cost allocation
- DSCR calculations use correct expense figures
- YoY expenses for data-sparse years (pre-Guesty) reflect real calendar costs, not data availability
