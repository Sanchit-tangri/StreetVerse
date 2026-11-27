import assert from 'assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { parseGatewayConfig } from '../../services/api-gateway/src/config/env';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { ManagedRedisClient } from '../../services/api-gateway/src/db/redis';
import { checkGatewayReadiness } from '../../services/api-gateway/src/utils/readiness';
import {
  createInitialBookingFlowState,
  resolveConfirmBookingOutcome,
  resolveLockSlotOutcome
} from '../../apps/buyer-web/src/utils/bookingFlow';
import {
  parseStoredSellerMerchant,
  resolveKycUploadOutcome,
  resolveSellerKycDisplayStatus
} from '../../apps/seller-web/src/utils/kycUpload';

interface CaseResult {
  name: string;
  passed: boolean;
  error?: string;
}

function makeTestConfig() {
  return parseGatewayConfig({
    NODE_ENV: 'test',
    PORT: '5099',
    ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:3001',
    JWT_SECRET: 's1_3_c_unit_test_secret_key_with_sufficient_bytes_2026!',
    CUSTOMER_DB_URL: 'postgresql://postgres:UnitCustSecret@127.0.0.1:5433/test_customer',
    MERCHANT_DB_URL: 'postgresql://postgres:UnitMerchSecret@127.0.0.1:5434/test_merchant',
    REDIS_URL: 'redis://default:UnitRedisSecret@127.0.0.1:6380'
  });
}

