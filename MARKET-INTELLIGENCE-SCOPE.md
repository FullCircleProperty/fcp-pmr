# Market Intelligence Overhaul — Full Scope (Tiers 1-3)

## The Problem We're Solving
"What's happening in my markets and should I change anything?"
"Where should I invest next?"
"How do my properties compare to the competition?"

## What Exists Today
- Market tab with city search, STR/LTR toggle, manual snapshot entry
- Watchlist with tier-based monitoring (weekly/bi-weekly/monthly) — cron NOT wired
- `master_listings` table: crawled STR listings (platform, title, price, beds, baths, location, ratings)
- `market_snapshots`: point-in-time data pulls (avg rate, median, occupancy, listing count)
- `market_seasonality`: per-city monthly multipliers from reservation data
- `market_insights`: AI analysis history per city
- PriceLabs gives us: your occupancy vs market occupancy (7/30/60 day)
- RentCast gives us: LTR rental rates, property values, AVM data
- Deep dive panel: shows snapshot history + AI analysis per city
- Market search: fetches listings from SearchAPI/Airbnb scraping

## Architecture Decision
The Market tab becomes a **research command center** with two modes:
1. **My Markets** — cities where you have properties (auto-populated)
2. **Research Markets** — cities you're exploring for investment

Both use the same market profile infrastructure.

---

## TIER 1: Per-Market Profile Pages (data-driven, no AI cost)

### New table: `market_profiles`
```sql
CREATE TABLE market_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  -- STR landscape (from crawl data)
  str_listing_count INTEGER,
  str_avg_adr REAL,
  str_median_adr REAL,
  str_avg_occupancy REAL,
  str_avg_rating REAL,
  str_avg_reviews INTEGER,
  str_property_mix TEXT,        -- JSON: {house: 45%, condo: 30%, apt: 25%}
  str_bedroom_mix TEXT,         -- JSON: {1br: 20%, 2br: 35%, 3br: 30%, 4br: 15%}
  str_price_bands TEXT,         -- JSON: [{range:"$50-100", count:45}, ...]
  str_top_hosts TEXT,           -- JSON: [{name:"Host", listings:12, avg_rating:4.8}]
  str_superhost_pct REAL,
  -- LTR data (from RentCast)
  ltr_avg_rent REAL,
  ltr_median_rent REAL,
  ltr_active_listings INTEGER,
  -- Your performance in this market
  your_property_count INTEGER,
  your_avg_adr REAL,
  your_avg_occupancy REAL,
  your_total_revenue REAL,
  your_avg_rating REAL,
  -- Trend data
  adr_trend_3mo REAL,          -- % change over 3 months
  listing_count_trend_3mo REAL,
  new_listings_30d INTEGER,
  -- Seasonality
  peak_months TEXT,             -- JSON: [6,7,8]
  low_months TEXT,              -- JSON: [1,2,3]
  peak_multiplier REAL,
  -- Metadata
  last_updated TEXT DEFAULT (datetime('now')),
  UNIQUE(city, state)
);
```

### What the profile page shows:
1. **Header**: City, State + your property count there + watchlist tier
2. **Market Overview cards**: Listing count, Avg ADR, Occupancy, Avg Rating
3. **Your Performance vs Market**: side-by-side ADR, occupancy, revenue
4. **STR Landscape**:
   - Property type distribution (pie/bar)
   - Bedroom distribution
   - Price band histogram
   - Superhost % (competitive indicator)
5. **Seasonality chart**: monthly multipliers from `market_seasonality`
6. **Trend indicators**: ADR trending up/down, new listings entering market
7. **Your Properties in this market**: list with quick stats

### Data sources (all free/existing):
- `master_listings` → STR landscape stats
- `market_seasonality` → seasonal patterns  
- `pricelabs_listings` → your vs market occupancy
- `guesty_reservations` → your actual revenue/ADR
- `market_snapshots` → historical data points for trends

