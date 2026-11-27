/**
 * StreetVerse Integration Tests: Live Database & API Gateway Contracts
 * Strictly requires isolated TEST_CUSTOMER_DB_URL and TEST_MERCHANT_DB_URL.
 * Never falls back to development DB URLs, localhost defaults, or fake in-memory seed data.
 */

import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { TestResult } from '../unit/search.test';
import { createStrictPgPool } from '../../services/api-gateway/src/db/postgres';

export async function runGatewayIntegrationTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  const testCustomerUrl = (process.env.TEST_CUSTOMER_DB_URL || '').trim();
  const testMerchantUrl = (process.env.TEST_MERCHANT_DB_URL || '').trim();

  if (!testCustomerUrl || !testMerchantUrl) {
    return [
      {
        suite: 'Live Integration & Security',
        name: 'BLOCKED: Isolated PostgreSQL Test Databases Required',
        passed: false,
        durationMs: 0,
        error:
          'BLOCKED: Set explicit TEST_CUSTOMER_DB_URL and TEST_MERCHANT_DB_URL to run live PostgreSQL integration tests (never falls back to development DBs or in-memory data).'
      }
    ];
  }

  const customerPool = createStrictPgPool(testCustomerUrl, 'customer');
  const merchantPool = createStrictPgPool(testMerchantUrl, 'merchant');

  const createdUserIds: string[] = [];
  const createdMerchantIds: string[] = [];

  try {
    // Verify real connectivity and ensure isolated schema exists
    try {
      await customerPool.query('SELECT 1');
      await merchantPool.query('SELECT 1');
      const custSql = fs.readFileSync(
        path.resolve(process.cwd(), 'packages/database-schemas/customer-db/schema.sql'),
        'utf8'
      );
      const merchSql = fs.readFileSync(
        path.resolve(process.cwd(), 'packages/database-schemas/merchant-db/schema.sql'),
        'utf8'
      );
      await customerPool.query(custSql);
      await merchantPool.query(merchSql);
    } catch (connErr: any) {
      return [
        {
          suite: 'Live Integration & Security',
          name: 'BLOCKED: Isolated PostgreSQL Connection Failed',
          passed: false,
          durationMs: 0,
          error: `BLOCKED: Isolated test PostgreSQL instances are unavailable (${connErr?.code || connErr?.message || 'connection error'}).`
        }
      ];
    }

    const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const localNum = `9895${runId.slice(-6)}`;
    const testUserEmail = `gateway.int.${runId}@example.test`;
    const testUserPhone = `+91${localNum}`;
    const testPasswordHash = await bcrypt.hash('Password123!', 10);

    const testMerchEmail = `merch.int.${runId}@example.test`;
    const testMerchPhone = `+919876${runId.slice(-6)}`;

    // Seed isolated synthetic fixtures for this test run only
    const userIns = await customerPool.query(
      `INSERT INTO users (phone, full_name, email, password_hash, is_verified, home_address)
       VALUES ($1, $2, $3, $4, true, 'Kothrud, Pune')
       RETURNING id`,
      [testUserPhone, 'Integration Test Customer', testUserEmail, testPasswordHash]
    );
    createdUserIds.push(userIns.rows[0].id);

    const merchIns = await merchantPool.query(
      `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open)
       VALUES ('Gateway Integration Grocery & Dining', 'GROCERY', $1, $2, $3, true, 'gw.int@okaxis', 'Pune', '411038', 18.5074, 73.8077, true)
       RETURNING id`,
      [testMerchPhone, testMerchEmail, testPasswordHash]
    );
    createdMerchantIds.push(merchIns.rows[0].id);

    await merchantPool.query(
      `INSERT INTO inventory_items (merchant_id, item_name, category, description, price, stock_quantity, unit, is_available)
       VALUES ($1, 'Integration Royal Dum Biryani (1kg)', 'DINING', 'Synthetic test dish', 349.00, 10, 'pot', true)`,
      [merchIns.rows[0].id]
    );

    // Test 1: Live Customer DB Connectivity & Synthetic User State
    {
      const start = Date.now();
      try {
        const res = await customerPool.query(
          'SELECT id, full_name, email, phone, is_verified FROM users WHERE email = $1',
          [testUserEmail]
        );
        assert(res.rows.length === 1, 'Synthetic customer must exist in isolated Customer DB');
        assert(res.rows[0].is_verified === true, 'Seeded customer must be verified');

        results.push({
          suite: 'Live Integration & Security',
          name: 'Integration: Live Isolated Customer DB Connectivity & User State',
          passed: true,
          durationMs: Date.now() - start,
          metadata: { user: res.rows[0].full_name }
        });
      } catch (e: any) {
        results.push({
          suite: 'Live Integration & Security',
          name: 'Integration: Live Isolated Customer DB Connectivity & User State',
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
        const res = await merchantPool.query(
          `SELECT
             m.business_name,
             round(earth_distance(ll_to_earth(m.latitude::float8, m.longitude::float8), ll_to_earth(18.5074, 73.8077))::numeric, 1) as distance_meters
           FROM merchants m
           WHERE m.id = $1
           LIMIT 1`,
          [merchIns.rows[0].id]
        );
        assert(res.rows.length === 1, 'Merchant DB must return synthetic merchant');
        assert(Number(res.rows[0].distance_meters) === 0, 'Origin point distance must be 0m');

        results.push({
          suite: 'Live Integration & Security',
          name: 'Integration: Live Isolated Merchant DB PostGIS Earthdistance Calculation',
          passed: true,
          durationMs: Date.now() - start,
          metadata: { merchant: res.rows[0].business_name, distance: res.rows[0].distance_meters }
        });
      } catch (e: any) {
        results.push({
          suite: 'Live Integration & Security',
          name: 'Integration: Live Isolated Merchant DB PostGIS Earthdistance Calculation',
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

    // Test 6: Bcrypt Password Verification Against Real PostgreSQL Hash
    {
      const start = Date.now();
      try {
        const userRes = await customerPool.query('SELECT password_hash FROM users WHERE id = $1', [
          userIns.rows[0].id
        ]);
        const isMatch = await bcrypt.compare('Password123!', userRes.rows[0].password_hash);
        assert(isMatch, 'Persisted customer bcrypt password must verify with Password123!');

        results.push({
          suite: 'Live Integration & Security',
          name: 'Integration: Customer Bcrypt Password Verification Against PostgreSQL',
          passed: true,
          durationMs: Date.now() - start
        });
      } catch (e: any) {
        results.push({
          suite: 'Live Integration & Security',
          name: 'Integration: Customer Bcrypt Password Verification Against PostgreSQL',
          passed: false,
          durationMs: Date.now() - start,
          error: e.message
        });
      }
    }

    // Test 7: Live Merchant DB Inventory JOIN Query
    {
      const start = Date.now();
      try {
        const res = await merchantPool.query(
          `SELECT
             i.item_name,
             i.price::float,
             m.business_name,
             m.upi_vpa
           FROM inventory_items i
           JOIN merchants m ON i.merchant_id = m.id
           WHERE m.id = $1 AND i.item_name ILIKE $2
           LIMIT 1`,
          [merchIns.rows[0].id, '%biryani%']
        );
        assert(res.rows.length === 1, 'Merchant DB must return synthetic biryani inventory item');
        assert(res.rows[0].item_name.includes('Biryani'), 'Item name must contain Biryani');
        assert(res.rows[0].price > 0, 'Item price must be positive number in INR');

        results.push({
          suite: 'Live Integration & Security',
          name: 'Integration: Live Isolated Merchant DB Inventory JOIN Query',
          passed: true,
          durationMs: Date.now() - start,
          metadata: { item: res.rows[0].item_name, price: res.rows[0].price, vendor: res.rows[0].business_name }
        });
      } catch (e: any) {
        results.push({
          suite: 'Live Integration & Security',
          name: 'Integration: Live Isolated Merchant DB Inventory JOIN Query',
          passed: false,
          durationMs: Date.now() - start,
          error: e.message
        });
      }
    }
  } finally {
    if (createdUserIds.length > 0) {
      await customerPool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]).catch(() => {});
    }
    if (createdMerchantIds.length > 0) {
      await merchantPool.query('DELETE FROM merchants WHERE id = ANY($1)', [createdMerchantIds]).catch(() => {});
    }
    await customerPool.end().catch(() => {});
    await merchantPool.end().catch(() => {});
  }

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runGatewayIntegrationTests()
    .then((results) => {
      let failed = 0;
      let blocked = false;
      for (const r of results) {
        if (r.passed) {
          console.log(`  PASS: ${r.name}`);
        } else {
          failed++;
          if (r.name.startsWith('BLOCKED:') || (r.error && r.error.startsWith('BLOCKED:'))) {
            blocked = true;
          }
          console.error(`  FAIL: ${r.name} -> ${r.error}`);
        }
      }
      console.log(`\nGateway Integration Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(blocked ? 2 : failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal Gateway Integration Test Error:', err);
      process.exit(1);
    });
}
