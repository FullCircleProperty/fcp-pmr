-- ============================================================
-- Full Circle Property Pricing Tool — D1 Schema
-- ============================================================

-- Core property table
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, -- owner of this property
  name TEXT,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT,
  county TEXT,
  latitude REAL,
  longitude REAL,

  -- Property details
  property_type TEXT DEFAULT 'single_family', -- single_family, condo, apartment, townhouse, glamping, studio
  bedrooms INTEGER NOT NULL DEFAULT 1,
  bathrooms REAL NOT NULL DEFAULT 1,
  sqft INTEGER,
  lot_acres REAL,
  year_built INTEGER,
  stories INTEGER DEFAULT 1,

  -- Purchase / value info
  purchase_price REAL,
  estimated_value REAL,
  annual_taxes REAL,
  hoa_monthly REAL DEFAULT 0,

  -- Listing status
  listing_status TEXT DEFAULT 'draft', -- draft, active, paused
  listing_url TEXT,
  image_url TEXT,
  unit_number TEXT,

  -- Ownership & expenses
  ownership_type TEXT DEFAULT 'purchased', -- purchased, rental
  monthly_mortgage REAL DEFAULT 0,
  monthly_insurance REAL DEFAULT 0,
  monthly_rent_cost REAL DEFAULT 0,
  security_deposit REAL DEFAULT 0,
  expense_electric REAL DEFAULT 0,
  expense_gas REAL DEFAULT 0,
  expense_water REAL DEFAULT 0,
  expense_internet REAL DEFAULT 0,
  expense_trash REAL DEFAULT 0,
  expense_other REAL DEFAULT 0,
  cleaning_fee REAL DEFAULT 0,

  -- Multi-family / building
  parent_id INTEGER,
  parking_spaces INTEGER,
  total_units_count INTEGER,
  parcel_id TEXT,
  zoning TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Amenities (many-to-many via junction)
CREATE TABLE IF NOT EXISTS amenities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL, -- outdoor, kitchen, entertainment, comfort, safety, accessibility, workspace, unique
  impact_score REAL DEFAULT 0  -- how much this amenity affects pricing (+/- percentage)
);

CREATE TABLE IF NOT EXISTS property_amenities (
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  amenity_id INTEGER NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
  notes TEXT,
  PRIMARY KEY (property_id, amenity_id)
);

-- Competitor / comparable listings
CREATE TABLE IF NOT EXISTS comparables (
  user_id INTEGER,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  comp_type TEXT DEFAULT 'str', -- str or ltr
  source TEXT NOT NULL, -- airbnb, vrbo, booking, rentcast, manual
  source_url TEXT,
  title TEXT,
  host_name TEXT,
  
  bedrooms INTEGER,
  bathrooms REAL,
  sleeps INTEGER,
  property_type TEXT,

  nightly_rate REAL,
  cleaning_fee REAL DEFAULT 0,
  service_fee REAL DEFAULT 0,
  total_for_one_night REAL,
  
  rating REAL,
  review_count INTEGER DEFAULT 0,
  superhost INTEGER DEFAULT 0,

  amenities_json TEXT, -- JSON array of amenity strings
  
  scraped_at TEXT DEFAULT (datetime('now'))
);

-- Market data snapshots (aggregated stats per area)
CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  rental_type TEXT DEFAULT 'str', -- str or ltr
  bedrooms INTEGER,
  property_type TEXT,
  
  avg_daily_rate REAL,
  median_daily_rate REAL,
  top10_daily_rate REAL,
  top25_daily_rate REAL,
  bottom25_daily_rate REAL,
  
  avg_occupancy REAL, -- as decimal 0-1
  peak_occupancy REAL,
  low_occupancy REAL,
  
  avg_annual_revenue REAL,
  peak_month TEXT,
  low_month TEXT,
  
  active_listings INTEGER,
  avg_review_score REAL,
  
  data_source TEXT, -- airdna, airroi, manual, rentcast
  snapshot_date TEXT DEFAULT (date('now'))
);

-- Pricing strategies (generated recommendations)
CREATE TABLE IF NOT EXISTS pricing_strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  
  strategy_name TEXT NOT NULL, -- e.g. 'aggressive_launch', 'premium_steady', 'seasonal_dynamic'
  
  base_nightly_rate REAL NOT NULL,
  weekend_rate REAL,
  
  cleaning_fee REAL DEFAULT 0,
  pet_fee REAL DEFAULT 0,
  
  weekly_discount REAL DEFAULT 0,   -- percentage
  monthly_discount REAL DEFAULT 0,  -- percentage
  
  peak_season_markup REAL DEFAULT 0,    -- percentage
  low_season_discount REAL DEFAULT 0,   -- percentage
  
  min_nights INTEGER DEFAULT 2,
  
  projected_occupancy REAL,         -- decimal
  projected_annual_revenue REAL,
  projected_monthly_avg REAL,
  
  reasoning TEXT,  -- AI or algorithm explanation
  ai_generated INTEGER DEFAULT 0,
  
  created_at TEXT DEFAULT (datetime('now'))
);

