-- ============================================================
-- Seed: Palm City, FL — Market data from our research
-- ============================================================

-- Market snapshot (AirROI data)
INSERT OR IGNORE INTO market_snapshots (city, state, avg_daily_rate, median_daily_rate, top10_daily_rate, top25_daily_rate, bottom25_daily_rate, avg_occupancy, peak_occupancy, low_occupancy, avg_annual_revenue, peak_month, low_month, active_listings, data_source)
VALUES ('Palm City', 'FL', 252, 189, 452, 313, 124, 0.44, 0.643, 0.29, 31551, 'March', 'September', 55, 'airroi');

-- AirDNA data (slightly different)
INSERT OR IGNORE INTO market_snapshots (city, state, avg_daily_rate, median_daily_rate, top10_daily_rate, top25_daily_rate, bottom25_daily_rate, avg_occupancy, peak_occupancy, low_occupancy, avg_annual_revenue, peak_month, low_month, active_listings, data_source)
VALUES ('Palm City', 'FL', 305, NULL, NULL, NULL, NULL, 0.52, NULL, NULL, NULL, NULL, NULL, 118, 'airdna');

-- 868 SW Habitat Ln property
INSERT OR IGNORE INTO properties (address, city, state, zip, property_type, bedrooms, bathrooms, sqft, lot_acres, year_built, stories, purchase_price, estimated_value, annual_taxes, hoa_monthly)
VALUES ('868 SW Habitat Ln', 'Palm City', 'FL', '34990', 'single_family', 4, 4, 3096, 0.56, 2017, 1, 1388000, 1311900, 17159, 293);

-- Add amenities for 868 SW Habitat
INSERT OR IGNORE INTO property_amenities (property_id, amenity_id)
SELECT (SELECT id FROM properties WHERE address = '868 SW Habitat Ln'), id
FROM amenities WHERE name IN (
  'Heated Pool', 'Outdoor Kitchen / Grill', 'Fire Pit', 'Screened Porch',
  'Lake / Pond View', 'Chef Kitchen / Premium Appliances', 'Ice Maker',
  'Smart TV / Streaming', 'In-law Suite / Guest Suite', 'Washer / Dryer',
  'A/C - Central', 'Gated Community', 'Impact Windows', 'Dedicated Office / Workspace',
  'High-Speed WiFi', 'Outdoor Shower'
);
