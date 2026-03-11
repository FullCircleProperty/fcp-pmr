# FCP-PMR v2.25.4 Code Audit Report
**Date:** 2026-03-10  
**Scope:** ~31,000 lines across worker.js (12,232), 16 frontend JS modules (14,232), HTML (1,656), CSS (497)

---

## CRITICAL — Fix Now

### 1. SQL Injection in PriceLabs Bulk Customizations
**File:** `src/worker.js` lines 5767, 5799  
**Issue:** `group_name` is interpolated into SQL with only basic quote-escaping (`replace(/'/g, "''")`). While this prevents simple injection, it's not parameterized. D1/SQLite parameterized queries should be used instead.  
**Risk:** Low (user must be authenticated), but violates secure coding principles.  
**Fix:** Rewrite to use `.bind()` parameters instead of string interpolation.

### 2. Property Delete Missing Cascade Tables
**File:** `src/worker.js` lines 1668-1693  
**Issue:** 3 tables with `property_id` are not cleaned up on property delete:
- `guest_stays` — orphaned guest stay records
- `price_history` — orphaned price history entries
- `property_algo_overrides` — orphaned algo overrides

**Fix:** Add these to the batch delete in `deleteProperty()`:
```js
env.DB.prepare(`DELETE FROM guest_stays WHERE property_id = ?`).bind(pid),
env.DB.prepare(`DELETE FROM price_history WHERE property_id = ?`).bind(pid),
env.DB.prepare(`DELETE FROM property_algo_overrides WHERE property_id = ?`).bind(pid),
```

### 3. Missing Database Indexes for Hot Queries
**Issue:** 135 queries reference `property_id + month` or `LOWER(city) + LOWER(state)` combinations, but only `master_listings` and `guesty_reservations` have indexes. Missing indexes:
- `monthly_actuals(property_id, month)` — queried on every property view, finance summary, dashboard
- `analysis_reports(property_id, report_type)` — queried on every pricing tab load
- `market_watchlist(city, state)` — queried in every cron run
- `pricelabs_rates(pl_listing_id, rate_date)` — composite for calendar queries

**Impact:** As data grows, these queries will slow down significantly. D1 has limited query budget per request.

---

## HIGH — Fix Soon

### 4. 206 Empty Catch Blocks in Worker.js
**Issue:** `catch {}` silently swallows errors throughout the backend. While acceptable for optional enrichment data, several are on critical paths:
- Monthly actuals rebuild (data correctness)
- Reservation linking (Guesty sync)
- Market profile building (display data)

**Recommendation:** Add `catch(e) { console.error('[context]', e.message); }` to at least the data-critical paths. Leave cosmetic ones as `catch {}`.

### 5. Double-Click Protection Gaps
**Issue:** 15 buttons have `btn.disabled = true` protection, but 34 action buttons exist in the HTML. Missing protection on:
- "Crawl" buttons (market profile, monitoring page)
- "Save PriceLabs Config" and "Apply to Other Properties"
- "Export PDF Statement" (could generate duplicate PDFs)
- "Run AI Deep Analysis" on market profiles

**Fix:** Add `btn.disabled = true` at start and re-enable in `.then()/.catch()` for all async action buttons.

### 6. Frontend Promises Without Catch
**Issue:** 11 `.then()` chains in the frontend lack `.catch()` handlers. If the API returns an error, these fail silently with no user feedback. Notable:
- `loadPlActionItems` — fails silently if reports endpoint errors
- `api('/api/algo-templates')` in property load — algo template dropdown breaks silently
- `applyPlCustomizationsToAll` callback chain

**Fix:** Add `.catch(function(err) { console.error(err); })` minimum, or `toast(err.message, 'error')` for user-facing operations.

---

## MEDIUM — Address in Next Session

### 7. No Rate Limiting on AI Endpoints
**Issue:** Revenue Optimization, PL Strategy, Listing Health, and Acquisition Analysis all call external AI APIs (Anthropic/OpenAI). There's no per-user rate limit — a user could trigger dozens of concurrent AI calls and burn through the API budget.
**Recommendation:** Add a simple in-flight check: if an AI analysis is already running for this property, reject with "Analysis in progress."