-- Tax configuration per county/state
CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  county TEXT,
  city TEXT,
  
  state_sales_tax REAL DEFAULT 0,
  county_surtax REAL DEFAULT 0,
  tourist_dev_tax REAL DEFAULT 0,
  other_tax REAL DEFAULT 0,
  total_tax_rate REAL GENERATED ALWAYS AS (state_sales_tax + county_surtax + tourist_dev_tax + other_tax) STORED,
  
  notes TEXT,
  updated_at TEXT DEFAULT (date('now'))
);

-- Uploaded images (stored as base64 in D1)
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data TEXT NOT NULL, -- base64 encoded
  size_bytes INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Master listings database (shared pool of all scraped/imported listings)
CREATE TABLE IF NOT EXISTS master_listings (
  user_id INTEGER,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL, -- airbnb, vrbo, booking, zillow, apartments, rentcast, manual
  listing_type TEXT DEFAULT 'str', -- str or ltr
  platform_id TEXT, -- platform-specific ID
  listing_url TEXT,
  title TEXT,
  description TEXT,
  host_name TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  address TEXT,
  latitude REAL,
  longitude REAL,
  bedrooms INTEGER,
  bathrooms REAL,
  sleeps INTEGER,
  sqft INTEGER,
  property_type TEXT,
  nightly_rate REAL,
  weekly_rate REAL,
  monthly_rate REAL,
  cleaning_fee REAL DEFAULT 0,
  service_fee REAL DEFAULT 0,
  rating REAL,
  review_count INTEGER DEFAULT 0,
  superhost INTEGER DEFAULT 0,
  amenities_json TEXT,
  photos_json TEXT,
  first_seen TEXT DEFAULT (datetime('now')),
  last_updated TEXT DEFAULT (datetime('now')),
  last_scraped TEXT,
  scrape_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  raw_data TEXT
);

CREATE INDEX IF NOT EXISTS idx_ml_city_state ON master_listings(city, state);
CREATE INDEX IF NOT EXISTS idx_ml_platform ON master_listings(platform, platform_id);
CREATE INDEX IF NOT EXISTS idx_ml_type ON master_listings(listing_type, city, state);

-- Data uploads / intelligence drops
CREATE TABLE IF NOT EXISTS data_uploads (
  user_id INTEGER,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_type TEXT NOT NULL, -- screenshot, csv, har, pdf, url_list, text
  filename TEXT,
  r2_key TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  status TEXT DEFAULT 'pending', -- pending, processing, complete, failed
  listings_extracted INTEGER DEFAULT 0,
  ai_summary TEXT,
  error_message TEXT,
  uploaded_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT
);

-- Crawl jobs
CREATE TABLE IF NOT EXISTS crawl_jobs (
  user_id INTEGER,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL, -- url_scrape, search_refresh, market_refresh, weekly_full
  status TEXT DEFAULT 'pending',
  target_url TEXT,
  target_city TEXT,
  target_state TEXT,
  target_platform TEXT,
  listings_found INTEGER DEFAULT 0,
  listings_updated INTEGER DEFAULT 0,
  listings_new INTEGER DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Property platform links (multi-platform pricing)
CREATE TABLE IF NOT EXISTS property_platforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- direct, airbnb, vrbo, booking, furnished_finder
  listing_url TEXT,
  platform_id TEXT,
  is_active INTEGER DEFAULT 1,
  
  nightly_rate REAL,
  weekly_rate REAL,
  monthly_rate REAL,
  cleaning_fee REAL DEFAULT 0,
  service_fee REAL DEFAULT 0,
  platform_fee_pct REAL DEFAULT 0,
  guest_fee_pct REAL DEFAULT 0,
  occupancy_tax_pct REAL DEFAULT 0,
  
  min_nights INTEGER,
  weekly_discount_pct REAL DEFAULT 0,
  monthly_discount_pct REAL DEFAULT 0,
  last_minute_discount_pct REAL DEFAULT 0,
  early_bird_discount_pct REAL DEFAULT 0,
  
  cancellation_policy TEXT,
  instant_book INTEGER DEFAULT 0,
  
  rating REAL,
  review_count INTEGER DEFAULT 0,
  
  last_scraped TEXT,
  raw_data TEXT,
  
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pp_property ON property_platforms(property_id);

-- PriceLabs integration
CREATE TABLE IF NOT EXISTS pricelabs_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  property_id INTEGER,
  pl_listing_id TEXT NOT NULL,
  pl_listing_name TEXT,
  pl_platform TEXT,
  pl_pms TEXT,
  base_price REAL,
  min_price REAL,
  currency TEXT DEFAULT 'USD',
  bedrooms INTEGER,
  last_synced TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(pl_listing_id)
);

