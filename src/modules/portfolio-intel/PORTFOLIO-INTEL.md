# Portfolio Intelligence Module

**Version:** 2.0.0 (refactored — no data duplication)
**Integrated with:** FCP-PMR v2.38.0+
**Portable:** calculations.js is zero-dependency; backend requires the data interface described below

## Architecture — No Data Duplication

The module reads directly from FCP-PMR's operational tables. No sync step, no stale data.

**Module-owned tables** (config + snapshots only):
- `portfolio_property_config` — per-property presentation settings (status, financing visibility, ramp-up config)
- `portfolio_profiles` — saved presentation profiles (bank, investor, internal)
- `portfolio_snapshots` — point-in-time portfolio valuations for tracking growth

**Reads from** (owned by FCP-PMR):
- `properties` — property details, financials, purchase_date
- `monthly_actuals` — actual revenue, occupancy, ADR by month

## Portability

To deploy elsewhere, the target app needs:
1. **`calculations.js`** — copy directly, zero dependencies
2. **A data source** with: properties (purchase_price, mortgage, expenses, value) and monthly revenue actuals
3. **An AI provider** — swap `callAIWithFallback` for your own

The portability boundary is the **data interface**, not table duplication.

## Presentation Profiles

- **Full Internal** — everything visible
- **Bank / Lender** — hides private loans, methodology, scenario tab
- **Investor Pitch** — anonymizes properties (A, B, C), hides financing details

## Financial Metrics

NOI, Cap Rate, DSCR, Cash-on-Cash, LTV, Expense Ratio, Debt Yield, Revenue/Unit, NOI/Unit, Loan Capacity (DSCR + LTV based)