### 8. Managed Property Fee Calculation Uses `total_revenue` Not `host_payout`
**File:** `frontend/parts/js/10-finances.js` line 1070  
**Issue:** The management fee is calculated on `total_revenue` (gross booking amount including the platform commission Airbnb takes). The owner might expect it based on `host_payout` (what actually hits the bank). This could cause disputes.
**Recommendation:** Add a `fee_revenue_basis` option: "gross booking" vs "actual payout." Default to current behavior but surface the option.

### 9. Full Calendar Generation Performance
**File:** `src/worker.js` line 6710 (getManagedPropertiesSummary)  
**Issue:** The full calendar month generation loops through every month since the first booking, creating objects in memory. For a property with 3 years of data, that's 36+ month objects with running balance calculations. For 10 managed properties, that's 360 objects per API call.
**Current impact:** Negligible for current data size. Future risk if managing 50+ properties.

### 10. PriceLabs Customizations Not Validated
**Issue:** The `pl_customizations_json` field accepts any JSON blob. No schema validation means:
- Typos in field names won't be caught
- Very large JSON blobs could be stored (no size limit)
- Frontend could store unexpected field names that the AI prompt builder doesn't read

**Recommendation:** Validate against a known field list before saving. Cap at 5KB.

---

## LOW — Maintenance / Code Quality

### 11. Hardcoded Limits on Queries
38 queries use hardcoded `LIMIT` values (5, 10, 20, 50, 100). Most are fine, but some affect data completeness:
- Reservation detail for owner statements: `LIMIT 100` — an active property with 200+ annual reservations will miss data
- Crawl jobs: `LIMIT 50` — history truncation
- Dashboard action items: `LIMIT 20` — properties beyond 20 aren't flagged

### 12. Seasonality Multiplier Edge Cases
**File:** `src/worker.js` (seasonality calculation)  
**Issue:** Seasonality multipliers can exceed 2.0x for extreme markets. The frontend displays percentages like "+122% vs avg" which is correct, but the backend comment says "1.0x = average" without clarifying that >2.0x is valid. No capping logic — a market with one massive month could show +500%.

### 13. Version String Not Embedded in Responses
The `package.json` version (2.25.4) is only used in the build script banner. The API doesn't return the version in response headers or a version endpoint, making it hard to verify which version is deployed.

### 14. CSS Variables Without Fallbacks
`styles.css` defines `--purple` and `--purple-dim` but some inline styles in HTML reference `var(--purple)` without fallback values. If the CSS fails to load, these elements would be invisible.

---

## POSITIVE FINDINGS — Things Working Well

- **LOWER() consistency:** All city/state queries use `LOWER()` ✓
- **LIVE_STATUS_SQL on financial queries:** Properly excludes canceled/inquiry statuses ✓
- **Building exclusion pattern:** `NOT IN (SELECT DISTINCT parent_id...)` consistently applied ✓
- **Managed property exclusion:** `(is_managed = 0 OR is_managed IS NULL)` on portfolio queries ✓
- **RentCast strictly LTR-only:** Enforced with explicit comment ✓
- **monthly_actuals ON CONFLICT:** Proper upsert prevents double-counting ✓
- **Cash-basis accounting:** Payout attributed to check-in month correctly ✓
- **XSS protection:** `esc()` function used consistently on user-facing data ✓
- **guestyApiFetchExt removed:** Clean consolidation, no stale references ✓
- **Delete cascade covers 13/16 tables:** Most critical data properly cleaned ✓
- **AI outputs never write to source tables:** Clean separation maintained ✓

---

## RECOMMENDED PRIORITY ORDER

1. **Add missing indexes** (biggest performance impact, 5 minutes)
2. **Fix delete cascade** (data integrity, 2 minutes)
3. **Fix SQL injection in bulk customizations** (security, 5 minutes)
4. **Add catch handlers to frontend promises** (user experience, 10 minutes)
5. **Add double-click protection** (UX, 15 minutes)
6. **Add console.error to critical catch blocks** (debugging, 20 minutes)
