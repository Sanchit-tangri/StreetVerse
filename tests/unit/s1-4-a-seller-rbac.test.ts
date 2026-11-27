/**
 * StreetVerse S1.4-A Unit & Route RBAC Tests:
 * Seller Account Separation, Store Membership RBAC, Legacy Token Rejection,
 * Protected KYC, Store Discovery, /me Introspection, and Migration Conflict Safety.
 */

import assert from 'assert';
import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { ManagedRedisClient } from '../../services/api-gateway/src/db/redis';
import {
  MerchantIdentityBackfillError,
  migrateAndBackfillSellerIdentities
} from '../../services/api-gateway/src/db/migrations/s14aSellerIdentityMigration';
import {
  requireSellerJwt,
  requireStoreMembership,
  SELLER_ACCOUNT_PRINCIPAL_TYPE,
  verifyAccessToken
} from '../../services/api-gateway/src/middleware/authJwt';
import {
  getPermissionsForRole,
  verifySellerStorePermission
} from '../../services/api-gateway/src/services/sellerRbac';

interface CaseResult {
  name: string;
  passed: boolean;
  error?: string;
}

function makeTestConfig(): GatewayConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    allowedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
    jwtSecret: crypto.randomBytes(36).toString('base64url'),
    jwtIssuer: 'streetverse-api-s14a',
    jwtBuyerAudience: 'streetverse-buyer-s14a',
    jwtSellerAudience: 'streetverse-seller-s14a',
    jwtExpiresIn: '1h',
    redisUrl: 'redis://default:UnitTestRedisSecret@127.0.0.1:16399',
    customerDbUrl: 'postgresql://postgres:UnitCustSecret@127.0.0.1:15433/cust',
    merchantDbUrl: 'postgresql://postgres:UnitMerchSecret@127.0.0.1:15434/merch',
    aiEngineUrl: 'http://127.0.0.1:8000'
  };
}

function createMemoryOtpRedis(): ManagedRedisClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const client: any = {
    status: 'ready',
    store,
    connect: async () => {
      client.status = 'ready';
    },
    ping: async () => 'PONG',
    set: async (key: string, val: string, ...args: any[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, String(val));
      return 'OK';
    },
    get: async (key: string) => store.get(key) ?? null,
    ttl: async (key: string) => (store.has(key) ? 45 : -2),
    del: async (...keys: string[]) => {
      let deleted = 0;
      for (const k of keys) {
        if (store.delete(k)) deleted++;
      }
      return deleted;
    },
    eval: async (script: string, numKeys: number, ...rest: string[]) => {
      const keys = rest.slice(0, numKeys);
      const argv = rest.slice(numKeys);
      if (script.includes('OWNER_WRITE_FAILED')) {
        store.set(keys[0], argv[0]);
        store.set(keys[1], argv[1]);
        store.set(keys[2], '0');
        return [1, 'OK', '', 1];
      }
      if (script.includes('EXPIRED')) {
        const stored = store.get(keys[0]);
        if (!stored) return [0, 'EXPIRED', 0];
        if (stored !== argv[0]) return [0, 'MISMATCH', 2];
        store.delete(keys[0]);
        store.delete(keys[1]);
        return [1, 'OK', 0];
      }
      if (keys.length === 3 && store.get(keys[2]) === argv[0]) {
        store.delete(keys[0]);
        store.delete(keys[1]);
        store.delete(keys[2]);
        return 1;
      }
      if (keys.length === 1 && store.get(keys[0]) === argv[0]) {
        store.delete(keys[0]);
        return 1;
      }
      return 0;
    },
    on: () => client,
    off: () => client,
    removeListener: () => client,
    once: () => client,
    quit: async () => 'OK',
    disconnect: () => {}
  };
  return client;
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

