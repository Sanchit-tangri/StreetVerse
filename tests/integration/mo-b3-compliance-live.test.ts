/**
 * StreetVerse MO-B3 Live PostgreSQL + Redis Compliance Integration Suite
 *
 * Runs strictly against disposable, dynamically ported Docker containers
 * (`pgvector/pgvector:pg16`, `postgres:16-alpine`, `redis:7-alpine`).
 * Never touches dev databases or volumes.
 *
 * Covers every MO-B3 Section 13 requirement live against PostgreSQL & Gateway:
 *   1. Migration (`005_mo_b3_store_compliance_enforcement.sql` + `applyMob3Migration`)
 *      is idempotent, parity-matches `schema.sql`, prevents warning deletion (`23514`),
 *      locks RESOLVED warnings (`23514`), and enforces DB `trg_merchants_block_open_when_suspended`.
 *   2. Store-specific warnings: independent per-store sequential numbering across multi-store
 *      owners, concurrent `Promise.all` warning issuance producing distinct `1, 2` sequence
 *      numbers without conflict, resolved warnings decrementing open counts cleanly without
 *      erasing numbers/history, unresolved warnings never expiring automatically, and derived
 *      overdue escalation tracking.
 *   3. STAFF blocked from reading/responding; cross-store Owner blocked; Owner responses
 *      keep warning OPEN & create `ADMIN` outbox notifications; only Admin resolves warnings.
 *   4. Ordinary suspension after repeated/overdue violations & immediate protective suspension
 *      for serious safety/fraud/legal risk without prior warnings; stores stay closed (`is_open=false`);
 *      Owner cannot reopen suspended store; Admin reactivation requires reviewed corrective
 *      evidence + reason, restores approved eligibility without auto-opening (`is_open=false`),
 *      preserves all old warnings & suspension history, and never affects Owner's other stores.
 */

import assert from 'assert';
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net, { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { createStrictPgPool, StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { migrateAndBackfillSellerIdentities } from '../../services/api-gateway/src/db/migrations/s14aSellerIdentityMigration';
import { applyMoaMigration } from '../../services/api-gateway/src/db/migrations/moaOnboardingMigration';
import { applyMob1Migration } from '../../services/api-gateway/src/db/migrations/mob1AdminMigration';
import { applyMob2Migration } from '../../services/api-gateway/src/db/migrations/mob2ReviewMigration';
import { applyMob3Migration } from '../../services/api-gateway/src/db/migrations/mob3ComplianceMigration';
import { SELLER_ACCOUNT_PRINCIPAL_TYPE } from '../../services/api-gateway/src/middleware/authJwt';
import { provisionAdminAccount } from '../../services/api-gateway/src/services/adminAuth';

const execFileAsync = promisify(execFile);
const RESERVED_PORTS = new Set([5432, 5433, 5434, 6379, 6380, 8000]);

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', args, { timeout: 60000, encoding: 'utf8' });
}

async function getFreePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as AddressInfo;
        srv.close((err) => (err ? reject(err) : resolve(addr.port)));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('Failed to allocate free port.');
}

async function waitForUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`${message}${lastErr instanceof Error ? ` (${lastErr.message})` : ''}`);
}

async function httpRequest(options: {
  port: number;
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; json: any; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        timeout: 10000,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }
            : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode || 0, json, body });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const PRE_MOA_BASE_MERCHANT_SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "cube";
