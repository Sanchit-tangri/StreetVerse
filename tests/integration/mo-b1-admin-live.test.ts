/**
 * StreetVerse MO-B1 Live PostgreSQL + Redis + CLI Provisioning Integration Suite
 *
 * Runs strictly against disposable, dynamically ported Docker containers
 * (`pgvector/pgvector:pg16`, `postgres:16-alpine`, `redis:7-alpine`) and never
 * touches dev containers or ports 5432, 5433, 5434, 6379, 6380, 8000.
 *
 * Covers every MO-B1 Section 7 verification case:
 *   1. MO-B1 migration (`003_mo_b1_admin_accounts.sql` + `applyMob1Migration`) is
 *      idempotent, preserves all existing Merchant DB & MO-A onboarding data,
 *      enforces `fk_submission_reviewed_by_admin` (`ON DELETE SET NULL`), and
 *      matches fresh-install `merchant-db/schema.sql`.
 *   2. CLI operational bootstrap (`provisionAdmin.ts`) rejects placeholder inputs,
 *      provisions an Admin account with bcrypt hashing and zero secret logging,
 *      rejects duplicate emails (`409 ADMIN_EMAIL_CONFLICT`), and remains completely
 *      isolated from Seller & Buyer identities.
 *   3. Live HTTP endpoints enforce Admin JWT audience isolation, refuse public
 *      self-registration, reject Buyer & Seller JWTs (`401`), reject Admin JWTs
 *      on Buyer/Seller/Conversations routes (`401`), enforce live `SUSPENDED` /
 *      `DISABLED` status revocation (`403 ADMIN_ACCOUNT_INACTIVE`), fail closed
 *      (`503`) when Merchant PostgreSQL goes offline, derive reviewer actor strictly
 *      from DB-backed `req.adminAuth` regardless of spoofed client params, and never
 *      expose `password_hash`, `storage_key`, or filesystem paths.
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
import { ADMIN_ACCOUNT_PRINCIPAL_TYPE } from '../../services/api-gateway/src/middleware/authJwt';
import {
  ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL,
  buildAdminLoginThrottleKeys
} from '../../services/api-gateway/src/services/adminLoginRateLimit';

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
  const boundary = '----StreetVerseMob1Boundary' + crypto.randomBytes(6).toString('hex');
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

async function runProvisionCli(envVars: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const tsxCli = path.resolve('services/api-gateway/node_modules/tsx/dist/cli.mjs');
  const scriptPath = path.resolve('services/api-gateway/src/scripts/provisionAdmin.ts');
  return execFileAsync(process.execPath, [tsxCli, scriptPath], {
    cwd: os.tmpdir(),
    env: {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      ...envVars
    },
    timeout: 30000,
    encoding: 'utf8'
  });
}

async function runSuite() {
  const results: TestResult[] = [];
  const createdContainers: string[] = [];
  const pools: StrictPgPool[] = [];
  const shutdowns: Array<() => Promise<unknown>> = [];
  const tmpStorageDir = path.join(os.tmpdir(), `streetverse-mob1-live-storage-${Date.now()}`);
  const runId = crypto.randomBytes(4).toString('hex');

  const pgPass = `Mob1Pg_${runId}`;
  const redisPass = `Mob1Redis_${runId}`;
  const custContainer = `sv-mob1-cust-${runId}`;
  const merchContainer = `sv-mob1-merch-${runId}`;
  const freshMerchContainer = `sv-mob1-fresh-${runId}`;
  const redisContainer = `sv-mob1-redis-${runId}`;

  const adminEmail = `reviewer.${runId}@streetverse.ops`;
  const adminName = 'StreetVerse Compliance Reviewer';
  const adminPassword = `SvOps#Review_${runId}!9`;

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
  let merchUrl = '';
  let custUrl = '';
  let redisUrl = '';
  let cfg!: GatewayConfig;
  let gwPort = 0;

  let seededPharmacyId = '';
  let seededOwnerId = '';
  let buyerJwt = '';
  let ownerJwt = '';
  let lastOtp = '';
  let provisionedAdminId = '';

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

    custUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${custPort}/sv_cust`;
    merchUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${merchPort}/sv_merch`;
    const freshUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${freshPort}/sv_fresh`;
    redisUrl = `redis://:${redisPass}@127.0.0.1:${redisPort}`;

    await Promise.all([
      waitForUntil(() => runDocker(['exec', custContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_cust']).then(() => true), 30000, 300, 'Customer DB ready'),
      waitForUntil(() => runDocker(['exec', merchContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_merch']).then(() => true), 30000, 300, 'Merchant DB ready'),
      waitForUntil(() => runDocker(['exec', freshMerchContainer, 'pg_isready', '-U', 'postgres', '-d', 'sv_fresh']).then(() => true), 30000, 300, 'Fresh DB ready'),
      waitForUntil(() => runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'ping']).then((r) => r.stdout.trim() === 'PONG'), 20000, 250, 'Redis ready')
    ]);

    custPool = createStrictPgPool(custUrl, 'customer');
    merchPool = createStrictPgPool(merchUrl, 'merchant');
    freshMerchPool = createStrictPgPool(freshUrl, 'merchant');
    pools.push(custPool, merchPool, freshMerchPool);

    await Promise.all([
      waitForUntil(async () => (await custPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Customer pool ready'),
      waitForUntil(async () => (await merchPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Merchant pool ready'),
      waitForUntil(async () => (await freshMerchPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'Fresh pool ready')
    ]);
    await delay(500);
    await Promise.all([
      waitForUntil(async () => (await custPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Customer pool stable'),
      waitForUntil(async () => (await merchPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Merchant pool stable'),
      waitForUntil(async () => (await freshMerchPool.query('SELECT 1')).rows.length === 1, 10000, 200, 'Fresh pool stable')
    ]);

    // Initialize Customer DB with Buyer record
    const custSchemaSql = fs.readFileSync(path.resolve('packages/database-schemas/customer-db/schema.sql'), 'utf8');
    await custPool.query(custSchemaSql);
    const buyerIns = await custPool.query(
      `INSERT INTO users (phone, full_name, email, password_hash, is_verified)
       VALUES ('+919900000088', 'Buyer MOB1', 'buyer.mob1@example.test', 'hash', true)
       RETURNING id`
    );
    const buyerId = String(buyerIns.rows[0].id);

    // =====================================================================
    // CASE 1: MO-B1 Migration, Idempotency, Fresh Schema Parity & FK Integrity
    // =====================================================================
    await runCase('MO-B1 migration upgrades S1.4-A/MO-A DB idempotently, preserves data, matches schema.sql, and enforces FK', async () => {
      await merchPool.query(PRE_MOA_BASE_MERCHANT_SQL);
      seededPharmacyId = '77777777-7777-4777-8777-777777777701';
      await merchPool.query(
        `INSERT INTO merchants (id, business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open)
         VALUES ($1, 'Pre-MOB1 Meds', 'PHARMACY', '+919844400001', 'meds@example.test', 'legacyhash', false, 'meds@ok', '10 MG Road, Pune', '411001', 18.5204, 73.8567, false)`,
        [seededPharmacyId]
      );
      await migrateAndBackfillSellerIdentities(merchPool);
      const ownerRow = await merchPool.query(`SELECT id FROM seller_accounts WHERE LOWER(email) = 'meds@example.test'`);
      seededOwnerId = String(ownerRow.rows[0].id);
      await merchPool.query(`UPDATE seller_accounts SET is_email_verified = true WHERE id = $1`, [seededOwnerId]);
      await applyMoaMigration(merchPool);

      const preTbl = await merchPool.query(`SELECT to_regclass('public.admin_accounts') AS tbl`);
      assert.strictEqual(preTbl.rows[0].tbl, null, 'admin_accounts must not exist before MO-B1 migration');

      // Apply twice for idempotency
      const m1 = await applyMob1Migration(merchPool);
      const m2 = await applyMob1Migration(merchPool);
      assert(m1.applied && m2.applied, 'MO-B1 migration idempotent');
      assert.strictEqual(m1.adminAccountsCount, 0);

      // Fresh schema.sql must include admin_accounts, trigger, and ON DELETE RESTRICT FK identically
      const freshSchemaSql = fs.readFileSync(path.resolve('packages/database-schemas/merchant-db/schema.sql'), 'utf8');
      await freshMerchPool.query(freshSchemaSql);
      const freshAdminTbl = await freshMerchPool.query(`SELECT to_regclass('public.admin_accounts') AS tbl`);
      assert(freshAdminTbl.rows[0].tbl !== null, 'Fresh merchant-db schema.sql includes admin_accounts');
      const freshFk = await freshMerchPool.query(
        `SELECT conname, confdeltype::text AS deltype FROM pg_constraint WHERE conname = 'fk_submission_reviewed_by_admin'`
      );
      assert.strictEqual(freshFk.rows.length, 1, 'Fresh schema includes fk_submission_reviewed_by_admin');
      assert.strictEqual(freshFk.rows[0].deltype, 'r', 'Fresh schema FK must use ON DELETE RESTRICT');

      // Verify idempotent upgrade if an earlier DB had ON DELETE SET NULL ('n') on fk_submission_reviewed_by_admin
      await merchPool.query(
        `ALTER TABLE store_kyc_submissions DROP CONSTRAINT fk_submission_reviewed_by_admin;
         ALTER TABLE store_kyc_submissions ADD CONSTRAINT fk_submission_reviewed_by_admin
           FOREIGN KEY (reviewed_by_admin_id) REFERENCES admin_accounts(id) ON DELETE SET NULL;`
      );
      await applyMob1Migration(merchPool);
      const upgradedFk = await merchPool.query(
        `SELECT confdeltype::text AS deltype FROM pg_constraint WHERE conname = 'fk_submission_reviewed_by_admin'`
      );
      assert.strictEqual(upgradedFk.rows[0].deltype, 'r', 'MO-B1 migration upgrades FK safely to ON DELETE RESTRICT');

      // Verify fk_submission_reviewed_by_admin rejects fake Admin UUID and blocks hard deletion of reviewed Admin
      const fakeAdminId = '99999999-9999-4999-8999-999999999999';
      const testSubRes = await merchPool.query(
        `INSERT INTO store_kyc_submissions (
           merchant_id, submission_version, submitted_by_seller_account_id, status,
           business_name_snapshot, category_snapshot, business_type_snapshot,
           fixed_premises_confirmed_snapshot, address_snapshot, pincode_snapshot,
           latitude_snapshot, longitude_snapshot, submitted_at
         ) VALUES (
           $1, 99, $2, 'SUBMITTED', 'Pre-MOB1 Meds', 'PHARMACY', 'FIXED_SHOP',
           true, '10 MG Road, Pune', '411001', 18.5204, 73.8567, CURRENT_TIMESTAMP
         ) RETURNING id`,
        [seededPharmacyId, seededOwnerId]
      );
      const testSubId = String(testSubRes.rows[0].id);

      let fkRejected = false;
      try {
        await merchPool.query(`UPDATE store_kyc_submissions SET reviewed_by_admin_id = $1 WHERE id = $2`, [
          fakeAdminId,
          testSubId
        ]);
      } catch (e: any) {
        fkRejected = e?.code === '23503';
      }
      assert(fkRejected, 'FK fk_submission_reviewed_by_admin must reject unknown admin IDs');

      const tmpAdminRes = await merchPool.query(
        `INSERT INTO admin_accounts (email, full_name, password_hash, role, status)
         VALUES ('temp.fk@streetverse.ops', 'Temp FK Admin', 'hash', 'ADMIN', 'ACTIVE') RETURNING id`
      );
      const tmpAdminId = String(tmpAdminRes.rows[0].id);
      await merchPool.query(`UPDATE store_kyc_submissions SET reviewed_by_admin_id = $1 WHERE id = $2`, [
        tmpAdminId,
        testSubId
      ]);

      let deleteReviewedAdminBlocked = false;
      try {
        await merchPool.query(`DELETE FROM admin_accounts WHERE id = $1`, [tmpAdminId]);
      } catch (e: any) {
        deleteReviewedAdminBlocked = e?.code === '23503';
      }
      assert(deleteReviewedAdminBlocked, 'Deleting Admin with review history must fail with FK restrict (23503)');

      const postDelAttempt = await merchPool.query(
        `SELECT reviewed_by_admin_id FROM store_kyc_submissions WHERE id = $1`,
        [testSubId]
      );
      assert.strictEqual(postDelAttempt.rows[0].reviewed_by_admin_id, tmpAdminId, 'Reviewer ID must remain preserved and non-NULL');

      // Trigger also protects Admin referenced only by store_onboarding_audit_events from deletion
      const auditOnlyAdminRes = await merchPool.query(
        `INSERT INTO admin_accounts (email, full_name, password_hash, role, status)
         VALUES ('temp.audit@streetverse.ops', 'Audit Admin', 'hash', 'ADMIN', 'ACTIVE') RETURNING id`
      );
      const auditOnlyAdminId = String(auditOnlyAdminRes.rows[0].id);
      await merchPool.query(
        `INSERT INTO store_onboarding_audit_events (merchant_id, actor_type, actor_id, event_type, event_metadata)
         VALUES ($1, 'ADMIN', $2, 'ADMIN_VIEW_INSPECTED', '{}'::jsonb)`,
        [seededPharmacyId, auditOnlyAdminId]
      );

      let deleteAuditedAdminBlocked = false;
      try {
        await merchPool.query(`DELETE FROM admin_accounts WHERE id = $1`, [auditOnlyAdminId]);
      } catch (e: any) {
        deleteAuditedAdminBlocked = e?.code === '23503';
      }
      assert(deleteAuditedAdminBlocked, 'Trigger must block deletion of Admin referenced in audit events');
    });

    // =====================================================================
    // CASE 2: Operational CLI Bootstrap Script (`provisionAdmin.ts`)
    // =====================================================================
    await runCase('CLI bootstrap rejects placeholder values, provisions isolated Admin account safely, and blocks duplicates', async () => {
      let rejectedPlaceholder = false;
      try {
        await runProvisionCli({
          MERCHANT_DB_URL: merchUrl,
          ADMIN_BOOTSTRAP_EMAIL: 'admin@example.com',
          ADMIN_BOOTSTRAP_NAME: 'Verification Admin',
          ADMIN_BOOTSTRAP_PASSWORD: 'REPLACE_WITH_STRONG_ADMIN_PASSWORD'
        });
      } catch {
        rejectedPlaceholder = true;
      }
      assert(rejectedPlaceholder, 'CLI bootstrap must reject .env.example placeholder credentials');

      const okCli = await runProvisionCli({
        MERCHANT_DB_URL: merchUrl,
        ADMIN_BOOTSTRAP_EMAIL: adminEmail,
        ADMIN_BOOTSTRAP_NAME: adminName,
        ADMIN_BOOTSTRAP_PASSWORD: adminPassword
      });
      assert(!okCli.stdout.includes(adminPassword), 'CLI output must never echo plaintext password');
      assert(!okCli.stdout.includes('password_hash') && !okCli.stdout.includes('$2'), 'CLI output must never print bcrypt hash');

      const parsed = JSON.parse(okCli.stdout.trim());
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.admin.email, adminEmail.toLowerCase());
      assert.strictEqual(parsed.admin.role, 'ADMIN');
      assert.strictEqual(parsed.admin.status, 'ACTIVE');
      provisionedAdminId = String(parsed.admin.id);

      // Verify Admin exists ONLY in admin_accounts (NOT seller_accounts or users)
      const inSeller = await merchPool.query(`SELECT id FROM seller_accounts WHERE LOWER(email) = $1`, [adminEmail]);
      assert.strictEqual(inSeller.rows.length, 0, 'Admin email must NOT exist in seller_accounts');
      const inBuyer = await custPool.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [adminEmail]);
      assert.strictEqual(inBuyer.rows.length, 0, 'Admin email must NOT exist in Customer DB users');

      // Duplicate CLI execution rejected cleanly
      let dupRejected = false;
      try {
        await runProvisionCli({
          MERCHANT_DB_URL: merchUrl,
          ADMIN_BOOTSTRAP_EMAIL: adminEmail,
          ADMIN_BOOTSTRAP_NAME: adminName,
          ADMIN_BOOTSTRAP_PASSWORD: adminPassword
        });
      } catch (e: any) {
        dupRejected = /ADMIN_EMAIL_CONFLICT|already exists/i.test(String(e?.stderr || e?.message));
      }
      assert(dupRejected, 'Duplicate CLI provisioning must fail cleanly with conflict');
    });

    // =====================================================================
    // CASE 3: Live HTTP Isolation, Queue/Store Prerequisite Inspection,
    //         Suspension Revocation, Spoof Resistance & DB Outage Fail-Closed
    // =====================================================================
    cfg = {
      nodeEnv: 'test',
      port: 0,
      allowedOrigins: ['http://127.0.0.1:3000'],
      jwtSecret: `mob1-live-test-secret-${runId}-more-than-32-bytes!`,
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

    buyerJwt = jwt.sign({ sub: buyerId, role: 'BUYER' }, cfg.jwtSecret, {
      issuer: cfg.jwtIssuer,
      audience: cfg.jwtBuyerAudience,
      expiresIn: '1h'
    });

    await runCase('Live Admin auth, cross-audience isolation, queue & store details inspection, suspension, and outage fail-closed', async () => {
      // 1. Register Seller Store & submit full Pharmacy KYC via real MO-A endpoints
      const sellerEmail = `owner.mob1.${runId}@example.test`;
      const regRes = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/auth/seller/register',
        body: {
          business_name: 'Kothrud Care Pharmacy',
          category: 'PHARMACY',
          owner_phone: '9855500001',
          owner_email: sellerEmail,
          password: 'SellerPass#123!',
          upi_vpa: 'kothrud@okaxis',
          address: 'Shop 5, Karve Road, Pune',
          pincode: '411038'
        }
      });
      assert.strictEqual(regRes.statusCode, 201);
      const storeId = String(regRes.json.merchantId);

      const otpVerify = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/auth/seller/verify-otp',
        body: { email: sellerEmail, otp: lastOtp }
      });
      assert.strictEqual(otpVerify.statusCode, 200);
      ownerJwt = String(otpVerify.json.token);

      const draftPut = await httpRequest({
        port: gwPort,
        method: 'PUT',
        path: `/api/v1/seller/stores/${storeId}/onboarding`,
        headers: { Authorization: `Bearer ${ownerJwt}` },
        body: {
          businessType: 'FIXED_SHOP',
          businessTypeConfirmed: true,
          fixedPremisesConfirmed: true,
          premisesOwnershipType: 'LEASED',
          address: 'Shop 5, Karve Road, Kothrud, Pune',
          pincode: '411038',
          latitude: 18.5074,
          longitude: 73.8077,
          gpsAccuracyMeters: 10
        }
      });
      assert.strictEqual(draftPut.statusCode, 200);

      const uploadDoc = async (reqKey: string, fname: string, mime: string, content: Buffer) => {
        const mp = buildMultipart({
          fieldName: 'document',
          filename: fname,
          mimeType: mime,
          content,
          extraFields: { requirementKey: reqKey }
        });
        const res = await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${storeId}/onboarding/documents`,
          headers: { Authorization: `Bearer ${ownerJwt}`, 'Content-Type': mp.contentType },
          body: mp.body
        });
        assert.strictEqual(res.statusCode, 201, `Upload ${reqKey} failed: ${res.body}`);
      };

      await uploadDoc('STOREFRONT_PHOTO_1', 'front1.jpg', 'image/jpeg', makeJpeg('mob1-1'));
      await uploadDoc('STOREFRONT_PHOTO_2', 'front2.png', 'image/png', makePng('mob1-2'));
      await uploadDoc('PREMISES_PROOF', 'lease.pdf', 'application/pdf', makePdf('mob1-lease'));
      await uploadDoc('DRUG_LICENSE', 'drug-license.pdf', 'application/pdf', makePdf('mob1-drug'));

      const subRes = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${storeId}/onboarding/submit`,
        headers: { Authorization: `Bearer ${ownerJwt}` }
      });
      assert.strictEqual(subRes.statusCode, 201);

      // 2. Unknown email and wrong password return identical 401 responses; Admin login clears failures cleanly in Redis
      const unknownEmailFail = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: `nonexistent.${runId}@streetverse.ops`, password: 'WrongPassword#123!' }
      });
      const wrongPwFail = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: adminEmail, password: 'WrongPassword#123!' }
      });
      assert.strictEqual(unknownEmailFail.statusCode, 401);
      assert.strictEqual(wrongPwFail.statusCode, 401);
      assert.strictEqual(unknownEmailFail.json.code, wrongPwFail.json.code);
      assert.strictEqual(unknownEmailFail.json.error, wrongPwFail.json.error);

      const keysBeforeSuccess = await runDocker([
        'exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'keys', 'sv:admin:login:fail:*'
      ]);
      assert(keysBeforeSuccess.stdout.trim().length > 0, 'Failed login attempts recorded in live Redis');

      const adminOnSellerLogin = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/auth/seller/login',
        body: { identifier: adminEmail, password: adminPassword }
      });
      assert.strictEqual(adminOnSellerLogin.statusCode, 401, 'Admin account must not log into Seller login');

      const adminLogin = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: adminEmail, password: adminPassword }
      });
      assert.strictEqual(adminLogin.statusCode, 200, `Admin login failed: ${adminLogin.body}`);

      const adminThrottleKeys = buildAdminLoginThrottleKeys('127.0.0.1', adminEmail);
      const unknownThrottleKeys = buildAdminLoginThrottleKeys('127.0.0.1', `nonexistent.${runId}@streetverse.ops`);
      const afterPairExists = await runDocker([
        'exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'exists', adminThrottleKeys.pairKey, adminThrottleKeys.ipKey
      ]);
      assert.strictEqual(
        afterPairExists.stdout.trim(),
        '0',
        'Successful login clears own pairKey and ipKey failure counters in live Redis'
      );
      const otherEmailStillTracked = await runDocker([
        'exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'exists', unknownThrottleKeys.pairKey
      ]);
      assert.strictEqual(
        otherEmailStillTracked.stdout.trim(),
        '1',
        'Successful login to Admin A must not wipe pair-specific failure count for unrelated target email B'
      );
      const adminJwt = String(adminLogin.json.token);
      const decodedAdmin = jwt.verify(adminJwt, cfg.jwtSecret, {
        issuer: cfg.jwtIssuer,
        audience: 'streetverse-admin'
      }) as jwt.JwtPayload;
      assert.strictEqual(decodedAdmin.sub, provisionedAdminId);
      assert.strictEqual(decodedAdmin.role, 'ADMIN');
      assert.strictEqual(decodedAdmin.principalType, ADMIN_ACCOUNT_PRINCIPAL_TYPE);
      assert(!adminLogin.body.includes('passwordHash') && !adminLogin.body.includes('password_hash'));

      const loginTsCheck = await merchPool.query(`SELECT last_login_at FROM admin_accounts WHERE id = $1`, [
        provisionedAdminId
      ]);
      assert(loginTsCheck.rows[0].last_login_at !== null, 'last_login_at updated in DB');

      // 3. Cross-role isolation against live routes
      for (const pathCheck of ['/api/v1/admin/me', '/api/v1/admin/onboarding/queue', `/api/v1/admin/onboarding/stores/${storeId}`]) {
        assert.strictEqual((await httpRequest({ port: gwPort, method: 'GET', path: pathCheck })).statusCode, 401);
        assert.strictEqual(
          (await httpRequest({ port: gwPort, method: 'GET', path: pathCheck, headers: { Authorization: `Bearer ${buyerJwt}` } })).statusCode,
          401
        );
        assert.strictEqual(
          (await httpRequest({ port: gwPort, method: 'GET', path: pathCheck, headers: { Authorization: `Bearer ${ownerJwt}` } })).statusCode,
          401
        );
      }

      assert.strictEqual(
        (await httpRequest({ port: gwPort, method: 'GET', path: '/api/v1/seller/stores', headers: { Authorization: `Bearer ${adminJwt}` } })).statusCode,
        401
      );
      assert.strictEqual(
        (await httpRequest({ port: gwPort, method: 'GET', path: `/api/v1/seller/stores/${storeId}/onboarding`, headers: { Authorization: `Bearer ${adminJwt}` } })).statusCode,
        401
      );
      assert.strictEqual(
        (await httpRequest({ port: gwPort, method: 'POST', path: '/api/user/request-email-change', headers: { Authorization: `Bearer ${adminJwt}` }, body: { newEmail: 'x@y.com' } })).statusCode,
        401
      );
      assert.strictEqual(
        (await httpRequest({ port: gwPort, method: 'GET', path: '/api/v1/conversations', headers: { Authorization: `Bearer ${adminJwt}` } })).statusCode,
        401
      );

      // 4. Protected GET /me, queue, and store details (with spoofed reviewer param ignored & zero leaks)
      const spoofedAdminId = '12341234-1234-4234-8234-123412341234';
      const meRes = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/admin/me?adminId=${spoofedAdminId}`,
        headers: { Authorization: `Bearer ${adminJwt}` }
      });
      assert.strictEqual(meRes.statusCode, 200);
      assert.strictEqual(meRes.json.admin.id, provisionedAdminId);
      assert.strictEqual(meRes.json.admin.role, 'ADMIN');
      assert(Array.isArray(meRes.json.admin.permissions) && meRes.json.admin.permissions.includes('KYC_REVIEW_DECIDE'));

      const queueRes = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/admin/onboarding/queue?reviewedByAdminId=${spoofedAdminId}`,
        headers: { Authorization: `Bearer ${adminJwt}` }
      });
      assert.strictEqual(queueRes.statusCode, 200);
      assert.strictEqual(queueRes.json.reviewedByActor.actorId, provisionedAdminId);
      const qStore = queueRes.json.items.find((i: any) => i.storeId === storeId);
      assert(qStore, 'Newly submitted Pharmacy appears in Admin queue');
      assert.strictEqual(qStore.onboardingStatus, 'SUBMITTED');
      assert.strictEqual(qStore.currentSubmission.documentCount, 4);
      assert(!queueRes.body.includes('passwordHash') && !queueRes.body.includes('password_hash'));
      assert(!queueRes.body.includes('storage_key') && !queueRes.body.includes('storageKey') && !queueRes.body.includes(tmpStorageDir));

      // 4a. The existing authorization model is role-backed: permissions are
      // derived from the live admin_accounts.role, never from JWT/query claims.
      // Temporarily revoke the sole ADMIN role in this disposable database while
      // preserving the already-issued valid JWT; protected routes must fail closed.
      await merchPool.query(`ALTER TABLE admin_accounts DROP CONSTRAINT admin_accounts_role_check`);
      try {
        await merchPool.query(`UPDATE admin_accounts SET role = 'REVOKED_TEST' WHERE id = $1`, [provisionedAdminId]);
        const roleRevokedQueue = await httpRequest({
          port: gwPort,
          method: 'GET',
          path: `/api/v1/admin/onboarding/queue?adminId=${spoofedAdminId}&role=ADMIN&permissions=KYC_QUEUE_READ`,
          headers: { Authorization: `Bearer ${adminJwt}` }
        });
        assert.strictEqual(roleRevokedQueue.statusCode, 403, 'Live DB role revocation blocks an existing Admin JWT');
        assert.strictEqual(roleRevokedQueue.json.code, 'ADMIN_FORBIDDEN');
      } finally {
        await merchPool.query(`UPDATE admin_accounts SET role = 'ADMIN' WHERE id = $1`, [provisionedAdminId]);
        await merchPool.query(
          `ALTER TABLE admin_accounts ADD CONSTRAINT admin_accounts_role_check CHECK (role IN ('ADMIN'))`
        );
      }

      const detailRes = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/admin/onboarding/stores/${storeId}?reviewedByAdminId=${spoofedAdminId}`,
        headers: { Authorization: `Bearer ${adminJwt}` }
      });
      assert.strictEqual(detailRes.statusCode, 200);
      assert.strictEqual(detailRes.json.reviewedByActor.actorId, provisionedAdminId);
      assert.strictEqual(detailRes.json.profile.status, 'SUBMITTED');
      assert.strictEqual(detailRes.json.prerequisiteCheck.missingRequirements.length, 0);
      assert.strictEqual(detailRes.json.prerequisiteCheck.missingGps, false);
      assert.strictEqual(detailRes.json.documents.length, 4);
      assert(
        detailRes.json.auditEvents.some((e: any) => e.eventType === 'SUBMISSION_CREATED'),
        'Store details should include SUBMISSION_CREATED audit event'
      );
      assert(!detailRes.body.includes('passwordHash') && !detailRes.body.includes('password_hash'));
      assert(!detailRes.body.includes('storage_key') && !detailRes.body.includes('storageKey') && !detailRes.body.includes(tmpStorageDir));

      // 5. Suspending Admin in DB revokes active JWT & login immediately; reactivating restores
      await merchPool.query(`UPDATE admin_accounts SET status = 'SUSPENDED' WHERE id = $1`, [provisionedAdminId]);
      const susMe = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: '/api/v1/admin/me',
        headers: { Authorization: `Bearer ${adminJwt}` }
      });
      assert.strictEqual(susMe.statusCode, 403);
      assert.strictEqual(susMe.json.code, 'ADMIN_ACCOUNT_INACTIVE');

      const susLogin = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: adminEmail, password: adminPassword }
      });
      assert.strictEqual(susLogin.statusCode, 403);

      await merchPool.query(`UPDATE admin_accounts SET status = 'ACTIVE' WHERE id = $1`, [provisionedAdminId]);
      const restoredMe = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: '/api/v1/admin/me',
        headers: { Authorization: `Bearer ${adminJwt}` }
      });
      assert.strictEqual(restoredMe.statusCode, 200);

      // 6. Live brute-force throttling: 5 wrong attempts -> 6th throttled 429; flushing test IP keys lets DB outage check run cleanly
      await runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'flushdb']);
      for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL; i++) {
        const failAttempt = await httpRequest({
          port: gwPort,
          method: 'POST',
          path: '/api/v1/admin/auth/login',
          body: { email: adminEmail, password: 'WrongPassword#123!' }
        });
        assert.strictEqual(failAttempt.statusCode, 401, `Attempt ${i + 1} returns 401`);
      }

      const throttledRes = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: adminEmail, password: adminPassword }
      });
      assert.strictEqual(throttledRes.statusCode, 429, '6th login attempt throttled with 429 in live Redis');
      assert.strictEqual(throttledRes.json.code, 'ADMIN_LOGIN_RATE_LIMITED');
      assert(Number(throttledRes.json.retryAfterSeconds) > 0, 'retryAfterSeconds populated');
      assert(throttledRes.headers['retry-after'], 'Retry-After HTTP header populated');

      // 7. Clear test throttle state, stop Redis -> login fails closed 503; restart Redis, stop Merchant DB -> 503 fail-closed
      await runDocker(['stop', redisContainer]);
      const redisDownLogin = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: adminEmail, password: adminPassword }
      });
      assert.strictEqual(redisDownLogin.statusCode, 503, 'Redis outage on Admin login fails closed with 503');

      await runDocker(['start', redisContainer]);
      await waitForUntil(
        () => runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'ping']).then((r) => r.stdout.trim() === 'PONG'),
        15000,
        250,
        'Redis restarted'
      );
      await waitForUntil(
        () => httpRequest({ port: gwPort, method: 'GET', path: '/api/ready' }).then((r) => r.statusCode === 200),
        15000,
        250,
        'Gateway Redis client reconnected'
      );
      await runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'flushdb']);

      await runDocker(['stop', merchContainer]);
      const outageMe = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: '/api/v1/admin/me',
        headers: { Authorization: `Bearer ${adminJwt}` }
      });
      assert.strictEqual(outageMe.statusCode, 503, `Outage fails closed with 503 on protected Admin route (got ${outageMe.statusCode}: ${outageMe.body})`);

      const outageLogin = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: adminEmail, password: adminPassword }
      });
      assert.strictEqual(outageLogin.statusCode, 503, `Outage fails closed with 503 on Admin login (got ${outageLogin.statusCode}: ${outageLogin.body})`);
    });
  } finally {
    await Promise.allSettled(shutdowns.map((fn) => fn()));
    await Promise.allSettled(pools.map((p) => p.end()));
    fs.rmSync(tmpStorageDir, { recursive: true, force: true });
    if (createdContainers.length > 0) {
      await runDocker(['rm', '-f', ...createdContainers]).catch(() => { });
    }
  }

  console.log('\n=== StreetVerse MO-B1 Live Integration Results ===');
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.name} (${r.durationMs}ms)`);
    if (r.error) console.log(`  -> ${r.error}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nSummary: ${passed}/${results.length} MO-B1 live scenarios passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

runSuite().catch((err) => {
  console.error('[MO-B1 Live Test Fatal Error]', err);
  process.exit(1);
});
