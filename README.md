# FCP — Property Market Research (PMR)

STR/LTR market analysis, pricing strategy, and portfolio management engine by Full Circle Property.  
Live at: **https://pmr.fullcircle-property.com**

---

## Quick Deploy

```bash
tar -xzf fcp-pmr-complete.tar.gz
cd fcp-pmr
./deploy.sh
```

The script handles everything interactively:
1. Preflight (Node, wrangler, auth check)
2. D1 database — creates `fcp-pmr-db` or reuses existing
3. R2 bucket — creates `fcp-pmr-images` for file uploads
4. Schema — just pings the DB; worker auto-migrates all tables on first request
5. Build — runs `build.js` to assemble `dist/worker.js`
6. Deploy — `wrangler deploy` (only touches the `fcp-pmr` worker)
7. DNS — auto-creates `pmr.fullcircle-property.com` CNAME via `dns-setup.js`
8. API keys — optional prompts for Anthropic, OpenAI, Google Places, RentCast, SearchAPI

> **Schema is fully self-managed.** The worker runs `ensureSchema()` on every cold start using `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE IF NOT EXISTS`. You never need to run migration files manually on an existing deployment — just deploy the new worker and it catches itself up.

---

## First Login

On first visit, PMR prompts you to create the admin account. The default password is defined in `src/worker.js` (`DEFAULT_ADMIN_PASSWORD`). **Change it immediately** — the setup screen won't let you reuse the default.

---

## Auth System

- **Sessions** — Bearer token, 72-hour expiry, stored in D1
- **Registration** — open sign-up form, admin must approve before access granted
- **Roles** — `admin` and `user`; admins can approve/reject/promote/demote/delete

Admin panel covers: user management, API key storage, budget controls per AI provider, DNS setup, usage/cost dashboard.

---

## Architecture

```
pmr.fullcircle-property.com
        │
  ┌─────┴──────────────────────────────────────────┐
  │              Cloudflare Worker                  │
  │                                                 │
  │  ┌──────────────────┐  ┌─────────────────────┐  │
  │  │ Frontend (inline) │  │  REST API (~114      │  │
  │  │ ~9,800 lines JS   │  │  routes)            │  │
  │  │ 14 modules        │  └──────────┬──────────┘  │
  │  └──────────────────┘             │             │
  │                        ┌──────────┴──────────┐  │
  │  ┌──────────────────┐  │  D1 SQLite (~23      │  │
  │  │   R2 Bucket       │  │  tables)            │  │
  │  │  (image uploads)  │  └─────────────────────┘  │
  │  └──────────────────┘                           │
  └─────────────────────────────────────────────────┘
         │              │               │
    Anthropic        OpenAI        Workers AI
    (Claude)        (GPT-4o)       (free tier)
         │              │               │
    RentCast       SearchAPI      PriceLabs API
    (LTR data)    (Zillow/web)   (STR pricing)
                                        │
                                   Guesty PMS
```

---

## Project Structure

```
fcp-pmr/
├── deploy.sh                     ← one-command deploy (7 steps)
├── dns-setup.js                  ← auto-creates Cloudflare CNAME (called by deploy.sh)
├── build.js                      ← assembles frontend parts → inlines into worker
├── package.json
├── wrangler.toml
├── README.md
├── src/
│   └── worker.js                 ← full backend: API + auth + AI + pricing (~7,100 lines)
├── frontend/
│   └── parts/
│       ├── app-html.html         ← main app UI (~1,055 lines)
│       └── js/
│           ├── 01-globals.js     ← shared state, auth, utilities (~991 lines)
│           ├── 02-properties.js  ← property CRUD, pricing tab, strategy cards (~3,987 lines)
│           ├── 03-analysis.js    ← global analysis tab (~422 lines)
│           ├── 04-comparables.js ← comps management (~278 lines)
│           ├── 05-lookup.js      ← address/property lookup + import (~354 lines)
│           ├── 06-csv.js         ← CSV export (~56 lines)
│           ├── 07-market.js      ← market data tab (~347 lines)
│           ├── 08-settings.js    ← admin panel, API keys, users (~422 lines)
│           ├── 09-intel.js       ← intel/data dump tab (~229 lines)
│           ├── 10-finances.js    ← portfolio finance dashboard (~814 lines)
│           ├── 11-pricing.js     ← pricing history + strategy management (~526 lines)
│           ├── 12-pricelabs.js   ← PriceLabs sync + listing management (~474 lines)
│           ├── 13-guesty.js      ← Guesty PMS integration (~560 lines)
│           └── 14-algo-health.js ← algorithm health dashboard (~299 lines)
├── migrations/
│   ├── 0001_init.sql             ← core schema: properties, comps, strategies, market
│   ├── 0002_auth.sql             ← users + sessions tables
│   ├── 0003_images_units.sql     ← image storage + unit columns
│   ├── 0004_name_column.sql      ← property name column
│   ├── seed_palm_city.sql        ← FL property + market seed data
│   └── seed_southbury.sql        ← CT portfolio seed data
└── dist/
    └── worker.js                 ← built output (~1,093 KB, auto-generated)
```

