# FCP-PMR v2.15.0 Session Summary

## Changes from v2.14.2

### Feature 1: Auto-Crawl Watchlist Markets (Market Intelligence Data Population)

**Problem:** Market Intelligence cards showed dashes because `master_listings` had no crawled STR data. The `buildMarketProfile()` function aggregated from an empty table.

**Solution:** New `crawlMarketListings(city, state, env)` function that runs automatically during the daily 6am cron, BEFORE `buildMarketProfile()` is called.

**How it works:**
1. Daily cron at `0 6 * * *` first calls `autoPopulateWatchlist()` to ensure all property cities are in the watchlist
2. For each due market (up to 10 per run), it now calls `crawlMarketListings()` FIRST
3. `crawlMarketListings()` uses SearchAPI to fetch:
   - **Airbnb listings** via the `airbnb` engine (structured data with pricing, beds, ratings)
   - **VRBO listings** via Google search engine (extracts links, attempts price/bedroom extraction from snippets)
4. All results are upserted into `master_listings` via the existing `upsertMasterListing()` function
5. After crawling, `buildMarketProfile()` now has real data to aggregate into `market_profiles`
6. Watchlist stats (listing_count, avg_price, new_listings_30d) are updated after each crawl
7. A `crawl_jobs` record is created for each auto-crawl for audit trail

**Key rules enforced:**
- RentCast is NEVER called in crawlMarketListings — it is strictly LTR-only
- All city queries use LOWER() for case-insensitive matching
- SearchAPI calls are tracked via `trackApiCall()` with distinct labels (`cron_airbnb`, `cron_vrbo`)
- Crawl is limited to 10 markets per cron run to stay within API rate limits

**Files modified:**
- `src/worker.js` — Added `crawlMarketListings()` function (~120 lines), wired into cron loop

### Feature 2: Owner Statement PDF Export

**Problem:** No way to generate downloadable monthly PDF statements for property owners from the Management view.

**Solution:** Client-side PDF generation using jsPDF + jspdf-autotable, triggered from the existing Management view.

**What the PDF includes:**
- Professional header with "OWNER STATEMENT" title, company name, period dates
- Owner name and property count
- Financial summary box: Gross Revenue, Expenses, Net Profit, Management Fee, Owner Payout
- Property detail table with per-property breakdown (fee %, basis, gross, expenses, net, fee, payout)
- Monthly breakdown tables per property (revenue, nights, occupancy, ADR, expenses, fee, owner payout)
- Fee calculation notes explaining each property's fee basis (gross vs net_profit)
- Footer with page numbers and generation timestamp

**UI additions:**
- "📄 Export PDF Statement" button on each owner statement card
- "📄 Export All PDFs" button at the section header to batch-generate for all owners
- PDFs respect the active period filter (YTD, This Month, Last Month, etc.)

**Files modified:**
- `build.js` — Added jsPDF and jspdf-autotable CDN scripts
- `frontend/parts/js/10-finances.js` — Added `exportOwnerStatementPDF()` (~290 lines) and `exportAllOwnerStatements()` functions, plus UI buttons

### Version Bump
- `package.json` — 2.14.2 → 2.15.0

### Technical Notes
- PDF generation is entirely client-side (no server endpoint needed) since all financial data is already loaded in the Management view
- The crawl function gracefully handles SearchAPI failures — errors are caught per-platform so Airbnb failure doesn't prevent VRBO crawl
- VRBO data via Google search is less structured than Airbnb — bedroom counts and prices are extracted from snippets when available
- Existing manual "Crawl" button on watchlist markets still works via the original `/api/intel/crawl` endpoint
