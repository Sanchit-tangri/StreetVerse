/**
 * StreetVerse S1.4-A Live PostgreSQL + Redis Migration, Backfill & RBAC Integration Suite
 *
 * Validates against disposable, dynamically ported Docker containers:
 *   - Pre-migration Merchant DB backfill -> `seller_accounts` + `store_memberships` (`OWNER`)
 *   - Preserved store UUIDs, `inventory_items`, `service_slots`, and Customer DB `orders`
 *   - Multi-store normalized owner grouping & safe rollback on ambiguous identities
 *   - Real PostgreSQL + Redis Seller register/login/verify-otp, JWT v2 vs legacy token rejection
 *   - Multi-store Owner vs Staff RBAC, store discovery (`/api/v1/seller/stores`), `/me`, and KYC protection
 */

import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net, { AddressInfo } from 'net';
import path from 'path';
import { promisify } from 'util';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { createStrictPgPool, StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import {
  MerchantIdentityBackfillError,
  migrateAndBackfillSellerIdentities
} from '../../services/api-gateway/src/db/migrations/s14aSellerIdentityMigration';
import {
  requireSellerJwt,
  requireStoreMembership,
  SELLER_ACCOUNT_PRINCIPAL_TYPE
} from '../../services/api-gateway/src/middleware/authJwt';

const execFileAsync = promisify(execFile);
const RESERVED_PORTS = new Set([5432, 5433, 5434, 6379, 6380, 8000]);

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', args, { timeout: 60000, encoding: 'utf8' });
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

async function getFreePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        server.close((err) => (err ? reject(err) : resolve(addr.port)));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('Could not allocate isolated port.');
}

