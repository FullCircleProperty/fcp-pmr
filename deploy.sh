#!/usr/bin/env bash
# ============================================================
# FCP — Property Market Research (PMR)
# One-command deploy: ./deploy.sh
#
# ISOLATION: This script ONLY touches:
#   - Worker: fcp-pmr (no other workers affected)
#   - Database: fcp-pmr-db (no other D1 databases affected)
#   - Bucket: fcp-pmr-images (R2, for image uploads)
#   - DNS: creates ONE proxied CNAME for pmr.fullcircle-property.com
#   - Secrets: only on fcp-pmr worker, only if you opt in
#   - No global installs, no system changes
# ============================================================

set -e

DEPLOY_START=$(date +%s)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DB_NAME="fcp-pmr-db"
WORKER_NAME="fcp-pmr"
CUSTOM_DOMAIN="pmr.fullcircle-property.com"
ZONE_NAME="fullcircle-property.com"
TOTAL_STEPS=8
APP_VERSION=$(node -e "try{console.log(require('./package.json').version)}catch{console.log('?.?.?')}" 2>/dev/null || echo "?.?.?")

info()    { echo -e "${CYAN}▸${NC} $1"; }
success() { echo -e "${GREEN}✔${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
fail()    { echo -e "${RED}✖${NC} $1"; exit 1; }
step()    { STEP_START=$(date +%s); echo -e "\n${BOLD}${CYAN}[$1/$TOTAL_STEPS]${NC} ${BOLD}$2${NC}"; }
step_done() { local elapsed=$(( $(date +%s) - STEP_START )); echo -e "${DIM}   ⏱ ${elapsed}s${NC}"; }
divider() { echo -e "${DIM}────────────────────────────────────────────${NC}"; }

prompt_yn() {
  local msg="$1" default="${2:-y}"
  if [[ "$default" == "y" ]]; then
    read -rp "$(echo -e "${CYAN}?${NC} ${msg} [Y/n]: ")" ans
    [[ -z "$ans" || "$ans" =~ ^[Yy] ]]
  else
    read -rp "$(echo -e "${CYAN}?${NC} ${msg} [y/N]: ")" ans
    [[ "$ans" =~ ^[Yy] ]]
  fi
}

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  FCP — Property Market Research (PMR)        ║${NC}"
echo -e "${BOLD}║  v${APP_VERSION} → ${CUSTOM_DOMAIN}   ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================
# STEP 1: Preflight
# ============================================================
step 1 "Preflight checks"

if ! command -v node &> /dev/null; then
  fail "Node.js not found. Install from https://nodejs.org"
fi
success "node $(node --version)"

# Use existing wrangler if available, otherwise npx (no global install)
if command -v wrangler &> /dev/null; then
  WRANGLER="wrangler"
  success "wrangler $($WRANGLER --version 2>&1 | head -1)"
else
  WRANGLER="npx wrangler@latest"
  info "wrangler not found globally — using npx (no global install)"
fi

info "Checking Cloudflare authentication..."
if ! $WRANGLER whoami &> /dev/null 2>&1; then
  warn "Not authenticated with Cloudflare"
  info "Opening browser for login..."
  $WRANGLER login
fi
WHOAMI=$($WRANGLER whoami 2>&1 | grep -i "account" | head -1 || echo "authenticated")
success "$WHOAMI"

MISSING=0
for f in wrangler.toml src/worker.js frontend/parts/js/01-globals.js build.js migrations/0001_init.sql; do
  [[ ! -f "$SCRIPT_DIR/$f" ]] && echo -e "  ${RED}✖${NC} Missing: $f" && MISSING=1
done
[[ ! -d "$SCRIPT_DIR/frontend/parts/js" ]] && echo -e "  ${RED}✖${NC} Missing: frontend/parts/js/" && MISSING=1
[[ $MISSING -eq 1 ]] && fail "Missing required files."
success "All project files present"
step_done

# ============================================================
# STEP 2: D1 database
# Only creates fcp-pmr-db. Does NOT touch any other databases.
# ============================================================
step 2 "D1 database: $DB_NAME"

CURRENT_DB_ID=$(grep 'database_id' wrangler.toml | grep -v '#' | sed 's/.*= *"//' | sed 's/".*//' | tr -d ' ')

if [[ -z "$CURRENT_DB_ID" ]]; then
  info "No database_id in wrangler.toml — looking for existing $DB_NAME..."

  DB_ID=""
  DB_LIST=$($WRANGLER d1 list --json 2>/dev/null || echo "[]")
  DB_ID=$(echo "$DB_LIST" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{const r=JSON.parse(d);const m=r.find(x=>x.name==='$DB_NAME');
      if(m)process.stdout.write(m.uuid);}catch{}
    })" 2>/dev/null || true)

  if [[ -n "$DB_ID" && "$DB_ID" != "null" ]]; then
    success "Found existing database: $DB_ID"
  else
    info "Creating D1 database: $DB_NAME"
    CREATE_OUTPUT=$($WRANGLER d1 create "$DB_NAME" 2>&1) || true
    echo -e "${DIM}${CREATE_OUTPUT}${NC}"
    DB_ID=$(echo "$CREATE_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[^"]+' 2>/dev/null || true)
    [[ -z "$DB_ID" ]] && DB_ID=$(echo "$CREATE_OUTPUT" | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
    [[ -z "$DB_ID" ]] && read -rp "$(echo -e "${CYAN}?${NC} Paste the database_id: ")" DB_ID
    success "Database created: $DB_ID"
  fi

  # Only replaces empty "" — won't overwrite if already set
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|database_id = \"\"|database_id = \"$DB_ID\"|" wrangler.toml
  else
    sed -i "s|database_id = \"\"|database_id = \"$DB_ID\"|" wrangler.toml
  fi
  success "Updated wrangler.toml"
else
  DB_ID="$CURRENT_DB_ID"
  success "Database already configured: $DB_ID"
fi
step_done

# ============================================================
# STEP 3: R2 image bucket
# Creates fcp-pmr-images. Does NOT touch other buckets.
# ============================================================
step 3 "R2 bucket: fcp-pmr-images"

R2_BUCKET="fcp-pmr-images"
R2_EXISTS=$($WRANGLER r2 bucket list 2>/dev/null | grep -c "$R2_BUCKET" || echo "0")

if [[ "$R2_EXISTS" -gt 0 ]]; then
  success "R2 bucket already exists: $R2_BUCKET"
else
  info "Creating R2 bucket: $R2_BUCKET"
  R2_OUTPUT=$($WRANGLER r2 bucket create "$R2_BUCKET" 2>&1) || true
  echo -e "${DIM}${R2_OUTPUT}${NC}"
  if echo "$R2_OUTPUT" | grep -qi "error" && ! echo "$R2_OUTPUT" | grep -qi "already exists"; then
    warn "R2 bucket creation may have failed — images will fall back to D1 storage"
  else
    success "R2 bucket created (images stored outside database now)"
  fi
fi

# ============================================================
# STEP 4: Database bootstrap (fresh installs only)
# The worker runs ensureSchema() on every cold start — it uses
# CREATE TABLE IF NOT EXISTS + ALTER TABLE IF NOT EXISTS to
# self-migrate. No manual column tracking needed here.
# This step only seeds the two foundation tables that must
# exist before the worker can serve its first request.
# ============================================================
step 4 "Database bootstrap"

# Check whether the DB is completely fresh (no tables yet)
TABLE_CHECK=$($WRANGLER d1 execute "$DB_NAME" --remote --yes --command "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'" --json 2>/dev/null || echo "[]")
TABLE_COUNT=$(echo "$TABLE_CHECK" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);console.log(r[0]&&r[0].results?r[0].results[0].c:0)}catch{console.log(0)}})" 2>/dev/null)

