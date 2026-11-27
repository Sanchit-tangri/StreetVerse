/**
 * MO-B1 Unit Tests: Admin Identity Separation, Audience Isolation,
 * Password Strength, Operational Provisioning, Suspended/Disabled Rejection,
 * Fail-Closed Outage Handling, and Spoof-Proof Actor Derivation.
 */

import bcrypt from 'bcryptjs';
import http from 'http';
import { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';

import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig, parseGatewayConfig } from '../../services/api-gateway/src/config/env';
import { StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { ManagedRedisClient } from '../../services/api-gateway/src/db/redis';
import {
  ADMIN_ACCOUNT_PRINCIPAL_TYPE,
  AuthenticatedRequest,
  SELLER_ACCOUNT_PRINCIPAL_TYPE,
  verifyAccessToken,
  verifyAdminToken
} from '../../services/api-gateway/src/middleware/authJwt';
import {
  provisionAdminAccount,
  resolveVerifiedAdminActor,
  validateAdminPasswordStrength
} from '../../services/api-gateway/src/services/adminAuth';
import {
  ADMIN_LOGIN_MAX_FAILURES_PER_IP,
  ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL,
  checkAdminLoginRateLimit,
  clearAdminLoginFailures,
  recordAdminLoginFailure
} from '../../services/api-gateway/src/services/adminLoginRateLimit';

// ============================================================
// Minimal runner & assertion helpers
// ============================================================

type TestFn = () => void | Promise<void>;
const TESTS: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  TESTS.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================
// Test fixtures & mocks
// ============================================================

const TEST_JWT_SECRET = 'mob1-unit-test-secret-with-at-least-32-bytes!';
const ADMIN_1_ID = '99991111-1111-4111-8111-111111111111';
const ADMIN_2_ID = '99992222-2222-4222-8222-222222222222';
const STORE_1_ID = '11111111-1111-4111-8111-111111111111';
const SELLER_1_ID = 'aaaa1111-1111-4111-8111-111111111111';
const BUYER_1_ID = 'bbbb1111-1111-4111-8111-111111111111';
const SUB_1_ID = 'cccc1111-1111-4111-8111-111111111111';

function makeTestConfig(): GatewayConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    allowedOrigins: ['http://localhost:3000'],
    jwtSecret: TEST_JWT_SECRET,
    jwtIssuer: 'streetverse-api',
    jwtBuyerAudience: 'streetverse-buyer',
    jwtSellerAudience: 'streetverse-seller',
    jwtAdminAudience: 'streetverse-admin',
    jwtExpiresIn: '1h',
    jwtAdminExpiresIn: '8h',
    redisUrl: 'redis://127.0.0.1:6399',
    customerDbUrl: 'postgresql://postgres:secret@127.0.0.1:5499/cust',
    merchantDbUrl: 'postgresql://postgres:secret@127.0.0.1:5499/merch',
    aiEngineUrl: 'http://127.0.0.1:8099',
    kycStorageDir: path.join(os.tmpdir(), 'streetverse-mob1-unit-storage')
  };
}

function makeHealthyRedisMock(): ManagedRedisClient {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();

  const client: ManagedRedisClient = {
    status: 'ready',
    connect: async () => {
      client.status = 'ready';
    },
    ping: async () => 'PONG',
    set: async () => 'OK',
    ttl: async (key: string) => ttls.get(key) ?? -2,
    del: async (...keys: string[]) => {
      let deleted = 0;
      for (const k of keys) {
        if (counts.delete(k)) deleted++;
        ttls.delete(k);
      }
      return deleted;
    },
    eval: async (script: string, _numKeys: number, ...args: (string | number)[]) => {
      if (client.status !== 'ready') {
        throw Object.assign(new Error('Stream isn\'t writeable'), { code: 'ECONNREFUSED' });
      }
      if (script.includes('INCR')) {
        const pairKey = String(args[0]);
        const ipKey = String(args[1]);
        const windowSec = Number(args[2]);
        const pairCount = (counts.get(pairKey) ?? 0) + 1;
        counts.set(pairKey, pairCount);
        if (pairCount === 1) ttls.set(pairKey, windowSec);
        const ipCount = (counts.get(ipKey) ?? 0) + 1;
        counts.set(ipKey, ipCount);
        if (ipCount === 1) ttls.set(ipKey, windowSec);
        return [pairCount, ipCount];
      }
      const pairKey = String(args[0]);
      const ipKey = String(args[1]);
      const maxPair = Number(args[2]);
      const maxIp = Number(args[3]);
      const fallbackTtl = Number(args[4]);
      const pairCount = counts.get(pairKey) ?? 0;
      if (pairCount >= maxPair) {
        return [0, ttls.get(pairKey) ?? fallbackTtl];
      }
      const ipCount = counts.get(ipKey) ?? 0;
      if (ipCount >= maxIp) {
        return [0, ttls.get(ipKey) ?? fallbackTtl];
      }
      return [1, 0];
    },
    multi: () => {
      const chain: any = { set: () => chain, del: () => chain, exec: async () => [] };
      return chain;
    },
    on: () => client,
    quit: async () => {
      client.status = 'end';
      return 'OK';
    },
    disconnect: () => {
      client.status = 'end';
    }
  };
  return client;
}

