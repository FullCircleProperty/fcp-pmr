# FCP — Property Market Research (PMR)

STR market analysis & pricing strategy engine by Full Circle Property.  
Live at: **https://pmr.fullcircle-property.com**

## Deploy

```bash
tar -xzf fcp-pmr.tar.gz
cd fcp-pmr
./deploy.sh
```

The script handles everything: wrangler install, auth, D1 setup, schema + auth migration, seed data, build, deploy, custom domain setup, and AI config.

## Auth System

On first visit, PMR prompts you to create an admin account with a default password (`PMR@dmin2026!`). You **must** change it on first login.

**User flow:**
- Anyone can request access via the registration form
- Admin approves/rejects pending users from the Admin tab
- Admin can reset passwords (generates temp password, forces change on login)
- Admin can promote users to admin or demote
- Sessions last 72 hours (Bearer token auth)

**Admin panel features:**
- User management: approve, reject, role change, password reset, delete
- DNS configuration: auto-creates CNAME + worker route via Cloudflare API
- Password change

## Architecture

```
pmr.fullcircle-property.com
        │
  ┌─────┴─────────────────────────────┐
  │       Cloudflare Worker           │
  │  ┌──────────┐  ┌──────────────┐   │
  │  │ Frontend  │  │  Auth +      │   │
  │  │ (inline)  │  │  Pricing     │   │
  │  └──────────┘  │  Engine      │   │
  │  ┌──────────┐  └──────┬───────┘   │
  │  │ D1 SQLite│  ┌──────┴───────┐   │
  │  │ 9 tables │  │ AI Provider  │   │
  │  └──────────┘  └──────────────┘   │
  └───────────────────────────────────┘
```

## Project Structure

```
fcp-pmr/
├── deploy.sh                     ← one-command deploy
├── build.js                      ← assembles parts → inlines into worker
├── package.json
├── wrangler.toml
├── README.md
├── src/
│   └── worker.js                 ← API + auth + pricing engine (460 lines)
├── frontend/
│   ├── parts/                    ← modular source files
│   │   ├── styles.css            ← all CSS (231 lines)
│   │   ├── auth-screens.html     ← login/register/init/changepw (51 lines)
│   │   ├── app-html.html         ← main app UI (202 lines)
│   │   └── app.js                ← all JavaScript (572 lines)
│   └── index.html                ← assembled output (auto-generated)
├── migrations/
│   ├── 0001_init.sql             ← core schema + amenities + taxes
│   ├── 0002_auth.sql             ← users + sessions tables
│   ├── seed_southbury.sql        ← CT portfolio data
│   └── seed_palm_city.sql        ← FL property + market data
└── dist/
    └── worker.js                 ← built output (auto-generated)
```

## API

### Auth (public)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/init` | Check if admin exists |
| POST | `/api/auth/init` | Create first admin |
| POST | `/api/auth/login` | Login → token |
| POST | `/api/auth/register` | Request access (pending) |

### Auth (authenticated)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me` | Current user info |
| POST | `/api/auth/change-password` | Change password |
| POST | `/api/auth/logout` | End session |

### Admin
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users/:id/approve` | Approve pending user |
| POST | `/api/admin/users/:id/reject` | Reject & delete |
| POST | `/api/admin/users/:id/role` | Set role (user/admin) |
| POST | `/api/admin/users/:id/reset-password` | Reset → temp pw |
| DELETE | `/api/admin/users/:id` | Delete user |
| POST | `/api/admin/dns/setup` | Auto-configure DNS |

### Properties & Analysis (authenticated)
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/properties` | List/create |
| GET/PUT/DELETE | `/api/properties/:id` | Read/update/delete |
| GET/POST | `/api/properties/:id/amenities` | Amenities |
| POST | `/api/properties/:id/analyze` | **Run pricing analysis** |
| GET | `/api/properties/:id/strategies` | Saved strategies |
| GET/POST | `/api/market` | Market snapshots |
| POST | `/api/comparables` | Add comparable |
| GET | `/api/taxes` | Tax rates |

## DNS Auto-Configuration

From the Admin tab, provide your Cloudflare API token and Zone ID. PMR will automatically:
1. Create a CNAME record (`pmr` → worker)
2. Add a worker route (`pmr.fullcircle-property.com/*` → fcp-pmr)

API token needs: **Zone.DNS Edit** + **Workers Routes Edit** permissions.

## Manual Commands

```bash
npm run dev                           # local dev
npm run deploy                        # build + deploy
wrangler d1 execute fcp-pmr-db \
  --remote --command "SELECT * FROM users"   # query users
wrangler secret put ANTHROPIC_API_KEY  # enable AI
wrangler tail                          # live logs
```