> **Migration files are for fresh databases only.** All subsequent schema changes are handled by `ensureSchema()` in `worker.js` at runtime. Do not run migration files against an existing deployment.

---

## Database Tables (~23)

| Group | Tables |
|-------|--------|
| Core | `properties`, `property_amenities`, `property_platforms`, `property_services`, `property_expenses`, `property_shares` |
| Pricing | `pricing_strategies`, `analysis_reports`, `performance_snapshots` |
| Market | `market_snapshots`, `market_seasonality`, `market_insights`, `comparables` |
| PMS | `guesty_reservations`, `guesty_listings`, `monthly_actuals` |
| Intel | `master_listings`, `crawl_jobs`, `data_uploads`, `pricelabs_listings`, `pricelabs_rates` |
| System | `users`, `sessions`, `images`, `app_settings`, `ai_usage`, `api_usage`, `rc_usage`, `cf_usage`, `service_catalog` |

---

## AI Providers

| Provider | Use | Key |
|----------|-----|-----|
| Anthropic (Claude) | Pricing strategies, PL optimization, revenue analysis | `ANTHROPIC_API_KEY` (secret or Admin → API Keys) |
| OpenAI (GPT-4o mini) | Fallback for all AI tasks | `OPENAI_API_KEY` |
| Cloudflare Workers AI | Free fallback, market summaries | Bound in `wrangler.toml` (no key needed) |

AI provider selection: user's explicit choice → auto-pick by budget → Workers AI free fallback.  
Per-provider budget limits configurable in Admin → API Keys.  
All AI calls logged in `ai_usage` (viewable in Admin → Usage).  
If AI fails, the UI now shows a specific error banner explaining why (bad key, budget exceeded, etc.).

---

## External APIs

| API | Purpose | Where to configure |
|-----|---------|-------------------|
| RentCast | LTR comps, property lookup (50 free calls/mo) | Admin → API Keys |
| SearchAPI | Zillow Zestimate + Rent Zestimate, STR comps | Admin → API Keys |
| Google Places | Address autocomplete | Admin → API Keys |
| PriceLabs | Live STR pricing, occupancy, rates calendar | Admin → PriceLabs (OAuth flow) |
| Guesty | Reservation imports, listing matching | Admin → Guesty (API key) |

> **RentCast is strictly for long-term rental data.** Never called for STR comps. STR comps come from SearchAPI (Airbnb/VRBO) only. This is enforced in the codebase.

---

## DNS Setup

`dns-setup.js` is called automatically by `deploy.sh` step 7. It:
1. Reads your Cloudflare auth from wrangler's local config (`~/.config/.wrangler/`)
2. Looks up the zone ID for `fullcircle-property.com`
3. Creates a proxied CNAME: `pmr` → `fcp-pmr.workers.dev`
4. Exits cleanly if the record already exists

If auto-setup fails (new machine, expired token), deploy.sh falls back to prompting for a Cloudflare API token or shows manual instructions. The script is always needed — keep it in the project.

