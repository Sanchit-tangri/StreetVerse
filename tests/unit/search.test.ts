/**
 * StreetVerse Unit Tests: Hyperlocal Discovery & Search Engine
 * Focus: Geospatial proximity calculations, keyword tokenization, 
 *        relevance scoring, multi-category ranking, and fallback synthesis.
 */

export interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  metadata?: any;
}

// 1. Great-circle distance calculator (Haversine formula in pure TypeScript for unit verification)
export function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c * 10) / 10; // meters rounded to 1 decimal
}

// 2. Keyword relevance scoring engine
export function computeRelevanceScore(
  query: string,
  itemName: string,
  category: string,
  vendorName: string,
  description?: string
): number {
  const q = query.trim().toLowerCase();
  const name = itemName.toLowerCase();
  const cat = category.toLowerCase();
  const vendor = vendorName.toLowerCase();
  const desc = (description || '').toLowerCase();

  if (name === q) return 1.0;
  if (name.includes(q)) return 0.98;
  if (cat.includes(q) || q.includes(cat)) return 0.92;
  if (vendor.includes(q)) return 0.88;
  if (desc.includes(q)) return 0.82;

  // Word token overlap
  const tokens = q.split(/\s+/).filter(Boolean);
  const matchCount = tokens.filter(
    (t) => name.includes(t) || cat.includes(t) || vendor.includes(t) || desc.includes(t)
  ).length;

  if (matchCount > 0) {
    return Math.min(0.85, 0.70 + (matchCount / tokens.length) * 0.15);
  }

  return 0.50; // Base baseline
}

// 3. Fallback catalog synthesizer
export function synthesizeFallbackResults(query: string, radiusKm: number, limit: number) {
  const catalog = [
    {
      item_name: 'Whole Wheat Brown Bread (400g)',
      category: 'GROCERY',
      business_name: 'Green Valley Daily Needs & Organic Grocery',
      price: 45,
      lat: 18.5074,
      lng: 73.8077
    },
    {
      item_name: 'Farm Fresh Organic Eggs (Pack of 6)',
      category: 'GROCERY',
      business_name: 'Green Valley Daily Needs & Organic Grocery',
      price: 60,
      lat: 18.5074,
      lng: 73.8077
    },
    {
      item_name: 'Pure Cow Milk (1 Litre)',
      category: 'GROCERY',
      business_name: 'Green Valley Daily Needs & Organic Grocery',
      price: 65,
      lat: 18.5074,
      lng: 73.8077
    },
    {
      item_name: 'Executive Haircut & Beard Grooming',
      category: 'SALON & SPA',
      business_name: 'Aura Unisex Neighborhood Salon',
      price: 250,
      lat: 18.5085,
      lng: 73.8055
    },
    {
      item_name: 'Skin Detox Facial & Hair Spa',
      category: 'SALON & SPA',
      business_name: 'Aura Unisex Neighborhood Salon',
      price: 650,
      lat: 18.5085,
      lng: 73.8055
    },
    {
      item_name: 'Digital Infrared Thermometer',
      category: 'PHARMACY',
      business_name: 'Apollo Lifecare Pharmacy',
      price: 850,
      lat: 18.506,
      lng: 73.809
    },
    {
      item_name: 'First Aid Emergency Care Kit',
      category: 'PHARMACY',
      business_name: 'Apollo Lifecare Pharmacy',
      price: 220,
      lat: 18.506,
      lng: 73.809
    }
  ];

  const q = query.toLowerCase().trim();
  const customerLat = 18.5074;
  const customerLng = 73.8077;

  return catalog
    .map((item) => {
      const distance = calculateHaversineDistance(customerLat, customerLng, item.lat, item.lng);
      const score = computeRelevanceScore(q, item.item_name, item.category, item.business_name);
      return {
        ...item,
        distance_meters: distance,
        relevance_score: score
      };
    })
    .filter((item) => item.distance_meters <= radiusKm * 1000)
    .sort((a, b) => b.relevance_score - a.relevance_score || a.distance_meters - b.distance_meters)
    .slice(0, limit);
}

