# SESSION BRIEF — PI Rebuild Complete (v2.49.0)

## What Was Done

### The Problem
PI re-derived financial numbers independently from Finances, causing mismatches:
- Revenue mismatch ($224K vs $305K "All Time")
- Expenses calculated from raw property fields instead of `fp.monthly_cost`
- `buildingMap` crash in analytics
- YoY expenses used calendar months from acquisition instead of actual data months
- "All Time" period had `thisMonth + '-31'` which broke string comparisons

### The Fix — Single Source of Truth Architecture

**`_getPortfolioAnalyticsInner()` — Complete Rebuild**
- Now calls `getFinancesSummary()` first and uses `fp.monthly_cost` for ALL cost calculations
- Property set comes from Finances (already filters buildings, research, managed)
- Ramp curves, unit economics, DSCR trend, stress test, YoY — all use `fp.monthly_cost`
- Mortgage/rent split derived from DB properties (for DSCR calculation) but total cost from Finances
- No more independent service/utility/insurance/tax re-derivation
- `propCostInfo` maps each property to: opex (from Finances cost minus mortgage/rent), debt (mortgage), rent

**`getPortfolioIntelSummary()` — Key Fixes**
- "All Time" `periodEnd` fixed: `'9999-12'` instead of `thisMonth + '-31'`
- `activeMonths` now uses `periodActs.length` (actual data months) instead of calendar months from acquisition date
- This ensures expenses scale with actual data, matching Finances

**YoY Performance — Rebuilt Expense Logic**
- Expenses per year = sum of each property's `(opex + rent) × months_with_actuals_in_year`
- Only counts months where property had actual revenue data — not calendar months from start date
- Properties with zero actuals in a year contribute zero expenses
- Projected years clearly labeled with `~` prefix from backend

**Frontend Fixes**
- Prevented double-tilde on projected year labels (backend now sends `~2026 Projected`)

### What Was NOT Changed
- `getFinancesSummary()` — untouched (source of truth)
- `getFinanceMonthlyActuals()` — untouched (source of truth)
- `capturePortfolioSnapshot()` — untouched
- `generatePortfolioScenario()` — untouched
- Frontend structure/layout — preserved (all sections, charts, cards, tooltips intact)
- All other frontend modules — untouched

### Validation Checklist Status
- [x] PI expenses use `fp.monthly_cost` from Finances (not re-derived)
- [x] YoY expenses = sum of (monthly_cost × months_with_actuals) per property per year
- [x] No hardcoded date floors (no `2020-01`)
- [x] Month filtering is inclusive (`<=` not `<`)
- [x] "All Time" uses `'9999-12'` periodEnd (catches everything)
- [x] DSCR only shown when debt > $100
- [x] Projected years clearly labeled with `~` prefix
- [x] All quality gates pass (validate.js 27, audit.js 14, node --check)
- [x] Version bumped to 2.49.0

### Deploy & Verify
After deploying, compare:
1. PI "All Time" Revenue vs Finances "All Time" Revenue — should match exactly
2. PI per-property revenue vs Finances actuals — should match
3. PI YoY expenses should look reasonable relative to Finances monthly costs
4. DSCR should only show when there's real debt service

### Remaining Items from Session Brief
- [ ] Charts readability improvements (could be done in follow-up polish pass)
- [ ] Per-property ramp curve pagination (>6 properties)
- [ ] Custom time period edge cases (need live testing)
