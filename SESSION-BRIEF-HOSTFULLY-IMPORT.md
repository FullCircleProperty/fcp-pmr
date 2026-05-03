# SESSION BRIEF — Hostfully Historical Data Import (v2.47.1+)

## Objective
Import 2+ years of Hostfully PMS reservation data into FCP-PMR to fill historical gaps in the YoY Performance section. Hostfully was FCP's PMS before Guesty — most 2024 and earlier data only exists there. Airbnb data partially overlaps (some migrated into Guesty), but Booking.com, Vrbo, and direct bookings from the Hostfully era are completely missing.

## Why It Matters
The YoY Performance section (added in v2.47.0) shows the portfolio growth story to banks/investors. Without historical data, 2024 shows only $22K revenue from 5 units — the real number is much higher. Accurate historical data transforms the pitch from "we just started" to "we have a proven 2-year track record."

## Architecture

### New Tables

```sql
-- Permanent storage for Hostfully data (never merged into guesty_reservations)
CREATE TABLE IF NOT EXISTS hostfully_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostfully_property_name TEXT,        -- original name from CSV
  property_id INTEGER,                 -- mapped PMR property ID
  guest_first TEXT,
  guest_last TEXT,
  guest_email TEXT,
  source TEXT,                         -- Airbnb, Booking, Vrbo, Hostfully (direct)
  airbnb_confirmation TEXT,            -- Airbnb Host Res # (dedup key for Airbnb)
  check_in TEXT,                       -- YYYY-MM-DD
  check_out TEXT,                      -- YYYY-MM-DD
  nights INTEGER,
  num_guests INTEGER,
  nightly_rate REAL,                   -- derived: rental_amount / nights
  cleaning_fee REAL,
  rental_amount REAL,                  -- accommodation/rental amount
  total_amount REAL,                   -- total charged to guest
  amount_paid REAL,
  host_payout REAL,                    -- total minus platform fees
  platform_fee REAL,                   -- Airbnb/Booking/Vrbo fee
  tax_amount REAL,
  security_deposit REAL,
  guest_tax_rate REAL,
  discount REAL,
  status TEXT DEFAULT 'pending',       -- pending|duplicate|matched|conflict|approved|rejected
  dedup_match_id TEXT,                 -- guesty reservation ID if duplicate found
  dedup_reason TEXT,                   -- why it was flagged (e.g., "airbnb_confirmation_match")
  import_batch TEXT,                   -- batch ID for tracking multiple imports
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(airbnb_confirmation, check_in, hostfully_property_name)
);

-- Property name mapping (persists across imports)
CREATE TABLE IF NOT EXISTS property_name_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_name TEXT NOT NULL,         -- Hostfully property name (or future PMS)
  external_source TEXT DEFAULT 'hostfully', -- which PMS this name came from
  property_id INTEGER NOT NULL,        -- mapped PMR property ID
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(external_name, external_source)
);
```

### Data Flow

```
CSV Upload → Parse → staged into hostfully_reservations (status='pending')
     ↓
Property Mapping UI → map Hostfully names → PMR property IDs
     ↓
Auto-Dedup Engine runs:
  - Airbnb: match on airbnb_confirmation → status='duplicate'
  - Booking/Vrbo: match on property_id + check_in + total (±$5) → status='duplicate'
  - No match: status='matched' (new data, ready for review)
  - Partial match (same prop+date, different amount): status='conflict'
     ↓
Review UI → user approves/rejects → status='approved' or 'rejected'
     ↓
Rebuild monthly_actuals → merges guesty_reservations + approved hostfully_reservations
```

### Monthly Actuals Rebuild
The `rebuildMonthlyActuals()` function (or a new unified version) must:
1. Query `guesty_reservations` for Guesty-sourced actuals (existing logic)
2. Query `hostfully_reservations WHERE status = 'approved'` for historical actuals
3. Merge by property_id + month, summing revenue/nights/etc.
4. Write to `monthly_actuals` with `ON CONFLICT DO UPDATE`

Key: the actuals rebuild must be idempotent — running it twice produces the same result.

## Hostfully CSV Column Mapping

| Hostfully Column | Maps To | Notes |
|---|---|---|
| Property Internal Name / Property Name | `hostfully_property_name` | Needs manual mapping to PMR property |
| Guest First / Guest Last / Guest Email | `guest_first`, `guest_last`, `guest_email` | |
| Source (Booking/Airbnb/Vrbo/Hostfully) | `source` | Platform identifier |
| Airbnb Host Res # | `airbnb_confirmation` | Primary dedup key for Airbnb reservations |
| Created or Check-In | `check_in` | Parse date format (M/D/YYYY → YYYY-MM-DD) |
| Check-Out | `check_out` | Parse date format |
| Extra Guest Tax Rate | `guest_tax_rate` | Stored as decimal (14.5% → 0.145) |
| Cleaning Fee | `cleaning_fee` | |
| Security Deposit | `security_deposit` | |
| Accommodation (Airbnb/Host/New/Vrbo columns) | `platform_fee` | Sum of platform-specific fee columns |
| Rental Amount | `rental_amount` | The accommodation charge |
| Total Amount | `total_amount` | Full guest charge |
| Amount Paid | `amount_paid` | What was actually collected |
| Balance Due | derived | `total_amount - amount_paid` |
| Discount | `discount` | |