export async function runSearchUnitTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  // Test 1: Geodesic Distance Accuracy
  {
    const start = Date.now();
    try {
      // Distance between Green Valley (18.5074, 73.8077) and Aura Salon (18.5085, 73.8055)
      const dist = calculateHaversineDistance(18.5074, 73.8077, 18.5085, 73.8055);
      // Expected ~262 meters (acceptable margin 250 - 275)
      assert(dist >= 250 && dist <= 275, `Distance must be ~262m, got ${dist}m`);

      // Zero-distance check (identical coordinates)
      const zeroDist = calculateHaversineDistance(18.5074, 73.8077, 18.5074, 73.8077);
      assert(zeroDist === 0, 'Distance between identical coordinates must be exactly 0');

      results.push({
        suite: 'Search Engine',
        name: 'Unit: Geospatial Haversine Great-Circle Proximity Calculation',
        passed: true,
        durationMs: Date.now() - start,
        metadata: { calculatedMeters: dist }
      });
    } catch (e: any) {
      results.push({
        suite: 'Search Engine',
        name: 'Unit: Geospatial Haversine Great-Circle Proximity Calculation',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 2: Keyword Tokenization & Relevance Ranking
  {
    const start = Date.now();
    try {
      const scoreExact = computeRelevanceScore(
        'bread',
        'Whole Wheat Brown Bread (400g)',
        'GROCERY',
        'Green Valley'
      );
      assert(scoreExact >= 0.95, `Exact keyword match in name must yield >= 0.95, got ${scoreExact}`);

      const scoreCategory = computeRelevanceScore('grocery', 'Milk', 'GROCERY', 'Green Valley');
      assert(scoreCategory >= 0.90, `Category match must yield >= 0.90, got ${scoreCategory}`);

      const scoreVendor = computeRelevanceScore('aura', 'Haircut', 'SALON', 'Aura Unisex Salon');
      assert(scoreVendor >= 0.85, `Vendor name match must yield >= 0.85, got ${scoreVendor}`);

      assert(scoreExact > scoreVendor, 'Item name match must rank higher than vendor name match');

      results.push({
        suite: 'Search Engine',
        name: 'Unit: Multi-Tiered Relevance Scoring Engine (Item, Category, Vendor)',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Search Engine',
        name: 'Unit: Multi-Tiered Relevance Scoring Engine (Item, Category, Vendor)',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 3: Radius Geofence Filtering
  {
    const start = Date.now();
    try {
      const within3km = synthesizeFallbackResults('bread', 3.0, 10);
      assert(within3km.length > 0, 'Results within 3km must not be empty for bread');
      assert(
        within3km.every((r) => r.distance_meters <= 3000),
        'All results must strictly respect the 3000m radius'
      );

      // Tight 100m radius check
      const tightRadius = synthesizeFallbackResults('pharmacy', 0.1, 10); // 100m radius
      // Pharmacy is 207m away, so at 100m it should be excluded
      assert(
        tightRadius.every((r) => r.distance_meters <= 100),
        'Tight 100m radius must strictly exclude out-of-boundary merchants'
      );

      results.push({
        suite: 'Search Engine',
        name: 'Unit: Dynamic Radius Geofence Boundary Enforcement (3km & 100m tests)',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Search Engine',
        name: 'Unit: Dynamic Radius Geofence Boundary Enforcement (3km & 100m tests)',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 4: Multi-Category Discovery (Products + Services)
  {
    const start = Date.now();
    try {
      const haircutResults = synthesizeFallbackResults('haircut', 5.0, 5);
      assert(haircutResults.length > 0, 'Haircut search must return results');
      assert(haircutResults[0].category === 'SALON & SPA', 'Haircut must match SALON & SPA category');
      assert(haircutResults[0].price === 250, 'Price must match catalog (250 INR)');

      const medResults = synthesizeFallbackResults('thermometer', 5.0, 5);
      assert(medResults.length > 0, 'Medical supply search must return pharmacy results');
      assert(medResults[0].category === 'PHARMACY', 'Must match PHARMACY category');

      results.push({
        suite: 'Search Engine',
        name: 'Unit: Cross-Domain Multi-Category Discovery (Retail Products & Salon Services)',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Search Engine',
        name: 'Unit: Cross-Domain Multi-Category Discovery (Retail Products & Salon Services)',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 5: Input Sanitization & Boundary Contracts
  {
    const start = Date.now();
    try {
      // Empty query fallback
      const emptyResults = synthesizeFallbackResults('', 5.0, 5);
      assert(emptyResults.length > 0, 'Empty query should safely return nearby shops rather than crashing');

      // Special characters & injection strings
      const specialQuery = synthesizeFallbackResults("'; DROP TABLE inventory; --", 5.0, 5);
      assert(Array.isArray(specialQuery), 'Special characters must return an array without crashing');

      // Zero or negative radius edge case
      const zeroRadius = synthesizeFallbackResults('bread', 0, 5);
      assert(zeroRadius.every((r) => r.distance_meters <= 0), 'Zero radius must only include 0m items');

      results.push({
        suite: 'Search Engine',
        name: 'Unit: Search Input Sanitization, SQL Boundary & Edge-Case Resilience',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Search Engine',
        name: 'Unit: Search Input Sanitization, SQL Boundary & Edge-Case Resilience',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  return results;
}

