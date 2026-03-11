# FCP-PMR Session Summary — v2.10.2 → v2.14.2
**Date:** 2026-03-07
**Platform:** Cloudflare Workers + D1 (SQLite)
**Live at:** pmr.fullcircle-property.com

## Versions Delivered

### v2.10.2–v2.10.7 (carried from prior session)
- Deterministic confirmation codes (pet fee fix)
- Refund tracking (5 CSV columns → monthly_actuals → finance display)
- guest_stays elimination (all queries read guesty_reservations directly)
- Properties query optimization (17 subqueries → 7 LEFT JOINs)
- Property card redesign (3-zone layout)
- Intelligence rebuild prompt
- Managed properties finance module

### v2.10.8 — Fee Basis Toggle
- Per-property `fee_basis` field: `gross` (% of revenue) or `net_profit` (% of revenue minus expenses)
- Toggle button in managed property form with live split preview
- Backend, frontend, AI prompts all respect per-property setting

### v2.10.9 — Finance Fixes
- **0 Bookings bug**: `num_reservations` missing from finance actuals SELECT
- **Money flow math**: restructured to show proper equation that adds up
- **Dead code removed**: `runPropertyPriceAnalysis` (103 lines)
- **All 5 AI prompt builders** now handle managed properties

### v2.11.0 — HOA / Restrictions / AI Notes
- `rental_restrictions`, `hoa_name`, `ai_notes` columns on properties
- New form section with textareas
- Feeds into ALL AI analysis prompts as hard constraints
- Shows in property finance overview with icons

### v2.11.1 — Guesty Linking Fix
- Multi-path matching (listing_name, guesty_listing_id, listing_address, platform_listing_name, fuzzy address)
- Auto-triggers processGuestyData + rebuildIntelligence after linking
- Toast shows linked reservation count

### v2.11.2 — Managed Finance Period Filters
- Managed section uses same period filters as main actuals (YTD/This Month/etc)
- Own period buttons, own date range display

### v2.11.3 — Property Form Section Styling
- `.prop-section` CSS panels with colored left borders + icon headers
- 10 sections styled: Ownership, Listing, Purchase, Rental, Managed, Expenses, Services, HOA/Restrictions, Capital, Photos

### v2.11.4 — Period Filter Sync
- `data-period` attributes replace text matching
- Managed section period buttons sync with main finance buttons

### v2.11.5 — Management Top-Level View
- New "🤝 Management" tab in main navigation (auto-hidden when no managed properties)
- Completely separated from Finance tab — own state, own period filters
- Contains: period buttons, summary cards, owner statement cards, property detail table, monthly breakdowns
- Finance tab is now purely portfolio — zero managed references

### v2.12.0–v2.12.2 — Demand Segment Tracking
- `demand_segment` column on guesty_reservations
- Classification engine (10 segments): vacation_str, weekend_getaway, short_vacation, extended_vacation, corporate, travel_nurse, insurance, relocation, midterm_family, long_term
- Classifies by: text patterns in notes/guest_name, stay length, guest count, channel, lead time, seasonality
- Runs automatically during intelligence rebuild (guests section)
- **Guest Intelligence UI**: DEMAND SEGMENTS section with colored cards per segment
- **Calendar**: segment badges on booked days
- **AI context**: per-property segment breakdown feeds into every analysis
- **Dashboard**: expanded action items (4 → 9) including segment insights, stale analysis, low occupancy, PriceLabs sync alerts

### v2.13.0–v2.13.5 — Market Intelligence (3 Tiers)
**Tier 1 — Per-Market Profiles:**
- `market_profiles` table with 25+ columns
- `buildMarketProfile()` aggregation engine reads from master_listings, market_snapshots, market_seasonality, pricelabs_listings, monthly_actuals
- Market grid landing page with cards per market
- Click card → profile page: overview KPIs, your performance vs market, STR landscape (property type/bedroom/price band distributions), seasonality chart, your properties table

**Tier 2 — Market Comparison:**
- "Compare Markets" button → sortable table of all markets side by side
- Color-coded: green when above market, red when below

