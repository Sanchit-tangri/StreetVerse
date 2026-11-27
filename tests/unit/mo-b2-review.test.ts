/**
 * MO-B2 Unit Tests: Admin Review Queue, Protected Document Content Inspection,
 * Structured Verification Checklist, Approval/More-Info/Reject State Machine,
 * Concurrency / Stale Submission Protections, and Audit / Outbox Integrity.
 */

import http from 'http';
import { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';

import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { ManagedRedisClient } from '../../services/api-gateway/src/db/redis';
import {
  ADMIN_ACCOUNT_PRINCIPAL_TYPE,
  SELLER_ACCOUNT_PRINCIPAL_TYPE
} from '../../services/api-gateway/src/middleware/authJwt';
import { validateStructuredReviewChecklist } from '../../services/api-gateway/src/services/adminReview';
import {
  computeSha256,
  KycDocumentStorage,
  KycStorageNotFoundError,
  KycStorageUnavailableError,
  KycStoreParams,
  KycStoreResult
} from '../../services/api-gateway/src/storage/kycDocumentStorage';

// ============================================================
// Runner & Assertions
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
// Test Fixtures & Mocks
// ============================================================

const TEST_JWT_SECRET = 'mob2-unit-test-secret-with-at-least-32-bytes!';
const ADMIN_1_ID = '99991111-1111-4111-8111-111111111111';
const ADMIN_2_ID = '99992222-2222-4222-8222-222222222222';
const STORE_GROCERY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_1_ID = 'aaaa1111-1111-4111-8111-111111111111';
const SUB_1_ID = 'cccc1111-1111-4111-8111-111111111111';
const SUB_OLD_ID = 'cccc0000-0000-4000-8000-000000000000';
const DOC_1_ID = 'dddd1111-1111-4111-8111-111111111111';

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
    kycStorageDir: path.join(os.tmpdir(), 'streetverse-mob2-unit-storage')
  };
}

function makeHealthyRedisMock(): ManagedRedisClient {
  const client: ManagedRedisClient = {
    status: 'ready',
    connect: async () => {
      client.status = 'ready';
    },
    ping: async () => 'PONG',
    set: async () => 'OK',
    ttl: async () => -2,
    del: async () => 0,
    eval: async () => [1, 0],
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

class MemoryMockStorage implements KycDocumentStorage {
  public files = new Map<string, Buffer>();
  public failUnavailable = false;

  async store(_params: KycStoreParams): Promise<KycStoreResult> {
    throw new Error('not needed in unit test');
  }
  async retrieve(storageKey: string): Promise<Buffer> {
    if (this.failUnavailable) {
      throw new KycStorageUnavailableError();
    }
    const buf = this.files.get(storageKey);
    if (!buf) {
      throw new KycStorageNotFoundError();
    }
    return buf;
  }
  async delete(_storageKey: string): Promise<void> {
    throw new Error('not needed');
  }
}

function makeAdminToken(sub: string): string {
  return jwt.sign(
    { sub, role: 'ADMIN', principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE, email: `${sub}@streetverse.ops` },
    TEST_JWT_SECRET,
    { issuer: 'streetverse-api', audience: 'streetverse-admin', expiresIn: '1h' }
  );
}

function makeSellerToken(sub: string): string {
  return jwt.sign(
    { sub, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE },
    TEST_JWT_SECRET,
    { issuer: 'streetverse-api', audience: 'streetverse-seller', expiresIn: '1h' }
  );
}

function makeBuyerToken(sub: string): string {
  return jwt.sign({ sub, role: 'BUYER' }, TEST_JWT_SECRET, {
    issuer: 'streetverse-api',
    audience: 'streetverse-buyer',
    expiresIn: '1h'
  });
}

async function httpRequest(options: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string; raw: Buffer; json: any }> {
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
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: text, raw, json });
        });
      }
    );
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function makeFullChecklist(reqKeys: string[]) {
  return {
    sellerIdentityReviewed: true,
    businessNameAndCategoryConfirmed: true,
    fixedPhysicalShopConfirmed: true,
    gpsLocationChecked: true,
    storefrontPhotosInspected: true,
    premisesEvidenceChecked: true,
    categoryDocumentsChecked: true,
    informationConsistent: true,
    noUnresolvedDiscrepancy: true,
    confirmedRequirementKeys: reqKeys
  };
}

// ============================================================
// 1. Structured Checklist & Category Definition Validation
// ============================================================