### Date Parsing
Hostfully dates appear to be in `M/D/YYYY` format (e.g., `1/17/2025`, `3/2/2025`).
Must convert to `YYYY-MM-DD` for consistency with Guesty data.

### Property Name Patterns Observed
- `Apartment Private Ap.aa7c3b2b9-Rebecca` — unit name with guest suffix
- `Private Ap.aa7c3b2b9-Seth` — shortened variant
- `Beach Apt Beach Apt 750c50b1-Alexandre` — beach properties
- `Private Ap.9e6fde0-Erica` — different ID format

The property identifier appears to be the hex ID in the name (e.g., `aa7c3b2b9`, `750c50b1`, `9e6fde0`).
These could potentially be extracted and matched programmatically, but manual mapping is safer.

## Dedup Logic (Detailed)

### Airbnb Reservations
```
IF hostfully.airbnb_confirmation IS NOT NULL AND != ''
  THEN match against guesty_reservations.confirmation_code
  IF match found → status = 'duplicate', dedup_match_id = guesty.id
```

### Booking.com / Vrbo Reservations
```
IF hostfully.source IN ('Booking', 'Vrbo')
  THEN match against guesty_reservations WHERE:
    - property_id matches (via mapping)
    - check_in date matches (±1 day tolerance for timezone issues)
    - ABS(total_amount - guesty.total_paid) < $5 (fee rounding tolerance)
  IF match found → status = 'duplicate'
  IF partial match (date matches but amount differs by >$5) → status = 'conflict'
```

### Direct / Hostfully Bookings
```
IF hostfully.source = 'Hostfully'
  → These are direct bookings, unlikely to be in Guesty
  → status = 'matched' (auto-approve candidate)
  → Still check for same property + same dates just in case
```

## UI Components

### 1. Import Tab (under Settings or as sub-tab of a Data Management section)
- File upload zone (drag & drop CSV)
- Import progress bar
- Summary after import: "X rows parsed, Y properties found"

### 2. Property Mapping Panel
- Left column: unique Hostfully property names (with row count)
- Right column: dropdown of PMR properties
- "Auto-match" button attempts fuzzy matching on address
- "Save Mapping" persists to `property_name_mappings`
- Shows unmapped count prominently

### 3. Review Dashboard
- Summary cards: Total | Duplicates | New | Conflicts | Approved | Rejected
- Filterable table with status color coding
- Conflict rows expand to show side-by-side: Hostfully data vs Guesty match
- Bulk actions: "Approve All New", "Reject All Duplicates"
- Individual row approve/reject buttons
- "Commit" button → rebuilds monthly_actuals

### 4. Import History
- List of past imports with batch ID, date, row count, status breakdown
- "Re-run dedup" button (in case new Guesty data arrived since import)
- "Rollback" button → sets all rows in batch back to 'rejected', rebuilds actuals

## Hard Rules
- NEVER insert into `guesty_reservations` — that table is Guesty-sync only
- NEVER auto-approve without user review on first import
- All financial amounts stored as-is from CSV (no currency conversion)
- `monthly_actuals` rebuild must handle both sources idempotently
- Property mapping table is source-specific (`external_source = 'hostfully'`) for future PMS imports
- Hostfully data is always traceable — `monthly_actuals` should track data source

## Edge Cases to Handle
- Reservations spanning month boundaries (check_in in Jan, check_out in Feb) → split revenue proportionally by nights in each month, same as Guesty logic
- Cancelled reservations (amount_paid = $0 or very low) → flag but don't auto-reject (could be partial refund)
- Properties not yet in PMR → require mapping before dedup can run
- Duplicate CSV uploads → `UNIQUE(airbnb_confirmation, check_in, hostfully_property_name)` prevents double-insert
- Guest names containing commas in CSV → parser must handle quoted fields

## Implementation Order
1. Schema: `hostfully_reservations` + `property_name_mappings` tables in `ensureSchema()`
2. CSV parser endpoint: `POST /api/import/hostfully` — parse, validate, insert as pending
3. Property mapping endpoints: `GET/POST /api/import/property-mappings`
4. Dedup engine endpoint: `POST /api/import/run-dedup`
5. Review endpoints: `GET /api/import/staged?status=...`, `POST /api/import/approve`, `POST /api/import/reject`
6. Commit endpoint: `POST /api/import/commit` → rebuild monthly_actuals
7. Frontend: new Import tab or section in Settings (file upload → mapping → review → commit flow)

## What NOT To Do
- Don't try to match Hostfully property IDs to Guesty listing IDs — the platforms use different ID systems
- Don't import guest phone numbers or sensitive PII beyond name/email
- Don't auto-commit — always require explicit user approval
- Don't rebuild monthly_actuals on every individual row approval — only on final commit
- Don't assume CSV column order is fixed — match on header names
