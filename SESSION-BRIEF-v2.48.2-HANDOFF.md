# SESSION BRIEF — v2.48.2 Handoff (April 6, 2026)

## Start Here
Upload this brief + the v2.48.2 tarball. Read this file first, then extract and work from the codebase.

## What Was Built This Session

### 1. Hostfully Historical Import Pipeline (v2.48.0)
Complete 4-step wizard for importing pre-Guesty reservation data:

**Upload → Map → Review/Approve → Commit**

- **Backend:** 11 new API endpoints under `/api/import/*`, 3 new tables (`hostfully_reservations`, `property_name_mappings`, `monthly_actuals.data_source` column)
- **Frontend:** New "Import" tab (`19-import.js`, ~600 lines), drag-drop CSV upload, property mapping UI, filterable review table with bulk approve/reject, commit with actuals rebuild
- **Architecture:** Hostfully data lives permanently in its own table, never touches `guesty_reservations`. Commit runs `processGuestyData()` first (clean Guesty rebuild), then layers approved Hostfully data additively via `ON CONFLICT DO UPDATE`. Fully idempotent.
- **Dedup engine:** Airbnb confirmation code match → universal date+amount fallback (±$5 = duplicate, ±$50 = conflict) → direct booking date overlap check
- **Full details:** See `SESSION-BRIEF-HOSTFULLY-IMPORT-DONE.md`

### 2. Import Bug Fixes (v2.48.0 → v2.48.2)
Seven bugs found and fixed during self-review + live testing:

| # | Bug | Fix |
|---|-----|-----|
| 1 | SQL injection in `runHostfullyDedup` — `batch_id` string-interpolated | Use `.bind()` |
| 2 | UNIQUE constraint let non-Airbnb rows duplicate on CSV re-upload (NULL uniqueness) | Changed to `UNIQUE(check_in, check_out, hostfully_property_name, rental_amount)` |
| 3 | D1 `.bind()` chaining in `getHostfullyStaged` — sequential binds replace each other | Use `.bind(...binds)` spread |
| 4 | Review card filter values mismatched status names ("Duplicates" vs "duplicate") | Explicit label→status mapping |
| 5 | No night-level dedup in commit — overlapping Hostfully reservations double-counted | Added `bookedDays` tracker |
| 6 | Missing SVG icons (`upload`, `checkCircle`, `checkSquare`) | Added Lucide paths to `_ICON_PATHS` |
| 7 | **Airbnb dedup miss** — date+amount matching was gated to Booking/Vrbo only | Made universal fallback for ALL sources |

### 3. Portfolio Intel Expense Fixes (v2.48.1)
YoY Performance showed contradictory expenses (going up and down). Three root causes in `getPortfolioAnalytics()`:

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| 1 | Child units got $0 building expenses | Multi-family units appeared cost-free | Load parent building, split insurance/taxes/HOA/mortgage by child count |
| 2 | Expenses tied to data-months, not calendar months | 2024 with 3 months of data showed 1/4 real expenses | Use calendar months (12 for past years, elapsed for current) |
| 3 | Child units missing `purchase_date` | Wrong start-of-operations timing | Fall through to parent building's `purchase_date` |

Same fixes applied to ramp curves `monthlyCost` calculation.

**Full details:** See `SESSION-BRIEF-PI-EXPENSE-FIX.md`

---

## Current State After Deploy

### What the user is testing right now:
- Hostfully CSV import with real data — first upload completed, mappings saved, dedup ran
- Some Airbnb reservations incorrectly showed as "New" (bug #7 fixed in v2.48.2)
- After deploying v2.48.2: user needs to **re-run dedup** from the Import tab to re-classify those Airbnb rows
- PI YoY expenses should now be monotonically increasing — user needs to verify

### Known issues to watch for:
1. **Dedup tolerance:** $50 conflict threshold may be too tight or too loose for some reservations where Hostfully and Guesty report different fee breakdowns. Watch for legitimate reservations showing as "conflict" or genuine duplicates slipping through as "new."
2. **Unmapped properties blocking dedup:** Dedup skips rows where `property_id IS NULL`. If user uploads CSV before mapping all properties, those rows stay `pending` forever. The UI warns about this but doesn't block dedup.
3. **Large CSV handling:** Entire CSV sent as JSON body. Fine for hundreds of rows, might hit Workers memory limits for 5K+ rows. Not an issue with current dataset.

---

## Pipeline: What To Build Next

From memory + session context, in priority order:

1. **Hostfully import polish** — any issues found during live testing
2. **Property Research tab** — per-property timeline, comps, trend, market context card with link to full market profile
3. **Market Demographics section** on market profiles
4. **Guest origins** via Guesty API
5. **Bulk "Run All" pricing analysis**
6. **Property ADR/occupancy vs. market badges**
7. **Market alert thresholds**
8. **SVG icon consistency audit**
9. **PMS integrations expansion**
10. **Owner statement PDF export** (jsPDF, partially built)
11. **Headless browser service** for VRBO/Booking.com guest-facing prices

---

## Key Architecture Reminders

- **Single source of truth:** `getFinancesSummary()` for costs, `processGuestyData()` for actuals. Don't re-derive.
- **Child units inherit from buildings:** Insurance, taxes, HOA, mortgage live on parent building → split by child count. `pushBuildingToUnits()` only pushes address/city/state, NOT financials.
- **Hostfully data is separate:** Never insert into `guesty_reservations`. The `hostfully_reservations` table is permanent. Commit layers data additively into `monthly_actuals`.
- **Status filtering:** `EXCLUDED_STATUSES` / `LIVE_STATUS_SQL` everywhere. `LOWER(COALESCE(status,''))` pattern.
- **Version bump:** Every build, no exceptions.
- **Quality gates:** `validate.js` (26 checks) + `audit.js` (14 checks) + `node --check` — all must pass.

## Files In This Tarball
```
src/worker.js          — monolith backend (~17,500 lines)
frontend/parts/js/     — 20 frontend modules (00-dashboard through 19-import)
frontend/parts/app-html.html — main HTML template
dist/worker.js         — built worker
package.json           — v2.48.2
build.js, validate.js, audit.js, deploy.sh
DEPLOYMENTS.md, README.md
SESSION-BRIEF-*.md     — 6 session briefs
```
