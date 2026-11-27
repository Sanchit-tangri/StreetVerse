/**
 * MO-B4 Unit Tests: Template Safety & Scrubbing, Exponential Backoff,
 * Fail-Closed Email Config Reporting, RBAC/IDOR Rejection, and Audit Rollback Safety.
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
import { createEmailService } from '../../services/api-gateway/src/services/email';
import {
  ClaimedOutboxEvent,
  computeRetryBackoffMs,
  renderOwnerNotificationContent,
  scrubSensitiveNotificationText
} from '../../services/api-gateway/src/services/notificationOutbox';
import { reactivateMerchantStore } from '../../services/api-gateway/src/services/adminCompliance';

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

const TEST_JWT_SECRET = 'mob4-unit-test-secret-with-at-least-32-bytes!';
const ADMIN_1_ID = '99991111-1111-4111-8111-111111111111';
const ADMIN_2_ID = '99992222-2222-4222-8222-111111111111';
const STORE_1_ID = '11111111-1111-4111-8111-111111111111';
const STORE_2_ID = '22222222-2222-4222-8222-111111111111';
const OWNER_1_ID = 'aaaa1111-1111-4111-8111-111111111111';
const OWNER_2_ID = 'aaaa2222-2222-4222-8222-222222222222';
const STAFF_1_ID = 'bbbb1111-1111-4111-8111-111111111111';
const NOTIF_1_ID = 'ffff1111-1111-4111-8111-111111111111';
const EVENT_1_ID = 'dddd1111-1111-4111-8111-111111111111';

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
    kycStorageDir: path.join(os.tmpdir(), 'streetverse-mob4-unit-storage'),
    notificationWorkerEnabled: false
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

function makeAdminToken(sub: string): string {
  return jwt.sign(
    { sub, role: 'ADMIN', principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE, email: 'ops@streetverse.ops' },
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

// ============================================================
// 1. Safe Template Rendering, Scrubbing & Exponential Backoff
// ============================================================

test('renderOwnerNotificationContent sanitizes sensitive tokens, escapes HTML, and preserves safe context across event types', () => {
  const scrubbed = scrubSensitiveNotificationText(
    'See C:\\private\\kyc\\doc.pdf and /var/data/storage_key=secret123 Bearer abc.def.ghi'
  );
  assert(!scrubbed.includes('C:\\private'), 'Windows path scrubbed');
  assert(!scrubbed.includes('/var/data'), 'Unix path scrubbed');
  assert(!scrubbed.includes('secret123'), 'storage_key token scrubbed');
  assert(!scrubbed.includes('abc.def.ghi'), 'Bearer token scrubbed');

  const events: ClaimedOutboxEvent[] = [
    {
      id: EVENT_1_ID,
      merchantId: STORE_1_ID,
      storeBusinessName: 'Bharat Kirana <script>alert(1)</script>',
      submissionId: 'sub-1',
      submissionVersion: 2,
      warningId: null,
      ownerSellerAccountId: OWNER_1_ID,
      recipientRole: 'OWNER',
      eventType: 'ONBOARDING_APPROVED',
      payload: { businessName: 'Bharat Kirana <script>alert(1)</script>', submissionVersion: 2 },
      deliveryAttempts: 1,
      maxAttempts: 5,
      inAppStatus: 'PENDING',
      emailStatus: 'PENDING'
    },
    {
      id: EVENT_1_ID,
      merchantId: STORE_1_ID,
      storeBusinessName: 'Bharat Kirana',
      submissionId: null,
      submissionVersion: null,
      warningId: 'warn-1',
      ownerSellerAccountId: OWNER_1_ID,
      recipientRole: 'OWNER',
      eventType: 'COMPLIANCE_WARNING_ESCALATED',
      payload: { warningNumber: 2, escalationNotes: 'INTERNAL_CONFIDENTIAL_ADMIN_NOTE' },
      deliveryAttempts: 1,
      maxAttempts: 5,
      inAppStatus: 'PENDING',
      emailStatus: 'PENDING'
    }
  ];

  const approvedRendered = renderOwnerNotificationContent(events[0]);
  assert(!approvedRendered.emailHtml.includes('<script>'), 'HTML escaped safely');
  assert(approvedRendered.emailHtml.includes('&lt;script&gt;'), 'Escaped tag preserved safely');
  assert(approvedRendered.message.includes('remains closed'), 'Approval explicitly keeps store closed reminder');

  const escRendered = renderOwnerNotificationContent(events[1]);
  assert(!escRendered.message.includes('INTERNAL_CONFIDENTIAL_ADMIN_NOTE'), 'Escalation notes excluded');
  assert(!escRendered.emailText.includes('INTERNAL_CONFIDENTIAL_ADMIN_NOTE'), 'Escalation notes excluded from email');

  // Exponential backoff bounded strictly
  assertEqual(computeRetryBackoffMs(1, 1000, 10000), 1000, 'Attempt 1 delay');
  assertEqual(computeRetryBackoffMs(2, 1000, 10000), 2000, 'Attempt 2 delay');
  assertEqual(computeRetryBackoffMs(4, 1000, 10000), 8000, 'Attempt 4 delay');
  assertEqual(computeRetryBackoffMs(8, 1000, 10000), 10000, 'Attempt 8 capped at max');
});

// ============================================================
// 2. Transactional Email Unconfigured / Transient / Permanent Handling
// ============================================================

test('sendTransactionalEmail never fakes success when SMTP is missing and classifies transient vs permanent SMTP errors', async () => {
  const prevUser = process.env.SMTP_USER;
  const prevPass = process.env.SMTP_PASS;
  process.env.SMTP_USER = 'YOUR_SMTP_USER_EMAIL_HERE';
  process.env.SMTP_PASS = '';

  try {
    // Even in test/development env, missing SMTP returns UNCONFIGURED (never SENT)
    const unconfSvc = createEmailService({
      redisClient: makeHealthyRedisMock(),
      nodeEnv: 'test',
      transporter: null
    });
    const unconfRes = await unconfSvc.sendTransactionalEmail!({
      to: 'owner@example.test',
      subject: 'Test Subject',
      text: 'Hello',
      html: '<p>Hello</p>',
      idempotencyKey: EVENT_1_ID
    });
    assertEqual(unconfRes.status, 'UNCONFIGURED', 'Never fake SENT when SMTP missing in test env');

    // Transient network error
    const transientSvc = createEmailService({
      redisClient: makeHealthyRedisMock(),
      nodeEnv: 'production',
      transporter: {
        sendMail: async () => {
          const e: any = new Error('Connection timed out');
          e.code = 'ETIMEDOUT';
          throw e;
        }
      }
    });
    const transRes = await transientSvc.sendTransactionalEmail!({
      to: 'owner@example.test',
      subject: 'Test Subject',
      text: 'Hello',
      html: '<p>Hello</p>',
      idempotencyKey: EVENT_1_ID
    });
    assertEqual(transRes.status, 'FAILED', 'Transient failure reported');
    if (transRes.status === 'FAILED') {
      assertEqual(transRes.transient, true, 'ETIMEDOUT classified transient');
    }

    // Permanent 550 bounce
    const permSvc = createEmailService({
      redisClient: makeHealthyRedisMock(),
      nodeEnv: 'production',
      transporter: {
        sendMail: async () => {
          const e: any = new Error('Mailbox unavailable');
          e.responseCode = 550;
          throw e;
        }
      }
    });
    const permRes = await permSvc.sendTransactionalEmail!({
      to: 'bad@example.test',
      subject: 'Test Subject',
      text: 'Hello',
      html: '<p>Hello</p>'
    });
    assertEqual(permRes.status, 'FAILED', '550 bounce reported');
    if (permRes.status === 'FAILED') {
      assertEqual(permRes.transient, false, 'SMTP 550 classified non-transient');
    }

    // Success attaches idempotency header cleanly
    let capturedHeader: string | undefined;
    const okSvc = createEmailService({
      redisClient: makeHealthyRedisMock(),
      nodeEnv: 'production',
      transporter: {
        sendMail: async (opts: any) => {
          capturedHeader = opts?.headers?.['X-StreetVerse-Idempotency-Key'];
          return { messageId: 'msg-001' };
        }
      }
    });
    const okRes = await okSvc.sendTransactionalEmail!({
      to: 'owner@example.test',
      subject: 'Test',
      text: 'Body',
      html: '<p>Body</p>',
      idempotencyKey: EVENT_1_ID
    });
    assertEqual(okRes.status, 'SENT', 'Configured transporter succeeds');
    assertEqual(capturedHeader, EVENT_1_ID, 'Idempotency key header attached');
  } finally {
    process.env.SMTP_USER = prevUser;
    process.env.SMTP_PASS = prevPass;
  }
});

// ============================================================
// 3. Owner Notification & Admin Outbox HTTP RBAC & Spoof Rejection
// ============================================================

test('Notification endpoints enforce strict Owner vs Staff RBAC, reject spoofed actor/recipient IDs, and guard Admin outbox APIs', async () => {
  let capturedQuerySellerId = '';
  let capturedReplayAdminId = '';

  const query = async (sql: string, params: any[] = []) => {
    if (/FROM admin_accounts\s+WHERE id = \$1/i.test(sql)) {
      return String(params[0]) === ADMIN_1_ID
        ? { rows: [{ id: ADMIN_1_ID, email: 'ops@streetverse.ops', full_name: 'Ops Admin', role: 'ADMIN', status: 'ACTIVE' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM seller_accounts/i.test(sql)) {
      const id = String(params[0]);
      if (id === OWNER_1_ID || id === OWNER_2_ID || id === STAFF_1_ID) {
        return { rows: [{ id, status: 'ACTIVE', phone: '+919800000001', email: `${id}@test.local`, is_email_verified: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/FROM merchants m\s+LEFT JOIN store_memberships sm/i.test(sql)) {
      const sellerId = String(params[0]);
      const storeId = String(params[1]);
      if (storeId !== STORE_1_ID && storeId !== STORE_2_ID) return { rows: [], rowCount: 0 };
      const role =
        storeId === STORE_1_ID
          ? sellerId === OWNER_1_ID
            ? 'OWNER'
            : sellerId === STAFF_1_ID
              ? 'STAFF'
              : null
          : sellerId === OWNER_2_ID
            ? 'OWNER'
            : null;
      return {
        rows: [{ store_id: storeId, business_name: 'Sample', membership_role: role, membership_status: role ? 'ACTIVE' : null }],
        rowCount: 1
      };
    }
    if (/FROM store_memberships sm\s+JOIN seller_accounts sa/i.test(sql) && /LIMIT 1/i.test(sql)) {
      const sellerId = String(params[0]);
      const storeId = String(params[1]);
      const allowed = (storeId === STORE_1_ID && sellerId === OWNER_1_ID) || (storeId === STORE_2_ID && sellerId === OWNER_2_ID);
      return { rows: allowed ? [{ '1': 1 }] : [], rowCount: allowed ? 1 : 0 };
    }
    if (/FROM owner_notifications n/i.test(sql)) {
      if (/COUNT\(\*\)::int AS total_count/i.test(sql)) {
        capturedQuerySellerId = String(params[0]);
        return { rows: [{ total_count: 1, unread_count: 1 }], rowCount: 1 };
      }
      if (/FOR UPDATE OF n/i.test(sql)) {
        const nid = String(params[0]);
        const sellerId = String(params[1]);
        if (nid === NOTIF_1_ID && sellerId === OWNER_1_ID) {
          return {
            rows: [{
              id: NOTIF_1_ID,
              outbox_event_id: EVENT_1_ID,
              merchant_id: STORE_1_ID,
              store_business_name: 'Sample Store',
              recipient_seller_account_id: OWNER_1_ID,
              event_type: 'ONBOARDING_APPROVED',
              title: 'Approved',
              message: 'Approved safely',
              metadata: {},
              is_read: false,
              read_at: null,
              created_at: new Date().toISOString()
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{
          id: NOTIF_1_ID,
          outbox_event_id: EVENT_1_ID,
          merchant_id: STORE_1_ID,
          store_business_name: 'Sample Store',
          recipient_seller_account_id: OWNER_1_ID,
          event_type: 'ONBOARDING_APPROVED',
          title: 'Approved',
          message: 'Approved safely',
          metadata: {},
          is_read: false,
          read_at: null,
          created_at: new Date().toISOString()
        }],
        rowCount: 1
      };
    }
    if (/UPDATE owner_notifications/i.test(sql)) {
      return {
        rows: [{
          id: NOTIF_1_ID,
          outbox_event_id: EVENT_1_ID,
          merchant_id: STORE_1_ID,
          recipient_seller_account_id: OWNER_1_ID,
          event_type: 'ONBOARDING_APPROVED',
          title: 'Approved',
          message: 'Approved safely',
          metadata: {},
          is_read: true,
          read_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        }],
        rowCount: 1
      };
    }
    if (/SELECT \* FROM owner_notification_events WHERE id = \$1 FOR UPDATE/i.test(sql)) {
      return {
        rows: [{ id: EVENT_1_ID, merchant_id: STORE_1_ID, event_type: 'ONBOARDING_APPROVED', delivery_status: 'TERMINAL_FAILED' }],
        rowCount: 1
      };
    }
    if (/UPDATE owner_notification_events\s+SET delivery_status = 'PENDING'/i.test(sql)) {
      capturedReplayAdminId = String(params[0]);
      return { rows: [{ merchant_id: STORE_1_ID, replayed_at: new Date().toISOString() }], rowCount: 1 };
    }
    if (/INSERT INTO store_onboarding_audit_events/i.test(sql)) {
      return { rows: [{ id: 'aud-1' }], rowCount: 1 };
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
    enableRedisAdapter: false,
    startNotificationWorker: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const adminJwt = makeAdminToken(ADMIN_1_ID);
  const owner1Jwt = makeSellerToken(OWNER_1_ID);
  const owner2Jwt = makeSellerToken(OWNER_2_ID);
  const staffJwt = makeSellerToken(STAFF_1_ID);
  const buyerJwt = makeBuyerToken('bbbb0000-0000-4000-8000-000000000000');

  try {
    // STAFF and cross-store Owner blocked on store notifications
    assertEqual(
      (await httpRequest({ port, method: 'GET', path: `/api/v1/seller/stores/${STORE_1_ID}/notifications`, headers: { Authorization: `Bearer ${staffJwt}` } })).statusCode,
      403,
      'STAFF cannot list store notifications'
    );
    assertEqual(
      (await httpRequest({ port, method: 'GET', path: `/api/v1/seller/stores/${STORE_1_ID}/notifications`, headers: { Authorization: `Bearer ${owner2Jwt}` } })).statusCode,
      403,
      'Owner 2 cannot read Store 1 notifications'
    );
    assertEqual(
      (await httpRequest({ port, method: 'GET', path: `/api/v1/seller/stores/${STORE_1_ID}/notifications` })).statusCode,
      401,
      'Unauthenticated request rejected on Seller notifications'
    );
    assertEqual(
      (await httpRequest({ port, method: 'GET', path: `/api/v1/seller/stores/${STORE_1_ID}/notifications`, headers: { Authorization: `Bearer ${buyerJwt}` } })).statusCode,
      403,
      'Buyer cannot read Seller notifications'
    );

    // Owner 2 passing ?recipientId=OWNER_1_ID or ?storeId=STORE_1_ID on account route cannot access Owner 1/Store 1
    assertEqual(
      (await httpRequest({
        port,
        method: 'GET',
        path: `/api/v1/seller/notifications?storeId=${STORE_1_ID}&recipientId=${OWNER_1_ID}`,
        headers: { Authorization: `Bearer ${owner2Jwt}` }
      })).statusCode,
      403,
      'Account notifications rejects unauthorized storeId filter'
    );
    // Owner 2 cannot mark Owner 1 notification read
    assertEqual(
      (await httpRequest({
        port,
        method: 'POST',
        path: `/api/v1/seller/notifications/${NOTIF_1_ID}/read`,
        headers: { Authorization: `Bearer ${owner2Jwt}` },
        body: { recipientId: OWNER_1_ID }
      })).statusCode,
      404,
      'Owner 2 cannot mark Owner 1 notification read'
    );

    // Owner 1 list ignores ?recipientId=OWNER_2_ID and uses JWT sub
    const o1List = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/seller/stores/${STORE_1_ID}/notifications?recipientId=${OWNER_2_ID}`,
      headers: { Authorization: `Bearer ${owner1Jwt}` }
    });
    assertEqual(o1List.statusCode, 200, 'Owner 1 reads Store 1 notifications');
    assertEqual(capturedQuerySellerId, OWNER_1_ID, 'Query always uses verified JWT sub');

    // Non-admin blocked from outbox replay; Admin replay ignores forged adminId in body
    assertEqual(
      (await httpRequest({
        port,
        method: 'POST',
        path: `/api/v1/admin/notifications/outbox/${EVENT_1_ID}/replay`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      })).statusCode,
      401,
      'Seller rejected on Admin replay API'
    );
    const replayOk = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/notifications/outbox/${EVENT_1_ID}/replay`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: { adminId: ADMIN_2_ID, reason: 'Retry transient failure safely' }
    });
    assertEqual(replayOk.statusCode, 200, 'Admin replay succeeds');
    assertEqual(capturedReplayAdminId, ADMIN_1_ID, 'Replay derives Admin identity solely from req.adminAuth');
  } finally {
    await shutdown();
  }
});

// ============================================================
// 4. Transactional Abort Rolls Back Partial Multi-Warning Reactivation
// ============================================================

test('reactivateMerchantStore rolls back transaction if a later warning resolution fails inside atomic loop', async () => {
  let rollbackCalled = 0;
  let commitCalled = 0;
  const W1 = 'f1111111-1111-4111-8111-111111111101';
  const W2 = 'f2222222-2222-4222-8222-222222222202';

  const query = async (sql: string, params: any[] = []) => {
    if (/FROM merchants\s+WHERE id = \$1/i.test(sql)) {
      return { rows: [{ id: STORE_1_ID, business_name: 'S1', category: 'GROCERY', is_open: false }], rowCount: 1 };
    }
    if (/FROM store_onboarding_profiles\s+WHERE merchant_id = \$1/i.test(sql)) {
      return {
        rows: [{
          id: 'p1',
          merchant_id: STORE_1_ID,
          status: 'SUSPENDED',
          pre_suspension_status: 'APPROVED',
          approved_submission_id: 'sub-1',
          reverification_required: false,
          owner_suspension_responded_at: new Date().toISOString()
        }],
        rowCount: 1
      };
    }
    if (/FROM store_compliance_warnings\s+WHERE merchant_id = \$1/i.test(sql)) {
      return {
        rows: [
          { id: W1, merchant_id: STORE_1_ID, warning_number: 1, status: 'OPEN', is_formal_ordinary: true, corrective_deadline: null },
          { id: W2, merchant_id: STORE_1_ID, warning_number: 2, status: 'OPEN', is_formal_ordinary: true, corrective_deadline: null }
        ],
        rowCount: 2
      };
    }
    if (/FROM store_compliance_warning_responses/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ cnt: 1 }], rowCount: 1 };
      // W1 has an Owner response, W2 does NOT -> W2 fails inside resolveWarningWithinTx AFTER W1 updated!
      const wid = String(params[0]);
      if (wid === W1) {
        return { rows: [{ id: 'r1', responded_by_seller_account_id: OWNER_1_ID, response_message: 'Fixed #1', evidence_references: [], created_at: new Date().toISOString() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/UPDATE store_compliance_warnings\s+SET status = 'RESOLVED'/i.test(sql)) {
      return {
        rows: [{
          id: W1,
          merchant_id: STORE_1_ID,
          warning_number: 1,
          violation_category: 'HYGIENE_STANDARD',
          severity: 'LOW',
          is_formal_ordinary: true,
          reason: 'R1',
          required_corrective_action: 'C1',
          issued_by_admin_id: ADMIN_1_ID,
          issued_at: new Date().toISOString(),
          corrective_deadline: null,
          status: 'RESOLVED',
          resolved_by_admin_id: params[0],
          resolved_at: new Date().toISOString(),
          resolution_reason: params[1],
          resolution_evidence_checked: true,
          evidence_references: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }],
        rowCount: 1
      };
    }
    if (/FROM store_memberships sm/i.test(sql)) return { rows: [{ seller_account_id: OWNER_1_ID }], rowCount: 1 };
    if (/INSERT INTO owner_notification_events/i.test(sql)) return { rows: [{ id: 'n1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };

  const pool = {
    query,
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
        if (sql === 'ROLLBACK') {
          rollbackCalled++;
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'COMMIT') {
          commitCalled++;
          return { rows: [], rowCount: 0 };
        }
        return query(sql, params);
      },
      release: () => {},
      on: () => ({}) as any,
      off: () => ({}) as any
    })
  } as unknown as StrictPgPool;

  const outcome = await reactivateMerchantStore(pool, {
    storeId: STORE_1_ID,
    adminId: ADMIN_1_ID,
    reason: 'Attempt atomic reactivation across two warnings',
    correctiveEvidenceReviewed: true,
    warningResolutions: [
      { warningId: W1, reason: 'Resolve W1 ok', correctiveEvidenceChecked: true },
      { warningId: W2, reason: 'Resolve W2 without owner response', correctiveEvidenceChecked: true }
    ]
  });

  assertEqual(outcome.ok, false, 'Reactivation fails cleanly on W2');
  assertEqual(outcome.ok ? 200 : outcome.status, 409, 'Returns 409 OWNER_RESPONSE_REQUIRED');
  assertEqual(rollbackCalled, 1, 'ROLLBACK invoked so W1 resolution + audit + outbox never commit partially');
  assertEqual(commitCalled, 0, 'COMMIT never called on failed reactivation transaction');
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
  console.log(`\nMO-B4 Unit Summary: ${TESTS.length - failed}/${TESTS.length} passed`);
  if (failed > 0) process.exit(1);
}

run();