function makeSimpleTxPool(
  queryImpl: (sql: string, values?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>
): StrictPgPool {
  return {
    query: queryImpl,
    connect: async () => ({
      query: queryImpl,
      release: () => {}
    }),
    on: () => {},
    end: async () => {}
  };
}

export async function runS14aSellerRbacTests(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  async function runCase(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err: any) {
      results.push({ name, passed: false, error: err?.stack || err?.message || String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // 1. Backfill / Migration unit tests (conservative verification, grouping & conflicts)
  // -------------------------------------------------------------------------
  await runCase('Backfill: conservative email verification requires fresh OTP even when legacy is_verified=true and merges same-owner stores', async () => {
    const insertedAccounts: any[] = [];
    const insertedMemberships: any[] = [];
    const txCommands: string[] = [];

    const store1Id = '11111111-1111-4111-8111-111111111111';
    const store2Id = '22222222-2222-4222-8222-222222222222';
    const storeUnverifiedId = '33333333-3333-4333-8333-333333333333';
    const pwHash1 = '$2a$10$fixedhashforowneridentitymatch123456789012345';
    const pwHash2 = '$2a$10$secondownerpasswordhash1234567890123456789012';

    const mockPool = makeSimpleTxPool(async (sql, values = []) => {
      const trimmed = sql.trim();
      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        txCommands.push(trimmed);
        return { rows: [], rowCount: 0 };
      }
      if (/FROM merchants/i.test(sql)) {
        return {
          rows: [
            // Same owner across two stores (one historically is_verified=true from KYC/seed, one false)
            { id: store1Id, owner_phone: '+91 98765 43210', owner_email: 'Owner.One@Example.test', password_hash: pwHash1, is_verified: true },
            { id: store2Id, owner_phone: '09876543210', owner_email: 'owner.one@example.test', password_hash: pwHash1, is_verified: false },
            // Distinct owner with legacy is_verified=false
            { id: storeUnverifiedId, owner_phone: '+919876543299', owner_email: 'unverified.legacy@example.test', password_hash: pwHash2, is_verified: false }
          ],
          rowCount: 3
        };
      }
      if (/FROM seller_accounts/i.test(sql) && /SELECT/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM store_memberships/i.test(sql) && /SELECT/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO seller_accounts/i.test(sql)) {
        const id = `aaaa0000-0000-4000-8000-00000000000${insertedAccounts.length + 1}`;
        insertedAccounts.push({
          id,
          phone: values[0],
          email: values[1],
          passwordHash: values[2],
          sqlHasFalseLiteral: /VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*false,\s*'ACTIVE'\)/i.test(sql)
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/INSERT INTO store_memberships/i.test(sql)) {
        insertedMemberships.push({ sellerAccountId: values[0], merchantId: values[1] });
        return { rows: [{ id: `mem-${insertedMemberships.length}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const summary = await migrateAndBackfillSellerIdentities(mockPool, {
      migrationSql: '-- noop test DDL'
    });

    assert.strictEqual(summary.applied, true);
    assert.strictEqual(summary.sellerAccountsCreated, 2);
    assert.strictEqual(summary.membershipsCreated, 3);
    assert.strictEqual(insertedAccounts.length, 2);
    assert(
      insertedAccounts.every((a) => a.sqlHasFalseLiteral),
      'Both legacy is_verified=true (ambiguous provenance) and is_verified=false accounts must initialize with is_email_verified=false'
    );
    assert.strictEqual(insertedAccounts[0].phone, '+919876543210');
    assert.strictEqual(insertedAccounts[0].email, 'owner.one@example.test');
    assert.strictEqual(insertedAccounts[0].passwordHash, pwHash1);
    assert.strictEqual(insertedAccounts[1].phone, '+919876543299');
    assert.strictEqual(insertedAccounts[1].passwordHash, pwHash2);
    assert.deepStrictEqual(
      insertedMemberships.filter((m) => m.sellerAccountId === insertedAccounts[0].id).map((m) => m.merchantId),
      [store1Id, store2Id],
      'Store UUIDs must remain untouched and both mapped as OWNER memberships on one Seller Account'
    );
    assert(txCommands.includes('BEGIN') && txCommands.includes('COMMIT') && !txCommands.includes('ROLLBACK'));
  });

  await runCase('Backfill: rerun preserves already migrated Seller Accounts, real OTP email verification state, and OWNER memberships', async () => {
    const store1Id = '11111111-1111-4111-8111-111111111111';
    const existingAccountId = 'aaaa0000-0000-4000-8000-000000000099';
    const pwHash = '$2a$10$fixedhashforreruncheck12345678901234567890123';
    let accountMutations = 0;
    let membershipMutations = 0;

    const mockPool = makeSimpleTxPool(async (sql) => {
      if (/FROM merchants/i.test(sql)) {
        return {
          rows: [{ id: store1Id, owner_phone: '+919876543210', owner_email: 'owner@example.test', password_hash: pwHash }],
          rowCount: 1
        };
      }
      if (/FROM seller_accounts/i.test(sql) && /SELECT/i.test(sql)) {
        // Account already verified email via OTP after initial backfill
        return {
          rows: [{ id: existingAccountId, phone: '+919876543210', email: 'owner@example.test', password_hash: pwHash, is_email_verified: true, status: 'ACTIVE' }],
          rowCount: 1
        };
      }
      if (/FROM store_memberships/i.test(sql) && /SELECT/i.test(sql)) {
        return {
          rows: [{ merchant_id: store1Id, seller_account_id: existingAccountId, role: 'OWNER', status: 'ACTIVE' }],
          rowCount: 1
        };
      }
      if (/INSERT INTO seller_accounts|UPDATE seller_accounts|DELETE FROM seller_accounts/i.test(sql)) {
        accountMutations++;
      }
      if (/INSERT INTO store_memberships|UPDATE store_memberships|DELETE FROM store_memberships/i.test(sql)) {
        membershipMutations++;
      }
      return { rows: [], rowCount: 0 };
    });

    const rerun = await migrateAndBackfillSellerIdentities(mockPool, { migrationSql: '-- noop' });
    assert.strictEqual(rerun.applied, true);
    assert.strictEqual(rerun.alreadyMappedStores, 1);
    assert.strictEqual(rerun.sellerAccountsCreated, 0);
    assert.strictEqual(rerun.membershipsCreated, 0);
    assert.strictEqual(accountMutations, 0, 'Rerun must never overwrite existing Seller Account or reset is_email_verified');
    assert.strictEqual(membershipMutations, 0, 'Rerun must never mutate existing OWNER memberships');
  });

  await runCase('Backfill: rejects phone/email conflicts, password conflicts, missing emails, and rolls back cleanly', async () => {
    const baseStore1 = '11111111-1111-4111-8111-111111111101';
    const baseStore2 = '22222222-2222-4222-8222-222222222202';

    const conflictFixtures: Array<{ label: string; expectedCode: string; rows: any[] }> = [
      {
        label: 'same phone with different emails',
        expectedCode: 'PHONE_EMAIL_MISMATCH',
        rows: [
          { id: baseStore1, owner_phone: '+919876543210', owner_email: 'one@example.test', password_hash: 'h1', is_verified: true },
          { id: baseStore2, owner_phone: '9876543210', owner_email: 'two@example.test', password_hash: 'h1', is_verified: true }
        ]
      },
      {
        label: 'same email with different phones',
        expectedCode: 'EMAIL_PHONE_MISMATCH',
        rows: [
          { id: baseStore1, owner_phone: '+919876543210', owner_email: 'same@example.test', password_hash: 'h1', is_verified: true },
          { id: baseStore2, owner_phone: '+919876543211', owner_email: 'SAME@example.test', password_hash: 'h1', is_verified: true }
        ]
      },
      {
        label: 'conflicting password hashes for same owner',
        expectedCode: 'PASSWORD_HASH_CONFLICT',
        rows: [
          { id: baseStore1, owner_phone: '+919876543210', owner_email: 'same@example.test', password_hash: 'hashA', is_verified: true },
          { id: baseStore2, owner_phone: '09876543210', owner_email: 'same@example.test', password_hash: 'hashB', is_verified: true }
        ]
      },
      {
        label: 'missing owner email (refuses to invent email)',
        expectedCode: 'MISSING_OR_INVALID_EMAIL',
        rows: [
          { id: baseStore1, owner_phone: '+919876543210', owner_email: null, password_hash: 'hashA', is_verified: true }
        ]
      },
      {
        label: 'missing password hash',
        expectedCode: 'MISSING_PASSWORD_HASH',
        rows: [
          { id: baseStore1, owner_phone: '+919876543210', owner_email: 'valid@example.test', password_hash: '', is_verified: true }
        ]
      }
    ];

    for (const fixture of conflictFixtures) {
      let wroteAnyAccount = false;
      let rolledBack = false;
      const pool = makeSimpleTxPool(async (sql) => {
        const t = sql.trim();
        if (t === 'ROLLBACK') {
          rolledBack = true;
          return { rows: [], rowCount: 0 };
        }
        if (/FROM merchants/i.test(sql)) return { rows: fixture.rows, rowCount: fixture.rows.length };
        if (/INSERT INTO seller_accounts/i.test(sql) || /INSERT INTO store_memberships/i.test(sql)) {
          wroteAnyAccount = true;
        }
        return { rows: [], rowCount: 0 };
      });

      let caught: unknown;
      try {
        await migrateAndBackfillSellerIdentities(pool, { migrationSql: '-- noop' });
      } catch (err) {
        caught = err;
      }

      assert(caught instanceof MerchantIdentityBackfillError, `${fixture.label}: expected MerchantIdentityBackfillError`);
      assert(
        caught.conflicts.some((c) => c.code === fixture.expectedCode),
        `${fixture.label}: expected conflict code ${fixture.expectedCode}, got ${JSON.stringify(caught.conflicts)}`
      );
      assert.strictEqual(wroteAnyAccount, false, `${fixture.label}: must never write partial rows on conflict`);
      assert.strictEqual(rolledBack, true, `${fixture.label}: must trigger ROLLBACK`);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Seller registration, login, OTP verification & Seller JWT semantics
  // -------------------------------------------------------------------------
  await runCase('Seller Auth: register creates account+store+OWNER tx; OTP verifies email only (not KYC); rejects legacy JWT', async () => {
    const cfg = makeTestConfig();
    const redis = createMemoryOtpRedis();
    const sellerAccounts: any[] = [];
    const stores: any[] = [];
    const memberships: any[] = [];
    const executedSql: string[] = [];

    const ownerAccountId = 'aaaa1111-1111-4111-8111-111111111111';
    const storeId = 'bbbb1111-1111-4111-8111-111111111111';

    let txSnapshot: { accounts: number; stores: number; memberships: number } | null = null;
    const queryFn = async (sql: string, values: any[] = []) => {
      executedSql.push(sql);
      const t = sql.trim();
      if (t === 'BEGIN') {
        txSnapshot = { accounts: sellerAccounts.length, stores: stores.length, memberships: memberships.length };
        return { rows: [], rowCount: 0 };
      }
      if (t === 'ROLLBACK') {
        if (txSnapshot) {
          sellerAccounts.length = txSnapshot.accounts;
          stores.length = txSnapshot.stores;
          memberships.length = txSnapshot.memberships;
        }
        return { rows: [], rowCount: 0 };
      }
      if (t === 'COMMIT') {
        txSnapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT id, phone, email FROM seller_accounts/i.test(sql)) {
        const hit = sellerAccounts.filter((a) => (values[0] || []).includes(a.phone) || a.email === values[1]);
        return { rows: hit, rowCount: hit.length };
      }
      if (/SELECT id, owner_phone, owner_email FROM merchants/i.test(sql)) {
        const hit = stores.filter((s) => (values[0] || []).includes(s.owner_phone) || s.owner_email === values[1]);
        return { rows: hit, rowCount: hit.length };
      }
      if (/INSERT INTO seller_accounts/i.test(sql)) {
        const row = {
          id: ownerAccountId,
          phone: values[0],
          email: values[1],
          password_hash: values[2],
          is_email_verified: false,
          status: 'ACTIVE'
        };
        sellerAccounts.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/INSERT INTO merchants/i.test(sql)) {
        const row = {
          id: storeId,
          business_name: values[0],
          category: values[1],
          owner_phone: values[2],
          owner_email: values[3],
          password_hash: null,
          upi_vpa: values[4],
          address: values[5],
          pincode: values[6],
          is_open: true,
          is_verified: false
        };
        stores.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/INSERT INTO store_memberships/i.test(sql)) {
        const row = { id: 'cccc1111-1111-4111-8111-111111111111', seller_account_id: values[0], merchant_id: values[1], role: 'OWNER', status: 'ACTIVE' };
        memberships.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/FROM seller_accounts\s+WHERE LOWER\(email\)/i.test(sql)) {
        const hit = sellerAccounts.filter((a) => a.email === values[0]);
        return { rows: hit, rowCount: hit.length };
      }
      if (/FROM seller_accounts\s+WHERE phone = ANY/i.test(sql)) {
        const hit = sellerAccounts.filter((a) => (values[0] || []).includes(a.phone));
        return { rows: hit, rowCount: hit.length };
      }
      if (/UPDATE seller_accounts SET is_email_verified = true/i.test(sql)) {
        const acct = sellerAccounts.find((a) => a.id === values[0]);
        if (acct) acct.is_email_verified = true;
        return { rows: [], rowCount: acct ? 1 : 0 };
      }
      if (/FROM seller_accounts\s+WHERE id = \$1/i.test(sql)) {
        const hit = sellerAccounts.filter((a) => a.id === values[0]);
        return { rows: hit, rowCount: hit.length };
      }
      if (/FROM store_memberships sm/i.test(sql)) {
        const rows = memberships
          .filter((m) => m.seller_account_id === values[0] && m.status === 'ACTIVE')
          .map((m) => {
            const st = stores.find((s) => s.id === m.merchant_id)!;
            return {
              store_id: st.id,
              business_name: st.business_name,
              category: st.category,
              upi_vpa: st.upi_vpa,
              address: st.address,
              pincode: st.pincode,
              is_open: st.is_open,
              membership_id: m.id,
              membership_role: m.role,
              membership_status: m.status
            };
          });
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    };

    const merchantPool = makeSimpleTxPool(queryFn);
    const customerPool = makeSimpleTxPool(async () => ({ rows: [], rowCount: 0 }));

    let lastOtp = '';
    const { server, io } = createGatewayApp(cfg, {
      customerPool,
      merchantPool,
      redis,
      emailTransporter: {
        sendMail: async (mail: any) => {
          const m = String(mail.text || '').match(/\b(\d{6})\b/);
          if (m) lastOtp = m[1];
          return {};
        }
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const reg = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/register',
        body: {
          business_name: 'Owner Multi Kirana',
          category: 'GROCERY',
          owner_phone: '9876501111',
          owner_email: 'owner.s14a@example.test',
          password: 'Password123!',
          upi_vpa: 'owner@okaxis',
          address: 'Pune',
          pincode: '411038'
        }
      });
      assert.strictEqual(reg.statusCode, 201);
      assert.strictEqual(reg.json.sellerAccountId, ownerAccountId);
      assert.strictEqual(reg.json.merchantId, storeId);
      assert.strictEqual(sellerAccounts.length, 1);
      assert.strictEqual(stores.length, 1);
      assert.strictEqual(stores[0].password_hash, null, 'New store must not hold authoritative password_hash');
      assert.strictEqual(memberships.length, 1);
      assert.strictEqual(memberships[0].role, 'OWNER');

      // Login authenticates against seller_accounts
      const verify = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/verify-otp',
        body: { email: 'owner.s14a@example.test', otp: lastOtp }
      });
      assert.strictEqual(verify.statusCode, 200);
      assert.strictEqual(sellerAccounts[0].is_email_verified, true);
      assert.strictEqual(stores[0].is_verified, false, 'OTP verify must NEVER set merchants.is_verified=true (KYC flag)');
      assert(!executedSql.some((s) => /UPDATE merchants SET is_verified = true/i.test(s)));

      const decoded = jwt.verify(verify.json.token, cfg.jwtSecret) as jwt.JwtPayload;
      assert.strictEqual(decoded.sub, ownerAccountId, 'Seller JWT sub must be Seller Account UUID, not Store ID');
      assert.strictEqual(decoded.role, 'SELLER');
      assert.strictEqual(decoded.principalType, SELLER_ACCOUNT_PRINCIPAL_TYPE);
      assert.strictEqual(decoded.merchantId, undefined, 'JWT must not embed single merchantId');
      assert.strictEqual(decoded.isVerified, undefined, 'JWT must not carry KYC verification claim');

      // Login using phone against seller_accounts works (clear redis cooldown first or check login directly after clearing)
      redis.store.clear();
      const loginByPhone = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/login',
        body: { identifier: '+91 98765 01111', password: 'Password123!' }
      });
      assert.strictEqual(loginByPhone.statusCode, 200);

      // Legacy Store-ID Seller token (missing principalType) must be rejected
      const legacyToken = jwt.sign(
        { sub: storeId, role: 'SELLER', businessName: 'Owner Multi Kirana' },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtSellerAudience, expiresIn: '1h' }
      );
      const legacyCheck = verifyAccessToken(legacyToken, cfg);
      assert.strictEqual(legacyCheck.ok, false);
      assert.strictEqual(legacyCheck.ok === false && legacyCheck.status, 401);

      // Buyer token cannot pass Seller routes or Seller audience
      const buyerToken = jwt.sign(
        { sub: 'u-buyer-1', role: 'BUYER', email: 'buyer@example.test' },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtBuyerAudience, expiresIn: '1h' }
      );
      const buyerOnStores = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/seller/stores',
        headers: { Authorization: `Bearer ${buyerToken}` }
      });
      assert.strictEqual(buyerOnStores.statusCode, 403);
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------
  // 3. Membership RBAC, multi-store Owner/Staff, KYC 401/403/503, /me, /stores
  // -------------------------------------------------------------------------
  await runCase('RBAC: enforces Owner vs Staff permissions, rejects inactive/other/forged roles, protects KYC & /me & /stores', async () => {
    const cfg = makeTestConfig();
    const redis = createMemoryOtpRedis();

    const ownerId = '10000000-0000-4000-8000-000000000001';
    const staffId = '10000000-0000-4000-8000-000000000002';
    const suspendedStaffId = '10000000-0000-4000-8000-000000000003';
    const strangerId = '10000000-0000-4000-8000-000000000004';
    const buyerId = '20000000-0000-4000-8000-000000000001';

    const store1Id = '30000000-0000-4000-8000-000000000001';
    const store2Id = '30000000-0000-4000-8000-000000000002';
    const suspendedStoreId = '30000000-0000-4000-8000-000000000003';

    const accounts = new Map<string, any>([
      [ownerId, { id: ownerId, phone: '+919811111111', email: 'owner@example.test', is_email_verified: true, status: 'ACTIVE', password_hash: 'SECRET_HASH_MUST_NEVER_LEAK' }],
      [staffId, { id: staffId, phone: '+919822222222', email: 'staff@example.test', is_email_verified: true, status: 'ACTIVE', password_hash: 'SECRET_HASH_MUST_NEVER_LEAK' }],
      [suspendedStaffId, { id: suspendedStaffId, phone: '+919833333333', email: 'susp@example.test', is_email_verified: true, status: 'ACTIVE' }],
      [strangerId, { id: strangerId, phone: '+919844444444', email: 'stranger@example.test', is_email_verified: true, status: 'ACTIVE' }]
    ]);

    const stores = new Map<string, any>([
      [store1Id, { id: store1Id, business_name: 'Store Alpha', category: 'GROCERY', upi_vpa: 'a@upi', address: 'Addr 1', pincode: '411038', is_open: true, is_verified: false }],
      [store2Id, { id: store2Id, business_name: 'Store Beta', category: 'SALON', upi_vpa: 'b@upi', address: 'Addr 2', pincode: '411038', is_open: true, is_verified: false }],
      [suspendedStoreId, { id: suspendedStoreId, business_name: 'Store Gamma', category: 'PHARMACY', upi_vpa: 'g@upi', address: 'Addr 3', pincode: '411038', is_open: true, is_verified: false }]
    ]);

    const memberships = [
      { id: 'mem-1', seller_account_id: ownerId, merchant_id: store1Id, role: 'OWNER', status: 'ACTIVE' },
      { id: 'mem-2', seller_account_id: ownerId, merchant_id: store2Id, role: 'OWNER', status: 'ACTIVE' },
      { id: 'mem-3', seller_account_id: staffId, merchant_id: store1Id, role: 'STAFF', status: 'ACTIVE' },
      { id: 'mem-4', seller_account_id: staffId, merchant_id: suspendedStoreId, role: 'STAFF', status: 'SUSPENDED' },
      { id: 'mem-5', seller_account_id: suspendedStaffId, merchant_id: store1Id, role: 'OWNER', status: 'REVOKED' }
    ];

    const customerPool = makeSimpleTxPool(async (sql, values = []) => {
      if (/FROM users\s+WHERE id = \$1/i.test(sql) && values[0] === buyerId) {
        return {
          rows: [
            {
              id: buyerId,
              phone: '+919900001111',
              full_name: 'Real Buyer',
              email: 'buyer@example.test',
              home_address: 'Pune',
              preferred_language: 'en',
              is_verified: true,
              created_at: '2026-11-26T00:00:00.000Z'
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const merchantPool = makeSimpleTxPool(async (sql, values = []) => {
      if (/FROM seller_accounts\s+WHERE id = \$1/i.test(sql)) {
        const acct = accounts.get(values[0]);
        return { rows: acct ? [acct] : [], rowCount: acct ? 1 : 0 };
      }
      if (/FROM merchants m\s+LEFT JOIN store_memberships sm/i.test(sql)) {
        const [acctId, stId] = values;
        const st = stores.get(stId);
        if (!st) return { rows: [], rowCount: 0 };
        const mem = memberships.find((m) => m.seller_account_id === acctId && m.merchant_id === stId);
        return {
          rows: [
            {
              store_id: st.id,
              business_name: st.business_name,
              membership_role: mem?.role || null,
              membership_status: mem?.status || null
            }
          ],
          rowCount: 1
        };
      }
      if (/FROM store_memberships sm\s+JOIN merchants m/i.test(sql)) {
        const rows = memberships
          .filter((m) => m.seller_account_id === values[0] && m.status === 'ACTIVE')
          .map((m) => {
            const st = stores.get(m.merchant_id)!;
            return {
              store_id: st.id,
              business_name: st.business_name,
              category: st.category,
              upi_vpa: st.upi_vpa,
              address: st.address,
              pincode: st.pincode,
              is_open: st.is_open,
              membership_id: m.id,
              membership_role: m.role,
              membership_status: m.status
            };
          });
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    });

    const { app, server, io } = createGatewayApp(cfg, {
      customerPool,
      merchantPool,
      redis
    });

    // Test reusable RBAC middleware directly on operational & owner-only endpoints without adding prod feature routes
    app.post(
      '/_test/stores/:storeId/inventory',
      requireSellerJwt(cfg),
      requireStoreMembership(merchantPool, { requiredPermission: 'INVENTORY_WRITE' }),
      (req: any, res) => res.status(200).json({ ok: true, role: req.storeAccess.role, storeId: req.storeAccess.storeId })
    );
    app.post(
      '/_test/stores/:storeId/settings',
      requireSellerJwt(cfg),
      requireStoreMembership(merchantPool, { requiredPermission: 'STORE_SETTINGS_WRITE' }),
      (req: any, res) => res.status(200).json({ ok: true, role: req.storeAccess.role })
    );

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const signSeller = (sub: string) =>
      jwt.sign({ sub, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE }, cfg.jwtSecret, {
        issuer: cfg.jwtIssuer,
        audience: cfg.jwtSellerAudience,
        expiresIn: '1h'
      });

    const ownerToken = signSeller(ownerId);
    const staffToken = signSeller(staffId);
    const revokedToken = signSeller(suspendedStaffId);
    const strangerToken = signSeller(strangerId);
    const legacyToken = jwt.sign({ sub: store1Id, role: 'SELLER' }, cfg.jwtSecret, {
      issuer: cfg.jwtIssuer,
      audience: cfg.jwtSellerAudience,
      expiresIn: '1h'
    });
    const buyerToken = jwt.sign({ sub: buyerId, role: 'BUYER' }, cfg.jwtSecret, {
      issuer: cfg.jwtIssuer,
      audience: cfg.jwtBuyerAudience,
      expiresIn: '1h'
    });

    try {
      // Owner accesses both store1 & store2
      const ownerS1 = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${store1Id}/inventory`,
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      const ownerS2 = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${store2Id}/settings`,
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      assert.strictEqual(ownerS1.statusCode, 200);
      assert.strictEqual(ownerS2.statusCode, 200);

      // Staff accesses store1 operational inventory (even with forged body role!)
      const staffInv = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${store1Id}/inventory`,
        headers: { Authorization: `Bearer ${staffToken}` },
        body: { role: 'OWNER' }
      });
      assert.strictEqual(staffInv.statusCode, 200);
      assert.strictEqual(staffInv.json.role, 'STAFF', 'Forged body role=OWNER must be ignored');

      // Staff cannot access Owner-only settings even when forging role: OWNER
      const staffSettings = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${store1Id}/settings`,
        headers: { Authorization: `Bearer ${staffToken}` },
        body: { role: 'OWNER', permissions: ['STORE_SETTINGS_WRITE'] }
      });
      assert.strictEqual(staffSettings.statusCode, 403);
      assert.strictEqual(staffSettings.json.code, 'INSUFFICIENT_STORE_PERMISSIONS');

      // Staff cannot access unassigned store2 or suspended store3
      const staffStore2 = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${store2Id}/inventory`,
        headers: { Authorization: `Bearer ${staffToken}` }
      });
      assert.strictEqual(staffStore2.statusCode, 403);
      assert.strictEqual(staffStore2.json.code, 'STORE_ACCESS_DENIED');

      const staffSuspended = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${suspendedStoreId}/inventory`,
        headers: { Authorization: `Bearer ${staffToken}` }
      });
      assert.strictEqual(staffSuspended.statusCode, 403);
      assert.strictEqual(staffSuspended.json.code, 'MEMBERSHIP_INACTIVE');

      // Revoked owner, stranger, and legacy token checks
      const revokedRes = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${store1Id}/inventory`,
        headers: { Authorization: `Bearer ${revokedToken}` }
      });
      assert.strictEqual(revokedRes.statusCode, 403);

      const strangerRes = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${store1Id}/inventory`,
        headers: { Authorization: `Bearer ${strangerToken}` }
      });
      assert.strictEqual(strangerRes.statusCode, 403);

      const legacyRes = await httpRequest({
        port,
        method: 'POST',
        path: `/_test/stores/${store1Id}/inventory`,
        headers: { Authorization: `Bearer ${legacyToken}` }
      });
      assert.strictEqual(legacyRes.statusCode, 401);

      // KYC endpoint RBAC: unauthenticated 401, Staff 403, Stranger 403, Owner 503 KYC_SUBMISSION_UNAVAILABLE
      const kycUnauth = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        body: { merchantId: store1Id, documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert.strictEqual(kycUnauth.statusCode, 401);

      const kycStaff = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${staffToken}` },
        body: { merchantId: store1Id, documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV', role: 'OWNER' }
      });
      assert.strictEqual(kycStaff.statusCode, 403);

      const kycStranger = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${strangerToken}` },
        body: { merchantId: store1Id, documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert.strictEqual(kycStranger.statusCode, 403);

      const kycOwner = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${ownerToken}` },
        body: { merchantId: store2Id, documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert.strictEqual(kycOwner.statusCode, 503);
      assert.strictEqual(kycOwner.json.code, 'KYC_SUBMISSION_UNAVAILABLE');
      assert.strictEqual(stores.get(store2Id).is_verified, false);

      // Store discovery: Owner sees 2 stores; Staff sees only active Store Alpha (suspended Store Gamma omitted)
      const ownerStores = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/seller/stores',
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      assert.strictEqual(ownerStores.statusCode, 200);
      assert.strictEqual(ownerStores.json.stores.length, 2);
      assert(ownerStores.json.stores.every((s: any) => s.role === 'OWNER'));

      const staffStores = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/seller/stores',
        headers: { Authorization: `Bearer ${staffToken}` }
      });
      assert.strictEqual(staffStores.statusCode, 200);
      assert.strictEqual(staffStores.json.stores.length, 1);
      assert.strictEqual(staffStores.json.stores[0].id, store1Id);
      assert.strictEqual(staffStores.json.stores[0].role, 'STAFF');
      assert(!staffStores.json.stores[0].permissions.includes('KYC_MANAGE'));
      assert(!staffStores.json.stores[0].permissions.includes('STAFF_MANAGE'));

      // /api/v1/auth/me returns server-backed profiles cleanly without password_hash or untrusted KYC fields
      const meBuyer = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${buyerToken}` }
      });
      assert.strictEqual(meBuyer.statusCode, 200);
      assert.strictEqual(meBuyer.json.role, 'BUYER');
      assert.strictEqual(meBuyer.json.user.id, buyerId);
      assert.strictEqual(meBuyer.json.user.password_hash, undefined);

      const meSeller = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      assert.strictEqual(meSeller.statusCode, 200);
      assert.strictEqual(meSeller.json.role, 'SELLER');
      assert.strictEqual(meSeller.json.sellerAccount.id, ownerId);
      assert.strictEqual(meSeller.json.sellerAccount.isEmailVerified, true);
      assert.strictEqual(meSeller.json.memberships.length, 2);
      assert(!meSeller.body.includes('SECRET_HASH_MUST_NEVER_LEAK'));
      assert(!meSeller.body.includes('isVerified'));
      assert(!meSeller.body.includes('kycApproved'));

      // Direct helper sanity check for all staff disallowed permissions
      const staffPerms = getPermissionsForRole('STAFF');
      for (const forbidden of ['STAFF_MANAGE', 'KYC_MANAGE', 'FINANCIAL_REPORTS_READ', 'STORE_SETTINGS_WRITE']) {
        assert(!staffPerms.includes(forbidden as any), `Staff must not hold ${forbidden}`);
      }
      const directDenied = await verifySellerStorePermission({
        merchantPool,
        sellerAccountId: staffId,
        storeId: store1Id,
        requiredPermission: 'FINANCIAL_REPORTS_READ'
      });
      assert.strictEqual(directDenied.ok, false);
      assert.strictEqual(directDenied.ok === false && directDenied.status, 403);
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------
  // 4. Honest DB outage & missing account error handling on /me and RBAC
  // -------------------------------------------------------------------------
  await runCase('/me & RBAC: handle missing accounts cleanly and fail closed 503 on database outage', async () => {
    const cfg = makeTestConfig();
    const redis = createMemoryOtpRedis();
    let dbDown = false;

    const customerPool = makeSimpleTxPool(async () => {
      if (dbDown) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' });
      return { rows: [], rowCount: 0 };
    });
    const merchantPool = makeSimpleTxPool(async () => {
      if (dbDown) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5434'), { code: 'ECONNREFUSED' });
      return { rows: [], rowCount: 0 };
    });

    const { server, io } = createGatewayApp(cfg, { customerPool, merchantPool, redis });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const missingBuyer = jwt.sign({ sub: '33333333-3333-4333-8333-333333333333', role: 'BUYER' }, cfg.jwtSecret, {
      issuer: cfg.jwtIssuer,
      audience: cfg.jwtBuyerAudience,
      expiresIn: '1h'
    });
    const missingSeller = jwt.sign(
      { sub: '44444444-4444-4444-8444-444444444444', role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE },
      cfg.jwtSecret,
      { issuer: cfg.jwtIssuer, audience: cfg.jwtSellerAudience, expiresIn: '1h' }
    );

    try {
      const buyer404 = await httpRequest({ port, method: 'GET', path: '/api/v1/auth/me', headers: { Authorization: `Bearer ${missingBuyer}` } });
      const seller404 = await httpRequest({ port, method: 'GET', path: '/api/v1/auth/me', headers: { Authorization: `Bearer ${missingSeller}` } });
      assert.strictEqual(buyer404.statusCode, 404);
      assert.strictEqual(seller404.statusCode, 404);

      dbDown = true;
      const buyer503 = await httpRequest({ port, method: 'GET', path: '/api/v1/auth/me', headers: { Authorization: `Bearer ${missingBuyer}` } });
      const seller503 = await httpRequest({ port, method: 'GET', path: '/api/v1/auth/me', headers: { Authorization: `Bearer ${missingSeller}` } });
      const stores503 = await httpRequest({ port, method: 'GET', path: '/api/v1/seller/stores', headers: { Authorization: `Bearer ${missingSeller}` } });
      assert.strictEqual(buyer503.statusCode, 503);
      assert.strictEqual(seller503.statusCode, 503);
      assert.strictEqual(stores503.statusCode, 503);
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runS14aSellerRbacTests()
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
      console.log(`\nS1.4-A Seller RBAC Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('S1.4-A Test Runner Error:', err);
      process.exit(1);
    });
}
