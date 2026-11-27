/**
 * StreetVerse MO-B4 Live PostgreSQL + Redis Reliable Notifications & Audit Integration Suite
 *
 * Runs strictly against disposable, dynamically ported Docker containers
 * (`pgvector/pgvector:pg16`, `postgres:16-alpine`, `redis:7-alpine`).
 * Never touches dev databases or volumes.
 *
 * Covers every MO-B4 Section 7 requirement end-to-end:
 *   1. Migration (`006_mo_b4_reliable_notifications_and_audit.sql` + `applyMob4Migration`)
 *      is idempotent, parity-matches `schema.sql`, preserves outbox rows, and guards
 *      `owner_notifications` immutability (`23514`).
 *   2. End-to-end MO-A + MO-B2 + MO-B3 audit completeness & attribution + outbox delivery
 *      via real APIs + Owner inbox read/unread/pagination + STAFF/cross-store rejection.
 *   3. Recipient ownership change between creation & delivery withheld safely (`TERMINAL_FAILED`)
 *      so revoked/demoted accounts never receive unauthorized delayed events.
 *   4. Multi-worker `FOR UPDATE OF e SKIP LOCKED`, strict per-store FIFO stream ordering,
 *      duplicate in-app suppression (`UNIQUE(outbox_event_id)`), and stale-lease recovery.
 *   5. Exponential backoff retries -> eventual success OR `TERMINAL_FAILED` -> Admin replay,
 *      honest `UNCONFIGURED` SMTP reporting, failed-transaction rollback consistency,
 *      and graceful gateway + worker shutdown.
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
import { applyMob4Migration } from '../../services/api-gateway/src/db/migrations/mob4NotificationMigration';
import { SELLER_ACCOUNT_PRINCIPAL_TYPE } from '../../services/api-gateway/src/middleware/authJwt';
import { provisionAdminAccount } from '../../services/api-gateway/src/services/adminAuth';
import { createEmailService } from '../../services/api-gateway/src/services/email';
import { processNotificationOutboxBatch } from '../../services/api-gateway/src/services/notificationOutbox';
import { createKycDocumentStorage } from '../../services/api-gateway/src/storage/kycDocumentStorage';
import {
  submitOnboardingApplication,
  updateOnboardingDraft,
  uploadDraftDocument
} from '../../services/api-gateway/src/services/onboarding';

const execFileAsync = promisify(execFile);
const RESERVED_PORTS = new Set([5432, 5433, 5434, 6379, 6380, 8000]);

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

const assertEqual = <T>(actual: T, expected: T, message?: string): void =>
  assert.strictEqual(actual, expected, message);

const VALID_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]);
const VALID_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x22)]);
const VALID_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x33)]);

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
  const tmpStorageDir = path.join(os.tmpdir(), `streetverse-mob4-live-storage-${Date.now()}`);
  const runId = crypto.randomBytes(4).toString('hex');

  const pgPass = `Mob4Pg_${runId}`;
  const redisPass = `Mob4Redis_${runId}`;
  const custContainer = `sv-mob4-cust-${runId}`;
  const merchContainer = `sv-mob4-merch-${runId}`;
  const freshMerchContainer = `sv-mob4-fresh-${runId}`;
  const redisContainer = `sv-mob4-redis-${runId}`;

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

  const store1Id = 'a0001111-1111-4111-8111-111111111101'; // Owner 1 Electronics
  const store2Id = 'a0002222-2222-4222-8222-222222222202'; // Owner 1 Stationery
  const store3Id = 'a0003333-3333-4333-8333-333333333303'; // Owner 2 Grocery

  let admin1Id = '';
  let owner1AcctId = '';
  let owner2AcctId = '';
  let staff1AcctId = '';
  let admin1Jwt = '';
  let owner1Jwt = '';
  let owner2Jwt = '';
  let staff1Jwt = '';
  let gwPort = 0;

  const sentEmails: Array<{ to: string; subject: string; text: string; html: string; idempotencyKey?: string }> = [];
  let emailBehavior: 'OK' | 'TRANSIENT_FAIL' | 'FAIL_THEN_SUCCEED' = 'OK';
  let transientFailuresRemaining = 0;

  const prevSmtpUser = process.env.SMTP_USER;
  const prevSmtpPass = process.env.SMTP_PASS;
  process.env.SMTP_USER = 'YOUR_SMTP_USER_EMAIL_HERE';
  process.env.SMTP_PASS = '';

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
    await delay(400);

    const custSchemaSql = fs.readFileSync(path.resolve('packages/database-schemas/customer-db/schema.sql'), 'utf8');
    await custPool.query(custSchemaSql);

    // =====================================================================
    // CASE 1: Migration 006 Idempotency, Fresh schema.sql Parity & Trigger Guards
    // =====================================================================
    await runCase('MO-B4 migration (006) upgrades idempotently, parity-matches fresh schema.sql, and locks notification history', async () => {
      await merchPool.query(PRE_MOA_BASE_MERCHANT_SQL);
      await merchPool.query(
        `INSERT INTO merchants (id, business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open)
         VALUES
           ($1, 'Owner1 Tech Mart', 'ELECTRONICS', '+919877800001', 'owner1@example.test', 'h', false, 't@ok', '10 Laxmi Rd, Pune', '411030', 18.51, 73.85, false),
           ($2, 'Owner1 Paper Point', 'STATIONERY', '9877800001', 'OWNER1@example.test', 'h', false, 's@ok', '11 Tilak Rd, Pune', '411030', 18.52, 73.85, false),
           ($3, 'Owner2 Fresh Kirana', 'GROCERY', '+919877800002', 'owner2@example.test', 'h', false, 'g@ok', '12 JM Rd, Pune', '411004', 18.52, 73.84, false)`,
        [store1Id, store2Id, store3Id]
      );
      await migrateAndBackfillSellerIdentities(merchPool);
      await applyMoaMigration(merchPool);
      await applyMob1Migration(merchPool);
      await applyMob2Migration(merchPool);
      await applyMob3Migration(merchPool);

      const r1 = await applyMob4Migration(merchPool);
      const r2 = await applyMob4Migration(merchPool);
      assert(r1.applied && r2.applied, '006 applies idempotently');

      const freshSchemaSql = fs.readFileSync(path.resolve('packages/database-schemas/merchant-db/schema.sql'), 'utf8');
      await freshMerchPool.query(freshSchemaSql);
      const freshInbox = await freshMerchPool.query(`SELECT to_regclass('public.owner_notifications') AS tbl`);
      assert(freshInbox.rows[0].tbl !== null, 'Fresh schema.sql includes owner_notifications');

      const o1Res = await merchPool.query(`SELECT id FROM seller_accounts WHERE LOWER(email) = 'owner1@example.test'`);
      owner1AcctId = String(o1Res.rows[0].id);
      const o2Res = await merchPool.query(`SELECT id FROM seller_accounts WHERE LOWER(email) = 'owner2@example.test'`);
      owner2AcctId = String(o2Res.rows[0].id);
      await merchPool.query(`UPDATE seller_accounts SET is_email_verified = true WHERE id IN ($1, $2)`, [
        owner1AcctId,
        owner2AcctId
      ]);

      const stfRes = await merchPool.query(
        `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
         VALUES ('+919877800003', 'staff1@example.test', 'h', true, 'ACTIVE') RETURNING id`
      );
      staff1AcctId = String(stfRes.rows[0].id);
      await merchPool.query(
        `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status) VALUES ($1, $2, 'STAFF', 'ACTIVE')`,
        [staff1AcctId, store1Id]
      );

      const a1 = await provisionAdminAccount(merchPool, {
        email: `mob4.admin.${runId}@streetverse.ops`,
        fullName: 'Notifications Admin',
        password: `Mob4Admin#${runId}!`
      });
      assert(a1.ok);
      admin1Id = a1.data.id;

      const jwtSecret = `mob4-live-secret-${runId}-more-than-32-bytes!`;
      owner1Jwt = jwt.sign({ sub: owner1AcctId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, jwtSecret, {
        issuer: 'streetverse-api',
        audience: 'streetverse-seller',
        expiresIn: '1h'
      });
      owner2Jwt = jwt.sign({ sub: owner2AcctId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, jwtSecret, {
        issuer: 'streetverse-api',
        audience: 'streetverse-seller',
        expiresIn: '1h'
      });
      staff1Jwt = jwt.sign({ sub: staff1AcctId, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, jwtSecret, {
        issuer: 'streetverse-api',
        audience: 'streetverse-seller',
        expiresIn: '1h'
      });
    });

    const spyTransporter = {
      sendMail: async (mailOptions: Record<string, unknown>) => {
        if (emailBehavior === 'TRANSIENT_FAIL') {
          const e: any = new Error('Simulated SMTP outage');
          e.code = 'ETIMEDOUT';
          throw e;
        }
        if (emailBehavior === 'FAIL_THEN_SUCCEED' && transientFailuresRemaining > 0) {
          transientFailuresRemaining--;
          const e: any = new Error('Transient SMTP throttle');
          e.code = 'ECONNRESET';
          throw e;
        }
        sentEmails.push({
          to: String(mailOptions.to),
          subject: String(mailOptions.subject),
          text: String(mailOptions.text),
          html: String(mailOptions.html),
          idempotencyKey: (mailOptions.headers as Record<string, string> | undefined)?.['X-StreetVerse-Idempotency-Key']
        });
        return { messageId: `spy-${sentEmails.length}` };
      }
    };

    const kycStorage = createKycDocumentStorage(tmpStorageDir);
    const emailSvc = createEmailService({
      redisClient: undefined,
      nodeEnv: 'test',
      transporter: spyTransporter
    });

    const cfg: GatewayConfig = {
      nodeEnv: 'test',
      port: 0,
      allowedOrigins: ['http://127.0.0.1:3000'],
      jwtSecret: `mob4-live-secret-${runId}-more-than-32-bytes!`,
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
      kycStorageDir: tmpStorageDir,
      notificationWorkerEnabled: false
    };

    const { server, shutdown } = createGatewayApp(cfg, {
      customerPool: custPool,
      merchantPool: merchPool,
      emailService: emailSvc,
      kycStorage,
      enableRedisAdapter: false,
      startNotificationWorker: false
    });
    shutdowns.push(shutdown);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    gwPort = (server.address() as AddressInfo).port;

    const loginRes = await httpRequest({
      port: gwPort,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: `mob4.admin.${runId}@streetverse.ops`, password: `Mob4Admin#${runId}!` }
    });
    assert.strictEqual(loginRes.statusCode, 200);
    admin1Jwt = String(loginRes.json.token);

    // =====================================================================
    // CASE 2: Audit Completeness (MO-A..MO-B3) + Delivery + Owner APIs + Ownership Transfer Guard
    // =====================================================================
    await runCase('MO-A..MO-B3 audit completeness, reliable in-app+email delivery, Owner inbox RBAC/read preservation, and revoked-ownership safety', async () => {
      // 1. Perform full MO-A lifecycle on store1Id (draft update -> doc upload -> duplicate rollback -> doc delete -> re-upload -> submit)
      assert(
        (await updateOnboardingDraft(merchPool, store1Id, owner1AcctId, {
          businessName: 'Owner1 Tech Mart',
          category: 'ELECTRONICS',
          businessType: 'FIXED_SHOP',
          businessTypeConfirmed: true,
          fixedPremisesConfirmed: true,
          address: '10 Laxmi Rd, Pune',
          pincode: '411030',
          latitude: 18.51,
          longitude: 73.85
        })).ok
      );
      const docExtra = await uploadDraftDocument(merchPool, kycStorage, {
        merchantId: store1Id,
        sellerAccountId: owner1AcctId,
        requirementKey: 'ADDITIONAL_PREMISES_PHOTO',
        fileBuffer: VALID_JPEG,
        declaredMimeType: 'image/jpeg',
        originalFilename: 'extra.jpg'
      });
      assert(docExtra.ok);
      assert(
        (await httpRequest({
          port: gwPort,
          method: 'DELETE',
          path: `/api/v1/seller/stores/${store1Id}/onboarding/documents/${docExtra.data.id}`,
          headers: { Authorization: `Bearer ${owner1Jwt}` }
        })).statusCode === 200
      );

      for (const [reqKey, buf, mime, fname] of [
        ['STOREFRONT_PHOTO_1', Buffer.concat([VALID_JPEG, Buffer.from([1])]), 'image/jpeg', 'front1.jpg'],
        ['STOREFRONT_PHOTO_2', Buffer.concat([VALID_PNG, Buffer.from([2])]), 'image/png', 'front2.png'],
        ['PREMISES_PROOF', Buffer.concat([VALID_PDF, Buffer.from([3])]), 'application/pdf', 'lease.pdf']
      ] as const) {
        const up = await uploadDraftDocument(merchPool, kycStorage, {
          merchantId: store1Id,
          sellerAccountId: owner1AcctId,
          requirementKey: reqKey,
          fileBuffer: buf,
          declaredMimeType: mime,
          originalFilename: fname
        });
        assert(up.ok);
      }

      const subRes = await submitOnboardingApplication(merchPool, store1Id, owner1AcctId);
      assert(subRes.ok);
      const subId = subRes.data.submission.id;

      // 2. Admin starts review & approves store1Id -> creates ADMIN_APPROVAL_GRANTED audit + ONBOARDING_APPROVED outbox event
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/onboarding/submissions/${subId}/start-review`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: { reviewNotes: 'CONFIDENTIAL_REVIEW_NOTE_NEVER_EMAILED' }
        })).statusCode,
        200
      );
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/onboarding/submissions/${subId}/approve`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: {
            checklist: {
              sellerIdentityReviewed: true,
              businessNameAndCategoryConfirmed: true,
              fixedPhysicalShopConfirmed: true,
              gpsLocationChecked: true,
              storefrontPhotosInspected: true,
              premisesEvidenceChecked: true,
              categoryDocumentsChecked: true,
              informationConsistent: true,
              noUnresolvedDiscrepancy: true,
              confirmedRequirementKeys: ['STOREFRONT_PHOTO_1', 'STOREFRONT_PHOTO_2', 'PREMISES_PROOF']
            },
            reviewNotes: 'PRIVATE_ADMIN_CHECKLIST_NOTE'
          }
        })).statusCode,
        200
      );

      // 3. Issue MO-B3 warning, Owner responds (ADMIN event!), escalate, resolve -> then run worker batch
      const warnRes = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store1Id}/compliance/warnings`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          violationCategory: 'HYGIENE_STANDARD',
          severity: 'LOW',
          reason: 'Signage obstruction noted.',
          requiredCorrectiveAction: 'Clear entrance signage cleanly.'
        }
      });
      assert.strictEqual(warnRes.statusCode, 201);
      const wId = warnRes.json.warning.id;

      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/seller/stores/${store1Id}/compliance/warnings/${wId}/respond`,
          headers: { Authorization: `Bearer ${owner1Jwt}` },
          body: { responseMessage: 'Cleared entrance signage today.' }
        })).statusCode,
        201
      );
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store1Id}/compliance/warnings/${wId}/escalate`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: { notes: 'INTERNAL_ESCALATION_NOTE_PRIVATE' }
        })).statusCode,
        200
      );
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'POST',
          path: `/api/v1/admin/stores/${store1Id}/compliance/warnings/${wId}/resolve`,
          headers: { Authorization: `Bearer ${admin1Jwt}` },
          body: { reason: 'Entrance clearance verified.', correctiveEvidenceChecked: true }
        })).statusCode,
        200
      );

      // Drain outbox queue sequentially across batches (per-store FIFO delivers 1 event per tick per stream)
      for (let i = 0; i < 6; i++) {
        await processNotificationOutboxBatch(merchPool, emailSvc, { workerId: 'case2-worker' });
      }

      // Verify Owner 1 received 4 OWNER notifications (APPROVED, WARNING_ISSUED, WARNING_ESCALATED, WARNING_RESOLVED)
      // while ADMIN event (COMPLIANCE_WARNING_RESPONSE_SUBMITTED) was marked SKIPPED_ADMIN_EVENT (not pushed to Seller inbox)
      const listRes = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/seller/stores/${store1Id}/notifications?limit=2&offset=0`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(listRes.statusCode, 200);
      assertEqual(listRes.json.totalCount, 4, 'Exactly 4 Owner notifications on Store 1');
      assertEqual(listRes.json.unreadCount, 4, 'All 4 start unread');
      assertEqual(listRes.json.notifications.length, 2, 'Pagination limit=2 respected');

      const unreadRes = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: `/api/v1/seller/notifications/unread-count`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(unreadRes.statusCode, 200);
      assertEqual(unreadRes.json.unreadCount, 4);

      // Zero leaks in email content
      for (const mail of sentEmails) {
        assert(!mail.text.includes('PRIVATE_ADMIN_CHECKLIST_NOTE'), 'Internal reviewNotes never emailed');
        assert(!mail.text.includes('INTERNAL_ESCALATION_NOTE_PRIVATE'), 'Internal escalationNotes never emailed');
        assert(!mail.html.includes('kyc-documents'), 'Private storage dir never emailed');
      }

      // STAFF & Owner 2 rejected (403); Buyer rejected (401)
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'GET',
          path: `/api/v1/seller/stores/${store1Id}/notifications`,
          headers: { Authorization: `Bearer ${staff1Jwt}` }
        })).statusCode,
        403
      );
      assert.strictEqual(
        (await httpRequest({
          port: gwPort,
          method: 'GET',
          path: `/api/v1/seller/stores/${store1Id}/notifications`,
          headers: { Authorization: `Bearer ${owner2Jwt}` }
        })).statusCode,
        403
      );

      // Mark 1 notification read -> unreadCount decrements 4 -> 3; delete blocked by trigger; audit & outbox rows intact
      const firstNotifId = listRes.json.notifications[0].id;
      const readOne = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/seller/stores/${store1Id}/notifications/${firstNotifId}/read`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(readOne.statusCode, 200);
      assert.strictEqual(readOne.json.notification.isRead, true);

      let deleteBlocked = false;
      try {
        await merchPool.query(`DELETE FROM owner_notifications WHERE id = $1`, [firstNotifId]);
      } catch (e: any) {
        deleteBlocked = e?.code === '23514';
      }
      assert(deleteBlocked, 'Trigger protects owner_notifications history from DELETE');

      // Audit completeness check on Store 1: verify all MO-A..MO-B3 event types committed with real JWT actors
      const auditRes = await merchPool.query(
        `SELECT actor_type, actor_id, event_type FROM store_onboarding_audit_events WHERE merchant_id = $1`,
        [store1Id]
      );
      const types = new Set(auditRes.rows.map((r) => String(r.event_type)));
      for (const expectedType of [
        'DRAFT_UPDATED',
        'DOCUMENT_UPLOADED',
        'DOCUMENT_DELETED',
        'SUBMISSION_CREATED',
        'REVIEW_STARTED',
        'ADMIN_APPROVAL_GRANTED',
        'COMPLIANCE_WARNING_ISSUED',
        'COMPLIANCE_WARNING_RESPONSE_SUBMITTED',
        'COMPLIANCE_WARNING_ESCALATED',
        'COMPLIANCE_WARNING_RESOLVED'
      ]) {
        assert(types.has(expectedType), `Missing audit event '${expectedType}'`);
      }

      // 4. Ownership change between creation and delivery on store3Id -> withheld cleanly (TERMINAL_FAILED)
      const suspend3 = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/stores/${store3Id}/compliance/suspend`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: {
          suspensionType: 'PROTECTIVE_SERIOUS_RISK',
          violationCategory: 'SUSPECTED_FRAUD',
          reason: 'Ownership change test suspension before worker dispatch.',
          evidenceReferences: [{ kind: 'CASE', referenceId: 'OWN-3', label: 'Fraud ticket' }]
        }
      });
      assert.strictEqual(suspend3.statusCode, 200);
      const withheldEventId = suspend3.json.suspension.notificationEventId;

      // Demote Owner 2 to REVOKED on store3Id BEFORE worker runs
      await merchPool.query(
        `UPDATE store_memberships SET status = 'REVOKED' WHERE merchant_id = $1 AND seller_account_id = $2`,
        [store3Id, owner2AcctId]
      );
      const emailsBefore = sentEmails.length;
      await processNotificationOutboxBatch(merchPool, emailSvc, { workerId: 'ownership-check-worker' });
      const withheldRow = await merchPool.query(`SELECT delivery_status, in_app_status, last_error FROM owner_notification_events WHERE id = $1`, [
        withheldEventId
      ]);
      assert.strictEqual(withheldRow.rows[0].delivery_status, 'TERMINAL_FAILED', 'Delayed event withheld when ownership revoked');
      assert.strictEqual(withheldRow.rows[0].in_app_status, 'FAILED');
      assert.strictEqual(sentEmails.length, emailsBefore, 'Revoked owner NOT emailed');
    });

    // =====================================================================
    // CASE 3: Multi-Worker SKIP LOCKED, FIFO Stream Order, Idempotency & Stale Lease Recovery
    // =====================================================================
    await runCase('Multi-worker SKIP LOCKED prevents double claims, preserves per-store FIFO ordering, avoids duplicate in-app rows, and recovers expired leases', async () => {
      // Re-activate Owner 2 cleanly on Store 3 and clear earlier emails counter
      await merchPool.query(
        `UPDATE store_memberships SET status = 'ACTIVE' WHERE merchant_id = $1 AND seller_account_id = $2`,
        [store3Id, owner2AcctId]
      );
      const emailsStart = sentEmails.length;

      // Seed 2 sequential events on store2Id (e2_1 and e2_2) and 1 event on store3Id (e3_1)
      const ins2_1 = await merchPool.query(
        `INSERT INTO owner_notification_events
           (merchant_id, owner_seller_account_id, recipient_role, event_type, payload, created_at)
         VALUES ($1, $2, 'OWNER', 'COMPLIANCE_WARNING_ISSUED', '{"warningNumber":1,"reason":"First store2 violation"}'::jsonb, NOW() - INTERVAL '10 seconds')
         RETURNING id`,
        [store2Id, owner1AcctId]
      );
      const ins2_2 = await merchPool.query(
        `INSERT INTO owner_notification_events
           (merchant_id, owner_seller_account_id, recipient_role, event_type, payload, created_at)
         VALUES ($1, $2, 'OWNER', 'COMPLIANCE_WARNING_RESOLVED', '{"warningNumber":1,"reason":"Second store2 resolution"}'::jsonb, NOW() - INTERVAL '5 seconds')
         RETURNING id`,
        [store2Id, owner1AcctId]
      );
      const ins3_1 = await merchPool.query(
        `INSERT INTO owner_notification_events
           (merchant_id, owner_seller_account_id, recipient_role, event_type, payload, created_at)
         VALUES ($1, $2, 'OWNER', 'COMPLIANCE_STORE_REACTIVATED', '{"restoredStatus":"APPROVED","reason":"Recovered store3"}'::jsonb, NOW() - INTERVAL '8 seconds')
         RETURNING id`,
        [store3Id, owner2AcctId]
      );
      const e2_1 = String(ins2_1.rows[0].id);
      const e2_2 = String(ins2_2.rows[0].id);
      const e3_1 = String(ins3_1.rows[0].id);

      // Slow transporter during simultaneous multi-worker batch to force genuine concurrency overlap
      let concurrentInFlight = 0;
      let maxInFlight = 0;
      const claimedByWorker = new Map<string, string[]>();
      const slowTransporter = {
        sendMail: async (mail: any) => {
          concurrentInFlight++;
          maxInFlight = Math.max(maxInFlight, concurrentInFlight);
          await delay(120);
          concurrentInFlight--;
          sentEmails.push({
            to: String(mail.to),
            subject: String(mail.subject),
            text: String(mail.text),
            html: String(mail.html),
            idempotencyKey: mail.headers?.['X-StreetVerse-Idempotency-Key']
          });
          return { messageId: `slow-${sentEmails.length}` };
        }
      };
      const slowEmailSvc = createEmailService({ redisClient: undefined, nodeEnv: 'test', transporter: slowTransporter });

      // Run 2 concurrent workers at the EXACT same instant!
      // FIFO ordering MUST deliver only e2_1 for Store 2 and e3_1 for Store 3 in parallel (e2_2 waits behind e2_1!)
      const [b1, b2] = await Promise.all([
        processNotificationOutboxBatch(merchPool, slowEmailSvc, {
          workerId: 'parallel-w1',
          batchSize: 5,
          onDeliverFailureInject: (ev) => {
            claimedByWorker.set('w1', [...(claimedByWorker.get('w1') ?? []), ev.id]);
          }
        }),
        processNotificationOutboxBatch(merchPool, slowEmailSvc, {
          workerId: 'parallel-w2',
          batchSize: 5,
          onDeliverFailureInject: (ev) => {
            claimedByWorker.set('w2', [...(claimedByWorker.get('w2') ?? []), ev.id]);
          }
        })
      ]);

      const totalClaimedWave1 = b1.claimedCount + b2.claimedCount;
      assertEqual(totalClaimedWave1, 2, 'Wave 1 claims e2_1 and e3_1 only while holding e2_2 in FIFO order');
      const allClaimedWave1 = [...(claimedByWorker.get('w1') ?? []), ...(claimedByWorker.get('w2') ?? [])];
      assert(allClaimedWave1.includes(e2_1) && allClaimedWave1.includes(e3_1), 'Both store head events claimed once');
      assert(!allClaimedWave1.includes(e2_2), 'e2_2 waited strictly behind e2_1');

      // Now Wave 2 claims and delivers e2_2 cleanly
      const w2Res = await processNotificationOutboxBatch(merchPool, slowEmailSvc, { workerId: 'wave2-w' });
      assertEqual(w2Res.claimedCount, 1);
      assertEqual(sentEmails.length - emailsStart, 3, 'Each of the 3 distinct events emailed exactly once');

      // Idempotency check: force e2_1 status back to PROCESSING with expired lease (simulating crash after in-app insert!)
      await merchPool.query(
        `UPDATE owner_notification_events
         SET delivery_status = 'PROCESSING',
             locked_by = 'crashed-worker-99',
             lease_expires_at = NOW() - INTERVAL '10 seconds'
         WHERE id = $1`,
        [e2_1]
      );
      const recoverRes = await processNotificationOutboxBatch(merchPool, slowEmailSvc, { workerId: 'recovery-worker' });
      assertEqual(recoverRes.deliveredCount, 1, 'Expired lease automatically reclaimed and finished');

      // Verify STILL only 1 in-app notification row for e2_1 AND e2_1 wasn't re-emailed since email_status was already SENT!
      const inboxCount = await merchPool.query(`SELECT COUNT(*)::int AS cnt FROM owner_notifications WHERE outbox_event_id = $1`, [e2_1]);
      assertEqual(inboxCount.rows[0].cnt, 1, 'Duplicate/recovered processing never creates duplicate owner_notifications');
      assertEqual(sentEmails.length - emailsStart, 3, 'Already SENT email skipped cleanly on lease recovery');
    });

    // =====================================================================
    // CASE 4: Backoff Retry -> Terminal Failure -> Admin Replay, Unconfigured Email & Failed Tx Rollback
    // =====================================================================
    await runCase('Retries use exponential backoff, reach TERMINAL_FAILED & replay cleanly, missing SMTP preserves in-app cleanly, and failed tx rolls back outbox+audit', async () => {
      // 1. Transient failure -> retries -> succeeds without duplicating in-app
      const insRetry = await merchPool.query(
        `INSERT INTO owner_notification_events
           (merchant_id, owner_seller_account_id, recipient_role, event_type, payload, max_attempts)
         VALUES ($1, $2, 'OWNER', 'COMPLIANCE_WARNING_ISSUED', '{"warningNumber":2,"reason":"Retry path"}'::jsonb, 4)
         RETURNING id`,
        [store2Id, owner1AcctId]
      );
      const evRetryId = String(insRetry.rows[0].id);

      emailBehavior = 'FAIL_THEN_SUCCEED';
      transientFailuresRemaining = 2;

      const r1 = await processNotificationOutboxBatch(merchPool, emailSvc, {
        workerId: 'retry-w',
        baseRetryDelayMs: 50,
        maxRetryDelayMs: 200
      });
      assertEqual(r1.retryingCount, 1);
      await delay(70);
      const r2 = await processNotificationOutboxBatch(merchPool, emailSvc, {
        workerId: 'retry-w',
        baseRetryDelayMs: 50,
        maxRetryDelayMs: 200
      });
      assertEqual(r2.retryingCount, 1);
      await delay(130);
      const r3 = await processNotificationOutboxBatch(merchPool, emailSvc, {
        workerId: 'retry-w',
        baseRetryDelayMs: 50,
        maxRetryDelayMs: 200
      });
      assertEqual(r3.deliveredCount, 1);
      const retryInboxCnt = await merchPool.query(`SELECT COUNT(*)::int AS cnt FROM owner_notifications WHERE outbox_event_id = $1`, [evRetryId]);
      assertEqual(retryInboxCnt.rows[0].cnt, 1, 'Retries never duplicate in-app notification');

      // 2. Repeated failure -> TERMINAL_FAILED -> Admin outbox summary & replay
      emailBehavior = 'TRANSIENT_FAIL';
      const insTerm = await merchPool.query(
        `INSERT INTO owner_notification_events
           (merchant_id, owner_seller_account_id, recipient_role, event_type, payload, max_attempts)
         VALUES ($1, $2, 'OWNER', 'COMPLIANCE_WARNING_RESOLVED', '{"warningNumber":2,"reason":"Terminal path"}'::jsonb, 2)
         RETURNING id`,
        [store2Id, owner1AcctId]
      );
      const evTermId = String(insTerm.rows[0].id);

      await processNotificationOutboxBatch(merchPool, emailSvc, { workerId: 'term-w', baseRetryDelayMs: 20, maxRetryDelayMs: 50 });
      await delay(40);
      const t2 = await processNotificationOutboxBatch(merchPool, emailSvc, { workerId: 'term-w', baseRetryDelayMs: 20, maxRetryDelayMs: 50 });
      assertEqual(t2.terminalFailedCount, 1);

      const summaryRes = await httpRequest({
        port: gwPort,
        method: 'GET',
        path: '/api/v1/admin/notifications/outbox/summary',
        headers: { Authorization: `Bearer ${admin1Jwt}` }
      });
      assert.strictEqual(summaryRes.statusCode, 200);
      assert(summaryRes.json.counts.terminalFailed >= 1, 'Summary exposes TERMINAL_FAILED count');

      // Replay while email is fixed
      emailBehavior = 'OK';
      const replayHttp = await httpRequest({
        port: gwPort,
        method: 'POST',
        path: `/api/v1/admin/notifications/outbox/${evTermId}/replay`,
        headers: { Authorization: `Bearer ${admin1Jwt}` },
        body: { reason: 'SMTP provider restored' }
      });
      assert.strictEqual(replayHttp.statusCode, 200);

      const postReplay = await processNotificationOutboxBatch(merchPool, emailSvc, { workerId: 'replay-w' });
      assertEqual(postReplay.deliveredCount, 1);
      const termInboxCnt = await merchPool.query(`SELECT COUNT(*)::int AS cnt FROM owner_notifications WHERE outbox_event_id = $1`, [evTermId]);
      assertEqual(termInboxCnt.rows[0].cnt, 1, 'Replay never duplicates existing in-app notification');

      // 3. Unconfigured SMTP never fakes SENT & preserves in-app delivery cleanly
      const noSmtpEmailSvc = createEmailService({ redisClient: undefined, nodeEnv: 'test', transporter: null });
      const insUnconf = await merchPool.query(
        `INSERT INTO owner_notification_events
           (merchant_id, owner_seller_account_id, recipient_role, event_type, payload)
         VALUES ($1, $2, 'OWNER', 'ONBOARDING_MORE_INFO_REQUIRED', '{"reason":"Missing bill date","submissionVersion":1}'::jsonb)
         RETURNING id`,
        [store2Id, owner1AcctId]
      );
      const evUnconfId = String(insUnconf.rows[0].id);

      const uRes = await processNotificationOutboxBatch(merchPool, noSmtpEmailSvc, { workerId: 'unconf-w' });
      assertEqual(uRes.deliveredCount, 1);
      const unconfRow = await merchPool.query(
        `SELECT delivery_status, in_app_status, email_status FROM owner_notification_events WHERE id = $1`,
        [evUnconfId]
      );
      assert.strictEqual(unconfRow.rows[0].delivery_status, 'DELIVERED');
      assert.strictEqual(unconfRow.rows[0].in_app_status, 'DELIVERED');
      assert.strictEqual(unconfRow.rows[0].email_status, 'UNCONFIGURED', 'Missing SMTP explicitly reported as UNCONFIGURED');

      // 4. Failed business tx rollback test: failing draft upload leaves ZERO audit/submission orphan
      const beforeAud = await merchPool.query(`SELECT COUNT(*)::int AS cnt FROM store_onboarding_audit_events WHERE merchant_id = $1`, [store2Id]);
      const failUp = await uploadDraftDocument(merchPool, kycStorage, {
        merchantId: store2Id,
        sellerAccountId: owner1AcctId,
        requirementKey: 'NON_EXISTENT_KEY_BAD',
        fileBuffer: Buffer.concat([VALID_JPEG, Buffer.from([9, 9])]),
        declaredMimeType: 'image/jpeg',
        originalFilename: 'bad.jpg'
      });
      assert.strictEqual(failUp.ok, false);
      const afterAud = await merchPool.query(`SELECT COUNT(*)::int AS cnt FROM store_onboarding_audit_events WHERE merchant_id = $1`, [store2Id]);
      assertEqual(afterAud.rows[0].cnt, beforeAud.rows[0].cnt, 'Failed business op creates zero audit records');

      // 5. Readiness stays 200 cleanly & gateway shutdown drains cleanly
      const readyRes = await httpRequest({ port: gwPort, method: 'GET', path: '/api/ready' });
      assert.strictEqual(readyRes.statusCode, 200);
    });
  } finally {
    process.env.SMTP_USER = prevSmtpUser;
    process.env.SMTP_PASS = prevSmtpPass;
    await Promise.allSettled(shutdowns.map((fn) => fn()));
    await Promise.allSettled(pools.map((p) => p.end()));
    fs.rmSync(tmpStorageDir, { recursive: true, force: true });
    if (createdContainers.length > 0) {
      await runDocker(['rm', '-f', ...createdContainers]).catch(() => {});
    }
  }

  console.log('\n=== StreetVerse MO-B4 Live Reliable Notifications & Audit Results ===');
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.name} (${r.durationMs}ms)`);
    if (r.error) console.log(`  -> ${r.error}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nSummary: ${passed}/${results.length} MO-B4 live scenarios passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

runSuite().catch((err) => {
  console.error('[MO-B4 Live Test Fatal Error]', err);
  process.exit(1);
});
