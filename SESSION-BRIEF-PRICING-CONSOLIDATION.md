# Session Brief: Pricing Analysis Consolidation

**Goal:** Merge three separate AI analysis functions into one unified analysis that produces one coherent, comprehensive result per property.

**Upload:** `fcp-pmr-v2.36.1.tar.gz` + this file

**Prompt for next session:**
> Continue FCP-PMR v2.36.1. Read DEPLOYMENTS.md and SESSION-BRIEF-PRICING-CONSOLIDATION.md first. The task is to consolidate the three pricing analysis functions into a single unified analysis. The brief has the full architecture, touchpoints, risks, and implementation plan.

---

## Why This Matters

The current system has three independent AI analysis functions that each make their own API call, produce different output schemas, and sometimes contradict each other. A user running all three on the same property might get:
- Price Analysis: $185/nt base, 35% occ, $2,367/mo
- PL Strategy: $165/nt base, 35% occ, $2,100/mo  
- Revenue Optimization: "raise rates by 15%" (contradicting the PL strategy that just lowered them)

Each analysis costs ~$0.02-0.05 in AI tokens. Consolidating saves 2/3 of that cost AND eliminates contradictions.

---

## Current Architecture (what exists now)

### Three Functions + One Helper

| Function | Lines | Location | API Route | Report Type | What It Does |
|----------|-------|----------|-----------|-------------|-------------|
| `analyzePricing()` | 758 | L3486 | `POST /api/properties/:id/analyze` | `pricing_analysis` | Generates 3 algorithmic strategies (Aggressive/Balanced/Premium) + 1 AI strategy. The main "Run Price Analysis" button. |
| `generateAIStrategy()` | 208 | L4244 | (called by analyzePricing) | (part of pricing_analysis) | Sub-function that handles the AI call for analyzePricing. Separate from PL Strategy. |
| `generatePLStrategyRecommendation()` | 304 | L4452 | `POST /api/properties/:id/pl-strategy` | `pl_strategy` | PriceLabs-focused AI analysis with setup steps, action items, seasonal adjustments. The "Generate Strategy" button on the PriceLabs config panel. |
| `generateRevenueOptimization()` | 182 | L4756 | `POST /api/properties/:id/revenue-optimize` | `revenue_optimization` | Revenue-focused AI with 90-day plan, quick wins, occupancy improvements, listing health. |

### Shared Data Layer
All three use `gatherPropertyContext()` (L3144) which queries ~34 DB tables and returns a unified context object. This is already consolidated — no changes needed here.

### What Each Saves

**To `pricing_strategies` table:**
- `analyzePricing` → saves 3-4 strategies (Aggressive Launch, Balanced, Premium, AI STR/LTR)
- `generatePLStrategyRecommendation` → saves 1 strategy ("AI Strategy (provider)")
- `generateRevenueOptimization` → does NOT save to pricing_strategies

**To `analysis_reports` table:**
- `analyzePricing` → `report_type = 'pricing_analysis'` (keeps last 3)
- `generatePLStrategyRecommendation` → `report_type = 'pl_strategy'`
- `generateRevenueOptimization` → `report_type = 'revenue_optimization'` + `'listing_health'`

### Frontend Callers (DO NOT BREAK THESE)

| File | Line | What | API Call |
|------|------|------|----------|
| `02-properties.js` | L4950 | "Run Price Analysis" button on Pricing subtab | `POST /api/properties/:id/analyze` |
| `02-properties.js` | L1370 | "Generate Strategy" button on PriceLabs config | `POST /api/properties/:id/pl-strategy` |
| `02-properties.js` | L856 | "Revenue Optimization" button | `POST /api/properties/:id/revenue-optimize` |
| `03-analysis.js` | L52 | Global analysis tab "Analyze" button | `POST /api/properties/:id/analyze` |
| `00-dashboard.js` | L907 | Bulk analyze from dashboard | `POST /api/analyze/bulk` |
| `12-pricelabs.js` | L513+ | PL compare panel reads strategies | reads `pricing_strategies` |
| `autoAnalyzeProperties()` | L4223 | Daily cron auto-analyze | calls `analyzePricing()` internally |

