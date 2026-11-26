/**
 * StreetVerse S1.2 Live PostgreSQL & Redis Integration Tests
 * Requires isolated test PostgreSQL + Redis instances (never truncates/alters dev volumes).
 * Explicitly reports BLOCKED when Docker / isolated test DBs or Redis are unavailable.
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import {
  acquireResendCooldown,
  clearResendCooldown,
  configureEmailService,
  disconnectEmailRedis,
  storeOtp,
  verifyOtp
} from '../../services/api-gateway/src/services/email';

const gatewayRequire = createRequire(
  path.resolve(__dirname, '..', '..', 'services', 'api-gateway', 'package.json')
);
const Redis = gatewayRequire('ioredis');

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; body: string }> {
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
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() }
            : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  // 1. Verify Docker availability before attempting container/DB checks
  try {
    execSync('docker info', { stdio: 'pipe' });
  } catch {
    console.error('BLOCKED: Docker daemon is unavailable (`docker info` failed). Real PostgreSQL & Redis integration tests cannot run.');
    process.exit(2);
  }

  const testCustomerUrl = process.env.TEST_CUSTOMER_DB_URL;
  const testMerchantUrl = process.env.TEST_MERCHANT_DB_URL;
  const testRedisUrl = process.env.TEST_REDIS_URL;

  if (!testCustomerUrl || !testMerchantUrl || !testRedisUrl) {
    console.error(
      'BLOCKED: Set isolated TEST_CUSTOMER_DB_URL, TEST_MERCHANT_DB_URL, and TEST_REDIS_URL to run live S1.2 integration tests without touching development databases.'
    );
    process.exit(2);
  }

  const custPool = new pg.Pool({ connectionString: testCustomerUrl, connectionTimeoutMillis: 2000 });
  const merchPool = new pg.Pool({ connectionString: testMerchantUrl, connectionTimeoutMillis: 2000 });
  const redis = new Redis(testRedisUrl, { connectTimeout: 2000, maxRetriesPerRequest: 1 });

  const createdUserIds: string[] = [];
  const createdMerchantIds: string[] = [];
  const createdRedisKeys: string[] = [];

  try {
    await custPool.query('SELECT 1');
    await merchPool.query('SELECT 1');
    await redis.ping();

    // Ensure schema exists on isolated test databases only
    const custSql = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/database-schemas/customer-db/schema.sql'),
      'utf8'
    );
    const merchSql = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/database-schemas/merchant-db/schema.sql'),
      'utf8'
    );
    await custPool.query(custSql);
    await merchPool.query(merchSql);

    const cfg: GatewayConfig = {
      nodeEnv: 'test',
      port: 0,
      allowedOrigins: ['https://buyer.example.test'],
      jwtSecret: crypto.randomBytes(36).toString('base64url'),
      jwtIssuer: 'streetverse-api-int',
      jwtBuyerAudience: 'streetverse-buyer-int',
      jwtSellerAudience: 'streetverse-seller-int',
      jwtExpiresIn: '7d',
      redisUrl: testRedisUrl,
      customerDbUrl: testCustomerUrl,
      merchantDbUrl: testMerchantUrl,
      aiEngineUrl: 'http://127.0.0.1:8000'
    };

    const { server, io } = createGatewayApp(cfg, {
      customerPool: custPool as any,
      merchantPool: merchPool as any,
      redis
    });

    let lastOtp = '';
    const okTransporter = {
      sendMail: async (mail: any) => {
        const m = String(mail.text || '').match(/(\d{6})/);
        if (m) lastOtp = m[1];
        return {};
      }
    };
    configureEmailService({
      nodeEnv: 'test',
      redisClient: redis,
      transporter: okTransporter
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const runId = Date.now().toString().slice(-6);

    try {
      // =====================================================================
      // A. LIVE REDIS LUA OTP + TTL + LOCKOUT + COOLDOWN TESTS
      // =====================================================================
      const redisRaceEmail = `int.race.${runId}@example.test`;
      createdRedisKeys.push(`otp:buyer:${redisRaceEmail}`, `otp_attempts:buyer:${redisRaceEmail}`);
      await storeOtp('buyer', redisRaceEmail, '482910');

      // 1. Concurrent Redis Lua OTP verification -> at most 1 success
      const concurrentResults = await Promise.all([
        verifyOtp('buyer', redisRaceEmail, '482910'),
        verifyOtp('buyer', redisRaceEmail, '482910'),
        verifyOtp('buyer', redisRaceEmail, '482910'),
        verifyOtp('buyer', redisRaceEmail, '482910')
      ]);
      assert(concurrentResults.filter((r) => r.valid).length === 1, 'Live Redis Lua must permit exactly 1 concurrent OTP success');

      // 2. Third incorrect attempt immediately deletes OTP & attempts keys + preserves TTL before strike 3
      const redisLockEmail = `int.lock.${runId}@example.test`;
      createdRedisKeys.push(`otp:buyer:${redisLockEmail}`, `otp_attempts:buyer:${redisLockEmail}`);
      await storeOtp('buyer', redisLockEmail, '135790');
      const v1 = await verifyOtp('buyer', redisLockEmail, '000001');
      assert(!v1.valid, 'Attempt 1 must fail');
      const ttlAfterFail = await redis.ttl(`otp_attempts:buyer:${redisLockEmail}`);
      assert(ttlAfterFail > 0 && ttlAfterFail <= 300, `Attempts key TTL must be preserved (got ${ttlAfterFail})`);
      const v2 = await verifyOtp('buyer', redisLockEmail, '000002');
      assert(!v2.valid, 'Attempt 2 must fail');
      const v3 = await verifyOtp('buyer', redisLockEmail, '000003');
      assert(!v3.valid && v3.reason?.toLowerCase().includes('too many'), 'Attempt 3 must lock immediately');
      assert((await redis.exists(`otp:buyer:${redisLockEmail}`)) === 0, 'Redis OTP key must be deleted immediately on 3rd strike');
      assert((await redis.exists(`otp_attempts:buyer:${redisLockEmail}`)) === 0, 'Redis attempts key must be deleted immediately on 3rd strike');

      // 3. Direct Redis 45s cooldown TTL check
      const cdId = `cd-${runId}`;
      createdRedisKeys.push(`otp_cooldown:test-scope:${cdId}`);
      const cdFirst = await acquireResendCooldown('test-scope', cdId);
      assert(cdFirst.allowed, 'Initial cooldown acquire must succeed');
      const cdTtl = await redis.ttl(`otp_cooldown:test-scope:${cdId}`);
      assert(cdTtl > 0 && cdTtl <= 45, `Cooldown TTL must be <= 45s, got ${cdTtl}`);
      const cdSecond = await acquireResendCooldown('test-scope', cdId);
      assert(!cdSecond.allowed, 'Second cooldown acquire within 45s must be denied');
      await clearResendCooldown('test-scope', cdId);

      // =====================================================================
      // B. LIVE POSTGRESQL BUYER PHONE, LOGIN COOLDOWN & EMAIL CHANGE TESTS
      // =====================================================================
      const localBuyer = `9891${runId}`;
      const regEmail = `int.buyer.${runId}@example.test`;
      createdRedisKeys.push(`otp:buyer:${regEmail}`, `otp_attempts:buyer:${regEmail}`);

      const regRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/register',
        body: {
          phone: `+91 ${localBuyer.slice(0, 5)} ${localBuyer.slice(5)}`,
          full_name: 'Integration Buyer',
          email: regEmail,
          password: 'Password123!'
        }
      });
      assert(regRes.statusCode === 201, `Expected 201 on buyer register, got ${regRes.statusCode}: ${regRes.body}`);

      const userRow = await custPool.query('SELECT id, phone, email FROM users WHERE LOWER(email) = $1', [regEmail]);
      assert(userRow.rows.length === 1 && userRow.rows[0].phone === `+91${localBuyer}`, 'Canonical +91 phone must persist in PG');
      const userId = userRow.rows[0].id;
      createdUserIds.push(userId);
      createdRedisKeys.push(`otp_cooldown:buyer-login:${userId}`, `otp_cooldown:email-change:${userId}`);

      // Duplicate equivalent phone format -> 409
      const dupPhoneRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/register',
        body: {
          phone: `0${localBuyer}`,
          full_name: 'Duplicate Phone',
          email: `dup.${runId}@example.test`,
          password: 'Password123!'
        }
      });
      assert(dupPhoneRes.statusCode === 409, `Expected 409 for duplicate normalized phone, got ${dupPhoneRes.statusCode}`);

      // Canonical E.164 login + repeated login 429 cooldown
      const loginCanonical = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: `+91${localBuyer}`, password: 'Password123!' }
      });
      assert(loginCanonical.statusCode === 200, `Canonical phone login failed: ${loginCanonical.statusCode}`);

      const loginCooldown = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: `+91${localBuyer}`, password: 'Password123!' }
      });
      assert(loginCooldown.statusCode === 429, `Repeated buyer login within 45s must return 429, got ${loginCooldown.statusCode}`);

      // Legacy 10-digit phone login test (isolated synthetic record)
      const legacyLocal = `9892${runId}`;
      const legacyEmail = `int.legacy.${runId}@example.test`;
      const legacyHash = await bcrypt.hash('Password123!', 10);
      const legacyIns = await custPool.query(
        `INSERT INTO users (phone, full_name, email, password_hash, is_verified) VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [legacyLocal, 'Legacy Phone User', legacyEmail, legacyHash]
      );
      const legacyUserId = legacyIns.rows[0].id;
      createdUserIds.push(legacyUserId);
      createdRedisKeys.push(
        `otp:buyer:${legacyEmail}`,
        `otp_attempts:buyer:${legacyEmail}`,
        `otp_cooldown:buyer-login:${legacyUserId}`
      );

      const legacyLogin = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: `+91 ${legacyLocal.slice(0, 5)} ${legacyLocal.slice(5)}`, password: 'Password123!' }
      });
      assert(legacyLogin.statusCode === 200, `Legacy 10-digit phone login via +91 input failed: ${legacyLogin.statusCode}`);

      // Ambiguous legacy phone match -> 409 conflict
      const ambigLocal = `9893${runId}`;
      const ambig1 = await custPool.query(
        `INSERT INTO users (phone, full_name, email, password_hash, is_verified) VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [ambigLocal, 'Ambig 1', `amb1.${runId}@example.test`, legacyHash]
      );
      const ambig2 = await custPool.query(
        `INSERT INTO users (phone, full_name, email, password_hash, is_verified) VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [`+91${ambigLocal}`, 'Ambig 2', `amb2.${runId}@example.test`, legacyHash]
      );
      createdUserIds.push(ambig1.rows[0].id, ambig2.rows[0].id);

      const ambigLogin = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: ambigLocal, password: 'Password123!' }
      });
      assert(ambigLogin.statusCode === 409, `Ambiguous legacy phone matches must return 409, got ${ambigLogin.statusCode}`);

      // Email-change against real customer schema + failed OTP leaves email unchanged + 23505 duplicate 409 + SMTP failure invalidation
      const token = jwt.sign(
        { sub: userId, role: 'BUYER', email: regEmail },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtBuyerAudience, expiresIn: '1h' }
      );
      const newEmail = `updated.${runId}@example.test`;
      createdRedisKeys.push(`otp:email-change:${userId}:${newEmail}`, `otp_attempts:email-change:${userId}:${newEmail}`);

      // SMTP failure invalidates OTP & releases cooldown
      configureEmailService({
        nodeEnv: 'test',
        redisClient: redis,
        transporter: {
          sendMail: async () => {
            throw new Error('SMTP failure');
          }
        }
      });
      const smtpFail = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${token}` },
        body: { newEmail }
      });
      assert(smtpFail.statusCode === 502, `Expected 502 on SMTP failure, got ${smtpFail.statusCode}`);
      assert((await redis.exists(`otp:email-change:${userId}:${newEmail}`)) === 0, 'Undelivered OTP must be deleted');
      assert((await redis.exists(`otp_cooldown:email-change:${userId}`)) === 0, 'Cooldown must clear on delivery failure');

      // Retry with working transporter immediately succeeds
      configureEmailService({ nodeEnv: 'test', redisClient: redis, transporter: okTransporter });
      const reqEmail = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${token}` },
        body: { newEmail }
      });
      assert(reqEmail.statusCode === 200, `Email change request failed: ${reqEmail.statusCode}`);

      // Wrong OTP leaves original email intact in PG
      const badOtpVerify = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/verify-email-change',
        headers: { Authorization: `Bearer ${token}` },
        body: { newEmail, otp: '000000' }
      });
      assert(badOtpVerify.statusCode === 400, 'Wrong OTP must return 400');
      const stillOriginal = await custPool.query('SELECT email FROM users WHERE id = $1', [userId]);
      assert(stillOriginal.rows[0].email === regEmail, 'Failed OTP must leave PG email unchanged');

      // Trigger real PostgreSQL 23505 unique constraint during verify-email-change:
      // Insert another user claiming newEmail after request-email-change already passed pre-check
      const raceUserIns = await custPool.query(
        `INSERT INTO users (phone, full_name, email, password_hash, is_verified) VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [`+919894${runId}`, 'Email Race User', newEmail, legacyHash]
      );
      createdUserIds.push(raceUserIns.rows[0].id);

      const conflictVerify = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/verify-email-change',
        headers: { Authorization: `Bearer ${token}` },
        body: { newEmail, otp: lastOtp }
      });
      assert(conflictVerify.statusCode === 409, `PostgreSQL 23505 email collision must return 409, got ${conflictVerify.statusCode}`);
      await custPool.query('DELETE FROM users WHERE id = $1', [raceUserIns.rows[0].id]);

      // Valid email-change on legacyUserId succeeds against actual customer schema
      const legacyToken = jwt.sign(
        { sub: legacyUserId, role: 'BUYER', email: legacyEmail },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtBuyerAudience, expiresIn: '1h' }
      );
      const finalNewEmail = `verified.${runId}@example.test`;
      createdRedisKeys.push(
        `otp:email-change:${legacyUserId}:${finalNewEmail}`,
        `otp_attempts:email-change:${legacyUserId}:${finalNewEmail}`,
        `otp_cooldown:email-change:${legacyUserId}`
      );
      const reqEmail2 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${legacyToken}` },
        body: { newEmail: finalNewEmail }
      });
      assert(reqEmail2.statusCode === 200, 'Second email change request must succeed');

      const verifyOk = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/verify-email-change',
        headers: { Authorization: `Bearer ${legacyToken}` },
        body: { newEmail: finalNewEmail, otp: lastOtp }
      });
      assert(verifyOk.statusCode === 200, `Valid verify-email-change failed: ${verifyOk.statusCode}: ${verifyOk.body}`);
      const afterRow = await custPool.query('SELECT email FROM users WHERE id = $1', [legacyUserId]);
      assert(afterRow.rows[0].email === finalNewEmail, 'Updated email must persist in PG users table');

      // =====================================================================
      // C. LIVE POSTGRESQL SELLER REGISTRATION & ISOLATED LOGIN COOLDOWN
      // =====================================================================
      const sellerLocal = `9876${runId}`;
      const sellerEmail = `int.seller.${runId}@example.test`;
      createdRedisKeys.push(`otp:seller:${sellerEmail}`, `otp_attempts:seller:${sellerEmail}`);

      const sellerReg = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/register',
        body: {
          business_name: 'Integration Kirana',
          category: 'GROCERY',
          owner_phone: `0${sellerLocal}`,
          owner_email: sellerEmail,
          password: 'Password123!',
          upi_vpa: 'int@okaxis',
          address: 'Pune',
          pincode: '411038'
        }
      });
      assert(sellerReg.statusCode === 201, `Expected 201 on seller register, got ${sellerReg.statusCode}: ${sellerReg.body}`);

      const merchRow = await merchPool.query('SELECT id, owner_phone FROM merchants WHERE LOWER(owner_email) = $1', [sellerEmail]);
      assert(merchRow.rows.length === 1 && merchRow.rows[0].owner_phone === `+91${sellerLocal}`, 'Canonical +91 owner_phone must persist');
      const merchantId = merchRow.rows[0].id;
      createdMerchantIds.push(merchantId);
      createdRedisKeys.push(`otp_cooldown:seller-login:${merchantId}`);

      const sellerLogin1 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/login',
        body: { identifier: sellerLocal, password: 'Password123!' }
      });
      assert(sellerLogin1.statusCode === 200, `First seller login must succeed, got ${sellerLogin1.statusCode}`);

      const sellerLogin2 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/login',
        body: { identifier: `+91 ${sellerLocal.slice(0, 5)} ${sellerLocal.slice(5)}`, password: 'Password123!' }
      });
      assert(sellerLogin2.statusCode === 429, `Repeated seller login within 45s must return 429, got ${sellerLogin2.statusCode}`);

      console.log('PASS: All expanded live PostgreSQL & Redis S1.2 integration tests passed.');
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  } finally {
    // Clean up ONLY test-created records & keys
    if (createdUserIds.length > 0) {
      await custPool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]).catch(() => {});
    }
    if (createdMerchantIds.length > 0) {
      await merchPool.query('DELETE FROM merchants WHERE id = ANY($1)', [createdMerchantIds]).catch(() => {});
    }
    if (createdRedisKeys.length > 0) {
      await redis.del(...createdRedisKeys).catch(() => {});
    }
    disconnectEmailRedis();
    await redis.quit().catch(() => {});
    await custPool.end().catch(() => {});
    await merchPool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('S1.2 Live Integration Test Error:', err);
  process.exit(1);
});