async function httpRequest(options: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; body: string; json: any }> {
  return new Promise((resolve, reject) => {
    const rawBody = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        timeout: 4000,
        headers: {
          ...(rawBody
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(rawBody)) }
            : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode ?? 0, body: text, json });
        });
      }
    );
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function makeBuyerToken(sub: string): string {
  return jwt.sign({ sub, role: 'BUYER' }, TEST_JWT_SECRET, {
    issuer: 'streetverse-api',
    audience: 'streetverse-buyer',
    expiresIn: '1h'
  });
}

function makeSellerToken(sub: string): string {
  return jwt.sign(
    { sub, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE },
    TEST_JWT_SECRET,
    { issuer: 'streetverse-api', audience: 'streetverse-seller', expiresIn: '1h' }
  );
}

function makeAdminToken(
  sub: string,
  overrides: { audience?: string; expiresIn?: string | number; extra?: Record<string, unknown> } = {}
): string {
  return jwt.sign(
    {
      sub,
      role: 'ADMIN',
      principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE,
      email: 'ops.admin@streetverse.local',
      ...(overrides.extra || {})
    },
    TEST_JWT_SECRET,
    {
      issuer: 'streetverse-api',
      audience: overrides.audience ?? 'streetverse-admin',
      expiresIn: (overrides.expiresIn ?? '1h') as jwt.SignOptions['expiresIn']
    }
  );
}

// ============================================================
// 1. Environment & JWT Audience Isolation
// ============================================================

test('parseGatewayConfig provides safe defaults and rejects Admin audience collision with Buyer/Seller', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    JWT_SECRET: TEST_JWT_SECRET,
    CUSTOMER_DB_URL: 'postgresql://postgres:secret@127.0.0.1:5433/cust',
    MERCHANT_DB_URL: 'postgresql://postgres:secret@127.0.0.1:5434/merch'
  };

  const parsed = parseGatewayConfig(baseEnv);
  assertEqual(parsed.jwtAdminAudience, 'streetverse-admin', 'Default Admin audience');
  assertEqual(parsed.jwtAdminExpiresIn, '8h', 'Default Admin expiry');

  const custom = parseGatewayConfig({
    ...baseEnv,
    JWT_ADMIN_AUDIENCE: 'custom-admin-aud',
    JWT_ADMIN_EXPIRES_IN: '4h'
  });
  assertEqual(custom.jwtAdminAudience, 'custom-admin-aud', 'Custom Admin audience');
  assertEqual(custom.jwtAdminExpiresIn, '4h', 'Custom Admin expiry');

  let threwBuyerCollision = false;
  try {
    parseGatewayConfig({ ...baseEnv, JWT_ADMIN_AUDIENCE: 'streetverse-buyer' });
  } catch (e: unknown) {
    threwBuyerCollision = /distinct/i.test(e instanceof Error ? e.message : String(e));
  }
  assert(threwBuyerCollision, 'JWT_ADMIN_AUDIENCE colliding with Buyer must fail fast');

  let threwSellerCollision = false;
  try {
    parseGatewayConfig({ ...baseEnv, JWT_ADMIN_AUDIENCE: 'streetverse-seller' });
  } catch (e: unknown) {
    threwSellerCollision = /distinct/i.test(e instanceof Error ? e.message : String(e));
  }
  assert(threwSellerCollision, 'JWT_ADMIN_AUDIENCE colliding with Seller must fail fast');
});

