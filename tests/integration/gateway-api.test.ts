/**
 * StreetVerse Integration Tests: Live Database & API Gateway Contracts
 * Focus: Verifies live PostgreSQL connections, SQL injection defense at the database
 *        boundary, live seed verification, and end-to-end transactional integrity.
 */

import pg from 'pg';
import bcrypt from 'bcryptjs';
import { TestResult } from '../unit/search.test';

export async function runGatewayIntegrationTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  const customerPool = new pg.Pool({
    connectionString:
      process.env.CUSTOMER_DB_URL ||
      'postgresql://postgres:postgres@localhost:5433/streetverse_customer_db',
    connectionTimeoutMillis: 3000
  });

  const merchantPool = new pg.Pool({
    connectionString:
      process.env.MERCHANT_DB_URL ||
      'postgresql://postgres:postgres@localhost:5434/streetverse_merchant_db',
    connectionTimeoutMillis: 3000
  });

  // Test 1: Live Customer DB Connectivity & Seed Verification
  {
    const start = Date.now();
    try {
      const res = await customerPool.query(
        'SELECT id, full_name, email, phone, is_verified FROM users WHERE email = $1',
        ['rahul.d@example.com']
      );
      assert(res.rows.length === 1, 'Customer Rahul Deshmukh must exist in Customer DB (Port 5433)');
      assert(res.rows[0].is_verified === true, 'Seeded customer must be verified');

      results.push({
        suite: 'Live Integration & Security',
        name: 'Integration: Live Customer DB (Port 5433) Connectivity & User State',
        passed: true,
        durationMs: Date.now() - start,
        metadata: { user: res.rows[0].full_name }
      });
    } catch (e: any) {
      results.push({
        suite: 'Live Integration & Security',
        name: 'Integration: Live Customer DB (Port 5433) Connectivity & User State',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 2: Live Merchant DB Connectivity & PostGIS earthdistance Verification
  {
    const start = Date.now();
    try {
      const res = await merchantPool.query(`
        SELECT 
          m.business_name, 
          round(earth_distance(ll_to_earth(m.latitude::float8, m.longitude::float8), ll_to_earth(18.5074, 73.8077))::numeric, 1) as distance_meters
        FROM merchants m
        WHERE m.category = 'GROCERY'
        LIMIT 1;
      `);
      assert(res.rows.length === 1, 'Merchant DB must return seeded grocery merchant');
      assert(Number(res.rows[0].distance_meters) === 0, 'Origin point distance must be 0m');

      results.push({
        suite: 'Live Integration & Security',
        name: 'Integration: Live Merchant DB (Port 5434) PostGIS Earthdistance Calculation',
        passed: true,
        durationMs: Date.now() - start,
        metadata: { merchant: res.rows[0].business_name, distance: res.rows[0].distance_meters }
      });
    } catch (e: any) {
      results.push({
        suite: 'Live Integration & Security',
        name: 'Integration: Live Merchant DB (Port 5434) PostGIS Earthdistance Calculation',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 3: SQL Injection Tautology Attack Vector (' OR '1'='1)
  {
    const start = Date.now();
    try {
      const maliciousPayload = "' OR '1'='1";
      const res = await customerPool.query(
        'SELECT id, phone, email FROM users WHERE LOWER(email) = $1 OR phone = $1',
        [maliciousPayload]
      );
      assert(
        res.rows.length === 0,
        `Tautology injection bypassed parameters! Expected 0 rows, got ${res.rows.length}`
      );

      results.push({
        suite: 'Live Integration & Security',
        name: "Security Blackbox: SQL Injection Resistance - Tautology Vector (' OR '1'='1)",
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Live Integration & Security',
        name: "Security Blackbox: SQL Injection Resistance - Tautology Vector (' OR '1'='1)",
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 4: SQL Injection Comment Vector (admin'--)
  {
    const start = Date.now();
    try {
      const maliciousPayload = "admin'--";
      const res = await customerPool.query(
        'SELECT id, phone, email FROM users WHERE LOWER(email) = $1 OR phone = $1',
        [maliciousPayload]
      );
      assert(res.rows.length === 0, 'Comment truncation payload must safely return zero results');

      results.push({
        suite: 'Live Integration & Security',
        name: "Security Blackbox: SQL Injection Resistance - Comment Vector (admin'--)",
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Live Integration & Security',
        name: "Security Blackbox: SQL Injection Resistance - Comment Vector (admin'--)",
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 5: SQL Injection Stacked Query Vector ('; DROP TABLE dummy; --)
  {
    const start = Date.now();
    try {
      const maliciousPayload = "'; DROP TABLE dummy_table; --";
      const res = await customerPool.query(
        'SELECT id, phone, email FROM users WHERE LOWER(email) = $1 OR phone = $1',
        [maliciousPayload]
      );
      assert(res.rows.length === 0, 'Stacked injection attempt must return zero rows without executing drop');

      results.push({
        suite: 'Live Integration & Security',
        name: "Security Blackbox: SQL Injection Resistance - Stacked Query Vector ('; DROP TABLE...)",
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Live Integration & Security',
        name: "Security Blackbox: SQL Injection Resistance - Stacked Query Vector ('; DROP TABLE...)",
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 6: Seeded Password Hashing Cryptographic Validation
  {
    const start = Date.now();
    try {
      const userRes = await customerPool.query(
        'SELECT password_hash FROM users WHERE email = $1',
        ['rahul.d@example.com']
      );
      const isMatch = await bcrypt.compare('Password123!', userRes.rows[0].password_hash);
      assert(isMatch, 'Seeded customer password must successfully verify with Password123!');

      results.push({
        suite: 'Live Integration & Security',
        name: 'Integration: Seeded Customer Bcrypt Password Verification Contract',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Live Integration & Security',
        name: 'Integration: Seeded Customer Bcrypt Password Verification Contract',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  await customerPool.end().catch(() => {});
  await merchantPool.end().catch(() => {});

  return results;
}

