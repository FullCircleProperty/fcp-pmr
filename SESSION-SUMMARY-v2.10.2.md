# FCP-PMR v2.10.2 Session Summary

## Version: 2.10.2
## Date: 2026-03-07
## Base: v2.10.1 tarball

---

## Changes Applied in This Session

### 1. Deterministic Confirmation Codes (pet fee fix)
- **File:** `src/worker.js` ~line 7022
- Replaced `Date.now() + Math.random()` fallback with deterministic hash from `guest_name + check_in + listing_name`
- Prevents duplicate GEN- codes on re-import, which was causing pet fee data to fragment

### 2. Refund Tracking (Priority 1) ✅
**New columns on `guesty_reservations`:**
- `total_refunded` — total amount refunded to guest
- `cancellation_fee` — fee retained from cancellation
- `canceled_accommodation` — canceled accommodation fare
- `canceled_cleaning` — canceled cleaning fare  
- `canceled_payout` — canceled host payout

**CSV mapping added for:**
- TOTAL REFUNDED → `total_refunded`
- CANCELLATION FEE → `cancellation_fee`
- CANCELED ACCOMMODATION FARE → `canceled_accommodation`
- CANCELED CLEANING FARE → `canceled_cleaning`
- CANCELED TOTAL PAYOUT → `canceled_payout`

**Refund data surfaces in:**
- Guesty stats endpoint (`/api/guesty/stats`) → `refund_summary` object
- Guesty tab UI — refund count, total refunded, cancel fees retained, lost payout
- Monthly actuals (`monthly_actuals` table) — `total_refunded`, `cancellation_fees` columns
- Finance tab money flow — refund and cancellation fee lines before total deposited
- Canceled reservations with refund data are aggregated into monthly_actuals by check-in month

### 3. Eliminate guest_stays Materialized View (Priority 2) ✅
**Architecture change:** All intelligence queries now read `guesty_reservations` directly with JOINs. No more stale materialized view.

**What changed:**
- Intelligence rebuild now stamps `guest_id` on `guesty_reservations` rows instead of creating `guest_stays` records
- `DELETE FROM guest_stays` replaced with `UPDATE guesty_reservations SET guest_id = NULL`
- All `getGuestIntelligence()` queries rewritten: `guest_stays` → `guesty_reservations` with status filter
- All `getGuestIntelForPrompt()` queries rewritten similarly
- Dashboard upcoming check-ins/check-outs now query `guesty_reservations` directly
- Calendar booking overlay query rewritten
- Debug/diagnostic queries updated
- Property deletion cascade changed from `DELETE guest_stays` to `UPDATE guesty_reservations SET property_id = NULL`
- New index: `idx_gr_guest_id` on `guesty_reservations(guest_id)`

**Column mapping (old → new):**
- `guest_stays.nights` → `guesty_reservations.nights_count`
- `guest_stays.guests` → `guesty_reservations.guest_count`
- `guest_stays.revenue` → `guesty_reservations.accommodation_fare`
- `guest_stays.payout` → `guesty_reservations.host_payout`
- `guest_stays.platform` → `guesty_reservations.source_file`

**Status filter applied to all live queries:**
```sql
LOWER(COALESCE(status,'')) NOT IN ('canceled','cancelled','declined','expired','denied','no_show','inquiry','awaiting_payment','pending','quote')
```

**Note:** The `guest_stays` table schema + migration still exists in ensureSchema() for backward compatibility — it just won't be populated anymore. Safe to drop manually later.

### 4. Amenities UI (Priority 3)
**Status:** Already complete from prior sessions. Full implementation exists:
- Category-grouped chip selector with search, bulk select, per-category toggle
- Impact score display per amenity
- Auto-detect from platform listings (scrapes listing URLs)
- Google search fallback for research properties
- Save/load per property via `/api/properties/:id/amenities`
- 9 categories: outdoor, kitchen, entertainment, comfort, safety, workspace, location, parking, unique
- Proper CSS in `styles.css` (`.chip`, `.chip.selected`, `.chip-container`)

---

## Files Modified
- `src/worker.js` — schema migrations, CSV import, intelligence queries, finance actuals, dashboard
- `frontend/parts/js/10-finances.js` — refund display in money flow
- `frontend/parts/js/13-guesty.js` — refund summary stats display
- `package.json` — version bump to 2.10.2

## Architecture Notes
- **RentCast** — strictly for LTR data. Never call for STR comps.
- **Intelligence is now live** — no rebuild needed to see current data (though rebuild still needed to create/update guest profiles)
- **Refund data flows:** CSV → guesty_reservations → monthly_actuals → finance tab