if [[ "$TABLE_COUNT" -eq 0 ]]; then
  info "Fresh database — running foundation migrations..."
  $WRANGLER d1 execute "$DB_NAME" --remote --yes --file=./migrations/0001_init.sql 2>&1 \
    || warn "0001_init may have partially applied — worker will fill gaps on first request"
  $WRANGLER d1 execute "$DB_NAME" --remote --yes --file=./migrations/0002_auth.sql 2>&1 \
    || warn "0002_auth may have partially applied — worker will fill gaps on first request"
  success "Foundation schema created — worker auto-migrates remaining tables on first request"
else
  success "Database has $TABLE_COUNT tables — worker will auto-migrate any missing columns on first request"
fi
# ============================================================
# STEP 5: Build (local only — no Cloudflare interaction)
# ============================================================
step 5 "Build"

node build.js
[[ ! -f "dist/worker.js" ]] && fail "Build failed"
success "Built dist/worker.js ($(( $(wc -c < dist/worker.js) / 1024 )) KB)"
step_done

# ============================================================
# STEP 6: Deploy worker
# Deploys ONLY the fcp-pmr worker. Does NOT touch other workers.
# wrangler deploy reads wrangler.toml which specifies name = "fcp-pmr".
# ============================================================
step 6 "Deploy worker: $WORKER_NAME"

info "Deploying (only affects ${BOLD}${WORKER_NAME}${NC} worker)..."
DEPLOY_OUTPUT=$($WRANGLER deploy 2>&1) || true
echo -e "${DIM}${DEPLOY_OUTPUT}${NC}"

if echo "$DEPLOY_OUTPUT" | grep -qi "error"; then
  warn "Deploy may have issues — check output above"
