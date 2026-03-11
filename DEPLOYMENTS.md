# FCP-PMR Deployment & Architecture Guide
**Living document — update with every major change.**
**Last updated:** v2.27.5 (2026-03-10)

---

## 🚨 READ THIS FIRST (New Session Checklist)

Every new Claude session working on FCP-PMR should:

1. **Read this file** (`DEPLOYMENTS.md`) — it has all the context you need
2. **Read the uploaded tarball version** — `grep '"version"' package.json`
3. **Run `node validate.js`** before AND after making changes
4. **Bump version** in `package.json` on EVERY build
5. **Never guess at code** — always read the actual file before editing
6. **Package tarball with dist/** — `tar czf` must include `dist/worker.js`

---

## 📐 Architecture Overview

```
Platform:     Cloudflare Workers (Paid plan — $5/mo, 10M req/mo)
Database:     D1 (SQLite) — ~23 tables
Storage:      R2 bucket (fcp-pmr-images) for file uploads
Frontend:     Vanilla JS, 16 modules concatenated by build.js
Backend:      Single worker.js (~12K lines) — ES module format
Build:        build.js assembles frontend → inlines into worker
Domain:       pmr.fullcircle-property.com
```

### File Structure (current)
```
src/worker.js              12,258 lines  ← ALL backend code (monolith)
frontend/parts/js/
  00-dashboard.js             700 lines  ← Dashboard KPIs, action items
  01-globals.js             1,634 lines  ← Auth, state, utilities, _ico()
  02-properties.js          5,384 lines  ← Property CRUD, detail view, listing health
  03-analysis.js              428 lines  ← Global analysis tab
  04-comparables.js           278 lines  ← Comps management
  05-lookup.js                354 lines  ← Address/property lookup
  06-csv.js                    56 lines  ← CSV export
  07-market.js                815 lines  ← Market data, profiles
  08-settings.js              482 lines  ← Admin panel
  09-intel.js                 577 lines  ← Intel/data hub
  10-finances.js            1,138 lines  ← Portfolio finances
  11-pricing.js             1,137 lines  ← Pricing strategies
  12-pricelabs.js             936 lines  ← PriceLabs integration
  13-guesty.js              1,138 lines  ← Guesty PMS integration
  14-algo-health.js           586 lines  ← Algorithm health dashboard
  15-intelligence.js          482 lines  ← Intelligence features
frontend/parts/app-html.html  1,656 lines  ← Main HTML shell
validate.js                              ← Build validation (RUN EVERY TIME)
build.js                                 ← Frontend assembler
deploy.sh                                ← One-command deploy
```

---

## 🛡️ Validation Script (`validate.js`)

**Run before AND after every code change:**
```bash
node validate.js
```

The script checks 26 items across 7 categories — every class of bug we've ever hit:

| Category | What it catches |
|----------|----------------|
| Syntax | Frontend JS parse errors, build failures |
| SQL Safety | `${uid}` injection, `.first()` destructuring, `service_name` ghost column |
| Data Integrity | Singleton constants, cascade delete coverage, share expiry |
| Business Rules | RentCast LTR-only, LOWER() on cities, managed exclusion |
| Security | Crypto for tokens, no debug endpoints, auth enforcement |
| Frontend | Tab scoping, COALESCE labels, icon system |
| Build | Version set, dist output exists |

**If it fails: DO NOT DEPLOY. Fix first.**

**To add new checks:** When a new bug class is discovered, add a `check()` or `warn()` call to `validate.js` so it's caught forever.

---

## 🔧 Key Constants (Single Source of Truth)

These are defined ONCE at the top of `src/worker.js` and referenced everywhere:

```js
// Line ~91 — Status exclusion for reservation queries
const EXCLUDED_STATUSES = "'canceled','cancelled','declined',...";
const LIVE_STATUS_SQL = `LOWER(COALESCE(status,'')) NOT IN (${EXCLUDED_STATUSES})`;
const LIVE_STATUS_GR = `LOWER(COALESCE(gr.status,'')) NOT IN (${EXCLUDED_STATUSES})`;
const LIVE_STATUS_MA = `LOWER(COALESCE(ma.status,'')) NOT IN (${EXCLUDED_STATUSES})`;

// Line ~98 — API keys managed by Admin UI (used in fetch + cron handlers)
const MANAGED_KEYS = ['ANTHROPIC_API_KEY','OPENAI_API_KEY','RENTCAST_API_KEY',...];
```

**RULE:** Never define these inline. Always reference the constant. `validate.js` checks for duplicates.

---

## 🚫 Hard Rules (Non-Negotiable)

| Rule | Why | Enforced by |
|------|-----|-------------|
| **RentCast is LTR-only** | It's a long-term rental data provider. STR comps come from SearchAPI. | `validate.js` check + `isLTR` guard in code |
| **LOWER() on all city comparisons** | City names may be mixed case in DB vs user input | `validate.js` check |
| **Status exclusion uses the constant** | 34+ queries need identical status filtering | `validate.js` singleton check |
| **Managed properties excluded from portfolio** | Jupiter FL is managed for an owner — its revenue must never appear in FCP's portfolio | Code uses `is_managed = 0 OR is_managed IS NULL` |
| **Buildings excluded from action items** | Parent buildings are containers, not actionable units | `parent_id IS NULL` or `NOT IN parent_id` patterns |
| **Image uploads use file upload, not URL-only** | URL pasting is insufficient; `/api/images/upload` exists | Frontend uses file input buttons |
| **Lookup must confirm before overwriting** | Prevents accidental data loss from auto-imports | Confirmation dialog in lookup flow |
| **Cascade delete covers all tables** | Deleted properties must not leave orphan data | `validate.js` checks 17 tables + child units |
| **Bump version on EVERY build** | Track what's deployed | `validate.js` checks version exists |

---

## 🏗️ Modular Extraction Plan

**Goal:** Incrementally split the monolith to reduce context window usage in future sessions, without a risky big-bang refactor.

**Strategy:** Extract one domain at a time, only when that domain is being actively modified. Test immediately after each extraction.

### Extraction Order (by risk/value)

| Phase | Extract | From | To | Lines | Risk | Trigger |
|-------|---------|------|----|-------|------|---------|
| 1 | Auth & sessions | `worker.js` | `src/lib/auth.js` | ~300 | Low | Next auth change |
| 2 | API key management | `worker.js` | `src/lib/api-keys.js` | ~200 | Low | Next key change |
| 3 | Schema/migrations | `worker.js` | `src/lib/schema.js` | ~600 | Low | Next schema change |
| 4 | Admin/settings routes | `worker.js` | `src/routes/admin.js` | ~500 | Low | Next admin change |
| 5 | Finance routes | `worker.js` | `src/routes/finance.js` | ~800 | Med | Next finance change |
| 6 | Guesty sync/CSV | `worker.js` | `src/routes/guesty.js` | ~2000 | Med | Next Guesty change |
| 7 | PriceLabs routes | `worker.js` | `src/routes/pricelabs.js` | ~600 | Med | Next PL change |
| 8 | AI analysis/prompts | `worker.js` | `src/routes/analysis.js` | ~2000 | High | Next AI change |
| 9 | Property CRUD | `worker.js` | `src/routes/properties.js` | ~1500 | High | Next prop change |
| 10 | Dashboard/cron | `worker.js` | `src/routes/dashboard.js` | ~800 | High | Next dashboard change |

### Extraction Process (for each phase)
1. **Read** the functions to extract — identify ALL dependencies (other functions, constants, env)
2. **Create** the new file with the functions + their imports
3. **Update** `worker.js` to import from the new file
4. **Update** `build.js` if needed to bundle the new module
5. **Run** `node validate.js` — must pass
6. **Test** the specific feature in the browser
7. **Update** this file's file structure section
8. **Add** any new validation checks to `validate.js` if the extraction introduced new patterns

### How build.js Would Handle Modules
Currently `build.js` concatenates frontend JS and inlines it. For backend modules:
- Option A: Use native ES module imports in `worker.js` — Cloudflare Workers supports this
- Option B: Extend `build.js` to bundle backend modules into `dist/worker.js`
- **Recommendation:** Option A is cleaner and requires less build tooling

### Frontend Extraction
`02-properties.js` (5,384 lines) should eventually split:
- `02a-property-list.js` — list view, cards, filtering
- `02b-property-detail.js` — detail view, tabs, overview
- `02c-property-forms.js` — add/edit forms, image management
- `02d-listing-health.js` — listing health panel renderer
- `02e-property-share.js` — share links, history

Same incremental approach: only extract when modifying that section.

---

## 📊 Properties & Data

### Current Properties (10)
| Property | Location | Type | Notes |
|----------|----------|------|-------|
| CT multi-family units | Middletown, Berlin, Milford, Southbury CT | Multi-family | Owned units |
| Jupiter FL | Jupiter, FL | Managed | Gated HOA, max 2 rentals/yr, 30-day min, MTR not STR |
| Palm City FL | Palm City, FL | Research | Research only, not owned |

### Integration Status
- **Guesty** — Connected. 6hr cron sync + daily full rebuild.
- **PriceLabs** — Connected. Daily cron price sync.
- **RentCast** — LTR data only. 50 free calls/mo.
- **SearchAPI** — Zillow + STR comps. Budget-guarded at 80 calls.
- **Google Places** — Address autocomplete.

### Cron Schedule
| Trigger | What | Notes |
|---------|------|-------|
| `0 */6 * * *` | Guesty incremental reservation sync | Every 6 hours |
| `0 6 * * *` | Full daily rebuild | PriceLabs + Guesty + actuals + intelligence + market crawl + profiles + stale cleanup |
| `0 6 * * 1` | Weekly Monday listings refresh | Guesty listing data resync |

---

## 📝 Version History (Key Milestones)

| Version | Date | Key Changes |
|---------|------|-------------|
| v2.27.5 | 2026-03-10 | Fixed 5 more `.catch()` on non-Promise bugs (research tab, PL action items, Guesty address, marketing export). New validate.js check (26/26). Dashboard layout: setup prompts + discoveries moved up. |
| v2.27.2 | 2026-03-10 | Market Intelligence overhaul: monthly revenue trend chart, snapshot trend chart, top hosts, market alerts on profile, managed exclusion in portfolio actuals |
| v2.27.1 | 2026-03-10 | CRITICAL: `.catch()` on `forEach` crashed `enterApp()` (pages stuck loading), SQL OR precedence in nearby query, managed property leak in portfolio actuals |
| v2.27.0 | 2026-03-10 | Screenshots rebuilt to match actual app views, audit items closed out, .then() catch handlers |
| v2.26.8 | 2026-03-10 | Guesty listing content on property detail (description, photos, accommodates from guesty_listings) |
| v2.26.6 | 2026-03-10 | AI generate fix (wrong function names), marketing api() signature fix, dashboard ${uf} regression fix |
| v2.26.3 | 2026-03-10 | Marketing content locking (is_locked column), batch seed fix, lock/unlock icons |
| v2.26.2 | 2026-03-10 | Persistent syslog() system, system_log table, Admin log viewer panel, auto-cleanup cron |
| v2.26.1 | 2026-03-10 | Double-click btnGuard(), 38 empty catches → logged in critical functions |
| v2.26.0 | 2026-03-10 | Marketing tab (admin-only) — seed, AI generate, lock, preview, export, screenshots |
| v2.25.6 | 2026-03-10 | SQL injection fix (getDashboard), crypto share codes, MANAGED_KEYS singleton, validation script |
| v2.25.5 | 2026-03-10 | Listing health panel, code audit fixes |
| v2.25.0 | 2026-03-09 | Listing health backend, AI prompt listing_improvements schema |
| v2.16.5 | earlier | Guesty+PriceLabs integrated, 10 properties, cron system |
| v2.10.2 | earlier | Pet fee fix (deterministic confirmation codes), auto-rebuild after import |
| v2.9.0 | earlier | Pet fee as real column, CSV import extraction |
| v2.8.0 | earlier | Major code audit — service_name, cascade delete, expires_at, debug endpoint removed |

### Bug Hall of Fame (lessons learned)
| Bug | Version Found | Root Cause | Prevention |
|-----|--------------|------------|------------|
| `service_name` ghost column | v2.8.0 | Query used column that doesn't exist — silently returned NULL | `validate.js` check |
| `.first()` destructured as `.all()` | v2.8.0 | D1 `.first()` returns a row, not `{results:[]}` | `validate.js` check |
| Orphan data from deletes | v2.8.0 | Missing tables in cascade delete | `validate.js` checks 17 tables |
| `alertTriangle` syntax error | v2.24.0 | sed replacement broke JS string concatenation | Frontend syntax check in `validate.js` |
| Pet stats inflated | v2.8.0 | Guest-level pet flag applied to all stays, not per-reservation | Fixed in code |
| Revenue missing `closed` status | v2.8.0 | `closed` reservations excluded from revenue queries | `EXCLUDED_STATUSES` constant |
| `${uid}` SQL injection | v2.25.6 | String interpolation in getDashboard instead of bind | `validate.js` check |
| MANAGED_KEYS divergence | v2.25.6 | Defined in 3 places — risk of adding key to one but not others | Global constant + `validate.js` |
| `${uf}` undefined after refactor | v2.26.4 | Removed `uf` variable from getDashboard for SQL injection fix but forgot second query still used it → finance metrics silently zeroed | `syslog()` caught it immediately |
| `api()` wrong signature | v2.26.5 | Marketing code used `api(path, {method:'POST'})` (fetch-style) instead of `api(path, 'POST', body)` → network errors | Note in DEPLOYMENTS: `api(path, method, body)` not options object |
| Wrong AI function names | v2.26.6 | Called `selectAIProvider()` / `callAI()` which don't exist — actual names are `pickAIProvider()` / `callAIWithFallback()` | Always read actual code before calling functions |
| Math.random for share codes | v2.25.6 | Predictable, low entropy | `validate.js` checks for crypto |
| `.catch()` on `forEach()` | v2.27.1 | `forEach` returns `undefined`; chaining `.catch()` throws TypeError, crashing `enterApp()` — entire app fails to load | Never chain `.catch()` on non-Promise returns; `validate.js` should check |
| SQL OR without parentheses | v2.27.1 | `AND x OR y AND z` binds as `(AND x) OR (y AND z)` — nearby property query returned entire DB for standalone properties | Always parenthesize OR conditions in SQL WHERE clauses |
| `getPortfolioActuals` missing managed exclusion | v2.27.1 | Excluded research but not managed → Jupiter FL revenue leaked into portfolio YTD/LY totals | Grep all portfolio queries for managed exclusion pattern |
| `.catch()` on array methods / constructors | v2.27.5 | v2.26.1 "empty catches" pass added `.catch()` to `.filter()`, `.forEach()`, `.map()`, `new Blob()`, `addEventListener()` — all return non-Promise, so `.catch()` throws TypeError or returns undefined | `validate.js` check #26 catches this pattern forever |

---

## 💡 Session Efficiency Tips

### For Claude (AI assistant)
- **Don't read all of worker.js** — use `grep -n` to find the relevant function, then `sed -n` to read just that section
- **Run validate.js first** to know what's already passing before making changes
- **Read this file first** to avoid re-discovering known issues
- **Be surgical** — fix one thing at a time, verify, move on
- **When auditing:** the validation script catches the structural bugs. Manual review should focus on logic correctness, not pattern matching.
- **Context window budget:** ~30K lines total codebase. Reading even 30% of it consumes most of the context window. Target reading <10% per session.

### Critical Gotchas (learned the hard way)
- **`api()` signature is `api(path, method, body)`** — NOT `api(path, {method, body})`. It's positional args, not a fetch-style options object. Every POST/PUT/DELETE call must be `api('/path', 'POST', { data })`.
- **AI functions are `pickAIProvider(env, taskName, qualityPref)` and `callAIWithFallback(env, taskName, prompt, maxTokensMain, maxTokensWorkers)`** — they return `{text, provider}` on success. Don't make up function names.
- **When refactoring a variable in a function, grep for ALL references in that function** — the `${uf}` bug happened because one query was fixed but a second query in the same function still used the old variable.
- **`syslog(env, level, source, message, detail, propertyId)`** — use this for error logging, not `console.error`. It persists to DB and shows in Admin → System Log.
- **`env.DB.batch(stmts)`** for bulk writes — never loop with sequential `await .run()` calls. D1 has subrequest limits.

### For the developer
- **Always upload the latest tarball** when starting a new chat
- **State what you want done** specifically — "fix the finance tab NaN" is better than "fix bugs"
- **Reference this doc** — "continue with Phase 3 extraction" or "the getDashboard bug from the hall of fame"
- **Keep sessions focused** — one feature or one bug domain per session prevents context overflow
- **The "conversation too long" problem** will improve as we extract modules. Each extraction reduces how much code needs to be read for a given task.

---

## 🔄 Deploy Checklist

Before every deployment:
```bash
# 1. Bump version
# Edit package.json version

