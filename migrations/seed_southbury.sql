-- ============================================================
-- Seed: Southbury / Middletown CT — Full Circle Portfolio
-- ============================================================

-- Market snapshot — Southbury
INSERT OR IGNORE INTO market_snapshots (city, state, avg_daily_rate, median_daily_rate, top10_daily_rate, top25_daily_rate, bottom25_daily_rate, avg_occupancy, peak_occupancy, low_occupancy, avg_annual_revenue, peak_month, low_month, active_listings, data_source)
VALUES ('Southbury', 'CT', 115, 100, 200, 150, 80, 0.50, 0.70, 0.30, NULL, 'July', 'January', NULL, 'manual_research');

-- Market snapshot — Middletown
INSERT OR IGNORE INTO market_snapshots (city, state, avg_daily_rate, median_daily_rate, top10_daily_rate, top25_daily_rate, bottom25_daily_rate, avg_occupancy, peak_occupancy, low_occupancy, avg_annual_revenue, peak_month, low_month, active_listings, data_source)
VALUES ('Middletown', 'CT', 143, 143, NULL, 175, 119, 0.53, NULL, NULL, NULL, NULL, NULL, NULL, 'airdna');

-- ── Apt 101 ──
INSERT OR IGNORE INTO properties (address, city, state, zip, property_type, bedrooms, bathrooms, sqft, year_built, listing_status)
VALUES ('1455 Southford Rd Apt 101', 'Southbury', 'CT', '06488', 'apartment', 1, 1, 1000, NULL, 'active');

INSERT OR IGNORE INTO property_amenities (property_id, amenity_id)
SELECT (SELECT id FROM properties WHERE address = '1455 Southford Rd Apt 101'), id
FROM amenities WHERE name IN ('Pool Table', 'Lake / Pond View', 'Smart TV / Streaming', 'Full Kitchen', 'Washer / Dryer', 'High-Speed WiFi', 'A/C - Central');

-- ── Apt 102 ──
INSERT OR IGNORE INTO properties (address, city, state, zip, property_type, bedrooms, bathrooms, sqft, year_built, listing_status)
VALUES ('1455 Southford Rd Apt 102', 'Southbury', 'CT', '06488', 'apartment', 1, 1, 800, NULL, 'active');

INSERT OR IGNORE INTO property_amenities (property_id, amenity_id)
SELECT (SELECT id FROM properties WHERE address = '1455 Southford Rd Apt 102'), id
FROM amenities WHERE name IN ('Pet Friendly', 'Smart TV / Streaming', 'Full Kitchen', 'Washer / Dryer', 'High-Speed WiFi', 'A/C - Central');

-- ── Apt 103 ──
INSERT OR IGNORE INTO properties (address, city, state, zip, property_type, bedrooms, bathrooms, sqft, year_built, listing_status)
VALUES ('1455 Southford Rd Apt 103', 'Southbury', 'CT', '06488', 'apartment', 1, 1, 850, NULL, 'active');

INSERT OR IGNORE INTO property_amenities (property_id, amenity_id)
SELECT (SELECT id FROM properties WHERE address = '1455 Southford Rd Apt 103'), id
FROM amenities WHERE name IN ('Smart TV / Streaming', 'Full Kitchen', 'Washer / Dryer', 'High-Speed WiFi', 'A/C - Central');

-- ── Apt 104 (new listing, no reviews) ──
INSERT OR IGNORE INTO properties (address, city, state, zip, property_type, bedrooms, bathrooms, sqft, year_built, listing_status)
VALUES ('1455 Southford Rd Apt 104', 'Southbury', 'CT', '06488', 'apartment', 1, 1, NULL, NULL, 'active');

INSERT OR IGNORE INTO property_amenities (property_id, amenity_id)
SELECT (SELECT id FROM properties WHERE address = '1455 Southford Rd Apt 104'), id
FROM amenities WHERE name IN ('Smart TV / Streaming', 'Full Kitchen', 'Washer / Dryer', 'High-Speed WiFi', 'A/C - Central');

-- ── Studio Retreat ──
INSERT OR IGNORE INTO properties (address, city, state, zip, property_type, bedrooms, bathrooms, sqft, year_built, listing_status)
VALUES ('1455 Southford Rd Studio', 'Southbury', 'CT', '06488', 'studio', 0, 1, NULL, NULL, 'active');

INSERT OR IGNORE INTO property_amenities (property_id, amenity_id)
SELECT (SELECT id FROM properties WHERE address = '1455 Southford Rd Studio'), id
FROM amenities WHERE name IN ('Garden / Yard', 'Smart TV / Streaming', 'High-Speed WiFi');

-- ── Bell Tent ──
INSERT OR IGNORE INTO properties (address, city, state, zip, property_type, bedrooms, bathrooms, sqft, year_built, listing_status)
VALUES ('1455 Southford Rd Bell Tent', 'Southbury', 'CT', '06488', 'glamping', 1, 0, NULL, NULL, 'active');

INSERT OR IGNORE INTO property_amenities (property_id, amenity_id)
SELECT (SELECT id FROM properties WHERE address = '1455 Southford Rd Bell Tent'), id
FROM amenities WHERE name IN ('Glamping / Unique Structure', 'Garden / Yard', 'Fire Pit');

-- ── Middletown (potential) ──
INSERT OR IGNORE INTO properties (address, city, state, zip, property_type, bedrooms, bathrooms, sqft, year_built, purchase_price, listing_status)
VALUES ('195 Liberty St', 'Middletown', 'CT', '06457', 'single_family', 3, 1, 1200, NULL, 277500, 'draft');

-- ── Competitor data for Southbury ──
INSERT OR IGNORE INTO comparables (property_id, source, title, host_name, bedrooms, bathrooms, sleeps, nightly_rate, cleaning_fee, total_for_one_night, rating, review_count, superhost)
SELECT p.id, 'airbnb', 'Cozy Apartment Centrally Located in Southbury', 'Charles', 1, 1, 4, 100, 0, 100, 4.97, 78, 1
FROM properties p WHERE p.address = '1455 Southford Rd Apt 101';