test('validateStructuredReviewChecklist rejects incomplete flags/requirements and avoids blanket GST', () => {
  const groceryExpected = ['STOREFRONT_PHOTO_1', 'STOREFRONT_PHOTO_2', 'PREMISES_PROOF', 'FSSAI_FOOD_RETAIL_REGISTRATION'];
  const restaurantExpected = ['STOREFRONT_PHOTO_1', 'STOREFRONT_PHOTO_2', 'PREMISES_PROOF', 'FSSAI_LICENSE'];

  // Missing one boolean flag
  const partialFlags = makeFullChecklist(groceryExpected);
  (partialFlags as any).gpsLocationChecked = false;
  assertEqual(
    validateStructuredReviewChecklist(partialFlags, groceryExpected).ok,
    false,
    'Missing gpsLocationChecked must fail'
  );

  // Missing category mandatory requirement confirmation
  const missingFssai = makeFullChecklist(['STOREFRONT_PHOTO_1', 'STOREFRONT_PHOTO_2', 'PREMISES_PROOF']);
  assertEqual(
    validateStructuredReviewChecklist(missingFssai, groceryExpected).ok,
    false,
    'Missing FSSAI_FOOD_RETAIL_REGISTRATION confirmation fails for Grocery'
  );

  // Restaurant check does NOT allow grocery FSSAI_FOOD_RETAIL_REGISTRATION in place of FSSAI_LICENSE
  const wrongFoodType = makeFullChecklist(groceryExpected);
  assertEqual(
    validateStructuredReviewChecklist(wrongFoodType, restaurantExpected).ok,
    false,
    'Restaurant requires FSSAI_LICENSE specifically'
  );

  // Valid grocery & stationery checklists succeed cleanly without GST
  const okGrocery = validateStructuredReviewChecklist(makeFullChecklist(groceryExpected), groceryExpected);
  assertEqual(okGrocery.ok, true, 'Complete Grocery checklist succeeds without GST');

  const stationeryExpected = ['STOREFRONT_PHOTO_1', 'STOREFRONT_PHOTO_2', 'PREMISES_PROOF'];
  const okStationery = validateStructuredReviewChecklist(makeFullChecklist(stationeryExpected), stationeryExpected);
  assertEqual(okStationery.ok, true, 'Complete Stationery checklist succeeds with universal docs only');
});

// ============================================================
// 2. Document Stream Security & Integrity Validation
// ============================================================