async function httpRequest(options: {
  port: number;
  method: 'GET' | 'POST';
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
        timeout: 8000,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() }
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

const PRE_S14A_MERCHANT_SCHEMA_SQL = `
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
  try {
    await runDocker(['info']);
  } catch (err: any) {
    console.error(`BLOCKED: Docker daemon unavailable (${err?.message || 'error'}). Live S1.4-A tests NOT RUN.`);
    process.exit(2);
  }

  const runId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const custContainer = `streetverse-s14a-cust-${runId}`;
  const merchContainer = `streetverse-s14a-merch-${runId}`;
  const conflictMerchContainer = `streetverse-s14a-conf-${runId}`;
  const redisContainer = `streetverse-s14a-redis-${runId}`;
  const createdContainers: string[] = [];

  const custPort = await getFreePort();
  const merchPort = await getFreePort();
  const conflictMerchPort = await getFreePort();
  const redisPort = await getFreePort();

  const pgPass = crypto.randomBytes(12).toString('hex');
  const redisPass = crypto.randomBytes(12).toString('hex');
  const jwtSecret = crypto.randomBytes(36).toString('base64url');

  const custDb = 'sv_s14a_customer';
  const merchDb = 'sv_s14a_merchant';
  const conflictMerchDb = 'sv_s14a_conflict';

  const customerDbUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${custPort}/${custDb}`;
  const merchantDbUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${merchPort}/${merchDb}`;
  const conflictMerchantDbUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${conflictMerchPort}/${conflictMerchDb}`;
  const redisUrl = `redis://:${redisPass}@127.0.0.1:${redisPort}`;

  const pools: StrictPgPool[] = [];
  const shutdowns: Array<() => Promise<unknown>> = [];
  const results: TestResult[] = [];

  async function runCase(name: string, fn: () => Promise<void>) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, durationMs: Date.now() - start });
    } catch (err: any) {
      results.push({ name, passed: false, durationMs: Date.now() - start, error: err?.stack || err?.message || String(err) });
    }
  }

  try {
    console.log(`[S1.4-A] Starting isolated containers (${runId}) on ports ${custPort}, ${merchPort}, ${conflictMerchPort}, ${redisPort}...`);

    await runDocker([
      'run', '-d', '--name', custContainer, '-p', `127.0.0.1:${custPort}:5432`,
      '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', `POSTGRES_DB=${custDb}`,
      'postgres:16-alpine'
    ]);
    createdContainers.push(custContainer);

    await runDocker([
      'run', '-d', '--name', merchContainer, '-p', `127.0.0.1:${merchPort}:5432`,
      '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', `POSTGRES_DB=${merchDb}`,
      'pgvector/pgvector:pg16'
    ]);
    createdContainers.push(merchContainer);

    await runDocker([
      'run', '-d', '--name', conflictMerchContainer, '-p', `127.0.0.1:${conflictMerchPort}:5432`,
      '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', `POSTGRES_DB=${conflictMerchDb}`,
      'pgvector/pgvector:pg16'
    ]);
    createdContainers.push(conflictMerchContainer);

    await runDocker([
      'run', '-d', '--name', redisContainer, '-p', `127.0.0.1:${redisPort}:6379`,
      'redis:7-alpine', 'redis-server', '--requirepass', redisPass
    ]);
    createdContainers.push(redisContainer);

    await Promise.all([
      waitForUntil(async () => { await runDocker(['exec', custContainer, 'pg_isready', '-U', 'postgres', '-d', custDb]); return true; }, 30000, 300, 'Customer PG ready timeout'),
      waitForUntil(async () => { await runDocker(['exec', merchContainer, 'pg_isready', '-U', 'postgres', '-d', merchDb]); return true; }, 30000, 300, 'Merchant PG ready timeout'),
      waitForUntil(async () => { await runDocker(['exec', conflictMerchContainer, 'pg_isready', '-U', 'postgres', '-d', conflictMerchDb]); return true; }, 30000, 300, 'Conflict Merchant PG ready timeout'),
      waitForUntil(async () => (await runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'ping'])).stdout.trim() === 'PONG', 20000, 250, 'Redis ready timeout')
    ]);

    const customerPool = createStrictPgPool(customerDbUrl, 'customer');
    const merchantPool = createStrictPgPool(merchantDbUrl, 'merchant');
    const conflictPool = createStrictPgPool(conflictMerchantDbUrl, 'merchant');
    pools.push(customerPool, merchantPool, conflictPool);

    await Promise.all([
      waitForUntil(async () => (await customerPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'customerPool connect'),
      waitForUntil(async () => (await merchantPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'merchantPool connect'),
      waitForUntil(async () => (await conflictPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'conflictPool connect')
    ]);

    const customerSchemaSql = fs.readFileSync(
      path.resolve(process.cwd(), 'packages', 'database-schemas', 'customer-db', 'schema.sql'),
      'utf8'
    );
    await customerPool.query(customerSchemaSql);
    await merchantPool.query(PRE_S14A_MERCHANT_SCHEMA_SQL);
    await conflictPool.query(PRE_S14A_MERCHANT_SCHEMA_SQL);

    // -----------------------------------------------------------------------
    // Case 1: Live PostgreSQL Migration & Backfill (UUID & FK preservation + multi-store grouping)
    // -----------------------------------------------------------------------
    let backfilledMultiStoreIds: string[] = [];
    let backfilledOwnerEmail = '';

    await runCase('Live PostgreSQL migration backfills existing merchants, preserves UUIDs/orders/inventory, and merges multi-store owners', async () => {
      const ownerPwHash = await bcrypt.hash('OwnerPass123!', 10);
      backfilledOwnerEmail = `multi.owner.${runId}@example.test`;

      // Seed Customer user + order referencing Store 1 UUID prior to migration
      const userIns = await customerPool.query(
        `INSERT INTO users (phone, full_name, email, password_hash, is_verified)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        ['+919800010001', 'Order Customer', `buyer.order.${runId}@example.test`, ownerPwHash]
      );
      const customerId = userIns.rows[0].id;

      // Store 1 & Store 2 use equivalent phone/email in different legacy string formats (pass legacy string UNIQUE constraints)
      const s1Ins = await merchantPool.query(
        `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude)
         VALUES ('Owner Flagship Kirana', 'GROCERY', '+919810000001', $1, $2, true, 'flagship@upi', 'Pune 1', '411038', 18.5074, 73.8077)
         RETURNING id`,
        [backfilledOwnerEmail.toUpperCase(), ownerPwHash]
      );
      const s2Ins = await merchantPool.query(
        `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude)
         VALUES ('Owner Branch Cafe', 'RESTAURANT', '09810000001', $1, $2, true, 'branch@upi', 'Pune 2', '411038', 18.5080, 73.8080)
         RETURNING id`,
        [backfilledOwnerEmail, ownerPwHash]
      );
      const s3Ins = await merchantPool.query(
        `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude)
         VALUES ('Separate Store Pharmacy', 'PHARMACY', '+919810000002', $1, $2, false, 'other@upi', 'Pune 3', '411038', 18.5090, 73.8090)
         RETURNING id`,
        [`other.owner.${runId}@example.test`, ownerPwHash]
      );

      const store1Id = String(s1Ins.rows[0].id);
      const store2Id = String(s2Ins.rows[0].id);
      const store3Id = String(s3Ins.rows[0].id);
      backfilledMultiStoreIds = [store1Id, store2Id];

      // Seed existing inventory, service slot, and customer order referencing store1Id
      await merchantPool.query(
        `INSERT INTO inventory_items (merchant_id, item_name, category, price, stock_quantity)
         VALUES ($1, 'Heritage Rice', 'GROCERY', 120.00, 10)`,
        [store1Id]
      );
      await merchantPool.query(
        `INSERT INTO service_slots (merchant_id, service_name, slot_start, slot_end, price)
         VALUES ($1, 'Consultation', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP + INTERVAL '2 hours', 200.00)`,
        [store2Id]
      );
      const orderIns = await customerPool.query(
        `INSERT INTO orders (user_id, merchant_id, total_amount, payment_status, delivery_type)
         VALUES ($1, $2, 120.00, 'PAID', 'STORE_PICKUP') RETURNING id`,
        [customerId, store1Id]
      );

      const migrationResult = await migrateAndBackfillSellerIdentities(merchantPool);
      assert(migrationResult.applied, 'Expected migration applied=true');
      assert(migrationResult.sellerAccountsCreated === 2, `Expected 2 distinct Seller Accounts created, got ${migrationResult.sellerAccountsCreated}`);
      assert(migrationResult.membershipsCreated === 3, `Expected 3 OWNER memberships created, got ${migrationResult.membershipsCreated}`);

      // Idempotent re-run must create zero duplicates
      const rerunResult = await migrateAndBackfillSellerIdentities(merchantPool);
      assert(rerunResult.sellerAccountsCreated === 0 && rerunResult.membershipsCreated === 0 && rerunResult.alreadyMappedStores === 3, 'Idempotent rerun must skip already mapped stores');

      // Store UUIDs, inventory, slots, and orders remain valid and unchanged
      const invRes = await merchantPool.query('SELECT merchant_id FROM inventory_items WHERE merchant_id = $1', [store1Id]);
      const slotRes = await merchantPool.query('SELECT merchant_id FROM service_slots WHERE merchant_id = $1', [store2Id]);
      const ordRes = await customerPool.query('SELECT id, merchant_id FROM orders WHERE id = $1', [orderIns.rows[0].id]);
      assert(invRes.rows.length === 1 && slotRes.rows.length === 1, 'Inventory and slot FKs must stay valid');
      assert(ordRes.rows[0].merchant_id === store1Id, 'Customer order merchant_id reference must stay intact');

      const multiAcctRes = await merchantPool.query(
        `SELECT sa.id, sa.phone, sa.email, sa.is_email_verified, count(sm.id)::int AS store_count
         FROM seller_accounts sa
         JOIN store_memberships sm ON sm.seller_account_id = sa.id AND sm.role = 'OWNER' AND sm.status = 'ACTIVE'
         WHERE LOWER(sa.email) = $1
         GROUP BY sa.id`,
        [backfilledOwnerEmail]
      );
      assert(multiAcctRes.rows.length === 1 && multiAcctRes.rows[0].store_count === 2, 'Normalized multi-store owner must share 1 Seller Account and 2 OWNER memberships');
      assert(multiAcctRes.rows[0].phone === '+919810000001', 'Normalized E.164 phone must be preserved');
      assert(
        multiAcctRes.rows[0].is_email_verified === false,
        'Legacy merchants.is_verified=true has ambiguous provenance and MUST require fresh OTP verification (is_email_verified=false)'
      );

      const separateAcctRes = await merchantPool.query(
        `SELECT sa.id, sa.is_email_verified, sm.merchant_id
         FROM seller_accounts sa
         JOIN store_memberships sm ON sm.seller_account_id = sa.id
         WHERE sm.merchant_id = $1`,
        [store3Id]
      );
      assert(
        separateAcctRes.rows.length === 1 && separateAcctRes.rows[0].is_email_verified === false,
        'Legacy is_verified=false store must map to OWNER membership with is_email_verified=false'
      );
    });

    // -----------------------------------------------------------------------
    // Case 2: Live PostgreSQL Conflicting Identity Rollback Safety
    // -----------------------------------------------------------------------
    await runCase('Live PostgreSQL migration aborts and rolls back atomically on ambiguous owner identities', async () => {
      const pwHash = await bcrypt.hash('ConflictPass123!', 10);
      await conflictPool.query(
        `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude)
         VALUES
           ('Conflict One', 'GROCERY', '+919899900001', 'first@conflict.test', $1, true, 'c1@upi', 'A1', '411038', 18.5, 73.8),
           ('Conflict Two', 'GROCERY', '09899900001', 'second@conflict.test', $1, true, 'c2@upi', 'A2', '411038', 18.5, 73.8)`,
        [pwHash]
      );

      let conflictCaught: unknown;
      try {
        await migrateAndBackfillSellerIdentities(conflictPool);
      } catch (err) {
        conflictCaught = err;
      }
      assert(conflictCaught instanceof MerchantIdentityBackfillError, 'Expected MerchantIdentityBackfillError on phone-email conflict');
      assert(conflictCaught.conflicts.some((c) => c.code === 'PHONE_EMAIL_MISMATCH'), 'Expected PHONE_EMAIL_MISMATCH diagnostic');

      // PostgreSQL transactional DDL rolled back table creation / inserts cleanly
      const tableCheck = await conflictPool.query("SELECT to_regclass('public.seller_accounts') AS tbl");
      assert(tableCheck.rows[0].tbl === null, 'Failed migration transaction must roll back cleanly leaving zero partial tables/rows');
    });

    // -----------------------------------------------------------------------
    // Case 3: Live Gateway Seller Auth, Legacy Token Rejection, RBAC & KYC
    // -----------------------------------------------------------------------
    await runCase('Live Gateway: Seller register/login/OTP, JWT v2 vs legacy token, Owner/Staff RBAC, /stores, /me, and KYC 401/403/503', async () => {
      let lastOtp = '';
      const cfg: GatewayConfig = {
        nodeEnv: 'test',
        port: 0,
        allowedOrigins: ['http://127.0.0.1:3000'],
        jwtSecret,
        jwtIssuer: 'streetverse-api-s14a-live',
        jwtBuyerAudience: 'streetverse-buyer-s14a-live',
        jwtSellerAudience: 'streetverse-seller-s14a-live',
        jwtExpiresIn: '1h',
        redisUrl,
        customerDbUrl,
        merchantDbUrl,
        aiEngineUrl: 'http://127.0.0.1:1'
      };

      const { app, server, shutdown } = createGatewayApp(cfg, {
        emailTransporter: {
          sendMail: async (mail: any) => {
            const m = String(mail.text || '').match(/\b(\d{6})\b/);
            if (m) lastOtp = m[1];
            return {};
          }
        }
      });
      shutdowns.push(shutdown);

      // Test operational vs owner-only middleware directly against live Merchant PostgreSQL
      app.post(
        '/_live-test/stores/:storeId/inventory',
        requireSellerJwt(cfg),
        requireStoreMembership(merchantPool, { requiredPermission: 'INVENTORY_WRITE' }),
        (req: any, res) => res.status(200).json({ ok: true, role: req.storeAccess.role })
      );
      app.post(
        '/_live-test/stores/:storeId/staff',
        requireSellerJwt(cfg),
        requireStoreMembership(merchantPool, { requiredPermission: 'STAFF_MANAGE' }),
        (req: any, res) => res.status(200).json({ ok: true, role: req.storeAccess.role })
      );

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;

      // 1. Fresh registration creates Seller Account + Store + OWNER membership atomically, leaves merchants.is_verified=false
      const newSellerEmail = `fresh.seller.${runId}@example.test`;
      const regRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/register',
        body: {
          business_name: 'Fresh S14A Store',
          category: 'GROCERY',
          owner_phone: '9822200011',
          owner_email: newSellerEmail,
          password: 'Password123!',
          upi_vpa: 'fresh@upi',
          address: 'Pune',
          pincode: '411038'
        }
      });
      assert(regRes.statusCode === 201 && regRes.json.sellerAccountId && regRes.json.merchantId, `Expected 201 with sellerAccountId + merchantId, got ${regRes.statusCode}`);
      const freshStoreId = regRes.json.merchantId as string;
      const freshSellerId = regRes.json.sellerAccountId as string;

      // Duplicate register fails cleanly with 409 without creating extra store
      const storesCountBeforeDup = (await merchantPool.query('SELECT count(*)::int AS c FROM merchants')).rows[0].c;
      const dupRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/register',
        body: {
          business_name: 'Dup Store Should Rollback',
          category: 'GROCERY',
          owner_phone: '+919822200011',
          owner_email: newSellerEmail,
          password: 'Password123!',
          upi_vpa: 'dup@upi',
          address: 'Pune',
          pincode: '411038'
        }
      });
      assert(dupRes.statusCode === 409, `Expected 409 on duplicate seller register, got ${dupRes.statusCode}`);
      const storesCountAfterDup = (await merchantPool.query('SELECT count(*)::int AS c FROM merchants')).rows[0].c;
      assert(storesCountAfterDup === storesCountBeforeDup, 'Duplicate registration must leave zero orphan store rows');

      const verifyFresh = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/verify-otp',
        body: { email: newSellerEmail, otp: lastOtp }
      });
      assert(verifyFresh.statusCode === 200 && verifyFresh.json.token, 'Fresh seller OTP verify must return token');
      const freshJwt = verifyFresh.json.token as string;
      const freshDecoded = jwt.verify(freshJwt, cfg.jwtSecret) as jwt.JwtPayload;
      assert(freshDecoded.sub === freshSellerId && freshDecoded.principalType === SELLER_ACCOUNT_PRINCIPAL_TYPE, 'JWT sub must match Seller Account ID');

      const dbVerifyCheck = await merchantPool.query(
        `SELECT sa.is_email_verified, m.is_verified
         FROM seller_accounts sa
         JOIN store_memberships sm ON sm.seller_account_id = sa.id
         JOIN merchants m ON m.id = sm.merchant_id
         WHERE sa.id = $1 AND m.id = $2`,
        [freshSellerId, freshStoreId]
      );
      assert(dbVerifyCheck.rows[0].is_email_verified === true, 'seller_accounts.is_email_verified must be true after OTP verify');
      assert(dbVerifyCheck.rows[0].is_verified === false, 'merchants.is_verified must remain false (OTP does not grant KYC approval)');

      // 2. Backfilled multi-store Owner logs in via phone against seller_accounts
      const multiLogin = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/login',
        body: { identifier: '09810000001', password: 'OwnerPass123!' }
      });
      assert(multiLogin.statusCode === 200, `Backfilled multi-store owner login failed: ${multiLogin.statusCode}`);
      const multiVerify = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/verify-otp',
        body: { email: backfilledOwnerEmail, otp: lastOtp }
      });
      assert(multiVerify.statusCode === 200 && multiVerify.json.stores.length === 2, 'Multi-store owner must receive both owned stores');
      assert(multiVerify.json.sellerAccount?.isEmailVerified === true, 'Fresh OTP verification sets seller_accounts.is_email_verified=true');
      const multiOwnerJwt = multiVerify.json.token as string;
      const multiOwnerAcctId = String(multiVerify.json.sellerAccount.id);

      // Re-running migration after OTP verification must preserve verified Seller Account and both memberships
      const postOtpRerun = await migrateAndBackfillSellerIdentities(merchantPool);
      assert(
        postOtpRerun.sellerAccountsCreated === 0 && postOtpRerun.membershipsCreated === 0,
        'Post-OTP migration rerun must not recreate accounts or memberships'
      );
      const preservedCheck = await merchantPool.query(
        'SELECT is_email_verified FROM seller_accounts WHERE id = $1',
        [multiOwnerAcctId]
      );
      assert(
        preservedCheck.rows[0]?.is_email_verified === true,
        'Migration rerun must preserve OTP-established is_email_verified=true'
      );

      // 3. Provision a Staff Seller Account assigned ONLY to Store 1 of backfilledMultiStoreIds, plus a Suspended membership on Store 2
      const staffPwHash = await bcrypt.hash('StaffPass123!', 10);
      const staffIns = await merchantPool.query(
        `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
         VALUES ('+919855500001', $1, $2, true, 'ACTIVE') RETURNING id`,
        [`staff.s14a.${runId}@example.test`, staffPwHash]
      );
      const staffId = staffIns.rows[0].id as string;
      await merchantPool.query(
        `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status)
         VALUES ($1, $2, 'STAFF', 'ACTIVE'), ($1, $3, 'OWNER', 'SUSPENDED')`,
        [staffId, backfilledMultiStoreIds[0], backfilledMultiStoreIds[1]]
      );
      const staffJwt = jwt.sign(
        { sub: staffId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtSellerAudience, expiresIn: '1h' }
      );

      // Legacy Merchant-ID token rejected everywhere
      const legacyToken = jwt.sign(
        { sub: backfilledMultiStoreIds[0], role: 'SELLER', businessName: 'Old' },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtSellerAudience, expiresIn: '1h' }
      );
      const legacyMe = await httpRequest({ port, method: 'GET', path: '/api/v1/auth/me', headers: { Authorization: `Bearer ${legacyToken}` } });
      assert(legacyMe.statusCode === 401, 'Legacy Merchant-ID token must return 401 on /me');

      // Staff permissions & forged-body resistance against real PostgreSQL
      const staffStore1Inv = await httpRequest({
        port,
        method: 'POST',
        path: `/_live-test/stores/${backfilledMultiStoreIds[0]}/inventory`,
        headers: { Authorization: `Bearer ${staffJwt}` },
        body: { role: 'OWNER' }
      });
      assert(staffStore1Inv.statusCode === 200 && staffStore1Inv.json.role === 'STAFF', 'Staff operational access on Store 1 must succeed with STAFF role');

      const staffStore1StaffMgmt = await httpRequest({
        port,
        method: 'POST',
        path: `/_live-test/stores/${backfilledMultiStoreIds[0]}/staff`,
        headers: { Authorization: `Bearer ${staffJwt}` },
        body: { role: 'OWNER' }
      });
      assert(staffStore1StaffMgmt.statusCode === 403, 'Staff must be denied Owner-only staff management even with forged role=OWNER');

      const staffSuspendedStore2 = await httpRequest({
        port,
        method: 'POST',
        path: `/_live-test/stores/${backfilledMultiStoreIds[1]}/inventory`,
        headers: { Authorization: `Bearer ${staffJwt}` }
      });
      assert(staffSuspendedStore2.statusCode === 403 && staffSuspendedStore2.json.code === 'MEMBERSHIP_INACTIVE', 'Suspended membership must fail 403 MEMBERSHIP_INACTIVE');

      // Store discovery & /me
      const staffStores = await httpRequest({ port, method: 'GET', path: '/api/v1/seller/stores', headers: { Authorization: `Bearer ${staffJwt}` } });
      assert(staffStores.statusCode === 200 && staffStores.json.stores.length === 1 && staffStores.json.stores[0].id === backfilledMultiStoreIds[0], 'Staff /stores must list only active assigned Store 1');

      const ownerMe = await httpRequest({ port, method: 'GET', path: '/api/v1/auth/me', headers: { Authorization: `Bearer ${multiOwnerJwt}` } });
      assert(ownerMe.statusCode === 200 && ownerMe.json.memberships.length === 2, 'Owner /me must list both active memberships');
      assert(!ownerMe.body.includes('password_hash') && !ownerMe.body.includes('isVerified'), '/me must omit password hashes and untrusted isVerified flags');

      // KYC authorization checks against live DB
      const kycStaff = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${staffJwt}` },
        body: { merchantId: backfilledMultiStoreIds[0], documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert(kycStaff.statusCode === 403, 'Staff must receive 403 on KYC upload');

      const kycCrossOwner = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${freshJwt}` },
        body: { merchantId: backfilledMultiStoreIds[0], documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert(kycCrossOwner.statusCode === 403, 'Different Seller Owner must receive 403 STORE_ACCESS_DENIED on another owner store');

      const kycOwner = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${freshJwt}` },
        body: { merchantId: freshStoreId, documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert(kycOwner.statusCode === 503 && kycOwner.json.code === 'KYC_SUBMISSION_UNAVAILABLE', `Expected 503 KYC_SUBMISSION_UNAVAILABLE for authorized Owner, got ${kycOwner.statusCode}`);
    });
  } finally {
    await Promise.allSettled(shutdowns.map((fn) => fn()));
    await Promise.allSettled(pools.map((p) => p.end()));
    if (createdContainers.length > 0) {
      await runDocker(['rm', '-f', ...createdContainers]).catch(() => {});
    }
  }

  console.log('\n=== StreetVerse S1.4-A Live Migration & RBAC Results ===');
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.name} (${r.durationMs}ms)`);
    if (r.error) console.log(`  -> ${r.error}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nSummary: ${passed}/${results.length} S1.4-A live scenarios passed.`);
  if (passed !== results.length) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('[S1.4-A Fatal Error]', err);
  process.exit(1);
});