### Frontend Display Functions

| Function | File | What It Renders |
|----------|------|----------------|
| `renderStrategyCard(s)` | `02-properties.js` L2279 | Individual strategy card (base/weekend/cleaning/occ/peak/low/annual) |
| `renderPLStrategy(d)` | `02-properties.js` L1415 | PL strategy result with setup steps, action items, seasonal config |
| Revenue optimization | `02-properties.js` L856+ | Quick wins, 90-day plan, occupancy improvements |
| `loadPLComparePanel()` | `12-pricelabs.js` | Side-by-side comparison: PriceLabs Now vs AI recommendation |

---

## The Consolidated Design

### New Function: `generateUnifiedAnalysis(propertyId, request, env)`

**One AI call that produces ALL of the following:**

```json
{
  "pricing": {
    "base_nightly_rate": 165,
    "weekend_rate": 206,
    "cleaning_fee": 125,
    "pet_fee": 0,
    "extra_guest_fee": 25,
    "min_nights_weekday": 2,
    "min_nights_weekend": 2,
    "weekly_discount_pct": 10,
    "monthly_discount_pct": 20,
    "projected_occupancy": 0.55,
    "projected_monthly_revenue": 2750,
    "projected_annual_revenue": 33000,
    "breakeven_occupancy": 0.25,
    "breakeven_rate": 95,
    "analysis": "3-5 paragraph comprehensive analysis...",
    "reasoning": "one-line summary",
    "recommendations": ["rec1", "rec2", "rec3"]
  },
  "seasonal": {
    "peak_months": ["June", "July", "August"],
    "peak_markup_pct": 40,
    "peak_rate": 231,
    "low_months": ["January", "February", "March"],
    "low_discount_pct": 20,
    "low_rate": 132,
    "orphan_day_discount_pct": 15,
    "last_minute_discount_pct": 10,
    "early_bird_discount_pct": 5
  },
  "pricelabs": {
    "base_price": 165,
    "min_price": 107,
    "max_price": 300,
    "setup_steps": ["step 1", "step 2", "step 3"],
    "action_items": [
      {"setting": "Base Price", "current": "$240", "recommended": "$165", "reason": "...", "priority": 1}
    ],
    "group_strategy_note": "If in a group, consider..."
  },
  "optimization": {
    "quick_wins": ["win1", "win2", "win3"],
    "ninety_day_plan": "paragraph...",
    "occupancy_improvements": [
      {"action": "...", "expected_impact": "+5% occ", "priority": 1, "timeframe": "1-2 weeks"}
    ],
    "revenue_increase_pct": 15,
    "target_monthly_revenue": 3100,
    "listing_health": {
      "score": 78,
      "photos_score": 80,
      "description_score": 70,
      "amenities_score": 85,
      "suggestions": ["suggestion1", "suggestion2"]
    }
  },
  "strategy_summary": "2-3 sentence overall summary tying everything together"
}
```

### API Routes — Backward Compatible

**Keep all three existing routes working** but have them call the unified function:

```
POST /api/properties/:id/analyze          → generateUnifiedAnalysis(id, req, env)
POST /api/properties/:id/pl-strategy      → generateUnifiedAnalysis(id, req, env) (returns pl-focused subset)
POST /api/properties/:id/revenue-optimize → generateUnifiedAnalysis(id, req, env) (returns opt-focused subset)
```

Each route can extract and return the relevant subset of the unified result so existing frontend code doesn't break immediately. Then update the frontend to use the full result.

### Report Storage — Migration Safe

- Save unified result as `report_type = 'unified_analysis'` 
- ALSO save to `'pricing_analysis'`, `'pl_strategy'`, `'revenue_optimization'` for backward compatibility with existing `gatherPropertyContext()` cross-referencing and the pricing overview
- Old reports with old types remain readable — don't delete or migrate them
- `pricing_strategies` table: save 3 algorithmic + 1 AI strategy (same as current analyzePricing)

