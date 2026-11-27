/**
 * StreetVerse MO-A Live PostgreSQL + Redis + Filesystem Onboarding Integration Suite
 *
 * Validates against disposable, dynamically ported Docker containers (`pgvector/pgvector:pg16`,
 * `postgres:16-alpine`, `redis:7-alpine`) and real temporary private filesystem storage:
 *   1. Pre-migration Merchant DB -> MO-A migration (`002_merchant_onboarding_and_kyc.sql` + helper):
 *      preserves store UUIDs/inventory/slots, leaves legacy `merchants.is_verified=true` stores
 *      unapproved (`PENDING_SUBMISSION`) and closes unapproved discovery defaults (`is_open=false`),
 *      verifies idempotency across reruns, verifies fresh `schema.sql` parity, and proves
 *      atomic rollback via `MerchantOnboardingMigrationError` on conflicting data.
 *   2. Fresh Seller registration creates `merchants.is_open=false`, `is_verified=false`, and
 *      `store_onboarding_profiles` in `PENDING_SUBMISSION`.
 *   3. Multi-store Owner vs Staff vs Buyer vs Cross-Owner RBAC, real multipart file uploads
 *      (JPEG/PNG/PDF + spoofed/SVG/EXE/oversized/duplicate/max-5 photo quota enforcement),
 *      private non-static storage with SHA-256 checksums, authorised retrieval, and draft removal.
 *   4. Full category-aware submission (`PHARMACY` Drug License, `RESTAURANT` FSSAI License,
 *      `GROCERY` no forced GST), immutable `store_kyc_submissions` / `kyc_documents` DB triggers,
 *      resubmission from `REJECTED` / `MORE_INFO_REQUIRED` creating `v2` without mutating `v1`,
 *      and append-only `store_onboarding_audit_events`.
 *   5. Location-change re-verification (`APPROVED` store shifting address/GPS transitions to
 *      `REVERIFICATION_REQUIRED`, closes `is_open=false`, preserves `approved_*` history, requires
 *      fresh GPS + storefront photos + premises proof, and creates `v_next` without auto-approval).
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
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { createStrictPgPool, StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { migrateAndBackfillSellerIdentities } from '../../services/api-gateway/src/db/migrations/s14aSellerIdentityMigration';
import {
  applyMoaMigration,
  MerchantOnboardingMigrationError
} from '../../services/api-gateway/src/db/migrations/moaOnboardingMigration';
import { getApplicableRequirements } from '../../services/api-gateway/src/services/onboarding';
import { SELLER_ACCOUNT_PRINCIPAL_TYPE } from '../../services/api-gateway/src/middleware/authJwt';

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
  throw new Error('Failed to allocate isolated free port.');
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
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; json: any; raw: Buffer; body: string }> {
  return new Promise((resolve, reject) => {
    const payload =
      options.body === undefined
        ? undefined
        : Buffer.isBuffer(options.body)
          ? options.body
          : JSON.stringify(options.body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        timeout: 10000,
        headers: {
          ...(payload && !Buffer.isBuffer(options.body)
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }
            : payload
              ? { 'Content-Length': String(payload.length) }
              : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const body = raw.toString('utf8');
          let json: any = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, json, raw, body });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function buildMultipart(params: {
  fieldName: string;
  filename: string;
  mimeType: string;
  content: Buffer;
  extraFields?: Record<string, string>;
}): { contentType: string; body: Buffer } {
  const boundary = '----StreetVerseLiveBoundary' + crypto.randomBytes(6).toString('hex');
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(params.extraFields || {})) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8')
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${params.fieldName}"; filename="${params.filename}"\r\nContent-Type: ${params.mimeType}\r\n\r\n`,
      'utf8'
    )
  );
  parts.push(params.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

function makeJpeg(tag: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(`JPEG-${tag}`)]);
}
function makePng(tag: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`PNG-${tag}`)]);
}
function makePdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n%StreetVerse-${tag}\n%%EOF\n`, 'utf8');
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
  const tmpStorageDir = path.join(os.tmpdir(), `streetverse-moa-live-storage-${Date.now()}`);
  const runId = crypto.randomBytes(4).toString('hex');

  const pgPass = `MoaPg_${runId}`;
  const redisPass = `MoaRedis_${runId}`;
  const custContainer = `sv-moa-cust-${runId}`;
  const merchContainer = `sv-moa-merch-${runId}`;
  const freshMerchContainer = `sv-moa-fresh-${runId}`;
  const conflictMerchContainer = `sv-moa-conflict-${runId}`;
  const redisContainer = `sv-moa-redis-${runId}`;

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
  let conflictPool!: StrictPgPool;
  let redisUrl = '';
  let custUrl = '';
  let merchUrl = '';
  let cfg!: GatewayConfig;
  let gwPort = 0;

  let legacyPharmacyId = '';
  let legacyRestaurantId = '';
  let legacyOwnerAcctId = '';
  let staffAcctId = '';
  let owner2AcctId = '';
  let owner2GroceryId = '';
  let buyerAcctId = '';

  let owner1Jwt = '';
  let staffJwt = '';
  let owner2Jwt = '';
  let buyerJwt = '';
  let lastOtp = '';

  try {
    const [custPort, merchPort, freshPort, conflictPort, redisPort] = await Promise.all([
      getFreePort(),
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
        'run', '-d', '--name', conflictMerchContainer,
        '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', 'POSTGRES_DB=sv_conflict',
        '-p', `127.0.0.1:${conflictPort}:5432`, 'pgvector/pgvector:pg16'
      ]),
      runDocker([
        'run', '-d', '--name', redisContainer,
        '-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--requirepass', redisPass
      ])
    ]);
    createdContainers.push(custContainer, merchContainer, freshMerchContainer, conflictMerchContainer, redisContainer);

    custUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${custPort}/sv_cust`;
    merchUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${merchPort}/sv_merch`;
    const freshUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${freshPort}/sv_fresh`;
    const conflictUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${conflictPort}/sv_conflict`;
    redisUrl = `redis://:${redisPass}@127.0.0.1:${redisPort}`;

    await Promise.all([
      waitForUntil(() => runDocker(['exec', custContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_cust']).then(() => true), 30000, 300, 'Customer DB ready'),
      waitForUntil(() => runDocker(['exec', merchContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_merch']).then(() => true), 30000, 300, 'Merchant DB ready'),
      waitForUntil(() => runDocker(['exec', freshMerchContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_fresh']).then(() => true), 30000, 300, 'Fresh DB ready'),
      waitForUntil(() => runDocker(['exec', conflictMerchContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_conflict']).then(() => true), 30000, 300, 'Conflict DB ready'),
      waitForUntil(() => runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'ping']).then((r) => r.stdout.trim() === 'PONG'), 20000, 250, 'Redis ready')
    ]);

    custPool = createStrictPgPool(custUrl, 'customer');
    merchPool = createStrictPgPool(merchUrl, 'merchant');
    freshMerchPool = createStrictPgPool(freshUrl, 'merchant');
    conflictPool = createStrictPgPool(conflictUrl, 'merchant');
    pools.push(custPool, merchPool, freshMerchPool, conflictPool);

    // Wait until initial Docker PostgreSQL initdb restart completes and pools accept stable TCP connections
    await Promise.all([
      waitForUntil(async () => (await custPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Customer pool connect'),
      waitForUntil(async () => (await merchPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Merchant pool connect'),
      waitForUntil(async () => (await freshMerchPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Fresh pool connect'),
      waitForUntil(async () => (await conflictPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Conflict pool connect')
    ]);
    await delay(500);
    await Promise.all([
      waitForUntil(async () => (await custPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Customer pool stable'),
      waitForUntil(async () => (await merchPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Merchant pool stable'),
      waitForUntil(async () => (await freshMerchPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Fresh pool stable'),
      waitForUntil(async () => (await conflictPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Conflict pool stable')
    ]);

    // Prepare Customer DB
    const customerSchemaSql = fs.readFileSync(path.resolve('packages/database-schemas/customer-db/schema.sql'), 'utf8');
    await custPool.query(customerSchemaSql);
    const buyerIns = await custPool.query(
      `INSERT INTO users (phone, full_name, email, password_hash, is_verified)
       VALUES ('+919900000011', 'Buyer MO-A', 'buyer.moa@example.test', 'hash', true) RETURNING id`
    );
    buyerAcctId = String(buyerIns.rows[0].id);

    // =====================================================================
    // CASE 1: Legacy Migration, Fresh Schema Consistency, Idempotency & Conflict Rollback
    // =====================================================================
    await runCase('Schema & migration: applies cleanly, preserves UUIDs/FKs, closes unapproved stores, ignores legacy is_verified, is idempotent, and rolls back on conflicts', async () => {
      await merchPool.query(PRE_MOA_BASE_MERCHANT_SQL);

      const ownerPwHash = await bcrypt.hash('OwnerPass123!', 10);
      legacyPharmacyId = '55555555-5555-4555-8555-555555555501';
      legacyRestaurantId = '55555555-5555-4555-8555-555555555502';

      // Two legacy stores owned by same Seller Account, both with historical `is_verified=true` and `is_open=true`
      await merchPool.query(
        `INSERT INTO merchants (id, business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open)
         VALUES
           ($1, 'Legacy Care Pharmacy', 'PHARMACY', '+919811100001', 'owner1@example.test', $3, true, 'pharm@okaxis', 'Shop 1, MG Road, Pune', '411001', 18.5204, 73.8567, true),
           ($2, 'Legacy Spice Bistro', 'RESTAURANT', '9811100001', 'OWNER1@example.test', $3, true, 'bistro@okaxis', 'Shop 2, FC Road, Pune', '411004', 18.5289, 73.8415, true)`,
        [legacyPharmacyId, legacyRestaurantId, ownerPwHash]
      );

      await merchPool.query(
        `INSERT INTO inventory_items (merchant_id, item_name, category, price, stock_quantity)
         VALUES ($1, 'Paracetamol 500mg', 'PHARMACY', 30.00, 100)`,
        [legacyPharmacyId]
      );
      await merchPool.query(
        `INSERT INTO service_slots (merchant_id, service_name, slot_start, slot_end, price, status)
         VALUES ($1, 'Table Reservation', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 100.00, 'AVAILABLE')`,
        [legacyRestaurantId]
      );

      // Run S1.4-A first (creates seller_accounts + store_memberships)
      const s14a = await migrateAndBackfillSellerIdentities(merchPool);
      assert(s14a.sellerAccountsCreated === 1 && s14a.membershipsCreated === 2, 'S1.4-A backfill succeeded');

      const ownerRes = await merchPool.query(`SELECT id FROM seller_accounts WHERE LOWER(email) = 'owner1@example.test'`);
      legacyOwnerAcctId = String(ownerRes.rows[0].id);
      await merchPool.query(`UPDATE seller_accounts SET is_email_verified = true WHERE id = $1`, [legacyOwnerAcctId]);

      // Apply MO-A migration
      const moa1 = await applyMoaMigration(merchPool);
      assert(moa1.applied && moa1.profilesCreated === 2 && moa1.legacyStoresClosed === 2 && moa1.ignoredLegacyIsVerifiedCount === 2, 'First MO-A migration stats valid');

      // Existing UUIDs, inventory, slots intact; stores closed & PENDING_SUBMISSION (NEVER APPROVED!)
      const postStores = await merchPool.query(
        `SELECT m.id, m.is_open, m.is_verified, p.status, p.reverification_required, p.approved_submission_id
         FROM merchants m JOIN store_onboarding_profiles p ON p.merchant_id = m.id
         ORDER BY m.id`
      );
      assert.strictEqual(postStores.rows.length, 2);
      for (const s of postStores.rows) {
        assert.strictEqual(s.status, 'PENDING_SUBMISSION', 'Legacy store with is_verified=true must stay PENDING_SUBMISSION');
        assert.strictEqual(s.is_open, false, 'Legacy unapproved store must be closed (is_open=false)');
        assert.strictEqual(s.approved_submission_id, null);
      }
      const invCount = await merchPool.query(`SELECT count(*)::int AS c FROM inventory_items WHERE merchant_id = $1`, [legacyPharmacyId]);
      assert.strictEqual(invCount.rows[0].c, 1, 'Inventory FK intact');

      // Re-run MO-A migration -> idempotent
      const moa2 = await applyMoaMigration(merchPool);
      assert.strictEqual(moa2.profilesCreated, 0, 'Migration rerun must create 0 duplicate profiles');
      assert.strictEqual(moa2.legacyStoresClosed, 0, 'Migration rerun must close 0 additional stores');

      const auditRows = await merchPool.query(`SELECT event_type FROM store_onboarding_audit_events`);
      assert.strictEqual(auditRows.rows.length, 2, 'Exactly 2 initialization audit events across reruns');

      // Verify append-only audit rule ignores DELETE / UPDATE
      await merchPool.query(`DELETE FROM store_onboarding_audit_events`);
      const afterAuditDelete = await merchPool.query(`SELECT count(*)::int AS c FROM store_onboarding_audit_events`);
      assert.strictEqual(afterAuditDelete.rows[0].c, 2, 'Audit log must ignore DELETE');

      // Fresh install schema.sql parity test
      const freshSchemaSql = fs.readFileSync(path.resolve('packages/database-schemas/merchant-db/schema.sql'), 'utf8');
      await freshMerchPool.query(freshSchemaSql);
      const freshReqCount = await freshMerchPool.query(`SELECT count(*)::int AS c FROM kyc_document_requirements`);
      const migReqCount = await merchPool.query(`SELECT count(*)::int AS c FROM kyc_document_requirements`);
      assert.strictEqual(freshReqCount.rows[0].c, migReqCount.rows[0].c, 'Fresh schema and migration seed identical requirement catalogue');

      // Conflict DB rollback check
      await conflictPool.query(PRE_MOA_BASE_MERCHANT_SQL);
      const s14aSql = fs.readFileSync(path.resolve('packages/database-schemas/merchant-db/migrations/001_s1_4_a_seller_accounts_and_memberships.sql'), 'utf8');
      await conflictPool.query(s14aSql);
      await conflictPool.query(
        `INSERT INTO merchants (id, business_name, category, owner_phone, owner_email, upi_vpa, address, pincode, latitude, longitude)
         VALUES ('66666666-6666-4666-8666-666666666601', 'Bad Geo Store', 'GROCERY', '+919822200001', 'bad@example.test', 'b@ok', 'Pune', '411038', 95.0, 73.8)`
      );
      let threwConflict = false;
      try {
        await applyMoaMigration(conflictPool);
      } catch (err) {
        threwConflict = err instanceof MerchantOnboardingMigrationError && err.conflicts.some((c) => c.code === 'INVALID_MERCHANT_COORDINATES');
      }
      assert(threwConflict, 'Conflicting/invalid merchant coordinates must throw MerchantOnboardingMigrationError');
      const rolledBackCheck = await conflictPool.query(`SELECT to_regclass('public.store_onboarding_profiles') AS tbl`);
      assert.strictEqual(rolledBackCheck.rows[0].tbl, null, 'Conflict migration must roll back DDL cleanly');
    });

    // Provision Staff on Store 1 (Pharmacy) and second Owner on Store 3 (Grocery via live register)
    const staffIns = await merchPool.query(
      `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
       VALUES ('+919811100002', 'staff1@example.test', 'hash', true, 'ACTIVE') RETURNING id`
    );
    staffAcctId = String(staffIns.rows[0].id);
    await merchPool.query(
      `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status)
       VALUES ($1, $2, 'STAFF', 'ACTIVE')`,
      [staffAcctId, legacyPharmacyId]
    );

    cfg = {
      nodeEnv: 'test',
      port: 0,
      allowedOrigins: ['http://127.0.0.1:3000'],
      jwtSecret: `moa-live-test-secret-${runId}-more-than-32-bytes!`,
      jwtIssuer: 'streetverse-api',
      jwtBuyerAudience: 'streetverse-buyer',
      jwtSellerAudience: 'streetverse-seller',
      jwtExpiresIn: '1h',
      redisUrl,
      customerDbUrl: custUrl,
      merchantDbUrl: merchUrl,
      aiEngineUrl: 'http://127.0.0.1:1',
      kycStorageDir: tmpStorageDir
    };

    const { server, shutdown } = createGatewayApp(cfg, {
      customerPool: custPool,
      merchantPool: merchPool,
      enableRedisAdapter: false,
      emailTransporter: {
        sendMail: async (mail: any) => {
          const match = String(mail?.text || '').match(/\b(\d{6})\b/);
          if (match) lastOtp = match[1];
          return {};
        }
      }
    });
    shutdowns.push(shutdown);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    gwPort = (server.address() as AddressInfo).port;

    owner1Jwt = jwt.sign({ sub: legacyOwnerAcctId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, cfg.jwtSecret, {
      issuer: cfg.jwtIssuer,
      audience: cfg.jwtSellerAudience,
      expiresIn: '1h'
    });
    staffJwt = jwt.sign({ sub: staffAcctId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, cfg.jwtSecret, {
      issuer: cfg.jwtIssuer,
      audience: cfg.jwtSellerAudience,
      expiresIn: '1h'
    });
    buyerJwt = jwt.sign({ sub: buyerAcctId, role: 'BUYER' }, cfg.jwtSecret, {
      issuer: cfg.jwtIssuer,
      audience: cfg.jwtBuyerAudience,
      expiresIn: '1h'
    });

    // =====================================================================
    // CASE 2: Registration Closed Default + RBAC + Multipart Private Storage
    // =====================================================================
    await runCase('Registration defaults closed & RBAC + Multipart private document upload/retrieval/deletion enforce security boundaries', async () => {
      const regRes = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/auth/seller/register',
        body: {
          business_name: 'Owner2 Fresh Kirana',
          category: 'GROCERY',
          owner_phone: '9833300001',
          owner_email: `owner2.${runId}@example.test`,
          password: 'Password123!',
          upi_vpa: 'owner2@okaxis',
          address: 'Shop 9, Kothrud, Pune',
          pincode: '411038'
        }
      });
      assert.strictEqual(regRes.statusCode, 201);
      owner2AcctId = regRes.json.sellerAccountId;
      owner2GroceryId = regRes.json.merchantId;

      const regVerify = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/auth/seller/verify-otp',
        body: { email: `owner2.${runId}@example.test`, otp: lastOtp }
      });
      assert.strictEqual(regVerify.statusCode, 200);
      owner2Jwt = regVerify.json.token;

      // Verify DB defaults: is_open=false, is_verified=false, profile=PENDING_SUBMISSION with NULL GPS
      const regDbCheck = await merchPool.query(
        `SELECT m.is_open, m.is_verified, p.status, p.latitude, p.longitude
         FROM merchants m JOIN store_onboarding_profiles p ON p.merchant_id = m.id
         WHERE m.id = $1`,
        [owner2GroceryId]
      );
      assert.strictEqual(regDbCheck.rows[0].is_open, false, 'Newly registered store defaults is_open=false');
      assert.strictEqual(regDbCheck.rows[0].is_verified, false, 'merchants.is_verified remains false');
      assert.strictEqual(regDbCheck.rows[0].status, 'PENDING_SUBMISSION');
      assert.strictEqual(regDbCheck.rows[0].latitude, null, 'Registration placeholder GPS must not pre-verify onboarding GPS');

      // RBAC checks
      assert.strictEqual((await httpRequest({ port: gwPort, method: 'GET', path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding` })).statusCode, 401);
      assert.strictEqual((await httpRequest({ port: gwPort, method: 'GET', path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding`, headers: { Authorization: `Bearer ${buyerJwt}` } })).statusCode, 403);
      assert.strictEqual((await httpRequest({ port: gwPort, method: 'GET', path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding`, headers: { Authorization: `Bearer ${staffJwt}` } })).statusCode, 403);
      assert.strictEqual((await httpRequest({ port: gwPort, method: 'GET', path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding`, headers: { Authorization: `Bearer ${owner2Jwt}` } })).statusCode, 403);

      // GROCERY store should NOT accept PHARMACY-only DRUG_LICENSE
      const wrongReq = buildMultipart({
        fieldName: 'document',
        filename: 'dl.pdf',
        mimeType: 'application/pdf',
        content: makePdf('wrong-cat'),
        extraFields: { requirementKey: 'DRUG_LICENSE' }
      });
      const wrongReqRes = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${owner2GroceryId}/onboarding/documents`,
        headers: { Authorization: `Bearer ${owner2Jwt}`, 'Content-Type': wrongReq.contentType },
        body: wrongReq.body
      });
      assert.strictEqual(wrongReqRes.statusCode, 400);
      assert.strictEqual(wrongReqRes.json.code, 'INVALID_REQUIREMENT_KEY');

      // Valid JPEG upload to Pharmacy Store 1
      const jpegBytes = makeJpeg('front1');
      const up1 = buildMultipart({
        fieldName: 'document',
        filename: '../../my shop/front.jpg',
        mimeType: 'image/jpeg',
        content: jpegBytes,
        extraFields: { requirementKey: 'STOREFRONT_PHOTO_1' }
      });
      const up1Res = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/documents`,
        headers: { Authorization: `Bearer ${owner1Jwt}`, 'Content-Type': up1.contentType },
        body: up1.body
      });
      assert.strictEqual(up1Res.statusCode, 201);
      const doc1Id = up1Res.json.document.id;
      assert(!up1Res.body.includes(tmpStorageDir) && !up1Res.body.includes('storage_key') && !up1Res.body.includes('storageKey'));

      // Verify private file written safely on disk (CSPRNG filename, not original filename)
      const diskFiles = fs.readdirSync(tmpStorageDir);
      assert.strictEqual(diskFiles.length, 1);
      assert(/^[0-9a-f]{64}\.jpg$/.test(diskFiles[0]), 'Private file uses CSPRNG name');
      assert(fs.readFileSync(path.join(tmpStorageDir, diskFiles[0])).equals(jpegBytes));

      // Duplicate identical file rejected 409 (checksum duplicate prevention)
      const dupUp = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/documents`,
        headers: { Authorization: `Bearer ${owner1Jwt}`, 'Content-Type': up1.contentType },
        body: up1.body
      });
      assert.strictEqual(dupUp.statusCode, 409);

      // Authorized retrieval streams exact bytes; cross-owner gets 403; non-static path returns 404
      const dlRes = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/documents/${doc1Id}`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(dlRes.statusCode, 200);
      assert(dlRes.raw.equals(jpegBytes), 'Retrieved bytes match stored JPEG');
      assert.strictEqual((await httpRequest({ port: gwPort, method: 'GET', path: `/data/kyc-documents/${diskFiles[0]}` })).statusCode, 404);

      // Owner2 cannot delete Owner1's doc; Owner1 deletes cleanly and removes physical file
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'DELETE',
          path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/documents/${doc1Id}`,
          headers: { Authorization: `Bearer ${owner2Jwt}` }
        })).statusCode,
        403
      );
      const delRes = await httpRequest({
        port: gwPort,
        method: 'DELETE',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/documents/${doc1Id}`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(delRes.statusCode, 200);
      assert.strictEqual(fs.readdirSync(tmpStorageDir).length, 0, 'Deleted draft file removed from disk');
    });

    // =====================================================================
    // CASE 3: Checklist Validation, Immutable Submit, Resubmission & Store Isolation
    // =====================================================================
    await runCase('Submission, category checklists, DB immutability triggers, resubmission v2, and store independence work end-to-end', async () => {
      // Attempt submit before GPS/confirmations/docs -> rejected 400
      const earlySub = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(earlySub.statusCode, 400);

      // Save fixed-shop draft + valid GPS
      const putRes = await httpRequest({
        port: gwPort,
        method: 'PUT',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding`,
        headers: { Authorization: `Bearer ${owner1Jwt}` },
        body: {
          businessName: 'Legacy Care Pharmacy',
          category: 'PHARMACY',
          businessType: 'FIXED_SHOP',
          businessTypeConfirmed: true,
          fixedPremisesConfirmed: true,
          premisesOwnershipType: 'RENTED',
          address: 'Shop 1, MG Road, Pune',
          pincode: '411001',
          latitude: 18.5204,
          longitude: 73.8567,
          gpsAccuracyMeters: 6.5
        }
      });
      assert.strictEqual(putRes.statusCode, 200);

      // Upload 2 storefront photos + 1 premises proof (WITHOUT DRUG_LICENSE yet) -> submit MUST fail!
      const uploadDoc = async (storeId: string, token: string, key: string, name: string, mime: string, content: Buffer) => {
        const mp = buildMultipart({
          fieldName: 'document',
          filename: name,
          mimeType: mime,
          content,
          extraFields: { requirementKey: key }
        });
        return httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${storeId}/onboarding/documents`,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': mp.contentType },
          body: mp.body
        });
      };

      const p1 = await uploadDoc(legacyPharmacyId, owner1Jwt, 'STOREFRONT_PHOTO_1', 'f1.jpg', 'image/jpeg', makeJpeg('ph1'));
      const p2 = await uploadDoc(legacyPharmacyId, owner1Jwt, 'STOREFRONT_PHOTO_2', 'f2.png', 'image/png', makePng('ph2'));
      const pr = await uploadDoc(legacyPharmacyId, owner1Jwt, 'PREMISES_PROOF', 'lease.pdf', 'application/pdf', makePdf('lease1'));
      assert(p1.statusCode === 201 && p2.statusCode === 201 && pr.statusCode === 201);

      const missingDlSub = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(missingDlSub.statusCode, 400);
      assert(missingDlSub.json.details.missingRequirements.includes('DRUG_LICENSE'), 'Pharmacy requires DRUG_LICENSE');

      // Enforce max 5 premises/storefront photo limit
      const x1 = await uploadDoc(legacyPharmacyId, owner1Jwt, 'ADDITIONAL_PREMISES_PHOTO', 'x1.jpg', 'image/jpeg', makeJpeg('x1'));
      const x2 = await uploadDoc(legacyPharmacyId, owner1Jwt, 'ADDITIONAL_PREMISES_PHOTO', 'x2.jpg', 'image/jpeg', makeJpeg('x2'));
      const x3 = await uploadDoc(legacyPharmacyId, owner1Jwt, 'ADDITIONAL_PREMISES_PHOTO', 'x3.jpg', 'image/jpeg', makeJpeg('x3'));
      const x4 = await uploadDoc(legacyPharmacyId, owner1Jwt, 'ADDITIONAL_PREMISES_PHOTO', 'x4.jpg', 'image/jpeg', makeJpeg('x4'));
      assert(x1.statusCode === 201 && x2.statusCode === 201 && x3.statusCode === 201);
      assert.strictEqual(x4.statusCode, 400, 'Over 5 storefront/premises photos rejected');
      assert.strictEqual(x4.json.code, 'MAX_PREMISES_PHOTOS_EXCEEDED');

      // Now upload DRUG_LICENSE (PDF) and submit -> succeeds with v1 SUBMITTED (not APPROVED)
      const dl = await uploadDoc(legacyPharmacyId, owner1Jwt, 'DRUG_LICENSE', 'drug-license.pdf', 'application/pdf', makePdf('dl1'));
      assert.strictEqual(dl.statusCode, 201);

      const sub1 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(sub1.statusCode, 201);
      assert.strictEqual(sub1.json.submissionVersion, 1);
      assert.strictEqual(sub1.json.status, 'SUBMITTED');
      const v1Id = sub1.json.submissionId;

      // Second store owned by same Owner (Restaurant) remains untouched in PENDING_SUBMISSION
      const store2Get = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/seller/stores/${legacyRestaurantId}/onboarding`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(store2Get.statusCode, 200);
      assert.strictEqual(store2Get.json.profile.status, 'PENDING_SUBMISSION', 'Multi-store status is strictly independent');

      // Cannot delete historical v1 document via API or SQL trigger
      const doc1Id = p1.json.document.id;
      const delHist = await httpRequest({
        port: gwPort,
        method: 'DELETE',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/documents/${doc1Id}`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(delHist.statusCode, 403);

      let triggerBlocked = false;
      try {
        await merchPool.query(`DELETE FROM kyc_documents WHERE id = $1`, [doc1Id]);
      } catch {
        triggerBlocked = true;
      }
      assert(triggerBlocked, 'PostgreSQL trigger must reject deletion of submitted kyc_documents');

      let snapshotTriggerBlocked = false;
      try {
        await merchPool.query(`UPDATE store_kyc_submissions SET address_snapshot = 'Tampered' WHERE id = $1`, [v1Id]);
      } catch {
        snapshotTriggerBlocked = true;
      }
      assert(snapshotTriggerBlocked, 'PostgreSQL trigger must reject mutating submitted snapshot');

      // Simulate Admin requesting MORE_INFO_REQUIRED with private review_notes (which must NOT leak)
      await merchPool.query(
        `UPDATE store_kyc_submissions SET status = 'MORE_INFO_REQUIRED', reviewed_at = CURRENT_TIMESTAMP, review_notes = 'INTERNAL_ADMIN_SECRET_NOTE' WHERE id = $1`,
        [v1Id]
      );
      await merchPool.query(
        `UPDATE store_onboarding_profiles SET status = 'MORE_INFO_REQUIRED' WHERE merchant_id = $1`,
        [legacyPharmacyId]
      );

      // Owner submits v2; v1 and v1 docs stay completely preserved and immutable
      assert.strictEqual((await uploadDoc(legacyPharmacyId, owner1Jwt, 'STOREFRONT_PHOTO_1', 'v2-f1.jpg', 'image/jpeg', makeJpeg('v2-1'))).statusCode, 201);
      assert.strictEqual((await uploadDoc(legacyPharmacyId, owner1Jwt, 'STOREFRONT_PHOTO_2', 'v2-f2.png', 'image/png', makePng('v2-2'))).statusCode, 201);
      assert.strictEqual((await uploadDoc(legacyPharmacyId, owner1Jwt, 'PREMISES_PROOF', 'v2-bill.pdf', 'application/pdf', makePdf('v2-bill'))).statusCode, 201);
      assert.strictEqual((await uploadDoc(legacyPharmacyId, owner1Jwt, 'DRUG_LICENSE', 'v2-dl.pdf', 'application/pdf', makePdf('v2-dl'))).statusCode, 201);

      const sub2 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(sub2.statusCode, 201);
      assert.strictEqual(sub2.json.submissionVersion, 2);

      const histRes = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/submissions`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(histRes.statusCode, 200);
      assert.strictEqual(histRes.json.submissions.length, 2);
      assert.strictEqual(histRes.json.submissions[0].submissionVersion, 2);
      assert.strictEqual(histRes.json.submissions[1].submissionVersion, 1);
      assert.strictEqual(histRes.json.submissions[1].status, 'MORE_INFO_REQUIRED');
      assert(!histRes.body.includes('INTERNAL_ADMIN_SECRET_NOTE'), 'Admin review_notes must not leak to Seller');

      const v1DocsStillIntact = await merchPool.query(`SELECT count(*)::int AS c FROM kyc_documents WHERE submission_id = $1`, [v1Id]);
      assert.strictEqual(v1DocsStillIntact.rows[0].c, 7, 'All 7 documents of historical v1 remain intact');
    });

    // =====================================================================
    // CASE 4: Location Change Re-Verification & Preservation
    // =====================================================================
    await runCase('Location change on approved store enforces REVERIFICATION_REQUIRED, closes store, preserves old approval, and blocks unapproved inheritance', async () => {
      const subRes = await merchPool.query(
        `SELECT id, address_snapshot, pincode_snapshot, latitude_snapshot, longitude_snapshot
         FROM store_kyc_submissions WHERE merchant_id = $1 AND submission_version = 2`,
        [legacyPharmacyId]
      );
      const subV2 = subRes.rows[0];

      // Simulate MO-B Admin approval of Pharmacy Store ONLY (Restaurant store remains untouched/unapproved)
      await merchPool.query(`UPDATE store_kyc_submissions SET status = 'APPROVED', reviewed_at = CURRENT_TIMESTAMP WHERE id = $1`, [subV2.id]);
      await merchPool.query(
        `UPDATE store_onboarding_profiles
         SET status = 'APPROVED',
             current_submission_id = $2,
             approved_submission_id = $2,
             approved_address = $3,
             approved_pincode = $4,
             approved_latitude = $5,
             approved_longitude = $6,
             approved_at = CURRENT_TIMESTAMP,
             reverification_required = false
         WHERE merchant_id = $1`,
        [legacyPharmacyId, subV2.id, subV2.address_snapshot, subV2.pincode_snapshot, subV2.latitude_snapshot, subV2.longitude_snapshot]
      );
      await merchPool.query(`UPDATE merchants SET is_open = true WHERE id = $1`, [legacyPharmacyId]);

      // Approval of Store 1 must NEVER approve Store 2
      const store2Profile = await merchPool.query(`SELECT status FROM store_onboarding_profiles WHERE merchant_id = $1`, [legacyRestaurantId]);
      assert.strictEqual(store2Profile.rows[0].status, 'PENDING_SUBMISSION');

      // Store 1 changes street address (without even supplying new GPS yet) -> MUST require re-verification & fresh GPS
      const relocateRes = await httpRequest({
        port: gwPort,
        method: 'PUT',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding`,
        headers: { Authorization: `Bearer ${owner1Jwt}` },
        body: {
          address: 'New Shop 42, Baner Road, Pune',
          pincode: '411045'
        }
      });
      assert.strictEqual(relocateRes.statusCode, 200);
      assert.strictEqual(relocateRes.json.locationChangeDetected, true);
      assert.strictEqual(relocateRes.json.profile.status, 'REVERIFICATION_REQUIRED');
      assert.strictEqual(relocateRes.json.profile.reverificationRequired, true);
      assert.strictEqual(relocateRes.json.profile.hasApprovedLocationHistory, true);
      assert.strictEqual(relocateRes.json.profile.latitude, null, 'Old GPS cleared so fresh GPS capture is mandatory');

      const dbAfterMove = await merchPool.query(
        `SELECT m.is_open, p.status, p.approved_submission_id, p.approved_address, p.approved_latitude::float, p.approved_longitude::float
         FROM merchants m JOIN store_onboarding_profiles p ON p.merchant_id = m.id WHERE m.id = $1`,
        [legacyPharmacyId]
      );
      assert.strictEqual(dbAfterMove.rows[0].is_open, false, 'Relocated store is closed until re-verified');
      assert.strictEqual(dbAfterMove.rows[0].approved_submission_id, subV2.id, 'Old approved submission ID preserved');
      assert.strictEqual(dbAfterMove.rows[0].approved_address, 'Shop 1, MG Road, Pune', 'Old approved address preserved');

      // Cannot submit immediately without fresh GPS & fresh documents
      const blockedSubmit = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(blockedSubmit.statusCode, 400);

      // Update fresh premises confirmation + new Baner GPS + fresh docs -> creates v3 SUBMITTED (reverification stays true!)
      await httpRequest({
        port: gwPort,
        method: 'PUT',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding`,
        headers: { Authorization: `Bearer ${owner1Jwt}` },
        body: {
          businessTypeConfirmed: true,
          fixedPremisesConfirmed: true,
          latitude: 18.5590,
          longitude: 73.7868
        }
      });
      for (const [k, n, m, b] of [
        ['STOREFRONT_PHOTO_1', 'v3-f1.jpg', 'image/jpeg', makeJpeg('v3-1')],
        ['STOREFRONT_PHOTO_2', 'v3-f2.png', 'image/png', makePng('v3-2')],
        ['PREMISES_PROOF', 'v3-rent.pdf', 'application/pdf', makePdf('v3-rent')],
        ['DRUG_LICENSE', 'v3-dl.pdf', 'application/pdf', makePdf('v3-dl')]
      ] as const) {
        const mp = buildMultipart({ fieldName: 'document', filename: n, mimeType: m, content: b, extraFields: { requirementKey: k } });
        const r = await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/documents`,
          headers: { Authorization: `Bearer ${owner1Jwt}`, 'Content-Type': mp.contentType },
          body: mp.body
        });
        assert.strictEqual(r.statusCode, 201);
      }

      const sub3 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${legacyPharmacyId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(sub3.statusCode, 201);
      assert.strictEqual(sub3.json.submissionVersion, 3);
      assert.strictEqual(sub3.json.submission.isReverification, true);
      assert.strictEqual(sub3.json.status, 'SUBMITTED');

      const finalProf = await merchPool.query(
        `SELECT status, reverification_required, approved_submission_id FROM store_onboarding_profiles WHERE merchant_id = $1`,
        [legacyPharmacyId]
      );
      assert.strictEqual(finalProf.rows[0].status, 'SUBMITTED');
      assert.strictEqual(finalProf.rows[0].reverification_required, true, 'New location does not inherit old approval automatically');
      assert.strictEqual(finalProf.rows[0].approved_submission_id, subV2.id);
    });

    // =====================================================================
    // CASE 5: Category Requirement Coverage (Grocery Retail vs Restaurant vs Stationery/Clothing/Electronics)
    // =====================================================================
    await runCase('Category requirement coverage separates Grocery retail from Restaurant and applies universal-only rules to Stationery/Clothing/Electronics', async () => {
      const uploadDoc = async (storeId: string, token: string, key: string, name: string, mime: string, content: Buffer) => {
        const mp = buildMultipart({
          fieldName: 'document',
          filename: name,
          mimeType: mime,
          content,
          extraFields: { requirementKey: key }
        });
        return httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${storeId}/onboarding/documents`,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': mp.contentType },
          body: mp.body
        });
      };

      // 1. Verify getApplicableRequirements across every category
      const groceryReq = await getApplicableRequirements(merchPool, 'GROCERY');
      const restReq = await getApplicableRequirements(merchPool, 'RESTAURANT');
      const pharmReq = await getApplicableRequirements(merchPool, 'PHARMACY');
      assert(groceryReq.ok && restReq.ok && pharmReq.ok);

      const gMandatory = groceryReq.data.filter((r) => r.isMandatory).map((r) => r.requirementKey);
      const rMandatory = restReq.data.filter((r) => r.isMandatory).map((r) => r.requirementKey);
      const pMandatory = pharmReq.data.filter((r) => r.isMandatory).map((r) => r.requirementKey);

      assert(
        gMandatory.includes('STOREFRONT_PHOTO_1') &&
          gMandatory.includes('STOREFRONT_PHOTO_2') &&
          gMandatory.includes('PREMISES_PROOF') &&
          gMandatory.includes('FSSAI_FOOD_RETAIL_REGISTRATION') &&
          !gMandatory.includes('FSSAI_LICENSE') &&
          !gMandatory.includes('DRUG_LICENSE'),
        `GROCERY must require retail FSSAI + universal docs only; got ${JSON.stringify(gMandatory)}`
      );
      assert(
        rMandatory.includes('FSSAI_LICENSE') && !rMandatory.includes('FSSAI_FOOD_RETAIL_REGISTRATION'),
        `RESTAURANT must use food-service FSSAI_LICENSE distinct from grocery retail; got ${JSON.stringify(rMandatory)}`
      );
      assert(
        pMandatory.includes('DRUG_LICENSE') && !pMandatory.includes('FSSAI_LICENSE'),
        `PHARMACY must require DRUG_LICENSE; got ${JSON.stringify(pMandatory)}`
      );

      for (const nonRegulatedCat of ['STATIONERY', 'CLOTHING', 'ELECTRONICS', 'HARDWARE', 'SALON', 'FLORIST', 'PET_SHOP', 'SPORTS']) {
        const res = await getApplicableRequirements(merchPool, nonRegulatedCat);
        assert(res.ok);
        const mandatory = res.data.filter((r) => r.isMandatory).map((r) => r.requirementKey).sort();
        assert.deepStrictEqual(
          mandatory,
          ['PREMISES_PROOF', 'STOREFRONT_PHOTO_1', 'STOREFRONT_PHOTO_2'],
          `${nonRegulatedCat} must require only universal physical premises docs`
        );
      }

      // 2. End-to-end GROCERY store submission: requires FSSAI_FOOD_RETAIL_REGISTRATION, rejects RESTAURANT FSSAI_LICENSE
      const grocPut = await httpRequest({
        port: gwPort,
        method: 'PUT',
        path: `/api/v1/seller/stores/${owner2GroceryId}/onboarding`,
        headers: { Authorization: `Bearer ${owner2Jwt}` },
        body: {
          businessType: 'FIXED_SHOP',
          businessTypeConfirmed: true,
          fixedPremisesConfirmed: true,
          address: 'Shop 9, Kothrud, Pune',
          pincode: '411038',
          latitude: 18.5074,
          longitude: 73.8077
        }
      });
      assert.strictEqual(grocPut.statusCode, 200);

      assert.strictEqual((await uploadDoc(owner2GroceryId, owner2Jwt, 'STOREFRONT_PHOTO_1', 'g1.jpg', 'image/jpeg', makeJpeg('g1'))).statusCode, 201);
      assert.strictEqual((await uploadDoc(owner2GroceryId, owner2Jwt, 'STOREFRONT_PHOTO_2', 'g2.png', 'image/png', makePng('g2'))).statusCode, 201);
      assert.strictEqual((await uploadDoc(owner2GroceryId, owner2Jwt, 'PREMISES_PROOF', 'g-rent.pdf', 'application/pdf', makePdf('g-rent'))).statusCode, 201);

      const grocMissingFssai = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${owner2GroceryId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${owner2Jwt}` }
      });
      assert.strictEqual(grocMissingFssai.statusCode, 400);
      assert(grocMissingFssai.json.details.missingRequirements.includes('FSSAI_FOOD_RETAIL_REGISTRATION'));

      const grocWrongRestKey = await uploadDoc(owner2GroceryId, owner2Jwt, 'FSSAI_LICENSE', 'rest.pdf', 'application/pdf', makePdf('wrong-rest'));
      assert.strictEqual(grocWrongRestKey.statusCode, 400, 'Grocery store must not accept RESTAURANT requirementKey');

      assert.strictEqual((await uploadDoc(owner2GroceryId, owner2Jwt, 'FSSAI_FOOD_RETAIL_REGISTRATION', 'g-fssai.pdf', 'application/pdf', makePdf('g-fssai'))).statusCode, 201);
      const grocSub = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${owner2GroceryId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${owner2Jwt}` }
      });
      assert.strictEqual(grocSub.statusCode, 201);

      // 3. Register STATIONERY shop (and test switching across CLOTHING/ELECTRONICS) -> submits with universal docs only
      const statEmail = `stationery.${runId}@example.test`;
      const statReg = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/auth/seller/register',
        body: {
          business_name: 'Student Corner Stationery',
          category: 'STATIONERY',
          owner_phone: '9844400001',
          owner_email: statEmail,
          password: 'Password123!',
          upi_vpa: 'stat@okaxis',
          address: 'Shop 22, Paud Road, Pune',
          pincode: '411038'
        }
      });
      assert.strictEqual(statReg.statusCode, 201);
      const statStoreId = statReg.json.merchantId;

      const statVerify = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/auth/seller/verify-otp',
        body: { email: statEmail, otp: lastOtp }
      });
      assert.strictEqual(statVerify.statusCode, 200);
      const statJwt = statVerify.json.token;

      // Verify CLOTHING & ELECTRONICS accepted cleanly on draft PUT, then keep STATIONERY
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'PUT',
          path: `/api/v1/seller/stores/${statStoreId}/onboarding`,
          headers: { Authorization: `Bearer ${statJwt}` },
          body: { category: 'CLOTHING' }
        })).statusCode,
        200
      );
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'PUT',
          path: `/api/v1/seller/stores/${statStoreId}/onboarding`,
          headers: { Authorization: `Bearer ${statJwt}` },
          body: { category: 'ELECTRONICS' }
        })).statusCode,
        200
      );
      const statPut = await httpRequest({
        port: gwPort,
        method: 'PUT',
        path: `/api/v1/seller/stores/${statStoreId}/onboarding`,
        headers: { Authorization: `Bearer ${statJwt}` },
        body: {
          category: 'STATIONERY',
          businessType: 'FIXED_SHOP',
          businessTypeConfirmed: true,
          fixedPremisesConfirmed: true,
          address: 'Shop 22, Paud Road, Pune',
          pincode: '411038',
          latitude: 18.5101,
          longitude: 73.8122
        }
      });
      assert.strictEqual(statPut.statusCode, 200);

      // Stationery rejects irrelevant FSSAI / Drug licences
      assert.strictEqual((await uploadDoc(statStoreId, statJwt, 'FSSAI_FOOD_RETAIL_REGISTRATION', 'f.pdf', 'application/pdf', makePdf('stat-no-fssai'))).statusCode, 400);
      assert.strictEqual((await uploadDoc(statStoreId, statJwt, 'DRUG_LICENSE', 'd.pdf', 'application/pdf', makePdf('stat-no-drug'))).statusCode, 400);

      // Submits cleanly with only 2 storefront photos + 1 premises proof
      assert.strictEqual((await uploadDoc(statStoreId, statJwt, 'STOREFRONT_PHOTO_1', 's1.jpg', 'image/jpeg', makeJpeg('stat1'))).statusCode, 201);
      assert.strictEqual((await uploadDoc(statStoreId, statJwt, 'STOREFRONT_PHOTO_2', 's2.png', 'image/png', makePng('stat2'))).statusCode, 201);
      assert.strictEqual((await uploadDoc(statStoreId, statJwt, 'PREMISES_PROOF', 's-bill.pdf', 'application/pdf', makePdf('stat-bill'))).statusCode, 201);

      const statSub = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${statStoreId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${statJwt}` }
      });
      assert.strictEqual(statSub.statusCode, 201);
      assert.strictEqual(statSub.json.status, 'SUBMITTED');
    });
  } finally {
    await Promise.allSettled(shutdowns.map((fn) => fn()));
    await Promise.allSettled(pools.map((p) => p.end()));
    fs.rmSync(tmpStorageDir, { recursive: true, force: true });
    if (createdContainers.length > 0) {
      await runDocker(['rm', '-f', ...createdContainers]).catch(() => {});
    }
  }

  console.log('\n=== StreetVerse MO-A Live Integration Results ===');
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.name} (${r.durationMs}ms)`);
    if (r.error) console.log(`  -> ${r.error}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nSummary: ${passed}/${results.length} MO-A live scenarios passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

runSuite().catch((err) => {
  console.error('[MO-A Live Test Fatal Error]', err);
  process.exit(1);
});