async function httpRequest(options: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function makeHealthyRedisMock(overrides: Partial<ManagedRedisClient> = {}): ManagedRedisClient {
  const client: ManagedRedisClient = {
    status: 'ready',
    connect: async () => {
      client.status = 'ready';
    },
    ping: async () => {
      if (client.status !== 'ready') throw new Error('Connection is closed.');
      return 'PONG';
    },
    set: async () => 'OK',
    ttl: async () => -2,
    del: async () => 0,
    eval: async () => 0,
    multi: () => {
      const chain: any = {
        set: () => chain,
        del: () => chain,
        exec: async () => []
      };
      return chain;
    },
    on: () => client,
    quit: async () => {
      client.status = 'end';
      return 'OK';
    },
    disconnect: () => {
      client.status = 'end';
    },
    ...overrides
  };
  return client;
}

function makePgPoolStub(
  handler: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>
): StrictPgPool {
  return {
    query: handler,
    connect: async () => ({
      query: handler,
      release: () => {}
    }),
    on: () => {},
    end: async () => {}
  };
}

export async function runS13CApiSafetyTests(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const runCase = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err: any) {
      results.push({ name, passed: false, error: err?.stack || err?.message || String(err) });
    }
  };

  // =========================================================================
  // 1. BOOKING DISABLEMENT & BUYER UI SAFETY
  // =========================================================================
  await runCase('Booking: lock-slot and confirm-payment return 503 with zero DB/Redis mutation or fake tokens', async () => {
    let customerQueries = 0;
    let merchantQueries = 0;
    let redisSetCalls = 0;
    let redisDelCalls = 0;

    const customerPool = makePgPoolStub(async (sql) => {
      customerQueries++;
      if (/^SELECT 1/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const merchantPool = makePgPoolStub(async (sql) => {
      if (/^SELECT 1/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      merchantQueries++;
      return {
        rows: [
          {
            item_id: 'item-db-1',
            item_name: 'Real Haircut Slot',
            category: 'SALON & SPA',
            price: 300,
            stock_quantity: 1,
            is_available: true,
            merchant_id: 'merch-db-1',
            business_name: 'Verified Studio',
            distance_meters: 120,
            relevance_score: 0.95
          }
        ],
        rowCount: 1
      };
    });

    const redis = makeHealthyRedisMock({
      set: async () => {
        redisSetCalls++;
        return 'OK';
      },
      del: async () => {
        redisDelCalls++;
        return 1;
      }
    });

    const cfg = makeTestConfig();
    const { server, io } = createGatewayApp(cfg, {
      customerPool,
      merchantPool,
      redis,
      aiSearchFetcher: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const lockRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/bookings/lock-slot',
        body: { slotId: 's-1', merchantId: 'm-1', userId: 'u-1', price: 250 }
      });
      assert.strictEqual(lockRes.statusCode, 503);
      const lockJson = JSON.parse(lockRes.body);
      assert.strictEqual(lockJson.success, false);
      assert.strictEqual(lockJson.code, 'BOOKING_TEMPORARILY_UNAVAILABLE');
      assert(!('lockToken' in lockJson) && !('paymentDetails' in lockJson));

      const confirmRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/bookings/confirm-payment',
        body: { slotId: 's-1', serviceName: 'Salon Haircut', lockToken: 'fake-token' }
      });
      assert.strictEqual(confirmRes.statusCode, 503);
      const confirmJson = JSON.parse(confirmRes.body);
      assert.strictEqual(confirmJson.success, false);
      assert.strictEqual(confirmJson.code, 'BOOKING_TEMPORARILY_UNAVAILABLE');
      assert(!('receipt' in confirmJson) && !confirmRes.body.includes('314') && !confirmRes.body.includes('RESILIENT-'));

      assert.strictEqual(customerQueries, 0, 'Disabled booking routes must not touch Customer DB');
      assert.strictEqual(merchantQueries, 0, 'Disabled booking routes must not query or mutate Merchant DB');
      assert.strictEqual(redisSetCalls, 0, 'Disabled booking routes must not set Redis locks');
      assert.strictEqual(redisDelCalls, 0, 'Disabled booking routes must not delete Redis keys');

      // Unrelated service discovery remains operational
      const searchRes = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/search/hyperlocal?q=haircut&lat=18.5074&lon=73.8077'
      });
      assert.strictEqual(searchRes.statusCode, 200);
      const searchJson = JSON.parse(searchRes.body);
      assert.strictEqual(searchJson.total_found, 1);
      assert.strictEqual(searchJson.results[0].item_id, 'item-db-1');
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  await runCase('Buyer Booking UI helpers fail closed on 503/network errors with zero fabricated tokens or 314 receipts', async () => {
    const init = createInitialBookingFlowState();
    assert.strictEqual(init.isSlotLocked, false);
    assert.strictEqual(init.lockToken, null);
    assert.strictEqual(init.bookingConfirmedReceipt, null);
    assert.strictEqual(init.bookingError, null);

    const lockedErr = resolveLockSlotOutcome(503, {
      success: false,
      code: 'BOOKING_TEMPORARILY_UNAVAILABLE',
      error: 'Booking is temporarily unavailable.'
    });
    assert.strictEqual(lockedErr.isSlotLocked, false);
    assert.strictEqual(lockedErr.lockToken, null);
    assert.strictEqual(lockedErr.bookingError, 'Booking is temporarily unavailable.');

    const bogusOkLock = resolveLockSlotOutcome(200, { success: true });
    assert.strictEqual(bogusOkLock.isSlotLocked, false);
    assert.strictEqual(bogusOkLock.lockToken, null);

    const confirmErr = resolveConfirmBookingOutcome(503, {
      success: false,
      code: 'BOOKING_TEMPORARILY_UNAVAILABLE',
      error: 'Booking is temporarily unavailable.'
    });
    assert.strictEqual(confirmErr.bookingConfirmedReceipt, null);
    assert.strictEqual(confirmErr.bookingError, 'Booking is temporarily unavailable.');

    const missingReceiptOk = resolveConfirmBookingOutcome(200, { success: true });
    assert.strictEqual(missingReceiptOk.bookingConfirmedReceipt, null);
    assert.ok(missingReceiptOk.bookingError);
  });

  // =========================================================================
  // 2. SELLER KYC VERIFICATION BOUNDARY, FALLBACK REMOVAL & ERROR MAPPING
  // =========================================================================
  await runCase('KYC: never sets is_verified=true, returns honest 503 when schema cannot store submissions, preserves 400/404/503/500', async () => {
    type Mode = 'found' | 'missing' | 'invalid_input_pg' | 'outage' | 'sql_bug';
    let mode: Mode = 'missing';
    let queryCount = 0;
    const executedSql: string[] = [];
    let merchantIsVerified = false;

    const cfg = makeTestConfig();
    const validSellerAccountUuid = 'b2222222-2222-4222-8222-222222222222';
    const validMerchantUuid = 'a1111111-1111-4111-8111-111111111111';
    const sellerOwnerToken = jwt.sign(
      { sub: validSellerAccountUuid, role: 'SELLER', principalType: 'SELLER_ACCOUNT' },
      cfg.jwtSecret,
      { issuer: cfg.jwtIssuer, audience: cfg.jwtSellerAudience, expiresIn: '1h' }
    );
    const authHeaders = { Authorization: `Bearer ${sellerOwnerToken}` };

    const customerPool = makePgPoolStub(async () => ({ rows: [], rowCount: 0 }));
    const merchantPool = makePgPoolStub(async (sql) => {
      queryCount++;
      executedSql.push(sql);
      if (/\bUPDATE\b/i.test(sql) && /is_verified\s*=\s*true/i.test(sql)) {
        merchantIsVerified = true;
      }
      if (mode === 'outage') {
        throw Object.assign(
          new Error('connect ECONNREFUSED 127.0.0.1:5434 postgresql://postgres:SecretPg@db:5434/merch'),
          { code: 'ECONNREFUSED' }
        );
      }
      if (mode === 'sql_bug') {
        throw Object.assign(new Error('column "bogus_col" does not exist in SQL SELECT'), { code: '42703' });
      }
      if (/FROM seller_accounts/i.test(sql)) {
        return { rows: [{ id: validSellerAccountUuid, status: 'ACTIVE' }], rowCount: 1 };
      }
      if (mode === 'missing') return { rows: [], rowCount: 0 };
      if (mode === 'invalid_input_pg') {
        throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
      }
      return {
        rows: [
          {
            store_id: validMerchantUuid,
            business_name: 'Valid Store',
            membership_role: 'OWNER',
            membership_status: 'ACTIVE'
          }
        ],
        rowCount: 1
      };
    });

    const { server, io } = createGatewayApp(cfg, {
      customerPool,
      merchantPool,
      redis: makeHealthyRedisMock()
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const origErr = console.error;
    const loggedErrors: string[] = [];
    console.error = (...args: any[]) => loggedErrors.push(args.map(String).join(' '));

    try {
      // 0. Unauthenticated upload -> 401 without touching DB
      const unauthKyc = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        body: { merchantId: validMerchantUuid, documentType: 'FSSAI_LICENSE', documentNumber: '123456' }
      });
      assert.strictEqual(unauthKyc.statusCode, 401);
      assert.strictEqual(queryCount, 0);

      // 1. Missing fields -> 400 without hitting DB
      const missingDocNum = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: authHeaders,
        body: { merchantId: validMerchantUuid, documentType: 'FSSAI_LICENSE' }
      });
      assert.strictEqual(missingDocNum.statusCode, 400);
      assert.strictEqual(queryCount, 0);

      // 2. Malformed UUID -> 400 without hitting DB
      const badUuid = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: authHeaders,
        body: { merchantId: 'm1-not-a-uuid', documentType: 'FSSAI_LICENSE', documentNumber: '123456' }
      });
      assert.strictEqual(badUuid.statusCode, 400);
      assert.strictEqual(queryCount, 0);

      // 3. Unsupported documentType -> 400 without hitting DB
      const badType = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: authHeaders,
        body: { merchantId: validMerchantUuid, documentType: 'FAKE_CERT', documentNumber: '123456' }
      });
      assert.strictEqual(badType.statusCode, 400);
      assert.strictEqual(queryCount, 0);

      // 4. Missing merchant -> 404
      mode = 'missing';
      const notFound = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: authHeaders,
        body: { merchantId: validMerchantUuid, documentType: 'FSSAI_LICENSE', documentNumber: '123456' }
      });
      assert.strictEqual(notFound.statusCode, 404);
      assert(!notFound.body.includes('VERIFIED') && !notFound.body.includes('certificate'));

      // 5. DB 22P02 -> 400
      mode = 'invalid_input_pg';
      const pg22p02 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: authHeaders,
        body: { merchantId: validMerchantUuid, documentType: 'FSSAI_LICENSE', documentNumber: '123456' }
      });
      assert.strictEqual(pg22p02.statusCode, 400);

      // 6. PG outage -> 503 without leaking credentials or returning fallback certificate
      mode = 'outage';
      const pgDown = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: authHeaders,
        body: { merchantId: validMerchantUuid, documentType: 'FSSAI_LICENSE', documentNumber: '123456' }
      });
      assert.strictEqual(pgDown.statusCode, 503);
      assert.strictEqual(JSON.parse(pgDown.body).code, 'POSTGRES_UNAVAILABLE');
      assert(!pgDown.body.includes('SecretPg') && !pgDown.body.includes('postgresql://'));
      assert(!pgDown.body.includes('VERIFIED') && !pgDown.body.includes('certificate'));

      // 7. Unexpected SQL defect -> 500 without leaking SQL or column name
      mode = 'sql_bug';
      const sqlErr = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: authHeaders,
        body: { merchantId: validMerchantUuid, documentType: 'FSSAI_LICENSE', documentNumber: '123456' }
      });
      assert.strictEqual(sqlErr.statusCode, 500);
      assert(!sqlErr.body.includes('bogus_col') && !sqlErr.body.includes('SELECT'));
      assert(loggedErrors.every((l) => !l.includes('SecretPg')));

      // 8. Existing merchant on current schema (lacks KYC submission tables):
      //    MUST NOT mutate merchants.is_verified, MUST NOT fabricate certificate/verified status,
      //    and MUST NOT claim 200 success when document submission cannot be persisted
      mode = 'found';
      const unprovisionedRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: authHeaders,
        body: { merchantId: validMerchantUuid, documentType: 'fssai_license', documentNumber: '11521038000412' }
      });
      assert.strictEqual(unprovisionedRes.statusCode, 503);
      const unprovisionedJson = JSON.parse(unprovisionedRes.body);
      assert.strictEqual(unprovisionedJson.success, false);
      assert.strictEqual(unprovisionedJson.code, 'KYC_SUBMISSION_UNAVAILABLE');
      assert(!unprovisionedRes.body.includes('certificate') && !unprovisionedRes.body.includes('VERIFIED'));
      assert.strictEqual(merchantIsVerified, false, 'KYC upload must NEVER set merchants.is_verified = true');
      assert(
        executedSql.every((sql) => !/\bUPDATE\b/i.test(sql) && !/is_verified\s*=\s*true/i.test(sql)),
        'KYC upload SQL must be read-only and never set is_verified = true'
      );
    } finally {
      console.error = origErr;
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  await runCase('Seller KYC UI helper rejects failed/unpersisted uploads and never displays verified status from submission', async () => {
    for (const status of [400, 404, 500, 503]) {
      const outcome = resolveKycUploadOutcome(false, status, {
        success: false,
        code: 'KYC_SUBMISSION_UNAVAILABLE',
        error: `Error ${status}`
      });
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(outcome.submission, null);
      assert.strictEqual(outcome.successMessage, null);
      assert.ok(outcome.errorMessage);
    }

    // Incomplete or certificate-style payloads without a genuine persisted submission must fail closed
    const incompleteOk = resolveKycUploadOutcome(true, 200, { success: true });
    assert.strictEqual(incompleteOk.ok, false);
    assert.strictEqual(incompleteOk.submission, null);

    const legacyCertAttempt = resolveKycUploadOutcome(true, 200, {
      success: true,
      certificate: {
        certificateId: 'KYC-1234ABCD',
        documentType: 'FSSAI_LICENSE',
        documentNumber: '11521038000412',
        status: 'VERIFIED'
      }
    });
    assert.strictEqual(legacyCertAttempt.ok, false);
    assert.strictEqual(legacyCertAttempt.submission, null);

    // Where future persistence supports genuine submission records, upload remains SUBMITTED (never approved/verified)
    const persistedSubmission = resolveKycUploadOutcome(true, 200, {
      success: true,
      submission: {
        submissionId: 'sub-9001',
        merchantId: 'a1111111-1111-4111-8111-111111111111',
        documentType: 'FSSAI_LICENSE',
        documentNumber: '11521038000412',
        status: 'SUBMITTED',
        submittedAt: '2026-11-26T00:00:00.000Z'
      }
    });
    assert.strictEqual(persistedSubmission.ok, true);
    assert.strictEqual(persistedSubmission.submission?.submissionId, 'sub-9001');
    assert.strictEqual(persistedSubmission.submission?.status, 'SUBMITTED');
    assert(!/verified\b|approved/i.test(persistedSubmission.submission?.status || ''));

    // Even if an upstream payload wrongly sent status='VERIFIED' or message='Verification complete!', UI clamps down
    const clampedSubmission = resolveKycUploadOutcome(true, 200, {
      success: true,
      message: 'Verification complete! Approved.',
      submission: {
        submissionId: 'sub-9002',
        documentType: 'GSTIN_CERTIFICATE',
        documentNumber: '27AABCU9603R1ZM',
        status: 'VERIFIED',
        submittedAt: '2026-11-26T00:00:00.000Z'
      }
    });
    assert.strictEqual(clampedSubmission.ok, true);
    assert.strictEqual(clampedSubmission.submission?.status, 'SUBMITTED');
    assert(!/verification complete|approved/i.test(clampedSubmission.successMessage || ''));
  });

  await runCase('Seller KYC status display rejects tampered localStorage kycApproval/submissions and distinguishes unpersisted errors', async () => {
    // 1. Tampered localStorage with kycApproval, reviewer/timestamp, isVerified, and submissions
    //    MUST NOT produce Admin Approved, KYC Approved, Verified, or Pending Admin Review
    const tamperedLocalStorageJson = JSON.stringify({
      id: 'm1',
      businessName: 'Tampered Store',
      isVerified: true,
      kycStatus: 'APPROVED',
      kycApproval: {
        status: 'APPROVED',
        reviewedBy: 'admin-reviewer-1',
        approvedAt: '2026-11-26T12:00:00.000Z'
      },
      submissions: [
        {
          submissionId: 'forged-sub-1',
          documentType: 'FSSAI_LICENSE',
          documentNumber: '11521038000412',
          status: 'SUBMITTED',
          submittedAt: '2026-11-26T00:00:00.000Z'
        }
      ],
      kycSubmissions: [{ submissionId: 'forged-sub-2' }]
    });

    const parsedMerchant = parseStoredSellerMerchant(tamperedLocalStorageJson);
    assert.strictEqual('kycApproval' in parsedMerchant, false, 'parseStoredSellerMerchant must strip kycApproval');
    assert.strictEqual('isVerified' in parsedMerchant, false, 'parseStoredSellerMerchant must strip isVerified');
    assert.strictEqual('submissions' in parsedMerchant, false, 'parseStoredSellerMerchant must strip submissions');
    assert.strictEqual('kycSubmissions' in parsedMerchant, false, 'parseStoredSellerMerchant must strip kycSubmissions');
    assert.strictEqual('kycStatus' in parsedMerchant, false, 'parseStoredSellerMerchant must strip kycStatus');

    const evenIfForgedArgPassed = (resolveSellerKycDisplayStatus as any)({
      merchant: JSON.parse(tamperedLocalStorageJson),
      submissions: JSON.parse(tamperedLocalStorageJson).submissions,
      serverConfirmedSubmissions: [],
      lastUploadError: null
    });
    assert.strictEqual(evenIfForgedArgPassed.isVerifiedApproved, false);
    assert.strictEqual(evenIfForgedArgPassed.hasPersistedSubmission, false);
    assert.strictEqual(evenIfForgedArgPassed.headerLabel, 'KYC Unverified');
    assert.strictEqual(evenIfForgedArgPassed.summaryLabel, 'Unverified — Not Submitted');
    assert.strictEqual(evenIfForgedArgPassed.badgeLabel, 'Unverified');
    assert(!/admin approved|kyc approved|\bverified\b|pending/i.test(evenIfForgedArgPassed.headerLabel));
    assert(!/admin approved|kyc approved|\bverified\b|pending/i.test(evenIfForgedArgPassed.summaryLabel));

    // 2. Failed 503 upload MUST remain unverified/unavailable and never create a pending submission
    const failedOutcome = resolveKycUploadOutcome(false, 503, {
      success: false,
      code: 'KYC_SUBMISSION_UNAVAILABLE',
      error: 'KYC document submission is temporarily unavailable until document persistence is provisioned.'
    });
    assert.strictEqual(failedOutcome.ok, false);
    assert.strictEqual(failedOutcome.submission, null);
    assert.ok(failedOutcome.errorMessage?.includes('unavailable'));

    const afterFailedUpload = resolveSellerKycDisplayStatus({
      serverConfirmedSubmissions: [],
      lastUploadError: failedOutcome.errorMessage
    });
    assert.strictEqual(afterFailedUpload.isVerifiedApproved, false);
    assert.strictEqual(afterFailedUpload.hasPersistedSubmission, false);
    assert.strictEqual(afterFailedUpload.headerLabel, 'KYC Submission Unavailable');
    assert.strictEqual(afterFailedUpload.summaryLabel, 'Submission Unavailable');
    assert.strictEqual(afterFailedUpload.badgeLabel, 'Unverified');
    assert(!/pending|submitted|approved|\bverified\b/i.test(afterFailedUpload.headerLabel));

    // 3. Genuine server-persisted submission creates pending review only (distinct from approved verification)
    const withPersistedSubmission = resolveKycUploadOutcome(true, 200, {
      success: true,
      submission: {
        submissionId: 'sub-9100',
        documentType: 'FSSAI_LICENSE',
        documentNumber: '11521038000412',
        status: 'SUBMITTED',
        submittedAt: '2026-11-26T00:00:00.000Z'
      }
    });
    assert.strictEqual(withPersistedSubmission.ok, true);

    const pendingState = resolveSellerKycDisplayStatus({
      serverConfirmedSubmissions: [withPersistedSubmission.submission!],
      lastUploadError: null
    });
    assert.strictEqual(pendingState.isVerifiedApproved, false);
    assert.strictEqual(pendingState.hasPersistedSubmission, true);
    assert.strictEqual(pendingState.headerLabel, 'KYC Submitted (Pending Review)');
    assert.strictEqual(pendingState.summaryLabel, 'Pending Admin Review');
    assert.strictEqual(pendingState.badgeLabel, 'Pending Review');
  });

  // =========================================================================
  // 3. SEARCH: REAL EMPTY RESULTS, PG OUTAGE 503, AI FALLBACK & SQL 500
  // =========================================================================
  await runCase('Search: empty DB returns {total_found:0, results:[]}, PG outage returns 503, AI down uses real DB, SQL bug returns 500', async () => {
    let aiMode: 'empty' | 'down' | 'real_ai' = 'down';
    let dbMode: 'empty' | 'rows' | 'outage' | 'sql_bug' = 'empty';

    const merchantPool = makePgPoolStub(async (sql) => {
      if (dbMode === 'outage') {
        throw Object.assign(
          new Error('connection terminated unexpectedly postgresql://pg:SearchSecret@host:5434/merch'),
          { code: '57P01' }
        );
      }
      if (dbMode === 'sql_bug') {
        throw Object.assign(new Error('relation "missing_items" does not exist'), { code: '42P01' });
      }
      if (dbMode === 'rows') {
        if (sql.includes('FROM inventory_items i') && !sql.includes('UNION ALL')) {
          return {
            rows: [
              {
                id: 'live-1',
                item_name: 'Organic Cow Milk',
                category: 'GROCERY',
                description: 'Fresh milk',
                price: 65,
                stock_quantity: 12,
                merchant_id: 'm-real-1',
                business_name: 'Real Farm Dairy',
                merchant_category: 'GROCERY',
                address: 'Kothrud',
                rating: 4.8
              }
            ],
            rowCount: 1
          };
        }
        return {
          rows: [
            {
              item_id: 'db-item-1',
              item_name: 'Organic Cow Milk',
              category: 'GROCERY',
              price: 65,
              stock_quantity: 12,
              is_available: true,
              merchant_id: 'm-real-1',
              business_name: 'Real Farm Dairy',
              distance_meters: 0,
              relevance_score: 0.99
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const { server, io } = createGatewayApp(makeTestConfig(), {
      customerPool: makePgPoolStub(async () => ({ rows: [], rowCount: 0 })),
      merchantPool,
      redis: makeHealthyRedisMock(),
      aiSearchFetcher: async () => {
        if (aiMode === 'down') {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
        }
        if (aiMode === 'empty') {
          return { query: 'nonexistent', radius_km: 10, total_found: 0, results: [] };
        }
        return { query: 'milk', radius_km: 10, total_found: 1, results: [{ item_id: 'ai-1' }] };
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const origErr = console.error;
    const origWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};

    try {
      // 1. Healthy DB with 0 matches (both GET & POST) returns real empty results, never static catalog
      aiMode = 'down';
      dbMode = 'empty';
      const emptyGet = await httpRequest({ port, method: 'GET', path: '/api/v1/search/hyperlocal?q=unicorns' });
      assert.strictEqual(emptyGet.statusCode, 200);
      const emptyGetJson = JSON.parse(emptyGet.body);
      assert.strictEqual(emptyGetJson.total_found, 0);
      assert.deepStrictEqual(emptyGetJson.results, []);

      aiMode = 'empty';
      const emptyPost = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/search/hyperlocal',
        body: { query: 'bread', latitude: 18.5, longitude: 73.8, max_radius_km: 5, limit: 10 }
      });
      assert.strictEqual(emptyPost.statusCode, 200);
      assert.strictEqual(JSON.parse(emptyPost.body).total_found, 0);
      assert.deepStrictEqual(JSON.parse(emptyPost.body).results, []);

      // 2. AI unavailable -> DB fallback returns genuine stored DB records (preserving 0m distance)
      aiMode = 'down';
      dbMode = 'rows';
      const dbFallback = await httpRequest({ port, method: 'GET', path: '/api/v1/search/hyperlocal?q=milk' });
      assert.strictEqual(dbFallback.statusCode, 200);
      const dbFallbackJson = JSON.parse(dbFallback.body);
      assert.strictEqual(dbFallbackJson.total_found, 1);
      assert.strictEqual(dbFallbackJson.results[0].item_id, 'db-item-1');
      assert.strictEqual(dbFallbackJson.results[0].distance_meters, 0);

      // 3. PG outage -> 503 on both /hyperlocal and /live-catalog (never 200 empty or mock results, never leaks secret)
      dbMode = 'outage';
      const outageSearch = await httpRequest({ port, method: 'GET', path: '/api/v1/search/hyperlocal?q=milk' });
      assert.strictEqual(outageSearch.statusCode, 503);
      assert(!outageSearch.body.includes('SearchSecret') && !outageSearch.body.includes('results'));

      const outageCatalog = await httpRequest({ port, method: 'GET', path: '/api/v1/search/live-catalog' });
      assert.strictEqual(outageCatalog.statusCode, 503);
      assert(!outageCatalog.body.includes('SearchSecret') && !outageCatalog.body.includes('"success":true'));

      // 4. Unexpected SQL error -> 500 without leaking relation names
      dbMode = 'sql_bug';
      const sqlBugSearch = await httpRequest({ port, method: 'POST', path: '/api/v1/search/hyperlocal', body: { query: 'milk' } });
      assert.strictEqual(sqlBugSearch.statusCode, 500);
      assert(!sqlBugSearch.body.includes('missing_items'));

      const sqlBugCatalog = await httpRequest({ port, method: 'GET', path: '/api/v1/search/live-catalog' });
      assert.strictEqual(sqlBugCatalog.statusCode, 500);
      assert(!sqlBugCatalog.body.includes('missing_items'));

      // 5. Invalid coords -> 400
      dbMode = 'empty';
      const badCoords = await httpRequest({ port, method: 'GET', path: '/api/v1/search/hyperlocal?q=milk&lat=notanumber' });
      assert.strictEqual(badCoords.statusCode, 400);
    } finally {
      console.error = origErr;
      console.warn = origWarn;
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  // =========================================================================
  // 4. HEALTH LIVENESS, READINESS (/api/ready) & NODE STATUS
  // =========================================================================
  await runCase('Health/Readiness/NodeStatus: liveness stays 200 on outages; readiness & node-status return 503 and reuse injected clients', async () => {
    let custMode: 'up' | 'down' | 'hang' = 'up';
    let merchMode: 'up' | 'down' | 'sql_bug' = 'up';
    let custQueries = 0;
    let merchQueries = 0;
    let redisPings = 0;

    const customerPool = makePgPoolStub(async (sql) => {
      custQueries++;
      if (custMode === 'down') {
        throw Object.assign(
          new Error('connect ECONNREFUSED 127.0.0.1:5433 postgresql://postgres:CustPass99@db:5433/cust'),
          { code: 'ECONNREFUSED' }
        );
      }
      if (custMode === 'hang') {
        return new Promise(() => {});
      }
      if (/count\(\*\)/i.test(sql)) return { rows: [{ count: 0 }], rowCount: 1 };
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    });

    const merchantPool = makePgPoolStub(async (sql) => {
      merchQueries++;
      if (merchMode === 'down') {
        throw Object.assign(
          new Error('the database system is shutting down'),
          { code: '57P01' }
        );
      }
      if (merchMode === 'sql_bug') {
        if (/^SELECT 1/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
        throw Object.assign(new Error('column missing'), { code: '42703' });
      }
      if (/count\(\*\)/i.test(sql)) return { rows: [{ count: 0 }], rowCount: 1 };
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    });

    const redis = makeHealthyRedisMock({
      status: 'wait',
      connect: async () => {
        redis.status = 'ready';
      },
      ping: async () => {
        redisPings++;
        if (redis.status !== 'ready') throw new Error('redis://default:RedisSecret88@127.0.0.1:6380 down');
        return 'PONG';
      }
    });

    const { server, io } = createGatewayApp(makeTestConfig(), { customerPool, merchantPool, redis });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const origErr = console.error;
    console.error = () => {};

    try {
      // 1. Liveness touches zero deps even when deps fail
      custMode = 'down';
      merchMode = 'down';
      redis.status = 'reconnecting';
      const healthDown = await httpRequest({ port, method: 'GET', path: '/api/health' });
      assert.strictEqual(healthDown.statusCode, 200);
      assert.strictEqual(JSON.parse(healthDown.body).status, 'healthy');
      assert.strictEqual(custQueries, 0);
      assert.strictEqual(merchQueries, 0);
      assert.strictEqual(redisPings, 0);

      // 2. All deps healthy -> /api/ready 200 (also dials lazy 'wait' Redis via existing client) & /node-status 200 with real 0 counts
      custMode = 'up';
      merchMode = 'up';
      redis.status = 'wait';
      const readyOk = await httpRequest({ port, method: 'GET', path: '/api/ready' });
      assert.strictEqual(readyOk.statusCode, 200);
      const readyOkJson = JSON.parse(readyOk.body);
      assert.strictEqual(readyOkJson.ready, true);
      assert.strictEqual(readyOkJson.checks.customerDb.status, 'up');
      assert.strictEqual(readyOkJson.checks.merchantDb.status, 'up');
      assert.strictEqual(readyOkJson.checks.redis.status, 'up');
      assert(custQueries >= 1 && merchQueries >= 1 && redisPings >= 1);

      const nodeOk = await httpRequest({ port, method: 'GET', path: '/api/v1/server/node-status' });
      assert.strictEqual(nodeOk.statusCode, 200);
      const nodeOkJson = JSON.parse(nodeOk.body);
      assert.strictEqual(nodeOkJson.ready, true);
      assert.deepStrictEqual(nodeOkJson.node.stats, { users: 0, merchants: 0, inventoryItems: 0 });

      // 3. Customer DB down -> /api/ready 503 and /node-status 503 (never leaks secret or returns fake stats)
      custMode = 'down';
      const readyNoCust = await httpRequest({ port, method: 'GET', path: '/api/ready' });
      assert.strictEqual(readyNoCust.statusCode, 503);
      assert.strictEqual(JSON.parse(readyNoCust.body).checks.customerDb.status, 'down');
      assert(!readyNoCust.body.includes('CustPass99'));

      const nodeNoCust = await httpRequest({ port, method: 'GET', path: '/api/v1/server/node-status' });
      assert.strictEqual(nodeNoCust.statusCode, 503);
      assert(!nodeNoCust.body.includes('Active In-Memory Datastore') && !nodeNoCust.body.includes('CustPass99'));

      // 4. Merchant DB down -> /api/ready 503
      custMode = 'up';
      merchMode = 'down';
      const readyNoMerch = await httpRequest({ port, method: 'GET', path: '/api/ready' });
      assert.strictEqual(readyNoMerch.statusCode, 503);
      assert.strictEqual(JSON.parse(readyNoMerch.body).checks.merchantDb.status, 'down');

      // 5. Redis down -> /api/ready 503
      merchMode = 'up';
      redis.status = 'reconnecting';
      const readyNoRedis = await httpRequest({ port, method: 'GET', path: '/api/ready' });
      assert.strictEqual(readyNoRedis.statusCode, 503);
      assert.strictEqual(JSON.parse(readyNoRedis.body).checks.redis.status, 'down');

      // 6. Bounded timeout prevents hanging check from blocking /api/ready
      custMode = 'hang';
      redis.status = 'ready';
      const bounded = await checkGatewayReadiness({
        customerPool,
        merchantPool,
        redis,
        timeoutMs: 30
      });
      assert.strictEqual(bounded.ready, false);
      assert.strictEqual(bounded.checks.customerDb.status, 'down');
      assert.strictEqual(bounded.checks.merchantDb.status, 'up');
      assert.strictEqual(bounded.checks.redis.status, 'up');

      // 7. Node-status handles unexpected SQL error on count query cleanly (500, no leaked column names)
      custMode = 'up';
      merchMode = 'sql_bug';
      const nodeSqlErr = await httpRequest({ port, method: 'GET', path: '/api/v1/server/node-status' });
      assert.strictEqual(nodeSqlErr.statusCode, 500);
      assert(!nodeSqlErr.body.includes('missing'));
    } finally {
      console.error = origErr;
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  // =========================================================================
  // 5. STATIC SOURCE AUDIT: ZERO FABRICATED CONSTANTS OR SELF-APPROVAL
  // =========================================================================
  await runCase('Production files contain no fabricated tokens (314, RESILIENT-), fallbackCert, auto-verified KYC, or mock search', async () => {
    const repoRoot = process.cwd();
    const appSrc = fs.readFileSync(path.join(repoRoot, 'services/api-gateway/src/app.ts'), 'utf8');
    const authSrc = fs.readFileSync(path.join(repoRoot, 'services/api-gateway/src/routes/auth.ts'), 'utf8');
    const searchSrc = fs.readFileSync(path.join(repoRoot, 'services/api-gateway/src/routes/search.ts'), 'utf8');
    const aiSrc = fs.readFileSync(path.join(repoRoot, 'services/ai-agent-engine/main.py'), 'utf8');
    const buyerSrc = fs.readFileSync(path.join(repoRoot, 'apps/buyer-web/src/pages/index.tsx'), 'utf8');
    const sellerSrc = fs.readFileSync(path.join(repoRoot, 'apps/seller-web/src/pages/index.tsx'), 'utf8');

    assert(!appSrc.includes('Active In-Memory Datastore'), 'app.ts must not reference fake in-memory datastore');
    assert(!appSrc.includes('streetverse.merchant@okhdfcbank'), 'app.ts must not include fake booking VPA');
    assert(!authSrc.includes('DOC-${'), 'auth.ts must not fabricate fallback KYC document numbers');
    assert(!authSrc.includes('STREETVERSE-VETTED-MERCHANT'), 'auth.ts must not fabricate verified KYC badges');
    const kycSection = authSrc.slice(authSrc.indexOf('/seller/kyc/upload'));
    assert(!kycSection.includes('SET is_verified = true'), 'KYC submission route must never set merchants.is_verified = true');
    assert(!searchSrc.includes('generateContextualSearchResults'), 'search.ts must remove static mock catalog');
    assert(!aiSrc.includes('mock-1') && !aiSrc.includes('generateContent'), 'AI engine must remove Gemini mock generator');
    assert(!buyerSrc.includes('RESILIENT-') && !buyerSrc.includes('STREETVERSE-PASS-PUNE-314'), 'Buyer UI must remove fabricated booking tokens');
    const kycHelperSrc = fs.readFileSync(path.join(repoRoot, 'apps/seller-web/src/utils/kycUpload.ts'), 'utf8');
    const kycHelperCodeOnly = kycHelperSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert(!sellerSrc.includes('fallbackCert'), 'Seller UI must not contain fallbackCert');
    assert(!sellerSrc.includes('KYC-FSSAI-189201'), 'Seller UI must not contain default fake cert');
    assert(!sellerSrc.includes('100% KYC Verified Merchant'), 'Seller UI must not contain hardcoded verified banner');
    assert(!sellerSrc.includes('STREETVERSE-VETTED-MERCHANT'), 'Seller UI must not contain fake vetted badge');
    assert(!sellerSrc.includes('currentMerchant?.isVerified'), 'Seller UI must not read currentMerchant.isVerified');
    assert(!sellerSrc.includes('kycApproval'), 'Seller UI must not reference kycApproval');
    assert(!/['"]Admin Approved['"]|['"]KYC Approved['"]/.test(sellerSrc), 'Seller UI must not contain Admin/KYC Approved literals');
    assert(
      !sellerSrc.includes("localStorage.getItem('streetverse_seller_merchant')"),
      'Seller UI must not read untrusted streetverse_seller_merchant from localStorage'
    );
    assert(sellerSrc.includes('hydrateSellerSession'), 'Seller UI must hydrate session via hydrateSellerSession');
    assert(sellerSrc.includes('resolveSellerKycDisplayStatus'), 'Seller UI must use resolveSellerKycDisplayStatus');
    assert(
      !/\bkycApproval\b|\bisVerified\b|TrustedKycApprovalEvidence|hasTrustedKycApproval|['"]Admin Approved['"]|['"]KYC Approved['"]/.test(
        kycHelperCodeOnly
      ),
      'kycUpload helper code must not accept kycApproval, isVerified, or Admin/KYC Approved literals'
    );
  });

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runS13CApiSafetyTests()
    .then((results) => {
      let failed = 0;
      for (const r of results) {
        if (r.passed) {
          console.log(`  PASS: ${r.name}`);
        } else {
          failed++;
          console.error(`  FAIL: ${r.name} -> ${r.error}`);
        }
      }
      console.log(`\nS1.3-C API Failure Safety Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal S1.3-C test error:', err);
      process.exit(1);
    });
}