### Keep Algorithmic Strategies

`generateAlgorithmicStrategies()` (L4244 area) should remain unchanged — it generates the three non-AI strategies (Aggressive/Balanced/Premium) from comps and market data. The unified analysis replaces only the AI portion.

---

## Implementation Plan (Step by Step)

### Phase 1: Build the new function (backend only)
1. Read `gatherPropertyContext()` to understand the data shape
2. Read all three existing prompts side-by-side
3. Design the unified prompt combining the best elements from all three
4. Write `generateUnifiedAnalysis()` with the unified prompt + robust JSON parsing
5. Wire it to save to all necessary tables (pricing_strategies, analysis_reports)

### Phase 2: Update API routes
1. Update `/api/properties/:id/analyze` to call new function
2. Update `/api/properties/:id/pl-strategy` to call new function, return PL-focused shape
3. Update `/api/properties/:id/revenue-optimize` to call new function, return opt-focused shape
4. Update `autoAnalyzeProperties()` to call new function
5. **Test:** existing frontend should still work with the old response shapes

### Phase 3: Update frontend display
1. Update `renderStrategyCard()` to show peak/low with dollar amounts
2. Update PriceLabs panel to show setup steps from unified result
3. Update revenue optimization display
4. Add "consistency check" — flag when numbers don't match previous run by >20%
5. **Keep all three buttons working** but they all trigger the same unified analysis

### Phase 4: Clean up
1. Mark old functions as deprecated (don't delete yet — keep for reference)
2. Update DEPLOYMENTS.md
3. Run validate.js + audit.js

---

## Critical Rules (DO NOT VIOLATE)

1. **Never delete old `analysis_reports` data.** Old reports with `report_type = 'pricing_analysis'` etc. must remain readable.
2. **Keep all three API routes.** Frontend has three separate buttons — they must all work.
3. **Keep `generateAlgorithmicStrategies()` untouched.** The three non-AI strategies are deterministic and useful.
4. **Keep `gatherPropertyContext()` untouched.** It's the shared data layer and works correctly.
5. **Peak/Low season labels must show dollar amounts** ("+40% Peak → $231/nt") not just percentages.
6. **PriceLabs setup steps must always be visible** when available — they were getting lost before.
7. **Read actual code before writing.** Grep for function names, column names, return shapes. Don't guess.
8. **Run validate.js + audit.js before every tarball.**
9. **Bump version on every deployable change.**
10. **Test that `autoAnalyzeProperties()` still works** — it's called by the daily cron.

---

## Files That Will Change

| File | What Changes |
|------|-------------|
| `src/worker.js` | New `generateUnifiedAnalysis()`, update 3 route handlers, deprecate old functions |
| `frontend/parts/js/02-properties.js` | Update strategy card display, PL panel, rev opt display |
| `frontend/parts/js/12-pricelabs.js` | Update PL compare panel to use unified data |
| `frontend/parts/js/03-analysis.js` | Minor — analysis tab calls same route |
| `DEPLOYMENTS.md` | Version history, architecture notes |

### Files That Should NOT Change
- `frontend/parts/js/01-globals.js` (icons, auth, utilities)
- `frontend/parts/js/10-finances.js` (bill tracker)
- `frontend/parts/js/00-dashboard.js` (dashboard)
- `validate.js`, `audit.js` (unless adding new checks)
- `build.js`, `wrangler.toml`
- Any other frontend files not listed above

---

## Current Version State

- **Version:** 2.36.1
- **Worker lines:** ~14,800
- **validate.js:** 26/26 passing
- **audit.js:** 14/14 passing, 0 errors, 33 warnings
- **Bill Tracker:** Fully built, own tab, 19-table cascade delete
- **Pricing Health Check:** Daily cron running
- **Auto-Analyze:** Daily, 3-tier priority