test('verifyAdminToken and verifyAccessToken maintain strict cryptographic separation', () => {
  const cfg = makeTestConfig();
  const buyerToken = makeBuyerToken(BUYER_1_ID);
  const sellerToken = makeSellerToken(SELLER_1_ID);
  const adminToken = makeAdminToken(ADMIN_1_ID);
  const expiredAdminToken = makeAdminToken(ADMIN_1_ID, { expiresIn: '-10s' });
  const spoofedSellerPrincipalAdminAud = jwt.sign(
    { sub: SELLER_1_ID, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE },
    TEST_JWT_SECRET,
    { issuer: 'streetverse-api', audience: 'streetverse-admin', expiresIn: '1h' }
  );
  const wrongRoleAdminAud = jwt.sign(
    { sub: ADMIN_1_ID, role: 'STAFF', principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE },
    TEST_JWT_SECRET,
    { issuer: 'streetverse-api', audience: 'streetverse-admin', expiresIn: '1h' }
  );

  // Admin token passes verifyAdminToken, fails Buyer/Seller verifyAccessToken
  const adminOk = verifyAdminToken(adminToken, cfg);
  assert(adminOk.ok === true, 'Valid Admin token should pass verifyAdminToken');
  if (adminOk.ok) {
    assertEqual(adminOk.principal.adminAccountId, ADMIN_1_ID, 'Admin ID extracted cleanly');
    assertEqual(adminOk.principal.principalType, ADMIN_ACCOUNT_PRINCIPAL_TYPE, 'Admin principalType');
  }
  const adminAsBuyerSeller = verifyAccessToken(adminToken, cfg);
  assert(adminAsBuyerSeller.ok === false, 'Admin token must fail Buyer/Seller verifyAccessToken');

  // Buyer/Seller tokens fail verifyAdminToken
  assert(verifyAdminToken(buyerToken, cfg).ok === false, 'Buyer token rejected by verifyAdminToken');
  assert(verifyAdminToken(sellerToken, cfg).ok === false, 'Seller token rejected by verifyAdminToken');

  // Wrong principalType, wrong role, expired rejected cleanly
  const badPrincipal = verifyAdminToken(spoofedSellerPrincipalAdminAud, cfg);
  assert(badPrincipal.ok === false && badPrincipal.status === 403, 'Seller principal on Admin aud returns 403');
  const badRole = verifyAdminToken(wrongRoleAdminAud, cfg);
  assert(badRole.ok === false && badRole.status === 403, 'Non-ADMIN role returns 403');
  const expired = verifyAdminToken(expiredAdminToken, cfg);
  assert(expired.ok === false && expired.status === 401, 'Expired Admin token returns 401');
});

// ============================================================
// 2. Password Strength & Operational Provisioning Validation
// ============================================================