Required token permission: **Zone.DNS Edit** on `fullcircle-property.com`.

---

## Key API Routes

### Auth
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/auth/init` | Check/create first admin |
| POST | `/api/auth/login` | Login → Bearer token |
| POST | `/api/auth/register` | Request access |
| GET | `/api/auth/me` | Current user |
| POST | `/api/auth/logout` | End session |

### Properties
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/properties` | List / create |
| GET/PUT/DELETE | `/api/properties/:id` | Read / update / delete (cascades all child data) |
| GET/POST | `/api/properties/:id/amenities` | Amenities |
| POST | `/api/properties/:id/analyze` | Pricing analysis (STR / LTR / Both) |
| GET | `/api/properties/:id/strategies` | Saved pricing strategies |
| GET | `/api/properties/:id/reports` | Saved AI analysis reports |
| GET | `/api/properties/:id/performance` | Performance snapshots |
| POST | `/api/properties/:id/zestimate` | Fetch Zillow home value + Rent Zestimate |
| POST | `/api/properties/:id/pl-strategy` | Generate full PriceLabs AI strategy |
| POST | `/api/properties/:id/revenue-optimize` | AI revenue gap analysis |
| POST | `/api/properties/:id/acquisition-analysis` | Acquisition / ROI analysis |
| POST | `/api/properties/:id/share` | Create / manage share links |
| POST | `/api/properties/:id/add-unit` | Add unit to multi-family building |
| GET/POST | `/api/properties/:id/platforms` | Listing platform management |
| POST | `/api/properties/:id/platforms/scrape` | Scrape live platform data |
| POST | `/api/properties/bulk-delete` | Cascade delete multiple properties |
| POST | `/api/properties/bulk-edit` | Batch field updates |

### Market / Comps / Finance
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/market` | Market snapshots |
| POST | `/api/market/fetch` | Fetch market data (RentCast / SearchAPI) |
| GET/POST | `/api/properties/:id/comparables` | Comps per property |
| GET | `/api/finances` | Portfolio finance summary |

### PriceLabs / Guesty
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/pricelabs/sync` | Sync listings + rates from PriceLabs |
| POST | `/api/pricelabs/listings/:id/link` | Link PL listing to property |
| POST | `/api/guesty/import` | Import reservations from Guesty CSV |

### Admin
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List users |
| POST | `/api/admin/users/:id/approve` | Approve pending user |
| POST | `/api/admin/users/:id/role` | Set role (user / admin) |
| POST | `/api/admin/users/:id/reset-password` | Generate temp password |
| DELETE | `/api/admin/users/:id` | Delete user |
| GET/POST | `/api/admin/keys` | API key read / write |
| GET | `/api/admin/usage` | AI + API cost dashboard |
| GET | `/api/admin/stats` | System stats + DB size |
| POST | `/api/admin/migrate` | Force schema re-migration |

### Sharing (public, no auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/share/:code` | Shared property view (expires_at enforced) |

---

## Manual Commands

```bash
# Local dev
npm run dev

# Deploy
./deploy.sh

# Force schema re-migration on existing deployment
curl -X POST https://pmr.fullcircle-property.com/api/admin/migrate \
  -H "Authorization: Bearer <your-token>"

# Live logs
wrangler tail

# Add AI key as Wrangler secret (alternative to Admin UI)
wrangler secret put ANTHROPIC_API_KEY

# Query DB directly
wrangler d1 execute fcp-pmr-db --remote --command "SELECT COUNT(*) FROM properties"

# List all tables
wrangler d1 execute fcp-pmr-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

---

## Security

- All write endpoints require a valid Bearer token (except `/api/auth/*` and `/api/share/*`)
- Property reads/writes/deletes enforce `user_id` ownership
- Share links enforce `expires_at` — expired links return 404
- Share links expose strategies and metadata only — AI report content is excluded
- Admin password must be changed on first login; default cannot be reused
- All SQL queries use parameterized binding (no string interpolation)
- API keys stored in DB via Admin UI; secrets via wrangler are isolated per worker