### Backend: `buildMarketProfile(city, state, env)`
Aggregates all existing data into `market_profiles`. Runs when:
- Clicking into a market profile
- After a crawl completes
- On intelligence rebuild

---

## TIER 2: Market Comparison View

### What it shows:
- Table/grid of all your markets side by side
- Columns: City, Your Properties, Your ADR, Market ADR, Your Occ, Market Occ, Revenue/Property, STR Count, Trend, Rating
- Color-coded: green when you're above market, red when below
- Sortable by any column
- "Opportunity Score" — composite metric:
  - High market ADR + low competition + your occ above market = strong
  - Declining market + increasing supply = warning

### This is purely frontend
All data comes from `market_profiles` table built in Tier 1. Just a different rendering.

---

## TIER 3: AI Market Narrative (premium, uses API credits)

### What AI adds:
- **Demand drivers**: "What brings people here?" — tourism, events, hospitals, universities, military bases, corporate offices
- **Regulatory landscape**: STR licensing, zoning restrictions, HOA prevalence, recent legislative changes
- **Investment thesis**: "Should you buy here?" — based on all data
- **Competitive positioning**: "Your 4BR at $180/nt is above the $150 median — sustainable because of your 4.9 rating and superhost status"
- **Actionable recommendations**: Specific pricing, amenity, and listing optimization suggestions per market

### Implementation:
- "Enrich Market" button per profile
- Feeds ALL Tier 1 data into a structured AI prompt
- AI response parsed into sections, stored in `market_profiles` JSON columns:
  - `ai_demand_drivers TEXT` — JSON array
  - `ai_regulatory_notes TEXT`
  - `ai_investment_thesis TEXT`
  - `ai_competitive_position TEXT`
  - `ai_recommendations TEXT` — JSON array
  - `ai_enriched_at TEXT`
- Cached — only re-runs when you click "Refresh AI Analysis"
- Shows enrichment date so you know how fresh the analysis is

### AI prompt structure:
```
You are an expert real estate market analyst. Analyze this market using the data provided.

MARKET: {city}, {state}
STR LANDSCAPE: {listing_count} active listings, ${avg_adr} avg ADR, {occupancy}% occupancy
PROPERTY MIX: {property_mix}
BEDROOM MIX: {bedroom_mix}  
PRICE BANDS: {price_bands}
SEASONALITY: Peak months: {peak_months} ({peak_multiplier}x), Low: {low_months}
TRENDS: ADR {adr_trend}% over 3mo, {new_listings} new listings in 30d
YOUR PORTFOLIO: {your_count} properties, ${your_adr} ADR, {your_occ}% occupancy

Return JSON with: demand_drivers[], regulatory_notes, investment_thesis, 
competitive_position, recommendations[], risk_factors[]
```

---

## UI/UX Plan

### Market tab becomes two-level:
1. **Market Grid** (landing page): cards for each market with key metrics
   - Auto-populated from property cities + watchlist
   - Click a card → opens profile page
   - "Compare Markets" button → comparison view
2. **Market Profile** (deep dive): full Tier 1-3 data for one market
3. **Market Comparison** (table view): all markets side by side

### Navigation:
- Back button returns to grid
- Profile page has tabs: Overview, STR Landscape, Your Performance, AI Analysis

---

## Implementation Order
1. `market_profiles` table + `buildMarketProfile()` aggregation function
2. Market profile API endpoint
3. Market grid landing page (cards)
4. Market profile page (Tier 1 — data only)
5. Market comparison view (Tier 2 — frontend only)
6. AI enrichment endpoint + prompt (Tier 3)
7. AI analysis display in profile page

---

## What This Enables
- Morning check: "Which markets need attention?"
- Investment research: "Is this new city worth entering?"
- Pricing confidence: "Am I above or below market? Is that sustainable?"
- Competitive awareness: "How many new listings entered my market?"
- Seasonal prep: "Peak season is 2 months out — am I priced right?"
