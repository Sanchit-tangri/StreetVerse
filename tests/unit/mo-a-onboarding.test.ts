/**
 * MO-A Unit Tests: Merchant Onboarding Data Model, Storage Security,
 * Input Validation, Error Safety, and Authorization Boundaries.
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';

import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { ManagedRedisClient } from '../../services/api-gateway/src/db/redis';
import { SELLER_ACCOUNT_PRINCIPAL_TYPE } from '../../services/api-gateway/src/middleware/authJwt';
import {
  computeSha256,
  detectMimeFromMagicBytes,
  FilesystemKycDocumentStorage,
  KYC_MAX_FILE_SIZE_BYTES,
  KycDocumentStorage,
  KycStorageNotFoundError,
  KycStorageUnavailableError,
  KycStorageValidationError,
  KycStoreParams,
  KycStoreResult,
  sanitizeOriginalFilename
} from '../../services/api-gateway/src/storage/kycDocumentStorage';
import {
  ALLOWED_STORE_CATEGORIES,
  haversineDistanceMeters,
  retrieveStoreDocumentContent,
  updateOnboardingDraft
} from '../../services/api-gateway/src/services/onboarding';

// ============================================================
// Runner helpers
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

async function assertRejects(fn: () => Promise<unknown>, substring?: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert(caught !== undefined, 'Expected promise to reject, but it resolved.');
  if (substring) {
    const msg = caught instanceof Error ? caught.message : String(caught);
    assert(msg.toLowerCase().includes(substring.toLowerCase()), `Expected "${substring}" in "${msg}"`);
  }
}

// ============================================================
// Mocks & test utilities
// ============================================================

const TEST_JWT_SECRET = 'moa-unit-test-secret-with-at-least-32-bytes!';
const STORE_A_ID = '11111111-1111-4111-8111-111111111111';
const STORE_B_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_A_ID = 'aaaa1111-1111-4111-8111-111111111111';
const STAFF_A_ID = 'bbbb1111-1111-4111-8111-111111111111';
const OWNER_B_ID = 'cccc1111-1111-4111-8111-111111111111';
const DOC_1_ID = 'dddd1111-1111-4111-8111-111111111111';

function makeTestConfig(kycStorageDir: string): GatewayConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    allowedOrigins: ['http://localhost:3000'],
    jwtSecret: TEST_JWT_SECRET,
    jwtIssuer: 'streetverse-api',
    jwtBuyerAudience: 'streetverse-buyer',
    jwtSellerAudience: 'streetverse-seller',
    jwtExpiresIn: '1h',
    redisUrl: 'redis://127.0.0.1:6399',
    customerDbUrl: 'postgresql://postgres:secret@127.0.0.1:5499/cust',
    merchantDbUrl: 'postgresql://postgres:secret@127.0.0.1:5499/merch',
    aiEngineUrl: 'http://127.0.0.1:8099',
    kycStorageDir
  };
}

function makeHealthyRedisMock(): ManagedRedisClient {
  const client: ManagedRedisClient = {
    status: 'ready',
    connect: async () => { client.status = 'ready'; },
    ping: async () => 'PONG',
    set: async () => 'OK',
    ttl: async () => -2,
    del: async () => 0,
    eval: async () => 0,
    multi: () => {
      const chain: any = { set: () => chain, del: () => chain, exec: async () => [] };
      return chain;
    },
    on: () => client,
    quit: async () => { client.status = 'end'; return 'OK'; },
    disconnect: () => { client.status = 'end'; }
  };
  return client;
}

class MemoryKycStorage implements KycDocumentStorage {
  public stored = new Map<string, Buffer>();
  public failNextWithUnavailable = false;
  async store(params: KycStoreParams): Promise<KycStoreResult> {
    if (this.failNextWithUnavailable) throw new KycStorageUnavailableError();
    const detected = detectMimeFromMagicBytes(params.buffer);
    if (!detected || detected !== params.mimeType) {
      throw new KycStorageValidationError('Invalid file signature.', 'INVALID_FILE_TYPE');
    }
    const key = `${crypto.randomBytes(16).toString('hex')}.bin`;
    this.stored.set(key, params.buffer);
    return {
      storageKey: key,
      sha256: computeSha256(params.buffer),
      mimeType: params.mimeType,
      fileSizeBytes: params.buffer.length,
      originalFilenameSanitized: sanitizeOriginalFilename(params.originalFilename)
    };
  }
  async retrieve(storageKey: string): Promise<Buffer> {
    if (this.failNextWithUnavailable) throw new KycStorageUnavailableError();
    const b = this.stored.get(storageKey);
    if (!b) throw new KycStorageNotFoundError();
    return b;
  }
  async delete(storageKey: string): Promise<void> {
    if (!this.stored.delete(storageKey)) throw new KycStorageNotFoundError();
  }
}

function makeSellerToken(sub: string, extra: Record<string, unknown> = {}): string {
  return jwt.sign(
    { sub, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE, ...extra },
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
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string; json: any }> {
  return new Promise((resolve, reject) => {
    const rawBody =
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
        timeout: 4000,
        headers: {
          ...(rawBody && !Buffer.isBuffer(options.body)
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(rawBody)) }
            : rawBody
              ? { 'Content-Length': String(rawBody.length) }
              : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: text, json: parsed });
        });
      }
    );
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
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
  const boundary = '----StreetVerseBoundary7e9a3c';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(params.extraFields || {})) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        'utf8'
      )
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
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(parts)
  };
}

function makeRbacAwarePool(options: {
  outage?: () => boolean;
  customQuery?: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }> | null;
} = {}): StrictPgPool {
  const accounts = new Map<string, any>([
    [OWNER_A_ID, { id: OWNER_A_ID, status: 'ACTIVE', phone: '+919800000001', email: 'ownera@test.local', is_email_verified: true }],
    [STAFF_A_ID, { id: STAFF_A_ID, status: 'ACTIVE', phone: '+919800000002', email: 'staffa@test.local', is_email_verified: true }],
    [OWNER_B_ID, { id: OWNER_B_ID, status: 'ACTIVE', phone: '+919800000003', email: 'ownerb@test.local', is_email_verified: true }]
  ]);
  const memberships = new Map<string, string>([
    [`${OWNER_A_ID}:${STORE_A_ID}`, 'OWNER'],
    [`${STAFF_A_ID}:${STORE_A_ID}`, 'STAFF'],
    [`${OWNER_B_ID}:${STORE_B_ID}`, 'OWNER']
  ]);

  const query = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number | null }> => {
    if (options.outage?.()) {
      throw Object.assign(
        new Error('connect ECONNREFUSED 127.0.0.1:5434 postgresql://postgres:TopSecret@db:5434/merch'),
        { code: 'ECONNREFUSED' }
      );
    }
    if (options.customQuery) {
      const handled = await options.customQuery(sql, params);
      if (handled) return handled;
    }
    if (/FROM seller_accounts/i.test(sql)) {
      const a = accounts.get(params[0]);
      return { rows: a ? [a] : [], rowCount: a ? 1 : 0 };
    }
    if (/FROM merchants m\s+LEFT JOIN store_memberships sm/i.test(sql)) {
      const storeId = params[1];
      if (storeId !== STORE_A_ID && storeId !== STORE_B_ID) return { rows: [], rowCount: 0 };
      const role = memberships.get(`${params[0]}:${storeId}`) || null;
      return {
        rows: [
          {
            store_id: storeId,
            business_name: storeId === STORE_A_ID ? 'Alpha Shop' : 'Beta Shop',
            membership_role: role,
            membership_status: role ? 'ACTIVE' : null
          }
        ],
        rowCount: 1
      };
    }
    if (/SELECT id, business_name, category.*FROM merchants/i.test(sql)) {
      const storeId = params[0];
      if (storeId !== STORE_A_ID && storeId !== STORE_B_ID) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: storeId, business_name: 'Alpha Shop', category: 'PHARMACY', is_open: false }],
        rowCount: 1
      };
    }
    if (/FROM store_onboarding_profiles/i.test(sql)) {
      return {
        rows: [
          {
            id: 'prof-1',
            merchant_id: STORE_A_ID,
            business_name: 'Alpha Shop',
            category: 'PHARMACY',
            business_type: 'FIXED_SHOP',
            business_type_confirmed: false,
            fixed_premises_confirmed: false,
            premises_ownership_type: null,
            address: 'Shop 1, Pune',
            pincode: '411038',
            latitude: null,
            longitude: null,
            gps_captured_at: null,
            gps_accuracy_meters: null,
            status: 'PENDING_SUBMISSION',
            current_submission_id: null,
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
    if (/FROM kyc_document_requirements/i.test(sql)) {
      return {
        rows: [
          {
            requirement_key: 'STOREFRONT_PHOTO_1',
            category: null,
            is_mandatory: true,
            document_type: 'STOREFRONT_PHOTO',
            label: 'Front Photo',
            description: 'Desc',
            sort_order: 10,
            effective_version: 1
          },
          {
            requirement_key: 'DRUG_LICENSE',
            category: 'PHARMACY',
            is_mandatory: true,
            document_type: 'DRUG_LICENSE',
            label: 'Drug License',
            description: 'Desc',
            sort_order: 40,
            effective_version: 1
          }
        ],
        rowCount: 2
      };
    }
    if (/FROM kyc_documents/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  return {
    query,
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        return query(sql, params);
      },
      release: () => {},
      on: () => ({}) as any,
      off: () => ({}) as any
    }),
    on: () => ({}) as any,
    end: async () => {}
  } as unknown as StrictPgPool;
}

// ============================================================
// 1. Storage & Magic Byte Validation Tests
// ============================================================

test('detectMimeFromMagicBytes accepts JPEG, PNG, PDF and rejects SVG, HTML, EXE, ZIP', () => {
  assertEqual(detectMimeFromMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg', 'JPEG');
  assertEqual(
    detectMimeFromMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/png',
    'PNG'
  );
  assertEqual(detectMimeFromMagicBytes(Buffer.from('%PDF-1.7\n...', 'utf8')), 'application/pdf', 'PDF');

  assertEqual(detectMimeFromMagicBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8')), null, 'SVG rejected');
  assertEqual(detectMimeFromMagicBytes(Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>', 'utf8')), null, 'HTML rejected');
  assertEqual(detectMimeFromMagicBytes(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])), null, 'Windows PE/EXE rejected');
  assertEqual(detectMimeFromMagicBytes(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])), null, 'Linux ELF rejected');
  assertEqual(detectMimeFromMagicBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04])), null, 'ZIP archive rejected');
});

test('FilesystemKycDocumentStorage enforces size limits, magic bytes, SHA-256, and traversal protection', async () => {
  const tmpDir = path.join(os.tmpdir(), `streetverse-moa-unit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storage = new FilesystemKycDocumentStorage(tmpDir);
  try {
    await assertRejects(
      () => storage.store({ buffer: Buffer.alloc(0), mimeType: 'image/jpeg', originalFilename: 'empty.jpg' }),
      'empty'
    );
    await assertRejects(
      () =>
        storage.store({
          buffer: Buffer.alloc(KYC_MAX_FILE_SIZE_BYTES + 1, 0xff),
          mimeType: 'image/jpeg',
          originalFilename: 'huge.jpg'
        }),
      '10 MB'
    );
    await assertRejects(
      () =>
        storage.store({
          buffer: Buffer.from('<svg onload="alert(1)"/>', 'utf8'),
          mimeType: 'image/svg+xml',
          originalFilename: 'xss.svg'
        }),
      'unsupported file type'
    );
    // Spoofed PNG bytes declared as PDF
    await assertRejects(
      () =>
        storage.store({
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
          mimeType: 'application/pdf',
          originalFilename: 'spoof.pdf'
        }),
      'does not match'
    );

    await assertRejects(() => storage.retrieve('../secret.txt'), 'path components');
    await assertRejects(() => storage.delete('..\\secret.txt'), 'path components');
    await assertRejects(() => storage.retrieve('missing-file-key.pdf'), 'does not exist');

    const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('shop-photo-bytes')]);
    const saved = await storage.store({
      buffer: jpegBytes,
      mimeType: 'image/jpeg',
      originalFilename: '../../my/../shop front.jpg'
    });
    assert(/^[0-9a-f]{64}\.jpg$/.test(saved.storageKey), 'Storage key must be 256-bit CSPRNG hex + extension');
    assert(!saved.originalFilenameSanitized.includes('..') && !saved.originalFilenameSanitized.includes('/'), 'Filename sanitized');
    assertEqual(saved.sha256, computeSha256(jpegBytes), 'SHA-256 matches');
    assert((await storage.retrieve(saved.storageKey)).equals(jpegBytes), 'Retrieved exact bytes');

    await storage.delete(saved.storageKey);
    await assertRejects(() => storage.retrieve(saved.storageKey), 'does not exist');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// 2. Authorization & Forged Payload / Private Exposure Tests
// ============================================================

test('HTTP RBAC: rejects unauth (401), Buyer (403), STAFF (403), cross-store Owner (403), forged body IDs (403), and allows OWNER (200)', async () => {
  const tmpDir = path.join(os.tmpdir(), `streetverse-moa-http-${Date.now()}`);
  const pool = makeRbacAwarePool();
  const storage = new MemoryKycStorage();
  const { server, shutdown } = createGatewayApp(makeTestConfig(tmpDir), {
    customerPool: pool,
    merchantPool: pool,
    redis: makeHealthyRedisMock(),
    kycStorage: storage,
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  try {
    // 1. Unauthenticated
    const noAuth = await httpRequest({ port, method: 'GET', path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding` });
    assertEqual(noAuth.statusCode, 401, 'Unauthenticated GET');

    // 2. Buyer token
    const buyer = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding`,
      headers: { Authorization: `Bearer ${makeBuyerToken('buyer-1')}` }
    });
    assertEqual(buyer.statusCode, 403, 'Buyer JWT GET');

    // 3. STAFF member rejected on onboarding GET, PUT, POST submit
    const staffToken = makeSellerToken(STAFF_A_ID);
    const staffGet = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding`,
      headers: { Authorization: `Bearer ${staffToken}` }
    });
    assertEqual(staffGet.statusCode, 403, 'STAFF denied GET onboarding');

    const staffPut = await httpRequest({
      port,
      method: 'PUT',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding`,
      headers: { Authorization: `Bearer ${staffToken}` },
      body: { sellerAccountId: OWNER_A_ID, role: 'OWNER', businessTypeConfirmed: true }
    });
    assertEqual(staffPut.statusCode, 403, 'STAFF denied PUT even with forged sellerAccountId/role');

    // 4. Owner B trying to access Store A denied + forged body storeId ignored
    const ownerBToken = makeSellerToken(OWNER_B_ID);
    const crossOwner = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding/submit`,
      headers: { Authorization: `Bearer ${ownerBToken}` },
      body: { storeId: STORE_B_ID, merchantId: STORE_B_ID, role: 'OWNER' }
    });
    assertEqual(crossOwner.statusCode, 403, 'Cross-store Owner denied even with forged body storeId');

    // 5. Owner A allowed GET onboarding -> zero raw paths or approval flags
    const ownerAToken = makeSellerToken(OWNER_A_ID);
    const ownerGet = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding`,
      headers: { Authorization: `Bearer ${ownerAToken}` }
    });
    assertEqual(ownerGet.statusCode, 200, 'Owner GET onboarding');
    assertEqual(ownerGet.json.profile.status, 'PENDING_SUBMISSION', 'Default status unapproved');
    assert(!ownerGet.body.includes(tmpDir), 'Never exposes storageDir path');

    // 6. Private storage paths cannot be fetched statically via HTTP
    const pub1 = await httpRequest({ port, method: 'GET', path: '/data/kyc-documents/fake.jpg' });
    const pub2 = await httpRequest({ port, method: 'GET', path: '/uploads/fake.jpg' });
    assertEqual(pub1.statusCode, 404, 'Static /data not exposed');
    assertEqual(pub2.statusCode, 404, 'Static /uploads not exposed');
  } finally {
    await shutdown({ timeoutMs: 1000 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// 3. Multipart Error Mapping, Storage Error Safety & DB Outage 503
// ============================================================

test('Upload and download map Multer SIZE_LIMIT, SVG/HTML rejection, missing file (404), storage error (503), and PG outage (503) without leaking paths or secrets', async () => {
  const tmpDir = path.join(os.tmpdir(), `streetverse-moa-err-${Date.now()}`);
  let dbOutage = false;
  const storage = new MemoryKycStorage();
  storage.stored.set('secret/path/internal-key.pdf', Buffer.from('%PDF-1.4\n', 'utf8'));

  const pool = makeRbacAwarePool({
    outage: () => dbOutage,
    customQuery: async (sql, params) => {
      if (/SELECT storage_key, mime_type, original_filename_sanitized/i.test(sql)) {
        if (params?.[0] === DOC_1_ID && params?.[1] === STORE_A_ID) {
          return {
            rows: [
              {
                storage_key: 'missing-on-disk-key.pdf',
                mime_type: 'application/pdf',
                original_filename_sanitized: 'bill.pdf'
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
      return null;
    }
  });

  const { server, shutdown } = createGatewayApp(makeTestConfig(tmpDir), {
    customerPool: pool,
    merchantPool: pool,
    redis: makeHealthyRedisMock(),
    kycStorage: storage,
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const ownerToken = makeSellerToken(OWNER_A_ID);

  try {
    // 1. Oversized multipart file returns clean JSON 400 FILE_TOO_LARGE (never HTML 500 stack trace)
    const bigMultipart = buildMultipart({
      fieldName: 'document',
      filename: 'big.jpg',
      mimeType: 'image/jpeg',
      content: Buffer.alloc(KYC_MAX_FILE_SIZE_BYTES + 256, 0xff),
      extraFields: { requirementKey: 'STOREFRONT_PHOTO_1' }
    });
    const tooLarge = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding/documents`,
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': bigMultipart.contentType },
      body: bigMultipart.body
    });
    assertEqual(tooLarge.statusCode, 400, 'Oversized upload returns 400');
    assertEqual(tooLarge.json?.code, 'FILE_TOO_LARGE', 'Returns FILE_TOO_LARGE JSON');

    // 2. HTML spoofed payload rejected cleanly
    const htmlMultipart = buildMultipart({
      fieldName: 'document',
      filename: 'bad.html',
      mimeType: 'text/html',
      content: Buffer.from('<html><body>xss</body></html>', 'utf8'),
      extraFields: { requirementKey: 'PREMISES_PROOF' }
    });
    const htmlRes = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding/documents`,
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': htmlMultipart.contentType },
      body: htmlMultipart.body
    });
    assertEqual(htmlRes.statusCode, 400, 'HTML upload rejected 400');
    assertEqual(htmlRes.json?.code, 'INVALID_FILE_TYPE', 'Returns INVALID_FILE_TYPE');

    // 3. Missing file on storage maps safely to 404 without leaking storageKey or directory
    const missingDoc = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding/documents/${DOC_1_ID}`,
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assertEqual(missingDoc.statusCode, 404, 'Missing stored file maps to 404');
    assert(!missingDoc.body.includes('missing-on-disk-key') && !missingDoc.body.includes(tmpDir), 'No storage key/path leaked');

    // 4. Storage unavailable error maps safely to 503
    storage.failNextWithUnavailable = true;
    const storage503 = await retrieveStoreDocumentContent(pool, storage, STORE_A_ID, DOC_1_ID);
    assert(!storage503.ok && storage503.status === 503 && storage503.code === 'STORAGE_UNAVAILABLE', 'Maps 503 STORAGE_UNAVAILABLE');
    storage.failNextWithUnavailable = false;

    // 5. DB outage maps to 503 without leaking connection string/password
    dbOutage = true;
    const db503 = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/seller/stores/${STORE_A_ID}/onboarding`,
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assertEqual(db503.statusCode, 503, 'PG outage returns 503');
    assert(!db503.body.includes('TopSecret') && !db503.body.includes('postgresql://'), 'Never leaks DB credentials');
  } finally {
    await shutdown({ timeoutMs: 1000 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// 4. Draft Validation (Ineligible Business Models & GPS Bounds)
// ============================================================

test('updateOnboardingDraft rejects home-based, mobile, online-only, service-area vendors and invalid GPS/categories', async () => {
  const pool = makeRbacAwarePool();

  for (const badType of ['HOME_BASED', 'MOBILE', 'MOBILE_VENDOR', 'ONLINE_ONLY', 'SERVICE_AREA_ONLY']) {
    const r = await updateOnboardingDraft(pool, STORE_A_ID, OWNER_A_ID, {
      businessType: badType,
      fixedPremisesConfirmed: true
    });
    assert(!r.ok && r.status === 400 && r.code === 'INELIGIBLE_BUSINESS_TYPE', `Should reject ${badType}`);
  }

  const noFixed = await updateOnboardingDraft(pool, STORE_A_ID, OWNER_A_ID, { fixedPremisesConfirmed: false });
  assert(!noFixed.ok && noFixed.status === 400 && noFixed.code === 'FIXED_PREMISES_REQUIRED', 'Rejects fixedPremisesConfirmed=false');

  const halfGps = await updateOnboardingDraft(pool, STORE_A_ID, OWNER_A_ID, { latitude: 18.5074 });
  assert(!halfGps.ok && halfGps.status === 400 && halfGps.code === 'GPS_INCOMPLETE', 'Rejects lat without lng');

  const nullIsland = await updateOnboardingDraft(pool, STORE_A_ID, OWNER_A_ID, { latitude: 0, longitude: 0 });
  assert(!nullIsland.ok && nullIsland.status === 400 && nullIsland.code === 'GPS_INVALID', 'Rejects (0, 0) Null Island');

  const badLat = await updateOnboardingDraft(pool, STORE_A_ID, OWNER_A_ID, { latitude: 91, longitude: 73.8 });
  assert(!badLat.ok && badLat.status === 400 && badLat.code === 'GPS_INVALID', 'Rejects latitude > 90');

  const badCat = await updateOnboardingDraft(pool, STORE_A_ID, OWNER_A_ID, { category: 'ILLEGAL_CAT' });
  assert(!badCat.ok && badCat.status === 400 && badCat.code === 'INVALID_CATEGORY', 'Rejects unknown category');

  for (const validCat of ['STATIONERY', 'CLOTHING', 'ELECTRONICS', 'SPORTS', 'HARDWARE', 'SALON', 'GROCERY']) {
    assert(ALLOWED_STORE_CATEGORIES.has(validCat), `Supports category ${validCat}`);
  }

  // Haversine check (~1.11 km per 0.01 deg latitude)
  const dist = haversineDistanceMeters(18.5074, 73.8077, 18.5174, 73.8077);
  assert(dist > 1000 && dist < 1200, `Haversine distance expected ~1112m, got ${dist}`);
});

// ============================================================
// 5. Static Security & Migration Consistency Checks
// ============================================================

test('Migration SQL and fresh schema define identical onboarding tables and accurate category-specific requirements without GST overreach', () => {
  const migrationSql = fs.readFileSync(
    path.resolve(__dirname, '../../packages/database-schemas/merchant-db/migrations/002_merchant_onboarding_and_kyc.sql'),
    'utf8'
  );
  const schemaSql = fs.readFileSync(
    path.resolve(__dirname, '../../packages/database-schemas/merchant-db/schema.sql'),
    'utf8'
  );

  for (const tbl of [
    'kyc_document_requirements',
    'store_onboarding_profiles',
    'store_kyc_submissions',
    'kyc_documents',
    'store_onboarding_audit_events'
  ]) {
    assert(migrationSql.includes(tbl), `Migration defines ${tbl}`);
    assert(schemaSql.includes(tbl), `schema.sql defines ${tbl}`);
  }
  assert(migrationSql.includes("('FSSAI_FOOD_RETAIL_REGISTRATION', 'GROCERY'"), 'Grocery food retail FSSAI requirement distinct from restaurant');
  assert(migrationSql.includes("('FSSAI_LICENSE', 'RESTAURANT'"), 'Restaurant food service FSSAI requirement defined');
  assert(migrationSql.includes("('DRUG_LICENSE', 'PHARMACY'"), 'Pharmacy drug license requirement defined');
  assert(!migrationSql.includes('GSTIN') && !migrationSql.includes('GST_'), 'No indiscriminate blanket GST mandate');
  assert(!migrationSql.includes('ADD CONSTRAINT IF NOT EXISTS'), 'Must not contain invalid PG syntax');
  assert(!schemaSql.includes('ADD CONSTRAINT IF NOT EXISTS'), 'schema.sql must not contain invalid PG syntax');
  assert(schemaSql.includes('is_open BOOLEAN DEFAULT false'), 'Fresh schema defaults stores closed');
});

async function run() {
  console.log(`\n=== Running MO-A Unit Tests (${TESTS.length} cases) ===`);
  let failed = 0;
  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`  PASS | ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL | ${t.name}`);
      console.error(`    -> ${err instanceof Error ? err.stack || err.message : String(err)}`);
    }
  }
  console.log(`\nMO-A Unit Summary: ${TESTS.length - failed}/${TESTS.length} passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