test('Protected document content endpoint validates ownership, checksum, storage availability, headers, and audits access/failure', async () => {
  const validJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('REAL-STORE-FRONT')]);
  const validSha = computeSha256(validJpeg);
  const storageKey = 'a'.repeat(64) + '.jpg';
  const storage = new MemoryMockStorage();
  storage.files.set(storageKey, validJpeg);

  const auditEventsRecorded: Array<{ eventType: string; metadata: any }> = [];

  const pool = {
    query: async (sql: string, params: any[] = []) => {
      if (/FROM admin_accounts\s+WHERE id = \$1/i.test(sql)) {
        return {
          rows: [{ id: ADMIN_1_ID, email: 'a1@streetverse.ops', full_name: 'Admin One', role: 'ADMIN', status: 'ACTIVE' }],
          rowCount: 1
        };
      }
      if (/FROM kyc_documents d\s+JOIN store_kyc_submissions s/i.test(sql)) {
        if (params[0] !== DOC_1_ID || params[1] !== SUB_1_ID) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [
            {
              id: DOC_1_ID,
              submission_id: SUB_1_ID,
              merchant_id: STORE_GROCERY_ID,
              requirement_key: 'STOREFRONT_PHOTO_1',
              document_type: 'STOREFRONT_PHOTO',
              original_filename_sanitized: 'front.jpg',
              storage_key: storageKey,
              mime_type: 'image/jpeg',
              file_size_bytes: validJpeg.length,
              sha256_checksum: validSha,
              submission_version: 1
            }
          ],
          rowCount: 1
        };
      }
      if (/INSERT INTO store_onboarding_audit_events/i.test(sql)) {
        auditEventsRecorded.push({
          eventType: String(params[2]),
          metadata: JSON.parse(String(params[3]))
        });
        return { rows: [{ id: 'aud-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string, params?: any[]) => pool.query(sql, params),
      release: () => {},
      on: () => ({}) as any,
      off: () => ({}) as any
    })
  } as unknown as StrictPgPool;

  const { server, shutdown } = createGatewayApp(makeTestConfig(), {
    customerPool: pool,
    merchantPool: pool,
    redis: makeHealthyRedisMock(),
    kycStorage: storage,
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const adminJwt = makeAdminToken(ADMIN_1_ID);
  const sellerJwt = makeSellerToken(OWNER_1_ID);
  const buyerJwt = makeBuyerToken('bbbb1111-1111-4111-8111-111111111111');

  try {
    const docPath = `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/documents/${DOC_1_ID}/content`;

    // 1. Seller, Buyer & unauthenticated rejected
    assertEqual((await httpRequest({ port, method: 'GET', path: docPath })).statusCode, 401, 'Unauth blocked');
    assertEqual(
      (await httpRequest({ port, method: 'GET', path: docPath, headers: { Authorization: `Bearer ${sellerJwt}` } })).statusCode,
      401,
      'Seller blocked on Admin document route'
    );
    assertEqual(
      (await httpRequest({ port, method: 'GET', path: docPath, headers: { Authorization: `Bearer ${buyerJwt}` } })).statusCode,
      401,
      'Buyer blocked on Admin document route'
    );

    // 2. Wrong submissionId returns 404
    const wrongSubRes = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/admin/onboarding/submissions/${SUB_OLD_ID}/documents/${DOC_1_ID}/content`,
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(wrongSubRes.statusCode, 404, 'Mismatched submission/doc rejects with 404');

    // 3. Valid document retrieval streams exact bytes + safe headers + logs view audit event without content or storageKey
    const okRes = await httpRequest({
      port,
      method: 'GET',
      path: docPath,
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(okRes.statusCode, 200, 'Valid document streams 200');
    assert(okRes.raw.equals(validJpeg), 'Exact JPEG bytes returned');
    assertEqual(okRes.headers['content-type'], 'image/jpeg', 'Safe JPEG content-type');
    assertEqual(okRes.headers['x-content-type-options'], 'nosniff', 'nosniff header set');
    assert(String(okRes.headers['cache-control']).includes('no-store'), 'private, no-store caching header set');
    assertEqual(auditEventsRecorded.length, 1, 'Document access audit logged');
    assertEqual(auditEventsRecorded[0].eventType, 'ADMIN_DOCUMENT_VIEWED', 'View audit event type');
    assert(!JSON.stringify(auditEventsRecorded[0]).includes(storageKey), 'Audit event never logs storageKey');

    // 4. Tampered bytes (checksum mismatch) rejects cleanly with 422 AND logs integrity failure audit event
    storage.files.set(storageKey, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('TAMPERED')]));
    const corruptRes = await httpRequest({
      port,
      method: 'GET',
      path: docPath,
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(corruptRes.statusCode, 422, 'Checksum mismatch rejects with 422');
    assertEqual(corruptRes.json?.code, 'DOCUMENT_CHECKSUM_MISMATCH', 'Returns DOCUMENT_CHECKSUM_MISMATCH');
    assertEqual(auditEventsRecorded[1].eventType, 'ADMIN_DOCUMENT_INTEGRITY_FAILURE', 'Integrity failure audited');

    // 5. Missing file fails cleanly with 404 and storage outage returns 503 without leaking storageKey
    storage.files.delete(storageKey);
    const missingRes = await httpRequest({
      port,
      method: 'GET',
      path: docPath,
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(missingRes.statusCode, 404, 'Missing file returns 404');
    assert(!missingRes.body.includes(storageKey), 'Missing error never leaks storageKey');

    storage.failUnavailable = true;
    const unavailableRes = await httpRequest({
      port,
      method: 'GET',
      path: docPath,
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(unavailableRes.statusCode, 503, 'Storage outage fails closed 503');
  } finally {
    await shutdown();
  }
});

// ============================================================
// 3. Decision State Machine, Concurrency, Stale Blocks & Reasons
// ============================================================

test('Review actions enforce transitions, mandatory reasons, stale blocking, reviewer locks, audit & outbox', async () => {
  let subStatus = 'SUBMITTED';
  let profStatus = 'SUBMITTED';
  let currentSubId = SUB_1_ID;
  let claimedAdminId: string | null = null;
  let hasNewerVersion = false;
  let isOpen = false;
  const auditEvents: any[] = [];
  const notifEvents: any[] = [];

  const groceryReqs = [
    { requirementKey: 'STOREFRONT_PHOTO_1', isMandatory: true },
    { requirementKey: 'STOREFRONT_PHOTO_2', isMandatory: true },
    { requirementKey: 'PREMISES_PROOF', isMandatory: true },
    { requirementKey: 'FSSAI_FOOD_RETAIL_REGISTRATION', isMandatory: true }
  ];

  const query = async (sql: string, params: any[] = []) => {
    if (/FROM admin_accounts\s+WHERE id = \$1/i.test(sql)) {
      const id = String(params[0]);
      if (id !== ADMIN_1_ID && id !== ADMIN_2_ID) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id, email: `${id}@streetverse.ops`, full_name: 'Reviewer', role: 'ADMIN', status: 'ACTIVE' }],
        rowCount: 1
      };
    }

    if (/SELECT [\s\S]*?FROM store_kyc_submissions\s+WHERE id = \$1/i.test(sql)) {
      if (params[0] !== SUB_1_ID) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: SUB_1_ID,
            merchant_id: STORE_GROCERY_ID,
            submission_version: 1,
            submitted_by_seller_account_id: OWNER_1_ID,
            status: subStatus,
            reviewed_by_admin_id: claimedAdminId,
            business_name_snapshot: 'Deccan Fresh Mart',
            category_snapshot: 'GROCERY',
            business_type_snapshot: 'FIXED_SHOP',
            fixed_premises_confirmed_snapshot: true,
            address_snapshot: '10 FC Road, Pune',
            pincode_snapshot: '411004',
            latitude_snapshot: 18.5204,
            longitude_snapshot: 73.8415,
            requirements_snapshot: groceryReqs,
            seller_contact_snapshot: { sellerAccountId: OWNER_1_ID, isEmailVerified: true }
          }
        ],
        rowCount: 1
      };
    }

    if (/SELECT [\s\S]*?FROM merchants\s+WHERE id = \$1/i.test(sql)) {
      return {
        rows: [{ id: STORE_GROCERY_ID, business_name: 'Deccan Fresh Mart', category: 'GROCERY', is_open: isOpen }],
        rowCount: 1
      };
    }

    if (/SELECT [\s\S]*?FROM store_onboarding_profiles\s+WHERE merchant_id = \$1/i.test(sql)) {
      return {
        rows: [{ id: 'prof-1', merchant_id: STORE_GROCERY_ID, status: profStatus, current_submission_id: currentSubId }],
        rowCount: 1
      };
    }

    if (/submission_version > \$2/i.test(sql)) {
      return { rows: hasNewerVersion ? [{ id: 'sub-newer' }] : [], rowCount: hasNewerVersion ? 1 : 0 };
    }

    if (/FROM kyc_document_requirements/i.test(sql)) {
      return {
        rows: groceryReqs.map((r) => ({ requirement_key: r.requirementKey })),
        rowCount: groceryReqs.length
      };
    }

    if (/FROM kyc_documents/i.test(sql)) {
      return {
        rows: [
          { id: 'd1', requirement_key: 'STOREFRONT_PHOTO_1', is_storefront_photo: true, is_premises_proof: false, sha256_checksum: '1' },
          { id: 'd2', requirement_key: 'STOREFRONT_PHOTO_2', is_storefront_photo: true, is_premises_proof: false, sha256_checksum: '2' },
          { id: 'd3', requirement_key: 'PREMISES_PROOF', is_storefront_photo: false, is_premises_proof: true, sha256_checksum: '3' },
          { id: 'd4', requirement_key: 'FSSAI_FOOD_RETAIL_REGISTRATION', is_storefront_photo: false, is_premises_proof: false, sha256_checksum: '4' }
        ],
        rowCount: 4
      };
    }

    if (/UPDATE store_kyc_submissions\s+SET status = 'UNDER_REVIEW'/i.test(sql)) {
      if (subStatus !== 'SUBMITTED') return { rows: [], rowCount: 0 };
      subStatus = 'UNDER_REVIEW';
      claimedAdminId = String(params[0]);
      return { rows: [{ review_started_at: new Date().toISOString() }], rowCount: 1 };
    }

    if (/UPDATE store_kyc_submissions\s+SET status = 'APPROVED'/i.test(sql)) {
      if (subStatus !== 'UNDER_REVIEW') return { rows: [], rowCount: 0 };
      subStatus = 'APPROVED';
      return { rows: [{ reviewed_at: new Date().toISOString() }], rowCount: 1 };
    }

    if (/UPDATE store_kyc_submissions\s+SET status = 'MORE_INFO_REQUIRED'/i.test(sql)) {
      if (subStatus !== 'UNDER_REVIEW') return { rows: [], rowCount: 0 };
      subStatus = 'MORE_INFO_REQUIRED';
      return { rows: [{ reviewed_at: new Date().toISOString() }], rowCount: 1 };
    }

    if (/UPDATE store_kyc_submissions\s+SET status = 'REJECTED'/i.test(sql)) {
      if (subStatus !== 'UNDER_REVIEW') return { rows: [], rowCount: 0 };
      subStatus = 'REJECTED';
      return { rows: [{ reviewed_at: new Date().toISOString() }], rowCount: 1 };
    }

    if (/UPDATE store_onboarding_profiles\s+SET status = '([^']+)'/i.test(sql)) {
      const m = sql.match(/SET status = '([^']+)'/i);
      if (m) profStatus = m[1];
      return { rows: [], rowCount: 1 };
    }

    if (/UPDATE merchants SET is_open = false/i.test(sql)) {
      isOpen = false;
      return { rows: [], rowCount: 1 };
    }

    if (/FROM store_memberships sm/i.test(sql)) {
      return { rows: [{ seller_account_id: OWNER_1_ID }], rowCount: 1 };
    }

    if (/INSERT INTO store_onboarding_audit_events/i.test(sql)) {
      auditEvents.push({ actorId: params[1], eventType: params[2], metadata: JSON.parse(String(params[3])) });
      return { rows: [{ id: `aud-${auditEvents.length}` }], rowCount: 1 };
    }

    if (/INSERT INTO owner_notification_events/i.test(sql)) {
      notifEvents.push({ eventType: params[4], payload: JSON.parse(String(params[5])) });
      return { rows: [{ id: `notif-${notifEvents.length}` }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  const pool = {
    query,
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        return query(sql, params);
      },
      release: () => {},
      on: () => ({}) as any,
      off: () => ({}) as any
    })
  } as unknown as StrictPgPool;

  const { server, shutdown } = createGatewayApp(makeTestConfig(), {
    customerPool: pool,
    merchantPool: pool,
    redis: makeHealthyRedisMock(),
    kycStorage: new MemoryMockStorage(),
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const admin1Jwt = makeAdminToken(ADMIN_1_ID);
  const admin2Jwt = makeAdminToken(ADMIN_2_ID);
  const groceryChecklist = makeFullChecklist(groceryReqs.map((r) => r.requirementKey));

  try {
    // 1. Cannot approve directly from SUBMITTED without starting review
    const prematureApprove = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/approve`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { checklist: groceryChecklist, reviewedByAdminId: ADMIN_2_ID }
    });
    assertEqual(prematureApprove.statusCode, 409, 'Premature approve before start-review fails 409');
    assertEqual(prematureApprove.json?.code, 'REVIEW_NOT_STARTED');

    // 2. Start review succeeds with Admin 1 regardless of spoofed adminId in body; Admin 2 cannot silently take over
    const startRes = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/start-review`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { reviewedByAdminId: ADMIN_2_ID, adminId: ADMIN_2_ID }
    });
    assertEqual(startRes.statusCode, 200, 'Start review succeeds');
    assertEqual(startRes.json?.decision?.reviewedByAdminId, ADMIN_1_ID, 'Spoofed body adminId ignored');

    const takeoverRes = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/start-review`,
      headers: { Authorization: `Bearer ${admin2Jwt}` }
    });
    assertEqual(takeoverRes.statusCode, 409, 'Competing Admin cannot hijack active UNDER_REVIEW');
    assertEqual(takeoverRes.json?.code, 'REVIEW_ALREADY_IN_PROGRESS');

    const admin2Approve = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/approve`,
      headers: { Authorization: `Bearer ${admin2Jwt}` },
      body: { checklist: groceryChecklist }
    });
    assertEqual(admin2Approve.statusCode, 409, 'Admin 2 cannot approve Admin 1 claimed review');
    assertEqual(admin2Approve.json?.code, 'REVIEW_CLAIMED_BY_ANOTHER_ADMIN');

    // 3. Reject & request-information enforce non-empty reason and valid classifications/requirements
    const missingMoreInfoReason = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/request-information`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { reason: 'ok', requestedRequirements: ['FSSAI_FOOD_RETAIL_REGISTRATION'] }
    });
    assertEqual(missingMoreInfoReason.statusCode, 400, 'Short/empty More Info reason rejected 400');

    const invalidReqKeyMoreInfo = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/request-information`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { reason: 'Please re-upload valid license.', requestedRequirements: ['DRUG_LICENSE'] }
    });
    assertEqual(invalidReqKeyMoreInfo.statusCode, 400, 'Category-inapplicable requestedRequirement rejected 400');

    const missingRejectReason = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/reject`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { reason: '', rejectionCategory: 'LOCATION_MISMATCH' }
    });
    assertEqual(missingRejectReason.statusCode, 400, 'Missing rejection reason rejected 400');

    const badRejectCat = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/reject`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { reason: 'Document blurry and unreadable.', rejectionCategory: 'MADE_UP' }
    });
    assertEqual(badRejectCat.statusCode, 400, 'Invalid rejectionCategory rejected 400');

    // 4. Approve succeeds -> store remains closed (isOpen: false), audit + outbox created
    const okApprove = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/approve`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { checklist: groceryChecklist, reviewNotes: 'Verified physical store photos and FSSAI retail cert.' }
    });
    assertEqual(okApprove.statusCode, 200, 'Approval succeeds');
    assertEqual(okApprove.json?.decision?.isOpen, false, 'Approved store must NOT auto-open');
    assert(Boolean(okApprove.json?.decision?.notificationEventId), 'Durable notification event created');
    assertEqual(notifEvents[0].eventType, 'ONBOARDING_APPROVED', 'Outbox event type');
    assertEqual(auditEvents.some((e) => e.eventType === 'ADMIN_APPROVAL_GRANTED' && e.actorId === ADMIN_1_ID), true, 'Approval audit written');

    // 5. Duplicate decision or stale decision returns 409
    const dupReject = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/reject`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { reason: 'Trying to override approved version.', rejectionCategory: 'OTHER' }
    });
    assertEqual(dupReject.statusCode, 409, 'Already decided submission blocks subsequent reject (409)');

    // Superseded submission blocked even if reset externally in test
    hasNewerVersion = true;
    subStatus = 'UNDER_REVIEW';
    profStatus = 'UNDER_REVIEW';
    const staleRes = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/onboarding/submissions/${SUB_1_ID}/approve`,
      headers: { Authorization: `Bearer ${admin1Jwt}` },
      body: { checklist: groceryChecklist }
    });
    assertEqual(staleRes.statusCode, 409, 'Superseded submission blocked 409');
    assertEqual(staleRes.json?.code, 'STALE_SUBMISSION');
  } finally {
    await shutdown();
  }
});

