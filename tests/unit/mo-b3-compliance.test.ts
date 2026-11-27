/**
 * MO-B3 Unit Tests: Store-Specific Compliance Warnings, Numbering, Overdue Derivation,
 * Evidence Safety, Owner vs Staff RBAC, Suspension Guards, and Admin Reactivation.
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
import {
  deriveIsOverdue,
  normalizeSafeEvidenceReferences
} from '../../services/api-gateway/src/services/adminCompliance';

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

const TEST_JWT_SECRET = 'mob3-unit-test-secret-with-at-least-32-bytes!';
const ADMIN_1_ID = '99991111-1111-4111-8111-111111111111';
const ADMIN_2_ID = '99992222-2222-4222-8222-111111111111';
const STORE_1_ID = '11111111-1111-4111-8111-111111111111';
const STORE_2_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_1_ID = 'aaaa1111-1111-4111-8111-111111111111';
const STAFF_1_ID = 'bbbb1111-1111-4111-8111-111111111111';
const WARN_1_ID = 'eeee1111-1111-4111-8111-111111111111';

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
    kycStorageDir: path.join(os.tmpdir(), 'streetverse-mob3-unit-storage')
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
// 1. Evidence Reference Sanitization & Derived Overdue Rules
// ============================================================

test('normalizeSafeEvidenceReferences rejects paths/storageKeys and deriveIsOverdue checks OPEN status cleanly', () => {
  assertEqual(
    normalizeSafeEvidenceReferences(['C:\\secret\\kyc\\file.pdf']).ok,
    false,
    'Windows path rejected'
  );
  assertEqual(
    normalizeSafeEvidenceReferences(['/var/lib/streetverse/kyc/abc.jpg']).ok,
    false,
    'Unix path rejected'
  );
  assertEqual(
    normalizeSafeEvidenceReferences([{ kind: 'REF', referenceId: 'storage_key:deadbeef', label: 'bad' }]).ok,
    false,
    'storage_key rejected'
  );
  assertEqual(
    normalizeSafeEvidenceReferences([{ kind: 'KYC_DOC', referenceId: 'doc-123', label: 'Inspector photo log' }]).ok,
    true,
    'Clean reference object accepted'
  );

  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  assertEqual(deriveIsOverdue('OPEN', past), true, 'Past deadline on OPEN warning is overdue');
  assertEqual(deriveIsOverdue('OPEN', future), false, 'Future deadline is not overdue');
  assertEqual(deriveIsOverdue('OPEN', null), false, 'Null deadline is not overdue');
  assertEqual(deriveIsOverdue('RESOLVED', past), false, 'RESOLVED warning is never overdue');
});

// ============================================================
// 2. RBAC, Actor Spoof Immunity, Severity Validation & State Guards
// ============================================================

test('Compliance APIs enforce Admin vs Owner vs Staff RBAC, reject forged actor IDs, and validate severity/state', async () => {
  let profileStatus = 'APPROVED';
  let warningStatus = 'OPEN';
  let openOrdWarnings = 0;
  let totalOrdWarnings = 0;
  let warningResponseCount = 0;
  const auditActors: string[] = [];

  const query = async (sql: string, params: any[] = []) => {
    if (/FROM admin_accounts\s+WHERE id = \$1/i.test(sql)) {
      const id = String(params[0]);
      if (id !== ADMIN_1_ID) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: ADMIN_1_ID, email: 'ops@streetverse.ops', full_name: 'Ops Admin', role: 'ADMIN', status: 'ACTIVE' }],
        rowCount: 1
      };
    }

    if (/FROM seller_accounts/i.test(sql)) {
      const id = String(params[0]);
      if (id === OWNER_1_ID) {
        return { rows: [{ id: OWNER_1_ID, status: 'ACTIVE', phone: '+919800000001', email: 'own@test.local', is_email_verified: true }], rowCount: 1 };
      }
      if (id === STAFF_1_ID) {
        return { rows: [{ id: STAFF_1_ID, status: 'ACTIVE', phone: '+919800000002', email: 'stf@test.local', is_email_verified: true }], rowCount: 1 };
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
          : null;
      return {
        rows: [
          {
            store_id: storeId,
            business_name: storeId === STORE_1_ID ? 'Sample Store' : 'Other Store',
            membership_role: role,
            membership_status: role ? 'ACTIVE' : null
          }
        ],
        rowCount: 1
      };
    }

    if (/FROM merchants\s+WHERE id = \$1/i.test(sql)) {
      if (params[0] !== STORE_1_ID) return { rows: [], rowCount: 0 };
      return { rows: [{ id: STORE_1_ID, business_name: 'Sample Store', category: 'GROCERY', is_open: false }], rowCount: 1 };
    }

    if (/FROM store_onboarding_profiles\s+WHERE merchant_id = \$1/i.test(sql)) {
      return {
        rows: [
          {
            id: 'prof-1',
            merchant_id: STORE_1_ID,
            status: profileStatus,
            pre_suspension_status: 'APPROVED',
            approved_submission_id: 'sub-1',
            reverification_required: false,
            owner_suspension_responded_at: null,
            suspension_reason: 'Repeated violation'
          }
        ],
        rowCount: 1
      };
    }

    if (/FROM store_compliance_warnings\s+WHERE id = \$1 AND merchant_id = \$2/i.test(sql)) {
      if (params[0] !== WARN_1_ID || params[1] !== STORE_1_ID) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: WARN_1_ID,
            merchant_id: STORE_1_ID,
            warning_number: 1,
            violation_category: 'HYGIENE_STANDARD',
            severity: 'LOW',
            is_formal_ordinary: true,
            reason: 'Refrigerator log missing',
            required_corrective_action: 'Upload signed temperature sheet',
            issued_by_admin_id: ADMIN_1_ID,
            issued_at: new Date().toISOString(),
            corrective_deadline: null,
            status: warningStatus,
            escalation_notes: 'SECRET_ADMIN_ESCALATION_NOTE',
            evidence_references: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ],
        rowCount: 1
      };
    }

    if (/FROM store_compliance_warnings/i.test(sql) && /next_number/i.test(sql)) {
      return {
        rows: [{ next_number: 1, open_ordinary: 0, open_serious: 0, resolved_count: 0, total_count: 0, overdue_count: 0 }],
        rowCount: 1
      };
    }

    if (/FROM store_compliance_warnings/i.test(sql) && /open_ordinary/i.test(sql)) {
      return { rows: [{ open_ordinary: openOrdWarnings, total_ordinary: totalOrdWarnings, overdue_open: 0 }], rowCount: 1 };
    }

    if (/FROM store_compliance_warnings\s+WHERE merchant_id = \$1\s+ORDER BY warning_number/i.test(sql)) {
      return {
        rows: [
          {
            id: WARN_1_ID,
            merchant_id: STORE_1_ID,
            warning_number: 1,
            violation_category: 'HYGIENE_STANDARD',
            severity: 'LOW',
            is_formal_ordinary: true,
            reason: 'Refrigerator log missing',
            required_corrective_action: 'Upload signed temperature sheet',
            issued_by_admin_id: ADMIN_1_ID,
            issued_at: new Date().toISOString(),
            corrective_deadline: null,
            status: warningStatus,
            escalated_at: new Date().toISOString(),
            escalated_by_admin_id: ADMIN_1_ID,
            escalation_notes: 'SECRET_ADMIN_ESCALATION_NOTE',
            evidence_references: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ],
        rowCount: 1
      };
    }

    if (/INSERT INTO store_compliance_warnings/i.test(sql)) {
      auditActors.push(String(params[7]));
      openOrdWarnings++;
      totalOrdWarnings++;
      return {
        rows: [
          {
            id: WARN_1_ID,
            merchant_id: STORE_1_ID,
            warning_number: Number(params[1]),
            violation_category: params[2],
            severity: params[3],
            is_formal_ordinary: Boolean(params[4]),
            reason: params[5],
            required_corrective_action: params[6],
            issued_by_admin_id: params[7],
            issued_at: new Date().toISOString(),
            corrective_deadline: params[8],
            status: 'OPEN',
            evidence_references: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ],
        rowCount: 1
      };
    }

    if (/INSERT INTO store_compliance_warning_responses/i.test(sql)) {
      warningResponseCount++;
      return {
        rows: [{ id: 'resp-1', created_at: new Date().toISOString() }],
        rowCount: 1
      };
    }

    if (/FROM store_compliance_warning_responses/i.test(sql)) {
      if (warningResponseCount === 0 && !/ORDER BY/i.test(sql)) return { rows: [{ cnt: 0 }], rowCount: 1 };
      return {
        rows:
          warningResponseCount > 0
            ? [
                {
                  id: 'resp-1',
                  warning_id: WARN_1_ID,
                  responded_by_seller_account_id: OWNER_1_ID,
                  response_message: 'Cleaned & calibrated',
                  evidence_references: [],
                  created_at: new Date().toISOString()
                }
              ]
            : [],
        rowCount: warningResponseCount > 0 ? 1 : 0
      };
    }

    if (/UPDATE store_compliance_warnings\s+SET status = 'RESOLVED'/i.test(sql)) {
      warningStatus = 'RESOLVED';
      return {
        rows: [
          {
            id: WARN_1_ID,
            merchant_id: STORE_1_ID,
            warning_number: 1,
            violation_category: 'HYGIENE_STANDARD',
            severity: 'LOW',
            is_formal_ordinary: true,
            reason: 'Refrigerator log missing',
            required_corrective_action: 'Upload signed temperature sheet',
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
          }
        ],
        rowCount: 1
      };
    }

    if (/FROM store_memberships sm/i.test(sql)) {
      return { rows: [{ seller_account_id: OWNER_1_ID }], rowCount: 1 };
    }

    if (/INSERT INTO owner_notification_events/i.test(sql)) {
      return { rows: [{ id: 'notif-1' }], rowCount: 1 };
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
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const adminJwt = makeAdminToken(ADMIN_1_ID);
  const ownerJwt = makeSellerToken(OWNER_1_ID);
  const staffJwt = makeSellerToken(STAFF_1_ID);
  const buyerJwt = makeBuyerToken('bbbb0000-0000-4000-8000-000000000000');

  try {
    // 1. Non-Admin rejected on Admin compliance endpoints
    const sellerIssue = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/warnings`,
      headers: { Authorization: `Bearer ${ownerJwt}` },
      body: { violationCategory: 'HYGIENE_STANDARD', severity: 'LOW', reason: 'Test reason', requiredCorrectiveAction: 'Fix it cleanly' }
    });
    assertEqual(sellerIssue.statusCode, 401, 'Seller cannot issue warnings via Admin API');

    const buyerSuspend = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/suspend`,
      headers: { Authorization: `Bearer ${buyerJwt}` },
      body: {}
    });
    assertEqual(buyerSuspend.statusCode, 401, 'Buyer cannot suspend store');

    // 2. Server-side severity validation: ordinary category rejects CRITICAL; serious category rejects LOW
    const invalidCritical = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/warnings`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        violationCategory: 'HYGIENE_STANDARD',
        severity: 'CRITICAL',
        reason: 'Missing fridge sheet',
        requiredCorrectiveAction: 'Upload temperature log sheet'
      }
    });
    assertEqual(invalidCritical.statusCode, 400, 'Ordinary violation rejects CRITICAL severity escalation');

    const invalidLowSerious = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/warnings`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        violationCategory: 'SUSPECTED_FRAUD',
        severity: 'LOW',
        reason: 'Fraudulent invoices spotted',
        requiredCorrectiveAction: 'Submit authentic tax records'
      }
    });
    assertEqual(invalidLowSerious.statusCode, 400, 'Serious violation rejects LOW severity');

    // 3. Issuing warning ignores forged adminId/issuedByAdminId
    const okWarn = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/warnings`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        adminId: ADMIN_2_ID,
        issuedByAdminId: ADMIN_2_ID,
        violationCategory: 'HYGIENE_STANDARD',
        severity: 'LOW',
        reason: 'Expired temperature chart on display',
        requiredCorrectiveAction: 'Upload daily temperature chart'
      }
    });
    assertEqual(okWarn.statusCode, 201, 'Valid warning succeeds');
    assertEqual(okWarn.json?.warning?.issuedByAdminId, ADMIN_1_ID, 'Issued Admin derived strictly from JWT');

    // 4. Ordinary suspension rejected on 0/1 ordinary warning without recurrence/overdue
    const earlyOrdSuspend = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/suspend`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        suspensionType: 'ORDINARY_VIOLATION',
        violationCategory: 'HYGIENE_STANDARD',
        reason: 'Attempting ordinary suspension after only one fresh warning'
      }
    });
    assertEqual(earlyOrdSuspend.statusCode, 409, 'Ordinary suspension requires repeated/overdue warnings');

    // 5. Protective suspension rejects missing evidence
    const noEvidProtective = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/suspend`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        suspensionType: 'PROTECTIVE_SERIOUS_RISK',
        violationCategory: 'IMMEDIATE_SAFETY_RISK',
        reason: 'Contaminated cold storage detected'
      }
    });
    assertEqual(noEvidProtective.statusCode, 400, 'Protective serious suspension requires evidenceReferences');

    // 6. STAFF & cross-store Owner blocked from compliance reads and responses
    assertEqual(
      (await httpRequest({ port, method: 'GET', path: `/api/v1/seller/stores/${STORE_1_ID}/compliance`, headers: { Authorization: `Bearer ${staffJwt}` } })).statusCode,
      403,
      'STAFF blocked from viewing compliance warnings'
    );
    assertEqual(
      (await httpRequest({
        port,
        method: 'POST',
        path: `/api/v1/seller/stores/${STORE_1_ID}/compliance/warnings/${WARN_1_ID}/respond`,
        headers: { Authorization: `Bearer ${staffJwt}` },
        body: { responseMessage: 'Staff trying to respond' }
      })).statusCode,
      403,
      'STAFF blocked from responding to warnings'
    );
    assertEqual(
      (await httpRequest({
        port,
        method: 'GET',
        path: `/api/v1/seller/stores/${STORE_2_ID}/compliance`,
        headers: { Authorization: `Bearer ${ownerJwt}` }
      })).statusCode,
      403,
      'Cross-store Owner blocked'
    );

    // 7. Owner view omits Admin-internal escalationNotes, and Owner cannot resolve warning
    const ownerView = await httpRequest({
      port,
      method: 'GET',
      path: `/api/v1/seller/stores/${STORE_1_ID}/compliance`,
      headers: { Authorization: `Bearer ${ownerJwt}` }
    });
    assertEqual(ownerView.statusCode, 200, 'Owner reads own store compliance');
    assert(!ownerView.body.includes('SECRET_ADMIN_ESCALATION_NOTE'), 'Internal Admin escalation notes never leak to Owner');

    // Cannot resolve without recorded Owner response or mandatory resolution fields
    const missingReasonResolve = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/warnings/${WARN_1_ID}/resolve`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: { reason: '', correctiveEvidenceChecked: true }
    });
    assertEqual(missingReasonResolve.statusCode, 400, 'Resolution requires non-empty reason');

    const noResponseResolve = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/warnings/${WARN_1_ID}/resolve`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: { reason: 'Trying to resolve without owner response', correctiveEvidenceChecked: true }
    });
    assertEqual(noResponseResolve.statusCode, 409, 'Resolution blocked until Owner responds');

    // Owner responds cleanly -> still OPEN; Admin resolves -> RESOLVED
    const ownerResp = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/seller/stores/${STORE_1_ID}/compliance/warnings/${WARN_1_ID}/respond`,
      headers: { Authorization: `Bearer ${ownerJwt}` },
      body: {
        responseMessage: 'Sanitized unit and attached daily calibration sheet',
        evidenceReferences: [{ kind: 'INSPECTION', referenceId: 'SHEET-101', label: 'Daily Log Sheet' }]
      }
    });
    assertEqual(ownerResp.statusCode, 201, 'Owner warning response succeeds');
    assertEqual(ownerResp.json?.warningStatus, 'OPEN', 'Owner response never resolves warning');

    const okResolve = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/warnings/${WARN_1_ID}/resolve`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: { reason: 'Verified sanitized unit and temperature sheet.', correctiveEvidenceChecked: true }
    });
    assertEqual(okResolve.statusCode, 200, 'Admin resolves warning after Owner response');
    assertEqual(okResolve.json?.warning?.status, 'RESOLVED');

    // 8. Reactivation rejects missing evidence confirmation & unresolved OPEN warnings even with Admin evidenceReferences
    profileStatus = 'SUSPENDED';
    const badReactivate = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/reactivate`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: { reason: 'Reactivate without checking', correctiveEvidenceReviewed: false }
    });
    assertEqual(badReactivate.statusCode, 400, 'Reactivation requires correctiveEvidenceReviewed=true');

    // Simulate an OPEN warning still existing -> must block reactivation even with evidenceReferences
    warningStatus = 'OPEN';
    const blockedUnresolved = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/reactivate`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        reason: 'Attempt reactivation while OPEN warning remains',
        correctiveEvidenceReviewed: true,
        evidenceReferences: [{ kind: 'INSPECTION', referenceId: 'DOC-9', label: 'Bypass attempt ref' }]
      }
    });
    assertEqual(blockedUnresolved.statusCode, 409, 'Admin evidenceReferences never bypass unresolved OPEN warnings');
  } finally {
    await shutdown();
  }
});

// ============================================================
// 3. Ordinary Threshold & Reactivation Consistency Edge Cases
// ============================================================

test('Ordinary suspension strictly requires >=2 OPEN warnings on same store and reactivation never leaves warnings OPEN or approves unapproved stores', async () => {
  interface MockWarning {
    id: string;
    merchant_id: string;
    warning_number: number;
    violation_category: string;
    severity: string;
    is_formal_ordinary: boolean;
    reason: string;
    required_corrective_action: string;
    issued_by_admin_id: string;
    issued_at: string;
    corrective_deadline: string | null;
    status: 'OPEN' | 'RESOLVED';
    resolved_by_admin_id: string | null;
    resolved_at: string | null;
    resolution_reason: string | null;
    resolution_evidence_checked: boolean;
    evidence_references: unknown[];
    created_at: string;
    updated_at: string;
  }

  const W_A1 = 'f1111111-1111-4111-8111-111111111101';
  const W_A2 = 'f1111111-1111-4111-8111-111111111102';
  const W_B1 = 'f2222222-2222-4222-8222-222222222201';
  const W_B2 = 'f2222222-2222-4222-8222-222222222202';
  const UNAPPROVED_STORE_ID = '33333333-3333-4333-8333-333333333333';

  let warnings: MockWarning[] = [];
  const responsesByWarning = new Map<string, number>();
  const auditEvents: Array<{ storeId: string; eventType: string; metadata: any }> = [];
  const profileState = new Map<string, {
    status: string;
    pre_suspension_status: string | null;
    approved_submission_id: string | null;
    reverification_required: boolean;
    owner_suspension_responded_at: string | null;
  }>([
    [
      STORE_1_ID,
      {
        status: 'APPROVED',
        pre_suspension_status: null,
        approved_submission_id: 'sub-approved-1',
        reverification_required: false,
        owner_suspension_responded_at: null
      }
    ],
    [
      STORE_2_ID,
      {
        status: 'APPROVED',
        pre_suspension_status: null,
        approved_submission_id: 'sub-approved-2',
        reverification_required: false,
        owner_suspension_responded_at: null
      }
    ],
    [
      UNAPPROVED_STORE_ID,
      {
        status: 'SUSPENDED',
        pre_suspension_status: 'DRAFT',
        approved_submission_id: null,
        reverification_required: false,
        owner_suspension_responded_at: new Date().toISOString()
      }
    ]
  ]);
  const storeIsOpen = new Map<string, boolean>([
    [STORE_1_ID, true],
    [STORE_2_ID, true],
    [UNAPPROVED_STORE_ID, false]
  ]);

  const makeWarn = (
    id: string,
    storeId: string,
    num: number,
    status: 'OPEN' | 'RESOLVED',
    deadline: string | null = null
  ): MockWarning => ({
    id,
    merchant_id: storeId,
    warning_number: num,
    violation_category: 'HYGIENE_STANDARD',
    severity: 'MODERATE',
    is_formal_ordinary: true,
    reason: `Violation #${num}`,
    required_corrective_action: `Correct #${num}`,
    issued_by_admin_id: ADMIN_1_ID,
    issued_at: new Date().toISOString(),
    corrective_deadline: deadline,
    status,
    resolved_by_admin_id: status === 'RESOLVED' ? ADMIN_1_ID : null,
    resolved_at: status === 'RESOLVED' ? new Date().toISOString() : null,
    resolution_reason: status === 'RESOLVED' ? 'Prior issue corrected' : null,
    resolution_evidence_checked: status === 'RESOLVED',
    evidence_references: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const query = async (sql: string, params: any[] = []) => {
    if (/FROM admin_accounts\s+WHERE id = \$1/i.test(sql)) {
      return String(params[0]) === ADMIN_1_ID
        ? { rows: [{ id: ADMIN_1_ID, email: 'ops@streetverse.ops', full_name: 'Ops Admin', role: 'ADMIN', status: 'ACTIVE' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM merchants\s+WHERE id = \$1/i.test(sql)) {
      const sid = String(params[0]);
      if (!profileState.has(sid)) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: sid, business_name: `Store ${sid.slice(0, 4)}`, category: 'GROCERY', is_open: storeIsOpen.get(sid) ?? false }],
        rowCount: 1
      };
    }
    if (/FROM store_onboarding_profiles\s+WHERE merchant_id = \$1/i.test(sql)) {
      const p = profileState.get(String(params[0]));
      return p ? { rows: [{ id: `prof-${params[0]}`, merchant_id: params[0], ...p }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/COUNT\(\*\) FILTER \(WHERE status = 'OPEN' AND is_formal_ordinary = true\)/i.test(sql)) {
      const sid = String(params[0]);
      const openOrd = warnings.filter((w) => w.merchant_id === sid && w.status === 'OPEN' && w.is_formal_ordinary).length;
      return { rows: [{ open_ordinary: openOrd }], rowCount: 1 };
    }
    if (/FROM store_compliance_warnings\s+WHERE merchant_id = \$1\s+ORDER BY warning_number/i.test(sql)) {
      const sid = String(params[0]);
      const rows = warnings.filter((w) => w.merchant_id === sid).sort((a, b) => a.warning_number - b.warning_number);
      return { rows, rowCount: rows.length };
    }
    if (/SELECT id, status, is_formal_ordinary, corrective_deadline\s+FROM store_compliance_warnings/i.test(sql)) {
      const sid = String(params[0]);
      const rows = warnings.filter((w) => w.merchant_id === sid);
      return { rows, rowCount: rows.length };
    }
    if (/FROM store_compliance_warning_responses/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) {
        const sid = String(params[0]);
        const cnt = warnings
          .filter((w) => w.merchant_id === sid)
          .reduce((acc, w) => acc + (responsesByWarning.get(w.id) ?? 0), 0);
        return { rows: [{ cnt }], rowCount: 1 };
      }
      const wid = String(params[0]);
      const cnt = responsesByWarning.get(wid) ?? 0;
      return {
        rows:
          cnt > 0
            ? [
                {
                  id: `resp-${wid}`,
                  warning_id: wid,
                  responded_by_seller_account_id: OWNER_1_ID,
                  response_message: 'Issue addressed',
                  evidence_references: [],
                  created_at: new Date().toISOString()
                }
              ]
            : [],
        rowCount: cnt > 0 ? 1 : 0
      };
    }
    if (/UPDATE store_compliance_warnings\s+SET status = 'RESOLVED'/i.test(sql)) {
      const target = warnings.find((w) => w.id === String(params[2]) && w.status === 'OPEN');
      if (!target) return { rows: [], rowCount: 0 };
      target.status = 'RESOLVED';
      target.resolved_by_admin_id = String(params[0]);
      target.resolved_at = new Date().toISOString();
      target.resolution_reason = String(params[1]);
      target.resolution_evidence_checked = true;
      return { rows: [target], rowCount: 1 };
    }
    if (/UPDATE store_onboarding_profiles\s+SET status = 'SUSPENDED'/i.test(sql)) {
      const p = profileState.get(String(params[5]));
      if (p) {
        p.pre_suspension_status = String(params[0]);
        p.status = 'SUSPENDED';
      }
      return { rows: [{ suspended_at: new Date().toISOString() }], rowCount: 1 };
    }
    if (/UPDATE store_onboarding_profiles\s+SET status = \$1,\s+last_reactivated_at/i.test(sql)) {
      const p = profileState.get(String(params[3]));
      if (p) p.status = String(params[0]);
      return { rows: [{ last_reactivated_at: new Date().toISOString() }], rowCount: 1 };
    }
    if (/UPDATE merchants SET is_open = false WHERE id = \$1/i.test(sql)) {
      storeIsOpen.set(String(params[0]), false);
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO store_onboarding_audit_events/i.test(sql)) {
      auditEvents.push({
        storeId: String(params[0]),
        eventType: String(params[3]),
        metadata: JSON.parse(String(params[4]))
      });
      return { rows: [{ id: 'audit-x' }], rowCount: 1 };
    }
    if (/FROM store_memberships sm/i.test(sql)) {
      return { rows: [{ seller_account_id: OWNER_1_ID }], rowCount: 1 };
    }
    if (/INSERT INTO owner_notification_events/i.test(sql)) {
      return { rows: [{ id: 'notif-x' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  let snapshotWarnings: MockWarning[] = [];
  let snapshotProfileJson = '';
  let snapshotAuditLen = 0;

  const pool = {
    query,
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql === 'BEGIN') {
          snapshotWarnings = warnings.map((w) => ({ ...w }));
          snapshotProfileJson = JSON.stringify(Array.from(profileState.entries()));
          snapshotAuditLen = auditEvents.length;
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'ROLLBACK') {
          warnings = snapshotWarnings.map((w) => ({ ...w }));
          for (const [k, v] of JSON.parse(snapshotProfileJson) as Array<[string, any]>) {
            profileState.set(k, v);
          }
          auditEvents.length = snapshotAuditLen;
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'COMMIT') return { rows: [], rowCount: 0 };
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
    enableRedisAdapter: false
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const adminJwt = makeAdminToken(ADMIN_1_ID);

  try {
    const pastDeadline = new Date(Date.now() - 3_600_000).toISOString();

    // Case A: 1 RESOLVED + 1 overdue OPEN on STORE_1, PLUS 2 OPEN on STORE_2 -> STORE_1 MUST fail 409!
    warnings = [
      makeWarn(W_A1, STORE_1_ID, 1, 'RESOLVED'),
      makeWarn(W_A2, STORE_1_ID, 2, 'OPEN', pastDeadline),
      makeWarn(W_B1, STORE_2_ID, 1, 'OPEN'),
      makeWarn(W_B2, STORE_2_ID, 2, 'OPEN')
    ];

    const suspendStore1Blocked = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_1_ID}/compliance/suspend`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        suspensionType: 'ORDINARY_VIOLATION',
        violationCategory: 'HYGIENE_STANDARD',
        reason: 'Only 1 open overdue warning plus 1 resolved warning on Store 1'
      }
    });
    assertEqual(suspendStore1Blocked.statusCode, 409, '1 RESOLVED + 1 overdue OPEN (+ 2 OPEN on Store 2) must NOT allow ordinary suspension');

    // Case B: Serious protective suspension succeeds with 0 warnings on Store 1 if safety/fraud category & evidence supplied,
    // wait -> use STORE_2 (2 OPEN) for ordinary suspension (200)
    const suspendStore2Ok = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_2_ID}/compliance/suspend`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        suspensionType: 'ORDINARY_VIOLATION',
        violationCategory: 'HYGIENE_STANDARD',
        reason: 'Two currently OPEN formal ordinary warnings on Store 2'
      }
    });
    assertEqual(suspendStore2Ok.statusCode, 200, '2 OPEN ordinary warnings on same store permit Admin suspension');

    // Reactivation of STORE_2 blocked while W_B1 & W_B2 are OPEN, even with Admin evidenceReferences
    profileState.get(STORE_2_ID)!.owner_suspension_responded_at = new Date().toISOString();
    const bypassAttempt = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_2_ID}/compliance/reactivate`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        reason: 'Trying to bypass two open warnings with evidence ref',
        correctiveEvidenceReviewed: true,
        evidenceReferences: [{ kind: 'INSPECTION', referenceId: 'OVERRIDE-ATTEMPT', label: 'Should not bypass' }]
      }
    });
    assertEqual(bypassAttempt.statusCode, 409, 'Reactivation cannot bypass OPEN warnings via evidenceReferences');

    // Partial resolution omitting W_B2 fails 409 and rolls back W_B1 cleanly
    responsesByWarning.set(W_B1, 1);
    responsesByWarning.set(W_B2, 1);
    const partialRes = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_2_ID}/compliance/reactivate`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        reason: 'Partial resolution check',
        correctiveEvidenceReviewed: true,
        warningResolutions: [
          { warningId: W_B1, reason: 'Resolved B1 only', correctiveEvidenceChecked: true }
        ]
      }
    });
    assertEqual(partialRes.statusCode, 409, 'Partial warningResolutions fails and does not leave W_B2 open');
    assertEqual(warnings.find((w) => w.id === W_B1)?.status, 'OPEN', 'Failed atomic reactivation rolled back W_B1');

    // Atomic resolution of both W_B1 and W_B2 inside reactivation succeeds cleanly with Admin attribution & audit records
    const atomicReactivate = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${STORE_2_ID}/compliance/reactivate`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        reason: 'Verified corrective resolution of both violations',
        correctiveEvidenceReviewed: true,
        warningResolutions: [
          {
            warningId: W_B1,
            reason: 'Sanitation check passed for warning #1',
            correctiveEvidenceChecked: true,
            evidenceReferences: [{ kind: 'LOG', referenceId: 'B1-OK', label: 'Log B1' }]
          },
          {
            warningId: W_B2,
            reason: 'Equipment calibration verified for warning #2',
            correctiveEvidenceChecked: true,
            evidenceReferences: [{ kind: 'LOG', referenceId: 'B2-OK', label: 'Log B2' }]
          }
        ]
      }
    });
    assertEqual(atomicReactivate.statusCode, 200, 'Atomic reactivation with all OPEN warnings resolved succeeds');
    assertEqual(atomicReactivate.json?.reactivation?.isOpen, false, 'Reactivation keeps store closed');
    assertEqual(warnings.find((w) => w.id === W_B1)?.resolved_by_admin_id, ADMIN_1_ID, 'Admin ID recorded on B1');
    assertEqual(warnings.find((w) => w.id === W_B2)?.status, 'RESOLVED', 'B2 resolved atomically');

    // Case C: Previously unapproved store NEVER inherits APPROVED upon reactivation
    const unapprovedReactivate = await httpRequest({
      port,
      method: 'POST',
      path: `/api/v1/admin/stores/${UNAPPROVED_STORE_ID}/compliance/reactivate`,
      headers: { Authorization: `Bearer ${adminJwt}` },
      body: {
        reason: 'Cleared protective suspension on unapproved draft store',
        correctiveEvidenceReviewed: true,
        evidenceReferences: [{ kind: 'CLEARANCE', referenceId: 'CLR-DRAFT', label: 'Clearance ref' }]
      }
    });
    assertEqual(unapprovedReactivate.statusCode, 200, 'Unapproved suspended store reactivates cleanly');
    assertEqual(unapprovedReactivate.json?.reactivation?.restoredStatus, 'DRAFT', 'Unapproved store restores DRAFT, never APPROVED');
    assertEqual(unapprovedReactivate.json?.reactivation?.isOpen, false, 'Unapproved reactivated store stays closed');
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
  console.log(`\nMO-B3 Unit Summary: ${TESTS.length - failed}/${TESTS.length} passed`);
  if (failed > 0) process.exit(1);
}

run();