CREATE EXTENSION IF NOT EXISTS "earthdistance";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_name VARCHAR(150) NOT NULL,
    category VARCHAR(50) NOT NULL,
    owner_phone VARCHAR(15) UNIQUE NOT NULL,
    owner_email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    is_verified BOOLEAN DEFAULT false,
    upi_vpa VARCHAR(100) NOT NULL,
    address TEXT NOT NULL,
    pincode VARCHAR(10) NOT NULL,
    latitude NUMERIC(10, 7) NOT NULL,
    longitude NUMERIC(10, 7) NOT NULL,
    is_open BOOLEAN DEFAULT true,
    rating NUMERIC(2, 1) DEFAULT 5.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inventory_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    item_name VARCHAR(200) NOT NULL,
    category VARCHAR(50) NOT NULL,
    description TEXT,
    price NUMERIC(10, 2) NOT NULL,
    stock_quantity INT NOT NULL DEFAULT 0,
    unit VARCHAR(20) DEFAULT 'pcs',
    is_available BOOLEAN DEFAULT true,
    embedding VECTOR(1536),
    last_restocked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS service_slots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    service_name VARCHAR(150) NOT NULL,
    slot_start TIMESTAMP WITH TIME ZONE NOT NULL,
    slot_end TIMESTAMP WITH TIME ZONE NOT NULL,
    capacity INT DEFAULT 1,
    booked_count INT DEFAULT 0,
    price NUMERIC(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'AVAILABLE',
    locked_until TIMESTAMP WITH TIME ZONE,
    locked_by_user_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
`;

async function runSuite() {
  const results: TestResult[] = [];
  const createdContainers: string[] = [];
  const pools: StrictPgPool[] = [];
  const shutdowns: Array<() => Promise<unknown>> = [];
  const tmpStorageDir = path.join(os.tmpdir(), `streetverse-mob3-live-storage-${Date.now()}`);
  const runId = crypto.randomBytes(4).toString('hex');

  const pgPass = `Mob3Pg_${runId}`;
  const redisPass = `Mob3Redis_${runId}`;
  const custContainer = `sv-mob3-cust-${runId}`;
  const merchContainer = `sv-mob3-merch-${runId}`;
  const freshMerchContainer = `sv-mob3-fresh-${runId}`;
  const redisContainer = `sv-mob3-redis-${runId}`;

  const runCase = async (name: string, fn: () => Promise<void>) => {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, durationMs: Date.now() - start });
    } catch (err) {
      results.push({
        name,
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.stack || err.message : String(err)
      });
    }
  };

  let custPool!: StrictPgPool;
  let merchPool!: StrictPgPool;
  let freshMerchPool!: StrictPgPool;
  let gwPort = 0;

  let admin1Id = '';
  let admin1Jwt = '';
  let owner1AcctId = '';
  let owner1Jwt = '';
  let staff1Jwt = '';
  let owner2Jwt = '';

  const store1Id = '90001111-1111-4111-8111-111111111101'; // Owner 1 Grocery (Approved)
  const store2Id = '90002222-2222-4222-8222-222222222202'; // Owner 1 Restaurant (Approved, same Owner!)
  const store3Id = '90003333-3333-4333-8333-333333333303'; // Owner 2 Pharmacy (Approved)

  try {
    const [custPort, merchPort, freshPort, redisPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
      getFreePort(),
      getFreePort()
    ]);

    await Promise.all([
      runDocker([
        'run', '-d', '--name', custContainer,
        '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', 'POSTGRES_DB=sv_cust',
        '-p', `127.0.0.1:${custPort}:5432`, 'postgres:16-alpine'
      ]),
      runDocker([
        'run', '-d', '--name', merchContainer,
        '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', 'POSTGRES_DB=sv_merch',
        '-p', `127.0.0.1:${merchPort}:5432`, 'pgvector/pgvector:pg16'
      ]),
      runDocker([
        'run', '-d', '--name', freshMerchContainer,
        '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', 'POSTGRES_DB=sv_fresh',
        '-p', `127.0.0.1:${freshPort}:5432`, 'pgvector/pgvector:pg16'
      ]),
      runDocker([
        'run', '-d', '--name', redisContainer,
        '-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--requirepass', redisPass
      ])
    ]);
    createdContainers.push(custContainer, merchContainer, freshMerchContainer, redisContainer);

    const custUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${custPort}/sv_cust`;
    const merchUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${merchPort}/sv_merch`;
    const freshUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${freshPort}/sv_fresh`;
    const redisUrl = `redis://:${redisPass}@127.0.0.1:${redisPort}`;

    await Promise.all([
      waitForUntil(() => runDocker(['exec', custContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_cust']).then(() => true), 30000, 300, 'Cust ready'),
      waitForUntil(() => runDocker(['exec', merchContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_merch']).then(() => true), 30000, 300, 'Merch ready'),
      waitForUntil(() => runDocker(['exec', freshMerchContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_fresh']).then(() => true), 30000, 300, 'Fresh ready'),
      waitForUntil(() => runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'ping']).then((r) => r.stdout.trim() === 'PONG'), 20000, 250, 'Redis ready')
    ]);

    custPool = createStrictPgPool(custUrl, 'customer');
    merchPool = createStrictPgPool(merchUrl, 'merchant');
    freshMerchPool = createStrictPgPool(freshUrl, 'merchant');
    pools.push(custPool, merchPool, freshMerchPool);

    await Promise.all([
      waitForUntil(async () => (await custPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Cust pool'),
      waitForUntil(async () => (await merchPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Merch pool'),
      waitForUntil(async () => (await freshMerchPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Fresh pool')
    ]);
    await delay(500);
    await Promise.all([
      waitForUntil(async () => (await custPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Cust stable'),
      waitForUntil(async () => (await merchPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Merch stable'),
      waitForUntil(async () => (await freshMerchPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Fresh stable')
    ]);

    const custSchemaSql = fs.readFileSync(path.resolve('packages/database-schemas/customer-db/schema.sql'), 'utf8');
    await custPool.query(custSchemaSql);

    // =====================================================================
    // CASE 1: MO-B3 Migration (005), Idempotency & Fresh schema.sql Parity
    // =====================================================================
    await runCase('MO-B3 migration (005) upgrades cleanly, is idempotent, and matches fresh schema.sql', async () => {
      await merchPool.query(PRE_MOA_BASE_MERCHANT_SQL);
      await merchPool.query(
        `INSERT INTO merchants (id, business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open)
         VALUES
           ($1, 'Owner1 Kirana Store', 'GROCERY', '+919877700001', 'owner1@example.test', 'h', false, 'k@ok', '1 MG Road, Pune', '411001', 18.52, 73.85, false),
           ($2, 'Owner1 Spice Bistro', 'RESTAURANT', '9877700001', 'OWNER1@example.test', 'h', false, 'b@ok', '2 FC Road, Pune', '411004', 18.53, 73.84, false),
           ($3, 'Owner2 Cure Pharmacy', 'PHARMACY', '+919877700002', 'owner2@example.test', 'h', false, 'p@ok', '3 Karve Rd, Pune', '411038', 18.51, 73.81, false)`,
        [store1Id, store2Id, store3Id]
      );
      await migrateAndBackfillSellerIdentities(merchPool);
      await applyMoaMigration(merchPool);
      await applyMob1Migration(merchPool);
      await applyMob2Migration(merchPool);

      const m1 = await applyMob3Migration(merchPool);
      const m2 = await applyMob3Migration(merchPool);
      assert(m1.applied && m2.applied, '005 applies idempotently');

      // Seed approved submissions + APPROVED status on Store 1, Store 2, Store 3 so reactivation tests eligibility restoration
      const o1Res = await merchPool.query(`SELECT id FROM seller_accounts WHERE LOWER(email) = 'owner1@example.test'`);
      owner1AcctId = String(o1Res.rows[0].id);
      const o2Res = await merchPool.query(`SELECT id FROM seller_accounts WHERE LOWER(email) = 'owner2@example.test'`);
      const owner2AcctId = String(o2Res.rows[0].id);
      await merchPool.query(`UPDATE seller_accounts SET is_email_verified = true WHERE id IN ($1, $2)`, [
        owner1AcctId,
        owner2AcctId
      ]);

      // Add Staff on Store 1
      const stfRes = await merchPool.query(
        `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
         VALUES ('+919877700003', 'staff1@example.test', 'h', true, 'ACTIVE') RETURNING id`
      );
      const staff1Id = String(stfRes.rows[0].id);
      await merchPool.query(
        `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status) VALUES ($1, $2, 'STAFF', 'ACTIVE')`,
        [staff1Id, store1Id]
      );

      for (const [sId, sOwnerId, bName, cat, addr, pin, lat, lng] of [
        [store1Id, owner1AcctId, 'Owner1 Kirana Store', 'GROCERY', '1 MG Road, Pune', '411001', 18.52, 73.85],
        [store2Id, owner1AcctId, 'Owner1 Spice Bistro', 'RESTAURANT', '2 FC Road, Pune', '411004', 18.53, 73.84],
        [store3Id, owner2AcctId, 'Owner2 Cure Pharmacy', 'PHARMACY', '3 Karve Rd, Pune', '411038', 18.51, 73.81]
      ] as const) {
        const subIns = await merchPool.query(
          `INSERT INTO store_kyc_submissions
             (merchant_id, submission_version, submitted_by_seller_account_id, status,
              business_name_snapshot, category_snapshot, business_type_snapshot,
              fixed_premises_confirmed_snapshot, address_snapshot, pincode_snapshot,
              latitude_snapshot, longitude_snapshot, submitted_at, reviewed_at)
           VALUES ($1, 1, $2, 'APPROVED', $3, $4, 'FIXED_SHOP', true, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id`,
          [sId, sOwnerId, bName, cat, addr, pin, lat, lng]
        );
        const subId = String(subIns.rows[0].id);
        await merchPool.query(
          `UPDATE store_onboarding_profiles
           SET status = 'APPROVED', current_submission_id = $1, approved_submission_id = $1,
               approved_address = $2, approved_pincode = $3, approved_latitude = $4, approved_longitude = $5,
               approved_at = CURRENT_TIMESTAMP
           WHERE merchant_id = $6`,
          [subId, addr, pin, lat, lng, sId]
        );
      }

      // Fresh schema.sql parity check
      const freshSchemaSql = fs.readFileSync(path.resolve('packages/database-schemas/merchant-db/schema.sql'), 'utf8');
      await freshMerchPool.query(freshSchemaSql);
      const freshWarnTbl = await freshMerchPool.query(`SELECT to_regclass('public.store_compliance_warnings') AS tbl`);
      assert(freshWarnTbl.rows[0].tbl !== null, 'Fresh schema.sql includes store_compliance_warnings');

      // Provision Admin 1
      const a1 = await provisionAdminAccount(merchPool, {
        email: `compliance.admin.${runId}@streetverse.ops`,
        fullName: 'Compliance Director',
        password: `Mob3Admin#${runId}!`
      });
      assert(a1.ok);
      admin1Id = a1.data.id;

      // Prepare JWTs for Owner 1, Staff 1, Owner 2
      const jwtSecret = `mob3-live-secret-${runId}-more-than-32-bytes!`;
      owner1Jwt = jwt.sign({ sub: owner1AcctId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, jwtSecret, {
        issuer: 'streetverse-api',
        audience: 'streetverse-seller',
        expiresIn: '1h'
      });
      staff1Jwt = jwt.sign({ sub: staff1Id, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, jwtSecret, {
        issuer: 'streetverse-api',
        audience: 'streetverse-seller',
        expiresIn: '1h'
      });
      owner2Jwt = jwt.sign({ sub: owner2AcctId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, jwtSecret, {
        issuer: 'streetverse-api',
        audience: 'streetverse-seller',
        expiresIn: '1h'
      });
    });

    const cfg: GatewayConfig = {
      nodeEnv: 'test',
      port: 0,
      allowedOrigins: ['http://127.0.0.1:3000'],
      jwtSecret: `mob3-live-secret-${runId}-more-than-32-bytes!`,
      jwtIssuer: 'streetverse-api',
      jwtBuyerAudience: 'streetverse-buyer',
      jwtSellerAudience: 'streetverse-seller',
      jwtAdminAudience: 'streetverse-admin',
      jwtExpiresIn: '1h',
      jwtAdminExpiresIn: '8h',
      redisUrl,
      customerDbUrl: custUrl,
      merchantDbUrl: merchUrl,
      aiEngineUrl: 'http://127.0.0.1:1',
      kycStorageDir: tmpStorageDir
    };

    const { server, shutdown } = createGatewayApp(cfg, {
      customerPool: custPool,
      merchantPool: merchPool,
      enableRedisAdapter: false
    });
    shutdowns.push(shutdown);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    gwPort = (server.address() as AddressInfo).port;

    const loginRes = await httpRequest({
      port: gwPort,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: `compliance.admin.${runId}@streetverse.ops`, password: `Mob3Admin#${runId}!` }
    });
    assert.strictEqual(loginRes.statusCode, 200);
    admin1Jwt = String(loginRes.json.token);

    // =====================================================================
    // CASE 2: Per-Store Warning Numbering, Concurrency, Deadlines, Response & Resolution
    // =====================================================================
    await runCase('Per-store concurrent warnings, independent store counts, deadlines/overdue, Staff rejection, and Admin resolution', async () => {
      // 1. Concurrent warning issuance on Store 1 produces distinct sequential warning numbers 1 & 2
      const deadlineFuture = new Date(Date.now() + 86_400_000).toISOString();
      const [cWarn1, cWarn2] = await Promise.all([
        httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store1Id}/compliance/warnings`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            violationCategory: 'HYGIENE_STANDARD',
            severity: 'LOW',
            reason: 'Cold display storage thermometer missing.',
            requiredCorrectiveAction: 'Install digital thermometer and submit reading.',
            correctiveDeadline: deadlineFuture,
            adminId: '00000000-0000-4000-8000-000000000000'
          }
        }),
        httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store1Id}/compliance/warnings`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            violationCategory: 'MISLEADING_LISTING',
            severity: 'MODERATE',
            reason: 'Pack weight mismatch on shelf label.',
            requiredCorrectiveAction: 'Update shelf weights to match sealed packets.',
            correctiveDeadline: deadlineFuture
          }
        })
      ]);
      assert.strictEqual(cWarn1.statusCode, 201);
      assert.strictEqual(cWarn2.statusCode, 201);
      const nums = [cWarn1.json.warning.warningNumber, cWarn2.json.warning.warningNumber].sort();
      assert.deepStrictEqual(nums, [1, 2], 'Concurrent warning issuance must assign unique sequential numbers 1 & 2');
      assert.strictEqual(cWarn1.json.warning.issuedByAdminId, admin1Id, 'Spoofed adminId ignored');

      const w1Id = cWarn1.json.warning.warningNumber === 1 ? cWarn1.json.warning.id : cWarn2.json.warning.id;
      const w2Id = cWarn1.json.warning.warningNumber === 2 ? cWarn1.json.warning.id : cWarn2.json.warning.id;

      // 2. Store 2 (same Owner 1!) starts independently at warningNumber = 1
      const s2Warn1 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store2Id}/compliance/warnings`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          violationCategory: 'OPERATIONAL_COMPLIANCE',
          severity: 'LOW',
          reason: 'Food prep zone barrier maintenance due.',
          requiredCorrectiveAction: 'Repair partition glass and upload proof.'
        }
      });
      assert.strictEqual(s2Warn1.statusCode, 201);
      assert.strictEqual(s2Warn1.json.warning.warningNumber, 1, 'Multi-store numbering resets independently per store');
      assert.strictEqual(s2Warn1.json.warningCounts.openOrdinaryWarnings, 1);

      // 3. STAFF and cross-store Owner blocked; Owner 1 responds twice to w1 cleanly without resolving it
      assert.strictEqual(
        (await httpRequest({ port: gwPort, method: 'GET', path: `/api/v1/seller/stores/${store1Id}/compliance`, headers: { Authorization: `Bearer ${staff1Jwt}` } })).statusCode,
        403
      );
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${store1Id}/compliance/warnings/${w1Id}/respond`,
          headers: { Authorization: `Bearer ${staff1Jwt}` },
          body: { responseMessage: 'Staff attempt' }
        })).statusCode,
        403
      );
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${store1Id}/compliance/warnings/${w1Id}/respond`,
          headers: { Authorization: `Bearer ${owner2Jwt}` },
          body: { responseMessage: 'Cross-owner attempt' }
        })).statusCode,
        403
      );

      for (const msg of ['First correction uploaded with log photo.', 'Second calibrated thermometer confirmation.']) {
        const respRes = await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${store1Id}/compliance/warnings/${w1Id}/respond`,
          headers: { Authorization: `Bearer ${owner1Jwt}` },
          body: {
            responseMessage: msg,
            evidenceReferences: [{ kind: 'LOG', referenceId: 'CAL-09', label: 'Calibration reading' }]
          }
        });
        assert.strictEqual(respRes.statusCode, 201);
        assert.strictEqual(respRes.json.warningStatus, 'OPEN');
      }

      const ownerCompliancePreResolve = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/seller/stores/${store1Id}/compliance`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(ownerCompliancePreResolve.json.warningCounts.openOrdinaryWarnings, 2);
      const w1View = ownerCompliancePreResolve.json.warnings.find((w: any) => w.id === w1Id);
      assert.strictEqual(w1View.responses.length, 2, 'Previous corrective responses preserved');

      // 4. Admin resolves w1 -> openOrdinaryWarnings decrements cleanly (2 -> 1); DELETE & reopen blocked by DB triggers
      const resolveW1 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/warnings/${w1Id}/resolve`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          reason: 'Verified temperature calibration evidence.',
          correctiveEvidenceChecked: true
        }
      });
      assert.strictEqual(resolveW1.statusCode, 200);
      assert.strictEqual(resolveW1.json.warning.status, 'RESOLVED');
      assert.strictEqual(resolveW1.json.warningCounts.openOrdinaryWarnings, 1, 'Resolved warnings no longer count');
      assert.strictEqual(resolveW1.json.warningCounts.resolvedWarnings, 1);

      let delBlocked = false;
      try {
        await merchPool.query(`DELETE FROM store_compliance_warnings WHERE id = $1`, [w1Id]);
      } catch (e: any) {
        delBlocked = e?.code === '23514';
      }
      assert(delBlocked, 'Trigger prevents deleting warnings');

      let reopenBlocked = false;
      try {
        await merchPool.query(`UPDATE store_compliance_warnings SET status = 'OPEN' WHERE id = $1`, [w1Id]);
      } catch (e: any) {
        reopenBlocked = e?.code === '23514';
      }
      assert(reopenBlocked, 'Trigger locks resolved warnings permanently');

      // 5. Simulate passed deadline on w2 -> warning NEVER auto-expires/auto-suspends, shows overdue & allows Admin escalation
      await merchPool.query(
        `UPDATE store_compliance_warnings SET corrective_deadline = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE id = $1`,
        [w2Id]
      );
      const overdueQueue = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: '/api/v1/admin/compliance/warnings?overdueOnly=true',
        headers: { Authorization: `Bearer ${admin1Jwt}` }
      });
      assert.strictEqual(overdueQueue.statusCode, 200);
      const w2Overdue = overdueQueue.json.warnings.find((w: any) => w.id === w2Id);
      assert(w2Overdue && w2Overdue.isOverdue === true && w2Overdue.status === 'OPEN', 'Overdue warning stays OPEN without auto-expiry');

      const escalateRes = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/warnings/${w2Id}/escalate`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: { notes: 'INTERNAL_ADMIN_ESCALATION_REVIEW: Deadline passed unaddressed.' }
      });
      assert.strictEqual(escalateRes.statusCode, 200);
      assert(escalateRes.json.warning.escalatedAt !== null);

      const ownerAfterEscalate = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/seller/stores/${store1Id}/compliance`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert(!ownerAfterEscalate.body.includes('INTERNAL_ADMIN_ESCALATION_REVIEW'), 'Internal escalation notes stay Admin-only');
    });

    // =====================================================================
    // CASE 3: Ordinary Suspension Thresholds -> Non-Openable DB Guard -> Warning Resolution & Admin Reactivation
    // =====================================================================
    await runCase('Ordinary suspension enforces >=2 OPEN warnings on same store, reactivation enforces warning resolution, and restores without auto-opening', async () => {
      // Right now Store 1 has w1 (RESOLVED) and w2 (OPEN & overdue).
      // 1) Proves 1 RESOLVED + 1 overdue OPEN on Store 1 MUST NOT permit ordinary suspension (409).
      const block1Resolved1Overdue = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/suspend`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          suspensionType: 'ORDINARY_VIOLATION',
          violationCategory: 'HYGIENE_STANDARD',
          reason: 'Should fail: only 1 OPEN (overdue) plus 1 RESOLVED warning on Store 1.'
        }
      });
      assert.strictEqual(
        block1Resolved1Overdue.statusCode,
        409,
        '1 RESOLVED + 1 overdue OPEN warning must NOT permit ordinary suspension'
      );

      // 2) Issue a 2nd OPEN ordinary warning on Store 2 (same Owner 1!):
      //    - Store 2 stays APPROVED (threshold does NOT auto-suspend)
      //    - Store 2 having 2 OPEN warnings does NOT satisfy Store 1's threshold (409 on Store 1)
      const s2Warn2 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store2Id}/compliance/warnings`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          violationCategory: 'DOCUMENT_DISCREPANCY',
          severity: 'MODERATE',
          reason: 'Menu allergen notice missing at entrance.',
          requiredCorrectiveAction: 'Post updated allergen chart.'
        }
      });
      assert.strictEqual(s2Warn2.statusCode, 201);
      assert.strictEqual(s2Warn2.json.warningCounts.openOrdinaryWarnings, 2);

      const store2PreSusp = await merchPool.query(`SELECT status FROM store_onboarding_profiles WHERE merchant_id = $1`, [store2Id]);
      assert.strictEqual(store2PreSusp.rows[0].status, 'APPROVED', 'Reaching 2 OPEN warnings never auto-suspends without explicit Admin decision');

      const blockCrossStoreCounts = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/suspend`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          suspensionType: 'ORDINARY_VIOLATION',
          violationCategory: 'HYGIENE_STANDARD',
          reason: 'Should fail: Store 2 open warnings must not count toward Store 1.'
        }
      });
      assert.strictEqual(
        blockCrossStoreCounts.statusCode,
        409,
        'Two OPEN warnings belonging to another store of the same Owner must NOT count'
      );

      // 3) Issue 2nd currently OPEN warning (#3 overall on Store 1) -> now Store 1 has 2 OPEN ordinary warnings (w2 & w3),
      //    permitting Admin to explicitly suspend Store 1 cleanly via ORDINARY_VIOLATION.
      const warn3 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/warnings`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          violationCategory: 'ORDER_FULFILLMENT',
          severity: 'HIGH',
          reason: 'Repeated unaddressed pack weight discrepancy complaints.',
          requiredCorrectiveAction: 'Audit scales and relabel SKUs.'
        }
      });
      assert.strictEqual(warn3.statusCode, 201);
      assert.strictEqual(warn3.json.warning.warningNumber, 3, 'Sequence preserves historical resolved warning #1 -> issues #3');
      const w3Id = warn3.json.warning.id;

      // Retrieve w2 ID on Store 1 cleanly
      const s1AdminView = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/admin/stores/${store1Id}/compliance`,
        headers: { Authorization: `Bearer ${admin1Jwt}` }
      });
      const w2Id = s1AdminView.json.warnings.find((w: any) => w.warningNumber === 2).id;

      const suspRes = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/suspend`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          suspensionType: 'ORDINARY_VIOLATION',
          violationCategory: 'ORDER_FULFILLMENT',
          reason: 'Two currently OPEN formal ordinary warnings on Store 1 after overdue escalation.',
          evidenceReferences: [{ kind: 'WARNING', referenceId: w3Id, label: 'Unresolved Warning #3' }]
        }
      });
      assert.strictEqual(suspRes.statusCode, 200);
      assert.strictEqual(suspRes.json.suspension.newStatus, 'SUSPENDED');
      assert.strictEqual(suspRes.json.suspension.isOpen, false);

      // Store 2 (same Owner 1!) MUST remain APPROVED cleanly
      const store2Status = await merchPool.query(`SELECT status FROM store_onboarding_profiles WHERE merchant_id = $1`, [store2Id]);
      assert.strictEqual(store2Status.rows[0].status, 'APPROVED', 'Owner other store unaffected by Store 1 suspension');

      // DB trigger forbids setting merchants.is_open = true while Store 1 is SUSPENDED
      let dbOpenBlocked = false;
      try {
        await merchPool.query(`UPDATE merchants SET is_open = true WHERE id = $1`, [store1Id]);
      } catch (e: any) {
        dbOpenBlocked = e?.code === '23514';
      }
      assert(dbOpenBlocked, 'PostgreSQL trigger blocks opening a SUSPENDED store');

      // Seller cannot update onboarding draft on SUSPENDED store
      const sellerDraftSuspended = await httpRequest({
        port: gwPort,
        method: 'PUT',
        path: `/api/v1/seller/stores/${store1Id}/onboarding`,
        headers: { Authorization: `Bearer ${owner1Jwt}` },
        body: { businessName: 'Trying bypass' }
      });
      assert.strictEqual(sellerDraftSuspended.statusCode, 403);

      // Owner submits corrective response on w2, w3 AND suspension response
      for (const [wid, msg] of [
        [w2Id, 'Updated all shelf weight labels cleanly.'],
        [w3Id, 'Calibrated digital scale and re-labeled inventory.']
      ] as const) {
        assert.strictEqual(
          (await httpRequest({
            port: gwPort,
            method: 'POST',
            path: `/api/v1/seller/stores/${store1Id}/compliance/warnings/${wid}/respond`,
            headers: { Authorization: `Bearer ${owner1Jwt}` },
            body: { responseMessage: msg, evidenceReferences: [{ kind: 'LOG', referenceId: 'FIX-01', label: 'Corrective log' }] }
          })).statusCode,
          201
        );
      }
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${store1Id}/compliance/suspension/respond`,
          headers: { Authorization: `Bearer ${owner1Jwt}` },
          body: { responseMessage: 'Full store audit complete and all corrective actions uploaded.' }
        })).statusCode,
        201
      );

      // Admin reactivation MUST STILL FAIL (409) while w2 & w3 are OPEN — even if evidenceReferences are provided!
      const blockedBypassWithRefs = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/reactivate`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          reason: 'Trying to reactivate with open warnings using evidence refs',
          correctiveEvidenceReviewed: true,
          evidenceReferences: [{ kind: 'INSPECTION', referenceId: 'BYPASS-CHK', label: 'Must not bypass OPEN warnings' }]
        }
      });
      assert.strictEqual(blockedBypassWithRefs.statusCode, 409, 'Admin evidenceReferences must NEVER bypass OPEN warnings');
      assert.strictEqual(blockedBypassWithRefs.json.code, 'UNRESOLVED_WARNINGS_REMAIN');

      // Admin formally resolves w2 via established /resolve endpoint; w3 still OPEN -> /reactivate still fails 409!
      const resolveW2 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/warnings/${w2Id}/resolve`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          reason: 'Verified updated shelf weight labels cleanly.',
          correctiveEvidenceChecked: true,
          evidenceReferences: [{ kind: 'INSPECTION', referenceId: 'W2-CHK', label: 'Shelf label photo verified' }]
        }
      });
      assert.strictEqual(resolveW2.statusCode, 200);

      const blockedOneOpenRemaining = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/reactivate`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          reason: 'Trying to reactivate while w3 still OPEN',
          correctiveEvidenceReviewed: true,
          evidenceReferences: [{ kind: 'INSPECTION', referenceId: 'REINSP-PARTIAL', label: 'Partial check' }]
        }
      });
      assert.strictEqual(blockedOneOpenRemaining.statusCode, 409, 'Store cannot reactivate while w3 remains OPEN');

      // Now Admin reactivates Store 1 atomically resolving the remaining open warning w3 with full audit/resolution detail
      const reactivateOk = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/reactivate`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          reason: 'Corrective actions verified via scale calibration and inspection.',
          correctiveEvidenceReviewed: true,
          evidenceReferences: [{ kind: 'INSPECTION', referenceId: 'REINSP-01', label: 'Verified re-inspection' }],
          warningResolutions: [
            {
              warningId: w3Id,
              reason: 'Digital scale calibration certificate verified during re-inspection.',
              correctiveEvidenceChecked: true,
              evidenceReferences: [{ kind: 'CERT', referenceId: 'SCALE-CERT-03', label: 'Scale calibration cert' }]
            }
          ]
        }
      });
      assert.strictEqual(reactivateOk.statusCode, 200);
      assert.strictEqual(reactivateOk.json.reactivation.restoredStatus, 'APPROVED');
      assert.strictEqual(reactivateOk.json.reactivation.isOpen, false, 'Reactivation NEVER auto-opens store');
      assert.deepStrictEqual(reactivateOk.json.reactivation.resolvedWarningIds, [w3Id]);

      // All old warnings (all 3 RESOLVED with Admin ID + reason + timestamp), suspension metadata, reactivation metadata,
      // audit events & outbox events preserved!
      const adminHistory = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/admin/stores/${store1Id}/compliance`,
        headers: { Authorization: `Bearer ${admin1Jwt}` }
      });
      assert.strictEqual(adminHistory.statusCode, 200);
      assert.strictEqual(adminHistory.json.warnings.length, 3, 'All historical warnings preserved');
      assert.strictEqual(adminHistory.json.warningCounts.openOrdinaryWarnings, 0, 'Zero OPEN warnings remain after reactivation');
      for (const w of adminHistory.json.warnings) {
        assert.strictEqual(w.status, 'RESOLVED');
        assert.strictEqual(w.resolvedByAdminId, admin1Id);
        assert(typeof w.resolutionReason === 'string' && w.resolutionReason.length >= 5);
        assert(w.resolvedAt !== null);
      }
      assert(adminHistory.json.complianceState.suspendedAt !== null, 'Suspension timestamp preserved in history');
      assert(adminHistory.json.complianceState.lastReactivatedAt !== null, 'Reactivation timestamp preserved');
      assert(adminHistory.json.auditEvents.some((e: any) => e.eventType === 'COMPLIANCE_STORE_SUSPENDED'));
      assert(adminHistory.json.auditEvents.some((e: any) => e.eventType === 'COMPLIANCE_WARNING_RESOLVED'));
      assert(adminHistory.json.auditEvents.some((e: any) => e.eventType === 'COMPLIANCE_STORE_REACTIVATED'));
      assert(adminHistory.json.notificationEvents.some((n: any) => n.eventType === 'COMPLIANCE_STORE_REACTIVATED'));
    });

    // =====================================================================
    // CASE 4: Immediate Protective Suspension (0 Prior Warnings) & Unapproved Store Reactivation Guard
    // =====================================================================
    await runCase('Immediate protective suspension enforces closed discovery on serious risk without 2 prior warnings and reactivates cleanly (never auto-approving unapproved stores)', async () => {
      // Simulate operating open Store 3 (zero prior warnings)
      await merchPool.query(`UPDATE merchants SET is_open = true WHERE id = $1`, [store3Id]);

      const immediateSusp = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store3Id}/compliance/suspend`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          suspensionType: 'PROTECTIVE_SERIOUS_RISK',
          violationCategory: 'IMMEDIATE_SAFETY_RISK',
          reason: 'Counterfeit / expired schedule-H medicines reported during spot check.',
          evidenceReferences: [{ kind: 'INSPECTION_CASE', referenceId: 'DRUG-INSP-88', label: 'Spot inspection report' }]
        }
      });
      assert.strictEqual(immediateSusp.statusCode, 200);
      assert.strictEqual(immediateSusp.json.suspension.newStatus, 'SUSPENDED');
      assert.strictEqual(immediateSusp.json.suspension.isOpen, false);

      // Verify DB is_open became false immediately while Store 2 stays untouched
      const s3Db = await merchPool.query(
        `SELECT m.is_open, p.status FROM merchants m JOIN store_onboarding_profiles p ON p.merchant_id = m.id WHERE m.id = $1`,
        [store3Id]
      );
      assert.strictEqual(s3Db.rows[0].is_open, false);
      assert.strictEqual(s3Db.rows[0].status, 'SUSPENDED');

      // Cannot reactivate before corrective evidence recorded
      const blockedEarlyReactivate = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store3Id}/compliance/reactivate`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: { reason: 'Trying without corrective evidence', correctiveEvidenceReviewed: true }
      });
      assert.strictEqual(blockedEarlyReactivate.statusCode, 409);

      // Owner submits corrective response -> Admin reactivates cleanly (remains closed until MO-C opens)
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${store3Id}/compliance/suspension/respond`,
          headers: { Authorization: `Bearer ${owner2Jwt}` },
          body: {
            responseMessage: 'Quarantined affected batch and submitted Drug Inspector clearance.',
            evidenceReferences: [{ kind: 'CLEARANCE', referenceId: 'DI-CLR-19', label: 'Drug Inspector clearance' }]
          }
        })).statusCode,
        201
      );

      const okReactivate3 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store3Id}/compliance/reactivate`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          reason: 'Drug Inspector clearance DI-CLR-19 verified cleanly.',
          correctiveEvidenceReviewed: true,
          evidenceReferences: [{ kind: 'CLEARANCE', referenceId: 'DI-CLR-19', label: 'Drug Inspector clearance' }]
        }
      });
      assert.strictEqual(okReactivate3.statusCode, 200);
      assert.strictEqual(okReactivate3.json.reactivation.restoredStatus, 'APPROVED');
      assert.strictEqual(okReactivate3.json.reactivation.isOpen, false);

      // Also verify a previously unapproved store (DRAFT, approved_submission_id IS NULL) suspended via protective risk
      // NEVER inherits APPROVED upon Admin reactivation and remains closed.
      const store4Id = '90004444-4444-4444-8444-444444444404';
      await merchPool.query(
        `INSERT INTO merchants (id, business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open)
         VALUES ($1, 'Unapproved Draft Mart', 'GROCERY', '+919877700004', 'owner4@example.test', 'h', false, 'd@ok', '4 JM Road, Pune', '411004', 18.52, 73.84, false)`,
        [store4Id]
      );
      await merchPool.query(
        `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
         VALUES ('+919877700004', 'owner4@example.test', 'h', true, 'ACTIVE') ON CONFLICT DO NOTHING`
      );
      const o4Res = await merchPool.query(`SELECT id FROM seller_accounts WHERE email = 'owner4@example.test'`);
      const o4AcctId = String(o4Res.rows[0].id);
      await merchPool.query(
        `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status) VALUES ($1, $2, 'OWNER', 'ACTIVE') ON CONFLICT DO NOTHING`,
        [o4AcctId, store4Id]
      );
      await merchPool.query(
        `INSERT INTO store_onboarding_profiles (merchant_id, business_name, category, status)
         VALUES ($1, 'Unapproved Draft Mart', 'GROCERY', 'DRAFT')`,
        [store4Id]
      );

      const susp4 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store4Id}/compliance/suspend`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          suspensionType: 'PROTECTIVE_SERIOUS_RISK',
          violationCategory: 'SUSPECTED_FRAUD',
          reason: 'Suspicious identity claim flagged during initial onboarding setup.',
          evidenceReferences: [{ kind: 'FRAUD_CASE', referenceId: 'FR-404', label: 'Onboarding fraud check' }]
        }
      });
      assert.strictEqual(susp4.statusCode, 200);

      const reactivate4 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store4Id}/compliance/reactivate`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          reason: 'False positive cleared; restore prior DRAFT onboarding status only.',
          correctiveEvidenceReviewed: true,
          evidenceReferences: [{ kind: 'CLEARANCE', referenceId: 'FR-CLR-404', label: 'Fraud false-positive clearance' }]
        }
      });
      assert.strictEqual(reactivate4.statusCode, 200);
      assert.strictEqual(reactivate4.json.reactivation.restoredStatus, 'DRAFT', 'Unapproved store NEVER inherits APPROVED');
      assert.strictEqual(reactivate4.json.reactivation.isOpen, false);
    });

    // =====================================================================
    // CASE 5: Deterministic Live PostgreSQL Concurrency & Serialization Audit
    // =====================================================================
    await runCase('Parent store lock serializes concurrent issue/reactivate, resolve/suspend, and isolates multi-store owners cleanly', async () => {
      const store5Id = '90005555-5555-4555-8555-555555555505'; // Owner 5 Store A (initially SUSPENDED with 0 warnings + suspension response)
      const store6Id = '90006666-6666-4666-8666-666666666606'; // Owner 5 Store B (same Owner 5, APPROVED)

      await merchPool.query(
        `INSERT INTO merchants (id, business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open)
         VALUES
           ($1, 'Concurrent Lock Store A', 'GROCERY', '+919877700005', 'owner5@example.test', 'h', false, 'a@ok', '5 JM Road, Pune', '411004', 18.52, 73.84, false),
           ($2, 'Concurrent Lock Store B', 'GROCERY', '+919877700006', 'owner5_alt@example.test', 'h', false, 'b@ok', '6 JM Road, Pune', '411004', 18.52, 73.85, false)`,
        [store5Id, store6Id]
      );
      await merchPool.query(
        `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
         VALUES ('+919877700005', 'owner5@example.test', 'h', true, 'ACTIVE') ON CONFLICT DO NOTHING`
      );
      const o5Res = await merchPool.query(`SELECT id FROM seller_accounts WHERE email = 'owner5@example.test'`);
      const owner5AcctId = String(o5Res.rows[0].id);
      const jwtSecret = `mob3-live-secret-${runId}-more-than-32-bytes!`;
      const owner5Jwt = jwt.sign({ sub: owner5AcctId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, jwtSecret, {
        issuer: 'streetverse-api',
        audience: 'streetverse-seller',
        expiresIn: '1h'
      });

      for (const sId of [store5Id, store6Id]) {
        await merchPool.query(
          `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status) VALUES ($1, $2, 'OWNER', 'ACTIVE') ON CONFLICT DO NOTHING`,
          [owner5AcctId, sId]
        );
        const subIns = await merchPool.query(
          `INSERT INTO store_kyc_submissions
             (merchant_id, submission_version, submitted_by_seller_account_id, status,
              business_name_snapshot, category_snapshot, business_type_snapshot,
              fixed_premises_confirmed_snapshot, address_snapshot, pincode_snapshot,
              latitude_snapshot, longitude_snapshot, submitted_at, reviewed_at)
           VALUES ($1, 1, $2, 'APPROVED', 'Concurrent Store', 'GROCERY', 'FIXED_SHOP', true, 'JM Road, Pune', '411004', 18.52, 73.84, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id`,
          [sId, owner5AcctId]
        );
        const subId = String(subIns.rows[0].id);
        await merchPool.query(
          `INSERT INTO store_onboarding_profiles
             (merchant_id, business_name, category, status, current_submission_id, approved_submission_id,
              approved_address, approved_pincode, approved_latitude, approved_longitude, approved_at)
           VALUES ($1, 'Concurrent Store', 'GROCERY', 'APPROVED', $2, $2, 'JM Road, Pune', '411004', 18.52, 73.84, CURRENT_TIMESTAMP)`,
          [sId, subId]
        );
      }

      // Suspend store5Id protectively & record Owner corrective response so reactivation would succeed absent a concurrent warning
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store5Id}/compliance/suspend`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            suspensionType: 'PROTECTIVE_SERIOUS_RISK',
            violationCategory: 'IMMEDIATE_SAFETY_RISK',
            reason: 'Initial serious protective suspension prior to concurrency test.',
            evidenceReferences: [{ kind: 'CASE', referenceId: 'CONC-5', label: 'Safety check 5' }]
          }
        })).statusCode,
        200
      );
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${store5Id}/compliance/suspension/respond`,
          headers: { Authorization: `Bearer ${owner5Jwt}` },
          body: { responseMessage: 'Submitted corrective mitigation plan for Store A.' }
        })).statusCode,
        201
      );

      // 1. Concurrent OPEN warning insertion MUST block/serialize against reactivation and prevent slipping through:
      const c1 = await merchPool.connect();
      let reactivatePromise!: Promise<{ statusCode: number; json: any; body: string }>;
      try {
        await c1.query('BEGIN');
        await c1.query(`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`, [store5Id]);

        let reactivateSettled = false;
        reactivatePromise = httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store5Id}/compliance/reactivate`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            reason: 'Attempt reactivation concurrently with new warning insertion',
            correctiveEvidenceReviewed: true
          }
        }).then((r) => {
          reactivateSettled = true;
          return r;
        });

        await delay(250);
        assert.strictEqual(reactivateSettled, false, 'reactivateMerchantStore must block on merchants parent FOR UPDATE lock');

        // Insert a brand-new OPEN warning inside held parent lock and COMMIT
        await c1.query(
          `INSERT INTO store_compliance_warnings
             (merchant_id, warning_number, violation_category, severity, is_formal_ordinary,
              reason, required_corrective_action, issued_by_admin_id, status)
           VALUES ($1, 1, 'HYGIENE_STANDARD', 'MODERATE', true, 'Concurrent violation spotted', 'Sanitize counter immediately', $2, 'OPEN')`,
          [store5Id, admin1Id]
        );
        await c1.query('COMMIT');
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c1.release();
      }

      const reactivateAfterConcurrentWarn = await reactivatePromise;
      assert.strictEqual(
        reactivateAfterConcurrentWarn.statusCode,
        409,
        'Concurrent OPEN warning committed before reactivation MUST cause 409 rejection'
      );
      assert.strictEqual(reactivateAfterConcurrentWarn.json?.code, 'UNRESOLVED_WARNINGS_REMAIN');
      const s5Prof = await merchPool.query(`SELECT status FROM store_onboarding_profiles WHERE merchant_id = $1`, [store5Id]);
      assert.strictEqual(s5Prof.rows[0].status, 'SUSPENDED', 'Store 5 remains cleanly SUSPENDED');

      // 2. While Store 5 is held locked in another transaction, Store 6 (same Owner 5!) MUST NOT block or share warning counts:
      const holdS5 = await merchPool.connect();
      try {
        await holdS5.query('BEGIN');
        await holdS5.query(`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`, [store5Id]);

        const s6w1 = await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store6Id}/compliance/warnings`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            violationCategory: 'HYGIENE_STANDARD',
            severity: 'LOW',
            reason: 'Store 6 independent warning #1 while Store 5 is locked',
            requiredCorrectiveAction: 'Submit cleaning checklist'
          }
        });
        assert.strictEqual(s6w1.statusCode, 201, 'Independent store warning succeeds immediately even while Store 5 locked');
        assert.strictEqual(s6w1.json.warning.warningNumber, 1, 'Store 6 numbering starts independently at 1');

        const s6w2 = await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store6Id}/compliance/warnings`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            violationCategory: 'DOCUMENT_DISCREPANCY',
            severity: 'MODERATE',
            reason: 'Store 6 independent warning #2',
            requiredCorrectiveAction: 'Update licence board'
          }
        });
        assert.strictEqual(s6w2.statusCode, 201);
        assert.strictEqual(s6w2.json.warningCounts.openOrdinaryWarnings, 2);

        // Owner 5 responds to s6w1 while Store 5 is still locked
        assert.strictEqual(
          (await httpRequest({
            port: gwPort,
            method: 'POST',
            path: `/api/v1/seller/stores/${store6Id}/compliance/warnings/${s6w1.json.warning.id}/respond`,
            headers: { Authorization: `Bearer ${owner5Jwt}` },
            body: { responseMessage: 'Submitted Store 6 cleaning checklist.' }
          })).statusCode,
          201
        );

        await holdS5.query('ROLLBACK');
      } finally {
        holdS5.release();
      }

      // 3. Concurrent warning resolution MUST prevent ordinary suspension from committing with only 1 OPEN warning:
      const s6Before = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/admin/stores/${store6Id}/compliance`,
        headers: { Authorization: `Bearer ${admin1Jwt}` }
      });
      const w6OneId = s6Before.json.warnings.find((w: any) => w.warningNumber === 1).id;

      const c2 = await merchPool.connect();
      let suspendPromise!: Promise<{ statusCode: number; json: any; body: string }>;
      try {
        await c2.query('BEGIN');
        await c2.query(`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`, [store6Id]);

        let suspendSettled = false;
        suspendPromise = httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store6Id}/compliance/suspend`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            suspensionType: 'ORDINARY_VIOLATION',
            violationCategory: 'HYGIENE_STANDARD',
            reason: 'Attempting ordinary suspension concurrently as warning #1 resolves'
          }
        }).then((r) => {
          suspendSettled = true;
          return r;
        });

        await delay(250);
        assert.strictEqual(suspendSettled, false, 'suspendMerchantStore must block on merchants parent FOR UPDATE lock');

        // Resolve w6OneId right before suspend threshold check runs
        await c2.query(
          `UPDATE store_compliance_warnings
           SET status = 'RESOLVED', resolved_by_admin_id = $1, resolved_at = CURRENT_TIMESTAMP,
               resolution_reason = 'Resolved concurrently prior to suspension', resolution_evidence_checked = true
           WHERE id = $2`,
          [admin1Id, w6OneId]
        );
        await c2.query('COMMIT');
      } catch (err) {
        await c2.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c2.release();
      }

      const suspendAfterResolve = await suspendPromise;
      assert.strictEqual(
        suspendAfterResolve.statusCode,
        409,
        'Concurrent warning resolution dropping OPEN count below 2 MUST prevent ordinary suspension'
      );
      assert.strictEqual(suspendAfterResolve.json?.code, 'PRIOR_WARNINGS_REQUIRED');
      const s6ProfMid = await merchPool.query(`SELECT status FROM store_onboarding_profiles WHERE merchant_id = $1`, [store6Id]);
      assert.strictEqual(s6ProfMid.rows[0].status, 'APPROVED', 'Store 6 remains APPROVED when only 1 OPEN warning remains');

      // 4. Issue warning #3 on Store 6 (now 2 OPEN ordinary warnings) & verify concurrent double-suspend + response/escalate/resolve contention have 0 deadlocks:
      const s6w3 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store6Id}/compliance/warnings`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          violationCategory: 'ORDER_FULFILLMENT',
          severity: 'MODERATE',
          reason: 'Store 6 independent warning #3 restoring 2 OPEN warnings',
          requiredCorrectiveAction: 'Confirm packaging weights'
        }
      });
      assert.strictEqual(s6w3.statusCode, 201);
      const w6ThreeId = s6w3.json.warning.id;

      // Parallel owner respond + admin escalate + admin resolve on w6ThreeId -> zero deadlocks/500s
      const raceOps = await Promise.all([
        httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${store6Id}/compliance/warnings/${w6ThreeId}/respond`,
          headers: { Authorization: `Bearer ${owner5Jwt}` },
          body: { responseMessage: 'Submitted packaging weights audit response.' }
        }),
        httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store6Id}/compliance/warnings/${w6ThreeId}/escalate`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: { notes: 'Concurrent escalation check during owner reply.' }
        }),
        httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store6Id}/compliance/suspend`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            suspensionType: 'ORDINARY_VIOLATION',
            violationCategory: 'ORDER_FULFILLMENT',
            reason: 'Concurrent suspend race #1 with two OPEN warnings on Store 6'
          }
        }),
        httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store6Id}/compliance/suspend`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            suspensionType: 'ORDINARY_VIOLATION',
            violationCategory: 'ORDER_FULFILLMENT',
            reason: 'Concurrent suspend race #2 with two OPEN warnings on Store 6'
          }
        })
      ]);

      for (const r of raceOps) {
        assert([200, 201, 409].includes(r.statusCode), `Expected clean serialized status without deadlock/500, got ${r.statusCode}: ${r.body}`);
      }
      const suspendCodes = [raceOps[2].statusCode, raceOps[3].statusCode].sort();
      assert.deepStrictEqual(suspendCodes, [200, 409], 'Concurrent suspensions on same store yield exactly one 200 and one 409');
    });
  } finally {
    await Promise.allSettled(shutdowns.map((fn) => fn()));
    await Promise.allSettled(pools.map((p) => p.end()));
    fs.rmSync(tmpStorageDir, { recursive: true, force: true });
    if (createdContainers.length > 0) {
      await runDocker(['rm', '-f', ...createdContainers]).catch(() => {});
    }
  }

  console.log('\n=== StreetVerse MO-B3 Live Compliance Integration Results ===');
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.name} (${r.durationMs}ms)`);
    if (r.error) console.log(`  -> ${r.error}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nSummary: ${passed}/${results.length} MO-B3 live scenarios passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

runSuite().catch((err) => {
  console.error('[MO-B3 Live Test Fatal Error]', err);
  process.exit(1);
});