# 2. Run validation
node validate.js

# 3. Build
node build.js

# 4. Package
tar czf fcp-pmr-v{VERSION}.tar.gz \
  --exclude='node_modules' --exclude='.git' \
  package.json build.js deploy.sh wrangler.toml validate.js \
  DEPLOYMENTS.md README.md dns-setup.js \
  src/worker.js dist/worker.js \
  frontend/ migrations/

# 5. Deploy
./deploy.sh

# 6. Verify
# - Dashboard loads
# - Properties list renders
# - Click into a property detail
# - Check finance tab shows numbers (not NaN)
# - Check listing health panel loads
```

---

## 🗄️ Database Tables Reference

**Core:** `properties`, `property_amenities`, `property_platforms`, `property_services`, `property_expenses`, `property_shares`, `property_images`, `property_algo_overrides`

**Pricing:** `pricing_strategies`, `analysis_reports`, `performance_snapshots`, `price_history`

**Market:** `market_snapshots`, `market_seasonality`, `market_insights`, `market_watchlist`, `comparables`, `master_listings`

**PMS:** `guesty_reservations`, `guesty_listings`, `guesty_calendar`, `guesty_guests`, `monthly_actuals`, `guest_stays`

**Intelligence:** `channel_intelligence`, `crawl_jobs`, `data_uploads`, `pricelabs_listings`, `pricelabs_rates`

**System:** `users`, `sessions`, `images`, `app_settings`, `ai_usage`, `api_usage`, `rc_usage`, `cf_usage`, `service_catalog`, `sync_log`

**All tables with `property_id`** must be included in cascade delete. Current coverage: 17 tables + child units via `parent_id`.