else
  success "Worker deployed"
fi
step_done

# ============================================================
# STEP 7: Custom domain DNS
# Creates ONLY a CNAME for pmr.fullcircle-property.com.
# Checks if record exists first — never modifies/deletes existing records.
# ============================================================
step 7 "DNS: $CUSTOM_DOMAIN"

echo ""

# First check if DNS already resolves — if so, skip everything
DNS_RESOLVES=$(node -e "
  const dns = require('dns');
  dns.resolve4('${CUSTOM_DOMAIN}', (err, addrs) => {
    console.log(!err && addrs && addrs.length > 0 ? 'yes' : 'no');
  });
" 2>/dev/null || echo "no")

if [[ "$DNS_RESOLVES" == "yes" ]]; then
  success "DNS already configured for ${CUSTOM_DOMAIN}"
else
  info "Setting up DNS for ${CUSTOM_DOMAIN}..."
  info "(Only creates 1 CNAME — does not touch existing DNS records)"
  echo ""

  # Try auto-setup using wrangler's stored auth
  DNS_DONE=false
  if node dns-setup.js "$ZONE_NAME" "pmr" "${WORKER_NAME}.workers.dev" 2>&1; then
    DNS_DONE=true
  fi

  if [[ "$DNS_DONE" != "true" ]]; then
    echo ""
    warn "Auto DNS setup could not complete."
    echo ""
    echo -e "  ${BOLD}Option A:${NC} Paste a Cloudflare API token (dash.cloudflare.com → My Profile → API Tokens)"
    echo -e "  ${BOLD}Option B:${NC} Add DNS manually: ${ZONE_NAME} → DNS → CNAME pmr → ${WORKER_NAME}.workers.dev (proxied)"
    echo ""

    if prompt_yn "Paste an API token now?" "n"; then
      read -rsp "$(echo -e "${CYAN}?${NC} API token (hidden): ")" CF_TOKEN
      echo ""
      CF_TOKEN=$(echo "$CF_TOKEN" | tr -d '[:space:]')

      if [[ -n "$CF_TOKEN" ]]; then
        ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}" \
          -H "Authorization: Bearer ${CF_TOKEN}" \
          -H "Content-Type: application/json" | \
          node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).result[0].id)}catch{console.log('')}})")

        if [[ -z "$ZONE_ID" ]]; then
          warn "Could not find zone — check token permissions"
        else
          EXISTS=$(curl -s "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${CUSTOM_DOMAIN}" \
            -H "Authorization: Bearer ${CF_TOKEN}" \
            -H "Content-Type: application/json" | \
            node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).result.length>0)}catch{console.log(false)}})")

          if [[ "$EXISTS" == "true" ]]; then
            success "DNS record already exists for ${CUSTOM_DOMAIN}"
          else
            OK=$(curl -s -X POST \
              "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
              -H "Authorization: Bearer ${CF_TOKEN}" \
              -H "Content-Type: application/json" \
              -d "{\"type\":\"CNAME\",\"name\":\"pmr\",\"content\":\"${WORKER_NAME}.workers.dev\",\"proxied\":true,\"ttl\":1}" | \
              node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).success===true)}catch{console.log(false)}})")

            if [[ "$OK" == "true" ]]; then
              success "DNS record created: ${CUSTOM_DOMAIN} → ${WORKER_NAME}.workers.dev"
            else
              warn "DNS creation failed — add record manually in Dashboard"
            fi
          fi
        fi
      fi
    else
      info "Skipped — add the DNS record manually when ready"
    fi
  fi
fi

# ============================================================
# STEP 8: Done — API keys managed in Admin UI
# ============================================================
step 8 "API keys"
echo ""
success "API keys are managed in the Admin UI — go to Admin → API Keys after first login"
info "Do NOT use wrangler secret put for API keys — the Admin UI is the only source of truth"

# ============================================================
# Done
# ============================================================
echo ""
divider
echo ""
echo -e "${GREEN}${BOLD}  ✔ FCP Property Market Research — deployed!${NC}"
echo ""
echo -e "  ${BOLD}Version:${NC}    v${APP_VERSION}"
echo -e "  ${BOLD}URL:${NC}        https://${CUSTOM_DOMAIN}"
echo -e "  ${BOLD}Database:${NC}   ${DB_NAME} (${DB_ID})"
echo ""
echo -e "  ${DIM}${WRANGLER} tail              # live logs${NC}"
echo -e "  ${DIM}${WRANGLER} secret put ...    # add API keys later${NC}"
DEPLOY_TOTAL=$(( $(date +%s) - DEPLOY_START ))
echo ""
echo -e "  ${DIM}Total deploy time: ${DEPLOY_TOTAL}s${NC}"
echo ""
divider
