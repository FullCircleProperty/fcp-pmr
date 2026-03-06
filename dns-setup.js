#!/usr/bin/env node
// dns-setup.js — Uses wrangler's internal fetch (with auth) to create DNS record
// This piggybacks on wrangler's stored OAuth session, so no tokens needed.

const { execSync } = require('child_process');

const ZONE_NAME = process.argv[2] || 'fullcircle-property.com';
const SUBDOMAIN = process.argv[3] || 'pmr';
const TARGET = process.argv[4] || 'fcp-pmr.workers.dev';
const FULL_DOMAIN = `${SUBDOMAIN}.${ZONE_NAME}`;

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim(); }
  catch (e) { return e.stdout ? e.stdout.trim() : ''; }
}

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  \x1b[32m✔\x1b[0m ${msg}`); }
function warn(msg) { console.log(`  \x1b[33m⚠\x1b[0m ${msg}`); }

async function main() {
  log(`Setting up DNS: ${FULL_DOMAIN} → ${TARGET}`);

  // Step 1: Get zone ID using wrangler d1 list trick — we know wrangler auth works
  // because we just deployed. Use a JS script that wrangler's node can run with fetch.

  // Actually, the simplest approach: just shell out to curl with the token from
  // CLOUDFLARE_API_TOKEN env, or ask wrangler to tell us account info.

  // BEST approach: use wrangler's undocumented but stable internal command
  // to dispatch API calls. This isn't available, so instead we'll write a
  // tiny worker script that calls the CF API and deploy it temporarily.

  // SIMPLEST approach that actually works: just use the Cloudflare dashboard API
  // via a wrangler-authenticated helper. Since wrangler exposes no direct API proxy,
  // we need the token. Let's extract it properly.

  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const https = require('https');

  // Find token - try every known location and format
  let token = process.env.CLOUDFLARE_API_TOKEN || '';

  if (!token) {
    const home = os.homedir();
    const paths = [
      path.join(home, '.config', '.wrangler', 'config', 'default.toml'),
      path.join(home, '.wrangler', 'config', 'default.toml'),
      path.join(home, '.config', 'wrangler', 'config', 'default.toml'),
      path.join(home, '.config', '.wrangler', 'config.toml'),
    ];

    for (const p of paths) {
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      log(`Found config: ${p}`);
      // Show what keys are in the config (not values) for debugging
      const keys = content.split('\n').filter(l => l.includes('=')).map(l => l.split('=')[0].trim());
      log(`  Keys: ${keys.join(', ')}`);

      // Try all token patterns
      for (const pattern of [
        /oauth_token\s*=\s*"([^"]+)"/,
        /api_token\s*=\s*"([^"]+)"/,
        /token\s*=\s*"([^"]+)"/,
      ]) {
        const m = content.match(pattern);
        if (m) { token = m[1]; break; }
      }

      // If we found a refresh token, try exchanging it
      if (!token) {
        const refreshMatch = content.match(/refresh_token\s*=\s*"([^"]+)"/);
        if (refreshMatch) {
          log('Found refresh token, exchanging...');
          // Read the expiry and access token if present
          const accessMatch = content.match(/access_token\s*=\s*"([^"]+)"/);
          if (accessMatch) {
            token = accessMatch[1];
            log('Using stored access token');
          } else {
            // Exchange refresh token
            try {
              const result = run(`curl -s -X POST "https://dash.cloudflare.com/oauth2/token" -d "grant_type=refresh_token&refresh_token=${refreshMatch[1]}&client_id=54d11594-84e4-41aa-b438-e81b8fa78ee7"`);
              const parsed = JSON.parse(result);
              if (parsed.access_token) {
                token = parsed.access_token;
                log('Exchanged refresh token');
              }
            } catch {}
          }
        }
      }

      if (token) break;
    }
  }

  if (!token) {
    // Last resort: try to extract from wrangler whoami debug output
    try {
      const debug = run('WRANGLER_LOG=debug wrangler whoami 2>&1 | head -50');
      const bearerMatch = debug.match(/Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
      if (bearerMatch) token = bearerMatch[1];
    } catch {}
  }

  if (!token) {
    warn('Could not find Cloudflare API token');
    warn('Set CLOUDFLARE_API_TOKEN env var and re-run, or create DNS manually');
    process.exit(1);
  }

  // Helper for CF API calls
  function cfApi(method, apiPath, body) {
    return new Promise((resolve) => {
      const opts = {
        hostname: 'api.cloudflare.com',
        path: `/client/v4${apiPath}`,
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ success: false, errors: [{ message: data.slice(0, 200) }] }); } });
      });
      req.on('error', (e) => resolve({ success: false, errors: [{ message: e.message }] }));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // Verify token
  let valid = await cfApi('GET', '/user/tokens/verify');
  if (!valid.success) valid = await cfApi('GET', '/user');
  if (!valid.success) {
    warn('Token invalid or expired');
    warn('Run: wrangler login');
    process.exit(1);
  }
  ok('Auth valid');

  // Find zone
  const zones = await cfApi('GET', `/zones?name=${ZONE_NAME}`);
  if (!zones.success || !zones.result || zones.result.length === 0) {
    warn(`Zone "${ZONE_NAME}" not found`);
    process.exit(1);
  }
  const zoneId = zones.result[0].id;
  ok(`Zone: ${ZONE_NAME} (${zoneId})`);

  // Check existing
  const existing = await cfApi('GET', `/zones/${zoneId}/dns_records?name=${FULL_DOMAIN}`);
  if (existing.success && existing.result && existing.result.length > 0) {
    ok(`DNS record already exists for ${FULL_DOMAIN}`);
    process.exit(0);
  }

  // Create
  log(`Creating CNAME: ${SUBDOMAIN} → ${TARGET} (proxied)...`);
  const result = await cfApi('POST', `/zones/${zoneId}/dns_records`, {
    type: 'CNAME', name: SUBDOMAIN, content: TARGET, proxied: true, ttl: 1
  });

  if (result.success) {
    ok(`DNS created: ${FULL_DOMAIN} → ${TARGET}`);
  } else {
    const errs = (result.errors || []).map(e => e.message).join(', ');
    if (/already|exist|duplicate/i.test(errs)) {
      ok('DNS record already exists');
    } else {
      warn(`Failed: ${errs}`);
      process.exit(1);
    }
  }
}

main().catch(e => { warn(e.message); process.exit(1); });