**Tier 3 — AI Enrichment:**
- "🤖 AI Analysis" button per profile
- Sends all Tier 1 data to AI via `callAIWithFallback`
- Returns: demand_drivers, regulatory_notes, investment_thesis, competitive_position, recommendations, risk_factors
- Cached in market_profiles, shows enrichment date

### v2.14.0 — Auto-Populate & Cron Wiring
- **localStorage eliminated** for market cities — now backed by watchlist DB
- Cities auto-populate from property cities on Market tab load
- Adding/removing cities uses watchlist API
- **Property create → auto-adds city to watchlist**
- **Cron auto-crawl wired**: daily 6am checks `next_crawl` on watchlist, runs `buildMarketProfile` for due markets, sets next_crawl by frequency

### v2.14.1 — Data Accuracy Fixes
1. **Revenue dedup**: moved `revenue +=` inside `bookedDays` guard (prevents double-count on overlapping bookings)
2. **Status filter alignment**: replaced all `status IN ('confirmed','closed')` with exclusion list matching intelligence queries
3. **Partial month occupancy**: current month uses elapsed days instead of full month (prevents deflated %)

### v2.14.2 — Case Sensitivity Fix
- 26 queries updated: all `WHERE city = ?` → `WHERE LOWER(city) = LOWER(?)`
- Covers: market_seasonality, market_snapshots, market_insights, dynamic query builders, similar properties
- Zero case-sensitive city queries remain in codebase

## Current Codebase Stats
- Worker: 10,712 lines
- Frontend: 14,249 lines (16 JS files)
- HTML: 1,542 lines | CSS: 439 lines
- Routes: 159 | Tables: 35 | Indexes: 17
- Total: ~26,940 lines

## Auto-Rebuild Chain
| Trigger | What runs |
|---------|-----------|
| CSV import | processGuestyData + rebuildIntelligence (guests+segments) |
| Guesty API sync | same |
| Listing link | same |
| Daily cron 6am | full: actuals + guests + segments + market + channels + market profiles |
| Weekly cron Mon 7am | Guesty listing sync + PriceLabs listing refresh |
| Property create | auto-adds city to watchlist |
| Market tab load | auto-populates watchlist from properties |

## Key Architecture Rules
- **RentCast**: strictly LTR data only — never called for STR comps
- **Managed properties**: completely excluded from portfolio totals, dashboard KPIs, finance calcs
- **guest_stays table**: schema kept, never populated — safe to drop
- **Fee basis**: per-property (`gross` or `net_profit`), not global
- **Status filter**: consistent exclusion list across ALL queries
- **City matching**: always LOWER(city) + LOWER(state), never case-sensitive

## Pipeline for Next Session
1. **Populate market data for empty cities** — wire SearchAPI auto-crawl into daily cron so master_listings gets STR data for all watchlist cities
2. **Owner statement PDF export** — downloadable monthly PDFs from Management view
3. **Guest origins enrichment** — Guesty API guest profile pull for hometown/country
4. **PMS integrations** — Hostaway, OwnerRez (table schema already universal)

## Files Modified This Session
- `src/worker.js` — schema, routes, processGuestyData, intelligence, market profiles, dashboard, AI prompts, cron
- `frontend/parts/js/00-dashboard.js` — no changes (dashboard renders from backend data)
- `frontend/parts/js/01-globals.js` — switchView handlers for management + market profiles
- `frontend/parts/js/02-properties.js` — fee basis, restrictions, section styling, property card, management tab visibility
- `frontend/parts/js/07-market.js` — market intelligence grid/profile/comparison, localStorage→DB migration
- `frontend/parts/js/09-intel.js` — calendar segment badges, block display cleanup
- `frontend/parts/js/10-finances.js` — management view separation, period filters, money flow fix
- `frontend/parts/js/13-guesty.js` — linking feedback with reservation count
- `frontend/parts/js/15-intelligence.js` — demand segment display
- `frontend/parts/app-html.html` — management view, market intelligence containers, property form sections
- `frontend/parts/styles.css` — prop-section panel classes
- `package.json` — version bumps