test('Unsubmitted DRAFT stores are excluded from queue query & filters validate cleanly', async () => {
  const seenSqls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      seenSqls.push(sql);
      if (/FROM admin_accounts\s+WHERE id = \$1/i.test(sql)) {
        return {
          rows: [{ id: ADMIN_1_ID, email: 'a@test.ops', full_name: 'Admin', role: 'ADMIN', status: 'ACTIVE' }],
          rowCount: 1
        };
      }
      if (/GROUP BY sop\.status/i.test(sql)) {
        return { rows: [{ status: 'SUBMITTED', cnt: 1 }], rowCount: 1 };
      }
      if (/SELECT COUNT\(\*\)::int AS total/i.test(sql)) {
        return { rows: [{ total: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as StrictPgPool;

  const { server, shutdown } = createGatewayApp(makeTestConfig(), {
    customerPool: pool,
    merchantPool: pool,
    redis: makeHealthyRedisMock(),
    kycStorage: new MemoryMockStorage(),
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const adminJwt = makeAdminToken(ADMIN_1_ID);

  try {
    const queueRes = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/admin/onboarding/queue?category=GROCERY&search=Kirana&sort=submitted_asc&limit=10&offset=0',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(queueRes.statusCode, 200, 'Queue returns 200 with MO-B2 filters');
    assert(seenSqls.some((s) => /sub\.status <> 'DRAFT'/i.test(s)), 'Queue query excludes unsubmitted DRAFT rows');

    const badCat = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/admin/onboarding/queue?category=HOME_CHEF',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(badCat.statusCode, 400, 'Invalid queue category filter returns 400');

    const badSort = await httpRequest({
      port,
      method: 'GET',
      path: '/api/v1/admin/onboarding/queue?sort=priority_vip',
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assertEqual(badSort.statusCode, 400, 'Non-priority-neutral/invalid sort rejected 400');
  } finally {
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
  console.log(`\nMO-B2 Unit Summary: ${TESTS.length - failed}/${TESTS.length} passed`);
  if (failed > 0) process.exit(1);
}

run();