CREATE TABLE IF NOT EXISTS pricelabs_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pl_listing_id TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  price REAL NOT NULL,
  min_stay INTEGER DEFAULT 1,
  is_available INTEGER DEFAULT 1,
  fetched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(pl_listing_id, rate_date)
);

CREATE INDEX IF NOT EXISTS idx_plr_listing ON pricelabs_rates(pl_listing_id);
CREATE INDEX IF NOT EXISTS idx_plr_date ON pricelabs_rates(rate_date);

-- ============================================================
-- Seed data: common amenities with impact scores
-- ============================================================

INSERT OR IGNORE INTO amenities (name, category, impact_score) VALUES
  -- Outdoor
  ('Private Pool', 'outdoor', 15.0),
  ('Heated Pool', 'outdoor', 18.0),
  ('Hot Tub / Spa', 'outdoor', 12.0),
  ('Outdoor Kitchen / Grill', 'outdoor', 8.0),
  ('Fire Pit', 'outdoor', 5.0),
  ('Patio / Deck', 'outdoor', 4.0),
  ('Screened Porch', 'outdoor', 6.0),
  ('Garden / Yard', 'outdoor', 3.0),
  ('Lake / Pond View', 'outdoor', 7.0),
  ('Ocean / Beach Access', 'outdoor', 25.0),
  ('Dock / Boat Access', 'outdoor', 15.0),
  ('Outdoor Shower', 'outdoor', 3.0),
  
  -- Kitchen
  ('Full Kitchen', 'kitchen', 5.0),
  ('Chef Kitchen / Premium Appliances', 'kitchen', 8.0),
  ('Coffee Machine / Espresso', 'kitchen', 2.0),
  ('Dishwasher', 'kitchen', 2.0),
  ('Ice Maker', 'kitchen', 1.5),
  
  -- Entertainment
  ('Pool Table', 'entertainment', 5.0),
  ('Game Room', 'entertainment', 7.0),
  ('Smart TV / Streaming', 'entertainment', 2.0),
  ('Board Games', 'entertainment', 1.0),
  ('Mini Golf', 'entertainment', 8.0),
  ('Arcade', 'entertainment', 6.0),
  
  -- Comfort
  ('King Bed (Primary)', 'comfort', 3.0),
  ('Memory Foam Mattresses', 'comfort', 2.0),
  ('In-law Suite / Guest Suite', 'comfort', 10.0),
  ('Multiple Living Areas', 'comfort', 5.0),
  ('Washer / Dryer', 'comfort', 3.0),
  ('A/C - Central', 'comfort', 2.0),
  ('Fireplace', 'comfort', 4.0),
  
  -- Safety
  ('Security System', 'safety', 2.0),
  ('Gated Community', 'safety', 5.0),
  ('Impact Windows', 'safety', 3.0),
  ('Smoke / CO Detectors', 'safety', 0.5),
  ('Fire Extinguisher', 'safety', 0.5),
  
  -- Workspace
  ('Dedicated Office / Workspace', 'workspace', 5.0),
  ('High-Speed WiFi', 'workspace', 3.0),
  
  -- Unique
  ('EV Charger', 'unique', 4.0),
  ('Sauna', 'unique', 8.0),
  ('Whole House Generator', 'unique', 3.0),
  ('Pet Friendly', 'unique', 6.0),
  ('Glamping / Unique Structure', 'unique', 12.0),
  ('Historic / Character Property', 'unique', 5.0);

-- ============================================================
-- Seed tax rates
-- ============================================================

INSERT OR IGNORE INTO tax_rates (state, county, city, state_sales_tax, county_surtax, tourist_dev_tax, notes) VALUES
  ('CT', 'New Haven', 'Southbury', 0.15, 0, 0, 'CT rooms tax 15% on stays under 30 days'),
  ('CT', 'Middlesex', 'Middletown', 0.15, 0, 0, 'CT rooms tax 15% on stays under 30 days'),
  ('FL', 'Martin', NULL, 0.06, 0.005, 0.05, 'FL 6% sales + 0.5% surtax + 5% TDT. No Airbnb collection agreement for TDT.');
