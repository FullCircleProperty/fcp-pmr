# SESSION BRIEF — Private/Family Loans Tab

## Upload this file with the tarball at the start of next session.
**Tarball:** fcp-pmr-v2.42.2.tar.gz
**Action:** Extract, validate (26/26), audit (14/14), then implement below.

---

## Context

FCP is a property management company managing 12 properties across CT and FL, owned by different LLCs. Properties are a mix of rental arbitrage (8 units rented from landlords, sublet on STR/MTR) and owned (4 units, some owner-financed). The platform (FCP-PMR) is at v2.42.2.

This session we rebuilt Portfolio Intel as a business-focused bank pitch dashboard:
- Business P&L framing (Revenue → Cost of Revenue → Gross Profit → OpEx → Net Income)
- Owned vs rental split with proper DSCR calculations
- Growth trajectory with stabilized projections
- Loan readiness section with established DSCR
- Loan & funding guide with 4 loan types + application checklist
- PI now consumes Finances data via `getFinancesSummary()` — single source of truth

## What To Build: Private/Family Loans Tab

### Purpose
Track loans from private individuals, family members, or non-institutional lenders. These are common in RE investing — seller financing, family loans for down payments, private money for renovations. Currently the platform tracks bank mortgages per property but has no way to track:
- Loans not tied to a specific property (business operating capital)
- Multiple loans from the same private lender
- Custom repayment terms (interest-only, balloon, deferred, etc.)
- Payment history / amortization tracking
- Lender relationship management

### Database Schema Needed

```sql
CREATE TABLE IF NOT EXISTS private_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lender_name TEXT NOT NULL,
  lender_type TEXT DEFAULT 'private',  -- 'family', 'private', 'seller', 'partner'
  loan_amount REAL NOT NULL,
  current_balance REAL,
  interest_rate REAL DEFAULT 0,
  term_months INTEGER,
  start_date TEXT,
  maturity_date TEXT,
  monthly_payment REAL DEFAULT 0,
  payment_type TEXT DEFAULT 'fixed',  -- 'fixed', 'interest_only', 'balloon', 'deferred', 'custom'
  balloon_amount REAL,
  balloon_date TEXT,
  property_id INTEGER,  -- NULL if business-level loan, property_id if tied to specific property
  purpose TEXT,  -- 'down_payment', 'renovation', 'operating_capital', 'property_acquisition', 'other'
  notes TEXT,
  status TEXT DEFAULT 'active',  -- 'active', 'paid_off', 'defaulted', 'restructured'
  collateral TEXT,  -- what secures it (property address, personal guarantee, etc.)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS private_loan_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL,
  principal_portion REAL,
  interest_portion REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (loan_id) REFERENCES private_loans(id)
);
```

### API Endpoints Needed
```
GET    /api/private-loans              — List all loans with summary stats
GET    /api/private-loans/:id          — Single loan detail with payment history
POST   /api/private-loans              — Create new loan
PUT    /api/private-loans/:id          — Update loan
DELETE /api/private-loans/:id          — Delete loan (cascade payments)
POST   /api/private-loans/:id/payments — Record a payment
DELETE /api/private-loans/:id/payments/:pid — Delete a payment
GET    /api/private-loans/summary      — Portfolio-wide private debt summary
```

### Frontend: New Tab or Sub-Tab
Options:
1. New top-level tab "Private Loans" — probably too prominent
2. Sub-tab under Finances — makes more sense, alongside the existing finance data
3. Section within Portfolio Intel — ties into the loan readiness narrative

**Recommendation:** Sub-tab under Finances. The Finances tab already has property-level costs. Private loans are a finance concern. Add a toggle/sub-nav: "Properties | Private Loans"

### UI Components Needed
1. **Loan List** — Table showing all private loans with: lender, amount, balance, rate, monthly payment, status, property (if linked), maturity date
2. **Add/Edit Loan Modal** — Form with all fields from schema
3. **Loan Detail View** — Shows loan terms + payment history + amortization schedule + remaining balance chart
4. **Record Payment** — Quick form: date, amount, auto-split principal/interest based on terms
5. **Summary Cards** — Total private debt, monthly obligations, weighted avg rate, upcoming maturities

### Integration Points
- **Portfolio Intel**: Private loan balances should appear in Balance Sheet section (Total Liabilities)
- **Portfolio Intel**: Private loan payments should factor into DSCR if they're debt service
- **Finances**: Monthly private loan payments should appear as expenses
- **Property Detail**: If a loan is linked to a property, show it on that property's detail page
- **Loan Guide**: Cross-reference — "You have $X in private loans that could be refinanced into conventional at lower rates"

### Key Rules
- Private loans with `property_id` are property-level debt — include in that property's expense calculation
- Private loans without `property_id` are business-level debt — include in portfolio DSCR
- The `show_private_loans` profile setting already exists in PI — respect it for presentation views
- Payment recording should auto-calculate principal/interest split based on loan terms (simple interest)
- Maturity date warnings: highlight loans maturing within 6 months

### Files To Modify
- `src/worker.js` — Schema migration, API endpoints, DSCR integration
- `frontend/parts/js/10-finances.js` — Add private loans sub-tab
- `frontend/parts/app-html.html` — Add private loans HTML structure
- `frontend/parts/js/17-portfolio-intel.js` — Integrate private debt into Balance Sheet & DSCR
- `package.json` — Version bump

### Session Workflow
1. Extract tarball, validate 26/26, audit 14/14
2. Add schema migration to `ensureSchema()`
3. Build API endpoints (CRUD + payments + summary)
4. Build frontend (Finances sub-tab with list, modal, detail, payments)
5. Integrate into PI (balance sheet, DSCR)
6. Validate, audit, bump version, package