test('validateAdminPasswordStrength and provisionAdminAccount enforce strict policy & conflict handling', async () => {
  assert(validateAdminPasswordStrength('short').ok === false, 'Short password rejected');
  assert(validateAdminPasswordStrength('REPLACE_WITH_STRONG_ADMIN_PASSWORD').ok === false, 'Placeholder rejected');
  assert(validateAdminPasswordStrength('NoSpecialChar123').ok === false, 'Missing special char rejected');
  assert(validateAdminPasswordStrength('nouppercasechar!123').ok === false, 'Missing uppercase rejected');
  assert(validateAdminPasswordStrength('StreetVerse#Ops2026!').ok === true, 'Strong password accepted');

  const insertedEmails = new Set<string>();
  const mockPool = {
    query: async (sql: string, params: any[] = []) => {
      if (/INSERT INTO admin_accounts/i.test(sql)) {
        const email = String(params[0]);
        if (insertedEmails.has(email)) {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        }
        insertedEmails.add(email);
        return {
          rows: [
            {
              id: ADMIN_1_ID,
              email,
              full_name: params[1],
              role: 'ADMIN',
              status: 'ACTIVE',
              last_login_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        return mockPool.query(sql, params);
      },
      release: () => {},
      on: () => ({}) as any,
      off: () => ({}) as any
    })
  } as unknown as StrictPgPool;

  const badEmail = await provisionAdminAccount(mockPool, {
    email: 'not-an-email',
    fullName: 'Ops Admin',
    password: 'StreetVerse#Ops2026!'
  });
  assert(badEmail.ok === false && badEmail.status === 400, 'Invalid email returns 400');

  const okRes = await provisionAdminAccount(mockPool, {
    email: '  Ops.Reviewer@StreetVerse.local ',
    fullName: 'Ops Reviewer',
    password: 'StreetVerse#Ops2026!'
  });
  assert(okRes.ok === true, 'Valid provision succeeds');
  if (okRes.ok) {
    assertEqual(okRes.data.email, 'ops.reviewer@streetverse.local', 'Email normalized lowercase');
    assertEqual((okRes.data as any).passwordHash, undefined, 'Never exposes passwordHash');
    assertEqual((okRes.data as any).password_hash, undefined, 'Never exposes password_hash');
  }

  const dupRes = await provisionAdminAccount(mockPool, {
    email: 'ops.reviewer@streetverse.local',
    fullName: 'Ops Reviewer',
    password: 'StreetVerse#Ops2026!'
  });
  assert(dupRes.ok === false && dupRes.status === 409 && dupRes.code === 'ADMIN_EMAIL_CONFLICT', 'Duplicate returns 409');
});

// ============================================================
// 3. HTTP Isolation, Suspension, Outage Fail-Closed & No Self-Registration
// ============================================================

test('HTTP routes enforce strict Admin isolation, suspension lockout, DB fail-closed, and zero leaks', async () => {
  const strongPassword = 'StreetVerse#Admin2026!';
  const passwordHash = await bcrypt.hash(strongPassword, 10);

  let adminStatus = 'ACTIVE';
  let simulateOutage = false;

  const merchantPool = {
    query: async (sql: string, params: any[] = []) => {
      if (simulateOutage) {
        throw Object.assign(
          new Error('connect ECONNREFUSED 127.0.0.1:5434 postgresql://postgres:TopSecret@db:5434/merch'),
          { code: 'ECONNREFUSED' }
        );
      }

      if (/FROM admin_accounts/i.test(sql) && /WHERE LOWER\(email\)/i.test(sql)) {
        const email = String(params[0]);
        if (email !== 'ops.admin@streetverse.local') return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: ADMIN_1_ID,
              email: 'ops.admin@streetverse.local',
              full_name: 'Primary Operations Admin',
              password_hash: passwordHash,
              role: 'ADMIN',
              status: adminStatus,
              last_login_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }

      if (/UPDATE admin_accounts\s+SET last_login_at/i.test(sql)) {
        return {
          rows: [
            {
              id: ADMIN_1_ID,
              email: 'ops.admin@streetverse.local',
              full_name: 'Primary Operations Admin',
              role: 'ADMIN',
              status: adminStatus,
              last_login_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }

      if (/FROM admin_accounts\s+WHERE id = \$1/i.test(sql)) {
        if (params[0] !== ADMIN_1_ID) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: ADMIN_1_ID,
              email: 'ops.admin@streetverse.local',
              full_name: 'Primary Operations Admin',
              role: 'ADMIN',
              status: adminStatus
            }
          ],
          rowCount: 1
        };
      }

      if (/SELECT COUNT\(\*\)::int AS total\s+FROM merchants/i.test(sql)) {
        return { rows: [{ total: 1 }], rowCount: 1 };
      }

      if (/FROM merchants m\s+LEFT JOIN store_onboarding_profiles/i.test(sql)) {
        return {
          rows: [
            {
              store_id: STORE_1_ID,
              business_name: 'Pune Health Pharmacy',
              category: 'PHARMACY',
              is_open: false,
              onboarding_status: 'SUBMITTED',
              reverification_required: false,
              reverification_reason: null,
              pincode: '411038',
              profile_updated_at: new Date().toISOString(),
              current_submission_id: SUB_1_ID,
              submission_version: 1,
              submission_status: 'SUBMITTED',
              submitted_at: new Date().toISOString(),
              reviewed_at: null,
              reviewed_by_admin_id: null,
              is_reverification: false,
              document_count: 4,
              owner_seller_account_id: SELLER_1_ID,
              owner_email: 'owner@pune.local',
              owner_is_email_verified: true
            }
          ],
          rowCount: 1
        };
      }

      if (/FROM merchants\s+WHERE id = \$1/i.test(sql)) {
        if (params[0] !== STORE_1_ID) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: STORE_1_ID,
              business_name: 'Pune Health Pharmacy',
              category: 'PHARMACY',
              is_open: false,
              address: '12 Karve Road, Kothrud, Pune',
              pincode: '411038',
              latitude: 18.5074,
              longitude: 73.8077,
              created_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }

      if (/FROM store_onboarding_profiles\s+WHERE merchant_id/i.test(sql)) {
        return {
          rows: [
            {
              id: 'prof-1111-1111-4111-8111-111111111111',
              merchant_id: STORE_1_ID,
              business_name: 'Pune Health Pharmacy',
              category: 'PHARMACY',
              business_type: 'FIXED_SHOP',
              business_type_confirmed: true,
              fixed_premises_confirmed: true,
              premises_ownership_type: 'RENTED',
              address: '12 Karve Road, Kothrud, Pune',
              pincode: '411038',
              latitude: 18.5074,
              longitude: 73.8077,
              gps_captured_at: new Date().toISOString(),
              gps_accuracy_meters: 12.5,
              status: 'SUBMITTED',
              current_submission_id: SUB_1_ID,
              draft_submission_id: null,
              approved_submission_id: null,
              reverification_required: false,
              reverification_reason: null,
              approved_address: null,
              approved_pincode: null,
              approved_latitude: null,
              approved_longitude: null,
              approved_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }

      if (/FROM store_memberships sm/i.test(sql)) {
        return {
          rows: [
            {
              membership_id: 'mem-1',
              role: 'OWNER',
              membership_status: 'ACTIVE',
              seller_account_id: SELLER_1_ID,
              email: 'owner@pune.local',
              is_email_verified: true,
              account_status: 'ACTIVE'
            }
          ],
          rowCount: 1
        };
      }

      if (/FROM store_kyc_submissions/i.test(sql)) {
        return {
          rows: [
            {
              id: SUB_1_ID,
              submission_version: 1,
              status: 'SUBMITTED',
              submitted_by_seller_account_id: SELLER_1_ID,
              business_name_snapshot: 'Pune Health Pharmacy',
              category_snapshot: 'PHARMACY',
              business_type_snapshot: 'FIXED_SHOP',
              fixed_premises_confirmed_snapshot: true,
              address_snapshot: '12 Karve Road, Kothrud, Pune',
              pincode_snapshot: '411038',
              latitude_snapshot: 18.5074,
              longitude_snapshot: 73.8077,
              gps_captured_at_snapshot: new Date().toISOString(),
              gps_accuracy_meters_snapshot: 12.5,
              submitted_requirements_version: 1,
              requirements_snapshot: [{ requirementKey: 'DRUG_LICENSE', isMandatory: true }],
              seller_contact_snapshot: { sellerAccountId: SELLER_1_ID, email: 'owner@pune.local' },
              is_reverification: false,
              submitted_at: new Date().toISOString(),
              reviewed_at: null,
              reviewed_by_admin_id: null,
              review_notes: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }

      if (/FROM kyc_documents/i.test(sql)) {
        assert(!/storage_key/i.test(sql), 'Admin document query must NEVER select storage_key');
        return {
          rows: [
            {
              id: 'doc-1',
              submission_id: SUB_1_ID,
              requirement_key: 'DRUG_LICENSE',
              document_type: 'DRUG_LICENSE',
              original_filename_sanitized: 'drug-license.pdf',
              mime_type: 'application/pdf',
              file_size_bytes: 2048,
              sha256_checksum: 'a'.repeat(64),
              uploaded_at: new Date().toISOString(),
              is_storefront_photo: false,
              is_premises_proof: false
            }
          ],
          rowCount: 1
        };
      }

      if (/FROM kyc_document_requirements/i.test(sql)) {
        return {
          rows: [
            {
              requirement_key: 'DRUG_LICENSE',
              category: 'PHARMACY',
              is_mandatory: true,
              document_type: 'DRUG_LICENSE',
              label: 'Drug License',
              description: 'Retail drug license',
              sort_order: 40,
              effective_version: 1
            }
          ],
          rowCount: 1
        };
      }

      if (/FROM store_onboarding_audit_events/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string, params?: any[]) => merchantPool.query(sql, params),
      release: () => {},
      on: () => ({}) as any,
      off: () => ({}) as any
    }),
    on: () => ({}) as any,
    end: async () => {}
  } as unknown as StrictPgPool;

  const redisMock = makeHealthyRedisMock();
  const { server, shutdown } = createGatewayApp(makeTestConfig(), {
    customerPool: merchantPool,
    merchantPool,
    redis: redisMock,
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  try {
    // 1. Public self-registration does not exist (unauthenticated hits requireAdminJwt 401; authenticated returns 404)
    const regAttempt = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/register',
      body: { email: 'evil@test.local', password: 'StreetVerse#Admin2026!' }
    });
    assertEqual(regAttempt.statusCode, 401, 'Unauthenticated /admin/auth/register blocked by Admin auth middleware');

    // 2. Wrong password and unknown email produce identical 401 responses (no enumeration)
    const badLogin = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'ops.admin@streetverse.local', password: 'WrongPassword#999!' }
    });
    const unknownLogin = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'nonexistent.admin@streetverse.local', password: 'WrongPassword#999!' }
    });
    assertEqual(badLogin.statusCode, 401, 'Wrong password returns 401');
    assertEqual(unknownLogin.statusCode, 401, 'Unknown email returns 401');
    assertEqual(badLogin.json?.code, unknownLogin.json?.code, 'Unknown email and wrong password return identical error code');
    assertEqual(badLogin.json?.error, unknownLogin.json?.error, 'Unknown email and wrong password return identical error message');

    // 3. Valid login returns 200 without password_hash and resets failure counters
    const okLogin = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'OPS.ADMIN@streetverse.local', password: strongPassword }
    });
    assertEqual(okLogin.statusCode, 200, 'Valid Admin login succeeds and clears previous failure count');
    const adminJwt = String(okLogin.json?.token || '');
    assert(adminJwt.length > 20, 'Admin JWT returned');
    assert(!okLogin.body.includes('passwordHash') && !okLogin.body.includes('password_hash'), 'No password_hash returned');

    const regAttemptAuthed = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/register',
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: { email: 'evil@test.local', password: 'StreetVerse#Admin2026!' }
    });
    assertEqual(regAttemptAuthed.statusCode, 404, 'Even authenticated /admin/auth/register does not exist (404)');

    const regTopAuthed = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/register',
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: { email: 'evil@test.local', password: 'StreetVerse#Admin2026!' }
    });
    assertEqual(regTopAuthed.statusCode, 404, 'No /admin/register endpoint exists (404)');

    // 4. Missing/invalid/expired JWT -> 401
    const noJwt = await httpRequest({ port, method: 'GET', path: '/api/v1/admin/me' });
    assertEqual(noJwt.statusCode, 401, 'Missing Admin JWT returns 401');

    const expiredJwt = makeAdminToken(ADMIN_1_ID, { expiresIn: '-5s' });
    const expRes = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/admin/onboarding/queue',
      headers: { Authorization: `Bearer ${expiredJwt}` }
    });
    assertEqual(expRes.statusCode, 401, 'Expired Admin JWT returns 401');

    // 5. Buyer & Seller JWTs rejected on /api/v1/admin/*
    const buyerToken = makeBuyerToken(BUYER_1_ID);
    const sellerToken = makeSellerToken(SELLER_1_ID);
    for (const p of ['/api/v1/admin/me', '/api/v1/admin/onboarding/queue', `/api/v1/admin/onboarding/stores/${STORE_1_ID}`]) {
      const bRes = await httpRequest({
        port,
        method: 'GET',
        path: p,
        headers: { Authorization: `Bearer ${buyerToken}` }
      });
      assertEqual(bRes.statusCode, 401, `Buyer JWT rejected at ${p}`);
      const sRes = await httpRequest({
        port,
        method: 'GET',
        path: p,
        headers: { Authorization: `Bearer ${sellerToken}` }
      });
      assertEqual(sRes.statusCode, 401, `Seller JWT rejected at ${p}`);
    }

    // 6. Admin JWT rejected on Seller & Buyer routes
    const adminOnSeller = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/seller/stores',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(adminOnSeller.statusCode, 401, 'Admin JWT rejected at /api/v1/seller/stores');

    const adminOnSellerOnboarding = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/seller/stores/${STORE_1_ID}/onboarding`,
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(adminOnSellerOnboarding.statusCode, 401, 'Admin JWT rejected at Seller onboarding route');

    const adminOnBuyer = await httpRequest({
      port,
      method: 'POST',
      path: '/api/user/request-email-change',
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: { newEmail: 'other@test.local' }
    });
    assertEqual(adminOnBuyer.statusCode, 401, 'Admin JWT rejected at /api/user/request-email-change');

    const adminOnAuthMe = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/auth/me',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(adminOnAuthMe.statusCode, 401, 'Admin JWT rejected at Buyer/Seller /api/v1/auth/me');

    const adminOnConversations = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/conversations',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(adminOnConversations.statusCode, 401, 'Admin JWT rejected at /api/v1/conversations');

    // 7. Queue & store inspection ignore spoofed admin/reviewer IDs and omit storage_key/password_hash
    const spoofedQueue = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/admin/onboarding/queue?reviewedByAdminId=${ADMIN_2_ID}&adminId=${ADMIN_2_ID}`,
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(spoofedQueue.statusCode, 200, 'Queue returns 200 for active Admin');
    assertEqual(spoofedQueue.json?.reviewedByActor?.actorId, ADMIN_1_ID, 'Actor ID derived from verified DB Admin only');

    const storeDetails = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/admin/onboarding/stores/${STORE_1_ID}?actorId=${ADMIN_2_ID}`,
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(storeDetails.statusCode, 200, 'Store details returns 200');
    assertEqual(storeDetails.json?.reviewedByActor?.actorId, ADMIN_1_ID, 'Store detail ignores spoofed actorId');
    assert(!storeDetails.body.includes('storage_key') && !storeDetails.body.includes('storageKey'), 'No storageKey leaked');
    assert(!storeDetails.body.includes('password_hash') && !storeDetails.body.includes('passwordHash'), 'No password hash leaked');

    // 8. Suspension revokes access for already-issued Admin JWT AND blocks login
    adminStatus = 'SUSPENDED';
    const suspendedMe = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/admin/me',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(suspendedMe.statusCode, 403, 'Suspended Admin JWT blocked with 403');
    assertEqual(suspendedMe.json?.code, 'ADMIN_ACCOUNT_INACTIVE', 'Suspended code matches');

    const suspendedLogin = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'ops.admin@streetverse.local', password: strongPassword }
    });
    assertEqual(suspendedLogin.statusCode, 403, 'Suspended Admin login blocked with 403');

    adminStatus = 'DISABLED';
    const disabledMe = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/admin/me',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(disabledMe.statusCode, 403, 'Disabled Admin JWT blocked with 403');

    // 9. DB outage fails closed cleanly with 503 and never leaks connection URL or secret
    adminStatus = 'ACTIVE';
    simulateOutage = true;
    const outageMe = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/admin/me',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(outageMe.statusCode, 503, 'DB outage fails closed with 503 on protected Admin route');
    assert(!outageMe.body.includes('TopSecret'), 'DB outage never leaks connection string credentials');

    const outageLogin = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'ops.admin@streetverse.local', password: strongPassword }
    });
    assertEqual(outageLogin.statusCode, 503, 'DB outage fails closed with 503 on Admin login');
  } finally {
    await shutdown();
  }
});

test('resolveVerifiedAdminActor ignores body/query IDs and fails without ACTIVE adminAuth', () => {
  const unauthedReq = {
    body: { reviewedByAdminId: ADMIN_2_ID, adminId: ADMIN_2_ID },
    query: { adminId: ADMIN_2_ID }
  } as unknown as AuthenticatedRequest;
  assertEqual(resolveVerifiedAdminActor(unauthedReq).ok, false, 'Missing adminAuth rejected');

  const suspendedReq = {
    body: { reviewedByAdminId: ADMIN_2_ID },
    adminAuth: {
      adminAccountId: ADMIN_1_ID,
      email: 'a@test.local',
      fullName: 'A',
      role: 'ADMIN' as const,
      permissions: ['KYC_QUEUE_READ' as const],
      principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE,
      status: 'SUSPENDED'
    }
  } as unknown as AuthenticatedRequest;
  const susRes = resolveVerifiedAdminActor(suspendedReq);
  assert(susRes.ok === false && susRes.status === 403, 'Non-ACTIVE adminAuth rejected');

  const activeReq = {
    body: { reviewedByAdminId: ADMIN_2_ID, actorId: ADMIN_2_ID },
    query: { reviewedByAdminId: ADMIN_2_ID },
    adminAuth: {
      adminAccountId: ADMIN_1_ID,
      email: 'a@test.local',
      fullName: 'Ops Admin',
      role: 'ADMIN' as const,
      permissions: ['KYC_QUEUE_READ' as const],
      principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE,
      status: 'ACTIVE'
    }
  } as unknown as AuthenticatedRequest;
  const okRes = resolveVerifiedAdminActor(activeReq);
  assert(okRes.ok === true && okRes.actor.actorId === ADMIN_1_ID, 'Verified DB Admin ID strictly used');
});

// ============================================================
// 4. Admin Login Abuse Protection, Non-Enumeration, Reset & Fail-Closed
// ============================================================

test('Admin login rate limiter throttles brute force, avoids cross-IP account DoS, resets on success, and fails closed', async () => {
  const redis = makeHealthyRedisMock();
  const attackerIp = '203.0.113.50';
  const adminIp = '198.51.100.20';
  const targetEmail = 'ops.admin@streetverse.local';

  // 1. Attacker IP hits per-(IP, email) limit (5 failed attempts)
  for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL; i++) {
    const pre = await checkAdminLoginRateLimit(redis, { clientIp: attackerIp, email: targetEmail });
    assertEqual(pre.allowed, true, `Attacker attempt ${i + 1} allowed before threshold`);
    await recordAdminLoginFailure(redis, { clientIp: attackerIp, email: targetEmail });
  }
  const blockedAttacker = await checkAdminLoginRateLimit(redis, { clientIp: attackerIp, email: targetEmail });
  assertEqual(blockedAttacker.allowed, false, '6th attempt from attacker IP for target email is throttled');
  assert(blockedAttacker.retryAfterSeconds > 0, 'Retry-After seconds positive');

  // 2. Legitimate Admin from separate IP is NOT locked out (no trivial account-lockout DoS)
  const adminFromOtherIp = await checkAdminLoginRateLimit(redis, { clientIp: adminIp, email: targetEmail });
  assertEqual(adminFromOtherIp.allowed, true, 'Legitimate Admin from distinct IP is unaffected');

  // 3. Per-IP spray protection throttles unknown-email spraying identically after MAX_FAILURES_PER_IP
  const sprayIp = '203.0.113.99';
  for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES_PER_IP; i++) {
    const pre = await checkAdminLoginRateLimit(redis, { clientIp: sprayIp, email: `unknown.${i}@streetverse.local` });
    assertEqual(pre.allowed, true, `Spray attempt ${i + 1} allowed before IP ceiling`);
    await recordAdminLoginFailure(redis, { clientIp: sprayIp, email: `unknown.${i}@streetverse.local` });
  }
  const blockedSpray = await checkAdminLoginRateLimit(redis, { clientIp: sprayIp, email: targetEmail });
  assertEqual(blockedSpray.allowed, false, 'IP ceiling throttles credential stuffing across varying emails');

  // 4. Successful login clears failures cleanly for (clientIp, email)
  for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL - 1; i++) {
    await recordAdminLoginFailure(redis, { clientIp: adminIp, email: targetEmail });
  }
  await clearAdminLoginFailures(redis, { clientIp: adminIp, email: targetEmail });
  const afterClear = await checkAdminLoginRateLimit(redis, { clientIp: adminIp, email: targetEmail });
  assertEqual(afterClear.allowed, true, 'Clearing after successful login resets failure state');

  // 5. HTTP integration: repeated wrong passwords return 429; successful login clears; suspended + wrong pw hides suspension; Redis down returns 503
  const strongPassword = 'StreetVerse#Admin2026!';
  const passwordHash = await bcrypt.hash(strongPassword, 10);
  let adminStatus = 'ACTIVE';
  const httpRedis = makeHealthyRedisMock();

  const pool = {
    query: async (sql: string, params: any[] = []) => {
      if (/FROM admin_accounts/i.test(sql) && /WHERE LOWER\(email\)/i.test(sql)) {
        if (params[0] !== 'ops.admin@streetverse.local') return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: ADMIN_1_ID,
              email: 'ops.admin@streetverse.local',
              full_name: 'Primary Operations Admin',
              password_hash: passwordHash,
              role: 'ADMIN',
              status: adminStatus,
              last_login_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }
      if (/UPDATE admin_accounts\s+SET last_login_at/i.test(sql)) {
        return {
          rows: [
            {
              id: ADMIN_1_ID,
              email: 'ops.admin@streetverse.local',
              full_name: 'Primary Operations Admin',
              role: 'ADMIN',
              status: adminStatus,
              last_login_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as StrictPgPool;

  const { server, shutdown } = createGatewayApp(makeTestConfig(), {
    customerPool: pool,
    merchantPool: pool,
    redis: httpRedis,
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  // Capture console logs to guarantee zero password/hash logging during login flows
  const capturedLogs: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(' '));
  };

  try {
    // 4 failed logins followed by 1 successful login resets threshold so another failure starts fresh
    for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL - 1; i++) {
      const failRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: 'ops.admin@streetverse.local', password: 'WrongPassword#123!' }
      });
      assertEqual(failRes.statusCode, 401, `Pre-success failed attempt ${i + 1} returns 401`);
    }

    const resetSuccess = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'ops.admin@streetverse.local', password: strongPassword }
    });
    assertEqual(resetSuccess.statusCode, 200, 'Valid login succeeds after 4 failures');

    // Suspended account with WRONG password yields identical 401 (does not enumerate status)
    adminStatus = 'SUSPENDED';
    const suspendedWrongPw = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'ops.admin@streetverse.local', password: 'WrongPassword#123!' }
    });
    assertEqual(suspendedWrongPw.statusCode, 401, 'Suspended account with wrong password returns generic 401');
    assertEqual(suspendedWrongPw.json?.code, 'ADMIN_INVALID_CREDENTIALS', 'Suspended wrong-pw hides status');

    // Now exhaust all 5 failures from clean reset -> 6th attempt returns 429
    adminStatus = 'ACTIVE';
    for (let i = 1; i < ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL; i++) {
      const r = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/admin/auth/login',
        body: { email: 'ops.admin@streetverse.local', password: 'WrongPassword#123!' }
      });
      assertEqual(r.statusCode, 401, `Exhausting failure ${i + 1} returns 401`);
    }

    const throttled = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'ops.admin@streetverse.local', password: strongPassword }
    });
    assertEqual(throttled.statusCode, 429, '6th login attempt throttled with 429 even with valid password');
    assertEqual(throttled.json?.code, 'ADMIN_LOGIN_RATE_LIMITED', 'Returns ADMIN_LOGIN_RATE_LIMITED code');
    assert(Number(throttled.json?.retryAfterSeconds) > 0, 'retryAfterSeconds returned in 429 payload');

    // Unknown email from already throttled pair uses separate pair key and returns 401 until pair/IP limit
    const unknownWhileOtherEmailThrottled = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'other.unknown@streetverse.local', password: 'WrongPassword#123!' }
    });
    assertEqual(unknownWhileOtherEmailThrottled.statusCode, 401, 'Distinct email still evaluates independently until IP ceiling');

    // Redis outage fails closed with 503 instead of disabling abuse protection
    httpRedis.status = 'reconnecting';
    const redisOutageLogin = await httpRequest({
      port,
      method: 'POST',
      path: '/api/v1/admin/auth/login',
      body: { email: 'ops.admin@streetverse.local', password: strongPassword }
    });
    assertEqual(redisOutageLogin.statusCode, 503, 'Redis outage on Admin login fails closed with 503');

    const joinedLogs = capturedLogs.join('\n');
    assert(!joinedLogs.includes(strongPassword) && !joinedLogs.includes('WrongPassword#123!') && !joinedLogs.includes(passwordHash), 'Passwords and bcrypt hashes must never be logged');
  } finally {
    console.error = origErr;
    console.warn = origWarn;
    await shutdown();
  }
});

async function run() {
  let failed = 0;
  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`PASS: ${t.name}`);
    } catch (err: unknown) {
      failed++;
      console.error(`FAIL: ${t.name}`);
      console.error(err instanceof Error ? err.stack || err.message : String(err));
    }
  }
  console.log(`\nMO-B1 Unit Summary: ${TESTS.length - failed}/${TESTS.length} passed`);
  if (failed > 0) process.exit(1);
}

run();
